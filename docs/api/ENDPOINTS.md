# TypEase API - endpoint index

Generated from the application metadata by `pnpm --filter @typease/api openapi`. 590 endpoints.
Request and response details are in `docs/api/modules/*.md` and `openapi.json` (also served at `/api/docs` outside production).


## AI document assistant

| Method | Path | Access |
| --- | --- | --- |
| POST | `/api/v1/documents/:id/extract` | ocr.run |
| GET | `/api/v1/documents/:id/extractions` | ocr.run or ocr.review |
| GET | `/api/v1/ocr/results` | ocr.run or ocr.review |
| GET | `/api/v1/ocr/results/:id` | ocr.run or ocr.review |
| POST | `/api/v1/ocr/results/:id/apply` | ocr.review |
| POST | `/api/v1/ocr/results/:id/review` | ocr.review |
| GET | `/api/v1/ocr/usage` | ocr.review or settings.manage or report.operational |

## Appointments

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/appointments` | appointment.read or appointment.manage |
| POST | `/api/v1/appointments` | appointment.manage |
| GET | `/api/v1/appointments/:id` | appointment.read or appointment.manage |
| PATCH | `/api/v1/appointments/:id` | appointment.manage |
| POST | `/api/v1/appointments/:id/cancel` | appointment.manage |
| POST | `/api/v1/appointments/:id/check-in` | appointment.manage |
| POST | `/api/v1/appointments/:id/complete` | appointment.manage |
| POST | `/api/v1/appointments/:id/confirm` | appointment.manage |
| POST | `/api/v1/appointments/:id/no-show` | appointment.manage |
| POST | `/api/v1/appointments/:id/reschedule` | appointment.manage |
| POST | `/api/v1/appointments/:id/start` | appointment.manage |
| GET | `/api/v1/appointments/availability` | appointment.read or appointment.manage or self.appointments |
| GET | `/api/v1/appointments/closures` | appointment.read or appointment.manage |
| POST | `/api/v1/appointments/closures` | appointment.manage |
| DELETE | `/api/v1/appointments/closures/:id` | appointment.manage |
| GET | `/api/v1/appointments/settings` | appointment.read or appointment.manage |
| PUT | `/api/v1/appointments/settings` | appointment.manage |
| GET | `/api/v1/appointments/slot-configs` | appointment.read or appointment.manage |
| POST | `/api/v1/appointments/slot-configs` | appointment.manage |
| DELETE | `/api/v1/appointments/slot-configs/:id` | appointment.manage |
| PATCH | `/api/v1/appointments/slot-configs/:id` | appointment.manage |
| GET | `/api/v1/me/appointments` | self.appointments |
| POST | `/api/v1/me/appointments` | self.appointments |
| GET | `/api/v1/me/appointments/:id` | self.appointments |
| POST | `/api/v1/me/appointments/:id/cancel` | self.appointments |
| POST | `/api/v1/me/appointments/:id/reschedule` | self.appointments |

## Audit logs

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/audit-logs` | audit.read |
| GET | `/api/v1/audit-logs/:id` | audit.read |
| GET | `/api/v1/audit-logs/export` | audit.read |

## Authentication

| Method | Path | Access |
| --- | --- | --- |
| POST | `/api/v1/auth/invitations/accept` | Public |
| GET | `/api/v1/auth/invitations/preview` | Public |
| POST | `/api/v1/auth/login` | Public |
| GET | `/api/v1/auth/login-activity` | Signed in |
| POST | `/api/v1/auth/logout` | Public |
| GET | `/api/v1/auth/me` | Signed in (support session: allowed without a scope) |
| PATCH | `/api/v1/auth/me` | Signed in |
| GET | `/api/v1/auth/memberships` | Signed in |
| POST | `/api/v1/auth/mfa/disable` | Signed in |
| POST | `/api/v1/auth/mfa/enable` | Signed in |
| POST | `/api/v1/auth/mfa/setup` | Signed in |
| POST | `/api/v1/auth/mfa/verify` | Public |
| POST | `/api/v1/auth/otp/request` | Public |
| POST | `/api/v1/auth/otp/verify` | Public |
| POST | `/api/v1/auth/password/change` | Signed in |
| POST | `/api/v1/auth/password/forgot` | Public |
| POST | `/api/v1/auth/password/reset` | Public |
| POST | `/api/v1/auth/phone/request-verification` | Signed in |
| POST | `/api/v1/auth/phone/verify` | Signed in |
| POST | `/api/v1/auth/refresh` | Public |
| POST | `/api/v1/auth/register` | Public |
| POST | `/api/v1/auth/resend-verification` | Public |
| POST | `/api/v1/auth/select-tenant` | Public |
| GET | `/api/v1/auth/sessions` | Signed in |
| DELETE | `/api/v1/auth/sessions/:id` | Signed in |
| POST | `/api/v1/auth/sessions/revoke-others` | Signed in |
| POST | `/api/v1/auth/support-session/exchange` | Public |
| POST | `/api/v1/auth/switch-tenant` | Signed in |
| POST | `/api/v1/auth/verify-email` | Public |

## Automations

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/automations` | automation.manage |
| POST | `/api/v1/automations` | automation.manage |
| DELETE | `/api/v1/automations/:id` | automation.manage |
| GET | `/api/v1/automations/:id` | automation.manage |
| PATCH | `/api/v1/automations/:id` | automation.manage |
| POST | `/api/v1/automations/:id/disable` | automation.manage |
| POST | `/api/v1/automations/:id/enable` | automation.manage |
| POST | `/api/v1/automations/:id/test` | automation.manage |
| GET | `/api/v1/automations/executions` | automation.manage |
| GET | `/api/v1/automations/executions/:id` | automation.manage |
| POST | `/api/v1/automations/executions/:id/retry` | automation.manage |
| POST | `/api/v1/automations/from-template/:key` | automation.manage |
| GET | `/api/v1/automations/meta` | automation.manage |
| GET | `/api/v1/automations/summary` | automation.manage |
| GET | `/api/v1/automations/templates` | automation.manage |

## Branches

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/branches` | branch.read |
| POST | `/api/v1/branches` | branch.manage |
| PATCH | `/api/v1/branches/:id` | branch.manage |
| GET | `/api/v1/branches/directory` | member kind CUSTOMER/CORPORATE (support session: allowed without a scope) |

