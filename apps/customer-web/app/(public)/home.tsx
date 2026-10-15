'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Mail, Phone, Search } from 'lucide-react';
import { Alert, Button, Card, Skeleton, cn, focusRing, formatPhone, useBranding, useI18n } from '@typease/ui';
import { TILE_TONES, categoryIcon, usePublicCatalogue } from '@/components/catalogue';

const STEPS = ['choose', 'upload', 'pay', 'track', 'receive'] as const;

/** The five steps of a request. Really a sequence, so it is numbered. `onBrand` when it sits on the hero colour. */
function HowItWorks({ onBrand, className }: { onBrand?: boolean; className?: string }) {
  const { t } = useI18n();
  return (
    <div className={cn('rounded-xl border p-6', onBrand ? 'border-sidebar-border bg-sidebar-accent/60' : 'bg-card', className)}>
      <h2 className="text-md font-semibold">{t('home.howTitle')}</h2>
      <ol className="mt-4 space-y-4">
        {STEPS.map((step, index) => (
          <li key={step} className="flex gap-3">
            <span
              aria-hidden="true"
              className={cn('tabular flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold', onBrand ? 'bg-sidebar-foreground/15' : 'bg-secondary-soft text-secondary-text')}
            >
              {index + 1}
            </span>
            <div>
              <p className="text-base font-medium leading-7">{t(`home.steps.${step}.title`)}</p>
              <p className={cn('text-sm', onBrand ? 'text-sidebar-muted' : 'text-muted-foreground')}>{t(`home.steps.${step}.text`)}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function Home() {
  const { t, tn, pick } = useI18n();
  const { config } = useBranding();
  const router = useRouter();
  const catalogue = usePublicCatalogue();
  const [q, setQ] = React.useState('');

  const categories = (catalogue.data?.categories ?? []).filter((c) => c.serviceCount > 0);
  const tagline = config?.tagline && config.mode === 'WHITE_LABEL' ? config.tagline : t('home.tagline');

  return (
    <>
      {/* Hero: the centre's primary colour, the promise, and the one thing to do first: find a service. */}
      <section className="bg-sidebar text-sidebar-foreground">
        <div className="mx-auto grid max-w-6xl grid-cols-1 gap-10 px-4 py-12 sm:px-6 sm:py-16 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-center lg:py-20">
          <div className="min-w-0">
            <h1 className="max-w-xl text-4xl font-semibold sm:text-5xl">{t('home.headline')}</h1>
            <p className="mt-4 text-lg text-sidebar-muted">
              {/* A centre's tagline is in one language: isolate it so its punctuation stays put in the other direction. */}
              <bdi>{tagline}</bdi>
            </p>
            <form
              role="search"
              className="mt-8 flex max-w-xl items-center gap-2 rounded-xl bg-card p-2 shadow-lg"
              onSubmit={(e) => {
                e.preventDefault();
                router.push(q.trim() ? `/services?q=${encodeURIComponent(q.trim())}` : '/services');
              }}
            >
              <label htmlFor="home-search" className="sr-only">
                {t('home.searchLabel')}
              </label>
              <Search className="ms-2 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <input
                id="home-search"
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t('home.searchPlaceholder')}
                enterKeyHint="search"
                className="h-11 w-0 min-w-0 flex-1 bg-transparent text-md text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
              />
              <Button type="submit" variant="accent" size="lg" className="h-11 px-5">
                {t('home.search')}
              </Button>
            </form>
          </div>

          {/* On phones the steps come after the categories: finding a service is the first thing to do. */}
          <HowItWorks onBrand className="hidden lg:block" />
        </div>
      </section>

      <section aria-labelledby="categories-h" className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="categories-h" className="text-2xl font-semibold">
              {t('home.categories')}
            </h2>
            <p className="mt-1 max-w-xl text-base text-muted-foreground">{t('home.categoriesText')}</p>
          </div>
          <Button asChild variant="link">
            <Link href="/services">{t('home.allServices')}</Link>
          </Button>
        </div>

        {config?.publicCatalogueEnabled === false ? (
          <Alert tone="info">{t('home.catalogueClosed')}</Alert>
        ) : catalogue.isPending ? (
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4" role="status" aria-label={t('common.loading')}>
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-[5.5rem]" />
            ))}
          </div>
        ) : catalogue.isError ? (
          <Alert tone="danger" action={<Button size="sm" variant="outline" onClick={() => void catalogue.refetch()}>{t('common.retry')}</Button>}>
            {t('errors.network')}
          </Alert>
        ) : categories.length === 0 ? (
          <Alert tone="info">{t('home.catalogueEmpty')}</Alert>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            {categories.map((category, index) => {
              const Icon = categoryIcon(category.icon);
              return (
                <li key={category.key}>
                  <Link
                    href={`/services?category=${encodeURIComponent(category.key)}`}
                    className={cn('flex h-full flex-col gap-3 rounded-lg border bg-card p-4 shadow-xs transition-shadow hover:shadow-md sm:flex-row sm:items-center sm:gap-4', focusRing)}
                  >
                    <span aria-hidden="true" className={cn('flex size-11 shrink-0 items-center justify-center rounded-[0.625rem] sm:size-12', TILE_TONES[index % TILE_TONES.length])}>
                      <Icon className="size-6" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-base font-semibold leading-5 text-foreground sm:text-md sm:leading-6">{pick(category.name, category.nameAr)}</span>
                      <span className="block text-sm text-muted-foreground">{tn('home.serviceCount', category.serviceCount)}</span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-4 sm:px-6 lg:hidden">
        <HowItWorks />
      </section>

      <section className="mx-auto grid max-w-6xl gap-4 px-4 pb-14 sm:px-6 md:grid-cols-2">
        <Card className="flex flex-col items-start gap-3 p-6">
          <h2 className="text-lg font-semibold">{t('home.trackTitle')}</h2>
          <p className="text-base text-muted-foreground">{t('home.trackText')}</p>
          <Button asChild variant="outline" className="mt-auto">
            <Link href="/track">{t('nav.track')}</Link>
          </Button>
        </Card>
        <Card className="flex flex-col items-start gap-3 p-6">
          <h2 className="text-lg font-semibold">{t('home.helpTitle')}</h2>
          <p className="text-base text-muted-foreground">{t('home.helpText')}</p>
          <div className="mt-auto flex flex-wrap gap-2">
            {config?.supportPhone ? (
              <Button asChild variant="outline">
                <a href={`tel:${config.supportPhone}`}>
                  <Phone aria-hidden="true" />
                  <span className="ltr-value">{formatPhone(config.supportPhone)}</span>
                </a>
              </Button>
            ) : null}
            {config?.supportEmail ? (
              <Button asChild variant="outline">
                <a href={`mailto:${config.supportEmail}`}>
                  <Mail aria-hidden="true" />
                  <span className="ltr-value">{config.supportEmail}</span>
                </a>
              </Button>
            ) : null}
            <Button asChild variant="ghost">
              <Link href="/faq">{t('nav.faq')}</Link>
            </Button>
          </div>
        </Card>
      </section>
    </>
  );
}
