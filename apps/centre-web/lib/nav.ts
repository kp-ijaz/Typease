import {
  BadgeCheck, BadgeDollarSign, BadgePercent, FileSignature, MessageCircle, Target, BellRing, BookOpenCheck, Building2, CalendarClock, CalendarDays, ChartColumn, ClipboardList, CreditCard, FileText, FolderOpen, Globe, HandCoins, LayoutDashboard, LayoutGrid, LifeBuoy,
  ListChecks, ListOrdered, Lock, MapPin, MessageSquareText, Palette, Plug, Receipt, ScrollText, Settings, ShieldCheck, Undo2, UserCog, Users, Wallet, Workflow, Zap,
} from 'lucide-react';
import type { NavGroup } from '@typease/ui';

/**
 * The complete navigation of the staff app as data. `anyOf` lists the
 * permissions (packages/permissions) of which the session needs at least one;
 * the shell hides what a role cannot use. The API enforces them again.
 */
export const NAV: NavGroup[] = [
  { id: 'home', items: [{ id: 'dashboard', labelKey: 'nav.dashboard', icon: LayoutDashboard, href: '/dashboard' }] },
  {
    id: 'work',
    labelKey: 'nav.groups.work',
    items: [
      { id: 'requests', labelKey: 'nav.requests', icon: ClipboardList, href: '/requests', anyOf: ['request.read.all', 'request.read.assigned'] },
      { id: 'inbox', labelKey: 'nav.inbox', icon: MessageCircle, href: '/inbox', anyOf: ['inbox.read', 'inbox.reply', 'inbox.manage'] },
      { id: 'leads', labelKey: 'nav.leads', icon: Target, href: '/leads', anyOf: ['lead.read', 'lead.manage'] },
      { id: 'customers', labelKey: 'nav.customers', icon: Users, href: '/customers', anyOf: ['customer.read'] },
      { id: 'corporate', labelKey: 'nav.corporate', icon: Building2, href: '/corporate', anyOf: ['corporate.read'] },
      { id: 'documents', labelKey: 'nav.documents', icon: FolderOpen, href: '/documents', anyOf: ['document.read'] },
      { id: 'paperwork', labelKey: 'nav.paperwork', icon: FileSignature, href: '/paperwork', anyOf: ['paperwork.read', 'paperwork.manage'] },
      { id: 'appointments', labelKey: 'nav.appointments', icon: CalendarDays, href: '/appointments', anyOf: ['appointment.read', 'appointment.manage'] },
      { id: 'queue', labelKey: 'nav.queue', icon: ListOrdered, href: '/queue', anyOf: ['queue.manage'] },
      { id: 'tasks', labelKey: 'nav.tasks', icon: ListChecks, href: '/tasks', anyOf: ['task.read', 'task.manage'] },
      { id: 'reminders', labelKey: 'nav.reminders', icon: BellRing, href: '/reminders', anyOf: ['reminder.read', 'reminder.manage'] },
    ],
  },
  {
    id: 'finance',
    labelKey: 'nav.groups.finance',
    items: [
      { id: 'quotations', labelKey: 'nav.quotations', icon: FileText, href: '/quotations', anyOf: ['quotation.read'] },
      { id: 'invoices', labelKey: 'nav.invoices', icon: Receipt, href: '/invoices', anyOf: ['invoice.read'] },
      { id: 'payments', labelKey: 'nav.payments', icon: CreditCard, href: '/payments', anyOf: ['payment.read'] },
      { id: 'cash', labelKey: 'nav.cash', icon: Wallet, href: '/cash', anyOf: ['cash.shift', 'cash.manage'] },
      { id: 'commissions', labelKey: 'nav.commissions', icon: BadgePercent, href: '/commissions', anyOf: ['commission.view_own', 'commission.manage'] },
      { id: 'accounting', labelKey: 'nav.accounting', icon: BookOpenCheck, href: '/accounting', anyOf: ['accounting.read'] },
      { id: 'payroll', labelKey: 'nav.payroll', icon: BadgeDollarSign, href: '/payroll', anyOf: ['payroll.manage', 'payroll.view_own'] },
      { id: 'refunds', labelKey: 'nav.refunds', icon: Undo2, href: '/refunds', anyOf: ['refund.request', 'refund.approve'] },
      // Expenses, fees owed to others, reconciliation and fee settings share one sub-navigation under /finance.
      // The entry opens /finance, which goes on to the first of those tools the role may use (expenses for most).
      { id: 'expenses', labelKey: 'nav.expenses', icon: HandCoins, href: '/finance', anyOf: ['expense.manage', 'payment.reconcile', 'finance.settings', 'report.financial'] },
    ],
  },
  {
    id: 'catalogue',
    labelKey: 'nav.groups.catalogue',
    items: [
      { id: 'services', labelKey: 'nav.services', icon: LayoutGrid, href: '/services', anyOf: ['service.read'] },
      { id: 'workflows', labelKey: 'nav.workflows', icon: Workflow, href: '/workflows', anyOf: ['workflow.manage'] },
    ],
  },
  {
    id: 'insight',
    labelKey: 'nav.groups.insight',
    items: [
      { id: 'reports', labelKey: 'nav.reports', icon: ChartColumn, href: '/reports', anyOf: ['report.operational', 'report.financial'] },
      { id: 'scheduled-reports', parent: 'reports', labelKey: 'nav.scheduledReports', icon: CalendarClock, href: '/reports/scheduled', anyOf: ['report.export'] },
      { id: 'support', labelKey: 'nav.support', icon: LifeBuoy, href: '/support', anyOf: ['ticket.read', 'ticket.manage'] },
      { id: 'automations', labelKey: 'nav.automations', icon: Zap, href: '/automations', anyOf: ['automation.manage'] },
    ],
  },
  {
    id: 'organisation',
    labelKey: 'nav.groups.organisation',
    items: [
      { id: 'staff', labelKey: 'nav.staff', icon: UserCog, href: '/staff', anyOf: ['staff.read'] },
      { id: 'roles', labelKey: 'nav.roles', icon: ShieldCheck, href: '/roles', anyOf: ['role.manage'] },
      { id: 'branches', labelKey: 'nav.branches', icon: MapPin, href: '/branches', anyOf: ['branch.manage'] },
    ],
  },
  {
    id: 'admin',
    labelKey: 'nav.groups.admin',
    items: [
      { id: 'branding', labelKey: 'nav.branding', icon: Palette, href: '/branding', anyOf: ['branding.manage'] },
      { id: 'domains', labelKey: 'nav.domains', icon: Globe, href: '/domains', anyOf: ['domain.manage'] },
      { id: 'integrations', labelKey: 'nav.integrations', icon: Plug, href: '/integrations', anyOf: ['integration.manage'] },
      { id: 'notifications', labelKey: 'nav.notifications', icon: MessageSquareText, href: '/notification-settings', anyOf: ['notification.manage'] },
      { id: 'subscription', labelKey: 'nav.subscription', icon: BadgeCheck, href: '/subscription', anyOf: ['subscription.manage'] },
      { id: 'audit', labelKey: 'nav.audit', icon: ScrollText, href: '/audit-log', anyOf: ['audit.read'] },
      { id: 'privacy', labelKey: 'nav.privacy', icon: Lock, href: '/privacy', anyOf: ['privacy.manage'] },
      { id: 'settings', labelKey: 'nav.settings', icon: Settings, href: '/settings', anyOf: ['settings.manage'] },
    ],
  },
];
