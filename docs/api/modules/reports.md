# Reports

Module folder: `services/api/src/modules/reports`. Tables: `scheduled_reports` (reports themselves are pure reads
over the tables of other modules). All paths are under `/api/v1`. Money is returned as strings with two decimals.

## Endpoints

| Method | Path | Access | Body / query | Response |
| --- | --- | --- | --- | --- |
| GET | `/reports` | `report.operational` or `report.financial` | - | The reports the caller may run, with their parameters |
| GET | `/reports/:key` | the permission of the report | period + filters (below) | Report (columns, rows, totals, chart, notes) |
| GET | `/reports/:key/drilldown` | the permission of the report | the report's filters + drill-down filter, `page`, `pageSize` (max 200, default 50) | The records behind the figures, paged |
| GET | `/reports/:key/export` | `report.export` AND the permission of the report | `format=xlsx\|pdf\|csv` + the report's filters | The file (attachment) |
| GET | `/reports/scheduled` | `report.export` | `page`, `pageSize`, `reportKey?` | Paged schedules the caller may see |
| POST | `/reports/scheduled` | `report.export` + the report's permission; plan feature `scheduledReports` | schedule (below) | Schedule |
| GET | `/reports/scheduled/:id` | `report.export` + the report's permission | - | Schedule |
| PATCH | `/reports/scheduled/:id` | as above; plan feature unless only `{ "isActive": false }` | any of `params, format, frequency, recipients, isActive, timeOfDay, weekday, dayOfMonth` | Schedule |
| DELETE | `/reports/scheduled/:id` | `report.export` + the report's permission | - | `{ "status": "DELETED" }` |
| GET | `/reports/scheduled/:id/runs` | the permission of the report (`report.operational` or `report.financial`) + its branch scope; `report.export` is not needed | `page`, `pageSize` | Run log with the generated files |
| POST | `/reports/scheduled/:id/runs/:documentId/download-link` | the permission of the report + its branch scope; `document.read` is neither needed nor enough | - | `{ url, expiresAt, filename, mime, sizeBytes, disposition: "attachment", reportTitle }` (200). 404 when the document is not a file of that schedule |

Unknown query parameters are rejected (400). An unknown report key is 404; a report the caller has no permission
for is 403. There is no tenant parameter anywhere.

### Period and filters

- `from`, `to`: calendar days (`YYYY-MM-DD`) in the centre's time zone, both included. Or `range`: one of
  `today, yesterday, last_7_days, last_30_days, last_week, month_to_date, last_month, year_to_date`. Sending both
  is a 400. Only `from`: up to today. Only `to`: from the first day of that month. Neither: the report's default
  (the current month to date unless stated otherwise). `from` after `to`: 400 `VALIDATION_FAILED`. Longer than the
  report allows (1830 days, 366 for daily sales): 422 `PERIOD_TOO_LONG`.
- `branchId`: must exist (404) and be a branch of the caller (403 `BRANCH_FORBIDDEN`). Without it, members
  limited to branches get their branches, everyone else all branches.
- Report-specific filters are listed per report under "drill-down filter"; a report ignores filters it does not use.

### Report

`GET /reports/daily-sales?from=2026-10-01&to=2026-10-02`

