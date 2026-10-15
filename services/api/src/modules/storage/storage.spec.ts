import { TestApp } from '../../../test/helpers';
import { sha256 } from '../../common/crypto';
import { StorageService } from './storage.service';

const TENANT = '99999999-2222-4333-8444-555555555555';
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('integration test body '.repeat(200))]);
const pathOf = (url: string) => new URL(url).pathname;

describe('Storage: signed upload / download URLs of the local driver', () => {
  let t: TestApp;
  let storage: StorageService;
  beforeAll(async () => {
    t = await TestApp.create();
    storage = t.get(StorageService);
  });
  afterAll(() => t.close());

  it('uploads through a signed URL without authentication, then serves a short-lived download', async () => {
    const key = storage.newKey(TENANT);
    expect(key.startsWith(`${TENANT}/`)).toBe(true);
    expect(storage.newKey(TENANT)).not.toBe(key);
    const up = await storage.presignUpload(key, 'application/pdf', PDF.length);
    expect(up.url).not.toContain(key.split('/')[1]);

    const put = await t.http.put(pathOf(up.url)).set('Content-Type', 'application/pdf').send(PDF);
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ status: 'UPLOADED' });

    // The bytes land in the staging area and only become the object after promotion.
    expect(await storage.head(key)).toBeNull();
    expect(await storage.promote(key)).toEqual({ sizeBytes: PDF.length, contentType: 'application/pdf' });
    expect(await storage.promote(key)).toEqual({ sizeBytes: PDF.length, contentType: 'application/pdf' }); // repeatable
    expect(sha256(await storage.getBuffer(key))).toBe(sha256(PDF));

    const down = await storage.presignDownload(key, { filename: 'scan "1".pdf', contentType: 'application/pdf', disposition: 'attachment' });
    expect(down.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 120_000);
    const got = await t.http.get(pathOf(down.url)).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toBe('application/pdf');
    expect(got.headers['content-disposition']).toMatch(/^attachment; filename="scan _1_.pdf"/);
    expect(got.headers['cache-control']).toBe('private, no-store');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    expect(sha256(got.body)).toBe(sha256(PDF));
  });

  it('an upload URL works exactly once', async () => {
    const key = storage.newKey(TENANT);
    const up = await storage.presignUpload(key, 'application/pdf', PDF.length);
    await t.http.put(pathOf(up.url)).set('Content-Type', 'application/pdf').send(PDF).expect(200);
    await storage.promote(key);
    // Replay after the file was accepted: refused, and nothing is written.
    const replay = await t.http.put(pathOf(up.url)).set('Content-Type', 'application/pdf').send(Buffer.concat([Buffer.from('%PDF-evil'), Buffer.alloc(PDF.length - 9)]));
    expect(replay.status).toBe(403);
    expect(replay.body.code).toBe('LINK_EXPIRED');
    expect(sha256(await storage.getBuffer(key))).toBe(sha256(PDF));
  });

  it('rejects tampered and expired links with LINK_EXPIRED', async () => {
    const key = storage.newKey(TENANT);
    await storage.put(key, PDF, 'application/pdf');
    const down = await storage.presignDownload(key, { filename: 'a.pdf', contentType: 'application/pdf', disposition: 'inline' });
    const path = pathOf(down.url);
    const tampered = await t.http.get(`${path.slice(0, -3)}AAA`);
    expect(tampered.status).toBe(403);
    expect(tampered.body.code).toBe('LINK_EXPIRED');
    const garbage = await t.http.get('/api/v1/storage/local/download/not-a-token');
    expect(garbage.body.code).toBe('LINK_EXPIRED');

    const expired = await storage.presignDownload(key, { filename: 'a.pdf', contentType: 'application/pdf', disposition: 'inline', ttlSeconds: -1 });
    const late = await t.http.get(pathOf(expired.url));
    expect(late.status).toBe(403);
    expect(late.body.code).toBe('LINK_EXPIRED');

    // A download ticket cannot be used to write, and an upload ticket cannot be used to read.
    await t.http.put(path.replace('/download/', '/upload/')).set('Content-Type', 'application/pdf').send(PDF).expect(403);
    const up = await storage.presignUpload(storage.newKey(TENANT), 'application/pdf', 10);
    await t.http.get(pathOf(up.url).replace('/upload/', '/download/')).expect(403);
  });

  it('enforces the declared size and content type', async () => {
    const key = storage.newKey(TENANT);
    const up = await storage.presignUpload(key, 'application/pdf', 1000);
    const tooBig = await t.http.put(pathOf(up.url)).set('Content-Type', 'application/pdf').send(Buffer.alloc(5000, 1));
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.code).toBe('PAYLOAD_TOO_LARGE');
    const tooSmall = await t.http.put(pathOf(up.url)).set('Content-Type', 'application/pdf').send(Buffer.alloc(10, 1));
    expect(tooSmall.status).toBe(400);
    expect(tooSmall.body.code).toBe('UPLOAD_SIZE_MISMATCH');
    const wrongType = await t.http.put(pathOf(up.url)).set('Content-Type', 'image/png').send(Buffer.alloc(1000, 1));
    expect(wrongType.status).toBe(415);
    expect(await storage.promote(key)).toBeNull();
    // The link is still usable after rejected attempts.
    await t.http.put(pathOf(up.url)).set('Content-Type', 'application/pdf').send(Buffer.alloc(1000, 1)).expect(200);
  });

  it('removes staged and final objects on discard', async () => {
    const key = storage.newKey(TENANT);
    await storage.putStaged(key, PDF, 'application/pdf');
    await storage.discard(key);
    expect(await storage.promote(key)).toBeNull();
    await storage.put(key, PDF, 'application/pdf');
    await storage.discard(key);
    expect(await storage.head(key)).toBeNull();
    await storage.discard(key);
  });
});
