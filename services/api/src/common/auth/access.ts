import { SetMetadata } from '@nestjs/common';
import type { PlatformPermission, TenantPermission } from '@typease/permissions';

export const ACCESS_KEY = 'typease:access';

export type AccessRule =
  | { type: 'public' }
  | { type: 'internal' }
  | { type: 'authenticated'; allowWithoutMfa?: boolean }
  | { type: 'tenant'; any?: string[]; all?: string[]; allowSuspended?: boolean; kinds?: Array<'STAFF' | 'CUSTOMER' | 'CORPORATE'> }
  | { type: 'platform'; any: string[] };

/**
 * Access declarations. EVERY route must carry exactly one of these; a route
 * without a declaration is rejected by the guard (fail closed) and by
 * test/architecture.spec.ts.
 */

/** No authentication. Use only for genuinely public data and credential exchange. */
export const Public = () => SetMetadata(ACCESS_KEY, { type: 'public' } satisfies AccessRule);
/** Any signed-in user; no tenant required (profile, session management). */
export const Authenticated = (opts: { allowWithoutMfa?: boolean } = {}) =>
  SetMetadata(ACCESS_KEY, { type: 'authenticated', ...opts } satisfies AccessRule);
/** Signed in to a tenant and holding ANY of the listed permissions. */
export const Permissions = (...any: TenantPermission[]) => SetMetadata(ACCESS_KEY, { type: 'tenant', any } satisfies AccessRule);
/** Signed in to a tenant and holding ALL of the listed permissions. */
export const AllPermissions = (...all: TenantPermission[]) => SetMetadata(ACCESS_KEY, { type: 'tenant', all } satisfies AccessRule);
/** Any active member of the tenant, optionally limited to membership kinds. */
export const TenantMember = (opts: { kinds?: Array<'STAFF' | 'CUSTOMER' | 'CORPORATE'>; allowSuspended?: boolean; any?: TenantPermission[] } = {}) =>
  SetMetadata(ACCESS_KEY, { type: 'tenant', ...opts } satisfies AccessRule);
/** Platform staff holding ANY of the listed platform permissions. Never grants tenant data. */
export const Platform = (...any: PlatformPermission[]) => SetMetadata(ACCESS_KEY, { type: 'platform', any } satisfies AccessRule);
/** Machine-to-machine calls from our own infrastructure (reverse proxy, monitoring). */
export const Internal = () => SetMetadata(ACCESS_KEY, { type: 'internal' } satisfies AccessRule);
