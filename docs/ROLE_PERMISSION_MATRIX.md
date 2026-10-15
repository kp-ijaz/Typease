# Role and permission matrix

This document lists every permission TypEase checks, the roles that ship with it, and the rules that sit on top of the matrix (branch scope, ownership scope, segregation of duties, MFA, custom roles).
It is for centre owners deciding who gets which role, for engineers adding an endpoint, and for reviewers auditing access.

The tables between the `generated:` markers were produced by a script from the single source of truth, [`packages/permissions/src/index.ts`](../packages/permissions/src/index.ts). They were not typed by hand. To regenerate them after a change, see [Regenerating this document](#regenerating-this-document).

Related documents: [TENANT_ISOLATION.md](TENANT_ISOLATION.md) (the tenant boundary underneath every permission), [SECURITY_CHECKLIST.md](SECURITY_CHECKLIST.md), [API_DOCUMENTATION.md](API_DOCUMENTATION.md) (how a route declares its rule).

## Contents

1. [How authorisation works](#1-how-authorisation-works)
2. [Permission catalogue](#2-permission-catalogue)
3. [System roles](#3-system-roles)
4. [Matrix: tenant roles](#4-matrix-tenant-roles)
5. [Platform roles](#5-platform-roles)
6. [Support access scopes](#6-support-access-scopes)
7. [Segregation of duties](#7-segregation-of-duties)
8. [Resource scoping](#8-resource-scoping-what-a-permission-does-not-give-you)
9. [Multi-factor authentication](#9-multi-factor-authentication)
10. [Custom roles and guard rails](#10-custom-roles-and-guard-rails)
11. [Regenerating this document](#regenerating-this-document)

## 1. How authorisation works

A permission is a string such as `request.review`. There are 85 tenant permissions (70 staff, 7 `self.*`, 8 `corp.*`) and 11 platform permissions.

| Layer | What it decides | Where |
| --- | --- | --- |
| Route rule | Every HTTP route must declare one access rule. A route with none is refused with `ACCESS_NOT_DECLARED` (fail closed). | `services/api/src/common/auth/access.ts`, `auth.guard.ts` |
| Permission | `@Permissions(a, b)` needs any one of the listed keys; `@AllPermissions(a, b)` needs all. | `auth.guard.ts` |
| Membership kind | `@TenantMember({ kinds })` restricts a route to `STAFF`, `CUSTOMER` or `CORPORATE` members. | `auth.guard.ts` |
| Resource scope | A permission says what you may do, not to which rows. Services narrow rows by branch, assignment, own customer profile or own company. | `services/api/src/common/scope.ts` and the module services |
| Tenant | Independent of permissions: a row of another centre is never visible. | Row-level security; see [TENANT_ISOLATION.md](TENANT_ISOLATION.md) |

Permissions are stored per tenant in `roles` and `role_permissions`. On every request the API reloads the session, the user, the membership and the role's permissions from the database (`PrincipalService.resolve`), so a role change or a revoked session takes effect on the next request and not when the access token expires.

The access rules a route can declare:

| Decorator | Meaning |
| --- | --- |
| `@Public()` | No sign-in. Must be rate limited (checked by an architecture test). |
| `@Internal()` | Needs the header `x-internal-token` equal to `INTERNAL_API_TOKEN`. |
| `@Authenticated({ allowWithoutMfa })` | Any signed-in user. |
| `@Permissions(...keys)` | Signed-in tenant member (or support session) holding any of the keys. |
| `@AllPermissions(...keys)` | Holding all of the keys. |
| `@TenantMember({ kinds, allowSuspended, any })` | Any member of the tenant of the listed kinds. |
| `@Platform(...keys)` | Platform staff holding the platform permission. |

## 2. Permission catalogue

<!-- generated:catalogue -->

### Customers (6)

| Permission | Meaning |
| --- | --- |
| `customer.read` | View customers (identity numbers masked) |
| `customer.create` | Register customers |
| `customer.update` | Edit customer profiles, notes and tags |
| `customer.archive` | Archive or restore customers |
| `customer.merge` | Merge duplicate customer records |
| `customer.sensitive.read` | Reveal full identity document numbers (logged) |

### Corporate (3)

| Permission | Meaning |
| --- | --- |
| `corporate.read` | View corporate accounts |
| `corporate.manage` | Create and edit corporate accounts, employees and pricing |
| `corporate.verify` | Verify corporate authorisation and approve credit terms |

### Services (3)

| Permission | Meaning |
| --- | --- |
| `service.read` | View the service catalogue |
| `service.manage` | Create and edit services, prices, forms and requirements |
| `workflow.manage` | Edit and publish workflows |

### Requests (11)

| Permission | Meaning |
| --- | --- |
| `request.read.all` | View all requests in permitted branches |
| `request.read.assigned` | View requests assigned to me |
| `request.create` | Create service requests |
| `request.update` | Edit request details and form data |
| `request.assign` | Assign or reassign requests |
| `request.process` | Prepare applications and update processing status |
| `request.review` | Approve or send back prepared applications |
| `request.submit_external` | Record submission to an authority or partner |
| `request.cancel` | Cancel requests |
| `request.reopen` | Reopen completed requests |
| `request.comment.internal` | Read and write internal notes |

### Documents (7)

| Permission | Meaning |
| --- | --- |
| `document.read` | View and download documents |
| `document.upload` | Upload documents |
| `document.verify` | Verify or reject documents |
| `document.delete` | Delete documents |
| `document.share` | Create secure share links |
| `ocr.run` | Run AI-assisted extraction |
| `ocr.review` | Confirm or correct extracted data |

### Finance (13)

| Permission | Meaning |
| --- | --- |
| `quotation.read` | View quotations |
| `quotation.manage` | Create and send quotations |
| `discount.approve` | Approve discounts |
| `invoice.read` | View invoices |
| `invoice.manage` | Create, issue and void invoices |
| `payment.read` | View payments |
| `payment.record` | Record payments and print receipts |
| `payment.reconcile` | Reconcile payments and settlements |
| `refund.request` | Request refunds |
| `refund.approve` | Approve and process refunds |
| `creditnote.manage` | Issue credit notes |
| `expense.manage` | Record expenses and fee remittances |
| `finance.settings` | Configure fee treatment, tax and payment methods |

### Reports (3)

| Permission | Meaning |
| --- | --- |
| `report.operational` | View operational reports |
| `report.financial` | View financial reports |
| `report.export` | Export and schedule reports |

### Operations (5)

| Permission | Meaning |
| --- | --- |
| `appointment.read` | View appointments |
| `appointment.manage` | Book, reschedule and cancel appointments |
| `queue.manage` | Issue and call queue tokens |
| `task.read` | View tasks |
| `task.manage` | Create, assign and complete tasks |

### Organisation (5)

| Permission | Meaning |
| --- | --- |
| `branch.read` | View branches |
| `branch.manage` | Create and edit branches |
| `staff.read` | View staff and workload |
| `staff.manage` | Invite staff, assign branches and schedules |
| `role.manage` | Create roles and change permissions |

### Communication (4)

| Permission | Meaning |
| --- | --- |
| `notification.manage` | Edit notification templates and channels |
| `reminder.read` | View expiry reminders |
| `reminder.manage` | Create and edit expiry reminders |
| `automation.manage` | Configure automations |

### Support (2)

| Permission | Meaning |
| --- | --- |
| `ticket.read` | View support tickets |
| `ticket.manage` | Reply to, assign and resolve support tickets |

### Administration (8)

| Permission | Meaning |
| --- | --- |
| `branding.manage` | Change white-label branding |
| `domain.manage` | Manage custom domains |
| `settings.manage` | Change centre settings |
| `subscription.manage` | Manage the TypEase subscription |
| `integration.manage` | Configure integrations and credentials |
| `audit.read` | View the audit trail |
| `privacy.manage` | Handle privacy requests, retention and consent |
| `support_access.decide` | Approve or deny TypEase support access |

### Self-service (7)

| Permission | Meaning |
| --- | --- |
| `self.profile` | Manage my own profile |
| `self.requests` | Create and track my own requests |
| `self.documents` | Upload and download my own documents |
| `self.payments` | View and pay my own quotations and invoices |
| `self.appointments` | Book my own appointments |
| `self.tickets` | Contact support |
| `self.privacy` | Manage consent and privacy requests |

### Corporate portal (8)

| Permission | Meaning |
| --- | --- |
| `corp.account.read` | View the company account |
| `corp.account.manage` | Manage company contacts |
| `corp.employees.read` | View authorised employee records |
| `corp.employees.manage` | Add and edit employee records |
| `corp.requests.read` | Track company requests |
| `corp.requests.create` | Create company requests |
| `corp.requests.approve` | Approve company requests and quotations |
| `corp.invoices.read` | View company invoices |
<!-- /generated:catalogue -->

## 3. System roles

Nine roles are created in every centre when it is provisioned (`ProvisioningService`). `Kind` decides which application the role can sign in to: `STAFF` uses the staff app, `CUSTOMER` the customer portal and mobile app, `CORPORATE` the corporate portal.

<!-- generated:roles -->
| Role key | Name | Arabic name | Kind | Permissions | MFA required | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `owner` | Centre Owner | مالك المركز | STAFF | 70 | yes | Full control of the typing centre. |
| `manager` | Centre Manager | مدير المركز | STAFF | 57 | yes | Runs assigned branches: staff, cases, schedules and operational reports. |
| `receptionist` | Receptionist | موظف الاستقبال | STAFF | 23 | no | Registers customers, starts requests, takes payments and books appointments. |
| `operator` | Typing Operator | موظف الطباعة | STAFF | 18 | no | Prepares assigned applications and records submission references. |
| `reviewer` | Document Reviewer | مدقق المستندات | STAFF | 12 | no | Verifies documents and extracted data, approves or returns cases. |
| `accountant` | Accountant | المحاسب | STAFF | 18 | yes | Invoices, reconciliation, government-fee liabilities, expenses and financial reports. |
| `customer` | Customer | العميل | CUSTOMER | 7 | no | Self-service access to own profile, requests, documents and payments. |
| `corporate_admin` | Corporate Administrator | مسؤول الشركة | CORPORATE | 9 | no | Manages the company account, employee records, requests and invoices. |
| `corporate_employee` | Corporate Employee | موظف الشركة | CORPORATE | 5 | no | Sees only their own records and requests. |
<!-- /generated:roles -->

Notes on the shipped roles:

- **Owner** always holds the complete staff catalogue. When a release adds a staff permission, role synchronisation gives it to every owner role. Other system roles only gain the permissions the release assigns to them; a permission a centre removed from a system role is not put back unless it is new in that release.
- **Manager** is the owner minus thirteen permissions: `payment.reconcile`, `refund.approve`, `creditnote.manage`, `finance.settings`, `branch.manage`, `role.manage`, `branding.manage`, `domain.manage`, `settings.manage`, `subscription.manage`, `integration.manage`, `privacy.manage`, `support_access.decide`.
- **Corporate employee** exists as a role with five permissions, but no endpoint creates a sign-in for a corporate employee at packaging time. Only corporate administrators (authorised contacts) can be invited. See [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).

## 4. Matrix: tenant roles

`Y` means the role holds the permission as shipped. `-` means it does not. A centre can change every role except the locked ones (section 10), so the live matrix of a centre is the one shown in the staff app under **Roles**, or returned by `GET /api/v1/roles`.

<!-- generated:matrix -->

**Customers**

| Permission | Owner | Manager | Recep. | Operator | Reviewer | Account. | Customer | Corp. admin | Corp. empl. |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `customer.read` | Y | Y | Y | Y | Y | Y | - | - | - |
| `customer.create` | Y | Y | Y | - | - | - | - | - | - |
| `customer.update` | Y | Y | Y | - | - | - | - | - | - |
| `customer.archive` | Y | Y | - | - | - | - | - | - | - |
| `customer.merge` | Y | Y | - | - | - | - | - | - | - |
| `customer.sensitive.read` | Y | Y | - | - | - | - | - | - | - |

**Corporate**

| Permission | Owner | Manager | Recep. | Operator | Reviewer | Account. | Customer | Corp. admin | Corp. empl. |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `corporate.read` | Y | Y | Y | - | - | Y | - | - | - |
| `corporate.manage` | Y | Y | - | - | - | - | - | - | - |
| `corporate.verify` | Y | Y | - | - | - | - | - | - | - |

**Services**

| Permission | Owner | Manager | Recep. | Operator | Reviewer | Account. | Customer | Corp. admin | Corp. empl. |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `service.read` | Y | Y | Y | Y | Y | Y | - | - | - |
| `service.manage` | Y | Y | - | - | - | - | - | - | - |
| `workflow.manage` | Y | Y | - | - | - | - | - | - | - |

**Requests**

| Permission | Owner | Manager | Recep. | Operator | Reviewer | Account. | Customer | Corp. admin | Corp. empl. |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `request.read.all` | Y | Y | Y | - | Y | Y | - | - | - |
| `request.read.assigned` | Y | Y | - | Y | - | - | - | - | - |
| `request.create` | Y | Y | Y | - | - | - | - | - | - |
| `request.update` | Y | Y | Y | Y | - | - | - | - | - |
| `request.assign` | Y | Y | - | - | - | - | - | - | - |
| `request.process` | Y | Y | - | Y | - | - | - | - | - |
| `request.review` | Y | Y | - | - | Y | - | - | - | - |
| `request.submit_external` | Y | Y | - | Y | - | - | - | - | - |
| `request.cancel` | Y | Y | - | - | - | - | - | - | - |
| `request.reopen` | Y | Y | - | - | - | - | - | - | - |
| `request.comment.internal` | Y | Y | Y | Y | Y | - | - | - | - |

**Documents**

| Permission | Owner | Manager | Recep. | Operator | Reviewer | Account. | Customer | Corp. admin | Corp. empl. |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `document.read` | Y | Y | Y | Y | Y | - | - | - | - |
| `document.upload` | Y | Y | Y | Y | - | - | - | - | - |
| `document.verify` | Y | Y | - | Y | Y | - | - | - | - |
| `document.delete` | Y | Y | - | - | - | - | - | - | - |
| `document.share` | Y | Y | - | - | - | - | - | - | - |
| `ocr.run` | Y | Y | - | Y | Y | - | - | - | - |
| `ocr.review` | Y | Y | - | - | Y | - | - | - | - |

**Finance**

| Permission | Owner | Manager | Recep. | Operator | Reviewer | Account. | Customer | Corp. admin | Corp. empl. |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `quotation.read` | Y | Y | Y | Y | - | Y | - | - | - |
| `quotation.manage` | Y | Y | Y | - | - | - | - | - | - |
| `discount.approve` | Y | Y | - | - | - | - | - | - | - |
| `invoice.read` | Y | Y | Y | Y | - | Y | - | - | - |
| `invoice.manage` | Y | Y | - | - | - | Y | - | - | - |
| `payment.read` | Y | Y | Y | - | - | Y | - | - | - |
| `payment.record` | Y | Y | Y | - | - | Y | - | - | - |
| `payment.reconcile` | Y | - | - | - | - | Y | - | - | - |
| `refund.request` | Y | Y | - | Y | - | Y | - | - | - |
| `refund.approve` | Y | - | - | - | - | Y | - | - | - |
| `creditnote.manage` | Y | - | - | - | - | Y | - | - | - |
| `expense.manage` | Y | Y | - | - | - | Y | - | - | - |
| `finance.settings` | Y | - | - | - | - | - | - | - | - |

**Reports**

| Permission | Owner | Manager | Recep. | Operator | Reviewer | Account. | Customer | Corp. admin | Corp. empl. |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `report.operational` | Y | Y | - | - | - | Y | - | - | - |
| `report.financial` | Y | Y | - | - | - | Y | - | - | - |
| `report.export` | Y | Y | - | - | - | Y | - | - | - |

**Operations**

| Permission | Owner | Manager | Recep. | Operator | Reviewer | Account. | Customer | Corp. admin | Corp. empl. |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `appointment.read` | Y | Y | Y | Y | - | - | - | - | - |
| `appointment.manage` | Y | Y | Y | - | - | - | - | - | - |
| `queue.manage` | Y | Y | Y | - | - | - | - | - | - |
| `task.read` | Y | Y | Y | Y | Y | - | - | - | - |
| `task.manage` | Y | Y | - | Y | Y | - | - | - | - |

**Organisation**

| Permission | Owner | Manager | Recep. | Operator | Reviewer | Account. | Customer | Corp. admin | Corp. empl. |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `branch.read` | Y | Y | Y | Y | Y | Y | - | - | - |
| `branch.manage` | Y | - | - | - | - | - | - | - | - |
| `staff.read` | Y | Y | - | - | - | - | - | - | - |
| `staff.manage` | Y | Y | - | - | - | - | - | - | - |
| `role.manage` | Y | - | - | - | - | - | - | - | - |

**Communication**

| Permission | Owner | Manager | Recep. | Operator | Reviewer | Account. | Customer | Corp. admin | Corp. empl. |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `notification.manage` | Y | Y | - | - | - | - | - | - | - |
| `reminder.read` | Y | Y | Y | - | - | - | - | - | - |
| `reminder.manage` | Y | Y | - | - | - | - | - | - | - |
| `automation.manage` | Y | Y | - | - | - | - | - | - | - |

**Support**

| Permission | Owner | Manager | Recep. | Operator | Reviewer | Account. | Customer | Corp. admin | Corp. empl. |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `ticket.read` | Y | Y | Y | - | - | - | - | - | - |
| `ticket.manage` | Y | Y | - | - | - | - | - | - | - |

**Administration**

| Permission | Owner | Manager | Recep. | Operator | Reviewer | Account. | Customer | Corp. admin | Corp. empl. |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `branding.manage` | Y | - | - | - | - | - | - | - | - |
| `domain.manage` | Y | - | - | - | - | - | - | - | - |
| `settings.manage` | Y | - | - | - | - | - | - | - | - |
| `subscription.manage` | Y | - | - | - | - | - | - | - | - |
| `integration.manage` | Y | - | - | - | - | - | - | - | - |
| `audit.read` | Y | Y | - | - | - | - | - | - | - |
| `privacy.manage` | Y | - | - | - | - | - | - | - | - |
| `support_access.decide` | Y | - | - | - | - | - | - | - | - |

**Self-service**

| Permission | Owner | Manager | Recep. | Operator | Reviewer | Account. | Customer | Corp. admin | Corp. empl. |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `self.profile` | - | - | - | - | - | - | Y | - | Y |
| `self.requests` | - | - | - | - | - | - | Y | - | Y |
| `self.documents` | - | - | - | - | - | - | Y | - | Y |
| `self.payments` | - | - | - | - | - | - | Y | - | - |
| `self.appointments` | - | - | - | - | - | - | Y | - | - |
| `self.tickets` | - | - | - | - | - | - | Y | Y | Y |
| `self.privacy` | - | - | - | - | - | - | Y | - | Y |

**Corporate portal**

| Permission | Owner | Manager | Recep. | Operator | Reviewer | Account. | Customer | Corp. admin | Corp. empl. |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `corp.account.read` | - | - | - | - | - | - | - | Y | - |
| `corp.account.manage` | - | - | - | - | - | - | - | Y | - |
| `corp.employees.read` | - | - | - | - | - | - | - | Y | - |
| `corp.employees.manage` | - | - | - | - | - | - | - | Y | - |
| `corp.requests.read` | - | - | - | - | - | - | - | Y | - |
| `corp.requests.create` | - | - | - | - | - | - | - | Y | - |
| `corp.requests.approve` | - | - | - | - | - | - | - | Y | - |
| `corp.invoices.read` | - | - | - | - | - | - | - | Y | - |
<!-- /generated:matrix -->

## 5. Platform roles

Platform staff are users with `users.platformRole` set. They sign in to the platform console (`app: "platform"`) and have no tenant membership. Platform permissions never give access to a centre's data; that needs a support access grant (section 6).

<!-- generated:platform -->
| Permission | Meaning | Super Admin | Support Agent |
| --- | --- | :-: | :-: |
| `platform.tenants.read` | View tenants and subscription information | Y | Y |
| `platform.tenants.manage` | Approve, suspend, reactivate and archive tenants | Y | - |
| `platform.plans.manage` | Manage plans, coupons and limits | Y | - |
| `platform.billing.manage` | Manage SaaS billing | Y | - |
| `platform.metrics.read` | View platform metrics | Y | - |
| `platform.features.manage` | Manage global feature flags and settings | Y | - |
| `platform.integrations.manage` | Manage approved platform integrations | Y | - |
| `platform.staff.manage` | Manage platform staff | Y | - |
| `platform.audit.read` | View platform audit and security events | Y | - |
| `platform.support.manage` | Handle platform support tickets | Y | Y |
| `platform.access.request` | Request time-limited access to a tenant | Y | Y |
<!-- /generated:platform -->

Platform staff are created with the CLI (`pnpm --filter @typease/api platform-admin`, see [PLATFORM_ADMIN_GUIDE.md](user-guides/PLATFORM_ADMIN_GUIDE.md)) or by a super admin through `POST /api/v1/platform/staff`. MFA enrolment is forced for every platform user when `MFA_ENFORCEMENT=required`, which the configuration forces in production.

## 6. Support access scopes

A platform user reaches a centre's data only through a time-limited access grant that the centre approves. The grant carries a list of scopes, and each scope must come from this allow-list (`SUPPORT_GRANTABLE`, 16 of the 70 staff permissions). Anything else is refused with `422 SCOPE_NOT_GRANTABLE`.

<!-- generated:support -->
| Scope a grant may contain | Meaning |
| --- | --- |
| `customer.read` | View customers (identity numbers masked) |
| `service.read` | View the service catalogue |
| `request.read.all` | View all requests in permitted branches |
| `request.comment.internal` | Read and write internal notes |
| `quotation.read` | View quotations |
| `invoice.read` | View invoices |
| `payment.read` | View payments |
| `branch.read` | View branches |
| `staff.read` | View staff and workload |
| `appointment.read` | View appointments |
| `task.read` | View tasks |
| `ticket.read` | View support tickets |
| `reminder.read` | View expiry reminders |
| `report.operational` | View operational reports |
| `audit.read` | View the audit trail |
| `document.read` | View and download documents |
<!-- /generated:support -->

What a grant does and does not do (`services/api/src/common/auth/support-session.ts`; every route is
exercised in `services/api/test/support-session.spec.ts` and `tests/security/05-platform-support-access.spec.ts`):

| Behaviour | Result |
| --- | --- |
| Routes that need a permission outside the granted scopes | `403 SUPPORT_ACCESS_SCOPE`, and a `PERMISSION_DENIED` security event is recorded |
| GET routes that need a permission inside the granted scopes | Allowed, for every branch of the centre; each call is written to the centre's audit trail (`support_access.api_call`) before it is served |
| Routes without a permission (`@TenantMember()`, `@Authenticated()`) | `403 SUPPORT_ACCESS_SCOPE`, except five marked `@SupportSessionSafe`: `GET /auth/me`, `GET /tenant`, `GET /feature-flags`, `GET /document-types`, `GET /branches/directory` |
| Any method other than GET / HEAD | `403 SUPPORT_ACCESS_READ_ONLY`, except the four link-creating POSTs marked `@SupportSessionRead` (document download and preview links, scheduled report file link, renewal link; each still needs its scope) and the write scopes below |
| Scope `request.comment.internal` | Allows reading and **writing** internal notes on a request (`SUPPORT_WRITE_SCOPES`). The note is stored with author type `PLATFORM` and the author shown as "(TypEase support)". This is the only state change a support session can perform. |
| Customer and company-user routes, platform routes | Always refused (`SUPPORT_ACCESS_SCOPE` / `PLATFORM_ONLY`), whatever was granted |
| Grant revoked, denied or expired | The support session stops working on the next request (`401 SUPPORT_ACCESS_ENDED`) |

The grant life cycle and its audit trail are described in [TENANT_ISOLATION.md](TENANT_ISOLATION.md#5-platform-staff-and-support-access).

## 7. Segregation of duties

The permission source declares two request/approve pairs:

<!-- generated:sod -->
| Request permission | Approve permission |
| --- | --- |
| `refund.request` | `refund.approve` |
| `quotation.manage` | `discount.approve` |
<!-- /generated:sod -->

Holding both permissions of a pair is allowed (the owner does). What is enforced is that the same person does not do both halves on the same record:

| Rule | Enforcement | Exception |
| --- | --- | --- |
| The person who requested a refund cannot approve, process or complete it. | `refunds.service.ts`, error `403 SELF_APPROVAL_FORBIDDEN` | None. A centre with a single person able to approve refunds cannot refund a payment that this person requested; someone else must raise the request. |
| The person who requested a discount on a quotation cannot approve it. | `quotations.service.ts`, error `403 SELF_APPROVAL_FORBIDDEN` | If exactly one active staff member in the centre holds `discount.approve`, that person may approve their own request. The audit entry says "self-approved: only approver in the centre". |
| A directly created invoice that contains a discount must be issued by someone holding `discount.approve`, and not by the person who created it. | `invoices.service.ts`, errors `403 DISCOUNT_APPROVAL_REQUIRED`, `403 SELF_APPROVAL_FORBIDDEN` | Same single-approver exception, audited as `invoice.discount_self_approved`. |
| A quotation with an unapproved discount cannot be sent or approved. | `quotations.service.ts`, error `409 DISCOUNT_APPROVAL_REQUIRED`; database check `quotations_discount_approval` | None |

The database does not enforce "requester is not approver"; the services do. The tests that cover it are listed in [TEST_REPORT.md](TEST_REPORT.md) (scenario 25).

## 8. Resource scoping: what a permission does not give you

| Scope | Applies to | Rule | Error when outside |
| --- | --- | --- | --- |
| Tenant | Everyone | Rows of another centre do not exist for the caller. | `404 NOT_FOUND` |
| Branch | Staff whose membership has `allBranches = false` | List endpoints are filtered to the member's branches (`branchFilter`); single-record endpoints check the record's branch (`assertBranchAccess`). | `403 BRANCH_FORBIDDEN` or `404` |
| Assignment | Staff with `request.read.assigned` but not `request.read.all` (the operator role) | Only requests the member is actively assigned to. | `404 NOT_FOUND` |
| Own customer profile | `CUSTOMER` members | Every `self.*` route resolves the member's own customer id from the membership (`ownCustomerId`), never from the request. | `403 NO_CUSTOMER_PROFILE` if the membership has none |
| Own company | `CORPORATE` members | Every `corp.*` route resolves the member's own corporate account (`ownCorporateAccountId`). | `403 NO_CORPORATE_ACCOUNT` |
| Sensitive identity numbers | Staff | Passport, Emirates ID and similar numbers are returned masked. Revealing one needs `customer.sensitive.read` and writes an audit entry. | `403 FORBIDDEN` |
| Internal notes | Customers and corporate users | Comments with visibility `INTERNAL` are never returned to non-staff members. | Not returned |

A tenant id is never taken from the request body, query string or path. An architecture test (`test/architecture.spec.ts`, "no module reads a tenant id from the request body, query or params") fails the build if a module does.

## 9. Multi-factor authentication

- MFA is TOTP (authenticator app) with ten single-use recovery codes.
- Roles marked "MFA required" above (owner, manager, accountant) and all platform staff must enrol when `MFA_ENFORCEMENT=required`. The production configuration refuses to start with any other value. With `MFA_ENFORCEMENT=optional` (the development default) enrolment is voluntary.
- A user who must enrol and has not is limited to the routes that allow it (`@Authenticated({ allowWithoutMfa: true })`: profile, MFA set-up, sign-out). Other routes answer `403 MFA_SETUP_REQUIRED`.
- Whether a role requires MFA is decided by the role key in the permission source (`SYSTEM_ROLES[key].requiresMfa`), not by a column. A custom role therefore never forces MFA, even if it holds `refund.approve` or `role.manage`. A centre that creates a powerful custom role has to ask those staff to enrol voluntarily. This is listed in [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).
- Customers and corporate users can enrol voluntarily. The mobile app has no enrolment screen (see [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)).

## 10. Custom roles and guard rails

Owners (anyone with `role.manage`) can create roles and change the permissions of existing ones under **Roles** in the staff app, or through `GET /api/v1/roles`, `GET /api/v1/roles/permissions` (the catalogue), `POST /api/v1/roles`, `PATCH /api/v1/roles/:id` and `DELETE /api/v1/roles/:id`.

| Guard rail | Behaviour | Error |
| --- | --- | --- |
| Staff only | A custom role is always created with kind `STAFF`. The request has no `kind` field, so customer and corporate roles cannot be created. | - |
| Key format | `^[a-z][a-z0-9_]{2,40}$`, unique per centre, and not one of the nine system keys. | `400 VALIDATION_FAILED` / `409 DUPLICATE` |
| Staff permissions only | `self.*`, `corp.*` and `platform.*` keys cannot be put in a staff role. | `400 UNKNOWN_PERMISSION` |
| No privilege escalation (roles) | You cannot add a permission to a role unless you hold it yourself. | `403 PRIVILEGE_ESCALATION` |
| No privilege escalation (staff) | You cannot give a staff member a role that holds permissions you lack, unless you are an owner. | `403 PRIVILEGE_ESCALATION` |
| Locked roles | `owner`, `customer`, `corporate_admin` and `corporate_employee` cannot be edited. | `409 ROLE_LOCKED` |
| System roles | The nine shipped roles cannot be deleted. The five that are not locked (manager, receptionist, operator, reviewer, accountant) can have their permissions changed. | `409 ROLE_LOCKED` |
| Role in use | A custom role that still has members cannot be deleted. | `409 ROLE_IN_USE` |
| Own access | You cannot change your own role or status, or remove yourself. | `403 SELF_CHANGE` |
| Last owner | The last active owner cannot be demoted, suspended or removed. | `409 LAST_OWNER` |
| Session revocation | Changing a member's role or status revokes that member's sessions in the centre. | - |

Every role change is written to the audit log with the before and after permission lists.

## Regenerating this document

The generated tables come from a short script that transpiles `packages/permissions/src/index.ts` and prints Markdown. The script is not part of the repository (the documentation author was not allowed to add source files). It is reproduced here so anyone can re-run it from the repository root:

```bash
node -e '
const fs=require("fs"),ts=require("typescript");
const js=ts.transpileModule(fs.readFileSync("packages/permissions/src/index.ts","utf8"),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
const m={exports:{}};new Function("module","exports",js)(m,m.exports);const P=m.exports;
for(const [k,d] of Object.entries(P.SYSTEM_ROLES)) console.log(k,d.permissions.length,d.requiresMfa?"mfa":"");
for(const k of Object.keys(P.TENANT_PERMISSIONS))
  console.log(k.padEnd(28),Object.values(P.SYSTEM_ROLES).map(r=>r.permissions.includes(k)?"Y":"-").join(" "));
'
```

The package's own unit tests (`packages/permissions/src/index.test.ts`, 6 tests) assert some of the invariants this document relies on: every role references known permissions only; the receptionist cannot touch restricted finance or administration; the operator cannot approve refunds or discounts and only sees assigned requests; customers and corporate users have no staff permissions; platform roles carry no tenant permission; support grants can never unlock write access to money, roles or deletion. If this document and the source ever disagree, the source is right.
