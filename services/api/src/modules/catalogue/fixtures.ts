import { Actor, PASSWORD, TenantFixture, TestApp, uniq } from '../../../test/helpers';

/** Test fixtures for the catalogue module (and for modules that need a service to hang things off). */

export async function categoryId(t: TestApp, tenant: TenantFixture, key = 'typing'): Promise<string> {
  return (await t.sys.serviceCategory.findFirstOrThrow({ where: { tenantId: tenant.id, key } })).id;
}

export function serviceBody(categoryIdValue: string, over: Record<string, unknown> = {}) {
  return {
    categoryId: categoryIdValue,
    code: `SVC-${uniq().toUpperCase()}`.slice(0, 30),
    name: 'Tenancy contract typing',
    nameAr: 'طباعة عقد الإيجار',
    description: 'Typing of a tenancy contract from the details you provide.',
    price: { serviceFee: '100.00', governmentFeeEstimate: '0', thirdPartyFeeEstimate: '0' },
    ...over,
  };
}

/** Creates a service through the API as the tenant owner and returns the response body. */
export async function createService(t: TestApp, tenant: TenantFixture, over: Record<string, unknown> = {}) {
  const res = await t.as(tenant.owner).post('/services', serviceBody(await categoryId(t, tenant), over));
  if (res.status !== 201) throw new Error(`createService failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; code: string; name: string; version: number; [k: string]: any };
}

export async function createCorporateAccount(t: TestApp, tenant: TenantFixture, companyName = `Company ${uniq()}`) {
  return t.sys.corporateAccount.create({ data: { tenantId: tenant.id, accountNo: `CORP-${uniq()}`, companyName, status: 'ACTIVE' } });
}

/** A signed-in corporate administrator of one company (rows created directly; the invitation flow is tested in the corporate module). */
export async function addCorporateUser(t: TestApp, tenant: TenantFixture, corporateAccountId: string, roleKey = 'corporate_admin'): Promise<Actor> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy on purpose: auth.service pulls in the whole auth module graph; loading it only when the fixture runs keeps spec-file load order unchanged
  const { hashPassword } = require('../auth/auth.service');
  const email = `corp-${uniq()}@example.test`;
  const user = await t.sys.user.create({ data: { email, fullName: 'Corporate User', passwordHash: await hashPassword(PASSWORD), emailVerifiedAt: new Date() } });
  const role = await t.sys.role.findFirstOrThrow({ where: { tenantId: tenant.id, key: roleKey } });
  await t.sys.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id, roleId: role.id, kind: 'CORPORATE', status: 'ACTIVE', corporateAccountId, allBranches: true, joinedAt: new Date() } });
  return t.login(email, PASSWORD, 'corporate', tenant.slug);
}

export const simpleForm = (over: Record<string, unknown> = {}) => ({
  steps: [
    {
      key: 'details',
      title: 'Details',
      fields: [
        { key: 'tenantName', label: 'Tenant name', type: 'text', required: true, prefillFrom: 'customer.fullName' },
        { key: 'propertyType', label: 'Property type', type: 'select', required: true, options: [{ value: 'apartment', label: 'Apartment' }, { value: 'villa', label: 'Villa' }] },
        { key: 'villaPlot', label: 'Plot number', type: 'text', showIf: { field: 'propertyType', in: ['villa'] } },
      ],
    },
  ],
  ...over,
});
