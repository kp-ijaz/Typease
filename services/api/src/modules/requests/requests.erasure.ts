import { Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@typease/database';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { ERASED_TEXT, ErasureRegistry, ErasureReport, ErasureSubject, identifierPattern, scrubJson, scrubText } from '../../common/erasure';

/**
 * Erasure step of the requests module. The requests of the person stay as business records
 * (number, service, status, dates, who worked on them); what the person told the centre does not:
 * the submitted form data, instructions, comments and notes, free-text reasons, and the public
 * tracking code. The append-only status history is handled by the privacy module.
 */
@Injectable()
export class RequestsErasure implements OnModuleInit {
  constructor(
    private readonly db: TenantDb,
    private readonly erasure: ErasureRegistry,
  ) {}

  onModuleInit() {
    this.erasure.register('requests', (tx, subject) => this.erase(tx, subject));
  }

  async erase(tx: Tx, subject: ErasureSubject): Promise<ErasureReport> {
    const tenantId = this.db.tenantId;
    const ids = subject.requestIds;
    if (!ids.length) return { requests: 0, formFields: 0, comments: 0 };
    const pattern = identifierPattern(subject.identifiers);
    const of = { tenantId, requestId: { in: ids } };

    const formFields = await tx.requestField.deleteMany({ where: of });
    const comments = await tx.requestComment.updateMany({ where: of, data: { body: ERASED_TEXT } });
    // The name shown next to a comment written by the person or their company.
    await tx.requestComment.updateMany({ where: { ...of, authorType: { in: ['CUSTOMER', 'CORPORATE'] } }, data: { authorName: null } });
    const requests = await tx.serviceRequest.updateMany({ where: { tenantId, id: { in: ids } }, data: { customerInstructions: null, trackingCodeHash: null } });
    // Free text written by staff about the case: the identifiers of the person are removed from it.
    for (const r of await tx.serviceRequest.findMany({ where: { tenantId, id: { in: ids }, OR: [{ cancellationReason: { not: null } }, { externalStatus: { not: null } }] }, select: { id: true, cancellationReason: true, externalStatus: true } })) {
      await tx.serviceRequest.update({ where: { id: r.id }, data: { cancellationReason: scrubText(r.cancellationReason, pattern), externalStatus: scrubText(r.externalStatus, pattern) } });
    }
    await tx.requestExternalReference.updateMany({ where: { ...of, notes: { not: null } }, data: { notes: null } });
    await tx.requestDocument.updateMany({ where: { ...of, rejectionReason: { not: null } }, data: { rejectionReason: null } });
    await tx.requestAssignment.updateMany({ where: { ...of, reason: { not: null } }, data: { reason: null } });
    for (const a of await tx.requestApproval.findMany({ where: of, select: { id: true, comment: true, payload: true } })) {
      await tx.requestApproval.update({ where: { id: a.id }, data: { comment: a.comment ? ERASED_TEXT : null, payload: scrubJson(a.payload, pattern) as Prisma.InputJsonValue } });
    }
    for (const step of await tx.workflowStepExecution.findMany({ where: { tenantId, execution: { requestId: { in: ids } } }, select: { id: true, result: true } })) {
      await tx.workflowStepExecution.update({ where: { id: step.id }, data: { result: scrubJson(step.result, pattern) as Prisma.InputJsonValue } });
    }
    return { requests: requests.count, formFields: formFields.count, comments: comments.count };
  }
}
