# TypEase backend conventions

How every business module in `services/api` is written. Read this before adding or changing a module.

## 1. Layout

```
services/api/src/
  config/env.ts               every environment variable (validated at boot)
  common/                     shared infrastructure (do not duplicate it in modules)
  modules/<name>/             one folder per business module
      <name>.module.ts        auto-discovered: no registration anywhere else
      <name>.controller.ts    HTTP only: access rule, DTO, call the service
      <name>.service.ts       business rules, transactions, audit, events
      <name>.spec.ts          integration tests against the real database
database/prisma/schema.prisma the data model (107 tables) - the contract between modules
packages/validation/src/<group>.ts   Zod schemas shared by API and web apps
packages/types               generated entity types + shared constants (state machine, events)
packages/permissions         permission catalogue + default role matrix
```

Reference implementations: `modules/tenancy/organisation.service.ts`, `modules/tenancy/branding.service.ts`,
`modules/tenancy/tenancy.controller.ts`, `test/foundation.spec.ts`, `test/helpers.ts`.

## 2. Data access and tenant isolation (non-negotiable)

- Inject `TenantDb` and do ALL tenant data access inside `this.db.tx(async (tx) => { ... })`.
  The transaction binds the tenant from the verified request context; PostgreSQL row-level security then
  restricts every statement to that tenant. Nested `tx()` calls join the outer transaction.
- Still write `tenantId: this.db.tenantId` in every `where` and `create` (defence in depth, and it uses the indexes).
- Never take a tenant id from the request body, query or params.
- Look rows up with `findFirst({ where: { id, tenantId } })` and wrap in `found(row, 'Customer')`: a row of another
  tenant must be a 404, never a 403.
- Before storing a foreign key that came from the client, load the referenced row in the same tenant (a database
  trigger also rejects cross-tenant references).
- `SystemDb` (not subject to RLS) is only for code that is cross-tenant by nature. The allow-list is in
  `test/architecture.spec.ts`. Scheduled jobs fan out with `TenantDirectory.forEachTenant()` instead.
- Tables are snake_case, columns camelCase. In raw SQL quote columns: `"tenantId"`.
- Money: `Decimal(14,2)`; use `D()`, `money()`, `sum()` from `common/pagination`. Never use JS numbers for money.
  API responses carry money as strings.
- The database enforces: check constraints, append-only tables (audit_logs, request_status_history,
  document_access_logs, consent_records, payment_allocations, liability_entries, security_events), invoice /
  payment immutability, one published workflow/form version. See `database/migrations/0003_integrity.sql`.

## 3. Request context

`ctx()` (from `common/context`) is the verified security context: `tenantId`, `userId`, `actorType`
(`STAFF | CUSTOMER | CORPORATE | PLATFORM | SYSTEM | AUTOMATION`), `membershipId`, `roleKey`, `permissions`,
`allBranches`, `branchIds`, `customerId`, `corporateAccountId`, `supportGrantId`, `ip`, `requestId`.

Resource-level scoping helpers (`common/scope`):
`branchFilter()`, `assertBranchAccess(branchId)`, `ownCustomerId()`, `ownCorporateAccountId()`, plus `can()`,
`canAny()`, `isStaff()`, `isCustomer()`, `isCorporate()`.

Rules:
- Staff limited to branches (`allBranches=false`) only see rows of their branches.
- Customers only ever see their own customer record and what hangs off it. Corporate users only their company.
- Operators with `request.read.assigned` (and not `request.read.all`) see only requests assigned to them.
- Internal notes, internal comments and staff-only fields are never returned to customers / corporate users.

## 4. Controllers

Every route needs exactly one access declaration (a route without one is rejected at runtime):

```ts
@Permissions('customer.read')            // tenant member holding ANY listed permission
@AllPermissions('a', 'b')                // ALL listed
@TenantMember({ kinds: ['CUSTOMER'] })   // any member of that kind (then scope by ownCustomerId())
@Authenticated()                         // any signed-in user, no tenant needed
@Platform('platform.tenants.read')       // platform staff, no tenant data
@Public()                                // no auth - add @RateLimit(...)
```

