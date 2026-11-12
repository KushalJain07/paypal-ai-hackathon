import "dotenv/config";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PaymentOrchestrator } from "../orchestrator/service.ts";
import { randomIdGenerator, systemClock } from "../orchestrator/service.ts";
import { createSupabasePersistence } from "../persistence/supabase.ts";
import { ManualApprovalProvider } from "../paypal/manual-approval-provider.ts";
import { SandboxPaymentProvider } from "../paypal/sandbox-payment-provider.ts";
interface DisplayDecision {
  phase: string;
  passed: boolean;
  results: Array<{
    rule: string;
    passed: boolean;
    expected: object;
    actual: object;
  }>;
}

const scenarioSchema = z.enum([
  "valid-capture",
  "undo",
  "refund",
  "wrong-payee",
  "over-cap",
  "reused-invoice",
  "expired-mandate",
]);
const configurationSchema = z.object({
  payeeEmail: z.string().email(),
  buyerPayeeEmail: z.string().email().optional(),
  approvalTimeoutMs: z.coerce.number().int().positive().default(5 * 60 * 1000),
  approvalIntervalMs: z.coerce.number().int().positive().default(2_000),
  mandateSigningSecret: z.string().min(32),
});

function parseArgs(args: string[]): {
  scenario: z.infer<typeof scenarioSchema>;
  options: Map<string, string>;
} {
  const scenario = scenarioSchema.parse(args[0]);
  const options = new Map<string, string>();
  const allowed = new Set([
    "--payee-email",
    "--buyer-payee-email",
    "--approval-timeout-ms",
    "--approval-interval-ms",
  ]);
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      !key?.startsWith("--") ||
      value === undefined ||
      !allowed.has(key) ||
      options.has(key)
    ) {
      throw new Error("INVALID_ARGUMENTS");
    }
    options.set(key, value);
  }
  return { scenario, options };
}

