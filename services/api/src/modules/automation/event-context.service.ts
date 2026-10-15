import { Injectable } from '@nestjs/common';
import { REQUEST_STATUS_META } from '@typease/types';
import type { RequestStatus } from '@typease/types';
import type { ServiceRequest } from '@typease/database';
import { env } from '../../config/env';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import type { TemplateData } from '../notifications/render';
import { RequestReader } from '../requests/request-reader.service';
import { TenantResolver } from '../tenancy/tenant-resolver.service';
import type { Facts } from '../workflows/rule-evaluator';

export interface AutomationEvent {
  id: string;
  type: string;
  payload: Record<string, any>;
  createdAt: Date;
}

/** Everything a rule can know about one event: loaded once per evaluation and once per action. */
export interface EventContext {
  event: AutomationEvent;
  tenant: { id: string; slug: string; name: string; timezone: string };
  request: ServiceRequest | null;
  customerId: string | null;
  corporateAccountId: string | null;
  branchId: string | null;
  assignee: { membershipId: string; userId: string; name: string; roleKey: string } | null;
  document: { id: string | null; typeKey: string; typeName: string; expiryDate: string | null } | null;
  facts: Facts;
  variables: TemplateData;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v) ? v : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const number = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const centre = (path: string) => `${env().CENTRE_WEB_URL.replace(/\/+$/, '')}${path}`;

function localParts(at: Date, timeZone: string): { date: string; time: string } {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return { date: `${get('day')} ${get('month')} ${get('year')}`, time: `${get('hour')}:${get('minute')}` };
  } catch {
    return { date: at.toISOString().slice(0, 10), time: at.toISOString().slice(11, 16) };
  }
}

/**
 * Turns a domain event into facts (for conditions) and variables (for texts).
 * Reads only: rows of the current tenant, through the caller's transaction.
 */
@Injectable()
export class EventContextService {
  constructor(
    private readonly db: TenantDb,
    private readonly reader: RequestReader,
    private readonly resolver: TenantResolver,
  ) {}

