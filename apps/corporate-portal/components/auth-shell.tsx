'use client';

import { ClipboardCheck, ClipboardList, Receipt, Users } from 'lucide-react';
import { AuthLayout, BrandLogo, useBranding, useI18n } from '@typease/ui';

const POINTS = [
  { key: 'employees', icon: Users },
  { key: 'requests', icon: ClipboardList },
  { key: 'approvals', icon: ClipboardCheck },
  { key: 'invoices', icon: Receipt },
] as const;

/** Signed-out frame of the corporate portal: what the portal is for, beside the form on wide screens. */
export function AuthShell({ children }: { children: React.ReactNode }) {
  const { t, locale } = useI18n();
  const { config, name } = useBranding();
  return (
    <AuthLayout
      homeHref="/sign-in"
      aside={
        <>
          <BrandLogo config={config} tone="onDark" size={40} locale={locale} />
          <div className="max-w-md">
            <p className="text-3xl font-semibold leading-tight">{t('auth.aside.headline')}</p>
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
          <p className="text-sm text-sidebar-muted">{t('auth.subtitle', { centre: name })}</p>
        </>
      }
    >
      {children}
    </AuthLayout>
  );
}
