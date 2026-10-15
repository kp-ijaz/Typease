import { createHmac } from 'node:crypto';
import { createServer, IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  checkUrl, DELIVERY_HEADER, DestinationPolicy, destinationOf, EVENT_HEADER, postSigned, privateAllowed, resolvePinned, safeEventData, sign, SIGNATURE_HEADER, TIMESTAMP_HEADER, WebhookFailed, WebhookRefused,
} from './webhook';

const policy = (over: Partial<DestinationPolicy> = {}): DestinationPolicy => ({ allowedHosts: ['hooks.partner.example'], tenantBase: 'https://n8n.centre.example/webhook', platformBase: null, production: true, ...over });
const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof WebhookRefused) return e.code;
    throw e;
  }
  return 'ACCEPTED';
};
const lookup = (...addresses: string[]) => async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

describe('webhook destination rules', () => {
  it('builds the address from a path below the n8n base, preferring the centre over the platform', () => {
    expect(destinationOf({ path: '/typease/new' }, policy())).toBe('https://n8n.centre.example/webhook/typease/new');
    expect(destinationOf({ path: '/typease/new' }, policy({ tenantBase: 'https://n8n.centre.example/webhook///' }))).toBe('https://n8n.centre.example/webhook/typease/new');
    expect(destinationOf({ path: '/x' }, policy({ tenantBase: null, platformBase: 'http://n8n:5678/webhook' }))).toBe('http://n8n:5678/webhook/x');
    expect(destinationOf({ url: 'https://hooks.partner.example/a' }, policy())).toBe('https://hooks.partner.example/a');
    expect(refusal(() => destinationOf({ path: '/x' }, policy({ tenantBase: null })))).toBe('NOT_CONFIGURED');
    expect(refusal(() => destinationOf({ path: '/x' }, policy({ tenantBase: '   ' })))).toBe('NOT_CONFIGURED');
  });

  it('accepts only the n8n address in force and hosts approved by the operator', () => {
    expect(checkUrl('https://n8n.centre.example/webhook/typease/new', policy()).trust).toBe('TENANT');
    expect(checkUrl('https://hooks.partner.example/anything?x=1', policy()).trust).toBe('ALLOW_LIST');
    expect(checkUrl('https://HOOKS.partner.EXAMPLE/anything', policy()).trust).toBe('ALLOW_LIST');
    expect(checkUrl('http://n8n:5678/webhook/x', policy({ platformBase: 'http://n8n:5678/webhook' })).trust).toBe('PLATFORM');

    expect(refusal(() => checkUrl('https://evil.example/webhook/typease/new', policy()))).toBe('HOST_NOT_ALLOWED');
    // Same host, but outside the base path / on another port / a look-alike prefix.
    expect(refusal(() => checkUrl('https://n8n.centre.example/admin', policy()))).toBe('HOST_NOT_ALLOWED');
    expect(refusal(() => checkUrl('https://n8n.centre.example/webhook/../admin', policy()))).toBe('HOST_NOT_ALLOWED');
    expect(refusal(() => checkUrl('https://n8n.centre.example/webhook-evil/x', policy()))).toBe('HOST_NOT_ALLOWED');
    expect(refusal(() => checkUrl('https://n8n.centre.example:8443/webhook/x', policy()))).toBe('HOST_NOT_ALLOWED');
    expect(refusal(() => checkUrl('https://n8n.centre.example.evil.example/webhook/x', policy()))).toBe('HOST_NOT_ALLOWED');
    expect(refusal(() => checkUrl('https://169.254.169.254/latest/meta-data', policy()))).toBe('HOST_NOT_ALLOWED');
    expect(refusal(() => checkUrl('https://localhost/webhook', policy()))).toBe('HOST_NOT_ALLOWED');
  });

  it('refuses malformed addresses, other schemes and credentials in the URL', () => {
    expect(refusal(() => checkUrl('not a url', policy()))).toBe('URL_INVALID');
    expect(refusal(() => checkUrl('ftp://hooks.partner.example/a', policy()))).toBe('URL_INVALID');
    expect(refusal(() => checkUrl('file:///etc/passwd', policy()))).toBe('URL_INVALID');
    expect(refusal(() => checkUrl('https://user:secret@hooks.partner.example/a', policy()))).toBe('CREDENTIALS_IN_URL');
    // "user@host" tricks: the real host is what follows the @.
    expect(refusal(() => checkUrl('https://hooks.partner.example@evil.example/a', policy()))).toBe('CREDENTIALS_IN_URL');
  });

  it('requires https, except where the operator allowed plain http', () => {
    expect(refusal(() => checkUrl('http://n8n.centre.example/webhook/x', policy({ tenantBase: 'http://n8n.centre.example/webhook' })))).toBe('HTTPS_REQUIRED');
    expect(checkUrl('http://hooks.partner.example/a', policy()).trust).toBe('ALLOW_LIST');
    expect(checkUrl('http://n8n:5678/webhook/a', policy({ platformBase: 'http://n8n:5678/webhook' })).trust).toBe('PLATFORM');
  });
});

