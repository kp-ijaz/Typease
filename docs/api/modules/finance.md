# Finance module (customer money)

Quotations, invoices, payments, refunds, credit notes, expenses, pass-through liabilities, reconciliation and
PDF documents of a typing centre. Code: `services/api/src/modules/finance`, schemas:
`packages/validation/src/finance.ts`.

This module is about the money between a **centre and its customers**. The money between a centre and
TypEase (SaaS subscription) is a different module with different tables and a different webhook route: see
`subscriptions.md`. The two only share the payment-gateway *adapters*.

All paths are under `/api/v1`. Every amount in a request is a decimal string or number with at most two
decimals; every amount in a response is a **two-decimal string** (`"150.00"`). Lists return
`{ data, meta: { page, pageSize, total, totalPages } }` and accept `page`, `pageSize`, `sort=field:asc|desc`, `q`.

## 1. Who sees what

| Caller | Sees |
| --- | --- |
| Staff | Rows of their branches (`allBranches=false` limits them). Operators who hold `request.read.assigned` but not `request.read.all` only see quotations / invoices / refunds of requests assigned to them. |
| Customer (`self.payments`) | Their own quotations (once sent), invoices (once issued), payments, receipts and credit notes. Never drafts, never an invoice that was voided **before it was issued** (draft -> void; `status = VOID` with `issuedAt = null`), never internal fields (discount approval, void reason, who recorded a payment, reconciliation). An invoice the customer did receive stays visible after it was voided, as `VOID`. |
| Corporate admin (`corp.invoices.read`, `corp.requests.approve`) | The same, for their own company only. |
| Another tenant | Nothing: every lookup by id is a `404`. |

Filters can only narrow this scope, never widen it (a customer passing someone else's `customerId` gets an empty list).
The invoice rule above is one filter (`CUSTOMER_VISIBLE_INVOICE` in `finance.core.ts`) applied to
`GET /invoices`, `GET /invoices/:id`, the PDF, `POST /invoices/:id/pay`, `GET /corporate/invoices`, the
`finance.invoices` list inside `GET /requests/:id` and the customer's privacy export; a hidden invoice answers
`404` by id. Staff see drafts and voided drafts as before.

**Merged customers.** Issued invoices and completed payments are immutable, so after `POST /customers/merge`
they keep the id of the retired record (`retainedOnSource` in the merge response); drafts, quotations and
unfinished payments move to the kept record. Finance treats the records as one customer:
- the `customerId` filter of `GET /quotations`, `GET /invoices` and `GET /payments` resolves the merge history
  (`customers.mergedIntoId` of records with status `MERGED`): filtering on the kept record also returns what
  stayed on the retired ones, and filtering on a retired id returns the same full set. `meta.total` counts all
  of them; the other filters still narrow the result. An id of another centre matches nothing;
- a signed-in customer's own scope includes the rows that stayed on records merged into theirs, so they see
  those invoices, payments and receipts and can pay an open one (`POST /invoices/:id/pay`). A record that
  points at another one without having status `MERGED` is not part of anybody else's scope.
The rows themselves are unchanged: `customerId` in a response is still the id the document was issued to.
Reports that break figures down **by customer** (`outstanding-payments`) use the same rule: the row is the
record that was kept (see `reports.md`). The implementation is shared: `common/merged-customers.ts`.

## 2. Money rules

### Lines and totals
Every line has a `component`: `SERVICE_FEE`, `GOVERNMENT_FEE` or `THIRD_PARTY_FEE`.

```
gross     = round2(quantity x unitAmount)
lineNet   = gross - discountAmount            (a discount can never exceed the line)
taxAmount = round2(lineNet x taxRatePercent / 100)      half-up, per line
lineTotal = lineNet + taxAmount

subtotalServiceFee / subtotalGovernmentFee / subtotalThirdParty = sum(gross) per component (gross of discount)
discountTotal = sum(discountAmount)      taxTotal = sum(taxAmount)
total = subtotalServiceFee + subtotalGovernmentFee + subtotalThirdParty - discountTotal + taxTotal
```

Default tax rate of a line (an explicit `taxRatePercent` on the line always wins):

- line linked to a service (`serviceId`): from the service's `taxMode` - `SERVICE_FEE_ONLY` (the centre's
  `taxRatePercent` on service-fee lines, 0 on the others), `ALL_COMPONENTS`, `NONE`;
- free-form line: the centre's rate when the fee component is marked `taxable`, otherwise 0.

Discounts are allowed on **service-fee lines only** (`422 DISCOUNT_ON_PASS_THROUGH` otherwise): government and
third-party fees are collected on behalf of others.

### Fee components and accounting treatment
`fee_components` (three rows per centre) say how each component is treated: the service fee is always
`REVENUE`; government and third-party fees default to `PASS_THROUGH_LIABILITY` and are **never reported as
centre revenue**. The owner can change name / treatment / taxable / ledger code. A change of treatment
applies to payments recorded from then on and stamps a review note; the API returns a notice that the
treatment must be reviewed with an accountant.

