export type PaymentStatus =
  | "requested"
  | "authorized"
  | "rejected"
  | "held"
  | "captured"
  | "voided"
  | "refunded"
  | "failed";

export type MandateStatus = "active" | "expired" | "revoked";
export type GuardianRule = "R1" | "R2" | "R3" | "R4" | "R5";

export interface RuleResult {
  rule: GuardianRule;
  phase: "preflight" | "authorized";
  passed: boolean;
  expected: unknown;
  actual: unknown;
}

export interface Mandate {
  id: string;
  version: number;
  payeeEmail: string;
  perPaymentCapCents: number;
  totalCapCents: number;
  spentCents: number;
  reservedCents: number;
  currency: "USD";
  purpose: string;
  expiresAt: string;
  undoWindowSeconds: number;
  status: MandateStatus;
  createdAt: string;
}

export interface PaymentRow {
  id: string;
  mandateId: string;
  status: PaymentStatus;
  releaseAt: string | null;
  amountCents: number;
  currency: "USD";
  payee: string;
  invoice: string;
  createdAt: string;
  decisions: RuleResult[];
  approvalUrl?: string | null;
}

export interface PaymentEvent {
  type: string;
  from: PaymentStatus | null;
  to: PaymentStatus | null;
  createdAt: string;
}

export interface PaymentDetail {
  payment: PaymentRow;
  decisions: RuleResult[];
  events: PaymentEvent[];
  paypalOrderId?: string | null;
  authorizationId?: string | null;
  captureId?: string | null;
}

export interface CreateMandateInput {
  payeeEmail: string;
  perPaymentCapCents: number;
  totalCapCents: number;
  purpose: string;
  expiresAt: string;
  undoWindowSeconds: number;
}

export interface RequestPaymentInput {
  mandateId: string;
  payeeEmail: string;
  amountCents: number;
  invoiceId: string;
}

export interface RewindApi {
  listMandates(): Promise<Mandate[]>;
  createMandate(input: CreateMandateInput): Promise<Mandate>;
  revokeMandate(id: string): Promise<Mandate>;
  listPayments(): Promise<PaymentRow[]>;
  getPayment(id: string): Promise<PaymentDetail>;
  requestPayment(input: RequestPaymentInput): Promise<PaymentRow>;
  authorizePayment(id: string): Promise<PaymentRow>;
  undoPayment(id: string): Promise<PaymentRow>;
  refundPayment(id: string): Promise<PaymentRow>;
  releaseDue(): Promise<void>;
}

export class RewindApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "RewindApiError";
  }
}

const ruleOrder: GuardianRule[] = ["R1", "R2", "R3", "R4", "R5"];

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RewindApiError("The server returned an invalid response.", "INVALID_RESPONSE");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeMandate(input: unknown): Mandate {
  const row = object(input);
  const expiresAt = string(row.expiresAt ?? row.expires_at);
  const status = string(row.status, "active");
  return {
    id: string(row.id),
    version: number(row.version, 1),
    payeeEmail: string(row.payeeEmail ?? row.payee_email),
    perPaymentCapCents: number(row.perPaymentCapCents ?? row.per_payment_cap),
    totalCapCents: number(row.totalCapCents ?? row.total_cap),
    spentCents: number(row.spentCents ?? row.spent_total),
    reservedCents: number(row.reservedCents ?? row.reserved_total),
    currency: "USD",
    purpose: string(row.purpose),
    expiresAt,
    undoWindowSeconds: number(row.undoWindowSeconds ?? row.undo_window_seconds),
    status: status === "revoked" || Date.parse(expiresAt) <= Date.now()
      ? status === "revoked" ? "revoked" : "expired"
      : "active",
    createdAt: string(row.createdAt ?? row.created_at),
  };
}

function normalizeDecision(input: unknown): RuleResult[] {
  const record = object(input);
  const list = Array.isArray(record.results)
    ? record.results
    : Array.isArray(record.decisions)
    ? record.decisions
    : [];
  const byRule = new Map<string, RuleResult>();
  for (const raw of list) {
    const item = object(raw);
    const rule = string(item.rule) as GuardianRule;
    if (!ruleOrder.includes(rule)) continue;
    byRule.set(rule, {
      rule,
      phase: string(item.phase, string(record.phase, "preflight")) === "authorized"
        ? "authorized"
        : "preflight",
      passed: item.passed === true,
      expected: item.expected ?? null,
      actual: item.actual ?? null,
    });
  }
  return ruleOrder.flatMap((rule) => {
    const result = byRule.get(rule);
    return result ? [result] : [];
  });
}

