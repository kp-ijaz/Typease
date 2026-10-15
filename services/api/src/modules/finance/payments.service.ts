import { Injectable, OnModuleInit } from '@nestjs/common';
import type { PayInvoiceInput, PaymentListQuery, RecordPaymentInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { Prisma, TenantDb, Tx } from '../../common/db/prisma.service';
import { DomainEvents } from '../../common/events.service';
import { AppError, Errors, found } from '../../common/errors';
import { JobQueue } from '../../common/jobs/job-queue';
import { D, pageArgs, pageResult, sum } from '../../common/pagination';
import { assertBranchAccess } from '../../common/scope';
import { SequenceService } from '../../common/sequence.service';
import { TenantDirectory } from '../../common/tenant-directory';
import { TenantResolver } from '../tenancy/tenant-resolver.service';
import { CashierService } from './cashier.service';
import { fmt } from './finance.calc';
import { assertCustomerNotErased, embedCustomerRef } from '../../common/customer-ref';
import { audience, customerFacing, dateRange, documentScope, FinanceCore, invoiceVisibility } from './finance.core';
import { GatewayError, GatewayEvent } from './gateways/payment-gateway';
import { PaymentGateways } from './gateways/payment-gateways';
import { IdempotencyService } from './idempotency.service';

const SORT = ['createdAt', 'receivedAt', 'amount', 'paymentNo'] as const;
export const SETTLED: Array<'COMPLETED' | 'PARTIALLY_REFUNDED' | 'REFUNDED'> = ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'];
const PAYABLE = ['ISSUED', 'PARTIALLY_PAID'];
const INCLUDE = {
  customer: { select: { id: true, customerNo: true, fullName: true, status: true } },
  branch: { select: { id: true, code: true, name: true } },
  paymentAllocations: { include: { invoice: { select: { id: true, invoiceNo: true, requestId: true, status: true, balanceDue: true } } }, orderBy: { createdAt: 'asc' as const } },
};

/** Lifetime of a hosted checkout session at the payment provider. After it, an attempt that was never completed is closed. */
export const ONLINE_CHECKOUT_LIFETIME_MINUTES = 60;
export const EXPIRE_CHECKOUTS_JOB = 'finance.expire_checkouts';
/** `failureReason` of an attempt closed by the expiry job. A late success from the provider may still complete such a payment. */
export const CHECKOUT_EXPIRED_REASON = 'EXPIRED';

type LockedInvoice = NonNullable<Awaited<ReturnType<FinanceCore['lockInvoice']>>>;
export type OnlineOutcome = { outcome: 'COMPLETED' | 'FAILED' | 'IGNORED' | 'REJECTED'; reason?: string; paymentId: string };

@Injectable()
export class PaymentsService implements OnModuleInit {
  constructor(
    private readonly db: TenantDb,
    private readonly core: FinanceCore,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly sequences: SequenceService,
    private readonly idempotency: IdempotencyService,
    private readonly gateways: PaymentGateways,
    private readonly resolver: TenantResolver,
    private readonly jobs: JobQueue,
    private readonly directory: TenantDirectory,
  ) {}

  onModuleInit() {
    this.jobs.register(EXPIRE_CHECKOUTS_JOB, async () => void (await this.directory.forEachTenant(EXPIRE_CHECKOUTS_JOB, async () => void (await this.expireCheckouts()))), { attempts: 1 });
    this.jobs.schedule({ name: EXPIRE_CHECKOUTS_JOB, everySeconds: 300, description: `Close online payment attempts that were not completed within ${ONLINE_CHECKOUT_LIFETIME_MINUTES} minutes` });
  }

  /**
   * Online payment attempts whose checkout page was opened but never finished would stay PENDING for ever.
   * Once the provider's session lifetime has passed they are closed as CANCELLED with the reason EXPIRED.
   * Nothing else changes (no money was recorded for a PENDING payment), nobody is notified, and a success
   * webhook that arrives later still completes the payment (see completeOnline). Runs per tenant; idempotent.
   */
  async expireCheckouts(now: Date = new Date()): Promise<{ expired: number }> {
    const tenantId = this.db.tenantId;
    const cutoff = new Date(now.getTime() - ONLINE_CHECKOUT_LIFETIME_MINUTES * 60_000);
    return this.db.tx(async (tx) => {
      const stale = await tx.payment.findMany({ where: { tenantId, method: 'ONLINE_GATEWAY', status: 'PENDING', createdAt: { lte: cutoff } }, select: { id: true, paymentNo: true, reference: true, createdAt: true }, orderBy: { createdAt: 'asc' }, take: 500 });
      let expired = 0;
      for (const p of stale) {
        // Conditional: a webhook that completed or failed the payment a moment ago wins.
        const changed = await tx.payment.updateMany({ where: { id: p.id, tenantId, status: 'PENDING' }, data: { status: 'CANCELLED', failureReason: CHECKOUT_EXPIRED_REASON } });
        if (changed.count !== 1) continue;
        expired += 1;
        await this.audit.log(
          { action: 'payment.checkout_expired', resourceType: 'Payment', resourceId: p.id, summary: `${p.paymentNo}: the online payment${p.reference ? ` for ${p.reference}` : ''} was not completed within ${ONLINE_CHECKOUT_LIFETIME_MINUTES} minutes`, before: { status: 'PENDING' }, after: { status: 'CANCELLED', reason: CHECKOUT_EXPIRED_REASON, startedAt: p.createdAt } },
          tx,
        );
      }
      return { expired };
    });
  }

  /** Gateway session references and idempotency keys are internal and never returned. */
  present<T extends Record<string, any>>(p: T) {
    const { gatewaySessionRef: _s, idempotencyKey: _i, ...rest } = embedCustomerRef(p); // `customer.erased` instead of the record status
    const allocated = sum(((p.paymentAllocations ?? []) as Array<{ amount: Prisma.Decimal }>).map((a) => a.amount));
    const base = { ...rest, ...(p.paymentAllocations ? { unallocatedAmount: fmt(SETTLED.includes(p.status) ? D(p.amount).minus(allocated) : 0) } : {}) };
    if (!customerFacing()) return base;
    const { receivedById: _r, reconciliationId: _c, reconciledAt: _a, notes: _n, ...publicView } = base as Record<string, any>;
    return publicView;
  }
  private scope(): Prisma.PaymentWhereInput {
    return documentScope({ hasRequest: false });
  }
  private async load(tx: Tx, id: string) {
    return found(await tx.payment.findFirst({ where: { id, tenantId: this.db.tenantId, AND: [this.scope()] }, include: INCLUDE }), 'Payment');
  }

  async get(id: string) {
    return this.db.tx(async (tx) => {
      const payment = await this.load(tx, id);
      const refunds = await tx.refund.findMany({
        where: { tenantId: this.db.tenantId, paymentId: id },
        orderBy: { createdAt: 'asc' },
        select: { id: true, refundNo: true, amount: true, status: true, reason: true, invoiceId: true, processedAt: true, createdAt: true },
      });
      return { ...this.present(payment), refunds };
    });
  }

  async list(query: PaymentListQuery) {
    return this.db.tx(async (tx) => {
      const received = dateRange(query.from, query.to);
      const where: Prisma.PaymentWhereInput = {
        tenantId: this.db.tenantId,
        AND: [
          this.scope(),
          query.status ? { status: query.status } : {},
          query.method ? { method: query.method } : {},
          query.customerId ? { customerId: { in: await this.core.customerFilterIds(tx, query.customerId) } } : {},
          query.corporateAccountId ? { corporateAccountId: query.corporateAccountId } : {},
          query.branchId ? { branchId: query.branchId } : {},
          query.invoiceId ? { paymentAllocations: { some: { invoiceId: query.invoiceId } } } : {},
          query.requestId ? { paymentAllocations: { some: { invoice: { requestId: query.requestId } } } } : {},
          received ? { OR: [{ receivedAt: received }, { receivedAt: null, createdAt: received }] } : {},
          query.reconciled === undefined || customerFacing() ? {} : query.reconciled ? { reconciliationId: { not: null } } : { reconciliationId: null },
          query.q ? { OR: [{ paymentNo: { contains: query.q, mode: 'insensitive' } }, { receiptNo: { contains: query.q, mode: 'insensitive' } }, { reference: { contains: query.q, mode: 'insensitive' } }] } : {},
        ],
      };
      const [rows, total] = await Promise.all([tx.payment.findMany({ where, ...pageArgs(query, SORT, 'createdAt:desc'), include: INCLUDE }), tx.payment.count({ where })]);
      return pageResult(rows.map((r) => this.present(r)), total, query);
    });
  }

  // ------------------------------------------------------------------ shared settlement
  /**
   * Allocates a COMPLETED payment to locked invoices: allocation rows, invoice
   * amounts + status, pass-through liability accrual, audit and the
   * payment.completed event - all in the caller's transaction.
   */
  private async settle(
    tx: Tx,
    payment: { id: string; paymentNo: string; receiptNo: string | null; amount: Prisma.Decimal; currency: string; method: string; customerId: string | null; gateway: string | null },
    allocations: Array<{ invoice: LockedInvoice; amount: Prisma.Decimal }>,
    action: 'payment.recorded' | 'payment.completed_online',
  ) {
    const tenantId = this.db.tenantId;
    const liability: Array<{ invoiceNo: string; governmentFee: string; thirdPartyFee: string }> = [];
    for (const a of allocations) {
      await tx.paymentAllocation.create({ data: { tenantId, paymentId: payment.id, invoiceId: a.invoice.id, amount: a.amount } });
      const updated = await this.core.applyToInvoice(tx, a.invoice, { paid: a.amount });
      const accrued = await this.core.accrueForInvoice(tx, updated, payment.id);
      liability.push({ invoiceNo: a.invoice.invoiceNo, governmentFee: fmt(accrued.GOVERNMENT_FEE), thirdPartyFee: fmt(accrued.THIRD_PARTY_FEE) });
    }
    const allocated = sum(allocations.map((a) => a.amount));
    await this.audit.log(
      {
        action,
        resourceType: 'Payment',
        resourceId: payment.id,
        summary: `${payment.paymentNo}: ${payment.currency} ${fmt(payment.amount)} by ${payment.method}${payment.gateway ? ` (${payment.gateway})` : ''}`,
        after: {
          paymentNo: payment.paymentNo,
          receiptNo: payment.receiptNo,
          amount: fmt(payment.amount),
          method: payment.method,
          allocations: allocations.map((a) => ({ invoiceNo: a.invoice.invoiceNo, amount: fmt(a.amount) })),
          unallocated: fmt(D(payment.amount).minus(allocated)),
          liabilityAccrued: liability,
        },
      },
      tx,
    );
    await this.events.emit(tx, 'payment.completed', {
      paymentId: payment.id,
      customerId: payment.customerId ?? undefined,
      amount: fmt(payment.amount),
      currency: payment.currency,
      method: payment.method,
      invoiceIds: allocations.map((a) => a.invoice.id),
      requestIds: [...new Set(allocations.map((a) => a.invoice.requestId).filter((v): v is string => !!v))],
    });
  }

  // ------------------------------------------------------------------ manual payments
  /** Cash / card machine / bank transfer / cheque taken by staff: completed immediately. */
  async record(input: RecordPaymentInput, idempotencyKey: string | undefined) {
    return this.idempotency.run('payment.record', idempotencyKey, input, async (tx) => {
      const tenantId = this.db.tenantId;
      const branch = found(await tx.branch.findFirst({ where: { id: input.branchId, tenantId } }), 'Branch');
      assertBranchAccess(branch.id);
      const amount = D(input.amount);
      const allocated = sum(input.allocations.map((a) => a.amount));
      if (!allocated.equals(amount)) {
        throw Errors.unprocessable('ALLOCATION_MISMATCH', `The allocations add up to ${fmt(allocated)} but the payment is ${fmt(amount)}. They must be equal.`);
      }
      const ids = input.allocations.map((a) => a.invoiceId);
      if (new Set(ids).size !== ids.length) throw Errors.unprocessable('DUPLICATE_INVOICE', 'Each invoice can appear only once in a payment.');
      const receivedAt = input.receivedAt ? new Date(input.receivedAt) : new Date();
      if (receivedAt.getTime() > Date.now() + 5 * 60_000) throw Errors.unprocessable('RECEIVED_IN_FUTURE', 'The payment date cannot be in the future.');

      // Lock the invoices in a stable order so two simultaneous payments can never deadlock or both pass the balance check.
      const locked: Array<{ invoice: LockedInvoice; amount: Prisma.Decimal }> = [];
      for (const a of [...input.allocations].sort((x, y) => x.invoiceId.localeCompare(y.invoiceId))) {
        const visible = await tx.invoice.findFirst({ where: { id: a.invoiceId, tenantId, AND: [documentScope()] }, select: { id: true } });
        const invoice = found(visible ? await this.core.lockInvoice(tx, a.invoiceId) : null, 'Invoice');
        if (!PAYABLE.includes(invoice.status)) {
          throw Errors.conflict('INVOICE_NOT_PAYABLE', `Invoice ${invoice.invoiceNo} is ${invoice.status.toLowerCase().replace('_', ' ')} and cannot take a payment.`);
        }
        if (D(a.amount).gt(invoice.balanceDue)) {
          throw Errors.unprocessable('OVERPAYMENT', `Invoice ${invoice.invoiceNo} has a balance of ${invoice.currency} ${fmt(invoice.balanceDue)}; ${fmt(a.amount)} is too much.`, { invoiceId: invoice.id, balanceDue: fmt(invoice.balanceDue) });
        }
        locked.push({ invoice, amount: D(a.amount) });
      }
      const currencies = new Set(locked.map((l) => l.invoice.currency));
      if (currencies.size > 1) throw Errors.unprocessable('MIXED_CURRENCIES', 'One payment cannot settle invoices in different currencies.');
      const customerIds = new Set(locked.map((l) => l.invoice.customerId));
      const corporateIds = new Set(locked.map((l) => l.invoice.corporateAccountId));
      let customerId: string | null = customerIds.size === 1 ? [...customerIds][0] : null;
      await assertCustomerNotErased(tx, tenantId, input.customerId);
      if (input.customerId) customerId = found(await tx.customer.findFirst({ where: { id: input.customerId, tenantId, deletedAt: null }, select: { id: true } }), 'Customer').id;

      // Counter money belongs to the cashier's open shift at this branch (see CashierService).
      const shift = await CashierService.openShiftOf(tx, tenantId, ctx().userId, branch.id);
      if (!shift && input.method === 'CASH' && (await CashierService.requiresShift(tx, tenantId))) {
        throw Errors.conflict('SHIFT_REQUIRED', 'Open your cash register shift at this branch before taking cash.');
      }
      const payment = await tx.payment.create({
        data: {
          tenantId,
          branchId: branch.id,
          shiftId: shift?.id ?? null,
          paymentNo: await this.sequences.next(tx, 'payment'),
          receiptNo: await this.sequences.next(tx, 'receipt'),
          customerId,
          corporateAccountId: corporateIds.size === 1 ? [...corporateIds][0] : null,
          method: input.method,
          status: 'COMPLETED',
          amount,
          currency: [...currencies][0],
          reference: input.reference ?? null,
          notes: input.notes ?? null,
          idempotencyKey: idempotencyKey!.trim(),
          receivedById: ctx().userId ?? null,
          receivedAt,
        },
      });
      await this.settle(tx, payment, locked, 'payment.recorded');
      return this.present(await this.load(tx, payment.id));
    });
  }

  // ------------------------------------------------------------------ online payments
  /** The browser is sent back only to one of this centre's own portals (no open redirect through the gateway). */
  private async assertReturnUrl(returnUrl: string | undefined) {
    if (!returnUrl) return;
    let origin: string;
    try {
      origin = new URL(returnUrl).origin;
    } catch {
      throw Errors.badRequest('INVALID_RETURN_URL', 'The return address is not a valid URL.');
    }
    if (!(await this.resolver.isAllowedOrigin(origin))) throw Errors.badRequest('INVALID_RETURN_URL', "The return address must be one of this centre's own portals.");
  }
  private async returnUrls(invoice: { id: string; corporateAccountId: string | null }, paymentId: string, returnUrl?: string) {
    if (returnUrl) {
      const withResult = (result: string) => {
        const u = new URL(returnUrl);
        u.searchParams.set('payment', paymentId);
        u.searchParams.set('result', result);
        return u.toString();
      };
      return { successUrl: withResult('success'), cancelUrl: withResult('cancelled') };
    }
    const app = audience() === 'CORPORATE' ? 'corporate' : 'customer';
    const link = (result: string) => this.resolver.portalLink(this.db.tenantId, '/payments/return', { invoice: invoice.id, payment: paymentId, result }, app);
    return { successUrl: await link('success'), cancelUrl: await link('cancelled') };
  }

  /**
   * Starts an online payment for one invoice: a PENDING payment plus a hosted
   * checkout session at the centre's gateway. Nothing is marked paid here - only
   * the signed gateway webhook completes the payment.
   */
  async startOnline(invoiceId: string, input: PayInvoiceInput) {
    await this.assertReturnUrl(input.returnUrl);
    const prepared = await this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const invoice = found(
        await tx.invoice.findFirst({ where: { id: invoiceId, tenantId, AND: [documentScope(), invoiceVisibility()] }, include: { customer: { select: { email: true } } } }),
        'Invoice',
      );
      if (!PAYABLE.includes(invoice.status)) {
        throw Errors.conflict('INVOICE_NOT_PAYABLE', invoice.status === 'PAID' ? 'This invoice is already paid.' : `This invoice is ${invoice.status.toLowerCase().replace('_', ' ')} and cannot be paid.`);
      }
      const amount = input.amount ? D(input.amount) : D(invoice.balanceDue);
      if (amount.lte(0) || amount.gt(invoice.balanceDue)) {
        throw Errors.unprocessable('OVERPAYMENT', `The balance of this invoice is ${invoice.currency} ${fmt(invoice.balanceDue)}.`, { balanceDue: fmt(invoice.balanceDue) });
      }
      const gateway = await this.gateways.forTenant(tx);
      const payment = await tx.payment.create({
        data: {
          tenantId,
          branchId: invoice.branchId,
          paymentNo: await this.sequences.next(tx, 'payment'),
          customerId: invoice.customerId,
          corporateAccountId: invoice.corporateAccountId,
          method: 'ONLINE_GATEWAY',
          status: 'PENDING',
          amount,
          currency: invoice.currency,
          gateway: gateway.name,
          // The invoice this checkout is for; the webhook allocates the money to it.
          reference: invoice.invoiceNo,
          receivedById: audience() === 'STAFF' ? (ctx().userId ?? null) : null,
        },
      });
      await this.audit.log(
        { action: 'payment.checkout_started', resourceType: 'Payment', resourceId: payment.id, summary: `${payment.paymentNo}: online payment of ${invoice.currency} ${fmt(amount)} for ${invoice.invoiceNo} started`, after: { invoiceNo: invoice.invoiceNo, amount: fmt(amount), gateway: gateway.name, startedBy: audience() } },
        tx,
      );
      return { invoice, payment, gateway };
    });
    const { invoice, payment, gateway } = prepared;
    const urls = await this.returnUrls(invoice, payment.id, input.returnUrl);
    let session: Awaited<ReturnType<typeof gateway.createCheckout>>;
    try {
      // The gateway is called outside the database transaction: a slow gateway must never hold locks.
      session = await gateway.createCheckout({
        channel: 'payments',
        reference: payment.id,
        amount: fmt(payment.amount),
        currency: payment.currency,
        description: `Invoice ${invoice.invoiceNo}`,
        customerEmail: invoice.customer.email,
        ...urls,
        metadata: { tenantId: this.db.tenantId, paymentId: payment.id, invoiceId: invoice.id },
      });
    } catch (e: any) {
      const reason = e instanceof GatewayError ? e.message : 'The payment gateway could not be reached.';
      await this.db.tx(async (tx) => {
        await tx.payment.updateMany({ where: { id: payment.id, tenantId: this.db.tenantId, status: 'PENDING' }, data: { status: 'FAILED', failureReason: reason.slice(0, 500) } });
        await this.audit.log({ action: 'payment.checkout_failed', resourceType: 'Payment', resourceId: payment.id, after: { reason } }, tx);
      });
      throw new AppError(502, 'GATEWAY_ERROR', `The payment page could not be opened: ${reason} Please try again, or pay at the centre.`);
    }
    await this.db.tx((tx) => tx.payment.updateMany({ where: { id: payment.id, tenantId: this.db.tenantId, status: 'PENDING' }, data: { gatewaySessionRef: session.sessionRef } }));
    return {
      paymentId: payment.id,
      paymentNo: payment.paymentNo,
      status: 'PENDING' as const,
      invoiceId: invoice.id,
      amount: fmt(payment.amount),
      currency: payment.currency,
      gateway: gateway.name,
      testMode: gateway.isTest,
      checkoutUrl: session.checkoutUrl,
      expiresAt: session.expiresAt,
    };
  }

  /**
   * Called by the webhook intake inside runAsTenant, after the signature was
   * verified. Completes the payment exactly once.
   */
  async completeOnline(paymentId: string, event: GatewayEvent): Promise<OnlineOutcome> {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const payment = found(await this.core.lockPayment(tx, paymentId), 'Payment');
      // An attempt that WE closed because nothing arrived in time can still be completed: the provider says the
      // money was taken, and that is what counts. Every other closed state stays closed.
      const lateSuccess = payment.status === 'CANCELLED' && payment.failureReason === CHECKOUT_EXPIRED_REASON && payment.method === 'ONLINE_GATEWAY';
      if (payment.status !== 'PENDING' && !lateSuccess) return { outcome: 'IGNORED', reason: `Payment is already ${payment.status}.`, paymentId };
      if ((event.amount !== null && !D(event.amount).equals(payment.amount)) || (event.currency !== null && event.currency !== payment.currency)) {
        return { outcome: 'REJECTED', reason: `The gateway reported ${event.currency ?? ''} ${event.amount ?? '?'} but ${payment.currency} ${fmt(payment.amount)} was expected.`, paymentId };
      }
      const receiptNo = await this.sequences.next(tx, 'receipt');
      // Exactly-once guard: only the state that was read (PENDING, or closed as EXPIRED) can become COMPLETED.
      const changed = await tx.payment.updateMany({
        where: { id: paymentId, tenantId, status: payment.status, ...(lateSuccess ? { failureReason: CHECKOUT_EXPIRED_REASON } : {}) },
        data: { status: 'COMPLETED', receiptNo, receivedAt: new Date(), failureReason: null, gatewayPaymentRef: event.paymentRef, ...(payment.gatewaySessionRef ? {} : { gatewaySessionRef: event.sessionRef }) },
      });
      if (changed.count !== 1) throw Errors.conflict('PAYMENT_STATE_CHANGED', 'The payment changed while it was being completed.');
      if (lateSuccess) {
        await this.audit.log({ action: 'payment.checkout_revived', resourceType: 'Payment', resourceId: paymentId, summary: `${payment.paymentNo}: the provider confirmed the payment after the attempt had been closed as expired`, before: { status: 'CANCELLED', reason: CHECKOUT_EXPIRED_REASON }, after: { status: 'COMPLETED' } }, tx);
      }

      const allocations: Array<{ invoice: LockedInvoice; amount: Prisma.Decimal }> = [];
      const target = payment.reference ? await tx.invoice.findFirst({ where: { tenantId, invoiceNo: payment.reference }, select: { id: true } }) : null;
      const invoice = target ? await this.core.lockInvoice(tx, target.id) : null;
      if (invoice && PAYABLE.includes(invoice.status)) {
        const amount = Prisma.Decimal.min(payment.amount, invoice.balanceDue);
        if (amount.gt(0)) allocations.push({ invoice, amount });
      }
      await this.settle(tx, { ...payment, receiptNo }, allocations, 'payment.completed_online');
      const unallocated = D(payment.amount).minus(sum(allocations.map((a) => a.amount)));
      if (unallocated.gt(0)) {
        // The money was really taken, so the payment is recorded in full; the part that no longer fits the invoice needs a refund decision.
        await this.audit.log(
          { action: 'payment.unallocated', resourceType: 'Payment', resourceId: paymentId, summary: `${payment.paymentNo}: ${payment.currency} ${fmt(unallocated)} could not be allocated (invoice ${payment.reference ?? '-'} is ${invoice?.status ?? 'missing'}). Refund or allocate it manually.`, after: { unallocated: fmt(unallocated) } },
          tx,
        );
      }
      return { outcome: 'COMPLETED', paymentId };
    });
  }

  async failOnline(paymentId: string, event: GatewayEvent): Promise<OnlineOutcome> {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const payment = found(await this.core.lockPayment(tx, paymentId), 'Payment');
      if (payment.status !== 'PENDING') return { outcome: 'IGNORED', reason: `Payment is already ${payment.status}.`, paymentId };
      const reason = (event.failureReason ?? 'The payment was not completed.').slice(0, 500);
      const changed = await tx.payment.updateMany({ where: { id: paymentId, tenantId, status: 'PENDING' }, data: { status: 'FAILED', failureReason: reason } });
      if (changed.count !== 1) throw Errors.conflict('PAYMENT_STATE_CHANGED', 'The payment changed while it was being updated.');
      await this.audit.log({ action: 'payment.failed', resourceType: 'Payment', resourceId: paymentId, summary: `${payment.paymentNo} failed: ${reason}`, after: { status: 'FAILED', reason } }, tx);
      await this.events.emit(tx, 'payment.failed', { paymentId, customerId: payment.customerId ?? undefined, reason });
      return { outcome: 'FAILED', paymentId };
    });
  }
}
