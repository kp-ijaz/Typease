'use client';

import * as React from 'react';
import Link from 'next/link';
import { Compass, Construction, RotateCw, TriangleAlert } from 'lucide-react';
import { useI18n } from '../i18n/provider';
import { Button } from '../components/button';
import { Card } from '../components/card';
import { PageHeader, type Crumb } from '../components/display';
import { EmptyState } from '../components/empty-state';
import { Skeleton } from '../components/skeleton';

/** Body of `app/error.tsx`: what happened in plain words, a retry, and a reference for support. */
export function ErrorScreen({ error, reset, homeHref = '/' }: { error: Error & { digest?: string }; reset: () => void; homeHref?: string }) {
  const { t } = useI18n();
  React.useEffect(() => {
    // Leave a trace for whoever looks at the browser console; error reporting hooks in here.
    console.error(error);
  }, [error]);
  return (
    <div className="flex min-h-[70dvh] items-center justify-center p-6">
      <Card role="alert" className="w-full max-w-lg p-8 text-center">
        <span aria-hidden="true" className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-destructive-soft text-destructive-text">
          <TriangleAlert className="size-6" />
        </span>
        <h1 className="text-xl font-semibold">{t('errors.pageErrorTitle')}</h1>
        <p className="mt-2 text-base text-muted-foreground">{t('errors.pageErrorDescription')}</p>
        {error.digest ? <p className="tabular mt-3 text-sm text-muted-foreground">{t('errors.reference', { id: error.digest })}</p> : null}
        <div className="mt-6 flex flex-col justify-center gap-2 sm:flex-row">
          <Button onClick={reset}>
            <RotateCw aria-hidden="true" />
            {t('common.retry')}
          </Button>
          <Button asChild variant="outline">
            <Link href={homeHref}>{t('errors.goHome')}</Link>
          </Button>
        </div>
      </Card>
    </div>
  );
}

/** Body of `app/not-found.tsx`. */
export function NotFoundScreen({ homeHref = '/' }: { homeHref?: string }) {
  const { t } = useI18n();
  return (
    <div className="flex min-h-[70dvh] items-center justify-center p-6">
      <EmptyState
        size="page"
        icon={<Compass />}
        title={<span className="text-xl">{t('errors.pageNotFoundTitle')}</span>}
        description={t('errors.pageNotFoundDescription')}
        action={
          <Button asChild>
            <Link href={homeHref}>{t('errors.goHome')}</Link>
          </Button>
        }
      />
    </div>
  );
}

/** Body of `loading.tsx` inside the shell: the shape of a page header and a list. */
export function PageSkeleton({ label }: { label?: string }) {
  return (
    <div role="status" aria-label={label ?? 'Loading'} className="space-y-6">
      <div className="space-y-2.5">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[4.75rem]" />
        ))}
      </div>
      <Skeleton className="h-72 w-full" />
    </div>
  );
}

/**
 * TEMPORARY marker for a route whose page has not been built yet: a proper
 * page header (so navigation, titles and breadcrumbs already work) and an
 * honest empty state. Replace the whole page; do not build on this component.
 */
export function SectionPlaceholder({ title, description, breadcrumbs }: { title: string; description?: string; breadcrumbs?: Crumb[] }) {
  const { t } = useI18n();
  return (
    <>
      <PageHeader title={title} description={description} breadcrumbs={breadcrumbs} />
      <Card>
        <EmptyState size="page" icon={<Construction />} title={t('common.comingSoon')} description={t('common.comingSoonDescription')} />
      </Card>
    </>
  );
}
