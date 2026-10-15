import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import { env } from '../../../config/env';
import { ProviderError } from './types';

/** Loopback, private, link-local, CGNAT, multicast and unspecified addresses (IPv4 and IPv6). */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    );
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith('ff');
  }
  return true;
}

/**
 * Hosts supplied by a tenant (their own SMTP server or SMS gateway) must not
 * point into our network. Enforced in production; local development commonly
 * uses a mail catcher on a private address.
 */
export async function assertPublicHost(host: string, what: string): Promise<void> {
  if (env().NODE_ENV !== 'production') return;
  const clean = host.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (isIP(clean)) addresses = [clean];
  else {
    try {
      addresses = (await dns.lookup(clean, { all: true })).map((a) => a.address);
    } catch {
      throw new ProviderError(`${what}: the host "${clean}" could not be resolved.`, true, 'DNS');
    }
  }
  if (!addresses.length || addresses.some(isPrivateAddress)) {
    throw new ProviderError(`${what}: the host "${clean}" is not allowed. Use a public server address.`, false, 'HOST_NOT_ALLOWED');
  }
}

/** Tenant-supplied HTTP endpoints must be HTTPS and on the operator's allow-list (OUTBOUND_WEBHOOK_ALLOWED_HOSTS). */
export function assertAllowedHttpEndpoint(url: string, what: string, allowed: string[] = env().OUTBOUND_WEBHOOK_ALLOWED_HOSTS): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ProviderError(`${what}: the address is not a valid URL.`, false, 'URL_INVALID');
  }
  if (parsed.protocol !== 'https:') throw new ProviderError(`${what}: only https:// addresses are allowed.`, false, 'HOST_NOT_ALLOWED');
  if (!allowed.map((h) => h.toLowerCase()).includes(parsed.hostname.toLowerCase())) {
    throw new ProviderError(`${what}: the host "${parsed.hostname}" has not been approved by the platform operator.`, false, 'HOST_NOT_ALLOWED');
  }
  return parsed;
}
