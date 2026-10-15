import { Injectable } from '@nestjs/common';
import { Prisma, Tx } from '../../common/db/prisma.service';
import { D } from '../../common/pagination';

type Dec = Prisma.Decimal;

/**
 * THE FINANCIAL BASIS OF EVERY REPORT AND DASHBOARD FIGURE
 *
 * GROSS COLLECTIONS (cash basis, all components)
 *   = payments completed in the period (by receivedAt; statuses COMPLETED, PARTIALLY_REFUNDED, REFUNDED)
 *   - refunds completed in the period (by processedAt).
 *   It is money through the till, including government fees, third-party charges and tax. It is NOT revenue.
 *
 * EARNED SERVICE REVENUE (accrual basis)
 *   = SERVICE_FEE lines of invoices ISSUED in the period, net of line discounts, excluding tax
 *     (lineTotal - taxAmount of each line; void and draft invoices never count)
 *   - the service-fee part of credit notes issued in the period, excluding tax.
 *   A credit note stores its service-fee part including tax; the tax share is removed in the
 *   proportion of the invoice's own service-fee lines: round2(part x net / gross).
 *
 * PASS-THROUGH FEES
 *   GOVERNMENT_FEE / THIRD_PARTY_FEE lines whose fee component is PASS_THROUGH_LIABILITY are never
 *   revenue; they are reported as "invoiced on behalf of others". When a centre configured such a
 *   component as REVENUE, its lines are reported as "other revenue", separately from the service fee.
 *
 * TAX is reported separately in every case.
 *
 * All sums are PostgreSQL `numeric` aggregates; nothing here touches a float.
 */
export const BASIS = {
  collections: 'Gross collections are on a cash basis: payments completed in the period minus refunds completed in the period, all fee components and tax included. They are not revenue.',
  revenue:
    'Earned service revenue is on an accrual basis: the service-fee lines of invoices issued in the period, net of discounts and excluding tax, minus the service-fee part of credit notes issued in the period. Void and draft invoices are excluded.',
  passThrough: 'Government fees and third-party charges treated as pass-through are money collected on behalf of others and are never counted as revenue.',
  otherRevenue: 'Fee components the centre configured as REVENUE in its finance settings are shown as "other revenue", using the configuration in force when the report is run.',
  tax: 'Tax is reported separately and is not part of any revenue figure.',
  timeZone: (tz: string) => `Days and months follow the centre's time zone (${tz}).`,
};

export interface MoneyScope {
  tenantId: string;
  /** null = every branch. */
  branchIds: string[] | null;
  /** Only invoices of requests this member prepares or reviews (operators limited to their own cases). */
  assigneeId?: string | null;
  timeZone: string;
}
export type RevenueGroup = 'none' | 'day' | 'month' | 'branch' | 'service' | 'corporate';
export type CollectionGroup = 'none' | 'day' | 'month' | 'branch';

export interface RevenueRow {
  key: string | null;
  invoices: number;
  serviceFeeInvoiced: Dec;
  serviceFeeCredited: Dec;
  /** Earned service revenue. */
  serviceFeeRevenue: Dec;
  /** Government / third-party components the centre treats as revenue. */
  otherRevenue: Dec;
  /** Pass-through fees invoiced (net of credits). Never revenue. */
  passThroughInvoiced: Dec;
  /** Tax invoiced, net of the tax share of credit notes. */
  tax: Dec;
  /** Everything invoiced net of credit notes, tax included. */
  totalInvoiced: Dec;
}
export interface CollectionRow {
  key: string | null;
  payments: Dec;
  refunds: Dec;
  /** payments - refunds. */
  grossCollections: Dec;
  paymentCount: number;
  refundCount: number;
}
export const ZERO_REVENUE = (key: string | null = null): RevenueRow => ({
  key, invoices: 0, serviceFeeInvoiced: D(0), serviceFeeCredited: D(0), serviceFeeRevenue: D(0), otherRevenue: D(0), passThroughInvoiced: D(0), tax: D(0), totalInvoiced: D(0),
});
export const ZERO_COLLECTIONS = (key: string | null = null): CollectionRow => ({ key, payments: D(0), refunds: D(0), grossCollections: D(0), paymentCount: 0, refundCount: 0 });

