/**
 * View models of the "people" section, modelled on the real responses of the API
 * (docs/api/modules/customers.md, corporate.md, documents.md, ocr.md and the list
 * endpoints of the neighbouring modules that the read-only tabs call).
 */
import type { Bilingual, CustomerListItem, CustomerProfile, PortalAccessStatus } from '@typease/api-client';

// ---------------------------------------------------------------- customers

export interface CustomerTag {
  id: string;
  name: string;
  color: string | null;
  customerCount?: number;
}
export interface CustomerNote {
  id: string;
  customerId: string;
  authorId: string;
  authorName: string | null;
  body: string;
  isPinned: boolean;
  createdAt: string;
}
export type ContactType = 'EMAIL' | 'PHONE' | 'WHATSAPP';
export interface CustomerContact {
  id: string;
  type: ContactType;
  value: string;
  label: string | null;
  isPrimary: boolean;
}
export interface CustomerCounters {
  openRequests: number;
  totalRequests: number;
  documents: number;
  unpaidInvoices: number;
  unpaidInvoicesBalance: string;
  currency: string;
  upcomingAppointments: number;
  openTickets: number;
}
export interface CustomerOverview extends CustomerProfile {
  communicationPrefs: { email?: boolean; sms?: boolean; whatsapp?: boolean; push?: boolean } | null;
  corporateAccount: { id: string; accountNo: string; companyName: string; status: string } | null;
  mergedInto: { id: string; customerNo: string; fullName: string } | null;
  mergedFrom: Array<{ id: string; customerNo: string; fullName: string }>;
  tags: CustomerTag[];
  pinnedNotes: CustomerNote[];
  contacts: CustomerContact[];
  portalAccess: { status: PortalAccessStatus; email?: string | null; lastLoginAt?: string | null };
  counters: CustomerCounters;
}
export interface CustomerIdentity {
  customerId: string;
  customerNo: string;
  emiratesId: string | null;
  emiratesIdExpiry: string | null;
  passportNo: string | null;
  passportCountry: string | null;
  passportExpiry: string | null;
}
export type ConsentPurpose = 'SERVICE_PROCESSING' | 'REMINDERS' | 'MARKETING' | 'AI_PROCESSING' | 'DOCUMENT_REUSE' | 'WHATSAPP';
export type LawfulBasis = 'CONSENT' | 'CONTRACT' | 'LEGAL_OBLIGATION' | 'LEGITIMATE_INTEREST';
export interface ConsentState {
  purpose: ConsentPurpose;
  description: string;
  status: 'GRANTED' | 'WITHDRAWN' | 'NOT_SET';
  granted: boolean;
  lawfulBasis: LawfulBasis | null;
  noticeVersion: string | null;
  grantedAt: string | null;
  withdrawnAt: string | null;
  updatedAt: string | null;
}
export interface ConsentRecord {
  id: string;
  customerId: string;
  purpose: ConsentPurpose;
  status: 'GRANTED' | 'WITHDRAWN';
  lawfulBasis: LawfulBasis | null;
  noticeVersion: string | null;
  capturedVia: 'STAFF_RECORDED' | 'PORTAL' | 'MOBILE';
  capturedById: string | null;
  createdAt: string;
}
export interface CustomerConsents {
  consents: ConsentState[];
  history: ConsentRecord[];
}
export interface ActivityEntry {
  id: string;
  action: string;
  summary: string | null;
  actorType: string;
  actorLabel: string | null;
  actorUserId: string | null;
  resourceId: string;
  createdAt: string;
}
export interface MergeResult {
  target: CustomerProfile;
  source: { id: string; customerNo: string; status: string; mergedIntoId: string };
  moved: Record<string, number>;
  retainedOnSource: Record<string, number>;
  filledFields: string[];
}
export type { CustomerListItem, CustomerProfile, PortalAccessStatus };

// ---------------------------------------------------------------- rows of the read-only tabs (other modules)

