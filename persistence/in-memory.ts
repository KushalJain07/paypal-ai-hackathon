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
import { transitionPaymentStatus } from "../domain/state-machine.ts";
import {
  appendPaymentEventSchema,
  decisionRecordSchema,
  paymentEventSchema,
  persistedMandateSchema,
  repositoryIdSchema,
  reservePaymentInputSchema,
  type AppendPaymentEvent,
  type DecisionRecord,
  type PaymentEvent,
  type ReservePaymentInput,
} from "./schemas.ts";
import {
  PersistenceError,
  type PaymentAction,
  type PaymentTransitionInput,
  type PersistenceRepositories,
} from "./repositories.ts";

export class InMemoryPersistence implements PersistenceRepositories {
  private readonly mandateRows = new Map<string, Mandate>();
  private readonly paymentRows = new Map<string, Payment>();
  private readonly decisionRows: DecisionRecord[] = [];
  private readonly eventRows: PaymentEvent[] = [];
  private readonly actionClaims = new Map<
    string,
    { action: PaymentAction; claimedAt: string }
  >();
  private nextDecisionId = 1;
  private nextEventId = 1;

  readonly mandates = {
    create: async (mandate: Mandate): Promise<Mandate> => {
      const validated = persistedMandateSchema.parse(mandate);
      if (this.mandateRows.has(validated.id)) {
        throw new PersistenceError(
          "DUPLICATE_MANDATE",
          "A mandate with this ID already exists.",
        );
      }

      this.mandateRows.set(validated.id, structuredClone(validated));
      return mandateSchema.parse(structuredClone(validated));
    },

    update: async (mandate: Mandate): Promise<Mandate> => {
      const validated = persistedMandateSchema.parse(mandate);
      if (!this.mandateRows.has(validated.id)) {
        throw new PersistenceError(
          "MANDATE_NOT_FOUND",
          "The requested mandate does not exist.",
        );
      }
      const current = this.mandateRows.get(validated.id);
      if (!current) {
        throw new PersistenceError(
          "MANDATE_NOT_FOUND",
          "The requested mandate does not exist.",
        );
      }
      const updated = mandateSchema.parse({
        ...validated,
        spent_total: current.spent_total,
        reserved_total: current.reserved_total,
      });
      this.mandateRows.set(validated.id, structuredClone(updated));
      return mandateSchema.parse(structuredClone(updated));
    },

    getById: async (id: string): Promise<Mandate | null> => {
      const mandate = this.mandateRows.get(repositoryIdSchema.parse(id));
      return mandate ? mandateSchema.parse(structuredClone(mandate)) : null;
    },

    list: async (): Promise<Mandate[]> =>
      [...this.mandateRows.values()]
        .sort((left, right) => left.created_at.localeCompare(right.created_at))
        .map((mandate) => mandateSchema.parse(structuredClone(mandate))),
  };

