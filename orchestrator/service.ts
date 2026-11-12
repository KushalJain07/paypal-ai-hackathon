import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { evaluate } from "../domain/guardian.ts";
import {
  createMandateSchema,
  mandateSchema,
  type CreateMandate,
  type Mandate,
} from "../domain/mandate.ts";
import {
  observedPaymentSchema,
  paymentSchema,
  type ObservedPayment,
  type Payment,
  type PaymentStatus,
} from "../domain/payment.ts";
import { transitionPaymentStatus } from "../domain/state-machine.ts";
import type {
  Authorization,
  Capture,
} from "../paypal/payment-provider.ts";
import {
  reservePaymentInputSchema,
  type ReservePaymentInput,
} from "../persistence/schemas.ts";
import type {
  OrchestratorDependencies,
  PaymentDetail,
  PaymentRequestInput,
  PaymentRequestResult,
  ReleaseResult,
  StaleReleaseResult,
} from "./ports.ts";
import type {
  PaymentNotification,
} from "../notifications/notifier.ts";

const requestSchema = z
  .object({
    mandateId: z.string().uuid(),
    payeeEmail: z.string().trim().email(),
    amountCents: z.number().int().positive().safe(),
    invoiceId: z.string().trim().min(1).max(127),
  })
  .strict();

const mandateIdSchema = z.string().uuid();
const paymentIdSchema = z.string().uuid();
const errorCodeSchema = z.string().regex(/^[A-Z0-9_-]{1,128}$/);
const reservationRejectionCodes = [
  "DUPLICATE_INVOICE",
  "BUDGET_EXCEEDED",
  "MANDATE_INACTIVE",
  "MANDATE_EXPIRED",
  "PAYMENT_AMOUNT_INVALID",
  "CURRENCY_MISMATCH",
] as const;

export class OrchestratorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OrchestratorError";
    this.code = code;
  }
}

function canonicalMandate(mandate: Omit<Mandate, "signature" | "hash">): string {
  return JSON.stringify({
    id: mandate.id,
    version: mandate.version,
    payee_email: mandate.payee_email,
    per_payment_cap: mandate.per_payment_cap,
    total_cap: mandate.total_cap,
    currency: mandate.currency,
    purpose: mandate.purpose,
    expires_at: new Date(mandate.expires_at).toISOString(),
    undo_window_seconds: mandate.undo_window_seconds,
    status: mandate.status,
  });
}

function signatureFor(canonical: string, secret: string): {
  signature: string;
  hash: string;
} {
  return {
    signature: createHmac("sha256", secret).update(canonical).digest("hex"),
    hash: createHash("sha256").update(canonical).digest("hex"),
  };
}

function safeFailureCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const parsedCode = errorCodeSchema.safeParse(error.code);
    if (parsedCode.success) {
      return parsedCode.data;
    }
  }
  if (error instanceof Error) {
    const parsedName = errorCodeSchema.safeParse(error.name.toUpperCase());
    if (parsedName.success) {
      return parsedName.data;
    }
  }
  return "OPERATION_FAILED";
}

function isReservationRejection(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }
  const parsedCode = errorCodeSchema.safeParse(error.code);
  return parsedCode.success &&
    reservationRejectionCodes.includes(
      parsedCode.data as (typeof reservationRejectionCodes)[number],
    );
}

function assertValidNow(date: Date): string {
  if (!Number.isFinite(date.getTime())) {
    throw new OrchestratorError("INVALID_CLOCK", "The clock returned an invalid date.");
  }
  return date.toISOString();
}

function failedRules(decision: ReturnType<typeof evaluate>): string[] {
  return decision.results
    .filter((result) => !result.passed)
    .map((result) => result.rule);
}

function makeObservedFromRequest(
  input: z.infer<typeof requestSchema>,
): ObservedPayment {
  return observedPaymentSchema.parse({
    payee_email: input.payeeEmail,
    amount: input.amountCents,
    currency: "USD",
    invoice_id: input.invoiceId,
    paypal_order_id: null,
    authorization_id: null,
    status: "requested",
  });
}

function assertTransition(from: PaymentStatus, to: PaymentStatus): void {
  try {
    transitionPaymentStatus(from, to);
  } catch {
    throw new OrchestratorError(
      "INVALID_TRANSITION",
      `Payment cannot transition from ${from} to ${to}.`,
    );
  }
}

