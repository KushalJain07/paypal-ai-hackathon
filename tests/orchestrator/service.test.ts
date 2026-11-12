import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Mandate } from "../../domain/mandate.ts";
import type { ObservedPayment, Payment } from "../../domain/payment.ts";
import {
  InMemoryPersistence,
  type ReservePaymentInput,
} from "../../persistence/index.ts";
import type {
  ApprovalOrder,
  ApprovalProvider,
  Authorization,
  Capture,
  CreateOrderInput,
  CreatedOrder,
  OrderSnapshot,
  PaymentProvider,
  Refund,
} from "../../paypal/payment-provider.ts";
import { PayPalProviderError } from "../../paypal/payment-provider.ts";
import type {
  Notifier,
  PaymentNotification,
} from "../../notifications/notifier.ts";
import {
  OrchestratorError,
  PaymentOrchestrator,
  verifyMandateSignature,
} from "../../orchestrator/service.ts";
import { runWorkerLoop } from "../../scripts/worker.ts";

const signingSecret = "unit-test-mandate-signing-secret-32chars";
const sandboxApprovalUrl =
  "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-TEST";
const defaultNow = new Date("2026-11-12T10:00:00.000Z");
const otherPaymentId = "00000000-0000-4000-8000-000000000099";

class TestClock {
  private current: Date;

  constructor(current: Date = new Date(defaultNow)) {
    this.current = current;
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }

  set(date: Date): void {
    this.current = new Date(date);
  }
}

class TestIds {
  private nextValue = 1;

  next(): string {
    const tail = String(this.nextValue++).padStart(12, "0");
    return `00000000-0000-4000-8000-${tail}`;
  }
}

class FakePaymentProvider implements PaymentProvider {
  createCalls = 0;
  authorizeCalls = 0;
  voidCalls = 0;
  captureCalls = 0;
  refundCalls = 0;
  failCreate = false;
  failCapture = false;
  pendingCapture = false;
  uncertainCapture = false;
  recoveryFailure = false;
  recoveredCapture: Capture | null = null;
  authorizationStatus: Authorization["status"] = "CREATED";
  reusedAuthorizationId: string | null = null;
  observe?: (payment: ObservedPayment) => ObservedPayment;
  private readonly orderByPayment = new Map<string, CreateOrderInput>();
  private readonly authorizationByPayment = new Map<string, string>();
  private readonly voided = new Set<string>();

  async createOrder(input: CreateOrderInput): Promise<CreatedOrder> {
    this.createCalls += 1;
    if (this.failCreate) {
      throw new Error("test-provider-failure");
    }
    this.orderByPayment.set(input.paymentId, input);
    return {
      paymentId: input.paymentId,
      paypalOrderId: `ORDER-${input.paymentId}`,
      status: "CREATED",
      approvalUrl: sandboxApprovalUrl,
    };
  }

  async getOrder(paymentId: string, orderId: string): Promise<OrderSnapshot> {
    const input = this.orderByPayment.get(paymentId);
    assert.ok(input);
    const authorizationId = this.authorizationByPayment.get(paymentId) ?? null;
    const observed = {
      payee_email: input.payeeEmail,
      amount: input.amountCents,
      currency: input.currency,
      invoice_id: input.invoiceId,
      paypal_order_id: orderId,
      authorization_id: authorizationId,
      status: authorizationId ? "authorized" : "requested",
    } satisfies ObservedPayment;
    return {
      paypalOrderId: orderId,
      status: authorizationId ? "COMPLETED" : "APPROVED",
      observedPayment: this.observe ? this.observe(observed) : observed,
    };
  }

  async authorizeOrder(
    paymentId: string,
    orderId: string,
  ): Promise<Authorization> {
    this.authorizeCalls += 1;
    assert.equal(orderId, `ORDER-${paymentId}`);
    const input = this.orderByPayment.get(paymentId);
    assert.ok(input);
    const authorizationId =
      this.reusedAuthorizationId ?? `AUTH-${paymentId}`;
    this.authorizationByPayment.set(paymentId, authorizationId);
    return {
      authorizationId,
      status: "CREATED",
      amountCents: input.amountCents,
      currency: input.currency,
    };
  }

