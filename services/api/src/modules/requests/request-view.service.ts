import { isErasedCustomer } from '../../common/customer-ref';
import { Injectable } from '@nestjs/common';
import { OPEN_STATUSES, REQUEST_STATUS_META, STATUS_SOURCE_LABEL, TERMINAL_STATUSES, WORKFLOW_STEP_META } from '@typease/types';
import type { RequestStatus } from '@typease/types';
import type { RequestExternalReference, ServiceRequest, StatusSource } from '@typease/database';
import { presentAuthor } from '../../common/author-display';
import { ctx, Ctx } from '../../common/context';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { Clock } from '../workflows/clock';
import { visibleFieldKeys } from './form-validator';
import { isExternalActor, requestActorKind } from './request-access';
import { externalResultOf, permittedChannels, RequestReader } from './request-reader.service';
import { RequestStateMachine } from './request-state-machine.service';
import { WorkflowEngine } from './workflow-engine.service';

export const statusLabel = (status: RequestStatus, forCustomer: boolean) => {
  const meta = REQUEST_STATUS_META[status];
  return forCustomer ? { en: meta.customerEn, ar: meta.customerAr } : { en: meta.en, ar: meta.ar };
};

/** An external status is never shown without saying who vouches for it. */
export function externalStatusView(status: string | null, source: StatusSource | null, at: Date | null) {
  if (!status) return null;
  const s = source ?? 'STAFF_ENTERED';
  return { status, source: s, sourceLabel: STATUS_SOURCE_LABEL[s], at };
}

export function isOverdue(request: Pick<ServiceRequest, 'status' | 'targetDate'>, now: Date): boolean {
  return !!request.targetDate && request.targetDate < now && OPEN_STATUSES.includes(request.status) && request.status !== 'DRAFT';
}

/** What happens next, in the customer's words. */
const NEXT_STEP: Record<RequestStatus, { en: string; ar: string; waitingOn: 'CUSTOMER' | 'CENTRE' | 'AUTHORITY' | 'NOBODY' }> = {
  DRAFT: { en: 'Complete the form, add the documents and submit the request.', ar: 'أكمل النموذج وأضف المستندات ثم أرسل الطلب.', waitingOn: 'CUSTOMER' },
  SUBMITTED: { en: 'The centre will check the request and the documents.', ar: 'سيقوم المركز بمراجعة الطلب والمستندات.', waitingOn: 'CENTRE' },
  AWAITING_CUSTOMER: { en: 'The centre needs something from you before it can continue.', ar: 'يحتاج المركز إلى إجراء منك قبل المتابعة.', waitingOn: 'CUSTOMER' },
  UNDER_REVIEW: { en: 'The documents are being checked. A quotation follows.', ar: 'المستندات قيد المراجعة، وسيصلك عرض السعر بعدها.', waitingOn: 'CENTRE' },
  QUOTED: { en: 'Review the quotation and approve it to continue.', ar: 'راجع عرض السعر ووافق عليه للمتابعة.', waitingOn: 'CUSTOMER' },
  AWAITING_PAYMENT: { en: 'Pay the invoice so that processing can start.', ar: 'ادفع الفاتورة ليبدأ تنفيذ الطلب.', waitingOn: 'CUSTOMER' },
  READY_FOR_PROCESSING: { en: 'The request is in the queue. An operator will start preparing it.', ar: 'الطلب في قائمة الانتظار وسيبدأ الموظف بتحضيره.', waitingOn: 'CENTRE' },
  IN_PREPARATION: { en: 'The application is being prepared.', ar: 'الطلب قيد التحضير.', waitingOn: 'CENTRE' },
  PENDING_APPROVAL: { en: 'The application is being prepared.', ar: 'الطلب قيد التحضير.', waitingOn: 'CENTRE' },
  READY_TO_SUBMIT: { en: 'The application is ready and will be submitted.', ar: 'الطلب جاهز وسيتم تقديمه.', waitingOn: 'CENTRE' },
  EXTERNAL_PROCESSING: { en: 'The application was submitted. We are waiting for the result.', ar: 'تم تقديم الطلب وننتظر النتيجة.', waitingOn: 'AUTHORITY' },
  RETURNED: { en: 'The application was returned for correction. The centre is working on it.', ar: 'أُعيد الطلب للتصحيح والمركز يعمل عليه.', waitingOn: 'CENTRE' },
  REJECTED: { en: 'The application was not accepted. The centre will contact you about the options.', ar: 'لم يُقبل الطلب وسيتواصل معك المركز بخصوص الخيارات.', waitingOn: 'CENTRE' },
  FINAL_REVIEW: { en: 'Final checks before the documents are released.', ar: 'مراجعة نهائية قبل تسليم المستندات.', waitingOn: 'CENTRE' },
  COMPLETED: { en: 'The request is complete. The documents are available.', ar: 'اكتمل الطلب والمستندات متاحة.', waitingOn: 'NOBODY' },
  CANCELLED: { en: 'This request was cancelled.', ar: 'تم إلغاء هذا الطلب.', waitingOn: 'NOBODY' },
};

