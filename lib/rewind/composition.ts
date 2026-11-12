import { PaymentOrchestrator, randomIdGenerator, systemClock } from "../../orchestrator/service.ts";
import { createSupabasePersistence } from "../../persistence/supabase.ts";
import { ManualApprovalProvider } from "../../paypal/manual-approval-provider.ts";
import { KernelApprovalProvider } from "../../paypal/kernel-approval-provider.ts";
import type { ApprovalProvider } from "../../paypal/payment-provider.ts";
import { SandboxPaymentProvider } from "../../paypal/sandbox-payment-provider.ts";
import { createWebhookNotifier } from "../../notifications/notifier.ts";
import {
  createRewindHandlers,
  createUnavailableRewindHandlers,
} from "./http-handlers.ts";

type RewindHandlers = ReturnType<typeof createRewindHandlers>;
let handlers: RewindHandlers | undefined;
let orchestrator: PaymentOrchestrator | undefined;

export function getRewindOrchestrator(): PaymentOrchestrator {
  if (!orchestrator) {
    const persistence = createSupabasePersistence();
    const paymentProvider = new SandboxPaymentProvider();
    const approvalProviderName = process.env.APPROVAL_PROVIDER ??
      (process.env.KERNEL_API_KEY ? "kernel" : "manual");
    const fallbackManual = process.env.APPROVAL_FALLBACK_MANUAL !== "false";
    if (approvalProviderName !== "manual" && approvalProviderName !== "kernel") {
      throw new Error("APPROVAL_PROVIDER must be manual or kernel");
    }
    const manualApproval = new ManualApprovalProvider(paymentProvider);
    const kernelConfigured = [
      process.env.KERNEL_API_KEY,
      process.env.KERNEL_PROFILE_NAME,
      process.env.SANDBOX_BUYER_EMAIL,
      process.env.SANDBOX_BUYER_PASSWORD,
    ].every((value) => Boolean(value?.trim()));
    let approvalProvider: ApprovalProvider = manualApproval;
    if (approvalProviderName === "kernel") {
      if (kernelConfigured) {
        approvalProvider = new KernelApprovalProvider(paymentProvider, {
          fallbackManual,
          manualApproval,
        });
      } else if (!fallbackManual) {
        throw new Error("Kernel approval is not configured and manual fallback is disabled");
      } else {
        console.warn("REWIND_APPROVAL_FALLBACK", {
          code: "KERNEL_NOT_CONFIGURED",
          provider: "manual",
        });
      }
    }
    orchestrator = new PaymentOrchestrator({
      mandates: persistence.mandates,
      payments: persistence.payments,
      decisions: persistence.decisions,
      events: persistence.events,
      paymentProvider,
      approvalProvider,
      clock: systemClock,
      ids: randomIdGenerator,
      notifier: createWebhookNotifier(),
    });
  }
  return orchestrator;
}

export function getRewindHandlers(): RewindHandlers {
  if (!handlers) {
    try {
      handlers = createRewindHandlers(getRewindOrchestrator());
    } catch (error) {
      handlers = createUnavailableRewindHandlers(error);
    }
  }
  return handlers;
}
