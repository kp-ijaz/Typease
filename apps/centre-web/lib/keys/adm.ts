/**
 * TanStack Query keys of the "adm" section (organisation, white label, integrations, privacy, settings,
 * onboarding). Keys start with the resource name, so `invalidateQueries({ queryKey: admKeys.staff.all })`
 * also refreshes the staff picker (`['staff', 'picker']`) and `admKeys.branches.all` the branch switcher.
 */
export const admKeys = {
  staff: {
    all: ['staff'] as const,
    list: (filters: Record<string, string | undefined>) => ['staff', 'list', filters] as const,
    full: ['staff', 'list', 'everyone'] as const,
    one: (id: string) => ['staff', 'one', id] as const,
    workload: (branchId?: string) => ['staff', 'workload', branchId ?? 'all'] as const,
    schedule: (id: string) => ['staff', 'schedule', id] as const,
  },
  roles: {
    all: ['roles'] as const,
    admin: ['roles', 'admin'] as const,
    permissions: ['roles', 'permissions'] as const,
  },
  branches: {
    all: ['branches'] as const,
    admin: ['branches', 'admin'] as const,
  },
  tenant: {
    all: ['tenant'] as const,
    detail: ['tenant', 'detail'] as const,
    usage: ['tenant', 'usage'] as const,
  },
  branding: { all: ['branding'] as const },
  domains: { all: ['domains'] as const },
  integrations: {
    all: ['integrations'] as const,
    catalogue: ['integrations', 'catalogue'] as const,
    list: ['integrations', 'list'] as const,
    logs: ['integrations', 'logs'] as const,
  },
  privacy: {
    all: ['privacy'] as const,
    overview: ['privacy', 'overview'] as const,
    requests: ['privacy', 'requests'] as const,
    request: (id: string) => ['privacy', 'requests', 'detail', id] as const,
    retention: ['privacy', 'retention'] as const,
    consents: ['privacy', 'consents'] as const,
    incidents: ['privacy', 'incidents'] as const,
    processors: ['privacy', 'processors'] as const,
  },
  supportAccess: { all: ['support-access'] as const },
  onboarding: { all: ['onboarding'] as const },
  plans: ['public-plans'] as const,
  subscription: { all: ['subscription'] as const },
};
