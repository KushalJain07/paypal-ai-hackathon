import { getRewindHandlers } from "@/lib/rewind/composition";

export async function GET(request: Request) {
  void request.url;
  return getRewindHandlers().getPayments();
}
