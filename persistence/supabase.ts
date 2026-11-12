import { createClient, type PostgrestError, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  decisionSchema,
  type Decision,
  type DecisionPhase,
} from "../domain/decision.ts";
import { mandateSchema, type Mandate } from "../domain/mandate.ts";
import {
  budgetStateSchema,
  paymentSchema,
  type BudgetState,
  type Payment,
} from "../domain/payment.ts";
import type {
  Database,
  DecisionRow,
  EventRow,
  MandateRow,
  PaymentRow,
} from "./database.types.ts";
import {
  appendPaymentEventSchema,
  budgetHistoryQuerySchema,
  decisionRecordSchema,
  paymentEventSchema,
  persistedMandateSchema,
  reservePaymentInputSchema,
  repositoryIdSchema,
  type AppendPaymentEvent,
  type DecisionRecord,
  type PaymentEvent,
} from "./schemas.ts";
import {
  PersistenceError,
  type PersistenceErrorCode,
  type PaymentAction,
  type PaymentTransitionInput,
  type PersistenceRepositories,
} from "./repositories.ts";

function databaseError(error: PostgrestError): PersistenceError {
  const message = error.message.trim();
  const knownCodes: readonly PersistenceErrorCode[] = [
    "MANDATE_NOT_FOUND",
    "MANDATE_INACTIVE",
    "MANDATE_EXPIRED",
    "PAYMENT_AMOUNT_INVALID",
    "CURRENCY_MISMATCH",
    "INVALID_PAYEE_EMAIL",
    "INVOICE_ID_REQUIRED",
    "DUPLICATE_INVOICE",
    "BUDGET_EXCEEDED",
    "PAYMENT_NOT_FOUND",
    "PAYMENT_STATUS_CONFLICT",
    "ACTION_ALREADY_CLAIMED",
    "INVALID_TRANSITION",
    "MANDATE_NOT_ACTIVE",
    "BUDGET_INVARIANT_FAILED",
  ];
  const knownCode = knownCodes.find((code) => code === message);

  if (knownCode) {
    return new PersistenceError(
      knownCode,
      persistenceMessage(knownCode),
    );
  }
  if (error.code === "23505") {
    const constraint = `${message} ${error.details ?? ""}`;
    if (constraint.includes("mandates_pkey")) {
      return new PersistenceError(
        "DUPLICATE_MANDATE",
        "A mandate with this ID already exists.",
      );
    }
    if (constraint.includes("mandate_invoice")) {
      return new PersistenceError(
        "DUPLICATE_INVOICE",
        persistenceMessage("DUPLICATE_INVOICE"),
      );
    }
    return new PersistenceError(
      "DUPLICATE_PAYMENT",
      "A record with the same unique identifier already exists.",
    );
  }

  return new PersistenceError(
    "DATABASE_ERROR",
    `Supabase persistence operation failed (${error.code || "unknown database error"}).`,
  );
}

function persistenceMessage(code: PersistenceErrorCode): string {
  switch (code) {
    case "CONFIGURATION_ERROR":
      return "Supabase persistence configuration is invalid.";
    case "DUPLICATE_MANDATE":
      return "A mandate with this ID already exists.";
    case "MANDATE_NOT_FOUND":
      return "The requested mandate does not exist.";
    case "MANDATE_INACTIVE":
      return "The mandate is not active.";
    case "MANDATE_EXPIRED":
      return "The mandate has expired.";
    case "PAYMENT_AMOUNT_INVALID":
      return "The payment amount exceeds the mandate's per-payment cap.";
    case "CURRENCY_MISMATCH":
      return "The payment currency does not match the mandate.";
    case "INVALID_PAYEE_EMAIL":
      return "The payee email is invalid.";
    case "INVOICE_ID_REQUIRED":
      return "An invoice ID is required.";
    case "DUPLICATE_INVOICE":
      return "This invoice has already been used under the mandate.";
    case "BUDGET_EXCEEDED":
      return "The requested payment exceeds the mandate's available budget.";
    case "PAYMENT_NOT_FOUND":
      return "The requested payment does not exist.";
    case "PAYMENT_STATUS_CONFLICT":
      return "The payment status changed before this operation completed.";
    case "ACTION_ALREADY_CLAIMED":
      return "Another payment action is already in progress.";
    case "INVALID_TRANSITION":
      return "The payment status transition is not allowed.";
    case "MANDATE_NOT_ACTIVE":
      return "The mandate is not active.";
    case "BUDGET_INVARIANT_FAILED":
      return "The payment budget could not be updated consistently.";
    default:
      return "The persistence request could not be completed.";
  }
}

