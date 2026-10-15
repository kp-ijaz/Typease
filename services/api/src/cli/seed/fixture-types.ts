/**
 * Shape of the fictional demo data in `database/seed/**`.
 *
 * The data modules import these types (type-only, erased at run time); the seed
 * program loads the data with a dynamic require so that the API build, whose
 * root directory is `src`, never has to compile files of another package.
 */

export type StaffRoleKey = 'owner' | 'manager' | 'receptionist' | 'operator' | 'reviewer' | 'accountant';
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type ManualMethod = 'CASH' | 'CARD_POS' | 'BANK_TRANSFER' | 'CHEQUE';
export type Priority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

export interface BranchFx {
  /** Branch code, also the handle used by staff, requests and appointments. */
  code: string;
  name: string;
  nameAr?: string;
  address: string;
  emirate: string;
  isHeadOffice?: boolean;
  /** Opening hours per weekday (0 = Sunday); null = closed. */
  hours: Partial<Record<Weekday, { open: string; close: string } | null>>;
}

export interface StaffFx {
  key: string;
  roleKey: StaffRoleKey;
  fullName: string;
  jobTitle: string;
  /** Local part of the login on the tenant's .test domain. */
  login: string;
  /** 'ALL' or branch codes. */
  branches: 'ALL' | string[];
  /** Service codes this operator is skilled in (auto-assignment prefers them). */
  skills?: string[];
  /** Weekly shifts: weekday list + times, at the first listed branch (or the head office). */
  shifts?: Array<{ days: Weekday[]; start: string; end: string; branch?: string }>;
  joinedDaysAgo: number;
}

export interface PersonFx {
  key: string;
  fullName: string;
  fullNameAr?: string;
  /** ISO 3166 alpha-2. */
  nationality: string;
  dateOfBirth: string;
  language?: 'en' | 'ar';
}

export interface CustomerFx extends PersonFx {
  /** Days before "now" the record was created. */
  since: number;
  /** Staff member (key) who registered a walk-in customer. Ignored for self-registered customers. */
  registeredBy?: string;
  city?: string;
  /** Which identity documents are on file. Default: both. */
  identity?: { emiratesId?: boolean; passport?: boolean };
  noEmail?: boolean;
  noPhone?: boolean;
  /**
   * Portal account: SELF = registered on the portal themselves, INVITED = invited by staff and accepted,
   * PENDING = invited, not accepted yet.
   */
  portal?: 'SELF' | 'INVITED' | 'PENDING';
  tags?: string[];
  notes?: Array<{ body: string; pinned?: boolean; by?: string }>;
  marketing?: boolean;
  whatsapp?: boolean;
  /** Extra consent decisions recorded by staff. */
  consents?: Array<{ purpose: 'REMINDERS' | 'DOCUMENT_REUSE' | 'AI_PROCESSING' | 'MARKETING' | 'WHATSAPP'; granted: boolean }>;
  extraContacts?: Array<{ type: 'EMAIL' | 'PHONE' | 'WHATSAPP'; label: string }>;
  /** Archived after registration (no open requests). */
  archived?: string;
}

export interface CompanyFx {
  key: string;
  companyName: string;
  companyNameAr?: string;
  /** Domain of the company's logins, e.g. falcon-demo.test */
  emailDomain: string;
  city: string;
  since: number;
  /** ACTIVE = verified; PENDING = waiting for verification; SUSPENDED = verified, then suspended. */
  state: 'ACTIVE' | 'PENDING' | 'SUSPENDED';
  verificationNote?: string;
  suspendReason?: string;
  credit?: { limit: string; termsDays: number; note: string };
  /** Proposed terms that are not approved (shown on the account, without effect). */
  proposedTerms?: { limit: string; termsDays: number };
  notes?: string;
  /** Authorised contacts. `accept: false` leaves the invitation pending. */
  members: Array<{ key: string; fullName: string; login: string; signatory?: boolean; accept: boolean }>;
  employees: Array<PersonFx & { employeeNo: string; designation: string }>;
  agreement?: { title: string; terms: string; startsDaysAgo: number; months: number; status: 'ACTIVE' | 'DRAFT' };
  contractPrices?: Array<{ service: string; fee: string }>;
  /** Create the BUSINESS customer profile used for requests of the company itself. */
  businessProfile?: boolean;
}

