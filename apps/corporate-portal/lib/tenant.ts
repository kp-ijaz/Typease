import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { LOCALE_COOKIE, NONCE_HEADER, TENANT_COOKIE, TENANT_SLUG_HEADER, resolveLocale, resolveTenant, type Locale, type ResolvedTenant } from '@typease/ui/server';
import { API_INTERNAL_URL, API_URL, DEFAULT_TENANT_SLUG, SHARED_HOSTS } from './config';

export interface PortalRequest extends ResolvedTenant {
  locale: Locale;
  nonce: string | undefined;
  /**
   * What the browser uses as API base URL. On a centre's own domain the API is
   * reached through this app's origin ("" = same-origin `/api/v1` proxy) so the
   * refresh cookie is first-party; on the shared portal the API is called directly.
   */
  apiBaseUrl: string;
}

/**
 * Everything the server needs to know about this request, resolved once per
 * request (React `cache`): which centre, which language, the CSP nonce.
 */
export const getPortalRequest = cache(async (): Promise<PortalRequest> => {
  const [h, c] = await Promise.all([headers(), cookies()]);
  const host = h.get('x-forwarded-host') ?? h.get('host');
  const tenant = await resolveTenant({
    apiUrl: API_INTERNAL_URL,
    host,
    requestedSlug: h.get(TENANT_SLUG_HEADER),
    cookieSlug: c.get(TENANT_COOKIE)?.value,
    defaultSlug: DEFAULT_TENANT_SLUG,
    sharedHosts: SHARED_HOSTS,
  });
  const locale = resolveLocale({ cookie: c.get(LOCALE_COOKIE)?.value, tenantDefault: tenant.config?.defaultLanguage, acceptLanguage: h.get('accept-language') });
  return { ...tenant, locale, nonce: h.get(NONCE_HEADER) ?? undefined, apiBaseUrl: tenant.via === 'host' ? '' : API_URL };
});
