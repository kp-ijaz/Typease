/**
 * View models of the finance, reporting, subscription and audit endpoints, modelled on the
 * real responses (docs/api/modules/finance.md, reports.md, dashboard.md, subscriptions.md, audit.md).
 * Entities come from @typease/types; what is declared here are the joined fields the API adds.
 */
import type {
  BillingCycle, CreditNote, Expense, FeeComponent, FeeComponentType, Invoice, InvoiceItem, InvoiceStatus, Page, PageMeta, Payment, PaymentAllocation, PaymentMethod, PaymentStatus,
  PlanFeatures, PlanLimits, Quotation, QuotationItem, ReconciliationRecord, Refund, RefundStatus, RequestStatus, SubscriptionInvoice, SubscriptionStatus, TenantStatus,
} from '@typease/types';

export type { FeeComponentType, PaymentMethod };
export interface Bilingual {
  en: string;
  ar: string;
}

export interface CustomerRef {
  id: string;
  customerNo: string;
  fullName: string;
  email?: string | null;
  phone?: string | null;
}
export interface BranchRef {
  id: string;
  code: string;
  name: string;
}
export interface CorporateRef {
  id: string;
  accountNo?: string;
  companyName: string;
}
export interface RequestRef {
  id: string;
  requestNo: string;
}

// ---------------------------------------------------------------- lines
export type LineItem = Pick<QuotationItem, 'id' | 'serviceId' | 'description' | 'component' | 'quantity' | 'unitAmount' | 'discountAmount' | 'taxRatePercent' | 'taxAmount' | 'lineTotal' | 'sortOrder'>;

/** The totals every quotation and invoice carries. */
export interface MoneyTotals {
  currency: string;
  subtotalServiceFee: string;
  subtotalGovernmentFee: string;
  subtotalThirdParty: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
}

// ---------------------------------------------------------------- quotations
export type DiscountApproval = 'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED';
export interface QuotationRow extends Omit<Quotation, 'discountApproval'> {
  discountApproval: DiscountApproval;
  customer: CustomerRef;
  corporateAccount: CorporateRef | null;
  branch: BranchRef;
  request: RequestRef | null;
  expired: boolean;
}
export interface QuotationDetail extends QuotationRow {
  quotationItems: QuotationItem[];
  invoice: { id: string; invoiceNo: string; status: InvoiceStatus; balanceDue: string } | null;
}
export interface QuotationDecision {
  quotation: QuotationDetail;
  invoice: { id: string; invoiceNo: string; status: InvoiceStatus; total: string; balanceDue: string; currency: string; dueAt: string | null };
}

// ---------------------------------------------------------------- invoices
export interface InvoiceRow extends Invoice {
  customer: CustomerRef;
  corporateAccount: CorporateRef | null;
  branch: BranchRef;
  request: RequestRef | null;
  overdue: boolean;
}
export interface InvoicePaymentLine {
  allocationId: string;
  allocated: string;
  id: string;
  paymentNo: string;
  receiptNo: string | null;
  method: PaymentMethod;
  status: PaymentStatus;
  receivedAt: string | null;
  amount: string;
  refundedAmount: string;
}
export interface InvoiceCreditNoteLine {
  id: string;
  creditNoteNo: string;
  amount: string;
  reason: string;
  status: string;
  issuedAt: string;
}
export interface InvoiceDetail extends InvoiceRow {
  invoiceItems: InvoiceItem[];
  quotation: { id: string; quotationNo: string } | null;
  payments: InvoicePaymentLine[];
  creditNotes: InvoiceCreditNoteLine[];
}
export interface PaymentLink {
  paymentId: string;
  paymentNo: string;
  status: 'PENDING';
  amount: string;
  currency: string;
  gateway: string;
  testMode: boolean;
  checkoutUrl: string;
  expiresAt: string;
}
export interface CorporateStatement {
  asOf: string;
  account: { id: string; accountNo: string; companyName: string; paymentTermsDays: number; creditApproved: boolean; creditLimit: string | null };
  currency: string;
  openBalance: string;
  availableCredit: string | null;
  ageing: Record<'current' | 'days1to30' | 'days31to60' | 'days61to90' | 'days90plus', string>;
  invoices: Array<{ id: string; invoiceNo: string; dueAt: string | null; balanceDue: string; bucket: string; daysOverdue: number }>;
}

