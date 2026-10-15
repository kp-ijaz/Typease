import { ERASED_CUSTOMER_STATUS, isErasedCustomer } from '../../common/customer-ref';
import { Injectable } from '@nestjs/common';
import type { Document, DocumentVersion, Prisma } from '@typease/database';
import type { DocumentDownloadLinkInput, DocumentListQuery, DocumentUpdateInput, DocumentUploadIntentInput, DocumentVerifyInput } from '@typease/validation';
import { env } from '../../config/env';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { sha256 } from '../../common/crypto';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { AppError, Errors, found } from '../../common/errors';
import { DomainEvents } from '../../common/events.service';
import { detectMime, safeFilename } from '../../common/files';
import { JobQueue } from '../../common/jobs/job-queue';
import { pageArgs, pageResult } from '../../common/pagination';
import { GeneratedDocumentInput, RestrictedDownloadLink } from '../../common/ports';
import { UsageService } from '../../common/usage.service';
import { StorageObjectNotFound } from '../storage/local.driver';
import { StorageService } from '../storage/storage.service';
import { DocumentAccess, ResolvedOwner } from './access';
import { allowedUploadMime, dayToDate, documentDownloadable, INLINE_MIME, isoDay, normaliseMime, presentDocument, presentVersion, RESTRICTED_PREFIX, restrictedCategory, SYSTEM_GENERATED, UPLOAD, versionDownloadable } from './presenters';

const MB = 1024 * 1024;
const SORTABLE = ['createdAt', 'updatedAt', 'expiryDate', 'title'] as const;
const OPEN_REQUEST: Prisma.ServiceRequestWhereInput = { status: { notIn: ['COMPLETED', 'CANCELLED'] }, deletedAt: null };
/** How long a soft-deleted document can still be restored before its files are removed. */
export const PURGE_GRACE_DAYS = 30;

export type AccessAction =
  | 'UPLOAD_INTENT' | 'UPLOAD' | 'VIEW' | 'DOWNLOAD_LINK' | 'PREVIEW_LINK' | 'UPDATE' | 'VERIFY' | 'DELETE' | 'RESTORE' | 'LEGAL_HOLD'
  | 'SHARE_CREATED' | 'SHARE_REVOKED' | 'SHARE_DOWNLOAD' | 'OCR_PROCESSED' | 'GENERATED' | 'PURGED' | 'QUARANTINED';

export const notAvailable = (doc: Pick<Document, 'status'>, version: Pick<DocumentVersion, 'scanStatus'> | null) => {
  if (doc.status === 'QUARANTINED' || version?.scanStatus === 'INFECTED') {
    return Errors.conflict('DOCUMENT_QUARANTINED', 'This file was blocked by the malware scanner and cannot be opened. Please upload a clean copy.');
  }
  if (doc.status === 'PENDING_SCAN' || version?.scanStatus === 'PENDING') {
    return Errors.conflict('DOCUMENT_NOT_READY', 'This file is still being checked. Please try again in a moment.');
  }
  if (doc.status === 'PENDING_UPLOAD') return Errors.conflict('DOCUMENT_NOT_READY', 'The upload of this file has not been completed yet.');
  if (doc.status === 'DELETED') return Errors.notFound('Document');
  return Errors.conflict('DOCUMENT_NOT_AVAILABLE', 'This file cannot be opened until it has passed the malware scan.');
};

/**
 * The document vault: upload intents, completion checks, metadata, versions,
 * verification, deletion and short-lived download links.
 *
 * Storage keys never leave this module: API responses carry document and
 * version ids, and bytes are only reachable through signed URLs that expire
 * within DOWNLOAD_URL_TTL_SECONDS.
 */
/** Title of a document whose owner was erased. */
export const ERASED_DOCUMENT_TITLE = 'Erased document';

