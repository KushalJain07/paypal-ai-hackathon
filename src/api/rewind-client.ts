import { z } from "zod";

import { env } from "../config/env.ts";

const requestPaymentInputSchema = z
  .object({
    mandateId: z.string().uuid(),
    payeeEmail: z.string().trim().email(),
    amountCents: z.number().int().positive().safe(),
    invoiceId: z.string().trim().min(1).max(127),
  })
  .strict();

export type RequestPaymentInput = z.infer<typeof requestPaymentInputSchema>;

const paymentSchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
  approval_url: z.string().url().nullable().optional(),
  amount: z.number().int().safe().optional(),
  currency: z.string().optional(),
  payee_email: z.string().optional(),
  invoice_id: z.string().nullable().optional(),
  release_at: z.string().nullable().optional(),
});

const requestResponseSchema = z.object({
  payment: paymentSchema,
});

const detailResponseSchema = z.object({
  payment: paymentSchema,
  decisions: z.array(z.object({
    rule: z.enum(["R1", "R2", "R3", "R4", "R5"]),
    phase: z.enum(["preflight", "authorized"]),
    passed: z.boolean(),
    expected: z.record(z.string(), z.unknown()),
    actual: z.record(z.string(), z.unknown()),
  })).optional(),
});

const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

export interface RewindApiError {
  code: string;
  message: string;
}

export class RewindClientError extends Error {
  readonly code: string;

  constructor(error: RewindApiError) {
    super(error.message);
    this.name = "RewindClientError";
    this.code = error.code;
  }
}

async function request<T>(
  path: string,
  init: RequestInit,
  schema: z.ZodType<T>,
  apiBaseUrl = env.REWIND_API_BASE_URL,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl.replace(/\/+$/, "")}/api/rewind${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...init.headers,
      },
      cache: "no-store",
    });
  } catch {
    throw new RewindClientError({
      code: "API_UNAVAILABLE",
      message: "The REWIND API could not be reached.",
    });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new RewindClientError({
      code: "INVALID_API_RESPONSE",
      message: "The REWIND API returned an invalid response.",
    });
  }

  if (!response.ok) {
    const parsedError = apiErrorSchema.safeParse(body);
    throw new RewindClientError(parsedError.success
      ? parsedError.data.error
      : {
          code: "API_REQUEST_FAILED",
          message: "The REWIND API request failed.",
        });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new RewindClientError({
      code: "INVALID_API_RESPONSE",
      message: "The REWIND API returned an unexpected response.",
    });
  }
  return parsed.data;
}

export async function requestPayment(input: unknown, apiBaseUrl?: string) {
  const validated = requestPaymentInputSchema.parse(input);
  const result = await request(
    "/payments/request",
    { method: "POST", body: JSON.stringify(validated) },
    requestResponseSchema,
    apiBaseUrl,
  );
  return {
    paymentId: result.payment.id,
    status: result.payment.status,
    approvalUrl: result.payment.approval_url ?? null,
  };
}

export async function getPaymentStatus(paymentId: unknown, apiBaseUrl?: string) {
  const id = z.string().uuid().parse(paymentId);
  const result = await request(
    `/payments/${encodeURIComponent(id)}`,
    { method: "GET" },
    detailResponseSchema,
    apiBaseUrl,
  );
  return {
    paymentId: result.payment.id,
    status: result.payment.status,
    amountCents: result.payment.amount,
    currency: result.payment.currency,
    payeeEmail: result.payment.payee_email,
    invoiceId: result.payment.invoice_id,
    releaseAt: result.payment.release_at,
    decisions: result.decisions ?? [],
  };
}
