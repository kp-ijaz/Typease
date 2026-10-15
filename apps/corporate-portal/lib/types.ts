/**
 * View models of the corporate portal, modelled on the real answers of the API for a company
 * administrator and for a company employee (docs/api/modules/*.md). Entities and enums come from
 * @typease/types; what is declared here are the portal-shaped responses of the endpoints we call.
 */
import type { Bilingual, RequestPaymentStatus, RequestSource } from '@typease/api-client';
import type { ChecklistStatus, DocumentStatus, FormSchema, InvoiceStatus, PaymentStatus, QuotationStatus, ReminderStatus, RequestStatus, TicketStatus, VerificationStatus } from '@typease/types';

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
/** Amounts are present for people who may see money; an employee of the company gets `amountsHidden: true` and the status only. */
export interface RequestQuotationSummary {
  id: string;
  quotationNo: string;
  status: QuotationStatus;
  total?: string;
  currency?: string;
  validUntil: string | null;
  sentAt: string | null;
}
export interface RequestInvoiceSummary {
  id: string;
  invoiceNo: string;
  status: InvoiceStatus;
  currency?: string;
  total?: string;
  amountPaid?: string;
  balanceDue?: string;
  issuedAt: string | null;
  dueAt: string | null;
}
export interface RequestFinance {
  amountsHidden?: boolean;
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

/** GET /requests/:id as a company user receives it. `finance` is null for employees (no `corp.invoices.read`). */
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
  /** The person (an employee) or, for `BUSINESS`, the company itself the request is for. */
  customer: { id: string; customerNo: string; fullName: string; fullNameAr: string | null; type: 'INDIVIDUAL' | 'BUSINESS'; erased?: boolean };
  /** Set when the request is billed to the company. */
  corporateAccount?: { id: string; accountNo: string; companyName: string } | null;
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
  /** COMPLETED requests only: the one rating a request gets, and whether the signed-in person may give it. */
  feedback?: FeedbackEntry | null;
  canRate?: boolean;
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
  /** `CORPORATE_CONTRACT` when the company's agreed fee replaces the catalogue fee. */
  serviceFeeSource?: 'CATALOGUE' | 'CORPORATE_CONTRACT' | (string & {});
  /** The catalogue fee the contract price replaces. */
  listServiceFee?: string;
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
  /** The person the document belongs to; null for a document of the company itself. */
  customerId: string | null;
  customerName?: string | null;
  customerErased?: boolean;
  requestNo?: string | null;
  corporateAccountId?: string | null;
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
  customerId?: string | null;
  customerName?: string | null;
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
  /** The employee (or the company's own record) the quotation is for. */
  customer?: { id: string; customerNo: string; fullName: string; erased?: boolean } | null;
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
  /** The employee (or the company's own record) the invoice was issued for. */
  customer?: { id: string; customerNo: string; fullName: string; erased?: boolean } | null;
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

// ------------------------------------------------------------------ branches

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
  /** null for company administrators (they have no customer record with contact preferences). */
  channelDefaults: Partial<Record<'email' | 'sms' | 'whatsapp' | 'push', boolean>> | null;
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

// ------------------------------------------------------------------ company (docs/api/modules/corporate.md)

export type CorporateStatus = 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
export interface BillingAddress {
  line1?: string | null;
  city?: string | null;
  emirate?: string | null;
  country?: string | null;
  poBox?: string | null;
}
/** GET /corporate/account. The typed client knows the fields the overview needs; these are the rest. */
export interface CompanyAccount {
  id: string;
  accountNo: string;
  companyName: string;
  companyNameAr: string | null;
  tradeLicenceNo: string | null;
  tradeLicenceAuthority: string | null;
  tradeLicenceExpiry: string | null;
  taxRegistrationNo: string | null;
  billingEmail: string | null;
  billingAddress: BillingAddress | null;
  status: CorporateStatus;
  verified: boolean;
  verifiedAt: string | null;
  credit: { approved: boolean; limit: string | null; paymentTermsDays: number };
  counters: { employees: number; members: number; openRequests: number; unpaidInvoices: number; unpaidInvoicesBalance: string; creditAvailable: string | null };
}
/** GET /corporate/members: the people who may act for the company in this portal. */
export interface CompanyMember {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  role: string;
  isAuthorisedSignatory: boolean;
  status: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'REMOVED';
  createdAt: string;
}
/** GET /corporate/roles: the company's roles (the centre's defaults until the company changes one). */
export interface CompanyRole {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
  memberCount: number;
  /** One of the two roles every company has: administrator or employee. */
  builtIn: boolean;
  baseKey: string | null;
  /** The administrator role: every company permission, always. */
  permissionsFixed: boolean;
  canDelete: boolean;
}
export interface RolePermissionDef {
  key: string;
  group: string;
  description: string;
}
/** GET /corporate/users: everybody with access to the company portal. */
export interface CompanyUser {
  id: string;
  fullName: string;
  email: string;
  status: 'INVITED' | 'ACTIVE' | 'SUSPENDED';
  type: 'COLLEAGUE' | 'EMPLOYEE';
  roleId: string;
  roleName: string;
  isMe: boolean;
}
/** GET /corporate/prices: the service fees agreed with the centre. */
export interface ContractPrice {
  id: string;
  serviceId: string;
  serviceName: string;
  serviceNameAr: string | null;
  contractServiceFee: string;
  catalogueServiceFee: string | null;
  currency: string;
}

export type EmployeeLoginStatus = 'NONE' | 'INVITED' | 'ACTIVE' | 'SUSPENDED';
export interface EmployeeLogin {
  status: EmployeeLoginStatus;
  email: string | null;
  invitedAt: string | null;
  joinedAt: string | null;
  lastLoginAt: string | null;
}
/** An employee as the company's administrators see it. Identity numbers arrive masked and stay masked. */
export interface Employee {
  id: string;
  corporateAccountId: string;
  /** The person's customer record: the filter key of their requests, documents and reminders. */
  customerId: string;
  /** The person's data was erased: the name is a placeholder and the record cannot be changed. */
  erased?: boolean;
  employeeNo: string | null;
  designation: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  createdAt: string;
  updatedAt: string;
  fullName: string;
  fullNameAr: string | null;
  email: string | null;
  phone: string | null;
  nationality: string | null;
  dateOfBirth: string | null;
  emiratesIdMasked: string | null;
  emiratesIdExpiry: string | null;
  passportNoMasked: string | null;
  passportCountry: string | null;
  passportExpiry: string | null;
  /** Absent on the rows of a bulk answer (new employees never have a login). */
  login?: EmployeeLogin;
  /** On create answers only. */
  outcome?: 'CREATED' | 'LINKED_EXISTING_CUSTOMER';
}
export interface BulkEmployeesResult {
  created: Array<Employee & { index: number }>;
  skipped: Array<{ index: number; reason: string; employeeId?: string; fullName: string }>;
  createdCount: number;
  skippedCount: number;
}
/** POST /corporate/employees/:id/login and POST /corporate/members. `dev` exists on development servers only. */
export interface InvitationResult {
  status: 'INVITED';
  email: string;
  dev?: { invitationToken?: string };
}

// ------------------------------------------------------------------ statement (GET /corporate/invoices/statement)

export type AgeingBucket = 'current' | 'days1to30' | 'days31to60' | 'days61to90' | 'days90plus';
export interface StatementInvoice {
  id: string;
  invoiceNo: string;
  issuedAt: string | null;
  dueAt: string | null;
  total: string;
  amountPaid: string;
  amountCredited: string;
  amountRefunded: string;
  balanceDue: string;
  status: InvoiceStatus;
  currency: string;
  requestId: string | null;
  requestNo?: string | null;
  customerId?: string | null;
  customerName?: string | null;
  customerErased?: boolean;
  bucket: AgeingBucket;
  daysOverdue: number;
}
export interface Statement {
  asOf: string;
  account: { id: string; accountNo: string; companyName: string; paymentTermsDays: number; creditApproved: boolean; creditLimit: string | null };
  currency: string;
  openBalance: string;
  availableCredit: string | null;
  ageing: Record<AgeingBucket, string>;
  invoices: StatementInvoice[];
}