export interface InvoiceRow {
  id: string;
  /** The record the invoice was issued to: after a merge this can be a retired record of the same person. */
  customerId: string | null;
  invoiceNo: string;
  status: string;
  currency: string;
  total: string;
  balanceDue: string;
  issuedAt: string | null;
  dueAt: string | null;
  createdAt: string;
  overdue: boolean;
  customer: { id: string; customerNo: string; fullName: string } | null;
  request: { id: string; requestNo: string } | null;
}
export interface PaymentRow {
  id: string;
  customerId: string | null;
  paymentNo: string;
  receiptNo: string | null;
  method: string;
  status: string;
  amount: string;
  refundedAmount: string;
  currency: string;
  reference: string | null;
  receivedAt: string | null;
  createdAt: string;
}
export interface AppointmentRow {
  id: string;
  branchName: string | null;
  serviceName: string | null;
  staffName: string | null;
  startsAt: string;
  localDate: string;
  localTime: string;
  localEndTime: string;
  status: string;
}
export interface NotificationRow {
  id: string;
  eventKey: string;
  eventLabel: string | null;
  channel: string;
  language: string;
  status: string;
  suppressedReason: string | null;
  recipientAddress: string | null;
  subject: string | null;
  createdAt: string;
  sentAt: string | null;
  lastError: string | null;
}
export interface ReminderRow {
  id: string;
  documentId: string | null;
  documentTypeKey: string;
  documentTypeName: string;
  documentTypeNameAr: string | null;
  subjectLabel: string | null;
  expiryDate: string;
  daysLeft: number;
  status: string;
  nextReminderOn: string | null;
  lastReminderAt: string | null;
}
export interface TicketRow {
  id: string;
  ticketNo: string;
  subject: string;
  category: string | null;
  priority: string;
  status: string;
  requestId: string | null;
  requestNo: string | null;
  assigneeName: string | null;
  resolutionBreached: boolean;
  createdAt: string;
}

// ---------------------------------------------------------------- documents

