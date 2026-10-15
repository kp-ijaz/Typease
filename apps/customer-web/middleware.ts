import { NextResponse, type NextRequest } from 'next/server';
import { contentSecurityPolicy, newNonce } from '@typease/config/security.mjs';
import { NONCE_HEADER, TENANT_COOKIE, TENANT_QUERY, TENANT_SLUG_HEADER, isTenantSlug } from '@typease/ui/server';
import { API_URL, IS_DEV, STORAGE_ORIGINS } from '@/lib/config';

/**
 * 1. Content-Security-Policy with a fresh script nonce for every document.
 * 2. `?tenant=<slug>` (links in emails, the shared portal): remembered in a
 *    cookie and handed to the root layout in a request header, so the very
 *    first response is already rendered for that centre.
 */
export function middleware(request: NextRequest) {
  const nonce = newNonce();
  const csp = contentSecurityPolicy({ nonce, apiUrl: API_URL, storageOrigins: STORAGE_ORIGINS, isDev: IS_DEV });
  const headers = new Headers(request.headers);
  headers.set(NONCE_HEADER, nonce);
  headers.set('content-security-policy', csp);
  // Never trust a client-sent copy of the internal header.
  headers.delete(TENANT_SLUG_HEADER);

  const requested = request.nextUrl.searchParams.get(TENANT_QUERY);
  const slug = isTenantSlug(requested) ? requested : null;
  if (slug) headers.set(TENANT_SLUG_HEADER, slug);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set('content-security-policy', csp);
  if (slug && request.cookies.get(TENANT_COOKIE)?.value !== slug) {
    response.cookies.set(TENANT_COOKIE, slug, { path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'lax', secure: request.nextUrl.protocol === 'https:' });
  }
  return response;
}

export const config = {
  // Documents only. /api/v1 is the proxy to the API; static files and the health check need no nonce.
  matcher: [{ source: '/((?!api/|_next/static|_next/image|healthz|.*\\.(?:svg|png|jpg|jpeg|webp|ico|txt|woff2?)$).*)' }],
};
