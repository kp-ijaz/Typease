import type { Method } from './http';
import { dubaiDay } from './jobs';
import type { World } from './world';

type Ids = Record<string, string>;

/**
 * One request aimed at ONE record: `path(target)` names the record by ids of
 * the target centre, `body(own)` is a complete, valid request body built from
 * the caller's own centre (so the only thing wrong with the request is whose
 * record the path names).
 *
 * The isolation spec sends each of them twice:
 *   - as centre A against the ids of centre B  -> must be refused, 404;
 *   - as centre A against A's own ids (control) -> must NOT be refused as
 *     unknown / invalid, which proves the request itself is a real one.
 */
export interface RecordAttack {
  resource: string;
  method: Method;
  path: (x: Ids) => string;
  body?: (own: World) => unknown;
  /**
   * The route is a list of sub-records ("the extractions of document X"): for a record of another centre it
   * answers like for a record that does not exist - 200 with an empty page - instead of 404.
   */
  emptyList?: true;
  /**
   * `false` = no control: the request cannot succeed on the caller's own record either, for a reason that
   * has nothing to do with whose record it is (state, plan, configuration). Say why in `why`.
   */
  control?: false;
  why?: string;
}

const A = (resource: string, method: Method, path: (x: Ids) => string, body?: (own: World) => unknown, extra: Partial<RecordAttack> = {}): RecordAttack => ({ resource, method, path, body, ...extra });
const soon = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

/**
 * Read / update / delete / download, resource type by resource type. Order matters only for the control run
 * (own records): reads first, then changes, destructive ones at the end of each block.
 */
