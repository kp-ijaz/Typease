import type { PublicTenantConfig } from '@typease/types';
import type { tenantSignupSchema, z } from '@typease/validation';
import type { ApiClient } from '../client';
import type { PublicCatalogue, PublicPlan, PublicService, PublicTrackingResult, TenantSignupResult } from '../types';

const open = { auth: false } as const;

/** Endpoints that need no sign-in: white-label presentation, catalogue, tracking, plans, centre sign-up. */
export const publicApi = (c: ApiClient) => ({
  /** By slug, by host, or (neither given) by the X-Tenant-Host header the client sends. */
  tenantConfig: (by: { slug?: string; host?: string; branchId?: string } = {}) => c.get<PublicTenantConfig>('/public/tenant-config', { query: by, ...open }),
  services: (q: { slug?: string; categoryKey?: string; q?: string } = {}) => c.get<PublicCatalogue>('/public/services', { query: q, ...open }),
  service: (id: string, slug?: string) => c.get<{ centre: PublicCatalogue['centre']; service: PublicService }>(`/public/services/${id}`, { query: { slug }, ...open }),
  track: (body: { tenantSlug?: string; requestNo: string; trackingCode: string }) => c.post<PublicTrackingResult>('/public/track', body, open),
  plans: () => c.get<PublicPlan[]>('/public/plans', open),
  slugAvailable: (slug: string) => c.get<{ slug: string; available: boolean }>('/public/slug-available', { query: { slug }, ...open }),
  signup: (body: z.input<typeof tenantSignupSchema>) => c.post<TenantSignupResult>('/public/signup', body, open),
});
