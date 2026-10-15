# Automation

Module folder: `services/api/src/modules/automation`. Tables: `automation_rules`, `automation_executions`. All paths
are under `/api/v1`.

A rule is: one trigger event, optional conditions, an ordered list of actions. When the event happens and the
conditions hold, the engine runs the actions as the `AUTOMATION` actor. Actions never write the tables of other
modules: each calls the service of the module that owns the data, so that module's rules (state machine and its
guards, consent, plan limits, audit) apply to automations exactly as they apply to people.

## Endpoints

Every route needs `automation.manage` (owners and managers by default). There is no tenant parameter.

| Method | Path | Plan feature `automation` | Body / query | Response |
| --- | --- | --- | --- | --- |
| GET | `/automations` | - | `page`, `pageSize`, `q?`, `triggerEvent?`, `enabled?=true\|false` | Paged rules with execution counters |
| GET | `/automations/meta` | - | - | Triggers with their facts and variables, action types, statuses an automation may set, webhook configuration state |
| GET | `/automations/templates` | - | - | `{ available, templates: [...] }` |
| POST | `/automations/from-template/:key` | required | `{ name? }` | The new rule (always DISABLED) + `problems` |
| GET | `/automations/summary` | - | - | Counters: rules, executions by status (24 h, 7 days, all time), open dead letters |
| GET | `/automations/executions` | - | `page`, `pageSize`, `ruleId?`, `status?`, `eventType?`, `from?`, `to?` (UTC days) | Paged execution log |
| GET | `/automations/executions/:id` | - | - | One execution with the configuration, output and error of every action |
| POST | `/automations/executions/:id/retry` | required | - | The execution, queued again |
| POST | `/automations` | required | rule (below) | Rule + `problems` |
| GET | `/automations/:id` | - | - | Rule + `stats` + `problems` |
| PATCH | `/automations/:id` | - | any of `name, description, triggerEvent, conditions, actions, maxRetries` | Rule + `problems` |
| DELETE | `/automations/:id` | - | - | `{ "status": "DELETED" }` (its execution log is deleted with it) |
| POST | `/automations/:id/enable` | required | - | Rule + `problems` (always empty: a rule with a finding is not switched on) |
| POST | `/automations/:id/disable` | - | - | Rule + `problems` |
| POST | `/automations/:id/test` | - | `{ eventId? }` | Dry run (nothing is executed) |

Without the plan feature the answer is 402 `PLAN_LIMIT_REACHED` with `details.limit = "automation"`.

### Rule

```json
POST /automations
{
  "name": "Urgent golden visas to the manager",
  "description": "Tell managers about urgent requests",
  "triggerEvent": "request.submitted",
  "conditions": { "all": [{ "fact": "request.priority", "op": "in", "value": ["HIGH", "URGENT"] }], "any": [{ "fact": "service.code", "op": "eq", "value": "GOLDEN-VISA" }] },
  "actions": [
    { "type": "create_task", "config": { "title": "Urgent: {{requestNumber}} for {{customerName}}", "priority": "HIGH", "roleKey": "manager", "dueInHours": 4 } },
    { "type": "send_notification", "config": { "to": "ROLE", "roleKey": "manager", "channels": ["IN_APP"], "subject": "Urgent: {{requestNumber}}", "body": "{{customerName}} needs {{serviceName}} urgently.\n\n[Open the request]({{centreLink}})" } }
  ],
  "isEnabled": false,
  "maxRetries": 3
}
```

```json
{
  "id": "…", "name": "Urgent golden visas to the manager", "description": "Tell managers about urgent requests", "templateKey": null,
  "triggerEvent": "request.submitted", "triggerLabel": "A request was submitted for processing",
  "conditions": { "all": [{ "fact": "request.priority", "op": "in", "value": ["HIGH", "URGENT"] }], "any": [{ "fact": "service.code", "op": "eq", "value": "GOLDEN-VISA" }] },
  "actions": [{ "type": "create_task", "label": "Create task", "config": { "title": "Urgent: {{requestNumber}} for {{customerName}}", "priority": "HIGH", "type": "GENERAL", "roleKey": "manager", "dueInHours": 4 } }, { "type": "send_notification", "label": "Send notification", "config": { "to": "ROLE", "roleKey": "manager", "channels": ["IN_APP"], "subject": "Urgent: {{requestNumber}}", "body": "…", "purpose": "SERVICE" } }],
  "isEnabled": false, "maxRetries": 3, "createdById": "…", "createdAt": "…", "updatedAt": "…",
  "problems": []
}
```

