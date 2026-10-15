import type {
  AccessGrant, Branch, BrandingSettings, DataRetentionPolicy, DataSubjectRequest, IntegrationLog, PlanFeatures, PlanLimits, ProcessorRecord, Role, SecurityIncident,
  StaffSchedule, Tenant, TenantDomain, TenantMembership,
} from '@typease/types';

/** Response shapes of the "adm" endpoints, modelled on the real JSON (entities from @typease/types plus joined fields). */

// ---- tenant
export interface TenantSettings {
  allowSelfRegistration?: boolean;
  defaultTargetHours?: number;
  quotationValidityDays?: number;
  invoiceDueDays?: number;
  autoAssign?: boolean;
  requestNumberPrefix?: string;
  reminderOffsetsDays?: number[];
  queueDisplayLanguage?: 'en' | 'ar';
  [key: string]: unknown;
}
export type TenantDetail = Omit<Tenant, 'onboardingData' | 'settings'> & { settings: TenantSettings };
export interface UsageRow {
  metric: string;
  used: number;
  limit: number | null;
}
export interface TenantUsage {
  plan: { key: string; status: string; limits: PlanLimits; features: PlanFeatures } | null;
  usage: UsageRow[];
}

// ---- branches
export type WorkingDay = { open: string; close: string } | null;
export type WorkingHours = Partial<Record<'0' | '1' | '2' | '3' | '4' | '5' | '6', WorkingDay>>;
export type BranchRow = Omit<Branch, 'workingHours'> & { workingHours: WorkingHours | null };

// ---- staff
export interface StaffMember extends TenantMembership {
  user: { id: string; email: string; fullName: string; phone: string | null; mfaEnabled: boolean; lastLoginAt: string | null };
  role: { id: string; key: string; name: string };
  branchIds: string[];
  serviceIds: string[];
}
export interface WorkloadRow {
  membershipId: string;
  name: string;
  roleKey: string;
  roleName: string;
  isAvailable: boolean;
  openRequests: number;
  openTasks: number;
  completedLast30Days: number;
}
export type ScheduleEntry = Pick<StaffSchedule, 'branchId' | 'weekday' | 'startTime' | 'endTime'>;
export interface DevTokenReply {
  dev?: { invitationToken?: string };
}

// ---- roles
export interface RoleRow extends Role {
  permissions: string[];
  memberCount: number;
  /** The owner role (and a company's administrator role): every permission of its kind, always. */
  permissionsFixed: boolean;
  canDelete: boolean;
  requiresMfa: boolean;
}
export interface PermissionDef {
  key: string;
  group: string;
  description: string;
}

// ---- branding and domains
export type BrandingRow = BrandingSettings & { logoUrl: string | null; faviconUrl: string | null };
export interface BrandingState {
  tenant: BrandingRow | null;
  branches: BrandingRow[];
  whiteLabelIncluded: boolean;
  defaults: { primary: string; secondary: string; accent: string };
}
export interface DnsInstructions {
  txt: { name: string; value: string };
  cname: { name: string; value: string };
  note: string;
}
export type DomainRow = Omit<TenantDomain, 'verificationToken' | 'status'> & {
  /** The stored status, or the derived SUSPENDED_BY_PLAN: verified, but the centre's plan does not include custom domains. */
  status: TenantDomain['status'] | 'SUSPENDED_BY_PLAN';
  /** True only while the portal is reachable on the domain. */
  routed?: boolean;
  /** Unverified domains only: until when the claim blocks other centres, and when it is removed. */
  claim?: { releasableAt: string; expiresAt: string } | null;
  dns: DnsInstructions | null;
};
export interface DomainsState {
  platformDomain: string;
  customDomainsIncluded: boolean;
  domains: DomainRow[];
}
export type DomainVerifyResult = DomainRow & { verified: boolean; message: string | null };

