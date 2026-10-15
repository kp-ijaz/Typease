import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type {
  CustomerReplyInput, MyTicketsQuery, OpenPlatformTicketInput, OpenTicketInput, PageQueryInput, SlaPoliciesInput, StaffOpenTicketInput, StaffReplyInput,
  SupportSettingsInput, TicketListQuery, TicketStatusInput, UpdateTicketInput,
} from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { authorKindOf } from '../../common/author-display';
import { ctx } from '../../common/context';
import { Prisma, TenantDb, Tx } from '../../common/db/prisma.service';
import { DomainEvents } from '../../common/events.service';
import { Errors, found } from '../../common/errors';
import { assertCustomerNotErased, isErasedCustomer } from '../../common/customer-ref';
import { JobQueue } from '../../common/jobs/job-queue';
import { pageArgs, pageResult } from '../../common/pagination';
import { SequenceService } from '../../common/sequence.service';
import { TenantDirectory } from '../../common/tenant-directory';
import { lockTenantSettings, saveTenantSettingsSection } from '../notifications/settings';
import { TasksService } from '../tasks/tasks.service';
import { ProvisioningService } from '../tenancy/provisioning.service';
import { afterCustomerReply, breachState, DEFAULT_SLA, dueTimes, isOpen, parseSupportSettings, PRIORITIES, Priority, SlaTargets, TICKET_TRANSITIONS, TicketStatus } from './sla';

export const SLA_JOB = 'support.sla';
const SORT = ['createdAt', 'updatedAt', 'priority', 'status', 'resolutionDueAt', 'firstResponseDueAt'] as const;
const OPEN = ['OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER'] as const;

const include = { customer: { select: { fullName: true, customerNo: true, status: true } }, request: { select: { requestNo: true } } } as const;
type Row = Prisma.SupportTicketGetPayload<{ include: typeof include }>;
type Message = Prisma.SupportMessageGetPayload<object>;
const label = (status: string) => status.toLowerCase().replace('_', ' ');

/**
 * Support tickets between customers and the centre (scope CUSTOMER), the
 * centre's own tickets to TypEase support as seen from the centre (scope
 * PLATFORM), SLA policies and the SLA job.
 */