- Body / query validation: Zod schema in `packages/validation/src/<group>.ts`, then
  `class CreateXDto extends dto(createXSchema) {}` (`common/zod`). Path ids: `@Param('id', ParseUUIDPipe)`.
- Tag with `@ApiTags(...)` and `@ApiBearerAuth()`.
- Lists: accept `pageQuery`, use `pageArgs(query, ALLOWED_SORT, 'createdAt:desc')` and return
  `pageResult(data, total, query)` -> `{ data, meta: { page, pageSize, total, totalPages } }`.
- Errors: `throw Errors.notFound('Invoice')`, `Errors.conflict('CODE', 'Plain-language message')`,
  `Errors.unprocessable(...)`, `Errors.forbidden(...)`, `Errors.notConfigured('WhatsApp', 'Add the credentials in Settings > Integrations.')`.
  Messages are read by receptionists and customers: say what happened and what to do next.

## 5. Cross-cutting services (all injectable from the global CoreModule)

| Need | Use |
| --- | --- |
| Audit trail (every create / update / delete / decision) | `audit.log({ action: 'invoice.voided', resourceType: 'Invoice', resourceId, before, after }, tx)` |
| Security event | `audit.security('WEBHOOK_SIGNATURE_INVALID', 'HIGH', {...})` |
| Human-readable numbers | `sequences.next(tx, 'invoice')` -> `INV-000042` (gap-free, per tenant) |
| Plan limits / features | `usage.assertWithinLimit('monthlyRequests', tx)`, `usage.assertFeature('automation', tx)`, `usage.record('notifications', 1, tx)` |
| Domain events | `events.emit(tx, 'payment.completed', payload)` |
| Background jobs | `jobs.register('x.do', handler)`, `jobs.enqueue('x.do', { tenantId, ... })`, `jobs.schedule({ name, cron, description })` |
| Encryption / hashing | `encryptText`, `decryptText`, `blindIndex`, `sha256`, `randomToken`, `signPayload`, `verifyPayload` (`common/crypto`) |
| Account-security messages | `Messenger` (verification, reset, OTP, invitations only) |
| Tenant defaults | `provisioning.registerTenantStep(name, async (tx, tenant) => {...})` in `onModuleInit` (idempotent) |
| Platform defaults | `provisioning.registerGlobalStep(name, async (tx) => {...})` |
| File type sniffing | `detectMime(buffer)`, `safeFilename(name)` (`common/files`) |
| Erased customers (`common/customer-ref`) | before attaching anything new to a customer: `await assertCustomerNotErased(tx, tenantId, customerId)` (409 `CUSTOMER_ERASED`); wherever a customer is embedded select `status` and pass the row through `customerRef()` / `embedCustomerRef()` so the response carries `erased` instead of the record status; flat views use `isErasedCustomer(row.customer)` |
| Worker liveness | `WorkerHeartbeat` (`common/jobs/worker-heartbeat`) is started by the worker and by the API in single-process mode; `liveness()` feeds `GET /platform/system/health` |

Job handlers receive `(payload, meta)` and run inside `runAsTenant(payload.tenantId)` automatically. They MUST be
idempotent (a job can run twice). Enqueue after commit: `this.db.afterCommit(() => this.jobs.enqueue(...))`.

## 6. Domain events (contract between modules)

Emit inside the business transaction. `events.on(type, (event, tx) => ...)` runs in the same transaction
(use it to keep another aggregate consistent). `events.subscribe(name, types, handler)` runs after commit,
at least once (notifications, automations).

