import { Injectable, Logger } from '@nestjs/common';
import { env } from '../../config/env';
import { AuditService } from '../../common/audit.service';
import { runAsTenant } from '../../common/context';
import { decryptJson, encryptJson } from '../../common/crypto';
import { TenantDb } from '../../common/db/prisma.service';
import { JobMeta, JobQueue } from '../../common/jobs/job-queue';
import type { TransactionalMessage } from '../../common/messenger';
import { UsageService } from '../../common/usage.service';
import { Channel, EXTERNAL_CHANNELS } from './catalogue';
import { DELIVER_JOB, NotificationService } from './notification.service';
import { ProviderChannel, ProviderRegistry, ResolvedProvider } from './providers/registry';
import { brief, OutboundMessage, ProviderError } from './providers/types';
import { emailLayout, escapeHtml, renderHtmlBody, renderSubject, renderText, TemplateData } from './render';
import { brandOf, effectiveTemplate, TemplateService } from './template.service';
import { pushPayload } from './push-payload';

export const DIRECT_JOB = 'notifications.send_direct';
export const MAINTENANCE_JOB = 'notifications.maintenance';
/** An attempt that has been PENDING for longer than this is considered interrupted. */
const IN_FLIGHT_MS = 120_000;
const STUCK_AFTER_MS = 10 * 60_000;

interface Claim {
  notification: {
    id: string;
    channel: Channel;
    language: string;
    eventKey: string;
    subject: string | null;
    body: string;
    data: Record<string, any>;
    recipientAddress: string | null;
    recipientUserId: string | null;
    relatedType: string | null;
    relatedId: string | null;
  };
  deliveryId: string;
  resolved?: ResolvedProvider;
  providerError?: unknown;
  sender: { name: string | null; address: string | null; verified: boolean };
  deviceTokens: Array<{ id: string; token: string }>;
}

/**
 * Delivery pipeline: notification (QUEUED) -> job `notifications.deliver` ->
 * one `notification_deliveries` row per attempt -> SENT or FAILED.
 *
 * Exactly-once guard: every attempt first CLAIMS the notification inside a
 * transaction that locks the row and checks its status. A notification that is
 * no longer QUEUED (already sent, failed for good, suppressed) is never sent
 * again, and two workers holding the same job cannot both send because the
 * second one sees the first one's PENDING attempt. The provider call itself
 * runs outside any transaction.
 */
