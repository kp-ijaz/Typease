import type { PublicTenantConfig } from '@typease/types';

/**
 * Which centre is a portal request for? Shared by the customer and corporate
 * portals (middleware + root layout). Server-safe, no React.
 *
 * Order:
 *   1. the host: a verified custom domain or <slug>.<platform base domain>
 *      (asked from the API: GET /public/tenant-config?host=)
 *   2. `?tenant=<slug>` in the URL, remembered in a cookie (shared portal)
 *   3. NEXT_PUBLIC_DEFAULT_TENANT_SLUG (single-centre deployments, local development)
 *   4. nothing: the app shows its "centre not found" page.
 * This only selects branding and the public catalogue. It is never authorisation.
 */

export const TENANT_COOKIE = 'te_tenant';
export const TENANT_QUERY = 'tenant';
/** Set by the middleware so the root layout sees a `?tenant=` slug on the very request that carries it. */
export const TENANT_SLUG_HEADER = 'x-te-tenant-slug';
export const NONCE_HEADER = 'x-nonce';

const SLUG = /^[a-z0-9]([a-z0-9-]{1,48}[a-z0-9])$/;
export const isTenantSlug = (value: unknown): value is string => typeof value === 'string' && SLUG.test(value);

/** Hosts that are never a tenant domain (the shared portal itself). */
export function isSharedHost(host: string | null | undefined, extra: readonly string[] = []): boolean {
  const name = (host ?? '').toLowerCase().split(':')[0];
  return !name || name === 'localhost' || name === '127.0.0.1' || name === '[::1]' || extra.map((h) => h.toLowerCase().split(':')[0]).includes(name);
}

interface CacheEntry {
  at: number;
  config: PublicTenantConfig | null;
}
const cache = new Map<string, CacheEntry>();
const FOUND_TTL = 60_000;
const MISSING_TTL = 15_000;

async function fetchConfig(apiUrl: string, by: { host?: string; slug?: string }, doFetch: typeof fetch): Promise<PublicTenantConfig | null> {
  const key = `${apiUrl}|${by.host ? `h:${by.host}` : `s:${by.slug}`}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.config ? FOUND_TTL : MISSING_TTL)) return hit.config;
  const qs = by.host ? `host=${encodeURIComponent(by.host)}` : `slug=${encodeURIComponent(by.slug as string)}`;
  let config: PublicTenantConfig | null = null;
  try {
    const res = await doFetch(`${apiUrl.replace(/\/+$/, '').replace(/\/api\/v1$/, '')}/api/v1/public/tenant-config?${qs}`, {
      headers: { accept: 'application/json', 'x-client-app': 'customer' },
      cache: 'no-store',
    });
    if (res.ok) config = (await res.json()) as PublicTenantConfig;
    else if (res.status !== 404) return hit?.config ?? null; // API trouble: keep what we knew, do not cache the failure
  } catch {
    return hit?.config ?? null;
  }
  cache.set(key, { at: Date.now(), config });
  if (cache.size > 2000) cache.clear();
  return config;
}

export interface ResolveTenantInput {
  /** Server-side API URL (may differ from the public one inside a cluster). */
  apiUrl: string;
  host?: string | null;
  /** `?tenant=` of this request (already validated by the middleware) or the header it set. */
  requestedSlug?: string | null;
  cookieSlug?: string | null;
  defaultSlug?: string | null;
  sharedHosts?: readonly string[];
  fetch?: typeof fetch;
}
export interface ResolvedTenant {
  config: PublicTenantConfig | null;
  /** How the centre was found. "host" means a tenant domain: links never need `?tenant=`. */
  via: 'host' | 'query' | 'cookie' | 'default' | 'none';
}

export async function resolveTenant(input: ResolveTenantInput): Promise<ResolvedTenant> {
  const doFetch = input.fetch ?? fetch;
  if (input.host && !isSharedHost(input.host, input.sharedHosts)) {
    const config = await fetchConfig(input.apiUrl, { host: input.host.toLowerCase() }, doFetch);
    if (config) return { config, via: 'host' };
  }
  const candidates: Array<[ResolvedTenant['via'], string | null | undefined]> = [
    ['query', input.requestedSlug],
    ['cookie', input.cookieSlug],
    ['default', input.defaultSlug],
  ];
  for (const [via, slug] of candidates) {
    if (!isTenantSlug(slug)) continue;
    const config = await fetchConfig(input.apiUrl, { slug }, doFetch);
    if (config) return { config, via };
  }
  return { config: null, via: 'none' };
}

/** For tests. */
export const clearTenantCache = () => cache.clear();