```json
{
  "key": "daily-sales", "title": "Daily sales", "description": "What was invoiced and what was collected, day by day. …",
  "category": "FINANCE", "permission": "report.financial",
  "parameters": [{ "key": "from", "label": "From", "type": "date" }, { "key": "to", "label": "To", "type": "date" }, { "key": "range", "label": "Relative period", "type": "relativeRange" }, { "key": "branchId", "label": "Branch", "type": "branch" }, { "key": "date", "label": "Day", "type": "date", "drilldownOnly": true }],
  "hasDrilldown": true, "asOfNow": false, "branchScoped": true,
  "generatedAt": "2026-10-09T08:15:02.113Z", "timeZone": "Asia/Dubai", "currency": "AED",
  "period": { "from": "2026-10-01", "to": "2026-10-02" }, "branchIds": null, "filters": {},
  "columns": [{ "key": "date", "label": "Date", "type": "date" }, { "key": "invoices", "label": "Invoices issued", "type": "number" }, { "key": "serviceFeeRevenue", "label": "Earned service revenue", "type": "money" }, { "key": "grossCollections", "label": "Gross collections (cash)", "type": "money" }],
  "rows": [{ "date": "2026-10-01", "invoices": 4, "serviceFeeRevenue": "600.00", "otherRevenue": "0.00", "passThroughInvoiced": "1450.00", "tax": "30.00", "totalInvoiced": "2080.00", "payments": "2080.00", "refunds": "0.00", "grossCollections": "2080.00" }],
  "totals": { "date": "Total", "invoices": 4, "serviceFeeRevenue": "600.00", "grossCollections": "2080.00" },
  "chart": { "type": "bar", "x": "date", "series": [{ "key": "serviceFeeRevenue", "label": "Earned service revenue" }, { "key": "grossCollections", "label": "Gross collections (cash)" }] },
  "notes": ["Earned service revenue is on an accrual basis: …", "Gross collections are on a cash basis: …", "Days and months follow the centre's time zone (Asia/Dubai)."]
}
```

(The example shows a subset of the columns.) Column `type` is one of `text | number | money | date | percent`.
`percent` values are percentages with one decimal (`25.0` = 25 %), `null` when there is nothing to divide by.
`chart.type` is `bar | line | pie`; `x` and each series `key` are column keys. Reports that are "as of now"
(`asOfNow: true`) return `period: { asOf, from: null, to: null }`. `GET /reports` returns
`{ canExport, exportFormats, reports: [{ key, title, description, category, permission, parameters, hasDrilldown, asOfNow, branchScoped }] }`
with only the reports the caller's permissions allow.

Drill-down: `{ key, title, period, columns, rows, notes, meta: { page, pageSize, total, totalPages } }`. Rows carry
the ids of the records next to the displayed columns. A report without a drill-down answers 422 `NO_DRILLDOWN`.

### The reports

| Key | Permission | Shows | Default period | Drill-down filter |
| --- | --- | --- | --- | --- |
| `daily-sales` | `report.financial` | Per day: invoices issued, earned service revenue, other revenue, pass-through fees invoiced, tax, total invoiced, payments, refunds, gross collections | month to date (max 366 days) | `date` |
| `monthly-service-revenue` | `report.financial` | Per month: service fees invoiced, credited, earned; other revenue; tax; gross collections | last 12 months | `month` (YYYY-MM) |
| `transactions-by-service` | `report.financial` | Per service: requests submitted / completed and the invoiced amounts by kind | month to date | `serviceId` |
| `outstanding-payments` | `report.financial` | Open invoice balances per customer, aged by days past the due date (not yet due, 1-30, 31-60, 61-90, over 90) | as of now | `customerId`, `bucket` |
| `refunds` | `report.financial` | Every refund paid out: amount, split by fee component, payment method, whether the charge was cancelled, reason | month to date | none (rows are the records) |
| `liabilities` | `report.financial` | Per pass-through fee component: owed at the start, accrued, reversed, remitted, owed at the end | month to date | `component` |
| `corporate-revenue` | `report.financial` | Per corporate account: invoiced amounts by kind, collected on its invoices, open balance now | month to date | `corporateAccountId` |
| `service-profitability` | `report.financial` | Per service: earned revenue, expenses linked to its requests, margin before overheads | month to date | `serviceId` |
| `requests-by-status` | `report.operational` | Where the requests created in the period stand today, with share | month to date | `status` |
| `staff-workload` | `report.operational` | Per staff member: cases assigned / completed in the period, average handling time, open and overdue cases and open tasks now | month to date | `membershipId` |
| `branch-performance` | `report.operational` | Per branch: requests submitted / completed, average processing time, open and overdue now; revenue, collections and open balance only for viewers with `report.financial` | month to date | none |
| `customer-growth` | `report.operational` | Per month: new customers (individuals / businesses), customers at month end, growth | last 12 months | `month` |
| `expiry-reminders` | `report.operational` | Per document type: expiring in the next `withinDays` (default 30), renewals started, reminders sent / not sent (no consent, opted out) / failed in the period | month to date | `kind=upcoming\|sent`, `documentTypeKey` |
| `document-processing-time` | `report.operational` | Per service: completed requests, average / median / 90th percentile hours from submission to completion, and the same for the time spent in document verification | month to date | `serviceId` |
| `customer-satisfaction` | `report.operational` | Ratings 1-5 after completed requests and resolved tickets: count, share, average | month to date | `rating` |

