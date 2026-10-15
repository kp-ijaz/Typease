import { SEGREGATED_DUTIES, SYSTEM_ROLES } from '@typease/permissions';
import {
  Actor,
  aed,
  api,
  call,
  CaseFile,
  Centre,
  Company,
  createCompany,
  createService,
  CreatedService,
  Crew,
  fils,
  idempotencyKey,
  inviteStaff,
  inviteStaffWithPermissions,
  mayPass,
  NO_SUCH_ID,
  addCompanyEmployee,
  employeeLogin,
  fetchLink,
  runScheduledJob,
  nameParam,
  isIdParam,
  registerPortalCustomer,
  registerWalkInCustomer,
  Route,
  routeName,
  routeTable,
  runCase,
  signUpCentre,
  TestApp,
  uniq,
  urlOf,
} from '../support';

/**
 * Scenario 25: an unauthorised role cannot approve refunds - and the role
 * boundaries around it.
 *
 *   1. Who may approve a refund: only a holder of `refund.approve`.
 *   2. Segregation of duties: never the person who asked for it, whatever
 *      their role (the same rule for discounts).
 *   3. The permission matrix of `packages/permissions`, route by route: for
 *      every system role, every route of the application answers exactly as
 *      the matrix and the route's declared access rule say.
 *   4. A few refusals per role with real records, and the rules that are not
 *      in the matrix: branch scope, assigned requests, privilege escalation.
 */
