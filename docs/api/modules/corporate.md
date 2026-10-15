# Corporate module

Corporate customers of a centre: company accounts, verification and credit approval, authorised contacts
(portal members), the employee directory, service agreements, contract prices, and the corporate portal.

Source: `services/api/src/modules/corporate/` · schemas: `packages/validation/src/corporate.ts`
Tables written: `corporate_accounts`, `corporate_members`, `corporate_employees`, `corporate_agreements`,
`corporate_prices`; `tenant_memberships` (kind `CORPORATE`) for portal access; `customers` only through the
customers module (`CustomersService`).
Tables read: `service_requests`, `invoices`, `services`, `service_prices`, `roles`, `tenants`, `subscriptions`.

All paths are below `/api/v1`. Money is a decimal string. Errors use the common shape
`{ statusCode, code, message, details?, requestId }`.

## Endpoints (41)

### Staff side: `/corporate-accounts`

| Method | Path | Permission | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/corporate-accounts` | `corporate.read` | `page, pageSize, sort, q, status` | Page of accounts with `employeeCount`, `memberCount` |
| POST | `/corporate-accounts` | `corporate.manage` | Account body | Account (201); `402 PLAN_LIMIT_REACHED`; `409 DUPLICATE_TRADE_LICENCE` |
| GET | `/corporate-accounts/:id` | `corporate.read` | - | Account + `counters` |
| PATCH | `/corporate-accounts/:id` | `corporate.manage` | Any account field | Account + `creditApprovalWithdrawn` |
| POST | `/corporate-accounts/:id/verify` | `corporate.verify` | `{ note }` | Account (`status: "ACTIVE"`) |
| POST | `/corporate-accounts/:id/credit` | `corporate.verify` | `{ approved, creditLimit?, paymentTermsDays?, note }` | Account |
| POST | `/corporate-accounts/:id/suspend` | `corporate.manage` | `{ reason }` | Account (`SUSPENDED`) |
| POST | `/corporate-accounts/:id/reactivate` | `corporate.manage` | - | Account (`ACTIVE`, or `PENDING_VERIFICATION` if never verified) |
| POST | `/corporate-accounts/:id/archive` | `corporate.manage` | `{ reason }` | Account (`ARCHIVED`) |
| GET | `/corporate-accounts/:id/members` | `corporate.read` | - | Members (not removed) |
| POST | `/corporate-accounts/:id/members` | `corporate.manage` | `{ fullName, email, phone?, isAuthorisedSignatory? }` | Member (201, `status: "INVITED"`) |
| PATCH | `/corporate-accounts/:id/members/:memberId` | `corporate.manage` | `{ fullName?, phone?, isAuthorisedSignatory?, status? }` (`ACTIVE` or `SUSPENDED`) | Member |
| POST | `/corporate-accounts/:id/members/:memberId/resend-invitation` | `corporate.manage` | - | `{ status: "SENT" }` |
| DELETE | `/corporate-accounts/:id/members/:memberId` | `corporate.manage` | - | `{ status: "REMOVED" }` |
| GET | `/corporate-accounts/:id/employees` | `corporate.read` | `page, pageSize, sort, q, status` | Page of employees |
| POST | `/corporate-accounts/:id/employees` | `corporate.manage` | Employee body | Employee + `outcome` (201); `409 EMPLOYEE_EXISTS` |
| POST | `/corporate-accounts/:id/employees/bulk` | `corporate.manage` | `{ employees: [1..200 employee bodies] }` | `{ created, skipped, createdCount, skippedCount }` (201) |
| GET | `/corporate-accounts/:id/employees/:employeeId` | `corporate.read` | - | Employee |
| PATCH | `/corporate-accounts/:id/employees/:employeeId` | `corporate.manage` | Any employee field + `status?` (`ACTIVE` or `INACTIVE`) | Employee |
| POST | `/corporate-accounts/:id/employees/:employeeId/login` | `corporate.manage` | `{ email? }` | `{ employeeId, membershipId, status: "INVITED", email }` (201) |
| POST | `/corporate-accounts/:id/employees/:employeeId/login/resend-invitation` | `corporate.manage` | - | `{ status: "SENT", email }` |
| DELETE | `/corporate-accounts/:id/employees/:employeeId/login` | `corporate.manage` | - | `{ employeeId, status: "NONE" }` |
| GET | `/corporate-accounts/:id/agreements` | `corporate.read` | - | Agreements, newest start date first |
| POST | `/corporate-accounts/:id/agreements` | `corporate.manage` | `{ title, terms?, startsOn, endsOn?, status? }` | Agreement (201) |
| PATCH | `/corporate-accounts/:id/agreements/:agreementId` | `corporate.manage` | Any agreement field | Agreement |
| DELETE | `/corporate-accounts/:id/agreements/:agreementId` | `corporate.manage` | - | `{ status: "DELETED" }` |
| GET | `/corporate-accounts/:id/prices` | `corporate.read` | - | Contract prices |
| PUT | `/corporate-accounts/:id/prices` | `corporate.manage` | `{ serviceId, serviceFee }` | The contract price (created or replaced) |
| DELETE | `/corporate-accounts/:id/prices/:priceId` | `corporate.manage` | - | `{ status: "DELETED" }` |

### Corporate portal: `/corporate` (membership kind `CORPORATE`)

There is no company id in any portal path. The company is the one bound to the signed-in membership.

| Method | Path | Access | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/corporate/account` | kind `CORPORATE` + `corp.account.read` | - | Own company (portal view) + `counters` |
| GET | `/corporate/employees` | kind `CORPORATE` + `corp.employees.read` | `page, pageSize, sort, q, status` | Page of own employees (portal view) |
| POST | `/corporate/employees` | kind `CORPORATE` + `corp.employees.manage` | Employee body | Employee + `outcome` (201) |
| POST | `/corporate/employees/bulk` | kind `CORPORATE` + `corp.employees.manage` | `{ employees: [1..200] }` | `{ created, skipped, createdCount, skippedCount }` (201) |
| GET | `/corporate/employees/:employeeId` | kind `CORPORATE` + `corp.employees.read` | - | Employee (portal view) |
| PATCH | `/corporate/employees/:employeeId` | kind `CORPORATE` + `corp.employees.manage` | Any employee field + `status?` | Employee (portal view) |
| POST | `/corporate/employees/:employeeId/login` | kind `CORPORATE` + `corp.employees.manage` | `{ email? }` | `{ employeeId, membershipId, status: "INVITED", email }` (201) |
| POST | `/corporate/employees/:employeeId/login/resend-invitation` | kind `CORPORATE` + `corp.employees.manage` | - | `{ status: "SENT", email }` |
| DELETE | `/corporate/employees/:employeeId/login` | kind `CORPORATE` + `corp.employees.manage` | - | `{ employeeId, status: "NONE" }` |
| GET | `/corporate/members` | kind `CORPORATE` + `corp.account.read` | - | Own contacts: `id, fullName, email, phone, role, isAuthorisedSignatory, status, createdAt` |
| POST | `/corporate/members` | kind `CORPORATE` + `corp.account.manage` | `{ fullName, email, phone?, isAuthorisedSignatory? }` | `{ id, status: "INVITED", email }` (201) |
| GET | `/corporate/prices` | kind `CORPORATE` + `corp.account.read` | - | Own contract prices |

