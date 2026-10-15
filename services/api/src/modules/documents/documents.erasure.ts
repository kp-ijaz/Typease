import { Injectable, OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@typease/database';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { ErasureRegistry, ErasureReport, ErasureSubject } from '../../common/erasure';
import { DocumentsService, ERASED_DOCUMENT_TITLE } from './documents.service';

export { ERASED_DOCUMENT_TITLE };

/**
 * Erasure step of the document vault: the documents of the person and of their requests are
 * deleted with no restore window (`purgeAfter = now`: the purge job that the privacy module starts
 * right after the erasure removes the files), share links are revoked, and titles, file names,
 * share recipients and verification notes are blanked at once. Documents that may not be deleted -
 * legal hold, a later retention date, used by somebody else's open request - are kept as they are
 * and counted, so the erasure can say so.
 */
@Injectable()
export class DocumentsErasure implements OnModuleInit {
  constructor(
    private readonly db: TenantDb,
    private readonly erasure: ErasureRegistry,
    private readonly documents: DocumentsService,
  ) {}

  onModuleInit() {
    this.erasure.register('documents', (tx, subject) => this.erase(tx, subject));
  }

  /** Documents of the person: filed under one of their records, or under one of their requests. */
  static ownedBy(tenantId: string, subject: Pick<ErasureSubject, 'customerIds' | 'requestIds'>): Prisma.DocumentWhereInput {
    return { tenantId, OR: [{ customerId: { in: subject.customerIds } }, ...(subject.requestIds.length ? [{ requestId: { in: subject.requestIds } }] : [])] };
  }

  async erase(tx: Tx, subject: ErasureSubject): Promise<ErasureReport> {
    const tenantId = this.db.tenantId;
    const owned = DocumentsErasure.ownedBy(tenantId, subject);
    const now = new Date();
    let deleted = 0;
    let kept = 0;
    const erasedIds: string[] = [];
    for (const doc of await tx.document.findMany({ where: { AND: [owned, { status: { not: 'DELETED' } }] } })) {
      if (await this.documents.deletionBlocker(tx, doc)) {
        kept += 1;
        continue;
      }
      await this.documents.softDeleteInternal(tx, doc, { purgeAfter: now, action: 'document.erased', summary: `Erasure request ${subject.privacyRequestId}` });
      erasedIds.push(doc.id);
      deleted += 1;
    }
    // Documents that were deleted earlier and still wait out their restore window are released for purging as well.
    const earlier = await tx.document.findMany({ where: { AND: [owned, { status: 'DELETED', legalHold: false }] }, select: { id: true, purgeAfter: true } });
    const released = earlier.filter((d) => !erasedIds.includes(d.id) && (!d.purgeAfter || d.purgeAfter > now)).length;
    const gone = earlier.map((d) => d.id);
    if (gone.length) {
      await tx.document.updateMany({ where: { tenantId, id: { in: gone } }, data: { title: ERASED_DOCUMENT_TITLE, category: null } });
      await tx.document.updateMany({ where: { tenantId, id: { in: gone }, OR: [{ purgeAfter: null }, { purgeAfter: { gt: now } }] }, data: { purgeAfter: now } });
      // File names are chosen by the uploader and often carry the name of the person.
      await tx.documentVersion.updateMany({ where: { tenantId, documentId: { in: gone }, originalFilename: { not: 'purged' } }, data: { originalFilename: 'erased' } });
      await tx.documentShare.updateMany({ where: { tenantId, documentId: { in: gone } }, data: { recipient: null } });
      await tx.documentShare.updateMany({ where: { tenantId, documentId: { in: gone }, revokedAt: null }, data: { revokedAt: now } });
      await tx.documentVerificationResult.updateMany({ where: { tenantId, documentId: { in: gone } }, data: { reason: null, fieldsConfirmed: {} } });
    }
    // A document that has to be kept (legal hold ...) is kept for the centre, not for third parties: its share links end too.
    await tx.documentShare.updateMany({ where: { tenantId, document: owned, revokedAt: null }, data: { revokedAt: now } });
    await tx.documentShare.updateMany({ where: { tenantId, document: owned, recipient: { not: null } }, data: { recipient: null } });
    return { deletedDocuments: deleted, keptDocuments: kept, releasedForPurge: released };
  }
}
