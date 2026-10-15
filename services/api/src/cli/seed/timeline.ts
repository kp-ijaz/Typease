import type { PrismaClient } from '@typease/database';
import { DAY } from './runtime';

/**
 * Spreads the demo activity over the past weeks.
 *
 * Everything in the seed happens "now", through the real API. To make lists and
 * charts look like a centre that has been working for three months, the seed
 * afterwards moves creation-style timestamps back - by direct SQL, because no
 * API can (or should) do that.
 *
 * How: every unit of work (a request, a ticket, a customer registration ...)
 * is a *scope* with checkpoints "real time R corresponds to virtual time V".
 * A row that belongs to the scope and was written at real time t gets the
 * virtual time of the last checkpoint before t (plus the seconds that passed
 * since). The mapping is applied table by table in `apply()`.
 *
 * Never touched (see database/migrations/0003_integrity.sql):
 *   - append-only tables: audit_logs, security_events, request_status_history,
 *     document_access_logs, consent_records, payment_allocations, liability_entries;
 *   - what the immutability triggers protect: invoice numbers / amounts / issuedAt,
 *     payment amount / method / receivedAt, refund and credit-note amounts.
 * Those keep the moment the seed ran.
 */

/** Dubai has no daylight saving time: local time is always UTC+4. */
const TZ_OFFSET_MIN = 240;

/**
 * Moves a moment into opening hours of the same local day (monotonic within a
 * day, so the order of events is kept): 08:30-19:30, Friday 14:30-19:30.
 */
export function intoBusinessHours(at: Date): Date {
  const localMs = at.getTime() + TZ_OFFSET_MIN * 60_000;
  const dayStart = Math.floor(localMs / DAY) * DAY;
  const minuteOfDay = (localMs - dayStart) / 60_000;
  const weekday = new Date(dayStart).getUTCDay();
  const [open, close] = weekday === 5 ? [870, 1170] : [510, 1170];
  const mapped = open + (minuteOfDay / 1440) * (close - open);
  return new Date(dayStart + mapped * 60_000 - TZ_OFFSET_MIN * 60_000);
}

interface Checkpoint {
  scope: string;
  realAt: Date;
  virtualAt: Date;
}

interface TableRule {
  table: string;
  /** SQL expression over alias x that yields the scope id of a row. */
  scope: string;
  columns: string[];
  /** Columns that keep their distance to an anchor column (deadlines): new = map(anchor) + (column - anchor). */
  anchored?: Array<{ column: string; anchor: string }>;
  where?: string;
}

const viaDocument = `(SELECT COALESCE(d."requestId", d."id") FROM "documents" d WHERE d."id" = x."documentId")`;
const viaTask = `(SELECT COALESCE(k."requestId", k."id") FROM "tasks" k WHERE k."id" = x."taskId")`;

