/**
 * View models of the "cases" section, modelled on the real answers of the API
 * (docs/api/modules/requests.md, documents.md, ocr.md, tasks.md, catalogue.md).
 * Entities and enums come from @typease/types; what is declared here are the
 * joined shapes the endpoints return.
 */
import type { Bilingual, CustomerProfile, RequestPaymentStatus, RequestPriority, RequestSource } from '@typease/api-client';
import type {
  ChecklistStatus, DocumentStatus, FormSchema, InvoiceStatus, QuotationStatus, RequestStatus, TaskStatus, VerificationStatus,
} from '@typease/types';

export type { Bilingual, RequestPriority, RequestPaymentStatus, RequestSource };

export type ComplianceCapability = 'DOCUMENT_PREPARATION_ONLY' | 'INFORMATIONAL_ONLY' | 'PARTNER_COORDINATION' | 'DIRECT_AUTHORISED';
export type SubmissionChannel = 'MANUAL_PORTAL' | 'AUTHORISED_PARTNER' | 'OFFICIAL_API';
export type StatusSource = 'INTERNAL' | 'STAFF_ENTERED' | 'PARTNER_PROVIDED' | 'VERIFIED_OFFICIAL';
export type PaymentPolicy = 'BEFORE_PROCESSING' | 'DEPOSIT' | 'AFTER_COMPLETION';
export type FieldSource = 'CUSTOMER' | 'STAFF' | 'PREFILL' | 'OCR' | (string & {});

// ------------------------------------------------------------------ the case view

export interface CaseChecklistDocument {
  id: string;
  title: string;
  documentTypeKey: string;
  status: DocumentStatus;
  verificationStatus: VerificationStatus;
  expiryDate: string | null;
  uploadedAt: string;
}
export interface CaseChecklistItem {
  id: string;
  kind: 'INPUT' | 'COMPLETION';
  documentTypeKey: string;
  label: string;
  labelAr: string | null;
  isMandatory: boolean;
  status: ChecklistStatus;
  /** Why the document was rejected, or (staff) why the line was waived. */
  note: string | null;
  actionRequired: boolean;
  reviewedAt: string | null;
  document: CaseChecklistDocument | null;
}

export interface ExternalReference {
  id: string;
  channel: SubmissionChannel;
  authorityName: string | null;
  referenceNo: string;
  status: string | null;
  statusSource: StatusSource;
  statusSourceLabel: Bilingual;
  /** COMPLETED | RETURNED | REJECTED once the outcome is recorded. */
  result: 'COMPLETED' | 'RETURNED' | 'REJECTED' | null;
  recordedAt: string;
  partnerName: string | null;
  partnerReference: string | null;
  integrationId: string | null;
  notes?: string | null;
  recordedById?: string | null;
}

export interface CaseComment {
  id: string;
  authorType: 'STAFF' | 'CUSTOMER' | 'CORPORATE' | 'SYSTEM' | (string & {});
  authorName: string | null;
  body: string;
  visibility: 'INTERNAL' | 'CUSTOMER';
  createdAt: string;
}

export interface CaseQuotationSummary {
  id: string;
  quotationNo: string;
  status: QuotationStatus;
  total: string;
  currency: string;
  validUntil: string | null;
  sentAt: string | null;
}
export interface CaseInvoiceSummary {
  id: string;
  invoiceNo: string;
  status: InvoiceStatus;
  currency: string;
  total: string;
  amountPaid: string;
  balanceDue: string;
  issuedAt: string | null;
  dueAt: string | null;
}
export interface CaseFinance {
  quotation: CaseQuotationSummary | null;
  invoices: CaseInvoiceSummary[];
  totals: { invoiced: string; paid: string; refunded: string; balance: string } | null;
}