export const RECORD_ATTACKS: RecordAttack[] = [
  // ---------------------------------------------------------------- customers
  A('customer', 'GET', (x) => `/customers/${x.walkIn}`),
  A('customer', 'GET', (x) => `/customers/${x.walkIn}/identity`),
  A('customer', 'GET', (x) => `/customers/${x.walkIn}/activity`),
  A('customer', 'GET', (x) => `/customers/${x.walkIn}/notes`),
  A('customer', 'GET', (x) => `/customers/${x.walkIn}/contacts`),
  A('customer', 'GET', (x) => `/customers/${x.walkIn}/consents`),
  A('customer', 'GET', (x) => `/privacy/consents/customers/${x.walkIn}/history`),
  A('customer', 'PATCH', (x) => `/customers/${x.walkIn}`, () => ({ fullName: 'Renamed By Another Centre' })),
  A('customer', 'PUT', (x) => `/customers/${x.walkIn}/consents`, () => ({ purpose: 'MARKETING', granted: true })),
  A('customer', 'POST', (x) => `/customers/${x.walkIn}/notes`, () => ({ body: 'A note from another centre' })),
  A('customer', 'PATCH', (x) => `/customers/${x.walkIn}/notes/${x.customerNote}`, () => ({ isPinned: true })),
  A('customer', 'POST', (x) => `/customers/${x.walkIn}/contacts`, () => ({ type: 'EMAIL', value: 'intruder@example.test', label: 'Other' })),
  A('customer', 'PATCH', (x) => `/customers/${x.walkIn}/contacts/${x.customerContact}`, () => ({ label: 'Changed' })),
  A('customer', 'POST', (x) => `/customers/${x.walkIn}/tags/${x.customerTag}`),
  A('customer', 'PUT', (x) => `/customers/${x.walkIn}/tags`, (own) => ({ tagIds: [own.ids.customerTag] })),
  A('customer', 'POST', (x) => `/customers/${x.walkIn}/portal-invitation`, () => ({})),
  A('customer', 'DELETE', (x) => `/customers/${x.walkIn}/tags/${x.customerTag}`),
  A('customer', 'DELETE', (x) => `/customers/${x.walkIn}/contacts/${x.customerContact}`),
  A('customer', 'DELETE', (x) => `/customers/${x.walkIn}/notes/${x.customerNote}`),
  A('customer', 'POST', (x) => `/customers/${x.walkIn}/archive`, () => ({ reason: 'Archived by another centre' })),
  A('customer', 'POST', (x) => `/customers/${x.walkIn}/restore`, () => ({})),
  A('customer tag', 'PATCH', (x) => `/customer-tags/${x.customerTag}`, () => ({ name: 'Renamed tag' })),
  A('customer tag', 'DELETE', (x) => `/customer-tags/${x.customerTag}`),

  // ---------------------------------------------------------------- requests
  A('request', 'GET', (x) => `/requests/${x.request}`),
  A('request', 'GET', (x) => `/requests/${x.request}/comments`),
  A('request', 'GET', (x) => `/requests/${x.request}/external-references`),
  A('request', 'PATCH', (x) => `/requests/${x.neighbourRequest}`, () => ({ priority: 'URGENT' })),
  A('request', 'PUT', (x) => `/requests/${x.neighbourRequest}/fields`, () => ({ values: { purpose: 'Changed by another centre' } })),
  A('request', 'POST', (x) => `/requests/${x.neighbourRequest}/comments`, () => ({ body: 'A comment from another centre', visibility: 'CUSTOMER' })),
  A('request', 'POST', (x) => `/requests/${x.neighbourRequest}/assign`, (own) => ({ assigneeMembershipId: own.crew.operator.membershipId, role: 'OPERATOR' })),
  A('request', 'POST', (x) => `/requests/${x.neighbourRequest}/auto-assign`, () => ({})),
  A('request', 'POST', (x) => `/requests/${x.neighbourRequest}/checklist`, () => ({ documentTypeKey: 'photo', label: 'Photo asked for by another centre' })),
  A('request', 'PUT', (x) => `/requests/${x.neighbourRequest}/checklist/${x.neighbourChecklistItem}/document`, (own) => ({ documentId: own.ids.neighbourVaultDocument })),
  A('request', 'POST', (x) => `/requests/${x.neighbourRequest}/checklist/${x.neighbourChecklistItem}/waive`, () => ({ reason: 'Waived by another centre' })),
  A('request', 'POST', (x) => `/requests/${x.neighbourRequest}/request-information`, () => ({ message: 'Please send us your passport again.' })),
  A('request', 'POST', (x) => `/requests/${x.neighbourRequest}/transition`, () => ({ to: 'UNDER_REVIEW', reason: 'Moved by another centre' })),
  A('request', 'POST', (x) => `/requests/${x.request}/reopen`, () => ({ reason: 'Reopened by another centre' })),
  A('request', 'POST', (x) => `/requests/${x.neighbourRequest}/mark-duplicate`, (own) => ({ duplicateOfId: own.ids.request })),
  A('request', 'POST', (x) => `/requests/${x.corporateRequest}/submit`, () => ({})),
  A('request', 'POST', (x) => `/requests/${x.corporateRequest}/cancel`, () => ({ reason: 'Cancelled by another centre' })),

  // ---------------------------------------------------------------- documents and their links
  A('document', 'GET', (x) => `/documents/${x.document}`),
  A('document', 'GET', (x) => `/documents/${x.document}/shares`),
  A('document', 'GET', (x) => `/documents/${x.document}/access-logs`),
  A('document', 'GET', (x) => `/documents/${x.document}/extractions`),
  A('document link', 'POST', (x) => `/documents/${x.document}/download-link`, () => ({})),
  A('document link', 'POST', (x) => `/documents/${x.document}/preview-link`, () => ({})),
  A('document link', 'POST', (x) => `/documents/${x.resultDocument}/download-link`, () => ({})),
  A('document link', 'POST', (x) => `/documents/${x.document}/download-link`, (own) => ({ versionId: own.ids.documentVersion }), { control: false, why: 'own document with its own version is the previous line; here the point is a foreign document with a version id of the caller' }),
  A('document', 'PATCH', (x) => `/documents/${x.document}`, () => ({ title: 'Retitled by another centre' })),
  A('document', 'POST', (x) => `/documents/${x.vaultDocument}/verify`, () => ({ decision: 'REJECTED', reason: 'Rejected by another centre' })),
  A('document', 'POST', (x) => `/documents/${x.document}/rescan`, () => ({})),
  A('document', 'PUT', (x) => `/documents/${x.vaultDocument}/legal-hold`, () => ({ legalHold: true, reason: 'Held by another centre' })),
  A('document', 'PUT', (x) => `/documents/${x.vaultDocument}/legal-hold`, () => ({ legalHold: false, reason: 'Released again' })),
  A('document share', 'POST', (x) => `/documents/${x.document}/shares`, () => ({ recipient: 'Somebody outside' })),
  A('document share', 'DELETE', (x) => `/documents/${x.document}/shares/${x.share}`),
  A('document', 'POST', (x) => `/documents/${x.document}/versions/${x.documentVersion}/complete`, () => ({}), { control: false, why: 'the upload of that version was completed long ago (409 on the own record)' }),
  A('document', 'DELETE', (x) => `/documents/${x.vaultDocument}`),
  A('document', 'POST', (x) => `/documents/${x.vaultDocument}/restore`, () => ({})),

  // ---------------------------------------------------------------- quotations
  A('quotation', 'GET', (x) => `/quotations/${x.quotation}`),
  A('quotation', 'GET', (x) => `/quotations/${x.quotation}/pdf`),
  A('quotation', 'PATCH', (x) => `/quotations/${x.neighbourQuotation}`, () => ({ notes: 'Changed by another centre' })),
  A('quotation', 'POST', (x) => `/quotations/${x.neighbourQuotation}/discount/approve`, () => ({ note: 'Approved by another centre' })),
  A('quotation', 'POST', (x) => `/quotations/${x.neighbourQuotation}/discount/reject`, () => ({ reason: 'Rejected by another centre' })),
  A('quotation', 'POST', (x) => `/quotations/${x.neighbourQuotation}/send`, () => ({})),
  A('quotation', 'POST', (x) => `/quotations/${x.neighbourQuotation}/reject`, () => ({ reason: 'Rejected by another centre' })),
  A('quotation', 'POST', (x) => `/quotations/${x.neighbourQuotation}/approve`, () => ({ note: 'Approved by another centre on behalf of the customer' })),
  A('quotation', 'POST', (x) => `/quotations/${x.neighbourQuotation}/cancel`, () => ({})),
  A('quotation', 'POST', (x) => `/quotations/from-request/${x.neighbourRequest}`, () => ({})),

  // ---------------------------------------------------------------- invoices and credit notes
  A('invoice', 'GET', (x) => `/invoices/${x.invoice}`),
  A('invoice', 'GET', (x) => `/invoices/${x.invoice}/pdf`),
  A('invoice', 'GET', (x) => `/finance/corporate-accounts/${x.corporateAccount}/statement`),
  A('credit note', 'GET', (x) => `/credit-notes/${x.creditNote}`),
  A('credit note', 'GET', (x) => `/credit-notes/${x.creditNote}/pdf`),
  A('invoice', 'PATCH', (x) => `/invoices/${x.draftInvoice}`, () => ({ notes: 'Changed by another centre' })),
  A('invoice', 'POST', (x) => `/invoices/${x.draftInvoice}/issue`, () => ({})),
  A('invoice', 'POST', (x) => `/invoices/${x.openInvoice}/pay`, () => ({})),
  A('invoice', 'POST', (x) => `/invoices/${x.openInvoice}/void`, () => ({ reason: 'Voided by another centre' })),

  // ---------------------------------------------------------------- payments and refunds
  A('payment', 'GET', (x) => `/payments/${x.payment}`),
  A('payment', 'GET', (x) => `/payments/${x.payment}/receipt/pdf`),
  A('refund', 'GET', (x) => `/refunds/${x.refund}`),
  A('refund', 'GET', (x) => `/refunds/${x.pendingRefund}`),
  A('refund', 'POST', (x) => `/refunds/${x.pendingRefund}/approve`, () => ({ reference: 'Paid out by another centre' })),
  A('refund', 'POST', (x) => `/refunds/${x.pendingRefund}/complete`, () => ({ reference: 'Completed by another centre' })),
  A('refund', 'POST', (x) => `/refunds/${x.pendingRefund}/process`, () => ({})),
  A('refund', 'POST', (x) => `/refunds/${x.pendingRefund}/reject`, () => ({ reason: 'Rejected by another centre' })),
  A('expense', 'GET', (x) => `/expenses/${x.expense}`),
  A('expense', 'PATCH', (x) => `/expenses/${x.expense}`, () => ({ description: 'Changed by another centre' })),
  A('expense', 'DELETE', (x) => `/expenses/${x.expense}`),
  A('reconciliation', 'GET', (x) => `/reconciliations/${x.reconciliation}`),
  A('reconciliation', 'PATCH', (x) => `/reconciliations/${x.reconciliation}`, () => ({ notes: 'Changed by another centre' })),
  A('reconciliation', 'POST', (x) => `/reconciliations/${x.reconciliation}/close`, () => ({ notes: 'Closed by another centre' })),

  // ---------------------------------------------------------------- appointments and the queue
  A('appointment', 'GET', (x) => `/appointments/${x.appointment}`),
  A('appointment', 'PATCH', (x) => `/appointments/${x.appointment}`, () => ({ notes: 'Changed by another centre' })),
  A('appointment', 'POST', (x) => `/appointments/${x.appointment}/confirm`, () => ({})),
  A('appointment', 'POST', (x) => `/appointments/${x.appointment}/reschedule`, () => ({ startsAt: soon(3 * 24 * 60), reason: 'Moved by another centre' })),
  A('appointment', 'POST', (x) => `/appointments/${x.appointment}/check-in`, () => ({ issueToken: false })),
  A('appointment', 'POST', (x) => `/appointments/${x.appointment}/no-show`, () => ({})),
  A('appointment', 'POST', (x) => `/appointments/${x.appointment}/cancel`, () => ({ reason: 'Cancelled by another centre' })),
  A('appointment slots', 'PATCH', (x) => `/appointments/slot-configs/${x.slotConfig}`, () => ({ capacity: 9 })),
  A('appointment slots', 'DELETE', (x) => `/appointments/slot-configs/${x.slotConfig}`),
  A('branch closure', 'DELETE', (x) => `/appointments/closures/${x.closure}`),
  A('queue token', 'POST', (x) => `/queue/tokens/${x.queueToken}/start`, () => ({})),
  A('queue token', 'POST', (x) => `/queue/tokens/${x.queueToken}/cancel`, () => ({})),

  // ---------------------------------------------------------------- tasks and tickets
  A('task', 'GET', (x) => `/tasks/${x.task}`),
  A('task', 'PATCH', (x) => `/tasks/${x.task}`, () => ({ title: 'Retitled by another centre' })),
  A('task', 'PUT', (x) => `/tasks/${x.task}/assignees`, (own) => ({ assigneeIds: [own.crew.receptionist.membershipId] })),
  A('task', 'POST', (x) => `/tasks/${x.task}/claim`, () => ({})),
  A('task', 'POST', (x) => `/tasks/${x.task}/status`, () => ({ status: 'DONE' })),
  A('ticket', 'GET', (x) => `/support/tickets/${x.ticket}`),
  A('ticket', 'PATCH', (x) => `/support/tickets/${x.ticket}`, () => ({ priority: 'URGENT' })),
  A('ticket', 'POST', (x) => `/support/tickets/${x.ticket}/messages`, () => ({ body: 'A reply from another centre' })),
  A('ticket', 'POST', (x) => `/support/tickets/${x.ticket}/status`, () => ({ status: 'CLOSED' })),
  A('platform ticket', 'GET', (x) => `/support/platform-tickets/${x.platformTicket}`),
  A('platform ticket', 'POST', (x) => `/support/platform-tickets/${x.platformTicket}/messages`, () => ({ body: 'A message from another centre' })),

  // ---------------------------------------------------------------- staff, roles, branches
  A('staff', 'GET', (x) => `/staff/${x.staff}`),
  A('staff', 'GET', (x) => `/staff/${x.staff}/schedule`),
  A('staff', 'PATCH', (x) => `/staff/${x.staff}`, () => ({ jobTitle: 'Changed by another centre' })),
  A('staff', 'PATCH', (x) => `/staff/${x.staff}`, () => ({ roleKey: 'owner' }), { control: false, why: 'promoting the own receptionist to owner would succeed and change later controls' }),
  A('staff', 'PUT', (x) => `/staff/${x.staff}/schedule`, (own) => ({ entries: [{ branchId: own.ids.branch, weekday: 1, startTime: '09:00', endTime: '17:00' }] })),
  A('staff', 'POST', (x) => `/staff/${x.invitedStaff}/resend-invitation`, () => ({})),
  A('staff', 'DELETE', (x) => `/staff/${x.invitedStaff}`),
  A('role', 'PATCH', (x) => `/roles/${x.role}`, () => ({ name: 'Renamed by another centre', permissions: ['customer.read', 'refund.approve'] })),
  A('role', 'DELETE', (x) => `/roles/${x.role}`),
  A('branch', 'PATCH', (x) => `/branches/${x.branch2}`, () => ({ name: 'Renamed by another centre' })),
  A('branch', 'PUT', (x) => `/branding/branches/${x.branch2}`, () => ({ displayName: 'Rebranded by another centre' })),

  // ---------------------------------------------------------------- services and workflows
  A('service', 'GET', (x) => `/services/${x.service}`),
  A('service', 'GET', (x) => `/services/${x.service}/full`),
  A('service', 'GET', (x) => `/services/${x.service}/price`),
  A('service', 'GET', (x) => `/services/${x.service}/prices`),
  A('service', 'GET', (x) => `/services/${x.service}/requirements`),
  A('service', 'GET', (x) => `/services/${x.service}/forms`),
  A('service', 'GET', (x) => `/services/${x.service}/forms/${x.form}`),
  A('service', 'PATCH', (x) => `/services/${x.service}`, () => ({ name: 'Renamed by another centre' })),
  A('service', 'POST', (x) => `/services/${x.service}/prices`, () => ({ serviceFee: '1.00' })),
  A('service', 'POST', (x) => `/services/${x.service}/requirements`, () => ({ documentTypeKey: 'photo', label: 'Added by another centre' })),
  A('service', 'PATCH', (x) => `/services/${x.service}/requirements/${x.requirement}`, () => ({ label: 'Changed by another centre' })),
  A('service', 'POST', (x) => `/services/${x.service}/forms`, () => ({ schema: { steps: [{ key: 'one', title: 'One', fields: [{ key: 'note', label: 'Note', type: 'text' }] }] } })),
  A('service', 'POST', (x) => `/services/${x.service}/forms/${x.form}/archive`, () => ({})),
  A('service', 'DELETE', (x) => `/services/${x.service}/requirements/${x.requirement}`),
  A('service', 'DELETE', (x) => `/services/${x.spareService}`),
  A('service', 'POST', (x) => `/services/${x.spareService}/restore`, () => ({})),
  A('service category', 'PATCH', (x) => `/service-categories/${x.category}`, () => ({ name: 'Renamed by another centre' })),
  A('document type', 'PATCH', (x) => `/document-types/${x.documentType}`, () => ({ name: 'Renamed by another centre' })),
  A('document type', 'DELETE', (x) => `/document-types/${x.documentType}`),
  A('workflow', 'GET', (x) => `/workflows/${x.workflow}`),
  A('workflow', 'GET', (x) => `/workflows/${x.workflow}/versions`),
  A('workflow', 'GET', (x) => `/workflows/${x.workflow}/versions/${x.workflowVersion}`),
  A('workflow', 'PATCH', (x) => `/workflows/${x.workflow}`, () => ({ name: 'Renamed by another centre' })),
  A('workflow', 'POST', (x) => `/workflows/${x.workflow}/versions`, () => ({ notes: 'Draft by another centre' })),
  A('workflow', 'POST', (x) => `/workflows/${x.workflow}/set-default`, () => ({})),
  A('workflow', 'POST', (x) => `/requests/${x.neighbourRequest}/workflow/migrate`, () => ({})),

  // ---------------------------------------------------------------- reports, audit trail, notifications, automations
  A('scheduled report', 'GET', (x) => `/reports/scheduled/${x.scheduledReport}`),
  A('scheduled report', 'GET', (x) => `/reports/scheduled/${x.scheduledReport}/runs`),
  A('scheduled report', 'POST', (x) => `/reports/scheduled/${x.scheduledReport}/runs/${x.document}/download-link`, () => ({}), { control: false, why: 'the document is not a file of that schedule (404 on the own record as well); the route is in the table for the foreign schedule id' }),
  A('scheduled report', 'PATCH', (x) => `/reports/scheduled/${x.scheduledReport}`, () => ({ isActive: false })),
  A('scheduled report', 'DELETE', (x) => `/reports/scheduled/${x.scheduledReport}`),
  A('audit log', 'GET', (x) => `/audit-logs/${x.auditLog}`),
  A('notification', 'GET', (x) => `/notifications/${x.notification}`),
  A('notification', 'POST', (x) => `/notifications/${x.notification}/retry`, () => ({})),
  A('notification', 'POST', (x) => `/me/notifications/${x.ownerInboxNotification}/read`, () => ({})),
  A('automation', 'GET', (x) => `/automations/${x.automation}`),
  A('automation', 'PATCH', (x) => `/automations/${x.automation}`, () => ({ name: 'Renamed by another centre' })),
  A('automation', 'POST', (x) => `/automations/${x.automation}/test`, () => ({})),
  A('automation', 'POST', (x) => `/automations/${x.automation}/enable`, () => ({})),
  A('automation', 'POST', (x) => `/automations/${x.automation}/disable`, () => ({})),
  A('automation', 'DELETE', (x) => `/automations/${x.automation}`),
  A('reminder', 'GET', (x) => `/reminders/${x.reminder}`),
  A('reminder', 'PATCH', (x) => `/reminders/${x.reminder}`, () => ({ expiryDate: dubaiDay(400) })),
  A('reminder', 'POST', (x) => `/reminders/${x.reminder}/renewal-link`, () => ({})),
  A('reminder', 'POST', (x) => `/reminders/${x.reminder}/pause`, () => ({})),
  A('reminder', 'POST', (x) => `/reminders/${x.reminder}/resume`, () => ({})),
  A('reminder', 'POST', (x) => `/reminders/${x.reminder}/cancel`, () => ({ reason: 'Cancelled by another centre' })),

  // ---------------------------------------------------------------- corporate accounts and employees
  A('corporate account', 'GET', (x) => `/corporate-accounts/${x.corporateAccount}`),
  A('corporate account', 'GET', (x) => `/corporate-accounts/${x.corporateAccount}/members`),
  A('corporate account', 'GET', (x) => `/corporate-accounts/${x.corporateAccount}/agreements`),
  A('corporate account', 'GET', (x) => `/corporate-accounts/${x.corporateAccount}/prices`),
  A('corporate employee', 'GET', (x) => `/corporate-accounts/${x.corporateAccount}/employees`),
  A('corporate employee', 'GET', (x) => `/corporate-accounts/${x.corporateAccount}/employees/${x.corporateEmployee}`),
  A('corporate account', 'PATCH', (x) => `/corporate-accounts/${x.corporateAccount}`, () => ({ notes: 'Changed by another centre' })),
  A('corporate account', 'POST', (x) => `/corporate-accounts/${x.corporateAccount}/verify`, () => ({ note: 'Verified by another centre' })),
  A('corporate account', 'POST', (x) => `/corporate-accounts/${x.corporateAccount}/credit`, () => ({ approved: true, creditLimit: '999999.00', paymentTermsDays: 365, note: 'Credit raised by another centre' })),
  A('corporate account', 'POST', (x) => `/corporate-accounts/${x.corporateAccount}/members`, () => ({ fullName: 'Planted Contact', email: `planted-${Date.now().toString(36)}@example.test` })),
  A('corporate account', 'PATCH', (x) => `/corporate-accounts/${x.corporateAccount}/members/${x.corporateMember}`, () => ({ isAuthorisedSignatory: false })),
  A('corporate account', 'POST', (x) => `/corporate-accounts/${x.corporateAccount}/members/${x.corporateMember}/resend-invitation`, () => ({}), { control: false, why: 'the own contact has accepted the invitation already (409)' }),
  A('corporate employee', 'POST', (x) => `/corporate-accounts/${x.corporateAccount}/employees`, () => ({ fullName: 'Planted Employee' })),
  A('corporate employee', 'POST', (x) => `/corporate-accounts/${x.corporateAccount}/employees/bulk`, () => ({ employees: [{ fullName: 'Planted Employee Two' }] })),
  A('corporate employee', 'PATCH', (x) => `/corporate-accounts/${x.corporateAccount}/employees/${x.corporateEmployee}`, () => ({ designation: 'Changed by another centre' })),
  A('corporate employee', 'POST', (x) => `/corporate-accounts/${x.corporateAccount}/employees/${x.corporateEmployee}/login`, () => ({})),
  A('corporate employee', 'POST', (x) => `/corporate-accounts/${x.corporateAccount}/employees/${x.corporateEmployee}/login/resend-invitation`, () => ({})),
  A('corporate employee', 'DELETE', (x) => `/corporate-accounts/${x.corporateAccount}/employees/${x.corporateEmployee}/login`),
  A('corporate account', 'POST', (x) => `/corporate-accounts/${x.corporateAccount}/agreements`, () => ({ title: 'Agreement planted by another centre', startsOn: dubaiDay(0) })),
  A('corporate account', 'PATCH', (x) => `/corporate-accounts/${x.corporateAccount}/agreements/${x.corporateAgreement}`, () => ({ title: 'Changed by another centre' })),
  A('corporate account', 'PUT', (x) => `/corporate-accounts/${x.corporateAccount}/prices`, (own) => ({ serviceId: own.ids.service, serviceFee: '1.00' })),
  A('corporate account', 'DELETE', (x) => `/corporate-accounts/${x.corporateAccount}/prices/${x.corporatePrice}`),
  A('corporate account', 'DELETE', (x) => `/corporate-accounts/${x.corporateAccount}/agreements/${x.corporateAgreement}`),
  A('corporate account', 'DELETE', (x) => `/corporate-accounts/${x.corporateAccount}/members/${x.corporateMember}`),
  A('corporate account', 'POST', (x) => `/corporate-accounts/${x.corporateAccount}/suspend`, () => ({ reason: 'Suspended by another centre' })),
  A('corporate account', 'POST', (x) => `/corporate-accounts/${x.corporateAccount}/reactivate`, () => ({ reason: 'Reactivated again' })),

  // ---------------------------------------------------------------- administration and privacy
  A('integration', 'GET', (x) => `/integrations/${x.integration}`),
  A('integration', 'PATCH', (x) => `/integrations/${x.integration}`, () => ({ name: 'Renamed by another centre' })),
  A('integration', 'PUT', (x) => `/integrations/${x.integration}/secrets`, () => ({ secrets: { webhookSecret: 'planted-by-another-centre-000000000000' } })),
  A('integration', 'POST', (x) => `/integrations/${x.integration}/test`, () => ({})),
  A('integration', 'POST', (x) => `/integrations/${x.integration}/disable`, () => ({})),
  A('integration', 'POST', (x) => `/integrations/${x.integration}/enable`, () => ({})),
  A('domain', 'POST', (x) => `/domains/${x.domain}/verify`, () => ({})),
  A('domain', 'DELETE', (x) => `/domains/${x.domain}`),
  A('privacy request', 'GET', (x) => `/privacy/requests/${x.privacyRequest}`),
  A('privacy request', 'POST', (x) => `/privacy/requests/${x.privacyRequest}/review`, () => ({})),
  A('privacy request', 'POST', (x) => `/privacy/requests/${x.privacyRequest}/decision`, () => ({ decision: 'APPROVED', decisionNote: 'Approved by another centre' })),
  A('privacy request', 'POST', (x) => `/privacy/requests/${x.privacyRequest}/complete`, () => ({})),
  A('retention policy', 'PATCH', (x) => `/privacy/retention-policies/${x.retentionPolicy}`, () => ({ retainDays: 1 })),
  A('privacy incident', 'GET', (x) => `/privacy/incidents/${x.privacyIncident}`),
  A('privacy incident', 'PATCH', (x) => `/privacy/incidents/${x.privacyIncident}`, () => ({ title: 'Retitled by another centre' })),
  A('privacy incident', 'POST', (x) => `/privacy/incidents/${x.privacyIncident}/status`, () => ({ status: 'RESOLVED', resolutionNotes: 'Closed by another centre' })),
  A('processor record', 'PATCH', (x) => `/privacy/processors/${x.processor}`, () => ({ purpose: 'Changed by another centre' })),
  A('processor record', 'DELETE', (x) => `/privacy/processors/${x.processor}`),
  A('support access', 'GET', (x) => `/support-access/${x.accessGrant}`),
  A('support access', 'POST', (x) => `/support-access/${x.accessGrant}/approve`, () => ({ note: 'Approved by another centre' })),
  A('support access', 'POST', (x) => `/support-access/${x.accessGrant}/deny`, () => ({ note: 'Denied by another centre' }), { control: false, why: 'the own request was approved by the line before (409)' }),
  A('support access', 'POST', (x) => `/support-access/${x.accessGrant}/revoke`, () => ({ note: 'Revoked by another centre' })),
  A('session', 'DELETE', (x) => `/auth/sessions/${x.receptionistSession}`, undefined, { control: false, why: 'sessions belong to a person, not to a centre: the owner cannot end a colleague\'s session through this route either (404)' }),
];

