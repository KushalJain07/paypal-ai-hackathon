import type { Decision, DecisionPhase } from "../domain/decision.ts";
import type { Mandate } from "../domain/mandate.ts";
import type { BudgetState, Payment } from "../domain/payment.ts";
import type {
  AppendPaymentEvent,
  DecisionRecord,
  PaymentEvent,
  ReservePaymentInput,
} from "./schemas.ts";

export type PersistenceErrorCode =
  | "CONFIGURATION_ERROR"
  | "MANDATE_NOT_FOUND"
  | "MANDATE_INACTIVE"
  | "MANDATE_EXPIRED"
  | "PAYMENT_AMOUNT_INVALID"
  | "CURRENCY_MISMATCH"
  | "INVALID_PAYEE_EMAIL"
  | "INVOICE_ID_REQUIRED"
  | "DUPLICATE_INVOICE"
  | "DUPLICATE_MANDATE"
  | "DUPLICATE_PAYMENT"
  | "PAYMENT_NOT_FOUND"
  | "PAYMENT_STATUS_CONFLICT"
  | "ACTION_ALREADY_CLAIMED"
  | "INVALID_TRANSITION"
  | "MANDATE_NOT_ACTIVE"
  | "BUDGET_INVARIANT_FAILED"
  | "BUDGET_EXCEEDED"
  | "INVALID_RECORD"
  | "DATABASE_ERROR";

export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode;

  constructor(
    code: PersistenceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PersistenceError";
    this.code = code;
  }
}

export interface MandateRepository {
  create(mandate: Mandate): Promise<Mandate>;
  update(mandate: Mandate): Promise<Mandate>;
  getById(id: string): Promise<Mandate | null>;
  list(): Promise<Mandate[]>;
}

export interface PaymentRepository {
  reserve(input: ReservePaymentInput): Promise<Payment>;
  createRejected(
    input: ReservePaymentInput,
    reason: string,
    detail: Record<string, string | number | boolean | null>,
  ): Promise<Payment>;
  attachOrder(
    paymentId: string,
    orderId: string,
    approvalUrl: string,
    at: string,
  ): Promise<Payment>;
  transition(input: PaymentTransitionInput): Promise<Payment>;
  claimAction(
    paymentId: string,
    expectedStatus: Payment["status"],
    action: PaymentAction,
    at: string,
    dueAt?: string,
  ): Promise<boolean>;
  clearActionClaim(paymentId: string, action: PaymentAction): Promise<void>;
  getById(id: string): Promise<Payment | null>;
  listAll(): Promise<Payment[]>;
  listByMandate(mandateId: string): Promise<Payment[]>;
  listDue(at: string): Promise<Payment[]>;
  // When excluded, also removes that payment's still-reserved amount from the snapshot.
  getBudgetState(
    mandateId: string,
    excludingPaymentId?: string,
  ): Promise<BudgetState>;
}

export interface DecisionRepository {
  append(
    paymentId: string,
    decision: Decision,
    createdAt: string,
    phase?: DecisionPhase,
  ): Promise<void>;
  listByPayment(paymentId: string): Promise<DecisionRecord[]>;
}

export type PaymentAction = "undo" | "release" | "refund";
export type BudgetEffect =
  | "none"
  | "release_reserved"
  | "reserved_to_spent"
  | "restore_spent";

export interface PaymentTransitionInput {
  paymentId: string;
  expectedStatus: Payment["status"];
  nextStatus: Payment["status"];
  at: string;
  budgetEffect: BudgetEffect;
  eventType: string;
  detail: Record<string, string | number | boolean | null>;
  paypalOrderId?: string;
  authorizationId?: string;
  captureId?: string;
  releaseAt?: string | null;
  failureReason?: string | null;
  claimAction?: PaymentAction;
}

export interface PaymentEventRepository {
  append(event: AppendPaymentEvent): Promise<PaymentEvent>;
  listByPayment(paymentId: string): Promise<PaymentEvent[]>;
}

export interface PersistenceRepositories {
  mandates: MandateRepository;
  payments: PaymentRepository;
  decisions: DecisionRepository;
  events: PaymentEventRepository;
}