## Branding

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/branding` | branding.manage or settings.manage |
| PUT | `/api/v1/branding` | branding.manage |
| PUT | `/api/v1/branding/branches/:branchId` | branding.manage |
| POST | `/api/v1/branding/favicon` | branding.manage |
| POST | `/api/v1/branding/logo` | branding.manage |
| GET | `/api/v1/domains` | domain.manage |
| POST | `/api/v1/domains` | domain.manage |
| DELETE | `/api/v1/domains/:id` | domain.manage |
| POST | `/api/v1/domains/:id/verify` | domain.manage |

## Catalogue (portal)

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/catalogue` | member kind CUSTOMER/CORPORATE |
| GET | `/api/v1/catalogue/:id` | member kind CUSTOMER/CORPORATE |

## Corporate accounts

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/corporate-accounts` | corporate.read |
| POST | `/api/v1/corporate-accounts` | corporate.manage |
| GET | `/api/v1/corporate-accounts/:id` | corporate.read |
| PATCH | `/api/v1/corporate-accounts/:id` | corporate.manage |
| GET | `/api/v1/corporate-accounts/:id/agreements` | corporate.read |
| POST | `/api/v1/corporate-accounts/:id/agreements` | corporate.manage |
| DELETE | `/api/v1/corporate-accounts/:id/agreements/:agreementId` | corporate.manage |
| PATCH | `/api/v1/corporate-accounts/:id/agreements/:agreementId` | corporate.manage |
| POST | `/api/v1/corporate-accounts/:id/archive` | corporate.manage |
| POST | `/api/v1/corporate-accounts/:id/credit` | corporate.verify |
| GET | `/api/v1/corporate-accounts/:id/employees` | corporate.read |
| POST | `/api/v1/corporate-accounts/:id/employees` | corporate.manage |
| GET | `/api/v1/corporate-accounts/:id/employees/:employeeId` | corporate.read |
| PATCH | `/api/v1/corporate-accounts/:id/employees/:employeeId` | corporate.manage |
| DELETE | `/api/v1/corporate-accounts/:id/employees/:employeeId/login` | corporate.manage |
| POST | `/api/v1/corporate-accounts/:id/employees/:employeeId/login` | corporate.manage |
| POST | `/api/v1/corporate-accounts/:id/employees/:employeeId/login/resend-invitation` | corporate.manage |
| POST | `/api/v1/corporate-accounts/:id/employees/bulk` | corporate.manage |
| GET | `/api/v1/corporate-accounts/:id/members` | corporate.read |
| POST | `/api/v1/corporate-accounts/:id/members` | corporate.manage |
| DELETE | `/api/v1/corporate-accounts/:id/members/:memberId` | corporate.manage |
| PATCH | `/api/v1/corporate-accounts/:id/members/:memberId` | corporate.manage |
| POST | `/api/v1/corporate-accounts/:id/members/:memberId/resend-invitation` | corporate.manage |
| GET | `/api/v1/corporate-accounts/:id/prices` | corporate.read |
| PUT | `/api/v1/corporate-accounts/:id/prices` | corporate.manage |
| DELETE | `/api/v1/corporate-accounts/:id/prices/:priceId` | corporate.manage |
| POST | `/api/v1/corporate-accounts/:id/reactivate` | corporate.manage |
| POST | `/api/v1/corporate-accounts/:id/suspend` | corporate.manage |
| POST | `/api/v1/corporate-accounts/:id/verify` | corporate.verify |

## Corporate portal

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/corporate/account` | member kind CORPORATE; corp.account.read |
| GET | `/api/v1/corporate/employees` | member kind CORPORATE; corp.employees.read |
| POST | `/api/v1/corporate/employees` | member kind CORPORATE; corp.employees.manage |
| GET | `/api/v1/corporate/employees/:employeeId` | member kind CORPORATE; corp.employees.read |
| PATCH | `/api/v1/corporate/employees/:employeeId` | member kind CORPORATE; corp.employees.manage |
| DELETE | `/api/v1/corporate/employees/:employeeId/login` | member kind CORPORATE; corp.employees.manage |
| POST | `/api/v1/corporate/employees/:employeeId/login` | member kind CORPORATE; corp.employees.manage |
| POST | `/api/v1/corporate/employees/:employeeId/login/resend-invitation` | member kind CORPORATE; corp.employees.manage |
| POST | `/api/v1/corporate/employees/bulk` | member kind CORPORATE; corp.employees.manage |
| GET | `/api/v1/corporate/members` | member kind CORPORATE; corp.account.read |
| POST | `/api/v1/corporate/members` | member kind CORPORATE; corp.account.manage |
| GET | `/api/v1/corporate/prices` | member kind CORPORATE; corp.account.read |

## Customer tags

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/customer-tags` | customer.read |
| POST | `/api/v1/customer-tags` | customer.update |
| DELETE | `/api/v1/customer-tags/:id` | customer.update |
| PATCH | `/api/v1/customer-tags/:id` | customer.update |

## Customers

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/customers` | customer.read |
| POST | `/api/v1/customers` | customer.create |
| GET | `/api/v1/customers/:id` | customer.read |
| PATCH | `/api/v1/customers/:id` | customer.update |
| GET | `/api/v1/customers/:id/activity` | customer.read |
| POST | `/api/v1/customers/:id/archive` | customer.archive |
| GET | `/api/v1/customers/:id/consents` | customer.read |
| PUT | `/api/v1/customers/:id/consents` | customer.update |
| GET | `/api/v1/customers/:id/contacts` | customer.read |
| POST | `/api/v1/customers/:id/contacts` | customer.update |
| DELETE | `/api/v1/customers/:id/contacts/:contactId` | customer.update |
| PATCH | `/api/v1/customers/:id/contacts/:contactId` | customer.update |
| GET | `/api/v1/customers/:id/identity` | customer.sensitive.read |
| GET | `/api/v1/customers/:id/notes` | customer.read |
| POST | `/api/v1/customers/:id/notes` | customer.update |
| DELETE | `/api/v1/customers/:id/notes/:noteId` | customer.update |
| PATCH | `/api/v1/customers/:id/notes/:noteId` | customer.update |
| POST | `/api/v1/customers/:id/portal-invitation` | customer.update |
| POST | `/api/v1/customers/:id/restore` | customer.archive |
| PUT | `/api/v1/customers/:id/tags` | customer.update |
| DELETE | `/api/v1/customers/:id/tags/:tagId` | customer.update |
| POST | `/api/v1/customers/:id/tags/:tagId` | customer.update |
| POST | `/api/v1/customers/duplicates/check` | customer.create or customer.update or customer.merge |
| POST | `/api/v1/customers/merge` | customer.merge |

