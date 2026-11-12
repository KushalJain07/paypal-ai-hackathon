import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PayPalProviderError,
  type PaymentProvider,
} from "../../paypal/payment-provider.ts";
import { ManualApprovalProvider } from "../../paypal/manual-approval-provider.ts";
import {
  derivePayPalRequestId,
  SandboxPaymentProvider,
} from "../../paypal/sandbox-payment-provider.ts";

const paymentId = "payment-123";
const orderId = "ORDER-123";
const authorizationId = "AUTH-123";

function response(
  body: unknown,
  status = 200,
): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeProvider(fetch: typeof globalThis.fetch): SandboxPaymentProvider {
  return new SandboxPaymentProvider({
    baseUrl: "https://api-m.sandbox.paypal.com",
    clientId: "test-client",
    clientSecret: "test-secret",
    fetch,
  });
}

function tokenResponse(): Response {
  return response({ access_token: "unit-test-token", expires_in: 3600 });
}

function orderResponse(
  status = "CREATED",
  includeAuthorization = false,
): object {
  return {
    id: orderId,
    status,
    intent: "AUTHORIZE",
    links: [{ href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-123", rel: "approve" }],
    purchase_units: [
      {
        invoice_id: "invoice-123",
        payee: { email_address: "payee@example.com" },
        amount: { currency_code: "USD", value: "12.34" },
        ...(includeAuthorization
          ? {
              payments: {
                authorizations: [{ id: authorizationId, status: "CREATED" }],
              },
            }
          : {}),
      },
    ],
  };
}

function authorizationResponse(status = "CREATED"): object {
  return {
    id: authorizationId,
    status,
    amount: { currency_code: "USD", value: "12.34" },
  };
}

describe("PayPal Sandbox payment provider", () => {
  it("creates AUTHORIZE orders and normalizes Guardian data", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const provider = makeProvider(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      return url.endsWith("/v1/oauth2/token")
        ? tokenResponse()
        : response(orderResponse());
    });

    const result = await provider.createOrder({
      paymentId,
      payeeEmail: "payee@example.com",
      amountCents: 1234,
      currency: "USD",
      invoiceId: "invoice-123",
    });

    assert.equal(result.paypalOrderId, orderId);
    assert.equal(result.status, "CREATED");
    assert.equal(calls.length, 2);
    const createCall = calls[1];
    assert.ok(createCall);
    assert.equal(createCall.init?.method, "POST");
    assert.equal(
      new Headers(createCall.init?.headers).get("PayPal-Request-Id"),
      derivePayPalRequestId(paymentId, "createOrder"),
    );
    assert.deepEqual(JSON.parse(String(createCall.init?.body)), {
      intent: "AUTHORIZE",
      purchase_units: [
        {
          invoice_id: "invoice-123",
          payee: { email_address: "payee@example.com" },
          amount: { currency_code: "USD", value: "12.34" },
        },
      ],
    });
  });

  it("maps PayPal errors without exposing raw payload values", async () => {
    const provider = makeProvider(async (input) =>
      String(input).endsWith("/v1/oauth2/token")
        ? tokenResponse()
        : response(
            {
              name: "UNPROCESSABLE_ENTITY",
              message: "secret-marker-do-not-include",
              debug_id: "private-debug-marker",
            },
            422,
          ),
    );

    await assert.rejects(
      provider.createOrder({
        paymentId,
        payeeEmail: "payee@example.com",
        amountCents: 100,
        currency: "USD",
        invoiceId: "invoice-123",
      }),
      (error: unknown) => {
        assert.ok(error instanceof PayPalProviderError);
        assert.equal(error.code, "UNPROCESSABLE_ENTITY");
        assert.equal(error.httpStatus, 422);
        assert.equal(error.message.includes("secret-marker"), false);
        assert.equal(error.message.includes("private-debug-marker"), false);
        return true;
      },
    );
  });

  it("uses stable, operation-specific idempotency headers on resource calls", async () => {
    const resourceHeaders: string[] = [];
    const provider = makeProvider(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/oauth2/token")) {
        return tokenResponse();
      }
      resourceHeaders.push(new Headers(init?.headers).get("PayPal-Request-Id") ?? "");
      return response(
        url.includes("/checkout/orders")
          ? orderResponse("COMPLETED", true)
          : authorizationResponse(),
      );
    });

    await provider.createOrder({
      paymentId,
      payeeEmail: "payee@example.com",
      amountCents: 1234,
      currency: "USD",
      invoiceId: "invoice-123",
    });
    const snapshot = await provider.getOrder(paymentId, orderId);

    assert.equal(resourceHeaders[0], derivePayPalRequestId(paymentId, "createOrder"));
    assert.equal(resourceHeaders[1], derivePayPalRequestId(paymentId, "getOrder"));
    assert.equal(snapshot.observedPayment.payee_email, "payee@example.com");
    assert.equal(snapshot.observedPayment.amount, 1234);
    assert.equal(snapshot.observedPayment.currency, "USD");
    assert.equal(snapshot.observedPayment.invoice_id, "invoice-123");
    assert.equal(snapshot.observedPayment.paypal_order_id, orderId);
    assert.equal(snapshot.observedPayment.authorization_id, authorizationId);
    assert.equal(snapshot.observedPayment.status, "authorized");
    assert.notEqual(resourceHeaders[0], resourceHeaders[1]);
    assert.equal(
      derivePayPalRequestId(paymentId, "createOrder"),
      derivePayPalRequestId(paymentId, "createOrder"),
    );
    assert.equal(derivePayPalRequestId(paymentId, "createOrder").length, 32);
  });

  it("rejects a non-Sandbox base URL at construction", () => {
    assert.throws(
      () =>
        new SandboxPaymentProvider({
          baseUrl: "https://api-m.paypal.com",
          clientId: "test-client",
          clientSecret: "test-secret",
          fetch: globalThis.fetch,
        }),
      (error: unknown) =>
        error instanceof PayPalProviderError && error.code === "UNSAFE_BASE_URL",
    );
  });

  it("verifies void status by reading the authorization after voiding", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const provider = makeProvider(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/v1/oauth2/token")) {
        return tokenResponse();
      }
      if (url.endsWith("/void")) {
        return response(undefined, 204);
      }
      return response(authorizationResponse("VOIDED"));
    });

    const result = await provider.voidAuthorization(paymentId, authorizationId);
    assert.equal(result.status, "VOIDED");
    assert.equal(calls.length, 3);
    assert.equal(calls[1]?.url.endsWith(`/authorizations/${authorizationId}/void`), true);
    assert.equal(calls[2]?.url.endsWith(`/authorizations/${authorizationId}`), true);
    assert.equal(
      new Headers(calls[1]?.init?.headers).get("PayPal-Request-Id"),
      derivePayPalRequestId(paymentId, "voidAuthorization"),
    );
    assert.equal(
      new Headers(calls[2]?.init?.headers).get("PayPal-Request-Id"),
      derivePayPalRequestId(paymentId, "getAuthorization"),
    );
  });

  it("authorizes, captures, and refunds using normalized results", async () => {
    const provider = makeProvider(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/oauth2/token")) {
        return tokenResponse();
      }
      if (url.endsWith(`/checkout/orders/${orderId}/authorize`)) {
        return response({
          ...orderResponse("COMPLETED"),
          purchase_units: [
            {
              invoice_id: "invoice-123",
              payee: { email_address: "payee@example.com" },
              amount: { currency_code: "USD", value: "12.34" },
              payments: {
                authorizations: [{ id: authorizationId, status: "CREATED" }],
              },
            },
          ],
        });
      }
      if (url.endsWith(`/authorizations/${authorizationId}`)) {
        return response(authorizationResponse());
      }
      if (url.endsWith(`/authorizations/${authorizationId}/capture`)) {
        return response({
          id: "CAPTURE-123",
          status: "COMPLETED",
          amount: { currency_code: "USD", value: "12.34" },
        });
      }
      return response({ id: "REFUND-123", status: "COMPLETED" });
    });

    const authorization = await provider.authorizeOrder(paymentId, orderId);
    const capture = await provider.captureAuthorization(
      paymentId,
      authorization.authorizationId,
    );
    const refund = await provider.refundCapture(paymentId, capture.captureId);

    assert.deepEqual(authorization, {
      authorizationId,
      status: "CREATED",
      amountCents: 1234,
      currency: "USD",
    });
    assert.deepEqual(capture, {
      captureId: "CAPTURE-123",
      status: "COMPLETED",
      amountCents: 1234,
      currency: "USD",
    });
    assert.deepEqual(refund, {
      refundId: "REFUND-123",
      status: "COMPLETED",
    });
  });
});

