import { getRewindHandlers } from "@/lib/rewind/composition";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return getRewindHandlers().postRefundPayment(request, id);
}
