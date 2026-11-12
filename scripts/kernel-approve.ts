import "dotenv/config";

import { randomUUID } from "node:crypto";
import { KernelApprovalProvider } from "../paypal/kernel-approval-provider.ts";
import { PayPalProviderError } from "../paypal/payment-provider.ts";
import { SandboxPaymentProvider } from "../paypal/sandbox-payment-provider.ts";

async function main(): Promise<void> {
  const payeeEmail = process.env.PAYPAL_SMOKE_PAYEE_EMAIL;
  if (!payeeEmail) throw new Error("Missing PAYPAL_SMOKE_PAYEE_EMAIL");
  const provider = new SandboxPaymentProvider();
  const paymentId = randomUUID();
  const order = await provider.createOrder({
    paymentId,
    payeeEmail,
    amountCents: 500,
    currency: "USD",
    invoiceId: `rewind-kernel-${paymentId}`,
  });
  const approval = new KernelApprovalProvider(provider);
  await approval.approve({
    paymentId: order.paymentId,
    paypalOrderId: order.paypalOrderId,
    approvalUrl: order.approvalUrl,
  });
  const result = await provider.getOrder(order.paymentId, order.paypalOrderId);
  const passed = result.status === "APPROVED";
  console.log(`Kernel approval ${passed ? "PASS" : "FAIL"}: resulting order status=${result.status}`);
  if (!passed) process.exitCode = 1;
}

try {
  await main();
} catch (error: unknown) {
  if (error instanceof PayPalProviderError) {
    console.error(`Kernel approval FAIL: ${error.message}`);
  } else {
    console.error("Kernel approval FAIL: invalid configuration or unexpected error.");
  }
  process.exitCode = 1;
}
