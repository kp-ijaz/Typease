/**
 * TypEase permission catalogue and default role matrix.
 *
 * - Permissions are resource.action keys enforced on every API endpoint.
 * - System roles are provisioned per tenant and can be cloned / customised
 *   (custom roles are stored in the database, see RolePermission).
 * - Platform roles are separate and never grant access to tenant documents.
 */

type Def = { group: string; description: string };

const P = <T extends Record<string, Def>>(x: T) => x;

export const TENANT_PERMISSIONS = P({
  // Customers
  'customer.read': { group: 'Customers', description: 'View customers (identity numbers masked)' },
  'customer.create': { group: 'Customers', description: 'Register customers' },
  'customer.update': { group: 'Customers', description: 'Edit customer profiles, notes and tags' },
  'customer.archive': { group: 'Customers', description: 'Archive or restore customers' },
  'customer.merge': { group: 'Customers', description: 'Merge duplicate customer records' },
  'customer.sensitive.read': { group: 'Customers', description: 'Reveal full identity document numbers (logged)' },
  // Corporate
  'corporate.read': { group: 'Corporate', description: 'View corporate accounts' },
  'corporate.manage': { group: 'Corporate', description: 'Create and edit corporate accounts, employees and pricing' },
  'corporate.verify': { group: 'Corporate', description: 'Verify corporate authorisation and approve credit terms' },
  // Catalogue
  'service.read': { group: 'Services', description: 'View the service catalogue' },
  'service.manage': { group: 'Services', description: 'Create and edit services, prices, forms and requirements' },
  'workflow.manage': { group: 'Services', description: 'Edit and publish workflows' },
  // Requests
  'request.read.all': { group: 'Requests', description: 'View all requests in permitted branches' },
  'request.read.assigned': { group: 'Requests', description: 'View requests assigned to me' },
  'request.create': { group: 'Requests', description: 'Create service requests' },
  'request.update': { group: 'Requests', description: 'Edit request details and form data' },
  'request.assign': { group: 'Requests', description: 'Assign or reassign requests' },
  'request.process': { group: 'Requests', description: 'Prepare applications and update processing status' },
  'request.review': { group: 'Requests', description: 'Approve or send back prepared applications' },
  'request.submit_external': { group: 'Requests', description: 'Record submission to an authority or partner' },
  'request.cancel': { group: 'Requests', description: 'Cancel requests' },
  'request.reopen': { group: 'Requests', description: 'Reopen completed requests' },
  'request.comment.internal': { group: 'Requests', description: 'Read and write internal notes' },
  // Documents
  'document.read': { group: 'Documents', description: 'View and download documents' },
  'document.upload': { group: 'Documents', description: 'Upload documents' },
  'document.verify': { group: 'Documents', description: 'Verify or reject documents' },
  'document.delete': { group: 'Documents', description: 'Delete documents' },
  'document.share': { group: 'Documents', description: 'Create secure share links' },
  'ocr.run': { group: 'Documents', description: 'Run AI-assisted extraction' },
  'ocr.review': { group: 'Documents', description: 'Confirm or correct extracted data' },
  // Finance
  'quotation.read': { group: 'Finance', description: 'View quotations' },
  'quotation.manage': { group: 'Finance', description: 'Create and send quotations' },
  'discount.approve': { group: 'Finance', description: 'Approve discounts' },
  'invoice.read': { group: 'Finance', description: 'View invoices' },
  'invoice.manage': { group: 'Finance', description: 'Create, issue and void invoices' },
  'payment.read': { group: 'Finance', description: 'View payments' },
  'payment.record': { group: 'Finance', description: 'Record payments and print receipts' },
  'payment.reconcile': { group: 'Finance', description: 'Reconcile payments and settlements' },
  'refund.request': { group: 'Finance', description: 'Request refunds' },
  'refund.approve': { group: 'Finance', description: 'Approve and process refunds' },
  'creditnote.manage': { group: 'Finance', description: 'Issue credit notes' },
  'expense.manage': { group: 'Finance', description: 'Record expenses and fee remittances' },
  'cash.shift': { group: 'Finance', description: 'Open and close own cash register shift' },
  'cash.manage': { group: 'Finance', description: 'See every cash shift, review closings and run the day-end report' },
  'commission.view_own': { group: 'Finance', description: 'See own commission earnings' },
  'commission.manage': { group: 'Finance', description: 'Set commission rules, see everybody\'s commission and record payouts' },
  'payroll.manage': { group: 'Finance', description: 'Salaries and WPS details of staff, monthly payroll, payslips and the WPS file' },
  'payroll.view_own': { group: 'Finance', description: 'See own payslips' },
  'lead.read': { group: 'Customers', description: 'See leads (enquiries) and their follow-ups' },
  'lead.manage': { group: 'Customers', description: 'Add and work leads, convert them to customers and requests' },
  'inbox.read': { group: 'Customers', description: 'Read the WhatsApp team inbox' },
  'inbox.reply': { group: 'Customers', description: 'Reply to customers on WhatsApp, assign and close conversations' },
  'inbox.manage': { group: 'Customers', description: 'Manage quick replies and the WhatsApp inbox set-up' },
  'paperwork.read': { group: 'Documents', description: 'See ready-made documents (certificates, NOCs, contracts)' },
  'paperwork.manage': { group: 'Documents', description: 'Prepare, issue, sign at the counter, hand over and void ready-made documents' },
  'paperwork.templates': { group: 'Documents', description: 'Edit the wording of ready-made document templates' },
  'accounting.read': { group: 'Finance', description: 'See the chart of accounts, journals, P&L, balance sheet and VAT report' },
  'accounting.manage': { group: 'Finance', description: 'Add accounts, post and reverse manual journals, build the books from history' },
  'finance.settings': { group: 'Finance', description: 'Configure fee treatment, tax and payment methods' },
  // Reports
  'report.operational': { group: 'Reports', description: 'View operational reports' },
  'report.financial': { group: 'Reports', description: 'View financial reports' },
  'report.export': { group: 'Reports', description: 'Export and schedule reports' },
  // Operations
  'appointment.read': { group: 'Operations', description: 'View appointments' },
  'appointment.manage': { group: 'Operations', description: 'Book, reschedule and cancel appointments' },
  'queue.manage': { group: 'Operations', description: 'Issue and call queue tokens' },
  'task.read': { group: 'Operations', description: 'View tasks' },
  'task.manage': { group: 'Operations', description: 'Create, assign and complete tasks' },
  // Organisation
  'branch.read': { group: 'Organisation', description: 'View branches' },
  'branch.manage': { group: 'Organisation', description: 'Create and edit branches' },
  'staff.read': { group: 'Organisation', description: 'View staff and workload' },
  'staff.manage': { group: 'Organisation', description: 'Invite staff, assign branches and schedules' },
  'role.manage': { group: 'Organisation', description: 'Create roles and change permissions' },
  // Communication
  'notification.manage': { group: 'Communication', description: 'Edit notification templates and channels' },
  'reminder.read': { group: 'Communication', description: 'View expiry reminders' },
  'reminder.manage': { group: 'Communication', description: 'Create and edit expiry reminders' },
  'automation.manage': { group: 'Communication', description: 'Configure automations' },
  // Support
  'ticket.read': { group: 'Support', description: 'View support tickets' },
  'ticket.manage': { group: 'Support', description: 'Reply to, assign and resolve support tickets' },
  // Administration
  'branding.manage': { group: 'Administration', description: 'Change white-label branding' },
  'domain.manage': { group: 'Administration', description: 'Manage custom domains' },
  'settings.manage': { group: 'Administration', description: 'Change centre settings' },
  'subscription.manage': { group: 'Administration', description: 'Manage the TypEase subscription' },
  'integration.manage': { group: 'Administration', description: 'Configure integrations and credentials' },
  'audit.read': { group: 'Administration', description: 'View the audit trail' },
  'privacy.manage': { group: 'Administration', description: 'Handle privacy requests, retention and consent' },
  'support_access.decide': { group: 'Administration', description: 'Approve or deny TypEase support access' },
  // Customer self-service
  'self.profile': { group: 'Self-service', description: 'Manage my own profile' },
  'self.requests': { group: 'Self-service', description: 'Create and track my own requests' },
  'self.documents': { group: 'Self-service', description: 'Upload and download my own documents' },
  'self.payments': { group: 'Self-service', description: 'View and pay my own quotations and invoices' },
  'self.appointments': { group: 'Self-service', description: 'Book my own appointments' },
  'self.tickets': { group: 'Self-service', description: 'Contact support' },
  'self.privacy': { group: 'Self-service', description: 'Manage consent and privacy requests' },
  // Corporate portal
  'corp.account.read': { group: 'Corporate portal', description: 'View the company account' },
  'corp.account.manage': { group: 'Corporate portal', description: 'Manage company contacts' },
  'corp.employees.read': { group: 'Corporate portal', description: 'View authorised employee records' },
  'corp.employees.manage': { group: 'Corporate portal', description: 'Add and edit employee records' },
  'corp.requests.read': { group: 'Corporate portal', description: 'Track company requests' },
  'corp.requests.create': { group: 'Corporate portal', description: 'Create company requests' },
  'corp.requests.approve': { group: 'Corporate portal', description: 'Approve company requests and quotations' },
  'corp.invoices.read': { group: 'Corporate portal', description: 'View company invoices' },
});