- `triggerEvent`: one of `customer.created, request.created, request.submitted, document.uploaded,
  document.verified, quotation.approved, payment.completed, request.assigned, request.status_changed,
  request.completed, request.overdue, request.step_overdue, document.expiring, appointment.created,
  subscription.renewal_due`.
- `conditions`: the rule language of workflows, `{ all?: [...], any?: [...] }` with `{ fact, op, value }`; `all`
  must all hold and, when present, at least one of `any`. Operators: `eq, neq, in, nin, gt, gte, lt, lte, exists,
  truthy`. Empty = always.
- `actions`: 1 to 10, executed in order. `isEnabled` defaults to `false`; `maxRetries` 0-10, default 3.
- In lists and `GET /automations/:id` a rule also carries
  `stats: { total, succeeded, failed, deadLetter, lastExecutionAt }`.

Validation happens in two steps. The shape (400 `VALIDATION_FAILED`): known trigger, known action types, the
configuration of each action against the schema of its type (unknown keys are rejected). Then the meaning (422
`INVALID_AUTOMATION` with `details.problems: [{ path, code, message }]`), see "What a rule may refer to" below.

### `problems` on a rule

Every answer that carries one rule (create, from-template, read, update, enable, disable) has
`problems: [{ path, code, message }]`: the findings of the same checks that decide whether the rule may be switched
on, evaluated at the time of the answer. `path` points into the rule (`conditions.all.0`, `actions.1`,
`actions.1.config.roleKey`), `message` is written for the owner. An empty list means "this rule can be switched
on". The list of `GET /automations` does not carry it.

| Kind of finding | Saving a rule that is switched off | Saving a rule that is (to be) switched on | Read / disable |
| --- | --- | --- | --- |
| Wrong definition (unknown fact, role, staff member, document type, variable, refused webhook URL, ...) | 422 | 422 | shown (the reference went stale after the rule was saved) |
| Not ready to run (`NOT_CONFIGURED`: no n8n address for a webhook `path`, or no signing secret; `CREDENTIALS_UNREADABLE`) | saved, finding returned in `problems` | 422 | shown |

A definition finding hides the "not ready to run" findings until it is repaired. `POST /automations/:id/enable`
answers 422 with exactly the list the rule showed before. A rule that is switched on and whose n8n connection was
removed afterwards shows the finding on read; it cannot be changed (422) until the connection is back or the rule
is switched off.

### Facts and variables per trigger

`GET /automations/meta` returns them per trigger (with labels, types and the closed lists of values). Summary:

| Fact group | Facts | Triggers |
| --- | --- | --- |
| Event | `event.type`, `event.actorType` (`STAFF, CUSTOMER, CORPORATE, PLATFORM, SYSTEM`) | all |
| Customer | `customer.type`, `customer.isCorporate` | all except `subscription.renewal_due` |
| | `customer.source` | `customer.created` |
| Request | `request.status`, `request.priority`, `request.source`, `request.paymentStatus`, `request.isAssigned`, `request.isOverdue`, `service.code`, `service.categoryKey`, `service.requiresApproval`, `service.complianceCapability`, `service.paymentPolicy`, `branch.code`, `assignee.roleKey` | all `request.*` triggers, `quotation.approved`, `payment.completed`, `document.uploaded`, `document.verified` (empty when the event has no request) |
| Status change | `status.from`, `status.to`, `status.customerVisible` | `request.status_changed` |
| Assignment | `assignment.role`, `assignment.method` | `request.assigned` |
| Step | `step.key`, `step.escalateToRoleKey` | `request.step_overdue` |
| Document | `document.typeKey`, `document.uploadedByType`, `document.generated`, `document.hasExpiry` | `document.uploaded`, `document.verified` |
| Expiry | `document.typeKey`, `expiry.daysLeft`, `expiry.offsetDays` | `document.expiring` |
| Quotation | `quotation.total`, `quotation.approvedByType` | `quotation.approved` |
| Payment | `payment.amount`, `payment.method`, `payment.currency` | `payment.completed` |
| Branch | `branch.code` | `appointment.created` |
| Subscription | `subscription.amount`, `subscription.currency`, `subscription.planKey` | `subscription.renewal_due` |