  readonly payments = {
    reserve: async (input: ReservePaymentInput): Promise<Payment> =>
      this.reservePayment(input),

    createRejected: async (
      input: ReservePaymentInput,
      reason: string,
      decision: Decision,
      createdAt: string,
    ): Promise<Payment> =>
      this.createRejectedPayment(input, reason, decision, createdAt),

    attachOrder: async (
      paymentId: string,
      orderId: string,
      approvalUrl: string,
      at: string,
    ): Promise<Payment> =>
      this.attachOrderId(paymentId, orderId, approvalUrl, at),

    transition: async (input: PaymentTransitionInput): Promise<Payment> =>
      this.transitionPayment(input),

    claimAction: async (
      paymentId: string,
      expectedStatus: Payment["status"],
      action: PaymentAction,
      at: string,
      dueAt?: string,
      staleAfterSeconds?: number,
    ): Promise<boolean> => this.claimPaymentAction(
      paymentId,
      expectedStatus,
      action,
      at,
      dueAt,
      staleAfterSeconds,
    ),

    clearActionClaim: async (
      paymentId: string,
      action: PaymentAction,
    ): Promise<void> => {
      if (
        this.actionClaims.get(repositoryIdSchema.parse(paymentId))?.action ===
        action
      ) {
        this.actionClaims.delete(paymentId);
      }
    },

    listStaleReleaseClaims: async (
      before: string,
    ): Promise<Array<{ payment: Payment; claimedAt: string }>> => {
      const cutoff = Date.parse(before);
      if (!Number.isFinite(cutoff)) {
        throw new PersistenceError("INVALID_RECORD", "Claim cutoff is invalid.");
      }
      return [...this.actionClaims.entries()]
        .flatMap(([paymentId, claim]) => {
          const payment = this.paymentRows.get(paymentId);
          if (
            claim.action !== "release" ||
            Date.parse(claim.claimedAt) >= cutoff ||
            !payment ||
            payment.status !== "held"
          ) {
            return [];
          }
          return [{
            payment: paymentSchema.parse(structuredClone(payment)),
            claimedAt: claim.claimedAt,
          }];
        })
        .sort((left, right) => left.claimedAt.localeCompare(right.claimedAt));
    },

    getById: async (id: string): Promise<Payment | null> => {
      const payment = this.paymentRows.get(repositoryIdSchema.parse(id));
      return payment ? paymentSchema.parse(structuredClone(payment)) : null;
    },

    listAll: async (): Promise<Payment[]> =>
      [...this.paymentRows.values()]
        .sort((left, right) => left.created_at.localeCompare(right.created_at))
        .map((payment) => paymentSchema.parse(structuredClone(payment))),

    listByMandate: async (mandateId: string): Promise<Payment[]> =>
      [...this.paymentRows.values()]
        .filter(
          (payment) =>
            payment.mandate_id === repositoryIdSchema.parse(mandateId),
        )
        .sort((left, right) => left.created_at.localeCompare(right.created_at))
        .map((payment) => paymentSchema.parse(structuredClone(payment))),

    listDue: async (at: string): Promise<Payment[]> => {
      const date = Date.parse(at);
      return [...this.paymentRows.values()]
        .filter(
          (payment) =>
            payment.status === "held" &&
            payment.release_at !== null &&
            Date.parse(payment.release_at) <= date,
        )
        .sort((left, right) =>
          (left.release_at ?? "").localeCompare(right.release_at ?? ""),
        )
        .map((payment) => paymentSchema.parse(structuredClone(payment)));
    },

    getBudgetState: async (
      mandateId: string,
      excludingPaymentId?: string,
    ): Promise<BudgetState> => {
      const validatedMandateId = repositoryIdSchema.parse(mandateId);
      const mandate = this.mandateRows.get(validatedMandateId);
      if (!mandate) {
        throw new PersistenceError(
          "MANDATE_NOT_FOUND",
          "The requested mandate does not exist.",
        );
      }

      const payments = [...this.paymentRows.values()].filter(
        (payment) =>
          payment.status !== "rejected" &&
          payment.mandate_id === validatedMandateId &&
          payment.id !==
          (excludingPaymentId
            ? repositoryIdSchema.parse(excludingPaymentId)
            : undefined),
      );
      const excludedPayment = excludingPaymentId
        ? this.paymentRows.get(repositoryIdSchema.parse(excludingPaymentId))
        : undefined;
      if (excludingPaymentId && !excludedPayment) {
        throw new PersistenceError(
          "INVALID_RECORD",
          "The excluded payment does not exist.",
        );
      }
      if (
        excludedPayment &&
        excludedPayment.mandate_id !== validatedMandateId
      ) {
        throw new PersistenceError(
          "INVALID_RECORD",
          "The excluded payment belongs to a different mandate.",
        );
      }
      const reservedPaymentStatuses = new Set([
        "requested",
        "authorized",
        "held",
      ]);
      const excludedReservedAmount =
        excludedPayment &&
        reservedPaymentStatuses.has(excludedPayment.status)
          ? excludedPayment.amount
          : 0;
      return budgetStateSchema.parse({
        spent_total: mandate.spent_total,
        reserved_total: mandate.reserved_total - excludedReservedAmount,
        used_invoice_ids: payments
          .flatMap((payment) =>
            payment.invoice_id === null ? [] : [payment.invoice_id],
          ),
        processed_order_ids: payments.flatMap((payment) =>
          payment.paypal_order_id === null ? [] : [payment.paypal_order_id],
        ),
        processed_authorization_ids: payments.flatMap((payment) =>
          payment.authorization_id === null
            ? []
            : [payment.authorization_id],
        ),
      });
    },
  };

