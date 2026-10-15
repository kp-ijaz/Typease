import { Injectable } from '@nestjs/common';
import type { ApproveRefundInput, ComponentBreakdownInput, RefundListQuery, RequestRefundInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { Prisma, TenantDb, Tx } from '../../common/db/prisma.service';
import { DomainEvents } from '../../common/events.service';
import { Errors, found } from '../../common/errors';
import { D, pageArgs, pageResult, sum } from '../../common/pagination';
import { branchFilter } from '../../common/scope';
import { SequenceService } from '../../common/sequence.service';
import { CashierService } from './cashier.service';
import { CreditNotesService } from './credit-notes.service';
import { ComponentAmounts, fmt, splitRefund } from './finance.calc';
import { dateRange, FinanceCore } from './finance.core';
import { GatewayError, RefundResult } from './gateways/payment-gateway';
import { PaymentGateways } from './gateways/payment-gateways';
import { IdempotencyService } from './idempotency.service';

const SORT = ['createdAt', 'amount', 'refundNo', 'processedAt'] as const;
const OPEN_STATES: Array<'REQUESTED' | 'APPROVED' | 'PROCESSING' | 'FAILED'> = ['REQUESTED', 'APPROVED', 'PROCESSING', 'FAILED'];
const INCLUDE = {
  payment: { select: { id: true, paymentNo: true, receiptNo: true, method: true, gateway: true, amount: true, refundedAmount: true, status: true, branchId: true, customerId: true } },
  invoice: { select: { id: true, invoiceNo: true, status: true, balanceDue: true } },
};
type Breakdown = { SERVICE_FEE?: string; GOVERNMENT_FEE?: string; THIRD_PARTY_FEE?: string; TAX?: string; cancelCharge?: boolean; explicit?: boolean };

@Injectable()
export class RefundsService {
  constructor(
    private readonly db: TenantDb,
    private readonly core: FinanceCore,
    private readonly creditNotes: CreditNotesService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly sequences: SequenceService,
    private readonly idempotency: IdempotencyService,
    private readonly gateways: PaymentGateways,
  ) {}

  /** Refunds are staff-only records; staff see those of payments taken in their branches (and, for operators, on their assigned requests). */
  private scope(): Prisma.RefundWhereInput {
    const c = ctx();
    const and: Prisma.RefundWhereInput[] = [];
    const branches = branchFilter(c);
    if (branches) and.push({ payment: { branchId: branches } });
    if (c.actorType === 'STAFF' && c.membershipId && c.permissions.has('request.read.assigned') && !c.permissions.has('request.read.all')) {
      and.push({ OR: [{ requestedById: c.userId ?? '' }, { invoice: { request: { OR: [{ assignedToId: c.membershipId }, { reviewerId: c.membershipId }] } } }] });
    }
    return { AND: and };
  }
  private paymentScope(): Prisma.PaymentWhereInput {
    const c = ctx();
    const and: Prisma.PaymentWhereInput[] = [];
    const branches = branchFilter(c);
    if (branches) and.push({ branchId: branches });
    if (c.actorType === 'STAFF' && c.membershipId && c.permissions.has('request.read.assigned') && !c.permissions.has('request.read.all')) {
      and.push({ paymentAllocations: { some: { invoice: { request: { OR: [{ assignedToId: c.membershipId }, { reviewerId: c.membershipId }] } } } } });
    }
    return { AND: and };
  }
  private async load(tx: Tx, id: string) {
    return found(await tx.refund.findFirst({ where: { id, tenantId: this.db.tenantId, ...this.scope() }, include: INCLUDE }), 'Refund');
  }
  private async lock(tx: Tx, id: string) {
    const tenantId = this.db.tenantId;
    await tx.$queryRaw`SELECT "id" FROM "refunds" WHERE "id" = ${id}::uuid AND "tenantId" = ${tenantId}::uuid FOR UPDATE`;
    return found(await tx.refund.findFirst({ where: { id, tenantId } }), 'Refund');
  }

  get(id: string) {
    return this.db.tx((tx) => this.load(tx, id));
  }

  async list(query: RefundListQuery) {
    return this.db.tx(async (tx) => {
      const created = dateRange(query.from, query.to);
      const where: Prisma.RefundWhereInput = {
        tenantId: this.db.tenantId,
        AND: [
          this.scope(),
          query.status ? { status: query.status } : {},
          query.paymentId ? { paymentId: query.paymentId } : {},
          query.invoiceId ? { invoiceId: query.invoiceId } : {},
          query.requestId ? { requestId: query.requestId } : {},
          created ? { createdAt: created } : {},
          query.q ? { refundNo: { contains: query.q, mode: 'insensitive' } } : {},
        ],
      };
      const [rows, total] = await Promise.all([tx.refund.findMany({ where, ...pageArgs(query, SORT, 'createdAt:desc'), include: INCLUDE }), tx.refund.count({ where })]);
      return pageResult(rows, total, query);
    });
  }

  // ------------------------------------------------------------------ request
  private parseBreakdown(input: ComponentBreakdownInput | undefined, amount: Prisma.Decimal): ComponentAmounts | null {
    if (!input) return null;
    const parts = { SERVICE_FEE: D(input.SERVICE_FEE), GOVERNMENT_FEE: D(input.GOVERNMENT_FEE), THIRD_PARTY_FEE: D(input.THIRD_PARTY_FEE) };
    const tax = D(input.TAX);
    const total = parts.SERVICE_FEE.plus(parts.GOVERNMENT_FEE).plus(parts.THIRD_PARTY_FEE).plus(tax);
    if (!total.equals(amount)) throw Errors.unprocessable('BREAKDOWN_MISMATCH', `The breakdown adds up to ${fmt(total)} but the refund is ${fmt(amount)}.`);
    // Tax is not held for anyone else in the pass-through ledger; it travels with the service-fee part.
    return { ...parts, SERVICE_FEE: parts.SERVICE_FEE.plus(tax) };
  }

  async request(input: RequestRefundInput, idempotencyKey: string | undefined) {
    return this.idempotency.run('refund.request', idempotencyKey, input, async (tx) => {
      const tenantId = this.db.tenantId;
      const visible = await tx.payment.findFirst({ where: { id: input.paymentId, tenantId, ...this.paymentScope() }, select: { id: true } });
      const payment = found(visible ? await this.core.lockPayment(tx, input.paymentId) : null, 'Payment');
      if (!['COMPLETED', 'PARTIALLY_REFUNDED'].includes(payment.status)) {
        throw Errors.conflict('PAYMENT_NOT_REFUNDABLE', payment.status === 'REFUNDED' ? 'This payment has already been refunded in full.' : 'Only a completed payment can be refunded.');
      }
      const amount = D(input.amount);
      const [allocations, others] = await Promise.all([
        tx.paymentAllocation.findMany({ where: { tenantId, paymentId: payment.id } }),
        tx.refund.findMany({ where: { tenantId, paymentId: payment.id, status: { in: [...OPEN_STATES, 'COMPLETED'] } }, select: { amount: true, invoiceId: true, status: true } }),
      ]);
      const pending = sum(others.filter((r) => r.status !== 'COMPLETED').map((r) => r.amount));
      const available = D(payment.amount).minus(payment.refundedAmount).minus(pending);
      if (amount.gt(available)) {
        throw Errors.unprocessable(
          'REFUND_EXCEEDS_PAYMENT',
          `At most ${payment.currency} ${fmt(Prisma.Decimal.max(available, 0))} of this payment can still be refunded${pending.gt(0) ? ` (${payment.currency} ${fmt(pending)} is already waiting in other refund requests)` : ''}.`,
          { available: fmt(Prisma.Decimal.max(available, 0)) },
        );
      }
      const byInvoice = new Map<string, Prisma.Decimal>();
      for (const a of allocations) byInvoice.set(a.invoiceId, (byInvoice.get(a.invoiceId) ?? D(0)).plus(a.amount));
      let invoiceId = input.invoiceId ?? null;
      if (!invoiceId && byInvoice.size === 1) invoiceId = [...byInvoice.keys()][0];
      if (!invoiceId && byInvoice.size > 1) {
        throw Errors.unprocessable('INVOICE_REQUIRED', 'This payment settled several invoices. Choose the invoice the refund relates to.');
      }
      const breakdown = this.parseBreakdown(input.breakdown, amount);
      let requestId: string | null = null;
      if (invoiceId) {
        const allocated = byInvoice.get(invoiceId);
        if (!allocated) throw Errors.unprocessable('NOT_ALLOCATED', 'This payment was not used for that invoice.');
        const taken = sum(others.filter((r) => r.invoiceId === invoiceId).map((r) => r.amount));
        if (amount.gt(allocated.minus(taken))) {
          throw Errors.unprocessable('REFUND_EXCEEDS_ALLOCATION', `Only ${payment.currency} ${fmt(Prisma.Decimal.max(allocated.minus(taken), 0))} of this payment is still refundable for that invoice.`);
        }
        const invoice = found(await tx.invoice.findFirst({ where: { id: invoiceId, tenantId } }), 'Invoice');
        requestId = invoice.requestId;
        if (breakdown) {
          const ledger = await this.core.ledgerState(tx, invoice.id);
          for (const c of ['GOVERNMENT_FEE', 'THIRD_PARTY_FEE'] as const) {
            if (breakdown[c].gt(ledger.netAccrued[c])) {
              throw Errors.unprocessable('BREAKDOWN_EXCEEDS_COLLECTED', `Only ${payment.currency} ${fmt(ledger.netAccrued[c])} was collected as ${c === 'GOVERNMENT_FEE' ? 'government fee' : 'third-party charge'} on this invoice.`, { component: c });
            }
          }
        }
      } else {
        // Money that was never allocated to an invoice (for example an online payment that arrived after the invoice was settled).
        const unallocated = D(payment.amount).minus(sum(allocations.map((a) => a.amount)));
        const taken = sum(others.filter((r) => !r.invoiceId).map((r) => r.amount));
        if (amount.gt(unallocated.minus(taken))) throw Errors.unprocessable('REFUND_EXCEEDS_ALLOCATION', 'That amount is larger than the unallocated part of this payment.');
        if (input.cancelCharge) throw Errors.unprocessable('NO_CHARGE_TO_CANCEL', 'This refund is not linked to an invoice, so there is no charge to cancel.');
        if (breakdown) throw Errors.unprocessable('BREAKDOWN_NOT_APPLICABLE', 'A component breakdown needs an invoice.');
      }
      const stored: Breakdown = {
        ...(breakdown && input.breakdown ? Object.fromEntries(Object.entries(input.breakdown).filter(([, v]) => v !== undefined).map(([k, v]) => [k, fmt(v)])) : {}),
        cancelCharge: input.cancelCharge,
        explicit: !!breakdown,
      };
      const refund = await tx.refund.create({
        data: {
          tenantId,
          refundNo: await this.sequences.next(tx, 'refund'),
          paymentId: payment.id,
          invoiceId,
          requestId,
          amount,
          currency: payment.currency,
          breakdown: stored as Prisma.InputJsonValue,
          reason: input.reason,
          status: 'REQUESTED',
          method: payment.method === 'ONLINE_GATEWAY' ? 'GATEWAY' : payment.method,
          requestedById: ctx().userId!,
        },
      });
      await this.audit.log(
        {
          action: 'refund.requested',
          resourceType: 'Refund',
          resourceId: refund.id,
          summary: `${refund.refundNo}: refund of ${refund.currency} ${fmt(amount)} requested on ${payment.paymentNo}`,
          after: { amount: fmt(amount), paymentNo: payment.paymentNo, invoiceId, reason: input.reason, cancelCharge: input.cancelCharge, breakdown: input.breakdown ?? null },
        },
        tx,
      );
      await this.events.emit(tx, 'refund.requested', { refundId: refund.id, paymentId: payment.id, requestId: requestId ?? undefined, amount: fmt(amount), currency: refund.currency });
      return this.load(tx, refund.id);
    });
  }

  // ------------------------------------------------------------------ decision (segregation of duties)
  /** The person who asked for a refund can never approve, process or complete it. No exceptions. */
  private assertNotRequester(refund: { requestedById: string }) {
    if (refund.requestedById === ctx().userId) {
      throw Errors.forbidden('SELF_APPROVAL_FORBIDDEN', 'You requested this refund, so a different person has to approve and pay it out.');
    }
  }

  async approve(id: string, input: ApproveRefundInput) {
    const approved = await this.db.tx(async (tx) => {
      await this.load(tx, id);
      const refund = await this.lock(tx, id);
      if (refund.status !== 'REQUESTED') throw Errors.conflict('REFUND_NOT_PENDING', `This refund is already ${refund.status.toLowerCase()}.`);
      this.assertNotRequester(refund);
      const breakdown = { ...((refund.breakdown ?? {}) as Breakdown) };
      if (input.cancelCharge !== undefined) {
        if (input.cancelCharge && !refund.invoiceId) throw Errors.unprocessable('NO_CHARGE_TO_CANCEL', 'This refund is not linked to an invoice, so there is no charge to cancel.');
        breakdown.cancelCharge = input.cancelCharge;
      }
      const changed = await tx.refund.updateMany({
        where: { id, tenantId: this.db.tenantId, status: 'REQUESTED' },
        data: { status: 'APPROVED', decidedById: ctx().userId ?? null, decidedAt: new Date(), breakdown: breakdown as Prisma.InputJsonValue },
      });
      if (!changed.count) throw Errors.conflict('REFUND_NOT_PENDING', 'This refund was just decided by someone else.');
      await this.audit.log(
        { action: 'refund.approved', resourceType: 'Refund', resourceId: id, summary: `${refund.refundNo} approved`, after: { amount: fmt(refund.amount), requestedById: refund.requestedById, approvedById: ctx().userId, cancelCharge: !!breakdown.cancelCharge } },
        tx,
      );
      return this.load(tx, id);
    });
    if (approved.payment.method === 'ONLINE_GATEWAY') return this.process(id);
    if (input.reference) return this.complete(id, input.reference);
    return approved;
  }

  async reject(id: string, reason: string) {
    return this.db.tx(async (tx) => {
      await this.load(tx, id);
      const refund = await this.lock(tx, id);
      if (refund.status !== 'REQUESTED') throw Errors.conflict('REFUND_NOT_PENDING', `This refund is already ${refund.status.toLowerCase()}.`);
      await tx.refund.update({ where: { id }, data: { status: 'REJECTED', decidedById: ctx().userId ?? null, decidedAt: new Date(), rejectionReason: reason } });
      await this.audit.log({ action: 'refund.rejected', resourceType: 'Refund', resourceId: id, summary: `${refund.refundNo} rejected`, after: { reason, requestedById: refund.requestedById, rejectedById: ctx().userId } }, tx);
      return this.load(tx, id);
    });
  }

  /** Manual methods: the approver hands the money back and records how (cash voucher, transfer reference). */
  async complete(id: string, reference: string) {
    return this.db.tx(async (tx) => {
      await this.load(tx, id);
      const refund = await this.lock(tx, id);
      this.assertNotRequester(refund);
      if (!['APPROVED', 'FAILED'].includes(refund.status)) {
        throw Errors.conflict('REFUND_NOT_APPROVED', refund.status === 'REQUESTED' ? 'This refund has to be approved first.' : `This refund is already ${refund.status.toLowerCase()}.`);
      }
      await this.finalise(tx, id, { reference });
      return this.load(tx, id);
    });
  }

  /** Gateway payments: sends (or re-checks) the refund at the gateway, then completes it. Safe to call again after a failure. */
  async process(id: string) {
    const prepared = await this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      await this.load(tx, id);
      const refund = await this.lock(tx, id);
      this.assertNotRequester(refund);
      if (!['APPROVED', 'FAILED', 'PROCESSING'].includes(refund.status)) {
        throw Errors.conflict('REFUND_NOT_APPROVED', refund.status === 'REQUESTED' ? 'This refund has to be approved first.' : `This refund is already ${refund.status.toLowerCase()}.`);
      }
      const payment = found(await tx.payment.findFirst({ where: { id: refund.paymentId, tenantId } }), 'Payment');
      if (payment.method !== 'ONLINE_GATEWAY' || !payment.gateway) {
        throw Errors.unprocessable('MANUAL_REFUND', 'This payment was not taken online. Hand the money back and complete the refund with a reference.');
      }
      if (!payment.gatewayPaymentRef) throw Errors.unprocessable('NO_GATEWAY_REFERENCE', 'The gateway reference of this payment is missing, so it cannot be refunded automatically. Refund it in the gateway dashboard and complete it with the reference.');
      const gateway = await this.gateways.forTenantByName(payment.gateway, tx);
      if (!gateway) {
        throw Errors.notConfigured(`The ${payment.gateway} payment gateway`, 'Reconnect it in Settings > Integrations, or refund in the gateway dashboard and complete this refund with the reference.');
      }
      await tx.refund.update({ where: { id }, data: { status: 'PROCESSING' } });
      return { refund, payment, gateway };
    });
    const { refund, payment, gateway } = prepared;
    let result: RefundResult;
    try {
      // Outside the transaction; the refund id is the gateway idempotency key, so a retry can never pay out twice.
      result =
        refund.status === 'PROCESSING' && refund.gatewayRefundRef
          ? await gateway.getRefund(refund.gatewayRefundRef)
          : await gateway.refund({ reference: refund.id, paymentRef: payment.gatewayPaymentRef!, amount: fmt(refund.amount), currency: refund.currency, reason: refund.reason });
    } catch (e: any) {
      result = { refundRef: refund.gatewayRefundRef ?? '', status: 'FAILED', failureReason: e instanceof GatewayError ? e.message : 'The payment gateway could not be reached.' };
    }
    return this.db.tx(async (tx) => {
      await this.lock(tx, id);
      if (result.status === 'COMPLETED') {
        await this.finalise(tx, id, { gatewayRefundRef: result.refundRef });
      } else if (result.status === 'PENDING') {
        await tx.refund.update({ where: { id }, data: { status: 'PROCESSING', gatewayRefundRef: result.refundRef } });
        await this.audit.log({ action: 'refund.processing', resourceType: 'Refund', resourceId: id, after: { gateway: gateway.name, gatewayRefundRef: result.refundRef } }, tx);
      } else {
        // No money moved. The refund can be retried or completed manually.
        await tx.refund.update({ where: { id }, data: { status: 'FAILED', rejectionReason: (result.failureReason ?? 'The gateway declined the refund.').slice(0, 500), ...(result.refundRef ? { gatewayRefundRef: result.refundRef } : {}) } });
        await this.audit.log({ action: 'refund.failed', resourceType: 'Refund', resourceId: id, summary: `${refund.refundNo} failed at ${gateway.name}`, after: { reason: result.failureReason ?? null } }, tx);
      }
      return this.load(tx, id);
    });
  }

  // ------------------------------------------------------------------ completion (one transaction)
  /**
   * Books a paid-out refund: refund COMPLETED, payment refundedAmount + status,
   * invoice amountRefunded (+ a credit note when the charge is cancelled),
   * liability reversals for the pass-through parts and the refund.completed event.
   */
  private async finalise(tx: Tx, id: string, how: { reference?: string; gatewayRefundRef?: string }) {
    const tenantId = this.db.tenantId;
    const refund = await this.lock(tx, id);
    // Cash handed back over the counter comes out of the open till of the person paying it out.
    const shift = refund.method === 'CASH' ? await CashierService.openShiftOf(tx, tenantId, ctx().userId) : null;
    const changed = await tx.refund.updateMany({
      where: { id, tenantId, status: { in: ['APPROVED', 'PROCESSING', 'FAILED'] } },
      // gatewayRefundRef holds the gateway's refund id, or for manual pay-outs the reference the approver recorded.
      data: { status: 'COMPLETED', processedAt: new Date(), rejectionReason: null, gatewayRefundRef: how.gatewayRefundRef ?? how.reference ?? refund.gatewayRefundRef, shiftId: shift?.id ?? null },
    });
    if (changed.count !== 1) throw Errors.conflict('REFUND_STATE_CHANGED', 'This refund was changed by someone else. Reload and try again.');

    const payment = found(await this.core.lockPayment(tx, refund.paymentId), 'Payment');
    const refundedAmount = D(payment.refundedAmount).plus(refund.amount);
    if (refundedAmount.gt(payment.amount)) throw Errors.unprocessable('REFUND_EXCEEDS_PAYMENT', 'This refund is larger than what is left of the payment.');
    await tx.payment.update({ where: { id: payment.id }, data: { refundedAmount, status: refundedAmount.equals(payment.amount) ? 'REFUNDED' : 'PARTIALLY_REFUNDED' } });

    const stored = (refund.breakdown ?? {}) as Breakdown;
    const cancelCharge = !!stored.cancelCharge && !!refund.invoiceId;
    let split: ComponentAmounts = { SERVICE_FEE: D(refund.amount), GOVERNMENT_FEE: D(0), THIRD_PARTY_FEE: D(0) };
    let creditNoteNo: string | null = null;
    let issuedCredit: { note: { id: string; creditNoteNo: string; amount: Prisma.Decimal; currency: string }; invoice: { id: string; requestId: string | null; customerId: string } } | null = null;
    let invoiceAfter: { status: string; balanceDue: Prisma.Decimal } | null = null;
    if (refund.invoiceId) {
      const invoice = found(await this.core.lockInvoice(tx, refund.invoiceId), 'Invoice');
      const ledger = await this.core.ledgerState(tx, invoice.id);
      if (stored.explicit) {
        // Clamp to what is really accrued: the money has left already, so completion must never fail on bookkeeping.
        const government = Prisma.Decimal.min(D(stored.GOVERNMENT_FEE), ledger.netAccrued.GOVERNMENT_FEE);
        const thirdParty = Prisma.Decimal.min(D(stored.THIRD_PARTY_FEE), ledger.netAccrued.THIRD_PARTY_FEE);
        split = { GOVERNMENT_FEE: government, THIRD_PARTY_FEE: thirdParty, SERVICE_FEE: D(refund.amount).minus(government).minus(thirdParty) };
      } else {
        split = splitRefund(refund.amount, D(invoice.amountPaid).minus(invoice.amountRefunded), ledger.effective, ledger.netAccrued);
      }
      if (cancelCharge) {
        const credit = await this.creditNotes.issueInTx(tx, invoice, {
          amount: D(refund.amount),
          reason: `Refund ${refund.refundNo}: ${refund.reason}`.slice(0, 500),
          breakdown: split,
          refunded: D(refund.amount),
          issuedById: ctx().userId ?? refund.decidedById ?? refund.requestedById,
        });
        creditNoteNo = credit.note.creditNoteNo;
        issuedCredit = { note: credit.note, invoice };
        invoiceAfter = credit.invoice;
      } else {
        invoiceAfter = await this.core.applyToInvoice(tx, invoice, { refunded: refund.amount });
      }
      await this.core.reverseForRefund(tx, invoice, refund.id, split);
    }
    const finalBreakdown: Breakdown = { SERVICE_FEE: fmt(split.SERVICE_FEE), GOVERNMENT_FEE: fmt(split.GOVERNMENT_FEE), THIRD_PARTY_FEE: fmt(split.THIRD_PARTY_FEE), ...(stored.TAX ? { TAX: stored.TAX } : {}), cancelCharge, explicit: !!stored.explicit };
    await tx.refund.update({ where: { id }, data: { breakdown: finalBreakdown as Prisma.InputJsonValue } });
    await this.audit.log(
      {
        action: 'refund.completed',
        resourceType: 'Refund',
        resourceId: id,
        summary: `${refund.refundNo}: ${refund.currency} ${fmt(refund.amount)} refunded on ${payment.paymentNo}`,
        after: {
          amount: fmt(refund.amount),
          paidOutBy: ctx().userId ?? null,
          requestedById: refund.requestedById,
          reference: how.reference ?? how.gatewayRefundRef ?? null,
          manual: !!how.reference,
          split: { serviceFee: fmt(split.SERVICE_FEE), governmentFee: fmt(split.GOVERNMENT_FEE), thirdPartyFee: fmt(split.THIRD_PARTY_FEE) },
          cancelCharge,
          creditNoteNo,
          paymentStatus: refundedAmount.equals(payment.amount) ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
          invoiceStatus: invoiceAfter?.status ?? null,
          invoiceBalanceDue: invoiceAfter ? fmt(invoiceAfter.balanceDue) : null,
        },
      },
      tx,
    );
    if (issuedCredit) await this.creditNotes.emitIssued(tx, issuedCredit.note, issuedCredit.invoice, id);
    await this.events.emit(tx, 'refund.completed', {
      refundId: id,
      paymentId: payment.id,
      invoiceId: refund.invoiceId ?? undefined,
      requestId: refund.requestId ?? undefined,
      amount: fmt(refund.amount),
      currency: refund.currency,
    });
  }
}