  async load(tx: Tx, event: AutomationEvent): Promise<EventContext> {
    const tenantId = this.db.tenantId;
    const p = (event.payload ?? {}) as Record<string, any>;
    const tenant = await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { id: true, slug: true, name: true, timezone: true, contactEmail: true, contactPhone: true } });

    const appointmentId = event.type === 'appointment.created' ? uuid(p.appointmentId) : null;
    const appointment = appointmentId
      ? await tx.appointment.findFirst({ where: { id: appointmentId, tenantId }, select: { id: true, branchId: true, customerId: true, serviceId: true, requestId: true, startsAt: true } })
      : null;

    const requestIds = Array.isArray(p.requestIds) ? p.requestIds.map(uuid).filter((v): v is string => !!v) : [];
    // A payment spread over several requests has no single "request of the event".
    const requestId = uuid(p.requestId) ?? (requestIds.length === 1 ? requestIds[0] : null) ?? appointment?.requestId ?? null;
    const request = requestId ? await tx.serviceRequest.findFirst({ where: { id: requestId, tenantId, deletedAt: null } }) : null;

    const customerId = uuid(p.customerId) ?? request?.customerId ?? appointment?.customerId ?? null;
    const customer = customerId
      ? await tx.customer.findFirst({ where: { id: customerId, tenantId }, select: { id: true, fullName: true, type: true, corporateAccountId: true } })
      : null;
    const corporateAccountId = uuid(p.corporateAccountId) ?? request?.corporateAccountId ?? customer?.corporateAccountId ?? null;

    const branchId = request?.branchId ?? appointment?.branchId ?? uuid(p.branchId);
    const branch = branchId ? await tx.branch.findFirst({ where: { id: branchId, tenantId }, select: { id: true, code: true, name: true, timezone: true } }) : null;

    const snapshot = request ? await this.reader.snapshot(tx, request) : null;
    const member = request?.assignedToId
      ? await tx.tenantMembership.findFirst({ where: { id: request.assignedToId, tenantId }, select: { id: true, userId: true, user: { select: { fullName: true } }, role: { select: { key: true } } } })
      : null;
    const assignee = member ? { membershipId: member.id, userId: member.userId, name: member.user.fullName, roleKey: member.role.key } : null;

    // ---- document (uploaded / verified / expiring)
    let document: EventContext['document'] = null;
    const documentId = uuid(p.documentId);
    const typeKey = text(p.documentTypeKey);
    if (documentId || typeKey) {
      const row = documentId ? await tx.document.findFirst({ where: { id: documentId, tenantId }, select: { id: true, documentTypeKey: true, expiryDate: true } }) : null;
      const key = typeKey ?? row?.documentTypeKey ?? 'other';
      const types = await tx.documentType.findMany({ where: { key, OR: [{ tenantId }, { tenantId: null }] }, select: { tenantId: true, name: true } });
      const type = types.find((t) => t.tenantId !== null) ?? types[0];
      const expiry = text(p.expiryDate)?.slice(0, 10) ?? ymd(row?.expiryDate);
      document = { id: row?.id ?? null, typeKey: key, typeName: type?.name ?? key, expiryDate: expiry && /^\d{4}-\d{2}-\d{2}$/.test(expiry) ? expiry : null };
    }

    const quotationId = uuid(p.quotationId);
    const quotation = quotationId ? await tx.quotation.findFirst({ where: { id: quotationId, tenantId }, select: { total: true, currency: true } }) : null;
    const appointmentService = !request && appointment?.serviceId ? await tx.service.findFirst({ where: { id: appointment.serviceId, tenantId }, select: { name: true } }) : null;

    // ---- facts
    const now = Date.now();
    const facts: Facts = {
      'event.type': event.type,
      'event.actorType': text(p._actor?.type) ?? 'SYSTEM',
      'customer.type': customer?.type ?? null,
      'customer.isCorporate': customer ? !!corporateAccountId : null,
      'branch.code': branch?.code ?? null,
    };
    if (event.type === 'customer.created') facts['customer.source'] = text(p.source);
    if (request && snapshot) {
      Object.assign(facts, {
        'request.status': request.status,
        'request.priority': request.priority,
        'request.source': request.source,
        'request.paymentStatus': request.paymentStatus,
        'request.isAssigned': !!request.assignedToId,
        'request.isOverdue': !!request.targetDate && request.targetDate.getTime() < now && !['COMPLETED', 'CANCELLED'].includes(request.status),
        'service.code': snapshot.code,
        'service.categoryKey': snapshot.categoryKey,
        'service.requiresApproval': snapshot.requiresApproval,
        'service.complianceCapability': snapshot.complianceCapability,
        'service.paymentPolicy': snapshot.paymentPolicy,
        'assignee.roleKey': assignee?.roleKey ?? null,
      });
    }
    switch (event.type) {
      case 'request.status_changed':
        Object.assign(facts, { 'status.from': text(p.from), 'status.to': text(p.to), 'status.customerVisible': p.customerVisible === true });
        break;
      case 'request.assigned':
        Object.assign(facts, { 'assignment.role': text(p.role), 'assignment.method': text(p.method) });
        break;
      case 'request.step_overdue':
        Object.assign(facts, { 'step.key': text(p.stepKey), 'step.escalateToRoleKey': text(p.escalateToRoleKey) });
        break;
      case 'document.uploaded':
      case 'document.verified':
        Object.assign(facts, { 'document.typeKey': document?.typeKey ?? null, 'document.uploadedByType': text(p.uploadedByType), 'document.generated': p.generated === true, 'document.hasExpiry': !!document?.expiryDate });
        break;
      case 'document.expiring':
        Object.assign(facts, { 'document.typeKey': document?.typeKey ?? null, 'expiry.daysLeft': number(p.daysLeft), 'expiry.offsetDays': number(p.offsetDays) });
        break;
      case 'quotation.approved':
        Object.assign(facts, { 'quotation.total': quotation ? Number(quotation.total) : null, 'quotation.approvedByType': text(p.approvedByType) });
        break;
      case 'payment.completed':
        Object.assign(facts, { 'payment.amount': number(p.amount), 'payment.method': text(p.method), 'payment.currency': text(p.currency) });
        break;
      case 'subscription.renewal_due':
        Object.assign(facts, { 'subscription.amount': number(p.amount), 'subscription.currency': text(p.currency), 'subscription.planKey': text(p.planKey) });
        break;
    }

    // ---- variables
    const centreLink = request
      ? centre(`/requests/${request.id}`)
      : event.type === 'subscription.renewal_due'
        ? centre('/settings/billing')
        : document?.id
          ? centre(`/documents/${document.id}`)
          : appointment
            ? centre('/appointments')
            : customer
              ? centre(`/customers/${customer.id}`)
              : centre('/');
    // In messages the notifications module replaces the three centre values with the branded ones.
    const variables: TemplateData = { centreLink, centreName: tenant.name, supportEmail: tenant.contactEmail ?? '', supportPhone: tenant.contactPhone ?? '' };
    if (customer) {
      variables.customerName = customer.fullName;
      variables.portalLink = await this.resolver.portalLink(tenantId, request ? `/requests/${request.id}` : '/');
    }
    if (request && snapshot) {
      Object.assign(variables, {
        requestNumber: request.requestNo,
        serviceName: snapshot.name,
        statusLabel: REQUEST_STATUS_META[request.status].en,
        assigneeName: assignee?.name ?? '',
        targetDate: ymd(request.targetDate) ?? '',
      });
    }
    if (branch) variables.branchName = branch.name;
    if (event.type === 'request.status_changed') variables.previousStatusLabel = REQUEST_STATUS_META[p.from as RequestStatus]?.en ?? '';
    if (event.type === 'request.step_overdue') variables.stepName = text(p.stepName) ?? text(p.stepKey) ?? '';
    if (document) {
      variables.documentName = document.typeName;
      variables.expiryDate = document.expiryDate ?? '';
    }
    if (event.type === 'document.expiring') variables.daysLeft = number(p.daysLeft) ?? '';
    if (event.type === 'payment.completed') Object.assign(variables, { amount: text(p.amount) ?? '', currency: text(p.currency) ?? '', paymentMethod: text(p.method) ?? '' });
    if (event.type === 'quotation.approved' && quotation) Object.assign(variables, { amount: quotation.total.toFixed(2), currency: quotation.currency });
    if (appointment) {
      const at = localParts(appointment.startsAt, branch?.timezone ?? tenant.timezone);
      Object.assign(variables, { appointmentDate: at.date, appointmentTime: at.time });
      if (appointmentService) variables.serviceName = appointmentService.name;
    }
    if (event.type === 'subscription.renewal_due') {
      const due = text(p.dueAt);
      Object.assign(variables, { amount: text(p.amount) ?? '', currency: text(p.currency) ?? '', planName: text(p.planName) ?? '', dueDate: due ? due.slice(0, 10) : '' });
    }

    return { event, tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, timezone: tenant.timezone }, request, customerId: customer?.id ?? null, corporateAccountId, branchId: branch?.id ?? null, assignee, document, facts, variables };
  }
}
