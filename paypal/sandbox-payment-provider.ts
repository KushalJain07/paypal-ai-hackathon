import { createHash } from "node:crypto";
import { z } from "zod";
import { observedPaymentSchema, type ObservedPayment } from "../domain/payment.ts";
import {
  PayPalProviderError,
  type Authorization,
  type AuthorizationStatus,
  type Capture,
  type CaptureStatus,
  type CreateOrderInput,
  type CreatedOrder,
  type OrderSnapshot,
  type PaymentProvider,
  type Refund,
} from "./payment-provider.ts";

const SANDBOX_API_URL = "https://api-m.sandbox.paypal.com";
const amountSchema = z
  .object({
    currency_code: z.string().regex(/^[A-Z]{3}$/),
    value: z.string().min(1).max(32),
  })
  .passthrough();
const captureAmountSchema = amountSchema.extend({
  value: z.string().regex(/^\d+(?:\.\d{1,2})?$/),
});

const linkSchema = z
  .object({ href: z.string().url(), rel: z.string().min(1) })
  .passthrough();

const authorizationResponseSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum([
      "CREATED",
      "PENDING",
      "CAPTURED",
      "DENIED",
      "PARTIALLY_CAPTURED",
      "VOIDED",
      "EXPIRED",
    ]),
    amount: amountSchema,
  })
  .passthrough();

const captureResponseSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum([
      "PENDING",
      "COMPLETED",
      "DECLINED",
      "PARTIALLY_REFUNDED",
      "REFUNDED",
    ]),
    amount: captureAmountSchema,
    final_capture: z.boolean().optional(),
  })
  .passthrough();

const refundResponseSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(["PENDING", "COMPLETED"]),
  })
  .passthrough();

const orderAuthorizationSchema = z
  .object({ id: z.string().min(1), status: authorizationResponseSchema.shape.status })
  .passthrough();
const orderCaptureSchema = z
  .object({ id: z.string().min(1), status: captureResponseSchema.shape.status })
  .passthrough();

