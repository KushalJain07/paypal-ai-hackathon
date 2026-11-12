"use client";

import {
  AllCommunityModule,
  ColDef,
  ICellRendererParams,
  ModuleRegistry,
  themeQuartz,
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  displayValue,
  formatMoney,
  GuardianRule,
  PaymentDetail,
  PaymentRow,
  RewindApiError,
  rewindApi,
  RuleResult,
} from "@/components/rewind/api";

ModuleRegistry.registerModules([AllCommunityModule]);

const ruleOrder: GuardianRule[] = ["R1", "R2", "R3", "R4", "R5"];
const gridTheme = themeQuartz.withParams({
  backgroundColor: "#ffffff",
  foregroundColor: "#26344f",
  headerBackgroundColor: "#f9fafc",
  borderColor: "#e5e9ef",
  rowHoverColor: "#f6f7fc",
  fontFamily: "Arial, Helvetica, sans-serif",
  fontSize: "11px",
});

function ruleTitle(result: RuleResult): string {
  const expected = displayValue(result.expected);
  const actual = displayValue(result.actual);
  return `${result.rule} · ${result.phase}\nExpected: ${expected}\nActual: ${actual}`;
}

function RulesCell({ data }: ICellRendererParams<PaymentRow>) {
  if (!data) return null;
  const byRule = new Map(data.decisions.map((result) => [result.rule, result]));
  return (
    <span className="rw-rule-chips" aria-label="Guardian rules">
      {ruleOrder.map((rule) => {
        const result = byRule.get(rule);
        const deferred = rule === "R5" &&
          result?.actual &&
          typeof result.actual === "object" &&
          JSON.stringify(result.actual).includes("deferred");
        const className = !result || deferred
          ? "rw-rule-deferred"
          : result.passed
          ? "rw-rule-pass"
          : "rw-rule-fail";
        const title = result
          ? ruleTitle(result)
          : `${rule}: no result returned yet`;
        return (
          <span className={`rw-rule-chip ${className}`} key={rule} title={title}>
            {rule}
          </span>
        );
      })}
    </span>
  );
}

function StatusCell({ data }: ICellRendererParams<PaymentRow>) {
  if (!data) return null;
  return <span className={`rw-status rw-status-${data.status}`}>{data.status}</span>;
}

function Countdown({ releaseAt }: { releaseAt: string | null }) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    const initial = window.setTimeout(() => setNow(Date.now()), 0);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(initial);
    };
  }, []);
  if (!releaseAt) return <span className="rw-countdown">—</span>;
  const seconds = now
    ? Math.max(0, Math.ceil((Date.parse(releaseAt) - now) / 1000))
    : 0;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return (
    <span className="rw-countdown" aria-label={seconds ? `${seconds} seconds until release` : "Ready to capture"}>
      {seconds ? `${minutes}:${String(remainder).padStart(2, "0")} left` : "Releasing"}
    </span>
  );
}

function RuleDetail({ result }: { result?: RuleResult }) {
  if (!result) {
    return (
      <div className="rw-rule-row">
        <span className="rw-rule-chip rw-rule-deferred">—</span>
        <div><strong>Not evaluated</strong><span className="rw-rule-values">No decision result was returned.</span></div>
      </div>
    );
  }
  const deferred = result.rule === "R5" && JSON.stringify(result.actual).includes("deferred");
  return (
    <div className="rw-rule-row">
      <span className={`rw-rule-chip ${deferred ? "rw-rule-deferred" : result.passed ? "rw-rule-pass" : "rw-rule-fail"}`}>
        {result.rule}
      </span>
      <div>
        <strong>{result.rule} · {result.phase} · {deferred ? "deferred" : result.passed ? "passed" : "failed"}</strong>
        <div className="rw-rule-values">
          <span><b>Expected</b><code>{displayValue(result.expected)}</code></span>
          <span><b>Observed</b><code>{displayValue(result.actual)}</code></span>
        </div>
      </div>
    </div>
  );
}

