# PayPilot implementation context and integration status

This note describes the main authored code paths and the generated
`paypal-integration/.next/dev` folder as they appear in this checkout. It
records the current implementation and its relationship to the stated goal:
an AI agent that makes payments, signs mandates, and can undo incorrect
payments.

## `src`

This folder contains four TypeScript files in three subfolders. It is a
standalone agent/PayPal Checkout path, separate from the Next.js dashboard
workflow described below.

- `src/config/env.ts` loads environment variables through `dotenv/config`,
  validates required values with Zod, and exports the validated `env` object.
  PayPal credentials and OpenRouter settings are required. The PayPal base URL
  and checkout return/cancel URLs have defaults.
- `src/paypal/paypal-client.ts` defines a PayPal REST API client. It obtains
  and reuses an OAuth access token, makes authenticated API requests, and
  provides operations to create, retrieve, and capture checkout orders. Order
  creation validates the amount and three-letter currency format and sends
  return/cancel URLs from the environment configuration.
- `src/agent/payment-agent.ts` configures a LangChain agent using
  `ChatOpenRouter`. It exposes two tools to the model: create a PayPal order
  and retrieve an order's status/captures. The create tool returns the
  PayPal approval URL when available. This agent does not expose the client's
  capture operation as a tool. Tool inputs are checked with Zod, and PayPal
  errors are returned as tool results.
- `src/index.ts` is a command-line entry point. It invokes the agent with a
  sample request to create a USD 50 order for "Premium News service," then
  prints the final agent message. It logs execution errors and sets a failing
  process exit code.

The modules are connected as follows: `index.ts` invokes the payment agent;
the agent reads configuration and calls the PayPal client; the PayPal client
also reads the validated configuration. These files implement PayPal Checkout
order operations rather than defining the Next.js pages or API routes.

## Next.js application: `app`

The `app` folder defines the browser dashboard and its HTTP route handlers.

- `app/page.tsx` is a client-side payment dashboard. It displays the queue,
  pending totals, a countdown, and a form for recipient email, USD amount,
  note, and undo window. It polls `GET /api/payments` about every 1.5 seconds,
  submits the form to `POST /api/payments`, and sends `DELETE
  /api/payments/{id}` when the user clicks Undo. The form is submitted by a
  human through the UI; this page does not invoke `paymentAgent`.
- `app/api/payments/route.ts` implements `GET` and `POST` for the queue.
  `GET` returns the in-memory payment list and a `ready` flag. The flag checks
  that the process is not in production, `PAYPAL_AUTOMATION_ENABLED` is
  exactly `true`, and both PayPal credential variables are non-empty. This is
  a configuration check, not a live PayPal connectivity or credential check.
  `POST` rejects requests when that check fails, parses JSON, validates an
  email address, an amount from USD 0.01 to USD 500.00 with at most two decimal
  places, an optional note up to 120 characters, and an integer undo period
  from 1 to 60 minutes. A valid request is handed to `schedulePayment`.
- `app/api/payments/[id]/route.ts` implements deletion by payment ID. It calls
  `cancelPayment`, returning 404 for an unknown ID and 409 when the payment is
  no longer pending.
- `app/layout.tsx` provides the shared HTML layout, Geist font variables, and
  page metadata.
- `app/globals.css` contains the Tailwind import and the dashboard's custom
  styling, including responsive layout rules.
- `app/favicon.ico` is the app icon.

The dashboard text describes the queue as agent-initiated, but the code in
this page provides a user-operated form. There is no API or code path here
that calls the LangChain `paymentAgent`.

## Payment queue and payout execution: `lib/payments.ts`

This module contains the runtime state and scheduling logic used by the
dashboard API:

1. A payment is assigned an ID, starts in `pending`, and receives an
   `executeAt` timestamp.
2. A Node.js timer is created for the selected 1–60 minute interval.
   `cancelPayment` can clear that timer and mark the payment `cancelled` while
   the status is still `pending`.