  async getAuthorization(
    paymentId: string,
    authorizationId: string,
  ): Promise<Authorization> {
    assert.equal(this.authorizationByPayment.get(paymentId), authorizationId);
    const input = this.orderByPayment.get(paymentId);
    assert.ok(input);
    return {
      authorizationId,
      status: this.voided.has(authorizationId)
        ? "VOIDED"
        : this.authorizationStatus,
      amountCents: input.amountCents,
      currency: input.currency,
    };
  }

  async findCaptureForAuthorization(): Promise<Capture | null> {
    if (this.recoveryFailure) {
      throw new PayPalProviderError(
        "NETWORK_ERROR",
        "getOrder",
      );
    }
    return this.recoveredCapture;
  }

  async captureAuthorization(
    paymentId: string,
    authorizationId: string,
  ): Promise<Capture> {
    this.captureCalls += 1;
    if (this.uncertainCapture) {
      throw new PayPalProviderError(
        "CAPTURE_RECOVERY_PENDING",
        "captureAuthorization",
      );
    }
    if (this.failCapture) {
      throw new Error("test-capture-failure");
    }
    assert.equal(this.authorizationByPayment.get(paymentId), authorizationId);
    const input = this.orderByPayment.get(paymentId);
    assert.ok(input);
    return {
      captureId: `CAPTURE-${paymentId}`,
      status: this.pendingCapture ? "PENDING" : "COMPLETED",
      amountCents: input.amountCents,
      currency: input.currency,
      finalCapture: true,
    };
  }

  async voidAuthorization(
    paymentId: string,
    authorizationId: string,
  ): Promise<Authorization> {
    this.voidCalls += 1;
    assert.equal(this.authorizationByPayment.get(paymentId), authorizationId);
    this.voided.add(authorizationId);
    const input = this.orderByPayment.get(paymentId);
    assert.ok(input);
    return {
      authorizationId,
      status: "VOIDED",
      amountCents: input.amountCents,
      currency: input.currency,
    };
  }

  async refundCapture(paymentId: string, captureId: string): Promise<Refund> {
    this.refundCalls += 1;
    assert.equal(captureId, `CAPTURE-${paymentId}`);
    return { refundId: `REFUND-${paymentId}`, status: "COMPLETED" };
  }
}

class FakeApprovalProvider implements ApprovalProvider {
  calls = 0;

  async approve(order: ApprovalOrder) {
    this.calls += 1;
    return {
      paymentId: order.paymentId,
      paypalOrderId: order.paypalOrderId,
      status: "APPROVED" as const,
    };
  }
}

interface TestContext {
  persistence: InMemoryPersistence;
  paymentProvider: FakePaymentProvider;
  approvalProvider: FakeApprovalProvider;
  clock: TestClock;
  orchestrator: PaymentOrchestrator;
  mandate: Mandate;
}

async function setup(options: {
  now?: Date;
  perPaymentCap?: number;
  totalCap?: number;
  notifier?: Notifier;
} = {}): Promise<TestContext> {
  const persistence = new InMemoryPersistence();
  const paymentProvider = new FakePaymentProvider();
  const approvalProvider = new FakeApprovalProvider();
  const clock = new TestClock(options.now);
  const ids = new TestIds();
  const orchestrator = new PaymentOrchestrator({
    mandates: persistence.mandates,
    payments: persistence.payments,
    decisions: persistence.decisions,
    events: persistence.events,
    paymentProvider,
    approvalProvider,
    clock,
    ids,
    signingSecret,
    notifier: options.notifier,
  });
  const mandate = await orchestrator.createMandate({
    payee_email: "payee@example.com",
    per_payment_cap: options.perPaymentCap ?? 7000,
    total_cap: options.totalCap ?? 10000,
    currency: "USD",
    purpose: "orchestrator tests",
    expires_at: "2026-12-20T00:00:00.000Z",
    undo_window_seconds: 60,
  });
  return {
    persistence,
    paymentProvider,
    approvalProvider,
    clock,
    orchestrator,
    mandate,
  };
}

