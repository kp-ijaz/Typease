/**
 * Security headers shared by the four TypEase web apps.
 *
 * Two layers:
 *  1. `staticSecurityHeaders()` is set in next.config for EVERY response
 *     (documents, static files, route handlers): nosniff, referrer policy,
 *     permissions policy, and the part of the Content-Security-Policy that
 *     needs no nonce (frame-ancestors, base-uri, form-action, object-src).
 *  2. `contentSecurityPolicy()` is set per request by each app's middleware.
 *     It carries a fresh nonce for scripts, because the Next.js App Router
 *     emits inline bootstrap scripts; a static policy could only allow them
 *     with 'unsafe-inline', which would give up XSS protection.
 *
 * Browsers enforce both policies together (the result is the intersection).
 * Plain ES module without Node APIs: it also runs in the edge runtime.
 */

/** @param {string | undefined | null} url */
export function originOf(url) {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** @param {string | undefined | null} list space- or comma-separated origins */
export function parseOrigins(list) {
  return (list ?? '')
    .split(/[\s,]+/)
    .map((v) => originOf(v))
    .filter(Boolean);
}

/**
 * @param {{ nonce: string, apiUrl?: string | null, storageOrigins?: string | null, isDev?: boolean }} options
 * @returns {string}
 */
export function contentSecurityPolicy({ nonce, apiUrl, storageOrigins, isDev = false }) {
  const api = originOf(apiUrl);
  const storage = parseOrigins(storageOrigins);
  const remote = [api, ...storage].filter(Boolean).join(' ');
  const directives = [
    `default-src 'self'`,
    // Scripts: only our own bundles, started by the nonce'd bootstrap. No inline handlers, no eval in production.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    // Styles: our stylesheets plus inline styles (component libraries position popovers with style attributes).
    `style-src 'self' 'unsafe-inline'`,
    // Images: self, inline data, in-memory previews, and logos / signed files served by the API and the file store.
    `img-src 'self' data: blob:${remote ? ` ${remote}` : ''}`,
    `font-src 'self' data:`,
    // XHR / fetch: self (same-origin proxy), the API, the file store for signed uploads; dev adds the HMR socket.
    `connect-src 'self'${remote ? ` ${remote}` : ''}${isDev ? ' ws: wss:' : ''}`,
    // The document viewer shows PDFs from in-memory blobs.
    `frame-src 'self' blob:`,
    `worker-src 'self' blob:`,
    `media-src 'self' blob:`,
    `manifest-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
  ];
  return directives.join('; ');
}

/**
 * Headers for next.config `headers()`.
 * @param {{ camera?: boolean, isDev?: boolean }} [options] camera: the app captures documents with the device camera.
 * @returns {Array<{ key: string, value: string }>}
 */
export function staticSecurityHeaders({ camera = false, isDev = false } = {}) {
  const headers = [
    { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    {
      key: 'Permissions-Policy',
      value: [`camera=${camera ? '(self)' : '()'}`, 'microphone=()', 'geolocation=()', 'payment=()', 'usb=()', 'browsing-topics=()'].join(', '),
    },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    { key: 'X-DNS-Prefetch-Control', value: 'off' },
  ];
  // HSTS only makes sense over HTTPS; local development runs on plain HTTP.
  if (!isDev) headers.push({ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' });
  return headers;
}

/** A random nonce (base64). Uses Web Crypto, available in Node and in the edge runtime. */
export function newNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
