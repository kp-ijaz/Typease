import { z } from 'zod';
import { email, isoDate, language, optionalText, pageQuery, phone, queryBool, slug, trimmed, uuid } from './common';

/**
 * Schemas of the platform administration API (`/platform/*`), the tenant-side
 * support-access decisions (`/support-access`) and the audit viewer (`/audit-logs`).
 */
const isoDateOrDateTime = z.union([isoDate, z.string().datetime({ offset: true })]);

// ------------------------------------------------------------------ audit viewer (tenant + platform)
export const auditLogQuery = pageQuery.extend({
  /** Prefix of the action, e.g. "invoice." or "customer.merged". */
  action: z.string().trim().min(2).max(80).regex(/^[a-z0-9_.-]+$/i).optional(),
  resourceType: z.string().trim().min(1).max(80).optional(),
  resourceId: z.string().trim().min(1).max(80).optional(),
  actorUserId: uuid.optional(),
  actorType: z.enum(['STAFF', 'CUSTOMER', 'CORPORATE', 'PLATFORM', 'SYSTEM', 'AUTOMATION']).optional(),
  from: isoDateOrDateTime.optional(),
  to: isoDateOrDateTime.optional(),
  /** true = only actions taken by TypEase support under an access grant; false = everything else. */
  supportAccess: queryBool,
  supportGrantId: uuid.optional(),
});
export type AuditLogQuery = z.infer<typeof auditLogQuery>;
/** Same filters as the list, without paging. */
export const auditExportQuery = auditLogQuery.omit({ page: true, pageSize: true, sort: true });
export type AuditExportQuery = z.infer<typeof auditExportQuery>;

export const platformAuditQuery = auditLogQuery.omit({ supportAccess: true, supportGrantId: true });
export type PlatformAuditQuery = z.infer<typeof platformAuditQuery>;
export const securityEventQuery = pageQuery.extend({
  type: z.string().trim().min(2).max(80).regex(/^[A-Z0-9_]+$/i).optional(),
  severity: z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  /** Platform staff filter; not an authorisation input. */
  centreId: uuid.optional(),
  /** true = only events that belong to no centre. */
  platformOnly: queryBool,
  userId: uuid.optional(),
  from: isoDateOrDateTime.optional(),
  to: isoDateOrDateTime.optional(),
});
export type SecurityEventQuery = z.infer<typeof securityEventQuery>;

// ------------------------------------------------------------------ tenants
export const tenantStatusValue = z.enum(['ONBOARDING', 'PENDING_APPROVAL', 'TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED', 'ARCHIVED']);
export const platformTenantListQuery = pageQuery.extend({
  status: tenantStatusValue.optional(),
  /** Plan key, or "none" for centres without a subscription. */
  plan: z.string().trim().min(1).max(60).optional(),
  createdFrom: isoDate.optional(),
  createdTo: isoDate.optional(),
  /** Only centres scheduled for permanent deletion. */
  offboarding: queryBool,
});
export type PlatformTenantListQuery = z.infer<typeof platformTenantListQuery>;

export const platformCreateTenantSchema = z.object({
  businessName: trimmed(160, 2),
  slug,
  legalName: optionalText(200),
  emirate: optionalText(60),
  ownerName: trimmed(160, 2),
  ownerEmail: email,
  ownerPhone: phone.optional(),
  preferredLanguage: language.default('en'),
  /** Optional: start a subscription for the centre straight away (public plans only). */
  planKey: z.string().trim().min(1).max(60).optional(),
  billingCycle: z.enum(['MONTHLY', 'ANNUAL']).default('MONTHLY'),
  couponCode: z.string().trim().min(2).max(40).optional(),
});
export type PlatformCreateTenantInput = z.infer<typeof platformCreateTenantSchema>;

export const tenantDecisionSchema = z.object({ note: optionalText(1000) });
export type TenantDecisionInput = z.infer<typeof tenantDecisionSchema>;
export const tenantReasonSchema = z.object({ reason: trimmed(500, 5) });
export type TenantReasonInput = z.infer<typeof tenantReasonSchema>;

export const offboardTenantSchema = z
  .object({
    /** Type the centre's slug to confirm. */
    confirmSlug: z.string().trim().min(1).max(60),
    reason: trimmed(1000, 10),
    /** Days until the data is permanently deleted. At least 30 unless `immediate`. */
    purgeAfterDays: z.coerce.number().int().min(0).max(3650).default(30),
    immediate: z.boolean().default(false),
    /** Second confirmation for `immediate`: the text "PURGE <slug>". */
    confirmImmediate: z.string().trim().max(80).optional(),
  })
  .refine((v) => v.immediate || v.purgeAfterDays >= 30, { message: 'The data is kept for at least 30 days before it is deleted.', path: ['purgeAfterDays'] });
