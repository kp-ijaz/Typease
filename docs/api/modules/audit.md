# Audit logs (viewer)

Module folder: `services/api/src/modules/audit`. Table read: `audit_logs` (written by every module through
`AuditService`; this module never writes to it except to record an export). Schemas:
`packages/validation/src/platform.ts` (`auditLogQuery`, `auditExportQuery`). All paths are under `/api/v1`.

The audit trail is **append-only**: the tenant-scoped database role may only `INSERT` and `SELECT`, and a
trigger rejects `UPDATE` and `DELETE` for every role. There is deliberately no endpoint that edits or
deletes an entry.

One controlled exception: when a customer's erasure (privacy module, data subject request of type `DELETION`)
is carried out, the entries of that centre that are linked to the person by id keep their place, time, actor
and action, but the person's values in `summary`, `before` and `after` are replaced by `[erased]`, and
`actorLabel`, `ip` and `userAgent` are removed from entries the person made themselves. No entry is deleted.
This runs on the system connection with the database's purge switch and is itself audited
(`privacy.customer_anonymised`, with the number of entries changed). See `privacy.md`, section 2.

## Endpoints

All three need `audit.read`. By default the owner and the manager hold it. Customers and corporate users
never do (it is not in their permission catalogue), and platform staff reach it only inside an approved
support access grant that includes the `audit.read` scope (see `platform.md`).

| Method | Path | Query | Response |
| --- | --- | --- | --- |
| GET | `/audit-logs` | `page, pageSize, sort (createdAt), q, action, resourceType, resourceId, actorUserId, actorType, from, to, supportAccess, supportGrantId` | Paged entries, newest first, **without** `before` / `after` |
| GET | `/audit-logs/export` | the same filters, no paging | `text/csv` (attachment) |
| GET | `/audit-logs/:id` | - | One entry **with** `before` / `after` |

Filters:

| Filter | Meaning |
| --- | --- |
| `action` | **prefix** of the action: `invoice.` matches `invoice.issued`, `invoice.voided` ... Letters, digits, `.`, `_`, `-` only |
| `resourceType` + `resourceId` | everything that happened to one record, e.g. `resourceType=Invoice&resourceId=<uuid>` |
| `actorUserId`, `actorType` | who did it; `actorType` is `STAFF, CUSTOMER, CORPORATE, PLATFORM, SYSTEM, AUTOMATION` |
| `from`, `to` | `YYYY-MM-DD` (the whole day, UTC) or a full ISO timestamp (exact) |
| `supportAccess` | `true` = only what TypEase support did or requested under an access grant; `false` = everything else |
| `supportGrantId` | everything that belongs to one support access grant |
| `q` | text in the summary, the actor's name or the action |

List entry:

```json
{ "id": "...", "createdAt": "2026-10-09T09:30:00.000Z", "action": "invoice.voided", "resourceType": "Invoice",
  "resourceId": "...", "summary": "Invoice INV-000042 voided", "actorType": "STAFF", "actorLabel": "Omar Khalid",
  "actorUserId": "...", "supportGrantId": null, "requestId": "...", "ip": "203.0.113.7" }
```

`GET /audit-logs/:id` adds `before`, `after` and `userAgent`. Credentials are never in these values: every
module's entries pass through the redaction in `AuditService` when they are written.

## Export

`GET /audit-logs/export` returns the filtered trail as CSV, newest first.

- Columns: `createdAt, action, resourceType, resourceId, summary, actorType, actorLabel, actorUserId,
  supportGrantId, ip, requestId, id`. `before` / `after` values are **not** exported.
- UTF-8 with a byte-order mark (Arabic names open correctly in spreadsheets), CRLF line ends, RFC 4180
  quoting.
- A cell that a spreadsheet would execute as a formula (starts with `=`, `+`, `-`, `@`, tab or carriage
  return) is prefixed with an apostrophe.
- **Capped at 10,000 rows** per file. Response headers: `X-Export-Rows` (rows in this file) and
  `X-Export-Truncated: true|false`. When it is truncated, narrow the date range and export again.
- The export itself is audited: `audit.exported` with the filters, the number of rows and whether it was
  truncated. (That entry is therefore part of the next export.)

## Business rules

- **Tenant isolation.** Every query runs on the tenant-scoped connection and filters by the centre of the
  session. An entry of another centre, and a platform-level entry (no centre), is `404` by id and never
  appears in a list or an export, whatever the filters.
- **Support access is visible.** Every entry written while TypEase support acts under an access grant has
  `actorType: "PLATFORM"`, an actor label ending in "(TypEase support)" and the grant's id in
  `supportGrantId`. The request for access and the moment support entered the centre carry the grant id too,
  so `?supportGrantId=<id>` shows the whole story of one grant.
- **Every call of a support session** that reaches centre data, and every call that was refused, is an entry
  `support_access.api_call` (`resourceType: "AccessGrant"`, `resourceId` = the grant,
  `after: { method, route, path, outcome: "ALLOWED" | "REFUSED", reason? }`), so
  `GET /audit-logs?supportGrantId=<id>` is the complete record of what TypEase support looked at and tried.
  Details: `platform.md`, "What a support session can reach".
- Sorting is always by time; ties are broken by id so paging is stable.

## Events and jobs

None.