export class PaymentOrchestrator {
  private readonly signingSecret: string;
  private readonly dependencies: OrchestratorDependencies;

  constructor(dependencies: OrchestratorDependencies) {
    this.dependencies = dependencies;
    const secret =
      dependencies.signingSecret ?? process.env.MANDATE_SIGNING_SECRET ?? "";
    if (secret.length < 32) {
      throw new OrchestratorError(
        "SIGNING_SECRET_REQUIRED",
        "MANDATE_SIGNING_SECRET must contain at least 32 characters.",
      );
    }
    this.signingSecret = secret;
  }

  async createMandate(input: CreateMandate): Promise<Mandate> {
    const draft = createMandateSchema.parse(input);
    const at = assertValidNow(this.dependencies.clock.now());
    const unsigned = {
      id: this.dependencies.ids.next(),
      version: 1,
      ...draft,
      spent_total: 0,
      reserved_total: 0,
      status: "active" as const,
      created_at: at,
    };
    const signed = {
      ...unsigned,
      ...signatureFor(canonicalMandate(unsigned), this.signingSecret),
    };
    return this.dependencies.mandates.create(mandateSchema.parse(signed));
  }

  async revokeMandate(mandateId: string): Promise<Mandate> {
    const id = mandateIdSchema.parse(mandateId);
    const mandate = await this.requireMandate(id);
    if (mandate.status === "revoked") {
      return mandate;
    }
    const unsigned = {
      ...mandate,
      version: mandate.version + 1,
      status: "revoked" as const,
    };
    const signed = {
      ...unsigned,
      ...signatureFor(canonicalMandate(unsigned), this.signingSecret),
    };
    return this.dependencies.mandates.update(mandateSchema.parse(signed));
  }

  async requestPayment(
    rawInput: PaymentRequestInput,
  ): Promise<PaymentRequestResult> {
    const input = requestSchema.parse(rawInput);
    const paymentId = paymentIdSchema.parse(this.dependencies.ids.next());
    const at = assertValidNow(this.dependencies.clock.now());
    const mandate = await this.requireMandate(input.mandateId);
    const effectiveMandate = this.effectiveMandate(mandate, at);
    const budget = await this.dependencies.payments.getBudgetState(mandate.id);
    const observed = makeObservedFromRequest(input);
    const preflight = evaluate(
      effectiveMandate,
      budget,
      observed,
      new Date(at),
      "preflight",
    );
    const reserveInput = reservePaymentInputSchema.parse({
      id: paymentId,
      mandate_id: mandate.id,
      invoice_id: input.invoiceId,
      amount: input.amountCents,
      currency: mandate.currency,
      payee_email: input.payeeEmail,
      created_at: at,
    });

    if (!preflight.passed) {
      const payment = await this.persistRejection(
        reserveInput,
        preflight,
        "GUARDIAN_PREFLIGHT_REJECTED",
        at,
      );
      this.notify({ type: "rejected", payment, failedRules: failedRules(preflight) });
      return { payment, decision: preflight, approvalUrl: null };
    }

    let payment: Payment;
    try {
      payment = await this.dependencies.payments.reserve(reserveInput);
    } catch (error) {
      if (!isReservationRejection(error)) {
        throw error;
      }
      const latestMandate = await this.dependencies.mandates.getById(mandate.id);
      if (!latestMandate) {
        throw new OrchestratorError("MANDATE_NOT_FOUND", "Mandate not found.");
      }
      const latestBudget = await this.dependencies.payments.getBudgetState(mandate.id);
      const currentDecision = evaluate(
        this.effectiveMandate(latestMandate, at),
        latestBudget,
        observed,
        new Date(at),
        "preflight",
      );
      const payment = await this.persistRejection(
        reserveInput,
        currentDecision,
        safeFailureCode(error),
        at,
      );
      this.notify({
        type: "rejected",
        payment,
        failedRules: failedRules(currentDecision),
      });
      return { payment, decision: currentDecision, approvalUrl: null };
    }

    try {
      await this.dependencies.decisions.append(
        payment.id,
        preflight,
        at,
        "preflight",
      );
    } catch (error) {
      await this.failPayment(payment, "requested", error, "release_reserved");
      throw this.toOrchestratorError(error);
    }

    let order;
    try {
      order = await this.dependencies.paymentProvider.createOrder({
        paymentId,
        payeeEmail: input.payeeEmail,
        amountCents: input.amountCents,
        currency: mandate.currency,
        invoiceId: input.invoiceId,
      });
    } catch (error) {
      await this.failPayment(payment, "requested", error, "release_reserved");
      throw this.toOrchestratorError(error);
    }
    const attached = await this.dependencies.payments.attachOrder(
      payment.id,
      order.paypalOrderId,
      order.approvalUrl,
      assertValidNow(this.dependencies.clock.now()),
    ).catch(async (error: unknown) => {
      await this.failPayment(payment, "requested", error, "release_reserved");
      throw this.toOrchestratorError(error);
    });
    return {
      payment: attached,
      decision: preflight,
      approvalUrl: order.approvalUrl,
    };
  }