export interface CustomServiceFx {
  code: string;
  categoryKey: string;
  name: string;
  nameAr: string;
  description: string;
  eligibilityGuidance?: string;
  complianceCapability: 'DOCUMENT_PREPARATION_ONLY' | 'PARTNER_COORDINATION' | 'INFORMATIONAL_ONLY';
  estimatedProcessingHours: number;
  requiresApproval?: boolean;
  paymentPolicy?: 'BEFORE_PROCESSING' | 'AFTER_COMPLETION' | 'DEPOSIT';
  depositPercent?: number;
  onlineAvailable?: boolean;
  isPublic?: boolean;
  /** Branch codes; omitted = all branches. */
  branches?: string[];
  /** Key of a workflow definition of the centre (e.g. 'walk-in-express'). */
  workflowKey?: string;
  price: { serviceFee: string; governmentFeeEstimate?: string; thirdPartyFeeEstimate?: string };
  /** Branch-specific price. */
  branchPrices?: Array<{ branch: string; serviceFee: string; governmentFeeEstimate?: string; thirdPartyFeeEstimate?: string }>;
  requirements: Array<{ documentTypeKey: string; label: string; labelAr?: string; isMandatory?: boolean; allowReuse?: boolean; maxAgeDays?: number }>;
  /** Form schema (FormSchema of @typease/types). */
  form?: unknown;
}

/** Where a request scenario comes to rest. */
export type RequestStop =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'UNDER_REVIEW'
  | 'DOCUMENTS_VERIFIED'
  | 'AWAITING_CUSTOMER'
  | 'QUOTED'
  | 'AWAITING_PAYMENT'
  | 'READY_FOR_PROCESSING'
  | 'IN_PREPARATION'
  | 'PENDING_APPROVAL'
  | 'READY_TO_SUBMIT'
  | 'EXTERNAL_PROCESSING'
  | 'RETURNED'
  | 'REJECTED'
  | 'FINAL_REVIEW'
  | 'COMPLETED'
  | 'CANCELLED';

export interface RequestScenarioFx {
  /** Stable handle, also used for idempotency keys and sample reference numbers. */
  ref: string;
  service: string;
  /** Customer key, or employee key of a company. */
  customer: string;
  branch?: string;
  /**
   * Who creates the request: STAFF (receptionist of the branch, walk-in), PORTAL (the customer, online),
   * CORPORATE (the company administrator on the corporate portal).
   */
  via?: 'STAFF' | 'PORTAL' | 'CORPORATE';
  /** Company key: the request is billed to this corporate account. */
  company?: string;
  priority?: Priority;
  instructions?: string;
  /** First and last activity, in days before "now". */
  start: number;
  end: number;
  stop: RequestStop;

  /** Input documents: 'ALL' (default), 'PARTIAL' (first mandatory line only) or 'NONE'. */
  documents?: 'ALL' | 'PARTIAL' | 'NONE';
  /** One input document is rejected. `fixed` = the customer replaces it and the case moves on. */
  rejectDocument?: { reason: string; fixed: boolean };
  /** Staff ask a question during preparation. `answered` = the customer replies and work resumes. */
  question?: { message: string; answered: boolean; reply?: string };
  quotation?: {
    discount?: { amount: string; reason: string; decision: 'APPROVE' | 'REJECT' | 'PENDING' };
    /** The first quotation is rejected by the customer with this reason; a revised one follows. */
    rejectedFirst?: string;
    /** The quotation runs out without an answer (stays that way). */
    expires?: boolean;
    /** Who answers: the customer on the portal, the company administrator, or staff on the customer's behalf. */
    approvedBy?: 'CUSTOMER' | 'STAFF' | 'CORPORATE';
  };
  payment?: {
    method: ManualMethod | 'ONLINE';
    /** Pay only this share (0-1) of the amount due and stop. */
    partial?: number;
    /** The first online attempt is declined by the test gateway. */
    declinedFirst?: boolean;
    /** An online checkout is opened and abandoned (payment stays PENDING). */
    abandoned?: boolean;
  };
  /** Assignment: 'AUTO' uses automatic assignment, otherwise the operator's staff key. */
  operator?: string;
  /** The first review is sent back with this comment. */
  reviewRejectedFirst?: string;
  external?: {
    /** Outcome reported by the partner: COMPLETED, RETURNED or REJECTED. */
    outcome?: 'COMPLETED' | 'RETURNED' | 'REJECTED';
    note?: string;
    /** After a return: correct and submit again (the second submission completes). */
    resubmitted?: boolean;
    statusNote?: string;
  };
  /** A completion document is filed (default true for requests that reach preparation). */
  deliverable?: boolean;
  cancel?: {
    by: 'STAFF' | 'CUSTOMER';
    reason: string;
    /** What happens to money already paid. */
    refund?: 'COMPLETED' | 'PENDING' | 'REJECTED';
    refundReason?: string;
  };
  /** Cancelled as a duplicate of this scenario (ref). */
  duplicateOf?: string;
  /** Reopened after completion with this reason. */
  reopened?: string;
  /** The target date has passed. */
  overdue?: boolean;
  /** Rating given by the customer after completion (needs a portal account). */
  rating?: { stars: 1 | 2 | 3 | 4 | 5; comment?: string };
  comments?: Array<{ by: string; body: string; visibility: 'INTERNAL' | 'CUSTOMER' }>;
  /** A government-fee remittance is recorded as an expense once the request is paid. */
  remitGovernmentFee?: boolean;
  /** Completed online payment is partly refunded through the gateway afterwards. */
  gatewayRefund?: { amount: string; reason: string };
}

