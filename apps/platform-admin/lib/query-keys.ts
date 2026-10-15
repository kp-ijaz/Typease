/** TanStack Query keys of this app. A key starts with the resource name (see FRONTEND_CONVENTIONS.md). */
export const keys = {
  plans: { all: ['plans'] as const, admin: ['plans', 'admin'] as const },
  coupons: { all: ['coupons'] as const },
  dashboard: {
    all: ['dashboard'] as const,
    summary: ['dashboard', 'summary'] as const,
    growth: ['dashboard', 'growth'] as const,
    revenue: ['dashboard', 'revenue'] as const,
    distribution: ['dashboard', 'distribution'] as const,
    usage: ['dashboard', 'usage'] as const,
    trials: ['dashboard', 'trials'] as const,
    failedPayments: ['dashboard', 'failed-payments'] as const,
  },
  tenants: {
    all: ['tenants'] as const,
    detail: (id: string) => ['tenants', 'detail', id] as const,
    flags: (id: string) => ['tenants', 'flags', id] as const,
    search: (q: string) => ['tenants', 'search', q] as const,
  },
  billing: {
    all: ['billing'] as const,
    history: (tenantId: string) => ['billing', 'history', tenantId] as const,
    failed: ['billing', 'failed'] as const,
  },
  tickets: {
    all: ['tickets'] as const,
    detail: (id: string) => ['tickets', 'detail', id] as const,
    open: ['tickets', 'open-count'] as const,
  },
  access: {
    all: ['access'] as const,
    detail: (id: string) => ['access', 'detail', id] as const,
    forTenant: (id: string, everyone: boolean) => ['access', 'tenant', id, everyone] as const,
  },
  flags: {
    all: ['flags'] as const,
    overrides: (flag: string) => ['flags', 'overrides', flag] as const,
  },
  settings: { all: ['settings'] as const },
  staff: { all: ['staff'] as const },
  audit: {
    all: ['audit'] as const,
    detail: (id: string) => ['audit', 'detail', id] as const,
  },
  security: { all: ['security'] as const, summary: ['security', 'summary'] as const },
  incidents: { all: ['incidents'] as const },
  processors: { all: ['processors'] as const },
  integrations: {
    all: ['integrations'] as const,
    authorisations: ['integrations', 'authorisations'] as const,
    providers: ['integrations', 'providers'] as const,
  },
  health: { all: ['health'] as const, providers: ['health', 'providers'] as const },
};