function printDecision(decision: DisplayDecision): void {
  console.log(`Guardian ${decision.phase} — ${decision.passed ? "PASS" : "REJECT"}`);
  console.log("| Rule | Passed | Expected | Actual |");
  console.log("|---|---:|---|---|");
  for (const result of decision.results) {
    console.log(
      `| ${result.rule} | ${result.passed ? "yes" : "no"} | ${JSON.stringify(result.expected)} | ${JSON.stringify(result.actual)} |`,
    );
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function createScenarioMandate(
  orchestrator: PaymentOrchestrator,
  payeeEmail: string,
  expiresAt: Date,
) {
  return orchestrator.createMandate({
    payee_email: payeeEmail,
    per_payment_cap: 10_000,
    total_cap: 20_000,
    currency: "USD",
    purpose: "REWIND S4 Sandbox end-to-end scenario",
    expires_at: expiresAt.toISOString(),
    undo_window_seconds: 10,
  });
}

async function main(): Promise<void> {
  const { scenario, options } = parseArgs(process.argv.slice(2));
  const configuration = configurationSchema.parse({
    payeeEmail: options.get("--payee-email") ?? process.env.PAYPAL_SMOKE_PAYEE_EMAIL,
    buyerPayeeEmail: options.get("--buyer-payee-email"),
    approvalTimeoutMs: options.get("--approval-timeout-ms"),
    approvalIntervalMs: options.get("--approval-interval-ms"),
    mandateSigningSecret: process.env.MANDATE_SIGNING_SECRET,
  });
  const persistence = createSupabasePersistence();
  const paymentProvider = new SandboxPaymentProvider();
  const approvalProvider = new ManualApprovalProvider(paymentProvider, {
    timeoutMs: configuration.approvalTimeoutMs,
    intervalMs: configuration.approvalIntervalMs,
  });
  const orchestrator = new PaymentOrchestrator({
    mandates: persistence.mandates,
    payments: persistence.payments,
    decisions: persistence.decisions,
    events: persistence.events,
    paymentProvider,
    approvalProvider,
    clock: systemClock,
    ids: randomIdGenerator,
    signingSecret: configuration.mandateSigningSecret,
  });
  const scenarioPayee =
    configuration.buyerPayeeEmail ?? configuration.payeeEmail;
  const expiresAt = new Date(Date.now() + (scenario === "expired-mandate" ? 5_000 : 24 * 60 * 60 * 1000));
  console.log(`Scenario: ${scenario}`);
  console.log("Creating signed Sandbox mandate.");
  const mandate = await createScenarioMandate(
    orchestrator,
    configuration.payeeEmail,
    expiresAt,
  );
  console.log(`Mandate created: ${mandate.id}`);

  if (scenario === "expired-mandate") {
    const waitMs = Math.max(0, Date.parse(mandate.expires_at) - Date.now() + 250);
    console.log(`Waiting ${waitMs}ms for mandate expiry.`);
    await sleep(waitMs);
  }

  if (scenario === "reused-invoice") {
    const invoiceId = `rewind-e2e-reused-${randomUUID()}`;
    console.log("Creating first request to establish the mandate-scoped invoice.");
    const first = await orchestrator.requestPayment({
      mandateId: mandate.id,
      payeeEmail: scenarioPayee,
      amountCents: 500,
      invoiceId,
    });
    printDecision(first.decision);
    console.log("Submitting a second request with the same invoice; it must be rejected before another PayPal order.");
    const duplicate = await orchestrator.requestPayment({
      mandateId: mandate.id,
      payeeEmail: scenarioPayee,
      amountCents: 500,
      invoiceId,
    });
    printDecision(duplicate.decision);
    console.log(`Duplicate request status: ${duplicate.payment.status}`);
    return;
  }

  if (
    scenario === "wrong-payee" ||
    scenario === "over-cap" ||
    scenario === "expired-mandate"
  ) {
    const result = await orchestrator.requestPayment({
      mandateId: mandate.id,
      payeeEmail:
        scenario === "wrong-payee"
          ? "attacker@example.invalid"
          : scenarioPayee,
      amountCents: scenario === "over-cap" ? 10_001 : 500,
      invoiceId: `rewind-e2e-${scenario}-${randomUUID()}`,
    });
    printDecision(result.decision);
    console.log(`Request status: ${result.payment.status}`);
    return;
  }

  const result = await orchestrator.requestPayment({
    mandateId: mandate.id,
    payeeEmail: scenarioPayee,
    amountCents: 500,
    invoiceId: `rewind-e2e-${scenario}-${randomUUID()}`,
  });
  printDecision(result.decision);
  if (result.payment.status !== "requested") {
    throw new Error("PREFLIGHT_REJECTED");
  }
  console.log(`Payment requested: ${result.payment.id}`);
  console.log("Continue authorization after manually approving the printed Sandbox link.");
  const held = await orchestrator.completeAuthorization(result.payment.id);
  const detail = await orchestrator.getPaymentDetail(held.id);
  const authorizedDecision: DisplayDecision = {
    phase: "authorized",
    passed: detail.decisions
      .filter((entry) => entry.phase === "authorized")
      .every((entry) => entry.passed),
    results: detail.decisions
      .filter((entry) => entry.phase === "authorized")
      .map(({ rule, passed, expected, actual }) => ({
        rule,
        passed,
        expected,
        actual,
      })),
  };
  printDecision(authorizedDecision);
  console.log(`Authorization complete: ${held.status}`);

  if (scenario === "undo") {
    const undone = await orchestrator.undo(held.id);
    console.log(`Undo complete: ${undone.status}`);
    return;
  }
  const releaseAt = held.release_at;
  if (!releaseAt) {
    throw new Error("RELEASE_TIME_MISSING");
  }
  const waitMs = Math.max(0, Date.parse(releaseAt) - Date.now());
  if (waitMs > 0) {
    console.log(`Waiting ${waitMs}ms for the undo window to expire.`);
    await sleep(waitMs);
  }
  const released = await orchestrator.releaseDue(new Date());
  console.log(`Release result: ${JSON.stringify(released)}`);
  if (scenario === "refund") {
    const refunded = await orchestrator.refund(held.id);
    console.log(`Refund complete: ${refunded.status}`);
  }
}

main().catch((error: unknown) => {
  const code =
    error && typeof error === "object" && "code" in error &&
    typeof error.code === "string"
      ? error.code
      : error instanceof z.ZodError
        ? "INVALID_CONFIGURATION"
        : "E2E_FAILED";
  console.error(`S4 Sandbox E2E stopped (${code}). Secrets and raw responses are not printed.`);
  process.exitCode = 1;
});
