# Customers module

Customer profiles, search, duplicate detection, merging, archive, internal notes, tags, extra contacts, consents,
portal invitations and customer self-service.

Source: `services/api/src/modules/customers/` · schemas: `packages/validation/src/customers.ts`
Tables written: `customers`, `customer_contacts`, `customer_notes`, `customer_tags`, `customer_tag_assignments`,
`customer_consents`, `consent_records`; plus `tenant_memberships` (portal invitation) and, during a merge only,
the `customerId` column of the tables listed under "Merging".
Tables read: `service_requests`, `documents`, `invoices`, `appointments`, `support_tickets`, `corporate_accounts`,
`audit_logs`, `users`, `roles`, `tenants`.

All paths are below `/api/v1`. Errors use the common shape `{ statusCode, code, message, details?, requestId }`.

## Endpoints (32)

### Staff: customers

| Method | Path | Permission | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/customers` | `customer.read` | Query, see "Search" | Page of list items |
| POST | `/customers` | `customer.create` | Customer body | Profile (201); `409 POSSIBLE_DUPLICATE` |
| POST | `/customers/duplicates/check` | `customer.create`, `customer.update` or `customer.merge` | `{ fullName?, email?, phone?, emiratesId?, passportNo?, excludeId? }` (at least one) | `{ candidates, strongCount, weakCount }` |
| POST | `/customers/merge` | `customer.merge` | `{ targetId, sourceId, confirmSourceCustomerNo, reason }` | `{ target, source, moved, retainedOnSource, filledFields }` |
| GET | `/customers/:id` | `customer.read` | - | Overview (below) |
| PATCH | `/customers/:id` | `customer.update` | Any customer field + `version?`, `confirmNotDuplicate?` | Profile |
| GET | `/customers/:id/identity` | `customer.sensitive.read` | - | Full identity numbers; audited on every call |
| POST | `/customers/:id/archive` | `customer.archive` | `{ reason? }` | Profile (`status: "ARCHIVED"`) |
| POST | `/customers/:id/restore` | `customer.archive` | - | Profile (`status: "ACTIVE"`) |
| GET | `/customers/:id/activity` | `customer.read` | `page, pageSize` | Page of audit entries |
| POST | `/customers/:id/portal-invitation` | `customer.update` | `{ email? }` | `{ membershipId, status: "INVITED", email }` (201) |

### Staff: notes, tags, contacts, consents

| Method | Path | Permission | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/customers/:id/notes` | `customer.read` | `page, pageSize, q` | Page of notes, pinned first, each with `authorName` |
| POST | `/customers/:id/notes` | `customer.update` | `{ body, isPinned? }` | Note (201) |
| PATCH | `/customers/:id/notes/:noteId` | `customer.update` | `{ body?, isPinned? }` | Note |
| DELETE | `/customers/:id/notes/:noteId` | `customer.update` | - | `{ status: "DELETED" }` |
| GET | `/customer-tags` | `customer.read` | - | Tags with `customerCount` |
| POST | `/customer-tags` | `customer.update` | `{ name, color? }` | Tag (201); `409 DUPLICATE_TAG` |
| PATCH | `/customer-tags/:id` | `customer.update` | `{ name?, color? }` | Tag |
| DELETE | `/customer-tags/:id` | `customer.update` | - | `{ status: "DELETED", removedFromCustomers }` |
| PUT | `/customers/:id/tags` | `customer.update` | `{ tagIds: uuid[] }` | The customer's tags (replaces the whole set) |
| POST | `/customers/:id/tags/:tagId` | `customer.update` | - | The customer's tags |
| DELETE | `/customers/:id/tags/:tagId` | `customer.update` | - | The customer's tags |
| GET | `/customers/:id/contacts` | `customer.read` | - | Contacts |
| POST | `/customers/:id/contacts` | `customer.update` | `{ type, value, label?, isPrimary? }` with `type` = `EMAIL`, `PHONE` or `WHATSAPP` | Contact (201) |
| PATCH | `/customers/:id/contacts/:contactId` | `customer.update` | `{ value?, label?, isPrimary? }` | Contact |
| DELETE | `/customers/:id/contacts/:contactId` | `customer.update` | - | `{ status: "DELETED" }` |
| GET | `/customers/:id/consents` | `customer.read` | - | `{ consents: [6 purposes], history: [...] }` |
| PUT | `/customers/:id/consents` | `customer.update` | `{ purpose, granted, lawfulBasis?, noticeVersion? }` | `{ changed, consents }` |

