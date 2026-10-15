/**
 * TanStack Query keys of the customer portal. Every key starts with the resource
 * name, so `invalidateQueries({ queryKey: keys.requests.all })` refreshes every
 * list, count and detail of that resource.
 */
export const keys = {
  requests: {
    all: ['requests'] as const,
    detail: (id: string) => ['requests', 'detail', id] as const,
    comments: (id: string) => ['requests', 'comments', id] as const,
    assist: (id: string) => ['requests', 'assist', id] as const,
    recent: ['requests', 'recent'] as const,
  },
  catalogue: {
    all: ['catalogue'] as const,
    service: (id: string) => ['catalogue', 'service', id] as const,
  },
  branches: ['branches', 'directory'] as const,
  documentTypes: ['document-types'] as const,
  documents: { all: ['documents'] as const },
  reminders: ['reminders'] as const,
  quotations: {
    all: ['quotations'] as const,
    detail: (id: string) => ['quotations', 'detail', id] as const,
    open: ['quotations', 'open'] as const,
  },
  invoices: {
    all: ['invoices'] as const,
    detail: (id: string) => ['invoices', 'detail', id] as const,
    unpaid: ['invoices', 'unpaid'] as const,
  },
  payments: {
    all: ['payments'] as const,
    detail: (id: string) => ['payments', 'detail', id] as const,
  },
  appointments: {
    all: ['appointments'] as const,
    availability: (branchId: string, date: string, serviceId: string) => ['appointments', 'availability', branchId, date, serviceId] as const,
  },
  notifications: {
    all: ['notifications'] as const,
    unread: ['notifications', 'unread'] as const,
    preferences: ['notifications', 'preferences'] as const,
  },
  tickets: {
    all: ['tickets'] as const,
    detail: (id: string) => ['tickets', 'detail', id] as const,
    open: ['tickets', 'open'] as const,
  },
  feedback: ['feedback'] as const,
  profile: {
    me: ['profile', 'me'] as const,
    consents: ['profile', 'consents'] as const,
    privacy: ['profile', 'privacy'] as const,
  },
};
