/**
 * TanStack Query keys of the "ops" section (catalogue, workflows, appointments, queue,
 * reminders, support, notifications, automations). A key starts with the resource name,
 * so invalidating the prefix refreshes every list and detail of that resource.
 */
export const opsKeys = {
  categories: { all: ['service-categories'] as const, list: (includeInactive: boolean) => ['service-categories', { includeInactive }] as const },
  /** Same prefix as the shared DocumentTypePicker, so both refresh together. */
  documentTypes: { all: ['document-types'] as const, manage: ['document-types', 'manage'] as const },
  services: {
    /** Same prefix as the shared ServicePicker. */
    all: ['services'] as const,
    catalogue: (filters: object) => ['services', 'catalogue', filters] as const,
    detail: (id: string) => ['services', 'detail', id] as const,
    price: (id: string, branchId?: string) => ['services', 'detail', id, 'price', branchId ?? 'default'] as const,
    prices: (id: string) => ['services', 'detail', id, 'prices'] as const,
    forms: (id: string) => ['services', 'detail', id, 'forms'] as const,
    form: (id: string, formId: string) => ['services', 'detail', id, 'forms', formId] as const,
  },
  workflows: {
    all: ['workflows'] as const,
    list: (includeArchived: boolean) => ['workflows', 'list', { includeArchived }] as const,
    templates: ['workflows', 'templates'] as const,
    meta: ['workflows', 'builder-meta'] as const,
    detail: (id: string) => ['workflows', 'detail', id] as const,
    versions: (id: string) => ['workflows', 'detail', id, 'versions'] as const,
  },
  appointments: {
    all: ['appointments'] as const,
    agenda: (params: object) => ['appointments', 'agenda', params] as const,
    availability: (params: object) => ['appointments', 'availability', params] as const,
    slotConfigs: (branchId: string) => ['appointments', 'slot-configs', branchId] as const,
    closures: (branchId: string) => ['appointments', 'closures', branchId] as const,
    settings: ['appointments', 'settings'] as const,
  },
  queue: {
    all: ['queue'] as const,
    tokens: (branchId: string) => ['queue', 'tokens', branchId] as const,
    counters: (branchId: string) => ['queue', 'counters', branchId] as const,
    stats: (params: object) => ['queue', 'stats', params] as const,
    display: (token: string) => ['queue-display', token] as const,
  },
  reminders: {
    all: ['reminders'] as const,
    detail: (id: string) => ['reminders', 'detail', id] as const,
    upcoming: (days: number, scope: object) => ['reminders', 'upcoming', days, scope] as const,
  },
  tickets: {
    all: ['support-tickets'] as const,
    detail: (id: string) => ['support-tickets', 'detail', id] as const,
    sla: ['support-tickets', 'sla'] as const,
    settings: ['support-tickets', 'settings'] as const,
  },
  feedback: { all: ['support-feedback'] as const, summary: ['support-feedback', 'summary'] as const },
  platformTickets: { all: ['platform-tickets'] as const, detail: (id: string) => ['platform-tickets', 'detail', id] as const },
  inbox: { all: ['my-notifications'] as const, list: (unreadOnly: boolean) => ['my-notifications', 'list', { unreadOnly }] as const },
  notifications: {
    all: ['notification-admin'] as const,
    channels: ['notification-admin', 'channels'] as const,
    settings: ['notification-admin', 'settings'] as const,
    events: ['notification-admin', 'events'] as const,
    templates: (eventKey: string) => ['notification-admin', 'templates', eventKey] as const,
    log: ['notification-admin', 'log'] as const,
    failures: ['notification-admin', 'failures'] as const,
    detail: (id: string) => ['notification-admin', 'detail', id] as const,
  },
  automations: {
    all: ['automations'] as const,
    meta: ['automations', 'meta'] as const,
    templates: ['automations', 'templates'] as const,
    summary: ['automations', 'summary'] as const,
    detail: (id: string) => ['automations', 'detail', id] as const,
    executions: ['automations', 'executions'] as const,
    execution: (id: string) => ['automations', 'executions', 'detail', id] as const,
  },
};
