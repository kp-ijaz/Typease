'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import type { LoginOk } from '@typease/api-client';
import { safeNextPath } from '../lib/errors';
import { useSession } from '../providers/auth';

/**
 * Where to go after a successful sign-in:
 *  1. the page the person originally asked for (`?next=`), if it is a path of this app;
 *  2. otherwise what the app maps the API's `landing` hint to (`/dashboard`, `/onboarding`,
 *     `/settings/security?setup=mfa`); apps translate the hint to their own routes;
 *  3. otherwise the app's home.
 * A required two-step setup always wins over `next`.
 */
export function useAfterSignIn(options: { mapLanding?: (landing: string, result: LoginOk) => string | undefined } = {}) {
  const router = useRouter();
  const session = useSession();
  const map = React.useRef(options.mapLanding);
  map.current = options.mapLanding;
  return React.useCallback(
    (result: LoginOk) => {
      const mapped = map.current?.(result.landing, result);
      const next = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('next') : null;
      const target = result.session.mfaRequiredSetup ? mapped ?? session.homePath : safeNextPath(next, mapped ?? session.homePath);
      router.replace(target);
    },
    [router, session.homePath],
  );
}