## Dashboard

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/dashboard` | member kind STAFF |
| GET | `/api/v1/dashboard/trends` | member kind STAFF |

## Document types

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/document-types` | Any tenant member (support session: allowed without a scope) |
| POST | `/api/v1/document-types` | service.manage |
| DELETE | `/api/v1/document-types/:id` | service.manage |
| PATCH | `/api/v1/document-types/:id` | service.manage |

## Documents

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/documents` | document.read or self.documents or corp.employees.read or corp.requests.read or corp.account.read |
| DELETE | `/api/v1/documents/:id` | document.delete |
| GET | `/api/v1/documents/:id` | document.read or self.documents or corp.employees.read or corp.requests.read or corp.account.read |
| PATCH | `/api/v1/documents/:id` | document.upload or document.verify |
| GET | `/api/v1/documents/:id/access-logs` | audit.read or privacy.manage |
| POST | `/api/v1/documents/:id/download-link` | document.read or self.documents or corp.employees.read or corp.requests.read or corp.account.read (support session: counts as a read) |
| PUT | `/api/v1/documents/:id/legal-hold` | privacy.manage |
| POST | `/api/v1/documents/:id/preview-link` | document.read or self.documents or corp.employees.read or corp.requests.read or corp.account.read (support session: counts as a read) |
| POST | `/api/v1/documents/:id/rescan` | document.verify |
| POST | `/api/v1/documents/:id/restore` | document.delete |
| GET | `/api/v1/documents/:id/shares` | document.share |
| POST | `/api/v1/documents/:id/shares` | document.share |
| DELETE | `/api/v1/documents/:id/shares/:shareId` | document.share |
| POST | `/api/v1/documents/:id/verify` | document.verify |
| POST | `/api/v1/documents/:id/versions/:versionId/complete` | document.upload or self.documents or corp.employees.manage or corp.requests.create |
| GET | `/api/v1/documents/checklist-assist` | document.read or self.documents or corp.employees.read or corp.requests.read or corp.account.read |
| POST | `/api/v1/documents/upload` | document.upload or self.documents or corp.employees.manage or corp.requests.create |
| POST | `/api/v1/documents/upload-intents` | document.upload or self.documents or corp.employees.manage or corp.requests.create |
| GET | `/api/v1/public/shared-documents/:token` | Public |

## Feature flags

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/feature-flags` | Any tenant member (support session: allowed without a scope) |

## Finance

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/credit-notes` | creditnote.manage or invoice.read or self.payments or corp.invoices.read |
| POST | `/api/v1/credit-notes` | creditnote.manage |
| GET | `/api/v1/credit-notes/:id` | creditnote.manage or invoice.read or self.payments or corp.invoices.read |
| GET | `/api/v1/credit-notes/:id/pdf` | creditnote.manage or invoice.read or self.payments or corp.invoices.read |
| GET | `/api/v1/expenses` | expense.manage |
| POST | `/api/v1/expenses` | expense.manage |
| DELETE | `/api/v1/expenses/:id` | expense.manage |
| GET | `/api/v1/expenses/:id` | expense.manage |
| PATCH | `/api/v1/expenses/:id` | expense.manage |
| GET | `/api/v1/finance/fee-components` | finance.settings or report.financial or payment.reconcile |
| PUT | `/api/v1/finance/fee-components` | finance.settings |
| GET | `/api/v1/finance/liabilities` | report.financial or payment.reconcile |

## Health

| Method | Path | Access |
| --- | --- | --- |
| GET | `/health` | Public |
| GET | `/health/ready` | Public |

## Integrations

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/integrations` | integration.manage |
| POST | `/api/v1/integrations` | integration.manage |
| DELETE | `/api/v1/integrations/:id` | integration.manage |
| GET | `/api/v1/integrations/:id` | integration.manage |
| PATCH | `/api/v1/integrations/:id` | integration.manage |
| POST | `/api/v1/integrations/:id/disable` | integration.manage |
| POST | `/api/v1/integrations/:id/enable` | integration.manage |
| PUT | `/api/v1/integrations/:id/secrets` | integration.manage |
| POST | `/api/v1/integrations/:id/test` | integration.manage |
| GET | `/api/v1/integrations/catalogue` | integration.manage |
| GET | `/api/v1/integrations/logs` | integration.manage |

## Internal

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/internal/metrics` | Internal token |

## Invoices

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/corporate/invoices` | corp.invoices.read |
| GET | `/api/v1/corporate/invoices/statement` | corp.invoices.read |
| GET | `/api/v1/finance/corporate-accounts/:id/statement` | invoice.read or report.financial |
| GET | `/api/v1/invoices` | invoice.read or self.payments or corp.invoices.read |
| POST | `/api/v1/invoices` | invoice.manage |
| GET | `/api/v1/invoices/:id` | invoice.read or self.payments or corp.invoices.read |
| PATCH | `/api/v1/invoices/:id` | invoice.manage |
| POST | `/api/v1/invoices/:id/issue` | invoice.manage |
| POST | `/api/v1/invoices/:id/pay` | self.payments or corp.invoices.read or payment.record |
| GET | `/api/v1/invoices/:id/pdf` | invoice.read or self.payments or corp.invoices.read |
| POST | `/api/v1/invoices/:id/void` | invoice.manage |

