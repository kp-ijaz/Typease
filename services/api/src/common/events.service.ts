import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { DomainEventType } from '@typease/types';
import { runAsSystem, runAsTenant, tryCtx } from './context';
import { SystemDb, TenantDb, Tx } from './db/prisma.service';
import { JobQueue } from './jobs/job-queue';

export interface DomainEvent<P = Record<string, any>> {
  id: string;
  tenantId: string | null;
  type: DomainEventType;
  payload: P;
  createdAt: Date;
}
type SyncListener = (event: DomainEvent, tx: Tx) => Promise<void>;
type Subscriber = (event: DomainEvent) => Promise<void>;

const MAX_ATTEMPTS = 8;

/**
 * Domain events with a transactional outbox.
 *
 *  emit()       - inside the business transaction: stores the event and runs
 *                 in-transaction listeners (e.g. the workflow engine reacting
 *                 to payment.completed), so state stays consistent.
 *  subscribe()  - at-least-once, after-commit consumers (automations,
 *                 notifications, n8n). They must be idempotent.
 *  dispatch()   - worker loop: delivers pending events with retry + backoff.
 */
@Injectable()
export class DomainEvents implements OnModuleInit {
  private readonly logger = new Logger(DomainEvents.name);
  private readonly sync = new Map<string, SyncListener[]>();
  private readonly subscribers: Array<{ name: string; types: string[] | '*'; handler: Subscriber }> = [];

  constructor(
    private readonly db: TenantDb,
    private readonly sys: SystemDb,
    private readonly jobs: JobQueue,
  ) {}

  onModuleInit() {
    this.jobs.register('outbox.dispatch', async () => void (await this.dispatch()), { attempts: 1 });
  }

  /** In-transaction listener. Throwing rolls back the whole business transaction. */
  on(type: DomainEventType, listener: SyncListener) {
    this.sync.set(type, [...(this.sync.get(type) ?? []), listener]);
  }
  /** After-commit subscriber. */
  subscribe(name: string, types: DomainEventType[] | '*', handler: Subscriber) {
    this.subscribers.push({ name, types, handler });
  }

  async emit(tx: Tx, type: DomainEventType, payload: Record<string, any>): Promise<DomainEvent> {
    const c = tryCtx();
    const tenantId = this.db.tenantId;
    const enriched = { ...payload, _actor: { userId: c?.userId ?? null, type: c?.actorType ?? 'SYSTEM' } };
    const row = await tx.outboxEvent.create({ data: { tenantId, type, payload: enriched as any } });
    const event: DomainEvent = { id: row.id, tenantId, type, payload: enriched, createdAt: row.createdAt };
    for (const listener of this.sync.get(type) ?? []) await listener(event, tx);
    this.db.afterCommit(() => this.jobs.enqueue('outbox.dispatch', {}, { attempts: 1 }));
    return event;
  }

  /**
   * Event written on the system connection: platform-level (no tenant), or about a tenant from code that
   * is cross-tenant by nature (billing, platform support). With `tx` (a SystemDb transaction) the event is
   * part of that transaction and dispatched after it commits; without one it is written at once.
   */
  async emitSystem(type: DomainEventType, payload: Record<string, any>, tenantId: string | null = null, tx?: Tx): Promise<void> {
    if (tx) {
      await tx.outboxEvent.create({ data: { tenantId, type, payload: payload as any } });
      this.sys.afterCommit(() => this.jobs.enqueue('outbox.dispatch', {}, { attempts: 1 }));
      return;
    }
    await this.sys.client.outboxEvent.create({ data: { tenantId, type, payload: payload as any } });
    await this.jobs.enqueue('outbox.dispatch', {}, { attempts: 1 });
  }

  /** Deliver pending events. Safe to run concurrently (row locks with SKIP LOCKED). */
  async dispatch(batchSize = 50): Promise<number> {
    let delivered = 0;
    for (;;) {
      const claimed = await this.sys.client.$queryRaw<Array<{ id: string }>>`
        UPDATE "outbox_events" SET "status" = 'PROCESSING', "attempts" = "attempts" + 1
        WHERE "id" IN (
          SELECT "id" FROM "outbox_events"
          WHERE ("status" = 'PENDING' AND "availableAt" <= now())
             OR ("status" = 'PROCESSING' AND "availableAt" <= now() - interval '5 minutes')
          ORDER BY "createdAt" LIMIT ${batchSize} FOR UPDATE SKIP LOCKED)
        RETURNING "id"`;
      if (!claimed.length) break;
      const rows = await this.sys.client.outboxEvent.findMany({
        where: { id: { in: claimed.map((r) => r.id) } },
        orderBy: { createdAt: 'asc' },
      });
      for (const row of rows) {
        const event: DomainEvent = {
          id: row.id,
          tenantId: row.tenantId,
          type: row.type as DomainEventType,
          payload: row.payload as any,
          createdAt: row.createdAt,
        };
        const errors: string[] = [];
        for (const sub of this.subscribers) {
          if (sub.types !== '*' && !sub.types.includes(event.type)) continue;
          try {
            const run = () => sub.handler(event);
            if (event.tenantId) await runAsTenant(event.tenantId, run, { actorType: 'AUTOMATION', actorLabel: `event:${sub.name}` });
            else await runAsSystem(run, { actorLabel: `event:${sub.name}` });
          } catch (e: any) {
            errors.push(`${sub.name}: ${e?.message ?? e}`);
            this.logger.warn(`subscriber ${sub.name} failed for ${event.type} ${event.id}: ${e?.message}`);
          }
        }
        if (!errors.length) {
          await this.sys.client.outboxEvent.update({ where: { id: row.id }, data: { status: 'PROCESSED', processedAt: new Date(), error: null } });
          delivered += 1;
        } else if (row.attempts >= MAX_ATTEMPTS) {
          await this.sys.client.outboxEvent.update({ where: { id: row.id }, data: { status: 'FAILED', error: errors.join(' | ').slice(0, 2000) } });
        } else {
          const backoffSeconds = Math.min(3600, 2 ** row.attempts * 5);
          await this.sys.client.outboxEvent.update({
            where: { id: row.id },
            data: { status: 'PENDING', availableAt: new Date(Date.now() + backoffSeconds * 1000), error: errors.join(' | ').slice(0, 2000) },
          });
        }
      }
      if (claimed.length < batchSize) break;
    }
    return delivered;
  }
}
