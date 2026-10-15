/**
 * TanStack Query keys of this app, in one place. A key starts with the resource
 * name, so `invalidateQueries({ queryKey: keys.customers.all })` after a mutation
 * refreshes every list and detail of that resource.
 */
export const keys = {
  requests: {
    all: ['requests'] as const,
    counts: (branchId?: string) => ['requests', 'counts', branchId ?? 'all'] as const,
    recent: ['requests', 'recent'] as const,
  },
  customers: { all: ['customers'] as const },
  branches: { all: ['branches'] as const },
  tenantConfig: (slug: string) => ['tenant-config', slug] as const,
  /**
   * The bell in the top bar. It starts with 'my-notifications' like the inbox's own queries, so
   * invalidating the inbox (`['my-notifications']`) refreshes the bell as well.
   */
  unreadNotifications: ['my-notifications', 'unread-count'] as const,
  /** GET /onboarding: the same key the onboarding wizard uses, so both read one answer. */
  onboarding: ['onboarding'] as const,
};