### Customer self-service (membership kind `CUSTOMER`)

| Method | Path | Access | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/me/customer` | kind `CUSTOMER` + `self.profile` | - | Own profile (masked) |
| PATCH | `/me/customer` | kind `CUSTOMER` + `self.profile` | `{ fullName?, fullNameAr?, preferredLanguage?, address?, communicationPrefs?, phone?, nationality?, dateOfBirth? }` | Own profile |
| GET | `/me/consents` | kind `CUSTOMER` + `self.privacy` | - | `{ consents: [6 purposes] }` |
| PUT | `/me/consents` | kind `CUSTOMER` + `self.privacy` | `{ consents: [{ purpose, granted, noticeVersion? }] }` | `{ changed: [purpose], consents }` |

The record is always the one linked to the signed-in membership (`ownCustomerId()`); there is no id in the path.

## Shapes

Customer body (`POST /customers`; all fields optional for PATCH):

```json
{
  "type": "INDIVIDUAL", "fullName": "Fatima Al Mansoori", "fullNameAr": "فاطمة المنصوري", "preferredLanguage": "ar",
  "email": "fatima@example.com", "phone": "+971501234567", "nationality": "AE", "dateOfBirth": "1988-07-15",
  "address": { "line1": "Villa 12", "city": "Dubai", "emirate": "Dubai", "country": "AE" },
  "emiratesId": "784-1988-1234567-1", "emiratesIdExpiry": "2028-03-31",
  "passportNo": "AB1234567", "passportCountry": "AE", "passportExpiry": "2030-01-01",
  "corporateAccountId": null, "communicationPrefs": { "whatsapp": true }, "marketingOptIn": false,
  "tagIds": [], "confirmNotDuplicate": false
}
```

Only `fullName` is required. Profile (returned by create, update, archive, restore):

```json
{
  "id": "…", "tenantId": "…", "customerNo": "CUS-000042", "type": "INDIVIDUAL", "status": "ACTIVE", "erased": false,
  "fullName": "Fatima Al Mansoori", "fullNameAr": "فاطمة المنصوري", "preferredLanguage": "ar",
  "email": "fatima@example.com", "phone": "+971501234567", "nationality": "AE", "dateOfBirth": "1988-07-15",
  "address": { "line1": "Villa 12", "city": "Dubai", "emirate": "Dubai", "country": "AE" },
  "emiratesIdMasked": "•••• 5671", "hasEmiratesId": true, "emiratesIdExpiry": "2028-03-31",
  "passportNoMasked": "•••• 4567", "hasPassport": true, "passportCountry": "AE", "passportExpiry": "2030-01-01",
  "corporateAccountId": null, "communicationPrefs": { "email": true, "sms": true, "whatsapp": true, "push": true },
  "marketingOptIn": false, "mergedIntoId": null, "lastActivityAt": "…", "createdById": "…",
  "createdAt": "…", "updatedAt": "…", "version": 1
}
```

Overview (`GET /customers/:id`) = profile plus:

```json
{
  "erasedAt": null,
  "corporateAccount": { "id": "…", "accountNo": "CORP-000009", "companyName": "Oryx Logistics LLC", "status": "ACTIVE" },
  "mergedInto": null,
  "mergedFrom": [{ "id": "…", "customerNo": "CUS-000017", "fullName": "Sara Ahmad", "erased": false }],
  "tags": [{ "id": "…", "name": "VIP", "color": "#0B7AD1" }],
  "pinnedNotes": [{ "id": "…", "body": "…", "isPinned": true, "authorId": "…", "authorName": "…", "createdAt": "…" }],
  "contacts": [{ "id": "…", "type": "EMAIL", "value": "work@example.com", "label": "Work", "isPrimary": true }],
  "portalAccess": { "status": "ACTIVE", "email": "fatima@example.com", "lastLoginAt": "…" },
  "counters": { "openRequests": 1, "totalRequests": 3, "documents": 1, "unpaidInvoices": 2, "unpaidInvoicesBalance": "449.50",
                "currency": "AED", "upcomingAppointments": 1, "openTickets": 1 }
}
```

`portalAccess.status` is `NONE | INVITED | ACTIVE | SUSPENDED`. The tab lists (requests, documents, invoices,
payments, appointments, communications, reminders, tickets) are served by the modules that own those tables,
filtered by `customerId`; this module provides the overview and `GET /customers/:id/activity`.

List item (`GET /customers`): `id, customerNo, type, status, fullName, fullNameAr, preferredLanguage, email, phone,
nationality, corporateAccountId, mergedIntoId, lastActivityAt, createdAt, emiratesIdMasked, passportNoMasked,
tags, portalAccess`. Date of birth and address are not in list rows.

`GET /customers/:id/identity`:

```json
{ "customerId": "…", "customerNo": "CUS-000042", "emiratesId": "784198812345671", "emiratesIdExpiry": "2028-03-31",
  "passportNo": "AB1234567", "passportCountry": "AE", "passportExpiry": "2030-01-01" }
