# Privacy (data subject requests, retention, consent overview, incident and vendor registers)

Source: `services/api/src/modules/privacy`. Request shapes: `packages/validation/src/privacy.ts`.
All paths are below `/api/v1`.

> **These are technical controls, not legal compliance.** The module gives a centre the tools to run a privacy
> process (record and answer requests, set retention periods, keep registers). It does not decide what the law
> requires, and using it does not make a centre compliant with the UAE Personal Data Protection Law or any
> other rule. Periods, lawful bases, notification duties and the handling of each request must be reviewed by
> qualified UAE advisers. Section 8 lists what to put in front of them.

## 1. Endpoints

### Customer self-service (`self.privacy`)

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| POST | `/privacy/my/requests` | `{ type: "ACCESS" \| "CORRECTION" \| "DELETION" \| "EXPORT", details? }` | `201` request |
| GET | `/privacy/my/requests` | - | my requests (newest first) |
| GET | `/privacy/my/requests/:id` | - | one of my requests |

The request is always filed for the caller's own customer record; ids in the body are ignored. One open
request per type (`409 REQUEST_ALREADY_OPEN`).

```json
{ "id": "…", "customerId": "…", "type": "EXPORT", "status": "RECEIVED", "details": null,
  "decisionNote": null, "retentionException": null, "exportDocumentId": null,
  "dueAt": "2026-11-08T09:00:00.000Z", "overdue": false, "completedAt": null, "createdAt": "…", "updatedAt": "…" }
```

### Centre privacy officer (`privacy.manage`; held by the owner role by default)

| Method | Path | Body / query | Returns / notes |
| --- | --- | --- | --- |
| GET | `/privacy/overview` | - | dashboard numbers (section 6) |
| GET | `/privacy/requests` | `page, pageSize, sort (createdAt, dueAt, updatedAt), status, type, customerId, overdue=true` | page of requests with `customer { id, customerNo, fullName, status }` |
| POST | `/privacy/requests` | `{ customerId, type, details?, dueAt? (YYYY-MM-DD) }` | records a request received at the counter / by phone |
| GET | `/privacy/requests/:id` | - | request; open deletion requests include `erasureImpact` |
| POST | `/privacy/requests/:id/review` | - | `RECEIVED -> IN_REVIEW` |
| POST | `/privacy/requests/:id/decision` | `{ decision: "APPROVED" \| "REJECTED", decisionNote (5+ chars) }` | decides a `RECEIVED` / `IN_REVIEW` request |
| POST | `/privacy/requests/:id/complete` | `{ note? }` | carries out an `APPROVED` request (section 2) |
| GET | `/privacy/retention-policies` | - | policies with `enforced` flag |
| POST | `/privacy/retention-policies` | `{ entity, documentTypeKey?, retainDays (1..36500), action?, legalBasisNote?, isActive? }` | `409 POLICY_EXISTS` for a second policy on the same entity / type |
| PATCH | `/privacy/retention-policies/:id` | any of `retainDays, action, legalBasisNote, isActive` | |
| DELETE | `/privacy/retention-policies/:id` | - | |
| GET | `/privacy/consents` | `page, pageSize, purpose, status, customerId` | page of current consents + `statistics[]` per purpose |
| GET | `/privacy/consents/customers/:customerId/history` | - | append-only consent history of one customer of this centre (any status, erased included). An unknown id or a customer of another centre answers `404`, never an empty list; a customer without any decision answers `200 []` |
| GET | `/privacy/incidents` | `page, pageSize, sort (detectedAt, createdAt, updatedAt), status, severity` | the centre's incident register |
| POST | `/privacy/incidents` | `{ title, description, severity?, affectedData?, personalDataInvolved?, notificationRequired?, detectedAt? }` | new incident, status `OPEN` |
| GET | `/privacy/incidents/:id` | - | |
| PATCH | `/privacy/incidents/:id` | any incident field, plus `authorityNotifiedAt`, `individualsNotifiedAt` (ISO date-time or null), `resolutionNotes` | |
| POST | `/privacy/incidents/:id/status` | `{ status, resolutionNotes? }` | workflow step (section 4) |
| GET | `/privacy/processors` | `page, pageSize, status, crossBorder` | the centre's vendor register |
| POST | `/privacy/processors` | `{ name, purpose, dataCategories[], country, crossBorder?, safeguards? }` | status `PENDING_REVIEW` |
| PATCH | `/privacy/processors/:id` | any of the above | a material change re-opens the review |
| POST | `/privacy/processors/:id/review` | `{ decision: "APPROVED" \| "REJECTED", safeguards? }` | cross-border processing review |
| DELETE | `/privacy/processors/:id` | - | |