// ---------------------------------------------------------------- payments
export interface PaymentAllocationLine extends Omit<PaymentAllocation, 'tenantId'> {
  invoice: { id: string; invoiceNo: string; requestId: string | null; status: InvoiceStatus; balanceDue: string };
}
export interface PaymentRow extends Omit<Payment, 'tenantId' | 'gatewaySessionRef' | 'idempotencyKey'> {
  customer: Pick<CustomerRef, 'id' | 'customerNo' | 'fullName'> | null;
  branch: BranchRef;
  paymentAllocations: PaymentAllocationLine[];
  unallocatedAmount: string;
}
export interface PaymentRefundLine {
  id: string;
  refundNo: string;
  amount: string;
  status: RefundStatus;
  reason: string;
  invoiceId: string | null;
  processedAt: string | null;
  createdAt: string;
}
export interface PaymentDetail extends PaymentRow {
  refunds: PaymentRefundLine[];
}

// ---------------------------------------------------------------- refunds
export interface RefundBreakdown {
  explicit?: boolean;
  cancelCharge?: boolean;
  SERVICE_FEE?: string;
  GOVERNMENT_FEE?: string;
  THIRD_PARTY_FEE?: string;
  TAX?: string;
}
export interface RefundRow extends Omit<Refund, 'breakdown'> {
  breakdown: RefundBreakdown | null;
  payment: { id: string; paymentNo: string; receiptNo: string | null; method: PaymentMethod; gateway: string | null; amount: string; refundedAmount: string; status: PaymentStatus; branchId: string; customerId: string | null };
  invoice: { id: string; invoiceNo: string; status: InvoiceStatus; balanceDue: string } | null;
}

// ---------------------------------------------------------------- credit notes
export interface CreditNoteRow extends Omit<CreditNote, 'tenantId' | 'breakdown'> {
  breakdown: Partial<Record<FeeComponentType, string>> | null;
  invoice: { id: string; invoiceNo: string; customerId: string; corporateAccountId: string | null; branchId: string; requestId: string | null; currency: string };
}
export interface CreditNoteCreated extends CreditNoteRow {
  invoiceStatus: InvoiceStatus;
  invoiceBalanceDue: string;
}

// ---------------------------------------------------------------- expenses, liabilities, reconciliation, settings
export type ExpenseCategory = 'GOVERNMENT_FEE_REMITTANCE' | 'THIRD_PARTY_PAYMENT' | 'RENT' | 'SALARIES' | 'SUPPLIES' | 'UTILITIES' | 'OTHER';
export const EXPENSE_CATEGORIES: ExpenseCategory[] = ['GOVERNMENT_FEE_REMITTANCE', 'THIRD_PARTY_PAYMENT', 'RENT', 'SALARIES', 'SUPPLIES', 'UTILITIES', 'OTHER'];
export type ExpenseMethod = 'CASH' | 'CARD' | 'BANK_TRANSFER' | 'CHEQUE' | 'E_WALLET' | 'OTHER';
export const EXPENSE_METHODS: ExpenseMethod[] = ['CASH', 'CARD', 'BANK_TRANSFER', 'CHEQUE', 'E_WALLET', 'OTHER'];
export interface ExpenseRow extends Omit<Expense, 'tenantId' | 'category' | 'method'> {
  category: ExpenseCategory;
  method: ExpenseMethod | null;
  branch: BranchRef;
}
export interface ExpensePage extends Page<ExpenseRow> {
  totalAmount: string;
}

export interface LiabilityAmounts {
  accrued: string;
  reversed: string;
  remitted: string;
  outstanding: string;
}
export interface LiabilityComponent extends LiabilityAmounts {
  component: 'GOVERNMENT_FEE' | 'THIRD_PARTY_FEE';
  name: string;
  treatment: string;
  ledgerCode: string | null;
}
export interface LiabilityRequestRow {
  requestId: string;
  requestNo: string;
  requestStatus: RequestStatus;
  customer: { id: string; fullName: string } | null;
  service: string | null;
  governmentFee: LiabilityAmounts;
  thirdPartyFee: LiabilityAmounts;
  outstanding: string;
}
export interface LiabilitiesResponse {
  currency: string;
  components: LiabilityComponent[];
  totalOutstanding: string;
  requests: Page<LiabilityRequestRow>;
}

export type ReconciliationStatus = 'OPEN' | 'MATCHED' | 'DISCREPANCY' | 'CLOSED';
export interface ReconciliationRow extends Omit<ReconciliationRecord, 'tenantId' | 'status'> {
  status: ReconciliationStatus;
}
export interface ReconciliationPayment {
  id: string;
  paymentNo: string;
  receiptNo: string | null;
  method: PaymentMethod;
  gateway: string | null;
  amount: string;
  refundedAmount: string;
  status: PaymentStatus;
  receivedAt: string | null;
  reference: string | null;
  branchId: string;
  customerId: string | null;
}
export interface ReconciliationDetail extends ReconciliationRow {
  attached: { count: number; total: string; payments: ReconciliationPayment[] };
  candidates: { count: number; total: string; payments: ReconciliationPayment[] };
}

