import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createAgentHandler,
  type AgentRequestInput,
} from "../../lib/rewind/agent-handler.ts";

const requestInput: AgentRequestInput = {
  mandateId: "00000000-0000-4000-8000-000000000001",
  payeeEmail: "payee@example.com",
  amountCents: 250,
  invoiceId: "agent-invoice-1",
};

describe("REWIND agent handler", () => {
  it("invokes the agent with validated payment details and request origin", async () => {
    let instruction = "";
    let apiBaseUrl = "";
    let expectedPayment: AgentRequestInput | undefined;
    const handler = createAgentHandler(async (prompt, baseUrl, expected) => {
      instruction = prompt;
      apiBaseUrl = baseUrl;
      expectedPayment = expected;
      return {
        message: "Payment request submitted.",
        action: {
          tool: "request_payment",
          success: true,
          paymentId: "00000000-0000-4000-8000-000000000002",
          status: "requested",
          approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=private",
        },
      };
    });

    const response = await handler(new Request("https://rewind.example/api/rewind/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestInput),
    }));

    assert.equal(response.status, 200);
    assert.equal(apiBaseUrl, "https://rewind.example");
    assert.match(instruction, /Call request_payment now/);
    assert.match(instruction, new RegExp(requestInput.mandateId));
    assert.deepEqual(expectedPayment, requestInput);
    assert.equal((await response.json()).action.status, "requested");
  });

  it("rejects fractional cents before invoking the agent", async () => {
    let invoked = false;
    const handler = createAgentHandler(async () => {
      invoked = true;
      return { message: "", action: null };
    });
    const response = await handler(new Request("http://localhost/api/rewind/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...requestInput, amountCents: 2.5 }),
    }));

    assert.equal(response.status, 422);
    assert.equal(invoked, false);
    assert.deepEqual(await response.json(), {
      error: {
        code: "VALIDATION_ERROR",
        message: "Provide a mandate, payee, positive integer cents amount, and invoice ID.",
      },
    });
  });

  it("does not expose agent/provider exception details", async () => {
    const handler = createAgentHandler(async () => {
      throw new Error("private provider response");
    });
    const response = await handler(new Request("http://localhost/api/rewind/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestInput),
    }));

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      error: {
        code: "AGENT_FAILED",
        message: "The agent could not complete this request. Check server logs and try again.",
      },
    });
  });
});
