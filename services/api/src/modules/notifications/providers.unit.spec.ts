import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { FakeHttp, TestSmtp } from './fixtures';
import { SmtpEmailProvider } from './providers/email';
import { LogProvider } from './providers/log';
import { assertAllowedHttpEndpoint, assertPublicHost, isPrivateAddress } from './providers/net-guard';
import { FcmPushProvider } from './providers/push';
import { ProviderRegistry } from './providers/registry';
import { HttpSmsProvider, TwilioSmsProvider } from './providers/sms';
import { ProviderError } from './providers/types';
import { MetaWhatsAppProvider } from './providers/whatsapp';

/**
 * Provider adapters against local fakes: a real SMTP server and a recording
 * HTTP server. They prove the exact wire format of each request; they do not
 * prove anything about the live providers' behaviour.
 */
describe('notification providers (local fakes)', () => {
  let http: FakeHttp;
  let smtp: TestSmtp;
  beforeAll(async () => {
    http = await new FakeHttp().start();
    smtp = await new TestSmtp().start();
  });
  afterAll(async () => {
    await http.stop();
    await smtp.stop();
  });
  beforeEach(() => {
    http.requests.length = 0;
    http.responses = [];
    http.routes = [];
    smtp.messages.length = 0;
    smtp.behaviour = [];
  });

  describe('SMTP email (nodemailer -> smtp-server)', () => {
    it('delivers subject, sender name, recipient, text and HTML and authenticates', async () => {
      const provider = new SmtpEmailProvider({ host: '127.0.0.1', port: smtp.port, secure: false, user: 'mailer', password: 's3cret', defaultFrom: { name: 'TypEase', address: 'no-reply@typease.test' } });
      const result = await provider.send({
        notificationId: '11111111-1111-4111-8111-111111111111',
        to: 'fatima@example.test',
        subject: 'Your request TE-000123 is complete',
        text: 'Hello Fatima, your request is complete.',
        html: '<p>Hello Fatima, your request is <b>complete</b>.</p>',
        from: { name: 'Al Noor Typing', address: 'hello@alnoor.example' },
        replyTo: 'support@alnoor.example',
      });
      provider.close();
      expect(result.providerMessageId).toBe('<11111111-1111-4111-8111-111111111111@alnoor.example>');
      expect(smtp.messages).toHaveLength(1);
      const mail = smtp.messages[0];
      expect(mail.from).toBe('hello@alnoor.example');
      expect(mail.to).toEqual(['fatima@example.test']);
      expect(mail.header('Subject')).toBe('Your request TE-000123 is complete');
      expect(mail.header('From')).toBe('Al Noor Typing <hello@alnoor.example>');
      expect(mail.header('To')).toBe('fatima@example.test');
      expect(mail.header('Reply-To')).toBe('support@alnoor.example');
      expect(mail.text).toContain('Hello Fatima, your request is complete.');
      expect(mail.text).toContain('<b>complete</b>');
      expect(smtp.logins.at(-1)).toEqual({ username: 'mailer', password: 's3cret' });
    });

    it('reports a temporary rejection as retryable and a permanent one as final', async () => {
      const provider = new SmtpEmailProvider({ host: '127.0.0.1', port: smtp.port, secure: false, defaultFrom: { name: 'TypEase', address: 'no-reply@typease.test' } });
      smtp.behaviour = [451, 550];
      const temporary = await provider.send({ to: 'a@example.test', subject: 's', text: 't' }).catch((e) => e);
      expect(temporary).toBeInstanceOf(ProviderError);
      expect(temporary.retryable).toBe(true);
      const permanent = await provider.send({ to: 'a@example.test', subject: 's', text: 't' }).catch((e) => e);
      expect(permanent).toBeInstanceOf(ProviderError);
      expect(permanent.retryable).toBe(false);
      provider.close();
      expect(smtp.messages).toHaveLength(0);
    });

    it('fails (retryable) when the server cannot be reached', async () => {
      const provider = new SmtpEmailProvider({ host: '127.0.0.1', port: 1, secure: false, defaultFrom: { name: 'TypEase', address: 'no-reply@typease.test' } });
      const err = await provider.send({ to: 'a@example.test', subject: 's', text: 't' }).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.retryable).toBe(true);
    });
  });

  describe('Twilio SMS', () => {
    it('posts a form-encoded message with HTTP Basic auth', async () => {
      http.responses = [{ status: 201, body: { sid: 'SM123', status: 'queued' } }];
      const provider = new TwilioSmsProvider({ accountSid: 'AC42', authToken: 'tok', from: '+15005550006', baseUrl: http.url });
      const result = await provider.send({ to: '+971501234567', text: 'Your code is 123456' });
      expect(result.providerMessageId).toBe('SM123');
      const req = http.requests[0];
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/2010-04-01/Accounts/AC42/Messages.json');
      expect(req.headers.authorization).toBe(`Basic ${Buffer.from('AC42:tok').toString('base64')}`);
      expect(req.headers['content-type']).toBe('application/x-www-form-urlencoded');
      expect(Object.fromEntries(new URLSearchParams(req.body))).toEqual({ To: '+971501234567', Body: 'Your code is 123456', From: '+15005550006' });
    });
    it('uses a messaging service when the sender is a service SID', async () => {
      http.responses = [{ status: 201, body: { sid: 'SM124' } }];
      const sid = `MG${'a'.repeat(32)}`;
      await new TwilioSmsProvider({ accountSid: 'AC42', authToken: 'tok', from: sid, baseUrl: http.url }).send({ to: '+971501234567', text: 'x' });
      expect(Object.fromEntries(new URLSearchParams(http.requests[0].body))).toEqual({ To: '+971501234567', Body: 'x', MessagingServiceSid: sid });
    });
    it('maps 4xx to a final error and 5xx / 429 to a retryable one', async () => {
      http.responses = [{ status: 400, body: { code: 21211, message: "The 'To' number is not a valid phone number." } }, { status: 503, body: {} }, { status: 429, body: {} }];
      const provider = new TwilioSmsProvider({ accountSid: 'AC42', authToken: 'tok', from: '+15005550006', baseUrl: http.url });
      const bad = await provider.send({ to: 'nope', text: 'x' }).catch((e) => e);
      expect(bad).toBeInstanceOf(ProviderError);
      expect(bad.retryable).toBe(false);
      expect(bad.message).toContain('21211');
      expect(bad.message).not.toContain('tok');
      expect((await provider.send({ to: '+971501234567', text: 'x' }).catch((e) => e)).retryable).toBe(true);
      expect((await provider.send({ to: '+971501234567', text: 'x' }).catch((e) => e)).retryable).toBe(true);
    });
  });

  describe('generic HTTP SMS gateway', () => {
    it('posts JSON { to, body } with a bearer token', async () => {
      http.responses = [{ status: 200, body: { id: 'gw-77' } }];
      const result = await new HttpSmsProvider({ url: `${http.url}/sms/send`, token: 'gateway-token' }).send({ to: '+971501234567', text: 'Hello' });
      expect(result.providerMessageId).toBe('gw-77');
      const req = http.requests[0];
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/sms/send');
      expect(req.headers.authorization).toBe('Bearer gateway-token');
      expect(req.headers['content-type']).toBe('application/json');
      expect(JSON.parse(req.body)).toEqual({ to: '+971501234567', body: 'Hello' });
    });
    it('surfaces a gateway rejection', async () => {
      http.responses = [{ status: 401, body: { error: 'invalid token' } }];
      const err = await new HttpSmsProvider({ url: `${http.url}/sms/send`, token: 'bad' }).send({ to: '+971501234567', text: 'Hello' }).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.retryable).toBe(false);
      expect(err.message).toContain('401');
    });
  });

  describe('Meta WhatsApp Business Cloud API', () => {
    it('sends an approved template message to /{phone-number-id}/messages', async () => {
      http.responses = [{ status: 200, body: { messaging_product: 'whatsapp', messages: [{ id: 'wamid.ABC' }] } }];
      const provider = new MetaWhatsAppProvider({ phoneNumberId: '1055', accessToken: 'EAAG-token', baseUrl: http.url, apiVersion: 'v21.0' });
      const result = await provider.send({ to: '+971501234567', text: 'ignored', whatsapp: { templateName: 'request_completed', languageCode: 'ar', parameters: ['فاطمة', 'TE-000123'] } });
      expect(result.providerMessageId).toBe('wamid.ABC');
      const req = http.requests[0];
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/v21.0/1055/messages');
      expect(req.headers.authorization).toBe('Bearer EAAG-token');
      expect(JSON.parse(req.body)).toEqual({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: '971501234567',
        type: 'template',
        template: { name: 'request_completed', language: { code: 'ar' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'فاطمة' }, { type: 'text', text: 'TE-000123' }] }] },
      });
    });
    it('refuses to send without an approved template and reports API errors', async () => {
      const provider = new MetaWhatsAppProvider({ phoneNumberId: '1055', accessToken: 'EAAG-token', baseUrl: http.url });
      const missing = await provider.send({ to: '+971501234567', text: 'free text' }).catch((e) => e);
      expect(missing.code).toBe('WHATSAPP_TEMPLATE_REQUIRED');
      expect(http.requests).toHaveLength(0);
      http.responses = [{ status: 400, body: { error: { message: '(#132001) Template name does not exist in the translation', code: 132001 } } }];
      const err = await provider.send({ to: '+971501234567', text: 'x', whatsapp: { templateName: 'nope', languageCode: 'en', parameters: [] } }).catch((e) => e);
      expect(err.retryable).toBe(false);
      expect(err.message).toContain('132001');
      expect(err.message).not.toContain('EAAG-token');
    });
  });

  describe('Firebase Cloud Messaging (HTTP v1)', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const account = { client_email: 'push@typease-test.iam.gserviceaccount.com', private_key: privateKey, private_key_id: 'key-1' };

    it('signs an RS256 service-account JWT, caches the access token and sends the message', async () => {
      http.routes = [
        { path: '/token', status: 200, body: { access_token: 'ya29.test-token', expires_in: 3600, token_type: 'Bearer' } },
        { path: '/v1/projects/typease-test/messages:send', status: 200, body: { name: 'projects/typease-test/messages/0:1' } },
      ];
      const provider = new FcmPushProvider({ projectId: 'typease-test', serviceAccount: account, tokenUrl: `${http.url}/token`, baseUrl: http.url });
      const first = await provider.send({ to: 'device-token-1', subject: 'Request completed', text: 'Your request is complete.', pushData: { relatedType: 'ServiceRequest', relatedId: 'r1' } });
      await provider.send({ to: 'device-token-2', subject: 'Second', text: 'Again' });
      expect(first.providerMessageId).toBe('projects/typease-test/messages/0:1');

      const tokenCalls = http.requests.filter((r) => r.url === '/token');
      expect(tokenCalls).toHaveLength(1); // cached until expiry
      const form = new URLSearchParams(tokenCalls[0].body);
      expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
      const claims = jwt.verify(form.get('assertion')!, publicKey, { algorithms: ['RS256'] }) as any;
      expect(claims.iss).toBe(account.client_email);
      expect(claims.scope).toBe('https://www.googleapis.com/auth/firebase.messaging');
      expect(claims.aud).toBe(`${http.url}/token`);
      expect(claims.exp - claims.iat).toBe(3600);
      expect(jwt.decode(form.get('assertion')!, { complete: true })!.header).toMatchObject({ alg: 'RS256', kid: 'key-1' });

      const sends = http.requests.filter((r) => r.url === '/v1/projects/typease-test/messages:send');
      expect(sends).toHaveLength(2);
      expect(sends[0].headers.authorization).toBe('Bearer ya29.test-token');
      expect(JSON.parse(sends[0].body)).toEqual({
        message: { token: 'device-token-1', notification: { title: 'Request completed', body: 'Your request is complete.' }, data: { relatedType: 'ServiceRequest', relatedId: 'r1' } },
      });
    });

    it('requests a new access token once the cached one is about to expire', async () => {
      http.routes = [{ path: '/token', status: 200, body: { access_token: 'short', expires_in: 30 } }];
      const provider = new FcmPushProvider({ projectId: 'p', serviceAccount: account, tokenUrl: `${http.url}/token`, baseUrl: http.url });
      await provider.accessToken();
      await provider.accessToken();
      expect(http.requests.filter((r) => r.url === '/token')).toHaveLength(2);
    });

    it('flags unregistered devices and failed authentication', async () => {
      http.routes = [
        { path: '/token', status: 200, body: { access_token: 't', expires_in: 3600 } },
        { path: '/v1/projects/p/messages:send', status: 404, body: { error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } } },
      ];
      const gone = await new FcmPushProvider({ projectId: 'p', serviceAccount: account, tokenUrl: `${http.url}/token`, baseUrl: http.url }).send({ to: 'old', subject: 's', text: 't' }).catch((e) => e);
      expect(gone.code).toBe('UNREGISTERED');
      expect(gone.retryable).toBe(false);

      http.routes = [{ path: '/token', status: 400, body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } }];
      const auth = await new FcmPushProvider({ projectId: 'p', serviceAccount: account, tokenUrl: `${http.url}/token`, baseUrl: http.url }).send({ to: 'd', subject: 's', text: 't' }).catch((e) => e);
      expect(auth.code).toBe('FCM_AUTH_FAILED');
      expect(auth.message).toContain('Invalid JWT Signature');

      const badKey = await new FcmPushProvider({ projectId: 'p', serviceAccount: { client_email: 'x', private_key: 'not a key' }, tokenUrl: `${http.url}/token`, baseUrl: http.url }).send({ to: 'd', subject: 's', text: 't' }).catch((e) => e);
      expect(badKey.code).toBe('FCM_KEY_INVALID');
      expect(badKey.retryable).toBe(false);
    });
  });

  describe('log provider and platform defaults', () => {
    const registry = new ProviderRegistry(null as any);
    const original = { ...env() };
    afterEach(() => Object.assign(env(), original));

    it('keeps messages in a local outbox in development', async () => {
      const { provider, source } = registry.platform('SMS');
      expect(provider.name).toBe('log');
      expect(source).toBe('PLATFORM');
      const result = await provider.send({ to: '+971500000001', text: 'hello log' });
      expect(result.providerMessageId).toMatch(/^log-/);
      expect(LogProvider.lastFor('+971500000001', 'SMS')?.message.text).toBe('hello log');
    });

    it('never pretends to send in production: the log driver and missing credentials fail clearly', () => {
      Object.assign(env(), { NODE_ENV: 'production' });
      for (const channel of ['EMAIL', 'SMS', 'WHATSAPP', 'PUSH'] as const) {
        let error: any;
        try {
          registry.platform(channel);
        } catch (e) {
          error = e;
        }
        expect(error).toBeInstanceOf(ProviderError);
        expect(error.code).toBe('INTEGRATION_NOT_CONFIGURED');
        expect(error.retryable).toBe(false);
        expect(error.message).toMatch(/is not configured/);
      }
    });

    it('requires complete credentials for each real driver', () => {
      Object.assign(env(), { MAIL_DRIVER: 'smtp', SMTP_HOST: undefined, SMS_DRIVER: 'twilio', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: undefined, WHATSAPP_DRIVER: 'meta', WHATSAPP_PHONE_NUMBER_ID: undefined, PUSH_DRIVER: 'fcm', FCM_PROJECT_ID: 'p', FCM_SERVICE_ACCOUNT_JSON: undefined });
      for (const channel of ['EMAIL', 'SMS', 'WHATSAPP', 'PUSH'] as const) expect(() => registry.platform(channel)).toThrow(/is not configured/);
      Object.assign(env(), { SMTP_HOST: 'mail.example.test', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM: '+15005550006', SMS_DRIVER: 'twilio', WHATSAPP_PHONE_NUMBER_ID: '1', WHATSAPP_ACCESS_TOKEN: 'x' });
      expect(registry.platform('EMAIL').provider.name).toBe('smtp');
      expect(registry.platform('SMS').provider.name).toBe('twilio');
      expect(registry.platform('WHATSAPP').provider.name).toBe('meta');
      Object.assign(env(), { SMS_DRIVER: 'http', SMS_HTTP_URL: 'https://sms.example.test/send', SMS_HTTP_TOKEN: 't' });
      expect(registry.platform('SMS').provider.name).toBe('http');
      Object.assign(env(), { FCM_SERVICE_ACCOUNT_JSON: 'not json' });
      expect(() => registry.platform('PUSH')).toThrow(/not a valid service-account key/);
    });
  });

  describe('outbound host guard (tenant-supplied servers)', () => {
    const original = { ...env() };
    afterEach(() => Object.assign(env(), original));

    it('recognises private, loopback and link-local addresses', () => {
      for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) expect([ip, isPrivateAddress(ip)]).toEqual([ip, true]);
      for (const ip of ['8.8.8.8', '172.32.0.1', '94.200.1.1', '2a00:1450:4001::1']) expect([ip, isPrivateAddress(ip)]).toEqual([ip, false]);
    });
    it('blocks private hosts in production only', async () => {
      await expect(assertPublicHost('127.0.0.1', 'Email delivery')).resolves.toBeUndefined();
      Object.assign(env(), { NODE_ENV: 'production' });
      await expect(assertPublicHost('127.0.0.1', 'Email delivery')).rejects.toThrow(/not allowed/);
      await expect(assertPublicHost('169.254.169.254', 'Email delivery')).rejects.toThrow(/not allowed/);
      await expect(assertPublicHost('8.8.8.8', 'Email delivery')).resolves.toBeUndefined();
    });
    it('allows tenant HTTP endpoints only on HTTPS and on the operator allow-list', () => {
      expect(() => assertAllowedHttpEndpoint('http://sms.partner.example/send', 'SMS delivery', ['sms.partner.example'])).toThrow(/https/);
      expect(() => assertAllowedHttpEndpoint('https://internal.service/send', 'SMS delivery', ['sms.partner.example'])).toThrow(/not been approved/);
      expect(() => assertAllowedHttpEndpoint('not a url', 'SMS delivery', [])).toThrow(/valid URL/);
      expect(assertAllowedHttpEndpoint('https://SMS.partner.example/send', 'SMS delivery', ['sms.partner.example']).hostname).toBe('sms.partner.example');
    });
  });
});