  async completeAuthorization(paymentId: string): Promise<Payment> {
    const payment = await this.requirePayment(paymentId);
    if (payment.status !== "requested") {
      throw new OrchestratorError(
        "PAYMENT_STATUS_CONFLICT",
        "Only a requested payment can be authorized.",
      );
    }
    if (!payment.paypal_order_id || !payment.approval_url) {
      throw new OrchestratorError(
        "ORDER_NOT_READY",
        "The payment does not have a persisted PayPal order and approval link.",
      );
    }
    const mandate = await this.requireMandate(payment.mandate_id);
    let authorization: Authorization;
    try {
      const approval = await this.dependencies.approvalProvider.approve({
        paymentId: payment.id,
        paypalOrderId: payment.paypal_order_id,
        approvalUrl: payment.approval_url,
      });
      if (
        approval.status !== "APPROVED" ||
        approval.paymentId !== payment.id ||
        approval.paypalOrderId !== payment.paypal_order_id
      ) {
        throw new OrchestratorError(
          "APPROVAL_NOT_VERIFIED",
          "The approval provider did not confirm this PayPal order.",
        );
      }
      authorization = await this.dependencies.paymentProvider.authorizeOrder(
        payment.id,
        payment.paypal_order_id,
      );
    } catch (error) {
      await this.failPayment(payment, "requested", error, "release_reserved");
      throw this.toOrchestratorError(error);
    }

    const authorized = await this.dependencies.payments.transition({
      paymentId: payment.id,
      expectedStatus: "requested",
      nextStatus: "authorized",
      at: assertValidNow(this.dependencies.clock.now()),
      budgetEffect: "none",
      eventType: "payment_authorized",
      detail: { authorization_id: authorization.authorizationId },
      authorizationId: authorization.authorizationId,
    });

    let orderSnapshot;
    let authorizationSnapshot: Authorization;
    try {
      [orderSnapshot, authorizationSnapshot] = await Promise.all([
        this.dependencies.paymentProvider.getOrder(
          payment.id,
          payment.paypal_order_id,
        ),
        this.dependencies.paymentProvider.getAuthorization(
          payment.id,
          authorization.authorizationId,
        ),
      ]);
    } catch (error) {
      await this.failPayment(authorized, "authorized", error, "release_reserved");
      throw this.toOrchestratorError(error);
    }

    const matchedAuthorization =
      orderSnapshot.paypalOrderId === payment.paypal_order_id &&
      authorizationSnapshot.authorizationId === authorization.authorizationId &&
      authorizationSnapshot.amountCents === payment.amount &&
      authorizationSnapshot.currency === payment.currency &&
      ["CREATED", "PENDING"].includes(authorizationSnapshot.status);
    const observed = observedPaymentSchema.parse({
      ...orderSnapshot.observedPayment,
      authorization_id: authorizationSnapshot.authorizationId,
      status:
        matchedAuthorization &&
        orderSnapshot.observedPayment.authorization_id ===
          authorizationSnapshot.authorizationId
          ? "authorized"
          : "failed",
    });
    const latestMandate = this.effectiveMandate(
      await this.requireMandate(mandate.id),
      assertValidNow(this.dependencies.clock.now()),
    );
    const budget = await this.dependencies.payments.getBudgetState(
      mandate.id,
      payment.id,
    );
    const authorizedDecision = evaluate(
      latestMandate,
      budget,
      observed,
      this.dependencies.clock.now(),
      "authorized",
    );
    await this.dependencies.decisions.append(
      payment.id,
      authorizedDecision,
      assertValidNow(this.dependencies.clock.now()),
      "authorized",
    );

    if (!authorizedDecision.passed) {
      try {
        const voided = await this.dependencies.paymentProvider.voidAuthorization(
          payment.id,
          authorizationSnapshot.authorizationId,
        );
        if (voided.status !== "VOIDED") {
          throw new OrchestratorError("VOID_NOT_VERIFIED", "Authorization void was not verified.");
        }
      } catch (error) {
        const failed = await this.failPayment(
          authorized,
          "authorized",
          error,
          "release_reserved",
        );
        return failed;
      }
      const rejected = await this.dependencies.payments.transition({
        paymentId: payment.id,
        expectedStatus: "authorized",
        nextStatus: "rejected",
        at: assertValidNow(this.dependencies.clock.now()),
        budgetEffect: "release_reserved",
        eventType: "payment_rejected",
        detail: { phase: "authorized", failed_rules: failedRules(authorizedDecision).join(",") },
        authorizationId: authorizationSnapshot.authorizationId,
        failureReason: "GUARDIAN_AUTHORIZED_REJECTED",
      });
      this.notify({
        type: "rejected",
        payment: rejected,
        failedRules: failedRules(authorizedDecision),
      });
      return rejected;
    }

    const releaseAt = new Date(
      this.dependencies.clock.now().getTime() +
        mandate.undo_window_seconds * 1000,
    ).toISOString();
    assertTransition("authorized", "held");
    const held = await this.dependencies.payments.transition({
      paymentId: payment.id,
      expectedStatus: "authorized",
      nextStatus: "held",
      at: assertValidNow(this.dependencies.clock.now()),
      budgetEffect: "none",
      eventType: "payment_held",
      detail: { release_at: releaseAt },
      authorizationId: authorizationSnapshot.authorizationId,
      releaseAt,
    });
    this.notify({ type: "held", payment: held });
    return held;
  }

