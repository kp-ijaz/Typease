/**
 * Response shapes of the "ops" endpoints, modelled on the real JSON of the API
 * (docs/api/modules/{catalogue,workflows,appointments,queue,reminders,support,notifications,automation}.md).
 */
import type { FormSchema, Rule, RuleOp } from '@typease/types';

// ---------------------------------------------------------------- catalogue

export type ComplianceCapability = 'DOCUMENT_PREPARATION_ONLY' | 'PARTNER_COORDINATION' | 'DIRECT_AUTHORISED' | 'INFORMATIONAL_ONLY';
export type PaymentPolicy = 'BEFORE_PROCESSING' | 'AFTER_COMPLETION' | 'DEPOSIT';
export type TaxMode = 'SERVICE_FEE_ONLY' | 'ALL_COMPONENTS' | 'NONE';

export interface ServiceCategory {
  id: string;
  key: string;
  name: string;
  nameAr: string | null;
  description: string | null;
  icon: string | null;
  sortOrder: number;
  isActive: boolean;
  serviceCount: number;
}

export interface DocumentTypeRow {
  id: string;
  key: string;
  name: string;
  nameAr: string | null;
  hasExpiry: boolean;
  ocrProfile: 'NONE' | 'PASSPORT' | 'EMIRATES_ID' | 'TRADE_LICENCE';
  reminderEnabled: boolean;
  isActive: boolean;
  source: 'PLATFORM' | 'TENANT';
  overridesPlatformDefault: boolean;
}

export interface PriceRow {
  id: string;
  serviceId: string;
  branchId: string | null;
  serviceFee: string;
  governmentFeeEstimate: string;
  thirdPartyFeeEstimate: string;
  currency: string;
  validFrom: string;
  validTo: string | null;
  isActive: boolean;
  createdAt: string;
  branch?: { id: string; name: string; nameAr?: string | null; code?: string } | null;
}

export interface Service {
  id: string;
  categoryId: string;
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
  taxMode: TaxMode;
  onlineAvailable: boolean;
  isPublic: boolean;
  isActive: boolean;
  allBranches: boolean;
  staffGroupRoleKey: string | null;
  workflowDefinitionId: string | null;
  sortOrder: number;
  version: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  category: { id: string; key: string; name: string; nameAr: string | null; icon: string | null; isActive: boolean };
  branchIds: string[];
  price: PriceRow | null;
}

export interface Requirement {
  id: string;
  serviceId: string;
  documentTypeKey: string;
  label: string;
  labelAr: string | null;
  description: string | null;
  isMandatory: boolean;
  allowReuse: boolean;
  maxAgeDays: number | null;
  sortOrder: number;
}

export type FormStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
export interface FormVersionRef {
  id: string;
  version: number;
  status: FormStatus;
  publishedAt: string | null;
  updatedAt: string;
}
export interface FormVersionRow extends FormVersionRef {
  createdAt: string;
  steps: number;
  fields: number;
}
export interface FormVersion extends FormVersionRef {
  schema: FormSchema;
}

export interface ServiceDetail extends Service {
  activePrices: PriceRow[];
  requirements: Requirement[];
  workflowDefinition: { id: string; key: string; name: string } | null;
  form: { published: FormVersionRef | null; draft: FormVersionRef | null };
}

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
  priceId: string;
  source: 'DEFAULT' | 'BRANCH';
  branchId: string | null;
  currency: string;
  serviceFee: string;
  governmentFeeEstimate: string;
  thirdPartyFeeEstimate: string;
  taxMode: TaxMode;
  taxRatePercent: string;
  components: PriceComponent[];
  subtotal: string;
  taxableAmount: string;
  taxAmount: string;
  total: string;
  paymentPolicy: PaymentPolicy;
  depositPercent: string | null;
  dueBeforeProcessing: string;
  containsEstimates: boolean;
}

// ---------------------------------------------------------------- workflows

