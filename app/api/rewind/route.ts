import { authorizeAndGuard, createMandate, createRewindOrder } from "@/lib/rewind";

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();

    if (!body || typeof body !== "object") {
      return Response.json({ error: "Send a valid JSON body." }, { status: 400 });
    }

    const data = body as Record<string, unknown>;

    if (data.action === "create-mandate") {
      const mandate = createMandate({
        payee: String(data.payee ?? ""),
        exactAmount: String(data.exactAmount ?? ""),
        maxAmount: String(data.maxAmount ?? ""),
        invoiceRef: String(data.invoiceRef ?? ""),
        expiresInMinutes: Number(data.expiresInMinutes),
      });
      return Response.json({ mandate }, { status: 201 });
    }

    if (data.action === "create-order") {
      if (typeof data.mandateId !== "string") {
        return Response.json({ error: "mandateId is required." }, { status: 400 });
      }
      const order = await createRewindOrder(data.mandateId);
      return Response.json({ order }, { status: 201 });
    }

    if (data.action === "authorize-and-guard") {
      if (
        typeof data.orderRecordId !== "string" ||
        typeof data.paypalOrderId !== "string"
      ) {
        return Response.json(
          { error: "orderRecordId and paypalOrderId are required." },
          { status: 400 }
        );
      }

      const result = await authorizeAndGuard(
        data.orderRecordId,
        data.paypalOrderId
      );
      return Response.json({ result });
    }

    return Response.json({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "REWIND request failed.";
    return Response.json({ error: message }, { status: 400 });
  }
}