function normalizePayment(input: unknown, decisions?: unknown): PaymentRow {
  const row = object(input);
  const embeddedDecisions = decisions ?? row.decisions ?? row.decision;
  const rawStatus = string(row.status, "requested");
  const payment: PaymentRow = {
    id: string(row.id),
    mandateId: string(row.mandateId ?? row.mandate_id),
    status: rawStatus as PaymentStatus,
    releaseAt: typeof (row.releaseAt ?? row.release_at) === "string"
      ? string(row.releaseAt ?? row.release_at)
      : null,
    amountCents: number(row.amountCents ?? row.amount),
    currency: "USD",
    payee: string(row.payee ?? row.payeeEmail ?? row.payee_email),
    invoice: string(row.invoice ?? row.invoiceId ?? row.invoice_id),
    createdAt: string(row.createdAt ?? row.created_at),
    decisions: normalizeDecision(embeddedDecisions),
    approvalUrl: typeof row.approvalUrl === "string"
      ? row.approvalUrl
      : typeof row.approval_url === "string"
      ? row.approval_url
      : null,
  };
  return payment;
}

function normalizeEvents(input: unknown): PaymentEvent[] {
  if (!Array.isArray(input)) return [];
  return input.map((raw) => {
    const item = object(raw);
    const from = item.from ?? item.from_status;
    const to = item.to ?? item.to_status;
    return {
      type: string(item.type),
      from: typeof from === "string" ? from as PaymentStatus : null,
      to: typeof to === "string" ? to as PaymentStatus : null,
      createdAt: string(item.createdAt ?? item.created_at),
    };
  });
}

async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      cache: "no-store",
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new RewindApiError("Could not reach the REWIND service.", "NETWORK_ERROR");
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new RewindApiError("The REWIND service returned an unreadable response.", "INVALID_RESPONSE");
  }
  const data = object(payload);
  if (!response.ok) {
    const error = object(data.error);
    throw new RewindApiError(
      string(error.message, "The request could not be completed."),
      string(error.code, "REQUEST_FAILED"),
    );
  }
  return payload;
}

const realApi: RewindApi = {
  async listMandates() {
    const payload = object(await requestJson("/api/rewind/mandates"));
    return Array.isArray(payload.mandates)
      ? payload.mandates.map(normalizeMandate)
      : [];
  },
  async createMandate(input) {
    const payload = object(await requestJson("/api/rewind/mandates", {
      method: "POST",
      body: JSON.stringify({
        payee_email: input.payeeEmail,
        per_payment_cap: input.perPaymentCapCents,
        total_cap: input.totalCapCents,
        currency: "USD",
        purpose: input.purpose,
        expires_at: input.expiresAt,
        undo_window_seconds: input.undoWindowSeconds,
      }),
    }));
    return normalizeMandate(payload.mandate);
  },
  async revokeMandate(id) {
    const payload = object(await requestJson(
      `/api/rewind/mandates/${encodeURIComponent(id)}/revoke`,
      { method: "POST" },
    ));
    return normalizeMandate(payload.mandate);
  },
  async listPayments() {
    const payload = object(await requestJson("/api/rewind/payments"));
    return Array.isArray(payload.payments)
      ? payload.payments.map((row) => {
          const item = object(row);
          return normalizePayment(item, item.decisions);
        })
      : [];
  },
  async getPayment(id) {
    const payload = object(await requestJson(
      `/api/rewind/payments/${encodeURIComponent(id)}`,
    ));
    const payment = normalizePayment(payload.payment, payload.decisions);
    const rawPayment = object(payload.payment);
    return {
      payment,
      decisions: normalizeDecision(payload.decisions),
      events: normalizeEvents(payload.events),
      paypalOrderId: string(rawPayment.paypalOrderId ?? rawPayment.paypal_order_id) || null,
      authorizationId: string(rawPayment.authorizationId ?? rawPayment.authorization_id) || null,
      captureId: string(rawPayment.captureId ?? rawPayment.capture_id) || null,
    };
  },
  async requestPayment(input) {
    const payload = object(await requestJson("/api/rewind/payments/request", {
      method: "POST",
      body: JSON.stringify(input),
    }));
    const payment = object(payload.payment);
    return normalizePayment(payment, payload.decision ?? payment.decisions);
  },
  async authorizePayment(id) {
    const payload = object(await requestJson(
      `/api/rewind/payments/${encodeURIComponent(id)}/authorize`,
      { method: "POST" },
    ));
    return normalizePayment(payload.payment, payload.decisions);
  },
  async undoPayment(id) {
    const payload = object(await requestJson(
      `/api/rewind/payments/${encodeURIComponent(id)}/undo`,
      { method: "POST" },
    ));
    return normalizePayment(payload.payment, payload.decisions);
  },
  async refundPayment(id) {
    const payload = object(await requestJson(
      `/api/rewind/payments/${encodeURIComponent(id)}/refund`,
      { method: "POST" },
    ));
    return normalizePayment(payload.payment, payload.decisions);
  },
  async releaseDue() {
    await requestJson("/api/rewind/worker/release", { method: "POST" });
  },
};

