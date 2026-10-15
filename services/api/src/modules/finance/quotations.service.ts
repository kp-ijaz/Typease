import { Injectable, OnModuleInit } from '@nestjs/common';
import type { CreateQuotationInput, DiscountRejectInput, FinanceLineInput, QuotationFromRequestInput, QuotationListQuery, UpdateQuotationInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { can, ctx } from '../../common/context';
import { Prisma, TenantDb, Tx } from '../../common/db/prisma.service';
import { DomainEvents } from '../../common/events.service';
import { Errors, found } from '../../common/errors';
import { JobQueue } from '../../common/jobs/job-queue';
import { D, pageArgs, pageResult } from '../../common/pagination';
import { assertBranchAccess } from '../../common/scope';
import { SequenceService } from '../../common/sequence.service';
import { TenantDirectory } from '../../common/tenant-directory';
import { CalculatedDocument, fmt } from './finance.calc';
import { audience, customerFacing, dateRange, documentScope, FinanceCore, toLineData, totalsData } from './finance.core';
import { embedCustomerRef } from '../../common/customer-ref';
import { InvoicesService } from './invoices.service';

const SORT = ['createdAt', 'validUntil', 'total', 'quotationNo', 'sentAt'] as const;
export const EXPIRE_JOB = 'finance.quotations.expire';
const INCLUDE = {
  quotationItems: { orderBy: { sortOrder: 'asc' as const } },
  customer: { select: { id: true, customerNo: true, fullName: true, email: true, phone: true, status: true } },
  corporateAccount: { select: { id: true, accountNo: true, companyName: true } },
  branch: { select: { id: true, code: true, name: true } },
  request: { select: { id: true, requestNo: true } },
};

@Injectable()
export class QuotationsService implements OnModuleInit {
  constructor(
    private readonly db: TenantDb,
    private readonly core: FinanceCore,
    private readonly invoices: InvoicesService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly sequences: SequenceService,
    private readonly jobs: JobQueue,
    private readonly directory: TenantDirectory,
  ) {}

  onModuleInit() {
    this.jobs.register(
      EXPIRE_JOB,
      async () => {
        await this.directory.forEachTenant(EXPIRE_JOB, async () => void (await this.expireDue()));
      },
      { attempts: 1 },
    );
    this.jobs.schedule({ name: EXPIRE_JOB, cron: '*/15 * * * *', description: 'Marks sent quotations past their validity date as EXPIRED.' });
  }

  /** Customers and corporate users only see quotations that were sent to them, without internal approval details. */
  present<T extends Record<string, any>>(q: T) {
    const expired = q.status === 'SENT' && !!q.validUntil && q.validUntil < new Date();
    q = embedCustomerRef(q); // `customer.erased` instead of the record status
    if (!customerFacing()) return { ...q, expired };
    const { discountRequestedById: _a, discountDecidedById: _b, discountReason: _c, discountApproval: _d, createdById: _e, decidedById: _f, version: _v, ...rest } = q;
    return { ...rest, expired };
  }
  private visibility(): Prisma.QuotationWhereInput {
    return customerFacing() ? { sentAt: { not: null }, status: { not: 'DRAFT' } } : {};
  }
  private async load(tx: Tx, id: string) {
    return found(await tx.quotation.findFirst({ where: { id, tenantId: this.db.tenantId, AND: [documentScope(), this.visibility()] }, include: INCLUDE }), 'Quotation');
  }

  async get(id: string) {
    return this.db.tx(async (tx) => {
      const q = await this.load(tx, id);
      const invoice = await tx.invoice.findFirst({ where: { tenantId: this.db.tenantId, quotationId: id }, select: { id: true, invoiceNo: true, status: true, balanceDue: true } });
      return { ...this.present(q), invoice };
    });
  }

  async list(query: QuotationListQuery) {
    return this.db.tx(async (tx) => {
      const created = dateRange(query.from, query.to);
      const where: Prisma.QuotationWhereInput = {
        tenantId: this.db.tenantId,
        AND: [
          documentScope(),
          this.visibility(),
          query.status ? { status: query.status } : {},
          query.customerId ? { customerId: { in: await this.core.customerFilterIds(tx, query.customerId) } } : {},
          query.requestId ? { requestId: query.requestId } : {},
          query.corporateAccountId ? { corporateAccountId: query.corporateAccountId } : {},
          query.branchId ? { branchId: query.branchId } : {},
          query.discountApproval && !customerFacing() ? { discountApproval: query.discountApproval } : {},
          created ? { createdAt: created } : {},
          query.q ? { OR: [{ quotationNo: { contains: query.q, mode: 'insensitive' } }, { customer: { fullName: { contains: query.q, mode: 'insensitive' } } }] } : {},
        ],
      };
      const [rows, total] = await Promise.all([
        tx.quotation.findMany({
          where,
          ...pageArgs(query, SORT, 'createdAt:desc'),
          include: { customer: INCLUDE.customer, corporateAccount: INCLUDE.corporateAccount, branch: INCLUDE.branch, request: INCLUDE.request },
        }),
        tx.quotation.count({ where }),
      ]);
      return pageResult(rows.map((r) => this.present(r)), total, query);
    });
  }

  // ------------------------------------------------------------------ create / edit
  private discountState(doc: Pick<CalculatedDocument, 'hasDiscount'>, reason: string | null | undefined) {
    if (!doc.hasDiscount) return { discountApproval: 'NONE', discountRequestedById: null, discountDecidedById: null, discountReason: null };
    if (!reason) throw Errors.unprocessable('DISCOUNT_REASON_REQUIRED', 'Explain why the discount is given. It is sent to the person who approves discounts.');
    return { discountApproval: 'PENDING', discountRequestedById: ctx().userId ?? null, discountDecidedById: null, discountReason: reason };
  }
  private validity(input: string | undefined, days: number): Date {
    if (!input) return new Date(Date.now() + days * 86_400_000);
    const d = new Date(input);
    if (d <= new Date()) throw Errors.unprocessable('VALIDITY_IN_PAST', 'The validity date must be in the future.');
    return d;
  }

  private async insert(
    tx: Tx,
    parties: Awaited<ReturnType<FinanceCore['resolveParties']>>,
    items: FinanceLineInput[],
    opts: { validUntil?: string; notes?: string | null; discountReason?: string | null; currency?: string },
  ) {
    const tenantId = this.db.tenantId;
    const settings = await this.core.settings(tx);
    const doc = await this.core.calculate(tx, items, settings.taxRatePercent);
    const quotation = await tx.quotation.create({
      data: {
        tenantId,
        branchId: parties.branch.id,
        quotationNo: await this.sequences.next(tx, 'quotation'),
        requestId: parties.request?.id ?? null,
        customerId: parties.customer.id,
        corporateAccountId: parties.corporateAccount?.id ?? null,
        status: 'DRAFT',
        currency: opts.currency ?? settings.currency,
        ...totalsData(doc),
        validUntil: this.validity(opts.validUntil, settings.quotationValidityDays),
        notes: opts.notes ?? null,
        ...this.discountState(doc, opts.discountReason),
        createdById: ctx().userId ?? null,
      },
    });
    await tx.quotationItem.createMany({ data: toLineData(doc).map((l) => ({ ...l, tenantId, quotationId: quotation.id })) });
    await this.audit.log(
      {
        action: 'quotation.created',
        resourceType: 'Quotation',
        resourceId: quotation.id,
        summary: `${quotation.quotationNo} drafted for ${quotation.currency} ${fmt(doc.total)}`,
        after: { quotationNo: quotation.quotationNo, customerId: quotation.customerId, requestId: quotation.requestId, total: fmt(doc.total), discountTotal: fmt(doc.discountTotal), discountApproval: quotation.discountApproval },
      },
      tx,
    );
    return this.present(await this.load(tx, quotation.id));
  }

  async create(input: CreateQuotationInput) {
    return this.db.tx(async (tx) => {
      const parties = await this.core.resolveParties(tx, input);
      return this.insert(tx, parties, input.items, input);
    });
  }

  /**
   * Builds the quotation from the request's service: the effective price for the
   * request's branch (branch price row, else the default row), the company's
   * contract price for the service fee, and the government / third-party
   * estimates as separate lines.
   */
  async createFromRequest(requestId: string, input: QuotationFromRequestInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const request = found(await tx.serviceRequest.findFirst({ where: { id: requestId, tenantId, deletedAt: null, ...documentScopeForRequest() }, include: { service: true } }), 'Request');
      assertBranchAccess(request.branchId);
      if (['CANCELLED', 'COMPLETED'].includes(request.status)) throw Errors.conflict('REQUEST_CLOSED', 'This request is closed, so it cannot be quoted.');
      const now = new Date();
      const prices = await tx.servicePrice.findMany({
        where: { tenantId, serviceId: request.serviceId, isActive: true, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }], AND: [{ OR: [{ branchId: request.branchId }, { branchId: null }] }] },
        orderBy: { validFrom: 'desc' },
      });
      const price = prices.find((p) => p.branchId === request.branchId) ?? prices.find((p) => p.branchId === null);
      if (!price) {
        throw Errors.unprocessable('NO_PRICE', `"${request.service.name}" has no active price for this branch. Add a price in the service catalogue, or create the quotation line by line.`);
      }
      let serviceFee = D(price.serviceFee);
      let contract = false;
      if (request.corporateAccountId) {
        const corporate = await tx.corporatePrice.findFirst({ where: { tenantId, corporateAccountId: request.corporateAccountId, serviceId: request.serviceId } });
        if (corporate) {
          serviceFee = D(corporate.serviceFee);
          contract = true;
        }
      }
      const items: FinanceLineInput[] = [
        {
          serviceId: request.serviceId,
          description: `${request.service.name} - service fee${contract ? ' (contract price)' : ''}`,
          component: 'SERVICE_FEE',
          quantity: '1',
          unitAmount: serviceFee.toFixed(2),
          discountAmount: input.serviceFeeDiscount ?? '0',
        },
      ];
      if (D(price.governmentFeeEstimate).gt(0)) {
        items.push({ serviceId: request.serviceId, description: `${request.service.name} - government fee (estimate)`, component: 'GOVERNMENT_FEE', quantity: '1', unitAmount: D(price.governmentFeeEstimate).toFixed(2), discountAmount: '0' });
      }
      if (D(price.thirdPartyFeeEstimate).gt(0)) {
        items.push({ serviceId: request.serviceId, description: `${request.service.name} - third-party charge (estimate)`, component: 'THIRD_PARTY_FEE', quantity: '1', unitAmount: D(price.thirdPartyFeeEstimate).toFixed(2), discountAmount: '0' });
      }
      const parties = await this.core.resolveParties(tx, { customerId: request.customerId, requestId: request.id, branchId: request.branchId, corporateAccountId: request.corporateAccountId });
      return this.insert(tx, parties, items, { ...input, currency: price.currency });
    });
  }

  private async editable(tx: Tx, id: string) {
    const q = await this.load(tx, id);
    if (q.status !== 'DRAFT') {
      throw Errors.conflict('QUOTATION_NOT_DRAFT', 'Only a draft quotation can be changed. Create a new quotation instead: sending it replaces this one.');
    }
    return q;
  }

  async update(id: string, input: UpdateQuotationInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const before = await this.editable(tx, id);
      const settings = await this.core.settings(tx);
      const data: Prisma.QuotationUncheckedUpdateInput = { version: { increment: 1 } };
      if (input.notes !== undefined) data.notes = input.notes;
      if (input.validUntil) data.validUntil = this.validity(input.validUntil, settings.quotationValidityDays);
      if (input.items) {
        const doc = await this.core.calculate(tx, input.items, settings.taxRatePercent);
        await tx.quotationItem.deleteMany({ where: { tenantId, quotationId: id } });
        await tx.quotationItem.createMany({ data: toLineData(doc).map((l) => ({ ...l, tenantId, quotationId: id })) });
        // Changing the lines always restarts discount approval: an approval covers exactly what was approved.
        Object.assign(data, totalsData(doc), this.discountState(doc, input.discountReason ?? before.discountReason));
      } else if (input.discountReason !== undefined && D(before.discountTotal).gt(0)) {
        // Re-request after a rejection that kept the discounts.
        Object.assign(data, this.discountState({ hasDiscount: true }, input.discountReason));
      }
      await tx.quotation.update({ where: { id }, data });
      const after = await this.load(tx, id);
      await this.audit.log(
        {
          action: 'quotation.updated',
          resourceType: 'Quotation',
          resourceId: id,
          before: { total: fmt(before.total), discountTotal: fmt(before.discountTotal), discountApproval: before.discountApproval },
          after: { total: fmt(after.total), discountTotal: fmt(after.discountTotal), discountApproval: after.discountApproval },
        },
        tx,
      );
      return this.present(after);
    });
  }

  // ------------------------------------------------------------------ discount approval (segregation of duties)
  private discountApprovers(tx: Tx) {
    return tx.tenantMembership.count({
      where: { tenantId: this.db.tenantId, kind: 'STAFF', status: 'ACTIVE', role: { rolePermissions: { some: { permissionKey: 'discount.approve' } } } },
    });
  }

  async approveDiscount(id: string, note?: string | null) {
    return this.db.tx(async (tx) => {
      const q = await this.editable(tx, id);
      if (q.discountApproval !== 'PENDING') throw Errors.conflict('NO_PENDING_DISCOUNT', 'There is no discount waiting for approval on this quotation.');
      const c = ctx();
      let selfApproved = false;
      if (q.discountRequestedById && q.discountRequestedById === c.userId) {
        // The requester may only approve when nobody else in the centre can.
        if ((await this.discountApprovers(tx)) > 1) {
          throw Errors.forbidden('SELF_APPROVAL_FORBIDDEN', 'You requested this discount, so a different person has to approve it.');
        }
        selfApproved = true;
      }
      await tx.quotation.update({ where: { id }, data: { discountApproval: 'APPROVED', discountDecidedById: c.userId ?? null, version: { increment: 1 } } });
      await this.audit.log(
        {
          action: 'quotation.discount_approved',
          resourceType: 'Quotation',
          resourceId: id,
          summary: `Discount of ${q.currency} ${fmt(q.discountTotal)} approved on ${q.quotationNo}${selfApproved ? ' (self-approved: only approver in the centre)' : ''}`,
          after: { discountTotal: fmt(q.discountTotal), requestedById: q.discountRequestedById, approvedById: c.userId, selfApproved, note: note ?? null },
        },
        tx,
      );
      return this.present(await this.load(tx, id));
    });
  }

  async rejectDiscount(id: string, input: DiscountRejectInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const q = await this.editable(tx, id);
      if (q.discountApproval !== 'PENDING') throw Errors.conflict('NO_PENDING_DISCOUNT', 'There is no discount waiting for approval on this quotation.');
      const c = ctx();
      if (input.clearDiscounts) {
        // Back to a sendable draft without the discount.
        const settings = await this.core.settings(tx);
        const items: FinanceLineInput[] = q.quotationItems.map((l) => ({
          serviceId: l.serviceId,
          description: l.description,
          component: l.component,
          quantity: l.quantity.toString(),
          unitAmount: l.unitAmount.toFixed(2),
          discountAmount: '0',
          taxRatePercent: l.taxRatePercent.toString(),
        }));
        const doc = await this.core.calculate(tx, items, settings.taxRatePercent);
        await tx.quotationItem.deleteMany({ where: { tenantId, quotationId: id } });
        await tx.quotationItem.createMany({ data: toLineData(doc).map((l) => ({ ...l, tenantId, quotationId: id })) });
        await tx.quotation.update({
          where: { id },
          data: { ...totalsData(doc), discountApproval: 'NONE', discountDecidedById: c.userId ?? null, discountReason: `Rejected: ${input.reason}`.slice(0, 500), version: { increment: 1 } },
        });
      } else {
        // Discounts stay on the draft; it cannot be sent until they are changed or requested again.
        await tx.quotation.update({ where: { id }, data: { discountApproval: 'REJECTED', discountDecidedById: c.userId ?? null, version: { increment: 1 } } });
      }
      await this.audit.log(
        {
          action: 'quotation.discount_rejected',
          resourceType: 'Quotation',
          resourceId: id,
          summary: `Discount of ${q.currency} ${fmt(q.discountTotal)} rejected on ${q.quotationNo}`,
          before: { discountTotal: fmt(q.discountTotal), requestedById: q.discountRequestedById },
          after: { rejectedById: c.userId, reason: input.reason, discountsCleared: input.clearDiscounts },
        },
        tx,
      );
      return this.present(await this.load(tx, id));
    });
  }

  // ------------------------------------------------------------------ send / cancel
  /** `silent`: the customer is told by the caller instead (the renewal autopilot sends its one-tap link). */
  async send(id: string, opts: { silent?: boolean } = {}) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const q = await this.editable(tx, id);
      if (q.discountApproval === 'PENDING') {
        throw Errors.conflict('DISCOUNT_APPROVAL_REQUIRED', 'This quotation contains a discount that has not been approved yet. Ask someone who may approve discounts.');
      }
      if (q.discountApproval === 'REJECTED') {
        throw Errors.conflict('DISCOUNT_REJECTED', 'The discount on this quotation was rejected. Remove it, or change it and request approval again.');
      }
      if (!q.quotationItems.length) throw Errors.unprocessable('NO_LINES', 'Add at least one line before sending the quotation.');
      const settings = await this.core.settings(tx);
      const now = new Date();
      const validUntil = q.validUntil && q.validUntil > now ? q.validUntil : new Date(now.getTime() + settings.quotationValidityDays * 86_400_000);
      const superseded = q.requestId
        ? await tx.quotation.findMany({ where: { tenantId, requestId: q.requestId, status: 'SENT', id: { not: id } }, select: { id: true, quotationNo: true } })
        : [];
      if (superseded.length) {
        await tx.quotation.updateMany({ where: { tenantId, id: { in: superseded.map((s) => s.id) }, status: 'SENT' }, data: { status: 'SUPERSEDED' } });
        for (const s of superseded) {
          await this.audit.log({ action: 'quotation.superseded', resourceType: 'Quotation', resourceId: s.id, summary: `${s.quotationNo} superseded by ${q.quotationNo}`, after: { supersededBy: id } }, tx);
        }
      }
      await tx.quotation.update({ where: { id }, data: { status: 'SENT', sentAt: now, validUntil, version: { increment: 1 } } });
      await this.audit.log({ action: 'quotation.sent', resourceType: 'Quotation', resourceId: id, summary: `${q.quotationNo} sent`, after: { total: fmt(q.total), validUntil, superseded: superseded.map((s) => s.quotationNo) } }, tx);
      await this.events.emit(tx, 'quotation.sent', { quotationId: id, requestId: q.requestId ?? undefined, customerId: q.customerId, total: fmt(q.total), currency: q.currency, ...(opts.silent ? { silent: true } : {}) });
      return this.present(await this.load(tx, id));
    });
  }

  async cancel(id: string, reason?: string | null) {
    return this.db.tx(async (tx) => {
      const q = await this.load(tx, id);
      if (!['DRAFT', 'SENT'].includes(q.status)) throw Errors.conflict('QUOTATION_CLOSED', `This quotation is already ${q.status.toLowerCase()}.`);
      const changed = await tx.quotation.updateMany({ where: { id, tenantId: this.db.tenantId, status: q.status }, data: { status: 'CANCELLED', rejectionReason: reason ?? null } });
      if (!changed.count) throw Errors.conflict('QUOTATION_CHANGED', 'This quotation was changed by someone else. Reload and try again.');
      await this.audit.log({ action: 'quotation.cancelled', resourceType: 'Quotation', resourceId: id, before: { status: q.status }, after: { status: 'CANCELLED', reason: reason ?? null } }, tx);
      return this.present(await this.load(tx, id));
    });
  }

  // ------------------------------------------------------------------ customer decision
  /**
   * Who may decide: the owning customer, a corporate admin of the owning company, or
   * staff recording the customer's decision (then a note is mandatory and audited).
   */
  private decisionActor(note?: string | null) {
    const who = audience();
    if (who === 'STAFF') {
      if (!can('quotation.manage')) throw Errors.forbidden();
      if (!note) throw Errors.unprocessable('NOTE_REQUIRED', 'Record how the customer gave the decision (for example "approved at the counter" or "confirmed by phone").');
    } else if (who === 'CORPORATE' && !can('corp.requests.approve')) throw Errors.forbidden();
    else if (who === 'CUSTOMER' && !can('self.payments')) throw Errors.forbidden();
    return who;
  }

  /** Marks one quotation EXPIRED if its validity has passed. Committed on its own so the refusal that follows does not undo it. */
  private async expireIfDue(id: string): Promise<boolean> {
    return this.db.tx(async (tx) => {
      const changed = await tx.quotation.updateMany({ where: { id, tenantId: this.db.tenantId, status: 'SENT', validUntil: { lt: new Date() } }, data: { status: 'EXPIRED' } });
      if (changed.count) await this.audit.log({ action: 'quotation.expired', resourceType: 'Quotation', resourceId: id, after: { status: 'EXPIRED' } }, tx);
      return changed.count > 0;
    });
  }

  async approve(id: string, note?: string | null) {
    const who = this.decisionActor(note);
    await this.db.tx((tx) => this.load(tx, id)); // 404 before anything else for rows the caller may not see
    if (await this.expireIfDue(id)) {
      throw Errors.conflict('QUOTATION_EXPIRED', 'This quotation has expired. Please ask the centre for an updated quotation.');
    }
    return this.db.tx(async (tx) => {
      const q = await this.load(tx, id);
      if (q.status === 'EXPIRED') throw Errors.conflict('QUOTATION_EXPIRED', 'This quotation has expired. Please ask the centre for an updated quotation.');
      if (q.status !== 'SENT') throw Errors.conflict('QUOTATION_NOT_OPEN', `This quotation is ${q.status.toLowerCase()} and can no longer be approved.`);
      const c = ctx();
      const now = new Date();
      // Conditional update: two simultaneous approvals can never both succeed (and so never create two invoices).
      const changed = await tx.quotation.updateMany({
        where: { id, tenantId: this.db.tenantId, status: 'SENT' },
        data: { status: 'APPROVED', decidedAt: now, decidedById: c.userId ?? null, decidedByType: c.actorType },
      });
      if (!changed.count) throw Errors.conflict('QUOTATION_NOT_OPEN', 'This quotation was just decided by someone else.');
      await this.audit.log(
        {
          action: 'quotation.approved',
          resourceType: 'Quotation',
          resourceId: id,
          summary: who === 'STAFF' ? `${q.quotationNo} approved by staff on the customer's behalf` : `${q.quotationNo} approved by the ${who.toLowerCase()} user`,
          after: { status: 'APPROVED', decidedByType: c.actorType, onBehalfOfCustomer: who === 'STAFF', note: note ?? null, total: fmt(q.total) },
        },
        tx,
      );
      await this.events.emit(tx, 'quotation.approved', { quotationId: id, requestId: q.requestId ?? undefined, customerId: q.customerId, approvedByType: c.actorType });
      const invoice = await this.invoices.createFromQuotation(tx, q);
      return {
        quotation: this.present(await this.load(tx, id)),
        invoice: { id: invoice.id, invoiceNo: invoice.invoiceNo, status: invoice.status, total: invoice.total, balanceDue: invoice.balanceDue, currency: invoice.currency, dueAt: invoice.dueAt },
      };
    });
  }

  async reject(id: string, reason: string) {
    const who = this.decisionActor(reason);
    await this.db.tx((tx) => this.load(tx, id));
    if (await this.expireIfDue(id)) throw Errors.conflict('QUOTATION_EXPIRED', 'This quotation has already expired.');
    return this.db.tx(async (tx) => {
      const q = await this.load(tx, id);
      if (q.status !== 'SENT') throw Errors.conflict('QUOTATION_NOT_OPEN', `This quotation is ${q.status.toLowerCase()} and can no longer be rejected.`);
      const c = ctx();
      const changed = await tx.quotation.updateMany({
        where: { id, tenantId: this.db.tenantId, status: 'SENT' },
        data: { status: 'REJECTED', decidedAt: new Date(), decidedById: c.userId ?? null, decidedByType: c.actorType, rejectionReason: reason },
      });
      if (!changed.count) throw Errors.conflict('QUOTATION_NOT_OPEN', 'This quotation was just decided by someone else.');
      await this.audit.log({ action: 'quotation.rejected', resourceType: 'Quotation', resourceId: id, after: { status: 'REJECTED', decidedByType: c.actorType, onBehalfOfCustomer: who === 'STAFF', reason } }, tx);
      await this.events.emit(tx, 'quotation.rejected', { quotationId: id, requestId: q.requestId ?? undefined, customerId: q.customerId, reason });
      return this.present(await this.load(tx, id));
    });
  }

  // ------------------------------------------------------------------ scheduled expiry (runs per tenant)
  async expireDue(): Promise<number> {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const due = await tx.quotation.findMany({ where: { tenantId, status: 'SENT', validUntil: { lt: new Date() } }, select: { id: true, quotationNo: true }, take: 500 });
      if (!due.length) return 0;
      const changed = await tx.quotation.updateMany({ where: { tenantId, id: { in: due.map((d) => d.id) }, status: 'SENT' }, data: { status: 'EXPIRED' } });
      for (const d of due) await this.audit.log({ action: 'quotation.expired', resourceType: 'Quotation', resourceId: d.id, summary: `${d.quotationNo} expired`, after: { status: 'EXPIRED' } }, tx);
      return changed.count;
    });
  }
}

/** Staff limited to assigned requests may only quote those. */
function documentScopeForRequest(): Record<string, any> {
  const c = ctx();
  if (c.actorType === 'STAFF' && c.membershipId && c.permissions.has('request.read.assigned') && !c.permissions.has('request.read.all')) {
    return { OR: [{ assignedToId: c.membershipId }, { reviewerId: c.membershipId }] };
  }
  return {};
}
