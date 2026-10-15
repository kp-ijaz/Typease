import { createHmac } from 'node:crypto';
import { promises as dns } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { isPrivateAddress } from '../notifications/providers/net-guard';

/**
 * Outbound webhooks of the automation engine ("call n8n / webhook").
 *
 * Everything here exists to make sure a rule written by a centre can never be
 * used to reach into our own network (SSRF) and that the receiver can prove
 * where a call came from:
 *
 *   destination   a path below the n8n base address (of the centre or of the platform),
 *                 or a complete URL on a host approved by the platform operator
 *   scheme        https; plain http only where the operator said so (allow-list, platform n8n)
 *   address       resolved once, every resolved address must be public (see resolvePinned for
 *                 the two operator-controlled exceptions), and the connection is pinned to the
 *                 address that was checked (no DNS rebinding)
 *   redirects     never followed (a 3xx answer is a failure)
 *   time          10 seconds for the whole exchange
 *   response      only the status code is used; the body is discarded
 *   signature     HMAC-SHA256 over "<timestamp>.<body>" in X-TypEase-Signature
 */

export const WEBHOOK_TIMEOUT_MS = 10_000;
export const SIGNATURE_HEADER = 'X-TypEase-Signature';
export const TIMESTAMP_HEADER = 'X-TypEase-Timestamp';
export const DELIVERY_HEADER = 'X-TypEase-Delivery';
export const EVENT_HEADER = 'X-TypEase-Event';

export type RefusalCode = 'URL_INVALID' | 'HOST_NOT_ALLOWED' | 'HTTPS_REQUIRED' | 'CREDENTIALS_IN_URL' | 'PRIVATE_ADDRESS' | 'NOT_CONFIGURED';

/** The destination is not acceptable. Never retried: trying again cannot change the answer. */
export class WebhookRefused extends Error {
  constructor(
    public readonly code: RefusalCode,
    message: string,
  ) {
    super(message);
  }
}
/** The call was attempted and did not succeed. */
export class WebhookFailed extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status: number | null = null,
  ) {
    super(message);
  }
}

/** Why we may call a destination at all. It decides how strict the network checks are. */
export type DestinationTrust =
  /** Below N8N_WEBHOOK_BASE_URL: the platform's own n8n, chosen by the operator (usually inside the private network). */
  | 'PLATFORM'
  /** A host on the operator's allow-list (OUTBOUND_WEBHOOK_ALLOWED_HOSTS). */
  | 'ALLOW_LIST'
  /** Below the n8n address the centre saved under Integrations: typed by a tenant, so never trusted as a network location. */
  | 'TENANT';

export interface DestinationPolicy {
  /** Hosts approved by the platform operator (OUTBOUND_WEBHOOK_ALLOWED_HOSTS). */
  allowedHosts: string[];
  /** The centre's own n8n webhook base address (Integrations > n8n), when it has one. */
  tenantBase?: string | null;
  /** N8N_WEBHOOK_BASE_URL of the installation. */
  platformBase?: string | null;
  /** In production an allow-listed host must be public too. */
  production: boolean;
}
export interface CheckedUrl {
  url: URL;
  hostname: string;
  trust: DestinationTrust;
}
export interface PinnedAddress {
  address: string;
  family: 4 | 6;
}
export type LookupFn = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const bare = (hostname: string) => hostname.replace(/^\[|\]$/g, '').toLowerCase();
const trimBase = (base: string) => base.trim().replace(/\/+$/, '');

/** The n8n base address in force: the centre's own when it has one, otherwise the platform's. */
export const baseOf = (policy: DestinationPolicy): string | null => policy.tenantBase?.trim() || policy.platformBase?.trim() || null;

/** The address a rule points at: `path` below the n8n base address, or a complete `url`. */
export function destinationOf(config: { path?: string; url?: string }, policy: DestinationPolicy): string {
  if (config.url) return config.url;
  const base = baseOf(policy);
  if (!base) {
    throw new WebhookRefused('NOT_CONFIGURED', 'No n8n address is configured. Add your n8n connection under Integrations, or use a complete URL on an approved host.');
  }
  return `${trimBase(base)}${config.path ?? ''}`;
}

