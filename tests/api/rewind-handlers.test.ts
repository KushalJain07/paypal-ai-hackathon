import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type {
  Decision,
  Mandate,
  Payment,
} from "../../domain/index.ts";
import type {
  PaymentDetail,
  PaymentRequestResult,
  ReleaseResult,
} from "../../orchestrator/ports.ts";
import { OrchestratorError } from "../../orchestrator/service.ts";
import { PayPalProviderError } from "../../paypal/payment-provider.ts";
import type { DecisionRecord, PaymentEvent } from "../../persistence/schemas.ts";
import {
  createRewindHandlers,
  type RewindHttpOrchestrator,
} from "../../lib/rewind/http-handlers.ts";

const mandateId = "00000000-0000-4000-8000-000000000001";
const paymentId = "00000000-0000-4000-8000-000000000002";
const createdAt = "2026-11-12T10:00:00.000Z";

const mandate: Mandate = {
  id: mandateId,
  version: 1,
  payee_email: "payee@example.com",
  per_payment_cap: 10_000,
  total_cap: 20_000,
  spent_total: 0,
  reserved_total: 500,
  currency: "USD",
  purpose: "route tests",
  expires_at: "2026-12-20T00:00:00.000Z",
  undo_window_seconds: 60,
  status: "active",
  signature: "signature-not-returned",
  hash: "hash-not-returned",
  created_at: createdAt,
};

const payment: Payment = {
  id: paymentId,
  mandate_id: mandateId,
  invoice_id: "invoice-1",
  amount: 500,
  currency: "USD",
  payee_email: "payee@example.com",
  approval_url: "https://www.sandbox.paypal.com/checkoutnow?token=private",
  paypal_order_id: "ORDER-123",
  authorization_id: "AUTH-123",
  capture_id: null,
  status: "requested",
  release_at: null,
  failure_reason: null,
  created_at: createdAt,
  updated_at: createdAt,
};

function guardianDecision(
  phase: "preflight" | "authorized",
  passed = true,
): Decision {
  return {
    phase,
    passed,
    results: [
      { rule: "R1", passed: true, expected: { payee: "payee@example.com" }, actual: { payee: "payee@example.com" } },
      { rule: "R2", passed: true, expected: { amount_cents: 500 }, actual: { amount_cents: 500 } },
      { rule: "R3", passed: true, expected: { invoice_id: "invoice-1" }, actual: { invoice_id: "invoice-1" } },
      { rule: "R4", passed: true, expected: { mandate_status: "active" }, actual: { mandate_status: "active" } },
      {
        rule: "R5",
        passed: true,
        expected: phase === "preflight"
          ? { status: "checked after authorization" }
          : { status: "authorized" },
        actual: phase === "preflight"
          ? { status: "deferred_no_paypal_ids_yet" }
          : { status: "authorized" },
      },
    ],
  };
}

function decisionRows(phase: "preflight" | "authorized"): DecisionRecord[] {
  return guardianDecision(phase).results.map((result, index) => ({
    id: index + 1 + (phase === "authorized" ? 10 : 0),
    payment_id: paymentId,
    phase,
    rule: result.rule,
    passed: result.passed,
    expected: result.expected,
    actual: result.actual,
    created_at: createdAt,
  }));
}

const events: PaymentEvent[] = [{
  id: 1,
  payment_id: paymentId,
  type: "payment_requested",
  from_status: null,
  to_status: "requested",
  detail: { invoice_id: "invoice-1" },
  created_at: createdAt,
}];

class FakeOrchestrator implements RewindHttpOrchestrator {
  nextRequestResult: PaymentRequestResult = {
    payment,
    decision: guardianDecision("preflight"),
    approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=private",
  };
  detail: PaymentDetail = {
    payment,
    decisions: decisionRows("preflight"),
    events,
  };
  error: unknown;

  async listMandates(): Promise<Mandate[]> {
    this.throwIfConfigured();
    return [mandate];
  }

  async createMandate(): Promise<Mandate> {
    this.throwIfConfigured();
    return mandate;
  }

  async revokeMandate(): Promise<Mandate> {
    this.throwIfConfigured();
    return { ...mandate, status: "revoked" };
  }

  async requestPayment(): Promise<PaymentRequestResult> {
    this.throwIfConfigured();
    return this.nextRequestResult;
  }

  async completeAuthorization(): Promise<Payment> {
    this.throwIfConfigured();
    return payment;
  }

  async listPayments(): Promise<Payment[]> {
    this.throwIfConfigured();
    return [payment];
  }

  async getPaymentDetail(): Promise<PaymentDetail> {
    this.throwIfConfigured();
    return this.detail;
  }

  async undo(): Promise<Payment> {
    this.throwIfConfigured();
    return { ...payment, status: "voided" };
  }

  async refund(): Promise<Payment> {
    this.throwIfConfigured();
    return { ...payment, status: "refunded" };
  }

  async releaseDue(): Promise<ReleaseResult[]> {
    this.throwIfConfigured();
    return [{ paymentId, status: "captured" }];
  }

  async recoverStaleReleases() {
    this.throwIfConfigured();
    return [];
  }

