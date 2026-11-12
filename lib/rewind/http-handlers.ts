import { z } from "zod";
import {
  createMandateSchema,
  guardianRules,
  type Mandate,
  type Payment,
} from "../../domain/index.ts";
import type { PaymentDetail } from "../../orchestrator/ports.ts";
import { OrchestratorError, type PaymentOrchestrator } from "../../orchestrator/service.ts";
import { PayPalProviderError } from "../../paypal/payment-provider.ts";
import { PersistenceError } from "../../persistence/repositories.ts";

const requestPaymentSchema = z
  .object({
    mandateId: z.string().uuid(),
    payeeEmail: z.string().trim().email(),
    amountCents: z.number().int().positive().safe(),
    invoiceId: z.string().trim().min(1).max(127),
  })
  .strict();

const identifierSchema = z.string().uuid();

const providerErrorCodes = new Set([
  "APPROVAL_NOT_VERIFIED",
  "APPROVAL_TIMEOUT",
  "APPROVAL_STATUS_INVALID",
  "AUTHORIZATION_MISMATCH",
  "AUTHORIZATION_NOT_READY",
  "AUTHORIZATION_MISSING",
  "CAPTURE_NOT_COMPLETED",
  "CAPTURE_RECOVERY_PENDING",
  "CAPTURE_NOT_FOUND",
  "NETWORK_ERROR",
  "RESPONSE_SCHEMA_INVALID",
  "ORDER_DATA_INCOMPLETE",
  "ORDER_READBACK_MISMATCH",
  "UNSAFE_BASE_URL",
  "MISSING_CREDENTIALS",
  "INVALID_CONFIGURATION",
  "VOID_NOT_VERIFIED",
  "REFUND_NOT_COMPLETED",
]);

const conflictCodes = new Set([
  "ACTION_ALREADY_CLAIMED",
  "AUTHORIZATION_MISSING",
  "BUDGET_EXCEEDED",
  "CAPTURE_MISSING",
  "DUPLICATE_INVOICE",
  "INVALID_TRANSITION",
  "MANDATE_EXPIRED",
  "MANDATE_INACTIVE",
  "MANDATE_NOT_ACTIVE",
  "ORDER_NOT_READY",
  "PAYMENT_STATUS_CONFLICT",
]);
const internalOrchestratorErrorCodes = new Set([
  "INVALID_CLOCK",
  "MANDATE_SIGNATURE_INVALID",
  "SIGNING_SECRET_REQUIRED",
]);

export type RewindHttpOrchestrator = Pick<
  PaymentOrchestrator,
  | "listMandates"
  | "createMandate"
  | "revokeMandate"
  | "requestPayment"
  | "completeAuthorization"
  | "listPayments"
  | "getPaymentDetail"
  | "undo"
  | "refund"
  | "releaseDue"
  | "recoverStaleReleases"
  | "listPayments"
>;

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function errorResponse(
  code: string,
  message: string,
  status: number,
): Response {
  return json({ error: { code, message } }, status);
}

function errorToResponse(error: unknown): Response {
  if (error instanceof z.ZodError) {
    return errorResponse("VALIDATION_ERROR", "Request validation failed.", 422);
  }
  if (error instanceof PayPalProviderError) {
    return errorResponse("PROVIDER_ERROR", error.message, 502);
  }
  if (error instanceof PersistenceError || error instanceof OrchestratorError) {
    if (error.code === "MANDATE_NOT_FOUND" || error.code === "PAYMENT_NOT_FOUND") {
      return errorResponse(error.code, error.message, 404);
    }
    if (conflictCodes.has(error.code)) {
      return errorResponse(error.code, error.message, 409);
    }
    if (providerErrorCodes.has(error.code)) {
      return errorResponse(error.code, error.message, 502);
    }
    if (
      error instanceof OrchestratorError &&
      !internalOrchestratorErrorCodes.has(error.code)
    ) {
      return errorResponse("PROVIDER_ERROR", error.message, 502);
    }
    if (error.code === "INVALID_RECORD" || error.code === "INVALID_INPUT") {
      return errorResponse("VALIDATION_ERROR", "Request validation failed.", 422);
    }
    return errorResponse(error.code, error.message, 500);
  }
  return errorResponse("INTERNAL_ERROR", "The request could not be completed.", 500);
}

export function createUnavailableRewindHandlers(error: unknown) {
  const respond = async () => errorToResponse(error);
  return {
    getMandates: respond,
    postMandates: respond,
    postRevokeMandate: respond,
    postPaymentRequest: respond,
    postAuthorizePayment: respond,
    getPayments: respond,
    getPayment: respond,
    postUndoPayment: respond,
    postRefundPayment: respond,
    postReleaseDue: respond,
    getHealth: respond,
  };
}

async function execute<T>(
  operation: () => Promise<T>,
  status = 200,
): Promise<Response> {
  try {
    return json(await operation(), status);
  } catch (error) {
    return errorToResponse(error);
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: [],
        message: "Body must be valid JSON.",
      },
    ]);
  }
}

