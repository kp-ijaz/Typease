import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { signPayload } from '../../common/crypto';
import { LocalStorageDriver, StorageObjectNotFound, UploadRejected } from './local.driver';
import { S3StorageDriver } from './s3.driver';
import { contentDisposition, isValidKey, stagingKeyFor } from './storage.types';

const TENANT = '11111111-2222-4333-8444-555555555555';
const KEY = `${TENANT}/${'k'.repeat(32)}`;
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('confidential passport scan '.repeat(40))]);

describe('storage keys', () => {
  it('accepts only <tenantId>/<random> keys, optionally in the staging area', () => {
    expect(isValidKey(KEY)).toBe(true);
    expect(isValidKey(stagingKeyFor(KEY))).toBe(true);
    for (const bad of ['', 'abc', `${TENANT}/../etc/passwd`, `../${KEY}`, `${TENANT}/short`, `${KEY}/more`, `/${KEY}`, `incoming/incoming/${KEY}`, `${TENANT}\\${'k'.repeat(32)}`, null, 42]) {
      expect(isValidKey(bad)).toBe(false);
    }
  });

  it('builds a safe Content-Disposition header', () => {
    expect(contentDisposition('attachment', 'passport.pdf')).toBe(`attachment; filename="passport.pdf"; filename*=UTF-8''passport.pdf`);
    const tricky = contentDisposition('inline', 'جواز "x"\\.pdf');
    expect(tricky).toMatch(/^inline; filename="[\x20-\x7e]*"; filename\*=UTF-8''[A-Za-z0-9%._-]+$/);
    expect(tricky.split('filename*')[0]).not.toContain('\\');
    expect(tricky.split('filename="')[1].split('";')[0]).not.toContain('"');
  });
});

