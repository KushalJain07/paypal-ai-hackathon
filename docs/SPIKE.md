# S0 PayPal Sandbox spike

This report contains only observed results. Approval URLs, access tokens, client
IDs, and client secrets are never recorded here.

## Configuration and scope

- `PAYPAL_BASE_URL` was unset during initial inspection; the application
  configuration defaults to `https://api-m.sandbox.paypal.com`.
- Sandbox credential variables were present. Their values were not displayed
  or copied into this report.
- All API operations in this spike are restricted by the script to the exact
  Sandbox base URL.
- Test payee: `sb-kcpio53471342@business.example.com`.
- Test amount: USD 50.00.
- First test invoice: `rewind-s0-spike-20261112-01`.
- The void scenario completed: buyer approval was registered, the order was
  authorized, payee/amount/invoice fields were readable from the order, and the
  authorization void request was accepted.
- A separate capture/refund scenario is pending buyer approval.

## Results

The script appends each observed result below. An absent result means the step
has not run; it is not evidence of success or failure.

## Approval-provider observations

- **Vault scope check:** completed. The Sandbox OAuth token did not include the
  vault/payment-token readwrite scope. This indicates the scope was not granted
  to this app token; no saved payment method was created or tested.
- **Manual approval:** the first order reached PayPal order status `APPROVED`
  even though the browser displayed a repeated “Continue to Review” step.
  Authorization and void then succeeded through the Orders API.
- **Kernel/Playwright:** not tested.

## S3 Sandbox smoke test

The staged S0 helper has been replaced by the S3 end-to-end Sandbox smoke
script. It creates fresh orders, prints each approval link, polls until manual
buyer approval is observed, then authorizes and completes a capture/refund
flow followed by a separate authorize/void flow:

```sh
npm run paypal:smoke -- --payee-email <sandbox-payee-email>
```

The smoke test also reads the order back and checks the payee, amount, currency,
invoice, and authorization ID. It creates persistent Sandbox transactions; use
only Sandbox accounts. The previous staged capture/refund order noted below is
historical and is not resumed by this script.
- **Sandbox vault scope check: PASS** — OAuth token does not include the vault/payment-token readwrite scope.


### void scenario — order creation
- **Create AUTHORIZE order: PASS** — order_id=4HA079699W446582T; status=CREATED; invoice_id=rewind-s0-spike-20261112-01; amount_usd=50.00; payee_email=sb-kcpio53471342@business.example.com; approval_link=returned (not stored)
- **Read-only order status: PASS** — order_id=4HA079699W446582T; status=APPROVED; intent=AUTHORIZE; payee_email_readable=true; invoice_id_readable=true; amount_readable=true; approval_links=self,update,authorize


### void scenario — order 4HA079699W446582T
- **Authorize approved order: PASS** — order_id=4HA079699W446582T; status=COMPLETED; authorization_id=52P66626D5026873M

- **GET order data readability: PASS** — payee_email_readable=true; payee_email=sb-kcpio53471342@business.example.com; amount_readable=true; amount=50.00 USD; invoice_id_readable=true; invoice_id=rewind-s0-spike-20261112-01; status=COMPLETED

- **Void authorization: PASS** — authorization_id=52P66626D5026873M; result=void request accepted

### capture-refund scenario — order creation
- **Create AUTHORIZE order: PASS** — order_id=7D050875XX858180S; status=CREATED; invoice_id=rewind-s0-spike-20261112-01-capture; amount_usd=50.00; payee_email=sb-kcpio53471342@business.example.com; approval_link=returned (not stored)
