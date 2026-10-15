import { SetMetadata } from '@nestjs/common';
import type { AccessRule } from './access';

/**
 * What a SUPPORT SESSION may reach. A support session is platform staff inside
 * one centre under an access grant the centre approved; its permissions are
 * exactly the scopes of that grant (`SUPPORT_GRANTABLE` in @typease/permissions).
 *
 * The rules, applied by the AuthGuard on every request of such a session:
 *
 *  1. A route is reachable only if the permission it requires is one of the
 *     granted scopes.
 *  2. A route that requires NO permission (`@TenantMember()`, `@Authenticated()`)
 *     is refused, unless it is explicitly marked `@SupportSessionSafe(...)`.
 *     The marker is only for what the staff app needs to start and to show the
 *     session: never for customer data, never for a change.
 *  3. Support sessions are read-only: every method other than GET / HEAD is
 *     refused, unless the route is marked `@SupportSessionRead(...)` (a POST that
 *     only reads, e.g. "create a short-lived download link") or the permission
 *     that opens the route is one of `SUPPORT_WRITE_SCOPES` and was granted.
 *  4. Routes for customers or company users only, and platform routes, are
 *     always refused.
 */

/** Granted scopes that allow a state change. Everything else a grant can carry is a read. */
export const SUPPORT_WRITE_SCOPES: readonly string[] = ['request.comment.internal'];

export const SUPPORT_KEY = 'typease:support-session';
export interface SupportRouteRule {
  mode: 'SAFE' | 'READ';
  /** Why a support session may call this route (shown in the API documentation and checked in review). */
  reason: string;
}

/**
 * A GET route WITHOUT a permission that a support session may call. Security
 * decision: only for the session itself and for reference data of the centre
 * that contains no customer data. Every use is listed in docs/api/modules/platform.md
 * and pinned by test/support-session.spec.ts.
 */
export const SupportSessionSafe = (reason: string) => SetMetadata(SUPPORT_KEY, { mode: 'SAFE', reason } satisfies SupportRouteRule);
/**
 * A route that is not a GET but changes nothing a centre would call data (it
 * returns a short-lived link or the result of a lookup). It still needs its
 * permission to be one of the granted scopes.
 */
export const SupportSessionRead = (reason: string) => SetMetadata(SUPPORT_KEY, { mode: 'READ', reason } satisfies SupportRouteRule);

export type SupportDecision =
  | { allowed: true; via: 'PUBLIC' | 'SAFE' | 'SCOPE'; audited: boolean }
  | { allowed: false; code: 'PLATFORM_ONLY' | 'SUPPORT_ACCESS_SCOPE' | 'SUPPORT_ACCESS_READ_ONLY'; message: string; required: string[] };

const READ_METHODS = ['GET', 'HEAD'];
const OUT_OF_SCOPE = 'This is outside the access the centre approved for TypEase support.';

/** Pure decision: may a support session with these scopes call a route with this declaration? */
export function decideSupportAccess(rule: AccessRule, marker: SupportRouteRule | undefined, method: string, scopes: ReadonlySet<string>): SupportDecision {
  const read = READ_METHODS.includes(method.toUpperCase());
  if (rule.type === 'public') return { allowed: true, via: 'PUBLIC', audited: false };
  if (rule.type === 'platform' || rule.type === 'internal') {
    return { allowed: false, code: 'PLATFORM_ONLY', message: 'A support session works inside one centre only. Use your platform session for the platform console.', required: rule.type === 'platform' ? rule.any : [] };
  }
  if (marker?.mode === 'SAFE') {
    // The marker never opens a change, whatever it was put on.
    if (!read) return { allowed: false, code: 'SUPPORT_ACCESS_READ_ONLY', message: 'Support access is read-only.', required: [] };
    return { allowed: true, via: 'SAFE', audited: false };
  }
  if (rule.type === 'authenticated') return { allowed: false, code: 'SUPPORT_ACCESS_SCOPE', message: OUT_OF_SCOPE, required: [] };

  // rule.type === 'tenant'
  const required = [...(rule.any ?? []), ...(rule.all ?? [])];
  // Routes for customers / company users are not for somebody who acts as staff.
  if (rule.kinds && !rule.kinds.includes('STAFF')) return { allowed: false, code: 'SUPPORT_ACCESS_SCOPE', message: OUT_OF_SCOPE, required: rule.kinds };
  if (!required.length) return { allowed: false, code: 'SUPPORT_ACCESS_SCOPE', message: OUT_OF_SCOPE, required: [] };
  const held = required.filter((p) => scopes.has(p));
  if (rule.any?.length && !rule.any.some((p) => scopes.has(p))) return { allowed: false, code: 'SUPPORT_ACCESS_SCOPE', message: OUT_OF_SCOPE, required };
  if (rule.all?.length && !rule.all.every((p) => scopes.has(p))) return { allowed: false, code: 'SUPPORT_ACCESS_SCOPE', message: OUT_OF_SCOPE, required };
  if (!read && marker?.mode !== 'READ' && !held.some((p) => SUPPORT_WRITE_SCOPES.includes(p))) {
    return { allowed: false, code: 'SUPPORT_ACCESS_READ_ONLY', message: 'Support access is read-only. The centre did not approve a permission that allows this change.', required };
  }
  return { allowed: true, via: 'SCOPE', audited: true };
}
