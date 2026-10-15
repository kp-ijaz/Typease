'use client';

import * as React from 'react';
import Link from 'next/link';
import { cn, focusRing } from '../lib/cn';
import { useI18n } from '../i18n/provider';
import { useBranding } from '../providers/branding';
import { BrandLogo } from '../providers/brand-style';
import { Card } from '../components/card';
import { LanguageSwitcher, ThemeToggle } from '../components/controls';

export interface AuthLayoutProps {
  children: React.ReactNode;
  /**
   * A brand panel shown beside the form from `lg` up (the staff app's sign-in).
   * Leave it out for the portals: a centred card on the centre's own background.
   */
  aside?: React.ReactNode;
  /** Where the logo links to. */
  homeHref?: string;
  /** Small print under the card (terms, support contact). */
  footer?: React.ReactNode;
  /** Wider card for longer forms (centre sign-up). */
  wide?: boolean;
}

/** The frame of every signed-out screen: logo, language and theme controls, and the form in a card. */
export function AuthLayout({ children, aside, homeHref = '/', footer, wide }: AuthLayoutProps) {
  const { config } = useBranding();
  const { t, locale } = useI18n();
  return (
    <div className="flex min-h-dvh bg-background">
      {aside ? <div className="relative hidden w-[42%] max-w-xl shrink-0 flex-col justify-between overflow-hidden bg-sidebar p-10 text-sidebar-foreground lg:flex xl:p-14">{aside}</div> : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between gap-3 px-4 sm:px-8">
          <Link href={homeHref} className={cn('rounded-md', aside && 'lg:invisible', focusRing)} aria-label={t('shell.home')}>
            <BrandLogo config={config} size={30} locale={locale} />
          </Link>
          <div className="flex items-center gap-1">
            <LanguageSwitcher />
            <ThemeToggle />
          </div>
        </header>
        <main id="main" className="flex flex-1 flex-col items-center justify-center px-4 pb-12 pt-4 sm:px-8">
          <div className={cn('w-full', wide ? 'max-w-xl' : 'max-w-[26rem]')}>{children}</div>
          {footer ? <div className={cn('mt-6 w-full text-center text-sm text-muted-foreground', wide ? 'max-w-xl' : 'max-w-[26rem]')}>{footer}</div> : null}
        </main>
      </div>
    </div>
  );
}

export interface AuthCardProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  /** Links under the form (create account, back to sign in). */
  footer?: React.ReactNode;
  className?: string;
}

/** Title + subtitle + form. The title is the page's <h1>. */
export function AuthCard({ title, subtitle, children, footer, className }: AuthCardProps) {
  return (
    <Card className={cn('p-6 shadow-sm sm:p-8', className)}>
      <div className="mb-6 space-y-1.5">
        <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
        {subtitle ? <p className="text-base text-muted-foreground">{subtitle}</p> : null}
      </div>
      {children}
      {footer ? <div className="mt-6 border-t pt-5 text-center text-base text-muted-foreground">{footer}</div> : null}
    </Card>
  );
}

/** Inline text link used inside the auth screens. */
export function AuthLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <Link href={href} className={cn('rounded-sm font-medium text-secondary-text underline-offset-4 hover:underline', focusRing, className)}>
      {children}
    </Link>
  );
}

/**
 * Development servers return one-time tokens in the response (EXPOSE_DEV_TOKENS)
 * because no email or SMS leaves the machine. This box surfaces them so the
 * flows can be walked through locally. Production responses never carry them,
 * so the box never renders there.
 */
export function DevTokenHint({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="mt-4 rounded-md border border-dashed border-warning/60 bg-warning-soft/60 p-3 text-sm text-foreground">
      <p className="font-semibold text-warning-text">{t('auth.dev.title')}</p>
      <p className="mt-0.5 text-muted-foreground">{t('auth.dev.text')}</p>
      <div className="mt-1.5 font-medium">{children}</div>
    </div>
  );
}

/** A 6-digit code field: numeric keypad on phones, SMS / authenticator autofill, large spaced digits. */
export const CodeInput = React.forwardRef<HTMLInputElement, Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'value'> & { value: string; onChange: (value: string) => void; length?: number }>(
  function CodeInput({ value, onChange, length = 6, className, ...props }, ref) {
    return (
      <input
        ref={ref}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        dir="ltr"
        maxLength={length}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/\D/g, '').slice(0, length))}
        className={cn(
          'keep-tracking tabular h-12 w-full rounded-md border border-input bg-card px-3 text-center text-2xl font-semibold tracking-[0.4em] text-foreground shadow-xs outline-none',
          'placeholder:text-muted-foreground/40 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 aria-[invalid=true]:border-destructive',
          className,
        )}
        placeholder={'•'.repeat(length)}
        {...props}
      />
    );
  },
);
