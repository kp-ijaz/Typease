import { Injectable } from '@nestjs/common';
import { NOTIFICATION_GROUPS } from '@typease/validation';
import type { InboxQuery, NotificationPreferencesInput, RegisterDeviceInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { TenantDb } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { pageArgs, pageResult } from '../../common/pagination';
import { CHANNELS } from './catalogue';

/** What every signed-in member sees: the in-app inbox, own preferences and own devices. */
@Injectable()
export class InboxService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
  ) {}

  private userId(): string {
    const id = ctx().userId;
    if (!id) throw Errors.unauthorized();
    return id;
  }

  async list(query: InboxQuery) {
    const userId = this.userId();
    return this.db.tx(async (tx) => {
      const mine = { tenantId: this.db.tenantId, recipientUserId: userId, channel: 'IN_APP' as const, status: { not: 'SUPPRESSED' as const } };
      const where = { ...mine, ...(query.unreadOnly ? { readAt: null } : {}) };
      const rows = await tx.notification.findMany({
        where,
        ...pageArgs(query, ['createdAt'] as const, 'createdAt:desc'),
        select: { id: true, eventKey: true, subject: true, body: true, language: true, relatedType: true, relatedId: true, readAt: true, createdAt: true },
      });
      const total = await tx.notification.count({ where });
      const unreadCount = await tx.notification.count({ where: { ...mine, readAt: null } });
      return { ...pageResult(rows, total, query), unreadCount };
    });
  }
  async markRead(id: string) {
    const userId = this.userId();
    return this.db.tx(async (tx) => {
      const n = found(await tx.notification.findFirst({ where: { id, tenantId: this.db.tenantId, recipientUserId: userId, channel: 'IN_APP' }, select: { id: true, readAt: true } }), 'Notification');
      const readAt = n.readAt ?? new Date();
      if (!n.readAt) await tx.notification.update({ where: { id }, data: { readAt } });
      return { id, readAt };
    });
  }
  async markAllRead() {
    const userId = this.userId();
    return this.db.tx(async (tx) => {
      const r = await tx.notification.updateMany({ where: { tenantId: this.db.tenantId, recipientUserId: userId, channel: 'IN_APP', readAt: null }, data: { readAt: new Date() } });
      return { updated: r.count };
    });
  }

  // ------------------------------------------------------------------ preferences
  /** Customers' choices belong to the customer record (whoever signs in for it); staff and company users have their own. */
  private subject() {
    const c = ctx();
    return c.customerId ? { customerId: c.customerId, userId: null } : { customerId: null, userId: this.userId() };
  }
  async preferences() {
    const subject = this.subject();
    return this.db.tx(async (tx) => {
      const rows = await tx.notificationPreference.findMany({ where: { tenantId: this.db.tenantId, ...subject }, orderBy: [{ channel: 'asc' }, { eventGroup: 'asc' }], select: { channel: true, eventGroup: true, enabled: true, updatedAt: true } });
      const customer = subject.customerId ? await tx.customer.findFirst({ where: { id: subject.customerId, tenantId: this.db.tenantId }, select: { communicationPrefs: true } }) : null;
      return {
        channels: CHANNELS,
        groups: NOTIFICATION_GROUPS,
        /** General channel switches recorded on the customer profile; an explicit preference below wins. */
        channelDefaults: (customer?.communicationPrefs ?? null) as Record<string, boolean> | null,
        preferences: rows,
        note: 'Account-security messages (verification, password reset, one-time codes) are always sent.',
      };
    });
  }
  async updatePreferences(input: NotificationPreferencesInput) {
    const subject = this.subject();
    await this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      for (const pref of input.preferences) {
        const existing = await tx.notificationPreference.findFirst({ where: { tenantId, ...subject, channel: pref.channel, eventGroup: pref.eventGroup } });
        if (existing) await tx.notificationPreference.update({ where: { id: existing.id }, data: { enabled: pref.enabled } });
        else await tx.notificationPreference.create({ data: { tenantId, ...subject, channel: pref.channel, eventGroup: pref.eventGroup, enabled: pref.enabled } });
      }
      // Opt-in / opt-out is a consent-relevant decision: keep the evidence.
      await this.audit.log({ action: 'notification.preferences_updated', resourceType: subject.customerId ? 'Customer' : 'User', resourceId: subject.customerId ?? subject.userId, after: input.preferences }, tx);
    });
    return this.preferences();
  }

  // ------------------------------------------------------------------ push devices
  async registerDevice(input: RegisterDeviceInput) {
    const userId = this.userId();
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      // A device belongs to whoever is signed in on it now.
      const existing = await tx.deviceToken.findFirst({ where: { tenantId, token: input.token } });
      const row = existing
        ? await tx.deviceToken.update({ where: { id: existing.id }, data: { userId, platform: input.platform, lastSeenAt: new Date() } })
        : await tx.deviceToken.create({ data: { tenantId, userId, platform: input.platform, token: input.token } });
      return { id: row.id, platform: row.platform, registeredAt: row.createdAt, lastSeenAt: row.lastSeenAt };
    });
  }
  async removeDevice(token: string) {
    const userId = this.userId();
    return this.db.tx(async (tx) => {
      const r = await tx.deviceToken.deleteMany({ where: { tenantId: this.db.tenantId, userId, token } });
      return { removed: r.count };
    });
  }
  async devices() {
    const userId = this.userId();
    return this.db.tx((tx) => tx.deviceToken.findMany({ where: { tenantId: this.db.tenantId, userId }, select: { id: true, platform: true, createdAt: true, lastSeenAt: true }, orderBy: { lastSeenAt: 'desc' } }));
  }
}
