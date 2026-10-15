import { Activity, Building2, CreditCard, Flag, KeyRound, Landmark, LayoutDashboard, LifeBuoy, Plug, ScrollText, Tags, TicketPercent, UserCog } from 'lucide-react';
import type { NavGroup } from '@typease/ui';

/**
 * Navigation of the platform console as data. `anyOf` lists the platform
 * permissions (packages/permissions, `platform.*`) of which the signed-in staff
 * member needs at least one. A support agent sees fewer sections than a super admin:
 * centres, plans, the support desk and access requests.
 */
export const NAV: NavGroup[] = [
  { id: 'home', items: [{ id: 'dashboard', labelKey: 'nav.dashboard', icon: LayoutDashboard, href: '/dashboard' }] },
  {
    id: 'centres',
    labelKey: 'nav.groups.centres',
    items: [
      { id: 'tenants', labelKey: 'nav.tenants', icon: Building2, href: '/tenants', anyOf: ['platform.tenants.read'] },
      { id: 'subscriptions', labelKey: 'nav.subscriptions', icon: CreditCard, href: '/subscriptions', anyOf: ['platform.billing.manage'] },
      { id: 'plans', labelKey: 'nav.plans', icon: Tags, href: '/plans', anyOf: ['platform.plans.manage', 'platform.billing.manage', 'platform.tenants.read'] },
      { id: 'coupons', parent: 'plans', labelKey: 'nav.coupons', icon: TicketPercent, href: '/plans/coupons', anyOf: ['platform.plans.manage', 'platform.billing.manage'] },
      { id: 'support', labelKey: 'nav.support', icon: LifeBuoy, href: '/support', anyOf: ['platform.support.manage'] },
      { id: 'access', labelKey: 'nav.access', icon: KeyRound, href: '/access-requests', anyOf: ['platform.access.request'] },
    ],
  },
  {
    id: 'platform',
    labelKey: 'nav.groups.platform',
    items: [
      { id: 'integrations', labelKey: 'nav.integrations', icon: Plug, href: '/integrations', anyOf: ['platform.integrations.manage', 'platform.metrics.read'] },
      { id: 'fees', labelKey: 'nav.fees', icon: Landmark, href: '/authority-fees', anyOf: ['platform.fees.manage'] },
      { id: 'flags', labelKey: 'nav.flags', icon: Flag, href: '/feature-flags', anyOf: ['platform.features.manage'] },
      { id: 'staff', labelKey: 'nav.staff', icon: UserCog, href: '/staff', anyOf: ['platform.staff.manage'] },
      { id: 'audit', labelKey: 'nav.audit', icon: ScrollText, href: '/audit', anyOf: ['platform.audit.read'] },
      { id: 'health', labelKey: 'nav.health', icon: Activity, href: '/system-health', anyOf: ['platform.metrics.read'] },
    ],
  },
];