The system role `corporate_admin` holds all `corp.*` permissions used here. `corporate_employee` holds none of
them and gets 403 on every `/corporate/*` endpoint. An employee who was given a login (see "Employee logins")
works through the self-service endpoints of the other modules (`/requests`, `/documents`, ...), scoped to their
own customer record.

## Shapes

Account body:

```json
{ "companyName": "Falcon Trading LLC", "companyNameAr": "فالكون للتجارة", "tradeLicenceNo": "TL-778899",
  "tradeLicenceAuthority": "Department of Economy", "tradeLicenceExpiry": "2027-06-30", "taxRegistrationNo": "100123456700003",
  "billingEmail": "accounts@falcon.example", "billingAddress": { "line1": "Office 501", "city": "Dubai", "emirate": "Dubai", "country": "AE", "poBox": "12345" },
  "paymentTermsDays": 30, "creditLimit": "5000.00", "notes": "Internal note" }
```

Only `companyName` is required. Account (staff):

```json
{ "id": "…", "tenantId": "…", "accountNo": "CORP-000001", "companyName": "Falcon Trading LLC", "companyNameAr": "…",
  "tradeLicenceNo": "TL-778899", "tradeLicenceAuthority": "…", "tradeLicenceExpiry": "2027-06-30", "taxRegistrationNo": "…",
  "billingEmail": "accounts@falcon.example", "billingAddress": { "city": "Dubai" }, "paymentTermsDays": 30, "creditLimit": "5000",
  "creditApproved": false, "status": "PENDING_VERIFICATION", "verifiedById": null, "verifiedAt": null, "notes": "Internal note",
  "createdAt": "…", "updatedAt": "…",
  "counters": { "employees": 1, "members": 1, "openRequests": 1, "totalRequests": 2, "unpaidInvoices": 1,
                "unpaidInvoicesBalance": "750.00", "creditAvailable": "1250.00" } }
```