export type OffboardTenantInput = z.infer<typeof offboardTenantSchema>;

// ------------------------------------------------------------------ support access
export const requestAccessSchema = z.object({
  reason: trimmed(1000, 10),
  /** Tenant permissions the grant unlocks. Only read-level permissions can be requested. */
  scopes: z.array(z.string().trim().min(3).max(60)).min(1).max(20),
  durationMinutes: z.coerce.number().int().min(5).max(1440).default(60),
  /** A platform support ticket of the same centre that this access is for. */
  ticketId: uuid.nullish(),
});
export type RequestAccessInput = z.infer<typeof requestAccessSchema>;
export const accessGrantStatus = z.enum(['REQUESTED', 'APPROVED', 'DENIED', 'REVOKED', 'EXPIRED']);
export const platformAccessGrantQuery = pageQuery.extend({
  status: accessGrantStatus.optional(),
  centreId: uuid.optional(),
  /** Requests of every staff member (needs platform.audit.read). Default: only my own. */
  all: queryBool,
});
export type PlatformAccessGrantQuery = z.infer<typeof platformAccessGrantQuery>;
export const tenantAccessGrantQuery = pageQuery.extend({ status: accessGrantStatus.optional() });
export type TenantAccessGrantQuery = z.infer<typeof tenantAccessGrantQuery>;
export const approveAccessSchema = z.object({
  note: optionalText(500),
  /** Optionally approve fewer scopes than were requested. */
  scopes: z.array(z.string().trim().min(3).max(60)).min(1).max(20).optional(),
  /** Optionally approve a shorter time than was requested. */
  durationMinutes: z.coerce.number().int().min(5).max(1440).optional(),
});
export type ApproveAccessInput = z.infer<typeof approveAccessSchema>;
export const accessNoteSchema = z.object({ note: optionalText(500) });
export type AccessNoteInput = z.infer<typeof accessNoteSchema>;

// ------------------------------------------------------------------ feature flags + settings
export const featureFlagKey = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_.-]{1,59}$/, 'Use 2-60 lowercase letters, numbers, dots, dashes or underscores');
export const featureFlagSchema = z.object({
  enabled: z.boolean(),
  /** Optional settings that travel with the flag. May carry a `description`. */
  payload: z.record(z.string().max(60), z.unknown()).optional(),
});
export type FeatureFlagInput = z.infer<typeof featureFlagSchema>;
export const platformSettingSchema = z.object({ value: z.unknown() });
export type PlatformSettingInput = z.infer<typeof platformSettingSchema>;

// ------------------------------------------------------------------ platform staff
export const platformRoleValue = z.enum(['SUPER_ADMIN', 'SUPPORT_AGENT']);
export const createPlatformStaffSchema = z.object({ email, fullName: trimmed(160, 2), role: platformRoleValue });
export type CreatePlatformStaffInput = z.infer<typeof createPlatformStaffSchema>;
export const updatePlatformStaffSchema = z
  .object({ role: platformRoleValue.optional(), fullName: trimmed(160, 2).optional() })
  .refine((v) => v.role !== undefined || v.fullName !== undefined, 'Nothing to change');
export type UpdatePlatformStaffInput = z.infer<typeof updatePlatformStaffSchema>;
export const platformStaffQuery = z.object({ role: platformRoleValue.optional(), status: z.enum(['ACTIVE', 'DISABLED']).optional(), q: z.string().trim().max(120).optional() });
export type PlatformStaffQuery = z.infer<typeof platformStaffQuery>;

// ------------------------------------------------------------------ dashboard + reports
export const platformPeriodQuery = z
  .object({ from: isoDate.optional(), to: isoDate.optional() })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: '"from" must not be after "to".', path: ['from'] });
export type PlatformPeriodQuery = z.infer<typeof platformPeriodQuery>;
export const tenantGrowthQuery = z
  .object({ from: isoDate.optional(), to: isoDate.optional(), interval: z.enum(['day', 'week', 'month']).default('month') })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: '"from" must not be after "to".', path: ['from'] });
export type TenantGrowthQuery = z.infer<typeof tenantGrowthQuery>;
export const failedPaymentsQuery = pageQuery.extend({ from: isoDate.optional(), to: isoDate.optional() });
export type FailedPaymentsQuery = z.infer<typeof failedPaymentsQuery>;

/** Platform console: custom-domain claims across all centres. */
export const platformDomainQuery = pageQuery.extend({
  /** Part of the domain name. */
  q: z.string().trim().toLowerCase().max(253).optional(),
  status: z.enum(['PENDING', 'VERIFIED', 'FAILED', 'DISABLED']).optional(),
  centreId: z.string().uuid().optional(),
});
export type PlatformDomainQuery = z.infer<typeof platformDomainQuery>;

