import { Injectable } from '@nestjs/common';
import { NOTIFICATION_EVENTS } from '@typease/types';
import type { NotificationFailureQuery, NotificationLogQuery, NotificationSettingsInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { Prisma, TenantDb } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { JobQueue } from '../../common/jobs/job-queue';
import { pageArgs, pageResult } from '../../common/pagination';
import { UsageService } from '../../common/usage.service';
import { Channel, CHANNELS, EVENT_DEFINITIONS, eventDefinition, EXTERNAL_CHANNELS } from './catalogue';
import { DELIVER_JOB } from './notification.service';
import { ProviderRegistry } from './providers/registry';
import { channelEnabled, NotificationSettings, parseSettings, saveSettings } from './settings';

const SORT = ['createdAt', 'sentAt', 'status', 'channel', 'eventKey'] as const;
const dayStart = (d: string) => new Date(`${d}T00:00:00.000Z`);
const dayEnd = (d: string) => new Date(`${d}T23:59:59.999Z`);
const label = (eventKey: string) => eventDefinition(eventKey)?.label ?? (NOTIFICATION_EVENTS as Record<string, string>)[eventKey] ?? eventKey;

/** Staff view of notifications: delivery log, failure report, retry, channels and settings. */
@Injectable()
export class NotificationAdminService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly jobs: JobQueue,
    private readonly usage: UsageService,
    private readonly providers: ProviderRegistry,
  ) {}

  /** A log row. The `data` column (rendering internals, encrypted payloads) is never exposed. */
  private shape(n: any) {
    const deliveries: any[] = n.notificationDeliveries ?? [];
    const last = deliveries[deliveries.length - 1];
    return {
      id: n.id,
      eventKey: n.eventKey,
      eventLabel: label(n.eventKey),
      channel: n.channel,
      language: n.language,
      status: n.status,
      suppressedReason: n.suppressedReason,
      recipientAddress: n.recipientAddress,
      recipientCustomerId: n.recipientCustomerId,
      recipientUserId: n.recipientUserId,
      subject: n.subject,
      relatedType: n.relatedType,
      relatedId: n.relatedId,
      createdAt: n.createdAt,
      sentAt: n.sentAt,
      attempts: deliveries.length,
      provider: last?.provider ?? null,
      lastError: [...deliveries].reverse().find((d) => d.error)?.error ?? null,
    };
  }
  private where(query: { status?: string; channel?: string; eventKey?: string; customerId?: string; from?: string; to?: string; q?: string }): Prisma.NotificationWhereInput {
    return {
      tenantId: this.db.tenantId,
      ...(query.status ? { status: query.status as any } : {}),
      ...(query.channel ? { channel: query.channel as any } : {}),
      ...(query.eventKey ? { eventKey: query.eventKey } : {}),
      ...(query.customerId ? { recipientCustomerId: query.customerId } : {}),
      ...(query.from || query.to ? { createdAt: { ...(query.from ? { gte: dayStart(query.from) } : {}), ...(query.to ? { lte: dayEnd(query.to) } : {}) } } : {}),
      ...(query.q ? { OR: [{ recipientAddress: { contains: query.q, mode: 'insensitive' } }, { subject: { contains: query.q, mode: 'insensitive' } }] } : {}),
    };
  }

  async log(query: NotificationLogQuery) {
    return this.db.tx(async (tx) => {
      const where = this.where(query);
      const [rows, total] = [
        await tx.notification.findMany({ where, ...pageArgs(query, SORT, 'createdAt:desc'), include: { notificationDeliveries: { orderBy: { attempt: 'asc' } } } }),
        await tx.notification.count({ where }),
      ];
      return pageResult(rows.map((r) => this.shape(r)), total, query);
    });
  }

  /** Failed notifications with the reason, plus totals per channel and event for the period. */
  async failures(query: NotificationFailureQuery) {
    return this.db.tx(async (tx) => {
      const where = this.where({ ...query, status: 'FAILED' });
      const rows = await tx.notification.findMany({ where, ...pageArgs(query, SORT, 'createdAt:desc'), include: { notificationDeliveries: { orderBy: { attempt: 'asc' } } } });
      const total = await tx.notification.count({ where });
      const byChannel = await tx.notification.groupBy({ by: ['channel'], where, _count: { _all: true } });
      const byEvent = await tx.notification.groupBy({ by: ['eventKey'], where, _count: { _all: true } });
      return {
        ...pageResult(rows.map((r) => this.shape(r)), total, query),
        summary: {
          total,
          byChannel: byChannel.map((r) => ({ channel: r.channel, count: r._count._all })),
          byEvent: byEvent.map((r) => ({ eventKey: r.eventKey, eventLabel: label(r.eventKey), count: r._count._all })).sort((a, b) => b.count - a.count),
        },
      };
    });
  }

  async get(id: string) {
    return this.db.tx(async (tx) => {
      const n = found(await tx.notification.findFirst({ where: { id, tenantId: this.db.tenantId }, include: { notificationDeliveries: { orderBy: { attempt: 'asc' } } } }), 'Notification');
      return {
        ...this.shape(n),
        body: n.body,
        readAt: n.readAt,
        deliveries: n.notificationDeliveries.map((d) => ({ id: d.id, attempt: d.attempt, provider: d.provider, status: d.status, providerMessageId: d.providerMessageId, error: d.error, requestedAt: d.requestedAt, completedAt: d.completedAt })),
      };
    });
  }

  /** Put a FAILED notification back in the queue with a fresh set of attempts. */
  async retry(id: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const locked = await tx.$queryRaw<Array<{ status: string }>>`SELECT "status"::text AS status FROM "notifications" WHERE "id" = ${id}::uuid AND "tenantId" = ${tenantId}::uuid FOR UPDATE`;
      if (!locked.length) throw Errors.notFound('Notification');
      if (locked[0].status !== 'FAILED') {
        throw Errors.conflict('NOT_RETRYABLE', locked[0].status === 'SUPPRESSED' ? 'This notification was not sent because of the recipient\'s preferences or a limit. It cannot be retried.' : 'Only failed notifications can be retried.');
      }
      const n = await tx.notification.update({ where: { id }, data: { status: 'QUEUED' } });
      if (EXTERNAL_CHANNELS.includes(n.channel)) await this.usage.record('notifications', 1, tx);
      await tx.reminderDispatch.updateMany({ where: { tenantId, notificationId: id, status: 'FAILED' }, data: { status: 'SENT', detail: 'Retried manually.' } });
      await this.audit.log({ action: 'notification.retried', resourceType: 'Notification', resourceId: id, summary: `${n.eventKey} / ${n.channel}` }, tx);
      this.db.afterCommit(() => this.jobs.enqueue(DELIVER_JOB, { tenantId, notificationId: id }, { jobId: `notif-${id}-retry-${Date.now()}` }));
      return { id, status: 'QUEUED' as const };
    });
  }

  /** Which provider serves each channel and whether it can send. Never returns credentials. */
  channels() {
    return this.db.tx((tx) => this.providers.status(tx));
  }

  // ------------------------------------------------------------------ settings
  private view(settings: NotificationSettings) {
    return {
      rateLimitPerHour: settings.rateLimitPerHour,
      events: EVENT_DEFINITIONS.map((d) => ({
        eventKey: d.key,
        label: d.label,
        group: d.group,
        audience: d.audience,
        /** Account-security messages are always sent on the channel the flow needs. */
        locked: d.group === 'security',
        channels: Object.fromEntries(CHANNELS.filter((c) => d.templates[c] || (c === 'PUSH' && d.templates.IN_APP) || settings.events[d.key]?.[c] !== undefined).map((c) => [c, channelEnabled(settings, d.key, c)])) as Partial<Record<Channel, boolean>>,
      })),
    };
  }
  async getSettings() {
    return this.db.tx(async (tx) => {
      const tenant = await tx.tenant.findFirstOrThrow({ where: { id: this.db.tenantId }, select: { settings: true } });
      return this.view(parseSettings(tenant.settings));
    });
  }
  async updateSettings(input: NotificationSettingsInput) {
    for (const key of Object.keys(input.events ?? {})) if (!eventDefinition(key)) throw Errors.unprocessable('UNKNOWN_EVENT', `"${key}" is not a notification event.`);
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      // Lock the tenant row so two concurrent settings changes are applied one after the other.
      const rows = await tx.$queryRaw<Array<{ settings: unknown }>>`SELECT "settings" FROM "tenants" WHERE "id" = ${tenantId}::uuid FOR UPDATE`;
      const current = parseSettings(rows[0]?.settings);
      const next: NotificationSettings = { rateLimitPerHour: input.rateLimitPerHour ?? current.rateLimitPerHour, events: { ...current.events } };
      for (const [key, channels] of Object.entries(input.events ?? {})) next.events[key] = { ...(next.events[key] ?? {}), ...channels };
      await saveSettings(tx, tenantId, next);
      await this.audit.log({ action: 'notification.settings_updated', resourceType: 'Tenant', resourceId: tenantId, before: current, after: input }, tx);
      return this.view(next);
    });
  }
  setEventChannel(eventKey: string, channel: Channel, enabled: boolean) {
    return this.updateSettings({ events: { [eventKey]: { [channel]: enabled } } });
  }
}
