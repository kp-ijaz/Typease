import { randomUUID } from 'node:crypto';
import { Actor, TestApp } from '../../services/api/test/helpers';
import { api } from './centre';
import { pathOf } from './http';

export const idempotencyKey = () => randomUUID();

export interface Line {
  component: 'SERVICE_FEE' | 'GOVERNMENT_FEE' | 'THIRD_PARTY_FEE';
  unitAmount: string;
  quantity?: number;
  discountAmount?: string;
  taxRatePercent?: number;
  serviceId?: string;
  description?: string;
}
const describeLine = (l: Line) => l.description ?? (l.component === 'SERVICE_FEE' ? 'Typing service fee' : l.component === 'GOVERNMENT_FEE' ? 'Government fee' : 'Courier charge');

/** Owner adds and enables the test payment gateway in Settings > Integrations (no money moves). */
export async function enableSandboxGateway(t: TestApp, owner: Actor): Promise<void> {
  const gateway = await api(t, owner).post('/integrations', { category: 'PAYMENT', provider: 'sandbox', mode: 'TEST' }, 201);
  const enabled = await api(t, owner).post(`/integrations/${gateway.id}/enable`);
  if (enabled.status !== 'ACTIVE') throw new Error(`The test gateway should be ACTIVE after enabling it, but is ${enabled.status}.`);
}

/** Draft + issue an invoice through the finance API. */
export async function issueInvoice(t: TestApp, actor: Actor, body: { customerId: string; branchId?: string; requestId?: string; corporateAccountId?: string; items: Line[] }) {
  const a = api(t, actor);
  const draft = await a.post('/invoices', { ...body, items: body.items.map((l) => ({ quantity: 1, ...l, description: describeLine(l) })) }, 201);
  return a.post(`/invoices/${draft.id}/issue`);
}

/** A manual payment at the counter, with an idempotency key like the staff app sends. */
export function recordPayment(
  t: TestApp,
  actor: Actor,
  p: { invoiceId: string; amount: string; branchId: string; customerId?: string; method?: 'CASH' | 'CARD_POS' | 'BANK_TRANSFER' | 'CHEQUE'; reference?: string },
  key: string = idempotencyKey(),
) {
  return api(t, actor)
    .with({ 'Idempotency-Key': key })
    .post('/payments', { method: p.method ?? 'CASH', amount: p.amount, branchId: p.branchId, customerId: p.customerId, ...(p.reference ? { reference: p.reference } : {}), allocations: [{ invoiceId: p.invoiceId, amount: p.amount }] }, 201);
}

export interface Checkout {
  paymentId: string;
  paymentNo: string;
  checkoutUrl: string;
  /** Last path segment of the checkout URL: the gateway's session reference. */
  sessionRef: string;
  amount: string;
}

/** The payer opens the hosted checkout for an invoice. Nothing is paid yet. */
export async function startCheckout(t: TestApp, payer: Actor, invoiceId: string, amount?: string): Promise<Checkout> {
  const started = await api(t, payer).post(`/invoices/${invoiceId}/pay`, amount ? { amount } : {}, 201);
  return { ...started, sessionRef: String(started.checkoutUrl).split('/').pop()!.split('?')[0] };
}

/**
 * "Pay" (or decline) on the test gateway's checkout page. The gateway then
 * delivers its signed webhook to the real webhook endpoint over HTTP; the answer
 * says what the webhook endpoint replied.
 */
export async function finishCheckout(t: TestApp, checkout: { checkoutUrl: string }, outcome: 'complete' | 'fail' = 'complete') {
  const res = await t.http.post(`${pathOf(checkout.checkoutUrl)}/${outcome}`).set('Accept', 'application/json').send(outcome === 'fail' ? { reason: 'Declined by the test gateway.' } : {});
  if (res.status !== 200) throw new Error(`POST <sandbox checkout>/${outcome} -> ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { outcome: string; webhook: { eventId: string; delivered: boolean; status: number; response: any } };
}

/** Refund requested by one person and approved (paid out) by another: the only way the API allows. */
export async function refundPayment(
  t: TestApp,
  requester: Actor,
  approver: Actor,
  r: { paymentId: string; invoiceId?: string; amount: string; reason?: string; cancelCharge?: boolean; breakdown?: Record<string, string> },
) {
  const requested = await api(t, requester)
    .with({ 'Idempotency-Key': idempotencyKey() })
    .post('/refunds', { paymentId: r.paymentId, invoiceId: r.invoiceId, amount: r.amount, reason: r.reason ?? 'Customer changed their mind', cancelCharge: r.cancelCharge ?? false, ...(r.breakdown ? { breakdown: r.breakdown } : {}) }, 201);
  const approved = await api(t, approver).post(`/refunds/${requested.id}/approve`, { reference: `Cash returned at the counter, voucher ${requested.refundNo}` });
  if (approved.status !== 'COMPLETED') throw new Error(`The refund ended as ${approved.status}: ${approved.rejectionReason ?? ''}`);
  return approved;
}