/** Statuses of an invoice that was issued and still stands. */
export const ISSUED_SQL = Prisma.sql`('ISSUED', 'PARTIALLY_PAID', 'PAID', 'CREDITED')`;
/** Statuses of a payment that was completed (later refunds do not undo the collection; they are counted separately). */
export const SETTLED_SQL = Prisma.sql`('COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED')`;

export const branchSql = (column: Prisma.Sql, branchIds: string[] | null): Prisma.Sql => (branchIds ? Prisma.sql`AND ${column}::text = ANY(${branchIds})` : Prisma.empty);
/** Invoice alias `i`: only invoices of requests the member works on. */
export const assigneeSql = (assigneeId: string | null | undefined): Prisma.Sql =>
  assigneeId
    ? Prisma.sql`AND EXISTS (SELECT 1 FROM "service_requests" own WHERE own."id" = i."requestId" AND (own."assignedToId" = ${assigneeId}::uuid OR own."reviewerId" = ${assigneeId}::uuid))`
    : Prisma.empty;
export const localDaySql = (column: Prisma.Sql, timeZone: string): Prisma.Sql => Prisma.sql`to_char((${column} AT TIME ZONE ${timeZone}), 'YYYY-MM-DD')`;
export const localMonthSql = (column: Prisma.Sql, timeZone: string): Prisma.Sql => Prisma.sql`to_char((${column} AT TIME ZONE ${timeZone}), 'YYYY-MM')`;

@Injectable()
export class FinanceMetrics {
  /**
   * One row per invoice line (kind INVOICE) and per credited component (kind
   * CREDIT_NOTE, negative amounts) that falls into the period:
   *   kind, doc_id, doc_no, at, branch_id, request_id, customer_id, corporate_account_id, service_id,
   *   component, is_revenue, net (excluding tax), tax
   * Every revenue report is an aggregate of this relation, so they can never disagree with each other.
   */
  movementsSql(scope: MoneyScope, start: Date, end: Date, extra: { serviceId?: string; corporateAccountId?: string } = {}): Prisma.Sql {
    const t = scope.tenantId;
    const invoiceFilters = Prisma.sql`${branchSql(Prisma.sql`i."branchId"`, scope.branchIds)} ${assigneeSql(scope.assigneeId)} ${extra.corporateAccountId ? Prisma.sql`AND i."corporateAccountId" = ${extra.corporateAccountId}::uuid` : Prisma.empty}`;
    const inner = Prisma.sql`
      SELECT 'INVOICE'::text AS kind, i."id" AS doc_id, i."invoiceNo" AS doc_no, i."issuedAt" AS at, i."branchId" AS branch_id, i."requestId" AS request_id,
             i."customerId" AS customer_id, i."corporateAccountId" AS corporate_account_id,
             COALESCE(it."serviceId", r."serviceId") AS service_id, it."component"::text AS component,
             (it."lineTotal" - it."taxAmount") AS net, it."taxAmount" AS tax
      FROM "invoices" i
      JOIN "invoice_items" it ON it."invoiceId" = i."id" AND it."tenantId" = i."tenantId"
      LEFT JOIN "service_requests" r ON r."id" = i."requestId"
      WHERE i."tenantId" = ${t}::uuid AND i."status" IN ${ISSUED_SQL} AND i."issuedAt" >= ${start} AND i."issuedAt" < ${end} ${invoiceFilters}
      UNION ALL
      SELECT 'CREDIT_NOTE'::text, c."id", c."creditNoteNo", c."issuedAt", i."branchId", i."requestId", i."customerId", i."corporateAccountId",
             COALESCE(one."service_id", r."serviceId"), comp."component",
             -(CASE WHEN ic."gross" > 0 THEN round(part."amount" * ic."net" / ic."gross", 2) ELSE part."amount" END),
             -(part."amount" - (CASE WHEN ic."gross" > 0 THEN round(part."amount" * ic."net" / ic."gross", 2) ELSE part."amount" END))
      FROM "credit_notes" c
      JOIN "invoices" i ON i."id" = c."invoiceId"
      LEFT JOIN "service_requests" r ON r."id" = i."requestId"
      CROSS JOIN (VALUES ('SERVICE_FEE'), ('GOVERNMENT_FEE'), ('THIRD_PARTY_FEE')) AS comp("component")
      CROSS JOIN LATERAL (SELECT COALESCE(NULLIF(c."breakdown" ->> comp."component", '')::numeric, 0) AS "amount") part
      LEFT JOIN LATERAL (
        SELECT SUM(x."lineTotal") AS "gross", SUM(x."lineTotal" - x."taxAmount") AS "net"
        FROM "invoice_items" x WHERE x."invoiceId" = i."id" AND x."component"::text = comp."component"
      ) ic ON true
      LEFT JOIN LATERAL (
        SELECT CASE WHEN COUNT(DISTINCT x."serviceId") = 1 THEN (array_agg(DISTINCT x."serviceId"))[1] END AS "service_id"
        FROM "invoice_items" x WHERE x."invoiceId" = i."id" AND x."serviceId" IS NOT NULL
      ) one ON true
      WHERE c."tenantId" = ${t}::uuid AND c."status" = 'ISSUED' AND c."issuedAt" >= ${start} AND c."issuedAt" < ${end} AND part."amount" <> 0 ${invoiceFilters}`;
    return Prisma.sql`
      SELECT mv.*, (mv.component = 'SERVICE_FEE' OR COALESCE(fc."treatment"::text, 'PASS_THROUGH_LIABILITY') = 'REVENUE') AS is_revenue
      FROM (${inner}) mv
      LEFT JOIN "fee_components" fc ON fc."tenantId" = ${t}::uuid AND fc."type"::text = mv.component
      ${extra.serviceId ? Prisma.sql`WHERE mv.service_id = ${extra.serviceId}::uuid` : Prisma.empty}`;
  }

