import type { Decision, RuleEvidence, RuleResult } from "./decision.ts";
import { decisionSchema } from "./decision.ts";
import type { Mandate } from "./mandate.ts";
import type { BudgetState, ObservedPayment } from "./payment.ts";

function createRuleResult(
  rule: RuleResult["rule"],
  passed: boolean,
  expected: Record<string, RuleEvidence>,
  actual: Record<string, RuleEvidence>,
): RuleResult {
  return { rule, passed, expected, actual };
}

export function evaluate(
  mandate: Mandate,
  budgetState: BudgetState,
  observedPayment: ObservedPayment,
  now: Date,
  phase: "preflight" | "authorized" = "authorized",
): Decision {
  const evaluatedAt = now.getTime();
  if (!Number.isFinite(evaluatedAt)) {
    throw new RangeError("now must be a valid Date");
  }

  const normalizedMandatePayee = mandate.payee_email.trim().toLowerCase();
  const normalizedObservedPayee = observedPayment.payee_email.trim().toLowerCase();
  const payeeMatches = normalizedObservedPayee === normalizedMandatePayee;

  // reserved_total is a pre-reservation snapshot and must exclude this payment's reservation.
  const availableBudget =
    mandate.total_cap - budgetState.spent_total - budgetState.reserved_total;
  const amountIsWithinLimits =
    observedPayment.amount > 0 &&
    observedPayment.amount <= mandate.per_payment_cap &&
    observedPayment.amount <= availableBudget;
  const currencyMatches = observedPayment.currency === mandate.currency;
  const amountAndCurrencyPass = amountIsWithinLimits && currencyMatches;

  const invoiceId = observedPayment.invoice_id;
  const invoiceIsPresent = invoiceId !== null && invoiceId.trim().length > 0;
  const invoiceWasUsed =
    invoiceId !== null && budgetState.used_invoice_ids.includes(invoiceId);

  const mandateIsUnexpired =
    mandate.status === "active" &&
    evaluatedAt < Date.parse(mandate.expires_at);

  const orderId = observedPayment.paypal_order_id;
  const authorizationId = observedPayment.authorization_id;
  const orderIdWasProcessed =
    orderId !== null && budgetState.processed_order_ids.includes(orderId);
  const authorizationIdWasProcessed =
    authorizationId !== null &&
    budgetState.processed_authorization_ids.includes(authorizationId);
  const paymentIsStillAuthorized = observedPayment.status === "authorized";

  const results: Decision["results"] = [
    createRuleResult(
      "R1",
      payeeMatches,
      { payee_email: mandate.payee_email.trim() },
      { payee_email: observedPayment.payee_email.trim() },
    ),
    createRuleResult(
      "R2",
      amountAndCurrencyPass,
      {
        amount_greater_than_cents: 0,
        per_payment_cap_cents: mandate.per_payment_cap,
        available_budget_cents: availableBudget,
        currency: mandate.currency,
      },
      {
        amount_cents: observedPayment.amount,
        currency: observedPayment.currency,
        within_amount_limits: amountIsWithinLimits,
      },
    ),
    createRuleResult(
      "R3",
      invoiceIsPresent && !invoiceWasUsed,
      { invoice_id: "present and unused for this mandate" },
      {
        invoice_id: invoiceId,
        already_used: invoiceWasUsed,
      },
    ),
    createRuleResult(
      "R4",
      mandateIsUnexpired,
      {
        status: "active",
        expires_at_after: now.toISOString(),
      },
      {
        status: mandate.status,
        expires_at: mandate.expires_at,
      },
    ),
    phase === "preflight"
      ? createRuleResult(
          "R5",
          true,
          { status: "checked after authorization" },
          { status: "deferred_no_paypal_ids_yet" },
        )
      : createRuleResult(
          "R5",
          orderId !== null &&
            orderId.trim().length > 0 &&
            !orderIdWasProcessed &&
            authorizationId !== null &&
            authorizationId.trim().length > 0 &&
            !authorizationIdWasProcessed &&
            paymentIsStillAuthorized,
          {
            paypal_order_id: "present and not previously processed globally",
            authorization_id: "present and not previously processed globally",
            status: "authorized",
          },
          {
            paypal_order_id: orderId,
            order_id_previously_processed: orderIdWasProcessed,
            authorization_id: authorizationId,
            authorization_id_previously_processed: authorizationIdWasProcessed,
            status: observedPayment.status,
          },
        ),
  ];

  const decision = {
    phase,
    passed:
      phase === "preflight"
        ? results.slice(0, 4).every((result) => result.passed)
        : results.every((result) => result.passed),
    results,
  };

  return decisionSchema.parse(decision);
}