/**
 * A request in the caller's OWN centre that carries an id of another centre in
 * its body: `body(own, foreign)`. Attack: foreign = ids of the other centre ->
 * refused. Control: foreign = own ids -> accepted (2xx), which proves that the
 * only reason for the refusal was the foreign id.
 */
export interface ReferenceAttack {
  what: string;
  method: Method;
  path: (own: Ids) => string;
  body: (own: World, f: Ids) => unknown;
  headers?: () => Record<string, string>;
  /** The refusal, when it is not the plain 404 "not found". */
  refusedWith?: [number, string];
  control?: false;
  why?: string;
}
const R = (what: string, method: Method, path: (own: Ids) => string, body: (own: World, f: Ids) => unknown, extra: Partial<ReferenceAttack> = {}): ReferenceAttack => ({ what, method, path, body, ...extra });
const line = (description: string, serviceId?: string) => ({ description, component: 'SERVICE_FEE', quantity: 1, unitAmount: '10.00', ...(serviceId ? { serviceId } : {}) });
const key = () => ({ 'Idempotency-Key': `ref-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}` });
const u = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const REFERENCE_ATTACKS: ReferenceAttack[] = [
  // customers
  R('customer -> corporate account', 'POST', () => '/customers', (own, f) => ({ type: 'INDIVIDUAL', fullName: `Linked Person ${u()}`, corporateAccountId: f.corporateAccount })),
  R('customer -> tags', 'POST', () => '/customers', (own, f) => ({ type: 'INDIVIDUAL', fullName: `Tagged Person ${u()}`, tagIds: [f.customerTag] })),
  R('customer update -> corporate account', 'PATCH', (o) => `/customers/${o.neighbour}`, (own, f) => ({ corporateAccountId: f.corporateAccount })),
  R('customer tags -> tag', 'PUT', (o) => `/customers/${o.neighbour}/tags`, (own, f) => ({ tagIds: [f.customerTag] })),
  R('customer merge -> source', 'POST', () => '/customers/merge', (own, f) => ({ targetId: own.ids.neighbour, sourceId: f.walkIn, confirmSourceCustomerNo: 'CUS-000003', reason: 'Merging a record of another centre' }), { control: false, why: 'a merge of two own customers needs the right customer number and would remove a customer later controls use' }),
  // requests
  R('request -> service', 'POST', () => '/requests', (own, f) => ({ serviceId: f.service, customerId: own.ids.neighbour, branchId: own.ids.branch, fields: { purpose: 'x' } })),
  R('request -> customer', 'POST', () => '/requests', (own, f) => ({ serviceId: own.ids.service, customerId: f.neighbour, branchId: own.ids.branch, fields: { purpose: 'x' } })),
  R('request -> branch', 'POST', () => '/requests', (own, f) => ({ serviceId: own.ids.service, customerId: own.ids.neighbour, branchId: f.branch, fields: { purpose: 'x' } })),
  R('request -> corporate account', 'POST', () => '/requests', (own, f) => ({ serviceId: own.ids.service, customerId: own.ids.corporateEmployeeCustomer, branchId: own.ids.branch, corporateAccountId: f.corporateAccount, fields: { purpose: 'x' } })),
  R('request -> reminder schedule', 'POST', () => '/requests', (own, f) => ({ serviceId: own.ids.service, customerId: own.ids.walkIn, branchId: own.ids.branch, renewalOfScheduleId: f.reminder, fields: { purpose: 'x' } })),
  R('request assignment -> staff member', 'POST', (o) => `/requests/${o.neighbourRequest}/assign`, (own, f) => ({ assigneeMembershipId: f.operator, role: 'OPERATOR', reason: 'Somebody from another centre' })),
  R('request checklist -> document', 'PUT', (o) => `/requests/${o.neighbourRequest}/checklist/${o.neighbourChecklistItem}/document`, (own, f) => ({ documentId: f.neighbourVaultDocument })),
  R('request duplicate -> request', 'POST', (o) => `/requests/${o.corporateRequest}/mark-duplicate`, (own, f) => ({ duplicateOfId: f.request })),
  // documents
  R('upload -> customer', 'POST', () => '/documents/upload-intents', (own, f) => ({ customerId: f.walkIn, documentTypeKey: 'other', filename: 'x.pdf', mime: 'application/pdf', sizeBytes: 500 })),
  R('upload -> request', 'POST', () => '/documents/upload-intents', (own, f) => ({ customerId: own.ids.neighbour, requestId: f.neighbourRequest, documentTypeKey: 'other', filename: 'x.pdf', mime: 'application/pdf', sizeBytes: 500 })),
  R('upload -> checklist line', 'POST', () => '/documents/upload-intents', (own, f) => ({ customerId: own.ids.neighbour, requestId: own.ids.neighbourRequest, checklistItemId: f.neighbourChecklistItem, documentTypeKey: 'passport', filename: 'x.pdf', mime: 'application/pdf', sizeBytes: 500 })),
  R('upload -> replaced document', 'POST', () => '/documents/upload-intents', (own, f) => ({ customerId: own.ids.neighbour, replacesDocumentId: f.neighbourVaultDocument, documentTypeKey: 'other', filename: 'x.pdf', mime: 'application/pdf', sizeBytes: 500 })),
  R('download link -> version of another document', 'POST', (o) => `/documents/${o.document}/download-link`, (own, f) => ({ versionId: f.documentVersion })),
  R('upload -> corporate account', 'POST', () => '/documents/upload-intents', (own, f) => ({ corporateAccountId: f.corporateAccount, documentTypeKey: 'other', filename: 'x.pdf', mime: 'application/pdf', sizeBytes: 500 })),
  // finance
  R('quotation -> customer', 'POST', () => '/quotations', (own, f) => ({ customerId: f.walkIn, items: [line('Typing')] })),
  R('quotation -> request', 'POST', () => '/quotations', (own, f) => ({ customerId: own.ids.neighbour, requestId: f.neighbourRequest, items: [line('Typing')] })),
  R('quotation -> branch', 'POST', () => '/quotations', (own, f) => ({ customerId: own.ids.walkIn, branchId: f.branch, items: [line('Typing')] })),
  R('quotation -> corporate account', 'POST', () => '/quotations', (own, f) => ({ customerId: own.ids.corporateEmployeeCustomer, corporateAccountId: f.corporateAccount, items: [line('Typing')] })),
  R('quotation line -> service', 'POST', () => '/quotations', (own, f) => ({ customerId: own.ids.walkIn, items: [line('Typing', f.service)] })),
  R('invoice -> customer', 'POST', () => '/invoices', (own, f) => ({ customerId: f.walkIn, items: [line('Typing')] })),
  R('invoice -> request', 'POST', () => '/invoices', (own, f) => ({ customerId: own.ids.neighbour, requestId: f.neighbourRequest, items: [line('Typing')] })),
  R('invoice -> branch', 'POST', () => '/invoices', (own, f) => ({ customerId: own.ids.walkIn, branchId: f.branch, items: [line('Typing')] })),
  R('invoice -> corporate account', 'POST', () => '/invoices', (own, f) => ({ customerId: own.ids.corporateEmployeeCustomer, corporateAccountId: f.corporateAccount, items: [line('Typing')] })),
  R('invoice line -> service', 'POST', () => '/invoices', (own, f) => ({ customerId: own.ids.walkIn, items: [line('Typing', f.service)] })),
  R('payment -> invoice', 'POST', () => '/payments', (own, f) => ({ method: 'CASH', amount: '1.00', branchId: own.ids.branch, allocations: [{ invoiceId: f.openInvoice, amount: '1.00' }] }), { headers: key }),
  R('payment -> branch', 'POST', () => '/payments', (own, f) => ({ method: 'CASH', amount: '1.00', branchId: f.branch, allocations: [{ invoiceId: own.ids.openInvoice, amount: '1.00' }] }), { headers: key }),
  R('payment -> customer', 'POST', () => '/payments', (own, f) => ({ method: 'CASH', amount: '1.00', branchId: own.ids.branch, customerId: f.walkIn, allocations: [{ invoiceId: own.ids.openInvoice, amount: '1.00' }] }), { headers: key }),
  R('refund -> payment', 'POST', () => '/refunds', (own, f) => ({ paymentId: f.payment, amount: '1.00', reason: 'Refund of a payment of another centre' }), { headers: key }),
  R('refund -> invoice', 'POST', () => '/refunds', (own, f) => ({ paymentId: own.ids.payment, invoiceId: f.invoice, amount: '1.00', reason: 'Refund against an invoice of another centre' }), { headers: key, refusedWith: [422, 'NOT_ALLOCATED'] }),
  R('credit note -> invoice', 'POST', () => '/credit-notes', (own, f) => ({ invoiceId: f.openInvoice, amount: '1.00', reason: 'Credit on an invoice of another centre' })),
  R('expense -> branch', 'POST', () => '/expenses', (own, f) => ({ branchId: f.branch, category: 'OTHER', description: 'Expense in a branch of another centre', amount: '1.00', paidOn: dubaiDay(0) })),
  R('expense -> request', 'POST', () => '/expenses', (own, f) => ({ branchId: own.ids.branch, category: 'OTHER', requestId: f.request, description: 'Expense on a request of another centre', amount: '1.00', paidOn: dubaiDay(0) })),
  R('reconciliation -> branch', 'POST', () => '/reconciliations', (own, f) => ({ method: 'CARD_POS', branchId: f.branch, periodStart: `${dubaiDay(-1)}T00:00:00.000Z`, periodEnd: soon(1), settledAmount: '0.00' })),
  R('reconciliation -> payments', 'POST', (o) => `/reconciliations/${o.reconciliation}/payments`, (own, f) => ({ paymentIds: [f.payment] })),
  // operations
  R('appointment -> branch', 'POST', () => '/appointments', (own, f) => ({ branchId: f.branch, startsAt: own.freeSlot(), guestName: 'Walk-in Visitor' }), { control: false, why: 'the slot is only free once; the control of "appointment -> customer" books it' }),
  R('appointment -> customer', 'POST', () => '/appointments', (own, f) => ({ branchId: own.ids.branch, startsAt: own.freeSlot(), customerId: f.neighbour })),
  R('appointment -> request', 'POST', () => '/appointments', (own, f) => ({ branchId: own.ids.branch, startsAt: own.freeSlot(), customerId: own.ids.neighbour, requestId: f.neighbourRequest })),
  R('appointment -> staff member', 'POST', () => '/appointments', (own, f) => ({ branchId: own.ids.branch, startsAt: own.freeSlot(), customerId: own.ids.neighbour, staffId: f.staff })),
  R('appointment -> service', 'POST', () => '/appointments', (own, f) => ({ branchId: own.ids.branch, startsAt: own.freeSlot(), customerId: own.ids.neighbour, serviceId: f.service })),
  R('appointment update -> request', 'PATCH', (o) => `/appointments/${o.appointment}`, (own, f) => ({ requestId: f.request })),
  R('slot configuration -> branch', 'POST', () => '/appointments/slot-configs', (own, f) => ({ branchId: f.branch2, weekday: 5, startTime: '10:00', endTime: '12:00' })),
  R('branch closure -> branch', 'POST', () => '/appointments/closures', (own, f) => ({ branchId: f.branch2, date: dubaiDay(45), reason: 'Closure planted by another centre' })),
  R('queue token -> branch', 'POST', () => '/queue/tokens', (own, f) => ({ branchId: f.branch })),
  R('queue token -> customer', 'POST', () => '/queue/tokens', (own, f) => ({ branchId: own.ids.branch, customerId: f.neighbour })),
  R('queue token -> appointment', 'POST', () => '/queue/tokens', (own, f) => ({ branchId: own.ids.branch, appointmentId: f.spareAppointment }), { control: false, why: 'a token for an appointment needs the visitor to be checked in, which is only possible on the day (409 for the own appointment)' }),
  R('task -> customer', 'POST', () => '/tasks', (own, f) => ({ title: 'Task about a customer of another centre', customerId: f.neighbour })),
  R('task -> request', 'POST', () => '/tasks', (own, f) => ({ title: 'Task about a request of another centre', requestId: f.request })),
  R('task -> assignee', 'POST', () => '/tasks', (own, f) => ({ title: 'Task for a colleague of another centre', assigneeIds: [f.staff] })),
  R('task -> branch', 'POST', () => '/tasks', (own, f) => ({ title: 'Task in a branch of another centre', branchId: f.branch })),
  R('task assignees -> staff member', 'PUT', (o) => `/tasks/${o.task}/assignees`, (own, f) => ({ assigneeIds: [f.staff] })),
  R('ticket -> customer', 'POST', () => '/support/tickets', (own, f) => ({ subject: 'Ticket for a customer of another centre', message: 'Hello', customerId: f.neighbour })),
  R('ticket -> request', 'POST', () => '/support/tickets', (own, f) => ({ subject: 'Ticket about a request of another centre', message: 'Hello', customerId: own.ids.customer, requestId: f.request })),
  R('ticket -> assignee', 'POST', () => '/support/tickets', (own, f) => ({ subject: 'Ticket for a colleague of another centre', message: 'Hello', customerId: own.ids.neighbour, assigneeId: f.staff })),
  R('ticket -> attachment', 'POST', () => '/support/tickets', (own, f) => ({ subject: 'Ticket with a file of another centre', message: 'Hello', customerId: own.ids.neighbour, attachments: [f.neighbourVaultDocument] })),
  R('ticket update -> assignee', 'PATCH', (o) => `/support/tickets/${o.ticket}`, (own, f) => ({ assigneeId: f.staff })),
  R('reminder -> customer', 'POST', () => '/reminders', (own, f) => ({ customerId: f.walkIn, documentTypeKey: 'passport', expiryDate: dubaiDay(300) })),
  R('reminder -> document', 'POST', () => '/reminders', (own, f) => ({ customerId: own.ids.neighbour, documentId: f.neighbourVaultDocument, documentTypeKey: 'other', expiryDate: dubaiDay(300) })),
  R('reminder -> corporate account', 'POST', () => '/reminders', (own, f) => ({ corporateAccountId: f.corporateAccount, documentTypeKey: 'trade_licence', expiryDate: dubaiDay(300) })),
  // organisation and catalogue
  R('staff invitation -> branch', 'POST', () => '/staff/invitations', (own, f) => ({ email: `planted-${u()}@example.test`, fullName: 'Planted Colleague', roleKey: 'receptionist', allBranches: false, branchIds: [f.branch2] })),
  R('staff update -> branch', 'PATCH', (o) => `/staff/${o.staff}`, (own, f) => ({ allBranches: false, branchIds: [f.branch2] })),
  R('staff update -> services', 'PATCH', (o) => `/staff/${o.staff}`, (own, f) => ({ serviceIds: [f.service] })),
  R('staff schedule -> branch', 'PUT', (o) => `/staff/${o.staff}/schedule`, (own, f) => ({ entries: [{ branchId: f.branch2, weekday: 2, startTime: '09:00', endTime: '17:00' }] })),
  R('service -> category', 'POST', () => '/services', (own, f) => ({ categoryId: f.category, code: `X-${u()}`.toUpperCase(), name: 'Service in a category of another centre', price: { serviceFee: '10.00' } })),
  R('service -> workflow', 'POST', () => '/services', (own, f) => ({ categoryId: own.ids.category, code: `Y-${u()}`.toUpperCase(), name: 'Service with a workflow of another centre', workflowDefinitionId: f.workflow, price: { serviceFee: '10.00' } })),
  R('service -> branches', 'POST', () => '/services', (own, f) => ({ categoryId: own.ids.category, code: `Z-${u()}`.toUpperCase(), name: 'Service in a branch of another centre', allBranches: false, branchIds: [f.branch2], price: { serviceFee: '10.00' } })),
  R('service update -> workflow', 'PATCH', (o) => `/services/${o.spareService}`, (own, f) => ({ workflowDefinitionId: f.workflow })),
  R('service price -> branch', 'POST', (o) => `/services/${o.spareService}/prices`, (own, f) => ({ branchId: f.branch2, serviceFee: '10.00' })),
  R('service order -> services', 'PUT', () => '/services/order', (own, f) => ({ ids: [f.service, f.spareService] })),
  R('category order -> categories', 'PUT', () => '/service-categories/order', (own, f) => ({ ids: [f.category] })),
  R('corporate price -> service', 'PUT', (o) => `/corporate-accounts/${o.corporateAccount}/prices`, (own, f) => ({ serviceId: f.spareService, serviceFee: '5.00' })),
  R('scheduled report -> branch', 'POST', () => '/reports/scheduled', (own, f) => ({ reportKey: 'requests-by-status', params: { range: 'last_month', branchId: f.branch }, frequency: 'MONTHLY', recipients: [own.centre.owner.email] })),
  R('scheduled report -> service', 'POST', () => '/reports/scheduled', (own, f) => ({ reportKey: 'requests-by-status', params: { range: 'last_month', serviceId: f.service }, frequency: 'WEEKLY', recipients: [own.centre.owner.email] })),
  R('privacy request -> customer', 'POST', () => '/privacy/requests', (own, f) => ({ type: 'ACCESS', customerId: f.walkIn, details: 'Access request for a customer of another centre' })),
];