export interface AppointmentFx {
  ref: string;
  customer?: string;
  guest?: { name: string };
  branch: string;
  service?: string;
  /** Day relative to today (negative = past) and local start time (HH:MM, on a slot boundary). */
  day: number;
  time: string;
  /** PORTAL = booked by the customer online. */
  via?: 'STAFF' | 'PORTAL';
  staff?: string;
  notes?: string;
  /**
   * What happened. Past days: COMPLETED, NO_SHOW, CANCELLED, RESCHEDULED. Today: AUTO lets the time of day decide.
   * Future days: BOOKED or CONFIRMED.
   */
  outcome: 'COMPLETED' | 'NO_SHOW' | 'CANCELLED' | 'RESCHEDULED' | 'BOOKED' | 'CONFIRMED' | 'AUTO';
  /** For RESCHEDULED: the new day / time. */
  movedTo?: { day: number; time: string };
  cancelReason?: string;
}

export interface TicketFx {
  ref: string;
  customer: string;
  /** PORTAL = opened by the customer (needs a portal account); STAFF = logged at the counter. */
  via: 'PORTAL' | 'STAFF';
  subject: string;
  category?: string;
  priority?: Priority;
  /** Scenario ref of the request the ticket is about. */
  request?: string;
  openedDaysAgo: number;
  assignee?: string;
  messages: Array<{ from: 'CUSTOMER' | 'STAFF'; by?: string; body: string; internal?: boolean; afterHours: number }>;
  /** Final state. */
  state: 'OPEN' | 'IN_PROGRESS' | 'WAITING_CUSTOMER' | 'RESOLVED' | 'CLOSED';
  resolution?: string;
  rating?: { stars: 1 | 2 | 3 | 4 | 5; comment?: string };
}

export interface TaskFx {
  title: string;
  description?: string;
  type: 'GENERAL' | 'FOLLOW_UP' | 'DOCUMENT_REVIEW' | 'APPROVAL';
  priority: Priority;
  by: string;
  assignees?: string[];
  roleKey?: StaffRoleKey;
  branch?: string;
  request?: string;
  customer?: string;
  createdDaysAgo: number;
  /** Due date relative to now, in days (negative = overdue). */
  dueInDays?: number;
  state: 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';
}

export interface ExpenseFx {
  branch: string;
  category: 'RENT' | 'SALARIES' | 'SUPPLIES' | 'UTILITIES' | 'OTHER' | 'GOVERNMENT_FEE_REMITTANCE' | 'THIRD_PARTY_PAYMENT';
  description: string;
  amount: string;
  paidDaysAgo: number;
  payee?: string;
  method?: 'CASH' | 'CARD' | 'BANK_TRANSFER' | 'CHEQUE' | 'E_WALLET' | 'OTHER';
}

export interface ReminderFx {
  customer?: string;
  company?: string;
  documentTypeKey: string;
  subjectLabel?: string;
  /** Expiry in days from today. */
  expiresInDays: number;
  offsetsDays?: number[];
  state?: 'ACTIVE' | 'PAUSED' | 'CANCELLED';
}