// ---- integrations
export type IntegrationFieldType = 'string' | 'text' | 'number' | 'boolean' | 'email' | 'phone' | 'host' | 'url' | 'date' | 'languageCodes' | 'json';
export interface IntegrationField {
  key: string;
  label: string;
  help: string | null;
  type: IntegrationFieldType;
  required: boolean;
  maxLength: number | null;
  example: string | null;
}
export interface IntegrationProvider {
  category: string;
  provider: string;
  name: string;
  description: string;
  kind: 'CONNECTION' | 'AUTHORISATION_RECORD';
  multiple: boolean;
  modes: Array<'TEST' | 'LIVE'>;
  configFields: IntegrationField[];
  secretFields: IntegrationField[];
  requiresVerification: boolean;
  testable: boolean;
  testNote: string | null;
  usage: { effective: boolean; note: string };
  approved: boolean;
  configured: Array<{ id: string; instanceKey: string | null; status: string }>;
}
export interface IntegrationCategory {
  category: string;
  label: string;
  providers: IntegrationProvider[];
}
export interface IntegrationAuthorisation {
  state: 'PENDING' | 'VERIFIED' | 'REJECTED';
  note: string | null;
  evidenceDocumentId: string | null;
  submittedAt: string | null;
  verifiedAt: string | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  expired: boolean;
}
export interface IntegrationRow {
  id: string;
  category: string;
  provider: string;
  instanceKey: string | null;
  known: boolean;
  kind: 'CONNECTION' | 'AUTHORISATION_RECORD';
  name: string;
  status: 'CONFIGURED' | 'ACTIVE' | 'DISABLED' | 'ERROR';
  mode: 'TEST' | 'LIVE';
  config: Record<string, unknown>;
  secretKeys: string[];
  secretsUpdatedAt: string | null;
  missing: { config: string[]; secrets: string[] };
  ready: boolean;
  approved: boolean;
  testable: boolean;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  authorisation: IntegrationAuthorisation | null;
  usage: { effective: boolean; note: string };
  webhookUrl: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface IntegrationTestResult {
  supported: boolean;
  ok: boolean | null;
  message: string;
  testedAt: string | null;
}
export type IntegrationLogRow = IntegrationLog;

// ---- privacy
export interface PrivacyOverview {
  dataSubjectRequests: { open: number; overdue: number; openByType: Record<string, number>; completedLast90Days: number };
  consents: Array<{ purpose: string; granted: number; withdrawn: number }>;
  retention: { policiesInForce: number; policiesEnforcedAutomatically: number; documentsOnLegalHold: number; deletedDocumentsAwaitingPurge: number };
  incidents: { byStatus: Record<string, number> };
  processors: { total: number; pendingReview: number; crossBorder: number; crossBorderUnapproved: number };
  disclaimer: string;
}
export interface ErasureImpact {
  openRequests: number;
  unpaidInvoices: number;
  closedRequests: number;
  invoices: number;
  payments: number;
  documents: number;
  heldDocuments: number;
  canProceed: boolean;
}
/** `details.blocking` of 409 ERASURE_BLOCKED: what stands in the way of an erasure. */
export interface ErasureBlocking {
  requests: Array<{ id: string; requestNo: string; status: string }>;
  invoices: Array<{ id: string; invoiceNo: string; balanceDue: string; currency: string }>;
}
export type PrivacyRequestRow = Omit<DataSubjectRequest, 'tenantId'> & {
  overdue: boolean;
  customer: { id: string; customerNo: string; fullName: string; status: string } | null;
  erasureImpact?: ErasureImpact;
};
export type RetentionPolicyRow = DataRetentionPolicy & { enforced: boolean };
export interface ConsentRow {
  id: string;
  customerId: string;
  purpose: string;
  status: 'GRANTED' | 'WITHDRAWN';
  lawfulBasis: string;
  noticeVersion: string | null;
  grantedAt: string | null;
  withdrawnAt: string | null;
  updatedAt: string;
  customer: { id: string; customerNo: string; fullName: string } | null;
}
export type IncidentRow = SecurityIncident;
export type ProcessorRow = ProcessorRecord;

// ---- support access
export type SupportGrant = Omit<AccessGrant, 'tenantId' | 'requestedById' | 'scopes'> & {
  requestedByName: string;
  /** `write` marks the scopes that let TypEase support change something (today: internal notes on requests). */
  scopes: Array<{ key: string; description: string; write?: boolean }>;
  active: boolean;
};

// ---- onboarding
export type OnboardingStepKey = 'account' | 'business' | 'plan' | 'branding' | 'services' | 'branches' | 'staff';
export interface OnboardingState {
  tenantStatus: string;
  currentStep: number;
  draft: Record<string, Record<string, unknown> | undefined> | null;
  steps: Array<{ key: OnboardingStepKey; title: string; done: boolean; required: boolean; hint?: string }>;
  canComplete: boolean;
  completed: boolean;
  plan: { key: string; name: string; status: string; trialEndsAt: string | null } | null;
}
