# REWIND PRD and SRS v0.1

Payment safety layer for AI-agent transactions on PayPal. Draft of 12 Nov 2026, submission due 13 Nov afternoon. This file is the source of truth for the coding agent: every requirement has an ID, build in the order given in section 12.

## 1. Product overview

**One line:** the agent proposes, REWIND verifies, PayPal executes, and the owner can still rewind.

**Problem:** AI agents can start payments, but the owner cannot be sure the agent pays only the approved recipient, only within approved amounts, against a real invoice, before the rule expires, and only once. Even a payment that passes every rule may still be one the owner dislikes.

**Solution:** the owner defines standing rules (mandates) on a dashboard. Every agent payment is authorized at PayPal but not captured. A deterministic Guardian checks rules R1 to R5. A passing payment sits in a **hold** for an undo window, then is captured automatically. The owner can void it during the window. After capture, the owner can refund it.

**Differentiator vs AgentGuard:** AgentGuard proves a payment was authorized. REWIND does that and also lets the owner reverse a payment they did not like. Prevent first, undo second.

### Goals

- G1: no payment reaches a recipient unless R1 to R5 pass.
- G2: the owner can reverse any non-captured payment for free (void) and any captured payment via refund.
- G3: the owner sets and changes rules from a real dashboard.
- G4: every decision is stored and explainable rule by rule.
- G5: a 2 to 3 minute demo that shows five attacks blocked, one valid payment, one undo.

### Non-goals

Production hardening, user accounts and login, multi-currency, real money, WebAuthn passkeys, merkle or timestamp anchoring, human approval thresholds, the Payouts API.

### Prize targets

Best Use of PayPal + AI, Best Use of Agentic Commerce, Best Use of AG Grid, Best Use of Render, Best Demo Delivery, Most Impactful, plus top-3 overall. Optional: Postman, APIMatic, Zapier. Kernel if used for approval.

## 2. Actors

- **Owner:** creates and edits mandates, watches payments, undoes or refunds.
- **Agent:** an LLM agent that can only request payments and read status. It has no capture, void or refund authority.
- **Guardian:** server-side deterministic rule engine. No LLM, no I/O inside the rule function.
- **Payee:** the recipient PayPal account named in a mandate.
- **Judge:** watches the demo video and reads the repo.

## 3. Glossary

- **Mandate:** a standing, signed rule set: payee, per-payment cap, total cap, currency, purpose, expiry, undo window.
- **Payment:** one agent request under one mandate.
- **Authorization:** PayPal reserves funds, nothing moves to the payee yet.
- **Hold:** an authorized, verified payment waiting out its undo window.
- **Capture:** funds move to the payee.
- **Void:** release an authorization before capture. Money never leaves.
- **Refund:** return captured funds. A separate PayPal operation from void.

## 4. Scope (MoSCoW)

**Must:** mandates with signing; agent tool surface (request, status); Guardian R1 to R5; PayPal authorize, capture, void, refund on sandbox; undo window with a persisted release time and a worker; Supabase storage; owner dashboard with AG Grid; approval provider interface; README with setup; deployed on Render; demo video.

**Should:** signed decision receipt plus verify page; attack simulator page (repurposes the existing test dashboard); Zapier alert when a payment enters a hold or is rejected; Postman collection.

**Could:** APIMatic SDK from the OpenAPI spec; Kernel as approval provider; Bryntum timeline of holds.

**Won't (this version):** see non-goals.

## 5. Architecture

### Components

1. **Web app (Next.js):** owner dashboard plus API routes.
2. **Domain layer:** types, state machine, Guardian. Pure TypeScript, zero imports from PayPal or Supabase.
3. **PayPal adapter:** implements a `PaymentProvider` interface (create order, get order, authorize, capture, void, refund).
4. **Approval provider:** implements `ApprovalProvider` (vault, kernel or playwright, manual). Obtains buyer approval so an authorization exists.
5. **Repository layer:** interfaces plus Supabase implementation plus in-memory fake for tests.
6. **Orchestrator service:** runs the payment flow using the above.
7. **Release worker:** long-running loop on Render that captures held payments whose `release_at` has passed.
8. **Agent (LangChain):** tools call the orchestrator API. No capture tool exists.

### Design principles (binding)

