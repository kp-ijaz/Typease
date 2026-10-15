import type { ReportQuery } from '@typease/validation';
import type { Tx } from '../../common/db/prisma.service';
import type { Period } from './time';

export type ColumnType = 'text' | 'number' | 'money' | 'date' | 'percent';
export interface ReportColumn {
  key: string;
  label: string;
  type: ColumnType;
}
/**
 * One row. Keys named in `columns` are shown; a row may carry further keys
 * (ids such as `requestId`, `invoiceId`) so the UI can link to the record or
 * ask for a drill-down. Money is a two-decimal string, never a float.
 */
export type ReportRow = Record<string, string | number | boolean | null>;

export interface ReportChart {
  type: 'bar' | 'line' | 'pie';
  /** Column that labels the points. */
  x: string;
  /** Columns that are plotted. */
  series: Array<{ key: string; label: string }>;
}
export interface ReportOutput {
  columns: ReportColumn[];
  rows: ReportRow[];
  totals?: ReportRow;
  chart?: ReportChart;
  /** Basis of the figures and anything a reader must know to interpret them. */
  notes: string[];
}

/** Who the figures are for. HTTP calls derive it from the caller; scheduled runs from the recipients. */
export interface ReportViewer {
  /** May see money (report.financial). Operational reports drop their money columns otherwise. */
  financial: boolean;
  /** May see customer names (customer.read). Otherwise only customer numbers are shown. */
  customerNames: boolean;
}

/** Everything a report needs to know about "for whom, where and when". */
export interface ReportContext {
  tenantId: string;
  tenantName: string;
  timeZone: string;
  currency: string;
  /** Today in the centre's time zone. */
  today: string;
  now: Date;
  period: Period;
  /** Branches the figures are limited to; null = the whole centre. */
  branchIds: string[] | null;
  viewer: ReportViewer;
  filters: ReportQuery;
}

export type ReportPermission = 'report.operational' | 'report.financial';
export interface ReportParameter {
  key: string;
  label: string;
  type: 'date' | 'relativeRange' | 'branch' | 'service' | 'customer' | 'corporateAccount' | 'staff' | 'enum' | 'number' | 'text' | 'month';
  required?: boolean;
  options?: string[];
  /** Only used by the drill-down. */
  drilldownOnly?: boolean;
}

export interface DrilldownOutput {
  columns: ReportColumn[];
  rows: ReportRow[];
  total: number;
  notes?: string[];
}

export interface ReportDefinition {
  key: string;
  title: string;
  description: string;
  permission: ReportPermission;
  category: 'FINANCE' | 'OPERATIONS' | 'CUSTOMERS';
  parameters: ReportParameter[];
  /** Longest period in days (reports with one row per day). */
  maxDays?: number;
  /** Period used when the caller names none (default: the current month to date). */
  defaultPeriod?: (today: string) => { from: string; to: string };
  /** Ignores the period: the figures are "as of now". */
  asOfNow?: boolean;
  /** False when the report cannot be limited to a branch (customers belong to the centre). */
  branchScoped: boolean;
  run(tx: Tx, rc: ReportContext): Promise<ReportOutput>;
  drilldown?(tx: Tx, rc: ReportContext, page: { skip: number; take: number }): Promise<DrilldownOutput>;
}

export const PERIOD_PARAMETERS: ReportParameter[] = [
  { key: 'from', label: 'From', type: 'date' },
  { key: 'to', label: 'To', type: 'date' },
  { key: 'range', label: 'Relative period', type: 'relativeRange' },
];
export const BRANCH_PARAMETER: ReportParameter = { key: 'branchId', label: 'Branch', type: 'branch' };