function PaymentDrawer({
  detail,
  loading,
  error,
  onClose,
}: {
  detail: PaymentDetail | null;
  loading: boolean;
  error: string;
  onClose: () => void;
}) {
  if (!detail && !loading && !error) return null;
  const payment = detail?.payment;
  const byRule = new Map((detail?.decisions ?? payment?.decisions ?? [])
    .map((result) => [result.rule, result]));

  return (
    <>
      <button className="rw-drawer-backdrop" onClick={onClose} aria-label="Close payment details" />
      <aside className="rw-drawer" aria-label="Payment details">
        <div className="rw-drawer-head">
          <div>
            <div className="rw-section-label">PAYMENT DETAIL</div>
            <h2>{payment ? formatMoney(payment.amountCents) : "Loading payment…"}</h2>
            {payment && <p>{payment.payee} · {payment.invoice}</p>}
          </div>
          <button className="rw-icon-button" onClick={onClose} type="button" aria-label="Close">×</button>
        </div>
        {loading && !detail
          ? <div className="rw-loading">Loading rules and event history…</div>
          : error
          ? <p className="rw-inline-error" role="alert">{error}</p>
          : detail && (
            <>
              <section className="rw-drawer-section">
                <h3>Guardian decision · R1–R5</h3>
                <div className="rw-rule-list">
                  {ruleOrder.map((rule) => <RuleDetail key={rule} result={byRule.get(rule)} />)}
                </div>
              </section>
              <section className="rw-drawer-section">
                <h3>Payment timeline</h3>
                <div className="rw-timeline">
                  {detail.events.length
                    ? detail.events.map((event, index) => (
                      <div className="rw-timeline-item" key={`${event.type}-${index}`}>
                        <span className="rw-timeline-dot" />
                        <div>
                          <strong>{event.type.replaceAll("_", " ")}</strong>
                          <small>
                            {event.from ? `${event.from} → ${event.to ?? "—"} · ` : ""}
                            {new Date(event.createdAt).toLocaleString()}
                          </small>
                        </div>
                      </div>
                    ))
                    : <div className="rw-empty">No events recorded.</div>}
                </div>
              </section>
              <section className="rw-drawer-section">
                <h3>Payment identifiers</h3>
                <div className="rw-ids">
                  <div className="rw-id-row"><span>Payment ID</span><code>{payment?.id}</code></div>
                  <div className="rw-id-row"><span>Mandate ID</span><code>{payment?.mandateId}</code></div>
                  <div className="rw-id-row"><span>PayPal order</span><code>{detail.paypalOrderId ?? "Not available"}</code></div>
                  <div className="rw-id-row"><span>Authorization</span><code>{detail.authorizationId ?? "Not available"}</code></div>
                  <div className="rw-id-row"><span>Capture</span><code>{detail.captureId ?? "Not available"}</code></div>
                </div>
              </section>
            </>
          )}
      </aside>
    </>
  );
}

