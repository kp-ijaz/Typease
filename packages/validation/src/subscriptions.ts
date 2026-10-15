import { z } from 'zod';
import { isoDateTime, moneyAmount, optionalText, pageQuery, positiveMoney, trimmed, uuid } from './common';

/**
 * SaaS billing of typing centres by TypEase (plans, coupons, subscriptions).
 * Completely separate from the centre's own customer finance.
 */

const billingCycle = z.enum(['MONTHLY', 'ANNUAL']);
const planKey = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9-]{1,39}$/, 'Use 2-40 lowercase letters, numbers or hyphens');
const couponCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9_-]{2,39}$/, 'Use 3-40 letters, numbers, hyphens or underscores');
/** -1 means unlimited. */
const limit = z.number().int().min(-1).max(100_000_000);

export const planLimitsSchema = z
  .object({ branches: limit, staffUsers: limit, monthlyRequests: limit, storageMb: limit, aiPages: limit, notifications: limit, corporateClients: limit })
  .strict();
/**
 * Feature keys of earlier releases that a client may still send. They are accepted and dropped, so an older
 * console keeps working; they are never stored and never returned. `apiAccess` was advertised but never built.
 */
export const RETIRED_PLAN_FEATURE_KEYS = ['apiAccess'] as const;
export const planFeaturesSchema = z
  .object({
    whiteLabel: z.boolean(),
    customDomains: z.boolean(),
    corporatePortal: z.boolean(),
    automation: z.boolean(),
    aiAssistant: z.boolean(),
    scheduledReports: z.boolean(),
    /** Retired: accepted from older clients, ignored. */
    apiAccess: z.boolean().optional(),
  })
  .strict()
  .transform(({ apiAccess: _retired, ...offered }) => offered);

export const subscriptionPlanSchema = z.object({
  key: planKey,
  name: trimmed(80, 2),
  description: optionalText(500),
  monthlyPrice: moneyAmount,
  annualPrice: moneyAmount,
  currency: z.string().regex(/^[A-Z]{3}$/).default('AED'),
  trialDays: z.number().int().min(0).max(365).default(14),
  limits: planLimitsSchema,
  features: planFeaturesSchema,
  isPublic: z.boolean().default(true),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});
export type SubscriptionPlanInput = z.infer<typeof subscriptionPlanSchema>;
/** The key identifies the plan in subscriptions and coupons and cannot be changed. */
export const updateSubscriptionPlanSchema = subscriptionPlanSchema.omit({ key: true, currency: true }).partial();
export type UpdateSubscriptionPlanInput = z.infer<typeof updateSubscriptionPlanSchema>;

const couponBase = z.object({
  code: couponCode,
  description: optionalText(300),
  /** Exactly one of percentOff / amountOff. */
  percentOff: z.coerce.number().gt(0).max(100).multipleOf(0.01).nullish(),
  amountOff: positiveMoney.nullish(),
  currency: z.string().regex(/^[A-Z]{3}$/).default('AED'),
  /** How many months the discount lasts once applied; empty = for as long as the subscription runs. */
  durationMonths: z.number().int().min(1).max(60).nullish(),
  maxRedemptions: z.number().int().min(1).max(1_000_000).nullish(),
  /** Empty = valid for every plan. */
  planKeys: z.array(planKey).max(20).default([]),
  validFrom: isoDateTime.nullish(),
  validUntil: isoDateTime.nullish(),
  isActive: z.boolean().default(true),
});
export const couponSchema = couponBase
  .refine((v) => (v.percentOff ? 1 : 0) + (v.amountOff ? 1 : 0) === 1, { message: 'Give either a percentage or a fixed amount, not both', path: ['percentOff'] })
  .refine((v) => !v.validFrom || !v.validUntil || new Date(v.validUntil) > new Date(v.validFrom), { message: 'The coupon must end after it starts', path: ['validUntil'] });
export type CouponInput = z.infer<typeof couponSchema>;
/** The discount itself is fixed once a coupon exists (it may already be in use); availability can change. */
export const updateCouponSchema = couponBase.pick({ description: true, durationMonths: true, maxRedemptions: true, planKeys: true, validFrom: true, validUntil: true, isActive: true }).partial();
export type UpdateCouponInput = z.infer<typeof updateCouponSchema>;

// ---------------------------------------------------------------- tenant side
export const startPlanSchema = z.object({ planKey, billingCycle: billingCycle.default('MONTHLY'), couponCode: couponCode.optional() });
export type StartPlanInput = z.infer<typeof startPlanSchema>;
export const changePlanSchema = z.object({ planKey, billingCycle: billingCycle.optional() });
export type ChangePlanInput = z.infer<typeof changePlanSchema>;
export const cancelSubscriptionSchema = z.object({ reason: trimmed(500, 3) });
export const applyCouponSchema = z.object({ code: couponCode });
export const subscriptionInvoiceListQuery = pageQuery.extend({ status: z.enum(['DRAFT', 'OPEN', 'PAID', 'VOID', 'UNCOLLECTIBLE']).optional() });
export type SubscriptionInvoiceListQuery = z.infer<typeof subscriptionInvoiceListQuery>;

// ---------------------------------------------------------------- platform billing admin
export const platformSubscriptionListQuery = pageQuery.extend({
  status: z.enum(['TRIALING', 'ACTIVE', 'PAST_DUE', 'GRACE', 'CANCELLED', 'EXPIRED']).optional(),
  planKey: planKey.optional(),
  billingCycle: billingCycle.optional(),
  tenantId: uuid.optional(),
});
export type PlatformSubscriptionListQuery = z.infer<typeof platformSubscriptionListQuery>;
export const offlineSubscriptionPaymentSchema = z.object({
  method: z.enum(['BANK_TRANSFER', 'CHEQUE', 'CASH']).default('BANK_TRANSFER'),
  /** Bank reference of the transfer. */
  reference: trimmed(120, 3),
  paidAt: isoDateTime.optional(),
});
export type OfflineSubscriptionPaymentInput = z.infer<typeof offlineSubscriptionPaymentSchema>;
export const extendTrialSchema = z.object({ days: z.number().int().min(1).max(180), reason: trimmed(300, 3) });
export type ExtendTrialInput = z.infer<typeof extendTrialSchema>;
export const voidSubscriptionInvoiceSchema = z.object({ reason: trimmed(300, 3) });
export const adminChangePlanSchema = z.object({
  planKey,
  billingCycle: billingCycle.optional(),
  /** true: switch now without a proration invoice (a commercial decision by TypEase). */
  immediate: z.boolean().default(false),
  reason: trimmed(300, 3),
});
export type AdminChangePlanInput = z.infer<typeof adminChangePlanSchema>;
