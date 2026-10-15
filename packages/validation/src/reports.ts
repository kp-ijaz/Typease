import { z } from 'zod';
import { email, hhmm, isoDate, uuid } from './common';

// ====================================================================== dashboard
/** `from` / `to` are calendar days in the centre's time zone. */
export const dashboardQuery = z
  .object({ branchId: uuid.optional(), from: isoDate.optional(), to: isoDate.optional() })
  .strict()
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: 'The start date must not be after the end date', path: ['to'] });
export type DashboardQuery = z.infer<typeof dashboardQuery>;
export const dashboardTrendsQuery = dashboardQuery;
export type DashboardTrendsQuery = z.infer<typeof dashboardTrendsQuery>;

// ====================================================================== reports
/** Periods that move with the calendar (scheduled reports, quick filters). Resolved in the centre's time zone. */
export const RELATIVE_RANGES = ['today', 'yesterday', 'last_7_days', 'last_30_days', 'last_week', 'month_to_date', 'last_month', 'year_to_date'] as const;
export const relativeRange = z.enum(RELATIVE_RANGES);
export type RelativeRange = z.infer<typeof relativeRange>;

export const REPORT_EXPORT_FORMATS = ['xlsx', 'pdf', 'csv'] as const;

const reportFilters = {
  /** Explicit period (calendar days in the centre's time zone) ... */
  from: isoDate.optional(),
  to: isoDate.optional(),
  /** ... or a relative one. Not both. */
  range: relativeRange.optional(),
  branchId: uuid.optional(),
  // Report-specific filters. A report ignores the ones it does not use.
  serviceId: uuid.optional(),
  customerId: uuid.optional(),
  corporateAccountId: uuid.optional(),
  membershipId: uuid.optional(),
  requestId: uuid.optional(),
  status: z.string().trim().max(40).optional(),
  component: z.enum(['GOVERNMENT_FEE', 'THIRD_PARTY_FEE']).optional(),
  documentTypeKey: z.string().trim().max(60).optional(),
  /** Expiry reminders drill-down: upcoming expiries or reminders that were sent. */
  kind: z.enum(['upcoming', 'sent']).optional(),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  /** Expiry reminders: how far ahead "upcoming" looks. */
  withinDays: z.coerce.number().int().min(1).max(365).optional(),
  /** Outstanding payments drill-down: one ageing bucket. */
  bucket: z.enum(['current', 'days1to30', 'days31to60', 'days61to90', 'days90plus']).optional(),
  /** Daily sales drill-down: one day. Monthly revenue drill-down: one month (YYYY-MM). */
  date: isoDate.optional(),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM').optional(),
};
const periodRules = (v: { from?: string; to?: string; range?: string }, c: z.RefinementCtx) => {
  if (v.range && (v.from || v.to)) c.addIssue({ code: 'custom', path: ['range'], message: 'Send either a relative range or from / to, not both' });
  if (v.from && v.to && v.from > v.to) c.addIssue({ code: 'custom', path: ['to'], message: 'The start date must not be after the end date' });
};

export const reportQuery = z.object(reportFilters).strict().superRefine(periodRules);
export type ReportQuery = z.infer<typeof reportQuery>;

export const reportDrilldownQuery = z
  .object({ ...reportFilters, page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50) })
  .strict()
  .superRefine(periodRules);
export type ReportDrilldownQuery = z.infer<typeof reportDrilldownQuery>;

export const reportExportQuery = z
  .object({ ...reportFilters, format: z.enum(REPORT_EXPORT_FORMATS) })
  .strict()
  .superRefine(periodRules);
export type ReportExportQuery = z.infer<typeof reportExportQuery>;

// ====================================================================== scheduled reports
export const scheduledReportFormat = z.enum(['XLSX', 'PDF']);
export const scheduledReportFrequency = z.enum(['DAILY', 'WEEKLY', 'MONTHLY']);

/** Filters of a scheduled report: always a relative period, never fixed dates. */
export const scheduledReportParams = z
  .object({
    range: relativeRange,
    branchId: uuid.optional(),
    serviceId: uuid.optional(),
    corporateAccountId: uuid.optional(),
    component: z.enum(['GOVERNMENT_FEE', 'THIRD_PARTY_FEE']).optional(),
    withinDays: z.number().int().min(1).max(365).optional(),
  })
  .strict();
export type ScheduledReportParams = z.infer<typeof scheduledReportParams>;

const scheduleTiming = {
  /** Local time of day in the centre's time zone (default 07:00). */
  timeOfDay: hhmm.optional(),
  /** WEEKLY: 0 = Sunday ... 6 = Saturday (default Monday). */
  weekday: z.number().int().min(0).max(6).optional(),
  /** MONTHLY: day of the month, 1-28 (default 1). */
  dayOfMonth: z.number().int().min(1).max(28).optional(),
};
const recipients = z
  .array(email)
  .min(1, 'Add at least one recipient')
  .max(20)
  .transform((list) => [...new Set(list)]);

export const createScheduledReportSchema = z
  .object({
    reportKey: z.string().trim().min(2).max(60),
    params: scheduledReportParams,
    format: scheduledReportFormat.default('XLSX'),
    frequency: scheduledReportFrequency,
    /** Email addresses of ACTIVE staff members of this centre who may see the report. */
    recipients,
    isActive: z.boolean().default(true),
    ...scheduleTiming,
  })
  .strict();
export type CreateScheduledReportInput = z.infer<typeof createScheduledReportSchema>;

export const updateScheduledReportSchema = z
  .object({
    params: scheduledReportParams.optional(),
    format: scheduledReportFormat.optional(),
    frequency: scheduledReportFrequency.optional(),
    recipients: recipients.optional(),
    isActive: z.boolean().optional(),
    ...scheduleTiming,
  })
  .strict();
export type UpdateScheduledReportInput = z.infer<typeof updateScheduledReportSchema>;

export const scheduledReportListQuery = z
  .object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20), reportKey: z.string().trim().max(60).optional() })
  .strict();
export type ScheduledReportListQuery = z.infer<typeof scheduledReportListQuery>;
export const scheduledReportRunsQuery = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) }).strict();
export type ScheduledReportRunsQuery = z.infer<typeof scheduledReportRunsQuery>;
