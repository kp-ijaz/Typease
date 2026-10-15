import { Injectable } from '@nestjs/common';
import type { CreateExpenseInput, ExpenseListQuery, FeeComponentsUpdateInput, LiabilityQuery, UpdateExpenseInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { Prisma, TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { D, pageArgs, pageResult } from '../../common/pagination';
import { assertBranchAccess, branchFilter } from '../../common/scope';
import { CashierService } from './cashier.service';
import { LedgerService } from './ledger.service';
import { fmt } from './finance.calc';
import { dateRange } from './finance.core';

const SORT = ['paidOn', 'amount', 'createdAt', 'category'] as const;
const REMITTANCE_COMPONENT: Record<string, 'GOVERNMENT_FEE' | 'THIRD_PARTY_FEE'> = { GOVERNMENT_FEE_REMITTANCE: 'GOVERNMENT_FEE', THIRD_PARTY_PAYMENT: 'THIRD_PARTY_FEE' };
const LABEL = { GOVERNMENT_FEE: 'government fees', THIRD_PARTY_FEE: 'third-party charges' } as const;
export const TREATMENT_NOTICE =
  'Accounting treatment decides whether money you collect is your revenue or a liability held for someone else. ' +
  'Government and third-party fees are pass-through liabilities by default and are never reported as centre revenue. ' +
  'Review any change with your accountant or tax adviser: it depends on your legal arrangements.';

interface Balance {
  accrued: Prisma.Decimal;
  reversed: Prisma.Decimal;
  remitted: Prisma.Decimal;
  outstanding: Prisma.Decimal;
}

/**
 * Liability ledger: money held on behalf of authorities and third parties.
 *   outstanding = accruals (collected) - reversals (refunded / credited) - remittances (paid out)
 * The ledger is append-only; a deleted remittance is undone with a compensating
 * entry (sourceType EXPENSE_VOID) which reports count as a negative remittance.
 */
@Injectable()
export class ExpensesService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
  ) {}

  // ------------------------------------------------------------------ fee components
  async feeComponents() {
    return this.db.tx(async (tx) => ({
      notice: TREATMENT_NOTICE,
      components: await tx.feeComponent.findMany({ where: { tenantId: this.db.tenantId }, orderBy: { type: 'asc' } }),
    }));
  }

  async updateFeeComponents(input: FeeComponentsUpdateInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      for (const change of input.components) {
        if (change.type === 'SERVICE_FEE' && change.treatment && change.treatment !== 'REVENUE') {
          throw Errors.unprocessable('SERVICE_FEE_IS_REVENUE', 'The typing centre service fee is always the centre\'s own revenue. Only government and third-party fees can be treated as pass-through.');
        }
        const before = found(await tx.feeComponent.findFirst({ where: { tenantId, type: change.type } }), 'Fee component');
        const data: Prisma.FeeComponentUpdateInput = {};
        if (change.name !== undefined) data.name = change.name;
        if (change.taxable !== undefined) data.taxable = change.taxable;
        if (change.ledgerCode !== undefined) data.ledgerCode = change.ledgerCode;
        if (change.treatment !== undefined && change.treatment !== before.treatment) {
          data.treatment = change.treatment;
          data.reviewNote = `Treatment changed from ${before.treatment} to ${change.treatment} on ${new Date().toISOString().slice(0, 10)}. Confirm with your accountant / tax adviser. Applies to payments recorded from now on.`;
        }
        if (!Object.keys(data).length) continue;
        const after = await tx.feeComponent.update({ where: { id: before.id }, data });
        await this.audit.log(
          {
            action: 'finance.fee_component_updated',
            resourceType: 'FeeComponent',
            resourceId: before.id,
            summary: `${before.type} treatment / settings changed`,
            before: { name: before.name, treatment: before.treatment, taxable: before.taxable, ledgerCode: before.ledgerCode },
            after: { name: after.name, treatment: after.treatment, taxable: after.taxable, ledgerCode: after.ledgerCode },
          },
          tx,
        );
      }
      return { notice: TREATMENT_NOTICE, components: await tx.feeComponent.findMany({ where: { tenantId }, orderBy: { type: 'asc' } }) };
    });
  }

  // ------------------------------------------------------------------ liabilities
  private async balances(tx: Tx, filter: { requestId?: string; branchIds?: string[]; component?: string }): Promise<Map<string, Balance>> {
    const tenantId = this.db.tenantId;
    const rows = await tx.$queryRaw<Array<{ requestId: string | null; component: string; accrued: Prisma.Decimal; reversed: Prisma.Decimal; remitted: Prisma.Decimal }>>`
      SELECT "requestId", "component"::text AS component,
        COALESCE(SUM(CASE WHEN "direction" = 'ACCRUAL' AND "sourceType" <> 'EXPENSE_VOID' THEN "amount" ELSE 0 END), 0) AS accrued,
        COALESCE(SUM(CASE WHEN "direction" = 'REVERSAL' THEN "amount" ELSE 0 END), 0) AS reversed,
        COALESCE(SUM(CASE WHEN "direction" = 'REMITTANCE' THEN "amount" WHEN "direction" = 'ACCRUAL' AND "sourceType" = 'EXPENSE_VOID' THEN -"amount" ELSE 0 END), 0) AS remitted
      FROM "liability_entries"
      WHERE "tenantId" = ${tenantId}::uuid
        ${filter.requestId ? Prisma.sql`AND "requestId" = ${filter.requestId}::uuid` : Prisma.empty}
        ${filter.component ? Prisma.sql`AND "component"::text = ${filter.component}` : Prisma.empty}
        ${filter.branchIds ? Prisma.sql`AND "branchId"::text = ANY(${filter.branchIds})` : Prisma.empty}
      GROUP BY "requestId", "component"`;
    const out = new Map<string, Balance>();
    for (const r of rows) {
      const accrued = D(r.accrued);
      const reversed = D(r.reversed);
      const remitted = D(r.remitted);
      out.set(`${r.requestId ?? ''}|${r.component}`, { accrued, reversed, remitted, outstanding: accrued.minus(reversed).minus(remitted) });
    }
    return out;
  }

  /** Outstanding pass-through money per component and per request. */
  async liabilities(query: LiabilityQuery) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const branches = query.branchId ? [query.branchId] : branchFilter()?.in;
      if (query.branchId) assertBranchAccess(query.branchId);
      const all = await this.balances(tx, { requestId: query.requestId, branchIds: branches, component: query.component });
      const zero = (): Balance => ({ accrued: D(0), reversed: D(0), remitted: D(0), outstanding: D(0) });
      const totals: Record<string, Balance> = { GOVERNMENT_FEE: zero(), THIRD_PARTY_FEE: zero() };
      const perRequest = new Map<string, Record<string, Balance>>();
      for (const [key, b] of all) {
        const [requestId, component] = key.split('|');
        const t = totals[component];
        t.accrued = t.accrued.plus(b.accrued);
        t.reversed = t.reversed.plus(b.reversed);
        t.remitted = t.remitted.plus(b.remitted);
        t.outstanding = t.outstanding.plus(b.outstanding);
        const row = perRequest.get(requestId) ?? {};
        row[component] = b;
        perRequest.set(requestId, row);
      }
      let keys = [...perRequest.keys()];
      if (query.outstandingOnly) keys = keys.filter((k) => Object.values(perRequest.get(k)!).some((b) => !b.outstanding.isZero()));
      const requests = await tx.serviceRequest.findMany({
        where: { tenantId, id: { in: keys.filter(Boolean) } },
        select: { id: true, requestNo: true, status: true, customer: { select: { id: true, fullName: true } }, service: { select: { name: true } } },
      });
      const byId = new Map(requests.map((r) => [r.id, r]));
      keys.sort((a, b) => (byId.get(b)?.requestNo ?? '').localeCompare(byId.get(a)?.requestNo ?? ''));
      const page = keys.slice((query.page - 1) * query.pageSize, query.page * query.pageSize);
      const show = (b?: Balance) => ({ accrued: fmt(b?.accrued), reversed: fmt(b?.reversed), remitted: fmt(b?.remitted), outstanding: fmt(b?.outstanding) });
      const components = await tx.feeComponent.findMany({ where: { tenantId, type: { in: ['GOVERNMENT_FEE', 'THIRD_PARTY_FEE'] } }, select: { type: true, name: true, treatment: true, ledgerCode: true } });
      return {
        currency: (await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { defaultCurrency: true } })).defaultCurrency,
        components: (['GOVERNMENT_FEE', 'THIRD_PARTY_FEE'] as const)
          .filter((c) => !query.component || query.component === c)
          .map((c) => ({ component: c, ...(components.find((x) => x.type === c) ?? {}), ...show(totals[c]) })),
        totalOutstanding: fmt(totals.GOVERNMENT_FEE.outstanding.plus(totals.THIRD_PARTY_FEE.outstanding)),
        requests: pageResult(
          page.map((k) => {
            const r = byId.get(k);
            const row = perRequest.get(k)!;
            return {
              requestId: k || null,
              requestNo: r?.requestNo ?? null,
              requestStatus: r?.status ?? null,
              customer: r?.customer ?? null,
              service: r?.service.name ?? null,
              governmentFee: show(row.GOVERNMENT_FEE),
              thirdPartyFee: show(row.THIRD_PARTY_FEE),
              outstanding: fmt(D(row.GOVERNMENT_FEE?.outstanding).plus(D(row.THIRD_PARTY_FEE?.outstanding))),
            };
          }),
          keys.length,
          query,
        ),
      };
    });
  }

  // ------------------------------------------------------------------ expenses
  private scope(): Prisma.ExpenseWhereInput {
    const branches = branchFilter();
    return { deletedAt: null, ...(branches ? { branchId: branches } : {}) };
  }
  private async load(tx: Tx, id: string) {
    return found(await tx.expense.findFirst({ where: { id, tenantId: this.db.tenantId, ...this.scope() }, include: { branch: { select: { id: true, code: true, name: true } } } }), 'Expense');
  }
  get(id: string) {
    return this.db.tx((tx) => this.load(tx, id));
  }

  async list(query: ExpenseListQuery) {
    return this.db.tx(async (tx) => {
      const paid = dateRange(query.from, query.to);
      const where: Prisma.ExpenseWhereInput = {
        tenantId: this.db.tenantId,
        AND: [
          this.scope(),
          query.category ? { category: query.category } : {},
          query.branchId ? { branchId: query.branchId } : {},
          query.requestId ? { requestId: query.requestId } : {},
          paid ? { paidOn: paid } : {},
          query.q ? { OR: [{ description: { contains: query.q, mode: 'insensitive' } }, { payee: { contains: query.q, mode: 'insensitive' } }, { reference: { contains: query.q, mode: 'insensitive' } }] } : {},
        ],
      };
      const [rows, total, totals] = await Promise.all([
        tx.expense.findMany({ where, ...pageArgs(query, SORT, 'paidOn:desc'), include: { branch: { select: { id: true, code: true, name: true } } } }),
        tx.expense.count({ where }),
        tx.expense.aggregate({ where, _sum: { amount: true } }),
      ]);
      return { ...pageResult(rows, total, query), totalAmount: fmt(totals._sum.amount) };
    });
  }

  /** Serialises remittances of one request so two people cannot both pay out the same liability. */
  private async lockRequestLedger(tx: Tx, requestId: string) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${this.db.tenantId}:liability:${requestId}`}, 0))::text AS locked`;
  }

  async create(input: CreateExpenseInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const branch = found(await tx.branch.findFirst({ where: { id: input.branchId, tenantId } }), 'Branch');
      assertBranchAccess(branch.id);
      const request = input.requestId ? found(await tx.serviceRequest.findFirst({ where: { id: input.requestId, tenantId, deletedAt: null }, select: { id: true, requestNo: true } }), 'Request') : null;
      const currency = (await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { defaultCurrency: true } })).defaultCurrency;
      const amount = D(input.amount);
      const component = REMITTANCE_COMPONENT[input.category];
      if (component && request) {
        await this.lockRequestLedger(tx, request.id);
        const balance = (await this.balances(tx, { requestId: request.id, component })).get(`${request.id}|${component}`);
        const outstanding = balance?.outstanding ?? D(0);
        if (amount.gt(outstanding)) {
          throw Errors.unprocessable(
            'REMITTANCE_EXCEEDS_LIABILITY',
            `Only ${currency} ${fmt(Prisma.Decimal.max(outstanding, 0))} of ${LABEL[component]} has been collected and not yet paid out for request ${request.requestNo}. You cannot remit ${currency} ${fmt(amount)}.`,
            { outstanding: fmt(Prisma.Decimal.max(outstanding, 0)), component },
          );
        }
      }
      const expense = await tx.expense.create({
        data: {
          tenantId,
          branchId: branch.id,
          category: input.category,
          requestId: request?.id ?? null,
          description: input.description,
          amount,
          currency,
          paidOn: new Date(`${input.paidOn}T00:00:00.000Z`),
          payee: input.payee ?? null,
          reference: input.reference ?? null,
          method: input.method ?? null,
          recordedById: ctx().userId!,
          // Paid in cash from the drawer: it reduces the cash expected in the recorder's open shift.
          shiftId: input.method === 'CASH' ? ((await CashierService.openShiftOf(tx, tenantId, ctx().userId, branch.id))?.id ?? null) : null,
        },
      });
      if (component && request) {
        await tx.liabilityEntry.create({
          data: { tenantId, branchId: branch.id, component, direction: 'REMITTANCE', amount, currency, requestId: request.id, invoiceId: null, sourceType: 'EXPENSE', sourceId: expense.id },
        });
      }
      await this.audit.log(
        {
          action: 'expense.created',
          resourceType: 'Expense',
          resourceId: expense.id,
          summary: `${input.category}: ${currency} ${fmt(amount)}${request ? ` for ${request.requestNo}` : ''}`,
          after: { category: input.category, amount: fmt(amount), requestId: request?.id ?? null, payee: input.payee ?? null, reference: input.reference ?? null, remittanceRecorded: !!(component && request) },
        },
        tx,
      );
      await this.ledger.postExpense(tx, this.db.tenantId, expense.id);
      return { ...(await this.load(tx, expense.id)), liabilitySettled: !!(component && request) };
    });
  }

  private remittanceEntry(tx: Tx, expenseId: string) {
    return tx.liabilityEntry.findFirst({ where: { tenantId: this.db.tenantId, sourceType: 'EXPENSE', sourceId: expenseId, direction: 'REMITTANCE' } });
  }

  async update(id: string, input: UpdateExpenseInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const before = await this.load(tx, id);
      const settled = await this.remittanceEntry(tx, id);
      const changed = {
        amount: input.amount !== undefined && !D(input.amount).equals(before.amount),
        category: input.category !== undefined && input.category !== before.category,
        requestId: input.requestId !== undefined && (input.requestId ?? null) !== before.requestId,
        branchId: input.branchId !== undefined && input.branchId !== before.branchId,
      };
      const touchesLedger = Object.values(changed).some(Boolean);
      if (settled && touchesLedger) {
        throw Errors.conflict('REMITTANCE_RECORDED', 'This expense settled a liability, so its amount, category, branch and request cannot be changed. Delete it and record it again.');
      }
      const data: Prisma.ExpenseUncheckedUpdateInput = {};
      if (input.branchId !== undefined) {
        found(await tx.branch.findFirst({ where: { id: input.branchId, tenantId } }), 'Branch');
        assertBranchAccess(input.branchId);
        data.branchId = input.branchId;
      }
      const nextCategory = input.category ?? before.category;
      const nextRequestId = input.requestId !== undefined ? input.requestId : before.requestId;
      if (!settled && REMITTANCE_COMPONENT[nextCategory] && nextRequestId && (changed.category || changed.requestId)) {
        throw Errors.conflict('RECORD_AS_NEW', 'To settle a request\'s liability, delete this expense and record it again as a remittance linked to the request.');
      }
      if (input.requestId !== undefined) {
        if (input.requestId) found(await tx.serviceRequest.findFirst({ where: { id: input.requestId, tenantId, deletedAt: null }, select: { id: true } }), 'Request');
        data.requestId = input.requestId ?? null;
      }
      if (input.category !== undefined) data.category = input.category;
      if (input.amount !== undefined) data.amount = D(input.amount);
      if (input.description !== undefined) data.description = input.description;
      if (input.paidOn !== undefined) data.paidOn = new Date(`${input.paidOn}T00:00:00.000Z`);
      if (input.payee !== undefined) data.payee = input.payee ?? null;
      if (input.reference !== undefined) data.reference = input.reference ?? null;
      if (input.method !== undefined) data.method = input.method ?? null;
      await tx.expense.update({ where: { id }, data });
      const after = await this.load(tx, id);
      if (touchesLedger || input.paidOn !== undefined || input.method !== undefined || input.description !== undefined) await this.ledger.repostExpense(tx, tenantId, id);
      await this.audit.log(
        {
          action: 'expense.updated',
          resourceType: 'Expense',
          resourceId: id,
          before: { category: before.category, amount: fmt(before.amount), description: before.description, payee: before.payee, reference: before.reference, paidOn: before.paidOn },
          after: { category: after.category, amount: fmt(after.amount), description: after.description, payee: after.payee, reference: after.reference, paidOn: after.paidOn },
        },
        tx,
      );
      return after;
    });
  }

  /** Soft delete. A recorded remittance is undone in the ledger with a compensating entry. */
  async remove(id: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const expense = await this.load(tx, id);
      const settled = await this.remittanceEntry(tx, id);
      if (settled) {
        if (settled.requestId) await this.lockRequestLedger(tx, settled.requestId);
        await tx.liabilityEntry.create({
          data: { tenantId, branchId: settled.branchId, component: settled.component, direction: 'ACCRUAL', amount: settled.amount, currency: settled.currency, requestId: settled.requestId, invoiceId: null, sourceType: 'EXPENSE_VOID', sourceId: expense.id },
        });
      }
      await tx.expense.update({ where: { id }, data: { deletedAt: new Date() } });
      await this.ledger.repostExpense(tx, tenantId, id);
      await this.audit.log(
        { action: 'expense.deleted', resourceType: 'Expense', resourceId: id, summary: `${expense.category}: ${expense.currency} ${fmt(expense.amount)} deleted`, before: { category: expense.category, amount: fmt(expense.amount), requestId: expense.requestId }, after: { remittanceReversed: !!settled } },
        tx,
      );
      return { status: 'DELETED' as const, remittanceReversed: !!settled };
    });
  }
}
