'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Bell, ChevronDown, Languages, LogOut, Plus, UserRound } from 'lucide-react';
import {
  Avatar, BrandLogo, Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, LanguageSwitcher, RequireAuth,
  ThemeToggle, cn, focusRing, isActivePath, useBranding, useI18n, useSession,
} from '@typease/ui';
import { useUnpaidInvoices } from '@/components/portal/money-hooks';
import { usePortalApi } from '@/lib/api';
import { ROUTES } from '@/lib/config';
import { MENU, PRIMARY, SECONDARY, SECTION_ALIASES, TABS, type NavCount, type NavEntry } from '@/lib/nav';
import { keys } from '@/lib/query-keys';

/** Sections that count as another one for "where am I" (an invoice page belongs to Payments). */
function sectionPath(pathname: string): string {
  for (const [prefix, target] of Object.entries(SECTION_ALIASES)) if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return target;
  return pathname;
}

/**
 * Numbers next to the navigation: what is waiting for the customer. Each one is a
 * count the API gives (unread notifications, requests by status, quotations awaiting
 * a decision, unpaid invoices, support conversations waiting for a reply).
 */
function useNavCounts(): Record<NavCount, number> {
  const api = usePortalApi();
  const every = { staleTime: 60_000, refetchInterval: 120_000 } as const;
  const unread = useQuery({ queryKey: keys.notifications.unread, queryFn: ({ signal }) => api.inbox({ pageSize: 1, unreadOnly: true }, signal), ...every });
  const requests = useQuery({ queryKey: [...keys.requests.all, 'counts'], queryFn: () => api.requestCounts(), ...every });
  const quotations = useQuery({ queryKey: keys.quotations.open, queryFn: ({ signal }) => api.quotations({ status: 'SENT', pageSize: 1 }, signal), ...every });
  const unpaid = useUnpaidInvoices();
  const tickets = useQuery({ queryKey: keys.tickets.open, queryFn: ({ signal }) => api.tickets({ status: 'WAITING_CUSTOMER', pageSize: 1 }, signal), ...every });
  const by = requests.data?.byStatus ?? {};
  return {
    notifications: unread.data?.unreadCount ?? 0,
    // Requests where the next move is the customer's.
    requests: (by.DRAFT ?? 0) + (by.AWAITING_CUSTOMER ?? 0) + (by.QUOTED ?? 0) + (by.AWAITING_PAYMENT ?? 0),
    quotations: quotations.data?.meta.total ?? 0,
    payments: unpaid.data?.length ?? 0,
    support: tickets.data?.meta.total ?? 0,
  };
}

