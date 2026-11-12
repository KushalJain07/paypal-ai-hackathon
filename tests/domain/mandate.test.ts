import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMandateSchema, mandateSchema } from "../../domain/mandate.ts";

const validDraft = {
  payee_email: "payee@example.com",
  per_payment_cap: 5000,
  total_cap: 10000,
  currency: "USD",
  purpose: "Approved invoices",
  expires_at: "2099-12-01T00:00:00.000Z",
  undo_window_seconds: 60,
};

describe("mandate schemas", () => {
  it("accepts valid USD mandate creation data with cents and a future expiry", () => {
    const result = createMandateSchema.safeParse(validDraft);

    assert.equal(result.success, true);
  });

  it("rejects invalid email, non-positive caps, excessive per-payment caps, and expired mandates", () => {
    assert.equal(
      createMandateSchema.safeParse({
        ...validDraft,
        payee_email: "not-an-email",
      }).success,
      false,
    );
    assert.equal(
      createMandateSchema.safeParse({
        ...validDraft,
        per_payment_cap: 0,
      }).success,
      false,
    );
    assert.equal(
      createMandateSchema.safeParse({
        ...validDraft,
        per_payment_cap: 10001,
      }).success,
      false,
    );
    assert.equal(
      createMandateSchema.safeParse({
        ...validDraft,
        expires_at: "2000-01-01T00:00:00.000Z",
      }).success,
      false,
    );
  });

  it("rejects non-integer cents, non-USD currency, and undo windows outside the required range", () => {
    assert.equal(
      createMandateSchema.safeParse({
        ...validDraft,
        total_cap: 100.5,
      }).success,
      false,
    );
    assert.equal(
      createMandateSchema.safeParse({
        ...validDraft,
        currency: "EUR",
      }).success,
      false,
    );
    assert.equal(
      createMandateSchema.safeParse({
        ...validDraft,
        undo_window_seconds: 9,
      }).success,
      false,
    );
    assert.equal(
      createMandateSchema.safeParse({
        ...validDraft,
        purpose: "p".repeat(201),
      }).success,
      false,
    );
  });

  it("accepts a structurally valid expired mandate record for historical reads", () => {
    const result = mandateSchema.safeParse({
      ...validDraft,
      id: "mandate-1",
      version: 1,
      spent_total: 1000,
      reserved_total: 500,
      status: "expired",
      signature: "signature",
      hash: "hash",
      created_at: "2026-11-01T00:00:00.000Z",
    });

    assert.equal(result.success, true);
  });
});
