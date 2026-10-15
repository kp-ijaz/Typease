import { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { env, loadEnv } from '../../config/env';
import {
  addCorporateAdmin, buildSandboxWebhook, createCorporate, createCustomer, createRequest, createService, enableSandbox, issueInvoice, line, listen, outbox, postSandboxWebhook, recordPayment, sessionRefOf,
} from './fixtures';
import { sandboxFormToken } from './gateways/sandbox.controller';
import { CHECKOUT_EXPIRED_REASON, EXPIRE_CHECKOUTS_JOB, ONLINE_CHECKOUT_LIFETIME_MINUTES } from './payments.service';

const MINUTE = 60_000;
/** End of the due day (23:59:59.999) on a calendar with a fixed offset from UTC. */
const endOfDay = (issuedAt: string, termsDays: number, offsetHours: number) => {
  const local = new Date(new Date(issuedAt).getTime() + offsetHours * 3_600_000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + termsDays + 1) - offsetHours * 3_600_000 - 1).toISOString();
};
const sandboxPath = (checkoutUrl: string) => new URL(checkoutUrl).pathname;

describe('Finance as customers see it: due dates, visibility, abandoned checkouts, the sandbox page', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let accountant: Actor;
  let manager: Actor;
  let customer: Actor;
  let otherCustomer: Actor;

  beforeAll(async () => {
    t = await listen(await TestApp.create());
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    accountant = await t.addStaff(alpha, 'accountant');
    manager = await t.addStaff(alpha, 'manager');
    customer = await t.addCustomer(alpha, { fullName: 'Aisha Khan' });
    otherCustomer = await t.addCustomer(alpha, { fullName: 'Omar Said' });
    await enableSandbox(t, alpha);
  });
  afterAll(() => t.close());

  const quotationFor = async (customerId: string, extra: Record<string, unknown> = {}) => {
    const q = await t.as(manager).post('/quotations', { customerId, items: [line('SERVICE_FEE', '100.00'), line('GOVERNMENT_FEE', '200.00')], ...extra }).expect(201);
    await t.as(manager).post(`/quotations/${q.body.id}/send`).expect(200);
    return q.body.id as string;
  };

  // ------------------------------------------------------------------ (a) due dates
  describe('due dates and "overdue"', () => {
    it('an invoice created by approving a quotation is due at the end of the day, not overdue the moment it exists', async () => {
      const quotationId = await quotationFor(customer.customerId!);
      const approved = await t.as(customer).post(`/quotations/${quotationId}/approve`, {}).expect(200);
      const invoice = (await t.as(customer).get(`/invoices/${approved.body.invoice.id}`).expect(200)).body;
      // No terms configured: due on receipt = payable until the end of today on the centre's calendar (Asia/Dubai).
      expect(invoice.dueAt).toBe(endOfDay(invoice.issuedAt, 0, 4));
      expect(approved.body.invoice.dueAt).toBe(invoice.dueAt);
      expect(new Date(invoice.dueAt).getTime()).toBeGreaterThan(Date.now());
      expect(invoice).toMatchObject({ status: 'ISSUED', overdue: false });
      // Nowhere does it count as overdue: not in the lists, not for staff, not in the request it belongs to.
      for (const actor of [customer, accountant]) {
        expect((await t.as(actor).get('/invoices?overdue=true&pageSize=100').expect(200)).body.data.map((i: any) => i.id)).not.toContain(invoice.id);
        expect((await t.as(actor).get('/invoices?pageSize=100').expect(200)).body.data.find((i: any) => i.id === invoice.id).overdue).toBe(false);
      }
      expect((await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: alpha.id, action: 'invoice.issued', resourceId: invoice.id } })).after).toMatchObject({ termsDays: 0, viaQuotation: true });
    });

    it('uses the centre\'s default terms, and a company\'s own terms when its credit is approved', async () => {
      await t.as(alpha.owner).patch('/tenant/settings', { invoiceDueDays: 7 }).expect(200);
      try {
        const approved = await t.as(customer).post(`/quotations/${await quotationFor(customer.customerId!)}/approve`, {}).expect(200);
        const own = (await t.as(accountant).get(`/invoices/${approved.body.invoice.id}`).expect(200)).body;
        expect(own.dueAt).toBe(endOfDay(own.issuedAt, 7, 4));

        const company = await createCorporate(t, alpha, { creditApproved: true, creditLimit: '100000.00', paymentTermsDays: 30, companyName: 'Terms Co LLC' });
        const employee = await createCustomer(t, alpha, { corporateAccountId: company.id });
        const admin = await addCorporateAdmin(t, alpha, company.id);
        const viaQuotation = await t.as(admin).post(`/quotations/${await quotationFor(employee.id, { corporateAccountId: company.id })}/approve`, {}).expect(200);
        const corporate = (await t.as(accountant).get(`/invoices/${viaQuotation.body.invoice.id}`).expect(200)).body;
        expect(corporate.dueAt).toBe(endOfDay(corporate.issuedAt, 30, 4));
        expect(corporate.overdue).toBe(false);

        // A company WITHOUT approved credit has no terms of its own: the centre's default applies.
        const plain = await createCorporate(t, alpha, { creditApproved: false, paymentTermsDays: 60 });
        const worker = await createCustomer(t, alpha, { corporateAccountId: plain.id });
        const inv = await issueInvoice(t, accountant, worker.id, { corporateAccountId: plain.id });
        expect(inv.dueAt).toBe(endOfDay(inv.issuedAt, 7, 4));
      } finally {
        await t.as(alpha.owner).patch('/tenant/settings', { invoiceDueDays: 0 }).expect(200);
      }
    });

    it('"end of the day" is the centre\'s day, wherever the centre is', async () => {
      const tokyo = await t.createTenant({ name: 'Tokyo Typing' });
      await t.sys.tenant.update({ where: { id: tokyo.id }, data: { timezone: 'Asia/Tokyo' } });
      const c = await createCustomer(t, tokyo);
      const inv = await issueInvoice(t, tokyo.owner, c.id);
      expect(inv.dueAt).toBe(endOfDay(inv.issuedAt, 0, 9));
      // An unknown zone name falls back to Asia/Dubai instead of failing the invoice.
      await t.sys.tenant.update({ where: { id: tokyo.id }, data: { timezone: 'Mars/Olympus' } });
      const fallback = await issueInvoice(t, tokyo.owner, c.id);
      expect(fallback.dueAt).toBe(endOfDay(fallback.issuedAt, 0, 4));
    });

    it('overdue means: the due moment has passed AND money is still expected - the same everywhere', async () => {
      const inv = await issueInvoice(t, accountant, customer.customerId!); // 305.00
      const overdueIds = async (actor: Actor) => (await t.as(actor).get('/invoices?overdue=true&pageSize=100').expect(200)).body.data.map((i: any) => i.id);
      const flag = async (actor: Actor) => (await t.as(actor).get(`/invoices/${inv.id}`).expect(200)).body.overdue;
      // One millisecond before the due moment: not overdue. One past it: overdue.
      await t.sys.invoice.update({ where: { id: inv.id }, data: { dueAt: new Date(Date.now() + 60_000) } });
      expect([await flag(customer), await flag(accountant)]).toEqual([false, false]);
      expect(await overdueIds(accountant)).not.toContain(inv.id);
      await t.sys.invoice.update({ where: { id: inv.id }, data: { dueAt: new Date(Date.now() - 1000) } });
      expect([await flag(customer), await flag(accountant)]).toEqual([true, true]);
      expect(await overdueIds(accountant)).toContain(inv.id);
      expect(await overdueIds(customer)).toContain(inv.id);
      expect(await overdueIds(otherCustomer)).not.toContain(inv.id);
      // Partly paid: still overdue.
      await recordPayment(t, accountant, { method: 'CASH', amount: '100.00', branchId: alpha.headOfficeId, allocations: [{ invoiceId: inv.id, amount: '100.00' }] }).expect(201);
      expect(await flag(customer)).toBe(true);
      expect(await overdueIds(accountant)).toContain(inv.id);
      // Fully paid: nothing is expected any more, so it is not overdue although the date has passed.
      await recordPayment(t, accountant, { method: 'CASH', amount: '205.00', branchId: alpha.headOfficeId, allocations: [{ invoiceId: inv.id, amount: '205.00' }] }).expect(201);
      expect([await flag(customer), await flag(accountant)]).toEqual([false, false]);
      expect(await overdueIds(accountant)).not.toContain(inv.id);
      // A void invoice past its date is not overdue either.
      const voided = await issueInvoice(t, accountant, customer.customerId!);
      await t.sys.invoice.update({ where: { id: voided.id }, data: { dueAt: new Date(Date.now() - 5 * 86_400_000) } });
      expect(await overdueIds(accountant)).toContain(voided.id);
      await t.as(alpha.owner).post(`/invoices/${voided.id}/void`, { reason: 'Issued by mistake' }).expect(200);
      expect(await overdueIds(accountant)).not.toContain(voided.id);
      expect((await t.as(accountant).get(`/invoices/${voided.id}`).expect(200)).body.overdue).toBe(false);
    });
  });

  // ------------------------------------------------------------------ (b) visibility
  describe('what customers and company users see', () => {
    it('never a draft, and never an invoice that was voided before it was issued', async () => {
      const service = await createService(t, alpha);
      const request = await createRequest(t, alpha, { customerId: customer.customerId!, serviceId: service.id });
      const draft = (await t.as(accountant).post('/invoices', { customerId: customer.customerId, requestId: request.id, items: [line('SERVICE_FEE', '50.00')] }).expect(201)).body;
      const scrapped = (await t.as(accountant).post('/invoices', { customerId: customer.customerId, requestId: request.id, items: [line('SERVICE_FEE', '60.00')] }).expect(201)).body;
      await t.as(alpha.owner).post(`/invoices/${scrapped.id}/void`, { reason: 'Wrong service, starting over' }).expect(200);
      const issuedThenVoided = await issueInvoice(t, accountant, customer.customerId!, { requestId: request.id });
      await t.as(alpha.owner).post(`/invoices/${issuedThenVoided.id}/void`, { reason: 'Customer changed their mind' }).expect(200);
      const live = await issueInvoice(t, accountant, customer.customerId!, { requestId: request.id });

      const mine = (await t.as(customer).get('/invoices?pageSize=100').expect(200)).body.data.map((i: any) => i.id);
      expect(mine).toEqual(expect.arrayContaining([live.id, issuedThenVoided.id]));
      expect(mine).not.toContain(draft.id);
      expect(mine).not.toContain(scrapped.id);
      const voidSeen = (await t.as(customer).get('/invoices?status=VOID&pageSize=100').expect(200)).body.data;
      expect(voidSeen.map((i: any) => i.id)).toContain(issuedThenVoided.id);
      expect(voidSeen.map((i: any) => i.id)).not.toContain(scrapped.id);
      expect(voidSeen.every((i: any) => i.issuedAt !== null)).toBe(true);
      for (const hidden of [draft.id, scrapped.id]) {
        await t.as(customer).get(`/invoices/${hidden}`).expect(404);
        await t.as(customer).get(`/invoices/${hidden}/pdf`).expect(404);
        await t.as(customer).post(`/invoices/${hidden}/pay`, {}).expect(404);
      }
      // An invoice the customer did receive stays visible after it was voided, marked as void.
      expect((await t.as(customer).get(`/invoices/${issuedThenVoided.id}`).expect(200)).body).toMatchObject({ status: 'VOID', overdue: false });
      // The request the customer follows shows the same set.
      const seen = (await t.as(customer).get(`/requests/${request.id}`).expect(200)).body.finance.invoices.map((i: any) => i.id).sort();
      expect(seen).toEqual([issuedThenVoided.id, live.id].sort());
      // Staff still see everything (the scrapped one as VOID, the draft as DRAFT).
      const staff = (await t.as(accountant).get(`/invoices?requestId=${request.id}&pageSize=100`).expect(200)).body.data.map((i: any) => [i.id, i.status]);
      expect(staff).toEqual(expect.arrayContaining([[draft.id, 'DRAFT'], [scrapped.id, 'VOID'], [issuedThenVoided.id, 'VOID'], [live.id, 'ISSUED']]));
      await t.as(accountant).get(`/invoices/${scrapped.id}`).expect(200);
      expect((await t.as(accountant).get(`/requests/${request.id}`).expect(200)).body.finance.invoices.map((i: any) => i.id)).toEqual(expect.arrayContaining([scrapped.id]));
    });

    it('the same for a company\'s users', async () => {
      const company = await createCorporate(t, alpha, { creditApproved: true, creditLimit: '100000.00', paymentTermsDays: 15 });
      const employee = await createCustomer(t, alpha, { corporateAccountId: company.id });
      const admin = await addCorporateAdmin(t, alpha, company.id);
      const draft = (await t.as(accountant).post('/invoices', { customerId: employee.id, corporateAccountId: company.id, items: [line('SERVICE_FEE', '50.00')] }).expect(201)).body;
      const scrapped = (await t.as(accountant).post('/invoices', { customerId: employee.id, corporateAccountId: company.id, items: [line('SERVICE_FEE', '60.00')] }).expect(201)).body;
      await t.as(alpha.owner).post(`/invoices/${scrapped.id}/void`, { reason: 'Duplicate of another draft' }).expect(200);
      const live = await issueInvoice(t, accountant, employee.id, { corporateAccountId: company.id });
      const seen = (await t.as(admin).get('/corporate/invoices?pageSize=100').expect(200)).body.data.map((i: any) => i.id);
      expect(seen).toEqual([live.id]);
      for (const hidden of [draft.id, scrapped.id]) await t.as(admin).get(`/invoices/${hidden}`).expect(404);
    });
  });

  // ------------------------------------------------------------------ (c) abandoned checkouts
  describe('online payment attempts that were never completed', () => {
    const startedAgo = (paymentId: string, minutes: number) => t.sys.payment.update({ where: { id: paymentId }, data: { createdAt: new Date(Date.now() - minutes * MINUTE) } });
    const paymentRow = (id: string) => t.sys.payment.findUniqueOrThrow({ where: { id } });

    it('are closed as CANCELLED / EXPIRED after the provider session lifetime, idempotently', async () => {
      expect(ONLINE_CHECKOUT_LIFETIME_MINUTES).toBe(60);
      expect(t.jobs.schedules().find((s) => s.name === EXPIRE_CHECKOUTS_JOB)).toMatchObject({ everySeconds: 300 });
      const inv = await issueInvoice(t, accountant, customer.customerId!);
      const old = await t.as(customer).post(`/invoices/${inv.id}/pay`, { amount: '100.00' }).expect(201);
      const recent = await t.as(customer).post(`/invoices/${inv.id}/pay`, { amount: '50.00' }).expect(201);
      const cash = await recordPayment(t, accountant, { method: 'CASH', amount: '10.00', branchId: alpha.headOfficeId, allocations: [{ invoiceId: inv.id, amount: '10.00' }] }).expect(201);
      await startedAgo(old.body.paymentId, 61);
      await startedAgo(recent.body.paymentId, 59);
      await startedAgo(cash.body.id, 500);
      await t.settle();
      const notifications = await t.sys.notification.count({ where: { tenantId: alpha.id } });

      await t.jobs.runScheduled(EXPIRE_CHECKOUTS_JOB);
      expect(await paymentRow(old.body.paymentId)).toMatchObject({ status: 'CANCELLED', failureReason: CHECKOUT_EXPIRED_REASON, receiptNo: null, receivedAt: null });
      expect((await paymentRow(recent.body.paymentId)).status).toBe('PENDING');
      expect((await paymentRow(cash.body.id)).status).toBe('COMPLETED');
      // Nothing about the invoice changed, nobody was told, and it is on the trail once.
      expect((await t.sys.invoice.findUniqueOrThrow({ where: { id: inv.id } })).amountPaid.toFixed(2)).toBe('10.00');
      await t.jobs.runScheduled(EXPIRE_CHECKOUTS_JOB);
      await t.jobs.runScheduled(EXPIRE_CHECKOUTS_JOB);
      await t.settle();
      const audit = await t.sys.auditLog.findMany({ where: { tenantId: alpha.id, action: 'payment.checkout_expired', resourceId: old.body.paymentId } });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorType: 'SYSTEM', before: { status: 'PENDING' }, after: { status: 'CANCELLED', reason: 'EXPIRED' } });
      expect(await t.sys.notification.count({ where: { tenantId: alpha.id } })).toBe(notifications);
      expect((await outbox(t, alpha.id, 'payment.failed')).filter((e) => (e.payload as any).paymentId === old.body.paymentId)).toHaveLength(0);
      // The customer sees what happened and can simply start again.
      expect((await t.as(customer).get(`/payments/${old.body.paymentId}`).expect(200)).body).toMatchObject({ status: 'CANCELLED', failureReason: 'EXPIRED' });
      expect((await t.as(customer).get('/payments?status=PENDING&pageSize=100').expect(200)).body.data.map((p: any) => p.id)).not.toContain(old.body.paymentId);
      await t.as(customer).post(`/invoices/${inv.id}/pay`, { amount: '100.00' }).expect(201);
    });

    it('a late success from the provider still wins: the expired attempt is completed exactly once', async () => {
      const inv = await issueInvoice(t, accountant, customer.customerId!);
      const start = await t.as(customer).post(`/invoices/${inv.id}/pay`, {}).expect(201);
      const hook = buildSandboxWebhook(sessionRefOf(start.body.checkoutUrl), 'succeeded');
      await startedAgo(start.body.paymentId, 90);
      await t.jobs.runScheduled(EXPIRE_CHECKOUTS_JOB);
      expect(await paymentRow(start.body.paymentId)).toMatchObject({ status: 'CANCELLED', failureReason: 'EXPIRED' });

      const late = await postSandboxWebhook(t, hook).expect(200);
      expect(late.body).toMatchObject({ received: true, processed: true, outcome: 'COMPLETED' });
      const paid = await paymentRow(start.body.paymentId);
      expect(paid).toMatchObject({ status: 'COMPLETED', failureReason: null });
      expect(paid.receiptNo).toMatch(/^RCT-\d{6}$/);
      expect(await t.sys.invoice.findUniqueOrThrow({ where: { id: inv.id } })).toMatchObject({ status: 'PAID' });
      expect(await t.sys.paymentAllocation.count({ where: { paymentId: paid.id } })).toBe(1);
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'payment.checkout_revived', resourceId: paid.id } })).toBe(1);
      expect((await outbox(t, alpha.id, 'payment.completed')).filter((e) => (e.payload as any).paymentId === paid.id)).toHaveLength(1);
      // The same event again, a second success event and the expiry job afterwards change nothing.
      expect((await postSandboxWebhook(t, hook).expect(200)).body).toMatchObject({ duplicate: true });
      expect((await postSandboxWebhook(t, buildSandboxWebhook(sessionRefOf(start.body.checkoutUrl), 'succeeded')).expect(200)).body).toMatchObject({ processed: false, outcome: 'IGNORED' });
      await t.jobs.runScheduled(EXPIRE_CHECKOUTS_JOB);
      expect((await paymentRow(paid.id)).status).toBe('COMPLETED');
      expect(await t.sys.paymentAllocation.count({ where: { paymentId: paid.id } })).toBe(1);
    });

    it('only an attempt that expired can be revived: a declined one stays declined, and a late decline changes nothing', async () => {
      const inv = await issueInvoice(t, accountant, customer.customerId!);
      const declined = await t.as(customer).post(`/invoices/${inv.id}/pay`, {}).expect(201);
      await postSandboxWebhook(t, buildSandboxWebhook(sessionRefOf(declined.body.checkoutUrl), 'failed')).expect(200);
      expect((await paymentRow(declined.body.paymentId)).status).toBe('FAILED');
      expect((await postSandboxWebhook(t, buildSandboxWebhook(sessionRefOf(declined.body.checkoutUrl), 'succeeded')).expect(200)).body).toMatchObject({ processed: false, outcome: 'IGNORED' });
      expect((await paymentRow(declined.body.paymentId)).status).toBe('FAILED');

      const expired = await t.as(customer).post(`/invoices/${inv.id}/pay`, {}).expect(201);
      await startedAgo(expired.body.paymentId, 120);
      await t.jobs.runScheduled(EXPIRE_CHECKOUTS_JOB);
      expect((await postSandboxWebhook(t, buildSandboxWebhook(sessionRefOf(expired.body.checkoutUrl), 'failed')).expect(200)).body).toMatchObject({ processed: false, outcome: 'IGNORED' });
      expect(await paymentRow(expired.body.paymentId)).toMatchObject({ status: 'CANCELLED', failureReason: 'EXPIRED' });
      expect((await t.sys.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('ISSUED');
    });

    it('the job and a success webhook at the same moment: the payment ends up completed', async () => {
      for (let round = 0; round < 3; round++) {
        const inv = await issueInvoice(t, accountant, customer.customerId!);
        const start = await t.as(customer).post(`/invoices/${inv.id}/pay`, {}).expect(201);
        await startedAgo(start.body.paymentId, 75);
        const hook = buildSandboxWebhook(sessionRefOf(start.body.checkoutUrl), 'succeeded');
        const [delivered] = await Promise.all([postSandboxWebhook(t, hook), t.jobs.runScheduled(EXPIRE_CHECKOUTS_JOB)]);
        expect(delivered.status).toBe(200);
        expect((await paymentRow(start.body.paymentId)).status).toBe('COMPLETED');
        expect(await t.sys.paymentAllocation.count({ where: { paymentId: start.body.paymentId } })).toBe(1);
        expect((await t.sys.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('PAID');
      }
    });
  });

  // ------------------------------------------------------------------ (d) the sandbox checkout page
  describe('the sandbox checkout page', () => {
    const html = (path: string) => t.http.get(path).set('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
    const start = async (body: Record<string, unknown> = {}) => {
      const inv = await issueInvoice(t, accountant, customer.customerId!);
      const res = await t.as(customer).post(`/invoices/${inv.id}/pay`, body).expect(201);
      return { invoiceId: inv.id, paymentId: res.body.paymentId as string, path: sandboxPath(res.body.checkoutUrl), ref: sessionRefOf(res.body.checkoutUrl) };
    };

    it('a browser gets a self-contained HTML page that says clearly that it is a test', async () => {
      const s = await start();
      const page = await html(s.path).expect(200);
      expect(page.headers['content-type']).toMatch(/^text\/html; charset=utf-8/);
      expect(page.text).toContain('TEST PAYMENT - no money is taken');
      expect(page.text).toContain('AED 305.00');
      expect(page.text).toMatch(/Invoice INV-\d{6}/);
      // Two plain forms that post to the existing endpoints, each with the token of this session.
      const actions = [...page.text.matchAll(/<form method="post" action="([^"]+)">/g)].map((m) => m[1].replace(/&amp;/g, '&'));
      expect(actions).toEqual([`${s.path}/complete?form=${sandboxFormToken(s.ref)}`, `${s.path}/fail?form=${sandboxFormToken(s.ref)}`]);
      expect(page.text.match(/<button/g)).toHaveLength(2);
      // Self-contained: no script, no external resource, and the policy forbids both.
      expect(page.text).not.toMatch(/<script|javascript:|\son[a-z]+=|<link|<img|<iframe|src=|url\(|@import/i);
      const csp = page.headers['content-security-policy'];
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("style-src 'unsafe-inline'");
      expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
      expect(csp).toContain("frame-ancestors 'none'");
      // The forms may post to this API and be redirected to the portal the customer came from - nowhere else.
      expect(csp).toMatch(new RegExp(`form-action 'self' ${env().CUSTOMER_WEB_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(;|$)`));
      expect(page.headers['cache-control']).toBe('no-store');
      expect(page.headers['referrer-policy']).toBe('no-referrer');
      // API clients keep getting JSON from the same address.
      const json = await t.http.get(s.path).expect(200);
      expect(json.headers['content-type']).toMatch(/application\/json/);
      expect(json.body).toMatchObject({ gateway: 'sandbox', testMode: true, amount: '305.00', currency: 'AED', actions: { complete: { method: 'POST' }, fail: { method: 'POST' } } });
      expect((await t.http.get(s.path).set('Accept', 'application/json').expect(200)).body.gateway).toBe('sandbox');
    });

    it('"Complete" pays through the signed webhook and redirects to the return address like a real provider', async () => {
      const returnUrl = `${env().CUSTOMER_WEB_URL}/invoices/return?from=checkout`;
      const s = await start({ returnUrl });
      const done = await t.http.post(`${s.path}/complete?form=${sandboxFormToken(s.ref)}`).type('form').send('').redirects(0);
      expect(done.status).toBe(303);
      const location = new URL(done.headers.location);
      expect(`${location.origin}${location.pathname}`).toBe(`${env().CUSTOMER_WEB_URL}/invoices/return`);
      expect(Object.fromEntries(location.searchParams)).toEqual({ from: 'checkout', payment: s.paymentId, result: 'success' });
      expect(await t.sys.payment.findUniqueOrThrow({ where: { id: s.paymentId } })).toMatchObject({ status: 'COMPLETED' });
      expect((await t.sys.invoice.findUniqueOrThrow({ where: { id: s.invoiceId } })).status).toBe('PAID');
      // Pressing the button again (back button, double click) redirects again and pays nothing twice.
      const again = await t.http.post(`${s.path}/complete?form=${sandboxFormToken(s.ref)}`).type('form').send('').redirects(0);
      expect(again.status).toBe(303);
      expect(await t.sys.paymentAllocation.count({ where: { paymentId: s.paymentId } })).toBe(1);
    });

    it('"Decline" fails the payment and redirects to the cancel address', async () => {
      const s = await start();
      const declined = await t.http.post(`${s.path}/fail?form=${sandboxFormToken(s.ref)}`).type('form').send('').redirects(0);
      expect(declined.status).toBe(303);
      expect(new URL(declined.headers.location).searchParams.get('result')).toBe('cancelled');
      expect(await t.sys.payment.findUniqueOrThrow({ where: { id: s.paymentId } })).toMatchObject({ status: 'FAILED', failureReason: 'The test payment was declined on the sandbox page.' });
      expect((await t.sys.invoice.findUniqueOrThrow({ where: { id: s.invoiceId } })).status).toBe('ISSUED');
    });

    it('refuses a form post without the token of that session, and keeps the JSON endpoints as they were', async () => {
      const s = await start();
      const other = await start();
      for (const token of ['', 'wrong', sandboxFormToken(other.ref)]) {
        const res = await t.http.post(`${s.path}/complete?form=${token}`).type('form').send('').redirects(0);
        expect([token, res.status]).toEqual([token, 403]);
        expect(res.headers['content-type']).toMatch(/text\/html/);
        expect(res.headers.location).toBeUndefined();
      }
      expect((await t.sys.payment.findUniqueOrThrow({ where: { id: s.paymentId } })).status).toBe('PENDING');
      // The customer portal's calls: JSON in, JSON out, no token.
      const fail = await t.http.post(`${s.path}/fail`).send({ reason: 'Card declined in test' }).expect(200);
      expect(fail.body).toMatchObject({ gateway: 'sandbox', outcome: 'failed', webhook: { delivered: true } });
      expect(fail.body.returnUrl).toContain('result=cancelled');
      expect((await t.sys.payment.findUniqueOrThrow({ where: { id: s.paymentId } })).failureReason).toBe('Card declined in test');
      await t.http.post(`${s.path}/fail`).send({ reason: 'x'.repeat(300) }).expect(400);
      const complete = await t.http.post(`${other.path}/complete`).expect(200);
      expect(complete.body).toMatchObject({ outcome: 'succeeded', webhook: { delivered: true, response: { outcome: 'COMPLETED' } } });
    });

    it('does not exist when the sandbox is switched off, and an expired or forged session shows a plain page', async () => {
      const s = await start();
      // A session reference that was tampered with (the signature no longer matches).
      const forged = `${s.path.slice(0, -4)}AAAA`;
      const gone = await html(forged).expect(404);
      expect(gone.headers['content-type']).toMatch(/text\/html/);
      expect(gone.text).toContain('TEST PAYMENT - no money is taken');
      expect(gone.text).toContain('expired');
      expect(gone.text).not.toContain('<form');
      await t.http.get(forged).expect(404);
      expect((await t.http.post(`${forged}/complete?form=${sandboxFormToken(s.ref)}`).type('form').send('').redirects(0)).status).toBe(404);

      const before = env().PAYMENT_SANDBOX_ENABLED;
      try {
        (env() as any).PAYMENT_SANDBOX_ENABLED = false;
        for (const res of [await html(s.path), await t.http.get(s.path), await t.http.post(`${s.path}/complete`), await t.http.post(`${s.path}/complete?form=${sandboxFormToken(s.ref)}`).type('form').send('').redirects(0), await t.http.post(`${s.path}/fail`).send({})]) {
          expect(res.status).toBe(404);
          expect(res.text ?? '').not.toContain('<form');
        }
      } finally {
        (env() as any).PAYMENT_SANDBOX_ENABLED = before;
      }
      expect((await t.sys.payment.findUniqueOrThrow({ where: { id: s.paymentId } })).status).toBe('PENDING');
      // Production refuses to start with the sandbox switched on.
      expect(() => loadEnv({ ...process.env, NODE_ENV: 'production', PAYMENT_SANDBOX_ENABLED: 'true' })).toThrow(/PAYMENT_SANDBOX_ENABLED must be false in production/);
    });
  });
});