```

`409 POSSIBLE_DUPLICATE`:

```json
{ "statusCode": 409, "code": "POSSIBLE_DUPLICATE",
  "message": "A customer with the same Emirates ID, passport, phone or email already exists. Open the existing record, or confirm that this is a different person to continue.",
  "details": { "candidates": [{ "customer": { "id": "…", "customerNo": "CUS-000003", "fullName": "Mohammed Ali", "emiratesIdMasked": "•••• 5671", "…": "list item" },
                                "signals": ["EMIRATES_ID", "NAME"], "strength": "STRONG" }] } }
```

Merge response:

```json
{ "target": { "…profile of the kept record…" },
  "source": { "id": "…", "customerNo": "CUS-000017", "status": "MERGED", "mergedIntoId": "…" },
  "moved": { "serviceRequests": 1, "documents": 1, "quotations": 1, "invoices": 1, "payments": 1, "appointments": 1, "queueTokens": 1,
             "reminderSchedules": 1, "supportTickets": 1, "customerFeedback": 1, "dataSubjectRequests": 1, "tasks": 1, "notifications": 1,
             "notes": 1, "contacts": 3, "tagAssignments": 1, "corporateEmployees": 1, "memberships": 0, "consents": 1 },
  "retainedOnSource": { "invoices": 1, "payments": 1 },
  "filledFields": ["fullNameAr", "nationality", "emiratesId"] }
```

Consent state item:

```json
{ "purpose": "MARKETING", "description": "Offers and news from the centre", "status": "GRANTED", "granted": true,
  "lawfulBasis": "CONSENT", "noticeVersion": "v2", "grantedAt": "…", "withdrawnAt": null, "updatedAt": "…" }
