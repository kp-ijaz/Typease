import { Injectable } from '@nestjs/common';
import { REQUEST_STATUS_META, TERMINAL_STATUSES } from '@typease/types';
import type { RequestStatus } from '@typease/types';
import type {
  AddChecklistItemBody, CompleteWorkflowStepBody, DecideRequestApprovalBody, RequestCommentBody, RequestInformationBody,
} from '@typease/validation';
import type { ServiceRequest } from '@typease/database';
import { AuditService } from '../../common/audit.service';
import { presentAuthor } from '../../common/author-display';
import { ctx } from '../../common/context';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { Clock } from '../workflows/clock';
import { isExternalActor, RequestAccess } from './request-access';
import { guardError } from './request-guards.service';
import { RequestReader } from './request-reader.service';
import { AS_CONTEXT, AS_SYSTEM, RequestStateMachine } from './request-state-machine.service';
import { CUSTOMER_UPLOADABLE, RequestViews } from './request-view.service';
import { WorkflowEngine } from './workflow-engine.service';

/**
 * Case actions. Each one is a thin, authorised wrapper: it changes the rows it
 * is about (checklist, approval, comment) and leaves every status change to
 * the state machine, which the workflow engine then follows.
 */
@Injectable()
export class RequestActionsService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly access: RequestAccess,
    private readonly reader: RequestReader,
    private readonly machine: RequestStateMachine,
    private readonly engine: WorkflowEngine,
    private readonly views: RequestViews,
  ) {}

  /** Visible to the actor, then locked. */
  private async open(tx: Tx, id: string): Promise<ServiceRequest> {
    await this.access.assertVisible(tx, id);
    return this.machine.lock(tx, id);
  }
  private assertNotClosed(request: ServiceRequest): void {
    if (TERMINAL_STATUSES.includes(request.status)) throw Errors.conflict('REQUEST_CLOSED', `This request is ${REQUEST_STATUS_META[request.status].en.toLowerCase()} and can no longer be changed.`);
  }
  private requirePermission(...any: string[]): void {
    const c = ctx();
    if (c.actorType === 'SYSTEM') return;
    if (!any.some((p) => c.permissions.has(p))) throw Errors.forbidden();
  }

  // ------------------------------------------------------------------ information from the customer
  async requestInformation(id: string, input: RequestInformationBody) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const request = await this.open(tx, id);
      const lines = await tx.requestDocument.findMany({ where: { tenantId, requestId: id }, select: { id: true, sortOrder: true } });
      const unknown = (input.checklistItemIds ?? []).filter((itemId) => !lines.some((l) => l.id === itemId));
      if (unknown.length) throw Errors.notFound('Checklist item');
      // New lines first, so that the history entry can name them. If the state machine refuses
      // the change, the whole transaction (including these lines) is rolled back.
      const addedItemIds: string[] = [];
      let sortOrder = Math.max(0, ...lines.map((l) => l.sortOrder)) + 1;
      for (const item of input.addItems ?? []) {
        const line = await tx.requestDocument.create({
          data: { tenantId, requestId: id, documentTypeKey: item.documentTypeKey, label: item.label, labelAr: item.labelAr ?? null, kind: 'INPUT', isMandatory: item.isMandatory, sortOrder: sortOrder++ },
        });
        addedItemIds.push(line.id);
      }
      const result = await this.machine.transition(tx, id, 'AWAITING_CUSTOMER', {
        actor: AS_CONTEXT,
        reason: input.message,
        customerMessage: input.message,
        customerVisible: true,
        meta: { requestedItemIds: input.checklistItemIds ?? [], addedItemIds },
      });
      if (addedItemIds.length) {
        await this.audit.log({ action: 'request.checklist_item_added', resourceType: 'ServiceRequest', resourceId: id, summary: `${request.requestNo}: ${addedItemIds.length} document(s) requested`, after: { items: input.addItems } }, tx);
      }
      return this.views.detail(tx, result.request);
    });
  }

  /**
   * The customer (or staff on their behalf) answered. The request returns to
   * where the question came from: document review, or preparation.
   */
  async resubmit(id: string, note?: string | null) {
    return this.db.tx(async (tx) => {
      const request = await this.open(tx, id);
      if (!isExternalActor()) this.requirePermission('document.verify', 'request.update', 'request.process');
      if (request.status !== 'AWAITING_CUSTOMER') {
        throw Errors.conflict('INVALID_TRANSITION', `Nothing is waiting for an answer: the request is ${REQUEST_STATUS_META[request.status].en.toLowerCase()}.`, { from: request.status });
      }
      const { to, origin } = await this.reader.resumeTarget(tx, id);
      // Authorised above (own request, or staff permission). Both return edges are system edges:
      // the customer does not choose where the case goes, the origin of the question does.
      const result = await this.machine.transition(tx, id, to, { actor: AS_SYSTEM, reason: note ?? null, meta: { resubmitted: true, origin } });
      return this.views.detail(tx, result.request);
    });
  }

  // ------------------------------------------------------------------ checklist
  async addChecklistItem(id: string, input: AddChecklistItemBody) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const request = await this.open(tx, id);
      this.assertNotClosed(request);
      if (input.kind === 'COMPLETION') this.requirePermission('request.process');
      else this.requirePermission('request.update', 'request.process', 'document.verify');
      const last = await tx.requestDocument.findFirst({ where: { tenantId, requestId: id }, orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } });
      const line = await tx.requestDocument.create({
        data: { tenantId, requestId: id, documentTypeKey: input.documentTypeKey, label: input.label, labelAr: input.labelAr ?? null, kind: input.kind, isMandatory: input.isMandatory, sortOrder: (last?.sortOrder ?? 0) + 1 },
      });
      await this.audit.log({ action: 'request.checklist_item_added', resourceType: 'RequestDocument', resourceId: line.id, summary: `${request.requestNo}: "${input.label}" added to the checklist`, after: input }, tx);
      await this.engine.advance(tx, id);
      return this.views.detail(tx, await this.machine.lock(tx, id));
    });
  }

  private async line(tx: Tx, requestId: string, itemId: string) {
    return found(await tx.requestDocument.findFirst({ where: { id: itemId, requestId, tenantId: this.db.tenantId } }), 'Checklist item');
  }

  async waiveChecklistItem(id: string, itemId: string, reason: string) {
    return this.db.tx(async (tx) => {
      const request = await this.open(tx, id);
      this.assertNotClosed(request);
      this.requirePermission('document.verify');
      const line = await this.line(tx, id, itemId);
      if (line.status === 'WAIVED') throw Errors.conflict('ALREADY_WAIVED', 'This document has already been waived.');
      await tx.requestDocument.update({ where: { id: itemId }, data: { status: 'WAIVED', rejectionReason: reason, reviewedById: ctx().userId ?? null, reviewedAt: this.clock.now() } });
      await this.audit.log({ action: 'request.checklist_item_waived', resourceType: 'RequestDocument', resourceId: itemId, summary: `${request.requestNo}: "${line.label}" waived`, before: { status: line.status }, after: { status: 'WAIVED', reason } }, tx);
      await this.engine.advance(tx, id);
      return this.views.detail(tx, await this.machine.lock(tx, id));
    });
  }

  /** Who may change which checklist line right now. */
  private assertLineEditable(request: ServiceRequest, line: { kind: string; status: string }): void {
    this.assertNotClosed(request);
    if (isExternalActor()) {
      if (line.kind !== 'INPUT') throw Errors.forbidden('FORBIDDEN', 'Completed documents are added by the centre.');
      if (!CUSTOMER_UPLOADABLE.includes(request.status)) throw Errors.conflict('REQUEST_NOT_EDITABLE', 'This request is already being processed. Ask the centre if a document has to be replaced.');
      if (line.status === 'VERIFIED' || line.status === 'WAIVED') throw Errors.conflict('DOCUMENT_ALREADY_ACCEPTED', 'This document has already been accepted and cannot be replaced online.');
    } else if (line.kind === 'COMPLETION') {
      this.requirePermission('request.process');
    } else {
      this.requirePermission('request.update', 'request.process', 'document.verify', 'request.create');
    }
  }

  /** Link an existing document (reuse, or a completed document) to a checklist line. */
  async linkDocument(id: string, itemId: string, documentId: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const request = await this.open(tx, id);
      const line = await this.line(tx, id, itemId);
      this.assertLineEditable(request, line);
      const now = this.clock.now();
      // Only documents of the same customer, of the request's company, or attached to this very request.
      const document = found(
        await tx.document.findFirst({
          where: {
            id: documentId, tenantId, deletedAt: null,
            OR: [{ customerId: request.customerId }, { requestId: id }, ...(request.corporateAccountId ? [{ corporateAccountId: request.corporateAccountId }] : [])],
          },
          select: { id: true, title: true, status: true, verificationStatus: true, expiryDate: true },
        }),
        'Document',
      );
      if (document.status !== 'AVAILABLE') throw Errors.unprocessable('DOCUMENT_NOT_AVAILABLE', 'This document is not available yet (it is still being checked, or was removed).');
      if (document.verificationStatus === 'REJECTED') throw Errors.unprocessable('DOCUMENT_REJECTED', 'This document was rejected and cannot be used. Upload a new one.');
      if (document.expiryDate && document.expiryDate < new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))) {
        throw Errors.unprocessable('DOCUMENT_EXPIRED', 'This document has expired. Upload the renewed document.');
      }
      const status = line.kind === 'INPUT' && document.verificationStatus === 'VERIFIED' ? 'VERIFIED' : 'UPLOADED';
      await tx.requestDocument.update({ where: { id: itemId }, data: { documentId: document.id, status, rejectionReason: null, reviewedById: null, reviewedAt: null } });
      await this.audit.log({ action: 'request.checklist_document_linked', resourceType: 'RequestDocument', resourceId: itemId, summary: `${request.requestNo}: "${document.title}" linked to "${line.label}"`, before: { documentId: line.documentId, status: line.status }, after: { documentId, status } }, tx);
      await this.engine.advance(tx, id);
      return this.views.detail(tx, await this.machine.lock(tx, id));
    });
  }

  async unlinkDocument(id: string, itemId: string) {
    return this.db.tx(async (tx) => {
      const request = await this.open(tx, id);
      const line = await this.line(tx, id, itemId);
      this.assertLineEditable(request, line);
      if (!line.documentId) return this.views.detail(tx, request);
      await tx.requestDocument.update({ where: { id: itemId }, data: { documentId: null, status: 'MISSING', rejectionReason: null, reviewedById: null, reviewedAt: null } });
      await this.audit.log({ action: 'request.checklist_document_unlinked', resourceType: 'RequestDocument', resourceId: itemId, summary: `${request.requestNo}: document removed from "${line.label}"`, before: { documentId: line.documentId, status: line.status }, after: { documentId: null, status: 'MISSING' } }, tx);
      await this.engine.advance(tx, id);
      return this.views.detail(tx, await this.machine.lock(tx, id));
    });
  }

  // ------------------------------------------------------------------ review approval
  async decideApproval(id: string, approvalId: string, input: DecideRequestApprovalBody) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const c = ctx();
      const request = await this.open(tx, id);
      const approval = found(await tx.requestApproval.findFirst({ where: { id: approvalId, requestId: id, tenantId } }), 'Approval');
      if (approval.type !== 'REVIEW') throw Errors.unprocessable('APPROVAL_TYPE_NOT_SUPPORTED', 'Only review approvals are decided here.');
      if (approval.status !== 'PENDING') throw Errors.conflict('ALREADY_DECIDED', `This review was already ${approval.status.toLowerCase()}.`);
      if (request.status !== 'PENDING_APPROVAL') throw Errors.conflict('INVALID_TRANSITION', `The request is not waiting for review (it is ${REQUEST_STATUS_META[request.status].en.toLowerCase()}).`, { from: request.status });
      // Segregation of duties: the person who prepared the case never approves it.
      if (request.assignedToId && c.userId) {
        const operator = await tx.tenantMembership.findFirst({ where: { id: request.assignedToId, tenantId }, select: { userId: true } });
        if (operator?.userId === c.userId) {
          throw guardError({ status: 403, code: 'SEGREGATION_OF_DUTIES', message: 'You prepared this case, so you cannot review it yourself. Another reviewer must decide.' });
        }
      }
      await tx.requestApproval.update({ where: { id: approvalId }, data: { status: input.decision, decidedById: c.userId ?? null, decidedAt: this.clock.now(), comment: input.comment ?? null } });
      await this.audit.log(
        { action: input.decision === 'APPROVED' ? 'request.review_approved' : 'request.review_rejected', resourceType: 'RequestApproval', resourceId: approvalId, summary: `${request.requestNo}: review ${input.decision.toLowerCase()}`, before: { status: 'PENDING' }, after: { status: input.decision, comment: input.comment ?? null } },
        tx,
      );
      const result =
        input.decision === 'APPROVED'
          ? await this.machine.transition(tx, id, 'READY_TO_SUBMIT', { actor: AS_CONTEXT, meta: { approvalId } })
          : // The reviewer's comment is the internal reason; the customer only sees that the case is still being prepared.
            await this.machine.transition(tx, id, 'IN_PREPARATION', { actor: AS_CONTEXT, reason: input.comment ?? null, customerVisible: false, meta: { approvalId } });
      return this.views.detail(tx, result.request);
    });
  }

  // ------------------------------------------------------------------ closing, reopening, duplicates
  private async move(id: string, to: RequestStatus, reason: string | null, meta?: Record<string, unknown>) {
    return this.db.tx(async (tx) => {
      const result = await this.machine.transition(tx, id, to, { actor: AS_CONTEXT, reason, meta });
      return this.views.detail(tx, result.request);
    });
  }
  complete(id: string) {
    return this.move(id, 'COMPLETED', null);
  }
  cancel(id: string, reason: string) {
    return this.move(id, 'CANCELLED', reason);
  }
  reopen(id: string, reason: string) {
    return this.move(id, 'IN_PREPARATION', reason, { reopened: true });
  }

  async markDuplicate(id: string, duplicateOfId: string) {
    return this.db.tx(async (tx) => {
      if (id === duplicateOfId) throw Errors.unprocessable('SAME_REQUEST', 'A request cannot be a duplicate of itself.');
      await this.open(tx, id);
      const original = await this.access.load(tx, duplicateOfId);
      if (original.duplicateOfId === id) throw Errors.unprocessable('CIRCULAR_DUPLICATE', `${original.requestNo} is already marked as a duplicate of this request.`);
      const result = await this.machine.transition(tx, id, 'CANCELLED', {
        actor: AS_CONTEXT,
        reason: `Duplicate of ${original.requestNo}`,
        customerMessage: `This request was a duplicate of ${original.requestNo} and has been closed.`,
        meta: { duplicateOfId },
        set: { duplicateOfId },
      });
      await this.audit.log({ action: 'request.marked_duplicate', resourceType: 'ServiceRequest', resourceId: id, summary: `${result.request.requestNo} marked as duplicate of ${original.requestNo}`, after: { duplicateOfId } }, tx);
      return this.views.detail(tx, result.request);
    });
  }

  // ------------------------------------------------------------------ comments
  async listComments(id: string) {
    return this.db.tx(async (tx) => {
      const request = await this.access.load(tx, id);
      const c = ctx();
      const internal = !isExternalActor(c) && (c.actorType === 'SYSTEM' || c.permissions.has('request.comment.internal'));
      const rows = await tx.requestComment.findMany({
        where: { tenantId: this.db.tenantId, requestId: request.id, ...(internal ? {} : { visibility: 'CUSTOMER' }) },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      return rows.map((m) => ({ id: m.id, ...presentAuthor(m, isExternalActor(c)), body: m.body, visibility: m.visibility, createdAt: m.createdAt }));
    });
  }

  async addComment(id: string, input: RequestCommentBody) {
    return this.db.tx(async (tx) => {
      const request = await this.access.load(tx, id);
      const c = ctx();
      const external = isExternalActor(c);
      // Customers can only ever write customer-visible comments; a wrong default must not hide their message.
      const visibility = external ? 'CUSTOMER' : input.visibility;
      if (!external) {
        if (visibility === 'INTERNAL') this.requirePermission('request.comment.internal');
        else this.requirePermission('request.update', 'request.process', 'request.review');
      }
      const comment = await tx.requestComment.create({
        data: { tenantId: this.db.tenantId, requestId: request.id, authorId: c.userId ?? null, authorType: c.actorType, authorName: c.actorLabel ?? null, body: input.body, visibility, createdAt: this.clock.now() },
      });
      await this.audit.log({ action: 'request.comment_added', resourceType: 'RequestComment', resourceId: comment.id, summary: `${request.requestNo}: ${visibility === 'INTERNAL' ? 'internal note' : 'comment'} added`, after: { visibility } }, tx);
      return { id: comment.id, ...presentAuthor(comment, external), body: comment.body, visibility: comment.visibility, createdAt: comment.createdAt };
    });
  }

  // ------------------------------------------------------------------ workflow
  async completeStep(id: string, input: CompleteWorkflowStepBody) {
    return this.db.tx(async (tx) => {
      const request = await this.open(tx, id);
      await this.engine.completeStaffTask(tx, request, { stepKey: input.stepKey, note: input.note ?? null });
      return this.views.detail(tx, await this.machine.lock(tx, id));
    });
  }

  async migrateWorkflow(id: string) {
    return this.db.tx(async (tx) => {
      const request = await this.open(tx, id);
      const migration = await this.engine.migrate(tx, request);
      return { ...(await this.views.detail(tx, await this.machine.lock(tx, id))), migration };
    });
  }
}
