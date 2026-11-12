import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { rewindApi } from "../../components/rewind/api.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("REWIND dashboard API client", () => {
  it("normalizes list responses with decisions returned as an array", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      payments: [{
        id: "payment-1",
        mandate_id: "mandate-1",
        status: "requested",
        amount: 8000,
        payee_email: "sandbox@example.com",
        invoice_id: "invoice-1",
        created_at: "2026-11-12T19:33:27.940Z",
        decisions: [
          {
            rule: "R1",
            phase: "preflight",
            passed: true,
            expected: { payee_email: "sandbox@example.com" },
            actual: { payee_email: "sandbox@example.com" },
          },
          {
            rule: "R5",
            phase: "preflight",
            passed: true,
            expected: { status: "checked after authorization" },
            actual: { status: "deferred_no_paypal_ids_yet" },
          },
        ],
      }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    const [payment] = await rewindApi.listPayments();

    assert.equal(payment?.id, "payment-1");
    assert.deepEqual(payment?.decisions.map(({ rule }) => rule), ["R1", "R5"]);
    assert.equal(payment?.decisions[1]?.phase, "preflight");
  });
});
