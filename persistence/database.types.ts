import type { PaymentStatus } from "../domain/payment.ts";
import type { JsonValue } from "./schemas.ts";

export type MandateRow = {
  id: string;
  version: number;
  payee_email: string;
  per_payment_cap: number;
  total_cap: number;
  spent_total: number;
  reserved_total: number;
  currency: "USD";
  purpose: string;
  expires_at: string;
  undo_window_seconds: number;
  status: "active" | "expired" | "revoked";
  signature: string;
  hash: string;
  created_at: string;
};

export type PaymentRow = {
  id: string;
  mandate_id: string;
  invoice_id: string;
  amount: number;
  currency: "USD";
  payee_email: string;
  approval_url: string | null;
  paypal_order_id: string | null;
  authorization_id: string | null;
  capture_id: string | null;
  status: PaymentStatus;
  release_at: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type DecisionRow = {
  id: number;
  payment_id: string;
  phase: "preflight" | "authorized";
  rule: "R1" | "R2" | "R3" | "R4" | "R5";
  passed: boolean;
  expected: JsonValue;
  actual: JsonValue;
  created_at: string;
};

export type EventRow = {
  id: number;
  payment_id: string;
  type: string;
  from_status: PaymentStatus | null;
  to_status: PaymentStatus | null;
  detail: JsonValue;
  created_at: string;
};

export type PaymentActionClaimRow = {
  payment_id: string;
  action: "undo" | "release" | "refund";
  claimed_at: string;
};

type TableDefinition<Row, Insert, Update> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

type Table<Row, Insert = Row, Update = Partial<Row>> = TableDefinition<
  Row,
  Insert,
  Update
>;

export interface Database {
  public: {
    Tables: {
      mandates: Table<MandateRow>;
      payments: Table<PaymentRow>;
      decisions: Table<DecisionRow, Omit<DecisionRow, "id">>;
      events: Table<EventRow, Omit<EventRow, "id">>;
      payment_action_claims: Table<PaymentActionClaimRow>;
    };
    Views: { [_ in never]: never };
    Functions: {
      reserve_payment: {
        Args: {
          p_id: string;
          p_mandate_id: string;
          p_invoice_id: string;
          p_amount: number;
          p_currency: string;
          p_payee_email: string;
          p_created_at: string;
        };
        Returns: PaymentRow[];
      };
      update_mandate: {
        Args: { p_mandate: JsonValue };
        Returns: MandateRow[];
      };
      create_rejected_payment: {
        Args: {
          p_id: string;
          p_mandate_id: string;
          p_invoice_id: string;
          p_amount: number;
          p_currency: string;
          p_payee_email: string;
          p_created_at: string;
          p_reason: string;
          p_decision: JsonValue;
        };
        Returns: PaymentRow[];
      };
      attach_paypal_order: {
        Args: {
          p_payment_id: string;
          p_order_id: string;
          p_approval_url: string;
          p_at: string;
        };
        Returns: PaymentRow[];
      };
      claim_payment_action: {
        Args: {
          p_payment_id: string;
          p_expected_status: string;
          p_action: string;
          p_at: string;
          p_due_at?: string | null;
        };
        Returns: boolean;
      };
      claim_payment_action_v2: {
        Args: {
          p_payment_id: string;
          p_expected_status: string;
          p_action: string;
          p_at: string;
          p_due_at?: string | null;
          p_stale_after_seconds: number;
        };
        Returns: boolean;
      };
      list_stale_release_claims: {
        Args: { p_before: string };
        Returns: Array<{ payment_id: string; claimed_at: string }>;
      };
      clear_payment_action_claim: {
        Args: { p_payment_id: string; p_action: string };
        Returns: undefined;
      };
      transition_payment: {
        Args: {
          p_payment_id: string;
          p_expected_status: string;
          p_next_status: string;
          p_at: string;
          p_budget_effect: string;
          p_event_type: string;
          p_detail: JsonValue;
          p_paypal_order_id?: string | null;
          p_authorization_id?: string | null;
          p_capture_id?: string | null;
          p_release_at?: string | null;
          p_failure_reason?: string | null;
          p_claim_action?: string | null;
        };
        Returns: PaymentRow[];
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
}
