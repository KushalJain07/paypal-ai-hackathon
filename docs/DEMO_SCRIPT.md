# REWIND demo script — 2:30

**Runtime:** 2 minutes 30 seconds. Keep the narration concise and cut waiting
time between prepared Sandbox steps. Do not imply that a Sandbox result proves
production readiness.

| Time | Screen actions | Narration |
|---|---|---|
| 0:00–0:08 | Open **Simulator**. Run **Wrong payee**; point to the failed R1 chip. | “This simulator sends an agent-shaped request for the wrong recipient. REWIND blocks it at R1 before PayPal.” |
| 0:08–0:38 | Run **Over cap**, **Reused invoice**, and **Expired mandate** in turn. Pause briefly on each failing R2, R3, or R4 result. | “R2 blocks an amount beyond the mandate or remaining budget. R3 rejects a repeated invoice. R4 rejects an expired mandate. Each result shows expected versus actual values.” |
| 0:38–0:58 | Show a prepared valid payment in **Payments** as `held`; point at its countdown and R1–R5 results. | “A valid request is authorized, read back from PayPal, and checked again. It is held—not captured—while the undo window runs.” |
| 0:58–1:10 | Let the short hold expire. Show the payment change to `captured` after the worker pass. | “When the countdown ends, the worker captures once and moves the reserved budget to spent.” |
| 1:10–1:39 | Show a second prepared `held` payment. Click **Undo**. Open the matching payment in PayPal Sandbox activity and show its authorization as `VOIDED`. | “For this second payment, I act before capture. Undo voids the authorization; when PayPal confirms `VOIDED`, the money never left.” |
| 1:39–1:57 | Show a prepared `captured` payment and click **Refund**. Show its resulting status; do not call it guaranteed. | “After capture, this is a refund, not an undo. It is a separate PayPal operation, and its success depends on PayPal and the recipient.” |
| 1:57–2:07 | Ten-second sponsor montage: payments grid, Supabase project/schema, then agent/OpenRouter source. Show Render or Zapier only as configuration/code, not a live deployment or delivery. | “AG Grid presents the payment record; Supabase backs atomic budget changes. OpenRouter is wired in the agent source, though its current demo entry point still needs an import-resolution fix.” |
| 2:07–2:30 | Return to REWIND title screen. | “Agents propose. REWIND verifies. You can still rewind.” |

## Recording notes

The demo steps above describe the intended Sandbox walkthrough; prepare and
verify each payment before recording. The repository currently has a known
dashboard integration gap: `POST /api/rewind/payments/request` omits the
approval URL that the simulator needs to open the buyer checkout. Until that
route contract is fixed, use `npm run e2e -- <scenario> --payee-email
<sandbox-payee-email>` for a valid backend flow—the script prints the manual
Sandbox approval link—or use pre-recorded, real Sandbox outcomes for the
dashboard segments. Do not present mock mode as a PayPal transaction.

The demo should show the PayPal Sandbox authorization as `VOIDED` by searching
for the prepared payment's invoice in Sandbox activity. Confirm that record is
available before recording; the dashboard API does not expose PayPal resource
IDs. Do not substitute the standalone smoke script's separate void order for
the payment shown in the REWIND dashboard.

## Pre-recording checklist

- [ ] Use a Sandbox buyer and Sandbox payee only; never use live credentials.
- [ ] Confirm the four simulator scenarios show the expected failing rule:
      wrong payee R1, over cap R2, reused invoice R3, expired mandate R4.
- [ ] Prepare an active mandate with enough total budget and a short undo
      window (10 seconds is the configured minimum).
- [ ] Prepare valid-capture, held-for-undo, and captured-for-refund records;
      verify their states and matching invoice IDs before recording.
- [ ] Pre-approve prepared Sandbox orders where possible; otherwise keep the
      Sandbox buyer logged in and ready to approve. Do not rely on Kernel until
      its live flow has been verified.
- [ ] Confirm the undo payment's PayPal Sandbox record visibly reports
      authorization status `VOIDED`.
- [ ] Check that the release worker is running, or that the dashboard fallback
      poll is active; confirm capture before beginning the narration.
- [ ] Clear unrelated demo data and browser tabs; retain only records needed
      for the walkthrough.
- [ ] Set browser zoom so the rule chips, countdown, action labels, and result
      status are readable.
- [ ] Check microphone level, screen recording, and narration timing. Record a
      backup take before the final version.
