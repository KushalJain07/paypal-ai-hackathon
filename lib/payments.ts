import { randomBytes, randomUUID } from "node:crypto";

export type PaymentStatus = "pending" | "sending" | "sent" | "failed" | "cancelled";
export type Payment = {
  id: string;
  recipient: string;
  amount: string;
  note: string;
  undoMinutes: number;
  status: PaymentStatus;
  createdAt: number;
  executeAt: number;
  error?: string;
  batchId?: string;
};

type StoredPayment = Payment & { timer?: ReturnType<typeof setTimeout> };
type PaymentStore = { payments: Map<string, StoredPayment> };
const globalForPayments = globalThis as typeof globalThis & { paymentStore?: PaymentStore };
const store = (globalForPayments.paymentStore ??= { payments: new Map() });

export function publicPayment(payment: StoredPayment): Payment {
  return Object.fromEntries(Object.entries(payment).filter(([key]) => key !== "timer")) as Payment;
}

export function listPayments() {
  return [...store.payments.values()].map(publicPayment).sort((a, b) => b.createdAt - a.createdAt);
}

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Add your PayPal Sandbox credentials to .env.local.`);
  return value;
}

async function submitPayout(payment: StoredPayment) {
  if (payment.status !== "pending") return;
  payment.status = "sending";
  try {
    const clientId = requiredEnv("PAYPAL_CLIENT_ID");
    const clientSecret = requiredEnv("PAYPAL_CLIENT_SECRET");
    if (process.env.PAYPAL_AUTOMATION_ENABLED !== "true") {
      throw new Error("Set PAYPAL_AUTOMATION_ENABLED=true to enable Sandbox payouts.");
    }
    if (process.env.NODE_ENV === "production") {
      throw new Error("Automated payouts are disabled in production until authentication and durable storage are configured.");
    }

    const baseUrl = "https://api-m.sandbox.paypal.com";
    const authResponse = await fetch(`${baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const auth = await authResponse.json().catch(() => ({}));
    if (!authResponse.ok || typeof auth.access_token !== "string") {
      const code = typeof auth.error === "string" ? auth.error : "AUTHENTICATION_FAILED";
      const description = typeof auth.error_description === "string" ? auth.error_description.replace(/[\r\n]+/g, " ").slice(0, 180) : "Check the Sandbox app credentials.";
      throw new Error(`PayPal Sandbox authentication failed (${code}): ${description}`);
    }

    const payoutResponse = await fetch(`${baseUrl}/v1/payments/payouts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.access_token}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": payment.id,
      },
      body: JSON.stringify({
        sender_batch_header: {
          sender_batch_id: `pp${Date.now()}${randomBytes(4).toString("hex")}`,
          email_subject: "You have a payment",
          email_message: payment.note || "An agent sent you a payment.",
        },
        items: [{
          recipient_type: "EMAIL",
          amount: { value: payment.amount, currency: "USD" },
          receiver: payment.recipient,
          note: payment.note || "Agent initiated payment",
          sender_item_id: randomUUID(),
        }],
      }),
    });
    const result = await payoutResponse.json().catch(() => ({}));
    if (!payoutResponse.ok) {
      const detail = Array.isArray(result.details) ? result.details[0] : undefined;
      const code = typeof detail?.issue === "string"
        ? detail.issue
        : typeof result.name === "string" ? result.name : `HTTP_${payoutResponse.status}`;
      const message = typeof detail?.description === "string"
        ? detail.description
        : typeof result.message === "string" ? result.message : "Check that Payouts is enabled for this Sandbox app and that the sender account can make payouts.";
      const safeMessage = message.replace(/[\r\n]+/g, " ").slice(0, 180);
      const debugId = payoutResponse.headers.get("paypal-debug-id");
      if (code === "PAYOUT_NOT_AVAILABLE" || /country.{0,50}not allowed to send this payout/i.test(safeMessage)) {
        throw new Error(`PayPal Payouts cannot send from the country registered to this sender account. This is an account eligibility restriction; use a payout method supported for your business location.${debugId ? ` [debug ${debugId}]` : ""}`);
      }
      throw new Error(`PayPal Sandbox rejected payout (${code}): ${safeMessage}${debugId ? ` [debug ${debugId}]` : ""}`);
    }
    payment.batchId = result.batch_header?.payout_batch_id;
    payment.status = "sent";
  } catch (error) {
    payment.status = "failed";
    payment.error = error instanceof Error ? error.message : "Payout failed. Check PayPal Sandbox and try again.";
  }
}

export function schedulePayment(input: { recipient: string; amount: string; note: string; undoMinutes: number }) {
  const createdAt = Date.now();
  const undoWindowMs = input.undoMinutes * 60 * 1000;
  const payment: StoredPayment = {
    id: randomUUID(),
    ...input,
    status: "pending",
    createdAt,
    executeAt: createdAt + undoWindowMs,
  };
  payment.timer = setTimeout(() => void submitPayout(payment), undoWindowMs);
  store.payments.set(payment.id, payment);
  return publicPayment(payment);
}

export function cancelPayment(id: string) {
  const payment = store.payments.get(id);
  if (!payment) return { error: "Payment not found." } as const;
  if (payment.status !== "pending") return { error: "The undo window has closed. This payment can no longer be cancelled." } as const;
  if (payment.timer) clearTimeout(payment.timer);
  payment.status = "cancelled";
  return { payment: publicPayment(payment) } as const;
}
