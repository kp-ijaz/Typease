import { z } from 'zod';
import { isoDate, isoDateTime, optionalText, pageQuery, trimmed, uuid } from './common';

export const REQUEST_STATUSES = [
  'DRAFT', 'SUBMITTED', 'AWAITING_CUSTOMER', 'UNDER_REVIEW', 'QUOTED', 'AWAITING_PAYMENT', 'READY_FOR_PROCESSING', 'IN_PREPARATION',
  'PENDING_APPROVAL', 'READY_TO_SUBMIT', 'EXTERNAL_PROCESSING', 'RETURNED', 'REJECTED', 'FINAL_REVIEW', 'COMPLETED', 'CANCELLED',
] as const;
export const REQUEST_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export const REQUEST_SOURCES = ['WALK_IN', 'ONLINE', 'MOBILE', 'CORPORATE'] as const;
/** Dashboard buckets: the keys of STATUS_BUCKETS plus two computed ones. */
export const REQUEST_BUCKETS = ['newRequests', 'pendingVerification', 'awaitingCustomer', 'awaitingPayment', 'readyForProcessing', 'inProgress', 'completedToday', 'overdue'] as const;
export const SUBMISSION_CHANNELS = ['MANUAL_PORTAL', 'AUTHORISED_PARTNER', 'OFFICIAL_API'] as const;
export const EXTERNAL_OUTCOMES = ['COMPLETED', 'RETURNED', 'REJECTED'] as const;
export const ASSIGNMENT_ROLES = ['OPERATOR', 'REVIEWER'] as const;

const requestStatus = z.enum(REQUEST_STATUSES);
const requestPriority = z.enum(REQUEST_PRIORITIES);
const documentTypeKeyRef = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{1,39}$/, 'Use the key of a document type');
const fieldKey = z.string().trim().min(1).max(80);

/** Form values keyed by field key. `null` clears a value. Checked against the service's form on the server. */
export const requestFieldValues = z
  .record(fieldKey, z.unknown())
  .refine((v) => Object.keys(v).length <= 300, 'Too many fields')
  .refine((v) => JSON.stringify(v).length <= 100_000, 'The form data is too large');

/**
 * Create a request (always as a DRAFT).
 *  - staff: `customerId` is required; `branchId` defaults to their branch / the head office.
 *  - customers: for themselves; `customerId` is ignored.
 *  - corporate admins: `corporateEmployeeId` for an employee, `customerId` for a record of the company,
 *    or neither for the company itself.
 */
export const createServiceRequestSchema = z.object({
  serviceId: uuid,
  customerId: uuid.optional(),
  branchId: uuid.optional(),
  /** Staff only: bill the request to this corporate account. */
  corporateAccountId: uuid.optional(),
  /** Corporate admins: the employee the request is for. */
  corporateEmployeeId: uuid.optional(),
  priority: requestPriority.optional(),
  instructions: optionalText(2000),
  fields: requestFieldValues.optional(),
  /** Staff only. */
  targetDate: isoDateTime.optional(),
  /** Renewal of the document tracked by this expiry reminder. */
  renewalOfScheduleId: uuid.optional(),
});
export type CreateServiceRequestBody = z.infer<typeof createServiceRequestSchema>;

export const updateServiceRequestSchema = z
  .object({
    instructions: optionalText(2000),
    /** Staff only. */
    priority: requestPriority.optional(),
    /** Staff only. */
    targetDate: isoDateTime.nullable().optional(),
    /** Optimistic concurrency: the `version` the client last saw. */
    version: z.number().int().min(1).optional(),
  })
  .refine((v) => v.instructions !== undefined || v.priority !== undefined || v.targetDate !== undefined, 'Nothing to change');
export type UpdateServiceRequestBody = z.infer<typeof updateServiceRequestSchema>;

export const saveRequestFieldsSchema = z.object({ values: requestFieldValues });
export type SaveRequestFieldsBody = z.infer<typeof saveRequestFieldsSchema>;

/** "A,B" or repeated query parameters -> array. */
const csvOf = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess((v) => (v === undefined || v === '' ? undefined : (Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim()).filter(Boolean)), z.array(item).max(20).optional());

export const serviceRequestListQuery = pageQuery.extend({
  status: csvOf(requestStatus),
  bucket: z.enum(REQUEST_BUCKETS).optional(),
  branchId: uuid.optional(),
  /** A membership id, or `me`. */
  assignedToId: z.union([z.literal('me'), uuid]).optional(),
  customerId: uuid.optional(),
  corporateAccountId: uuid.optional(),
  serviceId: uuid.optional(),
  priority: csvOf(requestPriority),
  source: csvOf(z.enum(REQUEST_SOURCES)),
  createdFrom: isoDate.optional(),
  createdTo: isoDate.optional(),
  submittedFrom: isoDate.optional(),
  submittedTo: isoDate.optional(),
  completedFrom: isoDate.optional(),
  completedTo: isoDate.optional(),
});
export type ServiceRequestListQuery = z.infer<typeof serviceRequestListQuery>;

export const serviceRequestCountsQuery = z.object({ branchId: uuid.optional() });
export type ServiceRequestCountsQuery = z.infer<typeof serviceRequestCountsQuery>;

