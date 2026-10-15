import type { RequestStatus } from './generated/models';

/**
 * The service-request state machine. This table is the single source of truth:
 * the API rejects any status change that is not listed here, and the web apps
 * use it to decide which actions to offer.
 */
export interface TransitionRule {
  to: RequestStatus;
  /** Staff need ANY of these permissions. Empty = not available to staff directly. */
  staff: string[];
  /** The owning customer / corporate admin may trigger it. */
  customer?: boolean;
  /** Fired by the workflow engine / automation in reaction to a domain event. */
  system?: boolean;
  /** A reason (shown in history) is mandatory. */
  reason?: boolean;
  /** Short verb for buttons. */
  action: string;
}

const t = (to: RequestStatus, action: string, staff: string[], extra: Partial<TransitionRule> = {}): TransitionRule => ({
  to,
  action,
  staff,
  ...extra,
});
const CANCEL = (customer = false) => t('CANCELLED', 'Cancel request', ['request.cancel'], { customer, reason: true });

export const REQUEST_TRANSITIONS: Record<RequestStatus, TransitionRule[]> = {
  DRAFT: [t('SUBMITTED', 'Submit', ['request.create', 'request.update'], { customer: true }), CANCEL(true)],
  SUBMITTED: [
    t('UNDER_REVIEW', 'Start review', ['document.verify', 'request.process', 'request.update'], { system: true }),
    t('AWAITING_CUSTOMER', 'Request information', ['document.verify', 'request.process', 'request.update'], { reason: true }),
    CANCEL(true),
  ],
  AWAITING_CUSTOMER: [
    t('UNDER_REVIEW', 'Resubmit', ['document.verify', 'request.update'], { customer: true, system: true }),
    t('IN_PREPARATION', 'Resume preparation', ['request.process'], { system: true }),
    CANCEL(true),
  ],
  UNDER_REVIEW: [
    t('AWAITING_CUSTOMER', 'Request information', ['document.verify', 'request.process'], { reason: true }),
    t('QUOTED', 'Send quotation', ['quotation.manage'], { system: true }),
    t('READY_FOR_PROCESSING', 'Approve for processing', ['document.verify'], { system: true }),
    CANCEL(true),
  ],
  QUOTED: [
    t('AWAITING_PAYMENT', 'Quotation approved', [], { system: true }),
    t('READY_FOR_PROCESSING', 'Quotation approved', [], { system: true }),
    t('UNDER_REVIEW', 'Revise quotation', ['quotation.manage'], { system: true }),
    CANCEL(true),
  ],
  AWAITING_PAYMENT: [
    t('READY_FOR_PROCESSING', 'Payment received', [], { system: true }),
    t('QUOTED', 'Revise quotation', ['quotation.manage'], { system: true }),
    CANCEL(true),
  ],
  READY_FOR_PROCESSING: [t('IN_PREPARATION', 'Start preparation', ['request.process']), CANCEL()],
  IN_PREPARATION: [
    t('PENDING_APPROVAL', 'Send for review', ['request.process']),
    t('READY_TO_SUBMIT', 'Mark ready to submit', ['request.process']),
    t('FINAL_REVIEW', 'Send to final review', ['request.process']),
    t('AWAITING_CUSTOMER', 'Request correction', ['request.process'], { reason: true }),
    CANCEL(),
  ],
  PENDING_APPROVAL: [
    t('READY_TO_SUBMIT', 'Approve', ['request.review']),
    t('IN_PREPARATION', 'Send back', ['request.review'], { reason: true }),
    CANCEL(),
  ],
  READY_TO_SUBMIT: [
    t('EXTERNAL_PROCESSING', 'Record submission', ['request.submit_external']),
    t('FINAL_REVIEW', 'Send to final review', ['request.process']),
    t('IN_PREPARATION', 'Back to preparation', ['request.process', 'request.review'], { reason: true }),
    CANCEL(),
  ],
  EXTERNAL_PROCESSING: [
    t('FINAL_REVIEW', 'Result received', ['request.process']),
    t('RETURNED', 'Mark returned', ['request.process'], { reason: true }),
    t('REJECTED', 'Mark rejected', ['request.process'], { reason: true }),
    CANCEL(),
  ],
  RETURNED: [
    t('IN_PREPARATION', 'Correct and resubmit', ['request.process']),
    t('AWAITING_CUSTOMER', 'Request correction', ['request.process'], { reason: true }),
    CANCEL(),
  ],
  REJECTED: [t('IN_PREPARATION', 'Prepare new application', ['request.process'], { reason: true }), CANCEL()],
  FINAL_REVIEW: [
    t('COMPLETED', 'Complete', ['request.review', 'request.reopen']),
    t('IN_PREPARATION', 'Send back', ['request.review', 'request.process'], { reason: true }),
  ],
  COMPLETED: [t('IN_PREPARATION', 'Reopen', ['request.reopen'], { reason: true })],
  CANCELLED: [],
};

export const TERMINAL_STATUSES: RequestStatus[] = ['COMPLETED', 'CANCELLED'];
export const OPEN_STATUSES = (Object.keys(REQUEST_TRANSITIONS) as RequestStatus[]).filter((s) => !TERMINAL_STATUSES.includes(s));

