/**
 * Domain events. Written to the transactional outbox in the same database
 * transaction as the change, then dispatched to automations, notifications
 * and (optionally) n8n by the worker.
 */
export const DOMAIN_EVENTS = {
  'customer.created': 'A customer was registered',
  'customer.merged': 'Two customer records were merged',
  'request.created': 'A service request was created',
  'request.submitted': 'A request was submitted for processing',
  'request.assigned': 'A request was assigned to a staff member',
  'request.status_changed': 'A request moved to a new status',
  'request.information_requested': 'Staff asked the customer for information or documents',
  'request.completed': 'A request was completed',
  'request.cancelled': 'A request was cancelled',
  'request.overdue': 'A request passed its target date',
  'request.step_overdue': 'A workflow step passed its time limit',
  'document.uploaded': 'A document was uploaded',
  'document.verified': 'A document was verified',
  'document.rejected': 'A document was rejected',
  'document.expiry_changed': 'The expiry date of a document was set or changed',
  'request.stage_overdue': 'A request stayed in a board column longer than its time limit',
  'paperwork.signature_requested': 'A ready-made document was issued and its signer was asked to sign',
  'paperwork.signed': 'A ready-made document was signed',
  'document.expiring': 'A tracked document is approaching expiry',
  'renewal.offered': 'A renewal (request and quotation) was prepared for an expiring document and offered to the customer',
  'quotation.sent': 'A quotation was sent to the customer',
  'quotation.approved': 'A quotation was approved',
  'quotation.rejected': 'A quotation was rejected',
  'invoice.issued': 'An invoice was issued',
  'invoice.voided': 'An invoice was voided',
  'invoice.payment_reminder': 'A payment reminder for an unpaid invoice is due',
  'creditnote.issued': 'A credit note was issued against an invoice',
  'payment.requested': 'A payment was requested',
  'payment.completed': 'A payment was completed',
  'payment.failed': 'A payment failed',
  'refund.requested': 'A refund was requested',
  'refund.completed': 'A refund was completed',
  'cash.shift_closed': 'A cash register shift was closed',
  'appointment.created': 'An appointment was booked',
  'appointment.reminder_due': 'An appointment reminder is due',
  'ticket.created': 'A support ticket was opened',
  'ticket.replied': 'A support ticket received a reply',
  'subscription.renewal_due': 'The TypEase subscription is about to renew',
  'subscription.payment_failed': 'A subscription payment failed',
  'staff.invited': 'A staff member was invited',
  'support_access.requested': 'TypEase support asked a centre for time-limited access',
  'support_access.decided': 'A support access request was approved, denied or revoked',
} as const;
export type DomainEventType = keyof typeof DOMAIN_EVENTS;

/** Events a tenant may use as an automation trigger. */
export const AUTOMATION_TRIGGERS: DomainEventType[] = [
  'customer.created', 'request.created', 'request.submitted', 'document.uploaded', 'document.verified',
  'quotation.approved', 'payment.completed', 'request.assigned', 'request.status_changed', 'request.completed',
  'request.overdue', 'request.step_overdue', 'document.expiring', 'appointment.created', 'subscription.renewal_due',
];

export const AUTOMATION_ACTIONS = {
  create_task: 'Create task',
  assign_staff: 'Assign staff',
  send_notification: 'Send notification',
  schedule_reminder: 'Schedule reminder',
  generate_document: 'Generate document',
  update_workflow_state: 'Update internal workflow state',
  request_approval: 'Request approval',
  create_follow_up: 'Create follow-up',
  escalate: 'Escalate overdue case',
  call_webhook: 'Call n8n / webhook',
} as const;
export type AutomationActionType = keyof typeof AUTOMATION_ACTIONS;

/** Events that can produce customer / staff notifications (template keys). */
export const NOTIFICATION_EVENTS = {
  'account.registered': 'Account registration',
  'account.email_verification': 'Email verification',
  'account.password_reset': 'Password reset',
  'account.otp': 'One-time passcode',
  'staff.invitation': 'Staff invitation',
  'request.created': 'New request',
  'request.documents_missing': 'Documents missing',
  'request.staff_assigned': 'Staff assigned',
  'request.status_changed': 'Case status changed',
  'request.completed': 'Application completed',
  'quotation.ready': 'Quotation ready',
  'payment.requested': 'Payment requested',
  'payment.received': 'Payment received',
  'appointment.confirmation': 'Appointment confirmation',
  'appointment.reminder': 'Appointment reminder',
  'document.expiry': 'Document expiry approaching',
  'document.rejected': 'Document rejected',
  'subscription.renewal': 'Subscription renewal',
  'subscription.payment_failed': 'Subscription payment failed',
  'support.response': 'Support response',
  'report.scheduled': 'Scheduled report',
  'support_access.requested': 'Support access requested',
  'support_access.decided': 'Support access decision',
  'cash.variance': 'Cash register difference',
  'invoice.reminder': 'Unpaid invoice reminder',
  'renewal.offer': 'Renewal ready to approve and pay',
  'request.stage_overdue': 'Request waiting too long in a board column',
  'paperwork.sign': 'Document ready to sign',
} as const;
export type NotificationEventKey = keyof typeof NOTIFICATION_EVENTS;
