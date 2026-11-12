"use client";

import { useEffect, useRef, useState } from "react";

type Mandate = {
  id: string;
  payee: string;
  exactAmount: string;
  maxAmount: string;
  invoiceRef: string;
  expiresAt: number;
};

type Result = {
  status: string;
  reasons: string[];
  authorizationId?: string;
  captureId?: string;
};

export default function RewindPage() {
  const [payee, setPayee] = useState("");
  const [exactAmount, setExactAmount] = useState("25.00");
  const [maxAmount, setMaxAmount] = useState("25.00");
  const [invoiceRef, setInvoiceRef] = useState("");
  const [expiry, setExpiry] = useState("30");

  const [mandate, setMandate] = useState<Mandate | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;

    const params = new URLSearchParams(window.location.search);
    const rewind = params.get("rewind");

    if (rewind === "cancelled") {
      handled.current = true;
      setMessage("PayPal approval was cancelled. No payment was captured.");
      window.history.replaceState({}, "", "/rewind");
      return;
    }

    if (rewind !== "approved") return;

    const orderRecordId = params.get("orderRecordId");
    const paypalOrderId = params.get("token");

    if (!orderRecordId || !paypalOrderId) {
      setMessage("Missing PayPal return information. Contact the demo operator.");
      window.history.replaceState({}, "", "/rewind");
      return;
    }

    handled.current = true;
    window.history.replaceState({}, "", "/rewind");

    async function processPayment() {
      setLoading(true);
      setMessage("PayPal approved. REWIND Guardian is checking the payment...");

      try {
        const response = await fetch("/api/rewind", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "authorize-and-guard",
            orderRecordId,
            paypalOrderId,
          }),
        });

        const data = await response.json();

        if (!response.ok) throw new Error(data.error || "Guardian processing failed.");

        setResult(data.result);
        setMessage("");
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Processing failed.");
      } finally {
        setLoading(false);
      }
    }

    processPayment();
  }, []);

  async function createMandate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage("");
    setResult(null);

    try {
      const response = await fetch("/api/rewind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create-mandate",
          payee,
          exactAmount,
          maxAmount,
          invoiceRef,
          expiresInMinutes: Number(expiry),
        }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Mandate creation failed.");

      setMandate(data.mandate);
      setMessage("Mandate created and saved. Ready for PayPal authorization.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Request failed.");
    } finally {
      setLoading(false);
    }
  }

  async function startPayment() {
    if (!mandate) return;

    setLoading(true);
    setMessage("Creating PayPal Sandbox authorization order...");

    try {
      const response = await fetch("/api/rewind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create-order",
          mandateId: mandate.id,
        }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Order creation failed.");

      window.location.assign(data.order.approvalUrl);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Order creation failed.");
      setLoading(false);
    }
  }

  return (
    <main style={{
      minHeight: "100vh",
      background: "#080d18",
      color: "#f8fafc",
      padding: "40px 20px",
      fontFamily: "Arial, sans-serif"
    }}>
      <div style={{ maxWidth: 850, margin: "0 auto" }}>
        <a href="/" style={{ color: "#94a3b8", textDecoration: "none" }}>
          ← Back to PayPilot
        </a>

        <header style={{ margin: "35px 0" }}>
          <div style={{ color: "#38bdf8", fontWeight: 700, letterSpacing: 3 }}>
            PAYMENT SECURITY SYSTEM
          </div>
          <h1 style={{ fontSize: 48, margin: "12px 0" }}>🛡 REWIND</h1>
          <p style={{ color: "#94a3b8", lineHeight: 1.7 }}>
            Deterministic payment guardian for AI-agent transactions.
            Define the mandate. Authorize through PayPal. Let Guardian decide.
          </p>
        </header>

        <section style={{
          background: "#111827",
          border: "1px solid #263449",
          borderRadius: 18,
          padding: 25,
          marginBottom: 22
        }}>
          <h2 style={{ fontSize: 23 }}>01 / Create payment mandate</h2>
          <p style={{ color: "#94a3b8", fontSize: 14 }}>
            Set the exact payment conditions before authorization.
          </p>

          <form onSubmit={createMandate}>
            {[
              { label: "Authorized payee email", value: payee, setter: setPayee, type: "email", placeholder: "merchant@example.com" },
              { label: "Exact payment amount (USD)", value: exactAmount, setter: setExactAmount, type: "number", placeholder: "25.00" },
              { label: "Maximum spending cap (USD)", value: maxAmount, setter: setMaxAmount, type: "number", placeholder: "25.00" },
              { label: "Invoice reference", value: invoiceRef, setter: setInvoiceRef, type: "text", placeholder: "INV-2026-001" },
              { label: "Mandate expiry (minutes)", value: expiry, setter: setExpiry, type: "number", placeholder: "30" },
            ].map((field) => (
              <label key={field.label} style={{
                display: "block",
                marginTop: 17,
                color: "#cbd5e1",
                fontSize: 14
              }}>
                {field.label}
                <input
                  required
                  type={field.type}
                  min={field.type === "number" ? "0.01" : undefined}
                  step={field.type === "number" ? "0.01" : undefined}
                  value={field.value}
                  onChange={(e) => field.setter(e.target.value)}
                  placeholder={field.placeholder}
                  style={{
                    display: "block",
                    boxSizing: "border-box",
                    width: "100%",
                    marginTop: 8,
                    padding: 13,
                    borderRadius: 9,
                    border: "1px solid #334155",
                    background: "#080d18",
                    color: "white",
                    outline: "none"
                  }}
                />
              </label>
            ))}

            <button disabled={loading} type="submit" style={buttonStyle}>
              {loading ? "Please wait..." : "Create Guardian Mandate →"}
            </button>
          </form>
        </section>

        {mandate && (
          <section style={panelStyle}>
            <h2>02 / Mandate created</h2>
            <p><strong>Payee:</strong> {mandate.payee}</p>
            <p><strong>Exact amount:</strong> ${mandate.exactAmount} USD</p>
            <p><strong>Maximum cap:</strong> ${mandate.maxAmount} USD</p>
            <p><strong>Invoice:</strong> {mandate.invoiceRef}</p>
            <p style={{ fontSize: 11, color: "#94a3b8", overflowWrap: "anywhere" }}>
              Mandate ID: {mandate.id}
            </p>

            <button
              disabled={loading}
              onClick={startPayment}
              style={buttonStyle}
            >
              {loading ? "Please wait..." : "Continue to PayPal Sandbox →"}
            </button>
          </section>
        )}

        {loading && (
          <section style={panelStyle}>
            <h2>Guardian processing</h2>
            <p>{message}</p>
          </section>
        )}

        {result && (
          <section style={{
            ...panelStyle,
            borderColor: result.status === "CAPTURED" ? "#16a34a" : "#dc2626"
          }}>
            <h2 style={{
              color: result.status === "CAPTURED" ? "#4ade80" : "#f87171",
              fontSize: 27
            }}>
              {result.status === "CAPTURED" ? "✓ PAYMENT CAPTURED" : "✕ PAYMENT VOIDED"}
            </h2>

            <h3>Guardian decision</h3>
            {result.reasons.map((reason, index) => (
              <p key={index} style={{ color: "#cbd5e1" }}>• {reason}</p>
            ))}

            {result.authorizationId && (
              <p style={{ overflowWrap: "anywhere", fontSize: 12 }}>
                Authorization ID: {result.authorizationId}
              </p>
            )}

            {result.captureId && (
              <p style={{ overflowWrap: "anywhere", fontSize: 12 }}>
                Capture ID: {result.captureId}
              </p>
            )}
          </section>
        )}

        {message && !loading && (
          <p style={{
            background: "#172033",
            padding: 15,
            borderRadius: 10,
            color: "#cbd5e1",
            overflowWrap: "anywhere"
          }}>
            {message}
          </p>
        )}

        <section style={{
          ...panelStyle,
          marginTop: 25
        }}>
          <h3>Guardian security rules</h3>
          {[
            "R1 — Verify authorized payee",
            "R2 — Verify exact amount and spending cap",
            "R3 — Verify invoice reference",
            "R4 — Verify mandate expiry",
            "R5 — Detect duplicate authorization",
          ].map((rule) => (
            <p key={rule} style={{ color: "#cbd5e1" }}>✓ {rule}</p>
          ))}
          <p style={{ color: "#64748b", fontSize: 12 }}>
            PayPal Sandbox only. This prototype is not configured for live payments.
          </p>
        </section>
      </div>
    </main>
  );
}

const buttonStyle: React.CSSProperties = {
  width: "100%",
  marginTop: 23,
  padding: 15,
  border: 0,
  borderRadius: 10,
  background: "#2563eb",
  color: "white",
  fontSize: 16,
  fontWeight: 700,
  cursor: "pointer"
};

const panelStyle: React.CSSProperties = {
  background: "#111827",
  border: "1px solid #263449",
  borderRadius: 18,
  padding: 25,
  marginBottom: 22,
  lineHeight: 1.7
};