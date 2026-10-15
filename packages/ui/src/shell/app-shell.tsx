'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Bell, ChevronDown, KeyRound, Languages, LogOut, Menu, PanelLeftClose, PanelLeftOpen, UserRound } from 'lucide-react';
import { cn, focusRing } from '../lib/cn';
import { useI18n } from '../i18n/provider';
import { useSession } from '../providers/auth';
import { useBranding } from '../providers/branding';
import { BrandLogo } from '../providers/brand-style';
import { Avatar } from '../components/avatar';
import { Button } from '../components/button';
import { LanguageSwitcher, ThemeToggle } from '../components/controls';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../components/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, Tooltip } from '../components/menus';
import { roleDisplayName } from '../lib/roles';
import { SupportSessionBanner } from './support-session';
import { filterNav, findNavItem, type NavGroup } from './nav';

const COLLAPSE_KEY = 'te_sidebar_collapsed';

export interface AppShellProps {
  /** The full navigation of the app as data; it is filtered by the session's permissions here. */
  nav: NavGroup[];
  /** Slot in the top bar for the global search field (hidden below `md`). */
  search?: React.ReactNode;
  /** Slot for the branch switcher. */
  branchSwitcher?: React.ReactNode;
  /** Slot for the notifications bell. Default: a plain bell linking to `notificationsHref` when given. */
  notifications?: React.ReactNode;
  notificationsHref?: string;
  /** Unread notifications: shown as a count on the default bell (and said in its accessible name). */
  notificationsCount?: number;
  profileHref?: string;
  securityHref?: string;
  /** Where the logo links to. */
  homeHref?: string;
  /** Content at the bottom of the sidebar (plan badge, help link). Hidden when collapsed. */
  sidebarFooter?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * For a line that sets its own `dir` (so that truncation cuts its end): keep it on the start side of the
 * LAYOUT, not of its own direction. `text-start` would follow the element's direction.
 */
const START_SIDE = 'ltr:text-left rtl:text-right';

function NavList({ groups, pathname, collapsed, onNavigate }: { groups: NavGroup[]; pathname: string; collapsed: boolean; onNavigate?: () => void }) {
  const { t, dir } = useI18n();
  // One current item: the most specific one (a sub-entry wins over its parent).
  const currentId = findNavItem(groups, pathname)?.id;
  return (
    <nav aria-label={t('shell.mainNavigation')} className="scroll-quiet flex-1 overflow-y-auto px-3 pb-4">
      {groups.map((group, index) => (
        <div key={group.id} className={cn(index > 0 && 'mt-5')}>
          {group.labelKey ? (
            collapsed ? (
              <div aria-hidden="true" className="mx-2 mb-2 border-t border-sidebar-border" />
            ) : (
              <p className="mb-1.5 px-3 text-xs font-medium text-sidebar-muted">{t(group.labelKey)}</p>
            )
          ) : null}
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              // A sub-entry has no place in the icon rail.
              if (item.parent && collapsed) return null;
              const active = item.id === currentId;
              const Icon = item.icon;
              const label = t(item.labelKey);
              const link = (
                <Link
                  href={item.href}
                  onClick={onNavigate}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'group flex h-10 items-center gap-3 rounded-md px-3 text-base font-medium outline-none transition-colors',
                    'focus-visible:ring-2 focus-visible:ring-sidebar-foreground/70',
                    active ? 'bg-sidebar-active text-sidebar-active-foreground' : 'text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground',
                    collapsed && 'justify-center px-0',
                    item.parent && 'h-9 ps-10 text-sm',
                  )}
                >
                  <Icon className={cn('shrink-0', item.parent ? 'size-4' : 'size-[1.125rem]')} aria-hidden="true" />
                  <span className={cn('truncate', collapsed && 'sr-only')}>{label}</span>
                </Link>
              );
              return (
                <li key={item.id}>
                  {collapsed ? (
                    <Tooltip content={label} side={dir === 'rtl' ? 'left' : 'right'} delayDuration={100}>
                      {link}
                    </Tooltip>
                  ) : (
                    link
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/**
 * The frame of the signed-in apps, after the brand reference: a navy sidebar
 * with the logo and grouped navigation (active item in brand blue), and a top
 * bar with search, branch, notifications, language, theme and the account menu.
 *
 *  - `lg` and up: the sidebar is fixed and can be collapsed to an icon rail (remembered per browser).
 *  - below `lg`: the sidebar becomes an off-canvas drawer opened from the top bar.
 *  - Right-to-left: everything mirrors; the sidebar sits on the right.
 */
export function AppShell({ nav, search, branchSwitcher, notifications, notificationsHref, notificationsCount = 0, profileHref, securityHref, homeHref = '/', sidebarFooter, children }: AppShellProps) {
  const session = useSession();
  const i18n = useI18n();
  const { t, locale, setLocale } = i18n;
  const { config } = useBranding();
  const pathname = usePathname() ?? '/';
  const router = useRouter();
  const [collapsed, setCollapsed] = React.useState(false);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [signingOut, setSigningOut] = React.useState(false);

  React.useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === '1');
    } catch {
      /* ignore */
    }
  }, []);
  const toggleCollapsed = () =>
    setCollapsed((value) => {
      try {
        window.localStorage.setItem(COLLAPSE_KEY, value ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !value;
    });

  // Close the drawer when the route changes (link clicked, back button).
  React.useEffect(() => setDrawerOpen(false), [pathname]);

  const groups = React.useMemo(() => filterNav(nav, session), [nav, session]);

  const signOut = async () => {
    setSigningOut(true);
    const supportSession = !!session.supportGrant;
    await session.signOut();
    // After a support session there is nothing to sign in to: <RequireAuth> shows "This support session has ended".
    if (!supportSession) router.replace(session.loginPath);
  };

  const user = session.user;
  // Platform staff have no membership: "SUPER_ADMIN" -> "Super admin".
  const platformRole = user?.platformRole ? user.platformRole.replace(/_/g, ' ').toLowerCase() : '';
  const roleName = session.membership
    ? roleDisplayName({ key: session.membership.roleKey, name: session.membership.roleName }, locale)
    : platformRole.charAt(0).toUpperCase() + platformRole.slice(1);
  const CollapseIcon = collapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <div className="min-h-dvh bg-background">
      <a
        href="#main"
        className="sr-only z-[60] rounded-md bg-primary px-4 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:start-3 focus:top-3"
      >
        {t('common.skipToContent')}
      </a>

      {/* Fixed sidebar (lg+) */}
      <aside
        className={cn(
          'fixed inset-y-0 start-0 z-30 hidden flex-col border-e border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 lg:flex print:!hidden',
          collapsed ? 'w-[4.5rem]' : 'w-64',
        )}
      >
        <div className={cn('flex h-16 shrink-0 items-center', collapsed ? 'justify-center px-2' : 'px-5')}>
          <Link href={homeHref} className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-sidebar-foreground/70" aria-label={t('shell.home')}>
            <BrandLogo config={config} tone="onDark" size={collapsed ? 30 : 32} compact={collapsed} locale={locale} />
          </Link>
        </div>
        <NavList groups={groups} pathname={pathname} collapsed={collapsed} />
        {sidebarFooter && !collapsed ? <div className="shrink-0 border-t border-sidebar-border p-4 text-sm text-sidebar-muted">{sidebarFooter}</div> : null}
      </aside>

      {/* Drawer (below lg) */}
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="start" className="border-sidebar-border bg-sidebar p-0 text-sidebar-foreground [&>button]:text-sidebar-muted [&>button]:hover:bg-sidebar-accent [&>button]:hover:text-sidebar-foreground">
          <SheetTitle className="sr-only">{t('shell.mainNavigation')}</SheetTitle>
          <SheetDescription className="sr-only">{t('shell.mainNavigation')}</SheetDescription>
          <div className="flex h-16 shrink-0 items-center px-5">
            <BrandLogo config={config} tone="onDark" size={30} locale={locale} />
          </div>
          <NavList groups={groups} pathname={pathname} collapsed={false} onNavigate={() => setDrawerOpen(false)} />
        </SheetContent>
      </Sheet>

      {/* Printing a page prints its content: the sidebar, the top bar and the shell's paddings are left out. */}
      <div className={cn('flex min-h-dvh flex-col transition-[padding] duration-200 print:!min-h-0 print:!ps-0', collapsed ? 'lg:ps-[4.5rem]' : 'lg:ps-64')}>
        {/* A TypEase support session announces itself above everything else, permanently (renders nothing otherwise). */}
        <SupportSessionBanner className="sticky top-0 z-20 print:hidden" />
        <header
          className={cn(
            'sticky z-20 flex h-16 shrink-0 items-center gap-2 border-b bg-card/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-card/85 sm:px-5 print:hidden',
            // Below the support bar the top bar scrolls with the page: two sticky rows would eat a phone's screen.
            session.supportGrant ? 'top-auto static' : 'top-0',
          )}
        >
          <Button variant="ghost" size="icon" className="lg:hidden" aria-label={t('shell.openMenu')} onClick={() => setDrawerOpen(true)}>
            <Menu className="!size-5" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="hidden text-muted-foreground lg:inline-flex"
            aria-label={collapsed ? t('shell.expandSidebar') : t('shell.collapseSidebar')}
            aria-pressed={collapsed}
            onClick={toggleCollapsed}
          >
            <CollapseIcon className="rtl-mirror !size-5" aria-hidden="true" />
          </Button>
          <Link href={homeHref} className={cn('rounded-md lg:hidden', focusRing)} aria-label={t('shell.home')}>
            <BrandLogo config={config} size={26} compact locale={locale} />
          </Link>

          <div className="hidden min-w-0 flex-1 md:block md:max-w-md">{search}</div>
          <div className="flex-1 md:hidden" />

          <div className="ms-auto flex items-center gap-1 sm:gap-1.5">
            {branchSwitcher ? <div className="hidden sm:block">{branchSwitcher}</div> : null}
            {notifications ??
              (notificationsHref ? (
                <Button asChild variant="ghost" size="icon" className="relative text-muted-foreground">
                  <Link href={notificationsHref} aria-label={notificationsCount > 0 ? `${t('shell.notifications')}: ${i18n.tn('shell.unread', notificationsCount)}` : t('shell.notifications')}>
                    <Bell className="!size-5" aria-hidden="true" />
                    {notificationsCount > 0 ? (
                      <span
                        aria-hidden="true"
                        data-slot="notifications-count"
                        className="tabular absolute end-0.5 top-0.5 flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full bg-destructive px-1 text-[0.6875rem] font-semibold leading-none text-destructive-foreground ring-2 ring-card"
                      >
                        {notificationsCount > 99 ? '99+' : i18n.formatNumber(notificationsCount)}
                      </span>
                    ) : null}
                  </Link>
                </Button>
              ) : null)}
            <LanguageSwitcher className="hidden text-muted-foreground sm:inline-flex" />
            <ThemeToggle size="icon" className="hidden text-muted-foreground sm:inline-flex" />

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t('shell.userMenu')}
                  className={cn('ms-1 flex items-center gap-2.5 rounded-full py-1 pe-1 ps-1 hover:bg-muted sm:rounded-lg sm:pe-2', focusRing)}
                >
                  <Avatar name={user?.fullName} size="sm" />
                  <span className="hidden min-w-0 text-start sm:block">
                    {/* dir="auto": the ellipsis goes at the END of the name, whichever way the name is written. Without it an
                        English name in the Arabic layout loses its beginning. The text still sits on the layout's start side. */}
                    <span dir="auto" className={cn('block max-w-36 truncate text-sm font-semibold leading-4 text-foreground', START_SIDE)}>
                      {user?.fullName}
                    </span>
                    <span dir="auto" className={cn('block max-w-36 truncate text-xs leading-4 text-muted-foreground', START_SIDE)}>
                      {roleName}
                    </span>
                  </span>
                  <ChevronDown className="hidden size-4 text-muted-foreground sm:block" aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-64">
                <DropdownMenuLabel className="space-y-0.5 py-2">
                  <span dir="auto" className={cn('block truncate text-base font-semibold text-foreground', START_SIDE)}>
                    {user?.fullName}
                  </span>
                  <span className={cn('block truncate font-normal', START_SIDE)} dir="ltr">
                    {user?.email}
                  </span>
                  {session.tenant ? (
                    <span dir="auto" className={cn('block truncate font-normal', START_SIDE)}>
                      {session.tenant.name}
                    </span>
                  ) : null}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {profileHref ? (
                  <DropdownMenuItem asChild>
                    <Link href={profileHref}>
                      <UserRound aria-hidden="true" />
                      {t('shell.profile')}
                    </Link>
                  </DropdownMenuItem>
                ) : null}
                {securityHref ? (
                  <DropdownMenuItem asChild>
                    <Link href={securityHref}>
                      <KeyRound aria-hidden="true" />
                      {t('shell.security')}
                    </Link>
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem className="sm:hidden" onSelect={() => setLocale(locale === 'en' ? 'ar' : 'en')}>
                  <Languages aria-hidden="true" />
                  <span lang={locale === 'en' ? 'ar' : 'en'}>{locale === 'en' ? t('common.arabic') : t('common.english')}</span>
                </DropdownMenuItem>
                <div className="flex items-center justify-between px-2.5 py-1 text-base sm:hidden">
                  <span>{t('theme.label')}</span>
                  <ThemeToggle />
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={signingOut}
                  onSelect={(e) => {
                    e.preventDefault();
                    void signOut();
                  }}
                >
                  <LogOut aria-hidden="true" />
                  {signingOut ? t('shell.signingOut') : t('shell.signOut')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[90rem] flex-1 px-4 py-6 outline-none sm:px-6 lg:px-8 lg:py-8 print:!max-w-none print:!p-0">
          {children}
        </main>
      </div>
    </div>
  );
}
