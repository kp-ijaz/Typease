# Requests module

Service requests ("cases"): creation, drafts, the state machine, assignment, the document checklist, review,
external processing, comments, public tracking and the workflow execution engine.

Code: `services/api/src/modules/requests`. Validation schemas: `packages/validation/src/requests.ts`.
The state machine and the engine are described in `docs/workflows/REQUEST_LIFECYCLE.md`; this document is the
API reference. Base path: `/api/v1`.

## Who sees which requests

| Actor | Sees and can act on |
| --- | --- |
| Staff with `request.read.all` | requests of the branches they are assigned to (all branches when the membership says so) |
| Staff with only `request.read.assigned` | requests where they are the operator or the reviewer |
| Customer | requests of their own customer record |
| Corporate administrator (`corp.requests.read`) | requests billed to their company (`corporateAccountId`) |
| Corporate employee | requests of their own customer record (the company's about them, and their personal ones) |

A request outside the scope answers 404 on every endpoint, as does a request of another centre. Route
permissions only decide who may call an endpoint; the scope and the state machine decide the rest.

What customers and corporate users never receive: internal reasons, internal comments, approvals,
assignments, full staff names (a comment written by staff carries the first name only, see "Comment
authors"), tasks, workflow internals (deadlines, roles, blockers, non-visible steps),
the cancellation reason, notes on external references. Amounts (`finance`) are only returned to actors who
hold `self.payments`, `corp.invoices.read`, `quotation.read`, `invoice.read` or `payment.read`; an employee
in the corporate portal gets the status of the quotation and of the invoices of their own request without
amounts (see "The finance block").

### Who a request is created for

| Caller of `POST /requests` | Subject (`customerId`) | Billed to (`corporateAccountId`) | `source` |
| --- | --- | --- | --- |
| Staff (`request.create`) | `customerId` from the body (required) | `corporateAccountId` from the body, if given; the customer must belong to that company (`422 CUSTOMER_NOT_IN_COMPANY`) | `WALK_IN` |
| Customer | their own record | nobody (personal request) | `ONLINE` / `MOBILE` |
| Corporate administrator (`corp.requests.create`) | the employee named by `corporateEmployeeId`, or the company's own record | their company | `CORPORATE` |
| Corporate employee (`self.requests`) | **their own record, always** | **their company** | `CORPORATE` |

An employee who names anybody else (`corporateEmployeeId` / `customerId` that is not their own) gets
`403 EMPLOYEE_SELF_ONLY`; `422 EMPLOYEE_NOT_ACTIVE` when their employee record was deactivated. A request for a
customer whose data was erased answers `409 CUSTOMER_ERASED`. `renewalOfScheduleId` must be a reminder of the
subject (an administrator or staff may also name a reminder of the company): otherwise 404.

### The finance block (`finance` of `GET /requests/:id`)

```jsonc
// people who may see money: the paying customer, a company administrator, finance-reading staff
{ "amountsHidden": false,
  "quotation": { "id": "…", "quotationNo": "QUO-000012", "status": "SENT", "total": "134.00", "currency": "AED", "validUntil": "2026-10-23T19:59:59.999Z", "sentAt": "2026-10-09T08:12:00.000Z" },
  "invoices": [ { "id": "…", "invoiceNo": "INV-000031", "status": "ISSUED", "currency": "AED", "total": "134.00", "amountPaid": "0.00", "balanceDue": "134.00", "issuedAt": "…", "dueAt": "…" } ],
  "totals": { "invoiced": "134.00", "paid": "0.00", "refunded": "0.00", "balance": "134.00" } }

// an employee signed in to the corporate portal: where things stand, no amounts, no decision
{ "amountsHidden": true,
  "quotation": { "id": "…", "quotationNo": "QUO-000012", "status": "SENT", "validUntil": "…", "sentAt": "…" },
  "invoices": [ { "id": "…", "invoiceNo": "INV-000031", "status": "ISSUED", "issuedAt": "…", "dueAt": "…" } ],
  "totals": null }

// everybody else (e.g. a reviewer without a finance permission): null
```

A draft quotation is never shown to the employee (`quotation: null` until it was sent). The ids are for display
and deep links of people who may open them: for the employee `GET /quotations/:id` and `GET /invoices/:id` are
403.

### Rating a completed request

For customers and company users `GET /requests/:id` also carries
`"feedback": { "rating": 4, "comment": "Quick and clear.", "createdAt": "…" } | null` and `"canRate": true|false`
(`true` = status `COMPLETED` and not rated yet). A request has one rating, whoever gives it - the person it is
about or an administrator of the company: `POST /me/feedback { "requestId": "…", "rating": 1-5, "comment"?: "…" }`
(see support.md).

### Customer references

Wherever a request names its customer (`customer` in the list and in the detail) the object carries
`erased: boolean`. `true` means the person's data was erased on request: `fullName` is the placeholder
"Erased customer" and there are no contact details. See customers.md, "Erased customers".

## Endpoints

### Creation and reading

| Method | Path | Permission (any of) | Purpose |
| --- | --- | --- | --- |
| POST | `/requests` | `request.create`, `self.requests`, `corp.requests.create` | Create a request as `DRAFT` |
| GET | `/requests` | `request.read.all`, `request.read.assigned`, `self.requests`, `corp.requests.read` | List with filters |
| GET | `/requests/counts` | same | Numbers per dashboard bucket for the same scope. Query: `branchId?` |
| GET | `/requests/:id` | same | The full case, shaped for the caller |

**POST /requests**

```json
{ "serviceId": "…", "customerId": "…", "branchId": "…", "priority": "HIGH", "instructions": "Call before submitting",
  "fields": { "purpose": "work" }, "targetDate": "2026-10-20T10:00:00+04:00",
  "corporateAccountId": "…", "corporateEmployeeId": "…", "renewalOfScheduleId": "…" }
```

| Caller | Rules |
| --- | --- |
| Staff | `customerId` required. `branchId` defaults to their branch, else the head office; they must have access to it. `source = WALK_IN`. `corporateAccountId` bills the request to an ACTIVE company the customer belongs to |
| Customer / corporate employee | For themselves (`customerId` in the body is ignored). `source = ONLINE`, or `MOBILE` when signed in through the mobile app. Only services with `onlineAvailable`. Branch: the given one, else the head office if the service is offered there, else the first branch that offers it. `priority` / `targetDate` -> 403 `STAFF_ONLY_FIELD`. Not billed to the company |
| Corporate administrator | `corporateEmployeeId` (an ACTIVE employee of the company), or `customerId` (a record of the company), or neither for the company itself (needs the company's BUSINESS customer profile -> else 422 `COMPANY_PROFILE_MISSING`). `source = CORPORATE`, `corporateAccountId` = their company, which must be ACTIVE |

What creation does: checks that the service is active and offered at the branch and that the customer is
ACTIVE; takes the next request number (`TE-000123`; prefix from `tenant.settings.requestNumberPrefix`);
freezes `serviceSnapshot` (name, code, complianceCapability, requiresApproval, paymentPolicy, depositPercent,
taxMode, estimatedProcessingHours, categoryKey); pins the PUBLISHED form of the service and the PUBLISHED
version of the service's workflow (or of the centre default); builds the checklist from the service
requirements; prefills form fields that declare `prefillFrom` from the customer profile (source `PREFILL`);
stores `fields` (partial values are fine in a draft); links a renewal (`renewalOfScheduleId` must be a
reminder of the same customer or company: sets `renewalOfDocumentId` and the reminder's `renewalRequestId`);
emits `request.created`.

Response (201): the case view (below) plus `reuseCandidates`:

```json
{ "id": "…", "requestNo": "TE-000123", "status": "DRAFT", "…": "…",
  "reuseCandidates": [{ "checklistItemId": "…", "documentId": "…", "documentTypeKey": "passport", "title": "Passport",
                        "expiryDate": "2030-01-01T00:00:00.000Z", "verifiedAt": "…", "linked": false }] }
```

For every checklist line whose requirement has `allowReuse`, the customer's newest AVAILABLE, VERIFIED,
unexpired document of that type (not older than `maxAgeDays`; for a company request also documents of the
company) is offered. It is linked automatically (`linked: true`, line `VERIFIED`) only when the customer has a
GRANTED `DOCUMENT_REUSE` consent; otherwise link it with
`PUT /requests/:id/checklist/:itemId/document`.

**GET /requests** - query parameters (all optional): `page`, `pageSize` (max 100), `sort`
(`createdAt|submittedAt|targetDate|completedAt|updatedAt|requestNo|priority` + `:asc|:desc`, default
`createdAt:desc`), `q` (request number, customer name, customer number, external reference number),
`status` (comma-separated or repeated), `bucket` (`newRequests`, `pendingVerification`, `awaitingCustomer`,
`awaitingPayment`, `readyForProcessing`, `inProgress`, `completedToday`, `overdue`), `branchId`,
`assignedToId` (a membership id or `me`), `customerId`, `corporateAccountId`, `serviceId`, `priority`, `source`,
`createdFrom/To`, `submittedFrom/To`, `completedFrom/To` (`YYYY-MM-DD`, UTC days). Filters narrow the scope;
they can not widen it.

```json
{ "data": [{ "id": "…", "requestNo": "TE-000123", "status": "EXTERNAL_PROCESSING",
             "statusLabel": { "en": "External processing", "ar": "معالجة خارجية" }, "priority": "NORMAL", "source": "WALK_IN",
             "paymentStatus": "PAID", "branchId": "…", "customer": { "id": "…", "customerNo": "CUS-000042", "fullName": "Aisha Khan" },
             "customerName": "Aisha Khan", "service": { "id": "…", "name": "New residence visa", "nameAr": "…", "code": "VISA-NEW" },
             "serviceName": "New residence visa", "assignee": { "membershipId": "…", "name": "Omar" }, "assigneeName": "Omar",
             "targetDate": "…", "overdue": false, "submittedAt": "…", "completedAt": null, "createdAt": "…",
             "externalStatus": { "status": "Under process", "source": "STAFF_ENTERED",
                                 "sourceLabel": { "en": "Entered by staff (not verified by the authority)", "ar": "…" }, "at": "…" } }],
  "meta": { "page": 1, "pageSize": 20, "total": 1, "totalPages": 1 } }
```

`statusLabel` is the customer wording for customers. `assignee` / `assigneeName` are omitted for customers.
`overdue` = open (not draft), with a target date in the past. `completedToday` uses the centre's time zone.

**GET /requests/counts**

```json
{ "buckets": { "newRequests": 3, "pendingVerification": 5, "awaitingCustomer": 2, "awaitingPayment": 1,
               "readyForProcessing": 4, "inProgress": 9, "completedToday": 6, "overdue": 2 },
  "byStatus": { "SUBMITTED": 3, "UNDER_REVIEW": 5 }, "open": 24, "drafts": 7 }
```

**GET /requests/:id** - the case view. It is also the response of every action below.

```json
{ "id": "…", "requestNo": "TE-000123", "status": "IN_PREPARATION", "statusLabel": { "en": "In preparation", "ar": "…" }, "tone": "info",
  "priority": "NORMAL", "source": "WALK_IN", "paymentStatus": "PAID", "version": 9,
  "branch": { "id": "…", "code": "MAIN", "name": "Main Branch" },
  "customer": { "id": "…", "customerNo": "CUS-000042", "fullName": "Aisha Khan", "type": "INDIVIDUAL" },
  "corporateAccount": null,
  "service": { "id": "…", "name": "New residence visa", "code": "VISA-NEW", "complianceCapability": "DIRECT_AUTHORISED",
               "requiresApproval": true, "paymentPolicy": "BEFORE_PROCESSING", "permittedChannels": ["MANUAL_PORTAL", "OFFICIAL_API"] },
  "customerInstructions": null, "submittedAt": "…", "targetDate": "…", "completedAt": null, "cancelledAt": null, "overdue": false,
  "submissionChannel": null, "externalStatus": null,
  "form": { "definitionId": "…", "schema": { "steps": [] }, "values": { "fullName": "Aisha Khan" }, "visibleFields": ["fullName"],
            "fields": [{ "key": "fullName", "value": "Aisha Khan", "source": "PREFILL", "verified": false }] },
  "checklist": [{ "id": "…", "kind": "INPUT", "documentTypeKey": "passport", "label": "Passport copy", "isMandatory": true,
                  "status": "VERIFIED", "note": null, "actionRequired": false,
                  "document": { "id": "…", "title": "Passport", "status": "AVAILABLE", "verificationStatus": "VERIFIED", "expiryDate": "…" } }],
  "externalReferences": [], "comments": [],
  "finance": { "quotation": { "id": "…", "quotationNo": "QUO-000031", "status": "APPROVED", "total": "750.00", "currency": "AED" },
               "invoices": [{ "id": "…", "invoiceNo": "INV-000045", "status": "PAID", "total": "750.00", "amountPaid": "750.00", "balanceDue": "0.00" }],
               "totals": { "invoiced": "750.00", "paid": "750.00", "refunded": "0.00", "balance": "0.00" } },
  "workflow": { "status": "ACTIVE", "currentStepKey": "prepare", "version": 1, "versionId": "…", "definition": { "key": "standard", "name": "…" },
                "steps": [{ "key": "prepare", "name": "Prepare application", "type": "STAFF_TASK", "position": 7, "status": "ACTIVE", "current": true,
                            "attempt": 1, "dueAt": "…", "escalatedAt": null, "assigneeRoleKey": "operator", "waitsFor": "task.completed", "blocked": null }] },
  "allowedActions": {
    "transitions": [{ "to": "PENDING_APPROVAL", "action": "Send for review", "requiresReason": false, "enabled": true },
                    { "to": "READY_TO_SUBMIT", "action": "Mark ready to submit", "requiresReason": false, "enabled": false,
                      "blocked": { "code": "APPROVAL_REQUIRED", "message": "This case requires review approval. Send it for review instead." } }],
    "other": ["edit_fields", "complete_step", "comment_internal", "comment"] },
  "nextStep": { "waitingOn": "CENTRE", "text": { "en": "The application is being prepared.", "ar": "…" },
                "step": { "key": "prepare", "name": "Prepare application", "type": "STAFF_TASK", "waitsFor": "task.completed", "dueAt": "…", "blocked": null } },
  "assignee": { "membershipId": "…", "name": "Omar", "roleKey": "operator" }, "reviewer": null,
  "history": [{ "id": "…", "from": "READY_FOR_PROCESSING", "to": "IN_PREPARATION", "actorType": "STAFF", "actorName": "Omar",
                "reason": null, "customerVisible": true, "customerMessage": "Being prepared", "meta": { "seq": 7, "via": "CONTEXT" }, "at": "…" }],
  "assignments": [], "approvals": [] }
```

- `allowedActions.transitions`: the edges the **current actor** may use from the current status, each with the
  guard verdict. Show a button per entry; disable it and show `blocked.message` when `enabled` is false.
  `allowedActions.other`: further things the actor can do now (`edit_fields`, `edit_details`, `assign`,
  `auto_assign`, `manage_checklist`, `waive_checklist_item`, `upload_documents`, `resubmit`, `decide_approval`,
  `complete_step`, `record_submission`, `update_external_status`, `record_external_result`, `mark_duplicate`,
  `migrate_workflow`, `comment`, `comment_internal`).
- `nextStep`: what happens next in plain words (`waitingOn`: `CUSTOMER`, `CENTRE`, `AUTHORITY`, `NOBODY`);
  staff also get the current workflow step and why it is blocked.
- Customers get `history` as `[{ id, status, statusLabel, message, at }]` (customer-visible entries only),
  `workflow` as `{ status, currentStepKey, steps: [{ key, name, nameAr, type, position, status, current, startedAt, completedAt }] }`
  (customer-visible steps only), and none of `assignee`, `reviewer`, `assignments`, `approvals`,
  `cancellationReason`, `duplicateOfId`, `reopenedCount`, `workflowVersionId`.
- `checklist[].note`: why a document was rejected, or (staff only) why a line was waived.
  `actionRequired`: the line the customer has to fix while the request is `AWAITING_CUSTOMER`.

### Drafts

| Method | Path | Permission (any of) | Purpose |
| --- | --- | --- | --- |
| PATCH | `/requests/:id` | `request.update`, `self.requests`, `corp.requests.create` | `{ instructions?, priority?, targetDate?, version? }`. Priority and target date are staff only. Customers: only while `DRAFT` / `AWAITING_CUSTOMER`. Audited with before / after |
| PUT | `/requests/:id/fields` | `request.update`, `request.process`, `request.create`, `self.requests`, `corp.requests.create` | `{ values: { key: value } }`; `null` clears a value |
| POST | `/requests/:id/submit` | `request.create`, `request.update`, `self.requests`, `corp.requests.create` | `DRAFT -> SUBMITTED` |

Form values are validated on the server against the pinned form schema (required, types, options, min / max,
pattern, `showIf`). While the request is a `DRAFT` only the values that are sent are checked, so a draft can be
saved half-filled and continued on another device. After submission the whole form must stay valid on every
save. Customers can edit only while `DRAFT` or `AWAITING_CUSTOMER`; staff until the request is closed
(`request.create` alone is enough only for drafts). The audit trail records which fields were saved, not their
values.

`submit` validates the form (422 `FORM_INVALID` with `details: [{ field, code, message }]`), checks and counts
the plan limit `monthlyRequests` (402 `PLAN_LIMIT_REACHED`), sets `submittedAt` and `targetDate` (a date set by
staff is kept; else service `estimatedProcessingHours`, else `tenant.settings.defaultTargetHours`, else 72 h),
starts the workflow execution, emits `request.submitted` and, when `tenant.settings.autoAssign` is true,
assigns an operator. The response is the case view plus **`trackingCode`** (e.g. `K7MQP-X2RTD`). It is shown
this one time; only its SHA-256 is stored.

### Status changes

| Method | Path | Permission (any of) | Purpose |
| --- | --- | --- | --- |
| POST | `/requests/:id/transition` | any request permission; the edge decides | `{ to, reason?, customerMessage?, version? }`: any edge of the state machine |
| POST | `/requests/:id/cancel` | `request.cancel`, `self.requests`, `corp.requests.create` | `{ reason }` (3-500 characters) |
| POST | `/requests/:id/reopen` | `request.reopen` | `{ reason }`: `COMPLETED -> IN_PREPARATION`, increments `reopenedCount`, restarts the workflow at the preparation step |
| POST | `/requests/:id/complete` | `request.review`, `request.reopen` | `FINAL_REVIEW -> COMPLETED` |
| POST | `/requests/:id/mark-duplicate` | `request.cancel` | `{ duplicateOfId }`: sets `duplicateOfId` and cancels with the reason "Duplicate of TE-…" |

Errors of every status change:

| HTTP | Code | Meaning |
| --- | --- | --- |
| 409 | `INVALID_TRANSITION` | "A request cannot go from X to Y." - the pair is not in the transition table |
| 403 | `FORBIDDEN` | The actor lacks the permission of the edge / the step is done by the centre |
| 403 | `TRANSITION_NOT_ALLOWED` | The edge is reserved for the system and can not be triggered by hand |
| 403 | `CANCELLATION_NOT_ALLOWED` | A customer tries to cancel a request that is already released for processing |
| 409 | `STALE_VERSION` | `version` does not match (`details.currentVersion`) |
| 422 | `REASON_REQUIRED` | The edge needs a reason |
| 422 / 403 / 402 | guard codes | See the guard table in `docs/workflows/REQUEST_LIFECYCLE.md`, section 4 |

Cancelling never refunds. When money is held for the request, the history `meta` and the `request.cancelled`
event carry `refundReviewNeeded: true` and `amountHeld`.

### Working with the customer

| Method | Path | Permission (any of) | Purpose |
| --- | --- | --- | --- |
| POST | `/requests/:id/request-information` | `document.verify`, `request.process`, `request.update` | `{ message, checklistItemIds?, addItems?: [{ documentTypeKey, label, labelAr?, isMandatory }] }` -> `AWAITING_CUSTOMER`. `message` is shown to the customer; `addItems` become new checklist lines |
| POST | `/requests/:id/resubmit` | `document.verify`, `request.update`, `request.process`, `self.requests`, `corp.requests.create` | `{ note? }`: back to `UNDER_REVIEW`, or to `IN_PREPARATION` when the question was asked during preparation or after a return |
| GET | `/requests/:id/comments` | read permissions | Customers and staff without `request.comment.internal` get customer-visible comments only |
| POST | `/requests/:id/comments` | `request.comment.internal`, `request.update`, `request.process`, `request.review`, `self.requests`, `corp.requests.read` | `{ body, visibility: INTERNAL \| CUSTOMER }` (staff default: `INTERNAL`). Customers always write `CUSTOMER` comments. `INTERNAL` needs `request.comment.internal`; a staff `CUSTOMER` comment needs `request.update`, `request.process` or `request.review` |

**Comment authors.** A comment is
`{ id, authorType, authorKind, authorName, body, visibility, createdAt }` in `GET /requests/:id/comments`, in
`comments` of `GET /requests/:id` and in the answer of `POST /requests/:id/comments`.

| Reader | `authorType` | `authorKind` | `authorName` |
| --- | --- | --- | --- |
| Staff (and a support session) | as stored: `STAFF`, `CUSTOMER`, `CORPORATE`, `PLATFORM`, `SYSTEM`, `AUTOMATION` | `STAFF` (staff, TypEase support), `CUSTOMER` (customer, company user), `SYSTEM` (system, automation) | as stored: the full name (`"Noura Khalid Al Suwaidi"`, `"Sara Ahmad (TypEase support)"`, `"automation:<rule>"`) |
| Customer / company user | the same value as `authorKind` for staff-side authors (`STAFF` or `SYSTEM`); their own side unchanged (`CUSTOMER` / `CORPORATE`) | the same three values | staff: the **first name only** (`"Noura"`; `"Dr. Abdul Rahman Al Farsi"` -> `"Abdul Rahman"`); system / automation: `null`; their own side: the full name |

Customers therefore never receive a staff member's family name, title or role, nor whether an answer came from
TypEase support or an automation. The stored comment keeps the full name. The rule is one function
(`presentAuthor` in `services/api/src/common/author-display.ts`); portals should label a `STAFF` comment with
`authorName` when present and with the centre's name otherwise.


`resubmit` is refused with 422 `REJECTED_DOCUMENTS_PENDING` while a rejected document has not been replaced
(a new upload of that type replaces it), unlinked or waived. Nothing moves in the workflow while the request
is `AWAITING_CUSTOMER`.

### Assignment

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| POST | `/requests/:id/assign` | `request.assign` | `{ assigneeMembershipId, role: OPERATOR \| REVIEWER, reason? }` |
| POST | `/requests/:id/auto-assign` | `request.assign` | Chooses the best available operator; the response adds `autoAssignment: { chosen, considered }` |

The assignee must be an ACTIVE staff member with access to the request's branch whose role holds
`request.process` (operator) or `request.review` (reviewer): otherwise 422 `ASSIGNEE_NOT_ACTIVE`,
`ASSIGNEE_NOT_AT_BRANCH`, `ASSIGNEE_ROLE_NOT_SUITABLE`. Replacing an assignee needs a `reason`
(422 `REASON_REQUIRED`). The same person can not be operator and reviewer of one case
(409 `SEGREGATION_OF_DUTIES`). Assigning closes the previous `request_assignments` row, updates
`assignedToId` / `reviewerId`, moves open workflow tasks, is audited and emits `request.assigned`.

Automatic assignment (endpoint, and at submission when `tenant.settings.autoAssign` is true): candidates are
ACTIVE, available (`isAvailable`) staff with branch access whose role may process requests - limited to the
service's `staffGroupRoleKey` when it has one - excluding the case's reviewer. Order: staff with a
`staff_skills` row for the service; then staff on shift now (or without any schedule) before staff who are
scheduled but off; then the lowest weighted number of open assigned requests (URGENT 3, HIGH 2, others 1);
then membership id. No candidate: 422 `NO_ASSIGNEE_AVAILABLE` on the endpoint; at submission the request
simply stays unassigned. The method is recorded as `AUTO`.

### Checklist

| Method | Path | Permission (any of) | Purpose |
| --- | --- | --- | --- |
| POST | `/requests/:id/checklist` | `request.update`, `request.process`, `document.verify` | `{ documentTypeKey, label, labelAr?, isMandatory, kind: INPUT \| COMPLETION }`. `COMPLETION` lines need `request.process` |
| POST | `/requests/:id/checklist/:itemId/waive` | `document.verify` | `{ reason }`: the line counts as satisfied |
| PUT | `/requests/:id/checklist/:itemId/document` | `request.update`, `request.process`, `request.create`, `document.verify`, `self.requests`, `corp.requests.create` | `{ documentId }`: link an existing document |
| DELETE | `/requests/:id/checklist/:itemId/document` | same | Unlink; the line becomes `MISSING` |

A document can be linked when it belongs to the same customer, to the request's company or to this request,
is `AVAILABLE`, not rejected and not expired (404 / 422 `DOCUMENT_NOT_AVAILABLE`, `DOCUMENT_REJECTED`,
`DOCUMENT_EXPIRED`). A verified document makes an input line `VERIFIED` at once, otherwise `UPLOADED`.
Customers can link and unlink input lines only while the request is `DRAFT`, `SUBMITTED`,
`AWAITING_CUSTOMER` or `UNDER_REVIEW`, and never a line that is already `VERIFIED` or `WAIVED`
(409 `DOCUMENT_ALREADY_ACCEPTED`). Completion lines are for staff with `request.process`.

Uploads themselves belong to the documents module. The checklist follows its events: `document.uploaded`
fills the line named by `checklistItemId`, or the first `MISSING` (then `REJECTED`) line of that document
type; `document.verified` / `document.rejected` update every line that uses the document.

### Review

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| POST | `/requests/:id/approvals/:approvalId/decide` | `request.review` | `{ decision: APPROVED \| REJECTED, comment }` (comment mandatory for `REJECTED`) |

`APPROVED` -> `READY_TO_SUBMIT`; `REJECTED` -> `IN_PREPARATION` with the comment as internal reason (not shown
to the customer) and the workflow back at the preparation step. The user of the request's operator can not
decide (403 `SEGREGATION_OF_DUTIES`). A decided review can not be decided again (409 `ALREADY_DECIDED`).
The pending review row is created whenever a request enters `PENDING_APPROVAL`.

### External processing

| Method | Path | Permission (any of) | Purpose |
| --- | --- | --- | --- |
| GET | `/requests/:id/external-references` | read permissions | References with status, source and source label |
| POST | `/requests/:id/external-references` | `request.submit_external` | `{ channel, authorityName?, referenceNo, partnerName?, partnerReference?, notes? }`: `READY_TO_SUBMIT -> EXTERNAL_PROCESSING`. While already in external processing it adds a further reference |
| PATCH | `/requests/:id/external-references/:refId` | `request.submit_external`, `request.process` | `{ status?, notes? }` |
| POST | `/requests/:id/external-result` | `request.process` | `{ outcome: COMPLETED \| RETURNED \| REJECTED, note }` (note mandatory unless `COMPLETED`) -> `FINAL_REVIEW` / `RETURNED` / `REJECTED` |

| HTTP | Code | When |
| --- | --- | --- |
| 422 | `SUBMISSION_NOT_PERMITTED` | The service is preparation-only or informational: the customer submits |
| 422 | `CHANNEL_NOT_PERMITTED` | The channel is not allowed for the service's capability (`details.permitted`) |
| 422 | `PARTNER_NAME_REQUIRED` | `AUTHORISED_PARTNER` without `partnerName` |
| 422 | `OFFICIAL_INTEGRATION_NOT_AVAILABLE` | `OFFICIAL_API` without a verified, active government integration and a registered adapter |
| 422 | `USE_RESULT_ACTION` | A status update that is really a final outcome (`completed`, `returned`, `rejected`) |
| 409 | `RESULT_ALREADY_RECORDED` | Updating the status of a submission whose result is recorded |
| 400 | `VALIDATION_FAILED` | Any extra field, e.g. `statusSource`: the bodies are strict |

Every external status in every response comes with `statusSource` and its label
(`sourceLabel` / `statusSourceLabel`), so a status typed by staff is never presented as official:

```json
{ "id": "…", "channel": "MANUAL_PORTAL", "authorityName": "GDRFA Dubai", "referenceNo": "GD-2026-000123",
  "status": "Under process at the authority", "statusSource": "STAFF_ENTERED",
  "statusSourceLabel": { "en": "Entered by staff (not verified by the authority)", "ar": "أدخلها الموظف (غير مؤكدة من الجهة)" },
  "result": null, "recordedAt": "…", "partnerName": null, "partnerReference": null, "integrationId": null, "notes": null }
```

The source is derived on the server: `PARTNER_PROVIDED` for partner references, `STAFF_ENTERED` otherwise.
`VERIFIED_OFFICIAL` can only come from an `OfficialSubmissionPort` adapter; none is part of this code base
(see `docs/workflows/REQUEST_LIFECYCLE.md`, section 8). The newest reference is mirrored on the request
(`externalStatus`).

### Workflow

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| POST | `/requests/:id/workflow/complete-step` | `request.process` | `{ stepKey?, note? }`: "preparation done". Completes the active staff task; the workflow decides what follows (review, submission, the next task, final review). 409 `STEP_NOT_ACTIVE` when no staff task is waiting |
| POST | `/requests/:id/workflow/migrate` | `workflow.manage` | Move this one case to the published version of its workflow. Response adds `migration: { fromVersion, toVersion, currentStepKey }`. 409 `ALREADY_CURRENT`, `STEP_NOT_IN_TARGET`, `REQUEST_CLOSED`, `WORKFLOW_NOT_PUBLISHED` |

### Public tracking

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| POST | `/public/track` | public, rate limited: 10 per 15 minutes per IP and request number | `{ tenantSlug?, requestNo, trackingCode }` |

The centre is taken from `tenantSlug`, else from the host the portal is served on.

```json
{ "requestNo": "TE-000123", "service": { "name": "New residence visa", "nameAr": "…" },
  "status": "EXTERNAL_PROCESSING", "statusLabel": { "en": "Submitted — in processing", "ar": "تم التقديم — قيد المعالجة" },
  "submittedAt": "…", "completedAt": null,
  "timeline": [{ "status": "SUBMITTED", "statusLabel": { "en": "Submitted", "ar": "تم الإرسال" }, "at": "…" }],
  "externalStatus": { "status": "Under process", "source": "STAFF_ENTERED",
                      "sourceLabel": { "en": "Entered by staff (not verified by the authority)", "ar": "…" }, "at": "…" } }
```

No names, documents, amounts, messages, reference numbers or staff. A wrong code, an unknown number, another
centre and a draft all answer the same 404 `NOT_FOUND` ("Request was not found.").

## Events

Emitted (inside the business transaction):

| Event | When | Payload |
| --- | --- | --- |
| `request.created` | a draft is created | `{ requestId, requestNo, customerId, serviceId, branchId, source }` |
| `request.submitted` | `DRAFT -> SUBMITTED` | `{ requestId, customerId }` |
| `request.status_changed` | every status change | `{ requestId, requestNo, customerId, from, to, customerVisible, customerMessage, reason? }`. A workflow notification step emits it with `from = to`, `informational: true` and `stepKey` |
| `request.information_requested` | `-> AWAITING_CUSTOMER` | `{ requestId, customerId, message }` |
| `request.completed` | `-> COMPLETED` | `{ requestId, customerId }` |
| `request.cancelled` | `-> CANCELLED` | `{ requestId, customerId, reason?, refundReviewNeeded, amountHeld? }` |
| `request.assigned` | assignment | `{ requestId, requestNo, customerId, assigneeMembershipId, assigneeUserId, role, method }` |
| `request.step_overdue` | job `workflows.scan` | `{ requestId, requestNo, customerId, stepKey, stepName, escalateToRoleKey }` |
| `request.overdue` | job `workflows.scan` | `{ requestId, requestNo, customerId, assigneeUserId? }` |

Consumed (in the emitting module's transaction, each reaction in its own savepoint):
`document.uploaded`, `document.verified`, `document.rejected`, `quotation.sent`, `quotation.approved`,
`quotation.rejected`, `invoice.issued`, `invoice.voided`, `creditnote.issued`, `payment.completed`,
`refund.completed`. See
`docs/workflows/REQUEST_LIFECYCLE.md`, section 6.

## Background jobs

| Job | Schedule | What it does |
| --- | --- | --- |
| `workflows.scan` | every 5 minutes, all operational centres | Escalates workflow steps past their time limit, flags requests past their target date and sends `QUOTED` requests whose quotation expired back to the quotation step. Idempotent |
| `workflows.advance` | queued when a reaction to another module's event failed | `{ tenantId, requestId }`: recomputes the payment status and advances the workflow. Idempotent |

## Tables

Written by this module: `service_requests`, `request_fields`, `request_documents`, `request_status_history`
(append-only), `request_assignments`, `request_approvals`, `request_comments`, `request_external_references`,
`workflow_executions`, `workflow_step_executions`; `tasks` and `task_assignments` rows with
`source = 'WORKFLOW'` or `'ESCALATION'`; `reminder_schedules.renewalRequestId`.

Read only: services, service requirements, forms, customers, consents, corporate accounts and employees,
documents, quotations, invoices, integrations, memberships, roles, schedules, skills, branches.

`service_requests.paymentStatus` is derived from the request's issued invoices: no invoice `UNPAID`; nothing
to pay `NOT_REQUIRED`; any refund `PARTIALLY_REFUNDED` / `REFUNDED`; zero balance `PAID`; something paid
`PARTIALLY_PAID`; else `UNPAID`. It is recomputed in the finance transaction on every event that changes an
invoice of the request: `invoice.issued`, `invoice.voided`, `creditnote.issued`, `payment.completed`,
`refund.completed` - for closed requests too (only open ones are advanced). A voided invoice does not count; a
credit note lowers what was invoiced (a fully credited, unpaid request is `NOT_REQUIRED`).

`request_documents.rejectionReason` holds the rejection reason of a rejected line and the waiver reason of a
waived line (exposed as `note`).

## Adding an official integration

`OFFICIAL_API` stays unavailable until a deployment registers an adapter:

1. The centre records its authorisation as an integration of category `GOVERNMENT` (an authorisation record:
   authority, reference, validity, who holds the portal account) and a person at the operator verifies it
   (`authorisationVerifiedAt`). This record **cannot hold credentials** (`secretFields: []`, see
   [integrations.md](integrations.md), section 4). An adapter would need its own, new provider definition
   with secret fields for the authority-issued API credentials, written when the authority's API access and
   its terms exist.
2. A module of that deployment implements the abstract `OfficialSubmissionPort`
   (`services/api/src/modules/requests/official-submission.port.ts`): `providers`, `confirmSubmission`,
   `fetchStatus`, against the authority's documented API, and provides it in a `@Global()` module.
3. Statuses returned by the adapter are stored as `VERIFIED_OFFICIAL`
   (`ExternalProcessingService.refreshOfficialStatus` for later updates). Anything typed by a person is
   relabelled `STAFF_ENTERED`.

An adapter must never scrape a portal, solve a CAPTCHA, intercept an OTP or invent a reference or status.
