import { createHmac } from 'node:crypto';
import { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { encryptJson } from '../../common/crypto';
import { LogProvider } from '../notifications/providers/log';
import { ProviderRegistry } from '../notifications/providers/registry';
import { createService } from '../requests/fixtures';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('WhatsApp team inbox', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let receptionist: Actor;
  let accountant: Actor;
  let manager: Actor;
  let conversationId: string;

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    receptionist = await t.addStaff(alpha, 'receptionist');
    accountant = await t.addStaff(alpha, 'accountant');
    manager = await t.addStaff(alpha, 'manager');
  });
  afterAll(() => t.close());

  it('receives messages (sandbox), matches known customers and counts unread', async () => {
    await t.as(alpha.owner).post('/customers', { fullName: 'Fatima Al Mansoori', phone: '+971501112233' }).expect(201);
    await t.as(alpha.owner).post('/inbox/simulate', { phone: '+971501112233', name: 'Fatima', text: 'Hello, my visa expires next month. How much is the renewal?' }).expect(201);
    await t.as(alpha.owner).post('/inbox/simulate', { phone: '+971509998877', name: 'New Person', text: 'Hi' }).expect(201);
    const list = (await t.as(receptionist).get('/inbox/conversations').expect(200)).body;
    expect(list.unreadTotal).toBe(2);
    const fatima = list.data.find((c: { phone: string }) => c.phone === '+971501112233');
    conversationId = fatima.id;
    expect(fatima).toMatchObject({ contactName: 'Fatima', unreadCount: 1, status: 'OPEN', windowOpen: true, customer: { fullName: 'Fatima Al Mansoori' } });
    expect(list.data.find((c: { phone: string }) => c.phone === '+971509998877').customer).toBeNull();
    await t.as(accountant).get('/inbox/conversations').expect(403);
    expect((await t.as(beta.owner).get('/inbox/conversations').expect(200)).body.data).toHaveLength(0);
    await t.as(beta.owner).get(`/inbox/conversations/${conversationId}`).expect(404);
  });

  it('replies within the 24-hour window, with notes, assignment and status', async () => {
    const opened = (await t.as(receptionist).get(`/inbox/conversations/${conversationId}`).expect(200)).body;
    expect(opened.messages.map((m: { direction: string }) => m.direction)).toEqual(['IN']);
    expect((await t.as(receptionist).get('/inbox/conversations').expect(200)).body.data.find((c: { id: string }) => c.id === conversationId).unreadCount).toBe(0);
    const sent = await t.as(receptionist).post(`/inbox/conversations/${conversationId}/reply`, { text: 'Hello Fatima, the renewal is AED 980. Shall we prepare it?' }).expect(201);
    expect(sent.body).toMatchObject({ direction: 'OUT', status: 'SENT' });
    expect(LogProvider.lastFor('+971501112233', 'WHATSAPP')?.message).toMatchObject({ freeForm: true, text: 'Hello Fatima, the renewal is AED 980. Shall we prepare it?' });
    await t.as(receptionist).post(`/inbox/conversations/${conversationId}/notes`, { text: 'Prefers Arabic. Visa expires 12 Nov.' }).expect(201);
    // Replying assigns an unassigned conversation to whoever replied.
    expect((await t.as(manager).get(`/inbox/conversations/${conversationId}`).expect(200)).body.assignedToId).toBe(receptionist.membershipId);
    await t.as(manager).put(`/inbox/conversations/${conversationId}/assignee`, { membershipId: manager.membershipId }).expect(200);
    await t.as(manager).put(`/inbox/conversations/${conversationId}/status`, { status: 'CLOSED' }).expect(200);
    // The customer writes again: the conversation opens again.
    await t.as(alpha.owner).post('/inbox/simulate', { phone: '+971501112233', text: 'Yes please' }).expect(201);
    const again = (await t.as(manager).get(`/inbox/conversations/${conversationId}`).expect(200)).body;
    expect(again.status).toBe('OPEN');
    expect(again.messages.map((m: { direction: string }) => m.direction)).toEqual(['IN', 'OUT', 'NOTE', 'IN']);
    expect(LogProvider.outbox.filter((e) => e.message.text.includes('Prefers Arabic'))).toHaveLength(0);
  });

  it('refuses free-form replies after 24 hours', async () => {
    await t.sys.waConversation.update({ where: { id: conversationId }, data: { lastInboundAt: new Date(Date.now() - 25 * 3_600_000) } });
    const late = await t.as(receptionist).post(`/inbox/conversations/${conversationId}/reply`, { text: 'Are you there?' });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('WINDOW_CLOSED');
  });

  it('files a photo from somebody new in a new customer\'s vault', async () => {
    await t.as(alpha.owner).post('/inbox/simulate', { phone: '+971554443322', name: 'Omar Haddad', text: 'My passport', media: PNG, mediaName: 'passport.png' }).expect(201);
    const conv = await t.sys.waConversation.findFirstOrThrow({ where: { tenantId: alpha.id, phone: '+971554443322' }, include: { messages: true } });
    expect(conv.customerId).toBeTruthy();
    expect((await t.sys.customer.findUniqueOrThrow({ where: { id: conv.customerId! } })).fullName).toBe('Omar Haddad');
    const message = conv.messages[0]!;
    expect(message).toMatchObject({ kind: 'IMAGE', body: 'My passport', error: null });
    const doc = await t.sys.document.findUniqueOrThrow({ where: { id: message.documentId! } });
    expect(doc).toMatchObject({ customerId: conv.customerId, documentTypeKey: 'other' });
  });

  it('starts a draft request from a photo the customer sent (WhatsApp intake)', async () => {
    const service = await createService(t, alpha, { requirements: [{ documentTypeKey: 'passport', label: 'Passport copy' }] });
    const conv = await t.sys.waConversation.findFirstOrThrow({ where: { tenantId: alpha.id, phone: '+971554443322' }, include: { messages: true } });
    const photo = conv.messages.find((m) => m.documentId)!;
    await t.settle(); // the upload is scanned before it can be used
    await t.as(accountant).post(`/inbox/messages/${photo.id}/intake`, { serviceId: service.id, documentTypeKey: 'passport' }).expect(403);
    const text = conv.messages.find((m) => !m.documentId);
    if (text) await t.as(alpha.owner).post(`/inbox/messages/${text.id}/intake`, { serviceId: service.id, documentTypeKey: 'passport' }).expect(422);
    const res = await t.as(receptionist).post(`/inbox/messages/${photo.id}/intake`, { serviceId: service.id, documentTypeKey: 'passport', runOcr: true }).expect(201);
    expect(res.body).toMatchObject({ requestNo: expect.any(String), linked: true });
    // OCR is switched off in this environment: reported, not hidden.
    expect(res.body.warnings).toContain('INTEGRATION_NOT_CONFIGURED');
    const request = await t.sys.serviceRequest.findUniqueOrThrow({ where: { id: res.body.requestId }, include: { requestDocuments: true } });
    expect(request).toMatchObject({ customerId: conv.customerId, status: 'DRAFT' });
    expect(request.requestDocuments.find((d) => d.documentTypeKey === 'passport')?.documentId).toBe(photo.documentId);
    expect((await t.sys.document.findUniqueOrThrow({ where: { id: photo.documentId! } })).documentTypeKey).toBe('passport');
    const notes = await t.sys.waMessage.findMany({ where: { conversationId: conv.id, direction: 'NOTE' } });
    expect(notes.some((n) => n.body?.includes(res.body.requestNo))).toBe(true);
  });

  describe('Meta webhook', () => {
    let integrationId: string;
    const sign = (body: string, secret = 'app-secret') => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    const payload = (messageId: string, extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ value: { metadata: { phone_number_id: '1234567890' }, contacts: [{ wa_id: '971527776655', profile: { name: 'Huda' } }], messages: [{ id: messageId, from: '971527776655', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Salam, I need an Emirates ID' } }], ...extra } }] }],
      });
    const post = (body: string, signature?: string) => {
      const r = t.http.post(`/api/v1/public/webhooks/whatsapp/${integrationId}`).set('content-type', 'application/json');
      return (signature ? r.set('x-hub-signature-256', signature) : r).send(body);
    };

    beforeAll(async () => {
      integrationId = (
        await t.sys.integration.create({
          data: { tenantId: alpha.id, category: 'WHATSAPP', provider: 'meta', name: 'WhatsApp', status: 'ACTIVE', mode: 'LIVE', config: { phoneNumberId: '1234567890', verifyToken: 'verify-me' }, secretsEnc: encryptJson({ accessToken: 'token', appSecret: 'app-secret' }) },
        })
      ).id;
    });

    it('answers the subscription handshake only with the right token', async () => {
      const ok = await t.http.get(`/api/v1/public/webhooks/whatsapp/${integrationId}`).query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '424242' }).expect(200);
      expect(ok.text).toBe('424242');
      await t.http.get(`/api/v1/public/webhooks/whatsapp/${integrationId}`).query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' }).expect(403);
    });

    it('accepts signed deliveries once, and tracks delivery of replies', async () => {
      const body = payload('wamid.A1');
      await post(body).expect(401);
      await post(body, sign(body, 'not-the-secret')).expect(401);
      expect((await post(body, sign(body)).expect(200)).body).toEqual({ received: 1, statuses: 0 });
      await post(body, sign(body)).expect(200); // Meta retries: stored once
      const conv = await t.sys.waConversation.findFirstOrThrow({ where: { tenantId: alpha.id, phone: '+971527776655' }, include: { messages: true } });
      expect(conv).toMatchObject({ contactName: 'Huda', unreadCount: 1 });
      expect(conv.messages).toHaveLength(1);
      expect(await t.sys.waConversation.count({ where: { tenantId: beta.id } })).toBe(0);

      // Graph API stand-in: the centre's Meta number is not called from tests.
      t.get(ProviderRegistry).setOverride('WHATSAPP', new LogProvider('WHATSAPP'));
      const reply = (await t.as(receptionist).post(`/inbox/conversations/${conv.id}/reply`, { text: 'Welcome Huda' }).expect(201)).body;
      t.get(ProviderRegistry).setOverride('WHATSAPP', null);
      const statusBody = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: '1234567890' }, statuses: [{ id: reply.providerMessageId, status: 'read' }] } }] }] });
      expect((await post(statusBody, sign(statusBody)).expect(200)).body).toEqual({ received: 0, statuses: 1 });
      expect((await t.sys.waMessage.findUniqueOrThrow({ where: { id: reply.id } })).status).toBe('READ');
    });
  });
});