Variables for texts (`{{name}}`; unknown variables render empty, values are inserted once and never interpreted):
`centreName, supportEmail, supportPhone, centreLink, portalLink` (not for `subscription.renewal_due`),
`customerName`, the request variables `requestNumber, serviceName, statusLabel, branchName, assigneeName,
targetDate`, and per trigger `previousStatusLabel`, `stepName`, `documentName`, `expiryDate`, `daysLeft`,
`amount`, `currency`, `paymentMethod`, `appointmentDate`, `appointmentTime`, `planName`, `dueDate`.
A link is written `[Label]({{centreLink}})`; links are recognised in the text of the rule only, never in values.

### Actions

| Type | Configuration | What it does | Through |
| --- | --- | --- | --- |
| `create_task` | `title`, `description?`, `priority = NORMAL`, `type = GENERAL \| DOCUMENT_REVIEW \| APPROVAL`, `roleKey?`, `dueInHours?` | A task (source `AUTOMATION`) linked to the request / customer / branch of the event, in the queue of the role | tasks module |
| `create_follow_up` | `title`, `description?`, `priority`, `roleKey?`, `dueInDays = 2` | A task of type `FOLLOW_UP`, due that many days later | tasks module |
| `assign_staff` | `{ mode: "AUTO" }` or `{ mode: "MEMBER", membershipId, role = OPERATOR \| REVIEWER }` | Assigns the request: the best available operator (skills, shift, workload) or a named member. Fills an empty seat only; a request that already has someone is left alone (`SKIPPED`) | requests assignment service |
| `send_notification` | `to: CUSTOMER \| ASSIGNEE \| ROLE`, `roleKey?`, `channels: [EMAIL, SMS, WHATSAPP, IN_APP, PUSH]`, `subject?` (needed for email, in-app, push), `body`, `purpose = SERVICE \| MARKETING`, `whatsappTemplateName?` | A message written by the centre to the customer, the operator of the request, or every active holder of a role (for a request: those working at its branch) | notifications module (`sendCustom`) |
| `schedule_reminder` | `documentTypeKey?`, `expiryInDays?`, `offsetsDays?`, `subjectLabel?` | An expiry reminder schedule for the customer or company. Document type and expiry date come from the event's document, or from the configuration. An existing open reminder counts as success | reminders module |
| `generate_document` | `title?`, `documentTypeKey = other`, `customerVisible = false` | The summary PDF of the request (fields not marked sensitive, checklist), stored with the request | `DocumentStorePort` |
| `update_workflow_state` | `to`, `reason?`, `customerMessage?` | Moves the request to another status | `RequestStateMachine.transition` |
| `request_approval` | `note?` | "Preparation done": the workflow sends the request for internal review | requests workflow engine |
| `escalate` | `roleKey = manager`, `title?`, `message?`, `priority = HIGH \| URGENT`, `dueInHours?` | An `ESCALATION` task for the role and an in-app alert to its holders | tasks + notifications modules |
| `call_webhook` | `{ path }` (below the n8n address) or `{ url }` (complete URL on an approved host) | A signed HTTPS POST | see "Webhooks" |

### Execution

```json
GET /automations/executions/…
{
  "id": "…", "ruleId": "…", "ruleName": "Task then n8n", "eventId": "…", "eventType": "request.submitted", "eventLabel": "A request was submitted for processing",
  "status": "DEAD_LETTER", "attempts": 3, "error": "Step 2 (Call n8n / webhook): The webhook answered with HTTP 500.",
  "startedAt": "…", "finishedAt": "…", "createdAt": "…", "maxRetries": 2, "canRetry": true,
  "event": { "occurredAt": "…", "data": { "requestId": "…", "customerId": "…" } },
  "actions": [
    { "index": 0, "type": "create_task", "label": "Create task", "status": "SUCCEEDED", "attempts": 1, "finishedAt": "…", "config": { "title": "Once only {{requestNumber}}", "priority": "NORMAL", "type": "GENERAL" }, "output": { "taskId": "…", "title": "Once only TE-000123" }, "error": null },
    { "index": 1, "type": "call_webhook", "label": "Call n8n / webhook", "status": "FAILED", "attempts": 3, "finishedAt": "…", "config": { "path": "/down" }, "output": null, "error": { "code": "WEBHOOK_HTTP_500", "message": "The webhook answered with HTTP 500.", "retryable": true } }
  ]
}
```

Execution `status`: `PENDING, RUNNING, SUCCEEDED, FAILED` (a retry is scheduled), `SKIPPED` (the rule was switched
off or the plan lost before it ran), `DEAD_LETTER`. Action `status`: `PENDING, SUCCEEDED, SKIPPED` (nothing to act
on, e.g. the event has no request), `FAILED`. The list (`GET /automations/executions`) carries the same rows
without `config`, `output` and `error` per action. `event.data` shows identifiers and status values only.