  readonly decisions = {
    append: async (
      paymentId: string,
      decision: Decision,
      createdAt: string,
      phase?: DecisionPhase,
    ): Promise<void> => {
      const validatedPaymentId = repositoryIdSchema.parse(paymentId);
      this.requirePayment(validatedPaymentId);
      const validated = decisionSchema.parse(decision);
      for (const result of validated.results) {
        const row = decisionRecordSchema.parse({
          id: this.nextDecisionId,
          payment_id: validatedPaymentId,
          phase: phase ?? validated.phase,
          ...result,
          created_at: createdAt,
        });
        this.decisionRows.push(row);
        this.nextDecisionId += 1;
      }
    },

    listByPayment: async (paymentId: string): Promise<DecisionRecord[]> =>
      this.decisionRows
        .filter(
          (decision) =>
            decision.payment_id === repositoryIdSchema.parse(paymentId),
        )
        .map((decision) => decisionRecordSchema.parse(structuredClone(decision))),
  };

  readonly events = {
    append: async (event: AppendPaymentEvent): Promise<PaymentEvent> => {
      const validated = appendPaymentEventSchema.parse(event);
      this.requirePayment(validated.payment_id);
      const row = paymentEventSchema.parse({
        ...validated,
        id: this.nextEventId,
      });
      this.eventRows.push(row);
      this.nextEventId += 1;
      return paymentEventSchema.parse(structuredClone(row));
    },

    listByPayment: async (paymentId: string): Promise<PaymentEvent[]> =>
      this.eventRows
        .filter(
          (event) => event.payment_id === repositoryIdSchema.parse(paymentId),
        )
        .map((event) => paymentEventSchema.parse(structuredClone(event))),
  };

  private reservePayment(input: ReservePaymentInput): Payment {
    const request = reservePaymentInputSchema.parse(input);
    const mandate = this.mandateRows.get(request.mandate_id);
    if (!mandate) {
      throw new PersistenceError(
        "MANDATE_NOT_FOUND",
        "The requested mandate does not exist.",
      );
    }

    if (mandate.status !== "active") {
      throw new PersistenceError(
        "MANDATE_INACTIVE",
        "The mandate is not active.",
      );
    }
    if (Date.parse(mandate.expires_at) <= Date.parse(request.created_at)) {
      throw new PersistenceError(
        "MANDATE_EXPIRED",
        "The mandate has expired.",
      );
    }
    if (request.currency !== mandate.currency) {
      throw new PersistenceError(
        "CURRENCY_MISMATCH",
        "The payment currency does not match the mandate.",
      );
    }
    if (request.amount > mandate.per_payment_cap) {
      throw new PersistenceError(
        "PAYMENT_AMOUNT_INVALID",
        "The payment amount exceeds the mandate's per-payment cap.",
      );
    }
    if (
      [...this.paymentRows.values()].some(
        (payment) =>
          payment.mandate_id === request.mandate_id &&
          payment.invoice_id === request.invoice_id &&
          payment.status !== "rejected",
      )
    ) {
      throw new PersistenceError(
        "DUPLICATE_INVOICE",
        "This invoice has already been used under the mandate.",
      );
    }

    const availableBudget =
      mandate.total_cap - mandate.spent_total - mandate.reserved_total;
    if (request.amount > availableBudget) {
      throw new PersistenceError(
        "BUDGET_EXCEEDED",
        "The requested payment exceeds the mandate's available budget.",
      );
    }
    if (this.paymentRows.has(request.id)) {
      throw new PersistenceError(
        "DUPLICATE_PAYMENT",
        "A payment with this ID already exists.",
      );
    }

    const payment = paymentSchema.parse({
      id: request.id,
      mandate_id: request.mandate_id,
      invoice_id: request.invoice_id,
      amount: request.amount,
      currency: request.currency,
      payee_email: request.payee_email,
      approval_url: null,
      paypal_order_id: null,
      authorization_id: null,
      capture_id: null,
      status: "requested",
      release_at: null,
      failure_reason: null,
      created_at: request.created_at,
      updated_at: request.created_at,
    });

    const updatedMandate = mandateSchema.parse({
      ...mandate,
      reserved_total: mandate.reserved_total + request.amount,
    });
    const event = appendPaymentEventSchema.parse({
      payment_id: payment.id,
      type: "payment_requested",
      from_status: null,
      to_status: "requested",
      detail: {
        invoice_id: request.invoice_id,
        amount: request.amount,
      },
      created_at: request.created_at,
    });
    const storedEvent = paymentEventSchema.parse({
      ...event,
      id: this.nextEventId,
    });

    this.mandateRows.set(updatedMandate.id, updatedMandate);
    this.paymentRows.set(payment.id, payment);
    this.eventRows.push(storedEvent);
    this.nextEventId += 1;

    return paymentSchema.parse(structuredClone(payment));
  }

