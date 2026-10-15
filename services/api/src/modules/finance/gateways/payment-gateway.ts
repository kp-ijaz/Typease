import { createHmac, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@typease/database';

/**
 * Port for online card / wallet payments. The same adapters serve two completely
 * separate flows: customer payments of a typing centre (tenant credentials, tenant
 * tables) and SaaS subscription payments to TypEase (platform credentials,
 * subscription tables). A flow never sees the other flow's events: each has its own
 * webhook route (`channel`).
 */
export type GatewayChannel = 'payments' | 'subscriptions';

export interface CheckoutRequest {
  channel: GatewayChannel;
  /** Our id for the charge (payment id / subscription invoice id). Used as the gateway idempotency key. */
  reference: string;
  /** Decimal string in major units, e.g. "157.50". */
  amount: string;
  currency: string;
  description: string;
  customerEmail?: string | null;
  successUrl: string;
  cancelUrl: string;
  /** Echoed back in the webhook. Never put personal data here. */
  metadata: Record<string, string>;
}
export interface CheckoutSession {
  sessionRef: string;
  checkoutUrl: string;
  expiresAt: Date | null;
}

export interface GatewayEvent {
  /** Gateway's unique id of this delivery: the duplicate / replay key. */
  id: string;
  type: 'payment.succeeded' | 'payment.failed' | 'ignored';
  /** Event name as sent by the gateway. */
  rawType: string;
  sessionRef: string | null;
  /** Gateway id of the money movement (needed for refunds). */
  paymentRef: string | null;
  /** Decimal string in major units, when the event carries an amount. */
  amount: string | null;
  currency: string | null;
  failureReason: string | null;
  occurredAt: Date;
  metadata: Record<string, string>;
}

export interface RefundRequest {
  /** Our refund id: the gateway idempotency key, so a retry never refunds twice. */
  reference: string;
  paymentRef: string;
  amount: string;
  currency: string;
  reason?: string | null;
}
export interface RefundResult {
  refundRef: string;
  status: 'COMPLETED' | 'PENDING' | 'FAILED';
  failureReason?: string | null;
}

export interface PaymentGateway {
  readonly name: string;
  /** True for adapters that never move real money. */
  readonly isTest: boolean;
  createCheckout(request: CheckoutRequest): Promise<CheckoutSession>;
  /**
   * Verifies the signature over the RAW request body and the timestamp tolerance,
   * then returns the normalised event. Throws WebhookSignatureError otherwise.
   */
  verifyWebhook(rawBody: Buffer, headers: WebhookHeaders, now?: Date): GatewayEvent;
  refund(request: RefundRequest): Promise<RefundResult>;
  /** Current state of a refund that was still pending when it was created. */
  getRefund(refundRef: string): Promise<RefundResult>;
}

export type WebhookHeaders = Record<string, string | string[] | undefined>;

/** Unverified pointers read from a webhook body, used ONLY to find whose secret verifies it. */
export interface PeekedReference {
  sessionRef: string | null;
  paymentRef: string | null;
}

export class WebhookSignatureError extends Error {
  constructor(
    public readonly reason: 'MISSING_SIGNATURE' | 'MALFORMED_SIGNATURE' | 'TIMESTAMP_OUT_OF_TOLERANCE' | 'SIGNATURE_MISMATCH' | 'MALFORMED_PAYLOAD' | 'NO_SECRET',
    message: string,
  ) {
    super(message);
  }
}

export class GatewayError extends Error {
  constructor(
    public readonly gateway: string,
    message: string,
    public readonly statusCode?: number,
    public readonly gatewayCode?: string,
  ) {
    super(message);
  }
}

export const header = (headers: WebhookHeaders, name: string): string | undefined => {
  const v = headers[name.toLowerCase()] ?? headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * Timestamped HMAC-SHA256 signatures in the widely used `t=<unix>,v1=<hex>` form
 * (the scheme Stripe documents): the signed string is `${t}.${rawBody}`.
 * Several v1 values may be present during secret rotation; any match is accepted.
 */
export function signTimestamped(rawBody: string | Buffer, secret: string, timestampSeconds = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac('sha256', secret).update(`${timestampSeconds}.`).update(rawBody).digest('hex');
  return `t=${timestampSeconds},v1=${mac}`;
}

export function verifyTimestamped(rawBody: Buffer, signatureHeader: string | undefined, secret: string | undefined, toleranceSeconds: number, now: Date = new Date()): { timestamp: number } {
  if (!secret) throw new WebhookSignatureError('NO_SECRET', 'No webhook signing secret is configured.');
  if (!signatureHeader) throw new WebhookSignatureError('MISSING_SIGNATURE', 'The signature header is missing.');
  let timestamp: number | null = null;
  const candidates: string[] = [];
  for (const part of signatureHeader.split(',')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key === 't' && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    else if (key === 'v1' && /^[0-9a-f]{64}$/i.test(value)) candidates.push(value.toLowerCase());
  }
  if (timestamp === null || !candidates.length) throw new WebhookSignatureError('MALFORMED_SIGNATURE', 'The signature header is malformed.');
  const expected = Buffer.from(createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex'));
  const ok = candidates.some((c) => {
    const given = Buffer.from(c);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!ok) throw new WebhookSignatureError('SIGNATURE_MISMATCH', 'The signature does not match the payload.');
  // Checked after the MAC so an attacker learns nothing from timing; a captured delivery cannot be replayed later.
  if (Math.abs(Math.floor(now.getTime() / 1000) - timestamp) > toleranceSeconds) {
    throw new WebhookSignatureError('TIMESTAMP_OUT_OF_TOLERANCE', 'The delivery is too old (or from the future) and was rejected.');
  }
  return { timestamp };
}

const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const THREE_DECIMAL = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);
const exponent = (currency: string) => (ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : THREE_DECIMAL.has(currency.toUpperCase()) ? 3 : 2);

/** "157.50" AED -> 15750 (gateways count in the smallest currency unit). */
export function toMinorUnits(amount: string, currency: string): number {
  const minor = new Prisma.Decimal(amount).mul(new Prisma.Decimal(10).pow(exponent(currency)));
  if (!minor.isInteger()) throw new Error(`Amount ${amount} ${currency} cannot be expressed in minor units.`);
  return minor.toNumber();
}
export function fromMinorUnits(minor: number | string, currency: string): string {
  return new Prisma.Decimal(minor).div(new Prisma.Decimal(10).pow(exponent(currency))).toFixed(2);
}

export function parseJsonBody(rawBody: Buffer): any {
  try {
    const parsed = JSON.parse(rawBody.toString('utf8'));
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    return parsed;
  } catch {
    throw new WebhookSignatureError('MALFORMED_PAYLOAD', 'The webhook body is not valid JSON.');
  }
}
export function stringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value && typeof value === 'object') for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (v !== null && v !== undefined) out[k] = String(v);
  return out;
}