@Injectable()
export class DocumentsService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly jobs: JobQueue,
    private readonly usage: UsageService,
    private readonly storage: StorageService,
    private readonly access: DocumentAccess,
  ) {}

  // ------------------------------------------------------------------ helpers
  /** Append-only access trail (who, what, from where). Written in the caller's transaction. */
  async logAccess(tx: Tx, documentId: string, versionId: string | null, action: AccessAction): Promise<void> {
    const c = ctx();
    await tx.documentAccessLog.create({
      data: {
        tenantId: this.db.tenantId,
        documentId,
        versionId,
        actorId: c.userId ?? null,
        actorType: c.actorType,
        action,
        supportGrantId: c.supportGrantId ?? null,
        ip: c.ip ?? null,
        userAgent: c.userAgent?.slice(0, 300) ?? null,
      },
    });
    // Document content reached by TypEase support is additionally visible in the centre's audit trail.
    if (c.supportGrantId && ['VIEW', 'DOWNLOAD_LINK', 'PREVIEW_LINK'].includes(action)) {
      await this.audit.log({ action: 'document.accessed_by_support', resourceType: 'Document', resourceId: documentId, summary: action }, tx);
    }
  }

  private async currentVersions(tx: Tx, docs: Document[]): Promise<Map<string, DocumentVersion>> {
    const ids = docs.map((d) => d.currentVersionId).filter((v): v is string => !!v);
    if (!ids.length) return new Map();
    const versions = await tx.documentVersion.findMany({ where: { tenantId: this.db.tenantId, id: { in: ids } } });
    return new Map(versions.map((v) => [v.id, v]));
  }

  private checkFileRules(mime: string, sizeBytes: number) {
    const allowed = allowedUploadMime();
    if (!allowed.includes(mime)) {
      throw Errors.unprocessable('FILE_TYPE_NOT_ALLOWED', `This file type cannot be uploaded. Allowed types: ${allowed.join(', ')}.`, { allowed });
    }
    const max = env().UPLOAD_MAX_BYTES;
    if (sizeBytes > max) throw new AppError(413, 'FILE_TOO_LARGE', `The file is too large. The limit is ${Math.floor(max / MB)} MB.`, { maxBytes: max });
  }

  // ------------------------------------------------------------------ upload: step 1
  /**
   * Creates the document (or a new version of an existing one) in a pending
   * state and returns a one-time URL the client PUTs the bytes to.
   */
  /** `restricted:` categories mark module-owned files and change who may read a document: clients can never set them. */
  private assertCategoryAllowed(category: string | null | undefined): void {
    if (category && category.trim().toLowerCase().startsWith(RESTRICTED_PREFIX)) {
      throw Errors.unprocessable('CATEGORY_RESERVED', `Categories starting with "${RESTRICTED_PREFIX}" are reserved for files the system generates. Choose another category.`);
    }
  }

  async createIntent(input: DocumentUploadIntentInput) {
    this.assertCategoryAllowed(input.category);
    const mime = normaliseMime(input.mime);
    this.checkFileRules(mime, input.sizeBytes);
    const tenantId = this.db.tenantId;
    const c = ctx();
    const staff = this.access.isStaff();

    const created = await this.db.tx(async (tx) => {
      await this.usage.assertWithinLimit('storageMb', tx, input.sizeBytes / MB);

      let doc: Document;
      let versionNo = 1;
      let owner: ResolvedOwner;
      if (input.replacesDocumentId) {
        // A new version keeps the owner of the existing document; only the request / checklist line it
        // answers may be named (and is checked like any other reference).
        doc = await this.access.findWritable(tx, input.replacesDocumentId);
        if (doc.status === 'DELETED') throw Errors.conflict('DOCUMENT_DELETED', 'This document was deleted. Upload it as a new document instead.');
        owner =
          input.requestId || input.checklistItemId
            ? await this.access.resolveOwner(tx, { requestId: input.requestId, checklistItemId: input.checklistItemId })
            : { customerId: doc.customerId, corporateAccountId: doc.corporateAccountId, requestId: doc.requestId, checklistItemId: null, checklistItem: null };
        const last = await tx.documentVersion.findFirst({ where: { tenantId, documentId: doc.id }, orderBy: { versionNo: 'desc' } });
        versionNo = (last?.versionNo ?? 0) + 1;
      } else {
        owner = await this.access.resolveOwner(tx, input);
        const type = await tx.documentType.findFirst({ where: { key: input.documentTypeKey, isActive: true, OR: [{ tenantId }, { tenantId: null }] }, orderBy: { tenantId: 'asc' } });
        if (!type) throw Errors.unprocessable('UNKNOWN_DOCUMENT_TYPE', 'That document type does not exist. Choose one from the list.');
        doc = await tx.document.create({
          data: {
            tenantId,
            customerId: owner.customerId,
            corporateAccountId: owner.corporateAccountId,
            requestId: owner.requestId,
            documentTypeKey: type.key,
            category: input.category ?? null,
            title: input.title ?? owner.checklistItem?.label ?? type.name,
            status: 'PENDING_UPLOAD',
            issuedDate: dayToDate(input.issuedDate) ?? null,
            expiryDate: dayToDate(input.expiryDate) ?? null,
            expiryVerified: false,
            customerVisible: staff ? (input.customerVisible ?? true) : true,
            // A file the centre uploads against a COMPLETION checklist line is the completed document
            // of that request - the same flag platform-generated files carry (see storeGenerated).
            isCompletionDocument: staff && owner.checklistItem?.kind === 'COMPLETION',
            uploadedById: c.userId ?? null,
            uploadedByType: c.actorType,
          },
        });
      }
      const key = this.storage.newKey(tenantId);
      const version = await tx.documentVersion.create({
        data: {
          tenantId,
          documentId: doc.id,
          versionNo,
          storageKey: key,
          originalFilename: safeFilename(input.filename),
          declaredMime: mime,
          sizeBytes: BigInt(input.sizeBytes),
          encryption: this.storage.encryption,
          // No dedicated column exists for intent data; it rides along with the version's metadata.
          encryptionMeta: { driver: this.storage.driverName, intent: { checklistItemId: owner.checklistItemId, requestId: owner.requestId } },
          uploadStatus: UPLOAD.PENDING,
          uploadExpiresAt: new Date(Date.now() + env().UPLOAD_URL_TTL_SECONDS * 1000),
          uploadedById: c.userId ?? null,
        },
      });
      await this.logAccess(tx, doc.id, version.id, 'UPLOAD_INTENT');
      return { doc, version, key };
    });

    const upload = await this.storage.presignUpload(created.key, mime, input.sizeBytes);
    return { documentId: created.doc.id, versionId: created.version.id, upload: { url: upload.url, method: upload.method, headers: upload.headers, expiresAt: upload.expiresAt } };
  }

  // ------------------------------------------------------------------ upload: step 3
  /**
   * Confirms an upload: the stored bytes are inspected (real type by magic
   * bytes, size, SHA-256) before the file is accepted and queued for the
   * malware scan. Safe to call twice.
   */
  async completeUpload(documentId: string, versionId: string) {
    const tenantId = this.db.tenantId;
    const { doc, version } = await this.db.tx(async (tx) => {
      const d = await this.access.findWritable(tx, documentId);
      const v = found(await tx.documentVersion.findFirst({ where: { id: versionId, documentId: d.id, tenantId } }), 'Upload');
      return { doc: d, version: v };
    });
    if (version.uploadStatus === UPLOAD.COMPLETED) return this.uploadSummary(documentId, versionId);
    if (version.uploadStatus !== UPLOAD.PENDING) {
      throw Errors.conflict('UPLOAD_REJECTED', 'This upload was not accepted or has expired. Please upload the file again.');
    }

    // Move the bytes out of the staging area first: from here on no upload URL can change them.
    const info = await this.storage.promote(version.storageKey);
    if (!info) throw Errors.conflict('UPLOAD_NOT_FOUND', 'The file has not arrived yet. Upload it to the link you were given, then try again.');
    if (info.sizeBytes > env().UPLOAD_MAX_BYTES) {
      await this.rejectUpload(doc, version, 'too large');
      throw new AppError(413, 'FILE_TOO_LARGE', `The file is too large. The limit is ${Math.floor(env().UPLOAD_MAX_BYTES / MB)} MB.`);
    }
    const content = await this.storage.getBuffer(version.storageKey);
    const detected = detectMime(content.subarray(0, 4100));
    const allowed = allowedUploadMime();
    if (!detected || !allowed.includes(detected) || detected !== version.declaredMime) {
      await this.rejectUpload(doc, version, `declared ${version.declaredMime}, content is ${detected ?? 'unrecognised'}`);
      await this.audit.security('UPLOAD_CONTENT_MISMATCH', 'MEDIUM', { documentId: doc.id, versionId: version.id, declared: version.declaredMime, detected });
      if (!detected || !allowed.includes(detected)) {
        throw Errors.unprocessable('FILE_TYPE_NOT_ALLOWED', `The content of this file is not an allowed type (${allowed.join(', ')}). It was not saved.`);
      }
      throw Errors.unprocessable('FILE_TYPE_MISMATCH', `This file is really "${detected}" but was sent as "${version.declaredMime}". It was not saved. Please upload it again with the right type.`);
    }

    const size = content.length;
    const digest = sha256(content);
    await this.db.tx(async (tx) => {
      // Guarded update: of two concurrent completions exactly one records usage and emits the event.
      const claimed = await tx.documentVersion.updateMany({
        where: { id: version.id, tenantId, uploadStatus: UPLOAD.PENDING },
        data: { uploadStatus: UPLOAD.COMPLETED, detectedMime: detected, sizeBytes: BigInt(size), sha256: digest, scanStatus: 'PENDING', uploadExpiresAt: null },
      });
      if (!claimed.count) return;
      const current = found(await tx.document.findFirst({ where: { id: doc.id, tenantId } }), 'Document');
      // A replacement for a document that is in use becomes current only after it passes the scan
      // (see DocumentScanService); until then the previous version stays downloadable.
      const replacesLiveVersion = current.status === 'AVAILABLE' && !!current.currentVersionId && current.currentVersionId !== version.id;
      // A document deleted while its upload was in flight stays deleted (the purge job removes the file).
      if (!replacesLiveVersion && current.status !== 'DELETED') {
        await tx.document.update({ where: { id: doc.id }, data: { currentVersionId: version.id, status: 'PENDING_SCAN' } });
      }
      await this.usage.record('storageBytes', size, tx, true);
      await this.logAccess(tx, doc.id, version.id, 'UPLOAD');
      await this.audit.log(
        {
          action: version.versionNo > 1 ? 'document.version_uploaded' : 'document.uploaded',
          resourceType: 'Document',
          resourceId: doc.id,
          after: { versionId: version.id, versionNo: version.versionNo, mime: detected, sizeBytes: size, sha256: digest, documentTypeKey: doc.documentTypeKey },
        },
        tx,
      );
      const intent = ((version.encryptionMeta as any)?.intent ?? {}) as { checklistItemId?: string | null; requestId?: string | null };
      await this.events.emit(tx, 'document.uploaded', {
        documentId: doc.id,
        versionId: version.id,
        customerId: doc.customerId,
        corporateAccountId: doc.corporateAccountId,
        requestId: intent.requestId ?? doc.requestId,
        checklistItemId: intent.checklistItemId ?? null,
        documentTypeKey: doc.documentTypeKey,
        uploadedByType: ctx().actorType,
      });
      this.db.afterCommit(() => this.jobs.enqueue('documents.scan', { tenantId, versionId: version.id }, { jobId: `documents.scan:${version.id}` }));
    });
    return this.uploadSummary(documentId, versionId);
  }

  private async rejectUpload(doc: Document, version: DocumentVersion, reason: string) {
    await this.storage.discard(version.storageKey);
    await this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const changed = await tx.documentVersion.updateMany({
        where: { id: version.id, tenantId, uploadStatus: UPLOAD.PENDING },
        data: { uploadStatus: UPLOAD.FAILED, scanDetail: `Rejected: ${reason}`.slice(0, 300), uploadExpiresAt: null },
      });
      if (!changed.count) return;
      // A document that never had a usable file is not kept.
      if (doc.status === 'PENDING_UPLOAD' && !doc.currentVersionId) {
        await tx.document.update({ where: { id: doc.id }, data: { status: 'DELETED', deletedAt: new Date(), purgeAfter: new Date() } });
      }
      await this.audit.log({ action: 'document.upload_rejected', resourceType: 'Document', resourceId: doc.id, summary: reason, after: { versionId: version.id } }, tx);
    });
  }

  /** What the uploader gets back. Deliberately small: uploading does not require permission to read documents. */
  private async uploadSummary(documentId: string, versionId: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const doc = found(await tx.document.findFirst({ where: { id: documentId, tenantId } }), 'Document');
      const version = found(await tx.documentVersion.findFirst({ where: { id: versionId, documentId, tenantId } }), 'Upload');
      return {
        documentId: doc.id,
        versionId: version.id,
        versionNo: version.versionNo,
        status: doc.status,
        isCurrentVersion: doc.currentVersionId === version.id,
        filename: version.originalFilename,
        mime: version.detectedMime ?? version.declaredMime,
        sizeBytes: Number(version.sizeBytes),
        scanStatus: version.scanStatus,
      };
    });
  }

  /** Convenience path for simple clients (mobile camera): one multipart request instead of three calls. */
  async uploadMultipart(fields: Omit<DocumentUploadIntentInput, 'filename' | 'mime' | 'sizeBytes'>, file: { originalname: string; mimetype: string; size: number; buffer: Buffer } | undefined) {
    if (!file?.buffer?.length) throw Errors.badRequest('FILE_REQUIRED', 'Attach the file in the "file" field.');
    // Camera and share-sheet clients often send a generic type: use what the bytes say, then validate as usual.
    const declared = normaliseMime(file.mimetype || '');
    const mime = declared && declared !== 'application/octet-stream' ? declared : (detectMime(file.buffer.subarray(0, 4100)) ?? declared);
    const intent = await this.createIntent({ ...fields, filename: file.originalname || 'upload', mime, sizeBytes: file.size });
    const version = await this.db.tx((tx) => tx.documentVersion.findFirstOrThrow({ where: { id: intent.versionId, tenantId: this.db.tenantId } }));
    await this.storage.putStaged(version.storageKey, file.buffer, mime);
    return this.completeUpload(intent.documentId, intent.versionId);
  }

  // ------------------------------------------------------------------ read side
  async list(query: DocumentListQuery) {
    const staff = this.access.isStaff();
    return this.db.tx(async (tx) => {
      const and: Prisma.DocumentWhereInput[] = [await this.access.readFilter(tx)];
      if (query.customerId) and.push({ customerId: query.customerId });
      if (query.requestId) and.push({ requestId: query.requestId });
      if (query.corporateAccountId) and.push({ corporateAccountId: query.corporateAccountId });
      if (query.type) and.push({ documentTypeKey: query.type });
      if (query.category) and.push({ category: query.category });
      if (query.verificationStatus) and.push({ verificationStatus: query.verificationStatus });
      if (query.expiringBefore) and.push({ expiryDate: { lte: dayToDate(query.expiringBefore)! } });
      if (query.status) and.push({ status: query.status });
      const showDeleted = staff && (query.includeDeleted || query.status === 'DELETED');
      if (!showDeleted) and.push({ status: { not: 'DELETED' } });
      // Abandoned upload intents are not documents yet.
      if (!query.status) and.push({ status: { not: 'PENDING_UPLOAD' } });
      if (query.q) and.push({ OR: [{ title: { contains: query.q, mode: 'insensitive' } }, { documentVersions: { some: { originalFilename: { contains: query.q, mode: 'insensitive' } } } }] });
      const where: Prisma.DocumentWhereInput = { AND: and };
      const [rows, total] = await Promise.all([tx.document.findMany({ where, ...pageArgs(query, SORTABLE, 'createdAt:desc') }), tx.document.count({ where })]);
      const versions = await this.currentVersions(tx, rows);
      const owners = await this.ownerLabels(tx, rows);
      return pageResult(rows.map((d) => ({ ...presentDocument(d, d.currentVersionId ? versions.get(d.currentVersionId) : null, staff), ...owners(d) })), total, query);
    });
  }

  /**
   * Whose document it is and which request it belongs to, in words: `customerName`, `customerErased` and
   * `requestNo`. Only for documents the caller may already read, so nothing is revealed that the row did not
   * already imply; a company's portal uses it to show "passport of <employee>, request TE-000123".
   */
  private async ownerLabels(tx: Tx, docs: Array<Pick<Document, 'customerId' | 'requestId'>>) {
    const tenantId = this.db.tenantId;
    const customerIds = [...new Set(docs.map((d) => d.customerId).filter((v): v is string => !!v))];
    const requestIds = [...new Set(docs.map((d) => d.requestId).filter((v): v is string => !!v))];
    const [customers, requests] = await Promise.all([
      customerIds.length ? tx.customer.findMany({ where: { tenantId, id: { in: customerIds } }, select: { id: true, fullName: true, status: true } }) : [],
      requestIds.length ? tx.serviceRequest.findMany({ where: { tenantId, id: { in: requestIds } }, select: { id: true, requestNo: true } }) : [],
    ]);
    const customer = new Map(customers.map((c) => [c.id, c]));
    const request = new Map(requests.map((r) => [r.id, r.requestNo]));
    return (d: Pick<Document, 'customerId' | 'requestId'>) => ({
      customerName: d.customerId ? (customer.get(d.customerId)?.fullName ?? null) : null,
      customerErased: d.customerId ? isErasedCustomer(customer.get(d.customerId)) : false,
      requestNo: d.requestId ? (request.get(d.requestId) ?? null) : null,
    });
  }

  async get(id: string) {
    const staff = this.access.isStaff();
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const doc = await this.access.findReadable(tx, id);
      const versions = await tx.documentVersion.findMany({
        where: { tenantId, documentId: doc.id, ...(staff ? {} : { uploadStatus: UPLOAD.COMPLETED }) },
        orderBy: { versionNo: 'desc' },
      });
      const checklist = await tx.requestDocument.findMany({ where: { tenantId, documentId: doc.id }, select: { id: true, requestId: true, documentTypeKey: true, label: true, status: true, kind: true } });
      const verifications = staff ? await tx.documentVerificationResult.findMany({ where: { tenantId, documentId: doc.id }, orderBy: { createdAt: 'desc' }, take: 20 }) : [];
      await this.logAccess(tx, doc.id, doc.currentVersionId, 'VIEW');
      return {
        ...presentDocument(doc, versions.find((v) => v.id === doc.currentVersionId), staff),
        ...(await this.ownerLabels(tx, [doc]))(doc),
        versions: versions.map((v) => ({ ...presentVersion(v, staff), isCurrent: v.id === doc.currentVersionId })),
        checklist,
        ...(staff ? { verifications } : {}),
      };
    });
  }

  /** Short-lived link to the bytes. `inline` (preview) is honoured for PDFs and images only. */
  async downloadLink(id: string, input: DocumentDownloadLinkInput) {
    const staff = this.access.isStaff();
    const picked = await this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const doc = await this.access.findReadable(tx, id);
      if (input.versionId && !staff && input.versionId !== doc.currentVersionId) throw Errors.notFound('Document version');
      const versionId = input.versionId ?? doc.currentVersionId;
      const version = versionId ? await tx.documentVersion.findFirst({ where: { id: versionId, documentId: doc.id, tenantId } }) : null;
      if (input.versionId && !version) throw Errors.notFound('Document version');
      if (!documentDownloadable(doc, version) || !version) throw notAvailable(doc, version);
      const mime = version.detectedMime ?? version.declaredMime;
      const disposition = input.disposition === 'inline' && INLINE_MIME.includes(mime) ? ('inline' as const) : ('attachment' as const);
      await this.logAccess(tx, doc.id, version.id, disposition === 'inline' ? 'PREVIEW_LINK' : 'DOWNLOAD_LINK');
      return { version, mime, disposition };
    });
    const link = await this.storage.presignDownload(picked.version.storageKey, { filename: picked.version.originalFilename, contentType: picked.mime, disposition: picked.disposition });
    return { url: link.url, expiresAt: link.expiresAt, filename: picked.version.originalFilename, mime: picked.mime, sizeBytes: Number(picked.version.sizeBytes), disposition: picked.disposition };
  }

  async accessLogs(id: string, query: { page?: number; pageSize?: number }) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const doc = found(await tx.document.findFirst({ where: { id, tenantId } }), 'Document');
      const where = { tenantId, documentId: doc.id };
      const [rows, total] = await Promise.all([tx.documentAccessLog.findMany({ where, ...pageArgs(query, ['createdAt'] as const, 'createdAt:desc') }), tx.documentAccessLog.count({ where })]);
      return pageResult(rows, total, query);
    });
  }

  // ------------------------------------------------------------------ metadata
  async update(id: string, input: DocumentUpdateInput) {
    this.assertCategoryAllowed(input.category);
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const before = await this.access.findReadable(tx, id);
      if (before.status === 'DELETED') throw Errors.conflict('DOCUMENT_DELETED', 'This document was deleted. Restore it before editing.');
      if (before.requestId) await this.access.assertRequestInScope(tx, before.requestId);
      const data: Prisma.DocumentUpdateInput = {};
      if (input.title !== undefined) data.title = input.title;
      if (input.category !== undefined) data.category = input.category ?? null;
      if (input.customerVisible !== undefined) data.customerVisible = input.customerVisible;
      if (input.documentTypeKey !== undefined && input.documentTypeKey !== before.documentTypeKey) {
        const type = await tx.documentType.findFirst({ where: { key: input.documentTypeKey, isActive: true, OR: [{ tenantId }, { tenantId: null }] } });
        if (!type) throw Errors.unprocessable('UNKNOWN_DOCUMENT_TYPE', 'That document type does not exist. Choose one from the list.');
        data.documentTypeKey = type.key;
      }
      if (input.issuedDate !== undefined) data.issuedDate = dayToDate(input.issuedDate);
      if (input.expiryDate !== undefined && input.expiryDate !== isoDay(before.expiryDate)) {
        data.expiryDate = dayToDate(input.expiryDate);
        // A date typed here is not a verification: only the verify action (or a reviewed extraction) confirms it.
        data.expiryVerified = false;
      }
      const after = await tx.document.update({ where: { id: before.id }, data });
      // Expiry reminders follow the date on the document (the reminders module listens).
      if (data.expiryDate !== undefined) await this.emitExpiryChanged(tx, after, before.expiryDate, 'MANUAL');
      await this.logAccess(tx, before.id, before.currentVersionId, 'UPDATE');
      await this.audit.log(
        {
          action: 'document.updated',
          resourceType: 'Document',
          resourceId: before.id,
          before: { title: before.title, category: before.category, documentTypeKey: before.documentTypeKey, expiryDate: isoDay(before.expiryDate), issuedDate: isoDay(before.issuedDate), customerVisible: before.customerVisible },
          after: input,
        },
        tx,
      );
      const version = after.currentVersionId ? await tx.documentVersion.findFirst({ where: { id: after.currentVersionId, tenantId } }) : null;
      return presentDocument(after, version, true);
    });
  }

  /**
   * `document.expiry_changed`: the one event for an expiry date set or changed outside the verify
   * action (typed by staff, or applied from a reviewed extraction). `expiryVerified` says whether a
   * person confirmed the date against the document.
   */
  async emitExpiryChanged(
    tx: Tx,
    doc: { id: string; customerId: string | null; corporateAccountId: string | null; requestId: string | null; documentTypeKey: string; expiryDate: Date | null; expiryVerified: boolean },
    previous: Date | null,
    source: 'MANUAL' | 'OCR',
  ): Promise<void> {
    await this.events.emit(tx, 'document.expiry_changed', {
      documentId: doc.id,
      customerId: doc.customerId,
      corporateAccountId: doc.corporateAccountId,
      requestId: doc.requestId,
      documentTypeKey: doc.documentTypeKey,
      expiryDate: isoDay(doc.expiryDate),
      previousExpiryDate: isoDay(previous),
      expiryVerified: doc.expiryVerified,
      source,
    });
  }

  // ------------------------------------------------------------------ verification
  async verify(id: string, input: DocumentVerifyInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const c = ctx();
      const doc = await this.access.findReadable(tx, id);
      const version = doc.currentVersionId ? await tx.documentVersion.findFirst({ where: { id: doc.currentVersionId, tenantId } }) : null;
      // A reviewer can only vouch for a file they are able to open.
      if (!documentDownloadable(doc, version)) throw notAvailable(doc, version);
      if (doc.requestId) await this.access.assertRequestInScope(tx, doc.requestId);

      const approved = input.decision === 'APPROVED';
      const expiryConfirmed = approved && !!input.expiryDate;
      const data: Prisma.DocumentUpdateInput = {
        verificationStatus: approved ? 'VERIFIED' : 'REJECTED',
        verifiedById: c.userId ?? null,
        verifiedAt: new Date(),
      };
      if (approved && input.expiryDate !== undefined) {
        data.expiryDate = dayToDate(input.expiryDate);
        data.expiryVerified = !!input.expiryDate;
      }
      if (approved && input.issuedDate !== undefined) data.issuedDate = dayToDate(input.issuedDate);
      const after = await tx.document.update({ where: { id: doc.id }, data });
      const result = await tx.documentVerificationResult.create({
        data: {
          tenantId,
          documentId: doc.id,
          versionId: doc.currentVersionId,
          reviewerId: found(c.userId, 'Reviewer'),
          decision: input.decision,
          reason: input.reason ?? null,
          fieldsConfirmed: approved ? { expiryDate: input.expiryDate ?? null, issuedDate: input.issuedDate ?? null, expiryConfirmed } : {},
        },
      });
      await this.logAccess(tx, doc.id, doc.currentVersionId, 'VERIFY');
      await this.audit.log(
        {
          action: approved ? 'document.verified' : 'document.rejected',
          resourceType: 'Document',
          resourceId: doc.id,
          summary: input.reason ?? undefined,
          before: { verificationStatus: doc.verificationStatus, expiryDate: isoDay(doc.expiryDate), expiryVerified: doc.expiryVerified },
          after: { decision: input.decision, verificationStatus: after.verificationStatus, expiryDate: isoDay(after.expiryDate), expiryVerified: after.expiryVerified },
        },
        tx,
      );
      const base = { documentId: doc.id, customerId: doc.customerId, requestId: doc.requestId, documentTypeKey: doc.documentTypeKey };
      if (approved) await this.events.emit(tx, 'document.verified', { ...base, expiryDate: isoDay(after.expiryDate), expiryVerified: after.expiryVerified });
      else await this.events.emit(tx, 'document.rejected', { ...base, reason: input.reason ?? '', decision: input.decision });
      return { ...presentDocument(after, version, true), verification: result };
    });
  }

  // ------------------------------------------------------------------ deletion
  /** Why a document may not be deleted right now, or null. */
  async deletionBlocker(tx: Tx, doc: Document): Promise<{ code: string; message: string } | null> {
    const tenantId = this.db.tenantId;
    if (doc.legalHold) return { code: 'LEGAL_HOLD', message: 'This document is under legal hold and cannot be deleted.' };
    if (doc.retentionUntil && doc.retentionUntil > new Date()) {
      return { code: 'RETENTION_ACTIVE', message: `This document must be kept until ${isoDay(doc.retentionUntil)}.` };
    }
    const openOwn = doc.requestId ? await tx.serviceRequest.count({ where: { id: doc.requestId, tenantId, ...OPEN_REQUEST } }) : 0;
    const openLinked = await tx.requestDocument.count({ where: { tenantId, documentId: doc.id, request: OPEN_REQUEST } });
    if (openOwn || openLinked) return { code: 'DOCUMENT_IN_USE', message: 'This document belongs to a request that is still open. Close the request or replace the document instead.' };
    return null;
  }

  /** Marks a document deleted (files stay until `purgeAfter`) and revokes its share links. No permission checks. */
  async softDeleteInternal(tx: Tx, doc: Document, opts: { purgeAfter: Date; action: string; summary?: string }): Promise<void> {
    const tenantId = this.db.tenantId;
    await tx.document.update({ where: { id: doc.id }, data: { status: 'DELETED', deletedAt: new Date(), deletedById: ctx().userId ?? null, purgeAfter: opts.purgeAfter } });
    await tx.documentShare.updateMany({ where: { tenantId, documentId: doc.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.logAccess(tx, doc.id, doc.currentVersionId, 'DELETE');
    await this.audit.log({ action: opts.action, resourceType: 'Document', resourceId: doc.id, summary: opts.summary, before: { status: doc.status }, after: { status: 'DELETED', purgeAfter: opts.purgeAfter } }, tx);
  }

  async remove(id: string) {
    return this.db.tx(async (tx) => {
      const doc = await this.access.findReadable(tx, id);
      if (doc.status === 'DELETED') return { id: doc.id, status: 'DELETED' as const, purgeAfter: doc.purgeAfter };
      if (doc.requestId) await this.access.assertRequestInScope(tx, doc.requestId);
      const blocker = await this.deletionBlocker(tx, doc);
      if (blocker) throw Errors.conflict(blocker.code, blocker.message);
      // A document that an erasure had to keep (legal hold, retention date, somebody else's open request) and that
      // staff now delete by hand is erased, not just deleted: no restore window, title and file name blanked at once.
      if (await this.ownerErased(tx, doc)) {
        const now = new Date();
        await this.softDeleteInternal(tx, doc, { purgeAfter: now, action: 'document.erased', summary: 'The owner was erased; deleted by staff without a restore window.' });
        await this.scrubErased(tx, [doc.id]);
        return { id: doc.id, status: 'DELETED' as const, purgeAfter: now };
      }
      const purgeAfter = new Date(Date.now() + PURGE_GRACE_DAYS * 86400_000);
      await this.softDeleteInternal(tx, doc, { purgeAfter, action: 'document.deleted' });
      return { id: doc.id, status: 'DELETED' as const, purgeAfter };
    });
  }

  /** Does this document belong to a person whose data was erased (directly, through a merged record, or through their request)? */
  async ownerErased(tx: Tx, doc: Pick<Document, 'id'>): Promise<boolean> {
    const erased = { status: ERASED_CUSTOMER_STATUS };
    return !!(await tx.document.findFirst({
      where: { id: doc.id, tenantId: this.db.tenantId, OR: [{ customer: erased }, { customer: { status: 'MERGED', mergedInto: erased } }, { customerId: null, request: { customer: erased } }] },
      select: { id: true },
    }));
  }
  /** What an erasure removes from a deleted document besides its files: the title, the file names (they often carry the person's name) and review notes. */
  async scrubErased(tx: Tx, documentIds: string[]): Promise<void> {
    if (!documentIds.length) return;
    const tenantId = this.db.tenantId;
    await tx.document.updateMany({ where: { tenantId, id: { in: documentIds } }, data: { title: ERASED_DOCUMENT_TITLE, category: null } });
    await tx.documentVersion.updateMany({ where: { tenantId, documentId: { in: documentIds }, originalFilename: { not: 'purged' } }, data: { originalFilename: 'erased' } });
    await tx.documentShare.updateMany({ where: { tenantId, documentId: { in: documentIds } }, data: { recipient: null } });
    await tx.documentVerificationResult.updateMany({ where: { tenantId, documentId: { in: documentIds } }, data: { reason: null, fieldsConfirmed: {} } });
  }

  /** Undo a deletion while the files still exist. */
  async restore(id: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const doc = await this.access.findReadable(tx, id);
      if (doc.status !== 'DELETED') throw Errors.conflict('NOT_DELETED', 'This document is not deleted.');
      const version = doc.currentVersionId ? await tx.documentVersion.findFirst({ where: { id: doc.currentVersionId, tenantId } }) : null;
      if (!version || version.uploadStatus !== UPLOAD.COMPLETED) {
        throw Errors.conflict('DOCUMENT_PURGED', 'The files of this document have already been removed and cannot be restored.');
      }
      // Erased is final: there is no way back, even in the minutes before the files are physically removed.
      if (await this.ownerErased(tx, doc)) throw Errors.conflict('DOCUMENT_ERASED', 'This document belonged to a customer whose data was erased. It cannot be restored.');
      const status = version.scanStatus === 'PENDING' || version.scanStatus === 'ERROR' ? 'PENDING_SCAN' : 'AVAILABLE';
      const after = await tx.document.update({ where: { id: doc.id }, data: { status, deletedAt: null, deletedById: null, purgeAfter: null } });
      await this.logAccess(tx, doc.id, version.id, 'RESTORE');
      await this.audit.log({ action: 'document.restored', resourceType: 'Document', resourceId: doc.id, after: { status } }, tx);
      return presentDocument(after, version, true);
    });
  }

  async setLegalHold(id: string, input: { legalHold: boolean; reason: string }) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const doc = found(await tx.document.findFirst({ where: { id, tenantId } }), 'Document');
      const after = await tx.document.update({ where: { id: doc.id }, data: { legalHold: input.legalHold } });
      await this.logAccess(tx, doc.id, doc.currentVersionId, 'LEGAL_HOLD');
      await this.audit.log(
        { action: input.legalHold ? 'document.legal_hold_set' : 'document.legal_hold_released', resourceType: 'Document', resourceId: doc.id, summary: input.reason, before: { legalHold: doc.legalHold }, after: { legalHold: input.legalHold } },
        tx,
      );
      const version = after.currentVersionId ? await tx.documentVersion.findFirst({ where: { id: after.currentVersionId, tenantId } }) : null;
      return presentDocument(after, version, true);
    });
  }

  // ------------------------------------------------------------------ used by sibling modules (ocr, privacy) and the port
  /**
   * Bytes of a document's current version for internal processing (OCR).
   * The caller has already authorised the actor; the read is still logged.
   */
  async readForProcessing(documentId: string, versionId: string, action: AccessAction): Promise<{ document: Document; version: DocumentVersion; content: Buffer } | null> {
    const loaded = await this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const document = await tx.document.findFirst({ where: { id: documentId, tenantId } });
      const version = document ? await tx.documentVersion.findFirst({ where: { id: versionId, documentId, tenantId } }) : null;
      if (!document || !version || document.status !== 'AVAILABLE' || !versionDownloadable(version)) return null;
      await this.logAccess(tx, document.id, version.id, action);
      return { document, version };
    });
    if (!loaded) return null;
    try {
      return { ...loaded, content: await this.storage.getBuffer(loaded.version.storageKey) };
    } catch (e) {
      if (e instanceof StorageObjectNotFound) return null;
      throw e;
    }
  }

  /**
   * Stores a file produced by the platform itself (PDF invoice, data export).
   * Runs inside the caller's tenant transaction. Such files are trusted: they
   * skip the type allow-list and the malware scan and are available at once.
   */
  async storeGenerated(input: GeneratedDocumentInput): Promise<{ documentId: string; versionId: string }> {
    if (!input.content?.length) throw new Error('storeGenerated: empty content.');
    if (input.restrictedTo !== undefined && !/^[a-z][a-z0-9-]{1,39}$/.test(input.restrictedTo)) throw new Error('storeGenerated: restrictedTo must be a short module key.');
    if (input.restrictedTo && (input.customerId || input.corporateAccountId || input.requestId)) throw new Error('storeGenerated: a restricted file cannot belong to a customer, a company or a request.');
    const tenantId = this.db.tenantId;
    const c = ctx();
    return this.db.tx(async (tx) => {
      if (input.customerId) found(await tx.customer.findFirst({ where: { id: input.customerId, tenantId } }), 'Customer');
      if (input.corporateAccountId) found(await tx.corporateAccount.findFirst({ where: { id: input.corporateAccountId, tenantId } }), 'Corporate account');
      if (input.requestId) found(await tx.serviceRequest.findFirst({ where: { id: input.requestId, tenantId } }), 'Request');
      const key = this.storage.newKey(tenantId);
      const doc = await tx.document.create({
        data: {
          tenantId,
          customerId: input.customerId ?? null,
          corporateAccountId: input.corporateAccountId ?? null,
          requestId: input.requestId ?? null,
          documentTypeKey: input.documentTypeKey,
          category: input.restrictedTo ? restrictedCategory(input.restrictedTo) : null,
          title: input.title.slice(0, 200),
          status: 'AVAILABLE',
          isCompletionDocument: input.isCompletionDocument ?? false,
          // A restricted file belongs to a module of the centre: never shown to a customer.
          customerVisible: input.restrictedTo ? false : (input.customerVisible ?? true),
          uploadedById: c.userId ?? null,
          uploadedByType: c.actorType,
        },
      });
      const version = await tx.documentVersion.create({
        data: {
          tenantId,
          documentId: doc.id,
          versionNo: 1,
          storageKey: key,
          originalFilename: safeFilename(input.filename),
          declaredMime: normaliseMime(input.mime),
          detectedMime: normaliseMime(input.mime),
          sizeBytes: BigInt(input.content.length),
          sha256: sha256(input.content),
          encryption: this.storage.encryption,
          encryptionMeta: { driver: this.storage.driverName },
          uploadStatus: UPLOAD.COMPLETED,
          scanStatus: 'SKIPPED',
          scanEngine: SYSTEM_GENERATED,
          scanDetail: 'Produced by the platform; not an upload.',
          scannedAt: new Date(),
          uploadedById: c.userId ?? null,
        },
      });
      await tx.document.update({ where: { id: doc.id }, data: { currentVersionId: version.id } });
      // The object is written before the transaction commits. If the caller's transaction rolls back,
      // the unreferenced object is left behind; it is unreachable (no row points at it).
      await this.storage.put(key, input.content, normaliseMime(input.mime));
      await this.usage.record('storageBytes', input.content.length, tx, true);
      await this.logAccess(tx, doc.id, version.id, 'GENERATED');
      await this.audit.log({ action: 'document.generated', resourceType: 'Document', resourceId: doc.id, after: { documentTypeKey: doc.documentTypeKey, title: doc.title, sizeBytes: input.content.length } }, tx);
      await this.events.emit(tx, 'document.uploaded', {
        documentId: doc.id,
        versionId: version.id,
        customerId: doc.customerId,
        corporateAccountId: doc.corporateAccountId,
        requestId: doc.requestId,
        checklistItemId: null,
        documentTypeKey: doc.documentTypeKey,
        uploadedByType: c.actorType,
        generated: true,
        isCompletionDocument: doc.isCompletionDocument,
      });
      return { documentId: doc.id, versionId: version.id };
    });
  }

  /**
   * Port: download link for a module-owned file. The owning module has authorised the actor with its own
   * rule; this only proves that the document really is a restricted file of that owner, and logs the access.
   */
  async restrictedDownloadLink(documentId: string, owner: string): Promise<RestrictedDownloadLink> {
    const version = await this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const doc = found(await tx.document.findFirst({ where: { id: documentId, tenantId, category: restrictedCategory(owner) } }), 'Document');
      const current = doc.currentVersionId ? await tx.documentVersion.findFirst({ where: { id: doc.currentVersionId, documentId: doc.id, tenantId } }) : null;
      if (!documentDownloadable(doc, current) || !current) throw notAvailable(doc, current);
      await this.logAccess(tx, doc.id, current.id, 'DOWNLOAD_LINK');
      return current;
    });
    const mime = version.detectedMime ?? version.declaredMime;
    const link = await this.storage.presignDownload(version.storageKey, { filename: version.originalFilename, contentType: mime, disposition: 'attachment' });
    return { url: link.url, expiresAt: link.expiresAt, filename: version.originalFilename, mime, sizeBytes: Number(version.sizeBytes), disposition: 'attachment' };
  }

  /** Port: see DocumentStorePort.restrictGenerated. Only unowned files that the platform generated itself qualify. */
  async restrictGenerated(documentIds: string[], owner: string): Promise<number> {
    if (!documentIds.length) return 0;
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const docs = await tx.document.findMany({
        where: { tenantId, id: { in: documentIds }, category: null, customerId: null, corporateAccountId: null, requestId: null, documentVersions: { every: { scanEngine: SYSTEM_GENERATED } } },
        select: { id: true },
      });
      for (const doc of docs) {
        await tx.document.update({ where: { id: doc.id }, data: { category: restrictedCategory(owner), customerVisible: false } });
        await tx.documentShare.updateMany({ where: { tenantId, documentId: doc.id, revokedAt: null }, data: { revokedAt: new Date() } });
        await this.audit.log({ action: 'document.restricted', resourceType: 'Document', resourceId: doc.id, summary: `Access limited to the ${owner} module`, before: { category: null }, after: { category: restrictedCategory(owner) } }, tx);
      }
      return docs.length;
    });
  }
}
