# PayPilot

PayPilot is a PayPal Sandbox prototype for agent initiated payouts. Choose a 1 to 60 minute undo window for each payout. If it is not undone, the server submits it through PayPal's Sandbox Payouts API.

## Run locally

1. Copy `.env.example` to `.env.local`.
2. Add your PayPal Sandbox REST app client ID and secret to `.env.local`.
3. Set `PAYPAL_AUTOMATION_ENABLED=true` to allow Sandbox payouts. Keep it `false` to prevent queued payments from being submitted.
4. Run `npm run dev` and open `http://localhost:3000`.

Use Sandbox accounts and recipients only. The amount is capped at $500 USD per payout in this prototype.

## Prototype limits

- The queue is held in the Node.js process memory. Restarting the server or using a serverless/multi-instance deployment can lose queued payments and timers. Use a durable database and a background job queue before deploying.
- This prototype has no user authentication. The API accepts payment requests from any browser that can reach it. Automated payouts are blocked in production; add authentication, authorization, audit logs, and durable idempotent job processing before enabling production payments.
- A payout accepted by PayPal may still be processing or later fail. Check the payout batch in the PayPal Sandbox dashboard for its final status.
- PayPal API errors are shown on the failed queue item. Payouts also require the Payouts capability for the REST app and a suitable Sandbox sender account; see [PayPal Payouts troubleshooting](https://developer.paypal.com/payouts/troubleshooting/).
- PayPal also restricts which countries can send Payouts. Check [supported countries and features](https://developer.paypal.com/payouts/supported-features/) before enabling this flow for an account.
- Keep credentials in `.env.local` or your deployment secret store. Never put them in `NEXT_PUBLIC_*` variables or commit them.

## REWIND persistence slice

The separate REWIND Orders domain has a Supabase persistence implementation
under `persistence/` and its initial schema in
`supabase/migrations/202611120001_s2_persistence.sql`. Apply the migration once
to a Sandbox Supabase project using its SQL Editor before using the persistence
adapter. Configure
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in server-side environment
variables only; the service-role key must never be exposed to browser code.

This S2 persistence layer is not connected to the existing Payouts dashboard or
`lib/payments.ts`. It supports atomic payment reservation, mandate and payment
reads, budget/history queries, and append-only decisions/events. The in-memory
implementation is used for isolated tests and does not require network access.

## REWIND PayPal S3 adapter

The separate Orders v2 adapter is under `paypal/`. It implements
`PaymentProvider`, requires Sandbox credentials from the server environment,
and refuses any base URL other than `https://api-m.sandbox.paypal.com`. Its
resource calls send a deterministic `PayPal-Request-Id` derived from the
payment ID and operation. The manual `ApprovalProvider` prints the Sandbox
buyer approval link and polls until PayPal reports `APPROVED`.

Run the end-to-end Sandbox smoke test with:

```sh
npm run paypal:smoke -- --payee-email sb-...@business.example.com
```

Or set `PAYPAL_SMOKE_PAYEE_EMAIL` and run `npm run paypal:smoke`. The script
creates two new Sandbox orders, waits for manual approval of each, captures
and refunds the first authorization, then voids the second and verifies the
authorization status with a GET. Use a Sandbox buyer/payee only; these orders
are external Sandbox transactions and are not deleted. Approval timeout and
poll interval can be supplied with `--timeout-ms` and `--interval-ms`.

Run `npm run supabase:smoke` to verify the configured Sandbox Supabase project.
The smoke RPC creates a mandate and payment inside a database subtransaction,
checks readback, duplicate-invoice rejection, and over-budget rejection, and
rolls the entire test transaction back. Apply
`supabase/migrations/202611120002_smoke_test_reservation.sql` in the Supabase
SQL Editor before running it. The script uses the server-only
`SUPABASE_SERVICE_ROLE_KEY` and never prints credentials or raw API bodies.
