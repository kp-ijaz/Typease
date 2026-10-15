import { Injectable } from '@nestjs/common';
import type { ReportDrilldownQuery, ReportExportQuery, ReportQuery } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { can } from '../../common/context';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { assertBranchAccess, branchFilter } from '../../common/scope';
import { BrandingService } from '../tenancy/branding.service';
import { financialReports } from './definitions/financial.reports';
import { operationalReports } from './definitions/operational.reports';
import { buildPdf, PdfBrand } from './export/pdf';
import { buildCsv } from './export/sanitise';
import { buildXlsx, ExportModel } from './export/xlsx';
import { FinanceMetrics } from './finance-metrics.service';
import { ReportContext, ReportDefinition, ReportOutput, ReportViewer } from './report.types';
import { daysBetween, firstOfMonth, localYmd, period, periodLabel, relativeRange, safeTimeZone } from './time';

export type ExportFormat = 'xlsx' | 'pdf' | 'csv';
export interface ReportFile {
  filename: string;
  mime: string;
  content: Buffer;
}
const MIME: Record<ExportFormat, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  csv: 'text/csv; charset=utf-8',
};
/** Longest period of a report without its own limit (five years). */
const MAX_DAYS = 1830;
const REPORT_TIMEOUT_MS = 60_000;

const FILTER_LABELS: Record<string, string> = {
  serviceId: 'Service', customerId: 'Customer', corporateAccountId: 'Corporate account', membershipId: 'Staff member', requestId: 'Request', status: 'Status', component: 'Fee component',
  documentTypeKey: 'Document type', kind: 'List', rating: 'Rating', withinDays: 'Days ahead', bucket: 'Ageing bucket', date: 'Day', month: 'Month',
};

/**
 * The report registry and everything that runs a report: the JSON view, the
 * drill-down and the file exports. A report is a pure read: it runs in one
 * tenant transaction, scoped to the branches the viewer may see.
 */
