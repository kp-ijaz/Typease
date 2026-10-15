import { Injectable } from '@nestjs/common';
import type { CreateCreditNoteInput, CreditNoteListQuery } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { Prisma, TenantDb, Tx } from '../../common/db/prisma.service';
import { DomainEvents } from '../../common/events.service';
import { Errors, found } from '../../common/errors';
import { D, money, pageArgs, pageResult } from '../../common/pagination';
import { SequenceService } from '../../common/sequence.service';
import { Component, ComponentAmounts, COMPONENTS, fmt, passThroughTargets, splitProportionally } from './finance.calc';
import { customerFacing, dateRange, documentScope, FinanceCore } from './finance.core';

const SORT = ['issuedAt', 'amount', 'creditNoteNo'] as const;
const INCLUDE = { invoice: { select: { id: true, invoiceNo: true, customerId: true, corporateAccountId: true, branchId: true, requestId: true, currency: true } } };
type LockedInvoice = NonNullable<Awaited<ReturnType<FinanceCore['lockInvoice']>>>;

@Injectable()
export class CreditNotesService {
  constructor(
    private readonly db: TenantDb,
    private readonly core: FinanceCore,
    private readonly audit: AuditService,
    private readonly sequences: SequenceService,
    private readonly events: DomainEvents,
  ) {}

  private invoiceScope(): Prisma.InvoiceWhereInput {
    return { AND: [documentScope(), customerFacing() ? { status: { not: 'DRAFT' } } : {}] };
  }
  present<T extends Record<string, any>>(cn: T) {
    if (!customerFacing()) return cn;
    const { issuedById: _i, ...rest } = cn;
    return rest;
  }

  async get(id: string) {
    return this.db.tx(async (tx) => this.present(found(await tx.creditNote.findFirst({ where: { id, tenantId: this.db.tenantId, invoice: this.invoiceScope() }, include: INCLUDE }), 'Credit note')));
  }

  async list(query: CreditNoteListQuery) {
    return this.db.tx(async (tx) => {
      const issued = dateRange(query.from, query.to);
      const where: Prisma.CreditNoteWhereInput = {
        tenantId: this.db.tenantId,
        invoice: this.invoiceScope(),
        AND: [query.invoiceId ? { invoiceId: query.invoiceId } : {}, issued ? { issuedAt: issued } : {}, query.q ? { creditNoteNo: { contains: query.q, mode: 'insensitive' } } : {}],
      };
      const [rows, total] = await Promise.all([tx.creditNote.findMany({ where, ...pageArgs(query, SORT, 'issuedAt:desc'), include: INCLUDE }), tx.creditNote.count({ where })]);
      return pageResult(rows.map((r) => this.present(r)), total, query);
    });
  }

  /**
   * Writes the credit note row and applies it to the (locked) invoice. Used for
   * stand-alone credit notes and for refunds that cancel the charge.
   * `refunded` is the cash refund applied in the same step (0 for a stand-alone note).
   */
  async issueInTx(
    tx: Tx,
    invoice: LockedInvoice,
    input: { amount: Prisma.Decimal; reason: string; breakdown: ComponentAmounts; refunded?: Prisma.Decimal; issuedById: string },
  ) {
    const tenantId = this.db.tenantId;
    // Tax share of the credit, in proportion to the invoice (informational; the breakdown amounts already include tax).
    const taxAmount = D(invoice.total).gt(0) ? Prisma.Decimal.min(money(input.amount.mul(invoice.taxTotal).div(invoice.total)), input.amount) : D(0);
    const note = await tx.creditNote.create({
      data: {
        tenantId,
        creditNoteNo: await this.sequences.next(tx, 'creditnote'),
        invoiceId: invoice.id,
        amount: input.amount,
        taxAmount,
        currency: invoice.currency,
        breakdown: Object.fromEntries(COMPONENTS.map((c) => [c, fmt(input.breakdown[c])])),
        reason: input.reason,
        status: 'ISSUED',
        issuedById: input.issuedById,
      },
    });
    const updated = await this.core.applyToInvoice(tx, invoice, { credited: input.amount, refunded: input.refunded ?? 0 });
    return { note, invoice: updated };
  }

  /**
   * `creditnote.issued`: emitted once the credit note and everything booked with it is written, so
   * in-transaction listeners (the request's payment status) read the final invoice figures.
   */
  async emitIssued(tx: Tx, note: { id: string; creditNoteNo: string; amount: Prisma.Decimal; currency: string }, invoice: { id: string; requestId: string | null; customerId: string }, refundId?: string) {
    await this.events.emit(tx, 'creditnote.issued', {
      creditNoteId: note.id,
      creditNoteNo: note.creditNoteNo,
      invoiceId: invoice.id,
      requestId: invoice.requestId ?? undefined,
      customerId: invoice.customerId,
      amount: fmt(note.amount),
      currency: note.currency,
      ...(refundId ? { refundId } : {}),
    });
  }

