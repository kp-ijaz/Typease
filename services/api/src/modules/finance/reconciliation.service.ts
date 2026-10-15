import { Injectable } from '@nestjs/common';
import type { CreateReconciliationInput, ReconciliationListQuery, UpdateReconciliationInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { Prisma, TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { D, pageArgs, pageResult, sum } from '../../common/pagination';
import { assertBranchAccess, branchFilter } from '../../common/scope';
import { fmt } from './finance.calc';
import { dateRange } from './finance.core';
import { SETTLED } from './payments.service';

const SORT = ['periodStart', 'createdAt', 'difference', 'settledAmount'] as const;
const PAYMENT_SELECT = { id: true, paymentNo: true, receiptNo: true, method: true, gateway: true, amount: true, refundedAmount: true, status: true, receivedAt: true, reference: true, branchId: true, customerId: true } as const;
type Record_ = { id: string; branchId: string | null; method: any; gateway: string | null; periodStart: Date; periodEnd: Date; settledAmount: Prisma.Decimal; feeAmount: Prisma.Decimal; status: string };

/** What a completed payment contributes to a settlement: what was taken minus what was refunded. */
const net = (p: { amount: Prisma.Decimal; refundedAmount: Prisma.Decimal }) => D(p.amount).minus(p.refundedAmount);

/**
 * Settlement reconciliation: the accountant compares what the bank / gateway /
 * till says was settled (plus the fees it deducted) with the payments TypEase
 * recorded for that method and period.
 *
 *   expected   = net amount of the attached payments
 *                (before any payment is attached: of every completed, un-reconciled payment in the period)
 *   difference = settledAmount + feeAmount - expected
 *   status     = OPEN (nothing attached) -> MATCHED (difference 0) | DISCREPANCY -> CLOSED
 */
@Injectable()
export class ReconciliationService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
  ) {}

  private scope(): Prisma.ReconciliationRecordWhereInput {
    const branches = branchFilter();
    return branches ? { branchId: branches } : {};
  }
  private candidateWhere(r: Pick<Record_, 'branchId' | 'method' | 'gateway' | 'periodStart' | 'periodEnd'>): Prisma.PaymentWhereInput {
    const branches = branchFilter();
    return {
      tenantId: this.db.tenantId,
      status: { in: SETTLED },
      method: r.method,
      ...(r.method === 'ONLINE_GATEWAY' && r.gateway ? { gateway: r.gateway } : {}),
      ...(r.branchId ? { branchId: r.branchId } : branches ? { branchId: branches } : {}),
      reconciliationId: null,
      receivedAt: { gte: r.periodStart, lt: r.periodEnd },
    };
  }

  /** Recomputes expected / difference / status from the attached payments. */
  private async refresh(tx: Tx, r: Record_) {
    const attached = await tx.payment.findMany({ where: { tenantId: this.db.tenantId, reconciliationId: r.id }, select: { amount: true, refundedAmount: true } });
    let expected: Prisma.Decimal;
    if (attached.length) expected = sum(attached.map(net));
    else expected = sum((await tx.payment.findMany({ where: this.candidateWhere(r), select: { amount: true, refundedAmount: true } })).map(net));
    const difference = D(r.settledAmount).plus(r.feeAmount).minus(expected);
    const status = r.status === 'CLOSED' ? 'CLOSED' : !attached.length ? 'OPEN' : difference.isZero() ? 'MATCHED' : 'DISCREPANCY';
    return tx.reconciliationRecord.update({ where: { id: r.id }, data: { expectedAmount: expected, difference, status } });
  }

  private async load(tx: Tx, id: string) {
    return found(await tx.reconciliationRecord.findFirst({ where: { id, tenantId: this.db.tenantId, ...this.scope() } }), 'Reconciliation');
  }
  private async detail(tx: Tx, id: string) {
    const record = await this.load(tx, id);
    const [attached, candidates] = await Promise.all([
      tx.payment.findMany({ where: { tenantId: this.db.tenantId, reconciliationId: id }, select: PAYMENT_SELECT, orderBy: { receivedAt: 'asc' } }),
      record.status === 'CLOSED' ? Promise.resolve([]) : tx.payment.findMany({ where: this.candidateWhere(record), select: PAYMENT_SELECT, orderBy: { receivedAt: 'asc' }, take: 500 }),
    ]);
    return {
      ...record,
      attached: { count: attached.length, total: fmt(sum(attached.map(net))), payments: attached },
      candidates: { count: candidates.length, total: fmt(sum(candidates.map(net))), payments: candidates },
    };
  }

  get(id: string) {
    return this.db.tx((tx) => this.detail(tx, id));
  }

  async list(query: ReconciliationListQuery) {
    return this.db.tx(async (tx) => {
      const period = dateRange(query.from, query.to);
      const where: Prisma.ReconciliationRecordWhereInput = {
        tenantId: this.db.tenantId,
        AND: [this.scope(), query.status ? { status: query.status } : {}, query.method ? { method: query.method } : {}, period ? { periodStart: period } : {}, query.q ? { statementReference: { contains: query.q, mode: 'insensitive' } } : {}],
      };
      const [rows, total] = await Promise.all([tx.reconciliationRecord.findMany({ where, ...pageArgs(query, SORT, 'periodStart:desc') }), tx.reconciliationRecord.count({ where })]);
      return pageResult(rows, total, query);
    });
  }

  async create(input: CreateReconciliationInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      if (input.branchId) {
        found(await tx.branch.findFirst({ where: { id: input.branchId, tenantId } }), 'Branch');
        assertBranchAccess(input.branchId);
      } else if (branchFilter()) {
        throw Errors.unprocessable('BRANCH_REQUIRED', 'Choose the branch you are reconciling.');
      }
      const record = await tx.reconciliationRecord.create({
        data: {
          tenantId,
          branchId: input.branchId ?? null,
          method: input.method,
          gateway: input.method === 'ONLINE_GATEWAY' ? (input.gateway ?? null) : null,
          periodStart: new Date(input.periodStart),
          periodEnd: new Date(input.periodEnd),
          statementReference: input.statementReference ?? null,
          expectedAmount: 0,
          settledAmount: D(input.settledAmount),
          feeAmount: D(input.feeAmount),
          difference: 0,
          status: 'OPEN',
          notes: input.notes ?? null,
          reconciledById: ctx().userId!,
        },
      });
      if (input.attachAll) {
        await tx.payment.updateMany({ where: this.candidateWhere(record), data: { reconciliationId: record.id, reconciledAt: new Date() } });
      }
      const refreshed = await this.refresh(tx, record);
      await this.audit.log(
        {
          action: 'reconciliation.created',
          resourceType: 'ReconciliationRecord',
          resourceId: record.id,
          summary: `${input.method}${record.gateway ? ` (${record.gateway})` : ''} ${input.periodStart.slice(0, 10)} to ${input.periodEnd.slice(0, 10)}`,
          after: { settledAmount: fmt(refreshed.settledAmount), feeAmount: fmt(refreshed.feeAmount), expectedAmount: fmt(refreshed.expectedAmount), difference: fmt(refreshed.difference), status: refreshed.status, attachAll: input.attachAll },
        },
        tx,
      );
      return this.detail(tx, record.id);
    });
  }

  private async open(tx: Tx, id: string) {
    const record = await this.load(tx, id);
    await tx.$queryRaw`SELECT "id" FROM "reconciliation_records" WHERE "id" = ${id}::uuid FOR UPDATE`;
    if (record.status === 'CLOSED') throw Errors.conflict('RECONCILIATION_CLOSED', 'This reconciliation is closed and can no longer be changed.');
    return record;
  }

  async update(id: string, input: UpdateReconciliationInput) {
    return this.db.tx(async (tx) => {
      const before = await this.open(tx, id);
      const updated = await tx.reconciliationRecord.update({
        where: { id },
        data: {
          ...(input.statementReference !== undefined ? { statementReference: input.statementReference ?? null } : {}),
          ...(input.settledAmount !== undefined ? { settledAmount: D(input.settledAmount) } : {}),
          ...(input.feeAmount !== undefined ? { feeAmount: D(input.feeAmount) } : {}),
          ...(input.notes !== undefined ? { notes: input.notes ?? null } : {}),
        },
      });
      const after = await this.refresh(tx, updated);
      await this.audit.log(
        {
          action: 'reconciliation.updated',
          resourceType: 'ReconciliationRecord',
          resourceId: id,
          before: { settledAmount: fmt(before.settledAmount), feeAmount: fmt(before.feeAmount), difference: fmt(before.difference), status: before.status },
          after: { settledAmount: fmt(after.settledAmount), feeAmount: fmt(after.feeAmount), difference: fmt(after.difference), status: after.status },
        },
        tx,
      );
      return this.detail(tx, id);
    });
  }

  async attach(id: string, paymentIds: string[]) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const record = await this.open(tx, id);
      const ids = [...new Set(paymentIds)];
      const payments = await tx.payment.findMany({ where: { tenantId, id: { in: ids }, ...(branchFilter() ? { branchId: branchFilter() } : {}) }, select: PAYMENT_SELECT });
      if (payments.length !== ids.length) throw Errors.notFound('Payment');
      for (const p of payments) {
        if (!SETTLED.includes(p.status as any)) throw Errors.unprocessable('PAYMENT_NOT_COMPLETED', `${p.paymentNo} is not a completed payment.`);
        if (p.method !== record.method || (record.method === 'ONLINE_GATEWAY' && record.gateway && p.gateway !== record.gateway)) {
          throw Errors.unprocessable('PAYMENT_METHOD_MISMATCH', `${p.paymentNo} was paid by ${p.method}${p.gateway ? ` (${p.gateway})` : ''}, which does not belong in this reconciliation.`);
        }
        if (record.branchId && p.branchId !== record.branchId) throw Errors.unprocessable('PAYMENT_BRANCH_MISMATCH', `${p.paymentNo} belongs to a different branch.`);
      }
      // Conditional on "not reconciled yet": a payment can be in one reconciliation only.
      const changed = await tx.payment.updateMany({ where: { tenantId, id: { in: ids }, reconciliationId: null }, data: { reconciliationId: id, reconciledAt: new Date() } });
      if (changed.count !== ids.length) throw Errors.conflict('ALREADY_RECONCILED', 'One or more of these payments are already part of a reconciliation.');
      const after = await this.refresh(tx, record);
      await this.audit.log(
        { action: 'reconciliation.payments_attached', resourceType: 'ReconciliationRecord', resourceId: id, after: { payments: payments.map((p) => p.paymentNo), expectedAmount: fmt(after.expectedAmount), difference: fmt(after.difference), status: after.status } },
        tx,
      );
      return this.detail(tx, id);
    });
  }

  async detach(id: string, paymentIds: string[]) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const record = await this.open(tx, id);
      const ids = [...new Set(paymentIds)];
      const changed = await tx.payment.updateMany({ where: { tenantId, id: { in: ids }, reconciliationId: id }, data: { reconciliationId: null, reconciledAt: null } });
      if (changed.count !== ids.length) throw Errors.unprocessable('NOT_ATTACHED', 'One or more of these payments are not part of this reconciliation.');
      const after = await this.refresh(tx, record);
      await this.audit.log({ action: 'reconciliation.payments_detached', resourceType: 'ReconciliationRecord', resourceId: id, after: { count: ids.length, expectedAmount: fmt(after.expectedAmount), difference: fmt(after.difference), status: after.status } }, tx);
      return this.detail(tx, id);
    });
  }

  async close(id: string, notes?: string | null) {
    return this.db.tx(async (tx) => {
      const record = await this.refresh(tx, await this.open(tx, id));
      if (record.status === 'OPEN') throw Errors.conflict('NOTHING_ATTACHED', 'Attach the payments this statement covers before closing the reconciliation.');
      if (record.status === 'DISCREPANCY' && !(notes ?? record.notes)) {
        throw Errors.unprocessable('EXPLANATION_REQUIRED', `There is a difference of ${fmt(record.difference)}. Add a note explaining it before closing.`);
      }
      await tx.reconciliationRecord.update({ where: { id }, data: { status: 'CLOSED', ...(notes ? { notes } : {}) } });
      await this.audit.log(
        { action: 'reconciliation.closed', resourceType: 'ReconciliationRecord', resourceId: id, summary: `Closed with difference ${fmt(record.difference)}`, before: { status: record.status }, after: { status: 'CLOSED', difference: fmt(record.difference), notes: notes ?? record.notes } },
        tx,
      );
      return this.detail(tx, id);
    });
  }
}
