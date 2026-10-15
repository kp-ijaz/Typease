/** Dynamic service form schema (ServiceFormDefinition.schema). */
export type FormFieldType =
  | 'text' | 'textarea' | 'number' | 'date' | 'email' | 'phone' | 'select' | 'multiselect' | 'checkbox' | 'radio' | 'country';

export interface FormField {
  key: string;
  label: string;
  labelAr?: string;
  type: FormFieldType;
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: Array<{ value: string; label: string; labelAr?: string }>;
  /** Only show when another field has one of these values. */
  showIf?: { field: string; in: Array<string | number | boolean> };
  /** Prefill from the customer profile, e.g. "customer.fullName", "customer.nationality". */
  prefillFrom?: string;
  /** Marks personal data so it is minimised in exports and logs. */
  sensitive?: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
  pattern?: string;
}
export interface FormStep {
  key: string;
  title: string;
  titleAr?: string;
  description?: string;
  fields: FormField[];
}
export interface FormSchema {
  steps: FormStep[];
}

export const PREFILL_SOURCES = [
  'customer.fullName', 'customer.fullNameAr', 'customer.email', 'customer.phone', 'customer.nationality',
  'customer.dateOfBirth', 'customer.passportCountry', 'customer.passportExpiry', 'customer.emiratesIdExpiry',
] as const;

/** Workflow rule language shared by workflow steps and automations. */
export type RuleOp = 'eq' | 'neq' | 'in' | 'nin' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists' | 'truthy';
export interface RuleCondition {
  fact: string;
  op: RuleOp;
  value?: unknown;
}
export interface Rule {
  all?: RuleCondition[];
  any?: RuleCondition[];
}

/** Facts available to workflow conditions. */
export const WORKFLOW_FACTS = [
  'service.code', 'service.categoryKey', 'service.requiresApproval', 'service.complianceCapability', 'service.paymentPolicy',
  'branch.code', 'customer.type', 'customer.isCorporate', 'request.priority', 'request.source',
  'documents.complete', 'payment.status', 'quotation.total', 'assignee.roleKey', 'approval.result',
] as const;

export const WORKFLOW_STEP_META = {
  CUSTOMER_FORM: { label: 'Customer form', waitsFor: 'form.completed', status: 'DRAFT' },
  DOCUMENT_UPLOAD: { label: 'Document upload', waitsFor: 'documents.uploaded', status: 'DRAFT' },
  STAFF_VERIFICATION: { label: 'Staff verification', waitsFor: 'documents.verified', status: 'UNDER_REVIEW' },
  QUOTATION: { label: 'Quotation', waitsFor: 'quotation.sent', status: 'UNDER_REVIEW' },
  CUSTOMER_APPROVAL: { label: 'Customer approval', waitsFor: 'quotation.approved', status: 'QUOTED' },
  PAYMENT: { label: 'Payment', waitsFor: 'payment.satisfied', status: 'AWAITING_PAYMENT' },
  STAFF_TASK: { label: 'Staff task', waitsFor: 'task.completed', status: 'IN_PREPARATION' },
  INTERNAL_APPROVAL: { label: 'Internal approval', waitsFor: 'approval.decided', status: 'PENDING_APPROVAL' },
  EXTERNAL_PROCESSING: { label: 'External / manual processing', waitsFor: 'external.result', status: 'READY_TO_SUBMIT' },
  DOCUMENT_GENERATION: { label: 'Document generation', waitsFor: null, status: null },
  NOTIFICATION: { label: 'Notification', waitsFor: null, status: null },
  CONDITIONAL_BRANCH: { label: 'Conditional branch', waitsFor: null, status: null },
  COMPLETION: { label: 'Completion', waitsFor: 'final.approved', status: 'FINAL_REVIEW' },
} as const;