### Dry run

`POST /automations/:id/test` evaluates the rule against a real event of its trigger - the one named by `eventId`,
otherwise the most recent one - and returns what would happen:

```json
{
  "dryRun": true, "rule": { "id": "…", "name": "Urgent handling", "isEnabled": false },
  "event": { "id": "…", "type": "request.submitted", "label": "A request was submitted for processing", "occurredAt": "…", "causedByAutomation": false, "data": { "requestId": "…", "customerId": "…" } },
  "facts": { "event.type": "request.submitted", "request.priority": "URGENT", "service.code": "GOLDEN-VISA" },
  "conditions": [{ "group": "all", "fact": "request.priority", "label": "Priority of the request", "op": "eq", "value": "URGENT", "actual": "URGENT", "passed": true }],
  "conditionsMet": true, "wouldRun": false, "notes": ["The automation is switched off."],
  "actions": [{ "index": 0, "type": "create_task", "label": "Create task", "config": { "…": "…" }, "applicable": true, "preview": { "title": "Call Omar Haddad about TE-000123", "description": null, "queue": "receptionist", "requestNumber": "TE-000123" } }]
}
```

Nothing is executed, nothing is written and no execution row is created. `actions` is empty when the conditions
are not met. 422 `NO_RECENT_EVENT` when the centre has no such event yet; 422 `EVENT_TYPE_MISMATCH` when
`eventId` is an event of another type; 404 for an event of another centre.

### Templates

`GET /automations/templates` lists the code-defined gallery. `POST /automations/from-template/:key` copies one into
the centre as a DISABLED rule (`templateKey` set) for the owner to review and switch on; things that still have to
be fixed (for example no n8n connection yet) come back as `problems` instead of failing the request.

| Key | Trigger | Does |
| --- | --- | --- |
| `auto-assign-on-submission` | `request.submitted` | Assigns the best available operator when the request has none |
| `follow-up-after-quotation-approved` | `quotation.approved` | Follow-up task due in 2 days |
| `notify-manager-request-overdue` | `request.overdue` | In-app and email message to managers |
| `escalate-overdue-step` | `request.step_overdue` | Urgent escalation task and alert for managers |
| `thank-customer-on-completion` | `request.completed` | Thank-you email and portal message to the customer |
| `expiry-reminder-on-verification` | `document.verified` | Expiry reminder for documents that have an expiry date |
| `notify-accountant-payment-received` | `payment.completed` | In-app message to accountants |
| `send-new-requests-to-n8n` | `request.submitted` | Signed webhook to `/typease/request-submitted` |
| `welcome-task-new-customer` | `customer.created` | Task for reception when a customer registered themselves |
| `summary-document-ready-for-processing` | `request.status_changed` | Summary PDF and a message to the operator when a request becomes ready |

## Events and jobs

Consumed (after commit, from the outbox, at-least-once): the 15 trigger events listed above, subscriber name
`automation`.

Emitted: none by this module itself. The actions cause the events of the modules they call (`request.assigned`,
`request.status_changed`, `document.uploaded`, …); those events carry `_actor.type = "AUTOMATION"`.

| Job | Schedule | What it does |
| --- | --- | --- |
| `automation.execute` | queued per execution `{ tenantId, executionId }`; queue attempts 1 (the engine schedules its own retries) | Runs the actions of one execution |
| `automation.sweep` | every 5 minutes, all operational tenants (`TenantDirectory.forEachTenant`) | Queues executions again whose job was lost: `PENDING` for more than 2 minutes, `RUNNING` for more than 15 minutes (interrupted), `FAILED` past their retry time |

Audit actions: `automation.created`, `automation.updated`, `automation.deleted`, `automation.enabled`,
`automation.disabled`, `automation.dead_letter`, `automation.execution_retried`. Everything an action does is
audited by the module that does it, with actor type `AUTOMATION` and actor label `automation:<rule name>`.

## Business rules

### From event to execution

- For every enabled rule of the trigger whose conditions hold, one `automation_executions` row is created
  (unique per rule and event) with a snapshot of the rule's actions, and `automation.execute` is queued. An event
  that is delivered again finds its rows and creates nothing. Events whose conditions do not hold leave no row.
- **Loop protection**: an event whose `_actor.type` is `AUTOMATION` never starts a rule. That covers everything an
  automation did (an assignment, a status change, a generated document) and everything other event subscribers
  did. `event.actorType` therefore never has the value `AUTOMATION` in a condition.
