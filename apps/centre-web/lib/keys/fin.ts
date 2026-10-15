/**
 * TanStack Query keys of the "fin" section (money, reports, subscription, audit).
 * A key starts with the resource name, so `invalidateQueries({ queryKey: finKeys.invoices.all })`
 * refreshes every list and detail of that resource. A payment touches invoices, quotations'
 * invoices, liabilities and the dashboard: use `finKeys.moneyChanged` for those.
 */
export const finKeys = {
  quotations: {
    all: ['quotations'] as const,
    detail: (id: string) => ['quotations', 'detail', id] as const,
  },
  invoices: {
    all: ['invoices'] as const,
    detail: (id: string) => ['invoices', 'detail', id] as const,
    open: (customerId: string) => ['invoices', 'open', customerId] as const,
    refunds: (id: string) => ['invoices', 'detail', id, 'refunds'] as const,
  },
  payments: {
    all: ['payments'] as const,
    detail: (id: string) => ['payments', 'detail', id] as const,
  },
  refunds: {
    all: ['refunds'] as const,
    detail: (id: string) => ['refunds', 'detail', id] as const,
  },
  creditNotes: {
    all: ['credit-notes'] as const,
    ofInvoice: (invoiceId: string) => ['credit-notes', 'invoice', invoiceId] as const,
  },
  expenses: { all: ['expenses'] as const },
  liabilities: {
    all: ['liabilities'] as const,
    summary: (branchId?: string) => ['liabilities', 'summary', branchId ?? 'all'] as const,
    ofRequest: (requestId: string) => ['liabilities', 'request', requestId] as const,
  },
  reconciliations: {
    all: ['reconciliations'] as const,
    detail: (id: string) => ['reconciliations', 'detail', id] as const,
  },
  feeComponents: ['fee-components'] as const,
  tenant: ['tenant', 'profile'] as const,
  gateway: ['integrations', 'payment-gateway'] as const,
  corporateStatement: (id: string) => ['corporate-accounts', 'statement', id] as const,
  requestBrief: (id: string) => ['requests', 'brief', id] as const,
  customerBrief: (id: string) => ['customers', 'brief', id] as const,
  dashboard: {
    all: ['dashboard'] as const,
    summary: (params: object) => ['dashboard', 'summary', params] as const,
    trends: (params: object) => ['dashboard', 'trends', params] as const,
  },
  reports: {
    all: ['reports'] as const,
    catalogue: ['reports', 'catalogue'] as const,
    run: (key: string, params: object) => ['reports', 'run', key, params] as const,
    drilldown: (key: string, params: object) => ['reports', 'drilldown', key, params] as const,
    scheduled: ['reports', 'scheduled'] as const,
    schedule: (id: string) => ['reports', 'scheduled', 'detail', id] as const,
    runs: (id: string, page: number) => ['reports', 'scheduled', 'detail', id, 'runs', page] as const,
  },
  subscription: {
    all: ['subscription'] as const,
    current: ['subscription', 'current'] as const,
    invoices: ['subscription', 'invoices'] as const,
    plans: ['public-plans'] as const,
  },
  audit: {
    all: ['audit-logs'] as const,
    detail: (id: string) => ['audit-logs', 'detail', id] as const,
  },
};

/** Resources whose figures change when money moves (payment, refund, credit note, invoice issued / voided). */
export const MONEY_RESOURCES = [finKeys.invoices.all, finKeys.payments.all, finKeys.refunds.all, finKeys.creditNotes.all, finKeys.quotations.all, finKeys.liabilities.all, finKeys.dashboard.all, finKeys.reports.all, ['requests'] as const] as const;