interface MockDatabase {
  mandates: Mandate[];
  payments: PaymentRow[];
  events: Map<string, PaymentEvent[]>;
  invoiceUses: Set<string>;
}

const mockKey = "__rewind_mock_db_v1__";
const mockGlobal = globalThis as typeof globalThis & {
  [mockKey]?: MockDatabase;
};

function mockDatabase(): MockDatabase {
  if (!mockGlobal[mockKey]) {
    const now = new Date();
    const existing = typeof window !== "undefined"
      ? window.localStorage.getItem(mockKey)
      : null;
    if (existing) {
      try {
        const parsed = JSON.parse(existing) as MockDatabase;
        parsed.events = new Map(Object.entries(parsed.events ?? {}));
        parsed.invoiceUses = new Set(parsed.invoiceUses ?? []);
        mockGlobal[mockKey] = parsed;
      } catch {
        window.localStorage.removeItem(mockKey);
      }
    }
    if (!mockGlobal[mockKey]) {
      const sample: Mandate = {
        id: "mock-mandate-001",
        version: 1,
        payeeEmail: "sandbox-merchant@example.com",
        perPaymentCapCents: 5000,
        totalCapCents: 20000,
        spentCents: 0,
        reservedCents: 0,
        currency: "USD",
        purpose: "Sandbox demo purchases",
        expiresAt: new Date(now.getTime() + 30 * 86400000).toISOString(),
        undoWindowSeconds: 30,
        status: "active",
        createdAt: now.toISOString(),
      };
      mockGlobal[mockKey] = {
        mandates: [sample],
        payments: [],
        events: new Map(),
        invoiceUses: new Set(),
      };
      persistMock();
    }
  }
  return mockGlobal[mockKey]!;
}

function persistMock(): void {
  if (typeof window === "undefined") return;
  const database = mockGlobal[mockKey];
  if (!database) return;
  window.localStorage.setItem(mockKey, JSON.stringify({
    ...database,
    events: Object.fromEntries(database.events),
    invoiceUses: [...database.invoiceUses],
  }));
}

function mockEvent(
  paymentId: string,
  type: string,
  from: PaymentStatus | null,
  to: PaymentStatus | null,
): void {
  const database = mockDatabase();
  const events = database.events.get(paymentId) ?? [];
  events.push({ type, from, to, createdAt: new Date().toISOString() });
  database.events.set(paymentId, events);
}

function mockRule(
  rule: GuardianRule,
  passed: boolean,
  expected: unknown,
  actual: unknown,
  phase: RuleResult["phase"] = "preflight",
): RuleResult {
  return { rule, passed, expected, actual, phase };
}

