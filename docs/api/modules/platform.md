# Platform administration

Module folder: `services/api/src/modules/platform`. Tables written: `tenants` (status columns),
`access_grants`, `feature_flags`, `platform_settings`, `users` (platform staff only), plus audit / security
entries. Schemas: `packages/validation/src/platform.ts`. All paths are under `/api/v1`.

This is the API behind the TypEase SaaS console. **Platform staff never get a centre's customer data
here.** Everything under `/platform/*` shows centre-level metadata only: profile, owner contacts,
subscription, usage against plan limits, counts of branches and staff, domains, onboarding progress. No
customers, documents, request content or financial records of a centre. Reaching those needs a support
access grant that the centre approves (section 4).

Related platform endpoints owned by other modules: plans, coupons and billing (`subscriptions.md`), the
support desk (`support.md`), incident and processor registers (`privacy.md`), approved providers and
authorisation review (`integrations.md`).

## Access

`@Platform(...)` routes need a platform session (signed in with `app: "platform"`, no centre bound) and one
of the listed permissions. A centre user, and a platform user who is inside a centre under a support grant,
get `403`.

| Permission | Super Admin | Support Agent | Used for |
| --- | --- | --- | --- |
| `platform.tenants.read` | yes | yes | list and view centres |
| `platform.tenants.manage` | yes | - | create, approve, reject, suspend, reactivate, archive, offboard |
| `platform.access.request` | yes | yes | ask a centre for support access, enter it |
| `platform.metrics.read` | yes | - | dashboard and reports |
| `platform.features.manage` | yes | - | feature flags and platform settings |
| `platform.staff.manage` | yes | - | platform staff |
| `platform.audit.read` | yes | - | platform audit entries, security events, other people's access requests |

## 1. Dashboard and SaaS reports (`platform.metrics.read`)

| Method | Path | Query | Response |
| --- | --- | --- | --- |
| GET | `/platform/dashboard` | `from?, to?` (`YYYY-MM-DD`; the churn period, default the last 30 days) | see below |
| GET | `/platform/reports/tenant-growth` | `from?, to?, interval = month \| week \| day` (default the last 12 months) | `{ from, to, interval, series: [{ period, from, new, total }] }` |
| GET | `/platform/reports/subscription-revenue` | `from?, to?` (default 12 months) | `{ series: [{ period, lines: [{ currency, invoices, total, tax, discount }] }], totals }` |
| GET | `/platform/reports/plan-distribution` | `from?, to?` (subscriptions created in the range; default all) | `{ total, centresWithoutSubscription, plans: [{ planKey, planName, currency, mrr, arr, subscriptions, byStatus, byCycle }] }` |
| GET | `/platform/reports/churn` | `from?, to?` (default 12 months) | `{ overall, series: [{ period, activeAtStart, churned, ratePercent, complete }] }` |
| GET | `/platform/reports/usage` | `from?, to?` (default 6 months) | `{ storage: { bytes, topCentres }, series: [{ period, requests, notifications, aiPages, aiCost }] }` |
| GET | `/platform/reports/failed-payments` | `from?, to?` (due date), `q, page, pageSize` | paged open invoices with failed attempts + `totals` |
| GET | `/platform/system/health` | - | the `systemHealth` block of the dashboard on its own (see "System status") |
| GET | `/platform/system/providers` | - | every external dependency: driver, status, detail (see "System status") |

```json
GET /platform/dashboard  ->  200
{ "generatedAt": "2026-10-09T08:00:00.000Z",
  "tenants": { "total": 42, "active": 30, "trial": 5, "onboarding": 2, "pendingApproval": 1, "pastDue": 2, "suspended": 1, "cancelled": 1, "archived": 0 },
  "revenue": [ { "currency": "AED", "mrr": "11244.17", "arr": "134930.00", "subscriptions": 32 } ],
  "churn": { "from": "...", "to": "...", "activeAtStart": 31, "churned": 1, "ratePercent": "3.23" },
  "failedPayments": { "openInvoices": 2, "amounts": [ { "currency": "AED", "total": "898.00" } ], "subscriptionsPastDue": 2, "subscriptionsInGrace": 0 },
  "usage": { "period": "2026-10", "storage": { "bytes": 5368709120, "gigabytes": 5 },
             "notifications": { "counted": 1840, "deliveriesByChannel": { "EMAIL": { "sent": 1210, "failed": 3 } } },
             "requests": 912, "ai": { "pages": 140, "calls": 61, "cost": [ { "currency": "USD", "estimate": "4.2000" } ] } },
  "supportTickets": { "byStatus": { "OPEN": 3, "IN_PROGRESS": 1, "WAITING_CUSTOMER": 0, "RESOLVED": 9, "CLOSED": 20 }, "open": 4, "total": 33 },
  "systemHealth": { "...": "exactly the body of GET /platform/system/health, see System status" } }
```

Every number is a query on real rows. The arithmetic is in `metrics.calc.ts` (unit-tested).

### System status

Two read-only endpoints for the "System" page of the console, both `@Platform('platform.metrics.read')`
(Super Admins; a Support Agent only if the platform role matrix gives it that permission). No value of a secret
is ever returned, not even a part of one; hosts and bucket names are. Nothing is contacted that would send or
cost anything: no SMTP handshake, no SMS / WhatsApp / push / payment / n8n call. The only real checks are one
`SELECT 1` on each database connection, one Redis `PING`, one round trip to object storage (`HeadBucket` on
S3, a probe file written and removed on the local driver; both give up after 3 seconds and the result is cached
for 15 seconds), the queue counts and the worker heartbeat (read from Redis).

**`GET /platform/system/health`** - the `systemHealth` block of the dashboard. `status` is `down` when a
database, Redis, the queue or the outbox cannot be read, `degraded` when `problems` is not empty for any other
reason (unreachable storage, stale or missing worker, failed jobs, failed or old events), `ok` otherwise.

```jsonc
{ "status": "ok",                          // ok | degraded | down
  "checkedAt": "2026-10-13T08:00:00.000Z",
  "database": true, "systemDatabase": true, "redis": true,
  "storage": { "driver": "s3",             // s3 | local
               "reachable": true,
               "target": "S3 bucket \"typease-prod-documents\" at s3.example.ae",   // local: "local directory /var/lib/typease/private"
               "error": null,              // error name / HTTP status only, e.g. "TimeoutError", "NotFound (HTTP 404)", "EACCES"
               "checkedAt": "2026-10-13T08:00:00.000Z" },
  "queue": { "driver": "bullmq", "reachable": true, "waiting": 0, "active": 1, "delayed": 12, "failed": 0 },
               // inline driver: { "driver": "inline", "reachable": true, "pending": 0, "deadLetters": 0 }
  "queues": [ { "name": "typease", "waiting": 0, "active": 1, "delayed": 12, "failed": 0 } ],
               // one row per queue (there is one), same shape for both drivers;
               // inline: waiting = jobs held in memory, active = delayed = 0, failed = dead letters
  "worker": { "mode": "worker",            // worker (QUEUE_DRIVER=bullmq) | single-process (QUEUE_DRIVER=inline: the API runs the jobs)
              "status": "OK",              // OK | STALE | NOT_SEEN | DISABLED
              "lastSeenAt": "2026-10-13T07:59:52.000Z",
              "ageSeconds": 8,
              "intervalSeconds": 15,       // WORKER_HEARTBEAT_INTERVAL_SECONDS
              "staleAfterSeconds": 30,     // two intervals
              "instances": [ { "instanceId": "worker-1:4321:a1b2c3", "mode": "worker", "startedAt": "2026-10-12T22:10:00.000Z",
                               "lastSeenAt": "2026-10-13T07:59:52.000Z", "ageSeconds": 8, "stale": false } ] },
               // null only when the heartbeat could not be read (Redis down)
  "outbox": { "pending": 0, "processing": 0, "failed": 0, "oldestPendingSeconds": 0 },   // null when it could not be read
  "problems": [] }                         // sentences for the operator, e.g. "The background worker last reported 95 seconds ago (expected every 15): background jobs are probably not being processed."
```

