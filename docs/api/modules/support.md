# Support

Module folder: `services/api/src/modules/support`. Tables: `sla_policies`, `support_tickets`, `support_messages`,
`customer_feedback`. All paths are under `/api/v1`.

Two kinds of tickets share the tables and never mix:

- `scope = CUSTOMER`: a customer (or company user) asks the centre.
- `scope = PLATFORM`: the centre asks TypEase support.

## Endpoints

### Centre staff - customer tickets

| Method | Path | Access | Body / query | Response |
| --- | --- | --- | --- | --- |
| GET | `/support/tickets` | `ticket.read` or `ticket.manage` | `page, pageSize, sort (createdAt, updatedAt, priority, status, resolutionDueAt, firstResponseDueAt), q (subject, ticket no., customer), status, open, priority, category, assigneeId, unassigned, customerId, requestId, breached` | Paged tickets |
| POST | `/support/tickets` | `ticket.manage` | `{ customerId, subject, message, category?, priority = NORMAL, requestId?, assigneeId?, attachments? }` | Ticket with messages |
| GET | `/support/tickets/:id` | `ticket.read` or `ticket.manage` | - | Ticket with ALL messages + `feedback` |
| PATCH | `/support/tickets/:id` | `ticket.manage` | `{ priority?, category?, assigneeId? (membership id or null) }` | Ticket |
| POST | `/support/tickets/:id/messages` | `ticket.manage` | `{ body, visibility = CUSTOMER | INTERNAL, attachments?, status?: WAITING_CUSTOMER | RESOLVED, resolutionSummary? }` | Ticket |
| POST | `/support/tickets/:id/status` | `ticket.manage` | `{ status, resolutionSummary? }` | Ticket |
| GET | `/support/sla-policies` | `ticket.read` or `ticket.manage` | - | Four policies (URGENT, HIGH, NORMAL, LOW) |
| PUT | `/support/sla-policies` | `ticket.manage` | `{ policies: [{ priority, firstResponseMinutes, resolutionMinutes, name?, isActive = true }] }` | Four policies |
| GET | `/support/settings` | `ticket.read` or `ticket.manage` | - | `{ reopenWindowDays }` |
| PUT | `/support/settings` | `ticket.manage` | `{ reopenWindowDays: 0-90 }` | `{ reopenWindowDays }` |
| GET | `/support/feedback` | `ticket.read` or `ticket.manage` | `page, pageSize, sort (createdAt, rating), q (comment), customerId, maxRating, kind = TICKET | REQUEST` | Paged feedback |
| GET | `/support/feedback/summary` | `ticket.read`, `ticket.manage` or `report.operational` | `from?, to? (YYYY-MM; default last 12 months, max 36)` | Average per month |

Ticket (staff view):

```json
{
  "id": "…", "ticketNo": "TKT-000012", "scope": "CUSTOMER", "subject": "Where is my visa?", "category": "Visa",
  "priority": "NORMAL", "status": "IN_PROGRESS",
  "customerId": "…", "customerName": "Fatima Al Mansoori", "customerNo": "CUS-000042",
  "requestId": "…", "requestNo": "TE-000123", "assigneeId": "…", "assigneeName": "Omar Khalid",
  "firstResponseDueAt": "2026-10-09T12:00:00.000Z", "resolutionDueAt": "2026-10-11T08:00:00.000Z",
  "firstRespondedAt": "2026-10-09T09:10:00.000Z", "resolvedAt": null, "closedAt": null, "resolutionSummary": null,
  "firstResponseBreached": false, "resolutionBreached": false, "createdAt": "…", "updatedAt": "…",
  "messages": [
    { "id": "…", "authorType": "CUSTOMER", "authorUserId": "…", "authorName": "Fatima Al Mansoori", "visibility": "CUSTOMER",
      "body": "I submitted my documents last week.", "attachments": [{ "documentId": "…", "title": "Passport" }], "createdAt": "…" }
  ],
  "feedback": null
}
```

Feedback summary:

```json
{ "from": "2025-11", "to": "2026-10", "timezone": "Asia/Dubai", "overall": { "count": 3, "average": 3.67 },
  "months": [{ "month": "2026-10", "count": 2, "average": 3.5, "tickets": 1, "requests": 1, "distribution": { "1": 0, "2": 1, "3": 0, "4": 0, "5": 1 } }] }
```

Months are calendar months in the centre's time zone; months without ratings have `count: 0, average: null`.

### Customers and company users (`self.tickets`)

