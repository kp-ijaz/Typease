import { Prisma, Tx } from '../../../common/db/prisma.service';
import { D, DecimalInput, sum } from '../../../common/pagination';
import { MoneyScope } from '../finance-metrics.service';
import { ReportColumn, ReportContext, ReportRow } from '../report.types';

/** Money for the API: a two-decimal string. */
export const money = (value: DecimalInput | null | undefined): string => D(value).toFixed(2);
export const moneyTotal = (rows: ReportRow[], key: string): string => sum(rows.map((r) => (r[key] === null || r[key] === undefined ? 0 : String(r[key])))).toFixed(2);
export const intTotal = (rows: ReportRow[], key: string): number => rows.reduce((n, r) => n + Number(r[key] ?? 0), 0);
/** `part / whole` as a percentage with one decimal, or null when there is nothing to divide by. */
export function percent(part: DecimalInput, whole: DecimalInput): number | null {
  const w = D(whole);
  if (w.isZero()) return null;
  return D(part).mul(100).div(w).toDecimalPlaces(1, Prisma.Decimal.ROUND_HALF_UP).toNumber();
}
export const col = (key: string, label: string, type: ReportColumn['type'] = 'text'): ReportColumn => ({ key, label, type });

export const scopeOf = (rc: ReportContext): MoneyScope => ({ tenantId: rc.tenantId, branchIds: rc.branchIds, timeZone: rc.timeZone });

/** Reports that list individual records stop here; their totals always cover every record. */
export const MAX_LISTED_ROWS = 2000;

export async function branchNames(tx: Tx, rc: ReportContext): Promise<Map<string, string>> {
  const rows = await tx.branch.findMany({ where: { tenantId: rc.tenantId, ...(rc.branchIds ? { id: { in: rc.branchIds } } : {}) }, select: { id: true, name: true }, orderBy: [{ isHeadOffice: 'desc' }, { name: 'asc' }] });
  return new Map(rows.map((b) => [b.id, b.name]));
}
export async function serviceNames(tx: Tx, rc: ReportContext, ids: Array<string | null>): Promise<Map<string, { name: string; code: string }>> {
  const wanted = [...new Set(ids.filter((v): v is string => !!v))];
  if (!wanted.length) return new Map();
  // Deleted services still label the history they belong to.
  const rows = await tx.service.findMany({ where: { tenantId: rc.tenantId, id: { in: wanted } }, select: { id: true, name: true, code: true } });
  return new Map(rows.map((s) => [s.id, { name: s.name, code: s.code }]));
}
/** How a customer is named for this viewer: the name with customer.read, otherwise the customer number. */
export const customerLabel = (rc: ReportContext, customer: { fullName?: string | null; customerNo?: string | null } | null | undefined): string | null =>
  customer ? ((rc.viewer.customerNames ? customer.fullName : customer.customerNo) ?? customer.customerNo ?? null) : null;
/** SQL expression for the same rule (aliases: customers `cu`). */
export const customerLabelSql = (rc: ReportContext): Prisma.Sql => (rc.viewer.customerNames ? Prisma.sql`cu."fullName"` : Prisma.sql`cu."customerNo"`);

/**
 * Customers whose records were merged are ONE customer in a breakdown. These two CTEs map every customer id of
 * `seed` (a query with one column `id`) to the record that was kept: `survivor(id, root)`. A record points at
 * another one only while its status is MERGED; chains (older data) are followed, at most ten steps.
 * Use inside `WITH RECURSIVE ...`, then `JOIN survivor sv ON sv.id = <customer id>` and label / group by `sv.root`.
 * (The same rule as `mergedCustomerIds` in common/merged-customers.ts, which the finance lists use.)
 */
export const survivorCtes = (tenantId: string, seed: Prisma.Sql): Prisma.Sql => Prisma.sql`
  up AS (
    SELECT s.id, c."id" AS cur, c."status"::text AS status, c."mergedIntoId" AS next, 0 AS hop
    FROM (${seed}) s JOIN "customers" c ON c."id" = s.id AND c."tenantId" = ${tenantId}::uuid
    UNION ALL
    SELECT up.id, p."id", p."status"::text, p."mergedIntoId", up.hop + 1
    FROM up JOIN "customers" p ON p."id" = up.next AND p."tenantId" = ${tenantId}::uuid
    WHERE up.status = 'MERGED' AND up.hop < 10
  ),
  survivor AS (SELECT DISTINCT ON (id) id, cur AS root FROM up ORDER BY id, hop DESC)`;

export const hours = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
export const isoDay = (value: Date | string | null | undefined): string | null => (value ? (value instanceof Date ? value.toISOString() : String(value)) : null);