export const PLATFORM_PERMISSIONS = P({
  'platform.tenants.read': { group: 'Platform', description: 'View tenants and subscription information' },
  'platform.tenants.manage': { group: 'Platform', description: 'Approve, suspend, reactivate and archive tenants' },
  'platform.plans.manage': { group: 'Platform', description: 'Manage plans, coupons and limits' },
  'platform.billing.manage': { group: 'Platform', description: 'Manage SaaS billing' },
  'platform.metrics.read': { group: 'Platform', description: 'View platform metrics' },
  'platform.features.manage': { group: 'Platform', description: 'Manage global feature flags and settings' },
  'platform.fees.manage': { group: 'Platform', description: 'Maintain the authority fee catalogue centres follow' },
  'platform.integrations.manage': { group: 'Platform', description: 'Manage approved platform integrations' },
  'platform.staff.manage': { group: 'Platform', description: 'Manage platform staff' },
  'platform.audit.read': { group: 'Platform', description: 'View platform audit and security events' },
  'platform.support.manage': { group: 'Platform', description: 'Handle platform support tickets' },
  'platform.access.request': { group: 'Platform', description: 'Request time-limited access to a tenant' },
});

export type TenantPermission = keyof typeof TENANT_PERMISSIONS;
export type PlatformPermission = keyof typeof PLATFORM_PERMISSIONS;
export type PermissionKey = TenantPermission | PlatformPermission;