| Method | Path | Body / query | Response |
| --- | --- | --- | --- |
| GET | `/me/tickets` | `page, pageSize, status` | Paged own tickets |
| POST | `/me/tickets` | `{ subject, message, category?, requestId?, attachments?: [documentId] }` | Ticket (requester view) |
| GET | `/me/tickets/:id` | - | Ticket (requester view) |
| POST | `/me/tickets/:id/messages` | `{ body, attachments? }` | Ticket (requester view) |
| GET | `/me/feedback` (`self.tickets` or `self.requests`) | `page, pageSize` | Own ratings; for a company administrator (`corp.requests.read`) the ratings of the company's requests, each with `customerId`, `customerName` |
| POST | `/me/feedback` (`self.tickets` or `self.requests`) | `{ ticketId or requestId, rating: 1-5, comment? }` | `{ id, ticketId, requestId, rating, comment, createdAt }` |

Requester view:

```json
{
  "id": "…", "ticketNo": "TKT-000012", "subject": "Where is my visa?", "category": "Visa", "status": "IN_PROGRESS",
  "requestId": "…", "requestNo": "TE-000123", "resolvedAt": null, "closedAt": null, "resolutionSummary": null,
  "canReply": true, "createdAt": "…", "updatedAt": "…",
  "messages": [
    { "id": "…", "fromSupport": false, "authorKind": "CUSTOMER", "authorName": "Fatima Al Mansoori", "body": "…", "attachments": [], "createdAt": "…" },
    { "id": "…", "fromSupport": true, "authorKind": "STAFF", "authorName": null, "body": "We are checking with the typing team.", "attachments": [], "createdAt": "…" }
  ],
  "feedback": null, "canRate": false
}
```

It never contains internal notes, staff names or ids, priority, assignment or SLA times. `authorKind` is the
role-neutral side of a message: `CUSTOMER` (the person who asked, or their company) with `authorName`, or
`STAFF` (the centre) with `authorName: null` - tickets do not show even the first name of the staff member
who answered (request comments do, see `requests.md`, "Comment authors"). In the centre's own tickets to
TypEase support the two values are `STAFF` (the centre, with the name) and `PLATFORM` (TypEase, no name).
Staff views of customer tickets carry `authorType` as stored plus `authorKind`
(`STAFF` / `CUSTOMER` / `SYSTEM`).

### Centre -> TypEase support (`settings.manage` or `ticket.manage`)

| Method | Path | Body / query | Response |
| --- | --- | --- | --- |
| GET | `/support/platform-tickets` | `page, pageSize, status` | Paged tickets (requester view + `priority`) |
| POST | `/support/platform-tickets` | `{ subject, message, category?, priority = NORMAL }` | Ticket (requester view) |
| GET | `/support/platform-tickets/:id` | - | Ticket (requester view) |
| POST | `/support/platform-tickets/:id/messages` | `{ body }` | Ticket (requester view) |

### TypEase support desk (platform staff, `@Platform('platform.support.manage')`)

| Method | Path | Body / query | Response |
| --- | --- | --- | --- |
| GET | `/platform/support/tickets` | `page, pageSize, sort, q (subject, ticket no., centre name), status, open, tenantId, priority, assignedToMe, unassigned` | Paged platform tickets of all centres |
| GET | `/platform/support/tickets/:id` | - | Ticket with all messages |
| POST | `/platform/support/tickets/:id/messages` | `{ body, visibility = CUSTOMER | INTERNAL, status?: WAITING_CUSTOMER | RESOLVED, resolutionSummary? }` | Ticket |
| PATCH | `/platform/support/tickets/:id` | `{ platformAssigneeId?, priority?, status?, resolutionSummary? }` | Ticket |

Platform view: `{ id, ticketNo, tenant: { id, name, slug, status, plan: { key, name, status } | null }, subject,
category, priority, status, platformAssigneeId, platformAssigneeName, firstRespondedAt, resolvedAt, closedAt,
resolutionSummary, createdAt, updatedAt, messages: [{ id, fromCentre, authorType, authorName, visibility, body, createdAt }] }`.

## Events and jobs

| Kind | Name | Details |
| --- | --- | --- |
| Emitted | `ticket.created` `{ ticketId, customerId?, requestId?, scope }` | Customer and platform tickets. |
| Emitted | `ticket.replied` `{ ticketId, customerId?, authorType, visibility }` | Every message after the first, including internal notes (`visibility: INTERNAL`). The notifications module sends `support.response` to the customer for customer-visible staff replies, and to the centre user who opened a platform ticket when TypEase support replies. Replies by platform staff are written to the outbox with `emitSystem` for the ticket's tenant. |
| Job | `support.sla` (every 10 minutes, all tenants; payload `{ now? }` for tests) | 1. Open customer tickets past a target get one escalation task per breach (`first_response`, `resolution`): task `type = ESCALATION`, `source = ESCALATION`, `roleKey = manager`, `stepKey = sla:<ticketId>:<kind>`, priority HIGH (URGENT for urgent tickets), audit `ticket.sla_breached`. The ticket row is locked while checking, so a breach is escalated once. 2. RESOLVED tickets whose reopen window has passed become CLOSED. |
| Provisioning | tenant step `support.sla_policies` | Creates the four default policies for a centre if they do not exist. |