describe('local storage driver', () => {
  let dir: string;
  let driver: LocalStorageDriver;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'typease-local-'));
    driver = new LocalStorageDriver(dir);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('stores files encrypted at rest and returns the original bytes', async () => {
    await driver.put(KEY, PDF, 'application/pdf');
    const onDisk = readFileSync(join(dir, `${KEY}.obj`));
    expect(onDisk.includes(Buffer.from('confidential passport scan'))).toBe(false);
    expect(onDisk.includes(Buffer.from('%PDF'))).toBe(false);
    expect((await driver.getBuffer(KEY)).equals(PDF)).toBe(true);
    expect(await driver.head(KEY)).toEqual({ sizeBytes: PDF.length, contentType: 'application/pdf' });
    expect((await driver.readHead(KEY, 5)).toString()).toBe('%PDF-');
    expect(statSync(join(dir, `${KEY}.obj`)).mode & 0o077).toBe(0);
  });

  it('refuses to serve a file that was modified on disk', async () => {
    const key = `${TENANT}/${'t'.repeat(32)}`;
    await driver.put(key, PDF, 'application/pdf');
    const path = join(dir, `${key}.obj`);
    const bytes = readFileSync(path);
    bytes[bytes.length - 3] ^= 0xff;
    writeFileSync(path, bytes);
    await expect(driver.getBuffer(key)).rejects.toThrow();
  });

  it('reports missing objects, moves and deletes idempotently', async () => {
    const a = `${TENANT}/${'a'.repeat(32)}`;
    const b = `${TENANT}/${'b'.repeat(32)}`;
    expect(await driver.head(a)).toBeNull();
    await expect(driver.getBuffer(a)).rejects.toBeInstanceOf(StorageObjectNotFound);
    await expect(driver.move(a, b)).rejects.toBeInstanceOf(StorageObjectNotFound);
    await driver.put(stagingKeyFor(a), PDF, 'application/pdf');
    await driver.move(stagingKeyFor(a), b);
    expect(await driver.head(stagingKeyFor(a))).toBeNull();
    expect((await driver.getBuffer(b)).equals(PDF)).toBe(true);
    await driver.delete(b);
    await driver.delete(b);
    expect(await driver.head(b)).toBeNull();
  });

  it('never resolves a key outside its root', async () => {
    for (const bad of [`${TENANT}/../../etc/passwd`, '../../etc/passwd', `${TENANT}/x`]) {
      await expect(driver.put(bad, PDF, 'application/pdf')).rejects.toThrow(/Invalid storage key/);
      await expect(driver.getBuffer(bad)).rejects.toThrow(/Invalid storage key/);
      await expect(driver.delete(bad)).rejects.toThrow(/Invalid storage key/);
      await expect(driver.presignDownload(bad, { filename: 'x', contentType: 'application/pdf', disposition: 'attachment', ttlSeconds: 60 })).rejects.toThrow(/Invalid storage key/);
    }
  });

  describe('signed tickets', () => {
    const tokenOf = (url: string) => url.split('/').pop()!;

    it('issues opaque, expiring upload and download tickets', async () => {
      const up = await driver.presignUpload(stagingKeyFor(KEY), { contentType: 'application/pdf', sizeBytes: PDF.length, ttlSeconds: 600 });
      expect(up.method).toBe('PUT');
      expect(up.headers).toEqual({ 'Content-Type': 'application/pdf' });
      expect(up.url).toMatch(/\/api\/v1\/storage\/local\/upload\/[A-Za-z0-9_.-]+$/);
      expect(up.expiresAt.getTime()).toBeGreaterThan(Date.now() + 590_000);
      // The object key is not readable from the URL (the ticket body is encrypted).
      const body = Buffer.from(tokenOf(up.url).split('.')[0], 'base64url').toString('utf8');
      expect(up.url).not.toContain(TENANT);
      expect(body).not.toContain(TENANT);
      expect(body).not.toContain('k'.repeat(32));
      const ticket = driver.openUploadTicket(tokenOf(up.url))!;
      expect(ticket).toMatchObject({ op: 'put', key: stagingKeyFor(KEY), ct: 'application/pdf', size: PDF.length });

      const down = await driver.presignDownload(KEY, { filename: 'p.pdf', contentType: 'application/pdf', disposition: 'inline', ttlSeconds: 120 });
      expect(driver.openDownloadTicket(tokenOf(down.url))).toMatchObject({ op: 'get', key: KEY, fn: 'p.pdf', disp: 'inline' });
      // A ticket is only valid for the operation it was issued for.
      expect(driver.openUploadTicket(tokenOf(down.url))).toBeNull();
      expect(driver.openDownloadTicket(tokenOf(up.url))).toBeNull();
    });

    it('rejects tampered, foreign and expired tickets', async () => {
      const down = await driver.presignDownload(KEY, { filename: 'p.pdf', contentType: 'application/pdf', disposition: 'attachment', ttlSeconds: 120 });
      const token = tokenOf(down.url);
      const [body, sig] = token.split('.');
      expect(driver.openDownloadTicket(`${body}x.${sig}`)).toBeNull();
      expect(driver.openDownloadTicket(`${body}.${sig.slice(0, -2)}AA`)).toBeNull();
      expect(driver.openDownloadTicket('')).toBeNull();
      expect(driver.openDownloadTicket('a.b')).toBeNull();
      // Correctly signed, but not one of our encrypted tickets.
      expect(driver.openDownloadTicket(signPayload({ op: 'get', key: KEY }, 60))).toBeNull();
      expect(driver.openDownloadTicket(signPayload({ p: 'not-an-envelope' }, 60))).toBeNull();
      const expired = await driver.presignDownload(KEY, { filename: 'p.pdf', contentType: 'application/pdf', disposition: 'attachment', ttlSeconds: -5 });
      expect(driver.openDownloadTicket(tokenOf(expired.url))).toBeNull();
    });

    const ticketFor = async (key: string, size: number) =>
      driver.openUploadTicket(tokenOf((await driver.presignUpload(stagingKeyFor(key), { contentType: 'application/pdf', sizeBytes: size, ttlSeconds: 600 })).url))!;

    it('accepts an upload of exactly the declared size, once', async () => {
      const key = `${TENANT}/${'u'.repeat(32)}`;
      const ticket = await ticketFor(key, PDF.length);
      await driver.receiveUpload(ticket, Readable.from([PDF.subarray(0, 100), PDF.subarray(100)]), { contentType: 'application/pdf; charset=binary', contentLength: String(PDF.length) });
      expect((await driver.getBuffer(stagingKeyFor(key))).equals(PDF)).toBe(true);
      // Replaying the same ticket is refused, even after the object was moved away.
      await driver.move(stagingKeyFor(key), key);
      await expect(driver.receiveUpload(ticket, Readable.from([PDF]), { contentType: 'application/pdf' })).rejects.toMatchObject({ code: 'ALREADY_USED' });
      expect(await driver.head(stagingKeyFor(key))).toBeNull();
    });

    it('enforces the size while streaming and the declared content type', async () => {
      const key = `${TENANT}/${'v'.repeat(32)}`;
      const ticket = await ticketFor(key, 1000);
      let pulled = 0;
      const endless = new Readable({
        read() {
          pulled += 1;
          this.push(Buffer.alloc(400, 1));
        },
      });
      await expect(driver.receiveUpload(ticket, endless, { contentType: 'application/pdf' })).rejects.toMatchObject({ code: 'TOO_LARGE' });
      // The driver stopped consuming: the source is paused and is not drained any further.
      const pulledAtRejection = pulled;
      await new Promise((r) => setTimeout(r, 25));
      expect(pulled).toBe(pulledAtRejection);
      expect(endless.isPaused()).toBe(true);
      endless.destroy();
      await expect(driver.receiveUpload(ticket, Readable.from([Buffer.alloc(10)]), { contentType: 'application/pdf', contentLength: '5000' })).rejects.toMatchObject({ code: 'TOO_LARGE' });
      await expect(driver.receiveUpload(ticket, Readable.from([Buffer.alloc(10)]), { contentType: 'application/pdf' })).rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
      await expect(driver.receiveUpload(ticket, Readable.from([Buffer.alloc(1000)]), { contentType: 'image/png' })).rejects.toBeInstanceOf(UploadRejected);
      expect(await driver.head(stagingKeyFor(key))).toBeNull();
      // None of the failed attempts consumed the ticket.
      await driver.receiveUpload(ticket, Readable.from([Buffer.alloc(1000, 7)]), { contentType: 'application/pdf' });
      expect((await driver.head(stagingKeyFor(key)))?.sizeBytes).toBe(1000);
    });

    it('sweeps old single-use markers and temp files only', async () => {
      const markers = join(dir, '_used');
      const before = readdirSync(markers).length;
      expect(before).toBeGreaterThan(0);
      expect((await driver.sweep(3600_000)).removed).toBe(0);
      const old = new Date(Date.now() - 2 * 86400_000);
      for (const name of readdirSync(markers)) utimesSync(join(markers, name), old, old);
      expect((await driver.sweep(86400_000)).removed).toBe(before);
      expect((await driver.getBuffer(KEY)).equals(PDF)).toBe(true);
    });
  });
});

