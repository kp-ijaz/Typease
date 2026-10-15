import { Injectable } from '@nestjs/common';
import { CAPABILITY_CHANNELS } from '@typease/types';
import type { ComplianceCapability, FormSchema, RequestStatus, SubmissionChannel, WorkflowStepType } from '@typease/types';
import type { RequestApproval, RequestDocument, RequestExternalReference, ServiceRequest } from '@typease/database';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { evaluateRule, Facts } from '../workflows/rule-evaluator';
import { WorkflowsService } from '../workflows/workflows.service';
import { paymentPosition, PaymentPosition, paymentRequirement, PaymentRequirement, PaymentStage } from './payment-policy';

/** Frozen copy of the service taken when the request was created. */
export interface ServiceSnapshot {
  name: string;
  nameAr: string | null;
  code: string;
  complianceCapability: ComplianceCapability;
  requiresApproval: boolean;
  paymentPolicy: string;
  depositPercent: string | null;
  taxMode: string;
  estimatedProcessingHours: number | null;
  categoryKey: string | null;
}

/** Outcomes of an external submission. Stored in the reference's status; only the result action may set them. */
export const EXTERNAL_RESULT_STATUSES = ['COMPLETED', 'RETURNED', 'REJECTED'] as const;
export type ExternalOutcome = (typeof EXTERNAL_RESULT_STATUSES)[number];
export const externalResultOf = (ref: { status: string | null } | null | undefined): ExternalOutcome | null =>
  ref?.status && (EXTERNAL_RESULT_STATUSES as readonly string[]).includes(ref.status) ? (ref.status as ExternalOutcome) : null;

export function permittedChannels(capability: string): readonly SubmissionChannel[] {
  return (CAPABILITY_CHANNELS as Record<string, readonly SubmissionChannel[]>)[capability] ?? [];
}

export interface ChecklistSummary {
  lines: RequestDocument[];
  /** Mandatory INPUT lines without a document that are not waived. */
  missing: RequestDocument[];
  /** INPUT lines whose document was rejected. */
  rejected: RequestDocument[];
  /** Mandatory INPUT lines that still wait for staff verification. */
  unverified: RequestDocument[];
  /** Every mandatory INPUT line has a document or is waived. */
  uploaded: boolean;
  /** Every mandatory INPUT line is VERIFIED or WAIVED and nothing is rejected. */
  verified: boolean;
  /** Mandatory COMPLETION lines without a document. */
  completionMissing: RequestDocument[];
}

export function summariseChecklist(lines: RequestDocument[]): ChecklistSummary {
  const input = lines.filter((l) => l.kind === 'INPUT');
  const mandatory = input.filter((l) => l.isMandatory);
  const missing = mandatory.filter((l) => l.status !== 'WAIVED' && !l.documentId);
  const rejected = input.filter((l) => l.status === 'REJECTED');
  const unverified = mandatory.filter((l) => l.status !== 'VERIFIED' && l.status !== 'WAIVED');
  const completionMissing = lines.filter((l) => l.kind === 'COMPLETION' && l.isMandatory && l.status !== 'WAIVED' && !l.documentId);
  return { lines, missing, rejected, unverified, uploaded: missing.length === 0, verified: unverified.length === 0 && rejected.length === 0, completionMissing };
}

/**
 * Read-side facts about one request, used by the state-machine guards, the
 * workflow engine and the API views. Everything is read inside the caller's
 * transaction, so guards always see the state they are about to change.
 * Tables of other modules (finance, corporate, documents) are only read here.
 */
@Injectable()
export class RequestReader {
  constructor(
    private readonly db: TenantDb,
    private readonly workflows: WorkflowsService,
  ) {}

  async snapshot(tx: Tx, request: Pick<ServiceRequest, 'serviceId' | 'serviceSnapshot'>): Promise<ServiceSnapshot> {
    const s = (request.serviceSnapshot ?? {}) as Partial<ServiceSnapshot>;
    if (s.complianceCapability && s.paymentPolicy && typeof s.requiresApproval === 'boolean') return { nameAr: null, depositPercent: null, estimatedProcessingHours: null, categoryKey: null, taxMode: 'SERVICE_FEE_ONLY', name: '', code: '', ...s } as ServiceSnapshot;
    // Rows created without a snapshot (imports, seeds) fall back to the live service.
    const service = await tx.service.findFirstOrThrow({ where: { id: request.serviceId, tenantId: this.db.tenantId }, include: { category: { select: { key: true } } } });
    return snapshotOfService(service);
  }

