import { Injectable } from '@nestjs/common';
import type { CustomerStatementQuery } from '@typease/validation';
import { isErasedCustomer } from '../../common/customer-ref';
import { Prisma, TenantDb } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { D, sum } from '../../common/pagination';
import { ownCustomerId } from '../../common/scope';
import { localDate } from '../reminders/dates';
import { AgeingBucket, ageingBucket, daysOverdue, fmt, OPEN_INVOICE_STATUSES } from './finance.calc';
import { audience, documentScope, FinanceCore, ownRecords } from './finance.core';

export type StatementEntryType = 'INVOICE' | 'INVOICE_VOID' | 'PAYMENT' | 'CREDIT_NOTE' | 'REFUND';
interface Entry {
  at: Date;
  type: StatementEntryType;
  reference: string;
  description: string;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
}
const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Statement of account of an individual customer: what was charged (invoices) and what was received or given back
 * (payments, credit notes, refunds, voids) in a period, with the opening and closing balance and the ageing of what
 * is still open. Company-billed invoices belong to the company's statement and are left out here.
 */
@Injectable()
export class StatementsService {
  constructor(
    private readonly db: TenantDb,
    private readonly core: FinanceCore,
  ) {}

  async customerStatement(customerId: string | null, query: CustomerStatementQuery) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const id = audience() === 'CUSTOMER' ? ownCustomerId() : customerId;
      if (audience() === 'CORPORATE' || !id) throw Errors.forbidden();
      const customer = found(await tx.customer.findFirst({ where: { id, tenantId } }), 'Customer');
      const tenant = await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { timezone: true } });
      const today = localDate(new Date(), tenant.timezone);
      const to = query.to ?? today;
      const from = query.from ?? `${Number(to.slice(0, 4)) - 1}${to.slice(4, 8)}${to.slice(8)}`;
      if (from > to) throw Errors.unprocessable('INVALID_PERIOD', 'The start of the period must be before its end.');
      const end = new Date(Date.parse(`${to}T00:00:00.000Z`) + 86_400_000);
      const scope = documentScope({ hasRequest: false });
      const own = ownRecords(customer.id);

      const invoices = await tx.invoice.findMany({
        where: { tenantId, corporateAccountId: null, issuedAt: { not: null, lt: end }, AND: [own, scope] },
        select: { id: true, invoiceNo: true, issuedAt: true, voidedAt: true, total: true, status: true, request: { select: { requestNo: true } } },
      });
      const payments = await tx.payment.findMany({
        where: { tenantId, corporateAccountId: null, status: { in: ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'] }, receivedAt: { not: null, lt: end }, AND: [own, scope] },
        select: { id: true, paymentNo: true, receiptNo: true, receivedAt: true, amount: true, method: true },
      });
      const credits = await tx.creditNote.findMany({
        where: { tenantId, status: { not: 'VOID' }, issuedAt: { lt: end }, invoice: { corporateAccountId: null, AND: [own, scope] } },
        select: { creditNoteNo: true, issuedAt: true, amount: true, reason: true, invoice: { select: { invoiceNo: true } } },
      });
      const refunds = await tx.refund.findMany({
        where: { tenantId, status: 'COMPLETED', processedAt: { not: null, lt: end }, payment: { corporateAccountId: null, AND: [own, scope] } },
        select: { refundNo: true, processedAt: true, amount: true, payment: { select: { paymentNo: true } } },
      });

      const entries: Entry[] = [
        ...invoices.map((i) => ({ at: i.issuedAt!, type: 'INVOICE' as const, reference: i.invoiceNo, description: i.request ? `Request ${i.request.requestNo}` : 'Invoice', debit: D(i.total), credit: D(0) })),
        ...invoices.filter((i) => i.status === 'VOID' && i.voidedAt && i.voidedAt < end).map((i) => ({ at: i.voidedAt!, type: 'INVOICE_VOID' as const, reference: i.invoiceNo, description: 'Invoice voided', debit: D(0), credit: D(i.total) })),
        ...payments.map((p) => ({ at: p.receivedAt!, type: 'PAYMENT' as const, reference: p.receiptNo ?? p.paymentNo, description: `Payment (${p.method.replace('_', ' ').toLowerCase()})`, debit: D(0), credit: D(p.amount) })),
        ...credits.map((c) => ({ at: c.issuedAt, type: 'CREDIT_NOTE' as const, reference: c.creditNoteNo, description: `Credit on ${c.invoice.invoiceNo}`, debit: D(0), credit: D(c.amount) })),
        ...refunds.map((r) => ({ at: r.processedAt!, type: 'REFUND' as const, reference: r.refundNo, description: `Refund of ${r.payment.paymentNo}`, debit: D(r.amount), credit: D(0) })),
      ].sort((a, b) => a.at.getTime() - b.at.getTime() || (a.debit.gt(0) ? -1 : 1));

      const start = new Date(`${from}T00:00:00.000Z`);
      const before = entries.filter((e) => e.at < start);
      const opening = sum(before.map((e) => e.debit.minus(e.credit)));
      let running = opening;
      const lines = entries
        .filter((e) => e.at >= start)
        .map((e) => {
          running = running.plus(e.debit).minus(e.credit);
          return { date: day(e.at), type: e.type, reference: e.reference, description: e.description, debit: fmt(e.debit), credit: fmt(e.credit), balance: fmt(running) };
        });
      const inPeriod = entries.filter((e) => e.at >= start);

      const now = new Date();
      const open = await tx.invoice.findMany({
        where: { tenantId, corporateAccountId: null, status: { in: OPEN_INVOICE_STATUSES }, AND: [own, scope] },
        orderBy: { dueAt: 'asc' },
        select: { id: true, invoiceNo: true, issuedAt: true, dueAt: true, total: true, balanceDue: true },
      });
      const buckets: Record<AgeingBucket, Prisma.Decimal> = { current: D(0), days1to30: D(0), days31to60: D(0), days61to90: D(0), days90plus: D(0) };
      for (const i of open) buckets[ageingBucket(i.dueAt, now)] = buckets[ageingBucket(i.dueAt, now)].plus(i.balanceDue);

      return {
        customer: { id: customer.id, customerNo: customer.customerNo, fullName: customer.fullName, fullNameAr: customer.fullNameAr, erased: isErasedCustomer(customer), taxRegistrationNo: customer.taxRegistrationNo },
        from,
        to,
        currency: (await this.core.settings(tx)).currency,
        openingBalance: fmt(opening),
        charged: fmt(sum(inPeriod.map((e) => e.debit))),
        received: fmt(sum(inPeriod.map((e) => e.credit))),
        closingBalance: fmt(running),
        lines,
        openInvoices: open.map((i) => ({ ...i, total: fmt(i.total), balanceDue: fmt(i.balanceDue), bucket: ageingBucket(i.dueAt, now), daysOverdue: daysOverdue(i.dueAt, now) })),
        ageing: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, fmt(v)])) as Record<AgeingBucket, string>,
      };
    });
  }
}
