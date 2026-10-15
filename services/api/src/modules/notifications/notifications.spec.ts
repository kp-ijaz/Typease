import { NOTIFICATION_EVENTS } from '@typease/types';
import { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { DomainEvents } from '../../common/events.service';
import { ProvisioningService } from '../tenancy/provisioning.service';
import { DeliveryService } from './delivery.service';
import { NotificationEventMapper } from './event-mapper.service';
import { emit, makeCustomer, makeIntegration, makeRequest, makeService, setConsent, TestSmtp } from './fixtures';
import { DELIVER_JOB, NotificationService } from './notification.service';
import { LogProvider } from './providers/log';
import { ProviderRegistry } from './providers/registry';
import { ProviderError } from './providers/types';

describe('Notifications', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let receptionist: Actor;
  let smtp: TestSmtp;

  const rowsFor = (tenantId: string, eventId: string) => t.sys.notification.findMany({ where: { tenantId, dedupeKey: { startsWith: `${eventId}:` } }, include: { notificationDeliveries: { orderBy: { attempt: 'asc' } } }, orderBy: { channel: 'asc' } });
  const byChannel = <T extends { channel: string }>(rows: T[], channel: string) => rows.find((r) => r.channel === channel);

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    receptionist = await t.addStaff(alpha, 'receptionist');
    smtp = await new TestSmtp().start();
    await t.settle();
  });
  afterAll(async () => {
    await smtp.stop();
    await t.close();
  });

  // ------------------------------------------------------------------ templates
  describe('templates', () => {
    it('seeds platform defaults for every event in English and Arabic and never overwrites an edited row', async () => {
      const defaults = await t.sys.notificationTemplate.findMany({ where: { tenantId: null } });
      for (const key of Object.keys(NOTIFICATION_EVENTS)) {
        for (const channel of ['EMAIL', 'IN_APP']) for (const language of ['en', 'ar']) expect([key, channel, language, defaults.some((d) => d.eventKey === key && d.channel === channel && d.language === language)]).toEqual([key, channel, language, true]);
      }
      const row = defaults.find((d) => d.eventKey === 'report.scheduled' && d.channel === 'EMAIL' && d.language === 'en')!;
      await t.sys.notificationTemplate.update({ where: { id: row.id }, data: { body: 'Edited by platform staff {{reportName}}' } });
      await t.get(ProvisioningService).bootstrapPlatform();
      const after = await t.sys.notificationTemplate.findMany({ where: { tenantId: null } });
      expect(after).toHaveLength(defaults.length);
      expect(after.find((d) => d.id === row.id)!.body).toBe('Edited by platform staff {{reportName}}');
      await t.sys.notificationTemplate.update({ where: { id: row.id }, data: { body: row.body } });
    });

    it('lists effective templates, lets a centre override one, preview it and reset it', async () => {
      const list = await t.as(alpha.owner).get('/notifications/templates?eventKey=request.completed&channel=EMAIL').expect(200);
      expect(list.body).toHaveLength(2);
      expect(list.body.every((r: any) => r.source === 'DEFAULT' && r.enabled === true)).toBe(true);
      expect(list.body[0].variables).toEqual(expect.arrayContaining(['customerName', 'requestNumber', 'portalLink', 'centreName']));

      const saved = await t
        .as(alpha.owner)
        .put('/notifications/templates/request.completed/EMAIL/en', { subject: 'Alpha says: {{requestNumber}} done', body: 'Dear {{customerName}}, collect {{requestNumber}} today. {{madeUp}}\n\n[See it]({{portalLink}})' })
        .expect(200);
      expect(saved.body.source).toBe('TENANT');
      expect(saved.body.unknownVariables).toEqual(['madeUp']);

      const after = await t.as(alpha.owner).get('/notifications/templates?eventKey=request.completed&channel=EMAIL&language=en').expect(200);
      expect(after.body[0]).toMatchObject({ source: 'TENANT', subject: 'Alpha says: {{requestNumber}} done' });
      expect(after.body[0].default.subject).toContain('is complete');

      const preview = await t.as(alpha.owner).post('/notifications/templates/preview', { eventKey: 'request.completed', channel: 'EMAIL', language: 'en' }).expect(200);
      expect(preview.body.subject).toBe('Alpha says: TE-000123 done');
      expect(preview.body.text).toContain('Dear Fatima Al Mansoori, collect TE-000123 today.');
      expect(preview.body.html).toContain('Alpha Typing');
      expect(preview.body.html).toContain('>See it</a>');
      const draft = await t.as(alpha.owner).post('/notifications/templates/preview', { eventKey: 'request.completed', channel: 'SMS', language: 'ar', body: 'مرحبا {{customerName}} <b>', data: { customerName: 'سارة' } }).expect(200);
      expect(draft.body.text).toBe('مرحبا سارة <b>');
      expect(draft.body.html).toBeNull();

      // Another centre still sees the platform default, never Alpha's wording.
      const other = await t.as(beta.owner).get('/notifications/templates?eventKey=request.completed&channel=EMAIL&language=en').expect(200);
      expect(other.body[0].source).toBe('DEFAULT');
      expect(JSON.stringify(other.body)).not.toContain('Alpha says');
      await t.as(beta.owner).delete('/notifications/templates/request.completed/EMAIL/en').expect(404);

      const audit = await t.sys.auditLog.findFirst({ where: { tenantId: alpha.id, action: 'notification_template.created' } });
      expect(audit?.actorUserId).toBe(alpha.owner.userId);
    });

    it('validates template input and requires notification.manage', async () => {
      await t.as(alpha.owner).put('/notifications/templates/nope.unknown/EMAIL/en', { subject: 's', body: 'some body' }).expect(422);
      await t.as(alpha.owner).put('/notifications/templates/request.completed/FAX/en', { subject: 's', body: 'some body' }).expect(400);
      await t.as(alpha.owner).put('/notifications/templates/request.completed/EMAIL/en', { body: 'no subject here' }).expect(422);
      await t.as(receptionist).get('/notifications/templates').expect(403);
      await t.as(receptionist).put('/notifications/templates/request.completed/EMAIL/en', { subject: 's', body: 'some body' }).expect(403);
      await t.as(receptionist).get('/notifications').expect(403);
      await t.as(receptionist).get('/notifications/channels').expect(403);
      await t.as(null).get('/notifications').expect(401);
      const events = await t.as(alpha.owner).get('/notifications/events').expect(200);
      expect(events.body.find((e: any) => e.eventKey === 'document.expiry')).toMatchObject({ group: 'reminders', requiredConsent: 'REMINDERS' });
      expect(events.body.find((e: any) => e.eventKey === 'account.otp').bypassesPreferences).toBe(true);
    });
  });

  // ------------------------------------------------------------------ event -> notification
  describe('event mapping and rendering', () => {
    it('notifies the customer about a new request by email and in the app, once per event', async () => {
      const portal = await t.addCustomer(alpha, { fullName: 'Layla Hassan' });
      const service = await makeService(t, alpha, { name: 'Emirates ID renewal' });
      const request = await makeRequest(t, alpha, portal.customerId!, { serviceId: service.id });
      const eventId = await emit(t, alpha.id, 'request.created', { requestId: request.id, customerId: portal.customerId, serviceId: service.id, branchId: alpha.headOfficeId, source: 'ONLINE' });
      await t.settle();

      const rows = await rowsFor(alpha.id, eventId);
      expect(rows.map((r) => r.channel).sort()).toEqual(['EMAIL', 'IN_APP']); // no device registered -> no push
      const email = byChannel(rows, 'EMAIL')!;
      expect(email).toMatchObject({ status: 'SENT', recipientAddress: portal.email, recipientCustomerId: portal.customerId, language: 'en', relatedType: 'ServiceRequest', relatedId: request.id });
      expect(email.subject).toBe(`We received your request ${request.requestNo}`);
      expect(email.notificationDeliveries).toHaveLength(1);
      expect(email.notificationDeliveries[0]).toMatchObject({ provider: 'log', attempt: 1, status: 'SENT' });
      expect(email.notificationDeliveries[0].providerMessageId).toMatch(/^log-/);
      const inApp = byChannel(rows, 'IN_APP')!;
      expect(inApp).toMatchObject({ status: 'SENT', recipientUserId: portal.userId });
      expect(inApp.notificationDeliveries).toHaveLength(0);

      const sent = LogProvider.lastFor(portal.email, 'EMAIL')!.message;
      expect(sent.text).toContain('Hello Layla Hassan');
      expect(sent.text).toContain('Emirates ID renewal');
      expect(sent.text).toContain(`/requests/${request.id}`);
      expect(sent.html).toContain('Alpha Typing');
      expect(sent.html).toContain(`requests/${request.id}`);
      // Platform sender with the centre's name while the centre's own address is not verified.
      expect(sent.from).toEqual({ name: 'Alpha Typing', address: 'no-reply@typease.localhost' });

      // The outbox delivers at least once: handling the same event again creates nothing new.
      const outbox = await t.sys.outboxEvent.findUniqueOrThrow({ where: { id: eventId } });
      await t.inTenant(alpha.id, () => t.get(NotificationEventMapper).handle({ id: outbox.id, tenantId: alpha.id, type: 'request.created', payload: outbox.payload as any, createdAt: outbox.createdAt }));
      await t.settle();
      expect(await rowsFor(alpha.id, eventId)).toHaveLength(2);

      // The customer finds it in the in-app inbox.
      const inbox = await t.as(portal).get('/me/notifications').expect(200);
      expect(inbox.body.unreadCount).toBe(2); // the welcome message from registration + this one
      expect(inbox.body.data.map((n: any) => n.eventKey).sort()).toEqual(['account.registered', 'request.created']);
      expect(inbox.body.data.find((n: any) => n.eventKey === 'request.created')).toMatchObject({ id: inApp.id, relatedId: request.id, readAt: null });
      expect(inbox.body.data[0].data).toBeUndefined();
      // "Account registration": the self-registered customer was welcomed by email as well.
      const welcome = await t.sys.notification.findFirstOrThrow({ where: { tenantId: alpha.id, eventKey: 'account.registered', channel: 'EMAIL', recipientCustomerId: portal.customerId } });
      expect(welcome).toMatchObject({ status: 'SENT', subject: 'Welcome to Alpha Typing', recipientAddress: portal.email });
    });

    it('chooses the Arabic template for an Arabic-language customer', async () => {
      const customer = await makeCustomer(t, alpha, { fullName: 'Mariam Saeed', fullNameAr: 'مريم سعيد', language: 'ar' });
      const service = await makeService(t, alpha);
      const request = await makeRequest(t, alpha, customer.id, { serviceId: service.id });
      const eventId = await emit(t, alpha.id, 'request.status_changed', { requestId: request.id, customerId: customer.id, from: 'SUBMITTED', to: 'IN_PREPARATION', customerVisible: true });
      await t.settle();
      const email = byChannel(await rowsFor(alpha.id, eventId), 'EMAIL')!;
      expect(email.language).toBe('ar');
      expect(email.subject).toBe(`تحديث على طلبك رقم ${request.requestNo}: قيد التحضير`);
      expect(email.body).toContain('مرحباً مريم سعيد');
      expect(email.body).toContain('تجديد تأشيرة الإقامة');
      expect(LogProvider.lastFor(customer.email!, 'EMAIL')!.message.html).toContain('dir="rtl"');
    });

    it('sends one specific message when staff ask the customer for something, in the reader language', async () => {
      const arabic = await makeCustomer(t, alpha, { fullNameAr: 'ليلى حسن', language: 'ar', phone: null });
      const english = await makeCustomer(t, alpha, { phone: null });
      const r1 = await makeRequest(t, alpha, arabic.id);
      const r2 = await makeRequest(t, alpha, english.id);
      // The requests module emits both events for the same change; without a staff note the message is the English status label.
      const status1 = await emit(t, alpha.id, 'request.status_changed', { requestId: r1.id, customerId: arabic.id, from: 'UNDER_REVIEW', to: 'AWAITING_CUSTOMER', customerVisible: true, customerMessage: 'Action needed from you' });
      const info1 = await emit(t, alpha.id, 'request.information_requested', { requestId: r1.id, customerId: arabic.id, message: 'Action needed from you' });
      const info2 = await emit(t, alpha.id, 'request.information_requested', { requestId: r2.id, customerId: english.id, message: 'Please upload the photo page of your passport.' });
      const status2 = await emit(t, alpha.id, 'request.status_changed', { requestId: r2.id, customerId: english.id, from: 'SUBMITTED', to: 'UNDER_REVIEW', customerVisible: true, customerMessage: 'Documents under review' });
      await t.settle();

      expect(await rowsFor(alpha.id, status1)).toHaveLength(0); // covered by the "documents missing" message
      const ar = byChannel(await rowsFor(alpha.id, info1), 'EMAIL')!;
      expect(ar).toMatchObject({ eventKey: 'request.documents_missing', language: 'ar', status: 'SENT' });
      expect(ar.body).toContain('مطلوب إجراء منك');
      expect(ar.body).not.toContain('Action needed from you');
      const en = byChannel(await rowsFor(alpha.id, info2), 'EMAIL')!;
      expect(en.subject).toBe(`Action needed for request ${r2.requestNo}`);
      expect(en.body).toContain('Please upload the photo page of your passport.');
      // A default customer message only repeats the status: it is not printed twice.
      const update = byChannel(await rowsFor(alpha.id, status2), 'EMAIL')!;
      expect(update.subject).toBe(`Update on your request ${r2.requestNo}: Documents under review`);
      expect(update.body.match(/Documents under review/g)).toHaveLength(1);
    });

    it('uses the centre override instead of the default, and the default again after a reset', async () => {
      const customer = await makeCustomer(t, alpha, { fullName: 'Noor Ali' });
      const request = await makeRequest(t, alpha, customer.id);
      const first = await emit(t, alpha.id, 'request.completed', { requestId: request.id, customerId: customer.id });
      await t.settle();
      const overridden = byChannel(await rowsFor(alpha.id, first), 'EMAIL')!;
      expect(overridden.subject).toBe(`Alpha says: ${request.requestNo} done`);
      expect(overridden.body).toContain(`Dear Noor Ali, collect ${request.requestNo} today.`);
      expect((overridden.data as any).templateSource).toBe('TENANT');

      // Beta keeps the platform wording for the same event.
      const betaCustomer = await makeCustomer(t, beta);
      const betaRequest = await makeRequest(t, beta, betaCustomer.id);
      const betaEvent = await emit(t, beta.id, 'request.completed', { requestId: betaRequest.id, customerId: betaCustomer.id });
      await t.settle();
      expect(byChannel(await rowsFor(beta.id, betaEvent), 'EMAIL')!.subject).toBe(`Your request ${betaRequest.requestNo} is complete`);

      const reset = await t.as(alpha.owner).delete('/notifications/templates/request.completed/EMAIL/en').expect(200);
      expect(reset.body.source).toBe('DEFAULT');
      const second = await emit(t, alpha.id, 'request.completed', { requestId: request.id, customerId: customer.id });
      await t.settle();
      expect(byChannel(await rowsFor(alpha.id, second), 'EMAIL')!.subject).toBe(`Your request ${request.requestNo} is complete`);
    });

    it('uses the own sender address of a centre only after it was verified', async () => {
      const gamma = await t.createTenant({ name: 'Gamma Typing' });
      const customer = await makeCustomer(t, gamma, { phone: null });
      const request = await makeRequest(t, gamma, customer.id);
      const fire = async () => {
        await emit(t, gamma.id, 'request.completed', { requestId: request.id, customerId: customer.id });
        await t.settle();
        return LogProvider.lastFor(customer.email!, 'EMAIL')!.message;
      };
      await t.sys.brandingSettings.updateMany({ where: { tenantId: gamma.id, branchId: null }, data: { emailFromName: 'Gamma Front Desk', emailFromAddress: 'hello@gamma-typing.example', emailSenderVerified: false, supportEmail: 'help@gamma-typing.example' } });
      const unverified = await fire();
      expect(unverified.from).toEqual({ name: 'Gamma Front Desk', address: 'no-reply@typease.localhost' });
      expect(unverified.replyTo).toBe('help@gamma-typing.example');
      expect(unverified.html).toContain('help@gamma-typing.example');
      await t.sys.brandingSettings.updateMany({ where: { tenantId: gamma.id, branchId: null }, data: { emailSenderVerified: true } });
      expect((await fire()).from).toEqual({ name: 'Gamma Front Desk', address: 'hello@gamma-typing.example' });
    });

    it('skips internal status changes and tells the assigned staff member and the customer about an assignment', async () => {
      const operator = await t.addStaff(alpha, 'operator');
      const portal = await t.addCustomer(alpha);
      const request = await makeRequest(t, alpha, portal.customerId!);
      const internal = await emit(t, alpha.id, 'request.status_changed', { requestId: request.id, customerId: portal.customerId, from: 'IN_PREPARATION', to: 'PENDING_APPROVAL', customerVisible: false });
      const assigned = await emit(t, alpha.id, 'request.assigned', { requestId: request.id, customerId: portal.customerId, assigneeMembershipId: operator.membershipId, assigneeUserId: operator.userId, role: 'OPERATOR', method: 'MANUAL' });
      await t.settle();
      expect(await rowsFor(alpha.id, internal)).toHaveLength(0);
      const rows = await rowsFor(alpha.id, assigned);
      expect(rows.map((r) => `${r.eventKey}:${r.channel}`).sort()).toEqual(['request.assigned_to_you:IN_APP', 'request.staff_assigned:IN_APP']);
      expect(rows.find((r) => r.eventKey === 'request.assigned_to_you')).toMatchObject({ recipientUserId: operator.userId, recipientCustomerId: null });
      const staffInbox = await t.as(operator).get('/me/notifications').expect(200);
      expect(staffInbox.body.data[0].subject).toBe(`New assignment: ${request.requestNo}`);
      // The customer's inbox never shows the staff notification.
      const customerInbox = await t.as(portal).get('/me/notifications').expect(200);
      expect(customerInbox.body.data.map((n: any) => n.eventKey).sort()).toEqual(['account.registered', 'request.staff_assigned']);
    });

    it('maps quotation, payment, support and subscription events to their templates', async () => {
      const portal = await t.addCustomer(alpha, { fullName: 'Huda Karim' });
      const request = await makeRequest(t, alpha, portal.customerId!);
      const quotation = await t.sys.quotation.create({ data: { tenantId: alpha.id, branchId: alpha.headOfficeId, quotationNo: 'QUO-900001', requestId: request.id, customerId: portal.customerId!, status: 'SENT', subtotalServiceFee: '525.00', total: '525.00' } });
      const invoice = await t.sys.invoice.create({ data: { tenantId: alpha.id, branchId: alpha.headOfficeId, invoiceNo: 'INV-900001', requestId: request.id, customerId: portal.customerId!, subtotalServiceFee: '525.00', total: '525.00', balanceDue: '525.00' } });
      const payment = await t.sys.payment.create({ data: { tenantId: alpha.id, branchId: alpha.headOfficeId, paymentNo: 'PAY-900001', receiptNo: 'RCT-900001', customerId: portal.customerId!, method: 'CASH', status: 'COMPLETED', amount: '525.00' } });
      const ticket = await t.sys.supportTicket.create({ data: { tenantId: alpha.id, ticketNo: 'TKT-900001', customerId: portal.customerId!, subject: 'Where is my visa?', raisedByUserId: portal.userId } });

      const q = await emit(t, alpha.id, 'quotation.sent', { quotationId: quotation.id, requestId: request.id, customerId: portal.customerId, total: '525.00', currency: 'AED' });
      const pr = await emit(t, alpha.id, 'payment.requested', { invoiceId: invoice.id, requestId: request.id, customerId: portal.customerId, amount: '525.00', currency: 'AED' });
      const pc = await emit(t, alpha.id, 'payment.completed', { paymentId: payment.id, customerId: portal.customerId, amount: '525.00', currency: 'AED', method: 'CASH', invoiceIds: [invoice.id], requestIds: [request.id] });
      const staffReply = await emit(t, alpha.id, 'ticket.replied', { ticketId: ticket.id, customerId: portal.customerId, authorType: 'STAFF', visibility: 'CUSTOMER' });
      const internalNote = await emit(t, alpha.id, 'ticket.replied', { ticketId: ticket.id, customerId: portal.customerId, authorType: 'STAFF', visibility: 'INTERNAL' });
      const ownReply = await emit(t, alpha.id, 'ticket.replied', { ticketId: ticket.id, customerId: portal.customerId, authorType: 'CUSTOMER', visibility: 'CUSTOMER' });
      const renewal = await emit(t, alpha.id, 'subscription.renewal_due', { subscriptionId: 'n/a', dueAt: '2026-11-01T00:00:00.000Z', amount: '1999.00', currency: 'AED' });
      await t.settle();

      expect(byChannel(await rowsFor(alpha.id, q), 'EMAIL')).toMatchObject({ eventKey: 'quotation.ready', subject: 'Your quotation QUO-900001 is ready', status: 'SENT' });
      expect(byChannel(await rowsFor(alpha.id, q), 'SMS')!.body).toContain('quotation QUO-900001 for 525.00 AED is ready');
      expect(byChannel(await rowsFor(alpha.id, pr), 'EMAIL')).toMatchObject({ eventKey: 'payment.requested', subject: 'Payment requested: invoice INV-900001' });
      expect(byChannel(await rowsFor(alpha.id, pc), 'EMAIL')!.body).toContain('Reference: RCT-900001');
      const reply = await rowsFor(alpha.id, staffReply);
      expect(byChannel(reply, 'EMAIL')).toMatchObject({ eventKey: 'support.response', subject: 'New reply to your ticket TKT-900001' });
      expect(byChannel(reply, 'EMAIL')!.body).toContain('Alpha Typing replied to your support ticket');
      expect(await rowsFor(alpha.id, internalNote)).toHaveLength(0);
      expect(await rowsFor(alpha.id, ownReply)).toHaveLength(0);

      const owners = await rowsFor(alpha.id, renewal);
      expect(owners.map((r) => r.channel).sort()).toEqual(['EMAIL', 'IN_APP']);
      expect(byChannel(owners, 'EMAIL')).toMatchObject({ eventKey: 'subscription.renewal', recipientAddress: alpha.owner.email, recipientUserId: null });
      expect(byChannel(owners, 'EMAIL')!.body).toContain('renews on 1 Nov 2026 for 1999.00 AED');
      expect(byChannel(owners, 'IN_APP')!.recipientUserId).toBe(alpha.owner.userId);
    });
  });

  // ------------------------------------------------------------------ consent, preferences, limits
  describe('consent, preferences and limits', () => {
    it('respects an opt-out: the notification is stored as SUPPRESSED, never sent, never dropped', async () => {
      const portal = await t.addCustomer(alpha);
      const request = await makeRequest(t, alpha, portal.customerId!);
      const prefs = await t.as(portal).put('/me/notification-preferences', { preferences: [{ channel: 'EMAIL', eventGroup: 'requests', enabled: false }] }).expect(200);
      expect(prefs.body.preferences).toEqual([expect.objectContaining({ channel: 'EMAIL', eventGroup: 'requests', enabled: false })]);
      await t.settle(); // the verification email from registration is out of the way
      const before = LogProvider.outbox.length;

      const eventId = await emit(t, alpha.id, 'request.created', { requestId: request.id, customerId: portal.customerId, serviceId: request.serviceId, branchId: alpha.headOfficeId, source: 'ONLINE' });
      await t.settle();
      const rows = await rowsFor(alpha.id, eventId);
      expect(byChannel(rows, 'EMAIL')).toMatchObject({ status: 'SUPPRESSED', suppressedReason: 'OPT_OUT', sentAt: null });
      expect(byChannel(rows, 'EMAIL')!.notificationDeliveries).toHaveLength(0);
      expect(byChannel(rows, 'IN_APP')!.status).toBe('SENT');
      expect(LogProvider.outbox.slice(before).some((m) => m.message.to === portal.email)).toBe(false);

      // The opt-out covers the "requests" group only: a payment message still goes out.
      const payment = await t.sys.payment.create({ data: { tenantId: alpha.id, branchId: alpha.headOfficeId, paymentNo: `PAY-${Date.now()}`, customerId: portal.customerId!, method: 'CASH', status: 'COMPLETED', amount: '10.00' } });
      const paid = await emit(t, alpha.id, 'payment.completed', { paymentId: payment.id, customerId: portal.customerId, amount: '10.00', currency: 'AED', method: 'CASH', invoiceIds: [], requestIds: [] });
      await t.settle();
      expect(byChannel(await rowsFor(alpha.id, paid), 'EMAIL')!.status).toBe('SENT');

      // Opting back in works, and the choice is audited.
      await t.as(portal).put('/me/notification-preferences', { preferences: [{ channel: 'EMAIL', eventGroup: 'requests', enabled: true }] }).expect(200);
      const again = await emit(t, alpha.id, 'request.completed', { requestId: request.id, customerId: portal.customerId });
      await t.settle();
      expect(byChannel(await rowsFor(alpha.id, again), 'EMAIL')!.status).toBe('SENT');
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'notification.preferences_updated', resourceId: portal.customerId } })).toBe(2);
      await t.as(portal).put('/me/notification-preferences', { preferences: [{ channel: 'EMAIL', eventGroup: 'security', enabled: false }] }).expect(400);
    });

    it('honours the customer profile switches and records a missing address', async () => {
      const noSms = await makeCustomer(t, alpha, { communicationPrefs: { email: true, sms: false, whatsapp: false, push: true } });
      const noEmail = await makeCustomer(t, alpha, { email: null });
      const r1 = await makeRequest(t, alpha, noSms.id);
      const r2 = await makeRequest(t, alpha, noEmail.id);
      const e1 = await emit(t, alpha.id, 'request.completed', { requestId: r1.id, customerId: noSms.id });
      const e2 = await emit(t, alpha.id, 'request.completed', { requestId: r2.id, customerId: noEmail.id });
      await t.settle();
      const first = await rowsFor(alpha.id, e1);
      expect(byChannel(first, 'SMS')).toMatchObject({ status: 'SUPPRESSED', suppressedReason: 'OPT_OUT' });
      expect(byChannel(first, 'EMAIL')!.status).toBe('SENT');
      expect(first.some((r) => r.channel === 'IN_APP')).toBe(false); // walk-in customer without a portal account
      const second = await rowsFor(alpha.id, e2);
      expect(byChannel(second, 'EMAIL')).toMatchObject({ status: 'SUPPRESSED', suppressedReason: 'NO_ADDRESS', recipientAddress: null });
      expect(byChannel(second, 'SMS')).toMatchObject({ status: 'SENT', recipientAddress: noEmail.phone });
      expect(LogProvider.lastFor(noEmail.phone!, 'SMS')!.message.text).toContain(`your request ${r2.requestNo} is complete`);
    });

    it('sends WhatsApp only with consent, an opt-in and an approved template', async () => {
      const customer = await makeCustomer(t, alpha, { fullName: 'Rana Aziz' });
      const request = await makeRequest(t, alpha, customer.id);
      const fire = async () => {
        const id = await emit(t, alpha.id, 'request.completed', { requestId: request.id, customerId: customer.id });
        await t.settle();
        return byChannel(await rowsFor(alpha.id, id), 'WHATSAPP');
      };
      expect(await fire()).toBeUndefined(); // WhatsApp is off until the centre enables it for the event
      const toggled = await t.as(alpha.owner).patch('/notifications/events/request.completed/channels/WHATSAPP', { enabled: true }).expect(200);
      expect(toggled.body.events.find((e: any) => e.eventKey === 'request.completed').channels.WHATSAPP).toBe(true);

      expect(await fire()).toMatchObject({ status: 'SUPPRESSED', suppressedReason: 'NO_CONSENT_WHATSAPP' });
      await setConsent(t, alpha.id, customer.id, 'WHATSAPP', 'GRANTED');
      expect(await fire()).toMatchObject({ status: 'SUPPRESSED', suppressedReason: 'OPT_OUT' });
      await t.sys.customer.update({ where: { id: customer.id }, data: { communicationPrefs: { email: true, sms: true, whatsapp: true, push: true } } });
      // Business-initiated messages need a template approved by Meta.
      expect(await fire()).toMatchObject({ status: 'SUPPRESSED', suppressedReason: 'WHATSAPP_TEMPLATE_REQUIRED' });

      await t
        .as(alpha.owner)
        .put('/notifications/templates/request.completed/WHATSAPP/en', { body: 'Hello {{customerName}}, your request {{requestNumber}} is complete.', whatsappTemplateName: 'request_completed_v1' })
        .expect(200);
      const sent = await fire();
      expect(sent).toMatchObject({ status: 'SENT', recipientAddress: customer.phone });
      expect(sent!.notificationDeliveries[0]).toMatchObject({ provider: 'log', status: 'SENT' });
      expect(LogProvider.lastFor(customer.phone!, 'WHATSAPP')!.message.whatsapp).toEqual({ templateName: 'request_completed_v1', languageCode: 'en', parameters: ['Rana Aziz', request.requestNo] });

      // A separate WhatsApp number on the customer record is preferred over the phone number.
      await t.sys.customerContact.create({ data: { tenantId: alpha.id, customerId: customer.id, type: 'WHATSAPP', value: '+971507770001', isPrimary: true } });
      expect(await fire()).toMatchObject({ status: 'SENT', recipientAddress: '+971507770001' });

      await setConsent(t, alpha.id, customer.id, 'WHATSAPP', 'WITHDRAWN');
      expect(await fire()).toMatchObject({ status: 'SUPPRESSED', suppressedReason: 'NO_CONSENT_WHATSAPP' });
      await t.as(alpha.owner).patch('/notifications/events/request.completed/channels/WHATSAPP', { enabled: false }).expect(200);
    });

    it('lets a centre switch an event off per channel', async () => {
      const customer = await makeCustomer(t, beta);
      const request = await makeRequest(t, beta, customer.id);
      const settings = await t.as(beta.owner).put('/notifications/settings', { events: { 'request.completed': { SMS: false } } }).expect(200);
      expect(settings.body.events.find((e: any) => e.eventKey === 'request.completed').channels).toMatchObject({ EMAIL: true, SMS: false });
      const id = await emit(t, beta.id, 'request.completed', { requestId: request.id, customerId: customer.id });
      await t.settle();
      expect((await rowsFor(beta.id, id)).map((r) => r.channel)).toEqual(['EMAIL']);
      await t.as(beta.owner).put('/notifications/settings', { events: { 'made.up': { SMS: false } } }).expect(422);
      const stored = await t.sys.tenant.findUniqueOrThrow({ where: { id: beta.id } });
      expect((stored.settings as any).notifications.events['request.completed']).toEqual({ SMS: false });
    });

    it('limits messages per recipient and channel per hour', async () => {
      const gamma = await t.createTenant();
      await t.as(gamma.owner).put('/notifications/settings', { rateLimitPerHour: 2 }).expect(200);
      const customer = await makeCustomer(t, gamma, { phone: null });
      const request = await makeRequest(t, gamma, customer.id);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push(await emit(t, gamma.id, 'request.completed', { requestId: request.id, customerId: customer.id }));
      await t.settle();
      const statuses = [];
      for (const id of ids) statuses.push(byChannel(await rowsFor(gamma.id, id), 'EMAIL')!);
      // Deliveries run concurrently, so which of the three is over the limit is not fixed - only that exactly one is.
      expect(statuses.map((s) => s.status).sort()).toEqual(['SENT', 'SENT', 'SUPPRESSED']);
      expect(statuses.find((s) => s.status === 'SUPPRESSED')!.suppressedReason).toBe('RATE_LIMITED');
    });

    it('enforces the monthly plan limit for external channels while in-app keeps working', async () => {
      const starter = await t.createTenant({ plan: 'starter' });
      const portal = await t.addCustomer(starter);
      await t.settle();
      const request = await makeRequest(t, starter, portal.customerId!);
      const usage = await t.as(starter.owner).get('/tenant/usage').expect(200);
      const metric = usage.body.usage.find((u: any) => u.metric === 'notifications');
      expect(metric.limit).toBe(500);
      expect(metric.used).toBeGreaterThan(0); // the verification emails were metered

      const period = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`;
      await t.sys.usageRecord.updateMany({ where: { tenantId: starter.id, metric: 'notifications', periodKey: period }, data: { quantity: 499 } });
      const ok = await emit(t, starter.id, 'request.created', { requestId: request.id, customerId: portal.customerId, serviceId: request.serviceId, branchId: starter.headOfficeId, source: 'ONLINE' });
      // Delivered before the next one is emitted: concurrent deliveries would race for the last unit of the quota.
      await t.settle();
      const over = await emit(t, starter.id, 'request.completed', { requestId: request.id, customerId: portal.customerId });
      await t.settle();
      expect(byChannel(await rowsFor(starter.id, ok), 'EMAIL')!.status).toBe('SENT');
      const blocked = await rowsFor(starter.id, over);
      expect(byChannel(blocked, 'EMAIL')).toMatchObject({ status: 'SUPPRESSED', suppressedReason: 'PLAN_LIMIT' });
      expect(byChannel(blocked, 'IN_APP')!.status).toBe('SENT');
      const after = await t.sys.usageRecord.findFirstOrThrow({ where: { tenantId: starter.id, metric: 'notifications', periodKey: period } });
      expect(Number(after.quantity)).toBe(500);

      // Account-security messages are never blocked by the plan.
      await t.http.post('/api/v1/auth/password/forgot').send({ email: portal.email, app: 'customer', tenantSlug: starter.slug });
      await t.settle();
      const reset = await t.sys.notification.findFirst({ where: { tenantId: starter.id, eventKey: 'account.password_reset' } });
      if (reset) expect(reset.status).toBe('SENT');
    });
  });

  // ------------------------------------------------------------------ delivery pipeline
  describe('delivery, retries and failures', () => {
    it('retries a failed delivery safely: it ends SENT with exactly one successful attempt and one message (scenario 27)', async () => {
      // Alpha uses its own SMTP server (tenant integration beats the platform default).
      await makeIntegration(t, alpha.id, 'EMAIL', 'smtp', { host: '127.0.0.1', port: smtp.port, secure: false, fromAddress: 'hello@alpha-typing.example' }, { user: 'alpha-mailer', password: 'alpha-secret' });
      const customer = await makeCustomer(t, alpha, { fullName: 'Salma Idris', phone: null });
      const request = await makeRequest(t, alpha, customer.id);
      smtp.behaviour = [451]; // first attempt: temporary failure, then accept
      const attemptsBefore = smtp.attempts;

      const eventId = await emit(t, alpha.id, 'request.completed', { requestId: request.id, customerId: customer.id });
      await t.settle();

      const n = byChannel(await rowsFor(alpha.id, eventId), 'EMAIL')!;
      expect(n.status).toBe('SENT');
      expect(n.sentAt).not.toBeNull();
      expect(n.notificationDeliveries.map((d) => [d.attempt, d.status, d.provider])).toEqual([[1, 'FAILED', 'smtp'], [2, 'SENT', 'smtp']]);
      expect(n.notificationDeliveries[0].error).toContain('Try again later');
      expect(n.notificationDeliveries[1].providerMessageId).toBe(`<${n.id}@alpha-typing.example>`);
      expect(smtp.attempts - attemptsBefore).toBe(2);

      // Exactly one message reached the mailbox, with the centre's branding.
      const received = smtp.messages.filter((m) => m.to.includes(customer.email!));
      expect(received).toHaveLength(1);
      expect(received[0].header('Subject')).toBe(`Your request ${request.requestNo} is complete`);
      expect(received[0].header('From')).toBe('Alpha Typing <hello@alpha-typing.example>');
      expect(received[0].header('To')).toBe(customer.email);
      expect(received[0].text).toContain('Hello Salma Idris');
      expect(received[0].text).toContain(`your request ${request.requestNo}`);
      expect(received[0].text).toContain('Thank you for choosing Alpha Typing.');
      expect(smtp.logins.at(-1)).toEqual({ username: 'alpha-mailer', password: 'alpha-secret' });

      // A duplicate or late job for the same notification must not send again.
      await t.jobs.execute(DELIVER_JOB, { tenantId: alpha.id, notificationId: n.id }, { attempt: 1, maxAttempts: 5 });
      await t.jobs.enqueue(DELIVER_JOB, { tenantId: alpha.id, notificationId: n.id }, { jobId: `dup-${n.id}` });
      await t.settle();
      expect(smtp.messages.filter((m) => m.to.includes(customer.email!))).toHaveLength(1);
      expect(await t.sys.notificationDelivery.count({ where: { notificationId: n.id } })).toBe(2);
      expect(await t.sys.notificationDelivery.count({ where: { notificationId: n.id, status: 'SENT' } })).toBe(1);
      // Manual retry is refused for something that was sent.
      const refused = await t.as(alpha.owner).post(`/notifications/${n.id}/retry`).expect(409);
      expect(refused.body.code).toBe('NOT_RETRYABLE');
    });

    it('marks a notification FAILED after the last attempt, reports it, and a manual retry sends it once', async () => {
      const customer = await makeCustomer(t, alpha, { phone: null });
      const request = await makeRequest(t, alpha, customer.id);
      smtp.behaviour = [451, 451, 451, 451, 451];
      const eventId = await emit(t, alpha.id, 'request.completed', { requestId: request.id, customerId: customer.id });
      await t.settle(12);

      const failed = byChannel(await rowsFor(alpha.id, eventId), 'EMAIL')!;
      expect(failed.status).toBe('FAILED');
      expect(failed.notificationDeliveries).toHaveLength(5);
      expect(failed.notificationDeliveries.every((d) => d.status === 'FAILED')).toBe(true);
      expect(smtp.messages.filter((m) => m.to.includes(customer.email!))).toHaveLength(0);

      const report = await t.as(alpha.owner).get('/notifications/failures?channel=EMAIL').expect(200);
      const entry = report.body.data.find((r: any) => r.id === failed.id);
      expect(entry).toMatchObject({ status: 'FAILED', attempts: 5, provider: 'smtp', eventLabel: 'Application completed' });
      expect(entry.lastError).toContain('Try again later');
      expect(report.body.summary.byChannel).toEqual(expect.arrayContaining([expect.objectContaining({ channel: 'EMAIL' })]));
      expect(report.body.summary.total).toBeGreaterThanOrEqual(1);

      const retried = await t.as(alpha.owner).post(`/notifications/${failed.id}/retry`).expect(200);
      expect(retried.body.status).toBe('QUEUED');
      await t.settle();
      const detail = await t.as(alpha.owner).get(`/notifications/${failed.id}`).expect(200);
      expect(detail.body.status).toBe('SENT');
      expect(detail.body.deliveries).toHaveLength(6);
      expect(detail.body.deliveries.filter((d: any) => d.status === 'SENT')).toHaveLength(1);
      expect(detail.body.data).toBeUndefined();
      expect(smtp.messages.filter((m) => m.to.includes(customer.email!))).toHaveLength(1);
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'notification.retried', resourceId: failed.id } })).toBe(1);
      await t.as(receptionist).post(`/notifications/${failed.id}/retry`).expect(403);
    });

    it('fails at once on a permanent rejection (no pointless retries)', async () => {
      const customer = await makeCustomer(t, alpha, { phone: null });
      const request = await makeRequest(t, alpha, customer.id);
      smtp.behaviour = [550];
      const eventId = await emit(t, alpha.id, 'request.completed', { requestId: request.id, customerId: customer.id });
      await t.settle();
      const n = byChannel(await rowsFor(alpha.id, eventId), 'EMAIL')!;
      expect(n.status).toBe('FAILED');
      expect(n.notificationDeliveries).toHaveLength(1);
      expect(n.notificationDeliveries[0].error).toContain('Mailbox unavailable');
    });

    it('fails clearly when an integration is incomplete instead of pretending to send', async () => {
      const delta = await t.createTenant();
      await makeIntegration(t, delta.id, 'SMS', 'twilio', { accountSid: 'AC1' }, {});
      const customer = await makeCustomer(t, delta, { email: null });
      const request = await makeRequest(t, delta, customer.id);
      const eventId = await emit(t, delta.id, 'request.completed', { requestId: request.id, customerId: customer.id });
      await t.settle();
      const sms = byChannel(await rowsFor(delta.id, eventId), 'SMS')!;
      expect(sms.status).toBe('FAILED');
      expect(sms.notificationDeliveries).toHaveLength(1);
      expect(sms.notificationDeliveries[0]).toMatchObject({ provider: 'none', status: 'FAILED' });
      expect(sms.notificationDeliveries[0].error).toMatch(/integration is incomplete/);

      const channels = await t.as(delta.owner).get('/notifications/channels').expect(200);
      expect(channels.body.find((c: any) => c.channel === 'SMS')).toMatchObject({ configured: false, source: 'NONE', provider: null });
      expect(channels.body.find((c: any) => c.channel === 'EMAIL')).toMatchObject({ configured: true, source: 'PLATFORM', provider: 'log' });
      expect(channels.body.find((c: any) => c.channel === 'IN_APP')).toMatchObject({ configured: true, source: 'BUILT_IN' });
    });

    it('shows the active provider per channel without ever returning credentials', async () => {
      const channels = await t.as(alpha.owner).get('/notifications/channels').expect(200);
      expect(channels.body.find((c: any) => c.channel === 'EMAIL')).toEqual({ channel: 'EMAIL', provider: 'smtp', source: 'TENANT', configured: true, detail: null });
      const text = JSON.stringify(channels.body);
      expect(text).not.toContain('alpha-secret');
      expect(text).not.toContain('alpha-mailer');
      expect(text).not.toContain('secretsEnc');
    });

    it('re-queues a notification whose delivery job was lost', async () => {
      const customer = await makeCustomer(t, beta, { phone: null });
      const request = await makeRequest(t, beta, customer.id);
      const eventId = await emit(t, beta.id, 'request.completed', { requestId: request.id, customerId: customer.id });
      await t.get(DomainEvents).dispatch();
      t.jobs.clearInline(); // simulate: the job never reached the queue
      const stuck = byChannel(await rowsFor(beta.id, eventId), 'EMAIL')!;
      expect(stuck.status).toBe('QUEUED');
      await t.sys.notification.update({ where: { id: stuck.id }, data: { createdAt: new Date(Date.now() - 30 * 60_000) } });
      const result = await t.inTenant(beta.id, () => t.get(DeliveryService).maintain());
      expect(result.requeued).toBe(1);
      await t.settle();
      expect(byChannel(await rowsFor(beta.id, eventId), 'EMAIL')!.status).toBe('SENT');
    });
  });

  // ------------------------------------------------------------------ account-security messages
  describe('account-security messages (Messenger transport)', () => {
    it('sends verification emails through the same templates and providers without storing the link', async () => {
      const epsilon = await t.createTenant({ name: 'Epsilon Typing' });
      const email = `secure-${Date.now()}@example.test`;
      const reg = await t.http.post('/api/v1/auth/register').send({ tenantSlug: epsilon.slug, fullName: 'Amal Yusuf', email, password: 'Correct-Horse-42', acceptTerms: true }).expect(201);
      const token: string = reg.body.dev.emailVerificationToken;

      const queued = await t.sys.notification.findFirstOrThrow({ where: { tenantId: epsilon.id, eventKey: 'account.email_verification', recipientAddress: email } });
      expect(queued.status).toBe('QUEUED');
      expect(queued.body).not.toContain(token);
      expect(JSON.stringify(queued.data)).not.toContain(token);
      expect((queued.data as any).secure).toEqual(expect.any(String));
      expect(queued.dedupeKey).toBeNull();

      await t.settle();
      const sent = await t.sys.notification.findUniqueOrThrow({ where: { id: queued.id } });
      expect(sent.status).toBe('SENT');
      expect((sent.data as any).secure).toBeUndefined(); // wiped once delivered
      const mail = LogProvider.lastFor(email, 'EMAIL')!.message;
      expect(mail.subject).toBe('Confirm your email address');
      expect(mail.text).toContain('Hello Amal Yusuf');
      expect(mail.text).toContain(`token=${token}`);
      expect(mail.html).toContain('Epsilon Typing');
      expect(mail.html).toContain('>Confirm email address</a>');

      // Staff looking at the delivery log never see the link either.
      const log = await t.as(epsilon.owner).get(`/notifications?eventKey=account.email_verification&q=${encodeURIComponent(email)}`).expect(200);
      expect(log.body.data).toHaveLength(1);
      expect(JSON.stringify(log.body)).not.toContain(token);
      const detail = await t.as(epsilon.owner).get(`/notifications/${queued.id}`).expect(200);
      expect(JSON.stringify(detail.body)).not.toContain(token);
    });

    it('sends one-time codes by SMS even to someone who opted out of everything', async () => {
      const phone = '+971501112233';
      await t.messenger.send({ eventKey: 'account.otp', channel: 'SMS', to: phone, language: 'ar', tenantId: alpha.id, data: { code: '482913', minutes: 5 } });
      await t.settle();
      const n = await t.sys.notification.findFirstOrThrow({ where: { tenantId: alpha.id, eventKey: 'account.otp', recipientAddress: phone } });
      expect(n).toMatchObject({ status: 'SENT', channel: 'SMS', language: 'ar' });
      expect(n.body).not.toContain('482913');
      expect(n.body).toContain('[hidden]');
      expect(LogProvider.lastFor(phone, 'SMS')!.message.text).toContain('482913 هو رمز التحقق');
    });

    it('delivers platform-level messages (no tenant) with the platform defaults', async () => {
      const email = `platform-${Date.now()}@typease.test`;
      await t.messenger.send({ eventKey: 'account.password_reset', channel: 'EMAIL', to: email, language: 'en', tenantId: null, data: { name: 'Platform Admin', link: 'https://admin.typease.test/reset-password?token=abc123', minutes: 60 } });
      await t.settle();
      const mail = LogProvider.lastFor(email, 'EMAIL')!.message;
      expect(mail.subject).toBe('Reset your password');
      expect(mail.text).toContain('Choose a new password: https://admin.typease.test/reset-password?token=abc123');
      expect(mail.from).toEqual({ name: 'TypEase', address: 'no-reply@typease.localhost' });
      expect(await t.sys.notification.count({ where: { recipientAddress: email } })).toBe(0); // nothing tenant-scoped is stored
    });
  });

  // ------------------------------------------------------------------ inbox, devices, push
  describe('inbox, devices and push', () => {
    it('lets a member read and mark only their own notifications', async () => {
      const one = await t.addCustomer(alpha);
      const two = await t.addCustomer(alpha);
      const request = await makeRequest(t, alpha, one.customerId!);
      for (let i = 0; i < 3; i++) await emit(t, alpha.id, 'request.completed', { requestId: request.id, customerId: one.customerId });
      await t.settle();

      // Each of them also has the welcome message from registration.
      const inbox = await t.as(one).get('/me/notifications?pageSize=2').expect(200);
      expect(inbox.body.meta).toMatchObject({ total: 4, pageSize: 2, totalPages: 2 });
      expect(inbox.body.unreadCount).toBe(4);
      const others = await t.as(two).get('/me/notifications').expect(200);
      expect(others.body.data.map((n: any) => n.eventKey)).toEqual(['account.registered']);

      const id = inbox.body.data[0].id;
      await t.as(two).post(`/me/notifications/${id}/read`).expect(404);
      const read = await t.as(one).post(`/me/notifications/${id}/read`).expect(200);
      expect(read.body.readAt).toBeTruthy();
      expect((await t.as(one).get('/me/notifications?unreadOnly=true').expect(200)).body.meta.total).toBe(3);
      expect((await t.as(one).post('/me/notifications/read-all').expect(200)).body.updated).toBe(3);
      expect((await t.as(one).get('/me/notifications').expect(200)).body.unreadCount).toBe(0);
      await t.as(null).get('/me/notifications').expect(401);
    });

    it('registers a device, pushes to it and removes it on sign-out', async () => {
      const portal = await t.addCustomer(alpha);
      const request = await makeRequest(t, alpha, portal.customerId!);
      const token = `fcm-device-token-${Date.now()}-abcdefghijklmnop`;
      await t.as(portal).post('/me/devices', { token: 'short', platform: 'android' }).expect(400);
      const device = await t.as(portal).post('/me/devices', { token, platform: 'android' }).expect(201);
      expect(device.body.platform).toBe('android');
      await t.as(portal).post('/me/devices', { token, platform: 'android' }).expect(201); // idempotent
      expect((await t.as(portal).get('/me/devices').expect(200)).body).toHaveLength(1);
      expect(JSON.stringify((await t.as(portal).get('/me/devices')).body)).not.toContain(token);

      const eventId = await emit(t, alpha.id, 'request.completed', { requestId: request.id, customerId: portal.customerId });
      await t.settle();
      const push = byChannel(await rowsFor(alpha.id, eventId), 'PUSH')!;
      expect(push).toMatchObject({ status: 'SENT', recipientUserId: portal.userId });
      expect(push.notificationDeliveries[0]).toMatchObject({ provider: 'log', status: 'SENT' });
      const sent = LogProvider.lastFor(token, 'PUSH')!.message;
      expect(sent.subject).toBe(`Request ${request.requestNo} completed`);
      expect(sent.pushData).toEqual({ relatedType: 'ServiceRequest', relatedId: request.id, eventKey: 'request.completed', notificationId: push.id });
      // The same target the inbox gives for the notification, so the app opens the same screen from either place.
      const inbox = (await t.as(portal).get('/me/notifications').expect(200)).body.data.find((n: any) => n.relatedId === request.id);
      expect([inbox.relatedType, inbox.relatedId]).toEqual([sent.pushData!.relatedType, sent.pushData!.relatedId]);

      // A queued push whose stored rendering has no copy of the target (rows written by earlier versions) still carries it.
      const requeued = await emit(t, alpha.id, 'request.completed', { requestId: request.id, customerId: portal.customerId });
      await t.get(DomainEvents).dispatch();
      const queued = byChannel(await rowsFor(alpha.id, requeued), 'PUSH')!;
      expect(queued.status).toBe('QUEUED');
      await t.sys.notification.update({ where: { id: queued.id }, data: { data: { templateId: null } } });
      await t.settle();
      const entry = LogProvider.lastFor(token, 'PUSH')!.message;
      expect(entry.notificationId).toBe(queued.id);
      expect(entry.pushData).toEqual({ relatedType: 'ServiceRequest', relatedId: request.id, eventKey: 'request.completed', notificationId: queued.id });

      // A notification about nothing in particular has no target, and says so by leaving the fields out.
      const custom = await t.inTenant(alpha.id, () =>
        t.get(NotificationService).sendCustom({ recipient: { kind: 'CUSTOMER', customerId: portal.customerId! }, channels: ['PUSH'], subject: 'Eid opening hours', body: 'We are closed on Friday.', data: {}, dedupeId: `custom-${Date.now()}` }),
      );
      expect(custom).toEqual([expect.objectContaining({ channel: 'PUSH', status: 'QUEUED' })]);
      await t.settle();
      const plain = LogProvider.lastFor(token, 'PUSH')!.message;
      expect(plain.subject).toBe('Eid opening hours');
      expect(plain.pushData).toEqual({ eventKey: expect.any(String), notificationId: custom[0].id });

      // Another member cannot remove someone else's device.
      const other = await t.addCustomer(alpha);
      expect((await t.as(other).delete('/me/devices').send({ token }).expect(200)).body.removed).toBe(0);
      expect((await t.as(portal).delete('/me/devices').send({ token }).expect(200)).body.removed).toBe(1);
      const after = await emit(t, alpha.id, 'request.completed', { requestId: request.id, customerId: portal.customerId });
      await t.settle();
      expect(byChannel(await rowsFor(alpha.id, after), 'PUSH')).toBeUndefined();
    });

    it('forgets device tokens the push provider reports as unregistered', async () => {
      const portal = await t.addCustomer(alpha);
      const request = await makeRequest(t, alpha, portal.customerId!);
      const delivered: string[] = [];
      const registry = t.get(ProviderRegistry);
      registry.setOverride('PUSH', {
        name: 'fake-fcm',
        channel: 'PUSH',
        send: async (message) => {
          if (message.to.startsWith('dead-')) throw new ProviderError('fcm: the device token is no longer registered.', false, 'UNREGISTERED');
          delivered.push(message.to);
          return { providerMessageId: `fake-${delivered.length}` };
        },
      });
      try {
        const live = `live-device-token-${Date.now()}-abcdef`;
        const dead = `dead-device-token-${Date.now()}-abcdef`;
        await t.as(portal).post('/me/devices', { token: live, platform: 'ios' }).expect(201);
        await t.as(portal).post('/me/devices', { token: dead, platform: 'android' }).expect(201);
        const first = await emit(t, alpha.id, 'request.completed', { requestId: request.id, customerId: portal.customerId });
        await t.settle();
        const push = byChannel(await rowsFor(alpha.id, first), 'PUSH')!;
        expect(push.status).toBe('SENT'); // one device was enough
        expect(push.notificationDeliveries.map((d) => [d.provider, d.status])).toEqual([['fake-fcm', 'SENT']]);
        expect(delivered).toEqual([live]);
        expect((await t.sys.deviceToken.findMany({ where: { tenantId: alpha.id, userId: portal.userId } })).map((d) => d.token)).toEqual([live]);

        // When no device is left that accepts messages, the notification fails for good and says why.
        await t.sys.deviceToken.updateMany({ where: { tenantId: alpha.id, userId: portal.userId }, data: { token: dead } });
        const second = await emit(t, alpha.id, 'request.completed', { requestId: request.id, customerId: portal.customerId });
        await t.settle();
        const failed = byChannel(await rowsFor(alpha.id, second), 'PUSH')!;
        expect(failed.status).toBe('FAILED');
        expect(failed.notificationDeliveries).toHaveLength(1);
        expect(failed.notificationDeliveries[0].error).toMatch(/None of the registered devices/);
        expect(await t.sys.deviceToken.count({ where: { tenantId: alpha.id, userId: portal.userId } })).toBe(0);
      } finally {
        registry.setOverride('PUSH', null);
      }
    });
  });

  // ------------------------------------------------------------------ tenant isolation
  describe('tenant isolation', () => {
    it('never lets tenant B read tenant A notifications, templates or settings', async () => {
      const alphaRow = await t.sys.notification.findFirstOrThrow({ where: { tenantId: alpha.id, channel: 'EMAIL' } });
      await t.as(beta.owner).get(`/notifications/${alphaRow.id}`).expect(404);
      await t.as(beta.owner).post(`/notifications/${alphaRow.id}/retry`).expect(404);
      const list = await t.as(beta.owner).get('/notifications?pageSize=100').expect(200);
      const betaIds = new Set((await t.sys.notification.findMany({ where: { tenantId: beta.id }, select: { id: true } })).map((r) => r.id));
      expect(list.body.data.length).toBeGreaterThan(0);
      expect(list.body.data.every((r: any) => betaIds.has(r.id))).toBe(true);

      await t.as(alpha.owner).put('/notifications/templates/payment.received/EMAIL/en', { subject: 'ALPHA-ONLY receipt', body: 'ALPHA-ONLY body {{amount}}' }).expect(200);
      const betaTemplates = await t.as(beta.owner).get('/notifications/templates').expect(200);
      expect(JSON.stringify(betaTemplates.body)).not.toContain('ALPHA-ONLY');

      // Row-level security holds even for unfiltered queries on the tenant connection.
      const seen = await t.inTenant(beta.id, () => t.db.tx((tx) => tx.notification.findMany({ select: { tenantId: true } })));
      expect(seen.every((r) => r.tenantId === beta.id)).toBe(true);
      const templates = await t.inTenant(beta.id, () => t.db.tx((tx) => tx.notificationTemplate.findMany({ select: { tenantId: true } })));
      expect(templates.every((r) => r.tenantId === null || r.tenantId === beta.id)).toBe(true);
      expect(templates.some((r) => r.tenantId === null)).toBe(true);
      const deliveries = await t.inTenant(beta.id, () => t.db.tx((tx) => tx.notificationDelivery.findMany({ select: { tenantId: true } })));
      expect(deliveries.every((r) => r.tenantId === beta.id)).toBe(true);
      // A tenant cannot edit a platform default through its own connection.
      const def = await t.sys.notificationTemplate.findFirstOrThrow({ where: { tenantId: null } });
      const changed = await t.inTenant(beta.id, () => t.db.tx((tx) => tx.notificationTemplate.updateMany({ where: { id: def.id }, data: { body: 'hijacked' } })));
      expect(changed.count).toBe(0);
      await t.as(alpha.owner).delete('/notifications/templates/payment.received/EMAIL/en').expect(200);
    });

    it('filters the delivery log', async () => {
      const customer = await makeCustomer(t, beta, { phone: null });
      const request = await makeRequest(t, beta, customer.id);
      await emit(t, beta.id, 'request.created', { requestId: request.id, customerId: customer.id, serviceId: request.serviceId, branchId: beta.headOfficeId, source: 'WALK_IN' });
      await t.settle();
      const byCustomer = await t.as(beta.owner).get(`/notifications?customerId=${customer.id}`).expect(200);
      expect(byCustomer.body.data).toHaveLength(1);
      expect(byCustomer.body.data[0]).toMatchObject({ eventKey: 'request.created', eventLabel: 'New request', channel: 'EMAIL', status: 'SENT', attempts: 1, provider: 'log' });
      const today = new Date().toISOString().slice(0, 10);
      expect((await t.as(beta.owner).get(`/notifications?customerId=${customer.id}&status=FAILED`).expect(200)).body.data).toHaveLength(0);
      expect((await t.as(beta.owner).get(`/notifications?customerId=${customer.id}&channel=EMAIL&eventKey=request.created&from=${today}&to=${today}`).expect(200)).body.data).toHaveLength(1);
      expect((await t.as(beta.owner).get(`/notifications?customerId=${customer.id}&to=2020-01-01`).expect(200)).body.data).toHaveLength(0);
      await t.as(beta.owner).get('/notifications?status=WRONG').expect(400);
    });
  });
});
