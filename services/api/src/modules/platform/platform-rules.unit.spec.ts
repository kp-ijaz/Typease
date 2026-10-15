import { invalidScopes } from './access-grants.service';
import { resolveFlag } from './feature-flags.service';
import { resolvePeriod } from './platform.util';
import { ForeignKey, purgeOrder, safeIdentifier } from './purge-plan';
import { SETTINGS } from './settings.service';
import { actionProblem, isBillingSuspension, platformSuspensionReason, rejectionReason, statusAfterReactivation, statusForSubscription } from './tenant-status';

describe('platform rules (pure)', () => {
  describe('tenant status', () => {
    it('maps a subscription to the centre status exactly as billing does', () => {
      expect(statusForSubscription('TRIALING')).toEqual({ status: 'TRIAL', suspensionReason: null });
      expect(statusForSubscription('ACTIVE')).toEqual({ status: 'ACTIVE', suspensionReason: null });
      expect(statusForSubscription('PAST_DUE')).toEqual({ status: 'PAST_DUE', suspensionReason: null });
      expect(statusForSubscription('GRACE')).toEqual({ status: 'PAST_DUE', suspensionReason: null });
      expect(statusForSubscription('EXPIRED')).toEqual({ status: 'SUSPENDED', suspensionReason: 'SUBSCRIPTION_UNPAID' });
      expect(statusForSubscription('CANCELLED')).toEqual({ status: 'CANCELLED', suspensionReason: null });
      expect(statusForSubscription(null)).toEqual({ status: 'ACTIVE', suspensionReason: null });
    });
    it('a centre that never finished onboarding goes back to onboarding', () => {
      expect(statusAfterReactivation({ onboardingStep: 3 }, 'ACTIVE').status).toBe('ONBOARDING');
      expect(statusAfterReactivation({ onboardingStep: 10 }, 'TRIALING').status).toBe('TRIAL');
      expect(statusAfterReactivation({ onboardingStep: 10 }, 'EXPIRED')).toEqual({ status: 'SUSPENDED', suspensionReason: 'SUBSCRIPTION_UNPAID' });
    });
    it('platform suspensions never look like a billing suspension', () => {
      expect(platformSuspensionReason('misuse')).toBe('PLATFORM: misuse');
      expect(rejectionReason('licence not found')).toBe('APPROVAL_REJECTED: licence not found');
      expect(platformSuspensionReason('x'.repeat(2000)).length).toBe(600);
      // Even a reason that tries to imitate the billing marker is stored with the prefix.
      expect(isBillingSuspension({ status: 'SUSPENDED', suspensionReason: platformSuspensionReason('SUBSCRIPTION_UNPAID') })).toBe(false);
      expect(isBillingSuspension({ status: 'SUSPENDED', suspensionReason: 'SUBSCRIPTION_UNPAID' })).toBe(true);
      expect(isBillingSuspension({ status: 'ACTIVE', suspensionReason: 'SUBSCRIPTION_UNPAID' })).toBe(false);
    });
    it('says which actions fit which state', () => {
      const t = (status: any, suspensionReason: string | null = null, offboardingAt: Date | null = null) => ({ status, suspensionReason, offboardingAt });
      expect(actionProblem('approve', t('PENDING_APPROVAL'))).toBeNull();
      expect(actionProblem('approve', t('ACTIVE'))?.code).toBe('NOT_PENDING_APPROVAL');
      expect(actionProblem('reject', t('ONBOARDING'))?.code).toBe('NOT_PENDING_APPROVAL');
      for (const s of ['ONBOARDING', 'PENDING_APPROVAL', 'TRIAL', 'ACTIVE', 'PAST_DUE']) expect(actionProblem('suspend', t(s))).toBeNull();
      expect(actionProblem('suspend', t('SUSPENDED', 'PLATFORM: x'))?.code).toBe('ALREADY_SUSPENDED');
      expect(actionProblem('suspend', t('SUSPENDED', 'SUBSCRIPTION_UNPAID'))).toBeNull();
      expect(actionProblem('suspend', t('ARCHIVED'))?.code).toBe('TENANT_NOT_ACTIVE');
      expect(actionProblem('suspend', t('CANCELLED'))?.code).toBe('TENANT_NOT_ACTIVE');
      expect(actionProblem('reactivate', t('SUSPENDED', 'PLATFORM: x'))).toBeNull();
      expect(actionProblem('reactivate', t('SUSPENDED', 'APPROVAL_REJECTED: y'))).toBeNull();
      expect(actionProblem('reactivate', t('SUSPENDED', 'SUBSCRIPTION_UNPAID'))?.code).toBe('SUSPENDED_FOR_NON_PAYMENT');
      expect(actionProblem('reactivate', t('ACTIVE'))?.code).toBe('NOT_SUSPENDED');
      expect(actionProblem('reactivate', t('ARCHIVED'))).toBeNull();
      expect(actionProblem('reactivate', t('ARCHIVED', null, new Date()))?.code).toBe('OFFBOARDING_SCHEDULED');
      expect(actionProblem('archive', t('ARCHIVED'))?.code).toBe('ALREADY_ARCHIVED');
      expect(actionProblem('archive', t('SUSPENDED', 'PLATFORM: x'))).toBeNull();
      expect(actionProblem('offboard', t('ACTIVE'))).toBeNull();
      expect(actionProblem('offboard', t('ARCHIVED'))).toBeNull();
      expect(actionProblem('offboard', t('ARCHIVED', null, new Date()))?.code).toBe('OFFBOARDING_SCHEDULED');
      expect(actionProblem('cancelOffboarding', t('ARCHIVED', null, new Date()))).toBeNull();
      expect(actionProblem('cancelOffboarding', t('ARCHIVED'))?.code).toBe('OFFBOARDING_NOT_SCHEDULED');
    });
  });

  describe('purge order', () => {
    const fk = (child: string, parent: string, rule = 'r'): ForeignKey => ({ child, parent, rule });
    it('deletes referencing tables before the tables they point at', () => {
      const tables = ['customers', 'service_requests', 'invoices', 'payment_allocations', 'payments', 'branches', 'audit_logs', 'tenants'];
      const fks = [fk('service_requests', 'customers'), fk('service_requests', 'branches'), fk('invoices', 'customers'), fk('invoices', 'service_requests', 'n'), fk('payment_allocations', 'payments'), fk('payment_allocations', 'invoices'), fk('payments', 'branches'), fk('customers', 'tenants', 'c')];
      const order = purgeOrder(tables, fks);
      const before = (a: string, b: string) => expect(order.indexOf(a)).toBeLessThan(order.indexOf(b));
      before('service_requests', 'customers');
      before('service_requests', 'branches');
      before('invoices', 'customers');
      before('payment_allocations', 'payments');
      before('payment_allocations', 'invoices');
      before('payments', 'branches');
      expect(order).not.toContain('tenants');
      expect(order.sort()).toEqual(tables.filter((t) => t !== 'tenants').sort());
      // Stable: the same input always gives the same order.
      expect(purgeOrder([...tables].reverse(), [...fks].reverse())).toEqual(purgeOrder(tables, fks));
    });
    it('treats cascade and no-action keys as ordering constraints, ignores set-null keys and self references', () => {
      expect(purgeOrder(['a', 'b'], [fk('b', 'a', 'c')])).toEqual(['b', 'a']);
      expect(purgeOrder(['a', 'b'], [fk('b', 'a', 'a')])).toEqual(['b', 'a']);
      expect(purgeOrder(['a', 'b'], [fk('b', 'a', 'n')])).toEqual(['a', 'b']);
      expect(purgeOrder(['customers'], [fk('customers', 'customers')])).toEqual(['customers']);
      // Keys to tables outside the tenant set (users, plans) do not matter.
      expect(purgeOrder(['subscriptions'], [fk('subscriptions', 'subscription_plans')])).toEqual(['subscriptions']);
      // A set-null back-reference does not make a cycle.
      expect(purgeOrder(['documents', 'request_documents'], [fk('request_documents', 'documents', 'n'), fk('documents', 'request_documents', 'r')])).toEqual(['documents', 'request_documents']);
    });
    it('keeps the platform incident register and reports a real cycle instead of guessing', () => {
      expect(purgeOrder(['security_incidents', 'customers'], [])).toEqual(['customers']);
      expect(() => purgeOrder(['a', 'b'], [fk('a', 'b'), fk('b', 'a')])).toThrow(/cycle between a, b/);
    });
    it('only interpolates plain identifiers into SQL', () => {
      expect(safeIdentifier('audit_logs')).toBe('"audit_logs"');
      for (const bad of ['users; DROP TABLE users', 'Users', 'a"b', '', 'tenant-domains']) expect(() => safeIdentifier(bad)).toThrow(/Unexpected table name/);
    });
  });

  it('support access can only ever include read-level scopes', () => {
    expect(invalidScopes(['customer.read', 'document.read', 'audit.read'])).toEqual([]);
    expect(invalidScopes(['customer.read', 'customer.update', 'refund.approve', 'nonsense'])).toEqual(['customer.update', 'refund.approve', 'nonsense']);
  });

  it('feature flags resolve as: own row > global default > off', () => {
    const rows = [
      { key: 'a', tenantId: null, enabled: true, payload: { x: 1 } },
      { key: 'a', tenantId: 't1', enabled: false, payload: {} },
      { key: 'b', tenantId: 't2', enabled: true, payload: { y: 2 } },
    ];
    expect(resolveFlag(rows, 'a', 't1')).toEqual({ enabled: false, source: 'TENANT', payload: {} });
    expect(resolveFlag(rows, 'a', 't2')).toEqual({ enabled: true, source: 'GLOBAL', payload: { x: 1 } });
    expect(resolveFlag(rows, 'a', null)).toEqual({ enabled: true, source: 'GLOBAL', payload: { x: 1 } });
    expect(resolveFlag(rows, 'b', 't2')).toEqual({ enabled: true, source: 'TENANT', payload: { y: 2 } });
    expect(resolveFlag(rows, 'b', 't1')).toEqual({ enabled: false, source: 'NONE', payload: {} });
    expect(resolveFlag(rows, 'missing', 't1')).toEqual({ enabled: false, source: 'NONE', payload: {} });
  });

  it('resolvePeriod turns inclusive dates into [start, end) and defaults to the last N days', () => {
    const now = new Date('2026-06-15T12:00:00Z');
    expect(resolvePeriod({ from: '2026-05-01', to: '2026-05-31' }, 30, now)).toEqual({ start: new Date('2026-05-01T00:00:00Z'), end: new Date('2026-06-01T00:00:00Z') });
    expect(resolvePeriod({}, 30, now)).toEqual({ start: new Date('2026-05-16T12:00:00Z'), end: now });
    expect(resolvePeriod({ to: '2026-06-10' }, 7, now)).toEqual({ start: new Date('2026-06-04T00:00:00Z'), end: new Date('2026-06-11T00:00:00Z') });
  });

  it('every setting on the allow-list accepts its own default', () => {
    expect(SETTINGS.map((s) => s.key)).toEqual(['subscriptions.policy', 'integrations.approvedProviders', 'supportAccess.policy', 'offboarding.policy']);
    for (const def of SETTINGS) expect([def.key, def.schema.safeParse(def.defaultValue).success]).toEqual([def.key, true]);
    const offboarding = SETTINGS.find((s) => s.key === 'offboarding.policy')!;
    expect(offboarding.schema.safeParse({ minPurgeDelayDays: 29 }).success).toBe(false);
    expect(offboarding.schema.safeParse({ minPurgeDelayDays: 90 }).success).toBe(true);
  });
});