export const DEFAULT_SERVICE_CATEGORIES = [
  { key: 'typing', name: 'Typing & Documentation', nameAr: 'الطباعة والمستندات', icon: 'file-text' },
  { key: 'visa', name: 'Visa Assistance', nameAr: 'المساعدة في التأشيرات', icon: 'plane' },
  { key: 'residence', name: 'Residence Assistance', nameAr: 'المساعدة في الإقامة', icon: 'home' },
  { key: 'emirates-id', name: 'Emirates ID Assistance', nameAr: 'المساعدة في الهوية الإماراتية', icon: 'id-card' },
  { key: 'labour', name: 'Labour & Employment Documents', nameAr: 'مستندات العمل والتوظيف', icon: 'briefcase' },
  { key: 'business', name: 'Business Setup Coordination', nameAr: 'تنسيق تأسيس الأعمال', icon: 'building' },
  { key: 'pro', name: 'PRO Services', nameAr: 'خدمات المندوب', icon: 'stamp' },
  { key: 'attestation', name: 'Attestation Coordination', nameAr: 'تنسيق التصديق', icon: 'badge-check' },
  { key: 'translation', name: 'Translation Coordination', nameAr: 'تنسيق الترجمة', icon: 'languages' },
  { key: 'printing', name: 'Printing & Scanning', nameAr: 'الطباعة والمسح الضوئي', icon: 'printer' },
  { key: 'corporate-docs', name: 'Corporate Document Administration', nameAr: 'إدارة مستندات الشركات', icon: 'folder' },
  { key: 'other', name: 'Other Services', nameAr: 'خدمات أخرى', icon: 'star' },
] as const;

export const DEFAULT_DOCUMENT_TYPES = [
  { key: 'passport', name: 'Passport', nameAr: 'جواز السفر', hasExpiry: true, ocrProfile: 'PASSPORT', reminderEnabled: true },
  { key: 'emirates_id', name: 'Emirates ID', nameAr: 'الهوية الإماراتية', hasExpiry: true, ocrProfile: 'EMIRATES_ID', reminderEnabled: true },
  { key: 'residence_visa', name: 'Residence Visa', nameAr: 'تأشيرة الإقامة', hasExpiry: true, ocrProfile: 'NONE', reminderEnabled: true },
  { key: 'trade_licence', name: 'Trade Licence', nameAr: 'الرخصة التجارية', hasExpiry: true, ocrProfile: 'TRADE_LICENCE', reminderEnabled: true },
  { key: 'labour_card', name: 'Labour Card / Work Permit', nameAr: 'بطاقة العمل', hasExpiry: true, ocrProfile: 'NONE', reminderEnabled: true },
  { key: 'employment_contract', name: 'Employment Contract', nameAr: 'عقد العمل', hasExpiry: true, ocrProfile: 'NONE', reminderEnabled: true },
  { key: 'photo', name: 'Personal Photo', nameAr: 'صورة شخصية', hasExpiry: false, ocrProfile: 'NONE', reminderEnabled: false },
  { key: 'tenancy_contract', name: 'Tenancy Contract', nameAr: 'عقد الإيجار', hasExpiry: true, ocrProfile: 'NONE', reminderEnabled: true },
  { key: 'certificate', name: 'Certificate', nameAr: 'شهادة', hasExpiry: false, ocrProfile: 'NONE', reminderEnabled: false },
  { key: 'completed_document', name: 'Completed Document', nameAr: 'المستند المكتمل', hasExpiry: false, ocrProfile: 'NONE', reminderEnabled: false },
  { key: 'other', name: 'Other Document', nameAr: 'مستند آخر', hasExpiry: false, ocrProfile: 'NONE', reminderEnabled: false },
] as const;

export const PLAN_LIMIT_KEYS = ['branches', 'staffUsers', 'monthlyRequests', 'storageMb', 'aiPages', 'notifications', 'corporateClients'] as const;
export type PlanLimitKey = (typeof PLAN_LIMIT_KEYS)[number];
export const PLAN_FEATURE_KEYS = ['whiteLabel', 'customDomains', 'apiAccess', 'corporatePortal', 'automation', 'aiAssistant', 'scheduledReports'] as const;
export type PlanFeatureKey = (typeof PLAN_FEATURE_KEYS)[number];
export type PlanLimits = Record<PlanLimitKey, number>;
export type PlanFeatures = Record<PlanFeatureKey, boolean>;
