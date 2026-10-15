import { z } from 'zod';
import { email, hexColor, hhmm, language, optionalText, password, percent, phone, slug, trimmed, uuid } from './common';

/** Step 1 of onboarding: a new typing centre signs up. */
export const tenantSignupSchema = z.object({
  businessName: trimmed(120, 2),
  slug,
  ownerName: trimmed(120, 2),
  email,
  phone,
  password,
  preferredLanguage: language.default('en'),
  acceptTerms: z.literal(true, { errorMap: () => ({ message: 'You must accept the terms' }) }),
});

export const onboardingBusinessSchema = z.object({
  legalName: trimmed(160, 2),
  tradeLicenceNo: optionalText(60),
  taxRegistrationNo: optionalText(30),
  emirate: z.enum(['Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah']),
  contactEmail: email,
  contactPhone: phone,
  defaultLanguage: language.default('en'),
});
export const onboardingPlanSchema = z.object({
  planKey: z.string().min(1).max(40),
  billingCycle: z.enum(['MONTHLY', 'ANNUAL']).default('MONTHLY'),
  couponCode: z.string().trim().toUpperCase().max(40).optional(),
});
export const onboardingDraftSchema = z.object({
  step: z.number().int().min(0).max(10),
  data: z.record(z.unknown()),
});

export const updateTenantSchema = z.object({
  name: trimmed(120, 2).optional(),
  legalName: optionalText(160),
  emirate: optionalText(40),
  contactEmail: email.optional(),
  contactPhone: phone.optional(),
  tradeLicenceNo: optionalText(60),
  taxRegistrationNo: optionalText(30),
  taxRatePercent: percent.optional(),
  defaultLanguage: language.optional(),
  timezone: z.string().max(60).optional(),
  aiEnabled: z.boolean().optional(),
});
export const tenantSettingsSchema = z.object({
  /** Whether customers may register themselves on the portal. */
  allowSelfRegistration: z.boolean().optional(),
  /** Default target processing time when the service has none. */
  defaultTargetHours: z.number().int().min(1).max(24 * 90).optional(),
  quotationValidityDays: z.number().int().min(1).max(90).optional(),
  invoiceDueDays: z.number().int().min(0).max(120).optional(),
  autoAssign: z.boolean().optional(),
  requestNumberPrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,6}$/).optional(),
  reminderOffsetsDays: z.array(z.number().int().min(1).max(365)).max(8).optional(),
  queueDisplayLanguage: language.optional(),
});

const workingDay = z.object({ open: hhmm, close: hhmm }).nullable();
export const branchSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,12}$/, 'Use 2-12 letters or numbers'),
  name: trimmed(120, 2),
  nameAr: optionalText(120),
  address: optionalText(300),
  emirate: optionalText(40),
  phone: phone.optional().nullable(),
  email: email.optional().nullable(),
  isHeadOffice: z.boolean().default(false),
  isActive: z.boolean().default(true),
  workingHours: z.record(z.enum(['0', '1', '2', '3', '4', '5', '6']), workingDay).default({}),
});
export const updateBranchSchema = branchSchema.partial();

export const inviteStaffSchema = z.object({
  email,
  fullName: trimmed(120, 2),
  roleKey: z.string().min(2).max(60),
  jobTitle: optionalText(80),
  allBranches: z.boolean().default(false),
  branchIds: z.array(uuid).max(50).default([]),
});
export const updateStaffSchema = z.object({
  roleKey: z.string().min(2).max(60).optional(),
  jobTitle: optionalText(80),
  allBranches: z.boolean().optional(),
  branchIds: z.array(uuid).max(50).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
  isAvailable: z.boolean().optional(),
  serviceIds: z.array(uuid).max(200).optional(),
});
export const staffScheduleSchema = z.object({
  entries: z
    .array(z.object({ branchId: uuid, weekday: z.number().int().min(0).max(6), startTime: hhmm, endTime: hhmm }))
    .max(60),
});

export const roleSchema = z.object({
  key: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{2,40}$/),
  name: trimmed(80, 2),
  description: optionalText(300),
  permissions: z.array(z.string().max(80)).max(200),
});
export const updateRoleSchema = roleSchema.omit({ key: true }).partial();

export const brandingSchema = z.object({
  mode: z.enum(['TYPEASE', 'WHITE_LABEL']).optional(),
  businessName: optionalText(120),
  businessNameAr: optionalText(120),
  primaryColor: hexColor.nullish(),
  secondaryColor: hexColor.nullish(),
  accentColor: hexColor.nullish(),
  websiteTitle: optionalText(80),
  tagline: optionalText(120),
  supportEmail: email.nullish(),
  supportPhone: phone.nullish(),
  emailFromName: optionalText(80),
  emailFromAddress: email.nullish(),
  invoiceFooter: optionalText(500),
  receiptFooter: optionalText(500),
  publicCatalogueEnabled: z.boolean().optional(),
});
export const domainSchema = z.object({
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'Enter a domain such as portal.yourcentre.ae'),
  /** Custom domains serve the customer portal. Staff, corporate and platform apps stay on TypEase hosts. */
  app: z.literal('customer').default('customer'),
});

export type TenantSignupInput = z.infer<typeof tenantSignupSchema>;
export type BranchInput = z.infer<typeof branchSchema>;