`counters` is on `GET /corporate-accounts/:id` only. `creditAvailable` is `null` unless credit is approved.

Account (portal, `GET /corporate/account`):

```json
{ "id": "…", "accountNo": "CORP-000001", "companyName": "Falcon Trading LLC", "companyNameAr": "…", "tradeLicenceNo": "…",
  "tradeLicenceAuthority": "…", "tradeLicenceExpiry": "2027-06-30", "taxRegistrationNo": "…", "billingEmail": "…", "billingAddress": {},
  "status": "ACTIVE", "verified": true, "verifiedAt": "…",
  "credit": { "approved": true, "limit": "9000.00", "paymentTermsDays": 30 },
  "counters": { "employees": 12, "members": 2, "openRequests": 3, "unpaidInvoices": 1, "unpaidInvoicesBalance": "750.00", "creditAvailable": "8250.00" } }
```

Never in the portal view: `notes`, `verifiedById`, `tenantId`. While credit is not approved `credit` is
`{ "approved": false, "limit": null, "paymentTermsDays": 0 }`, whatever limit has been proposed.

Employee body:

```json
{ "fullName": "Ravi Kumar", "fullNameAr": "رافي كومار", "email": "ravi@example.com", "phone": "+971551230001", "nationality": "IN",
  "dateOfBirth": "1990-03-03", "emiratesId": "784-1990-1234567-1", "emiratesIdExpiry": "2027-12-31",
  "passportNo": "N1234567", "passportCountry": "IN", "passportExpiry": "2031-01-01", "employeeNo": "E-100", "designation": "Electrician" }
```

Only `fullName` is required. Employee (staff view):

```json
{ "id": "…", "corporateAccountId": "…", "employeeNo": "E-100", "designation": "Electrician", "status": "ACTIVE",
  "createdAt": "…", "updatedAt": "…", "customerId": "…", "customerNo": "CUS-000042", "customerStatus": "ACTIVE",
  "fullName": "Ravi Kumar", "fullNameAr": "رافي كومار", "email": "ravi@example.com", "phone": "+971551230001", "nationality": "IN",
  "dateOfBirth": "1990-03-03", "emiratesIdMasked": "•••• 5671", "emiratesIdExpiry": "2027-12-31",
  "passportNoMasked": "•••• 4567", "passportCountry": "IN", "passportExpiry": "2031-01-01",
  "login": { "status": "ACTIVE", "email": "ravi@example.com", "invitedAt": "…", "joinedAt": "…", "lastLoginAt": "…" },
  "outcome": "CREATED" }
```

`login.status` is `NONE` (all other fields `null`), `INVITED` (invitation not accepted yet), `ACTIVE` or
`SUSPENDED`. It is part of every employee view, for staff and for the company's administrators, except the rows
of a bulk response (new employees never have a login).

The portal view is the same without `customerId`, `customerNo` and `customerStatus`. `outcome` is present on
create responses only: `CREATED` or `LINKED_EXISTING_CUSTOMER`.

Bulk response:

