import './worker-env.fixtures';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Actor, TenantFixture, TestApp, uniq } from '../../../test/helpers';
import { ctx } from '../../common/context';
import { TenantDb } from '../../common/db/prisma.service';
import { DomainEvents } from '../../common/events.service';
import { JobMeta, JobQueue, QUEUE_NAME } from '../../common/jobs/job-queue';
import { WorkerHeartbeat } from '../../common/jobs/worker-heartbeat';
import { env } from '../../config/env';
import { installSignalHandlers, queueClientOf, repeatOptions, RunningWorker, schedulerId, startWorker, syncSchedulers } from '../../worker';
import { pdfBytes } from '../documents/fixtures';
import { createCustomer } from '../finance/fixtures';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await sleep(40);
  }
}
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });

/**
 * The background worker against the REAL BullMQ driver on the private Redis
 * database: the API process enqueues, a separately booted worker (its own Nest
 * application context, like in production) executes.
 */
describe('Background worker (real BullMQ queue)', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let admin: Actor;
  let running: RunningWorker;
  let workerJobs: JobQueue;
  let setup: Redis;
  let inspect: Queue;

  beforeAll(async () => {
    expect(env().QUEUE_DRIVER).toBe('bullmq');
    // Only this queue's keys are touched, never the whole Redis database.
    setup = new Redis(env().REDIS_URL, { maxRetriesPerRequest: null });
    inspect = new Queue(QUEUE_NAME, { connection: setup });
    await inspect.obliterate({ force: true });
    // A scheduler left behind by an older release: the worker must remove it.
    await inspect.upsertJobScheduler(schedulerId('retired.job'), { every: 3_600_000 }, { name: 'retired.job', data: {} });

    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    admin = await t.createPlatformAdmin('SUPER_ADMIN');
    running = await startWorker({ healthPort: 0, handleSignals: false, outboxIntervalMs: 250, concurrency: 4, shutdownTimeoutMs: 15_000 });
    workerJobs = running.app.get(JobQueue);
  }, 120_000);

  afterAll(async () => {
    await running?.stop('test finished');
    await inspect.obliterate({ force: true }).catch(() => undefined);
    await inspect.close();
    await setup.quit().catch(() => undefined);
    // The API side enqueued through JobQueue as well: close the connection BullMQ leaves open.
    const apiQueueClient = await queueClientOf(t.jobs);
    await t.close();
    apiQueueClient?.disconnect();
  }, 60_000);

  it('refuses to start without the BullMQ driver', async () => {
    (env() as any).QUEUE_DRIVER = 'inline';
    try {
      await expect(startWorker({ healthPort: false, handleSignals: false })).rejects.toThrow(/QUEUE_DRIVER=bullmq/);
    } finally {
      (env() as any).QUEUE_DRIVER = 'bullmq';
    }
    process.env.WORKER_CONCURRENCY = 'many';
    try {
      await expect(startWorker({ healthPort: false, handleSignals: false })).rejects.toThrow(/WORKER_CONCURRENCY must be a whole number/);
    } finally {
      delete process.env.WORKER_CONCURRENCY;
    }
  });

  it('registers every declared schedule as a BullMQ job scheduler and removes stale ones', async () => {
    const declared = workerJobs.schedules();
    expect(declared.length).toBeGreaterThanOrEqual(6);
    const schedulers = await running.queue.getJobSchedulers(0, -1);
    const byId = new Map(schedulers.map((s) => [s.key, s]));
    expect([...byId.keys()].sort()).toEqual(declared.map((s) => schedulerId(s.name)).sort());
    expect(byId.has(schedulerId('retired.job'))).toBe(false);
    for (const schedule of declared) {
      const scheduler = byId.get(schedulerId(schedule.name))!;
      expect(scheduler.name).toBe(schedule.name);
      if (schedule.everySeconds) expect([schedule.name, scheduler.every]).toEqual([schedule.name, schedule.everySeconds * 1000]);
      else expect([schedule.name, scheduler.pattern, scheduler.tz]).toEqual([schedule.name, schedule.cron, 'UTC']);
      // Each one has a handler, or the scheduled job could never run.
      expect(workerJobs.names()).toContain(schedule.name);
    }
    // The jobs of this workstream.
    expect(byId.get(schedulerId('platform.offboarding'))).toMatchObject({ pattern: '40 2 * * *', tz: 'UTC' });
    expect(byId.get(schedulerId('platform.access_grants_expiry'))).toMatchObject({ every: 60_000 });
    expect(byId.get(schedulerId('integrations.authorisation_expiry'))).toMatchObject({ pattern: '20 1 * * *' });
    expect((await running.health()).schedulers).toBe(declared.length);
    expect(repeatOptions({ name: 'x', everySeconds: 30, description: '' })).toEqual({ every: 30_000 });
    expect(repeatOptions({ name: 'x', cron: '0 2 * * *', description: '' })).toEqual({ pattern: '0 2 * * *', tz: 'UTC' });
  });

  it('a scheduler really produces jobs that the worker runs; removing the schedule stops them', async () => {
    const ticks: Array<{ attempt: number; tenantId: string | undefined }> = [];
    workerJobs.register('test.tick', async (_payload: unknown, meta: JobMeta) => void ticks.push({ attempt: meta.attempt, tenantId: ctx().tenantId }));
    const declared = workerJobs.schedules();
    const synced = await syncSchedulers(running.queue, [...declared, { name: 'test.tick', everySeconds: 1, description: 'test' }]);
    expect(synced.registered).toContain(schedulerId('test.tick'));
    expect(synced.removed).toEqual([]);
    await until('two scheduled runs', () => ticks.length >= 2, 10_000);
    // Scheduled jobs run once per tick (no retries) and without a tenant.
    expect(ticks.every((x) => x.attempt === 1 && x.tenantId === undefined)).toBe(true);
    const again = await syncSchedulers(running.queue, declared);
    expect(again.removed).toEqual([schedulerId('test.tick')]);
    expect((await running.queue.getJobSchedulers(0, -1)).map((s) => s.key)).not.toContain(schedulerId('test.tick'));
    await sleep(1300);
    const settled = ticks.length;
    await sleep(1500);
    expect(ticks.length).toBe(settled);
  });

  it('runs a job enqueued by the API inside the right tenant (row-level security applies)', async () => {
    const seen: Array<{ marker: string; tenantId?: string; actorType: string; actorLabel?: string; branchTenants: string[]; attempt: number; maxAttempts: number; jobId?: string }> = [];
    workerJobs.register('test.context', async (payload: { marker: string }, meta: JobMeta) => {
      const c = ctx();
      // An unfiltered query: only row-level security limits what comes back.
      const branches = c.tenantId ? await running.app.get(TenantDb).tx((tx) => tx.branch.findMany({ select: { tenantId: true } })) : [];
      seen.push({ marker: payload.marker, tenantId: c.tenantId, actorType: c.actorType, actorLabel: c.actorLabel, branchTenants: [...new Set(branches.map((b) => b.tenantId))], ...meta });
    });
    // The handler exists only in the worker process: the API side merely puts jobs on the queue.
    expect(t.jobs.names()).not.toContain('test.context');
    const marker = uniq();
    await t.jobs.enqueue('test.context', { tenantId: alpha.id, marker: `${marker}-alpha` }, { attempts: 2, backoffMs: 100 });
    await t.jobs.enqueue('test.context', { tenantId: beta.id, marker: `${marker}-beta` });
    await t.jobs.enqueue<{ tenantId?: string; marker: string }>('test.context', { marker: `${marker}-system` });
    // The same job id twice is one job.
    await t.jobs.enqueue('test.context', { tenantId: alpha.id, marker: `${marker}-once` }, { jobId: `once-${marker}` });
    await t.jobs.enqueue('test.context', { tenantId: alpha.id, marker: `${marker}-once` }, { jobId: `once-${marker}` });
    await until('all four jobs', () => seen.filter((s) => s.marker.startsWith(marker)).length >= 4);
    await sleep(300);
    const mine = seen.filter((s) => s.marker.startsWith(marker));
    expect(mine).toHaveLength(4);
    const a = mine.find((s) => s.marker.endsWith('-alpha'))!;
    expect(a).toMatchObject({ tenantId: alpha.id, actorType: 'SYSTEM', actorLabel: 'job:test.context', branchTenants: [alpha.id], attempt: 1, maxAttempts: 2 });
    expect(a.jobId).toBeTruthy();
    expect(mine.find((s) => s.marker.endsWith('-beta'))).toMatchObject({ tenantId: beta.id, branchTenants: [beta.id], maxAttempts: 5 });
    expect(mine.find((s) => s.marker.endsWith('-system'))).toMatchObject({ tenantId: undefined, actorType: 'SYSTEM', branchTenants: [] });
    expect(mine.find((s) => s.marker.endsWith('-once'))).toMatchObject({ jobId: `once-${marker}` });
  });

  it('runs real module jobs: an uploaded document is scanned by the worker, not by the API', async () => {
    const customer = await createCustomer(t, alpha);
    const upload = await t.as(alpha.owner).upload('/documents/upload', 'file', pdfBytes(), 'passport.pdf', { customerId: customer.id, documentTypeKey: 'passport', title: 'Passport copy' });
    expect(upload.status).toBe(201);
    expect(upload.body.status).toBe('PENDING_SCAN');
    // Nothing is pending in the API process: the job went to Redis.
    expect(t.jobs.pendingCount()).toBe(0);
    const version = await until('the scan verdict', async () => {
      const v = await t.sys.documentVersion.findFirstOrThrow({ where: { documentId: upload.body.documentId } });
      return v.scanStatus !== 'PENDING' ? v : null;
    });
    expect(version.scannedAt).toBeTruthy();
    expect((await t.sys.document.findUniqueOrThrow({ where: { id: upload.body.documentId } })).status).toBe('AVAILABLE');
  });

  it('retries a failing job with exponential backoff, then leaves it in the failed set', async () => {
    const attempts: Array<{ at: number; attempt: number; maxAttempts: number }> = [];
    workerJobs.register('test.fail', async (_p: unknown, meta: JobMeta) => {
      attempts.push({ at: Date.now(), ...meta });
      throw new Error('boom: provider unavailable');
    });
    let flaky = 0;
    workerJobs.register('test.flaky', async () => {
      flaky += 1;
      if (flaky === 1) throw new Error('first attempt fails');
    });
    const before = await running.health();
    await t.jobs.enqueue('test.fail', { tenantId: alpha.id }, { attempts: 3, backoffMs: 300 });
    await t.jobs.enqueue('test.flaky', {}, { attempts: 3, backoffMs: 100 });

    const dead = await until('the job to reach the failed set', async () => (await running.queue.getFailed()).find((j) => j.name === 'test.fail'), 20_000);
    expect(attempts.map((a) => [a.attempt, a.maxAttempts])).toEqual([[1, 3], [2, 3], [3, 3]]);
    // Backoff: 300 ms before the second attempt, 600 ms before the third (allowing for timer slack).
    expect(attempts[1].at - attempts[0].at).toBeGreaterThanOrEqual(280);
    expect(attempts[2].at - attempts[1].at).toBeGreaterThanOrEqual(560);
    expect(attempts[2].at - attempts[1].at).toBeGreaterThan(attempts[1].at - attempts[0].at);
    expect(dead).toMatchObject({ name: 'test.fail', attemptsMade: 3, failedReason: 'boom: provider unavailable', data: { tenantId: alpha.id } });
    // It is not retried any further.
    await sleep(900);
    expect(attempts).toHaveLength(3);
    // A job that fails once and then succeeds is not a dead letter.
    await until('the flaky job to succeed', () => flaky === 2);
    expect((await running.queue.getFailed()).map((j) => j.name)).not.toContain('test.flaky');

    const after = await running.health();
    // test.fail: two retries and one final failure; test.flaky: one retry.
    expect(after.jobs.failed - before.jobs.failed).toBeGreaterThanOrEqual(1);
    expect(after.jobs.retried - before.jobs.retried).toBeGreaterThanOrEqual(3);
    expect(after.jobs).toMatchObject({ lastFailedJob: expect.any(String) });
    expect(after.queue!.failed).toBeGreaterThanOrEqual(1);
    // The platform console and the metrics endpoint (API process) see the same dead letter.
    const dashboard = await t.as(admin).get('/platform/dashboard').expect(200);
    expect(dashboard.body.systemHealth.queue).toMatchObject({ driver: 'bullmq', reachable: true });
    expect(dashboard.body.systemHealth.queue.failed).toBeGreaterThanOrEqual(1);
    expect(dashboard.body.systemHealth.status).toBe('degraded');
    expect(dashboard.body.systemHealth.problems.join(' ')).toMatch(/background jobs failed/);
    const metrics = await t.http.get('/api/v1/internal/metrics').set('x-internal-token', env().INTERNAL_API_TOKEN).expect(200);
    expect(metrics.text).toContain('typease_queue_up{driver="bullmq"} 1');
    expect(Number(metrics.text.match(/^typease_queue_jobs\{state="failed"\} (\d+)$/m)![1])).toBeGreaterThanOrEqual(1);
  });

  it('delivers a domain event emitted in an API request to subscribers in the worker', async () => {
    const delivered: Array<{ type: string; tenantId: string | null; ctxTenant?: string; actorType: string; payload: any }> = [];
    running.app.get(DomainEvents).subscribe('worker-test', ['customer.created'], async (event) => void delivered.push({ type: event.type, tenantId: event.tenantId, ctxTenant: ctx().tenantId, actorType: ctx().actorType, payload: event.payload }));

    const created = await t.as(alpha.owner).post('/customers', { fullName: 'Worker Event Customer' }).expect(201);
    const mine = await until('the subscriber in the worker', () => delivered.find((d) => d.payload.customerId === created.body.id));
    expect(mine).toMatchObject({ type: 'customer.created', tenantId: alpha.id, ctxTenant: alpha.id, actorType: 'AUTOMATION' });
    const row = await until('the outbox row to be marked', async () => {
      const r = await t.sys.outboxEvent.findFirstOrThrow({ where: { tenantId: alpha.id, type: 'customer.created', payload: { path: ['customerId'], equals: created.body.id } } });
      return r.status === 'PROCESSED' ? r : null;
    });
    expect(row.processedAt).toBeTruthy();

    // The safety net: an event for which no dispatch job was ever enqueued (as after a Redis outage)
    // is still picked up by the worker's outbox interval.
    const orphanId = (await createCustomer(t, beta)).id;
    const orphan = await t.sys.outboxEvent.create({ data: { tenantId: beta.id, type: 'customer.created', payload: { customerId: orphanId, source: 'TEST' } } });
    await until('the orphaned event', () => delivered.find((d) => d.payload.customerId === orphanId), 10_000);
    expect(delivered.find((d) => d.payload.customerId === orphanId)).toMatchObject({ tenantId: beta.id, ctxTenant: beta.id });
    await until('the orphan to be marked', async () => (await t.sys.outboxEvent.findUniqueOrThrow({ where: { id: orphan.id } })).status === 'PROCESSED');
    expect((await running.health()).outbox).toMatchObject({ lastError: null, lastRunAt: expect.any(String) });
  });

  it('answers its health endpoint', async () => {
    expect(running.healthPort).toBeGreaterThan(0);
    const base = `http://127.0.0.1:${running.healthPort}`;
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ status: 'ok', service: 'typease-worker', redis: true, database: true, running: true, concurrency: 4 });
    expect(body.jobs.processed).toBeGreaterThan(3);
    expect(Date.parse(body.jobs.lastCompletedAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(Date.parse(body.jobs.lastStartedAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(Date.parse(body.outbox.lastRunAt)).toBeGreaterThan(Date.now() - 5_000);
    expect(body.queue).toEqual({ waiting: expect.any(Number), active: expect.any(Number), delayed: expect.any(Number), failed: expect.any(Number) });
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(await (await fetch(`${base}/health/ready`)).json()).toMatchObject({ status: 'ok' });
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    expect((await fetch(`${base}/anything-else`)).status).toBe(404);
    expect((await fetch(`${base}/health`, { method: 'POST' })).status).toBe(405);
    // Nothing about tenants, jobs' payloads or configuration is exposed.
    expect(JSON.stringify(body)).not.toMatch(/tenantId|DATABASE_URL|redis:\/\/|password|secret/i);
  });

  it('reports that it is alive: the platform sees a worker heartbeat, the queue figures and the driver', async () => {
    const workerBeat = running.app.get(WorkerHeartbeat);
    // Written by the worker process on start; read by the API from Redis.
    const live = await until('the worker heartbeat', async () => {
      const l = await t.get(WorkerHeartbeat).liveness();
      return l.status === 'OK' ? l : null;
    });
    expect(live).toMatchObject({ mode: 'worker', status: 'OK', intervalSeconds: 15, staleAfterSeconds: 30 });
    expect(live.instances.find((i) => i.instanceId === workerBeat.instanceId)).toMatchObject({ mode: 'worker', stale: false });
    // The API process itself is not a worker and does not claim to be one.
    expect(live.instances.find((i) => i.instanceId === t.get(WorkerHeartbeat).instanceId)).toBeUndefined();

    const health = (await t.as(admin).get('/platform/system/health').expect(200)).body;
    expect(health).toMatchObject({
      redis: true, storage: { reachable: true },
      queue: { driver: 'bullmq', reachable: true },
      queues: [{ name: QUEUE_NAME, waiting: expect.any(Number), active: expect.any(Number), delayed: expect.any(Number), failed: expect.any(Number) }],
      worker: { mode: 'worker', status: 'OK', lastSeenAt: expect.any(String) },
    });
    expect(health.problems.join(' ')).not.toMatch(/No background worker|last reported/);
    const providers = (await t.as(admin).get('/platform/system/providers').expect(200)).body.providers;
    expect(providers.find((p: any) => p.key === 'queue')).toMatchObject({ driver: 'bullmq', status: 'CONFIGURED' });
  });

  it('wires SIGTERM and SIGINT to one graceful stop', async () => {
    const proc = new EventEmitter();
    const calls: string[] = [];
    const exits: number[] = [];
    let release!: () => void;
    const remove = installSignalHandlers(
      (reason) => {
        calls.push(reason);
        return new Promise<void>((resolve) => (release = resolve));
      },
      proc as any,
      (code) => void exits.push(code),
    );
    proc.emit('SIGTERM');
    proc.emit('SIGTERM');
    proc.emit('SIGINT');
    expect(calls).toEqual(['SIGTERM']); // a second signal does not start a second shutdown
    expect(exits).toEqual([]); // not before the stop has finished
    release();
    await sleep(10);
    expect(exits).toEqual([0]);
    remove();
    expect(proc.listenerCount('SIGTERM') + proc.listenerCount('SIGINT')).toBe(0);

    const failing = new EventEmitter();
    const codes: number[] = [];
    installSignalHandlers(() => Promise.reject(new Error('close failed')), failing as any, (code) => void codes.push(code));
    failing.emit('SIGINT');
    await sleep(10);
    expect(codes).toEqual([1]);
  });

  it('shuts down gracefully: running jobs finish, no new jobs are taken, connections close', async () => {
    let started = false;
    let finished = false;
    workerJobs.register('test.slow', async () => {
      started = true;
      await sleep(1500);
      finished = true;
    });
    const late: string[] = [];
    workerJobs.register('test.late', async (payload: { marker: string }) => void late.push(payload.marker));
    await t.jobs.enqueue('test.slow', {}, { attempts: 1 });
    await until('the slow job to start', () => started);

    const port = running.healthPort!;
    const stopping = running.stop('test');
    // While it is shutting down the health endpoint says so, and new work stays on the queue.
    const during = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.status, () => 0);
    expect([503, 0]).toContain(during);
    const marker = uniq();
    await t.jobs.enqueue<{ tenantId?: string; marker: string }>('test.late', { marker }, { attempts: 1 });
    expect(finished).toBe(false);
    await stopping;
    expect(finished).toBe(true); // it waited for the running job
    expect(running.worker.isRunning()).toBe(false);
    await sleep(500);
    expect(late).toEqual([]);
    expect((await inspect.getWaiting()).map((j) => j.name)).toContain('test.late');
    // The slow job completed normally: it is not in the failed set and will not run again.
    expect((await inspect.getFailed()).map((j) => j.name)).not.toContain('test.slow');
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
    // Stopping twice is harmless.
    await running.stop('again');
    // The API keeps working without a worker; its jobs simply wait.
    await t.as(alpha.owner).get('/branches').expect(200);
  });

  it('as a real process: starts from the entry file, becomes healthy, exits 0 on SIGTERM', async () => {
    const port = await freePort();
    const child = spawn(process.execPath, ['-r', '@swc-node/register', 'src/worker.ts'], {
      cwd: join(__dirname, '..', '..', '..'),
      env: { ...process.env, QUEUE_DRIVER: 'bullmq', WORKER_HEALTH_PORT: String(port), WORKER_CONCURRENCY: '2', NODE_OPTIONS: '--max-old-space-size=1024' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    try {
      const healthy = await until(
        'the worker process to become healthy',
        async () => {
          if (child.exitCode !== null) throw new Error(`worker process exited early (${child.exitCode}):\n${output}`);
          return fetch(`http://127.0.0.1:${port}/health`).then((r) => (r.status === 200 ? r.json() : null), () => null);
        },
        90_000,
      );
      expect(healthy).toMatchObject({ status: 'ok', concurrency: 2, running: true });
      // It does real work: an event waiting in the outbox is dispatched by this process.
      const orphanId = (await createCustomer(t, alpha)).id;
      const orphan = await t.sys.outboxEvent.create({ data: { tenantId: alpha.id, type: 'customer.created', payload: { customerId: orphanId, source: 'TEST' } } });
      await until('the worker process to dispatch an outbox event', async () => (await t.sys.outboxEvent.findUniqueOrThrow({ where: { id: orphan.id } })).status === 'PROCESSED', 30_000);

      child.kill('SIGTERM');
      let giveUp: NodeJS.Timeout | undefined;
      const result = await Promise.race([exited, new Promise<{ code: number | null; signal: string | null }>((resolve) => (giveUp = setTimeout(() => resolve({ code: -1, signal: 'TIMEOUT' }), 40_000)))]);
      clearTimeout(giveUp);
      expect([result.code, result.signal]).toEqual([0, null]);
      await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }, 150_000);
});
