import { Injectable } from '@nestjs/common';
import type { FinanceLineInput } from '@typease/validation';
import { ctx, Ctx } from '../../common/context';
import { Prisma, TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { assertCustomerNotErased } from '../../common/customer-ref';
import { mergedCustomerIds } from '../../common/merged-customers';
import { D, DecimalInput, sum } from '../../common/pagination';
import { assertBranchAccess, branchFilter, defaultBranchId, ownCorporateAccountId, ownCustomerId } from '../../common/scope';
import {
  accrualForPayment, calculateDocument, CalculatedDocument, CalculationError, Component, ComponentAmounts, componentTotals, defaultTaxRate, invoiceState,
  PASS_THROUGH, passThroughTargets, zeroComponents,
} from './finance.calc';

type Dec = Prisma.Decimal;
const MAX_TOTAL = new Prisma.Decimal('99999999999.99');

export type Audience = 'STAFF' | 'CUSTOMER' | 'CORPORATE';
export function audience(c: Ctx = ctx()): Audience {
  if (c.actorType === 'CUSTOMER') return 'CUSTOMER';
  if (c.actorType === 'CORPORATE') return 'CORPORATE';
  return 'STAFF';
}
export const customerFacing = (c: Ctx = ctx()) => audience(c) !== 'STAFF';

/**
 * Invoices a customer or a company user may see: never a draft, and never an invoice that was voided without
 * ever having been issued (draft -> void: it was a working paper of the centre, the customer was never asked
 * to pay it). Staff see everything their scope allows.
 */
export const CUSTOMER_VISIBLE_INVOICE = { NOT: [{ status: 'DRAFT' as const }, { status: 'VOID' as const, issuedAt: null }] };
export const invoiceVisibility = (c: Ctx = ctx()): Record<string, any> => (customerFacing(c) ? CUSTOMER_VISIBLE_INVOICE : {});

/**
 * Row-level scope for finance documents that carry customerId / corporateAccountId /
 * branchId (/ requestId): customers see their own, corporate users their company's,
 * staff their branches, and operators limited to "assigned requests" only documents
 * of requests assigned to them.
 */
export function documentScope(opts: { hasRequest?: boolean } = { hasRequest: true }, c: Ctx = ctx()): Record<string, any> {
  if (c.actorType === 'CUSTOMER') return ownRecords(ownCustomerId(c));
  if (c.actorType === 'CORPORATE') return { corporateAccountId: ownCorporateAccountId(c) };
  const where: Record<string, any> = {};
  const branches = branchFilter(c);
  if (branches) where.branchId = branches;
  if (opts.hasRequest !== false && c.actorType === 'STAFF' && c.membershipId && c.permissions.has('request.read.assigned') && !c.permissions.has('request.read.all')) {
    where.request = { OR: [{ assignedToId: c.membershipId }, { reviewerId: c.membershipId }] };
  }
  return where;
}

/**
 * What belongs to one customer record, including what stayed on records that were merged into it.
 * Issued invoices and completed payments are immutable: after a merge they keep the id of the retired
 * record (`customers.mergedIntoId` points at the record that was kept; the merge re-points earlier merges,
 * so one level is the whole history). Without this a customer would lose sight of - and could not pay -
 * invoices issued before two of their records were merged. Always combine with AND, never by spreading.
 */
export function ownRecords(customerId: string): Record<string, any> {
  return { OR: [{ customerId }, { customer: { is: { mergedIntoId: customerId, status: 'MERGED' } } }] };
}

/** Inclusive date range (YYYY-MM-DD, interpreted as UTC days) for a timestamp column. */
export function dateRange(from?: string, to?: string): { gte?: Date; lt?: Date } | undefined {
  if (!from && !to) return undefined;
  const out: { gte?: Date; lt?: Date } = {};
  if (from) out.gte = new Date(`${from}T00:00:00.000Z`);
  if (to) out.lt = new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 86_400_000);
  return out;
}

export function toLineData(doc: CalculatedDocument) {
  return doc.lines.map((l) => ({
    serviceId: l.serviceId,
    description: l.description,
    component: l.component,
    quantity: l.quantity,
    unitAmount: l.unitAmount,
    discountAmount: l.discountAmount,
    taxRatePercent: l.taxRatePercent,
    taxAmount: l.taxAmount,
    lineTotal: l.lineTotal,
    sortOrder: l.sortOrder,
  }));
}
export function totalsData(doc: CalculatedDocument) {
  return {
    subtotalServiceFee: doc.subtotalServiceFee,
    subtotalGovernmentFee: doc.subtotalGovernmentFee,
    subtotalThirdParty: doc.subtotalThirdParty,
    discountTotal: doc.discountTotal,
    taxTotal: doc.taxTotal,
    total: doc.total,
  };
}

