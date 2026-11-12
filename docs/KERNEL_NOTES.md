# Kernel approval notes

The Kernel approval provider is intentionally opt-in (`APPROVAL_PROVIDER=kernel`);
manual approval remains the default. It uses a named persistent Kernel profile with
stealth enabled, and only treats a PayPal Orders API status of `APPROVED` as success.
The checkout page wording is never interpreted as approval.

No live Sandbox run was attempted in this workspace because the required Kernel API
key and Sandbox-buyer credentials were not supplied. Therefore there is no observed
captcha, bot check, or 2FA block to report. If a live run reaches one of those checks,
stop the run, record the exact visible blocker here, and retain manual approval; do
not add a bypass beyond Kernel stealth.

Kernel references verified on 12 November 2026:

- https://www.kernel.sh/browsers — TypeScript SDK, CDP connection, session deletion.
- https://www.kernel.sh/ai-library/reliable-web-access-ai-agents — `stealth`, named
  profiles, `save_changes`, live view, and cleanup guidance.
- https://www.kernel.sh/docs/api-reference/browsers/list-browser-sessions — returned
  `cdp_ws_url`, `browser_live_view_url`, and session fields.
