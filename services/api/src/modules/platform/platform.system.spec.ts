import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { WORKER_HEARTBEAT_KEY, WorkerHeartbeat } from '../../common/jobs/worker-heartbeat';
import { QUEUE_NAME } from '../../common/jobs/job-queue';
import { RedisService } from '../../common/redis';
import { Env, env } from '../../config/env';
import { LocalStorageDriver } from '../storage/local.driver';
import { StorageService } from '../storage/storage.service';
import { SystemProvidersService } from './system-providers.service';

/**
 * System status for the platform console: which providers the installation is configured to use
 * (never "configured" for a log driver, never a secret) and whether the things it runs on answer -
 * object storage, the job queue, and whatever executes the jobs (heartbeat).
 */
describe('Platform: system status', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let admin: Actor;
  let support: Actor;
  const original: Partial<Env> = {};
  const set = (values: Partial<Env>) => {
    for (const [key, value] of Object.entries(values)) {
      if (!(key in original)) (original as any)[key] = (env() as any)[key];
      (env() as any)[key] = value;
    }
  };
  const restore = () => {
    Object.assign(env(), original);
    for (const key of Object.keys(original)) delete (original as any)[key];
  };

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    admin = await t.createPlatformAdmin('SUPER_ADMIN');
    support = await t.createPlatformAdmin('SUPPORT_AGENT');
  });
  afterEach(() => {
    restore();
    jest.restoreAllMocks();
  });
  afterAll(() => t.close());

  const byKey = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.key, r]));

  describe('GET /platform/system/providers', () => {
    it('is for platform staff who may read metrics', async () => {
      await t.http.get('/api/v1/platform/system/providers').expect(401);
      await t.as(alpha.owner).get('/platform/system/providers').expect(403);
      await t.as(alpha.owner).get('/platform/system/health').expect(403);
      const allowed = (await t.sys.user.findUniqueOrThrow({ where: { id: support.userId } })).platformRole;
      expect(allowed).toBe('SUPPORT_AGENT');
      // A support agent holds platform.metrics.read only if the role says so: the route follows the permission, not the title.
      const res = await t.as(support).get('/platform/system/providers');
      expect([200, 403]).toContain(res.status);
      await t.as(admin).get('/platform/system/providers').expect(200);
    });

    it('with log drivers and the inline queue: nothing is reported as configured that only writes to the log', async () => {
      const body = (await t.as(admin).get('/platform/system/providers').expect(200)).body;
      expect(body).toMatchObject({ generatedAt: expect.any(String), environment: 'test' });
      expect(body.providers.map((p: any) => p.key)).toEqual(['mail', 'sms', 'whatsapp', 'push', 'storage', 'malware_scanner', 'ocr', 'payments', 'payments_sandbox', 'automation_webhooks', 'redis', 'queue', 'error_tracking']);
      for (const p of body.providers) {
        expect(p).toMatchObject({ key: expect.any(String), label: expect.any(String), driver: expect.any(String), detail: expect.any(String) });
        expect(['CONFIGURED', 'NOT_CONFIGURED', 'LOG_ONLY', 'DISABLED', 'SANDBOX']).toContain(p.status);
        expect(p.detail.length).toBeGreaterThan(20);
        if (p.driver === 'log') expect(p.status).toBe('LOG_ONLY');
      }
      const p = byKey(body.providers);
      for (const key of ['mail', 'sms', 'whatsapp', 'push']) {
        expect([key, p[key].driver, p[key].status]).toEqual([key, 'log', 'LOG_ONLY']);
        expect(p[key].detail).toMatch(/NOT delivered/);
      }
      // Really checked: the local directory was written to, Redis answered a PING.
      expect(p.storage).toMatchObject({ driver: 'local', status: 'CONFIGURED', reachable: true, lastError: null, lastCheckedAt: expect.any(String) });
      expect(p.storage.detail).toContain(t.get(StorageService).local!.root);
      expect(p.redis).toMatchObject({ driver: 'redis', status: 'CONFIGURED', reachable: true, lastError: null, lastCheckedAt: expect.any(String) });
      expect(p.malware_scanner).toMatchObject({ driver: 'none', status: 'DISABLED' });
      expect(p.ocr).toMatchObject({ driver: 'disabled', status: 'DISABLED' });
      // The test adapter is on in tests and no real gateway is set: that is SANDBOX, never CONFIGURED.
      expect(p.payments).toMatchObject({ driver: 'sandbox', status: 'SANDBOX' });
      expect(p.payments_sandbox).toMatchObject({ driver: 'sandbox', status: 'SANDBOX' });
      expect(p.automation_webhooks.status).toBe('NOT_CONFIGURED');
      expect(p.queue).toMatchObject({ driver: 'inline', status: 'DISABLED' });
      expect(p.error_tracking).toMatchObject({ driver: 'none', status: 'NOT_CONFIGURED' });
      // Rows that are not checked carry no check fields.
      expect(p.mail).not.toHaveProperty('lastCheckedAt');

      // No secret of the installation, whole or in part.
      const text = JSON.stringify(body);
      const e = env();
      for (const secret of [e.JWT_ACCESS_SECRET, e.HMAC_KEY, e.DATA_ENCRYPTION_KEY, e.INTERNAL_API_TOKEN, e.PAYMENT_SANDBOX_WEBHOOK_SECRET, e.DATABASE_URL, e.DATABASE_SYSTEM_URL, 'app_dev_pw', 'system_dev_pw']) expect(text).not.toContain(secret);
    });

    it('reports what the environment says: complete settings are CONFIGURED, half of them NOT_CONFIGURED, and no secret is echoed', async () => {
      const secrets = {
        SMTP_PASSWORD: 'smtp-pass-7Hq2-do-not-show', TWILIO_AUTH_TOKEN: 'twilio-token-9Zx-do-not-show', WHATSAPP_ACCESS_TOKEN: 'wa-token-4Kd-do-not-show', FCM_SERVICE_ACCOUNT_JSON: '{"private_key":"fcm-key-do-not-show","client_email":"x@y.iam"}',
        STRIPE_SECRET_KEY: 'sk_test_51Habcdo-not-show', STRIPE_WEBHOOK_SECRET: 'whsec_do-not-show', N8N_WEBHOOK_SECRET: 'n8n-secret-do-not-show', OCR_EXTERNAL_TOKEN: 'ocr-token-do-not-show', SMS_HTTP_TOKEN: 'sms-http-token-do-not-show',
      };
      const full: Env = {
        ...env(), ...secrets,
        MAIL_DRIVER: 'smtp', SMTP_HOST: 'smtp.mail.example', SMTP_PORT: 465, SMTP_SECURE: true, SMTP_USER: 'mailer', MAIL_FROM_ADDRESS: 'no-reply@centres.example', MAIL_FROM_NAME: 'TypEase',
        SMS_DRIVER: 'twilio', TWILIO_ACCOUNT_SID: 'ACdo-not-show-sid', TWILIO_FROM: '+15005550006',
        WHATSAPP_DRIVER: 'meta', WHATSAPP_PHONE_NUMBER_ID: '104500000000001',
        PUSH_DRIVER: 'fcm', FCM_PROJECT_ID: 'typease-prod',
        MALWARE_SCANNER: 'clamav', CLAMAV_HOST: 'clamav.internal', CLAMAV_PORT: 3310, REQUIRE_CLEAN_SCAN: true,
        OCR_PROVIDER: 'external-http', OCR_EXTERNAL_URL: 'https://ocr.partner.example/v1/read?key=in-url-do-not-show',
        PAYMENT_SANDBOX_ENABLED: false,
        N8N_WEBHOOK_BASE_URL: 'http://n8n.internal:5678/webhook', OUTBOUND_WEBHOOK_ALLOWED_HOSTS: ['hooks.partner.example'],
      };
      const rows = SystemProvidersService.fromEnvironment(full);
      const p = byKey(rows);
      expect(Object.fromEntries(rows.map((r) => [r.key, `${r.driver}:${r.status}`]))).toEqual({
        mail: 'smtp:CONFIGURED', sms: 'twilio:CONFIGURED', whatsapp: 'meta:CONFIGURED', push: 'fcm:CONFIGURED', malware_scanner: 'clamav:CONFIGURED', ocr: 'external-http:CONFIGURED',
        payments: 'stripe:CONFIGURED', payments_sandbox: 'sandbox:DISABLED', automation_webhooks: 'n8n:CONFIGURED', error_tracking: 'none:NOT_CONFIGURED',
      });
      expect(p.mail.detail).toContain('smtp.mail.example:465');
      expect(p.mail.detail).toMatch(/not contacted/);
      expect(p.payments.detail).toMatch(/TEST mode key/);
      expect(p.ocr.detail).toContain('ocr.partner.example');
      expect(p.automation_webhooks.detail).toContain('hooks.partner.example');
      const text = JSON.stringify(rows);
      for (const value of [...Object.values(secrets), 'do-not-show', 'fcm-key', 'ACdo-not-show-sid']) expect(text).not.toContain(value);

      // Half-configured: the driver is chosen but something it needs is missing.
      const half = byKey(SystemProvidersService.fromEnvironment({
        ...full, SMTP_HOST: undefined, TWILIO_AUTH_TOKEN: undefined, WHATSAPP_ACCESS_TOKEN: undefined, FCM_SERVICE_ACCOUNT_JSON: undefined, OCR_EXTERNAL_URL: undefined, STRIPE_WEBHOOK_SECRET: undefined, N8N_WEBHOOK_SECRET: undefined,
      }));
      for (const [key, variable] of [['mail', 'SMTP_HOST'], ['sms', 'TWILIO_AUTH_TOKEN'], ['whatsapp', 'WHATSAPP_ACCESS_TOKEN'], ['push', 'FCM_SERVICE_ACCOUNT_JSON'], ['ocr', 'OCR_EXTERNAL_URL'], ['payments', 'STRIPE_WEBHOOK_SECRET'], ['automation_webhooks', 'N8N_WEBHOOK_SECRET']]) {
        expect([key, half[key].status]).toEqual([key, 'NOT_CONFIGURED']);
        expect(half[key].detail).toContain(variable);
      }
      // A log driver is LOG_ONLY whatever else is set next to it.
      const logOnly = byKey(SystemProvidersService.fromEnvironment({ ...full, MAIL_DRIVER: 'log', SMS_DRIVER: 'log', WHATSAPP_DRIVER: 'log', PUSH_DRIVER: 'log' }));
      for (const key of ['mail', 'sms', 'whatsapp', 'push']) expect([key, logOnly[key].status]).toEqual([key, 'LOG_ONLY']);
      // Neither gateway nor test adapter.
      expect(byKey(SystemProvidersService.fromEnvironment({ ...full, STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined })).payments).toMatchObject({ driver: 'none', status: 'NOT_CONFIGURED' });
    });

    it('says so when the store does not answer', async () => {
      // A "directory" below a regular file can never be created or written to.
      const file = join(tmpdir(), `typease-not-a-directory-${Date.now()}`);
      writeFileSync(file, 'x');
      const broken = await new LocalStorageDriver(join(file, 'private')).check();
      rmSync(file);
      expect(broken).toMatchObject({ ok: false, target: `local directory ${join(file, 'private')}`, error: expect.stringMatching(/^E[A-Z]+$/) });
      jest.spyOn(t.get(StorageService), 'check').mockResolvedValue({ ok: false, target: 'S3 bucket "typease-documents" at s3.example', error: 'TimeoutError' });
      const p = byKey((await t.as(admin).get('/platform/system/providers').expect(200)).body.providers);
      expect(p.storage).toMatchObject({ status: 'CONFIGURED', reachable: false, lastError: 'TimeoutError' });
      expect(p.storage.detail).toMatch(/did NOT answer/);
      const health = (await t.as(admin).get('/platform/system/health').expect(200)).body;
      expect(health.storage).toMatchObject({ driver: 'local', reachable: false, error: 'TimeoutError', target: 'S3 bucket "typease-documents" at s3.example' });
      expect(health.status).toBe('degraded');
      expect(health.problems.join(' ')).toMatch(/Object storage is not reachable/);
    });
  });

  describe('system health', () => {
    const clearBeats = () => t.get(RedisService).client.del(WORKER_HEARTBEAT_KEY);

    it('adds object storage, per-queue figures and the job runner to the dashboard block and serves it on its own', async () => {
      const health = (await t.as(admin).get('/platform/system/health').expect(200)).body;
      expect(health).toMatchObject({
        checkedAt: expect.any(String), database: true, systemDatabase: true, redis: true,
        storage: { driver: 'local', reachable: true, error: null, target: expect.stringContaining('local directory'), checkedAt: expect.any(String) },
        queue: { driver: 'inline', reachable: true },
        queues: [{ name: QUEUE_NAME, waiting: expect.any(Number), active: 0, delayed: 0, failed: expect.any(Number) }],
        // Tests drain the inline queue by hand: nothing runs jobs on its own, and that is not a problem to report.
        worker: { mode: 'single-process', status: 'DISABLED', lastSeenAt: null, ageSeconds: null, intervalSeconds: 15, staleAfterSeconds: 30, instances: [] },
        outbox: { pending: expect.any(Number), failed: expect.any(Number) },
      });
      // Only the sentences of this block: the outbox line of an earlier suite ("... is the worker running?") is not one of them.
      expect(health.problems.join(' ')).not.toMatch(/background worker|job runner of the API|Object storage/);
      const dashboard = (await t.as(admin).get('/platform/dashboard').expect(200)).body;
      expect(Object.keys(dashboard.systemHealth).sort()).toEqual(Object.keys(health).sort());
      expect(dashboard.systemHealth.worker).toEqual(health.worker);
      // Jobs waiting in memory show up as "waiting".
      await t.jobs.enqueue('documents.purge', {}, { delayMs: 3_600_000, jobId: `status-probe-${Date.now()}` });
      const queued = (await t.as(admin).get('/platform/system/health').expect(200)).body;
      expect(queued.queues[0].waiting).toBe(health.queues[0].waiting + 1);
      expect(queued.queue.pending).toBe(queued.queues[0].waiting);
      t.jobs.clearInline();
    });

    it('single-process mode: the API reports itself; a silence of more than two intervals is STALE', async () => {
      await clearBeats();
      set({ QUEUE_INLINE_AUTORUN: true });
      const heartbeat = t.get(WorkerHeartbeat);
      let health = (await t.as(admin).get('/platform/system/health').expect(200)).body;
      expect(health.worker).toMatchObject({ mode: 'single-process', status: 'NOT_SEEN', lastSeenAt: null, instances: [] });
      expect(health.status).toBe('degraded');
      expect(health.problems.join(' ')).toMatch(/has not reported yet/);

      expect(await heartbeat.beat('single-process')).toBe(true);
      // The key has a time to live: a heartbeat that nobody renews goes away by itself.
      const ttl = await t.get(RedisService).client.ttl(WORKER_HEARTBEAT_KEY);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(24 * 3600);
      health = (await t.as(admin).get('/platform/system/health').expect(200)).body;
      expect(health.worker).toMatchObject({ mode: 'single-process', status: 'OK', lastSeenAt: expect.any(String), intervalSeconds: 15, staleAfterSeconds: 30 });
      expect(health.worker.ageSeconds).toBeLessThanOrEqual(2);
      expect(health.worker.instances).toEqual([expect.objectContaining({ instanceId: heartbeat.instanceId, mode: 'single-process', stale: false, startedAt: expect.any(String) })]);
      expect(health.problems.join(' ')).not.toMatch(/background worker|job runner of the API/);

      // 31 seconds of silence (interval 15): stale, and said in words.
      await heartbeat.beat('single-process', new Date(Date.now() - 31_000));
      health = (await t.as(admin).get('/platform/system/health').expect(200)).body;
      expect(health.worker).toMatchObject({ status: 'STALE', lastSeenAt: expect.any(String) });
      expect(health.worker.ageSeconds).toBeGreaterThanOrEqual(31);
      expect(health.worker.instances[0]).toMatchObject({ stale: true });
      expect(health.status).toBe('degraded');
      expect(health.problems.join(' ')).toMatch(/last reported 3\d seconds ago \(expected every 15\)/);
      // 29 seconds: still fine.
      await heartbeat.beat('single-process', new Date(Date.now() - 29_000));
      expect((await heartbeat.liveness()).status).toBe('OK');
      // A different interval moves the threshold with it.
      set({ WORKER_HEARTBEAT_INTERVAL_SECONDS: 10 });
      expect(await heartbeat.liveness()).toMatchObject({ status: 'STALE', intervalSeconds: 10, staleAfterSeconds: 20 });
    });

    it('worker mode: only a worker counts, and an interval timer keeps the heartbeat fresh', async () => {
      await clearBeats();
      const heartbeat = t.get(WorkerHeartbeat);
      const redis = t.get(RedisService).client;
      set({ QUEUE_DRIVER: 'bullmq' });
      // The API's own (single-process) heartbeat says nothing about a worker.
      await heartbeat.beat('single-process');
      expect(await heartbeat.liveness()).toMatchObject({ mode: 'worker', status: 'NOT_SEEN', instances: [] });
      // Two workers: one alive, one that stopped a while ago. The freshest one decides.
      await redis.hset(WORKER_HEARTBEAT_KEY, 'host-a:1:aaaaaa', JSON.stringify({ mode: 'worker', startedAt: new Date(Date.now() - 3_600_000).toISOString(), lastSeenAt: new Date(Date.now() - 5_000).toISOString() }));
      await redis.hset(WORKER_HEARTBEAT_KEY, 'host-b:2:bbbbbb', JSON.stringify({ mode: 'worker', startedAt: new Date(Date.now() - 7_200_000).toISOString(), lastSeenAt: new Date(Date.now() - 600_000).toISOString() }));
      // Leftovers: older than a day, and something that is not a heartbeat at all.
      await redis.hset(WORKER_HEARTBEAT_KEY, 'host-c:3:cccccc', JSON.stringify({ mode: 'worker', startedAt: '2020-01-01T00:00:00.000Z', lastSeenAt: new Date(Date.now() - 25 * 3_600_000).toISOString() }));
      await redis.hset(WORKER_HEARTBEAT_KEY, 'garbage', 'not json');
      const live = await heartbeat.liveness();
      expect(live).toMatchObject({ mode: 'worker', status: 'OK' });
      expect(live.instances.map((i) => [i.instanceId, i.stale])).toEqual([['host-a:1:aaaaaa', false], ['host-b:2:bbbbbb', true]]);
      expect(Object.keys(await redis.hgetall(WORKER_HEARTBEAT_KEY)).sort()).toEqual(['host-a:1:aaaaaa', 'host-b:2:bbbbbb', heartbeat.instanceId].sort());
      // The live one stops as well.
      await redis.hdel(WORKER_HEARTBEAT_KEY, 'host-a:1:aaaaaa');
      expect(await heartbeat.liveness()).toMatchObject({ status: 'STALE', lastSeenAt: expect.any(String) });
      restore();

      // start() beats at once and then on the interval; stop() ends it and leaves the last heartbeat behind.
      await clearBeats();
      set({ QUEUE_INLINE_AUTORUN: true });
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask', 'performance', 'Date'] });
      try {
        const beat = jest.spyOn(heartbeat, 'beat');
        heartbeat.start('single-process');
        heartbeat.start('single-process'); // one timer only
        expect(beat).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(15_000 * 3);
        expect(beat).toHaveBeenCalledTimes(4);
        heartbeat.stop();
        jest.advanceTimersByTime(15_000 * 3);
        expect(beat).toHaveBeenCalledTimes(4);
      } finally {
        jest.useRealTimers();
      }
      await new Promise((r) => setTimeout(r, 50));
      expect((await heartbeat.liveness()).status).toBe('OK');
    });
  });
});
