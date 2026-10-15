import { Injectable, OnModuleInit } from '@nestjs/common';
import type { Customer, Document, OcrExtractionResult, Prisma } from '@typease/database';
import { OCR_DATE_FIELDS, OCR_FIELD_KEYS, OcrApplyInput, OcrExtractInput, OcrFieldKey, OcrResultsQuery, OcrReviewInput, OcrUsageQuery } from '@typease/validation';
import { env } from '../../config/env';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { blindIndex, decryptText, encryptText, last4, maskTail } from '../../common/crypto';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { AppError, Errors, found } from '../../common/errors';
import { JobMeta, JobQueue } from '../../common/jobs/job-queue';
import { D, pageArgs, pageResult } from '../../common/pagination';
import { periodKey, UsageService } from '../../common/usage.service';
import { DocumentAccess } from '../documents/access';
import { DocumentsService, notAvailable } from '../documents/documents.service';
import { dayToDate, documentDownloadable, isoDay } from '../documents/presenters';
import { DocumentClass, extractDocument, FIELD_LABELS, FieldSource } from './extractors';
import { OcrProviders } from './providers';
import { buildWarnings, matchesOnFile, OcrWarning, OnFile } from './warnings';

/** Identity numbers are encrypted inside the stored JSON, like on the customer record. */
const SENSITIVE_KEYS: OcrFieldKey[] = ['passportNumber', 'emiratesIdNumber', 'cardNumber', 'personalNumber'];
/** Reviewed fields that `apply` knows how to copy somewhere. Everything else is for the reviewer's eyes only. */
export const APPLICABLE_KEYS: OcrFieldKey[] = ['fullName', 'nationality', 'dateOfBirth', 'passportNumber', 'emiratesIdNumber', 'issuingState', 'expiryDate', 'issueDate'];
export const UNVERIFIED_NOTICE = 'Read automatically from the document. Not verified: compare every value with the document before using it.';

interface StoredField {
  key: OcrFieldKey;
  value: string | null;
  valueEnc?: string;
  confidence: number;
  source: FieldSource;
}
type Decision = 'CONFIRMED' | 'CORRECTED' | 'ADDED' | 'REJECTED';
interface StoredReviewedField {
  key: OcrFieldKey;
  value: string | null;
  valueEnc?: string;
  decision: Decision;
}
interface StoredReview {
  fields: StoredReviewedField[];
  note: string | null;
  applied: Array<{ at: string; by: string | null; keys: OcrFieldKey[] }>;
}

const seal = <T extends { key: OcrFieldKey; value: string | null }>(field: T): T & { valueEnc?: string } =>
  field.value !== null && SENSITIVE_KEYS.includes(field.key) ? { ...field, value: null, valueEnc: encryptText(field.value) } : field;
const unseal = <T extends { value: string | null; valueEnc?: string }>(field: T): Omit<T, 'valueEnc'> => {
  const { valueEnc, ...rest } = field;
  return { ...rest, value: valueEnc ? decryptText(valueEnc) : field.value };
};
const validIsoDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/** Normalises and validates a value typed by the reviewer. Returns the canonical form or an error text. */
export function normaliseReviewedValue(key: OcrFieldKey, raw: string): { value: string } | { error: string } {
  const v = raw.trim();
  if (!v) return { error: 'is empty' };
  if (OCR_DATE_FIELDS.includes(key)) return validIsoDay(v) ? { value: v } : { error: 'must be a real date written as YYYY-MM-DD' };
  switch (key) {
    case 'passportNumber': {
      const n = v.toUpperCase().replace(/\s/g, '');
      return /^[A-Z0-9]{5,12}$/.test(n) ? { value: n } : { error: 'must be 5-12 letters or digits' };
    }
    case 'emiratesIdNumber': {
      const n = v.replace(/[\s-]/g, '');
      return /^784\d{12}$/.test(n) ? { value: `${n.slice(0, 3)}-${n.slice(3, 7)}-${n.slice(7, 14)}-${n.slice(14)}` } : { error: 'must have 15 digits starting with 784' };
    }
    case 'nationality':
    case 'issuingState': {
      const n = v.toUpperCase();
      return /^[A-Z]{1,3}$/.test(n) ? { value: n } : { error: 'must be a country code such as IND' };
    }
    case 'sex': {
      const n = v.toUpperCase();
      return ['M', 'F', 'X'].includes(n) ? { value: n } : { error: 'must be M, F or X' };
    }
    case 'cardNumber':
    case 'personalNumber':
    case 'licenceNumber': {
      const n = v.toUpperCase();
      return /^[A-Z0-9][A-Z0-9/ -]{0,29}$/.test(n) ? { value: n } : { error: 'may only contain letters, digits, "/" and "-"' };
    }
    default:
      return v.length <= 200 ? { value: v.replace(/\s+/g, ' ') } : { error: 'is too long' };
  }
}

