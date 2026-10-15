import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@typease/database';
import { AuditService } from '../../common/audit.service';
import { TenantDb } from '../../common/db/prisma.service';
import { JobQueue } from '../../common/jobs/job-queue';
import { TenantDirectory } from '../../common/tenant-directory';
import { UsageService } from '../../common/usage.service';
import { StorageService } from '../storage/storage.service';
import { DocumentsService } from './documents.service';
import { UPLOAD } from './presenters';

const OPEN_REQUEST: Prisma.ServiceRequestWhereInput = { status: { notIn: ['COMPLETED', 'CANCELLED'] }, deletedAt: null };
const BATCH = 200;
/** An unfinished upload is cleaned up this long after its URL expired. */
const STALE_UPLOAD_GRACE_MS = 3600_000;

export interface PurgeReport {
  expiredUploads: number;
  retentionDeleted: number;
  /** Documents of erased customers that had to be kept at the time of the erasure and are free now. */
  erasureDeleted: number;
  purgedDocuments: number;
  purgedFiles: number;
  bytesFreed: number;
}
const emptyReport = (): PurgeReport => ({ expiredUploads: 0, retentionDeleted: 0, erasureDeleted: 0, purgedDocuments: 0, purgedFiles: 0, bytesFreed: 0 });

/**
 * Daily housekeeping (job `documents.purge`), per tenant:
 *   1. abandoned upload intents are discarded;
 *   2. retention policies for entity DOCUMENT with action DELETE soft-delete documents
 *      whose retention period has passed (counted from the completion / cancellation of
 *      the document's request, or from the upload date when there is no request);
 *   2b. documents of erased (anonymised) customers that were kept at the time of the
 *      erasure - legal hold, a retention date, another open request - are deleted as soon
 *      as that reason is gone: an erasure is finished without anybody having to remember it;
 *   3. files of soft-deleted documents past `purgeAfter` are physically removed and the
 *      tenant's storage usage is reduced.
 * Documents under legal hold, with a later `retentionUntil`, or attached to an open
 * request are never touched. Every step can be repeated safely.
 */
@Injectable()
export class DocumentRetentionService implements OnModuleInit {
  private readonly logger = new Logger(DocumentRetentionService.name);

  constructor(
    private readonly db: TenantDb,
    private readonly jobs: JobQueue,
    private readonly tenants: TenantDirectory,
    private readonly audit: AuditService,
    private readonly usage: UsageService,
    private readonly storage: StorageService,
    private readonly documents: DocumentsService,
  ) {}

  onModuleInit() {
    this.jobs.register('documents.purge', async () => void (await this.runForAllTenants()), { attempts: 1 });
    this.jobs.schedule({ name: 'documents.purge', cron: '30 22 * * *', description: 'Apply document retention policies and remove the files of deleted documents (daily, 02:30 Gulf time).' });
  }

  async runForAllTenants(): Promise<PurgeReport> {
    const total = emptyReport();
    const outcome = await this.tenants.forEachTenant('documents.purge', async () => {
      const report = await this.purgeTenant();
      for (const key of Object.keys(total) as Array<keyof PurgeReport>) total[key] += report[key];
    });
    const swept = await this.storage.sweep();
    this.logger.log(`documents.purge: ${JSON.stringify(total)} tenants ok=${outcome.ok} failed=${outcome.failed} swept=${swept.removed}`);
    return total;
  }

  /** Runs inside one tenant's context (see TenantDirectory.forEachTenant). */
  async purgeTenant(now = new Date()): Promise<PurgeReport> {
    const report = emptyReport();
    report.expiredUploads = await this.discardStaleUploads(now);
    report.retentionDeleted = await this.applyRetentionPolicies(now);
    report.erasureDeleted = await this.finishErasures(now);
    await this.purgeDeleted(now, report);
    return report;
  }

  private async discardStaleUploads(now: Date): Promise<number> {
    const tenantId = this.db.tenantId;
    const stale = await this.db.tx((tx) =>
      tx.documentVersion.findMany({ where: { tenantId, uploadStatus: UPLOAD.PENDING, uploadExpiresAt: { lt: new Date(now.getTime() - STALE_UPLOAD_GRACE_MS) } }, take: BATCH }),
    );
    let count = 0;
    for (const version of stale) {
      await this.storage.discard(version.storageKey);
      await this.db.tx(async (tx) => {
        const changed = await tx.documentVersion.updateMany({ where: { id: version.id, tenantId, uploadStatus: UPLOAD.PENDING }, data: { uploadStatus: UPLOAD.FAILED, scanDetail: 'Upload was never completed.', uploadExpiresAt: null } });
        if (!changed.count) return;
        count += 1;
        await tx.document.updateMany({ where: { id: version.documentId, tenantId, status: 'PENDING_UPLOAD', currentVersionId: null }, data: { status: 'DELETED', deletedAt: now, purgeAfter: now } });
      });
    }
    return count;
  }

