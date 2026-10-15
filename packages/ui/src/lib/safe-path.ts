/**
 * Kept in its own module, free of imports: the server entry (and with it each
 * app's middleware, which runs on the Edge runtime) can use it without pulling
 * in the API client.
 */

/** Only same-site paths are followed after sign-in ("/requests?bucket=overdue"); anything else falls back. */
export function safeNextPath(next: string | null | undefined, fallback: string): string {
  if (!next) return fallback;
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is being rejected
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\') || /[\u0000-\u001f]/.test(next)) return fallback;
  return next;
}
