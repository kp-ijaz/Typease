# Dashboard

Module folder: `services/api/src/modules/dashboard`. No tables of its own: every widget is a live query over the
tables of other modules. All paths are under `/api/v1`. Money is returned as strings with two decimals.

## Endpoints

| Method | Path | Access | Query | Response |
| --- | --- | --- | --- | --- |
| GET | `/dashboard` | Any staff member | `branchId?`, `from?`, `to?` (`YYYY-MM-DD`) | All widgets in one response (below) |
| GET | `/dashboard/trends` | Any staff member | `branchId?`, `from?`, `to?` | One row per day: requests created / completed, service revenue, gross collections |

Unknown query parameters are rejected (400). There is no tenant parameter: the centre is always the one of the
signed-in member.

`GET /dashboard`

```json
{
  "generatedAt": "2026-10-09T08:15:02.113Z",
  "timeZone": "Asia/Dubai",
  "today": "2026-10-09",
  "currency": "AED",
  "filters": { "branchId": null, "from": null, "to": null },
  "scope": { "branchIds": null, "requests": "ALL", "finance": "ALL" },
  "requests": {
    "newRequests": 4, "pendingVerification": 3, "awaitingCustomer": 2, "awaitingPayment": 1, "readyForProcessing": 2,
    "inProgress": 6, "completedToday": 5, "overdue": 2, "open": 18, "drafts": 1,
    "byStatus": { "SUBMITTED": 4, "UNDER_REVIEW": 3, "COMPLETED": 41 },
    "range": null
  },
  "finance": {
    "serviceRevenueToday": "1250.00", "otherRevenueToday": "0.00", "taxInvoicedToday": "62.50",
    "grossCollectionsToday": "4310.00", "paymentsToday": "4410.00", "refundsToday": "100.00",
    "outstandingReceivables": "9870.50", "openInvoices": 14,
    "range": null,
    "labels": {
      "serviceRevenueToday": "Today's service revenue (earned service fees, excluding tax)",
      "grossCollectionsToday": "Today's gross collections (cash received minus refunds, all fees and tax)",
      "outstandingReceivables": "Outstanding receivables (open invoice balances)"
    },
    "notes": ["Earned service revenue is on an accrual basis: …", "Gross collections are on a cash basis: …", "Government fees and third-party charges treated as pass-through …"]
  },
  "staffWorkload": {
    "unassignedRequests": 3,
    "staff": [{ "membershipId": "…", "name": "Omar Khalid", "roleKey": "operator", "roleName": "Typing Operator", "openRequests": 7, "overdueRequests": 1, "highPriorityRequests": 2, "openTasks": 4, "overdueTasks": 0 }]
  },
  "upcomingExpiries": {
    "withinDays": 30, "from": "2026-10-09", "to": "2026-11-08", "total": 12,
    "items": [{ "scheduleId": "…", "documentTypeKey": "passport", "documentTypeName": "Passport", "documentTypeNameAr": "جواز السفر", "expiryDate": "2026-10-21", "daysLeft": 12, "status": "ACTIVE", "customerId": "…", "corporateAccountId": null, "renewalStarted": false, "customerNo": "CUS-000311", "customerName": "Fatima Al Mansoori", "subjectLabel": "Fatima Al Mansoori" }]
  },
  "recentActivity": [{ "id": "…", "requestId": "…", "requestNo": "TE-000123", "branchId": "…", "serviceName": "Residence visa renewal", "from": "UNDER_REVIEW", "to": "QUOTED", "toLabel": { "en": "Quotation sent", "ar": "تم إرسال عرض السعر" }, "at": "2026-10-09T08:01:44.000Z", "actorType": "STAFF", "actorName": "Sara Ali", "customerNo": "CUS-000311", "customerName": "Fatima Al Mansoori" }]
}
```

`GET /dashboard/trends`

```json
{
  "generatedAt": "…", "timeZone": "Asia/Dubai", "currency": "AED", "from": "2026-09-10", "to": "2026-10-09",
  "filters": { "branchId": null }, "scope": { "branchIds": null, "requests": "ALL", "finance": "ALL" },
  "days": [{ "date": "2026-09-10", "requestsCreated": 9, "requestsCompleted": 6, "serviceRevenue": "1890.00", "grossCollections": "5120.00" }],
  "notes": ["Earned service revenue is on an accrual basis: …", "Gross collections are on a cash basis: …"]
}
```

## Events and jobs

