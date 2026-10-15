/**
 * Response shapes of the platform endpoints this console uses, modelled on the real
 * answers of the API (docs/api/modules/platform.md, subscriptions.md, support.md,
 * integrations.md, privacy.md). Entity enums come from @typease/types.
 */
import type {
  AccessGrantStatus, BillingCycle, DomainStatus, IntegrationStatus, MembershipStatus, PlanFeatures, PlanLimitKey, PlanLimits, PlatformRole, RequestPriority, SubscriptionInvoiceStatus, SubscriptionStatus,
  TenantStatus, TicketStatus,
} from '@typease/types';

export type { AccessGrantStatus, BillingCycle, PlatformRole, SubscriptionStatus, TenantStatus, TicketStatus };
export type TicketPriority = RequestPriority;

export interface CentreRef {
  id: string;
  name: string;
  slug: string;
  status?: TenantStatus;
}

// ---------------------------------------------------------------- dashboard and reports

export interface CurrencyAmount {
  currency: string;
  total: string;
}
// The system status types are shared with the API (@typease/types): health, queues, worker heartbeat, providers.
export type { SystemHealth, SystemProvider, SystemProviders, SystemProviderStatus, SystemQueueCounts, SystemStorageHealth, SystemWorkerLiveness } from '@typease/types';
import type { SystemHealth } from '@typease/types';
export interface FailedPaymentTotals {
  openInvoices: number;
  amounts: CurrencyAmount[];
  subscriptionsPastDue: number;
  subscriptionsInGrace: number;
}
export interface PlatformDashboard {
  generatedAt: string;
  tenants: { total: number; active: number; trial: number; onboarding: number; pendingApproval: number; pastDue: number; suspended: number; cancelled: number; archived: number };
  revenue: Array<{ currency: string; mrr: string; arr: string; subscriptions: number }>;
  churn: { from: string; to: string; activeAtStart: number; churned: number; ratePercent: string | null };
  failedPayments: FailedPaymentTotals;
  usage: {
    period: string;
    storage: { bytes: number; gigabytes: number };
    notifications: { counted: number; deliveriesByChannel: Record<string, { sent: number; failed: number }> };
    requests: number;
    ai: { pages: number; calls: number; cost: Array<{ currency: string; estimate: string }> };
  };
  supportTickets: { byStatus: Record<TicketStatus, number>; open: number; total: number };
  systemHealth: SystemHealth;
}
export interface TenantGrowthReport {
  from: string;
  to: string;
  interval: 'day' | 'week' | 'month';
  series: Array<{ period: string; from: string; new: number; total: number }>;
}
export interface SubscriptionRevenueReport {
  from: string;
  to: string;
  series: Array<{ period: string; lines: Array<{ currency: string; invoices: number; total: string; tax: string; discount: string }> }>;
  totals: Array<{ currency: string; invoices: number; total: string }>;
}
export interface PlanDistributionReport {
  total: number;
  centresWithoutSubscription: number;
  plans: Array<{ planKey: string; planName: string; currency: string; mrr: string; arr: string; subscriptions: number; byStatus: Partial<Record<SubscriptionStatus, number>>; byCycle: Record<BillingCycle, number> }>;
}
export interface UsageReport {
  from: string;
  to: string;
  storage: { bytes: number; topCentres: Array<{ centre: CentreRef; bytes: number }> };
  series: Array<{ period: string; requests: number; notifications: number; aiPages: number }>;
}
export interface FailedPaymentRow {
  id: string;
  number: string;
  reason: string;
  total: string;
  currency: string;
  dueAt: string;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  centre: CentreRef;
  subscriptionStatus: SubscriptionStatus;
  graceEndsAt: string | null;
  plan: { key: string; name: string };
}

// ---------------------------------------------------------------- tenants

