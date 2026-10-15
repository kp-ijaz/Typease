import { z } from 'zod';
import { isoDate, optionalText, pageQuery, queryBool, trimmed, uuid } from './common';

/**
 * Document vault + AI document assistant (OCR) request shapes.
 * Shared by the API and the web / mobile apps.
 */

const typeKey = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/, 'Use a document type key such as "passport"');
const boolField = z.union([z.boolean(), z.enum(['true', 'false'])]).transform((v) => v === true || v === 'true');

export const DOCUMENT_STATUSES = ['PENDING_UPLOAD', 'PENDING_SCAN', 'AVAILABLE', 'QUARANTINED', 'DELETED'] as const;
export const DOCUMENT_VERIFICATION_STATUSES = ['UNVERIFIED', 'VERIFIED', 'REJECTED'] as const;
export const DOCUMENT_DECISIONS = ['APPROVED', 'REJECTED', 'CORRECTION_REQUESTED'] as const;

/** Who the document belongs to and how it is filed. Shared by both upload paths. */
const documentOwnerFields = {
  customerId: uuid.optional(),
  corporateAccountId: uuid.optional(),
  requestId: uuid.optional(),
  /** request_documents.id: the checklist line this upload answers. */
  checklistItemId: uuid.optional(),
  documentTypeKey: typeKey,
  title: trimmed(200).optional(),
  category: optionalText(80),
  /** Adds a new version to this document instead of creating a new one. */
  replacesDocumentId: uuid.optional(),
  /** As stated by the uploader. Stays unverified until a reviewer confirms it. */
  expiryDate: isoDate.optional(),
  issuedDate: isoDate.optional(),
};

/** Step 1 of the upload flow: POST /documents/upload-intents */
export const documentUploadIntentSchema = z.object({
  ...documentOwnerFields,
  filename: trimmed(255),
  mime: z.string().trim().toLowerCase().min(3).max(100),
  /** Exact size of the file in bytes. The upload URL only accepts a body of this size. */
  sizeBytes: z.coerce.number().int().positive(),
  /** Staff only. Defaults to true. */
  customerVisible: z.boolean().optional(),
});
export type DocumentUploadIntentInput = z.infer<typeof documentUploadIntentSchema>;

/** Text fields of the multipart convenience endpoint POST /documents/upload (plus the `file` part). */
export const documentMultipartFieldsSchema = z.object({ ...documentOwnerFields, customerVisible: boolField.optional() });
export type DocumentMultipartFields = z.infer<typeof documentMultipartFieldsSchema>;

export const documentListQuery = pageQuery.extend({
  customerId: uuid.optional(),
  requestId: uuid.optional(),
  corporateAccountId: uuid.optional(),
  /** Document type key, e.g. passport */
  type: typeKey.optional(),
  category: z.string().trim().max(80).optional(),
  status: z.enum(DOCUMENT_STATUSES).optional(),
  verificationStatus: z.enum(DOCUMENT_VERIFICATION_STATUSES).optional(),
  /** Documents whose expiry date is on or before this day. */
  expiringBefore: isoDate.optional(),
  /** Staff only: include soft-deleted documents. */
  includeDeleted: queryBool,
});
export type DocumentListQuery = z.infer<typeof documentListQuery>;

