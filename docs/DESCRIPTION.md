# REWIND

AI agents can act quickly—and send money to the wrong person, exceed a budget,
reuse an invoice, or repeat a payment. A mandate records what an owner approved,
but it does not leave time to change their mind after a specific payment is
authorized.

REWIND is a PayPal Sandbox payment safety layer. Owners set a standing mandate
for a payee, payment and total limits, purpose, expiry, and undo window. Its
LangChain/OpenRouter agent has request and status tools only; its direct Node
demo currently fails on an extensionless import, so a live agent invocation is
unverified.

The server runs a deterministic Guardian against every request. It checks the
payee, amount and available budget, invoice uniqueness, mandate validity, and
replay identifiers. A request that passes is reserved atomically in Supabase,
then sent to PayPal as an `AUTHORIZE` order. After buyer approval, REWIND reads
the order and authorization back from PayPal and checks again. A passing
payment waits in a held state until its undo window ends; the worker then
captures it. Before capture, the owner can Undo by voiding the authorization.
After capture, Refund is a separate PayPal operation and is not guaranteed.

The repo includes the dashboard, AG Grid payment history, Supabase API and
worker, Sandbox adapter, and tests. The recorded Sandbox spike confirms manual
approval, authorization/readback, and a void request; it does not record a
completed capture/refund flow.

Unlike mandate-only approaches, mandates prove intent; REWIND adds a hold and
undo window so an owner can still reverse an authorized payment before capture.
The project uses AG Grid and Supabase; OpenRouter is wired in the agent source
but its current direct Node entry point does not start. A Render Blueprint,
optional Zapier webhook, and Kernel approval provider are present, but live
Render, Zapier, and Kernel runs are not verified here.

Next: close the dashboard approval-link gap, verify the full Sandbox flow from
the dashboard through capture, test optional integrations live, and add
authentication, receipts, and an OpenAPI/Postman collection before production
use.
