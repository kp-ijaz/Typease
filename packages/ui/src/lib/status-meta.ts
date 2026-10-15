import { REQUEST_STATUS_META } from '@typease/types';
import type {
  AppointmentStatus, ApprovalStatus, AutomationExecutionStatus, ChecklistStatus, CorporateStatus, CustomerStatus, DeliveryStatus, DocumentStatus, DomainStatus, IntegrationStatus,
  InvoiceStatus, MembershipStatus, NotificationStatus, PaymentStatus, PublishStatus, QueueStatus, QuotationStatus, RefundStatus, ReminderStatus, RequestPaymentStatus,
  RequestPriority, RequestStatus, SubscriptionInvoiceStatus, SubscriptionStatus, TaskStatus, TenantStatus, TicketStatus, VerificationStatus,
} from '@typease/types';

export type Tone = 'neutral' | 'info' | 'warning' | 'success' | 'danger';
export interface StatusMeta {
  en: string;
  ar: string;
  tone: Tone;
}
type MetaMap<K extends string> = Record<K, StatusMeta>;
const m = (en: string, ar: string, tone: Tone): StatusMeta => ({ en, ar, tone });

/** Staff wording of request statuses (customers get `customerEn` / `customerAr`, see StatusBadge `audience`). */
const request = Object.fromEntries(Object.entries(REQUEST_STATUS_META).map(([k, v]) => [k, { en: v.en, ar: v.ar, tone: v.tone }])) as MetaMap<RequestStatus>;
const requestCustomer = Object.fromEntries(Object.entries(REQUEST_STATUS_META).map(([k, v]) => [k, { en: v.customerEn, ar: v.customerAr, tone: v.tone }])) as MetaMap<RequestStatus>;