  async undo(paymentId: string): Promise<Payment> {
    const payment = await this.requirePayment(paymentId);
    if (payment.status !== "held") {
      throw new OrchestratorError(
        "PAYMENT_STATUS_CONFLICT",
        "Only a held payment can be undone.",
      );
    }
    if (!payment.authorization_id) {
      throw new OrchestratorError(
        "AUTHORIZATION_MISSING",
        "The held payment has no PayPal authorization.",
      );
    }
    const at = assertValidNow(this.dependencies.clock.now());
    const claimed = await this.dependencies.payments.claimAction(
      payment.id,
      "held",
      "undo",
      at,
    );
    if (!claimed) {
      throw new OrchestratorError(
        "ACTION_ALREADY_CLAIMED",
        "The payment is already being released or undone.",
      );
    }
    let authorization: Authorization;
    try {
      authorization = await this.dependencies.paymentProvider.voidAuthorization(
        payment.id,
        payment.authorization_id,
      );
      if (authorization.status !== "VOIDED") {
        throw new OrchestratorError(
          "VOID_NOT_VERIFIED",
          "PayPal did not confirm the authorization was voided.",
        );
      }
    } catch (error) {
      await this.failPayment(payment, "held", error, "release_reserved", "undo");
      throw this.toOrchestratorError(error);
    }
    try {
      const voided = await this.dependencies.payments.transition({
        paymentId: payment.id,
        expectedStatus: "held",
        nextStatus: "voided",
        at: assertValidNow(this.dependencies.clock.now()),
        budgetEffect: "release_reserved",
        eventType: "payment_undone",
        detail: { authorization_id: authorization.authorizationId },
        authorizationId: authorization.authorizationId,
        claimAction: "undo",
      });
      this.notify({ type: "voided", payment: voided });
      return voided;
    } catch (error) {
      await this.dependencies.payments.clearActionClaim(payment.id, "undo");
      throw this.toOrchestratorError(error);
    }
  }

