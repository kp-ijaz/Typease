import { Actor, PASSWORD, TenantFixture, TestApp, uniq } from '../../../test/helpers';
import { createDocument, createService } from '../requests/fixtures';
import { activeAccount, addCorporateAdmin, employeeBody } from './fixtures';

/**
 * Corporate employee logins: a corporate administrator or centre staff invite an
 * employee to the corporate portal; the employee signs in with the role
 * `corporate_employee` and reaches only their own requests and documents.
 */
describe('Corporate employee logins', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let clerk: Actor; // corporate.read + corporate.manage
  let receptionist: Actor; // corporate.read only
  let falcon: { id: string; accountNo: string };
  let oryx: { id: string; accountNo: string };
  let falconAdmin: Actor;
  let oryxAdmin: Actor;
  let service: { id: string };

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    await t.as(alpha.owner).post('/roles', { key: 'corporate_clerk', name: 'Corporate clerk', permissions: ['corporate.read', 'corporate.manage', 'customer.read'] }).expect(201);
    clerk = await t.addStaff(alpha, 'corporate_clerk');
    receptionist = await t.addStaff(alpha, 'receptionist');
    falcon = await activeAccount(t, alpha, { companyName: 'Falcon Trading LLC' });
    oryx = await activeAccount(t, alpha, { companyName: 'Oryx Logistics LLC' });
    falconAdmin = await addCorporateAdmin(t, alpha, falcon.id);
    oryxAdmin = await addCorporateAdmin(t, alpha, oryx.id);
    service = await createService(t, alpha, { form: null, requirements: [] });
  });
  afterAll(() => t.close());

  const audit = (action: string, resourceId: string) => t.sys.auditLog.findMany({ where: { tenantId: alpha.id, action, resourceId }, orderBy: { createdAt: 'asc' } });
  const addEmployee = async (accountId: string, over: Record<string, unknown> = {}) => (await t.as(clerk).post(`/corporate-accounts/${accountId}/employees`, employeeBody(over)).expect(201)).body as { id: string; customerId: string; email: string | null; fullName: string; login: any };
  const accept = (token: string, password: string | undefined = PASSWORD) => t.http.post('/api/v1/auth/invitations/accept').send({ token, ...(password ? { password } : {}), app: 'corporate' });
  const signIn = (email: string) => t.http.post('/api/v1/auth/login').send({ email, password: PASSWORD, app: 'corporate', tenantSlug: alpha.slug });
  const staffLogin = (accountId: string, employeeId: string) => `/corporate-accounts/${accountId}/employees/${employeeId}/login`;
  const portalLogin = (employeeId: string) => `/corporate/employees/${employeeId}/login`;
  const loginOf = async (accountId: string, employeeId: string) => (await t.as(clerk).get(`/corporate-accounts/${accountId}/employees/${employeeId}`).expect(200)).body.login;

  /** Invites through the staff route, accepts and signs in to the corporate portal. */
  async function employeeActor(accountId: string, employee: { id: string; email: string | null }): Promise<Actor> {
    const invite = await t.as(clerk).post(staffLogin(accountId, employee.id)).expect(201);
    const accepted = await accept(invite.body.dev.invitationToken).expect(200);
    expect(accepted.body.status).toBe('OK');
    return t.login(employee.email!, PASSWORD, 'corporate', alpha.slug);
  }

  it('staff invite an employee; after accepting, the employee signs in to the corporate portal and sees only their own requests and documents', async () => {
    const ravi = await addEmployee(falcon.id, { fullName: 'Ravi Kumar' });
    const sana = await addEmployee(falcon.id, { fullName: 'Sana Iqbal' });
    expect(ravi.login).toEqual({ status: 'NONE', email: null, invitedAt: null, joinedAt: null, lastLoginAt: null });

    // The company orders one request for each of them; each has a document in the vault.
    const raviRequest = (await t.as(falconAdmin).post('/requests', { serviceId: service.id, corporateEmployeeId: ravi.id }).expect(201)).body;
    const sanaRequest = (await t.as(falconAdmin).post('/requests', { serviceId: service.id, corporateEmployeeId: sana.id }).expect(201)).body;
    const raviDoc = await createDocument(t, alpha, { customerId: ravi.customerId, documentTypeKey: 'passport' });
    const sanaDoc = await createDocument(t, alpha, { customerId: sana.customerId, documentTypeKey: 'passport' });
    const companyDoc = await createDocument(t, alpha, { corporateAccountId: falcon.id, documentTypeKey: 'trade_licence' });

    const invite = await t.as(clerk).post(staffLogin(falcon.id, ravi.id)).expect(201);
    expect(invite.body).toMatchObject({ employeeId: ravi.id, status: 'INVITED', email: ravi.email, membershipId: expect.any(String), dev: { invitationToken: expect.any(String) } });
    const membership = await t.sys.tenantMembership.findUniqueOrThrow({ where: { id: invite.body.membershipId }, include: { role: true } });
    expect(membership).toMatchObject({ tenantId: alpha.id, kind: 'CORPORATE', status: 'INVITED', corporateAccountId: falcon.id, corporateEmployeeId: ravi.id, customerId: ravi.customerId, invitedById: clerk.userId, joinedAt: null });
    expect(membership.role.key).toBe('corporate_employee');
    expect(await loginOf(falcon.id, ravi.id)).toMatchObject({ status: 'INVITED', email: ravi.email, invitedAt: expect.any(String), joinedAt: null });
    // The token is stored hashed only, and the invitation email went to the employee.
    const tokens = await t.sys.authToken.findMany({ where: { type: 'INVITATION', tenantId: alpha.id, target: ravi.email! } });
    expect(tokens).toHaveLength(1);
    expect(JSON.stringify(tokens)).not.toContain(invite.body.dev.invitationToken);
    // Until the invitation is accepted there is no way in.
    await signIn(ravi.email!).expect(401);

    const preview = await t.http.get(`/api/v1/auth/invitations/preview?token=${invite.body.dev.invitationToken}`).expect(200);
    expect(preview.body).toMatchObject({ email: ravi.email, centreName: 'Alpha Typing', roleName: 'Corporate Employee', needsPassword: true, app: 'corporate' });
    const accepted = await accept(invite.body.dev.invitationToken).expect(200);
    expect(accepted.body).toMatchObject({ status: 'OK', session: { membership: { kind: 'CORPORATE', roleKey: 'corporate_employee', corporateAccountId: falcon.id, customerId: ravi.customerId } } });
    expect(accepted.body.session.permissions.sort()).toEqual(['self.documents', 'self.privacy', 'self.profile', 'self.requests', 'self.tickets']);

    const raviUser = await t.login(ravi.email!, PASSWORD, 'corporate', alpha.slug);
    expect(raviUser).toMatchObject({ roleKey: 'corporate_employee', customerId: ravi.customerId, membershipId: invite.body.membershipId });
    expect(await loginOf(falcon.id, ravi.id)).toMatchObject({ status: 'ACTIVE', email: ravi.email, joinedAt: expect.any(String), lastLoginAt: expect.any(String) });
    // The company's administrator sees the same state in the portal.
    expect((await t.as(falconAdmin).get(`/corporate/employees/${ravi.id}`).expect(200)).body.login.status).toBe('ACTIVE');
    const listed = (await t.as(falconAdmin).get('/corporate/employees').expect(200)).body.data;
    expect(Object.fromEntries(listed.map((e: any) => [e.id, e.login.status]))).toMatchObject({ [ravi.id]: 'ACTIVE', [sana.id]: 'NONE' });

    // Own requests only.
    expect((await t.as(raviUser).get('/requests').expect(200)).body.data.map((r: any) => r.id)).toEqual([raviRequest.id]);
    expect((await t.as(raviUser).get(`/requests/${raviRequest.id}`).expect(200)).body.customer.id).toBe(ravi.customerId);
    await t.as(raviUser).get(`/requests/${sanaRequest.id}`).expect(404);
    await t.as(raviUser).post(`/requests/${sanaRequest.id}/cancel`, { reason: 'Not mine to cancel' }).expect(404);
    // Own documents only: not a colleague's, not the company's.
    expect((await t.as(raviUser).get('/documents').expect(200)).body.data.map((d: any) => d.id)).toEqual([raviDoc.id]);
    await t.as(raviUser).get(`/documents/${raviDoc.id}`).expect(200);
    await t.as(raviUser).get(`/documents/${sanaDoc.id}`).expect(404);
    await t.as(raviUser).get(`/documents/${companyDoc.id}`).expect(404);
    await t.as(raviUser).get(`/documents?customerId=${sana.customerId}`).expect((res) => expect(JSON.stringify(res.body)).not.toContain(sanaDoc.id));

    // No corporate-administrator route, no staff route.
    for (const path of ['/corporate/account', '/corporate/employees', `/corporate/employees/${ravi.id}`, '/corporate/members', '/corporate/prices']) await t.as(raviUser).get(path).expect(403);
    await t.as(raviUser).post('/corporate/employees', employeeBody()).expect(403);
    await t.as(raviUser).patch(`/corporate/employees/${ravi.id}`, { designation: 'Director' }).expect(403);
    await t.as(raviUser).post('/corporate/members', { fullName: 'A Friend', email: `friend-${uniq()}@example.test` }).expect(403);
    await t.as(raviUser).post(portalLogin(sana.id)).expect(403);
    await t.as(raviUser).post(`${portalLogin(sana.id)}/resend-invitation`).expect(403);
    await t.as(raviUser).delete(portalLogin(ravi.id)).expect(403);
    for (const path of [`/corporate-accounts/${falcon.id}`, `/corporate-accounts/${falcon.id}/employees`, '/customers', `/customers/${sana.customerId}`]) await t.as(raviUser).get(path).expect(403);
    await t.as(raviUser).post(staffLogin(falcon.id, sana.id)).expect(403);

    const logs = await audit('corporate.employee_login_invited', falcon.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actorUserId: clerk.userId, resourceType: 'CorporateAccount', after: { employeeId: ravi.id, customerId: ravi.customerId, membershipId: invite.body.membershipId, email: ravi.email, invitedByType: 'STAFF' } });
    expect(JSON.stringify(logs)).not.toContain(invite.body.dev.invitationToken);
  });

  it('a corporate administrator invites employees of their own company only; other companies and other centres are refused', async () => {
    const amal = await addEmployee(falcon.id, { fullName: 'Amal Yousef' });
    const stranger = await addEmployee(oryx.id, { fullName: 'Oryx Driver' });

    // Another company's administrator of the same centre cannot reach Falcon's employee at all.
    await t.as(oryxAdmin).post(portalLogin(amal.id)).expect(404);
    await t.as(oryxAdmin).post(`${portalLogin(amal.id)}/resend-invitation`).expect(404);
    await t.as(oryxAdmin).delete(portalLogin(amal.id)).expect(404);
    // A company id in the body is not a way around it.
    await t.as(oryxAdmin).post(portalLogin(amal.id), { email: `x-${uniq()}@example.test`, corporateAccountId: falcon.id } as any).expect(404);
    // Staff cannot attach an employee through the wrong company either.
    await t.as(clerk).post(staffLogin(oryx.id, amal.id)).expect(404);
    expect(await t.sys.tenantMembership.count({ where: { corporateEmployeeId: amal.id } })).toBe(0);

    // Cross-tenant: staff and corporate administrators of another centre.
    const betaAccount = await activeAccount(t, beta);
    const betaAdmin = await addCorporateAdmin(t, beta, betaAccount.id);
    await t.as(beta.owner).post(staffLogin(falcon.id, amal.id)).expect(404);
    await t.as(beta.owner).post(staffLogin(betaAccount.id, amal.id)).expect(404);
    await t.as(beta.owner).delete(staffLogin(falcon.id, amal.id)).expect(404);
    await t.as(betaAdmin).post(portalLogin(amal.id)).expect(404);
    await t.as(betaAdmin).delete(portalLogin(amal.id)).expect(404);
    // Who may not invite: read-only staff, customers, anonymous callers.
    await t.as(receptionist).post(staffLogin(falcon.id, amal.id)).expect(403);
    await t.as(receptionist).delete(staffLogin(falcon.id, amal.id)).expect(403);
    await t.as(await t.addCustomer(alpha)).post(portalLogin(amal.id)).expect(403);
    await t.as(alpha.owner).post(portalLogin(amal.id)).expect(403);
    await t.as(null).post(portalLogin(amal.id)).expect(401);
    await t.as(null).post(staffLogin(falcon.id, amal.id)).expect(401);
    expect(await t.sys.tenantMembership.count({ where: { corporateEmployeeId: amal.id } })).toBe(0);

    // The company's own administrator can, to an address of their choosing.
    const address = `amal-private-${uniq()}@example.test`;
    const invite = await t.as(falconAdmin).post(portalLogin(amal.id), { email: address.toUpperCase() }).expect(201);
    expect(invite.body).toMatchObject({ employeeId: amal.id, status: 'INVITED', email: address });
    const log = (await audit('corporate.employee_login_invited', falcon.id)).find((l) => (l.after as any).employeeId === amal.id)!;
    expect(log).toMatchObject({ actorUserId: falconAdmin.userId, after: { invitedByType: 'CORPORATE', email: address } });
    await accept(invite.body.dev.invitationToken).expect(200);
    const amalUser = await t.login(address, PASSWORD, 'corporate', alpha.slug);

    // The employee of company A is invisible to an employee of company B, and vice versa.
    const strangerUser = await employeeActor(oryx.id, stranger);
    const amalRequest = (await t.as(falconAdmin).post('/requests', { serviceId: service.id, corporateEmployeeId: amal.id }).expect(201)).body;
    await t.as(strangerUser).get(`/requests/${amalRequest.id}`).expect(404);
    expect((await t.as(strangerUser).get('/requests').expect(200)).body.data).toEqual([]);
    expect((await t.as(amalUser).get('/requests').expect(200)).body.data.map((r: any) => r.id)).toEqual([amalRequest.id]);
    // The login of one centre is of no use at another centre.
    expect((await t.http.post('/api/v1/auth/login').send({ email: address, password: PASSWORD, app: 'corporate', tenantSlug: beta.slug })).status).toBe(403);
  });

  it('refuses invitations that make no sense, without revealing who owns an address', async () => {
    const noEmail = await addEmployee(falcon.id, { email: null });
    expect((await t.as(clerk).post(staffLogin(falcon.id, noEmail.id)).expect(422)).body.code).toBe('EMAIL_REQUIRED');
    await t.as(clerk).post(staffLogin(falcon.id, noEmail.id), { email: 'not-an-address' }).expect(400);

    const first = await addEmployee(falcon.id);
    const second = await addEmployee(falcon.id);
    const invite = await t.as(clerk).post(staffLogin(falcon.id, first.id)).expect(201);
    // Pending: use resend, not a second invitation.
    expect((await t.as(clerk).post(staffLogin(falcon.id, first.id)).expect(409)).body.code).toBe('INVITATION_PENDING');
    // The same address cannot open a second employee's record, a colleague's company, or an administrator's.
    for (const [path, actor] of [[staffLogin(falcon.id, second.id), clerk], [portalLogin(second.id), falconAdmin]] as const) {
      const taken = await t.as(actor).post(path, { email: first.email }).expect(409);
      expect(taken.body.code).toBe('EMAIL_IN_USE');
      expect(JSON.stringify(taken.body)).not.toMatch(/Falcon|Oryx|CORP-/);
    }
    const oryxEmployee = await addEmployee(oryx.id);
    expect((await t.as(oryxAdmin).post(portalLogin(oryxEmployee.id), { email: first.email }).expect(409)).body.code).toBe('EMAIL_IN_USE');
    expect((await t.as(clerk).post(staffLogin(falcon.id, second.id), { email: falconAdmin.email }).expect(409)).body.code).toBe('EMAIL_IN_USE');
    expect((await t.sys.tenantMembership.findFirstOrThrow({ where: { tenantId: alpha.id, userId: falconAdmin.userId, kind: 'CORPORATE' }, include: { role: true } })).role.key).toBe('corporate_admin');

    await accept(invite.body.dev.invitationToken).expect(200);
    expect((await t.as(clerk).post(staffLogin(falcon.id, first.id)).expect(409)).body.code).toBe('ALREADY_HAS_ACCESS');
    expect((await t.as(clerk).post(staffLogin(falcon.id, first.id), { email: `other-${uniq()}@example.test` }).expect(409)).body.code).toBe('ALREADY_HAS_ACCESS');
    expect((await t.as(clerk).post(`${staffLogin(falcon.id, first.id)}/resend-invitation`).expect(409)).body.code).toBe('NOT_INVITED');
    expect((await t.as(clerk).delete(staffLogin(falcon.id, second.id)).expect(409)).body.code).toBe('NO_LOGIN');

    // An inactive employee gets no portal access.
    await t.as(clerk).patch(`/corporate-accounts/${falcon.id}/employees/${second.id}`, { status: 'INACTIVE' }).expect(200);
    expect((await t.as(clerk).post(staffLogin(falcon.id, second.id)).expect(409)).body.code).toBe('EMPLOYEE_INACTIVE');

    // The portal only writes while the company is active; staff are refused on an archived company.
    const pending = (await t.as(clerk).post('/corporate-accounts', { companyName: `Pending ${uniq()} LLC` }).expect(201)).body;
    const pendingAdmin = await addCorporateAdmin(t, alpha, pending.id);
    const pendingEmployee = await addEmployee(pending.id);
    expect((await t.as(pendingAdmin).post(portalLogin(pendingEmployee.id)).expect(403)).body.code).toBe('CORPORATE_ACCOUNT_NOT_ACTIVE');
    await t.as(clerk).post(`/corporate-accounts/${pending.id}/archive`, { reason: 'Never verified' }).expect(200);
    expect((await t.as(clerk).post(staffLogin(pending.id, pendingEmployee.id)).expect(409)).body.code).toBe('CORPORATE_ACCOUNT_ARCHIVED');
  });

  it('requires the corporatePortal plan feature', async () => {
    const basic = await t.createTenant({ plan: 'starter' });
    const account = await t.sys.corporateAccount.create({ data: { tenantId: basic.id, accountNo: 'CORP-000001', companyName: 'No Portal LLC', status: 'ACTIVE', verifiedAt: new Date() } });
    const customer = await t.sys.customer.create({ data: { tenantId: basic.id, customerNo: 'CUS-000001', fullName: 'No Portal Employee', email: `np-${uniq()}@example.test`, corporateAccountId: account.id } });
    const employee = await t.sys.corporateEmployee.create({ data: { tenantId: basic.id, corporateAccountId: account.id, customerId: customer.id } });
    const res = await t.as(basic.owner).post(`/corporate-accounts/${account.id}/employees/${employee.id}/login`).expect(402);
    expect(res.body).toMatchObject({ code: 'PLAN_LIMIT_REACHED', details: { limit: 'corporatePortal' } });
    expect(await t.sys.tenantMembership.count({ where: { tenantId: basic.id, kind: 'CORPORATE' } })).toBe(0);
  });

  it('resend replaces the link; revoke withdraws a pending invitation', async () => {
    const employee = await addEmployee(falcon.id);
    const invite = await t.as(falconAdmin).post(portalLogin(employee.id)).expect(201);
    const again = await t.as(clerk).post(`${staffLogin(falcon.id, employee.id)}/resend-invitation`).expect(200);
    expect(again.body).toMatchObject({ status: 'SENT', email: employee.email, dev: { invitationToken: expect.any(String) } });
    expect(again.body.dev.invitationToken).not.toBe(invite.body.dev.invitationToken);
    expect((await accept(invite.body.dev.invitationToken).expect(400)).body.code).toBe('TOKEN_INVALID');
    expect((await audit('corporate.employee_login_invitation_resent', falcon.id)).some((l) => (l.after as any).employeeId === employee.id)).toBe(true);

    // The administrator withdraws the invitation: the link that was still valid stops working.
    const revoked = await t.as(falconAdmin).delete(portalLogin(employee.id)).expect(200);
    expect(revoked.body).toEqual({ employeeId: employee.id, status: 'NONE' });
    expect((await accept(again.body.dev.invitationToken).expect(400)).body.code).toBe('TOKEN_INVALID');
    expect((await loginOf(falcon.id, employee.id)).status).toBe('NONE');
    expect(await t.sys.tenantMembership.findUniqueOrThrow({ where: { id: invite.body.membershipId } })).toMatchObject({ status: 'REMOVED', corporateEmployeeId: null, customerId: null });
    await signIn(employee.email!).expect(401);
    // The same person can be invited again later; the same membership row is re-used.
    const third = await t.as(clerk).post(staffLogin(falcon.id, employee.id)).expect(201);
    expect(third.body.membershipId).toBe(invite.body.membershipId);
    await accept(third.body.dev.invitationToken).expect(200);
    await t.login(employee.email!, PASSWORD, 'corporate', alpha.slug);
  });

  it('revoking an active login ends the session at once', async () => {
    const employee = await addEmployee(falcon.id);
    const user = await employeeActor(falcon.id, employee);
    await t.as(user).get('/requests').expect(200);

    const revoked = await t.as(clerk).delete(staffLogin(falcon.id, employee.id)).expect(200);
    expect(revoked.body.status).toBe('NONE');
    await t.as(user).get('/requests').expect(401);
    await t.as(user).get('/auth/me').expect(401);
    expect((await signIn(employee.email!)).status).toBe(403);
    expect((await loginOf(falcon.id, employee.id)).status).toBe('NONE');
    const log = (await audit('corporate.employee_login_revoked', falcon.id)).find((l) => (l.after as any).employeeId === employee.id)!;
    expect(log).toMatchObject({ actorUserId: clerk.userId, before: { employeeId: employee.id, logins: [{ membershipId: user.membershipId, email: employee.email, status: 'ACTIVE' }] }, after: { status: 'NONE' } });
    // The person's record, and what the company sees of it, are untouched.
    expect((await t.sys.customer.findUniqueOrThrow({ where: { id: employee.customerId } })).status).toBe('ACTIVE');
    expect((await t.as(falconAdmin).get(`/corporate/employees/${employee.id}`).expect(200)).body).toMatchObject({ status: 'ACTIVE', login: { status: 'NONE' } });
  });

  it('a deactivated employee loses the login; after reactivation a new invitation re-opens it without a new password', async () => {
    const employee = await addEmployee(falcon.id);
    const user = await employeeActor(falcon.id, employee);
    const deactivated = await t.as(falconAdmin).patch(`/corporate/employees/${employee.id}`, { status: 'INACTIVE' }).expect(200);
    expect(deactivated.body.login.status).toBe('SUSPENDED');
    await t.as(user).get('/requests').expect(401);
    expect((await signIn(employee.email!)).status).toBe(403);

    await t.as(falconAdmin).patch(`/corporate/employees/${employee.id}`, { status: 'ACTIVE' }).expect(200);
    // Reactivating the employment does not silently re-open the login.
    expect((await loginOf(falcon.id, employee.id)).status).toBe('SUSPENDED');
    expect((await signIn(employee.email!)).status).toBe(403);
    const invite = await t.as(falconAdmin).post(portalLogin(employee.id)).expect(201);
    expect(invite.body.membershipId).toBe(user.membershipId);
    const preview = await t.http.get(`/api/v1/auth/invitations/preview?token=${invite.body.dev.invitationToken}`).expect(200);
    expect(preview.body.needsPassword).toBe(false);
    await t.http.post('/api/v1/auth/invitations/accept').send({ token: invite.body.dev.invitationToken, app: 'corporate' }).expect(200);
    const back = await t.login(employee.email!, PASSWORD, 'corporate', alpha.slug);
    expect(back.customerId).toBe(employee.customerId);
    await t.as(back).get('/requests').expect(200);
  });

  it('a new address replaces a pending invitation sent to another address', async () => {
    const employee = await addEmployee(falcon.id);
    const first = await t.as(clerk).post(staffLogin(falcon.id, employee.id)).expect(201);
    const address = `second-${uniq()}@example.test`;
    const second = await t.as(clerk).post(staffLogin(falcon.id, employee.id), { email: address }).expect(201);
    expect(second.body.membershipId).not.toBe(first.body.membershipId);
    expect((await accept(first.body.dev.invitationToken).expect(400)).body.code).toBe('TOKEN_INVALID');
    expect(await t.sys.tenantMembership.findUniqueOrThrow({ where: { id: first.body.membershipId } })).toMatchObject({ status: 'REMOVED', corporateEmployeeId: null, customerId: null });
    expect(await loginOf(falcon.id, employee.id)).toMatchObject({ status: 'INVITED', email: address });
    expect(await t.sys.tenantMembership.count({ where: { tenantId: alpha.id, corporateEmployeeId: employee.id, status: { not: 'REMOVED' } } })).toBe(1);
  });
});