export function findTransition(from: RequestStatus, to: RequestStatus): TransitionRule | undefined {
  return REQUEST_TRANSITIONS[from]?.find((r) => r.to === to);
}

/** Dashboard buckets (section 10 of the product brief). */
export const STATUS_BUCKETS = {
  newRequests: ['SUBMITTED'],
  pendingVerification: ['UNDER_REVIEW'],
  awaitingCustomer: ['AWAITING_CUSTOMER', 'QUOTED'],
  awaitingPayment: ['AWAITING_PAYMENT'],
  readyForProcessing: ['READY_FOR_PROCESSING'],
  inProgress: ['IN_PREPARATION', 'PENDING_APPROVAL', 'READY_TO_SUBMIT', 'EXTERNAL_PROCESSING', 'RETURNED', 'REJECTED', 'FINAL_REVIEW'],
} satisfies Record<string, RequestStatus[]>;

type Tone = 'neutral' | 'info' | 'warning' | 'success' | 'danger';
export const REQUEST_STATUS_META: Record<RequestStatus, { en: string; ar: string; customerEn: string; customerAr: string; tone: Tone }> = {
  DRAFT: { en: 'Draft', ar: 'مسودة', customerEn: 'Draft — not submitted yet', customerAr: 'مسودة — لم تُرسل بعد', tone: 'neutral' },
  SUBMITTED: { en: 'New', ar: 'جديد', customerEn: 'Submitted', customerAr: 'تم الإرسال', tone: 'info' },
  AWAITING_CUSTOMER: { en: 'Awaiting customer', ar: 'بانتظار العميل', customerEn: 'Action needed from you', customerAr: 'مطلوب إجراء منك', tone: 'warning' },
  UNDER_REVIEW: { en: 'Documents under review', ar: 'مراجعة المستندات', customerEn: 'Documents under review', customerAr: 'المستندات قيد المراجعة', tone: 'info' },
  QUOTED: { en: 'Quotation sent', ar: 'تم إرسال عرض السعر', customerEn: 'Quotation ready for approval', customerAr: 'عرض السعر جاهز للموافقة', tone: 'warning' },
  AWAITING_PAYMENT: { en: 'Awaiting payment', ar: 'بانتظار الدفع', customerEn: 'Payment required', customerAr: 'الدفع مطلوب', tone: 'warning' },
  READY_FOR_PROCESSING: { en: 'Ready for processing', ar: 'جاهز للمعالجة', customerEn: 'Queued for processing', customerAr: 'في قائمة المعالجة', tone: 'info' },
  IN_PREPARATION: { en: 'In preparation', ar: 'قيد التحضير', customerEn: 'Being prepared', customerAr: 'قيد التحضير', tone: 'info' },
  PENDING_APPROVAL: { en: 'Pending review approval', ar: 'بانتظار موافقة المدقق', customerEn: 'Being prepared', customerAr: 'قيد التحضير', tone: 'info' },
  READY_TO_SUBMIT: { en: 'Ready to submit', ar: 'جاهز للتقديم', customerEn: 'Ready for submission', customerAr: 'جاهز للتقديم', tone: 'info' },
  EXTERNAL_PROCESSING: { en: 'External processing', ar: 'معالجة خارجية', customerEn: 'Submitted — in processing', customerAr: 'تم التقديم — قيد المعالجة', tone: 'info' },
  RETURNED: { en: 'Returned', ar: 'مُعاد', customerEn: 'Returned for correction', customerAr: 'أُعيد للتصحيح', tone: 'warning' },
  REJECTED: { en: 'Rejected', ar: 'مرفوض', customerEn: 'Application was not accepted', customerAr: 'لم يُقبل الطلب', tone: 'danger' },
  FINAL_REVIEW: { en: 'Final review', ar: 'المراجعة النهائية', customerEn: 'Final checks', customerAr: 'المراجعة النهائية', tone: 'info' },
  COMPLETED: { en: 'Completed', ar: 'مكتمل', customerEn: 'Completed', customerAr: 'مكتمل', tone: 'success' },
  CANCELLED: { en: 'Cancelled', ar: 'ملغي', customerEn: 'Cancelled', customerAr: 'ملغي', tone: 'neutral' },
};

/** How an external (authority / partner) status must be labelled wherever it is shown. */
export const STATUS_SOURCE_LABEL = {
  INTERNAL: { en: 'TypEase internal status', ar: 'حالة داخلية' },
  STAFF_ENTERED: { en: 'Entered by staff (not verified by the authority)', ar: 'أدخلها الموظف (غير مؤكدة من الجهة)' },
  PARTNER_PROVIDED: { en: 'Provided by partner', ar: 'مقدمة من الشريك' },
  VERIFIED_OFFICIAL: { en: 'Verified via official integration', ar: 'مؤكدة عبر الربط الرسمي' },
} as const;

/** Which submission channels each compliance capability permits. */
export const CAPABILITY_CHANNELS = {
  DOCUMENT_PREPARATION_ONLY: [],
  INFORMATIONAL_ONLY: [],
  PARTNER_COORDINATION: ['AUTHORISED_PARTNER'],
  DIRECT_AUTHORISED: ['MANUAL_PORTAL', 'OFFICIAL_API'],
} as const;
