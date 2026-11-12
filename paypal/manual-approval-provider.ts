import { z } from "zod";
import type { PaymentProvider } from "./payment-provider.ts";
import {
  PayPalProviderError,
  type ApprovalOrder,
  type ApprovalProvider,
  type ApprovalReady,
} from "./payment-provider.ts";

const settingsSchema = z
  .object({
    timeoutMs: z.number().int().positive().default(5 * 60 * 1000),
    intervalMs: z.number().int().positive().default(2_000),
  })
  .strict()
  .refine((settings) => settings.intervalMs <= settings.timeoutMs, {
    message: "intervalMs must not exceed timeoutMs",
  });

function isSandboxApprovalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      ["sandbox.paypal.com", "www.sandbox.paypal.com"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

const approvalUrlSchema = z.string().url().refine(isSandboxApprovalUrl);

interface ManualApprovalOptions {
  timeoutMs?: number;
  intervalMs?: number;
  print?: (message: string) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export class ManualApprovalProvider implements ApprovalProvider {
  private readonly paymentProvider: PaymentProvider;
  private readonly timeoutMs: number;
  private readonly intervalMs: number;
  private readonly print: (message: string) => void;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    paymentProvider: PaymentProvider,
    options: ManualApprovalOptions = {},
  ) {
    this.paymentProvider = paymentProvider;
    const settings = settingsSchema.parse({
      timeoutMs: options.timeoutMs,
      intervalMs: options.intervalMs,
    });
    this.timeoutMs = settings.timeoutMs;
    this.intervalMs = settings.intervalMs;
    this.print = options.print ?? console.log;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? Date.now;
  }

  async approve(order: ApprovalOrder): Promise<ApprovalReady> {
    const parsedOrder = z
      .object({
        paymentId: z.string().min(1).max(256),
        paypalOrderId: z.string().min(1).max(256),
        approvalUrl: approvalUrlSchema,
      })
      .strict()
      .safeParse(order);
    if (!parsedOrder.success) {
      throw new PayPalProviderError("INVALID_APPROVAL_ORDER", "manualApproval");
    }
    this.print(`Approve this PayPal Sandbox order: ${parsedOrder.data.approvalUrl}`);
    const deadline = this.now() + this.timeoutMs;
    while (true) {
      const snapshot = await this.paymentProvider.getOrder(
        parsedOrder.data.paymentId,
        parsedOrder.data.paypalOrderId,
      );
      if (snapshot.status === "APPROVED") {
        return {
          paymentId: parsedOrder.data.paymentId,
          paypalOrderId: snapshot.paypalOrderId,
          status: "APPROVED",
        };
      }
      if (
        snapshot.status === "VOIDED" ||
        snapshot.status === "COMPLETED"
      ) {
        throw new PayPalProviderError(
          "ORDER_NOT_APPROVABLE",
          "manualApproval",
        );
      }
      const remainingMs = deadline - this.now();
      if (remainingMs <= 0) {
        throw new PayPalProviderError("APPROVAL_TIMEOUT", "manualApproval");
      }
      await this.sleep(Math.min(this.intervalMs, remainingMs));
    }
  }
}