Also relevant, documented in `documents.md`: `PUT /documents/:id/legal-hold` and `GET /documents/:id/access-logs`.

### Platform staff (platform-level registers: rows without a tenant)

| Method | Path | Platform permission |
| --- | --- | --- |
| GET | `/platform/privacy/incidents`, `/platform/privacy/incidents/:id`, `/platform/privacy/processors` | `platform.audit.read` |
| POST / PATCH | `/platform/privacy/incidents`, `/platform/privacy/incidents/:id`, POST `/platform/privacy/incidents/:id/status` | `platform.tenants.manage` |
| POST / PATCH / DELETE | `/platform/privacy/processors`, `/platform/privacy/processors/:id`, POST `/platform/privacy/processors/:id/review` | `platform.integrations.manage` |

Platform staff see and change **only** platform-level rows; a centre's own incident and vendor registers are
not visible to them, and centres never see platform rows. There is no dedicated platform permission for
maintaining these registers yet, which is why the two existing "manage" permissions are used for writes.

Endpoint count: 36 (3 self-service, 23 privacy officer, 10 platform).

## 2. Data subject requests

```
RECEIVED ──review──> IN_REVIEW ──decision──> APPROVED ──complete──> COMPLETED
    └──────────────decision───────────────> REJECTED
```

- Due date: 30 days after filing unless staff set another date. `overdue` is true for an open request past its
  due date; `GET /privacy/requests?overdue=true` lists them.
- A decision always carries a written note. Every step is written to the audit trail
  (`privacy.request_received`, `_in_review`, `_approved`, `_rejected`, `_completed`, `privacy.erasure_blocked`,
  `privacy.export_generated`, `privacy.customer_anonymised`, `privacy.login_anonymised`; documents:
  `document.erased`).
- Completing a `COMPLETED` request again changes nothing.

What `complete` does:

| Type | Action |
| --- | --- |
| `ACCESS`, `EXPORT` | Builds one JSON file with the customer's profile (identity numbers **decrypted for this file only**), contacts, current consents and consent history, service requests with the submitted form data, metadata of their documents (no file contents), issued invoices and payments. The file is stored in the vault as a document of type `data_export`, visible to the customer; its id is returned as `exportDocumentId`. The customer downloads it through `POST /documents/:id/download-link`. Not included: internal staff notes and documents hidden from the customer (their number is stated in the file) |
| `CORRECTION` | Nothing automatic: staff correct the record in the customer module and complete the request with a `note` describing what was changed (`422 NOTE_REQUIRED` without it) |
| `DELETION` | Erasure across all modules, see below |

The export file contains identity numbers in clear text inside an encrypted, access-logged document. The
default retention policy deletes `data_export` documents 30 days after they were created.

### Erasure

`GET /privacy/requests/:id` shows the impact first:

```json
"erasureImpact": { "openRequests": 1, "unpaidInvoices": 1, "closedRequests": 1, "invoices": 2,
                   "payments": 1, "documents": 2, "heldDocuments": 1, "canProceed": false }
```

All figures cover the customer record of the request **and every record that was merged into it**: they are
the same person.

**One rule decides whether an erasure may go ahead:** it is refused while the person has open service requests
(any status except COMPLETED / CANCELLED) or issued invoices with a balance due. The answer is
`409 ERASURE_BLOCKED`; the message names them and `details` lists them:

```json
{ "code": "ERASURE_BLOCKED",
  "message": "The data cannot be deleted yet: 1 service request(s) are still open (TE-000123) and 1 invoice(s) are unpaid (INV-000045). Close or cancel the requests and settle or void the invoices, then complete this request again.",
  "details": { "openRequests": 1, "unpaidInvoices": 1, "closedRequests": 1, "invoices": 2, "payments": 1, "documents": 2, "heldDocuments": 1, "canProceed": false,
               "blocking": { "requests": [{ "id": "…", "requestNo": "TE-000123", "status": "IN_PREPARATION" }],
                             "invoices": [{ "id": "…", "invoiceNo": "INV-000045", "balanceDue": "80.00", "currency": "AED" }] } } }
```

A blocked erasure changes nothing. The request stays `APPROVED`, the reason is stored in `retentionException`
(the customer can read it), and `complete` can be called again once the obstacles are gone.

