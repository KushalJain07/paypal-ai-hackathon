"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type Payment = {
  id: string;
  recipient: string;
  amount: string;
  note: string;
  undoMinutes: number;
  status: "pending" | "sending" | "sent" | "failed" | "cancelled";
  createdAt: number;
  executeAt: number;
  error?: string;
  batchId?: string;
};

const money = (value: string | number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(value));

function readablePaymentError(error?: string) {
  if (error && (error.includes("PAYOUT_NOT_AVAILABLE") || /country.{0,50}not allowed to send this payout/i.test(error))) {
    const debugId = error.match(/\[debug ([^\]]+)\]/)?.[1];
    return `PayPal Payouts cannot send from the country registered to this sender account. Use a payout method supported for your business location.${debugId ? ` PayPal debug ID: ${debugId}.` : ""}`;
  }
  return error;
}

export default function Home() {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [undoMinutes, setUndoMinutes] = useState("5");
  const [payments, setPayments] = useState<Payment[]>([]);
  const [sandboxReady, setSandboxReady] = useState(false);
  const [now, setNow] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = async () => {
    try {
      const response = await fetch("/api/payments", { cache: "no-store" });
      const data = await response.json();
      if (response.ok) {
        setPayments(data.payments);
        setSandboxReady(data.ready);
      }
    } catch {
      setError("Can’t reach the payment service. Check that the app server is running.");
    }
  };

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, 1500);
    const initialRefresh = window.setTimeout(() => {
      setNow(Date.now());
      void refresh();
    }, 0);

    return () => {
      window.clearInterval(timer);
      window.clearTimeout(initialRefresh);
    };
  }, []);

  const pending = useMemo(() => payments.filter((payment) => payment.status === "pending"), [payments]);
  const totalPending = pending.reduce((sum, payment) => sum + Number(payment.amount), 0);

  async function schedulePayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const response = await fetch("/api/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipient, amount, note, undoMinutes: Number(undoMinutes) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not queue payment.");
      setRecipient("");
      setAmount("");
      setNote("");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not queue payment.");
    } finally {
      setBusy(false);
    }
  }

  async function undoPayment(id: string) {
    const response = await fetch(`/api/payments/${id}`, { method: "DELETE" });
    const data = await response.json();
    if (!response.ok) setError(data.error || "This payment can no longer be undone.");
    await refresh();
  }

  function remaining(payment: Payment) {
    const ms = Math.max(0, payment.executeAt - now);
    return `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <a className="brand" href="#home" aria-label="PayPilot home"><span className="brand-mark">P</span><span>paypilot<span className="brand-dot">.</span></span></a>
        <div className="workspace"><span className="workspace-icon">◈</span><span><strong>Acme Studio</strong><small>Sandbox workspace</small></span><span className="chevron">⌄</span></div>
        <div className="nav-label">WORKSPACE</div>
        <nav className="nav"><a className="nav-item active" href="#home"><span>◫</span>Overview</a><a className="nav-item" href="#queue"><span>↗</span>Payments <span className="nav-count">{payments.length}</span></a><a className="nav-item" href="#automation"><span>✳</span>Automation</a></nav>
        <div className="side-bottom"><div className="status-card"><span className={`status-led ${sandboxReady ? "" : "offline"}`}/><span><strong>{sandboxReady ? "Sandbox connected" : "Sandbox setup needed"}</strong><small>{sandboxReady ? "Payments are test only" : "Configure server credentials"}</small></span></div><div className="profile"><div className="avatar">AS</div><span><strong>Acme Studio</strong><small>Workspace owner</small></span><span className="dots">···</span></div></div>
      </aside>

      <section className="main-area" id="home">
        <header className="topbar"><div className="breadcrumb">Workspace <span>/</span> Overview</div><div className="top-actions"><span className={`env-pill ${sandboxReady ? "" : "offline"}`}><i/> {sandboxReady ? "SANDBOX" : "NOT CONNECTED"}</span><button className="icon-button" aria-label="Notifications">♧<i/></button><div className="avatar small">AS</div></div></header>
        <div className="content">
          <div className="page-heading"><div><div className="eyebrow"><span className="sparkle">✳</span> PAYMENT AUTOMATION</div><h1>Good morning, Alex <span className="wave">✳</span></h1><p>Review agent initiated payments and step in whenever you need.</p></div><div className="heading-date"><span className="calendar">▦</span> Tuesday, November 11</div></div>

          <div className="banner"><div className="banner-icon">↶</div><div><strong>You’re in control of every payment.</strong><span>Choose an undo window for each payment. Undo it any time before the countdown ends.</span></div><a href="#automation">How it works <span>↗</span></a></div>

          <div className="metrics"><article className="metric"><div className="metric-top"><span>IN THE UNDO WINDOW</span><span className="metric-icon lilac">◷</span></div><strong className="metric-value">{pending.length.toString().padStart(2, "0")}</strong><div className="metric-foot">Agent payments waiting</div></article><article className="metric"><div className="metric-top"><span>AMOUNT ON HOLD</span><span className="metric-icon mint">＄</span></div><strong className="metric-value">{money(totalPending)}</strong><div className="metric-foot">Can still be undone</div></article><article className="metric"><div className="metric-top"><span>CURRENT SAFETY WINDOW</span><span className="metric-icon peach">⏱</span></div><strong className="metric-value">{undoMinutes} <small>min</small></strong><div className="metric-foot">Set separately per payment</div></article></div>

          <div className="columns">
            <section className="panel queue-panel" id="queue"><div className="panel-heading"><div><div className="section-kicker">LIVE QUEUE</div><h2>Payments in review <span className="count-badge">{pending.length}</span></h2></div><button className="text-button" onClick={() => void refresh()}>↻ <span>Refresh</span></button></div>
              {payments.length === 0 ? <div className="empty"><div className="empty-art"><span>↗</span><i>···</i></div><strong>Nothing in the queue yet</strong><p>When your agent schedules a payment, it’ll show up here with a custom undo window.</p></div> : <div className="payment-list">{[...payments].reverse().map((payment) => <article className="payment-row" key={payment.id}><div className={`recipient-avatar ${payment.status}`}>{payment.recipient.slice(0, 1).toUpperCase()}</div><div className="payment-info"><strong>{payment.recipient}</strong><span>{payment.note || "Agent initiated payment"} · {new Date(payment.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div><div className="payment-amount">{money(payment.amount)}<span className={`payment-state ${payment.status}`}>{payment.status === "pending" ? "Undo available" : payment.status === "sending" ? "Sending" : payment.status === "sent" ? "Submitted to PayPal" : payment.status === "cancelled" ? "Undone" : "Failed"}</span>{payment.error && <span className="row-error">{readablePaymentError(payment.error)}</span>}</div>{payment.status === "pending" ? <><div className="countdown"><span>{remaining(payment)}</span><small>remaining</small></div><button className="undo-button" onClick={() => void undoPayment(payment.id)}>Undo</button></> : <div className="done-mark">{payment.status === "sent" ? "Submitted" : payment.status === "cancelled" ? "Undone" : ""}</div>}</article>)}</div>}
            </section>

            <aside className="panel form-panel" id="automation"><div className="form-title"><span className="form-glyph">✳</span><div><div className="section-kicker">AGENT ACTION</div><h2>Schedule a payment</h2></div></div><p className="form-intro">Queue a payment on behalf of your agent. Set how long you want to review it before it’s sent through PayPal Sandbox.</p><form onSubmit={schedulePayment}><label htmlFor="recipient">Recipient email</label><div className="input-wrap"><span>✉</span><input id="recipient" type="email" autoComplete="email" placeholder="vendor@example.com" value={recipient} onChange={(event) => setRecipient(event.target.value)} required /></div><label htmlFor="amount">Amount</label><div className="input-wrap amount-wrap"><span>$</span><input id="amount" type="number" min="0.01" max="500" step="0.01" placeholder="0.00" value={amount} onChange={(event) => setAmount(event.target.value)} required /><span className="currency">USD⌄</span></div><label htmlFor="undo-minutes">Undo window <span className="optional">1–60 MINUTES</span></label><div className="input-wrap amount-wrap"><span>◷</span><input id="undo-minutes" type="number" min="1" max="60" step="1" value={undoMinutes} onChange={(event) => setUndoMinutes(event.target.value)} required /><span className="currency">MIN</span></div><label htmlFor="note">What’s this for? <span className="optional">OPTIONAL</span></label><input className="plain-input" id="note" maxLength={120} placeholder="e.g. March design retainer" value={note} onChange={(event) => setNote(event.target.value)} /><div className="hold-note"><span>◷</span><span><strong>{undoMinutes || "0"}-minute undo window</strong><small>Payment is sent automatically when the timer ends.</small></span></div>{error && <div className="form-error" role="alert">{error}</div>}<button className="submit-button" type="submit" disabled={busy || !sandboxReady}>{busy ? "Scheduling…" : <><span>✳</span> Schedule payment <span className="button-arrow">→</span></>}</button><div className="secure-note"><span>♢</span> {sandboxReady ? "PayPal Sandbox payout processing" : "Add Sandbox credentials in .env.local to enable payouts"}</div></form></aside>
          </div>
          <footer className="footer"><span>PayPilot <span className="brand-dot">.</span> <span className="footer-muted">A safer way to automate payments.</span></span><span className={sandboxReady ? "" : "offline-text"}><i/> {sandboxReady ? "PAYPAL SANDBOX CONNECTED" : "SANDBOX SETUP NEEDED"}</span></footer>
        </div>
      </section>
    </main>
  );
}
