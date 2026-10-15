import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { env } from '../../config/env';
import { RedisService } from '../redis';

/** Redis hash: one field per process that runs background jobs, value = its last heartbeat (JSON). */
export const WORKER_HEARTBEAT_KEY = 'typease:worker:heartbeats';
/** How long the last heartbeat stays readable after the last process stopped writing ("last seen 3 hours ago"). */
export const WORKER_HEARTBEAT_TTL_SECONDS = 24 * 3600;

/** Who runs the jobs: a separate worker process (BullMQ), or the API itself (single-process mode). */
export type WorkerMode = 'worker' | 'single-process';
export interface WorkerBeat {
  instanceId: string;
  mode: WorkerMode;
  startedAt: string;
  lastSeenAt: string;
}
export interface WorkerLiveness {
  /** The mode this installation is configured for: QUEUE_DRIVER=bullmq needs a worker, QUEUE_DRIVER=inline runs jobs in the API. */
  mode: WorkerMode;
  /**
   * OK        a process of that mode reported within two intervals;
   * STALE     the last report is older than two intervals: jobs are probably not being processed;
   * NOT_SEEN  no process of that mode has reported (within the last 24 hours);
   * DISABLED  inline queue without QUEUE_INLINE_AUTORUN: nothing runs jobs on its own (tests, one-off scripts).
   */
  status: 'OK' | 'STALE' | 'NOT_SEEN' | 'DISABLED';
  lastSeenAt: string | null;
  /** Seconds since the last report, or null. */
  ageSeconds: number | null;
  intervalSeconds: number;
  staleAfterSeconds: number;
  /** Processes of the configured mode that reported within the last 24 hours, most recent first. */
  instances: Array<WorkerBeat & { ageSeconds: number; stale: boolean }>;
}

/**
 * "Is anything processing background jobs?" - answered from Redis, so the API can tell without
 * talking to the worker. The worker (and the API in single-process mode) writes a heartbeat on an
 * interval; the platform's system status reads it. A heartbeat is a statement about the process
 * that wrote it only: it does not say that a particular job succeeded.
 */
@Injectable()
export class WorkerHeartbeat implements OnModuleDestroy {
  private readonly logger = new Logger(WorkerHeartbeat.name);
  readonly instanceId = `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;
  private readonly startedAt = new Date();
  private timer?: NodeJS.Timeout;

  constructor(private readonly redis: RedisService) {}

  get intervalSeconds(): number {
    return env().WORKER_HEARTBEAT_INTERVAL_SECONDS;
  }

  /** Writes one heartbeat for this process. Never throws: a Redis hiccup must not stop the worker. */
  async beat(mode: WorkerMode, at: Date = new Date()): Promise<boolean> {
    const beat: WorkerBeat = { instanceId: this.instanceId, mode, startedAt: this.startedAt.toISOString(), lastSeenAt: at.toISOString() };
    try {
      await this.redis.client.multi().hset(WORKER_HEARTBEAT_KEY, this.instanceId, JSON.stringify(beat)).expire(WORKER_HEARTBEAT_KEY, WORKER_HEARTBEAT_TTL_SECONDS).exec();
      return true;
    } catch (e: any) {
      this.logger.warn(`heartbeat not written: ${e?.message ?? e}`);
      return false;
    }
  }

  /** Beats now and then on every interval until `stop()`. Calling it twice keeps one timer. */
  start(mode: WorkerMode): void {
    if (this.timer) return;
    void this.beat(mode);
    this.timer = setInterval(() => void this.beat(mode), this.intervalSeconds * 1000);
    this.timer.unref();
  }
  /** Stops beating. The last heartbeat stays, so the status turns STALE instead of forgetting the process. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Every heartbeat on record. Entries older than the retention are removed on the way. */
  async beats(now: Date = new Date()): Promise<WorkerBeat[]> {
    const raw = await this.redis.client.hgetall(WORKER_HEARTBEAT_KEY);
    const out: WorkerBeat[] = [];
    const expired: string[] = [];
    for (const [field, value] of Object.entries(raw)) {
      let beat: WorkerBeat | null = null;
      try {
        const parsed = JSON.parse(value);
        if (typeof parsed?.lastSeenAt === 'string' && (parsed.mode === 'worker' || parsed.mode === 'single-process')) beat = { instanceId: field, mode: parsed.mode, startedAt: String(parsed.startedAt ?? parsed.lastSeenAt), lastSeenAt: parsed.lastSeenAt };
      } catch {
        beat = null;
      }
      if (!beat || now.getTime() - new Date(beat.lastSeenAt).getTime() > WORKER_HEARTBEAT_TTL_SECONDS * 1000) expired.push(field);
      else out.push(beat);
    }
    if (expired.length) await this.redis.client.hdel(WORKER_HEARTBEAT_KEY, ...expired).catch(() => undefined);
    return out;
  }

  /** Liveness of whatever is supposed to run the jobs in this installation. */
  async liveness(now: Date = new Date()): Promise<WorkerLiveness> {
    const e = env();
    const mode: WorkerMode = e.QUEUE_DRIVER === 'bullmq' ? 'worker' : 'single-process';
    const intervalSeconds = this.intervalSeconds;
    const staleAfterSeconds = intervalSeconds * 2;
    const base = { mode, intervalSeconds, staleAfterSeconds };
    if (mode === 'single-process' && !e.QUEUE_INLINE_AUTORUN) return { ...base, status: 'DISABLED', lastSeenAt: null, ageSeconds: null, instances: [] };
    const instances = (await this.beats(now))
      .filter((b) => b.mode === mode)
      .map((b) => {
        const ageSeconds = Math.max(0, Math.round((now.getTime() - new Date(b.lastSeenAt).getTime()) / 1000));
        return { ...b, ageSeconds, stale: ageSeconds > staleAfterSeconds };
      })
      .sort((a, b) => a.ageSeconds - b.ageSeconds);
    const latest = instances[0];
    if (!latest) return { ...base, status: 'NOT_SEEN', lastSeenAt: null, ageSeconds: null, instances };
    return { ...base, status: latest.stale ? 'STALE' : 'OK', lastSeenAt: latest.lastSeenAt, ageSeconds: latest.ageSeconds, instances };
  }

  onModuleDestroy() {
    this.stop();
  }
}
