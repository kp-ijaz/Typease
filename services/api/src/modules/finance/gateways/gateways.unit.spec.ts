import { createHmac } from 'node:crypto';
import { looksLikeCardNumber } from '@typease/validation';
import '../../../../test/env';
import { requestHash, stableStringify } from '../idempotency.service';
import { fromMinorUnits, GatewayError, signTimestamped, toMinorUnits, verifyTimestamped, WebhookSignatureError } from './payment-gateway';
import { buildSandboxWebhook, decodeSandboxSession, SandboxGateway, sandboxPaymentRef } from './sandbox.gateway';
import { formEncode, StripeGateway } from './stripe.gateway';

const SECRET = 'whsec_test_0123456789abcdef';
const reason = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof WebhookSignatureError) return e.reason;
    throw e;
  }
  return 'NO_ERROR';
};

describe('webhook signatures (t=...,v1=... HMAC-SHA256 over "<t>.<raw body>")', () => {
  const body = Buffer.from('{"id":"evt_1","type":"checkout.session.completed"}');
  const now = new Date('2026-06-10T10:00:00Z');
  const ts = Math.floor(now.getTime() / 1000);
  // Computed independently of the implementation under test, exactly as Stripe documents it.
  const expected = createHmac('sha256', SECRET).update(`${ts}.${body.toString('utf8')}`, 'utf8').digest('hex');

  it('produces the documented signature', () => {
    expect(signTimestamped(body, SECRET, ts)).toBe(`t=${ts},v1=${expected}`);
  });
  it('accepts a valid signature inside the tolerance', () => {
    expect(verifyTimestamped(body, `t=${ts},v1=${expected}`, SECRET, 300, now)).toEqual({ timestamp: ts });
    expect(reason(() => verifyTimestamped(body, `t=${ts},v1=${expected}`, SECRET, 300, new Date(now.getTime() + 299_000)))).toBe('NO_ERROR');
  });
  it('accepts any matching v1 during secret rotation and ignores other schemes', () => {
    const header = `t=${ts},v0=deadbeef,v1=${'0'.repeat(64)},v1=${expected}`;
    expect(reason(() => verifyTimestamped(body, header, SECRET, 300, now))).toBe('NO_ERROR');
  });
  it('rejects a wrong secret, a changed body and a changed timestamp', () => {
    expect(reason(() => verifyTimestamped(body, `t=${ts},v1=${expected}`, 'whsec_other', 300, now))).toBe('SIGNATURE_MISMATCH');
    expect(reason(() => verifyTimestamped(Buffer.from(body.toString().replace('evt_1', 'evt_2')), `t=${ts},v1=${expected}`, SECRET, 300, now))).toBe('SIGNATURE_MISMATCH');
    expect(reason(() => verifyTimestamped(body, `t=${ts + 1},v1=${expected}`, SECRET, 300, now))).toBe('SIGNATURE_MISMATCH');
  });
  it('rejects stale and future deliveries even when the signature is valid (replay resistance)', () => {
    const old = ts - 301;
    const header = signTimestamped(body, SECRET, old);
    expect(reason(() => verifyTimestamped(body, header, SECRET, 300, now))).toBe('TIMESTAMP_OUT_OF_TOLERANCE');
    expect(reason(() => verifyTimestamped(body, signTimestamped(body, SECRET, ts + 301), SECRET, 300, now))).toBe('TIMESTAMP_OUT_OF_TOLERANCE');
    expect(reason(() => verifyTimestamped(body, signTimestamped(body, SECRET, ts - 300), SECRET, 300, now))).toBe('NO_ERROR');
  });
  it('rejects missing or malformed headers and a missing secret', () => {
    expect(reason(() => verifyTimestamped(body, undefined, SECRET, 300, now))).toBe('MISSING_SIGNATURE');
    expect(reason(() => verifyTimestamped(body, 'garbage', SECRET, 300, now))).toBe('MALFORMED_SIGNATURE');
    expect(reason(() => verifyTimestamped(body, `v1=${expected}`, SECRET, 300, now))).toBe('MALFORMED_SIGNATURE');
    expect(reason(() => verifyTimestamped(body, `t=${ts}`, SECRET, 300, now))).toBe('MALFORMED_SIGNATURE');
    expect(reason(() => verifyTimestamped(body, `t=${ts},v1=short`, SECRET, 300, now))).toBe('MALFORMED_SIGNATURE');
    expect(reason(() => verifyTimestamped(body, `t=${ts},v1=${expected}`, undefined, 300, now))).toBe('NO_SECRET');
  });
});