| Event | Payload |
| --- | --- |
| `customer.created` | `{ customerId, source }` |
| `customer.merged` | `{ sourceId, targetId, sourceCustomerNo, targetCustomerNo }` |
| `request.created` | `{ requestId, customerId, serviceId, branchId, source }` |
| `request.submitted` | `{ requestId, customerId }` |
| `request.assigned` | `{ requestId, customerId, assigneeMembershipId, assigneeUserId, role, method }` |
| `request.status_changed` | `{ requestId, customerId, from, to, customerVisible, customerMessage?, reason? }` |
| `request.information_requested` | `{ requestId, customerId, message }` |
| `request.completed` / `request.cancelled` | `{ requestId, customerId, reason? }` |
| `request.overdue` | `{ requestId, customerId, assigneeUserId? }` |
| `request.step_overdue` | `{ requestId, stepKey, stepName, escalateToRoleKey? }` |
| `document.uploaded` | `{ documentId, versionId, customerId?, corporateAccountId?, requestId?, checklistItemId?, documentTypeKey, uploadedByType }` |
| `document.verified` | `{ documentId, customerId?, requestId?, documentTypeKey, expiryDate? }` |
| `document.rejected` | `{ documentId, customerId?, requestId?, documentTypeKey, reason }` |
| `document.expiry_changed` | `{ documentId, customerId?, corporateAccountId?, requestId?, documentTypeKey, expiryDate?, previousExpiryDate?, expiryVerified, source: MANUAL \| OCR }` (a staff edit and "apply" of an OCR result emit the same event) |
| `document.expiring` | `{ scheduleId, documentId?, customerId?, corporateAccountId?, documentTypeKey, subjectLabel, expiryDate, daysLeft }` |
| `quotation.sent` | `{ quotationId, requestId?, customerId, total, currency }` |
| `quotation.approved` | `{ quotationId, requestId?, customerId, approvedByType }` |
| `quotation.rejected` | `{ quotationId, requestId?, customerId, reason }` |
| `invoice.issued` | `{ invoiceId, requestId?, customerId, total, currency }` |
| `invoice.voided` | `{ invoiceId, requestId?, customerId, total, currency, reason }` (only for an invoice that had been issued; a voided draft emits nothing) |
| `creditnote.issued` | `{ creditNoteId, creditNoteNo, invoiceId, requestId?, customerId, amount, currency, refundId? }` |
| `payment.requested` | `{ invoiceId, requestId?, customerId, amount, currency }` |
| `payment.completed` | `{ paymentId, customerId?, amount, currency, method, invoiceIds: string[], requestIds: string[] }` |
| `payment.failed` | `{ paymentId, customerId?, reason }` |
| `refund.requested` | `{ refundId, paymentId, requestId?, amount, currency }` |
| `refund.completed` | `{ refundId, paymentId, invoiceId?, requestId?, amount, currency }` |
| `appointment.created` | `{ appointmentId, customerId?, branchId, startsAt }` |
| `appointment.reminder_due` | `{ appointmentId, customerId?, branchId, startsAt, hoursBefore }` |
| `ticket.created` | `{ ticketId, customerId?, requestId?, scope }` |
| `ticket.replied` | `{ ticketId, customerId?, authorType, visibility }` |
| `subscription.renewal_due` | `{ subscriptionId, dueAt, amount, currency }` |
| `subscription.payment_failed` | `{ subscriptionId, invoiceId, invoiceNumber, amount, currency, reason, attempt? }` |
| `staff.invited` | `{ membershipId, email, roleKey }` |
| `support_access.requested` | `{ grantId, requestedById, requesterName?, durationMinutes, scopes, ticketId? }` (emitted by the platform module on the system connection, in the transaction that creates the request) |
| `support_access.decided` | `{ grantId, status: APPROVED \| DENIED \| REVOKED, previousStatus, by: CENTRE \| PLATFORM, expiresAt?, actorUserId? }` |

The names are the keys of `DOMAIN_EVENTS` in `packages/types/src/events.ts` (the source of truth; add an event
there first). There is no `user.registered` domain event (the key was listed but never emitted, and was removed):
self-registration writes the audit action `user.registered` and emits `customer.created` with
`source: "SELF_REGISTRATION"`, which is what the welcome message and automations react to.

Every payload also carries `_actor` (`{ userId, type }`), added by `DomainEvents.emit`. Not every state
change has an event: closing an abandoned online payment (`payment.checkout_expired`), releasing an unverified
domain claim and the calls of a support session are audit entries only, because no other module reacts to them.

