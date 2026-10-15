import { Injectable, OnModuleInit } from '@nestjs/common';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { ErasureRegistry, ErasureReport, ErasureSubject } from '../../common/erasure';

/**
 * Erasure step of the appointments module: notes and reasons on the person's appointments are
 * removed, and appointments that have not taken place yet are cancelled (the slot is free again).
 * Past appointments stay as calendar history of an anonymous customer.
 */
@Injectable()
export class AppointmentsErasure implements OnModuleInit {
  constructor(
    private readonly db: TenantDb,
    private readonly erasure: ErasureRegistry,
  ) {}

  onModuleInit() {
    this.erasure.register('appointments', (tx, subject) => this.erase(tx, subject));
  }

  async erase(tx: Tx, subject: ErasureSubject): Promise<ErasureReport> {
    const tenantId = this.db.tenantId;
    const where = { tenantId, customerId: { in: subject.customerIds } };
    const scrubbed = await tx.appointment.updateMany({ where, data: { notes: null, cancelledReason: null, guestName: null, guestPhone: null } });
    const cancelled = await tx.appointment.updateMany({ where: { ...where, status: { in: ['BOOKED', 'CONFIRMED'] }, startsAt: { gt: new Date() } }, data: { status: 'CANCELLED' } });
    return { appointments: scrubbed.count, cancelledUpcoming: cancelled.count };
  }
}
