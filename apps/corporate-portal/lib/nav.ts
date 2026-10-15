import { Bell, BellRing, Building2, ClipboardCheck, ClipboardList, FolderOpen, LayoutDashboard, LifeBuoy, Receipt, ShieldCheck, Users } from 'lucide-react';
import type { NavGroup } from '@typease/ui';

/**
 * Navigation of the corporate portal as data. `anyOf` lists the permissions (packages/permissions:
 * `corp.*` for a company's administrators, `self.*` for an employee signed in for their own records)
 * of which the session needs at least one; the shell hides the rest and the API checks them again.
 *
 * An employee therefore sees: Overview, Requests (their own), Documents (their own), Reminders,
 * Notifications and Support. No directory, no approvals, no invoices, no company profile.
 */
export const NAV: NavGroup[] = [
  { id: 'home', items: [{ id: 'overview', labelKey: 'nav.overview', icon: LayoutDashboard, href: '/overview' }] },
  {
    id: 'work',
    labelKey: 'nav.groups.work',
    items: [
      { id: 'employees', labelKey: 'nav.employees', icon: Users, href: '/employees', anyOf: ['corp.employees.read'] },
      { id: 'requests', labelKey: 'nav.requests', icon: ClipboardList, href: '/requests', anyOf: ['corp.requests.read', 'self.requests'] },
      { id: 'approvals', labelKey: 'nav.approvals', icon: ClipboardCheck, href: '/approvals', anyOf: ['corp.requests.approve'] },
      { id: 'documents', labelKey: 'nav.documents', icon: FolderOpen, href: '/documents', anyOf: ['corp.employees.read', 'corp.requests.read', 'corp.account.read', 'self.documents'] },
      { id: 'invoices', labelKey: 'nav.invoices', icon: Receipt, href: '/invoices', anyOf: ['corp.invoices.read'] },
      // GET /me/reminders answers every company user: the company's schedule for administrators, their own for an employee.
      { id: 'reminders', labelKey: 'nav.reminders', icon: BellRing, href: '/reminders' },
    ],
  },
  {
    id: 'company',
    labelKey: 'nav.groups.company',
    items: [
      { id: 'company', labelKey: 'nav.company', icon: Building2, href: '/company', anyOf: ['corp.account.read'] },
      // Everybody with the company account sees the roles; only the company administrator changes them.
      { id: 'roles', labelKey: 'nav.roles', icon: ShieldCheck, href: '/roles', anyOf: ['corp.account.read'] },
      { id: 'notifications', labelKey: 'nav.notifications', icon: Bell, href: '/notifications' },
      { id: 'support', labelKey: 'nav.support', icon: LifeBuoy, href: '/support', anyOf: ['self.tickets'] },
    ],
  },
];
