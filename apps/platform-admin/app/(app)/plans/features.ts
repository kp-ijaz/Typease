/**
 * The plan features the console shows and edits. `apiAccess` was retired: the API no longer
 * returns it (GET /public/plans) and ignores it when sent, so it is left out here even though
 * PLAN_FEATURE_KEYS of @typease/types still lists it.
 */
export const PLAN_FEATURES = ['whiteLabel', 'customDomains', 'corporatePortal', 'automation', 'aiAssistant', 'scheduledReports'] as const;
export type ConsolePlanFeature = (typeof PLAN_FEATURES)[number];
