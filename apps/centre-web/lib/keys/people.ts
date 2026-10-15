/**
 * TanStack Query keys of the "people" section (customer detail, corporate clients, document vault).
 * Customer keys start with ['customers'] and document keys with ['documents'], the same prefixes the
 * rest of the app uses, so that invalidating a resource refreshes every list and detail of it.
 */
export const peopleKeys = {
  customers: {
    all: ['customers'] as const,
    detail: (id: string) => ['customers', 'detail', id] as const,
    name: (id: string) => ['customers', 'name', id] as const,
    notes: (id: string) => ['customers', 'detail', id, 'notes'] as const,
    consents: (id: string) => ['customers', 'detail', id, 'consents'] as const,
    duplicates: (id: string) => ['customers', 'detail', id, 'duplicates'] as const,
    activity: (id: string) => ['customers', 'detail', id, 'activity'] as const,
    /** Read-only lists of other modules shown in the tabs of one customer. */
    tab: (id: string, tab: string) => ['customers', 'detail', id, 'tab', tab] as const,
    tags: ['customer-tags'] as const,
  },
  corporate: {
    all: ['corporate-accounts'] as const,
    detail: (id: string) => ['corporate-accounts', 'detail', id] as const,
    members: (id: string) => ['corporate-accounts', 'detail', id, 'members'] as const,
    employees: (id: string) => ['corporate-accounts', 'detail', id, 'employees'] as const,
    employee: (id: string, employeeId: string) => ['corporate-accounts', 'detail', id, 'employee', employeeId] as const,
    agreements: (id: string) => ['corporate-accounts', 'detail', id, 'agreements'] as const,
    prices: (id: string) => ['corporate-accounts', 'detail', id, 'prices'] as const,
    statement: (id: string) => ['corporate-accounts', 'detail', id, 'statement'] as const,
    tab: (id: string, tab: string) => ['corporate-accounts', 'detail', id, 'tab', tab] as const,
  },
  documents: {
    all: ['documents'] as const,
    detail: (id: string) => ['documents', 'detail', id] as const,
    shares: (id: string) => ['documents', 'detail', id, 'shares'] as const,
    accessLogs: (id: string) => ['documents', 'detail', id, 'access-logs'] as const,
    extractions: (id: string) => ['documents', 'detail', id, 'extractions'] as const,
    extraction: (resultId: string) => ['ocr-results', resultId] as const,
  },
  plan: ['tenant', 'usage'] as const,
  tenant: ['tenant', 'profile'] as const,
  ocrUsage: ['ocr', 'usage'] as const,
};