## My profile

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/me/consents` | member kind CUSTOMER; self.privacy |
| PUT | `/api/v1/me/consents` | member kind CUSTOMER; self.privacy |
| GET | `/api/v1/me/customer` | member kind CUSTOMER; self.profile |
| PATCH | `/api/v1/me/customer` | member kind CUSTOMER; self.profile |

## Notifications

| Method | Path | Access |
| --- | --- | --- |
| DELETE | `/api/v1/me/devices` | Any tenant member |
| GET | `/api/v1/me/devices` | Any tenant member |
| POST | `/api/v1/me/devices` | Any tenant member |
| GET | `/api/v1/me/notification-preferences` | Any tenant member |
| PUT | `/api/v1/me/notification-preferences` | Any tenant member |
| GET | `/api/v1/me/notifications` | Any tenant member |
| POST | `/api/v1/me/notifications/:id/read` | Any tenant member |
| POST | `/api/v1/me/notifications/read-all` | Any tenant member |
| GET | `/api/v1/notifications` | notification.manage |
| GET | `/api/v1/notifications/:id` | notification.manage |
| POST | `/api/v1/notifications/:id/retry` | notification.manage |
| GET | `/api/v1/notifications/channels` | notification.manage |
| GET | `/api/v1/notifications/events` | notification.manage |
| PATCH | `/api/v1/notifications/events/:eventKey/channels/:channel` | notification.manage |
| GET | `/api/v1/notifications/failures` | notification.manage |
| GET | `/api/v1/notifications/settings` | notification.manage |
| PUT | `/api/v1/notifications/settings` | notification.manage |
| GET | `/api/v1/notifications/templates` | notification.manage |
| DELETE | `/api/v1/notifications/templates/:eventKey/:channel/:language` | notification.manage |
| PUT | `/api/v1/notifications/templates/:eventKey/:channel/:language` | notification.manage |
| POST | `/api/v1/notifications/templates/preview` | notification.manage |

## Payments

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/payments` | payment.read or self.payments or corp.invoices.read |
| POST | `/api/v1/payments` | payment.record |
| GET | `/api/v1/payments/:id` | payment.read or self.payments or corp.invoices.read |
| GET | `/api/v1/payments/:id/receipt/pdf` | payment.read or payment.record or self.payments or corp.invoices.read |