export interface FeeComponentsResponse {
  notice: string;
  components: Array<Omit<FeeComponent, 'tenantId'>>;
}
export interface TenantProfile {
  id: string;
  name: string;
  taxRegistrationNo: string | null;
  /** Percent as text, e.g. "5". */
  taxRatePercent: string | null;
  defaultCurrency: string;
  settings: { invoiceDueDays?: number; quotationValidityDays?: number } & Record<string, unknown>;
}

// ---------------------------------------------------------------- dashboard
export type RequestBucketKey = 'newRequests' | 'pendingVerification' | 'awaitingCustomer' | 'awaitingPayment' | 'readyForProcessing' | 'inProgress' | 'completedToday' | 'overdue';
export interface DashboardResponse {
  generatedAt: string;
  timeZone: string;
  today: string;
  currency: string;
  filters: { branchId: string | null; from: string | null; to: string | null };
  scope: { branchIds: string[] | null; requests: 'ALL' | 'ASSIGNED' | 'NONE'; finance: 'ALL' | 'OWN_CASES' | 'NONE' };
  requests:
    | (Record<RequestBucketKey, number> & { open: number; drafts: number; byStatus: Partial<Record<RequestStatus, number>>; range: { from: string; to: string; created: number; completed: number } | null })
    | null;
  finance: {
    serviceRevenueToday: string;
    otherRevenueToday: string;
    taxInvoicedToday: string;
    grossCollectionsToday: string | null;
    paymentsToday: string | null;
    refundsToday: string | null;
    outstandingReceivables: string;
    openInvoices: number;
    range: { from: string; to: string; serviceRevenue: string; otherRevenue: string; taxInvoiced: string; grossCollections: string | null } | null;
    labels: Record<string, string>;
    notes: string[];
  } | null;
  staffWorkload: {
    unassignedRequests: number | null;
    staff: Array<{ membershipId: string; name: string; roleKey: string; roleName: string; openRequests: number; overdueRequests: number; highPriorityRequests: number; openTasks: number; overdueTasks: number }>;
  } | null;
  upcomingExpiries: {
    withinDays: number;
    from: string;
    to: string;
    total: number;
    items: Array<{
      scheduleId: string;
      documentTypeKey: string;
      documentTypeName: string;
      documentTypeNameAr: string | null;
      expiryDate: string;
      daysLeft: number;
      status: string;
      customerId: string | null;
      corporateAccountId: string | null;
      renewalStarted: boolean;
      customerNo: string | null;
      customerName: string | null;
      subjectLabel: string | null;
    }>;
  } | null;
  recentActivity: Array<{
    id: string;
    requestId: string;
    requestNo: string;
    branchId: string;
    serviceName: string;
    from: RequestStatus | null;
    to: RequestStatus;
    toLabel: Bilingual;
    at: string;
    actorType: string;
    actorName: string | null;
    customerNo: string | null;
    customerName: string | null;
  }> | null;
}
export interface DashboardTrends {
  from: string;
  to: string;
  currency: string;
  timeZone: string;
  days: Array<{ date: string; requestsCreated: number | null; requestsCompleted: number | null; serviceRevenue: string | null; grossCollections: string | null }>;
  notes: string[];
}

// ---------------------------------------------------------------- reports
export type ReportColumnType = 'text' | 'number' | 'money' | 'date' | 'percent';
export interface ReportColumn {
  key: string;
  label: string;
  type: ReportColumnType;
}
export interface ReportParameter {
  key: string;
  label: string;
  type: 'date' | 'relativeRange' | 'branch' | 'service' | 'customer' | 'corporateAccount' | 'staff' | 'enum' | 'month' | 'number' | 'text';
  options?: string[];
  drilldownOnly?: boolean;
}
export interface ReportDefinition {
  key: string;
  title: string;
  description: string;
  category: string;
  permission: string;
  parameters: ReportParameter[];
  hasDrilldown: boolean;
  asOfNow: boolean;
  branchScoped: boolean;
}
export interface ReportCatalogue {
  canExport: boolean;
  exportFormats: Array<'xlsx' | 'pdf' | 'csv'>;
  reports: ReportDefinition[];
}
export type ReportRow = Record<string, string | number | boolean | null | undefined>;
export interface ReportPeriod {
  from: string | null;
  to: string | null;
  asOf?: string;
}
export interface ReportResult extends ReportDefinition {
  generatedAt: string;
  timeZone: string;
  currency: string;
  period: ReportPeriod;
  branchIds: string[] | null;
  filters: Record<string, unknown>;
  columns: ReportColumn[];
  rows: ReportRow[];
  totals: ReportRow | null;
  chart: { type: 'bar' | 'line' | 'pie'; x: string; series: Array<{ key: string; label: string }> } | null;
  notes: string[];
}
export interface ReportDrilldown {
  key: string;
  title: string;
  period: ReportPeriod;
  columns: ReportColumn[];
  rows: ReportRow[];
  notes: string[];
  meta: PageMeta;
}
export type RelativeRangeKey = 'today' | 'yesterday' | 'last_7_days' | 'last_30_days' | 'last_week' | 'month_to_date' | 'last_month' | 'year_to_date';
export interface ScheduledReportRow {
  id: string;
  reportKey: string;
  reportTitle: string;
  params: { range: RelativeRangeKey; branchId?: string; serviceId?: string; corporateAccountId?: string; component?: 'GOVERNMENT_FEE' | 'THIRD_PARTY_FEE'; withinDays?: number };
  format: 'XLSX' | 'PDF';
  frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  timeOfDay: string;
  weekday: number | null;
  dayOfMonth: number | null;
  timeZone: string;
  recipients: string[];
  isActive: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  createdById: string | null;
  createdAt: string;
  link?: string;
}
export interface ScheduledRun {
  ranAt: string;
  dueAt: string | null;
  status: string;
  detail: string | null;
  period: { from: string; to: string } | null;
  format: string | null;
  rows: number | null;
  recipients: string[] | null;
  documentId: string | null;
  document: { id: string; title: string; filename: string; mime: string; sizeBytes: number; available: boolean } | null;
}