export default function PaymentsPage() {
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [selectedDetail, setSelectedDetail] = useState<PaymentDetail | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [drawerError, setDrawerError] = useState("");
  const [pollError, setPollError] = useState("");
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const polling = useRef(false);
  const gridRef = useRef<AgGridReact<PaymentRow>>(null);

  const poll = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    try {
      await rewindApi.releaseDue();
      const rows = await rewindApi.listPayments();
      setPayments([...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      setPollError("");
    } catch (error) {
      setPollError(error instanceof RewindApiError ? error.message : "Could not refresh payment activity.");
    } finally {
      polling.current = false;
    }
  }, []);

  useEffect(() => {
    void poll();
    const pollTimer = window.setInterval(() => void poll(), 3000);
    return () => {
      window.clearInterval(pollTimer);
    };
  }, [poll]);

  const rowAction = useCallback(async (payment: PaymentRow, action: "undo" | "refund") => {
    setBusy((current) => ({ ...current, [payment.id]: true }));
    setRowErrors((current) => ({ ...current, [payment.id]: "" }));
    try {
      if (action === "undo") await rewindApi.undoPayment(payment.id);
      else await rewindApi.refundPayment(payment.id);
      await poll();
      if (selectedDetail?.payment.id === payment.id) {
        const detail = await rewindApi.getPayment(payment.id);
        setSelectedDetail(detail);
      }
    } catch (error) {
      setRowErrors((current) => ({
        ...current,
        [payment.id]: error instanceof RewindApiError
          ? error.message
          : `Could not ${action} this payment.`,
      }));
    } finally {
      setBusy((current) => ({ ...current, [payment.id]: false }));
    }
  }, [poll, selectedDetail?.payment.id]);

  const fetchDetail = useCallback(async (paymentId: string) => {
    setSelectedDetail(null);
    setDrawerError("");
    setDrawerLoading(true);
    try {
      setSelectedDetail(await rewindApi.getPayment(paymentId));
    } catch (error) {
      setDrawerError(error instanceof RewindApiError
        ? error.message
        : "Could not load payment detail.");
    } finally {
      setDrawerLoading(false);
    }
  }, []);

  const columnDefs = useMemo<ColDef<PaymentRow>[]>(() => [
    {
      field: "payee",
      headerName: "Payee",
      minWidth: 170,
      flex: 1.15,
      cellRenderer: ({ data }: ICellRendererParams<PaymentRow>) => data
        ? <span>
            <span className="rw-grid-open-row">{data.payee}</span>
            <small className="rw-cell-secondary">Mandate {data.mandateId.slice(0, 10)}…</small>
          </span>
        : null,
    },
    {
      field: "amountCents",
      headerName: "Amount",
      minWidth: 96,
      valueFormatter: ({ value }) => formatMoney(Number(value ?? 0)),
      cellClass: "rw-cell-primary",
    },
    {
      field: "invoice",
      headerName: "Invoice",
      minWidth: 120,
      flex: .8,
      cellRenderer: ({ value }: ICellRendererParams<PaymentRow>) => (
        <span className="rw-cell-primary" title={String(value ?? "")}>{value}</span>
      ),
    },
    {
      field: "status",
      headerName: "Status",
      minWidth: 110,
      cellRenderer: StatusCell,
    },
    {
      colId: "guardian",
      headerName: "Guardian",
      minWidth: 124,
      cellRenderer: RulesCell,
    },
    {
      field: "createdAt",
      headerName: "Created",
      minWidth: 150,
      valueFormatter: ({ value }) => value ? new Date(String(value)).toLocaleString() : "—",
    },
    {
      colId: "actions",
      headerName: "Actions",
      minWidth: 180,
      maxWidth: 220,
      sortable: false,
      filter: false,
      cellRenderer: ({ data }: ICellRendererParams<PaymentRow>) => {
        if (!data) return null;
        const action = data.status === "held" ? "undo" : data.status === "captured" ? "refund" : null;
        if (!action) return <span className="rw-cell-secondary">—</span>;
        return (
          <div className="rw-grid-action-cell" onClick={(event) => event.stopPropagation()}>
            {data.status === "held" && <Countdown releaseAt={data.releaseAt} />}
            <button
              className={`rw-button rw-button-small ${action === "undo" ? "rw-button-secondary" : "rw-button-primary"}`}
              disabled={Boolean(busy[data.id])}
              onClick={() => void rowAction(data, action)}
              type="button"
            >
              {busy[data.id] ? "Working…" : action === "undo" ? "Undo" : "Refund"}
            </button>
            {rowErrors[data.id] && <small className="rw-field-error" title={rowErrors[data.id]}>Error</small>}
          </div>
        );
      },
    },
  ], [busy, rowAction, rowErrors]);

  const openDetail = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.closest(".rw-grid-action-cell, button")) return;
    const rowIndex = Number(target.closest(".ag-row")?.getAttribute("row-index"));
    if (!Number.isInteger(rowIndex) || rowIndex < 0) return;
    const payment = gridRef.current?.api.getDisplayedRowAtIndex(rowIndex)?.data;
    if (payment) void fetchDetail(payment.id);
  }, [fetchDetail]);

  const heldCount = payments.filter((payment) => payment.status === "held").length;
  const capturedCount = payments.filter((payment) => payment.status === "captured").length;

  return (
    <>
      <div className="rw-page-heading">
        <div>
          <div className="rw-section-label">LIVE PAYMENT QUEUE</div>
          <h2>Payments</h2>
          <p>Every request is checked before it moves. Held funds remain reversible until release.</p>
        </div>
        <div className="rw-grid-actions">
          <span className="rw-status rw-status-held">{heldCount} held</span>
          <span className="rw-status rw-status-captured">{capturedCount} captured</span>
        </div>
      </div>
      {pollError && <p className="rw-inline-error" role="alert">{pollError}</p>}
      <section className="rw-panel rw-grid-panel" aria-label="Payments table">
        <div className="rw-grid-toolbar">
          <div><strong>Payment activity</strong><small>Updated automatically every 3 seconds · click a row for its decision record</small></div>
          <div className="rw-grid-actions">
            <span className="rw-section-label">WORKER POLL ACTIVE</span>
            <button className="rw-button rw-button-secondary rw-button-small" onClick={() => void poll()} type="button">
              ↻ Refresh
            </button>
          </div>
        </div>
        <div className="rw-grid-wrap" onClick={openDetail}>
          <AgGridReact<PaymentRow>
            ref={gridRef}
            columnDefs={columnDefs}
            defaultColDef={{ resizable: true, sortable: true, suppressHeaderMenuButton: true }}
            getRowId={({ data }) => data.id}
            rowData={payments}
            rowHeight={59}
            theme={gridTheme}
            tooltipShowDelay={250}
          />
        </div>
        {payments.length === 0 && !pollError && (
          <div className="rw-empty">No payment requests yet. Use the Simulator to create a sandbox payment.</div>
        )}
      </section>
      <PaymentDrawer
        detail={selectedDetail}
        error={drawerError}
        loading={drawerLoading}
        onClose={() => {
          setSelectedDetail(null);
          setDrawerLoading(false);
          setDrawerError("");
        }}
      />
    </>
  );
}
