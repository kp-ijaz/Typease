import { ctx, Ctx } from './context';
import { Errors } from './errors';

/**
 * Resource-level scoping helpers. Permissions say WHAT a role may do; these
 * say on WHICH rows (own branch, own customer record, own company).
 */

/** Prisma filter for a branchId column, or undefined when the member may see all branches. */
export function branchFilter(c: Ctx = ctx()): { in: string[] } | undefined {
  if (c.actorType !== 'STAFF' || c.allBranches) return undefined;
  return { in: c.branchIds };
}
export function assertBranchAccess(branchId: string, c: Ctx = ctx()): void {
  if (c.actorType !== 'STAFF' || c.allBranches) return;
  if (!c.branchIds.includes(branchId)) throw Errors.forbidden('BRANCH_FORBIDDEN', 'You are not assigned to that branch.');
}
/** The branch to use when the caller did not choose one. */
export function defaultBranchId(c: Ctx = ctx()): string | undefined {
  return c.actorType === 'STAFF' && !c.allBranches ? c.branchIds[0] : undefined;
}

/** Customers act only on their own customer record. */
export function ownCustomerId(c: Ctx = ctx()): string {
  if (!c.customerId) throw Errors.forbidden('NO_CUSTOMER_PROFILE', 'Your account is not linked to a customer profile.');
  return c.customerId;
}
/** Corporate users act only inside their own company. */
export function ownCorporateAccountId(c: Ctx = ctx()): string {
  if (c.actorType !== 'CORPORATE' || !c.corporateAccountId) throw Errors.forbidden('NO_CORPORATE_ACCOUNT', 'Your account is not linked to a company.');
  return c.corporateAccountId;
}