Worker heartbeat: the process that runs the jobs - the worker (`services/api/src/worker.ts`), or the API itself
when `QUEUE_DRIVER=inline` and `QUEUE_INLINE_AUTORUN=true` - writes `{ instanceId, mode, startedAt, lastSeenAt }`
into the Redis hash `typease:worker:heartbeats` (one field per process, hash TTL 24 hours) every
`WORKER_HEARTBEAT_INTERVAL_SECONDS` (5-300, default 15). `instances` lists the processes of the configured mode
that reported within the last 24 hours, most recent first; the freshest decides `status`: `OK` within two
intervals, `STALE` after that (jobs are probably not being processed), `NOT_SEEN` when nothing of that mode ever
reported (in `worker` mode: "start the worker"), `DISABLED` for the inline queue without autorun (tests,
one-off scripts: nothing runs jobs on its own, and that is not reported as a problem). An API heartbeat says
nothing about a worker and the other way round. A heartbeat is a statement about the process only, not about any
job: failed jobs are in `queues[].failed` / the dead letters.

**`GET /platform/system/providers`** - what the installation is configured to use, from the environment plus
the two real checks above (`storage`, `redis`). Rows come in this order and with these keys:
`mail, sms, whatsapp, push, storage, malware_scanner, ocr, payments, payments_sandbox, automation_webhooks,
redis, queue, error_tracking`.

```jsonc
{ "generatedAt": "2026-10-13T08:00:00.000Z",
  "environment": "production",             // NODE_ENV
  "providers": [
    { "key": "mail", "label": "E-mail", "driver": "smtp", "status": "CONFIGURED",
      "detail": "SMTP server smtp.example.ae:587 (STARTTLS), with a user name; sender \"TypEase\" <no-reply@example.ae>. The server is not contacted by this check." },
    { "key": "sms", "label": "SMS", "driver": "log", "status": "LOG_ONLY",
      "detail": "SMS_DRIVER=log: text messages are written to the application log and are NOT delivered. Centres can still connect their own provider under Settings > Integrations." },
    { "key": "whatsapp", "label": "WhatsApp Business", "driver": "meta", "status": "NOT_CONFIGURED", "detail": "Not usable yet: set WHATSAPP_ACCESS_TOKEN." },
    { "key": "push", "label": "Push notifications", "driver": "fcm", "status": "CONFIGURED", "detail": "Firebase Cloud Messaging, project typease-prod. Firebase is not contacted by this check." },
    { "key": "storage", "label": "Object storage", "driver": "s3", "status": "CONFIGURED",
      "reachable": true, "lastCheckedAt": "2026-10-13T08:00:00.000Z", "lastError": null,
      "detail": "S3 bucket \"typease-prod-documents\" at s3.example.ae; objects are private and encrypted by the store (SSE-S3). The store answered just now." },
    { "key": "malware_scanner", "label": "Malware scanner", "driver": "clamav", "status": "CONFIGURED", "detail": "ClamAV daemon at clamav:3310; a file can be downloaded only after a clean result. The daemon is not contacted by this check." },
    { "key": "ocr", "label": "Document reading (OCR)", "driver": "tesseract", "status": "CONFIGURED", "detail": "Tesseract runs inside this server (English model shipped with the application); documents do not leave the installation." },
    { "key": "payments", "label": "Online payments", "driver": "stripe", "status": "CONFIGURED", "detail": "Stripe (live key) with a webhook signing secret, for the platform's own billing. Each centre connects its own gateway under Settings > Integrations. Stripe is not contacted by this check." },
    { "key": "payments_sandbox", "label": "Payment test adapter", "driver": "sandbox", "status": "DISABLED", "detail": "PAYMENT_SANDBOX_ENABLED=false: the test gateway cannot be used." },
    { "key": "automation_webhooks", "label": "Automation webhooks (n8n)", "driver": "none", "status": "NOT_CONFIGURED", "detail": "No platform n8n (N8N_WEBHOOK_BASE_URL, N8N_WEBHOOK_SECRET). Centres can still enter the address of their own n8n; such calls go to public addresses only. No additional hosts are on the allow-list (OUTBOUND_WEBHOOK_ALLOWED_HOSTS)." },
    { "key": "redis", "label": "Redis", "driver": "redis", "status": "CONFIGURED",
      "reachable": true, "lastCheckedAt": "2026-10-13T08:00:00.000Z", "lastError": null,
      "detail": "Redis at redis:6379: rate limits, short-lived caches and the job queue. It answered just now." },
    { "key": "queue", "label": "Background jobs", "driver": "bullmq", "status": "CONFIGURED", "detail": "BullMQ on Redis; jobs are executed by the separate worker process. See the system health for the queue figures and the worker heartbeat." },
    { "key": "error_tracking", "label": "Error tracking", "driver": "none", "status": "NOT_CONFIGURED", "detail": "TypEase has no error-tracking integration. Errors are written to the application log (LOG_FORMAT=json, LOG_LEVEL=info); collect the log to be alerted." }
  ] }
```

| Field | Meaning |
| --- | --- |
| `driver` | the driver chosen in the environment: `smtp`/`log`; `twilio`/`http`/`log`; `meta`/`log`; `fcm`/`log`; `s3`/`local`; `clamav`/`none`; `tesseract`/`external-http`/`disabled`; `stripe`/`sandbox`/`none`; `n8n`/`none`; `redis`; `bullmq`/`inline`; `none` |
| `status` | `CONFIGURED` - the driver has everything it needs (for `storage` / `redis` also when the check failed just now: see `reachable`); `NOT_CONFIGURED` - the driver is chosen but a required variable is missing (`detail` names it), or there is nothing at all; `LOG_ONLY` - a `log` driver: written to the log, **not delivered** (never reported as configured); `DISABLED` - switched off on purpose (`MALWARE_SCANNER=none`, `OCR_PROVIDER=disabled`, test adapter off, inline queue without autorun); `SANDBOX` - only the payment test adapter is on (no money moves; `payments` is `SANDBOX` when no real gateway is set and the adapter is on) |
| `detail` | one or two sentences for the operator; names variables and hosts, never a credential |
| `reachable`, `lastCheckedAt`, `lastError` | only on `storage` and `redis` (the rows that are really checked); `lastError` is an error name / status, or null |