// ---------------------------------------------------------------- subscription
export interface SubscriptionPlanView {
  id?: string;
  key: string;
  name: string;
  description?: string | null;
  monthlyPrice: string;
  annualPrice: string;
  currency: string;
  limits: PlanLimits;
  features: PlanFeatures;
}
export interface SubscriptionOpenInvoice {
  id: string;
  number: string;
  reason: string;
  total: string;
  currency: string;
  dueAt: string;
  overdue: boolean;
}
export interface SubscriptionView {
  tenantStatus: TenantStatus;
  suspendedForNonPayment: boolean;
  subscription: {
    id: string;
    status: SubscriptionStatus;
    billingCycle: BillingCycle;
    currentPeriodStart: string;
    currentPeriodEnd: string;
    trialEndsAt: string | null;
    trialDaysLeft: number | null;
    graceEndsAt: string | null;
    cancelAtPeriodEnd: boolean;
    cancelledAt: string | null;
    cancellationReason: string | null;
    price: string;
  } | null;
  plan: SubscriptionPlanView | null;
  pendingChange: { plan: { key: string; name: string } | null; billingCycle: BillingCycle | null; effective: string; effectiveAt: string | null } | null;
  coupon: { code: string; percentOff: string | null; amountOff: string | null; endsAt: string | null } | null;
  usage: Array<{ metric: string; used: number; limit: number }>;
  openInvoices: SubscriptionOpenInvoice[];
}
export interface PlanChangeResult extends SubscriptionView {
  change: { kind: 'UPGRADE' | 'DOWNGRADE' | 'CYCLE_ONLY' | 'WITHDRAWN'; effective: string; invoiceId: string | null; amount: string | null };
}
export interface PlanStartResult extends SubscriptionView {
  outcome: 'TRIAL_STARTED' | 'PAYMENT_REQUIRED' | 'ACTIVE';
  invoiceId: string | null;
}
export type SubscriptionInvoiceRow = Omit<SubscriptionInvoice, 'lines' | 'gatewayRef'> & { lines: Array<{ description: string; amount: string; couponCode?: string | null }> | null };
export interface SubscriptionCheckout {
  invoiceId: string;
  number: string;
  amount: string;
  currency: string;
  gateway: string;
  testMode: boolean;
  checkoutUrl: string;
  expiresAt: string;
}

// ---------------------------------------------------------------- audit
export interface AuditEntry {
  id: string;
  createdAt: string;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  summary: string | null;
  actorType: 'STAFF' | 'CUSTOMER' | 'CORPORATE' | 'PLATFORM' | 'SYSTEM' | 'AUTOMATION';
  actorLabel: string | null;
  actorUserId: string | null;
  supportGrantId: string | null;
  requestId: string | null;
  ip: string | null;
}
export interface AuditEntryDetail extends AuditEntry {
  before: unknown;
  after: unknown;
  userAgent: string | null;
}

/** A request as far as money screens need it (GET /requests/:id). */
export interface RequestBrief {
  id: string;
  requestNo: string;
  status: RequestStatus;
  statusLabel: Bilingual;
  branch: { id: string; code: string; name: string; nameAr: string | null } | null;
  customer: { id: string; customerNo: string; fullName: string; fullNameAr: string | null } | null;
  corporateAccount: { id: string; companyName: string } | null;
  service: { id: string; name: string; nameAr: string | null; code: string } | null;
}
export interface CustomerBrief {
  id: string;
  customerNo: string;
  fullName: string;
  fullNameAr: string | null;
  corporateAccountId: string | null;
}
