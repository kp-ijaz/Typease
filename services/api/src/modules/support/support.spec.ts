import { Actor, PASSWORD, TenantFixture, TestApp, uniq } from '../../../test/helpers';
import { hashPassword } from '../auth/auth.service';
import { makeCustomer, makeRequest } from '../notifications/fixtures';
import { SLA_JOB } from './support.service';

describe('Support', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let manager: Actor; // ticket.read + ticket.manage
  let receptionist: Actor; // ticket.read only
  let operator: Actor; // no ticket permission
  let one: Actor;
  let two: Actor;
  const open = (actor: Actor, body: Record<string, unknown> = {}) => t.as(actor).post('/me/tickets', { subject: 'Where is my visa?', message: 'I submitted my documents last week.', ...body });
  const staffReply = (actor: Actor, id: string, body: Record<string, unknown>) => t.as(actor).post(`/support/tickets/${id}/messages`, body);
  const runSla = async (now?: Date) => {
    await t.jobs.execute(SLA_JOB, now ? { now: now.toISOString() } : {}, { attempt: 1, maxAttempts: 1 });
    await t.settle();
  };
  const makeDocument = (tenant: TenantFixture, customerId: string, over: Record<string, unknown> = {}) =>
    t.sys.document.create({ data: { tenantId: tenant.id, customerId, documentTypeKey: 'passport', title: `Passport ${uniq()}`, status: 'AVAILABLE', ...over } as any });

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    manager = await t.addStaff(alpha, 'manager');
    receptionist = await t.addStaff(alpha, 'receptionist');
    operator = await t.addStaff(alpha, 'operator');
    one = await t.addCustomer(alpha, { fullName: 'Fatima Al Mansoori' });
    two = await t.addCustomer(alpha, { fullName: 'Second Customer' });
    await t.settle();
  });
  afterAll(() => t.close());

  // ------------------------------------------------------------------ SLA configuration
  describe('SLA policies and settings', () => {
    it('gives every new centre a policy per priority and lets managers change them', async () => {
      const rows = await t.sys.slaPolicy.findMany({ where: { tenantId: alpha.id } });
      expect(rows.map((r) => r.priority).sort()).toEqual(['HIGH', 'LOW', 'NORMAL', 'URGENT']);
      const policies = await t.as(receptionist).get('/support/sla-policies').expect(200);
      expect(policies.body).toEqual([
        { priority: 'URGENT', name: 'Urgent', firstResponseMinutes: 30, resolutionMinutes: 480, isActive: true },
        { priority: 'HIGH', name: 'High', firstResponseMinutes: 60, resolutionMinutes: 1440, isActive: true },
        { priority: 'NORMAL', name: 'Normal', firstResponseMinutes: 240, resolutionMinutes: 2880, isActive: true },
        { priority: 'LOW', name: 'Low', firstResponseMinutes: 480, resolutionMinutes: 4320, isActive: true },
      ]);
      const gamma = await t.createTenant();
      const saved = await t.as(gamma.owner).put('/support/sla-policies', { policies: [{ priority: 'HIGH', firstResponseMinutes: 15, resolutionMinutes: 120 }] }).expect(200);
      expect(saved.body.find((p: any) => p.priority === 'HIGH')).toMatchObject({ firstResponseMinutes: 15, resolutionMinutes: 120, name: 'High' });
      expect(saved.body.find((p: any) => p.priority === 'NORMAL').firstResponseMinutes).toBe(240);
      expect(await t.sys.slaPolicy.count({ where: { tenantId: gamma.id } })).toBe(4); // updated in place, not duplicated
      await t.as(gamma.owner).put('/support/sla-policies', { policies: [{ priority: 'HIGH', firstResponseMinutes: 120, resolutionMinutes: 60 }] }).expect(400);
      await t.as(gamma.owner).put('/support/sla-policies', { policies: [{ priority: 'HIGH', firstResponseMinutes: 5, resolutionMinutes: 60 }, { priority: 'HIGH', firstResponseMinutes: 5, resolutionMinutes: 60 }] }).expect(400);
      await t.as(receptionist).put('/support/sla-policies', { policies: [{ priority: 'HIGH', firstResponseMinutes: 15, resolutionMinutes: 120 }] }).expect(403);
      await t.as(operator).get('/support/sla-policies').expect(403);

      expect((await t.as(gamma.owner).get('/support/settings').expect(200)).body).toEqual({ reopenWindowDays: 7 });
      expect((await t.as(gamma.owner).put('/support/settings', { reopenWindowDays: 3 }).expect(200)).body).toEqual({ reopenWindowDays: 3 });
      await t.as(gamma.owner).put('/support/settings', { reopenWindowDays: 500 }).expect(400);
      expect(await t.sys.auditLog.count({ where: { tenantId: gamma.id, action: { in: ['sla_policy.updated', 'support.settings_updated'] } } })).toBe(2);
    });
  });

  // ------------------------------------------------------------------ customer tickets
  describe('customer tickets', () => {
    it('lets a customer open a ticket about their own request, with SLA due times computed for staff', async () => {
      const request = await makeRequest(t, alpha, one.customerId!);
      const othersRequest = await makeRequest(t, alpha, two.customerId!);
      const document = await makeDocument(alpha, one.customerId!);
      const othersDocument = await makeDocument(alpha, two.customerId!);

      const before = Date.now();
      const created = await open(one, { requestId: request.id, category: 'Visa', attachments: [document.id] }).expect(201);
      expect(created.body).toMatchObject({ ticketNo: expect.stringMatching(/^TKT-\d{6}$/), subject: 'Where is my visa?', category: 'Visa', status: 'OPEN', requestId: request.id, requestNo: request.requestNo, canReply: true, canRate: false, feedback: null });
      expect(created.body.messages).toEqual([
        { id: expect.any(String), fromSupport: false, authorKind: 'CUSTOMER', authorName: 'Fatima Al Mansoori', body: 'I submitted my documents last week.', attachments: [{ documentId: document.id, title: document.title }], createdAt: expect.any(String) },
      ]);
      // Nothing about SLA targets, priority or assignment reaches the customer.
      for (const key of ['priority', 'assigneeId', 'firstResponseDueAt', 'resolutionDueAt', 'firstResponseBreached', 'customerId']) expect(created.body).not.toHaveProperty(key);

      const staff = await t.as(receptionist).get(`/support/tickets/${created.body.id}`).expect(200);
      expect(staff.body).toMatchObject({ scope: 'CUSTOMER', priority: 'NORMAL', customerId: one.customerId, customerName: 'Fatima Al Mansoori', assigneeId: null, firstRespondedAt: null, firstResponseBreached: false, resolutionBreached: false });
      const openedAt = new Date(staff.body.createdAt).getTime();
      expect(openedAt).toBeGreaterThanOrEqual(before - 1000);
      expect(new Date(staff.body.firstResponseDueAt).getTime() - openedAt).toBe(240 * 60_000);
      expect(new Date(staff.body.resolutionDueAt).getTime() - openedAt).toBe(2880 * 60_000);
      expect(staff.body.messages[0]).toMatchObject({ authorType: 'CUSTOMER', visibility: 'CUSTOMER', authorUserId: one.userId });

      // Only their own requests and documents can be referenced.
      await open(one, { requestId: othersRequest.id }).expect(404);
      await open(one, { attachments: [othersDocument.id] }).expect(404);
      await open(one, { subject: 'x' }).expect(400);
      await open(one, { message: '' }).expect(400);
      const event = await t.sys.outboxEvent.findFirstOrThrow({ where: { tenantId: alpha.id, type: 'ticket.created' }, orderBy: { createdAt: 'desc' } });
      expect(event.payload).toMatchObject({ ticketId: created.body.id, customerId: one.customerId, requestId: request.id, scope: 'CUSTOMER' });
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'ticket.created', resourceId: created.body.id, actorUserId: one.userId } })).toBe(1);
      // Ticket numbers are sequential.
      const next = await open(one).expect(201);
      expect(Number(next.body.ticketNo.slice(4)) - Number(created.body.ticketNo.slice(4))).toBe(1);
    });

    it('keeps internal notes away from the customer and tracks the first response', async () => {
      const ticket = (await open(one).expect(201)).body;
      const othersDocument = await makeDocument(alpha, two.customerId!);
      const ownDocument = await makeDocument(alpha, one.customerId!);
      const hiddenDocument = await makeDocument(alpha, one.customerId!, { customerVisible: false });

      // An internal note: invisible to the customer, does not stop the first-response clock, notifies nobody.
      const note = await staffReply(manager, ticket.id, { body: 'INTERNAL-SECRET: customer was rude on the phone', visibility: 'INTERNAL', attachments: [othersDocument.id] }).expect(201);
      expect(note.body).toMatchObject({ status: 'OPEN', firstRespondedAt: null });
      expect(note.body.messages.at(-1)).toMatchObject({ visibility: 'INTERNAL', authorType: 'STAFF', authorUserId: manager.userId });
      await t.settle();
      expect(await t.sys.notification.count({ where: { tenantId: alpha.id, eventKey: 'support.response', relatedId: ticket.id } })).toBe(0);
      const afterNote = await t.as(one).get(`/me/tickets/${ticket.id}`).expect(200);
      expect(afterNote.body.messages).toHaveLength(1);
      expect(JSON.stringify(afterNote.body)).not.toContain('INTERNAL-SECRET');
      expect(JSON.stringify((await t.as(one).get('/me/tickets').expect(200)).body)).not.toContain('INTERNAL-SECRET');
      expect((await staffReply(manager, ticket.id, { body: 'note', visibility: 'INTERNAL', status: 'RESOLVED' }).expect(422)).body.code).toBe('STATUS_NEEDS_REPLY');

      // A reply the customer can see may only carry documents the customer may see.
      expect((await staffReply(manager, ticket.id, { body: 'Here you go', attachments: [othersDocument.id] }).expect(422)).body.code).toBe('ATTACHMENT_NOT_SHAREABLE');
      expect((await staffReply(manager, ticket.id, { body: 'Here you go', attachments: [hiddenDocument.id] }).expect(422)).body.code).toBe('ATTACHMENT_NOT_SHAREABLE');
      const reply = await staffReply(manager, ticket.id, { body: 'We are checking with the typing team.', attachments: [ownDocument.id] }).expect(201);
      expect(reply.body.status).toBe('IN_PROGRESS');
      expect(reply.body.firstRespondedAt).toBeTruthy();
      const firstRespondedAt = reply.body.firstRespondedAt;

      const seen = await t.as(one).get(`/me/tickets/${ticket.id}`).expect(200);
      expect(seen.body.status).toBe('IN_PROGRESS');
      expect(seen.body.messages).toHaveLength(2);
      // The customer learns that the centre answered - not who: no name, no role, no user id.
      expect(seen.body.messages[1]).toEqual({ id: expect.any(String), fromSupport: true, authorKind: 'STAFF', authorName: null, body: 'We are checking with the typing team.', attachments: [{ documentId: ownDocument.id, title: ownDocument.title }], createdAt: expect.any(String) });
      expect(JSON.stringify(seen.body)).not.toContain(manager.userId);

      // The customer is notified about the reply, without the reply text itself.
      await t.settle();
      const emails = await t.sys.notification.findMany({ where: { tenantId: alpha.id, eventKey: 'support.response', relatedId: ticket.id, channel: 'EMAIL' } });
      expect(emails).toHaveLength(1);
      expect(emails[0]).toMatchObject({ status: 'SENT', recipientAddress: one.email, subject: `New reply to your ticket ${ticket.ticketNo}` });
      expect(emails[0].body).not.toContain('typing team');

      // Later replies do not move the first-response time.
      const second = await staffReply(manager, ticket.id, { body: 'Please send a clearer photo.', status: 'WAITING_CUSTOMER' }).expect(201);
      expect(second.body).toMatchObject({ status: 'WAITING_CUSTOMER', firstRespondedAt });
      const answered = await t.as(one).post(`/me/tickets/${ticket.id}/messages`, { body: 'Here is a new photo.' }).expect(201);
      expect(answered.body.status).toBe('IN_PROGRESS');
      expect(answered.body.messages.at(-1)).toMatchObject({ fromSupport: false, body: 'Here is a new photo.' });
      // The customer's own reply does not notify the customer.
      await t.settle();
      expect(await t.sys.notification.count({ where: { tenantId: alpha.id, eventKey: 'support.response', relatedId: ticket.id, channel: 'EMAIL' } })).toBe(2);
    });

    it('resolves, reopens on a customer reply inside the window, and closes for good afterwards', async () => {
      const ticket = (await open(one).expect(201)).body;
      const resolved = await staffReply(manager, ticket.id, { body: 'Your visa is ready for collection.', status: 'RESOLVED', resolutionSummary: 'Visa issued' }).expect(201);
      expect(resolved.body).toMatchObject({ status: 'RESOLVED', resolutionSummary: 'Visa issued' });
      expect(resolved.body.resolvedAt).toBeTruthy();
      expect((await t.as(one).get(`/me/tickets/${ticket.id}`).expect(200)).body).toMatchObject({ status: 'RESOLVED', canReply: true, canRate: true, resolutionSummary: 'Visa issued' });

      const reopened = await t.as(one).post(`/me/tickets/${ticket.id}/messages`, { body: 'The name on it is misspelled.' }).expect(201);
      expect(reopened.body).toMatchObject({ status: 'IN_PROGRESS', resolvedAt: null });
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'ticket.reopened', resourceId: ticket.id } })).toBe(1);

      await t.as(manager).post(`/support/tickets/${ticket.id}/status`, { status: 'RESOLVED', resolutionSummary: 'Corrected and reissued' }).expect(200);
      // Ten days later the window (7 days) is over.
      await t.sys.supportTicket.update({ where: { id: ticket.id }, data: { resolvedAt: new Date(Date.now() - 10 * 86_400_000) } });
      expect((await t.as(one).get(`/me/tickets/${ticket.id}`).expect(200)).body.canReply).toBe(false);
      const late = await t.as(one).post(`/me/tickets/${ticket.id}/messages`, { body: 'One more thing' }).expect(409);
      expect(late.body.code).toBe('TICKET_CLOSED');
      // The job closes it.
      await runSla();
      const closed = await t.as(manager).get(`/support/tickets/${ticket.id}`).expect(200);
      expect(closed.body.status).toBe('CLOSED');
      expect(closed.body.closedAt).toBeTruthy();
      expect((await staffReply(manager, ticket.id, { body: 'Hello again' }).expect(409)).body.code).toBe('TICKET_CLOSED');
      await staffReply(manager, ticket.id, { body: 'Closed after the window.', visibility: 'INTERNAL' }).expect(201); // notes are still possible
      expect((await t.as(manager).post(`/support/tickets/${ticket.id}/status`, { status: 'IN_PROGRESS' }).expect(409)).body.code).toBe('INVALID_TRANSITION');
      expect((await t.as(manager).patch(`/support/tickets/${ticket.id}`, { priority: 'HIGH' }).expect(409)).body.code).toBe('TICKET_CLOSED');
    });

    it('lets staff assign, prioritise and move tickets, with permissions and valid transitions only', async () => {
      const ticket = (await open(two, { subject: 'Invoice question' }).expect(201)).body;
      await t.as(receptionist).patch(`/support/tickets/${ticket.id}`, { priority: 'HIGH' }).expect(403); // ticket.read only
      await staffReply(receptionist, ticket.id, { body: 'Hi' }).expect(403);
      await t.as(receptionist).post(`/support/tickets/${ticket.id}/status`, { status: 'RESOLVED' }).expect(403);
      await t.as(operator).get('/support/tickets').expect(403);
      await t.as(operator).get(`/support/tickets/${ticket.id}`).expect(403);
      await t.as(null).get('/support/tickets').expect(401);

      const assigned = await t.as(manager).patch(`/support/tickets/${ticket.id}`, { assigneeId: receptionist.membershipId, priority: 'URGENT', category: 'Billing' }).expect(200);
      expect(assigned.body).toMatchObject({ assigneeId: receptionist.membershipId, assigneeName: expect.stringContaining('receptionist'), priority: 'URGENT', category: 'Billing' });
      // New priority, new targets - still counted from when the ticket was opened.
      const openedAt = new Date(assigned.body.createdAt).getTime();
      expect(new Date(assigned.body.firstResponseDueAt).getTime() - openedAt).toBe(30 * 60_000);
      expect(new Date(assigned.body.resolutionDueAt).getTime() - openedAt).toBe(480 * 60_000);
      await t.as(manager).patch(`/support/tickets/${ticket.id}`, { assigneeId: '00000000-0000-4000-8000-000000000000' }).expect(404);
      await t.as(manager).patch(`/support/tickets/${ticket.id}`, { assigneeId: one.membershipId }).expect(404); // a customer is not staff
      await t.as(manager).patch(`/support/tickets/${ticket.id}`, { priority: 'EXTREME' }).expect(400);
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, resourceId: ticket.id, action: { in: ['ticket.assigned', 'ticket.updated'] } } })).toBe(2);

      expect((await t.as(manager).post(`/support/tickets/${ticket.id}/status`, { status: 'OPEN' }).expect(409)).body.code).toBe('NO_CHANGE');
      await t.as(manager).post(`/support/tickets/${ticket.id}/status`, { status: 'IN_PROGRESS' }).expect(200);
      expect((await t.as(manager).post(`/support/tickets/${ticket.id}/status`, { status: 'OPEN' }).expect(409)).body.code).toBe('INVALID_TRANSITION');
      await t.as(manager).post(`/support/tickets/${ticket.id}/status`, { status: 'WAITING_CUSTOMER' }).expect(200);
      const resolved = await t.as(manager).post(`/support/tickets/${ticket.id}/status`, { status: 'RESOLVED', resolutionSummary: 'Explained the invoice' }).expect(200);
      expect(resolved.body).toMatchObject({ status: 'RESOLVED', resolutionSummary: 'Explained the invoice', firstResponseBreached: false });
      expect((await t.as(manager).post(`/support/tickets/${ticket.id}/status`, { status: 'IN_PROGRESS' }).expect(200)).body).toMatchObject({ status: 'IN_PROGRESS', resolvedAt: null });
      const closed = await t.as(manager).post(`/support/tickets/${ticket.id}/status`, { status: 'CLOSED' }).expect(200);
      expect(closed.body.status).toBe('CLOSED');
      expect(closed.body.resolvedAt).toBeTruthy();
      await t.as(manager).post(`/support/tickets/${ticket.id}/status`, { status: 'DELETED' }).expect(400);

      // Filters.
      const ids = async (query: string) => (await t.as(manager).get(`/support/tickets?pageSize=100&${query}`).expect(200)).body.data.map((x: any) => x.id);
      expect(await ids('status=CLOSED')).toContain(ticket.id);
      expect(await ids('open=true')).not.toContain(ticket.id);
      expect(await ids(`assigneeId=${receptionist.membershipId}`)).toEqual([ticket.id]);
      expect(await ids('unassigned=true')).not.toContain(ticket.id);
      expect(await ids(`customerId=${two.customerId}&category=Billing&priority=URGENT`)).toEqual([ticket.id]);
      expect(await ids('q=invoice')).toEqual([ticket.id]);
    });

    it('lets staff open a ticket for a customer, who then finds it in the portal', async () => {
      const request = await makeRequest(t, alpha, two.customerId!);
      const otherRequest = await makeRequest(t, alpha, one.customerId!);
      const created = await t.as(manager).post('/support/tickets', { customerId: two.customerId, subject: 'Phone call: missing receipt', message: 'Customer called and asked for a copy of the receipt.', priority: 'HIGH', requestId: request.id, assigneeId: manager.membershipId }).expect(201);
      expect(created.body).toMatchObject({ customerId: two.customerId, priority: 'HIGH', assigneeId: manager.membershipId, requestNo: request.requestNo, status: 'OPEN' });
      await t.as(manager).post('/support/tickets', { customerId: two.customerId, subject: 'Wrong request', message: 'Linked to somebody else', requestId: otherRequest.id }).expect(404);
      await t.as(receptionist).post('/support/tickets', { customerId: two.customerId, subject: 'No permission', message: 'Should fail' }).expect(403);
      const mine = await t.as(two).get('/me/tickets').expect(200);
      expect(mine.body.data.map((x: any) => x.id)).toContain(created.body.id);
      expect((await t.as(two).get(`/me/tickets/${created.body.id}`).expect(200)).body.messages[0]).toMatchObject({ fromSupport: true, authorKind: 'STAFF', authorName: null });
    });
  });

  // ------------------------------------------------------------------ SLA job
  describe('SLA breaches (job support.sla)', () => {
    it('flags breaches in lists and creates one escalation task for managers per breach', async () => {
      const delta = await t.createTenant({ name: 'Delta Typing' });
      const boss = await t.addStaff(delta, 'manager');
      const portal = await t.addCustomer(delta);
      const ticket = (await t.http.post('/api/v1/me/tickets').set('Authorization', `Bearer ${portal.token}`).send({ subject: 'Nobody answers', message: 'Hello?' }).expect(201)).body;
      const healthy = (await t.http.post('/api/v1/me/tickets').set('Authorization', `Bearer ${portal.token}`).send({ subject: 'Just opened', message: 'Hi' }).expect(201)).body;
      const tasks = () => t.sys.task.findMany({ where: { tenantId: delta.id, source: 'ESCALATION' }, orderBy: { createdAt: 'asc' } });

      await runSla();
      expect(await tasks()).toHaveLength(0); // nothing is late yet

      // Five hours later (first response was due after four).
      const later = new Date(Date.now() + 5 * 3_600_000);
      await runSla(later);
      await runSla(later);
      let escalations = await tasks();
      expect(escalations).toHaveLength(2); // one per ticket, not one per run
      expect(escalations.map((e) => e.stepKey).sort()).toEqual([`sla:${healthy.id}:first_response`, `sla:${ticket.id}:first_response`].sort());
      const task = escalations.find((e) => e.stepKey === `sla:${ticket.id}:first_response`)!;
      expect(task).toMatchObject({ type: 'ESCALATION', source: 'ESCALATION', roleKey: 'manager', priority: 'HIGH', status: 'OPEN', customerId: portal.customerId });
      expect(task.title).toBe(`Ticket ${ticket.ticketNo} has had no reply within the agreed time`);
      // The manager finds it in the queue of their role and can take it.
      const queue = await t.as(boss).get('/tasks/mine').expect(200);
      expect(queue.body.data.find((x: any) => x.id === task.id)).toMatchObject({ claimable: true, type: 'ESCALATION' });
      await t.as(boss).post(`/tasks/${task.id}/claim`).expect(200);
      expect(await t.sys.auditLog.count({ where: { tenantId: delta.id, action: 'ticket.sla_breached', resourceId: ticket.id } })).toBe(1);

      // Really late now: make the stored due time lie in the past so the list shows it.
      await t.sys.supportTicket.update({ where: { id: ticket.id }, data: { firstResponseDueAt: new Date(Date.now() - 3_600_000) } });
      const list = await t.as(boss).get('/support/tickets?breached=true').expect(200);
      expect(list.body.data.map((x: any) => x.id)).toEqual([ticket.id]);
      expect(list.body.data[0]).toMatchObject({ firstResponseBreached: true, resolutionBreached: false });
      const all = await t.as(boss).get('/support/tickets').expect(200);
      expect(all.body.data.find((x: any) => x.id === healthy.id)).toMatchObject({ firstResponseBreached: false });

      // A late answer keeps the flag on the ticket.
      const answered = await t.as(boss).post(`/support/tickets/${ticket.id}/messages`, { body: 'Sorry for the delay.' }).expect(201);
      expect(answered.body).toMatchObject({ firstResponseBreached: true, status: 'IN_PROGRESS' });
      expect((await t.as(boss).get('/support/tickets?breached=true').expect(200)).body.data).toHaveLength(0); // answered: no longer an open breach
      // Resolved tickets are never escalated; the other one is still unresolved three days later.
      await t.as(boss).post(`/support/tickets/${healthy.id}/status`, { status: 'RESOLVED' }).expect(200);
      await runSla(new Date(Date.now() + 72 * 3_600_000));
      await runSla(new Date(Date.now() + 73 * 3_600_000));
      escalations = await tasks();
      expect(escalations.filter((e) => e.stepKey?.startsWith(`sla:${ticket.id}:`)).map((e) => e.stepKey).sort()).toEqual([`sla:${ticket.id}:first_response`, `sla:${ticket.id}:resolution`]);
      expect(escalations.some((e) => e.stepKey === `sla:${healthy.id}:resolution`)).toBe(false);
      expect(escalations).toHaveLength(3);
    });
  });

  // ------------------------------------------------------------------ feedback
  describe('customer feedback', () => {
    it('accepts one rating per resolved ticket or completed request, from its owner only', async () => {
      const epsilon = await t.createTenant({ name: 'Epsilon Typing' });
      const lead = await t.addStaff(epsilon, 'manager');
      const customer = await t.addCustomer(epsilon, { fullName: 'Happy Customer' });
      const other = await t.addCustomer(epsilon);
      const as = (actor: Actor) => t.as(actor);
      const ticket = (await as(customer).post('/me/tickets', { subject: 'Thanks', message: 'Quick question' }).expect(201)).body;
      const completed = await makeRequest(t, epsilon, customer.customerId!, { status: 'COMPLETED' });
      const running = await makeRequest(t, epsilon, customer.customerId!, { status: 'IN_PREPARATION' });

      expect((await as(customer).post('/me/feedback', { ticketId: ticket.id, rating: 5 }).expect(409)).body.code).toBe('NOT_RESOLVED');
      await as(lead).post(`/support/tickets/${ticket.id}/status`, { status: 'RESOLVED' }).expect(200);
      await as(other).post('/me/feedback', { ticketId: ticket.id, rating: 1 }).expect(404);
      await as(customer).post('/me/feedback', { ticketId: ticket.id, rating: 6 }).expect(400);
      await as(customer).post('/me/feedback', { ticketId: ticket.id, rating: 0 }).expect(400);
      await as(customer).post('/me/feedback', { rating: 4 }).expect(400);
      await as(customer).post('/me/feedback', { ticketId: ticket.id, requestId: completed.id, rating: 4 }).expect(400);

      // Two submissions at once: exactly one is stored.
      const [a, b] = await Promise.all([as(customer).post('/me/feedback', { ticketId: ticket.id, rating: 5, comment: 'Fast and friendly' }), as(customer).post('/me/feedback', { ticketId: ticket.id, rating: 5, comment: 'Fast and friendly' })]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect([a, b].find((r) => r.status === 409)!.body.code).toBe('ALREADY_RATED');
      expect(await t.sys.customerFeedback.count({ where: { tenantId: epsilon.id, ticketId: ticket.id } })).toBe(1);
      expect((await as(customer).get(`/me/tickets/${ticket.id}`).expect(200)).body).toMatchObject({ canRate: false, feedback: { rating: 5, comment: 'Fast and friendly' } });

      expect((await as(customer).post('/me/feedback', { requestId: running.id, rating: 3 }).expect(409)).body.code).toBe('NOT_COMPLETED');
      await as(other).post('/me/feedback', { requestId: completed.id, rating: 1 }).expect(404);
      const rated = await as(customer).post('/me/feedback', { requestId: completed.id, rating: 2, comment: 'Took too long' }).expect(201);
      expect(rated.body).toMatchObject({ requestId: completed.id, ticketId: null, rating: 2 });
      expect((await as(customer).post('/me/feedback', { requestId: completed.id, rating: 5 }).expect(409)).body.code).toBe('ALREADY_RATED');
      expect((await as(customer).get('/me/feedback').expect(200)).body.data.map((f: any) => [f.kind, f.rating]).sort()).toEqual([['REQUEST', 2], ['TICKET', 5]]);
      expect((await as(other).get('/me/feedback').expect(200)).body.meta.total).toBe(0);
      await as(lead).post('/me/feedback', { ticketId: ticket.id, rating: 5 }).expect(403); // staff cannot rate

      // Staff see the results and the monthly average.
      const list = await as(lead).get('/support/feedback').expect(200);
      expect(list.body.meta.total).toBe(2);
      expect(list.body.data.find((f: any) => f.kind === 'TICKET')).toMatchObject({ rating: 5, customerName: 'Happy Customer', ticketNo: ticket.ticketNo, ticketSubject: 'Thanks' });
      expect(list.body.data.find((f: any) => f.kind === 'REQUEST')).toMatchObject({ rating: 2, requestNo: completed.requestNo });
      expect((await as(lead).get('/support/feedback?maxRating=2').expect(200)).body.data.map((f: any) => f.rating)).toEqual([2]);
      expect((await as(lead).get('/support/feedback?kind=TICKET').expect(200)).body.meta.total).toBe(1);
      // An older rating from two months ago, for the report.
      const twoMonthsAgo = new Date();
      twoMonthsAgo.setUTCDate(15);
      twoMonthsAgo.setUTCMonth(twoMonthsAgo.getUTCMonth() - 2);
      await t.sys.customerFeedback.create({ data: { tenantId: epsilon.id, customerId: customer.customerId!, requestId: running.id, rating: 4, createdAt: twoMonthsAgo } });
      const summary = await as(lead).get('/support/feedback/summary').expect(200);
      expect(summary.body.months).toHaveLength(12);
      expect(summary.body.overall).toEqual({ count: 3, average: 3.67 });
      expect(summary.body.months.at(-1)).toMatchObject({ count: 2, average: 3.5, tickets: 1, requests: 1, distribution: { 1: 0, 2: 1, 3: 0, 4: 0, 5: 1 } });
      expect(summary.body.months.at(-3)).toMatchObject({ month: twoMonthsAgo.toISOString().slice(0, 7), count: 1, average: 4 });
      expect(summary.body.months.at(-2)).toMatchObject({ count: 0, average: null });
      const month = summary.body.to;
      expect((await as(lead).get(`/support/feedback/summary?from=${month}&to=${month}`).expect(200)).body.months).toHaveLength(1);
      await as(lead).get('/support/feedback/summary?from=2026-13').expect(400);
      await as(lead).get(`/support/feedback/summary?from=${month}&to=2020-01`).expect(400);
      const accountant = await t.addStaff(epsilon, 'accountant'); // report.operational
      await as(accountant).get('/support/feedback/summary').expect(200);
      await as(accountant).get('/support/feedback').expect(403);
    });
  });

  // ------------------------------------------------------------------ customers and isolation
  describe('customers, company users and tenant isolation', () => {
    it('shows customers only their own tickets and nothing of the staff side', async () => {
      const mine = (await open(one, { subject: 'Private matter' }).expect(201)).body;
      await t.as(two).get(`/me/tickets/${mine.id}`).expect(404);
      await t.as(two).post(`/me/tickets/${mine.id}/messages`, { body: 'Intruding' }).expect(404);
      expect((await t.as(two).get('/me/tickets?pageSize=100').expect(200)).body.data.some((x: any) => x.id === mine.id)).toBe(false);
      expect((await t.as(one).get('/me/tickets?status=OPEN&pageSize=100').expect(200)).body.data.some((x: any) => x.id === mine.id)).toBe(true);
      for (const path of ['/support/tickets', `/support/tickets/${mine.id}`, '/support/sla-policies', '/support/feedback', '/support/platform-tickets']) await t.as(one).get(path).expect(403);
      await t.as(one).post(`/support/tickets/${mine.id}/messages`, { body: 'As staff?' }).expect(403);
      await t.as(one).post(`/support/tickets/${mine.id}/status`, { status: 'CLOSED' }).expect(403);
      // Staff have no "my tickets".
      await t.as(manager).get('/me/tickets').expect(403);
      await t.as(null).get('/me/tickets').expect(401);
    });

    it('lets a company administrator without a customer record open tickets about the company requests', async () => {
      const account = await t.sys.corporateAccount.create({ data: { tenantId: alpha.id, accountNo: `CORP-${uniq()}`, companyName: 'Gulf Trading LLC', status: 'ACTIVE' } });
      const role = await t.sys.role.findFirstOrThrow({ where: { tenantId: alpha.id, key: 'corporate_admin' } });
      const email = `corp-${uniq()}@gulf-trading.example`;
      const user = await t.sys.user.create({ data: { email, fullName: 'Khalid PRO', passwordHash: await hashPassword(PASSWORD), emailVerifiedAt: new Date() } });
      await t.sys.tenantMembership.create({ data: { tenantId: alpha.id, userId: user.id, roleId: role.id, kind: 'CORPORATE', status: 'ACTIVE', corporateAccountId: account.id, allBranches: true } });
      const admin = await t.login(email, PASSWORD, 'corporate', alpha.slug);
      const employee = await makeCustomer(t, alpha, { corporateAccountId: account.id });
      const companyRequest = await t.sys.serviceRequest.create({ data: { tenantId: alpha.id, branchId: alpha.headOfficeId, requestNo: `TE-${uniq()}`.toUpperCase(), customerId: employee.id, corporateAccountId: account.id, serviceId: (await makeRequest(t, alpha, employee.id)).serviceId } });
      const foreignRequest = await makeRequest(t, alpha, one.customerId!);

      const ticket = await t.as(admin).post('/me/tickets', { subject: 'Labour card status', message: 'Any news?', requestId: companyRequest.id }).expect(201);
      expect(ticket.body).toMatchObject({ requestNo: companyRequest.requestNo, status: 'OPEN' });
      expect(ticket.body.messages[0]).toMatchObject({ fromSupport: false, authorName: 'Khalid PRO' });
      await t.as(admin).post('/me/tickets', { subject: 'Not ours', message: 'x', requestId: foreignRequest.id }).expect(404);
      expect((await t.as(admin).get('/me/tickets').expect(200)).body.data.map((x: any) => x.id)).toEqual([ticket.body.id]);
      const stored = await t.sys.supportTicket.findUniqueOrThrow({ where: { id: ticket.body.id } });
      expect(stored).toMatchObject({ customerId: null, raisedByUserId: user.id });
      expect((await t.sys.supportMessage.findFirstOrThrow({ where: { ticketId: stored.id } })).authorType).toBe('CORPORATE');
      // A rating is stored against a customer record, and a company's ticket has none: said in so many words.
      // (Completed requests of the company can be rated: corporate.employee-requests.spec.ts.)
      expect((await t.as(admin).post('/me/feedback', { ticketId: ticket.body.id, rating: 5 }).expect(422)).body.code).toBe('TICKET_RATING_NOT_AVAILABLE');
      expect((await t.as(admin).get('/me/feedback').expect(200)).body.data).toEqual([]);
      // Other customers of the centre do not see it.
      await t.as(one).get(`/me/tickets/${ticket.body.id}`).expect(404);
    });

    it('never lets tenant B read, answer or reference tenant A tickets', async () => {
      const ticket = (await open(one, { subject: 'Alpha confidential' }).expect(201)).body;
      await t.as(beta.owner).get(`/support/tickets/${ticket.id}`).expect(404);
      await t.as(beta.owner).patch(`/support/tickets/${ticket.id}`, { priority: 'LOW' }).expect(404);
      await staffReply(beta.owner, ticket.id, { body: 'Hello from Beta' }).expect(404);
      await t.as(beta.owner).post(`/support/tickets/${ticket.id}/status`, { status: 'CLOSED' }).expect(404);
      await t.as(beta.owner).post('/support/tickets', { customerId: one.customerId, subject: 'Cross tenant', message: 'x' }).expect(404);
      const betaCustomer = await t.addCustomer(beta);
      await t.as(betaCustomer).get(`/me/tickets/${ticket.id}`).expect(404);
      await t.as(betaCustomer).post(`/me/tickets/${ticket.id}/messages`, { body: 'x' }).expect(404);
      await t.as(betaCustomer).post('/me/feedback', { ticketId: ticket.id, rating: 1 }).expect(404);
      const alphaRequest = await makeRequest(t, alpha, one.customerId!);
      await t.as(betaCustomer).post('/me/tickets', { subject: 'Wrong centre', message: 'x', requestId: alphaRequest.id }).expect(404);
      const alphaDocument = await makeDocument(alpha, one.customerId!);
      await t.as(betaCustomer).post('/me/tickets', { subject: 'Wrong centre', message: 'x', attachments: [alphaDocument.id] }).expect(404);

      const list = await t.as(beta.owner).get('/support/tickets?pageSize=100').expect(200);
      expect(JSON.stringify(list.body)).not.toContain('Alpha confidential');
      const seen = await t.inTenant(beta.id, () => t.db.tx((tx) => tx.supportTicket.findMany({ select: { tenantId: true } })));
      expect(seen.every((r) => r.tenantId === beta.id)).toBe(true);
      const messages = await t.inTenant(beta.id, () => t.db.tx((tx) => tx.supportMessage.findMany({ select: { tenantId: true } })));
      expect(messages.every((r) => r.tenantId === beta.id)).toBe(true);
      await expect(
        t.inTenant(beta.id, () => t.db.tx((tx) => tx.supportMessage.create({ data: { tenantId: beta.id, ticketId: ticket.id, authorType: 'STAFF', body: 'injected' } }))),
      ).rejects.toThrow(/cross-tenant|violates|security/i);
      expect((await t.sys.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('OPEN');
    });
  });

  // ------------------------------------------------------------------ platform tickets
  describe('platform tickets (centre -> TypEase support)', () => {
    it('lets owners and managers ask TypEase support, and platform staff answer across tenants without seeing customer data', async () => {
      const agent = await t.createPlatformAdmin('SUPPORT_AGENT');
      const admin = await t.createPlatformAdmin('SUPER_ADMIN');
      const customerTicket = (await open(one, { subject: 'CUSTOMER-ONLY ticket' }).expect(201)).body;

      // Centre side.
      await t.as(receptionist).post('/support/platform-tickets', { subject: 'Help', message: 'x' }).expect(403);
      await t.as(one).post('/support/platform-tickets', { subject: 'Help', message: 'x' }).expect(403);
      const opened = await t.as(alpha.owner).post('/support/platform-tickets', { subject: 'Cannot verify our custom domain', message: 'DNS record is in place but verification fails.', priority: 'HIGH', category: 'Domains' }).expect(201);
      expect(opened.body).toMatchObject({ ticketNo: expect.stringMatching(/^TKT-\d{6}$/), subject: 'Cannot verify our custom domain', status: 'OPEN', canReply: true, requestId: null });
      expect(opened.body.messages[0]).toMatchObject({ fromSupport: false, body: 'DNS record is in place but verification fails.' });
      const betaTicket = (await t.as(beta.owner).post('/support/platform-tickets', { subject: 'Invoice for our subscription', message: 'Please resend it.' }).expect(201)).body;
      const stored = await t.sys.supportTicket.findUniqueOrThrow({ where: { id: opened.body.id } });
      expect(stored).toMatchObject({ scope: 'PLATFORM', customerId: null, requestId: null, raisedByUserId: alpha.owner.userId, firstResponseDueAt: null });
      // Platform tickets and customer tickets never mix on the centre side.
      await t.as(alpha.owner).get(`/support/tickets/${opened.body.id}`).expect(404);
      await t.as(alpha.owner).get(`/support/platform-tickets/${customerTicket.id}`).expect(404);
      expect((await t.as(alpha.owner).get('/support/tickets?pageSize=100').expect(200)).body.data.some((x: any) => x.id === opened.body.id)).toBe(false);
      expect((await t.as(manager).get('/support/platform-tickets').expect(200)).body.data.map((x: any) => x.id)).toEqual([opened.body.id]);
      await t.as(alpha.owner).get(`/support/platform-tickets/${betaTicket.id}`).expect(404);

      // Platform side: across tenants, platform tickets only.
      const list = await t.as(agent).get('/platform/support/tickets?pageSize=100').expect(200);
      const ids = list.body.data.map((x: any) => x.id);
      expect(ids).toEqual(expect.arrayContaining([opened.body.id, betaTicket.id]));
      expect(ids).not.toContain(customerTicket.id);
      const row = list.body.data.find((x: any) => x.id === opened.body.id);
      expect(row.tenant).toEqual({ id: alpha.id, name: 'Alpha Typing', slug: alpha.slug, status: 'ACTIVE', plan: { key: 'enterprise', name: 'Enterprise', status: 'ACTIVE' } });
      expect(Object.keys(row).sort()).toEqual(['category', 'closedAt', 'createdAt', 'firstRespondedAt', 'id', 'platformAssigneeId', 'platformAssigneeName', 'priority', 'resolutionSummary', 'resolvedAt', 'status', 'subject', 'tenant', 'ticketNo', 'updatedAt']);
      expect(JSON.stringify(list.body)).not.toContain('CUSTOMER-ONLY');
      expect(JSON.stringify(list.body)).not.toContain('Fatima');
      await t.as(agent).get(`/platform/support/tickets/${customerTicket.id}`).expect(404);
      await t.as(agent).post(`/platform/support/tickets/${customerTicket.id}/messages`, { body: 'Should not work' }).expect(404);
      await t.as(agent).patch(`/platform/support/tickets/${customerTicket.id}`, { status: 'CLOSED' }).expect(404);
      expect((await t.as(agent).get(`/platform/support/tickets?tenantId=${beta.id}`).expect(200)).body.data.map((x: any) => x.id)).toEqual([betaTicket.id]);
      expect((await t.as(agent).get('/platform/support/tickets?q=custom%20domain').expect(200)).body.data.map((x: any) => x.id)).toEqual([opened.body.id]);

      // Access boundaries in both directions.
      expect((await t.as(alpha.owner).get('/platform/support/tickets').expect(403)).body.code).toBe('PLATFORM_ONLY');
      await t.as(one).get('/platform/support/tickets').expect(403);
      await t.as(null).get('/platform/support/tickets').expect(401);
      expect((await t.as(agent).get('/support/tickets').expect(403)).body.code).toBe('TENANT_REQUIRED');
      await t.as(agent).get(`/support/platform-tickets/${opened.body.id}`).expect(403);

      // An internal note stays inside TypEase; a reply reaches the centre.
      const note = await t.as(agent).post(`/platform/support/tickets/${opened.body.id}/messages`, { body: 'PLATFORM-INTERNAL: check the CNAME target', visibility: 'INTERNAL' }).expect(201);
      expect(note.body).toMatchObject({ status: 'OPEN', firstRespondedAt: null });
      const reply = await t.as(agent).post(`/platform/support/tickets/${opened.body.id}/messages`, { body: 'Please add the TXT record shown in Settings > Domains.' }).expect(201);
      expect(reply.body).toMatchObject({ status: 'IN_PROGRESS', platformAssigneeId: agent.userId, platformAssigneeName: 'Platform SUPPORT_AGENT' });
      expect(reply.body.messages.map((m: any) => [m.fromCentre, m.visibility])).toEqual([[true, 'CUSTOMER'], [false, 'INTERNAL'], [false, 'CUSTOMER']]);
      const centreView = await t.as(alpha.owner).get(`/support/platform-tickets/${opened.body.id}`).expect(200);
      expect(centreView.body.status).toBe('IN_PROGRESS');
      expect(centreView.body.messages).toHaveLength(2);
      expect(centreView.body.messages[1]).toMatchObject({ fromSupport: true, authorKind: 'PLATFORM', authorName: null, body: 'Please add the TXT record shown in Settings > Domains.' });
      expect(JSON.stringify(centreView.body)).not.toContain('PLATFORM-INTERNAL');

      // The person who asked is told (in the centre's own notification pipeline).
      await t.settle();
      const notified = await t.sys.notification.findMany({ where: { tenantId: alpha.id, eventKey: 'support.response', relatedId: opened.body.id }, orderBy: { channel: 'asc' } });
      expect(notified.map((n) => [n.channel, n.status])).toEqual([['EMAIL', 'SENT'], ['IN_APP', 'SENT']]);
      expect(notified[0].recipientAddress).toBe(alpha.owner.email);
      expect(notified[0].body).toContain('TypEase Support replied to your support ticket');

      // Assignment only to platform staff; resolve; the centre reopens with a reply.
      expect((await t.as(agent).patch(`/platform/support/tickets/${opened.body.id}`, { platformAssigneeId: alpha.owner.userId }).expect(422)).body.code).toBe('NOT_PLATFORM_STAFF');
      const reassigned = await t.as(admin).patch(`/platform/support/tickets/${opened.body.id}`, { platformAssigneeId: admin.userId, priority: 'URGENT' }).expect(200);
      expect(reassigned.body).toMatchObject({ platformAssigneeId: admin.userId, priority: 'URGENT' });
      const resolved = await t.as(agent).patch(`/platform/support/tickets/${opened.body.id}`, { status: 'RESOLVED', resolutionSummary: 'TXT record was missing' }).expect(200);
      expect(resolved.body).toMatchObject({ status: 'RESOLVED', resolutionSummary: 'TXT record was missing' });
      const back = await t.as(alpha.owner).post(`/support/platform-tickets/${opened.body.id}/messages`, { body: 'Still failing after adding it.' }).expect(201);
      expect(back.body).toMatchObject({ status: 'IN_PROGRESS', resolvedAt: null });
      expect((await t.as(agent).patch(`/platform/support/tickets/${opened.body.id}`, { status: 'OPEN' }).expect(409)).body.code).toBe('INVALID_TRANSITION');
      await t.as(agent).patch(`/platform/support/tickets/${opened.body.id}`, { status: 'CLOSED' }).expect(200);
      expect((await t.as(alpha.owner).post(`/support/platform-tickets/${opened.body.id}/messages`, { body: 'Hello?' }).expect(409)).body.code).toBe('TICKET_CLOSED');
      expect((await t.as(agent).post(`/platform/support/tickets/${opened.body.id}/messages`, { body: 'Reopen?' }).expect(409)).body.code).toBe('TICKET_CLOSED');
      const audit = await t.sys.auditLog.findMany({ where: { tenantId: alpha.id, resourceId: opened.body.id, action: { startsWith: 'platform_ticket.' } } });
      expect(audit.length).toBeGreaterThanOrEqual(5);
      expect(audit.every((a) => a.actorType === 'PLATFORM')).toBe(true);
      // The SLA job leaves platform tickets alone.
      await runSla(new Date(Date.now() + 30 * 86_400_000));
      expect(await t.sys.task.count({ where: { tenantId: beta.id, stepKey: { startsWith: `sla:${betaTicket.id}` } } })).toBe(0);
    });
  });
});
