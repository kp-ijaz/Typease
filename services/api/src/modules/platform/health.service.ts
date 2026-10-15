import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { SystemDb, TenantDb } from '../../common/db/prisma.service';
import { JobQueue, QUEUE_NAME } from '../../common/jobs/job-queue';
import { WorkerHeartbeat, WorkerLiveness } from '../../common/jobs/worker-heartbeat';
import { RedisService } from '../../common/redis';
import { StorageService } from '../storage/storage.service';

export type QueueStats =
  | { driver: 'bullmq'; reachable: boolean; waiting: number; active: number; delayed: number; failed: number }
  | { driver: 'inline'; reachable: true; pending: number; deadLetters: number };

/** The same figures for every queue of the installation (there is one: "typease"), whatever the driver. */
export interface QueueCounts {
  name: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}
export interface StorageHealth {
  driver: 's3' | 'local';
  reachable: boolean;
  /** Where the objects live (bucket and endpoint host, or the local directory). */
  target: string;
  error: string | null;
  checkedAt: string;
}

export interface OutboxStats {
  pending: number;
  processing: number;
  failed: number;
  /** Age of the oldest event still waiting for delivery, in seconds (0 when none is waiting). */
  oldestPendingSeconds: number;
}

/**
 * Health of the things the platform runs on: both database connections, Redis,
 * object storage, the job queue, whatever executes the jobs (the worker's
 * heartbeat) and the event outbox. Used by the dashboard, by
 * `GET /platform/system/health` and by the Prometheus endpoint.
 */
@Injectable()
export class SystemHealthService implements OnModuleDestroy {
  private queue?: Queue;
  private connection?: Redis;

  constructor(
    private readonly sys: SystemDb,
    private readonly db: TenantDb,
    private readonly redis: RedisService,
    private readonly jobs: JobQueue,
    private readonly storage: StorageService,
    private readonly heartbeat: WorkerHeartbeat,
  ) {}

  /** The store is asked at most every 15 seconds: the dashboard is polled, a bucket need not be. */
  private storageCache?: { at: number; value: StorageHealth };
  async storageHealth(now: Date = new Date()): Promise<StorageHealth> {
    if (this.storageCache && now.getTime() - this.storageCache.at < 15_000 && this.storageCache.value.reachable) return this.storageCache.value;
    const check = await this.storage.check();
    const value: StorageHealth = { driver: this.storage.driverName, reachable: check.ok, target: check.target, error: check.error, checkedAt: now.toISOString() };
    this.storageCache = { at: now.getTime(), value };
    return value;
  }

  /** Per-queue figures in one shape for both drivers (inline: waiting = jobs in memory, failed = dead letters). */
  queueCounts(queue: QueueStats): QueueCounts[] {
    if (queue.driver === 'inline') return [{ name: QUEUE_NAME, waiting: queue.pending, active: 0, delayed: 0, failed: queue.deadLetters }];
    return [{ name: QUEUE_NAME, waiting: queue.waiting, active: queue.active, delayed: queue.delayed, failed: queue.failed }];
  }
  workerLiveness(now: Date = new Date()): Promise<WorkerLiveness | null> {
    return this.heartbeat.liveness(now).catch(() => null);
  }

  private bull(): Queue {
    if (!this.queue) {
      // Read-only use (job counts). BullMQ needs its own connection.
      this.connection = this.redis.duplicateForQueue();
      this.connection.on('error', () => undefined);
      this.queue = new Queue(QUEUE_NAME, { connection: this.connection });
      this.queue.on('error', () => undefined);
    }
    return this.queue;
  }

