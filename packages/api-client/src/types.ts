/**
 * Response shapes of the endpoints used by the app skeletons. Entity types come
 * from @typease/types; what is declared here are the API's view models (list
 * rows, counters, public catalogue ...) as documented in docs/api/modules.
 */
import type { AuthMembership, PasswordPolicy, PlanFeatures, PlanLimits, RequestStatus } from '@typease/types';

export interface Bilingual {
  en: string;
  ar: string;
}

// ---- requests
export type RequestPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
export type RequestSource = 'WALK_IN' | 'ONLINE' | 'MOBILE' | 'CORPORATE';
export type RequestBucket = 'newRequests' | 'pendingVerification' | 'awaitingCustomer' | 'awaitingPayment' | 'readyForProcessing' | 'inProgress' | 'completedToday' | 'overdue';
export type RequestPaymentStatus = 'UNPAID' | 'NOT_REQUIRED' | 'PARTIALLY_PAID' | 'PAID' | 'PARTIALLY_REFUNDED' | 'REFUNDED';

export interface RequestListItem {
  id: string;
  requestNo: string;
  status: RequestStatus;
  statusLabel: Bilingual;
  priority: RequestPriority;
  source: RequestSource;
  paymentStatus: RequestPaymentStatus;
  branchId: string;
  serviceId: string;
  corporateAccountId: string | null;
  customer: { id: string; customerNo: string; fullName: string };
  customerName: string;
  service: { id: string; name: string; nameAr: string | null; code?: string };
  serviceName: string;
  /** Not sent to customers. */
  assignee?: { membershipId: string; name: string } | null;
  assigneeName?: string | null;
  targetDate: string | null;
  overdue: boolean;
  /** Staff only: when the request entered its current status (board time limits). */
  statusSince?: string;
  submittedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  externalStatus: { status: string; source: string; sourceLabel: Bilingual; at: string } | null;
}
export interface RequestCounts {
  buckets: Record<RequestBucket, number>;
  byStatus: Partial<Record<RequestStatus, number>>;
  open: number;
  drafts: number;
}
export interface RequestListFilters {
  status?: RequestStatus | RequestStatus[];
  bucket?: RequestBucket;
  branchId?: string;
  assignedToId?: string;
  customerId?: string;
  corporateAccountId?: string;
  serviceId?: string;
  priority?: RequestPriority;
  source?: RequestSource;
  createdFrom?: string;
  createdTo?: string;
  submittedFrom?: string;
  submittedTo?: string;
  completedFrom?: string;
  completedTo?: string;
}
export interface PublicTrackingResult {
  requestNo: string;
  service: { name: string; nameAr: string | null };
  status: RequestStatus;
  statusLabel: Bilingual;
  submittedAt: string | null;
  completedAt: string | null;
  timeline: Array<{ status: RequestStatus; statusLabel: Bilingual; at: string }>;
  externalStatus: { status: string; source: string; sourceLabel: Bilingual; at: string } | null;
}

// ---- customers
export type CustomerStatus = 'ACTIVE' | 'ARCHIVED' | 'MERGED' | 'ANONYMISED';
export type PortalAccessStatus = 'NONE' | 'INVITED' | 'ACTIVE' | 'SUSPENDED';
export interface CustomerListItem {
  id: string;
  customerNo: string;
  type: 'INDIVIDUAL' | 'BUSINESS';
  status: CustomerStatus;
  fullName: string;
  fullNameAr: string | null;
  preferredLanguage: string;
  email: string | null;
  phone: string | null;
  nationality: string | null;
  corporateAccountId: string | null;
  mergedIntoId: string | null;
  lastActivityAt: string | null;
  createdAt: string;
  emiratesIdMasked: string | null;
  passportNoMasked: string | null;
  tags: Array<{ id: string; name: string; color: string | null }>;
  portalAccess: PortalAccessStatus | { status: PortalAccessStatus };
}
/** Profile returned by create / update. */
export interface CustomerProfile extends Omit<CustomerListItem, 'tags' | 'portalAccess'> {
  tenantId: string;
  dateOfBirth: string | null;
  /** UAE TRN of a business customer (15 digits), printed on its tax invoices. */
  taxRegistrationNo?: string | null;
  address: { line1?: string | null; city?: string | null; emirate?: string | null; country?: string | null } | null;
  hasEmiratesId: boolean;
  emiratesIdExpiry: string | null;
  hasPassport: boolean;
  passportCountry: string | null;
  passportExpiry: string | null;
  marketingOptIn: boolean;
  updatedAt: string;
  version: number;
}
export interface DuplicateCandidate {
  customer: CustomerListItem;
  signals: Array<'EMIRATES_ID' | 'PASSPORT' | 'PHONE' | 'EMAIL' | 'NAME'>;
  strength: 'STRONG' | 'WEAK';
}

