import { randomUUID } from 'node:crypto';
import type { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { PASSWORD, uniq } from '../../../test/helpers';
import { encryptJson } from '../../common/crypto';
import { hashPassword } from '../auth/auth.service';
import { buildSandboxWebhook } from './gateways/sandbox.gateway';

/**
 * Test fixtures for the finance module. Rows owned by other modules (customers,
 * services, requests, corporate accounts, integrations) are created directly in
 * the database, as the workstream rules require.
 */

export const key = () => randomUUID();

/**
 * Keeps the HTTP server listening for the whole spec file. Without this supertest opens and
 * closes a listener per request, which makes concurrent requests (and the sandbox gateway's
 * loopback webhook delivery) race against the listener being closed.
 */
export async function listen(t: TestApp): Promise<TestApp> {
  // TestApp.create() already listens on an ephemeral port; kept for call-site compatibility.
  return t;
}

export async function createCustomer(t: TestApp, tenant: TenantFixture, opts: { fullName?: string; corporateAccountId?: string | null } = {}) {
  return t.sys.customer.create({
    data: { tenantId: tenant.id, customerNo: `CUS-${uniq()}`, fullName: opts.fullName ?? 'Walk-in Customer', email: `c-${uniq()}@example.test`, corporateAccountId: opts.corporateAccountId ?? null },
  });
}

export async function createService(
  t: TestApp,
  tenant: TenantFixture,
  opts: { name?: string; taxMode?: 'SERVICE_FEE_ONLY' | 'ALL_COMPONENTS' | 'NONE'; serviceFee?: string; governmentFee?: string; thirdPartyFee?: string; branchPrices?: Array<{ branchId: string; serviceFee: string; governmentFee?: string; thirdPartyFee?: string }>; noPrice?: boolean } = {},
) {
  const category = await t.sys.serviceCategory.findFirstOrThrow({ where: { tenantId: tenant.id } });
  const service = await t.sys.service.create({
    data: { tenantId: tenant.id, categoryId: category.id, code: `SVC-${uniq()}`.toUpperCase(), name: opts.name ?? 'Visa typing', taxMode: opts.taxMode ?? 'SERVICE_FEE_ONLY' },
  });
  if (!opts.noPrice) {
    await t.sys.servicePrice.create({
      data: { tenantId: tenant.id, serviceId: service.id, branchId: null, serviceFee: opts.serviceFee ?? '100.00', governmentFeeEstimate: opts.governmentFee ?? '200.00', thirdPartyFeeEstimate: opts.thirdPartyFee ?? '0', validFrom: new Date(Date.now() - 86_400_000) },
    });
  }
  for (const bp of opts.branchPrices ?? []) {
    await t.sys.servicePrice.create({
      data: { tenantId: tenant.id, serviceId: service.id, branchId: bp.branchId, serviceFee: bp.serviceFee, governmentFeeEstimate: bp.governmentFee ?? '0', thirdPartyFeeEstimate: bp.thirdPartyFee ?? '0', validFrom: new Date(Date.now() - 86_400_000) },
    });
  }
  return service;
}

export async function createRequest(
  t: TestApp,
  tenant: TenantFixture,
  opts: { customerId: string; serviceId: string; branchId?: string; corporateAccountId?: string | null; assignedToId?: string | null; status?: string },
) {
  return t.sys.serviceRequest.create({
    data: {
      tenantId: tenant.id,
      branchId: opts.branchId ?? tenant.headOfficeId,
      requestNo: `TE-${uniq()}`.toUpperCase(),
      customerId: opts.customerId,
      serviceId: opts.serviceId,
      corporateAccountId: opts.corporateAccountId ?? null,
      assignedToId: opts.assignedToId ?? null,
      status: (opts.status as any) ?? 'SUBMITTED',
    },
  });
}

export async function createCorporate(t: TestApp, tenant: TenantFixture, opts: { creditApproved?: boolean; creditLimit?: string | null; paymentTermsDays?: number; companyName?: string } = {}) {
  return t.sys.corporateAccount.create({
    data: {
      tenantId: tenant.id,
      accountNo: `CORP-${uniq()}`.toUpperCase(),
      companyName: opts.companyName ?? `Gulf Trading ${uniq()} LLC`,
      status: 'ACTIVE',
      creditApproved: opts.creditApproved ?? false,
      creditLimit: opts.creditLimit ?? null,
      paymentTermsDays: opts.paymentTermsDays ?? 0,
    },
  });
}

/** A signed-in corporate administrator of one company. */
export async function addCorporateAdmin(t: TestApp, tenant: TenantFixture, corporateAccountId: string): Promise<Actor> {
  const email = `corp-${uniq()}@example.test`;
  const user = await t.sys.user.create({ data: { email, fullName: 'Corporate Admin', passwordHash: await hashPassword(PASSWORD), emailVerifiedAt: new Date() } });
  const role = await t.sys.role.findFirstOrThrow({ where: { tenantId: tenant.id, key: 'corporate_admin' } });
  await t.sys.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id, roleId: role.id, kind: 'CORPORATE', status: 'ACTIVE', corporateAccountId, allBranches: true, joinedAt: new Date() } });
  return t.login(email, PASSWORD, 'corporate', tenant.slug);
}