/**
 * Valid bodies for routes that are not in the table of record attacks (the populated centre has no record of
 * that kind to run a control against, or the route is covered there with another id). The route sweep uses
 * them so that a foreign id is refused as "not found" and not earlier, as an invalid body.
 */
export const SWEEP_BODIES: Record<string, (own: World) => unknown> = {
  'POST /api/v1/ocr/results/:id/apply': () => ({ fields: ['passportNumber'] }),
  'POST /api/v1/ocr/results/:id/review': () => ({ fields: [{ key: 'passportNumber', value: 'N1234567' }] }),
  'POST /api/v1/corporate-accounts/:id/archive': () => ({ reason: 'Archived by another centre' }),
  'POST /api/v1/privacy/processors/:id/review': () => ({ decision: 'APPROVED' }),
  'POST /api/v1/reconciliations/:id/payments': (own) => ({ paymentIds: [own.ids.payment] }),
  'POST /api/v1/reconciliations/:id/payments/remove': (own) => ({ paymentIds: [own.ids.payment] }),
  'POST /api/v1/requests/:id/approvals/:approvalId/decide': () => ({ decision: 'APPROVED' }),
  'POST /api/v1/requests/:id/external-references': () => ({ channel: 'MANUAL_PORTAL', referenceNo: 'SAMPLE-REF-1' }),
  'PATCH /api/v1/requests/:id/external-references/:refId': () => ({ status: 'In progress' }),
  'POST /api/v1/requests/:id/external-result': () => ({ outcome: 'COMPLETED' }),
  'PUT /api/v1/services/:id/forms/:formId': () => ({ schema: { steps: [{ key: 'one', title: 'One', fields: [{ key: 'note', label: 'Note', type: 'text' }] }] } }),
  'PUT /api/v1/services/:id/requirements/order': (own) => ({ ids: [own.ids.requirement] }),
  'PUT /api/v1/workflows/:id/versions/:versionId/steps': () => ({ steps: [{ key: 'finish', name: 'Finish', type: 'COMPLETION' }] }),
  // portal routes
  'POST /api/v1/me/tickets/:id/messages': () => ({ body: 'A reply from somebody else' }),
  'POST /api/v1/me/appointments/:id/reschedule': () => ({ startsAt: soon(3 * 24 * 60) }),
  'POST /api/v1/me/appointments/:id/cancel': () => ({ reason: 'Cancelled by somebody else' }),
};

