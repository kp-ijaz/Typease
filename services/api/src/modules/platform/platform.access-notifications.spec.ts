import { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { env } from '../../config/env';
import { DomainEvents } from '../../common/events.service';
import { defaultTemplateRows, SUPERSEDED_DEFAULTS } from '../notifications/catalogue';
import { supportAccessKind } from '../notifications/event-mapper.service';
import { LogProvider } from '../notifications/providers/log';
import { ProvisioningService } from '../tenancy/provisioning.service';
import { requestAccess } from './fixtures';

/**
 * Support access and the people who have to know about it: the centre's
 * deciders hear about a request (in the application and by email), and the
 * TypEase staff member who asked hears about the decision.
 */
describe('Platform: support access notifications', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let admin: Actor;
  let agent: Actor;
  let officer: Actor; // custom role holding support_access.decide
  let manager: Actor; // may not decide

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    admin = await t.createPlatformAdmin('SUPER_ADMIN');
    agent = await t.createPlatformAdmin('SUPPORT_AGENT');
    await t.as(alpha.owner).post('/roles', { key: 'security_officer', name: 'Security officer', permissions: ['support_access.decide', 'audit.read'] }).expect(201);
    officer = await t.addStaff(alpha, 'security_officer');
    manager = await t.addStaff(alpha, 'manager');
    await t.settle();
  });
  afterAll(() => t.close());

  const notificationsOf = (tenantId: string, grantId: string) =>
    t.sys.notification.findMany({ where: { tenantId, eventKey: 'support_access.requested', relatedId: grantId }, orderBy: [{ recipientUserId: 'asc' }, { channel: 'asc' }], include: { notificationDeliveries: true } });
  const withdraw = (grantId: string, by: Actor = agent) => t.as(by).post(`/platform/access-grants/${grantId}/revoke`).expect(200);
  const decidedMessages = (email: string) => t.messenger.captured.filter((m) => m.to === email && m.eventKey === 'support_access.decided');
  const approvalLink = `${env().CENTRE_WEB_URL}/settings?tab=support`;

  describe('a request reaches the people who may decide', () => {
    it('owners and other deciders are told in the application and by email, with a link to the approval screen', async () => {
      const grant = await requestAccess(t, agent, alpha, ['customer.read', 'invoice.read'], { reason: 'A customer reports that an invoice PDF cannot be opened', durationMinutes: 45 });
      // Written with the request, in one transaction.
      const event = await t.sys.outboxEvent.findFirstOrThrow({ where: { tenantId: alpha.id, type: 'support_access.requested' }, orderBy: { createdAt: 'desc' } });
      expect(event.payload).toMatchObject({ grantId: grant.id, requestedById: agent.userId, requesterName: 'Platform SUPPORT_AGENT', durationMinutes: 45, scopes: ['customer.read', 'invoice.read'] });
      await t.settle();

      const rows = await notificationsOf(alpha.id, grant.id);
      expect(rows.map((r) => [r.recipientUserId, r.channel, r.status, r.relatedType]).sort()).toEqual(
        [
          [alpha.owner.userId, 'EMAIL', 'SENT', 'AccessGrant'],
          [alpha.owner.userId, 'IN_APP', 'SENT', 'AccessGrant'],
          [officer.userId, 'EMAIL', 'SENT', 'AccessGrant'],
          [officer.userId, 'IN_APP', 'SENT', 'AccessGrant'],
        ]
          // Email rows carry the address, not the user id.
          .map((r) => (r[1] === 'EMAIL' ? [null, r[1], r[2], r[3]] : r))
          .sort(),
      );
      expect(rows.filter((r) => r.channel === 'EMAIL').map((r) => r.recipientAddress).sort()).toEqual([alpha.owner.email, officer.email].sort());
      expect(rows.every((r) => r.suppressedReason === null)).toBe(true);

      // The email: who asks, for how long, why, and where to decide. Nothing else.
      const email = LogProvider.lastFor(alpha.owner.email, 'EMAIL')!.message;
      expect(email.subject).toBe('TypEase support is asking for access to Alpha Typing');
      expect(email.text).toContain('Platform SUPPORT_AGENT from TypEase support has asked for access to Alpha Typing for 45 minutes.');
      // Only read permissions were asked for: that, and only that, is called read-only.
      expect(email.text).toContain('What they ask for: read-only access.');
      expect(email.text).toContain('Reason given: A customer reports that an invoice PDF cannot be opened');
      expect(email.text).toContain(`Review the request: ${approvalLink}`);
      expect(email.html).toContain(approvalLink);
      expect(`${email.text} ${email.html}`).not.toMatch(/token|password/i);

      // The in-app inbox of a decider, with the target the application opens.
      const inbox = (await t.as(officer).get('/me/notifications').expect(200)).body;
      const item = inbox.data.find((n: any) => n.relatedId === grant.id);
      expect(item).toMatchObject({ eventKey: 'support_access.requested', relatedType: 'AccessGrant', relatedId: grant.id, subject: 'Support access requested', body: 'Platform SUPPORT_AGENT from TypEase support asks for 45 minutes of access: read-only access. Your decision is needed.', readAt: null });
      // The decider can act on exactly that request.
      expect((await t.as(officer).get(`/support-access/${grant.id}`).expect(200)).body).toMatchObject({ id: grant.id, status: 'REQUESTED' });

      // Not told: staff who may not decide, the requester, any other centre.
      expect((await t.as(manager).get('/me/notifications').expect(200)).body.data.filter((n: any) => n.eventKey === 'support_access.requested')).toEqual([]);
      expect(LogProvider.lastFor(manager.email, 'EMAIL')?.message.subject ?? '').not.toMatch(/asking for access/);
      expect(await t.sys.notification.count({ where: { eventKey: 'support_access.requested', OR: [{ recipientUserId: agent.userId }, { recipientAddress: agent.email }] } })).toBe(0);
      expect(await t.sys.notification.count({ where: { tenantId: beta.id, eventKey: 'support_access.requested' } })).toBe(0);
      expect((await t.as(beta.owner).get('/me/notifications').expect(200)).body.data).toEqual([]);

      // Delivered again (at-least-once): no second message for anybody.
      await t.sys.outboxEvent.update({ where: { id: event.id }, data: { status: 'PENDING' } });
      await t.settle();
      expect(await notificationsOf(alpha.id, grant.id)).toHaveLength(4);
      await withdraw(grant.id);
    });

    it('is written in the language of the recipient and cannot be switched off by a personal preference', async () => {
      await t.sys.user.update({ where: { id: officer.userId }, data: { preferredLanguage: 'ar' } });
      // The officer opted out of email for everything; a request for access to the centre still arrives.
      await t.sys.notificationPreference.create({ data: { tenantId: alpha.id, userId: officer.userId, channel: 'EMAIL', eventGroup: '*', enabled: false } });
      const grant = await requestAccess(t, agent, alpha, ['customer.read'], { reason: 'Checking a report that will not load' });
      await t.settle();
      const rows = (await notificationsOf(alpha.id, grant.id)).filter((r) => r.recipientUserId === officer.userId || r.recipientAddress === officer.email);
      expect(rows.map((r) => [r.channel, r.language, r.status]).sort()).toEqual([['EMAIL', 'ar', 'SENT'], ['IN_APP', 'ar', 'SENT']]);
      const email = LogProvider.lastFor(officer.email, 'EMAIL')!.message;
      expect(email.subject).toBe('فريق دعم TypEase يطلب الوصول إلى Alpha Typing');
      expect(email.text).toContain('ما يطلبه: وصول للقراءة فقط.');
      expect(email.text).toContain('السبب المذكور: Checking a report that will not load');
      expect(email.text).toContain(approvalLink);
      expect(LogProvider.lastFor(alpha.owner.email, 'EMAIL')!.message.subject).toBe('TypEase support is asking for access to Alpha Typing');
      await t.sys.user.update({ where: { id: officer.userId }, data: { preferredLanguage: 'en' } });
      await withdraw(grant.id);
    });

    it('says what is asked for: a request that includes writing internal notes is never called read-only', async () => {
      expect(supportAccessKind(['customer.read', 'request.read.all'], 'en')).toBe('read-only access');
      expect(supportAccessKind(['request.read.all', 'request.comment.internal'], 'en')).toBe('read access, plus writing internal notes on requests (nothing else can be changed)');
      expect(supportAccessKind(['request.read.all', 'request.comment.internal'], 'ar')).toBe('وصول للقراءة، مع كتابة ملاحظات داخلية على الطلبات (لا يمكن تغيير أي شيء آخر)');
      expect(supportAccessKind([], 'ar')).toBe('وصول للقراءة فقط');

      await t.sys.user.update({ where: { id: officer.userId }, data: { preferredLanguage: 'ar' } });
      const grant = await requestAccess(t, agent, alpha, ['request.read.all', 'request.comment.internal'], { reason: 'Leaving a note for the case handler', durationMinutes: 30 });
      await t.settle();
      const rows = await notificationsOf(alpha.id, grant.id);
      // Every message about this request points at the grant: that is what the application opens.
      expect(rows).toHaveLength(4);
      expect(rows.every((r) => r.relatedType === 'AccessGrant' && r.relatedId === grant.id)).toBe(true);
      for (const r of rows) expect(`${r.subject} ${r.body}`).not.toMatch(/read-only|للقراءة فقط/);

      const english = LogProvider.lastFor(alpha.owner.email, 'EMAIL')!.message;
      expect(english.text).toContain('has asked for access to Alpha Typing for 30 minutes.');
      expect(english.text).toContain('What they ask for: read access, plus writing internal notes on requests (nothing else can be changed).');
      expect(`${english.text} ${english.html}`).not.toMatch(/read-only/);
      const arabic = LogProvider.lastFor(officer.email, 'EMAIL')!.message;
      expect(arabic.text).toContain('ما يطلبه: وصول للقراءة، مع كتابة ملاحظات داخلية على الطلبات (لا يمكن تغيير أي شيء آخر).');
      expect(arabic.text).not.toContain('للقراءة فقط');
      const ownerItem = (await t.as(alpha.owner).get('/me/notifications').expect(200)).body.data.find((n: any) => n.relatedId === grant.id);
      expect(ownerItem).toMatchObject({ relatedType: 'AccessGrant', relatedId: grant.id, body: 'Platform SUPPORT_AGENT from TypEase support asks for 30 minutes of access: read access, plus writing internal notes on requests (nothing else can be changed). Your decision is needed.' });
      const officerItem = (await t.as(officer).get('/me/notifications').expect(200)).body.data.find((n: any) => n.relatedId === grant.id);
      expect(officerItem.body).toBe('يطلب Platform SUPPORT_AGENT من فريق دعم TypEase الوصول لمدة 30 دقيقة: وصول للقراءة، مع كتابة ملاحظات داخلية على الطلبات (لا يمكن تغيير أي شيء آخر). بانتظار قرارك.');
      // What the decider opens with that id says the same, permission by permission.
      const detail = (await t.as(alpha.owner).get(`/support-access/${grant.id}`).expect(200)).body;
      expect(detail.scopes.find((s: any) => s.key === 'request.comment.internal')).toMatchObject({ write: true });
      await t.sys.user.update({ where: { id: officer.userId }, data: { preferredLanguage: 'en' } });
      await withdraw(grant.id);
    });

    it('a stored default that still has the old "read-only" wording is corrected; an edited one is left alone', async () => {
      const where = { tenantId: null, eventKey: 'support_access.requested' };
      const old = SUPERSEDED_DEFAULTS.find((d) => d.channel === 'IN_APP' && d.language === 'en')!;
      const edited = 'Our own wording: {{requesterName}} asks for {{durationMinutes}} minutes of read-only access.';
      await t.sys.notificationTemplate.updateMany({ where: { ...where, channel: 'IN_APP', language: 'en' }, data: { body: old.body } });
      await t.sys.notificationTemplate.updateMany({ where: { ...where, channel: 'IN_APP', language: 'ar' }, data: { body: edited } });
      const before = await t.sys.notificationTemplate.count({ where: { tenantId: null } });
      await t.get(ProvisioningService).bootstrapPlatform();
      expect(await t.sys.notificationTemplate.count({ where: { tenantId: null } })).toBe(before);
      const rows = await t.sys.notificationTemplate.findMany({ where: { ...where, channel: 'IN_APP' } });
      expect(rows.find((r) => r.language === 'en')!.body).toBe('{{requesterName}} from TypEase support asks for {{durationMinutes}} minutes of access: {{accessKind}}. Your decision is needed.');
      expect(rows.find((r) => r.language === 'ar')!.body).toBe(edited);
      // Put the built-in Arabic wording back for the tests that follow.
      const builtIn = defaultTemplateRows().find((r) => r.eventKey === 'support_access.requested' && r.channel === 'IN_APP' && r.language === 'ar')!;
      await t.sys.notificationTemplate.updateMany({ where: { ...where, channel: 'IN_APP', language: 'ar' }, data: { body: builtIn.body } });
    });

    it('a request that was withdrawn before the message went out is not announced', async () => {
      const grant = await requestAccess(t, agent, alpha, ['customer.read']);
      await withdraw(grant.id);
      await t.settle();
      expect(await notificationsOf(alpha.id, grant.id)).toEqual([]);
    });

    it('a refused request creates neither a grant nor an event', async () => {
      const before = await t.sys.outboxEvent.count({ where: { type: 'support_access.requested' } });
      await t.as(agent).post(`/platform/tenants/${alpha.id}/access-grants`, { reason: 'Trying to get write access', scopes: ['invoice.manage'], durationMinutes: 30 }).expect(422);
      await t.as(alpha.owner).post(`/platform/tenants/${alpha.id}/access-grants`, { reason: 'A centre cannot ask for itself', scopes: ['customer.read'] }).expect(403);
      expect(await t.sys.outboxEvent.count({ where: { type: 'support_access.requested' } })).toBe(before);
    });
  });

  describe('the decision reaches the person who asked', () => {
    const consoleLink = `${env().PLATFORM_ADMIN_URL}/access-requests`;

    it('approved: valid until when, with the note of the centre', async () => {
      const grant = await requestAccess(t, agent, alpha, ['customer.read'], { durationMinutes: 20 });
      const sent = decidedMessages(agent.email).length;
      const approved = (await t.as(alpha.owner).post(`/support-access/${grant.id}/approve`, { note: 'Please only look at the invoices of October.' }).expect(200)).body;
      const event = await t.sys.outboxEvent.findFirstOrThrow({ where: { tenantId: alpha.id, type: 'support_access.decided' }, orderBy: { createdAt: 'desc' } });
      expect(event.payload).toMatchObject({ grantId: grant.id, status: 'APPROVED', previousStatus: 'REQUESTED', by: 'CENTRE', _actor: { userId: alpha.owner.userId, type: 'STAFF' } });
      await t.settle();

      expect(decidedMessages(agent.email)).toHaveLength(sent + 1);
      const until = approved.expiresAt.slice(0, 16).replace('T', ' ');
      expect(t.messenger.lastFor(agent.email, 'support_access.decided')).toMatchObject({
        channel: 'EMAIL', language: 'en',
        data: { name: 'Platform SUPPORT_AGENT', tenantName: 'Alpha Typing', decision: 'approved', consoleLink, details: expect.stringContaining(`The access is valid until ${until} (UTC).`) },
      });
      expect(t.messenger.lastFor(agent.email, 'support_access.decided')!.tenantId ?? null).toBeNull();
      const email = LogProvider.lastFor(agent.email, 'EMAIL')!.message;
      expect(email.subject).toBe('Support access to Alpha Typing: approved');
      expect(email.text).toContain('Your request for support access to Alpha Typing was approved.');
      expect(email.text).toContain('Note from the centre: Please only look at the invoices of October.');
      expect(email.text).toContain(`Open your access requests: ${consoleLink}`);
      // A platform message: it is not a notification of the centre and does not use the centre's allowance.
      expect(await t.sys.notification.count({ where: { OR: [{ recipientUserId: agent.userId }, { recipientAddress: agent.email }] } })).toBe(0);
      const audit = await t.sys.auditLog.findMany({ where: { tenantId: null, action: 'support_access.requester_notified', resourceId: grant.id } });
      expect(audit).toHaveLength(1);
      expect(audit[0].after).toMatchObject({ eventId: event.id, status: 'APPROVED', by: 'CENTRE' });

      // The same event delivered again does not send a second email.
      await t.sys.outboxEvent.update({ where: { id: event.id }, data: { status: 'PENDING' } });
      await t.settle();
      expect(decidedMessages(agent.email)).toHaveLength(sent + 1);

      // The centre ends the access early: the requester hears about that too.
      await t.as(alpha.owner).post(`/support-access/${grant.id}/revoke`, { note: 'We are done, thank you.' }).expect(200);
      await t.settle();
      expect(decidedMessages(agent.email)).toHaveLength(sent + 2);
      expect(t.messenger.lastFor(agent.email, 'support_access.decided')!.data).toMatchObject({ decision: 'ended', details: expect.stringContaining('The centre ended the access.') });
      expect(String(t.messenger.lastFor(agent.email, 'support_access.decided')!.data.details)).toContain('Note from the centre: We are done, thank you.');
      expect(LogProvider.lastFor(agent.email, 'EMAIL')!.message.subject).toBe('Support access to Alpha Typing: ended');
    });

    it('denied, in the language of the requester', async () => {
      await t.sys.user.update({ where: { id: agent.userId }, data: { preferredLanguage: 'ar' } });
      const grant = await requestAccess(t, agent, alpha, ['customer.read']);
      await t.as(officer).post(`/support-access/${grant.id}/deny`, { note: 'Please call us first.' }).expect(200);
      await t.settle();
      const message = t.messenger.lastFor(agent.email, 'support_access.decided')!;
      expect(message).toMatchObject({ language: 'ar', data: { decision: 'تم رفضه', tenantName: 'Alpha Typing' } });
      expect(String(message.data.details)).toContain('ملاحظة من المركز: Please call us first.');
      const email = LogProvider.lastFor(agent.email, 'EMAIL')!.message;
      expect(email.subject).toBe('وصول الدعم إلى Alpha Typing: تم رفضه');
      expect(email.text).toContain(consoleLink);
      await t.sys.user.update({ where: { id: agent.userId }, data: { preferredLanguage: 'en' } });
    });

    it('a Super Admin ending somebody\'s access tells that person; withdrawing your own request tells nobody', async () => {
      const grant = await requestAccess(t, agent, alpha, ['customer.read']);
      await t.as(alpha.owner).post(`/support-access/${grant.id}/approve`, {}).expect(200);
      await t.settle();
      const sent = decidedMessages(agent.email).length;
      await withdraw(grant.id, admin);
      await t.settle();
      expect(decidedMessages(agent.email)).toHaveLength(sent + 1);
      expect(t.messenger.lastFor(agent.email, 'support_access.decided')!.data).toMatchObject({ decision: 'ended', details: 'A platform administrator ended the access. Sessions opened under it were closed.' });
      expect(decidedMessages(admin.email)).toEqual([]);

      const own = await requestAccess(t, agent, alpha, ['customer.read']);
      await t.settle();
      const before = decidedMessages(agent.email).length;
      await withdraw(own.id);
      await t.settle();
      expect(decidedMessages(agent.email)).toHaveLength(before);
      expect(await t.sys.outboxEvent.count({ where: { tenantId: alpha.id, type: 'support_access.decided', payload: { path: ['grantId'], equals: own.id } } })).toBe(0);
    });

    it('a requester whose account was disabled in the meantime is not written to', async () => {
      const leaving = await t.createPlatformAdmin('SUPPORT_AGENT');
      const grant = await requestAccess(t, leaving, beta, ['customer.read']);
      await t.sys.user.update({ where: { id: leaving.userId }, data: { status: 'DISABLED' } });
      await t.as(beta.owner).post(`/support-access/${grant.id}/deny`, {}).expect(200);
      await t.settle();
      expect(decidedMessages(leaving.email)).toEqual([]);
      // Everything was processed: nothing is stuck in the outbox.
      expect(await t.get(DomainEvents).dispatch()).toBe(0);
      expect(await t.sys.outboxEvent.count({ where: { type: { in: ['support_access.requested', 'support_access.decided'] }, status: { not: 'PROCESSED' } } })).toBe(0);
    });
  });
});
