import { Injectable } from '@nestjs/common';
import type { CashSettingsInput, CloseShiftInput, DayEndQuery, OpenShiftInput, ReviewShiftInput, ShiftListQuery } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { Prisma, TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { DomainEvents } from '../../common/events.service';
import { D, pageArgs, pageResult, sum } from '../../common/pagination';
import { assertBranchAccess, branchFilter } from '../../common/scope';
import { SequenceService } from '../../common/sequence.service';
import { addDays, safeTimeZone, startOfLocalDay } from '../reports/time';
import { fmt } from './finance.calc';

/** Methods taken at the counter; online payments never touch a till. */
export const COUNTER_METHODS = ['CASH', 'CARD_POS', 'BANK_TRANSFER', 'CHEQUE'] as const;
const SETTLED: Array<'COMPLETED' | 'PARTIALLY_REFUNDED' | 'REFUNDED'> = ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'];
const SORT = ['openedAt', 'closedAt', 'shiftNo'] as const;
/** A cash difference above this (either way) is flagged to the managers. Centres can change it in finance settings. */
export const DEFAULT_VARIANCE_TOLERANCE = '5.00';

export interface ShiftTally {
  byMethod: Record<string, string>;
  paymentCount: number;
  cashIn: string;
  cashRefunds: string;
  cashExpenses: string;
  expectedCash: string;
  expectedCard: string;
}

type ShiftRow = Prisma.CashierShiftGetPayload<{ include: { branch: { select: { id: true; code: true; name: true; nameAr: true } } } }>;

/**
 * Cash register shifts and the day-end closing.
 *
 *   expected cash = opening float + cash payments - cash refunds paid out - cash expenses paid from the till
 *
 * Payments, refunds and expenses are linked to the shift when they are recorded (shiftId), so the
 * expected amount is exact and does not depend on clocks. A closed shift keeps a snapshot of the
 * tally; the manager review (four eyes: never by the cashier) completes it.
 */
@Injectable()
export class CashierService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly sequences: SequenceService,
  ) {}

  /** The open shift of the person recording money, if any (used by payments, refunds and expenses). */
  static async openShiftOf(tx: Tx, tenantId: string, userId: string | undefined, branchId?: string): Promise<{ id: string; branchId: string } | null> {
    if (!userId) return null;
    const shift = await tx.cashierShift.findFirst({ where: { tenantId, openedById: userId, status: 'OPEN' }, select: { id: true, branchId: true } });
    if (!shift || (branchId && shift.branchId !== branchId)) return null;
    return shift;
  }

  /** Whether this centre requires an open shift before cash can be taken (finance setting). */
  static async requiresShift(tx: Tx, tenantId: string): Promise<boolean> {
    const t = await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { settings: true } });
    return ((t.settings ?? {}) as Record<string, unknown>).requireShiftForCash === true;
  }

  private async tolerance(tx: Tx): Promise<Prisma.Decimal> {
    const t = await tx.tenant.findFirstOrThrow({ where: { id: this.db.tenantId }, select: { settings: true } });
    const value = ((t.settings ?? {}) as Record<string, unknown>).cashVarianceTolerance;
    return D(typeof value === 'string' || typeof value === 'number' ? value : DEFAULT_VARIANCE_TOLERANCE);
  }

  // ------------------------------------------------------------------ settings
  async settings() {
    return this.db.tx(async (tx) => {
      const t = await tx.tenant.findFirstOrThrow({ where: { id: this.db.tenantId }, select: { settings: true } });
      const s = (t.settings ?? {}) as Record<string, unknown>;
      return { requireShiftForCash: s.requireShiftForCash === true, cashVarianceTolerance: fmt(await this.tolerance(tx)) };
    });
  }

  async updateSettings(input: CashSettingsInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const t = await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { settings: true } });
      const before = (t.settings ?? {}) as Record<string, unknown>;
      const next = {
        ...before,
        ...(input.requireShiftForCash !== undefined ? { requireShiftForCash: input.requireShiftForCash } : {}),
        ...(input.cashVarianceTolerance !== undefined ? { cashVarianceTolerance: fmt(input.cashVarianceTolerance) } : {}),
      };
      await tx.tenant.update({ where: { id: tenantId }, data: { settings: next as Prisma.InputJsonValue } });
      await this.audit.log({ action: 'cash.settings_updated', resourceType: 'Tenant', resourceId: tenantId, before: { requireShiftForCash: before.requireShiftForCash ?? false, cashVarianceTolerance: before.cashVarianceTolerance ?? DEFAULT_VARIANCE_TOLERANCE }, after: input }, tx);
      return { requireShiftForCash: next.requireShiftForCash === true, cashVarianceTolerance: fmt(await this.tolerance(tx)) };
    });
  }

  // ------------------------------------------------------------------ tally
  async tally(tx: Tx, shift: { id: string; openingFloat: Prisma.Decimal | string }): Promise<ShiftTally> {
    const tenantId = this.db.tenantId;
    const payments = await tx.payment.groupBy({
      by: ['method'],
      where: { tenantId, shiftId: shift.id, status: { in: SETTLED } },
      _sum: { amount: true },
      _count: { _all: true },
    });
    const byMethod: Record<string, string> = Object.fromEntries(COUNTER_METHODS.map((m) => [m, '0.00']));
    let paymentCount = 0;
    for (const p of payments) {
      byMethod[p.method] = fmt(p._sum.amount ?? 0);
      paymentCount += p._count._all;
    }
    const refunds = await tx.refund.aggregate({ where: { tenantId, shiftId: shift.id, status: 'COMPLETED', method: 'CASH' }, _sum: { amount: true } });
    const expenses = await tx.expense.aggregate({ where: { tenantId, shiftId: shift.id, method: 'CASH', deletedAt: null }, _sum: { amount: true } });
    const cashIn = D(byMethod.CASH ?? 0);
    const cashRefunds = D(refunds._sum.amount ?? 0);
    const cashExpenses = D(expenses._sum.amount ?? 0);
    return {
      byMethod,
      paymentCount,
      cashIn: fmt(cashIn),
      cashRefunds: fmt(cashRefunds),
      cashExpenses: fmt(cashExpenses),
      expectedCash: fmt(D(shift.openingFloat).plus(cashIn).minus(cashRefunds).minus(cashExpenses)),
      expectedCard: fmt(byMethod.CARD_POS ?? 0),
    };
  }

  private present(shift: ShiftRow, tally: ShiftTally | null) {
    const closed = shift.status !== 'OPEN';
    return {
      id: shift.id,
      shiftNo: shift.shiftNo,
      status: shift.status,
      currency: shift.currency,
      branch: shift.branch,
      openedById: shift.openedById,
      openedByName: shift.openedByName,
      openedAt: shift.openedAt,
      openingFloat: fmt(shift.openingFloat),
      openingNote: shift.openingNote,
      closedById: shift.closedById,
      closedAt: shift.closedAt,
      // Closed shifts show what was frozen at closing; open shifts the live figures.
      tally: closed ? (shift.expected as unknown as ShiftTally | null) : tally,
      countedCash: shift.countedCash === null ? null : fmt(shift.countedCash),
      countedCard: shift.countedCard === null ? null : fmt(shift.countedCard),
      cashVariance: shift.cashVariance === null ? null : fmt(shift.cashVariance),
      cardVariance: shift.cardVariance === null ? null : fmt(shift.cardVariance),
      denominations: shift.denominations,
      closingNote: shift.closingNote,
      reviewedById: shift.reviewedById,
      reviewedAt: shift.reviewedAt,
      reviewNote: shift.reviewNote,
      version: shift.version,
    };
  }

  private load(tx: Tx, id: string) {
    return tx.cashierShift.findFirst({
      where: { id, tenantId: this.db.tenantId },
      include: { branch: { select: { id: true, code: true, name: true, nameAr: true } } },
    });
  }

  /** Cashiers see their own shifts; `cash.manage` sees every shift of their branches. */
  private assertVisible(shift: { openedById: string; branchId: string }) {
    const c = ctx();
    if (shift.openedById === c.userId) return;
    if (!c.permissions.has('cash.manage')) throw Errors.notFound('Shift');
    assertBranchAccess(shift.branchId, c);
  }

  // ------------------------------------------------------------------ open / current
  async current() {
    return this.db.tx(async (tx) => {
      const own = await CashierService.openShiftOf(tx, this.db.tenantId, ctx().userId);
      if (!own) return null;
      const shift = (await this.load(tx, own.id))!;
      return this.present(shift, await this.tally(tx, shift));
    });
  }

  async open(input: OpenShiftInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const userId = ctx().userId!;
      const branch = found(await tx.branch.findFirst({ where: { id: input.branchId, tenantId, isActive: true } }), 'Branch');
      assertBranchAccess(branch.id);
      const existing = await CashierService.openShiftOf(tx, tenantId, userId);
      if (existing) throw Errors.conflict('SHIFT_ALREADY_OPEN', 'You already have an open shift. Close it before opening a new one.', { shiftId: existing.id });
      const user = await tx.user.findFirstOrThrow({ where: { id: userId }, select: { fullName: true } });
      const currency = (await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { defaultCurrency: true } })).defaultCurrency;
      const created = await tx.cashierShift.create({
        data: {
          tenantId,
          branchId: branch.id,
          shiftNo: await this.sequences.next(tx, 'shift'),
          currency,
          openedById: userId,
          openedByName: user.fullName,
          openingFloat: D(input.openingFloat ?? 0),
          openingNote: input.note ?? null,
        },
      });
      await this.audit.log({ action: 'cash.shift_opened', resourceType: 'CashierShift', resourceId: created.id, summary: `${created.shiftNo} opened at ${branch.name} with ${currency} ${fmt(created.openingFloat)}`, after: { branchId: branch.id, openingFloat: fmt(created.openingFloat) } }, tx);
      const shift = (await this.load(tx, created.id))!;
      return this.present(shift, await this.tally(tx, shift));
    });
  }

  // ------------------------------------------------------------------ close / review
  async close(id: string, input: CloseShiftInput) {
    return this.db.tx(async (tx) => {
      const before = found(await this.load(tx, id), 'Shift');
      this.assertVisible(before);
      if (before.openedById !== ctx().userId && !ctx().permissions.has('cash.manage')) throw Errors.forbidden('FORBIDDEN', 'Only the cashier or a manager can close this shift.');
      // Lock the row: two people closing at once must not both succeed.
      await tx.$queryRaw`SELECT id FROM "cashier_shifts" WHERE id = ${id}::uuid FOR UPDATE`;
      const shift = (await this.load(tx, id))!;
      if (shift.status !== 'OPEN') throw Errors.conflict('SHIFT_NOT_OPEN', `Shift ${shift.shiftNo} is already closed.`);
      if (input.version !== undefined && input.version !== shift.version) throw Errors.conflict('STALE_VERSION', 'This shift was changed by someone else. Reload and try again.');

      const countedCash = D(input.countedCash);
      if (input.denominations) {
        const counted = sum(Object.entries(input.denominations).map(([face, count]) => D(face).mul(count ?? 0)));
        if (!counted.equals(countedCash)) {
          throw Errors.unprocessable('DENOMINATIONS_MISMATCH', `The notes and coins add up to ${fmt(counted)}, but the counted cash is ${fmt(countedCash)}.`, { denominationsTotal: fmt(counted) });
        }
      }
      const tally = await this.tally(tx, shift);
      const cashVariance = countedCash.minus(tally.expectedCash);
      const countedCard = input.countedCard === undefined || input.countedCard === null ? null : D(input.countedCard);
      const cardVariance = countedCard === null ? null : countedCard.minus(tally.expectedCard);
      const tolerance = await this.tolerance(tx);
      const flagged = cashVariance.abs().gt(tolerance) || (cardVariance !== null && cardVariance.abs().gt(tolerance));

      await tx.cashierShift.update({
        where: { id },
        data: {
          status: 'CLOSED',
          closedById: ctx().userId!,
          closedAt: new Date(),
          expected: tally as unknown as Prisma.InputJsonValue,
          countedCash,
          countedCard,
          cashVariance,
          cardVariance,
          denominations: input.denominations ? (input.denominations as Prisma.InputJsonValue) : Prisma.DbNull,
          closingNote: input.note ?? null,
          version: { increment: 1 },
        },
      });
      await this.audit.log(
        {
          action: 'cash.shift_closed',
          resourceType: 'CashierShift',
          resourceId: id,
          summary: `${shift.shiftNo} closed: expected ${fmt(tally.expectedCash)}, counted ${fmt(countedCash)}, difference ${fmt(cashVariance)}`,
          after: { expectedCash: tally.expectedCash, countedCash: fmt(countedCash), cashVariance: fmt(cashVariance), countedCard: countedCard ? fmt(countedCard) : null, cardVariance: cardVariance ? fmt(cardVariance) : null, flagged },
        },
        tx,
      );
      await this.events.emit(tx, 'cash.shift_closed', {
        shiftId: id,
        shiftNo: shift.shiftNo,
        branchId: shift.branchId,
        cashierId: shift.openedById,
        cashierName: shift.openedByName,
        expectedCash: tally.expectedCash,
        countedCash: fmt(countedCash),
        cashVariance: fmt(cashVariance),
        cardVariance: cardVariance === null ? null : fmt(cardVariance),
        currency: shift.currency,
        flagged,
      });
      const closed = (await this.load(tx, id))!;
      return { ...this.present(closed, null), flagged };
    });
  }

  async review(id: string, input: ReviewShiftInput) {
    return this.db.tx(async (tx) => {
      const shift = found(await this.load(tx, id), 'Shift');
      this.assertVisible(shift);
      if (shift.status !== 'CLOSED') throw Errors.conflict('SHIFT_NOT_CLOSED', shift.status === 'OPEN' ? 'Close the shift before reviewing it.' : `Shift ${shift.shiftNo} is already reviewed.`);
      // Four eyes: a cashier never signs off their own till (the centre owner excepted, for one-person centres).
      if (shift.openedById === ctx().userId && ctx().roleKey !== 'owner') throw Errors.forbidden('OWN_SHIFT', 'Someone else must review your shift.');
      const changed = await tx.cashierShift.updateMany({ where: { id, tenantId: this.db.tenantId, status: 'CLOSED' }, data: { status: 'REVIEWED', reviewedById: ctx().userId!, reviewedAt: new Date(), reviewNote: input.note ?? null, version: { increment: 1 } } });
      if (changed.count !== 1) throw Errors.conflict('STALE_VERSION', 'This shift was changed by someone else. Reload and try again.');
      await this.audit.log({ action: 'cash.shift_reviewed', resourceType: 'CashierShift', resourceId: id, summary: `${shift.shiftNo} reviewed`, after: { note: input.note ?? null, cashVariance: shift.cashVariance === null ? null : fmt(shift.cashVariance) } }, tx);
      return this.present((await this.load(tx, id))!, null);
    });
  }

  // ------------------------------------------------------------------ read
  async get(id: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const shift = found(await this.load(tx, id), 'Shift');
      this.assertVisible(shift);
      const [payments, refunds, expenses] = await Promise.all([
        tx.payment.findMany({
          where: { tenantId, shiftId: id },
          orderBy: { receivedAt: 'asc' },
          select: { id: true, paymentNo: true, receiptNo: true, method: true, status: true, amount: true, reference: true, receivedAt: true, customer: { select: { id: true, fullName: true, customerNo: true } } },
        }),
        tx.refund.findMany({ where: { tenantId, shiftId: id }, orderBy: { processedAt: 'asc' }, select: { id: true, refundNo: true, method: true, status: true, amount: true, processedAt: true } }),
        tx.expense.findMany({ where: { tenantId, shiftId: id, deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true, category: true, description: true, method: true, amount: true, payee: true, createdAt: true } }),
      ]);
      return {
        ...this.present(shift, shift.status === 'OPEN' ? await this.tally(tx, shift) : null),
        payments: payments.map((p) => ({ ...p, amount: fmt(p.amount) })),
        refunds: refunds.map((r) => ({ ...r, amount: fmt(r.amount) })),
        expenses: expenses.map((e) => ({ ...e, amount: fmt(e.amount) })),
      };
    });
  }

  async list(query: ShiftListQuery) {
    return this.db.tx(async (tx) => {
      const c = ctx();
      const tenantId = this.db.tenantId;
      const tz = safeTimeZone((await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { timezone: true } })).timezone);
      const where: Prisma.CashierShiftWhereInput = {
        tenantId,
        ...(c.permissions.has('cash.manage') ? { branchId: query.branchId ? query.branchId : branchFilter(c) } : { openedById: c.userId }),
        ...(query.branchId && !c.permissions.has('cash.manage') ? { branchId: query.branchId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.openedById && c.permissions.has('cash.manage') ? { openedById: query.openedById } : {}),
        ...(query.from || query.to
          ? { openedAt: { ...(query.from ? { gte: startOfLocalDay(query.from, tz) } : {}), ...(query.to ? { lt: startOfLocalDay(addDays(query.to, 1), tz) } : {}) } }
          : {}),
      };
      if (query.branchId) assertBranchAccess(query.branchId, c);
      const [rows, total] = await Promise.all([
        tx.cashierShift.findMany({ where, ...pageArgs(query, SORT, 'openedAt:desc'), include: { branch: { select: { id: true, code: true, name: true, nameAr: true } } } }),
        tx.cashierShift.count({ where }),
      ]);
      const items = [];
      for (const s of rows) items.push(this.present(s, s.status === 'OPEN' ? await this.tally(tx, s) : null));
      return pageResult(items, total, query);
    });
  }

  /**
   * Day-end closing for one local day (the centre's time zone): every payment of the day by method,
   * the shifts with their counts and differences, cash refunds and cash expenses, and what was taken
   * outside any shift (online payments, or counter payments recorded without an open shift).
   */
  async dayEnd(query: DayEndQuery) {
    return this.db.tx(async (tx) => {
      const c = ctx();
      const tenantId = this.db.tenantId;
      if (query.branchId) assertBranchAccess(query.branchId, c);
      const tenant = await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { timezone: true, defaultCurrency: true } });
      const tz = safeTimeZone(tenant.timezone);
      const from = startOfLocalDay(query.date, tz);
      const to = startOfLocalDay(addDays(query.date, 1), tz);
      const branch = query.branchId ? { branchId: query.branchId } : branchFilter(c) ? { branchId: branchFilter(c) } : {};

      const payments = await tx.payment.findMany({
        where: { tenantId, ...branch, status: { in: SETTLED }, receivedAt: { gte: from, lt: to } },
        select: { method: true, amount: true, shiftId: true, receivedById: true },
      });
      const byMethod: Record<string, string> = {};
      for (const m of [...COUNTER_METHODS, 'ONLINE_GATEWAY']) byMethod[m] = fmt(sum(payments.filter((p) => p.method === m).map((p) => p.amount)));
      const outsideShift = payments.filter((p) => !p.shiftId);
      const refunds = await tx.refund.findMany({
        where: { tenantId, status: 'COMPLETED', processedAt: { gte: from, lt: to }, ...(query.branchId || branchFilter(c) ? { payment: { is: branch } } : {}) },
        select: { method: true, amount: true },
      });
      const expenses = await tx.expense.findMany({
        where: { tenantId, ...branch, deletedAt: null, paidOn: new Date(`${query.date}T00:00:00.000Z`) },
        select: { method: true, amount: true, category: true },
      });
      const shifts = await tx.cashierShift.findMany({
        where: { tenantId, ...branch, openedAt: { lt: to }, OR: [{ closedAt: null }, { closedAt: { gte: from } }] },
        orderBy: { openedAt: 'asc' },
        include: { branch: { select: { id: true, code: true, name: true, nameAr: true } } },
      });
      const shiftViews = [];
      for (const s of shifts) shiftViews.push(this.present(s, s.status === 'OPEN' ? await this.tally(tx, s) : null));
      const closedShifts = shifts.filter((s) => s.status !== 'OPEN');
      return {
        date: query.date,
        timeZone: tz,
        currency: tenant.defaultCurrency,
        branchId: query.branchId ?? null,
        collections: { byMethod, total: fmt(sum(payments.map((p) => p.amount))), count: payments.length },
        refunds: { total: fmt(sum(refunds.map((r) => r.amount))), cash: fmt(sum(refunds.filter((r) => r.method === 'CASH').map((r) => r.amount))), count: refunds.length },
        expenses: { total: fmt(sum(expenses.map((e) => e.amount))), cash: fmt(sum(expenses.filter((e) => e.method === 'CASH').map((e) => e.amount))), count: expenses.length },
        outsideShifts: {
          total: fmt(sum(outsideShift.map((p) => p.amount))),
          counter: fmt(sum(outsideShift.filter((p) => p.method !== 'ONLINE_GATEWAY').map((p) => p.amount))),
          online: fmt(sum(outsideShift.filter((p) => p.method === 'ONLINE_GATEWAY').map((p) => p.amount))),
          count: outsideShift.length,
        },
        shifts: shiftViews,
        variance: {
          cash: fmt(sum(closedShifts.map((s) => s.cashVariance ?? 0))),
          card: fmt(sum(closedShifts.map((s) => s.cardVariance ?? 0))),
          openShifts: shifts.filter((s) => s.status === 'OPEN').length,
          unreviewed: shifts.filter((s) => s.status === 'CLOSED').length,
        },
      };
    });
  }
}
