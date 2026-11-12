import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluate } from "../../domain/guardian.ts";
import type {
  BudgetState,
  Mandate,
  ObservedPayment,
} from "../../domain/index.ts";

const now = new Date("2026-11-12T10:00:00.000Z");

function makeMandate(overrides: Partial<Mandate> = {}): Mandate {
  return {
    id: "mandate-1",
    version: 1,
    payee_email: "payee@example.com",
    per_payment_cap: 5000,
    total_cap: 10000,
    spent_total: 1000,
    reserved_total: 1000,
    currency: "USD",
    purpose: "Approved invoices",
    expires_at: "2026-12-01T00:00:00.000Z",
    undo_window_seconds: 60,
    status: "active",
    signature: "test-signature",
    hash: "test-hash",
    created_at: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeBudgetState(overrides: Partial<BudgetState> = {}): BudgetState {
  return {
    spent_total: 1000,
    reserved_total: 1000,
    used_invoice_ids: ["invoice-used"],
    processed_order_ids: ["order-used"],
    processed_authorization_ids: ["authorization-used"],
    ...overrides,
  };
}

function makeObservedPayment(
  overrides: Partial<ObservedPayment> = {},
): ObservedPayment {
  return {
    payee_email: "payee@example.com",
    amount: 3000,
    currency: "USD",
    invoice_id: "invoice-new",
    paypal_order_id: "order-new",
    authorization_id: "authorization-new",
    status: "authorized",
    ...overrides,
  };
}

function resultFor(
  paymentOverrides: Partial<ObservedPayment> = {},
  mandateOverrides: Partial<Mandate> = {},
  budgetOverrides: Partial<BudgetState> = {},
) {
  return evaluate(
    makeMandate(mandateOverrides),
    makeBudgetState(budgetOverrides),
    makeObservedPayment(paymentOverrides),
    now,
  );
}

describe("Guardian R1-R5", () => {
  it("defers R5 during preflight without synthetic PayPal identifiers", () => {
    const result = evaluate(
      makeMandate(),
      makeBudgetState(),
      makeObservedPayment({
        paypal_order_id: null,
        authorization_id: null,
        status: "requested",
      }),
      now,
      "preflight",
    );

    assert.equal(result.phase, "preflight");
    assert.equal(result.passed, true);
    assert.deepEqual(result.results[4], {
      rule: "R5",
      passed: true,
      expected: { status: "checked after authorization" },
      actual: { status: "deferred_no_paypal_ids_yet" },
    });
  });

  it("fails preflight when any of R1-R4 fails, regardless of deferred R5", () => {
    const result = evaluate(
      makeMandate(),
      makeBudgetState(),
      makeObservedPayment({
        payee_email: "attacker@example.com",
        paypal_order_id: null,
        authorization_id: null,
        status: "requested",
      }),
      now,
      "preflight",
    );

    assert.equal(result.results[0]?.passed, false);
    assert.equal(result.results[4]?.actual.status, "deferred_no_paypal_ids_yet");
    assert.equal(result.passed, false);
  });

  it("passes R1 for a trimmed, case-insensitive payee match", () => {
    const result = resultFor({ payee_email: "  PAYEE@example.com " });

    assert.equal(result.results[0].rule, "R1");
    assert.equal(result.results[0].passed, true);
  });

  it("fails R1 when the observed payee differs", () => {
    const result = resultFor({ payee_email: "other@example.com" });

    assert.equal(result.results[0].passed, false);
  });

  it("passes R2 when amount fits the caps and currency", () => {
    const result = resultFor({ amount: 3000 });

    assert.equal(result.results[1].passed, true);
  });

  it("fails R2 for a non-positive amount", () => {
    const result = resultFor({ amount: 0 });

    assert.equal(result.results[1].passed, false);
  });

  it("fails R2 when the amount exceeds either payment cap or available budget", () => {
    const abovePerPaymentCap = resultFor({ amount: 5001 });
    const aboveAvailableBudget = resultFor(
      { amount: 8001 },
      { per_payment_cap: 9000 },
      { spent_total: 1000, reserved_total: 1000 },
    );

    assert.equal(abovePerPaymentCap.results[1].passed, false);
    assert.equal(aboveAvailableBudget.results[1].passed, false);
  });

  it("fails R2 when currency does not match", () => {
    const result = resultFor({ currency: "EUR" });

    assert.equal(result.results[1].passed, false);
  });

  it("passes R3 for a present invoice not used under this mandate", () => {
    const result = resultFor();

    assert.equal(result.results[2].passed, true);
  });

  it("fails R3 for a missing or previously used invoice", () => {
    const missingInvoice = resultFor({ invoice_id: "  " });
    const usedInvoice = resultFor({ invoice_id: "invoice-used" });

    assert.equal(missingInvoice.results[2].passed, false);
    assert.equal(usedInvoice.results[2].passed, false);
  });

  it("passes R4 for an active mandate that has not expired", () => {
    const result = resultFor();

    assert.equal(result.results[3].passed, true);
  });

  it("fails R4 for an inactive or expired mandate", () => {
    const revoked = resultFor({}, { status: "revoked" });
    const expired = resultFor(
      {},
      { expires_at: "2026-11-12T10:00:00.000Z" },
    );

    assert.equal(revoked.results[3].passed, false);
    assert.equal(expired.results[3].passed, false);
  });

  it("passes R5 for new PayPal IDs while the payment is authorized", () => {
    const result = resultFor();

    assert.equal(result.results[4].passed, true);
  });

  it("fails R5 for previously processed IDs or a payment no longer authorized", () => {
    const repeatedOrder = resultFor({ paypal_order_id: "order-used" });
    const repeatedAuthorization = resultFor({
      authorization_id: "authorization-used",
    });
    const alreadyHeld = resultFor({ status: "held" });

    assert.equal(repeatedOrder.results[4].passed, false);
    assert.equal(repeatedAuthorization.results[4].passed, false);
    assert.equal(alreadyHeld.results[4].passed, false);
  });

  it("evaluates and returns all five rules when multiple rules fail", () => {
    const result = resultFor(
      {
        payee_email: "attacker@example.com",
        amount: 0,
        invoice_id: "invoice-used",
        status: "held",
      },
      { status: "revoked" },
    );

    assert.deepEqual(
      result.results.map(({ rule }) => rule),
      ["R1", "R2", "R3", "R4", "R5"],
    );
    assert.deepEqual(
      result.results.map(({ passed }) => passed),
      [false, false, false, false, false],
    );
    assert.equal(result.passed, false);
  });

  it("returns an overall passing verdict only when all five rules pass", () => {
    const result = resultFor();

    assert.equal(result.results.length, 5);
    assert.ok(result.results.every(({ passed }) => passed));
    assert.equal(result.passed, true);
  });

  it("does not include the current reservation in available budget", () => {
    const result = resultFor(
      { amount: 8000 },
      { per_payment_cap: 8000, total_cap: 10000 },
      { spent_total: 1000, reserved_total: 1000 },
    );

    assert.equal(result.results[1].expected.available_budget_cents, 8000);
    assert.equal(result.results[1].passed, true);
  });
});
