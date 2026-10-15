import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { ActorType, PlatformRole } from '@typease/database';

/**
 * Per-request (or per-job) security context. It is the ONLY source of the
 * tenant id used for data access: it is filled by the authentication guard
 * from verified credentials and memberships, never from client input.
 */
export interface Ctx {
  requestId: string;
  ip?: string;
  userAgent?: string;
  app?: string;
  /** Tenant resolved from the request host. Used for public pages only, never for authorisation. */
  hostTenantId?: string;

  userId?: string;
  sessionId?: string;
  actorType: ActorType;
  actorLabel?: string;
  platformRole?: PlatformRole | null;

  tenantId?: string;
  membershipId?: string;
  roleKey?: string;
  permissions: Set<string>;
  allBranches: boolean;
  branchIds: string[];
  customerId?: string | null;
  corporateAccountId?: string | null;
  corporateEmployeeId?: string | null;
  /** Present while platform staff act inside a tenant under an approved AccessGrant. */
  supportGrantId?: string;
}

const storage = new AsyncLocalStorage<Ctx>();

export function newContext(partial: Partial<Ctx> = {}): Ctx {
  return {
    requestId: randomUUID(),
    actorType: 'SYSTEM',
    permissions: new Set(),
    allBranches: false,
    branchIds: [],
    ...partial,
  };
}

export function runWithContext<T>(context: Ctx, fn: () => T): T {
  return storage.run(context, fn);
}

/** Current context. Throws outside a request / job: there is no implicit global tenant. */
export function ctx(): Ctx {
  const c = storage.getStore();
  if (!c) throw new Error('No request context: wrap the call in runWithContext / runAsTenant.');
  return c;
}
export function tryCtx(): Ctx | undefined {
  return storage.getStore();
}

/** Run background work for one tenant as the system actor (jobs, schedulers, webhooks). */
export function runAsTenant<T>(tenantId: string, fn: () => Promise<T>, overrides: Partial<Ctx> = {}): Promise<T> {
  return storage.run(
    newContext({ tenantId, actorType: 'SYSTEM', actorLabel: 'system', allBranches: true, ...overrides }),
    fn,
  );
}
/** Run cross-tenant platform work (no tenant bound). */
export function runAsSystem<T>(fn: () => Promise<T>, overrides: Partial<Ctx> = {}): Promise<T> {
  return storage.run(newContext({ actorType: 'SYSTEM', actorLabel: 'system', ...overrides }), fn);
}

export function currentTenantId(): string {
  const id = ctx().tenantId;
  if (!id) throw new Error('No tenant bound to the current context.');
  return id;
}
export const isStaff = (c: Ctx = ctx()) => c.actorType === 'STAFF' || (c.actorType === 'PLATFORM' && !!c.supportGrantId) || c.actorType === 'SYSTEM' || c.actorType === 'AUTOMATION';
export const isCustomer = (c: Ctx = ctx()) => c.actorType === 'CUSTOMER';
export const isCorporate = (c: Ctx = ctx()) => c.actorType === 'CORPORATE';
export const can = (permission: string, c: Ctx = ctx()) => c.actorType === 'SYSTEM' || c.permissions.has(permission);
export const canAny = (permissions: string[], c: Ctx = ctx()) => c.actorType === 'SYSTEM' || permissions.some((p) => c.permissions.has(p));