describe("manual approval provider", () => {
  it("prints the approval link and polls until PayPal reports APPROVED", async () => {
    const statuses: Array<"CREATED" | "APPROVED"> = ["CREATED", "APPROVED"];
    const printed: string[] = [];
    const provider: PaymentProvider = {
      async createOrder() {
        throw new Error("not used");
      },
      async getOrder() {
        const status = statuses.shift();
        assert.ok(status);
        return {
          paypalOrderId: orderId,
          status,
          observedPayment: {
            payee_email: "payee@example.com",
            amount: 100,
            currency: "USD",
            invoice_id: "invoice-123",
            paypal_order_id: orderId,
            authorization_id: null,
            status: "requested",
          },
        };
      },
      async authorizeOrder() {
        throw new Error("not used");
      },
      async getAuthorization() {
        throw new Error("not used");
      },
      async captureAuthorization() {
        throw new Error("not used");
      },
      async voidAuthorization() {
        throw new Error("not used");
      },
      async refundCapture() {
        throw new Error("not used");
      },
    };
    const approval = new ManualApprovalProvider(provider, {
      timeoutMs: 1000,
      intervalMs: 1,
      print: (message) => printed.push(message),
      sleep: async () => {},
    });

    const result = await approval.approve({
      paymentId,
      paypalOrderId: orderId,
      approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-123",
    });
    assert.equal(result.status, "APPROVED");
    assert.deepEqual(printed, [
      "Approve this PayPal Sandbox order: https://www.sandbox.paypal.com/checkoutnow?token=ORDER-123",
    ]);
  });
});