#### What an erasure does

It runs in one tenant transaction. Every module removes or anonymises **its own** data through a step it
registers with `ErasureRegistry` (`common/erasure.ts`) in `onModuleInit` - the same pattern as tenant
provisioning steps. A failing step fails the whole erasure (nothing is half-erased). The steps receive the
`ErasureSubject`: the ids of the person's records, logins, requests and of everything that belongs to them, and
what the person was known by (names, email addresses, phone numbers, decrypted identity numbers) so that copies
in free text can be found. Registered steps:

| Step (module) | Removed or anonymised | Kept |
| --- | --- | --- |
| `customers` | The record becomes `ANONYMISED`: name "Erased customer", Arabic name, email, phone, nationality, date of birth, address blanked; Emirates ID and passport columns (ciphertext, blind index, last four, expiry, country) null; marketing and channel preferences off. **Records merged into it** lose the same fields (they keep status `MERGED`). Contacts, notes and tag assignments are deleted | The row, its id and `customerNo` (a pseudonym that the kept records point at); consent rows (purpose, status, dates) |
| `corporate` | The employee record: `INACTIVE`, `employeeNo` and `designation` null | The row (links the company's past requests to an anonymous person) |
| `requests` | Submitted form data (`request_fields`, deleted), `customerInstructions`, the public tracking code, every comment (text replaced by `[erased]`, author name removed), notes on external references, checklist rejection reasons, assignment reasons, approval comments; the person's identifiers are taken out of cancellation reasons, external status texts and workflow step results | The request itself: number, service, status, dates, assignments, external reference numbers |
| `tasks` | Description of tasks about the person or their requests; the person's identifiers in the title | The task |
| `documents` | Documents of the person and of their requests: deleted with no restore window (`purgeAfter = now`), title "Erased document", file name `erased`, share links revoked and their recipient removed, verification notes blanked. Earlier deletions still inside their 30-day window are released for purging | Documents that may not be deleted (below) |
| `ocr` | Every extraction (extracted and reviewed values) of the person's documents, including those of a kept document | - |
| `notifications` | Messages addressed to the person (by customer record, email address or phone number): subject, text, rendered payload, address and provider error texts removed; their notification preferences and registered devices deleted. Staff notifications **about** the person or their requests lose the person's identifiers | The rows as delivery statistics (event, channel, status, time) |
| `reminders` | Expiry reminder schedules and their send log (deleted) | - |
| `appointments` | Notes, cancellation reasons, guest fields; appointments that have not taken place are cancelled | Past appointments as calendar history |
| `support` | Tickets of the person: subject "Erased ticket", every message `[erased]`, attachments and resolution summary removed, open tickets closed; feedback comments | Ticket rows (number, dates, SLA times), feedback ratings |
| `finance` | Free-text notes on quotations, invoices and payments; the person's identifiers in refund and credit-note reasons | **Everything else, unchanged**: quotations, invoices and their lines, credit notes, payments, refunds, the liability ledger - numbers, amounts, dates, statuses, references |
| `privacy` | `details` of the person's privacy requests; the person's identifiers in decision notes | The requests (type, status, dates, decision) |

Then, by the privacy module itself:

- **Portal access.** The memberships that linked a login to the person (customer portal, corporate employee
  login) are removed; sessions and one-time tokens for this centre are deleted. Existing tokens stop working
  at once.
- **The login account** (`users` row, platform-wide). If the account is used for nothing else - no membership
  of another centre, no staff or corporate role, no platform role (`REMOVED` memberships do not count) - it is
  anonymised and disabled: name "Erased user", email replaced by `erased-<userId>@erased.invalid`, phone,
  password hash, MFA secret and recovery codes removed, status `DISABLED`, all sessions and tokens deleted, the
  address and network data removed from its sign-in history and security events. The address is then free to
  register again as a new account. **If the account is used elsewhere it is not touched**; `retentionException`
  says so, and the person keeps signing in to the other centre or role. Audited as `privacy.login_anonymised`
  (no personal values).
- **Trails that are append-only** (audit trail, security events, request status history, consent history,
  document access log) are kept - no entry is removed - but the person's values are taken out of them:
  values under personal keys (`fullName`, `email`, `phone`, `address`, identity numbers, contact values ...)
  and every occurrence of the person's known identifiers become `[erased]`; status-history reasons and
  customer messages of the person's requests become `[erased]`; IP address and user agent recorded with the
  person's own actions are removed. Only entries that are linked to the person **by id** are touched (the
  resource is theirs, an id of theirs is named in the entry, or their account made it) - never because a name
  or number happens to match, so another customer's trail cannot be damaged. The same is done for the outbox,
  stored idempotent responses, automation run results, the integration log and the sign-in history of the
  centre. This part runs on the system connection with the database's purge switch
  (`privacy/erasure-system.service.ts`); the tenant connection cannot update these tables.
