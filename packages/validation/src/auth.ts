import { z } from 'zod';
import { email, language, password, phone, slug, trimmed, uuid } from './common';

export const appKey = z.enum(['centre', 'customer', 'corporate', 'platform', 'mobile']);

export const loginSchema = z.object({
  email,
  password: z.string().min(1).max(128),
  app: appKey,
  /** Which centre the user is signing in to (customer / corporate apps). Resolved from the host when omitted. */
  tenantSlug: slug.optional(),
  deviceName: z.string().max(80).optional(),
});
export const otpRequestSchema = z.object({ phone, app: appKey, tenantSlug: slug.optional() });
export const otpVerifySchema = z.object({
  phone,
  code: z.string().regex(/^\d{6}$/),
  app: appKey,
  tenantSlug: slug.optional(),
  deviceName: z.string().max(80).optional(),
});
export const mfaVerifySchema = z.object({ challengeToken: z.string().min(10), code: z.string().trim().min(6).max(20) });
export const selectTenantSchema = z.object({ selectionToken: z.string().min(10), membershipId: uuid });
export const switchTenantSchema = z.object({ membershipId: uuid });
export const refreshSchema = z.object({ refreshToken: z.string().min(20).optional(), app: appKey.optional() });
/** GET /auth/sessions: at most `limit` live sessions, most recent first; the current session is always among them. */
export const sessionListQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), app: appKey.optional() });
export type SessionListQuery = z.infer<typeof sessionListQuery>;
/** One-time code from the platform console (`#code=` fragment of the hand-off link) that opens a support session in the staff app. */
export const supportSessionExchangeSchema = z.object({ code: z.string().trim().min(20).max(200) });

export const registerCustomerSchema = z.object({
  tenantSlug: slug.optional(),
  fullName: trimmed(120, 2),
  email,
  phone: phone.optional(),
  password,
  preferredLanguage: language.default('en'),
  acceptTerms: z.literal(true, { errorMap: () => ({ message: 'You must accept the terms and privacy notice' }) }),
  marketingOptIn: z.boolean().default(false),
});
export const verifyEmailSchema = z.object({ token: z.string().min(10) });
export const resendVerificationSchema = z.object({ email });
export const forgotPasswordSchema = z.object({ email, app: appKey.optional(), tenantSlug: slug.optional() });
export const resetPasswordSchema = z.object({ token: z.string().min(10), password });
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1), newPassword: password });
export const mfaEnableSchema = z.object({ code: z.string().regex(/^\d{6}$/) });
export const mfaDisableSchema = z.object({ password: z.string().min(1), code: z.string().trim().min(6).max(20) });
export const acceptInvitationSchema = z.object({
  token: z.string().min(10),
  fullName: trimmed(120, 2).optional(),
  password: password.optional(),
  app: appKey.default('centre'),
});
export const phoneVerifyRequestSchema = z.object({ phone });
export const phoneVerifyConfirmSchema = z.object({ phone, code: z.string().regex(/^\d{6}$/) });
export const updateProfileSchema = z.object({
  fullName: trimmed(120, 2).optional(),
  preferredLanguage: language.optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterCustomerInput = z.infer<typeof registerCustomerSchema>;