- Files the centre generates for itself that belong to no customer, company or request (for example scheduled
  report files) do not count as `document.uploaded` for automations.
- A centre without the plan feature keeps its rules, but events create no executions for it; an execution that
  was waiting when the feature was lost ends as `SKIPPED`. The same happens to an execution whose rule was
  switched off before its turn.

### Running, retrying, giving up

- The job runs as the `AUTOMATION` actor inside the tenant: it holds no permissions.
- Every action runs in its own database transaction together with the record of its result, so a finished action
  is never repeated: a retry continues at the first action that is not finished. The actions use the snapshot
  taken when the event arrived; editing the rule does not change executions that already exist.
- Extra protection per action: notifications carry the dedupe id `automation:<executionId>:<index>` (one
  notification per recipient and channel, however often it is tried); webhooks carry it as `X-TypEase-Delivery`;
  each transaction first checks, under a row lock, that this run still owns the execution.
- **Retryable** failures: HTTP 5xx / 408 / 425 / 429 from a webhook, an unreachable or slow webhook, a host that
  cannot be resolved, a concurrent update, "nobody available" for an automatic assignment, rate limits and
  unexpected errors. The execution becomes `FAILED` and runs again after 30 s, 1 min, 2 min, … (doubling, at most
  1 h), up to `maxRetries` times.
- **Not retryable**: refusals of a module that trying again cannot change (a transition that is not allowed or is
  blocked by a guard, a role that no longer exists, a refused webhook destination, HTTP 3xx / 4xx from a webhook).
- When retries are used up, or at once for a failure that is not retryable, the execution goes to the
  **dead-letter list** (`DEAD_LETTER`), an audit entry `automation.dead_letter` is written, and every active
  owner of the centre gets an in-app alert "Automation failed: <rule>" with the reason and a link to the
  execution. Actions after the failed one do not run.
- `POST /automations/executions/:id/retry` puts a dead-lettered execution back in the queue with a fresh retry
  budget; finished actions stay finished. 409 `NOT_DEAD_LETTERED` for anything else, 409 `AUTOMATION_DISABLED`
  while the rule is switched off.

### What an automation can never do

- **Status changes** go through `RequestStateMachine.transition` with the SYSTEM authority and nothing else. That
  authority may only use the edges marked `system: true` in the transition table, and every guard of the edge is
  evaluated. Saving a rule whose target is not the target of any automatic edge is refused (422
  `STATUS_NOT_AUTOMATABLE`); automatable targets are `UNDER_REVIEW, QUOTED, AWAITING_PAYMENT,
  READY_FOR_PROCESSING, IN_PREPARATION` (the last one only from "awaiting customer"). At run time an edge that
  does not exist fails with `INVALID_TRANSITION`, one that needs a person with `TRANSITION_NOT_ALLOWED`, a
  blocked one with the code of its guard (`DOCUMENTS_NOT_VERIFIED`, `PAYMENT_REQUIRED`, `QUOTATION_PENDING`, …).
  In every case the request is unchanged and the execution is dead-lettered with that reason.
- **Reviews**: `request_approval` asks the workflow engine to complete the preparation step. If that does not end
  in a pending review (the workflow has no review at that point, or a guard blocks it) everything is rolled back
  to a savepoint and the action fails with `REVIEW_NOT_REQUESTED`. The review itself is always decided by a
  reviewer.
- **Messages** go through the notifications module: consent (WhatsApp, marketing), opt-outs and preferences, the
  hourly rate limit, the monthly plan limit, the delivery pipeline and the delivery log all apply. A suppressed
  message is recorded there with its reason; the action reports the counts
  (`{ recipients, queued, delivered, suppressed, suppressedReasons }`). `purpose: MARKETING` is only possible
  towards customers and requires their marketing consent and opt-in. WhatsApp needs the name of an approved
  message template.
- **Assignments** never replace the person who has the case, and the assignee must satisfy the same rules as for
  a manual assignment (active, works at the branch, role may prepare / review, not both operator and reviewer).

### What a rule may refer to

Checked on create and update, again when the rule is switched on, and shown as `problems` on every answer
that carries the rule (see "`problems` on a rule") when something has gone stale:

- facts must exist for the trigger (`UNKNOWN_FACT`), comparisons must be sound (`INVALID_RULE`), values of facts
  with a closed list must be in it (`UNKNOWN_VALUE`);
