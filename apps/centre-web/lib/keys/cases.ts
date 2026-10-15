/**
 * TanStack Query keys of the "cases" section (request wizard, case page, tasks).
 * Every key starts with the resource name, so the usual prefix invalidation works:
 * `invalidateQueries({ queryKey: ['requests'] })` refreshes lists, counts AND open case pages.
 */
export const caseKeys = {
  /** One case (GET /requests/:id). Under 'requests' on purpose. */
  detail: (id: string) => ['requests', 'detail', id] as const,
  /** Requests offered as "the original" when marking a duplicate. */
  duplicateSearch: (customerId: string) => ['requests', 'duplicate-candidates', customerId] as const,

  quotations: (requestId: string) => ['quotations', 'by-request', requestId] as const,
  invoices: (requestId: string) => ['invoices', 'by-request', requestId] as const,

  documents: ['documents'] as const,
  checklistAssist: (requestId: string) => ['documents', 'checklist-assist', requestId] as const,
  requestDocuments: (requestId: string) => ['documents', 'by-request', requestId] as const,
  document: (id: string) => ['documents', 'detail', id] as const,

  ocr: ['ocr'] as const,
  ocrUsage: ['ocr', 'usage'] as const,
  ocrRuns: (documentId: string) => ['ocr', 'runs', documentId] as const,
  ocrResult: (id: string) => ['ocr', 'result', id] as const,

  customer: (id: string) => ['customers', 'detail', id] as const,
  corporateAccount: (id: string) => ['corporate-accounts', 'detail', id] as const,

  serviceCatalogue: ['services', 'wizard'] as const,
  serviceFull: (id: string, branchId?: string, corporateAccountId?: string) => ['services', 'full', id, branchId ?? 'default', corporateAccountId ?? 'none'] as const,

  centre: ['tenant', 'settings'] as const,
  workflowDefinition: (id: string) => ['workflows', 'definition', id] as const,

  tasks: ['tasks'] as const,
  task: (id: string) => ['tasks', 'detail', id] as const,
  taskCounts: ['tasks', 'counts'] as const,
};