@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);

  constructor(
    private readonly db: TenantDb,
    private readonly jobs: JobQueue,
    private readonly audit: AuditService,
    private readonly usage: UsageService,
    private readonly providers: ProviderRegistry,
    private readonly templates: TemplateService,
    private readonly notifications: NotificationService,
  ) {}

  // ------------------------------------------------------------------ job: deliver one notification
  async deliver(notificationId: string, meta: JobMeta): Promise<void> {
    const tenantId = this.db.tenantId;
    const claim = await this.db.tx(async (tx): Promise<Claim | null> => {
      const locked = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT "status"::text AS status FROM "notifications" WHERE "id" = ${notificationId}::uuid AND "tenantId" = ${tenantId}::uuid FOR UPDATE`;
      if (!locked.length || locked[0].status !== 'QUEUED') return null;
      const n = await tx.notification.findFirstOrThrow({ where: { id: notificationId, tenantId } });
      if (n.channel === 'IN_APP') {
        await tx.notification.update({ where: { id: n.id }, data: { status: 'SENT', sentAt: new Date() } });
        return null;
      }
      const deliveries = await tx.notificationDelivery.findMany({ where: { tenantId, notificationId }, orderBy: { attempt: 'asc' } });
      const now = Date.now();
      // Another worker is sending right now: leave it alone.
      if (deliveries.some((d) => d.status === 'PENDING' && now - d.requestedAt.getTime() < IN_FLIGHT_MS)) return null;
      const stale = deliveries.filter((d) => d.status === 'PENDING');
      if (stale.length) {
        await tx.notificationDelivery.updateMany({
          where: { id: { in: stale.map((d) => d.id) } },
          data: { status: 'FAILED', error: 'The attempt did not finish (the worker was interrupted).', completedAt: new Date() },
        });
      }
      let resolved: ResolvedProvider | undefined;
      let providerError: unknown;
      try {
        resolved = await this.providers.resolve(n.channel as ProviderChannel, tx);
      } catch (e) {
        providerError = e;
      }
      const delivery = await tx.notificationDelivery.create({
        data: { tenantId, notificationId, provider: resolved?.provider.name ?? 'none', attempt: (deliveries.at(-1)?.attempt ?? 0) + 1, status: 'PENDING' },
      });
      const branding = n.channel === 'EMAIL' ? await tx.brandingSettings.findFirst({ where: { tenantId, branchId: null }, select: { emailFromName: true, emailFromAddress: true, emailSenderVerified: true } }) : null;
      const deviceTokens = n.channel === 'PUSH' && n.recipientUserId ? await tx.deviceToken.findMany({ where: { tenantId, userId: n.recipientUserId }, select: { id: true, token: true } }) : [];
      return {
        notification: { id: n.id, channel: n.channel, language: n.language, eventKey: n.eventKey, subject: n.subject, body: n.body, data: (n.data ?? {}) as Record<string, any>, recipientAddress: n.recipientAddress, recipientUserId: n.recipientUserId, relatedType: n.relatedType, relatedId: n.relatedId },
        deliveryId: delivery.id,
        resolved,
        providerError,
        sender: { name: branding?.emailFromName ?? null, address: branding?.emailFromAddress ?? null, verified: branding?.emailSenderVerified === true },
        deviceTokens,
      };
    });
    if (!claim) return;

    let providerMessageId: string | null = null;
    let error: unknown;
    const deadTokenIds: string[] = [];
    try {
      if (claim.providerError) throw claim.providerError;
      providerMessageId = await this.send(tenantId, claim, deadTokenIds);
    } catch (e) {
      error = e;
    }
    const retryable = !(error instanceof ProviderError) || error.retryable;
    const final = !!error && (!retryable || meta.attempt >= meta.maxAttempts);
    const message = error ? brief(error instanceof ProviderError ? error.message : `Unexpected error: ${(error as any)?.message ?? error}`, 500) : null;

    await this.db.tx(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "notifications" WHERE "id" = ${notificationId}::uuid AND "tenantId" = ${tenantId}::uuid FOR UPDATE`;
      await tx.notificationDelivery.update({
        where: { id: claim.deliveryId },
        data: { status: error ? 'FAILED' : 'SENT', providerMessageId, error: message, completedAt: new Date() },
      });
      if (deadTokenIds.length) await tx.deviceToken.deleteMany({ where: { tenantId, id: { in: deadTokenIds } } });
      if (!error) {
        const { secure: _secure, ...rest } = claim.notification.data;
        await tx.notification.updateMany({ where: { id: notificationId, tenantId, status: 'QUEUED' }, data: { status: 'SENT', sentAt: new Date(), data: rest } });
      } else if (final) {
        const changed = await tx.notification.updateMany({ where: { id: notificationId, tenantId, status: 'QUEUED' }, data: { status: 'FAILED' } });
        if (changed.count) {
          // The message never left: give the plan allowance back.
          if (EXTERNAL_CHANNELS.includes(claim.notification.channel)) await this.usage.record('notifications', -1, tx);
          await tx.reminderDispatch.updateMany({ where: { tenantId, notificationId }, data: { status: 'FAILED', detail: message } });
        }
      }
    });
    if (error && !final) throw error instanceof Error ? error : new Error(String(error));
    if (error) this.logger.warn(`notification ${notificationId} failed for good: ${message}`);
  }

  /** Builds the provider message and sends it. Returns the provider's message id. */
  private async send(tenantId: string, claim: Claim, deadTokenIds: string[]): Promise<string | null> {
    const n = claim.notification;
    const resolved = claim.resolved!;
    // Account-security messages keep their real content encrypted until now.
    const secure: { subject?: string | null; text: string; html?: string; wa?: any } | null = n.data.secure ? decryptJson(n.data.secure) : null;
    const subject = secure ? (secure.subject ?? null) : n.subject;
    const text = secure ? secure.text : n.body;
    const base: OutboundMessage = { notificationId: n.id, to: n.recipientAddress ?? '', subject, text };

    if (n.channel === 'EMAIL') {
      if (!n.recipientAddress) throw new ProviderError('The notification has no email address.', false, 'NO_ADDRESS');
      const brand = await this.templates.brand(tenantId, n.language);
      const inner = (secure ? secure.html : n.data.html) ?? `<p style="margin:0 0 16px 0;line-height:1.6">${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
      const e = env();
      // A centre's own address is used only after its sender domain was verified; otherwise the
      // platform sender with the centre's name. A centre's own mail server sends from its own address.
      const ownAddress = resolved.source === 'TENANT' ? (resolved.settings.fromAddress ?? (claim.sender.verified ? claim.sender.address : null)) : claim.sender.verified ? claim.sender.address : null;
      const from = { name: claim.sender.name ?? (resolved.source === 'TENANT' ? resolved.settings.fromName : null) ?? brand.name, address: String(ownAddress ?? e.MAIL_FROM_ADDRESS) };
      const result = await resolved.provider.send({ ...base, html: emailLayout({ innerHtml: inner, subject: subject ?? '', language: n.language, brand }), from, replyTo: brand.supportEmail ?? null });
      return result.providerMessageId ?? null;
    }
    if (n.channel === 'SMS') {
      if (!n.recipientAddress) throw new ProviderError('The notification has no phone number.', false, 'NO_ADDRESS');
      return (await resolved.provider.send(base)).providerMessageId ?? null;
    }
    if (n.channel === 'WHATSAPP') {
      const wa = secure ? secure.wa : n.data.wa;
      if (!n.recipientAddress) throw new ProviderError('The notification has no phone number.', false, 'NO_ADDRESS');
      if (!wa?.templateName) throw new ProviderError('An approved WhatsApp template is required for this message.', false, 'WHATSAPP_TEMPLATE_REQUIRED');
      const languageCode = String(resolved.settings.languageCodes?.[n.language] ?? n.language);
      return (await resolved.provider.send({ ...base, whatsapp: { templateName: wa.templateName, languageCode, parameters: wa.parameters ?? [] } })).providerMessageId ?? null;
    }
    // PUSH: one message per registered device of the user.
    if (!claim.deviceTokens.length) throw new ProviderError('The person has no registered device.', false, 'NO_DEVICE');
    const pushData = pushPayload(n);
    const ids: string[] = [];
    let lastError: unknown;
    for (const device of claim.deviceTokens) {
      try {
        const result = await resolved.provider.send({ ...base, to: device.token, pushData });
        if (result.providerMessageId) ids.push(result.providerMessageId);
        else ids.push('sent');
      } catch (e) {
        if (e instanceof ProviderError && e.code === 'UNREGISTERED') deadTokenIds.push(device.id);
        else lastError = e;
      }
    }
    if (ids.length) return ids[0];
    if (lastError) throw lastError;
    throw new ProviderError('None of the registered devices accepts notifications any more.', false, 'UNREGISTERED');
  }

  // ------------------------------------------------------------------ account-security messages (Messenger port)
  /**
   * Transport plugged into `Messenger`. With a tenant the message becomes a
   * normal notification (delivery log, retries, the centre's templates and
   * providers). Without one it is queued for direct delivery with the platform
   * defaults. Never throws: sign-up and password flows must not fail because
   * a provider is down - the failure is recorded and retried instead.
   */
  async sendTransactional(message: TransactionalMessage): Promise<void> {
    try {
      if (message.tenantId) {
        const data: TemplateData = { ...message.data };
        await runAsTenant(
          message.tenantId,
          () =>
            this.notifications.notify({
              eventKey: message.eventKey,
              recipient: { kind: 'ADDRESS', channel: message.channel, address: message.to, name: typeof data.name === 'string' ? data.name : null, language: message.language ?? null },
              data,
              channels: [message.channel],
              force: true,
            }),
          { actorLabel: 'messenger' },
        );
        return;
      }
      await this.jobs.enqueue<{ enc: string; tenantId?: null }>(DIRECT_JOB, { enc: encryptJson({ eventKey: message.eventKey, channel: message.channel, to: message.to, language: message.language ?? 'en', data: message.data }) }, { attempts: 5, backoffMs: 15_000 });
    } catch (e: any) {
      this.logger.error(`account message ${message.eventKey} could not be queued: ${e?.message ?? e}`);
      await this.audit.security('NOTIFICATION_QUEUE_FAILED', 'HIGH', { eventKey: message.eventKey, channel: message.channel }, message.tenantId ?? null);
    }
  }

  /** Job: platform-level message (no tenant): platform default template and provider. */
  async sendDirect(payload: { enc: string }, meta: JobMeta): Promise<void> {
    const message = decryptJson<{ eventKey: string; channel: 'EMAIL' | 'SMS'; to: string; language: string; data: TemplateData }>(payload.enc);
    try {
      const template = effectiveTemplate(await this.templates.platformRows(message.eventKey), message.eventKey, message.channel, message.language);
      if (!template) throw new ProviderError(`No platform template exists for ${message.eventKey} (${message.channel}).`, false, 'TEMPLATE_MISSING');
      const brand = brandOf(null, env().MAIL_FROM_NAME);
      const data: TemplateData = { ...message.data, ...this.templates.commonData(brand) };
      const subject = template.subject ? renderSubject(template.subject, data) : null;
      const text = renderText(template.body, data);
      const { provider } = this.providers.platform(message.channel);
      await provider.send({
        to: message.to,
        subject,
        text,
        ...(message.channel === 'EMAIL'
          ? { html: emailLayout({ innerHtml: renderHtmlBody(template.body, data, brand.colors.secondary), subject: subject ?? '', language: template.language, brand }), from: { name: env().MAIL_FROM_NAME, address: env().MAIL_FROM_ADDRESS } }
          : {}),
      });
    } catch (e: any) {
      const retryable = !(e instanceof ProviderError) || e.retryable;
      if (retryable && meta.attempt < meta.maxAttempts) throw e;
      this.logger.error(`platform message ${message.eventKey} (${message.channel}) was NOT delivered: ${brief(e?.message)}`);
      await this.audit.security('NOTIFICATION_DELIVERY_FAILED', 'HIGH', { eventKey: message.eventKey, channel: message.channel, error: brief(e?.message) }, null);
    }
  }

  // ------------------------------------------------------------------ job: maintenance (per tenant)
  /**
   * Safety net, run for each tenant every few minutes:
   *  - re-queues notifications that are still QUEUED long after creation (the
   *    enqueue after commit was lost, or a worker died between attempts);
   *  - removes encrypted account-message payloads that are no longer needed.
   */
  async maintain(now = new Date()): Promise<{ requeued: number }> {
    const tenantId = this.db.tenantId;
    const cutoff = new Date(now.getTime() - STUCK_AFTER_MS);
    const stuck = await this.db.tx(async (tx) => {
      await tx.$executeRaw`
        UPDATE "notifications" SET "data" = "data" - 'secure'
        WHERE "tenantId" = ${tenantId}::uuid AND "status" <> 'QUEUED' AND "createdAt" < ${new Date(now.getTime() - 86_400_000)} AND "data" ? 'secure'`;
      const rows = await tx.notification.findMany({
        where: { tenantId, status: 'QUEUED', channel: { not: 'IN_APP' }, createdAt: { lt: cutoff } },
        select: { id: true, notificationDeliveries: { select: { requestedAt: true }, orderBy: { requestedAt: 'desc' }, take: 1 } },
        orderBy: { createdAt: 'asc' },
        take: 200,
      });
      return rows.filter((r) => !r.notificationDeliveries.length || r.notificationDeliveries[0].requestedAt < cutoff).map((r) => r.id);
    });
    const bucket = Math.floor(now.getTime() / STUCK_AFTER_MS);
    for (const id of stuck) await this.jobs.enqueue(DELIVER_JOB, { tenantId, notificationId: id }, { jobId: `notif-${id}-sweep-${bucket}` });
    return { requeued: stuck.length };
  }
}