  private keySql(group: RevenueGroup, timeZone: string): Prisma.Sql {
    switch (group) {
      case 'day':
        return localDaySql(Prisma.sql`m.at`, timeZone);
      case 'month':
        return localMonthSql(Prisma.sql`m.at`, timeZone);
      case 'branch':
        return Prisma.sql`m.branch_id::text`;
      case 'service':
        return Prisma.sql`m.service_id::text`;
      case 'corporate':
        return Prisma.sql`m.corporate_account_id::text`;
      default:
        return Prisma.sql`'all'::text`;
    }
  }

  /** Invoiced and earned amounts of the period, grouped. Groups without any movement are absent. */
  async revenue(tx: Tx, scope: MoneyScope, start: Date, end: Date, group: RevenueGroup = 'none', extra: { serviceId?: string; corporateAccountId?: string } = {}): Promise<RevenueRow[]> {
    const rows = await tx.$queryRaw<Array<Record<string, any>>>`
      WITH m AS (${this.movementsSql(scope, start, end, extra)})
      SELECT ${this.keySql(group, scope.timeZone)} AS key,
        (COUNT(DISTINCT m.doc_id) FILTER (WHERE m.kind = 'INVOICE'))::int AS invoices,
        COALESCE(SUM(m.net) FILTER (WHERE m.kind = 'INVOICE' AND m.component = 'SERVICE_FEE'), 0) AS service_fee_invoiced,
        COALESCE(-SUM(m.net) FILTER (WHERE m.kind = 'CREDIT_NOTE' AND m.component = 'SERVICE_FEE'), 0) AS service_fee_credited,
        COALESCE(SUM(m.net) FILTER (WHERE m.component = 'SERVICE_FEE'), 0) AS service_fee_revenue,
        COALESCE(SUM(m.net) FILTER (WHERE m.component <> 'SERVICE_FEE' AND m.is_revenue), 0) AS other_revenue,
        COALESCE(SUM(m.net) FILTER (WHERE NOT m.is_revenue), 0) AS pass_through,
        COALESCE(SUM(m.tax), 0) AS tax,
        COALESCE(SUM(m.net + m.tax), 0) AS total
      FROM m GROUP BY 1 ORDER BY 1 NULLS LAST`;
    return rows.map((r) => ({
      key: r.key ?? null,
      invoices: Number(r.invoices),
      serviceFeeInvoiced: D(r.service_fee_invoiced),
      serviceFeeCredited: D(r.service_fee_credited),
      serviceFeeRevenue: D(r.service_fee_revenue),
      otherRevenue: D(r.other_revenue),
      passThroughInvoiced: D(r.pass_through),
      tax: D(r.tax),
      totalInvoiced: D(r.total),
    }));
  }
  async revenueTotal(tx: Tx, scope: MoneyScope, start: Date, end: Date): Promise<RevenueRow> {
    return (await this.revenue(tx, scope, start, end, 'none'))[0] ?? ZERO_REVENUE('all');
  }