Tests: `platform.system.spec.ts`, `worker.bullmq.spec.ts` (a real worker's heartbeat seen by the API).

**MRR / ARR.** For every subscription whose status is `ACTIVE`, `PAST_DUE` or `GRACE` (a trial pays
nothing yet; `CANCELLED` and `EXPIRED` have ended):

```
price of one billing period   = plan.monthlyPrice             (monthly billing)
                              = plan.annualPrice              (annual billing)
coupon discount on the period = price x percentOff / 100      (percentage coupon)
                              = min(amountOff, price)         (fixed coupon, same currency as the plan)
                              = 0                             (no coupon, or couponEndsAt has passed)
net per period                = price - discount, never below 0
monthly contribution          = net                           (monthly billing)
                              = net / 12                      (annual billing)
MRR = sum of the contributions, rounded half-up to 2 decimals once, per currency
ARR = MRR x 12 (computed from the unrounded sum, then rounded)
```

Amounts in different currencies are never added together: `revenue` has one line per plan currency (an
empty array when nothing is being charged). Tax is not part of MRR. MRR is a run rate, not money received -
for that see `subscription-revenue`, which sums **paid** subscription invoices by the month of `paidAt`.

**Churn** for a period `(start, end]`:

```
activeAtStart = subscriptions that were ACTIVE / PAST_DUE / GRACE at `start`
churned       = of those, the ones that reached CANCELLED or EXPIRED after `start`, up to `end`
ratePercent   = churned / activeAtStart x 100   (null when nothing was paying at the start)
```

The status at a past moment is replayed from `subscription_events` rows of type `STATUS_CHANGED` (written
by the billing module on every transition). A subscription without any recorded change is taken at its
current status. A subscription that starts and ends inside the period is not in the base; a trial that
never converts is not churn. In `/reports/churn` the running month has `complete: false`.

**Failed payments** = `OPEN` subscription invoices with `attemptCount > 0`, plus the number of
subscriptions in `PAST_DUE` and in `GRACE`.

**Usage** comes from `usage_records` (`storageBytes` running total; `notifications`, `monthlyRequests`,
`aiPages` per calendar month) and `ai_usage_logs` (`costEstimate`, per currency). Notification figures are
**counts**; TypEase does not record what a provider charged per message, so there is no notification cost.
`deliveriesByChannel` counts delivery attempts of the current month.

**System health**: both database connections, Redis, the job queue (BullMQ: `waiting / active / delayed /
failed`; single-process mode: `pending / deadLetters`) and the event outbox. `status` is `down` when a
dependency does not answer, `degraded` when there are failed jobs, failed events, or events waiting for more
than 10 minutes (`problems` says which), otherwise `ok`.

Notes: tenant growth no longer counts centres that were permanently deleted. Exports of these reports to
Excel / PDF are not implemented in this module.

## 2. Centres (tenants)

| Method | Path | Permission | Body / query | Response |
| --- | --- | --- | --- | --- |
| GET | `/platform/tenants` | `tenants.read` | `page, pageSize, sort (createdAt, name, slug, status), q (name, legal name, slug, contact email), status, plan (key or "none"), createdFrom, createdTo, offboarding` | Paged list rows |
| GET | `/platform/tenants/:id` | `tenants.read` | - | Centre detail |
| POST | `/platform/tenants` | `tenants.manage` | `{ businessName, slug, legalName?, emirate?, ownerName, ownerEmail, ownerPhone?, preferredLanguage = "en", planKey?, billingCycle = "MONTHLY", couponCode? }` | `201` detail + `plan` + `invitation` |
| POST | `/platform/tenants/:id/owner-invitation` | `tenants.manage` | - | `{ email, status: "SENT" }` |
| POST | `/platform/tenants/:id/approve` | `tenants.manage` | `{ note? }` | detail |
| POST | `/platform/tenants/:id/reject` | `tenants.manage` | `{ reason }` | detail |
| POST | `/platform/tenants/:id/suspend` | `tenants.manage` | `{ reason }` (5+ characters) | detail |
| POST | `/platform/tenants/:id/reactivate` | `tenants.manage` | `{ note? }` | detail |
| POST | `/platform/tenants/:id/archive` | `tenants.manage` | `{ reason }` | detail |
| POST | `/platform/tenants/:id/offboard` | `tenants.manage`, Super Admin only | section 3 | detail + `offboarding` |
| POST | `/platform/tenants/:id/cancel-offboarding` | `tenants.manage`, Super Admin only | `{ reason }` | detail |

List row: `{ id, slug, name, legalName, status, emirate, contactEmail, contactPhone, suspendedAt,
suspensionReason, archivedAt, offboardingAt, createdAt, plan: { key, name } | null, subscription: { status,
billingCycle, currentPeriodEnd, trialEndsAt } | null }`.

```json
GET /platform/tenants/:id  ->  200
{ "id": "...", "slug": "alpha", "name": "Alpha Typing Centre", "legalName": "Alpha Typing LLC", "status": "ACTIVE",
  "suspendedAt": null, "suspensionReason": null, "approvedAt": "...", "archivedAt": null, "offboardingAt": null, "offboarding": null, "createdAt": "...",
  "profile": { "country": "AE", "emirate": "Dubai", "timezone": "Asia/Dubai", "defaultCurrency": "AED", "defaultLanguage": "en",
               "contactEmail": "...", "contactPhone": "...", "tradeLicenceNo": null, "taxRegistrationNo": null, "aiEnabled": false },
  "owners": [ { "membershipId": "...", "userId": "...", "fullName": "...", "email": "...", "phone": "+9715...", "status": "ACTIVE",
                "accountStatus": "ACTIVE", "emailVerified": true, "mfaEnabled": false, "invitedAt": null, "joinedAt": "...", "lastLoginAt": "..." } ],
  "subscription": { "id": "...", "status": "ACTIVE", "billingCycle": "MONTHLY", "plan": { "key": "professional", "name": "Professional", "monthlyPrice": "349", "annualPrice": "3490", "currency": "AED" },
                    "pendingPlan": null, "currentPeriodStart": "...", "currentPeriodEnd": "...", "trialEndsAt": null, "graceEndsAt": null, "cancelAtPeriodEnd": false, "cancelledAt": null },
  "usage": [ { "metric": "branches", "used": 2, "limit": 2 }, { "metric": "staffUsers", "used": 4, "limit": 10 } ],
  "counts": { "branches": { "total": 2, "active": 2 }, "staff": { "active": 4, "invited": 0, "suspended": 0 } },
  "domains": [ { "id": "...", "domain": "portal.alpha.ae", "kind": "CUSTOM", "app": "customer", "status": "VERIFIED", "isPrimary": true, "verifiedAt": "...", "lastCheckedAt": null, "lastCheckError": null } ],
  "onboarding": { "currentStep": 10, "completed": true, "canComplete": true, "steps": [ { "key": "account", "title": "Verify your email and phone", "done": true, "required": true } ] },
  "lastActivity": { "at": "...", "lastSessionAt": "...", "lastLoginAt": "...", "lastAuditedActionAt": "..." },
  "support": { "openPlatformTickets": 0, "pendingAccessRequests": 0, "activeAccessGrants": 0 } }
```

`usage` is exactly what the owner sees under `GET /tenant/usage`; `onboarding` is the owner's own progress
(both are computed by their own services inside the centre's row-level-security context). `lastActivity`
is derived from sessions, sign-ins and the time of the last audited action - metadata only.

### Creating a centre on behalf of a customer

`POST /platform/tenants` creates the centre in `ONBOARDING`, provisions it like a self-service sign-up
(roles, head office, default categories, fee treatment, branding) and adds the owner as an **invited**
member. The owner receives the normal invitation email (`AuthService.sendInvitation`) and chooses their own
password - platform staff never set or see one. With `EXPOSE_DEV_TOKENS=true` (never in production) the
answer contains `invitation.dev.invitationToken`.

- `ownerEmail` may belong to somebody who already owns another centre: no second account is created and no
  password is asked when they accept. It may not be a TypEase staff address (`409 EMAIL_IN_USE`).
- `planKey` (an active **public** plan) starts the subscription through the billing module at once:
  `plan.outcome` is `TRIAL_STARTED`, `PAYMENT_REQUIRED` or `ACTIVE`. If the plan cannot be started (for
  example a coupon problem) the centre is still created and `plan.outcome` is `FAILED` with the reason; the
  owner then chooses a plan during onboarding. A private plan is assigned afterwards in Billing.
- The centre goes through the ordinary onboarding. Where `TENANT_APPROVAL_REQUIRED=true` it therefore also
  ends in `PENDING_APPROVAL` and has to be approved like any other.
- `POST .../owner-invitation` sends a new invitation (the earlier link stops working) while it has not been
  accepted (`409 NO_PENDING_INVITATION` afterwards).

### Status changes

`tenants.status` is shared with SaaS billing: the hourly subscription job re-derives it from the
subscription. Billing never touches `ONBOARDING`, `PENDING_APPROVAL` or `ARCHIVED`, and never a
`SUSPENDED` centre whose `suspensionReason` is anything other than `SUBSCRIPTION_UNPAID`. Every suspension
made here stores a reason with a prefix, so **a payment can never undo it**.

| Action | Allowed when | Result |
| --- | --- | --- |
| approve | `PENDING_APPROVAL` | status according to the subscription: `TRIALING` -> `TRIAL`, `ACTIVE` -> `ACTIVE`, `PAST_DUE` / `GRACE` -> `PAST_DUE`, `EXPIRED` -> `SUSPENDED` (unpaid), `CANCELLED` -> `CANCELLED`, none -> `ACTIVE`; sets `approvedAt` / `approvedById` |
| reject | `PENDING_APPROVAL` | `SUSPENDED`, `suspensionReason = "APPROVAL_REJECTED: <reason>"`. The owner can still read the reason (`GET /tenant`). A later *reactivate* approves it after all. |
| suspend | any status except `ARCHIVED`, `CANCELLED`, or already suspended by the platform | `SUSPENDED`, `suspensionReason = "PLATFORM: <reason>"`. Also possible on top of a billing suspension. |
| reactivate | `SUSPENDED` by the platform, or `ARCHIVED` without a scheduled offboarding | `ONBOARDING` if onboarding was never finished, otherwise the status the subscription implies (table above) |
| archive | any status except `ARCHIVED` | `ARCHIVED`; every session of the centre is ended; the subscription is cancelled and open subscription invoices are voided. Nothing is deleted. |

- A suspended centre keeps its staff sessions so the owner can read the reason and reach the subscription
  page; every other route answers `403 TENANT_UNAVAILABLE` from the next request on. Customers are locked
  out as well.
- A centre suspended **for non-payment** cannot be reactivated here (`409 SUSPENDED_FOR_NON_PAYMENT`):
  record the payment or extend the trial in Billing and the centre comes back by itself.
- An archived centre cannot be signed in to. After *reactivate* its status is `CANCELLED` (its subscription
  was ended) and the owner has to subscribe again.
- Every change is written to the platform audit trail **and** to the centre's own audit trail
  (`tenant.approved`, `.rejected`, `.suspended`, `.reactivated`, `.archived`, `.created_by_platform`,
  `.owner_invitation_resent`) and as a security event `TENANT_<ACTION>` (severity MEDIUM).

## 3. Controlled offboarding

Offboarding permanently deletes a centre. It is deliberately slow and explicit.

```
POST /platform/tenants/:id/offboard      (Platform Super Admin)
{ "confirmSlug": "alpha",                 // type the centre's slug
  "reason": "Centre closed and asked for its data to be deleted.",   // 10+ characters
  "purgeAfterDays": 30,                   // default 30; at least 30 (or the configured minimum)
  "immediate": false,                     // true needs confirmImmediate
  "confirmImmediate": "PURGE alpha" }     // only with immediate: the literal text "PURGE <slug>"
```

What happens at once (one transaction):

1. status `ARCHIVED`, `offboardingAt` = now + `purgeAfterDays` (or now, when immediate);
2. every session of the centre is revoked - staff, customers, corporate users and TypEase support sessions;
3. its domains are set to `DISABLED`; open support access grants are revoked;
4. its subscription is cancelled and open subscription invoices are voided.

The answer is the centre detail with `offboarding: { purgeAt, scheduledAt, scheduledBy, reason, immediate,
dataExport: "NOT_AUTOMATIC" }`. While it is scheduled, `GET /platform/tenants/:id` shows `offboarding`
and `GET /platform/tenants?offboarding=true` lists the centre.

`POST /platform/tenants/:id/cancel-offboarding { reason }` withdraws it **before** the date
(`409 OFFBOARDING_DUE` afterwards). The centre stays `ARCHIVED` (reactivate it separately); its domains go
back to `PENDING` and have to be verified again.

### The purge (job `platform.offboarding`, daily 02:40 UTC; at once for `immediate`)

For every `ARCHIVED` centre whose `offboardingAt` has passed:

1. **Files first.** Every stored and staged object under the centre's prefix is deleted through the storage
   module (`StorageService.deleteTenantObjects`: `<tenantId>/...` and `incoming/<tenantId>/...`), and the
   centre's logo / favicon are removed from the public asset store. If this fails nothing else is touched
   and the next run tries again.
2. **Then every row, in ONE transaction** on the system connection with
   `SET LOCAL typease.allow_purge = 'on'` (the only way past the append-only and immutability triggers,
   valid for that transaction alone): every table that has a `tenantId` column, in an order computed from
   the foreign keys in the database catalogue (referencing tables first), then the accounts that existed
   only because of this centre, then the `tenants` row.

What is deleted: customers, documents, requests, invoices, payments, audit entries, security events,
notifications, integrations and their credentials, sessions, one-time tokens, sign-in history, memberships -
everything of the centre. **User accounts** are deleted when the person belonged to no other centre and is
not TypEase staff; somebody who also works at another centre keeps their account and that membership.

What is kept:

- one platform audit entry `tenant.purged` (centre id, slug, name, counts per table, number of files and
  accounts, and a summary of TypEase's own subscription invoices to the centre: number, status, total,
  period, paid date - up to 500);
- earlier platform audit entries about the centre (suspension, scheduling ...);
- rows of the platform incident register (`security_incidents`) that mention the centre: TypEase has to be
  able to show regulators what was done about an incident.

The job is safe to run twice and from two workers: file deletion is idempotent, and the database part
re-checks the centre under a row lock. A failure for one centre is recorded as security event
`TENANT_PURGE_FAILED` (HIGH) and does not stop the others. **There is no undo and no backup is taken by the
job**; database backups age out by their own retention.

Policy setting `offboarding.policy` (`{ minPurgeDelayDays }`, default 30): the minimum can be raised, never
lowered below 30.

### Data export for the owner - manual procedure

**Nothing is exported automatically** (`dataExport: "NOT_AUTOMATIC"`). Once offboarding is scheduled the
owner can no longer sign in, so agree the export **before** calling the endpoint:

1. While the centre is still active, the owner exports what they need with the product's own functions:
   customer and financial reports, invoice and receipt PDFs, and the documents in the vault (downloads are
   decrypted by the application; with the local storage driver the files on disk are encrypted and useless
   on their own).
2. If the owner asks TypEase for a full data set, an operator produces it from the database during the
   waiting period and hands it over through an agreed secure channel. As the schema owner, for every table
   with a `tenantId` column:

   ```sql
   \copy (SELECT * FROM "customers" WHERE "tenantId" = '<tenant id>') TO 'customers.csv' CSV HEADER
   -- the list of tables:
   SELECT c.relname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
   WHERE a.attname = 'tenantId' AND c.relkind = 'r' AND NOT a.attisdropped ORDER BY 1;
   ```

   Leave out `sessions`, `auth_tokens` and `integration_credentials_metadata.secretsEnc`. Identity document
   numbers are stored encrypted and are not readable in such an export.
3. Record on the platform support ticket what was exported, for whom and when, then schedule the
   offboarding. Use the waiting period (30 days or more) as the window in which the owner can still ask.

## 4. Time-limited support access

Platform staff hold no permission inside a centre. To look at a centre's data they **ask**, the centre
**approves**, and the access ends by itself.

How it is enforced: the access token of a support session carries the grant id. On **every** request the
grant is read from the database; it must be `APPROVED`, not revoked and not past `expiresAt`, and only its
scopes become the session's permissions. A denial, a revocation or the expiry therefore takes effect on
the very next request, with the same token. A support session is bound to that one centre and is not a
platform session (`/platform/*` answers `403 PLATFORM_ONLY`).

**Scopes** can only be chosen from `SUPPORT_GRANTABLE` (package `@typease/permissions`): `customer.read,
service.read, request.read.all, request.comment.internal, quotation.read, invoice.read, payment.read,
branch.read, staff.read, appointment.read, task.read, ticket.read, reminder.read, report.operational,
audit.read, document.read`. Fifteen of them are reads; exactly one, `request.comment.internal`, lets support
change something (write an internal note on a request) and is shown to the centre as a write before it
approves (`write: true`). **Document content needs the explicit `document.read` scope.**

### What a support session can reach

Decided by the authentication guard on every request of a support session (code:
`services/api/src/common/auth/support-session.ts`, test: `services/api/test/support-session.spec.ts`, which
calls every registered route):

1. **Only what the scopes open.** A route is reachable when a permission it requires is one of the granted
   scopes. Everything else answers `403 SUPPORT_ACCESS_SCOPE`.
2. **Routes without a permission are closed** (`@TenantMember()` and `@Authenticated()` routes: own profile
   changes, password, MFA, sessions, memberships, switching centre, the dashboard, the personal inbox, device
   registration, plan usage ...), except the five marked `@SupportSessionSafe` in the code:

   | Route | Why a support session may call it |
   | --- | --- |
   | `GET /auth/me` | the session itself: who, which centre, which grant, until when |
   | `GET /tenant` | the profile of the centre itself (name, language, time zone, currency, settings) for the frame of the staff app |
   | `GET /feature-flags` | which screens the centre has switched on (booleans) |
   | `GET /document-types` | reference list of document type names |
   | `GET /branches/directory` | branch names, addresses and opening hours as published to customers |

   None of them returns customer data, none of them is a change. `POST /auth/logout` and `POST /auth/refresh`
   are public routes and work for a support session as for any other session.
3. **Read-only.** Any method other than GET / HEAD answers `403 SUPPORT_ACCESS_READ_ONLY`, with two
   exceptions that both still need their scope:
   - four POST routes that only return a short-lived link (`@SupportSessionRead`):
     `POST /documents/:id/download-link`, `POST /documents/:id/preview-link` (`document.read`),
     `POST /reports/scheduled/:id/runs/:documentId/download-link` (`report.operational`),
     `POST /reminders/:id/renewal-link` (`reminder.read`);
   - the write scopes defined in code (`SUPPORT_WRITE_SCOPES`): today only `request.comment.internal`, which
     opens `POST /requests/:id/comments` for an **internal** note. A customer-visible comment needs a
     permission that cannot be granted.
4. **Never, whatever was granted:** routes for customers and company users (`kinds` without `STAFF`),
   platform routes (`403 PLATFORM_ONLY`), identity numbers in clear (`customer.sensitive.read`), OCR results,
   staff / role / billing / subscription / integration / privacy-request management, deciding about support
   access. None of these permissions is in `SUPPORT_GRANTABLE`.
5. **Public routes** treat a support session like an anonymous caller (its staff standing is not applied);
   only the identity is known, so that signing out ends the right session.
6. **A suspended or archived centre** is closed to support sessions like to its staff
   (`403 TENANT_UNAVAILABLE`), except for the routes that are open to suspended centres.
7. **Every call that reaches centre data is recorded.** Each allowed call writes an entry
   `support_access.api_call` on the centre's audit trail with the grant id:
   `after: { method, route, path, outcome: "ALLOWED" }` (the query string is not stored). If that entry
   cannot be written, the call is not carried out. A refused call writes the same entry with
   `outcome: "REFUSED"` and `reason` (`SUPPORT_ACCESS_SCOPE`, `SUPPORT_ACCESS_READ_ONLY`, `PLATFORM_ONLY` ...)
   **once per grant, route pattern and reason in ten minutes**: a client that retries a forbidden request in a
   loop cannot bury the centre's trail. Repeats inside the window are counted (in Redis) and reported on the
   next entry for the same call: `after.collapsed = { windowMinutes: 10, suppressedSincePreviousEntry: n }`,
   and the summary ends in "(n more refusals of this call since the previous entry were not recorded one by
   one)". The security event `PERMISSION_DENIED` (with `supportGrantId`) is written for every refusal; without
   Redis every refusal is written to the trail as well. The five routes of point 2 and the public routes are
   not recorded (they carry no centre data). Changes are additionally audited by the module that makes them,
   and file reads are in the document access log - all with `supportGrantId`.

### TypEase staff (`platform.access.request`)

| Method | Path | Body / query | Response |
| --- | --- | --- | --- |
| POST | `/platform/tenants/:id/access-grants` | `{ reason (10+), scopes: [...], durationMinutes = 60 (5..1440), ticketId? }` | `201` grant, status `REQUESTED` |
| GET | `/platform/access-grants` | `status?, centreId?, q?, all?, page...` | own requests; `all=true` needs `platform.audit.read` |
| GET | `/platform/access-grants/:id` | - | grant (own, or any with `platform.audit.read`) |
| POST | `/platform/access-grants/:id/enter` | - | `{ accessToken, expiresIn, refreshToken, session, landing, grant: { id, scopes, expiresAt }, handoff: { code, expiresAt, url } }` (see "Support session hand-off") |
| POST | `/platform/access-grants/:id/revoke` | - | grant, status `REVOKED` (withdraw a request / end access early; a Super Admin may do it for anyone) |

```json
{ "id": "...", "centre": { "id": "...", "name": "Alpha Typing", "slug": "alpha", "status": "ACTIVE" },
  "requestedById": "...", "requestedByName": "Sara Support", "reason": "Customer reports a missing invoice PDF",
  "scopes": ["customer.read", "invoice.read"], "ticketId": null, "status": "APPROVED", "durationMinutes": 30,
  "decidedByName": "Centre Owner", "decidedAt": "...", "decisionNote": "OK until lunch.",
  "startsAt": "2026-10-09T09:00:00.000Z", "expiresAt": "2026-10-09T09:30:00.000Z", "revokedAt": null, "usable": true, "createdAt": "..." }
```

- `ticketId` must be a platform support ticket of the same centre (`422 TICKET_NOT_FOUND`).
- One open request or active grant per staff member and centre (`409 ACCESS_ALREADY_OPEN`).
- Only the person who asked can `enter`, only while the grant is approved and unexpired
  (`409 ACCESS_NOT_APPROVED`, `403 SUPPORT_ACCESS_ENDED`). A browser uses `handoff.url` (next section). An
  API client can use the returned `accessToken` as the bearer token for the centre's ordinary API. The
  refresh token works only while the grant is in force, and the session row expires with the grant.
- Policy setting `supportAccess.policy`: `{ maxDurationMinutes = 1440, pendingExpiryDays = 7 }`.

### Support session hand-off

The platform console and the staff app are different origins, and a token must never travel in a URL. The
console therefore gets a **one-time code** and opens the staff app with it; the staff app exchanges the code
for its own session.

**Step 1 - platform console** (bearer token of the platform session, permission `platform.access.request`):

```http
POST /api/v1/platform/access-grants/5f0c.../enter
```

```json
{
  "accessToken": "eyJ...", "expiresIn": 900, "refreshToken": "...", "landing": "/",
  "session": { "...": "as GET /auth/me below" },
  "grant": { "id": "5f0c...", "scopes": ["customer.read", "invoice.read"], "expiresAt": "2026-10-09T09:30:00.000Z" },
  "handoff": {
    "code": "kq3X...43 characters or more...",
    "expiresAt": "2026-10-09T09:01:00.000Z",
    "url": "https://app.typease.example/support-session#code=kq3X..."
  }
}
```

- The console opens `handoff.url` in a new tab (`window.open(url, '_blank', 'noopener')`) and forgets the
  response. It does not need `accessToken` / `refreshToken`; they are for API clients.
- `handoff.url` is `${CENTRE_WEB_URL}/support-session#code=<code>`. The code is in the **fragment**: browsers
  do not send it to any server and it does not appear in access logs.
- The code is 32 random bytes (base64url), stored only as a SHA-256 hash (`auth_tokens`, type
  `SUPPORT_HANDOFF`), valid for **60 seconds**, usable **once**. Calling `enter` again makes a new code and
  cancels the unused one. Errors of `enter`: `404` (not the requester), `409 ACCESS_NOT_APPROVED`,
  `403 SUPPORT_ACCESS_ENDED`, `403 TENANT_UNAVAILABLE`.

**Step 2 - staff app**, page `/support-session`: read `location.hash`, remove it from the address bar
(`history.replaceState`), then:

```http
POST /api/v1/auth/support-session/exchange
X-Requested-With: typease
Content-Type: application/json

{ "code": "kq3X..." }
```

Public route (the staff app has no session yet), rate-limited (10 per 5 minutes per IP), `credentials:
'include'` so that the cookie is stored. Response `200`:

```json
{
  "status": "OK",
  "accessToken": "eyJ...",
  "expiresIn": 900,
  "landing": "/",
  "session": {
    "user": { "id": "...", "email": "sara@typease.example", "phone": null, "fullName": "Sara Support", "preferredLanguage": "en",
              "platformRole": "SUPPORT_AGENT", "mfaEnabled": true, "emailVerified": true, "phoneVerified": false },
    "tenant": { "id": "...", "slug": "alpha", "name": "Alpha Typing", "status": "ACTIVE", "timezone": "Asia/Dubai", "currency": "AED" },
    "membership": null,
    "permissions": ["customer.read", "invoice.read"],
    "supportGrant": {
      "id": "5f0c...",
      "scopes": ["customer.read", "invoice.read"],
      "writeScopes": [],
      "readOnly": true,
      "startsAt": "2026-10-09T09:00:00.000Z",
      "expiresAt": "2026-10-09T09:30:00.000Z",
      "tenantId": "...",
      "tenantName": "Alpha Typing",
      "reason": "Customer reports a missing invoice PDF"
    },
    "mfaRequiredSetup": false
  }
}
```

plus `Set-Cookie: te_rt_centre=<refresh token>; HttpOnly; SameSite=Lax; Path=/api/v1/auth; Max-Age=<seconds
until the grant expires>` (`Secure` when `COOKIE_SECURE=true`). The refresh token is not in the body. From
here on the staff app works exactly as after a normal sign-in: bearer `accessToken`, `POST /auth/refresh`
with the cookie, `POST /auth/logout` to leave.

| Answer | When |
| --- | --- |
| `400 VALIDATION_FAILED` | `code` missing or shorter than 20 characters |
| `400 HANDOFF_INVALID` | unknown code, used before, older than 60 seconds, or replaced by a newer `enter` |
| `403 CSRF_CHECK_FAILED` | header `X-Requested-With: typease` missing (the code is **not** used up) |
| `403 SUPPORT_ACCESS_ENDED` | the grant was revoked or its time ran out between step 1 and step 2 |
| `403 ACCOUNT_DISABLED` | the platform account was disabled or is no longer platform staff |
| `403 TENANT_UNAVAILABLE` | the centre was suspended or archived in between |
| `429 RATE_LIMITED` | too many attempts |

Everything is checked again at the exchange: the code is claimed with one conditional UPDATE (of several
simultaneous exchanges exactly one succeeds; a refused exchange uses the code up as well), then the grant
(approved, not revoked, unexpired, requested by this person), the account and the centre. `support_access.entered`
is written to the centre's audit trail and to the platform trail (`after.via = "HANDOFF"`; the `enter` call
itself is recorded with `via = "CONSOLE"`), plus the security event `SUPPORT_ACCESS_ENTERED`. Refused codes
are security events `SUPPORT_HANDOFF_REJECTED` (`reason: UNKNOWN_CODE | CODE_REUSED | CODE_EXPIRED`).

