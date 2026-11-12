import type { ReactNode } from "react";
import { RewindShell } from "@/components/rewind/rewind-shell";
import "./rewind.css";

export default function RewindLayout({ children }: { children: ReactNode }) {
  return <RewindShell>{children}</RewindShell>;
}
