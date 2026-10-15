import { describe, expect, it } from 'vitest';
import { PLATFORM_ROLES, SUPPORT_GRANTABLE, SYSTEM_ROLES, TENANT_PERMISSIONS } from './index';

describe('permission matrix', () => {
  it('every role references known permissions only', () => {
    for (const role of Object.values(SYSTEM_ROLES)) {
      for (const p of role.permissions) expect(TENANT_PERMISSIONS).toHaveProperty(p);
    }
  });
  it('receptionist cannot touch restricted finance or administration', () => {
    const p = SYSTEM_ROLES.receptionist.permissions;
    for (const k of ['refund.approve', 'discount.approve', 'finance.settings', 'role.manage', 'subscription.manage', 'payment.reconcile'])
      expect(p).not.toContain(k);
  });
  it('operator cannot approve refunds or discounts and only sees assigned requests', () => {
    const p = SYSTEM_ROLES.operator.permissions;
    expect(p).not.toContain('refund.approve');
    expect(p).not.toContain('discount.approve');
    expect(p).not.toContain('request.read.all');
    expect(p).toContain('request.read.assigned');
  });
  it('customers and corporate users have no staff permissions', () => {
    for (const key of ['customer', 'corporate_admin', 'corporate_employee']) {
      for (const p of SYSTEM_ROLES[key].permissions) expect(p.startsWith('self.') || p.startsWith('corp.')).toBe(true);
    }
  });
  it('platform roles carry no tenant permission (documents need an access grant)', () => {
    for (const role of Object.values(PLATFORM_ROLES)) {
      for (const p of role.permissions) expect(p.startsWith('platform.')).toBe(true);
    }
  });
  it('support grants can never unlock write access to money, roles or deletion', () => {
    for (const k of ['refund.approve', 'payment.record', 'role.manage', 'document.delete', 'customer.merge', 'invoice.manage'])
      expect(SUPPORT_GRANTABLE).not.toContain(k);
  });
});
