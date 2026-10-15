import { Actor, PASSWORD, TenantFixture, TestApp } from '../../../test/helpers';
import { activeAccount, addCorporateAdmin, addCorporateEmployeeLogin } from './fixtures';

/** A company's own roles in the corporate portal: only its administrator manages them, and nothing reaches another company. */
describe('corporate portal: company roles', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let accountA: { id: string };
  let accountB: { id: string };
  let adminA: Actor;
  let adminA2: Actor & { memberId: string };
  let adminB: Actor;
  let employeeA: Actor;
  let employeeRoleId: string;
  let approverId: string;
  type Role = { id: string; name: string; builtIn: boolean; baseKey: string | null; permissions: string[]; memberCount: number; permissionsFixed: boolean; canDelete: boolean };
  const roles = async (who: Actor) => (await t.as(who).get('/corporate/roles').expect(200)).body as Role[];
  const byBase = (list: Role[], key: string) => list.find((r) => r.baseKey === key)!;

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    accountA = await activeAccount(t, alpha);
    accountB = await activeAccount(t, alpha);
    adminA = await addCorporateAdmin(t, alpha, accountA.id);
    adminA2 = await addCorporateAdmin(t, alpha, accountA.id);
    adminB = await addCorporateAdmin(t, alpha, accountB.id);
    employeeA = await addCorporateEmployeeLogin(t, alpha, accountA.id);
  });
  afterAll(() => t.close());

  it('lists the centre defaults with who holds them; only the administrator may change anything', async () => {
    const list = await roles(adminA);
    expect(list.map((r) => [r.baseKey, r.builtIn, r.memberCount, r.permissionsFixed, r.canDelete])).toEqual([
      ['corporate_admin', true, 2, true, false],
      ['corporate_employee', true, 1, false, false],
    ]);
    employeeRoleId = byBase(list, 'corporate_employee').id;
    await t.as(employeeA).post('/corporate/roles', { name: 'Sneaky', permissions: [] }).expect(403);
    await t.as(employeeA).patch(`/corporate/roles/${employeeRoleId}`, { name: 'Sneaky' }).expect(403);
  });

  it('changing a built-in role gives the company its own copy; the centre and other companies keep theirs', async () => {
    const centreDefault = await t.sys.role.findFirstOrThrow({ where: { tenantId: alpha.id, key: 'corporate_employee' }, include: { rolePermissions: true } });
    const changed = (await t.as(adminA).patch(`/corporate/roles/${employeeRoleId}`, { name: 'Field staff', permissions: ['self.profile', 'self.requests', 'self.documents'] }).expect(200)).body as Role;
    expect(changed).toMatchObject({ name: 'Field staff', builtIn: true, baseKey: 'corporate_employee', memberCount: 1, permissions: ['self.profile', 'self.requests', 'self.documents'] });
    expect(changed.id).not.toBe(centreDefault.id);
    // The centre default is untouched, company B still sees it, and A's people moved onto A's copies.
    const after = await t.sys.role.findUniqueOrThrow({ where: { id: centreDefault.id }, include: { rolePermissions: true } });
    expect([after.name, after.rolePermissions.length]).toEqual([centreDefault.name, centreDefault.rolePermissions.length]);
    expect(byBase(await roles(adminB), 'corporate_employee')).toMatchObject({ id: centreDefault.id, name: centreDefault.name });
    const listA = await roles(adminA);
    expect(listA.map((r) => r.id)).not.toContain(centreDefault.id);
    const moved = await t.sys.tenantMembership.findMany({ where: { corporateAccountId: accountA.id }, include: { role: true } });
    expect(moved.every((m) => m.role.corporateAccountId === accountA.id)).toBe(true);
    // The centre's own role list does not show company roles.
    expect((await t.as(alpha.owner).get('/roles').expect(200)).body.map((r: { id: string }) => r.id)).not.toContain(changed.id);
    // A new colleague of A gets A's administrator copy.
    const colleague = await addCorporateAdmin(t, alpha, accountA.id);
    const m = await t.sys.tenantMembership.findUniqueOrThrow({ where: { id: colleague.membershipId! }, include: { role: true } });
    expect(m.role.id).toBe(byBase(listA, 'corporate_admin').id);
  });

  it('the administrator role can be renamed but always keeps every permission, and built-in roles stay', async () => {
    const admin = byBase(await roles(adminA), 'corporate_admin');
    expect((await t.as(adminA).patch(`/corporate/roles/${admin.id}`, { permissions: admin.permissions.slice(1) }).expect(409)).body.code).toBe('PERMISSIONS_FIXED');
    expect((await t.as(adminA).patch(`/corporate/roles/${admin.id}`, { name: 'Company owner' }).expect(200)).body.name).toBe('Company owner');
    expect((await t.as(adminA).delete(`/corporate/roles/${admin.id}`).expect(409)).body.code).toBe('ROLE_REQUIRED');
    await t.as(adminA).delete(`/corporate/roles/${employeeRoleId}`).expect(404); // the centre default is no longer one of A's roles
  });

  it('creates, assigns, edits and deletes a role of its own', async () => {
    await t.as(adminA).post('/corporate/roles', { name: 'Approver', permissions: ['invoice.read'] }).expect(400);
    const created = (await t.as(adminA).post('/corporate/roles', { name: 'Approver', description: 'Approves requests', permissions: ['corp.requests.read', 'corp.requests.approve', 'corp.employees.read'] }).expect(201)).body as Role;
    approverId = created.id;
    expect(created).toMatchObject({ builtIn: false, canDelete: true, memberCount: 0 });

    // Give the employee login the new role: their session ends, and the next one has the new permissions.
    await t.as(employeeA).get('/corporate/employees').expect(403);
    const users = (await t.as(adminA).get('/corporate/users').expect(200)).body as Array<{ id: string; email: string; isMe: boolean; type: string }>;
    const emp = users.find((u) => u.email === employeeA.email)!;
    const me = users.find((u) => u.isMe)!;
    await t.as(adminA).put(`/corporate/users/${me.id}/role`, { roleId: approverId }).expect(403);
    await t.as(adminA).put(`/corporate/users/${emp.id}/role`, { roleId: approverId }).expect(200);
    await t.as(employeeA).get('/corporate/employees').expect(401);
    employeeA = await t.login(employeeA.email, PASSWORD, 'corporate', alpha.slug);
    await t.as(employeeA).get('/corporate/employees').expect(200);

    // Someone else's company and someone else's centre cannot touch it.
    await t.as(adminB).patch(`/corporate/roles/${approverId}`, { name: 'Hijacked' }).expect(404);
    await t.as(adminB).put(`/corporate/users/${emp.id}/role`, { roleId: (await roles(adminB))[1]!.id }).expect(404);
    await t.as(beta.owner).patch(`/roles/${approverId}`, { name: 'Hijacked' }).expect(404);

    expect((await t.as(adminA).patch(`/corporate/roles/${approverId}`, { permissions: ['corp.requests.read'] }).expect(200)).body.permissions).toEqual(['corp.requests.read']);
    expect((await t.as(adminA).delete(`/corporate/roles/${approverId}`).expect(409)).body.code).toBe('ROLE_IN_USE');
    const fieldStaff = byBase(await roles(adminA), 'corporate_employee').id;
    await t.as(adminA).put(`/corporate/users/${emp.id}/role`, { roleId: fieldStaff }).expect(200);
    await t.as(adminA).delete(`/corporate/roles/${approverId}`).expect(200);
    expect(await t.sys.role.findUnique({ where: { id: approverId } })).toBeNull();
    const audit = await t.sys.auditLog.findMany({ where: { tenantId: alpha.id, resourceId: accountA.id, action: { startsWith: 'corporate.role' } }, select: { action: true } });
    expect(new Set(audit.map((a) => a.action))).toEqual(new Set(['corporate.role_created', 'corporate.role_updated', 'corporate.role_deleted']));
  });

  it('a role that may manage the account is still not the administrator', async () => {
    const manager = (await t.as(adminA).post('/corporate/roles', { name: 'Office manager', permissions: ['corp.account.read', 'corp.account.manage'] }).expect(201)).body as Role;
    const users = (await t.as(adminA).get('/corporate/users').expect(200)).body as Array<{ id: string; email: string }>;
    await t.as(adminA).put(`/corporate/users/${users.find((u) => u.email === adminA2.email)!.id}/role`, { roleId: manager.id }).expect(200);
    const relogged = await t.login(adminA2.email, PASSWORD, 'corporate', alpha.slug);
    expect((await t.as(relogged).post('/corporate/roles', { name: 'Mine', permissions: [] }).expect(403)).body.code).toBe('COMPANY_ADMIN_ONLY');
  });
});
