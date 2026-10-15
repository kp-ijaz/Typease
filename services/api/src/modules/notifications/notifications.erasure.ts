import { Injectable, OnModuleInit } from '@nestjs/common';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { Prisma } from '@typease/database';
import { ERASED_TEXT, ErasureRegistry, ErasureReport, ErasureSubject, identifierPattern, scrubJson, scrubText } from '../../common/erasure';

/**
 * Erasure step of the notifications module. The history of what was sent to the person stays as
 * a delivery statistic (event, channel, status, time) but loses its content: subject, text, the
 * rendered payload, the address it went to and provider error texts. Their notification
 * preferences and registered devices are removed.
 */
@Injectable()
export class NotificationsErasure implements OnModuleInit {
  constructor(
    private readonly db: TenantDb,
    private readonly erasure: ErasureRegistry,
  ) {}

  onModuleInit() {
    this.erasure.register('notifications', (tx, subject) => this.erase(tx, subject));
  }

  async erase(tx: Tx, subject: ErasureSubject): Promise<ErasureReport> {
    const tenantId = this.db.tenantId;
    // Messages addressed to the person: through their customer record, or straight to their email address / phone
    // number (account messages such as a verification link or an invitation).
    const addresses = [...new Set([...subject.identifiers.emails.map((e) => e.toLowerCase()), ...subject.identifiers.emails, ...subject.identifiers.phones])];
    const rows = await tx.notification.findMany({
      where: { tenantId, OR: [{ recipientCustomerId: { in: subject.customerIds } }, ...(addresses.length ? [{ recipientAddress: { in: addresses } }] : [])] },
      select: { id: true },
    });
    for (const row of rows) {
      // The dedupe key embeds the address the message went to; the replacement still stops a repeated event from creating a new row.
      await tx.notification.update({ where: { id: row.id }, data: { subject: null, body: ERASED_TEXT, data: {}, recipientAddress: null, dedupeKey: `erased:${row.id}` } });
    }
    const ids = rows.map((r) => r.id);
    if (ids.length) await tx.notificationDelivery.updateMany({ where: { tenantId, notificationId: { in: ids }, error: { not: null } }, data: { error: null } });
    // Messages to staff ABOUT the person (a request assigned, a ticket opened ...): they stay readable, without the person's name and details.
    const pattern = identifierPattern(subject.identifiers);
    const about = subject.resourceIds.length
      ? await tx.notification.findMany({ where: { tenantId, relatedId: { in: subject.resourceIds }, id: { notIn: ids } }, select: { id: true, subject: true, body: true, data: true } })
      : [];
    let mentions = 0;
    for (const row of about) {
      const next = { subject: scrubText(row.subject, pattern), body: scrubText(row.body, pattern), data: scrubJson(row.data, pattern) };
      if (next.subject === row.subject && next.body === row.body && JSON.stringify(next.data) === JSON.stringify(row.data)) continue;
      await tx.notification.update({ where: { id: row.id }, data: { subject: next.subject, body: next.body, data: next.data as Prisma.InputJsonValue } });
      mentions += 1;
    }
    const preferences = await tx.notificationPreference.deleteMany({ where: { tenantId, customerId: { in: subject.customerIds } } });
    // Devices of the portal logins - unless the same account is also a staff member of this centre and keeps using the app.
    const staff = subject.userIds.length ? await tx.tenantMembership.findMany({ where: { tenantId, userId: { in: subject.userIds }, kind: 'STAFF', status: { not: 'REMOVED' } }, select: { userId: true } }) : [];
    const portalOnly = subject.userIds.filter((id) => !staff.some((m) => m.userId === id));
    const devices = portalOnly.length ? await tx.deviceToken.deleteMany({ where: { tenantId, userId: { in: portalOnly } } }) : { count: 0 };
    return { notifications: rows.length, staffNotifications: mentions, preferences: preferences.count, devices: devices.count };
  }
}