  /** Cash in and out of the period, grouped. Refunds follow the branch of the payment they return. */
  async collections(tx: Tx, scope: MoneyScope, start: Date, end: Date, group: CollectionGroup = 'none'): Promise<CollectionRow[]> {
    const key = (at: Prisma.Sql) =>
      group === 'day' ? localDaySql(at, scope.timeZone) : group === 'month' ? localMonthSql(at, scope.timeZone) : group === 'branch' ? Prisma.sql`p."branchId"::text` : Prisma.sql`'all'::text`;
    const rows = await tx.$queryRaw<Array<Record<string, any>>>`
      SELECT x.key, COALESCE(SUM(x.paid), 0) AS payments, COALESCE(SUM(x.refunded), 0) AS refunds,
             (COUNT(*) FILTER (WHERE x.kind = 'P'))::int AS payment_count, (COUNT(*) FILTER (WHERE x.kind = 'R'))::int AS refund_count
      FROM (
        SELECT ${key(Prisma.sql`p."receivedAt"`)} AS key, 'P'::text AS kind, p."amount" AS paid, 0::numeric AS refunded
        FROM "payments" p
        WHERE p."tenantId" = ${scope.tenantId}::uuid AND p."status" IN ${SETTLED_SQL} AND p."receivedAt" >= ${start} AND p."receivedAt" < ${end} ${branchSql(Prisma.sql`p."branchId"`, scope.branchIds)}
        UNION ALL
        SELECT ${key(Prisma.sql`rf."processedAt"`)}, 'R'::text, 0::numeric, rf."amount"
        FROM "refunds" rf JOIN "payments" p ON p."id" = rf."paymentId"
        WHERE rf."tenantId" = ${scope.tenantId}::uuid AND rf."status" = 'COMPLETED' AND rf."processedAt" >= ${start} AND rf."processedAt" < ${end} ${branchSql(Prisma.sql`p."branchId"`, scope.branchIds)}
      ) x GROUP BY 1 ORDER BY 1 NULLS LAST`;
    return rows.map((r) => {
      const payments = D(r.payments);
      const refunds = D(r.refunds);
      return { key: r.key ?? null, payments, refunds, grossCollections: payments.minus(refunds), paymentCount: Number(r.payment_count), refundCount: Number(r.refund_count) };
    });
  }
  async collectionsTotal(tx: Tx, scope: MoneyScope, start: Date, end: Date): Promise<CollectionRow> {
    return (await this.collections(tx, scope, start, end, 'none'))[0] ?? ZERO_COLLECTIONS('all');
  }

  /** Open balances of issued invoices, as of now. */
  async receivables(tx: Tx, scope: MoneyScope): Promise<{ outstanding: Dec; invoices: number }> {
    const rows = await tx.$queryRaw<Array<{ outstanding: Dec; invoices: number }>>`
      SELECT COALESCE(SUM(i."balanceDue"), 0) AS outstanding, COUNT(*)::int AS invoices
      FROM "invoices" i
      WHERE i."tenantId" = ${scope.tenantId}::uuid AND i."status" IN ('ISSUED', 'PARTIALLY_PAID') AND i."balanceDue" > 0
        ${branchSql(Prisma.sql`i."branchId"`, scope.branchIds)} ${assigneeSql(scope.assigneeId)}`;
    return { outstanding: D(rows[0]?.outstanding), invoices: Number(rows[0]?.invoices ?? 0) };
  }
}
