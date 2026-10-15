import { TenantFixture, TestApp } from '../../../test/helpers';
import { makeCustomer, makeRequest, setConsent } from '../notifications/fixtures';
import { CUSTOM_EVENT, CUSTOM_MARKETING_EVENT, CustomNotifyInput, NotificationService } from '../notifications/notification.service';
import { LogProvider } from '../notifications/providers/log';

/**
 * `NotificationService.sendCustom` is the door through which automations send
 * messages written by a centre. These tests pin down that it is the SAME door
 * as for every other notification: consent, opt-outs, rate limit, plan limit,
 * delivery pipeline and delivery log all apply.
 */
describe('Custom (automation) notifications', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let n = 0;
  const send = (tenant: TenantFixture, input: Partial<CustomNotifyInput> & Pick<CustomNotifyInput, 'recipient' | 'channels'>) =>
    t.inTenant(tenant.id, () => t.get(NotificationService).sendCustom({ dedupeId: `test:${Date.now()}:${n++}`, body: 'Hello {{customerName}}', subject: 'Subject', data: {}, ...input }));
  const row = (id: string) => t.sys.notification.findUniqueOrThrow({ where: { id }, include: { notificationDeliveries: true } });

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    await t.settle();
  });
  afterAll(() => t.close());

  it('renders the text of the centre and delivers it through the normal pipeline', async () => {
    const customer = await makeCustomer(t, alpha, { fullName: 'Fatima <b>Al</b> Mansoori' });
    const request = await makeRequest(t, alpha, customer.id);
    const created = await send(alpha, {
      recipient: { kind: 'CUSTOMER', customerId: customer.id },
      channels: ['EMAIL', 'SMS'],
      subject: 'Update on {{requestNumber}}',
      body: 'Dear {{customerName}},\n\nyour request {{requestNumber}} moved on. {{unknownVariable}}\n\n[Open it]({{portalLink}})\n\n{{centreName}}',
      data: { customerName: customer.fullName, requestNumber: request.requestNo, portalLink: 'https://portal.example/requests/1', centreName: 'overridden by branding' },
      related: { type: 'ServiceRequest', id: request.id },
    });
    expect(created.map((c) => [c.channel, c.status])).toEqual([['EMAIL', 'QUEUED'], ['SMS', 'QUEUED']]);
    await t.settle();

    const email = await row(created[0].id);
    expect(email).toMatchObject({ eventKey: CUSTOM_EVENT, status: 'SENT', recipientCustomerId: customer.id, recipientAddress: customer.email, subject: `Update on ${request.requestNo}`, relatedType: 'ServiceRequest', relatedId: request.id });
    expect(email.body).toBe(`Dear Fatima <b>Al</b> Mansoori,\n\nyour request ${request.requestNo} moved on.\n\nOpen it: https://portal.example/requests/1\n\nAlpha Typing`);
    expect(email.notificationDeliveries).toHaveLength(1);
    expect(email.notificationDeliveries[0]).toMatchObject({ status: 'SENT', provider: 'log' });
    expect((email.data as any).templateSource).toBe('TENANT');
    const sent = LogProvider.lastFor(customer.email!, 'EMAIL')!.message;
    expect(sent.subject).toBe(`Update on ${request.requestNo}`);
    // Values are escaped in HTML: a name can never inject markup into an email.
    expect(sent.html).toContain('Fatima &lt;b&gt;Al&lt;/b&gt; Mansoori');
    expect(sent.html).not.toContain('<b>Al</b>');
    expect(sent.html).toContain('href="https://portal.example/requests/1"');
    expect(LogProvider.lastFor(customer.phone!, 'SMS')!.message.text).toContain(`your request ${request.requestNo} moved on.`);
    // Metered like any other external message.
    const usage = await t.sys.usageRecord.findFirstOrThrow({ where: { tenantId: alpha.id, metric: 'notifications' }, orderBy: { periodKey: 'desc' } });
    expect(Number(usage.quantity)).toBeGreaterThanOrEqual(2);
  });

  it('never turns text typed by a customer into a link', async () => {
    const customer = await makeCustomer(t, alpha, { fullName: '[Click here](https://evil.example/phish)' });
    const [email] = await send(alpha, { recipient: { kind: 'CUSTOMER', customerId: customer.id }, channels: ['EMAIL'], body: 'Dear {{customerName}}, thank you.', data: { customerName: customer.fullName } });
    await t.settle();
    const html = LogProvider.lastFor(customer.email!, 'EMAIL')!.message.html!;
    expect(html).not.toContain('href="https://evil.example/phish"');
    expect((await row(email.id)).body).toBe('Dear [Click here](https://evil.example/phish), thank you.');
  });

  it('is idempotent per dedupe id, recipient and channel', async () => {
    const customer = await makeCustomer(t, alpha);
    const input = { dedupeId: `automation:exec-1:0:${Date.now()}`, recipient: { kind: 'CUSTOMER' as const, customerId: customer.id }, channels: ['EMAIL' as const] };
    const first = await send(alpha, input);
    const second = await send(alpha, input);
    // A later attempt that adds a channel only creates what is missing.
    const third = await send(alpha, { ...input, channels: ['EMAIL', 'SMS'] });
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
    expect(third.map((c) => c.channel)).toEqual(['SMS']);
    await t.settle();
    expect(await t.sys.notification.count({ where: { tenantId: alpha.id, recipientCustomerId: customer.id } })).toBe(2);
    expect(LogProvider.outbox.filter((m) => m.message.to === customer.email)).toHaveLength(1);
  });

  it('respects opt-outs: profile switches and explicit preferences', async () => {
    const noSms = await makeCustomer(t, alpha, { communicationPrefs: { email: true, sms: false, whatsapp: false, push: true } });
    const created = await send(alpha, { recipient: { kind: 'CUSTOMER', customerId: noSms.id }, channels: ['EMAIL', 'SMS'] });
    expect(created).toEqual([expect.objectContaining({ channel: 'EMAIL', status: 'QUEUED' }), expect.objectContaining({ channel: 'SMS', status: 'SUPPRESSED', suppressedReason: 'OPT_OUT' })]);

    // A portal customer who switched off request emails: custom messages belong to the same group.
    const portal = await t.addCustomer(alpha);
    await t.as(portal).put('/me/notification-preferences', { preferences: [{ channel: 'EMAIL', eventGroup: 'requests', enabled: false }] }).expect(200);
    await t.settle();
    const before = LogProvider.outbox.length;
    const forPortal = await send(alpha, { recipient: { kind: 'CUSTOMER', customerId: portal.customerId! }, channels: ['EMAIL', 'IN_APP'] });
    await t.settle();
    expect(forPortal).toEqual([expect.objectContaining({ channel: 'EMAIL', status: 'SUPPRESSED', suppressedReason: 'OPT_OUT' }), expect.objectContaining({ channel: 'IN_APP', status: 'SENT' })]);
    expect(LogProvider.outbox.slice(before).some((m) => m.message.to === portal.email)).toBe(false);
    // Suppressed is recorded, never dropped, and never attempted.
    const suppressed = await row(forPortal[0].id);
    expect(suppressed.notificationDeliveries).toHaveLength(0);
    expect(suppressed.sentAt).toBeNull();
  });

  it('sends WhatsApp only with consent, the opt-in and an approved template name', async () => {
    const customer = await makeCustomer(t, alpha);
    const wa = async (templateName?: string) =>
      (await send(alpha, { recipient: { kind: 'CUSTOMER', customerId: customer.id }, channels: ['WHATSAPP'], body: 'Hello {{customerName}}, {{requestNumber}} is ready.', data: { customerName: 'Rana', requestNumber: 'TE-1' }, whatsappTemplateName: templateName }))[0];
    expect(await wa('ready_v1')).toMatchObject({ status: 'SUPPRESSED', suppressedReason: 'NO_CONSENT_WHATSAPP' });
    await setConsent(t, alpha.id, customer.id, 'WHATSAPP', 'GRANTED');
    expect(await wa('ready_v1')).toMatchObject({ status: 'SUPPRESSED', suppressedReason: 'OPT_OUT' });
    await t.sys.customer.update({ where: { id: customer.id }, data: { communicationPrefs: { email: true, sms: true, whatsapp: true, push: true } } });
    expect(await wa()).toMatchObject({ status: 'SUPPRESSED', suppressedReason: 'WHATSAPP_TEMPLATE_REQUIRED' });
    expect(await wa('ready_v1')).toMatchObject({ status: 'QUEUED' });
    await t.settle();
    expect(LogProvider.lastFor(customer.phone!, 'WHATSAPP')!.message.whatsapp).toEqual({ templateName: 'ready_v1', languageCode: 'en', parameters: ['Rana', 'TE-1'] });
  });

  it('treats a MARKETING message as marketing: consent and opt-in are mandatory', async () => {
    const customer = await makeCustomer(t, alpha);
    const promo = async () => send(alpha, { recipient: { kind: 'CUSTOMER', customerId: customer.id }, channels: ['EMAIL', 'SMS'], purpose: 'MARKETING', body: 'Offer for {{customerName}}' });
    expect(await promo()).toEqual([expect.objectContaining({ status: 'SUPPRESSED', suppressedReason: 'NO_CONSENT_MARKETING' }), expect.objectContaining({ status: 'SUPPRESSED', suppressedReason: 'NO_CONSENT_MARKETING' })]);
    await setConsent(t, alpha.id, customer.id, 'MARKETING', 'GRANTED');
    // The consent alone is not enough without the marketing opt-in on the profile.
    expect((await promo()).every((c) => c.suppressedReason === 'NO_CONSENT_MARKETING')).toBe(true);
    await t.sys.customer.update({ where: { id: customer.id }, data: { marketingOptIn: true } });
    const sent = await promo();
    expect(sent.map((c) => c.status)).toEqual(['QUEUED', 'QUEUED']);
    expect((await row(sent[0].id)).eventKey).toBe(CUSTOM_MARKETING_EVENT);
    // The same customer still gets service messages without any marketing consent.
    const other = await makeCustomer(t, alpha);
    expect((await send(alpha, { recipient: { kind: 'CUSTOMER', customerId: other.id }, channels: ['EMAIL'] }))[0].status).toBe('QUEUED');
    await t.settle();
  });

  it('does not message archived customers and records why', async () => {
    const customer = await makeCustomer(t, alpha);
    await t.sys.customer.update({ where: { id: customer.id }, data: { status: 'ARCHIVED' } });
    expect(await send(alpha, { recipient: { kind: 'CUSTOMER', customerId: customer.id }, channels: ['EMAIL'] })).toEqual([expect.objectContaining({ status: 'SUPPRESSED', suppressedReason: 'CUSTOMER_INACTIVE' })]);
    const noEmail = await makeCustomer(t, alpha, { email: null });
    expect(await send(alpha, { recipient: { kind: 'CUSTOMER', customerId: noEmail.id }, channels: ['EMAIL'] })).toEqual([expect.objectContaining({ status: 'SUPPRESSED', suppressedReason: 'NO_ADDRESS' })]);
  });

  it('applies the hourly rate limit per recipient and channel', async () => {
    const gamma = await t.createTenant();
    await t.as(gamma.owner).put('/notifications/settings', { rateLimitPerHour: 2 }).expect(200);
    const customer = await makeCustomer(t, gamma, { phone: null });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await send(gamma, { recipient: { kind: 'CUSTOMER', customerId: customer.id }, channels: ['EMAIL'] }))[0]);
    expect(statuses.map((s) => s.status)).toEqual(['QUEUED', 'QUEUED', 'SUPPRESSED']);
    expect(statuses[2].suppressedReason).toBe('RATE_LIMITED');
    await t.settle();
  });

  it('applies the monthly plan limit to external channels while in-app keeps working', async () => {
    const starter = await t.createTenant({ plan: 'starter' });
    const portal = await t.addCustomer(starter);
    await t.settle();
    const period = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`;
    await t.sys.usageRecord.updateMany({ where: { tenantId: starter.id, metric: 'notifications', periodKey: period }, data: { quantity: 499 } });
    const recipient = { kind: 'CUSTOMER' as const, customerId: portal.customerId! };
    expect((await send(starter, { recipient, channels: ['EMAIL'] }))[0].status).toBe('QUEUED');
    const over = await send(starter, { recipient, channels: ['EMAIL', 'IN_APP'] });
    expect(over).toEqual([expect.objectContaining({ channel: 'EMAIL', status: 'SUPPRESSED', suppressedReason: 'PLAN_LIMIT' }), expect.objectContaining({ channel: 'IN_APP', status: 'SENT' })]);
    const after = await t.sys.usageRecord.findFirstOrThrow({ where: { tenantId: starter.id, metric: 'notifications', periodKey: period } });
    expect(Number(after.quantity)).toBe(500);
    await t.settle();
  });

  it('reaches staff in the application and only active members of the centre', async () => {
    const manager = await t.addStaff(alpha, 'manager');
    await t.settle();
    const [inApp] = await send(alpha, { recipient: { kind: 'USER', userId: manager.userId }, channels: ['IN_APP'], subject: 'Overdue: {{requestNumber}}', body: 'Please look at {{requestNumber}}.', data: { requestNumber: 'TE-9' } });
    expect(inApp).toMatchObject({ channel: 'IN_APP', status: 'SENT' });
    const inbox = await t.as(manager).get('/me/notifications').expect(200);
    expect(inbox.body.data[0]).toMatchObject({ subject: 'Overdue: TE-9', body: 'Please look at TE-9.' });
    // Staff have no recorded WhatsApp consent: with or without a phone number nothing is sent.
    const whatsapp = () => send(alpha, { recipient: { kind: 'USER', userId: manager.userId }, channels: ['WHATSAPP'], whatsappTemplateName: 'x' });
    expect((await whatsapp())[0]).toMatchObject({ status: 'SUPPRESSED', suppressedReason: 'NO_ADDRESS' });
    await t.sys.user.update({ where: { id: manager.userId }, data: { phone: `+9715${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}` } });
    expect((await whatsapp())[0]).toMatchObject({ status: 'SUPPRESSED', suppressedReason: 'NO_CONSENT_WHATSAPP' });

    // A member of ANOTHER centre is not a recipient here, and neither is a customer record of another centre.
    expect(await send(beta, { recipient: { kind: 'USER', userId: manager.userId }, channels: ['IN_APP', 'EMAIL'] })).toEqual([]);
    const foreign = await makeCustomer(t, alpha);
    expect(await send(beta, { recipient: { kind: 'CUSTOMER', customerId: foreign.id }, channels: ['EMAIL'] })).toEqual([]);
    expect(await t.sys.notification.count({ where: { tenantId: beta.id, OR: [{ recipientUserId: manager.userId }, { recipientCustomerId: foreign.id }] } })).toBe(0);
  });

  it('refuses an empty message or a missing dedupe id, and ignores unknown channels', async () => {
    const customer = await makeCustomer(t, alpha);
    const recipient = { kind: 'CUSTOMER' as const, customerId: customer.id };
    await expect(send(alpha, { recipient, channels: ['EMAIL'], body: '   ' })).rejects.toThrow(/body is empty/);
    await expect(send(alpha, { recipient, channels: ['EMAIL'], dedupeId: '' })).rejects.toThrow(/dedupe id/);
    expect(await send(alpha, { recipient, channels: ['FAX' as any] })).toEqual([]);
    expect(await send(alpha, { recipient, channels: [] })).toEqual([]);
  });
});
