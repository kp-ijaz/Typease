# TypEase acceptance suite (API level)

The cross-module tests of TypEase: the 30 end-to-end scenarios of section 34 of
`docs/brand/MASTER_PROMPT.md`, driven over HTTP against the real application - the real NestJS app with all
modules, guards, pipes and filters, a real PostgreSQL 16 with row-level security, a real Redis, background jobs
executed inline. The tests use the API the way the web and mobile apps do; nothing is mocked inside the API.

Browser tests (Playwright, `tests/e2e`) would be a separate level and are not part of this suite - and they
were not written: `pnpm test:e2e` prints `tests/e2e/README.md` and exits 1. See `docs/TESTING.md` for how the
levels fit together.

| Folder | Scenarios | Files | Tests |
| --- | --- | --- | --- |
| `integration/` | 1-23, 26-30 | 9 | 54 |
| `security/` | 24, 25 and the boundaries around them | 6 | 32 |
| `support/` | the scenario DSL both folders share | | |

## Running

From the repository root (PostgreSQL and Redis must be running; the test database must exist - see
`docs/TESTING.md`, "Required services"):

```bash
pnpm test:integration                       # tests/integration, about 1.5 minutes
pnpm test:security                          # tests/security, about 3.5 minutes
pnpm test:integration 02-request-journey    # one file (anything appended is a jest argument)
pnpm test:security -t "refund"              # tests whose name matches
pnpm --filter @typease/tests typecheck      # TypeScript check of specs and helpers
```

The scripts live in `tests/package.json`. The suite has no dependencies of its own: it is run by the API
package's jest (`pnpm --filter @typease/api exec jest --runInBand --config ../../tests/jest.<suite>.config.js`),
with the same database rebuild (`services/api/test/global-setup.ts`: the test database is dropped and rebuilt
from the migration files on every invocation) and the same environment (`services/api/test/env.ts`) as the
API's own tests. Files run one after the other, in the order of their names
(`support/sequencer.js`), in one process, against one database.

Two switches help when a refusal is not the expected one:

- `DEBUG_REFUSALS=1` prints every `expectRefused(...)` with the status and code the API really answered;
- `DEBUG_SWEEP=1` prints the answers of the reference attacks and filtered lists of `security/01` and the
  reference attempts of `security/02`.

Expected noise in the output of the security folder: a few `ERROR [Http] ... The AI document assistant is not
configured` lines. OCR is switched off in the test environment and the route walks call the extraction route;
`503 INTEGRATION_NOT_CONFIGURED` is the documented answer.

## Rules of the suite

1. **Through the public API.** Centres are created by sign-up and onboarding, staff by invitation and
   acceptance, customers by registration and email verification, documents by the three-step upload (intent,
   `PUT` to the signed URL, complete), payments by the cashier's request or the gateway's signed webhook.
   `support/` contains builders for these steps; no builder writes to the database.