/**
 * A complete, valid body for a route of the table (from SWEEP_BODIES, else from the record attack that uses the
 * route), so that a request with a foreign id is refused for the id and not for its body. `{}` when the route
 * takes no body or none is known.
 */
export function bodyForRoute(route: { method: string; path: string }, own: World, sample: Ids): unknown {
  const name = `${route.method} ${route.path}`;
  if (SWEEP_BODIES[name]) return SWEEP_BODIES[name](own);
  const pattern = new RegExp(`^${route.path.replace('/api/v1', '').replace(/:[A-Za-z]+/g, '[^/]+')}$`);
  return RECORD_ATTACKS.find((x) => x.method === route.method && pattern.test(x.path(sample)))?.body?.(own) ?? {};
}

/**
 * Routes that list sub-records of a record WITHOUT looking the record itself up, so that a foreign or unknown
 * id gives an empty page (200) instead of 404. docs/architecture/BACKEND_CONVENTIONS.md section 2 asks for 404;
 * the list is kept explicit so that it cannot grow unnoticed. It is empty: the two routes that used to be here
 * (`GET /documents/:id/extractions`, `GET /privacy/consents/customers/:customerId/history`) now answer 404.
 */
export const EMPTY_SUBLIST_ROUTES: string[] = [];

/** Lists and reports filtered by an id of another centre: the answer must be empty (or a refusal), never a row of that centre. */
export const FOREIGN_FILTERS: Array<(f: Ids) => string> = [
  (f) => `/customers?corporateAccountId=${f.corporateAccount}`,
  (f) => `/customers?tagId=${f.customerTag}`,
  (f) => `/requests?customerId=${f.customer}`,
  (f) => `/requests?serviceId=${f.service}`,
  (f) => `/requests?branchId=${f.branch}`,
  (f) => `/requests?corporateAccountId=${f.corporateAccount}`,
  (f) => `/requests?assignedToId=${f.operator}`,
  (f) => `/requests/counts?branchId=${f.branch}`,
  (f) => `/documents?customerId=${f.customer}`,
  (f) => `/documents?requestId=${f.request}`,
  (f) => `/documents?corporateAccountId=${f.corporateAccount}`,
  (f) => `/documents/checklist-assist?requestId=${f.neighbourRequest}`,
  (f) => `/ocr/results?documentId=${f.document}`,
  (f) => `/quotations?customerId=${f.customer}`,
  (f) => `/quotations?requestId=${f.request}`,
  (f) => `/invoices?customerId=${f.customer}`,
  (f) => `/invoices?requestId=${f.request}`,
  (f) => `/invoices?corporateAccountId=${f.corporateAccount}`,
  (f) => `/invoices?branchId=${f.branch}`,
  (f) => `/payments?invoiceId=${f.invoice}`,
  (f) => `/payments?customerId=${f.customer}`,
  (f) => `/payments?requestId=${f.request}`,
  (f) => `/refunds?paymentId=${f.payment}`,
  (f) => `/refunds?invoiceId=${f.invoice}`,
  (f) => `/credit-notes?invoiceId=${f.invoice}`,
  (f) => `/expenses?requestId=${f.request}`,
  (f) => `/expenses?branchId=${f.branch}`,
  (f) => `/finance/liabilities?requestId=${f.request}`,
  (f) => `/finance/liabilities?branchId=${f.branch}`,
  (f) => `/appointments?customerId=${f.customer}`,
  (f) => `/appointments?branchId=${f.branch}`,
  (f) => `/appointments?staffId=${f.staff}`,
  (f) => `/appointments/availability?branchId=${f.branch}&date=${dubaiDay(3)}`,
  (f) => `/appointments/slot-configs?branchId=${f.branch}`,
  (f) => `/appointments/closures?branchId=${f.branch2}`,
  (f) => `/queue/tokens?branchId=${f.branch}`,
  (f) => `/queue/counters?branchId=${f.branch}`,
  (f) => `/queue/stats?branchId=${f.branch}`,
  (f) => `/tasks?customerId=${f.customer}`,
  (f) => `/tasks?requestId=${f.request}`,
  (f) => `/tasks?assigneeId=${f.staff}`,
  (f) => `/tasks?branchId=${f.branch}`,
  (f) => `/support/tickets?customerId=${f.customer}`,
  (f) => `/support/tickets?requestId=${f.request}`,
  (f) => `/support/tickets?assigneeId=${f.staff}`,
  (f) => `/support/feedback?customerId=${f.customer}`,
  (f) => `/reminders?customerId=${f.walkIn}&includeExpired=true`,
  (f) => `/reminders?corporateAccountId=${f.corporateAccount}`,
  (f) => `/notifications?customerId=${f.customer}`,
  (f) => `/audit-logs?resourceId=${f.customer}`,
  (f) => `/audit-logs?resourceType=Customer&resourceId=${f.walkIn}`,
  (f) => `/audit-logs?actorUserId=${f.ownerUser}`,
  (f) => `/audit-logs?supportGrantId=${f.accessGrant}`,
  (f) => `/privacy/requests?customerId=${f.customer}`,
  (f) => `/privacy/consents?customerId=${f.customer}`,
  (f) => `/automations/executions?ruleId=${f.automation}`,
  (f) => `/integrations/logs?integrationId=${f.integration}`,
  (f) => `/staff/workload?branchId=${f.branch}`,
  (f) => `/services?categoryId=${f.category}`,
  (f) => `/services?branchId=${f.branch}`,
  (f) => `/dashboard?branchId=${f.branch}`,
  (f) => `/dashboard/trends?branchId=${f.branch}`,
  (f) => `/reports/daily-sales?range=today&branchId=${f.branch}`,
  (f) => `/reports/transactions-by-service?range=today&serviceId=${f.service}`,
  (f) => `/reports/corporate-revenue?range=today&corporateAccountId=${f.corporateAccount}`,
  (f) => `/reports/outstanding-payments?customerId=${f.customer}`,
  (f) => `/reports/outstanding-payments/drilldown?customerId=${f.customer}`,
  (f) => `/reports/requests-by-status?range=today&branchId=${f.branch}`,
  (f) => `/reports/daily-sales/export?format=csv&range=today&branchId=${f.branch}`,
];