export interface DirectInvoiceFx {
  ref: string;
  customer: string;
  company?: string;
  branch: string;
  notes?: string;
  daysAgo: number;
  lines: Array<{ description: string; component: 'SERVICE_FEE' | 'GOVERNMENT_FEE' | 'THIRD_PARTY_FEE'; quantity?: number; unitAmount: string }>;
  /** DRAFT = never issued; VOID = issued, then voided; CREDITED = fully credited; otherwise issued and optionally paid. */
  outcome: 'DRAFT' | 'ISSUED' | 'PAID' | 'PARTIALLY_PAID' | 'VOID' | 'CREDITED' | 'PARTIALLY_CREDITED';
  payment?: { method: ManualMethod; share?: number };
  reason?: string;
}

/** A document filed in the vault outside a request. */
export interface VaultFx {
  customer?: string;
  company?: string;
  documentTypeKey: string;
  label?: string;
  by: string;
  daysAgo: number;
  /**
   * VERIFIED / UNVERIFIED: an ordinary upload. EXPIRED: the stated expiry date has passed. NEW_VERSION: a second
   * version replaces the first. QUARANTINED: the antivirus TEST file (EICAR), which the vault blocks. DELETED: removed
   * again. SHARED: a time-limited share link exists. LEGAL_HOLD: protected from deletion.
   */
  outcome: 'VERIFIED' | 'UNVERIFIED' | 'EXPIRED' | 'NEW_VERSION' | 'QUARANTINED' | 'DELETED' | 'SHARED' | 'LEGAL_HOLD';
  note?: string;
}

export interface ReconciliationFx {
  method: 'CASH' | 'CARD_POS' | 'BANK_TRANSFER' | 'CHEQUE' | 'ONLINE_GATEWAY';
  branch?: string;
  /** Period in days before now (to = 0 means "until now"). */
  fromDaysAgo: number;
  toDaysAgo: number;
  statementReference: string;
  /** MATCHED_CLOSED: statement equals the payments, record closed. DISCREPANCY: statement is short by `shortBy`. OPEN: nothing attached yet. */
  outcome: 'MATCHED_CLOSED' | 'DISCREPANCY' | 'OPEN';
  shortBy?: string;
  feeAmount?: string;
  notes?: string;
}

