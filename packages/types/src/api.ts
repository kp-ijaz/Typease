/** Shapes shared by every TypEase REST endpoint. */

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
export interface Page<T> {
  data: T[];
  meta: PageMeta;
}
export interface PageQuery {
  page?: number;
  pageSize?: number;
  /** "field:asc" or "field:desc" */
  sort?: string;
  q?: string;
}
export interface ApiErrorBody {
  statusCode: number;
  /** Stable machine-readable code, e.g. TENANT_FORBIDDEN, INVALID_TRANSITION */
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
}

export type AppKey = 'centre' | 'customer' | 'corporate' | 'platform' | 'mobile';

export interface AuthMembership {
  membershipId: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  kind: 'STAFF' | 'CUSTOMER' | 'CORPORATE';
  roleKey: string;
  roleName: string;
}
export interface SessionUser {
  id: string;
  email: string;
  phone: string | null;
  fullName: string;
  preferredLanguage: string;
  platformRole: 'SUPER_ADMIN' | 'SUPPORT_AGENT' | null;
  mfaEnabled: boolean;
  emailVerified: boolean;
  phoneVerified: boolean;
}
/** Returned by GET /auth/me and embedded in login responses. */
export interface SessionInfo {
  user: SessionUser;
  tenant: { id: string; slug: string; name: string; status: string; timezone: string; currency: string } | null;
  membership: {
    id: string;
    kind: 'STAFF' | 'CUSTOMER' | 'CORPORATE';
    roleKey: string;
    roleName: string;
    allBranches: boolean;
    branchIds: string[];
    customerId: string | null;
    corporateAccountId: string | null;
  } | null;
  permissions: string[];
  /**
   * Set while a TypEase support agent is inside a centre under an approved access grant (a "support
   * session"): `membership` is null and `permissions` equals `supportGrant.scopes`. null / absent otherwise.
   */
  supportGrant?: SupportGrant | null;
  mfaRequiredSetup: boolean;
}
/** The access grant a support session runs under (docs/api/modules/platform.md, "Support session hand-off"). */
export interface SupportGrant {
  id: string;
  /** Permission keys the centre approved. */
  scopes: string[];
  /** The subset of `scopes` that allows changes. Empty for a read-only session. */
  writeScopes: string[];
  readOnly: boolean;
  /** When the centre approved (the clock starts then). */
  startsAt: string | null;
  /** The session ends at this moment, or earlier when the grant is revoked. */
  expiresAt: string;
  tenantId: string;
  tenantName: string;
  /** Why access was asked for, as shown to the centre. */
  reason: string;
}
export type LoginResult =
  | { status: 'OK'; accessToken: string; expiresIn: number; refreshToken?: string; session: SessionInfo; landing: string }
  | { status: 'MFA_REQUIRED'; challengeToken: string }
  | { status: 'SELECT_TENANT'; selectionToken: string; memberships: AuthMembership[] };

/** Public, unauthenticated tenant presentation data (white-label). */
export interface PublicTenantConfig {
  tenantId: string;
  slug: string;
  name: string;
  nameAr: string | null;
  mode: 'TYPEASE' | 'WHITE_LABEL';
  logoUrl: string | null;
  faviconUrl: string | null;
  colors: { primary: string; secondary: string; accent: string };
  websiteTitle: string;
  tagline: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  defaultLanguage: string;
  currency: string;
  timezone: string;
  publicCatalogueEnabled: boolean;
  features: Record<string, boolean>;
  /** The rules a new password must meet. Absent on older API versions: fall back to the built-in rules. */
  passwordPolicy?: PasswordPolicy;
}
/** Published by GET /public/tenant-config and the invitation preview. */
export interface PasswordPolicy {
  minLength: number;
  maxLength: number;
  /** Character classes that must each appear at least once. */
  requires: Array<'lowercase' | 'uppercase' | 'digit'>;
}

// =============================================================================
// Fields and endpoints added by the API's hardening passes. Everything here is
// additive: older responses simply lack the field. The module documents under
// docs/api/modules/ describe each one with an example.
// =============================================================================

/**
 * A customer mentioned inside another record: an invoice, a payment, a quotation, a request, a merge link.
 * `erased: true` = the person's data was erased on request; the name is the placeholder "Erased customer".
 * (The record status itself is not part of a reference.)
 */
export interface CustomerRef {
  id: string;
  customerNo?: string;
  fullName: string;
  erased: boolean;
  email?: string | null;
  phone?: string | null;
}
/** On customer records (GET /customers, GET /customers/:id). An erased record is a stub: `status: "ANONYMISED"`, no personal field. */
export interface CustomerErasureFlags {
  erased: boolean;
  /** GET /customers/:id only: when the data was erased (null for every other record). */
  erasedAt?: string | null;
}
/** Whose it is, in words: on document rows (GET /documents, GET /documents/:id) and on rows of the corporate statement. */
export interface OwnerLabels {
  customerName: string | null;
  customerErased: boolean;
  requestNo: string | null;
}
/** Flat variant on appointments, support tickets and reminders (staff views). */
export interface CustomerErasedFlag {
  customerErased: boolean;
}
/** GET /me/reminders rows additionally carry the person the reminder is about. */
export interface ReminderOwner {
  customerId: string | null;
  customerName: string | null;
}
/** Corporate employees as returned to the corporate portal now carry the id to filter by (`?customerId=`). */
export interface CorporateEmployeeCustomerLink {
  customerId: string;
}