/** Generic status change. Only edges of the state machine are accepted; guards and permissions apply. */
export const requestTransitionSchema = z.object({
  to: requestStatus,
  reason: optionalText(500),
  /** Shown to the customer instead of the standard wording. */
  customerMessage: optionalText(500),
  version: z.number().int().min(1).optional(),
});
export type RequestTransitionBody = z.infer<typeof requestTransitionSchema>;

export const requestReasonSchema = z.object({ reason: trimmed(500, 3) });
export type RequestReasonBody = z.infer<typeof requestReasonSchema>;

export const requestNoteSchema = z.object({ note: optionalText(500) });
export type RequestNoteBody = z.infer<typeof requestNoteSchema>;

export const assignRequestSchema = z.object({
  assigneeMembershipId: uuid,
  role: z.enum(ASSIGNMENT_ROLES).default('OPERATOR'),
  /** Mandatory when somebody else is already assigned. */
  reason: optionalText(300),
});
export type AssignRequestBody = z.infer<typeof assignRequestSchema>;

export const requestInformationSchema = z.object({
  /** Shown to the customer. */
  message: trimmed(1000, 5),
  /** Existing checklist lines the customer must fix. */
  checklistItemIds: z.array(uuid).max(30).optional(),
  /** New documents to ask for. */
  addItems: z
    .array(z.object({ documentTypeKey: documentTypeKeyRef, label: trimmed(120, 2), labelAr: optionalText(120), isMandatory: z.boolean().default(true) }))
    .max(10)
    .optional(),
});
export type RequestInformationBody = z.infer<typeof requestInformationSchema>;

export const addChecklistItemSchema = z.object({
  documentTypeKey: documentTypeKeyRef,
  label: trimmed(120, 2),
  labelAr: optionalText(120),
  isMandatory: z.boolean().default(true),
  /** INPUT = needed from the customer; COMPLETION = a deliverable of the request. */
  kind: z.enum(['INPUT', 'COMPLETION']).default('INPUT'),
});
export type AddChecklistItemBody = z.infer<typeof addChecklistItemSchema>;

export const linkChecklistDocumentSchema = z.object({ documentId: uuid });
export type LinkChecklistDocumentBody = z.infer<typeof linkChecklistDocumentSchema>;

export const decideRequestApprovalSchema = z
  .object({ decision: z.enum(['APPROVED', 'REJECTED']), comment: optionalText(1000) })
  .refine((v) => v.decision === 'APPROVED' || (v.comment ?? '').length >= 3, { message: 'Explain what has to be corrected', path: ['comment'] });
export type DecideRequestApprovalBody = z.infer<typeof decideRequestApprovalSchema>;

export const requestCommentSchema = z.object({
  body: trimmed(4000, 1),
  visibility: z.enum(['INTERNAL', 'CUSTOMER']).default('INTERNAL'),
});
export type RequestCommentBody = z.infer<typeof requestCommentSchema>;

export const markRequestDuplicateSchema = z.object({ duplicateOfId: uuid });
export type MarkRequestDuplicateBody = z.infer<typeof markRequestDuplicateSchema>;

/**
 * Record a submission made through a permitted channel. There is deliberately
 * no status-source field: the source is derived from the channel and can never
 * be claimed by the client.
 */
export const recordExternalReferenceSchema = z
  .object({
    channel: z.enum(SUBMISSION_CHANNELS),
    authorityName: optionalText(160),
    referenceNo: trimmed(120, 2),
    partnerName: optionalText(160),
    partnerReference: optionalText(120),
    notes: optionalText(1000),
  })
  .strict();
export type RecordExternalReferenceBody = z.infer<typeof recordExternalReferenceSchema>;

export const updateExternalReferenceSchema = z
  .object({ status: trimmed(200, 2).optional(), notes: optionalText(1000) })
  .strict()
  .refine((v) => v.status !== undefined || v.notes !== undefined, 'Nothing to change');
export type UpdateExternalReferenceBody = z.infer<typeof updateExternalReferenceSchema>;

export const recordExternalResultSchema = z
  .object({ outcome: z.enum(EXTERNAL_OUTCOMES), note: optionalText(1000) })
  .strict()
  .refine((v) => v.outcome === 'COMPLETED' || (v.note ?? '').length >= 3, { message: 'Describe what the authority or partner reported', path: ['note'] });
export type RecordExternalResultBody = z.infer<typeof recordExternalResultSchema>;

export const completeWorkflowStepSchema = z.object({ stepKey: z.string().trim().min(1).max(40).optional(), note: optionalText(500) });
export type CompleteWorkflowStepBody = z.infer<typeof completeWorkflowStepSchema>;

/** Public tracking: request number + the tracking code given to the customer at submission. */
export const publicTrackRequestSchema = z.object({
  tenantSlug: z.string().trim().toLowerCase().max(50).optional(),
  requestNo: z.string().trim().toUpperCase().min(3).max(40),
  trackingCode: z.string().trim().min(6).max(64),
});
export type PublicTrackRequestBody = z.infer<typeof publicTrackRequestSchema>;

// ---------------------------------------------------------------- board time limits
/** Minutes a request may stay in a status before its card turns red and managers are told. Null removes the limit. */
export const boardTimeLimitsSchema = z.object({
  limits: z.record(z.string().regex(/^[A-Z_]{3,30}$/), z.number().int().min(5).max(60 * 24 * 60).nullable()),
});
export type BoardTimeLimitsInput = z.infer<typeof boardTimeLimitsSchema>;
