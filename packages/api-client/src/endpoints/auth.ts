import type { AuthMembership, LoginResult, SessionInfo } from '@typease/types';
import type {
  acceptInvitationSchema, changePasswordSchema, forgotPasswordSchema, loginSchema, mfaDisableSchema, otpRequestSchema, otpVerifySchema,
  registerCustomerSchema, resetPasswordSchema, updateProfileSchema, z,
} from '@typease/validation';
import type { ApiClient } from '../client';
import type { LoginOk } from '../session';
import type { AuthSessionRow, DevTokens, InvitationPreview, MfaSetup } from '../types';

type In<T extends z.ZodTypeAny> = z.input<T>;
const open = { auth: false } as const;

/** What the endpoint groups need from the session manager of the app (`createApi(client, { session: manager })`). */
export interface ApiSessionHooks {
  exchangeSupportSession?: (code: string) => Promise<LoginOk>;
}
export interface SessionListQuery {
  /** How many to return, most recent first (default 20, at most 100). The current session is always included. */
  limit?: number;
  /** Only the sessions of one application ("centre", "customer" ...). */
  app?: string;
}

/** Sign-in, registration, passwords, two-step verification and sessions. `app` is filled in from the client. */
export const authApi = (c: ApiClient, session: ApiSessionHooks = {}) => ({
  login: (body: Omit<In<typeof loginSchema>, 'app'>) => c.post<LoginResult>('/auth/login', { ...body, app: c.app }, open),
  requestOtp: (body: Omit<In<typeof otpRequestSchema>, 'app'>) => c.post<{ status: 'SENT_IF_REGISTERED'; dev?: DevTokens }>('/auth/otp/request', { ...body, app: c.app }, open),
  verifyOtp: (body: Omit<In<typeof otpVerifySchema>, 'app'>) => c.post<LoginResult>('/auth/otp/verify', { ...body, app: c.app }, open),
  verifyMfa: (body: { challengeToken: string; code: string }) => c.post<LoginResult>('/auth/mfa/verify', body, open),
  selectTenant: (body: { selectionToken: string; membershipId: string }) => c.post<LoginResult>('/auth/select-tenant', body, open),
  switchTenant: (membershipId: string) => c.post<LoginResult>('/auth/switch-tenant', { membershipId }),
  memberships: () => c.get<AuthMembership[]>('/auth/memberships'),
  me: () => c.get<SessionInfo>('/auth/me'),
  updateProfile: (body: In<typeof updateProfileSchema>) => c.patch<{ status: 'UPDATED' }>('/auth/me', body),

  register: (body: In<typeof registerCustomerSchema>) => c.post<{ status: 'VERIFICATION_SENT'; email: string; dev?: DevTokens }>('/auth/register', body, open),
  verifyEmail: (token: string) => c.post<{ status: string }>('/auth/verify-email', { token }, open),
  resendVerification: (email: string) => c.post<{ status: 'SENT_IF_REGISTERED'; dev?: DevTokens }>('/auth/resend-verification', { email }, open),

  forgotPassword: (body: Omit<In<typeof forgotPasswordSchema>, 'app'>) =>
    c.post<{ status: 'SENT_IF_REGISTERED'; dev?: DevTokens }>('/auth/password/forgot', { ...body, app: c.app }, open),
  resetPassword: (body: In<typeof resetPasswordSchema>) => c.post<{ status: 'PASSWORD_UPDATED' }>('/auth/password/reset', body, open),
  changePassword: (body: In<typeof changePasswordSchema>) => c.post<{ status: 'PASSWORD_UPDATED' }>('/auth/password/change', body),

  mfaSetup: () => c.post<MfaSetup>('/auth/mfa/setup'),
  mfaEnable: (code: string) => c.post<{ status: 'MFA_ENABLED'; recoveryCodes: string[] }>('/auth/mfa/enable', { code }),
  mfaDisable: (body: In<typeof mfaDisableSchema>) => c.post<{ status: 'MFA_DISABLED' }>('/auth/mfa/disable', body),

  /** The signed-in person's live sessions, most recent first (the current one is always in the list, `current: true`). */
  sessions: (query?: SessionListQuery) => c.get<AuthSessionRow[]>('/auth/sessions', { query }),
  /** The same list together with how many live sessions there are in all (header `X-Total-Count`). */
  sessionsPage: async (query?: SessionListQuery): Promise<{ sessions: AuthSessionRow[]; total: number }> => {
    const { data, headers } = await c.requestWithHeaders<AuthSessionRow[]>('GET', '/auth/sessions', { query });
    const total = Number(headers.get('x-total-count'));
    // An older API (or a proxy that drops the header) answers without it: what was returned is all we know of.
    return { sessions: data, total: headers.has('x-total-count') && Number.isFinite(total) ? Math.max(total, data.length) : data.length };
  },
  revokeSession: (id: string) => c.delete<{ status: 'REVOKED' }>(`/auth/sessions/${id}`),
  revokeOtherSessions: () => c.post<{ revoked: number }>('/auth/sessions/revoke-others'),

  /**
   * Support session hand-off (staff app, page /support-session): exchanges the one-time code from the
   * platform console for a session and installs it exactly like a sign-in (access token in memory, refresh
   * cookie set by the API). Rejects with HANDOFF_INVALID, SUPPORT_ACCESS_ENDED, TENANT_UNAVAILABLE ...
   * With a bare client (no session manager attached) the result is only returned.
   */
  exchangeSupportSession: (code: string): Promise<LoginOk> =>
    session.exchangeSupportSession ? session.exchangeSupportSession(code) : c.post<LoginOk>('/auth/support-session/exchange', { code }, open),

  previewInvitation: (token: string) => c.get<InvitationPreview>('/auth/invitations/preview', { query: { token }, ...open }),
  acceptInvitation: (body: Omit<In<typeof acceptInvitationSchema>, 'app'>) => c.post<LoginResult>('/auth/invitations/accept', { ...body, app: c.app }, open),
});
