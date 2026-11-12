import { z } from "zod";
import type {
  PaymentAgentAction,
  PaymentAgentResult,
} from "../../src/agent/payment-agent.ts";

const agentRequestSchema = z.object({
  mandateId: z.string().uuid(),
  payeeEmail: z.string().trim().email(),
  amountCents: z.number().int().positive().safe(),
  invoiceId: z.string().trim().min(1).max(127),
}).strict();

export type AgentRequestInput = z.infer<typeof agentRequestSchema>;
export type AgentRunner = (
  instruction: string,
  apiBaseUrl: string,
  expectedPayment: AgentRequestInput,
) => Promise<PaymentAgentResult>;

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function instructionFor(input: AgentRequestInput): string {
  return [
    "Request this payment using the existing REWIND mandate. Call request_payment now.",
    `Mandate ID: ${input.mandateId}`,
    `Payee email: ${input.payeeEmail}`,
    `Amount: ${input.amountCents} integer USD cents`,
    `Invoice ID: ${input.invoiceId}`,
  ].join("\n");
}

export function createAgentHandler(runAgent: AgentRunner) {
  return async (request: Request): Promise<Response> => {
    const rawInput = await readJson(request);
    const parsed = agentRequestSchema.safeParse(rawInput);
    if (!parsed.success) {
      return json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Provide a mandate, payee, positive integer cents amount, and invoice ID.",
        },
      }, 422);
    }

    try {
      const result = await runAgent(
        instructionFor(parsed.data),
        new URL(
          process.env.REWIND_API_BASE_URL ??
            process.env.RENDER_EXTERNAL_URL ??
            request.url,
        ).origin,
        parsed.data,
      );
      const action: PaymentAgentAction | null = result.action;
      return json({
        message: result.message,
        action,
      }, 200);
    } catch (error) {
      if (error instanceof z.ZodError || (
        error instanceof Error && error.message === "AGENT_CONFIGURATION_REQUIRED"
      )) {
        return json({
          error: {
            code: "AGENT_NOT_CONFIGURED",
            message: "Configure OPENROUTER_API_KEY and OPENROUTER_MODEL to use the payment agent.",
          },
        }, 503);
      }
      return json({
        error: {
          code: "AGENT_FAILED",
          message: "The agent could not complete this request. Check server logs and try again.",
        },
      }, 502);
    }
  };
}
