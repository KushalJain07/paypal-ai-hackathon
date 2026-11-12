"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  formatMoney,
  Mandate,
  RewindApiError,
  rewindApi,
} from "@/components/rewind/api";

type FormFields = {
  payeeEmail: string;
  perPaymentCap: string;
  totalCap: string;
  purpose: string;
  expiresAt: string;
  undoWindow: string;
};

const emptyForm: FormFields = {
  payeeEmail: "",
  perPaymentCap: "",
  totalCap: "",
  purpose: "",
  expiresAt: "",
  undoWindow: "60",
};

function centsFromInput(value: string): number | null {
  if (!/^(?:\d+)(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const cents = Math.round(Number(value) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

function localDateTimeMinimum(): string {
  const date = new Date(Date.now() + 60_000);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

function MandateCard({
  mandate,
  busy,
  now,
  onRevoke,
}: {
  mandate: Mandate;
  busy: boolean;
  now: number;
  onRevoke: (mandate: Mandate) => void;
}) {
  const total = mandate.totalCapCents;
  const spent = Math.min(mandate.spentCents, total);
  const reserved = Math.min(mandate.reservedCents, Math.max(0, total - spent));
  const available = Math.max(0, total - spent - reserved);
  const spentWidth = total > 0 ? (spent / total) * 100 : 0;
  const reservedWidth = total > 0 ? (reserved / total) * 100 : 0;
  const status = mandate.status === "active" &&
      now > 0 && Date.parse(mandate.expiresAt) <= now
    ? "expired"
    : mandate.status;

  return (
    <article className="rw-panel rw-mandate-card">
      <div className="rw-mandate-card-head">
        <div>
          <h3>{mandate.payeeEmail}</h3>
          <p>{mandate.purpose || "No purpose specified"}</p>
        </div>
        <span className={`rw-status rw-status-${status}`}>{status}</span>
      </div>
      <div className="rw-budget-caption">
        <span>Budget used</span>
        <strong>{formatMoney(spent + reserved)} of {formatMoney(total)}</strong>
      </div>
      <div
        className="rw-budget-track"
        role="img"
        aria-label={`Spent ${formatMoney(spent)}, reserved ${formatMoney(reserved)}, available ${formatMoney(available)}`}
      >
        <span className="rw-budget-spent" style={{ width: `${spentWidth}%` }} />
        <span className="rw-budget-reserved" style={{ width: `${reservedWidth}%` }} />
      </div>
      <div className="rw-budget-legend">
        <span><i />Spent {formatMoney(spent)}</span>
        <span className="reserved"><i />Reserved {formatMoney(reserved)}</span>
        <span className="available"><i />Available {formatMoney(available)}</span>
      </div>
      <div className="rw-mandate-meta">
        <span>Per-payment cap<strong>{formatMoney(mandate.perPaymentCapCents)}</strong></span>
        <span>Undo window<strong>{mandate.undoWindowSeconds}s</strong></span>
        <span>Expires<strong>{new Date(mandate.expiresAt).toLocaleString()}</strong></span>
        <span>Mandate ID<strong title={mandate.id}>{mandate.id.slice(0, 13)}…</strong></span>
      </div>
      <div className="rw-card-actions">
        <span className="rw-section-label">VERSION {mandate.version}</span>
        {status === "active" && (
          <button
            className="rw-button rw-button-danger rw-button-small"
            disabled={busy}
            onClick={() => onRevoke(mandate)}
            type="button"
          >
            Revoke
          </button>
        )}
      </div>
    </article>
  );
}

export default function MandatesPage() {
  const [mandates, setMandates] = useState<Mandate[]>([]);
  const [fields, setFields] = useState<FormFields>(emptyForm);
  const [errors, setErrors] = useState<Partial<Record<keyof FormFields, string>>>({});
  const [serviceError, setServiceError] = useState("");
  const [success, setSuccess] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyMandate, setBusyMandate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(0);
  const [minimumExpiry, setMinimumExpiry] = useState("");

  const refresh = useCallback(async () => {
    try {
      const rows = await rewindApi.listMandates();
      setMandates(rows);
      setServiceError("");
    } catch (error) {
      setServiceError(error instanceof RewindApiError
        ? error.message
        : "Could not load mandates.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
      setMinimumExpiry(localDateTimeMinimum());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  function validate(): boolean {
    const next: Partial<Record<keyof FormFields, string>> = {};
    const payee = fields.payeeEmail.trim();
    const perPayment = centsFromInput(fields.perPaymentCap);
    const total = centsFromInput(fields.totalCap);
    const expiry = Date.parse(fields.expiresAt);
    const undo = Number(fields.undoWindow);

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payee)) {
      next.payeeEmail = "Enter a valid recipient email.";
    }
    if (perPayment === null || perPayment <= 0) {
      next.perPaymentCap = "Enter an amount greater than $0 with up to two decimals.";
    }
    if (total === null || total <= 0) {
      next.totalCap = "Enter a total budget greater than $0.";
    } else if (perPayment !== null && perPayment > total) {
      next.perPaymentCap = "The per-payment cap cannot exceed the total budget.";
    }
    if (!fields.purpose.trim()) {
      next.purpose = "Add a short purpose for this mandate.";
    } else if (fields.purpose.trim().length > 200) {
      next.purpose = "Purpose must be 200 characters or fewer.";
    }
    if (!fields.expiresAt || !Number.isFinite(expiry) || expiry <= Date.now()) {
      next.expiresAt = "Choose an expiry date and time in the future.";
    }
    if (!Number.isInteger(undo) || undo < 10 || undo > 3600) {
      next.undoWindow = "Undo window must be between 10 and 3,600 seconds.";
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSuccess("");
    setServiceError("");
    if (!validate()) return;

    setSaving(true);
    try {
      await rewindApi.createMandate({
        payeeEmail: fields.payeeEmail.trim(),
        perPaymentCapCents: centsFromInput(fields.perPaymentCap)!,
        totalCapCents: centsFromInput(fields.totalCap)!,
        purpose: fields.purpose.trim(),
        expiresAt: new Date(fields.expiresAt).toISOString(),
        undoWindowSeconds: Number(fields.undoWindow),
      });
      setFields(emptyForm);
      setErrors({});
      setSuccess("Mandate created and ready for agent payment requests.");
      await refresh();
    } catch (error) {
      setServiceError(error instanceof RewindApiError
        ? error.message
        : "Could not create this mandate.");
    } finally {
      setSaving(false);
    }
  }

  async function revoke(mandate: Mandate) {
    if (!window.confirm(`Revoke the mandate for ${mandate.payeeEmail}? New requests will be rejected.`)) {
      return;
    }
    setBusyMandate(mandate.id);
    setServiceError("");
    setSuccess("");
    try {
      await rewindApi.revokeMandate(mandate.id);
      setSuccess(`Mandate for ${mandate.payeeEmail} was revoked.`);
      await refresh();
    } catch (error) {
      setServiceError(error instanceof RewindApiError
        ? error.message
        : "Could not revoke this mandate.");
    } finally {
      setBusyMandate(null);
    }
  }

  const activeCount = mandates.filter((mandate) =>
    mandate.status === "active" && (now === 0 || Date.parse(mandate.expiresAt) > now)
  ).length;

  return (
    <>
      <div className="rw-page-heading">
        <div>
          <div className="rw-section-label">OWNER CONTROLS</div>
          <h2>Mandates</h2>
          <p>Set clear boundaries for every payment an agent is allowed to propose.</p>
        </div>
        <span className="rw-status rw-status-active">{activeCount} active</span>
      </div>

      <div className="rw-mandates-layout">
        <section className="rw-panel">
          <div className="rw-panel-title">
            <div className="rw-section-label">NEW RULE SET</div>
            <h3>Create a mandate</h3>
            <p>Amounts are entered in USD; the API stores integer cents.</p>
          </div>
          <form className="rw-form" onSubmit={submit} noValidate>
            <div className="rw-form-grid">
              <div className="rw-field">
                <label htmlFor="payee-email">Payee email</label>
                <input
                  autoComplete="email"
                  id="payee-email"
                  onChange={(event) => setFields({ ...fields, payeeEmail: event.target.value })}
                  placeholder="merchant@example.com"
                  type="email"
                  value={fields.payeeEmail}
                />
                {errors.payeeEmail && <span className="rw-field-error">{errors.payeeEmail}</span>}
              </div>
              <div className="rw-field">
                <label htmlFor="per-payment-cap">Per-payment cap (USD)</label>
                <input
                  id="per-payment-cap"
                  min="0.01"
                  onChange={(event) => setFields({ ...fields, perPaymentCap: event.target.value })}
                  placeholder="50.00"
                  step="0.01"
                  type="number"
                  value={fields.perPaymentCap}
                />
                {errors.perPaymentCap && <span className="rw-field-error">{errors.perPaymentCap}</span>}
              </div>
              <div className="rw-field">
                <label htmlFor="total-cap">Total budget (USD)</label>
                <input
                  id="total-cap"
                  min="0.01"
                  onChange={(event) => setFields({ ...fields, totalCap: event.target.value })}
                  placeholder="250.00"
                  step="0.01"
                  type="number"
                  value={fields.totalCap}
                />
                {errors.totalCap && <span className="rw-field-error">{errors.totalCap}</span>}
              </div>
              <div className="rw-field">
                <label htmlFor="undo-window">Undo window (seconds)</label>
                <input
                  id="undo-window"
                  max="3600"
                  min="10"
                  onChange={(event) => setFields({ ...fields, undoWindow: event.target.value })}
                  type="number"
                  value={fields.undoWindow}
                />
                {errors.undoWindow && <span className="rw-field-error">{errors.undoWindow}</span>}
              </div>
              <div className="rw-field">
                <label htmlFor="mandate-expiry">Expiry</label>
                <input
                  id="mandate-expiry"
                  min={minimumExpiry}
                  onChange={(event) => setFields({ ...fields, expiresAt: event.target.value })}
                  type="datetime-local"
                  value={fields.expiresAt}
                />
                {errors.expiresAt && <span className="rw-field-error">{errors.expiresAt}</span>}
              </div>
              <div className="rw-field">
                <label htmlFor="mandate-purpose">Purpose <span>({fields.purpose.length}/200)</span></label>
                <textarea
                  id="mandate-purpose"
                  maxLength={200}
                  onChange={(event) => setFields({ ...fields, purpose: event.target.value })}
                  placeholder="What are agent payments for?"
                  value={fields.purpose}
                />
                {errors.purpose && <span className="rw-field-error">{errors.purpose}</span>}
              </div>
            </div>
            {serviceError && <p className="rw-inline-error" role="alert">{serviceError}</p>}
            {success && <p className="rw-success-note" role="status">{success}</p>}
            <div className="rw-form-footer">
              <small>Mandates can be revoked at any time. Existing holds are unchanged.</small>
              <button className="rw-button rw-button-primary" disabled={saving} type="submit">
                {saving ? "Creating…" : "Create mandate"}
              </button>
            </div>
          </form>
        </section>

        <section>
          <div className="rw-panel-title" style={{ padding: "2px 0 12px", border: 0 }}>
            <div className="rw-section-label">SIGNED PAYMENT RULES</div>
            <h3 style={{ margin: "5px 0 0", fontSize: 13 }}>Mandate ledger <span className="rw-count-badge">{mandates.length}</span></h3>
          </div>
          {serviceError && !mandates.length && (
            <p className="rw-inline-error" role="alert">{serviceError}</p>
          )}
          {loading
            ? <div className="rw-panel rw-empty">Loading mandates…</div>
            : mandates.length === 0
            ? <div className="rw-panel rw-empty">No mandates yet. Create one to set payment boundaries.</div>
            : <div className="rw-mandate-list">
                {mandates.map((mandate) => (
                  <MandateCard
                    busy={busyMandate === mandate.id}
                    key={mandate.id}
                    mandate={mandate}
                    now={now}
                    onRevoke={revoke}
                  />
                ))}
              </div>}
        </section>
      </div>
    </>
  );
}