/** Path parameters that are not record ids. */
const NAME_PARAMS: Record<string, string> = { key: 'daily-sales', eventKey: 'request.completed', channel: 'EMAIL', language: 'en', token: 'x'.repeat(43), sessionRef: 'cs_unknown', gateway: 'sandbox' };
export const isIdParam = (param: string) => !(param in NAME_PARAMS);
export const nameParam = (param: string) => NAME_PARAMS[param];

const BY_PARAM: Record<string, string> = {
  agreementId: 'corporateAgreement', employeeId: 'corporateEmployee', memberId: 'corporateMember', contactId: 'customerContact', noteId: 'customerNote',
  tagId: 'customerTag', shareId: 'share', branchId: 'branch2', customerId: 'walkIn', requestId: 'neighbourRequest', documentId: 'document',
  itemId: 'neighbourChecklistItem', formId: 'form', requirementId: 'requirement',
};
const BY_SEGMENT: Record<string, string> = {
  documents: 'document', appointments: 'appointment', closures: 'closure', 'slot-configs': 'slotConfig', 'audit-logs': 'auditLog', sessions: 'receptionistSession',
  automations: 'automation', branches: 'branch2', domains: 'domain', catalogue: 'service', 'corporate-accounts': 'corporateAccount', 'customer-tags': 'customerTag',
  customers: 'walkIn', 'document-types': 'documentType', 'credit-notes': 'creditNote', expenses: 'expense', integrations: 'integration', invoices: 'openInvoice',
  notifications: 'notification', payments: 'payment', incidents: 'privacyIncident', processors: 'processor', 'retention-policies': 'retentionPolicy', tokens: 'queueToken',
  quotations: 'neighbourQuotation', reconciliations: 'reconciliation', refunds: 'pendingRefund', reminders: 'reminder', scheduled: 'scheduledReport',
  requests: 'neighbourRequest', roles: 'role', 'service-categories': 'category', services: 'service', tickets: 'ticket', 'platform-tickets': 'platformTicket',
  'support-access': 'accessGrant', tasks: 'task', staff: 'staff', workflows: 'workflow', 'from-request': 'neighbourRequest',
};

/**
 * Which harvested record of a centre fits a path parameter of a route - e.g. `:noteId` of
 * `/customers/:id/notes/:noteId` is the centre's customer note. `undefined`: the populated centre has no
 * record of that kind (the caller then uses an id that belongs to nothing and says so).
 */
export function recordIdFor(ids: Ids, routePath: string, param: string, before: string): string | undefined {
  const path = routePath.replace('/api/v1', '');
  if (param === 'priceId') return path.startsWith('/corporate-accounts') ? ids.corporatePrice : ids.price;
  if (param === 'versionId') return path.startsWith('/documents') ? ids.documentVersion : ids.workflowVersion;
  if (param === 'approvalId' || param === 'refId') return undefined;
  if (param !== 'id') return ids[BY_PARAM[param]];
  if (path.startsWith('/privacy/') && before === 'requests') return ids.privacyRequest;
  if (path.startsWith('/me/notifications')) return ids.ownerInboxNotification;
  if (path.startsWith('/subscription/') || path.startsWith('/ocr/') || before === 'executions') return undefined;
  return ids[BY_SEGMENT[before]];
}
