import { Injectable, OnModuleInit } from '@nestjs/common';
import type { CommissionEntryQuery, CommissionPayoutInput, CommissionRuleInput, CommissionSummaryQuery, UpdateCommissionRuleInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { Prisma, TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { DomainEvent, DomainEvents } from '../../common/events.service';
import { D, pageArgs, pageResult, sum } from '../../common/pagination';
import { addDays, safeTimeZone, startOfLocalDay } from '../reports/time';
import { fmt } from './finance.calc';
import { LedgerService } from './ledger.service';

type Beneficiary = 'OPERATOR' | 'REVIEWER' | 'CREATOR';
const BENEFICIARIES: Beneficiary[] = ['OPERATOR', 'REVIEWER', 'CREATOR'];
const SORT = ['earnedAt', 'amount', 'paidAt'] as const;

/**
 * Staff commission. When a request is completed, every beneficiary (the operator it is assigned to, its active
 * reviewer, the staff member who created it) earns according to the rule for its service, or the default rule.
 * A percentage is taken of the service fee only: net of discounts, without VAT and without the government and
 * third-party fees, which are not the centre's revenue. Accrual runs inside the completion transaction; a
 * reopened request voids what was not paid out yet and earns again when it is completed again.
 */
@Injectable()
export class CommissionsService implements OnModuleInit {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly ledger: LedgerService,
  ) {}

  onModuleInit() {
    this.events.on('request.completed', (event, tx) => this.accrue(event, tx));
    this.events.on('request.status_changed', (event, tx) => this.onStatusChanged(event, tx));
  }

  // ------------------------------------------------------------------ accrual
  /** The service fee of a request: service-fee lines of its issued invoices, after line discounts, before VAT. */
  static async serviceFeeBasis(tx: Tx, tenantId: string, requestId: string): Promise<{ basis: Prisma.Decimal; currency: string | null }> {
    const lines = await tx.invoiceItem.findMany({
      where: { tenantId, component: 'SERVICE_FEE', invoice: { requestId, status: { in: ['ISSUED', 'PARTIALLY_PAID', 'PAID'] } } },
      select: { quantity: true, unitAmount: true, discountAmount: true, invoice: { select: { currency: true } } },
    });
    const basis = sum(lines.map((l) => D(l.quantity).mul(l.unitAmount).minus(l.discountAmount)));
    return { basis: Prisma.Decimal.max(basis, 0).toDecimalPlaces(2), currency: lines[0]?.invoice.currency ?? null };
  }

  static computeAmount(kind: 'PERCENT' | 'FIXED', value: Prisma.Decimal | string, basis: Prisma.Decimal | string): Prisma.Decimal {
    return kind === 'FIXED' ? D(value) : D(basis).mul(value).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  }

  private async beneficiaries(tx: Tx, tenantId: string, request: { id: string; assignedToId: string | null; createdById: string | null; createdByType: string }) {
    const people = new Map<Beneficiary, { membershipId: string; userId: string } | null>();
    if (request.assignedToId) {
      const m = await tx.tenantMembership.findFirst({ where: { id: request.assignedToId, tenantId, kind: 'STAFF' }, select: { id: true, userId: true } });
      people.set('OPERATOR', m ? { membershipId: m.id, userId: m.userId } : null);
    }
    const reviewer = await tx.requestAssignment.findFirst({ where: { tenantId, requestId: request.id, role: 'REVIEWER', unassignedAt: null }, orderBy: { assignedAt: 'desc' }, select: { assignee: { select: { id: true, userId: true, kind: true } } } });
    if (reviewer?.assignee.kind === 'STAFF') people.set('REVIEWER', { membershipId: reviewer.assignee.id, userId: reviewer.assignee.userId });
    if (request.createdById && request.createdByType === 'STAFF') {
      const m = await tx.tenantMembership.findFirst({ where: { tenantId, userId: request.createdById, kind: 'STAFF' }, select: { id: true, userId: true } });
      if (m) people.set('CREATOR', { membershipId: m.id, userId: m.userId });
    }
    return people;
  }

  async accrue(event: DomainEvent, tx: Tx): Promise<void> {
    const requestId = event.payload?.requestId;
    const tenantId = event.tenantId;
    if (typeof requestId !== 'string' || !tenantId) return;
    const rules = await tx.commissionRule.findMany({ where: { tenantId, isActive: true } });
    if (!rules.length) return;
    const request = await tx.serviceRequest.findFirst({ where: { id: requestId, tenantId }, select: { id: true, serviceId: true, assignedToId: true, createdById: true, createdByType: true } });
    if (!request) return;
    const { basis, currency } = await CommissionsService.serviceFeeBasis(tx, tenantId, requestId);
    const fallbackCurrency = currency ?? (await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { defaultCurrency: true } })).defaultCurrency;
    const people = await this.beneficiaries(tx, tenantId, request);
    for (const beneficiary of BENEFICIARIES) {
      const person = people.get(beneficiary);
      if (!person) continue;
      const rule = rules.find((r) => r.beneficiary === beneficiary && r.serviceId === request.serviceId) ?? rules.find((r) => r.beneficiary === beneficiary && r.serviceId === null);
      if (!rule) continue;
      const amount = CommissionsService.computeAmount(rule.kind, rule.value, basis);
      if (amount.lte(0)) continue;
      // Idempotent: a duplicate event (or a race) cannot accrue twice (unique index on non-void entries).
      const inserted = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO "commission_entries" ("tenantId", "ruleId", "requestId", "serviceId", "membershipId", "userId", "beneficiary", "basis", "kind", "value", "amount", "currency")
        VALUES (${tenantId}::uuid, ${rule.id}::uuid, ${request.id}::uuid, ${request.serviceId}::uuid, ${person.membershipId}::uuid, ${person.userId}::uuid,
                ${beneficiary}::"CommissionBeneficiary", ${basis}, ${rule.kind}::"CommissionKind", ${rule.value}, ${amount}, ${fallbackCurrency})
        ON CONFLICT ("requestId", "ruleId", "membershipId") WHERE "status" <> 'VOID' DO NOTHING
        RETURNING "id"`;
      await this.ledger.postCommission(tx, tenantId, inserted.map((r) => r.id), 'ACCRUED');
    }
  }

  /** Reopened (COMPLETED -> anything else): unpaid commission of the request is voided. Paid entries stay. */
  async onStatusChanged(event: DomainEvent, tx: Tx): Promise<void> {
    const p = event.payload ?? {};
    if (p.from !== 'COMPLETED' || p.to === 'COMPLETED' || typeof p.requestId !== 'string' || !event.tenantId) return;
    const voided = await tx.commissionEntry.findMany({ where: { tenantId: event.tenantId, requestId: p.requestId, status: 'ACCRUED' }, select: { id: true } });
    if (!voided.length) return;
    await tx.commissionEntry.updateMany({
      where: { tenantId: event.tenantId, id: { in: voided.map((v) => v.id) }, status: 'ACCRUED' },
      data: { status: 'VOID', voidedAt: new Date(), voidReason: 'The request was reopened.' },
    });
    await this.ledger.postCommission(tx, event.tenantId, voided.map((v) => v.id), 'VOIDED');
  }

  // ------------------------------------------------------------------ rules
  private presentRule(r: Prisma.CommissionRuleGetPayload<{ include: { service: { select: { id: true; name: true; nameAr: true } } } }>) {
    return { id: r.id, serviceId: r.serviceId, service: r.service, beneficiary: r.beneficiary, kind: r.kind, value: fmt(r.value), isActive: r.isActive, createdAt: r.createdAt, updatedAt: r.updatedAt };
  }

  async rules() {
    return this.db.tx(async (tx) => {
      const rows = await tx.commissionRule.findMany({ where: { tenantId: this.db.tenantId }, orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }], include: { service: { select: { id: true, name: true, nameAr: true } } } });
      return rows.map((r) => this.presentRule(r));
    });
  }

  async createRule(input: CommissionRuleInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      if (input.serviceId) found(await tx.service.findFirst({ where: { id: input.serviceId, tenantId, deletedAt: null }, select: { id: true } }), 'Service');
      const clash = await tx.commissionRule.findFirst({ where: { tenantId, serviceId: input.serviceId, beneficiary: input.beneficiary, isActive: true } });
      if (clash) throw Errors.conflict('RULE_EXISTS', 'There is already an active rule for this service and person. Change that rule instead.', { ruleId: clash.id });
      const created = await tx.commissionRule.create({
        data: { tenantId, serviceId: input.serviceId, beneficiary: input.beneficiary, kind: input.kind, value: D(input.value), createdById: ctx().userId! },
        include: { service: { select: { id: true, name: true, nameAr: true } } },
      });
      await this.audit.log({ action: 'commission.rule_created', resourceType: 'CommissionRule', resourceId: created.id, after: { serviceId: input.serviceId, beneficiary: input.beneficiary, kind: input.kind, value: fmt(input.value) } }, tx);
      return this.presentRule(created);
    });
  }

  async updateRule(id: string, input: UpdateCommissionRuleInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const before = found(await tx.commissionRule.findFirst({ where: { id, tenantId } }), 'Rule');
      const kind = input.kind ?? before.kind;
      const value = input.value !== undefined ? D(input.value) : before.value;
      if (kind === 'PERCENT' && value.gt(100)) throw Errors.unprocessable('VALIDATION_FAILED', 'A percentage cannot be above 100.');
      if (input.isActive === true && !before.isActive) {
        const clash = await tx.commissionRule.findFirst({ where: { tenantId, serviceId: before.serviceId, beneficiary: before.beneficiary, isActive: true, id: { not: id } } });
        if (clash) throw Errors.conflict('RULE_EXISTS', 'Another active rule already covers this service and person.');
      }
      // Changes apply to requests completed from now on; earned commission keeps the rate it was earned at.
      const updated = await tx.commissionRule.update({ where: { id }, data: { kind, value, ...(input.isActive !== undefined ? { isActive: input.isActive } : {}) }, include: { service: { select: { id: true, name: true, nameAr: true } } } });
      await this.audit.log({ action: 'commission.rule_updated', resourceType: 'CommissionRule', resourceId: id, before: { kind: before.kind, value: fmt(before.value), isActive: before.isActive }, after: { kind, value: fmt(value), isActive: updated.isActive } }, tx);
      return this.presentRule(updated);
    });
  }

  // ------------------------------------------------------------------ entries, summary, payout
  private async period(tx: Tx, from?: string, to?: string) {
    const tz = safeTimeZone((await tx.tenant.findFirstOrThrow({ where: { id: this.db.tenantId }, select: { timezone: true } })).timezone);
    return { ...(from ? { gte: startOfLocalDay(from, tz) } : {}), ...(to ? { lt: startOfLocalDay(addDays(to, 1), tz) } : {}) };
  }

  /** Everybody's entries with `commission.manage`; otherwise only the caller's own. */
  async entries(query: CommissionEntryQuery) {
    return this.db.tx(async (tx) => {
      const c = ctx();
      const tenantId = this.db.tenantId;
      const own = !c.permissions.has('commission.manage');
      const where: Prisma.CommissionEntryWhereInput = {
        tenantId,
        ...(own ? { membershipId: c.membershipId } : query.membershipId ? { membershipId: query.membershipId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.from || query.to ? { earnedAt: await this.period(tx, query.from, query.to) } : {}),
      };
      const [rows, total, totals] = await Promise.all([
        tx.commissionEntry.findMany({
          where,
          ...pageArgs(query, SORT, 'earnedAt:desc'),
          include: { request: { select: { id: true, requestNo: true, service: { select: { name: true, nameAr: true } } } }, membership: { select: { id: true, user: { select: { fullName: true } } } } },
        }),
        tx.commissionEntry.count({ where }),
        tx.commissionEntry.groupBy({ by: ['status'], where, _sum: { amount: true } }),
      ]);
      const items = rows.map((e) => ({
        id: e.id,
        request: { id: e.request.id, requestNo: e.request.requestNo, serviceName: e.request.service.name, serviceNameAr: e.request.service.nameAr },
        membershipId: e.membershipId,
        staffName: e.membership.user.fullName,
        beneficiary: e.beneficiary,
        basis: fmt(e.basis),
        kind: e.kind,
        value: fmt(e.value),
        amount: fmt(e.amount),
        currency: e.currency,
        status: e.status,
        earnedAt: e.earnedAt,
        paidAt: e.paidAt,
        payoutRef: e.payoutRef,
        voidReason: e.voidReason,
      }));
      const byStatus = Object.fromEntries(['ACCRUED', 'PAID', 'VOID'].map((s) => [s, fmt(totals.find((t) => t.status === s)?._sum.amount ?? 0)]));
      return { ...pageResult(items, total, query), totals: byStatus };
    });
  }

  /** Per person for a period: earned (accrued + paid), still to pay, paid, number of requests. */
  async summary(query: CommissionSummaryQuery) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const rows = await tx.commissionEntry.groupBy({
        by: ['membershipId', 'status'],
        where: { tenantId, status: { in: ['ACCRUED', 'PAID'] }, earnedAt: await this.period(tx, query.from, query.to) },
        _sum: { amount: true },
        _count: { _all: true },
      });
      const ids = [...new Set(rows.map((r) => r.membershipId))];
      const people = await tx.tenantMembership.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, user: { select: { fullName: true } }, role: { select: { name: true } } } });
      const currency = (await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { defaultCurrency: true } })).defaultCurrency;
      // Everything still owed, whatever the period (what a payout would settle).
      const owed = await tx.commissionEntry.groupBy({ by: ['membershipId'], where: { tenantId, status: 'ACCRUED', membershipId: { in: ids } }, _sum: { amount: true } });
      return {
        from: query.from,
        to: query.to,
        currency,
        staff: people
          .map((p) => {
            const mine = rows.filter((r) => r.membershipId === p.id);
            const accrued = D(mine.find((r) => r.status === 'ACCRUED')?._sum.amount ?? 0);
            const paid = D(mine.find((r) => r.status === 'PAID')?._sum.amount ?? 0);
            return {
              membershipId: p.id,
              name: p.user.fullName,
              role: p.role?.name ?? null,
              requests: mine.reduce((n, r) => n + r._count._all, 0),
              earned: fmt(accrued.plus(paid)),
              accrued: fmt(accrued),
              paid: fmt(paid),
              owedTotal: fmt(owed.find((o) => o.membershipId === p.id)?._sum.amount ?? 0),
            };
          })
          .sort((a, b) => Number(b.earned) - Number(a.earned)),
      };
    });
  }

  async payout(input: CommissionPayoutInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const person = found(await tx.tenantMembership.findFirst({ where: { id: input.membershipId, tenantId, kind: 'STAFF' }, select: { id: true, user: { select: { fullName: true } } } }), 'Staff member');
      const until = await this.period(tx, undefined, input.upTo);
      const due = await tx.commissionEntry.findMany({ where: { tenantId, membershipId: person.id, status: 'ACCRUED', earnedAt: until }, select: { id: true, amount: true, currency: true } });
      if (!due.length) throw Errors.conflict('NOTHING_TO_PAY', `${person.user.fullName} has no unpaid commission up to ${input.upTo}.`);
      const total = sum(due.map((e) => e.amount));
      const changed = await tx.commissionEntry.updateMany({
        where: { tenantId, id: { in: due.map((e) => e.id) }, status: 'ACCRUED' },
        data: { status: 'PAID', paidAt: new Date(), paidById: ctx().userId!, payoutRef: input.reference },
      });
      if (changed.count !== due.length) throw Errors.conflict('STALE_VERSION', 'Some of this commission changed while you were paying it. Reload and try again.');
      await this.ledger.postCommission(tx, tenantId, due.map((e) => e.id), 'PAID');
      await this.audit.log({ action: 'commission.paid_out', resourceType: 'TenantMembership', resourceId: person.id, summary: `Commission paid to ${person.user.fullName}: ${due[0]!.currency} ${fmt(total)} (${due.length} entries, ref ${input.reference})`, after: { entries: due.length, total: fmt(total), upTo: input.upTo, reference: input.reference } }, tx);
      return { membershipId: person.id, name: person.user.fullName, entries: due.length, total: fmt(total), currency: due[0]!.currency, reference: input.reference };
    });
  }
}