export interface TenantRow {
  id: string;
  slug: string;
  name: string;
  legalName: string | null;
  status: TenantStatus;
  emirate: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  suspendedAt: string | null;
  suspensionReason: string | null;
  archivedAt: string | null;
  offboardingAt: string | null;
  createdAt: string;
  plan: { key: string; name: string } | null;
  subscription: { status: SubscriptionStatus; billingCycle: BillingCycle; currentPeriodEnd: string | null; trialEndsAt: string | null } | null;
}
export interface TenantOwner {
  membershipId: string;
  userId: string;
  fullName: string;
  email: string;
  phone: string | null;
  status: MembershipStatus;
  accountStatus: 'ACTIVE' | 'DISABLED';
  emailVerified: boolean;
  mfaEnabled: boolean;
  invitedAt: string | null;
  joinedAt: string | null;
  lastLoginAt: string | null;
}
export interface UsageLine {
  metric: PlanLimitKey;
  used: number;
  /** -1 = unlimited, 0 = not part of the plan. */
  limit: number;
}
export interface TenantDomain {
  id: string;
  domain: string;
  kind: string;
  app: string;
  status: DomainStatus;
  isPrimary: boolean;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  lastCheckError: string | null;
}
export interface TenantDetail {
  id: string;
  slug: string;
  name: string;
  legalName: string | null;
  status: TenantStatus;
  suspendedAt: string | null;
  suspensionReason: string | null;
  approvedAt: string | null;
  archivedAt: string | null;
  offboardingAt: string | null;
  offboarding: { purgeAt: string; scheduledAt: string; scheduledBy: string | null; reason: string; immediate: boolean; dataExport: string } | null;
  createdAt: string;
  profile: {
    country: string | null;
    emirate: string | null;
    timezone: string;
    defaultCurrency: string;
    defaultLanguage: string;
    contactEmail: string | null;
    contactPhone: string | null;
    tradeLicenceNo: string | null;
    taxRegistrationNo: string | null;
    aiEnabled: boolean;
  };
  owners: TenantOwner[];
  subscription: {
    id: string;
    status: SubscriptionStatus;
    billingCycle: BillingCycle;
    plan: { key: string; name: string; monthlyPrice: string; annualPrice: string; currency: string };
    pendingPlan: { key: string; name: string } | null;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    trialEndsAt: string | null;
    graceEndsAt: string | null;
    cancelAtPeriodEnd: boolean;
    cancelledAt: string | null;
  } | null;
  usage: UsageLine[];
  counts: { branches: { total: number; active: number }; staff: { active: number; invited: number; suspended: number } };
  domains: TenantDomain[];
  onboarding: { currentStep: number; completed: boolean; canComplete: boolean; steps: Array<{ key: string; title: string; done: boolean; required: boolean }> } | null;
  lastActivity: { at: string | null; lastSessionAt: string | null; lastLoginAt: string | null; lastAuditedActionAt: string | null } | null;
  support: { openPlatformTickets: number; pendingAccessRequests: number; activeAccessGrants: number };
}
export interface TenantCreated extends TenantDetail {
  plan: { outcome: 'TRIAL_STARTED' | 'PAYMENT_REQUIRED' | 'ACTIVE' | 'FAILED'; invoiceId?: string | null; code?: string; message?: string } | null;
  invitation: { email: string; status: string; dev?: { invitationToken?: string } } | null;
}

// ---------------------------------------------------------------- plans, coupons, billing

export interface PlatformPlan {
  id: string;
  key: string;
  name: string;
  description: string | null;
  monthlyPrice: string;
  annualPrice: string;
  currency: string;
  trialDays: number;
  limits: PlanLimits;
  features: PlanFeatures;
  isPublic: boolean;
  isActive: boolean;
  sortOrder: number;
  subscriptionCount?: number;
  pendingCount?: number;
}
export interface Coupon {
  id: string;
  code: string;
  description: string | null;
  percentOff: string | null;
  amountOff: string | null;
  currency: string;
  durationMonths: number | null;
  maxRedemptions: number | null;
  redeemedCount: number;
  planKeys: string[];
  validFrom: string | null;
  validUntil: string | null;
  isActive: boolean;
  createdAt: string;
  activeSubscriptions: number;
}
export interface CouponRef {
  id?: string;
  code: string;
  percentOff: string | null;
  amountOff: string | null;
  currency?: string;
}
export interface SubscriptionRow {
  id: string;
  tenantId: string;
  status: SubscriptionStatus;
  billingCycle: BillingCycle;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  graceEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  cancelledAt: string | null;
  cancellationReason: string | null;
  pendingCycle: BillingCycle | null;
  couponEndsAt: string | null;
  createdAt: string;
  updatedAt: string;
  tenant: CentreRef;
  plan: { key: string; name: string; monthlyPrice: string; annualPrice: string; currency: string };
  pendingPlan: { key: string; name: string } | null;
  coupon: CouponRef | null;
}
export interface SubscriptionInvoice {
  id: string;
  number: string;
  status: SubscriptionInvoiceStatus;
  reason: string;
  periodStart: string | null;
  periodEnd: string | null;
  subtotal: string;
  discount: string;
  tax: string;
  total: string;
  currency: string;
  lines: Array<{ amount: string; description: string; planName?: string; couponCode?: string | null }>;
  dueAt: string | null;
  paidAt: string | null;
  paymentMethod: string | null;
  gatewayRef: string | null;
  attemptCount: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
}
export interface SubscriptionEvent {
  id: string;
  type: string;
  data: Record<string, unknown> | null;
  actorId: string | null;
  createdAt: string;
}
export interface BillingHistory {
  tenant: { id: string; slug: string; name: string; status: TenantStatus; suspensionReason: string | null };
  subscription:
    | (Omit<SubscriptionRow, 'tenant' | 'plan'> & { plan: PlatformPlan })
    | null;
  invoices: SubscriptionInvoice[];
  events: SubscriptionEvent[];
}
export interface PlanChangeResult extends BillingHistory {
  change: { kind: 'UPGRADE' | 'DOWNGRADE' | 'CYCLE_ONLY' | 'WITHDRAWN' | string; effective: string; invoiceId: string | null; amount: string | null };
}

// ---------------------------------------------------------------- support desk