### Who writes which tables

A module may READ any tenant table, but WRITES only its own tables. Everything else happens through events.

| Module | Owns |
| --- | --- |
| customers | customers, customer_contacts, customer_notes, customer_tags(+assignments), customer_consents, consent_records |
| corporate | corporate_accounts, corporate_members, corporate_employees, corporate_agreements, corporate_prices |
| catalogue | service_categories, document_types, services, service_branches, service_prices, service_requirements, service_form_definitions |
| workflows / requests | workflow_*, service_requests, request_* (incl. the document checklist `request_documents`), workflow tasks |
| documents / ocr / privacy | documents, document_versions, document_access_logs, document_shares, document_verification_results, ocr_extraction_results, ai_usage_logs, data_retention_policies, data_subject_requests, security_incidents, processor_records |
| finance | fee_components, quotations(+items), invoices(+items), payments, payment_allocations, refunds, credit_notes, expenses, liability_entries, reconciliation_records, payment_webhook_events, idempotency_keys |
| subscriptions | subscription_plans, coupons, subscriptions, subscription_invoices, subscription_events |
| notifications / reminders | notification*, device_tokens, reminder_schedules, reminder_dispatches |
| operations / support | appointments, appointment_slot_configs, branch_closures, queue_tokens, tasks, task_assignments, sla_policies, support_tickets, support_messages, customer_feedback |
| platform / integrations / reports | access_grants, feature_flags, platform_settings, integration_credentials_metadata, integration_logs, scheduled_reports |

Consequences that matter:
- `request_documents` (the checklist) is updated ONLY by the requests module, reacting to `document.*` events.
  The documents module passes `requestId` / `checklistItemId` through in the event payload.
- `service_requests.paymentStatus` is maintained by the requests module from `payment.completed` /
  `refund.completed`. Finance never writes to service_requests.
- Notifications are created only by the notifications module, from events.

## 7. External integrations

Nothing may pretend to work. For every external service: an interface, at least one real adapter, a `log`
adapter for development where meaningful, and a clear `INTEGRATION_NOT_CONFIGURED` error (HTTP 503) when
credentials are missing. Never invent credentials, live connections or successful submissions. Never call
services not approved in configuration. Outbound HTTP to user-supplied URLs must be SSRF-safe (allow-list,
no private ranges). Government portals are never automated: no scraping, CAPTCHA bypass or OTP interception.

## 8. Tests

Each module ships `*.spec.ts` integration tests that boot the real application and database:

```ts
import { TestApp, TenantFixture } from '../../../test/helpers';
let t: TestApp, alpha: TenantFixture, beta: TenantFixture;
beforeAll(async () => { t = await TestApp.create(); alpha = await t.createTenant(); beta = await t.createTenant(); });
afterAll(() => t.close());
// t.as(alpha.owner).post('/customers', {...}).expect(201)
// t.addStaff(alpha, 'receptionist'), t.addCustomer(alpha), t.createPlatformAdmin()
// t.settle()  -> deliver outbox events + run queued jobs;   t.inTenant(id, () => t.db.tx(...));   t.sys.<model>
```

Every module must prove: (1) the happy path, (2) Tenant A cannot read / change / reference Tenant B rows for each
resource, (3) roles without the permission get 403, (4) customers / corporate users only reach their own rows,
(5) the module's business rules and state transitions, including the forbidden ones.

Pure logic (parsers, calculators) gets `*.unit.spec.ts` tests that need no database.

Run: `pnpm --filter @typease/api exec jest src/modules/<name>` (database `typease_test` is rebuilt from the
migration files by `test/global-setup.ts`).

## 9. Quality bar

- No placeholder code, no `TODO`, no buttons / endpoints that do nothing, no static arrays as data sources.
- Every operational feature persists to PostgreSQL.
- Destructive or financial actions: permission + audit + transaction; approvals respect segregation of duties
  (the requester can never approve their own refund / discount).
- Do not collect or return sensitive data that is not needed. Mask identity numbers in lists.
- Documentation must describe what is implemented, not what is planned.
