import { Injectable, OnModuleInit } from '@nestjs/common';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { ErasureRegistry, ErasureReport, ErasureSubject } from '../../common/erasure';

/**
 * Erasure step of the corporate module: the employment record of the person. The row stays (it
 * is what links the company's past requests to an - now anonymous - person) but is switched off
 * and loses the company's staff number and the job title.
 */
@Injectable()
export class CorporateErasure implements OnModuleInit {
  constructor(
    private readonly db: TenantDb,
    private readonly erasure: ErasureRegistry,
  ) {}

  onModuleInit() {
    this.erasure.register('corporate', (tx, subject) => this.erase(tx, subject));
  }

  async erase(tx: Tx, subject: ErasureSubject): Promise<ErasureReport> {
    const employees = await tx.corporateEmployee.updateMany({
      where: { tenantId: this.db.tenantId, customerId: { in: subject.customerIds } },
      data: { status: 'INACTIVE', employeeNo: null, designation: null },
    });
    return { employeeRecords: employees.count };
  }
}