function request(
  mandateId: string,
  overrides: Partial<{
    payeeEmail: string;
    amountCents: number;
    invoiceId: string;
  }> = {},
) {
  return {
    mandateId,
    payeeEmail: overrides.payeeEmail ?? "payee@example.com",
    amountCents: overrides.amountCents ?? 3000,
    invoiceId: overrides.invoiceId ?? "invoice-new",
  };
}

async function beginAndAuthorize(
  context: TestContext,
  input = request(context.mandate.id),
): Promise<Payment> {
  const result = await context.orchestrator.requestPayment(input);
  assert.equal(result.payment.status, "requested");
  return context.orchestrator.completeAuthorization(result.payment.id);
}

async function seedPayment(
  context: TestContext,
  overrides: Partial<ReservePaymentInput> = {},
): Promise<Payment> {
  return context.persistence.payments.reserve({
    id: otherPaymentId,
    mandate_id: context.mandate.id,
    invoice_id: "invoice-seeded",
    amount: 500,
    currency: "USD",
    payee_email: "payee@example.com",
    created_at: context.clock.now().toISOString(),
    ...overrides,
  });
}

describe("S4 payment orchestrator", () => {
  it("notifies on held, rejected, captured, voided, and refunded transitions", async () => {
    const notifications: PaymentNotification[] = [];
    const context = await setup({
      notifier: {
        notify: async (notification) => {
          notifications.push(notification);
        },
      },
    });

    await context.orchestrator.requestPayment(
      request(context.mandate.id, { payeeEmail: "other@example.com" }),
    );
    const heldForUndo = await beginAndAuthorize(
      context,
      request(context.mandate.id, { invoiceId: "undo-invoice" }),
    );
    await context.orchestrator.undo(heldForUndo.id);
    const heldForCapture = await beginAndAuthorize(
      context,
      request(context.mandate.id, { invoiceId: "capture-invoice" }),
    );
    await context.orchestrator.releaseDue(
      new Date("2026-11-12T10:01:00.000Z"),
    );
    await context.orchestrator.refund(heldForCapture.id);

    assert.deepEqual(
      notifications.map(({ type }) => type),
      ["rejected", "held", "voided", "held", "captured", "refunded"],
    );
    assert.deepEqual(notifications[0]?.failedRules, ["R1"]);
  });

  it("runs a valid request through hold and due capture", async () => {
    const context = await setup();
    const held = await beginAndAuthorize(context);
    assert.equal(held.status, "held");
    assert.equal(held.release_at, "2026-11-12T10:01:00.000Z");

    const detail = await context.orchestrator.getPaymentDetail(held.id);
    assert.deepEqual(
      detail.decisions.map((decision) => decision.phase),
      ["preflight", "preflight", "preflight", "preflight", "preflight",
        "authorized", "authorized", "authorized", "authorized", "authorized"],
    );
    assert.equal(detail.decisions[4]?.actual.status, "deferred_no_paypal_ids_yet");

    const released = await context.orchestrator.releaseDue(
      new Date("2026-11-12T10:01:00.000Z"),
    );
    assert.deepEqual(released, [{ paymentId: held.id, status: "captured" }]);
    const captured = await context.persistence.payments.getById(held.id);
    const mandate = await context.persistence.mandates.getById(context.mandate.id);
    assert.equal(captured?.status, "captured");
    assert.equal(mandate?.reserved_total, 0);
    assert.equal(mandate?.spent_total, 3000);
  });

  it("undoes held payments and releases the reservation", async () => {
    const context = await setup();
    const held = await beginAndAuthorize(context);

    const undone = await context.orchestrator.undo(held.id);
    const mandate = await context.persistence.mandates.getById(context.mandate.id);

    assert.equal(undone.status, "voided");
    assert.equal(context.paymentProvider.voidCalls, 1);
    assert.equal(mandate?.reserved_total, 0);
    assert.equal(mandate?.spent_total, 0);
  });

  it("refunds captured payments and restores spent budget", async () => {
    const context = await setup();
    const held = await beginAndAuthorize(context);
    await context.orchestrator.releaseDue(
      new Date("2026-11-12T10:01:00.000Z"),
    );

    const refunded = await context.orchestrator.refund(held.id);
    const mandate = await context.persistence.mandates.getById(context.mandate.id);

    assert.equal(refunded.status, "refunded");
    assert.equal(context.paymentProvider.refundCalls, 1);
    assert.equal(mandate?.spent_total, 0);
  });

  it("rejects all preflight rule failures before any PayPal call", async () => {
    const cases = [
      {
        name: "R1",
        input: (context: TestContext) =>
          request(context.mandate.id, { payeeEmail: "other@example.com" }),
        expectedRule: "R1",
      },
      {
        name: "R2",
        input: (context: TestContext) =>
          request(context.mandate.id, { amountCents: 7001 }),
        expectedRule: "R2",
      },
      {
        name: "R3",
        input: (context: TestContext) => request(context.mandate.id, {
          invoiceId: "invoice-used",
        }),
        expectedRule: "R3",
      },
      {
        name: "R4",
        input: (context: TestContext) => request(context.mandate.id),
        expectedRule: "R4",
        now: new Date("2026-12-21T00:00:00.000Z"),
      },
    ] as const;

    for (const testCase of cases) {
      const context = await setup(
        "now" in testCase ? { now: testCase.now } : {},
      );
      if (testCase.name === "R3") {
        await seedPayment(context, { invoice_id: "invoice-used" });
      }
      const result = await context.orchestrator.requestPayment(
        testCase.input(context),
      );
      const detail = await context.orchestrator.getPaymentDetail(result.payment.id);
      assert.equal(result.payment.status, "rejected", testCase.name);
      assert.equal(result.decision.phase, "preflight");
      assert.equal(result.decision.results.find(
        (rule) => rule.rule === testCase.expectedRule,
      )?.passed, false);
      assert.equal(result.decision.results[4]?.actual.status, "deferred_no_paypal_ids_yet");
      assert.equal(detail.decisions.length, 5);
      assert.equal(context.paymentProvider.createCalls, 0);
      assert.equal(
        (await context.persistence.mandates.getById(context.mandate.id))
          ?.reserved_total,
        testCase.name === "R3" ? 500 : 0,
      );
    }
  });

  it("does not allow a preflight result to authorize or hold a rejected payment", async () => {
    const context = await setup();
    const rejected = await context.orchestrator.requestPayment(
      request(context.mandate.id, { payeeEmail: "other@example.com" }),
    );

    await assert.rejects(
      context.orchestrator.completeAuthorization(rejected.payment.id),
      (error: unknown) =>
        error instanceof OrchestratorError &&
        error.code === "PAYMENT_STATUS_CONFLICT",
    );
    assert.equal(
      (await context.persistence.payments.getById(rejected.payment.id))?.status,
      "rejected",
    );
    assert.equal(context.paymentProvider.authorizeCalls, 0);
  });

  it("stores rejected duplicate invoice attempts without reserving more budget", async () => {
    const context = await setup();
    const first = await context.orchestrator.requestPayment(
      request(context.mandate.id, { invoiceId: "same-invoice" }),
    );
    const second = await context.orchestrator.requestPayment(
      request(context.mandate.id, { invoiceId: "same-invoice" }),
    );
    const mandate = await context.persistence.mandates.getById(context.mandate.id);

    assert.equal(first.payment.status, "requested");
    assert.equal(second.payment.status, "rejected");
    assert.equal(second.decision.results[2]?.passed, false);
    assert.equal(context.paymentProvider.createCalls, 1);
    assert.equal(mandate?.reserved_total, 3000);
  });

  it("serializes concurrent requests so budget cannot be overspent", async () => {
    const context = await setup();
    const results = await Promise.all([
      context.orchestrator.requestPayment(
        request(context.mandate.id, {
          amountCents: 6000,
          invoiceId: "concurrent-a",
        }),
      ),
      context.orchestrator.requestPayment(
        request(context.mandate.id, {
          amountCents: 6000,
          invoiceId: "concurrent-b",
        }),
      ),
    ]);
    const statuses = results.map(({ payment }) => payment.status).sort();
    const mandate = await context.persistence.mandates.getById(context.mandate.id);

    assert.deepEqual(statuses, ["rejected", "requested"]);
    assert.equal(mandate?.reserved_total, 6000);
    assert.equal(context.paymentProvider.createCalls, 1);
  });

  it("runs the authorized Guardian phase and voids on each failing rule", async () => {
    const cases = ["R1", "R2", "R3", "R4", "R5"] as const;
    for (const failingRule of cases) {
      const context = await setup();
      if (failingRule === "R3") {
        await seedPayment(context, { invoice_id: "invoice-already-used" });
        context.paymentProvider.observe = (payment) => ({
          ...payment,
          invoice_id: "invoice-already-used",
        });
      }
      if (failingRule === "R5") {
        await seedPayment(context);
        await context.persistence.payments.transition({
          paymentId: otherPaymentId,
          expectedStatus: "requested",
          nextStatus: "authorized",
          at: context.clock.now().toISOString(),
          budgetEffect: "none",
          eventType: "payment_authorized",
          detail: { authorization_id: "AUTH-REPLAY" },
          authorizationId: "AUTH-REPLAY",
        });
        context.paymentProvider.reusedAuthorizationId = "AUTH-REPLAY";
      }
      if (failingRule === "R1") {
        context.paymentProvider.observe = (payment) => ({
          ...payment,
          payee_email: "attacker@example.com",
        });
      }
      if (failingRule === "R2") {
        context.paymentProvider.observe = (payment) => ({
          ...payment,
          amount: 7001,
        });
      }

      const requestResult = await context.orchestrator.requestPayment(
        request(context.mandate.id),
      );
      if (failingRule === "R4") {
        context.clock.set(new Date("2026-12-21T00:00:00.000Z"));
      }
      const result = await context.orchestrator.completeAuthorization(
        requestResult.payment.id,
      );
      const detail = await context.orchestrator.getPaymentDetail(result.id);
      const finalDecision = detail.decisions.filter(
        (decision) => decision.phase === "authorized",
      );

      assert.equal(result.status, "rejected", failingRule);
      assert.equal(finalDecision.length, 5);
      assert.equal(
        finalDecision.find((decision) => decision.rule === failingRule)?.passed,
        false,
        failingRule,
      );
      assert.equal(context.paymentProvider.voidCalls, 1);
      assert.equal(
        (await context.persistence.mandates.getById(context.mandate.id))
          ?.reserved_total,
        failingRule === "R3" || failingRule === "R5" ? 500 : 0,
      );
    }
  });

  it("wins only one action when undo races releaseDue", async () => {
    const context = await setup();
    const held = await beginAndAuthorize(context);
    const results = await Promise.allSettled([
      context.orchestrator.undo(held.id),
      context.orchestrator.releaseDue(
        new Date("2026-11-12T10:01:00.000Z"),
      ),
    ]);
    const payment = await context.persistence.payments.getById(held.id);
    const successfulActions = results.filter(
      (result) =>
        result.status === "fulfilled" &&
        (Array.isArray(result.value)
          ? result.value.some((entry) => entry.status === "captured")
          : result.value.status === "voided"),
    );

    assert.equal(successfulActions.length, 1);
    assert.ok(payment?.status === "voided" || payment?.status === "captured");
    assert.equal(context.paymentProvider.captureCalls + context.paymentProvider.voidCalls, 1);
  });

  it("captures only once when releaseDue runs twice", async () => {
    const context = await setup();
    const held = await beginAndAuthorize(context);
    const at = new Date("2026-11-12T10:01:00.000Z");

    const [first, second] = await Promise.all([
      context.orchestrator.releaseDue(at),
      context.orchestrator.releaseDue(at),
    ]);
    assert.equal(context.paymentProvider.captureCalls, 1);
    assert.equal(
      [...first, ...second].filter((result) => result.status === "captured").length,
      1,
    );
    assert.equal(
      (await context.persistence.payments.getById(held.id))?.status,
      "captured",
    );
  });

  it("keeps overlapping worker loops from releasing the same payment twice", async () => {
    const context = await setup();
    const held = await beginAndAuthorize(context);
    const now = new Date("2026-11-12T10:01:00.000Z");
    const runOnce = async () => {
      const controller = new AbortController();
      await runWorkerLoop(context.orchestrator, controller.signal, {
        intervalMs: 100,
        staleClaimSeconds: 120,
        now: () => now,
        sleep: async () => controller.abort(),
        logger: { info: () => {}, error: () => {} },
      });
    };

    await Promise.all([runOnce(), runOnce()]);

    assert.equal(context.paymentProvider.captureCalls, 1);
    assert.equal((await context.persistence.payments.getById(held.id))?.status, "captured");
  });

  it("recovers a stale claim to captured when PayPal already has the capture", async () => {
    const context = await setup();
    const held = await beginAndAuthorize(context);
    const claimedAt = new Date("2026-11-12T10:01:00.000Z");
    const claimed = await context.persistence.payments.claimAction(
      held.id,
      "held",
      "release",
      claimedAt.toISOString(),
      claimedAt.toISOString(),
    );
    assert.equal(claimed, true);
    context.paymentProvider.recoveredCapture = {
      captureId: `CAPTURE-${held.id}`,
      status: "COMPLETED",
      amountCents: held.amount,
      currency: held.currency,
      finalCapture: true,
    };
    const now = new Date("2026-11-12T10:04:00.000Z");

    const recovered = await context.orchestrator.recoverStaleReleases(now, 120);
    const release = await context.orchestrator.releaseDue(now);

    assert.deepEqual(recovered, [{ paymentId: held.id, status: "captured" }]);
    assert.deepEqual(release, []);
    assert.equal(context.paymentProvider.captureCalls, 0);
    assert.equal((await context.persistence.payments.getById(held.id))?.status, "captured");
  });

  it("returns an uncaptured stale payment to held so it can be released", async () => {
    const context = await setup();
    const held = await beginAndAuthorize(context);
    const claimedAt = new Date("2026-11-12T10:01:00.000Z");
    await context.persistence.payments.claimAction(
      held.id,
      "held",
      "release",
      claimedAt.toISOString(),
      claimedAt.toISOString(),
    );
    const now = new Date("2026-11-12T10:04:00.000Z");

    const recovered = await context.orchestrator.recoverStaleReleases(now, 120);
    const release = await context.orchestrator.releaseDue(now);

    assert.deepEqual(recovered, [{ paymentId: held.id, status: "held" }]);
    assert.deepEqual(release, [{ paymentId: held.id, status: "captured" }]);
    assert.equal(context.paymentProvider.captureCalls, 1);
  });

  it("fails and releases budget for a stale claim with a terminal authorization", async () => {
    const context = await setup();
    const held = await beginAndAuthorize(context);
    const claimedAt = new Date("2026-11-12T10:01:00.000Z");
    await context.persistence.payments.claimAction(
      held.id,
      "held",
      "release",
      claimedAt.toISOString(),
      claimedAt.toISOString(),
    );
    context.paymentProvider.authorizationStatus = "VOIDED";
    const recovered = await context.orchestrator.recoverStaleReleases(
      new Date("2026-11-12T10:04:00.000Z"),
      120,
    );

    assert.deepEqual(recovered, [{ paymentId: held.id, status: "failed" }]);
    assert.equal((await context.persistence.payments.getById(held.id))?.status, "failed");
    assert.equal(
      (await context.persistence.mandates.getById(context.mandate.id))?.reserved_total,
      0,
    );
  });

  it("retains a refreshed claim when PayPal recovery is inconclusive", async () => {
    const context = await setup();
    const held = await beginAndAuthorize(context);
    const claimedAt = new Date("2026-11-12T10:01:00.000Z");
    await context.persistence.payments.claimAction(
      held.id,
      "held",
      "release",
      claimedAt.toISOString(),
      claimedAt.toISOString(),
    );
    context.paymentProvider.recoveryFailure = true;
    const now = new Date("2026-11-12T10:04:00.000Z");

    const recovered = await context.orchestrator.recoverStaleReleases(now, 120);
    const release = await context.orchestrator.releaseDue(now);

    assert.equal(recovered[0]?.status, "held");
    assert.equal(recovered[0]?.error, "NETWORK_ERROR");
    assert.deepEqual(release, [{ paymentId: held.id, status: "skipped" }]);
    assert.equal(context.paymentProvider.captureCalls, 0);
  });

  it("uses the configured stale threshold for both recovery and due releases", async () => {
    const context = await setup();
    const held = await beginAndAuthorize(context);
    const claimedAt = new Date("2026-11-12T10:01:00.000Z");
    await context.persistence.payments.claimAction(
      held.id,
      "held",
      "release",
      claimedAt.toISOString(),
      claimedAt.toISOString(),
    );
    const beforeStale = new Date("2026-11-12T10:04:00.000Z");

    assert.deepEqual(
      await context.orchestrator.recoverStaleReleases(beforeStale, 300),
      [],
    );
    assert.deepEqual(
      await context.orchestrator.releaseDue(beforeStale, 300),
      [{ paymentId: held.id, status: "skipped" }],
    );
    assert.equal(context.paymentProvider.captureCalls, 0);

    const afterStale = new Date("2026-11-12T10:07:00.000Z");
    assert.deepEqual(
      await context.orchestrator.recoverStaleReleases(afterStale, 300),
      [{ paymentId: held.id, status: "held" }],
    );
    assert.deepEqual(
      await context.orchestrator.releaseDue(afterStale, 300),
      [{ paymentId: held.id, status: "captured" }],
    );
  });

  it("keeps a held payment reserved when PayPal reports capture pending", async () => {
    const context = await setup();
    const held = await beginAndAuthorize(context);
    context.paymentProvider.pendingCapture = true;

    const [result] = await context.orchestrator.releaseDue(
      new Date("2026-11-12T10:01:00.000Z"),
    );

    assert.deepEqual(result, {
      paymentId: held.id,
      status: "skipped",
      error: "CAPTURE_PENDING",
    });
    assert.equal(
      (await context.persistence.payments.getById(held.id))?.status,
      "held",
    );
    assert.equal(
      (await context.persistence.mandates.getById(context.mandate.id))
        ?.reserved_total,
      held.amount,
    );
  });

  it("does not fail a payment when the capture outcome is uncertain", async () => {
    const context = await setup();
    const held = await beginAndAuthorize(context);
    context.paymentProvider.uncertainCapture = true;

    const [result] = await context.orchestrator.releaseDue(
      new Date("2026-11-12T10:01:00.000Z"),
    );

    assert.deepEqual(result, {
      paymentId: held.id,
      status: "skipped",
      error: "CAPTURE_RECOVERY_PENDING",
    });
    assert.equal(
      (await context.persistence.payments.getById(held.id))?.status,
      "held",
    );
    assert.equal(
      (await context.persistence.mandates.getById(context.mandate.id))
        ?.reserved_total,
      held.amount,
    );
  });

  it("releases the reserved budget when a provider call fails", async () => {
    const context = await setup();
    context.paymentProvider.failCreate = true;

    await assert.rejects(
      context.orchestrator.requestPayment(request(context.mandate.id)),
      (error: unknown) =>
        error instanceof OrchestratorError && error.code === "ERROR",
    );
    const payments = await context.persistence.payments.listAll();
    const mandate = await context.persistence.mandates.getById(context.mandate.id);
    assert.equal(payments[0]?.status, "failed");
    assert.equal(mandate?.reserved_total, 0);
  });

  it("validates mandate HMAC signatures and signs revocation", async () => {
    const context = await setup();
    assert.equal(
      verifyMandateSignature(context.mandate, signingSecret),
      true,
    );
    assert.equal(
      verifyMandateSignature(
        {
          ...context.mandate,
          expires_at: context.mandate.expires_at.replace(/Z$/, "+00:00"),
        },
        signingSecret,
      ),
      true,
    );
    const revoked = await context.orchestrator.revokeMandate(context.mandate.id);

    assert.equal(revoked.status, "revoked");
    assert.notEqual(revoked.signature, context.mandate.signature);
    assert.equal(verifyMandateSignature(revoked, signingSecret), true);
  });

  it("preserves reserved budget when revoking a mandate", async () => {
    const context = await setup();
    await context.orchestrator.requestPayment(request(context.mandate.id));

    const revoked = await context.orchestrator.revokeMandate(context.mandate.id);

    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.reserved_total, 3000);
    assert.equal(
      (await context.persistence.mandates.getById(context.mandate.id))
        ?.reserved_total,
      3000,
    );
  });
});