```

`status` is `GRANTED | WITHDRAWN | NOT_SET`. History item: `id, customerId, purpose, status, lawfulBasis,
noticeVersion, capturedVia (STAFF_RECORDED | PORTAL | MOBILE), capturedById, createdAt`.

## Business rules

### Customer numbers and versions
- `customerNo` (`CUS-000001` ...) is gap-free and unique per centre; it is assigned in the same transaction that
  creates the record, so a failed registration does not use up a number.
- Optimistic concurrency: send the `version` you loaded with PATCH; a mismatch is `409 VERSION_CONFLICT`. Every
  change increases `version`. `status`, `customerNo` and merge links cannot be set through PATCH.
- Customers belong to the centre, not to a branch: staff restricted to certain branches still see all customers.
- Names are stored with single spaces; emails lower-case; phones in E.164 (`+971501234567`).

### Identity numbers (Emirates ID, passport number)
- Stored only as: an AES-256-GCM encrypted value, a keyed blind index (HMAC, scoped to the centre) and the last
  four characters. The plain number is in no column.
- Every normal response (list, overview, create, update, duplicate candidates, merge, self-service) shows
  `emiratesIdMasked` / `passportNoMasked` (`"•••• 5671"`) and `hasEmiratesId` / `hasPassport`. The encrypted and
  hashed columns are never selected for these responses.
- `GET /customers/:id/identity` returns the decrypted numbers to holders of `customer.sensitive.read` and writes
  the audit entry `customer.identity_revealed` on every call (who, when, which fields - never the numbers).
- The audit trail describes identity numbers as `"ends in 5671"` only.
- To replace a number send the new value; to remove it send `null`.

### Search (`GET /customers`)
| Parameter | Matching |
| --- | --- |
| `q` | Name (English or Arabic) contains, case-insensitive; customer number exact (`CUS-000042`, or just `42`); email contains when the text has an `@`; phone exact after normalisation; Emirates ID / passport exact through the blind index; request reference exact (`TE-000123`) |
| `phone` | Exact after normalisation: `050 123 4567`, `00971501234567` and `+971501234567` are the same number. Never partial |
| `email` | Exact (case-insensitive) |
| `emiratesId`, `passportNo` | Exact match through the blind index only. Partial numbers, including the stored last four digits, never match |
| `requestNo` | The customer of the request with that reference |
| `status` | `ACTIVE` (default), `ARCHIVED`, `MERGED`, `ANONYMISED`, `ALL`. `ALL` = active, archived and merged; erased records (`ANONYMISED`) are listed only when asked for explicitly, never by `ALL`, by a search or by a picker (see "Erased customers") |
| `type`, `tagId`, `corporateAccountId`, `hasAccount` | Filters (`hasAccount` = has an active or invited portal login) |
| `sort` | `createdAt` (default, desc), `fullName`, `customerNo`, `lastActivityAt` |

### Duplicate detection
- Signals: same Emirates ID, same passport number, same phone, same email (**strong**); same normalised name
  (**weak**). Records that are `MERGED` or `ANONYMISED` are ignored. Detection never crosses centres.
- `POST /customers/duplicates/check` only reports. Candidates are masked list items.
- `POST /customers` runs the same check. If there is at least one strong candidate and `confirmNotDuplicate` is not
  `true`, nothing is created and the answer is `409 POSSIBLE_DUPLICATE` with the candidates. With
  `confirmNotDuplicate: true` the record is created and the audit entry lists the records the member of staff
  reviewed (`confirmedNotDuplicateOf`).
- A matching name alone never blocks a registration and never merges anything.
- PATCH applies the same gate when it sets an Emirates ID, passport number, phone or email that another record
  already has.
- Two simultaneous registrations with the same identifying value are serialised: only one can pass the check.

### Merging (`POST /customers/merge`)
- Never automatic. Requires `customer.merge`, the typed number of the record that will be retired
  (`confirmSourceCustomerNo`, case-insensitive) and a reason of at least 5 characters.
- Refused: a record into itself (`422 MERGE_SAME_RECORD`); wrong typed number (`422 MERGE_CONFIRMATION_MISMATCH`);
  a record that was already merged, as source or target (`409 ALREADY_MERGED`); an erased record
  (`409 CUSTOMER_ERASED`); an archived target (`409 CUSTOMER_ARCHIVED` - restore it first; an archived source
  is fine); two records linked to different portal logins (`409 MERGE_BOTH_HAVE_LOGINS`).
- One transaction; any failure leaves both records exactly as they were. Moved to the kept record:
  service requests, documents, quotations, **draft** invoices, **unfinished** payments, appointments, queue tokens,
  reminder schedules, support tickets, feedback, data subject requests, tasks, in-app notifications, notes,
  contacts, tag assignments, corporate employee records, portal logins and consents.
- **Issued invoices and completed payments stay on the retired record.** The database treats their customer as
  immutable. They are reported in `retainedOnSource`, the retired record keeps pointing at the kept record
  (`mergedIntoId`), and the kept record's overview lists `mergedFrom` and includes those invoices in
  `unpaidInvoices` / `unpaidInvoicesBalance`. A finance screen that lists a customer's invoices or payments must
  therefore query `customerId IN (id, ...mergedFrom ids)`.
- Empty fields of the kept record are filled from the retired one (`fullNameAr`, `email`, `phone`, `nationality`,
  `dateOfBirth`, `address`, `corporateAccountId`, Emirates ID, passport); existing values are never overwritten.
  When both records have a different main email / phone, the retired record's value is kept as an extra contact
  labelled `From CUS-…`.
- Contacts: exact duplicates are dropped; the kept record's primary contacts stay primary. Tags and employee
  records are de-duplicated. Consents: one row per purpose - where both records decided and the decisions differ,
  the more recent one stands and is appended to the history of the kept record.
- The retired record becomes `MERGED` with `mergedIntoId`, is read-only and is hidden from the default list.
  Records merged into it earlier are re-pointed to the kept record.
- Audit: `customer.merged` on the kept record (reason, counts per table, retained rows, filled fields) and
  `customer.merged_into` on the retired record. Event: `customer.merged`.

### Archive / restore
- Archive sets `status: "ARCHIVED"` (soft). Refused while the customer has open requests
  (`409 CUSTOMER_HAS_OPEN_REQUESTS`). Archived customers are hidden from the default list, cannot be edited
  (`409 CUSTOMER_ARCHIVED`) and can be restored. Merged records cannot be restored (`409 NOT_ARCHIVED`), erased
  records answer `409 CUSTOMER_ERASED`.

### Erased customers
A privacy erasure (privacy.md, "Erasure") keeps the customer row - invoices, payments and requests still point
at it - but blanks every personal field, renames it to the placeholder **"Erased customer"**, sets
`status: "ANONYMISED"` and `deletedAt` (= when it was erased). What is left is a stub:

- `GET /customers/:id` answers `200` with the stub: `status: "ANONYMISED"`, `erased: true`, `erasedAt` (ISO
  timestamp; `null` on every other record), `fullName: "Erased customer"`, `fullNameAr`, `email`, `phone`,
  `nationality`, `dateOfBirth`, `address`, `passportCountry` all `null`, `emiratesIdMasked` / `passportNoMasked`
  `null`, `hasEmiratesId` / `hasPassport` `false`, `marketingOptIn: false`, no contacts, notes or tags,
  `portalAccess: { status: "NONE", email: null }`. The counters still count the kept requests and invoices. A
  record of another centre is 404 as always.
- Every mutation answers `409 CUSTOMER_ERASED`: `PATCH`, archive, restore, identity reveal (nothing is left to
  reveal, and no `customer.identity_revealed` entry is written), notes, contacts, tags, consents, portal
  invitation, merge (as source or target), and anything that would attach something new to the record - a
  request, a quotation, an invoice, a payment, a document upload, a reminder, an appointment, a queue token, a
  task, a support ticket, a privacy request. The message says why: the record is kept only as a reference.
- Lists and search leave it out: `GET /customers` without `status`, with `status=ALL` or `ARCHIVED`, with any
  `q`, and the duplicate check never return it. Only `GET /customers?status=ANONYMISED` lists erased records
  (list rows carry `erased: true`). A record that had been merged into the erased one before the erasure keeps
  `status: "MERGED"` (finance still finds what stayed on it) but is blanked too and carries `erased: true`.
- Wherever another record embeds the customer - `customer` on invoices, payments, quotations, requests (list and
  detail), `mergedInto` / `mergedFrom` here, employee rows of the corporate module - the reference carries
  `erased: boolean` and never the record status: `{ id, customerNo, fullName, erased, email?, phone? }`. Flat
  views (appointments, support tickets, reminders) carry `customerErased`; document rows `customerName` +
  `customerErased`.
- Customers and corporate users never see an erased record: the person's own logins are gone, and a company
  no longer sees that employee (corporate.md).

### Notes, tags, contacts
- Notes are internal: there is no customer-facing endpoint for them. Pinned notes come first and appear in the
  overview. Only the author can change the text of a note; anyone with `customer.update` can pin / unpin; a note
  can be deleted by its author or by someone holding `customer.archive`. The audit trail records that a note was
  added / changed / deleted, never its text.
- Tag names are unique per centre (case-insensitive). Deleting a tag removes it from every customer. Tags are
  internal labels and are never shown to customers.
- Contacts: the value is validated for its type (email, or E.164 for `PHONE` / `WHATSAPP`). Exactly one primary
  per type: the first contact of a type is primary, making another one primary demotes the previous one, the
  primary flag cannot simply be switched off (`422 PRIMARY_CONTACT_REQUIRED`), and removing the primary promotes
  the oldest remaining contact of that type. The same value cannot be added twice (`409 DUPLICATE_CONTACT`).

### Consents
- Purposes: `SERVICE_PROCESSING`, `REMINDERS`, `MARKETING`, `AI_PROCESSING`, `DOCUMENT_REUSE`, `WHATSAPP`.
- `customer_consents` holds the current state per purpose; every change appends a row to `consent_records`
  (purpose, status, lawful basis, notice version, channel, who recorded it, IP). The database rejects updates and
  deletes on `consent_records`. Saving an unchanged decision writes nothing (`changed: false`).
- Lawful basis: `CONTRACT` for `SERVICE_PROCESSING`, `CONSENT` for the others, unless staff state another one
  (`CONSENT | CONTRACT | LEGAL_OBLIGATION | LEGITIMATE_INTEREST`).
- `capturedVia`: `STAFF_RECORDED` for the staff endpoint; `PORTAL` or `MOBILE` (session app `mobile`) for the
  customer's own changes.
- A customer registered by staff gets `SERVICE_PROCESSING` (contract) recorded, plus `MARKETING` / `WHATSAPP` when
  those were ticked. Customers created for a company by the corporate module get no consent rows.
- `MARKETING` mirrors `customers.marketingOptIn` and `WHATSAPP` mirrors `communicationPrefs.whatsapp`, in both
  directions: changing the flag on the profile records the consent decision, and changing the consent updates
  the flag.
- Customers cannot switch off `SERVICE_PROCESSING` themselves (`422 CONSENT_REQUIRED_FOR_SERVICE`); a
  `PUT /me/consents` containing it changes nothing at all.

### Portal invitation
- `POST /customers/:id/portal-invitation` creates (or re-uses) the user account for the email address and an
  `INVITED` membership of kind `CUSTOMER` with the `customer` role, linked to exactly this customer, then sends
  the invitation through `AuthService.sendInvitation({ app: 'customer' })` after the transaction. When the person
  accepts (`POST /auth/invitations/accept`) they see the existing record with its history.
- The address is `email` from the body, else the customer's email (`422 EMAIL_REQUIRED` if neither). A given
  address fills an empty email on the record.
- Calling it again re-sends: the earlier link stops working. Sending to a different address withdraws the earlier
  unanswered invitation.
- `409 ALREADY_HAS_ACCESS` when the customer already has a login; `409 EMAIL_IN_USE` when the address already
  signs in to another customer profile of the same centre.
- In non-production environments with `EXPOSE_DEV_TOKENS=true` the response also carries `dev.invitationToken`.

### Self-service
- `PATCH /me/customer` accepts name, Arabic name, language, address and communication preferences - always - and
  **phone, nationality and date of birth while the value is empty or the customer's own entry**. Once somebody
  at the centre entered or confirmed a value (registration at the counter, a staff edit, a value applied from a
  reviewed document, a merge), it counts as verified: a change answers
  `409 CORRECTION_REQUIRED { details: { fields: ["nationality"], how: "POST /privacy/my/requests { type: CORRECTION, ... }" } }`
  and nothing of that request is applied (not even the allowed part). Sending the value that is already there
  is not a change; `null` clears a value (and counts as a change). Validation is the same as at the counter
  (`+971...` phone, ISO country code, `YYYY-MM-DD` not in the future: `400`).
- `GET /me/customer` and the `PATCH` response carry `editable: { phone, nationality, dateOfBirth }` (`false` =
  confirmed by the centre, send a correction request). There is no "verified" column: the audit trail of the
  record says who set each value last (`customer.self_updated` = the customer; everything else = the centre; a
  value that came with a record the customer created by registering online is the customer's own).
- The email address (the login), identity numbers, type, status, company link and marketing opt-in are never
  changed here: those keys are ignored. Not possible while the record is not `ACTIVE` (`409 PROFILE_LOCKED`).
- The own profile never contains notes, tags, counters, merge links or who created the record.

### Activity and last activity
- `GET /customers/:id/activity` lists the audit entries whose resource is this customer (and records merged into
  it): `id, action, summary, actorType, actorLabel, actorUserId, resourceId, createdAt`. `before` / `after` are
  included only for callers holding `audit.read`.
- `lastActivityAt` is set by this module's own changes and moved forward by the events listed below.

## Events
| Direction | Event | Payload / effect |
| --- | --- | --- |
| Emitted | `customer.created` | `{ customerId, source }` with `source` = `STAFF` or `CORPORATE` (self-registration emits it from the auth module with `SELF_REGISTRATION`) |
| Emitted | `customer.merged` | `{ sourceId, targetId, sourceCustomerNo, targetCustomerNo }` |
| Consumed (after commit, idempotent) | `request.created`, `request.submitted`, `request.completed`, `document.uploaded`, `quotation.approved`, `payment.completed`, `appointment.created`, `ticket.created` | Moves `lastActivityAt` of `payload.customerId` forward. Does not change `version` |

## Background jobs
None.

## Audit actions
`customer.created`, `customer.updated`, `customer.identity_revealed`, `customer.archived`, `customer.restored`,
`customer.merged`, `customer.merged_into`, `customer.note_added|note_updated|note_deleted`,
`customer.tags_changed|tag_assigned|tag_removed`, `customer.contact_added|contact_updated|contact_removed`,
`customer.consent_granted|consent_withdrawn|consent_changed`, `customer.portal_invited`, `customer.self_updated`
(resource type `Customer`) and `customer_tag.created|updated|deleted` (resource type `CustomerTag`).