- P1: the Guardian is a pure function: `evaluate(mandate, budgetState, observedPayment, now) -> Decision`. Deterministic, no network, no database, no LLM.
- P2: the agent never holds capture, void or refund authority. Only the server does, on Guardian pass, worker release, or owner action.
- P3: PayPal is the source of truth for what was authorized. Guardian compares mandate against data fetched from PayPal, not against what the agent claimed.
- P4: payment status changes only through the state machine in section 10. Illegal transitions throw.
- P5: budget is reserved atomically at request time and released on void, reject or refund.
- P6: all external input validated with zod at the boundary. Zod schemas are the API contract.
- P7: external services sit behind interfaces so tests run without network.
- P8: every state change and decision appends an event row. Nothing is deleted.
- P9: secrets only from environment variables, never committed, never logged.

## 6. End-to-end flow

1. Owner creates a mandate on the dashboard. Server signs it.
2. Agent calls `request_payment(mandate_id, payee_email, amount, invoice_id)`.
3. Server loads the mandate, reserves budget atomically, creates a payment row (`requested`).
4. Server creates a PayPal order with `intent=AUTHORIZE`, payee email, amount, `invoice_id`.
5. Approval provider obtains buyer approval. Server authorizes the order. Payment becomes `authorized`.
6. Server fetches the actual order and authorization from PayPal. Guardian evaluates R1 to R5 on that data.
7. Fail: void the authorization, release reserved budget, status `rejected`, store which rules failed.
8. Pass: status `held`, set `release_at = now + mandate.undo_window_seconds`, fire alert.
9. Owner clicks Undo before `release_at`: void, release budget, status `voided`.
10. Otherwise the worker captures at `release_at`: status `captured`, reserved budget moves to spent.
11. After capture the owner may refund: status `refunded`, spent budget restored.

## 7. Functional requirements

### Mandates (FR-M)

- **FR-M1** Owner can create a mandate with: payee\_email, per\_payment\_cap, total\_cap, currency (USD only), purpose (text, max 200), expires\_at, undo\_window\_seconds (10 to 3600).
- **FR-M2** Server signs the canonical JSON of the mandate fields (HMAC-SHA256 with a server secret) and stores the signature and hash. Any later field change creates a new version and signature.
- **FR-M3** Owner can edit, revoke and list mandates. Revoked mandates reject all new requests.
- **FR-M4** Mandate status: `active`, `expired`, `revoked`. Expiry is computed from `expires_at`.
- **FR-M5** Validation: per\_payment\_cap greater than 0 and not above total\_cap, expires\_at in the future, valid email.
- **FR-M6** Budget fields: `spent_total` and `reserved_total`. Available budget is `total_cap - spent_total - reserved_total`.

### Agent interface (FR-A)

- **FR-A1** Agent has exactly two tools: `request_payment` and `get_payment_status`.
- **FR-A2** `request_payment` returns the payment id and current status only, never the PayPal credentials or capture capability.
- **FR-A3** Agent tool errors are returned as structured results, not thrown.
- **FR-A4** The agent code path contains no import of the capture, void or refund functions (verified by a test or lint rule).

### Guardian rules (FR-G)

Input is the mandate, budget state, and the data observed from PayPal. Output is one record per rule with `rule`, `passed`, `expected`, `actual`.

- **FR-G1 (R1 payee)** observed payee email equals mandate payee email, case-insensitive.
- **FR-G2 (R2 amount)** observed amount is greater than 0, at most per\_payment\_cap, and at most available budget. Currency matches.
- **FR-G3 (R3 invoice)** `invoice_id` is present and has not been used before under this mandate.
- **FR-G4 (R4 expiry)** mandate is `active` and `now` is before `expires_at`.
- **FR-G5 (R5 replay)** the PayPal order id and authorization id have not been processed before, and the payment row has not already left `authorized`.
- **FR-G6** Overall verdict passes only if all five pass. All five results are always stored, even after the first failure.
- **FR-G7** Guardian has one unit test per rule for pass and fail, plus a combined-failure test. No network in these tests.

### Payment lifecycle (FR-P)

- **FR-P1** Status values: `requested`, `authorized`, `rejected`, `held`, `captured`, `voided`, `refunded`, `failed`.
- **FR-P2** Legal transitions are exactly those in section 10.
- **FR-P3** Budget reservation and the duplicate-invoice check happen in one database transaction. Two simultaneous requests cannot overspend.
- **FR-P4** PayPal API errors move the payment to `failed`, release reserved budget, and record the error without secrets.
- **FR-P5** Every PayPal call uses an idempotency key (PayPal-Request-Id) derived from the payment id and operation.