/**
 * AI document assistant: OCR + field extraction with mandatory human review.
 *
 *  - Nothing runs unless an OCR engine is configured (OCR_PROVIDER), the centre
 *    switched AI on, the plan includes it and the monthly page limit allows it.
 *  - A customer who withdrew consent for AI processing is never processed.
 *  - Results are suggestions. COMPLETED means "waiting for a person"; only a
 *    REVIEWED result can be applied, only field by field, only on request.
 *  - The recognised text is used in memory and discarded: it is never stored
 *    or logged.
 */
@Injectable()
export class OcrService implements OnModuleInit {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly jobs: JobQueue,
    private readonly usage: UsageService,
    private readonly providers: OcrProviders,
    private readonly documents: DocumentsService,
    private readonly access: DocumentAccess,
  ) {}

  onModuleInit() {
    this.jobs.register<{ tenantId: string; resultId: string }>('ocr.extract', (payload, meta) => this.process(payload.resultId, meta), { attempts: 3, backoffMs: 20_000 });
  }

  // ------------------------------------------------------------------ gates
  private async assertTenantAllowsAi(tx: Tx, pages = 1): Promise<void> {
    const tenant = await tx.tenant.findFirstOrThrow({ where: { id: this.db.tenantId }, select: { aiEnabled: true } });
    if (!tenant.aiEnabled) throw Errors.forbidden('AI_DISABLED', 'AI document processing is switched off for this centre. An owner can switch it on in the centre settings.');
    await this.usage.assertFeature('aiAssistant', tx);
    await this.usage.assertWithinLimit('aiPages', tx, pages);
  }

  private async subjectCustomerId(tx: Tx, doc: Pick<Document, 'customerId' | 'requestId'>): Promise<string | null> {
    if (doc.customerId) return doc.customerId;
    if (!doc.requestId) return null;
    const request = await tx.serviceRequest.findFirst({ where: { id: doc.requestId, tenantId: this.db.tenantId }, select: { customerId: true } });
    return request?.customerId ?? null;
  }

  /**
   * Consent rule: processing is refused when the customer has an explicit
   * WITHDRAWN record for the purpose AI_PROCESSING. Without any record,
   * staff-initiated processing is carried out under the contract basis (the
   * customer asked the centre to handle the document).
   */
  private async consentWithdrawn(tx: Tx, customerId: string | null): Promise<boolean> {
    if (!customerId) return false;
    const consent = await tx.customerConsent.findFirst({ where: { tenantId: this.db.tenantId, customerId, purpose: 'AI_PROCESSING' } });
    return consent?.status === 'WITHDRAWN';
  }

  // ------------------------------------------------------------------ request
  async requestExtraction(documentId: string, input: OcrExtractInput) {
    const provider = this.providers.require();
    const tenantId = this.db.tenantId;
    return this.db.tx(async (tx) => {
      await this.assertTenantAllowsAi(tx);
      const doc = await this.access.findReadable(tx, documentId);
      const version = doc.currentVersionId ? await tx.documentVersion.findFirst({ where: { id: doc.currentVersionId, tenantId } }) : null;
      if (!version || !documentDownloadable(doc, version)) throw notAvailable(doc, version);
      const mime = version.detectedMime ?? version.declaredMime;
      if (!provider.supports(mime)) {
        throw Errors.unprocessable('OCR_UNSUPPORTED_FILE', provider.name === 'tesseract' ? 'The built-in OCR engine reads images (JPG, PNG, WebP) only. Upload a photo or scan image of the document.' : 'This file type cannot be read by the configured OCR engine.');
      }
      if (await this.consentWithdrawn(tx, await this.subjectCustomerId(tx, doc))) {
        throw Errors.forbidden('AI_CONSENT_WITHDRAWN', 'This customer has withdrawn consent for AI processing of their documents. Enter the details by hand.');
      }
      // Asking twice for the same file does not start (or bill) a second run.
      const running = await tx.ocrExtractionResult.findFirst({ where: { tenantId, documentId: doc.id, versionId: version.id, status: { in: ['QUEUED', 'PROCESSING'] } } });
      if (running) return this.summary(running);

      let profile: string = input.profile;
      if (profile === 'AUTO') {
        const type = await tx.documentType.findFirst({ where: { key: doc.documentTypeKey, OR: [{ tenantId }, { tenantId: null }] }, orderBy: { tenantId: 'asc' } });
        profile = type && type.ocrProfile !== 'NONE' ? type.ocrProfile : 'AUTO';
      }
      const result = await tx.ocrExtractionResult.create({
        data: { tenantId, documentId: doc.id, versionId: version.id, provider: provider.name, profile, status: 'QUEUED', requestedById: ctx().userId ?? null },
      });
      await this.audit.log({ action: 'ocr.requested', resourceType: 'OcrExtractionResult', resourceId: result.id, after: { documentId: doc.id, versionId: version.id, provider: provider.name, profile } }, tx);
      this.db.afterCommit(() => this.jobs.enqueue('ocr.extract', { tenantId, resultId: result.id }, { jobId: `ocr.extract:${result.id}` }));
      return this.summary(result);
    });
  }

  // ------------------------------------------------------------------ job
  /** Runs the engine and stores the suggestions. Idempotent: a finished result is never processed again. */
  async process(resultId: string, meta: JobMeta): Promise<void> {
    const tenantId = this.db.tenantId;
    const claim = await this.db.tx(async (tx) => {
      const result = await tx.ocrExtractionResult.findFirst({ where: { id: resultId, tenantId } });
      if (!result || !['QUEUED', 'PROCESSING'].includes(result.status)) return null;
      await tx.ocrExtractionResult.update({ where: { id: result.id }, data: { status: 'PROCESSING' } });
      // The switches are checked again: they may have changed while the job was waiting.
      let blocked: string | null = null;
      try {
        await this.assertTenantAllowsAi(tx);
      } catch (e) {
        blocked = e instanceof AppError ? e.message : 'AI processing is not available.';
      }
      const doc = await tx.document.findFirst({ where: { id: result.documentId, tenantId } });
      if (!blocked && doc && (await this.consentWithdrawn(tx, await this.subjectCustomerId(tx, doc)))) blocked = 'The customer has withdrawn consent for AI processing.';
      return { result, blocked };
    });
    if (!claim) return;
    const { result } = claim;
    if (claim.blocked) return this.fail(result, claim.blocked, false);
    if (!this.providers.configured) return this.fail(result, 'No OCR engine is configured.', false);
    const provider = this.providers.current;

    const loaded = await this.documents.readForProcessing(result.documentId, result.versionId, 'OCR_PROCESSED');
    if (!loaded) return this.fail(result, 'The document is no longer available.', false);
    const mime = loaded.version.detectedMime ?? loaded.version.declaredMime;

    let recognised: { text: string; pages: number; confidence: number };
    try {
      recognised = await provider.recognise(loaded.content, mime);
    } catch (e: any) {
      // Outages are retried by the queue; a definite refusal (unsupported file, not configured) is final.
      if (!(e instanceof AppError) && meta.attempt < meta.maxAttempts) throw e;
      return this.fail(result, e instanceof AppError ? e.message : 'The OCR engine could not read this document. Please try again later.', true, provider.name);
    }

    const hint = (['PASSPORT', 'EMIRATES_ID', 'TRADE_LICENCE'] as DocumentClass[]).includes(result.profile as DocumentClass) ? (result.profile as DocumentClass) : null;
    const extraction = extractDocument(recognised.text, { hint, ocrConfidence: recognised.confidence });
    recognised.text = ''; // the raw text is not needed any more and is never persisted
    const onFile = await this.db.tx((tx) => this.loadOnFile(tx, loaded.document));
    const warnings = buildWarnings(extraction, onFile);
    const pages = Math.max(1, Math.floor(recognised.pages) || 1);
    const cost = D(env().OCR_COST_PER_PAGE).mul(pages);

    await this.db.tx(async (tx) => {
      const done = await tx.ocrExtractionResult.updateMany({
        where: { id: result.id, tenantId, status: 'PROCESSING' },
        data: {
          status: 'COMPLETED',
          classification: extraction.classification,
          classificationConfidence: extraction.classificationConfidence,
          fields: extraction.fields.map((f) => seal(f)) as unknown as Prisma.InputJsonValue,
          warnings: warnings as unknown as Prisma.InputJsonValue,
          pages,
          costUnits: cost,
          error: null,
          completedAt: new Date(),
        },
      });
      if (!done.count) return;
      await tx.aiUsageLog.create({ data: { tenantId, provider: provider.name, operation: 'ocr.extract', documentId: result.documentId, pages, units: pages, costEstimate: cost, actorId: result.requestedById, success: true } });
      await this.usage.record('aiPages', pages, tx);
      await this.audit.log(
        {
          action: 'ocr.completed',
          resourceType: 'OcrExtractionResult',
          resourceId: result.id,
          // Field names and warning codes only: extracted values do not belong in the audit trail.
          after: { documentId: result.documentId, classification: extraction.classification, fields: extraction.fields.map((f) => f.key), warnings: warnings.map((w) => w.code), pages },
        },
        tx,
      );
    });
  }

  private async fail(result: OcrExtractionResult, message: string, engineWasCalled: boolean, provider = result.provider): Promise<void> {
    const tenantId = this.db.tenantId;
    await this.db.tx(async (tx) => {
      const changed = await tx.ocrExtractionResult.updateMany({ where: { id: result.id, tenantId, status: { in: ['QUEUED', 'PROCESSING'] } }, data: { status: 'FAILED', error: message.slice(0, 300), completedAt: new Date() } });
      if (!changed.count) return;
      if (engineWasCalled) {
        await tx.aiUsageLog.create({ data: { tenantId, provider, operation: 'ocr.extract', documentId: result.documentId, pages: 0, units: 0, costEstimate: 0, actorId: result.requestedById, success: false } });
      }
      await this.audit.log({ action: 'ocr.failed', resourceType: 'OcrExtractionResult', resourceId: result.id, summary: message.slice(0, 300) }, tx);
    });
  }

  // ------------------------------------------------------------------ profile comparison
  /** Decrypts what is on file so it can be compared. The values stay inside this service: never logged, never returned in full. */
  private async loadOnFile(tx: Tx, doc: Document): Promise<OnFile | null> {
    const customerId = await this.subjectCustomerId(tx, doc);
    const customer = customerId ? await tx.customer.findFirst({ where: { id: customerId, tenantId: this.db.tenantId } }) : null;
    if (!customer) return doc.expiryDate ? { documentExpiryDate: isoDay(doc.expiryDate) } : null;
    return { ...this.customerOnFile(customer), documentExpiryDate: isoDay(doc.expiryDate) };
  }
  private customerOnFile(customer: Customer): OnFile {
    return {
      fullName: customer.fullName,
      dateOfBirth: isoDay(customer.dateOfBirth),
      nationality: customer.nationality,
      passportNumber: customer.passportNoEnc ? decryptText(customer.passportNoEnc) : null,
      emiratesIdNumber: customer.emiratesIdEnc ? decryptText(customer.emiratesIdEnc) : null,
    };
  }

  // ------------------------------------------------------------------ read
  private summary(r: OcrExtractionResult) {
    const warnings = (r.warnings as unknown as OcrWarning[]) ?? [];
    return {
      id: r.id,
      documentId: r.documentId,
      versionId: r.versionId,
      provider: r.provider,
      profile: r.profile,
      status: r.status,
      /** True until a person has reviewed the result. */
      unverified: r.status !== 'REVIEWED',
      classification: r.classification,
      classificationConfidence: r.classificationConfidence === null ? null : Number(r.classificationConfidence),
      fieldCount: ((r.fields as unknown as StoredField[]) ?? []).length,
      warningCount: { high: warnings.filter((w) => w.severity === 'HIGH').length, medium: warnings.filter((w) => w.severity === 'MEDIUM').length, low: warnings.filter((w) => w.severity === 'LOW').length },
      pages: r.pages,
      costUnits: r.costUnits.toString(),
      error: r.error,
      requestedById: r.requestedById,
      reviewedById: r.reviewedById,
      reviewedAt: r.reviewedAt,
      createdAt: r.createdAt,
      completedAt: r.completedAt,
    };
  }

  private async findResult(tx: Tx, id: string): Promise<{ result: OcrExtractionResult; doc: Document }> {
    const result = found(await tx.ocrExtractionResult.findFirst({ where: { id, tenantId: this.db.tenantId } }), 'Extraction result');
    // The same document rules apply to its extractions (branch, assignment).
    const doc = await this.access.findReadable(tx, result.documentId).catch(() => {
      throw Errors.notFound('Extraction result');
    });
    return { result, doc };
  }

  /**
   * Extractions of ONE document. The document must exist and be readable by the caller: an unknown id, a document
   * of another centre or one outside the caller's scope answers 404 - never an empty list that looks like "this
   * document has no extractions".
   */
  async listForDocument(documentId: string) {
    await this.db.tx(async (tx) => {
      found(await tx.document.findFirst({ where: { AND: [{ id: documentId, tenantId: this.db.tenantId }, await this.access.readFilter(tx)] }, select: { id: true } }), 'Document');
    });
    return this.list({ documentId, page: 1, pageSize: 50 } as OcrResultsQuery);
  }

  async list(query: OcrResultsQuery) {
    return this.db.tx(async (tx) => {
      const where: Prisma.OcrExtractionResultWhereInput = {
        tenantId: this.db.tenantId,
        document: await this.access.readFilter(tx),
        ...(query.status ? { status: query.status } : {}),
        ...(query.documentId ? { documentId: query.documentId } : {}),
      };
      const [rows, total] = await Promise.all([tx.ocrExtractionResult.findMany({ where, ...pageArgs(query, ['createdAt', 'completedAt'] as const, 'createdAt:desc') }), tx.ocrExtractionResult.count({ where })]);
      return pageResult(rows.map((r) => this.summary(r)), total, query);
    });
  }

  /** The human review screen: each field as extracted, next to what is on file, with confidence. */
  async get(id: string) {
    return this.db.tx(async (tx) => {
      const { result, doc } = await this.findResult(tx, id);
      const customerId = await this.subjectCustomerId(tx, doc);
      const customer = customerId ? await tx.customer.findFirst({ where: { id: customerId, tenantId: this.db.tenantId } }) : null;
      const onFile: OnFile = { ...(customer ? this.customerOnFile(customer) : {}), documentExpiryDate: isoDay(doc.expiryDate) };
      // What may be SHOWN from the file: identity numbers only masked.
      const display: Partial<Record<OcrFieldKey, string | null>> = {
        fullName: customer?.fullName ?? null,
        dateOfBirth: isoDay(customer?.dateOfBirth),
        nationality: customer?.nationality ?? null,
        passportNumber: maskTail(customer?.passportNoLast4),
        emiratesIdNumber: maskTail(customer?.emiratesIdLast4),
        issuingState: customer?.passportCountry ?? null,
        expiryDate: isoDay(doc.expiryDate),
        issueDate: isoDay(doc.issuedDate),
      };
      const extracted = ((result.fields as unknown as StoredField[]) ?? []).map((f) => unseal(f));
      const review = result.reviewedFields as unknown as StoredReview | null;
      const reviewed = (review?.fields ?? []).map((f) => unseal(f));
      const keys = OCR_FIELD_KEYS.filter((k) => extracted.some((f) => f.key === k) || reviewed.some((f) => f.key === k));
      return {
        ...this.summary(result),
        notice: result.status === 'REVIEWED' ? null : UNVERIFIED_NOTICE,
        customerId,
        fields: keys.map((key) => {
          const e = extracted.find((f) => f.key === key);
          const r = reviewed.find((f) => f.key === key);
          const shown = display[key];
          return {
            key,
            label: FIELD_LABELS[key],
            extracted: e ? { value: e.value, confidence: e.confidence, source: e.source } : null,
            onFile: shown === undefined ? null : { value: shown ?? null, matches: matchesOnFile(key, r?.value ?? e?.value, onFile) },
            reviewed: r ? { value: r.value, decision: r.decision } : null,
            canApply: APPLICABLE_KEYS.includes(key),
          };
        }),
        warnings: (result.warnings as unknown as OcrWarning[]) ?? [],
        reviewNote: review?.note ?? null,
        applied: review?.applied ?? [],
      };
    });
  }

  // ------------------------------------------------------------------ review
  /** A person confirms, corrects or rejects the suggestions. Stores what THEY read on the document. */
  async review(id: string, input: OcrReviewInput) {
    await this.db.tx(async (tx) => {
      const { result } = await this.findResult(tx, id);
      if (!['COMPLETED', 'REVIEWED'].includes(result.status)) {
        throw Errors.conflict('OCR_NOT_READY', result.status === 'FAILED' ? 'This extraction failed. Run it again or enter the details by hand.' : 'This extraction has not finished yet.');
      }
      const extracted = ((result.fields as unknown as StoredField[]) ?? []).map((f) => unseal(f));
      const problems: Array<{ path: string; message: string }> = [];
      const fields: StoredReviewedField[] = input.fields.map((f, i) => {
        const original = extracted.find((e) => e.key === f.key)?.value ?? null;
        if (f.value === null || f.value.trim() === '') return { key: f.key, value: null, decision: 'REJECTED' as Decision };
        const normalised = normaliseReviewedValue(f.key, f.value);
        if ('error' in normalised) {
          problems.push({ path: `fields.${i}.value`, message: `${FIELD_LABELS[f.key]} ${normalised.error}.` });
          return { key: f.key, value: null, decision: 'REJECTED' as Decision };
        }
        const decision: Decision = original === null ? 'ADDED' : original === normalised.value ? 'CONFIRMED' : 'CORRECTED';
        return seal({ key: f.key, value: normalised.value, decision });
      });
      if (problems.length) throw Errors.unprocessable('INVALID_REVIEW_VALUE', 'Some values are not valid. Please correct them.', problems);
      const previous = result.reviewedFields as unknown as StoredReview | null;
      const review: StoredReview = { fields, note: input.note ?? null, applied: previous?.applied ?? [] };
      await tx.ocrExtractionResult.update({
        where: { id: result.id },
        data: { status: 'REVIEWED', reviewedFields: review as unknown as Prisma.InputJsonValue, reviewedById: ctx().userId ?? null, reviewedAt: new Date() },
      });
      await this.audit.log(
        { action: 'ocr.reviewed', resourceType: 'OcrExtractionResult', resourceId: result.id, after: { documentId: result.documentId, decisions: Object.fromEntries(fields.map((f) => [f.key, f.decision])) } },
        tx,
      );
    });
    return this.get(id);
  }

  // ------------------------------------------------------------------ apply
  /**
   * Copies reviewed fields, chosen one by one, to the customer profile and the
   * document. This is the only path from an extraction to stored customer data.
   */
  async apply(id: string, input: OcrApplyInput) {
    const tenantId = this.db.tenantId;
    await this.db.tx(async (tx) => {
      const { result, doc } = await this.findResult(tx, id);
      if (result.status !== 'REVIEWED') throw Errors.conflict('OCR_NOT_REVIEWED', 'Only values that a person has reviewed can be applied. Review this extraction first.');
      const review = result.reviewedFields as unknown as StoredReview;
      const keys = [...new Set(input.fields)];
      const values = new Map<OcrFieldKey, string>();
      for (const key of keys) {
        if (!APPLICABLE_KEYS.includes(key)) throw Errors.unprocessable('FIELD_NOT_APPLICABLE', `${FIELD_LABELS[key]} cannot be applied automatically. Update it by hand where it is needed.`);
        const reviewed = review.fields.map((f) => unseal(f)).find((f) => f.key === key);
        if (!reviewed || reviewed.decision === 'REJECTED' || !reviewed.value) {
          throw Errors.unprocessable('FIELD_NOT_REVIEWED', `${FIELD_LABELS[key]} was not confirmed in the review, so it cannot be applied.`);
        }
        values.set(key, reviewed.value);
      }

      let documentClass = result.classification as DocumentClass | null;
      if (documentClass !== 'PASSPORT' && documentClass !== 'EMIRATES_ID') {
        documentClass = (['PASSPORT', 'EMIRATES_ID'] as DocumentClass[]).includes(result.profile as DocumentClass) ? (result.profile as DocumentClass) : null;
      }

      // ---- document
      const docData: Prisma.DocumentUpdateInput = {};
      if (values.has('expiryDate')) {
        docData.expiryDate = dayToDate(values.get('expiryDate'))!;
        docData.expiryVerified = true; // a person read this date on the document
      }
      if (values.has('issueDate')) docData.issuedDate = dayToDate(values.get('issueDate'))!;

      // ---- customer profile
      const profileKeys = keys.filter((k) => ['fullName', 'nationality', 'dateOfBirth', 'passportNumber', 'emiratesIdNumber', 'issuingState'].includes(k));
      const customerId = await this.subjectCustomerId(tx, doc);
      const customer = customerId ? await tx.customer.findFirst({ where: { id: customerId, tenantId } }) : null;
      const data: Prisma.CustomerUpdateInput = {};
      if (profileKeys.length) {
        if (!customer) throw Errors.unprocessable('NO_CUSTOMER_FOR_DOCUMENT', 'This document is not linked to a customer, so profile fields cannot be applied.');
        if (customer.status === 'ANONYMISED' || customer.status === 'MERGED' || customer.deletedAt) throw Errors.conflict('CUSTOMER_INACTIVE', 'This customer record is no longer active.');
        if (values.has('fullName')) data.fullName = values.get('fullName')!;
        if (values.has('nationality')) data.nationality = values.get('nationality')!;
        if (values.has('dateOfBirth')) data.dateOfBirth = dayToDate(values.get('dateOfBirth'))!;
        if (values.has('issuingState')) {
          if (documentClass !== 'PASSPORT') throw Errors.unprocessable('FIELD_NOT_APPLICABLE', 'The issuing country can only be applied from a passport.');
          data.passportCountry = values.get('issuingState')!;
        }
        // Identity numbers: same scheme as the customers module (ciphertext + blind index + last four characters).
        const duplicate = async (column: 'passportNoHash' | 'emiratesIdHash', hash: string, label: string) => {
          const other = await tx.customer.findFirst({ where: { tenantId, [column]: hash, id: { not: customer.id }, deletedAt: null, status: { in: ['ACTIVE', 'ARCHIVED'] } }, select: { id: true } });
          if (other) throw Errors.conflict('IDENTITY_NUMBER_IN_USE', `Another customer record already has this ${label}. Check for a duplicate record before applying it.`);
        };
        if (values.has('passportNumber')) {
          const number = values.get('passportNumber')!;
          const hash = blindIndex(tenantId, 'passport', number);
          await duplicate('passportNoHash', hash, 'passport number');
          Object.assign(data, { passportNoEnc: encryptText(number), passportNoHash: hash, passportNoLast4: last4(number) });
        }
        if (values.has('emiratesIdNumber')) {
          const number = values.get('emiratesIdNumber')!.replace(/-/g, '');
          const hash = blindIndex(tenantId, 'emiratesId', number);
          await duplicate('emiratesIdHash', hash, 'Emirates ID number');
          Object.assign(data, { emiratesIdEnc: encryptText(number), emiratesIdHash: hash, emiratesIdLast4: last4(number) });
        }
      }
      // The document's expiry is also the profile's passport / Emirates ID expiry.
      if (values.has('expiryDate') && customer && customer.status === 'ACTIVE' && documentClass) {
        if (documentClass === 'PASSPORT') data.passportExpiry = dayToDate(values.get('expiryDate'))!;
        if (documentClass === 'EMIRATES_ID') data.emiratesIdExpiry = dayToDate(values.get('expiryDate'))!;
      }

      if (Object.keys(docData).length) {
        const updated = await tx.document.update({ where: { id: doc.id }, data: docData });
        // Same event as a date typed on the document, so expiry reminders are scheduled / rescheduled.
        if (values.has('expiryDate')) await this.documents.emitExpiryChanged(tx, updated, doc.expiryDate, 'OCR');
      }
      if (customer && Object.keys(data).length) {
        await tx.customer.update({ where: { id: customer.id }, data: { ...data, version: { increment: 1 } } });
        await this.audit.log(
          {
            action: 'customer.updated_from_document',
            resourceType: 'Customer',
            resourceId: customer.id,
            summary: `Reviewed values applied from extraction ${result.id}.`,
            // Which fields changed. Identity numbers are never written to the audit trail.
            before: { fullName: customer.fullName, nationality: customer.nationality, dateOfBirth: isoDay(customer.dateOfBirth), passportNo: maskTail(customer.passportNoLast4), emiratesId: maskTail(customer.emiratesIdLast4) },
            after: { fields: Object.keys(data).filter((k) => !/Enc$|Hash$|Last4$/.test(k)), identityNumbersChanged: ['passportNumber', 'emiratesIdNumber'].filter((k) => values.has(k as OcrFieldKey)) },
          },
          tx,
        );
      }
      review.applied = [...(review.applied ?? []), { at: new Date().toISOString(), by: ctx().userId ?? null, keys }];
      await tx.ocrExtractionResult.update({ where: { id: result.id }, data: { reviewedFields: review as unknown as Prisma.InputJsonValue } });
      await this.audit.log(
        { action: 'ocr.applied', resourceType: 'OcrExtractionResult', resourceId: result.id, after: { documentId: doc.id, customerId: customer && Object.keys(data).length ? customer.id : null, keys } },
        tx,
      );
    });
    return this.get(id);
  }

  // ------------------------------------------------------------------ usage
  async usageReport(query: OcrUsageQuery) {
    const now = new Date();
    const from = query.from ? new Date(`${query.from}T00:00:00.000Z`) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const to = query.to ? new Date(`${query.to}T23:59:59.999Z`) : now;
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const tenant = await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { aiEnabled: true } });
      const plan = await this.usage.plan(tx);
      const usedThisMonth = await this.usage.current('aiPages', tx);
      const where = { tenantId, createdAt: { gte: from, lte: to } };
      const grouped = await tx.aiUsageLog.groupBy({ by: ['provider', 'operation', 'success', 'currency'], where, _count: { _all: true }, _sum: { pages: true, costEstimate: true } });
      const recent = await tx.aiUsageLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50 });
      const ok = grouped.filter((g) => g.success);
      const limit = plan.limits.aiPages;
      return {
        aiEnabled: tenant.aiEnabled,
        provider: { name: this.providers.current.name, configured: this.providers.configured },
        plan: { includesAiAssistant: plan.features.aiAssistant, monthlyPageLimit: limit },
        currentMonth: { period: periodKey(now), pagesUsed: usedThisMonth, pagesRemaining: limit === -1 ? null : Math.max(0, limit - usedThisMonth) },
        range: { from, to },
        totals: {
          extractions: ok.reduce((n, g) => n + g._count._all, 0),
          failed: grouped.filter((g) => !g.success).reduce((n, g) => n + g._count._all, 0),
          pages: ok.reduce((n, g) => n + (g._sum.pages ?? 0), 0),
          /** Estimate: pages x OCR_COST_PER_PAGE as configured by the operator. Not an invoice. */
          costEstimate: ok.reduce((sum, g) => sum.plus(D(g._sum.costEstimate)), D(0)).toFixed(4),
          currency: grouped[0]?.currency ?? 'USD',
        },
        byProvider: grouped.map((g) => ({ provider: g.provider, operation: g.operation, success: g.success, count: g._count._all, pages: g._sum.pages ?? 0, costEstimate: D(g._sum.costEstimate).toFixed(4) })),
        recent: recent.map((l) => ({ id: l.id, provider: l.provider, operation: l.operation, documentId: l.documentId, pages: l.pages, costEstimate: l.costEstimate.toFixed(4), currency: l.currency, success: l.success, actorId: l.actorId, createdAt: l.createdAt })),
      };
    });
  }
}