  async checklist(tx: Tx, requestId: string): Promise<ChecklistSummary> {
    const lines = await tx.requestDocument.findMany({ where: { tenantId: this.db.tenantId, requestId }, orderBy: [{ kind: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] });
    return summariseChecklist(lines);
  }

  async formSchema(tx: Tx, formDefinitionId: string | null): Promise<FormSchema | null> {
    if (!formDefinitionId) return null;
    const form = await tx.serviceFormDefinition.findFirst({ where: { id: formDefinitionId, tenantId: this.db.tenantId }, select: { schema: true } });
    return (form?.schema ?? null) as FormSchema | null;
  }

  async fieldValues(tx: Tx, requestId: string): Promise<Record<string, unknown>> {
    const rows = await tx.requestField.findMany({ where: { tenantId: this.db.tenantId, requestId }, select: { key: true, value: true } });
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  // ------------------------------------------------------------------ finance (read only)
  async position(tx: Tx, requestId: string): Promise<PaymentPosition> {
    const invoices = await tx.invoice.findMany({
      where: { tenantId: this.db.tenantId, requestId },
      select: { status: true, total: true, amountPaid: true, amountCredited: true, amountRefunded: true, balanceDue: true },
    });
    return paymentPosition(invoices);
  }

  /** The quotation that currently counts: the newest one that was actually sent. */
  async currentQuotation(tx: Tx, requestId: string) {
    return tx.quotation.findFirst({
      where: { tenantId: this.db.tenantId, requestId, status: { in: ['SENT', 'APPROVED', 'REJECTED', 'EXPIRED'] } },
      orderBy: [{ sentAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, quotationNo: true, status: true, total: true, currency: true, validUntil: true, sentAt: true, decidedAt: true, rejectionReason: true },
    });
  }

  /** Invoice on account: the request belongs to an ACTIVE corporate account with approved credit. */
  async corporateCredit(tx: Tx, request: Pick<ServiceRequest, 'corporateAccountId'>): Promise<boolean> {
    if (!request.corporateAccountId) return false;
    const account = await tx.corporateAccount.findFirst({ where: { id: request.corporateAccountId, tenantId: this.db.tenantId, deletedAt: null }, select: { status: true, creditApproved: true } });
    return !!account && account.status === 'ACTIVE' && account.creditApproved;
  }

  async payment(tx: Tx, request: Pick<ServiceRequest, 'id' | 'serviceId' | 'serviceSnapshot' | 'corporateAccountId'>, stage: PaymentStage): Promise<PaymentRequirement & { position: PaymentPosition }> {
    const [snapshot, position, quotation, corporateCredit] = await Promise.all([
      this.snapshot(tx, request),
      this.position(tx, request.id),
      this.currentQuotation(tx, request.id),
      this.corporateCredit(tx, request),
    ]);
    const requirement = paymentRequirement({
      policy: snapshot.paymentPolicy,
      depositPercent: snapshot.depositPercent,
      stage,
      position,
      corporateCredit,
      approvedQuotationTotal: quotation?.status === 'APPROVED' ? quotation.total : null,
    });
    return { ...requirement, position };
  }

  // ------------------------------------------------------------------ approvals and external processing
  /**
   * The review that currently counts. An approval stops counting as soon as
   * the case goes back to preparation (the state machine marks it superseded),
   * so a reworked application always needs a fresh review.
   */
  async review(tx: Tx, requestId: string): Promise<{ latest: RequestApproval | null; approved: RequestApproval | null }> {
    const latest = await tx.requestApproval.findFirst({ where: { tenantId: this.db.tenantId, requestId, type: 'REVIEW' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    const superseded = !!(latest?.payload as Record<string, unknown> | null)?.supersededAt;
    return { latest, approved: latest && latest.status === 'APPROVED' && !superseded ? latest : null };
  }

  /**
   * Where a request that waits for the customer returns to: preparation when
   * the question was asked during preparation (or after the application was
   * returned), document review otherwise. The origin is recorded in the history
   * entry that put the request into AWAITING_CUSTOMER.
   */
  async resumeTarget(tx: Tx, requestId: string): Promise<{ to: 'UNDER_REVIEW' | 'IN_PREPARATION'; origin: RequestStatus }> {
    const rows = await tx.requestStatusHistory.findMany({ where: { tenantId: this.db.tenantId, requestId, toStatus: 'AWAITING_CUSTOMER' }, select: { fromStatus: true, meta: true } });
    const asked = rows.filter((h) => h.fromStatus !== 'AWAITING_CUSTOMER').sort((a, b) => Number((b.meta as Record<string, unknown>)?.seq ?? 0) - Number((a.meta as Record<string, unknown>)?.seq ?? 0))[0];
    const origin = (((asked?.meta as Record<string, unknown> | undefined)?.origin as RequestStatus | undefined) ?? asked?.fromStatus ?? 'UNDER_REVIEW') as RequestStatus;
    return { to: origin === 'IN_PREPARATION' || origin === 'RETURNED' ? 'IN_PREPARATION' : 'UNDER_REVIEW', origin };
  }

  async latestExternalReference(tx: Tx, requestId: string): Promise<RequestExternalReference | null> {
    return tx.requestExternalReference.findFirst({ where: { tenantId: this.db.tenantId, requestId }, orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }] });
  }

  /** Does the workflow this case is pinned to contain a step of this type that applies to it? */
  async hasStep(tx: Tx, request: ServiceRequest, type: WorkflowStepType): Promise<boolean> {
    if (!request.workflowVersionId) return false;
    const steps = (await this.workflows.stepsOf(tx, request.workflowVersionId)).filter((s) => s.type === type);
    if (!steps.length) return false;
    if (steps.some((s) => !s.conditions)) return true;
    const facts = await this.facts(tx, request);
    return steps.some((s) => evaluateRule(s.conditions, facts));
  }

  /**
   * Must a reviewer approve the prepared application? Always when the service
   * says so (compliance: no workflow can switch this off), and also when the
   * centre added a review step to the workflow of this case.
   */
  async reviewRequired(tx: Tx, request: ServiceRequest): Promise<boolean> {
    if ((await this.snapshot(tx, request)).requiresApproval) return true;
    return this.hasStep(tx, request, 'INTERNAL_APPROVAL');
  }

  // ------------------------------------------------------------------ workflow facts
  /** The facts workflow rules can test (see WORKFLOW_FACTS). */
  async facts(tx: Tx, request: ServiceRequest): Promise<Facts> {
    const tenantId = this.db.tenantId;
    const [snapshot, branch, customer, checklist, quotation, review, assignee] = await Promise.all([
      this.snapshot(tx, request),
      tx.branch.findFirst({ where: { id: request.branchId, tenantId }, select: { code: true } }),
      tx.customer.findFirst({ where: { id: request.customerId, tenantId }, select: { type: true } }),
      this.checklist(tx, request.id),
      this.currentQuotation(tx, request.id),
      this.review(tx, request.id),
      request.assignedToId ? tx.tenantMembership.findFirst({ where: { id: request.assignedToId, tenantId }, select: { role: { select: { key: true } } } }) : null,
    ]);
    return {
      'service.code': snapshot.code,
      'service.categoryKey': snapshot.categoryKey,
      'service.requiresApproval': snapshot.requiresApproval,
      'service.complianceCapability': snapshot.complianceCapability,
      'service.paymentPolicy': snapshot.paymentPolicy,
      'branch.code': branch?.code ?? null,
      'customer.type': customer?.type ?? null,
      'customer.isCorporate': !!request.corporateAccountId,
      'request.priority': request.priority,
      'request.source': request.source,
      'documents.complete': checklist.verified,
      'payment.status': request.paymentStatus,
      'quotation.total': quotation && ['SENT', 'APPROVED'].includes(quotation.status) ? Number(quotation.total) : null,
      'assignee.roleKey': assignee?.role.key ?? null,
      'approval.result': review.latest?.status ?? null,
    };
  }
}

export function snapshotOfService(service: {
  name: string; nameAr: string | null; code: string; complianceCapability: ComplianceCapability; requiresApproval: boolean; paymentPolicy: string;
  depositPercent: { toString(): string } | null; taxMode: string; estimatedProcessingHours: number | null; category?: { key: string } | null;
}): ServiceSnapshot {
  return {
    name: service.name,
    nameAr: service.nameAr,
    code: service.code,
    complianceCapability: service.complianceCapability,
    requiresApproval: service.requiresApproval,
    paymentPolicy: service.paymentPolicy,
    depositPercent: service.depositPercent ? service.depositPercent.toString() : null,
    taxMode: service.taxMode,
    estimatedProcessingHours: service.estimatedProcessingHours,
    categoryKey: service.category?.key ?? null,
  };
}
