'use client';

import { useQuery } from '@tanstack/react-query';
import { AppShell, RequireAuth, useSession } from '@typease/ui';
import { usePortalApi } from '@/lib/api';
import { ROUTES } from '@/lib/config';
import { NAV } from '@/lib/nav';
import { keys } from '@/lib/query-keys';

/** Unread notifications for the bell; asked once a session exists and refreshed now and then. */
function Shell({ children }: { children: React.ReactNode }) {
  const api = usePortalApi();
  const session = useSession();
  const unread = useQuery({
    queryKey: keys.notifications.unread,
    queryFn: ({ signal }) => api.inbox({ pageSize: 1, unreadOnly: true }, signal),
    enabled: session.isAuthenticated,
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
  return (
    <AppShell nav={NAV} homeHref={ROUTES.home} notificationsHref={ROUTES.notifications} notificationsCount={unread.data?.unreadCount ?? 0} profileHref={ROUTES.profile} securityHref={ROUTES.security}>
      {children}
    </AppShell>
  );
}

/** The signed-in part of the corporate portal: only company users (membership kind CORPORATE) get in. */
export function PortalShell({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth kinds={['CORPORATE']} mfaSetupPath={ROUTES.security}>
      <Shell>{children}</Shell>
    </RequireAuth>
  );
}
