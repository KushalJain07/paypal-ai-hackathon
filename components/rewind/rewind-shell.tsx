"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const navigation = [
  { href: "/rewind/mandates", label: "Mandates", icon: "◈" },
  { href: "/rewind/payments", label: "Payments", icon: "↗" },
  { href: "/rewind/simulator", label: "Simulator", icon: "⌁" },
];

export function RewindShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="rewind-shell">
      <aside className="rewind-sidebar">
        <Link className="rewind-brand" href="/rewind/payments">
          <span className="rewind-brand-mark">R</span>
          <span>REWIND<span className="rewind-brand-period">.</span></span>
        </Link>
        <div className="rewind-workspace">
          <span className="rewind-workspace-mark">◉</span>
          <span><strong>Sandbox workspace</strong><small>PayPal · USD</small></span>
          <span className="rewind-chevron">⌄</span>
        </div>
        <p className="rewind-nav-label">PAYMENT CONTROL</p>
        <nav className="rewind-nav" aria-label="REWIND dashboard">
          {navigation.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                className={`rewind-nav-link${active ? " is-active" : ""}`}
                href={item.href}
                key={item.href}
                aria-current={active ? "page" : undefined}
              >
                <span className="rewind-nav-icon" aria-hidden="true">{item.icon}</span>
                {item.label}
                {item.label === "Payments" &&
                  <span className="rewind-nav-dot" aria-hidden="true" />}
              </Link>
            );
          })}
        </nav>
        <div className="rewind-sidebar-bottom">
          <div className="rewind-safety-note">
            <span className="rewind-status-led" />
            <div><strong>Sandbox mode</strong><small>No real money moves</small></div>
          </div>
          <div className="rewind-profile">
            <span className="rewind-avatar">OW</span>
            <span><strong>Workspace owner</strong><small>Owner controls</small></span>
          </div>
        </div>
      </aside>
      <div className="rewind-main">
        <header className="rewind-topbar">
          <div className="rewind-breadcrumb">Workspace <span>/</span> REWIND</div>
          <div className="rewind-topbar-right">
            <span className="rewind-env-pill"><i /> SANDBOX</span>
            <span className="rewind-topbar-caption">Payment safety console</span>
          </div>
        </header>
        <main className="rewind-content">
          <div className="rewind-page-brand">
            <div>
              <div className="rewind-eyebrow">PAYMENT SAFETY LAYER</div>
              <h1>REWIND</h1>
              <p>Agents propose. REWIND verifies. You can still rewind.</p>
            </div>
            <div className="rewind-trust-stamp">
              <span>✳</span><div><strong>Rules before release</strong><small>Every payment. Every time.</small></div>
            </div>
          </div>
          {children}
          <footer className="rewind-footer">
            <span><i /> All payment actions are guarded by mandate rules.</span>
            <span>REWIND · Sandbox environment</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
