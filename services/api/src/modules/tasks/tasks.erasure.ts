import { Injectable, OnModuleInit } from '@nestjs/common';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { ErasureRegistry, ErasureReport, ErasureSubject, identifierPattern, scrubText } from '../../common/erasure';

/** Erasure step of the tasks module: tasks about the person or their requests lose their free text. */
@Injectable()
export class TasksErasure implements OnModuleInit {
  constructor(
    private readonly db: TenantDb,
    private readonly erasure: ErasureRegistry,
  ) {}

  onModuleInit() {
    this.erasure.register('tasks', (tx, subject) => this.erase(tx, subject));
  }

  async erase(tx: Tx, subject: ErasureSubject): Promise<ErasureReport> {
    const tenantId = this.db.tenantId;
    const pattern = identifierPattern(subject.identifiers);
    const tasks = await tx.task.findMany({
      where: { tenantId, OR: [{ customerId: { in: subject.customerIds } }, ...(subject.requestIds.length ? [{ requestId: { in: subject.requestIds } }] : [])] },
      select: { id: true, title: true, description: true },
    });
    for (const task of tasks) await tx.task.update({ where: { id: task.id }, data: { title: scrubText(task.title, pattern), description: null } });
    return { tasks: tasks.length };
  }
}
