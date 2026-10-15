import { TenantFixture, TestApp } from './helpers';

/** Custom roles: a role can be deleted once nobody holds it any more - people who left do not count. */
describe('custom roles: deletion', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
  });
  afterAll(() => t.close());

  const createRole = async (key: string) => (await t.as(alpha.owner).post('/roles', { key, name: `Role ${key}`, permissions: ['customer.read', 'request.read.all'] }).expect(201)).body as { id: string; key: string };

  it('a role whose only members were removed can be deleted; their history rows move to a built-in role', async () => {
    const role = await createRole('night_shift');
    const first = await t.addStaff(alpha, 'night_shift');
    const second = await t.addStaff(alpha, 'night_shift');

    // While somebody still holds it: refused.
    expect((await t.as(alpha.owner).delete(`/roles/${role.id}`).expect(409)).body.code).toBe('ROLE_IN_USE');
    await t.as(alpha.owner).delete(`/staff/${first.membershipId}`).expect(200);
    expect((await t.as(alpha.owner).delete(`/roles/${role.id}`).expect(409)).body.code).toBe('ROLE_IN_USE');
    await t.as(alpha.owner).delete(`/staff/${second.membershipId}`).expect(200);
    expect((await t.sys.tenantMembership.findMany({ where: { roleId: role.id } })).map((m) => m.status)).toEqual(['REMOVED', 'REMOVED']);

    // Only people who left are on it now: it goes.
    expect((await t.as(alpha.owner).delete(`/roles/${role.id}`).expect(200)).body).toEqual({ status: 'DELETED' });
    expect(await t.sys.role.findUnique({ where: { id: role.id } })).toBeNull();
    expect(await t.sys.rolePermission.count({ where: { roleId: role.id } })).toBe(0);
    // The membership rows of the people who left are kept (history), parked on a built-in staff role, still REMOVED.
    const parked = await t.sys.tenantMembership.findMany({ where: { id: { in: [first.membershipId!, second.membershipId!] } }, include: { role: true } });
    expect(parked.map((m) => [m.status, m.role.key, m.role.isSystem, m.tenantId]).sort()).toEqual([['REMOVED', 'receptionist', true, alpha.id], ['REMOVED', 'receptionist', true, alpha.id]]);
    // They did not get anything back by this: no sign-in, no permission.
    await t.as(first).get('/customers').expect(401);
    const audit = await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: alpha.id, action: 'role.deleted', resourceId: role.id } });
    expect(audit).toMatchObject({ actorUserId: alpha.owner.userId, before: { key: 'night_shift' } });
    expect((await t.as(alpha.owner).get('/roles').expect(200)).body.map((r: any) => r.key)).not.toContain('night_shift');
    // The key is free again.
    await createRole('night_shift');
  });

  it('a role that was only ever offered in an invitation that was withdrawn can be deleted too', async () => {
    const role = await createRole('temp_helper');
    const invited = await t.as(alpha.owner).post('/staff/invitations', { email: `helper-${Date.now()}@example.test`, fullName: 'Temp Helper', roleKey: 'temp_helper', allBranches: true });
    expect([200, 201]).toContain(invited.status);
    const membershipId = invited.body.membershipId ?? invited.body.id;
    expect((await t.as(alpha.owner).delete(`/roles/${role.id}`).expect(409)).body.code).toBe('ROLE_IN_USE');
    await t.as(alpha.owner).delete(`/staff/${membershipId}`).expect(200);
    await t.as(alpha.owner).delete(`/roles/${role.id}`).expect(200);
    expect(await t.sys.role.findUnique({ where: { id: role.id } })).toBeNull();
  });

  it('roles of another centre stay out of reach', async () => {
    const role = await createRole('alpha_only');
    await t.as(beta.owner).delete(`/roles/${role.id}`).expect(404);
    await t.as(beta.owner).patch(`/roles/${role.id}`, { name: 'Hijacked' }).expect(404);
    expect(await t.sys.role.findUnique({ where: { id: role.id } })).not.toBeNull();
  });
});

