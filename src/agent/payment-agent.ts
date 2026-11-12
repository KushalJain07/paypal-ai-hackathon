import { createAgent, tool } from "langchain";
import { ChatOpenRouter } from "@langchain/openrouter";
import { z } from "zod";

import { env, requireAgentConfiguration } from "../config/env.ts";
import {
  getPaymentStatus,
  RewindClientError,
  requestPayment,
} from "../api/rewind-client.ts";
import type { RequestPaymentInput } from "../api/rewind-client.ts";

export type PaymentAgentAction =
  | {
      tool: "request_payment";
      success: true;
      paymentId: string;
      status: string;
      approvalUrl: string | null;
    }
  | {
      tool: "request_payment" | "get_payment_status";
      success: false;
      error: { code: string; message: string };
    }
  | {
      tool: "get_payment_status";
      success: true;
      paymentId: string;
      status: string;
    };

export interface PaymentAgentResult {
  message: string;
  action: PaymentAgentAction | null;
}

function safeToolError(error: unknown): { code: string; message: string } {
  if (error instanceof RewindClientError) {
    return { code: error.code, message: error.message };
  }
  return { code: "INVALID_REQUEST", message: "The payment request could not be completed." };
}

const systemPrompt = `
You are an assistant for a REWIND payment service.

Your responsibilities:

1. When the user gives an existing mandate ID, payee email, integer cents amount, and invoice ID for a payment request, call request_payment immediately.
2. Never invent a mandate, amount, payee, or invoice ID. Ask for missing values.
3. Use get_payment_status when a user asks about an existing payment and provides its payment ID.
4. Report only the status and decision data returned by the tools.
5. A requested or held payment is not yet a completed capture.
6. Never claim to perform or authorize an operation that is not available through these two tools.
`;

export async function runPaymentAgent(
  instruction: string,
  apiBaseUrl = env.REWIND_API_BASE_URL,
  expectedPayment?: RequestPaymentInput,
): Promise<PaymentAgentResult> {
  const configuration = requireAgentConfiguration();
  let action: PaymentAgentAction | null = null;
  const requestPaymentTool = tool(
    async ({ mandateId, payeeEmail, amountCents, invoiceId }) => {
      try {
        if (expectedPayment && (
          mandateId !== expectedPayment.mandateId ||
          payeeEmail.trim().toLowerCase() !== expectedPayment.payeeEmail.toLowerCase() ||
          amountCents !== expectedPayment.amountCents ||
          invoiceId !== expectedPayment.invoiceId
        )) {
          action = {
            tool: "request_payment",
            success: false,
            error: {
              code: "AGENT_ARGUMENT_MISMATCH",
              message: "The agent request did not match the payment details you submitted.",
            },
          };
          return JSON.stringify(action);
        }
        const result = await requestPayment({
          mandateId,
          payeeEmail,
          amountCents,
          invoiceId,
        }, apiBaseUrl);
        action = {
          tool: "request_payment",
          success: true,
          paymentId: result.paymentId,
          status: result.status,
          approvalUrl: result.approvalUrl,
        };
      } catch (error) {
        action = { tool: "request_payment", success: false, error: safeToolError(error) };
      }
      return JSON.stringify(action?.tool === "request_payment" && action.success
        ? {
            tool: action.tool,
            success: action.success,
            paymentId: action.paymentId,
            status: action.status,
          }
        : action);
    },
    {
      name: "request_payment",
      description:
        "Requests a payment under an existing mandate. Returns only the payment ID and current status.",
      schema: z.object({
        mandateId: z.string().uuid().describe("Existing REWIND mandate ID"),
        payeeEmail: z.string().email().describe("Mandated payee email"),
        amountCents: z.number().int().positive().safe()
          .describe("Payment amount as integer USD cents"),
        invoiceId: z.string().min(1).max(127).describe("Unique invoice ID"),
      }),
    }
  );
  const getPaymentStatusTool = tool(
    async ({ paymentId }) => {
      try {
        const result = await getPaymentStatus(paymentId, apiBaseUrl);
        action = {
          tool: "get_payment_status",
          success: true,
          paymentId: result.paymentId,
          status: result.status,
        };
      } catch (error) {
        action = { tool: "get_payment_status", success: false, error: safeToolError(error) };
      }
      return JSON.stringify(action);
    },
    {
      name: "get_payment_status",
      description:
        "Gets the current status and Guardian decisions for a REWIND payment by payment ID.",
      schema: z.object({
        paymentId: z.string().uuid().describe("REWIND payment ID"),
      }),
    }
  );

  const agent = createAgent({
    model: new ChatOpenRouter({
      apiKey: configuration.apiKey,
      model: configuration.model,
      temperature: 0,
    }),
    tools: [requestPaymentTool, getPaymentStatusTool],
    systemPrompt,
  });
  const result = await agent.invoke({
    messages: [{ role: "user", content: instruction }],
  });
  const content = result.messages.at(-1)?.content;
  const message = typeof content === "string"
    ? content
    : Array.isArray(content)
    ? content.map((part) => typeof part === "string" ? part : JSON.stringify(part)).join("\n")
    : "";
  return { message, action };
}