const invoice: MetaMap<InvoiceStatus> = {
  DRAFT: m('Draft', 'مسودة', 'neutral'),
  ISSUED: m('Unpaid', 'غير مدفوعة', 'warning'),
  PARTIALLY_PAID: m('Partly paid', 'مدفوعة جزئيًا', 'warning'),
  PAID: m('Paid', 'مدفوعة', 'success'),
  VOID: m('Void', 'ملغاة', 'neutral'),
  CREDITED: m('Credited', 'مُصدَر لها إشعار دائن', 'neutral'),
};
const payment: MetaMap<PaymentStatus> = {
  PENDING: m('Pending', 'قيد الانتظار', 'warning'),
  COMPLETED: m('Received', 'تم الاستلام', 'success'),
  FAILED: m('Failed', 'فشلت', 'danger'),
  CANCELLED: m('Cancelled', 'ملغاة', 'neutral'),
  PARTIALLY_REFUNDED: m('Partly refunded', 'مستردة جزئيًا', 'info'),
  REFUNDED: m('Refunded', 'مستردة', 'neutral'),
};
const requestPayment: MetaMap<RequestPaymentStatus> = {
  NOT_REQUIRED: m('No payment needed', 'لا يلزم دفع', 'neutral'),
  UNPAID: m('Unpaid', 'غير مدفوع', 'warning'),
  PARTIALLY_PAID: m('Partly paid', 'مدفوع جزئيًا', 'warning'),
  PAID: m('Paid', 'مدفوع', 'success'),
  PARTIALLY_REFUNDED: m('Partly refunded', 'مسترد جزئيًا', 'info'),
  REFUNDED: m('Refunded', 'مسترد', 'neutral'),
};
const quotation: MetaMap<QuotationStatus> = {
  DRAFT: m('Draft', 'مسودة', 'neutral'),
  SENT: m('Awaiting approval', 'بانتظار الموافقة', 'warning'),
  APPROVED: m('Approved', 'تمت الموافقة', 'success'),
  REJECTED: m('Declined', 'مرفوض', 'danger'),
  EXPIRED: m('Expired', 'منتهي الصلاحية', 'neutral'),
  SUPERSEDED: m('Replaced', 'تم استبداله', 'neutral'),
  CANCELLED: m('Cancelled', 'ملغي', 'neutral'),
};
const refund: MetaMap<RefundStatus> = {
  REQUESTED: m('Awaiting approval', 'بانتظار الموافقة', 'warning'),
  APPROVED: m('Approved', 'تمت الموافقة', 'info'),
  REJECTED: m('Rejected', 'مرفوض', 'danger'),
  PROCESSING: m('Processing', 'قيد المعالجة', 'info'),
  COMPLETED: m('Refunded', 'تم الاسترداد', 'success'),
  FAILED: m('Failed', 'فشل', 'danger'),
};
const document: MetaMap<DocumentStatus> = {
  PENDING_UPLOAD: m('Uploading', 'جارٍ الرفع', 'neutral'),
  PENDING_SCAN: m('Security check', 'فحص أمني', 'info'),
  AVAILABLE: m('Available', 'متاح', 'success'),
  QUARANTINED: m('Blocked', 'محظور', 'danger'),
  DELETED: m('Deleted', 'محذوف', 'neutral'),
};
const verification: MetaMap<VerificationStatus> = {
  UNVERIFIED: m('Not checked', 'لم يُدقَّق', 'neutral'),
  VERIFIED: m('Verified', 'موثّق', 'success'),
  REJECTED: m('Rejected', 'مرفوض', 'danger'),
};
const checklist: MetaMap<ChecklistStatus> = {
  MISSING: m('Missing', 'ناقص', 'warning'),
  UPLOADED: m('Uploaded', 'تم الرفع', 'info'),
  VERIFIED: m('Verified', 'موثّق', 'success'),
  REJECTED: m('Rejected', 'مرفوض', 'danger'),
  WAIVED: m('Not needed', 'غير مطلوب', 'neutral'),
};
const appointment: MetaMap<AppointmentStatus> = {
  BOOKED: m('Booked', 'محجوز', 'info'),
  CONFIRMED: m('Confirmed', 'مؤكد', 'info'),
  CHECKED_IN: m('Checked in', 'تم الحضور', 'warning'),
  IN_SERVICE: m('In service', 'قيد الخدمة', 'warning'),
  COMPLETED: m('Completed', 'مكتمل', 'success'),
  CANCELLED: m('Cancelled', 'ملغي', 'neutral'),
  NO_SHOW: m('No show', 'لم يحضر', 'danger'),
  RESCHEDULED: m('Rescheduled', 'أُعيدت جدولته', 'neutral'),
};
const task: MetaMap<TaskStatus> = {
  OPEN: m('To do', 'للتنفيذ', 'info'),
  IN_PROGRESS: m('In progress', 'قيد التنفيذ', 'warning'),
  DONE: m('Done', 'منجز', 'success'),
  CANCELLED: m('Cancelled', 'ملغي', 'neutral'),
};
const ticket: MetaMap<TicketStatus> = {
  OPEN: m('Open', 'مفتوح', 'info'),
  IN_PROGRESS: m('In progress', 'قيد المعالجة', 'warning'),
  WAITING_CUSTOMER: m('Waiting for customer', 'بانتظار العميل', 'warning'),
  RESOLVED: m('Resolved', 'تم الحل', 'success'),
  CLOSED: m('Closed', 'مغلق', 'neutral'),
};
const customer: MetaMap<CustomerStatus> = {
  ACTIVE: m('Active', 'نشط', 'success'),
  ARCHIVED: m('Archived', 'مؤرشف', 'neutral'),
  MERGED: m('Merged', 'مدموج', 'neutral'),
  ANONYMISED: m('Anonymised', 'مجهول الهوية', 'neutral'),
};
const corporate: MetaMap<CorporateStatus> = {
  PENDING_VERIFICATION: m('Awaiting verification', 'بانتظار التحقق', 'warning'),
  ACTIVE: m('Active', 'نشط', 'success'),
  SUSPENDED: m('Suspended', 'موقوف', 'danger'),
  ARCHIVED: m('Archived', 'مؤرشف', 'neutral'),
};
const membership: MetaMap<MembershipStatus> = {
  INVITED: m('Invited', 'مدعو', 'warning'),
  ACTIVE: m('Active', 'نشط', 'success'),
  SUSPENDED: m('Suspended', 'موقوف', 'danger'),
  REMOVED: m('Removed', 'مُزال', 'neutral'),
};
const subscription: MetaMap<SubscriptionStatus> = {
  TRIALING: m('Trial', 'فترة تجريبية', 'info'),
  ACTIVE: m('Active', 'نشط', 'success'),
  PAST_DUE: m('Payment overdue', 'الدفع متأخر', 'danger'),
  GRACE: m('Grace period', 'فترة سماح', 'warning'),
  CANCELLED: m('Cancelled', 'ملغي', 'neutral'),
  EXPIRED: m('Expired', 'منتهي', 'neutral'),
};
const tenant: MetaMap<TenantStatus> = {
  ONBOARDING: m('Setting up', 'قيد الإعداد', 'info'),
  PENDING_APPROVAL: m('Awaiting approval', 'بانتظار الموافقة', 'warning'),
  TRIAL: m('Trial', 'فترة تجريبية', 'info'),
  ACTIVE: m('Active', 'نشط', 'success'),
  PAST_DUE: m('Payment overdue', 'الدفع متأخر', 'danger'),
  SUSPENDED: m('Suspended', 'موقوف', 'danger'),
  CANCELLED: m('Cancelled', 'ملغي', 'neutral'),
  ARCHIVED: m('Archived', 'مؤرشف', 'neutral'),
};
const priority: MetaMap<RequestPriority> = {
  LOW: m('Low', 'منخفضة', 'neutral'),
  NORMAL: m('Normal', 'عادية', 'neutral'),
  HIGH: m('High', 'عالية', 'warning'),
  URGENT: m('Urgent', 'عاجلة', 'danger'),
};
const portalAccess: MetaMap<'NONE' | 'INVITED' | 'ACTIVE' | 'SUSPENDED'> = {
  NONE: m('No online account', 'لا يوجد حساب إلكتروني', 'neutral'),
  INVITED: m('Invited', 'مدعو', 'warning'),
  ACTIVE: m('Online account', 'حساب إلكتروني', 'success'),
  SUSPENDED: m('Suspended', 'موقوف', 'danger'),
};