/** Statuses in which a customer may still edit the form, instructions and documents. */
export const CUSTOMER_EDITABLE: RequestStatus[] = ['DRAFT', 'AWAITING_CUSTOMER'];
export const CUSTOMER_UPLOADABLE: RequestStatus[] = ['DRAFT', 'SUBMITTED', 'AWAITING_CUSTOMER', 'UNDER_REVIEW'];

/**
 * Builds API responses for requests. One place decides what each kind of
 * actor may see: customers and corporate users never receive internal reasons,
 * internal comments, approvals, assignments, tasks or workflow internals.
 */
@Injectable()
export class RequestViews {
  constructor(
    private readonly db: TenantDb,
    private readonly reader: RequestReader,
    private readonly machine: RequestStateMachine,
    private readonly engine: WorkflowEngine,
    private readonly clock: Clock,
  ) {}

  /** The full case, shaped for the current actor. */
  async detail(tx: Tx, request: ServiceRequest) {
    const tenantId = this.db.tenantId;
    const c = ctx();
    const external = isExternalActor(c);
    const now = this.clock.now();
    const id = request.id;

    const [snapshot, branch, customer, corporate, schema, fieldRows, lines, historyRows, references, comments, position, quotation, invoices, members] = await Promise.all([
      this.reader.snapshot(tx, request),
      tx.branch.findFirst({ where: { id: request.branchId, tenantId }, select: { id: true, code: true, name: true, nameAr: true } }),
      tx.customer.findFirst({ where: { id: request.customerId, tenantId }, select: { id: true, customerNo: true, fullName: true, fullNameAr: true, type: true, email: true, phone: true, status: true } }),
      request.corporateAccountId ? tx.corporateAccount.findFirst({ where: { id: request.corporateAccountId, tenantId }, select: { id: true, accountNo: true, companyName: true } }) : null,
      this.reader.formSchema(tx, request.formDefinitionId),
      tx.requestField.findMany({ where: { tenantId, requestId: id }, orderBy: { key: 'asc' } }),
      tx.requestDocument.findMany({
        where: { tenantId, requestId: id },
        orderBy: [{ kind: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        include: { document: { select: { id: true, title: true, documentTypeKey: true, status: true, verificationStatus: true, expiryDate: true, isCompletionDocument: true, customerVisible: true, createdAt: true } } },
      }),
      tx.requestStatusHistory.findMany({ where: { tenantId, requestId: id } }),
      tx.requestExternalReference.findMany({ where: { tenantId, requestId: id }, orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }] }),
      tx.requestComment.findMany({
        where: { tenantId, requestId: id, ...(external || !c.permissions.has('request.comment.internal') ? { visibility: 'CUSTOMER' as const } : {}) },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.reader.position(tx, id),
      this.reader.currentQuotation(tx, id),
      tx.invoice.findMany({
        // No drafts for anybody here; customers and company users also never see an invoice that was voided before it was issued.
        where: { tenantId, requestId: id, status: { not: 'DRAFT' }, ...(external ? { NOT: { status: 'VOID' as const, issuedAt: null } } : {}) },
        select: { id: true, invoiceNo: true, status: true, currency: true, total: true, amountPaid: true, amountRefunded: true, balanceDue: true, issuedAt: true, dueAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      tx.tenantMembership.findMany({
        where: { tenantId, id: { in: [request.assignedToId, request.reviewerId].filter((x): x is string => !!x) } },
        select: { id: true, user: { select: { fullName: true } }, role: { select: { key: true, name: true } } },
      }),
    ]);

    const history = historyRows.sort((a, b) => Number((a.meta as any)?.seq ?? 0) - Number((b.meta as any)?.seq ?? 0) || a.createdAt.getTime() - b.createdAt.getTime());
    const member = (membershipId: string | null) => {
      const m = members.find((x) => x.id === membershipId);
      return m ? { membershipId: m.id, name: m.user.fullName, roleKey: m.role.key } : null;
    };
    const values = Object.fromEntries(fieldRows.map((f) => [f.key, f.value]));
    const awaiting = request.status === 'AWAITING_CUSTOMER' ? [...history].reverse().find((h) => h.toStatus === 'AWAITING_CUSTOMER' && h.fromStatus !== 'AWAITING_CUSTOMER') : undefined;
    const requestedItemIds = new Set<string>([...(((awaiting?.meta as any)?.requestedItemIds as string[]) ?? []), ...(((awaiting?.meta as any)?.addedItemIds as string[]) ?? []), ...(((awaiting?.meta as any)?.rejectedItemIds as string[]) ?? [])]);

    const base = {
      id,
      requestNo: request.requestNo,
      status: request.status,
      statusLabel: statusLabel(request.status, external),
      tone: REQUEST_STATUS_META[request.status].tone,
      priority: request.priority,
      source: request.source,
      paymentStatus: request.paymentStatus,
      version: request.version,
      branch,
      customer: customer ? { id: customer.id, customerNo: customer.customerNo, fullName: customer.fullName, fullNameAr: customer.fullNameAr, type: customer.type, erased: isErasedCustomer(customer), ...(external ? {} : { email: customer.email, phone: customer.phone }) } : null,
      corporateAccount: corporate,
      service: external
        ? { id: request.serviceId, name: snapshot.name, nameAr: snapshot.nameAr, code: snapshot.code }
        : { id: request.serviceId, ...snapshot, permittedChannels: permittedChannels(snapshot.complianceCapability) },
      customerInstructions: request.customerInstructions,
      submittedAt: request.submittedAt,
      targetDate: request.targetDate,
      completedAt: request.completedAt,
      cancelledAt: request.cancelledAt,
      overdue: isOverdue(request, now),
      submissionChannel: request.submissionChannel,
      externalStatus: externalStatusView(request.externalStatus, request.externalStatusSource, request.externalStatusAt),
      renewalOfDocumentId: request.renewalOfDocumentId,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
      form: {
        definitionId: request.formDefinitionId,
        schema,
        values,
        visibleFields: [...visibleFieldKeys(schema, values)],
        fields: fieldRows.map((f) => ({ key: f.key, value: f.value, source: f.source, verified: f.verified, updatedAt: f.updatedAt })),
      },
      checklist: lines
        .filter((l) => !external || l.kind === 'INPUT' || !l.document || l.document.customerVisible)
        .map((l) => ({
          id: l.id,
          kind: l.kind,
          documentTypeKey: l.documentTypeKey,
          label: l.label,
          labelAr: l.labelAr,
          isMandatory: l.isMandatory,
          status: l.status,
          /** Why the document was rejected, or why the line was waived. */
          note: l.status === 'REJECTED' || (!external && l.status === 'WAIVED') ? l.rejectionReason : null,
          actionRequired: request.status === 'AWAITING_CUSTOMER' && (l.status === 'REJECTED' || (requestedItemIds.has(l.id) && l.status !== 'VERIFIED' && l.status !== 'WAIVED')),
          reviewedAt: external ? undefined : l.reviewedAt,
          document: l.document && (!external || l.document.customerVisible) ? { id: l.document.id, title: l.document.title, documentTypeKey: l.document.documentTypeKey, status: l.document.status, verificationStatus: l.document.verificationStatus, expiryDate: l.document.expiryDate, uploadedAt: l.document.createdAt } : null,
        })),
      externalReferences: references.map((r) => this.reference(r, external)),
      // Customers and company users see staff authors by first name only (see common/author-display.ts).
      comments: comments.map((m) => ({ id: m.id, ...presentAuthor(m, external), body: m.body, visibility: m.visibility, createdAt: m.createdAt })),
      // Amounts are for people who may see money: the paying customer, the company's administrator, finance-reading staff.
      // An employee who uses the company's portal sees where the quotation and the invoices of their own request
      // stand - who has to act next - but not the amounts (the company's prices are the company's business) and
      // cannot approve or pay.
      finance: ['self.payments', 'corp.invoices.read', 'quotation.read', 'invoice.read', 'payment.read'].some((p) => c.permissions.has(p)) || c.actorType === 'SYSTEM'
        ? {
            amountsHidden: false,
            quotation: quotation ? { id: quotation.id, quotationNo: quotation.quotationNo, status: quotation.status, total: quotation.total.toFixed(2), currency: quotation.currency, validUntil: quotation.validUntil, sentAt: quotation.sentAt } : null,
            invoices: invoices.map((i) => ({ id: i.id, invoiceNo: i.invoiceNo, status: i.status, currency: i.currency, total: i.total.toFixed(2), amountPaid: i.amountPaid.minus(i.amountRefunded).toFixed(2), balanceDue: i.balanceDue.toFixed(2), issuedAt: i.issuedAt, dueAt: i.dueAt })),
            totals: { invoiced: position.invoiced.toFixed(2), paid: position.paid.toFixed(2), refunded: position.refunded.toFixed(2), balance: position.balance.toFixed(2) },
          }
        : requestActorKind(c) === 'CORPORATE_EMPLOYEE'
          ? {
              amountsHidden: true,
              quotation: quotation && quotation.status !== 'DRAFT' ? { id: quotation.id, quotationNo: quotation.quotationNo, status: quotation.status, validUntil: quotation.validUntil, sentAt: quotation.sentAt } : null,
              invoices: invoices.map((i) => ({ id: i.id, invoiceNo: i.invoiceNo, status: i.status, issuedAt: i.issuedAt, dueAt: i.dueAt })),
              totals: null,
            }
          : null,
      workflow: await this.engine.progress(tx, request, { forCustomer: external }),
      allowedActions: { transitions: await this.machine.available(tx, request), other: this.otherActions(request, c) },
      nextStep: await this.nextStep(tx, request, external, awaiting?.customerMessage ?? null),
    };

    if (external) {
      // One rating per request, whoever gives it (the person it is about or an administrator of the company).
      const rated = request.status === 'COMPLETED' ? await tx.customerFeedback.findFirst({ where: { tenantId, requestId: id }, select: { rating: true, comment: true, createdAt: true } }) : null;
      return {
        ...base,
        feedback: rated,
        canRate: request.status === 'COMPLETED' && !rated,
        // Customers see what changed and what it means for them; never who decided or why internally.
        history: history.filter((h) => h.customerVisible).map((h) => ({ id: h.id, status: h.toStatus, statusLabel: statusLabel(h.toStatus, true), message: h.customerMessage, at: h.createdAt })),
      };
    }

    const [assignments, approvals] = await Promise.all([
      tx.requestAssignment.findMany({ where: { tenantId, requestId: id }, orderBy: [{ assignedAt: 'asc' }, { id: 'asc' }], include: { assignee: { select: { user: { select: { fullName: true } }, role: { select: { key: true } } } } } }),
      tx.requestApproval.findMany({ where: { tenantId, requestId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    ]);
    const userIds = [...new Set([...history.map((h) => h.actorId), ...approvals.flatMap((a) => [a.requestedById, a.decidedById])].filter((x): x is string => !!x))];
    const users = userIds.length ? await tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true } }) : [];
    const userName = (userId: string | null) => users.find((u) => u.id === userId)?.fullName ?? null;

    return {
      ...base,
      assignee: member(request.assignedToId),
      reviewer: member(request.reviewerId),
      cancellationReason: request.cancellationReason,
      duplicateOfId: request.duplicateOfId,
      reopenedCount: request.reopenedCount,
      workflowVersionId: request.workflowVersionId,
      createdByType: request.createdByType,
      history: history.map((h) => ({
        id: h.id, from: h.fromStatus, to: h.toStatus, toLabel: statusLabel(h.toStatus, false), actorType: h.actorType, actorId: h.actorId, actorName: userName(h.actorId),
        reason: h.reason, customerVisible: h.customerVisible, customerMessage: h.customerMessage, meta: h.meta, at: h.createdAt,
      })),
      assignments: assignments.map((a) => ({ id: a.id, role: a.role, method: a.method, reason: a.reason, assigneeMembershipId: a.assigneeId, assigneeName: a.assignee.user.fullName, assigneeRoleKey: a.assignee.role.key, assignedAt: a.assignedAt, unassignedAt: a.unassignedAt })),
      approvals: approvals.map((a) => ({
        id: a.id, type: a.type, status: a.status, stepKey: a.stepKey, requestedById: a.requestedById, requestedByName: userName(a.requestedById), decidedById: a.decidedById, decidedByName: userName(a.decidedById),
        decidedAt: a.decidedAt, comment: a.comment, superseded: !!(a.payload as any)?.supersededAt, createdAt: a.createdAt,
      })),
    };
  }

  reference(r: RequestExternalReference, external: boolean) {
    const shared = {
      id: r.id,
      channel: r.channel,
      authorityName: r.authorityName,
      referenceNo: r.referenceNo,
      status: r.status,
      statusSource: r.statusSource,
      statusSourceLabel: STATUS_SOURCE_LABEL[r.statusSource],
      result: externalResultOf(r),
      recordedAt: r.recordedAt,
    };
    return external ? shared : { ...shared, partnerName: r.partnerName, partnerReference: r.partnerReference, integrationId: r.integrationId, notes: r.notes, recordedById: r.recordedById };
  }

  /** Things other than status changes the current actor can do with this request right now. */
  private otherActions(request: ServiceRequest, c: Ctx): string[] {
    const can = (...permissions: string[]) => permissions.some((p) => c.permissions.has(p));
    const open = !TERMINAL_STATUSES.includes(request.status);
    const out: string[] = [];
    if (requestActorKind(c) === 'STAFF') {
      if (open && can('request.update', 'request.process')) out.push('edit_fields');
      if (open && can('request.update')) out.push('edit_details');
      if (open && can('request.assign')) out.push('assign', 'auto_assign');
      if (open && can('request.update', 'request.process', 'document.verify')) out.push('manage_checklist');
      if (open && can('document.verify')) out.push('waive_checklist_item');
      if (request.status === 'AWAITING_CUSTOMER' && can('document.verify', 'request.update', 'request.process')) out.push('resubmit');
      if (request.status === 'PENDING_APPROVAL' && can('request.review')) out.push('decide_approval');
      if (request.status === 'IN_PREPARATION' && can('request.process')) out.push('complete_step');
      if (['READY_TO_SUBMIT', 'EXTERNAL_PROCESSING'].includes(request.status) && can('request.submit_external')) out.push('record_submission');
      if (open && can('request.submit_external', 'request.process')) out.push('update_external_status');
      if (request.status === 'EXTERNAL_PROCESSING' && can('request.process')) out.push('record_external_result');
      if (open && can('request.cancel')) out.push('mark_duplicate');
      if (open && can('workflow.manage')) out.push('migrate_workflow');
      if (can('request.comment.internal')) out.push('comment_internal');
      if (can('request.update', 'request.process', 'request.review')) out.push('comment');
      return out;
    }
    if (CUSTOMER_EDITABLE.includes(request.status)) out.push('edit_fields', 'edit_details');
    if (CUSTOMER_UPLOADABLE.includes(request.status)) out.push('upload_documents');
    if (request.status === 'AWAITING_CUSTOMER') out.push('resubmit');
    out.push('comment');
    return out;
  }

  private async nextStep(tx: Tx, request: ServiceRequest, external: boolean, customerMessage: string | null) {
    const hint = NEXT_STEP[request.status];
    const text = request.status === 'AWAITING_CUSTOMER' && customerMessage ? { en: customerMessage, ar: hint.ar } : { en: hint.en, ar: hint.ar };
    if (external) return { waitingOn: hint.waitingOn, text };
    const execution = await tx.workflowExecution.findFirst({ where: { tenantId: this.db.tenantId, requestId: request.id }, select: { id: true, status: true, currentStepKey: true } });
    let step: { key: string; name: string; type: string; waitsFor: string | null; dueAt: Date | null; blocked: unknown } | null = null;
    if (execution?.status === 'ACTIVE' && execution.currentStepKey) {
      const row = await tx.workflowStepExecution.findFirst({ where: { tenantId: this.db.tenantId, executionId: execution.id, stepKey: execution.currentStepKey }, orderBy: { attempt: 'desc' } });
      if (row) step = { key: row.stepKey, name: row.stepName, type: row.stepType, waitsFor: WORKFLOW_STEP_META[row.stepType].waitsFor, dueAt: row.dueAt, blocked: (row.result as any)?.blocked ?? null };
    }
    return { waitingOn: hint.waitingOn, text, step };
  }
}
