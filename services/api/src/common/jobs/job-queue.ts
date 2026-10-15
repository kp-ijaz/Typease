import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { env } from '../../config/env';
import { runAsSystem, runAsTenant } from '../context';
import { RedisService } from '../redis';

export interface JobMeta {
  attempt: number;
  maxAttempts: number;
  jobId?: string;
}
export type JobHandler<P = any> = (payload: P, meta: JobMeta) => Promise<void>;
export interface JobOptions {
  delayMs?: number;
  attempts?: number;
  backoffMs?: number;
  /** Same id = same job: duplicates are ignored (idempotent enqueue). */
  jobId?: string;
}
interface Registered {
  handler: JobHandler;
  defaults: JobOptions;
}
interface InlineJob {
  name: string;
  payload: any;
  options: JobOptions;
  attempt: number;
  runAt: number;
}

export interface JobSchedule {
  /** Name of a registered job handler. */
  name: string;
  /** Run every N seconds ... */
  everySeconds?: number;
  /** ... or on a cron pattern (UTC), e.g. "0 2 * * *". */
  cron?: string;
  description: string;
}

export const QUEUE_NAME = 'typease';

/**
 * Background job facade.
 *
 *  - `bullmq` driver (default): jobs go to Redis and are executed by services/worker
 *    with retries, exponential backoff and a failed-job set (dead letters).
 *  - `inline` driver (tests / single-process demos): jobs are kept in memory and run
 *    by `drain()`, with the same retry semantics.
 *
 * Handlers are registered by the owning module in onModuleInit and must be
 * idempotent: a job may run more than once.
 */
@Injectable()
export class JobQueue implements OnModuleDestroy {
  private readonly logger = new Logger(JobQueue.name);
  private readonly handlers = new Map<string, Registered>();
  private queue?: Queue;
  private queueConnection?: ReturnType<RedisService['duplicateForQueue']>;
  private inline: InlineJob[] = [];
  private inlineIds = new Set<string>();
  readonly deadLetters: Array<{ name: string; payload: any; error: string }> = [];
  private readonly scheduleList: JobSchedule[] = [];

  constructor(private readonly redis: RedisService) {}

  get driver() {
    return env().QUEUE_DRIVER;
  }

  register<P>(name: string, handler: JobHandler<P>, defaults: JobOptions = {}) {
    if (this.handlers.has(name)) throw new Error(`Job handler "${name}" is already registered.`);
    this.handlers.set(name, { handler, defaults });
  }
  names(): string[] {
    return [...this.handlers.keys()];
  }

  /**
   * Declare a recurring job. The worker turns these into BullMQ job schedulers;
   * tests call `runScheduled(name)` to execute one immediately.
   */
  schedule(schedule: JobSchedule) {
    if (!schedule.everySeconds && !schedule.cron) throw new Error(`Schedule "${schedule.name}" needs everySeconds or cron.`);
    this.scheduleList.push(schedule);
  }
  schedules(): JobSchedule[] {
    return [...this.scheduleList];
  }
  async runScheduled(name: string): Promise<void> {
    await this.execute(name, {}, { attempt: 1, maxAttempts: 1 });
  }

  private kickTimer?: NodeJS.Timeout;
  private draining = false;
  private intervals: NodeJS.Timeout[] = [];

  /** Single-process mode: run queued jobs shortly after they were enqueued. */
  private kick(delayMs: number) {
    const timer = setTimeout(async () => {
      if (this.draining) return this.kick(50);
      this.draining = true;
      try {
        await this.drain();
      } catch (e: any) {
        this.logger.error(`inline drain failed: ${e?.message}`);
      } finally {
        this.draining = false;
        if (this.inline.length) this.kick(Math.max(50, Math.min(...this.inline.map((j) => j.runAt)) - Date.now()));
      }
    }, Math.max(10, delayMs));
    timer.unref();
    this.kickTimer = timer;
  }

