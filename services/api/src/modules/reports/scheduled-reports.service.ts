import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import type { CreateScheduledReportInput, ReportQuery, ScheduledReportListQuery, ScheduledReportParams, ScheduledReportRunsQuery, UpdateScheduledReportInput } from '@typease/validation';
import type { ScheduledReport } from '@typease/database';
import { env } from '../../config/env';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { AppError, Errors, found } from '../../common/errors';
import { JobQueue } from '../../common/jobs/job-queue';
import { Messenger } from '../../common/messenger';
import { DocumentStorePort } from '../../common/ports';
import { assertBranchAccess, branchFilter } from '../../common/scope';
import { TenantDirectory } from '../../common/tenant-directory';
import { UsageService } from '../../common/usage.service';
import { ReportDefinition } from './report.types';
import { ExportFormat, ReportsService } from './reports.service';
import { DEFAULT_TIMING, nextRunAfter, periodLabel, safeTimeZone, ScheduleTiming } from './time';

export const SCHEDULED_JOB = 'reports.scheduled';
const RUN_ACTION = 'report.scheduled_run';
/** Owner key of the generated files in the document vault (DocumentStorePort `restrictedTo`). */
export const REPORT_FILE_OWNER = 'scheduled-report';
const REPORT_FILE_TITLE_PREFIX = 'Scheduled report: ';
/** A run that fails is tried again on the next ticks; after this many failures the occurrence is given up. */
const MAX_FAILURES_PER_OCCURRENCE = 3;
const RUN_TIMEOUT_MS = 90_000;

interface StoredParams {
  filters: ScheduledReportParams;
  timing: { timeOfDay: string; weekday: number; dayOfMonth: number };
  /** Consecutive failures of the occurrence that is due. */
  failures?: number;
}
interface Recipient {
  email: string;
  name: string;
  language: string;
  financial: boolean;
  customerNames: boolean;
}
interface RecipientProblem {
  email: string;
  code: 'NOT_ACTIVE_STAFF' | 'NO_REPORT_PERMISSION' | 'NO_BRANCH_ACCESS';
  message: string;
}

const stored = (row: Pick<ScheduledReport, 'params'>): StoredParams => {
  const p = (row.params ?? {}) as Partial<StoredParams>;
  return { filters: (p.filters ?? { range: 'yesterday' }) as ScheduledReportParams, timing: { ...DEFAULT_TIMING, ...(p.timing ?? {}) }, failures: p.failures ?? 0 };
};
const timingOf = (row: Pick<ScheduledReport, 'params' | 'frequency'>): ScheduleTiming => ({ frequency: row.frequency as ScheduleTiming['frequency'], ...stored(row).timing });

/**
 * Scheduled reports: a report key, a relative period, a format and a rhythm.
 * The job `reports.scheduled` generates the file when it is due, files it in
 * the centre's document vault (never customer visible) and emails each
 * recipient a link to the centre application - never the file itself.
 */
