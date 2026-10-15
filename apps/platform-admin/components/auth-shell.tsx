'use client';

import { KeyRound, ShieldCheck } from 'lucide-react';
import { AuthLayout, Logo, useI18n } from '@typease/ui';

const POINTS = [
  { key: 'mfa', icon: ShieldCheck },
  { key: 'access', icon: KeyRound },
] as const;

/** Signed-out frame of the platform console. Always the TypEase brand. */
export function AuthShell({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <AuthLayout
      homeHref="/sign-in"
      aside={
        <>
          <Logo tone="onDark" size={40} />
          <div className="max-w-md">
            <p className="text-3xl font-semibold leading-tight">{t('auth.aside.headline')}</p>
            <p className="mt-3 text-md text-sidebar-muted">{t('auth.aside.text')}</p>
            <ul className="mt-10 space-y-6">
              {POINTS.map(({ key, icon: Icon }) => (
                <li key={key} className="flex gap-4">
                  <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-sidebar-accent text-sidebar-foreground">
                    <Icon className="size-5" />
                  </span>
                  <div>
                    <p className="text-md font-semibold">{t(`auth.aside.points.${key}.title`)}</p>
                    <p className="mt-0.5 text-base text-sidebar-muted">{t(`auth.aside.points.${key}.text`)}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          {/* The panel lays out three blocks (top, middle, bottom); the bottom one stays empty here. */}
          <span aria-hidden="true" />
        </>
      }
    >
      {children}
    </AuthLayout>
  );
}