  async create(input: CreateCreditNoteInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const visible = await tx.invoice.findFirst({ where: { id: input.invoiceId, tenantId, AND: [documentScope()] }, select: { id: true } });
      const invoice = found(visible ? await this.core.lockInvoice(tx, input.invoiceId) : null, 'Invoice');
      if (invoice.status === 'DRAFT') throw Errors.conflict('INVOICE_NOT_ISSUED', 'This invoice is still a draft: simply edit it.');
      if (invoice.status === 'VOID') throw Errors.conflict('INVOICE_VOID', 'This invoice is void.');
      const amount = D(input.amount);
      if (D(invoice.balanceDue).isZero()) {
        throw Errors.conflict(
          'NOTHING_TO_CREDIT',
          D(invoice.amountPaid).minus(invoice.amountRefunded).gt(0)
            ? 'This invoice is fully paid. To cancel a paid charge, refund the payment and choose "cancel the charge": the credit note is issued with the refund.'
            : 'This invoice has no open balance to credit.',
        );
      }
      if (amount.gt(invoice.balanceDue)) {
        throw Errors.unprocessable(
          'CREDIT_EXCEEDS_BALANCE',
          `Only the open balance (${invoice.currency} ${fmt(invoice.balanceDue)}) can be credited. For amounts already paid, refund the payment and choose "cancel the charge".`,
          { balanceDue: fmt(invoice.balanceDue) },
        );
      }
      const ledger = await this.core.ledgerState(tx, invoice.id);
      let breakdown: ComponentAmounts;
      if (input.breakdown) {
        breakdown = { SERVICE_FEE: D(input.breakdown.SERVICE_FEE), GOVERNMENT_FEE: D(input.breakdown.GOVERNMENT_FEE), THIRD_PARTY_FEE: D(input.breakdown.THIRD_PARTY_FEE) };
        const total = breakdown.SERVICE_FEE.plus(breakdown.GOVERNMENT_FEE).plus(breakdown.THIRD_PARTY_FEE);
        if (!total.equals(amount)) throw Errors.unprocessable('BREAKDOWN_MISMATCH', `The breakdown adds up to ${fmt(total)} but the credit note is ${fmt(amount)}.`);
        for (const c of COMPONENTS) {
          if (breakdown[c].gt(ledger.effective[c])) {
            throw Errors.unprocessable('BREAKDOWN_EXCEEDS_COMPONENT', `Only ${invoice.currency} ${fmt(ledger.effective[c])} of ${label(c)} is left on this invoice.`, { component: c });
          }
        }
      } else {
        // Spread over what is still unpaid per component (remainder on the service fee).
        const covered = passThroughTargets(D(invoice.amountPaid).minus(invoice.amountRefunded), ledger.effective);
        const uncovered = Object.fromEntries(COMPONENTS.map((c) => [c, Prisma.Decimal.max(ledger.effective[c].minus(covered[c]), 0)])) as ComponentAmounts;
        breakdown = splitProportionally(amount, uncovered);
        if (breakdown.SERVICE_FEE.gt(ledger.effective.SERVICE_FEE)) breakdown = splitProportionally(amount, ledger.effective);
      }
      const { note, invoice: updated } = await this.issueInTx(tx, invoice, { amount, reason: input.reason, breakdown, issuedById: ctx().userId! });
      await this.core.rebalanceAfterCredit(tx, updated, note.id);
      await this.audit.log(
        {
          action: 'creditnote.issued',
          resourceType: 'CreditNote',
          resourceId: note.id,
          summary: `${note.creditNoteNo}: ${invoice.currency} ${fmt(amount)} credited on ${invoice.invoiceNo}`,
          before: { balanceDue: fmt(invoice.balanceDue), status: invoice.status },
          after: { amount: fmt(amount), breakdown: note.breakdown, reason: input.reason, balanceDue: fmt(updated.balanceDue), status: updated.status },
        },
        tx,
      );
      await this.emitIssued(tx, note, invoice);
      return { ...this.present(found(await tx.creditNote.findFirst({ where: { id: note.id, tenantId }, include: INCLUDE }), 'Credit note')), invoiceStatus: updated.status, invoiceBalanceDue: updated.balanceDue };
    });
  }
}

const label = (c: Component) => (c === 'SERVICE_FEE' ? 'service fee' : c === 'GOVERNMENT_FEE' ? 'government fee' : 'third-party charge');