/** A walk-in token in the queue. */
const queue: MetaMap<QueueStatus> = {
  WAITING: m('Waiting', 'في الانتظار', 'info'),
  CALLED: m('Called', 'تم النداء', 'warning'),
  SERVING: m('Being served', 'قيد الخدمة', 'warning'),
  COMPLETED: m('Served', 'تمت الخدمة', 'success'),
  NO_SHOW: m('No show', 'لم يحضر', 'danger'),
  CANCELLED: m('Cancelled', 'ملغي', 'neutral'),
};
/** A reminder schedule (the plan to remind someone before a document expires). */
const reminder: MetaMap<ReminderStatus> = {
  ACTIVE: m('Active', 'نشط', 'success'),
  PAUSED: m('Paused', 'متوقف مؤقتًا', 'warning'),
  COMPLETED: m('Finished', 'منتهٍ', 'neutral'),
  CANCELLED: m('Cancelled', 'ملغي', 'neutral'),
};
/** One planned message of a reminder schedule (the API stores these as plain strings). */
const reminderDispatch: MetaMap<'PENDING' | 'SENT' | 'FAILED' | 'CANCELLED' | 'SKIPPED_NO_CONSENT' | 'SKIPPED_OPT_OUT'> = {
  PENDING: m('Planned', 'مُجدول', 'neutral'),
  SENT: m('Sent', 'أُرسل', 'success'),
  FAILED: m('Failed', 'فشل', 'danger'),
  CANCELLED: m('Not sent', 'لم يُرسل', 'neutral'),
  SKIPPED_NO_CONSENT: m('Skipped: no consent', 'تم التخطي: لا توجد موافقة', 'warning'),
  SKIPPED_OPT_OUT: m('Skipped: opted out', 'تم التخطي: ألغى الاشتراك', 'warning'),
};
/** A message the centre sends (email, SMS, WhatsApp, in-app). */
const notification: MetaMap<NotificationStatus> = {
  QUEUED: m('Queued', 'في قائمة الإرسال', 'neutral'),
  SENT: m('Sent', 'أُرسل', 'info'),
  DELIVERED: m('Delivered', 'تم التسليم', 'success'),
  FAILED: m('Failed', 'فشل', 'danger'),
  SUPPRESSED: m('Not sent', 'لم يُرسل', 'warning'),
};
/** One delivery attempt of a message or a webhook. */
const delivery: MetaMap<DeliveryStatus> = {
  PENDING: m('Pending', 'قيد الانتظار', 'neutral'),
  SENT: m('Sent', 'أُرسل', 'info'),
  DELIVERED: m('Delivered', 'تم التسليم', 'success'),
  FAILED: m('Failed', 'فشل', 'danger'),
};
/** One run of an automation rule. */
const automationExecution: MetaMap<AutomationExecutionStatus> = {
  PENDING: m('Waiting', 'في الانتظار', 'neutral'),
  RUNNING: m('Running', 'قيد التنفيذ', 'info'),
  SUCCEEDED: m('Succeeded', 'نجح', 'success'),
  FAILED: m('Failed, will retry', 'فشل وسيُعاد', 'warning'),
  SKIPPED: m('Skipped', 'تم التخطي', 'neutral'),
  DEAD_LETTER: m('Gave up', 'توقفت المحاولات', 'danger'),
};
/** Things that are drafted, published and retired: services, workflow versions, forms, templates. */
const publish: MetaMap<PublishStatus> = {
  DRAFT: m('Draft', 'مسودة', 'neutral'),
  PUBLISHED: m('Published', 'منشور', 'success'),
  ARCHIVED: m('Archived', 'مؤرشف', 'neutral'),
};
const approval: MetaMap<ApprovalStatus> = {
  PENDING: m('Awaiting approval', 'بانتظار الموافقة', 'warning'),
  APPROVED: m('Approved', 'تمت الموافقة', 'success'),
  REJECTED: m('Rejected', 'مرفوض', 'danger'),
  CANCELLED: m('Cancelled', 'ملغي', 'neutral'),
};
const domain: MetaMap<DomainStatus> = {
  PENDING: m('Awaiting verification', 'بانتظار التحقق', 'warning'),
  VERIFIED: m('Verified', 'موثّق', 'success'),
  FAILED: m('Verification failed', 'فشل التحقق', 'danger'),
  DISABLED: m('Off', 'متوقف', 'neutral'),
};
const integration: MetaMap<IntegrationStatus> = {
  DISABLED: m('Off', 'متوقف', 'neutral'),
  CONFIGURED: m('Set up, not active', 'تم الإعداد، غير مفعّل', 'info'),
  ACTIVE: m('Active', 'نشط', 'success'),
  ERROR: m('Needs attention', 'يحتاج إلى مراجعة', 'danger'),
};
/** Invoices TypEase issues to the centre for its subscription. */
const subscriptionInvoice: MetaMap<SubscriptionInvoiceStatus> = {
  DRAFT: m('Draft', 'مسودة', 'neutral'),
  OPEN: m('Unpaid', 'غير مدفوعة', 'warning'),
  PAID: m('Paid', 'مدفوعة', 'success'),
  VOID: m('Void', 'ملغاة', 'neutral'),
  UNCOLLECTIBLE: m('Not collected', 'غير محصّلة', 'danger'),
};

export const STATUS_META = {
  request, requestCustomer, invoice, payment, requestPayment, quotation, refund, document, verification, checklist, appointment, task, ticket,
  customer, corporate, membership, subscription, tenant, priority, portalAccess,
  queue, reminder, reminderDispatch, notification, delivery, automationExecution, publish, approval, domain, integration, subscriptionInvoice,
} as const;

export type StatusKind = keyof typeof STATUS_META;

/** Meta for a status of a kind; unknown values (a status added to the API later) fall back to a neutral badge showing the raw value. */
export function statusMeta(kind: StatusKind, status: string): StatusMeta {
  const meta = (STATUS_META[kind] as Record<string, StatusMeta>)[status];
  if (meta) return meta;
  const readable = status.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  return { en: readable, ar: readable, tone: 'neutral' };
}
