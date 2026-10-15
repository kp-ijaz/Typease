import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { env } from '../../config/env';
import { scrub } from './connection-tester';
import { assertApprovedEndpoint, EndpointNotAllowed, guardedRequest, isDevAllowedHost, parseSafeUrl, resolveSafeHost } from './net-guard';

const lookupTo = (...addresses: string[]) => async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
const code = async (p: Promise<unknown>) => p.then(() => 'OK', (e) => (e instanceof EndpointNotAllowed ? e.code : `OTHER:${e?.message}`));

describe('integrations SSRF guard', () => {
  const allowed = env().OUTBOUND_WEBHOOK_ALLOWED_HOSTS;
  const nodeEnv = env().NODE_ENV;
  afterEach(() => {
    allowed.length = 0;
    (env() as any).NODE_ENV = nodeEnv;
  });

  describe('resolveSafeHost', () => {
    it('accepts a host whose addresses are all public and prefers IPv4', async () => {
      expect(await resolveSafeHost('smtp.example.ae', 'Mail server', lookupTo('2001:4860:4860::8888', '93.184.216.34'))).toEqual({ host: 'smtp.example.ae', address: '93.184.216.34', family: 4 });
      expect(await resolveSafeHost('8.8.8.8', 'Mail server')).toEqual({ host: '8.8.8.8', address: '8.8.8.8', family: 4 });
      expect((await resolveSafeHost('v6.example.ae', 'Mail server', lookupTo('2001:4860:4860::8888'))).family).toBe(6);
    });
    it('refuses private, loopback, link-local, CGNAT and unspecified addresses', async () => {
      for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::5', '::ffff:10.0.0.1', '224.0.0.1']) {
        expect(await code(resolveSafeHost(ip, 'Mail server'))).toBe('HOST_NOT_ALLOWED');
        expect(await code(resolveSafeHost('name.example.ae', 'Mail server', lookupTo(ip)))).toBe('HOST_NOT_ALLOWED');
      }
    });
    it('refuses a name that resolves to a public AND an internal address (DNS trick)', async () => {
      expect(await code(resolveSafeHost('mixed.example.ae', 'Mail server', lookupTo('93.184.216.34', '10.0.0.7')))).toBe('HOST_NOT_ALLOWED');
    });
    it('reports names that do not resolve', async () => {
      expect(await code(resolveSafeHost('nowhere.example.ae', 'Mail server', async () => { throw new Error('ENOTFOUND'); }))).toBe('DNS_FAILED');
      expect(await code(resolveSafeHost('empty.example.ae', 'Mail server', lookupTo()))).toBe('DNS_FAILED');
      expect(await code(resolveSafeHost('  ', 'Mail server'))).toBe('URL_INVALID');
    });
    it('allows an internal development host only when the operator listed it, and never in production', async () => {
      allowed.push('mailhog.internal');
      expect(isDevAllowedHost('MailHog.Internal')).toBe(true);
      expect(await resolveSafeHost('mailhog.internal', 'Mail server', lookupTo('10.0.0.7'))).toMatchObject({ address: '10.0.0.7' });
      expect(await code(resolveSafeHost('other.internal', 'Mail server', lookupTo('10.0.0.7')))).toBe('HOST_NOT_ALLOWED');
      (env() as any).NODE_ENV = 'production';
      expect(isDevAllowedHost('mailhog.internal')).toBe(false);
      expect(await code(resolveSafeHost('mailhog.internal', 'Mail server', lookupTo('10.0.0.7')))).toBe('HOST_NOT_ALLOWED');
    });
  });

  describe('parseSafeUrl / assertApprovedEndpoint', () => {
    const tryParse = (url: string) => {
      try {
        return parseSafeUrl(url, 'Gateway').toString();
      } catch (e: any) {
        return e.code as string;
      }
    };
    it('only https, no credentials in the address', () => {
      expect(tryParse('https://api.example.ae/v1')).toBe('https://api.example.ae/v1');
      expect(tryParse('http://api.example.ae/v1')).toBe('SCHEME_NOT_ALLOWED');
      expect(tryParse('ftp://api.example.ae/v1')).toBe('SCHEME_NOT_ALLOWED');
      expect(tryParse('file:///etc/passwd')).toBe('SCHEME_NOT_ALLOWED');
      expect(tryParse('https://user:pw@api.example.ae/')).toBe('URL_INVALID');
      expect(tryParse('not a url')).toBe('URL_INVALID');
    });
    it('plain http is possible only for a listed development host outside production', () => {
      allowed.push('127.0.0.1');
      expect(tryParse('http://127.0.0.1:8080/x')).toBe('http://127.0.0.1:8080/x');
      expect(tryParse('http://127.0.0.2:8080/x')).toBe('SCHEME_NOT_ALLOWED');
      (env() as any).NODE_ENV = 'production';
      expect(tryParse('http://127.0.0.1:8080/x')).toBe('SCHEME_NOT_ALLOWED');
    });
    it('webhook-style endpoints must be on the operator allow-list', () => {
      expect(() => assertApprovedEndpoint('https://gw.example.ae/send', 'SMS gateway')).toThrow(/has not been approved yet/);
      allowed.push('gw.example.ae');
      expect(assertApprovedEndpoint('https://GW.example.ae/send', 'SMS gateway').hostname).toBe('gw.example.ae');
      // The list approves the host; it never downgrades to http.
      expect(() => assertApprovedEndpoint('http://gw.example.ae/send', 'SMS gateway')).toThrow(/only https/);
      (env() as any).NODE_ENV = 'production';
      expect(() => assertApprovedEndpoint('http://gw.example.ae/send', 'SMS gateway')).toThrow(/only https/);
      expect(assertApprovedEndpoint('https://gw.example.ae/send', 'SMS gateway').protocol).toBe('https:');
    });
  });

  describe('guardedRequest', () => {
    it('connects to the address that was checked, sends the headers and caps the body', async () => {
      const seen: Array<{ host?: string; auth?: string; url?: string }> = [];
      const server = createServer((req, res) => {
        seen.push({ host: req.headers.host, auth: req.headers.authorization, url: req.url });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, filler: 'x'.repeat(5000) }));
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const port = (server.address() as AddressInfo).port;
      try {
        allowed.push('api.dev.internal');
        // The name does not exist in DNS: the request can only arrive because the checked address is used.
        const res = await guardedRequest('GET', `http://api.dev.internal:${port}/v1/ping?x=1`, { what: 'Test', headers: { authorization: 'Bearer abc' }, lookup: lookupTo('127.0.0.1'), maxBytes: 1000 });
        expect(res.status).toBe(200);
        expect(res.body.length).toBeLessThanOrEqual(1000);
        expect(seen).toEqual([{ host: `api.dev.internal:${port}`, auth: 'Bearer abc', url: '/v1/ping?x=1' }]);
        // Without the allow-list entry nothing is sent at all.
        allowed.length = 0;
        expect(await code(guardedRequest('GET', `http://api.dev.internal:${port}/v1/ping`, { what: 'Test', lookup: lookupTo('127.0.0.1') }))).toBe('SCHEME_NOT_ALLOWED');
        expect(await code(guardedRequest('GET', `https://api.dev.internal:${port}/v1/ping`, { what: 'Test', lookup: lookupTo('127.0.0.1') }))).toBe('HOST_NOT_ALLOWED');
        expect(seen).toHaveLength(1);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    });
    it('reports a server that does not answer as an ordinary error', async () => {
      allowed.push('127.0.0.1');
      await expect(guardedRequest('GET', 'http://127.0.0.1:1/x', { what: 'Test', timeoutMs: 2000 })).rejects.toThrow();
    });
  });

  it('scrub removes credential values an upstream error may echo back', () => {
    expect(scrub('535 Authentication failed for mailer with password hunter2-long', { user: 'mailer', password: 'hunter2-long' })).toBe('535 Authentication failed for [redacted] with password [redacted]');
    expect(scrub('short values such as "ab" are left alone', { pin: 'ab' })).toContain('"ab"');
    expect(scrub(`line one\n   line two ${'x'.repeat(400)}`, {}).length).toBe(300);
  });
});