**What the staff app shows.** `GET /auth/me` returns the same `session` object on every load. When
`session.supportGrant` is not `null` the app is in a support session and must show a permanent banner:
centre (`tenantName`), "read-only" unless `readOnly` is `false`, the scopes, and a countdown to `expiresAt`.
`membership` is `null` and `permissions` equals `supportGrant.scopes`; build the navigation from
`permissions` as for any user. Calls outside the scopes answer `403 SUPPORT_ACCESS_SCOPE` or
`SUPPORT_ACCESS_READ_ONLY` (not errors to report - hide the control). `landing` is `/` (the dashboard API is
closed to support sessions).

**How the session ends.** At `expiresAt`, or earlier when the centre or the platform revokes the grant, the
very next API call answers `401` with `code: "SUPPORT_ACCESS_ENDED"` (expired) or `"SESSION_EXPIRED"`
(revoked: the session was closed), and `POST /auth/refresh` answers `401` too. The staff app should then show
"Support access has ended" and offer to close the tab; there is nothing to sign in to. The session row and
the cookie never outlive the grant.

### The centre (`support_access.decide`, the owner by default)

| Method | Path | Body / query | Response |
| --- | --- | --- | --- |
| GET | `/support-access` | `status?, q?, page...` | paged grants + `pending` (number waiting for a decision) |
| GET | `/support-access/:id` | - | grant |
| POST | `/support-access/:id/approve` | `{ note?, scopes?, durationMinutes? }` | grant, status `APPROVED` |
| POST | `/support-access/:id/deny` | `{ note? }` | grant, status `DENIED` |
| POST | `/support-access/:id/revoke` | `{ note? }` | grant, status `REVOKED` |