**Merged customers in breakdowns by customer.** An issued invoice keeps the id of the customer record it was
issued to, also after that record was merged into another one (`POST /customers/merge`). `outstanding-payments`
(the report with one row per customer) resolves every such id to the record that was **kept**
(`customers.mergedIntoId` of records with status `MERGED`, chains followed): the retired record has no row of
its own, its invoices are counted in the survivor's row (invoice count and every ageing bucket), and the totals
of the report are unchanged by a merge. In the drill-down, `customerId` stands for the whole family: the id of
the kept record and the id of a retired record return the same invoices, and each row carries the kept record's
id and name. Reports that list single documents (`daily-sales` drill-down, `refunds`, ...) show each document
with the customer it was issued to, as before.

### Export

`GET /reports/refunds/export?format=xlsx&from=2026-10-01&to=2026-10-31` answers with the file:
`Content-Disposition: attachment; filename="refunds_2026-10-01_2026-10-31.xlsx"`, `Cache-Control: private, no-store`.

- **XLSX** (exceljs): sheet "Report" with a styled, frozen header row, typed cells (numbers as numbers, money with
  the format `#,##0.00`, percentages `0.0%`, dates as dates) and a bold totals row; sheet "Parameters" with the
  report name, the centre, when it was generated, the time zone, the currency, the period, the branch scope, the
  filters and the notes (including the financial basis).
- **PDF** (pdfkit): header band in the centre's brand colour with the centre's name (`BrandingService`), the
  parameters, the table with the header repeated on every page, totals, notes, "Page x of y". Landscape when the
  report has more than six columns. Text is Latin-1; other characters are replaced. No logo is embedded.
- **CSV**: UTF-8 with a byte-order mark, RFC 4180 quoting, totals as the last line.
- **Formula injection**: in XLSX and CSV every text value that starts with `=`, `+`, `-`, `@` (also after leading
  white space) or with a tab / carriage return / line feed is prefixed with an apostrophe, and text cells are
  written as text, never as formulas. Numbers and dates are written as typed values and are not affected.
- **Audit**: every export writes `report.exported` (who, which report, format, period, branches, filters, number
  of rows, file size). Viewing a report on screen is not an export.

### Scheduled report

```json
POST /reports/scheduled
{ "reportKey": "monthly-service-revenue", "params": { "range": "last_month" }, "format": "PDF", "frequency": "MONTHLY", "dayOfMonth": 1, "timeOfDay": "07:00", "recipients": ["accountant@centre.example"] }
```

```json
{
  "id": "…", "reportKey": "monthly-service-revenue", "reportTitle": "Monthly service revenue", "params": { "range": "last_month" },
  "format": "PDF", "frequency": "MONTHLY", "timeOfDay": "07:00", "weekday": null, "dayOfMonth": 1, "timeZone": "Asia/Dubai",
  "recipients": ["accountant@centre.example"], "isActive": true, "nextRunAt": "2026-11-01T03:00:00.000Z", "lastRunAt": null, "lastStatus": null,
  "createdById": "…", "createdAt": "…", "link": "https://centre.example/reports/scheduled/…"
}
```

`params`: `range` (required, a relative range - never fixed dates), `branchId?`, `serviceId?`,
`corporateAccountId?`, `component?`, `withinDays?`. `format`: `XLSX` (default) or `PDF`. `frequency`: `DAILY`,
`WEEKLY` (`weekday` 0 = Sunday … 6 = Saturday, default Monday) or `MONTHLY` (`dayOfMonth` 1-28, default 1).
`timeOfDay` is `HH:MM` on the centre's clock (default 07:00). `recipients`: 1-20 email addresses.

Run log (`GET /reports/scheduled/:id/runs`):