export const ALL_PERMISSIONS: Record<PermissionKey, Def> = { ...TENANT_PERMISSIONS, ...PLATFORM_PERMISSIONS };

const tenantKeys = Object.keys(TENANT_PERMISSIONS) as TenantPermission[];
const staffKeys = tenantKeys.filter((k) => !k.startsWith('self.') && !k.startsWith('corp.'));
const without = (keys: TenantPermission[], excluded: TenantPermission[]) => keys.filter((k) => !excluded.includes(k));

export type RoleKind = 'STAFF' | 'CUSTOMER' | 'CORPORATE';
export interface SystemRole {
  key: string;
  name: string;
  nameAr: string;
  kind: RoleKind;
  description: string;
  permissions: TenantPermission[];
  /** Privileged roles must enrol in MFA. */
  requiresMfa: boolean;
}

export const SYSTEM_ROLES: Record<string, SystemRole> = {
  owner: {
    key: 'owner',
    name: 'Centre Owner',
    nameAr: 'مالك المركز',
    kind: 'STAFF',
    description: 'Full control of the typing centre.',
    permissions: staffKeys,
    requiresMfa: true,
  },
  manager: {
    key: 'manager',
    name: 'Centre Manager',
    nameAr: 'مدير المركز',
    kind: 'STAFF',
    description: 'Runs assigned branches: staff, cases, schedules and operational reports.',
    permissions: without(staffKeys, [
      'subscription.manage',
      'role.manage',
      'domain.manage',
      'branding.manage',
      'integration.manage',
      'finance.settings',
      'refund.approve',
      'payment.reconcile',
      'creditnote.manage',
      'accounting.manage',
      'payroll.manage',
      'privacy.manage',
      'support_access.decide',
      'settings.manage',
      'branch.manage',
    ]),
    requiresMfa: true,
  },
  receptionist: {
    key: 'receptionist',
    name: 'Receptionist',
    nameAr: 'موظف الاستقبال',
    kind: 'STAFF',
    description: 'Registers customers, starts requests, takes payments and books appointments.',
    permissions: [
      'customer.read', 'customer.create', 'customer.update', 'corporate.read', 'service.read',
      'request.read.all', 'request.create', 'request.update', 'request.comment.internal',
      'document.read', 'document.upload', 'quotation.read', 'quotation.manage', 'invoice.read',
      'payment.read', 'payment.record', 'cash.shift', 'commission.view_own', 'payroll.view_own', 'lead.read', 'lead.manage', 'paperwork.read', 'paperwork.manage', 'inbox.read', 'inbox.reply', 'appointment.read', 'appointment.manage', 'queue.manage',
      'task.read', 'ticket.read', 'reminder.read', 'branch.read',
    ],
    requiresMfa: false,
  },
  operator: {
    key: 'operator',
    name: 'Typing Operator',
    nameAr: 'موظف الطباعة',
    kind: 'STAFF',
    description: 'Prepares assigned applications and records submission references.',
    permissions: [
      'customer.read', 'service.read', 'request.read.assigned', 'request.update', 'request.process',
      'request.submit_external', 'request.comment.internal', 'document.read', 'document.upload',
      'document.verify', 'ocr.run', 'quotation.read', 'invoice.read', 'refund.request', 'appointment.read',
      'task.read', 'task.manage', 'branch.read', 'commission.view_own', 'payroll.view_own', 'paperwork.read', 'paperwork.manage',
    ],
    requiresMfa: false,
  },
  reviewer: {
    key: 'reviewer',
    name: 'Document Reviewer',
    nameAr: 'مدقق المستندات',
    kind: 'STAFF',
    description: 'Verifies documents and extracted data, approves or returns cases.',
    permissions: [
      'customer.read', 'service.read', 'request.read.all', 'request.review', 'request.comment.internal',
      'document.read', 'document.verify', 'ocr.run', 'ocr.review', 'task.read', 'task.manage', 'branch.read', 'commission.view_own', 'payroll.view_own',
    ],
    requiresMfa: false,
  },
  accountant: {
    key: 'accountant',
    name: 'Accountant',
    nameAr: 'المحاسب',
    kind: 'STAFF',
    description: 'Invoices, reconciliation, government-fee liabilities, expenses and financial reports.',
    permissions: [
      'customer.read', 'corporate.read', 'service.read', 'request.read.all', 'quotation.read', 'invoice.read',
      'invoice.manage', 'payment.read', 'payment.record', 'payment.reconcile', 'refund.request', 'refund.approve',
      'creditnote.manage', 'expense.manage', 'cash.shift', 'cash.manage', 'commission.view_own', 'commission.manage', 'accounting.read', 'accounting.manage', 'payroll.manage', 'payroll.view_own', 'lead.read', 'report.financial', 'report.operational', 'report.export', 'branch.read',
    ],
    requiresMfa: true,
  },
  customer: {
    key: 'customer',
    name: 'Customer',
    nameAr: 'العميل',
    kind: 'CUSTOMER',
    description: 'Self-service access to own profile, requests, documents and payments.',
    permissions: ['self.profile', 'self.requests', 'self.documents', 'self.payments', 'self.appointments', 'self.tickets', 'self.privacy'],
    requiresMfa: false,
  },
  corporate_admin: {
    key: 'corporate_admin',
    name: 'Corporate Administrator',
    nameAr: 'مسؤول الشركة',
    kind: 'CORPORATE',
    description: 'Manages the company account, employee records, requests and invoices.',
    permissions: [
      'corp.account.read', 'corp.account.manage', 'corp.employees.read', 'corp.employees.manage',
      'corp.requests.read', 'corp.requests.create', 'corp.requests.approve', 'corp.invoices.read', 'self.tickets',
    ],
    requiresMfa: false,
  },
  corporate_employee: {
    key: 'corporate_employee',
    name: 'Corporate Employee',
    nameAr: 'موظف الشركة',
    kind: 'CORPORATE',
    description: 'Sees only their own records and requests.',
    permissions: ['self.profile', 'self.requests', 'self.documents', 'self.tickets', 'self.privacy'],
    requiresMfa: false,
  },
};

