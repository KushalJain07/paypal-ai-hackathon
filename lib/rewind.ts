
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

type Mandate = {
  id: string;
  payee: string;
  exactAmount: string;
  maxAmount: string;
  invoiceRef: string;
  expiresAt: number;
};

type RewindOrder = {
  id: string;
  mandateId: string;
  paypalOrderId: string;
  status: string;
  authorizationId?: string;
  decision?: string[];
};

const dataDir = path.join(process.cwd(), "data");
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, "rewind.sqlite"));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS mandates (
    id TEXT PRIMARY KEY,
    payee TEXT NOT NULL,
    exact_amount TEXT NOT NULL,
    max_amount TEXT NOT NULL,
    invoice_ref TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rewind_orders (
    id TEXT PRIMARY KEY,
    mandate_id TEXT NOT NULL,
    paypal_order_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    authorization_id TEXT,
    decision TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS used_authorizations (
    authorization_id TEXT PRIMARY KEY
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_rewind_one_order_per_mandate
  ON rewind_orders(mandate_id);
`);

function getMandate(id: string): Mandate | undefined {
  const row = db.prepare("SELECT * FROM mandates WHERE id = ?").get(id) as
    | {
        id: string;
        payee: string;
        exact_amount: string;
        max_amount: string;
        invoice_ref: string;
        expires_at: number;
      }
    | undefined;

  return row && {
    id: row.id,
    payee: row.payee,
    exactAmount: row.exact_amount,
    maxAmount: row.max_amount,
    invoiceRef: row.invoice_ref,
    expiresAt: row.expires_at,
  };
}

function getOrder(id: string): RewindOrder | undefined {
  const row = db.prepare("SELECT * FROM rewind_orders WHERE id = ?").get(id) as
    | {
        id: string;
        mandate_id: string;
        paypal_order_id: string;
        status: string;
        authorization_id?: string;
        decision?: string;
      }
    | undefined;

  return row && {
    id: row.id,
    mandateId: row.mandate_id,
    paypalOrderId: row.paypal_order_id,
    status: row.status,
    authorizationId: row.authorization_id,
    decision: row.decision ? JSON.parse(row.decision) : undefined,
  };
}

function updateOrder(
  id: string,
  status: string,
  authorizationId?: string,
  decision?: string[]
) {
  db.prepare(`
    UPDATE rewind_orders
    SET status = ?,
        authorization_id = COALESCE(?, authorization_id),
        decision = COALESCE(?, decision)
    WHERE id = ?
  `).run(
    status,
    authorizationId ?? null,
    decision ? JSON.stringify(decision) : null,
    id
  );
}

function credentials() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("REWIND Sandbox actions are disabled in production.");
  }

  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;

  if (!id || !secret) {
    throw new Error("Add PayPal Sandbox credentials to .env.local.");
  }

  return { id, secret };
}

const base = "https://api-m.sandbox.paypal.com";

async function paypal(
  pathname: string,
  method = "GET",
  body?: unknown
) {
  const c = credentials();

  const auth = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(
        `${c.id}:${c.secret}`
      ).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    cache: "no-store",
  });

  const token = await auth.json();

  if (!auth.ok || typeof token.access_token !== "string") {
    throw new Error(
      "PayPal Sandbox authentication failed. Check server credentials."
    );
  }

  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      "Content-Type": "application/json",
      ...(method !== "GET"
        ? { "PayPal-Request-Id": randomUUID() }
        : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: "no-store",
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    const issue =
      result.details?.[0]?.issue || result.name || "PayPal error";

    throw new Error(
      `${issue}: ${result.message || `HTTP ${response.status}`}`
    );
  }

  return result;
}

export function createMandate(input: {
  payee: string;
  exactAmount: string;
  maxAmount: string;
  invoiceRef: string;
  expiresInMinutes: number;
}) {
  const payee = input.payee.trim().toLowerCase();
  const invoiceRef = input.invoiceRef.trim();

  const exact = Number(input.exactAmount);
  const cap = Number(input.maxAmount);

  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payee) ||
    payee.length > 254
  ) {
    throw new Error("Enter a valid payee email.");
  }

  if (
    !/^\d+(\.\d{1,2})?$/.test(input.exactAmount) ||
    !/^\d+(\.\d{1,2})?$/.test(input.maxAmount) ||
    !Number.isFinite(exact) ||
    !Number.isFinite(cap) ||
    exact < 0.01 ||
    cap < exact ||
    cap > 10000
  ) {
    throw new Error(
      "Enter valid USD amounts (maximum $10,000; up to 2 decimals)."
    );
  }

  if (!invoiceRef || invoiceRef.length > 100) {
    throw new Error(
      "Invoice reference is required (max 100 characters)."
    );
  }

  if (
    !Number.isInteger(input.expiresInMinutes) ||
    input.expiresInMinutes < 1 ||
    input.expiresInMinutes > 1440
  ) {
    throw new Error(
      "Expiry must be between 1 and 1440 minutes."
    );
  }

  const mandate: Mandate = {
    id: randomUUID(),
    payee,
    exactAmount: exact.toFixed(2),
    maxAmount: cap.toFixed(2),
    invoiceRef,
    expiresAt: Date.now() + input.expiresInMinutes * 60000,
  };

  db.prepare("INSERT INTO mandates VALUES (?, ?, ?, ?, ?, ?)").run(
    mandate.id,
    mandate.payee,
    mandate.exactAmount,
    mandate.maxAmount,
    mandate.invoiceRef,
    mandate.expiresAt
  );

  return mandate;
}

export async function createRewindOrder(mandateId: string) {
  const mandate = getMandate(mandateId);

  if (!mandate) {
    throw new Error("Mandate not found.");
  }

  if (Date.now() >= mandate.expiresAt) {
    throw new Error("Mandate has expired.");
  }

  const existing = db
    .prepare("SELECT id FROM rewind_orders WHERE mandate_id = ?")
    .get(mandateId);

  if (existing) {
    throw new Error("This one-time mandate already has an order.");
  }

  const orderRecordId = randomUUID();
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  const result = await paypal("/v2/checkout/orders", "POST", {
    intent: "AUTHORIZE",

    purchase_units: [
      {
        reference_id: mandate.id,
        custom_id: mandate.invoiceRef,
        payee: {
          email_address: mandate.payee,
        },
        amount: {
          currency_code: "USD",
          value: mandate.exactAmount,
        },
      },
    ],

    application_context: {
      brand_name: "REWIND Guardian",
      user_action: "PAY_NOW",
      return_url: `${appUrl}/rewind?rewind=approved&orderRecordId=${orderRecordId}`,
      cancel_url: `${appUrl}/rewind?rewind=cancelled&orderRecordId=${orderRecordId}`,
    },
  });

  if (typeof result.id !== "string") {
    throw new Error("PayPal did not return an order ID.");
  }

  const approvalUrl = result.links?.find(
    (link: { rel?: string }) => link.rel === "approve"
  )?.href;

  if (!approvalUrl) {
    throw new Error("PayPal did not return an approval link.");
  }

  db.prepare(`
    INSERT INTO rewind_orders
    VALUES (?, ?, ?, 'CREATED', NULL, NULL, ?)
  `).run(
    orderRecordId,
    mandateId,
    result.id,
    Date.now()
  );

  return {
    id: orderRecordId,
    mandateId,
    paypalOrderId: result.id,
    status: "CREATED",
    approvalUrl,
  };
}

export async function authorizeAndGuard(
  orderRecordId: string,
  returnedPaypalOrderId: string
) {
  const order = getOrder(orderRecordId);

  if (!order) {
    throw new Error("REWIND order not found.");
  }

  if (order.paypalOrderId !== returnedPaypalOrderId) {
    throw new Error("PayPal order token mismatch.");
  }

  if (order.status !== "CREATED") {
    throw new Error(`Order already processed: ${order.status}.`);
  }

  const mandate = getMandate(order.mandateId);

  if (!mandate) {
    throw new Error("Mandate not found.");
  }

  // Claim the order before network calls to prevent parallel processing.
  const claim = db
    .prepare(`
      UPDATE rewind_orders
      SET status = 'PROCESSING'
      WHERE id = ? AND status = 'CREATED'
    `)
    .run(orderRecordId);

  if (Number(claim.changes) !== 1) {
    throw new Error("This order is already being processed.");
  }

  try {
    const authorized = await paypal(
      `/v2/checkout/orders/${encodeURIComponent(
        order.paypalOrderId
      )}/authorize`,
      "POST",
      {}
    );

    const authorizationId =
      authorized.purchase_units?.[0]?.payments?.authorizations?.[0]?.id;

    if (typeof authorizationId !== "string") {
      throw new Error("PayPal did not return an authorization ID.");
    }

    updateOrder(orderRecordId, "AUTHORIZED", authorizationId);

    const approved = await paypal(
      `/v2/checkout/orders/${encodeURIComponent(order.paypalOrderId)}`
    );

    const unit = approved.purchase_units?.[0];
    const reasons: string[] = [];

    // R4: Mandate expiry
    if (Date.now() >= mandate.expiresAt) {
      reasons.push("R4: Mandate expired.");
    }

    // R1: Payee validation
    if (
      String(unit?.payee?.email_address || "").toLowerCase() !==
      mandate.payee
    ) {
      reasons.push("R1: Payee does not match mandate.");
    }

    // R2: Exact amount and spending cap
    if (
      unit?.amount?.currency_code !== "USD" ||
      unit?.amount?.value !== mandate.exactAmount ||
      Number(unit?.amount?.value) > Number(mandate.maxAmount)
    ) {
      reasons.push(
        "R2: Amount does not match exact amount or spending cap."
      );
    }

    // R3: Invoice reference
    if (unit?.custom_id !== mandate.invoiceRef) {
      reasons.push("R3: Invoice reference does not match.");
    }

    // R5: Duplicate authorization
    const duplicate = db
      .prepare(
        "SELECT authorization_id FROM used_authorizations WHERE authorization_id = ?"
      )
      .get(authorizationId);

    if (duplicate) {
      reasons.push("R5: Duplicate authorization detected.");
    }

    if (reasons.length > 0) {
      await paypal(
        `/v2/payments/authorizations/${encodeURIComponent(
          authorizationId
        )}/void`,
        "POST",
        {}
      );

      updateOrder(
        orderRecordId,
        "VOIDED",
        authorizationId,
        reasons
      );

      return {
        status: "VOIDED",
        reasons,
        authorizationId,
      };
    }

    db.prepare(
      "INSERT INTO used_authorizations VALUES (?)"
    ).run(authorizationId);

    const capture = await paypal(
      `/v2/payments/authorizations/${encodeURIComponent(
        authorizationId
      )}/capture`,
      "POST",
      {
        amount: {
          currency_code: "USD",
          value: mandate.exactAmount,
        },
        final_capture: true,
      }
    );

    const decision = [
      "All five Guardian checks passed. Payment captured.",
    ];

    updateOrder(
      orderRecordId,
      "CAPTURED",
      authorizationId,
      decision
    );

    return {
      status: "CAPTURED",
      reasons: decision,
      authorizationId,
      captureId: capture.id,
    };
  } catch (error) {
    // Keep AUTHORIZED if PayPal authorization succeeded.
    // Never falsely report that an authorized payment was voided.
    const current = getOrder(orderRecordId);

    if (current?.status === "PROCESSING") {
      updateOrder(orderRecordId, "FAILED");
    }

    throw error;
  }
}