```json
{ "id": "...", "requestedByName": "Sara Support", "reason": "...",
  "scopes": [ { "key": "customer.read", "description": "View customers (identity numbers masked)", "write": false } ],
  "ticketId": null, "status": "REQUESTED", "durationMinutes": 30, "decidedById": null, "decidedAt": null, "decisionNote": null,
  "startsAt": null, "expiresAt": null, "revokedAt": null, "active": false, "createdAt": "..." }
```

- **The clock starts at approval**: `startsAt = now`, `expiresAt = now + durationMinutes`.
- The centre may approve **less** than was asked - fewer scopes, a shorter time - never more
  (`422 SCOPE_NOT_REQUESTED`, `422 DURATION_TOO_LONG`).
- `revoke` works at any time on a waiting request or a running grant; sessions opened under the grant are
  closed.
- A grant of another centre does not exist here (`404`). A support session cannot decide about access
  (`support_access.decide` is not grantable).
- A decision that was already taken is `409 ACCESS_ALREADY_DECIDED`.

### Audit trail

Everything is on the **centre's** audit trail. What TypEase support did carries `supportGrantId`,
`actorType: "PLATFORM"` and an actor label ending in "(TypEase support)": `support_access.requested`,
`support_access.entered`, `support_access.api_call` for every allowed call made under the grant and for refused
calls (one entry per route and reason in ten minutes, with the count of repeats - see "What a support session
can reach", point 7), and every audited action taken under the grant. What the centre did about the grant -
`support_access.approved`, `.denied`, `.revoked` (and `.expired`, written by the job) - is the centre's own act:
`actorType: "STAFF"` (or `SYSTEM`), `resourceType: "AccessGrant"`, `resourceId` = the grant id, **no**
`supportGrantId`.

- `GET /audit-logs?supportAccess=true` lists what was done under any grant (rows with a `supportGrantId`;
  `supportAccess=false` the opposite).
- `GET /audit-logs?supportGrantId=<id>` tells the whole story of one grant: everything done under it **and**
  the centre's own decisions about it. A search text (`q`) narrows that story, it never widens it.

`support_access.entered` is also on the platform trail. Security events: `SUPPORT_ACCESS_REQUESTED`,
`_APPROVED`, `_DENIED`, `_ENTERED`, `_REVOKED`, `SUPPORT_HANDOFF_REJECTED`, and `PERMISSION_DENIED` (with
`supportGrantId`) for every refused call - the security log is never collapsed.

Job `platform.access_grants_expiry` (every 60 seconds): marks grants whose time is over as `EXPIRED`, ends
their sessions, and lapses requests nobody answered within `pendingExpiryDays`. Access itself stops at
`expiresAt` whether or not the job has run yet.

### Notifications

- **A request arrives** (`POST /platform/tenants/:id/access-grants`): the request and the domain event
  `support_access.requested` are written in one transaction. The notifications module then tells every active
  staff member of the centre who holds `support_access.decide` (the owners by default, plus custom roles) -
  in the application (`GET /me/notifications`, `relatedType: "AccessGrant"`, `relatedId` = the grant id) and by
  email, in the person's language (English / Arabic), through the centre's normal notification pipeline
  (template `support_access.requested`). The message names who asks, for how many minutes, why, and **what the
  access allows**, worked out from the requested scopes (variable `accessKind`): "read-only access" only when
  nothing in the request can change anything; otherwise "read access, plus writing internal notes on requests
  (nothing else can be changed)" - in English and Arabic. It links to the approval screen of the staff
  application: `${CENTRE_WEB_URL}/settings?tab=support`. Each in-app item identifies the grant
  (`relatedType: "AccessGrant"`, `relatedId` = the grant id), which is what the application opens. The template belongs
  to the `security` group: a personal opt-out does not suppress it and it does not use the plan's notification
  allowance. A request that was withdrawn or decided before the message was created is not announced; a
  repeated delivery of the event creates nothing new.
- **A decision** - approved, denied, or revoked by the centre (`support_access.decided`, emitted in the
  centre's transaction), or ended by a Super Admin on somebody else's behalf: the TypEase staff member who asked
  gets an email (template `support_access.decided`, their language) with what was decided, until when the
  access is valid, the centre's note, and a link to `${PLATFORM_ADMIN_URL}/access-requests`. It is a platform
  message: sent with the platform's template and provider, not stored among the centre's notifications and not
  counted against the centre's allowance. Each message is recorded on the platform audit trail
  (`support_access.requester_notified`, with the event id - which also prevents a second email when the event
  is delivered again). Withdrawing your own request sends nothing; a requester whose account is disabled is
  not written to. Platform staff have no in-application inbox, so this one is email only.
- Not notified: the expiry of an approved grant, and a request that lapses unanswered (job
  `platform.access_grants_expiry`). The console shows `pending` from `GET /support-access`.

## 5. Feature flags and platform settings (`platform.features.manage`)

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/platform/feature-flags` | - | `[{ key, enabled, hasGlobalDefault, payload, updatedAt, overrides: { total, enabled, disabled } }]` |
| PUT | `/platform/feature-flags/:key` | `{ enabled, payload? }` | the flag (creates or changes the global default) |
| DELETE | `/platform/feature-flags/:key` | - | `{ status: "DELETED" }` - the default **and** every override |
| GET | `/platform/feature-flags/:key/overrides` | - | `[{ centre, enabled, payload, updatedAt }]` |
| GET | `/platform/tenants/:id/feature-flags` | - | `[{ key, enabled, source: "TENANT" \| "GLOBAL" \| "NONE", globalDefault, payload }]` |
| PUT | `/platform/tenants/:id/feature-flags/:key` | `{ enabled, payload? }` | the flag as it now applies to the centre |
| DELETE | `/platform/tenants/:id/feature-flags/:key` | - | the flag after falling back to the default |
| GET | `/feature-flags` | - (any member of a centre, also when suspended) | `{ "<key>": true \| false }` for the member's own centre |

Keys: 2-60 characters, lowercase letters, digits, `.`, `_`, `-`, starting with a letter.

**Resolution: the centre's own row > the global default > off.** An override carries its own `payload`.
For code, the injectable `FeatureFlags` service is exported by the (global) platform module:

```ts
constructor(private readonly flags: FeatureFlags) {}
if (await this.flags.isEnabled('new_quotation_editor', tx)) { ... }   // current centre; tx optional
const settings = await this.flags.payload('new_quotation_editor');
```

Outside a tenant context only the global default applies. A centre can read its own rows and the defaults
and cannot write any (database grants).

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/platform/settings` | - | `[{ key, description, usedBy, value, isDefault, defaultValue, updatedAt }]` |
| GET | `/platform/settings/:key` | - | one setting |
| PUT | `/platform/settings/:key` | `{ value }` | the setting (`422 INVALID_SETTING` with `details: [{ path, message }]`) |
| DELETE | `/platform/settings/:key` | - | the setting, back at its default |

**Allow-list.** Only these keys exist as far as the API is concerned; any other row of `platform_settings`
(for example the subscription invoice counter) is invisible and answers `404`:

| Key | Value | Default | Read by |
| --- | --- | --- | --- |
| `subscriptions.policy` | `{ renewalLeadDays, trialReminderDays, retryDelaysDays[], graceDays, taxRatePercent }` (all optional) | `7, 3, [1, 2], 7, 0` | subscriptions |
| `integrations.approvedProviders` | `["CATEGORY/provider", ...]` or `null` | `null` = all | integrations. Changing it here has the same effect as `PUT /platform/integrations/approved-providers`, including switching off withdrawn providers. |
| `supportAccess.policy` | `{ maxDurationMinutes (5..1440), pendingExpiryDays (1..30) }` | `1440, 7` | support access |
| `offboarding.policy` | `{ minPurgeDelayDays (30..3650) }` | `30` | offboarding |

## 6. Platform staff (`platform.staff.manage`)

| Method | Path | Body / query | Response |
| --- | --- | --- | --- |
| GET | `/platform/staff` | `role?, status?, q?` | `[{ id, email, fullName, role, roleName, status, mfaEnabled, invitationPending, lastLoginAt, createdAt, isYou }]` |
| POST | `/platform/staff` | `{ email, fullName, role: "SUPER_ADMIN" \| "SUPPORT_AGENT" }` | `201` staff member |
| PATCH | `/platform/staff/:id` | `{ role?, fullName? }` | staff member |
| POST | `/platform/staff/:id/invitation` | - | `{ status: "SENT", email }` |
| POST | `/platform/staff/:id/disable` | - | staff member |
| POST | `/platform/staff/:id/enable` | - | staff member |

- A new member gets an email with a link to `PLATFORM_ADMIN_URL/reset-password?token=...` (valid 72
  hours). It is the ordinary password-reset token: the person chooses a password with
  `POST /auth/password/reset` and then signs in with `app: "platform"`. Sending the invitation again
  replaces the link (`409 ALREADY_ACTIVATED` once a password exists).
- The email must not belong to an existing account of a typing centre (`409 EMAIL_IN_USE`): platform staff
  use a separate address.
- A role change takes effect on the person's next request (permissions are read from the account each time).
- Disabling ends all sessions of the person and closes every support access they had requested or held.
- **Nobody can change the role of, disable or enable their own account** (`403 SELF_CHANGE`).
- **There is always one active Super Admin**: demoting or disabling the last one is
  `409 LAST_SUPER_ADMIN`, also when two Super Admins act on each other at the same moment (the changes are
  serialised).
- Audit: `platform.staff_created`, `_role_changed`, `_updated`, `_disabled`, `_enabled`,
  `_invitation_resent`; security events `PLATFORM_STAFF_CREATED`, `PLATFORM_ROLE_CHANGED` (HIGH),
  `PLATFORM_STAFF_DISABLED` (HIGH), `PLATFORM_STAFF_ENABLED`.

## 7. Platform audit and security events (`platform.audit.read`)

| Method | Path | Query | Response |
| --- | --- | --- | --- |
| GET | `/platform/audit-logs` | `page, pageSize, q, action (prefix), resourceType, resourceId, actorUserId, actorType, from, to` | paged entries without `before` / `after` |
| GET | `/platform/audit-logs/:id` | - | one entry with `before` / `after` |
| GET | `/platform/security-events` | `page, pageSize, type, severity, centreId, platformOnly, userId, from, to` | paged `{ id, type, severity, details, userId, ip, createdAt, centre: { id, name, slug } \| null }` |
| GET | `/platform/security-events/summary` | `from?, to?` (default the last 7 days) | `{ total, bySeverity, byType: [{ type, severity, count }] }` |

**Only platform-level audit entries** (`tenantId IS NULL`) are readable here: what TypEase staff and
platform jobs did. That restriction is part of every query, not a filter the caller could leave out; a
centre's own entries - and with them the `before` / `after` values of its records - answer `404`. Platform
actions that concern a centre are written twice on purpose (once here, once on the centre's trail).

Security events of all centres are listed (failed sign-ins, permission denials, refresh-token reuse,
webhook signature failures, support access, tenant status changes, purge failures ...).

## 8. Monitoring

`GET /internal/metrics` - `@Internal()`: needs the header `x-internal-token: <INTERNAL_API_TOKEN>`; a staff
login is not enough, and the reverse proxy should not expose `/api/v1/internal/*`. Prometheus text format
0.0.4. Values are read from the database and the queue at scrape time, so every API replica reports the
same numbers (except the two process gauges).

| Metric | Meaning |
| --- | --- |
| `typease_process_uptime_seconds`, `typease_process_resident_memory_bytes`, `typease_process_heap_used_bytes` | this API process |
| `typease_database_up`, `typease_queue_up{driver}` | 1 / 0 |
| `typease_tenants{status}` | centres by status (lowercase) |
| `typease_outbox_pending`, `typease_outbox_processing`, `typease_outbox_failed`, `typease_outbox_oldest_pending_seconds` | the event outbox |
| `typease_queue_jobs{state="waiting\|active\|delayed\|failed"}` | BullMQ job counts; in single-process mode the in-memory queue of this process (`failed` = dead letters) |
| `typease_notifications_failed` | notifications created in the last hour that ended as FAILED |
| `typease_notification_delivery_attempts_failed` | failed provider delivery attempts in the last hour |

**HTTP request rates and latencies are not instrumented** in the API; take them from the reverse proxy.
The worker has its own health endpoint (`docs/architecture/WORKER.md`).

## 9. Background jobs and events

| Job | Schedule | What it does |
| --- | --- | --- |
| `platform.offboarding` | daily `40 2 * * *` UTC, and at once after an immediate offboarding | permanently deletes centres whose date has passed |
| `platform.access_grants_expiry` | every 60 seconds | marks expired grants, ends their sessions, lapses unanswered requests |

Domain events:

| Event | Emitted when | Payload | Consumed by |
| --- | --- | --- | --- |
| `support_access.requested` | TypEase staff ask a centre for access (system outbox, same transaction as the grant; `tenantId` = the centre) | `{ grantId, requestedById, requesterName, durationMinutes, scopes, ticketId }` | notifications module: tells the centre's deciders |
| `support_access.decided` | the centre approves, denies or revokes (tenant transaction, `by: "CENTRE"`); a Super Admin ends somebody else's grant (`by: "PLATFORM"`, `actorUserId`) | `{ grantId, status: APPROVED \| DENIED \| REVOKED, previousStatus, by, expiresAt? }` | this module (`platform.support-access`): emails the requester |

## 10. Error codes

| Code | HTTP | Meaning |
| --- | --- | --- |
| `PLATFORM_ONLY` | 403 | a `/platform/*` route was called without a platform session |
| `SLUG_TAKEN`, `EMAIL_IN_USE`, `PHONE_IN_USE`, `ACCOUNT_DISABLED` | 409 | creating a centre |
| `PLAN_NOT_AVAILABLE` | 422 | unknown, inactive or private plan |
| `NOT_PENDING_APPROVAL`, `ALREADY_SUSPENDED`, `NOT_SUSPENDED`, `TENANT_NOT_ACTIVE`, `ALREADY_ARCHIVED` | 409 | the action does not fit the centre's status |
| `SUSPENDED_FOR_NON_PAYMENT` | 409 | fix billing instead of reactivating |
| `SUPER_ADMIN_ONLY` | 403 | offboarding |
| `CONFIRMATION_MISMATCH`, `IMMEDIATE_CONFIRMATION_REQUIRED`, `PURGE_DELAY_TOO_SHORT` | 422 | offboarding confirmations |
| `OFFBOARDING_SCHEDULED`, `OFFBOARDING_NOT_SCHEDULED`, `OFFBOARDING_DUE` | 409 | offboarding state |
| `SCOPE_NOT_GRANTABLE`, `DURATION_TOO_LONG`, `TICKET_NOT_FOUND`, `SCOPE_NOT_REQUESTED` | 422 | support access request / approval |
| `ACCESS_ALREADY_OPEN`, `ACCESS_NOT_APPROVED`, `ACCESS_ALREADY_DECIDED`, `ACCESS_ALREADY_CLOSED`, `TENANT_UNAVAILABLE` | 409 | support access state |
| `SUPPORT_ACCESS_SCOPE`, `SUPPORT_ACCESS_READ_ONLY` | 403 | a support session called a route outside its granted scopes / tried to change something |
| `HANDOFF_INVALID` | 400 | support-session hand-off code unknown, used, expired or replaced |
| `SUPPORT_ACCESS_ENDED` | 403 / 401 | the grant was denied, revoked or has expired (401 when a support token is used after that; a revoked session answers `SESSION_EXPIRED`) |
| `INVALID_SETTING` | 422 | a platform setting failed validation |
| `SELF_CHANGE` | 403 | changing your own platform account |
| `LAST_SUPER_ADMIN`, `ALREADY_STAFF`, `ALREADY_ACTIVATED`, `ALREADY_DISABLED`, `ALREADY_ACTIVE` | 409 | platform staff |
| `RANGE_TOO_LONG` | 400 | a report range with too many steps (more than 400) |

## 11. Custom domains: claims, release and the plan

Code: `services/api/src/modules/tenancy/branding.service.ts`, `tenant-resolver.service.ts`; tests:
`services/api/test/domains.spec.ts`. A domain belongs to at most one centre (unique in the database).

### The centre (`domain.manage`)

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/domains` | - | `{ platformDomain, customDomainsIncluded, domains: [domain] }` |
| POST | `/domains` | `{ domain, app = "customer" }` | `201` domain, status `PENDING`, with the DNS records to create |
| POST | `/domains/:id/verify` | - | domain + `{ verified, message }` |
| DELETE | `/domains/:id` | - | `{ "status": "REMOVED" }` |

```json
{ "id": "...", "tenantId": "...", "domain": "portal.alpha.ae", "kind": "CUSTOM", "app": "customer",
  "status": "PENDING", "routed": false, "isPrimary": false,
  "verifiedAt": null, "lastCheckedAt": null, "lastCheckError": null, "createdById": "...", "createdAt": "2026-10-09T08:00:00.000Z", "updatedAt": "...",
  "claim": { "releasableAt": "2026-10-12T08:00:00.000Z", "expiresAt": "2026-10-23T08:00:00.000Z" },
  "dns": { "txt": { "name": "_typease-verify.portal.alpha.ae", "value": "typease-verify=..." },
           "cname": { "name": "portal.alpha.ae", "value": "portal.typease.example" }, "note": "..." } }
```

- `status`: `PENDING` (claimed, not checked or not found yet), `FAILED` (last DNS check did not match),
  `VERIFIED`, `DISABLED` (centre offboarded), and the derived value **`SUSPENDED_BY_PLAN`**: the domain is
  verified but the centre's plan does not include custom domains (plan feature `customDomains`). It is not a
  stored value: the row stays `VERIFIED`.
- `routed`: `true` only while the portal is reachable on the domain (`VERIFIED` and included in the plan).
- `claim` (unverified domains only): `releasableAt` = created + 72 hours, `expiresAt` = created + 14 days.
- `dns` is `null` once verified.
- Errors of `POST /domains`: `400 DOMAIN_NOT_ALLOWED` (a TypEase address), `402 PLAN_LIMIT_REACHED`
  (`details.limit = "customDomains"`), `409 DOMAIN_ALREADY_ADDED` (already on this centre's list),
  `409 DOMAIN_IN_USE` (held by another account; the answer never says by whom).

### Unverified claims do not block for ever

- A claim that was **never verified** (`PENDING` or `FAILED`, `verifiedAt` empty) blocks other centres for
  **72 hours** (`DOMAIN_CLAIM_RELEASE_HOURS`). After that, the next centre that claims the domain - and whose
  plan includes custom domains - gets it: the old claim is deleted in the same request and the new claim starts
  `PENDING` with a new verification token (the old centre's DNS record proves nothing for it). Of two centres
  that claim a released domain at the same moment exactly one succeeds; the other gets `409 DOMAIN_IN_USE`.
- Job `tenancy.domain_claims_cleanup` (daily 03:10 UTC) deletes never-verified claims older than **14 days**
  (`DOMAIN_CLAIM_EXPIRY_DAYS`). Nobody is notified.
- Both are recorded on the trail of the centre that held the claim: `domain.claim_released`,
  `after.reason = "SUPERSEDED" | "EXPIRED"` (the entry does not name the other centre).
- **A verified domain is never released automatically**, however old, and neither is one that is
  suspended by the plan or disabled by offboarding.

### Platform staff

| Method | Path | Permission | Body / query | Response |
| --- | --- | --- | --- | --- |
| GET | `/platform/domains` | `platform.tenants.read` | `q?` (part of the name), `status?`, `centreId?`, `page`, `pageSize`, `sort?` (`createdAt`, `domain`, `status`) | paged domains with `centre: { id, slug, name, status, planKey }`, `ageHours`, `routed`, derived `status` (no verification token) |
| DELETE | `/platform/domains/:id` | `platform.tenants.manage` | `{ "reason": "5 to 500 characters" }` | `{ "id": "...", "domain": "portal.alpha.ae", "status": "RELEASED" }` |

`DELETE` removes any claim, verified or not (ownership dispute, a claim made by mistake). It takes effect at
once (routing and certificate check). If the released domain was the centre's primary one, its oldest remaining
verified domain becomes primary. Audit: `domain.released_by_platform` on the platform trail and on the centre's
trail, with what the domain was (`before`) and the reason. `404` for an unknown id, `400` without a reason.

### A verified domain follows the plan

- Host resolution (`GET /public/tenant-config?host=`, the tenant picked from the `Origin` / `X-Tenant-Host`
  header, CORS for the domain's origin) and the reverse proxy's on-demand TLS check
  (`GET /internal/tls/ask?domain=` answers `404` = "do not issue a certificate") accept a custom domain only
  while it is `VERIFIED` **and** the centre's current plan has `customDomains: true`. No subscription counts
  as "not included".
- Links the system builds for customers (`portalLink`: emails, renewal links) fall back to the shared portal
  address with `?tenant=<slug>` while the domain is suspended. `<slug>.<PLATFORM_BASE_DOMAIN>` always works.
- When the plan includes the feature again the domain resolves again; nothing has to be verified again.
- Resolution answers are cached for 30 seconds per API instance. Verifying, removing or releasing a domain
  clears the cache at once on the instance that handled it; a plan change is visible after 30 seconds at the
  latest.
- A certificate that was already issued is not revoked: the reverse proxy keeps serving TLS for the host,
  but the API no longer maps the host to a centre (the portal shows "centre not found") and the certificate
  is not renewed.

