import { createRewindAgent } from "@/src/agent/rewind-agent";

export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (
      typeof body.mandateId !== "string" ||
      typeof body.message !== "string" ||
      !body.message.trim()
    ) {
      return Response.json(
        { error: "mandateId and message are required." },
        { status: 400 }
      );
    }

    if (!process.env.OPENROUTER_API_KEY) {
      return Response.json(
        { error: "OpenRouter API key is not configured." },
        { status: 503 }
      );
    }

    const agent = createRewindAgent(body.mandateId);
    const result = await agent.invoke({
      messages: [{ role: "user", content: body.message }],
    });

    return Response.json({
      response: result.messages.at(-1)?.content ?? "No response from agent.",
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Agent request failed." },
      { status: 400 }
    );
  }
}
