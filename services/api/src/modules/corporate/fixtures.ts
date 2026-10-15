import { Actor, PASSWORD, TenantFixture, TestApp, uniq } from '../../../test/helpers';

/** Test fixtures for the corporate module. Everything goes through the real API unless noted. */

const digits = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
export const emiratesId = () => `784${digits(12)}`;
export const passport = () => `N${digits(8)}`;

export function accountBody(over: Record<string, unknown> = {}) {
  const id = uniq();
  return { companyName: `Company ${id} LLC`, tradeLicenceNo: `TL-${id}`.toUpperCase(), billingEmail: `accounts-${id}@example.test`, ...over };
}

export async function createAccount(t: TestApp, tenant: TenantFixture, over: Record<string, unknown> = {}) {
  const res = await t.as(tenant.owner).post('/corporate-accounts', accountBody(over));
  if (res.status !== 201) throw new Error(`createAccount failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; accountNo: string; companyName: string; status: string; [k: string]: any };
}

/** A company that the centre has verified (status ACTIVE). */
export async function activeAccount(t: TestApp, tenant: TenantFixture, over: Record<string, unknown> = {}) {
  const account = await createAccount(t, tenant, over);
  const res = await t.as(tenant.owner).post(`/corporate-accounts/${account.id}/verify`, { note: 'Trade licence and authorisation letter checked' });
  if (res.status !== 200) throw new Error(`verify failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as typeof account;
}

/** Invites an authorised contact as staff, accepts the invitation and signs in to the corporate portal. */
export async function addCorporateAdmin(t: TestApp, tenant: TenantFixture, accountId: string, email = `corp-admin-${uniq()}@example.test`): Promise<Actor & { memberId: string }> {
  const invite = await t.as(tenant.owner).post(`/corporate-accounts/${accountId}/members`, { fullName: 'Corporate Admin', email, isAuthorisedSignatory: true });
  if (invite.status !== 201) throw new Error(`member invite failed: ${invite.status} ${JSON.stringify(invite.body)}`);
  const accept = await t.http.post('/api/v1/auth/invitations/accept').send({ token: invite.body.dev.invitationToken, password: PASSWORD, app: 'corporate' });
  if (accept.status !== 200 || accept.body.status !== 'OK') throw new Error(`accept failed: ${accept.status} ${JSON.stringify(accept.body)}`);
  return { ...(await t.login(email, PASSWORD, 'corporate', tenant.slug)), memberId: invite.body.id };
}

/** A signed-in user with the corporate_employee role (no corp.* permissions) that is not linked to an employee record yet. Rows are created directly; the real invitation flow is covered in corporate.logins.spec.ts. */
export async function addCorporateEmployeeLogin(t: TestApp, tenant: TenantFixture, accountId: string): Promise<Actor> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy on purpose: auth.service pulls in the whole auth module graph; loading it only when the fixture runs keeps spec-file load order unchanged
  const { hashPassword } = require('../auth/auth.service');
  const email = `corp-emp-${uniq()}@example.test`;
  const user = await t.sys.user.create({ data: { email, fullName: 'Employee Login', passwordHash: await hashPassword(PASSWORD), emailVerifiedAt: new Date() } });
  const role = await t.sys.role.findFirstOrThrow({ where: { tenantId: tenant.id, key: 'corporate_employee' } });
  await t.sys.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id, roleId: role.id, kind: 'CORPORATE', status: 'ACTIVE', corporateAccountId: accountId, allBranches: true, joinedAt: new Date() } });
  return t.login(email, PASSWORD, 'corporate', tenant.slug);
}

export function employeeBody(over: Record<string, unknown> = {}) {
  const id = uniq();
  return { fullName: `Employee ${id}`, email: `emp-${id}@example.test`, passportNo: passport(), passportCountry: 'IN', nationality: 'IN', employeeNo: `E-${id}`, designation: 'Technician', ...over };
}

export async function seedService(t: TestApp, tenant: TenantFixture, serviceFee = '100.00') {
  const category = await t.sys.serviceCategory.findFirstOrThrow({ where: { tenantId: tenant.id, key: 'typing' } });
  const service = await t.sys.service.create({ data: { tenantId: tenant.id, categoryId: category.id, code: `SVC-${uniq()}`.toUpperCase().slice(0, 30), name: `Service ${uniq()}` } });
  await t.sys.servicePrice.create({ data: { tenantId: tenant.id, serviceId: service.id, serviceFee, governmentFeeEstimate: '50.00' } });
  return service;
}
