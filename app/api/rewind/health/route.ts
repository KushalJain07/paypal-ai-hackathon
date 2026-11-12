import { getRewindHandlers } from "@/lib/rewind/composition";

export const GET = () => getRewindHandlers().getHealth();
