import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AuditService } from '../../common/audit.service';
import { TenantDb } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { JobMeta, JobQueue } from '../../common/jobs/job-queue';
import { UsageService } from '../../common/usage.service';
import { StorageObjectNotFound } from '../storage/local.driver';
import { StorageService } from '../storage/storage.service';
import { DocumentAccess } from './access';
import { DocumentsService } from './documents.service';
import { MalwareScanService, ScanVerdict } from './malware';
import { UPLOAD } from './presenters';

/**
 * Malware scanning of uploaded versions (job `documents.scan`).
 *
 *   CLEAN / SKIPPED -> the version becomes (or stays) the document's current version, document AVAILABLE
 *   INFECTED        -> the file is deleted from storage, the version is marked INFECTED and can never be
 *                      downloaded; a document whose only file it was is QUARANTINED
 *   scanner failure -> retried with backoff; after the last attempt the version is marked ERROR and the
 *                      document stays unavailable until a rescan succeeds
 */
@Injectable()
export class DocumentScanService implements OnModuleInit {
  private readonly logger = new Logger(DocumentScanService.name);

  constructor(
    private readonly db: TenantDb,
    private readonly jobs: JobQueue,
    private readonly audit: AuditService,
    private readonly usage: UsageService,
    private readonly storage: StorageService,
    private readonly malware: MalwareScanService,
    private readonly documents: DocumentsService,
    private readonly access: DocumentAccess,
  ) {}

  onModuleInit() {
    this.jobs.register<{ tenantId: string; versionId: string }>('documents.scan', (payload, meta) => this.scanVersion(payload.versionId, meta), { attempts: 5, backoffMs: 15_000 });
  }

  /** Idempotent: a version that already has a verdict is left alone. */
  async scanVersion(versionId: string, meta: JobMeta): Promise<void> {
    const tenantId = this.db.tenantId;
    const version = await this.db.tx((tx) => tx.documentVersion.findFirst({ where: { id: versionId, tenantId } }));
    if (!version || version.uploadStatus !== UPLOAD.COMPLETED || !['PENDING', 'ERROR'].includes(version.scanStatus)) return;

    let verdict: ScanVerdict;
    try {
      verdict = await this.malware.scan(await this.storage.getBuffer(version.storageKey));
    } catch (e: any) {
      const missing = e instanceof StorageObjectNotFound;
      if (!missing && meta.attempt < meta.maxAttempts) throw e; // let the queue retry with backoff
      const detail = missing ? 'The stored file is missing.' : String(e?.message ?? e).slice(0, 300);
      await this.db.tx((tx) =>
        tx.documentVersion.updateMany({ where: { id: version.id, tenantId, scanStatus: { in: ['PENDING', 'ERROR'] } }, data: { scanStatus: 'ERROR', scanEngine: this.malware.engine, scanDetail: detail, scannedAt: new Date() } }),
      );
      await this.audit.security('MALWARE_SCAN_FAILED', 'MEDIUM', { documentId: version.documentId, versionId: version.id, detail });
      this.logger.error(`scan failed for version ${version.id}: ${detail}`);
      return;
    }

    if (verdict.status === 'INFECTED') {
      // Remove the bytes first: even if the database update fails and the job is retried, the file is gone.
      await this.storage.discard(version.storageKey);
    }
    await this.db.tx(async (tx) => {
      const claimed = await tx.documentVersion.updateMany({
        where: { id: version.id, tenantId, scanStatus: { in: ['PENDING', 'ERROR'] } },
        data: {
          scanStatus: verdict.status,
          scanEngine: verdict.engine,
          scanDetail: verdict.detail?.slice(0, 300) ?? null,
          scannedAt: new Date(),
          ...(verdict.status === 'INFECTED' ? { uploadStatus: UPLOAD.PURGED } : {}),
        },
      });
      if (!claimed.count) return;
      const doc = found(await tx.document.findFirst({ where: { id: version.documentId, tenantId } }), 'Document');
      const isCurrent = doc.currentVersionId === version.id;

      if (verdict.status === 'INFECTED') {
        await this.usage.record('storageBytes', -Number(version.sizeBytes), tx, true);
        if (isCurrent && doc.status !== 'DELETED') {
          await tx.document.update({ where: { id: doc.id }, data: { status: 'QUARANTINED' } });
          await tx.documentShare.updateMany({ where: { tenantId, documentId: doc.id, revokedAt: null }, data: { revokedAt: new Date() } });
        }
        await this.documents.logAccess(tx, doc.id, version.id, 'QUARANTINED');
        await this.audit.log(
          { action: 'document.quarantined', resourceType: 'Document', resourceId: doc.id, summary: `Malware detected (${verdict.detail ?? 'unknown'}). The file was deleted.`, after: { versionId: version.id, versionNo: version.versionNo, engine: verdict.engine, documentStatus: isCurrent ? 'QUARANTINED' : doc.status } },
          tx,
        );
        this.db.afterCommit(() => this.audit.security('MALWARE_DETECTED', 'HIGH', { documentId: doc.id, versionId: version.id, signature: verdict.detail, engine: verdict.engine, uploadedById: version.uploadedById }));
        return;
      }

      if (doc.status === 'DELETED') return;
      if (isCurrent) {
        if (doc.status === 'PENDING_SCAN') await tx.document.update({ where: { id: doc.id }, data: { status: 'AVAILABLE' } });
        return;
      }
      // A replacement version that waited for its scan: it takes over only if it is newer than the current one.
      const current = doc.currentVersionId ? await tx.documentVersion.findFirst({ where: { id: doc.currentVersionId, tenantId } }) : null;
      if (current && current.versionNo > version.versionNo) return;
      await tx.document.update({
        where: { id: doc.id },
        // New content has not been reviewed: verification starts again.
        data: { currentVersionId: version.id, status: 'AVAILABLE', verificationStatus: 'UNVERIFIED', verifiedById: null, verifiedAt: null, expiryVerified: false },
      });
      await this.audit.log({ action: 'document.version_activated', resourceType: 'Document', resourceId: doc.id, before: { currentVersionId: doc.currentVersionId }, after: { currentVersionId: version.id, versionNo: version.versionNo } }, tx);
    });
  }

  /** Staff action: queue another scan for a version whose scan failed (scanner was down). */
  async rescan(documentId: string) {
    const tenantId = this.db.tenantId;
    return this.db.tx(async (tx) => {
      const doc = await this.access.findReadable(tx, documentId);
      const versions = await tx.documentVersion.findMany({ where: { tenantId, documentId: doc.id, uploadStatus: UPLOAD.COMPLETED, scanStatus: { in: ['ERROR', 'PENDING'] } } });
      if (!versions.length) throw Errors.conflict('NOTHING_TO_SCAN', 'This document has no file waiting for a malware scan.');
      for (const v of versions) {
        // No job id: a rescan must not be swallowed as a duplicate of the original job.
        this.db.afterCommit(() => this.jobs.enqueue('documents.scan', { tenantId, versionId: v.id }));
      }
      await this.audit.log({ action: 'document.rescan_requested', resourceType: 'Document', resourceId: doc.id, after: { versions: versions.map((v) => v.id) } }, tx);
      return { documentId: doc.id, queued: versions.length };
    });
  }
}