export type DocumentStatus = 'PENDING_UPLOAD' | 'PENDING_SCAN' | 'AVAILABLE' | 'QUARANTINED' | 'DELETED';
export type VerificationStatus = 'UNVERIFIED' | 'VERIFIED' | 'REJECTED';
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
  sha256?: string | null;
  scanEngine?: string | null;
  scanDetail?: string | null;
  uploadedById?: string | null;
  isCurrent?: boolean;
}
export interface DocumentRow {
  id: string;
  customerId: string | null;
  corporateAccountId: string | null;
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
  isCompletionDocument: boolean;
  uploadedByType: string;
  createdAt: string;
  updatedAt: string;
  downloadable: boolean;
  currentVersion: DocumentVersion | null;
  customerVisible?: boolean;
  legalHold?: boolean;
  retentionUntil?: string | null;
  verifiedById?: string | null;
  uploadedById?: string | null;
  deletedAt?: string | null;
  purgeAfter?: string | null;
}
export interface DocumentVerification {
  id: string;
  versionId: string | null;
  reviewerId: string | null;
  decision: 'APPROVED' | 'REJECTED' | 'CORRECTION_REQUESTED';
  reason: string | null;
  createdAt: string;
}
export interface DocumentDetail extends DocumentRow {
  versions: DocumentVersion[];
  checklist: Array<{ id: string; requestId: string; documentTypeKey: string; label: string; status: string; kind: string }>;
  verifications?: DocumentVerification[];
}
export interface DocumentShare {
  id: string;
  recipient: string | null;
  expiresAt: string;
  maxDownloads: number;
  downloadCount: number;
  revokedAt: string | null;
  createdAt: string;
  createdById?: string | null;
  active: boolean;
  /** Only in the answer to "create": shown once. */
  token?: string;
  url?: string;
}
export interface AccessLogRow {
  id: string;
  versionId: string | null;
  actorId: string | null;
  actorType: string;
  action: string;
  supportGrantId: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------- AI document assistant

export type OcrStatus = 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'REVIEWED';
export interface OcrSummary {
  id: string;
  documentId: string;
  versionId: string | null;
  status: OcrStatus;
  provider: string | null;
  profile: string | null;
  /** True until a person has reviewed the result. */
  unverified: boolean;
  classification: string | null;
  classificationConfidence: number | null;
  fieldCount: number;
  warningCount: { high: number; medium: number; low: number };
  pages: number | null;
  error: string | null;
  reviewedAt: string | null;
  createdAt: string;
  completedAt: string | null;
}
export interface OcrField {
  key: string;
  label: string;
  canApply: boolean;
  extracted: { value: string; confidence: number; source: string } | null;
  onFile: { value: string | null; matches: boolean | null } | null;
  reviewed: { value: string | null; decision: 'CONFIRMED' | 'CORRECTED' | 'ADDED' | 'REJECTED' } | null;
}
export interface OcrWarning {
  code: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  field?: string | null;
  message: string;
  suggestion?: { target: string; fieldKey: string } | null;
}
export interface OcrResult extends OcrSummary {
  customerId: string | null;
  notice: string | null;
  fields: OcrField[];
  warnings: OcrWarning[];
  reviewNote: string | null;
  applied: Array<{ at: string; by: string | null; keys: string[] }>;
}
export interface OcrUsage {
  aiEnabled: boolean;
  provider: { name: string; configured: boolean };
  plan: { includesAiAssistant: boolean; monthlyPageLimit: number | null };
  currentMonth: { period: string; pagesUsed: number; pagesRemaining: number | null };
}

// ---------------------------------------------------------------- corporate

export type CorporateStatus = 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
export interface BillingAddress {
  line1?: string | null;
  city?: string | null;
  emirate?: string | null;
  country?: string | null;
  poBox?: string | null;
}
export interface CorporateAccount {
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
  paymentTermsDays: number;
  creditLimit: string | null;
  creditApproved: boolean;
  status: CorporateStatus;
  verifiedById: string | null;
  verifiedAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  employeeCount?: number;
  memberCount?: number;
  creditApprovalWithdrawn?: boolean;
}
export interface CorporateCounters {
  employees: number;
  members: number;
  openRequests: number;
  totalRequests: number;
  unpaidInvoices: number;
  unpaidInvoicesBalance: string;
  creditAvailable: string | null;
}
export interface CorporateAccountDetail extends CorporateAccount {
  counters: CorporateCounters;
}
export interface CorporateMember {
  id: string;
  userId: string | null;
  fullName: string;
  email: string;
  phone: string | null;
  role: string;
  isAuthorisedSignatory: boolean;
  status: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'REMOVED';
  createdAt: string;
}
export interface CorporateEmployee {
  id: string;
  corporateAccountId: string;
  employeeNo: string | null;
  designation: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  createdAt: string;
  customerId: string;
  customerNo: string;
  customerStatus: string;
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
  /** Login for the corporate portal (role corporate_employee). Absent on the rows of a bulk response. */
  login?: EmployeeLogin;
  outcome?: 'CREATED' | 'LINKED_EXISTING_CUSTOMER';
}
export type EmployeeLoginStatus = 'NONE' | 'INVITED' | 'ACTIVE' | 'SUSPENDED';
export interface EmployeeLogin {
  status: EmployeeLoginStatus;
  email: string | null;
  invitedAt: string | null;
  joinedAt: string | null;
  lastLoginAt: string | null;
}
/** POST /corporate-accounts/:id/employees/:employeeId/login */
export interface EmployeeLoginInvited {
  employeeId: string;
  membershipId: string;
  status: 'INVITED';
  email: string;
}
export interface BulkEmployeesResult {
  created: Array<CorporateEmployee & { index: number }>;
  skipped: Array<{ index: number; reason: string; employeeId?: string; fullName: string }>;
  createdCount: number;
  skippedCount: number;
}
export type AgreementStatus = 'DRAFT' | 'ACTIVE' | 'EXPIRED' | 'TERMINATED';
export interface CorporateAgreement {
  id: string;
  title: string;
  terms: string | null;
  startsOn: string;
  endsOn: string | null;
  status: AgreementStatus;
  createdAt: string;
}
export interface ContractPrice {
  id: string;
  serviceId: string;
  serviceName: string;
  serviceNameAr: string | null;
  serviceCode: string;
  serviceActive: boolean;
  contractServiceFee: string;
  catalogueServiceFee: string | null;
  currency: string;
}
export interface CorporateStatement {
  asOf: string;
  currency: string;
  openBalance: string;
  availableCredit: string | null;
  ageing: { current: string; days1to30: string; days31to60: string; days61to90: string; days90plus: string };
  invoices: Array<{
    id: string;
    invoiceNo: string;
    issuedAt: string | null;
    dueAt: string | null;
    total: string;
    balanceDue: string;
    status: string;
    currency: string;
    requestId: string | null;
    bucket: string;
    daysOverdue: number;
  }>;
}
export interface PlanUsage {
  plan: {
    key: string;
    status: string;
    limits: Record<string, number | null>;
    features: Record<string, boolean>;
  };
  usage: Array<{ metric: string; used: number; limit: number | null }>;
}
export type { Bilingual };
