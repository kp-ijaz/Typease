import { Injectable } from '@nestjs/common';
import { SystemDb } from '../../common/db/prisma.service';
import { SystemHealthService } from './health.service';
import { Metric, prometheusText } from './metrics.calc';
import { PlatformTenantsService } from './tenants.service';

/**
 * Operational metrics for a Prometheus scraper (`GET /internal/metrics`).
 * Gauges are read from the database and the queue at scrape time; nothing is
 * accumulated in the process, so several API replicas report the same values.
 *
 * HTTP request rates / latencies are NOT instrumented here - take those from
 * the reverse proxy or load balancer.
 */
@Injectable()
export class PlatformMetricsService {
  constructor(
    private readonly sys: SystemDb,
    private readonly tenants: PlatformTenantsService,
    private readonly health: SystemHealthService,
  ) {}

  async collect(): Promise<Metric[]> {
    const hourAgo = new Date(Date.now() - 3600_000);
    const up = (fn: () => Promise<unknown>) => fn().then(() => 1, () => 0);
    const [database, byStatus, outbox, queue, notificationsFailed, deliveriesFailed] = await Promise.all([
      up(() => this.sys.client.$queryRaw`SELECT 1`),
      this.tenants.countByStatus().catch(() => null),
      this.health.outbox().catch(() => null),
      this.health.queueStats(),
      this.sys.client.notification.count({ where: { status: 'FAILED', createdAt: { gte: hourAgo } } }).catch(() => null),
      this.sys.client.notificationDelivery.count({ where: { status: 'FAILED', requestedAt: { gte: hourAgo } } }).catch(() => null),
    ]);
    const memory = process.memoryUsage();
    const metrics: Metric[] = [
      { name: 'typease_process_uptime_seconds', help: 'Seconds since this API process started.', type: 'gauge', samples: [{ value: Math.round(process.uptime()) }] },
      { name: 'typease_process_resident_memory_bytes', help: 'Resident set size of this API process.', type: 'gauge', samples: [{ value: memory.rss }] },
      { name: 'typease_process_heap_used_bytes', help: 'V8 heap in use by this API process.', type: 'gauge', samples: [{ value: memory.heapUsed }] },
      { name: 'typease_database_up', help: '1 when the system database connection answers.', type: 'gauge', samples: [{ value: database }] },
      { name: 'typease_queue_up', help: '1 when the job queue is reachable.', type: 'gauge', samples: [{ labels: { driver: queue.driver }, value: queue.reachable ? 1 : 0 }] },
    ];
    if (byStatus) {
      metrics.push({ name: 'typease_tenants', help: 'Centres by status.', type: 'gauge', samples: Object.entries(byStatus).map(([status, value]) => ({ labels: { status: status.toLowerCase() }, value })) });
    }
    if (outbox) {
      metrics.push({ name: 'typease_outbox_pending', help: 'Domain events in the outbox waiting to be delivered.', type: 'gauge', samples: [{ value: outbox.pending }] });
      metrics.push({ name: 'typease_outbox_processing', help: 'Domain events currently claimed by a dispatcher.', type: 'gauge', samples: [{ value: outbox.processing }] });
      metrics.push({ name: 'typease_outbox_failed', help: 'Domain events that could not be delivered after all attempts.', type: 'gauge', samples: [{ value: outbox.failed }] });
      metrics.push({ name: 'typease_outbox_oldest_pending_seconds', help: 'Age of the oldest domain event still waiting for delivery.', type: 'gauge', samples: [{ value: outbox.oldestPendingSeconds }] });
    }
    // The same series for both queue drivers, so dashboards and alerts need no special case.
    const jobs = queue.driver === 'bullmq' ? { waiting: queue.waiting, active: queue.active, delayed: queue.delayed, failed: queue.failed } : { waiting: queue.pending, active: 0, delayed: 0, failed: queue.deadLetters };
    metrics.push({
      name: 'typease_queue_jobs',
      help: queue.driver === 'bullmq' ? 'Background jobs in the BullMQ queue by state. "failed" is the dead-letter set.' : 'Background jobs of the in-process (inline) queue by state. "failed" are dead letters of this process.',
      type: 'gauge',
      samples: Object.entries(jobs).map(([state, value]) => ({ labels: { state }, value })),
    });
    if (notificationsFailed !== null) metrics.push({ name: 'typease_notifications_failed', help: 'Notifications created in the last hour that ended as FAILED.', type: 'gauge', samples: [{ value: notificationsFailed }] });
    if (deliveriesFailed !== null) metrics.push({ name: 'typease_notification_delivery_attempts_failed', help: 'Failed provider delivery attempts in the last hour.', type: 'gauge', samples: [{ value: deliveriesFailed }] });
    return metrics;
  }

  async text(): Promise<string> {
    return prometheusText(await this.collect(), ['TypEase operational metrics. HTTP request metrics are not instrumented; use the reverse proxy for those.']);
  }
}