describe('S3 storage driver (offline: requests are signed / built locally, nothing is sent)', () => {
  const credentials = { accessKeyId: 'AKIAOFFLINETESTKEY00', secretAccessKey: 'offline-secret-offline-secret-0000000000' };
  const calls: Array<{ method: string; path: string; headers: Record<string, string>; query: Record<string, any> }> = [];
  let respond: (req: { method: string; path: string }) => { statusCode: number; headers?: Record<string, string>; body?: Buffer };
  const requestHandler: any = {
    metadata: { handlerProtocol: 'http/1.1' },
    async handle(request: any) {
      calls.push({ method: request.method, path: request.path, headers: request.headers, query: request.query ?? {} });
      const r = respond(request);
      return { response: { statusCode: r.statusCode, headers: r.headers ?? {}, body: Readable.from(r.body ? [r.body] : []) } };
    },
    updateHttpClientConfig() {},
    httpHandlerConfigs: () => ({}),
    destroy() {},
  };
  const aws = new S3StorageDriver({ bucket: 'typease-private-docs', region: 'me-central-1', forcePathStyle: false, credentials, requestHandler });
  const minio = new S3StorageDriver({ bucket: 'typease-private-docs', region: 'us-east-1', endpoint: 'http://minio.internal:9000', forcePathStyle: true, credentials, requestHandler });
  beforeEach(() => {
    calls.length = 0;
    respond = () => ({ statusCode: 200 });
  });

  it('presigns an upload bound to bucket, key, type, size, encryption and expiry', async () => {
    const up = await aws.presignUpload(stagingKeyFor(KEY), { contentType: 'image/png', sizeBytes: 2048, ttlSeconds: 600 });
    const url = new URL(up.url);
    expect(url.protocol).toBe('https:');
    expect(url.host).toBe('typease-private-docs.s3.me-central-1.amazonaws.com');
    expect(url.pathname).toBe(`/${stagingKeyFor(KEY)}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Credential')).toContain('/me-central-1/s3/aws4_request');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    // The store rejects the PUT unless these headers are sent exactly as signed.
    expect(url.searchParams.get('X-Amz-SignedHeaders')!.split(';').sort()).toEqual(['content-length', 'content-type', 'host', 'x-amz-server-side-encryption']);
    expect(up.method).toBe('PUT');
    expect(up.headers).toEqual({ 'Content-Type': 'image/png', 'x-amz-server-side-encryption': 'AES256' });
    // No public ACL, no checksum parameters a browser could not satisfy.
    expect(up.url).not.toMatch(/acl|public|x-amz-checksum|x-amz-sdk-checksum/i);
    expect(up.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 600_000);
    expect(calls).toHaveLength(0);
  });

  it('signs a different URL for a different size or type', async () => {
    const sig = async (contentType: string, sizeBytes: number) => new URL((await aws.presignUpload(stagingKeyFor(KEY), { contentType, sizeBytes, ttlSeconds: 600 })).url).searchParams.get('X-Amz-Signature');
    jest.useFakeTimers({ now: new Date('2026-01-15T10:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
    try {
      const base = await sig('image/png', 2048);
      expect(await sig('image/png', 2048)).toBe(base);
      expect(await sig('image/png', 2049)).not.toBe(base);
      expect(await sig('application/pdf', 2048)).not.toBe(base);
    } finally {
      jest.useRealTimers();
    }
  });

  it('presigns a short-lived download with a forced disposition and no caching', async () => {
    const down = await aws.presignDownload(KEY, { filename: 'Passport copy.pdf', contentType: 'application/pdf', disposition: 'attachment', ttlSeconds: 120 });
    const url = new URL(down.url);
    expect(url.pathname).toBe(`/${KEY}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('120');
    expect(url.searchParams.get('response-content-disposition')).toBe(`attachment; filename="Passport copy.pdf"; filename*=UTF-8''Passport%20copy.pdf`);
    expect(url.searchParams.get('response-content-type')).toBe('application/pdf');
    expect(url.searchParams.get('response-cache-control')).toBe('private, no-store');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(down.expiresAt.getTime()).toBeGreaterThan(Date.now() + 100_000);
  });

  it('supports path-style endpoints (MinIO and other S3-compatible stores)', async () => {
    const down = await minio.presignDownload(KEY, { filename: 'a.png', contentType: 'image/png', disposition: 'inline', ttlSeconds: 60 });
    const url = new URL(down.url);
    expect(url.origin).toBe('http://minio.internal:9000');
    expect(url.pathname).toBe(`/typease-private-docs/${KEY}`);
  });

  it('refuses keys that were not generated by the storage service', async () => {
    await expect(aws.presignUpload('public/index.html', { contentType: 'text/html', sizeBytes: 1, ttlSeconds: 60 })).rejects.toThrow(/Invalid storage key/);
    await expect(aws.getBuffer('../other-bucket/key')).rejects.toThrow(/Invalid storage key/);
    expect(calls).toHaveLength(0);
  });

  it('writes with server-side encryption and reads only the first bytes for sniffing', async () => {
    await aws.put(KEY, PDF, 'application/pdf');
    expect(calls[0]).toMatchObject({ method: 'PUT', path: `/${KEY}` });
    expect(calls[0].headers['x-amz-server-side-encryption']).toBe('AES256');
    expect(calls[0].headers['content-type']).toBe('application/pdf');
    expect(calls[0].headers['x-amz-acl']).toBeUndefined();

    respond = () => ({ statusCode: 206, headers: { 'content-range': 'bytes 0-15/900' }, body: PDF.subarray(0, 16) });
    const head = await aws.readHead(KEY, 16);
    expect(head.toString('latin1').startsWith('%PDF-')).toBe(true);
    expect(calls[1]).toMatchObject({ method: 'GET', path: `/${KEY}` });
    expect(calls[1].headers.range).toBe('bytes=0-15');

    respond = () => ({ statusCode: 200, headers: { 'content-length': String(PDF.length), 'content-type': 'application/pdf' }, body: PDF });
    expect((await aws.getBuffer(KEY)).equals(PDF)).toBe(true);
  });

  it('maps head / missing objects / delete / move', async () => {
    respond = () => ({ statusCode: 200, headers: { 'content-length': '900', 'content-type': 'application/pdf' } });
    expect(await aws.head(KEY)).toEqual({ sizeBytes: 900, contentType: 'application/pdf' });
    expect(calls[0].method).toBe('HEAD');

    respond = () => ({ statusCode: 404 });
    expect(await aws.head(KEY)).toBeNull();
    respond = () => ({ statusCode: 404, headers: { 'content-type': 'application/xml' }, body: Buffer.from('<Error><Code>NoSuchKey</Code><Message>gone</Message></Error>') });
    await expect(aws.getBuffer(KEY)).rejects.toBeInstanceOf(StorageObjectNotFound);

    calls.length = 0;
    respond = (req) => (req.method === 'PUT' ? { statusCode: 200, headers: { 'content-type': 'application/xml' }, body: Buffer.from('<CopyObjectResult><ETag>"x"</ETag></CopyObjectResult>') } : { statusCode: 204 });
    await aws.move(stagingKeyFor(KEY), KEY);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`PUT /${KEY}`, `DELETE /${stagingKeyFor(KEY)}`]);
    expect(calls[0].headers['x-amz-copy-source']).toBe(`typease-private-docs/${stagingKeyFor(KEY)}`);
    expect(calls[0].headers['x-amz-server-side-encryption']).toBe('AES256');
  });
});