/** Tables whose timestamps follow a scope. Order does not matter: every statement reads the original values of its own table. */
const RULES: TableRule[] = [
  { table: 'service_requests', scope: 'x."id"', columns: ['submittedAt', 'completedAt', 'cancelledAt', 'externalStatusAt', 'createdAt', 'updatedAt'] },
  { table: 'request_fields', scope: 'x."requestId"', columns: ['updatedAt'] },
  { table: 'request_documents', scope: 'x."requestId"', columns: ['reviewedAt', 'createdAt', 'updatedAt'] },
  { table: 'request_assignments', scope: 'x."requestId"', columns: ['assignedAt', 'unassignedAt'] },
  { table: 'request_approvals', scope: 'x."requestId"', columns: ['decidedAt', 'createdAt'] },
  { table: 'request_comments', scope: 'x."requestId"', columns: ['createdAt'] },
  { table: 'request_external_references', scope: 'x."requestId"', columns: ['recordedAt'] },
  { table: 'workflow_executions', scope: 'x."requestId"', columns: ['startedAt', 'completedAt', 'updatedAt'] },
  {
    table: 'workflow_step_executions',
    scope: `(SELECT e."requestId" FROM "workflow_executions" e WHERE e."id" = x."executionId")`,
    columns: ['startedAt', 'completedAt', 'escalatedAt', 'createdAt'],
    anchored: [{ column: 'dueAt', anchor: 'startedAt' }],
  },
  { table: 'documents', scope: 'COALESCE(x."requestId", x."id")', columns: ['verifiedAt', 'createdAt', 'updatedAt'] },
  { table: 'document_versions', scope: viaDocument, columns: ['scannedAt', 'createdAt'] },
  { table: 'document_verification_results', scope: viaDocument, columns: ['createdAt'] },
  { table: 'quotations', scope: 'COALESCE(x."requestId", x."id")', columns: ['sentAt', 'decidedAt', 'createdAt', 'updatedAt'], anchored: [{ column: 'validUntil', anchor: 'createdAt' }] },
  // issuedAt is immutable and stays; the due date keeps its distance to the (virtual) moment of issue.
  { table: 'invoices', scope: 'COALESCE(x."requestId", x."id")', columns: ['voidedAt', 'createdAt', 'updatedAt'], anchored: [{ column: 'dueAt', anchor: 'issuedAt' }] },
  // receivedAt is immutable: manual payments get it through the API, online payments keep the real time.
  { table: 'payments', scope: 'x."id"', columns: ['createdAt', 'updatedAt'] },
  { table: 'refunds', scope: 'x."id"', columns: ['decidedAt', 'processedAt', 'createdAt', 'updatedAt'] },
  { table: 'expenses', scope: 'x."id"', columns: ['createdAt', 'updatedAt'] },
  { table: 'tasks', scope: 'COALESCE(x."requestId", x."id")', columns: ['completedAt', 'createdAt', 'updatedAt'], anchored: [{ column: 'dueAt', anchor: 'createdAt' }], where: `x."source" <> 'MANUAL'` },
  { table: 'tasks', scope: 'x."id"', columns: ['completedAt', 'createdAt', 'updatedAt'], where: `x."source" = 'MANUAL'` },
  { table: 'task_assignments', scope: viaTask, columns: ['assignedAt', 'unassignedAt'] },
  // A message about a record follows that record. Account messages (invitation, email verification, one-time code)
  // name no record: they follow the centre's own checkpoints (sign-up, each invitation, each registration).
  { table: 'notifications', scope: 'COALESCE(x."relatedId", x."tenantId")', columns: ['sentAt', 'createdAt'] },
  { table: 'notification_deliveries', scope: `(SELECT COALESCE(n."relatedId", n."tenantId") FROM "notifications" n WHERE n."id" = x."notificationId")`, columns: ['requestedAt', 'completedAt'] },
  { table: 'reminder_schedules', scope: viaDocument, columns: ['createdAt', 'updatedAt'] },
  {
    table: 'support_tickets',
    scope: 'x."id"',
    columns: ['firstRespondedAt', 'resolvedAt', 'closedAt', 'createdAt', 'updatedAt'],
    anchored: [
      { column: 'firstResponseDueAt', anchor: 'createdAt' },
      { column: 'resolutionDueAt', anchor: 'createdAt' },
    ],
  },
  { table: 'support_messages', scope: 'x."ticketId"', columns: ['createdAt'] },
  { table: 'customer_feedback', scope: 'COALESCE(x."requestId", x."ticketId")', columns: ['createdAt'] },
  { table: 'customers', scope: 'x."id"', columns: ['createdAt', 'updatedAt'] },
  { table: 'customer_notes', scope: 'x."customerId"', columns: ['createdAt'] },
  { table: 'customer_contacts', scope: 'x."customerId"', columns: ['createdAt'] },
  { table: 'corporate_accounts', scope: 'x."id"', columns: ['verifiedAt', 'createdAt', 'updatedAt'] },
  { table: 'corporate_members', scope: 'x."corporateAccountId"', columns: ['createdAt', 'updatedAt'] },
  { table: 'corporate_employees', scope: 'x."corporateAccountId"', columns: ['createdAt', 'updatedAt'] },
  { table: 'corporate_prices', scope: 'x."corporateAccountId"', columns: ['createdAt'] },
  { table: 'corporate_agreements', scope: 'x."corporateAccountId"', columns: ['createdAt', 'updatedAt'] },
  { table: 'tenant_memberships', scope: 'x."id"', columns: ['invitedAt', 'joinedAt', 'createdAt', 'updatedAt'] },
  { table: 'users', scope: 'x."id"', columns: ['emailVerifiedAt', 'passwordChangedAt', 'createdAt', 'updatedAt'] },
  { table: 'subscriptions', scope: 'x."id"', columns: ['createdAt', 'updatedAt'] },
  { table: 'subscription_invoices', scope: 'x."subscriptionId"', columns: ['createdAt', 'updatedAt'] },
  { table: 'subscription_events', scope: 'x."subscriptionId"', columns: ['createdAt'] },
  { table: 'data_subject_requests', scope: 'x."id"', columns: ['completedAt', 'createdAt', 'updatedAt'], anchored: [{ column: 'dueAt', anchor: 'createdAt' }] },
];

