import { env } from '../../../config/env';
import {
  CheckoutRequest, CheckoutSession, fromMinorUnits, GatewayError, GatewayEvent, header, parseJsonBody, PaymentGateway, PeekedReference, RefundRequest,
  RefundResult, stringMap, toMinorUnits, verifyTimestamped, WebhookHeaders, WebhookSignatureError,
} from './payment-gateway';

export interface StripeCredentials {
  secretKey: string;
  /** Signing secret of the webhook endpoint (whsec_...). */
  webhookSecret?: string | null;
}
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

const API = 'https://api.stripe.com/v1';
const TIMEOUT_MS = 20_000;

/** Stripe's form encoding: nested objects become key[sub][sub]=value. */
export function formEncode(value: Record<string, unknown>, prefix = ''): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => parts.push(typeof item === 'object' ? formEncode(item as Record<string, unknown>, `${key}[${i}]`) : `${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`));
    else if (typeof v === 'object') parts.push(formEncode(v as Record<string, unknown>, key));
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return parts.filter(Boolean).join('&');
}

/**
 * Stripe adapter written against Stripe's public HTTP API (Checkout Sessions,
 * Refunds, webhook signatures) using fetch - no SDK.
 *
 * STATUS: implemented, NOT verified against live Stripe (no credentials are
 * available in this environment). Signature verification and request building
 * are unit-tested with locally computed values.
 *
 * Card data never touches TypEase: the customer pays on Stripe's hosted page.
 */
export class StripeGateway implements PaymentGateway {
  readonly name = 'stripe';
  readonly isTest: boolean;

  constructor(
    private readonly credentials: StripeCredentials,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {
    this.isTest = credentials.secretKey.startsWith('sk_test_');
  }

  static peek(rawBody: Buffer): PeekedReference | null {
    try {
      const object = JSON.parse(rawBody.toString('utf8'))?.data?.object ?? {};
      if (object.object !== 'checkout.session') return null;
      const pi = typeof object.payment_intent === 'string' ? object.payment_intent : (object.payment_intent?.id ?? null);
      return { sessionRef: typeof object.id === 'string' ? object.id : null, paymentRef: pi };
    } catch {
      return null;
    }
  }

  private async call(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, idempotencyKey?: string): Promise<any> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.credentials.secretKey}` };
    if (body) headers['content-type'] = 'application/x-www-form-urlencoded';
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(`${API}${path}`, { method, headers, body: body ? formEncode(body) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e: any) {
      throw new GatewayError('stripe', `Stripe could not be reached: ${e?.message ?? e}`);
    }
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new GatewayError('stripe', `Stripe returned an unreadable response (HTTP ${res.status}).`, res.status);
    }
    if (!res.ok) throw new GatewayError('stripe', json?.error?.message ?? `Stripe rejected the request (HTTP ${res.status}).`, res.status, json?.error?.code ?? json?.error?.type);
    return json;
  }

  async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    const metadata = { ...request.metadata, reference: request.reference, channel: request.channel };
    const session = await this.call(
      'POST',
      '/checkout/sessions',
      {
        mode: 'payment',
        success_url: request.successUrl,
        cancel_url: request.cancelUrl,
        client_reference_id: request.reference,
        customer_email: request.customerEmail ?? undefined,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: request.currency.toLowerCase(),
              unit_amount: toMinorUnits(request.amount, request.currency),
              product_data: { name: request.description.slice(0, 250) },
            },
          },
        ],
        metadata,
        payment_intent_data: { metadata },
      },
      `checkout-${request.reference}`,
    );
    if (typeof session.id !== 'string' || typeof session.url !== 'string') throw new GatewayError('stripe', 'Stripe did not return a checkout session.');
    return { sessionRef: session.id, checkoutUrl: session.url, expiresAt: typeof session.expires_at === 'number' ? new Date(session.expires_at * 1000) : null };
  }

  verifyWebhook(rawBody: Buffer, headers: WebhookHeaders, now: Date = new Date()): GatewayEvent {
    verifyTimestamped(rawBody, header(headers, 'stripe-signature'), this.credentials.webhookSecret ?? undefined, env().PAYMENT_WEBHOOK_TOLERANCE_SECONDS, now);
    const event = parseJsonBody(rawBody);
    if (typeof event.id !== 'string' || !event.id || typeof event.type !== 'string') throw new WebhookSignatureError('MALFORMED_PAYLOAD', 'The webhook has no event id or type.');
    const object = event.data?.object ?? {};
    const isSession = object.object === 'checkout.session';
    let type: GatewayEvent['type'] = 'ignored';
    let failureReason: string | null = null;
    if (isSession) {
      if (event.type === 'checkout.session.completed') type = object.payment_status === 'paid' ? 'payment.succeeded' : 'ignored'; // unpaid = asynchronous method, a later event decides
      else if (event.type === 'checkout.session.async_payment_succeeded') type = 'payment.succeeded';
      else if (event.type === 'checkout.session.async_payment_failed') {
        type = 'payment.failed';
        failureReason = 'The payment was not completed by the bank.';
      } else if (event.type === 'checkout.session.expired') {
        type = 'payment.failed';
        failureReason = 'The checkout session expired before the payment was made.';
      }
    }
    const currency = typeof object.currency === 'string' ? object.currency.toUpperCase() : null;
    return {
      id: event.id,
      type,
      rawType: event.type,
      sessionRef: isSession && typeof object.id === 'string' ? object.id : null,
      paymentRef: typeof object.payment_intent === 'string' ? object.payment_intent : (object.payment_intent?.id ?? null),
      amount: isSession && typeof object.amount_total === 'number' && currency ? fromMinorUnits(object.amount_total, currency) : null,
      currency,
      failureReason,
      occurredAt: new Date((typeof event.created === 'number' ? event.created : Math.floor(now.getTime() / 1000)) * 1000),
      metadata: stringMap(object.metadata),
    };
  }

  private static refundResult(refund: any): RefundResult {
    if (typeof refund?.id !== 'string') throw new GatewayError('stripe', 'Stripe did not return a refund.');
    const status = refund.status === 'succeeded' ? 'COMPLETED' : refund.status === 'pending' || refund.status === 'requires_action' ? 'PENDING' : 'FAILED';
    return { refundRef: refund.id, status, failureReason: status === 'FAILED' ? (refund.failure_reason ?? `Stripe reported the refund as ${refund.status}.`) : null };
  }

  async refund(request: RefundRequest): Promise<RefundResult> {
    const refund = await this.call(
      'POST',
      '/refunds',
      { payment_intent: request.paymentRef, amount: toMinorUnits(request.amount, request.currency), reason: 'requested_by_customer', metadata: { reference: request.reference } },
      `refund-${request.reference}`,
    );
    return StripeGateway.refundResult(refund);
  }

  async getRefund(refundRef: string): Promise<RefundResult> {
    return StripeGateway.refundResult(await this.call('GET', `/refunds/${encodeURIComponent(refundRef)}`));
  }
}