@Injectable()
export class ScheduledReportsService implements OnModuleInit {
  private readonly logger = new Logger(ScheduledReportsService.name);

  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly jobs: JobQueue,
    private readonly tenants: TenantDirectory,
    private readonly usage: UsageService,
    private readonly messenger: Messenger,
    private readonly reports: ReportsService,
    @Optional() private readonly documentStore?: DocumentStorePort,
  ) {}

  onModuleInit() {
    this.jobs.register(
      SCHEDULED_JOB,
      async (payload: { now?: string }) => {
        const result = await this.tenants.forEachTenant(SCHEDULED_JOB, async () => void (await this.runDue(payload?.now ? new Date(payload.now) : new Date())));
        if (result.failed) this.logger.warn(`${SCHEDULED_JOB}: ${result.failed} tenant(s) failed, ${result.ok} ok`);
      },
      { attempts: 1 },
    );
    this.jobs.schedule({ name: SCHEDULED_JOB, everySeconds: 900, description: 'Generate scheduled reports that are due and notify their recipients' });
  }

  // ------------------------------------------------------------------ helpers
  private async timeZone(tx: Tx): Promise<string> {
    return safeTimeZone((await tx.tenant.findFirstOrThrow({ where: { id: this.db.tenantId }, select: { timezone: true } })).timezone);
  }
  private shape(row: ScheduledReport, timeZone: string) {
    const p = stored(row);
    const def = this.reports.find(row.reportKey);
    return {
      id: row.id,
      reportKey: row.reportKey,
      reportTitle: def?.title ?? row.reportKey,
      params: p.filters,
      format: row.format,
      frequency: row.frequency,
      timeOfDay: p.timing.timeOfDay,
      weekday: row.frequency === 'WEEKLY' ? p.timing.weekday : null,
      dayOfMonth: row.frequency === 'MONTHLY' ? p.timing.dayOfMonth : null,
      timeZone,
      recipients: row.recipients,
      isActive: row.isActive,
      nextRunAt: row.isActive ? row.nextRunAt : null,
      lastRunAt: row.lastRunAt,
      lastStatus: row.lastStatus,
      createdById: row.createdById,
      createdAt: row.createdAt,
      link: `${env().CENTRE_WEB_URL}/reports/scheduled/${row.id}`,
    };
  }

  /** A schedule the caller may see: they hold the report's permission and may see its branch scope. */
  private async load(tx: Tx, id: string): Promise<{ row: ScheduledReport; def: ReportDefinition }> {
    const row = found(await tx.scheduledReport.findFirst({ where: { id, tenantId: this.db.tenantId } }), 'Scheduled report');
    const def = this.reports.definition(row.reportKey);
    const mine = branchFilter()?.in;
    if (mine && def.branchScoped) {
      const branchId = stored(row).filters.branchId;
      // A schedule over all branches, or over another branch, does not exist for a member limited to their own.
      if (!branchId || !mine.includes(branchId)) throw Errors.notFound('Scheduled report');
    }
    return { row, def };
  }

  /** Filters must point at rows of this centre, and at branches the author may see. */
  private async assertFilters(tx: Tx, def: ReportDefinition, filters: ScheduledReportParams): Promise<void> {
    const tenantId = this.db.tenantId;
    if (def.branchScoped) {
      if (filters.branchId) {
        found(await tx.branch.findFirst({ where: { id: filters.branchId, tenantId }, select: { id: true } }), 'Branch');
        assertBranchAccess(filters.branchId);
      } else if (branchFilter()) {
        throw Errors.unprocessable('BRANCH_REQUIRED', 'You work at specific branches, so choose the branch this report is for.');
      }
    }
    if (filters.serviceId) found(await tx.service.findFirst({ where: { id: filters.serviceId, tenantId }, select: { id: true } }), 'Service');
    if (filters.corporateAccountId) found(await tx.corporateAccount.findFirst({ where: { id: filters.corporateAccountId, tenantId }, select: { id: true } }), 'Corporate account');
  }

  /**
   * Who may receive a report: ACTIVE staff members of this centre whose role
   * holds the report's permission and who may see the branch scope of the
   * schedule. Nobody else - no external addresses, no customers.
   */
  private async resolveRecipients(tx: Tx, emails: string[], def: ReportDefinition, branchId: string | undefined): Promise<{ eligible: Recipient[]; problems: RecipientProblem[] }> {
    const members = await tx.tenantMembership.findMany({
      where: { tenantId: this.db.tenantId, kind: 'STAFF', status: 'ACTIVE', user: { email: { in: emails } } },
      select: {
        allBranches: true,
        membershipBranches: { select: { branchId: true } },
        user: { select: { email: true, fullName: true, preferredLanguage: true, status: true, deletedAt: true } },
        role: { select: { rolePermissions: { select: { permissionKey: true } } } },
      },
    });
    const eligible: Recipient[] = [];
    const problems: RecipientProblem[] = [];
    for (const email of emails) {
      const member = members.find((m) => m.user.email === email && m.user.status === 'ACTIVE' && !m.user.deletedAt);
      if (!member) {
        problems.push({ email, code: 'NOT_ACTIVE_STAFF', message: `${email} is not an active staff member of your centre. Scheduled reports can only be sent to your own staff.` });
        continue;
      }
      const permissions = new Set(member.role.rolePermissions.map((p) => p.permissionKey));
      if (!permissions.has(def.permission)) {
        problems.push({ email, code: 'NO_REPORT_PERMISSION', message: `${member.user.fullName} is not allowed to view ${def.permission === 'report.financial' ? 'financial' : 'operational'} reports.` });
        continue;
      }
      if (def.branchScoped && !member.allBranches && (!branchId || !member.membershipBranches.some((b) => b.branchId === branchId))) {
        problems.push({ email, code: 'NO_BRANCH_ACCESS', message: `${member.user.fullName} only works at specific branches and may not see ${branchId ? 'that branch' : 'a report over all branches'}.` });
        continue;
      }
      eligible.push({ email, name: member.user.fullName, language: member.user.preferredLanguage, financial: permissions.has('report.financial'), customerNames: permissions.has('customer.read') });
    }
    return { eligible, problems };
  }
  private async assertRecipients(tx: Tx, emails: string[], def: ReportDefinition, branchId: string | undefined): Promise<void> {
    const { problems } = await this.resolveRecipients(tx, emails, def, branchId);
    if (problems.length) throw Errors.unprocessable('INVALID_RECIPIENTS', problems[0].message, { recipients: problems });
  }

  // ------------------------------------------------------------------ CRUD
  async list(query: ScheduledReportListQuery) {
    return this.db.tx(async (tx) => {
      const timeZone = await this.timeZone(tx);
      const rows = await tx.scheduledReport.findMany({ where: { tenantId: this.db.tenantId, ...(query.reportKey ? { reportKey: query.reportKey } : {}) }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] });
      // Row-level rules (report permission, branch scope) are not expressible in SQL here: the table is small, so filter after loading.
      const visible: ScheduledReport[] = [];
      for (const row of rows) {
        try {
          await this.load(tx, row.id);
          visible.push(row);
        } catch (e) {
          if (!(e instanceof AppError)) throw e;
        }
      }
      const start = (query.page - 1) * query.pageSize;
      return { data: visible.slice(start, start + query.pageSize).map((r) => this.shape(r, timeZone)), meta: { page: query.page, pageSize: query.pageSize, total: visible.length, totalPages: Math.max(1, Math.ceil(visible.length / query.pageSize)) } };
    });
  }

  async get(id: string) {
    return this.db.tx(async (tx) => this.shape((await this.load(tx, id)).row, await this.timeZone(tx)));
  }

  async create(input: CreateScheduledReportInput) {
    const def = this.reports.definition(input.reportKey);
    return this.db.tx(async (tx) => {
      await this.usage.assertFeature('scheduledReports', tx);
      await this.assertFilters(tx, def, input.params);
      await this.assertRecipients(tx, input.recipients, def, input.params.branchId);
      const timeZone = await this.timeZone(tx);
      const timing = { timeOfDay: input.timeOfDay ?? DEFAULT_TIMING.timeOfDay, weekday: input.weekday ?? DEFAULT_TIMING.weekday, dayOfMonth: input.dayOfMonth ?? DEFAULT_TIMING.dayOfMonth };
      const params: StoredParams = { filters: input.params, timing, failures: 0 };
      const row = await tx.scheduledReport.create({
        data: {
          tenantId: this.db.tenantId, reportKey: def.key, params: params as object, format: input.format, frequency: input.frequency, recipients: input.recipients, isActive: input.isActive,
          nextRunAt: nextRunAfter({ frequency: input.frequency, ...timing }, new Date(), timeZone), createdById: ctx().userId ?? null,
        },
      });
      await this.audit.log({ action: 'report.schedule_created', resourceType: 'ScheduledReport', resourceId: row.id, summary: `${def.title}: ${input.frequency.toLowerCase()} ${input.format}`, after: { reportKey: def.key, params: input.params, timing, format: input.format, frequency: input.frequency, recipients: input.recipients, isActive: input.isActive } }, tx);
      return this.shape(row, timeZone);
    });
  }

  async update(id: string, input: UpdateScheduledReportInput) {
    return this.db.tx(async (tx) => {
      const { row: before, def } = await this.load(tx, id);
      const current = stored(before);
      const filters = input.params ?? current.filters;
      const recipients = input.recipients ?? before.recipients;
      const frequency = (input.frequency ?? before.frequency) as ScheduleTiming['frequency'];
      const timing = { timeOfDay: input.timeOfDay ?? current.timing.timeOfDay, weekday: input.weekday ?? current.timing.weekday, dayOfMonth: input.dayOfMonth ?? current.timing.dayOfMonth };
      const isActive = input.isActive ?? before.isActive;
      // Switching a schedule off (and nothing else) is always possible, also after a downgrade of the plan.
      const onlyDeactivating = input.isActive === false && Object.keys(input).length === 1;
      if (!onlyDeactivating) {
        await this.usage.assertFeature('scheduledReports', tx);
        await this.assertFilters(tx, def, filters);
        await this.assertRecipients(tx, recipients, def, filters.branchId);
      }
      const timeZone = await this.timeZone(tx);
      const rescheduled = frequency !== before.frequency || JSON.stringify(timing) !== JSON.stringify(current.timing) || (isActive && !before.isActive);
      const params: StoredParams = { filters, timing, failures: rescheduled ? 0 : current.failures };
      const row = await tx.scheduledReport.update({
        where: { id },
        data: { params: params as object, format: input.format ?? before.format, frequency, recipients, isActive, ...(rescheduled ? { nextRunAt: nextRunAfter({ frequency, ...timing }, new Date(), timeZone) } : {}) },
      });
      await this.audit.log(
        {
          action: 'report.schedule_updated', resourceType: 'ScheduledReport', resourceId: id, summary: def.title,
          before: { params: current.filters, timing: current.timing, format: before.format, frequency: before.frequency, recipients: before.recipients, isActive: before.isActive },
          after: { params: filters, timing, format: row.format, frequency, recipients, isActive },
        },
        tx,
      );
      return this.shape(row, timeZone);
    });
  }

  async remove(id: string) {
    return this.db.tx(async (tx) => {
      const { row, def } = await this.load(tx, id);
      await tx.scheduledReport.delete({ where: { id } });
      await this.audit.log({ action: 'report.schedule_deleted', resourceType: 'ScheduledReport', resourceId: id, summary: def.title, before: { reportKey: row.reportKey, frequency: row.frequency, recipients: row.recipients } }, tx);
      return { id, status: 'DELETED' as const };
    });
  }

  /**
   * The files this schedule produced, newest first. Each entry names the vault
   * document; the file itself is fetched with `downloadLink()` below, under the
   * rule of the schedule (the report's permission and the branch scope). The
   * general document endpoints do not serve these files.
   */
  async runs(id: string, query: ScheduledReportRunsQuery) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const { def } = await this.load(tx, id);
      const where = { tenantId, resourceType: 'ScheduledReport', resourceId: id, action: RUN_ACTION };
      const [logs, total] = [await tx.auditLog.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }), await tx.auditLog.count({ where })];
      const documentIds = logs.map((l) => (l.after as Record<string, any> | null)?.documentId).filter((v): v is string => typeof v === 'string');
      const documents = documentIds.length
        ? await tx.document.findMany({ where: { tenantId, id: { in: documentIds } }, select: { id: true, title: true, status: true, currentVersionId: true, documentVersions: { select: { id: true, originalFilename: true, sizeBytes: true, detectedMime: true } } } })
        : [];
      const data = logs.map((log) => {
        const a = (log.after ?? {}) as Record<string, any>;
        const doc = documents.find((d) => d.id === a.documentId);
        const version = doc?.documentVersions.find((v) => v.id === doc.currentVersionId);
        return {
          ranAt: log.createdAt,
          dueAt: a.dueAt ?? null,
          status: a.status ?? 'SUCCESS',
          detail: a.detail ?? null,
          period: a.periodFrom ? { from: a.periodFrom, to: a.periodTo } : null,
          format: a.format ?? null,
          rows: a.rows ?? null,
          recipients: a.recipients ?? [],
          documentId: doc ? doc.id : null,
          document: doc && version ? { id: doc.id, title: doc.title, filename: version.originalFilename, mime: version.detectedMime, sizeBytes: Number(version.sizeBytes), available: doc.status === 'AVAILABLE' } : null,
        };
      });
      return { data, meta: { page: query.page, pageSize: query.pageSize, total, totalPages: Math.max(1, Math.ceil(total / query.pageSize)) }, download: { method: 'POST', path: `/reports/scheduled/${id}/runs/:documentId/download-link`, permission: def.permission } };
    });
  }

  /**
   * Short-lived link to one generated file. Who may fetch it is decided here, not by the document vault:
   * the caller must hold the permission of the report (`report.financial` / `report.operational`, exactly as
   * for running it on demand) and may see the branch scope of the schedule. Holding `document.read` is
   * neither needed nor enough. Audited, and written to the document access log.
   */
  async downloadLink(id: string, documentId: string) {
    if (!this.documentStore) throw Errors.notConfigured('Document storage', 'The documents module is not loaded in this installation, so report files cannot be downloaded.');
    const store = this.documentStore;
    const reportTitle = await this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const { row, def } = await this.load(tx, id);
      // The file must be a run of THIS schedule: the run log is written by the job only and cannot be edited.
      const run = await tx.auditLog.findFirst({ where: { tenantId, resourceType: 'ScheduledReport', resourceId: id, action: RUN_ACTION, after: { path: ['documentId'], equals: documentId } }, select: { id: true } });
      if (!run) throw Errors.notFound('Report file');
      // Files stored before report files were restricted are taken out of the general document rules now.
      await store.restrictGenerated([documentId], REPORT_FILE_OWNER);
      await this.audit.log({ action: 'report.scheduled_file_downloaded', resourceType: 'ScheduledReport', resourceId: id, summary: def.title, after: { documentId, reportKey: row.reportKey } }, tx);
      return def.title;
    });
    const link = await store.restrictedDownloadLink(documentId, REPORT_FILE_OWNER);
    return { ...link, reportTitle };
  }

  // ------------------------------------------------------------------ job (one tenant)
  /** Runs every schedule of the current tenant that is due. One failing schedule never stops the others. */
  async runDue(now = new Date()): Promise<{ due: number; generated: number; failed: number }> {
    const tenantId = this.db.tenantId;
    await this.restrictLegacyFiles().catch((e) => this.logger.error(`could not restrict earlier report files: ${e?.message ?? e}`));
    const due = await this.db.tx((tx) => tx.scheduledReport.findMany({ where: { tenantId, isActive: true, nextRunAt: { lte: now } }, select: { id: true }, orderBy: [{ nextRunAt: 'asc' }, { id: 'asc' }], take: 200 }));
    let generated = 0;
    let failed = 0;
    for (const { id } of due) {
      try {
        if (await this.runOne(id, now)) generated += 1;
      } catch (e: any) {
        failed += 1;
        this.logger.warn(`scheduled report ${id} failed: ${e?.message ?? e}`);
        await this.recordFailure(id, now, e).catch((inner) => this.logger.error(`could not record the failure of scheduled report ${id}: ${inner?.message ?? inner}`));
      }
    }
    return { due: due.length, generated, failed };
  }

  /**
   * Report files generated before they were restricted sat in the vault as ordinary documents, readable by
   * every holder of `document.read`. Each tick takes the ones that the run log proves to be report files out
   * of the general rules. Normally there is nothing to do (one indexed query).
   */
  async restrictLegacyFiles(): Promise<number> {
    if (!this.documentStore) return 0;
    const store = this.documentStore;
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const candidates = await tx.document.findMany({
        where: { tenantId, category: null, customerId: null, corporateAccountId: null, requestId: null, title: { startsWith: REPORT_FILE_TITLE_PREFIX } },
        select: { id: true },
        take: 500,
      });
      if (!candidates.length) return 0;
      const proven: string[] = [];
      for (const { id } of candidates) {
        const run = await tx.auditLog.findFirst({ where: { tenantId, resourceType: 'ScheduledReport', action: RUN_ACTION, after: { path: ['documentId'], equals: id } }, select: { id: true } });
        if (run) proven.push(id);
      }
      return store.restrictGenerated(proven, REPORT_FILE_OWNER);
    });
  }

  private async lock(tx: Tx, id: string): Promise<ScheduledReport | null> {
    const tenantId = this.db.tenantId;
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "scheduled_reports" WHERE "id" = ${id}::uuid AND "tenantId" = ${tenantId}::uuid FOR UPDATE`;
    return rows.length ? tx.scheduledReport.findFirst({ where: { id, tenantId } }) : null;
  }

  /**
   * One occurrence, in one transaction with the schedule row locked: the file
   * is stored, the run is recorded and `nextRunAt` moves on together, so the
   * same due time can never produce two files, however often the job runs.
   * Emails go out after the commit.
   */
  async runOne(id: string, now = new Date()): Promise<boolean> {
    const outcome = await this.db.tx(
      async (tx) => {
        const row = await this.lock(tx, id);
        if (!row || !row.isActive || row.nextRunAt.getTime() > now.getTime()) return null; // already handled
        const p = stored(row);
        const timeZone = await this.timeZone(tx);
        const dueAt = row.nextRunAt;
        const next = nextRunAfter(timingOf(row), now.getTime() > dueAt.getTime() ? now : dueAt, timeZone);
        const finish = async (status: 'SUCCESS' | 'SKIPPED' | 'FAILED', detail: string | null, after: Record<string, unknown> = {}) => {
          await tx.scheduledReport.update({ where: { id }, data: { lastRunAt: now, lastStatus: detail ? `${status}: ${detail}`.slice(0, 300) : status, nextRunAt: next, params: { ...p, failures: 0 } as object } });
          await this.audit.log({ action: RUN_ACTION, resourceType: 'ScheduledReport', resourceId: id, summary: `${row.reportKey}: ${status.toLowerCase()}`, after: { status, detail, dueAt: dueAt.toISOString(), format: row.format, ...after } }, tx);
        };

        if (!(await this.usage.hasFeature('scheduledReports', tx))) {
          await finish('SKIPPED', 'Scheduled reports are not included in the current plan.');
          return null;
        }
        const def = this.reports.find(row.reportKey);
        if (!def) {
          await finish('FAILED', 'This report no longer exists.');
          return null;
        }
        const { eligible, problems } = await this.resolveRecipients(tx, row.recipients, def, p.filters.branchId);
        if (!eligible.length) {
          await finish('FAILED', 'None of the recipients is an active staff member who may view this report.', { skippedRecipients: problems.map((x) => ({ email: x.email, code: x.code })) });
          return null;
        }
        if (!this.documentStore) throw Errors.notConfigured('Document storage', 'The documents module is not loaded in this installation, so the report file cannot be stored.');

        // The period is relative to the moment the run was due, so a late run still reports the intended period.
        const rc = await this.reports.context(tx, def, { ...p.filters } as ReportQuery, { financial: eligible.every((r) => r.financial), customerNames: eligible.every((r) => r.customerNames) }, { now: dueAt });
        const format = row.format.toLowerCase() as ExportFormat;
        const { file, rowCount } = await this.reports.render(tx, def, rc, format);
        const label = def.asOfNow ? `as of ${rc.today}` : periodLabel(rc.period.from, rc.period.to);
        const document = await this.documentStore.storeGenerated({ documentTypeKey: 'other', title: `${REPORT_FILE_TITLE_PREFIX}${def.title} (${label})`, filename: file.filename, mime: file.mime, content: file.content, customerVisible: false, restrictedTo: REPORT_FILE_OWNER });
        await finish('SUCCESS', problems.length ? `${problems.length} recipient(s) skipped` : null, {
          documentId: document.documentId, periodFrom: def.asOfNow ? null : rc.period.from, periodTo: def.asOfNow ? null : rc.period.to, rows: rowCount, sizeBytes: file.content.length,
          recipients: eligible.map((r) => r.email), skippedRecipients: problems.map((x) => ({ email: x.email, code: x.code })),
        });
        return { eligible, title: def.title, label };
      },
      { timeoutMs: RUN_TIMEOUT_MS },
    );
    if (!outcome) return false;
    const tenantId = this.db.tenantId;
    for (const recipient of outcome.eligible) {
      // A link to the centre application (sign-in required). The file is never attached and never linked directly.
      await this.messenger
        .send({
          eventKey: 'report.scheduled', channel: 'EMAIL', to: recipient.email, language: recipient.language, tenantId,
          data: { name: recipient.name, reportName: outcome.title, periodLabel: outcome.label, centreLink: `${env().CENTRE_WEB_URL}/reports/scheduled/${id}` },
        })
        .catch((e) => this.logger.error(`scheduled report ${id}: the notification to a recipient could not be queued: ${e?.message ?? e}`));
    }
    return true;
  }

  /** A run that threw: retried on the next ticks, then given up for this occurrence so the schedule keeps its rhythm. */
  private async recordFailure(id: string, now: Date, error: unknown): Promise<void> {
    const message = String((error as any)?.message ?? error).slice(0, 240);
    await this.db.tx(async (tx) => {
      const row = await this.lock(tx, id);
      if (!row || !row.isActive || row.nextRunAt.getTime() > now.getTime()) return;
      const p = stored(row);
      const failures = (p.failures ?? 0) + 1;
      const giveUp = failures >= MAX_FAILURES_PER_OCCURRENCE;
      const next = giveUp ? nextRunAfter(timingOf(row), now, await this.timeZone(tx)) : row.nextRunAt;
      await tx.scheduledReport.update({ where: { id }, data: { lastRunAt: now, lastStatus: `FAILED: ${message}`.slice(0, 300), nextRunAt: next, params: { ...p, failures: giveUp ? 0 : failures } as object } });
      await this.audit.log(
        { action: RUN_ACTION, resourceType: 'ScheduledReport', resourceId: id, summary: `${row.reportKey}: failed`, after: { status: 'FAILED', detail: message, dueAt: row.nextRunAt.toISOString(), format: row.format, attempt: failures, willRetry: !giveUp } },
        tx,
      );
    });
  }
}
