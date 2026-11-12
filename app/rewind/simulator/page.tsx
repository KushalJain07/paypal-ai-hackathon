"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  CreateMandateInput,
  formatMoney,
  GuardianRule,
  Mandate,
  PaymentRow,
  RewindApiError,
  rewindApi,
  RuleResult,
} from "@/components/rewind/api";

type Scenario = "valid" | "wrong-payee" | "over-cap" | "reused-invoice" | "expired";

const scenarios: Array<{
  id: Scenario;
  title: string;
  description: string;
  icon: string;
}> = [
  { id: "valid", title: "Valid payment", description: "Passes Guardian and enters the undo hold.", icon: "✓" },
  { id: "wrong-payee", title: "Wrong payee", description: "R1 should block a recipient mismatch.", icon: "R1" },
  { id: "over-cap", title: "Over cap", description: "R2 should block an amount above mandate limits.", icon: "R2" },
  { id: "reused-invoice", title: "Reused invoice", description: "R3 should reject the duplicate invoice.", icon: "R3" },
  { id: "expired", title: "Expired mandate", description: "Creates a short-lived mandate, then tests R4.", icon: "R4" },
];

const ruleOrder: GuardianRule[] = ["R1", "R2", "R3", "R4", "R5"];

function centsForValid(mandate: Mandate): number {
  return Math.max(1, Math.min(1250, mandate.perPaymentCapCents));
}