  async releaseDue(
    now: Date,
    staleAfterSeconds = 120,
  ): Promise<ReleaseResult[]> {
    const at = assertValidNow(now);
    const staleSeconds = z.number().int().positive().max(86400)
      .parse(staleAfterSeconds);
    const duePayments = await this.dependencies.payments.listDue(at);
    const results: ReleaseResult[] = [];
    for (const payment of duePayments) {
      if (payment.status !== "held" || !payment.authorization_id) {
        results.push({ paymentId: payment.id, status: "skipped" });
        continue;
      }
      let claimed = false;
      let captureReturned = false;
      try {
        claimed = await this.dependencies.payments.claimAction(
          payment.id,
          "held",
          "release",
          assertValidNow(this.dependencies.clock.now()),
          at,
          staleSeconds,
        );
        if (!claimed) {
          results.push({ paymentId: payment.id, status: "skipped" });
          continue;
        }
        const capture = await this.dependencies.paymentProvider.captureAuthorization(
          payment.id,
          payment.authorization_id,
        );
        captureReturned = true;
        if (capture.status === "PENDING") {
          await this.dependencies.payments.clearActionClaim(
            payment.id,
            "release",
          );
          results.push({
            paymentId: payment.id,
            status: "skipped",
            error: "CAPTURE_PENDING",
          });
          continue;
        }
        this.assertFullCapture(capture, payment);
        const capturedPayment = await this.dependencies.payments.transition({
          paymentId: payment.id,
          expectedStatus: "held",
          nextStatus: "captured",
          at: assertValidNow(this.dependencies.clock.now()),
          budgetEffect: "reserved_to_spent",
          eventType: "payment_captured",
          detail: { capture_id: capture.captureId },
          captureId: capture.captureId,
          claimAction: "release",
        });
        this.notify({ type: "captured", payment: capturedPayment });
        results.push({ paymentId: payment.id, status: "captured" });
      } catch (error) {
        const current = await this.dependencies.payments.getById(payment.id);
        let finalError = this.safeErrorCode(error);
        const captureOutcomeUncertain =
          finalError === "CAPTURE_RECOVERY_PENDING";
        if (captureReturned || captureOutcomeUncertain) {
          if (claimed) {
            await this.dependencies.payments.clearActionClaim(
              payment.id,
              "release",
            );
          }
        } else if (current?.status === "held" && claimed) {
          try {
            await this.failPayment(current, "held", error, "release_reserved", "release");
          } catch (finalizeError) {
            finalError = this.safeErrorCode(finalizeError);
          }
        }
        results.push({
          paymentId: payment.id,
          status:
            current?.status === "held" &&
              claimed &&
              !captureReturned &&
              !captureOutcomeUncertain
              ? "failed"
              : "skipped",
          error: finalError,
        });
      }
    }
    return results;
  }