  /** Single-process mode: run interval schedules inside the API process. */
  startInlineSchedules() {
    if (this.driver !== 'inline' || !env().QUEUE_INLINE_AUTORUN || this.intervals.length) return;
    for (const s of this.scheduleList) {
      // Cron schedules (daily / hourly housekeeping) run hourly here; all handlers are idempotent.
      const everyMs = (s.everySeconds ?? 3600) * 1000;
      const timer = setInterval(() => {
        this.runScheduled(s.name).catch((e) => this.logger.warn(`schedule ${s.name} failed: ${e?.message}`));
      }, everyMs);
      timer.unref();
      this.intervals.push(timer);
    }
    this.logger.log(`Single-process mode: ${this.intervals.length} schedules run inside the API process.`);
  }

  private bull(): Queue {
    if (!this.queue) {
      this.queueConnection = this.redis.duplicateForQueue();
      this.queue = new Queue(QUEUE_NAME, {
        connection: this.queueConnection,
        defaultJobOptions: { removeOnComplete: { age: 3600, count: 1000 }, removeOnFail: { age: 14 * 86400 } },
      });
    }
    return this.queue;
  }

  async enqueue<P extends { tenantId?: string | null }>(name: string, payload: P, options: JobOptions = {}): Promise<void> {
    const reg = this.handlers.get(name);
    const opts = { attempts: 5, backoffMs: 5_000, ...(reg?.defaults ?? {}), ...options };
    if (this.driver === 'inline') {
      if (opts.jobId) {
        if (this.inlineIds.has(opts.jobId)) return;
        this.inlineIds.add(opts.jobId);
      }
      this.inline.push({ name, payload, options: opts, attempt: 0, runAt: Date.now() + (opts.delayMs ?? 0) });
      if (env().QUEUE_INLINE_AUTORUN) this.kick(opts.delayMs ?? 0);
      return;
    }
    await this.bull().add(name, payload, {
      delay: opts.delayMs,
      attempts: opts.attempts,
      backoff: { type: 'exponential', delay: opts.backoffMs },
      jobId: opts.jobId,
    });
  }

  /** Execute one job with the right tenant / system context. Used by the worker and by drain(). */
  async execute(name: string, payload: any, meta: JobMeta): Promise<void> {
    const reg = this.handlers.get(name);
    if (!reg) throw new Error(`No handler registered for job "${name}".`);
    const run = () => reg.handler(payload, meta);
    if (payload?.tenantId) await runAsTenant(payload.tenantId, run, { actorLabel: `job:${name}` });
    else await runAsSystem(run, { actorLabel: `job:${name}` });
  }

  /**
   * Inline driver: run queued jobs until the queue is empty. Delayed jobs are
   * skipped unless `includeDelayed` is set. Returns the number of executions.
   */
  async drain(options: { includeDelayed?: boolean; maxRounds?: number } = {}): Promise<number> {
    let executed = 0;
    for (let round = 0; round < (options.maxRounds ?? 50); round++) {
      const now = Date.now();
      const ready = this.inline.filter((j) => options.includeDelayed || j.runAt <= now);
      if (!ready.length) break;
      this.inline = this.inline.filter((j) => !ready.includes(j));
      for (const job of ready) {
        job.attempt += 1;
        const max = job.options.attempts ?? 5;
        try {
          await this.execute(job.name, job.payload, { attempt: job.attempt, maxAttempts: max, jobId: job.options.jobId });
        } catch (e: any) {
          if (job.attempt < max) {
            job.runAt = Date.now();
            this.inline.push(job);
          } else {
            this.deadLetters.push({ name: job.name, payload: job.payload, error: String(e?.message ?? e) });
            this.logger.warn(`job ${job.name} moved to dead letters: ${e?.message}`);
          }
        }
        executed += 1;
      }
    }
    return executed;
  }
  pendingCount(): number {
    return this.inline.length;
  }
  /** Tests only. */
  clearInline() {
    this.inline = [];
    this.inlineIds.clear();
    this.deadLetters.length = 0;
  }

  async onModuleDestroy() {
    if (this.kickTimer) clearTimeout(this.kickTimer);
    this.intervals.forEach((i) => clearInterval(i));
    await this.queue?.close();
    // BullMQ does not close a connection it did not create.
    this.queueConnection?.disconnect();
  }
}
