/**
 * The one place this app reads its environment.
 * Server code (layout, middleware) may use everything here; client components
 * receive what they need through <AppProviders> props, never from process.env.
 */
import type { AppKey } from '@typease/types';

export const APP: AppKey = 'platform';

/** API origin as the browser reaches it. Run-time override first, then the build-time public value. */
export const API_URL = (process.env.API_PUBLIC_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000').replace(/\/+$/, '');
export const STORAGE_ORIGINS = process.env.NEXT_PUBLIC_STORAGE_ORIGINS ?? '';
export const IS_DEV = process.env.NODE_ENV !== 'production';

export const ROUTES = {
  signIn: '/sign-in',
  home: '/dashboard',
  profile: '/account/profile',
  security: '/account/security',
} as const;