describe('webhook address resolution (SSRF)', () => {
  const tenant = () => checkUrl('https://n8n.centre.example/webhook/x', policy());
  const listed = (production: boolean) => ({ checked: checkUrl('https://hooks.partner.example/x', policy({ production })), policy: policy({ production }) });

  it('pins a public address', async () => {
    await expect(resolvePinned(tenant(), policy(), lookup('93.184.216.34'))).resolves.toEqual({ address: '93.184.216.34', family: 4 });
    await expect(resolvePinned(tenant(), policy(), lookup('2606:2800:220:1:248:1893:25c8:1946', '93.184.216.34'))).resolves.toEqual({ address: '93.184.216.34', family: 4 });
  });

  it.each([
    ['loopback', '127.0.0.1'], ['private 10/8', '10.1.2.3'], ['private 172.16/12', '172.20.0.5'], ['private 192.168/16', '192.168.1.10'], ['link-local / cloud metadata', '169.254.169.254'],
    ['carrier-grade NAT', '100.64.0.1'], ['unspecified', '0.0.0.0'], ['IPv6 loopback', '::1'], ['IPv6 unique local', 'fd00::1'], ['IPv6 link-local', 'fe80::1'], ['IPv4-mapped IPv6', '::ffff:10.0.0.1'],
  ])('refuses a centre-supplied host that resolves to %s', async (_name, address) => {
    await expect(resolvePinned(tenant(), policy(), lookup(address))).rejects.toMatchObject({ code: 'PRIVATE_ADDRESS' });
    await expect(resolvePinned(tenant(), policy({ production: false }), lookup(address))).rejects.toMatchObject({ code: 'PRIVATE_ADDRESS' });
  });

  it('refuses when ANY of the resolved addresses is private (DNS answers that mix public and private)', async () => {
    await expect(resolvePinned(tenant(), policy(), lookup('93.184.216.34', '10.0.0.7'))).rejects.toBeInstanceOf(WebhookRefused);
  });

  it('refuses private IP literals of a centre-supplied address without any lookup', async () => {
    const never = jest.fn();
    for (const host of ['127.0.0.1', '10.0.0.5', '[::1]']) {
      const p = policy({ tenantBase: `https://${host}/webhook` });
      await expect(resolvePinned(checkUrl(`https://${host}/webhook/x`, p), p, never as any)).rejects.toMatchObject({ code: 'PRIVATE_ADDRESS' });
    }
    expect(never).not.toHaveBeenCalled();
  });

  it('lets an operator-approved host be private outside production only', async () => {
    const dev = listed(false);
    await expect(resolvePinned(dev.checked, dev.policy, lookup('127.0.0.1'))).resolves.toEqual({ address: '127.0.0.1', family: 4 });
    const prod = listed(true);
    await expect(resolvePinned(prod.checked, prod.policy, lookup('127.0.0.1'))).rejects.toMatchObject({ code: 'PRIVATE_ADDRESS' });
    expect(privateAllowed('ALLOW_LIST', true)).toBe(false);
    expect(privateAllowed('TENANT', false)).toBe(false);
  });

  it("lets the platform's own n8n (operator configuration) live in the private network", async () => {
    const p = policy({ tenantBase: null, platformBase: 'http://n8n:5678/webhook' });
    await expect(resolvePinned(checkUrl('http://n8n:5678/webhook/x', p), p, lookup('172.18.0.4'))).resolves.toEqual({ address: '172.18.0.4', family: 4 });
  });

  it('treats a failed lookup as a temporary failure', async () => {
    const failing = async () => {
      throw new Error('ENOTFOUND');
    };
    await expect(resolvePinned(tenant(), policy(), failing)).rejects.toMatchObject({ retryable: true });
    await expect(resolvePinned(tenant(), policy(), lookup())).rejects.toBeInstanceOf(WebhookFailed);
  });
});

