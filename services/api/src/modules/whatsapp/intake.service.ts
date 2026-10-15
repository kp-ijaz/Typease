import { Injectable } from '@nestjs/common';
import type { InboxIntakeInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { TenantDb } from '../../common/db/prisma.service';
import { AppError, Errors, found } from '../../common/errors';
import { OcrService } from '../ocr/ocr.service';
import { RequestActionsService } from '../requests/request-actions.service';
import { RequestsService } from '../requests/requests.service';

/**
 * WhatsApp intake: a photo or PDF a customer sent in the inbox becomes a draft request of the chosen service. The
 * file is filed under its document type, linked to the matching checklist line and read by OCR; staff check the
 * suggestions on the request page. Each step that cannot happen yet (the file is still being scanned, OCR is not
 * available) is reported, never silently skipped.
 */
@Injectable()
export class WhatsAppIntakeService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly requests: RequestsService,
    private readonly actions: RequestActionsService,
    private readonly ocr: OcrService,
  ) {}

  async intake(messageId: string, input: InboxIntakeInput) {
    const tenantId = this.db.tenantId;
    const { message, conversation } = await this.db.tx(async (tx) => {
      const m = found(await tx.waMessage.findFirst({ where: { id: messageId, tenantId }, include: { conversation: true } }), 'Message');
      if (m.direction !== 'IN' || !m.documentId) throw Errors.unprocessable('NO_FILE', 'Only a photo or PDF the customer sent can start a request.');
      if (!m.conversation.customerId) throw Errors.unprocessable('NO_CUSTOMER', 'Link the conversation to a customer first.');
      const type = await tx.documentType.findFirst({ where: { key: input.documentTypeKey, isActive: true, OR: [{ tenantId }, { tenantId: null }] }, select: { key: true } });
      if (!type) throw Errors.unprocessable('UNKNOWN_DOCUMENT_TYPE', 'That document type does not exist.');
      // File it under what it really is: the checklist and the OCR profile follow the type.
      await tx.document.updateMany({ where: { id: m.documentId, tenantId, documentTypeKey: 'other' }, data: { documentTypeKey: type.key } });
      return { message: m, conversation: m.conversation };
    });

    const request = await this.requests.create({ serviceId: input.serviceId, customerId: conversation.customerId!, instructions: `Started from a WhatsApp message (${conversation.phone}).` });
    const warnings: string[] = [];
    const line = request.checklist?.find((l) => l.kind === 'INPUT' && l.documentTypeKey === input.documentTypeKey && !l.document);
    let linked = false;
    if (!line) warnings.push('NO_MATCHING_CHECKLIST_LINE');
    else {
      try {
        await this.actions.linkDocument(request.id, line.id, message.documentId!);
        linked = true;
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        warnings.push(e.code);
      }
    }
    let ocr: { id: string; status: string } | null = null;
    if (input.runOcr) {
      try {
        const r = (await this.ocr.requestExtraction(message.documentId!, { profile: 'AUTO' })) as { id: string; status: string };
        ocr = { id: r.id, status: r.status };
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        warnings.push(e.code);
      }
    }
    await this.db.tx(async (tx) => {
      await tx.waMessage.create({ data: { tenantId, conversationId: conversation.id, direction: 'NOTE', kind: 'TEXT', status: 'NOTE', authorId: ctx().userId ?? null, body: `Request ${request.requestNo} started from this file${linked ? '' : ' (link the file on the request page)'}${ocr ? '; OCR is reading it' : ''}.` } });
      await this.audit.log({ action: 'whatsapp.intake', resourceType: 'ServiceRequest', resourceId: request.id, summary: `${request.requestNo} started from a WhatsApp file`, after: { messageId, documentId: message.documentId, linked, ocr: ocr?.id ?? null, warnings } }, tx);
    });
    return { requestId: request.id, requestNo: request.requestNo as string, linked, ocr, warnings };
  }
}
