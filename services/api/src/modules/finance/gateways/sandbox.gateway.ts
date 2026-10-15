import { env } from '../../../config/env';
import { randomToken, sha256, signPayload, verifyPayload } from '../../../common/crypto';
import {
  CheckoutRequest, CheckoutSession, GatewayChannel, GatewayEvent, header, parseJsonBody, PaymentGateway, PeekedReference, RefundRequest, RefundResult,
  signTimestamped, stringMap, verifyTimestamped, WebhookHeaders, WebhookSignatureError,
} from './payment-gateway';

export const SANDBOX_SIGNATURE_HEADER = 'x-typease-sandbox-signature';
const SESSION_TTL_SECONDS = 3600;
const PREFIX = 'sbx_cs_';

/** What a sandbox checkout session carries (signed, so it cannot be forged or edited). */
export interface SandboxSession {
  channel: GatewayChannel;
  reference: string;
  amount: string;
  currency: string;
  description: string;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
  exp: number;
}

export function decodeSandboxSession(sessionRef: string): SandboxSession | null {
  if (!sessionRef?.startsWith(PREFIX)) return null;
  const payload = verifyPayload<any>(sessionRef.slice(PREFIX.length));
  if (!payload || payload.k !== 'sandbox-checkout') return null;
  return {
    channel: payload.ch,
    reference: payload.ref,
    amount: payload.amt,
    currency: payload.cur,
    description: payload.desc,
    successUrl: payload.ok,
    cancelUrl: payload.ko,
    metadata: payload.meta ?? {},
    exp: payload.exp,
  };
}

/** The money-movement id the sandbox "gateway" assigns to a session (stable, so one session can only pay once). */
export const sandboxPaymentRef = (sessionRef: string) => `sbx_pi_${sha256(sessionRef).slice(0, 24)}`;

/** Builds the webhook the sandbox sends for a session, exactly as an external gateway would: raw JSON + signature header. */
export function buildSandboxWebhook(
  sessionRef: string,
  outcome: 'succeeded' | 'failed',
  opts: { eventId?: string; reason?: string | null; timestampSeconds?: number; secret?: string } = {},
): { body: string; headers: Record<string, string>; eventId: string } {
  const session = decodeSandboxSession(sessionRef);
  if (!session) throw new Error('Unknown or expired sandbox session.');
  const created = opts.timestampSeconds ?? Math.floor(Date.now() / 1000);
  const eventId = opts.eventId ?? `sbx_evt_${randomToken(12)}`;
  const body = JSON.stringify({
    id: eventId,
    type: outcome === 'succeeded' ? 'checkout.succeeded' : 'checkout.failed',
    created,
    livemode: false,
    data: {
      sessionRef,
      paymentRef: outcome === 'succeeded' ? sandboxPaymentRef(sessionRef) : null,
      reference: session.reference,
      amount: session.amount,
      currency: session.currency,
      failureReason: outcome === 'failed' ? (opts.reason ?? 'The test payment was declined.') : null,
      metadata: session.metadata,
    },
  });
  return {
    body,
    eventId,
    headers: { 'content-type': 'application/json', [SANDBOX_SIGNATURE_HEADER]: signTimestamped(body, opts.secret ?? env().PAYMENT_SANDBOX_WEBHOOK_SECRET, created) },
  };
}

/**
 * TEST adapter. No money moves and no external service is called.
 *
 * It is only available when PAYMENT_SANDBOX_ENABLED is true (env validation forces
 * it off in production). The "hosted checkout page" lives on our own API
 * (/public/payments/sandbox/checkout/:sessionRef); completing or failing it makes
 * the sandbox deliver a correctly signed webhook to our real webhook endpoint, so
 * the whole online flow can be exercised end to end.
 *
 * Refunds succeed immediately, except when the reason contains "[sandbox:fail]"
 * (a documented switch to exercise the failure path).
 */
export class SandboxGateway implements PaymentGateway {
  readonly name = 'sandbox';
  readonly isTest = true;

  static peek(rawBody: Buffer): PeekedReference | null {
    try {
      const data = JSON.parse(rawBody.toString('utf8'))?.data ?? {};
      return { sessionRef: typeof data.sessionRef === 'string' ? data.sessionRef : null, paymentRef: typeof data.paymentRef === 'string' ? data.paymentRef : null };
    } catch {
      return null;
    }
  }

  async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    const token = signPayload(
      { k: 'sandbox-checkout', ch: request.channel, ref: request.reference, amt: request.amount, cur: request.currency, desc: request.description, ok: request.successUrl, ko: request.cancelUrl, meta: request.metadata },
      SESSION_TTL_SECONDS,
    );
    const sessionRef = `${PREFIX}${token}`;
    return {
      sessionRef,
      checkoutUrl: `${env().API_PUBLIC_URL}/api/v1/public/payments/sandbox/checkout/${sessionRef}`,
      expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
    };
  }

  verifyWebhook(rawBody: Buffer, headers: WebhookHeaders, now: Date = new Date()): GatewayEvent {
    verifyTimestamped(rawBody, header(headers, SANDBOX_SIGNATURE_HEADER), env().PAYMENT_SANDBOX_WEBHOOK_SECRET, env().PAYMENT_WEBHOOK_TOLERANCE_SECONDS, now);
    const event = parseJsonBody(rawBody);
    if (typeof event.id !== 'string' || !event.id || typeof event.type !== 'string') throw new WebhookSignatureError('MALFORMED_PAYLOAD', 'The webhook has no event id or type.');
    const data = event.data ?? {};
    return {
      id: event.id,
      type: event.type === 'checkout.succeeded' ? 'payment.succeeded' : event.type === 'checkout.failed' ? 'payment.failed' : 'ignored',
      rawType: event.type,
      sessionRef: typeof data.sessionRef === 'string' ? data.sessionRef : null,
      paymentRef: typeof data.paymentRef === 'string' ? data.paymentRef : null,
      amount: data.amount !== undefined && data.amount !== null ? String(data.amount) : null,
      currency: typeof data.currency === 'string' ? data.currency.toUpperCase() : null,
      failureReason: typeof data.failureReason === 'string' ? data.failureReason : null,
      occurredAt: new Date((typeof event.created === 'number' ? event.created : Math.floor(now.getTime() / 1000)) * 1000),
      metadata: stringMap(data.metadata),
    };
  }

  async refund(request: RefundRequest): Promise<RefundResult> {
    if ((request.reason ?? '').includes('[sandbox:fail]')) {
      return { refundRef: `sbx_re_${sha256(request.reference).slice(0, 24)}`, status: 'FAILED', failureReason: 'The sandbox gateway declined the test refund.' };
    }
    return { refundRef: `sbx_re_${sha256(request.reference).slice(0, 24)}`, status: 'COMPLETED' };
  }
  async getRefund(refundRef: string): Promise<RefundResult> {
    return { refundRef, status: 'COMPLETED' };
  }
}