/** The permissions a role of each kind can be given when a centre or a company edits its roles. */
export const ROLE_CATALOGUE: Record<RoleKind, TenantPermission[]> = {
  STAFF: staffKeys,
  CUSTOMER: SYSTEM_ROLES.customer!.permissions,
  CORPORATE: [...new Set([...SYSTEM_ROLES.corporate_admin!.permissions, ...SYSTEM_ROLES.corporate_employee!.permissions])],
};

/**
 * The top role of a centre (owner) and of a company (corporate_admin). Only its holders manage roles, so it
 * always keeps its whole catalogue and cannot be deleted: nobody can lock themselves out of role management.
 */
export const TOP_ROLE_KEYS = ['owner', 'corporate_admin'] as const;

export type PlatformRoleKey = 'SUPER_ADMIN' | 'SUPPORT_AGENT';

/** Neither platform role includes any tenant permission: tenant data needs an AccessGrant. */
export const PLATFORM_ROLES: Record<PlatformRoleKey, { name: string; permissions: PlatformPermission[] }> = {
  SUPER_ADMIN: { name: 'Platform Super Admin', permissions: Object.keys(PLATFORM_PERMISSIONS) as PlatformPermission[] },
  SUPPORT_AGENT: {
    name: 'Platform Support Agent',
    permissions: ['platform.tenants.read', 'platform.support.manage', 'platform.access.request'],
  },
};

