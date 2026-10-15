/**
 * TanStack Query keys of the corporate portal. Every key starts with the resource name, so
 * `invalidateQueries({ queryKey: keys.requests.all })` refreshes every list, count and detail of it.
 */
export const keys = {
  account: ['corporate-account'] as const,
  members: ['corporate-members'] as const,
  prices: ['corporate-prices'] as const,
  roles: ['corporate-roles'] as const,
  rolePermissions: ['corporate-roles', 'permissions'] as const,
  users: ['corporate-users'] as const,
  employees: {
    all: ['employees'] as const,
    detail: (id: string) => ['employees', 'detail', id] as const,
  },
  requests: {
    all: ['requests'] as const,
    counts: ['requests', 'counts'] as const,
    recent: ['requests', 'recent'] as const,
    detail: (id: string) => ['requests', 'detail', id] as const,
    assist: (id: string) => ['requests', 'assist', id] as const,
    of: (customerId: string) => ['requests', 'of', customerId] as const,
  },
  catalogue: {
    all: ['catalogue'] as const,
    service: (id: string) => ['catalogue', 'service', id] as const,
  },
  branches: ['branches', 'directory'] as const,
  documentTypes: ['document-types'] as const,
  documents: {
    all: ['documents'] as const,
    of: (customerId: string) => ['documents', 'of', customerId] as const,
  },
  reminders: Object.assign(['reminders'] as const, { of: (customerId: string) => ['reminders', customerId] as const }),
  quotations: {
    all: ['quotations'] as const,
    detail: (id: string) => ['quotations', 'detail', id] as const,
    open: ['quotations', 'open'] as const,
  },
  invoices: {
    all: ['invoices'] as const,
    detail: (id: string) => ['invoices', 'detail', id] as const,
    statement: ['invoices', 'statement'] as const,
  },
  payments: {
    all: ['payments'] as const,
    detail: (id: string) => ['payments', 'detail', id] as const,
  },
  notifications: {
    all: ['notifications'] as const,
    unread: ['notifications', 'unread'] as const,
    preferences: ['notifications', 'preferences'] as const,
  },
  tickets: {
    all: ['tickets'] as const,
    detail: (id: string) => ['tickets', 'detail', id] as const,
  },
  feedback: ['feedback'] as const,
};