## Platform

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/platform/access-grants` | Platform: platform.access.request |
| GET | `/api/v1/platform/access-grants/:id` | Platform: platform.access.request |
| POST | `/api/v1/platform/access-grants/:id/enter` | Platform: platform.access.request |
| POST | `/api/v1/platform/access-grants/:id/revoke` | Platform: platform.access.request |
| GET | `/api/v1/platform/audit-logs` | Platform: platform.audit.read |
| GET | `/api/v1/platform/audit-logs/:id` | Platform: platform.audit.read |
| GET | `/api/v1/platform/dashboard` | Platform: platform.metrics.read |
| GET | `/api/v1/platform/domains` | Platform: platform.tenants.read |
| DELETE | `/api/v1/platform/domains/:id` | Platform: platform.tenants.manage |
| GET | `/api/v1/platform/feature-flags` | Platform: platform.features.manage |
| DELETE | `/api/v1/platform/feature-flags/:key` | Platform: platform.features.manage |
| PUT | `/api/v1/platform/feature-flags/:key` | Platform: platform.features.manage |
| GET | `/api/v1/platform/feature-flags/:key/overrides` | Platform: platform.features.manage |
| GET | `/api/v1/platform/integrations/approved-providers` | Platform: platform.integrations.manage |
| PUT | `/api/v1/platform/integrations/approved-providers` | Platform: platform.integrations.manage |
| GET | `/api/v1/platform/integrations/authorisations` | Platform: platform.integrations.manage |
| GET | `/api/v1/platform/integrations/authorisations/:id` | Platform: platform.integrations.manage |
| POST | `/api/v1/platform/integrations/authorisations/:id/reject` | Platform: platform.integrations.manage |
| POST | `/api/v1/platform/integrations/authorisations/:id/verify` | Platform: platform.integrations.manage |
| GET | `/api/v1/platform/privacy/incidents` | Platform: platform.audit.read |
| POST | `/api/v1/platform/privacy/incidents` | Platform: platform.tenants.manage |
| GET | `/api/v1/platform/privacy/incidents/:id` | Platform: platform.audit.read |
| PATCH | `/api/v1/platform/privacy/incidents/:id` | Platform: platform.tenants.manage |
| POST | `/api/v1/platform/privacy/incidents/:id/status` | Platform: platform.tenants.manage |
| GET | `/api/v1/platform/privacy/processors` | Platform: platform.audit.read |
| POST | `/api/v1/platform/privacy/processors` | Platform: platform.integrations.manage |
| DELETE | `/api/v1/platform/privacy/processors/:id` | Platform: platform.integrations.manage |
| PATCH | `/api/v1/platform/privacy/processors/:id` | Platform: platform.integrations.manage |
| POST | `/api/v1/platform/privacy/processors/:id/review` | Platform: platform.integrations.manage |
| GET | `/api/v1/platform/reports/churn` | Platform: platform.metrics.read |
| GET | `/api/v1/platform/reports/failed-payments` | Platform: platform.metrics.read |
| GET | `/api/v1/platform/reports/plan-distribution` | Platform: platform.metrics.read |
| GET | `/api/v1/platform/reports/subscription-revenue` | Platform: platform.metrics.read |
| GET | `/api/v1/platform/reports/tenant-growth` | Platform: platform.metrics.read |
| GET | `/api/v1/platform/reports/usage` | Platform: platform.metrics.read |
| GET | `/api/v1/platform/security-events` | Platform: platform.audit.read |
| GET | `/api/v1/platform/security-events/summary` | Platform: platform.audit.read |
| GET | `/api/v1/platform/settings` | Platform: platform.features.manage |
| DELETE | `/api/v1/platform/settings/:key` | Platform: platform.features.manage |
| GET | `/api/v1/platform/settings/:key` | Platform: platform.features.manage |
| PUT | `/api/v1/platform/settings/:key` | Platform: platform.features.manage |
| GET | `/api/v1/platform/staff` | Platform: platform.staff.manage |
| POST | `/api/v1/platform/staff` | Platform: platform.staff.manage |
| PATCH | `/api/v1/platform/staff/:id` | Platform: platform.staff.manage |
| POST | `/api/v1/platform/staff/:id/disable` | Platform: platform.staff.manage |
| POST | `/api/v1/platform/staff/:id/enable` | Platform: platform.staff.manage |
| POST | `/api/v1/platform/staff/:id/invitation` | Platform: platform.staff.manage |
| GET | `/api/v1/platform/support/tickets` | Platform: platform.support.manage |
| GET | `/api/v1/platform/support/tickets/:id` | Platform: platform.support.manage |
| PATCH | `/api/v1/platform/support/tickets/:id` | Platform: platform.support.manage |
| POST | `/api/v1/platform/support/tickets/:id/messages` | Platform: platform.support.manage |
| GET | `/api/v1/platform/system/health` | Platform: platform.metrics.read |
| GET | `/api/v1/platform/system/providers` | Platform: platform.metrics.read |
| GET | `/api/v1/platform/tenants` | Platform: platform.tenants.read |
| POST | `/api/v1/platform/tenants` | Platform: platform.tenants.manage |
| GET | `/api/v1/platform/tenants/:id` | Platform: platform.tenants.read |
| POST | `/api/v1/platform/tenants/:id/access-grants` | Platform: platform.access.request |
| POST | `/api/v1/platform/tenants/:id/approve` | Platform: platform.tenants.manage |
| POST | `/api/v1/platform/tenants/:id/archive` | Platform: platform.tenants.manage |
| POST | `/api/v1/platform/tenants/:id/cancel-offboarding` | Platform: platform.tenants.manage |
| GET | `/api/v1/platform/tenants/:id/feature-flags` | Platform: platform.features.manage |
| DELETE | `/api/v1/platform/tenants/:id/feature-flags/:key` | Platform: platform.features.manage |
| PUT | `/api/v1/platform/tenants/:id/feature-flags/:key` | Platform: platform.features.manage |
| POST | `/api/v1/platform/tenants/:id/offboard` | Platform: platform.tenants.manage |
| POST | `/api/v1/platform/tenants/:id/owner-invitation` | Platform: platform.tenants.manage |
| POST | `/api/v1/platform/tenants/:id/reactivate` | Platform: platform.tenants.manage |
| POST | `/api/v1/platform/tenants/:id/reject` | Platform: platform.tenants.manage |
| POST | `/api/v1/platform/tenants/:id/suspend` | Platform: platform.tenants.manage |

## Platform billing

| Method | Path | Access |
| --- | --- | --- |
| POST | `/api/v1/platform/billing/invoices/:id/pay-offline` | Platform: platform.billing.manage |
| POST | `/api/v1/platform/billing/invoices/:id/void` | Platform: platform.billing.manage |
| GET | `/api/v1/platform/billing/subscriptions` | Platform: platform.billing.manage |
| GET | `/api/v1/platform/billing/tenants/:tenantId` | Platform: platform.billing.manage |
| POST | `/api/v1/platform/billing/tenants/:tenantId/change-plan` | Platform: platform.billing.manage |
| POST | `/api/v1/platform/billing/tenants/:tenantId/coupon` | Platform: platform.billing.manage |
| POST | `/api/v1/platform/billing/tenants/:tenantId/extend-trial` | Platform: platform.billing.manage |
| GET | `/api/v1/platform/billing/tenants/:tenantId/invoices/:id/pdf` | Platform: platform.billing.manage |
| GET | `/api/v1/platform/coupons` | Platform: platform.plans.manage or platform.billing.manage |
| POST | `/api/v1/platform/coupons` | Platform: platform.plans.manage |
| DELETE | `/api/v1/platform/coupons/:id` | Platform: platform.plans.manage |
| PATCH | `/api/v1/platform/coupons/:id` | Platform: platform.plans.manage |
| GET | `/api/v1/platform/plans` | Platform: platform.plans.manage or platform.billing.manage |
| POST | `/api/v1/platform/plans` | Platform: platform.plans.manage |
| DELETE | `/api/v1/platform/plans/:id` | Platform: platform.plans.manage |
| PATCH | `/api/v1/platform/plans/:id` | Platform: platform.plans.manage |

## Privacy

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/privacy/consents` | privacy.manage |
| GET | `/api/v1/privacy/consents/customers/:customerId/history` | privacy.manage |
| GET | `/api/v1/privacy/incidents` | privacy.manage |
| POST | `/api/v1/privacy/incidents` | privacy.manage |
| GET | `/api/v1/privacy/incidents/:id` | privacy.manage |
| PATCH | `/api/v1/privacy/incidents/:id` | privacy.manage |
| POST | `/api/v1/privacy/incidents/:id/status` | privacy.manage |
| GET | `/api/v1/privacy/my/requests` | self.privacy |
| POST | `/api/v1/privacy/my/requests` | self.privacy |
| GET | `/api/v1/privacy/my/requests/:id` | self.privacy |
| GET | `/api/v1/privacy/overview` | privacy.manage |
| GET | `/api/v1/privacy/processors` | privacy.manage |
| POST | `/api/v1/privacy/processors` | privacy.manage |
| DELETE | `/api/v1/privacy/processors/:id` | privacy.manage |
| PATCH | `/api/v1/privacy/processors/:id` | privacy.manage |
| POST | `/api/v1/privacy/processors/:id/review` | privacy.manage |
| GET | `/api/v1/privacy/requests` | privacy.manage |
| POST | `/api/v1/privacy/requests` | privacy.manage |
| GET | `/api/v1/privacy/requests/:id` | privacy.manage |
| POST | `/api/v1/privacy/requests/:id/complete` | privacy.manage |
| POST | `/api/v1/privacy/requests/:id/decision` | privacy.manage |
| POST | `/api/v1/privacy/requests/:id/review` | privacy.manage |
| GET | `/api/v1/privacy/retention-policies` | privacy.manage |
| POST | `/api/v1/privacy/retention-policies` | privacy.manage |
| DELETE | `/api/v1/privacy/retention-policies/:id` | privacy.manage |
| PATCH | `/api/v1/privacy/retention-policies/:id` | privacy.manage |

