import type { FormSchema, RequestStatus } from '@typease/types';
import { Actor, PASSWORD, TenantFixture, TestApp, uniq } from '../../../test/helpers';
import { DomainEvents } from '../../common/events.service';
import { hashPassword } from '../auth/auth.service';

/**
 * Test fixtures for the requests / workflows modules. Rows that belong to
 * other modules (catalogue, customers, corporate, documents, finance) are
 * created directly in the database, and their domain events are emitted the
 * way those modules do: inside a tenant transaction.
 */

export const SAMPLE_FORM: FormSchema = {
  steps: [
    {
      key: 'applicant',
      title: 'Applicant',
      fields: [
        { key: 'fullName', label: 'Full name', type: 'text', required: true, prefillFrom: 'customer.fullName' },
        { key: 'nationality', label: 'Nationality', type: 'country', prefillFrom: 'customer.nationality' },
        { key: 'purpose', label: 'Purpose', type: 'select', required: true, options: [{ value: 'work', label: 'Work' }, { value: 'family', label: 'Family' }] },
        { key: 'sponsor', label: 'Sponsor', type: 'text', required: true, showIf: { field: 'purpose', in: ['work'] } },
      ],
    },
  ],
};

export interface ServiceOptions {
  name?: string;
  complianceCapability?: 'DOCUMENT_PREPARATION_ONLY' | 'PARTNER_COORDINATION' | 'DIRECT_AUTHORISED' | 'INFORMATIONAL_ONLY';
  requiresApproval?: boolean;
  paymentPolicy?: 'BEFORE_PROCESSING' | 'AFTER_COMPLETION' | 'DEPOSIT';
  depositPercent?: number;
  estimatedProcessingHours?: number | null;
  onlineAvailable?: boolean;
  isActive?: boolean;
  allBranches?: boolean;
  branchIds?: string[];
  staffGroupRoleKey?: string;
  workflowDefinitionId?: string;
  form?: FormSchema | null;
  requirements?: Array<{ documentTypeKey: string; label: string; isMandatory?: boolean; allowReuse?: boolean; maxAgeDays?: number }>;
}

export async function createService(t: TestApp, tenant: TenantFixture, options: ServiceOptions = {}) {
  const category = await t.sys.serviceCategory.findFirstOrThrow({ where: { tenantId: tenant.id, key: 'visa' } });
  const code = `SVC-${uniq()}`.toUpperCase();
  const service = await t.sys.service.create({
    data: {
      tenantId: tenant.id,
      categoryId: category.id,
      code,
      name: options.name ?? `Residence visa ${code}`,
      nameAr: 'تأشيرة إقامة',
      complianceCapability: options.complianceCapability ?? 'DIRECT_AUTHORISED',
      requiresApproval: options.requiresApproval ?? true,
      paymentPolicy: options.paymentPolicy ?? 'BEFORE_PROCESSING',
      depositPercent: options.depositPercent ?? null,
      estimatedProcessingHours: options.estimatedProcessingHours === undefined ? 48 : options.estimatedProcessingHours,
      onlineAvailable: options.onlineAvailable ?? true,
      isActive: options.isActive ?? true,
      allBranches: options.allBranches ?? true,
      staffGroupRoleKey: options.staffGroupRoleKey ?? null,
      workflowDefinitionId: options.workflowDefinitionId ?? null,
    },
  });
  for (const branchId of options.branchIds ?? []) await t.sys.serviceBranch.create({ data: { tenantId: tenant.id, serviceId: service.id, branchId } });
  const requirements = options.requirements ?? [
    { documentTypeKey: 'passport', label: 'Passport copy' },
    { documentTypeKey: 'photo', label: 'Personal photo' },
  ];
  for (const [i, r] of requirements.entries()) {
    await t.sys.serviceRequirement.create({
      data: { tenantId: tenant.id, serviceId: service.id, documentTypeKey: r.documentTypeKey, label: r.label, isMandatory: r.isMandatory ?? true, allowReuse: r.allowReuse ?? true, maxAgeDays: r.maxAgeDays ?? null, sortOrder: i + 1 },
    });
  }
  const form = options.form === undefined ? SAMPLE_FORM : options.form;
  if (form) await t.sys.serviceFormDefinition.create({ data: { tenantId: tenant.id, serviceId: service.id, version: 1, status: 'PUBLISHED', schema: form as object, publishedAt: new Date() } });
  return service;
}