  private createRejectedPayment(
    input: ReservePaymentInput,
    reason: string,
    decision: Decision,
    createdAt: string,
  ): Payment {
    const request = reservePaymentInputSchema.parse(input);
    const validatedDecision = decisionSchema.parse(decision);
    const validatedReason = z.string().min(1).max(128).parse(reason);
    const validatedAt = z.string().datetime({ offset: true }).parse(createdAt);
    if (this.paymentRows.has(request.id)) {
      throw new PersistenceError(
        "DUPLICATE_PAYMENT",
        "A payment with this ID already exists.",
      );
    }
    const payment = paymentSchema.parse({
      id: request.id,
      mandate_id: request.mandate_id,
      invoice_id: request.invoice_id,
      amount: request.amount,
      currency: request.currency,
      payee_email: request.payee_email,
      approval_url: null,
      paypal_order_id: null,
      authorization_id: null,
      capture_id: null,
      status: "rejected",
      release_at: null,
      failure_reason: validatedReason,
      created_at: validatedAt,
      updated_at: validatedAt,
    });
    const event = appendPaymentEventSchema.parse({
      payment_id: payment.id,
      type: "payment_rejected",
      from_status: null,
      to_status: "rejected",
      detail: {
        failed_rules: validatedDecision.results
          .filter((result) => !result.passed)
          .map((result) => result.rule)
          .join(","),
        reason: validatedReason,
        phase: validatedDecision.phase,
      },
      created_at: validatedAt,
    });
    const decisionRecords = validatedDecision.results.map((result) =>
      decisionRecordSchema.parse({
        id: this.nextDecisionId,
        payment_id: payment.id,
        phase: validatedDecision.phase,
        ...result,
        created_at: validatedAt,
      }),
    );
    this.paymentRows.set(payment.id, payment);
    this.eventRows.push(
      paymentEventSchema.parse({ ...event, id: this.nextEventId }),
    );
    this.nextEventId += 1;
    this.decisionRows.push(...decisionRecords);
    this.nextDecisionId += decisionRecords.length;
    return paymentSchema.parse(structuredClone(payment));
  }

  private attachOrderId(
    paymentId: string,
    orderId: string,
    approvalUrl: string,
    at: string,
  ): Payment {
    const id = repositoryIdSchema.parse(paymentId);
    const current = this.requirePayment(id);
    if (current.status !== "requested") {
      throw new PersistenceError(
        "PAYMENT_STATUS_CONFLICT",
        "The payment is no longer awaiting order creation.",
      );
    }
    if (
      [...this.paymentRows.values()].some(
        (payment) => payment.id !== id && payment.paypal_order_id === orderId,
      )
    ) {
      throw new PersistenceError(
        "DUPLICATE_PAYMENT",
        "A PayPal order is already associated with another payment.",
      );
    }
    const updated = paymentSchema.parse({
      ...current,
      approval_url: z.string().url().parse(approvalUrl),
      paypal_order_id: orderId,
      updated_at: at,
    });
    this.paymentRows.set(id, updated);
    this.appendEvent({
      payment_id: id,
      type: "paypal_order_created",
      from_status: current.status,
      to_status: current.status,
      detail: { paypal_order_id: orderId },
      created_at: at,
    });
    return paymentSchema.parse(structuredClone(updated));
  }