## Public

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/internal/tls/ask` | Public |
| POST | `/api/v1/public/appointments` | Public |
| GET | `/api/v1/public/appointments/availability` | Public |
| POST | `/api/v1/public/appointments/cancel` | Public |
| GET | `/api/v1/public/appointments/options` | Public |
| GET | `/api/v1/public/assets/:key` | Public |
| GET | `/api/v1/public/payments/sandbox/checkout/:sessionRef` | Public |
| POST | `/api/v1/public/payments/sandbox/checkout/:sessionRef/complete` | Public |
| POST | `/api/v1/public/payments/sandbox/checkout/:sessionRef/fail` | Public |
| GET | `/api/v1/public/plans` | Public |
| GET | `/api/v1/public/queue/display` | Public |
| GET | `/api/v1/public/queue/display/stream` | Public |
| GET | `/api/v1/public/services` | Public |
| GET | `/api/v1/public/services/:id` | Public |
| POST | `/api/v1/public/signup` | Public |
| GET | `/api/v1/public/slug-available` | Public |
| GET | `/api/v1/public/tenant-config` | Public |
| POST | `/api/v1/public/track` | Public |
| POST | `/api/v1/public/webhooks/payments/:gateway` | Public |
| POST | `/api/v1/public/webhooks/subscriptions/:gateway` | Public |

## Queue

| Method | Path | Access |
| --- | --- | --- |
| POST | `/api/v1/queue/call-next` | queue.manage |
| GET | `/api/v1/queue/counters` | queue.manage |
| POST | `/api/v1/queue/display-tokens` | queue.manage |
| POST | `/api/v1/queue/display-tokens/revoke` | queue.manage |
| GET | `/api/v1/queue/stats` | queue.manage or report.operational |
| GET | `/api/v1/queue/tokens` | queue.manage |
| POST | `/api/v1/queue/tokens` | queue.manage |
| POST | `/api/v1/queue/tokens/:id/cancel` | queue.manage |
| POST | `/api/v1/queue/tokens/:id/complete` | queue.manage |
| POST | `/api/v1/queue/tokens/:id/no-show` | queue.manage |
| POST | `/api/v1/queue/tokens/:id/recall` | queue.manage |
| POST | `/api/v1/queue/tokens/:id/start` | queue.manage |

## Quotations

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/quotations` | quotation.read or self.payments or corp.requests.read or corp.requests.approve or corp.invoices.read |
| POST | `/api/v1/quotations` | quotation.manage |
| GET | `/api/v1/quotations/:id` | quotation.read or self.payments or corp.requests.read or corp.requests.approve or corp.invoices.read |
| PATCH | `/api/v1/quotations/:id` | quotation.manage |
| POST | `/api/v1/quotations/:id/approve` | self.payments or corp.requests.approve or quotation.manage |
| POST | `/api/v1/quotations/:id/cancel` | quotation.manage |
| POST | `/api/v1/quotations/:id/discount/approve` | discount.approve |
| POST | `/api/v1/quotations/:id/discount/reject` | discount.approve |
| GET | `/api/v1/quotations/:id/pdf` | quotation.read or self.payments or corp.requests.read or corp.requests.approve or corp.invoices.read |
| POST | `/api/v1/quotations/:id/reject` | self.payments or corp.requests.approve or quotation.manage |
| POST | `/api/v1/quotations/:id/send` | quotation.manage |
| POST | `/api/v1/quotations/from-request/:requestId` | quotation.manage |

## Reconciliation

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/reconciliations` | payment.reconcile |
| POST | `/api/v1/reconciliations` | payment.reconcile |
| GET | `/api/v1/reconciliations/:id` | payment.reconcile |
| PATCH | `/api/v1/reconciliations/:id` | payment.reconcile |
| POST | `/api/v1/reconciliations/:id/close` | payment.reconcile |
| POST | `/api/v1/reconciliations/:id/payments` | payment.reconcile |
| POST | `/api/v1/reconciliations/:id/payments/remove` | payment.reconcile |

## Refunds

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/refunds` | refund.request or refund.approve |
| POST | `/api/v1/refunds` | refund.request |
| GET | `/api/v1/refunds/:id` | refund.request or refund.approve |
| POST | `/api/v1/refunds/:id/approve` | refund.approve |
| POST | `/api/v1/refunds/:id/complete` | refund.approve |
| POST | `/api/v1/refunds/:id/process` | refund.approve |
| POST | `/api/v1/refunds/:id/reject` | refund.approve |

## Reminders

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/me/reminders` | member kind CUSTOMER/CORPORATE |
| GET | `/api/v1/reminders` | reminder.read or reminder.manage |
| POST | `/api/v1/reminders` | reminder.manage |
| GET | `/api/v1/reminders/:id` | reminder.read or reminder.manage |
| PATCH | `/api/v1/reminders/:id` | reminder.manage |
| POST | `/api/v1/reminders/:id/cancel` | reminder.manage |
| POST | `/api/v1/reminders/:id/pause` | reminder.manage |
| POST | `/api/v1/reminders/:id/renewal-link` | reminder.read or reminder.manage (support session: counts as a read) |
| POST | `/api/v1/reminders/:id/resume` | reminder.manage |

## Reports

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/reports` | report.operational or report.financial |
| GET | `/api/v1/reports/:key` | report.operational or report.financial |
| GET | `/api/v1/reports/:key/drilldown` | report.operational or report.financial |
| GET | `/api/v1/reports/:key/export` | report.export |
| GET | `/api/v1/reports/scheduled` | report.export |
| POST | `/api/v1/reports/scheduled` | report.export |
| DELETE | `/api/v1/reports/scheduled/:id` | report.export |
| GET | `/api/v1/reports/scheduled/:id` | report.export |
| PATCH | `/api/v1/reports/scheduled/:id` | report.export |
| GET | `/api/v1/reports/scheduled/:id/runs` | report.operational or report.financial |
| POST | `/api/v1/reports/scheduled/:id/runs/:documentId/download-link` | report.operational or report.financial (support session: counts as a read) |

