# Reminders (document expiry automation)

Module folder: `services/api/src/modules/reminders`. Tables: `reminder_schedules`, `reminder_dispatches`.
All paths are under `/api/v1`. Sending is done by the notifications module (template `document.expiry`).

## Endpoints

| Method | Path | Access | Body / query | Response |
| --- | --- | --- | --- | --- |
| GET | `/reminders` | `reminder.read` or `reminder.manage` | `page, pageSize, sort (expiryDate, createdAt, status; default expiryDate:asc), q (subject label), status, customerId, corporateAccountId, documentTypeKey, withinDays, includeExpired` | Paged schedules |
| POST | `/reminders` | `reminder.manage` | `{ customerId? , corporateAccountId?, documentId?, documentTypeKey, subjectLabel?, expiryDate (YYYY-MM-DD), offsetsDays? }` | Schedule with `dispatches` |
| GET | `/reminders/:id` | `reminder.read` or `reminder.manage` | - | Schedule with `dispatches` |
| PATCH | `/reminders/:id` | `reminder.manage` | `{ subjectLabel?, expiryDate?, offsetsDays?, status?: "ACTIVE" | "PAUSED" }` | Schedule |
| POST | `/reminders/:id/pause` | `reminder.manage` | - | Schedule (409 `NO_CHANGE` when already paused) |
| POST | `/reminders/:id/resume` | `reminder.manage` | - | Schedule |
| POST | `/reminders/:id/cancel` | `reminder.manage` | `{ reason? }` | Schedule |
| POST | `/reminders/:id/renewal-link` | `reminder.read` or `reminder.manage` | - | `{ scheduleId, app: "customer" | "corporate", link }` |
| GET | `/me/reminders` | Member of kind CUSTOMER or CORPORATE | `page, pageSize, sort, customerId?` | Paged own schedules (reduced fields). `customerId` narrows a company administrator's list to one employee (the `customerId` of the employee object); any id outside the caller's scope gives an empty page |

Schedule:

```json
{
  "id": "6c0f...", "customerId": "5f1e...", "customerName": "Fatima Al Mansoori", "customerNo": "CUS-000042",
  "corporateAccountId": null, "corporateName": null, "documentId": null,
  "documentTypeKey": "passport", "documentTypeName": "Passport", "documentTypeNameAr": "جواز السفر",
  "subjectLabel": "Fatima Al Mansoori", "expiryDate": "2027-01-07", "daysLeft": 90,
  "offsetsDays": [90, 60, 30, 15, 7], "status": "ACTIVE", "nextReminderOn": "2026-10-09",
  "lastReminderAt": null, "renewalRequestId": null, "createdAt": "...", "updatedAt": "...",
  "dispatches": [
    { "id": "...", "offsetDays": 90, "dueOn": "2026-10-09", "status": "SENT", "detail": "EMAIL: QUEUED, SMS: SUPPRESSED (NO_ADDRESS)", "notificationId": "0b0c...", "processedAt": "..." }
  ]
}
```