function isUnder(url: URL, base: string | null | undefined): boolean {
  if (!base?.trim()) return false;
  let b: URL;
  try {
    b = new URL(trimBase(base));
  } catch {
    return false;
  }
  if (b.origin !== url.origin) return false;
  const prefix = b.pathname.replace(/\/+$/, '');
  return prefix === '' || url.pathname === prefix || url.pathname.startsWith(`${prefix}/`);
}

/** Static checks: form of the URL, scheme, and whether the host is one we may call at all. */
export function checkUrl(raw: string, policy: DestinationPolicy): CheckedUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookRefused('URL_INVALID', 'The webhook address is not a valid URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new WebhookRefused('URL_INVALID', 'Only https:// webhook addresses are supported.');
  if (url.username || url.password) throw new WebhookRefused('CREDENTIALS_IN_URL', 'The webhook address must not contain a user name or password.');
  const hostname = bare(url.hostname);
  if (!hostname) throw new WebhookRefused('URL_INVALID', 'The webhook address has no host.');

  let trust: DestinationTrust;
  if (isUnder(url, policy.platformBase)) trust = 'PLATFORM';
  else if (policy.allowedHosts.map((h) => h.trim().toLowerCase()).filter(Boolean).includes(hostname)) trust = 'ALLOW_LIST';
  else if (isUnder(url, policy.tenantBase)) trust = 'TENANT';
  else throw new WebhookRefused('HOST_NOT_ALLOWED', `The host "${hostname}" is neither your configured n8n address nor a host approved by the platform operator.`);

  // Plain http only where the operator said so: the allow-list, or the platform's own n8n.
  if (url.protocol === 'http:' && trust === 'TENANT') throw new WebhookRefused('HTTPS_REQUIRED', 'Webhook addresses must use https://.');
  return { url, hostname, trust };
}

const systemLookup: LookupFn = (hostname) => dns.lookup(hostname, { all: true });

/** May a destination of this trust level resolve to a private address? */
export function privateAllowed(trust: DestinationTrust, production: boolean): boolean {
  if (trust === 'PLATFORM') return true;
  if (trust === 'ALLOW_LIST') return !production;
  return false;
}

/**
 * Resolves the host and refuses private, loopback, link-local and other
 * non-public addresses: if ANY resolved address is private the call is refused.
 *
 * Two exceptions, both decided by the operator and never by a centre:
 *  - the platform's own n8n (N8N_WEBHOOK_BASE_URL), which normally lives in the private network;
 *  - outside production, a host on the allow-list (a local n8n during development and in tests).
 */
