import { assertCustomerNotErased, customerRef } from '../../common/customer-ref';
import { Injectable } from '@nestjs/common';
import { OPEN_STATUSES, REQUEST_STATUS_META, STATUS_BUCKETS, TERMINAL_STATUSES } from '@typease/types';
import type { FormSchema, RequestStatus } from '@typease/types';
import type {
  CreateServiceRequestBody, RequestTransitionBody, SaveRequestFieldsBody, ServiceRequestCountsQuery, ServiceRequestListQuery, UpdateServiceRequestBody,
} from '@typease/validation';
import type { Prisma, ServiceRequest } from '@typease/database';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { DomainEvents } from '../../common/events.service';
import { Errors, found } from '../../common/errors';
import { pageArgs, pageResult } from '../../common/pagination';
import { assertBranchAccess, defaultBranchId } from '../../common/scope';
import { SequenceService } from '../../common/sequence.service';
import { Clock } from '../workflows/clock';
import { WorkflowsService } from '../workflows/workflows.service';
import { startOfLocalDay } from './assignment-ranking';
import { isEmptyValue, prefillValues, validateFormValues } from './form-validator';
import { isExternalActor, RequestAccess, requestActorKind } from './request-access';
import { RequestReader, snapshotOfService } from './request-reader.service';
import { AS_CONTEXT, RequestStateMachine } from './request-state-machine.service';
import { CUSTOMER_EDITABLE, externalStatusView, isOverdue, RequestViews, statusLabel } from './request-view.service';
import { StageLimitsService } from './stage-limits.service';
import { WorkflowEngine } from './workflow-engine.service';

const SORTABLE = ['createdAt', 'submittedAt', 'targetDate', 'completedAt', 'updatedAt', 'requestNo', 'priority'] as const;
const day = (isoDate: string, end = false) => new Date(`${isoDate}T${end ? '23:59:59.999' : '00:00:00.000'}Z`);

export interface ReuseCandidate {
  checklistItemId: string;
  documentId: string;
  documentTypeKey: string;
  title: string;
  expiryDate: Date | null;
  verifiedAt: Date | null;
  /** True when the document was linked automatically (the customer consented to document reuse). */
  linked: boolean;
}