function requireData<T>(data: T | null, operation: string): T {
  if (data === null) {
    throw new PersistenceError(
      "DATABASE_ERROR",
      `Supabase ${operation} returned no record.`,
    );
  }
  return data;
}

function mandateFromRow(row: MandateRow): Mandate {
  return mandateSchema.parse(row);
}

function paymentFromRow(row: PaymentRow): Payment {
  return paymentSchema.parse(row);
}

function decisionFromRow(row: DecisionRow): DecisionRecord {
  return decisionRecordSchema.parse(row);
}

function eventFromRow(row: EventRow): PaymentEvent {
  return paymentEventSchema.parse(row);
}

export function createSupabasePersistence(
  env: NodeJS.ProcessEnv = process.env,
): PersistenceRepositories {
  const config = zodSupabaseConfig(env);
  const client = createClient<Database>(config.url, config.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
  return createSupabaseRepositories(client);
}

function zodSupabaseConfig(env: NodeJS.ProcessEnv): {
  url: string;
  serviceRoleKey: string;
} {
  const configSchema = z.object({
    url: z.string().url(),
    serviceRoleKey: z.string().min(1),
  });
  const parsed = configSchema.safeParse({
    url: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  });
  if (!parsed.success) {
    throw new PersistenceError(
      "CONFIGURATION_ERROR",
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured for server persistence.",
    );
  }
  return parsed.data;
}

function createSupabaseRepositories(
  client: SupabaseClient<Database>,
): PersistenceRepositories {
  return {
    mandates: {
      create: async (mandate): Promise<Mandate> => {
        const validated = persistedMandateSchema.parse(mandate);
        const { data, error } = await client
          .from("mandates")
          .insert(validated)
          .select("*")
          .single();
        if (error) {
          throw databaseError(error);
        }
        return mandateFromRow(requireData(data, "mandate create"));
      },

      update: async (mandate): Promise<Mandate> => {
        const validated = persistedMandateSchema.parse(mandate);
        const { data, error } = await client.rpc("update_mandate", {
          p_mandate: validated,
        });
        if (error) {
          throw databaseError(error);
        }
        return mandateFromRow(requireData(data?.[0] ?? null, "mandate update"));
      },

      getById: async (id): Promise<Mandate | null> => {
        const validatedId = repositoryIdSchema.parse(id);
        const { data, error } = await client
          .from("mandates")
          .select("*")
          .eq("id", validatedId)
          .maybeSingle();
        if (error) {
          throw databaseError(error);
        }
        return data ? mandateFromRow(data) : null;
      },

      list: async (): Promise<Mandate[]> => {
        const { data, error } = await client
          .from("mandates")
          .select("*")
          .order("created_at", { ascending: true });
        if (error) {
          throw databaseError(error);
        }
        return data.map(mandateFromRow);
      },
    },

    payments: {
      reserve: async (input): Promise<Payment> => {
        const request = reservePaymentInputSchema.parse(input);
        const { data, error } = await client.rpc("reserve_payment", {
          p_id: request.id,
          p_mandate_id: request.mandate_id,
          p_invoice_id: request.invoice_id,
          p_amount: request.amount,
          p_currency: request.currency,
          p_payee_email: request.payee_email,
          p_created_at: request.created_at,
        });
        if (error) {
          throw databaseError(error);
        }
        const row = requireData(data?.[0] ?? null, "payment reservation");
        return paymentFromRow(row);
      },

      createRejected: async (
        input,
        reason,
        decision,
        createdAt,
      ): Promise<Payment> => {
        const request = reservePaymentInputSchema.parse(input);
        const safeReason = z.string().min(1).max(128).parse(reason);
        const validatedDecision = decisionSchema.parse(decision);
        const validatedAt = z.string().datetime({ offset: true }).parse(createdAt);
        const { data, error } = await client.rpc("create_rejected_payment", {
          p_id: request.id,
          p_mandate_id: request.mandate_id,
          p_invoice_id: request.invoice_id,
          p_amount: request.amount,
          p_currency: request.currency,
          p_payee_email: request.payee_email,
          p_created_at: validatedAt,
          p_reason: safeReason,
          p_decision: validatedDecision,
        });
        if (error) {
          throw databaseError(error);
        }
        return paymentFromRow(
          requireData(data?.[0] ?? null, "rejected payment creation"),
        );
      },

      attachOrder: async (
        paymentId,
        orderId,
        approvalUrl,
        at,
      ): Promise<Payment> => {
        const validatedId = repositoryIdSchema.parse(paymentId);
        const validatedOrderId = z.string().min(1).max(256).parse(orderId);
        const validatedApprovalUrl = z.string().url().parse(approvalUrl);
        const validatedAt = z.string().datetime({ offset: true }).parse(at);
        const { data, error } = await client.rpc("attach_paypal_order", {
          p_payment_id: validatedId,
          p_order_id: validatedOrderId,
          p_approval_url: validatedApprovalUrl,
          p_at: validatedAt,
        });
        if (error) {
          throw databaseError(error);
        }
        return paymentFromRow(
          requireData(data?.[0] ?? null, "PayPal order attachment"),
        );
      },

      transition: async (
        input: PaymentTransitionInput,
      ): Promise<Payment> => {
        const request = z.object({
          paymentId: repositoryIdSchema,
          expectedStatus: paymentSchema.shape.status,
          nextStatus: paymentSchema.shape.status,
          at: z.string().datetime({ offset: true }),
          budgetEffect: z.enum([
            "none",
            "release_reserved",
            "reserved_to_spent",
            "restore_spent",
          ]),
          eventType: z.string().min(1).max(128),
          detail: z.record(z.string(), z.union([
            z.string(),
            z.number().finite(),
            z.boolean(),
            z.null(),
          ])),
          paypalOrderId: z.string().min(1).max(256).optional(),
          authorizationId: z.string().min(1).max(256).optional(),
          captureId: z.string().min(1).max(256).optional(),
          releaseAt: z.string().datetime({ offset: true }).nullable().optional(),
          failureReason: z.string().max(512).nullable().optional(),
          claimAction: z.enum(["undo", "release", "refund"]).optional(),
        }).strict().parse(input);
        const { data, error } = await client.rpc("transition_payment", {
          p_payment_id: request.paymentId,
          p_expected_status: request.expectedStatus,
          p_next_status: request.nextStatus,
          p_at: request.at,
          p_budget_effect: request.budgetEffect,
          p_event_type: request.eventType,
          p_detail: request.detail,
          p_paypal_order_id: request.paypalOrderId,
          p_authorization_id: request.authorizationId,
          p_capture_id: request.captureId,
          p_release_at: request.releaseAt,
          p_failure_reason: request.failureReason,
          p_claim_action: request.claimAction,
        });
        if (error) {
          throw databaseError(error);
        }
        return paymentFromRow(
          requireData(data?.[0] ?? null, "payment transition"),
        );
      },

      claimAction: async (
        paymentId,
        expectedStatus,
        action: PaymentAction,
        at,
        dueAt,
        staleAfterSeconds = 120,
      ): Promise<boolean> => {
        const validatedId = repositoryIdSchema.parse(paymentId);
        const validatedStatus = paymentSchema.shape.status.parse(expectedStatus);
        const validatedAction = z.enum(["undo", "release", "refund"]).parse(action);
        const validatedAt = z.string().datetime({ offset: true }).parse(at);
        const validatedDueAt = dueAt === undefined
          ? null
          : z.string().datetime({ offset: true }).parse(dueAt);
        const validatedStaleAfterSeconds = z.number().int().positive().max(86400)
          .parse(staleAfterSeconds);
        const { data, error } = await client.rpc("claim_payment_action_v2", {
          p_payment_id: validatedId,
          p_expected_status: validatedStatus,
          p_action: validatedAction,
          p_at: validatedAt,
          p_due_at: validatedDueAt,
          p_stale_after_seconds: validatedStaleAfterSeconds,
        });
        if (error) {
          throw databaseError(error);
        }
        return data === true;
      },

      listStaleReleaseClaims: async (
        before,
      ): Promise<Array<{ payment: Payment; claimedAt: string }>> => {
        const validatedBefore = z.string().datetime({ offset: true }).parse(before);
        const { data, error } = await client.rpc("list_stale_release_claims", {
          p_before: validatedBefore,
        });
        if (error) {
          throw databaseError(error);
        }
        const claims = data ?? [];
        if (claims.length === 0) {
          return [];
        }
        const { data: paymentRows, error: paymentError } = await client
          .from("payments")
          .select("*")
          .in("id", claims.map((claim) => claim.payment_id));
        if (paymentError) {
          throw databaseError(paymentError);
        }
        const paymentsById = new Map(
          paymentRows.map((row) => [row.id, paymentFromRow(row)]),
        );
        return claims.flatMap((claim) => {
          const payment = paymentsById.get(claim.payment_id);
          return payment
            ? [{ payment, claimedAt: claim.claimed_at }]
            : [];
        });
      },

      clearActionClaim: async (
        paymentId,
        action: PaymentAction,
      ): Promise<void> => {
        const { error } = await client.rpc("clear_payment_action_claim", {
          p_payment_id: repositoryIdSchema.parse(paymentId),
          p_action: z.enum(["undo", "release", "refund"]).parse(action),
        });
        if (error) {
          throw databaseError(error);
        }
      },

      getById: async (id): Promise<Payment | null> => {
        const validatedId = repositoryIdSchema.parse(id);
        const { data, error } = await client
          .from("payments")
          .select("*")
          .eq("id", validatedId)
          .maybeSingle();
        if (error) {
          throw databaseError(error);
        }
        return data ? paymentFromRow(data) : null;
      },

      listAll: async (): Promise<Payment[]> => {
        const { data, error } = await client
          .from("payments")
          .select("*")
          .order("created_at", { ascending: true });
        if (error) {
          throw databaseError(error);
        }
        return data.map(paymentFromRow);
      },

      listByMandate: async (mandateId): Promise<Payment[]> => {
        const validatedMandateId = repositoryIdSchema.parse(mandateId);
        const { data, error } = await client
          .from("payments")
          .select("*")
          .eq("mandate_id", validatedMandateId)
          .order("created_at", { ascending: true });
        if (error) {
          throw databaseError(error);
        }
        return data.map(paymentFromRow);
      },

      listDue: async (at): Promise<Payment[]> => {
        const validatedAt = z.string().datetime({ offset: true }).parse(at);
        const { data, error } = await client
          .from("payments")
          .select("*")
          .eq("status", "held")
          .lte("release_at", validatedAt)
          .order("release_at", { ascending: true });
        if (error) {
          throw databaseError(error);
        }
        return data.map(paymentFromRow);
      },

      getBudgetState: async (
        mandateId,
        excludingPaymentId,
      ): Promise<BudgetState> => {
        const query = budgetHistoryQuerySchema.parse({
          mandate_id: mandateId,
          excluding_payment_id: excludingPaymentId,
        });
        const { data: mandate, error: mandateError } = await client
          .from("mandates")
          .select("spent_total,reserved_total")
          .eq("id", query.mandate_id)
          .maybeSingle();
        if (mandateError) {
          throw databaseError(mandateError);
        }
        if (!mandate) {
          throw new PersistenceError(
            "MANDATE_NOT_FOUND",
            persistenceMessage("MANDATE_NOT_FOUND"),
          );
        }

        const mandatePaymentsQuery = client
          .from("payments")
          .select("invoice_id")
          .eq("mandate_id", query.mandate_id)
          .neq("status", "rejected");
        const paymentsWithOrdersQuery = client
          .from("payments")
          .select("paypal_order_id")
          .not("paypal_order_id", "is", null);
        const paymentsWithAuthorizationsQuery = client
          .from("payments")
          .select("authorization_id")
          .not("authorization_id", "is", null);
        const [
          { data: mandatePayments, error: mandatePaymentError },
          { data: paymentsWithOrders, error: orderPaymentError },
          { data: paymentsWithAuthorizations, error: authorizationPaymentError },
          { data: excludedPayment, error: excludedPaymentError },
        ] = await Promise.all([
          query.excluding_payment_id
            ? mandatePaymentsQuery.neq("id", query.excluding_payment_id)
            : mandatePaymentsQuery,
          query.excluding_payment_id
            ? paymentsWithOrdersQuery.neq("id", query.excluding_payment_id)
            : paymentsWithOrdersQuery,
          query.excluding_payment_id
            ? paymentsWithAuthorizationsQuery.neq(
                "id",
                query.excluding_payment_id,
              )
            : paymentsWithAuthorizationsQuery,
          query.excluding_payment_id
            ? client
                .from("payments")
                .select("amount,status,mandate_id")
                .eq("id", query.excluding_payment_id)
                .maybeSingle()
            : Promise.resolve({ data: null, error: null }),
        ]);
        if (mandatePaymentError) {
          throw databaseError(mandatePaymentError);
        }
        if (orderPaymentError) {
          throw databaseError(orderPaymentError);
        }
        if (authorizationPaymentError) {
          throw databaseError(authorizationPaymentError);
        }
        if (excludedPaymentError) {
          throw databaseError(excludedPaymentError);
        }
        if (query.excluding_payment_id && !excludedPayment) {
          throw new PersistenceError(
            "INVALID_RECORD",
            "The excluded payment does not exist.",
          );
        }
        if (
          excludedPayment &&
          excludedPayment.mandate_id !== query.mandate_id
        ) {
          throw new PersistenceError(
            "INVALID_RECORD",
            "The excluded payment belongs to a different mandate.",
          );
        }
        const excludedReservation =
          excludedPayment &&
          ["requested", "authorized", "held"].includes(excludedPayment.status)
            ? excludedPayment.amount
            : 0;

        return budgetStateSchema.parse({
          spent_total: mandate.spent_total,
          reserved_total: mandate.reserved_total - excludedReservation,
          used_invoice_ids: mandatePayments.map((payment) => payment.invoice_id),
          processed_order_ids: paymentsWithOrders.flatMap((payment) =>
            payment.paypal_order_id === null ? [] : [payment.paypal_order_id],
          ),
          processed_authorization_ids: paymentsWithAuthorizations.flatMap(
            (payment) =>
              payment.authorization_id === null
                ? []
                : [payment.authorization_id],
          ),
        });
      },
    },

    decisions: {
      append: async (
        paymentId: string,
        decision: Decision,
        createdAt: string,
        phase?: DecisionPhase,
      ): Promise<void> => {
        const validatedPaymentId = repositoryIdSchema.parse(paymentId);
        const validated = decisionSchema.parse({
          ...decision,
          phase: phase ?? decision.phase,
        });
        const rows = validated.results.map((result) => ({
          payment_id: validatedPaymentId,
          phase: validated.phase,
          ...result,
          created_at: createdAt,
        }));
        const { error } = await client.from("decisions").insert(rows);
        if (error) {
          throw databaseError(error);
        }
      },

      listByPayment: async (paymentId): Promise<DecisionRecord[]> => {
        const validatedPaymentId = repositoryIdSchema.parse(paymentId);
        const { data, error } = await client
          .from("decisions")
          .select("*")
          .eq("payment_id", validatedPaymentId)
          .order("id", { ascending: true });
        if (error) {
          throw databaseError(error);
        }
        return data.map(decisionFromRow);
      },
    },

    events: {
      append: async (event: AppendPaymentEvent): Promise<PaymentEvent> => {
        const validated = appendPaymentEventSchema.parse(event);
        const { data, error } = await client
          .from("events")
          .insert(validated)
          .select("*")
          .single();
        if (error) {
          throw databaseError(error);
        }
        return eventFromRow(requireData(data, "event append"));
      },

      listByPayment: async (paymentId): Promise<PaymentEvent[]> => {
        const validatedPaymentId = repositoryIdSchema.parse(paymentId);
        const { data, error } = await client
          .from("events")
          .select("*")
          .eq("payment_id", validatedPaymentId)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true });
        if (error) {
          throw databaseError(error);
        }
        return data.map(eventFromRow);
      },
    },
  };
}