function publicMandate(mandate: Mandate) {
  return {
    id: mandate.id,
    version: mandate.version,
    payee_email: mandate.payee_email,
    per_payment_cap: mandate.per_payment_cap,
    total_cap: mandate.total_cap,
    spent_total: mandate.spent_total,
    reserved_total: mandate.reserved_total,
    currency: mandate.currency,
    purpose: mandate.purpose,
    expires_at: mandate.expires_at,
    undo_window_seconds: mandate.undo_window_seconds,
    status: mandate.status,
    created_at: mandate.created_at,
  };
}

function publicPayment(payment: Payment) {
  return {
    id: payment.id,
    mandate_id: payment.mandate_id,
    status: payment.status,
    release_at: payment.release_at,
    amount: payment.amount,
    currency: payment.currency,
    payee_email: payment.payee_email,
    invoice_id: payment.invoice_id,
    created_at: payment.created_at,
    updated_at: payment.updated_at,
  };
}

function latestDecisions(detail: PaymentDetail) {
  const latestByRule = new Map<string, PaymentDetail["decisions"][number]>();
  for (const decision of detail.decisions) {
    const previous = latestByRule.get(decision.rule);
    if (
      !previous ||
      decision.created_at > previous.created_at ||
      (decision.created_at === previous.created_at && decision.id > previous.id)
    ) {
      latestByRule.set(decision.rule, decision);
    }
  }
  return guardianRules.flatMap((rule) => {
    const decision = latestByRule.get(rule);
    return decision
      ? [{
          rule: decision.rule,
          phase: decision.phase,
          passed: decision.passed,
          expected: decision.expected,
          actual: decision.actual,
        }]
      : [];
  });
}

export function createRewindHandlers(orchestrator: RewindHttpOrchestrator) {
  return {
    getHealth: () =>
      execute(async () => ({
        ok: true,
        pendingHeldCount: (await orchestrator.listPayments()).filter(
          (payment) => payment.status === "held",
        ).length,
      })),

    getMandates: () =>
      execute(async () => ({
        mandates: (await orchestrator.listMandates()).map(publicMandate),
      })),

    postMandates: async (request: Request) =>
      execute(async () => {
        const input = createMandateSchema.parse(await readJson(request));
        return { mandate: publicMandate(await orchestrator.createMandate(input)) };
      }, 201),

    postRevokeMandate: async (_request: Request, rawId: string) =>
      execute(async () => {
        const id = identifierSchema.parse(rawId);
        return { mandate: publicMandate(await orchestrator.revokeMandate(id)) };
      }),

    postPaymentRequest: async (request: Request) => {
      try {
        const input = requestPaymentSchema.parse(await readJson(request));
        const result = await orchestrator.requestPayment(input);
        const approvalLink = result.approvalUrl
          ? { approval_url: result.approvalUrl }
          : {};
        return json({
          payment: { ...publicPayment(result.payment), ...approvalLink },
          decision: result.decision,
        }, result.payment.status === "rejected" ? 200 : 201);
      } catch (error) {
        return errorToResponse(error);
      }
    },

    postAuthorizePayment: async (_request: Request, rawId: string) =>
      execute(async () => {
        const id = identifierSchema.parse(rawId);
        const payment = await orchestrator.completeAuthorization(id);
        const detail = await orchestrator.getPaymentDetail(payment.id);
        return {
          payment: publicPayment(payment),
          decisions: latestDecisions(detail),
        };
      }),

    getPayments: () =>
      execute(async () => {
        const payments = await orchestrator.listPayments();
        const rows = await Promise.all(
          payments.map(async (payment) => {
            const detail = await orchestrator.getPaymentDetail(payment.id);
            return {
              ...publicPayment(payment),
              decisions: latestDecisions(detail),
            };
          }),
        );
        return { payments: rows };
      }),

    getPayment: async (rawId: string) =>
      execute(async () => {
        const id = identifierSchema.parse(rawId);
        const detail = await orchestrator.getPaymentDetail(id);
        return {
          payment: publicPayment(detail.payment),
          decisions: detail.decisions,
          events: detail.events,
        };
      }),

    postUndoPayment: async (_request: Request, rawId: string) =>
      execute(async () => {
        const id = identifierSchema.parse(rawId);
        const payment = await orchestrator.undo(id);
        const detail = await orchestrator.getPaymentDetail(payment.id);
        return {
          payment: publicPayment(payment),
          decisions: latestDecisions(detail),
        };
      }),

    postRefundPayment: async (_request: Request, rawId: string) =>
      execute(async () => {
        const id = identifierSchema.parse(rawId);
        const payment = await orchestrator.refund(id);
        const detail = await orchestrator.getPaymentDetail(payment.id);
        return {
          payment: publicPayment(payment),
          decisions: latestDecisions(detail),
        };
      }),

    postReleaseDue: () =>
      execute(async () => {
        const now = new Date();
        const staleClaimSeconds = z.coerce.number().int().positive().max(86400)
          .parse(process.env.STALE_CLAIM_SECONDS ?? "120");
        const recovered = await orchestrator.recoverStaleReleases(
          now,
          staleClaimSeconds,
        );
        const results = await orchestrator.releaseDue(now, staleClaimSeconds);
        return {
          capturedCount: results.filter((result) => result.status === "captured")
            .length,
          recoveredCapturedCount: recovered.filter(
            (result) => result.status === "captured",
          ).length,
          results,
        };
      }),
  };
}
