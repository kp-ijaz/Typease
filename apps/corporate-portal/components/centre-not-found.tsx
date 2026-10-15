'use client';

import { Building2 } from 'lucide-react';
import { Card, LanguageSwitcher, Logo, ThemeToggle, useT } from '@typease/ui';

/** Shown instead of the portal when the host, `?tenant=` and the default slug all lead to no centre. */
export function CentreNotFound() {
  const t = useT('centreNotFound');
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="flex h-16 items-center justify-between px-4 sm:px-8">
        <Logo size={30} />
        <div className="flex items-center gap-1">
          <LanguageSwitcher />
          <ThemeToggle />
        </div>
      </header>
      <main className="flex flex-1 items-center justify-center p-6">
        <Card className="w-full max-w-lg p-8 text-center">
          <span aria-hidden="true" className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <Building2 className="size-6" />
          </span>
          <h1 className="text-xl font-semibold">{t('title')}</h1>
          <p className="mt-2 text-base text-muted-foreground">{t('text')}</p>
          <p className="mt-5 text-sm text-muted-foreground">{t('hint')}</p>
          <code dir="ltr" className="mt-1.5 inline-block rounded-md border bg-muted/60 px-3 py-1.5 font-mono text-sm">
            …/?tenant=your-centre
          </code>
        </Card>
      </main>
    </div>
  );
}
