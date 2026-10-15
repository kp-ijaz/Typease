import { z } from 'zod';
import { moneyAmount, optionalText, trimmed } from './common';

/** Payroll: pay set-up per staff member, monthly runs, WPS. */
export const staffPaySchema = z.object({
  basicSalary: moneyAmount,
  housingAllowance: moneyAmount.default('0'),
  transportAllowance: moneyAmount.default('0'),
  otherAllowance: moneyAmount.default('0'),
  payMethod: z.enum(['WPS', 'BANK', 'CASH']).default('WPS'),
  /** MOHRE person code (14 digits) used in the WPS salary file. */
  employeeWpsId: z.string().trim().regex(/^\d{14}$/, 'The WPS person code has 14 digits').nullish(),
  /** Routing code (agent id) of the employee's bank: 9 digits. */
  bankRoutingCode: z.string().trim().regex(/^\d{9}$/, 'The routing code has 9 digits').nullish(),
  /** UAE IBAN: AE + 21 digits. Only sent to change it; stored encrypted. */
  iban: z.string().trim().toUpperCase().transform((v) => v.replace(/\s/g, '')).pipe(z.string().regex(/^AE\d{21}$/, 'A UAE IBAN is AE followed by 21 digits')).nullish(),
  includeCommission: z.boolean().default(true),
  isActive: z.boolean().default(true),
});
export type StaffPayInput = z.infer<typeof staffPaySchema>;

export const payrollPeriod = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');
export const createPayrollRunSchema = z.object({ period: payrollPeriod, notes: optionalText(500) });
export const updatePayrollLineSchema = z.object({
  daysWorked: z.number().int().min(0).max(31).optional(),
  overtime: moneyAmount.optional(),
  deductions: moneyAmount.optional(),
  deductionNote: optionalText(300),
});
export type UpdatePayrollLineInput = z.infer<typeof updatePayrollLineSchema>;
export const payPayrollRunSchema = z.object({ paidFrom: z.enum(['BANK', 'CASH']).default('BANK'), reference: trimmed(120, 1) });
export const payrollSettingsSchema = z.object({
  /** Employer establishment id of the WPS file (13 digits). */
  wpsEmployerId: z.string().trim().regex(/^\d{13}$/, 'The employer id has 13 digits').nullish(),
  /** Routing code of the employer's bank (9 digits). */
  wpsBankRoutingCode: z.string().trim().regex(/^\d{9}$/, 'The routing code has 9 digits').nullish(),
});
export type PayrollSettingsInput = z.infer<typeof payrollSettingsSchema>;