```json
{ "created": [{ "index": 0, "outcome": "CREATED", "…": "employee view" }],
  "skipped": [{ "index": 1, "reason": "ALREADY_EMPLOYEE", "employeeId": "…", "fullName": "Already Here" }],
  "createdCount": 4, "skippedCount": 2 }
```

Contract price (staff): `{ id, serviceId, serviceName, serviceNameAr, serviceCode, serviceActive, createdAt,
contractServiceFee, catalogueServiceFee, currency }`. Portal: `{ id, serviceId, serviceName, serviceNameAr,
contractServiceFee, catalogueServiceFee, currency }`.

Agreement: `{ id, corporateAccountId, title, terms, startsOn, endsOn, status, createdAt, updatedAt }` with dates as
`YYYY-MM-DD` and `status` one of `DRAFT | ACTIVE | EXPIRED | TERMINATED`.

## Business rules

### Accounts
- `accountNo` (`CORP-000001` ...) is gap-free and unique per centre.
- Creating an account counts against the plan limit `corporateClients` (`402 PLAN_LIMIT_REACHED`). Archived
  accounts do not count; restoring one is checked against the limit again.
- A new account is always `PENDING_VERIFICATION` with `creditApproved: false`. `status`, `creditApproved`,
  `verifiedAt` and `verifiedById` cannot be set through create or PATCH.
- Two non-archived accounts of a centre cannot have the same trade licence number
  (`409 DUPLICATE_TRADE_LICENCE`, case-insensitive).
- List: `status` filter accepts `PENDING_VERIFICATION | ACTIVE | SUSPENDED | ARCHIVED | ALL`; without it archived
  accounts are hidden. `q` searches company name (English / Arabic), account number (exact) and trade licence
  number. `sort`: `createdAt` (default, desc), `companyName`, `accountNo`.

### Verification and credit (`corporate.verify`)
- Verification is a separate decision: `POST …/verify` with a note saying what was checked. It sets
  `status: "ACTIVE"`, `verifiedById` and `verifiedAt`, and is audited (`corporate.account_verified`). A company
  can be verified once (`409 ALREADY_VERIFIED`).
- Credit: `creditLimit` and `paymentTermsDays` on the account are proposed terms. They count only while
  `creditApproved` is true. `POST …/credit` with `approved: true` needs a verified company
  (`422 CORPORATE_NOT_VERIFIED`) and a limit greater than zero, given in the call or already on the account
  (`422 CREDIT_LIMIT_REQUIRED`); it may set the limit and terms in the same call. `approved: false` withdraws
  the approval. Both are audited with the note (`corporate.credit_approved` / `corporate.credit_revoked`).
- If someone with `corporate.manage` changes `creditLimit` or `paymentTermsDays` of an account whose credit is
  approved, the approval is withdrawn automatically (`creditApprovalWithdrawn: true` in the response) and has to
  be given again.
- This module stores and reports the terms (`counters.creditAvailable` = approved limit minus unpaid invoice
  balances, never below zero). It does not block invoices; that is the finance module's decision.

### Status
| From | Action | To |
| --- | --- | --- |
| `PENDING_VERIFICATION` | verify | `ACTIVE` |
| `ACTIVE` | suspend (reason) | `SUSPENDED` |
| `SUSPENDED` | reactivate | `ACTIVE` |
| any except `ARCHIVED` | archive (reason) | `ARCHIVED` |
| `ARCHIVED` | reactivate | `ACTIVE` if it was verified, else `PENDING_VERIFICATION` |

- Other transitions are `409 INVALID_STATUS`.
- Archiving is refused while the company has open requests (`409 CORPORATE_HAS_OPEN_REQUESTS`). It suspends
  every portal membership of the company and ends their sessions at once. After a restore, members stay
  suspended until staff reactivate them one by one.
- An archived account is read-only for staff (`409 CORPORATE_ACCOUNT_ARCHIVED`).

### Members (authorised contacts)
- Inviting a member requires the plan feature `corporatePortal` (`402 PLAN_LIMIT_REACHED`,
  `details.limit: "corporatePortal"`).