## Requests

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/requests` | request.read.all or request.read.assigned or self.requests or corp.requests.read |
| POST | `/api/v1/requests` | request.create or self.requests or corp.requests.create |
| GET | `/api/v1/requests/:id` | request.read.all or request.read.assigned or self.requests or corp.requests.read |
| PATCH | `/api/v1/requests/:id` | request.update or self.requests or corp.requests.create |
| POST | `/api/v1/requests/:id/approvals/:approvalId/decide` | request.review |
| POST | `/api/v1/requests/:id/assign` | request.assign |
| POST | `/api/v1/requests/:id/auto-assign` | request.assign |
| POST | `/api/v1/requests/:id/cancel` | request.cancel or self.requests or corp.requests.create |
| POST | `/api/v1/requests/:id/checklist` | request.update or request.process or document.verify |
| DELETE | `/api/v1/requests/:id/checklist/:itemId/document` | request.update or request.process or request.create or document.verify or self.requests or corp.requests.create |
| PUT | `/api/v1/requests/:id/checklist/:itemId/document` | request.update or request.process or request.create or document.verify or self.requests or corp.requests.create |
| POST | `/api/v1/requests/:id/checklist/:itemId/waive` | document.verify |
| GET | `/api/v1/requests/:id/comments` | request.read.all or request.read.assigned or self.requests or corp.requests.read |
| POST | `/api/v1/requests/:id/comments` | request.comment.internal or request.update or request.process or request.review or self.requests or corp.requests.read |
| POST | `/api/v1/requests/:id/complete` | request.review or request.reopen |
| GET | `/api/v1/requests/:id/external-references` | request.read.all or request.read.assigned or self.requests or corp.requests.read |
| POST | `/api/v1/requests/:id/external-references` | request.submit_external |
| PATCH | `/api/v1/requests/:id/external-references/:refId` | request.submit_external or request.process |
| POST | `/api/v1/requests/:id/external-result` | request.process |
| PUT | `/api/v1/requests/:id/fields` | request.update or request.process or request.create or self.requests or corp.requests.create |
| POST | `/api/v1/requests/:id/mark-duplicate` | request.cancel |
| POST | `/api/v1/requests/:id/reopen` | request.reopen |
| POST | `/api/v1/requests/:id/request-information` | document.verify or request.process or request.update |
| POST | `/api/v1/requests/:id/resubmit` | document.verify or request.update or request.process or self.requests or corp.requests.create |
| POST | `/api/v1/requests/:id/submit` | request.create or request.update or self.requests or corp.requests.create |
| POST | `/api/v1/requests/:id/transition` | request.create or request.update or request.process or request.review or request.submit_external or request.cancel or request.reopen or document.verify or quotation.manage or self.requests or corp.requests.create |
| POST | `/api/v1/requests/:id/workflow/complete-step` | request.process |
| POST | `/api/v1/requests/:id/workflow/migrate` | workflow.manage |
| GET | `/api/v1/requests/counts` | request.read.all or request.read.assigned or self.requests or corp.requests.read |

## Roles

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/roles` | staff.read or role.manage or task.manage |
| POST | `/api/v1/roles` | role.manage |
| DELETE | `/api/v1/roles/:id` | role.manage |
| PATCH | `/api/v1/roles/:id` | role.manage |
| GET | `/api/v1/roles/permissions` | staff.read or role.manage |

## Service categories

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/service-categories` | service.read |
| POST | `/api/v1/service-categories` | service.manage |
| DELETE | `/api/v1/service-categories/:id` | service.manage |
| PATCH | `/api/v1/service-categories/:id` | service.manage |
| PUT | `/api/v1/service-categories/order` | service.manage |

## Services

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/services` | service.read |
| POST | `/api/v1/services` | service.manage |
| DELETE | `/api/v1/services/:id` | service.manage |
| GET | `/api/v1/services/:id` | service.read |
| PATCH | `/api/v1/services/:id` | service.manage |
| GET | `/api/v1/services/:id/forms` | service.read |
| POST | `/api/v1/services/:id/forms` | service.manage |
| DELETE | `/api/v1/services/:id/forms/:formId` | service.manage |
| GET | `/api/v1/services/:id/forms/:formId` | service.read |
| PUT | `/api/v1/services/:id/forms/:formId` | service.manage |
| POST | `/api/v1/services/:id/forms/:formId/archive` | service.manage |
| POST | `/api/v1/services/:id/forms/:formId/publish` | service.manage |
| GET | `/api/v1/services/:id/full` | service.read |
| GET | `/api/v1/services/:id/price` | service.read |
| GET | `/api/v1/services/:id/prices` | service.read |
| POST | `/api/v1/services/:id/prices` | service.manage |
| DELETE | `/api/v1/services/:id/prices/:priceId` | service.manage |
| GET | `/api/v1/services/:id/requirements` | service.read |
| POST | `/api/v1/services/:id/requirements` | service.manage |
| DELETE | `/api/v1/services/:id/requirements/:requirementId` | service.manage |
| PATCH | `/api/v1/services/:id/requirements/:requirementId` | service.manage |
| PUT | `/api/v1/services/:id/requirements/order` | service.manage |
| POST | `/api/v1/services/:id/restore` | service.manage |
| PUT | `/api/v1/services/order` | service.manage |
| POST | `/api/v1/services/starter-catalogue` | service.manage |

