import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DomainEventType, REQUEST_STATUS_META } from '@typease/types';
import { SUPPORT_WRITE_SCOPES } from '../../common/auth/support-session';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { DomainEvent, DomainEvents } from '../../common/events.service';
import { TenantResolver } from '../tenancy/tenant-resolver.service';
import { Lang } from './catalogue';
import { NotificationService, Recipient, Target } from './notification.service';
import { TemplateData } from './render';
import { centreAppUrl, TemplateService } from './template.service';

const HANDLED: DomainEventType[] = [
  'customer.created',
  'request.created',
  'request.information_requested',
  'request.assigned',
  'request.status_changed',
  'request.completed',
  'quotation.sent',
  'payment.requested',
  'payment.completed',
  'appointment.created',
  'appointment.reminder_due',
  'document.expiring',
  'document.rejected',
  'ticket.replied',
  'subscription.renewal_due',
  'subscription.payment_failed',
  'support_access.requested',
  'cash.shift_closed',
  'invoice.payment_reminder',
  'renewal.offered',
  'request.stage_overdue',
  'paperwork.signature_requested',
];

const locale = (language: Lang) => (language === 'ar' ? 'ar-AE-u-nu-latn' : 'en-GB');
export const formatDate = (date: Date, language: Lang, timeZone: string) => new Intl.DateTimeFormat(locale(language), { day: 'numeric', month: 'short', year: 'numeric', timeZone }).format(date);
export const formatTime = (date: Date, language: Lang, timeZone: string) => new Intl.DateTimeFormat(locale(language), { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(date);
const amountText = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : String(value ?? '');
};
const localised = (language: Lang, en: string | null | undefined, ar: string | null | undefined) => (language === 'ar' ? ar || en : en) ?? '';

/** What each permission that lets support CHANGE something allows, in words (everything else a grant can carry is a read). */
const SUPPORT_WRITE_WORDS: Record<string, Record<Lang, string>> = {
  'request.comment.internal': { en: 'writing internal notes on requests', ar: 'كتابة ملاحظات داخلية على الطلبات' },
};
/**
 * The access a support request asks for, in words, worked out from the requested permissions: "read-only
 * access" only when nothing in the request allows a change. A change permission without wording of its own
 * is named by its key rather than left out - the message must never promise less than is asked for.
 */
export function supportAccessKind(scopes: string[], language: Lang): string {
  const writes = scopes.filter((s) => SUPPORT_WRITE_SCOPES.includes(s));
  if (!writes.length) return language === 'ar' ? 'وصول للقراءة فقط' : 'read-only access';
  const words = writes.map((s) => SUPPORT_WRITE_WORDS[s]?.[language] ?? s);
  return language === 'ar'
    ? `وصول للقراءة، مع ${words.join(' و')} (لا يمكن تغيير أي شيء آخر)`
    : `read access, plus ${words.join(' and ')} (nothing else can be changed)`;
}

/**
 * Domain event -> notification mapping. Runs after commit, at least once; the
 * dedupe key `<eventId>:<channel>:<recipient>` makes a repeated delivery of the
 * same event harmless. Everything a template needs is loaded here, inside the
 * tenant transaction; messages only ever link to portal pages that require sign-in.
 */
@Injectable()
export class NotificationEventMapper implements OnModuleInit {
  private readonly logger = new Logger(NotificationEventMapper.name);

  constructor(
    private readonly db: TenantDb,
    private readonly events: DomainEvents,
    private readonly notifications: NotificationService,
    private readonly templates: TemplateService,
    private readonly resolver: TenantResolver,
  ) {}

  onModuleInit() {
    this.events.subscribe('notifications', HANDLED, (event) => this.handle(event));
  }

  async handle(event: DomainEvent): Promise<void> {
    if (!event.tenantId) return;
    const p = event.payload ?? {};
    await this.db.tx(async (tx) => {
      switch (event.type) {
        case 'customer.created': {
          // "Account registration": only people who registered themselves have an account to welcome.
          if (p.source !== 'SELF_REGISTRATION' || typeof p.customerId !== 'string') return;
          const portalLink = await this.resolver.portalLink(event.tenantId!, '/');
          await this.notifications.notify({ eventKey: 'account.registered', eventId: event.id, recipient: { kind: 'CUSTOMER', customerId: p.customerId }, data: (t) => ({ customerName: t.name, portalLink }), related: { type: 'Customer', id: p.customerId } });
          return;
        }
        case 'request.created':
          return this.requestEvent(tx, event, 'request.created', p.requestId);
        case 'request.information_requested': {
          // Without a note from staff the requests module passes the English status label: say it in the reader's language.
          const waiting = REQUEST_STATUS_META.AWAITING_CUSTOMER;
          const custom = typeof p.message === 'string' && p.message.trim() && p.message !== waiting.customerEn && p.message !== waiting.customerAr ? p.message.trim() : null;
          return this.requestEvent(tx, event, 'request.documents_missing', p.requestId, (t) => ({ message: custom ?? (t.language === 'ar' ? waiting.customerAr : waiting.customerEn) }));
        }
        case 'request.assigned':
          return this.requestAssigned(tx, event);
        case 'request.status_changed': {
          // Internal steps stay internal. Completion and "action needed" have their own, more specific
          // messages (request.completed / request.information_requested are emitted with the same change).
          if (p.customerVisible !== true || p.to === 'COMPLETED' || p.to === 'AWAITING_CUSTOMER') return;
          const meta = REQUEST_STATUS_META[p.to as keyof typeof REQUEST_STATUS_META];
          // The default customer message is just the status label again: only a real note is worth repeating.
          const note = typeof p.customerMessage === 'string' && (!meta || (p.customerMessage !== meta.customerEn && p.customerMessage !== meta.customerAr)) ? p.customerMessage : '';
          return this.requestEvent(tx, event, 'request.status_changed', p.requestId, (t) => ({
            statusLabel: meta ? (t.language === 'ar' ? meta.customerAr : meta.customerEn) : String(p.to ?? ''),
            customerMessage: note,
          }));
        }
        case 'request.completed':
          return this.requestEvent(tx, event, 'request.completed', p.requestId);
        case 'quotation.sent':
          return this.quotationSent(tx, event);
        case 'payment.requested':
          return this.paymentRequested(tx, event);
        case 'payment.completed':
          return this.paymentCompleted(tx, event);
        case 'appointment.created':
          return this.appointment(tx, event, 'appointment.confirmation');
        case 'appointment.reminder_due':
          return this.appointment(tx, event, 'appointment.reminder');
        case 'document.expiring':
          return this.documentExpiring(tx, event);
        case 'document.rejected':
          return this.documentRejected(tx, event);
        case 'ticket.replied':
          return this.ticketReplied(tx, event);
        case 'subscription.renewal_due':
          return this.subscription(tx, event, 'subscription.renewal');
        case 'subscription.payment_failed':
          return this.subscription(tx, event, 'subscription.payment_failed');
        case 'support_access.requested':
          return this.supportAccessRequested(tx, event);
        case 'cash.shift_closed':
          return this.cashVariance(tx, event);
        case 'invoice.payment_reminder':
          return this.invoiceReminder(tx, event);
        case 'renewal.offered':
          return this.renewalOffered(tx, event);
        case 'request.stage_overdue':
          return this.stageOverdue(tx, event);
        case 'paperwork.signature_requested':
          return this.signatureRequested(tx, event);
        default:
          return;
      }
    });
  }

  // ------------------------------------------------------------------ requests
  private async loadRequest(tx: Tx, requestId: unknown) {
    if (typeof requestId !== 'string') return null;
    return tx.serviceRequest.findFirst({
      where: { id: requestId, tenantId: this.db.tenantId },
      select: { id: true, requestNo: true, customerId: true, corporateAccountId: true, service: { select: { name: true, nameAr: true } }, customer: { select: { fullName: true } } },
    });
  }
  /**
   * Links for one message, per application: a company request is read in the corporate portal by the
   * company's administrators and by an employee whose only login is the company one; everybody else
   * gets the customer portal. `corporatePath` is used only when `company` is set (the record belongs to
   * a company, or the page exists in both portals).
   */
  private async links(company: string | boolean | null, customerPath: string, corporatePath: string = customerPath): Promise<(t: Target) => string> {
    const tenantId = this.db.tenantId;
    const customer = await this.resolver.portalLink(tenantId, customerPath);
    const corporate = company ? await this.resolver.portalLink(tenantId, corporatePath, {}, 'corporate') : null;
    return (t) => (t.portal === 'corporate' && corporate ? corporate : customer);
  }
  /**
   * The same message for the company's administrators who hold `permission`. A request of a company is
   * the company's business as much as the employee's: its administrators approve the price, pay the
   * invoice and answer questions of the centre. Their own notification preferences apply, and the
   * dedupe key keeps a person who is both subject and administrator from hearing it twice.
   */
  private async notifyCompany(tx: Tx, corporateAccountId: string | null, permission: string, message: { eventKey: string; eventId: string; data: (t: Target) => TemplateData; related: { type: string; id: string } }) {
    if (!corporateAccountId) return;
    for (const recipient of await this.notifications.corporateAdministrators(tx, corporateAccountId, permission)) {
      await this.notifications.notify({ ...message, recipient });
    }
  }
  /** Request events that the company's administrators receive as well (holders of "see the company's requests"). */
  private static readonly COMPANY_REQUEST_EVENTS = new Set(['request.documents_missing', 'request.completed']);

  private async requestEvent(tx: Tx, event: DomainEvent, eventKey: string, requestId: unknown, extra: (t: Target) => TemplateData = () => ({})) {
    const request = await this.loadRequest(tx, requestId);
    if (!request) return;
    const link = await this.links(request.corporateAccountId, `/requests/${request.id}`);
    const message = {
      eventKey,
      eventId: event.id,
      data: (t: Target) => ({ customerName: t.name, requestNumber: request.requestNo, serviceName: localised(t.language, request.service.name, request.service.nameAr), portalLink: link(t), ...extra(t) }),
      related: { type: 'ServiceRequest', id: request.id },
    };
    await this.notifications.notify({ ...message, recipient: { kind: 'CUSTOMER', customerId: request.customerId } });
    if (NotificationEventMapper.COMPANY_REQUEST_EVENTS.has(eventKey)) await this.notifyCompany(tx, request.corporateAccountId, 'corp.requests.read', message);
  }
  private async requestAssigned(tx: Tx, event: DomainEvent) {
    const p = event.payload;
    const request = await this.loadRequest(tx, p.requestId);
    if (!request) return;
    // "Staff assigned" for the customer ...
    await this.requestEvent(tx, event, 'request.staff_assigned', request.id);
    // ... and "assigned to you" for the staff member (unless they assigned it to themselves).
    if (typeof p.assigneeUserId === 'string' && p.assigneeUserId !== p._actor?.userId) {
      await this.notifications.notify({
        eventKey: 'request.assigned_to_you',
        eventId: event.id,
        recipient: { kind: 'USER', userId: p.assigneeUserId },
        data: (t) => ({ staffName: t.name, requestNumber: request.requestNo, serviceName: localised(t.language, request.service.name, request.service.nameAr), customerName: request.customer.fullName, centreLink: centreAppUrl(`/requests/${request.id}`) }),
        related: { type: 'ServiceRequest', id: request.id },
      });
    }
  }

  // ------------------------------------------------------------------ money
  private async quotationSent(tx: Tx, event: DomainEvent) {
    const p = event.payload;
    if (typeof p.quotationId !== 'string' || p.silent === true) return;
    const tenantId = this.db.tenantId;
    const q = await tx.quotation.findFirst({ where: { id: p.quotationId, tenantId }, select: { id: true, quotationNo: true, customerId: true, corporateAccountId: true, requestId: true, total: true, currency: true, validUntil: true, request: { select: { requestNo: true } } } });
    if (!q) return;
    const tenant = await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { timezone: true } });
    // The person the request is about reads the price in their own portal. An employee signed in to the
    // corporate portal cannot decide on it: they are sent to their request, where its status is shown.
    const subjectLink = await this.links(q.corporateAccountId, `/quotations/${q.id}`, q.requestId ? `/requests/${q.requestId}` : '/');
    // The administrators who may approve are sent straight to the approval screen of the corporate portal.
    const approvalLink = await this.links(q.corporateAccountId, `/quotations/${q.id}`, `/approvals/${q.id}`);
    const message = (link: (t: Target) => string) => ({
      eventKey: 'quotation.ready',
      eventId: event.id,
      data: (t: Target) => ({
        customerName: t.name,
        quotationNumber: q.quotationNo,
        requestNumber: q.request?.requestNo ?? '',
        amount: amountText(p.total ?? q.total.toString()),
        currency: String(p.currency ?? q.currency),
        validUntil: q.validUntil ? formatDate(q.validUntil, t.language, tenant.timezone) : '',
        portalLink: link(t),
      }),
      related: { type: 'Quotation', id: q.id },
    });
    await this.notifications.notify({ ...message(subjectLink), recipient: { kind: 'CUSTOMER', customerId: q.customerId } });
    await this.notifyCompany(tx, q.corporateAccountId, 'corp.requests.approve', message(approvalLink));
  }
  private async paymentRequested(tx: Tx, event: DomainEvent) {
    const p = event.payload;
    if (typeof p.invoiceId !== 'string') return;
    const tenantId = this.db.tenantId;
    const inv = await tx.invoice.findFirst({ where: { id: p.invoiceId, tenantId }, select: { id: true, invoiceNo: true, customerId: true, corporateAccountId: true, requestId: true, balanceDue: true, currency: true, dueAt: true, request: { select: { requestNo: true } } } });
    if (!inv) return;
    const tenant = await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { timezone: true } });
    // As for quotations: an employee in the corporate portal follows the status on their request, the
    // administrators who see the company's invoices are sent to the invoice itself.
    const subjectLink = await this.links(inv.corporateAccountId, `/invoices/${inv.id}`, inv.requestId ? `/requests/${inv.requestId}` : '/');
    const invoiceLink = await this.links(inv.corporateAccountId, `/invoices/${inv.id}`);
    const message = (link: (t: Target) => string) => ({
      eventKey: 'payment.requested',
      eventId: event.id,
      data: (t: Target) => ({
        customerName: t.name,
        invoiceNumber: inv.invoiceNo,
        requestNumber: inv.request?.requestNo ?? '',
        amount: amountText(p.amount ?? inv.balanceDue.toString()),
        currency: String(p.currency ?? inv.currency),
        dueDate: inv.dueAt ? formatDate(inv.dueAt, t.language, tenant.timezone) : '',
        portalLink: link(t),
      }),
      related: { type: 'Invoice', id: inv.id },
    });
    await this.notifications.notify({ ...message(subjectLink), recipient: { kind: 'CUSTOMER', customerId: inv.customerId } });
    await this.notifyCompany(tx, inv.corporateAccountId, 'corp.invoices.read', message(invoiceLink));
  }
  /** An unpaid invoice reminder (automatic stage or sent by staff): the customer, and the company's invoice contacts. */
  private async invoiceReminder(tx: Tx, event: DomainEvent) {
    const p = event.payload;
    if (typeof p.invoiceId !== 'string') return;
    const tenantId = this.db.tenantId;
    const inv = await tx.invoice.findFirst({ where: { id: p.invoiceId, tenantId }, select: { id: true, invoiceNo: true, customerId: true, corporateAccountId: true, balanceDue: true, currency: true, dueAt: true, status: true } });
    // Paid or voided between the scan and the delivery: nothing to remind.
    if (!inv || !['ISSUED', 'PARTIALLY_PAID'].includes(inv.status) || inv.balanceDue.lte(0)) return;
    const tenant = await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { timezone: true } });
    const invoiceLink = await this.links(inv.corporateAccountId, `/invoices/${inv.id}`);
    const message = {
      eventKey: 'invoice.reminder' as const,
      eventId: event.id,
      data: (t: Target) => ({
        customerName: t.name,
        invoiceNumber: inv.invoiceNo,
        amount: amountText(inv.balanceDue.toString()),
        currency: inv.currency,
        dueDate: inv.dueAt ? formatDate(inv.dueAt, t.language, tenant.timezone) : '',
        daysOverdue: String(p.daysOverdue ?? ''),
        portalLink: invoiceLink(t),
      }),
      related: { type: 'Invoice', id: inv.id },
    };
    await this.notifications.notify({ ...message, recipient: { kind: 'CUSTOMER', customerId: inv.customerId } });
    await this.notifyCompany(tx, inv.corporateAccountId, 'corp.invoices.read', message);
  }
  /** The renewal autopilot prepared a renewal: the customer gets the one-tap approve-and-pay link. */
  private async renewalOffered(tx: Tx, event: DomainEvent) {
    const p = event.payload;
    if (typeof p.quotationId !== 'string' || typeof p.renewLink !== 'string') return;
    const tenantId = this.db.tenantId;
    const q = await tx.quotation.findFirst({ where: { id: p.quotationId, tenantId }, select: { id: true, customerId: true, total: true, currency: true, status: true } });
    // Approved, declined or replaced before the message went out: nothing to offer any more.
    if (!q || q.status !== 'SENT') return;
    const expiry = typeof p.expiryDate === 'string' ? new Date(`${p.expiryDate}T00:00:00.000Z`) : null;
    await this.notifications.notify({
      eventKey: 'renewal.offer',
      eventId: event.id,
      recipient: { kind: 'CUSTOMER', customerId: q.customerId },
      data: (t: Target) => ({
        customerName: t.name,
        documentName: String((t.language === 'ar' ? p.documentNameAr : null) ?? p.documentName ?? ''),
        expiryDate: expiry ? formatDate(expiry, t.language, 'UTC') : '',
        serviceName: String((t.language === 'ar' ? p.serviceNameAr : null) ?? p.serviceName ?? ''),
        amount: amountText(q.total.toString()),
        currency: q.currency,
        renewLink: p.renewLink as string,
      }),
      related: { type: 'Quotation', id: q.id },
    });
  }
  private async paymentCompleted(tx: Tx, event: DomainEvent) {
    const p = event.payload;
    if (typeof p.paymentId !== 'string') return;
    const tenantId = this.db.tenantId;
    const pay = await tx.payment.findFirst({ where: { id: p.paymentId, tenantId }, select: { id: true, paymentNo: true, receiptNo: true, customerId: true, corporateAccountId: true, amount: true, currency: true } });
    const customerId = pay?.customerId ?? (typeof p.customerId === 'string' ? p.customerId : null);
    if (!pay || !customerId) return;
    const link = await this.links(pay.corporateAccountId, '/payments', '/invoices');
    await this.notifications.notify({
      eventKey: 'payment.received',
      eventId: event.id,
      recipient: { kind: 'CUSTOMER', customerId },
      data: (t) => ({ customerName: t.name, receiptNumber: pay.receiptNo ?? pay.paymentNo, amount: amountText(p.amount ?? pay.amount.toString()), currency: String(p.currency ?? pay.currency), portalLink: link(t) }),
      related: { type: 'Payment', id: pay.id },
    });
  }

  // ------------------------------------------------------------------ appointments
  private async appointment(tx: Tx, event: DomainEvent, eventKey: string) {
    const p = event.payload;
    if (typeof p.appointmentId !== 'string') return;
    const tenantId = this.db.tenantId;
    const a = await tx.appointment.findFirst({
      where: { id: p.appointmentId, tenantId },
      select: { id: true, customerId: true, guestName: true, guestPhone: true, startsAt: true, status: true, branch: { select: { name: true, nameAr: true, timezone: true } }, service: { select: { name: true, nameAr: true } } },
    });
    if (!a) return;
    // A reminder for an appointment that was cancelled in the meantime would only confuse.
    if (eventKey === 'appointment.reminder' && !['BOOKED', 'CONFIRMED'].includes(a.status)) return;
    let recipient: Recipient;
    let portalLink = '';
    if (a.customerId) {
      recipient = { kind: 'CUSTOMER', customerId: a.customerId };
      portalLink = await this.resolver.portalLink(tenantId, '/appointments');
    } else if (a.guestPhone && /^\+[1-9][0-9]{6,14}$/.test(a.guestPhone)) {
      recipient = { kind: 'ADDRESS', channel: 'SMS', address: a.guestPhone, name: a.guestName };
    } else return;
    const tz = a.branch.timezone || 'Asia/Dubai';
    await this.notifications.notify({
      eventKey,
      eventId: event.id,
      recipient,
      data: (t) => ({
        customerName: t.name,
        appointmentDate: formatDate(a.startsAt, t.language, tz),
        appointmentTime: formatTime(a.startsAt, t.language, tz),
        branchName: localised(t.language, a.branch.name, a.branch.nameAr),
        serviceName: localised(t.language, a.service?.name, a.service?.nameAr),
        portalLink,
      }),
      related: { type: 'Appointment', id: a.id },
    });
  }

  // ------------------------------------------------------------------ document expiry
  private async documentExpiring(tx: Tx, event: DomainEvent) {
    const p = event.payload;
    const tenantId = this.db.tenantId;
    const key = String(p.documentTypeKey ?? '');
    const types = await tx.documentType.findMany({ where: { key, OR: [{ tenantId }, { tenantId: null }] }, select: { tenantId: true, name: true, nameAr: true } });
    const type = types.find((t) => t.tenantId !== null) ?? types[0];
    const expiry = new Date(String(p.expiryDate));
    if (Number.isNaN(expiry.getTime())) return;
    const scheduleId = typeof p.scheduleId === 'string' ? p.scheduleId : null;
    const corporate = !p.customerId && typeof p.corporateAccountId === 'string';
    const renewalLink = await this.resolver.portalLink(tenantId, '/requests/new', scheduleId ? { renewalOf: scheduleId } : {}, corporate ? 'corporate' : 'customer');
    const data = (t: Target): TemplateData => ({
      recipientName: t.name,
      documentName: localised(t.language, type?.name ?? key.replace(/_/g, ' '), type?.nameAr),
      subjectLabel: String(p.subjectLabel ?? ''),
      expiryDate: formatDate(expiry, t.language, 'UTC'),
      daysLeft: String(p.daysLeft ?? ''),
      renewalLink,
    });
    const recipients: Recipient[] = [];
    if (typeof p.customerId === 'string') recipients.push({ kind: 'CUSTOMER', customerId: p.customerId });
    else if (corporate) recipients.push(...(await this.notifications.corporateRecipients(tx, p.corporateAccountId)));
    const created = [];
    for (const recipient of recipients) {
      created.push(...(await this.notifications.notify({ eventKey: 'document.expiry', eventId: event.id, recipient, data, related: scheduleId ? { type: 'ReminderSchedule', id: scheduleId } : null })));
    }
    // Link the reminder dispatch to what was actually created, so the reminder history shows the result.
    if (typeof p.dispatchId === 'string' && created.length) {
      const sent = created.find((c) => c.status !== 'SUPPRESSED');
      const detail = created.map((c) => `${c.channel}: ${c.status}${c.suppressedReason ? ` (${c.suppressedReason})` : ''}`).join(', ').slice(0, 500);
      await tx.reminderDispatch.updateMany({ where: { id: p.dispatchId, tenantId }, data: { notificationId: (sent ?? created[0]).id, detail } });
    }
  }
  // ------------------------------------------------------------------ rejected documents
  /**
   * A document was rejected (or must be sent again): the person it belongs to is told what to do, and
   * so are the administrators of the company when the document belongs to a company request or to the
   * company itself. The reason is the reviewer's own note; without one the message says so in words.
   */
  private async documentRejected(tx: Tx, event: DomainEvent) {
    const p = event.payload;
    const tenantId = this.db.tenantId;
    if (typeof p.documentId !== 'string') return;
    const doc = await tx.document.findFirst({
      where: { id: p.documentId, tenantId, deletedAt: null },
      select: { id: true, title: true, documentTypeKey: true, customerId: true, corporateAccountId: true, requestId: true, request: { select: { id: true, requestNo: true, corporateAccountId: true } } },
    });
    if (!doc) return;
    const key = doc.documentTypeKey ?? '';
    const types = key ? await tx.documentType.findMany({ where: { key, OR: [{ tenantId }, { tenantId: null }] }, select: { tenantId: true, name: true, nameAr: true } }) : [];
    const type = types.find((t) => t.tenantId !== null) ?? types[0];
    const corporateAccountId = doc.request?.corporateAccountId ?? doc.corporateAccountId ?? null;
    const link = await this.links(corporateAccountId, doc.request ? `/requests/${doc.request.id}` : '/documents');
    const reason = typeof p.reason === 'string' ? p.reason.trim() : '';
    const message = {
      eventKey: 'document.rejected',
      eventId: event.id,
      data: (t: Target): TemplateData => ({
        recipientName: t.name,
        documentName: localised(t.language, type?.name ?? (key ? key.replace(/_/g, ' ') : doc.title), type?.nameAr) || doc.title,
        requestNumber: doc.request?.requestNo ?? '-',
        reason: reason || (t.language === 'ar' ? 'لم يذكر المركز سبباً. يرجى رفع نسخة واضحة وكاملة.' : 'The centre did not give a reason. Please upload a clear and complete copy.'),
        portalLink: link(t),
      }),
      related: { type: 'Document', id: doc.id },
    };
    if (doc.customerId) await this.notifications.notify({ ...message, recipient: { kind: 'CUSTOMER', customerId: doc.customerId } });
    await this.notifyCompany(tx, corporateAccountId, doc.request ? 'corp.requests.read' : 'corp.employees.read', message);
  }

  // ------------------------------------------------------------------ support
  private async ticketReplied(tx: Tx, event: DomainEvent) {
    const p = event.payload;
    if (p.visibility !== 'CUSTOMER' || typeof p.ticketId !== 'string') return;
    const tenantId = this.db.tenantId;
    const ticket = await tx.supportTicket.findFirst({ where: { id: p.ticketId, tenantId }, select: { id: true, ticketNo: true, subject: true, scope: true, customerId: true, raisedByUserId: true } });
    if (!ticket) return;
    if (ticket.scope === 'PLATFORM') {
      // TypEase support answered a ticket the centre opened.
      if (p.authorType !== 'PLATFORM' || !ticket.raisedByUserId) return;
      await this.notifications.notify({
        eventKey: 'support.response',
        eventId: event.id,
        recipient: { kind: 'USER', userId: ticket.raisedByUserId },
        data: (t) => ({ recipientName: t.name, ticketNumber: ticket.ticketNo, ticketSubject: ticket.subject, teamName: t.language === 'ar' ? 'فريق دعم TypEase' : 'TypEase Support', portalLink: centreAppUrl(`/support/platform/${ticket.id}`) }),
        related: { type: 'SupportTicket', id: ticket.id },
      });
      return;
    }
    // Only replies written by staff reach the customer; the customer's own messages do not echo back.
    if (!['STAFF', 'PLATFORM'].includes(String(p.authorType)) || !ticket.customerId) return;
    const names = { en: (await this.templates.brand(tenantId, 'en')).name, ar: (await this.templates.brand(tenantId, 'ar')).name };
    // Both portals have the ticket page: the reply opens where the person signs in.
    const link = await this.links(true, `/support/${ticket.id}`);
    await this.notifications.notify({
      eventKey: 'support.response',
      eventId: event.id,
      recipient: { kind: 'CUSTOMER', customerId: ticket.customerId },
      data: (t) => ({ recipientName: t.name, ticketNumber: ticket.ticketNo, ticketSubject: ticket.subject, teamName: names[t.language], portalLink: link(t) }),
      related: { type: 'SupportTicket', id: ticket.id },
    });
  }

  // ------------------------------------------------------------------ support access -> the people who decide
  /**
   * TypEase support asked for access: everybody who may decide (permission `support_access.decide`,
   * the centre's owners by default) is told in the application and by email, with a link to the
   * approval screen. A request that was withdrawn or decided before the event arrived needs no message.
   */
  private async supportAccessRequested(tx: Tx, event: DomainEvent) {
    const p = event.payload;
    const tenantId = this.db.tenantId;
    if (typeof p.grantId !== 'string') return;
    const grant = await tx.accessGrant.findFirst({ where: { id: p.grantId, tenantId }, select: { id: true, status: true, reason: true, durationMinutes: true, scopes: true } });
    if (!grant || grant.status !== 'REQUESTED') return;
    const deciders = await tx.tenantMembership.findMany({
      where: { tenantId, kind: 'STAFF', status: 'ACTIVE', role: { rolePermissions: { some: { permissionKey: 'support_access.decide' } } } },
      select: { userId: true },
    });
    for (const decider of deciders) {
      await this.notifications.notify({
        eventKey: 'support_access.requested',
        eventId: event.id,
        recipient: { kind: 'USER', userId: decider.userId },
        data: (t) => ({
          name: t.name,
          requesterName: typeof p.requesterName === 'string' && p.requesterName ? p.requesterName : 'TypEase support',
          reason: grant.reason,
          durationMinutes: String(grant.durationMinutes),
          accessKind: supportAccessKind(grant.scopes, t.language),
          centreLink: centreAppUrl('/settings?tab=support'),
        }),
        related: { type: 'AccessGrant', id: grant.id },
      });
    }
    if (!deciders.length) this.logger.warn(`support_access.requested: tenant ${tenantId} has nobody who may decide on support access.`);
  }

  // ------------------------------------------------------------------ cash register -> managers
  /** A shift closed with a difference above the tolerance: everybody with `cash.manage` except the cashier is told. */
  /** A ready-made document was issued: the customer gets the link to read and sign it. */
  private async signatureRequested(tx: Tx, event: DomainEvent) {
    const p = event.payload;
    if (typeof p.documentId !== 'string' || typeof p.customerId !== 'string' || typeof p.signLink !== 'string') return;
    const doc = await tx.generatedDocument.findFirst({ where: { id: p.documentId, tenantId: this.db.tenantId }, select: { status: true } });
    if (doc?.status !== 'ISSUED') return;
    await this.notifications.notify({
      eventKey: 'paperwork.sign',
      eventId: event.id,
      recipient: { kind: 'CUSTOMER', customerId: p.customerId },
      data: (t) => ({ customerName: t.name, documentTitle: localised(t.language, String(p.title ?? ''), typeof p.titleAr === 'string' ? p.titleAr : null), documentNumber: String(p.documentNo ?? ''), signLink: p.signLink as string }),
      related: { type: 'GeneratedDocument', id: p.documentId },
    });
  }
  /** A request stayed in a board column past its limit: the branch's managers (who can reassign) and the assignee. */
  private async stageOverdue(tx: Tx, event: DomainEvent) {
    const p = event.payload;
    if (typeof p.requestId !== 'string' || typeof p.status !== 'string') return;
    const tenantId = this.db.tenantId;
    const managers = await tx.tenantMembership.findMany({
      where: { tenantId, kind: 'STAFF', status: 'ACTIVE', role: { rolePermissions: { some: { permissionKey: 'request.assign' } } }, OR: [{ allBranches: true }, { membershipBranches: { some: { branchId: String(p.branchId ?? '') } } }] },
      select: { userId: true },
    });
    const recipients = new Set(managers.map((m) => m.userId));
    if (typeof p.assigneeUserId === 'string') recipients.add(p.assigneeUserId);
    const meta = REQUEST_STATUS_META[p.status as keyof typeof REQUEST_STATUS_META];
    const waited = (Date.now() - Date.parse(String(p.since))) / 3_600_000;
    for (const userId of recipients) {
      await this.notifications.notify({
        eventKey: 'request.stage_overdue',
        eventId: event.id,
        recipient: { kind: 'USER', userId },
        data: (t) => ({
          name: t.name,
          requestNumber: String(p.requestNo ?? ''),
          stage: meta ? localised(t.language, meta.en, meta.ar) : p.status as string,
          waited: (Math.round(waited * 10) / 10).toString(),
          limit: (Math.round((Number(p.limitMinutes) / 60) * 10) / 10).toString(),
          centreLink: centreAppUrl(`/requests/${p.requestId}`),
        }),
        related: { type: 'ServiceRequest', id: p.requestId },
      });
    }
  }
  private async cashVariance(tx: Tx, event: DomainEvent) {
    const p = event.payload;
    if (!p.flagged || typeof p.shiftId !== 'string') return;
    const tenantId = this.db.tenantId;
    const managers = await tx.tenantMembership.findMany({
      where: {
        tenantId,
        kind: 'STAFF',
        status: 'ACTIVE',
        userId: { not: String(p.cashierId ?? '') },
        role: { rolePermissions: { some: { permissionKey: 'cash.manage' } } },
        // Only managers who can see the branch of the shift.
        OR: [{ allBranches: true }, { membershipBranches: { some: { branchId: String(p.branchId ?? '') } } }],
      },
      select: { userId: true },
    });
    for (const m of managers) {
      await this.notifications.notify({
        eventKey: 'cash.variance',
        eventId: event.id,
        recipient: { kind: 'USER', userId: m.userId },
        data: (t) => ({
          name: t.name,
          shiftNumber: String(p.shiftNo ?? ''),
          cashierName: String(p.cashierName ?? ''),
          expectedCash: amountText(p.expectedCash),
          countedCash: amountText(p.countedCash),
          difference: amountText(p.cashVariance),
          currency: String(p.currency ?? 'AED'),
          centreLink: centreAppUrl(`/cash?shift=${p.shiftId}`),
        }),
        related: { type: 'CashierShift', id: p.shiftId },
      });
    }
  }

  // ------------------------------------------------------------------ SaaS billing -> centre owners
  private async subscription(tx: Tx, event: DomainEvent, eventKey: 'subscription.renewal' | 'subscription.payment_failed') {
    const p = event.payload;
    const tenantId = this.db.tenantId;
    const sub = await tx.subscription.findFirst({ where: { tenantId }, select: { id: true, currentPeriodEnd: true, plan: { select: { name: true } } } });
    const tenant = await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { timezone: true, defaultCurrency: true } });
    const owners = await tx.tenantMembership.findMany({ where: { tenantId, kind: 'STAFF', status: 'ACTIVE', role: { key: 'owner' } }, select: { userId: true } });
    const due = p.dueAt ? new Date(String(p.dueAt)) : (sub?.currentPeriodEnd ?? null);
    for (const owner of owners) {
      await this.notifications.notify({
        eventKey,
        eventId: event.id,
        recipient: { kind: 'USER', userId: owner.userId },
        data: (t) => ({
          name: t.name,
          planName: typeof p.planName === 'string' && p.planName ? p.planName : (sub?.plan.name ?? ''),
          amount: p.amount !== undefined && p.amount !== null ? amountText(p.amount) : '',
          currency: String(p.currency ?? tenant.defaultCurrency),
          renewalDate: due && !Number.isNaN(due.getTime()) ? formatDate(due, t.language, tenant.timezone) : '',
          reason: String(p.reason ?? ''),
          centreLink: centreAppUrl('/settings/subscription'),
        }),
        related: sub ? { type: 'Subscription', id: sub.id } : null,
      });
    }
    if (!owners.length) this.logger.warn(`${eventKey}: tenant ${tenantId} has no active owner to notify.`);
  }
}