@Injectable()
export class RequestsService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly sequences: SequenceService,
    private readonly clock: Clock,
    private readonly workflows: WorkflowsService,
    private readonly access: RequestAccess,
    private readonly reader: RequestReader,
    private readonly machine: RequestStateMachine,
    private readonly engine: WorkflowEngine,
    private readonly views: RequestViews,
  ) {}

  // =====================================================================================
  // Creation
  // =====================================================================================

  async create(input: CreateServiceRequestBody) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const c = ctx();
      const kind = requestActorKind(c);
      const external = isExternalActor(c);
      const now = this.clock.now();

      // ---- who the request is for -------------------------------------------------------
      let customerId: string;
      let corporateAccountId: string | null = null;
      let source: 'WALK_IN' | 'ONLINE' | 'MOBILE' | 'CORPORATE';
      if (kind === 'CORPORATE_ADMIN') {
        if (!c.permissions.has('corp.requests.create')) throw Errors.forbidden();
        corporateAccountId = c.corporateAccountId ?? null;
        if (!corporateAccountId) throw Errors.forbidden('NO_CORPORATE_ACCOUNT', 'Your account is not linked to a company.');
        source = 'CORPORATE';
        customerId = await this.corporateSubject(tx, corporateAccountId, input);
      } else if (kind === 'CORPORATE_EMPLOYEE') {
        // An employee who uses the company's portal raises a COMPANY request for themselves: the company's prices
        // and agreement apply, its administrators see it, approve its quotation and pay its invoice. The subject
        // is always the employee's own record - never a colleague, never the company.
        if (!c.permissions.has('self.requests')) throw Errors.forbidden();
        corporateAccountId = c.corporateAccountId ?? null;
        if (!corporateAccountId || !c.corporateEmployeeId) throw Errors.forbidden('NO_CORPORATE_ACCOUNT', 'Your account is not linked to an employee record of a company.');
        const self = await tx.corporateEmployee.findFirst({ where: { id: c.corporateEmployeeId, tenantId, corporateAccountId }, select: { id: true, customerId: true, status: true } });
        if (!self) throw Errors.forbidden('NO_CORPORATE_ACCOUNT', 'Your account is not linked to an employee record of a company.');
        if ((input.corporateEmployeeId && input.corporateEmployeeId !== self.id) || (input.customerId && input.customerId !== self.customerId)) {
          throw Errors.forbidden('EMPLOYEE_SELF_ONLY', 'You can create requests for yourself only. Ask your company administrator to create a request for somebody else.');
        }
        if (self.status !== 'ACTIVE') throw Errors.unprocessable('EMPLOYEE_NOT_ACTIVE', 'Your employee record is not active. Please contact your company administrator.');
        customerId = self.customerId;
        source = 'CORPORATE';
      } else if (external) {
        if (!c.permissions.has('self.requests')) throw Errors.forbidden();
        customerId = await this.access.selfCustomerId(tx, c);
        source = c.app === 'mobile' ? 'MOBILE' : 'ONLINE';
      } else {
        if (kind === 'STAFF' && !c.permissions.has('request.create')) throw Errors.forbidden();
        if (!input.customerId) throw Errors.unprocessable('CUSTOMER_REQUIRED', 'Choose the customer this request is for.');
        customerId = input.customerId;
        corporateAccountId = input.corporateAccountId ?? null;
        source = 'WALK_IN';
      }
      if (external && (input.priority !== undefined || input.targetDate !== undefined)) {
        throw Errors.forbidden('STAFF_ONLY_FIELD', 'Priority and target date are set by the centre.');
      }

      await assertCustomerNotErased(tx, tenantId, customerId);
      const customer = found(await tx.customer.findFirst({ where: { id: customerId, tenantId, deletedAt: null } }), 'Customer');
      if (customer.status !== 'ACTIVE') throw Errors.unprocessable('CUSTOMER_NOT_ACTIVE', 'This customer record is not active. Restore it before creating a request.');
      if (corporateAccountId) {
        const account = found(await tx.corporateAccount.findFirst({ where: { id: corporateAccountId, tenantId, deletedAt: null } }), 'Corporate account');
        if (account.status !== 'ACTIVE') throw Errors.unprocessable('CORPORATE_ACCOUNT_INACTIVE', 'This corporate account is not active, so requests cannot be created for it.');
        const belongs =
          customer.corporateAccountId === account.id ||
          !!(await tx.corporateEmployee.findFirst({ where: { tenantId, corporateAccountId: account.id, customerId: customer.id }, select: { id: true } }));
        if (!belongs) throw Errors.unprocessable('CUSTOMER_NOT_IN_COMPANY', 'This customer is not an employee or a record of that company.');
      }

      // ---- service and branch -----------------------------------------------------------
      const service = found(
        await tx.service.findFirst({ where: { id: input.serviceId, tenantId, deletedAt: null }, include: { category: { select: { key: true } }, serviceBranches: { select: { branchId: true } } } }),
        'Service',
      );
      if (!service.isActive) throw Errors.unprocessable('SERVICE_NOT_AVAILABLE', 'This service is not offered at the moment.');
      if (external && !service.onlineAvailable) throw Errors.unprocessable('SERVICE_NOT_ONLINE', 'This service can only be requested at the centre. Please visit or contact the centre.');

      const branches = await tx.branch.findMany({ where: { tenantId, isActive: true }, select: { id: true, isHeadOffice: true }, orderBy: [{ isHeadOffice: 'desc' }, { name: 'asc' }] });
      const offered = branches.filter((b) => service.allBranches || service.serviceBranches.some((sb) => sb.branchId === b.id));
      const branchId = input.branchId ?? (external ? offered[0]?.id : (defaultBranchId(c) ?? branches[0]?.id));
      if (!branchId || !branches.some((b) => b.id === branchId)) throw Errors.notFound('Branch');
      if (!external) assertBranchAccess(branchId, c);
      if (!offered.some((b) => b.id === branchId)) throw Errors.unprocessable('SERVICE_NOT_AT_BRANCH', 'This service is not offered at that branch. Choose another branch.');

      // ---- what the case is pinned to ---------------------------------------------------
      const form = await tx.serviceFormDefinition.findFirst({ where: { tenantId, serviceId: service.id, status: 'PUBLISHED' }, select: { id: true, schema: true } });
      const schema = (form?.schema ?? null) as FormSchema | null;
      const { versionId } = await this.workflows.resolvePublishedVersion(tx, service.workflowDefinitionId);

      let renewalOfDocumentId: string | null = null;
      if (input.renewalOfScheduleId) {
        const schedule = found(
          // An employee renews their own documents only; an administrator (or staff) may also renew the company's.
          await tx.reminderSchedule.findFirst({ where: { id: input.renewalOfScheduleId, tenantId, OR: [{ customerId }, ...(corporateAccountId && kind !== 'CORPORATE_EMPLOYEE' ? [{ corporateAccountId }] : [])] } }),
          'Reminder',
        );
        renewalOfDocumentId = schedule.documentId;
      }

      const tenant = await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { settings: true } });
      const prefix = String(((tenant.settings ?? {}) as Record<string, unknown>).requestNumberPrefix ?? '').trim();
      const sequenceNo = await this.sequences.next(tx, 'request');
      const requestNo = /^[A-Z0-9]{1,6}$/.test(prefix) ? sequenceNo.replace(/^[A-Z]+-/, `${prefix}-`) : sequenceNo;

      const request = await tx.serviceRequest.create({
        data: {
          tenantId, branchId, requestNo, customerId, corporateAccountId, serviceId: service.id,
          serviceSnapshot: snapshotOfService(service) as object,
          status: 'DRAFT',
          priority: input.priority ?? 'NORMAL',
          source,
          paymentStatus: 'UNPAID',
          customerInstructions: input.instructions ?? null,
          targetDate: input.targetDate ? new Date(input.targetDate) : null,
          formDefinitionId: form?.id ?? null,
          workflowVersionId: versionId,
          renewalOfDocumentId,
          createdById: c.userId ?? null,
          createdByType: c.actorType,
          createdAt: now,
        },
      });
      await this.machine.recordCreation(tx, request.id);
      if (input.renewalOfScheduleId) await tx.reminderSchedule.update({ where: { id: input.renewalOfScheduleId }, data: { renewalRequestId: request.id } });

      // ---- checklist from the service requirements ----------------------------------------
      const requirements = await tx.serviceRequirement.findMany({ where: { tenantId, serviceId: service.id }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
      if (requirements.length) {
        await tx.requestDocument.createMany({
          data: requirements.map((r, i) => ({ tenantId, requestId: request.id, requirementId: r.id, documentTypeKey: r.documentTypeKey, label: r.label, labelAr: r.labelAr, kind: 'INPUT', isMandatory: r.isMandatory, sortOrder: r.sortOrder || i })),
        });
      }

      // ---- prefill from the customer profile, then the values the caller sent --------------
      const prefilled = prefillValues(schema, customer as unknown as Record<string, unknown>);
      const prefillKeys = Object.keys(prefilled);
      if (prefillKeys.length) {
        await tx.requestField.createMany({ data: prefillKeys.map((key) => ({ tenantId, requestId: request.id, key, value: prefilled[key] as Prisma.InputJsonValue, source: 'PREFILL' })) });
      }
      if (input.fields && Object.keys(input.fields).length) await this.writeFields(tx, request, schema, input.fields, external ? 'CUSTOMER' : 'STAFF');

      const reuseCandidates = await this.offerReuse(tx, request, requirements);

      await this.audit.log(
        { action: 'request.created', resourceType: 'ServiceRequest', resourceId: request.id, summary: `${requestNo} created for ${customer.fullName}`, after: { requestNo, customerId, serviceId: service.id, branchId, source, corporateAccountId, priority: request.priority } },
        tx,
      );
      await this.events.emit(tx, 'request.created', { requestId: request.id, requestNo, customerId, serviceId: service.id, branchId, source });
      return { ...(await this.views.detail(tx, request)), reuseCandidates };
    });
  }

  /** Corporate admins create for an employee, for a record of the company, or for the company itself. */
  private async corporateSubject(tx: Tx, corporateAccountId: string, input: CreateServiceRequestBody): Promise<string> {
    const tenantId = this.db.tenantId;
    if (input.corporateEmployeeId) {
      const employee = found(await tx.corporateEmployee.findFirst({ where: { id: input.corporateEmployeeId, tenantId, corporateAccountId } }), 'Employee');
      if (employee.status !== 'ACTIVE') throw Errors.unprocessable('EMPLOYEE_NOT_ACTIVE', 'This employee record is not active.');
      return employee.customerId;
    }
    if (input.customerId) {
      const customer = await tx.customer.findFirst({
        where: { id: input.customerId, tenantId, deletedAt: null, OR: [{ corporateAccountId }, { corporateEmployees: { some: { corporateAccountId } } }] },
        select: { id: true },
      });
      return found(customer, 'Customer').id;
    }
    const company = await tx.customer.findFirst({ where: { tenantId, corporateAccountId, type: 'BUSINESS', status: 'ACTIVE', deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    if (!company) throw Errors.unprocessable('COMPANY_PROFILE_MISSING', 'Your company does not have a customer profile yet. Ask the centre to complete the company profile, or choose an employee.');
    return company.id;
  }

  /**
   * "Do not ask for the same document twice": for every checklist line whose
   * requirement allows reuse, the customer's newest valid document of that type
   * is offered. It is linked automatically only when the customer has granted
   * the DOCUMENT_REUSE consent; otherwise somebody links it explicitly.
   */
  private async offerReuse(tx: Tx, request: ServiceRequest, requirements: Array<{ id: string; documentTypeKey: string; allowReuse: boolean; maxAgeDays: number | null }>): Promise<ReuseCandidate[]> {
    const tenantId = this.db.tenantId;
    const reusable = requirements.filter((r) => r.allowReuse);
    if (!reusable.length) return [];
    const now = this.clock.now();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const consent = await tx.customerConsent.findFirst({ where: { tenantId, customerId: request.customerId, purpose: 'DOCUMENT_REUSE' }, select: { status: true } });
    const autoLink = consent?.status === 'GRANTED';
    const lines = await tx.requestDocument.findMany({ where: { tenantId, requestId: request.id, kind: 'INPUT' } });
    const out: ReuseCandidate[] = [];
    for (const requirement of reusable) {
      const line = lines.find((l) => l.requirementId === requirement.id);
      if (!line) continue;
      const document = await tx.document.findFirst({
        where: {
          tenantId,
          documentTypeKey: requirement.documentTypeKey,
          status: 'AVAILABLE',
          verificationStatus: 'VERIFIED',
          deletedAt: null,
          isCompletionDocument: false,
          AND: [
            { OR: [{ customerId: request.customerId }, ...(request.corporateAccountId ? [{ corporateAccountId: request.corporateAccountId, customerId: null }] : [])] },
            { OR: [{ expiryDate: null }, { expiryDate: { gte: today } }] },
            ...(requirement.maxAgeDays ? [{ createdAt: { gte: new Date(now.getTime() - requirement.maxAgeDays * 86_400_000) } }] : []),
          ],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, title: true, documentTypeKey: true, expiryDate: true, verifiedAt: true },
      });
      if (!document) continue;
      if (autoLink) await tx.requestDocument.update({ where: { id: line.id }, data: { documentId: document.id, status: 'VERIFIED', reviewedAt: document.verifiedAt } });
      out.push({ checklistItemId: line.id, documentId: document.id, documentTypeKey: document.documentTypeKey, title: document.title, expiryDate: document.expiryDate, verifiedAt: document.verifiedAt, linked: autoLink });
    }
    return out;
  }

  // =====================================================================================
  // Drafts: details and form values
  // =====================================================================================

  async update(id: string, input: UpdateServiceRequestBody) {
    return this.db.tx(async (tx) => {
      await this.access.assertVisible(tx, id);
      const before = await this.machine.lock(tx, id);
      const c = ctx();
      const external = isExternalActor(c);
      if (input.version !== undefined && input.version !== before.version) {
        throw Errors.conflict('STALE_VERSION', 'This request was changed by someone else in the meantime. Reload it and try again.', { currentVersion: before.version });
      }
      if (external) {
        if (input.priority !== undefined || input.targetDate !== undefined) throw Errors.forbidden('STAFF_ONLY_FIELD', 'Priority and target date are set by the centre.');
        if (!CUSTOMER_EDITABLE.includes(before.status)) throw Errors.conflict('REQUEST_NOT_EDITABLE', 'This request is already being processed. Add a comment if something has to change.');
      } else {
        if (requestActorKind(c) === 'STAFF' && !c.permissions.has('request.update')) throw Errors.forbidden();
        if (TERMINAL_STATUSES.includes(before.status)) throw Errors.conflict('REQUEST_CLOSED', `This request is ${REQUEST_STATUS_META[before.status].en.toLowerCase()} and can no longer be changed.`);
      }
      const data: Prisma.ServiceRequestUncheckedUpdateInput = { version: { increment: 1 } };
      const changed: Record<string, unknown> = {};
      const was: Record<string, unknown> = {};
      if (input.instructions !== undefined && (input.instructions ?? null) !== before.customerInstructions) {
        data.customerInstructions = input.instructions ?? null;
        [was.customerInstructions, changed.customerInstructions] = [before.customerInstructions, input.instructions ?? null];
      }
      if (input.priority !== undefined && input.priority !== before.priority) {
        data.priority = input.priority;
        [was.priority, changed.priority] = [before.priority, input.priority];
      }
      if (input.targetDate !== undefined) {
        const target = input.targetDate ? new Date(input.targetDate) : null;
        if ((target?.getTime() ?? null) !== (before.targetDate?.getTime() ?? null)) {
          data.targetDate = target;
          [was.targetDate, changed.targetDate] = [before.targetDate, target];
        }
      }
      if (!Object.keys(changed).length) return this.views.detail(tx, before);
      const after = await tx.serviceRequest.update({ where: { id }, data });
      // Open workflow tasks follow the priority of their request.
      if (changed.priority) await tx.task.updateMany({ where: { tenantId: this.db.tenantId, requestId: id, source: 'WORKFLOW', status: { in: ['OPEN', 'IN_PROGRESS'] } }, data: { priority: after.priority } });
      await this.audit.log({ action: 'request.updated', resourceType: 'ServiceRequest', resourceId: id, summary: `${before.requestNo}: ${Object.keys(changed).join(', ')} changed`, before: was, after: changed }, tx);
      return this.views.detail(tx, after);
    });
  }

  /**
   * Saves form values. A draft may be incomplete (only what is sent is
   * checked); once the request is submitted the whole form must stay valid.
   */
  async saveFields(id: string, input: SaveRequestFieldsBody) {
    return this.db.tx(async (tx) => {
      await this.access.assertVisible(tx, id);
      const request = await this.machine.lock(tx, id);
      const c = ctx();
      const external = isExternalActor(c);
      if (external) {
        if (!CUSTOMER_EDITABLE.includes(request.status)) throw Errors.conflict('REQUEST_NOT_EDITABLE', 'This request is already being processed. Add a comment if something has to change.');
      } else {
        // Whoever may create a request may fill in its draft; after submission editing needs request.update / request.process.
        const allowed = request.status === 'DRAFT' ? ['request.update', 'request.process', 'request.create'] : ['request.update', 'request.process'];
        if (requestActorKind(c) === 'STAFF' && !allowed.some((p) => c.permissions.has(p))) throw Errors.forbidden();
        if (TERMINAL_STATUSES.includes(request.status)) throw Errors.conflict('REQUEST_CLOSED', `This request is ${REQUEST_STATUS_META[request.status].en.toLowerCase()} and can no longer be changed.`);
      }
      const schema = await this.reader.formSchema(tx, request.formDefinitionId);
      const keys = await this.writeFields(tx, request, schema, input.values, external ? 'CUSTOMER' : 'STAFF');
      const after = await tx.serviceRequest.update({ where: { id }, data: { version: { increment: 1 } } });
      // Field values can be personal data: the audit trail records which fields changed, not their content.
      await this.audit.log({ action: 'request.fields_saved', resourceType: 'ServiceRequest', resourceId: id, summary: `${request.requestNo}: ${keys.length} field(s) saved`, after: { fields: keys } }, tx);
      await this.engine.advance(tx, id);
      return this.views.detail(tx, after);
    });
  }

  private async writeFields(tx: Tx, request: ServiceRequest, schema: FormSchema | null, incoming: Record<string, unknown>, source: 'CUSTOMER' | 'STAFF'): Promise<string[]> {
    const tenantId = this.db.tenantId;
    const draft = request.status === 'DRAFT';
    const stored = await this.reader.fieldValues(tx, request.id);
    const merged: Record<string, unknown> = { ...stored };
    for (const [key, value] of Object.entries(incoming)) {
      if (isEmptyValue(value)) delete merged[key];
      else merged[key] = value;
    }
    const provided = Object.fromEntries(Object.entries(incoming).filter(([, v]) => !isEmptyValue(v)));
    const check = draft ? validateFormValues(schema, provided, { partial: true }) : validateFormValues(schema, merged);
    // Old values of fields that were removed from the form do not block an edit.
    const errors = check.errors.filter((e) => e.code !== 'UNKNOWN_FIELD' || e.field in incoming);
    if (errors.length) throw Errors.unprocessable('FORM_INVALID', `Please check the form: ${errors[0].message}`, errors);

    for (const key of Object.keys(incoming)) {
      if (isEmptyValue(incoming[key])) {
        await tx.requestField.deleteMany({ where: { tenantId, requestId: request.id, key } });
        continue;
      }
      // Values of fields that are currently hidden are not kept on a submitted request.
      if (!(key in check.values)) continue;
      const value = check.values[key] as Prisma.InputJsonValue;
      await tx.requestField.upsert({
        where: { requestId_key: { requestId: request.id, key } },
        create: { tenantId, requestId: request.id, key, value, source },
        update: { value, source, verified: false },
      });
    }
    return Object.keys(incoming);
  }

  // =====================================================================================
  // Status changes exposed directly
  // =====================================================================================

  async submit(id: string) {
    return this.db.tx(async (tx) => {
      const result = await this.machine.transition(tx, id, 'SUBMITTED', { actor: AS_CONTEXT });
      const view = await this.views.detail(tx, result.request);
      // The tracking code is shown exactly once; only its hash is stored.
      return result.trackingCode ? { ...view, trackingCode: result.trackingCode } : view;
    });
  }

  /** The generic transition endpoint: any listed edge, subject to permissions and guards. */
  async transition(id: string, input: RequestTransitionBody) {
    return this.db.tx(async (tx) => {
      const result = await this.machine.transition(tx, id, input.to as RequestStatus, {
        actor: AS_CONTEXT,
        reason: input.reason ?? null,
        customerMessage: input.customerMessage ?? null,
        expectedVersion: input.version,
      });
      const view = await this.views.detail(tx, result.request);
      return result.trackingCode ? { ...view, trackingCode: result.trackingCode } : view;
    });
  }

  // =====================================================================================
  // Reading
  // =====================================================================================

  async get(id: string) {
    return this.db.tx(async (tx) => this.views.detail(tx, await this.access.load(tx, id)));
  }

  private async filters(tx: Tx, query: ServiceRequestListQuery | ServiceRequestCountsQuery): Promise<Prisma.ServiceRequestWhereInput[]> {
    const tenantId = this.db.tenantId;
    const c = ctx();
    const and: Prisma.ServiceRequestWhereInput[] = [{ tenantId, deletedAt: null }, await this.access.scope(tx)];
    if (query.branchId) and.push({ branchId: query.branchId });
    const q = query as ServiceRequestListQuery;
    if (q.status?.length) and.push({ status: { in: q.status } });
    if (q.bucket) and.push(await this.bucketFilter(tx, q.bucket));
    if (q.assignedToId) and.push({ assignedToId: q.assignedToId === 'me' ? (c.membershipId ?? '00000000-0000-0000-0000-000000000000') : q.assignedToId });
    if (q.customerId) and.push({ customerId: q.customerId });
    if (q.corporateAccountId) and.push({ corporateAccountId: q.corporateAccountId });
    if (q.serviceId) and.push({ serviceId: q.serviceId });
    if (q.priority?.length) and.push({ priority: { in: q.priority } });
    if (q.source?.length) and.push({ source: { in: q.source } });
    const range = (from?: string, to?: string) => ({ ...(from ? { gte: day(from) } : {}), ...(to ? { lte: day(to, true) } : {}) });
    if (q.createdFrom || q.createdTo) and.push({ createdAt: range(q.createdFrom, q.createdTo) });
    if (q.submittedFrom || q.submittedTo) and.push({ submittedAt: range(q.submittedFrom, q.submittedTo) });
    if (q.completedFrom || q.completedTo) and.push({ completedAt: range(q.completedFrom, q.completedTo) });
    if (q.q) {
      const text = q.q.trim();
      and.push({
        OR: [
          { requestNo: { contains: text, mode: 'insensitive' } },
          { customer: { fullName: { contains: text, mode: 'insensitive' } } },
          { customer: { customerNo: { contains: text, mode: 'insensitive' } } },
          { requestExternalReferences: { some: { referenceNo: { contains: text, mode: 'insensitive' } } } },
        ],
      });
    }
    return and;
  }

  private async bucketFilter(tx: Tx, bucket: string): Promise<Prisma.ServiceRequestWhereInput> {
    const now = this.clock.now();
    if (bucket === 'overdue') return { status: { in: OPEN_STATUSES.filter((s) => s !== 'DRAFT') }, targetDate: { lt: now } };
    if (bucket === 'completedToday') {
      const tenant = await tx.tenant.findFirstOrThrow({ where: { id: this.db.tenantId }, select: { timezone: true } });
      return { status: 'COMPLETED', completedAt: { gte: startOfLocalDay(now, tenant.timezone) } };
    }
    return { status: { in: (STATUS_BUCKETS as Record<string, RequestStatus[]>)[bucket] ?? [] } };
  }

  async list(query: ServiceRequestListQuery) {
    return this.db.tx(async (tx) => {
      const where: Prisma.ServiceRequestWhereInput = { AND: await this.filters(tx, query) };
      const external = isExternalActor();
      const now = this.clock.now();
      const [rows, total] = await Promise.all([
        tx.serviceRequest.findMany({
          where,
          ...pageArgs(query, SORTABLE, 'createdAt:desc'),
          select: {
            id: true, requestNo: true, status: true, priority: true, source: true, paymentStatus: true, branchId: true, serviceId: true, serviceSnapshot: true,
            corporateAccountId: true, submittedAt: true, targetDate: true, completedAt: true, createdAt: true, updatedAt: true,
            externalStatus: true, externalStatusSource: true, externalStatusAt: true,
            customer: { select: { id: true, customerNo: true, fullName: true, status: true } },
            service: { select: { name: true, nameAr: true, code: true } },
            assignedTo: { select: { id: true, user: { select: { fullName: true } } } },
          },
        }),
        tx.serviceRequest.count({ where }),
      ]);
      const since = external ? new Map<string, Date>() : await StageLimitsService.statusSince(tx, rows);
      const data = rows.map(({ serviceSnapshot, service, assignedTo, customer, ...r }) => {
        const snapshot = (serviceSnapshot ?? {}) as { name?: string; nameAr?: string | null; code?: string };
        return {
          ...r,
          statusLabel: statusLabel(r.status, external),
          customer: customerRef(customer),
          customerName: customer.fullName,
          service: { id: r.serviceId, name: snapshot.name ?? service.name, nameAr: snapshot.nameAr ?? service.nameAr, code: snapshot.code ?? service.code },
          serviceName: snapshot.name ?? service.name,
          // Customers are told that somebody is working on the case, not who.
          assignee: external ? undefined : assignedTo ? { membershipId: assignedTo.id, name: assignedTo.user.fullName } : null,
          assigneeName: external ? undefined : (assignedTo?.user.fullName ?? null),
          overdue: isOverdue(r, now),
          /** Staff only: when the request entered its current status (board time limits). */
          statusSince: external ? undefined : since.get(r.id),
          externalStatus: externalStatusView(r.externalStatus, r.externalStatusSource, r.externalStatusAt),
          externalStatusSource: undefined,
          externalStatusAt: undefined,
        };
      });
      return pageResult(data, total, query);
    });
  }

  /** Dashboard widgets: one number per bucket, for exactly the requests the actor may see. */
  async counts(query: ServiceRequestCountsQuery) {
    return this.db.tx(async (tx) => {
      const base = await this.filters(tx, query);
      const byStatus = await tx.serviceRequest.groupBy({ by: ['status'], where: { AND: base }, _count: { _all: true } });
      const count = (statuses: RequestStatus[]) => byStatus.filter((r) => statuses.includes(r.status)).reduce((n, r) => n + r._count._all, 0);
      const [completedToday, overdue] = await Promise.all([
        tx.serviceRequest.count({ where: { AND: [...base, await this.bucketFilter(tx, 'completedToday')] } }),
        tx.serviceRequest.count({ where: { AND: [...base, await this.bucketFilter(tx, 'overdue')] } }),
      ]);
      const buckets = Object.fromEntries(Object.entries(STATUS_BUCKETS).map(([key, statuses]) => [key, count(statuses as RequestStatus[])]));
      return {
        buckets: { ...buckets, completedToday, overdue },
        byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
        open: count(OPEN_STATUSES.filter((s) => s !== 'DRAFT')),
        drafts: count(['DRAFT']),
      };
    });
  }
}