@Injectable()
export class SupportService implements OnModuleInit {
  private readonly logger = new Logger(SupportService.name);

  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly sequences: SequenceService,
    private readonly jobs: JobQueue,
    private readonly tenants: TenantDirectory,
    private readonly provisioning: ProvisioningService,
    private readonly tasks: TasksService,
  ) {}

  onModuleInit() {
    // Every centre starts with an SLA policy per priority (existing rows are never overwritten).
    this.provisioning.registerTenantStep('support.sla_policies', async (tx, tenant) => {
      for (const priority of PRIORITIES) {
        const exists = await tx.slaPolicy.findFirst({ where: { tenantId: tenant.id, priority }, select: { id: true } });
        if (!exists) await tx.slaPolicy.create({ data: { tenantId: tenant.id, priority, name: DEFAULT_SLA[priority].name, firstResponseMinutes: DEFAULT_SLA[priority].firstResponseMinutes, resolutionMinutes: DEFAULT_SLA[priority].resolutionMinutes } });
      }
    });
    this.jobs.register(SLA_JOB, async (payload: { now?: string }) => void (await this.tenants.forEachTenant(SLA_JOB, async () => void (await this.runSla(payload?.now ? new Date(payload.now) : new Date())))), { attempts: 1 });
    this.jobs.schedule({ name: SLA_JOB, everySeconds: 600, description: 'Escalate support tickets that breached their SLA and close resolved tickets after the reopen window' });
  }

  // ------------------------------------------------------------------ helpers
  private async targets(tx: Tx, priority: Priority): Promise<SlaTargets | null> {
    const row = await tx.slaPolicy.findFirst({ where: { tenantId: this.db.tenantId, priority } });
    if (!row) return DEFAULT_SLA[priority];
    return row.isActive ? { firstResponseMinutes: row.firstResponseMinutes, resolutionMinutes: row.resolutionMinutes } : null;
  }
  private async settings(tx: Tx) {
    const tenant = await tx.tenant.findFirstOrThrow({ where: { id: this.db.tenantId }, select: { settings: true } });
    return parseSupportSettings(tenant.settings);
  }
  private async lock(tx: Tx, id: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "support_tickets" WHERE "id" = ${id}::uuid AND "tenantId" = ${this.db.tenantId}::uuid FOR UPDATE`;
    if (!rows.length) throw Errors.notFound('Ticket');
  }
  private async attachmentTitles(tx: Tx, messages: Message[]) {
    const ids = [...new Set(messages.flatMap((m) => m.attachments))];
    const docs = ids.length ? await tx.document.findMany({ where: { tenantId: this.db.tenantId, id: { in: ids } }, select: { id: true, title: true } }) : [];
    return new Map(docs.map((d) => [d.id, d.title]));
  }
  private async staffNames(tx: Tx, membershipIds: Array<string | null>) {
    const ids = [...new Set(membershipIds.filter((v): v is string => !!v))];
    const rows = ids.length ? await tx.tenantMembership.findMany({ where: { tenantId: this.db.tenantId, id: { in: ids } }, select: { id: true, user: { select: { fullName: true } } } }) : [];
    return new Map(rows.map((r) => [r.id, r.user.fullName]));
  }

  private staffView(row: Row, names: Map<string, string>, now = new Date()) {
    return {
      id: row.id,
      ticketNo: row.ticketNo,
      scope: row.scope,
      subject: row.subject,
      category: row.category,
      priority: row.priority,
      status: row.status,
      customerId: row.customerId,
      customerName: row.customer?.fullName ?? null,
      customerErased: isErasedCustomer(row.customer),
      customerNo: row.customer?.customerNo ?? null,
      requestId: row.requestId,
      requestNo: row.request?.requestNo ?? null,
      assigneeId: row.assigneeId,
      assigneeName: row.assigneeId ? (names.get(row.assigneeId) ?? null) : null,
      firstResponseDueAt: row.firstResponseDueAt,
      resolutionDueAt: row.resolutionDueAt,
      firstRespondedAt: row.firstRespondedAt,
      resolvedAt: row.resolvedAt,
      closedAt: row.closedAt,
      resolutionSummary: row.resolutionSummary,
      ...breachState(row as any, now),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
  private staffMessages(messages: Message[], titles: Map<string, string>) {
    return messages.map((m) => ({
      id: m.id,
      authorType: m.authorType,
      authorKind: authorKindOf(m.authorType),
      authorUserId: m.authorUserId,
      authorName: m.authorName,
      visibility: m.visibility,
      body: m.body,
      attachments: m.attachments.map((documentId) => ({ documentId, title: titles.get(documentId) ?? null })),
      createdAt: m.createdAt,
    }));
  }
  /** What the person who asked sees: no internal notes, no staff identities, no SLA internals. */
  private requesterView(row: Row, reopenWindowDays: number, now = new Date()) {
    const replyable = afterCustomerReply(row.status as TicketStatus, row.resolvedAt, reopenWindowDays, now) !== 'CLOSED';
    return {
      id: row.id,
      ticketNo: row.ticketNo,
      subject: row.subject,
      category: row.category,
      status: row.status,
      requestId: row.requestId,
      requestNo: row.request?.requestNo ?? null,
      resolvedAt: row.resolvedAt,
      closedAt: row.closedAt,
      resolutionSummary: row.resolutionSummary,
      canReply: replyable,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
  /**
   * Messages as the person who asked sees them. The other side is anonymous: no name at all (stricter than the
   * first-name rule for request comments), only the role-neutral `authorKind` - `STAFF` for the centre answering
   * a customer, `PLATFORM` for TypEase answering a centre.
   */
  private requesterMessages(messages: Message[], titles: Map<string, string>, ownSide: string[]) {
    const customerTicket = ownSide.includes('CUSTOMER');
    return messages
      .filter((m) => m.visibility === 'CUSTOMER')
      .map((m) => {
        const mine = ownSide.includes(m.authorType);
        const authorKind = customerTicket ? (mine ? ('CUSTOMER' as const) : ('STAFF' as const)) : mine ? ('STAFF' as const) : ('PLATFORM' as const);
        return { id: m.id, fromSupport: !mine, authorKind, authorName: mine ? m.authorName : null, body: m.body, attachments: m.attachments.map((documentId) => ({ documentId, title: titles.get(documentId) ?? null })), createdAt: m.createdAt };
      });
  }

  /** Documents attached by a customer must be their own; staff may only share with the customer what the customer may see. */
  private async assertAttachments(tx: Tx, ids: string[], rule: { ownerCustomerId?: string | null; ownerCorporateAccountId?: string | null; customerVisibleFor?: string | null }) {
    if (!ids.length) return;
    const unique = [...new Set(ids)];
    const docs = await tx.document.findMany({ where: { tenantId: this.db.tenantId, id: { in: unique }, deletedAt: null, status: { not: 'DELETED' } }, select: { id: true, customerId: true, corporateAccountId: true, customerVisible: true } });
    if (docs.length !== unique.length) throw Errors.notFound('Document');
    for (const doc of docs) {
      if (rule.ownerCustomerId !== undefined || rule.ownerCorporateAccountId !== undefined) {
        const own = (!!rule.ownerCustomerId && doc.customerId === rule.ownerCustomerId) || (!!rule.ownerCorporateAccountId && doc.corporateAccountId === rule.ownerCorporateAccountId);
        // Somebody else's document is indistinguishable from a missing one.
        if (!own) throw Errors.notFound('Document');
      }
      if (rule.customerVisibleFor !== undefined && (doc.customerId !== rule.customerVisibleFor || !doc.customerVisible)) {
        throw Errors.unprocessable('ATTACHMENT_NOT_SHAREABLE', 'Only documents that belong to this customer and are visible to them can be attached to a reply the customer will see.');
      }
    }
  }

  private async createTicket(
    tx: Tx,
    input: { scope: 'CUSTOMER' | 'PLATFORM'; customerId: string | null; requestId: string | null; subject: string; category?: string | null; priority: Priority; assigneeId?: string | null; message: string; attachments: string[] },
  ): Promise<Row> {
    const tenantId = this.db.tenantId;
    const c = ctx();
    const now = new Date();
    // TypEase support has its own service levels: a centre's policies only apply to its customers' tickets.
    const due = input.scope === 'CUSTOMER' ? dueTimes(now, await this.targets(tx, input.priority)) : { firstResponseDueAt: null, resolutionDueAt: null };
    const ticket = await tx.supportTicket.create({
      data: {
        tenantId,
        ticketNo: await this.sequences.next(tx, 'ticket'),
        scope: input.scope,
        customerId: input.customerId,
        requestId: input.requestId,
        raisedByUserId: c.userId ?? null,
        subject: input.subject,
        category: input.category ?? null,
        priority: input.priority,
        assigneeId: input.assigneeId ?? null,
        createdAt: now,
        ...due,
      },
      include,
    });
    await tx.supportMessage.create({ data: { tenantId, ticketId: ticket.id, authorUserId: c.userId ?? null, authorType: c.actorType, authorName: c.actorLabel ?? null, body: input.message, visibility: 'CUSTOMER', attachments: [...new Set(input.attachments)] } });
    await this.audit.log({ action: 'ticket.created', resourceType: 'SupportTicket', resourceId: ticket.id, summary: ticket.ticketNo, after: { scope: input.scope, subject: input.subject, priority: input.priority, customerId: input.customerId, requestId: input.requestId } }, tx);
    await this.events.emit(tx, 'ticket.created', { ticketId: ticket.id, customerId: ticket.customerId, requestId: ticket.requestId, scope: ticket.scope });
    return ticket;
  }

  // ------------------------------------------------------------------ customers and company users (own tickets)
  /** Tickets of my customer record, or tickets I raised myself (company administrators have no customer record). */
  private ownWhere(): Prisma.SupportTicketWhereInput {
    const c = ctx();
    if (!c.userId) throw Errors.unauthorized();
    return { tenantId: this.db.tenantId, scope: 'CUSTOMER', OR: [...(c.customerId ? [{ customerId: c.customerId }] : []), { raisedByUserId: c.userId }] };
  }
  private async ownTicket(tx: Tx, id: string): Promise<Row> {
    return found(await tx.supportTicket.findFirst({ where: { id, ...this.ownWhere() }, include }), 'Ticket');
  }
  private async requesterDetail(tx: Tx, row: Row, ownSide: string[]) {
    const messages = await tx.supportMessage.findMany({ where: { tenantId: this.db.tenantId, ticketId: row.id, visibility: 'CUSTOMER' }, orderBy: { createdAt: 'asc' } });
    const feedback = row.scope === 'CUSTOMER' ? await tx.customerFeedback.findFirst({ where: { tenantId: this.db.tenantId, ticketId: row.id }, select: { rating: true, comment: true, createdAt: true } }) : null;
    const settings = await this.settings(tx);
    return {
      ...this.requesterView(row, settings.reopenWindowDays),
      messages: this.requesterMessages(messages, await this.attachmentTitles(tx, messages), ownSide),
      ...(row.scope === 'CUSTOMER' ? { feedback, canRate: !feedback && !!row.customerId && ['RESOLVED', 'CLOSED'].includes(row.status) } : {}),
    };
  }

  async openMine(input: OpenTicketInput) {
    const c = ctx();
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      if (input.requestId) {
        // Only the customer's own request (or one of their company's) can be linked.
        const owner: Prisma.ServiceRequestWhereInput[] = [...(c.customerId ? [{ customerId: c.customerId }] : []), ...(c.corporateAccountId ? [{ corporateAccountId: c.corporateAccountId }] : [])];
        if (!owner.length) throw Errors.notFound('Request');
        found(await tx.serviceRequest.findFirst({ where: { id: input.requestId, tenantId, deletedAt: null, OR: owner }, select: { id: true } }), 'Request');
      }
      await this.assertAttachments(tx, input.attachments, { ownerCustomerId: c.customerId ?? null, ownerCorporateAccountId: c.corporateAccountId ?? null });
      const ticket = await this.createTicket(tx, { scope: 'CUSTOMER', customerId: c.customerId ?? null, requestId: input.requestId ?? null, subject: input.subject, category: input.category, priority: 'NORMAL', message: input.message, attachments: input.attachments });
      return this.requesterDetail(tx, ticket, ['CUSTOMER', 'CORPORATE']);
    });
  }
  async listMine(query: MyTicketsQuery) {
    return this.db.tx(async (tx) => {
      const where: Prisma.SupportTicketWhereInput = { ...this.ownWhere(), ...(query.status ? { status: query.status } : {}) };
      const rows = await tx.supportTicket.findMany({ where, ...pageArgs(query, SORT, 'updatedAt:desc'), include });
      const total = await tx.supportTicket.count({ where });
      const settings = await this.settings(tx);
      return pageResult(rows.map((r) => this.requesterView(r, settings.reopenWindowDays)), total, query);
    });
  }
  getMine(id: string) {
    return this.db.tx(async (tx) => this.requesterDetail(tx, await this.ownTicket(tx, id), ['CUSTOMER', 'CORPORATE']));
  }
  async replyMine(id: string, input: CustomerReplyInput) {
    const c = ctx();
    return this.db.tx(async (tx) => {
      await this.ownTicket(tx, id); // 404 before any lock for tickets that are not mine
      await this.lock(tx, id);
      const ticket = await this.ownTicket(tx, id);
      await this.assertAttachments(tx, input.attachments, { ownerCustomerId: c.customerId ?? null, ownerCorporateAccountId: c.corporateAccountId ?? null });
      await this.requesterReply(tx, ticket, input.body, input.attachments);
      return this.requesterDetail(tx, await this.ownTicket(tx, id), ['CUSTOMER', 'CORPORATE']);
    });
  }

  /** A reply from the side that asked (customer, or the centre on a platform ticket). */
  private async requesterReply(tx: Tx, ticket: Row, body: string, attachments: string[]) {
    const c = ctx();
    const tenantId = this.db.tenantId;
    const now = new Date();
    const outcome = afterCustomerReply(ticket.status as TicketStatus, ticket.resolvedAt, (await this.settings(tx)).reopenWindowDays, now);
    if (outcome === 'CLOSED') throw Errors.conflict('TICKET_CLOSED', 'This ticket is closed. Please open a new ticket if you still need help.');
    await tx.supportMessage.create({ data: { tenantId, ticketId: ticket.id, authorUserId: c.userId ?? null, authorType: c.actorType, authorName: c.actorLabel ?? null, body, visibility: 'CUSTOMER', attachments: [...new Set(attachments)] } });
    await tx.supportTicket.update({ where: { id: ticket.id }, data: { status: outcome.status, ...(outcome.reopened ? { resolvedAt: null } : {}) } });
    if (outcome.reopened) await this.audit.log({ action: 'ticket.reopened', resourceType: 'SupportTicket', resourceId: ticket.id, summary: 'Reopened by a reply from the requester', before: { status: ticket.status }, after: { status: outcome.status } }, tx);
    await this.events.emit(tx, 'ticket.replied', { ticketId: ticket.id, customerId: ticket.customerId, authorType: c.actorType, visibility: 'CUSTOMER' });
  }

  // ------------------------------------------------------------------ staff (customer tickets)
  private async staffTicket(tx: Tx, id: string): Promise<Row> {
    return found(await tx.supportTicket.findFirst({ where: { id, tenantId: this.db.tenantId, scope: 'CUSTOMER' }, include }), 'Ticket');
  }
  private async staffDetail(tx: Tx, row: Row) {
    const messages = await tx.supportMessage.findMany({ where: { tenantId: this.db.tenantId, ticketId: row.id }, orderBy: { createdAt: 'asc' } });
    const feedback = await tx.customerFeedback.findFirst({ where: { tenantId: this.db.tenantId, ticketId: row.id }, select: { rating: true, comment: true, createdAt: true } });
    return { ...this.staffView(row, await this.staffNames(tx, [row.assigneeId])), messages: this.staffMessages(messages, await this.attachmentTitles(tx, messages)), feedback };
  }
  private async assertAssignee(tx: Tx, membershipId: string | null | undefined) {
    if (!membershipId) return;
    const member = found(await tx.tenantMembership.findFirst({ where: { id: membershipId, tenantId: this.db.tenantId, kind: 'STAFF' }, select: { status: true, user: { select: { fullName: true } } } }), 'Staff member');
    if (member.status !== 'ACTIVE') throw Errors.unprocessable('ASSIGNEE_INACTIVE', `${member.user.fullName} is not an active member of your team.`);
  }

  async list(query: TicketListQuery) {
    return this.db.tx(async (tx) => {
      const now = new Date();
      const where: Prisma.SupportTicketWhereInput = {
        tenantId: this.db.tenantId,
        scope: 'CUSTOMER',
        ...(query.status ? { status: query.status } : query.open ? { status: { in: [...OPEN] } } : {}),
        ...(query.priority ? { priority: query.priority } : {}),
        ...(query.category ? { category: query.category } : {}),
        ...(query.assigneeId ? { assigneeId: query.assigneeId } : query.unassigned ? { assigneeId: null } : {}),
        ...(query.customerId ? { customerId: query.customerId } : {}),
        ...(query.requestId ? { requestId: query.requestId } : {}),
        ...(query.q ? { OR: [{ subject: { contains: query.q, mode: 'insensitive' } }, { ticketNo: { contains: query.q, mode: 'insensitive' } }, { customer: { fullName: { contains: query.q, mode: 'insensitive' } } }] } : {}),
        // Breached = still open and past a target. (Tickets answered or resolved late keep their flag in the row.)
        ...(query.breached ? { status: { in: [...OPEN] }, AND: [{ OR: [{ firstRespondedAt: null, firstResponseDueAt: { lt: now } }, { resolutionDueAt: { lt: now } }] }] } : {}),
      };
      const rows = await tx.supportTicket.findMany({ where, ...pageArgs(query, SORT, 'createdAt:desc'), include });
      const total = await tx.supportTicket.count({ where });
      const names = await this.staffNames(tx, rows.map((r) => r.assigneeId));
      return pageResult(rows.map((r) => this.staffView(r, names, now)), total, query);
    });
  }
  get(id: string) {
    return this.db.tx(async (tx) => this.staffDetail(tx, await this.staffTicket(tx, id)));
  }
  /** Staff opens a ticket for a customer (phone call, at the counter). */
  async open(input: StaffOpenTicketInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      await assertCustomerNotErased(tx, tenantId, input.customerId);
      found(await tx.customer.findFirst({ where: { id: input.customerId, tenantId, deletedAt: null }, select: { id: true } }), 'Customer');
      if (input.requestId) found(await tx.serviceRequest.findFirst({ where: { id: input.requestId, tenantId, customerId: input.customerId, deletedAt: null }, select: { id: true } }), 'Request');
      await this.assertAssignee(tx, input.assigneeId);
      await this.assertAttachments(tx, input.attachments, { customerVisibleFor: input.customerId });
      const ticket = await this.createTicket(tx, { scope: 'CUSTOMER', customerId: input.customerId, requestId: input.requestId ?? null, subject: input.subject, category: input.category, priority: input.priority, assigneeId: input.assigneeId, message: input.message, attachments: input.attachments });
      return this.staffDetail(tx, ticket);
    });
  }
  async update(id: string, input: UpdateTicketInput) {
    return this.db.tx(async (tx) => {
      await this.lock(tx, id);
      const before = await this.staffTicket(tx, id);
      if (before.status === 'CLOSED') throw Errors.conflict('TICKET_CLOSED', 'This ticket is closed and can no longer be changed.');
      const data: Prisma.SupportTicketUncheckedUpdateInput = {};
      if (input.assigneeId !== undefined && input.assigneeId !== before.assigneeId) {
        await this.assertAssignee(tx, input.assigneeId);
        data.assigneeId = input.assigneeId;
      }
      if (input.category !== undefined) data.category = input.category;
      if (input.priority && input.priority !== before.priority) {
        data.priority = input.priority;
        // A new priority means new targets, still counted from when the ticket was opened.
        if (isOpen(before.status)) Object.assign(data, dueTimes(before.createdAt, await this.targets(tx, input.priority)));
      }
      const row = await tx.supportTicket.update({ where: { id }, data, include });
      if (data.assigneeId !== undefined) await this.audit.log({ action: 'ticket.assigned', resourceType: 'SupportTicket', resourceId: id, summary: before.ticketNo, before: { assigneeId: before.assigneeId }, after: { assigneeId: row.assigneeId } }, tx);
      if (data.priority !== undefined || data.category !== undefined) {
        await this.audit.log({ action: 'ticket.updated', resourceType: 'SupportTicket', resourceId: id, summary: before.ticketNo, before: { priority: before.priority, category: before.category }, after: { priority: row.priority, category: row.category } }, tx);
      }
      return this.staffDetail(tx, row);
    });
  }

  async reply(id: string, input: StaffReplyInput) {
    const c = ctx();
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      await this.lock(tx, id);
      const ticket = await this.staffTicket(tx, id);
      const visible = input.visibility === 'CUSTOMER';
      if (visible && ticket.status === 'CLOSED') throw Errors.conflict('TICKET_CLOSED', 'This ticket is closed. Ask the customer to open a new ticket, or add an internal note.');
      if (!visible && input.status) throw Errors.unprocessable('STATUS_NEEDS_REPLY', 'The status can only be changed together with a reply the customer can see.');
      await this.assertAttachments(tx, input.attachments, visible ? { customerVisibleFor: ticket.customerId } : {});
      const now = new Date();
      await tx.supportMessage.create({ data: { tenantId, ticketId: id, authorUserId: c.userId ?? null, authorType: c.actorType, authorName: c.actorLabel ?? null, body: input.body, visibility: input.visibility, attachments: [...new Set(input.attachments)] } });
      if (visible) {
        const from = ticket.status as TicketStatus;
        const to: TicketStatus = input.status ?? (from === 'OPEN' ? 'IN_PROGRESS' : from);
        if (to !== from && !TICKET_TRANSITIONS[from].includes(to)) throw Errors.conflict('INVALID_TRANSITION', `A ticket that is ${label(from)} cannot be set to ${label(to)}.`, { from, to });
        await tx.supportTicket.update({
          where: { id },
          data: {
            status: to,
            // The first reply the customer can see stops the first-response clock.
            firstRespondedAt: ticket.firstRespondedAt ?? now,
            ...(to === 'RESOLVED' && from !== 'RESOLVED' ? { resolvedAt: now, resolutionSummary: input.resolutionSummary ?? ticket.resolutionSummary } : {}),
          },
        });
        if (to !== from) await this.audit.log({ action: `ticket.${to.toLowerCase()}`, resourceType: 'SupportTicket', resourceId: id, summary: ticket.ticketNo, before: { status: from }, after: { status: to } }, tx);
      }
      await this.audit.log({ action: visible ? 'ticket.replied' : 'ticket.note_added', resourceType: 'SupportTicket', resourceId: id, summary: ticket.ticketNo }, tx);
      await this.events.emit(tx, 'ticket.replied', { ticketId: id, customerId: ticket.customerId, authorType: c.actorType, visibility: input.visibility });
      return this.staffDetail(tx, await this.staffTicket(tx, id));
    });
  }

  private async applyStatus(tx: Tx, ticket: Row, input: TicketStatusInput) {
    const from = ticket.status as TicketStatus;
    const to = input.status as TicketStatus;
    if (from === to) throw Errors.conflict('NO_CHANGE', `This ticket is already ${label(to)}.`);
    if (!TICKET_TRANSITIONS[from].includes(to)) throw Errors.conflict('INVALID_TRANSITION', `A ticket that is ${label(from)} cannot be set to ${label(to)}.`, { from, to });
    const now = new Date();
    await tx.supportTicket.update({
      where: { id: ticket.id },
      data: {
        status: to,
        ...(to === 'RESOLVED' ? { resolvedAt: now, resolutionSummary: input.resolutionSummary ?? ticket.resolutionSummary } : {}),
        ...(to === 'CLOSED' ? { closedAt: now, resolvedAt: ticket.resolvedAt ?? now, resolutionSummary: input.resolutionSummary ?? ticket.resolutionSummary } : {}),
        // Taking a resolved ticket up again.
        ...(from === 'RESOLVED' && to === 'IN_PROGRESS' ? { resolvedAt: null } : {}),
      },
    });
    await this.audit.log({ action: from === 'RESOLVED' && to === 'IN_PROGRESS' ? 'ticket.reopened' : `ticket.${to.toLowerCase()}`, resourceType: 'SupportTicket', resourceId: ticket.id, summary: ticket.ticketNo, before: { status: from }, after: { status: to, resolutionSummary: input.resolutionSummary ?? undefined } }, tx);
  }
  async setStatus(id: string, input: TicketStatusInput) {
    return this.db.tx(async (tx) => {
      await this.lock(tx, id);
      await this.applyStatus(tx, await this.staffTicket(tx, id), input);
      return this.staffDetail(tx, await this.staffTicket(tx, id));
    });
  }

  // ------------------------------------------------------------------ SLA policies and settings
  async slaPolicies() {
    return this.db.tx(async (tx) => {
      const rows = await tx.slaPolicy.findMany({ where: { tenantId: this.db.tenantId } });
      return PRIORITIES.map((priority) => {
        const row = rows.find((r) => r.priority === priority);
        return row
          ? { priority, name: row.name, firstResponseMinutes: row.firstResponseMinutes, resolutionMinutes: row.resolutionMinutes, isActive: row.isActive }
          : { priority, name: DEFAULT_SLA[priority].name, firstResponseMinutes: DEFAULT_SLA[priority].firstResponseMinutes, resolutionMinutes: DEFAULT_SLA[priority].resolutionMinutes, isActive: true };
      });
    });
  }
  /** New targets apply to tickets opened (or re-prioritised) from now on; existing due times stay. */
  async saveSlaPolicies(input: SlaPoliciesInput) {
    await this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      for (const p of input.policies) {
        const before = await tx.slaPolicy.findFirst({ where: { tenantId, priority: p.priority } });
        const data = { name: p.name ?? before?.name ?? DEFAULT_SLA[p.priority].name, firstResponseMinutes: p.firstResponseMinutes, resolutionMinutes: p.resolutionMinutes, isActive: p.isActive };
        const row = before ? await tx.slaPolicy.update({ where: { id: before.id }, data }) : await tx.slaPolicy.create({ data: { ...data, tenantId, priority: p.priority } });
        await this.audit.log({ action: 'sla_policy.updated', resourceType: 'SlaPolicy', resourceId: row.id, summary: p.priority, before: before ? { firstResponseMinutes: before.firstResponseMinutes, resolutionMinutes: before.resolutionMinutes, isActive: before.isActive } : undefined, after: data }, tx);
      }
    });
    return this.slaPolicies();
  }
  getSettings() {
    return this.db.tx((tx) => this.settings(tx));
  }
  updateSettings(input: SupportSettingsInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const all = await lockTenantSettings(tx, tenantId);
      const before = parseSupportSettings(all);
      const next = { ...(all.support ?? {}), reopenWindowDays: input.reopenWindowDays };
      await saveTenantSettingsSection(tx, tenantId, 'support', next);
      await this.audit.log({ action: 'support.settings_updated', resourceType: 'Tenant', resourceId: tenantId, before, after: input }, tx);
      return parseSupportSettings({ support: next });
    });
  }

  // ------------------------------------------------------------------ the centre's tickets to TypEase support (scope PLATFORM)
  private async platformTicket(tx: Tx, id: string): Promise<Row> {
    return found(await tx.supportTicket.findFirst({ where: { id, tenantId: this.db.tenantId, scope: 'PLATFORM' }, include }), 'Ticket');
  }
  /** Platform tickets never carry customer or request references: TypEase support sees no customer data. */
  async openPlatform(input: OpenPlatformTicketInput) {
    return this.db.tx(async (tx) => {
      const ticket = await this.createTicket(tx, { scope: 'PLATFORM', customerId: null, requestId: null, subject: input.subject, category: input.category, priority: input.priority, message: input.message, attachments: [] });
      return this.requesterDetail(tx, ticket, ['STAFF']);
    });
  }
  async listPlatform(query: PageQueryInput & { status?: string }) {
    return this.db.tx(async (tx) => {
      const where: Prisma.SupportTicketWhereInput = { tenantId: this.db.tenantId, scope: 'PLATFORM', ...(query.status ? { status: query.status as TicketStatus } : {}) };
      const rows = await tx.supportTicket.findMany({ where, ...pageArgs(query, SORT, 'updatedAt:desc'), include });
      const total = await tx.supportTicket.count({ where });
      const settings = await this.settings(tx);
      return pageResult(rows.map((r) => ({ ...this.requesterView(r, settings.reopenWindowDays), priority: r.priority })), total, query);
    });
  }
  getPlatform(id: string) {
    return this.db.tx(async (tx) => this.requesterDetail(tx, await this.platformTicket(tx, id), ['STAFF']));
  }
  async replyPlatform(id: string, body: string) {
    return this.db.tx(async (tx) => {
      await this.platformTicket(tx, id);
      await this.lock(tx, id);
      await this.requesterReply(tx, await this.platformTicket(tx, id), body, []);
      return this.requesterDetail(tx, await this.platformTicket(tx, id), ['STAFF']);
    });
  }

  // ------------------------------------------------------------------ SLA job (one tenant)
  /**
   * - Open customer tickets past a target get ONE escalation task per breach
   *   (first response, resolution) in the queue of the `manager` role.
   * - Resolved tickets are closed once the reopen window has passed.
   */
  async runSla(now = new Date()): Promise<{ escalated: number; closed: number }> {
    const tenantId = this.db.tenantId;
    const stats = { escalated: 0, closed: 0 };
    const breached = await this.db.tx((tx) =>
      tx.supportTicket.findMany({
        where: { tenantId, scope: 'CUSTOMER', status: { in: [...OPEN] }, OR: [{ firstRespondedAt: null, firstResponseDueAt: { lt: now } }, { resolutionDueAt: { lt: now } }] },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: 500,
      }),
    );
    for (const { id } of breached) {
      try {
        stats.escalated += await this.db.tx(async (tx) => {
          // The ticket row is locked: two runs of the job cannot both create the task.
          await this.lock(tx, id);
          const ticket = await tx.supportTicket.findFirstOrThrow({ where: { id, tenantId } });
          if (!isOpen(ticket.status)) return 0;
          const state = breachState(ticket as any, now);
          const kinds: Array<{ key: 'first_response' | 'resolution'; title: string }> = [];
          if (state.firstResponseBreached && !ticket.firstRespondedAt) kinds.push({ key: 'first_response', title: `Ticket ${ticket.ticketNo} has had no reply within the agreed time` });
          if (state.resolutionBreached) kinds.push({ key: 'resolution', title: `Ticket ${ticket.ticketNo} was not resolved within the agreed time` });
          let created = 0;
          for (const kind of kinds) {
            const stepKey = `sla:${ticket.id}:${kind.key}`;
            if (await tx.task.findFirst({ where: { tenantId, stepKey }, select: { id: true } })) continue;
            const taskId = await this.tasks.createSystemTask(tx, {
              title: kind.title,
              description: `Subject: ${ticket.subject}\nPriority: ${ticket.priority}\nOpen the ticket, reply to the customer and agree on the next step.`,
              type: 'ESCALATION',
              source: 'ESCALATION',
              priority: ticket.priority === 'URGENT' ? 'URGENT' : 'HIGH',
              roleKey: 'manager',
              customerId: ticket.customerId,
              requestId: ticket.requestId,
            });
            await tx.task.update({ where: { id: taskId }, data: { stepKey } });
            await this.audit.log({ action: 'ticket.sla_breached', resourceType: 'SupportTicket', resourceId: ticket.id, summary: `${ticket.ticketNo}: ${kind.key.replace('_', ' ')}`, after: { taskId } }, tx);
            created += 1;
          }
          return created;
        });
      } catch (e: any) {
        this.logger.error(`SLA check for ticket ${id} failed: ${e?.message ?? e}`);
      }
    }
    stats.closed = await this.db.tx(async (tx) => {
      const window = (await this.settings(tx)).reopenWindowDays;
      const rows = await tx.supportTicket.findMany({ where: { tenantId, status: 'RESOLVED', resolvedAt: { lt: new Date(now.getTime() - window * 86_400_000) } }, select: { id: true, ticketNo: true }, take: 500 });
      for (const row of rows) {
        const changed = await tx.supportTicket.updateMany({ where: { id: row.id, tenantId, status: 'RESOLVED' }, data: { status: 'CLOSED', closedAt: now } });
        if (changed.count) await this.audit.log({ action: 'ticket.closed', resourceType: 'SupportTicket', resourceId: row.id, summary: `${row.ticketNo}: closed automatically after ${window} days without a reply`, before: { status: 'RESOLVED' }, after: { status: 'CLOSED' } }, tx);
      }
      return rows.length;
    });
    return stats;
  }
}
