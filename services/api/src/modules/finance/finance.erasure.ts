import { Injectable, OnModuleInit } from '@nestjs/common';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { ErasureRegistry, ErasureReport, ErasureSubject, identifierPattern, scrubText } from '../../common/erasure';

/**
 * Erasure step of the finance module. Financial records are kept: quotations, invoices, credit
 * notes, payments, refunds and the liability ledger stay exactly as they are - numbers, amounts,
 * dates, statuses - and keep pointing at the customer record, which by now is anonymous (the
 * reference is a pseudonym). Only free text is touched: notes are removed, and the identifiers of
 * the person are taken out of the mandatory reason of a refund or credit note. Totals and reports
 * do not change.
 */
@Injectable()
export class FinanceErasure implements OnModuleInit {
  constructor(
    private readonly db: TenantDb,
    private readonly erasure: ErasureRegistry,
  ) {}

  onModuleInit() {
    this.erasure.register('finance', (tx, subject) => this.erase(tx, subject));
  }

  async erase(tx: Tx, subject: ErasureSubject): Promise<ErasureReport> {
    const tenantId = this.db.tenantId;
    const mine = { tenantId, customerId: { in: subject.customerIds } };
    const pattern = identifierPattern(subject.identifiers);
    await tx.quotation.updateMany({ where: { ...mine, OR: [{ notes: { not: null } }, { discountReason: { not: null } }, { rejectionReason: { not: null } }] }, data: { notes: null, discountReason: null, rejectionReason: null } });
    await tx.invoice.updateMany({ where: { ...mine, notes: { not: null } }, data: { notes: null } });
    await tx.payment.updateMany({ where: { ...mine, notes: { not: null } }, data: { notes: null } });
    const refunds = await tx.refund.findMany({ where: { tenantId, payment: { customerId: { in: subject.customerIds } } }, select: { id: true, reason: true, rejectionReason: true } });
    for (const r of refunds) {
      const reason = scrubText(r.reason, pattern);
      const rejectionReason = scrubText(r.rejectionReason, pattern);
      if (reason !== r.reason || rejectionReason !== r.rejectionReason) await tx.refund.update({ where: { id: r.id }, data: { reason, rejectionReason } });
    }
    const creditNotes = await tx.creditNote.findMany({ where: { tenantId, invoice: { customerId: { in: subject.customerIds } } }, select: { id: true, reason: true } });
    for (const n of creditNotes) {
      const reason = scrubText(n.reason, pattern);
      if (reason !== n.reason) await tx.creditNote.update({ where: { id: n.id }, data: { reason } });
    }
    const [quotations, invoices, payments] = [await tx.quotation.count({ where: mine }), await tx.invoice.count({ where: { ...mine, status: { not: 'DRAFT' } } }), await tx.payment.count({ where: mine })];
    return { retainedQuotations: quotations, retainedInvoices: invoices, retainedPayments: payments, retainedRefunds: refunds.length, retainedCreditNotes: creditNotes.length };
  }
}
