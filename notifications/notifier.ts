import { z } from "zod";
import type { Payment } from "../domain/payment.ts";

export type PaymentNotificationType =
  | "held"
  | "rejected"
  | "captured"
  | "voided"
  | "refunded";

export interface PaymentNotification {
  type: PaymentNotificationType;
  payment: Pick<
    Payment,
    | "id"
    | "status"
    | "payee_email"
    | "amount"
    | "currency"
    | "invoice_id"
    | "release_at"
  >;
  failedRules?: string[];
}

export interface Notifier {
  notify(notification: PaymentNotification): Promise<void>;
}

export interface NotifierOptions {
  webhookUrl?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  logError?: (code: string, type: PaymentNotificationType) => void;
}

export function createWebhookNotifier(options: NotifierOptions = {}): Notifier {
  const url = options.webhookUrl ?? process.env.ZAPIER_WEBHOOK_URL;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 5000;
  const logError = options.logError ?? ((code, type) => {
    console.error("REWIND_NOTIFIER_ERROR", { code, type });
  });

  if (!url) {
    return { notify: async () => {} };
  }
  const validatedUrl = z.string().url().parse(url);
  if (new URL(validatedUrl).protocol !== "https:") {
    throw new Error("ZAPIER_WEBHOOK_URL must use HTTPS.");
  }
  const validatedTimeout = z.number().int().positive().max(30000).parse(timeoutMs);

  return {
    notify: async (notification) => {
      const body = {
        event: notification.type,
        payment: {
          id: notification.payment.id,
          status: notification.payment.status,
          payee: notification.payment.payee_email,
          amount_cents: notification.payment.amount,
          currency: notification.payment.currency,
          invoice_id: notification.payment.invoice_id,
          release_at: notification.payment.release_at,
        },
        ...(notification.failedRules
          ? { failed_rules: notification.failedRules }
          : {}),
      };
      try {
        const response = await fetchImpl(validatedUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(validatedTimeout),
        });
        if (!response.ok) {
          logError(`HTTP_${response.status}`, notification.type);
        }
      } catch {
        logError("DELIVERY_FAILED", notification.type);
      }
    },
  };
}
