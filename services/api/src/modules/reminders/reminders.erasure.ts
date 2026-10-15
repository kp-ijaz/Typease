import { Injectable, OnModuleInit } from '@nestjs/common';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { ErasureRegistry, ErasureReport, ErasureSubject } from '../../common/erasure';

/** Erasure step of the reminders module: the person's expiry reminders (and their send log) are deleted, so nothing is sent any more. */
@Injectable()
export class RemindersErasure implements OnModuleInit {
  constructor(
    private readonly db: TenantDb,
    private readonly erasure: ErasureRegistry,
  ) {}

  onModuleInit() {
    this.erasure.register('reminders', (tx, subject) => this.erase(tx, subject));
  }

  async erase(tx: Tx, subject: ErasureSubject): Promise<ErasureReport> {
    const tenantId = this.db.tenantId;
    const where = { tenantId, customerId: { in: subject.customerIds } };
    const dispatches = await tx.reminderDispatch.deleteMany({ where: { tenantId, schedule: where } });
    const schedules = await tx.reminderSchedule.deleteMany({ where });
    return { schedules: schedules.count, dispatches: dispatches.count };
  }
}