  private transitionPayment(input: PaymentTransitionInput): Payment {
    const paymentId = repositoryIdSchema.parse(input.paymentId);
    const current = this.requirePayment(paymentId);
    if (current.status !== input.expectedStatus) {
      throw new PersistenceError(
        "PAYMENT_STATUS_CONFLICT",
        "The payment status changed before this operation completed.",
      );
    }
    if (
      input.claimAction &&
      this.actionClaims.get(paymentId)?.action !== input.claimAction
    ) {
      throw new PersistenceError(
        "ACTION_ALREADY_CLAIMED",
        "The payment action claim is missing or no longer active.",
      );
    }
    transitionPaymentStatus(current.status, input.nextStatus);
    const mandate = this.mandateRows.get(current.mandate_id);
    if (!mandate) {
      throw new PersistenceError(
        "MANDATE_NOT_FOUND",
        "The payment mandate does not exist.",
      );
    }

    let spentDelta = 0;
    let reservedDelta = 0;
    switch (input.budgetEffect) {
      case "release_reserved":
        reservedDelta = -current.amount;
        break;
      case "reserved_to_spent":
        reservedDelta = -current.amount;
        spentDelta = current.amount;
        break;
      case "restore_spent":
        spentDelta = -current.amount;
        break;
      case "none":
        break;
    }
    const updatedMandate = mandateSchema.parse({
      ...mandate,
      spent_total: mandate.spent_total + spentDelta,
      reserved_total: mandate.reserved_total + reservedDelta,
    });
    const updatedPayment = paymentSchema.parse({
      ...current,
      paypal_order_id: input.paypalOrderId ?? current.paypal_order_id,
      authorization_id: input.authorizationId ?? current.authorization_id,
      capture_id: input.captureId ?? current.capture_id,
      release_at:
        input.releaseAt === undefined ? current.release_at : input.releaseAt,
      failure_reason:
        input.failureReason === undefined
          ? current.failure_reason
          : input.failureReason,
      status: input.nextStatus,
      updated_at: input.at,
    });
    this.mandateRows.set(updatedMandate.id, updatedMandate);
    this.paymentRows.set(paymentId, updatedPayment);
    this.appendEvent({
      payment_id: paymentId,
      type: input.eventType,
      from_status: current.status,
      to_status: input.nextStatus,
      detail: input.detail,
      created_at: input.at,
    });
    if (input.claimAction) {
      this.actionClaims.delete(paymentId);
    }
    return paymentSchema.parse(structuredClone(updatedPayment));
  }

  private claimPaymentAction(
    paymentId: string,
    expectedStatus: Payment["status"],
    action: PaymentAction,
    at: string,
    dueAt?: string,
    staleAfterSeconds = 120,
  ): boolean {
    const id = repositoryIdSchema.parse(paymentId);
    const validatedStaleAfterSeconds = z.number().int().positive().max(86400)
      .parse(staleAfterSeconds);
    const payment = this.paymentRows.get(id);
    const existingClaim = this.actionClaims.get(id);
    const claimIsActive =
      existingClaim !== undefined &&
      Date.parse(existingClaim.claimedAt) >
        Date.parse(at) - validatedStaleAfterSeconds * 1000;
    if (!payment || payment.status !== expectedStatus || claimIsActive) {
      return false;
    }
    if (
      action === "release" &&
      (!payment.release_at ||
        !dueAt ||
        Date.parse(payment.release_at) > Date.parse(dueAt))
    ) {
      return false;
    }
    if (action === "undo" && expectedStatus !== "held") {
      return false;
    }
    if (action === "release" && expectedStatus !== "held") {
      return false;
    }
    if (action === "refund" && expectedStatus !== "captured") {
      return false;
    }
    if (!Number.isFinite(Date.parse(at))) {
      throw new PersistenceError("INVALID_RECORD", "Action time is invalid.");
    }
    this.actionClaims.set(id, { action, claimedAt: at });
    return true;
  }

  private appendEvent(event: AppendPaymentEvent): void {
    const validated = appendPaymentEventSchema.parse(event);
    this.eventRows.push(
      paymentEventSchema.parse({
        ...validated,
        id: this.nextEventId,
      }),
    );
    this.nextEventId += 1;
  }

  private requirePayment(paymentId: string): Payment {
    const payment = this.paymentRows.get(paymentId);
    if (!payment) {
      throw new PersistenceError(
        "INVALID_RECORD",
        "The payment does not exist.",
      );
    }
    return payment;
  }
}