## Business rules

- **Ticket numbers**: `TKT-000001`, gap-free per centre (`sequences.next(tx, 'ticket')`), shared by both scopes.
- **Who sees what**: customers see tickets of their own customer record and tickets they raised themselves;
  company administrators (no customer record) see the tickets they raised. A ticket can be linked to one of
  the requester's own requests (own customer record, or own company). Anything else is 404.
- **Visibility**: staff messages are `CUSTOMER` (a reply) or `INTERNAL` (a note). Internal notes are never
  returned to the requester, never notify anybody and can still be added to a closed ticket. On platform
  tickets `INTERNAL` notes stay inside the TypEase team and are never returned to the centre.
- **Attachments** are document ids. Customers can attach only their own documents (404 otherwise). A staff
  reply the customer can see may only carry documents that belong to that customer and are customer-visible
  (422 `ATTACHMENT_NOT_SHAREABLE`); internal notes may reference any document of the centre. Platform tickets
  take no attachments.
- **Statuses**: `OPEN -> IN_PROGRESS -> WAITING_CUSTOMER -> RESOLVED -> CLOSED`.
  - Staff changes: OPEN -> IN_PROGRESS | WAITING_CUSTOMER | RESOLVED | CLOSED; IN_PROGRESS -> WAITING_CUSTOMER |
    RESOLVED | CLOSED; WAITING_CUSTOMER -> IN_PROGRESS | RESOLVED | CLOSED; RESOLVED -> IN_PROGRESS (reopen) |
    CLOSED. CLOSED is final. Others: 409 `INVALID_TRANSITION`; same status: 409 `NO_CHANGE`.
  - The first customer-visible staff reply moves OPEN to IN_PROGRESS and sets `firstRespondedAt`. A reply can
    set WAITING_CUSTOMER or RESOLVED in the same call (not together with an internal note: 422
    `STATUS_NEEDS_REPLY`).
  - A requester reply moves WAITING_CUSTOMER to IN_PROGRESS and reopens a RESOLVED ticket within
    `reopenWindowDays` (default 7) of `resolvedAt`. After the window, or on a CLOSED ticket: 409
    `TICKET_CLOSED`. `canReply` tells the portal.
- **SLA** (customer tickets only): targets per priority in calendar minutes (defaults: URGENT 30 min / 8 h,
  HIGH 1 h / 24 h, NORMAL 4 h / 48 h, LOW 8 h / 72 h). `firstResponseDueAt` and `resolutionDueAt` are computed
  when the ticket is opened; changing the priority recomputes them from the opening time. Changing a policy
  does not touch existing tickets. An inactive policy means no targets for new tickets of that priority.
  The clock does not pause while waiting for the customer.
- **Breach flags** on every staff view: `firstResponseBreached` (no reply by the due time, or the reply came
  late) and `resolutionBreached` (not resolved by the due time, or resolved late). `breached=true` lists tickets
  that are still open and past a target.
- **Feedback**: a customer - or an employee signed in to the corporate portal - rates one of their own
  RESOLVED / CLOSED tickets or COMPLETED requests with 1-5 and an optional comment, once (409 `NOT_RESOLVED`,
  `NOT_COMPLETED`, `ALREADY_RATED`). A **company administrator** (`corp.requests.read`) rates any COMPLETED
  request of the company; the rating is stored against the person the request is about (`customerId`), a
  request has one rating whoever gives it, and a request outside the caller's scope is 404. Concurrent
  submissions are serialised with an advisory lock. Tickets opened by a company have no customer record behind
  them and cannot be rated (422 `TICKET_RATING_NOT_AVAILABLE`); a company user without any customer record or
  company gets 403 `NO_CUSTOMER_PROFILE` / `NO_CORPORATE_ACCOUNT`. `canRate` / `feedback` are part of the
  requester's ticket view and of `GET /requests/:id` for customers and company users (requests.md).
- **Platform tickets** never store a customer or request reference and get no SLA targets from the centre's
  policies. The platform desk is the only code in this module that uses the system database connection; every
  query there is restricted to `scope = PLATFORM`, so customer tickets return 404 for platform staff. Platform
  staff see the conversation, the centre's name, status and plan - no customers, requests or documents. Tickets
  can only be assigned to active platform staff (422 `NOT_PLATFORM_STAFF`); the first reply assigns the ticket
  to the replying agent when nobody is assigned.
- **Audit**: `ticket.created`, `ticket.replied`, `ticket.note_added`, `ticket.assigned`, `ticket.updated`,
  `ticket.in_progress | waiting_customer | resolved | closed | reopened`, `ticket.sla_breached`,
  `sla_policy.updated`, `support.settings_updated`, `feedback.submitted`; platform side (system audit entries with
  the ticket's tenant): `platform_ticket.replied | note_added | updated`.
