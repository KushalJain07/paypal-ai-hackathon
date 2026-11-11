import { cancelPayment } from "@/lib/payments";

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const result = cancelPayment(id);
  if ("error" in result) {
    return Response.json({ error: result.error }, { status: result.error === "Payment not found." ? 404 : 409 });
  }
  return Response.json({ payment: result.payment });
}