/**
 * Tenant permissions a support AccessGrant may unlock. Anything else (finance
 * changes, role management, deletions ...) can never be delegated to support.
 */
export const SUPPORT_GRANTABLE: TenantPermission[] = [
  'customer.read', 'service.read', 'request.read.all', 'request.comment.internal', 'quotation.read', 'invoice.read',
  'payment.read', 'branch.read', 'staff.read', 'appointment.read', 'task.read', 'ticket.read', 'reminder.read',
  'report.operational', 'audit.read', 'document.read',
];

/** Pairs where the same person may not both request and approve. */
export const SEGREGATED_DUTIES: Array<{ request: TenantPermission; approve: TenantPermission }> = [
  { request: 'refund.request', approve: 'refund.approve' },
  { request: 'quotation.manage', approve: 'discount.approve' },
];

export function hasPermission(granted: Iterable<string>, required: string): boolean {
  for (const g of granted) if (g === required) return true;
  return false;
}
export function hasAny(granted: Iterable<string>, required: string[]): boolean {
  const set = granted instanceof Set ? granted : new Set(granted);
  return required.some((r) => set.has(r));
}
export function hasAll(granted: Iterable<string>, required: string[]): boolean {
  const set = granted instanceof Set ? granted : new Set(granted);
  return required.every((r) => set.has(r));
}
export const isPrivilegedRole = (roleKey: string) => SYSTEM_ROLES[roleKey]?.requiresMfa ?? false;

/**
 * Permissions added to the built-in roles after centres already exist. Centres may edit those roles,
 * so a later sync must not re-add what they removed: each rollout is applied once per centre at
 * startup (ProvisioningService.bootstrapPlatform) and remembered. New centres get SYSTEM_ROLES as is.
 */
export const PERMISSION_ROLLOUTS: Array<{ id: string; grants: Partial<Record<string, string[]>> }> = [
  {
    id: '2026-10-commissions',
    grants: {
      owner: ['commission.view_own', 'commission.manage'],
      manager: ['commission.view_own', 'commission.manage'],
      accountant: ['commission.view_own', 'commission.manage'],
      receptionist: ['commission.view_own'],
      operator: ['commission.view_own'],
      reviewer: ['commission.view_own'],
    },
  },
  { id: '2026-10-cashier-shifts', grants: { owner: ['cash.shift', 'cash.manage'], manager: ['cash.shift', 'cash.manage'], receptionist: ['cash.shift'], accountant: ['cash.shift', 'cash.manage'] } },
  { id: '2026-10-payroll', grants: { owner: ['payroll.manage', 'payroll.view_own'], manager: ['payroll.view_own'], accountant: ['payroll.manage', 'payroll.view_own'], receptionist: ['payroll.view_own'], operator: ['payroll.view_own'], reviewer: ['payroll.view_own'] } },
  { id: '2026-10-leads', grants: { owner: ['lead.read', 'lead.manage'], manager: ['lead.read', 'lead.manage'], receptionist: ['lead.read', 'lead.manage'], accountant: ['lead.read'] } },
  { id: '2026-10-whatsapp-inbox', grants: { owner: ['inbox.read', 'inbox.reply', 'inbox.manage'], manager: ['inbox.read', 'inbox.reply', 'inbox.manage'], receptionist: ['inbox.read', 'inbox.reply'] } },
  { id: '2026-10-paperwork', grants: { owner: ['paperwork.read', 'paperwork.manage', 'paperwork.templates'], manager: ['paperwork.read', 'paperwork.manage', 'paperwork.templates'], receptionist: ['paperwork.read', 'paperwork.manage'], operator: ['paperwork.read', 'paperwork.manage'] } },
  { id: '2026-10-accounting', grants: { owner: ['accounting.read', 'accounting.manage'], manager: ['accounting.read'], accountant: ['accounting.read', 'accounting.manage'] } },
];