### Undo and refund (FR-U)

- **FR-U1** `held` payments show a live countdown on the dashboard.
- **FR-U2** Undo on a `held` payment voids the authorization and releases budget. Allowed only while `held`.
- **FR-U3** The worker captures `held` payments where `release_at` is at or before now. It must be safe to run twice (idempotent), and must skip payments already voided.
- **FR-U4** Race rule: if Undo and release collide, whichever transaction moves the status out of `held` first wins, the other is rejected with a clear message.
- **FR-U5** Refund on a `captured` payment calls PayPal refund, sets `refunded`, restores spent budget. UI labels it Refund, never Undo.
- **FR-U6** The worker survives restarts because release times live in the database, not in memory timers.

### Approval provider (FR-V)

- **FR-V1** `ApprovalProvider.approve(order) -> authorization-ready` is the only approval abstraction the orchestrator knows.
- **FR-V2** Three implementations selectable by env var `APPROVAL_PROVIDER`: `vault`, `kernel` (cloud browser with the sandbox buyer), `manual` (shows the approval link, owner clicks).
- **FR-V3** `manual` must always work and is the default fallback.
- **FR-V4** Spike task S0: within 45 minutes determine which provider is feasible and record the result in `docs/SPIKE.md`.

### Dashboard (FR-D)

- **FR-D1** Mandates page: create, edit, revoke, with budget bars (spent, reserved, available).
- **FR-D2** Payments page using AG Grid: columns for payee, amount, invoice, mandate, status, R1 to R5 chips, created time, actions.
- **FR-D3** Row detail shows the five rule results with expected versus actual, and the event timeline.
- **FR-D4** Held rows show countdown and an Undo button. Captured rows show a Refund button.
- **FR-D5** Dashboard reflects status changes within 3 seconds (polling is acceptable).
- **FR-D6** Simulator page (test harness): one button per attack scenario plus one valid payment. Kept separate from the owner pages.

### Audit and receipts (FR-L)

- **FR-L1** Append-only `events` table written on every status change and Guardian decision.
- **FR-L2** (Should) Each decision produces a signed receipt (HMAC over canonical JSON), viewable and verifiable at `/receipt/:id`.

### Integrations (FR-S)

- **FR-S1** (Should) Zapier webhook fires on `held` and `rejected` with payment summary.
- **FR-S2** (Should) Postman collection and OpenAPI spec generated from zod schemas.

## 8. Non-functional requirements

- **NFR-1 Determinism:** same inputs to the Guardian always produce the same output.
- **NFR-2 Safety:** sandbox only. Startup refuses to run if a live PayPal base URL is configured.
- **NFR-3 Setup:** a fresh clone runs with `npm install`, copy `.env.example`, `npm run dev`. Plus one SQL migration file for Supabase.
- **NFR-4 Testing:** unit tests for domain and Guardian, integration tests for the orchestrator using fakes, one sandbox smoke script.
- **NFR-5 Observability:** structured logs with payment id, never secrets.
- **NFR-6 Performance:** Guardian decision under 50 ms excluding network. Dashboard update lag under 3 s.
- **NFR-7 Secrets:** Supabase service key and PayPal secrets only server-side.
- **NFR-8 Security (honest scope):** no user auth in this version. Documented in README as a known limitation.

## 9. Data model (Supabase Postgres)

**mandates:** id, version, payee\_email, per\_payment\_cap, total\_cap, spent\_total, reserved\_total, currency, purpose, expires\_at, undo\_window\_seconds, status, signature, created\_at.

**payments:** id, mandate\_id, invoice\_id, amount, currency, payee\_email, paypal\_order\_id, authorization\_id, capture\_id, status, release\_at, failure\_reason, created\_at, updated\_at. Unique constraint on (mandate\_id, invoice\_id). Unique constraints on paypal\_order\_id and authorization\_id.

**decisions:** id, payment\_id, rule (R1 to R5), passed, expected, actual, created\_at.

**events:** id, payment\_id, type, from\_status, to\_status, detail (json), created\_at. Append only.