- The invitation creates (or re-uses) the user account for the email address, an `INVITED` tenant membership of
  kind `CORPORATE` with the role `corporate_admin` bound to the company, and the `corporate_members` row. The
  email is sent through `AuthService.sendInvitation({ app: 'corporate' })` after the transaction. Accepting
  (`POST /auth/invitations/accept`) activates both the membership and the member row.
- One login acts for one company per centre: the same address cannot be invited twice to a company
  (`409 ALREADY_MEMBER`) and cannot be attached to a second company (`409 EMAIL_IN_USE`; the message never says
  which company).
- `resend-invitation` works only for a pending invitation (`409 NOT_INVITED`); the earlier link stops working.
- Suspending a member suspends the membership and ends the person's sessions for the centre immediately. A
  pending invitation cannot be suspended (`409 INVITATION_PENDING`); remove the member to withdraw it.
- Removing a member sets the membership to `REMOVED` and ends the sessions. The same person can be invited again
  later.
- A company administrator can invite colleagues to their own company from the portal (`POST /corporate/members`).
  There is no portal endpoint to suspend or remove contacts; staff do that.
- In non-production environments with `EXPOSE_DEV_TOKENS=true`, invitation responses carry `dev.invitationToken`.

### Employees
- Every employee is backed by a customer record of the centre (type `INDIVIDUAL`, `corporateAccountId` = the
  company), so documents and requests hang off a person. The pair (company, customer) is unique.
- Re-use: when the passport number or Emirates ID of the new employee matches (exactly, through the blind index)
  a customer that **already belongs to the same company**, that customer is linked instead of creating a second
  record (`outcome: "LINKED_EXISTING_CUSTOMER"`). If that person is already on the employee list the call fails
  with `409 EMPLOYEE_EXISTS` (`details: { employeeId, status }`); in a bulk call the row is reported under
  `skipped`.
- A customer who does not belong to the company - a private customer, or an employee of another company - is
  never linked, even with identical identity numbers. A new customer record is created instead, and nothing
  about the other record is revealed. Staff can find such pairs with the staff-only duplicate check
  (`POST /customers/duplicates/check`) and merge them if appropriate.
- No consent rows are recorded for people added by or for a company: they were not present to give one.
- Bulk: 1 to 200 employees per call, validated together (one invalid row rejects the whole call with the path of
  each problem, e.g. `employees.1.emiratesId`) and written in one transaction.
- Identity numbers are stored and shown exactly as in the customers module: encrypted + blind index + last four,
  masked in every response here. The full numbers are only available to staff holding `customer.sensitive.read`
  through `GET /customers/:id/identity`.
- PATCH changes employment fields (`employeeNo`, `designation`, `status`) and the person's details (which updates
  the customer record). An identity number that another employee of the same company already has is refused
  (`409 EMPLOYEE_EXISTS`).
- Deactivating (`status: "INACTIVE"`) hides the employee from the default list, keeps the customer record and its
  history, and suspends any portal login tied to that employment. `status: "ACTIVE"` reactivates.
- List: `status` = `ACTIVE` (default), `INACTIVE`, `ALL`; `q` searches name, employee number and designation;
  `sort` = `createdAt` (default, desc), `fullName`, `employeeNo`.

### Employee logins (role `corporate_employee`)
- Who may invite: centre staff holding `corporate.manage` (any company of the centre that is not archived) and
  the company's own users holding `corp.employees.manage` (their own company only, and only while it is
  `ACTIVE`). The plan feature `corporatePortal` is required (`402 PLAN_LIMIT_REACHED`). Portal logins are not
  metered: the plan limit `staffUsers` counts staff memberships only, so no seat limit applies here.
- The invitation goes to `email` from the request or, without one, to the email on the employee's record
  (`422 EMAIL_REQUIRED` if there is neither). It creates (or re-uses) the user account for that address and an
  `INVITED` tenant membership of kind `CORPORATE` with the role `corporate_employee`, bound to the company
  (`corporateAccountId`), the employment (`corporateEmployeeId`) and the person's customer record (`customerId`).
  The email is sent through `AuthService.sendInvitation({ app: 'corporate' })` after the transaction; only the
  hash of the one-time token is stored. Accepting (`POST /auth/invitations/accept`) activates the membership;
  the person then signs in with `app: "corporate"`.
