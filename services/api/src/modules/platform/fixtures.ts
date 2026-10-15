import type { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { uniq } from '../../../test/helpers';

/** Test fixtures for the platform module. Only used by specs. */

export const tenantRow = (t: TestApp, id: string) => t.sys.tenant.findUniqueOrThrow({ where: { id } });
export const subscriptionRow = (t: TestApp, tenantId: string) => t.sys.subscription.findUnique({ where: { tenantId }, include: { plan: true } });

/** Audit entries about one centre on the platform trail (tenantId NULL) and on the centre's own trail. */
export async function auditOf(t: TestApp, action: string, resourceId: string) {
  const rows = await t.sys.auditLog.findMany({ where: { action, resourceId }, orderBy: { createdAt: 'asc' } });
  return { platform: rows.filter((r) => r.tenantId === null), centre: rows.filter((r) => r.tenantId !== null) };
}

/** Body for POST /platform/tenants. */
export function newCentre(over: Record<string, unknown> = {}) {
  const id = uniq();
  return { businessName: `Invited Centre ${id}`, slug: `inv-${id}`, ownerName: `Owner ${id}`, ownerEmail: `invited-owner-${id}@example.test`, ...over };
}

/** A platform staff member asks a centre for access; returns the grant as the API reports it. */
export async function requestAccess(t: TestApp, staff: Actor, tenant: { id: string }, scopes: string[], over: Record<string, unknown> = {}) {
  const res = await t.as(staff).post(`/platform/tenants/${tenant.id}/access-grants`, { reason: 'Investigating support ticket about missing invoices', scopes, durationMinutes: 30, ...over });
  if (res.status !== 201) throw new Error(`access request failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; status: string; scopes: string[]; [k: string]: any };
}

/** Request + approval by the centre's owner + entering: returns an Actor that carries the support session. */
export async function supportSession(t: TestApp, staff: Actor, tenant: TenantFixture, scopes: string[], over: Record<string, unknown> = {}): Promise<{ grantId: string; support: Actor; refreshToken: string }> {
  const grant = await requestAccess(t, staff, tenant, scopes, over);
  const approved = await t.as(tenant.owner).post(`/support-access/${grant.id}/approve`, {});
  if (approved.status !== 200) throw new Error(`approval failed: ${approved.status} ${JSON.stringify(approved.body)}`);
  const entered = await t.as(staff).post(`/platform/access-grants/${grant.id}/enter`);
  if (entered.status !== 200) throw new Error(`enter failed: ${entered.status} ${JSON.stringify(entered.body)}`);
  return { grantId: grant.id, refreshToken: entered.body.refreshToken, support: { token: entered.body.accessToken, userId: staff.userId, email: staff.email, membershipId: null, customerId: null, roleKey: null } };
}