  private async applyRetentionPolicies(now: Date): Promise<number> {
    const tenantId = this.db.tenantId;
    const policies = await this.db.tx((tx) => tx.dataRetentionPolicy.findMany({ where: { tenantId, entity: 'DOCUMENT', action: 'DELETE', isActive: true } }));
    if (!policies.length) return 0;
    const specificKeys = policies.filter((p) => p.documentTypeKey).map((p) => p.documentTypeKey!);
    let deleted = 0;
    for (const policy of policies) {
      const cutoff = new Date(now.getTime() - policy.retainDays * 86400_000);
      const where: Prisma.DocumentWhereInput = {
        tenantId,
        status: { in: ['AVAILABLE', 'QUARANTINED', 'PENDING_SCAN'] },
        legalHold: false,
        // A type with its own policy is never governed by the general (type-less) policy.
        documentTypeKey: policy.documentTypeKey ? policy.documentTypeKey : { notIn: specificKeys },
        AND: [
          { OR: [{ retentionUntil: null }, { retentionUntil: { lte: now } }] },
          {
            OR: [
              { requestId: null, createdAt: { lt: cutoff } },
              { request: { OR: [{ status: 'COMPLETED', completedAt: { lt: cutoff } }, { status: 'CANCELLED', cancelledAt: { lt: cutoff } }] } },
            ],
          },
        ],
        requestDocuments: { none: { request: OPEN_REQUEST } },
      };
      for (let round = 0; round < 50; round++) {
        const batch = await this.db.tx(async (tx) => {
          const docs = await tx.document.findMany({ where, take: BATCH, orderBy: { createdAt: 'asc' } });
          for (const doc of docs) {
            await this.documents.softDeleteInternal(tx, doc, {
              purgeAfter: now,
              action: 'document.retention_expired',
              summary: `Retention policy: keep ${policy.retainDays} days${policy.documentTypeKey ? ` (${policy.documentTypeKey})` : ''}.`,
            });
          }
          return docs.length;
        }, { timeoutMs: 60_000 });
        deleted += batch;
        if (batch < BATCH) break;
      }
    }
    return deleted;
  }

  /**
   * An erasure keeps the documents it may not delete (legal hold, a fixed retention date, use by somebody
   * else's open request). Once that reason is gone they are deleted like the rest were: no restore window,
   * title and file name blanked, share links revoked.
   */
  private async finishErasures(now: Date): Promise<number> {
    const tenantId = this.db.tenantId;
    const erased = { status: 'ANONYMISED' as const };
    const where: Prisma.DocumentWhereInput = {
      tenantId,
      status: { not: 'DELETED' },
      legalHold: false,
      AND: [{ OR: [{ retentionUntil: null }, { retentionUntil: { lte: now } }] }, { OR: [{ customer: erased }, { customer: { status: 'MERGED', mergedInto: erased } }, { customerId: null, request: { customer: erased } }] }],
    };
    let deleted = 0;
    const skipped: string[] = [];
    for (let round = 0; round < 50; round++) {
      const batch = await this.db.tx(async (tx) => {
        const docs = await tx.document.findMany({ where: { ...where, id: { notIn: skipped } }, take: BATCH, orderBy: { createdAt: 'asc' } });
        let done = 0;
        for (const doc of docs) {
          // Still used by an open request of somebody else: it stays until that request is closed.
          if (await this.documents.deletionBlocker(tx, doc)) {
            skipped.push(doc.id);
            continue;
          }
          await this.documents.softDeleteInternal(tx, doc, { purgeAfter: now, action: 'document.erased', summary: 'The owner was erased; the reason for keeping this document has ended.' });
          await this.documents.scrubErased(tx, [doc.id]);
          done += 1;
        }
        return { found: docs.length, done };
      }, { timeoutMs: 60_000 });
      deleted += batch.done;
      if (batch.found < BATCH) break;
    }
    return deleted;
  }

  private async purgeDeleted(now: Date, report: PurgeReport): Promise<void> {
    const tenantId = this.db.tenantId;
    const removable = [UPLOAD.COMPLETED, UPLOAD.PENDING];
    const eligible: Prisma.DocumentWhereInput = { tenantId, status: 'DELETED', legalHold: false, purgeAfter: { lte: now } };
    const failed: string[] = [];
    for (let round = 0; round < 50; round++) {
      const docs = await this.db.tx((tx) =>
        tx.document.findMany({
          where: { ...eligible, id: { notIn: failed }, documentVersions: { some: { uploadStatus: { in: removable } } } },
          include: { documentVersions: { where: { uploadStatus: { in: removable } } } },
          take: BATCH,
          orderBy: { purgeAfter: 'asc' },
        }),
      );
      if (!docs.length) break;
      for (const doc of docs) {
        try {
          // Look again right before destroying anything: a legal hold or a restore may have arrived.
          const still = await this.db.tx((tx) => tx.document.count({ where: { ...eligible, id: doc.id } }));
          if (!still) continue;
          // Files first, then the database: a crash in between is repaired by the next run.
          for (const version of doc.documentVersions) await this.storage.discard(version.storageKey);
          await this.db.tx(async (tx) => {
            let files = 0;
            for (const version of doc.documentVersions) {
              const changed = await tx.documentVersion.updateMany({
                where: { id: version.id, tenantId, uploadStatus: version.uploadStatus },
                data: { uploadStatus: UPLOAD.PURGED, originalFilename: 'purged', sha256: null, uploadExpiresAt: null },
              });
              if (!changed.count) continue;
              files += 1;
              // Only completed uploads were ever counted towards the tenant's storage.
              if (version.uploadStatus === UPLOAD.COMPLETED) {
                await this.usage.record('storageBytes', -Number(version.sizeBytes), tx, true);
                report.bytesFreed += Number(version.sizeBytes);
              }
            }
            if (!files) return;
            // Extracted personal data goes with the file it was read from.
            await tx.ocrExtractionResult.deleteMany({ where: { tenantId, documentId: doc.id } });
            await this.documents.logAccess(tx, doc.id, null, 'PURGED');
            await this.audit.log({ action: 'document.purged', resourceType: 'Document', resourceId: doc.id, summary: `${files} file(s) removed from storage.` }, tx);
            report.purgedFiles += files;
            report.purgedDocuments += 1;
          });
        } catch (e: any) {
          // One unreadable object must not stop the rest of the tenant's purge; it is retried tomorrow.
          failed.push(doc.id);
          this.logger.error(`purge failed for document ${doc.id}: ${e?.message ?? e}`);
        }
      }
      if (docs.length < BATCH) break;
    }
  }
}
