import { promises as dns } from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import { isIP } from 'node:net';
import { env } from '../../config/env';
import { isPrivateAddress } from '../notifications/providers/net-guard';

/**
 * SSRF guard for outbound calls whose target a centre typed in (connection
 * tests of its SMTP server, gateway or scanner).
 *
 * Rules:
 *  - HTTP targets must be https.
 *  - After DNS resolution EVERY address of the host must be public: no private,
 *    loopback, link-local, CGNAT, multicast or unspecified ranges.
 *  - The connection is then made to the address that was checked (the hostname
 *    is not resolved a second time, so a DNS answer cannot change in between).
 *  - Redirects are never followed.
 *
 * The only exception is for development and tests: a host that the operator
 * listed in OUTBOUND_WEBHOOK_ALLOWED_HOSTS may be private and may use plain
 * http, and only when NODE_ENV is not "production". In production the
 * exception does not exist.
 */
export class EndpointNotAllowed extends Error {
  constructor(
    message: string,
    public readonly code: 'URL_INVALID' | 'SCHEME_NOT_ALLOWED' | 'HOST_NOT_ALLOWED' | 'DNS_FAILED',
  ) {
    super(message);
  }
}

const stripBrackets = (host: string) => host.replace(/^\[|\]$/g, '');

/** A development host the operator explicitly allowed. Never true in production. */
export function isDevAllowedHost(host: string): boolean {
  if (env().NODE_ENV === 'production') return false;
  return env()
    .OUTBOUND_WEBHOOK_ALLOWED_HOSTS.map((h) => h.toLowerCase())
    .includes(stripBrackets(host).toLowerCase());
}

export interface ResolvedTarget {
  host: string;
  address: string;
  family: 4 | 6;
}

type Lookup = (host: string) => Promise<Array<{ address: string; family: number }>>;
const systemLookup: Lookup = (host) => dns.lookup(host, { all: true });

/** Resolves a host and refuses it unless every address is public (or the host is an allowed development host). */
export async function resolveSafeHost(host: string, what: string, lookup: Lookup = systemLookup): Promise<ResolvedTarget> {
  const clean = stripBrackets(host.trim());
  if (!clean) throw new EndpointNotAllowed(`${what}: the server address is empty.`, 'URL_INVALID');
  let addresses: Array<{ address: string; family: number }>;
  const literal = isIP(clean);
  if (literal) addresses = [{ address: clean, family: literal }];
  else {
    try {
      addresses = await lookup(clean);
    } catch {
      throw new EndpointNotAllowed(`${what}: the server "${clean}" could not be found. Check the spelling.`, 'DNS_FAILED');
    }
  }
  if (!addresses.length) throw new EndpointNotAllowed(`${what}: the server "${clean}" could not be found. Check the spelling.`, 'DNS_FAILED');
  if (addresses.some((a) => isPrivateAddress(a.address)) && !isDevAllowedHost(clean)) {
    throw new EndpointNotAllowed(`${what}: "${clean}" points to a private or internal network address, which is not allowed. Use the public address of the server.`, 'HOST_NOT_ALLOWED');
  }
  // Prefer IPv4: many mail servers and gateways do not listen on IPv6 even when the name has an AAAA record.
  const first = addresses.find((a) => a.family === 4) ?? addresses[0];
  return { host: clean, address: first.address, family: first.family === 6 ? 6 : 4 };
}

/** Parses and checks a URL: https only (http only for an allowed development host), no credentials in the URL. */
export function parseSafeUrl(raw: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EndpointNotAllowed(`${what}: the address is not a valid URL.`, 'URL_INVALID');
  }
  if (url.username || url.password) throw new EndpointNotAllowed(`${what}: the address must not contain a user name or password.`, 'URL_INVALID');
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && isDevAllowedHost(url.hostname)) return url;
  throw new EndpointNotAllowed(`${what}: only https:// addresses are allowed.`, 'SCHEME_NOT_ALLOWED');
}

/**
 * Tenant-supplied webhook-style endpoints (SMS gateway, OCR service, n8n) must
 * be https AND on the operator's allow-list, the same rule the sending code
 * applies (notifications/providers/net-guard.ts).
 */
export function assertApprovedEndpoint(raw: string, what: string): URL {
  const url = parseSafeUrl(raw, what);
  // The sending code never uses plain http, not even for a development host.
  if (url.protocol !== 'https:') throw new EndpointNotAllowed(`${what}: only https:// addresses are allowed.`, 'SCHEME_NOT_ALLOWED');
  const allowed = env().OUTBOUND_WEBHOOK_ALLOWED_HOSTS.map((h) => h.toLowerCase());
  if (!allowed.includes(url.hostname.toLowerCase())) {
    throw new EndpointNotAllowed(`${what}: the host "${url.hostname}" has not been approved yet. Ask TypEase support to approve it, then save again.`, 'HOST_NOT_ALLOWED');
  }
  return url;
}

export interface GuardedResponse {
  status: number;
  body: string;
  durationMs: number;
}

/**
 * One guarded HTTP request: checks the URL, resolves and checks the host, and
 * connects to exactly the checked address (TLS still verifies the certificate
 * against the host name). The response body is capped; redirects are returned
 * as they are, never followed.
 */
export async function guardedRequest(
  method: 'GET' | 'POST',
  rawUrl: string,
  opts: { what: string; headers?: Record<string, string>; timeoutMs?: number; maxBytes?: number; lookup?: Lookup },
): Promise<GuardedResponse> {
  const url = parseSafeUrl(rawUrl, opts.what);
  const target = await resolveSafeHost(url.hostname, opts.what, opts.lookup);
  const started = Date.now();
  const lib = url.protocol === 'https:' ? https : http;
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  return new Promise<GuardedResponse>((resolve, reject) => {
    const req = lib.request(
      {
        method,
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        headers: { accept: 'application/json', 'user-agent': 'TypEase-Integrations/1.0', ...(opts.headers ?? {}) },
        timeout: opts.timeoutMs ?? 10_000,
        // Pin the connection to the address that passed the check.
        lookup: (_hostname: string, options: any, callback: any) => {
          if (options?.all) callback(null, [{ address: target.address, family: target.family }]);
          else callback(null, target.address, target.family);
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size <= maxBytes) chunks.push(chunk);
          else res.destroy();
        });
        const done = () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), durationMs: Date.now() - started });
        res.on('end', done);
        res.on('close', done);
      },
    );
    req.on('timeout', () => req.destroy(new Error('The server did not answer in time.')));
    req.on('error', (e) => reject(e));
    req.end();
  });
}