// ---- organisation
export interface BranchSummary {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  emirate: string | null;
  isHeadOffice: boolean;
  isActive: boolean;
}

// ---- public catalogue
export interface PublicCategory {
  key: string;
  name: string;
  nameAr: string | null;
  icon: string | null;
  serviceCount: number;
}
export interface FeeEstimate {
  currency: string;
  serviceFee: string;
  governmentFeeEstimate: string;
  thirdPartyFeeEstimate: string;
  taxEstimate: string;
  totalEstimate: string;
  isEstimate: true;
}
export interface PublicService {
  id: string;
  name: string;
  nameAr: string | null;
  description: string | null;
  descriptionAr: string | null;
  eligibilityGuidance: string | null;
  category: { key: string; name: string; nameAr: string | null; icon: string | null };
  complianceCapability: 'DOCUMENT_PREPARATION_ONLY' | 'INFORMATIONAL_ONLY' | 'PARTNER_COORDINATION' | 'DIRECT_AUTHORISED';
  estimatedProcessingHours: number | null;
  onlineAvailable: boolean;
  requiredDocuments: Array<{ label: string; labelAr: string | null; description: string | null; isMandatory: boolean }>;
  feeEstimate: FeeEstimate | null;
}
export interface PublicCatalogue {
  centre: { slug: string; name: string; currency: string };
  categories: PublicCategory[];
  services: PublicService[];
}

// ---- plans
export interface PublicPlan {
  key: string;
  name: string;
  description: string | null;
  monthlyPrice: string;
  annualPrice: string;
  currency: string;
  trialDays: number;
  limits: PlanLimits;
  features: PlanFeatures;
  sortOrder: number;
  annualSaving: string;
}

// ---- corporate portal
export interface CorporatePortalAccount {
  id: string;
  accountNo: string;
  companyName: string;
  companyNameAr: string | null;
  tradeLicenceNo: string | null;
  tradeLicenceAuthority: string | null;
  tradeLicenceExpiry: string | null;
  taxRegistrationNo: string | null;
  billingEmail: string | null;
  status: 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
  verified: boolean;
  verifiedAt: string | null;
  credit: { approved: boolean; limit: string | null; paymentTermsDays: number };
  counters: { employees: number; members: number; openRequests: number; unpaidInvoices: number; unpaidInvoicesBalance: string; creditAvailable: string | null };
}

// ---- auth
/** Development servers return one-time tokens here (EXPOSE_DEV_TOKENS). Never present in production. */
export interface DevTokens {
  emailVerificationToken?: string;
  passwordResetToken?: string;
  invitationToken?: string;
  otp?: string;
}
export interface AuthSessionRow {
  id: string;
  app: string;
  tenantId: string | null;
  deviceName: string | null;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  /** A TypEase support session inside the centre (opened under an access grant), not one of the person's own devices. */
  supportSession?: boolean;
  current: boolean;
}
export interface MfaSetup {
  secret: string;
  otpauthUrl: string;
}
export interface InvitationPreview {
  email: string;
  fullName: string | null;
  centreName: string;
  roleName: string;
  needsPassword: boolean;
  app: string;
  /** The rules the new password must meet (absent on older API versions). */
  passwordPolicy?: PasswordPolicy;
}
export interface TenantSignupResult {
  tenantId: string;
  slug: string;
  status: 'VERIFICATION_SENT';
  email: string;
  dev?: DevTokens;
}
export type { AuthMembership };