- What the employee can do comes from the role (`self.profile`, `self.requests`, `self.documents`,
  `self.tickets`, `self.privacy`) and from row-level scoping in the other modules: requests and documents of
  their own customer record only. A colleague's request or document, a company document and every
  `/corporate/*` and staff endpoint are 404 / 403.
- **A request the employee creates in the corporate portal is a request of the company about that employee**
  (`POST /requests { serviceId, ... }`): `corporateAccountId` comes from the login, the subject is the employee's
  own customer record, `source` is `CORPORATE`. Naming anybody else (`corporateEmployeeId` or `customerId` of a
  colleague, of another company or of a stranger) answers `403 EMPLOYEE_SELF_ONLY`; a company id in the body is
  ignored. An inactive employee record answers `422 EMPLOYEE_NOT_ACTIVE`. From there on it is an ordinary
  company request: the contract price applies, the company's administrators see it, approve or reject its
  quotation, receive and pay its invoice, and are told about it (see notifications.md). There is no account
  setting that switches employee-raised requests off: `corporate_accounts` has no settings column, so every
  active employee with a login may raise one.
- The employee follows their request without amounts and without a say: `finance` of `GET /requests/:id` is
  `{ amountsHidden: true, quotation: { id, quotationNo, status, validUntil, sentAt } | null,
  invoices: [{ id, invoiceNo, status, issuedAt, dueAt }], totals: null }`. `GET /quotations`, `/invoices`,
  `/payments`, `/corporate/invoices`, every quotation / invoice by id and every decision (`approve`, `reject`,
  `pay`) stay 403.
- The same person may also have a personal login to the customer portal (membership kind `CUSTOMER` on the same
  customer record). Requests made with that login are personal (`corporateAccountId: null`, list price, their
  own quotation and invoice); the company's administrators neither see them nor hear about them.
- Refusals: the person's data was erased (`409 CUSTOMER_ERASED` for staff; a company no longer sees that
  employee at all, 404); the employee is inactive (`409 EMPLOYEE_INACTIVE`) or the customer record behind it is
  archived / merged (`409 EMPLOYEE_RECORD_LOCKED`); the employee already has an active login
  (`409 ALREADY_HAS_ACCESS`); an invitation to the same address is pending (`409 INVITATION_PENDING`, use
  resend); the address already acts in another corporate capacity at the centre - an administrator, or another
  employee (`409 EMAIL_IN_USE`; the message never says which).
- Inviting another address while an invitation is pending withdraws the earlier invitation (its link stops
  working).
- `resend-invitation` works only while an invitation is pending (`409 NOT_INVITED`); the earlier link stops
  working.
- `DELETE …/login` withdraws a pending invitation or removes the login (`409 NO_LOGIN` when there is neither):
  the membership becomes `REMOVED`, its links to the employee and the customer record are cleared and the
  person's sessions for the centre end at once. It stays possible while the company is suspended or waiting for
  verification. The same person can be invited again later.
- Deactivating the employee suspends the login (`login.status: "SUSPENDED"`) and ends the sessions; so does
  archiving the company. Reactivating the employee does not re-open the login: invite again (the person accepts
  with the link and keeps their password).

### Agreements and contract prices
- Agreements are free-form records of what was agreed (title, terms, period, status). `endsOn` cannot be before
  `startsOn`.
- A contract price belongs to one company and one service; there is at most one per pair, and `PUT` replaces it.
  The service must belong to the centre and not be deleted.
- A contract price replaces only the **service fee** of the catalogue price. Government and third-party
  estimates are never part of a contract price. The catalogue applies it when a price is resolved for that
  company (`GET /services/:id/price?corporateAccountId=…`, `/services/:id/full`, `/catalogue` for the company's
  own users).

### What a company administrator reads and does about company requests
- `GET /requests` / `GET /requests/:id` (`corp.requests.read`): every request billed to the company - raised by
  an administrator, by an employee in the portal or by staff for the company - with the amounts in `finance`
  (requests.md, "The finance block"). `GET /requests/:id` of a COMPLETED company request also carries
  `feedback` / `canRate`; `POST /me/feedback { requestId, rating, comment? }` rates it once, whoever gives the
  rating (support.md). `GET /me/feedback` lists the ratings of the company's requests with `customerId` and
  `customerName`.