```json
{
  "data": [{ "ranAt": "2026-10-01T03:00:41.000Z", "dueAt": "2026-10-01T03:00:00.000Z", "status": "SUCCESS", "detail": null, "period": { "from": "2026-09-01", "to": "2026-09-30" }, "format": "PDF", "rows": 1, "recipients": ["accountant@centre.example"], "documentId": "…", "document": { "id": "…", "title": "Scheduled report: Monthly service revenue (2026-09-01 to 2026-09-30)", "filename": "monthly-service-revenue_2026-09-01_2026-09-30.pdf", "mime": "application/pdf", "sizeBytes": 2214, "available": true } }],
  "meta": { "page": 1, "pageSize": 20, "total": 1, "totalPages": 1 },
  "download": { "method": "POST", "path": "/reports/scheduled/<id>/runs/:documentId/download-link", "permission": "report.financial" }
}
```

## Events and jobs

No domain events are emitted or consumed.

| Job | Schedule | What it does |
| --- | --- | --- |
| `reports.scheduled` | every 15 minutes, all operational tenants (`TenantDirectory.forEachTenant`) | For every active schedule whose `nextRunAt` has passed: generates the file, stores it through `DocumentStorePort` as a restricted file, writes the run to the audit trail, moves `nextRunAt` on, then emails each recipient. One schedule failing does not stop the others. Each tick first restricts report files that were stored before report files were restricted (see "Business rules"). |

The email uses `Messenger` with the template `report.scheduled` (variables `name`, `reportName`, `periodLabel`,
`centreLink`). `centreLink` is `${CENTRE_WEB_URL}/reports/scheduled/<id>`: a page of the centre application that
requires sign-in. The file is never attached and no public link to it exists.

Audit actions: `report.exported`, `report.schedule_created`, `report.schedule_updated`, `report.schedule_deleted`,
`report.scheduled_run` (one per run; this is the run log), `report.scheduled_file_downloaded` (one per download
link, with the document id; the documents module also writes `DOWNLOAD_LINK` to the document's access log).

## Business rules

### The financial basis (every financial figure, here and on the dashboard)

- **GROSS COLLECTIONS** are cash: payments completed in the period (by `receivedAt`; statuses `COMPLETED`,
  `PARTIALLY_REFUNDED`, `REFUNDED`) minus refunds completed in the period (by `processedAt`), all fee components
  and tax included. They are never called revenue. A refund is counted in the branch of its payment.
- **EARNED SERVICE REVENUE** is accrual: the `SERVICE_FEE` lines of invoices issued in the period (status
  `ISSUED`, `PARTIALLY_PAID`, `PAID` or `CREDITED`; drafts and void invoices never count), net of line discounts
  and excluding tax (`lineTotal - taxAmount`), minus the service-fee part of credit notes issued in the period.
  A credit note stores its service-fee part including tax; the tax share is removed in the proportion of the
  invoice's own service-fee lines, rounded to the fils.
- **Pass-through fees**: `GOVERNMENT_FEE` / `THIRD_PARTY_FEE` lines whose fee component is
  `PASS_THROUGH_LIABILITY` are never revenue. They appear as "Government and third-party fees invoiced (not
  revenue)" and in the liabilities report. When the centre configured such a component as `REVENUE` in its finance
  settings, its lines are reported as "Other revenue (fees treated as revenue)", in a column of their own. The
  configuration in force when the report runs is used (there is no history of the setting).
- **Tax** is always a column of its own and part of no revenue figure.
- Every financial report states its basis in `notes`; exports carry the notes too.
- All sums are PostgreSQL `numeric` aggregates and `Decimal` arithmetic. No floating-point arithmetic is used.
- **Liabilities**: from the liability ledger. Accrued = collected on behalf of an authority or third party;
  reversed = refunded or credited; remitted = paid out through an expense marked as a remittance (a voided
  remittance counts back). Owed at the end = owed at the start + accrued - reversed - remitted. Entries are dated
  by the moment they were booked.