## 10. State machine

- requested to authorized, failed
- authorized to held, rejected, failed
- held to captured, voided, failed
- captured to refunded
- rejected, voided, refunded, failed are terminal

## 11. API (draft)

- `POST /api/mandates`, `GET /api/mandates`, `PATCH /api/mandates/:id`, `POST /api/mandates/:id/revoke`
- `POST /api/payments/request` (agent facing)
- `GET /api/payments`, `GET /api/payments/:id`
- `POST /api/payments/:id/undo`, `POST /api/payments/:id/refund`
- `POST /api/worker/release` (cron or manual trigger, same logic as the worker loop)
- `GET /api/receipts/:id`

All bodies validated with zod. Errors use one shape: `{ error: { code, message } }`.

## 12. Build order (vertical slices)

Each slice ends with passing tests and something demoable. Do not start a slice before the previous one is green.

- **S0 Spike (parallel, one person):** PayPal sandbox AUTHORIZE order, then test vault, then kernel or playwright, then manual. Output `docs/SPIKE.md`. Also confirm capture, void, refund each work on sandbox.
- **S1 Domain:** types, zod schemas, state machine, Guardian R1 to R5 with tests.
- **S2 Persistence:** SQL migration, repository interfaces, in-memory fake, Supabase implementation, atomic reserve function.
- **S3 PayPal adapter:** `PaymentProvider` plus sandbox smoke script (create, authorize, capture, void, refund).
- **S4 Orchestrator:** request, authorize, guardian, hold, release, undo, refund, with fakes in tests.
- **S5 Agent tools and API routes:** wire LangChain tools to the API, enforce FR-A4.
- **S6 Worker:** release loop, idempotency, restart safety, Render service.
- **S7 Dashboard:** mandates page, AG Grid payments page, detail drawer, simulator.
- **S8 Polish:** receipts, Zapier, Postman, README, deployment, demo recording.

If time runs short, cut from the bottom: S8 first, then simulator extras. Never cut S1 to S4.

## 13. Rules for the coding agent (copy into AGENTS.md)

- Read this file before any task. Implement only the requirement IDs named in the task.
- One slice per task. Do not touch files outside the slice unless required, and say why.
- The domain folder must not import from PayPal, Supabase, Next or any network library.
- Every FR needs a test or a documented manual check before it is marked done.
- Validate all external input with zod. No `any`. Strict TypeScript.
- Never add capture, void or refund to anything the agent can call.
- Never log or commit secrets. Update `.env.example` when adding variables.
- Before reporting done: run lint, typecheck and tests, and paste the results.
- If a requirement is unclear or conflicts, stop and ask instead of guessing.
- Keep functions small, name by behavior, no dead code, no TODO without a requirement ID.

## 14. Definition of done

- All Must requirements pass their tests.
- Five attack scenarios each fail the correct rule and void the authorization.
- One valid payment is held, then captured by the worker with no human action.
- One held payment is undone and the sandbox shows the authorization voided.
- One captured payment is refunded.
- Fresh clone setup works from the README.
- Deployed on Render and reachable.

## 15. Demo and submission checklist

- Video 2 to 3 minutes: open with an attack, show all five attacks blocked with the rule highlighted, one valid payment, countdown, undo, then refund after capture. State clearly: undo before money moves, refund after.
- Show each sponsor tool for a few seconds with a one-line explanation of how it is used.
- Repo with README: what it is, architecture diagram, setup in three steps, env variables, limitations.
- Text description: problem, mandates and R1 to R5, undo and refund distinction, what is live in sandbox, difference from existing mandate-only approaches.
- Record a backup demo run before the final take. Test setup on a fresh clone. Submit with at least one hour of buffer.

## 16. Assumptions and open items

- A1: Orders v2 with `intent=AUTHORIZE` is available on the sandbox app. Verify in S0.
- A2: how a sandbox buyer balance displays during an authorization hold is unverified. Verify in S0 and adjust demo wording.
- A3: vaulting combined with AUTHORIZE may be blocked. Fallback chain in FR-V2.
- A4: Payee email on the order is settable and readable back. Verify in S0, since R1 depends on it.
- A5: PayPal authorization honor period is far longer than any undo window used here.
- A6: Render free tier may sleep. Use a paid or always-on worker, or trigger release through the cron endpoint, and verify before recording.
