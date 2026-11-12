import type { ObservedPayment } from "../domain/payment.ts";

export interface CreateOrderInput {
  paymentId: string;
  payeeEmail: string;
  amountCents: number;
  currency: string;
  invoiceId: string;
}

export type PayPalOrderStatus =
  | "CREATED"
  | "SAVED"
  | "APPROVED"
  | "VOIDED"
  | "COMPLETED"
  | "PAYER_ACTION_REQUIRED";

export interface CreatedOrder {
  paymentId: string;
  paypalOrderId: string;
  status: PayPalOrderStatus;
  approvalUrl: string;
}

export interface OrderSnapshot {
  paypalOrderId: string;
  status: PayPalOrderStatus;
  observedPayment: ObservedPayment;
}

export type AuthorizationStatus =
  | "CREATED"
  | "PENDING"
  | "CAPTURED"
  | "DENIED"
  | "PARTIALLY_CAPTURED"
  | "VOIDED"
  | "EXPIRED";

export interface Authorization {
  authorizationId: string;
  status: AuthorizationStatus;
  amountCents: number;
  currency: string;
}

export type CaptureStatus =
  | "PENDING"
  | "COMPLETED"
  | "DECLINED"
  | "PARTIALLY_REFUNDED"
  | "REFUNDED";

export interface Capture {
  captureId: string;
  status: CaptureStatus;
  amountCents: number;
  currency: string;
  finalCapture: boolean | null;
}

export interface Refund {
  refundId: string;
  status: "PENDING" | "COMPLETED";
}

export interface PaymentProvider {
  createOrder(input: CreateOrderInput): Promise<CreatedOrder>;
  getOrder(paymentId: string, orderId: string): Promise<OrderSnapshot>;
  authorizeOrder(paymentId: string, orderId: string): Promise<Authorization>;
  getAuthorization(
    paymentId: string,
    authorizationId: string,
  ): Promise<Authorization>;
  captureAuthorization(
    paymentId: string,
    authorizationId: string,
  ): Promise<Capture>;
  findCaptureForAuthorization?(
    paymentId: string,
    orderId: string,
    authorizationId: string,
  ): Promise<Capture | null>;
  voidAuthorization(
    paymentId: string,
    authorizationId: string,
  ): Promise<Authorization>;
  refundCapture(paymentId: string, captureId: string): Promise<Refund>;
}

export interface ApprovalOrder {
  paymentId: string;
  paypalOrderId: string;
  approvalUrl: string;
}

export interface ApprovalReady {
  paymentId: string;
  paypalOrderId: string;
  status: "APPROVED";
}

export interface ApprovalProvider {
  approve(order: ApprovalOrder): Promise<ApprovalReady>;
}

export class PayPalProviderError extends Error {
  readonly code: string;
  readonly operation: string;
  readonly httpStatus: number | undefined;

  constructor(
    code: string,
    operation: string,
    httpStatus?: number,
  ) {
    super(`PayPal Sandbox ${operation} failed (${code}).`);
    this.name = "PayPalProviderError";
    this.code = code;
    this.operation = operation;
    this.httpStatus = httpStatus;
  }
}