None. The dashboard reads; it emits no events, consumes none and has no jobs.

## Business rules

- **Widgets and the statuses behind them** (`STATUS_BUCKETS` in `@typease/types`):

  | Widget | Counts |
  | --- | --- |
  | `newRequests` | `SUBMITTED` |
  | `pendingVerification` | `UNDER_REVIEW` |
  | `awaitingCustomer` | `AWAITING_CUSTOMER`, `QUOTED` |
  | `awaitingPayment` | `AWAITING_PAYMENT` |
  | `readyForProcessing` | `READY_FOR_PROCESSING` |
  | `inProgress` | the preparation, review, submission and final-review statuses |
  | `completedToday` | requests whose `completedAt` falls on today's calendar day in the centre's time zone |
  | `overdue` | open requests (not draft, completed or cancelled) whose target date has passed |
  | `open` / `drafts` / `byStatus` | every open request / drafts / the raw count per status |

- **Time zone**: "today" and every day in the trends are calendar days of the centre's time zone
  (`tenants.timezone`), computed with `Intl.DateTimeFormat`, never the server's or UTC's day. `timeZone` and
  `today` in the response say which day that is.
- **Period** (`from` / `to`): optional. With a period, the status counts cover the requests created in it and
  `requests.range` adds `{ from, to, created, completed }`; `finance.range` adds revenue and collections of the
  period; `recentActivity` is limited to it. Only `from`: up to today. Only `to`: from the first day of that month.
  `from` after `to`: 400 `VALIDATION_FAILED`. `completedToday`, the "today" finance figures, receivables, workload
  and expiries are always "now", whatever period is selected.
- **Branch scope**: members limited to branches only ever see their branches (`scope.branchIds`). An explicit
  `branchId` must exist in the centre (404) and be one of the member's branches (403 `BRANCH_FORBIDDEN`).
- **Own cases**: staff with `request.read.assigned` but not `request.read.all` (operators) get every request
  widget, their workload line and the activity feed for the requests they prepare or review only
  (`scope.requests = "ASSIGNED"`); `staffWorkload.unassignedRequests` is `null` for them. Staff with neither
  permission get `requests`, `staffWorkload` and `recentActivity` as `null` (`scope.requests = "NONE"`).
- **Financial widgets** need `report.financial` or `invoice.read`; everyone else gets `finance: null` (never
  zeros). Cash figures (`grossCollectionsToday`, `paymentsToday`, `refundsToday`, `range.grossCollections`, and
  `grossCollections` in the trends) additionally need `report.financial` or `payment.read`; otherwise they are
  `null`. Operators who hold `invoice.read` only see figures of the invoices of their own cases
  (`scope.finance = "OWN_CASES"`), without cash figures.
- **What "revenue" means** (shared with the reports module, see `reports.md`):
  - `serviceRevenueToday` is EARNED SERVICE REVENUE: the service-fee lines of invoices issued today, net of line
    discounts, excluding tax, minus the service-fee part of credit notes issued today. Government fees and
    third-party charges are not in it.
  - `otherRevenueToday` is non-zero only when the centre configured a government / third-party component as
    REVENUE in its finance settings.
  - `grossCollectionsToday` is CASH: payments completed today minus refunds completed today, all fee components
    and tax included. It is labelled as such (`labels`) and is not revenue.
  - `outstandingReceivables` is the sum of the open balances of issued invoices right now.
- **Staff workload**: per staff member with open work: open requests assigned as operator, how many of them are
  overdue or high priority, open tasks and overdue tasks; at most 50 lines, busiest first.
- **Upcoming expiries** (needs `reminder.read` or `reminder.manage`, else `null`): the reminder schedules
  (`ACTIVE` or `PAUSED`) whose document expires within the next 30 days; `total` and the first 10 by expiry date.
  Reminder schedules belong to the centre, not to a branch, so this widget ignores `branchId`.
- **Recent activity**: the last 15 status changes of visible requests. `customerName` (here and in the expiry
  list, together with `subjectLabel`) is only filled for viewers with `customer.read`; others get the customer
  number and `null`.
- **Trends**: default the last 30 days, at most 366 (422 `PERIOD_TOO_LONG`). `serviceRevenue` is `null` without
  access to financial figures, `grossCollections` is `null` without access to cash figures, the request columns
  are `null` without access to requests.
- **Tenant isolation**: every query runs in a tenant transaction under row-level security and also filters on the
  tenant id explicitly.