- **Files.** A job (`privacy.erasure_finalise`) runs right after the transaction and removes the files of the
  deleted documents from storage; it also retries closing the logins.

**Kept, and stated in `retentionException`:** issued invoices and payment records (with credit notes, refunds
and the liability ledger) - unchanged and still linked to the, now anonymous, customer record; closed service
requests as business records without what the person told the centre; documents under legal hold, with a later
`retentionUntil`, or used by somebody else's open request; the login account when it is used elsewhere.
Financial totals and every report figure are the same before and after an erasure.

A kept document is deleted automatically (title, file name, file) by the next `documents.purge` run after its
legal hold is released or its retention date has passed - and at once when a member of staff deletes it by
hand after the hold was released: `DELETE /documents/:id` on a document of an erased customer has no restore
window (`purgeAfter` = now), blanks the title and file names in the same transaction and is audited as
`document.erased`; `POST /documents/:id/restore` answers `409 DOCUMENT_ERASED` (documents.md). Its OCR
extractions and share links are removed at the time of the erasure.

**What staff see afterwards.** The customer record stays reachable as a stub so that the kept invoices,
payments and requests still lead somewhere: `GET /customers/:id` answers `200` with `status: "ANONYMISED"`,
`erased: true`, `erasedAt`, the placeholder name and no personal field; every change or new attachment answers
`409 CUSTOMER_ERASED`; it is excluded from lists, search and pickers unless asked for with
`GET /customers?status=ANONYMISED`; and wherever it is embedded (invoice, payment, quotation, request, document
row, employee row, merge link) the reference carries `erased: true`. Customers and corporate users never see
it: the person's logins are gone and a company no longer sees the employee (customers.md "Erased customers",
corporate.md). A further privacy request for the record answers `409 CUSTOMER_ERASED`.

The audit entry `privacy.customer_anonymised` records what was done, in numbers only: per step, per trail,
how many logins were anonymised or kept. Completing a `COMPLETED` request again changes nothing.

#### Not covered

Read this before telling a customer that "everything is gone".

- **Issued financial documents keep their text.** Line descriptions of issued invoices and sent quotations are
  frozen by the database; if staff typed a person's name into a line description it stays. Payment references,
  gateway references and receipt numbers stay (reconciliation needs them). Only `notes` are removed.
- **A kept document is kept whole** until the reason ends: its file, title and file name can contain the
  person's name. The erasure does not weaken a legal hold.
- **Authority and partner reference numbers** recorded on a request (`request_external_references`) are kept:
  the authority can link them to a person, the centre no longer can.
- **Free text that is not linked by id.** Text about the person that staff typed into a record of *another*
  customer or request, and text in entries that only mention the person by a nickname or a detail that is not
  one of the known identifiers (current and merged names, email addresses and phone numbers of the profile,
  its contacts and its logins, Emirates ID and passport numbers), is not found. Names shorter than four
  characters are not searched for as text (they would hit unrelated words); they are still removed wherever
  they sit under a personal key.
- **Other roles of the same person.** An authorised company contact (`corporate_members`), a staff account or a
  guest booking without a customer record (`appointments.guestName`) is a different record and is not part of
  a customer's erasure.
- **Another centre.** An erasure is strictly per centre. The person's data at another centre, and a login
  account that is still used there, are not touched.
