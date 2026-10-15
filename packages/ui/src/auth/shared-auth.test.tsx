/**
 * Shared auth / account components and the support-session bar, exercised against a scripted API.
 * Each block names the defect or feature it covers.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PublicTenantConfig, SessionInfo, SupportGrant } from '@typease/types';
import { apiError, json, mockFetch, type RecordedCall } from '../../../api-client/src/test-helpers';
import { I18nProvider, leafKeys, lookup, mergeDictionaries, translate, uiDictionaries, type Dictionaries } from '../i18n';
import { ThemeProvider } from '../providers/theme';
import { BrandingProvider } from '../providers/branding';
import { AuthProvider, useApi } from '../providers/auth';
import { TooltipProvider } from '../components/menus';
import { Toaster } from '../components/toast';
import { DataTable } from '../data-table/data-table';
import { DEFAULT_PASSWORD_POLICY, passwordHint, passwordSchema, resolvePasswordPolicy } from '../lib/password-policy';
import { localiseValidationMessage } from '../lib/validation-messages';
import { RequireAuth, RequirePermission } from '../shell/require-auth';
import { SupportSessionBanner, formatCountdown } from '../shell/support-session';
import { MfaSetupPanel, otpauthUrlFor } from './mfa-setup';
import { ChangePasswordForm, ResetPasswordForm } from './password';
import { SessionsPanel } from './sessions';
import { SignInFlow } from './sign-in';

const router = { push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/customers', useSearchParams: () => new URLSearchParams() }));

// ---------------------------------------------------------------------------------------------------------------------
const staff: SessionInfo = {
  user: { id: 'u1', email: 'noor@example.ae', phone: null, fullName: 'Noor Al Mansoori', preferredLanguage: 'en', platformRole: null, mfaEnabled: false, emailVerified: true, phoneVerified: false },
  tenant: { id: 't1', slug: 'al-noor', name: 'Al Noor Typing Centre', status: 'ACTIVE', timezone: 'Asia/Dubai', currency: 'AED' },
  membership: { id: 'm1', kind: 'STAFF', roleKey: 'receptionist', roleName: 'Receptionist', allBranches: true, branchIds: [], customerId: null, corporateAccountId: null },
  permissions: ['customer.read'],
  supportGrant: null,
  mfaRequiredSetup: false,
};
const grantUntil = (ms: number): SupportGrant => ({
  id: 'g1',
  scopes: ['customer.read', 'invoice.read', 'request.update'],
  writeScopes: ['request.update'],
  readOnly: true,
  startsAt: new Date(Date.now() - 60_000).toISOString(),
  expiresAt: new Date(Date.now() + ms).toISOString(),
  tenantId: 't1',
  tenantName: 'Alpha Typing',
  reason: 'Customer reports a missing invoice PDF',
});
const support = (ms: number): SessionInfo => ({
  ...staff,
  user: { ...staff.user, fullName: 'Sara Support', email: 'sara@typease.example', platformRole: 'SUPPORT_AGENT' },
  tenant: { ...staff.tenant!, name: 'Alpha Typing', slug: 'alpha' },
  membership: null,
  permissions: ['customer.read', 'invoice.read', 'request.update'],
  supportGrant: grantUntil(ms),
});
const login = (session: SessionInfo) => json(200, { status: 'OK', accessToken: 'access-1', expiresIn: 900, session, landing: '/' });

const whiteLabel: PublicTenantConfig = {
  tenantId: 't1', slug: 'al-noor', name: 'Al Noor Typing Centre', nameAr: 'مركز النور للطباعة', mode: 'WHITE_LABEL', logoUrl: null, faviconUrl: null,
  colors: { primary: '#5B1A3C', secondary: '#B4532A', accent: '#C8962E' }, websiteTitle: 'Al Noor', tagline: null, supportEmail: null, supportPhone: null,
  defaultLanguage: 'en', currency: 'AED', timezone: 'Asia/Dubai', publicCatalogueEnabled: true, features: {},
};

type Handler = (call: RecordedCall) => Response | Promise<Response> | undefined;
/** Mounts `ui` inside the real provider stack; `handler` answers the API calls (undefined = 404). */
function mount(ui: React.ReactElement, options: { handler?: Handler; session?: SessionInfo | null; locale?: 'en' | 'ar'; tenant?: PublicTenantConfig | null; dictionaries?: Dictionaries; strict?: boolean } = {}) {
  const { handler, session = staff, locale = 'en', tenant = null, dictionaries = uiDictionaries, strict = false } = options;
  const api = mockFetch(async (call) => {
    const own = await handler?.(call);
    if (own) return own;
    if (call.url.endsWith('/auth/refresh')) return session ? login(session) : apiError(401, 'SESSION_EXPIRED');
    if (call.url.endsWith('/auth/logout')) return json(200, { status: 'SIGNED_OUT' });
    if (call.url.endsWith('/auth/me')) return session ? json(200, session) : apiError(401, 'SESSION_EXPIRED');
    return apiError(404, 'NOT_FOUND', `No answer scripted for ${call.method} ${call.url}`);
  });
  vi.stubGlobal('fetch', api.fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (
    <I18nProvider locale={locale} dictionaries={dictionaries}>
      <ThemeProvider>
        <QueryClientProvider client={client}>
          <BrandingProvider config={tenant}>
            <AuthProvider app="centre" apiBaseUrl="http://api.test">
              <TooltipProvider>
                {ui}
                <Toaster />
              </TooltipProvider>
            </AuthProvider>
          </BrandingProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </I18nProvider>
  );
  return { ...render(strict ? <React.StrictMode>{tree}</React.StrictMode> : tree), calls: api.calls };
}
const path = (call: RecordedCall) => call.url.replace('http://api.test/api/v1', '');
const pause = (ms = 20) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // One real BroadcastChannel per test process would let the "tabs" of different tests talk to each other.
  vi.stubGlobal('BroadcastChannel', undefined);
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  router.replace.mockClear();
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  errors.mockRestore();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------------------------------------------------
describe('SessionsPanel: a bounded list, the total, and "sign out all other devices" behind a confirmation', () => {
  const row = (n: number, current = false) => ({
    id: `s${n}`, app: 'centre', tenantId: 't1', deviceName: null, userAgent: `Mozilla/5.0 (Windows NT 10.0) Chrome/126.${n} Safari/537.36`, ip: `10.0.0.${n}`,
    createdAt: '2026-10-01T08:00:00.000Z', lastUsedAt: new Date(Date.UTC(2026, 9, 9, 9, 0, 0) - n * 60_000).toISOString(), expiresAt: '2026-11-09T09:00:00.000Z', supportSession: false, current,
  });
  /** 37 live sessions; the current one is the 30th most recent, so it is NOT among the newest. */
  const all = Array.from({ length: 37 }, (_, i) => row(i + 1, i + 1 === 30));
  const sessionsHandler = (revoked: { others: boolean }): Handler => (call) => {
    if (call.url.includes('/auth/sessions/revoke-others')) {
      revoked.others = true;
      return json(200, { revoked: 36 });
    }
    if (!call.url.includes('/auth/sessions')) return undefined;
    if (revoked.others) return json(200, [row(30, true)], { 'X-Total-Count': '1' });
    const limit = Number(new URL(call.url).searchParams.get('limit') ?? 20);
    const current = all.find((r) => r.current)!;
    const newest = all.filter((r) => !r.current).slice(0, limit - 1);
    // the API's order: most recent first, the current one wherever it falls
    return json(200, [...newest, current].sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt)), { 'X-Total-Count': String(all.length) });
  };

  it('shows this device first, then ten more, with the total and "Show more"', async () => {
    const revoked = { others: false };
    const view = mount(<SessionsPanel />, { handler: sessionsHandler(revoked) });
    const items = await screen.findAllByRole('listitem');
    // the first request asks for the current session plus ten
    const first = view.calls.find((c) => path(c).startsWith('/auth/sessions'))!;
    expect(path(first)).toBe('/auth/sessions?limit=11');
    expect(items).toHaveLength(11);
    expect(within(items[0]).getByText('This device')).toBeTruthy();
    expect(within(items[1]).getByText('10.0.0.1')).toBeTruthy();
    expect(screen.getByText('Showing 11 of 37 signed-in devices')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(31));
    expect(view.calls.some((c) => path(c) === '/auth/sessions?limit=31')).toBe(true);
    expect(within(screen.getAllByRole('listitem')[0]).getByText('This device')).toBeTruthy();
    expect(screen.getByText('Showing 31 of 37 signed-in devices')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(37));
    // everything is listed: no counter, no "Show more"
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    expect(screen.queryByText(/Showing/)).toBeNull();
  });

  it('asks before signing out all other devices, says how many, and resets the list afterwards', async () => {
    const revoked = { others: false };
    const view = mount(<SessionsPanel />, { handler: sessionsHandler(revoked) });
    await screen.findAllByRole('listitem');
    fireEvent.click(screen.getByRole('button', { name: 'Sign out all other devices' }));
    const dialog = await screen.findByRole('alertdialog');
    // 36 others, although only ten of them are on screen
    expect(within(dialog).getByText(/36 other devices are signed in\. Every device except this one will have to sign in again\./)).toBeTruthy();
    expect(view.calls.some((c) => path(c) === '/auth/sessions/revoke-others')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out all other devices' }));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
    expect(view.calls.filter((c) => path(c) === '/auth/sessions/revoke-others' && c.method === 'POST')).toHaveLength(1);
    expect(await screen.findByText('36 other devices were signed out.')).toBeTruthy();
    expect(screen.getByText('No other devices are signed in.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign out all other devices' })).toBeNull();
  });

  it('says so when there are more sessions than the API lists', async () => {
    const many = Array.from({ length: 100 }, (_, i) => row(i + 1, i === 0));
    mount(<SessionsPanel />, { handler: (call) => (call.url.includes('/auth/sessions') ? json(200, many.slice(0, Number(new URL(call.url).searchParams.get('limit'))), { 'X-Total-Count': '240' }) : undefined) });
    await screen.findAllByRole('listitem');
    for (let i = 0; i < 5; i++) {
      const more = screen.queryByRole('button', { name: 'Show more' });
      if (!more) break;
      fireEvent.click(more);
      await pause(30);
    }
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(100));
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    expect(screen.getByText(/Only the 100 most recently used devices are listed/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('ChangePasswordForm', () => {
  const fill = (label: RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
  const wrongCurrent: Handler = (call) => (call.url.endsWith('/auth/password/change') ? apiError(400, 'INVALID_CREDENTIALS', 'Your current password is not correct.') : undefined);

  it.each([
    ['en', /Current password/, /^New password/, /Repeat the new password/, 'Change password', 'The current password is not correct.'],
    ['ar', /كلمة المرور الحالية/, /^كلمة المرور الجديدة/, /أعد كتابة كلمة المرور الجديدة/, 'تغيير كلمة المرور', 'كلمة المرور الحالية غير صحيحة.'],
  ] as const)('reports a wrong CURRENT password on that field (%s)', async (locale, current, next, confirm, submit, message) => {
    mount(<ChangePasswordForm />, { handler: wrongCurrent, locale });
    await pause();
    fill(current, 'Wrong-Password-1');
    fill(next, 'New-Password-2026');
    fill(confirm, 'New-Password-2026');
    fireEvent.click(screen.getByRole('button', { name: submit }));
    const field = screen.getByLabelText(current) as HTMLInputElement;
    await waitFor(() => expect(field.getAttribute('aria-invalid')).toBe('true'));
    expect(document.getElementById(field.getAttribute('aria-describedby') as string)?.textContent).toBe(message);
    // only there: no general alert about "email or password", and the other fields are not blamed
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(/email or password|البريد الإلكتروني أو كلمة المرور/);
    expect((screen.getByLabelText(next) as HTMLInputElement).getAttribute('aria-invalid')).toBe('false');
    // what was typed stays
    expect(field.value).toBe('Wrong-Password-1');
  });

  it('uses the password policy the centre publishes: hint and check before the request', async () => {
    const view = mount(<ChangePasswordForm />, { tenant: { ...whiteLabel, passwordPolicy: { minLength: 14, maxLength: 64, requires: ['lowercase', 'digit'] } } });
    await pause();
    expect(screen.getByText('At least 14 characters, with a lower-case letter and a number.')).toBeTruthy();
    fill(/Current password/, 'Old-Password-1');
    fill(/^New password/, 'short1');
    fill(/Repeat the new password/, 'short1');
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('Use at least 14 characters')).toBeTruthy();
    expect(view.calls.some((c) => c.url.endsWith('/auth/password/change'))).toBe(false);
    // 14 lower-case letters and a digit pass this policy (no upper-case letter is asked for)
    fill(/^New password/, 'longenoughpass1');
    fill(/Repeat the new password/, 'longenoughpass1');
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    await waitFor(() => expect(view.calls.some((c) => c.url.endsWith('/auth/password/change'))).toBe(true));
  });

  it('falls back to the built-in rules without a published policy (reset form)', async () => {
    mount(<ResetPasswordForm token="reset-token-0123456789" signInHref="/sign-in" forgotHref="/forgot-password" />, { session: null });
    expect(await screen.findByText('At least 10 characters, with upper-case and lower-case letters and a number.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^New password/), { target: { value: 'alllowercase1' } });
    fireEvent.blur(screen.getByLabelText(/^New password/));
    expect(await screen.findByText('Include an upper-case letter, a lower-case letter and a number')).toBeTruthy();
  });
});

describe('password policy helpers', () => {
  const en = { t: (key: string, vars?: Record<string, string | number>) => translate(uiDictionaries, 'en', key, vars) };
  const ar = { t: (key: string, vars?: Record<string, string | number>) => translate(uiDictionaries, 'ar', key, vars) };
  it('tidies what the API publishes and falls back to the built-in rules', () => {
    expect(resolvePasswordPolicy(undefined)).toEqual(DEFAULT_PASSWORD_POLICY);
    expect(resolvePasswordPolicy(null)).toEqual(DEFAULT_PASSWORD_POLICY);
    expect(resolvePasswordPolicy({ minLength: 12, maxLength: 128, requires: ['digit', 'uppercase'] })).toEqual({ minLength: 12, maxLength: 128, requires: ['uppercase', 'digit'] });
    // nonsense values do not weaken or break the form
    expect(resolvePasswordPolicy({ minLength: -3, maxLength: 0, requires: ['emoji'] as never })).toEqual({ minLength: 10, maxLength: 128, requires: [] });
  });
  it('checks exactly the published rules', () => {
    const schema = passwordSchema({ minLength: 12, maxLength: 20, requires: ['uppercase', 'digit'] });
    const problem = (value: string) => schema.safeParse(value).error?.issues[0]?.message;
    expect(problem('Short1')).toBe('Use at least 12 characters');
    expect(problem('LONGENOUGHBUTNODIGIT')).toBe('PASSWORD_NEEDS:uppercase_digit');
    expect(problem('A2345678901234567890X')).toBe('Use at most 20 characters');
    expect(schema.safeParse('NOLOWERCASE12').success).toBe(true);
    expect(passwordSchema().safeParse('TypEase-Demo-2026').success).toBe(true);
    expect(passwordSchema().safeParse('nouppercase1').success).toBe(false);
  });
  it('words the hint and the messages in both languages, for any minimum the API sends', () => {
    expect(passwordHint({ minLength: 12, maxLength: 128, requires: ['lowercase', 'uppercase', 'digit'] }, en)).toBe('At least 12 characters, with upper-case and lower-case letters and a number.');
    expect(passwordHint({ minLength: 12, maxLength: 128, requires: [] }, en)).toBe('At least 12 characters.');
    expect(passwordHint(null, ar)).toContain('10');
    expect(passwordHint(null, ar)).toMatch(/[؀-ۿ]/);
    // the API's own sentence for a raised minimum is translated too
    expect(localiseValidationMessage('Use at least 12 characters', en)).toBe('Use at least 12 characters');
    expect(localiseValidationMessage('Use at least 12 characters', ar)).toContain('12');
    expect(localiseValidationMessage('Use at least 12 characters', ar)).toMatch(/[؀-ۿ]/);
    expect(localiseValidationMessage('PASSWORD_NEEDS:lowercase_digit', en)).toBe('Include a lower-case letter and a number');
    expect(localiseValidationMessage('PASSWORD_NEEDS:lowercase_uppercase_digit', ar)).toMatch(/[؀-ۿ]/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('SignInFlow: one message for an unverified email', () => {
  it('shows a single alert with the action to send the email again', async () => {
    const view = mount(<SignInFlow onSignedIn={() => undefined} forgotHref="/forgot-password" />, {
      session: null,
      handler: (call) => {
        if (call.url.endsWith('/auth/login')) return apiError(403, 'EMAIL_NOT_VERIFIED', 'Please verify your email address first.');
        if (call.url.endsWith('/auth/resend-verification')) return json(200, { status: 'SENT_IF_REGISTERED' });
        return undefined;
      },
    });
    fireEvent.change(await screen.findByLabelText(/Email address/), { target: { value: 'aisha@example.test' } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: 'Some-Password-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    const alert = await screen.findByRole('alert');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(within(alert).getByText('Confirm your email address first')).toBeTruthy();
    // the password is not kept, the email is
    expect((screen.getByLabelText(/^Password/) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/Email address/) as HTMLInputElement).value).toBe('aisha@example.test');

    fireEvent.click(within(alert).getByRole('button', { name: 'Send the email again' }));
    await waitFor(() => expect(view.calls.some((c) => c.url.endsWith('/auth/resend-verification') && (c.body as { email: string }).email === 'aisha@example.test')).toBe(true));
    // the warning is replaced by the confirmation: still one message
    expect(await screen.findByText('If the address is registered, a new link is on its way.')).toBeTruthy();
    expect(screen.queryByText('Confirm your email address first')).toBeNull();
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('still shows other sign-in failures as the form message', async () => {
    mount(<SignInFlow onSignedIn={() => undefined} forgotHref="/forgot-password" />, {
      session: null,
      handler: (call) => (call.url.endsWith('/auth/login') ? apiError(401, 'INVALID_CREDENTIALS', 'The email or password is incorrect.') : undefined),
    });
    fireEvent.change(await screen.findByLabelText(/Email address/), { target: { value: 'aisha@example.test' } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: 'Some-Password-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('The email or password is not correct. Check them and try again.')).toBeTruthy();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('brand names: a centre\'s users never read "TypEase" in shared screens', () => {
  const setup: Handler = (call) => (call.url.endsWith('/auth/mfa/setup') ? json(200, { secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/TypEase:noor%40example.ae?secret=JBSWY3DPEHPK3PXP&period=30&digits=6&algorithm=SHA1&issuer=TypEase' }) : undefined);

  it('MfaSetupPanel speaks of the centre in a white-label app', async () => {
    mount(<MfaSetupPanel />, { handler: setup, tenant: whiteLabel });
    fireEvent.click(await screen.findByRole('button', { name: 'Start setup' }));
    expect(await screen.findByText('Type the code the app shows for Al Noor Typing Centre to finish.')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'QR code to add Al Noor Typing Centre to your authenticator app' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('TypEase');
  });
  it('... in Arabic with the Arabic name of the centre', async () => {
    mount(<MfaSetupPanel />, { handler: setup, tenant: whiteLabel, locale: 'ar' });
    await pause();
    fireEvent.click(screen.getAllByRole('button')[0]);
    await waitFor(() => expect(document.body.textContent).toContain('مركز النور للطباعة'));
    expect(document.body.textContent).not.toContain('TypEase');
  });
  it('... and of TypEase where there is no centre brand (platform console, TypEase-branded centre)', async () => {
    mount(<MfaSetupPanel />, { handler: setup, tenant: { ...whiteLabel, mode: 'TYPEASE' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Start setup' }));
    expect(await screen.findByText('Type the code the app shows for TypEase to finish.')).toBeTruthy();
  });
  it('labels the authenticator entry with the centre, without touching the secret', () => {
    const original = 'otpauth://totp/TypEase:noor%40example.ae?secret=JBSWY3DPEHPK3PXP&period=30&digits=6&algorithm=SHA1&issuer=TypEase';
    const url = otpauthUrlFor(original, 'Al Noor Typing Centre');
    expect(url.startsWith('otpauth://totp/Al%20Noor%20Typing%20Centre:noor%40example.ae?')).toBe(true);
    const params = new URLSearchParams(url.split('?')[1]);
    expect(Object.fromEntries(params)).toEqual({ secret: 'JBSWY3DPEHPK3PXP', period: '30', digits: '6', algorithm: 'SHA1', issuer: 'Al Noor Typing Centre' });
    expect(url).not.toContain('+');
    expect(otpauthUrlFor(original, 'TypEase')).toBe(original);
    expect(otpauthUrlFor('not-an-otpauth-link', 'Al Noor')).toBe('not-an-otpauth-link');
    expect(otpauthUrlFor(original, 'مركز النور')).toContain(`issuer=${encodeURIComponent('مركز النور')}`);
  });
  it('keeps "TypEase" out of the shared texts, except where TypEase itself is the subject', () => {
    // Texts about TypEase as a company or about TypEase staff: centre sign-up, the platform, support sessions.
    const allowed = new Set([
      'apiErrors.SIGNUP_CLOSED', 'apiErrors.PLATFORM_ONLY', 'auth.signup.acceptTerms', 'auth.sessions.supportSession',
      'supportSession.readOnly', 'supportSession.readWrite', 'supportSession.endedHint',
    ]);
    for (const dictionary of [uiDictionaries.en, uiDictionaries.ar]) {
      const offenders = leafKeys(dictionary).filter((key) => String(lookup(dictionary, key)).includes('TypEase') && !allowed.has(key));
      expect(offenders).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('no-access state: app-neutral by default, each app may word its own', () => {
  it.each([
    ['en', 'Your role does not include this area. Ask an administrator if you need it.'],
    ['ar', 'دورك لا يشمل هذا القسم. اطلب ذلك من أحد المسؤولين إذا كنت بحاجة إليه.'],
  ] as const)('does not send people to a "centre owner" (%s)', async (locale, text) => {
    mount(<RequirePermission anyOf={['invoice.read']}>secret</RequirePermission>, { locale });
    expect(await screen.findByText(text)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/centre owner|مالك المركز/);
    expect(screen.queryByText('secret')).toBeNull();
  });
  it('takes the wording of the app\'s dictionary when there is one', async () => {
    const app = mergeDictionaries(uiDictionaries, { en: { session: { noPermissionDescription: 'Ask a super admin if you need it.' } }, ar: { session: { noPermissionDescription: 'اطلب ذلك من مدير عام.' } } });
    mount(<RequirePermission anyOf={['platform.plans.manage']}>secret</RequirePermission>, { dictionaries: app });
    expect(await screen.findByText('Ask a super admin if you need it.')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('DataTable under React StrictMode (development)', () => {
  it('keeps initialFilterValues although every effect runs twice', async () => {
    const queryFn = vi.fn(async (_params: Record<string, unknown>) => ({ data: [{ id: '1', name: 'Ahmed Khalid' }], meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 } }));
    const onFilterValuesChange = vi.fn();
    mount(
      <DataTable
        caption="Invoices"
        queryKey={['strict']}
        queryFn={queryFn}
        columns={[{ id: 'name', header: 'Name', cell: (r: { id: string; name: string }) => r.name, mobile: 'title' as const }]}
        rowKey={(r) => r.id}
        initialFilterValues={{ status: 'UNPAID' }}
        onFilterValuesChange={onFilterValuesChange}
      />,
      { strict: true },
    );
    await waitFor(() => expect(queryFn).toHaveBeenCalled());
    await pause(40);
    // every request carried the preset, and the URL shows it
    expect(queryFn.mock.calls.every((call) => call[0].status === 'UNPAID')).toBe(true);
    expect(window.location.search).toBe('?status=UNPAID');
    expect(onFilterValuesChange).toHaveBeenLastCalledWith({ status: 'UNPAID' });
    expect(errors).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('support session', () => {
  it('formats the countdown as a clock', () => {
    expect(formatCountdown(29 * 60_000 + 41_000)).toBe('29:41');
    expect(formatCountdown(3_727_000)).toBe('1:02:07');
    expect(formatCountdown(400)).toBe('0:01');
    expect(formatCountdown(-5)).toBe('0:00');
  });

  it('shows a permanent bar with centre, access level, countdown and scopes; nothing for ordinary sessions', async () => {
    const view = mount(
      <RequireAuth kinds={['STAFF']}>
        <SupportSessionBanner />
        <p>inside the app</p>
      </RequireAuth>,
      { session: support(29 * 60_000 + 41_000) },
    );
    // a support session has no membership, and still gets into an app for staff
    expect(await screen.findByText('inside the app')).toBeTruthy();
    const bar = screen.getByRole('region', { name: 'Support session' });
    expect(within(bar).getByText(/^TypEase support session: read-only access to Alpha Typing until /)).toBeTruthy();
    expect(within(bar).getByText(/^29:\d\d left$/)).toBeTruthy();
    // no way to dismiss it
    expect(within(bar).queryByRole('button', { name: /close|dismiss|hide/i })).toBeNull();
    expect(within(bar).getAllByRole('button').map((b) => b.textContent)).toEqual(['What this session can see', 'End session']);

    fireEvent.click(within(bar).getByRole('button', { name: 'What this session can see' }));
    const scopes = await screen.findByRole('dialog');
    expect(within(scopes).getByText('customer.read')).toBeTruthy();
    expect(within(scopes).getByText('request.update')).toBeTruthy();
    expect(within(scopes).getAllByText('View only')).toHaveLength(2);
    expect(within(scopes).getAllByText('Can change')).toHaveLength(1);
    expect(within(scopes).getByText('Customer reports a missing invoice PDF')).toBeTruthy();
    view.unmount();

    mount(
      <RequireAuth kinds={['STAFF']}>
        <SupportSessionBanner />
        <p>inside the app</p>
      </RequireAuth>,
    );
    expect(await screen.findByText('inside the app')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Support session' })).toBeNull();
  });

  it('is in Arabic for an Arabic reader', async () => {
    mount(
      <RequireAuth kinds={['STAFF']}>
        <SupportSessionBanner />
      </RequireAuth>,
      { session: support(10 * 60_000), locale: 'ar' },
    );
    const bar = await screen.findByRole('region', { name: 'جلسة دعم' });
    expect(within(bar).getByText(/^جلسة دعم من TypEase: وصول للقراءة فقط إلى Alpha Typing حتى /)).toBeTruthy();
    expect(within(bar).getByRole('button', { name: 'إنهاء الجلسة' })).toBeTruthy();
  });

  it('"End session" signs out and shows the ended page instead of a sign-in', async () => {
    const view = mount(
      <RequireAuth kinds={['STAFF']}>
        <SupportSessionBanner />
        <p>inside the app</p>
      </RequireAuth>,
      { session: support(10 * 60_000) },
    );
    fireEvent.click(await screen.findByRole('button', { name: 'End session' }));
    expect(await screen.findByRole('heading', { name: 'This support session has ended' })).toBeTruthy();
    expect(screen.getByText(/Access to Alpha Typing was limited in time and is now closed/)).toBeTruthy();
    expect(view.calls.some((c) => c.url.endsWith('/auth/logout'))).toBe(true);
    expect(screen.queryByText('inside the app')).toBeNull();
    // not sent to the sign-in page of the centre
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('shows the ended page when the grant runs out: the server is asked at that moment and answers SUPPORT_ACCESS_ENDED', async () => {
    let expired = false;
    const view = mount(
      <RequireAuth kinds={['STAFF']}>
        <SupportSessionBanner />
        <p>inside the app</p>
      </RequireAuth>,
      { session: support(1200), handler: (call) => (expired && call.url.endsWith('/auth/me') ? apiError(401, 'SUPPORT_ACCESS_ENDED', 'Support access has ended.') : undefined) },
    );
    expect(await screen.findByText('inside the app')).toBeTruthy();
    expect(view.calls.some((c) => c.url.endsWith('/auth/me'))).toBe(false);
    expired = true;
    expect(await screen.findByRole('heading', { name: 'This support session has ended' }, { timeout: 4000 })).toBeTruthy();
    expect(view.calls.some((c) => c.url.endsWith('/auth/me'))).toBe(true);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('closes the session on this device when the server cannot be reached two minutes after the end', async () => {
    const view = mount(
      <RequireAuth kinds={['STAFF']}>
        <SupportSessionBanner />
        <p>inside the app</p>
      </RequireAuth>,
      {
        session: support(-3 * 60_000),
        handler: (call) => {
          if (call.url.endsWith('/auth/me')) throw new TypeError('Failed to fetch');
          return undefined;
        },
      },
    );
    expect(await screen.findByRole('heading', { name: 'This support session has ended' })).toBeTruthy();
    expect(screen.queryByText('inside the app')).toBeNull();
    expect(view.calls.some((c) => c.url.endsWith('/auth/me'))).toBe(true);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('keeps the session when this device\'s clock is fast and the server still confirms it', async () => {
    const session = support(-30_000);
    mount(
      <RequireAuth kinds={['STAFF']}>
        <SupportSessionBanner />
        <p>inside the app</p>
      </RequireAuth>,
      { session },
    );
    expect(await screen.findByText('inside the app')).toBeTruthy();
    await pause(150);
    expect(screen.getByRole('region', { name: 'Support session' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'This support session has ended' })).toBeNull();
  });

  it('shows the ended page when any call answers 403 SUPPORT_ACCESS_ENDED (revoked by the centre)', async () => {
    function Caller() {
      const api = useApi();
      return <button onClick={() => void api.client.get('/customers').catch(() => undefined)}>load customers</button>;
    }
    mount(
      <RequireAuth kinds={['STAFF']}>
        <SupportSessionBanner />
        <Caller />
      </RequireAuth>,
      { session: support(10 * 60_000), handler: (call) => (call.url.endsWith('/customers') ? apiError(403, 'SUPPORT_ACCESS_ENDED', 'Support access has ended.') : undefined) },
    );
    fireEvent.click(await screen.findByRole('button', { name: 'load customers' }));
    expect(await screen.findByRole('heading', { name: 'This support session has ended' })).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('an ordinary session that ends still gets the usual "sign in again"', async () => {
    function Caller() {
      const api = useApi();
      return <button onClick={() => void api.client.get('/customers').catch(() => undefined)}>load customers</button>;
    }
    mount(
      <RequireAuth kinds={['STAFF']}>
        <Caller />
      </RequireAuth>,
      { handler: (call) => (call.url.endsWith('/customers') ? apiError(401, 'SESSION_EXPIRED') : undefined) },
    );
    fireEvent.click(await screen.findByRole('button', { name: 'load customers' }));
    expect(await screen.findByRole('heading', { name: 'Your session has ended' })).toBeTruthy();
    expect(screen.queryByText('This support session has ended')).toBeNull();
  });
});
