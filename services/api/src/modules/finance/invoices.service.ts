import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { CreateInvoiceInput, InvoiceListQuery, UpdateInvoiceInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { can, ctx } from '../../common/context';
import { Prisma, TenantDb, Tx } from '../../common/db/prisma.service';
import { DomainEvents } from '../../common/events.service';
import { Errors, found } from '../../common/errors';
import { D, pageArgs, pageResult, sum } from '../../common/pagination';
import { ownCorporateAccountId } from '../../common/scope';
import { SequenceService } from '../../common/sequence.service';
import { AgeingBucket, ageingBucket, daysOverdue, fmt, invoiceDueAt, invoiceState, isInvoiceOverdue, overdueInvoiceWhere, totalsFromStoredLines } from './finance.calc';
import { embedCustomerRef, isErasedCustomer } from '../../common/customer-ref';
import { audience, customerFacing, dateRange, documentScope, FinanceCore, toLineData, totalsData, invoiceVisibility } from './finance.core';

const SORT = ['createdAt', 'issuedAt', 'dueAt', 'total', 'balanceDue', 'invoiceNo'] as const;
const OPEN: Array<'ISSUED' | 'PARTIALLY_PAID'> = ['ISSUED', 'PARTIALLY_PAID'];
const INCLUDE = {
  invoiceItems: { orderBy: { sortOrder: 'asc' as const } },
  customer: { select: { id: true, customerNo: true, fullName: true, email: true, phone: true, status: true } },
  corporateAccount: { select: { id: true, accountNo: true, companyName: true } },
  branch: { select: { id: true, code: true, name: true } },
  request: { select: { id: true, requestNo: true } },
  quotation: { select: { id: true, quotationNo: true } },
};

type QuotationForInvoice = {
  id: string;
  branchId: string;
  requestId: string | null;
  customerId: string;
  corporateAccountId: string | null;
  currency: string;
  notes: string | null;
  quotationItems: Array<{
    serviceId: string | null; description: string; component: 'SERVICE_FEE' | 'GOVERNMENT_FEE' | 'THIRD_PARTY_FEE'; quantity: Prisma.Decimal; unitAmount: Prisma.Decimal;
    discountAmount: Prisma.Decimal; taxRatePercent: Prisma.Decimal; taxAmount: Prisma.Decimal; lineTotal: Prisma.Decimal; sortOrder: number;
  }>;
};

@Injectable()
export class InvoicesService {
  constructor(
    private readonly db: TenantDb,
    private readonly core: FinanceCore,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly sequences: SequenceService,
  ) {}

  /** Customers and corporate users never see drafts or internal bookkeeping fields. */
  present<T extends Record<string, any>>(invoice: T) {
    const overdue = isInvoiceOverdue(invoice as unknown as Parameters<typeof isInvoiceOverdue>[0]);
    invoice = embedCustomerRef(invoice); // `customer.erased` instead of the record status
    if (!customerFacing()) return { ...invoice, overdue };
    const { createdById: _c, version: _v, voidReason: _r, ...rest } = invoice;
    return { ...rest, overdue };
  }
  private visibility() {
    return invoiceVisibility();
  }

  private async load(tx: Tx, id: string) {
    return found(await tx.invoice.findFirst({ where: { id, tenantId: this.db.tenantId, AND: [documentScope(), this.visibility()] }, include: INCLUDE }), 'Invoice');
  }

  async get(id: string) {
    return this.db.tx(async (tx) => {
      const invoice = await this.load(tx, id);
      const [allocations, creditNotes] = await Promise.all([
        tx.paymentAllocation.findMany({
          where: { tenantId: this.db.tenantId, invoiceId: id },
          include: { payment: { select: { id: true, paymentNo: true, receiptNo: true, method: true, status: true, receivedAt: true, amount: true, refundedAmount: true } } },
          orderBy: { createdAt: 'asc' },
        }),
        tx.creditNote.findMany({ where: { tenantId: this.db.tenantId, invoiceId: id }, orderBy: { issuedAt: 'asc' }, select: { id: true, creditNoteNo: true, amount: true, reason: true, status: true, issuedAt: true } }),
      ]);
      return { ...this.present(invoice), payments: allocations.map((a) => ({ allocationId: a.id, allocated: a.amount, ...a.payment })), creditNotes };
    });
  }

  async list(query: InvoiceListQuery, extra: Prisma.InvoiceWhereInput = {}) {
    return this.db.tx(async (tx) => {
      const created = dateRange(query.from, query.to);
      // Scope and filters are AND-ed, so a filter can narrow but never widen what the caller may see.
      const where: Prisma.InvoiceWhereInput = {
        tenantId: this.db.tenantId,
        AND: [
          documentScope(),
          this.visibility(),
          extra,
          query.status ? { status: query.status } : {},
          query.customerId ? { customerId: { in: await this.core.customerFilterIds(tx, query.customerId) } } : {},
          query.requestId ? { requestId: query.requestId } : {},
          query.corporateAccountId ? { corporateAccountId: query.corporateAccountId } : {},
          query.branchId ? { branchId: query.branchId } : {},
          created ? { createdAt: created } : {},
          query.overdue ? overdueInvoiceWhere() : {},
          query.q ? { OR: [{ invoiceNo: { contains: query.q, mode: 'insensitive' } }, { customer: { fullName: { contains: query.q, mode: 'insensitive' } } }] } : {},
        ],
      };
      const [rows, total] = await Promise.all([
        tx.invoice.findMany({
          where,
          ...pageArgs(query, SORT, 'createdAt:desc'),
          include: { customer: INCLUDE.customer, corporateAccount: INCLUDE.corporateAccount, branch: INCLUDE.branch, request: INCLUDE.request },
        }),
        tx.invoice.count({ where }),
      ]);
      return pageResult(rows.map((r) => this.present(r)), total, query);
    });
  }

  // ------------------------------------------------------------------ drafts
  async create(input: CreateInvoiceInput) {
    return this.db.tx(async (tx) => {
      const settings = await this.core.settings(tx);
      const parties = await this.core.resolveParties(tx, input);
      const doc = await this.core.calculate(tx, input.items, settings.taxRatePercent);
      const invoice = await tx.invoice.create({
        data: {
          tenantId: this.db.tenantId,
          branchId: parties.branch.id,
          // The real number is taken from the gap-free sequence when the invoice is issued.
          invoiceNo: `DRAFT-${randomBytes(6).toString('hex').toUpperCase()}`,
          requestId: parties.request?.id ?? null,
          customerId: parties.customer.id,
          corporateAccountId: parties.corporateAccount?.id ?? null,
          status: 'DRAFT',
          currency: settings.currency,
          ...totalsData(doc),
          balanceDue: doc.total,
          notes: input.notes ?? null,
          createdById: ctx().userId ?? null,
        },
      });
      await tx.invoiceItem.createMany({ data: toLineData(doc).map((l) => ({ ...l, tenantId: this.db.tenantId, invoiceId: invoice.id })) });
      await this.audit.log({ action: 'invoice.created', resourceType: 'Invoice', resourceId: invoice.id, after: { customerId: invoice.customerId, total: fmt(doc.total), lines: doc.lines.length } }, tx);
      return this.present(await this.load(tx, invoice.id));
    });
  }

  async update(id: string, input: UpdateInvoiceInput) {
    return this.db.tx(async (tx) => {
      const before = await this.load(tx, id);
      if (before.status !== 'DRAFT') {
        throw Errors.conflict('INVOICE_ISSUED', 'An issued invoice cannot be edited. Issue a credit note to correct it, or void it if nothing has been paid.');
      }
      const data: Prisma.InvoiceUpdateInput = { version: { increment: 1 } };
      if (input.notes !== undefined) data.notes = input.notes;
      if (input.items) {
        const settings = await this.core.settings(tx);
        const doc = await this.core.calculate(tx, input.items, settings.taxRatePercent);
        await tx.invoiceItem.deleteMany({ where: { tenantId: this.db.tenantId, invoiceId: id } });
        await tx.invoiceItem.createMany({ data: toLineData(doc).map((l) => ({ ...l, tenantId: this.db.tenantId, invoiceId: id })) });
        Object.assign(data, totalsData(doc), { balanceDue: doc.total });
      }
      await tx.invoice.update({ where: { id }, data });
      const after = await this.load(tx, id);
      await this.audit.log({ action: 'invoice.updated', resourceType: 'Invoice', resourceId: id, before: { total: fmt(before.total), notes: before.notes }, after: { total: fmt(after.total), notes: after.notes } }, tx);
      return this.present(after);
    });
  }

  // ------------------------------------------------------------------ issue
  /**
   * DRAFT -> ISSUED inside the caller's transaction: takes the invoice number,
   * sets the due date, enforces corporate credit and emits the events.
   */
  async issueInTx(tx: Tx, id: string, opts: { viaQuotation?: boolean } = {}) {
    const tenantId = this.db.tenantId;
    const draft = found(await this.core.lockInvoice(tx, id), 'Invoice');
    if (draft.status !== 'DRAFT') throw Errors.conflict('INVOICE_ALREADY_ISSUED', 'This invoice has already been issued.');
    const items = await tx.invoiceItem.findMany({ where: { tenantId, invoiceId: id } });
    if (!items.length) throw Errors.unprocessable('NO_LINES', 'Add at least one line before issuing the invoice.');
    const check = totalsFromStoredLines(items);
    if (!check.total.equals(draft.total)) throw Errors.unprocessable('TOTALS_MISMATCH', 'The invoice totals do not match its lines. Save the lines again before issuing.');

    // Segregation of duties for discounts on directly created invoices (quotation discounts are approved on the quotation).
    if (!opts.viaQuotation && D(draft.discountTotal).gt(0)) {
      if (!can('discount.approve')) {
        throw Errors.forbidden('DISCOUNT_APPROVAL_REQUIRED', 'This invoice contains a discount. Someone who may approve discounts has to issue it.');
      }
      const c = ctx();
      if (c.actorType === 'STAFF' && draft.createdById && draft.createdById === c.userId) {
        const approvers = await this.discountApprovers(tx);
        if (approvers > 1) {
          throw Errors.forbidden('SELF_APPROVAL_FORBIDDEN', 'You created this discounted invoice, so a different person has to issue it.');
        }
        await this.audit.log({ action: 'invoice.discount_self_approved', resourceType: 'Invoice', resourceId: id, after: { selfApproved: true, discountTotal: fmt(draft.discountTotal), reason: 'Only one active member can approve discounts' } }, tx);
      }
    }

    const settings = await this.core.settings(tx);
    const now = new Date();
    let dueDays = settings.invoiceDueDays;
    if (draft.corporateAccountId) {
      // Serialise concurrent invoices of the same company so the credit check cannot be raced.
      await tx.$queryRaw`SELECT "id" FROM "corporate_accounts" WHERE "id" = ${draft.corporateAccountId}::uuid AND "tenantId" = ${tenantId}::uuid FOR UPDATE`;
      const account = found(await tx.corporateAccount.findFirst({ where: { id: draft.corporateAccountId, tenantId } }), 'Corporate account');
      if (account.creditApproved && account.status === 'ACTIVE') {
        dueDays = account.paymentTermsDays;
        if (account.creditLimit !== null) {
          const open = await tx.invoice.aggregate({ _sum: { balanceDue: true }, where: { tenantId, corporateAccountId: account.id, status: { in: OPEN } } });
          const openBalance = D(open._sum.balanceDue);
          if (openBalance.plus(draft.total).gt(account.creditLimit)) {
            throw Errors.unprocessable(
              'CREDIT_LIMIT_EXCEEDED',
              `This invoice would take ${account.companyName} over its approved credit limit of ${draft.currency} ${fmt(account.creditLimit)} (open balance ${draft.currency} ${fmt(openBalance)}). Collect payment for open invoices first, or ask a manager to review the limit.`,
              { creditLimit: fmt(account.creditLimit), openBalance: fmt(openBalance), invoiceTotal: fmt(draft.total) },
            );
          }
        }
      }
      // Without approved credit the company pays like any other customer (the centre's normal due days).
    }
    const invoiceNo = await this.sequences.next(tx, 'invoice');
    const state = invoiceState({ total: draft.total, amountPaid: 0, amountCredited: 0, amountRefunded: 0 });
    const issued = await tx.invoice.update({
      where: { id },
      // Due at the END of the due day on the centre's calendar: "due on receipt" (0 days) is payable all of today.
      data: { invoiceNo, status: state.status, issuedAt: now, dueAt: invoiceDueAt(now, dueDays, settings.tenant.timezone), balanceDue: state.balanceDue, version: { increment: 1 } },
    });
    await this.audit.log({ action: 'invoice.issued', resourceType: 'Invoice', resourceId: id, summary: `${invoiceNo} issued for ${issued.currency} ${fmt(issued.total)}`, after: { invoiceNo, total: fmt(issued.total), dueAt: issued.dueAt, termsDays: dueDays, viaQuotation: !!opts.viaQuotation } }, tx);
    await this.events.emit(tx, 'invoice.issued', { invoiceId: id, requestId: issued.requestId ?? undefined, customerId: issued.customerId, total: fmt(issued.total), currency: issued.currency });
    if (D(issued.total).gt(0)) {
      await this.events.emit(tx, 'payment.requested', { invoiceId: id, requestId: issued.requestId ?? undefined, customerId: issued.customerId, amount: fmt(issued.balanceDue), currency: issued.currency });
    }
    return issued;
  }

  private discountApprovers(tx: Tx) {
    return tx.tenantMembership.count({
      where: { tenantId: this.db.tenantId, kind: 'STAFF', status: 'ACTIVE', role: { rolePermissions: { some: { permissionKey: 'discount.approve' } } } },
    });
  }

  async issue(id: string) {
    return this.db.tx(async (tx) => {
      await this.load(tx, id); // scope check
      await this.issueInTx(tx, id);
      return this.present(await this.load(tx, id));
    });
  }

  /** Called when a quotation is approved: copies its lines and issues the invoice in the same transaction. */
  async createFromQuotation(tx: Tx, quotation: QuotationForInvoice) {
    const tenantId = this.db.tenantId;
    const totals = totalsFromStoredLines(quotation.quotationItems);
    const invoice = await tx.invoice.create({
      data: {
        tenantId,
        branchId: quotation.branchId,
        invoiceNo: `DRAFT-${randomBytes(6).toString('hex').toUpperCase()}`,
        requestId: quotation.requestId,
        quotationId: quotation.id,
        customerId: quotation.customerId,
        corporateAccountId: quotation.corporateAccountId,
        status: 'DRAFT',
        currency: quotation.currency,
        ...totals,
        balanceDue: totals.total,
        notes: quotation.notes,
        createdById: ctx().userId ?? null,
      },
    });
    await tx.invoiceItem.createMany({
      data: quotation.quotationItems.map((l) => ({
        tenantId,
        invoiceId: invoice.id,
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
      })),
    });
    return this.issueInTx(tx, invoice.id, { viaQuotation: true });
  }

  // ------------------------------------------------------------------ void
  async void(id: string, reason: string) {
    return this.db.tx(async (tx) => {
      await this.load(tx, id);
      const invoice = found(await this.core.lockInvoice(tx, id), 'Invoice');
      if (invoice.status === 'VOID') throw Errors.conflict('INVOICE_VOID', 'This invoice is already void.');
      if (D(invoice.amountPaid).gt(0)) {
        throw Errors.conflict('INVOICE_HAS_PAYMENTS', 'Payments have been recorded on this invoice, so it cannot be voided. Refund the payment or issue a credit note instead.');
      }
      if (D(invoice.amountCredited).gt(0)) {
        throw Errors.conflict('INVOICE_HAS_CREDITS', 'A credit note has been issued against this invoice, so it cannot be voided.');
      }
      const voided = await tx.invoice.update({ where: { id }, data: { status: 'VOID', voidedAt: new Date(), voidReason: reason, version: { increment: 1 } } });
      await this.audit.log({ action: 'invoice.voided', resourceType: 'Invoice', resourceId: id, summary: `${invoice.invoiceNo} voided`, before: { status: invoice.status }, after: { status: 'VOID', reason } }, tx);
      // The request's payment status is derived from its invoices: the requests module recomputes it on this event.
      if (invoice.status !== 'DRAFT') {
        await this.events.emit(tx, 'invoice.voided', { invoiceId: id, requestId: invoice.requestId ?? undefined, customerId: invoice.customerId, total: fmt(invoice.total), currency: invoice.currency, reason });
      }
      return this.present(await this.load(tx, voided.id));
    });
  }

  // ------------------------------------------------------------------ corporate statement
  /** Open invoices of one company with ageing buckets by days past due. */
  async statement(corporateAccountId?: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const accountId = audience() === 'CORPORATE' ? ownCorporateAccountId() : corporateAccountId;
      const account = found(accountId ? await tx.corporateAccount.findFirst({ where: { id: accountId, tenantId, deletedAt: null } }) : null, 'Corporate account');
      const scope = documentScope();
      const invoices = await tx.invoice.findMany({
        where: { tenantId, corporateAccountId: account.id, status: { in: OPEN }, ...(scope.branchId ? { branchId: scope.branchId } : {}) },
        orderBy: [{ dueAt: 'asc' }, { issuedAt: 'asc' }],
        select: {
          id: true, invoiceNo: true, issuedAt: true, dueAt: true, total: true, amountPaid: true, amountCredited: true, amountRefunded: true, balanceDue: true, status: true, currency: true, requestId: true,
          customerId: true, customer: { select: { fullName: true, status: true } }, request: { select: { requestNo: true } },
        },
      });
      const now = new Date();
      const buckets: Record<AgeingBucket, Prisma.Decimal> = { current: D(0), days1to30: D(0), days31to60: D(0), days61to90: D(0), days90plus: D(0) };
      const rows = invoices.map(({ customer, request, ...i }) => {
        const bucket = ageingBucket(i.dueAt, now);
        buckets[bucket] = buckets[bucket].plus(i.balanceDue);
        // Whom the invoice is about and which request it settles, in words: a company reads statements by person.
        return { ...i, customerName: customer.fullName, customerErased: isErasedCustomer(customer), requestNo: request?.requestNo ?? null, bucket, daysOverdue: daysOverdue(i.dueAt, now) };
      });
      const openBalance = sum(invoices.map((i) => i.balanceDue));
      const creditActive = account.creditApproved && account.status === 'ACTIVE';
      return {
        asOf: now,
        account: { id: account.id, accountNo: account.accountNo, companyName: account.companyName, paymentTermsDays: account.paymentTermsDays, creditApproved: account.creditApproved, creditLimit: account.creditLimit },
        currency: invoices[0]?.currency ?? (await this.core.settings(tx)).currency,
        openBalance: fmt(openBalance),
        availableCredit: creditActive && account.creditLimit !== null ? fmt(Prisma.Decimal.max(D(account.creditLimit).minus(openBalance), 0)) : null,
        ageing: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, fmt(v)])) as Record<AgeingBucket, string>,
        invoices: rows,
      };
    });
  }
}