### Invoice balance and status
`balanceDue = total - amountCredited - amountPaid + amountRefunded` (database check constraint), re-derived in
the same transaction as every payment, refund and credit note:

| Situation | Status |
| --- | --- |
| nothing paid, balance > 0 | `ISSUED` |
| something paid (net of refunds), balance > 0 | `PARTIALLY_PAID` |
| balance 0 | `PAID` (also a zero-total invoice) |
| balance 0, nothing paid net of refunds, something credited | `CREDITED` |

An issued invoice is immutable (API and database trigger): its lines, amounts, customer and number never
change. Corrections are credit notes; `void` only while nothing was paid or credited.

### Pass-through liabilities
When money is allocated to an invoice, the share that belongs to the authority / third party is accrued in
`liability_entries` (append-only):

> After every payment the accrued government-fee (third-party) liability of the invoice is brought up to
> `round2(netPaid x componentTotal / invoiceTotal)`, where `componentTotal` is the sum of the line totals
> of that component (after credit notes) and `netPaid` is everything paid minus everything refunded.

So a partial payment is spread over the components **in proportion to the invoice**, the share is computed
on the cumulative amount (after full payment exactly the component totals have been accrued - no rounding
drift between instalments), and the **rounding remainder always falls on the service-fee share**.
Example: invoice 340.00 = service 105.00 + government 200.00 + third party 35.00; a payment of 100.00 accrues
58.82 government and 10.29 third party, the remaining 30.89 is service fee.

- `ACCRUAL` on payment; `REVERSAL` on refund (proportional by the same rule, or the explicit breakdown of the
  refund) and when a credit note changes the split; `REMITTANCE` when an expense pays the money out.
- Components whose treatment is `REVENUE` are not accrued.
- Outstanding liability = accruals - reversals - remittances, per component and per request.

## 3. Endpoints

