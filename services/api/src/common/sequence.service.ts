import { Injectable } from '@nestjs/common';
import { TenantDb, Tx } from './db/prisma.service';

const PREFIX: Record<string, string> = {
  customer: 'CUS',
  corporate: 'CORP',
  request: 'TE',
  quotation: 'QUO',
  invoice: 'INV',
  payment: 'PAY',
  receipt: 'RCT',
  refund: 'RFD',
  creditnote: 'CN',
  ticket: 'TKT',
  shift: 'SH',
  journal: 'JE',
  paperwork: 'DOC',
  payroll: 'PR',
  lead: 'LD',
};

/**
 * Gap-free, per-tenant numbering. The counter row is locked until the
 * surrounding transaction commits, so a rolled-back request never burns a number
 * and two concurrent requests can never receive the same one.
 */
@Injectable()
export class SequenceService {
  constructor(private readonly db: TenantDb) {}

  async nextValue(tx: Tx, key: string, tenantId: string = this.db.tenantId): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ value: number }>>`
      INSERT INTO "number_sequences" ("id", "tenantId", "key", "nextValue")
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${key}, 2)
      ON CONFLICT ("tenantId", "key") DO UPDATE SET "nextValue" = "number_sequences"."nextValue" + 1
      RETURNING "nextValue" - 1 AS value`;
    return Number(rows[0].value);
  }

  /** e.g. next(tx, 'invoice') -> "INV-000042" */
  async next(tx: Tx, key: keyof typeof PREFIX | string, width = 6, tenantId?: string): Promise<string> {
    const n = await this.nextValue(tx, key, tenantId);
    return `${PREFIX[key] ?? key.toUpperCase()}-${String(n).padStart(width, '0')}`;
  }
}