export async function resolvePinned(checked: CheckedUrl, policy: DestinationPolicy, lookup: LookupFn = systemLookup): Promise<PinnedAddress> {
  let addresses: Array<{ address: string; family: number }>;
  const literal = isIP(checked.hostname);
  if (literal) addresses = [{ address: checked.hostname, family: literal }];
  else {
    try {
      addresses = await lookup(checked.hostname);
    } catch {
      throw new WebhookFailed(`The host "${checked.hostname}" could not be resolved.`, true);
    }
  }
  if (!addresses.length) throw new WebhookFailed(`The host "${checked.hostname}" could not be resolved.`, true);
  if (!privateAllowed(checked.trust, policy.production) && addresses.some((a) => isPrivateAddress(a.address))) {
    throw new WebhookRefused('PRIVATE_ADDRESS', `The host "${checked.hostname}" points to a private or internal network address. Webhooks can only be sent to public addresses.`);
  }
  const first = addresses.find((a) => a.family === 4) ?? addresses[0];
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

export function sign(secret: string, timestamp: number | string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

export interface PostInput {
  checked: CheckedUrl;
  pinned: PinnedAddress;
  body: string;
  secret: string;
  deliveryId: string;
  event: string;
  timeoutMs?: number;
  now?: () => number;
}

/** POSTs the signed body to the pinned address. Resolves with the status code of a 2xx answer, throws otherwise. */
export function postSigned(input: PostInput): Promise<{ status: number }> {
  const { checked, pinned } = input;
  const timestamp = Math.floor((input.now?.() ?? Date.now()) / 1000);
  const payload = Buffer.from(input.body, 'utf8');
  const secure = checked.url.protocol === 'https:';
  const options: https.RequestOptions = {
    method: 'POST',
    hostname: checked.hostname,
    port: checked.url.port || (secure ? 443 : 80),
    path: `${checked.url.pathname}${checked.url.search}`,
    agent: false,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(payload.length),
      'User-Agent': 'TypEase-Automation/1.0',
      Accept: '*/*',
      [TIMESTAMP_HEADER]: String(timestamp),
      [SIGNATURE_HEADER]: sign(input.secret, timestamp, input.body),
      [DELIVERY_HEADER]: input.deliveryId,
      [EVENT_HEADER]: input.event,
    },
    // The connection goes to the address that passed the check, whatever DNS says a moment later.
    lookup: ((_hostname: string, opts: any, cb: any) => {
      const callback = typeof opts === 'function' ? opts : cb;
      if (opts && typeof opts === 'object' && opts.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
      else callback(null, pinned.address, pinned.family);
    }) as any,
  };
  const timeoutMs = input.timeoutMs ?? WEBHOOK_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const req = (secure ? https : http).request(options, (res) => {
      const status = res.statusCode ?? 0;
      // The body is never read into memory or interpreted.
      let seen = 0;
      res.on('data', (chunk: Buffer) => {
        seen += chunk.length;
        if (seen > 65_536) res.destroy();
      });
      res.on('error', () => undefined);
      finish(() => {
        if (status >= 200 && status < 300) return resolve({ status });
        if (status >= 300 && status < 400) return reject(new WebhookFailed(`The webhook answered with a redirect (HTTP ${status}). Redirects are not followed; use the final address.`, false, status));
        const retryable = status >= 500 || status === 408 || status === 425 || status === 429;
        reject(new WebhookFailed(`The webhook answered with HTTP ${status}.`, retryable, status));
      });
    });
    const timer = setTimeout(() => {
      finish(() => reject(new WebhookFailed(`The webhook did not answer within ${Math.round(timeoutMs / 1000)} seconds.`, true)));
      req.destroy();
    }, timeoutMs);
    req.on('error', (e: NodeJS.ErrnoException) => finish(() => reject(new WebhookFailed(`The webhook could not be reached (${e.code ?? e.message}).`, true))));
    req.end(payload);
  });
}

// ---------------------------------------------------------------------------------- payload
/**
 * Fields of a domain event that may leave the system: identifiers, codes,
 * amounts and dates. Names, free text typed by people, identity numbers and
 * document contents are never part of a webhook, whatever the event carries.
 */
export const WEBHOOK_DATA_FIELDS = [
  'requestId', 'requestNo', 'requestIds', 'customerId', 'corporateAccountId', 'serviceId', 'branchId', 'source',
  'from', 'to', 'customerVisible', 'assigneeMembershipId', 'assigneeUserId', 'role', 'method', 'stepKey', 'escalateToRoleKey',
  'documentId', 'versionId', 'checklistItemId', 'documentTypeKey', 'uploadedByType', 'generated', 'isCompletionDocument', 'expiryDate', 'expiryVerified',
  'scheduleId', 'dispatchId', 'daysLeft', 'offsetDays',
  'quotationId', 'approvedByType', 'paymentId', 'invoiceId', 'invoiceIds', 'amount', 'currency',
  'appointmentId', 'startsAt', 'subscriptionId', 'dueAt', 'planKey',
] as const;

const isScalar = (v: unknown) => v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 200);

export function safeEventData(payload: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of WEBHOOK_DATA_FIELDS) {
    const value = payload?.[key];
    if (value === undefined) continue;
    if (isScalar(value)) out[key] = value;
    else if (Array.isArray(value) && value.length <= 100 && value.every((v) => typeof v === 'string' && v.length <= 200)) out[key] = value;
  }
  return out;
}
