import { NextResponse, type NextRequest } from 'next/server';
import { contentSecurityPolicy, newNonce } from '@typease/config/security.mjs';
import { API_URL, IS_DEV, STORAGE_ORIGINS } from '@/lib/config';

/**
 * Issues the Content-Security-Policy with a fresh script nonce for every
 * document request. The nonce travels to the root layout in the `x-nonce`
 * request header; Next.js reads it from the policy and applies it to its own
 * scripts. (The remaining security headers come from next.config.)
 */
export function middleware(request: NextRequest) {
  const nonce = newNonce();
  const csp = contentSecurityPolicy({ nonce, apiUrl: API_URL, storageOrigins: STORAGE_ORIGINS, isDev: IS_DEV });
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('content-security-policy', csp);
  return response;
}

export const config = {
  // Documents only: static files, images and the health check need no nonce.
  matcher: [{ source: '/((?!_next/static|_next/image|healthz|.*\\.(?:svg|png|jpg|jpeg|webp|ico|txt|woff2?)$).*)' }],
};