/**
 * `finance` of GET /requests/:id.
 *  - people who may see money (the paying customer, a company administrator, finance-reading staff): amounts;
 *  - an employee in the corporate portal: where the quotation and the invoices stand, without amounts;
 *  - everybody else: null.
 */
export type RequestFinanceSummary =
  | {
      amountsHidden: false;
      quotation: { id: string; quotationNo: string; status: string; total: string; currency: string; validUntil: string | null; sentAt: string | null } | null;
      invoices: Array<{ id: string; invoiceNo: string; status: string; currency: string; total: string; amountPaid: string; balanceDue: string; issuedAt: string | null; dueAt: string | null }>;
      totals: { invoiced: string; paid: string; refunded: string; balance: string };
    }
  | {
      amountsHidden: true;
      quotation: { id: string; quotationNo: string; status: string; validUntil: string | null; sentAt: string | null } | null;
      invoices: Array<{ id: string; invoiceNo: string; status: string; issuedAt: string | null; dueAt: string | null }>;
      totals: null;
    }
  | null;
/** GET /requests/:id for customers and company users: the one rating a completed request can have. */
export interface RequestRatingState {
  feedback: { rating: number; comment: string | null; createdAt: string } | null;
  /** true = completed and not rated yet: POST /me/feedback { requestId, rating, comment? }. */
  canRate: boolean;
}

/** GET /me/customer and PATCH /me/customer: which details the customer may still change themselves. */
export interface OwnProfileEditability {
  /** false = entered or confirmed by the centre: a change needs a correction request (409 CORRECTION_REQUIRED). */
  editable: { phone: boolean; nationality: boolean; dateOfBirth: boolean };
}

/** POST /auth/mfa/setup. `issuer` is the name the authenticator app shows: the centre's brand for a white-label centre, otherwise "TypEase". */
export interface MfaSetupResult {
  secret: string;
  issuer: string;
  otpauthUrl: string;
}

// ----------------------------------------------------------------------------- platform: system status
export type SystemProviderStatus = 'CONFIGURED' | 'NOT_CONFIGURED' | 'LOG_ONLY' | 'DISABLED' | 'SANDBOX';
export type SystemProviderKey =
  | 'mail' | 'sms' | 'whatsapp' | 'push' | 'storage' | 'malware_scanner' | 'ocr' | 'payments' | 'payments_sandbox' | 'automation_webhooks' | 'redis' | 'queue' | 'error_tracking';
export interface SystemProvider {
  key: SystemProviderKey;
  label: string;
  /** The driver chosen in the environment: smtp, log, twilio, s3, local, clamav, none ... */
  driver: string;
  status: SystemProviderStatus;
  /** One or two sentences for an operator. Never contains a secret. */
  detail: string;
  /** Only on rows that are really checked (storage, redis). */
  reachable?: boolean;
  lastCheckedAt?: string;
  lastError?: string | null;
}
/** GET /platform/system/providers */
export interface SystemProviders {
  generatedAt: string;
  environment: 'development' | 'test' | 'production';
  providers: SystemProvider[];
}
export interface SystemQueueCounts {
  name: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}
export interface SystemStorageHealth {
  driver: 's3' | 'local';
  reachable: boolean;
  target: string;
  error: string | null;
  checkedAt: string;
}
export interface SystemWorkerLiveness {
  /** `worker` = a separate worker process (QUEUE_DRIVER=bullmq); `single-process` = the API runs the jobs itself. */
  mode: 'worker' | 'single-process';
  status: 'OK' | 'STALE' | 'NOT_SEEN' | 'DISABLED';
  lastSeenAt: string | null;
  ageSeconds: number | null;
  intervalSeconds: number;
  /** Two intervals: older than this is STALE. */
  staleAfterSeconds: number;
  instances: Array<{ instanceId: string; mode: 'worker' | 'single-process'; startedAt: string; lastSeenAt: string; ageSeconds: number; stale: boolean }>;
}
/** GET /platform/system/health, and `systemHealth` of GET /platform/dashboard. */
export interface SystemHealth {
  status: 'ok' | 'degraded' | 'down';
  checkedAt: string;
  database: boolean;
  systemDatabase: boolean;
  redis: boolean;
  storage: SystemStorageHealth;
  queue:
    | { driver: 'bullmq'; reachable: boolean; waiting: number; active: number; delayed: number; failed: number }
    | { driver: 'inline'; reachable: true; pending: number; deadLetters: number };
  queues: SystemQueueCounts[];
  worker: SystemWorkerLiveness | null;
  outbox: { pending: number; processing: number; failed: number; oldestPendingSeconds: number } | null;
  /** What is wrong, in sentences. Empty when status is "ok". */
  problems: string[];
}