/** Catalogue and configuration rows of a centre: they simply get the day the centre was set up. */
const SETUP_TABLES: Array<{ table: string; columns: string[] }> = [
  { table: 'branches', columns: ['createdAt', 'updatedAt'] },
  { table: 'roles', columns: ['createdAt', 'updatedAt'] },
  { table: 'branding_settings', columns: ['createdAt', 'updatedAt'] },
  { table: 'service_categories', columns: ['createdAt', 'updatedAt'] },
  { table: 'services', columns: ['createdAt', 'updatedAt'] },
  { table: 'service_prices', columns: ['createdAt', 'validFrom'] },
  { table: 'service_requirements', columns: ['createdAt'] },
  { table: 'service_form_definitions', columns: ['createdAt', 'updatedAt', 'publishedAt'] },
  { table: 'workflow_definitions', columns: ['createdAt', 'updatedAt'] },
  { table: 'workflow_versions', columns: ['createdAt', 'updatedAt', 'publishedAt'] },
  { table: 'customer_tags', columns: ['createdAt'] },
  { table: 'integration_credentials_metadata', columns: ['createdAt'] },
  { table: 'appointment_slot_configs', columns: ['createdAt'] },
];

export class Timeline {
  private readonly checkpoints: Checkpoint[] = [];
  private readonly aliases = new Map<string, string>();
  private readonly setups: Array<{ tenantId: string; at: Date }> = [];
  private readonly direct: Array<{ table: string; id: string; values: Record<string, Date> }> = [];
  readonly now = new Date();

  /** "From this real moment on, rows of the scope happened at `virtualAt`." */
  mark(scope: string, virtualAt: Date): void {
    this.checkpoints.push({ scope, realAt: new Date(), virtualAt: this.clamp(virtualAt) });
  }
  /**
   * For rows whose id is only known after they were created: call `begin` before the work,
   * then the returned function with every scope id that work produced.
   */
  begin(virtualAt: Date): (...scopes: Array<string | null | undefined>) => void {
    const realAt = new Date();
    const at = this.clamp(virtualAt);
    return (...scopes) => {
      for (const scope of scopes) if (scope) this.checkpoints.push({ scope, realAt, virtualAt: at });
    };
  }
  /** Rows identified by `id` (a payment, an invoice, a quotation ...) follow the timeline of another scope. */
  alias(id: string, scope: string): void {
    this.aliases.set(id, scope);
  }
  setupDay(tenantId: string, at: Date): void {
    this.setups.push({ tenantId, at });
  }
  /** Explicit value for one row (used sparingly, e.g. tenants.createdAt). */
  set(table: string, id: string, values: Record<string, Date>): void {
    this.direct.push({ table, id, values });
  }

  /**
   * Virtual moments for a unit of work whose steps have the given weights: the first step
   * happens `startDaysAgo`, the last one `endDaysAgo`, the others in between in proportion
   * to the weight of the steps before them. All moved into opening hours.
   */
  plan(startDaysAgo: number, endDaysAgo: number, weights: number[]): Date[] {
    const t0 = this.now.getTime() - startDaysAgo * DAY;
    const span = Math.max(0, (startDaysAgo - endDaysAgo) * DAY);
    const before = weights.slice(0, -1).reduce((a, b) => a + b, 0) || 1;
    let acc = 0;
    return weights.map((w) => {
      const at = this.clamp(intoBusinessHours(new Date(t0 + (span * acc) / before)));
      acc += w;
      return at;
    });
  }
  /**
   * A moment given as "n days ago" falls on whatever time of day the seed happens to run. This moves it into
   * the opening hours of that day (the same mapping the request stages use), `minutesEarlier` before it when a
   * record must exist before the cases that refer to it (a customer before the request of the same morning).
   */
  office(at: Date, minutesEarlier = 0): Date {
    return this.clamp(new Date(intoBusinessHours(at).getTime() - minutesEarlier * 60_000));
  }
  /** Virtual moments always lie before the seed started, so they can be told apart from real timestamps. */
  clamp(at: Date): Date {
    const latest = new Date(this.now.getTime() - 120_000);
    return at > latest ? latest : at;
  }