export interface TenantFx {
  slug: string;
  name: string;
  legalName: string;
  emirate: 'Abu Dhabi' | 'Dubai' | 'Sharjah' | 'Ajman' | 'Umm Al Quwain' | 'Ras Al Khaimah' | 'Fujairah';
  /** Staff logins are <login>@<emailDomain>. */
  emailDomain: string;
  planKey: 'starter' | 'professional' | 'business';
  /** Billing history: the trial started this many days ago; paid periods follow until today. */
  trialStartedDaysAgo: number;
  /** How the first invoice was settled: ONLINE = owner pays through the test gateway, OFFLINE = recorded by TypEase billing staff. */
  firstInvoice?: 'ONLINE' | 'OFFLINE';
  coupon?: string;
  taxRatePercent: number;
  settings?: Record<string, unknown>;
  /** Role key every service is limited to for (automatic) assignment, e.g. 'operator'. */
  serviceStaffGroup?: StaffRoleKey;
  branding?: {
    whiteLabel: boolean;
    businessName?: string;
    businessNameAr?: string;
    primaryColor?: string;
    secondaryColor?: string;
    accentColor?: string;
    websiteTitle?: string;
    tagline?: string;
    invoiceFooter?: string;
    receiptFooter?: string;
    emailFromName?: string;
    /** Initials drawn on the generated sample logo. */
    logoText?: string;
  };
  customDomain?: string;
  /** Head office first; it replaces the provisioned "Main Branch". */
  branches: BranchFx[];
  owner: StaffFx;
  staff: StaffFx[];
  /** Codes of starter services the centre switched off or re-priced. */
  starterAdjustments?: Array<{ code: string; isActive?: boolean; price?: { serviceFee: string; governmentFeeEstimate?: string; thirdPartyFeeEstimate?: string }; requiresApproval?: boolean; branchPrice?: { branch: string; serviceFee: string } }>;
  customServices?: CustomServiceFx[];
  /** Permissions the owner added to a built-in role (shows that roles can be tailored). */
  roleAdjustments?: Array<{ roleKey: StaffRoleKey; add: string[] }>;
  /** A sample partner the centre coordinates submissions with (needed for PARTNER_COORDINATION services). */
  partner?: {
    name: string;
    /** Invented legal name of the partner (shown as "fictional"). */
    legalName: string;
    serviceScope: string;
    /** Sample agreement number, SAMPLE-... */
    agreementReference: string;
    validForDays: number;
    contactName?: string;
    contactEmail?: string;
    /** What the TypEase administrator needs to know to review the record (10+ characters). */
    note: string;
    /** PENDING leaves the record waiting in the platform console; default: verified. */
    review?: 'VERIFIED' | 'PENDING';
  };
  /** Customised copy of a workflow template, published as a new version. */
  workflowCustomisation?: { definitionKey: string; notes: string; addNotificationAfter: string; message: string; reviewTimeoutHours?: number };
  tags?: Array<{ name: string; color: string }>;
  customers: CustomerFx[];
  companies?: CompanyFx[];
  requests: RequestScenarioFx[];
  directInvoices?: DirectInvoiceFx[];
  /** A company pays several invoices with one transfer (requests by scenario ref). */
  statementPayments?: Array<{ company: string; requests: string[]; method: ManualMethod; daysAgo: number }>;
  reconciliations?: ReconciliationFx[];
  vault?: VaultFx[];
  /** Customers who switched a channel off themselves (shows suppressed notifications). */
  optOuts?: Array<{ customer: string; channel: 'EMAIL' | 'SMS'; group: string }>;
  /**
   * A short period in which the centre's own SMS gateway was misconfigured: notifications by SMS
   * fail while these request scenarios run; afterwards the gateway is switched off again.
   */
  smsOutage?: { during: string[]; gatewayName: string };
  expenses?: ExpenseFx[];
  appointments?: AppointmentFx[];
  /** Walk-in queue of today at the head office: customer keys (null = anonymous walk-in). */
  queueToday?: Array<{ customer?: string; service?: string; state: 'WAITING' | 'CALLED' | 'SERVING' | 'COMPLETED' | 'NO_SHOW' | 'CANCELLED'; counter?: string }>;
  tasks?: TaskFx[];
  tickets?: TicketFx[];
  reminders?: ReminderFx[];
  /** Data subject requests. */
  privacyRequests?: Array<{ customer: string; type: 'ACCESS' | 'CORRECTION' | 'DELETION' | 'EXPORT'; via: 'PORTAL' | 'STAFF'; details?: string; daysAgo: number; outcome: 'RECEIVED' | 'IN_REVIEW' | 'APPROVED' | 'REJECTED' | 'COMPLETED'; note?: string }>;
  /** Questions the centre asked TypEase support. */
  platformTickets?: Array<{ subject: string; message: string; category?: string; priority?: Priority; daysAgo: number; reply?: string; resolved?: boolean }>;
  /** Shown in the demo guide as "try this": an action the plan does not allow. */
  planLimitDemo?: { secondBranch: BranchFx };
}

export interface PlatformFx {
  admin: { fullName: string; email: string };
  support: { fullName: string; email: string };
  coupon?: { code: string; description: string; percentOff: number; durationMonths: number };
  incident?: { title: string; description: string; severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' };
  processors?: Array<{ name: string; purpose: string; dataCategories: string[]; country: string; safeguards?: string }>;
  /**
   * Time-limited support access the support agent asks centres for (needs the platform module).
   * USED_AND_REVOKED: the owner approves `approvedScopes` for `approvedMinutes`, the agent looks at the centre, the owner ends it.
   * PENDING: left waiting for the owner. DENIED: the owner says no.
   */
  supportAccess?: Array<{
    centre: string;
    reason: string;
    scopes: string[];
    durationMinutes: number;
    outcome: 'USED_AND_REVOKED' | 'PENDING' | 'DENIED';
    approvedScopes?: string[];
    approvedMinutes?: number;
    decisionNote?: string;
  }>;
}

export interface IdentityFx {
  /** Obviously fake Emirates ID for the n-th person: 784-1900-0000NNN-C. */
  emiratesId(n: number): string;
  /** Obviously fake passport number: TEST0NNNN. */
  passportNo(n: number): string;
  /** Phone number in the non-subscriber demo range. */
  phone(n: number): string;
  tradeLicenceNo(n: number): string;
  sampleReference(prefix: string, n: number): string;
}

export interface DemoFixtures {
  identity: IdentityFx;
  platform: PlatformFx;
  tenants: TenantFx[];
  /** Valid form values for a service of the catalogue. */
  formValues(serviceCode: string, person: PersonFx, pick: (n: number) => number): Record<string, unknown>;
  defaults: { passwordEnv: string; password: string };
}
