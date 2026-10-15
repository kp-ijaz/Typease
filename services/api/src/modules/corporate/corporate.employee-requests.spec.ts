import { Actor, PASSWORD, TenantFixture, TestApp, uniq } from '../../../test/helpers';
import { env } from '../../config/env';
import { hashPassword } from '../auth/auth.service';
import { enableSandbox } from '../finance/fixtures';
import { createDocument, emit, forceStatus } from '../requests/fixtures';
import { activeAccount, addCorporateAdmin, employeeBody, seedService } from './fixtures';

/**
 * A request that an employee creates in the corporate portal is a request of the company about that
 * employee: contract price, the company's administrators see it, approve its quotation, pay its
 * invoice and hear about it; the employee follows where it stands, without amounts. Administrators
 * filter requests, documents and reminders by one of THEIR employees.
 */
describe('Corporate employees in the corporate portal', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let manager: Actor;
  let falcon: { id: string; accountNo: string };
  let oryx: { id: string; accountNo: string };
  let falconAdmin: Actor;
  let oryxAdmin: Actor;
  let service: { id: string; name: string };
  let ravi: { id: string; customerId: string; email: string | null; fullName: string };
  let sana: { id: string; customerId: string; email: string | null; fullName: string };
  let omar: { id: string; customerId: string; email: string | null; fullName: string };
  let raviUser: Actor; // corporate portal login of the employee
  let raviPersonal: Actor; // the same person with a personal login to the customer portal

  const addEmployee = async (accountId: string, over: Record<string, unknown> = {}) => (await t.as(alpha.owner).post(`/corporate-accounts/${accountId}/employees`, employeeBody(over)).expect(201)).body;
  async function employeeActor(accountId: string, employee: { id: string; email: string | null }): Promise<Actor> {
    const invite = await t.as(alpha.owner).post(`/corporate-accounts/${accountId}/employees/${employee.id}/login`).expect(201);
    await t.http.post('/api/v1/auth/invitations/accept').send({ token: invite.body.dev.invitationToken, password: PASSWORD, app: 'corporate' }).expect(200);
    return t.login(employee.email!, PASSWORD, 'corporate', alpha.slug);
  }
  /** A personal account in the customer portal for a customer record that already exists. */
  async function personalLogin(customerId: string): Promise<Actor> {
    const email = `personal-${uniq()}@example.test`;
    const user = await t.sys.user.create({ data: { email, fullName: 'Ravi Kumar', passwordHash: await hashPassword(PASSWORD), emailVerifiedAt: new Date() } });
    const role = await t.sys.role.findFirstOrThrow({ where: { tenantId: alpha.id, key: 'customer' } });
    await t.sys.tenantMembership.create({ data: { tenantId: alpha.id, userId: user.id, roleId: role.id, kind: 'CUSTOMER', status: 'ACTIVE', customerId, joinedAt: new Date() } });
    return t.login(email, PASSWORD, 'customer', alpha.slug);
  }
  const notes = (eventKey: string, relatedId: string) => t.sys.notification.findMany({ where: { tenantId: alpha.id, eventKey, relatedId }, orderBy: { createdAt: 'asc' } });
  const forUser = (rows: Awaited<ReturnType<typeof notes>>, actor: Actor, channel = 'EMAIL') => rows.filter((r) => r.channel === channel && (channel === 'EMAIL' ? r.recipientAddress === actor.email : r.recipientUserId === actor.userId));
  const corporateUrl = () => env().CORPORATE_WEB_URL;
  const customerUrl = () => env().CUSTOMER_WEB_URL;

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    manager = await t.addStaff(alpha, 'manager');
    falcon = await activeAccount(t, alpha, { companyName: 'Falcon Trading LLC' });
    oryx = await activeAccount(t, alpha, { companyName: 'Oryx Logistics LLC' });
    falconAdmin = await addCorporateAdmin(t, alpha, falcon.id);
    oryxAdmin = await addCorporateAdmin(t, alpha, oryx.id);
    service = await seedService(t, alpha, '100.00');
    await t.as(alpha.owner).put(`/corporate-accounts/${falcon.id}/prices`, { serviceId: service.id, serviceFee: '80.00' }).expect(200);
    ravi = await addEmployee(falcon.id, { fullName: 'Ravi Kumar' });
    sana = await addEmployee(falcon.id, { fullName: 'Sana Iqbal' });
    omar = await addEmployee(oryx.id, { fullName: 'Omar Said' });
    raviUser = await employeeActor(falcon.id, ravi);
    raviPersonal = await personalLogin(ravi.customerId);
    await enableSandbox(t, alpha);
  });
  afterAll(() => t.close());

  describe('a request created by an employee', () => {
    let requestId: string;
    let requestNo: string;
    let quotationId: string;
    let invoiceId: string;

    it('is a request of the company about the employee, and of nobody else', async () => {
      // Nobody but themselves: not a colleague by employee id, not by customer id, not a stranger of another company.
      for (const body of [{ corporateEmployeeId: sana.id }, { customerId: sana.customerId }, { corporateEmployeeId: omar.id }, { customerId: omar.customerId }]) {
        const refused = await t.as(raviUser).post('/requests', { serviceId: service.id, ...body }).expect(403);
        expect(refused.body.code).toBe('EMPLOYEE_SELF_ONLY');
      }
      expect(await t.sys.serviceRequest.count({ where: { tenantId: alpha.id, customerId: { in: [sana.customerId, omar.customerId] } } })).toBe(0);
      // A company id in the body is ignored: the company is the one of the login.
      const created = await t.as(raviUser).post('/requests', { serviceId: service.id, corporateAccountId: oryx.id, instructions: 'Please renew before my trip.' } as any).expect(201);
      requestId = created.body.id;
      requestNo = created.body.requestNo;
      const row = await t.sys.serviceRequest.findUniqueOrThrow({ where: { id: requestId } });
      expect(row).toMatchObject({ customerId: ravi.customerId, corporateAccountId: falcon.id, source: 'CORPORATE', createdById: raviUser.userId, createdByType: 'CORPORATE' });
      // Naming themselves explicitly is the same thing.
      const explicit = await t.as(raviUser).post('/requests', { serviceId: service.id, corporateEmployeeId: ravi.id, customerId: ravi.customerId }).expect(201);
      expect(await t.sys.serviceRequest.findUniqueOrThrow({ where: { id: explicit.body.id } })).toMatchObject({ customerId: ravi.customerId, corporateAccountId: falcon.id });
      await t.as(raviUser).post(`/requests/${explicit.body.id}/cancel`, { reason: 'Created twice by mistake' }).expect(200);

      await t.as(raviUser).post(`/requests/${requestId}/submit`).expect(200);
      // The administrators of the company see it like any other request of the company; another company does not.
      const listed = (await t.as(falconAdmin).get('/requests').expect(200)).body.data;
      expect(listed.map((r: any) => r.id)).toContain(requestId);
      expect((await t.as(falconAdmin).get(`/requests/${requestId}`).expect(200)).body).toMatchObject({ id: requestId, customer: { id: ravi.customerId }, corporateAccount: { id: falcon.id } });
      await t.as(oryxAdmin).get(`/requests/${requestId}`).expect(404);
      expect(JSON.stringify((await t.as(oryxAdmin).get('/requests').expect(200)).body)).not.toContain(requestId);
    });

    it('is priced by the company contract; the employee follows the status without amounts and decides nothing', async () => {
      const built = await t.as(manager).post(`/quotations/from-request/${requestId}`, {}).expect(201);
      quotationId = built.body.id;
      expect(built.body.corporateAccountId).toBe(falcon.id);
      expect(JSON.stringify(built.body)).toContain('(contract price)');
      expect(built.body.subtotalServiceFee).toBe('80.00');
      await t.as(manager).post(`/quotations/${quotationId}/send`).expect(200);
      await t.settle();

      const seen = (await t.as(raviUser).get(`/requests/${requestId}`).expect(200)).body;
      expect(seen.finance).toEqual({ amountsHidden: true, quotation: { id: quotationId, quotationNo: built.body.quotationNo, status: 'SENT', validUntil: expect.anything(), sentAt: expect.any(String) }, invoices: [], totals: null });
      expect(JSON.stringify(seen.finance)).not.toContain('80.00');
      // The lists and the documents themselves stay closed, and so does every decision.
      await t.as(raviUser).get('/quotations').expect(403);
      await t.as(raviUser).get(`/quotations/${quotationId}`).expect(403);
      await t.as(raviUser).post(`/quotations/${quotationId}/approve`, {}).expect(403);
      await t.as(raviUser).post(`/quotations/${quotationId}/reject`, { reason: 'Too expensive for me' }).expect(403);
      await t.as(raviUser).get('/invoices').expect(403);
      await t.as(raviUser).get('/payments').expect(403);
      await t.as(raviUser).get('/corporate/invoices').expect(403);
      expect((await t.sys.quotation.findUniqueOrThrow({ where: { id: quotationId } })).status).toBe('SENT');

      // The administrator sees the amounts and approves; the invoice is the company's.
      const adminView = (await t.as(falconAdmin).get(`/requests/${requestId}`).expect(200)).body;
      expect(adminView.finance).toMatchObject({ amountsHidden: false, quotation: { id: quotationId, status: 'SENT', total: built.body.total } });
      await t.as(oryxAdmin).post(`/quotations/${quotationId}/approve`, {}).expect(404);
      const approved = await t.as(falconAdmin).post(`/quotations/${quotationId}/approve`, {}).expect(200);
      invoiceId = approved.body.invoice.id;
      if (approved.body.invoice.status === 'DRAFT') await t.as(manager).post(`/invoices/${invoiceId}/issue`).expect(200);
      await t.settle();
      const invoice = await t.sys.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
      expect(invoice).toMatchObject({ corporateAccountId: falcon.id, customerId: ravi.customerId, requestId });

      const after = (await t.as(raviUser).get(`/requests/${requestId}`).expect(200)).body.finance;
      expect(after).toMatchObject({ amountsHidden: true, quotation: { status: 'APPROVED' }, totals: null });
      expect(after.invoices).toEqual([{ id: invoiceId, invoiceNo: invoice.invoiceNo, status: invoice.status, issuedAt: expect.any(String), dueAt: expect.anything() }]);
      await t.as(raviUser).get(`/invoices/${invoiceId}`).expect(403);
      await t.as(raviUser).post(`/invoices/${invoiceId}/pay`, {}).expect(403);

      // The company's invoice list and statement show it, with the person and the request in words.
      const invoices = (await t.as(falconAdmin).get('/corporate/invoices').expect(200)).body;
      expect(JSON.stringify(invoices)).toContain(invoiceId);
      const statement = (await t.as(falconAdmin).get('/corporate/invoices/statement').expect(200)).body;
      expect(statement.invoices.find((i: any) => i.id === invoiceId)).toMatchObject({ customerId: ravi.customerId, customerName: 'Ravi Kumar', customerErased: false, requestNo });
      expect(JSON.stringify((await t.as(oryxAdmin).get('/corporate/invoices/statement').expect(200)).body)).not.toContain(invoiceId);
      // ... and the administrator can pay it online.
      if (invoice.status !== 'PAID') {
        const pay = await t.as(falconAdmin).post(`/invoices/${invoiceId}/pay`, {}).set('Idempotency-Key', uniq());
        expect([200, 201]).toContain(pay.status);
        expect(pay.body.checkoutUrl ?? pay.body.payment?.checkoutUrl ?? pay.body.url).toEqual(expect.any(String));
      }
    });

    it('tells the administrators of the company, with links into the corporate portal', async () => {
      // Quotation waiting for approval: the administrators who may approve are sent to the approval screen.
      const quotation = await notes('quotation.ready', quotationId);
      const adminMail = forUser(quotation, falconAdmin);
      expect(adminMail).toHaveLength(1);
      expect(adminMail[0]).toMatchObject({ recipientCustomerId: null, relatedType: 'Quotation', relatedId: quotationId });
      expect(adminMail[0].body).toContain(`${corporateUrl()}/approvals/${quotationId}`);
      expect(adminMail[0].body).not.toContain(customerUrl());
      expect(forUser(quotation, falconAdmin, 'IN_APP')).toHaveLength(1);
      // Nothing for the other company.
      expect(forUser(quotation, oryxAdmin)).toHaveLength(0);
      expect(forUser(quotation, oryxAdmin, 'IN_APP')).toHaveLength(0);

      // Invoice issued: the administrators who see the company's invoices are sent to the invoice.
      const invoice = await notes('payment.requested', invoiceId);
      expect(forUser(invoice, falconAdmin)).toHaveLength(1);
      expect(forUser(invoice, falconAdmin)[0].body).toContain(`${corporateUrl()}/invoices/${invoiceId}`);
      expect(forUser(invoice, oryxAdmin)).toHaveLength(0);

      // Request needs information / is completed.
      const askedId = (await emit(t, alpha.id, 'request.information_requested', { requestId, message: 'Please send the new passport copy.' })).id;
      const doneId = (await emit(t, alpha.id, 'request.completed', { requestId })).id;
      await t.settle();
      for (const [eventId, eventKey] of [[askedId, 'request.documents_missing'], [doneId, 'request.completed']] as const) {
        const rows = await t.sys.notification.findMany({ where: { tenantId: alpha.id, dedupeKey: { startsWith: `${eventId}:` } } });
        const mail = forUser(rows, falconAdmin);
        expect([eventKey, mail.length]).toEqual([eventKey, 1]);
        expect(mail[0]).toMatchObject({ eventKey, relatedType: 'ServiceRequest', relatedId: requestId });
        expect(mail[0].body).toContain(`${corporateUrl()}/requests/${requestId}`);
        expect(forUser(rows, falconAdmin, 'IN_APP')).toHaveLength(1);
        expect(forUser(rows, oryxAdmin)).toHaveLength(0);
        // The person the request is about is told as before - once, even with two logins.
        expect(rows.filter((r) => r.channel === 'EMAIL' && r.recipientCustomerId === ravi.customerId)).toHaveLength(1);
        // Both of their logins find it in the application.
        expect(forUser(rows, raviUser, 'IN_APP')).toHaveLength(1);
        expect(forUser(rows, raviPersonal, 'IN_APP')).toHaveLength(1);
      }

      // Document rejected: the person and the company's administrators, each once.
      const doc = await createDocument(t, alpha, { customerId: ravi.customerId, requestId, documentTypeKey: 'passport' });
      const rejectedId = (await emit(t, alpha.id, 'document.rejected', { documentId: doc.id, customerId: ravi.customerId, requestId, documentTypeKey: 'passport', reason: 'The photo page is cut off.' })).id;
      await t.settle();
      const rejected = await t.sys.notification.findMany({ where: { tenantId: alpha.id, dedupeKey: { startsWith: `${rejectedId}:` } } });
      expect(new Set(rejected.map((r) => r.eventKey))).toEqual(new Set(['document.rejected']));
      expect(rejected.every((r) => r.relatedType === 'Document' && r.relatedId === doc.id)).toBe(true);
      const adminRejected = forUser(rejected, falconAdmin);
      expect(adminRejected).toHaveLength(1);
      expect(adminRejected[0].subject).toBe('Please send your Passport again');
      expect(adminRejected[0].body).toContain('The photo page is cut off.');
      expect(adminRejected[0].body).toContain(requestNo);
      expect(adminRejected[0].body).toContain(`${corporateUrl()}/requests/${requestId}`);
      expect(rejected.filter((r) => r.channel === 'EMAIL' && r.recipientCustomerId === ravi.customerId)).toHaveLength(1);
      expect(forUser(rejected, oryxAdmin)).toHaveLength(0);

      // The administrator finds all of it in the inbox of the corporate portal.
      const inbox = (await t.as(falconAdmin).get('/me/notifications?pageSize=50').expect(200)).body.data;
      expect(new Set(inbox.map((n: any) => n.eventKey))).toEqual(new Set(['quotation.ready', 'payment.requested', 'request.documents_missing', 'request.completed', 'document.rejected']));
      expect((await t.as(oryxAdmin).get('/me/notifications').expect(200)).body.data).toEqual([]);
    });

    it('respects the preferences of an administrator and leaves personal requests of the same person alone', async () => {
      // An employee whose only login is the corporate one is sent to the corporate portal (their request), never to an approval screen.
      const sanaUser = await employeeActor(falcon.id, sana);
      const sanaRequest = (await t.as(sanaUser).post('/requests', { serviceId: service.id }).expect(201)).body;
      await t.as(sanaUser).post(`/requests/${sanaRequest.id}/submit`).expect(200);
      // One administrator switches request e-mails off: suppressed for them, stored, never dropped.
      await t.as(falconAdmin).put('/me/notification-preferences', { preferences: [{ channel: 'EMAIL', eventGroup: 'payments', enabled: false }] }).expect(200);
      const q = (await t.as(manager).post(`/quotations/from-request/${sanaRequest.id}`, {}).expect(201)).body;
      await t.as(manager).post(`/quotations/${q.id}/send`).expect(200);
      await t.settle();
      const rows = await notes('quotation.ready', q.id);
      const adminMail = forUser(rows, falconAdmin);
      expect(adminMail).toHaveLength(1);
      expect(adminMail[0]).toMatchObject({ status: 'SUPPRESSED', suppressedReason: 'OPT_OUT' });
      expect(forUser(rows, falconAdmin, 'IN_APP')).toHaveLength(1);
      const subject = rows.filter((r) => r.channel === 'EMAIL' && r.recipientCustomerId === sana.customerId);
      expect(subject).toHaveLength(1);
      expect(subject[0].body).toContain(`${corporateUrl()}/requests/${sanaRequest.id}`);
      expect(subject[0].body).not.toContain('/approvals/');
      expect(subject[0].body).not.toContain(customerUrl());
      await t.as(falconAdmin).put('/me/notification-preferences', { preferences: [{ channel: 'EMAIL', eventGroup: 'payments', enabled: true }] }).expect(200);

      // A personal request of the same person, made with their personal login, is not the company's business.
      const personal = (await t.as(raviPersonal).post('/requests', { serviceId: service.id }).expect(201)).body;
      const row = await t.sys.serviceRequest.findUniqueOrThrow({ where: { id: personal.id } });
      expect(row).toMatchObject({ customerId: ravi.customerId, corporateAccountId: null, source: 'ONLINE' });
      await t.as(raviPersonal).post(`/requests/${personal.id}/submit`).expect(200);
      const pq = (await t.as(manager).post(`/quotations/from-request/${personal.id}`, {}).expect(201)).body;
      expect(pq.subtotalServiceFee).toBe('100.00'); // list price: no contract
      await t.as(manager).post(`/quotations/${pq.id}/send`).expect(200);
      await t.settle();
      const personalRows = await notes('quotation.ready', pq.id);
      expect(forUser(personalRows, falconAdmin)).toHaveLength(0);
      expect(forUser(personalRows, falconAdmin, 'IN_APP')).toHaveLength(0);
      const own = personalRows.filter((r) => r.channel === 'EMAIL' && r.recipientCustomerId === ravi.customerId);
      expect(own).toHaveLength(1);
      expect(own[0].body).toContain(`${customerUrl()}/quotations/${pq.id}`);
      // The company does not see it; the personal login sees both, decides on its own and reads its amounts.
      await t.as(falconAdmin).get(`/requests/${personal.id}`).expect(404);
      expect(JSON.stringify((await t.as(falconAdmin).get(`/requests?customerId=${ravi.customerId}&pageSize=100`).expect(200)).body)).not.toContain(personal.id);
      // In the corporate portal the person still finds everything about themselves, without amounts and without a say.
      expect((await t.as(raviUser).get(`/requests/${personal.id}`).expect(200)).body.finance).toMatchObject({ amountsHidden: true, totals: null });
      await t.as(raviUser).post(`/quotations/${pq.id}/approve`, {}).expect(403);
      const mine = (await t.as(raviPersonal).get('/requests').expect(200)).body.data.map((r: any) => r.id);
      expect(mine).toEqual(expect.arrayContaining([personal.id, requestId]));
      expect((await t.as(raviPersonal).get(`/requests/${personal.id}`).expect(200)).body.finance).toMatchObject({ amountsHidden: false, quotation: { id: pq.id, total: pq.total } });
      await t.as(raviPersonal).post(`/quotations/${pq.id}/approve`, {}).expect(200);
    });

    it('is rated once, by the administrator or by the employee', async () => {
      await forceStatus(t, requestId, 'IN_PREPARATION');
      const early = await t.as(falconAdmin).post('/me/feedback', { requestId, rating: 5 }).expect(409);
      expect(early.body.code).toBe('NOT_COMPLETED');
      await forceStatus(t, requestId, 'COMPLETED', { completedAt: new Date() });
      expect((await t.as(falconAdmin).get(`/requests/${requestId}`).expect(200)).body).toMatchObject({ feedback: null, canRate: true });
      // Another company cannot rate it, and nobody can rate a request they cannot see.
      await t.as(oryxAdmin).post('/me/feedback', { requestId, rating: 1 }).expect(404);

      const rated = await t.as(falconAdmin).post('/me/feedback', { requestId, rating: 4, comment: 'Quick and clear.' }).expect(201);
      expect(rated.body).toMatchObject({ requestId, ticketId: null, rating: 4, comment: 'Quick and clear.' });
      // Stored against the person the request is about.
      expect(await t.sys.customerFeedback.findUniqueOrThrow({ where: { id: rated.body.id } })).toMatchObject({ tenantId: alpha.id, customerId: ravi.customerId, requestId, rating: 4 });
      const audit = await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: alpha.id, action: 'feedback.submitted', resourceId: rated.body.id } });
      expect(audit).toMatchObject({ actorUserId: falconAdmin.userId });
      // One rating per request, whoever gives it.
      for (const actor of [falconAdmin, raviUser, raviPersonal]) {
        const again = await t.as(actor).post('/me/feedback', { requestId, rating: 1 }).expect(409);
        expect(again.body.code).toBe('ALREADY_RATED');
      }
      expect(await t.sys.customerFeedback.count({ where: { tenantId: alpha.id, requestId } })).toBe(1);
      expect((await t.as(raviUser).get(`/requests/${requestId}`).expect(200)).body).toMatchObject({ feedback: { rating: 4, comment: 'Quick and clear.' }, canRate: false });

      const adminList = (await t.as(falconAdmin).get('/me/feedback').expect(200)).body.data;
      expect(adminList).toEqual([expect.objectContaining({ id: rated.body.id, kind: 'REQUEST', requestId, requestNo, rating: 4, customerId: ravi.customerId, customerName: 'Ravi Kumar' })]);
      expect((await t.as(oryxAdmin).get('/me/feedback').expect(200)).body.data).toEqual([]);
      expect((await t.as(raviUser).get('/me/feedback').expect(200)).body.data.map((f: any) => f.id)).toEqual([rated.body.id]);
      // The centre sees it in its satisfaction list.
      expect((await t.as(alpha.owner).get(`/support/feedback?customerId=${ravi.customerId}`).expect(200)).body.data.map((f: any) => f.id)).toEqual([rated.body.id]);

      // An employee rates their own completed company request when nobody has yet; a colleague's is not theirs.
      const second = (await t.as(falconAdmin).post('/requests', { serviceId: service.id, corporateEmployeeId: ravi.id }).expect(201)).body;
      const sanas = (await t.as(falconAdmin).post('/requests', { serviceId: service.id, corporateEmployeeId: sana.id }).expect(201)).body;
      await forceStatus(t, second.id, 'COMPLETED', { completedAt: new Date() });
      await forceStatus(t, sanas.id, 'COMPLETED', { completedAt: new Date() });
      await t.as(raviUser).post('/me/feedback', { requestId: sanas.id, rating: 5 }).expect(404);
      await t.as(raviUser).post('/me/feedback', { requestId: second.id, rating: 5 }).expect(201);
      // Tickets of a company have no customer record behind them: said clearly, not a bare 403.
      const ticket = (await t.as(falconAdmin).post('/me/tickets', { subject: 'Invoice question', message: 'Could you send the statement again?' }).expect(201)).body;
      const refused = await t.as(falconAdmin).post('/me/feedback', { ticketId: ticket.id, rating: 5 }).expect(422);
      expect(refused.body.code).toBe('TICKET_RATING_NOT_AVAILABLE');
    });
  });

  describe('filters for administrators', () => {
    it('exposes customerId on employees and filters requests, documents and reminders by an employee of the own company only', async () => {
      const employees = (await t.as(falconAdmin).get('/corporate/employees').expect(200)).body.data;
      expect(Object.fromEntries(employees.map((e: any) => [e.id, e.customerId]))).toMatchObject({ [ravi.id]: ravi.customerId, [sana.id]: sana.customerId });
      expect((await t.as(falconAdmin).get(`/corporate/employees/${ravi.id}`).expect(200)).body.customerId).toBe(ravi.customerId);
      // Staff-only details stay staff-only.
      expect(employees[0].customerNo).toBeUndefined();

      const raviRequest = (await t.as(falconAdmin).post('/requests', { serviceId: service.id, corporateEmployeeId: ravi.id }).expect(201)).body;
      const sanaRequest = (await t.as(falconAdmin).post('/requests', { serviceId: service.id, corporateEmployeeId: sana.id }).expect(201)).body;
      const omarRequest = (await t.as(oryxAdmin).post('/requests', { serviceId: service.id, corporateEmployeeId: omar.id }).expect(201)).body;
      const raviDoc = await createDocument(t, alpha, { customerId: ravi.customerId, requestId: raviRequest.id, documentTypeKey: 'passport' });
      const sanaDoc = await createDocument(t, alpha, { customerId: sana.customerId, documentTypeKey: 'passport' });
      const omarDoc = await createDocument(t, alpha, { customerId: omar.customerId, requestId: omarRequest.id, documentTypeKey: 'passport' });
      const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
      const raviReminder = (await t.as(alpha.owner).post('/reminders', { customerId: ravi.customerId, documentTypeKey: 'passport', expiryDate: inDays(60) }).expect(201)).body;
      const sanaReminder = (await t.as(alpha.owner).post('/reminders', { customerId: sana.customerId, documentTypeKey: 'passport', expiryDate: inDays(70) }).expect(201)).body;
      const omarReminder = (await t.as(alpha.owner).post('/reminders', { customerId: omar.customerId, documentTypeKey: 'passport', expiryDate: inDays(80) }).expect(201)).body;

      // Requests.
      const requests = (await t.as(falconAdmin).get(`/requests?customerId=${ravi.customerId}&pageSize=100`).expect(200)).body.data;
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.map((r: any) => r.id)).toContain(raviRequest.id);
      expect(requests.map((r: any) => r.id)).not.toContain(sanaRequest.id);
      expect(requests.every((r: any) => r.customer.id === ravi.customerId)).toBe(true);
      // Documents: with the name of the person and the request number.
      const documents = (await t.as(falconAdmin).get(`/documents?customerId=${ravi.customerId}&pageSize=100`).expect(200)).body.data;
      expect(documents.map((d: any) => d.id)).toContain(raviDoc.id);
      expect(documents.map((d: any) => d.id)).not.toContain(sanaDoc.id);
      expect(documents.find((d: any) => d.id === raviDoc.id)).toMatchObject({ customerId: ravi.customerId, customerName: 'Ravi Kumar', customerErased: false, requestNo: raviRequest.requestNo });
      expect((await t.as(falconAdmin).get(`/documents/${sanaDoc.id}`).expect(200)).body).toMatchObject({ customerName: 'Sana Iqbal', requestNo: null });
      // Reminders.
      const all = (await t.as(falconAdmin).get('/me/reminders?pageSize=100').expect(200)).body.data;
      expect(all.map((r: any) => r.id)).toEqual(expect.arrayContaining([raviReminder.id, sanaReminder.id]));
      expect(all.map((r: any) => r.id)).not.toContain(omarReminder.id);
      const reminders = (await t.as(falconAdmin).get(`/me/reminders?customerId=${ravi.customerId}`).expect(200)).body.data;
      expect(reminders.map((r: any) => r.id)).toEqual([raviReminder.id]);
      expect(reminders[0]).toMatchObject({ customerId: ravi.customerId, customerName: 'Ravi Kumar' });

      // An employee of ANOTHER company, a customer of nobody and an unknown id all give the same empty page.
      const stranger = await t.addCustomer(alpha);
      for (const id of [omar.customerId, stranger.customerId!, '6f1c2f0e-3a55-4c56-9a39-0d1f0a5a7e11']) {
        for (const path of ['/requests', '/documents', '/me/reminders']) {
          const res = await t.as(falconAdmin).get(`${path}?customerId=${id}`).expect(200);
          expect([path, id, res.body.data, res.body.meta.total]).toEqual([path, id, [], 0]);
        }
      }
      // ... and the other way round: Oryx cannot look at a Falcon employee.
      for (const path of ['/requests', '/documents', '/me/reminders']) {
        const res = await t.as(oryxAdmin).get(`${path}?customerId=${ravi.customerId}`).expect(200);
        expect([path, res.body.data]).toEqual([path, []]);
      }
      expect((await t.as(oryxAdmin).get(`/documents?customerId=${omar.customerId}`).expect(200)).body.data.map((d: any) => d.id)).toEqual([omarDoc.id]);
      await t.as(falconAdmin).get('/me/reminders?customerId=not-a-uuid').expect(400);
      // The employee's own filter cannot widen their view either.
      expect((await t.as(raviUser).get(`/me/reminders?customerId=${sana.customerId}`).expect(200)).body.data).toEqual([]);
      expect((await t.as(raviUser).get('/me/reminders').expect(200)).body.data.map((r: any) => r.id)).toEqual([raviReminder.id]);
    });
  });

  describe('renewals', () => {
    it('forgets the renewal request of a reminder when that request is cancelled', async () => {
      const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
      const reminder = (await t.as(alpha.owner).post('/reminders', { customerId: ravi.customerId, documentTypeKey: 'emirates_id', expiryDate: inDays(30) }).expect(201)).body;
      const other = (await t.as(alpha.owner).post('/reminders', { customerId: ravi.customerId, documentTypeKey: 'residence_visa', expiryDate: inDays(40) }).expect(201)).body;
      // An employee renews their own documents only.
      const sanas = (await t.as(alpha.owner).post('/reminders', { customerId: sana.customerId, documentTypeKey: 'emirates_id', expiryDate: inDays(30) }).expect(201)).body;
      await t.as(raviUser).post('/requests', { serviceId: service.id, renewalOfScheduleId: sanas.id }).expect(404);

      const renewal = (await t.as(raviUser).post('/requests', { serviceId: service.id, renewalOfScheduleId: reminder.id }).expect(201)).body;
      const kept = (await t.as(raviUser).post('/requests', { serviceId: service.id, renewalOfScheduleId: other.id }).expect(201)).body;
      expect((await t.sys.reminderSchedule.findUniqueOrThrow({ where: { id: reminder.id } })).renewalRequestId).toBe(renewal.id);
      expect((await t.as(raviUser).get('/me/reminders').expect(200)).body.data.find((r: any) => r.id === reminder.id).renewalRequestId).toBe(renewal.id);

      await t.as(raviUser).post(`/requests/${renewal.id}/cancel`, { reason: 'I will renew it myself' }).expect(200);
      expect((await t.sys.reminderSchedule.findUniqueOrThrow({ where: { id: reminder.id } })).renewalRequestId).toBeNull();
      // Only that reminder: the other renewal is still running.
      expect((await t.sys.reminderSchedule.findUniqueOrThrow({ where: { id: other.id } })).renewalRequestId).toBe(kept.id);
      expect((await t.as(raviUser).get('/me/reminders').expect(200)).body.data.find((r: any) => r.id === reminder.id).renewalRequestId).toBeNull();
      const audit = await t.sys.auditLog.findMany({ where: { tenantId: alpha.id, action: 'reminder.renewal_cleared', resourceId: reminder.id } });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ resourceType: 'ReminderSchedule', before: { renewalRequestId: renewal.id }, after: { renewalRequestId: null } });

      // A new renewal can be started from the same reminder.
      const again = (await t.as(raviUser).post('/requests', { serviceId: service.id, renewalOfScheduleId: reminder.id }).expect(201)).body;
      expect((await t.sys.reminderSchedule.findUniqueOrThrow({ where: { id: reminder.id } })).renewalRequestId).toBe(again.id);
      // Staff cancelling has the same effect.
      await t.as(manager).post(`/requests/${again.id}/cancel`, { reason: 'Customer changed their mind' }).expect(200);
      expect((await t.sys.reminderSchedule.findUniqueOrThrow({ where: { id: reminder.id } })).renewalRequestId).toBeNull();
    });
  });
});
