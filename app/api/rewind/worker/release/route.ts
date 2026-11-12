import { getRewindHandlers } from "@/lib/rewind/composition";

export async function POST() {
  return getRewindHandlers().postReleaseDue();
}
