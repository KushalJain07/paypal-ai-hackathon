import type { PaymentStatus } from "./payment.ts";

const legalTransitions: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  requested: ["authorized", "failed"],
  authorized: ["held", "rejected", "failed"],
  held: ["captured", "voided", "failed"],
  captured: ["refunded"],
  rejected: [],
  voided: [],
  refunded: [],
  failed: [],
};

export class IllegalPaymentTransitionError extends Error {
  constructor(from: PaymentStatus, to: PaymentStatus) {
    super(`Illegal payment status transition: ${from} -> ${to}`);
    this.name = "IllegalPaymentTransitionError";
  }
}

export function transitionPaymentStatus(
  current: PaymentStatus,
  next: PaymentStatus,
): PaymentStatus {
  if (!legalTransitions[current].includes(next)) {
    throw new IllegalPaymentTransitionError(current, next);
  }

  return next;
}
