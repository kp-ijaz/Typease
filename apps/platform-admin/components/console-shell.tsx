'use client';

import { AppShell, RequireAuth } from '@typease/ui';
import { ROUTES } from '@/lib/config';
import { NAV } from '@/lib/nav';

/**
 * The signed-in part of the console. Only accounts with a platform role get in
 * (`platform`), and two-step verification is mandatory: while the API reports
 * `mfaRequiredSetup`, every page leads to the security page where it is set up.
 */
export function ConsoleShell({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth platform mfaSetupPath={ROUTES.security}>
      <AppShell nav={NAV} homeHref={ROUTES.home} profileHref={ROUTES.profile} securityHref={ROUTES.security}>
        {children}
      </AppShell>
    </RequireAuth>
  );
}