  async recoverStaleReleases(
    now: Date,
    staleAfterSeconds = 120,
  ): Promise<StaleReleaseResult[]> {
    const at = assertValidNow(now);
    const staleSeconds = z.number().int().positive().max(86400)
      .parse(staleAfterSeconds);
    const cutoff = new Date(now.getTime() - staleSeconds * 1000).toISOString();
    const staleClaims = await this.dependencies.payments.listStaleReleaseClaims(cutoff);
    const results: StaleReleaseResult[] = [];

    for (const { payment } of staleClaims) {
      if (
        payment.status !== "held" ||
        !payment.paypal_order_id ||
        !payment.authorization_id
      ) {
        results.push({ paymentId: payment.id, status: "skipped" });
        continue;
      }

      let claimed: boolean;
      try {
        claimed = await this.dependencies.payments.claimAction(
          payment.id,
          "held",
          "release",
          at,
          at,
          staleSeconds,
        );
      } catch (error) {
        results.push({
          paymentId: payment.id,
          status: "skipped",
          error: this.safeErrorCode(error),
        });
        continue;
      }
      if (!claimed) {
        results.push({ paymentId: payment.id, status: "skipped" });
        continue;
      }

      try {
        const authorization = await this.dependencies.paymentProvider.getAuthorization(
          payment.id,
          payment.authorization_id,
        );
        const findCapture = this.dependencies.paymentProvider
          .findCaptureForAuthorization;
        if (!findCapture) {
          throw new OrchestratorError(
            "CAPTURE_RECOVERY_UNAVAILABLE",
            "PayPal capture recovery is unavailable.",
          );
        }
        const capture = await findCapture.call(
          this.dependencies.paymentProvider,
          payment.id,
          payment.paypal_order_id,
          payment.authorization_id,
        );
        if (capture?.status === "COMPLETED") {
          this.assertFullCapture(capture, payment);
          const capturedPayment = await this.dependencies.payments.transition({
            paymentId: payment.id,
            expectedStatus: "held",
            nextStatus: "captured",
            at,
            budgetEffect: "reserved_to_spent",
            eventType: "payment_captured",
            detail: { capture_id: capture.captureId, recovered: true },
            captureId: capture.captureId,
            claimAction: "release",
          });
          this.notify({ type: "captured", payment: capturedPayment });
          results.push({ paymentId: payment.id, status: "captured" });
          continue;
        }
        if (capture?.status === "PENDING") {
          await this.dependencies.payments.clearActionClaim(payment.id, "release");
          results.push({
            paymentId: payment.id,
            status: "held",
            error: "CAPTURE_PENDING",
          });
          continue;
        }

        if (
          authorization.status === "VOIDED" ||
          authorization.status === "DENIED" ||
          authorization.status === "EXPIRED"
        ) {
          await this.failPayment(
            payment,
            "held",
            new OrchestratorError(
              `AUTHORIZATION_${authorization.status}`,
              "PayPal authorization is no longer capturable.",
            ),
            "release_reserved",
            "release",
          );
          results.push({ paymentId: payment.id, status: "failed" });
          continue;
        }
        if (
          authorization.status === "CAPTURED" ||
          authorization.status === "PARTIALLY_CAPTURED"
        ) {
          // Keep the refreshed claim so releaseDue cannot issue a new capture
          // while PayPal's order readback is still incomplete.
          results.push({
            paymentId: payment.id,
            status: "held",
            error: "CAPTURE_RECOVERY_PENDING",
          });
          continue;
        }

        await this.dependencies.payments.clearActionClaim(payment.id, "release");
        results.push({ paymentId: payment.id, status: "held" });
      } catch (error) {
        // Retain the refreshed claim: inconclusive PayPal reads must not permit
        // releaseDue to submit another capture attempt.
        results.push({
          paymentId: payment.id,
          status: "held",
          error: this.safeErrorCode(error),
        });
      }
    }
    return results;
  }

  async refund(paymentId: string): Promise<Payment> {
    const payment = await this.requirePayment(paymentId);
    if (payment.status !== "captured") {
      throw new OrchestratorError(
        "PAYMENT_STATUS_CONFLICT",
        "Only a captured payment can be refunded.",
      );
    }
    if (!payment.capture_id) {
      throw new OrchestratorError(
        "CAPTURE_MISSING",
        "The captured payment has no PayPal capture.",
      );
    }
    const at = assertValidNow(this.dependencies.clock.now());
    const claimed = await this.dependencies.payments.claimAction(
      payment.id,
      "captured",
      "refund",
      at,
    );
    if (!claimed) {
      throw new OrchestratorError(
        "ACTION_ALREADY_CLAIMED",
        "A refund is already in progress.",
      );
    }
    try {
      const refund = await this.dependencies.paymentProvider.refundCapture(
        payment.id,
        payment.capture_id,
      );
      if (refund.status !== "COMPLETED") {
        throw new OrchestratorError(
          "REFUND_NOT_COMPLETED",
          "PayPal has not confirmed the full refund.",
        );
      }
      const refunded = await this.dependencies.payments.transition({
        paymentId: payment.id,
        expectedStatus: "captured",
        nextStatus: "refunded",
        at: assertValidNow(this.dependencies.clock.now()),
        budgetEffect: "restore_spent",
        eventType: "payment_refunded",
        detail: { refund_id: refund.refundId },
        claimAction: "refund",
      });
      this.notify({ type: "refunded", payment: refunded });
      return refunded;
    } catch (error) {
      await this.dependencies.payments.clearActionClaim(payment.id, "refund");
      throw this.toOrchestratorError(error);
    }
  }

  async listPayments(): Promise<Payment[]> {
    return this.dependencies.payments.listAll();
  }

  async getPaymentDetail(paymentId: string): Promise<PaymentDetail> {
    const payment = await this.requirePayment(paymentId);
    const [decisions, events] = await Promise.all([
      this.dependencies.decisions.listByPayment(payment.id),
      this.dependencies.events.listByPayment(payment.id),
    ]);
    return { payment, decisions, events };
  }

