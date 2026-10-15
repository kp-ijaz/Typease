import type { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { uniq } from '../../../test/helpers';
import { BillingClock } from './billing-clock';
import { SubscriptionLifecycle } from './lifecycle.service';

/** Test fixtures for SaaS billing. Time is moved with the injectable BillingClock, never by sleeping. */
export const DAY = 86_400_000;
export const clockOf = (t: TestApp) => t.get(BillingClock);
export const lifecycleOf = (t: TestApp) => t.get(SubscriptionLifecycle);

export const subOf = (t: TestApp, tenantId: string) => t.sys.subscription.findUniqueOrThrow({ where: { tenantId }, include: { plan: true, pendingPlan: true, coupon: true } });
export const tenantOf = (t: TestApp, tenantId: string) => t.sys.tenant.findUniqueOrThrow({ where: { id: tenantId } });
export const invoicesOf = (t: TestApp, tenantId: string) => t.sys.subscriptionInvoice.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } });
export const openInvoiceOf = async (t: TestApp, tenantId: string) => {
  const open = await t.sys.subscriptionInvoice.findMany({ where: { tenantId, status: 'OPEN' }, orderBy: { createdAt: 'desc' } });
  if (open.length !== 1) throw new Error(`expected exactly one open subscription invoice, found ${open.length}`);
  return open[0];
};
export const eventsOf = async (t: TestApp, tenantId: string, type?: string) =>
  t.sys.subscriptionEvent.findMany({ where: { tenantId, ...(type ? { type } : {}) }, orderBy: { createdAt: 'asc' } });
export const outboxOf = (t: TestApp, tenantId: string, type: string) => t.sys.outboxEvent.findMany({ where: { tenantId, type }, orderBy: { createdAt: 'asc' } });

/** A centre that has just signed up and has not chosen a plan yet. */
export function signedUpTenant(t: TestApp, name?: string) {
  return t.createTenant({ plan: null, status: 'ONBOARDING', name });
}

/** Finishes onboarding through the real endpoint (a service is the one remaining required step). */
export async function completeOnboarding(t: TestApp, tenant: TenantFixture) {
  const category = await t.sys.serviceCategory.findFirstOrThrow({ where: { tenantId: tenant.id } });
  await t.sys.service.create({ data: { tenantId: tenant.id, categoryId: category.id, code: `SVC-${uniq()}`.toUpperCase(), name: 'Typing' } });
  const res = await t.as(tenant.owner).post('/onboarding/complete');
  if (res.status !== 200) throw new Error(`onboarding completion failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { status: string };
}

/** Puts an existing subscription on exact dates so proration and lifecycle maths are deterministic. */
export function setPeriod(t: TestApp, tenantId: string, start: Date, end: Date, extra: Record<string, unknown> = {}) {
  return t.sys.subscription.update({ where: { tenantId }, data: { currentPeriodStart: start, currentPeriodEnd: end, ...extra } });
}

/** Pays a subscription invoice through the sandbox gateway: checkout -> signed webhook -> our subscription webhook route. */
export async function paySandbox(t: TestApp, owner: Actor, invoiceId: string) {
  const start = await t.as(owner).post(`/subscription/invoices/${invoiceId}/pay`);
  if (start.status !== 201) throw new Error(`pay failed: ${start.status} ${JSON.stringify(start.body)}`);
  const done = await t.http.post(`${new URL(start.body.checkoutUrl).pathname}/complete`);
  if (done.status !== 200 || done.body.webhook?.status !== 200) throw new Error(`sandbox completion failed: ${done.status} ${JSON.stringify(done.body)}`);
  return { start: start.body, done: done.body };
}

export const couponCode = (prefix = 'SAVE') => `${prefix}${uniq()}`.toUpperCase();
