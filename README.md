# PayPilot

PayPilot is a PayPal Sandbox prototype for agent initiated payouts. Every queued payout stays cancellable for five minutes. If it is not undone, the server submits it through PayPal's Sandbox Payouts API.

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
- Keep credentials in `.env.local` or your deployment secret store. Never put them in `NEXT_PUBLIC_*` variables or commit them.
