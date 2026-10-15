import { Injectable, OnModuleInit } from '@nestjs/common';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { ErasureRegistry, ErasureReport, ErasureSubject } from '../../common/erasure';

/**
 * Erasure step of the AI document assistant: everything that was read out of the person's
 * documents (extracted and reviewed values) is removed at once - also for a document that itself
 * has to be kept (legal hold): the file is the record, the extraction is only a copy of its data.
 */
@Injectable()
export class OcrErasure implements OnModuleInit {
  constructor(
    private readonly db: TenantDb,
    private readonly erasure: ErasureRegistry,
  ) {}

  onModuleInit() {
    this.erasure.register('ocr', (tx, subject) => this.erase(tx, subject));
  }

  async erase(tx: Tx, subject: ErasureSubject): Promise<ErasureReport> {
    const tenantId = this.db.tenantId;
    const removed = await tx.ocrExtractionResult.deleteMany({
      where: { tenantId, document: { OR: [{ customerId: { in: subject.customerIds } }, ...(subject.requestIds.length ? [{ requestId: { in: subject.requestIds } }] : [])] } },
    });
    return { extractions: removed.count };
  }
}