describe('minor units', () => {
  it('converts two-, zero- and three-decimal currencies', () => {
    expect(toMinorUnits('157.50', 'AED')).toBe(15750);
    expect(toMinorUnits('0.01', 'aed')).toBe(1);
    expect(toMinorUnits('1999.99', 'USD')).toBe(199999);
    expect(toMinorUnits('500.00', 'JPY')).toBe(500);
    expect(toMinorUnits('12.34', 'KWD')).toBe(12340);
    expect(fromMinorUnits(15750, 'AED')).toBe('157.50');
    expect(fromMinorUnits(500, 'JPY')).toBe('500.00');
    expect(fromMinorUnits(12340, 'KWD')).toBe('12.34');
    expect(() => toMinorUnits('10.50', 'JPY')).toThrow();
  });
});

describe('StripeGateway (implemented against the public HTTP API; not verified against live Stripe)', () => {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const fakeFetch = (response: { status: number; json: unknown }) => async (url: string, init: any) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    return { status: response.status, ok: response.status >= 200 && response.status < 300, text: async () => JSON.stringify(response.json) };
  };
  const event = (overrides: Record<string, unknown> = {}, type = 'checkout.session.completed') =>
    Buffer.from(
      JSON.stringify({
        id: 'evt_1PabcDEF',
        object: 'event',
        type,
        created: Math.floor(Date.now() / 1000),
        data: { object: { id: 'cs_test_a1b2', object: 'checkout.session', payment_status: 'paid', payment_intent: 'pi_3Pxyz', amount_total: 30500, currency: 'aed', client_reference_id: 'pay-1', metadata: { paymentId: 'pay-1', tenantId: 'ten-1' }, ...overrides } },
      }),
    );
  beforeEach(() => (calls.length = 0));

  it('form-encodes nested parameters the way Stripe expects', () => {
    expect(decodeURIComponent(formEncode({ mode: 'payment', line_items: [{ quantity: 1, price_data: { currency: 'aed', unit_amount: 100 } }], metadata: { a: 'b c' }, skip: undefined }))).toBe(
      'mode=payment&line_items[0][quantity]=1&line_items[0][price_data][currency]=aed&line_items[0][price_data][unit_amount]=100&metadata[a]=b c',
    );
  });

  it('creates a Checkout Session with minor units, metadata and an idempotency key', async () => {
    const gateway = new StripeGateway({ secretKey: 'sk_test_123', webhookSecret: SECRET }, fakeFetch({ status: 200, json: { id: 'cs_test_a1b2', url: 'https://checkout.stripe.com/c/pay/cs_test_a1b2', expires_at: 1781000000 } }));
    const session = await gateway.createCheckout({
      channel: 'payments', reference: 'pay-1', amount: '305.00', currency: 'AED', description: 'Invoice INV-000001', customerEmail: 'a@example.test',
      successUrl: 'https://portal.example/ok', cancelUrl: 'https://portal.example/cancel', metadata: { paymentId: 'pay-1' },
    });
    expect(session).toEqual({ sessionRef: 'cs_test_a1b2', checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_a1b2', expiresAt: new Date(1781000000 * 1000) });
    expect(gateway.isTest).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers).toMatchObject({ authorization: 'Bearer sk_test_123', 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': 'checkout-pay-1' });
    const params = new URLSearchParams(calls[0].body);
    expect(params.get('mode')).toBe('payment');
    expect(params.get('line_items[0][price_data][unit_amount]')).toBe('30500');
    expect(params.get('line_items[0][price_data][currency]')).toBe('aed');
    expect(params.get('line_items[0][price_data][product_data][name]')).toBe('Invoice INV-000001');
    expect(params.get('client_reference_id')).toBe('pay-1');
    expect(params.get('metadata[paymentId]')).toBe('pay-1');
    expect(params.get('payment_intent_data[metadata][reference]')).toBe('pay-1');
    expect(params.get('success_url')).toBe('https://portal.example/ok');
    // No card data is ever sent by us.
    expect(calls[0].body).not.toMatch(/card|number|cvc/i);
  });

  it('surfaces Stripe errors with their message', async () => {
    const gateway = new StripeGateway({ secretKey: 'sk_live_x' }, fakeFetch({ status: 401, json: { error: { message: 'Invalid API Key provided', type: 'invalid_request_error' } } }));
    expect(gateway.isTest).toBe(false);
    await expect(gateway.refund({ reference: 'r1', paymentRef: 'pi_1', amount: '10.00', currency: 'AED' })).rejects.toMatchObject({ message: 'Invalid API Key provided', statusCode: 401 });
    const down = new StripeGateway({ secretKey: 'sk_test_x' }, async () => {
      throw new Error('connect ETIMEDOUT');
    });
    await expect(down.getRefund('re_1')).rejects.toBeInstanceOf(GatewayError);
  });

  it('refunds by payment intent with an idempotency key and maps the status', async () => {
    const gateway = new StripeGateway({ secretKey: 'sk_test_123' }, fakeFetch({ status: 200, json: { id: 're_3Pabc', status: 'succeeded' } }));
    expect(await gateway.refund({ reference: 'refund-uuid', paymentRef: 'pi_3Pxyz', amount: '152.50', currency: 'AED', reason: 'x' })).toEqual({ refundRef: 're_3Pabc', status: 'COMPLETED', failureReason: null });
    const params = new URLSearchParams(calls[0].body);
    expect(calls[0].url).toBe('https://api.stripe.com/v1/refunds');
    expect(params.get('payment_intent')).toBe('pi_3Pxyz');
    expect(params.get('amount')).toBe('15250');
    expect(calls[0].headers['idempotency-key']).toBe('refund-refund-uuid');
    const pending = new StripeGateway({ secretKey: 'sk_test_123' }, fakeFetch({ status: 200, json: { id: 're_1', status: 'pending' } }));
    expect((await pending.getRefund('re_1')).status).toBe('PENDING');
    const failed = new StripeGateway({ secretKey: 'sk_test_123' }, fakeFetch({ status: 200, json: { id: 're_1', status: 'failed', failure_reason: 'insufficient_funds' } }));
    expect(await failed.getRefund('re_1')).toMatchObject({ status: 'FAILED', failureReason: 'insufficient_funds' });
  });

  it('verifies the Stripe-Signature header with a locally computed signature and normalises the event', () => {
    const gateway = new StripeGateway({ secretKey: 'sk_test_123', webhookSecret: SECRET });
    const body = event();
    const parsed = gateway.verifyWebhook(body, { 'stripe-signature': signTimestamped(body, SECRET) });
    expect(parsed).toMatchObject({ id: 'evt_1PabcDEF', type: 'payment.succeeded', rawType: 'checkout.session.completed', sessionRef: 'cs_test_a1b2', paymentRef: 'pi_3Pxyz', amount: '305.00', currency: 'AED', metadata: { paymentId: 'pay-1', tenantId: 'ten-1' } });
    expect(reason(() => gateway.verifyWebhook(body, { 'stripe-signature': signTimestamped(body, 'whsec_wrong') }))).toBe('SIGNATURE_MISMATCH');
    expect(reason(() => gateway.verifyWebhook(body, {}))).toBe('MISSING_SIGNATURE');
    expect(reason(() => gateway.verifyWebhook(body, { 'stripe-signature': signTimestamped(body, SECRET, Math.floor(Date.now() / 1000) - 4000) }))).toBe('TIMESTAMP_OUT_OF_TOLERANCE');
    expect(reason(() => new StripeGateway({ secretKey: 'sk_test_123' }).verifyWebhook(body, { 'stripe-signature': signTimestamped(body, SECRET) }))).toBe('NO_SECRET');
    const notJson = Buffer.from('not json');
    expect(reason(() => gateway.verifyWebhook(notJson, { 'stripe-signature': signTimestamped(notJson, SECRET) }))).toBe('MALFORMED_PAYLOAD');
  });

  it('maps event types: unpaid completion waits, async results and expiry decide', () => {
    const gateway = new StripeGateway({ secretKey: 'sk_test_123', webhookSecret: SECRET });
    const parse = (body: Buffer) => gateway.verifyWebhook(body, { 'stripe-signature': signTimestamped(body, SECRET) });
    expect(parse(event({ payment_status: 'unpaid' })).type).toBe('ignored');
    expect(parse(event({}, 'checkout.session.async_payment_succeeded')).type).toBe('payment.succeeded');
    expect(parse(event({}, 'checkout.session.async_payment_failed'))).toMatchObject({ type: 'payment.failed' });
    expect(parse(event({}, 'checkout.session.expired')).failureReason).toMatch(/expired/);
    expect(parse(event({ object: 'charge' }, 'charge.succeeded'))).toMatchObject({ type: 'ignored', sessionRef: null });
    expect(parse(event({ payment_intent: { id: 'pi_obj' } })).paymentRef).toBe('pi_obj');
  });

  it('peeks the session reference without trusting it', () => {
    expect(StripeGateway.peek(event())).toEqual({ sessionRef: 'cs_test_a1b2', paymentRef: 'pi_3Pxyz' });
    expect(StripeGateway.peek(event({ object: 'charge' }))).toBeNull();
    expect(StripeGateway.peek(Buffer.from('nope'))).toBeNull();
  });
});

describe('SandboxGateway (TEST adapter)', () => {
  const gateway = new SandboxGateway();
  const request = { channel: 'payments' as const, reference: 'pay-1', amount: '305.00', currency: 'AED', description: 'Invoice INV-000001', successUrl: 'http://localhost:3002/ok', cancelUrl: 'http://localhost:3002/cancel', metadata: { paymentId: 'pay-1' } };

  it('creates a signed, self-describing session on our own API', async () => {
    const session = await gateway.createCheckout(request);
    expect(gateway.isTest).toBe(true);
    expect(session.checkoutUrl).toBe(`http://localhost:4000/api/v1/public/payments/sandbox/checkout/${session.sessionRef}`);
    expect(decodeSandboxSession(session.sessionRef)).toMatchObject({ channel: 'payments', reference: 'pay-1', amount: '305.00', currency: 'AED', successUrl: 'http://localhost:3002/ok', metadata: { paymentId: 'pay-1' } });
    // A session cannot be forged or edited.
    expect(decodeSandboxSession(`${session.sessionRef.slice(0, -3)}abc`)).toBeNull();
    expect(decodeSandboxSession('sbx_cs_anything')).toBeNull();
  });

  it('signs its webhooks so that only the configured secret verifies them', async () => {
    const session = await gateway.createCheckout(request);
    const hook = buildSandboxWebhook(session.sessionRef, 'succeeded');
    const event = gateway.verifyWebhook(Buffer.from(hook.body), hook.headers);
    expect(event).toMatchObject({ id: hook.eventId, type: 'payment.succeeded', sessionRef: session.sessionRef, paymentRef: sandboxPaymentRef(session.sessionRef), amount: '305.00', currency: 'AED', metadata: { paymentId: 'pay-1' } });
    const failed = buildSandboxWebhook(session.sessionRef, 'failed', { reason: 'Declined' });
    expect(gateway.verifyWebhook(Buffer.from(failed.body), failed.headers)).toMatchObject({ type: 'payment.failed', failureReason: 'Declined', paymentRef: null });
    const forged = buildSandboxWebhook(session.sessionRef, 'succeeded', { secret: 'guess' });
    expect(reason(() => gateway.verifyWebhook(Buffer.from(forged.body), forged.headers))).toBe('SIGNATURE_MISMATCH');
    expect(reason(() => gateway.verifyWebhook(Buffer.from(hook.body.replace('305.00', '1.00')), hook.headers))).toBe('SIGNATURE_MISMATCH');
    expect(SandboxGateway.peek(Buffer.from(hook.body))).toEqual({ sessionRef: session.sessionRef, paymentRef: sandboxPaymentRef(session.sessionRef) });
  });

  it('refunds succeed, except with the documented failure switch', async () => {
    expect(await gateway.refund({ reference: 'r1', paymentRef: 'sbx_pi_1', amount: '5.00', currency: 'AED' })).toMatchObject({ status: 'COMPLETED' });
    expect((await gateway.refund({ reference: 'r1', paymentRef: 'sbx_pi_1', amount: '5.00', currency: 'AED' })).refundRef).toBe((await gateway.refund({ reference: 'r1', paymentRef: 'sbx_pi_1', amount: '5.00', currency: 'AED' })).refundRef);
    expect(await gateway.refund({ reference: 'r2', paymentRef: 'sbx_pi_1', amount: '5.00', currency: 'AED', reason: 'test [sandbox:fail]' })).toMatchObject({ status: 'FAILED' });
  });
});

describe('idempotency request hash', () => {
  it('ignores key order and undefined values, but not content', () => {
    expect(stableStringify({ b: 1, a: [{ y: 2, x: 1 }], c: undefined })).toBe('{"a":[{"x":1,"y":2}],"b":1}');
    expect(requestHash({ amount: '10.00', method: 'CASH' })).toBe(requestHash({ method: 'CASH', amount: '10.00' }));
    expect(requestHash({ amount: '10.00' })).not.toBe(requestHash({ amount: '10.01' }));
    expect(requestHash({ a: null })).toBe(requestHash({ a: null }));
  });
});

describe('card number detection', () => {
  it('flags Luhn-valid card numbers in free text and leaves ordinary references alone', () => {
    expect(looksLikeCardNumber('card 4242 4242 4242 4242')).toBe(true);
    expect(looksLikeCardNumber('5555-5555-5555-4444')).toBe(true);
    expect(looksLikeCardNumber('378282246310005')).toBe(true);
    expect(looksLikeCardNumber('Approval 123456, slip 0098')).toBe(false);
    expect(looksLikeCardNumber('TRF-2026-000188213')).toBe(false);
    expect(looksLikeCardNumber('1234 5678 9012 3456')).toBe(false); // fails the Luhn check
    expect(looksLikeCardNumber(null)).toBe(false);
  });
});
