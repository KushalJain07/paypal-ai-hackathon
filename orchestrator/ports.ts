import type {
  Decision,
  DecisionPhase,
  Mandate,
  Payment,
  BudgetState,
} from "../domain/index.ts";
import type {
  ApprovalProvider,
  PaymentProvider,
} from "../paypal/payment-provider.ts";
import type {
  AppendPaymentEvent,
  DecisionRecord,
  PaymentEvent,
  ReservePaymentInput,
} from "../persistence/schemas.ts";
import type {
  PaymentAction,
  PaymentTransitionInput,
} from "../persistence/repositories.ts";

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export interface MandateRepo {
  create(mandate: Mandate): Promise<Mandate>;
  update(mandate: Mandate): Promise<Mandate>;
  getById(id: string): Promise<Mandate | null>;
  list(): Promise<Mandate[]>;
}

export interface PaymentRepo {
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
  listDue(at: string): Promise<Payment[]>;
  getBudgetState(
    mandateId: string,
    excludingPaymentId?: string,
  ): Promise<BudgetState>;
}

export interface DecisionRepo {
  append(
    paymentId: string,
    decision: Decision,
    createdAt: string,
    phase?: DecisionPhase,
  ): Promise<void>;
  listByPayment(paymentId: string): Promise<DecisionRecord[]>;
}

export interface EventRepo {
  append(event: AppendPaymentEvent): Promise<PaymentEvent>;
  listByPayment(paymentId: string): Promise<PaymentEvent[]>;
}

export interface OrchestratorDependencies {
  mandates: MandateRepo;
  payments: PaymentRepo;
  decisions: DecisionRepo;
  events: EventRepo;
  paymentProvider: PaymentProvider;
  approvalProvider: ApprovalProvider;
  clock: Clock;
  ids: IdGenerator;
  signingSecret?: string;
}

export interface PaymentRequestInput {
  mandateId: string;
  payeeEmail: string;
  amountCents: number;
  invoiceId: string;
}

export interface PaymentRequestResult {
  payment: Payment;
  decision: Decision;
  approvalUrl: string | null;
}

export interface PaymentDetail {
  payment: Payment;
  decisions: DecisionRecord[];
  events: PaymentEvent[];
}

export interface ReleaseResult {
  paymentId: string;
  status: "captured" | "failed" | "skipped";
  error?: string;
}

export type {
  ApprovalProvider,
  PaymentProvider,
  PaymentAction,
};
