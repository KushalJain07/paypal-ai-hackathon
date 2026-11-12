import { getRewindHandlers } from "@/lib/rewind/composition";

export async function POST(request: Request) {
  return getRewindHandlers().postPaymentRequest(request);
}
