import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluate } from "../../domain/guardian.ts";
import type { Mandate } from "../../domain/mandate.ts";
import type { Decision } from "../../domain/decision.ts";
import {
  InMemoryPersistence,
} from "../../persistence/in-memory.ts";
import { PersistenceError } from "../../persistence/repositories.ts";
import {
  reservePaymentInputSchema,
  type ReservePaymentInput,
} from "../../persistence/schemas.ts";

const now = "2026-11-12T10:00:00.000Z";
const mandateId = "00000000-0000-4000-8000-000000000001";
const otherMandateId = "00000000-0000-4000-8000-000000000002";

function makeMandate(
  id = mandateId,
  overrides: Partial<Mandate> = {},
): Mandate {
  return {
    id,
    version: 1,
    payee_email: "payee@example.com",
    per_payment_cap: 7000,
    total_cap: 10000,
    spent_total: 0,
    reserved_total: 0,
    currency: "USD",
    purpose: "Sandbox tests",
    expires_at: "2026-12-01T00:00:00.000Z",
    undo_window_seconds: 60,
    status: "active",
    signature: "test-signature",
    hash: "test-hash",
    created_at: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

function paymentInput(
  id: string,
  overrides: Partial<ReservePaymentInput> = {},
): ReservePaymentInput {
  return {
    id,
    mandate_id: mandateId,
    invoice_id: `invoice-${id}`,
    amount: 3000,
    currency: "USD",
    payee_email: "payee@example.com",
    created_at: now,
    ...overrides,
  };
}

async function setupPersistence(): Promise<InMemoryPersistence> {
  const persistence = new InMemoryPersistence();
  await persistence.mandates.create(makeMandate());
  return persistence;
}

describe("in-memory S2 persistence", () => {
  it("creates and reads back validated mandates", async () => {
    const persistence = await setupPersistence();

    const mandate = await persistence.mandates.getById(mandateId);
    assert.equal(mandate?.id, mandateId);
    assert.equal((await persistence.mandates.list()).length, 1);
  });

  it("only persists mandates with UUIDs", async () => {
    const persistence = new InMemoryPersistence();
    await assert.rejects(
      persistence.mandates.create(
        makeMandate("mandate-not-uuid"),
      ),
    );
    assert.deepEqual(await persistence.mandates.list(), []);
  });

  it("reserves budget and appends the initial requested event atomically", async () => {
    const persistence = await setupPersistence();
    const input = paymentInput(
      "10000000-0000-4000-8000-000000000001",
    );

    const payment = await persistence.payments.reserve(input);
    const mandate = await persistence.mandates.getById(mandateId);
    const events = await persistence.events.listByPayment(payment.id);
    const budget = await persistence.payments.getBudgetState(mandateId);

    assert.equal(payment.status, "requested");
    assert.equal(payment.invoice_id, input.invoice_id);
    assert.equal(mandate?.reserved_total, input.amount);
    assert.equal(budget.reserved_total, input.amount);
    assert.deepEqual(
      events.map(({ type, from_status, to_status }) => ({
        type,
        from_status,
        to_status,
      })),
      [
        {
          type: "payment_requested",
          from_status: null,
          to_status: "requested",
        },
      ],
    );
  });

  it("excludes the current payment and its reservation from budget history", async () => {
    const persistence = await setupPersistence();
    const payment = await persistence.payments.reserve(
      paymentInput("10000000-0000-4000-8000-000000000002"),
    );

    const budgetBeforeExclusion =
      await persistence.payments.getBudgetState(mandateId);
    const budgetExcludingCurrent =
      await persistence.payments.getBudgetState(mandateId, payment.id);

    assert.equal(budgetBeforeExclusion.reserved_total, payment.amount);
    assert.equal(budgetBeforeExclusion.used_invoice_ids.length, 1);
    assert.equal(budgetExcludingCurrent.reserved_total, 0);
    assert.deepEqual(budgetExcludingCurrent.used_invoice_ids, []);
  });

  it("only excludes a payment belonging to the requested mandate", async () => {
    const persistence = await setupPersistence();
    await persistence.mandates.create(makeMandate(otherMandateId));
    const otherPayment = await persistence.payments.reserve(
      paymentInput("10000000-0000-4000-8000-000000000014", {
        mandate_id: otherMandateId,
      }),
    );

    await assert.rejects(
      persistence.payments.getBudgetState(mandateId, otherPayment.id),
      (error: unknown) =>
        error instanceof PersistenceError && error.code === "INVALID_RECORD",
    );
  });

  it("serializes concurrent reservations so the mandate cannot be overspent", async () => {
    const persistence = await setupPersistence();
    const requests = [
      paymentInput("10000000-0000-4000-8000-000000000003", {
        amount: 6000,
        invoice_id: "invoice-concurrent-a",
      }),
      paymentInput("10000000-0000-4000-8000-000000000004", {
        amount: 6000,
        invoice_id: "invoice-concurrent-b",
      }),
    ];

    const results = await Promise.allSettled(
      requests.map((request) => persistence.payments.reserve(request)),
    );
    const fulfilled = results.filter(
      (result) => result.status === "fulfilled",
    );
    const rejected = results.find((result) => result.status === "rejected");
    const mandate = await persistence.mandates.getById(mandateId);
    const payments = await persistence.payments.listByMandate(mandateId);

    assert.equal(fulfilled.length, 1);
    assert.ok(rejected && rejected.status === "rejected");
    assert.equal(rejected.reason.code, "BUDGET_EXCEEDED");
    assert.equal(mandate?.reserved_total, 6000);
    assert.equal(payments.length, 1);
  });

  it("rejects duplicate invoices for one mandate but allows reuse under another", async () => {
    const persistence = await setupPersistence();
    await persistence.mandates.create(makeMandate(otherMandateId));
    const invoiceId = "invoice-shared-test";

    await persistence.payments.reserve(
      paymentInput("10000000-0000-4000-8000-000000000005", {
        invoice_id: invoiceId,
      }),
    );
    await assert.rejects(
      persistence.payments.reserve(
        paymentInput("10000000-0000-4000-8000-000000000006", {
          invoice_id: invoiceId,
        }),
      ),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "DUPLICATE_INVOICE",
    );

    const reused = await persistence.payments.reserve(
      paymentInput("10000000-0000-4000-8000-000000000007", {
        mandate_id: otherMandateId,
        invoice_id: invoiceId,
      }),
    );
    assert.equal(reused.mandate_id, otherMandateId);
  });

  it("rejects inactive, expired, wrong-currency, and over-cap requests", async () => {
    const persistence = await setupPersistence();
    const inactiveId = "00000000-0000-4000-8000-000000000003";
    const expiredId = "00000000-0000-4000-8000-000000000004";
    await persistence.mandates.create(
      makeMandate(inactiveId, { status: "revoked" }),
    );
    await persistence.mandates.create(
      makeMandate(expiredId, { expires_at: "2026-11-12T09:00:00.000Z" }),
    );

    const cases = [
      {
        input: paymentInput("10000000-0000-4000-8000-000000000008", {
          mandate_id: inactiveId,
        }),
        code: "MANDATE_INACTIVE",
      },
      {
        input: paymentInput("10000000-0000-4000-8000-000000000009", {
          mandate_id: expiredId,
        }),
        code: "MANDATE_EXPIRED",
      },
      {
        input: paymentInput("10000000-0000-4000-8000-000000000011", {
          amount: 7001,
        }),
        code: "PAYMENT_AMOUNT_INVALID",
      },
    ];

    for (const { input, code } of cases) {
      await assert.rejects(
        persistence.payments.reserve(input),
        (error: unknown) =>
          error instanceof PersistenceError && error.code === code,
      );
    }
    assert.equal(
      reservePaymentInputSchema.safeParse({
        ...paymentInput("10000000-0000-4000-8000-000000000013"),
        currency: "EUR",
      }).success,
      false,
    );

    assert.equal(
      (await persistence.payments.listByMandate(mandateId)).length,
      0,
    );
  });

  it("stores all five decision records and returns detached append-only event copies", async () => {
    const persistence = await setupPersistence();
    const payment = await persistence.payments.reserve(
      paymentInput("10000000-0000-4000-8000-000000000012"),
    );
    const decision: Decision = evaluate(
      makeMandate(),
      {
        spent_total: 0,
        reserved_total: 0,
        used_invoice_ids: [],
        processed_order_ids: [],
        processed_authorization_ids: [],
      },
      {
        payee_email: "payee@example.com",
        amount: 3000,
        currency: "USD",
        invoice_id: "invoice-evaluated",
        paypal_order_id: "order-evaluated",
        authorization_id: "authorization-evaluated",
        status: "authorized",
      },
      new Date(now),
    );
    await persistence.decisions.append(payment.id, decision, now);

    const appendedEvent = await persistence.events.append({
      payment_id: payment.id,
      type: "guardian_decision",
      from_status: "authorized",
      to_status: "held",
      detail: { verdict: decision.passed },
      created_at: now,
    });
    appendedEvent.detail.verdict = false;

    const decisions = await persistence.decisions.listByPayment(payment.id);
    const events = await persistence.events.listByPayment(payment.id);
    assert.equal(decisions.length, 5);
    assert.deepEqual(
      decisions.map(({ rule }) => rule),
      ["R1", "R2", "R3", "R4", "R5"],
    );
    assert.equal(events.at(-1)?.detail.verdict, true);
  });
});