  async queueStats(): Promise<QueueStats> {
    if (this.jobs.driver === 'inline') return { driver: 'inline', reachable: true, pending: this.jobs.pendingCount(), deadLetters: this.jobs.deadLetters.length };
    try {
      const counts = await Promise.race([
        this.bull().getJobCounts('waiting', 'prioritized', 'active', 'delayed', 'failed'),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000).unref()),
      ]);
      return { driver: 'bullmq', reachable: true, waiting: (counts.waiting ?? 0) + (counts.prioritized ?? 0), active: counts.active ?? 0, delayed: counts.delayed ?? 0, failed: counts.failed ?? 0 };
    } catch {
      return { driver: 'bullmq', reachable: false, waiting: 0, active: 0, delayed: 0, failed: 0 };
    }
  }

  async outbox(): Promise<OutboxStats> {
    const rows = await this.sys.client.$queryRaw<Array<{ status: string; n: bigint; oldest: Date | null }>>`
      SELECT "status"::text AS status, count(*) AS n, min("createdAt") AS oldest FROM "outbox_events" WHERE "status" IN ('PENDING', 'PROCESSING', 'FAILED') GROUP BY 1`;
    const by = new Map(rows.map((r) => [r.status, r]));
    const oldest = by.get('PENDING')?.oldest;
    return {
      pending: Number(by.get('PENDING')?.n ?? 0),
      processing: Number(by.get('PROCESSING')?.n ?? 0),
      failed: Number(by.get('FAILED')?.n ?? 0),
      oldestPendingSeconds: oldest ? Math.max(0, Math.round((Date.now() - new Date(oldest).getTime()) / 1000)) : 0,
    };
  }

  async health() {
    const check = (fn: () => Promise<unknown>) => fn().then(() => true, () => false);
    const now = new Date();
    const [database, systemDatabase, redis, queue, outbox, storage, worker] = await Promise.all([
      check(() => this.db.client.$queryRaw`SELECT 1`),
      check(() => this.sys.client.$queryRaw`SELECT 1`),
      this.redis.ping(),
      this.queueStats(),
      this.outbox().catch(() => null),
      this.storageHealth(now),
      this.workerLiveness(now),
    ]);
    const problems: string[] = [];
    if (!database || !systemDatabase) problems.push('The database is not reachable.');
    if (!redis) problems.push('Redis is not reachable.');
    if (!queue.reachable) problems.push('The job queue is not reachable.');
    if (queue.driver === 'bullmq' && queue.failed > 0) problems.push(`${queue.failed} background jobs failed and are waiting in the failed set.`);
    if (queue.driver === 'inline' && queue.deadLetters > 0) problems.push(`${queue.deadLetters} background jobs failed (dead letters).`);
    if (outbox && outbox.failed > 0) problems.push(`${outbox.failed} domain events could not be delivered.`);
    if (outbox && outbox.oldestPendingSeconds > 600) problems.push('Domain events have been waiting for more than 10 minutes: is the worker running?');
    if (!storage.reachable) problems.push(`Object storage is not reachable (${storage.target}${storage.error ? `: ${storage.error}` : ''}): uploads and downloads fail.`);
    if (worker?.status === 'STALE') problems.push(`The ${worker.mode === 'worker' ? 'background worker' : 'job runner of the API'} last reported ${worker.ageSeconds} seconds ago (expected every ${worker.intervalSeconds}): background jobs are probably not being processed.`);
    if (worker?.status === 'NOT_SEEN') problems.push(worker.mode === 'worker' ? 'No background worker has reported: jobs are queued but nothing processes them. Start the worker.' : 'The job runner of the API has not reported yet.');
    // Stale workers and an unreachable store degrade the service; "down" is kept for what nothing works without.
    const down = !database || !systemDatabase || !redis || !queue.reachable || !outbox;
    return {
      status: down ? ('down' as const) : problems.length ? ('degraded' as const) : ('ok' as const),
      checkedAt: now.toISOString(),
      database,
      systemDatabase,
      redis,
      storage,
      queue,
      /** Waiting / active / delayed / failed per queue, in the same shape for both queue drivers. */
      queues: this.queueCounts(queue),
      /** Is anything executing the jobs? Null only when the heartbeat could not be read (Redis down). */
      worker,
      outbox,
      problems,
    };
  }

  async onModuleDestroy() {
    await this.queue?.close().catch(() => undefined);
    this.connection?.disconnect();
  }
}