export interface PlatformTicketMessage {
  id: string;
  fromCentre: boolean;
  authorType: string;
  authorName: string | null;
  visibility: 'CUSTOMER' | 'INTERNAL';
  body: string;
  createdAt: string;
}
export interface PlatformTicket {
  id: string;
  ticketNo: string;
  tenant: CentreRef & { plan: { key: string; name: string; status: SubscriptionStatus } | null };
  subject: string;
  category: string | null;
  priority: TicketPriority;
  status: TicketStatus;
  platformAssigneeId: string | null;
  platformAssigneeName: string | null;
  firstRespondedAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  resolutionSummary: string | null;
  createdAt: string;
  updatedAt: string;
  messages?: PlatformTicketMessage[];
}

// ---------------------------------------------------------------- support access

export interface AccessGrant {
  id: string;
  centre: CentreRef;
  requestedById: string;
  requestedByName: string | null;
  reason: string;
  scopes: string[];
  ticketId: string | null;
  status: AccessGrantStatus;
  durationMinutes: number;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  startsAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  usable: boolean;
  createdAt: string;
}

// ---------------------------------------------------------------- feature flags and settings

export interface FeatureFlag {
  key: string;
  enabled: boolean;
  hasGlobalDefault: boolean;
  payload: Record<string, unknown> | null;
  updatedAt: string | null;
  overrides: { total: number; enabled: number; disabled: number };
}
export interface FlagOverride {
  centre: CentreRef;
  enabled: boolean;
  payload: Record<string, unknown> | null;
  updatedAt: string | null;
}
export interface TenantFlag {
  key: string;
  enabled: boolean;
  source: 'TENANT' | 'GLOBAL' | 'NONE';
  /** The platform default; false when there is none. */
  globalDefault: boolean;
  payload: Record<string, unknown> | null;
}
export interface PlatformSetting<V = unknown> {
  key: string;
  description: string;
  usedBy: string;
  value: V;
  isDefault: boolean;
  defaultValue: V;
  updatedAt: string | null;
}

// ---------------------------------------------------------------- staff

export interface PlatformStaffMember {
  id: string;
  email: string;
  fullName: string;
  role: PlatformRole;
  roleName: string;
  status: 'ACTIVE' | 'DISABLED';
  mfaEnabled: boolean;
  invitationPending: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  isYou: boolean;
}

// ---------------------------------------------------------------- audit and security

export type AuditActorType = 'STAFF' | 'CUSTOMER' | 'CORPORATE' | 'PLATFORM' | 'SYSTEM' | 'AUTOMATION';
export interface AuditEntry {
  id: string;
  createdAt: string;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  summary: string | null;
  actorType: AuditActorType;
  actorLabel: string | null;
  actorUserId: string | null;
  requestId: string | null;
  ip: string | null;
}
export interface AuditEntryDetail extends AuditEntry {
  before: unknown;
  after: unknown;
  userAgent: string | null;
}
export type Severity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export interface SecurityEvent {
  id: string;
  userId: string | null;
  type: string;
  severity: Severity;
  details: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
  centre: { id: string; name: string | null; slug: string | null } | null;
}
export interface SecuritySummary {
  from: string;
  to: string;
  total: number;
  bySeverity: Record<Severity, number>;
  byType: Array<{ type: string; severity: Severity; count: number }>;
}

// ---------------------------------------------------------------- integrations

export type AuthorisationState = 'PENDING' | 'VERIFIED' | 'REJECTED';
export interface AuthorisationRecord {
  id: string;
  centre: CentreRef;
  category: 'GOVERNMENT' | 'PARTNER';
  provider: string;
  instanceKey: string | null;
  name: string;
  status: IntegrationStatus;
  state: AuthorisationState;
  fields: Array<{ key: string; label: string; value: unknown; keyField: boolean }>;
  authorisationNote: string | null;
  evidenceDocumentId: string | null;
  submittedAt: string | null;
  verifiedAt: string | null;
  verifiedByName: string | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface ApprovedProviders {
  restricted: boolean;
  providers: Array<{ code: string; category: string; provider: string; name: string; kind: 'CONNECTION' | 'AUTHORISATION' | string; approved: boolean }>;
  /** Only in the answer to a change: how many active integrations were switched off. */
  switchedOff?: number;
}

// ---------------------------------------------------------------- privacy registers (platform level)

export type IncidentSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type IncidentStatus = 'OPEN' | 'INVESTIGATING' | 'CONTAINED' | 'RESOLVED';
export interface PlatformIncident {
  id: string;
  title: string;
  description: string | null;
  severity: IncidentSeverity;
  status: IncidentStatus;
  affectedData: string | null;
  personalDataInvolved: boolean;
  notificationRequired: boolean | null;
  authorityNotifiedAt: string | null;
  individualsNotifiedAt: string | null;
  resolutionNotes: string | null;
  detectedAt: string;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export type ProcessorStatus = 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';
export interface ProcessorRecord {
  id: string;
  name: string;
  purpose: string | null;
  dataCategories: string[];
  country: string | null;
  crossBorder: boolean;
  safeguards: string | null;
  status: ProcessorStatus;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
