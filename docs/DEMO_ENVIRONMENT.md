# Demo environment

`pnpm db:seed` fills an **empty** database with three fictional typing centres, their staff,
customers, cases, money, documents and support history, so that every screen of the four apps has
something meaningful to show and tenant isolation can be demonstrated.

> **For local development only - never deploy known demo passwords to production.**
> Every account below uses one shared password that is printed in this file. The seed refuses to run
> with `NODE_ENV=production`, refuses a database that already contains centres, and never deletes data.
> All people, companies, numbers and documents are invented.

Contents: [1 Run it](#1-run-it) - [2 Logins](#2-logins) - [3 What to look at](#3-what-to-look-at-per-role) -
[4 Tenant isolation](#4-demonstrating-tenant-isolation) - [5 Plan limits](#5-plan-limits-desert-rose) -
[6 What the data contains](#6-what-the-data-contains) - [7 Fictional data](#7-how-the-fictional-data-is-recognisable) -
[8 How the seed works](#8-how-the-seed-works) - [9 Limits](#9-known-limits-of-the-demo-data) -
[10 Reset](#10-reset-the-demo)

## 1. Run it

Requirements: PostgreSQL with the migrations applied to an **empty** database, Redis, and the same
environment the API uses (database URLs, `JWT_ACCESS_SECRET`, `DATA_ENCRYPTION_KEY`, `HMAC_KEY`,
storage settings). The seed encrypts identity numbers and stores files with these settings: seed with the
environment the API will later run with, otherwise the API cannot decrypt or find them.

**Stop the API and the worker first.** The seed starts its own copy of the application; a running worker
would pick up the same events and deliver the demo messages through whatever mail / SMS driver it has.

```bash
# environment already exported in the shell
pnpm db:seed

# or let the seed read a KEY=VALUE file (values already set in the shell win)
pnpm db:seed --env-file=.env

# check the result (read-only; see section 8)
node scripts/seed-verify.mjs --env-file=.env
```

Docker Compose: `docker compose --profile seed run --rm seed` (see `docs/deployment/docker.md`).

It takes about two and a half minutes (measured: 144 s and 154 s for two consecutive runs on the build
machine, about 3,460 API calls) and prints one line per step, the list of logins and the tracking codes
of three requests. If a step fails, the seed stops and prints the API's own error message; nothing is
rolled back, so reset the database (section 10) before running it again.

| Option / variable | Meaning |
| --- | --- |
| `--env-file=<path>` | read `KEY=VALUE` lines before starting |
| `--force-empty-check=skip` | development only: do not insist on a database without centres |
| `DEMO_PASSWORD` | the shared password. Default: `TypEase-Demo-2026`. Your own value must pass the API's password rules, otherwise the first sign-up fails with the API's message |
| `LOG_LEVEL` | default `warn` during a seed |

Settings the seed forces **for its own process only** (nothing is written to a file):
`EXPOSE_DEV_TOKENS=true` (verification and invitation tokens come back in API responses),
`QUEUE_DRIVER=inline`, `RATE_LIMIT_ENABLED=false`, `PAYMENT_SANDBOX_ENABLED=true`,
`MAIL_DRIVER=SMS_DRIVER=WHATSAPP_DRIVER=PUSH_DRIVER=log` (no real message can leave, whatever the
developer's environment says), `MALWARE_SCANNER=none`, `OUTBOUND_WEBHOOK_ALLOWED_HOSTS=127.0.0.1`, and it
removes the Stripe and n8n settings and an external OCR provider from its environment.

After seeding, start the API with `PAYMENT_SANDBOX_ENABLED=true` if you want to try online payments
(the centres use the test gateway), and with `EXPOSE_DEV_TOKENS=true` if you want to register new
accounts without a mailbox.

## 2. Logins

Password for **every** account: `TypEase-Demo-2026` (or your `DEMO_PASSWORD`).
The seed signs in with each of these accounts at the end of the run, so a listed login that does not work
means the database was changed afterwards.

| App | Local URL | Behind the development proxy |
| --- | --- | --- |
| Centre app (staff) | http://localhost:3001 | `http://app.typease.localhost` |
| Customer portal | http://localhost:3002/?tenant=`<slug>` | `http://<slug>.typease.localhost` |
| Corporate portal | http://localhost:3003/?tenant=`<slug>` | `http://corporate.typease.localhost/?tenant=<slug>` |
| Platform console | http://localhost:3004 | `http://admin.typease.localhost` |
| API | http://localhost:4000/api/v1 | `http://api.typease.localhost` |

One-click logins: when an app is started with `NEXT_PUBLIC_DEMO_PASSWORD` set to the shared password (demo
sites only - see each app's `.env.example`), `/sign-in?demo=<email>` (portals: `?tenant=<slug>&demo=<email>`)
signs straight in as that seeded `.test` account. The landing page in `marketing/landing/` has a button per role.

Staff do not choose a centre: their account belongs to exactly one. The two portals take the centre from
the address (`<slug>.typease.localhost`, or `?tenant=<slug>` which is then remembered in a cookie).
Slugs: `al-noor`, `gulf-star`, `desert-rose`.

### TypEase platform

| Role | Email | Name |
| --- | --- | --- |
| Platform super admin | `admin@typease.test` | Platform Admin (demo) |
| Platform support agent | `support@typease.test` | Platform Support Agent (demo) |

### Al Noor Typing Centre (`al-noor`) - Business plan, active, white label, two branches

| App | Role | Email | Name | Notes |
| --- | --- | --- | --- | --- |
| Centre | Owner | `owner@al-noor.test` | Salem Al Marri | everything, both branches |
| Centre | Manager | `manager@al-noor.test` | Priya Nair | Sharjah branch only |
| Centre | Receptionist | `reception.dubai@al-noor.test` | Maria Santos | Deira head office only |
| Centre | Receptionist | `reception.sharjah@al-noor.test` | Ahmed Farouk | Sharjah only |
| Centre | Typing operator | `operator1@al-noor.test` | Rahul Menon | Deira; visas, family files, Emirates ID |
| Centre | Typing operator | `operator2@al-noor.test` | Fatima Zahra Idrissi | both branches; licences, attestation, translation |
| Centre | Typing operator | `operator3@al-noor.test` | Bilal Chaudhry | Sharjah; tenancy, Emirates ID, medical bundle |
| Centre | Document reviewer | `reviewer@al-noor.test` | Lakshmi Iyer | reviews and final checks |
| Centre | Accountant | `accountant@al-noor.test` | Omar Haddad | finance |
| Customer portal | Customer | `aisha.rahman@example.test` | Aisha Rahman | AN-000027 with the partner, AN-000052 waiting for payment |
| Customer portal | Customer | `noura.al.ketbi@example.test` | Noura Al Ketbi | Arabic; quotation with a discount to accept (AN-000046) |
| Customer portal | Customer | `grace.mendoza@example.test` | Grace Mendoza | registered online; a draft to finish (AN-000056) |
| Customer portal | Customer | `emily.carter@example.test` | Emily Carter | quotation to accept or reject (AN-000058) |
| Customer portal | Customer | `joseph.mathew@example.test` | Joseph Mathew | a rejected photo to replace (AN-000050) |
| Customer portal | Customer | `rowena.castillo@example.test` | Rowena Castillo | registered online; a draft (AN-000063) |
| Customer portal | Customer | `hassan.el.sayed@example.test` | Hassan El Sayed | Arabic; an invoice to pay online (AN-000059) |
| Customer portal | Customer | `daniel.okafor@example.test` | Daniel Okafor | a new request (AN-000062), a cancelled one, a deletion request that is blocked while a request is open |
| Corporate portal | Company administrator | `admin@falcon-demo.test` | Deepa Krishnan, Falcon Demo Logistics LLC | verified, credit approved, 6 employees |
| Corporate portal | Company administrator | `admin@marsa-demo.test` | Elias Haddad, Marsa Demo Catering LLC | **suspended**: can read, cannot order |

A ninth customer (Krishna Thapa) has an invitation that was never accepted, and the company
Blue Dune Demo Trading LLC is still waiting for verification: both are visible to staff only.

### Gulf Star Document Services (`gulf-star`) - Professional plan, active, TypEase branding, one branch

| App | Role | Email | Name | Notes |
| --- | --- | --- | --- | --- |
| Centre | Owner | `owner@gulf-star.test` | Shaima Al Ali | |
| Centre | Receptionist | `reception@gulf-star.test` | John Fernandes | |
| Centre | Typing operator | `operator@gulf-star.test` | Usman Tariq | requests are assigned automatically |
| Centre | Accountant | `accountant@gulf-star.test` | Meera Joshi | |
| Customer portal | Customer | `anita.dsouza@example.test` | Anita DSouza | an invoice to pay (GS-000017) |
| Customer portal | Customer | `marilou.ramos@example.test` | Marilou Ramos | registered online; a draft (GS-000021) |
| Customer portal | Customer | `olivia.bennett@example.test` | Olivia Bennett | one completed request |
| Corporate portal | Company administrator | `admin@pearl-demo.test` | Sanjay Kapoor, Pearl Demo Contracting LLC | 3 employees, two unpaid invoices on account |

### Desert Rose Typing (`desert-rose`) - Starter plan, in its trial, one branch

| App | Role | Email | Name | Notes |
| --- | --- | --- | --- | --- |
| Centre | Owner | `owner@desert-rose.test` | Mona Abdulla | trial banner, plan limits (section 5) |
| Centre | Receptionist | `reception@desert-rose.test` | Carlos Reyes | |
| Customer portal | Customer | `liza.soriano@example.test` | Liza Soriano | one request waiting for payment |

There is no login with the role `corporate_employee`: no endpoint creates one (see section 9).

Request, invoice and customer numbers are the same after every run of an unmodified seed (the data set is
deterministic). Tracking codes are generated by the API and differ per run: the seed prints three of them.

## 3. What to look at per role

**Owner, Al Noor** (`owner@al-noor.test`)
- Requests in every status. Examples: AN-000045 and AN-000050 wait for the customer because a document was
  rejected; AN-000017 went back to "Under review" because its quotation QUO-000017 expired; AN-000022 was
  reopened after completion; AN-000023 is overdue; AN-000028 was closed as a duplicate; AN-000024 was
  returned by the partner and AN-000025 rejected; AN-000036 and AN-000041 wait for internal approval.
- Settings: white-label branding with a logo, the custom domain `portal.alnoor-typing.test` waiting for
  DNS verification, two branches with different opening hours, roles (the receptionist role was given
  ticket handling), Integrations (test payment gateway, a verified partner record, a switched-off SMS
  gateway that caused the failed notifications).
- Catalogue: the starter services plus three of its own - "Family residence file" (partner coordination,
  needs internal approval), a medical / Emirates ID bundle and an express desk service for Deira only;
  the "standard" workflow in version 2 (an extra customer notification after payment, published 45 days
  ago - older requests still run on version 1).
- Subscription: four paid invoices, the first three with the coupon `DEMO20`.
- Support access: one request from TypEase support that was approved, used and revoked - the audit trail
  shows every step.
- Notifications: sent, suppressed (opt-out, no address) and seven failed SMS from the gateway outage, one
  of them retried successfully.

**Manager** (`manager@al-noor.test`): the same centre reduced to the Sharjah branch - requests, queue and
appointments of Deira are not there. Decides on discounts, refunds and internal approvals; sees the
overdue escalations of the branch.

**Receptionists**: `reception.dubai@al-noor.test` sees today's queue at Deira (three waiting, one called,
one being served), today's appointments, walk-in registration and customer search by the demo identity
numbers. `reception.sharjah@al-noor.test` sees none of that - a different branch.

**Operators**: each sees the requests assigned to them. Rahul Menon (operator1) has the most: preparation
tasks, a question to a customer, the partner submissions; Fatima Zahra Idrissi has AN-000029 waiting for
an answer; Bilal Chaudhry has the Sharjah cases including the overdue AN-000023.

**Reviewer** (`reviewer@al-noor.test`): documents to verify (37 not yet reviewed), expiring documents,
requests in "Pending approval" and "Final review", one document in quarantine (the EICAR antivirus test
file) and one under legal hold.

**Accountant** (`accountant@al-noor.test`): quotations (a discount waiting for approval on QUO-000044, a
rejected and an expired quotation), invoices in every state (draft, issued, part-paid, paid, void,
credited), payments by cash, card terminal, bank transfer, cheque and the online test gateway (one failed
attempt, one still open), refunds (two completed, RFD-000004 waiting for approval, RFD-000003 rejected),
credit notes, expenses including government-fee remittances linked to requests, three reconciliation
records (cash closed, card terminal with a discrepancy, gateway open), the statement payment of Falcon
Demo Logistics covering several invoices.

**Customers** (portal): own requests with their timeline, documents with expiry dates and reminders,
quotations to accept, invoices to pay through the test gateway (card form of the sandbox, no money moves),
appointments, support tickets, consent settings and the privacy requests (export, correction, deletion).
Noura Al Ketbi and Hassan El Sayed use Arabic.

**Company administrators** (corporate portal): employees, requests ordered for employees, invoices on
account and the statement, company documents (trade licence with an expiry reminder), contract prices.
Marsa Demo Catering is suspended: reading works, ordering answers `403 CORPORATE_ACCOUNT_NOT_ACTIVE`.

**Gulf Star**: a smaller centre with TypEase branding and automatic assignment; basic finance; one
partner record that is still waiting for the TypEase review.

**Desert Rose**: a centre five days into its trial, with six customers and six requests.

**Platform super admin** (`admin@typease.test`): the three centres with plan, status and usage; SaaS
billing (paid invoices, one first invoice recorded as an offline bank transfer, coupon DEMO20); the
support desk with questions from the centres; the incident register and the processor register; the
authorisation record of Gulf Star waiting for review; support access requests of all staff.

**Platform support agent** (`support@typease.test`): the support desk, and support access - a request to
Gulf Star waiting for the owner, one that Desert Rose denied, one that Al Noor approved and later revoked.
The agent has no access to any centre's data without an approved grant.

## 4. Demonstrating tenant isolation

1. **Same URL, two centres.** Open the centre app in two browser profiles, sign in as
   `owner@al-noor.test` in one and `owner@gulf-star.test` in the other, and open `/requests` (or
   customers, invoices, documents) in both: same address, completely different data, different branding.
2. **Direct access by id answers 404, not 403.** Copy the address of a request (or customer, invoice,
   payment, quotation) from the Al Noor window into the Gulf Star window: "not found". The other centre
   cannot even learn that the record exists. The seed performs these checks itself at the end of every run
   and stops if one of them does not answer 404:

   | Who | Tries to open | Answer |
   | --- | --- | --- |
   | Al Noor owner | a Gulf Star customer, request, invoice, payment | `404 NOT_FOUND` |
   | Gulf Star owner | an Al Noor customer, request, quotation | `404 NOT_FOUND` |
   | customer Aisha Rahman | another customer's request (same centre) | `404 NOT_FOUND` |
   | Marsa Demo Catering administrator | an employee of Falcon Demo Logistics | `404 NOT_FOUND` |
   | Maria Santos (Deira only) | a request of the Sharjah branch | `404 NOT_FOUND` |

3. **With curl** (API on port 4000):

   ```bash
   login() { curl -s localhost:4000/api/v1/auth/login -H 'content-type: application/json' \
     -d "{\"email\":\"$1\",\"password\":\"TypEase-Demo-2026\",\"app\":\"centre\"}" | node -pe 'JSON.parse(require("fs").readFileSync(0)).accessToken'; }
   A=$(login owner@al-noor.test); G=$(login owner@gulf-star.test)
   ID=$(curl -s 'localhost:4000/api/v1/requests?pageSize=1' -H "authorization: Bearer $A" | node -pe 'JSON.parse(require("fs").readFileSync(0)).data[0].id')
   curl -s -o /dev/null -w '%{http_code}\n' localhost:4000/api/v1/requests/$ID -H "authorization: Bearer $A"   # 200
   curl -s -o /dev/null -w '%{http_code}\n' localhost:4000/api/v1/requests/$ID -H "authorization: Bearer $G"   # 404
   ```

4. **Platform staff see no customer data.** Sign in to the platform console: centres appear with plan and
   usage only. Support access must be requested and approved by the owner; the seed shows that the
   approved scopes work, that documents stay closed without the `document.read` scope, that nothing can
   be written, and that the same session is refused the moment the owner revokes the grant.
5. **In the database.** `node scripts/seed-verify.mjs` follows every foreign key between tenant-owned
   tables (104 relations) and reports any row that points into another centre; row-level security is on
   for all 101 tenant-owned tables, and the application role sees no row at all without a selected centre.

## 5. Plan limits (Desert Rose)

Sign in as `owner@desert-rose.test` (Starter plan, trial). These actions are refused with
`402 PLAN_LIMIT_REACHED` and an upgrade message; the seed tries each of them:

| Action | Message |
| --- | --- |
| add a second branch | "Your plan includes 1 branches. Upgrade your subscription to add more." |
| add a corporate account | "Your plan includes 0 corporate clients. ..." |
| switch to white-label branding | "White-label branding is not included in your plan. ..." |
| add a custom domain | "Custom domains is not included in your plan. ..." |

## 6. What the data contains

Numbers of the verified reference run (`node scripts/seed-verify.mjs`, 59 checks):

| | Al Noor | Gulf Star | Desert Rose |
| --- | --- | --- | --- |
| Plan / status | Business / active | Professional / active | Starter / trial |
| Signed up | 116 days ago | 50 days ago | 5 days ago |
| Staff accounts | 9 | 4 | 2 |
| Customers (incl. company employees) | 45 | 16 | 6 |
| Portal accounts / company administrators | 8 / 2 | 3 / 1 | 1 / 0 |
| Corporate accounts | 3 (active with credit, pending, suspended) | 1 | - |
| Requests | 63, all 16 statuses | 21 | 6 |
| Quotations | 54 | 17 | 4 |
| Invoices | 53, all 6 states | 18 | 4 |
| Payments | 46, all 5 methods | 14 | 3 |
| Refunds / credit notes | 4 / 4 | 1 / 1 | - |
| Expenses | 16 | 5 | 1 |
| Documents | 162 | 59 | 11 |
| Appointments | 19 | 4 | 1 |
| Queue tokens (today) | 10 | - | - |
| Tasks | 170 | 50 | 10 |
| Support tickets (customer + platform) | 8 + 2 | 2 + 1 | 1 |
| Notifications | 1,121 | 358 | 75 |
| Expiry reminder schedules | 84 | 35 | 4 |

Also: 233 uploaded sample files, 2 documents with several versions, 14 documents expiring within 60
days, 45 completed (output) documents, 79 consent records, 6 data subject requests (received, in review,
approved, completed, rejected - and a deletion that the system blocks because a request is still open),
3 support access requests, 658 request status history rows. Request activity starts 88 days ago.

## 7. How the fictional data is recognisable

| Kind | Pattern | Why it cannot be real |
| --- | --- | --- |
| Email | `...@example.test`, `...@<centre>.test`, `...@<company>-demo.test`, `...@typease.test` | `.test` is reserved (RFC 2606 / 6761): no such domain can exist |
| Phone | `+971 59 000 0NNN` | see the note below |
| Emirates ID | `784-1900-0000NNN-C` | year of birth 1900, serial 0000NNN, and `C` is deliberately **not** the valid check digit (Luhn digit plus one) |
| Passport | `TEST0NNNN` | |
| Trade licence / tax number | `SAMPLE-TL-00NN`, `SAMPLE-TRN-<CENTRE>` | |
| Authority / partner references, cheque and transfer references | `SAMPLE-<TYPE>-NNNN` | labelled as sample values |
| Companies, partners, authorities | names contain "Demo" or "(fictional)" | |
| Custom domain | `portal.alnoor-typing.test` | reserved top-level domain |
| Files | `sample-*.pdf`, `sample-*.png` | generated by the seed with a diagonal watermark "FICTIONAL SAMPLE - NOT A REAL DOCUMENT"; photos are a grey silhouette placeholder with initials |

**Phone range - an assumption, not a verified fact.** The UAE has no number range reserved for fiction.
To our knowledge mobile numbers start with 050, 052, 054, 055, 056 or 058 and 059 is not allocated to an
operator, so `+971 59 000 0NNN` should have no subscriber while still passing validation. This was not
checked against the regulator's current numbering plan. Check it (and change `PHONE_PREFIX` in
`database/seed/identity.ts`) before using the data anywhere messages could really be sent. The seed
itself can never send one: it forces the `log` drivers.

People have ordinary invented names of mixed nationalities. Any resemblance to a real person is
coincidental; no real identity number, company or government reference is used.

One upload is the standard EICAR antivirus test string inside a PDF wrapper (`sample-antivirus-test-file.pdf`).
It is harmless by design, is detected by the built-in check and ends in quarantine; local antivirus
software may flag the file in the storage directory.

## 8. How the seed works

- `services/api/src/cli/seed.ts` starts the real application in its own process on a free port and uses
  the **public HTTP API** like the web apps do: sign-up, email and phone verification, onboarding, staff
  invitations, catalogue, customers, the three-step document upload, verification, quotations, approvals,
  manual payments, the test gateway with its signed webhook, refunds, appointments, the queue, tickets,
  privacy requests, support access. After each step it delivers the outbox events and runs the queued
  jobs, which is what the worker does.
- The data lives in `database/seed/` as TypeScript modules (`tenants/*.ts`, `platform.ts`, `forms.ts`,
  `identity.ts`); the code that drives the API is in `services/api/src/cli/seed/`.
- Deterministic: a fixed pseudo-random seed (`typease-demo-v1`); two runs produce the same counts.
- **History without touching history tables.** Two parts of the application read the time from a clock
  that can be moved, and the seed moves it instead of editing rows: the subscriptions module
  (`BillingClock`, so the real lifecycle job creates trials, invoices, renewals and payments day by day)
  and the request workflow (`Clock`, so request creation, the append-only status history, steps,
  assignments and approvals get their dates natively).

### Direct database access

Everything else goes through the API. The exceptions, each printed at the end of a run:

| What | Why |
| --- | --- |
| `users`: the first platform super admin is inserted | No endpoint creates the first administrator, by design. The support agent is then invited by that administrator through `POST /platform/staff`. |
| `appointments`: `startsAt`, `endsAt`, `checkedInAt`, `createdAt` of past and same-day appointments | The API only books future slots. Appointments are booked for a coming week and moved back by whole weeks; their status changes go through the API. |
| One pass that moves creation-style timestamps (`createdAt`, `updatedAt`, `sentAt`, `decidedAt`, `verifiedAt`, `dueAt` ...) of non-append-only rows into the past | To spread customers, documents, quotations, tasks, tickets, notifications over the weeks. The exact tables and columns are listed in `services/api/src/cli/seed/timeline.ts`. |

Never touched: the append-only tables (`audit_logs`, `security_events`, `request_status_history`,
`document_access_logs`, `consent_records`, `payment_allocations`, `liability_entries`) and everything the
immutability triggers protect (invoice numbers, amounts and issue dates; payment amounts, methods and
receipt dates; refund and credit-note amounts).

Only when the application runs with a reduced module list (`TYPEASE_MODULES` without `integrations` or
`platform`) the seed additionally inserts the integration records (test payment gateway, partner record,
the SMS gateway of the outage) and the support agent directly, because those endpoints do not exist then.
The run says so in its summary.

### The verification script

`node scripts/seed-verify.mjs [--env-file=<path>]` connects with `SEED_VERIFY_DATABASE_URL`, else
`DATABASE_SYSTEM_URL`, else `DATABASE_MIGRATION_URL` (not the application role: row-level security hides
everything from it), in a read-only session. It prints the summary of section 6 and checks: the three
centres with plan, status and branding; accounts per role; customers and companies; every request status
in Al Noor and the exception paths; quotations, invoices, payments, refunds per state and that balances
add up; documents per state; appointments, queue, tasks, tickets, notifications, reminders, consents;
that every tenant-owned table holds only rows of the three centres and no foreign key crosses centres;
that every email, phone number, licence and reference follows the patterns of section 7. With `HMAC_KEY`
set it also proves that every stored Emirates ID and passport number comes from the fake ranges. `pg` is
resolved from the `database` package, so the script runs from any directory. Exit code 1 = a check failed.

## 9. Known limits of the demo data

- **Dates that stay on the day of the seed.** Invoice issue dates, credit-note dates and the receipt date
  of online payments are protected by database triggers and are therefore "today", although the invoice
  rows, quotations and the cases around them are spread over the weeks. Manual payments carry their real
  (past) receipt date because the API accepts one. Audit entries, consent events, payment allocations and
  document access logs are append-only and also carry the seed's date. Reports by invoice date show the
  whole turnover on one day; reports by request, payment receipt or completion date show the history.
- **Appointment confirmations.** Past appointments were booked for a coming week and moved back; the
  confirmation messages in the notification log are dated today and mention the original date.
- **"Today".** Appointments of today and the queue are created relative to the moment the seed runs
  (Dubai time). Seed in the morning for a full "today"; a later run produces more no-shows. Re-seed on
  the day of a demonstration.
- **No `corporate_employee` login.** The role exists, but no endpoint creates such a membership; employees
  are represented as customers of the company.
- **No OCR results.** OCR is disabled unless the installation configures a provider; the seed does not
  start one.
- **Automations, scheduled reports, feature flags** are not seeded; the screens start empty.
- **Escalations.** Because steps were "waiting" for weeks in back-dated cases, the escalation job creates
  a fair number of "overdue step" tasks for the managers (16 at Al Noor).
- **The SMS outage.** For the failed notifications the owner of Al Noor configures an SMS gateway whose
  address is a closed port on the local machine (`https://127.0.0.1:2/...`) and switches it off again.
  It stays in Settings > Integrations as a disabled entry.

## 10. Reset the demo

```bash
# stop the API and the worker, then:
ALLOW_DB_RESET=true pnpm db:reset          # drops everything, re-applies the migrations, seeds again
```

`pnpm db:reset` needs `ALLOW_DB_RESET=true`, the migration role (`DATABASE_MIGRATION_URL`) and is refused
with `NODE_ENV=production`. To rebuild without seeding:
`ALLOW_DB_RESET=true pnpm --filter @typease/database exec tsx scripts/migrate.ts --reset`, then
`pnpm db:seed` whenever you want the data.

Also clear what lives outside the database, otherwise old files and queued jobs stay behind (sessions are
rows in PostgreSQL and go with the reset):

- the storage directory (`STORAGE_LOCAL_DIR`) or the development bucket - the seed uploads about 230 files;
- Redis (`redis-cli -n <db> flushdb` for the development database) - rate-limit counters, the job queue and
  the worker heartbeat.

Then start the API and the worker again and sign in with the logins of section 2.

**For local development only - never deploy known demo passwords to production.**