function makeInvoice(): string {
  return `demo-${crypto.randomUUID()}`;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function currentTime(): number {
  return Date.now();
}

function ResultRules({ results }: { results: RuleResult[] }) {
  const byRule = new Map(results.map((result) => [result.rule, result]));
  return (
    <div className="rw-rule-list">
      {ruleOrder.map((rule) => {
        const result = byRule.get(rule);
        const deferred = rule === "R5" && result &&
          JSON.stringify(result.actual).includes("deferred");
        return (
          <div className="rw-rule-row" key={rule}>
            <span className={`rw-rule-chip ${!result || deferred ? "rw-rule-deferred" : result.passed ? "rw-rule-pass" : "rw-rule-fail"}`}>
              {rule}
            </span>
            <div>
              <strong>{result
                ? `${result.phase} · ${deferred ? "deferred" : result.passed ? "passed" : "failed"}`
                : "No rule result returned"}</strong>
              <div className="rw-rule-values">
                <span><b>Expected</b>{result ? JSON.stringify(result.expected) : "—"}</span>
                <span><b>Actual</b>{result ? JSON.stringify(result.actual) : "—"}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function SimulatorPage() {
  const [mandates, setMandates] = useState<Mandate[]>([]);
  const [selectedMandateId, setSelectedMandateId] = useState("");
  const [result, setResult] = useState<PaymentRow | null>(null);
  const [scenarioTitle, setScenarioTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  const [error, setError] = useState("");
  const [approvalError, setApprovalError] = useState("");
  const [agentAmount, setAgentAmount] = useState("5.00");
  const [agentInvoice, setAgentInvoice] = useState("");
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentMessage, setAgentMessage] = useState("");
  const [agentError, setAgentError] = useState("");

  const loadMandates = useCallback(async () => {
    try {
      const rows = await rewindApi.listMandates();
      setMandates(rows);
      setSelectedMandateId((current) =>
        rows.some((item) => item.id === current)
          ? current
          : rows.find((item) => item.status === "active")?.id ?? rows[0]?.id ?? ""
      );
    } catch (reason) {
      setError(reason instanceof RewindApiError ? reason.message : "Could not load mandates.");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadMandates(), 0);
    return () => window.clearTimeout(timer);
  }, [loadMandates]);

  const selectedMandate = mandates.find((item) => item.id === selectedMandateId);

  async function createExpiredMandate(source: Mandate): Promise<Mandate> {
    const expiresAt = new Date(currentTime() + 5500).toISOString();
    const input: CreateMandateInput = {
      payeeEmail: source.payeeEmail,
      perPaymentCapCents: source.perPaymentCapCents,
      totalCapCents: Math.max(source.totalCapCents, source.perPaymentCapCents),
      purpose: "REWIND simulator: expired mandate test",
      expiresAt,
      undoWindowSeconds: source.undoWindowSeconds,
    };
    const mandate = await rewindApi.createMandate(input);
    await loadMandates();
    setBusyLabel("Letting the test mandate expire…");
    const wait = Math.max(0, Date.parse(expiresAt) - currentTime() + 400);
    await sleep(wait);
    return mandate;
  }

  async function runScenario(scenario: Scenario) {
    if (!selectedMandate) {
      setError("Create or select a mandate before running a scenario.");
      return;
    }
    setBusy(true);
    setError("");
    setApprovalError("");
    setResult(null);
    const selected = selectedMandate;
    const invoiceId = makeInvoice();
    try {
      let mandate = selected;
      if (scenario === "expired") {
        setBusyLabel("Creating a short-lived mandate…");
        mandate = await createExpiredMandate(selected);
      }

      const validAmount = centsForValid(mandate);
      let request = {
        mandateId: mandate.id,
        payeeEmail: mandate.payeeEmail,
        amountCents: validAmount,
        invoiceId,
      };
      if (scenario === "wrong-payee") {
        request = { ...request, payeeEmail: "wrong.recipient@example.net" };
      } else if (scenario === "over-cap") {
        request = {
          ...request,
          amountCents: mandate.perPaymentCapCents + 100,
        };
      }

      setBusyLabel(
        scenario === "reused-invoice"
          ? "Recording the invoice, then retrying it…"
          : "Requesting payment and running Guardian…",
      );
      if (scenario === "reused-invoice") {
        await rewindApi.requestPayment(request);
      }
      const payment = await rewindApi.requestPayment(request);
      setResult(payment);
      setScenarioTitle(scenarios.find((item) => item.id === scenario)?.title ?? "Scenario");
    } catch (reason) {
      setError(reason instanceof RewindApiError ? reason.message : "Scenario could not be completed.");
    } finally {
      setBusy(false);
      setBusyLabel("");
    }
  }

  async function approve() {
    if (!result) return;
    setBusy(true);
    setBusyLabel("Verifying authorization…");
    setApprovalError("");
    try {
      const updated = await rewindApi.authorizePayment(result.id);
      setResult(updated);
      setScenarioTitle("Valid payment · approved");
    } catch (reason) {
      setApprovalError(reason instanceof RewindApiError
        ? reason.message
        : "Could not complete authorization.");
    } finally {
      setBusy(false);
      setBusyLabel("");
    }
  }

  async function askAgent(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedMandate || selectedMandate.status !== "active") {
      setAgentError("Select an active mandate before asking the agent.");
      return;
    }
    const amount = Number(agentAmount);
    const amountCents = Math.round(amount * 100);
    if (!Number.isFinite(amount) || amountCents <= 0 ||
      Math.abs(amount * 100 - amountCents) > 0.000001) {
      setAgentError("Enter a positive amount with no more than two decimal places.");
      return;
    }
    const invoiceId = agentInvoice.trim() || `agent-${crypto.randomUUID()}`;
    setAgentInvoice(invoiceId);
    setAgentBusy(true);
    setAgentError("");
    setAgentMessage("");
    try {
      const response = await fetch("/api/rewind/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mandateId: selectedMandate.id,
          payeeEmail: selectedMandate.payeeEmail,
          amountCents,
          invoiceId,
        }),
        cache: "no-store",
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const errorBody = body && typeof body === "object" && "error" in body
          ? (body as { error?: { message?: string } }).error
          : undefined;
        throw new Error(errorBody?.message ?? "The payment agent request failed.");
      }
      if (!body || typeof body !== "object" || !("action" in body)) {
        throw new Error("The agent returned an invalid response.");
      }
      const resultBody = body as {
        message?: unknown;
        action?: {
          tool?: unknown;
          success?: unknown;
          paymentId?: unknown;
          approvalUrl?: unknown;
          error?: { message?: unknown };
        } | null;
      };
      setAgentMessage(typeof resultBody.message === "string" ? resultBody.message : "");
      const action = resultBody.action;
      if (action?.tool !== "request_payment") {
        throw new Error("The agent did not submit a payment request. Review its response and try again.");
      }
      if (action.success !== true || typeof action.paymentId !== "string") {
        throw new Error(
          typeof action.error?.message === "string"
            ? action.error.message
            : "The agent's payment request did not complete.",
        );
      }
      const detail = await rewindApi.getPayment(action.paymentId);
      setResult({
        ...detail.payment,
        approvalUrl: typeof action.approvalUrl === "string" ? action.approvalUrl : null,
      });
      setScenarioTitle("Agent payment request");
      setApprovalError("");
    } catch (reason) {
      setAgentError(reason instanceof Error
        ? reason.message
        : "The payment agent request failed.");
    } finally {
      setAgentBusy(false);
    }
  }

  const isValidRequested = result?.status === "requested";
  const isRejected = result?.status === "rejected";
  const ruleResults = result?.decisions ?? [];

  return (
    <>
      <div className="rw-page-heading">
        <div>
          <div className="rw-section-label">SAFE DEMONSTRATION HARNESS</div>
          <h2>Simulator</h2>
          <p>Exercise a valid payment and the main Guardian checks without giving the agent payment controls.</p>
        </div>
        <Link className="rw-button rw-button-secondary" href="/rewind/payments">View payments ↗</Link>
      </div>

      <section className="rw-panel rw-agent-panel">
        <div className="rw-panel-title">
          <div className="rw-section-label">LIVE AGENT REQUEST</div>
          <h3>Ask the agent to propose a payment</h3>
          <p>The agent submits only a request. The server applies the mandate Guardian; the agent cannot authorize, capture, undo, or refund.</p>
        </div>
        <form className="rw-agent-form" onSubmit={(event) => void askAgent(event)}>
          <div className="rw-agent-form-grid">
            <label className="rw-field">
              <span>Active mandate</span>
              <select
                onChange={(event) => setSelectedMandateId(event.target.value)}
                value={selectedMandateId}
                required
              >
                {mandates.filter((mandate) => mandate.status === "active").map((mandate) => (
                  <option key={mandate.id} value={mandate.id}>
                    {mandate.payeeEmail} · {mandate.id.slice(0, 8)}
                  </option>
                ))}
                {!mandates.some((mandate) => mandate.status === "active") &&
                  <option value="">No active mandates</option>}
              </select>
            </label>
            <label className="rw-field">
              <span>Amount (USD)</span>
              <input
                min="0.01"
                step="0.01"
                type="number"
                value={agentAmount}
                onChange={(event) => setAgentAmount(event.target.value)}
                required
              />
            </label>
            <label className="rw-field">
              <span>Invoice ID</span>
              <input
                maxLength={127}
                value={agentInvoice}
                onChange={(event) => setAgentInvoice(event.target.value)}
                placeholder="Generated if left blank"
              />
            </label>
            <button
              className="rw-button rw-button-primary"
              disabled={agentBusy || !mandates.some((mandate) => mandate.status === "active")}
              type="submit"
            >
              {agentBusy ? "Agent is checking…" : "Ask agent to request payment"}
            </button>
          </div>
          {agentBusy && <div className="rw-loading" role="status">Calling the agent and submitting through the real REWIND API…</div>}
          {agentError && <p className="rw-inline-error" role="alert">{agentError}</p>}
          {agentMessage && <p className="rw-agent-message" role="status">{agentMessage}</p>}
        </form>
      </section>

      <div className="rw-sim-layout">
        <section className="rw-panel">
          <div className="rw-panel-title">
            <div className="rw-section-label">CHOOSE A TEST</div>
            <h3>Run a scenario</h3>
            <p>Each attack uses the request API and shows the returned rule results.</p>
          </div>
          <div className="rw-simulator-select">
            <label htmlFor="sim-mandate">Mandate</label>
            <select
              id="sim-mandate"
              onChange={(event) => setSelectedMandateId(event.target.value)}
              value={selectedMandateId}
            >
              {mandates.length === 0 && <option value="">No mandates available</option>}
              {mandates.map((mandate) => (
                <option key={mandate.id} value={mandate.id}>
                  {mandate.payeeEmail} · {mandate.status} · {mandate.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </div>
          <div className="rw-scenario-list">
            {scenarios.map((scenario) => (
              <button
                className="rw-scenario-button"
                disabled={busy || !selectedMandate}
                key={scenario.id}
                onClick={() => void runScenario(scenario.id)}
                type="button"
              >
                <span className="rw-scenario-icon">{scenario.icon}</span>
                <span><strong>{scenario.title}</strong><small>{scenario.description}</small></span>
              </button>
            ))}
          </div>
          {busy && <div className="rw-loading" role="status">{busyLabel || "Working…"}</div>}
          {error && <p className="rw-inline-error" role="alert" style={{ margin: "0 14px 14px" }}>{error}</p>}
        </section>

        <section className="rw-panel">
          <div className="rw-panel-title">
            <div className="rw-section-label">LATEST RUN</div>
            <h3>Guardian result</h3>
            <p>Rule outcomes are returned by the payment request or authorization flow.</p>
          </div>
          {!result
            ? <div className="rw-empty">Choose a scenario to see what the Guardian observed.</div>
            : (
              <div className="rw-result-card">
                <div className="rw-result-head">
                  <div>
                    <h3>{scenarioTitle}</h3>
                    <p>{result.payee} · {formatMoney(result.amountCents)} · invoice {result.invoice}</p>
                  </div>
                  <span className={`rw-status rw-status-${result.status}`}>{result.status}</span>
                </div>
                <ResultRules results={ruleResults} />
                {isValidRequested && (
                  <div className="rw-approval-box">
                    <strong>PayPal buyer approval</strong>
                    <p>
                      Approve the Sandbox order in PayPal. Authorization will then be verified and held for
                      the mandate&apos;s undo window.
                    </p>
                    {result.approvalUrl
                      ? <a href={result.approvalUrl} target="_blank" rel="noreferrer">Open PayPal Sandbox approval ↗</a>
                      : <span className="rw-field-error">Approval URL was not included in the API response.</span>}
                    <div className="rw-result-actions">
                      <button
                        className="rw-button rw-button-primary"
                        disabled={busy || !result.approvalUrl}
                        onClick={() => void approve()}
                        type="button"
                      >
                        I approved it
                      </button>
                    </div>
                    {approvalError && <p className="rw-inline-error" role="alert">{approvalError}</p>}
                  </div>
                )}
                {isRejected && (
                  <p className="rw-success-note">Blocked before authorization. No buyer approval or capture was requested.</p>
                )}
                {result.status !== "requested" && (
                  <div className="rw-result-actions">
                    <Link className="rw-button rw-button-secondary" href="/rewind/payments">
                      Open payments ↗
                    </Link>
                  </div>
                )}
                <div className="rw-ids" style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid #edf0f4" }}>
                  <div className="rw-id-row"><span>Payment ID</span><code>{result.id}</code></div>
                  <div className="rw-id-row"><span>Mandate ID</span><code>{result.mandateId}</code></div>
                </div>
              </div>
            )}
        </section>
      </div>
      <p className="rw-simulator-footnote">
        Sandbox only. The simulator does not capture, void, or refund directly; owner actions remain on the Payments page.
      </p>
    </>
  );
}