export interface LedgerState {
  /** Component totals of the invoice after credit notes. */
  effective: ComponentAmounts;
  /** Pass-through liability accrued for this invoice, net of reversals. */
  netAccrued: { GOVERNMENT_FEE: Dec; THIRD_PARTY_FEE: Dec };
}

/**
 * Building blocks shared by quotations, invoices, payments, refunds and credit
 * notes. Everything runs inside the caller's tenant transaction.
 */
@Injectable()
export class FinanceCore {
  constructor(private readonly db: TenantDb) {}

  async settings(tx: Tx) {
    const tenant = await tx.tenant.findFirstOrThrow({ where: { id: this.db.tenantId } });
    const s = (tenant.settings ?? {}) as Record<string, unknown>;
    const int = (v: unknown, def: number) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : def);
    return {
      tenant,
      currency: tenant.defaultCurrency,
      taxRatePercent: D(tenant.taxRatePercent),
      quotationValidityDays: int(s.quotationValidityDays, 14),
      invoiceDueDays: int(s.invoiceDueDays, 0),
    };
  }

  /** Validates every foreign key that came from the client inside the current tenant. */
  async resolveParties(tx: Tx, input: { customerId: string; branchId?: string | null; requestId?: string | null; corporateAccountId?: string | null }) {
    const tenantId = this.db.tenantId;
    await assertCustomerNotErased(tx, tenantId, input.customerId);
    const customer = found(await tx.customer.findFirst({ where: { id: input.customerId, tenantId, deletedAt: null } }), 'Customer');
    if (customer.status !== 'ACTIVE') throw Errors.unprocessable('CUSTOMER_INACTIVE', 'This customer record is archived or merged. Open the active customer record instead.');
    const request = input.requestId ? found(await tx.serviceRequest.findFirst({ where: { id: input.requestId, tenantId, deletedAt: null } }), 'Request') : null;
    if (request && request.customerId !== customer.id) {
      throw Errors.unprocessable('REQUEST_CUSTOMER_MISMATCH', 'That request belongs to a different customer.');
    }
    const branchId = input.branchId ?? request?.branchId ?? defaultBranchId() ?? (await tx.branch.findFirst({ where: { tenantId, isHeadOffice: true } }))?.id;
    const branch = found(branchId ? await tx.branch.findFirst({ where: { id: branchId, tenantId } }) : null, 'Branch');
    if (!branch.isActive) throw Errors.unprocessable('BRANCH_INACTIVE', 'That branch is not active.');
    assertBranchAccess(branch.id);
    const corporateAccountId = input.corporateAccountId ?? request?.corporateAccountId ?? null;
    const corporateAccount = corporateAccountId ? found(await tx.corporateAccount.findFirst({ where: { id: corporateAccountId, tenantId, deletedAt: null } }), 'Corporate account') : null;
    if (request?.corporateAccountId && corporateAccount && request.corporateAccountId !== corporateAccount.id) {
      throw Errors.unprocessable('REQUEST_COMPANY_MISMATCH', 'That request belongs to a different company.');
    }
    return { customer, request, branch, corporateAccount };
  }

  /**
   * Calculates lines and totals. Default tax rate per line:
   *   - line linked to a service: from the service's tax mode;
   *   - free-form line: the centre's rate when the fee component is marked taxable, else 0;
   *   - an explicit taxRatePercent on the line always wins.
   * Discounts are only allowed on service-fee lines: government and third-party
   * fees are collected on behalf of others and cannot be discounted by the centre.
   */
  async calculate(tx: Tx, items: FinanceLineInput[], taxRatePercent: DecimalInput): Promise<CalculatedDocument> {
    const tenantId = this.db.tenantId;
    const serviceIds = [...new Set(items.map((i) => i.serviceId).filter((v): v is string => !!v))];
    const services = serviceIds.length ? await tx.service.findMany({ where: { tenantId, id: { in: serviceIds }, deletedAt: null }, select: { id: true, taxMode: true } }) : [];
    if (services.length !== serviceIds.length) throw Errors.notFound('Service');
    const mode = new Map(services.map((s) => [s.id, s.taxMode]));
    const components = await tx.feeComponent.findMany({ where: { tenantId } });
    const taxable = (c: Component) => components.find((x) => x.type === c)?.taxable ?? c === 'SERVICE_FEE';
    items.forEach((item, i) => {
      if (item.component !== 'SERVICE_FEE' && D(item.discountAmount ?? 0).gt(0)) {
        throw Errors.unprocessable('DISCOUNT_ON_PASS_THROUGH', `Line ${i + 1}: discounts apply to the service fee only. Government and third-party fees are collected on behalf of others.`, { line: i });
      }
    });
    let doc: CalculatedDocument;
    try {
      doc = calculateDocument(items, (l) => (l.serviceId ? defaultTaxRate(mode.get(l.serviceId), l.component, taxRatePercent) : taxable(l.component) ? taxRatePercent : 0));
    } catch (e) {
      if (e instanceof CalculationError) throw Errors.unprocessable(e.code, e.message, { line: e.line });
      throw e;
    }
    if (doc.total.gt(MAX_TOTAL) || doc.lines.some((l) => l.gross.gt(MAX_TOTAL))) throw Errors.unprocessable('AMOUNT_TOO_LARGE', 'The total is larger than the system can record.');
    return doc;
  }

  /** Locks the invoice row until the transaction ends, so concurrent payments / refunds / credits are applied one after another. */
  /**
   * `customerId` list filters: the ids that stand for that customer. A customer whose records were merged
   * has finance documents under several ids (issued invoices and completed payments never move), so a filter
   * on the kept record includes the retired ones, and a filter on a retired id shows the same full set.
   * Ids of another centre resolve to themselves and therefore match nothing.
   */
  async customerFilterIds(tx: Tx, customerId: string): Promise<string[]> {
    // One implementation for every module that filters or groups by customer (finance lists, reports).
    return mergedCustomerIds(tx, this.db.tenantId, customerId);
  }

  async lockInvoice(tx: Tx, id: string) {
    const tenantId = this.db.tenantId;
    await tx.$queryRaw`SELECT "id" FROM "invoices" WHERE "id" = ${id}::uuid AND "tenantId" = ${tenantId}::uuid FOR UPDATE`;
    return tx.invoice.findFirst({ where: { id, tenantId } });
  }
  async lockPayment(tx: Tx, id: string) {
    const tenantId = this.db.tenantId;
    await tx.$queryRaw`SELECT "id" FROM "payments" WHERE "id" = ${id}::uuid AND "tenantId" = ${tenantId}::uuid FOR UPDATE`;
    return tx.payment.findFirst({ where: { id, tenantId } });
  }

  /**
   * Applies a money movement to an issued invoice and re-derives balance and
   * status (ISSUED / PARTIALLY_PAID / PAID / CREDITED). The caller must hold the row lock.
   */
  async applyToInvoice(
    tx: Tx,
    invoice: { id: string; status: string; total: Dec; amountPaid: Dec; amountCredited: Dec; amountRefunded: Dec },
    delta: { paid?: DecimalInput; credited?: DecimalInput; refunded?: DecimalInput },
  ) {
    if (!['ISSUED', 'PARTIALLY_PAID', 'PAID', 'CREDITED'].includes(invoice.status)) {
      throw Errors.conflict('INVOICE_NOT_OPEN', invoice.status === 'DRAFT' ? 'This invoice has not been issued yet.' : 'This invoice is void.');
    }
    const amounts = {
      total: invoice.total,
      amountPaid: D(invoice.amountPaid).plus(D(delta.paid)),
      amountCredited: D(invoice.amountCredited).plus(D(delta.credited)),
      amountRefunded: D(invoice.amountRefunded).plus(D(delta.refunded)),
    };
    let state: ReturnType<typeof invoiceState>;
    try {
      state = invoiceState(amounts);
    } catch (e) {
      if (e instanceof CalculationError) throw Errors.unprocessable(e.code, e.message);
      throw e;
    }
    return tx.invoice.update({
      where: { id: invoice.id },
      data: { amountPaid: amounts.amountPaid, amountCredited: amounts.amountCredited, amountRefunded: amounts.amountRefunded, balanceDue: state.balanceDue, status: state.status, version: { increment: 1 } },
    });
  }

  /** Credit-adjusted component totals and the liability already accrued for one invoice. */
  async ledgerState(tx: Tx, invoiceId: string): Promise<LedgerState> {
    const tenantId = this.db.tenantId;
    const [items, credits, entries] = await Promise.all([
      tx.invoiceItem.findMany({ where: { tenantId, invoiceId }, select: { component: true, lineTotal: true } }),
      tx.creditNote.findMany({ where: { tenantId, invoiceId, status: 'ISSUED' }, select: { breakdown: true } }),
      tx.liabilityEntry.groupBy({ by: ['component', 'direction'], where: { tenantId, invoiceId, sourceType: { in: ['PAYMENT', 'REFUND', 'CREDIT_NOTE'] } }, _sum: { amount: true } }),
    ]);
    const effective = componentTotals(items);
    for (const cn of credits) {
      const b = (cn.breakdown ?? {}) as Record<string, string>;
      for (const c of ['SERVICE_FEE', 'GOVERNMENT_FEE', 'THIRD_PARTY_FEE'] as Component[]) {
        effective[c] = Prisma.Decimal.max(effective[c].minus(D(b[c])), 0);
      }
    }
    const net = (c: Component) =>
      sum(entries.filter((e) => e.component === c && e.direction === 'ACCRUAL').map((e) => e._sum.amount)).minus(
        sum(entries.filter((e) => e.component === c && e.direction === 'REVERSAL').map((e) => e._sum.amount)),
      );
    return { effective, netAccrued: { GOVERNMENT_FEE: net('GOVERNMENT_FEE'), THIRD_PARTY_FEE: net('THIRD_PARTY_FEE') } };
  }

  /** Components the centre treats as money held for others. */
  async passThroughComponents(tx: Tx): Promise<Set<Component>> {
    const rows = await tx.feeComponent.findMany({ where: { tenantId: this.db.tenantId } });
    const out = new Set<Component>();
    for (const c of PASS_THROUGH) {
      const row = rows.find((r) => r.type === c);
      if (!row || row.treatment === 'PASS_THROUGH_LIABILITY') out.add(c);
    }
    return out;
  }

  private async writeLiability(
    tx: Tx,
    invoice: { id: string; branchId: string; requestId: string | null; currency: string },
    component: Component,
    direction: 'ACCRUAL' | 'REVERSAL',
    amount: Dec,
    source: { type: 'PAYMENT' | 'REFUND' | 'CREDIT_NOTE'; id: string },
  ) {
    if (component === 'SERVICE_FEE' || amount.lte(0)) return;
    await tx.liabilityEntry.create({
      data: {
        tenantId: this.db.tenantId,
        branchId: invoice.branchId,
        component,
        direction,
        amount,
        currency: invoice.currency,
        requestId: invoice.requestId,
        invoiceId: invoice.id,
        sourceType: source.type,
        sourceId: source.id,
      },
    });
  }

  /**
   * Liability accrual after money was allocated to an invoice. Brings the net
   * accrued amount of each pass-through component up to its share of the money
   * collected so far (see passThroughTargets for the allocation rule).
   */
  async accrueForInvoice(
    tx: Tx,
    invoice: { id: string; branchId: string; requestId: string | null; currency: string; amountPaid: Dec; amountRefunded: Dec },
    paymentId: string,
  ): Promise<ComponentAmounts> {
    const written = zeroComponents();
    const passThrough = await this.passThroughComponents(tx);
    if (!passThrough.size) return written;
    const ledger = await this.ledgerState(tx, invoice.id);
    const delta = accrualForPayment(D(invoice.amountPaid).minus(D(invoice.amountRefunded)), ledger.effective, ledger.netAccrued);
    for (const component of PASS_THROUGH) {
      if (!passThrough.has(component) || delta[component].lte(0)) continue;
      await this.writeLiability(tx, invoice, component, 'ACCRUAL', delta[component], { type: 'PAYMENT', id: paymentId });
      written[component] = delta[component];
    }
    return written;
  }

  /** Liability reversal for the pass-through parts of a refund (never more than is accrued for the invoice). */
  async reverseForRefund(
    tx: Tx,
    invoice: { id: string; branchId: string; requestId: string | null; currency: string },
    refundId: string,
    parts: Pick<ComponentAmounts, 'GOVERNMENT_FEE' | 'THIRD_PARTY_FEE'>,
  ): Promise<ComponentAmounts> {
    const written = zeroComponents();
    const ledger = await this.ledgerState(tx, invoice.id);
    for (const component of PASS_THROUGH) {
      const amount = Prisma.Decimal.min(D(parts[component]), ledger.netAccrued[component]);
      if (amount.lte(0)) continue;
      await this.writeLiability(tx, invoice, component, 'REVERSAL', amount, { type: 'REFUND', id: refundId });
      written[component] = amount;
    }
    return written;
  }

  /**
   * After a credit note changed what the customer owes per component, brings the
   * accrued liability back in line with the money already collected (either direction).
   */
  async rebalanceAfterCredit(
    tx: Tx,
    invoice: { id: string; branchId: string; requestId: string | null; currency: string; amountPaid: Dec; amountRefunded: Dec },
    creditNoteId: string,
  ): Promise<void> {
    const passThrough = await this.passThroughComponents(tx);
    const ledger = await this.ledgerState(tx, invoice.id);
    const target = passThroughTargets(D(invoice.amountPaid).minus(D(invoice.amountRefunded)), ledger.effective);
    for (const component of PASS_THROUGH) {
      const diff = target[component].minus(ledger.netAccrued[component]);
      if (diff.gt(0) && passThrough.has(component)) await this.writeLiability(tx, invoice, component, 'ACCRUAL', diff, { type: 'CREDIT_NOTE', id: creditNoteId });
      else if (diff.lt(0)) await this.writeLiability(tx, invoice, component, 'REVERSAL', diff.neg(), { type: 'CREDIT_NOTE', id: creditNoteId });
    }
  }
}
