import { Bell, CalendarDays, ClipboardList, CreditCard, FileText, FolderOpen, Home, LifeBuoy, MessageSquare, ScrollText, UserRound, type LucideIcon } from 'lucide-react';

/** A number shown next to a navigation entry; where it comes from is decided in the shell (`useNavCounts`). */
export type NavCount = 'requests' | 'quotations' | 'payments' | 'notifications' | 'support';

export interface NavEntry {
  href: string;
  /** Dictionary key of the label. */
  key: string;
  icon: LucideIcon;
  exact?: boolean;
  count?: NavCount;
}

/** Every signed-in screen of the portal, once. The shell arranges them (top bar, "More", phone tab bar, account menu). */
export const NAV = {
  dashboard: { href: '/dashboard', key: 'nav.dashboard', icon: Home, exact: true },
  requests: { href: '/requests', key: 'nav.requests', icon: ClipboardList, count: 'requests' },
  documents: { href: '/documents', key: 'nav.documents', icon: FolderOpen },
  payments: { href: '/payments', key: 'nav.payments', icon: CreditCard, count: 'payments' },
  quotations: { href: '/quotations', key: 'nav.quotations', icon: FileText, count: 'quotations' },
  statement: { href: '/statement', key: 'nav.statement', icon: ScrollText },
  appointments: { href: '/appointments', key: 'nav.appointments', icon: CalendarDays },
  messages: { href: '/messages', key: 'nav.messages', icon: MessageSquare },
  notifications: { href: '/notifications', key: 'nav.notifications', icon: Bell, count: 'notifications' },
  support: { href: '/support', key: 'nav.support', icon: LifeBuoy, count: 'support' },
  profile: { href: '/profile', key: 'nav.profile', icon: UserRound },
} as const satisfies Record<string, NavEntry>;

/** Always visible in the top bar on wide screens. */
export const PRIMARY: NavEntry[] = [NAV.dashboard, NAV.requests, NAV.documents, NAV.payments];
/** Under "More" on wide screens. */
export const SECONDARY: NavEntry[] = [NAV.quotations, NAV.statement, NAV.appointments, NAV.messages, NAV.notifications, NAV.support];
/** The bottom tab bar on phones, after the brand reference: home, requests, [new request], payments, profile. */
export const TABS: NavEntry[] = [{ ...NAV.dashboard, key: 'nav.home' }, NAV.requests, NAV.payments, NAV.profile];
/** In the account menu on phones: everything the tab bar does not hold. */
export const MENU: NavEntry[] = [NAV.documents, ...SECONDARY];

/** Invoices are money too: on an invoice page "Payments" is the current section. */
export const SECTION_ALIASES: Record<string, string> = { '/invoices': '/payments' };