### Fee components and liabilities
| Method | Path | Access | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/finance/fee-components` | `finance.settings`, `report.financial` or `payment.reconcile` | - | `{ notice, components: [{ type, name, treatment, taxable, ledgerCode, reviewNote }] }` |
| PUT | `/finance/fee-components` | `finance.settings` | `{ components: [{ type, name?, treatment?, taxable?, ledgerCode? }] }` | same as GET. `422 SERVICE_FEE_IS_REVENUE` when trying to make the service fee pass-through. |
| GET | `/finance/liabilities` | `report.financial` or `payment.reconcile` | query `branchId?, requestId?, component?, outstandingOnly?, page, pageSize` | `{ currency, components: [{ component, name, treatment, accrued, reversed, remitted, outstanding }], totalOutstanding, requests: { data: [{ requestId, requestNo, customer, service, governmentFee: {...}, thirdPartyFee: {...}, outstanding }], meta } }` |

### Quotations
| Method | Path | Access | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/quotations` | `quotation.read`, `self.payments`, `corp.requests.read`, `corp.requests.approve`, `corp.invoices.read` | query `status, customerId, requestId, corporateAccountId, branchId, from, to, discountApproval, q` | page of quotations |
| POST | `/quotations` | `quotation.manage` | `{ customerId, branchId?, requestId?, corporateAccountId?, validUntil?, notes?, discountReason?, items: [{ serviceId?, description, component, quantity=1, unitAmount, discountAmount=0, taxRatePercent? }] }` | quotation with `quotationItems` (status `DRAFT`) |
| POST | `/quotations/from-request/:requestId` | `quotation.manage` | `{ validUntil?, notes?, serviceFeeDiscount?, discountReason? }` | quotation built from the service price |
| GET | `/quotations/:id` | as list | - | quotation + `invoice` (once approved) + `expired` |
| GET | `/quotations/:id/pdf` | as list | - | `application/pdf` |
| PATCH | `/quotations/:id` | `quotation.manage` | `{ validUntil?, notes?, discountReason?, items? }` | quotation. `409 QUOTATION_NOT_DRAFT` unless `DRAFT`. |
| POST | `/quotations/:id/discount/approve` | `discount.approve` | `{ note? }` | quotation (`discountApproval: APPROVED`) |
| POST | `/quotations/:id/discount/reject` | `discount.approve` | `{ reason, clearDiscounts=true }` | quotation |
| POST | `/quotations/:id/send` | `quotation.manage` | - | quotation (`SENT`) |
| POST | `/quotations/:id/cancel` | `quotation.manage` | `{ reason? }` | quotation (`CANCELLED`); only `DRAFT` / `SENT` |
| POST | `/quotations/:id/approve` | `self.payments` (own), `corp.requests.approve` (own company) or `quotation.manage` (on the customer's behalf) | `{ note? }` - mandatory for staff | `{ quotation, invoice: { id, invoiceNo, status, total, balanceDue, currency, dueAt } }` |
| POST | `/quotations/:id/reject` | same as approve | `{ reason }` | quotation (`REJECTED`) |

```json
POST /quotations/from-request/6c1...   ->  201
{
  "id": "0e9...", "quotationNo": "QUO-000012", "status": "DRAFT", "currency": "AED",
  "subtotalServiceFee": "120.00", "subtotalGovernmentFee": "330.00", "subtotalThirdParty": "25.00",
  "discountTotal": "0.00", "taxTotal": "6.00", "total": "481.00",
  "validUntil": "2026-06-24T09:12:00.000Z", "discountApproval": "NONE",
  "quotationItems": [
    { "description": "Family visa - service fee", "component": "SERVICE_FEE", "quantity": "1.00", "unitAmount": "120.00", "discountAmount": "0.00", "taxRatePercent": "5.00", "taxAmount": "6.00", "lineTotal": "126.00" },
    { "description": "Family visa - government fee (estimate)", "component": "GOVERNMENT_FEE", "quantity": "1.00", "unitAmount": "330.00", "taxRatePercent": "0.00", "taxAmount": "0.00", "lineTotal": "330.00" }
  ]
}
```

Rules:

- **Number / validity**: `QUO-000001` from the per-tenant sequence at creation; `validUntil` defaults to now +
  tenant setting `quotationValidityDays` (14).
- **From a request**: effective price of the request's service for the request's branch (active
  `service_prices` row of that branch, else the default row; `422 NO_PRICE` if neither); a
  `corporate_prices` row of the request's company replaces **only the service fee**; government and
  third-party estimates become separate lines.
- **Discount approval (segregation of duties)**: any line discount needs `discountReason` and sets
  `discountApproval = PENDING`; sending is blocked (`409 DISCOUNT_APPROVAL_REQUIRED`). The approver must
  hold `discount.approve` and must **not** be the user who requested the discount
  (`403 SELF_APPROVAL_FORBIDDEN`). Only exception: when the requester is the *only* active member holding
  `discount.approve`, the approval is allowed and the audit entry records `selfApproved: true`. Changing the
  lines after an approval restarts the approval. Reject with `clearDiscounts: true` removes the discounts
  (draft is sendable again); with `false` the discounts stay, status `REJECTED`, and a `PATCH` with a new
  `discountReason` or new lines requests approval again.
- **Send**: `DRAFT -> SENT`, emits `quotation.sent`. Earlier `SENT` quotations of the same request become
  `SUPERSEDED` at that moment.
- **Decision**: the owning customer, a corporate admin of the owning company, or staff on the customer's
  behalf (`decidedByType` is stored; staff must give a note, which is audited with
  `onBehalfOfCustomer: true`). An expired quotation cannot be approved (`409 QUOTATION_EXPIRED`).
  Approval - in one transaction - marks the quotation `APPROVED`, creates and **issues** the invoice from its
  lines and emits `quotation.approved`, `invoice.issued` and (unless the total is 0) `payment.requested`.
  If issuing fails (for example the corporate credit limit) nothing is approved.

### Invoices
| Method | Path | Access | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/invoices` | `invoice.read`, `self.payments`, `corp.invoices.read` | query `status, customerId, requestId, corporateAccountId, branchId, from, to, overdue, q` | page of invoices (each with `overdue`) |
| POST | `/invoices` | `invoice.manage` | `{ customerId, branchId?, requestId?, corporateAccountId?, notes?, items }` | draft invoice (`invoiceNo` is `DRAFT-...` until issued) |
| GET | `/invoices/:id` | as list | - | invoice + `invoiceItems` + `payments` (allocations) + `creditNotes` |
| GET | `/invoices/:id/pdf` | as list | - | `application/pdf` |
| PATCH | `/invoices/:id` | `invoice.manage` | `{ notes?, items? }` | invoice. `409 INVOICE_ISSUED` once issued. |
| POST | `/invoices/:id/issue` | `invoice.manage` | - | issued invoice |
| POST | `/invoices/:id/void` | `invoice.manage` | `{ reason }` | invoice (`VOID`). `409 INVOICE_HAS_PAYMENTS` / `INVOICE_HAS_CREDITS`. Also discards a draft. |
| POST | `/invoices/:id/pay` | `self.payments` (own), `corp.invoices.read` (own company), `payment.record` (staff: payment link) | `{ amount?, returnUrl? }` | `{ paymentId, paymentNo, status: "PENDING", amount, currency, gateway, testMode, checkoutUrl, expiresAt }` |
| GET | `/corporate/invoices` | `corp.invoices.read` | as `/invoices` | the company's invoices |
| GET | `/corporate/invoices/statement` | `corp.invoices.read` | - | statement of the caller's company |
| GET | `/finance/corporate-accounts/:id/statement` | `invoice.read` or `report.financial` | - | statement |

```json
GET /finance/corporate-accounts/9b2.../statement  ->  200
{
  "asOf": "2026-06-30T12:00:00.000Z",
  "account": { "id": "9b2...", "accountNo": "CORP-000004", "companyName": "Gulf Trading LLC", "paymentTermsDays": 30, "creditApproved": true, "creditLimit": "5000.00" },
  "currency": "AED", "openBalance": "525.00", "availableCredit": "4475.00",
  "ageing": { "current": "105.00", "days1to30": "105.00", "days31to60": "105.00", "days61to90": "105.00", "days90plus": "105.00" },
  "invoices": [ { "id": "...", "invoiceNo": "INV-000031", "issuedAt": "...", "dueAt": "...", "total": "105.00", "amountPaid": "0.00", "amountCredited": "0.00", "amountRefunded": "0.00", "balanceDue": "105.00", "status": "ISSUED", "currency": "AED", "requestId": "...",
                  "customerId": "...", "customerName": "Ravi Kumar", "customerErased": false, "requestNo": "TE-000123", "bucket": "days31to60", "daysOverdue": 45 } ]
}
```

Statement rows name the person the invoice is about (`customerId`, `customerName`; `customerErased: true` when
their data was erased and the name is a placeholder) and the request it settles (`requestNo`, `null` for an
invoice outside a request): a company reads its statement by employee. Wherever an invoice, quotation or
payment embeds its `customer`, that object carries `erased: boolean` (customers.md, "Erased customers").

Rules:

- **Issue**: takes `INV-000001` from the gap-free sequence at issue time, sets `issuedAt` and `dueAt`; emits
  `invoice.issued` and `payment.requested`. The same code issues the invoice that is created when a quotation
  is approved.
- **Payment terms and `dueAt`**: the terms in days are the company's `paymentTermsDays` when the invoice
  belongs to a corporate account that is `ACTIVE` with `creditApproved`; otherwise the centre's setting
  `invoiceDueDays` (`PATCH /tenant/settings`, 0-120); otherwise 0 = due on receipt. `dueAt` is the **end of the
  due day on the centre's calendar**: 23:59:59.999 in the centre's time zone (`tenants.timezone`, Asia/Dubai
  by default; an unknown zone name falls back to Asia/Dubai) of the day `issue date + terms`. An invoice with
  0 days is therefore payable until the end of the day it was issued; it is never overdue the moment it
  exists. Example: issued 9 October 10:00 Dubai time, 0 days -> `dueAt = 2026-10-09T19:59:59.999Z`; 30 days ->
  `2026-11-08T19:59:59.999Z`. The audit entry `invoice.issued` records `termsDays`.
- **Overdue** has one definition (`isInvoiceOverdue` / `overdueInvoiceWhere` in `finance.calc.ts`):
  status `ISSUED` or `PARTIALLY_PAID`, `balanceDue > 0` and **`now > dueAt`**. It is what the `overdue` flag on
  every invoice, the `overdue=true` filter, `daysOverdue` and the ageing buckets of the corporate statement
  and of the report `outstanding-payments` use. A draft, a paid, credited or void invoice and an invoice
  without `dueAt` are never overdue.
- **Corporate credit**: when the invoice has a `corporateAccountId` whose account is `ACTIVE` with
  `creditApproved`,
  `open balances of the company + this invoice <= creditLimit` is enforced (`422 CREDIT_LIMIT_EXCEEDED`, with
  `details { creditLimit, openBalance, invoiceTotal }`; no limit set = no cap). Without approved credit the
  company pays like anyone else (the centre's terms, no credit check).
- **Discounts on directly created invoices**: issuing needs `discount.approve`, and not by the user who
  created the draft (same single-approver exception, audited). Discounts that came from an approved
  quotation need no second approval.
- **Ageing buckets** by days past `dueAt`: `current`, `days1to30`, `days31to60`, `days61to90`, `days90plus`.

### Payments
| Method | Path | Access | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/payments` | `payment.read`, `self.payments`, `corp.invoices.read` | query `status, method, customerId, corporateAccountId, invoiceId, requestId, branchId, from, to, reconciled, q` | page of payments |
| POST | `/payments` | `payment.record` + header `Idempotency-Key` | `{ method: CASH\|CARD_POS\|BANK_TRANSFER\|CHEQUE, amount, reference?, notes?, branchId, customerId?, receivedAt?, allocations: [{ invoiceId, amount }] }` | payment (`COMPLETED`) with `paymentAllocations`, `unallocatedAmount` |
| GET | `/payments/:id` | as list | - | payment + allocations + `refunds` |
| GET | `/payments/:id/receipt/pdf` | as list, or `payment.record` | - | `application/pdf` (`409 NO_RECEIPT` unless completed) |

```json
POST /payments        Idempotency-Key: 5f1c0a3e-...        ->  201
{ "method": "CASH", "amount": "305.00", "branchId": "...", "allocations": [{ "invoiceId": "...", "amount": "305.00" }] }

{ "id": "...", "paymentNo": "PAY-000018", "receiptNo": "RCT-000017", "status": "COMPLETED", "method": "CASH",
  "amount": "305.00", "refundedAmount": "0.00", "currency": "AED", "receivedAt": "...", "unallocatedAmount": "0.00",
  "paymentAllocations": [{ "invoiceId": "...", "amount": "305.00", "invoice": { "invoiceNo": "INV-000021", "status": "PAID", "balanceDue": "0.00" } }] }
```

Rules:

- **Manual payments** are `COMPLETED` immediately with a payment number and a receipt number. The
  allocations must add up to the amount (`422 ALLOCATION_MISMATCH`), each at most the invoice's balance
  (`422 OVERPAYMENT`), only `ISSUED` / `PARTIALLY_PAID` invoices (`409 INVOICE_NOT_PAYABLE`), one currency.
  Invoices are locked while the payment is booked, so two simultaneous payments can never both settle the
  same balance.
- **Idempotency** (`Idempotency-Key`, 8-128 chars, required on `POST /payments` and `POST /refunds`): the
  first request runs and its response is stored with the key in the same transaction; the same key with the
  same body returns the stored response with header `Idempotent-Replayed: true`; the same key with a
  different body is `409 IDEMPOTENCY_KEY_REUSED`. A failed request stores nothing and can be retried with
  the same key. Keys are per tenant and operation and expire after 24 hours.
- **Card data is never stored**: only method, amount and a free-text reference. A reference or note that
  contains something that looks like a card number (13-19 digits passing the Luhn check) is rejected with `400`.
- Completed payments and allocations are immutable in the database.
- Every completed payment emits `payment.completed` with `invoiceIds` and `requestIds`, and accrues liabilities.

### Online payments and gateways
`POST /invoices/:id/pay` creates a `PENDING` payment and a hosted checkout session at the centre's gateway.
**Nothing is paid until the gateway's signed webhook arrives.** The gateway is the centre's `ACTIVE`
integration row of category `PAYMENT` (credentials in `secretsEnc`); when there is none the answer is
`503 INTEGRATION_NOT_CONFIGURED` and manual payments keep working. A configured real gateway wins over the
sandbox. `returnUrl` must be one of the centre's own portals (`400 INVALID_RETURN_URL` otherwise).

| Adapter | Status |
| --- | --- |
| `sandbox` | TEST adapter. Only when `PAYMENT_SANDBOX_ENABLED=true` (forced off in production). No money moves. Checkout "page" on our own API (below); completing or failing it makes the sandbox POST a correctly signed webhook to the real webhook endpoint over HTTP. Refunds succeed, except when the refund reason contains `[sandbox:fail]`. |
| `stripe` | Written against Stripe's public HTTP API with `fetch`: Checkout Session creation, `Stripe-Signature` verification (`t=..,v1=..` HMAC-SHA256 over `"<t>.<raw body>"`, timestamp tolerance), refunds. **Implemented, not verified against live Stripe** (no credentials in this environment); signature verification and request building are unit-tested with locally computed values. Credentials per centre: `{ secretKey, webhookSecret }`. Configure the Stripe endpoint for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`. |

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| POST | `/public/webhooks/payments/:gateway` | public, rate-limited | Gateway webhook for customer payments. Body: the gateway's raw JSON. Response `200 { received, processed, duplicate?, outcome?, reason? }`. |
| GET | `/public/payments/sandbox/checkout/:sessionRef` | public (sandbox only) | **A browser** (`Accept: text/html`) gets the HTML test checkout page. **API clients** (`Accept: application/json` or `*/*`, e.g. `fetch`) get the description: `{ gateway: "sandbox", testMode: true, notice, description, amount, currency, purpose, expiresAt, actions }` |
| POST | `/public/payments/sandbox/checkout/:sessionRef/complete` | public (sandbox only) | "Pays": sends the signed success webhook. JSON answer `{ gateway, testMode, outcome, webhook: { eventId, delivered, status, response }, returnUrl }`. With `?form=<token>` (the HTML page): `303` redirect to the success address |
| POST | `/public/payments/sandbox/checkout/:sessionRef/fail` | public (sandbox only) | `{ reason? }` - sends the signed failure webhook; same JSON answer. With `?form=<token>`: `303` redirect to the cancel address |

**The sandbox checkout page.** `checkoutUrl` of `POST /invoices/:id/pay` is a page an app can simply redirect
to (mobile web view, corporate portal, customer portal), exactly like the hosted page of a real provider:

1. the app sends the browser to `checkoutUrl`;
2. the page shows a banner "TEST PAYMENT - no money is taken", the description and the amount, and two
   buttons: **Complete test payment** and **Decline**;
3. each button is a plain HTML form that posts to `/complete` or `/fail` with `?form=<token>`; the API
   delivers the signed webhook to itself (that is what completes or fails the payment) and answers
   `303 See Other` with `Location:` the `returnUrl` the app passed, plus `payment=<payment id>` and
   `result=success` or `result=cancelled` (without a `returnUrl`: the portal's `/payments/return?invoice=..&payment=..&result=..`);
4. back in the app, read the outcome from `GET /payments/:id` - the `result` parameter is a hint for the
   screen, not proof of payment.

The page is one self-contained HTML document: inline style, **no script**, no external resource. Its response
carries its own policy (`Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action
'self' <origins of the return addresses>; base-uri 'none'; frame-ancestors 'none'`), `Cache-Control: no-store`
and `Referrer-Policy: no-referrer`. The form token is an HMAC bound to that one session; a form post with a
missing or wrong token gets `403` (an HTML page) and changes nothing. An unknown, edited or expired session is
`404` (HTML for a browser, JSON otherwise). With `PAYMENT_SANDBOX_ENABLED=false` none of the three routes
exists (`404`), and the API refuses to start in production with the sandbox switched on. The JSON use of the
three routes (customer portal, tests) is unchanged and needs no token.

**Attempts that are never completed.** An online payment whose checkout page was opened and abandoned would
stay `PENDING` for ever. Job `finance.expire_checkouts` (every 5 minutes, per tenant) closes `PENDING`
`ONLINE_GATEWAY` payments older than the provider's session lifetime - **60 minutes**
(`ONLINE_CHECKOUT_LIFETIME_MINUTES`) - as `status: "CANCELLED"`, `failureReason: "EXPIRED"`. Nothing else
changes (a `PENDING` payment never touched the invoice), no event is emitted, nobody is notified; audit
`payment.checkout_expired`. The update is conditional, so running the job twice or at the same moment as a
webhook is harmless. **A late success still wins**: if the provider's success webhook arrives for a payment
that was closed as `EXPIRED`, the payment is completed exactly as a pending one would be (`COMPLETED`, receipt
number, allocation, `payment.completed`; `failureReason` cleared; audit `payment.checkout_revived`). Only
`EXPIRED` can be revived: a payment that the provider reported as failed stays `FAILED`, and a late failure
event for an expired payment is ignored. The customer can start a new payment for the invoice at any time.

Webhook guarantees:

- The signature is verified over the **raw body**; deliveries older (or newer) than
  `PAYMENT_WEBHOOK_TOLERANCE_SECONDS` are rejected. Invalid -> `400 WEBHOOK_SIGNATURE_INVALID` and a
  `WEBHOOK_SIGNATURE_INVALID` security event. Nothing is recorded or changed before verification.
- The tenant is found from the payment row (session reference, gateway payment reference, or our payment id
  echoed by the gateway) on the system connection; the signature is then checked with *that centre's*
  secret, and the business change runs inside that centre's row-level-security context.
- Each verified event is stored in `payment_webhook_events` (unique gateway + event id). A duplicate delivery
  returns `200 { duplicate: true }` and does nothing; a delivery whose processing crashed is processed when
  the gateway retries it.
- The payment completes **exactly once** (conditional update `PENDING -> COMPLETED`, or from `CANCELLED` /
  `EXPIRED` for a late success, see above), gets its receipt number,
  is allocated to the invoice it was started for, and emits `payment.completed`. A failure event marks it
  `FAILED` and emits `payment.failed`.
- If the gateway amount / currency differs from the pending payment, nothing is completed
  (`WEBHOOK_AMOUNT_MISMATCH` security event).
- If the invoice was settled otherwise in the meantime, the payment is still recorded in full (the money was
  taken); only what fits is allocated and the rest is reported as `unallocatedAmount` for a refund decision.
- A Stripe event that matches none of our payments cannot be verified with any centre's secret; it is
  acknowledged with `200 { processed: false, reason: "UNKNOWN_REFERENCE" }` and ignored.

### Refunds
| Method | Path | Access | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/refunds` | `refund.request` or `refund.approve` | query `status, paymentId, invoiceId, requestId, from, to, q` | page of refunds |
| POST | `/refunds` | `refund.request` + `Idempotency-Key` | `{ paymentId, invoiceId?, amount, reason, breakdown?: { SERVICE_FEE?, GOVERNMENT_FEE?, THIRD_PARTY_FEE?, TAX? }, cancelCharge=false }` | refund (`REQUESTED`) |
| GET | `/refunds/:id` | as list | - | refund + payment + invoice |
| POST | `/refunds/:id/approve` | `refund.approve` | `{ cancelCharge?, reference? }` | refund |
| POST | `/refunds/:id/reject` | `refund.approve` | `{ reason }` | refund (`REJECTED`) |
| POST | `/refunds/:id/complete` | `refund.approve` | `{ reference }` | refund (`COMPLETED`) - manual pay-out |
| POST | `/refunds/:id/process` | `refund.approve` | - | refund - sends / re-checks a gateway refund |

Rules:

- Against a `COMPLETED` / `PARTIALLY_REFUNDED` payment; amount <= payment amount - already refunded -
  amounts waiting in other open requests (`422 REFUND_EXCEEDS_PAYMENT`). When the payment settled several
  invoices, `invoiceId` is required.
- **Segregation of duties, no exception**: the requester can never approve, process or complete their own
  refund (`403 SELF_APPROVAL_FORBIDDEN`), whatever their role. Roles without `refund.approve` get `403`.
- `approve`: payments taken through a gateway are refunded through the adapter immediately
  (`PROCESSING -> COMPLETED`, or `FAILED` with the gateway's reason in `rejectionReason`; nothing is booked on
  failure; retry with `/process` or finish with `/complete`). Manual methods stay `APPROVED` until the
  approver records how the money went back (`reference` in the approve call, or `/complete`).
  `gatewayRefundRef` holds the gateway's refund id, or for manual pay-outs that reference.
- **Completion is one transaction**: refund `COMPLETED`; payment `refundedAmount` and status
  (`PARTIALLY_REFUNDED` / `REFUNDED`); invoice `amountRefunded`; liability `REVERSAL` entries for the
  pass-through parts; `refund.completed`.
- `cancelCharge` (requester's choice, the approver may override): `true` = the charge itself is cancelled -
  a credit note for the same amount is issued in the same transaction, so the balance does **not** reopen;
  `false` = the amount becomes due again (invoice back to `PARTIALLY_PAID` / `ISSUED`).
- `breakdown` (optional) must add up to the amount; government / third-party parts cannot exceed what was
  collected for the invoice. Without it the split is proportional (see liabilities). The final split is
  stored in `breakdown` together with `cancelCharge` and `explicit`.

### Credit notes
| Method | Path | Access | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/credit-notes` | `creditnote.manage`, `invoice.read`, `self.payments`, `corp.invoices.read` | query `invoiceId, from, to, q` | page |
| POST | `/credit-notes` | `creditnote.manage` | `{ invoiceId, amount, reason, breakdown?: { SERVICE_FEE?, GOVERNMENT_FEE?, THIRD_PARTY_FEE? } }` | credit note + `invoiceStatus`, `invoiceBalanceDue` |
| GET | `/credit-notes/:id` | as list | - | credit note |
| GET | `/credit-notes/:id/pdf` | as list | - | `application/pdf` |

A stand-alone credit note reduces the **open balance** of an issued invoice (`amount <= balanceDue`,
`422 CREDIT_EXCEEDS_BALANCE`). Money that was already paid is credited through a refund with
`cancelCharge: true` (`409 NOTHING_TO_CREDIT` explains this on a paid invoice). Fully credited with nothing
paid -> `CREDITED`. Without a breakdown the credit is spread over what is still unpaid per component.

### Expenses
| Method | Path | Access | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/expenses` | `expense.manage` | query `category, branchId, requestId, from, to, q` | page + `totalAmount` |
| POST | `/expenses` | `expense.manage` | `{ branchId, category, requestId?, description, amount, paidOn (YYYY-MM-DD), payee?, reference?, method? }` | expense + `liabilitySettled` |
| GET / PATCH / DELETE | `/expenses/:id` | `expense.manage` | partial body for PATCH | expense; DELETE is a soft delete `{ status: "DELETED", remittanceReversed }` |

Categories: `GOVERNMENT_FEE_REMITTANCE`, `THIRD_PARTY_PAYMENT`, `RENT`, `SALARIES`, `SUPPLIES`, `UTILITIES`, `OTHER`.

- A `GOVERNMENT_FEE_REMITTANCE` / `THIRD_PARTY_PAYMENT` **linked to a request** writes a `REMITTANCE`
  liability entry and can never exceed the collected, not yet remitted liability of that request and
  component (`422 REMITTANCE_EXCEEDS_LIABILITY`). Simultaneous remittances of one request are serialised.
- Without a request (for example an authority wallet top-up) it is an ordinary expense and does not touch
  the ledger.
- A recorded remittance cannot change amount, category, branch or request (`409 REMITTANCE_RECORDED`);
  deleting it writes a compensating ledger entry, so the liability is outstanding again.

### Reconciliation
| Method | Path | Access | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/reconciliations` | `payment.reconcile` | query `status, method, from, to, q` | page |
| POST | `/reconciliations` | `payment.reconcile` | `{ method, gateway? (required for ONLINE_GATEWAY), branchId?, periodStart, periodEnd, statementReference?, settledAmount, feeAmount=0, notes?, attachAll=false }` | record + `attached { count, total, payments }` + `candidates { ... }` |
| GET | `/reconciliations/:id` | `payment.reconcile` | - | same |
| PATCH | `/reconciliations/:id` | `payment.reconcile` | `{ statementReference?, settledAmount?, feeAmount?, notes? }` | same |
| POST | `/reconciliations/:id/payments` | `payment.reconcile` | `{ paymentIds }` | attaches payments |
| POST | `/reconciliations/:id/payments/remove` | `payment.reconcile` | `{ paymentIds }` | detaches payments |
| POST | `/reconciliations/:id/close` | `payment.reconcile` | `{ notes? }` | record (`CLOSED`) |

`expectedAmount` = net amount (amount - refunded) of the attached payments; before anything is attached, of
every completed, un-reconciled payment of that method / gateway (and branch) received in the period - these
are the `candidates`. `difference = settledAmount + feeAmount - expectedAmount`. Status: `OPEN` (nothing
attached) -> `MATCHED` (difference 0) or `DISCREPANCY` -> `CLOSED`. A payment belongs to one reconciliation
only (`reconciliationId`, `reconciledAt`); a discrepancy needs a note before closing; a closed record is final.

## 4. PDF documents
Quotation, invoice (titled "Tax invoice" when the centre has a tax registration number), receipt and credit
note, generated with pdfkit and branded with the centre's public presentation (`BrandingService.publicConfig`:
name, colours, logo in white-label mode, invoice / receipt footer). Each document has clearly separated
sections for **service fees**, **government fees** and **third-party charges**, then discount, tax, total,
paid and balance. The sentence "Government fees are collected on behalf of the relevant authority." is
printed directly under the government-fee heading. The PDF endpoints apply exactly the same authorisation as
the JSON detail endpoints.

Limitations: **English only** (characters outside Latin-1, such as Arabic names, are printed as `?`); logos
are embedded only when stored locally as PNG or JPEG. E-mail delivery is done by the notifications module
from the events below, not by this module.

## 5. Events

Emitted (transactional outbox, same transaction as the change):

| Event | When | Payload |
| --- | --- | --- |
| `quotation.sent` | quotation sent | `{ quotationId, requestId?, customerId, total, currency }` |
| `quotation.approved` | customer decision | `{ quotationId, requestId?, customerId, approvedByType }` |
| `quotation.rejected` | customer decision | `{ quotationId, requestId?, customerId, reason }` |
| `invoice.issued` | invoice issued (directly or through approval) | `{ invoiceId, requestId?, customerId, total, currency }` |
| `invoice.voided` | an issued invoice was voided (discarding a draft emits nothing) | `{ invoiceId, requestId?, customerId, total, currency, reason }` |
| `creditnote.issued` | credit note issued: stand-alone (`POST /credit-notes`) or with a refund that cancels the charge (then `refundId` is set; emitted just before `refund.completed`) | `{ creditNoteId, creditNoteNo, invoiceId, requestId?, customerId, amount, currency, refundId? }` |
| `payment.requested` | invoice issued with total > 0 | `{ invoiceId, requestId?, customerId, amount, currency }` |
| `payment.completed` | manual payment recorded / online payment completed | `{ paymentId, customerId?, amount, currency, method, invoiceIds: [], requestIds: [] }` |
| `payment.failed` | online payment failed | `{ paymentId, customerId?, reason }` |
| `refund.requested` | refund requested | `{ refundId, paymentId, requestId?, amount, currency }` |
| `refund.completed` | refund paid out | `{ refundId, paymentId, invoiceId?, requestId?, amount, currency }` |

Consumed: none. Finance never writes to `service_requests`; the requests module derives the request's
payment status from `invoice.issued`, `invoice.voided`, `creditnote.issued`, `payment.completed` and
`refund.completed` (in the same transaction, so the status is never stale after a void or a credit note).

## 6. Background jobs

| Job | Schedule | What it does |
| --- | --- | --- |
| `finance.quotations.expire` | every 15 minutes, per tenant | `SENT` quotations past `validUntil` become `EXPIRED` (audited). An attempt to approve an expired quotation also marks it `EXPIRED` straight away. |
| `finance.expire_checkouts` | every 5 minutes, per tenant | `PENDING` online payments older than 60 minutes become `CANCELLED` with `failureReason = "EXPIRED"` (audited, no event). See "Attempts that are never completed". |

## 7. Audit and security events
Every create / update / decision writes an audit entry in the same transaction (`quotation.*`, `invoice.*`,
`payment.*`, `refund.*`, `creditnote.issued`, `expense.*`, `reconciliation.*`, `finance.fee_component_updated`).
Security events: `WEBHOOK_SIGNATURE_INVALID` (HIGH), `WEBHOOK_AMOUNT_MISMATCH` (HIGH),
`WEBHOOK_PAYMENT_NOT_PENDING` (MEDIUM: money arrived for a payment that is no longer pending),
`WEBHOOK_UNMATCHED` (LOW).

## 8. Error codes a client should handle

| Code | HTTP | Meaning |
| --- | --- | --- |
| `IDEMPOTENCY_KEY_REQUIRED` / `IDEMPOTENCY_KEY_INVALID` | 400 | header missing or malformed |
| `IDEMPOTENCY_KEY_REUSED` | 409 | key already used for a different request |
| `DISCOUNT_APPROVAL_REQUIRED` / `DISCOUNT_REJECTED` | 409 | quotation cannot be sent yet |
| `SELF_APPROVAL_FORBIDDEN` | 403 | requester tried to approve their own discount / refund |
| `QUOTATION_EXPIRED` / `QUOTATION_NOT_OPEN` / `QUOTATION_NOT_DRAFT` | 409 | wrong quotation state |
| `NOTE_REQUIRED` | 422 | staff decided for the customer without a note |
| `CREDIT_LIMIT_EXCEEDED` | 422 | corporate credit limit |
| `INVOICE_ISSUED` / `INVOICE_NOT_PAYABLE` / `INVOICE_HAS_PAYMENTS` | 409 | wrong invoice state |
| `ALLOCATION_MISMATCH` / `OVERPAYMENT` | 422 | payment does not fit the invoices |
| `INTEGRATION_NOT_CONFIGURED` | 503 | no payment gateway connected |
| `GATEWAY_ERROR` | 502 | the gateway could not open the checkout |
| `REFUND_EXCEEDS_PAYMENT` / `REFUND_EXCEEDS_ALLOCATION` | 422 | refund too large |
| `CREDIT_EXCEEDS_BALANCE` / `NOTHING_TO_CREDIT` | 422 / 409 | credit note does not fit |
| `REMITTANCE_EXCEEDS_LIABILITY` | 422 | more remitted than collected |
| `IMMUTABLE_RECORD` | 409 | database refused a change to an issued / completed record |