describe('Role boundaries and refund approval (scenario 25)', () => {
  let t: TestApp;
  let centre: Centre;
  let crew: Crew;
  let manager: Actor;
  let accountant: Actor;
  let secondAccountant: Actor;
  let customer: Actor;
  let service: CreatedService;
  let paid: CaseFile;
  let platformAdmin: Actor;
  let routes: Route[];
  const id = uniq();

  const invoice = () => api(t, accountant).get(`/invoices/${paid.invoiceId}`);
  const payment = () => api(t, accountant).get(`/payments/${paid.paymentId}`);
  const refund = (refundId: string) => api(t, accountant).get(`/refunds/${refundId}`);
  const requestRefund = (actor: Actor, amount: string, reason: string, over: Record<string, unknown> = {}) =>
    api(t, actor).with({ 'Idempotency-Key': idempotencyKey() }).req('POST', '/refunds', { paymentId: paid.paymentId, invoiceId: paid.invoiceId, amount, reason, ...over });
  /** Number of "permission denied" security events recorded for a user (platform console). */
  const denials = async (userId: string) => (await api(t, platformAdmin).get(`/platform/security-events?type=PERMISSION_DENIED&userId=${userId}&pageSize=1`)).meta.total as number;

  beforeAll(async () => {
    t = await TestApp.create();
    platformAdmin = await t.createPlatformAdmin('SUPER_ADMIN');
    centre = await signUpCentre(t, { name: `Counter Centre ${id}` });
    await api(t, centre.owner).patch('/tenant', { taxRatePercent: 5 });
    service = await createService(t, centre.owner, {
      name: 'Visa application typing',
      categoryKey: 'visa',
      requiresApproval: true,
      price: { serviceFee: '400.00', governmentFeeEstimate: '600.00' },
      requirements: [{ documentTypeKey: 'passport', label: 'Passport copy', isMandatory: true }],
    });
    crew = { owner: centre.owner, receptionist: await inviteStaff(t, centre, 'receptionist'), reviewer: await inviteStaff(t, centre, 'reviewer'), operator: await inviteStaff(t, centre, 'operator') };
    manager = await inviteStaff(t, centre, 'manager');
    accountant = await inviteStaff(t, centre, 'accountant');
    secondAccountant = await inviteStaff(t, centre, 'accountant');
    customer = await registerPortalCustomer(t, centre, { fullName: `Refund Customer ${id}` });
    // One completed case, paid in cash: 400.00 + 5% + 600.00 = 1020.00.
    const plain = await createService(t, centre.owner, { name: 'Plain typing', price: { serviceFee: '400.00', governmentFeeEstimate: '600.00' }, requirements: [{ documentTypeKey: 'passport', label: 'Passport copy', isMandatory: true }] });
    paid = await runCase(t, crew, { serviceId: plain.id, branchId: centre.headOfficeId, portalCustomer: customer });
    expect(paid.total).toBe('1020.00');
    routes = routeTable(t);
    await t.settle();
  }, 300_000);
  afterAll(() => t.close());

  it('S25 unauthorised role cannot approve refunds', async () => {
    // The accountant asks for a refund of 120.00. It waits for somebody else's decision.
    const asked = await requestRefund(accountant, '120.00', 'Customer was charged for one page too many', { cancelCharge: true });
    expect(asked.status).toBe(201);
    const refundId = asked.body.id as string;
    expect(asked.body).toMatchObject({ status: 'REQUESTED', amount: '120.00' });
    const untouched = async () => {
      await t.settle();
      expect(await refund(refundId)).toMatchObject({ status: 'REQUESTED', amount: '120.00' });
      expect(await payment()).toMatchObject({ status: 'COMPLETED', amount: '1020.00', refundedAmount: '0.00' });
      expect(await invoice()).toMatchObject({ status: 'PAID', amountRefunded: '0.00', amountCredited: '0.00', balanceDue: '0.00' });
      expect((await api(t, accountant).get(`/credit-notes?invoiceId=${paid.invoiceId}`)).data).toEqual([]);
      expect((await api(t, accountant).get('/reports/refunds?range=today')).rows).toEqual([]);
    };
    await untouched();

    // The matrix says who holds what. (If somebody edits the matrix, this is the place that notices.)
    const holds = (role: string, permission: string) => (SYSTEM_ROLES[role].permissions as string[]).includes(permission);
    expect(Object.keys(SYSTEM_ROLES).filter((r) => holds(r, 'refund.approve')).sort()).toEqual(['accountant', 'owner']);
    expect(Object.keys(SYSTEM_ROLES).filter((r) => holds(r, 'refund.request')).sort()).toEqual(['accountant', 'manager', 'operator', 'owner']);
    expect(SEGREGATED_DUTIES).toEqual(expect.arrayContaining([{ request: 'refund.request', approve: 'refund.approve' }]));

    const decisions: Array<[string, unknown]> = [
      ['approve', { reference: 'Cash returned at the counter' }],
      ['approve', {}],
      ['approve', { cancelCharge: false, reference: 'x' }],
      ['complete', { reference: 'Cash returned at the counter' }],
      ['process', {}],
      ['reject', { reason: 'Not justified' }],
    ];
    // --- roles without any refund permission: they cannot even look at refunds
    const custom = await inviteStaffWithPermissions(t, centre, ['payment.read', 'payment.record', 'invoice.read', 'invoice.manage', 'refund.request', 'creditnote.manage', 'report.financial']);
    const strangers: Array<[string, Actor, boolean]> = [
      ['receptionist', crew.receptionist, false],
      ['reviewer', crew.reviewer, false],
      ['operator', crew.operator, true], // may ask for a refund ...
      ['manager', manager, true], // ... and so may the manager; neither may decide
      ['custom role with every finance permission except refund.approve', custom, true],
      ['customer', customer, false],
    ];
    for (const [label, actor, maySee] of strangers) {
      const before = await denials(actor.userId);
      for (const [action, body] of decisions) {
        const res = await api(t, actor).req('POST', `/refunds/${refundId}/${action}`, body);
        expect([label, action, res.status, res.body.code]).toEqual([label, action, 403, 'FORBIDDEN']);
      }
      // Each refusal is a recorded security event, attributed to the person.
      expect([label, (await denials(actor.userId)) - before]).toEqual([label, decisions.length]);
      const seen = await api(t, actor).req('GET', `/refunds/${refundId}`);
      // (an operator only sees refunds of requests assigned to them - this one is - and a customer never does)
      expect([label, seen.status]).toEqual([label, maySee ? 200 : 403]);
      expect([label, (await api(t, actor).req('GET', '/refunds')).status]).toEqual([label, maySee ? 200 : 403]);
      if (!maySee) {
        const ask = await requestRefund(actor, '1.00', 'I would like some money back');
        expect([label, ask.status]).toEqual([label, 403]);
      }
    }
    // Nobody signed in, a made-up token, the customer the money belongs to: no.
    expect((await api(t, null).req('POST', `/refunds/${refundId}/approve`, {})).status).toBe(401);
    expect((await t.http.post(`/api/v1/refunds/${refundId}/approve`).set('Authorization', 'Bearer not-a-token').send({})).status).toBe(401);
    // A role cannot be talked into it by the request either: no header, query or body field grants a permission.
    const pushy = await api(t, manager)
      .with({ 'x-role': 'owner', 'x-permissions': 'refund.approve', 'x-user-id': centre.owner.userId })
      .req('POST', `/refunds/${refundId}/approve?role=owner&permissions=refund.approve`, { reference: 'x', approvedById: centre.owner.userId, roleKey: 'owner', permissions: ['refund.approve'] });
    expect([pushy.status, pushy.body.code]).toEqual([403, 'FORBIDDEN']);
    // A manager cannot give themselves (or a friend) the permission: roles are not theirs to manage, and they
    // cannot invite somebody into a role that holds more than their own.
    expect((await api(t, manager).req('POST', '/roles', { key: `refunder_${id}`, name: 'Refunder', permissions: ['refund.approve'] })).status).toBe(403);
    const roles: any[] = await api(t, centre.owner).get('/roles');
    expect((await api(t, manager).req('PATCH', `/roles/${roles.find((r) => r.key === 'manager').id}`, { permissions: [...SYSTEM_ROLES.manager.permissions, 'refund.approve'] })).status).toBe(403);
    expect((await api(t, manager).req('PATCH', `/staff/${manager.membershipId}`, { roleKey: 'owner' })).status).toBe(403);
    const invite = await api(t, manager).req('POST', '/staff/invitations', { email: `friend-${id}@example.test`, fullName: 'A Friend', roleKey: 'accountant', allBranches: true });
    expect([invite.status, invite.body.code]).toEqual([403, 'PRIVILEGE_ESCALATION']);
    const inviteOwner = await api(t, manager).req('POST', '/staff/invitations', { email: `friend2-${id}@example.test`, fullName: 'Another Friend', roleKey: 'owner', allBranches: true });
    expect([inviteOwner.status, inviteOwner.body.code]).toEqual([403, 'PRIVILEGE_ESCALATION']);

    // After all of that: the refund is still waiting, and not a fils has moved.
    await untouched();
    const audit = await api(t, centre.owner).get(`/audit-logs?resourceType=Refund&resourceId=${refundId}&pageSize=100`);
    expect(audit.data.map((e: any) => e.action)).toEqual(['refund.requested']);

    // --- the authorised decision: a second person with refund.approve
    const approved = await api(t, secondAccountant).post(`/refunds/${refundId}/approve`, { reference: 'Cash voucher 0042' });
    expect(approved).toMatchObject({ status: 'COMPLETED', amount: '120.00' });
    await t.settle();
    expect(await payment()).toMatchObject({ status: 'PARTIALLY_REFUNDED', refundedAmount: '120.00' });
    expect(await invoice()).toMatchObject({ amountRefunded: '120.00', amountCredited: '120.00', balanceDue: '0.00' });
    expect((await api(t, accountant).get('/reports/refunds?range=today')).totals.amount).toBe('120.00');
    const trail = await api(t, centre.owner).get(`/audit-logs?resourceType=Refund&resourceId=${refundId}&pageSize=100`);
    const byAction = Object.fromEntries(trail.data.map((e: any) => [e.action, e.actorUserId]));
    expect(byAction['refund.requested']).toBe(accountant.userId);
    expect(Object.entries(byAction).filter(([action]) => action !== 'refund.requested').every(([, actor]) => actor === secondAccountant.userId)).toBe(true);
    expect(Object.keys(byAction).length).toBeGreaterThanOrEqual(2);
    // A decided refund cannot be decided again - by anybody.
    for (const actor of [secondAccountant, centre.owner]) expect((await api(t, actor).req('POST', `/refunds/${refundId}/approve`, { reference: 'again' })).status).toBe(409);
    expect((await api(t, centre.owner).req('POST', `/refunds/${refundId}/reject`, { reason: 'Too late' })).status).toBe(409);
    expect((await payment()).refundedAmount).toBe('120.00');
  }, 120_000);

  it('S25 segregation of duties: the person who requested a refund can never approve it - owner and accountant included', async () => {
    const refundedBefore = fils((await payment()).refundedAmount);

    // --- an accountant holds both permissions, and still cannot decide about their own request
    const own = await requestRefund(accountant, '50.00', 'Duplicate charge');
    expect(own.status).toBe(201);
    for (const [action, body] of [['approve', { reference: 'Paid out to myself' }], ['approve', {}], ['complete', { reference: 'Paid out to myself' }], ['process', {}]] as const) {
      const res = await api(t, accountant).req('POST', `/refunds/${own.body.id}/${action}`, body);
      expect([action, res.status, res.body.code]).toEqual([action, 403, 'SELF_APPROVAL_FORBIDDEN']);
    }
    expect(await refund(own.body.id)).toMatchObject({ status: 'REQUESTED' });
    expect(fils((await payment()).refundedAmount)).toBe(refundedBefore);

    // --- the owner of the centre is not above the rule
    const byOwner = await requestRefund(centre.owner, '30.00', 'Goodwill gesture');
    expect(byOwner.status).toBe(201);
    const self = await api(t, centre.owner).req('POST', `/refunds/${byOwner.body.id}/approve`, { reference: 'Owner pays out to the customer' });
    expect([self.status, self.body.code]).toEqual([403, 'SELF_APPROVAL_FORBIDDEN']);
    expect(await refund(byOwner.body.id)).toMatchObject({ status: 'REQUESTED' });

    // --- two steps, two people: approval (without a pay-out reference) by one, and the requester still cannot complete it
    const stepOne = await api(t, centre.owner).post(`/refunds/${own.body.id}/approve`, {});
    expect(stepOne.status).toBe('APPROVED');
    const finishOwn = await api(t, accountant).req('POST', `/refunds/${own.body.id}/complete`, { reference: 'I finish my own refund' });
    expect([finishOwn.status, finishOwn.body.code]).toEqual([403, 'SELF_APPROVAL_FORBIDDEN']);
    expect(fils((await payment()).refundedAmount)).toBe(refundedBefore); // approved is not paid out
    const done = await api(t, secondAccountant).post(`/refunds/${own.body.id}/complete`, { reference: 'Cash voucher 0043' });
    expect(done.status).toBe('COMPLETED');
    // ... and the owner's request is decided by an accountant.
    expect((await api(t, accountant).post(`/refunds/${byOwner.body.id}/approve`, { reference: 'Cash voucher 0044' })).status).toBe('COMPLETED');
    await t.settle();
    expect(fils((await payment()).refundedAmount)).toBe(refundedBefore + fils('80.00'));

    // --- an operator may ask; the decision is somebody else's, and a manager is not that somebody
    const byOperator = await requestRefund(crew.operator, '10.00', 'Wrong fee quoted at the desk');
    expect(byOperator.status).toBe(201);
    expect((await api(t, crew.operator).req('POST', `/refunds/${byOperator.body.id}/approve`, {})).status).toBe(403);
    expect((await api(t, manager).req('POST', `/refunds/${byOperator.body.id}/approve`, {})).status).toBe(403);
    const rejected = await api(t, accountant).post(`/refunds/${byOperator.body.id}/reject`, { reason: 'The fee was correct.' });
    expect(rejected.status).toBe('REJECTED');
    expect(fils((await payment()).refundedAmount)).toBe(refundedBefore + fils('80.00')); // a rejected refund moves nothing

    // --- a custom role does not get around it either: with both permissions the requester is still locked out
    const both = await inviteStaffWithPermissions(t, centre, ['refund.request', 'refund.approve', 'payment.read', 'invoice.read']);
    const byCustom = await requestRefund(both, '5.00', 'Rounding correction');
    expect(byCustom.status).toBe(201);
    const customSelf = await api(t, both).req('POST', `/refunds/${byCustom.body.id}/approve`, { reference: 'x' });
    expect([customSelf.status, customSelf.body.code]).toEqual([403, 'SELF_APPROVAL_FORBIDDEN']);
    // ... while somebody whose role only approves can decide it.
    const approverOnly = await inviteStaffWithPermissions(t, centre, ['refund.approve', 'payment.read']);
    expect((await requestRefund(approverOnly, '1.00', 'I cannot ask')).status).toBe(403);
    expect((await api(t, approverOnly).post(`/refunds/${byCustom.body.id}/approve`, { reference: 'Cash voucher 0045' })).status).toBe('COMPLETED');

    // --- two people at the same moment: one refund is decided once, and two requests cannot share the same money
    const contested = await requestRefund(crew.operator, '20.00', 'Decided by two people at once');
    const decisions = await Promise.all([
      api(t, accountant).req('POST', `/refunds/${contested.body.id}/approve`, { reference: 'Cash voucher 0046' }),
      api(t, secondAccountant).req('POST', `/refunds/${contested.body.id}/approve`, { reference: 'Cash voucher 0047' }),
      api(t, centre.owner).req('POST', `/refunds/${contested.body.id}/reject`, { reason: 'Decided otherwise' }),
    ]);
    expect(decisions.filter((d) => d.status === 200)).toHaveLength(1);
    expect(decisions.filter((d) => d.status !== 200).map((d) => d.status)).toEqual([409, 409]);
    const decided = await refund(contested.body.id);
    expect(['COMPLETED', 'REJECTED']).toContain(decided.status);
    const paidOut = decided.status === 'COMPLETED' ? fils('20.00') : 0n;
    await t.settle();
    expect(fils((await payment()).refundedAmount)).toBe(refundedBefore + fils('85.00') + paidOut);
    const remaining = fils('1020.00') - fils((await payment()).refundedAmount);
    const share = aed(remaining / 2n + 100n); // two of these do not fit into what is left
    const race = await Promise.all([requestRefund(accountant, share, 'First of two at once'), requestRefund(manager, share, 'Second of two at once')]);
    expect(race.map((r) => r.status).sort()).toEqual([201, 422]);
    expect(race.find((r) => r.status === 422)!.body.code).toBe('REFUND_EXCEEDS_PAYMENT');
    await api(t, centre.owner).post(`/refunds/${race.find((r) => r.status === 201)!.body.id}/reject`, { reason: 'Only a test of the race' });

    // --- the money: requested + approved + paid out can never exceed what was paid
    const left = fils('1020.00') - fils((await payment()).refundedAmount);
    const tooMuch = await requestRefund(secondAccountant, aed(left + 1n), 'More than was paid');
    expect([tooMuch.status, tooMuch.body.code]).toEqual([422, 'REFUND_EXCEEDS_PAYMENT']);
    const all = (await api(t, accountant).get(`/refunds?paymentId=${paid.paymentId}&pageSize=100`)).data as any[];
    const completed = all.filter((r) => r.status === 'COMPLETED');
    expect(aed(completed.reduce((sum, r) => sum + fils(r.amount), 0n))).toBe((await payment()).refundedAmount);
    // Every completed refund was requested by one person and decided by another.
    for (const r of completed) {
      const trail = (await api(t, centre.owner).get(`/audit-logs?resourceType=Refund&resourceId=${r.id}&pageSize=100`)).data as any[];
      const requester = trail.find((e) => e.action === 'refund.requested').actorUserId;
      const deciders = trail.filter((e) => e.action !== 'refund.requested').map((e) => e.actorUserId);
      expect(deciders.length).toBeGreaterThan(0);
      expect([r.refundNo, deciders.includes(requester)]).toEqual([r.refundNo, false]);
    }
  }, 120_000);

  it('S25 segregation of duties for discounts: whoever asks for a discount does not approve it', async () => {
    const person = await registerWalkInCustomer(t, crew.receptionist, { fullName: `Discount Customer ${id}` });
    const desk = api(t, crew.receptionist);
    const quotation = await desk.post('/quotations', { customerId: person.id, branchId: centre.headOfficeId, discountReason: 'Returning customer', items: [{ description: 'Typing', component: 'SERVICE_FEE', quantity: 1, unitAmount: '300.00', discountAmount: '90.00' }] }, 201);
    expect(quotation.discountApproval).toBe('PENDING');
    // Not sendable until somebody with the permission - and not the author - approves the discount.
    const early = await desk.req('POST', `/quotations/${quotation.id}/send`);
    expect([early.status, early.body.code]).toEqual([409, 'DISCOUNT_APPROVAL_REQUIRED']);
    for (const actor of [crew.receptionist, crew.operator, crew.reviewer, accountant]) {
      expect([actor.roleKey, (await api(t, actor).req('POST', `/quotations/${quotation.id}/discount/approve`, { note: 'Fine by me' })).status]).toEqual([actor.roleKey, 403]);
    }
    expect((await desk.get(`/quotations/${quotation.id}`)).discountApproval).toBe('PENDING');
    const approved = await api(t, manager).post(`/quotations/${quotation.id}/discount/approve`, { note: 'Approved for a returning customer' });
    expect(approved.discountApproval).toBe('APPROVED');
    expect((await desk.post(`/quotations/${quotation.id}/send`)).status).toBe('SENT');

    // A manager's own discount: the manager holds discount.approve and still needs somebody else.
    const own = await api(t, manager).post('/quotations', { customerId: person.id, branchId: centre.headOfficeId, discountReason: 'Manager special', items: [{ description: 'Typing', component: 'SERVICE_FEE', quantity: 1, unitAmount: '300.00', discountAmount: '150.00' }] }, 201);
    const self = await api(t, manager).req('POST', `/quotations/${own.id}/discount/approve`, { note: 'I approve my own discount' });
    expect([self.status, self.body.code]).toEqual([403, 'SELF_APPROVAL_FORBIDDEN']);
    expect((await api(t, manager).req('POST', `/quotations/${own.id}/send`)).status).toBe(409);
    expect((await api(t, centre.owner).post(`/quotations/${own.id}/discount/approve`, { note: 'Approved by the owner' })).discountApproval).toBe('APPROVED');
    // The same on a direct invoice: the author of a discount cannot issue it.
    const draft = await api(t, accountant).post('/invoices', { customerId: person.id, branchId: centre.headOfficeId, items: [{ description: 'Typing', component: 'SERVICE_FEE', quantity: 1, unitAmount: '100.00', discountAmount: '40.00' }] }, 201);
    expect((await api(t, accountant).req('POST', `/invoices/${draft.id}/issue`)).status).toBe(403);
    expect((await api(t, accountant).get(`/invoices/${draft.id}`)).status).toBe('DRAFT');
  });

  it('S25 the permission matrix holds on every route, for every system role', async () => {
    // The users: one per system role, all in this centre.
    const company: Company = await createCompany(t, centre, { companyName: `Matrix Trading ${id} LLC` });
    const employee = await addCompanyEmployee(t, company);
    const users: Record<string, Actor> = {
      manager,
      receptionist: crew.receptionist,
      operator: crew.operator,
      reviewer: crew.reviewer,
      accountant: secondAccountant,
      customer: await registerPortalCustomer(t, centre, { fullName: 'Matrix Customer' }),
      corporate_admin: company.admin,
      corporate_employee: await employeeLogin(t, centre, company, employee),
    };
    const guarded = routes.filter((r) => r.rule && r.rule.type !== 'public');
    expect(guarded.length).toBeGreaterThan(500);
    const wrong: string[] = [];
    const summary: Record<string, string> = {};

    for (const [role, actor] of Object.entries(users)) {
      const matrix = SYSTEM_ROLES[role];
      expect([role, actor.roleKey]).toEqual([role, role]);
      // The role as provisioned in the centre is the role of the matrix.
      const me = await api(t, actor).get('/auth/me');
      expect([role, [...me.permissions].sort()]).toEqual([role, [...matrix.permissions].sort()]);
      const before = await denials(actor.userId);
      let refusedByMatrix = 0;
      let open = 0;
      for (const r of guarded) {
        const res = await call(t, actor, r, urlOf(r, (param) => (isIdParam(param) ? NO_SUCH_ID : nameParam(param))), {});
        const name = `${role}: ${routeName(r)}`;
        const rule = r.rule!;
        if (rule.type === 'internal') {
          if (res.status !== 401) wrong.push(`${name} -> ${res.status} (machine route)`);
        } else if (rule.type === 'platform') {
          if (res.status !== 403 || res.body?.code !== 'PLATFORM_ONLY') wrong.push(`${name} -> ${res.status} ${res.body?.code} (platform route)`);
        } else if (!mayPass(rule, matrix)) {
          // Not in the matrix: refused by the guard, before the handler runs.
          refusedByMatrix += 1;
          if (res.status !== 403 || res.body?.code !== 'FORBIDDEN') wrong.push(`${name} -> ${res.status} ${res.body?.code} (the matrix does not allow it)`);
        } else {
          // In the matrix: the guard lets the call through. What comes back is the handler's answer for an id
          // that belongs to nothing and an empty body (404 / 400 / 200 ...) - never "sign in", never a crash.
          // (503 INTEGRATION_NOT_CONFIGURED is the honest answer of a feature that is switched off here: OCR.)
          open += 1;
          if (res.status === 401 || (res.status >= 500 && res.body?.code !== 'INTEGRATION_NOT_CONFIGURED')) wrong.push(`${name} -> ${res.status} ${res.body?.code} (the matrix allows it)`);
        }
      }
      // The guard refused exactly the routes the matrix closes - not one more (every refusal by the guard is a
      // security event; a handler that says "forbidden" for a finer rule does not write one).
      const refusedByGuard = (await denials(actor.userId)) - before;
      if (refusedByGuard !== refusedByMatrix) wrong.push(`${role}: the guard refused ${refusedByGuard} routes, the matrix closes ${refusedByMatrix}`);
      summary[role] = `${open} open, ${refusedByMatrix} closed`;
      expect([role, open > 15, refusedByMatrix > 30]).toEqual([role, true, true]);
    }
    expect(wrong).toEqual([]);
    // Narrower roles reach fewer routes than broader ones.
    const openOf = (role: string) => Number(summary[role].split(' ')[0]);
    expect(openOf('manager')).toBeGreaterThan(openOf('accountant'));
    expect(openOf('accountant')).toBeGreaterThan(openOf('customer'));
    expect(openOf('customer')).toBeGreaterThan(openOf('corporate_employee'));
  }, 600_000);

  it('a scheduled report file is opened through the report, by people who may see that report - not through the document vault', async () => {
    const acc = api(t, accountant);
    const schedule = await acc.post('/reports/scheduled', { reportKey: 'daily-sales', params: { range: 'today' }, format: 'XLSX', frequency: 'DAILY', recipients: [accountant.email, manager.email] }, 201);
    // Time travel (database): the schedule is due now instead of tomorrow morning; then the job that runs every 15 minutes.
    await t.sys.scheduledReport.update({ where: { id: schedule.id }, data: { nextRunAt: new Date(Date.now() - 60_000) } });
    await runScheduledJob(t, 'reports.scheduled');
    const runs = await acc.get(`/reports/scheduled/${schedule.id}/runs`);
    expect(runs.data).toHaveLength(1);
    expect(runs.data[0]).toMatchObject({ status: 'SUCCESS', document: { available: true } });
    const documentId = runs.data[0].documentId as string;
    const linkPath = `/reports/scheduled/${schedule.id}/runs/${documentId}/download-link`;

    // --- the vault does not know the file, whoever asks and whatever they hold (the owner holds every permission)
    for (const actor of [centre.owner, manager, accountant, crew.reviewer]) {
      const who = api(t, actor);
      for (const [method, path, body] of [
        ['GET', `/documents/${documentId}`, undefined],
        ['POST', `/documents/${documentId}/download-link`, {}],
        ['POST', `/documents/${documentId}/preview-link`, {}],
        ['POST', `/documents/${documentId}/shares`, {}],
        ['PATCH', `/documents/${documentId}`, { title: 'Renamed', customerVisible: true }],
        ['DELETE', `/documents/${documentId}`, undefined],
      ] as const) {
        const res = await who.req(method, path, body);
        // 404 for those who may use the route at all; 403 where the role does not even have the route.
        expect([actor.roleKey, `${method} ${path.replace(documentId, ':id')}`, [403, 404].includes(res.status)]).toEqual([actor.roleKey, `${method} ${path.replace(documentId, ':id')}`, true]);
      }
      const listed = await who.req('GET', '/documents?pageSize=100&includeDeleted=true');
      if (listed.status === 200) expect(listed.body.data.map((d: any) => d.id)).not.toContain(documentId);
    }
    expect((await api(t, centre.owner).req('GET', `/documents/${documentId}`)).status).toBe(404);

    // --- the report route: the permission of THAT report decides (daily sales is a financial report)
    const operationalOnly = await inviteStaffWithPermissions(t, centre, ['report.operational', 'report.export', 'document.read', 'document.share', 'document.delete']);
    for (const [label, actor, status] of [
      ['accountant', accountant, 200],
      ['manager', manager, 200],
      ['owner', centre.owner, 200],
      ['reviewer (reads documents, not reports)', crew.reviewer, 403],
      ['receptionist', crew.receptionist, 403],
      ['operator', crew.operator, 403],
      ['a role with operational reports, export and every document permission', operationalOnly, 403],
      ['customer', customer, 403],
    ] as const) {
      const res = await api(t, actor).req('POST', linkPath, {});
      expect([label, res.status]).toEqual([label, status]);
      if (status !== 200) expect(res.body.url).toBeUndefined();
    }
    expect((await api(t, null).req('POST', linkPath, {})).status).toBe(401);
    // The link gives the file: a spreadsheet, with today's figures in it.
    const link = await acc.post(linkPath, {}, 200);
    expect(link).toMatchObject({ disposition: 'attachment' });
    expect(new Date(link.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
    const file = await fetchLink(t, link.url);
    expect(file.status).toBe(200);
    expect((file.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    // The route opens report files only: another document id - a customer's passport copy - is not served by it.
    const passport = paid.inputs[0].documentId;
    expect((await acc.req('POST', `/reports/scheduled/${schedule.id}/runs/${passport}/download-link`, {})).status).toBe(404);
    expect((await acc.req('POST', `/reports/scheduled/${NO_SUCH_ID}/runs/${documentId}/download-link`, {})).status).toBe(404);
    // Each download is on the audit trail.
    const audit = await api(t, centre.owner).get('/audit-logs?action=report.scheduled_file_downloaded&pageSize=100');
    expect(audit.data.length).toBeGreaterThanOrEqual(4);
  });

  it('S25 each role is refused what is not its job - with real records', async () => {
    const person = await registerWalkInCustomer(t, crew.receptionist, { fullName: `Role Check ${id}`, passportNo: 'N7654321', passportCountry: 'IN' });
    const open = await runCase(t, crew, { serviceId: service.id, branchId: centre.headOfficeId, customerId: person.id, stopAt: 'IN_PREPARATION' });
    const waiting = await runCase(t, crew, { serviceId: service.id, branchId: centre.headOfficeId, customerId: person.id, stopAt: 'READY_FOR_PROCESSING' });
    const draft = await api(t, accountant).post('/invoices', { customerId: person.id, branchId: centre.headOfficeId, items: [{ description: 'Typing', component: 'SERVICE_FEE', quantity: 1, unitAmount: '90.00' }] }, 201);
    const pay = (invoiceId: string) => ({ method: 'CASH', amount: '1.00', branchId: centre.headOfficeId, allocations: [{ invoiceId, amount: '1.00' }] });
    const doc = open.inputs[0].documentId;
    type Check = [string, string, string, unknown?];
    const refusals: Record<string, { actor: Actor; no: Check[]; yes: Check[] }> = {
      receptionist: {
        actor: crew.receptionist,
        no: [
          ['reveal identity numbers', 'GET', `/customers/${person.id}/identity`],
          ['verify a document', 'POST', `/documents/${doc}/verify`, { decision: 'APPROVED' }],
          ['delete a document', 'DELETE', `/documents/${doc}`],
          ['assign a request', 'POST', `/requests/${waiting.requestId}/assign`, { assigneeMembershipId: crew.operator.membershipId, role: 'OPERATOR' }],
          ['complete a request', 'POST', `/requests/${open.requestId}/complete`],
          ['issue an invoice', 'POST', `/invoices/${draft.id}/issue`],
          ['void an invoice', 'POST', `/invoices/${open.invoiceId}/void`, { reason: 'Not my job' }],
          ['issue a credit note', 'POST', '/credit-notes', { invoiceId: open.invoiceId, amount: '1.00', reason: 'Not my job' }],
          ['archive a customer', 'POST', `/customers/${person.id}/archive`, { reason: 'Not my job' }],
          ['read financial reports', 'GET', '/reports/daily-sales?range=today'],
          ['read the audit trail', 'GET', '/audit-logs'],
          ['invite staff', 'POST', '/staff/invitations', { email: `r-${id}@example.test`, fullName: 'Not Allowed', roleKey: 'receptionist', allBranches: true }],
          ['change centre settings', 'PATCH', '/tenant', { name: 'Renamed by the receptionist' }],
          ['change a price', 'POST', `/services/${service.id}/prices`, { serviceFee: '1.00' }],
          ['see the subscription', 'GET', '/subscription'],
        ],
        yes: [['read a customer', 'GET', `/customers/${person.id}`], ['read a request', 'GET', `/requests/${open.requestId}`], ['read an invoice', 'GET', `/invoices/${open.invoiceId}`]],
      },
      operator: {
        actor: crew.operator,
        no: [
          ['register a customer', 'POST', '/customers', { type: 'INDIVIDUAL', fullName: 'Not Allowed' }],
          ['edit a customer', 'PATCH', `/customers/${person.id}`, { fullName: 'Renamed by the operator' }],
          ['create a request', 'POST', '/requests', { serviceId: service.id, customerId: person.id }],
          ['take a payment', 'POST', '/payments', pay(draft.id)],
          ['prepare a quotation', 'POST', `/quotations/from-request/${open.requestId}`, {}],
          ['issue an invoice', 'POST', `/invoices/${draft.id}/issue`],
          ['assign a request', 'POST', `/requests/${open.requestId}/assign`, { assigneeMembershipId: crew.operator.membershipId, role: 'OPERATOR' }],
          ['complete a request', 'POST', `/requests/${open.requestId}/complete`],
          ['cancel a request', 'POST', `/requests/${open.requestId}/cancel`, { reason: 'Not my job' }],
          ['delete a document', 'DELETE', `/documents/${doc}`],
          ['read financial reports', 'GET', '/reports/daily-sales?range=today'],
          ['list payments', 'GET', '/payments'],
          ['manage services', 'PATCH', `/services/${service.id}`, { name: 'Renamed by the operator' }],
        ],
        yes: [['read the assigned request', 'GET', `/requests/${open.requestId}`], ['read its document', 'GET', `/documents/${doc}`], ['comment on it', 'POST', `/requests/${open.requestId}/comments`, { body: 'Working on it.' }]],
      },
      reviewer: {
        actor: crew.reviewer,
        no: [
          ['register a customer', 'POST', '/customers', { type: 'INDIVIDUAL', fullName: 'Not Allowed' }],
          ['edit a customer', 'PATCH', `/customers/${person.id}`, { fullName: 'Renamed by the reviewer' }],
          ['create a request', 'POST', '/requests', { serviceId: service.id, customerId: person.id }],
          ['take a payment', 'POST', '/payments', pay(draft.id)],
          ['prepare a quotation', 'POST', `/quotations/from-request/${open.requestId}`, {}],
          ['read invoices', 'GET', `/invoices/${open.invoiceId}`],
          ['read quotations', 'GET', '/quotations'],
          ['assign a request', 'POST', `/requests/${open.requestId}/assign`, { assigneeMembershipId: crew.operator.membershipId, role: 'OPERATOR' }],
          ['process a request', 'POST', `/requests/${open.requestId}/workflow/complete-step`, { note: 'Not my job' }],
          ['upload a document', 'POST', '/documents/upload-intents', { customerId: person.id, documentTypeKey: 'other', filename: 'x.pdf', mime: 'application/pdf', sizeBytes: 300 }],
          ['delete a document', 'DELETE', `/documents/${doc}`],
          ['read reports', 'GET', '/reports/requests-by-status?range=today'],
          ['reveal identity numbers', 'GET', `/customers/${person.id}/identity`],
        ],
        yes: [['read a request', 'GET', `/requests/${open.requestId}`], ['read a document', 'GET', `/documents/${doc}`], ['get a document link', 'POST', `/documents/${doc}/download-link`, {}]],
      },
      accountant: {
        actor: accountant,
        no: [
          ['register a customer', 'POST', '/customers', { type: 'INDIVIDUAL', fullName: 'Not Allowed' }],
          ['create a request', 'POST', '/requests', { serviceId: service.id, customerId: person.id }],
          ['change a request', 'PATCH', `/requests/${open.requestId}`, { priority: 'URGENT' }],
          ['assign a request', 'POST', `/requests/${open.requestId}/assign`, { assigneeMembershipId: crew.operator.membershipId, role: 'OPERATOR' }],
          ['read a document', 'GET', `/documents/${doc}`],
          ['download a document', 'POST', `/documents/${doc}/download-link`, {}],
          ['verify a document', 'POST', `/documents/${doc}/verify`, { decision: 'APPROVED' }],
          ['reveal identity numbers', 'GET', `/customers/${person.id}/identity`],
          ['prepare a quotation', 'POST', `/quotations/from-request/${open.requestId}`, {}],
          ['approve a discount', 'POST', `/quotations/${open.quotationId}/discount/approve`, {}],
          ['change fee treatment', 'PUT', '/finance/fee-components', { components: [{ type: 'GOVERNMENT_FEE', treatment: 'REVENUE' }] }],
          ['invite staff', 'POST', '/staff/invitations', { email: `a-${id}@example.test`, fullName: 'Not Allowed', roleKey: 'receptionist', allBranches: true }],
          ['manage roles', 'POST', '/roles', { key: `acc_${id}`, name: 'Mine', permissions: ['customer.read'] }],
          ['read the audit trail', 'GET', '/audit-logs'],
          ['change centre settings', 'PATCH', '/tenant', { taxRatePercent: 0 }],
        ],
        yes: [['read an invoice', 'GET', `/invoices/${open.invoiceId}`], ['read financial reports', 'GET', '/reports/daily-sales?range=today'], ['read a payment', 'GET', `/payments/${open.paymentId}`]],
      },
      manager: {
        actor: manager,
        no: [
          ['approve a refund', 'POST', `/refunds/${NO_SUCH_ID}/approve`, {}],
          ['issue a credit note', 'POST', '/credit-notes', { invoiceId: open.invoiceId, amount: '1.00', reason: 'Not my job' }],
          ['reconcile payments', 'GET', '/reconciliations'],
          ['change fee treatment', 'PUT', '/finance/fee-components', { components: [{ type: 'GOVERNMENT_FEE', treatment: 'REVENUE' }] }],
          ['manage roles', 'POST', '/roles', { key: `mgr_${id}`, name: 'Mine', permissions: ['customer.read'] }],
          ['open a branch', 'POST', '/branches', { code: 'MG1', name: 'Not allowed' }],
          ['change centre settings', 'PATCH', '/tenant', { name: 'Renamed by the manager' }],
          ['change the branding', 'PUT', '/branding', { primaryColor: '#123456' }],
          ['add a domain', 'POST', '/domains', { domain: `mgr-${id}.example.ae` }],
          ['manage the subscription', 'POST', '/subscription/change-plan', { planKey: 'starter' }],
          ['configure integrations', 'GET', '/integrations'],
          ['handle privacy requests', 'GET', '/privacy/requests'],
          ['decide about support access', 'GET', '/support-access'],
          ['put a document on legal hold', 'PUT', `/documents/${doc}/legal-hold`, { legalHold: true, reason: 'Not my job' }],
        ],
        yes: [['read reports', 'GET', '/reports/daily-sales?range=today'], ['read staff', 'GET', '/staff'], ['reveal identity numbers', 'GET', `/customers/${person.id}/identity`], ['read the audit trail', 'GET', '/audit-logs']],
      },
    };
    const wrong: string[] = [];
    for (const [role, { actor, no, yes }] of Object.entries(refusals)) {
      for (const [what, method, path, body] of no) {
        const res = await api(t, actor).with(path === '/payments' ? { 'Idempotency-Key': idempotencyKey() } : {}).req(method as any, path, body);
        if (res.status !== 403) wrong.push(`${role} may not ${what}, but ${method} ${path.split('?')[0]} answered ${res.status} ${res.body?.code ?? ''}`);
      }
      for (const [what, method, path, body] of yes) {
        const res = await api(t, actor).req(method as any, path, body);
        if (res.status < 200 || res.status > 299) wrong.push(`${role} may ${what}, but ${method} ${path.split('?')[0]} answered ${res.status} ${res.body?.code ?? ''}`);
      }
    }
    expect(wrong).toEqual([]);
    // None of the refused calls left a trace in the records.
    expect((await api(t, centre.owner).get(`/customers/${person.id}`)).fullName).toBe(person.fullName);
    expect((await api(t, centre.owner).get(`/invoices/${draft.id}`)).status).toBe('DRAFT');
    expect((await api(t, centre.owner).get('/tenant')).name).toBe(centre.name);
    expect((await api(t, centre.owner).get(`/requests/${open.requestId}`)).status).toBe('IN_PREPARATION');

    // --- rules that are not in the matrix -------------------------------------------------------------
    // An operator sees only the requests assigned to them.
    const op = api(t, crew.operator);
    expect((await op.req('GET', `/requests/${waiting.requestId}`)).status).toBe(404);
    const mine = (await op.get('/requests?pageSize=100')).data.map((r: any) => r.id);
    expect(mine).toContain(open.requestId);
    expect(mine).not.toContain(waiting.requestId);
    expect((await op.req('POST', `/requests/${waiting.requestId}/transition`, { to: 'IN_PREPARATION' })).status).toBe(404);
    expect((await op.req('GET', `/invoices/${waiting.invoiceId}`)).status).toBe(404);
    // ... and what hangs off a request follows it: its documents (also as a link), quotation, invoice, tasks and comments.
    const notMine = waiting.inputs[0].documentId;
    const linked = await api(t, manager).post('/tasks', { title: `Check the file of ${waiting.requestNo}`, requestId: waiting.requestId }, 201);
    for (const [method, path, body] of [
      ['GET', `/documents/${notMine}`, undefined],
      ['POST', `/documents/${notMine}/download-link`, {}],
      ['POST', `/documents/${notMine}/preview-link`, {}],
      ['POST', `/documents/${notMine}/verify`, { decision: 'REJECTED', reason: 'Not my case' }],
      ['GET', `/quotations/${waiting.quotationId}`, undefined],
      ['GET', `/quotations/${waiting.quotationId}/pdf`, undefined],
      ['GET', `/invoices/${waiting.invoiceId}/pdf`, undefined],
      ['GET', `/requests/${waiting.requestId}/comments`, undefined],
      ['POST', `/requests/${waiting.requestId}/comments`, { body: 'Not my case' }],
      ['POST', `/requests/${waiting.requestId}/workflow/complete-step`, { note: 'Not my case' }],
      ['GET', `/tasks/${linked.id}`, undefined],
    ] as const) {
      expect([`${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')}`, (await op.req(method, path, body)).status]).toEqual([`${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')}`, 404]);
    }
    for (const path of ['/documents?pageSize=100', `/documents?requestId=${waiting.requestId}`, '/quotations?pageSize=100', '/invoices?pageSize=100', '/tasks?pageSize=100']) {
      const rows = (await op.get(path)).data.map((row: any) => row.id);
      for (const hidden of [notMine, waiting.quotationId, waiting.invoiceId, linked.id]) expect([path, rows.includes(hidden)]).toEqual([path, false]);
    }
    // (the same records of the assigned case are there for the operator)
    expect((await op.get(`/documents/${doc}`)).id).toBe(doc);
    expect((await op.get(`/quotations/${open.quotationId}`)).id).toBe(open.quotationId);
    expect((await op.get(`/invoices/${open.invoiceId}`)).id).toBe(open.invoiceId);
    // An operator cannot approve their own work, and a reviewer cannot be both operator and reviewer of a case.
    await op.post(`/requests/${open.requestId}/checklist`, { documentTypeKey: 'completed_document', label: 'Prepared application', isMandatory: false, kind: 'COMPLETION' }, [200, 201]);
    await op.post(`/requests/${open.requestId}/workflow/complete-step`, { note: 'Prepared.' }, [200, 201]);
    await t.settle();
    const pending = await api(t, crew.reviewer).get(`/requests/${open.requestId}`);
    expect(pending.status).toBe('PENDING_APPROVAL');
    const approval = (pending.approvals as any[]).find((x) => x.status === 'PENDING');
    expect((await op.req('POST', `/requests/${open.requestId}/approvals/${approval.id}/decide`, { decision: 'APPROVED' })).status).toBe(403);
    expect((await api(t, crew.reviewer).get(`/requests/${open.requestId}`)).status).toBe('PENDING_APPROVAL');

    // Branch scope: a receptionist of the second branch does not see, and cannot work on, cases of the head office.
    const branch2 = await api(t, centre.owner).post('/branches', { code: 'B2', name: 'Second Branch' }, 201);
    const limited = await inviteStaff(t, centre, 'receptionist', { branchIds: [branch2.id] });
    const l = api(t, limited);
    expect((await l.req('GET', `/requests/${open.requestId}`)).status).toBe(404);
    expect((await l.get('/requests?pageSize=100')).data).toEqual([]);
    expect((await l.req('GET', `/invoices/${open.invoiceId}`)).status).toBe(404);
    expect((await l.get('/payments?pageSize=100')).data).toEqual([]);
    const elsewhere = await l.req('POST', '/requests', { serviceId: service.id, customerId: person.id, branchId: centre.headOfficeId });
    expect([elsewhere.status, elsewhere.body.code]).toEqual([403, 'BRANCH_FORBIDDEN']);
    const takeMoney = await l.with({ 'Idempotency-Key': idempotencyKey() }).req('POST', '/payments', pay(open.invoiceId!));
    expect([403, 404]).toContain(takeMoney.status);
    // In their own branch they work normally.
    const own = await l.post('/requests', { serviceId: service.id, customerId: person.id, branchId: branch2.id }, 201);
    expect((await l.get('/requests?pageSize=100')).data.map((r: any) => r.id)).toEqual([own.id]);

    // A suspended colleague is out at once, with the token they already hold; reinstated, they are back.
    const before = await l.req('GET', '/customers');
    expect(before.status).toBe(200);
    await api(t, centre.owner).patch(`/staff/${limited.membershipId}`, { status: 'SUSPENDED' });
    expect((await l.req('GET', '/customers')).status).toBe(401);
    // A changed role never lingers in an old session: the sessions of the colleague are ended, and the next
    // sign-in carries the new role - in both directions.
    const colleague = await inviteStaff(t, centre, 'receptionist');
    expect((await api(t, colleague).req('GET', '/reports/daily-sales?range=today')).status).toBe(403);
    await api(t, centre.owner).patch(`/staff/${colleague.membershipId}`, { roleKey: 'accountant' });
    expect((await api(t, colleague).req('GET', '/customers')).status).toBe(401);
    const asAccountant = await t.login(colleague.email);
    expect(asAccountant.roleKey).toBe('accountant');
    expect((await api(t, asAccountant).req('GET', '/reports/daily-sales?range=today')).status).toBe(200);
    await api(t, centre.owner).patch(`/staff/${colleague.membershipId}`, { roleKey: 'receptionist' });
    expect((await api(t, asAccountant).req('GET', '/reports/daily-sales?range=today')).status).toBe(401);
    expect((await api(t, await t.login(colleague.email)).req('GET', '/reports/daily-sales?range=today')).status).toBe(403);
  }, 300_000);
});