export const documentUpdateSchema = z
  .object({
    title: trimmed(200),
    category: optionalText(80),
    documentTypeKey: typeKey,
    expiryDate: isoDate.nullable(),
    issuedDate: isoDate.nullable(),
    customerVisible: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type DocumentUpdateInput = z.infer<typeof documentUpdateSchema>;

export const documentDownloadLinkSchema = z.object({
  disposition: z.enum(['attachment', 'inline']).default('attachment'),
  /** Staff only: an earlier version instead of the current one. */
  versionId: uuid.optional(),
});
export type DocumentDownloadLinkInput = z.infer<typeof documentDownloadLinkSchema>;

export const documentVerifySchema = z
  .object({
    decision: z.enum(DOCUMENT_DECISIONS),
    reason: optionalText(500),
    /** Sending a date means the reviewer confirmed it against the document. */
    expiryDate: isoDate.nullish(),
    issuedDate: isoDate.nullish(),
  })
  .refine((v) => v.decision === 'APPROVED' || (v.reason ?? '').length >= 3, { path: ['reason'], message: 'Give the reason so the customer knows what to fix' });
export type DocumentVerifyInput = z.infer<typeof documentVerifySchema>;

export const DOCUMENT_SHARE_MAX_HOURS = 7 * 24;
export const documentShareSchema = z.object({
  expiresInHours: z.coerce.number().int().min(1).max(DOCUMENT_SHARE_MAX_HOURS).default(24),
  maxDownloads: z.coerce.number().int().min(1).max(20).default(3),
  /** Free-text note about who the link is for (not used for delivery). */
  recipient: optionalText(200),
});
export type DocumentShareInput = z.infer<typeof documentShareSchema>;

export const documentLegalHoldSchema = z.object({ legalHold: z.boolean(), reason: trimmed(500, 3) });
export const documentChecklistAssistQuery = z.object({ requestId: uuid });
export const documentAccessLogQuery = pageQuery.pick({ page: true, pageSize: true });

// ---------------------------------------------------------------------------- AI document assistant

export const OCR_EXTRACTION_PROFILES = ['AUTO', 'PASSPORT', 'EMIRATES_ID', 'TRADE_LICENCE'] as const;
export const OCR_RESULT_STATUSES = ['QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'REVIEWED'] as const;
/** Every field the assistant can extract. Values are suggestions until a person reviews them. */
export const OCR_FIELD_KEYS = [
  'passportNumber', 'cardNumber', 'emiratesIdNumber', 'surname', 'givenNames', 'fullName', 'nationality', 'issuingState',
  'dateOfBirth', 'sex', 'expiryDate', 'issueDate', 'personalNumber', 'licenceNumber', 'companyName',
] as const;
export type OcrFieldKey = (typeof OCR_FIELD_KEYS)[number];
export const OCR_DATE_FIELDS: OcrFieldKey[] = ['dateOfBirth', 'expiryDate', 'issueDate'];

export const ocrExtractSchema = z.object({
  /** AUTO uses the document type's OCR profile and falls back to classification from the text. */
  profile: z.enum(OCR_EXTRACTION_PROFILES).default('AUTO'),
});
export type OcrExtractInput = z.infer<typeof ocrExtractSchema>;

export const ocrReviewSchema = z.object({
  fields: z
    .array(
      z.object({
        key: z.enum(OCR_FIELD_KEYS),
        /** The value the reviewer read on the document. null = the reviewer rejects this field. */
        value: z.string().trim().max(200).nullable(),
      }),
    )
    .min(1)
    .max(OCR_FIELD_KEYS.length)
    .refine((list) => new Set(list.map((f) => f.key)).size === list.length, 'Each field may appear once'),
  note: optionalText(500),
});
export type OcrReviewInput = z.infer<typeof ocrReviewSchema>;

export const ocrApplySchema = z.object({
  /** Reviewed fields to copy to the customer profile / document. Nothing is applied implicitly. */
  fields: z.array(z.enum(OCR_FIELD_KEYS)).min(1).max(OCR_FIELD_KEYS.length),
});
export type OcrApplyInput = z.infer<typeof ocrApplySchema>;

export const ocrResultsQuery = pageQuery.pick({ page: true, pageSize: true, sort: true }).extend({
  status: z.enum(OCR_RESULT_STATUSES).optional(),
  documentId: uuid.optional(),
});
export type OcrResultsQuery = z.infer<typeof ocrResultsQuery>;
export const ocrUsageQuery = z.object({ from: isoDate.optional(), to: isoDate.optional() });
export type OcrUsageQuery = z.infer<typeof ocrUsageQuery>;