  async listMandates(): Promise<Mandate[]> {
    const mandates = await this.dependencies.mandates.list();
    if (
      mandates.some(
        (mandate) => !verifyMandateSignature(mandate, this.signingSecret),
      )
    ) {
      throw new OrchestratorError(
        "MANDATE_SIGNATURE_INVALID",
        "A stored mandate signature is invalid.",
      );
    }
    return mandates;
  }

  private async persistRejection(
    input: ReservePaymentInput,
    decision: ReturnType<typeof evaluate>,
    reason: string,
    at: string,
  ): Promise<Payment> {
    const payment = await this.dependencies.payments.createRejected(
      input,
      reason,
      decision,
      at,
    );
    return payment;
  }

  private effectiveMandate(mandate: Mandate, at: string): Mandate {
    if (
      mandate.status === "active" &&
      Date.parse(mandate.expires_at) <= Date.parse(at)
    ) {
      return mandateSchema.parse({ ...mandate, status: "expired" });
    }
    return mandate;
  }

  private async requirePayment(paymentId: string): Promise<Payment> {
    const id = paymentIdSchema.parse(paymentId);
    const payment = await this.dependencies.payments.getById(id);
    if (!payment) {
      throw new OrchestratorError("PAYMENT_NOT_FOUND", "Payment not found.");
    }
    return paymentSchema.parse(payment);
  }

  private async requireMandate(mandateId: string): Promise<Mandate> {
    const mandate = await this.dependencies.mandates.getById(mandateId);
    if (!mandate) {
      throw new OrchestratorError("MANDATE_NOT_FOUND", "Mandate not found.");
    }
    if (!verifyMandateSignature(mandate, this.signingSecret)) {
      throw new OrchestratorError(
        "MANDATE_SIGNATURE_INVALID",
        "The stored mandate signature is invalid.",
      );
    }
    return mandate;
  }

  private assertFullCapture(capture: Capture, payment: Payment): void {
    if (
      capture.status !== "COMPLETED" ||
      capture.amountCents !== payment.amount ||
      capture.currency !== payment.currency
    ) {
      throw new OrchestratorError(
        "CAPTURE_NOT_COMPLETED",
        "PayPal has not confirmed the full capture.",
      );
    }
  }

  private async failPayment(
    payment: Payment,
    expectedStatus: PaymentStatus,
    error: unknown,
    budgetEffect: "release_reserved",
    claimAction?: "undo" | "release",
  ): Promise<Payment> {
    const code = this.safeErrorCode(error);
    assertTransition(expectedStatus, "failed");
    return this.dependencies.payments.transition({
      paymentId: payment.id,
      expectedStatus,
      nextStatus: "failed",
      at: assertValidNow(this.dependencies.clock.now()),
      budgetEffect,
      eventType: "payment_failed",
      detail: { error_code: code },
      failureReason: code,
      claimAction,
    });
  }

  private safeErrorCode(error: unknown): string {
    return error instanceof OrchestratorError
      ? error.code
      : safeFailureCode(error);
  }

  private notify(notification: PaymentNotification): void {
    if (!this.dependencies.notifier) {
      return;
    }
    void this.dependencies.notifier.notify(notification).catch(() => {
      console.error("REWIND_NOTIFIER_ERROR", {
        code: "DELIVERY_FAILED",
        type: notification.type,
      });
    });
  }

  private toOrchestratorError(error: unknown): OrchestratorError {
    if (error instanceof OrchestratorError) {
      return error;
    }
    const code = this.safeErrorCode(error);
    return new OrchestratorError(code, `Payment operation failed (${code}).`);
  }
}

export const systemClock = {
  now: (): Date => new Date(),
};

export const randomIdGenerator = {
  next: (): string => randomUUID(),
};

export function verifyMandateSignature(
  mandate: Mandate,
  secret: string,
): boolean {
  const { signature, hash } = signatureFor(
    canonicalMandate(mandate),
    secret,
  );
  const suppliedSignature = Buffer.from(mandate.signature, "hex");
  const expectedSignature = Buffer.from(signature, "hex");
  const suppliedHash = Buffer.from(mandate.hash, "hex");
  const expectedHash = Buffer.from(hash, "hex");
  return (
    suppliedSignature.length === expectedSignature.length &&
    suppliedHash.length === expectedHash.length &&
    timingSafeEqual(suppliedSignature, expectedSignature) &&
    timingSafeEqual(suppliedHash, expectedHash)
  );
}
