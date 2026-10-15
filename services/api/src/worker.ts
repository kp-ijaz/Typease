import 'reflect-metadata';
import { INestApplicationContext, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Job, Queue, Worker } from 'bullmq';
import type Redis from 'ioredis';
import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AppModule } from './app.module';
import { createAppLogger } from './common/logger';
import { TenantDb } from './common/db/prisma.service';
import { DomainEvents } from './common/events.service';
import { JobQueue, JobSchedule, QUEUE_NAME } from './common/jobs/job-queue';
import { WorkerHeartbeat } from './common/jobs/worker-heartbeat';
import { RedisService } from './common/redis';
import { env } from './config/env';
import { ProvisioningService } from './modules/tenancy/provisioning.service';

/**
 * The TypEase background worker.
 *
 * It boots the same Nest application as the API - every module, so every job
 * handler, schedule and event subscriber is registered - but opens no HTTP
 * listener for the API. Then it
 *
 *   1. consumes the BullMQ queue and runs each job through `JobQueue.execute`
 *      (which binds the tenant of the job for row-level security),
 *   2. turns every declared schedule into a BullMQ job scheduler and removes
 *      schedulers whose schedule no longer exists,
 *   3. runs the outbox dispatcher on an interval as a safety net (events are
 *      normally dispatched by a job enqueued when they are emitted; the interval
 *      also delivers retries that became due),
 *   4. answers a small health endpoint,
 *   5. writes a heartbeat to Redis on an interval (WORKER_HEARTBEAT_INTERVAL_SECONDS), which is how the
 *      platform's system status knows that a worker is alive, and
 *   6. shuts down gracefully on SIGTERM / SIGINT: no new jobs, running jobs
 *      finish, connections close.
 *
 * Worker settings (declared with defaults in config/env.ts; read again here with range checks):
 *   WORKER_CONCURRENCY           jobs processed in parallel            default 5
 *   WORKER_HEALTH_PORT           port of the health endpoint           default 4100
 *   WORKER_OUTBOX_INTERVAL_MS    outbox safety-net interval            default 10000
 *   WORKER_SHUTDOWN_TIMEOUT_MS   how long running jobs may finish      default 30000
 */
export interface WorkerOptions {
  concurrency?: number;
  /** Port of the health endpoint. `0` picks a free port (tests); `false` disables it. */
  healthPort?: number | false;
  outboxIntervalMs?: number;
  shutdownTimeoutMs?: number;
  /** Install SIGTERM / SIGINT handlers. Default true. */
  handleSignals?: boolean;
  /** Run the idempotent platform bootstrap (permissions, plans, templates) first. Default true. */
  bootstrap?: boolean;
  logger?: false | Array<'error' | 'warn' | 'log' | 'debug' | 'verbose'>;
}

export interface WorkerHealth {
  status: 'ok' | 'degraded' | 'stopping';
  service: 'typease-worker';
  redis: boolean;
  database: boolean;
  running: boolean;
  concurrency: number;
  schedulers: number;
  uptimeSeconds: number;
  jobs: { processed: number; failed: number; retried: number; active: number; lastStartedAt: string | null; lastCompletedAt: string | null; lastFailedAt: string | null; lastFailedJob: string | null };
  queue: { waiting: number; active: number; delayed: number; failed: number } | null;
  outbox: { lastRunAt: string | null; lastDelivered: number; lastError: string | null };
}

export interface RunningWorker {
  app: INestApplicationContext;
  worker: Worker;
  queue: Queue;
  /** Actual port of the health endpoint, or null when it is disabled. */
  healthPort: number | null;
  health(): Promise<WorkerHealth>;
  /** Graceful shutdown. Safe to call more than once. */
  stop(reason?: string): Promise<void>;
}

const SCHEDULER_PREFIX = 'schedule:';
export const schedulerId = (name: string) => `${SCHEDULER_PREFIX}${name}`;