2. **The database is read or written directly only where the API cannot do the job**, and each place says so:
   - proving that something was NOT duplicated or NOT changed (payment rows and webhook events in
     `integration/06`; the fingerprint of every row of a centre and the "no row points across centres" query in
     `security/01`, `02`, `05`, `06`; the anonymised customer and user rows in `integration/08`);
   - row-level security itself (`security/06`: raw SQL on the API's own `typease_app` connection);
   - time travel where no API exists: the expiry of a share link (`integration/07`), the age of documents
     (`integration/08`), of an online checkout (`integration/06`) and of a domain claim (`integration/05`), the
     end of a support-access grant (`security/05`), the due time of a scheduled report (`security/03`).
   Two more things are set from outside the HTTP API because they are operator-level settings, not user
   actions: the billing clock (`BillingClock`, `integration/05`) and the lifetime of signed links
   (`DOWNLOAD_URL_TTL_SECONDS` / `UPLOAD_URL_TTL_SECONDS`, `integration/07`). The only account created in the
   database is the first platform administrator (production uses the `platform-admin` CLI; the API has no
   endpoint for it).
3. **One scenario, one named test with its number** (`S07 customer submits a service request`). Additional
   tests of the same scenario carry the same number.
4. **Expected values do not come from the code under test.** Money is computed in integer fils in
   `support/money.ts` and `support/books.ts` (the test's own set of books, from the documented rules); role
   expectations come from the permission matrix in `packages/permissions` and the DECLARED access rule of each
   route, not from the guard.
5. **A product defect is not worked around.** The assertion stays as the specification demands and the test is
   marked `// PRODUCT DEFECT:` with expected and actual behaviour. At the time of writing there is no such
   marker in the suite (see "Observations" at the end).

## `support/`

| File | What it gives a spec |
| --- | --- |
| `http.ts` | `Api` client (`get/post/...` throw with the API's own message on an unexpected status; `req` returns the raw response), `expectRefused(res, status, code?)`, `pathOf(url)` |
| `centre.ts` | `signUpCentre` (public sign-up, email verification, onboarding with plan and first service), `createService` (service + price + checklist + published form), `inviteStaff`, `inviteStaffWithPermissions` (custom role), `registerPortalCustomer`, `registerWalkInCustomer`, `invitePortalAccess`, `createCompany` (verified, credit, signed-in administrator), `addCompanyEmployee`, `employeeLogin` |
| `documents.ts`, `files.ts` | `uploadDocument` (the real three-step upload), `downloadDocument`, `fetchLink`; synthetic PDF / PNG files and a disguised executable |
| `finance.ts` | `enableSandboxGateway`, `issueInvoice`, `recordPayment`, `startCheckout` / `finishCheckout` (hosted test checkout and its signed webhook), `refundPayment` |
| `journey.ts` | `runCase`: one request through the standard workflow up to any stage, by the same kinds of users as scenario 6-17 |
| `jobs.ts` | `runScheduledJob`, `mailTo` (what the development mail driver captured), `dubaiDay`, `withOperatorSetting`, `allowOperatorHost`, `sleep` |
| `money.ts`, `books.ts` | decimal arithmetic in fils; the independent model of a centre's finances for scenario 30 |
| `world.ts` | `populate`: a centre with at least one record of every main resource type (79 harvested ids), for the security suite |
| `routes.ts` | the route table of the running application (`routeTable`), `urlOf`, `call`, `mayPass` (what the matrix and a route's declared rule say about a member) |
| `attacks.ts` | the tables of the isolation tests: `RECORD_ATTACKS` (read / update / delete / download, 221 requests with valid bodies), `REFERENCE_ATTACKS` (ids of another centre in create / update bodies, 78 requests), `FOREIGN_FILTERS`, `recordIdFor`, `bodyForRoute` |
| `isolation.ts` | `fingerprint` / `changedTables` (hash of every row a centre owns), `crossTenantReferences`, `asAppRole` (raw SQL as `typease_app`) |
| `sequencer.js` | runs the files in name order |

## Traceability: scenario -> test -> what is asserted -> what is not

`I/` = `tests/integration/`, `S/` = `tests/security/`. "Not covered" lists what this level cannot or does not
show; where another level covers it, that level is named.

### Scenarios 1-5: onboarding (`I/01-onboarding.spec.ts`)

| # | Test | Asserted | Not covered at this level |
| --- | --- | --- | --- |
| 1 | `S01 platform admin creates a tenant` | `POST /platform/tenants` by a Super Admin: centre in `ONBOARDING`, trial subscription of the chosen plan, owner INVITED (no password exists, sign-in refused), head office provisioned, slug taken; a Support Agent gets 403, anonymous 401 | The platform console UI. Creating the first Super Admin (CLI; here inserted in the database) |
| 2 | `S02 tenant owner completes onboarding`; `S02 a centre can also sign up by itself and complete onboarding (public flow)` | Invitation preview and acceptance; wizard state before / after; `ONBOARDING_INCOMPLETE` until business details and a first service exist; centre becomes `TRIAL`; default roles and head office; platform view agrees; public config served; audit entries; invitation link single-use. Self-service: sign-up, verification, plan, `SLUG_TAKEN`, `ACCOUNT_EXISTS` | Phone verification of the owner (switched off in the test environment); the wizard screens |
| 3 | `S03 tenant owner creates a branch` | Branch created and listed; plan usage 2 / 2 on Professional; a third branch is `402 PLAN_LIMIT_REACHED` and not created; platform counts agree; audit | Branch working hours and branding per branch |
| 4 | `S04 owner invites a staff member` | Unknown role refused; invitation creates an INVITED member limited to the second branch; the email captured by the mail driver contains the link, the stored notification does not; invited member cannot sign in; second invitation `409 ALREADY_MEMBER` | Delivery of the email by a real provider |
| 5 | `S05 staff member logs in` | Password policy published in the invitation and in the public config and enforced (one character short, no upper / lower case, no digit: `400 VALIDATION_FAILED`, invitation still valid); acceptance; wrong password `INVALID_CREDENTIALS`; session bound to centre, role and branch; receptionist's permissions (allowed and refused calls); staff account refused in the customer and platform apps; login activity; logout kills the token | MFA enrolment (optional in the test environment; covered by `services/api/test/foundation.spec.ts`); OTP sign-in (no SMS provider) |

### Scenarios 6-17 and 20: one request from the counter to the downloaded result (`I/02-request-journey.spec.ts`)

One customer, one request, thirteen tests that continue each other. Amounts are derived from the price list
(200.00 + 5 % + 350.00 + 30.00 = 590.00).

| # | Test | Asserted | Not covered at this level |
| --- | --- | --- | --- |
| 6 | `S06 staff creates a customer` | Receptionist registers the customer; identity numbers stored but masked (`identity` route 403 for the receptionist, clear for the owner); search; `409 POSSIBLE_DUPLICATE`; audit without the numbers; portal invitation accepted, own profile | Merging duplicates; Arabic names |
| 7 | `S07 customer submits a service request` | Portal catalogue with the estimate; draft with checklist and prefilled form; server-side form validation (`FORM_INVALID` names the conditional field); submit -> `SUBMITTED` with tracking code; staff list and counters; public tracking with the code, 404 with a wrong one, no name in it; another customer gets 404; staff-only field `403 STAFF_ONLY_FIELD` | The mobile source (`MOBILE`); the form UI |
| 8 | `S08 customer uploads documents` | Disguised executable refused (`FILE_TYPE_*`), nothing attached; a file larger than announced `413 PAYLOAD_TOO_LARGE`, another content type `415 UPLOAD_TYPE_MISMATCH`, nothing to complete (`409 UPLOAD_NOT_FOUND`), another customer cannot complete it (404); real three-step uploads; the upload URL cannot be replayed (`403 LINK_EXPIRED`); checklist `UPLOADED`; request moves to `UNDER_REVIEW`; bytes come back identical; another customer 404; customer cannot verify | Malware scanning by a real scanner (`MALWARE_SCANNER=none`; the EICAR path is in `I/07`); the S3 driver (local storage driver here) |
| 9 | `S09 reviewer verifies documents` | Receptionist cannot verify; approve with expiry date; rejection needs a reason; request -> `AWAITING_CUSTOMER`, line `REJECTED` with the note; resubmit blocked while rejected; replacement is a new version of the same document; resubmit; all lines `VERIFIED`; two versions kept | OCR-assisted verification (OCR disabled) |
| 10 | `S10 quotation is generated` | Quotation from the request = price list: three components, tax on the service fee only, per-line amounts; draft invisible to the customer; send -> `QUOTED`; customer sees list, request and PDF (`%PDF-`); other customer 404; reviewer 403 | The content of the PDF beyond its signature bytes; discount approval (`S/03`) |
| 11 | `S11 customer approves quotation` | Other customer 404; approval creates the invoice (total = quotation total); request -> `AWAITING_PAYMENT`; second approve / reject 409; staff cannot skip the payment (`403 TRANSITION_NOT_ALLOWED`) | Quotation expiry job (module spec) |
| 20 | `S20 invoice is generated` | Invoice number format, status, customer, request, component subtotals, tax, total, balance; `dueAt` = end of the issue day in Asia/Dubai (`...T19:59:59.999Z`), not overdue, not in `overdue=true`; lines add up to the total; exactly one invoice for the request; customer list and PDF; other customer 404; issued invoice cannot be edited; a DRAFT invoice and an invoice voided before issue do not exist for the customer (list, by id, PDF, pay) | An invoice becoming overdue (needs a past due date: finance module spec); the PDF layout |
| 12 | `S12 payment is recorded` | Idempotency key required; overpayment `422`; cash instalment -> receipt number, `PARTIALLY_PAID`; same key replays the same payment (`Idempotent-Replayed`), nothing booked twice; card payment of the rest -> `PAID`, request `READY_FOR_PROCESSING`; two payments add up to the total; paid invoice takes no more (`409 INVOICE_NOT_PAYABLE`); customer has the receipt PDF; reviewer 403 | Online payment (covered in `I/03`, `I/06`); a real gateway (Stripe adapter is not executed anywhere) |
| 13 | `S13 request is assigned` | Operator cannot see the request before assignment (404); no work without an operator (`OPERATOR_REQUIRED`); receptionist cannot be operator (`ASSIGNEE_ROLE_NOT_SUITABLE`) and cannot assign (403); assignment; segregation of duties operator / reviewer (`409`); replacing needs a reason; operator sees it in "mine", gets an in-app notification, workload; the customer does not see who works on the file | Auto-assignment |
| 14 | `S14 operator processes request` | `IN_PREPARATION`; internal note invisible to the customer, customer comment visible with the staff member's FIRST NAME only and `authorKind: STAFF` (staff see the full name); submission to an authority refused for a preparation-only service (`422 SUBMISSION_NOT_PERMITTED`); completion line added; the customer cannot upload to it (`403 COMPLETION_DOCUMENT_STAFF_ONLY`); operator uploads the result; direct jump to final review refused (`422 APPROVAL_REQUIRED`); `PENDING_APPROVAL` (customer still sees "Being prepared"); operator cannot approve own work (403); reviewer approves -> `FINAL_REVIEW` | Submission through a partner (covered in `I/03`); official API integration (none exists; section 31 forbids pretending) |
| 15 | `S15 request is completed` | Operator and receptionist cannot complete (403); reviewer completes; staff, customer and public tracking agree; full status history in order (13 transitions); a completed case cannot be cancelled (`409 INVALID_TRANSITION`); invoiced = paid, balance 0; counters | Reopening |
| 16 | `S16 customer receives notification` | In-app inbox contains one message per customer-relevant step and exactly one `request.completed`, linked to the request, with the request number; no message for internal steps; the centre's delivery log shows the email `SENT` once; the development mail driver captured exactly one such email to the customer's address, without any file link; another customer cannot mark it and received nothing | **Real delivery by an external provider** (SMTP is exercised against a local test server in `I/04`; SMS, WhatsApp and push providers are not configured in tests); rendering in a mail client |
| 17 | `S17 customer downloads completed document` | The result is listed as the completion document; short-lived signed link (< 60 min, file name, size); bytes identical to what the operator uploaded; a tampered link is refused; other customer 404, anonymous 401; the download is on the document's access log, attributed to the customer | Download through S3 pre-signed URLs; the browser's handling of the file |

### Scenario 18: corporate (`I/03-corporate.spec.ts`)

| # | Test | Asserted | Not covered at this level |
| --- | --- | --- | --- |
| 18 | `S18 corporate customer submits an employee request` | Partner-coordination service only after TypEase verified the centre's partner authorisation (`CAPABILITY_NOT_PERMITTED` before); corporate portal: own account, contract price in the catalogue; employee added (numbers masked); request for the employee (`source: CORPORATE`), upload, submit; quotation at the contract price; approval on account -> work starts without payment; `dueAt` = end of the day issue + 30 days (the company's terms); credit limit enforced (`CREDIT_LIMIT_EXCEEDED`, nothing created); partner processing: only the permitted channel, partner name required, a client cannot claim "official" status; status labelled `PARTNER_PROVIDED` for the company; internal notes hidden; the company cannot upload to the completion line; result filed and completed with an open invoice; statement, ageing, counters; online payment through the hosted checkout frees the credit; the earlier quotation can then be approved | A real partner system (the partner is a record; staff enter what the partner reports - by design, section 31) |
| 18 | `S18 the company employee signs in and sees only their own request` | Employee login by invitation (role `corporate_employee`); own request only; colleague's request 404; company account, directory and invoices 403; administrator sees both | The corporate portal UI. Deeper boundaries: `S/02` |

### Scenarios 19 and 27: jobs (`I/04-reminders-and-jobs.spec.ts`)

| # | Test | Asserted | Not covered at this level |
| --- | --- | --- | --- |
| 19 | `S19 reminder job runs` | Verifying a document with an expiry date creates the schedule (30 days: offsets, next reminder today); `reminders.scan`: one reminder at the nearest offset, older offsets cancelled, in-app message and one email, dispatch linked to the notification; no consent -> `SKIPPED_NO_CONSENT`, nothing sent; running the job three times the same day sends nothing more; 15 days later (the job's own `today` parameter) the next reminder, once; renewal request linked to the schedule, not usable by another customer; after the expiry date the schedule is `COMPLETED` | The scheduler itself (cron timing, BullMQ repeatable jobs: `services/api/src/modules/platform/worker.bullmq.spec.ts` and `docs/architecture/WORKER.md`); jobs run inline here |
| 19 | `S19 every scheduled job is registered, runs, and can run twice in a row` | The jobs the specification relies on are on the schedule list, unique, each with a cron or interval; every scheduled handler runs twice against this suite's data without an error; the centre is unaffected | What each job does (their module specs) |
| 27 | `S27 failed notification is retried safely` | The centre's own SMTP server (a real SMTP server on localhost) answers 451 once: deliveries `FAILED`, `SENT`, two attempts, exactly one message in the mailbox, authenticated with the centre's credentials; a duplicate delivery job does not send again; manual retry of a sent message `409 NOT_RETRYABLE`; server down for all attempts: `FAILED`, listed under failures with the reason, in-app copy unaffected; receptionist cannot retry (403); the owner's retry sends exactly one message; a second retry is refused; audited once | Retry back-off timing (attempts run immediately in inline mode); SMS / WhatsApp / push retry (no provider) |

### Scenarios 21-23: subscription, white label, custom domain (`I/05-subscription-and-white-label.spec.ts`)

| # | Test | Asserted | Not covered at this level |
| --- | --- | --- | --- |
| 21 | `S21 subscription is upgraded` | Starter limits enforced (white label, domain, second branch: `402`); only the owner manages the subscription; trial end (billing clock moved): first invoice, `PAST_DUE`, paid through the hosted checkout -> `ACTIVE`; upgrade ten days into the period: proration computed by the test (price difference x remaining time, half-up) equals the invoice; nothing unlocks before payment; after payment plan = Business, same period end, limits lifted; invoice cannot be paid twice (`409`); billing history; PDF; SaaS billing does not appear in the centre's own books; platform view; downgrade blocked by usage | A real payment provider for SaaS billing (sandbox gateway); dunning emails |
| 22 | `S22 white-label theme is changed` | Invalid colour 400; manager 403; theme and logo saved; public config (mode, name, title, tagline, support email, colours with defaults kept); logo served publicly, byte-identical; settings page; audit; email template preview carries the brand; another centre untouched; switch back to TypEase mode and forth | **How the web and mobile apps render the theme** (browser e2e, Flutter); favicon; emails as rendered by a client |
| 23 | `S23 custom-domain configuration is validated`; `S23 an unverified claim does not block a domain for ever, and a verified domain follows the plan` | Invalid names 400; TypEase hosts cannot be claimed (`DOMAIN_NOT_ALLOWED`); `PENDING` with the TXT record to create; not routed before verification (TLS ask 404, config 404, no CORS); no record / wrong record -> not verified; another centre cannot claim, verify or delete; right record -> `VERIFIED`: TLS ask 200, config by host, `x-tenant-host`, CORS; look-alike host 404; removal un-routes. Second test: claim blocks for 72 hours and is then released to the next claimant with a new token (old DNS record proves nothing), audit on the first centre without naming the other; a verified domain is never released; plan loses `customDomains` -> config 404, TLS ask 404, no CORS, `SUSPENDED_BY_PLAN`, centre's own address works; plan restored -> resolves again | **Real DNS and real certificates**: the DNS lookup is replaced by a table (the API's `FakeDns`), no certificate is issued; the reverse proxy (Caddy on-demand TLS) is not run; the 30-second resolution cache is emptied instead of waited for (cache timing: `services/api/test/domains.spec.ts`) |

### Scenario 26: payments exactly once (`I/06-payments-idempotency.spec.ts`)

| # | Test | Asserted | Not covered at this level |
| --- | --- | --- | --- |
| 26 | `S26 duplicate payment webhook does not duplicate payment` | The test plays the gateway (signed webhook built with the sandbox gateway's own builder). First delivery `processed`, three more `duplicate`; one payment `COMPLETED`, invoice `PAID`; in the tables: 1 payment, 1 allocation, 1 `payment.completed` event, 1 webhook event; liability accrued once; one receipt message; a different event for the same session and a late "failed" change nothing | A real gateway's webhook format (Stripe signature verification is unit-tested in the finance module with locally computed values; never against Stripe) |
| 26 | `S26 concurrent deliveries of one webhook complete the payment once` | Six simultaneous deliveries: all 200, exactly one processed; rows as above | |
| 26 | `S26 a forged, altered or misdirected webhook pays nothing` | Wrong secret, altered body, no signature, stale timestamp: `400 WEBHOOK_SIGNATURE_INVALID`, payment stays `PENDING`; delivery to the billing webhook books nothing; security events recorded; the genuine event still works once | |
| 26 | `S26 a declined attempt and a second, successful one leave exactly one completed payment` | `FAILED` attempt cannot be revived by a late success; second attempt pays; paid invoice cannot be paid online again | |
| 26 | `S26 an abandoned checkout is closed after 60 minutes, and a late success webhook still books the payment - once` | Attempt aged 61 minutes -> `CANCELLED / EXPIRED` by `finance.expire_checkouts`; 59 minutes stays `PENDING`; a declined one stays `FAILED`; invoice and inbox untouched; job idempotent, audited once as SYSTEM; late success -> `COMPLETED` once (duplicates and a second event id change nothing), `payment.checkout_revived`; a late failure for an expired attempt is ignored; the customer can start again | The 5-minute schedule itself |
| 26 | `S26 a manual payment sent twice or simultaneously is booked once (Idempotency-Key)` | Six identical simultaneous requests: one payment; replay returns it; same key with another body `409 IDEMPOTENCY_KEY_REUSED`; another centre's identical key is independent; two cashiers race for the balance: one wins; refund requests have the same protection | |

### Scenario 28: document links (`I/07-documents-links.spec.ts`)

| # | Test | Asserted | Not covered at this level |
| --- | --- | --- | --- |
| 28 | `S28 expired document download URL is rejected` | Link lifetime set to 2 seconds: in time the file, after expiry `403 LINK_EXPIRED` with no byte of the file, repeatedly; the same for an inline preview link; a new link works; the default lifetime is minutes | Expiry of S3 pre-signed URLs (enforced by the storage provider, not by TypEase) |
| 28 | `S28 a link cannot be forged, extended or obtained by somebody else` | Changed signature, extended expiry, nonsense, empty signature: 403; the token names neither the document nor the file; a download ticket is not an upload ticket; anonymous 401, other customer 404; attempts do not burn the genuine link; access log | |
| 28 | `S28 an expired upload URL cannot be used` | Upload after expiry `403 LINK_EXPIRED`; nothing can be completed (`409`) or downloaded | |
| 28 | `S28 a share link expires, runs out of downloads and can be revoked` | Customers cannot create share links; redeem counts down; token never listed; expired (database time travel), exhausted and revoked links `403 LINK_EXPIRED`; guessed token 404 | |
| 28 | `S28 a quarantined or deleted document gives no link, also to its owner` | EICAR test content -> `QUARANTINED`, no link for owner or staff, no share; deleted document: no link, share link dead; restored: link works | A commercial malware scanner (the built-in signature check finds EICAR) |

### Scenario 29: privacy and retention (`I/08-privacy-and-retention.spec.ts`)

| # | Test | Asserted | Not covered at this level |
| --- | --- | --- | --- |
| 29 | `S29 an archived customer leaves daily work, and the history stays and can be restored` | Receptionist cannot archive; blocked while a request is open; archived: not in the default list, not editable, no new requests (`CUSTOMER_NOT_ACTIVE`); record, completed case, paid invoice and documents intact; restore; audit | |
| 29 | `S29 a deletion request erases the person and keeps the books` | Customer files the request (deadline set, no second open request); only the privacy officer handles it; impact preview; completion blocked before approval and while a request / invoice is open (`ERASURE_BLOCKED` names them); after clearing: erasure; the record is 404 for staff and not searchable; database row `ANONYMISED` with every personal column empty; cases keep number, status and service but no name, no form data, no comment text; documents deleted without restore; messages kept without address or name; audit trail kept without the person's values (list, detail, CSV export); invoice, payment, receipt and today's report figures identical before and after; session dead, password dead, account row without password and email; the address can register again as a new customer; completing again changes nothing | **Whether the retention periods and the erasure scope satisfy UAE law** - a legal review, not a test (`docs/UAE_COMPLIANCE_REVIEW.md`); erasure of files in an S3 bucket and of backups |
| 29 | `S29 documents are deleted when their retention period ends, unless they are on legal hold` | A 30-day policy for supporting documents; of four documents (old, old on legal hold, recent, old passport under the general policy) the nightly job deletes exactly the first; purged file cannot be restored (`DOCUMENT_PURGED`); audit entry by SYSTEM; a held document cannot be deleted by hand (`LEGAL_HOLD`); releasing the hold lets the next run delete it | The 30-day restore window timing; physical removal from object storage |
| 29 | `S29 an export request gives the person their own data, and only to them` | Export file contains the person's profile, request with form data, invoice and payment; nothing of another customer, no internal columns; nobody else can open it | The export format as a contract for other systems |

### Scenario 30: reports reconcile (`I/09-reports-reconciliation.spec.ts`)

The test keeps its own books (`support/books.ts`) for a day of business: seven invoices (one from a full
request, one with a discount, one whose tax rounds, one corporate on account, one voided, one draft, one
refunded without cancelling the charge), payments by four methods on two days, two completed refunds and a
pending one, a credit note, abandoned and declined online attempts, four expenses.

| # | Test | Asserted | Not covered at this level |
| --- | --- | --- | --- |
| 30 | `S30 the records themselves agree with the books: every invoice total, balance and status` | Per invoice: total, tax, paid, refunded, credited, balance, status; lists of payments, refunds and open invoices add up to the books | |
| 30 | `S30 daily sales ...`, `S30 monthly service revenue`, `S30 transactions by service`, `S30 outstanding payments`, `S30 refunds`, `S30 liabilities ...`, `S30 corporate revenue and the company statement`, `S30 service profitability` | Every row and total of all eight financial reports equals the books (accrual revenue net of credit notes with the tax share removed proportionally, cash collections by day of receipt, pass-through fees never revenue, liabilities accrued / reversed / remitted, ageing, margins with one decimal); drill-downs add up to their rows; void and draft invoices appear nowhere; branch and single-day slices are consistent with the whole; over-remittance refused | Periods longer than two days; multi-currency (the product is AED only); a time zone other than Asia/Dubai |
| 30 | `S30 branch performance, dashboard, cash reconciliation and export show the same money` | Money columns of the branch report, the dashboard tiles and trends, the till reconciliation (`MATCHED`, difference 0.00) and the totals line of the CSV export; no money for roles without the financial permission; export audited | XLSX and PDF export content; scheduled report content (access to the files: `S/03`) |
| 30 | `S30 the figures do not move when the reports are asked again, and no financial report is left out` | The list of financial reports is exactly the eight compared above (a new one fails the test until it is reconciled); repeated calls return identical rows and totals | Operational (non-financial) reports are not reconciled against an independent model |

### Scenario 24: tenant isolation (`S/01`, `S/02`, `S/05`, `S/06`)

Two centres are populated through the API with a record of every main resource type; the owner of centre A
attacks centre B with the ids harvested there.

| File | Test | Asserted |
| --- | --- | --- |
| `S/01-tenant-isolation.spec.ts` | `S24 tenant A cannot read, update, delete or download a record of tenant B (every main resource type)` | 221 requests with valid bodies over customers, requests, documents and their links, quotations, invoices, credit notes, payments, refunds, expenses, reconciliations, appointments, queue, tasks, tickets, staff, roles, branches, services, workflows, scheduled reports, audit log, notifications, automations, reminders, corporate accounts and employees, integrations, domains, privacy records, support access: each answers **404** and contains nothing of B; the hash of every row B owns is unchanged |
| | `S24 every route of the application that names a record by id refuses the ids of tenant B` | The route table of the running app: all 267 tenant routes that take an id, with B's ids (and, for nested routes, own parent + B's child and B's parent + own child), with valid bodies: 404 everywhere; 403 only on portal routes closed to staff; nothing of B in any answer; B unchanged. Ten route parameters for which the populated centre has no record are listed in the test |
| | `S24 lists, searches, filters, reports and exports of tenant A never contain a row of tenant B` | Every list route; searches for B's names, emails, passport and phone numbers; 69 lists filtered by an id of B (empty or refused); every report with drill-down and CSV export; the audit export; A's report and dashboard figures are identical before and after B did a day of business |
| | `S24 a record of tenant B cannot be referenced from tenant A (ids of B in create and update bodies)` | 78 create / update requests of A carrying an id of B (customer, request, document and document version, quotation, invoice, payment, refund, credit note, expense, reconciliation, appointment, queue, task, ticket, reminder, staff, service, corporate price, scheduled report, privacy request): 404 from the application; no row in the database points across centres; B unchanged. **Control:** the same requests with A's own ids succeed |
| | `S24 a tenant id, slug or host supplied by the client never switches the tenant` | Spoofed `x-tenant-*`, `x-forwarded-host`, `origin`, `referer` headers, query parameters and body fields: still centre A; rows created stay in A; `switch-tenant` needs a membership; signing in "to" B with A's credentials; a correctly signed token that claims B's tenant on A's session is refused (401); a tampered token `TOKEN_INVALID`; a tracking code of B is worthless on A's portal |
| | `S24 control: ...` (two tests) | The leak detector and the fingerprint detect a real leak / change; the record requests succeed (or meet a state rule) against A's own records, so the 404s were about ownership |
| `S/02-customer-and-corporate-boundaries.spec.ts` | `S24 a customer cannot read, download, change or pay anything of another customer of the same centre` | 37 requests on another customer's request, documents, links, quotation, invoice, payment, credit note, ticket, appointment, privacy request, notification: 404; nobody else can accept a waiting quotation; ids of another customer inside own requests (upload target, checklist link, ticket, feedback, renewal) refused; a version id of somebody else's file does not redirect a link (download 404, preview serves the caller's own file); a `customerId` in the body does not change whose request it is; lists and filters only own rows; control: the owner reaches all of them |
| | `S24 a company administrator cannot see or touch another company, nor a private customer of the centre` | Other company's employees, requests, documents, invoices: 404; staff routes that take a company id: 403; lists and filters; the other company's own view |
| | `S24 a company employee sees only their own request - not a colleague's, not the company's books` | Colleague's request, comments, documents, uploads: 404; company administration and invoices: 403; own requests are private (the administrator does not see them) |
| | `no field in a request body makes a portal user more than they are (mass assignment)` | Profile, account, new request, comment, registration and invitation acceptance with extra fields (`status`, `roleKey`, `platformRole`, `tenantId`, `permissions` ...): ignored or refused |
| | `S24 portal users of centre A reach nothing of centre B (every portal route that takes an id)` | Customer, company administrator and company employee of A against every portal route with B's ids and valid bodies: 404; B unchanged |
| `S/05-platform-support-access.spec.ts` | `S24 platform: a platform admin cannot read tenant customer documents without an approved support-access grant` | Super Admin and Support Agent: all 451 tenant routes `403 TENANT_REQUIRED`; no platform role holds a tenant permission; the platform console (16 views) shows no customer data and no document id; a requested grant opens nothing (`409 ACCESS_NOT_APPROVED`); TypEase staff cannot approve; manager 403, other centre's owner 404; non-grantable scopes cannot be requested; a reason is required; denial is final; history with reason and decision note on the centre's audit trail |
| | `S24 platform: with a grant, platform staff reach only what its scopes open - reading, in that centre, until it ends` | `customer.read` only: documents `403 SUPPORT_ACCESS_SCOPE`, identity numbers masked; the centre may approve less, never more; with `document.read`: the file can be read (bytes identical); whole route table: exactly ten routes open; every change refused, nothing changed; other centre 404; platform console closed to the session; nobody else can enter the grant; every call on the centre's audit trail (allowed and refused) and on the document's access log; revocation and expiry end access on the next request |
| | `a suspended centre is closed to its staff and customers on the next request, keeps its data, and reopens` | Only a Super Admin suspends, with a reason; owner, manager, receptionist, accountant, customer and company administrator: `403 TENANT_UNAVAILABLE` with the tokens they hold; no new registrations; the owner still reads the reason and the subscription; the other centre unaffected; reactivated: everybody back, no row of the centre's data changed; platform audit trail |
| | `S24 platform: the hand-off code ...` | One-time code in the URL fragment; CSRF header required (code not used up without it); guessed, reused and replaced codes `HANDOFF_INVALID`; refresh token only as an HttpOnly cookie; revoked grant `SUPPORT_ACCESS_ENDED`; security events without the code |
| `S/06-row-level-security.spec.ts` | `S24 database: the connection the API uses for tenant data is an ordinary role ...` | `typease_app`: no superuser, no BYPASSRLS, owns nothing; 19 escape attempts refused by PostgreSQL (SET ROLE, disabling RLS, dropping policies or guards, credentials, server files); `row_security = off` makes queries fail instead of leak |
| | `S24 database: every table the role can touch is protected by a row-level security policy` | Catalogue check for all tables; the tables without a tenant column that the role may read are exactly `permissions, subscription_plans, tenants, users`; subscription tables read-only; no access to sessions and tokens |
| | `S24 database: without app.tenant_id the role sees no tenant rows and cannot write - in every tenant-owned table` | For every tenant-owned table (more than 90): 0 rows visible, UPDATE and DELETE touch 0 rows or are denied; INSERTs refused; pooled connections carry no leftover tenant; both centres' fingerprints unchanged |
| | `S24 database: with tenant A bound the role reaches only rows of A ...` | No row of another tenant visible in any table; platform default rows exist in exactly two tables and cannot be changed; rows of B cannot be updated, deleted, inserted, taken over or pointed at (RLS and the cross-tenant guard); a centre cannot activate itself, change its plan, rewrite its audit trail or alter issued financial records; controls succeed |

Not covered for scenario 24: isolation of files in object storage across centres (keys are per tenant; the
local storage driver is used), of cache keys in Redis, and of dedicated-database deployments (an optional mode
of section 5 that is not implemented). Row-level security cannot stop somebody who can execute arbitrary SQL as
`typease_app` from binding another tenant: that is the application's job and is tested over HTTP.

### Scenario 25: roles and refund approval (`S/03-roles-and-refund-approval.spec.ts`)

| Test | Asserted | Not covered at this level |
| --- | --- | --- |
| `S25 unauthorised role cannot approve refunds` | Who holds `refund.approve` / `refund.request` in the matrix; receptionist, reviewer, operator, manager, a custom role with every finance permission except `refund.approve`, the customer: approve, complete, process, reject -> `403 FORBIDDEN`, each recorded as a security event; no header, query or body field grants the permission; a manager cannot create or widen a role, promote themselves or invite somebody into a stronger role (`PRIVILEGE_ESCALATION`); refund still `REQUESTED`, payment, invoice, credit notes and the refund report untouched; then a second accountant approves: `COMPLETED`, books updated, audit shows two different people; decided refunds cannot be decided again | Refunds through a real gateway |
| `S25 segregation of duties: the person who requested a refund can never approve it - owner and accountant included` | Accountant and owner: `403 SELF_APPROVAL_FORBIDDEN` on approve / complete / process of their own request; two-step approval; operator may ask, manager may not decide; custom role with both permissions still locked out of its own request; a role that only approves can decide but not request; two approvals and a rejection at the same moment: exactly one decision, the others 409; two requests racing for the same remaining money: one accepted, one `REFUND_EXCEEDS_PAYMENT`; requested + paid out never exceeds the payment; for every completed refund the trail shows requester != decider | |
| `S25 segregation of duties for discounts ...` | Discount blocks sending (`DISCOUNT_APPROVAL_REQUIRED`); roles without `discount.approve` 403; manager approves the receptionist's, not their own; the author of a discounted invoice cannot issue it | The "only approver in the centre" exception (finance module spec) |
| `S25 the permission matrix holds on every route, for every system role` | Eight roles x all 548 non-public routes: a route the matrix closes answers `403 FORBIDDEN` (platform routes `PLATFORM_ONLY`, the machine route 401); a route the matrix opens is never refused by the guard; the number of guard refusals recorded as security events equals the number of routes the matrix closes, per role; the provisioned roles carry exactly the matrix's permissions | Custom roles beyond the three used; the UI hiding what a role cannot do |
| `a scheduled report file is opened through the report ...` | The generated file does not exist for the document vault (owner included); the report route gives it to holders of the report's permission only; other document ids 404 through that route; downloads audited | The content of the file |
| `S25 each role is refused what is not its job - with real records` | 13-15 refusals and 3-4 permitted calls per role (receptionist, operator, reviewer, accountant, manager) on real records; nothing changed; an operator sees only assigned requests and what hangs off them (documents, links, quotation, invoice, comments, tasks); an operator cannot approve own work; a receptionist limited to a branch sees and touches nothing of another branch (`BRANCH_FORBIDDEN`); suspension ends the session at once; a role change ends the sessions and the next sign-in carries the new role | |

### Around scenarios 24 and 25: authentication (`S/04-authentication-and-sessions.spec.ts`)

| Test | Asserted | Not covered at this level |
| --- | --- | --- |
| `unauthenticated access to every non-public route is refused (the whole route table)` | The list of public routes is the reviewed list of 40; every other route (548) answers 401 without a token, with garbage, with an expired but correctly signed token and with a token signed by another key; eleven more variants on a sample (alg `none`, HS512, other audience / issuer, unknown session, another user on the session, no `Bearer`, basic auth, cookie, other headers, query string); a hand-made token with the real key works (control) | TLS, HSTS and the reverse proxy; brute-force rate limits (switched off in the test environment: `RATE_LIMIT_ENABLED=false`) |
| `the public routes give a stranger presentation data or ask for a credential of their own` | 24 public routes refuse without their own credential; password reset, resend and sign-in do not reveal whether an account exists; presentation routes contain nobody's personal data; health endpoints reveal no connection strings | |
| `refresh-token reuse revokes the session family` | Rotation; the retired access token dies; replaying a used refresh token: 401, and the newest access and refresh tokens of the family die; the person's other device survives; a `REFRESH_TOKEN_REUSE` security event (HIGH); browser flow: HttpOnly, SameSite cookie scoped to `/api/v1/auth`, anti-CSRF header required, reuse kills the family | Cookie behaviour in real browsers (`Secure`, cross-site) |
| `signing out ...`, `at most twenty live sessions ...`, `accounts: lock-out ...` | Session list with `X-Total-Count`, limit, current session; nobody ends another person's session; logout; "everywhere else"; the 21st-23rd sign-in end the three oldest (`SESSION_EXPIRED`), per app; lock-out after five failures (429); password policy on registration, reset and change; one-time verification and reset links; reset and change end other sessions | MFA and OTP flows (foundation spec of the API) |

## What this suite does not do

- It does not start a browser, the Next.js apps, the Flutter app, the worker process, a reverse proxy, S3, a
  real payment gateway, a real SMS / WhatsApp / push provider, real DNS or a certificate authority.
- It does not measure performance or load.
- It does not replace the module specs in `services/api`: those test each rule of each module in depth; this
  suite tests that the modules work together and that the boundaries hold across all of them.

## Observations (not failures)

No test in the suite is marked as a product defect. Three things were noticed and are encoded as explicit,
narrow expectations so that they cannot spread unnoticed:

1. Two "list of sub-records" routes answer a foreign or unknown parent id with `200` and an empty page instead
   of `404`: `GET /documents/:id/extractions` and `GET /privacy/consents/customers/:customerId/history`
   (`EMPTY_SUBLIST_ROUTES` in `support/attacks.ts`). Nothing is disclosed - the answer is identical for an id
   that belongs to nothing - but it is not what `docs/architecture/BACKEND_CONVENTIONS.md` section 2 asks for.
2. `docs/api/modules/platform.md` ("Audit trail") reads as if `GET /audit-logs?supportGrantId=<id>` returned the
   centre's own decisions (`support_access.approved / denied / revoked`) as well. It returns what TypEase
   support did or requested under the grant (entries with `actorType: PLATFORM`); the centre's decisions are
   found with `resourceType=AccessGrant&resourceId=<id>`. The API's own spec (`platform.access.spec.ts`)
   asserts the implemented behaviour, so this is treated as a wording problem of the document.
3. The security event `REFRESH_TOKEN_REUSE` has no `userId` column value (the replaying caller is not signed
   in); the affected user is in `details.userId`. Filtering `/platform/security-events` by `userId` therefore
   does not find it.

## Known sensitivities

- **Midnight in Dubai (20:00 UTC).** Several files compute "today" on the centre's calendar when they start
  (`integration/04`, `09`; `security/01` compares today's figures before and after). A run that crosses
  20:00 UTC inside one of these files can fail. Run it again.
- **Real waiting.** `integration/07` waits about seven seconds for links to expire. The in-time fetch has a
  two-second window; a machine that stalls for longer makes that test fail.
- **Order.** All files of a folder share one database and run in name order. Scheduled jobs fan out over every
  centre in the database, including those of earlier files; no file relies on what another file left behind.