3. When the timer fires, `submitPayout` changes the status to `sending`,
   obtains a PayPal OAuth token using the configured client credentials, then
   posts a one-item request to PayPal's Sandbox Payouts endpoint.
4. On an accepted API response, the module stores the returned batch ID, when
   present, and marks the item `sent`. On an error, it marks the item `failed`
   and stores an error message.

The module uses an in-process `Map` stored on `globalThis`, with timers held
alongside the payment records. This is not durable storage: restarting the
process loses the queue and timers. It does not poll PayPal for a payout
batch's final state, and `sent` means the payout request was accepted by the
API, not that the recipient's funds have been confirmed as delivered. A
PayPal payout, once submitted, is not reversed by this code.

The Payouts URL is hard-coded to PayPal Sandbox. Submission also checks that
automation is enabled and refuses to execute in production. The API routes do
not implement user authentication or authorization.

## Generated output: `.next/dev`

This is Next.js development output. At the time this note was written it
contained 289 files. It is not the primary place to edit application behavior;
the corresponding authored application files are outside this folder.
Individual generated names and counts can change when Next.js runs again.

The direct entries include:

- `build/`: generated JavaScript chunks and source maps used by the development
  build.
- `cache/`: Turbopack development cache data.
- `logs/`: development log output.
- `server/`: server-side compiled output and metadata for app routes, including
  page and payment API route artifacts present in this snapshot.
- `static/`: browser-facing JavaScript chunks, development client files, and
  static media used by the running app.
- `types/`: generated TypeScript declarations and route validation metadata.
- JSON manifests: build/chunk, fallback build, route, and prerender metadata.
- `trace`: Next.js trace data about build/runtime activity.
- `package.json`: marks this generated output directory as CommonJS.

The generated route type metadata lists `/api/payments` and
`/api/payments/[id]`. Generated artifacts can be incomplete or temporarily out
of sync while the development server is running; use authored files under
`app/` as the source of truth.

## Current integration status against the stated goal

The repository currently has two distinct payment implementations:

| Area | Implemented behavior | Boundary in the current code |
|---|---|---|
| LangChain agent in `src/` | Uses OpenRouter to create PayPal Checkout orders and retrieve their status. The create tool returns an approval URL. | The agent is not connected to the Next.js UI or API. It does not create Payouts API payments, sign mandates, or expose the client's capture operation as a tool. |
| Next.js app and `lib/payments.ts` | A person can queue a Sandbox payout to an email address, set a delay, cancel it before the timer expires, and view its queue status. After the delay, the server submits it to PayPal Sandbox Payouts. | Queue creation is from the dashboard form, not an AI decision. The delay is a pre-send cancellation window; it is not an undo/reversal after submission. No mandate signing or mandate lifecycle is implemented. |

No code found in these paths implements mandate creation, mandate signing,
recording a signer's consent, or using a signed mandate to authorize a
payment. The current two implementations use different PayPal flows:
PayPal Checkout orders with buyer approval in `src/paypal/paypal-client.ts`,
and email-recipient Payouts in `lib/payments.ts`. They are not wired into a
single end-to-end agent workflow.

The README describes the app as a Sandbox prototype and notes its lack of
authentication, process-memory queue, production payout block, and need to
check PayPal's payout batch for final status. At the time of inspection, the
local `.env` had PayPal and OpenRouter variables populated, but
`PAYPAL_AUTOMATION_ENABLED` was unset. Consequently, the app's `ready` check
would be false and its payment-creation API would reject requests until that
flag is enabled. The presence of environment values does not establish that
the credentials are valid or that the PayPal app/account can send payouts.
Secret values are intentionally not included here. `.env` files are ignored by
Git; `.env.example` currently documents the PayPal payout variables.

No test files were present under `tests/` at the time of inspection. The
package scripts provide `dev`, `build`, `start`, and `lint`.

## Additional scope

The repository also contains configuration, public assets, and project
documentation outside the folders described in detail above. In particular,
`README.md` documents the local run flow and prototype constraints. Do not
infer that `src/` alone represents the complete application, or that generated
files in `.next/dev/` are independent source definitions.
