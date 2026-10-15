import { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { createService } from '../requests/fixtures';
import { LeadsService } from './leads.service';

describe('CRM leads', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let receptionist: Actor;
  let accountant: Actor;
  let operator: Actor;
  let serviceId: string;
  let leadId: string;
  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    receptionist = await t.addStaff(alpha, 'receptionist');
    accountant = await t.addStaff(alpha, 'accountant');
    operator = await t.addStaff(alpha, 'operator');
    serviceId = (await createService(t, alpha)).id;
  });
  afterAll(() => t.close());

  it('records enquiries with an owner, follow-up and activity log', async () => {
    await t.as(receptionist).post('/leads', { name: 'No Contact' }).expect(400);
    await t.as(accountant).post('/leads', { name: 'Read only', phone: '+971501110000' }).expect(403);
    await t.as(operator).get('/leads').expect(403);
    const lead = (await t.as(receptionist).post('/leads', { name: 'Khalid Saeed', phone: '0501239876'.replace(/^0/, '+971'), source: 'PHONE', serviceId, interest: 'Family visa for wife and 2 children', estimatedValue: '2500.00', nextFollowUpAt: inHours(-1) }).expect(201)).body;
    leadId = lead.id;
    expect(lead).toMatchObject({ leadNo: expect.stringMatching(/^LD-\d{6}$/), status: 'NEW', ownerId: receptionist.membershipId });
    const list = (await t.as(accountant).get('/leads').query({ due: true }).expect(200)).body;
    expect(list.dueToday).toBe(1);
    expect(list.data[0]).toMatchObject({ id: leadId, followUpDue: true, ownerName: expect.any(String), service: { id: serviceId } });
    // A call moves a new lead to "contacted" and sets the next follow-up.
    const after = (await t.as(receptionist).post(`/leads/${leadId}/activities`, { kind: 'CALL', body: 'Needs the salary certificate first', nextFollowUpAt: inHours(48) }).expect(201)).body;
    expect(after.status).toBe('CONTACTED');
    expect((await t.as(receptionist).get('/leads').query({ due: true }).expect(200)).body.dueToday).toBe(0);
    await t.as(receptionist).put(`/leads/${leadId}/status`, { status: 'QUOTED' }).expect(200);
    await t.as(receptionist).put(`/leads/${leadId}/status`, { status: 'WON' }).expect(422);
    const detail = (await t.as(receptionist).get(`/leads/${leadId}`).expect(200)).body;
    expect(detail.activities.map((a: { kind: string }) => a.kind)).toEqual(['STATUS', 'CALL', 'STATUS']);
    await t.as(beta.owner).get(`/leads/${leadId}`).expect(404);
  });

  it('a lost lead needs a reason', async () => {
    const lost = (await t.as(receptionist).post('/leads', { name: 'Price shopper', email: 'shopper@example.test' }).expect(201)).body;
    await t.as(receptionist).put(`/leads/${lost.id}/status`, { status: 'LOST' }).expect(400);
    await t.as(receptionist).put(`/leads/${lost.id}/status`, { status: 'LOST', lostReason: 'Went to another centre' }).expect(200);
    expect((await t.as(receptionist).get('/leads').query({ status: 'LOST' }).expect(200)).body.counts.LOST).toBe(1);
  });

  it('winning creates the customer and the first request', async () => {
    const won = (await t.as(receptionist).post(`/leads/${leadId}/convert`, {}).expect(200)).body;
    expect(won).toMatchObject({ customer: 'CREATED', requestNo: expect.any(String) });
    const customer = await t.sys.customer.findUniqueOrThrow({ where: { id: won.customerId } });
    expect(customer).toMatchObject({ fullName: 'Khalid Saeed', phone: '+971501239876' });
    const request = await t.sys.serviceRequest.findUniqueOrThrow({ where: { id: won.requestId } });
    expect(request).toMatchObject({ customerId: customer.id, serviceId, status: 'DRAFT' });
    expect(request.customerInstructions).toContain('Family visa');
    await t.as(receptionist).post(`/leads/${leadId}/convert`, {}).expect(409);
  });

  it('a lead from WhatsApp is matched to the existing customer instead of a duplicate', async () => {
    await t.as(alpha.owner).post('/inbox/simulate', { phone: '+971501239876', name: 'Khalid', text: 'Also my brother needs a visit visa' }).expect(201);
    const conv = await t.sys.waConversation.findFirstOrThrow({ where: { tenantId: alpha.id, phone: '+971501239876' } });
    const lead = (await t.as(receptionist).post('/leads', { name: 'Khalid (brother visit visa)', phone: '+971501239876', source: 'WHATSAPP', conversationId: conv.id }).expect(201)).body;
    expect((await t.as(receptionist).get(`/inbox/conversations/${conv.id}`).expect(200)).body.lead).toMatchObject({ id: lead.id });
    const won = (await t.as(receptionist).post(`/leads/${lead.id}/convert`, {}).expect(200)).body;
    expect(won).toMatchObject({ customer: 'MATCHED', requestId: null });
    expect(await t.sys.customer.count({ where: { tenantId: alpha.id, phone: '+971501239876' } })).toBe(1);
  });

  it('erasing the customer removes their leads', async () => {
    const customer = await t.sys.customer.findFirstOrThrow({ where: { tenantId: alpha.id, phone: '+971501239876' } });
    const report = await t.inTenant(alpha.id, () => t.db.tx((tx) => t.get(LeadsService).erase(tx, { tenantId: alpha.id, privacyRequestId: 'x', customerId: customer.id, customerIds: [customer.id] } as never)));
    expect(report).toEqual({ leads: 2 });
  });
});
