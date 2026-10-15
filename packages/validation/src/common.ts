import { z } from 'zod';

export const uuid = z.string().uuid();
export const optionalUuid = z.string().uuid().nullish();
export const trimmed = (max = 200, min = 1) => z.string().trim().min(min).max(max);
export const optionalText = (max = 2000) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v === '' ? null : v));
export const email = z.string().trim().toLowerCase().email().max(254);
/** E.164, e.g. +971501234567 */
export const phone = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s()-]/g, ''))
  .pipe(z.string().regex(/^\+[1-9][0-9]{6,14}$/, 'Use international format, e.g. +971501234567'));
export const language = z.enum(['en', 'ar']);
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const isoDateTime = z.string().datetime({ offset: true });
export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24h)');
export const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Use a hex colour such as #0B7AD1');
export const currency = z.string().regex(/^[A-Z]{3}$/).default('AED');
/** Money as a decimal string or number with at most 2 decimals, >= 0. */
export const moneyAmount = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .pipe(z.string().regex(/^\d{1,11}(\.\d{1,2})?$/, 'Enter an amount such as 150.00'));
export const positiveMoney = moneyAmount.refine((v) => Number(v) > 0, 'Amount must be greater than zero');
export const percent = z.coerce.number().min(0).max(100);
export const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]([a-z0-9-]{1,48}[a-z0-9])$/, 'Use 3-50 lowercase letters, numbers or hyphens');
export const countryCode = z.string().trim().toUpperCase().regex(/^[A-Z]{2,3}$/);
/** The lowest minimum length any environment can have. The API may require more (PASSWORD_MIN_LENGTH). */
export const PASSWORD_MIN_LENGTH_FLOOR = 10;
/**
 * Schema for a NEW password with a given minimum length. Web apps build it from the policy the API publishes
 * (`passwordPolicy.minLength` in GET /public/tenant-config and in the invitation preview); `password` below is
 * the floor that always applies.
 */
export const passwordWithMinLength = (minLength: number = PASSWORD_MIN_LENGTH_FLOOR) =>
  z
    .string()
    .min(Math.max(PASSWORD_MIN_LENGTH_FLOOR, minLength), `Use at least ${Math.max(PASSWORD_MIN_LENGTH_FLOOR, minLength)} characters`)
    .max(128)
    .refine((v) => /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v), 'Include upper-case, lower-case and a number');
export const password = passwordWithMinLength();

const boolish = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((v) => v === true || v === 'true');
export const queryBool = boolish.optional();

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sort: z
    .string()
    .regex(/^[A-Za-z]+:(asc|desc)$/)
    .optional(),
  q: z.string().trim().max(120).optional(),
});
export type PageQueryInput = z.infer<typeof pageQuery>;

export const dateRangeQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  branchId: uuid.optional(),
});
export const idParam = z.object({ id: uuid });
export const reasonBody = z.object({ reason: trimmed(500, 3) });
export const optionalReasonBody = z.object({ reason: optionalText(500) });

export const ruleCondition = z.object({
  fact: z.string().min(1).max(80),
  op: z.enum(['eq', 'neq', 'in', 'nin', 'gt', 'gte', 'lt', 'lte', 'exists', 'truthy']),
  value: z.unknown().optional(),
});
export const rule = z.object({ all: z.array(ruleCondition).max(20).optional(), any: z.array(ruleCondition).max(20).optional() });
