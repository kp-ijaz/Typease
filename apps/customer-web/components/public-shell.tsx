'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu } from 'lucide-react';
import {
  BrandLogo, Button, LanguageSwitcher, Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle, ThemeToggle, cn, focusRing, isActivePath, useBranding, useI18n,
  useSession,
} from '@typease/ui';
import { ROUTES } from '@/lib/config';

const LINKS = [
  { href: '/', key: 'nav.home', exact: true },
  { href: '/services', key: 'nav.services' },
  { href: '/track', key: 'nav.track' },
  { href: '/faq', key: 'nav.help' },
] as const;
const FOOTER_LINKS = [
  { href: '/about', key: 'nav.about' },
  { href: '/contact', key: 'nav.contact' },
  { href: '/faq', key: 'nav.faq' },
  { href: '/privacy', key: 'nav.privacy' },
  { href: '/terms', key: 'nav.terms' },
] as const;

/** Header and footer of the public pages. One primary action in the header: "Sign up" (or "Dashboard" when logged in). */
export function PublicShell({ children }: { children: React.ReactNode }) {
  const { t, locale } = useI18n();
  const { config, name, isWhiteLabel } = useBranding();
  const session = useSession();
  const pathname = usePathname() ?? '/';
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => setOpen(false), [pathname]);

  const canRegister = config?.features.selfRegistration !== false;
  const account = session.isAuthenticated ? (
    <Button asChild variant="accent">
      <Link href={ROUTES.dashboard}>{t('nav.dashboard')}</Link>
    </Button>
  ) : (
    <>
      <Button asChild variant="outline">
        <Link href={ROUTES.login}>{t('nav.login')}</Link>
      </Button>
      {canRegister ? (
        <Button asChild variant="accent">
          <Link href={ROUTES.register}>{t('nav.register')}</Link>
        </Button>
      ) : null}
    </>
  );

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <a href="#main" className="sr-only z-[60] rounded-md bg-primary px-4 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:start-3 focus:top-3">
        {t('common.skipToContent')}
      </a>
      <header className="sticky top-0 z-30 border-b bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/85">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
          <Link href="/" className={cn('flex min-w-0 items-center gap-3 rounded-md', focusRing)} aria-label={name}>
            <BrandLogo config={config} size={32} locale={locale} className="shrink-0" />
            {/* A TypEase-branded centre shows the TypEase logo: say whose portal this is next to it. */}
            {isWhiteLabel ? null : <span className="truncate border-s ps-3 text-base font-medium text-foreground/80">{name}</span>}
          </Link>
          <nav aria-label={t('shell.mainNavigation')} className="ms-4 hidden shrink-0 items-center gap-1 md:flex lg:ms-6">
            {LINKS.map((link) => {
              const active = isActivePath(pathname, link);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn('rounded-md px-3 py-2 text-base font-medium transition-colors', active ? 'text-secondary-text' : 'text-foreground/80 hover:bg-muted hover:text-foreground', focusRing)}
                >
                  {t(link.key)}
                </Link>
              );
            })}
          </nav>
          <div className="ms-auto flex items-center gap-1.5">
            <LanguageSwitcher className="hidden sm:inline-flex" />
            <ThemeToggle className="hidden sm:inline-flex" size="icon" />
            <div className="hidden items-center gap-2 md:flex">{account}</div>
            <Button variant="ghost" size="icon" className="md:hidden" aria-label={t('nav.menu')} onClick={() => setOpen(true)}>
              <Menu className="!size-5" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </header>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="end" className="w-[min(20rem,88vw)]">
          <SheetHeader>
            <SheetTitle>{t('nav.menu')}</SheetTitle>
            <SheetDescription className="sr-only">{t('shell.mainNavigation')}</SheetDescription>
          </SheetHeader>
          <SheetBody className="flex flex-col gap-1">
            {LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                aria-current={isActivePath(pathname, link) ? 'page' : undefined}
                className={cn('rounded-md px-3 py-2.5 text-md font-medium', isActivePath(pathname, link) ? 'bg-secondary-soft text-secondary-text' : 'hover:bg-muted', focusRing)}
              >
                {t(link.key)}
              </Link>
            ))}
            <div className="mt-4 flex flex-col gap-2 border-t pt-4 [&>*]:w-full">{account}</div>
            <div className="mt-4 flex items-center justify-between border-t pt-4">
              <LanguageSwitcher />
              <ThemeToggle />
            </div>
          </SheetBody>
        </SheetContent>
      </Sheet>

      <main id="main" tabIndex={-1} className="flex-1 outline-none">
        {children}
      </main>

      <footer className="border-t bg-card">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 md:flex-row md:items-center md:justify-between">
          <div className="space-y-2">
            <BrandLogo config={config} size={26} locale={locale} />
            <p className="text-sm text-muted-foreground">{t('footer.rights', { year: new Date().getFullYear(), name })}</p>
          </div>
          <nav aria-label={t('nav.more')} className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            {FOOTER_LINKS.map((link) => (
              <Link key={link.href} href={link.href} className={cn('rounded-sm text-muted-foreground hover:text-foreground hover:underline', focusRing)}>
                {t(link.key)}
              </Link>
            ))}
          </nav>
        </div>
        {/* A white-label portal belongs to the centre: no TypEase mention there. */}
        {isWhiteLabel ? null : (
          <div className="border-t">
            <p className="mx-auto max-w-6xl px-4 py-3 text-xs text-muted-foreground sm:px-6">{t('footer.poweredBy')}</p>
          </div>
        )}
      </footer>
    </div>
  );
}

/** Centred column for text pages and forms inside the public shell. */
export function PublicPage({ title, description, children, narrow }: { title: React.ReactNode; description?: React.ReactNode; children: React.ReactNode; narrow?: boolean }) {
  return (
    <div className={cn('mx-auto px-4 py-8 sm:px-6 sm:py-12', narrow ? 'max-w-3xl' : 'max-w-6xl')}>
      <header className="mb-8">
        <h1 className="text-3xl font-semibold text-foreground">{title}</h1>
        {description ? <p className="mt-2 max-w-2xl text-md text-muted-foreground">{description}</p> : null}
      </header>
      {children}
    </div>
  );
}