## Storage

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/storage/local/download/:token` | Public |
| PUT | `/api/v1/storage/local/upload/:token` | Public |

## Subscription

| Method | Path | Access |
| --- | --- | --- |
| POST | `/api/v1/onboarding/plan` | subscription.manage |
| GET | `/api/v1/subscription` | subscription.manage |
| POST | `/api/v1/subscription/cancel` | subscription.manage |
| POST | `/api/v1/subscription/change-plan` | subscription.manage |
| POST | `/api/v1/subscription/coupon` | subscription.manage |
| GET | `/api/v1/subscription/invoices` | subscription.manage |
| GET | `/api/v1/subscription/invoices/:id` | subscription.manage |
| POST | `/api/v1/subscription/invoices/:id/pay` | subscription.manage |
| GET | `/api/v1/subscription/invoices/:id/pdf` | subscription.manage |
| POST | `/api/v1/subscription/restart` | subscription.manage |
| POST | `/api/v1/subscription/resume` | subscription.manage |

## Support

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/me/feedback` | self.tickets or self.requests |
| POST | `/api/v1/me/feedback` | self.tickets or self.requests |
| GET | `/api/v1/me/tickets` | self.tickets |
| POST | `/api/v1/me/tickets` | self.tickets |
| GET | `/api/v1/me/tickets/:id` | self.tickets |
| POST | `/api/v1/me/tickets/:id/messages` | self.tickets |
| GET | `/api/v1/support/feedback` | ticket.read or ticket.manage |
| GET | `/api/v1/support/feedback/summary` | ticket.read or ticket.manage or report.operational |
| GET | `/api/v1/support/platform-tickets` | settings.manage or ticket.manage |
| POST | `/api/v1/support/platform-tickets` | settings.manage or ticket.manage |
| GET | `/api/v1/support/platform-tickets/:id` | settings.manage or ticket.manage |
| POST | `/api/v1/support/platform-tickets/:id/messages` | settings.manage or ticket.manage |
| GET | `/api/v1/support/settings` | ticket.read or ticket.manage |
| PUT | `/api/v1/support/settings` | ticket.manage |
| GET | `/api/v1/support/sla-policies` | ticket.read or ticket.manage |
| PUT | `/api/v1/support/sla-policies` | ticket.manage |
| GET | `/api/v1/support/tickets` | ticket.read or ticket.manage |
| POST | `/api/v1/support/tickets` | ticket.manage |
| GET | `/api/v1/support/tickets/:id` | ticket.read or ticket.manage |
| PATCH | `/api/v1/support/tickets/:id` | ticket.manage |
| POST | `/api/v1/support/tickets/:id/messages` | ticket.manage |
| POST | `/api/v1/support/tickets/:id/status` | ticket.manage |

## Support access

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/support-access` | support_access.decide |
| GET | `/api/v1/support-access/:id` | support_access.decide |
| POST | `/api/v1/support-access/:id/approve` | support_access.decide |
| POST | `/api/v1/support-access/:id/deny` | support_access.decide |
| POST | `/api/v1/support-access/:id/revoke` | support_access.decide |

## Tasks

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/tasks` | task.read or task.manage |
| POST | `/api/v1/tasks` | task.manage |
| GET | `/api/v1/tasks/:id` | member kind STAFF |
| PATCH | `/api/v1/tasks/:id` | task.manage |
| PUT | `/api/v1/tasks/:id/assignees` | task.manage |
| POST | `/api/v1/tasks/:id/claim` | member kind STAFF |
| POST | `/api/v1/tasks/:id/status` | member kind STAFF |
| GET | `/api/v1/tasks/mine` | member kind STAFF |

## Tenants

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/onboarding` | settings.manage |
| PUT | `/api/v1/onboarding/business` | settings.manage |
| POST | `/api/v1/onboarding/complete` | settings.manage |
| PUT | `/api/v1/onboarding/draft` | settings.manage |
| GET | `/api/v1/tenant` | member kind STAFF (support session: allowed without a scope) |
| PATCH | `/api/v1/tenant` | settings.manage |
| PATCH | `/api/v1/tenant/settings` | settings.manage |
| GET | `/api/v1/tenant/usage` | member kind STAFF |

## Users

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/staff` | staff.read or request.assign or task.manage |
| DELETE | `/api/v1/staff/:id` | staff.manage |
| GET | `/api/v1/staff/:id` | staff.read |
| PATCH | `/api/v1/staff/:id` | staff.manage |
| POST | `/api/v1/staff/:id/resend-invitation` | staff.manage |
| GET | `/api/v1/staff/:id/schedule` | staff.read |
| PUT | `/api/v1/staff/:id/schedule` | staff.manage |
| POST | `/api/v1/staff/invitations` | staff.manage |
| GET | `/api/v1/staff/workload` | staff.read or request.assign |

## Workflows

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/workflows` | workflow.manage or service.manage |
| POST | `/api/v1/workflows` | workflow.manage |
| DELETE | `/api/v1/workflows/:id` | workflow.manage |
| GET | `/api/v1/workflows/:id` | workflow.manage or service.manage |
| PATCH | `/api/v1/workflows/:id` | workflow.manage |
| POST | `/api/v1/workflows/:id/archive` | workflow.manage |
| POST | `/api/v1/workflows/:id/set-default` | workflow.manage |
| GET | `/api/v1/workflows/:id/versions` | workflow.manage |
| POST | `/api/v1/workflows/:id/versions` | workflow.manage |
| DELETE | `/api/v1/workflows/:id/versions/:versionId` | workflow.manage |
| GET | `/api/v1/workflows/:id/versions/:versionId` | workflow.manage |
| POST | `/api/v1/workflows/:id/versions/:versionId/publish` | workflow.manage |
| POST | `/api/v1/workflows/:id/versions/:versionId/rollback` | workflow.manage |
| PUT | `/api/v1/workflows/:id/versions/:versionId/steps` | workflow.manage |
| GET | `/api/v1/workflows/builder-meta` | workflow.manage |
| GET | `/api/v1/workflows/templates` | workflow.manage |
| POST | `/api/v1/workflows/validate` | workflow.manage |
