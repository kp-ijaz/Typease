import { Actor, TenantFixture, TestApp, uniq } from '../../../test/helpers';
import { decryptJson } from '../../common/crypto';
import { env } from '../../config/env';
import { categoryId, serviceBody } from '../catalogue/fixtures';
import { createCustomer, issueInvoice } from '../finance/fixtures';
import { ConnectionTester } from './connection-tester';
import { allowDevHost, createIntegration, FakeApi, FakeClamd, governmentRecord, LocalSmtp, partnerRecord } from './fixtures';
import { AUTHORISATION_EXPIRY_JOB } from './integrations.module';

const SMTP_PASSWORD = 'smtp-Pa55word-do-not-leak';
const STRIPE_KEY = 'sk_test_51NoLeakStripeSecretKeyValue';
const STRIPE_WHSEC = 'whsec_NoLeakWebhookSecretValue';
const TWILIO_TOKEN = 'twilio-auth-token-no-leak-0001';
const ALL_SECRETS = [SMTP_PASSWORD, STRIPE_KEY, STRIPE_WHSEC, TWILIO_TOKEN];

describe('Integrations', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let admin: Actor;
  let agent: Actor;
  let smtp: LocalSmtp;
  /** Every response body seen in this file, to prove that no credential ever leaves the API. */
  const seen: string[] = [];
  const keep = <T extends { text?: string; body?: unknown }>(res: T): T => {
    seen.push(res.text ?? JSON.stringify(res.body ?? null));
    return res;
  };
  const restore: Array<() => void> = [];

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    admin = await t.createPlatformAdmin('SUPER_ADMIN');
    agent = await t.createPlatformAdmin('SUPPORT_AGENT');
    smtp = await new LocalSmtp({ user: 'mailer@alpha.example', password: SMTP_PASSWORD }).start();
  });
  afterAll(async () => {
    restore.forEach((fn) => fn());
    await t.sys.platformSetting.deleteMany({ where: { key: 'integrations.approvedProviders' } });
    await smtp.stop();
    await t.close();
  });

  // ------------------------------------------------------------------ catalogue
  describe('catalogue', () => {
    it('lists every category with its providers, settings and credential fields', async () => {
      const res = keep(await t.as(alpha.owner).get('/integrations/catalogue').expect(200));
      const byCategory = new Map<string, any>(res.body.map((c: any) => [c.category, c]));
      expect([...byCategory.keys()]).toEqual(['PAYMENT', 'EMAIL', 'SMS', 'WHATSAPP', 'PUSH', 'OCR', 'MALWARE_SCAN', 'AUTOMATION', 'PARTNER', 'GOVERNMENT']);
      const codes = (c: string) => byCategory.get(c).providers.map((p: any) => p.provider);
      expect(codes('PAYMENT')).toEqual(['sandbox', 'stripe']);
      expect(codes('SMS')).toEqual(['twilio', 'http']);
      expect(codes('GOVERNMENT')).toEqual(['official-portal-access']);
      const smtpDef = byCategory.get('EMAIL').providers[0];
      expect(smtpDef.configFields.map((f: any) => f.key)).toEqual(['host', 'port', 'secure', 'requireTls', 'fromAddress', 'fromName']);
      expect(smtpDef.secretFields.map((f: any) => f.key)).toEqual(['user', 'password']);
      expect(smtpDef).toMatchObject({ kind: 'CONNECTION', testable: true, approved: true, configured: [] });
      // A government entry is a record of an authorisation: no credentials can be stored for it.
      const gov = byCategory.get('GOVERNMENT').providers[0];
      expect(gov).toMatchObject({ kind: 'AUTHORISATION_RECORD', requiresVerification: true, testable: false, multiple: true, secretFields: [] });
      expect(gov.description).toMatch(/never stores portal user names or passwords/i);
    });
  });

  // ------------------------------------------------------------------ access
  describe('access', () => {
    it('is limited to roles with integration.manage; customers and platform staff never reach it', async () => {
      const manager = await t.addStaff(alpha, 'manager');
      const receptionist = await t.addStaff(alpha, 'receptionist');
      const customer = await t.addCustomer(alpha);
      const row = await createIntegration(t, alpha.owner, { category: 'EMAIL', provider: 'smtp', config: { host: 'smtp.access-test.example' } });
      for (const actor of [manager, receptionist, customer, admin]) {
        await t.as(actor).get('/integrations').expect(403);
        await t.as(actor).get('/integrations/catalogue').expect(403);
        await t.as(actor).get('/integrations/logs').expect(403);
        await t.as(actor).get(`/integrations/${row.id}`).expect(403);
        await t.as(actor).post('/integrations', { category: 'SMS', provider: 'twilio', config: { accountSid: 'ACx', from: '+15005550006' } }).expect(403);
        await t.as(actor).patch(`/integrations/${row.id}`, { name: 'Hijack' }).expect(403);
        await t.as(actor).put(`/integrations/${row.id}/secrets`, { secrets: { password: 'x' } }).expect(403);
        await t.as(actor).post(`/integrations/${row.id}/enable`).expect(403);
        await t.as(actor).post(`/integrations/${row.id}/test`).expect(403);
        await t.as(actor).delete(`/integrations/${row.id}`).expect(403);
      }
      await t.as(null).get('/integrations').expect(401);
      // Tenant users never reach the platform side; a support agent may not manage integrations.
      for (const actor of [alpha.owner, manager, agent]) {
        await t.as(actor).get('/platform/integrations/authorisations').expect(403);
        await t.as(actor).get('/platform/integrations/approved-providers').expect(403);
        await t.as(actor).put('/platform/integrations/approved-providers', { providers: null }).expect(403);
      }
      await t.as(alpha.owner).delete(`/integrations/${row.id}`).expect(200);
    });
  });

  // ------------------------------------------------------------------ SMTP: config, secrets, test
  describe('a connection (SMTP)', () => {
    let id: string;

    it('refuses unknown providers, unknown settings and internal addresses', async () => {
      expect((await t.as(alpha.owner).post('/integrations', { category: 'EMAIL', provider: 'twilio', config: {} }).expect(422)).body.code).toBe('UNKNOWN_PROVIDER');
      const unknownField = await t.as(alpha.owner).post('/integrations', { category: 'EMAIL', provider: 'smtp', config: { host: 'smtp.example.ae', password: 'in-the-wrong-place' } }).expect(422);
      expect(unknownField.body).toMatchObject({ code: 'INVALID_INTEGRATION_CONFIG', details: { field: 'password' } });
      expect((await t.as(alpha.owner).post('/integrations', { category: 'EMAIL', provider: 'smtp', config: {} }).expect(422)).body.message).toMatch(/Server/);
      expect((await t.as(alpha.owner).post('/integrations', { category: 'EMAIL', provider: 'smtp', config: { host: 'smtp.example.ae', port: 70000 } }).expect(422)).body.details.field).toBe('port');
      // A literal private address is refused when it is saved ...
      for (const host of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '192.168.1.10']) {
        const res = await t.as(alpha.owner).post('/integrations', { category: 'EMAIL', provider: 'smtp', config: { host } }).expect(422);
        expect(res.body).toMatchObject({ code: 'ENDPOINT_NOT_ALLOWED', details: { reason: 'HOST_NOT_ALLOWED' } });
      }
      expect(await t.sys.integration.count({ where: { tenantId: alpha.id, category: 'EMAIL' } })).toBe(0);
    });

    it('saves the configuration as CONFIGURED and never returns a credential', async () => {
      const res = keep(
        await t
          .as(alpha.owner)
          .post('/integrations', { category: 'EMAIL', provider: 'smtp', mode: 'LIVE', config: { host: 'localhost', port: smtp.port, secure: false, requireTls: false, fromAddress: 'Hello@Alpha.Example', fromName: 'Alpha Typing' }, secrets: { user: 'mailer@alpha.example', password: 'wrong-password-first' } })
          .expect(201),
      );
      id = res.body.id;
      expect(res.body).toMatchObject({
        category: 'EMAIL', provider: 'smtp', instanceKey: null, kind: 'CONNECTION', name: 'Your own mail server (SMTP)', status: 'CONFIGURED', mode: 'LIVE',
        config: { host: 'localhost', port: smtp.port, secure: false, requireTls: false, fromAddress: 'hello@alpha.example', fromName: 'Alpha Typing' },
        secretKeys: ['password', 'user'], missing: { config: [], secrets: [] }, ready: true, approved: true, testable: true, lastTestedAt: null, authorisation: null,
      });
      expect(res.body.secretsUpdatedAt).toBeTruthy();
      expect(res.body.webhookUrl).toBeNull();
      expect(res.body).not.toHaveProperty('secretsEnc');
      expect(res.body).not.toHaveProperty('secrets');
      // Stored encrypted, never in clear text.
      const row = await t.sys.integration.findUniqueOrThrow({ where: { id } });
      expect(row.secretsEnc).toBeTruthy();
      expect(row.secretsEnc).not.toContain('wrong-password-first');
      expect(decryptJson(row.secretsEnc!)).toEqual({ user: 'mailer@alpha.example', password: 'wrong-password-first' });
      // One per provider.
      expect((await t.as(alpha.owner).post('/integrations', { category: 'EMAIL', provider: 'smtp', config: { host: 'other.example.ae' } }).expect(409)).body.code).toBe('INTEGRATION_EXISTS');
    });

    it('blocks a connection test that would reach an internal address (SSRF guard)', async () => {
      // "localhost" is a name, so it is only recognised as internal when it is resolved for the test.
      const res = keep(await t.as(alpha.owner).post(`/integrations/${id}/test`).expect(200));
      expect(res.body).toMatchObject({ supported: true, ok: false });
      expect(res.body.message).toMatch(/private or internal network address/);
      expect(smtp.logins).toHaveLength(0);
      const log = await t.sys.integrationLog.findFirstOrThrow({ where: { tenantId: alpha.id, integrationId: id }, orderBy: { createdAt: 'desc' } });
      expect(log).toMatchObject({ operation: 'TEST_CONNECTION', direction: 'OUTBOUND', success: false });
      expect(log.error).toMatch(/^HOST_NOT_ALLOWED/);
    });

    it('tests the connection against a real SMTP server: wrong password fails, right password succeeds', async () => {
      // The operator explicitly allows this development host (never possible in production).
      restore.push(allowDevHost('localhost'));
      const wrong = keep(await t.as(alpha.owner).post(`/integrations/${id}/test`).expect(200));
      expect(wrong.body).toMatchObject({ supported: true, ok: false });
      expect(wrong.body.message).toMatch(/refused the user name or password/);
      expect(smtp.logins.at(-1)).toMatchObject({ username: 'mailer@alpha.example', ok: false });
      expect((await t.sys.integration.findUniqueOrThrow({ where: { id } })).lastTestOk).toBe(false);

      // Credentials are write-only: replace the password, keep the user.
      const put = keep(await t.as(alpha.owner).put(`/integrations/${id}/secrets`, { secrets: { password: SMTP_PASSWORD } }).expect(200));
      expect(put.body).toMatchObject({ secretKeys: ['password', 'user'], lastTestedAt: null, lastTestOk: null });
      expect(decryptJson((await t.sys.integration.findUniqueOrThrow({ where: { id } })).secretsEnc!)).toEqual({ user: 'mailer@alpha.example', password: SMTP_PASSWORD });

      const ok = keep(await t.as(alpha.owner).post(`/integrations/${id}/test`).expect(200));
      expect(ok.body).toMatchObject({ supported: true, ok: true });
      expect(ok.body.message).toMatch(/signed in\. No message was sent/);
      expect(smtp.logins.at(-1)).toMatchObject({ ok: true });
      expect(smtp.messages).toBe(0);
      const after = keep(await t.as(alpha.owner).get(`/integrations/${id}`).expect(200));
      expect(after.body).toMatchObject({ lastTestOk: true, status: 'CONFIGURED' });
      expect(after.body.lastTestedAt).toBeTruthy();

      const logs = keep(await t.as(alpha.owner).get(`/integrations/logs?integrationId=${id}`).expect(200));
      expect(logs.body.meta.total).toBe(3);
      expect(logs.body.data[0]).toMatchObject({ category: 'EMAIL', provider: 'smtp', operation: 'TEST_CONNECTION', success: true, request: { host: 'localhost', port: smtp.port, auth: 'user + password (redacted)' } });
      expect(keep(await t.as(alpha.owner).get(`/integrations/logs?integrationId=${id}&success=false`).expect(200)).body.meta.total).toBe(2);
    });

    it('is used by the notifications module once it is switched on', async () => {
      const before = await t.as(alpha.owner).get('/notifications/channels').expect(200);
      expect(before.body.find((c: any) => c.channel === 'EMAIL')).toMatchObject({ source: 'PLATFORM' });
      const enabled = keep(await t.as(alpha.owner).post(`/integrations/${id}/enable`).expect(200));
      expect(enabled.body).toMatchObject({ status: 'ACTIVE', switchedOff: [] });
      const after = await t.as(alpha.owner).get('/notifications/channels').expect(200);
      expect(after.body.find((c: any) => c.channel === 'EMAIL')).toMatchObject({ provider: 'smtp', source: 'TENANT', configured: true });
      // SMTP has no REQUIRED credential (open relays exist), so it stays ACTIVE without a password.
      const removed = keep(await t.as(alpha.owner).put(`/integrations/${id}/secrets`, { secrets: { password: null } }).expect(200));
      expect(removed.body).toMatchObject({ status: 'ACTIVE', secretKeys: ['user'] });
      await t.as(alpha.owner).put(`/integrations/${id}/secrets`, { secrets: { password: SMTP_PASSWORD } }).expect(200);
      const off = keep(await t.as(alpha.owner).post(`/integrations/${id}/disable`).expect(200));
      expect(off.body.status).toBe('DISABLED');
      expect((await t.as(alpha.owner).get('/notifications/channels').expect(200)).body.find((c: any) => c.channel === 'EMAIL')).toMatchObject({ source: 'PLATFORM' });
    });

    it('validates credential names and changes of configuration', async () => {
      expect((await t.as(alpha.owner).put(`/integrations/${id}/secrets`, { secrets: { apiKey: 'nope' } }).expect(422)).body.details.field).toBe('apiKey');
      await t.as(alpha.owner).put(`/integrations/${id}/secrets`, { secrets: {} }).expect(400);
      const patched = keep(await t.as(alpha.owner).patch(`/integrations/${id}`, { name: 'Alpha mail relay', config: { host: 'localhost', port: smtp.port, requireTls: false } }).expect(200));
      // The configuration is replaced as a whole, and an earlier test result no longer applies.
      expect(patched.body).toMatchObject({ name: 'Alpha mail relay', config: { host: 'localhost', port: smtp.port, requireTls: false }, lastTestedAt: null, lastTestOk: null, secretKeys: ['password', 'user'] });
      expect(patched.body.config).not.toHaveProperty('fromAddress');
      await t.as(alpha.owner).patch(`/integrations/${id}`, {}).expect(400);
      expect((await t.as(alpha.owner).patch(`/integrations/${id}`, { authorisationNote: 'This is not a record at all' }).expect(422)).body.code).toBe('NOT_AN_AUTHORISATION_RECORD');
    });
  });

  // ------------------------------------------------------------------ provider APIs
  describe('connection tests against provider APIs (local fake servers)', () => {
    let tester: ConnectionTester;
    beforeAll(() => {
      tester = t.get(ConnectionTester);
      restore.push(allowDevHost('127.0.0.1'));
    });
    afterAll(() => {
      tester.setEndpoint('stripe', null);
      tester.setEndpoint('twilio', null);
    });

    it('Stripe: reads the balance with the secret key; needs both credentials before it can be enabled', async () => {
      const api = await new FakeApi((req) => (req.headers.authorization === `Bearer ${STRIPE_KEY}` ? { status: 200, body: { object: 'balance', livemode: false } } : { status: 401, body: { error: { type: 'invalid_request_error', message: `Invalid API Key provided: ${String(req.headers.authorization)}` } } })).start();
      tester.setEndpoint('stripe', api.url);
      try {
        const created = keep(await t.as(alpha.owner).post('/integrations', { category: 'PAYMENT', provider: 'stripe', secrets: { secretKey: 'sk_test_wrong_key_value_123' } }).expect(201));
        expect(created.body).toMatchObject({ status: 'CONFIGURED', secretKeys: ['secretKey'], missing: { secrets: ['webhookSecret'] }, ready: false });
        // The address to register in the Stripe dashboard is part of the answer.
        expect(created.body.webhookUrl).toBe(`${env().API_PUBLIC_URL}/api/v1/public/webhooks/payments/stripe`);
        const incomplete = await t.as(alpha.owner).post(`/integrations/${created.body.id}/enable`).expect(422);
        expect(incomplete.body).toMatchObject({ code: 'INTEGRATION_INCOMPLETE', details: { missing: { secrets: ['webhookSecret'] } } });
        expect((await t.as(alpha.owner).post(`/integrations/${created.body.id}/test`).expect(422)).body.code).toBe('INTEGRATION_INCOMPLETE');

        await t.as(alpha.owner).put(`/integrations/${created.body.id}/secrets`, { secrets: { webhookSecret: STRIPE_WHSEC } }).expect(200);
        const rejected = keep(await t.as(alpha.owner).post(`/integrations/${created.body.id}/test`).expect(200));
        expect(rejected.body).toMatchObject({ ok: false });
        expect(rejected.body.message).toMatch(/Stripe rejected the secret key/);
        expect(rejected.body.message).not.toContain('sk_test_wrong_key_value_123');

        await t.as(alpha.owner).put(`/integrations/${created.body.id}/secrets`, { secrets: { secretKey: `  ${STRIPE_KEY}\n` } }).expect(200);
        const ok = keep(await t.as(alpha.owner).post(`/integrations/${created.body.id}/test`).expect(200));
        expect(ok.body).toMatchObject({ ok: true });
        expect(ok.body.message).toMatch(/accepted the key \(test mode\)/);
        expect(api.seen.at(-1)).toMatchObject({ method: 'GET', url: '/v1/balance' });
        expect(api.seen.at(-1)!.headers.authorization).toBe(`Bearer ${STRIPE_KEY}`);
        const log = await t.sys.integrationLog.findFirstOrThrow({ where: { tenantId: alpha.id, integrationId: created.body.id, success: true } });
        expect(log).toMatchObject({ statusCode: 200, request: { method: 'GET', auth: 'bearer secret key (redacted)', keyKind: 'test' }, response: { status: 200, livemode: false } });

        const enabled = keep(await t.as(alpha.owner).post(`/integrations/${created.body.id}/enable`).expect(200));
        expect(enabled.body.status).toBe('ACTIVE');
        // Taking away a credential it needs puts it back to CONFIGURED: it can no longer be used.
        const removed = keep(await t.as(alpha.owner).put(`/integrations/${created.body.id}/secrets`, { secrets: { webhookSecret: null } }).expect(200));
        expect(removed.body).toMatchObject({ status: 'CONFIGURED', secretKeys: ['secretKey'] });
        await t.as(alpha.owner).delete(`/integrations/${created.body.id}`).expect(200);
      } finally {
        await api.stop();
      }
    });

    it('never follows a redirect to somewhere else', async () => {
      const target = await new FakeApi(() => ({ status: 200, body: { object: 'balance', livemode: false } })).start();
      const redirector = await new FakeApi(() => ({ status: 302, body: {}, headers: { location: `${target.url}/v1/balance` } })).start();
      tester.setEndpoint('stripe', redirector.url);
      try {
        const row = await createIntegration(t, beta.owner, { category: 'PAYMENT', provider: 'stripe', secrets: { secretKey: STRIPE_KEY, webhookSecret: STRIPE_WHSEC } });
        const res = keep(await t.as(beta.owner).post(`/integrations/${row.id}/test`).expect(200));
        expect(res.body.ok).toBe(false);
        expect(target.seen).toHaveLength(0);
        await t.as(beta.owner).delete(`/integrations/${row.id}`).expect(200);
      } finally {
        await target.stop();
        await redirector.stop();
      }
    });

    it('Twilio: reads the account with basic auth; one SMS provider is active at a time', async () => {
      // Built at runtime so GitHub secret scanning does not flag this fake SID.
      const sid = `AC${'0123456789abcdef'.repeat(2)}`;
      const expected = `Basic ${Buffer.from(`${sid}:${TWILIO_TOKEN}`).toString('base64')}`;
      const api = await new FakeApi((req) => (req.headers.authorization === expected ? { status: 200, body: { sid, status: 'active' } } : { status: 401, body: { code: 20003, message: 'Authenticate' } })).start();
      tester.setEndpoint('twilio', api.url);
      const gateway = allowDevHost('sms-gateway.example.ae');
      try {
        const twilio = keep(await t.as(alpha.owner).post('/integrations', { category: 'SMS', provider: 'twilio', config: { accountSid: sid, from: '+15005550006' }, secrets: { authToken: TWILIO_TOKEN } }).expect(201));
        const ok = keep(await t.as(alpha.owner).post(`/integrations/${twilio.body.id}/test`).expect(200));
        expect(ok.body).toMatchObject({ ok: true });
        expect(api.seen.at(-1)).toMatchObject({ method: 'GET', url: `/2010-04-01/Accounts/${sid}.json` });
        expect((await t.as(alpha.owner).post(`/integrations/${twilio.body.id}/enable`).expect(200)).body.status).toBe('ACTIVE');
        expect((await t.as(alpha.owner).get('/notifications/channels').expect(200)).body.find((c: any) => c.channel === 'SMS')).toMatchObject({ provider: 'twilio', source: 'TENANT', configured: true });

        // The HTTP gateway host must be https and approved by the operator.
        expect((await t.as(alpha.owner).post('/integrations', { category: 'SMS', provider: 'http', config: { url: 'https://unapproved.example.ae/send' }, secrets: { token: 'x' } }).expect(422)).body).toMatchObject({ code: 'ENDPOINT_NOT_ALLOWED' });
        expect((await t.as(alpha.owner).post('/integrations', { category: 'SMS', provider: 'http', config: { url: 'http://sms-gateway.example.com/send' }, secrets: { token: 'x' } }).expect(422)).body.details.reason).toBe('SCHEME_NOT_ALLOWED');
        expect((await t.as(alpha.owner).post('/integrations', { category: 'SMS', provider: 'http', config: { url: 'https://user:pw@sms-gateway.example.ae/send' }, secrets: { token: 'x' } }).expect(422)).body.code).toBe('INVALID_INTEGRATION_CONFIG');
        const http = keep(await t.as(alpha.owner).post('/integrations', { category: 'SMS', provider: 'http', config: { url: 'https://sms-gateway.example.ae/send' }, secrets: { token: 'gateway-token-no-leak' } }).expect(201));
        ALL_SECRETS.push('gateway-token-no-leak');
        // No automatic test exists for a generic gateway; nothing is recorded.
        const untestable = keep(await t.as(alpha.owner).post(`/integrations/${http.body.id}/test`).expect(200));
        expect(untestable.body).toMatchObject({ supported: false, ok: null, testedAt: null });
        expect(untestable.body.message).toMatch(/cannot be tested automatically/);
        expect(await t.sys.integrationLog.count({ where: { integrationId: http.body.id } })).toBe(0);

        const switched = keep(await t.as(alpha.owner).post(`/integrations/${http.body.id}/enable`).expect(200));
        expect(switched.body).toMatchObject({ status: 'ACTIVE', switchedOff: [{ id: twilio.body.id }] });
        expect((await t.sys.integration.findUniqueOrThrow({ where: { id: twilio.body.id } })).status).toBe('DISABLED');
      } finally {
        gateway();
        await api.stop();
      }
    });

    it('ClamAV: sends PING and expects PONG', async () => {
      const clamd = await new FakeClamd().start();
      const other = await new FakeClamd('HTTP/1.1 400 Bad Request\r\n\r\n').start();
      try {
        const row = keep(await t.as(alpha.owner).post('/integrations', { category: 'MALWARE_SCAN', provider: 'clamav', config: { host: '127.0.0.1', port: clamd.port } }).expect(201));
        expect(row.body.usage).toMatchObject({ effective: false });
        expect((await t.as(alpha.owner).post(`/integrations/${row.body.id}/test`).expect(200)).body).toMatchObject({ ok: true });
        expect(clamd.received).toEqual(['zPING\0']);
        await t.as(alpha.owner).patch(`/integrations/${row.body.id}`, { config: { host: '127.0.0.1', port: other.port } }).expect(200);
        const notClam = await t.as(alpha.owner).post(`/integrations/${row.body.id}/test`).expect(200);
        expect(notClam.body.ok).toBe(false);
        expect(notClam.body.message).toMatch(/not like a ClamAV scanner/);
        await t.as(alpha.owner).delete(`/integrations/${row.body.id}`).expect(200);
      } finally {
        await clamd.stop();
        await other.stop();
      }
    });
  });

  // ------------------------------------------------------------------ sandbox payments end to end
  describe('sandbox payment gateway configured through this API', () => {
    it('makes the finance online-payment flow work end to end', async () => {
      const gamma = await t.createTenant({ name: 'Gamma Typing' });
      const customer = await createCustomer(t, gamma);
      const invoice = await issueInvoice(t, gamma.owner, customer.id);
      // Nothing configured: the finance module answers "not configured".
      expect((await t.as(gamma.owner).post(`/invoices/${invoice.id}/pay`, {}).expect(503)).body.code).toBe('INTEGRATION_NOT_CONFIGURED');

      const sandbox = keep(await t.as(gamma.owner).post('/integrations', { category: 'PAYMENT', provider: 'sandbox', mode: 'LIVE' }).expect(201));
      // The sandbox is always a TEST gateway, whatever the client asks for.
      expect(sandbox.body).toMatchObject({ status: 'CONFIGURED', mode: 'TEST', secretKeys: [], ready: true });
      expect((await t.as(gamma.owner).patch(`/integrations/${sandbox.body.id}`, { mode: 'LIVE' }).expect(422)).body.code).toBe('MODE_NOT_SUPPORTED');
      // Saved but not switched on: still not usable.
      await t.as(gamma.owner).post(`/invoices/${invoice.id}/pay`, {}).expect(503);
      expect((await t.as(gamma.owner).post(`/integrations/${sandbox.body.id}/enable`).expect(200)).body.status).toBe('ACTIVE');

      const start = await t.as(gamma.owner).post(`/invoices/${invoice.id}/pay`, {}).expect(201);
      expect(start.body).toMatchObject({ status: 'PENDING', gateway: 'sandbox', testMode: true, invoiceId: invoice.id });
      const done = await t.http.post(`${new URL(start.body.checkoutUrl).pathname}/complete`).expect(200);
      expect(done.body.webhook).toMatchObject({ delivered: true, status: 200 });
      const paid = await t.as(gamma.owner).get(`/invoices/${invoice.id}`).expect(200);
      expect(paid.body).toMatchObject({ status: 'PAID', balanceDue: '0.00' });
      expect(await t.sys.payment.count({ where: { tenantId: gamma.id, status: 'COMPLETED', gateway: 'sandbox' } })).toBe(1);

      // Switched off again: new online payments stop, the completed one is untouched.
      await t.as(gamma.owner).post(`/integrations/${sandbox.body.id}/disable`).expect(200);
      const second = await issueInvoice(t, gamma.owner, customer.id);
      await t.as(gamma.owner).post(`/invoices/${second.id}/pay`, {}).expect(503);
    });
  });

  // ------------------------------------------------------------------ approved providers
  describe('platform-approved providers', () => {
    it('by default every provider of the catalogue is approved', async () => {
      const res = await t.as(admin).get('/platform/integrations/approved-providers').expect(200);
      expect(res.body.restricted).toBe(false);
      expect(res.body.providers.every((p: any) => p.approved)).toBe(true);
      expect(res.body.providers.map((p: any) => p.code)).toEqual(expect.arrayContaining(['PAYMENT/stripe', 'EMAIL/smtp', 'OCR/external-http', 'GOVERNMENT/official-portal-access']));
    });

    it('a provider that is not approved cannot be created or enabled, and active ones are switched off', async () => {
      const delta = await t.createTenant({ name: 'Delta Typing' });
      const wa = await createIntegration(t, delta.owner, { category: 'WHATSAPP', provider: 'meta', config: { phoneNumberId: '1098765432', languageCodes: { en: 'en_US', ar: 'ar' } }, secrets: { accessToken: 'wa-token-no-leak-1' } });
      ALL_SECRETS.push('wa-token-no-leak-1');
      await t.as(delta.owner).post(`/integrations/${wa.id}/enable`).expect(200);
      const push = await createIntegration(t, delta.owner, { category: 'PUSH', provider: 'fcm', config: { projectId: 'delta-app' }, secrets: { serviceAccountJson: JSON.stringify({ client_email: 'svc@delta.iam.example', private_key: 'not-a-real-key-no-leak' }) } });
      ALL_SECRETS.push('not-a-real-key-no-leak');

      expect((await t.as(admin).put('/platform/integrations/approved-providers', { providers: ['EMAIL/smtp', 'NOPE/unknown-thing'] }).expect(422)).body.code).toBe('UNKNOWN_PROVIDER');
      try {
        // Everything stays approved except WhatsApp, push and the external OCR service.
        const all: string[] = (await t.as(admin).get('/platform/integrations/approved-providers').expect(200)).body.providers.map((p: any) => p.code);
        const set = await t.as(admin).put('/platform/integrations/approved-providers', { providers: all.filter((code) => !['WHATSAPP/meta', 'PUSH/fcm', 'OCR/external-http'].includes(code)) }).expect(200);
        expect(set.body).toMatchObject({ restricted: true, switchedOff: 1 });
        expect(set.body.providers.find((p: any) => p.code === 'WHATSAPP/meta').approved).toBe(false);

        // The active WhatsApp integration was switched off for the centre, with an entry on ITS audit trail.
        expect((await t.sys.integration.findUniqueOrThrow({ where: { id: wa.id } })).status).toBe('DISABLED');
        expect(await t.sys.auditLog.count({ where: { tenantId: delta.id, action: 'integration.disabled_by_platform', resourceId: wa.id } })).toBe(1);
        const refusedEnable = await t.as(delta.owner).post(`/integrations/${wa.id}/enable`).expect(422);
        expect(refusedEnable.body).toMatchObject({ code: 'PROVIDER_NOT_APPROVED', details: { category: 'WHATSAPP', provider: 'meta' } });
        expect((await t.as(delta.owner).post(`/integrations/${push.id}/enable`).expect(422)).body.code).toBe('PROVIDER_NOT_APPROVED');
        const refusedCreate = await t.as(delta.owner).post('/integrations', { category: 'OCR', provider: 'external-http', config: { url: 'https://ocr.example.ai/v1' }, secrets: { token: 'x' } }).expect(422);
        expect(refusedCreate.body.code).toBe('PROVIDER_NOT_APPROVED');
        expect(refusedCreate.body.message).toMatch(/approved services/);
        expect(await t.sys.integration.count({ where: { tenantId: delta.id, category: 'OCR' } })).toBe(0);
        // The centre sees which providers it may use; approved ones still work.
        const catalogue = await t.as(delta.owner).get('/integrations/catalogue').expect(200);
        const flat = catalogue.body.flatMap((c: any) => c.providers);
        expect(flat.find((p: any) => p.provider === 'meta').approved).toBe(false);
        expect(flat.find((p: any) => p.provider === 'smtp').approved).toBe(true);
        expect((await t.as(delta.owner).get(`/integrations/${wa.id}`).expect(200)).body).toMatchObject({ approved: false, status: 'DISABLED' });
        await createIntegration(t, delta.owner, { category: 'EMAIL', provider: 'smtp', config: { host: 'smtp.delta.example.ae' } });
        // Recorded on the platform audit trail.
        expect(await t.sys.auditLog.count({ where: { tenantId: null, action: 'platform.approved_providers_changed', actorUserId: admin.userId } })).toBeGreaterThanOrEqual(1);
      } finally {
        const reset = await t.as(admin).put('/platform/integrations/approved-providers', { providers: null }).expect(200);
        expect(reset.body.restricted).toBe(false);
      }
      // Lifting the restriction does not switch anything back on by itself.
      expect((await t.sys.integration.findUniqueOrThrow({ where: { id: wa.id } })).status).toBe('DISABLED');
      expect((await t.as(delta.owner).post(`/integrations/${wa.id}/enable`).expect(200)).body.status).toBe('ACTIVE');
    });
  });

  // ------------------------------------------------------------------ authorisation records
  describe('government and partner authorisation records', () => {
    let gov: any;
    let cat: string;
    const direct = () => t.as(alpha.owner).post('/services', serviceBody(cat, { complianceCapability: 'DIRECT_AUTHORISED' }));
    const viaPartner = () => t.as(alpha.owner).post('/services', serviceBody(cat, { complianceCapability: 'PARTNER_COORDINATION' }));

    beforeAll(async () => {
      cat = await categoryId(t, alpha);
    });

    it('a government record holds no credentials and waits, switched off, for verification', async () => {
      expect((await t.as(alpha.owner).post('/integrations', governmentRecord({ authorisationNote: 'short' })).expect(422)).body.code).toBe('AUTHORISATION_NOTE_REQUIRED');
      const withSecret = await t.as(alpha.owner).post('/integrations', governmentRecord({ secrets: { password: 'portal-password' } })).expect(422);
      expect(withSecret.body.code).toBe('INVALID_INTEGRATION_CONFIG');
      expect(withSecret.body.message).toMatch(/never holds credentials/);
      const inNotes = await t.as(alpha.owner).post('/integrations', governmentRecord({ config: { ...governmentRecord().config, notes: 'portal login user: tasheel1 password: Secret#1' } })).expect(422);
      expect(inNotes.body.message).toMatch(/Never store portal credentials/);
      expect((await t.as(alpha.owner).post('/integrations', governmentRecord({ evidenceDocumentId: '6f1c3c9e-2a54-4d0b-9d3e-8b1c5a7f0e11' })).expect(422)).body.code).toBe('EVIDENCE_NOT_FOUND');
      expect((await t.as(alpha.owner).post('/integrations', governmentRecord({ config: { ...governmentRecord().config, validUntil: '2025-01-01' } })).expect(422)).body.details.field).toBe('validUntil');
      expect(await t.sys.integration.count({ where: { tenantId: alpha.id, category: 'GOVERNMENT' } })).toBe(0);

      const document = await t.sys.document.create({ data: { tenantId: alpha.id, documentTypeKey: 'trade_licence', title: 'Tasheel licence 2026' } });
      const foreign = await t.sys.document.create({ data: { tenantId: beta.id, documentTypeKey: 'trade_licence', title: 'Beta licence' } });
      expect((await t.as(alpha.owner).post('/integrations', governmentRecord({ evidenceDocumentId: foreign.id })).expect(422)).body.code).toBe('EVIDENCE_NOT_FOUND');

      const res = keep(await t.as(alpha.owner).post('/integrations', governmentRecord({ evidenceDocumentId: document.id })).expect(201));
      gov = res.body;
      expect(gov).toMatchObject({
        category: 'GOVERNMENT', provider: 'official-portal-access', instanceKey: 'mohre', kind: 'AUTHORISATION_RECORD', name: 'MOHRE', status: 'DISABLED', mode: 'LIVE', secretKeys: [], ready: false, testable: false,
        config: { authorityName: 'MOHRE', authorisationReference: 'TAS-2026-00417', validUntil: '2099-12-31' },
        authorisation: { state: 'PENDING', evidenceDocumentId: document.id, verifiedAt: null, reviewNote: null, expired: false },
      });
      expect(gov.config).not.toHaveProperty('_authorisation');
      expect((await t.sys.integration.findUniqueOrThrow({ where: { id: gov.id } })).provider).toBe('official-portal-access:mohre');

      // Not usable before a person at TypEase has checked it.
      expect((await direct().expect(422)).body.code).toBe('CAPABILITY_NOT_PERMITTED');
      expect((await t.as(alpha.owner).post(`/integrations/${gov.id}/enable`).expect(409)).body.code).toBe('AUTHORISATION_NOT_VERIFIED');
      expect((await t.as(alpha.owner).put(`/integrations/${gov.id}/secrets`, { secrets: { password: 'x' } }).expect(422)).body.message).toMatch(/never holds credentials/);
      expect((await t.as(alpha.owner).post(`/integrations/${gov.id}/test`).expect(200)).body).toMatchObject({ supported: false });
    });

    it('several authorities can be recorded, each under its own key', async () => {
      expect((await t.as(alpha.owner).post('/integrations', governmentRecord()).expect(409)).body.code).toBe('INTEGRATION_EXISTS');
      const second = await createIntegration(t, alpha.owner, governmentRecord({ instanceKey: undefined, config: { authorityName: 'GDRFA Dubai', authorisationReference: 'AMER-0099', credentialHolder: 'Owner' } }));
      expect(second).toMatchObject({ instanceKey: 'gdrfa-dubai', name: 'GDRFA Dubai', status: 'DISABLED' });
      expect((await t.as(alpha.owner).post('/integrations', { category: 'EMAIL', provider: 'smtp', instanceKey: 'second', config: { host: 'x.example.ae' } }).expect(422)).body.code).toBe('INSTANCE_NOT_SUPPORTED');
      const catalogue = await t.as(alpha.owner).get('/integrations/catalogue').expect(200);
      const entry = catalogue.body.find((c: any) => c.category === 'GOVERNMENT').providers[0];
      expect(entry.configured.map((c: any) => c.instanceKey).sort()).toEqual(['gdrfa-dubai', 'mohre']);
    });

    it('a platform administrator reviews pending records and sees only the record itself', async () => {
      const betaRecord = await createIntegration(t, beta.owner, governmentRecord({ instanceKey: 'icp', config: { authorityName: 'ICP', authorisationReference: 'ICP-551', credentialHolder: 'Beta owner' } }));
      const pending = await t.as(admin).get('/platform/integrations/authorisations').expect(200);
      const ids = pending.body.data.map((r: any) => r.id);
      expect(ids).toEqual(expect.arrayContaining([gov.id, betaRecord.id]));
      const mine = pending.body.data.find((r: any) => r.id === gov.id);
      expect(mine).toMatchObject({ centre: { id: alpha.id, name: 'Alpha Typing', slug: alpha.slug }, category: 'GOVERNMENT', provider: 'official-portal-access', instanceKey: 'mohre', state: 'PENDING', status: 'DISABLED' });
      expect(mine.fields.find((f: any) => f.key === 'authorisationReference')).toMatchObject({ label: 'Authorisation / licence reference', value: 'TAS-2026-00417', keyField: true });
      expect(mine.authorisationNote).toMatch(/MOHRE service-centre register/);
      expect(Object.keys(mine).sort()).toEqual(
        ['authorisationNote', 'category', 'centre', 'createdAt', 'evidenceDocumentId', 'fields', 'id', 'instanceKey', 'name', 'provider', 'reviewNote', 'reviewedAt', 'state', 'status', 'submittedAt', 'updatedAt', 'verifiedAt', 'verifiedByName'].sort(),
      );
      expect(Object.keys(mine.centre).sort()).toEqual(['id', 'name', 'slug', 'status']);
      // Filters; connections of a centre are not reachable here at all.
      expect((await t.as(admin).get(`/platform/integrations/authorisations?centreId=${beta.id}`).expect(200)).body.data.map((r: any) => r.id)).toEqual([betaRecord.id]);
      expect((await t.as(admin).get('/platform/integrations/authorisations?category=PARTNER').expect(200)).body.data.find((r: any) => r.id === gov.id)).toBeUndefined();
      const smtpRow = await t.sys.integration.findFirstOrThrow({ where: { tenantId: alpha.id, category: 'EMAIL' } });
      await t.as(admin).get(`/platform/integrations/authorisations/${smtpRow.id}`).expect(404);
      await t.as(admin).post(`/platform/integrations/authorisations/${smtpRow.id}/verify`, {}).expect(404);
      expect((await t.sys.integration.findUniqueOrThrow({ where: { id: smtpRow.id } })).authorisationVerifiedAt).toBeNull();
      await t.as(beta.owner).delete(`/integrations/${betaRecord.id}`).expect(200);
    });

    it('verification switches the record on and unlocks "direct authorised" services', async () => {
      const verified = await t.as(admin).post(`/platform/integrations/authorisations/${gov.id}/verify`, { note: 'Checked against the MOHRE register on 9 Oct.' }).expect(200);
      expect(verified.body).toMatchObject({ state: 'VERIFIED', status: 'ACTIVE', reviewNote: 'Checked against the MOHRE register on 9 Oct.' });
      expect(verified.body.verifiedByName).toMatch(/Platform SUPER_ADMIN/);
      expect((await t.as(admin).post(`/platform/integrations/authorisations/${gov.id}/verify`, {}).expect(409)).body.code).toBe('ALREADY_VERIFIED');
      const row = await t.sys.integration.findUniqueOrThrow({ where: { id: gov.id } });
      expect(row).toMatchObject({ status: 'ACTIVE', authorisationVerifiedById: admin.userId });
      expect(row.authorisationVerifiedAt).toBeTruthy();

      const mine = keep(await t.as(alpha.owner).get(`/integrations/${gov.id}`).expect(200));
      expect(mine.body).toMatchObject({ status: 'ACTIVE', ready: true, authorisation: { state: 'VERIFIED', reviewNote: 'Checked against the MOHRE register on 9 Oct.' } });
      expect(mine.body.authorisation.verifiedAt).toBeTruthy();
      // Both audit trails know about it.
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'integration.authorisation_verified', resourceId: gov.id } })).toBe(1);
      expect(await t.sys.auditLog.count({ where: { tenantId: null, action: 'integration.authorisation_verified', resourceId: gov.id, actorUserId: admin.userId } })).toBe(1);
      expect((await t.as(admin).get('/platform/integrations/authorisations?state=VERIFIED').expect(200)).body.data.map((r: any) => r.id)).toContain(gov.id);

      // Cross-module: the catalogue module now accepts the capability.
      expect((await direct().expect(201)).body.complianceCapability).toBe('DIRECT_AUTHORISED');
      // The centre may switch its own verified record off and on again.
      expect((await t.as(alpha.owner).post(`/integrations/${gov.id}/disable`).expect(200)).body.status).toBe('DISABLED');
      await direct().expect(422);
      expect((await t.as(alpha.owner).post(`/integrations/${gov.id}/enable`).expect(200)).body.status).toBe('ACTIVE');
      await direct().expect(201);
      // Nothing here makes the official-API channel available: no adapter exists in TypEase.
      expect(row.provider.startsWith('official-portal-access')).toBe(true);
    });

    it('changing a key field of a verified record withdraws the verification', async () => {
      // A contact detail is not what was verified.
      const minor = await t.as(alpha.owner).patch(`/integrations/${gov.id}`, { config: { ...gov.config, credentialHolder: 'Omar Haddad, Operations Lead', notes: 'Renewal reminder set for November.' } }).expect(200);
      expect(minor.body).toMatchObject({ status: 'ACTIVE', authorisation: { state: 'VERIFIED' } });
      await direct().expect(201);

      const changed = await t.as(alpha.owner).patch(`/integrations/${gov.id}`, { config: { ...gov.config, authorisationReference: 'TAS-2027-00001' } }).expect(200);
      expect(changed.body).toMatchObject({ status: 'DISABLED', ready: false, authorisation: { state: 'PENDING', verifiedAt: null, reviewNote: null } });
      const row = await t.sys.integration.findUniqueOrThrow({ where: { id: gov.id } });
      expect(row).toMatchObject({ authorisationVerifiedAt: null, authorisationVerifiedById: null, status: 'DISABLED' });
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'integration.verification_reset', resourceId: gov.id } })).toBe(1);
      expect((await direct().expect(422)).body.code).toBe('CAPABILITY_NOT_PERMITTED');
      expect((await t.as(alpha.owner).post(`/integrations/${gov.id}/enable`).expect(409)).body.code).toBe('AUTHORISATION_NOT_VERIFIED');
      expect((await t.as(admin).get('/platform/integrations/authorisations').expect(200)).body.data.map((r: any) => r.id)).toContain(gov.id);
    });

    it('a rejected record shows the note to the centre and can be corrected and submitted again', async () => {
      await t.as(admin).post(`/platform/integrations/authorisations/${gov.id}/reject`, { note: 'no' }).expect(400);
      const rejected = await t.as(admin).post(`/platform/integrations/authorisations/${gov.id}/reject`, { note: 'The reference TAS-2027-00001 is not on the register.' }).expect(200);
      expect(rejected.body).toMatchObject({ state: 'REJECTED', status: 'DISABLED', verifiedAt: null });
      expect((await t.as(admin).post(`/platform/integrations/authorisations/${gov.id}/reject`, { note: 'Again, the same.' }).expect(409)).body.code).toBe('ALREADY_REJECTED');
      expect((await t.as(admin).get('/platform/integrations/authorisations').expect(200)).body.data.map((r: any) => r.id)).not.toContain(gov.id);
      expect((await t.as(admin).get('/platform/integrations/authorisations?state=REJECTED').expect(200)).body.data.map((r: any) => r.id)).toContain(gov.id);

      const mine = await t.as(alpha.owner).get(`/integrations/${gov.id}`).expect(200);
      expect(mine.body.authorisation).toMatchObject({ state: 'REJECTED', reviewNote: 'The reference TAS-2027-00001 is not on the register.' });
      const refused = await t.as(alpha.owner).post(`/integrations/${gov.id}/enable`).expect(409);
      expect(refused.body.message).toMatch(/did not accept/);

      const corrected = await t.as(alpha.owner).patch(`/integrations/${gov.id}`, { config: { ...gov.config, authorisationReference: 'TAS-2026-00417' }, authorisationNote: 'Corrected the licence reference; see the attached licence.' }).expect(200);
      expect(corrected.body.authorisation.state).toBe('PENDING');
      await t.as(admin).post(`/platform/integrations/authorisations/${gov.id}/verify`, {}).expect(200);
      await direct().expect(201);
      // TypEase can also withdraw a verification later (for example when a licence lapses).
      const withdrawn = await t.as(admin).post(`/platform/integrations/authorisations/${gov.id}/reject`, { note: 'Licence suspended by the authority.' }).expect(200);
      expect(withdrawn.body).toMatchObject({ state: 'REJECTED', status: 'DISABLED' });
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'integration.authorisation_withdrawn', resourceId: gov.id } })).toBe(1);
      await direct().expect(422);
    });

    it('a partner record unlocks "partner coordination" only after verification', async () => {
      expect((await viaPartner().expect(422)).body.code).toBe('CAPABILITY_NOT_PERMITTED');
      const partner = await createIntegration(t, alpha.owner, partnerRecord());
      expect(partner).toMatchObject({ category: 'PARTNER', provider: 'authorised-partner', instanceKey: 'gulf-amer-services-llc', status: 'DISABLED', authorisation: { state: 'PENDING' } });
      // Submitted but unverified: still not usable (the record is not left in the CONFIGURED state).
      await viaPartner().expect(422);
      await t.as(admin).post(`/platform/integrations/authorisations/${partner.id}/verify`, {}).expect(200);
      expect((await viaPartner().expect(201)).body.complianceCapability).toBe('PARTNER_COORDINATION');
      // A partner does not authorise direct processing.
      await direct().expect(422);
    });

    it('a lapsed authorisation is switched off by the daily job and cannot be switched back on', async () => {
      const epsilon = await t.createTenant({ name: 'Epsilon Typing' });
      const record = await createIntegration(t, epsilon.owner, governmentRecord());
      await t.as(admin).post(`/platform/integrations/authorisations/${record.id}/verify`, {}).expect(200);
      await t.jobs.runScheduled(AUTHORISATION_EXPIRY_JOB);
      expect((await t.sys.integration.findUniqueOrThrow({ where: { id: record.id } })).status).toBe('ACTIVE');

      const row = await t.sys.integration.findUniqueOrThrow({ where: { id: record.id } });
      await t.sys.integration.update({ where: { id: record.id }, data: { config: { ...(row.config as object), validUntil: '2026-01-31' } } });
      await t.jobs.runScheduled(AUTHORISATION_EXPIRY_JOB);
      await t.jobs.runScheduled(AUTHORISATION_EXPIRY_JOB);
      expect((await t.sys.integration.findUniqueOrThrow({ where: { id: record.id } })).status).toBe('DISABLED');
      expect(await t.sys.auditLog.count({ where: { tenantId: epsilon.id, action: 'integration.authorisation_expired', resourceId: record.id } })).toBe(1);
      const view = await t.as(epsilon.owner).get(`/integrations/${record.id}`).expect(200);
      expect(view.body.authorisation).toMatchObject({ state: 'VERIFIED', expired: true });
      expect((await t.as(epsilon.owner).post(`/integrations/${record.id}/enable`).expect(409)).body.code).toBe('AUTHORISATION_EXPIRED');
    });
  });

  // ------------------------------------------------------------------ tenant isolation
  describe('tenant isolation', () => {
    it('one centre never sees or changes another centre\'s integrations or logs', async () => {
      const mine = await t.sys.integration.findMany({ where: { tenantId: alpha.id } });
      expect(mine.length).toBeGreaterThan(3);
      const betaRow = await createIntegration(t, beta.owner, { category: 'EMAIL', provider: 'smtp', config: { host: 'smtp.beta.example.ae' }, secrets: { user: 'beta', password: 'beta-smtp-password-no-leak' } });
      ALL_SECRETS.push('beta-smtp-password-no-leak');

      const betaList = keep(await t.as(beta.owner).get('/integrations').expect(200));
      expect(betaList.body.map((r: any) => r.id)).toEqual([betaRow.id]);
      const alphaList = keep(await t.as(alpha.owner).get('/integrations').expect(200));
      expect(alphaList.body.map((r: any) => r.id).sort()).toEqual(mine.map((r) => r.id).sort());
      expect(keep(await t.as(alpha.owner).get('/integrations?category=EMAIL').expect(200)).body).toHaveLength(1);

      for (const row of mine.slice(0, 3)) {
        await t.as(beta.owner).get(`/integrations/${row.id}`).expect(404);
        await t.as(beta.owner).patch(`/integrations/${row.id}`, { name: 'Taken over' }).expect(404);
        await t.as(beta.owner).put(`/integrations/${row.id}/secrets`, { secrets: { password: 'x' } }).expect(404);
        await t.as(beta.owner).post(`/integrations/${row.id}/enable`).expect(404);
        await t.as(beta.owner).post(`/integrations/${row.id}/disable`).expect(404);
        await t.as(beta.owner).post(`/integrations/${row.id}/test`).expect(404);
        await t.as(beta.owner).delete(`/integrations/${row.id}`).expect(404);
      }
      const unchanged = await t.sys.integration.findMany({ where: { tenantId: alpha.id } });
      expect(unchanged.map((r) => [r.id, r.name, r.status, r.secretsEnc])).toEqual(mine.map((r) => [r.id, r.name, r.status, r.secretsEnc]));

      const betaLogs = keep(await t.as(beta.owner).get('/integrations/logs').expect(200));
      expect(betaLogs.body.data.every((l: any) => l.tenantId === beta.id)).toBe(true);
      const alphaLogs = keep(await t.as(alpha.owner).get('/integrations/logs?pageSize=100').expect(200));
      expect(alphaLogs.body.meta.total).toBeGreaterThan(3);
      expect(alphaLogs.body.data.every((l: any) => l.tenantId === alpha.id)).toBe(true);
      expect(keep(await t.as(beta.owner).get(`/integrations/logs?integrationId=${mine[0].id}`).expect(200)).body.meta.total).toBe(0);

      // Row-level security holds even for an unfiltered query on the tenant connection.
      const visible = await t.inTenant(beta.id, () => t.db.tx((tx) => tx.integration.findMany()));
      expect(visible.every((r) => r.tenantId === beta.id)).toBe(true);
    });
  });

  // ------------------------------------------------------------------ secrets never leave
  describe('credentials', () => {
    it('never appear in any response, audit entry or log row', async () => {
      keep(await t.as(alpha.owner).get('/integrations').expect(200));
      keep(await t.as(alpha.owner).get('/integrations/logs?pageSize=100').expect(200));
      keep(await t.as(alpha.owner).get('/integrations/catalogue').expect(200));
      keep(await t.as(admin).get('/platform/integrations/authorisations?pageSize=100').expect(200));
      expect(seen.length).toBeGreaterThan(15);
      const audit = JSON.stringify(await t.sys.auditLog.findMany({ where: { action: { startsWith: 'integration.' } } }));
      const logs = JSON.stringify(await t.sys.integrationLog.findMany());
      const rows = JSON.stringify(await t.sys.integration.findMany());
      for (const secret of ALL_SECRETS) {
        expect(seen.join('\n')).not.toContain(secret);
        expect(audit).not.toContain(secret);
        expect(logs).not.toContain(secret);
        // ... and the table itself only holds them encrypted.
        expect(rows).not.toContain(secret);
      }
      expect(seen.join('\n')).not.toContain('secretsEnc');
      // The audit trail records WHICH credentials changed, not their values.
      const entry = await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: alpha.id, action: 'integration.credentials_changed' }, orderBy: { createdAt: 'asc' } });
      expect(entry.after).toMatchObject({ stored: expect.arrayContaining(['password']), set: ['password'], removed: [] });
    });

    it('deleting an integration removes its stored credentials', async () => {
      const row = await createIntegration(t, beta.owner, { category: 'SMS', provider: 'twilio', config: { accountSid: `AC${uniq()}`, from: 'BetaTyping' }, secrets: { authToken: 'to-be-deleted' } });
      expect((await t.as(beta.owner).delete(`/integrations/${row.id}`).expect(200)).body).toEqual({ status: 'DELETED' });
      expect(await t.sys.integration.findUnique({ where: { id: row.id } })).toBeNull();
      await t.as(beta.owner).get(`/integrations/${row.id}`).expect(404);
      expect(await t.sys.auditLog.count({ where: { tenantId: beta.id, action: 'integration.deleted', resourceId: row.id } })).toBe(1);
    });
  });
});
