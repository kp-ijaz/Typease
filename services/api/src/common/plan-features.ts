import { PLAN_FEATURE_KEYS } from '@typease/types';
import type { PlanFeatureKey } from '@typease/types';

/**
 * Plan features that were listed once but that nothing in the product implements. They are no longer offered:
 * not in the default plans, not in what a plans endpoint returns, not in what a plan can be given. A stored plan
 * (or an older client) that still carries such a key is tolerated - the key is simply ignored and dropped.
 *
 * `apiAccess`: there is no API-key authentication and no public API for third parties, so a plan cannot include it.
 */
export const RETIRED_PLAN_FEATURES = ['apiAccess'] as const;
export type RetiredPlanFeature = (typeof RETIRED_PLAN_FEATURES)[number];
export type OfferedPlanFeatureKey = Exclude<PlanFeatureKey, RetiredPlanFeature>;
export type OfferedPlanFeatures = Record<OfferedPlanFeatureKey, boolean>;

/** The feature catalogue: every feature a plan can include, in display order. */
export const OFFERED_PLAN_FEATURE_KEYS = PLAN_FEATURE_KEYS.filter((k): k is OfferedPlanFeatureKey => !(RETIRED_PLAN_FEATURES as readonly string[]).includes(k));

/**
 * The features of a stored plan as the product understands them: exactly the offered keys, each a boolean
 * (missing = not included). Retired and unknown keys in the stored JSON are ignored.
 */
export function offeredFeatures(stored: unknown): OfferedPlanFeatures {
  const source = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
  return Object.fromEntries(OFFERED_PLAN_FEATURE_KEYS.map((k) => [k, source[k] === true])) as OfferedPlanFeatures;
}

/** A plan row (or any object with `features`) as it leaves the API: without retired feature keys. */
export function withOfferedFeatures<T extends { features: unknown }>(plan: T): Omit<T, 'features'> & { features: OfferedPlanFeatures } {
  return { ...plan, features: offeredFeatures(plan.features) };
}