- **Outside the database.** Messages already delivered (the person's mailbox, SMS / WhatsApp providers), files
  already downloaded or shared, application logs, database and storage backups, and storage-level object
  versioning are outside the application.
- **Trail redaction is committed on its own.** It happens inside the erasure but on a second database
  connection. If the erasure fails after that point (a step throws, the database goes away), the trails of that
  person are already redacted while the rest is not; completing the request again finishes the job.
- **No schema change was made for this.** Two things would need one: (1) a durable, queryable record of an
  erasure per step (today it is the audit entry `privacy.customer_anonymised`) - e.g. a JSON column
  `data_subject_requests.erasureReport`; (2) removing a login account whose email column must stay unique and
  non-null without inventing a replacement address - e.g. making `users.email` nullable. Neither blocks the
  erasure.
- The retention policies for `CUSTOMER`, `NOTIFICATION` and `SUPPORT_TICKET` are still not applied
  automatically (section 3): data of customers who never ask for deletion is kept until staff act.

## 3. Retention policies

`entity`: `DOCUMENT`, `CUSTOMER`, `NOTIFICATION`, `SUPPORT_TICKET`. `action`: `DELETE` or `ANONYMISE`
(documents can only be deleted). A `DOCUMENT` policy may be limited to one `documentTypeKey`; the policy
without a type is the general one.

**What is enforced automatically today: only active `DOCUMENT` / `DELETE` policies**, by the daily
`documents.purge` job (see `documents.md`): `retainDays` after the document's request was completed or
cancelled, or after the upload date when it has no request. A type-specific policy takes precedence over the
general one. Documents under legal hold, with a later `retentionUntil`, or tied to an open request are skipped.
Policies for the other entities are stored (and returned with `enforced: false`) but no job applies them yet.

Every new centre starts with these values (tenant provisioning step `privacy.retention-defaults`; existing
policies are never overwritten):

| Entity | Type | Days | Action | Active |
| --- | --- | --- | --- | --- |
| DOCUMENT | (general) | 1825 | DELETE | yes |
| DOCUMENT | `data_export` | 30 | DELETE | yes |
| CUSTOMER | - | 2555 | ANONYMISE | no |
| NOTIFICATION | - | 365 | DELETE | no |
| SUPPORT_TICKET | - | 730 | DELETE | no |

They are starting points chosen by TypEase, not legal advice (each carries a note saying so). Note that files
generated by the platform (for example PDFs filed by the finance module) fall under the general document
policy unless you add a policy for their document type: decide those periods with your accountant.

## 4. Incident register

`OPEN -> INVESTIGATING -> CONTAINED -> RESOLVED`. No step can be skipped. `CONTAINED` and `RESOLVED` can go
back to `INVESTIGATING` (reopening clears `resolvedAt`). Any other move is `409 INVALID_TRANSITION` with the
allowed next steps in `details.allowed`.

Closing (`RESOLVED`) requires:

- `resolutionNotes` (`422 RESOLUTION_NOTES_REQUIRED`);
- when `personalDataInvolved` is true: a recorded decision in `notificationRequired`
  (`422 NOTIFICATION_DECISION_REQUIRED`);
- when `notificationRequired` is true: `authorityNotifiedAt` (`422 NOTIFICATION_NOT_RECORDED`).

`authorityNotifiedAt` and `individualsNotifiedAt` are set with `PATCH` and cannot lie in the future. The
system records these facts; it does not notify anyone and does not judge whether or when notification is
legally required.

```json
{ "id": "…", "tenantId": "…", "title": "Passport copies emailed to the wrong address", "description": "…",
  "severity": "HIGH", "status": "CONTAINED", "affectedData": "Two passport copies", "personalDataInvolved": true,
  "notificationRequired": true, "authorityNotifiedAt": "2026-10-09T08:00:00.000Z", "individualsNotifiedAt": null,
  "resolutionNotes": null, "detectedAt": "…", "resolvedAt": null, "reportedById": "…", "createdAt": "…", "updatedAt": "…" }
```

## 5. Processor / vendor register and cross-border review

Each vendor that receives personal data is recorded with its purpose, data categories and the country of
processing. `crossBorder` defaults to true whenever the country is not `AE`.

- New and materially changed entries are `PENDING_REVIEW`. Changing purpose, data categories, country or the
  cross-border flag of a reviewed entry puts it back to `PENDING_REVIEW`; renaming does not.
- `review` approves or rejects. Approving a cross-border vendor requires `safeguards` to be recorded
  (`422 SAFEGUARDS_REQUIRED`). The reviewer and time are stored.
- The register is a record. It does not technically block an integration: configuring a provider (for example
  `OCR_PROVIDER=external-http`) is an operator decision that should be preceded by an entry here.

## 6. Overview

`GET /privacy/overview`:

```json
{
  "dataSubjectRequests": { "open": 2, "overdue": 1, "openByType": { "EXPORT": 1, "DELETION": 1 }, "completedLast90Days": 0 },
  "consents": [ { "purpose": "MARKETING", "granted": 0, "withdrawn": 2 }, { "purpose": "SERVICE_PROCESSING", "granted": 2, "withdrawn": 0 } ],
  "retention": { "policiesInForce": 2, "policiesEnforcedAutomatically": 2, "documentsOnLegalHold": 1,
                 "deletedDocumentsAwaitingPurge": 0, "policies": [ { "entity": "DOCUMENT", "documentTypeKey": null, "retainDays": 1825, "action": "DELETE", "isActive": true, "enforced": true } ] },
  "incidents": { "byStatus": { "OPEN": 1, "INVESTIGATING": 1, "CONTAINED": 0, "RESOLVED": 0 } },
  "processors": { "total": 1, "pendingReview": 1, "crossBorder": 1, "crossBorderUnapproved": 1 },
  "disclaimer": "These figures describe technical controls in TypEase. They do not establish legal compliance; have your privacy practices reviewed by qualified UAE advisers."
}
```

Consent itself is recorded by the customers module (`customer_consents`, `consent_records`); this module only
reads it. The AI assistant honours a withdrawn `AI_PROCESSING` consent (`ocr.md`).

## 7. Access rules, events, jobs

- Everything on the staff side needs `privacy.manage`. Customers only reach `/privacy/my/*` and only their own
  requests. Another centre's rows are always `404`.
- Data subject requests and retention policies are tenant tables protected by row-level security.
  `security_incidents` and `processor_records` are system-only tables that the tenant database role cannot
  read at all; they are reached through the system connection by one service
  (`privacy/incident.service.ts`), which filters every statement by the caller's tenant (or `tenantId IS NULL`
  for the platform register).
