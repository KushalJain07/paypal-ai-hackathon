import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWebhookNotifier } from "../../notifications/notifier.ts";

const notification = {
  type: "held" as const,
  payment: {
    id: "payment-1",
    status: "held" as const,
    payee_email: "payee@example.com",
    amount: 1250,
    currency: "USD" as const,
    invoice_id: "invoice-1",
    release_at: "2026-11-12T10:01:00.000Z",
  },
};

describe("webhook notifier", () => {
  it("sends a safe payment summary and does not include credentials", async () => {
    let sentUrl = "";
    let sentBody = "";
    const notifier = createWebhookNotifier({
      webhookUrl: "https://hooks.example.com/rewind",
      fetch: async (input, init) => {
        sentUrl = String(input);
        sentBody = String(init?.body);
        return new Response(null, { status: 200 });
      },
    });

    await notifier.notify(notification);

    assert.equal(sentUrl, "https://hooks.example.com/rewind");
    assert.deepEqual(JSON.parse(sentBody), {
      event: "held",
      payment: {
        id: "payment-1",
        status: "held",
        payee: "payee@example.com",
        amount_cents: 1250,
        currency: "USD",
        invoice_id: "invoice-1",
        release_at: "2026-11-12T10:01:00.000Z",
      },
    });
    assert.equal(sentBody.includes("authorization_id"), false);
    assert.equal(sentBody.includes("SUPABASE"), false);
  });

  it("swallows delivery failures and logs only a safe code and event type", async () => {
    const logged: Array<[string, string]> = [];
    const notifier = createWebhookNotifier({
      webhookUrl: "https://hooks.example.com/rewind",
      fetch: async () => {
        throw new Error("sensitive transport details");
      },
      logError: (code, type) => logged.push([code, type]),
    });

    await assert.doesNotReject(notifier.notify(notification));
    assert.deepEqual(logged, [["DELIVERY_FAILED", "held"]]);
  });

  it("is a no-op without a webhook URL", async () => {
    const notifier = createWebhookNotifier({ webhookUrl: "" });
    await assert.doesNotReject(notifier.notify(notification));
  });
});