export type WorkflowStepType =
  | 'CUSTOMER_FORM' | 'DOCUMENT_UPLOAD' | 'STAFF_VERIFICATION' | 'INTERNAL_APPROVAL' | 'CUSTOMER_APPROVAL' | 'QUOTATION' | 'PAYMENT' | 'STAFF_TASK'
  | 'EXTERNAL_PROCESSING' | 'NOTIFICATION' | 'DOCUMENT_GENERATION' | 'COMPLETION' | 'CONDITIONAL_BRANCH';

export interface WorkflowStep {
  id?: string;
  position?: number;
  key: string;
  name: string;
  nameAr: string | null;
  type: WorkflowStepType;
  config: Record<string, unknown>;
  conditions: Rule | null;
  branches: Array<{ when: Rule; goTo: string }> | null;
  nextStepKey: string | null;
  onRejectStepKey: string | null;
  assigneeRoleKey: string | null;
  timeoutHours: number | null;
  escalateToRoleKey: string | null;
  customerVisible: boolean;
}
export type WorkflowVersionStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
export interface WorkflowVersion {
  id: string;
  definitionId: string;
  version: number;
  status: WorkflowVersionStatus;
  notes: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  steps: WorkflowStep[];
}
export interface WorkflowVersionRow extends Omit<WorkflowVersion, 'steps'> {
  stepCount: number;
  casesUsing: number;
}
export interface WorkflowListItem {
  id: string;
  key: string;
  name: string;
  description: string | null;
  templateKey: string | null;
  isDefault: boolean;
  archived: boolean;
  servicesUsing: number;
  versionCount: number;
  publishedVersion: { id: string; version: number; publishedAt: string | null; stepCount: number } | null;
  draftVersion: { id: string; version: number; stepCount: number } | null;
}
export interface WorkflowDetail {
  id: string;
  key: string;
  name: string;
  description: string | null;
  templateKey: string | null;
  isDefault: boolean;
  servicesUsing: number;
  publishedVersion: WorkflowVersion | null;
  draftVersion: WorkflowVersion | null;
}
export interface WorkflowTemplate {
  key: string;
  name: string;
  description: string;
  steps: Array<{ key: string; name: string; nameAr: string | null; type: WorkflowStepType; customerVisible: boolean; position: number }>;
}
export interface WorkflowMeta {
  stepTypes: Array<{ type: WorkflowStepType; label: string; waitsFor: string | null; status: string | null }>;
  facts: string[];
  operators: RuleOp[];
  roles: Array<{ key: string; name: string }>;
  timeoutHours: { min: number; max: number };
  defaultDefinitionId: string | null;
}
export interface WorkflowProblem {
  code: string;
  stepKey?: string;
  message: string;
}

// ---------------------------------------------------------------- appointments

export type AppointmentStatus = 'BOOKED' | 'CONFIRMED' | 'CHECKED_IN' | 'IN_SERVICE' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW' | 'RESCHEDULED';
export interface Appointment {
  id: string;
  branchId: string;
  branchName: string;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  guestName: string | null;
  guestPhone: string | null;
  serviceId: string | null;
  serviceName: string | null;
  requestId: string | null;
  staffId: string | null;
  staffName: string | null;
  startsAt: string;
  endsAt: string;
  localDate: string;
  localTime: string;
  localEndTime: string;
  timezone: string;
  status: AppointmentStatus;
  source: string;
  notes: string | null;
  cancelledReason: string | null;
  checkedInAt: string | null;
  customerNoShowCount: number;
  queueToken?: { id: string; tokenNo: string; status: string; counter: string | null } | null;
}
export interface Slot {
  startsAt: string;
  endsAt: string;
  localStart: string;
  localEnd: string;
  available: boolean;
  remaining: number;
  capacity: number;
  booked: number;
  staffOnDuty: number;
}
export interface Availability {
  branchId: string;
  date: string;
  timezone: string;
  closed: boolean;
  closedReason: string | null;
  bookableUntil: string;
  slots: Slot[];
}
export interface SlotConfig {
  id: string;
  branchId: string;
  serviceId: string | null;
  weekday: number;
  startTime: string;
  endTime: string;
  slotMinutes: number;
  capacity: number;
  isActive: boolean;
}
export interface Closure {
  id: string;
  branchId: string;
  date: string;
  reason: string | null;
  affectedAppointments?: number;
}
export interface AppointmentSettings {
  guestBookingEnabled: boolean;
  noShowAfterMinutes: number;
  customerCancelCutoffMinutes: number;
  reminderHoursBefore: number[];
  maxDaysAhead: number;
  limitToStaffOnDuty: boolean;
}