export interface WorkflowStepView {
  key: string;
  name: string;
  nameAr: string | null;
  type: string;
  position: number;
  status: 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'SKIPPED' | 'CANCELLED' | 'FAILED' | (string & {});
  current: boolean;
  startedAt: string | null;
  completedAt: string | null;
  attempt: number;
  dueAt: string | null;
  escalatedAt: string | null;
  assigneeRoleKey: string | null;
  waitsFor: string | null;
  blocked: { code: string; message: string } | null;
  note: string | null;
}
export interface CaseWorkflow {
  status: 'NOT_STARTED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | 'FAILED' | (string & {});
  currentStepKey: string | null;
  steps: WorkflowStepView[];
  definition?: { id: string; key: string; name: string } | null;
  version?: number | null;
  versionId?: string | null;
  migratedFromVersionId?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface AllowedTransition {
  to: RequestStatus;
  /** English verb from the state machine; translated by `cases.transitions.<FROM>.<TO>`. */
  action: string;
  requiresReason: boolean;
  enabled: boolean;
  blocked?: { code: string; message: string } | null;
}
export type OtherAction =
  | 'edit_fields' | 'edit_details' | 'assign' | 'auto_assign' | 'manage_checklist' | 'waive_checklist_item' | 'upload_documents' | 'resubmit'
  | 'decide_approval' | 'complete_step' | 'record_submission' | 'update_external_status' | 'record_external_result' | 'mark_duplicate'
  | 'migrate_workflow' | 'comment' | 'comment_internal';

export interface CaseHistoryEntry {
  id: string;
  from: RequestStatus | null;
  to: RequestStatus;
  toLabel: Bilingual;
  actorType: string;
  actorId: string | null;
  actorName: string | null;
  reason: string | null;
  customerVisible: boolean;
  customerMessage: string | null;
  meta: Record<string, unknown> | null;
  at: string;
}
export interface CaseAssignment {
  id: string;
  role: 'OPERATOR' | 'REVIEWER';
  method: 'MANUAL' | 'AUTO' | (string & {});
  reason: string | null;
  assigneeMembershipId: string;
  assigneeName: string;
  assigneeRoleKey: string | null;
  assignedAt: string;
  unassignedAt: string | null;
}
export interface CaseApproval {
  id: string;
  type: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  stepKey: string | null;
  requestedById: string | null;
  requestedByName: string | null;
  decidedById: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  comment: string | null;
  superseded: boolean;
  createdAt: string;
}
export interface CasePerson {
  membershipId: string;
  name: string;
  roleKey: string | null;
}

export interface CaseFormField {
  key: string;
  value: unknown;
  source: FieldSource;
  verified: boolean;
  updatedAt: string;
}

export interface CaseView {
  id: string;
  requestNo: string;
  status: RequestStatus;
  statusLabel: Bilingual;
  tone: string;
  priority: RequestPriority;
  source: RequestSource;
  paymentStatus: RequestPaymentStatus;
  version: number;
  branch: { id: string; code: string; name: string; nameAr: string | null };
  customer: { id: string; customerNo: string; fullName: string; fullNameAr: string | null; type: 'INDIVIDUAL' | 'BUSINESS'; email: string | null; phone: string | null };
  corporateAccount: { id: string; accountNo?: string; companyName: string; companyNameAr?: string | null } | null;
  service: {
    id: string;
    name: string;
    nameAr: string | null;
    code: string;
    categoryKey: string | null;
    complianceCapability: ComplianceCapability;
    requiresApproval: boolean;
    paymentPolicy: PaymentPolicy;
    depositPercent: string | null;
    estimatedProcessingHours: number | null;
    taxMode: string | null;
    permittedChannels: SubmissionChannel[];
  };
  customerInstructions: string | null;
  submittedAt: string | null;
  targetDate: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  overdue: boolean;
  submissionChannel: SubmissionChannel | null;
  externalStatus: { status: string; source: StatusSource; sourceLabel: Bilingual; at: string } | null;
  renewalOfDocumentId: string | null;
  createdAt: string;
  updatedAt: string;
  form: {
    definitionId: string | null;
    schema: FormSchema | null;
    values: Record<string, unknown>;
    visibleFields: string[];
    fields: CaseFormField[];
  };
  checklist: CaseChecklistItem[];
  externalReferences: ExternalReference[];
  comments: CaseComment[];
  /** Absent / null for roles that may not see amounts. */
  finance?: CaseFinance | null;
  workflow: CaseWorkflow;
  allowedActions: { transitions: AllowedTransition[]; other: OtherAction[] };
  nextStep: {
    waitingOn: 'CUSTOMER' | 'CENTRE' | 'AUTHORITY' | 'NOBODY';
    text: Bilingual;
    step: { key: string; name: string; type: string; waitsFor: string | null; dueAt: string | null; blocked: { code: string; message: string } | null } | null;
  };
  assignee: CasePerson | null;
  reviewer: CasePerson | null;
  cancellationReason: string | null;
  duplicateOfId: string | null;
  reopenedCount: number;
  workflowVersionId: string | null;
  createdByType: string;
  history: CaseHistoryEntry[];
  assignments: CaseAssignment[];
  approvals: CaseApproval[];
}

export interface ReuseCandidate {
  checklistItemId: string;
  documentId: string;
  documentTypeKey: string;
  title: string;
  expiryDate: string | null;
  verifiedAt: string | null;
  linked: boolean;
}
export type CreatedCase = CaseView & { reuseCandidates?: ReuseCandidate[] };
export type SubmittedCase = CaseView & { trackingCode?: string };

// ------------------------------------------------------------------ catalogue

export interface PriceComponent {
  component: 'SERVICE_FEE' | 'GOVERNMENT_FEE' | 'THIRD_PARTY_FEE';
  amount: string;
  isEstimate: boolean;
  taxable: boolean;
  taxAmount: string;
  total: string;
}
export interface EffectivePrice {
  serviceId: string;
  currency: string;
  serviceFee: string;
  serviceFeeSource: string;
  listServiceFee: string;
  governmentFeeEstimate: string;
  thirdPartyFeeEstimate: string;
  taxRatePercent: string;
  components: PriceComponent[];
  subtotal: string;
  taxAmount: string;
  total: string;
  paymentPolicy: PaymentPolicy;
  depositPercent: string | null;
  dueBeforeProcessing: string;
  containsEstimates: boolean;
}
export interface ServiceRequirement {
  id: string;
  documentTypeKey: string;
  label: string;
  labelAr: string | null;
  description: string | null;
  isMandatory: boolean;
  allowReuse: boolean;
  maxAgeDays: number | null;
}
export interface ServiceCategoryRef {
  id: string;
  key: string;
  name: string;
  nameAr: string | null;
  icon: string | null;
}
/** A row of GET /services (also the base of GET /services/:id/full). */
export interface ServiceRow {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  description: string | null;
  descriptionAr: string | null;
  eligibilityGuidance: string | null;
  complianceCapability: ComplianceCapability;
  estimatedProcessingHours: number | null;
  requiresApproval: boolean;
  paymentPolicy: PaymentPolicy;
  depositPercent: string | null;
  isActive: boolean;
  allBranches: boolean;
  branchIds: string[];
  category: ServiceCategoryRef | null;
  price: { serviceFee: string; governmentFeeEstimate: string | null; thirdPartyFeeEstimate: string | null; currency: string } | null;
}
export interface ServiceFull extends Omit<ServiceRow, 'price'> {
  price: EffectivePrice | null;
  requirements: ServiceRequirement[];
  form: { id: string; version: number; schema: FormSchema } | null;
}

// ------------------------------------------------------------------ customers

export interface CustomerDetail extends CustomerProfile {
  portalAccess?: { status: string; email: string | null; lastLoginAt: string | null } | string | null;
  counters?: { openRequests: number; totalRequests: number; documents: number; unpaidInvoices: number; unpaidInvoicesBalance: string } | null;
  corporateAccount?: { id: string; companyName: string; companyNameAr?: string | null; status?: string } | null;
}

// ------------------------------------------------------------------ finance (read side)

export interface FeeTotals {
  currency: string;
  subtotalServiceFee: string;
  subtotalGovernmentFee: string;
  subtotalThirdParty: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
}
export interface QuotationRow extends FeeTotals {
  id: string;
  quotationNo: string;
  status: QuotationStatus;
  validUntil: string | null;
  sentAt: string | null;
  decidedAt: string | null;
  createdAt: string;
  expired?: boolean;
}
export interface InvoiceRow extends FeeTotals {
  id: string;
  invoiceNo: string;
  status: InvoiceStatus;
  quotationId: string | null;
  amountPaid: string;
  amountCredited: string;
  amountRefunded: string;
  balanceDue: string;
  issuedAt: string | null;
  dueAt: string | null;
  overdue?: boolean;
}

// ------------------------------------------------------------------ documents

export interface DocumentVersion {
  id: string;
  versionNo: number;
  filename: string;
  mime: string;
  sizeBytes: number;
  uploadStatus: string;
  scanStatus: string;
  scannedAt: string | null;
  createdAt: string;
  downloadable: boolean;
  isCurrent?: boolean;
}
export interface DocumentRow {
  id: string;
  customerId: string | null;
  requestId: string | null;
  documentTypeKey: string;
  title: string;
  status: DocumentStatus;
  verificationStatus: VerificationStatus;
  verifiedAt: string | null;
  issuedDate: string | null;
  expiryDate: string | null;
  expiryVerified: boolean;
  isCompletionDocument: boolean;
  uploadedByType: string;
  createdAt: string;
  downloadable: boolean;
  currentVersion: DocumentVersion | null;
}
export interface DocumentDetail extends DocumentRow {
  versions: DocumentVersion[];
  checklist: Array<{ id: string; requestId: string; label: string; status: ChecklistStatus; kind: string }>;
  verifications?: Array<{ id: string; decision: 'APPROVED' | 'REJECTED' | 'CORRECTION_REQUESTED'; reason: string | null; createdAt: string }>;
}

export type AssistState = 'MISSING' | 'PROCESSING' | 'BLOCKED' | 'REJECTED' | 'EXPIRED' | 'EXPIRING' | 'UNVERIFIED' | 'PRESENT' | 'WAIVED';
export interface AssistCandidate {
  documentId: string;
  title: string;
  verificationStatus: VerificationStatus;
  expiryDate: string | null;
}
export interface AssistItem {
  checklistItemId: string;
  documentTypeKey: string;
  label: string;
  labelAr: string | null;
  kind: 'INPUT' | 'COMPLETION';
  isMandatory: boolean;
  checklistStatus: ChecklistStatus;
  state: AssistState;
  hint: string;
  documentId: string | null;
  verificationStatus: VerificationStatus | null;
  expiryDate: string | null;
  expiryVerified: boolean | null;
  daysToExpiry: number | null;
  candidates: AssistCandidate[];
}
export interface ChecklistAssist {
  requestId: string;
  expiringWithinDays: number;
  summary: {
    total: number; missing: number; rejected: number; expired: number; expiring: number; unverified: number; present: number; waived: number; processing: number;
    mandatoryInputsProvided: boolean;
    missingMandatory: string[];
  };
  items: AssistItem[];
}

// ------------------------------------------------------------------ AI document assistant

export type OcrStatus = 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'REVIEWED';
export interface OcrRunSummary {
  id: string;
  documentId: string;
  status: OcrStatus;
  profile: string | null;
  provider: string | null;
  error?: string | null;
  createdAt?: string;
  completedAt?: string | null;
}
export interface OcrField {
  key: string;
  label: string;
  canApply: boolean;
  extracted: { value: string | null; confidence: number; source: string } | null;
  onFile: { value: string | null; matches: boolean | null } | null;
  reviewed: { value: string | null; decision?: 'CONFIRMED' | 'CORRECTED' | 'ADDED' | 'REJECTED' | (string & {}) } | null;
}
export interface OcrWarning {
  code: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  field: string | null;
  message: string;
  suggestion?: { target: string; fieldKey: string } | null;
}
export interface OcrResult extends OcrRunSummary {
  unverified: boolean;
  notice: string | null;
  classification: string | null;
  classificationConfidence: number | null;
  pages: number | null;
  fields: OcrField[];
  warnings: OcrWarning[];
  reviewNote: string | null;
  applied: Array<{ at: string; by: string | null; keys: string[] }>;
}
export interface OcrUsage {
  aiEnabled: boolean;
  provider: { name: string; configured: boolean };
  plan: { includesAiAssistant: boolean; monthlyPageLimit: number };
  currentMonth: { period: string; pagesUsed: number; pagesRemaining: number };
}

// ------------------------------------------------------------------ tasks

export type TaskType = 'GENERAL' | 'FOLLOW_UP' | 'DOCUMENT_REVIEW' | 'APPROVAL' | 'ESCALATION' | 'WORKFLOW_STEP';
export type TaskSource = 'MANUAL' | 'WORKFLOW' | 'AUTOMATION' | 'ESCALATION';
export interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  type: TaskType;
  priority: RequestPriority;
  status: TaskStatus;
  source: TaskSource;
  workflowManaged: boolean;
  stepKey: string | null;
  roleKey: string | null;
  branchId: string | null;
  requestId: string | null;
  requestNo: string | null;
  customerId: string | null;
  customerName: string | null;
  dueAt: string | null;
  overdue: boolean;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  assignees: Array<{ membershipId: string; userId: string; name: string; assignedAt: string }>;
  assignedToMe: boolean;
  claimable: boolean;
}

/** GET /tenant: the part the case page reads. */
export interface CentreSettings {
  id: string;
  aiEnabled: boolean;
  defaultLanguage: string;
  settings?: { autoAssign?: boolean } | null;
}
