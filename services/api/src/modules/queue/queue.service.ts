import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import type { CallNextInput, DisplayTokenInput, IssueTokenInput, QueueListQuery, QueueStatsQuery } from '@typease/validation';
import { env } from '../../config/env';
import { AuditService } from '../../common/audit.service';
import { ctx, runAsTenant } from '../../common/context';
import { signPayload, verifyPayload } from '../../common/crypto';
import { Prisma, TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { assertCustomerNotErased } from '../../common/customer-ref';
import { assertBranchAccess } from '../../common/scope';
import { SequenceService } from '../../common/sequence.service';
import { localParts, safeTimeZone } from '../appointments/slots';
import { lockTenantSettings, saveTenantSettingsSection } from '../notifications/settings';

const WALK_IN_LETTER = 'W';
const DISPLAY_KIND = 'queue-display';
const POLL_MS = 3_000;
const HEARTBEAT_MS = 20_000;
const MAX_STREAM_MS = 60 * 60_000;

type TokenRow = Prisma.QueueTokenGetPayload<{ include: { customer: { select: { fullName: true } } } }>;
export interface DisplayAccess {
  tenantId: string;
  branchId: string;
  version: number;
  exp: number;
}
/** What a public queue screen may show: token numbers, counters and statuses. Nothing about people. */
export interface DisplayState {
  branch: { name: string; nameAr: string | null };
  date: string;
  language: string;
  nowServing: Array<{ tokenNo: string; counter: string | null; status: 'CALLED' | 'SERVING' }>;
  nextUp: string[];
  waitingCount: number;
  generatedAt: string;
}

/**
 * Walk-in queue: tokens per branch and day, counters, the public display and
 * waiting-time statistics.
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  /** In-process nudge so open display streams refresh at once after a change (polling covers other instances). */
  private readonly changes = new EventEmitter().setMaxListeners(0);
  private readonly streams = new Set<() => void>();

  /** Shutdown: release every open display stream (timers, listeners, sockets). */
  onModuleDestroy() {
    for (const close of [...this.streams]) close();
  }

  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly sequences: SequenceService,
  ) {}

  // ------------------------------------------------------------------ helpers
  private async branch(tx: Tx, branchId: string) {
    const branch = found(await tx.branch.findFirst({ where: { id: branchId, tenantId: this.db.tenantId }, select: { id: true, name: true, nameAr: true, timezone: true, isActive: true } }), 'Branch');
    assertBranchAccess(branch.id);
    return branch;
  }
  private today(timeZone: string, now = new Date()): string {
    return localParts(now, safeTimeZone(timeZone)).date;
  }
  private dateOnly = (date: string) => new Date(`${date}T00:00:00.000Z`);
  private touched(branchId: string) {
    const key = `${this.db.tenantId}:${branchId}`;
    this.db.afterCommit(() => void this.changes.emit(key));
  }
  /** A = first service category, B = second ... so people can tell queues apart at a glance. */
  private async letter(tx: Tx, categoryId: string | null): Promise<string> {
    if (!categoryId) return WALK_IN_LETTER;
    const categories = await tx.serviceCategory.findMany({ where: { tenantId: this.db.tenantId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }], select: { id: true } });
    const index = categories.findIndex((c) => c.id === categoryId);
    return index < 0 ? WALK_IN_LETTER : String.fromCharCode(65 + (index % 26));
  }
  private async shape(tx: Tx, rows: TokenRow[]) {
    const tenantId = this.db.tenantId;
    const categoryIds = [...new Set(rows.map((r) => r.categoryId).filter((v): v is string => !!v))];
    const staffIds = [...new Set(rows.map((r) => r.servedById).filter((v): v is string => !!v))];
    const categories = categoryIds.length ? await tx.serviceCategory.findMany({ where: { tenantId, id: { in: categoryIds } }, select: { id: true, name: true, nameAr: true } }) : [];
    const staff = staffIds.length ? await tx.tenantMembership.findMany({ where: { tenantId, id: { in: staffIds } }, select: { id: true, user: { select: { fullName: true } } } }) : [];
    const now = Date.now();
    return rows.map((r) => ({
      id: r.id,
      tokenNo: r.tokenNo,
      branchId: r.branchId,
      queueDate: r.queueDate.toISOString().slice(0, 10),
      categoryId: r.categoryId,
      categoryName: categories.find((c) => c.id === r.categoryId)?.name ?? null,
      customerId: r.customerId,
      customerName: r.customer?.fullName ?? null,
      appointmentId: r.appointmentId,
      status: r.status,
      counter: r.counter,
      servedById: r.servedById,
      servedByName: staff.find((s) => s.id === r.servedById)?.user.fullName ?? null,
      issuedAt: r.issuedAt,
      calledAt: r.calledAt,
      servedAt: r.servedAt,
      completedAt: r.completedAt,
      /** Seconds between issue and call (still counting while the person waits). */
      waitSeconds: Math.max(0, Math.round(((r.calledAt?.getTime() ?? (r.status === 'WAITING' ? now : r.issuedAt.getTime())) - r.issuedAt.getTime()) / 1000)),
    }));
  }
  private readonly include = { customer: { select: { fullName: true } } } as const;
  private async one(tx: Tx, id: string) {
    const row = found(await tx.queueToken.findFirst({ where: { id, tenantId: this.db.tenantId }, include: this.include }), 'Queue token');
    assertBranchAccess(row.branchId);
    return row;
  }

  // ------------------------------------------------------------------ tokens
  /** Issue a token. Joins the caller's transaction (appointment check-in issues one with the check-in). */
  async issue(input: IssueTokenInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const branch = await this.branch(tx, input.branchId);
      if (!branch.isActive) throw Errors.conflict('BRANCH_INACTIVE', 'This branch is not active.');
      let categoryId = input.categoryId ?? null;
      if (categoryId) found(await tx.serviceCategory.findFirst({ where: { id: categoryId, tenantId }, select: { id: true } }), 'Service category');
      else if (input.serviceId) categoryId = found(await tx.service.findFirst({ where: { id: input.serviceId, tenantId }, select: { categoryId: true } }), 'Service').categoryId;
      let customerId = input.customerId ?? null;
      await assertCustomerNotErased(tx, tenantId, customerId);
      if (customerId) found(await tx.customer.findFirst({ where: { id: customerId, tenantId, deletedAt: null }, select: { id: true } }), 'Customer');
      if (input.appointmentId) {
        const appointment = found(await tx.appointment.findFirst({ where: { id: input.appointmentId, tenantId }, select: { id: true, branchId: true, status: true, customerId: true, service: { select: { categoryId: true } } } }), 'Appointment');
        if (appointment.branchId !== branch.id) throw Errors.unprocessable('APPOINTMENT_BRANCH_MISMATCH', 'That appointment is booked at a different branch.');
        if (appointment.status !== 'CHECKED_IN') throw Errors.conflict('APPOINTMENT_NOT_CHECKED_IN', 'Check the customer in before issuing a token for the appointment.');
        const existing = await tx.queueToken.findFirst({ where: { tenantId, appointmentId: appointment.id, status: { in: ['WAITING', 'CALLED', 'SERVING'] } }, select: { tokenNo: true } });
        if (existing) throw Errors.conflict('TOKEN_EXISTS', `This appointment already has token ${existing.tokenNo}.`);
        customerId ??= appointment.customerId;
        categoryId ??= appointment.service?.categoryId ?? null;
      }
      const date = this.today(branch.timezone);
      // Gap-free per branch and day: the counter row stays locked until this transaction commits.
      const number = await this.sequences.nextValue(tx, `queue:${branch.id}:${date}`);
      const tokenNo = `${await this.letter(tx, categoryId)}-${String(number).padStart(3, '0')}`;
      const row = await tx.queueToken.create({
        data: { tenantId, branchId: branch.id, queueDate: this.dateOnly(date), tokenNo, categoryId, customerId, appointmentId: input.appointmentId ?? null },
        include: this.include,
      });
      this.touched(branch.id);
      return (await this.shape(tx, [row]))[0];
    });
  }

  async list(query: QueueListQuery) {
    return this.db.tx(async (tx) => {
      const branch = await this.branch(tx, query.branchId);
      const date = query.date ?? this.today(branch.timezone);
      const rows = await tx.queueToken.findMany({
        where: { tenantId: this.db.tenantId, branchId: branch.id, queueDate: this.dateOnly(date), ...(query.status ? { status: query.status } : {}), ...(query.categoryId ? { categoryId: query.categoryId } : {}) },
        orderBy: [{ issuedAt: 'asc' }, { tokenNo: 'asc' }],
        include: this.include,
      });
      const tokens = await this.shape(tx, rows);
      const count = (status: string) => rows.filter((r) => r.status === status).length;
      return { branchId: branch.id, date, summary: { waiting: count('WAITING'), called: count('CALLED'), serving: count('SERVING'), completed: count('COMPLETED'), noShow: count('NO_SHOW'), cancelled: count('CANCELLED') }, tokens };
    });
  }

  /**
   * Call the longest-waiting token to a counter. The row is locked with SKIP
   * LOCKED, so two counters pressing "next" at the same moment always get
   * different tokens.
   */
  async callNext(input: CallNextInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const branch = await this.branch(tx, input.branchId);
      const date = this.today(branch.timezone);
      const category = input.categoryId ? Prisma.sql`AND "categoryId" = ${input.categoryId}::uuid` : Prisma.empty;
      const next = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "queue_tokens"
        WHERE "tenantId" = ${tenantId}::uuid AND "branchId" = ${branch.id}::uuid AND "queueDate" = ${date}::date AND "status" = 'WAITING' ${category}
        ORDER BY "issuedAt" ASC, "tokenNo" ASC
        LIMIT 1 FOR UPDATE SKIP LOCKED`;
      if (!next.length) return { token: null, message: 'Nobody is waiting.' };
      const row = await tx.queueToken.update({ where: { id: next[0].id }, data: { status: 'CALLED', calledAt: new Date(), counter: input.counter, servedById: ctx().membershipId ?? null }, include: this.include });
      this.touched(branch.id);
      return { token: (await this.shape(tx, [row]))[0], message: null };
    });
  }

  private transition(id: string, allowed: string[], apply: (tx: Tx, row: TokenRow) => Promise<Prisma.QueueTokenUpdateInput>, auditAction?: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "queue_tokens" WHERE "id" = ${id}::uuid AND "tenantId" = ${tenantId}::uuid FOR UPDATE`;
      if (!locked.length) throw Errors.notFound('Queue token');
      const before = await this.one(tx, id);
      if (!allowed.includes(before.status)) {
        throw Errors.conflict('INVALID_TRANSITION', `Token ${before.tokenNo} is ${before.status.toLowerCase().replace('_', ' ')}; this action is not possible now.`, { status: before.status });
      }
      const row = await tx.queueToken.update({ where: { id }, data: await apply(tx, before), include: this.include });
      if (auditAction) await this.audit.log({ action: auditAction, resourceType: 'QueueToken', resourceId: id, summary: before.tokenNo, before: { status: before.status }, after: { status: row.status } }, tx);
      this.touched(before.branchId);
      return (await this.shape(tx, [row]))[0];
    });
  }

  /** Announce a called token again (optionally at another counter). */
  recall(id: string, counter?: string) {
    return this.transition(id, ['CALLED'], async () => ({ calledAt: new Date(), ...(counter ? { counter } : {}), servedById: ctx().membershipId ?? null }));
  }
  startServing(id: string) {
    return this.transition(id, ['CALLED'], async (tx, row) => {
      if (row.appointmentId) await tx.appointment.updateMany({ where: { id: row.appointmentId, tenantId: this.db.tenantId, status: 'CHECKED_IN' }, data: { status: 'IN_SERVICE' } });
      return { status: 'SERVING', servedAt: new Date(), servedById: ctx().membershipId ?? row.servedById };
    });
  }
  complete(id: string) {
    return this.transition(id, ['CALLED', 'SERVING'], async (tx, row) => {
      const now = new Date();
      if (row.appointmentId) await tx.appointment.updateMany({ where: { id: row.appointmentId, tenantId: this.db.tenantId, status: { in: ['CHECKED_IN', 'IN_SERVICE'] } }, data: { status: 'COMPLETED' } });
      return { status: 'COMPLETED', servedAt: row.servedAt ?? now, completedAt: now };
    });
  }
  noShow(id: string) {
    return this.transition(
      id,
      ['CALLED'],
      async (tx, row) => {
        if (row.appointmentId) await tx.appointment.updateMany({ where: { id: row.appointmentId, tenantId: this.db.tenantId, status: 'CHECKED_IN' }, data: { status: 'NO_SHOW' } });
        return { status: 'NO_SHOW', completedAt: new Date() };
      },
      'queue.token_no_show',
    );
  }
  cancel(id: string) {
    return this.transition(id, ['WAITING', 'CALLED'], async () => ({ status: 'CANCELLED', completedAt: new Date() }), 'queue.token_cancelled');
  }

  /** Counters in use today: who is at the counter and how many people each one served. */
  async counters(branchId: string) {
    return this.db.tx(async (tx) => {
      const branch = await this.branch(tx, branchId);
      const date = this.today(branch.timezone);
      const rows = await tx.queueToken.findMany({ where: { tenantId: this.db.tenantId, branchId: branch.id, queueDate: this.dateOnly(date), counter: { not: null } }, orderBy: { calledAt: 'desc' }, include: this.include });
      const tokens = await this.shape(tx, rows);
      const names = [...new Set(tokens.map((r) => r.counter!))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      return {
        branchId: branch.id,
        date,
        counters: names.map((counter) => {
          const mine = tokens.filter((r) => r.counter === counter);
          const current = mine.find((r) => r.status === 'SERVING') ?? mine.find((r) => r.status === 'CALLED') ?? null;
          return {
            counter,
            current: current ? { id: current.id, tokenNo: current.tokenNo, status: current.status, calledAt: current.calledAt, servedByName: current.servedByName } : null,
            servedToday: mine.filter((r) => r.status === 'COMPLETED').length,
            noShowsToday: mine.filter((r) => r.status === 'NO_SHOW').length,
          };
        }),
      };
    });
  }

  // ------------------------------------------------------------------ statistics
  async stats(query: QueueStatsQuery) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const branch = await this.branch(tx, query.branchId);
      const tz = safeTimeZone(branch.timezone);
      const to = query.to ?? this.today(tz);
      const from = query.from ?? new Date(this.dateOnly(to).getTime() - 29 * 86_400_000).toISOString().slice(0, 10);
      if (from > to) throw Errors.badRequest('INVALID_RANGE', 'The start date must not be after the end date.');
      const range = Prisma.sql`"tenantId" = ${tenantId}::uuid AND "branchId" = ${branch.id}::uuid AND "queueDate" BETWEEN ${from}::date AND ${to}::date`;
      const wait = Prisma.sql`EXTRACT(EPOCH FROM ("calledAt" - "issuedAt"))`;
      const service = Prisma.sql`EXTRACT(EPOCH FROM ("completedAt" - "servedAt"))`;
      const [totals] = await tx.$queryRaw<Array<Record<string, number | null>>>`
        SELECT
          count(*)::int AS "total",
          count(*) FILTER (WHERE "status" = 'COMPLETED')::int AS "completed",
          count(*) FILTER (WHERE "status" = 'NO_SHOW')::int AS "noShows",
          count(*) FILTER (WHERE "status" = 'CANCELLED')::int AS "cancelled",
          count(DISTINCT "queueDate")::int AS "days",
          (avg(${wait}) FILTER (WHERE "calledAt" IS NOT NULL))::float8 AS "waitAvg",
          (percentile_cont(0.5) WITHIN GROUP (ORDER BY ${wait}) FILTER (WHERE "calledAt" IS NOT NULL))::float8 AS "waitMedian",
          (percentile_cont(0.9) WITHIN GROUP (ORDER BY ${wait}) FILTER (WHERE "calledAt" IS NOT NULL))::float8 AS "waitP90",
          (avg(${service}) FILTER (WHERE "status" = 'COMPLETED' AND "servedAt" IS NOT NULL AND "completedAt" IS NOT NULL))::float8 AS "serviceAvg",
          (percentile_cont(0.5) WITHIN GROUP (ORDER BY ${service}) FILTER (WHERE "status" = 'COMPLETED' AND "servedAt" IS NOT NULL AND "completedAt" IS NOT NULL))::float8 AS "serviceMedian",
          (percentile_cont(0.9) WITHIN GROUP (ORDER BY ${service}) FILTER (WHERE "status" = 'COMPLETED' AND "servedAt" IS NOT NULL AND "completedAt" IS NOT NULL))::float8 AS "serviceP90"
        FROM "queue_tokens" WHERE ${range}`;
      // The ORM stores timestamps as UTC wall-clock values in the session time zone. Reading the wall clock
      // back in the session zone and declaring it UTC yields the true instant whatever that zone is.
      const hours = await tx.$queryRaw<Array<{ hour: number; count: number }>>`
        SELECT EXTRACT(HOUR FROM ((("issuedAt" AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE 'UTC') AT TIME ZONE ${tz}))::int AS "hour", count(*)::int AS "count"
        FROM "queue_tokens" WHERE ${range} GROUP BY 1 ORDER BY 1`;
      const seconds = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(Number(v)));
      const total = Number(totals.total ?? 0);
      const cancelled = Number(totals.cancelled ?? 0);
      const noShows = Number(totals.noShows ?? 0);
      const days = Math.max(1, Number(totals.days ?? 0));
      return {
        branchId: branch.id,
        from,
        to,
        timezone: tz,
        tokens: { total, completed: Number(totals.completed ?? 0), noShows, cancelled, daysWithTokens: Number(totals.days ?? 0) },
        /** Seconds from issuing the token to calling it. */
        waitSeconds: { average: seconds(totals.waitAvg), median: seconds(totals.waitMedian), p90: seconds(totals.waitP90) },
        /** Seconds from "start serving" to "complete". */
        serviceSeconds: { average: seconds(totals.serviceAvg), median: seconds(totals.serviceMedian), p90: seconds(totals.serviceP90) },
        /** Share of tokens (cancelled ones excluded) whose holder did not come when called. */
        noShowRate: total - cancelled > 0 ? Math.round((noShows / (total - cancelled)) * 1000) / 1000 : 0,
        /** Tokens issued per hour of the day (branch time), summed over the period and averaged per day with tokens. */
        tokensPerHour: hours.map((h) => ({ hour: Number(h.hour), count: Number(h.count), averagePerDay: Math.round((Number(h.count) / days) * 10) / 10 })),
      };
    });
  }

  // ------------------------------------------------------------------ public display
  private displayVersion(settings: Record<string, any>, branchId: string): number {
    const v = Number(settings?.queue?.displayVersions?.[branchId]);
    return Number.isInteger(v) && v > 0 ? v : 1;
  }
  /** Signed, long-lived token for a queue screen at one branch. */
  async createDisplayToken(input: DisplayTokenInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const branch = await this.branch(tx, input.branchId);
      const tenant = await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { settings: true } });
      const ttl = input.validDays * 86_400;
      const token = signPayload({ k: DISPLAY_KIND, t: tenantId, b: branch.id, v: this.displayVersion(tenant.settings as any, branch.id) }, ttl);
      await this.audit.log({ action: 'queue.display_token_issued', resourceType: 'Branch', resourceId: branch.id, summary: `Valid for ${input.validDays} days` }, tx);
      return {
        token,
        branchId: branch.id,
        expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
        displayUrl: `${env().API_PUBLIC_URL}/api/v1/public/queue/display?token=${encodeURIComponent(token)}`,
        streamUrl: `${env().API_PUBLIC_URL}/api/v1/public/queue/display/stream?token=${encodeURIComponent(token)}`,
      };
    });
  }
  /** Invalidate every display link issued so far for a branch (lost tablet, link shared by mistake). */
  async revokeDisplayTokens(branchId: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const branch = await this.branch(tx, branchId);
      const settings = await lockTenantSettings(tx, tenantId);
      const queue = { ...(settings.queue ?? {}), displayVersions: { ...(settings.queue?.displayVersions ?? {}), [branch.id]: this.displayVersion(settings, branch.id) + 1 } };
      await saveTenantSettingsSection(tx, tenantId, 'queue', queue);
      await this.audit.log({ action: 'queue.display_tokens_revoked', resourceType: 'Branch', resourceId: branch.id }, tx);
      this.touched(branch.id);
      return { branchId: branch.id, revoked: true };
    });
  }

  /** Signature and expiry only (no database). */
  parseDisplayToken(token: string): DisplayAccess {
    const payload = verifyPayload<{ k?: string; t?: string; b?: string; v?: number }>(token);
    if (!payload || payload.k !== DISPLAY_KIND || typeof payload.t !== 'string' || typeof payload.b !== 'string') {
      throw Errors.unauthorized('DISPLAY_TOKEN_INVALID', 'This display link is not valid or has expired. Ask the centre for a new one.');
    }
    return { tenantId: payload.t, branchId: payload.b, version: Number(payload.v ?? 1), exp: payload.exp };
  }

  /**
   * State for the public screen. Runs as the system actor inside the token's
   * tenant; row-level security keeps the query on that tenant's rows.
   */
  async displayState(access: DisplayAccess): Promise<DisplayState> {
    if (access.exp < Math.floor(Date.now() / 1000)) throw Errors.unauthorized('DISPLAY_TOKEN_INVALID', 'This display link has expired. Ask the centre for a new one.');
    return runAsTenant(
      access.tenantId,
      () =>
        this.db.tx(async (tx) => {
          const tenant = await tx.tenant.findFirst({ where: { id: access.tenantId }, select: { status: true, settings: true } });
          const branch = await tx.branch.findFirst({ where: { id: access.branchId, tenantId: access.tenantId }, select: { id: true, name: true, nameAr: true, timezone: true, isActive: true } });
          const usable = tenant && ['ONBOARDING', 'PENDING_APPROVAL', 'TRIAL', 'ACTIVE', 'PAST_DUE'].includes(tenant.status);
          if (!usable || !branch || !branch.isActive || this.displayVersion(tenant.settings as any, branch.id) !== access.version) {
            throw Errors.unauthorized('DISPLAY_TOKEN_INVALID', 'This display link is no longer valid. Ask the centre for a new one.');
          }
          const date = this.today(branch.timezone);
          const where = { tenantId: access.tenantId, branchId: branch.id, queueDate: this.dateOnly(date) };
          // Only token numbers, counters and statuses are selected: no customer columns ever leave the database here.
          const active = await tx.queueToken.findMany({ where: { ...where, status: { in: ['CALLED', 'SERVING'] } }, orderBy: [{ calledAt: 'desc' }], take: 12, select: { tokenNo: true, counter: true, status: true } });
          const waiting = await tx.queueToken.findMany({ where: { ...where, status: 'WAITING' }, orderBy: [{ issuedAt: 'asc' }, { tokenNo: 'asc' }], take: 8, select: { tokenNo: true } });
          const waitingCount = await tx.queueToken.count({ where: { ...where, status: 'WAITING' } });
          const language = (tenant!.settings as any)?.queueDisplayLanguage === 'ar' ? 'ar' : 'en';
          return {
            branch: { name: branch.name, nameAr: branch.nameAr },
            date,
            language,
            nowServing: active.map((a) => ({ tokenNo: a.tokenNo, counter: a.counter, status: a.status as 'CALLED' | 'SERVING' })),
            nextUp: waiting.map((w) => w.tokenNo),
            waitingCount,
            generatedAt: new Date().toISOString(),
          };
        }),
      { actorLabel: 'queue-display' },
    );
  }

  get activeStreams() {
    return this.streams.size;
  }
  /**
   * Server-Sent Events for a display. Sends the state at once, then whenever it
   * changes (database poll every few seconds plus an in-process nudge), with a
   * heartbeat in between. Everything is released when `close()` is called.
   */
  async openDisplayStream(access: DisplayAccess, write: (chunk: string) => void, end: () => void): Promise<{ close: () => void }> {
    const first = await this.displayState(access); // invalid links fail here, before any stream is opened
    const key = `${access.tenantId}:${access.branchId}`;
    let closed = false;
    let busy = false;
    let last = '';
    const fingerprint = (s: DisplayState) => JSON.stringify({ ...s, generatedAt: undefined });
    const send = (state: DisplayState) => {
      last = fingerprint(state);
      write(`event: queue\ndata: ${JSON.stringify(state)}\n\n`);
    };
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(poll);
      clearInterval(beat);
      clearTimeout(ttl);
      this.changes.off(key, refresh);
      this.streams.delete(close);
      end();
    };
    const refresh = async () => {
      if (closed || busy) return;
      busy = true;
      try {
        const state = await this.displayState(access);
        if (!closed && fingerprint(state) !== last) send(state);
      } catch (e: any) {
        if (e?.code === 'DISPLAY_TOKEN_INVALID' && !closed) {
          write('event: expired\ndata: {}\n\n');
          close();
        } else this.logger.warn(`queue display refresh failed: ${e?.message ?? e}`);
      } finally {
        busy = false;
      }
    };
    this.streams.add(close);
    write('retry: 5000\n\n');
    send(first);
    const poll = setInterval(() => void refresh(), POLL_MS);
    const beat = setInterval(() => !closed && write(': keep-alive\n\n'), HEARTBEAT_MS);
    // Screens reconnect by themselves; a bounded lifetime keeps abandoned connections from piling up.
    const ttl = setTimeout(close, MAX_STREAM_MS);
    this.changes.on(key, refresh);
    return { close };
  }
}