// ---------------------------------------------------------------- queue

export type QueueStatus = 'WAITING' | 'CALLED' | 'SERVING' | 'COMPLETED' | 'NO_SHOW' | 'CANCELLED';
export interface QueueToken {
  id: string;
  tokenNo: string;
  branchId: string;
  queueDate: string;
  categoryId: string | null;
  categoryName: string | null;
  customerId: string | null;
  customerName: string | null;
  appointmentId: string | null;
  status: QueueStatus;
  counter: string | null;
  servedByName: string | null;
  issuedAt: string;
  calledAt: string | null;
  servedAt: string | null;
  completedAt: string | null;
  waitSeconds: number | null;
}
export interface QueueBoard {
  branchId: string;
  date: string;
  summary: { waiting: number; called: number; serving: number; completed: number; noShow: number; cancelled: number };
  tokens: QueueToken[];
}
export interface QueueCounters {
  branchId: string;
  date: string;
  counters: Array<{ counter: string; current: { id: string; tokenNo: string; status: QueueStatus; calledAt: string | null; servedByName: string | null } | null; servedToday: number; noShowsToday: number }>;
}
interface Timing {
  average: number | null;
  median: number | null;
  p90: number | null;
}
export interface QueueStats {
  branchId: string;
  from: string;
  to: string;
  timezone: string;
  tokens: { total: number; completed: number; noShows: number; cancelled: number; daysWithTokens: number };
  waitSeconds: Timing;
  serviceSeconds: Timing;
  noShowRate: number | null;
  tokensPerHour: Array<{ hour: number; count: number; averagePerDay: number }>;
}
export interface DisplayLink {
  token: string;
  branchId: string;
  expiresAt: string;
}
export interface DisplayState {
  branch: { name: string; nameAr: string | null };
  date: string;
  language: string;
  nowServing: Array<{ tokenNo: string; counter: string | null; status: 'CALLED' | 'SERVING' }>;
  nextUp: string[];
  waitingCount: number;
  generatedAt: string;
}

// ---------------------------------------------------------------- reminders

export type ReminderStatus = 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';
export interface ReminderDispatch {
  id: string;
  offsetDays: number;
  dueOn: string;
  status: string;
  detail: string | null;
  notificationId: string | null;
  processedAt: string | null;
}
export interface Reminder {
  id: string;
  customerId: string | null;
  customerName: string | null;
  customerNo: string | null;
  corporateAccountId: string | null;
  corporateName: string | null;
  documentId: string | null;
  documentTypeKey: string;
  documentTypeName: string;
  documentTypeNameAr: string | null;
  subjectLabel: string;
  expiryDate: string;
  daysLeft: number;
  offsetsDays: number[];
  status: ReminderStatus;
  nextReminderOn: string | null;
  lastReminderAt: string | null;
  renewalRequestId: string | null;
  createdAt: string;
  dispatches?: ReminderDispatch[];
}

// ---------------------------------------------------------------- support

