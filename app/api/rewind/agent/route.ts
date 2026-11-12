import { createAgentHandler } from "../../../../lib/rewind/agent-handler.ts";
import { runPaymentAgent } from "../../../../src/agent/payment-agent.ts";

export const POST = createAgentHandler(runPaymentAgent);
