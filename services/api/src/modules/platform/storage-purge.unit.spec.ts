import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { randomToken } from '../../common/crypto';
import { LocalStorageDriver } from '../storage/local.driver';
import { S3StorageDriver } from '../storage/s3.driver';
import { stagingKeyFor } from '../storage/storage.types';

/** The "delete everything of one tenant" method that offboarding added to both storage drivers. */
describe('storage: delete by tenant prefix', () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const key = (tenantId: string) => `${tenantId}/${randomToken(24)}`;

  describe('local driver', () => {
    let root: string;
    let driver: LocalStorageDriver;
    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), 'typease-purge-'));
      driver = new LocalStorageDriver(root);
    });
    afterAll(() => rm(root, { recursive: true, force: true }));

    it('removes stored and staged objects of that tenant only, and can be repeated', async () => {
      const a1 = key(tenantA);
      const a2 = key(tenantA);
      const aStaged = stagingKeyFor(key(tenantA));
      const b1 = key(tenantB);
      const bStaged = stagingKeyFor(key(tenantB));
      for (const k of [a1, a2, aStaged, b1, bStaged]) await driver.put(k, Buffer.from(`content of ${k}`), 'application/pdf');

      expect(await driver.deleteTenant(tenantA)).toEqual({ removed: 3 });
      for (const k of [a1, a2, aStaged]) expect(await driver.head(k)).toBeNull();
      expect((await driver.getBuffer(b1)).toString()).toBe(`content of ${b1}`);
      expect(await driver.head(bStaged)).not.toBeNull();
      expect(await readdir(root)).not.toContain(tenantA);
      expect(await readdir(join(root, 'incoming'))).toEqual([tenantB]);
      // Idempotent.
      expect(await driver.deleteTenant(tenantA)).toEqual({ removed: 0 });
      expect(await driver.deleteTenant(randomUUID())).toEqual({ removed: 0 });
    });

    it('refuses anything that is not a tenant id (the value becomes a directory name)', async () => {
      for (const bad of ['', '..', '../..', `${tenantB}/..`, 'incoming', '*', tenantB.toUpperCase()]) {
        await expect(driver.deleteTenant(bad)).rejects.toThrow(/needs a tenant id/);
      }
      expect(await readdir(root)).toContain(tenantB);
    });
  });

  describe('s3 driver', () => {
    const calls: Array<{ method: string; path: string; query: Record<string, any> }> = [];
    let respond: (req: { method: string; path: string; query: Record<string, any> }) => { statusCode: number; body?: string };
    const requestHandler: any = {
      metadata: { handlerProtocol: 'http/1.1' },
      async handle(request: any) {
        const call = { method: request.method, path: request.path, query: request.query ?? {} };
        calls.push(call);
        const r = respond(call);
        return { response: { statusCode: r.statusCode, headers: r.body ? { 'content-type': 'application/xml' } : {}, body: Readable.from(r.body ? [Buffer.from(r.body)] : []) } };
      },
      updateHttpClientConfig() {},
      httpHandlerConfigs: () => ({}),
      destroy() {},
    };
    const driver = new S3StorageDriver({ bucket: 'typease-private-docs', region: 'us-east-1', endpoint: 'http://minio.internal:9000', forcePathStyle: true, credentials: { accessKeyId: 'AKIATEST', secretAccessKey: 'secret' }, requestHandler });
    const listing = (keys: string[], next?: string) =>
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>${next ? 'true' : 'false'}</IsTruncated>${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ''}${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}</ListBucketResult>`;
    beforeEach(() => {
      calls.length = 0;
    });

    it('lists both prefixes page by page and deletes exactly the keys it was given', async () => {
      const stored = [`${tenantA}/k1`, `${tenantA}/k2`, `${tenantA}/k3`];
      const staged = [`incoming/${tenantA}/s1`];
      respond = (req) => {
        if (req.method !== 'GET') return { statusCode: 204 };
        const prefix = String(req.query.prefix);
        if (prefix === `${tenantA}/`) return req.query['continuation-token'] ? { statusCode: 200, body: listing(stored.slice(2)) } : { statusCode: 200, body: listing(stored.slice(0, 2), 'page-2') };
        return { statusCode: 200, body: listing(staged) };
      };
      expect(await driver.deleteTenant(tenantA)).toEqual({ removed: 4 });
      const lists = calls.filter((c) => c.method === 'GET');
      expect(lists.map((c) => [c.query.prefix, c.query['continuation-token'] ?? null])).toEqual([[`${tenantA}/`, null], [`${tenantA}/`, 'page-2'], [`incoming/${tenantA}/`, null]]);
      expect(lists.map((c) => [c.path.replace(/\/$/, ''), String(c.query['list-type'])])).toEqual([['/typease-private-docs', '2'], ['/typease-private-docs', '2'], ['/typease-private-docs', '2']]);
      const deleted = calls.filter((c) => c.method === 'DELETE').map((c) => decodeURIComponent(c.path)).sort();
      expect(deleted).toEqual([...stored, ...staged].map((k) => `/typease-private-docs/${k}`).sort());
    });

    it('never deletes a key outside the tenant prefix, even if the store returns one', async () => {
      respond = (req) => (req.method === 'GET' ? { statusCode: 200, body: listing(String(req.query.prefix).startsWith('incoming/') ? [] : [`${tenantA}/mine`, `${tenantB}/not-mine`]) } : { statusCode: 204 });
      expect(await driver.deleteTenant(tenantA)).toEqual({ removed: 1 });
      expect(calls.filter((c) => c.method === 'DELETE').map((c) => decodeURIComponent(c.path))).toEqual([`/typease-private-docs/${tenantA}/mine`]);
    });

    it('does nothing for an empty tenant and refuses a value that is not a tenant id', async () => {
      respond = (req) => (req.method === 'GET' ? { statusCode: 200, body: listing([]) } : { statusCode: 204 });
      expect(await driver.deleteTenant(tenantB)).toEqual({ removed: 0 });
      expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
      calls.length = 0;
      await expect(driver.deleteTenant('')).rejects.toThrow(/needs a tenant id/);
      await expect(driver.deleteTenant('incoming')).rejects.toThrow(/needs a tenant id/);
      expect(calls).toHaveLength(0);
    });
  });
});
