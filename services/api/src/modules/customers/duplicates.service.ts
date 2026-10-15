import { Injectable } from '@nestjs/common';
import { blindIndex } from '../../common/crypto';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { CUSTOMER_COLUMNS, CustomerRow, customerListItem, normaliseName } from './customer-view';

export type DuplicateSignal = 'EMIRATES_ID' | 'PASSPORT' | 'PHONE' | 'EMAIL' | 'NAME';
/** A matching name alone is weak: common names are shared by many people. */
const STRONG: DuplicateSignal[] = ['EMIRATES_ID', 'PASSPORT', 'PHONE', 'EMAIL'];
const MAX_PER_SIGNAL = 10;

export interface DuplicateInput {
  fullName?: string | null;
  email?: string | null;
  phone?: string | null;
  emiratesId?: string | null;
  passportNo?: string | null;
  excludeId?: string;
}
export interface DuplicateCandidate {
  customer: ReturnType<typeof customerListItem>;
  signals: DuplicateSignal[];
  strength: 'STRONG' | 'WEAK';
}

/**
 * Finds records that may be the same person. It only reports; it never merges
 * and never decides. Records that were already merged or anonymised are ignored.
 */
@Injectable()
export class DuplicatesService {
  constructor(private readonly db: TenantDb) {}

  /**
   * Two receptionists registering the same person at the same moment must not
   * both pass the check: the identifying values are locked for the transaction.
   */
  async lock(tx: Tx, input: DuplicateInput): Promise<void> {
    const tenantId = this.db.tenantId;
    const keys = [
      input.emiratesId ? `eid:${blindIndex(tenantId, 'emiratesId', input.emiratesId)}` : null,
      input.passportNo ? `pp:${blindIndex(tenantId, 'passport', input.passportNo)}` : null,
      input.phone ? `ph:${input.phone}` : null,
      input.email ? `em:${input.email}` : null,
    ]
      .filter((k): k is string => !!k)
      .map((k) => `customer-dup:${tenantId}:${k}`)
      .sort();
    for (const key of keys) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }

  async find(tx: Tx, input: DuplicateInput): Promise<DuplicateCandidate[]> {
    const tenantId = this.db.tenantId;
    const hits = new Map<string, Set<DuplicateSignal>>();
    const add = (rows: Array<{ id: string }>, signal: DuplicateSignal) => {
      for (const r of rows) hits.set(r.id, (hits.get(r.id) ?? new Set<DuplicateSignal>()).add(signal));
    };
    const base = { tenantId, deletedAt: null, status: { in: ['ACTIVE', 'ARCHIVED'] as Array<'ACTIVE' | 'ARCHIVED'> }, ...(input.excludeId ? { id: { not: input.excludeId } } : {}) };
    const lookup = (where: Record<string, unknown>) => tx.customer.findMany({ where: { ...base, ...where }, select: { id: true }, take: MAX_PER_SIGNAL, orderBy: { createdAt: 'asc' } });

    if (input.emiratesId) add(await lookup({ emiratesIdHash: blindIndex(tenantId, 'emiratesId', input.emiratesId) }), 'EMIRATES_ID');
    if (input.passportNo) add(await lookup({ passportNoHash: blindIndex(tenantId, 'passport', input.passportNo) }), 'PASSPORT');
    if (input.phone) add(await lookup({ phone: input.phone }), 'PHONE');
    if (input.email) add(await lookup({ email: input.email.toLowerCase() }), 'EMAIL');
    if (input.fullName && normaliseName(input.fullName).length >= 2) {
      // The database lower-cases both sides, so the comparison never depends on two different case rules.
      const name = input.fullName.replace(/\s+/g, ' ').trim();
      const exclude = input.excludeId ?? '00000000-0000-0000-0000-000000000000';
      add(
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "customers"
          WHERE "tenantId" = ${tenantId}::uuid AND "deletedAt" IS NULL AND "status" IN ('ACTIVE', 'ARCHIVED')
            AND "id" <> ${exclude}::uuid AND lower("fullName") = lower(${name})
          ORDER BY "createdAt" LIMIT ${MAX_PER_SIGNAL}`,
        'NAME',
      );
    }
    if (!hits.size) return [];

    const rows = (await tx.customer.findMany({ where: { tenantId, id: { in: [...hits.keys()] } }, select: CUSTOMER_COLUMNS })) as CustomerRow[];
    return rows
      .map((row) => {
        const signals = [...hits.get(row.id)!];
        return { customer: customerListItem(row), signals, strength: signals.some((s) => STRONG.includes(s)) ? ('STRONG' as const) : ('WEAK' as const) };
      })
      .sort((a, b) => Number(b.strength === 'STRONG') - Number(a.strength === 'STRONG') || b.signals.length - a.signals.length || a.customer.customerNo.localeCompare(b.customer.customerNo));
  }

  /** POST /customers/duplicates/check */
  check(input: DuplicateInput) {
    return this.db.tx(async (tx) => {
      const candidates = await this.find(tx, input);
      return { candidates, strongCount: candidates.filter((c) => c.strength === 'STRONG').length, weakCount: candidates.filter((c) => c.strength === 'WEAK').length };
    });
  }
}