const purchaseUnitSchema = z
  .object({
    invoice_id: z.string().optional(),
    payee: z.object({ email_address: z.string().email().optional() }).optional(),
    amount: amountSchema.optional(),
    payments: z
      .object({
        authorizations: z.array(orderAuthorizationSchema).optional(),
        captures: z.array(orderCaptureSchema).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const orderResponseSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum([
      "CREATED",
      "SAVED",
      "APPROVED",
      "VOIDED",
      "COMPLETED",
      "PAYER_ACTION_REQUIRED",
    ]),
    intent: z.literal("AUTHORIZE").optional(),
    links: z.array(linkSchema).optional(),
    purchase_units: z.array(purchaseUnitSchema).min(1),
  })
  .passthrough();

const createOrderResponseSchema = orderResponseSchema.omit({
  purchase_units: true,
});

const oauthResponseSchema = z
  .object({
    access_token: z.string().min(1),
    expires_in: z.number().positive(),
  })
  .passthrough();

const apiErrorSchema = z
  .object({ name: z.string().optional() })
  .passthrough();

const createOrderInputSchema = z
  .object({
    paymentId: z.string().min(1).max(256),
    payeeEmail: z.string().email(),
    amountCents: z.number().int().positive().safe(),
    currency: z.literal("USD"),
    invoiceId: z.string().min(1).max(127),
  })
  .strict();

interface ProviderOptions {
  baseUrl?: string;
  clientId?: string;
  clientSecret?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

type Operation =
  | "createOrder"
  | "getOrder"
  | "authorizeOrder"
  | "getAuthorization"
  | "captureAuthorization"
  | "getCapture"
  | "voidAuthorization"
  | "refundCapture";

type PayPalAmount = z.infer<typeof amountSchema>;
type PayPalOrder = z.infer<typeof orderResponseSchema>;
type PayPalAuthorization = z.infer<typeof authorizationResponseSchema>;
type PayPalCapture = z.infer<typeof captureResponseSchema>;

function encodeIdentifier(value: string, operation: Operation): string {
  const parsed = z.string().min(1).max(256).safeParse(value);
  if (!parsed.success) {
    throw new PayPalProviderError("INVALID_INPUT", operation);
  }
  return encodeURIComponent(parsed.data);
}

export function derivePayPalRequestId(paymentId: string, operation: Operation): string {
  return createHash("sha256")
    .update(`${paymentId}:${operation}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function centsToAmount(amountCents: number): string {
  const dollars = Math.floor(amountCents / 100);
  const cents = String(amountCents % 100).padStart(2, "0");
  return `${dollars}.${cents}`;
}

function parseAmount(amount: PayPalAmount): { amountCents: number; currency: string } {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount.value);
  if (!match) {
    throw new PayPalProviderError(
      "RESPONSE_SCHEMA_INVALID",
      "normalizeResponse",
    );
  }
  const whole = Number(match[1]);
  const fractional = Number((match[2] ?? "").padEnd(2, "0"));
  const amountCents = whole * 100 + fractional;
  if (!Number.isSafeInteger(amountCents)) {
    throw new PayPalProviderError(
      "RESPONSE_SCHEMA_INVALID",
      "normalizeResponse",
    );
  }
  return { amountCents, currency: amount.currency_code };
}

function assertSandboxApprovalUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PayPalProviderError("APPROVAL_URL_INVALID", "createOrder");
  }
  if (
    url.protocol !== "https:" ||
    !["sandbox.paypal.com", "www.sandbox.paypal.com"].includes(url.hostname)
  ) {
    throw new PayPalProviderError("APPROVAL_URL_INVALID", "createOrder");
  }
  return url.toString();
}

function mapObservedStatus(order: PayPalOrder): ObservedPayment["status"] {
  const purchaseUnit = order.purchase_units[0];
  const authorization = purchaseUnit?.payments?.authorizations?.[0];
  const capture = purchaseUnit?.payments?.captures?.[0];
  if (authorization?.status === "VOIDED" || order.status === "VOIDED") {
    return "voided";
  }
  if (capture?.status === "REFUNDED") {
    return "refunded";
  }
  if (capture?.status === "COMPLETED") {
    return "captured";
  }
  if (
    authorization?.status === "DENIED" ||
    authorization?.status === "EXPIRED"
  ) {
    return "failed";
  }
  if (authorization?.status === "CAPTURED" || authorization?.status === "PARTIALLY_CAPTURED") {
    return "captured";
  }
  if (authorization) {
    return "authorized";
  }
  return "requested";
}

function normalizeOrder(order: PayPalOrder): ObservedPayment {
  const unit = order.purchase_units[0];
  if (!unit?.amount || !unit.payee?.email_address) {
    throw new PayPalProviderError("ORDER_DATA_INCOMPLETE", "normalizeResponse");
  }
  const { amountCents, currency } = parseAmount(unit.amount);
  const parsed = observedPaymentSchema.safeParse({
    payee_email: unit.payee.email_address,
    amount: amountCents,
    currency,
    invoice_id: unit.invoice_id ?? null,
    paypal_order_id: order.id,
    authorization_id: unit.payments?.authorizations?.[0]?.id ?? null,
    status: mapObservedStatus(order),
  });
  if (!parsed.success) {
    throw new PayPalProviderError("RESPONSE_SCHEMA_INVALID", "normalizeResponse");
  }
  return parsed.data;
}

function firstPurchaseUnit(order: PayPalOrder): NonNullable<PayPalOrder["purchase_units"][number]> {
  const unit = order.purchase_units[0];
  if (!unit) {
    throw new PayPalProviderError("ORDER_DATA_INCOMPLETE", "normalizeResponse");
  }
  return unit;
}

export class SandboxPaymentProvider implements PaymentProvider {
  readonly baseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private accessToken: string | undefined;
  private tokenExpiresAt = 0;
  private tokenRequest: Promise<string> | undefined;

  constructor(options: ProviderOptions = {}) {
    const configuredUrl =
      options.baseUrl ?? process.env.PAYPAL_BASE_URL ?? SANDBOX_API_URL;
    if (configuredUrl !== SANDBOX_API_URL) {
      throw new PayPalProviderError("UNSAFE_BASE_URL", "startup");
    }
    this.baseUrl = configuredUrl;
    this.clientId = options.clientId ?? process.env.PAYPAL_CLIENT_ID ?? "";
    this.clientSecret = options.clientSecret ?? process.env.PAYPAL_CLIENT_SECRET ?? "";
    if (!this.clientId || !this.clientSecret) {
      throw new PayPalProviderError("MISSING_CREDENTIALS", "startup");
    }
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new PayPalProviderError("INVALID_CONFIGURATION", "startup");
    }
  }

  async createOrder(input: CreateOrderInput): Promise<CreatedOrder> {
    const validated = createOrderInputSchema.safeParse(input);
    if (!validated.success) {
      throw new PayPalProviderError("INVALID_INPUT", "createOrder");
    }
    const order = await this.request(
      "createOrder",
      validated.data.paymentId,
      "/v2/checkout/orders",
      "POST",
      createOrderResponseSchema,
      {
        intent: "AUTHORIZE",
        purchase_units: [
          {
            invoice_id: validated.data.invoiceId,
            payee: { email_address: validated.data.payeeEmail },
            amount: {
              currency_code: validated.data.currency,
              value: centsToAmount(validated.data.amountCents),
            },
          },
        ],
      },
    );
    const approvalLink = order.links?.find(
      (link) => link.rel === "approve" || link.rel === "payer-action",
    )?.href;
    if (!approvalLink) {
      throw new PayPalProviderError("APPROVAL_URL_MISSING", "createOrder");
    }
    return {
      paymentId: validated.data.paymentId,
      paypalOrderId: order.id,
      status: order.status,
      approvalUrl: assertSandboxApprovalUrl(approvalLink),
    };
  }

  async getOrder(paymentId: string, orderId: string): Promise<OrderSnapshot> {
    const order = await this.request(
      "getOrder",
      paymentId,
      `/v2/checkout/orders/${encodeIdentifier(orderId, "getOrder")}`,
      "GET",
      orderResponseSchema,
    );
    return {
      paypalOrderId: order.id,
      status: order.status,
      observedPayment: normalizeOrder(order),
    };
  }

  async findCaptureForAuthorization(
    paymentId: string,
    orderId: string,
    authorizationId: string,
  ): Promise<Capture | null> {
    const order = await this.request(
      "getOrder",
      paymentId,
      `/v2/checkout/orders/${encodeIdentifier(orderId, "getOrder")}`,
      "GET",
      orderResponseSchema,
    );
    const matchingUnit = order.purchase_units.find((unit) =>
      unit.payments?.authorizations?.some(
        (authorization) => authorization.id === authorizationId,
      )
    );
    if (!matchingUnit) {
      return null;
    }
    const captureId = matchingUnit.payments?.captures?.at(-1)?.id;
    return captureId ? this.getCapture(paymentId, captureId) : null;
  }

  async authorizeOrder(
    paymentId: string,
    orderId: string,
  ): Promise<Authorization> {
    const order = await this.request(
      "authorizeOrder",
      paymentId,
      `/v2/checkout/orders/${encodeIdentifier(orderId, "authorizeOrder")}/authorize`,
      "POST",
      orderResponseSchema,
      {},
    );
    const authorization = firstPurchaseUnit(order).payments?.authorizations?.[0];
    if (!authorization) {
      throw new PayPalProviderError("AUTHORIZATION_MISSING", "authorizeOrder");
    }
    return this.getAuthorization(paymentId, authorization.id);
  }

  async getAuthorization(
    paymentId: string,
    authorizationId: string,
  ): Promise<Authorization> {
    const authorization = await this.request(
      "getAuthorization",
      paymentId,
      `/v2/payments/authorizations/${encodeIdentifier(authorizationId, "getAuthorization")}`,
      "GET",
      authorizationResponseSchema,
    );
    return this.normalizeAuthorization(authorization);
  }

  async captureAuthorization(
    paymentId: string,
    authorizationId: string,
  ): Promise<Capture> {
    const path = `/v2/payments/authorizations/${encodeIdentifier(authorizationId, "captureAuthorization")}/capture`;
    let response: unknown;
    try {
      response = await this.request(
        "captureAuthorization",
        paymentId,
        path,
        "POST",
        z.unknown(),
        { final_capture: true },
      );
    } catch (error) {
      if (!this.isAmbiguousCaptureError(error)) {
        throw error;
      }
      return this.recoverCapture(paymentId, authorizationId, undefined, true);
    }

    const parsed = captureResponseSchema.safeParse(response);
    if (parsed.success) {
      try {
        return this.normalizeCapture(parsed.data);
      } catch {
        return this.recoverCapture(paymentId, authorizationId, response, true);
      }
    }
    return this.recoverCapture(paymentId, authorizationId, response, true);
  }

  async getCapture(paymentId: string, captureId: string): Promise<Capture> {
    const capture = await this.request(
      "getCapture",
      paymentId,
      `/v2/payments/captures/${encodeIdentifier(captureId, "getCapture")}`,
      "GET",
      captureResponseSchema,
    );
    return this.normalizeCapture(capture);
  }

  async voidAuthorization(
    paymentId: string,
    authorizationId: string,
  ): Promise<Authorization> {
    await this.request(
      "voidAuthorization",
      paymentId,
      `/v2/payments/authorizations/${encodeIdentifier(authorizationId, "voidAuthorization")}/void`,
      "POST",
      z.undefined(),
      {},
    );
    const authorization = await this.getAuthorization(paymentId, authorizationId);
    if (authorization.status !== "VOIDED") {
      throw new PayPalProviderError("VOID_NOT_VERIFIED", "voidAuthorization");
    }
    return authorization;
  }

  async refundCapture(paymentId: string, captureId: string): Promise<Refund> {
    const refund = await this.request(
      "refundCapture",
      paymentId,
      `/v2/payments/captures/${encodeIdentifier(captureId, "refundCapture")}/refund`,
      "POST",
      refundResponseSchema,
      {},
    );
    return { refundId: refund.id, status: refund.status };
  }

  private normalizeAuthorization(
    authorization: PayPalAuthorization,
  ): Authorization {
    const { amountCents, currency } = parseAmount(authorization.amount);
    return {
      authorizationId: authorization.id,
      status: authorization.status,
      amountCents,
      currency,
    };
  }

  private normalizeCapture(capture: PayPalCapture): Capture {
    const { amountCents, currency } = parseAmount(capture.amount);
    return {
      captureId: capture.id,
      status: capture.status,
      amountCents,
      currency,
      finalCapture: capture.final_capture ?? null,
    };
  }

  private isAmbiguousCaptureError(error: unknown): boolean {
    return error instanceof PayPalProviderError &&
      error.operation === "captureAuthorization" &&
      (error.code === "NETWORK_ERROR" ||
        error.code === "RESPONSE_SCHEMA_INVALID" ||
        (error.httpStatus !== undefined && error.httpStatus >= 500));
  }

  private async recoverCapture(
    paymentId: string,
    authorizationId: string,
    response: unknown,
    mayRetry: boolean,
  ): Promise<Capture> {
    const captureId = z.object({ id: z.string().min(1) })
      .passthrough()
      .safeParse(response).data?.id;
    let captureLookupError: unknown;
    if (captureId) {
      try {
        return await this.getCapture(paymentId, captureId);
      } catch (error) {
        captureLookupError = error;
      }
    }

    let authorization: Authorization;
    try {
      authorization = await this.getAuthorization(paymentId, authorizationId);
    } catch {
      throw new PayPalProviderError(
        "CAPTURE_RECOVERY_PENDING",
        "captureAuthorization",
      );
    }
    if (authorization.status === "CAPTURED" ||
      authorization.status === "PARTIALLY_CAPTURED") {
      throw new PayPalProviderError(
        "CAPTURE_RECOVERY_PENDING",
        "captureAuthorization",
      );
    }
    if (mayRetry &&
      (authorization.status === "CREATED" ||
        authorization.status === "PENDING")) {
      let retryResponse: unknown;
      try {
        retryResponse = await this.request(
          "captureAuthorization",
          paymentId,
          `/v2/payments/authorizations/${encodeIdentifier(authorizationId, "captureAuthorization")}/capture`,
          "POST",
          z.unknown(),
          { final_capture: true },
        );
      } catch (error) {
        if (this.isAmbiguousCaptureError(error)) {
          throw new PayPalProviderError(
            "CAPTURE_RECOVERY_PENDING",
            "captureAuthorization",
          );
        }
        throw error;
      }
      const retryParsed = captureResponseSchema.safeParse(retryResponse);
      if (retryParsed.success) {
        try {
          return this.normalizeCapture(retryParsed.data);
        } catch {
          return this.recoverCapture(
            paymentId,
            authorizationId,
            retryResponse,
            false,
          );
        }
      }
      return this.recoverCapture(
        paymentId,
        authorizationId,
        retryResponse,
        false,
      );
    }
    if (captureLookupError instanceof PayPalProviderError &&
      captureLookupError.code === "NETWORK_ERROR") {
      throw new PayPalProviderError(
        "CAPTURE_RECOVERY_PENDING",
        "captureAuthorization",
      );
    }
    throw new PayPalProviderError(
      "RESPONSE_SCHEMA_INVALID",
      "captureAuthorization",
    );
  }

  private async request<T>(
    operation: Operation,
    paymentId: string,
    path: string,
    method: "GET" | "POST",
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    encodeIdentifier(paymentId, operation);
    const token = await this.getAccessToken();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "PayPal-Request-Id": derivePayPalRequestId(paymentId, operation),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new PayPalProviderError("NETWORK_ERROR", operation);
    }
    if (!response.ok) {
      throw await this.mapApiError(response, operation);
    }
    if (response.status === 204) {
      const parsed = schema.safeParse(undefined);
      if (!parsed.success) {
        throw new PayPalProviderError("RESPONSE_SCHEMA_INVALID", operation);
      }
      return parsed.data;
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new PayPalProviderError("RESPONSE_SCHEMA_INVALID", operation);
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new PayPalProviderError("RESPONSE_SCHEMA_INVALID", operation);
    }
    return parsed.data;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }
    if (this.tokenRequest) {
      return this.tokenRequest;
    }
    this.tokenRequest = this.fetchAccessToken();
    try {
      return await this.tokenRequest;
    } finally {
      this.tokenRequest = undefined;
    }
  }

  private async fetchAccessToken(): Promise<string> {
    const basicAuth = Buffer.from(
      `${this.clientId}:${this.clientSecret}`,
      "utf8",
    ).toString("base64");
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basicAuth}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: "grant_type=client_credentials",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new PayPalProviderError("NETWORK_ERROR", "oauth");
    }
    if (!response.ok) {
      throw await this.mapApiError(response, "oauth");
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new PayPalProviderError("RESPONSE_SCHEMA_INVALID", "oauth");
    }
    const parsed = oauthResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new PayPalProviderError("RESPONSE_SCHEMA_INVALID", "oauth");
    }
    this.accessToken = parsed.data.access_token;
    this.tokenExpiresAt =
      Date.now() + Math.max(1, parsed.data.expires_in - 60) * 1000;
    return parsed.data.access_token;
  }

  private async mapApiError(
    response: Response,
    operation: string,
  ): Promise<PayPalProviderError> {
    let code = `HTTP_${response.status}`;
    try {
      const payload: unknown = await response.json();
      const parsed = apiErrorSchema.safeParse(payload);
      const candidate = parsed.data?.name;
      if (candidate && /^[A-Z0-9_]{1,64}$/.test(candidate)) {
        code = candidate;
      }
    } catch {
      // The fixed HTTP code is sufficient when PayPal returns a non-JSON error.
    }
    return new PayPalProviderError(code, operation, response.status);
  }
}

export type { AuthorizationStatus, CaptureStatus };
export { SANDBOX_API_URL };