- `GET /corporate/invoices` and `GET /corporate/invoices/statement` (`corp.invoices.read`): statement rows carry
  `customerId`, `customerName`, `customerErased` and `requestNo`, so the statement reads by employee
  (finance.md).
- `GET /documents` / `GET /documents/:id`: rows carry `customerName`, `customerErased`, `requestNo`
  (documents.md); `GET /me/reminders` rows `customerId`, `customerName` (reminders.md).
- Notifications (`GET /me/notifications`, e-mail, push, in the administrator's language and subject to their
  own preferences): a quotation waiting for approval (`quotation.ready`, holders of `corp.requests.approve`,
  link `${CORPORATE_WEB_URL}/approvals/:quotationId`), an invoice issued (`payment.requested`,
  `corp.invoices.read`, link `/invoices/:id`), a request that needs information or was completed
  (`request.documents_missing`, `request.completed`, `corp.requests.read`, link `/requests/:id`) and a rejected
  document (`document.rejected`, link `/requests/:id` or `/documents`). Personal requests of an employee
  (made with a customer login) never reach the company (notifications.md, "Company requests").

### Corporate portal isolation
- The company is taken from the verified membership (`ownCorporateAccountId()`); ids or company fields in a
  request body are ignored. An employee, member or price of another company is indistinguishable from one that
  does not exist (404), also for another company of the same centre.
- Corporate users cannot use any staff endpoint (`/customers`, `/corporate-accounts`, `/services` ...): 403.
- Employee personal data is available only to corporate users holding `corp.employees.read`.
- Every employee object returned to the portal carries `customerId`: the id of the person's record. It is the
  filter key for that person's requests, documents and reminders - `GET /requests?customerId=`,
  `GET /documents?customerId=`, `GET /me/reminders?customerId=`. The filter only ever narrows what the caller
  may see anyway: the id of an employee of another company, of a private customer or of nobody gives the same
  empty page (`200`, `data: []`, `meta.total: 0`), never an error that would confirm the record exists.
  `customerNo` and `customerStatus` stay staff-only.
- A person whose data was erased (privacy erasure) disappears from the portal: not in `GET /corporate/employees`
  (also not with `status=ALL`), 404 by id, no invitation, no change. Staff still see the row, inactive and
  nameless, with `erased: true`, and get `409 CUSTOMER_ERASED` when they try to change or invite it. The
  company's past requests and invoices about that person stay visible to the company, with the placeholder name.
- Writes from the portal (`POST` / `PATCH` employees, inviting colleagues) need the company to be `ACTIVE`:
  `403 CORPORATE_ACCOUNT_NOT_ACTIVE` while it is waiting for verification or suspended. Reading stays possible in
  both states, so a suspended company can still see what it owes. An archived company has no portal access.

## Events
- Emitted: `customer.created` with `source: "CORPORATE"` for every newly created employee customer (emitted by
  the customers module inside the same transaction).
- Consumed: none.

## Background jobs
None.

## Audit actions
`corporate.account_created`, `corporate.account_updated`, `corporate.account_verified`, `corporate.credit_approved`,
`corporate.credit_revoked`, `corporate.account_suspended`, `corporate.account_reactivated`,
`corporate.account_archived`, `corporate.member_invited`, `corporate.member_invitation_resent`,
`corporate.member_updated`, `corporate.member_removed`, `corporate.employee_added`, `corporate.employee_updated`,
`corporate.employee_deactivated`, `corporate.employee_login_invited`, `corporate.employee_login_invitation_resent`,
`corporate.employee_login_revoked`, `corporate.agreement_created`, `corporate.agreement_updated`,
`corporate.agreement_deleted`, `corporate.price_set`, `corporate.price_removed` - all with resource type
`CorporateAccount` and the account id as resource id. Customer records created or changed for an employee are
additionally audited as `customer.created` / `customer.updated`.
