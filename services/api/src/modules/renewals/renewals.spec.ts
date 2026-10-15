import { TenantFixture, TestApp } from '../../../test/helpers';
import { addDays, localDate } from '../reminders/dates';
import { createCorporate, createCustomer, createService, enableSandbox, listen, outbox } from '../finance/fixtures';

describe('Renewal autopilot', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let serviceId: string;
  const today = () => localDate(new Date(), 'Asia/Dubai');
  const schedule = (tenant: TenantFixture, customerId: string, days: number, extra: Record<string, unknown> = {}) =>
    t.sys.reminderSchedule.create({ data: { tenantId: tenant.id, customerId, documentTypeKey: 'emirates_id', subjectLabel: 'Emirates ID', expiryDate: new Date(`${addDays(today(), days)}T00:00:00.000Z`), ...extra } });
  const tokenOf = async (scheduleId: string) => {
    const event = (await outbox(t, alpha.id, 'renewal.offered')).find((e) => (e.payload as any).scheduleId === scheduleId)!;
    return new URL((event.payload as any).renewLink).searchParams.get('t')!;
  };
  const publicApi = () => t.as(null);

  beforeAll(async () => {
    t = await listen(await TestApp.create());
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    serviceId = (await createService(t, alpha, { name: 'Emirates ID renewal', serviceFee: '70.00', governmentFee: '300.00' })).id;
    await enableSandbox(t, alpha);
  });
  afterAll(() => t.close());

  it('is configured per centre: on/off, the window and which service renews which document type', async () => {
    const operator = await t.addStaff(alpha, 'operator');
    await t.as(operator).put('/renewals/autopilot', { enabled: true }).expect(403);
    await t.as(beta.owner).put('/renewals/autopilot', { services: { emirates_id: serviceId } }).expect(404);
    const saved = await t.as(alpha.owner).put('/renewals/autopilot', { enabled: true, daysBefore: 30, services: { emirates_id: serviceId } }).expect(200);
    expect(saved.body).toEqual({ enabled: true, daysBefore: 30, services: { emirates_id: serviceId } });
    expect((await t.as(beta.owner).get('/renewals/autopilot').expect(200)).body).toMatchObject({ enabled: false, services: {} });
  });

  let scheduleId: string;
  let customerId: string;
  it('offers renewals inside the window only, once, for individual customers', async () => {
    customerId = (await createCustomer(t, alpha, { fullName: 'Fatima Al Mansoori' })).id;
    scheduleId = (await schedule(alpha, customerId, 20)).id;
    await schedule(alpha, customerId, 90); // not yet
    await schedule(alpha, customerId, -60); // expired too long ago
    await schedule(alpha, customerId, 10, { documentTypeKey: 'passport' }); // type not mapped
    const company = await createCorporate(t, alpha);
    await schedule(alpha, customerId, 10, { corporateAccountId: company.id }); // a company's document

    const candidates = (await t.as(alpha.owner).get('/renewals/autopilot').expect(200)).body.candidates;
    expect(candidates.map((c: { id: string }) => c.id)).toEqual([scheduleId]);

    const run = await t.as(alpha.owner).post('/renewals/autopilot/run').expect(200);
    expect(run.body).toEqual({ offered: 1, failed: [] });
    const linked = await t.sys.reminderSchedule.findUniqueOrThrow({ where: { id: scheduleId } });
    const request = await t.sys.serviceRequest.findUniqueOrThrow({ where: { id: linked.renewalRequestId! } });
    expect(request).toMatchObject({ customerId, serviceId, status: 'DRAFT' });
    const quotation = await t.sys.quotation.findFirstOrThrow({ where: { requestId: request.id } });
    expect(quotation.status).toBe('SENT');
    expect(quotation.total.toFixed(2)).toBe('373.50'); // 70 + 5% VAT + 300 government fee

    // The customer gets the one-tap link, not the generic "quotation ready" message.
    await t.settle();
    const sent = await t.sys.notification.findMany({ where: { tenantId: alpha.id, recipientCustomerId: customerId } });
    expect(sent.some((n) => n.eventKey === 'renewal.offer' && n.body.includes('/renew?t='))).toBe(true);
    expect(sent.some((n) => n.eventKey === 'quotation.ready')).toBe(false);

    expect((await t.as(alpha.owner).post('/renewals/autopilot/run').expect(200)).body.offered).toBe(0);
    expect((await t.as(alpha.owner).post(`/renewals/autopilot/offer/${scheduleId}`)).body.code).toBe('RENEWAL_EXISTS');
  });

  it('shows the offer to whoever holds the link, and nothing for a forged one', async () => {
    const token = await tokenOf(scheduleId);
    const view = await publicApi().get(`/public/renewals/${token}`).expect(200);
    expect(view.body).toMatchObject({ centreName: 'Alpha Typing', customerFirstName: 'Fatima', status: 'SENT', serviceName: 'Emirates ID renewal', documentName: 'Emirates ID', total: '373.50', payOnline: true, invoice: null });
    expect(view.body.lines).toHaveLength(2);
    expect(JSON.stringify(view.body)).not.toMatch(/@example\.test/);
    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), t: beta.id })).toString('base64url');
    await publicApi().get(`/public/renewals/${forged}.${sig}`).expect(404);
    await publicApi().get('/public/renewals/not-a-token').expect(404);
  });

  it('one tap approves the quotation, issues the invoice and opens the payment page', async () => {
    const token = await tokenOf(scheduleId);
    const accepted = await publicApi().post(`/public/renewals/${token}/accept`).send({}).expect(200);
    expect(accepted.body.approved).toBe(true);
    expect(accepted.body.checkoutUrl).toMatch(/^http/);
    const linked = await t.sys.reminderSchedule.findUniqueOrThrow({ where: { id: scheduleId } });
    const quotation = await t.sys.quotation.findFirstOrThrow({ where: { requestId: linked.renewalRequestId! } });
    expect(quotation).toMatchObject({ status: 'APPROVED', decidedByType: 'CUSTOMER' });
    const invoice = await t.sys.invoice.findFirstOrThrow({ where: { quotationId: quotation.id } });
    expect(invoice.customerId).toBe(customerId);
    // Opening the link again goes back to payment instead of failing.
    expect((await publicApi().post(`/public/renewals/${token}/accept`).send({}).expect(200)).body.checkoutUrl).toMatch(/^http/);
    expect((await publicApi().get(`/public/renewals/${token}`).expect(200)).body).toMatchObject({ status: 'APPROVED', invoice: { invoiceNo: invoice.invoiceNo } });
    await publicApi().post(`/public/renewals/${token}/decline`).send({}).expect(409);
  });

  it('the customer can decline', async () => {
    const other = await schedule(alpha, (await createCustomer(t, alpha)).id, 5);
    await t.as(alpha.owner).post(`/renewals/autopilot/offer/${other.id}`).expect(201);
    const token = await tokenOf(other.id);
    await publicApi().post(`/public/renewals/${token}/decline`).send({ reason: 'Renewed it myself' }).expect(200);
    const linked = await t.sys.reminderSchedule.findUniqueOrThrow({ where: { id: other.id } });
    expect((await t.sys.quotation.findFirstOrThrow({ where: { requestId: linked.renewalRequestId! } })).status).toBe('REJECTED');
  });

  it('a renewal that cannot be prepared leaves nothing behind and is reported', async () => {
    const unpriced = await createService(t, alpha, { name: 'Unpriced renewal', noPrice: true });
    await t.as(alpha.owner).put('/renewals/autopilot', { services: { residence_visa: unpriced.id } }).expect(200);
    const s = await schedule(alpha, (await createCustomer(t, alpha)).id, 15, { documentTypeKey: 'residence_visa' });
    const run = await t.as(alpha.owner).post('/renewals/autopilot/run').expect(200);
    expect(run.body.failed).toEqual([{ scheduleId: s.id, reason: expect.stringContaining('no active price') }]);
    expect((await t.sys.reminderSchedule.findUniqueOrThrow({ where: { id: s.id } })).renewalRequestId).toBeNull();
    expect(await t.sys.serviceRequest.count({ where: { tenantId: alpha.id, serviceId: unpriced.id } })).toBe(0);
  });

  it('does nothing while switched off', async () => {
    await t.as(alpha.owner).put('/renewals/autopilot', { enabled: false }).expect(200);
    await schedule(alpha, (await createCustomer(t, alpha)).id, 3);
    expect((await t.as(alpha.owner).post('/renewals/autopilot/run').expect(200)).body).toEqual({ offered: 0, failed: [] });
  });
});
