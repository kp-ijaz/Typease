import { Actor, PASSWORD, TenantFixture, TestApp, uniq } from '../../../test/helpers';
import { blindIndex } from '../../common/crypto';
import { accountBody, activeAccount, addCorporateAdmin, addCorporateEmployeeLogin, createAccount, emiratesId, employeeBody, passport, seedService } from './fixtures';

describe('Corporate', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let receptionist: Actor; // corporate.read only
  let clerk: Actor; // corporate.read + corporate.manage, no corporate.verify
  let manager: Actor; // everything incl. corporate.verify
  let customer: Actor;

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    receptionist = await t.addStaff(alpha, 'receptionist');
    manager = await t.addStaff(alpha, 'manager');
    await t.as(alpha.owner).post('/roles', { key: 'corporate_clerk', name: 'Corporate clerk', permissions: ['corporate.read', 'corporate.manage', 'customer.read'] }).expect(201);
    clerk = await t.addStaff(alpha, 'corporate_clerk');
    customer = await t.addCustomer(alpha);
  });
  afterAll(() => t.close());

  const audit = (tenantId: string, action: string, resourceId?: string) => t.sys.auditLog.findMany({ where: { tenantId, action, ...(resourceId ? { resourceId } : {}) }, orderBy: { createdAt: 'asc' } });
  const VERIFY = { note: 'Trade licence and authorisation letter checked' };

  // ------------------------------------------------------------------ accounts
  describe('accounts (staff)', () => {
    it('registers a company with an account number; it always starts unverified and without credit', async () => {
      const gamma = await t.createTenant();
      const res = await t.as(gamma.owner).post('/corporate-accounts', {
        companyName: 'Falcon Trading LLC', companyNameAr: 'فالكون للتجارة', tradeLicenceNo: 'TL-778899', tradeLicenceAuthority: 'Department of Economy', tradeLicenceExpiry: '2027-06-30',
        taxRegistrationNo: '100123456700003', billingEmail: 'Accounts@Falcon.example.test', billingAddress: { line1: 'Office 501', city: 'Dubai', country: 'ae', poBox: '12345' },
        paymentTermsDays: 30, creditLimit: '5000', notes: 'Introduced by the owner',
        // None of these can be set by whoever registers the company:
        status: 'ACTIVE', creditApproved: true, verifiedAt: new Date().toISOString(), verifiedById: gamma.owner.userId, accountNo: 'CORP-999999',
      } as any).expect(201);
      expect(res.body).toMatchObject({
        tenantId: gamma.id, accountNo: 'CORP-000001', companyName: 'Falcon Trading LLC', companyNameAr: 'فالكون للتجارة', tradeLicenceNo: 'TL-778899', tradeLicenceExpiry: '2027-06-30',
        billingEmail: 'accounts@falcon.example.test', billingAddress: { line1: 'Office 501', city: 'Dubai', country: 'AE', poBox: '12345' }, paymentTermsDays: 30, creditLimit: '5000',
        status: 'PENDING_VERIFICATION', creditApproved: false, verifiedAt: null, verifiedById: null,
      });
      expect((await createAccount(t, gamma)).accountNo).toBe('CORP-000002');
      const logs = await audit(gamma.id, 'corporate.account_created', res.body.id);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ actorUserId: gamma.owner.userId, resourceType: 'CorporateAccount' });
    });

    it('validates input and refuses a second account with the same trade licence', async () => {
      const post = (over: Record<string, unknown>) => t.as(manager).post('/corporate-accounts', accountBody(over));
      await post({ companyName: 'X' }).expect(400);
      await post({ billingEmail: 'nope' }).expect(400);
      await post({ paymentTermsDays: -1 }).expect(400);
      await post({ paymentTermsDays: 400 }).expect(400);
      await post({ creditLimit: '-10' }).expect(400);
      await post({ tradeLicenceExpiry: '30/06/2027' }).expect(400);
      const first = await createAccount(t, alpha, { tradeLicenceNo: 'TL-DUP-1' });
      const clash = await post({ tradeLicenceNo: 'tl-dup-1' }).expect(409);
      expect(clash.body).toMatchObject({ code: 'DUPLICATE_TRADE_LICENCE', details: { corporateAccountId: first.id } });
      // The same licence number at another centre is that centre's business.
      await t.as(beta.owner).post('/corporate-accounts', accountBody({ tradeLicenceNo: 'TL-DUP-1' })).expect(201);
    });

    it('enforces the plan limit on corporate clients, also when an archived account is restored', async () => {
      const none = await t.createTenant({ plan: 'starter' });
      const refused = await t.as(none.owner).post('/corporate-accounts', accountBody()).expect(402);
      expect(refused.body).toMatchObject({ code: 'PLAN_LIMIT_REACHED', details: { limit: 'corporateClients' } });
      expect(await t.sys.corporateAccount.count({ where: { tenantId: none.id } })).toBe(0);

      const pro = await t.createTenant({ plan: 'professional' }); // 10 corporate clients
      const accounts = [];
      for (let i = 0; i < 10; i++) accounts.push(await createAccount(t, pro));
      await t.as(pro.owner).post('/corporate-accounts', accountBody()).expect(402);
      // Archiving frees a place ...
      await t.as(pro.owner).post(`/corporate-accounts/${accounts[0].id}/archive`, { reason: 'Contract ended' }).expect(200);
      const eleventh = await createAccount(t, pro);
      expect(eleventh.accountNo).toBe('CORP-000011');
      // ... and restoring the archived one would exceed the plan again.
      expect((await t.as(pro.owner).post(`/corporate-accounts/${accounts[0].id}/reactivate`).expect(402)).body.code).toBe('PLAN_LIMIT_REACHED');
      expect((await t.sys.corporateAccount.findUniqueOrThrow({ where: { id: accounts[0].id } })).status).toBe('ARCHIVED');
    });

    it('lists with search, status filter and paging; the detail has counters', async () => {
      const gamma = await t.createTenant();
      const falcon = await activeAccount(t, gamma, { companyName: 'Falcon Trading LLC', tradeLicenceNo: 'TL-FALCON' });
      const oryx = await createAccount(t, gamma, { companyName: 'Oryx Logistics LLC', companyNameAr: 'أوريكس' });
      const gone = await createAccount(t, gamma, { companyName: 'Gone Away FZE' });
      await t.as(gamma.owner).post(`/corporate-accounts/${gone.id}/archive`, { reason: 'Closed down' }).expect(200);
      const ids = (res: any) => res.body.data.map((a: any) => a.id);
      const get = (query: string) => t.as(gamma.owner).get(`/corporate-accounts?${query}`).expect(200);

      expect(ids(await get('sort=accountNo:asc'))).toEqual([falcon.id, oryx.id]);
      expect(ids(await get('status=ALL&sort=accountNo:asc'))).toEqual([falcon.id, oryx.id, gone.id]);
      expect(ids(await get('status=ARCHIVED'))).toEqual([gone.id]);
      expect(ids(await get('status=PENDING_VERIFICATION'))).toEqual([oryx.id]);
      expect(ids(await get('q=falcon'))).toEqual([falcon.id]);
      expect(ids(await get('q=tl-falc'))).toEqual([falcon.id]);
      expect(ids(await get(`q=${oryx.accountNo.toLowerCase()}`))).toEqual([oryx.id]);
      expect(ids(await get(`q=${encodeURIComponent('أوريكس')}`))).toEqual([oryx.id]);
      const page = await get('sort=companyName:asc&pageSize=1&page=2');
      expect(ids(page)).toEqual([oryx.id]);
      expect(page.body.meta).toEqual({ page: 2, pageSize: 1, total: 2, totalPages: 2 });
      expect(page.body.data[0]).toMatchObject({ employeeCount: 0, memberCount: 0 });

      // Counters: work in progress, money owed and what is left of an approved credit limit.
      await t.as(gamma.owner).post(`/corporate-accounts/${falcon.id}/employees`, employeeBody()).expect(201);
      const person = await t.sys.customer.findFirstOrThrow({ where: { tenantId: gamma.id, corporateAccountId: falcon.id } });
      const service = await seedService(t, gamma);
      await t.sys.serviceRequest.create({ data: { tenantId: gamma.id, branchId: gamma.headOfficeId, requestNo: `TE-${uniq()}`, customerId: person.id, corporateAccountId: falcon.id, serviceId: service.id, status: 'IN_PREPARATION' } });
      await t.sys.serviceRequest.create({ data: { tenantId: gamma.id, branchId: gamma.headOfficeId, requestNo: `TE-${uniq()}`, customerId: person.id, corporateAccountId: falcon.id, serviceId: service.id, status: 'COMPLETED' } });
      await t.sys.invoice.create({ data: { tenantId: gamma.id, branchId: gamma.headOfficeId, invoiceNo: `INV-${uniq()}`, customerId: person.id, corporateAccountId: falcon.id, status: 'ISSUED', subtotalServiceFee: '750.00', total: '750.00', balanceDue: '750.00', issuedAt: new Date() } });
      await t.sys.invoice.create({ data: { tenantId: gamma.id, branchId: gamma.headOfficeId, invoiceNo: `INV-${uniq()}`, customerId: person.id, corporateAccountId: falcon.id, status: 'PAID', subtotalServiceFee: '100.00', total: '100.00', amountPaid: '100.00', balanceDue: '0.00', issuedAt: new Date() } });
      const before = (await t.as(gamma.owner).get(`/corporate-accounts/${falcon.id}`).expect(200)).body;
      expect(before.counters).toEqual({ employees: 1, members: 0, openRequests: 1, totalRequests: 2, unpaidInvoices: 1, unpaidInvoicesBalance: '750.00', creditAvailable: null });
      await t.as(gamma.owner).post(`/corporate-accounts/${falcon.id}/credit`, { approved: true, creditLimit: '2000', paymentTermsDays: 30, note: 'Approved by the owner' }).expect(200);
      expect((await t.as(gamma.owner).get(`/corporate-accounts/${falcon.id}`)).body.counters.creditAvailable).toBe('1250.00');
      expect((await t.as(gamma.owner).get(`/corporate-accounts/${oryx.id}`)).body.counters).toMatchObject({ employees: 0, openRequests: 0, unpaidInvoicesBalance: '0.00' });
    });

    it('updates details; changing approved credit terms withdraws the approval', async () => {
      const account = await activeAccount(t, alpha, { creditLimit: '1000', paymentTermsDays: 15 });
      const updated = (await t.as(clerk).patch(`/corporate-accounts/${account.id}`, { companyName: 'Renamed Trading LLC', billingAddress: { city: 'Sharjah' }, tradeLicenceExpiry: '2028-01-01' }).expect(200)).body;
      expect(updated).toMatchObject({ companyName: 'Renamed Trading LLC', billingAddress: { city: 'Sharjah' }, tradeLicenceExpiry: '2028-01-01', creditApprovalWithdrawn: false });
      await t.as(manager).post(`/corporate-accounts/${account.id}/credit`, { approved: true, note: 'Terms agreed' }).expect(200);
      // Unrelated edits keep the approval.
      expect((await t.as(clerk).patch(`/corporate-accounts/${account.id}`, { notes: 'Pays on time', creditLimit: '1000.00', paymentTermsDays: 15 }).expect(200)).body).toMatchObject({ creditApproved: true, creditApprovalWithdrawn: false });
      // A clerk can propose new terms, but cannot make them count.
      const raised = (await t.as(clerk).patch(`/corporate-accounts/${account.id}`, { creditLimit: '50000' }).expect(200)).body;
      expect(raised).toMatchObject({ creditLimit: '50000', creditApproved: false, creditApprovalWithdrawn: true });
      await t.as(clerk).patch(`/corporate-accounts/${account.id}`, { creditApproved: true, status: 'ACTIVE', verifiedAt: null } as any).expect(200);
      expect(await t.sys.corporateAccount.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({ creditApproved: false, status: 'ACTIVE' });
      const log = (await audit(alpha.id, 'corporate.account_updated', account.id)).find((l) => (l.summary ?? '').includes('credit approval withdrawn'))!;
      expect(log.before).toMatchObject({ creditLimit: '1000', creditApproved: true });
      expect(log.after).toMatchObject({ creditLimit: '50000', creditApproved: false });
    });
  });

  // ------------------------------------------------------------------ verification + credit
  describe('verification and credit approval (corporate.verify)', () => {
    it('verification is a separate, audited decision', async () => {
      const account = await createAccount(t, alpha);
      await t.as(clerk).post(`/corporate-accounts/${account.id}/verify`, VERIFY).expect(403);
      await t.as(receptionist).post(`/corporate-accounts/${account.id}/verify`, VERIFY).expect(403);
      await t.as(manager).post(`/corporate-accounts/${account.id}/verify`, {}).expect(400);
      await t.as(manager).post(`/corporate-accounts/${account.id}/verify`, { note: 'ok' }).expect(400);
      expect((await t.sys.corporateAccount.findUniqueOrThrow({ where: { id: account.id } })).status).toBe('PENDING_VERIFICATION');

      const verified = (await t.as(manager).post(`/corporate-accounts/${account.id}/verify`, VERIFY).expect(200)).body;
      expect(verified).toMatchObject({ status: 'ACTIVE', verifiedById: manager.userId });
      expect(verified.verifiedAt).not.toBeNull();
      const log = (await audit(alpha.id, 'corporate.account_verified', account.id))[0];
      expect(log).toMatchObject({ actorUserId: manager.userId, before: { status: 'PENDING_VERIFICATION' }, after: { status: 'ACTIVE', note: VERIFY.note } });
      expect((await t.as(manager).post(`/corporate-accounts/${account.id}/verify`, VERIFY).expect(409)).body.code).toBe('ALREADY_VERIFIED');
    });

    it('credit needs a verified company, a limit and the verify permission', async () => {
      const account = await createAccount(t, alpha);
      const decide = (actor: Actor, body: Record<string, unknown>) => t.as(actor).post(`/corporate-accounts/${account.id}/credit`, body);
      await decide(clerk, { approved: true, creditLimit: '1000', note: 'Trying my luck' }).expect(403);
      expect((await decide(manager, { approved: true, creditLimit: '1000', note: 'Too early' }).expect(422)).body.code).toBe('CORPORATE_NOT_VERIFIED');
      await t.as(manager).post(`/corporate-accounts/${account.id}/verify`, VERIFY).expect(200);
      expect((await decide(manager, { approved: true, note: 'No limit given' }).expect(422)).body.code).toBe('CREDIT_LIMIT_REQUIRED');
      expect((await decide(manager, { approved: true, creditLimit: '0', note: 'Zero limit' }).expect(422)).body.code).toBe('CREDIT_LIMIT_REQUIRED');
      await decide(manager, { approved: true, creditLimit: '1000' }).expect(400);

      const approved = (await decide(manager, { approved: true, creditLimit: '7500.50', paymentTermsDays: 45, note: 'Bank guarantee received' }).expect(200)).body;
      expect(approved).toMatchObject({ creditApproved: true, creditLimit: '7500.5', paymentTermsDays: 45 });
      const revoked = (await decide(manager, { approved: false, note: 'Two invoices overdue' }).expect(200)).body;
      expect(revoked).toMatchObject({ creditApproved: false, creditLimit: '7500.5' });
      expect((await audit(alpha.id, 'corporate.credit_approved', account.id))[0]).toMatchObject({ actorUserId: manager.userId, before: { creditApproved: false }, after: { creditApproved: true, creditLimit: '7500.50', paymentTermsDays: 45, note: 'Bank guarantee received' } });
      expect((await audit(alpha.id, 'corporate.credit_revoked', account.id))[0].after).toMatchObject({ creditApproved: false, note: 'Two invoices overdue' });
    });
  });

  // ------------------------------------------------------------------ status
  describe('suspend, reactivate, archive', () => {
    it('follows the allowed transitions and audits each one', async () => {
      const account = await createAccount(t, alpha);
      const act = (action: string, body?: object) => t.as(clerk).post(`/corporate-accounts/${account.id}/${action}`, body);
      expect((await act('suspend', { reason: 'Not yet active' }).expect(409)).body.code).toBe('INVALID_STATUS');
      expect((await act('reactivate').expect(409)).body.code).toBe('INVALID_STATUS');
      await t.as(manager).post(`/corporate-accounts/${account.id}/verify`, VERIFY).expect(200);
      await act('suspend', {}).expect(400);
      expect((await act('suspend', { reason: 'Invoices overdue' }).expect(200)).body.status).toBe('SUSPENDED');
      expect((await act('suspend', { reason: 'Again' }).expect(409)).body.message).toMatch(/already suspended/);
      expect((await act('reactivate').expect(200)).body.status).toBe('ACTIVE');
      expect((await act('archive', { reason: 'Company closed' }).expect(200)).body.status).toBe('ARCHIVED');
      expect((await act('archive', { reason: 'Again' }).expect(409)).body.code).toBe('INVALID_STATUS');
      // An archived account is read-only until it is restored.
      expect((await t.as(clerk).patch(`/corporate-accounts/${account.id}`, { notes: 'x' }).expect(409)).body.code).toBe('CORPORATE_ACCOUNT_ARCHIVED');
      expect((await t.as(clerk).post(`/corporate-accounts/${account.id}/employees`, employeeBody()).expect(409)).body.code).toBe('CORPORATE_ACCOUNT_ARCHIVED');
      expect((await act('reactivate').expect(200)).body.status).toBe('ACTIVE');
      for (const action of ['corporate.account_suspended', 'corporate.account_archived']) expect((await audit(alpha.id, action, account.id)).length).toBe(1);
      expect((await audit(alpha.id, 'corporate.account_reactivated', account.id)).length).toBe(2);

      // An account that was never verified comes back as pending, not as active.
      const unverified = await createAccount(t, alpha);
      await t.as(clerk).post(`/corporate-accounts/${unverified.id}/archive`, { reason: 'Mistake' }).expect(200);
      expect((await t.as(clerk).post(`/corporate-accounts/${unverified.id}/reactivate`).expect(200)).body.status).toBe('PENDING_VERIFICATION');
    });

    it('cannot archive a company with open requests', async () => {
      const account = await activeAccount(t, alpha);
      await t.as(clerk).post(`/corporate-accounts/${account.id}/employees`, employeeBody()).expect(201);
      const person = await t.sys.customer.findFirstOrThrow({ where: { corporateAccountId: account.id } });
      const service = await seedService(t, alpha);
      const request = await t.sys.serviceRequest.create({ data: { tenantId: alpha.id, branchId: alpha.headOfficeId, requestNo: `TE-${uniq()}`, customerId: person.id, corporateAccountId: account.id, serviceId: service.id, status: 'SUBMITTED' } });
      const res = await t.as(clerk).post(`/corporate-accounts/${account.id}/archive`, { reason: 'Leaving' }).expect(409);
      expect(res.body.code).toBe('CORPORATE_HAS_OPEN_REQUESTS');
      await t.sys.serviceRequest.update({ where: { id: request.id }, data: { status: 'CANCELLED' } });
      await t.as(clerk).post(`/corporate-accounts/${account.id}/archive`, { reason: 'Leaving' }).expect(200);
    });

    it('archiving ends the company\'s portal access immediately', async () => {
      const account = await activeAccount(t, alpha);
      const admin = await addCorporateAdmin(t, alpha, account.id);
      await t.as(admin).get('/corporate/account').expect(200);
      await t.as(clerk).post(`/corporate-accounts/${account.id}/archive`, { reason: 'Contract terminated' }).expect(200);
      await t.as(admin).get('/corporate/account').expect(401);
      await expect(t.login(admin.email, PASSWORD, 'corporate', alpha.slug)).rejects.toThrow(/login failed/);
      expect((await t.sys.tenantMembership.findUniqueOrThrow({ where: { id: admin.membershipId! } })).status).toBe('SUSPENDED');
      expect((await audit(alpha.id, 'corporate.account_archived', account.id))[0].after).toMatchObject({ portalAccessEnded: 1 });
    });
  });

  // ------------------------------------------------------------------ members
  describe('members (authorised contacts)', () => {
    it('invites a contact: placeholder user + INVITED corporate membership bound to the company; accepting gives portal access', async () => {
      const account = await activeAccount(t, alpha, { companyName: 'Invite Co LLC' });
      const email = `signatory-${uniq()}@example.test`;
      const invite = (await t.as(clerk).post(`/corporate-accounts/${account.id}/members`, { fullName: 'Huda Signatory', email: email.toUpperCase(), phone: '+971 50 222 3344', isAuthorisedSignatory: true }).expect(201)).body;
      expect(invite).toMatchObject({ corporateAccountId: account.id, fullName: 'Huda Signatory', email, phone: '+971502223344', role: 'ADMIN', isAuthorisedSignatory: true, status: 'INVITED', dev: { invitationToken: expect.any(String) } });

      const membership = await t.sys.tenantMembership.findFirstOrThrow({ where: { tenantId: alpha.id, userId: invite.userId, kind: 'CORPORATE' }, include: { role: true, user: true } });
      expect(membership).toMatchObject({ status: 'INVITED', corporateAccountId: account.id, customerId: null, invitedById: clerk.userId, role: { key: 'corporate_admin' }, user: { email, passwordHash: null } });
      const mail = t.messenger.lastFor(email, 'staff.invitation')!;
      expect(mail.data.link).toContain('accept-invitation?token=');
      expect(mail.data).toMatchObject({ name: 'Huda Signatory', role: 'Corporate Administrator' });
      expect((await audit(alpha.id, 'corporate.member_invited', account.id))[0].after).toMatchObject({ email, membershipId: membership.id, invitedByType: 'STAFF' });

      // Not usable before the invitation is accepted.
      await expect(t.login(email, PASSWORD, 'corporate', alpha.slug)).rejects.toThrow(/login failed/);
      const accepted = await t.http.post('/api/v1/auth/invitations/accept').send({ token: invite.dev.invitationToken, password: PASSWORD, app: 'corporate' }).expect(200);
      expect(accepted.body.session.membership).toMatchObject({ kind: 'CORPORATE', roleKey: 'corporate_admin', corporateAccountId: account.id });
      const login = await t.login(email, PASSWORD, 'corporate', alpha.slug);
      expect((await t.as(login).get('/corporate/account').expect(200)).body).toMatchObject({ id: account.id, companyName: 'Invite Co LLC' });
      const members = (await t.as(clerk).get(`/corporate-accounts/${account.id}/members`).expect(200)).body;
      expect(members).toEqual([expect.objectContaining({ id: invite.id, email, status: 'ACTIVE' })]);
      expect((await t.as(clerk).get(`/corporate-accounts/${account.id}`)).body.counters.members).toBe(1);
    });

    it('requires the corporatePortal plan feature', async () => {
      const basic = await t.createTenant({ plan: 'starter' });
      const account = await t.sys.corporateAccount.create({ data: { tenantId: basic.id, accountNo: 'CORP-000001', companyName: 'No Portal LLC', status: 'ACTIVE', verifiedAt: new Date() } });
      const res = await t.as(basic.owner).post(`/corporate-accounts/${account.id}/members`, { fullName: 'Nobody Yet', email: `np-${uniq()}@example.test` }).expect(402);
      expect(res.body).toMatchObject({ code: 'PLAN_LIMIT_REACHED', details: { limit: 'corporatePortal' } });
      expect(res.body.message).toMatch(/corporate portal is not included in your plan/i);
      expect(await t.sys.corporateMember.count({ where: { tenantId: basic.id } })).toBe(0);
      expect(await t.sys.tenantMembership.count({ where: { tenantId: basic.id, kind: 'CORPORATE' } })).toBe(0);
    });

    it('one login acts for one company: no second invitation, no attaching to another company', async () => {
      const one = await activeAccount(t, alpha);
      const two = await activeAccount(t, alpha, { companyName: 'Secret Rival LLC' });
      const email = `one-company-${uniq()}@example.test`;
      await t.as(clerk).post(`/corporate-accounts/${one.id}/members`, { fullName: 'First Invite', email }).expect(201);
      expect((await t.as(clerk).post(`/corporate-accounts/${one.id}/members`, { fullName: 'First Invite', email }).expect(409)).body.code).toBe('ALREADY_MEMBER');
      const other = await t.as(clerk).post(`/corporate-accounts/${two.id}/members`, { fullName: 'First Invite', email }).expect(409);
      expect(other.body.code).toBe('EMAIL_IN_USE');
      expect(await t.sys.corporateMember.count({ where: { corporateAccountId: two.id } })).toBe(0);
      await t.as(clerk).post(`/corporate-accounts/${one.id}/members`, { fullName: 'X', email: 'bad' }).expect(400);
    });

    it('re-sends a pending invitation; the earlier link stops working', async () => {
      const account = await activeAccount(t, alpha);
      const email = `resend-${uniq()}@example.test`;
      const invite = (await t.as(clerk).post(`/corporate-accounts/${account.id}/members`, { fullName: 'Slow Reader', email }).expect(201)).body;
      const again = (await t.as(clerk).post(`/corporate-accounts/${account.id}/members/${invite.id}/resend-invitation`).expect(200)).body;
      expect(again).toMatchObject({ status: 'SENT', dev: { invitationToken: expect.any(String) } });
      await t.http.post('/api/v1/auth/invitations/accept').send({ token: invite.dev.invitationToken, password: PASSWORD, app: 'corporate' }).expect(400);
      await t.http.post('/api/v1/auth/invitations/accept').send({ token: again.dev.invitationToken, password: PASSWORD, app: 'corporate' }).expect(200);
      expect((await t.as(clerk).post(`/corporate-accounts/${account.id}/members/${invite.id}/resend-invitation`).expect(409)).body.code).toBe('NOT_INVITED');
    });

    it('suspending a member ends their sessions at once; reactivating restores access', async () => {
      const account = await activeAccount(t, alpha);
      const admin = await addCorporateAdmin(t, alpha, account.id);
      const base = `/corporate-accounts/${account.id}/members/${admin.memberId}`;
      await t.as(admin).get('/corporate/account').expect(200);

      const suspended = (await t.as(clerk).patch(base, { status: 'SUSPENDED', isAuthorisedSignatory: false, fullName: 'Renamed Admin' }).expect(200)).body;
      expect(suspended).toMatchObject({ status: 'SUSPENDED', isAuthorisedSignatory: false, fullName: 'Renamed Admin' });
      await t.as(admin).get('/corporate/account').expect(401);
      await expect(t.login(admin.email, PASSWORD, 'corporate', alpha.slug)).rejects.toThrow(/login failed/);
      const sessions = await t.sys.session.findMany({ where: { userId: admin.userId, tenantId: alpha.id } });
      expect(sessions.length).toBeGreaterThan(0);
      expect(sessions.every((s) => s.revokedAt !== null && s.revokedReason === 'MEMBERSHIP_CHANGED')).toBe(true);

      expect((await t.as(clerk).patch(base, { status: 'ACTIVE' }).expect(200)).body.status).toBe('ACTIVE');
      const back = await t.login(admin.email, PASSWORD, 'corporate', alpha.slug);
      await t.as(back).get('/corporate/account').expect(200);
      expect((await audit(alpha.id, 'corporate.member_updated', account.id)).length).toBe(2);
    });

    it('removing a member ends access; the same person can be invited again later', async () => {
      const account = await activeAccount(t, alpha);
      const admin = await addCorporateAdmin(t, alpha, account.id);
      const pending = (await t.as(clerk).post(`/corporate-accounts/${account.id}/members`, { fullName: 'Never Accepted', email: `pending-${uniq()}@example.test` }).expect(201)).body;
      // An unanswered invitation cannot be "suspended"; it is withdrawn by removing the member.
      expect((await t.as(clerk).patch(`/corporate-accounts/${account.id}/members/${pending.id}`, { status: 'SUSPENDED' }).expect(409)).body.code).toBe('INVITATION_PENDING');
      await t.as(clerk).delete(`/corporate-accounts/${account.id}/members/${pending.id}`).expect(200);
      await t.http.post('/api/v1/auth/invitations/accept').send({ token: pending.dev.invitationToken, password: PASSWORD, app: 'corporate' }).expect(400);

      expect((await t.as(clerk).delete(`/corporate-accounts/${account.id}/members/${admin.memberId}`).expect(200)).body).toEqual({ status: 'REMOVED' });
      await t.as(admin).get('/corporate/account').expect(401);
      expect((await t.sys.tenantMembership.findUniqueOrThrow({ where: { id: admin.membershipId! } })).status).toBe('REMOVED');
      expect((await t.as(clerk).get(`/corporate-accounts/${account.id}/members`)).body).toEqual([]);
      await t.as(clerk).delete(`/corporate-accounts/${account.id}/members/${admin.memberId}`).expect(404);

      // Invited again: same membership row, new invitation, access restored after accepting.
      const again = (await t.as(clerk).post(`/corporate-accounts/${account.id}/members`, { fullName: 'Back Again', email: admin.email }).expect(201)).body;
      expect(again.id).toBe(admin.memberId);
      await t.http.post('/api/v1/auth/invitations/accept').send({ token: again.dev.invitationToken, app: 'corporate' }).expect(200);
      const login = await t.login(admin.email, PASSWORD, 'corporate', alpha.slug);
      expect(login.membershipId).toBe(admin.membershipId);
      await t.as(login).get('/corporate/account').expect(200);
    });
  });

  // ------------------------------------------------------------------ employees (staff)
  describe('employees (staff)', () => {
    it('creates an employee backed by a customer record of the company, with masked identity numbers', async () => {
      const account = await activeAccount(t, alpha);
      const eid = emiratesId();
      const pp = passport();
      const res = await t.as(clerk).post(`/corporate-accounts/${account.id}/employees`, {
        fullName: '  Ravi   Kumar ', fullNameAr: 'رافي كومار', email: 'Ravi.Kumar@Example.test', phone: '+971 55 123 0001', nationality: 'in', dateOfBirth: '1990-03-03',
        emiratesId: eid, emiratesIdExpiry: '2027-12-31', passportNo: pp.toLowerCase(), passportCountry: 'IN', passportExpiry: '2031-01-01', employeeNo: 'E-100', designation: 'Electrician',
      }).expect(201);
      expect(res.body).toMatchObject({
        corporateAccountId: account.id, employeeNo: 'E-100', designation: 'Electrician', status: 'ACTIVE', outcome: 'CREATED',
        fullName: 'Ravi Kumar', fullNameAr: 'رافي كومار', email: 'ravi.kumar@example.test', phone: '+971551230001', nationality: 'IN', dateOfBirth: '1990-03-03',
        emiratesIdMasked: `•••• ${eid.slice(-4)}`, emiratesIdExpiry: '2027-12-31', passportNoMasked: `•••• ${pp.slice(-4)}`, passportCountry: 'IN', passportExpiry: '2031-01-01',
        customerId: expect.any(String), customerNo: expect.stringMatching(/^CUS-\d{6}$/),
      });
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(eid);
      expect(text).not.toContain(pp);
      expect(text).not.toMatch(/Enc|Hash|Last4/);

      const person = await t.sys.customer.findUniqueOrThrow({ where: { id: res.body.customerId } });
      expect(person).toMatchObject({ tenantId: alpha.id, type: 'INDIVIDUAL', status: 'ACTIVE', corporateAccountId: account.id, fullName: 'Ravi Kumar', emiratesIdHash: blindIndex(alpha.id, 'emiratesId', eid), passportNoHash: blindIndex(alpha.id, 'passport', pp) });
      // The person was not present: nothing is recorded as their consent.
      expect(await t.sys.customerConsent.count({ where: { customerId: person.id } })).toBe(0);
      expect(await t.sys.consentRecord.count({ where: { customerId: person.id } })).toBe(0);
      const event = (await t.sys.outboxEvent.findMany({ where: { tenantId: alpha.id, type: 'customer.created' } })).find((e) => (e.payload as any).customerId === person.id)!;
      expect((event.payload as any).source).toBe('CORPORATE');
      expect((await audit(alpha.id, 'corporate.employee_added', account.id))[0].after).toMatchObject({ employeeId: res.body.id, customerId: person.id, reusedCustomer: false });
      expect((await audit(alpha.id, 'customer.created', person.id))[0].after).toMatchObject({ source: 'CORPORATE' });
      // Staff see the person in the customer list of that company.
      expect((await t.as(clerk).get(`/customers?corporateAccountId=${account.id}`)).body.data.map((c: any) => c.id)).toEqual([person.id]);
    });

    it('re-uses an existing customer of the same company when the passport or Emirates ID matches', async () => {
      const account = await activeAccount(t, alpha);
      const pp = passport();
      const eid = emiratesId();
      const existing = (await t.as(alpha.owner).post('/customers', { fullName: 'Known Person', passportNo: pp, emiratesId: eid, corporateAccountId: account.id }).expect(201)).body;
      const before = await t.sys.customer.count({ where: { tenantId: alpha.id } });

      const linked = (await t.as(clerk).post(`/corporate-accounts/${account.id}/employees`, employeeBody({ fullName: 'Known Person (typed differently)', passportNo: pp, employeeNo: 'E-7' })).expect(201)).body;
      expect(linked).toMatchObject({ outcome: 'LINKED_EXISTING_CUSTOMER', customerId: existing.id, customerNo: existing.customerNo, fullName: 'Known Person', employeeNo: 'E-7' });
      expect(await t.sys.customer.count({ where: { tenantId: alpha.id } })).toBe(before);
      expect((await audit(alpha.id, 'corporate.employee_added', account.id))[0].after).toMatchObject({ reusedCustomer: true, customerId: existing.id });

      // The same person again (by Emirates ID this time) is not added twice.
      const dup = await t.as(clerk).post(`/corporate-accounts/${account.id}/employees`, employeeBody({ passportNo: undefined, emiratesId: eid })).expect(409);
      expect(dup.body).toMatchObject({ code: 'EMPLOYEE_EXISTS', details: { employeeId: linked.id, status: 'ACTIVE' } });
      expect(await t.sys.corporateEmployee.count({ where: { corporateAccountId: account.id } })).toBe(1);
    });

    it('never attaches a customer from outside the company, even with a matching identity number', async () => {
      const account = await activeAccount(t, alpha);
      const rival = await activeAccount(t, alpha);
      const walkInPassport = passport();
      const rivalEid = emiratesId();
      const walkIn = (await t.as(alpha.owner).post('/customers', { fullName: 'Private Walk In', passportNo: walkInPassport }).expect(201)).body;
      const rivalEmployee = (await t.as(clerk).post(`/corporate-accounts/${rival.id}/employees`, employeeBody({ fullName: 'Rival Employee', emiratesId: rivalEid })).expect(201)).body;

      const a = (await t.as(clerk).post(`/corporate-accounts/${account.id}/employees`, employeeBody({ fullName: 'Same Passport', passportNo: walkInPassport })).expect(201)).body;
      const b = (await t.as(clerk).post(`/corporate-accounts/${account.id}/employees`, employeeBody({ fullName: 'Same Emirates ID', emiratesId: rivalEid })).expect(201)).body;
      expect(a).toMatchObject({ outcome: 'CREATED', fullName: 'Same Passport' });
      expect(b).toMatchObject({ outcome: 'CREATED', fullName: 'Same Emirates ID' });
      expect(a.customerId).not.toBe(walkIn.id);
      expect(b.customerId).not.toBe(rivalEmployee.customerId);
      // The outside records are untouched and still belong where they belonged.
      expect(await t.sys.customer.findUniqueOrThrow({ where: { id: walkIn.id } })).toMatchObject({ corporateAccountId: null, fullName: 'Private Walk In' });
      expect(await t.sys.customer.findUniqueOrThrow({ where: { id: rivalEmployee.customerId } })).toMatchObject({ corporateAccountId: rival.id });
      expect(await t.sys.corporateEmployee.count({ where: { customerId: walkIn.id } })).toBe(0);
      // Staff can still find the possible duplicate through the normal, staff-only duplicate check.
      const check = (await t.as(alpha.owner).post('/customers/duplicates/check', { passportNo: walkInPassport }).expect(200)).body;
      expect(check.candidates.map((c: any) => c.customer.id).sort()).toEqual([walkIn.id, a.customerId].sort());
    });

    it('bulk: up to 200 in one transaction; people already on the list are reported, not duplicated', async () => {
      const account = await activeAccount(t, alpha);
      const base = `/corporate-accounts/${account.id}/employees`;
      const already = (await t.as(clerk).post(base, employeeBody({ fullName: 'Already Here' })).expect(201)).body;
      const alreadyPassport = (await t.as(manager).get(`/customers/${already.customerId}/identity`).expect(200)).body.passportNo;
      const known = (await t.as(alpha.owner).post('/customers', { fullName: 'Known Customer', emiratesId: emiratesId(), corporateAccountId: account.id }).expect(201)).body;
      const knownEid = (await t.as(manager).get(`/customers/${known.id}/identity`)).body.emiratesId;
      const twice = passport();

      const res = await t.as(clerk).post(`${base}/bulk`, {
        employees: [
          employeeBody({ fullName: 'New One' }),
          employeeBody({ fullName: 'Already Here Again', passportNo: alreadyPassport }),
          employeeBody({ fullName: 'Known Customer', passportNo: undefined, emiratesId: knownEid }),
          employeeBody({ fullName: 'Listed Twice', passportNo: twice }),
          employeeBody({ fullName: 'Listed Twice (again)', passportNo: twice }),
          { fullName: 'No Documents Yet' },
        ],
      }).expect(201);
      expect(res.body).toMatchObject({ createdCount: 4, skippedCount: 2 });
      expect(res.body.created.map((e: any) => [e.index, e.outcome, e.fullName])).toEqual([[0, 'CREATED', 'New One'], [2, 'LINKED_EXISTING_CUSTOMER', 'Known Customer'], [3, 'CREATED', 'Listed Twice'], [5, 'CREATED', 'No Documents Yet']]);
      expect(res.body.skipped).toEqual([
        { index: 1, reason: 'ALREADY_EMPLOYEE', employeeId: already.id, fullName: 'Already Here' },
        { index: 4, reason: 'ALREADY_EMPLOYEE', employeeId: res.body.created[2].id, fullName: 'Listed Twice' },
      ]);
      expect(await t.sys.corporateEmployee.count({ where: { corporateAccountId: account.id } })).toBe(5);
      expect(JSON.stringify(res.body)).not.toContain(twice);

      // Validation is all-or-nothing: one bad row and nobody is created.
      const count = await t.sys.customer.count({ where: { tenantId: alpha.id } });
      const bad = await t.as(clerk).post(`${base}/bulk`, { employees: [employeeBody(), employeeBody({ emiratesId: '123' }), employeeBody({ fullName: 'Z' })] }).expect(400);
      expect(bad.body.details.map((d: any) => d.path)).toEqual(['employees.1.emiratesId', 'employees.2.fullName']);
      expect(await t.sys.customer.count({ where: { tenantId: alpha.id } })).toBe(count);
      await t.as(clerk).post(`${base}/bulk`, { employees: [] }).expect(400);
      await t.as(clerk).post(`${base}/bulk`, { employees: Array.from({ length: 201 }, (_, i) => ({ fullName: `Person ${i}` })) }).expect(400);
    });

    it('accepts a full batch of 200', async () => {
      const account = await activeAccount(t, alpha);
      const employees = Array.from({ length: 200 }, (_, i) => ({ fullName: `Batch Person ${i + 1}`, employeeNo: `B-${i + 1}`, passportNo: `B${String(1000000 + i)}` }));
      const res = await t.as(clerk).post(`/corporate-accounts/${account.id}/employees/bulk`, { employees }).expect(201);
      expect(res.body).toMatchObject({ createdCount: 200, skippedCount: 0 });
      expect(await t.sys.corporateEmployee.count({ where: { corporateAccountId: account.id } })).toBe(200);
      const numbers = (await t.sys.customer.findMany({ where: { corporateAccountId: account.id }, select: { customerNo: true } })).map((c) => c.customerNo);
      expect(new Set(numbers).size).toBe(200);
      const list = (await t.as(clerk).get(`/corporate-accounts/${account.id}/employees?pageSize=100&page=2&sort=employeeNo:asc`).expect(200)).body;
      expect(list.meta).toEqual({ page: 2, pageSize: 100, total: 200, totalPages: 2 });
    }, 120_000);

    it('lists, searches, updates and deactivates', async () => {
      const account = await activeAccount(t, alpha);
      const base = `/corporate-accounts/${account.id}/employees`;
      const zaid = (await t.as(clerk).post(base, employeeBody({ fullName: 'Zaid Mansour', employeeNo: 'E-2', designation: 'Driver' })).expect(201)).body;
      const amal = (await t.as(clerk).post(base, employeeBody({ fullName: 'Amal Yousef', employeeNo: 'E-1', designation: 'Accountant' })).expect(201)).body;
      const names = async (query = '') => (await t.as(receptionist).get(`${base}?${query}`).expect(200)).body.data.map((e: any) => e.fullName);
      expect(await names('sort=fullName:asc')).toEqual(['Amal Yousef', 'Zaid Mansour']);
      expect(await names('sort=employeeNo:desc')).toEqual(['Zaid Mansour', 'Amal Yousef']);
      expect(await names('q=zaid')).toEqual(['Zaid Mansour']);
      expect(await names('q=accountant')).toEqual(['Amal Yousef']);
      expect(await names('q=e-2')).toEqual(['Zaid Mansour']);
      expect((await t.as(receptionist).get(`${base}/${amal.id}`).expect(200)).body).toMatchObject({ id: amal.id, fullName: 'Amal Yousef' });

      const newPassport = passport();
      const updated = (await t.as(clerk).patch(`${base}/${zaid.id}`, { fullName: 'Zaid Al Mansour', designation: 'Senior Driver', passportNo: newPassport, nationality: 'JO', phone: '+971501110000' }).expect(200)).body;
      expect(updated).toMatchObject({ fullName: 'Zaid Al Mansour', designation: 'Senior Driver', passportNoMasked: `•••• ${newPassport.slice(-4)}`, nationality: 'JO', phone: '+971501110000', employeeNo: 'E-2' });
      expect(await t.sys.customer.findUniqueOrThrow({ where: { id: zaid.customerId } })).toMatchObject({ fullName: 'Zaid Al Mansour', passportNoHash: blindIndex(alpha.id, 'passport', newPassport) });
      // A colleague's identity number cannot be given to someone else.
      const amalPassport = (await t.as(manager).get(`/customers/${amal.customerId}/identity`)).body.passportNo;
      expect((await t.as(clerk).patch(`${base}/${zaid.id}`, { passportNo: amalPassport }).expect(409)).body.code).toBe('EMPLOYEE_EXISTS');
      await t.as(clerk).patch(`${base}/${zaid.id}`, { emiratesId: 'nope' }).expect(400);

      const off = (await t.as(clerk).patch(`${base}/${zaid.id}`, { status: 'INACTIVE' }).expect(200)).body;
      expect(off.status).toBe('INACTIVE');
      expect(await names()).toEqual(['Amal Yousef']);
      expect(await names('status=INACTIVE')).toEqual(['Zaid Al Mansour']);
      expect((await names('status=ALL')).sort()).toEqual(['Amal Yousef', 'Zaid Al Mansour']);
      // The person's customer record and history stay.
      expect((await t.sys.customer.findUniqueOrThrow({ where: { id: zaid.customerId } })).status).toBe('ACTIVE');
      expect((await t.as(clerk).post(base, employeeBody({ passportNo: newPassport })).expect(409)).body).toMatchObject({ code: 'EMPLOYEE_EXISTS', details: { status: 'INACTIVE' } });
      expect((await t.as(clerk).patch(`${base}/${zaid.id}`, { status: 'ACTIVE' }).expect(200)).body.status).toBe('ACTIVE');
      expect((await audit(alpha.id, 'corporate.employee_deactivated', account.id)).length).toBe(1);
      expect((await t.as(clerk).get(`/corporate-accounts/${account.id}`)).body.counters.employees).toBe(2);
    });

    it('deactivating an employee suspends a portal login tied to that employment', async () => {
      const account = await activeAccount(t, alpha);
      const employee = (await t.as(clerk).post(`/corporate-accounts/${account.id}/employees`, employeeBody()).expect(201)).body;
      const login = await addCorporateEmployeeLogin(t, alpha, account.id);
      await t.sys.tenantMembership.update({ where: { id: login.membershipId! }, data: { corporateEmployeeId: employee.id } });
      await t.as(login).get('/auth/me').expect(200);
      await t.as(clerk).patch(`/corporate-accounts/${account.id}/employees/${employee.id}`, { status: 'INACTIVE' }).expect(200);
      await t.as(login).get('/auth/me').expect(401);
      expect((await t.sys.tenantMembership.findUniqueOrThrow({ where: { id: login.membershipId! } })).status).toBe('SUSPENDED');
    });

    it('an employee is reachable only through its own company', async () => {
      const one = await activeAccount(t, alpha);
      const two = await activeAccount(t, alpha);
      const employee = (await t.as(clerk).post(`/corporate-accounts/${one.id}/employees`, employeeBody()).expect(201)).body;
      await t.as(clerk).get(`/corporate-accounts/${two.id}/employees/${employee.id}`).expect(404);
      await t.as(clerk).patch(`/corporate-accounts/${two.id}/employees/${employee.id}`, { designation: 'Moved' }).expect(404);
      expect((await t.as(clerk).get(`/corporate-accounts/${two.id}/employees`)).body.data).toEqual([]);
    });
  });

  // ------------------------------------------------------------------ agreements + prices
  describe('agreements and contract prices', () => {
    it('agreements: create, list, edit, delete', async () => {
      const account = await activeAccount(t, alpha);
      const base = `/corporate-accounts/${account.id}/agreements`;
      const a = (await t.as(clerk).post(base, { title: 'PRO services 2026', terms: 'Monthly invoice, 30 days.', startsOn: '2026-01-01', endsOn: '2026-12-31' }).expect(201)).body;
      expect(a).toMatchObject({ corporateAccountId: account.id, title: 'PRO services 2026', startsOn: '2026-01-01', endsOn: '2026-12-31', status: 'ACTIVE' });
      const open = (await t.as(clerk).post(base, { title: 'Open-ended typing', startsOn: '2027-01-01', status: 'DRAFT' }).expect(201)).body;
      expect(open).toMatchObject({ endsOn: null, status: 'DRAFT', terms: null });
      await t.as(clerk).post(base, { title: 'Backwards', startsOn: '2026-06-01', endsOn: '2026-05-31' }).expect(400);
      await t.as(clerk).post(base, { title: 'No start' }).expect(400);
      await t.as(clerk).post(base, { title: 'Bad status', startsOn: '2026-01-01', status: 'SIGNED' }).expect(400);

      expect((await t.as(receptionist).get(base).expect(200)).body.map((x: any) => x.id)).toEqual([open.id, a.id]);
      expect((await t.as(clerk).patch(`${base}/${a.id}`, { status: 'TERMINATED', endsOn: '2026-06-30' }).expect(200)).body).toMatchObject({ status: 'TERMINATED', endsOn: '2026-06-30', startsOn: '2026-01-01' });
      expect((await t.as(clerk).patch(`${base}/${a.id}`, { endsOn: '2025-01-01' }).expect(422)).body.code).toBe('INVALID_DATES');
      expect((await t.as(clerk).patch(`${base}/${a.id}`, { endsOn: null }).expect(200)).body.endsOn).toBeNull();
      await t.as(clerk).delete(`${base}/${open.id}`).expect(200);
      await t.as(clerk).delete(`${base}/${open.id}`).expect(404);
      expect((await audit(alpha.id, 'corporate.agreement_created', account.id)).length).toBe(2);
      expect((await audit(alpha.id, 'corporate.agreement_deleted', account.id)).length).toBe(1);
      // An agreement is reachable only through its own company.
      const other = await activeAccount(t, alpha);
      await t.as(clerk).patch(`/corporate-accounts/${other.id}/agreements/${a.id}`, { title: 'Hijack' }).expect(404);
      await t.as(clerk).delete(`/corporate-accounts/${other.id}/agreements/${a.id}`).expect(404);
    });

    it('contract prices: one per company and service, overriding only the service fee of the catalogue price', async () => {
      const account = await activeAccount(t, alpha);
      const other = await activeAccount(t, alpha);
      const service = await seedService(t, alpha, '100.00');
      const base = `/corporate-accounts/${account.id}/prices`;

      const set = (await t.as(clerk).put(base, { serviceId: service.id, serviceFee: '80' }).expect(200)).body;
      expect(set).toMatchObject({ serviceId: service.id, serviceName: service.name, serviceCode: service.code, contractServiceFee: '80.00', catalogueServiceFee: '100.00', currency: 'AED' });
      // Setting it again replaces the fee: still one row.
      const again = (await t.as(clerk).put(base, { serviceId: service.id, serviceFee: '75.50' }).expect(200)).body;
      expect(again).toMatchObject({ id: set.id, contractServiceFee: '75.50' });
      expect(await t.sys.corporatePrice.count({ where: { corporateAccountId: account.id, serviceId: service.id } })).toBe(1);
      expect((await t.as(receptionist).get(base).expect(200)).body).toEqual([expect.objectContaining({ id: set.id, contractServiceFee: '75.50' })]);
      expect((await t.as(receptionist).get(`/corporate-accounts/${other.id}/prices`)).body).toEqual([]);
      const logs = await audit(alpha.id, 'corporate.price_set', account.id);
      expect(logs.map((l) => [(l.before as any)?.serviceFee ?? null, (l.after as any).serviceFee])).toEqual([[null, '80.00'], ['80.00', '75.50']]);

      // The catalogue resolves the effective price with it: service fee replaced, government estimate untouched.
      const effective = (await t.as(alpha.owner).get(`/services/${service.id}/price?corporateAccountId=${account.id}`).expect(200)).body;
      expect(effective).toMatchObject({ serviceFee: '75.50', listServiceFee: '100.00', serviceFeeSource: 'CORPORATE_CONTRACT', governmentFeeEstimate: '50.00', taxAmount: '3.78', total: '129.28' });
      expect((await t.as(alpha.owner).get(`/services/${service.id}/price?corporateAccountId=${other.id}`)).body).toMatchObject({ serviceFee: '100.00', serviceFeeSource: 'CATALOGUE' });

      await t.as(clerk).put(base, { serviceId: service.id, serviceFee: '-1' }).expect(400);
      await t.as(clerk).put(base, { serviceId: service.id }).expect(400);
      await t.as(clerk).put(base, { serviceId: '00000000-0000-4000-8000-000000000000', serviceFee: '10' }).expect(404);
      await t.sys.service.update({ where: { id: service.id }, data: { deletedAt: new Date() } });
      await t.as(clerk).put(base, { serviceId: service.id, serviceFee: '10' }).expect(404);
      expect((await t.as(clerk).get(base)).body).toEqual([]);
      await t.sys.service.update({ where: { id: service.id }, data: { deletedAt: null } });

      await t.as(clerk).delete(`/corporate-accounts/${other.id}/prices/${set.id}`).expect(404);
      await t.as(clerk).delete(`${base}/${set.id}`).expect(200);
      expect((await t.as(alpha.owner).get(`/services/${service.id}/price?corporateAccountId=${account.id}`)).body.serviceFeeSource).toBe('CATALOGUE');
    });
  });

  // ------------------------------------------------------------------ staff permissions
  describe('staff permissions', () => {
    it('read-only staff can look but not change; customers and anonymous callers get nothing', async () => {
      const account = await activeAccount(t, alpha);
      const employee = (await t.as(clerk).post(`/corporate-accounts/${account.id}/employees`, employeeBody()).expect(201)).body;
      const service = await seedService(t, alpha);
      const base = `/corporate-accounts/${account.id}`;
      for (const path of ['', '/members', '/employees', `/employees/${employee.id}`, '/agreements', '/prices']) await t.as(receptionist).get(base + path).expect(200);
      await t.as(receptionist).get('/corporate-accounts').expect(200);

      await t.as(receptionist).post('/corporate-accounts', accountBody()).expect(403);
      await t.as(receptionist).patch(base, { notes: 'x' }).expect(403);
      await t.as(receptionist).post(`${base}/suspend`, { reason: 'Because' }).expect(403);
      await t.as(receptionist).post(`${base}/archive`, { reason: 'Because' }).expect(403);
      await t.as(receptionist).post(`${base}/reactivate`).expect(403);
      await t.as(receptionist).post(`${base}/credit`, { approved: true, creditLimit: '1', note: 'Because' }).expect(403);
      await t.as(receptionist).post(`${base}/members`, { fullName: 'No Way', email: 'no@example.test' }).expect(403);
      await t.as(receptionist).post(`${base}/employees`, employeeBody()).expect(403);
      await t.as(receptionist).post(`${base}/employees/bulk`, { employees: [employeeBody()] }).expect(403);
      await t.as(receptionist).patch(`${base}/employees/${employee.id}`, { designation: 'x' }).expect(403);
      await t.as(receptionist).post(`${base}/agreements`, { title: 'Nope', startsOn: '2026-01-01' }).expect(403);
      await t.as(receptionist).put(`${base}/prices`, { serviceId: service.id, serviceFee: '1' }).expect(403);

      for (const actor of [customer, null]) {
        const status = actor ? 403 : 401;
        await t.as(actor).get('/corporate-accounts').expect(status);
        await t.as(actor).get(base).expect(status);
        await t.as(actor).get(`${base}/employees`).expect(status);
        await t.as(actor).post('/corporate-accounts', accountBody()).expect(status);
      }
      // A typing operator has no corporate permission at all.
      const operator = await t.addStaff(alpha, 'operator');
      await t.as(operator).get('/corporate-accounts').expect(403);
      await t.as(operator).get(`${base}/employees`).expect(403);
    });
  });

  // ------------------------------------------------------------------ corporate portal
  describe('corporate portal', () => {
    let gamma: TenantFixture;
    let falcon: any, oryx: any;
    let falconAdmin: Actor & { memberId: string };
    let oryxAdmin: Actor & { memberId: string };
    let falconEmployee: any, oryxEmployee: any;
    let unrelated: any;
    let service: any, otherService: any;
    const oryxPassport = passport();

    beforeAll(async () => {
      gamma = await t.createTenant({ name: 'Gamma Typing' });
      falcon = await activeAccount(t, gamma, { companyName: 'Falcon Trading LLC', notes: 'INTERNAL: slow payer', creditLimit: '9000', paymentTermsDays: 30 });
      oryx = await activeAccount(t, gamma, { companyName: 'Oryx Logistics LLC', notes: 'INTERNAL: owner is a friend' });
      falconAdmin = await addCorporateAdmin(t, gamma, falcon.id);
      oryxAdmin = await addCorporateAdmin(t, gamma, oryx.id);
      falconEmployee = (await t.as(gamma.owner).post(`/corporate-accounts/${falcon.id}/employees`, employeeBody({ fullName: 'Falcon Worker', emiratesId: emiratesId() })).expect(201)).body;
      oryxEmployee = (await t.as(gamma.owner).post(`/corporate-accounts/${oryx.id}/employees`, employeeBody({ fullName: 'Oryx Worker', passportNo: oryxPassport })).expect(201)).body;
      unrelated = (await t.as(gamma.owner).post('/customers', { fullName: 'Unrelated Individual', phone: '+971509990001' }).expect(201)).body;
      service = await seedService(t, gamma, '100.00');
      otherService = await seedService(t, gamma, '200.00');
      await t.as(gamma.owner).put(`/corporate-accounts/${falcon.id}/prices`, { serviceId: service.id, serviceFee: '70' }).expect(200);
      await t.as(gamma.owner).put(`/corporate-accounts/${oryx.id}/prices`, { serviceId: otherService.id, serviceFee: '150' }).expect(200);
    });

    it('GET /corporate/account shows the own company without internal fields; credit only once approved', async () => {
      const mine = (await t.as(falconAdmin).get('/corporate/account').expect(200)).body;
      expect(mine).toMatchObject({ id: falcon.id, accountNo: falcon.accountNo, companyName: 'Falcon Trading LLC', status: 'ACTIVE', verified: true, credit: { approved: false, limit: null, paymentTermsDays: 0 }, counters: { employees: 1, members: 1 } });
      const text = JSON.stringify(mine);
      for (const internal of ['INTERNAL', 'notes', 'verifiedById', 'tenantId', 'Oryx', '9000']) expect(text).not.toContain(internal);
      await t.as(gamma.owner).post(`/corporate-accounts/${falcon.id}/credit`, { approved: true, note: 'Guarantee on file' }).expect(200);
      expect((await t.as(falconAdmin).get('/corporate/account')).body.credit).toEqual({ approved: true, limit: '9000.00', paymentTermsDays: 30 });
      expect((await t.as(oryxAdmin).get('/corporate/account')).body).toMatchObject({ id: oryx.id, companyName: 'Oryx Logistics LLC' });
    });

    it('a corporate user sees and changes only the employees of their own company', async () => {
      const list = (await t.as(falconAdmin).get('/corporate/employees').expect(200)).body;
      expect(list.data.map((e: any) => e.id)).toEqual([falconEmployee.id]);
      expect(list.meta.total).toBe(1);
      // The id of the person's record is given (the portal filters requests, documents and reminders by it);
      // the centre's internal customer number and record status are not exposed to the company.
      expect(list.data[0].customerId).toBe(falconEmployee.customerId);
      for (const key of ['customerNo', 'customerStatus']) expect(list.data[0]).not.toHaveProperty(key);
      expect(list.data[0].emiratesIdMasked).toMatch(/^•••• \d{4}$/);
      expect(JSON.stringify(list.body ?? list)).not.toMatch(/Enc|Hash|Last4/);
      expect((await t.as(falconAdmin).get('/corporate/employees?q=oryx&status=ALL')).body.data).toEqual([]);

      // The other company's employee does not exist as far as this user can tell.
      await t.as(falconAdmin).get(`/corporate/employees/${oryxEmployee.id}`).expect(404);
      await t.as(falconAdmin).patch(`/corporate/employees/${oryxEmployee.id}`, { designation: 'Poached', fullName: 'Renamed By Rival' }).expect(404);
      await t.as(falconAdmin).patch(`/corporate/employees/${oryxEmployee.id}`, { status: 'INACTIVE' }).expect(404);
      expect(await t.sys.corporateEmployee.findUniqueOrThrow({ where: { id: oryxEmployee.id }, include: { customer: true } })).toMatchObject({ status: 'ACTIVE', designation: 'Technician', customer: { fullName: 'Oryx Worker' } });

      // Own employees can be read and edited.
      expect((await t.as(falconAdmin).get(`/corporate/employees/${falconEmployee.id}`).expect(200)).body.fullName).toBe('Falcon Worker');
      const edited = (await t.as(falconAdmin).patch(`/corporate/employees/${falconEmployee.id}`, { designation: 'Supervisor', phone: '+971501234000' }).expect(200)).body;
      expect(edited).toMatchObject({ designation: 'Supervisor', phone: '+971501234000' });
      expect(edited.customerId).toBe(falconEmployee.customerId);
      expect(edited).not.toHaveProperty('customerNo');
      const log = (await audit(gamma.id, 'corporate.employee_updated', falcon.id)).pop()!;
      expect(log).toMatchObject({ actorType: 'CORPORATE', actorUserId: falconAdmin.userId });
    });

    it('new employees always land in the caller\'s own company, whatever the request says', async () => {
      const created = (await t.as(falconAdmin).post('/corporate/employees', { ...employeeBody({ fullName: 'Portal Hire' }), corporateAccountId: oryx.id, tenantId: beta.id, customerId: unrelated.id } as any).expect(201)).body;
      expect(created).toMatchObject({ fullName: 'Portal Hire', corporateAccountId: falcon.id, outcome: 'CREATED' });
      const stored = await t.sys.corporateEmployee.findUniqueOrThrow({ where: { id: created.id }, include: { customer: true } });
      expect(stored).toMatchObject({ tenantId: gamma.id, corporateAccountId: falcon.id, customer: { corporateAccountId: falcon.id, tenantId: gamma.id } });
      expect(stored.customerId).not.toBe(unrelated.id);
      expect((await t.as(oryxAdmin).get('/corporate/employees?status=ALL')).body.data.map((e: any) => e.id)).toEqual([oryxEmployee.id]);

      const bulk = (await t.as(falconAdmin).post('/corporate/employees/bulk', { employees: [employeeBody({ fullName: 'Bulk A' }), employeeBody({ fullName: 'Bulk B' })] }).expect(201)).body;
      expect(bulk).toMatchObject({ createdCount: 2, skippedCount: 0 });
      expect(bulk.created.every((e: any) => e.corporateAccountId === falcon.id && typeof e.customerId === 'string' && !('customerNo' in e))).toBe(true);
      expect((await audit(gamma.id, 'corporate.employee_added', falcon.id)).filter((l) => l.actorType === 'CORPORATE').length).toBe(3);
    });

    it('adding a person who works for another company, or is a private customer, reveals nothing and links nothing', async () => {
      const before = await t.sys.corporateEmployee.count({ where: { corporateAccountId: oryx.id } });
      // Falcon registers somebody with the passport number of an Oryx employee.
      const res = await t.as(falconAdmin).post('/corporate/employees', employeeBody({ fullName: 'Moonlighter', passportNo: oryxPassport })).expect(201);
      expect(res.body).toMatchObject({ outcome: 'CREATED', fullName: 'Moonlighter' });
      expect(JSON.stringify(res.body)).not.toContain('Oryx');
      const stored = await t.sys.corporateEmployee.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(stored.customerId).not.toBe(oryxEmployee.customerId);
      expect(await t.sys.corporateEmployee.count({ where: { corporateAccountId: oryx.id } })).toBe(before);
      expect((await t.sys.customer.findUniqueOrThrow({ where: { id: oryxEmployee.customerId } })).corporateAccountId).toBe(oryx.id);
      // No duplicate warning with other people's details is ever sent to a company.
      const samePhone = await t.as(falconAdmin).post('/corporate/employees', employeeBody({ fullName: 'Shares A Phone', phone: '+971509990001' })).expect(201);
      expect(JSON.stringify(samePhone.body)).not.toContain('Unrelated Individual');
    });

    it('a corporate user cannot reach staff endpoints, other companies or unrelated customers', async () => {
      const forbidden = [
        '/customers', `/customers/${unrelated.id}`, `/customers/${falconEmployee.customerId}`, `/customers/${oryxEmployee.customerId}`, `/customers/${falconEmployee.customerId}/identity`,
        `/customers/${unrelated.id}/notes`, '/customer-tags', '/corporate-accounts', `/corporate-accounts/${falcon.id}`, `/corporate-accounts/${oryx.id}`,
        `/corporate-accounts/${oryx.id}/employees`, `/corporate-accounts/${oryx.id}/members`, `/corporate-accounts/${oryx.id}/prices`, `/corporate-accounts/${falcon.id}/employees`,
        '/services', '/me/customer', '/me/consents',
      ];
      for (const path of forbidden) await t.as(falconAdmin).get(path).expect(403);
      await t.as(falconAdmin).post('/customers', { fullName: 'Made By Corporate' }).expect(403);
      await t.as(falconAdmin).post('/customers/duplicates/check', { passportNo: oryxPassport }).expect(403);
      await t.as(falconAdmin).post('/customers/merge', { sourceId: unrelated.id, targetId: falconEmployee.customerId, confirmSourceCustomerNo: unrelated.customerNo, reason: 'Take over' }).expect(403);
      await t.as(falconAdmin).patch(`/corporate-accounts/${falcon.id}`, { creditLimit: '999999' }).expect(403);
      await t.as(falconAdmin).post(`/corporate-accounts/${falcon.id}/verify`, VERIFY).expect(403);
      await t.as(falconAdmin).post(`/corporate-accounts/${falcon.id}/credit`, { approved: true, creditLimit: '999999', note: 'Self approval' }).expect(403);
      await t.as(falconAdmin).put(`/corporate-accounts/${falcon.id}/prices`, { serviceId: service.id, serviceFee: '0' }).expect(403);
      await t.as(falconAdmin).post(`/corporate-accounts/${oryx.id}/employees`, employeeBody()).expect(403);
      expect((await t.sys.corporateAccount.findUniqueOrThrow({ where: { id: falcon.id } })).creditLimit!.toFixed(2)).toBe('9000.00');
    });

    it('members: the company sees its own contacts and can invite a colleague', async () => {
      const mine = (await t.as(falconAdmin).get('/corporate/members').expect(200)).body;
      expect(mine).toEqual([expect.objectContaining({ id: falconAdmin.memberId, email: falconAdmin.email, status: 'ACTIVE', role: 'ADMIN' })]);
      for (const key of ['userId', 'tenantId', 'corporateAccountId']) expect(mine[0]).not.toHaveProperty(key);

      const email = `colleague-${uniq()}@example.test`;
      const invite = (await t.as(falconAdmin).post('/corporate/members', { fullName: 'Colleague Two', email, corporateAccountId: oryx.id } as any).expect(201)).body;
      expect(invite).toMatchObject({ status: 'INVITED', email, dev: { invitationToken: expect.any(String) } });
      expect(invite).not.toHaveProperty('userId');
      const row = await t.sys.corporateMember.findUniqueOrThrow({ where: { id: invite.id } });
      expect(row.corporateAccountId).toBe(falcon.id);
      expect((await audit(gamma.id, 'corporate.member_invited', falcon.id)).pop()!.after).toMatchObject({ email, invitedByType: 'CORPORATE' });
      await t.http.post('/api/v1/auth/invitations/accept').send({ token: invite.dev.invitationToken, password: PASSWORD, app: 'corporate' }).expect(200);
      const colleague = await t.login(email, PASSWORD, 'corporate', gamma.slug);
      expect((await t.as(colleague).get('/corporate/account')).body.id).toBe(falcon.id);
      expect((await t.as(colleague).get('/corporate/employees')).body.data.every((e: any) => e.corporateAccountId === falcon.id)).toBe(true);
      expect((await t.as(falconAdmin).get('/corporate/members')).body).toHaveLength(2);
      expect((await t.as(oryxAdmin).get('/corporate/members')).body.map((m: any) => m.email)).toEqual([oryxAdmin.email]);

      // Inviting somebody who already acts for another company fails without saying which company.
      const taken = await t.as(falconAdmin).post('/corporate/members', { fullName: 'Oryx Admin', email: oryxAdmin.email }).expect(409);
      expect(taken.body.code).toBe('EMAIL_IN_USE');
      expect(JSON.stringify(taken.body)).not.toMatch(/Oryx Logistics|CORP-/);
      expect((await t.sys.tenantMembership.findUniqueOrThrow({ where: { id: oryxAdmin.membershipId! } })).corporateAccountId).toBe(oryx.id);
      expect((await t.as(falconAdmin).post('/corporate/members', { fullName: 'Me Again', email: falconAdmin.email }).expect(409)).body.code).toBe('ALREADY_MEMBER');
    });

    it('prices: each company sees only its own contract prices', async () => {
      const mine = (await t.as(falconAdmin).get('/corporate/prices').expect(200)).body;
      expect(mine).toEqual([{ id: expect.any(String), serviceId: service.id, serviceName: service.name, serviceNameAr: null, contractServiceFee: '70.00', catalogueServiceFee: '100.00', currency: 'AED' }]);
      const theirs = (await t.as(oryxAdmin).get('/corporate/prices').expect(200)).body;
      expect(theirs.map((p: any) => [p.serviceId, p.contractServiceFee])).toEqual([[otherService.id, '150.00']]);
    });

    it('only authorised corporate users see employee personal data', async () => {
      const employeeLogin = await addCorporateEmployeeLogin(t, gamma, falcon.id);
      for (const path of ['/corporate/employees', `/corporate/employees/${falconEmployee.id}`, '/corporate/account', '/corporate/members', '/corporate/prices']) await t.as(employeeLogin).get(path).expect(403);
      await t.as(employeeLogin).post('/corporate/employees', employeeBody()).expect(403);
      await t.as(employeeLogin).patch(`/corporate/employees/${falconEmployee.id}`, { designation: 'Self promoted' }).expect(403);
      await t.as(employeeLogin).post('/corporate/members', { fullName: 'A Friend', email: `friend-${uniq()}@example.test` }).expect(403);
      // Staff, customers and anonymous callers have no business on the portal endpoints.
      for (const actor of [gamma.owner, await t.addCustomer(gamma)]) {
        for (const path of ['/corporate/account', '/corporate/employees', '/corporate/members', '/corporate/prices']) await t.as(actor).get(path).expect(403);
        await t.as(actor).post('/corporate/employees', employeeBody()).expect(403);
      }
      await t.as(null).get('/corporate/employees').expect(401);
      await t.as(null).get('/corporate/account').expect(401);
    });

    it('a company can read but not change anything until it is verified, and while it is suspended', async () => {
      const pending = await createAccount(t, gamma, { companyName: 'Pending Co LLC' });
      const admin = await addCorporateAdmin(t, gamma, pending.id);
      expect((await t.as(admin).get('/corporate/account').expect(200)).body).toMatchObject({ status: 'PENDING_VERIFICATION', verified: false });
      await t.as(admin).get('/corporate/employees').expect(200);
      const blocked = await t.as(admin).post('/corporate/employees', employeeBody()).expect(403);
      expect(blocked.body.code).toBe('CORPORATE_ACCOUNT_NOT_ACTIVE');
      expect(blocked.body.message).toMatch(/not verified your company yet/);
      await t.as(admin).post('/corporate/employees/bulk', { employees: [employeeBody()] }).expect(403);
      await t.as(admin).post('/corporate/members', { fullName: 'Too Early', email: `early-${uniq()}@example.test` }).expect(403);
      expect(await t.sys.corporateEmployee.count({ where: { corporateAccountId: pending.id } })).toBe(0);

      await t.as(gamma.owner).post(`/corporate-accounts/${pending.id}/verify`, VERIFY).expect(200);
      const employee = (await t.as(admin).post('/corporate/employees', employeeBody()).expect(201)).body;
      await t.as(gamma.owner).post(`/corporate-accounts/${pending.id}/suspend`, { reason: 'Overdue invoices' }).expect(200);
      expect((await t.as(admin).get('/corporate/account').expect(200)).body.status).toBe('SUSPENDED');
      const suspended = await t.as(admin).patch(`/corporate/employees/${employee.id}`, { designation: 'Blocked' }).expect(403);
      expect(suspended.body.message).toMatch(/suspended/);
      await t.as(admin).post('/corporate/employees', employeeBody()).expect(403);
      await t.as(gamma.owner).post(`/corporate-accounts/${pending.id}/reactivate`).expect(200);
      await t.as(admin).patch(`/corporate/employees/${employee.id}`, { designation: 'Allowed again' }).expect(200);
    });

    it('row-level security: a corporate session of another centre cannot see this centre at all', async () => {
      const betaAccount = await activeAccount(t, beta);
      const betaAdmin = await addCorporateAdmin(t, beta, betaAccount.id);
      expect((await t.as(betaAdmin).get('/corporate/employees?status=ALL')).body.data).toEqual([]);
      await t.as(betaAdmin).get(`/corporate/employees/${falconEmployee.id}`).expect(404);
      await t.as(betaAdmin).patch(`/corporate/employees/${falconEmployee.id}`, { designation: 'Cross tenant' }).expect(404);
      expect((await t.as(betaAdmin).get('/corporate/prices')).body).toEqual([]);
      expect((await t.as(betaAdmin).get('/corporate/account')).body.id).toBe(betaAccount.id);
      await expect(t.login(betaAdmin.email, PASSWORD, 'corporate', gamma.slug)).rejects.toThrow(/login failed/);
    });
  });

  // ------------------------------------------------------------------ tenant isolation (staff)
  describe('tenant isolation', () => {
    it('centre A staff cannot read, change or reference corporate data of centre B', async () => {
      const b = await activeAccount(t, beta, { companyName: 'Beta Secret Holdings' });
      const bAdmin = await addCorporateAdmin(t, beta, b.id);
      const bEmployee = (await t.as(beta.owner).post(`/corporate-accounts/${b.id}/employees`, employeeBody({ fullName: 'Beta Worker' })).expect(201)).body;
      const bAgreement = (await t.as(beta.owner).post(`/corporate-accounts/${b.id}/agreements`, { title: 'Beta agreement', startsOn: '2026-01-01' }).expect(201)).body;
      const bService = await seedService(t, beta);
      const bPrice = (await t.as(beta.owner).put(`/corporate-accounts/${b.id}/prices`, { serviceId: bService.id, serviceFee: '55' }).expect(200)).body;
      const own = await activeAccount(t, alpha);
      const ownService = await seedService(t, alpha);
      const a = t.as(alpha.owner);
      const base = `/corporate-accounts/${b.id}`;

      // Reads
      expect((await a.get('/corporate-accounts?status=ALL&pageSize=100')).body.data.every((x: any) => x.tenantId === alpha.id)).toBe(true);
      expect((await a.get('/corporate-accounts?q=Beta Secret')).body.data).toEqual([]);
      for (const path of ['', '/members', '/employees', `/employees/${bEmployee.id}`, '/agreements', '/prices']) await a.get(base + path).expect(404);
      await a.get(`/corporate-accounts/${own.id}/employees/${bEmployee.id}`).expect(404);

      // Writes on B's rows
      await a.patch(base, { companyName: 'Hijacked LLC' }).expect(404);
      await a.post(`${base}/verify`, VERIFY).expect(404);
      await a.post(`${base}/credit`, { approved: true, creditLimit: '1', note: 'Hijack' }).expect(404);
      await a.post(`${base}/suspend`, { reason: 'Hijack' }).expect(404);
      await a.post(`${base}/archive`, { reason: 'Hijack' }).expect(404);
      await a.post(`${base}/reactivate`).expect(404);
      await a.post(`${base}/members`, { fullName: 'Planted Admin', email: `planted-${uniq()}@example.test` }).expect(404);
      await a.patch(`${base}/members/${bAdmin.memberId}`, { status: 'SUSPENDED' }).expect(404);
      await a.delete(`${base}/members/${bAdmin.memberId}`).expect(404);
      await a.patch(`/corporate-accounts/${own.id}/members/${bAdmin.memberId}`, { status: 'SUSPENDED' }).expect(404);
      await a.delete(`/corporate-accounts/${own.id}/members/${bAdmin.memberId}`).expect(404);
      await a.post(`${base}/employees`, employeeBody()).expect(404);
      await a.post(`${base}/employees/bulk`, { employees: [employeeBody()] }).expect(404);
      await a.patch(`${base}/employees/${bEmployee.id}`, { designation: 'Hijacked' }).expect(404);
      await a.patch(`/corporate-accounts/${own.id}/employees/${bEmployee.id}`, { designation: 'Hijacked' }).expect(404);
      await a.post(`${base}/agreements`, { title: 'Planted', startsOn: '2026-01-01' }).expect(404);
      await a.patch(`/corporate-accounts/${own.id}/agreements/${bAgreement.id}`, { title: 'Hijacked' }).expect(404);
      await a.delete(`/corporate-accounts/${own.id}/agreements/${bAgreement.id}`).expect(404);
      await a.put(`${base}/prices`, { serviceId: ownService.id, serviceFee: '1' }).expect(404);
      await a.delete(`/corporate-accounts/${own.id}/prices/${bPrice.id}`).expect(404);

      // References to B's rows from A's records
      await a.put(`/corporate-accounts/${own.id}/prices`, { serviceId: bService.id, serviceFee: '1' }).expect(404);
      await a.post('/customers', { fullName: 'Cross Linked', corporateAccountId: b.id }).expect(404);
      await a.get(`/services/${ownService.id}/price?corporateAccountId=${b.id}`).expect(404);

      // B is exactly as it was and its admin still has access.
      expect(await t.sys.corporateAccount.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({ companyName: 'Beta Secret Holdings', status: 'ACTIVE', creditApproved: false });
      expect(await t.sys.corporateMember.count({ where: { corporateAccountId: b.id } })).toBe(1);
      expect(await t.sys.corporateEmployee.count({ where: { corporateAccountId: b.id } })).toBe(1);
      expect((await t.sys.corporateEmployee.findUniqueOrThrow({ where: { id: bEmployee.id } })).designation).toBe('Technician');
      expect((await t.sys.corporateAgreement.findUniqueOrThrow({ where: { id: bAgreement.id } })).title).toBe('Beta agreement');
      expect((await t.sys.corporatePrice.findMany({ where: { corporateAccountId: b.id } })).map((p) => p.serviceFee.toFixed(2))).toEqual(['55.00']);
      await t.as(bAdmin).get('/corporate/account').expect(200);
    });

    it('row-level security holds for unfiltered queries on every corporate table', async () => {
      await activeAccount(t, beta);
      for (const model of ['corporateAccount', 'corporateMember', 'corporateEmployee', 'corporateAgreement', 'corporatePrice'] as const) {
        const rows = (await t.inTenant(alpha.id, () => t.db.tx((tx) => (tx as any)[model].findMany({ select: { tenantId: true } })))) as Array<{ tenantId: string }>;
        expect([model, rows.every((r) => r.tenantId === alpha.id)]).toEqual([model, true]);
      }
      const betaAccount = await t.sys.corporateAccount.findFirstOrThrow({ where: { tenantId: beta.id } });
      await expect(
        t.inTenant(alpha.id, () => t.db.tx((tx) => tx.corporateMember.create({ data: { tenantId: alpha.id, corporateAccountId: betaAccount.id, fullName: 'Injected', email: 'injected@example.test' } }))),
      ).rejects.toThrow(/cross-tenant|violates|security/i);
    });
  });
});