export async function createCustomer(t: TestApp, tenant: TenantFixture, data: { fullName?: string; nationality?: string; corporateAccountId?: string; type?: 'INDIVIDUAL' | 'BUSINESS'; status?: 'ACTIVE' | 'ARCHIVED' } = {}) {
  return t.sys.customer.create({
    data: {
      tenantId: tenant.id,
      customerNo: `CUS-${uniq()}`.toUpperCase(),
      fullName: data.fullName ?? `Customer ${uniq()}`,
      nationality: data.nationality ?? 'IN',
      type: data.type ?? 'INDIVIDUAL',
      status: data.status ?? 'ACTIVE',
      corporateAccountId: data.corporateAccountId ?? null,
    },
  });
}

export async function createCorporateAccount(t: TestApp, tenant: TenantFixture, data: { creditApproved?: boolean; status?: 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED' } = {}) {
  return t.sys.corporateAccount.create({
    data: { tenantId: tenant.id, accountNo: `CORP-${uniq()}`.toUpperCase(), companyName: `Company ${uniq()} LLC`, status: data.status ?? 'ACTIVE', creditApproved: data.creditApproved ?? false },
  });
}

/** A portal user of a company: corporate administrator, or an employee linked to their own customer record. */
export async function addCorporateUser(t: TestApp, tenant: TenantFixture, corporateAccountId: string, roleKey: 'corporate_admin' | 'corporate_employee', link: { customerId?: string; corporateEmployeeId?: string } = {}): Promise<Actor> {
  const email = `${roleKey}-${uniq()}@example.test`;
  const user = await t.sys.user.create({ data: { email, fullName: `${roleKey} ${uniq()}`, passwordHash: await hashPassword(PASSWORD), emailVerifiedAt: new Date() } });
  const role = await t.sys.role.findFirstOrThrow({ where: { tenantId: tenant.id, key: roleKey } });
  await t.sys.tenantMembership.create({
    data: { tenantId: tenant.id, userId: user.id, roleId: role.id, kind: 'CORPORATE', status: 'ACTIVE', allBranches: false, corporateAccountId, customerId: link.customerId ?? null, corporateEmployeeId: link.corporateEmployeeId ?? null, joinedAt: new Date() },
  });
  return t.login(email, PASSWORD, 'corporate', tenant.slug);
}

export async function createDocument(
  t: TestApp,
  tenant: TenantFixture,
  data: { customerId?: string | null; corporateAccountId?: string | null; requestId?: string | null; documentTypeKey: string; verified?: boolean; rejected?: boolean; expiryDate?: Date | null; isCompletionDocument?: boolean; createdAt?: Date; status?: 'AVAILABLE' | 'PENDING_SCAN' | 'QUARANTINED' },
) {
  return t.sys.document.create({
    data: {
      tenantId: tenant.id,
      customerId: data.customerId ?? null,
      corporateAccountId: data.corporateAccountId ?? null,
      requestId: data.requestId ?? null,
      documentTypeKey: data.documentTypeKey,
      title: `${data.documentTypeKey} ${uniq()}`,
      status: data.status ?? 'AVAILABLE',
      verificationStatus: data.rejected ? 'REJECTED' : data.verified ? 'VERIFIED' : 'UNVERIFIED',
      verifiedAt: data.verified ? new Date() : null,
      expiryDate: data.expiryDate ?? null,
      isCompletionDocument: data.isCompletionDocument ?? false,
      ...(data.createdAt ? { createdAt: data.createdAt } : {}),
    },
  });
}

/** Emit a domain event of another module, exactly as that module would: inside a tenant transaction. */
export function emit(t: TestApp, tenantId: string, type: Parameters<DomainEvents['emit']>[1], payload: Record<string, unknown>) {
  return t.inTenant(tenantId, () => t.db.tx((tx) => t.get(DomainEvents).emit(tx, type, payload)));
}

export const getRequest = (t: TestApp, id: string) => t.sys.serviceRequest.findUniqueOrThrow({ where: { id } });
export const statusOf = async (t: TestApp, id: string): Promise<RequestStatus> => (await getRequest(t, id)).status;
export const checklistOf = (t: TestApp, requestId: string) => t.sys.requestDocument.findMany({ where: { requestId }, orderBy: [{ kind: 'desc' }, { sortOrder: 'asc' }] });

/** Status history in the order it was written. */
export async function historyOf(t: TestApp, requestId: string) {
  const rows = await t.sys.requestStatusHistory.findMany({ where: { requestId } });
  return rows.sort((a, b) => Number((a.meta as any).seq) - Number((b.meta as any).seq));
}
export const pathOf = async (t: TestApp, requestId: string) => (await historyOf(t, requestId)).filter((h) => h.fromStatus !== h.toStatus).map((h) => h.toStatus);

/** Outbox events about one request, oldest first. */
export async function eventsOf(t: TestApp, tenantId: string, requestId: string, type?: string) {
  const rows = await t.sys.outboxEvent.findMany({ where: { tenantId, ...(type ? { type } : {}) }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  return rows.filter((r) => (r.payload as any)?.requestId === requestId).map((r) => ({ type: r.type, payload: r.payload as Record<string, any> }));
}
export const tasksOf = (t: TestApp, requestId: string) => t.sys.task.findMany({ where: { requestId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], include: { taskAssignments: true } });
export const openTasksOf = async (t: TestApp, requestId: string) => (await tasksOf(t, requestId)).filter((task) => task.status === 'OPEN' || task.status === 'IN_PROGRESS');

export async function stepsOf(t: TestApp, requestId: string) {
  const execution = await t.sys.workflowExecution.findUnique({ where: { requestId }, include: { workflowStepExecutions: { orderBy: [{ createdAt: 'asc' }, { attempt: 'asc' }] } } });
  return { execution, steps: execution?.workflowStepExecutions ?? [], current: execution?.currentStepKey ?? null, status: (key: string) => [...(execution?.workflowStepExecutions ?? [])].reverse().find((s) => s.stepKey === key)?.status ?? null };
}

/** The documents module: a customer uploads a document for a checklist line. */
export async function uploadFor(t: TestApp, tenant: TenantFixture, requestId: string, line: { id: string; documentTypeKey: string }, options: { withItemId?: boolean } = {}) {
  const request = await getRequest(t, requestId);
  const document = await createDocument(t, tenant, { customerId: request.customerId, requestId, documentTypeKey: line.documentTypeKey });
  await emit(t, tenant.id, 'document.uploaded', {
    documentId: document.id, versionId: document.id, customerId: request.customerId, requestId, documentTypeKey: line.documentTypeKey, uploadedByType: 'CUSTOMER',
    ...(options.withItemId === false ? {} : { checklistItemId: line.id }),
  });
  return document;
}
/** The documents module: staff verify a document. */
export async function verifyDocument(t: TestApp, tenant: TenantFixture, documentId: string, requestId?: string) {
  const document = await t.sys.document.update({ where: { id: documentId }, data: { verificationStatus: 'VERIFIED', verifiedAt: new Date() } });
  await emit(t, tenant.id, 'document.verified', { documentId, customerId: document.customerId, requestId, documentTypeKey: document.documentTypeKey });
}
export async function rejectDocument(t: TestApp, tenant: TenantFixture, documentId: string, reason: string, requestId?: string) {
  const document = await t.sys.document.update({ where: { id: documentId }, data: { verificationStatus: 'REJECTED' } });
  await emit(t, tenant.id, 'document.rejected', { documentId, customerId: document.customerId, requestId, documentTypeKey: document.documentTypeKey, reason });
}
/** Upload and verify every outstanding mandatory input document. */
export async function completeDocuments(t: TestApp, tenant: TenantFixture, requestId: string) {
  for (const line of await checklistOf(t, requestId)) {
    if (line.kind !== 'INPUT' || line.status === 'VERIFIED' || line.status === 'WAIVED') continue;
    const documentId = line.status === 'UPLOADED' && line.documentId ? line.documentId : (await uploadFor(t, tenant, requestId, line)).id;
    await verifyDocument(t, tenant, documentId, requestId);
  }
}

/** Finance: a quotation is sent to the customer. */
export async function sendQuotation(t: TestApp, tenant: TenantFixture, requestId: string, total = 500) {
  const request = await getRequest(t, requestId);
  const quotation = await t.sys.quotation.create({
    data: {
      tenantId: tenant.id, branchId: request.branchId, quotationNo: `QUO-${uniq()}`.toUpperCase(), requestId, customerId: request.customerId, corporateAccountId: request.corporateAccountId,
      status: 'SENT', subtotalServiceFee: total, total, sentAt: new Date(),
    },
  });
  await emit(t, tenant.id, 'quotation.sent', { quotationId: quotation.id, requestId, customerId: request.customerId, total: total.toFixed(2), currency: 'AED' });
  return quotation;
}
/** Finance: the quotation is approved and the invoice is issued in the same transaction. */
export async function approveQuotation(t: TestApp, tenant: TenantFixture, quotationId: string, options: { withInvoice?: boolean } = {}) {
  const quotation = await t.sys.quotation.update({ where: { id: quotationId }, data: { status: 'APPROVED', decidedAt: new Date(), decidedByType: 'CUSTOMER' } });
  const invoice =
    options.withInvoice === false
      ? null
      : await t.sys.invoice.create({
          data: {
            tenantId: tenant.id, branchId: quotation.branchId, invoiceNo: `INV-${uniq()}`.toUpperCase(), requestId: quotation.requestId, quotationId, customerId: quotation.customerId,
            corporateAccountId: quotation.corporateAccountId, status: 'ISSUED', subtotalServiceFee: quotation.total, total: quotation.total, balanceDue: quotation.total, issuedAt: new Date(),
          },
        });
  await emit(t, tenant.id, 'quotation.approved', { quotationId, requestId: quotation.requestId, customerId: quotation.customerId, approvedByType: 'CUSTOMER' });
  if (invoice) await emit(t, tenant.id, 'invoice.issued', { invoiceId: invoice.id, requestId: quotation.requestId, customerId: quotation.customerId, total: quotation.total.toFixed(2), currency: 'AED' });
  return { quotation, invoice };
}
export async function rejectQuotation(t: TestApp, tenant: TenantFixture, quotationId: string, reason = 'Too expensive') {
  const quotation = await t.sys.quotation.update({ where: { id: quotationId }, data: { status: 'REJECTED', decidedAt: new Date(), decidedByType: 'CUSTOMER', rejectionReason: reason } });
  await emit(t, tenant.id, 'quotation.rejected', { quotationId, requestId: quotation.requestId, customerId: quotation.customerId, reason });
}
/** Finance: a payment is completed and allocated to the invoice. */
export async function payInvoice(t: TestApp, tenant: TenantFixture, invoiceId: string, amount?: number) {
  const invoice = await t.sys.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  const paying = amount ?? Number(invoice.balanceDue);
  const paid = Number(invoice.amountPaid) + paying;
  const balance = Number(invoice.total) - Number(invoice.amountCredited) - paid + Number(invoice.amountRefunded);
  const payment = await t.sys.payment.create({
    data: { tenantId: tenant.id, branchId: invoice.branchId, paymentNo: `PAY-${uniq()}`.toUpperCase(), customerId: invoice.customerId, method: 'CASH', status: 'COMPLETED', amount: paying, receivedAt: new Date() },
  });
  await t.sys.paymentAllocation.create({ data: { tenantId: tenant.id, paymentId: payment.id, invoiceId, amount: paying } });
  await t.sys.invoice.update({ where: { id: invoiceId }, data: { amountPaid: paid, balanceDue: balance, status: balance <= 0 ? 'PAID' : 'PARTIALLY_PAID' } });
  await emit(t, tenant.id, 'payment.completed', { paymentId: payment.id, customerId: invoice.customerId, amount: paying.toFixed(2), currency: 'AED', method: 'CASH', invoiceIds: [invoiceId], requestIds: invoice.requestId ? [invoice.requestId] : [] });
  return payment;
}

/** Puts a request into a status without going through the state machine (to test what the machine refuses). */
export async function forceStatus(t: TestApp, requestId: string, status: RequestStatus, extra: Record<string, unknown> = {}) {
  await t.sys.serviceRequest.update({ where: { id: requestId }, data: { status, ...extra } });
}

/** A staff-created draft with a valid form. */
export async function draftRequest(t: TestApp, _tenant: TenantFixture, actor: Actor, serviceId: string, customerId: string, extra: Record<string, unknown> = {}) {
  const res = await t.as(actor).post('/requests', { serviceId, customerId, fields: { purpose: 'family' }, ...extra });
  if (res.status !== 201) throw new Error(`create request failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}
export async function submittedRequest(t: TestApp, tenant: TenantFixture, actor: Actor, serviceId: string, customerId: string, extra: Record<string, unknown> = {}) {
  const draft = await draftRequest(t, tenant, actor, serviceId, customerId, extra);
  const res = await t.as(actor).post(`/requests/${draft.id}/submit`);
  if (res.status !== 200) throw new Error(`submit failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/**
 * Drives a request to READY_FOR_PROCESSING through the standard workflow:
 * documents verified, quotation approved, invoice paid.
 */
export async function readyRequest(t: TestApp, tenant: TenantFixture, actor: Actor, serviceId: string, customerId: string, extra: Record<string, unknown> = {}) {
  const request = await submittedRequest(t, tenant, actor, serviceId, customerId, extra);
  await completeDocuments(t, tenant, request.id);
  const quotation = await sendQuotation(t, tenant, request.id);
  const { invoice } = await approveQuotation(t, tenant, quotation.id);
  if (invoice && (await statusOf(t, request.id)) === 'AWAITING_PAYMENT') await payInvoice(t, tenant, invoice.id);
  return { id: request.id as string, requestNo: request.requestNo as string, trackingCode: request.trackingCode as string, quotation, invoice };
}