/** Connects the TEST gateway for a tenant (what Settings > Integrations would do). */
export function enableSandbox(t: TestApp, tenant: TenantFixture) {
  return t.sys.integration.create({ data: { tenantId: tenant.id, category: 'PAYMENT', provider: 'sandbox', name: 'Sandbox (test payments)', status: 'ACTIVE', mode: 'TEST' } });
}
export function enableStripe(t: TestApp, tenant: TenantFixture, secrets: { secretKey: string; webhookSecret: string }) {
  return t.sys.integration.create({
    data: { tenantId: tenant.id, category: 'PAYMENT', provider: 'stripe', name: 'Stripe', status: 'ACTIVE', mode: 'TEST', secretsEnc: encryptJson(secrets), secretKeys: ['secretKey', 'webhookSecret'] },
  });
}

export const line = (component: 'SERVICE_FEE' | 'GOVERNMENT_FEE' | 'THIRD_PARTY_FEE', unitAmount: string, extra: Record<string, unknown> = {}) => ({
  description: component === 'SERVICE_FEE' ? 'Typing service fee' : component === 'GOVERNMENT_FEE' ? 'Government fee' : 'Courier charge',
  component,
  quantity: 1,
  unitAmount,
  ...extra,
});

/** Creates and issues an invoice through the API (service fee taxed at the centre's 5%, pass-through fees untaxed). */
export async function issueInvoice(
  t: TestApp,
  actor: Actor,
  customerId: string,
  opts: { serviceFee?: string; governmentFee?: string; thirdPartyFee?: string; requestId?: string; corporateAccountId?: string; branchId?: string } = {},
) {
  const items = [line('SERVICE_FEE', opts.serviceFee ?? '100.00')];
  if (opts.governmentFee !== '0') items.push(line('GOVERNMENT_FEE', opts.governmentFee ?? '200.00'));
  if (opts.thirdPartyFee) items.push(line('THIRD_PARTY_FEE', opts.thirdPartyFee));
  const draft = await t.as(actor).post('/invoices', { customerId, requestId: opts.requestId, corporateAccountId: opts.corporateAccountId, branchId: opts.branchId, items });
  if (draft.status !== 201) throw new Error(`invoice create failed: ${draft.status} ${JSON.stringify(draft.body)}`);
  const issued = await t.as(actor).post(`/invoices/${draft.body.id}/issue`);
  if (issued.status !== 200) throw new Error(`invoice issue failed: ${issued.status} ${JSON.stringify(issued.body)}`);
  return issued.body as { id: string; invoiceNo: string; total: string; balanceDue: string; status: string; [k: string]: any };
}

export function recordPayment(t: TestApp, actor: Actor, body: Record<string, unknown>, idempotencyKey: string = key()) {
  return t.as(actor).post('/payments', body).set('Idempotency-Key', idempotencyKey);
}

/** Posts a sandbox webhook straight to the public endpoint, like the gateway would. */
export function postSandboxWebhook(t: TestApp, hook: { body: string; headers: Record<string, string> }, channel: 'payments' | 'subscriptions' = 'payments') {
  let req = t.http.post(`/api/v1/public/webhooks/${channel}/sandbox`);
  for (const [k, v] of Object.entries(hook.headers)) req = req.set(k, v);
  return req.send(hook.body);
}
export { buildSandboxWebhook };

/** The session reference is the last path segment of the sandbox checkout URL. */
export const sessionRefOf = (checkoutUrl: string) => checkoutUrl.split('/').pop()!;

/** Events of one type written to the outbox for a tenant. */
export async function outbox(t: TestApp, tenantId: string, type: string) {
  return t.sys.outboxEvent.findMany({ where: { tenantId, type }, orderBy: { createdAt: 'asc' } });
}
