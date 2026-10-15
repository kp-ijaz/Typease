import type { Document, DocumentVersion } from '@typease/database';
import { env } from '../../config/env';

/**
 * Module-owned, staff-only files (scheduled reports ...) carry `restricted:<owner>` in `category`. They are
 * outside the general access rules of the vault: see DocumentAccess.readFilter and the DocumentStorePort.
 */
export const RESTRICTED_PREFIX = 'restricted:';
export const restrictedCategory = (owner: string) => `${RESTRICTED_PREFIX}${owner}`;
export const isRestricted = (doc: { category: string | null }) => !!doc.category && doc.category.startsWith(RESTRICTED_PREFIX);

/** scanEngine value of files produced by the platform itself (invoices, exports): never uploaded, so not scanned. */
export const SYSTEM_GENERATED = 'system-generated';
/** uploadStatus values. PURGED = the stored file has been physically removed. */
export const UPLOAD = { PENDING: 'PENDING', COMPLETED: 'COMPLETED', FAILED: 'FAILED', PURGED: 'PURGED' } as const;
/** Types a browser may render inline. Everything else is always sent as an attachment. */
export const INLINE_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

export const isoDay = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);
export const dayToDate = (day: string | null | undefined): Date | null | undefined => (day === undefined ? undefined : day === null ? null : new Date(`${day}T00:00:00.000Z`));
export const normaliseMime = (mime: string) => {
  const m = mime.trim().toLowerCase().split(';')[0];
  return m === 'image/jpg' || m === 'image/pjpeg' ? 'image/jpeg' : m;
};
export const allowedUploadMime = (): string[] =>
  env()
    .UPLOAD_ALLOWED_MIME.split(',')
    .map((m) => normaliseMime(m))
    .filter(Boolean);

/**
 * May the bytes of this version be handed out?
 * Only fully uploaded files that the scanner cleared. Without a scanner the
 * result is SKIPPED, which is accepted unless REQUIRE_CLEAN_SCAN is on.
 */
export function versionDownloadable(v: Pick<DocumentVersion, 'uploadStatus' | 'scanStatus' | 'scanEngine'> | null | undefined): boolean {
  if (!v || v.uploadStatus !== UPLOAD.COMPLETED) return false;
  if (v.scanStatus === 'CLEAN') return true;
  if (v.scanStatus === 'SKIPPED') return v.scanEngine === SYSTEM_GENERATED || !env().REQUIRE_CLEAN_SCAN;
  return false;
}
export function documentDownloadable(doc: Pick<Document, 'status'>, v: Parameters<typeof versionDownloadable>[0]): boolean {
  return doc.status === 'AVAILABLE' && versionDownloadable(v);
}

/** API shape of a version. The storage key and encryption metadata are never included. */
export function presentVersion(v: DocumentVersion, staff: boolean) {
  return {
    id: v.id,
    versionNo: v.versionNo,
    filename: v.originalFilename,
    mime: v.detectedMime ?? v.declaredMime,
    sizeBytes: Number(v.sizeBytes),
    uploadStatus: v.uploadStatus,
    scanStatus: v.scanStatus,
    scannedAt: v.scannedAt,
    createdAt: v.createdAt,
    downloadable: versionDownloadable(v),
    ...(staff ? { sha256: v.sha256, scanEngine: v.scanEngine, scanDetail: v.scanDetail, uploadedById: v.uploadedById } : {}),
  };
}

export function presentDocument(d: Document, current: DocumentVersion | null | undefined, staff: boolean) {
  return {
    id: d.id,
    customerId: d.customerId,
    corporateAccountId: d.corporateAccountId,
    requestId: d.requestId,
    documentTypeKey: d.documentTypeKey,
    category: d.category,
    title: d.title,
    status: d.status,
    verificationStatus: d.verificationStatus,
    verifiedAt: d.verifiedAt,
    issuedDate: isoDay(d.issuedDate),
    expiryDate: isoDay(d.expiryDate),
    /** false = the date was typed in or suggested and nobody has checked it against the document yet. */
    expiryVerified: d.expiryVerified,
    isCompletionDocument: d.isCompletionDocument,
    uploadedByType: d.uploadedByType,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    currentVersion: current ? presentVersion(current, staff) : null,
    downloadable: documentDownloadable(d, current),
    ...(staff
      ? {
          customerVisible: d.customerVisible,
          legalHold: d.legalHold,
          retentionUntil: d.retentionUntil,
          verifiedById: d.verifiedById,
          uploadedById: d.uploadedById,
          deletedAt: d.deletedAt,
          deletedById: d.deletedById,
          purgeAfter: d.purgeAfter,
        }
      : {}),
  };
}