@Injectable()
export class ReportsService {
  private readonly definitions: ReportDefinition[];

  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly branding: BrandingService,
    metrics: FinanceMetrics,
  ) {
    this.definitions = [...financialReports(metrics), ...operationalReports(metrics)];
  }

  // ------------------------------------------------------------------ registry
  all(): ReportDefinition[] {
    return this.definitions;
  }
  find(key: string): ReportDefinition | undefined {
    return this.definitions.find((d) => d.key === key);
  }
  /** The report, if it exists and the caller holds its permission. */
  definition(key: string): ReportDefinition {
    const def = found(this.find(key), 'Report');
    if (!can(def.permission)) throw Errors.forbidden('FORBIDDEN', def.permission === 'report.financial' ? 'Financial reports are only available to people with the "View financial reports" permission.' : 'You do not have permission to view this report.');
    return def;
  }
  describe(def: ReportDefinition) {
    return {
      key: def.key,
      title: def.title,
      description: def.description,
      category: def.category,
      permission: def.permission,
      parameters: def.parameters,
      hasDrilldown: !!def.drilldown,
      asOfNow: !!def.asOfNow,
      branchScoped: def.branchScoped,
    };
  }
  /** What the caller may run. */
  list() {
    const exportable = can('report.export');
    return {
      canExport: exportable,
      exportFormats: exportable ? (['xlsx', 'pdf', 'csv'] as ExportFormat[]) : [],
      reports: this.definitions.filter((d) => can(d.permission)).map((d) => this.describe(d)),
    };
  }

  viewer(): ReportViewer {
    return { financial: can('report.financial'), customerNames: can('customer.read') };
  }

  // ------------------------------------------------------------------ context
  /**
   * Resolves "for whom, where and when" once, for every report:
   *  - the period, in the centre's time zone (explicit dates, a relative range, or the report's default);
   *  - the branches: an explicit branch must be one the caller may see, otherwise the caller's own branches.
   */
  async context(tx: Tx, def: ReportDefinition, filters: ReportQuery, viewer: ReportViewer, options: { now?: Date } = {}): Promise<ReportContext> {
    const tenantId = this.db.tenantId;
    const tenant = await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { name: true, timezone: true, defaultCurrency: true } });
    const timeZone = safeTimeZone(tenant.timezone);
    const now = options.now ?? new Date();
    const today = localYmd(now, timeZone);

    let range: { from: string; to: string };
    if (filters.range) range = relativeRange(filters.range, today);
    else if (filters.from || filters.to) {
      const to = filters.to ?? (filters.from && filters.from > today ? filters.from : today);
      range = { from: filters.from ?? firstOfMonth(to), to };
    } else range = def.defaultPeriod?.(today) ?? { from: firstOfMonth(today), to: today };
    if (range.from > range.to) throw Errors.unprocessable('INVALID_PERIOD', 'The start date must not be after the end date.');
    const limit = def.maxDays ?? MAX_DAYS;
    if (!def.asOfNow && daysBetween(range.from, range.to) + 1 > limit) {
      throw Errors.unprocessable('PERIOD_TOO_LONG', `This report covers at most ${limit} days. Choose a shorter period.`, { maxDays: limit });
    }

    let branchIds: string[] | null = null;
    if (def.branchScoped) {
      if (filters.branchId) {
        found(await tx.branch.findFirst({ where: { id: filters.branchId, tenantId }, select: { id: true } }), 'Branch');
        assertBranchAccess(filters.branchId);
        branchIds = [filters.branchId];
      } else branchIds = branchFilter()?.in ?? null;
    }
    return { tenantId, tenantName: tenant.name, timeZone, currency: tenant.defaultCurrency, today, now, period: period(range.from, range.to, timeZone), branchIds, viewer, filters };
  }

  private envelope(def: ReportDefinition, rc: ReportContext, out: ReportOutput) {
    return {
      ...this.describe(def),
      generatedAt: rc.now.toISOString(),
      timeZone: rc.timeZone,
      currency: rc.currency,
      period: def.asOfNow ? { asOf: rc.now.toISOString(), from: null, to: null } : { from: rc.period.from, to: rc.period.to },
      branchIds: rc.branchIds,
      filters: Object.fromEntries(Object.entries(rc.filters).filter(([k, v]) => v !== undefined && !['from', 'to', 'range', 'branchId', 'page', 'pageSize', 'format'].includes(k))),
      columns: out.columns,
      rows: out.rows,
      totals: out.totals ?? null,
      chart: out.chart ?? null,
      notes: out.notes,
    };
  }

  // ------------------------------------------------------------------ run / drill-down
  async run(key: string, query: ReportQuery) {
    const def = this.definition(key);
    return this.db.tx(
      async (tx) => {
        const rc = await this.context(tx, def, query, this.viewer());
        return this.envelope(def, rc, await def.run(tx, rc));
      },
      { timeoutMs: REPORT_TIMEOUT_MS },
    );
  }

  /** The records behind a report, with their ids, a page at a time. */
  async drilldown(key: string, query: ReportDrilldownQuery) {
    const def = this.definition(key);
    if (!def.drilldown) throw Errors.unprocessable('NO_DRILLDOWN', 'This report has no drill-down: its rows already are the individual records.');
    const { page, pageSize, ...filters } = query;
    return this.db.tx(
      async (tx) => {
        const rc = await this.context(tx, def, filters, this.viewer());
        const out = await def.drilldown!(tx, rc, { skip: (page - 1) * pageSize, take: pageSize });
        return {
          key: def.key,
          title: def.title,
          period: def.asOfNow ? { asOf: rc.now.toISOString(), from: null, to: null } : { from: rc.period.from, to: rc.period.to },
          columns: out.columns,
          rows: out.rows,
          notes: out.notes ?? [],
          meta: { page, pageSize, total: out.total, totalPages: Math.max(1, Math.ceil(out.total / pageSize)) },
        };
      },
      { timeoutMs: REPORT_TIMEOUT_MS },
    );
  }

  // ------------------------------------------------------------------ files
  private async parameterLines(tx: Tx, def: ReportDefinition, rc: ReportContext): Promise<Array<[string, string]>> {
    const lines: Array<[string, string]> = [];
    lines.push(['Period', def.asOfNow ? `As of ${rc.now.toISOString().slice(0, 16).replace('T', ' ')} UTC` : periodLabel(rc.period.from, rc.period.to)]);
    if (!def.branchScoped) lines.push(['Branch', 'Whole centre (this report is not kept per branch)']);
    else if (!rc.branchIds) lines.push(['Branch', 'All branches']);
    else {
      const names = await tx.branch.findMany({ where: { tenantId: rc.tenantId, id: { in: rc.branchIds } }, select: { name: true }, orderBy: { name: 'asc' } });
      lines.push(['Branch', names.map((b) => b.name).join(', ') || 'No branch']);
    }
    for (const [k, v] of Object.entries(rc.filters)) if (v !== undefined && FILTER_LABELS[k]) lines.push([FILTER_LABELS[k], String(v)]);
    return lines;
  }

  async pdfBrand(tenantId: string, fallbackName: string): Promise<PdfBrand> {
    try {
      const config = await this.branding.publicConfig(tenantId);
      return { name: config.name, colors: config.colors, supportEmail: config.supportEmail, supportPhone: config.supportPhone, poweredBy: config.mode !== 'WHITE_LABEL' };
    } catch {
      return { name: fallbackName, colors: { primary: '#0B2240', secondary: '#0B7AD1', accent: '#F59E0B' }, poweredBy: true };
    }
  }

  /** Runs a report and renders it as a file. No permission check and no audit: callers do both. */
  async render(tx: Tx, def: ReportDefinition, rc: ReportContext, format: ExportFormat): Promise<{ file: ReportFile; rowCount: number }> {
    const out = await def.run(tx, rc);
    const model: ExportModel = {
      key: def.key, title: def.title, tenantName: rc.tenantName, generatedAt: rc.now, timeZone: rc.timeZone, currency: rc.currency,
      parameters: await this.parameterLines(tx, def, rc), columns: out.columns, rows: out.rows, totals: out.totals, notes: out.notes,
    };
    const content = format === 'xlsx' ? await buildXlsx(model) : format === 'pdf' ? await buildPdf(model, await this.pdfBrand(rc.tenantId, rc.tenantName)) : buildCsv(out.columns, out.rows, out.totals);
    const stamp = def.asOfNow ? rc.today : rc.period.from === rc.period.to ? rc.period.from : `${rc.period.from}_${rc.period.to}`;
    return { file: { filename: `${def.key}_${stamp}.${format}`, mime: MIME[format], content }, rowCount: out.rows.length };
  }

  /** Export for a signed-in user (report.export + the report's own permission). Audited. */
  async export(key: string, query: ReportExportQuery): Promise<ReportFile> {
    if (!can('report.export')) throw Errors.forbidden('FORBIDDEN', 'You do not have permission to export reports.');
    const def = this.definition(key);
    const { format, ...filters } = query;
    return this.db.tx(
      async (tx) => {
        const rc = await this.context(tx, def, filters, this.viewer());
        const { file, rowCount } = await this.render(tx, def, rc, format);
        await this.audit.log(
          {
            action: 'report.exported',
            resourceType: 'Report',
            resourceId: def.key,
            summary: `${def.title} exported as ${format.toUpperCase()}`,
            after: { format, from: def.asOfNow ? null : rc.period.from, to: def.asOfNow ? null : rc.period.to, branchIds: rc.branchIds, filters, rows: rowCount, sizeBytes: file.content.length },
          },
          tx,
        );
        return file;
      },
      { timeoutMs: REPORT_TIMEOUT_MS },
    );
  }
}
