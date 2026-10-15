import type { Response } from 'supertest';
import { Actor, TestApp } from '../../services/api/test/helpers';
import type { AccessRule } from '../../services/api/src/common/auth/access';
import { DiscoveredRoute, discoverRoutes } from '../../services/api/src/common/auth/routes';

/**
 * The route table of the booted application, read from the controller metadata
 * by the API's own `discoverRoutes` (the function `docs/api/ENDPOINTS.md` is
 * generated with). The security suite walks this table, so a route that is
 * added later is attacked without anybody having to remember it.
 */
export type Route = DiscoveredRoute;
export type TenantRule = Extract<AccessRule, { type: 'tenant' }>;

export const routeName = (r: { method: string; path: string }) => `${r.method} ${r.path}`;
/** A well-formed id that belongs to nothing. */
export const NO_SUCH_ID = '5b1d7c2e-1111-4222-8333-444455556666';

export function routeTable(t: TestApp): Route[] {
  return discoverRoutes(t.app);
}

/** Names of the `:param` placeholders of a route, in order. */
export const paramsOf = (route: Route): string[] => [...route.path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]);

/**
 * The URL of a route with every `:param` replaced. `value(param, before)` gets
 * the parameter name and the path segment in front of it
 * (`/customers/:id/notes/:noteId` -> ("id", "customers"), ("noteId", "notes")).
 */
export function urlOf(route: Route, value: (param: string, before: string, index: number) => string = () => NO_SUCH_ID): string {
  const segments = route.path.split('/');
  let index = 0;
  return segments.map((s, i) => (s.startsWith(':') ? encodeURIComponent(value(s.slice(1), segments[i - 1] ?? '', index++)) : s)).join('/');
}

/** Sends one request to a route of the table. Binary answers are collected as a Buffer; nothing is asserted. */
export function call(t: TestApp, actor: Actor | null, route: { method: string }, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  let r = (t.http as any)[route.method.toLowerCase()](url);
  if (actor) r = r.set('Authorization', `Bearer ${actor.token}`);
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  if (route.method !== 'GET' && route.method !== 'DELETE') r = r.send((body as object) ?? {});
  return r;
}

/** Everything a response said, as text (JSON, plain text or a binary body), for "does it contain X" checks. */
export function textOf(res: Response): string {
  if (Buffer.isBuffer(res.body)) return res.body.toString('latin1');
  return `${res.text ?? ''}${res.text ? '' : JSON.stringify(res.body ?? '')}`;
}

/**
 * What the authentication guard must decide for a tenant member with these
 * permissions - computed here from the DECLARED access rule of the route and
 * the permission matrix, independently of the guard's code.
 */
export function mayPass(rule: AccessRule, member: { kind: 'STAFF' | 'CUSTOMER' | 'CORPORATE'; permissions: Iterable<string> }): boolean {
  const held = new Set(member.permissions);
  switch (rule.type) {
    case 'public':
    case 'authenticated':
      return true;
    case 'internal':
    case 'platform':
      return false;
    case 'tenant':
      if (rule.kinds && !rule.kinds.includes(member.kind)) return false;
      if (rule.any?.length && !rule.any.some((p) => held.has(p))) return false;
      if (rule.all?.length && !rule.all.every((p) => held.has(p))) return false;
      return true;
  }
}
