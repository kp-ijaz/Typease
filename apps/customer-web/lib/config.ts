/**
 * The one place this app reads its environment. Client components get what
 * they need through props / <AppProviders>, never from process.env.
 */
import type { AppKey } from '@typease/types';

export const APP: AppKey = 'customer';

/** API origin as the browser reaches it. */
export const API_URL = (process.env.API_PUBLIC_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000').replace(/\/+$/, '');
/** API origin as this server reaches it (tenant lookup). */
export const API_INTERNAL_URL = (process.env.API_INTERNAL_URL || API_URL).replace(/\/+$/, '');
export const STORAGE_ORIGINS = process.env.NEXT_PUBLIC_STORAGE_ORIGINS ?? '';
export const DEFAULT_TENANT_SLUG = process.env.NEXT_PUBLIC_DEFAULT_TENANT_SLUG || '';
export const SHARED_HOSTS = (process.env.PORTAL_SHARED_HOSTS ?? '').split(/[\s,]+/).filter(Boolean);
export const IS_DEV = process.env.NODE_ENV !== 'production';

export const ROUTES = {
  home: '/',
  login: '/login',
  register: '/register',
  dashboard: '/dashboard',
  services: '/services',
  track: '/track',
  newRequest: '/requests/new',
  profile: '/profile',
  privacy: '/privacy',
  terms: '/terms',
} as const;
