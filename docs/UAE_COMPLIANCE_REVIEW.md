# UAE compliance review (engineering self-assessment)

> **This is not legal advice and not a statement of compliance.** It was written by the engineers who built
> TypEase. It describes which technical controls exist in the code and which do not, arranged by the topics a
> UAE adviser is likely to ask about. It does not say what the law requires of any particular operator or
> typing centre, and nothing in it has been reviewed by a lawyer, a tax adviser or a regulator.
>
> The existence of a control does not make its use lawful or sufficient. **Before real customer data is
> processed, the operator and each centre must obtain a review by qualified UAE legal and tax advisers.**
> Section 10 lists the questions to put to them.

## Contents

1. [Scope](#1-scope)
2. [Who is responsible for what](#2-who-is-responsible-for-what)
3. [Personal data protection](#3-personal-data-protection)
4. [VAT](#4-vat)
5. [Electronic payments](#5-electronic-payments)
6. [Government services](#6-government-services)
7. [Arabic support](#7-arabic-support)
8. [Demo and test data](#8-demo-and-test-data)
9. [Records the operator must keep](#9-records-the-operator-must-keep)
10. [Questions for the advisers](#10-questions-for-the-advisers)
11. [Summary of what is missing](#11-summary-of-what-is-missing)

## 1. Scope

| Topic | Reference used for the headings | What this document does |
| --- | --- | --- |
| Personal data | UAE Federal Decree-Law No. 45 of 2021 on the Protection of Personal Data (PDPL), by its general principles | Maps each principle to code. No article numbers are cited and no interpretation is offered |
| VAT | UAE VAT at the standard rate of 5% | Describes the tax fields, invoices and credit notes the system produces |
| Payments | Card and online payments | Describes where card data does and does not flow |
| Government services | Section 31 of the product specification | Describes what the code enforces |
| Language | English and Arabic | Describes what is and is not available in Arabic |

Other regimes may apply and are **not** assessed here: rules of the financial free zones (DIFC, ADGM) and
other free zones with their own data-protection regulations, sector rules of individual authorities,
consumer protection, electronic transactions and trust services, anti-money-laundering obligations,
commercial licensing of typing centres, labour and immigration record-keeping, and the terms each authority
sets for service centres. Whether any of them applies is a question for the advisers.

Status of the software itself: no independent security review or penetration test has been done
([SECURITY_CHECKLIST.md](SECURITY_CHECKLIST.md)); no external provider has been contacted; the deployment
layer has never been run ([KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)).

## 2. Who is responsible for what

The software has three kinds of party. Which legal role each one has (controller, processor, joint
controller, sub-processor) is a legal determination this document does not make.

| Party | What it does in the system |
| --- | --- |
| The operator | Hosts TypEase, holds the encryption keys and the database, chooses the hosting region and the platform-level providers, employs the platform administrators and support agents |
| A typing centre (tenant) | Decides which customer data to collect, which services to offer, which forms to use, which providers to connect, how long to keep data, and who of its staff sees what |
| A customer or a company | Gives the centre data and documents, in person or through the portals |

The customer portal's built-in privacy policy text says that the centre is responsible for the data and that
TypEase processes it on the centre's behalf. That sentence is part of an unreviewed template (section 3.2)
and is a statement to be confirmed, not a finding.

Technical facts relevant to the determination:

- Platform staff cannot read a centre's data, except through a time-limited, scoped, read-only access grant
  that the centre approves, and every use is recorded in the centre's audit trail
  ([TENANT_ISOLATION.md](TENANT_ISOLATION.md), section 5).
- A login account (`users`) is shared across centres: the same email address is one account even when the
  person is a customer of two centres. The profile data of the person at each centre is separate.
- All centres share one database, one file store and one job queue. Separation is logical (row-level
  security and application checks), not physical.

## 3. Personal data protection

Module: `services/api/src/modules/privacy`, with consent in the customers module. Reference:
[api/modules/privacy.md](api/modules/privacy.md), [api/modules/customers.md](api/modules/customers.md).
Staff app screen: **Privacy** (owner only by default: `privacy.manage`).

![Privacy screen of the staff app](brand/screenshots/centre-adm-privacy-en-light-desktop.png)

### 3.1 Lawful basis and consent records

What exists:

| Control | Detail |
| --- | --- |
| Six purposes | `SERVICE_PROCESSING`, `REMINDERS`, `MARKETING`, `AI_PROCESSING`, `DOCUMENT_REUSE`, `WHATSAPP` |
| Current state per purpose | `customer_consents`: granted or withdrawn, lawful basis, notice version, dates |
| History | `consent_records`: every change with purpose, status, lawful basis, notice version, channel (`STAFF_RECORDED`, `PORTAL`, `MOBILE`), who recorded it and the IP address. Append-only in the database |
| Lawful basis field | One of `CONSENT`, `CONTRACT`, `LEGAL_OBLIGATION`, `LEGITIMATE_INTEREST`. The default is `CONTRACT` for `SERVICE_PROCESSING` and `CONSENT` for the others. Staff can record a different basis |
| Withdrawal | Customers change their own consents in the portal (profile, privacy section) or ask staff. They cannot switch off `SERVICE_PROCESSING` themselves |
| Registration | Self-registration requires ticking acceptance of the terms and privacy notice, and records `SERVICE_PROCESSING` (contract) and the customer's marketing choice. A customer registered by staff gets `SERVICE_PROCESSING` recorded |

How each purpose is enforced in code:

| Purpose | Enforcement |
| --- | --- |
| `REMINDERS` | Expiry reminders are sent only with a **granted** consent; otherwise the dispatch is recorded as `SKIPPED_NO_CONSENT` |
| `MARKETING` | Marketing messages need a granted consent and the profile opt-in |
| `WHATSAPP` | Nothing is sent on WhatsApp without a granted consent |
| `DOCUMENT_REUSE` | A document already on file is linked to a new request automatically only with a granted consent; otherwise a person has to link it |
| `AI_PROCESSING` | OCR is refused when the consent is **withdrawn**. When no decision is recorded, staff-initiated OCR proceeds, on the stated basis that the customer asked the centre to handle the document. It is opt-out, not opt-in |
| `SERVICE_PROCESSING` | Recorded, not enforced: nothing in the request flow checks it |

What does not exist:

- The lawful basis is a label a person chooses. The system does not determine or validate it.
- Corporate employees and customers created for a company get no consent rows; reminders to companies go to
  the company's contacts without a consumer consent.
- There is no consent record for staff members, guests who book an appointment without an account, or
  visitors to the public pages.
- The notice version stored with a consent is filled in only when staff type it. The portals do not send a
  version, so a consent given online does not record which notice text was shown.
- No age check and no parental-consent mechanism. Centres routinely handle documents of dependants and
  minors (family visas); the system treats them like any other document.
- No cookie banner. The web apps use only functional cookies and browser storage (session refresh, language,
  theme, the remembered centre) and include no analytics or advertising scripts; whether a notice is needed
  is a legal question.

### 3.2 Transparency: privacy notice and terms

- The customer portal has a **Privacy policy** page and a **Terms of service** page
  (`apps/customer-web`, routes `/privacy` and `/terms`). Their text is a general template in the
  application's dictionaries, in English and Arabic, displayed under a warning that it "must be reviewed and
  completed by the centre's legal and data-protection advisers before it is relied on".
- The text is the same for every centre apart from the centre's name. **A centre cannot edit it in the
  application**; changing it requires changing the dictionary files and rebuilding the portal.
- There is no versioning of the notice, no record of which version a person saw, and no re-acceptance flow
  when it changes.
- The corporate portal, the staff application and the mobile app have no privacy notice of their own.

### 3.3 Purpose limitation

- Data is organised by purpose-specific modules, and the consent purposes above gate the secondary uses
  (reminders, marketing, WhatsApp, reuse, OCR).
- Outbound automation webhooks carry identifiers, codes, amounts and dates only; names, contact details,
  identity numbers and document contents are never included (`automation/webhook.ts`).
- Nothing technical prevents a centre from using data it holds for another purpose (for example exporting a
  customer list from a report). Purpose limitation beyond the gates above is an organisational control.
- The platform console's cross-centre figures are counts and amounts, not customer records.

### 3.4 Data minimisation

| Measure | Where |
| --- | --- |
| Identity numbers are shown as the last four characters; the full number needs the permission `customer.sensitive.read` and every reveal is audited | customers module |
| The audit trail records that a field changed, not the identity number or the form values | customers, requests modules |
| The public tracking page shows status and timeline only: no name, document, amount or staff | requests module |
| The waiting-room display shows token numbers and counters only | queue module |
| Document download links expire after 120 seconds by default; share links after at most 7 days and 20 downloads | documents module |
| Platform support sees a centre's data only within the scopes of an approved grant, read-only, with every call written to the centre's audit trail | platform module, `common/auth/support-session.ts` |
| The logs contain no request bodies; known sensitive field names are redacted | `common/logger.ts` |
| The seed and tests use invented people and specimen documents only | section 8 |

Not provided: the system does not limit which fields a centre asks for. A centre can build a form that
collects any personal data, including identity numbers typed into ordinary form fields, which are then
stored unencrypted. Collecting only what a service needs is the centre's decision.

### 3.5 Accuracy

- Customers can correct their own name, Arabic name, language, address and communication preferences in the
  portal. Email, phone and identity numbers are changed by staff.
- OCR results are suggestions: a person reviews them before anything is copied to the profile, and identity
  numbers found by OCR are stored encrypted until then.
- Document expiry dates are marked as verified only when a person confirmed them against the document.
- Duplicate customer records can be merged, with an audit trail.

### 3.6 Data-subject requests

Workflow (`data_subject_requests`): `RECEIVED` to `IN_REVIEW` to `APPROVED` or `REJECTED`, then
`COMPLETED`. A customer files a request in the portal for their own record; staff can record a request that
arrived another way. One open request per type. The default due date is 30 days after filing; staff can set
another. That period is a default chosen by the developers, not a statement of a legal deadline. Overdue
requests are flagged on the Privacy screen. Every step is audited and every decision needs a written note.

| Right | What the system does | What it does not do |
| --- | --- | --- |
| Access, and export in a machine-readable form | Builds one JSON file: profile (identity numbers decrypted for this file), contacts, consents and their history, service requests with submitted form data, metadata of documents the customer may see, issued invoices, payments. Stored as a document the customer can download; deleted after 30 days by the default retention policy | Not in the file: quotations, appointments, support tickets and messages, notifications sent, reminders, comments, feedback, internal notes, documents hidden from the customer (only their number is stated), file contents. No transfer to another provider |
| Correction | Workflow and audit trail. Staff correct the record in the customer screens and complete the request with a note | No automatic change; no check of evidence |
| Deletion | Erasure by anonymisation, described below | Refused while the person has open service requests or unpaid invoices. Financial records are kept |
| Withdrawal of consent | Per purpose, by the customer or by staff, with history | - |
| Restriction of processing, objection | Not implemented as such. A customer record can be archived by staff; a document can be put under legal hold | No "restricted" state that stops processing while a dispute is examined |
| Objection to automated decisions | The system makes no decision about a person automatically: OCR output is reviewed by staff, automatic assignment chooses a member of staff, automations cannot approve, reject or complete a request | - |
| Identity verification of the requester | A portal request comes from the signed-in customer. For requests recorded by staff, verification is the centre's procedure | Nothing automated |

**Erasure as coded.** The detail is in [api/modules/privacy.md](api/modules/privacy.md) ("What an erasure
does") and [api/modules/customers.md](api/modules/customers.md) ("Erased customers"); it is exercised by
`services/api/src/modules/privacy/privacy.spec.ts` and by scenario 29 of the acceptance suite
(`tests/integration/08-privacy-and-retention.spec.ts`: after the erasure the person's values are gone from the
record, the cases, the documents, the messages and the trails, while invoice, payment, receipt and report
figures are identical before and after; the address can register again). Results: [TEST_REPORT.md](TEST_REPORT.md).

1. *Check.* If the person (including records merged into theirs) has an open service request or an issued
   invoice with a balance due, nothing is changed: the request stays approved, the reason is stored where the
   customer can read it, and the call answers `409 ERASURE_BLOCKED`.
2. *Trails.* In the centre's append-only records (audit trail, security events, request status history,
   consent history, document access log) the entries stay, but the person's values are removed from them:
   names, contact details and identity numbers in summaries and before / after values, free-text reasons and
   customer messages in the status history, IP addresses and user agents of the person's own actions. The
   same is done for stored event payloads, stored idempotent responses, automation results and integration
   logs. This uses the database's controlled purge switch on the system connection.
3. *Each module's data* (a registry of steps, `common/erasure.ts`):

   | Module | Removed or blanked | Kept |
   | --- | --- | --- |
   | Customers | Profile fields, identity numbers, contacts, notes, tags, on the record and on records merged into it. Status becomes `ANONYMISED`; the row is a stub named "Erased customer" with `erased: true` and `erasedAt`; every change to it, and anything that would attach a new record to it, answers `409 CUSTOMER_ERASED`; lists and searches leave it out unless `status=ANONYMISED` is asked for; every other record that embeds the customer carries `erased: true` | The row, as an anonymous reference for the records below; consent rows (purpose, status, dates) |
   | Requests | Submitted form data, instructions, comments, free-text reasons, the public tracking code | Request number, service, status, dates, who worked on it |
   | Documents | Documents of the person and of their requests are deleted with no restore window; titles, file names and share recipients are blanked at once; share links revoked | Documents under legal hold, with a later retention date, or used by somebody else's open request |
   | OCR | Everything extracted from the person's documents | - |
   | Finance | Notes; the person's identifiers inside refund and credit-note reasons | Quotations, invoices, credit notes, payments, refunds and the liability ledger, unchanged, linked to the anonymous record |
   | Notifications | Subject, text, recipient address, provider error texts; preferences and registered devices | The fact that a message of a given kind was sent, when and with what result |
   | Reminders | Reminder schedules and their send log | - |
   | Appointments | Notes and reasons; upcoming appointments are cancelled | Past appointments as calendar history |
   | Support | Ticket subject, all messages, attachments, resolution summary, feedback comment; open tickets are closed | Ticket number, dates, rating |
   | Tasks | Free text of tasks about the person or their requests | The task rows |
   | Corporate | Staff number and job title on the employment record, which is switched off | The row |
   | Privacy | The free-text details of the person's privacy requests | The requests themselves |

4. *Portal access.* The memberships that linked a login to the person at this centre are removed, and the
   sessions and one-time tokens for this centre are deleted.
5. *Login account.* If the account is used for nothing else (no other centre, no staff or platform role) it
   is anonymised and disabled: reserved undeliverable address, no phone, no password, no MFA secret, sign-in
   history blanked. If it is used elsewhere it is kept and only the access to this centre is removed.
6. *Files.* A job removes the files of the deleted documents straight away and retries the closing of the
   logins if it failed.
7. *Record.* The audit entry of the erasure contains counts only. The privacy request records in plain words
   what was retained and why.

What an erasure does not reach:

- **Backups.** Data erased from the live database remains in earlier backups until they expire. There is no
  per-person or per-centre removal from backups.
- **Logs** outside the database (application and proxy logs), which contain user ids and IP addresses, not
  names or documents.
- **Copies outside TypEase**: emails and messages already delivered, files a member of staff downloaded,
  data sent to an external OCR service, payment gateway records, whatever a webhook receiver stored.
- **Free text about the person in other people's records.** Trail entries are matched by the person's own
  record ids, never by name alone, so that another customer's history cannot be damaged. A note on another
  customer's record that happens to mention the person is not found.
- **Company-level data.** A company's documents and requests that are not filed under the person.
- **Staff members.** There is no erasure flow for a centre's own staff or for platform staff.

### 3.7 Retention

- Policies per entity (`data_retention_policies`): `DOCUMENT`, `CUSTOMER`, `NOTIFICATION`,
  `SUPPORT_TICKET`, with a number of days, an action (`DELETE` or `ANONYMISE`) and a free-text legal-basis
  note.
- **Only document deletion is enforced automatically** (daily job `documents.purge`): a document is deleted
  the configured number of days after its request was completed or cancelled, or after upload when it has no
  request. A policy for one document type overrides the general one. Policies for customers, notifications
  and support tickets are stored and shown as "not enforced"; no job applies them.
- Starting values for a new centre: documents 1825 days; personal data exports 30 days; customers 2555 days
  (inactive); notifications 365 days (inactive); support tickets 730 days (inactive). **These numbers were
  chosen by the developers as placeholders. They are not derived from any legal requirement.**
- Deleted documents can be restored for 30 days, then the files are removed.
- Legal hold on a document (`privacy.manage`) and a fixed `retentionUntil` date block deletion and purging.
- No retention rule exists for: audit and security logs (kept until the centre is purged), requests,
  financial records (immutable; never deleted), appointments, consent history, application logs.
- When the platform offboards a centre, its data is removed after a grace period by a controlled purge; see
  [api/modules/platform.md](api/modules/platform.md).

### 3.8 Security of processing

Covered item by item in [SECURITY_CHECKLIST.md](SECURITY_CHECKLIST.md). The points an adviser usually asks
about first:

- Identity numbers on the customer record, OCR results, MFA secrets and provider credentials are encrypted
  at field level; other personal data is not. Files are encrypted by the application (local driver) or by
  the object store on request (S3 driver).
- Data-key rotation exists (`DATA_ENCRYPTION_KEY_ID`, `DATA_ENCRYPTION_OLD_KEYS` and the `reencrypt`
  command; [deployment/secrets.md](deployment/secrets.md), section 5) and is covered by its tests; it has never
  been run on a production-sized data set. `HMAC_KEY` (blind indexes, signed links) cannot be rotated.
- Malware scanning of uploads is optional and off by default.
- Access is by role and scope, enforced on the server and again by database row-level security.
- Every access to a document is logged; every reveal of an identity number is logged.
- No independent assessment of any of this has been made.

### 3.9 Breach handling

- **Incident register** per centre (and one for the platform): title, description, severity, affected data,
  whether personal data is involved, whether notification is required, when the authority and the individuals
  were notified, resolution notes. Workflow `OPEN`, `INVESTIGATING`, `CONTAINED`, `RESOLVED`.
- An incident involving personal data cannot be closed without a recorded decision on notification, and, if
  notification is required, without the date the authority was notified.
- Supporting evidence: the append-only audit trail, security events (failed sign-ins, token reuse, malware,
  invalid webhook signatures, support access), the document access log.

What the system does **not** do: detect a breach, alert anybody about security events, decide whether or
when notification is required, notify an authority or an individual, produce a notification text, or track a
deadline. The register records what people did. The procedure, the contact points and the time limits are
the operator's and the centre's to define with their advisers.

### 3.10 Cross-border processing and data residency

Where data is stored and processed is decided entirely by the operator's deployment. The software has no
region lock and no check of where a server or provider is located.

| Data flow | Decided by | Notes |
| --- | --- | --- |
| Database, Redis, file store, backups | Operator | The example configuration names the object-store region `me-central-1`; that is a default string, not a guarantee of where anything runs |
| Email (SMTP relay) | Operator, or the centre's own SMTP connection | Message text and recipient address leave the system |
| SMS, WhatsApp, push | Operator or centre | Phone numbers, device tokens and message text go to the provider |
| Online payments | Centre (its gateway account) | Amount, invoice reference and the customer's email go to the gateway; card data is entered at the gateway |
| External OCR (`OCR_PROVIDER=external-http`) | Operator | **The whole document image** is sent to the configured URL. Off by default; the bundled `tesseract` provider runs locally |
| Automation webhooks, n8n | Centre and operator | Identifiers, codes, amounts and dates only |
| Monitoring and log shipping | Operator | Logs contain user ids, tenant ids and IP addresses |
| Support by the operator's staff | Operator | Read access under a grant, from wherever those staff are |

The **processor register** (section 3.11) has a country and a cross-border flag per vendor and refuses to
approve a cross-border vendor without recorded safeguards. It is a record: it does not block a connection
that has no entry.

### 3.11 Processors and vendors

- Register per centre and for the platform (`processor_records`): name, purpose, data categories, country,
  cross-border flag, safeguards, review status. A material change puts an entry back to "pending review".
- The register is not connected to the integrations screen: connecting a provider does not create or
  require an entry.
- No contract templates, data-processing agreements or sub-processor lists are part of the software.
- The third-party services the code can talk to: Stripe, Twilio, an HTTP SMS gateway, Meta WhatsApp Cloud
  API, Firebase Cloud Messaging, an SMTP relay, S3-compatible storage, ClamAV, an external OCR endpoint,
  n8n. None is contacted unless configured, and **none has been exercised against the real service**.

### 3.12 Governance items with no tooling

No part of the software produces or maintains: a record of processing activities, a data-protection impact
assessment, the appointment or contact details of a data-protection officer, staff training records,
data-processing agreements, or a policy library. If any of these is required, it is kept outside TypEase.

## 4. VAT

Module: `services/api/src/modules/finance`. Reference: [api/modules/finance.md](api/modules/finance.md).

What the system does:

| Item | Behaviour |
| --- | --- |
| Tax rate | One rate per centre (`tenants.taxRatePercent`, default 5). A line can carry an explicit rate |
| What is taxed | Per service (`taxMode`): the service fee only (default), every component, or nothing. Tax is computed per line, rounded half-up to two decimals, and summed |
| Fee components | Every line is a service fee, a government fee or a third-party fee. Government and third-party fees default to pass-through liabilities and are not reported as the centre's revenue. The owner can change the treatment; the screen says the treatment must be reviewed with an accountant |
| Tax registration number | The centre's TRN (`taxRegistrationNo`) is printed on quotations, invoices, receipts and credit notes when set |
| Invoice title | "Tax invoice" when the centre has a TRN, otherwise "Invoice" |
| Numbering | Invoice numbers come from a per-centre sequence taken at issue time, without gaps |
| Immutability | An issued invoice cannot be changed or deleted (API and database trigger). Corrections are credit notes; a void is possible only while nothing was paid or credited |
| Credit notes | Numbered, linked to the invoice, with amount, tax amount and reason |
| Reports | "Tax invoiced" appears as a column in the daily-sales and monthly-revenue reports |
| Currency | One currency per centre (default AED). No multi-currency invoices, no exchange rates |

What a tax invoice PDF contains: the centre's name, legal name, phone and email, TRN, the document title and
number, issue date, due date, status, request and quotation numbers, branch, the customer's name and customer
number (for a company: company name and account number), lines grouped by fee component with quantity, unit
amount, discount, tax amount and rate, line total, then subtotals, discount, tax, total, paid and balance,
and the centre's footer text.

What it does **not** contain or do:

- **The centre's address** is not printed. **The customer's address and the customer's TRN** are not printed
  (a company's TRN is stored on the corporate account but not used on documents).
- **Arabic.** PDFs are English only; characters outside Latin-1, including Arabic names, print as `?`.
- No distinction between a full and a simplified tax invoice, no "tax credit note" wording, no statement of
  the tax amount in AED when another currency is used (there is no other currency).
- No reverse-charge, zero-rated, exempt or out-of-scope classification beyond a rate of 0 on a line.
- No handling of the tax point for deposits and advance payments: a deposit is a part-payment of an invoice
  already issued for the full amount.
- **No VAT return, no export for filing, no connection to the Federal Tax Authority, and no e-invoicing**
  (no structured electronic invoice format, no exchange through a service provider).
- No check that a TRN is well formed or valid.
- No retention rule for financial records: they are simply never deleted.
- Subscription invoices from the operator to centres use a platform setting whose tax rate defaults to 0;
  the operator's own VAT position is outside this document.

Whether treating government fees as pass-through disbursements is correct for a given centre, and whether
the PDF meets the content requirements for a tax invoice, are questions for a tax adviser. The missing
address and customer TRN in particular should be put to them before invoices are issued to businesses.

## 5. Electronic payments

| Item | Behaviour |
| --- | --- |
| Card data | **Never entered into, sent through or stored by TypEase.** Online payment opens the gateway's hosted checkout page; TypEase receives a signed notification with amount, currency and the gateway's references |
| Manual payments | Staff record method (cash, card terminal, bank transfer, cheque), amount and a free-text reference. A reference or note that looks like a card number (13 to 19 digits passing the Luhn check) is rejected |
| Gateway credentials | Stored per centre, encrypted, write-only |
| Webhooks | Signature verified over the raw body with that centre's secret; each event processed once; amount and currency must match |
| Refunds | Requested and approved by two different people; through the gateway for online payments, recorded by hand otherwise |
| Money flow | From the customer to the centre's own gateway or bank account. TypEase does not hold, pool or transfer customers' money |
| Gateways | A sandbox test adapter (never in production) and a Stripe adapter that has **not** been run against Stripe |

Not assessed here: the centre's and the operator's obligations under card-scheme rules (PCI DSS) as agreed
with their acquirer, licensing questions around payment services, which gateways are available to a UAE
business, and the terms of any gateway. The statement that card data does not touch TypEase describes the
code; the scope of any card-security assessment is determined with the acquirer.

## 6. Government services

Specification section 31 requires that the system supports government-related assistance without presenting
itself as an authorised government platform. What the code does is described in full in
[WORKFLOW_DOCUMENTATION.md](WORKFLOW_DOCUMENTATION.md), section 13. In summary:

| Requirement of section 31 | What the code does |
| --- | --- |
| Manual processing: staff use the official portal separately and record reference and status | Implemented as the `MANUAL_PORTAL` channel. TypEase stores the reference and what staff typed |
| Partner processing: record partner identity and reference | Implemented as the `AUTHORISED_PARTNER` channel; the partner's name is mandatory |
| Official API integration, if available and authorised | **Not implemented.** The channel `OFFICIAL_API` and an abstract adapter interface exist; no adapter exists, so the channel always answers `OFFICIAL_INTEGRATION_NOT_AVAILABLE` |
| Never: CAPTCHA bypass, OTP interception, unauthorised portal automation, credential sharing, scraping | None of these exists in the code. Authorisation records refuse to store credentials or text that looks like a password, PIN or OTP |
| Never: fake approvals or fabricated statuses | A status typed by staff is always stored and shown with the source "Entered by staff (not verified by the authority)". Clients cannot set the source |
| Label every status by source | Four labels: internal, staff-entered, partner-provided, verified official. The last one cannot occur without an adapter |
| A centre may submit only what it is authorised for | A service can be marked as submitted by the centre only when the centre has an authorisation record that a TypEase administrator verified. Otherwise the service is "document preparation only" and no submission can be recorded |

Limits to state plainly:

- "Verified" means a platform administrator looked at the evidence a centre supplied and recorded a
  decision. **The software does not and cannot check an authorisation with any authority.** The operator
  needs a procedure for that review and bears the consequences of getting it wrong.
- Nothing stops a member of staff from typing a false status. The label says where it came from; it does not
  make it true.
- Service categories and the starter catalogue are business groupings. They are not a claim that a centre is
  licensed for those services.
- Any real integration with an authority requires that authority's documented API access and authorisation.
  None has been sought or obtained for this software.
- Expiry reminders say a document "expires on <date> according to our records" and make no statement about
  legal deadlines or penalties.

## 7. Arabic support

| Area | English | Arabic |
| --- | --- | --- |
| Staff app, customer portal, corporate portal, platform console: interface text | Yes | Yes, with right-to-left layout. Both dictionaries must have the same keys (a test checks it) |
| Mobile app | Written with both languages | Never compiled, so not observed |
| Status labels and customer-facing status wording | Yes | Yes (`REQUEST_STATUS_META`) |
| Names of services, categories, document types, branches, workflow steps, form labels | Yes | Optional Arabic field entered by the centre |
| Customer name | Yes | Optional Arabic name field |
| Notification templates (email, SMS, WhatsApp, push, in-app) | Yes | Yes; Arabic emails are laid out right to left. A centre's own overrides are per language |
| Privacy policy and terms template | Yes | Yes (unreviewed template) |
| **API error and validation messages** | Yes | **No.** The API answers in English only; the web apps translate known error codes where they have a translation and otherwise show the English message |
| **PDF quotations, invoices, receipts, credit notes, request summaries** | Yes | **No.** English and Latin-1 only; Arabic text prints as `?` |
| Report exports (CSV, Excel, PDF) | Yes | Column headings are English |
| OCR | Machine-readable zone and Latin text | No Arabic recognition |
| Search | Yes | Arabic names can be searched as stored; no normalisation of Arabic letter variants |
| Dates and numbers | Gregorian calendar, Western digits | Same; no Hijri calendar |

Whether invoices or other documents must be available in Arabic for a given centre is a question for the
advisers. As built, the system cannot produce them.

## 8. Demo and test data

- The seed (`pnpm db:seed`) creates three fictional centres with invented people, companies, numbers and
  documents. Addresses use reserved domains such as `.test`, and the conventions that make the data
  recognisable as fictional are described in [DEMO_ENVIRONMENT.md](DEMO_ENVIRONMENT.md).
- Tests and fixtures use specimen and invented identity data only. No real passport or Emirates ID data is
  in the repository.
- The seed must never be run against a production database; the readiness script looks for demo accounts.
- Real customer documents must not be loaded into development or test environments.

## 9. Records the operator must keep

The software does not keep these for you. Which of them are legally required, and for how long, is for the
advisers to confirm.

**Operator of the platform**

- The legal review of this document and the decisions taken on each question in section 10.
- Hosting: where the database, file store, backups and logs are, under which contracts.
- The list of platform-level providers and their agreements; the platform's processor register kept current.
- Key management: who holds `DATA_ENCRYPTION_KEY` and `HMAC_KEY`, where the copies are, when they were
  generated.
- Backup schedule, off-site copies, restore drills and their results.
- The procedure and the evidence for verifying centres' authorisation records, per decision.
- Platform administrator and support accounts: who has them, with MFA; reviews of support access grants.
- Security reviews, penetration tests, dependency audits and what was done about their findings.
- The incident response procedure and the platform incident register.
- The agreements with each centre (terms of service, data-processing terms).

**Each typing centre**

- Its trade licence and every authorisation or partner agreement it relies on, with validity dates.
- Its privacy notice and terms as reviewed, with their versions and dates of publication.
- Its retention decisions with reasons, entered as policies; its handling of records the system does not
  delete automatically.
- Privacy requests received, including those not made through the portal, with identity checks and outcomes.
- The centre's incident register and notification decisions.
- Its vendor register, including its own payment gateway, SMTP, SMS and WhatsApp accounts.
- Staff roles and who holds `customer.sensitive.read`, `privacy.manage` and `support_access.decide`;
  periodic access reviews.
- Financial records: invoices, credit notes, receipts, expenses, the liability ledger for fees collected on
  behalf of authorities, and reconciliations. Export them regularly; do not rely on the application as the
  only copy.
- Evidence of consent given outside the portal (at the counter, by phone), recorded by staff.

## 10. Questions for the advisers

**Data protection**

1. What is the legal role of the operator and of each centre, and what agreements follow from it?
2. Which lawful basis applies to each purpose? In particular: is "contract" sufficient for staff-initiated
   OCR when no consent decision is recorded, and for reminders to company contacts?
3. Is the template privacy notice acceptable once completed, and how must changes be communicated, given
   that the system records no notice version for online consents?
4. What applies to documents of minors and dependants, and to any category of data that needs special care?
5. Is the export file sufficient as a response to an access request, given what it leaves out?
6. Is erasure by anonymisation, with financial records retained and linked to an anonymous record,
   acceptable? What about backups and delivered messages?
7. Which retention period applies to each kind of record: identity documents, requests, financial records,
   audit logs, consent history, support tickets, notifications?
8. Is a "restriction of processing" state required?
9. When must a personal-data breach be notified, to whom, in what form and within what time?
10. Where may the data be hosted, and which transfers (messaging providers, payment gateway, external OCR,
    monitoring, remote support) need which safeguards?
11. Is a data-protection officer, an impact assessment or a record of processing activities required?
12. Do free-zone rules or sector rules apply to the operator or to particular centres?

**Tax and finance**

13. Does the invoice PDF meet the content requirements for a tax invoice, given that the supplier's address,
    the customer's address and the customer's TRN are missing and that it is English only?
14. Is the pass-through treatment of government and third-party fees correct, and what evidence is needed?
15. How must deposits and advance payments be invoiced?
16. Which e-invoicing obligations apply and from when?
17. What is the operator's own VAT position on subscription invoices?
18. For how long must financial records be kept, and in what form?

**Payments**

19. Which card-security obligations apply to the operator and to centres with a hosted checkout?
20. Do any payment-services rules apply to the way refunds and pass-through fees are handled?

**Government services**

21. What authorisation does a centre need for each kind of service, and what evidence must the operator
    check before marking a centre's authorisation as verified?
22. What wording must customers see so that the centre and the platform are not mistaken for an authority?
23. What are the conditions for any future official integration?

## 11. Summary of what is missing

- Legal, tax and security review: none has taken place.
- Editable, versioned privacy notice per centre; record of the notice version shown online.
- Opt-in consent for OCR; consent records for corporate employees and guests.
- Enforcement of retention for anything except documents; retention of logs.
- A "restricted" processing state.
- Breach detection, alerting and notification.
- Any technical control over where data is hosted or which vendor receives it.
- Rotation of `HMAC_KEY`; field-level encryption beyond identity numbers.
- Supplier address, customer address and customer TRN on invoices; Arabic PDFs.
- VAT returns, e-invoicing, any connection to the tax authority.
- Any official integration with any authority.
- Arabic API messages; Arabic OCR.
- Removal of an erased person from backups.

See also [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) and [SECURITY_CHECKLIST.md](SECURITY_CHECKLIST.md).