`GET /me/reminders` item: `{ id, documentTypeKey, documentTypeName, documentTypeNameAr, subjectLabel, customerId,
customerName, expiryDate, daysLeft, status, nextReminderOn, renewalRequestId, renewalPath }` where `renewalPath`
is `/requests/new?renewalOf=<scheduleId>` inside the portal and `customerId` / `customerName` say whose document
it is (both `null` for a schedule of the company itself). Cancelled schedules are not listed. Staff rows
(`GET /reminders`) additionally carry `customerErased` (the person's data was erased; the name is a placeholder).

`GET /reminders?withinDays=30` is the "upcoming expiries" widget: schedules that are ACTIVE or PAUSED and expire
between today and today + 30 days (add `includeExpired=true` to keep past dates), soonest first.

## Events

| Direction | Event | What happens |
| --- | --- | --- |
| Consumed | `document.verified` `{ documentId, expiryDate?, ... }` | When the document has an expiry date and its document type has `reminderEnabled`, a schedule is created for the document (or its expiry date updated). For personal documents, older running schedules of the same customer and document type are set to COMPLETED ("renewed"). Idempotent. |
| Consumed | `document.expiry_changed` `{ documentId, source, ... }` | The expiry date of a document was typed by staff (`PATCH /documents/:id`) or applied from a reviewed OCR extraction. The handler reads the date from the document row (events may arrive late or twice). A running schedule of that document moves to the new date and starts a new round. A new schedule is started only when the date was confirmed by a person (`expiryVerified`, which applying a reviewed extraction sets), the type has `reminderEnabled` and the date is not in the past; a date that was only typed waits for the verify action. A removed date changes nothing. Idempotent. |
| Emitted | `document.expiring` `{ scheduleId, dispatchId, documentId, customerId, corporateAccountId, documentTypeKey, subjectLabel, expiryDate (YYYY-MM-DD), daysLeft, offsetDays }` | One per due reminder, emitted by the daily scan. |

## Background job

`reminders.scan` - daily at 04:00 UTC (08:00 in the UAE), fans out over all operational tenants. Payload
`{ today?: "YYYY-MM-DD" }` overrides the date (tests, back-fills); otherwise "today" is the current date in the
tenant's time zone. For every ACTIVE schedule, inside one transaction with the schedule row locked:

1. An offset is due once `expiryDate - offset <= today`. If several are due and unhandled (schedule created
   late, job did not run), only the one closest to the expiry date is sent; the others get a dispatch row
   `CANCELLED` ("Replaced by a later reminder"). Nobody receives several reminders at once.
2. A `reminder_dispatches` row is inserted for the offset (unique per schedule + offset). If it already exists
   the scan stops there: running the job twice on the same day sends nothing twice.
3. Consent and preferences are checked with the notification rules:
   - `SKIPPED_NO_CONSENT` - the customer has no `REMINDERS` consent with status GRANTED;
   - `SKIPPED_OPT_OUT` - consent exists but every available channel is opted out;
   - `FAILED` - nobody reachable (no email, phone or portal account);
   - otherwise `SENT`: `document.expiring` is emitted in the same transaction.
4. The notifications module links the dispatch to the notification it created (`notificationId`, `detail`
   lists the channels) and sets the dispatch to `FAILED` with the provider error if delivery finally fails.
5. After the expiry date has passed the schedule becomes `COMPLETED`; unsent offsets are recorded as `CANCELLED`.

## Business rules

- A schedule belongs to a customer, a corporate account, or both; the document id is optional (reminders can
  be tracked without an uploaded file). `documentTypeKey` must be an active tenant or platform document type.
- Default offsets: `tenant.settings.reminderOffsetsDays`, else 90, 60, 30, 15, 7. Custom offsets: 1-12 values
  between 0 and 730 days; 0 means "on the expiry day". Stored largest first, duplicates removed.
- The expiry date cannot be in the past (422 `EXPIRY_IN_PAST`). One running schedule per owner, document type and
  subject label (409 `DUPLICATE_REMINDER`); a company can track the same document type for many employees by
  using different subject labels. A linked document must belong to the same customer / company
  (422 `DOCUMENT_OWNER_MISMATCH`).
- Changing the expiry date starts a new round: the dispatch rows of the old date are deleted (the count is in
  the audit entry) because each offset can exist only once per schedule.
- Status: `ACTIVE <-> PAUSED`, `-> CANCELLED` (manual), `-> COMPLETED` (expired or renewed). CANCELLED and
  COMPLETED schedules cannot be changed (409 `REMINDER_CLOSED`). Paused schedules are skipped by the scan; after
  resuming, at most one missed reminder is sent.
- Corporate schedules (no customer): reminders go to the company's portal members, or to the billing email
  when there are none; no consumer consent is required for these business contacts.
- Renewal assistance: `POST /reminders/:id/renewal-link` returns
  `TenantResolver.portalLink(tenantId, '/requests/new', { renewalOf: <scheduleId> })` (corporate portal for
  company schedules). The requests module stores the new request in `renewalRequestId`; this module clears it
  again when that request is cancelled (`request.cancelled`, in the same transaction; audit
  `reminder.renewal_cleared`), so a new renewal can be started from the same reminder. An employee in the
  corporate portal may only renew their own documents; an administrator also the company's.
- Wording: the default templates say the document "expires on <date> according to our records" and make no
  statement about legal deadlines or penalties (enforced by a unit test).
- Customers see only schedules of their own customer record. Company users see the company's schedules; those
  with `corp.employees.read` also see the schedules of the company's employees.
- Audit actions: `reminder.created`, `reminder.updated`, `reminder.cancelled`, `reminder.completed`.