- The erasure parts that cannot run on the tenant connection (append-only trails, the platform-wide `users`
  table) are in `privacy/erasure-system.service.ts`, the only other file of this module on the system
  connection; every statement there is filtered by the tenant of the erasure or by the person's own account ids.
- Events emitted / consumed: none. Cross-module work of an erasure goes through `ErasureRegistry`
  (`common/erasure.ts`): a module that stores something about a customer registers a step
  (`erasure.register('<module>', async (tx, subject) => ({ ...counts }))`); steps must be idempotent and must
  not write personal values to logs or audit entries.
- Background jobs: `privacy.erasure_finalise` (queued by every completed erasure; payload
  `{ tenantId, privacyRequestId, userIds }`; 5 attempts): removes the files of the deleted documents now
  (`DocumentRetentionService.purgeTenant`) and closes the logins again (idempotent retry). Retention is carried
  out by `documents.purge`, which also deletes kept documents of erased customers once their legal hold or
  retention date has ended; the tenant provisioning step `privacy.retention-defaults` creates the starting
  policies.

## 8. Checklist for review by qualified UAE advisers

Technical controls that exist, and the decision each one needs from an adviser or the centre's management:

| Topic | What the system does | To be decided / confirmed |
| --- | --- | --- |
| Lawful basis and consent | Stores consent state and history per purpose; AI processing stops on withdrawal | Which purposes need consent, wording and version of the privacy notice, whether "contract" covers staff-initiated AI extraction |
| Access / export requests | Workflow with due date; JSON export of profile, requests, document metadata, invoices, payments, consents | Whether the export scope is sufficient; identity verification before approval; the 30-day default deadline |
| Correction requests | Workflow and audit trail; the change itself is made by staff | Evidence required before correcting identity data |
| Deletion requests | Erasure across all modules with recorded retention exceptions; refusal while requests / invoices are open; redaction of the person's values in the kept trails; the login account is anonymised when it is used for nothing else | Which records must be kept and for how long (financial, labour, immigration); whether redacting the audit trail is acceptable for your record-keeping duties; the items under "Not covered" in section 2 |
| Retention | Configurable periods; automatic deletion of documents; legal hold | Every period in section 3; periods for records not enforced automatically |
| Security of identity documents | Encrypted storage, random keys, short-lived links, malware scan, access log (`documents.md`) | Key management and backup practice; whether a malware scanner is deployed (`MALWARE_SCANNER`) |
| Incidents | Register with workflow and notification timestamps | When an incident must be notified, to whom and within what time; who decides |
| Vendors and cross-border transfers | Register with review and safeguards field | Transfer mechanisms and contract terms per vendor; hosting region of the database and file storage |
| Support access by TypEase | Time-limited grants with scopes; document access logged with the grant id | The centre's internal approval rule for granting access |
| Demo / test data | Tests and fixtures use ICAO specimens and invented data only | Keep real documents out of non-production environments |