export type TicketStatus = 'OPEN' | 'IN_PROGRESS' | 'WAITING_CUSTOMER' | 'RESOLVED' | 'CLOSED';
export type TicketPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
export interface TicketMessage {
  id: string;
  authorType: 'CUSTOMER' | 'STAFF' | 'CORPORATE' | 'SYSTEM' | string;
  authorName: string | null;
  visibility: 'CUSTOMER' | 'INTERNAL';
  body: string;
  attachments: Array<{ documentId: string; title: string | null }>;
  createdAt: string;
}
export interface TicketFeedback {
  id: string;
  rating: number;
  comment: string | null;
  createdAt: string;
}
export interface Ticket {
  id: string;
  ticketNo: string;
  subject: string;
  category: string | null;
  priority: TicketPriority;
  status: TicketStatus;
  customerId: string | null;
  customerName: string | null;
  customerNo: string | null;
  requestId: string | null;
  requestNo: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  firstResponseDueAt: string | null;
  resolutionDueAt: string | null;
  firstRespondedAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  resolutionSummary: string | null;
  firstResponseBreached: boolean;
  resolutionBreached: boolean;
  createdAt: string;
  updatedAt: string;
  messages?: TicketMessage[];
  feedback?: TicketFeedback | null;
}
export interface SlaPolicy {
  priority: TicketPriority;
  name: string;
  firstResponseMinutes: number;
  resolutionMinutes: number;
  isActive: boolean;
}
export interface FeedbackRow {
  id: string;
  kind: 'TICKET' | 'REQUEST';
  rating: number;
  comment: string | null;
  customerId: string | null;
  customerName: string | null;
  ticketId: string | null;
  ticketNo: string | null;
  ticketSubject: string | null;
  requestId: string | null;
  requestNo: string | null;
  createdAt: string;
}
export interface FeedbackSummary {
  from: string;
  to: string;
  overall: { count: number; average: number | null };
  months: Array<{ month: string; count: number; average: number | null; tickets: number; requests: number; distribution: Record<string, number> }>;
}
export interface PlatformTicket {
  id: string;
  ticketNo: string;
  subject: string;
  category: string | null;
  status: TicketStatus;
  priority?: TicketPriority;
  resolvedAt: string | null;
  closedAt: string | null;
  resolutionSummary: string | null;
  canReply: boolean;
  createdAt: string;
  updatedAt: string;
  messages?: Array<{ id: string; fromSupport: boolean; authorName: string | null; body: string; createdAt: string }>;
}

// ---------------------------------------------------------------- notifications

export type NotificationChannel = 'EMAIL' | 'SMS' | 'WHATSAPP' | 'IN_APP' | 'PUSH';
export type NotificationStatus = 'QUEUED' | 'SENT' | 'DELIVERED' | 'FAILED' | 'SUPPRESSED';
export interface InboxItem {
  id: string;
  eventKey: string;
  subject: string | null;
  body: string | null;
  relatedType: string | null;
  relatedId: string | null;
  readAt: string | null;
  createdAt: string;
}
export interface ChannelStatus {
  channel: NotificationChannel;
  provider: string | null;
  source: 'TENANT' | 'PLATFORM' | 'BUILT_IN' | 'NONE';
  configured: boolean;
  detail: string | null;
}
export interface EventSetting {
  eventKey: string;
  label: string;
  group: string;
  audience: string;
  locked: boolean;
  channels: Partial<Record<NotificationChannel, boolean>>;
}
export interface NotificationSettings {
  rateLimitPerHour: number;
  events: EventSetting[];
}
export interface NotificationEvent {
  eventKey: string;
  label: string;
  group: string;
  variables: Array<{ name: string; description: string }>;
}
export interface TemplateRow {
  eventKey: string;
  label: string;
  channel: NotificationChannel;
  language: 'en' | 'ar';
  source: 'TENANT' | 'DEFAULT';
  name: string | null;
  subject: string | null;
  body: string;
  whatsappTemplateName: string | null;
  enabled: boolean;
  default: { subject: string | null; body: string } | null;
  variables: string[];
}
export interface TemplatePreview {
  subject: string | null;
  text: string;
  html: string | null;
  whatsappParameters?: Array<{ name: string; value: string } | string> | null;
  unknownVariables: string[];
}
export interface NotificationLogRow {
  id: string;
  eventKey: string;
  eventLabel: string | null;
  channel: NotificationChannel;
  language: string;
  status: NotificationStatus;
  suppressedReason: string | null;
  recipientAddress: string | null;
  recipientCustomerId: string | null;
  subject: string | null;
  createdAt: string;
  sentAt: string | null;
  attempts: number;
  provider: string | null;
  lastError: string | null;
  body?: string | null;
  deliveries?: Array<{ id: string; attempt: number; provider: string | null; status: string; error: string | null; requestedAt: string; completedAt: string | null }>;
}
export interface FailureSummary {
  total: number;
  byChannel: Array<{ channel: NotificationChannel; count: number }>;
  byEvent: Array<{ eventKey: string; eventLabel: string | null; count: number }>;
}