/** Every role of a centre - built-in, custom, staff and portal - is the owner's to change. */
describe('roles: the owner manages all of them', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  const role = async (key: string) => t.sys.role.findFirstOrThrow({ where: { tenantId: alpha.id, key, corporateAccountId: null }, include: { rolePermissions: true } });
  const perms = async (key: string) => (await role(key)).rolePermissions.map((p) => p.permissionKey).sort();

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
  });
  afterAll(() => t.close());

  it('only the owner: not a manager, and not a custom role that was given "manage roles"', async () => {
    const manager = await t.addStaff(alpha, 'manager');
    const operator = await role('operator');
    expect((await t.as(manager).patch(`/roles/${operator.id}`, { name: 'Typist' }).expect(403)).body.code).toBeDefined();
    await t.as(alpha.owner).post('/roles', { key: 'deputy', name: 'Deputy', permissions: ['role.manage', 'staff.read'] }).expect(201);
    const deputy = await t.addStaff(alpha, 'deputy');
    expect((await t.as(deputy).patch(`/roles/${operator.id}`, { name: 'Typist' }).expect(403)).body.code).toBe('OWNER_ONLY');
    expect((await t.as(deputy).post('/roles', { key: 'mine', name: 'Mine', permissions: [] }).expect(403)).body.code).toBe('OWNER_ONLY');
    expect((await t.as(deputy).delete(`/roles/${operator.id}`).expect(403)).body.code).toBe('OWNER_ONLY');
  });

  it('a built-in staff role can be renamed and given other permissions', async () => {
    const operator = await role('operator');
    const before = await perms('operator');
    const next = [...before.filter((p) => p !== 'request.read.assigned'), 'report.operational'];
    const res = (await t.as(alpha.owner).patch(`/roles/${operator.id}`, { name: 'Typist', description: 'Types the applications', permissions: next }).expect(200)).body;
    expect(res).toMatchObject({ name: 'Typist', isSystem: true });
    expect(await perms('operator')).toEqual([...next].sort());
    const listed = (await t.as(alpha.owner).get('/roles').expect(200)).body.find((r: { id: string }) => r.id === operator.id);
    expect(listed).toMatchObject({ name: 'Typist', canDelete: true, permissionsFixed: false });
    expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'role.updated', resourceId: operator.id } })).toBe(1);
  });

  it('a built-in staff role nobody holds can be deleted; the owner role never', async () => {
    const reviewer = await role('reviewer');
    const held = await t.addStaff(alpha, 'reviewer');
    expect((await t.as(alpha.owner).delete(`/roles/${reviewer.id}`).expect(409)).body.code).toBe('ROLE_IN_USE');
    await t.as(alpha.owner).delete(`/staff/${held.membershipId}`).expect(200);
    await t.as(alpha.owner).delete(`/roles/${reviewer.id}`).expect(200);
    expect(await t.sys.role.findUnique({ where: { id: reviewer.id } })).toBeNull();
    // The person who left is parked on another built-in role, still removed.
    expect(await t.sys.tenantMembership.findUniqueOrThrow({ where: { id: held.membershipId! }, include: { role: true } })).toMatchObject({ status: 'REMOVED', role: { key: 'receptionist' } });

    const owner = await role('owner');
    expect((await t.as(alpha.owner).delete(`/roles/${owner.id}`).expect(409)).body.code).toBe('ROLE_LOCKED');
    const all = await perms('owner');
    expect((await t.as(alpha.owner).patch(`/roles/${owner.id}`, { permissions: all.filter((p) => p !== 'role.manage') }).expect(409)).body.code).toBe('PERMISSIONS_FIXED');
    await t.as(alpha.owner).patch(`/roles/${owner.id}`, { name: 'Managing partner', permissions: all }).expect(200);
    expect(await perms('owner')).toEqual(all);
  });

  it('portal roles can be edited within their own permissions, but not deleted', async () => {
    const customer = await role('customer');
    expect((await t.as(alpha.owner).get('/roles/permissions').query({ kind: 'CUSTOMER' }).expect(200)).body.every((p: { key: string }) => p.key.startsWith('self.'))).toBe(true);
    expect((await t.as(alpha.owner).patch(`/roles/${customer.id}`, { permissions: [...(await perms('customer')), 'invoice.read'] }).expect(400)).body.code).toBe('UNKNOWN_PERMISSION');
    const fewer = (await perms('customer')).filter((p) => p !== 'self.appointments');
    await t.as(alpha.owner).patch(`/roles/${customer.id}`, { name: 'Client', permissions: fewer }).expect(200);
    expect(await perms('customer')).toEqual(fewer);
    expect((await t.as(alpha.owner).delete(`/roles/${customer.id}`).expect(409)).body.code).toBe('ROLE_REQUIRED');

    const companyEmployee = await role('corporate_employee');
    await t.as(alpha.owner).patch(`/roles/${companyEmployee.id}`, { permissions: [...(await perms('corporate_employee')), 'corp.requests.read'] }).expect(200);
    const companyAdmin = await role('corporate_admin');
    expect((await t.as(alpha.owner).patch(`/roles/${companyAdmin.id}`, { permissions: ['corp.account.read'] }).expect(409)).body.code).toBe('PERMISSIONS_FIXED');
  });
});
