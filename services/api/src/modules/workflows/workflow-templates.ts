import type { WorkflowStepDef } from './workflow-validator';

export interface WorkflowTemplate {
  key: 'standard' | 'walk-in-express' | 'pay-on-completion';
  name: string;
  description: string;
  steps: WorkflowStepDef[];
}

/** Capabilities under which the centre itself (or its partner) submits the application. */
const SUBMITTING_CAPABILITIES = ['PARTNER_COORDINATION', 'DIRECT_AUTHORISED'];

const form: WorkflowStepDef = { key: 'form', name: 'Application details', nameAr: 'بيانات الطلب', type: 'CUSTOMER_FORM', customerVisible: true };
const documents: WorkflowStepDef = { key: 'documents', name: 'Upload documents', nameAr: 'رفع المستندات', type: 'DOCUMENT_UPLOAD', customerVisible: true };
const verification: WorkflowStepDef = {
  key: 'verification', name: 'Document verification', nameAr: 'التحقق من المستندات', type: 'STAFF_VERIFICATION',
  timeoutHours: 24, escalateToRoleKey: 'manager', customerVisible: true,
};
const quotation: WorkflowStepDef = {
  key: 'quotation', name: 'Quotation', nameAr: 'عرض السعر', type: 'QUOTATION',
  assigneeRoleKey: 'receptionist', timeoutHours: 24, escalateToRoleKey: 'manager', customerVisible: true,
};
const customerApproval: WorkflowStepDef = {
  key: 'customer-approval', name: 'Quotation approval', nameAr: 'الموافقة على عرض السعر', type: 'CUSTOMER_APPROVAL',
  onRejectStepKey: 'quotation', timeoutHours: 72, escalateToRoleKey: 'manager', customerVisible: true,
};
const payment: WorkflowStepDef = { key: 'payment', name: 'Payment', nameAr: 'الدفع', type: 'PAYMENT', timeoutHours: 72, escalateToRoleKey: 'manager', customerVisible: true };
const prepare: WorkflowStepDef = {
  key: 'prepare', name: 'Prepare application', nameAr: 'تحضير الطلب', type: 'STAFF_TASK',
  assigneeRoleKey: 'operator', timeoutHours: 48, escalateToRoleKey: 'manager', customerVisible: true,
};
const review: WorkflowStepDef = {
  key: 'review', name: 'Review approval', nameAr: 'موافقة المدقق', type: 'INTERNAL_APPROVAL',
  conditions: { all: [{ fact: 'service.requiresApproval', op: 'truthy' }] },
  onRejectStepKey: 'prepare', assigneeRoleKey: 'reviewer', timeoutHours: 24, escalateToRoleKey: 'manager', customerVisible: false,
};
const submission: WorkflowStepDef = {
  key: 'submission', name: 'Submission and external processing', nameAr: 'التقديم والمعالجة الخارجية', type: 'EXTERNAL_PROCESSING',
  conditions: { all: [{ fact: 'service.complianceCapability', op: 'in', value: SUBMITTING_CAPABILITIES }] },
  assigneeRoleKey: 'operator', timeoutHours: 120, escalateToRoleKey: 'manager', customerVisible: true,
};
const completion: WorkflowStepDef = {
  key: 'completion', name: 'Final review and completion', nameAr: 'المراجعة النهائية والإنجاز', type: 'COMPLETION',
  assigneeRoleKey: 'reviewer', timeoutHours: 24, escalateToRoleKey: 'manager', customerVisible: true,
};

/**
 * Code-defined starting points. They are copied into each centre when it is
 * provisioned (as a workflow definition with one published version); after
 * that the centre owns its copy and can customise it through the builder.
 */
export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    key: 'standard',
    name: 'Standard service request',
    description: 'Form and documents, verification, quotation, payment before processing, preparation, review when the service requires it, submission where the centre is authorised, final review.',
    steps: [form, documents, verification, quotation, customerApproval, payment, prepare, review, submission, completion],
  },
  {
    key: 'walk-in-express',
    name: 'Walk-in express',
    description: 'For typing and printing while the customer waits: documents, quick check, quotation, payment, the job, hand-over.',
    steps: [
      documents,
      { ...verification, timeoutHours: 2 },
      { ...quotation, timeoutHours: 2 },
      { ...customerApproval, timeoutHours: 4 },
      { ...payment, timeoutHours: 4 },
      { ...prepare, key: 'task', name: 'Type / print the document', nameAr: 'طباعة المستند', timeoutHours: 4 },
      { ...completion, timeoutHours: 4 },
    ],
  },
  {
    key: 'pay-on-completion',
    name: 'Pay on completion',
    description: 'Like the standard workflow, but the customer pays when the work is finished. Use with services whose payment policy is "after completion" or "deposit".',
    steps: [form, documents, verification, quotation, customerApproval, prepare, review, submission, { ...payment, assigneeRoleKey: 'receptionist' }, completion],
  },
];

export const DEFAULT_TEMPLATE_KEY: WorkflowTemplate['key'] = 'standard';

export function findTemplate(key: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find((t) => t.key === key);
}