- `service.code`, `service.categoryKey`, `branch.code`, `assignee.roleKey`, `step.escalateToRoleKey` and
  `document.typeKey` in conditions must name a service, category, branch, staff role or document type of the
  caller's own centre (`UNKNOWN_REFERENCE`);
- `roleKey` of an action must be a staff role of the centre (`UNKNOWN_ROLE`); `membershipId` must be an active
  staff member of the centre whose role may prepare / review (`UNKNOWN_STAFF`, `STAFF_NOT_ACTIVE`,
  `STAFF_ROLE_NOT_SUITABLE`); document types must exist (`UNKNOWN_DOCUMENT_TYPE`);
- variables in texts must exist for the trigger (`UNKNOWN_VARIABLE`);
- actions that work on a request (`assign_staff`, `generate_document`, `update_workflow_state`,
  `request_approval`, a message to the assignee) or on a customer (`schedule_reminder`, a message to the customer)
  are refused for triggers that never have one (`ACTION_NOT_APPLICABLE`); a reminder needs a document type and an
  expiry (`DOCUMENT_TYPE_REQUIRED`, `EXPIRY_REQUIRED`);
- a webhook `url` must pass the destination rules below (`HOST_NOT_ALLOWED`, `HTTPS_REQUIRED`,
  `CREDENTIALS_IN_URL`, `URL_INVALID`); switching a rule with a webhook on also needs an address and a signing
  secret (`NOT_CONFIGURED`).

### Webhooks (`call_webhook`)

- **Destination**: `path` is appended to the n8n webhook base address: the centre's own connection (Integrations,
  category `AUTOMATION`, provider `n8n`, switched on: `config.webhookBaseUrl`, secret `signingSecret`), otherwise
  the platform's `N8N_WEBHOOK_BASE_URL`. `url` is a complete address whose host is on the operator's allow-list
  `OUTBOUND_WEBHOOK_ALLOWED_HOSTS`. Nothing else can be called. `path` may only contain letters, digits and
  `- . _ ~ /`, without `..` or `//`.
- **Scheme**: https. Plain http only where the operator said so: a host on the allow-list, or the platform's own
  n8n address.
- **Address check (SSRF)**: the host is resolved once; if ANY resolved address is loopback, private, link-local,
  carrier-grade NAT, multicast or unspecified (IPv4 and IPv6, including IPv4-mapped IPv6) the call is refused
  (`PRIVATE_ADDRESS`). The connection is then made to the address that was checked, so a second DNS answer cannot
  redirect it. Two exceptions, both decided by the operator and never by a centre: the platform's own
  `N8N_WEBHOOK_BASE_URL` (normally inside the private network), and, outside production only, a host on the
  allow-list (a local n8n during development and in tests).
- No credentials in the URL. Redirects are never followed (a 3xx answer is a failure). 10 seconds for the whole
  exchange. The response body is discarded; only the status code is used (2xx = success).
- **Payload**: `{ "event", "tenantSlug", "occurredAt", "data" }`. `data` contains `eventId`, the identifiers,
  codes, amounts and dates of the event (an allow-list of field names) and, for a request, `request: { id,
  number, status, priority, serviceCode, branchCode }`. Names, contact details, free text, identity numbers and
  document contents are never sent.
- **Signature**: headers `X-TypEase-Timestamp` (Unix seconds), `X-TypEase-Signature: sha256=<hex>` where the hex
  is HMAC-SHA256 of `"<timestamp>.<raw body>"` with the signing secret, `X-TypEase-Delivery:
  <executionId>:<actionIndex>` (identical on every retry, for deduplication) and `X-TypEase-Event`. The secret is
  the centre's own when it has an n8n connection, otherwise `N8N_WEBHOOK_SECRET`; calls to the platform's n8n are
  always signed with the platform secret. The secret is never returned by any endpoint or written to a log.

### Notifications module: `sendCustom`

`NotificationService.sendCustom({ dedupeId, recipient, channels, subject?, body, data, purpose?,
whatsappTemplateName?, related? })` was added for this module. It creates notifications from a text written by
the centre instead of a catalogue template (event key `automation.message`, or `marketing.automation` for
`purpose: MARKETING`) and otherwise takes exactly the same road as `notify()`: recipient resolution, consent,
preferences, rate limit, plan limit, delivery job and delivery log. It can never be an account-security message,
so it bypasses nothing.

### Tenant isolation

Rules and executions are read and written in tenant transactions under row-level security, with an explicit
tenant filter. A rule or execution of another centre is 404. Events of one centre never start rules of another.
