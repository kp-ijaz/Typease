import { Injectable } from '@nestjs/common';
import type { PlatformStaffReplyInput, PlatformTicketListQuery, PlatformTicketUpdateInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { Prisma, SystemDb } from '../../common/db/prisma.service';
import { DomainEvents } from '../../common/events.service';
import { Errors, found } from '../../common/errors';
import { pageArgs, pageResult } from '../../common/pagination';
import { TICKET_TRANSITIONS, TicketStatus } from './sla';

const SORT = ['createdAt', 'updatedAt', 'priority', 'status'] as const;
const OPEN = ['OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER'] as const;
const label = (status: string) => status.toLowerCase().replace('_', ' ');

/**
 * TypEase support desk: tickets that centres opened to the platform
 * (scope = PLATFORM), across all tenants.
 *
 * This is the one place in the support module that uses the system database
 * connection, because the work is cross-tenant by nature. Every query is pinned
 * to `scope: 'PLATFORM'`, so customer tickets, customers and requests of a
 * centre are unreachable from here: platform staff see the conversation, the
 * centre's name and its plan - nothing else.
 */
@Injectable()
export class PlatformSupportService {
  constructor(
    private readonly sys: SystemDb,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
  ) {}

  private async tenants(ids: string[]) {
    const unique = [...new Set(ids)];
    const rows = unique.length ? await this.sys.client.tenant.findMany({ where: { id: { in: unique } }, select: { id: true, name: true, slug: true, status: true, subscription: { select: { status: true, plan: { select: { key: true, name: true } } } } } }) : [];
    return new Map(rows.map((t) => [t.id, { id: t.id, name: t.name, slug: t.slug, status: t.status, plan: t.subscription ? { key: t.subscription.plan.key, name: t.subscription.plan.name, status: t.subscription.status } : null }]));
  }
  private async staffNames(ids: Array<string | null>) {
    const unique = [...new Set(ids.filter((v): v is string => !!v))];
    const rows = unique.length ? await this.sys.client.user.findMany({ where: { id: { in: unique }, platformRole: { not: null } }, select: { id: true, fullName: true } }) : [];
    return new Map(rows.map((u) => [u.id, u.fullName]));
  }
  private view(row: Prisma.SupportTicketGetPayload<object>, tenants: Awaited<ReturnType<PlatformSupportService['tenants']>>, names: Map<string, string>) {
    return {
      id: row.id,
      ticketNo: row.ticketNo,
      tenant: tenants.get(row.tenantId) ?? null,
      subject: row.subject,
      category: row.category,
      priority: row.priority,
      status: row.status,
      platformAssigneeId: row.platformAssigneeId,
      platformAssigneeName: row.platformAssigneeId ? (names.get(row.platformAssigneeId) ?? null) : null,
      firstRespondedAt: row.firstRespondedAt,
      resolvedAt: row.resolvedAt,
      closedAt: row.closedAt,
      resolutionSummary: row.resolutionSummary,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
  private async one(id: string, db: Pick<Prisma.TransactionClient, 'supportTicket'> = this.sys.client) {
    return found(await db.supportTicket.findFirst({ where: { id, scope: 'PLATFORM' } }), 'Ticket');
  }
  private async detail(id: string) {
    const row = await this.one(id);
    const messages = await this.sys.client.supportMessage.findMany({ where: { ticketId: row.id, tenantId: row.tenantId }, orderBy: { createdAt: 'asc' } });
    return {
      ...this.view(row, await this.tenants([row.tenantId]), await this.staffNames([row.platformAssigneeId])),
      messages: messages.map((m) => ({ id: m.id, fromCentre: m.authorType !== 'PLATFORM', authorType: m.authorType, authorName: m.authorName, visibility: m.visibility, body: m.body, createdAt: m.createdAt })),
    };
  }

  async list(query: PlatformTicketListQuery) {
    const where: Prisma.SupportTicketWhereInput = {
      scope: 'PLATFORM',
      ...(query.status ? { status: query.status } : query.open ? { status: { in: [...OPEN] } } : {}),
      ...(query.tenantId ? { tenantId: query.tenantId } : {}),
      ...(query.priority ? { priority: query.priority } : {}),
      ...(query.assignedToMe ? { platformAssigneeId: ctx().userId } : query.unassigned ? { platformAssigneeId: null } : {}),
      ...(query.q ? { OR: [{ subject: { contains: query.q, mode: 'insensitive' } }, { ticketNo: { contains: query.q, mode: 'insensitive' } }, { tenant: { name: { contains: query.q, mode: 'insensitive' } } }] } : {}),
    };
    const rows = await this.sys.client.supportTicket.findMany({ where, ...pageArgs(query, SORT, 'updatedAt:desc') });
    const total = await this.sys.client.supportTicket.count({ where });
    const tenants = await this.tenants(rows.map((r) => r.tenantId));
    const names = await this.staffNames(rows.map((r) => r.platformAssigneeId));
    return pageResult(rows.map((r) => this.view(r, tenants, names)), total, query);
  }
  get(id: string) {
    return this.detail(id);
  }

  async reply(id: string, input: PlatformStaffReplyInput) {
    const c = ctx();
    const visible = input.visibility === 'CUSTOMER';
    if (!visible && input.status) throw Errors.unprocessable('STATUS_NEEDS_REPLY', 'The status can only be changed together with a reply the centre can see.');
    const tenantId = await this.sys.tx(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "support_tickets" WHERE "id" = ${id}::uuid AND "scope" = 'PLATFORM' FOR UPDATE`;
      if (!locked.length) throw Errors.notFound('Ticket');
      const ticket = await this.one(id, tx);
      if (visible && ticket.status === 'CLOSED') throw Errors.conflict('TICKET_CLOSED', 'This ticket is closed. Add an internal note, or ask the centre to open a new ticket.');
      const now = new Date();
      await tx.supportMessage.create({ data: { tenantId: ticket.tenantId, ticketId: ticket.id, authorUserId: c.userId ?? null, authorType: 'PLATFORM', authorName: c.actorLabel ?? 'TypEase Support', body: input.body, visibility: input.visibility, attachments: [] } });
      if (visible) {
        const from = ticket.status as TicketStatus;
        const to: TicketStatus = input.status ?? (from === 'OPEN' ? 'IN_PROGRESS' : from);
        if (to !== from && !TICKET_TRANSITIONS[from].includes(to)) throw Errors.conflict('INVALID_TRANSITION', `A ticket that is ${label(from)} cannot be set to ${label(to)}.`, { from, to });
        await tx.supportTicket.update({
          where: { id: ticket.id },
          data: {
            status: to,
            firstRespondedAt: ticket.firstRespondedAt ?? now,
            platformAssigneeId: ticket.platformAssigneeId ?? c.userId ?? null,
            ...(to === 'RESOLVED' && from !== 'RESOLVED' ? { resolvedAt: now, resolutionSummary: input.resolutionSummary ?? ticket.resolutionSummary } : {}),
          },
        });
      }
      return ticket.tenantId;
    });
    await this.audit.logSystem({ action: visible ? 'platform_ticket.replied' : 'platform_ticket.note_added', resourceType: 'SupportTicket', resourceId: id }, tenantId);
    // The centre is told through the normal notification pipeline (in its own tenant context).
    await this.events.emitSystem('ticket.replied', { ticketId: id, customerId: null, authorType: 'PLATFORM', visibility: input.visibility }, tenantId);
    return this.detail(id);
  }

  async update(id: string, input: PlatformTicketUpdateInput) {
    const result = await this.sys.tx(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "support_tickets" WHERE "id" = ${id}::uuid AND "scope" = 'PLATFORM' FOR UPDATE`;
      if (!locked.length) throw Errors.notFound('Ticket');
      const before = await this.one(id, tx);
      const data: Prisma.SupportTicketUncheckedUpdateInput = {};
      if (input.platformAssigneeId !== undefined && input.platformAssigneeId !== before.platformAssigneeId) {
        if (input.platformAssigneeId) {
          const user = await tx.user.findFirst({ where: { id: input.platformAssigneeId, platformRole: { not: null }, status: 'ACTIVE', deletedAt: null }, select: { id: true } });
          if (!user) throw Errors.unprocessable('NOT_PLATFORM_STAFF', 'Tickets can only be assigned to active TypEase support staff.');
        }
        data.platformAssigneeId = input.platformAssigneeId;
      }
      if (input.priority && input.priority !== before.priority) data.priority = input.priority;
      if (input.status && input.status !== before.status) {
        const from = before.status as TicketStatus;
        const to = input.status as TicketStatus;
        if (!TICKET_TRANSITIONS[from].includes(to)) throw Errors.conflict('INVALID_TRANSITION', `A ticket that is ${label(from)} cannot be set to ${label(to)}.`, { from, to });
        const now = new Date();
        data.status = to;
        if (to === 'RESOLVED') Object.assign(data, { resolvedAt: now, resolutionSummary: input.resolutionSummary ?? before.resolutionSummary });
        if (to === 'CLOSED') Object.assign(data, { closedAt: now, resolvedAt: before.resolvedAt ?? now, resolutionSummary: input.resolutionSummary ?? before.resolutionSummary });
        if (from === 'RESOLVED' && to === 'IN_PROGRESS') data.resolvedAt = null;
      } else if (input.resolutionSummary !== undefined) data.resolutionSummary = input.resolutionSummary;
      if (!Object.keys(data).length) return { tenantId: before.tenantId, before, changed: false };
      await tx.supportTicket.update({ where: { id }, data });
      return { tenantId: before.tenantId, before, changed: true, data };
    });
    if (result.changed) {
      await this.audit.logSystem(
        { action: 'platform_ticket.updated', resourceType: 'SupportTicket', resourceId: id, before: { status: result.before.status, priority: result.before.priority, platformAssigneeId: result.before.platformAssigneeId }, after: input },
        result.tenantId,
      );
    }
    return this.detail(id);
  }
}
