'use client';

import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { AppShell, Input, PageSkeleton, RequireAuth, TENANT_COOKIE, useApi, useBranding, useI18n, useSession } from '@typease/ui';
import { ROUTES } from '@/lib/config';
import { NAV } from '@/lib/nav';
import { keys } from '@/lib/query-keys';
import { BranchProvider, BranchSwitcher } from './branch';

/** Search field of the top bar: finds requests by customer name, mobile or request number. */
function GlobalSearch() {
  const { t } = useI18n();
  const router = useRouter();
  const [q, setQ] = React.useState('');
  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const query = q.trim();
        if (query) router.push(`/requests?q=${encodeURIComponent(query)}`);
      }}
    >
      <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('dashboard.searchPlaceholder')} aria-label={t('dashboard.searchPlaceholder')} startAdornment={<Search aria-hidden="true" />} className="[&::-webkit-search-cancel-button]:hidden" />
    </form>
  );
}

/**
 * White-label centres see their own brand in the staff app. After sign-in the
 * centre's presentation is loaded and applied; its slug is remembered in a
 * cookie so the server can paint the right colours on the next full load.
 */
function StaffBranding() {
  const api = useApi();
  const session = useSession();
  const { setConfig } = useBranding();
  const slug = session.tenant?.slug;
  const config = useQuery({ queryKey: keys.tenantConfig(slug ?? ''), queryFn: () => api.public.tenantConfig({ slug }), enabled: !!slug, staleTime: 10 * 60_000 });
  React.useEffect(() => {
    if (config.data) setConfig(config.data);
  }, [config.data, setConfig]);
  React.useEffect(() => {
    if (slug) document.cookie = `${TENANT_COOKIE}=${slug}; path=/; max-age=31536000; samesite=lax`;
  }, [slug]);
  return null;
}

/**
 * How many notifications the signed-in person has not read: GET /me/notifications?pageSize=1 answers
 * `unreadCount`. Asked once a minute while the tab is visible and when the window gets focus again;
 * between two questions the bell follows the inbox page, which keeps its own count up to date.
 */
function useUnreadNotifications(): number {
  const api = useApi();
  const queryClient = useQueryClient();
  const unread = useQuery({
    queryKey: keys.unreadNotifications,
    queryFn: async ({ signal }) => (await api.client.get<{ unreadCount?: number }>('/me/notifications', { query: { pageSize: 1 }, signal })).unreadCount ?? 0,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
    // The bell must never be the reason a screen shows an error.
    retry: false,
  });

  // The inbox marks messages as read in its own cached pages: take the count from there the moment it changes.
  React.useEffect(() => {
    const cache = queryClient.getQueryCache();
    return cache.subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'success') return;
      const key = event.query.queryKey;
      if (key[0] !== keys.unreadNotifications[0] || key[1] === keys.unreadNotifications[1]) return;
      const count = (event.query.state.data as { unreadCount?: unknown } | undefined)?.unreadCount;
      if (typeof count === 'number' && count !== queryClient.getQueryData(keys.unreadNotifications)) queryClient.setQueryData(keys.unreadNotifications, count);
    });
  }, [queryClient]);

  return unread.data ?? 0;
}

/** Paths a centre that is still being set up may use besides the wizard: the person's own account (password, two-step verification). */
const OPEN_DURING_ONBOARDING = ['/onboarding', '/account'];

/**
 * A centre whose status is ONBOARDING has not finished its set-up. Whoever may change the centre's
 * settings is taken to the wizard from every other screen until it is complete; colleagues without
 * that permission work normally (they cannot finish the set-up anyway).
 *
 * The wizard reloads the session when it finishes. Should the session still say ONBOARDING although
 * GET /onboarding reports the set-up as complete (finished in another tab), the session is reloaded here.
 */
function OnboardingGate({ children }: { children: React.ReactNode }) {
  const api = useApi();
  const session = useSession();
  const router = useRouter();
  const pathname = usePathname() ?? '/';
  const { t } = useI18n();

  const pending = session.tenant?.status === 'ONBOARDING' && session.hasPermission('settings.manage');
  const state = useQuery({ queryKey: keys.onboarding, queryFn: () => api.client.get<{ completed: boolean }>('/onboarding'), enabled: pending, staleTime: 30_000, retry: false });
  const completed = state.data?.completed === true;
  const exempt = OPEN_DURING_ONBOARDING.some((path) => pathname === path || pathname.startsWith(`${path}/`));
  // If the question itself fails, the session's word counts: the wizard shows what went wrong.
  const mustOnboard = pending && !exempt && !completed && !state.isPending;

  const { reload } = session;
  React.useEffect(() => {
    if (pending && completed) void reload();
  }, [pending, completed, reload]);
  React.useEffect(() => {
    if (mustOnboard) router.replace(ROUTES.onboarding);
  }, [mustOnboard, router]);

  // No flash of a screen the person is about to be taken away from.
  if (pending && !exempt && !completed) return <PageSkeleton label={t('common.loading')} />;
  return <>{children}</>;
}

function Shell({ children }: { children: React.ReactNode }) {
  const unread = useUnreadNotifications();
  return (
    <AppShell
      nav={NAV}
      homeHref={ROUTES.home}
      search={<GlobalSearch />}
      branchSwitcher={<BranchSwitcher />}
      notificationsHref={ROUTES.notifications}
      notificationsCount={unread}
      profileHref={ROUTES.profile}
      securityHref={ROUTES.security}
    >
      <OnboardingGate>{children}</OnboardingGate>
    </AppShell>
  );
}

export function StaffShell({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth kinds={['STAFF']} mfaSetupPath={ROUTES.security}>
      <BranchProvider>
        <StaffBranding />
        <Shell>{children}</Shell>
      </BranchProvider>
    </RequireAuth>
  );
}