function CountBadge({ value, className }: { value: number; className?: string }) {
  const { formatNumber } = useI18n();
  if (value <= 0) return null;
  return (
    <span className={cn('tabular inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1.5 text-2xs font-semibold leading-none text-accent-foreground', className)}>
      {value > 99 ? '99+' : formatNumber(value)}
    </span>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { t, tn, locale, setLocale } = useI18n();
  const { config, name } = useBranding();
  const session = useSession();
  const pathname = sectionPath(usePathname() ?? '/');
  const router = useRouter();
  const counts = useNavCounts();
  const countOf = (item: NavEntry) => (item.count ? counts[item.count] : 0);
  // The bell already carries the unread notifications.
  const moreCount = SECONDARY.reduce((sum, item) => sum + (item.count === 'notifications' ? 0 : countOf(item)), 0);

  const signOut = async () => {
    await session.signOut();
    router.replace('/');
  };
  const tab = (item: NavEntry) => {
    const active = isActivePath(pathname, item);
    const Icon = item.icon;
    return (
      <Link
        key={item.href}
        href={item.href}
        aria-current={active ? 'page' : undefined}
        className={cn('flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-md py-1.5 text-2xs font-medium', active ? 'text-secondary-text' : 'text-muted-foreground', focusRing)}
      >
        <span className="relative">
          <Icon className="size-5" aria-hidden="true" />
          <CountBadge value={countOf(item)} className="absolute -end-3 -top-1.5 h-4 min-w-4 px-1" />
        </span>
        <span className="max-w-full truncate px-0.5">{t(item.key)}</span>
      </Link>
    );
  };
  const menuItem = (item: NavEntry) => (
    <DropdownMenuItem key={item.href} asChild>
      <Link href={item.href}>
        <item.icon aria-hidden="true" />
        <span className="flex-1">{t(item.key)}</span>
        <CountBadge value={countOf(item)} />
      </Link>
    </DropdownMenuItem>
  );

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <a href="#main" className="sr-only z-[60] rounded-md bg-primary px-4 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:start-3 focus:top-3">
        {t('common.skipToContent')}
      </a>
      <header className="no-print sticky top-0 z-30 border-b bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/85">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-2 px-4 sm:px-6">
          <Link href={ROUTES.dashboard} className={cn('min-w-0 shrink rounded-md', focusRing)} aria-label={name}>
            <BrandLogo config={config} size={30} locale={locale} />
          </Link>
          <nav aria-label={t('shell.mainNavigation')} className="ms-6 hidden items-center gap-0.5 lg:flex">
            {PRIMARY.map((item) => {
              const active = isActivePath(pathname, item);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-2 text-base font-medium transition-colors', active ? 'bg-secondary-soft text-secondary-text' : 'text-foreground/80 hover:bg-muted hover:text-foreground', focusRing)}
                >
                  {t(item.key)}
                  <CountBadge value={countOf(item)} />
                </Link>
              );
            })}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className={cn('px-3', SECONDARY.some((item) => isActivePath(pathname, item)) ? 'bg-secondary-soft text-secondary-text' : 'text-foreground/80')}>
                  {t('nav.more')}
                  <CountBadge value={moreCount} />
                  <ChevronDown aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-60">
                {SECONDARY.map(menuItem)}
              </DropdownMenuContent>
            </DropdownMenu>
          </nav>

          <div className="ms-auto flex shrink-0 items-center gap-1.5">
            <Button asChild variant="accent" className="hidden sm:inline-flex">
              <Link href={ROUTES.newRequest}>
                <Plus aria-hidden="true" />
                {t('nav.newRequest')}
              </Link>
            </Button>
            <Button asChild variant="ghost" size="icon" className="relative text-muted-foreground">
              <Link href="/notifications" aria-label={counts.notifications > 0 ? tn('my.shell.unreadNotifications', counts.notifications) : t('nav.notifications')}>
                <Bell className="!size-5" aria-hidden="true" />
                <CountBadge value={counts.notifications} className="absolute end-0.5 top-0.5 h-4 min-w-4 px-1" />
              </Link>
            </Button>
            <LanguageSwitcher className="hidden text-muted-foreground md:inline-flex" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" aria-label={t('shell.userMenu')} className={cn('relative rounded-full', focusRing)}>
                  <Avatar name={session.user?.fullName} size="sm" />
                  {/* On phones the secondary sections live in this menu: say so when one of them waits for the customer. */}
                  {MENU.some((item) => countOf(item) > 0 && item.count !== 'notifications') ? <span aria-hidden="true" className="absolute -end-0.5 -top-0.5 size-3 rounded-full border-2 border-card bg-accent lg:hidden" /> : null}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-64">
                <DropdownMenuLabel className="space-y-0.5 py-2">
                  <span className="block truncate text-base font-semibold text-foreground">{session.user?.fullName}</span>
                  <span className="block truncate font-normal" dir="ltr">
                    {session.user?.email}
                  </span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href={ROUTES.profile}>
                    <UserRound aria-hidden="true" />
                    {t('nav.profile')}
                  </Link>
                </DropdownMenuItem>
                {/* On phones the secondary sections live here; wide screens have them under "More". */}
                <div className="lg:hidden">{MENU.map(menuItem)}</div>
                <DropdownMenuItem className="md:hidden" onSelect={() => setLocale(locale === 'en' ? 'ar' : 'en')}>
                  <Languages aria-hidden="true" />
                  <span lang={locale === 'en' ? 'ar' : 'en'}>{locale === 'en' ? t('common.arabic') : t('common.english')}</span>
                </DropdownMenuItem>
                <div className="flex items-center justify-between px-2.5 py-1 text-base">
                  <span>{t('theme.label')}</span>
                  <ThemeToggle />
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={(e) => {
                    e.preventDefault();
                    void signOut();
                  }}
                >
                  <LogOut aria-hidden="true" />
                  {t('shell.signOut')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 px-4 pb-28 pt-6 outline-none sm:px-6 sm:pb-12 sm:pt-8">
        {children}
      </main>

      {/* Bottom tab bar (phones): the four places people go most, and "new request" in the middle. */}
      <nav aria-label={t('shell.mainNavigation')} className="no-print fixed inset-x-0 bottom-0 z-30 border-t bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden">
        <div className="mx-auto flex max-w-md items-end gap-1 px-2 pt-1.5">
          {TABS.slice(0, 2).map(tab)}
          <Link href={ROUTES.newRequest} aria-label={t('nav.newRequest')} className={cn('-mt-5 mb-1 flex size-14 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground shadow-md', focusRing)}>
            <Plus className="size-6" aria-hidden="true" />
          </Link>
          {TABS.slice(2).map(tab)}
        </div>
      </nav>
    </div>
  );
}

/** The signed-in part of the customer portal: simple top navigation, and a bottom tab bar on phones. */
export function AccountShell({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth kinds={['CUSTOMER', 'CORPORATE']}>
      <Shell>{children}</Shell>
    </RequireAuth>
  );
}
