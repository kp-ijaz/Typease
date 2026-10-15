/**
 * View models of the customer portal, modelled on the real answers of the API for a
 * signed-in customer (docs/api/modules/*.md). Entities and enums come from @typease/types;
 * what is declared here are the customer-shaped responses of the endpoints the portal calls.
 */
import type { Bilingual, RequestPaymentStatus, RequestSource } from '@typease/api-client';
import type {
  AppointmentStatus, ChecklistStatus, DocumentStatus, FormSchema, InvoiceStatus, PaymentStatus, QuotationStatus, ReminderStatus, RequestStatus, TicketStatus, VerificationStatus,
} from '@typease/types';

export type { Bilingual };

// ------------------------------------------------------------------ requests

export type StatusSource = 'INTERNAL' | 'STAFF_ENTERED' | 'PARTNER_PROVIDED' | 'VERIFIED_OFFICIAL';
export type ComplianceCapability = 'DOCUMENT_PREPARATION_ONLY' | 'INFORMATIONAL_ONLY' | 'PARTNER_COORDINATION' | 'DIRECT_AUTHORISED';
export type PaymentPolicy = 'BEFORE_PROCESSING' | 'DEPOSIT' | 'AFTER_COMPLETION';

export interface ChecklistDocument {
  id: string;
  title: string;
  documentTypeKey: string;
  status: DocumentStatus;
  verificationStatus: VerificationStatus;
  expiryDate: string | null;
  uploadedAt: string;
}
export interface ChecklistItem {
  id: string;
  /** INPUT = the customer provides it; COMPLETION = the centre produces it. */
  kind: 'INPUT' | 'COMPLETION';
  documentTypeKey: string;
  label: string;
  labelAr: string | null;
  isMandatory: boolean;
  status: ChecklistStatus;
  /** Why the document was not accepted. */
  note: string | null;
  /** The line the customer has to fix while the request waits for them. */
  actionRequired: boolean;
  document: ChecklistDocument | null;
}
export interface ExternalReference {
  id: string;
  channel: 'MANUAL_PORTAL' | 'AUTHORISED_PARTNER' | 'OFFICIAL_API';
  authorityName: string | null;
  referenceNo: string;
  status: string | null;
  statusSource: StatusSource;
  statusSourceLabel: Bilingual;
  result: 'COMPLETED' | 'RETURNED' | 'REJECTED' | null;
  recordedAt: string;
}
export interface RequestComment {
  id: string;
  authorType: 'STAFF' | 'CUSTOMER' | 'CORPORATE' | 'SYSTEM' | (string & {});
  authorName: string | null;
  body: string;
  visibility: 'INTERNAL' | 'CUSTOMER';
  createdAt: string;
}
export interface RequestQuotationSummary {
  id: string;
  quotationNo: string;
  status: QuotationStatus;
  total: string;
  currency: string;
  validUntil: string | null;
  sentAt: string | null;
}
export interface RequestInvoiceSummary {
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
export interface RequestFinance {
  quotation: RequestQuotationSummary | null;
  invoices: RequestInvoiceSummary[];
  totals: { invoiced: string; paid: string; refunded: string; balance: string } | null;
}
export interface WorkflowStep {
  key: string;
  name: string;
  nameAr: string | null;
  type: string;
  position: number;
  status: 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'SKIPPED' | 'CANCELLED' | 'FAILED' | (string & {});
  current: boolean;
  startedAt: string | null;
  completedAt: string | null;
}
export interface AllowedTransition {
  to: RequestStatus;
  action: string;
  requiresReason: boolean;
  enabled: boolean;
  blocked?: { code: string; message: string } | null;
}
export interface RequestHistoryEntry {
  id: string;
  status: RequestStatus;
  statusLabel: Bilingual;
  /** The centre's own words for this step when it wrote some, else the status label in English. */
  message: string | null;
  at: string;
}
export interface FormFieldValue {
  key: string;
  value: unknown;
  source: 'CUSTOMER' | 'STAFF' | 'PREFILL' | 'OCR' | (string & {});
  verified: boolean;
  updatedAt: string;
}

/** GET /requests/:id as a customer receives it. */
export interface RequestView {
  id: string;
  requestNo: string;
  status: RequestStatus;
  statusLabel: Bilingual;
  tone: string;
  source: RequestSource;
  paymentStatus: RequestPaymentStatus;
  version: number;
  branch: { id: string; code: string; name: string; nameAr: string | null };
  customer: { id: string; customerNo: string; fullName: string; fullNameAr: string | null; type: 'INDIVIDUAL' | 'BUSINESS' };
  service: { id: string; name: string; nameAr: string | null; code?: string };
  customerInstructions: string | null;
  submittedAt: string | null;
  targetDate: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  overdue: boolean;
  externalStatus: { status: string; source: StatusSource; sourceLabel: Bilingual; at: string } | null;
  renewalOfDocumentId: string | null;
  createdAt: string;
  updatedAt: string;
  form: { definitionId: string | null; schema: FormSchema | null; values: Record<string, unknown>; visibleFields: string[]; fields: FormFieldValue[] };
  checklist: ChecklistItem[];
  externalReferences: ExternalReference[];
  comments: RequestComment[];
  finance?: RequestFinance | null;
  workflow: { status: string; currentStepKey: string | null; steps: WorkflowStep[] } | null;
  allowedActions: { transitions: AllowedTransition[]; other: string[] };
  nextStep: { waitingOn: 'CUSTOMER' | 'CENTRE' | 'AUTHORITY' | 'NOBODY'; text: Bilingual } | null;
  history: RequestHistoryEntry[];
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
export type CreatedRequest = RequestView & { reuseCandidates?: ReuseCandidate[] };
export type SubmittedRequest = RequestView & { trackingCode?: string };

/** GET /documents/checklist-assist?requestId= */
export interface ChecklistAssistItem {
  checklistItemId: string;
  documentTypeKey: string;
  label: string;
  labelAr: string | null;
  kind: 'INPUT' | 'COMPLETION';
  isMandatory: boolean;
  checklistStatus: ChecklistStatus;
  state: 'PRESENT' | 'MISSING' | 'REJECTED' | 'EXPIRED' | 'EXPIRING' | 'UNVERIFIED' | 'WAIVED' | 'PROCESSING' | (string & {});
  hint: string | null;
  documentId: string | null;
  expiryDate: string | null;
  daysToExpiry: number | null;
  candidates: Array<{ documentId: string; title: string; verificationStatus: VerificationStatus; expiryDate: string | null }>;
}
export interface ChecklistAssist {
  requestId: string;
  items: ChecklistAssistItem[];
}

// ------------------------------------------------------------------ catalogue (signed in)

export interface PriceComponent {
  component: 'SERVICE_FEE' | 'GOVERNMENT_FEE' | 'THIRD_PARTY_FEE';
  amount: string;
  isEstimate: boolean;
  taxable: boolean;
  taxAmount: string;
  total: string;
}
export interface EffectivePrice {
  currency: string;
  serviceFee: string;
  governmentFeeEstimate: string;
  thirdPartyFeeEstimate: string;
  components: PriceComponent[];
  subtotal: string;
  taxAmount: string;
  total: string;
  paymentPolicy: PaymentPolicy;
  depositPercent: string | null;
  dueBeforeProcessing: string;
  containsEstimates: boolean;
}
export interface CatalogueCategory {
  key: string;
  name: string;
  nameAr: string | null;
  icon: string | null;
  serviceCount: number;
}
export interface CatalogueService {
  id: string;
  name: string;
  nameAr: string | null;
  description: string | null;
  descriptionAr: string | null;
  eligibilityGuidance: string | null;
  category: { key: string; name: string; nameAr: string | null; icon: string | null };
  complianceCapability: ComplianceCapability;
  estimatedProcessingHours: number | null;
  paymentPolicy: PaymentPolicy;
  onlineAvailable: boolean;
  allBranches: boolean;
  branchIds: string[];
  price: EffectivePrice | null;
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
export interface CatalogueServiceDetail extends CatalogueService {
  requirements: ServiceRequirement[];
  form: { id: string; version: number; schema: FormSchema } | null;
}
export interface Catalogue {
  categories: CatalogueCategory[];
  services: CatalogueService[];
}

// ------------------------------------------------------------------ documents

export interface DocumentVersion {
  id: string;
  versionNo: number;
  filename: string;
  mime: string;
  sizeBytes: number;
  uploadStatus: string;
  scanStatus: 'PENDING' | 'CLEAN' | 'INFECTED' | 'SKIPPED' | 'ERROR' | (string & {});
  scannedAt: string | null;
  createdAt: string;
  downloadable: boolean;
}
export interface DocumentRow {
  id: string;
  customerId: string | null;
  requestId: string | null;
  documentTypeKey: string;
  category: string | null;
  title: string;
  status: DocumentStatus;
  verificationStatus: VerificationStatus;
  verifiedAt: string | null;
  issuedDate: string | null;
  expiryDate: string | null;
  expiryVerified: boolean;
  /** A file the centre produced for the customer (the result of a request). */
  isCompletionDocument: boolean;
  uploadedByType: string;
  createdAt: string;
  updatedAt: string;
  downloadable: boolean;
  currentVersion: DocumentVersion | null;
}
export interface DocumentType {
  id: string;
  key: string;
  name: string;
  nameAr: string | null;
  hasExpiry: boolean;
  isActive: boolean;
}
export interface ReminderRow {
  id: string;
  documentTypeKey: string;
  documentTypeName: string;
  documentTypeNameAr: string | null;
  subjectLabel: string | null;
  expiryDate: string;
  daysLeft: number;
  status: ReminderStatus;
  nextReminderOn: string | null;
  renewalRequestId: string | null;
  /** `/requests/new?renewalOf=<scheduleId>` inside the portal. */
  renewalPath: string;
}

// ------------------------------------------------------------------ money

export type FeeComponent = 'SERVICE_FEE' | 'GOVERNMENT_FEE' | 'THIRD_PARTY_FEE';
export interface FinanceLine {
  id: string;
  description: string;
  component: FeeComponent;
  quantity: string;
  unitAmount: string;
  discountAmount: string;
  taxRatePercent: string;
  taxAmount: string;
  lineTotal: string;
  sortOrder: number;
}
interface FinanceTotals {
  currency: string;
  subtotalServiceFee: string;
  subtotalGovernmentFee: string;
  subtotalThirdParty: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
}
export interface QuotationRow extends FinanceTotals {
  id: string;
  quotationNo: string;
  requestId: string | null;
  status: QuotationStatus;
  validUntil: string | null;
  notes: string | null;
  sentAt: string | null;
  decidedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
  branch: { id: string; code: string; name: string } | null;
  request: { id: string; requestNo: string } | null;
  expired: boolean;
}
export interface QuotationDetail extends QuotationRow {
  quotationItems: FinanceLine[];
  invoice: { id: string; invoiceNo: string; status: InvoiceStatus; total: string; balanceDue: string; currency: string } | null;
}
export interface QuotationApproval {
  quotation: QuotationDetail;
  invoice: { id: string; invoiceNo: string; status: InvoiceStatus; total: string; balanceDue: string; currency: string; dueAt: string | null } | null;
}
export interface InvoiceRow extends FinanceTotals {
  id: string;
  invoiceNo: string;
  requestId: string | null;
  quotationId: string | null;
  status: InvoiceStatus;
  amountPaid: string;
  amountCredited: string;
  amountRefunded: string;
  balanceDue: string;
  issuedAt: string | null;
  dueAt: string | null;
  voidedAt: string | null;
  notes: string | null;
  createdAt: string;
  branch: { id: string; code: string; name: string } | null;
  request: { id: string; requestNo: string } | null;
  overdue: boolean;
}
/** One payment that settled (part of) an invoice, as GET /invoices/:id lists it. */
export interface InvoicePaymentAllocation {
  allocationId: string;
  /** How much of the payment went to this invoice. */
  allocated: string;
  /** The payment's id. */
  id: string;
  paymentNo: string;
  receiptNo: string | null;
  method: PaymentMethod;
  status: PaymentStatus;
  receivedAt: string | null;
  amount: string;
  refundedAmount: string;
}
export interface InvoiceDetail extends InvoiceRow {
  invoiceItems: FinanceLine[];
  quotation: { id: string; quotationNo: string } | null;
  payments: InvoicePaymentAllocation[];
  creditNotes: Array<{ id: string; creditNoteNo: string; amount: string; reason: string | null; status: string; issuedAt: string | null }>;
}
export type PaymentMethod = 'CASH' | 'CARD_POS' | 'BANK_TRANSFER' | 'CHEQUE' | 'ONLINE_GATEWAY' | (string & {});
export interface PaymentRow {
  id: string;
  paymentNo: string;
  receiptNo: string | null;
  method: PaymentMethod;
  status: PaymentStatus;
  amount: string;
  refundedAmount: string;
  currency: string;
  gateway: string | null;
  reference: string | null;
  failureReason: string | null;
  receivedAt: string | null;
  createdAt: string;
  paymentAllocations: Array<{ invoiceId: string; amount: string; invoice: { id?: string; invoiceNo: string; requestId?: string | null; status: InvoiceStatus; balanceDue: string } | null }>;
  unallocatedAmount: string;
}
export interface PaymentDetail extends PaymentRow {
  refunds: Array<{ id: string; amount: string; status: string; reason?: string | null; completedAt?: string | null; createdAt?: string }>;
}
/** POST /invoices/:id/pay */
export interface CheckoutSession {
  paymentId: string;
  paymentNo: string;
  status: PaymentStatus;
  invoiceId: string;
  amount: string;
  currency: string;
  gateway: string;
  testMode: boolean;
  checkoutUrl: string;
  expiresAt: string;
}

// ------------------------------------------------------------------ appointments

export interface AppointmentRow {
  id: string;
  branchId: string;
  branchName: string;
  branchNameAr: string | null;
  serviceId: string | null;
  serviceName: string | null;
  serviceNameAr: string | null;
  startsAt: string;
  endsAt: string;
  localDate: string;
  localTime: string;
  localEndTime: string;
  timezone: string;
  status: AppointmentStatus;
  cancelledReason: string | null;
  rescheduledFromId: string | null;
  rescheduledToId: string | null;
  canCancel: boolean;
  canReschedule: boolean;
}
export interface AvailabilitySlot {
  startsAt: string;
  endsAt: string;
  localStart: string;
  localEnd: string;
  available: boolean;
  remaining: number;
}
export interface Availability {
  branchId: string;
  branchName: string;
  date: string;
  timezone: string;
  closed: boolean;
  bookableUntil: string | null;
  slots: AvailabilitySlot[];
}
export interface BranchDirectoryEntry {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  address: string | null;
  emirate: string | null;
  phone: string | null;
  email: string | null;
  timezone: string;
  isHeadOffice: boolean;
  workingHours: Record<string, { open: string; close: string } | null> | null;
}

// ------------------------------------------------------------------ notifications

export interface InboxItem {
  id: string;
  eventKey: string;
  subject: string | null;
  body: string | null;
  language: string;
  relatedType: string | null;
  relatedId: string | null;
  readAt: string | null;
  createdAt: string;
}
export interface Inbox {
  data: InboxItem[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
  unreadCount: number;
}
export type NotificationChannel = 'EMAIL' | 'SMS' | 'WHATSAPP' | 'IN_APP' | 'PUSH';
export interface NotificationPreferences {
  channels: NotificationChannel[];
  groups: string[];
  channelDefaults: Partial<Record<'email' | 'sms' | 'whatsapp' | 'push', boolean>>;
  preferences: Array<{ channel: NotificationChannel; eventGroup: string; enabled: boolean }>;
  note: string | null;
}

// ------------------------------------------------------------------ support

export interface TicketMessage {
  id: string;
  fromSupport: boolean;
  authorName: string | null;
  body: string;
  attachments: Array<{ documentId: string; title: string }>;
  createdAt: string;
}
export interface TicketRow {
  id: string;
  ticketNo: string;
  subject: string;
  category: string | null;
  status: TicketStatus;
  requestId: string | null;
  requestNo: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  resolutionSummary: string | null;
  canReply: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface FeedbackEntry {
  id: string;
  rating: number;
  comment: string | null;
  ticketId: string | null;
  requestId: string | null;
  createdAt: string;
}
export interface TicketDetail extends TicketRow {
  messages: TicketMessage[];
  feedback: FeedbackEntry | null;
  canRate: boolean;
}

// ------------------------------------------------------------------ profile and privacy

export interface OwnCustomer {
  id: string;
  customerNo: string;
  type: 'INDIVIDUAL' | 'BUSINESS';
  fullName: string;
  fullNameAr: string | null;
  preferredLanguage: 'en' | 'ar' | (string & {});
  email: string | null;
  phone: string | null;
  nationality: string | null;
  dateOfBirth: string | null;
  address: { line1?: string | null; city?: string | null; emirate?: string | null; country?: string | null } | null;
  communicationPrefs: Partial<Record<'email' | 'sms' | 'whatsapp' | 'push', boolean>> | null;
  marketingOptIn: boolean;
  emiratesIdMasked: string | null;
  hasEmiratesId: boolean;
  emiratesIdExpiry: string | null;
  passportNoMasked: string | null;
  hasPassport: boolean;
  passportCountry: string | null;
  passportExpiry: string | null;
}
export type ConsentPurpose = 'SERVICE_PROCESSING' | 'REMINDERS' | 'MARKETING' | 'AI_PROCESSING' | 'DOCUMENT_REUSE' | 'WHATSAPP';
export interface ConsentState {
  purpose: ConsentPurpose;
  description: string;
  status: 'GRANTED' | 'WITHDRAWN' | 'NOT_SET';
  granted: boolean;
  lawfulBasis: string;
  grantedAt: string | null;
  withdrawnAt: string | null;
  updatedAt: string | null;
}
export type PrivacyRequestType = 'ACCESS' | 'CORRECTION' | 'DELETION' | 'EXPORT';
export interface PrivacyRequest {
  id: string;
  type: PrivacyRequestType;
  status: 'RECEIVED' | 'IN_REVIEW' | 'APPROVED' | 'REJECTED' | 'COMPLETED';
  details: string | null;
  decisionNote: string | null;
  retentionException: string | null;
  exportDocumentId: string | null;
  dueAt: string | null;
  overdue: boolean;
  completedAt: string | null;
  createdAt: string;
}