// ---------------------------------------------------------------- automations

export interface FactMeta {
  key: string;
  label?: string;
  type?: 'string' | 'number' | 'boolean';
  values?: string[] | null;
}
export interface AutomationTrigger {
  key: string;
  label: string;
  hasRequest: 'ALWAYS' | 'SOMETIMES' | 'NEVER' | string;
  hasCustomer: 'ALWAYS' | 'SOMETIMES' | 'NEVER' | string;
  facts: FactMeta[];
  variables: Array<{ key: string; description: string }>;
}
export interface AutomationMeta {
  available: boolean;
  triggers: AutomationTrigger[];
  actions: Array<{ type: string; label: string; needsRequest: boolean; needsCustomer: boolean }>;
  operators: RuleOp[];
  channels: NotificationChannel[];
  automaticStatuses: Array<{ status: string; label: string }>;
  webhook: { configured: boolean; source: string | null; approvedHosts: string[]; signature: string };
  limits: { maxActions: number; maxRetries: number; maxConditionsPerGroup: number };
}
export interface AutomationActionRow {
  type: string;
  label?: string;
  config: Record<string, unknown>;
}
export interface AutomationProblem {
  path: string;
  code: string;
  message: string;
}
export interface AutomationRule {
  id: string;
  name: string;
  description: string | null;
  templateKey: string | null;
  triggerEvent: string;
  triggerLabel: string;
  conditions: Rule;
  actions: AutomationActionRow[];
  isEnabled: boolean;
  maxRetries: number;
  createdAt: string;
  updatedAt: string;
  stats?: { total: number; succeeded: number; failed: number; deadLetter: number; lastExecutionAt: string | null };
  problems?: AutomationProblem[];
}
export interface AutomationTemplate {
  key: string;
  name: string;
  description: string;
  category: string;
  triggerEvent: string;
  triggerLabel: string;
  actions: AutomationActionRow[];
  requires: string | null;
}
interface ExecutionCounters {
  total: number;
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  skipped: number;
  deadLetter: number;
}
export interface AutomationSummary {
  available: boolean;
  rules: { total: number; enabled: number; disabled: number };
  executions: { last24h: ExecutionCounters; last7d: ExecutionCounters; allTime: ExecutionCounters };
  deadLetters: { open: number; recent?: Execution[] };
}
export type ExecutionStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'DEAD_LETTER';
export interface ExecutionAction {
  index: number;
  type: string;
  label: string;
  status: 'PENDING' | 'SUCCEEDED' | 'SKIPPED' | 'FAILED';
  attempts: number;
  finishedAt: string | null;
  config?: Record<string, unknown>;
  output?: Record<string, unknown> | null;
  error?: { code: string; message: string; retryable?: boolean } | null;
}
export interface Execution {
  id: string;
  ruleId: string;
  ruleName: string;
  eventId: string;
  eventType: string;
  eventLabel: string;
  status: ExecutionStatus;
  attempts: number;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  maxRetries: number;
  canRetry: boolean;
  event?: { occurredAt: string; data: Record<string, unknown> };
  actions: ExecutionAction[];
}
export interface DryRun {
  dryRun: true;
  rule: { id: string; name: string; isEnabled: boolean };
  event: { id: string; type: string; label: string; occurredAt: string; data: Record<string, unknown> };
  facts: Record<string, unknown>;
  conditions: Array<{ group: 'all' | 'any'; fact: string; label: string; op: RuleOp; value: unknown; actual: unknown; passed: boolean }>;
  conditionsMet: boolean;
  wouldRun: boolean;
  notes: string[];
  /** Empty when the conditions are not met. */
  actions?: Array<{ index: number; type: string; label: string; config?: Record<string, unknown>; applicable: boolean; preview?: Record<string, unknown> | null; note?: string; reason?: string }>;
}