export const rewindMockApi: RewindApi = {
  async listMandates() {
    return mockDatabase().mandates.map((item) => normalizeMandate(item));
  },
  async createMandate(input) {
    const now = new Date().toISOString();
    const mandate: Mandate = {
      id: crypto.randomUUID(),
      version: 1,
      payeeEmail: input.payeeEmail,
      perPaymentCapCents: input.perPaymentCapCents,
      totalCapCents: input.totalCapCents,
      spentCents: 0,
      reservedCents: 0,
      currency: "USD",
      purpose: input.purpose,
      expiresAt: input.expiresAt,
      undoWindowSeconds: input.undoWindowSeconds,
      status: "active",
      createdAt: now,
    };
    const database = mockDatabase();
    database.mandates.unshift(mandate);
    persistMock();
    return mandate;
  },
  async revokeMandate(id) {
    const database = mockDatabase();
    const mandate = database.mandates.find((item) => item.id === id);
    if (!mandate) throw new RewindApiError("Mandate not found.", "MANDATE_NOT_FOUND");
    mandate.status = "revoked";
    persistMock();
    return { ...mandate };
  },
  async listPayments() {
    return [...mockDatabase().payments]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((item) => ({ ...item, decisions: [...item.decisions] }));
  },
  async getPayment(id) {
    const database = mockDatabase();
    const payment = database.payments.find((item) => item.id === id);
    if (!payment) throw new RewindApiError("Payment not found.", "PAYMENT_NOT_FOUND");
    return {
      payment: { ...payment, decisions: [...payment.decisions] },
      decisions: [...payment.decisions],
      events: [...(database.events.get(id) ?? [])],
      paypalOrderId: `ORDER-${id.slice(0, 8)}`,
      authorizationId: payment.status === "requested" ? null : `AUTH-${id.slice(0, 8)}`,
      captureId: payment.status === "captured" || payment.status === "refunded"
        ? `CAPTURE-${id.slice(0, 8)}`
        : null,
    };
  },
  async requestPayment(input) {
    const database = mockDatabase();
    const mandate = database.mandates.find((item) => item.id === input.mandateId);
    if (!mandate) throw new RewindApiError("Mandate not found.", "MANDATE_NOT_FOUND");
    const now = new Date();
    const invoiceKey = `${mandate.id}:${input.invoiceId}`;
    const used = database.invoiceUses.has(invoiceKey);
    const available = mandate.totalCapCents - mandate.spentCents - mandate.reservedCents;
    const active = mandate.status === "active" && Date.parse(mandate.expiresAt) > now.getTime();
    const checks: RuleResult[] = [
      mockRule("R1", input.payeeEmail.trim().toLowerCase() === mandate.payeeEmail.toLowerCase(), {
        payee: mandate.payeeEmail,
      }, { payee: input.payeeEmail }),
      mockRule("R2", input.amountCents > 0 &&
        input.amountCents <= mandate.perPaymentCapCents &&
        input.amountCents <= available, {
        per_payment_cap_cents: mandate.perPaymentCapCents,
        available_cents: available,
      }, { amount_cents: input.amountCents }),
      mockRule("R3", input.invoiceId.trim().length > 0 && !used, {
        invoice_unused: true,
      }, { invoice_id: input.invoiceId, previously_used: used }),
      mockRule("R4", active, { status: "active", expires_at: mandate.expiresAt }, {
        status: mandate.status,
        checked_at: now.toISOString(),
      }),
      mockRule("R5", true, { status: "checked after authorization" }, {
        status: "deferred_no_paypal_ids_yet",
      }),
    ];
    const passed = checks.every((rule) => rule.passed);
    const payment: PaymentRow = {
      id: crypto.randomUUID(),
      mandateId: mandate.id,
      status: passed ? "requested" : "rejected",
      releaseAt: null,
      amountCents: input.amountCents,
      currency: "USD",
      payee: input.payeeEmail,
      invoice: input.invoiceId,
      createdAt: now.toISOString(),
      decisions: checks,
      approvalUrl: passed
        ? "https://www.sandbox.paypal.com/checkoutnow?token=MOCK-APPROVAL"
        : null,
    };
    database.payments.unshift(payment);
    if (passed) {
      mandate.reservedCents += input.amountCents;
      database.invoiceUses.add(invoiceKey);
      mockEvent(payment.id, "payment_requested", null, "requested");
    } else {
      mockEvent(payment.id, "payment_rejected", null, "rejected");
    }
    persistMock();
    return { ...payment, decisions: [...payment.decisions] };
  },
  async authorizePayment(id) {
    const database = mockDatabase();
    const payment = database.payments.find((item) => item.id === id);
    if (!payment) throw new RewindApiError("Payment not found.", "PAYMENT_NOT_FOUND");
    if (payment.status !== "requested") {
      throw new RewindApiError("Only a requested payment can be approved.", "PAYMENT_STATUS_CONFLICT");
    }
    const now = new Date();
    const mandate = database.mandates.find((item) => item.id === payment.mandateId)!;
    const authorizedRules: RuleResult[] = [
      mockRule("R1", payment.payee.toLowerCase() === mandate.payeeEmail.toLowerCase(), {
        payee: mandate.payeeEmail,
      }, { payee: payment.payee }, "authorized"),
      mockRule("R2", payment.amountCents <= mandate.perPaymentCapCents, {
        amount_cents: mandate.perPaymentCapCents,
      }, { amount_cents: payment.amountCents }, "authorized"),
      mockRule("R3", !database.invoiceUses.has(`${mandate.id}:${payment.invoice}`) ||
        payment.status === "requested", { invoice_unused: true }, {
        invoice_id: payment.invoice,
        paypal_order_id: `ORDER-${id.slice(0, 8)}`,
      }, "authorized"),
      mockRule("R4", mandate.status === "active" &&
        Date.parse(mandate.expiresAt) > now.getTime(), { status: "active" }, {
        status: mandate.status,
      }, "authorized"),
      mockRule("R5", true, { ids_unseen: true }, {
        paypal_order_id: `ORDER-${id.slice(0, 8)}`,
        authorization_id: `AUTH-${id.slice(0, 8)}`,
        status: "authorized",
      }, "authorized"),
    ];
    payment.decisions = authorizedRules;
    payment.status = "held";
    payment.releaseAt = new Date(now.getTime() + mandate.undoWindowSeconds * 1000).toISOString();
    mockEvent(id, "payment_authorized", "requested", "authorized");
    mockEvent(id, "payment_held", "authorized", "held");
    persistMock();
    return { ...payment, decisions: [...payment.decisions] };
  },
  async undoPayment(id) {
    const database = mockDatabase();
    const payment = database.payments.find((item) => item.id === id);
    if (!payment || payment.status !== "held") {
      throw new RewindApiError("Only a held payment can be undone.", "PAYMENT_STATUS_CONFLICT");
    }
    payment.status = "voided";
    const mandate = database.mandates.find((item) => item.id === payment.mandateId)!;
    mandate.reservedCents = Math.max(0, mandate.reservedCents - payment.amountCents);
    mockEvent(id, "payment_undone", "held", "voided");
    persistMock();
    return { ...payment };
  },
  async refundPayment(id) {
    const database = mockDatabase();
    const payment = database.payments.find((item) => item.id === id);
    if (!payment || payment.status !== "captured") {
      throw new RewindApiError("Only a captured payment can be refunded.", "PAYMENT_STATUS_CONFLICT");
    }
    payment.status = "refunded";
    const mandate = database.mandates.find((item) => item.id === payment.mandateId)!;
    mandate.spentCents = Math.max(0, mandate.spentCents - payment.amountCents);
    mockEvent(id, "payment_refunded", "captured", "refunded");
    persistMock();
    return { ...payment };
  },
  async releaseDue() {
    const database = mockDatabase();
    const now = Date.now();
    for (const payment of database.payments) {
      if (payment.status !== "held" || !payment.releaseAt ||
        Date.parse(payment.releaseAt) > now) continue;
      payment.status = "captured";
      const mandate = database.mandates.find((item) => item.id === payment.mandateId)!;
      mandate.reservedCents = Math.max(0, mandate.reservedCents - payment.amountCents);
      mandate.spentCents += payment.amountCents;
      mockEvent(payment.id, "payment_captured", "held", "captured");
    }
    persistMock();
  },
};

export const rewindApi: RewindApi =
  realApi;

export function formatMoney(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

export function displayValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "—";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