  private throwIfConfigured(): void {
    if (this.error) {
      throw this.error;
    }
  }
}

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/rewind", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("REWIND API handlers", () => {
  it("returns 422 with the standard error shape for invalid integer-cent input", async () => {
    const handlers = createRewindHandlers(new FakeOrchestrator());
    const response = await handlers.postPaymentRequest(jsonRequest({
      mandateId,
      payeeEmail: "payee@example.com",
      amountCents: 5.25,
      invoiceId: "invoice-1",
    }));

    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), {
      error: { code: "VALIDATION_ERROR", message: "Request validation failed." },
    });
  });

  it("returns Guardian rejection as HTTP 200 with all five rule results", async () => {
    const fake = new FakeOrchestrator();
    fake.nextRequestResult = {
      payment: { ...payment, status: "rejected", failure_reason: "GUARDIAN_PREFLIGHT_REJECTED" },
      decision: {
        ...guardianDecision("preflight", false),
        results: guardianDecision("preflight").results.map((result) =>
          result.rule === "R1" ? { ...result, passed: false } : result
        ),
      },
      approvalUrl: null,
    };
    const handlers = createRewindHandlers(fake);
    const response = await handlers.postPaymentRequest(jsonRequest({
      mandateId,
      payeeEmail: "wrong@example.com",
      amountCents: 500,
      invoiceId: "invoice-1",
    }));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.payment.status, "rejected");
    assert.equal(body.decision.phase, "preflight");
    assert.equal(body.decision.results.length, 5);
    assert.deepEqual(body.decision.results[4], {
      rule: "R5",
      passed: true,
      expected: { status: "checked after authorization" },
      actual: { status: "deferred_no_paypal_ids_yet" },
    });
    assert.equal("approval_url" in body.payment, false);
    assert.equal("signature" in body.payment, false);
  });

  it("returns the Sandbox approval link for a requested payment", async () => {
    const handlers = createRewindHandlers(new FakeOrchestrator());
    const response = await handlers.postPaymentRequest(jsonRequest({
      mandateId,
      payeeEmail: "payee@example.com",
      amountCents: 500,
      invoiceId: "invoice-1",
    }));
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.equal(
      body.payment.approval_url,
      "https://www.sandbox.paypal.com/checkoutnow?token=private",
    );
  });

  it("includes the latest R1-R5 phase results in the payment list", async () => {
    const fake = new FakeOrchestrator();
    fake.detail = {
      ...fake.detail,
      decisions: [...decisionRows("preflight"), ...decisionRows("authorized")],
    };
    const response = await createRewindHandlers(fake).getPayments();
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.payments[0].status, "requested");
    assert.equal(body.payments[0].amount, 500);
    assert.equal(body.payments[0].payee_email, "payee@example.com");
    assert.equal(body.payments[0].invoice_id, "invoice-1");
    assert.equal(body.payments[0].decisions.length, 5);
    assert.ok(body.payments[0].decisions.every(
      (entry: { phase: string }) => entry.phase === "authorized",
    ));
  });

  it("reports the service health and number of held payments", async () => {
    const fake = new FakeOrchestrator();
    fake.listPayments = async () => [
      { ...payment, status: "held" },
      { ...payment, id: "00000000-0000-4000-8000-000000000003", status: "captured" },
    ];
    const response = await createRewindHandlers(fake).getHealth();

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      pendingHeldCount: 1,
    });
  });

  it("maps missing state and provider errors to 404, 409, and 502", async () => {
    const fake = new FakeOrchestrator();
    const handlers = createRewindHandlers(fake);

    fake.error = new OrchestratorError("PAYMENT_NOT_FOUND", "Payment not found.");
    assert.equal((await handlers.getPayment(paymentId)).status, 404);
    fake.error = new OrchestratorError("PAYMENT_STATUS_CONFLICT", "Invalid state.");
    assert.equal((await handlers.getPayment(paymentId)).status, 409);
    fake.error = new PayPalProviderError("NETWORK_ERROR", "getOrder");
    assert.equal((await handlers.getPayment(paymentId)).status, 502);
  });

  it("returns payment detail with phase decisions and events", async () => {
    const response = await createRewindHandlers(new FakeOrchestrator())
      .getPayment(paymentId);
    const body = await response.json();

    assert.equal(body.payment.id, paymentId);
    assert.equal(body.decisions[0].phase, "preflight");
    assert.equal(body.events.length, 1);
    assert.equal("approval_url" in body.payment, false);
  });
});

describe("FR-A4 agent source boundary", () => {
  it("keeps the src code path free of direct PayPal adapters and privileged operations", async () => {
    const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));
    const sourceFiles = await listSourceFiles(sourceRoot);
    const source = (await Promise.all(sourceFiles.map((file) => readFile(file, "utf8"))))
      .join("\n");

    assert.doesNotMatch(
      source,
      /\bfrom\s*["'][^"']*(?:paypal|PaymentProvider|sandbox-payment-provider)[^"']*["']/i,
    );
    assert.doesNotMatch(
      source,
      /\b(?:captureAuthorization|voidAuthorization|refundCapture|authorizeOrder|undoPayment|captureOrder)\b/,
    );

    const agent = await readFile(
      new URL("../../src/agent/payment-agent.ts", import.meta.url),
      "utf8",
    );
    assert.equal((agent.match(/\btool\s*\(/g) ?? []).length, 2);
    assert.match(agent, /name:\s*"request_payment"/);
    assert.match(agent, /name:\s*"get_payment_status"/);
  });
});

async function listSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      return listSourceFiles(path);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  }));
  return nested.flat();
}
