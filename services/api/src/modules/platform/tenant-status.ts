import type { SubscriptionStatus, TenantStatus } from '@typease/database';

/**
 * Pure rules for the tenant life cycle as the platform console drives it.
 * Unit-tested in tenant-status.unit.spec.ts.
 *
 * tenants.status is shared with SaaS billing (modules/subscriptions): the
 * hourly lifecycle job re-derives it from the subscription. Two things keep
 * the two from fighting:
 *
 *  - billing never touches ONBOARDING, PENDING_APPROVAL or ARCHIVED, and never
 *    a SUSPENDED centre whose `suspensionReason` is anything other than
 *    "SUBSCRIPTION_UNPAID";
 *  - every suspension made here therefore stores a reason that starts with
 *    "PLATFORM:" (or "APPROVAL_REJECTED:"), so paying an invoice can never
 *    undo it.
 */
export const BILLING_SUSPENSION = 'SUBSCRIPTION_UNPAID';
export const PLATFORM_SUSPENSION_PREFIX = 'PLATFORM: ';
export const REJECTION_PREFIX = 'APPROVAL_REJECTED: ';

export const platformSuspensionReason = (reason: string) => `${PLATFORM_SUSPENSION_PREFIX}${reason}`.slice(0, 600);
export const rejectionReason = (reason: string) => `${REJECTION_PREFIX}${reason}`.slice(0, 600);
export const isBillingSuspension = (t: { status: string; suspensionReason: string | null }) => t.status === 'SUSPENDED' && t.suspensionReason === BILLING_SUSPENSION;

/** The status a working centre has for a given subscription state (the same mapping billing uses). */
export function statusForSubscription(subscription: SubscriptionStatus | null | undefined): { status: TenantStatus; suspensionReason: string | null } {
  switch (subscription) {
    case 'TRIALING':
      return { status: 'TRIAL', suspensionReason: null };
    case 'PAST_DUE':
    case 'GRACE':
      return { status: 'PAST_DUE', suspensionReason: null };
    case 'EXPIRED':
      // Still unpaid: billing owns this suspension and lifts it when the invoice is paid.
      return { status: 'SUSPENDED', suspensionReason: BILLING_SUSPENSION };
    case 'CANCELLED':
      return { status: 'CANCELLED', suspensionReason: null };
    case 'ACTIVE':
    default:
      // No subscription row at all only happens for centres set up outside the normal flow.
      return { status: 'ACTIVE', suspensionReason: null };
  }
}

/** Where a centre returns to when a platform suspension (or archive) is lifted. */
export function statusAfterReactivation(tenant: { onboardingStep: number }, subscription: SubscriptionStatus | null | undefined): { status: TenantStatus; suspensionReason: string | null } {
  // Onboarding was never finished: the owner continues where they stopped.
  if (tenant.onboardingStep < 10) return { status: 'ONBOARDING', suspensionReason: null };
  return statusForSubscription(subscription);
}

export type TenantAction = 'approve' | 'reject' | 'suspend' | 'reactivate' | 'archive' | 'offboard' | 'cancelOffboarding';

/** Why an action is not possible in the current state, or null when it is. */
export function actionProblem(action: TenantAction, tenant: { status: TenantStatus; suspensionReason: string | null; offboardingAt: Date | null }): { code: string; message: string } | null {
  const s = tenant.status;
  switch (action) {
    case 'approve':
    case 'reject':
      return s === 'PENDING_APPROVAL' ? null : { code: 'NOT_PENDING_APPROVAL', message: 'This centre is not waiting for approval.' };
    case 'suspend':
      if (s === 'ARCHIVED' || s === 'CANCELLED') return { code: 'TENANT_NOT_ACTIVE', message: `A ${s.toLowerCase()} centre cannot be suspended.` };
      if (s === 'SUSPENDED' && !isBillingSuspension(tenant)) return { code: 'ALREADY_SUSPENDED', message: 'This centre is already suspended.' };
      return null;
    case 'reactivate':
      if (s === 'ARCHIVED') return tenant.offboardingAt ? { code: 'OFFBOARDING_SCHEDULED', message: 'This centre is scheduled for deletion. Cancel the offboarding first.' } : null;
      if (s !== 'SUSPENDED') return { code: 'NOT_SUSPENDED', message: 'Only a suspended or archived centre can be reactivated.' };
      if (isBillingSuspension(tenant)) {
        return { code: 'SUSPENDED_FOR_NON_PAYMENT', message: 'This centre is suspended because its subscription is unpaid. Record the payment or extend the trial in Billing; the centre is then reactivated automatically.' };
      }
      return null;
    case 'archive':
      return s === 'ARCHIVED' ? { code: 'ALREADY_ARCHIVED', message: 'This centre is already archived.' } : null;
    case 'offboard':
      return tenant.offboardingAt ? { code: 'OFFBOARDING_SCHEDULED', message: 'Offboarding is already scheduled for this centre.' } : null;
    case 'cancelOffboarding':
      return tenant.offboardingAt ? null : { code: 'OFFBOARDING_NOT_SCHEDULED', message: 'No offboarding is scheduled for this centre.' };
  }
}