- **Service profitability**: margin = earned service revenue + other revenue - expenses linked to requests of the
  service. Remittances of pass-through fees are not a cost and are shown separately. Expenses without a request
  (rent, salaries) are overheads and are not allocated; the notes say so.
- **Outstanding payments**: open balances as of now, aged by whole days past `dueAt` (invoices without a due date
  are "not yet due").
- A voided invoice disappears from the period in which it was issued (reports are not frozen snapshots).

### Scope and privacy

- Reports run in one tenant transaction under row-level security and filter on the tenant id explicitly.
- Branch scope as described under "Period and filters". `customer-growth` and `expiry-reminders` cover the whole
  centre (customers and reminder schedules do not belong to a branch) and ignore `branchId`.
- Customer names appear only for viewers with `customer.read`; others see the customer number.
- `branch-performance` shows its money columns only to viewers with `report.financial`.
- Reports are not narrowed to "requests assigned to me": they need a report permission, which operators do not
  have by default.

### Scheduled reports

- Creating, changing and re-activating a schedule needs the plan feature `scheduledReports` (402
  `PLAN_LIMIT_REACHED`). Switching one off (`{ "isActive": false }`) and deleting it always work. A centre that
  lost the feature keeps its schedules; their runs are recorded as `SKIPPED: Scheduled reports are not included in
  the current plan.`
- The author needs `report.export` and the permission of the report. Members limited to branches must name one of
  their branches for branch-scoped reports (422 `BRANCH_REQUIRED`) and only see schedules of their branches (404
  otherwise).
- **Recipients** must be email addresses of ACTIVE staff members of the same centre whose role holds the report's
  permission and who may see the branch scope of the schedule. Anything else is refused with 422
  `INVALID_RECIPIENTS` and one entry per address in `details.recipients`: `NOT_ACTIVE_STAFF`,
  `NO_REPORT_PERMISSION` or `NO_BRANCH_ACCESS`. External addresses and customers can never be recipients.
  Recipients are checked again at every run: someone who left or lost the permission is skipped
  (`lastStatus: "SUCCESS: 1 recipient(s) skipped"`); when nobody is left the run is `FAILED`.
- The content of a scheduled file is what ALL its recipients may see: money columns of `branch-performance` and
  customer names are only included when every recipient holds the permission for them.
- `nextRunAt` is computed on the centre's own clock (time zone of the tenant), strictly after the previous run.
  The reported period is relative to the moment the run was due, so a late run still covers the intended period.
- A run is idempotent per due time: the schedule row is locked, and a second worker that finds `nextRunAt` already
  moved on does nothing.
- A run that throws is tried again on the next ticks; after 3 failures the occurrence is given up and the schedule
  moves to its next date. `lastStatus` is `SUCCESS`, `SUCCESS: n recipient(s) skipped`, `FAILED: <reason>` or
  `SKIPPED: <reason>`.
- The generated file is stored in the document vault through `DocumentStorePort` as a **restricted file**
  (`restrictedTo: "scheduled-report"`; type `other`, never visible to customers, not attached to a customer or
  request). The vault's general endpoints do not serve restricted files to anybody: `GET /documents`,
  `GET /documents/:id`, the download / preview links, share links, edit, verify, delete and "new version" all
  answer as if the file did not exist, whatever the caller holds (`document.read`, `document.delete` ...).
- Who may open a generated file is the rule of the report, the same as for running it on demand:
  `POST /reports/scheduled/:id/runs/:documentId/download-link` needs the permission of that report
  (`report.financial` for a financial report, `report.operational` otherwise; 403 without it) and the branch
  scope of the schedule (a member limited to branches does not see a schedule over all branches or over another
  branch: 404). `report.export` is needed to create and manage schedules, not to read their files, so every
  eligible recipient can open the file the email announces. The document must be a run of that schedule (run
  log); any other document id is 404, so the route cannot be used to read vault documents. The link is
  short-lived, the download is audited (`report.scheduled_file_downloaded`) and logged on the document.
- Files generated before this rule existed were ordinary vault documents. The job restricts them on its next
  tick (only documents that the run log proves to be report files; a document that merely has a similar title
  is left alone), and a download through the report route does the same at once. Each change is audited
  (`document.restricted`).
