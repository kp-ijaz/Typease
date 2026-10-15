import type { DomainEventType, Rule } from '@typease/types';
import type { AutomationActionType } from '@typease/types';

/**
 * Ready-made automations. Creating a rule from a template copies it into the
 * centre as a DISABLED rule: the owner reviews texts, roles and conditions,
 * then switches it on. Templates only use the built-in roles (manager,
 * accountant, ...); a centre that renamed or removed one is told so when the
 * rule is created.
 */
export interface AutomationTemplate {
  key: string;
  name: string;
  description: string;
  category: 'Assignment' | 'Follow-up' | 'Customer communication' | 'Escalation' | 'Finance' | 'Documents' | 'Integration';
  triggerEvent: DomainEventType;
  conditions: Rule;
  actions: Array<{ type: AutomationActionType; config: Record<string, unknown> }>;
  maxRetries: number;
  /** What the centre has to have before the rule can be switched on. */
  requires?: string;
}

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    key: 'auto-assign-on-submission',
    name: 'Assign automatically when a request is submitted',
    description: 'Gives every newly submitted request to the best available operator (skills, shift and workload). Requests that already have an operator are left alone.',
    category: 'Assignment',
    triggerEvent: 'request.submitted',
    conditions: { all: [{ fact: 'request.isAssigned', op: 'eq', value: false }] },
    actions: [{ type: 'assign_staff', config: { mode: 'AUTO' } }],
    maxRetries: 3,
  },
  {
    key: 'follow-up-after-quotation-approved',
    name: 'Create a follow-up task 2 days after a quotation is approved',
    description: 'Puts a follow-up into the task list, due two days after the customer approved the quotation, so nobody forgets to check that the payment arrived and the work started.',
    category: 'Follow-up',
    triggerEvent: 'quotation.approved',
    conditions: {},
    actions: [
      {
        type: 'create_follow_up',
        config: { title: 'Follow up on {{requestNumber}}: quotation approved', description: '{{customerName}} approved the quotation for {{serviceName}}. Check that the payment was received and that preparation has started.', priority: 'NORMAL', dueInDays: 2 },
      },
    ],
    maxRetries: 3,
  },
  {
    key: 'notify-manager-request-overdue',
    name: 'Notify the manager when a request becomes overdue',
    description: 'Tells every manager (in the application and by email) as soon as a request passes its target date.',
    category: 'Escalation',
    triggerEvent: 'request.overdue',
    conditions: {},
    actions: [
      {
        type: 'send_notification',
        config: {
          to: 'ROLE',
          roleKey: 'manager',
          channels: ['IN_APP', 'EMAIL'],
          subject: 'Overdue: {{requestNumber}}',
          body: 'Request {{requestNumber}} ({{serviceName}}) passed its target date {{targetDate}}. Current status: {{statusLabel}}. Operator: {{assigneeName}}.\n\n[Open the request]({{centreLink}})',
        },
      },
    ],
    maxRetries: 3,
  },
  {
    key: 'escalate-overdue-step',
    name: 'Escalate a workflow step that passed its time limit',
    description: 'Creates an urgent escalation task for the managers and alerts them when a step of a workflow has been waiting longer than its time limit.',
    category: 'Escalation',
    triggerEvent: 'request.step_overdue',
    conditions: {},
    actions: [
      {
        type: 'escalate',
        config: { roleKey: 'manager', title: 'Step overdue on {{requestNumber}}: {{stepName}}', message: 'The step "{{stepName}}" of request {{requestNumber}} ({{serviceName}}) passed its time limit. Operator: {{assigneeName}}.', priority: 'URGENT', dueInHours: 4 },
      },
    ],
    maxRetries: 3,
  },
  {
    key: 'thank-customer-on-completion',
    name: 'Thank the customer when a request is completed',
    description: 'Sends the customer a short thank-you message by email and in the portal when their request is completed. Customers who opted out of emails only get the portal message.',
    category: 'Customer communication',
    triggerEvent: 'request.completed',
    conditions: {},
    actions: [
      {
        type: 'send_notification',
        config: {
          to: 'CUSTOMER',
          channels: ['EMAIL', 'IN_APP'],
          subject: 'Thank you - {{requestNumber}} is completed',
          body: 'Dear {{customerName}},\n\nyour request {{requestNumber}} ({{serviceName}}) is completed. Thank you for choosing {{centreName}}.\n\n[View your request]({{portalLink}})',
          purpose: 'SERVICE',
        },
      },
    ],
    maxRetries: 3,
  },
  {
    key: 'expiry-reminder-on-verification',
    name: 'Schedule an expiry reminder when a document is verified',
    description: 'When staff verify a document that has an expiry date, a reminder schedule is created so the customer is reminded before it expires (with their consent).',
    category: 'Documents',
    triggerEvent: 'document.verified',
    conditions: { all: [{ fact: 'document.hasExpiry', op: 'eq', value: true }] },
    actions: [{ type: 'schedule_reminder', config: {} }],
    maxRetries: 3,
  },
  {
    key: 'notify-accountant-payment-received',
    name: 'Notify the accountant when a payment is received',
    description: 'Tells every accountant in the application when a payment is completed, with the amount and the payment method.',
    category: 'Finance',
    triggerEvent: 'payment.completed',
    conditions: {},
    actions: [
      {
        type: 'send_notification',
        config: { to: 'ROLE', roleKey: 'accountant', channels: ['IN_APP'], subject: 'Payment received: {{amount}} {{currency}}', body: 'A payment of {{amount}} {{currency}} ({{paymentMethod}}) was received from {{customerName}}.\n\n[Open]({{centreLink}})' },
      },
    ],
    maxRetries: 3,
  },
  {
    key: 'send-new-requests-to-n8n',
    name: 'Send new requests to n8n',
    description: 'Calls your n8n workflow with a signed webhook whenever a request is submitted. Only identifiers and status values are sent, never names, identity numbers or documents.',
    category: 'Integration',
    triggerEvent: 'request.submitted',
    conditions: {},
    actions: [{ type: 'call_webhook', config: { path: '/typease/request-submitted' } }],
    maxRetries: 5,
    requires: 'An n8n connection under Integrations (webhook base address and signing secret).',
  },
  {
    key: 'welcome-task-new-customer',
    name: 'Create a welcome task when a customer registers online',
    description: 'Creates a task for reception to call or message customers who registered themselves in the portal, so their first request gets started.',
    category: 'Follow-up',
    triggerEvent: 'customer.created',
    conditions: { all: [{ fact: 'customer.source', op: 'eq', value: 'SELF_REGISTRATION' }] },
    actions: [{ type: 'create_task', config: { title: 'Welcome {{customerName}}', description: '{{customerName}} registered in the customer portal. Get in touch and offer help with their first request.', priority: 'NORMAL', type: 'GENERAL', roleKey: 'receptionist', dueInHours: 24 } }],
    maxRetries: 3,
  },
  {
    key: 'summary-document-ready-for-processing',
    name: 'Generate a summary sheet when a request is ready for processing',
    description: 'Stores an internal summary PDF of the request (details and checklist) in its documents when it becomes ready for processing, and tells the assigned operator.',
    category: 'Documents',
    triggerEvent: 'request.status_changed',
    conditions: { all: [{ fact: 'status.to', op: 'eq', value: 'READY_FOR_PROCESSING' }] },
    actions: [
      { type: 'generate_document', config: { title: 'Summary of {{requestNumber}}', documentTypeKey: 'other', customerVisible: false } },
      { type: 'send_notification', config: { to: 'ASSIGNEE', channels: ['IN_APP'], subject: '{{requestNumber}} is ready for processing', body: 'Request {{requestNumber}} ({{serviceName}}) is paid and ready. A summary sheet was added to its documents.\n\n[Open the request]({{centreLink}})' } },
    ],
    maxRetries: 3,
  },
];

export const findTemplate = (key: string) => AUTOMATION_TEMPLATES.find((t) => t.key === key);
