import "dotenv/config";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ManualApprovalProvider } from "../paypal/manual-approval-provider.ts";
import {
  PayPalProviderError,
  type CreateOrderInput,
} from "../paypal/payment-provider.ts";
import { SandboxPaymentProvider } from "../paypal/sandbox-payment-provider.ts";

const commandSchema = z
  .object({
    payeeEmail: z.string().email(),
    amountCents: z.number().int().positive().safe().default(5000),
    timeoutMs: z.number().int().positive().default(5 * 60 * 1000),
    intervalMs: z.number().int().positive().default(2_000),
  })
  .strict()
  .refine((value) => value.intervalMs <= value.timeoutMs, {
    message: "poll interval must not exceed the approval timeout",
  });

function parseCommand(args: string[]): z.infer<typeof commandSchema> {
  const options = new Map<string, string>();
  const allowedOptions = new Set([
    "--payee-email",
    "--amount-cents",
    "--timeout-ms",
    "--interval-ms",
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined || options.has(key)) {
      throw new Error("INVALID_COMMAND");
    }
    if (!allowedOptions.has(key)) {
      throw new Error("INVALID_COMMAND");
    }
    options.set(key, value);
  }
  return commandSchema.parse({
    payeeEmail:
      options.get("--payee-email") ?? process.env.PAYPAL_SMOKE_PAYEE_EMAIL,
    amountCents: options.has("--amount-cents")
      ? Number(options.get("--amount-cents"))
      : undefined,
    timeoutMs: options.has("--timeout-ms")
      ? Number(options.get("--timeout-ms"))
      : undefined,
    intervalMs: options.has("--interval-ms")
      ? Number(options.get("--interval-ms"))
      : undefined,
  });
}

function makeInput(
  payeeEmail: string,
  amountCents: number,
  flow: "refund" | "void",
): CreateOrderInput {
  const paymentId = randomUUID();
  return {
    paymentId,
    payeeEmail,
    amountCents,
    currency: "USD",
    invoiceId: `rewind-${flow}-${paymentId}`,
  };
}

async function runRefundFlow(
  input: CreateOrderInput,
  provider: SandboxPaymentProvider,
  approval: ManualApprovalProvider,
): Promise<void> {
  console.log("Refund flow: creating AUTHORIZE order.");
  const order = await provider.createOrder(input);
  console.log(`Refund flow: order ${order.paypalOrderId} created.`);
  await approval.approve({
    paymentId: order.paymentId,
    paypalOrderId: order.paypalOrderId,
    approvalUrl: order.approvalUrl,
  });

  const authorization = await provider.authorizeOrder(
    input.paymentId,
    order.paypalOrderId,
  );
  if (
    authorization.status !== "CREATED" &&
    authorization.status !== "PENDING"
  ) {
    throw new PayPalProviderError("AUTHORIZATION_NOT_READY", "smokeTest");
  }
  if (
    authorization.amountCents !== input.amountCents ||
    authorization.currency !== input.currency
  ) {
    throw new PayPalProviderError("AUTHORIZATION_MISMATCH", "smokeTest");
  }
  const orderReadback = await provider.getOrder(
    input.paymentId,
    order.paypalOrderId,
  );
  if (
    orderReadback.observedPayment.payee_email.toLowerCase() !==
      input.payeeEmail.toLowerCase() ||
    orderReadback.observedPayment.amount !== input.amountCents ||
    orderReadback.observedPayment.currency !== input.currency ||
    orderReadback.observedPayment.invoice_id !== input.invoiceId ||
    orderReadback.observedPayment.authorization_id !==
      authorization.authorizationId
  ) {
    throw new PayPalProviderError("ORDER_READBACK_MISMATCH", "smokeTest");
  }
  console.log("Refund flow: authorization and PayPal order readback verified.");

  const capture = await provider.captureAuthorization(
    input.paymentId,
    authorization.authorizationId,
  );
  if (capture.status !== "COMPLETED") {
    throw new PayPalProviderError("CAPTURE_NOT_COMPLETED", "smokeTest");
  }
  const refund = await provider.refundCapture(input.paymentId, capture.captureId);
  if (refund.status !== "COMPLETED" && refund.status !== "PENDING") {
    throw new PayPalProviderError("REFUND_NOT_ACCEPTED", "smokeTest");
  }
  console.log(`Refund flow: capture completed; refund status=${refund.status}.`);
}

async function runVoidFlow(
  input: CreateOrderInput,
  provider: SandboxPaymentProvider,
  approval: ManualApprovalProvider,
): Promise<void> {
  console.log("Void flow: creating AUTHORIZE order.");
  const order = await provider.createOrder(input);
  console.log(`Void flow: order ${order.paypalOrderId} created.`);
  await approval.approve({
    paymentId: order.paymentId,
    paypalOrderId: order.paypalOrderId,
    approvalUrl: order.approvalUrl,
  });

  const authorization = await provider.authorizeOrder(
    input.paymentId,
    order.paypalOrderId,
  );
  const voidedAuthorization = await provider.voidAuthorization(
    input.paymentId,
    authorization.authorizationId,
  );
  if (voidedAuthorization.status !== "VOIDED") {
    throw new PayPalProviderError("VOID_NOT_VERIFIED", "smokeTest");
  }
  console.log("Void flow: authorization GET confirmed VOIDED.");
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv.slice(2));
  const provider = new SandboxPaymentProvider();
  const approval = new ManualApprovalProvider(provider, {
    timeoutMs: command.timeoutMs,
    intervalMs: command.intervalMs,
  });

  await runRefundFlow(
    makeInput(command.payeeEmail, command.amountCents, "refund"),
    provider,
    approval,
  );
  await runVoidFlow(
    makeInput(command.payeeEmail, command.amountCents, "void"),
    provider,
    approval,
  );
  console.log("PayPal Sandbox smoke test passed.");
}

main().catch((error: unknown) => {
  if (error instanceof PayPalProviderError) {
    console.error(`PayPal Sandbox smoke test failed: ${error.message}`);
  } else if (error instanceof z.ZodError) {
    console.error("Invalid smoke-test configuration. Check email and numeric options.");
  } else {
    console.error("PayPal Sandbox smoke test failed (unexpected error).");
  }
  process.exitCode = 1;
});
