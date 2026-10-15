import { Injectable, OnModuleInit } from '@nestjs/common';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { ERASED_TEXT, ErasureRegistry, ErasureReport, ErasureSubject } from '../../common/erasure';

export const ERASED_TICKET_SUBJECT = 'Erased ticket';

/**
 * Erasure step of the support module: the person's tickets stay as counted, dated records but
 * lose what was written in them - subject, every message (theirs and the centre's replies),
 * attachments, the resolution summary - and the comment of their feedback. Tickets that are
 * still open are closed: there is nobody left to answer.
 */
@Injectable()
export class SupportErasure implements OnModuleInit {
  constructor(
    private readonly db: TenantDb,
    private readonly erasure: ErasureRegistry,
  ) {}

  onModuleInit() {
    this.erasure.register('support', (tx, subject) => this.erase(tx, subject));
  }

  async erase(tx: Tx, subject: ErasureSubject): Promise<ErasureReport> {
    const tenantId = this.db.tenantId;
    const tickets = await tx.supportTicket.findMany({ where: { tenantId, scope: 'CUSTOMER', customerId: { in: subject.customerIds } }, select: { id: true } });
    const ids = tickets.map((t) => t.id);
    let messages = 0;
    if (ids.length) {
      const now = new Date();
      await tx.supportTicket.updateMany({ where: { tenantId, id: { in: ids } }, data: { subject: ERASED_TICKET_SUBJECT, resolutionSummary: null } });
      await tx.supportTicket.updateMany({ where: { tenantId, id: { in: ids }, status: { notIn: ['RESOLVED', 'CLOSED'] } }, data: { status: 'CLOSED', closedAt: now } });
      messages = (await tx.supportMessage.updateMany({ where: { tenantId, ticketId: { in: ids } }, data: { body: ERASED_TEXT, attachments: [] } })).count;
      await tx.supportMessage.updateMany({ where: { tenantId, ticketId: { in: ids }, authorType: { in: ['CUSTOMER', 'CORPORATE'] } }, data: { authorName: null } });
    }
    const feedback = await tx.customerFeedback.updateMany({ where: { tenantId, customerId: { in: subject.customerIds }, comment: { not: null } }, data: { comment: null } });
    return { tickets: ids.length, messages, feedbackComments: feedback.count };
  }
}