const intFromEnv = (name: string, fallback: number, min: number, max: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be a whole number between ${min} and ${max} (got "${raw}").`);
  return value;
};

/** BullMQ repeat options of a declared schedule. Cron patterns are evaluated in UTC. */
export function repeatOptions(schedule: JobSchedule): { every: number } | { pattern: string; tz: string } {
  if (schedule.everySeconds) return { every: schedule.everySeconds * 1000 };
  if (schedule.cron) return { pattern: schedule.cron, tz: 'UTC' };
  throw new Error(`Schedule "${schedule.name}" has neither everySeconds nor cron.`);
}

/**
 * Makes the queue's schedulers equal to the declared schedules: creates or
 * updates one scheduler per schedule and removes every scheduler that no
 * longer has one. Safe to run from several workers at once (upserts).
 */
export async function syncSchedulers(queue: Queue, schedules: JobSchedule[], logger: Pick<Logger, 'log' | 'warn'> = new Logger('Worker')): Promise<{ registered: string[]; removed: string[] }> {
  const wanted = new Map(schedules.map((s) => [schedulerId(s.name), s]));
  const registered: string[] = [];
  for (const [id, schedule] of wanted) {
    await queue.upsertJobScheduler(id, repeatOptions(schedule), {
      name: schedule.name,
      data: {},
      // A scheduled run that fails is not retried: the next tick runs it again, and every handler is idempotent.
      opts: { attempts: 1, removeOnComplete: { age: 3600, count: 200 }, removeOnFail: { age: 14 * 86400 } },
    });
    registered.push(id);
  }
  const removed: string[] = [];
  for (const existing of await queue.getJobSchedulers(0, -1)) {
    const id = existing.id ?? existing.key;
    if (!id || wanted.has(id)) continue;
    await queue.removeJobScheduler(id);
    removed.push(id);
    logger.warn(`removed scheduler "${id}": its schedule is no longer declared`);
  }
  return { registered, removed };
}

/** The Redis connection behind JobQueue's lazily created BullMQ queue, if it was ever used. */
export async function queueClientOf(jobs: JobQueue): Promise<Redis | null> {
  const lazy = (jobs as unknown as { queue?: Queue }).queue;
  if (!lazy) return null;
  try {
    return (await lazy.client) as unknown as Redis;
  } catch {
    return null;
  }
}

/** Wires SIGTERM / SIGINT to a graceful stop. Returns a function that removes the handlers again. */
export function installSignalHandlers(stop: (reason: string) => Promise<void>, proc: Pick<NodeJS.Process, 'on' | 'off'> = process, exit: (code: number) => void = (code) => process.exit(code)): () => void {
  let stopping = false;
  const handler = (signal: string) => {
    if (stopping) return;
    stopping = true;
    stop(signal).then(
      () => exit(0),
      () => exit(1),
    );
  };
  const onTerm = () => handler('SIGTERM');
  const onInt = () => handler('SIGINT');
  proc.on('SIGTERM', onTerm);
  proc.on('SIGINT', onInt);
  return () => {
    proc.off('SIGTERM', onTerm);
    proc.off('SIGINT', onInt);
  };
}

export async function startWorker(options: WorkerOptions = {}): Promise<RunningWorker> {
  const logger = new Logger('Worker');
  const e = env();
  if (e.QUEUE_DRIVER !== 'bullmq') {
    throw new Error('The worker needs QUEUE_DRIVER=bullmq. With QUEUE_DRIVER=inline the API runs the jobs itself (single-process mode) and no worker is started.');
  }
  const concurrency = options.concurrency ?? intFromEnv('WORKER_CONCURRENCY', 5, 1, 200);
  const outboxIntervalMs = options.outboxIntervalMs ?? intFromEnv('WORKER_OUTBOX_INTERVAL_MS', 10_000, 100, 600_000);
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? intFromEnv('WORKER_SHUTDOWN_TIMEOUT_MS', 30_000, 1_000, 3_600_000);
  const healthPort = options.healthPort === false ? null : (options.healthPort ?? intFromEnv('WORKER_HEALTH_PORT', 4100, 1, 65_535));
  const startedAt = Date.now();

  // The whole application without an HTTP server: all handlers, schedules and subscribers register in onModuleInit.
  const app = await NestFactory.createApplicationContext(AppModule, { logger: options.logger ?? createAppLogger() });
  const jobs = app.get(JobQueue);
  const events = app.get(DomainEvents);
  const redis = app.get(RedisService);
  const database = app.get(TenantDb);
  if (options.bootstrap !== false) await app.get(ProvisioningService).bootstrapPlatform();

  // BullMQ needs dedicated connections (blocking commands); it does not close connections it was handed.
  const connections: Redis[] = [redis.duplicateForQueue(), redis.duplicateForQueue()];
  for (const c of connections) c.on('error', (err) => logger.warn(`redis: ${err.message}`));
  const queue = new Queue(QUEUE_NAME, { connection: connections[0] });
  queue.on('error', (err) => logger.warn(`queue: ${err.message}`));

  const stats = { processed: 0, failed: 0, retried: 0, lastStartedAt: null as Date | null, lastCompletedAt: null as Date | null, lastFailedAt: null as Date | null, lastFailedJob: null as string | null };
  const outbox = { lastRunAt: null as Date | null, lastDelivered: 0, lastError: null as string | null };

  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      stats.lastStartedAt = new Date();
      await jobs.execute(job.name, job.data, { attempt: job.attemptsMade + 1, maxAttempts: job.opts.attempts ?? 1, jobId: job.id });
    },
    { connection: connections[1], concurrency },
  );
  worker.on('completed', () => {
    stats.processed += 1;
    stats.lastCompletedAt = new Date();
  });
  worker.on('failed', (job, err) => {
    stats.lastFailedAt = new Date();
    stats.lastFailedJob = job?.name ?? null;
    const attempts = job?.opts.attempts ?? 1;
    const made = job?.attemptsMade ?? 0;
    const label = `job ${job?.name ?? '?'} (${job?.id ?? '?'})`;
    if (made >= attempts) {
      // Out of attempts: BullMQ keeps it in the failed set (the dead letters) for 14 days.
      stats.failed += 1;
      logger.error(`${label} failed for good after ${made} of ${attempts} attempts and is now in the failed set: ${err?.message ?? err}`);
    } else {
      stats.retried += 1;
      logger.warn(`${label} failed on attempt ${made} of ${attempts}, it will be retried: ${err?.message ?? err}`);
    }
  });
  worker.on('error', (err) => logger.warn(`worker: ${err.message}`));
  await worker.waitUntilReady();

  const { registered, removed } = await syncSchedulers(queue, jobs.schedules(), logger);

  // --- heartbeat: "a worker is alive" for the platform's system status -------------------------
  const heartbeat = app.get(WorkerHeartbeat);
  heartbeat.start('worker');

  // --- outbox safety net --------------------------------------------------------------------
  let dispatching: Promise<void> | null = null;
  const runOutbox = () => {
    if (dispatching) return; // never overlap with a slow run
    dispatching = events
      .dispatch()
      .then((delivered) => {
        outbox.lastRunAt = new Date();
        outbox.lastDelivered = delivered;
        outbox.lastError = null;
      })
      .catch((err) => {
        outbox.lastRunAt = new Date();
        outbox.lastError = String(err?.message ?? err).slice(0, 300);
        logger.warn(`outbox dispatch failed: ${outbox.lastError}`);
      })
      .finally(() => {
        dispatching = null;
      });
  };
  const outboxTimer = setInterval(runOutbox, outboxIntervalMs);
  runOutbox();

  // --- health -------------------------------------------------------------------------------
  let stopping = false;
  const health = async (): Promise<WorkerHealth> => {
    const [redisOk, databaseOk, counts] = await Promise.all([
      redis.ping(),
      // A bare connectivity check: no tenant is bound and no table is read.
      database.client.$queryRaw`SELECT 1`.then(() => true, () => false),
      Promise.race([queue.getJobCounts('waiting', 'prioritized', 'active', 'delayed', 'failed'), new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000).unref())]).catch(() => null),
    ]);
    const running = worker.isRunning() && !stopping;
    return {
      status: stopping ? 'stopping' : redisOk && databaseOk && running && counts ? 'ok' : 'degraded',
      service: 'typease-worker',
      redis: redisOk,
      database: databaseOk,
      running,
      concurrency,
      schedulers: registered.length,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      jobs: {
        processed: stats.processed,
        failed: stats.failed,
        retried: stats.retried,
        active: counts?.active ?? 0,
        lastStartedAt: stats.lastStartedAt?.toISOString() ?? null,
        lastCompletedAt: stats.lastCompletedAt?.toISOString() ?? null,
        lastFailedAt: stats.lastFailedAt?.toISOString() ?? null,
        lastFailedJob: stats.lastFailedJob,
      },
      queue: counts ? { waiting: (counts.waiting ?? 0) + (counts.prioritized ?? 0), active: counts.active ?? 0, delayed: counts.delayed ?? 0, failed: counts.failed ?? 0 } : null,
      outbox: { lastRunAt: outbox.lastRunAt?.toISOString() ?? null, lastDelivered: outbox.lastDelivered, lastError: outbox.lastError },
    };
  };

  let server: Server | null = null;
  let boundPort: number | null = null;
  if (healthPort !== null) {
    server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
      };
      if (req.method !== 'GET') return send(405, { error: 'method not allowed' });
      // Liveness: the process answers. Readiness (/health): it can actually do its work.
      if (path === '/health/live') return send(200, { status: 'ok', service: 'typease-worker' });
      if (path === '/health' || path === '/health/ready') {
        health().then(
          (h) => send(h.status === 'ok' ? 200 : 503, h),
          () => send(503, { status: 'degraded', service: 'typease-worker' }),
        );
        return;
      }
      send(404, { error: 'not found' });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(healthPort, '0.0.0.0', () => resolve());
    });
    boundPort = (server.address() as AddressInfo).port;
  }

  // --- graceful shutdown ---------------------------------------------------------------------
  let stopped: Promise<void> | null = null;
  let removeSignalHandlers: () => void = () => undefined;
  const stop = (reason = 'stop requested'): Promise<void> => {
    if (stopped) return stopped;
    stopping = true;
    stopped = (async () => {
      logger.log(`shutting down (${reason}): no new jobs are taken, running jobs may finish`);
      removeSignalHandlers();
      clearInterval(outboxTimer);
      heartbeat.stop();
      // 1. Stop taking jobs and wait for the ones that are running; give up waiting after the timeout.
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        worker.close().then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), shutdownTimeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (timedOut) {
        logger.warn(`running jobs did not finish within ${shutdownTimeoutMs} ms; closing anyway (BullMQ returns them to the queue as stalled jobs)`);
        await worker.close(true).catch(() => undefined);
      }
      // 2. Let an outbox run that is in flight complete.
      if (dispatching) await dispatching;
      // 3. Close everything that was opened here, then the application (database pools, Redis).
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await queue.close().catch(() => undefined);
      await Promise.all(connections.map((c) => c.quit().catch(() => c.disconnect())));
      // Handlers enqueue follow-up jobs through JobQueue, which opens its own queue connection on first use.
      // BullMQ does not close a connection it was handed, and JobQueue keeps no reference to it, so it is
      // looked up here and closed after the application; otherwise the process could not exit on its own.
      const enqueueClient = await queueClientOf(jobs);
      await app.close();
      enqueueClient?.disconnect();
      logger.log('worker stopped');
    })();
    return stopped;
  };
  if (options.handleSignals !== false) removeSignalHandlers = installSignalHandlers(stop);

  logger.log(
    `TypEase worker ready: queue "${QUEUE_NAME}", concurrency ${concurrency}, ${jobs.names().length} job handlers, ${registered.length} schedulers` +
      `${removed.length ? ` (${removed.length} stale removed)` : ''}, outbox every ${outboxIntervalMs} ms${boundPort !== null ? `, health on :${boundPort}/health` : ''}`,
  );
  return { app, worker, queue, healthPort: boundPort, health, stop };
}

// `node dist/worker.js` (or the dev script) starts the worker; importing this file does not.
if (require.main === module) {
  startWorker().catch((err) => {
    // Configuration and start-up errors must be loud and fatal.
    console.error(err);
    process.exit(1);
  });
}
