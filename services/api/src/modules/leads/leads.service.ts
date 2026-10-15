import { Injectable, OnModuleInit } from '@nestjs/common';
import { customerSchema, type ConvertLeadInput, type LeadInput, type LeadQuery, type UpdateLeadInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { Prisma, TenantDb, Tx } from '../../common/db/prisma.service';
import { ErasureRegistry, ErasureSubject } from '../../common/erasure';
import { Errors, found } from '../../common/errors';
import { pageArgs, pageResult } from '../../common/pagination';
import { SequenceService } from '../../common/sequence.service';
import { CustomersService } from '../customers/customers.service';
import { DuplicatesService } from '../customers/duplicates.service';
import { fmt } from '../finance/finance.calc';
import { localDate } from '../reminders/dates';
import { RequestsService } from '../requests/requests.service';

const OPEN = ['NEW', 'CONTACTED', 'QUOTED'] as const;
const CONTACT_KINDS = ['CALL', 'WHATSAPP', 'EMAIL', 'MEETING'];

/**
 * CRM leads: everyone who asked about a service and is not a customer yet (or not for this). Each lead has an
 * owner, a next follow-up and an activity log; winning it links or creates the customer (with the usual duplicate
 * check) and can open the first request. Leads come from the counter, the phone, the website or a WhatsApp chat.
 */
@Injectable()
export class LeadsService implements OnModuleInit {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly sequences: SequenceService,
    private readonly customers: CustomersService,
    private readonly duplicates: DuplicatesService,
    private readonly requests: RequestsService,
    private readonly erasure: ErasureRegistry,
  ) {}

  onModuleInit() {
    this.erasure.register('leads', (tx, subject) => this.erase(tx, subject));
  }

  private async endOfToday(tx: Tx) {
    const tz = (await tx.tenant.findFirstOrThrow({ where: { id: this.db.tenantId }, select: { timezone: true } })).timezone;
    // The local day ends at most 14 hours after UTC midnight of the next day; a day-precision cut-off is enough here.
    return new Date(Date.parse(`${localDate(new Date(), tz)}T23:59:59.999Z`));
  }

  private async names(tx: Tx, membershipIds: Array<string | null>) {
    const ids = [...new Set(membershipIds.filter((x): x is string => !!x))];
    const rows = ids.length ? await tx.tenantMembership.findMany({ where: { tenantId: this.db.tenantId, id: { in: ids } }, select: { id: true, user: { select: { fullName: true } } } }) : [];
    return new Map(rows.map((r) => [r.id, r.user.fullName]));
  }

  async list(query: LeadQuery) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const end = await this.endOfToday(tx);
      const where: Prisma.LeadWhereInput = {
        tenantId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.source ? { source: query.source } : {}),
        ...(query.ownerId ? { ownerId: query.ownerId } : {}),
        ...(query.mine ? { ownerId: ctx().membershipId ?? '00000000-0000-0000-0000-000000000000' } : {}),
        ...(query.due ? { status: { in: [...OPEN] }, nextFollowUpAt: { lte: end } } : {}),
        ...(query.q ? { OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { phone: { contains: query.q.replace(/\s/g, '') } }, { email: { contains: query.q, mode: 'insensitive' } }, { leadNo: { contains: query.q.toUpperCase() } }] } : {}),
      };
      const [rows, total, byStatus, due] = await Promise.all([
        tx.lead.findMany({ where, ...pageArgs(query, ['createdAt', 'nextFollowUpAt', 'name'], 'createdAt:desc') }),
        tx.lead.count({ where }),
        tx.lead.groupBy({ by: ['status'], where: { tenantId }, _count: { _all: true } }),
        tx.lead.count({ where: { tenantId, status: { in: [...OPEN] }, nextFollowUpAt: { lte: end } } }),
      ]);
      const owners = await this.names(tx, rows.map((r) => r.ownerId));
      const services = new Map((await tx.service.findMany({ where: { tenantId, id: { in: rows.map((r) => r.serviceId).filter((x): x is string => !!x) } }, select: { id: true, name: true, nameAr: true } })).map((s) => [s.id, s]));
      return {
        ...pageResult(
          rows.map((r) => ({ ...r, estimatedValue: r.estimatedValue ? fmt(r.estimatedValue) : null, ownerName: r.ownerId ? (owners.get(r.ownerId) ?? null) : null, service: r.serviceId ? (services.get(r.serviceId) ?? null) : null, followUpDue: !!r.nextFollowUpAt && r.nextFollowUpAt <= end && (OPEN as readonly string[]).includes(r.status) })),
          total,
          query,
        ),
        counts: Object.fromEntries(byStatus.map((b) => [b.status, b._count._all])),
        dueToday: due,
      };
    });
  }

  private async load(tx: Tx, id: string) {
    return found(await tx.lead.findFirst({ where: { id, tenantId: this.db.tenantId } }), 'Lead');
  }

  async get(id: string) {
    return this.db.tx(async (tx) => {
      const lead = await this.load(tx, id);
      const activities = await tx.leadActivity.findMany({ where: { tenantId: this.db.tenantId, leadId: id }, orderBy: { createdAt: 'desc' } });
      const users = new Map((await tx.user.findMany({ where: { id: { in: activities.map((a) => a.createdById).filter((x): x is string => !!x) } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
      const owners = await this.names(tx, [lead.ownerId]);
      const customer = lead.customerId ? await tx.customer.findFirst({ where: { id: lead.customerId }, select: { id: true, customerNo: true, fullName: true } }) : null;
      const request = lead.requestId ? await tx.serviceRequest.findFirst({ where: { id: lead.requestId }, select: { id: true, requestNo: true, status: true } }) : null;
      const service = lead.serviceId ? await tx.service.findFirst({ where: { id: lead.serviceId }, select: { id: true, name: true, nameAr: true } }) : null;
      return { ...lead, estimatedValue: lead.estimatedValue ? fmt(lead.estimatedValue) : null, ownerName: lead.ownerId ? (owners.get(lead.ownerId) ?? null) : null, customer, request, service, activities: activities.map((a) => ({ ...a, authorName: a.createdById ? (users.get(a.createdById) ?? null) : null })) };
    });
  }

  private async assertRefs(tx: Tx, input: { serviceId?: string | null; ownerId?: string | null; conversationId?: string | null }) {
    const tenantId = this.db.tenantId;
    if (input.serviceId) found(await tx.service.findFirst({ where: { id: input.serviceId, tenantId, deletedAt: null }, select: { id: true } }), 'Service');
    if (input.ownerId) found(await tx.tenantMembership.findFirst({ where: { id: input.ownerId, tenantId, kind: 'STAFF', status: 'ACTIVE' }, select: { id: true } }), 'Staff member');
    if (input.conversationId) found(await tx.waConversation.findFirst({ where: { id: input.conversationId, tenantId }, select: { id: true } }), 'Conversation');
  }

  private activity(tx: Tx, leadId: string, kind: string, body: string) {
    return tx.leadActivity.create({ data: { tenantId: this.db.tenantId, leadId, kind, body, createdById: ctx().userId ?? null } });
  }

  async create(input: LeadInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      await this.assertRefs(tx, input);
      const lead = await tx.lead.create({
        data: {
          tenantId, leadNo: await this.sequences.next(tx, 'lead'), name: input.name, phone: input.phone ?? null, email: input.email ?? null, source: input.source, serviceId: input.serviceId ?? null,
          interest: input.interest ?? null, estimatedValue: input.estimatedValue ?? null, ownerId: input.ownerId ?? ctx().membershipId ?? null,
          nextFollowUpAt: input.nextFollowUpAt ? new Date(input.nextFollowUpAt) : null, conversationId: input.conversationId ?? null, createdById: ctx().userId ?? null,
        },
      });
      await this.activity(tx, lead.id, 'STATUS', `Lead created (${input.source.toLowerCase().replace('_', ' ')})`);
      await this.audit.log({ action: 'lead.created', resourceType: 'Lead', resourceId: lead.id, summary: `${lead.leadNo} ${lead.name}` }, tx);
      return lead;
    });
  }

  async update(id: string, input: UpdateLeadInput) {
    return this.db.tx(async (tx) => {
      await this.load(tx, id);
      await this.assertRefs(tx, input);
      const { nextFollowUpAt, ...rest } = input;
      return tx.lead.update({ where: { id }, data: { ...rest, ...(nextFollowUpAt !== undefined ? { nextFollowUpAt: nextFollowUpAt ? new Date(nextFollowUpAt) : null } : {}) } });
    });
  }

  async setStatus(id: string, status: 'NEW' | 'CONTACTED' | 'QUOTED' | 'WON' | 'LOST', lostReason?: string | null) {
    return this.db.tx(async (tx) => {
      const lead = await this.load(tx, id);
      if (status === 'WON') throw Errors.unprocessable('USE_CONVERT', 'Convert the lead to win it: that links or creates the customer.');
      if (lead.status === 'WON') throw Errors.conflict('LEAD_WON', 'This lead is already won.');
      await tx.lead.update({ where: { id }, data: { status, lostReason: status === 'LOST' ? lostReason! : null, ...(status === 'LOST' ? { nextFollowUpAt: null } : {}) } });
      await this.activity(tx, id, 'STATUS', status === 'LOST' ? `Lost: ${lostReason}` : `Moved to ${status.toLowerCase()}`);
      return this.load(tx, id);
    });
  }

  /** A call, message or note; the next follow-up moves with it. A first contact moves a new lead to "contacted". */
  async addActivity(id: string, kind: string, body: string, nextFollowUpAt?: string | null) {
    return this.db.tx(async (tx) => {
      const lead = await this.load(tx, id);
      await this.activity(tx, id, kind, body);
      await tx.lead.update({
        where: { id },
        data: { ...(nextFollowUpAt !== undefined ? { nextFollowUpAt: nextFollowUpAt ? new Date(nextFollowUpAt) : null } : {}), ...(lead.status === 'NEW' && CONTACT_KINDS.includes(kind) ? { status: 'CONTACTED' } : {}) },
      });
      return this.load(tx, id);
    });
  }

  /** Won: the existing customer (chosen, or found by phone / email) or a new one, and optionally a first request. */
  async convert(id: string, input: ConvertLeadInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const lead = await this.load(tx, id);
      if (lead.status === 'WON') throw Errors.conflict('LEAD_WON', 'This lead is already won.');
      let customerId = input.customerId ?? null;
      let linked = 'CHOSEN';
      if (customerId) found(await tx.customer.findFirst({ where: { id: customerId, tenantId, deletedAt: null }, select: { id: true } }), 'Customer');
      else {
        const strong = (await this.duplicates.find(tx, { fullName: lead.name, phone: lead.phone, email: lead.email })).find((d) => d.strength === 'STRONG');
        if (strong) {
          customerId = strong.customer.id;
          linked = 'MATCHED';
        } else {
          customerId = (await this.customers.create(customerSchema.parse({ fullName: lead.name, phone: lead.phone, email: lead.email }))).id;
          linked = 'CREATED';
        }
      }
      const serviceId = input.serviceId ?? lead.serviceId;
      const request = serviceId ? await this.requests.create({ serviceId, customerId: customerId!, instructions: `From lead ${lead.leadNo}${lead.interest ? `: ${lead.interest}` : ''}` }) : null;
      await tx.lead.update({ where: { id }, data: { status: 'WON', wonAt: new Date(), customerId, requestId: request?.id ?? null, nextFollowUpAt: null, lostReason: null } });
      if (lead.conversationId) await tx.waConversation.updateMany({ where: { id: lead.conversationId, tenantId, customerId: null }, data: { customerId } });
      await this.activity(tx, id, 'STATUS', `Won${request ? `: request ${request.requestNo}` : ''}`);
      await this.audit.log({ action: 'lead.won', resourceType: 'Lead', resourceId: id, summary: `${lead.leadNo} won (${linked.toLowerCase()} customer)`, after: { customerId, requestId: request?.id ?? null } }, tx);
      return { leadId: id, customerId, customer: linked, requestId: request?.id ?? null, requestNo: (request?.requestNo as string | undefined) ?? null };
    });
  }

  async erase(tx: Tx, subject: ErasureSubject) {
    const removed = await tx.lead.deleteMany({ where: { tenantId: this.db.tenantId, customerId: { in: subject.customerIds } } });
    return { leads: removed.count };
  }
}