describe('webhook delivery', () => {
  interface Seen {
    method: string;
    url: string;
    headers: IncomingMessage['headers'];
    body: string;
  }
  let server: Server;
  let port: number;
  let seen: Seen[];
  let respond: (req: IncomingMessage, body: string) => { status: number; headers?: Record<string, string>; hang?: boolean };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
        const answer = respond(req, body);
        if (answer.hang) return;
        res.writeHead(answer.status, answer.headers ?? {});
        res.end('ignored body');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }));
  beforeEach(() => {
    seen = [];
    respond = () => ({ status: 204 });
  });

  const dev = (): DestinationPolicy => ({ allowedHosts: ['hooks.local.test'], tenantBase: null, platformBase: null, production: false });
  const post = (path = '/webhook/typease', extra: Partial<Parameters<typeof postSigned>[0]> = {}) =>
    postSigned({
      checked: checkUrl(`http://hooks.local.test:${port}${path}`, dev()),
      // The name does not resolve at all: the request only arrives because the connection is pinned.
      pinned: { address: '127.0.0.1', family: 4 },
      body: JSON.stringify({ event: 'request.submitted', data: { requestId: 'r1' } }),
      secret: 'top-secret',
      deliveryId: 'exec-1:0',
      event: 'request.submitted',
      ...extra,
    });

  it('signs the exact body with HMAC-SHA256 over "<timestamp>.<body>"', () => {
    const expected = createHmac('sha256', 'k').update('1700000000.{"a":1}').digest('hex');
    expect(sign('k', 1700000000, '{"a":1}')).toBe(`sha256=${expected}`);
    expect(sign('other', 1700000000, '{"a":1}')).not.toBe(`sha256=${expected}`);
  });

  it('POSTs JSON to the pinned address with signature, timestamp, delivery id and event headers', async () => {
    await expect(post('/webhook/typease?source=te', { now: () => 1_700_000_000_000 })).resolves.toEqual({ status: 204 });
    expect(seen).toHaveLength(1);
    const call = seen[0];
    expect(call.method).toBe('POST');
    expect(call.url).toBe('/webhook/typease?source=te');
    expect(call.headers.host).toBe(`hooks.local.test:${port}`);
    expect(call.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(call.headers[TIMESTAMP_HEADER.toLowerCase()]).toBe('1700000000');
    expect(call.headers[DELIVERY_HEADER.toLowerCase()]).toBe('exec-1:0');
    expect(call.headers[EVENT_HEADER.toLowerCase()]).toBe('request.submitted');
    // The receiver can verify the call with nothing but the shared secret, the timestamp header and the raw body.
    const expected = `sha256=${createHmac('sha256', 'top-secret').update(`1700000000.${call.body}`).digest('hex')}`;
    expect(call.headers[SIGNATURE_HEADER.toLowerCase()]).toBe(expected);
    expect(JSON.parse(call.body)).toEqual({ event: 'request.submitted', data: { requestId: 'r1' } });
  });

  it('retries server errors and throttling, but not client errors', async () => {
    for (const [status, retryable] of [[500, true], [503, true], [429, true], [408, true], [400, false], [401, false], [404, false], [410, false]] as const) {
      respond = () => ({ status });
      await expect(post()).rejects.toMatchObject({ retryable, status });
    }
  });

  it('never follows a redirect', async () => {
    respond = (req) => (req.url === '/webhook/typease' ? { status: 302, headers: { Location: `http://127.0.0.1:${port}/internal/admin` } } : { status: 200 });
    await expect(post()).rejects.toMatchObject({ retryable: false, status: 302 });
    expect(seen.map((s) => s.url)).toEqual(['/webhook/typease']);
    respond = () => ({ status: 307, headers: { Location: 'http://169.254.169.254/latest/meta-data' } });
    await expect(post()).rejects.toMatchObject({ status: 307 });
  });

  it('gives up after the time limit', async () => {
    respond = () => ({ status: 200, hang: true });
    const started = Date.now();
    await expect(post('/slow', { timeoutMs: 150 })).rejects.toMatchObject({ retryable: true, status: null });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('reports an unreachable destination as a temporary failure', async () => {
    const closed = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    await expect(postSigned({ checked: checkUrl(`http://hooks.local.test:${closed}/x`, dev()), pinned: { address: '127.0.0.1', family: 4 }, body: '{}', secret: 's', deliveryId: 'd', event: 'e' })).rejects.toMatchObject({ retryable: true });
  });
});

describe('webhook payload', () => {
  it('keeps identifiers, codes, amounts and dates and drops everything else', () => {
    const data = safeEventData({
      requestId: '5b1d7c2e-1111-4222-8333-444455556666', requestNo: 'TE-000123', customerId: 'c-1', from: 'SUBMITTED', to: 'UNDER_REVIEW', customerVisible: true, amount: '155.00', currency: 'AED', daysLeft: 30,
      invoiceIds: ['i-1', 'i-2'], expiryDate: '2027-01-31',
      // none of these may leave the system
      customerMessage: 'Please bring your passport', reason: 'Customer called, very upset', message: 'free text', subjectLabel: "Ahmed's passport", fullName: 'Ahmed Al Mansoori', emiratesId: '784-1990-1234567-1',
      passportNo: 'P1234567', notes: 'x', stepName: 'Prepare', invoiceNumber: 'SUB-1', _actor: { userId: 'u-1', type: 'STAFF' },
    });
    expect(data).toEqual({
      requestId: '5b1d7c2e-1111-4222-8333-444455556666', requestNo: 'TE-000123', customerId: 'c-1', from: 'SUBMITTED', to: 'UNDER_REVIEW', customerVisible: true, amount: '155.00', currency: 'AED', daysLeft: 30,
      invoiceIds: ['i-1', 'i-2'], expiryDate: '2027-01-31',
    });
  });

  it('drops values of the wrong shape even under an allowed name', () => {
    expect(safeEventData({ requestId: { $ne: null }, customerId: 'x'.repeat(201), invoiceIds: [{ id: 1 }], amount: Number.NaN, requestIds: ['ok'] })).toEqual({ requestIds: ['ok'] });
    expect(safeEventData(null)).toEqual({});
  });
});