  async apply(sys: PrismaClient): Promise<{ statements: number; rows: number }> {
    // Aliased ids share the checkpoints of their scope.
    const all: Checkpoint[] = [...this.checkpoints];
    const byScope = new Map<string, Checkpoint[]>();
    for (const c of this.checkpoints) byScope.set(c.scope, [...(byScope.get(c.scope) ?? []), c]);
    for (const [id, scope] of this.aliases) for (const c of byScope.get(scope) ?? []) all.push({ ...c, scope: id });

    const scopes = all.map((c) => c.scope);
    const reals = all.map((c) => c.realAt.toISOString());
    const virtuals = all.map((c) => c.virtualAt.toISOString());
    // $4 = the moment the seed started. Timestamps before it were written with a virtual time already
    // (the requests module and SaaS billing read their own, movable clocks) and are left alone.
    const cp = `WITH cp AS (SELECT * FROM unnest($1::uuid[], $2::timestamptz[], $3::timestamptz[]) AS t(scope, real_at, virtual_at))`;
    const mapped = (scope: string, col: string) => `COALESCE(
        (SELECT cp.virtual_at + (${col} - cp.real_at) FROM cp WHERE cp.scope = ${scope} AND cp.real_at <= ${col} ORDER BY cp.real_at DESC LIMIT 1),
        (SELECT cp.virtual_at + (${col} - cp.real_at) FROM cp WHERE cp.scope = ${scope} ORDER BY cp.real_at ASC LIMIT 1),
        ${col})`;
    const runStart = this.now.toISOString();

    let statements = 0;
    let rows = 0;
    await sys.$transaction(
      async (tx) => {
        for (const rule of RULES) {
          const sets = [
            ...rule.columns.map((c) => `"${c}" = CASE WHEN x."${c}" IS NULL OR x."${c}" < $4::timestamptz THEN x."${c}" ELSE ${mapped(rule.scope, `x."${c}"`)} END`),
            ...(rule.anchored ?? []).map(
              (a) =>
                `"${a.column}" = CASE WHEN x."${a.column}" IS NULL OR x."${a.anchor}" IS NULL OR x."${a.anchor}" < $4::timestamptz THEN x."${a.column}" ELSE ${mapped(rule.scope, `x."${a.anchor}"`)} + (x."${a.column}" - x."${a.anchor}") END`,
            ),
          ];
          const sql = `${cp} UPDATE "${rule.table}" t SET ${sets.join(', ')} FROM "${rule.table}" x
            WHERE x.ctid = t.ctid AND ${rule.scope} IN (SELECT scope FROM cp)${rule.where ? ` AND ${rule.where}` : ''}`;
          rows += await tx.$executeRawUnsafe(sql, scopes, reals, virtuals, runStart);
          statements += 1;
        }
        for (const s of this.setups) {
          for (const t of SETUP_TABLES) {
            const sets = t.columns.map((c) => `"${c}" = CASE WHEN "${c}" IS NULL THEN NULL ELSE $2::timestamptz END`).join(', ');
            rows += await tx.$executeRawUnsafe(`UPDATE "${t.table}" SET ${sets} WHERE "tenantId" = $1::uuid`, s.tenantId, s.at.toISOString());
            statements += 1;
          }
        }
        for (const d of this.direct) {
          const cols = Object.keys(d.values);
          const sets = cols.map((c, i) => `"${c}" = $${i + 2}::timestamptz`).join(', ');
          rows += await tx.$executeRawUnsafe(`UPDATE "${d.table}" SET ${sets} WHERE "id" = $1::uuid`, d.id, ...cols.map((c) => d.values[c].toISOString()));
          statements += 1;
        }
      },
      { timeout: 120_000, maxWait: 20_000 },
    );
    return { statements, rows };
  }
}
