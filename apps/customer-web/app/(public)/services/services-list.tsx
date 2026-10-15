'use client';

import * as React from 'react';
import Link from 'next/link';
import { Clock, Globe, SearchX, Store } from 'lucide-react';
import type { PublicService } from '@typease/api-client';
import { Alert, Badge, Button, Card, EmptyState, SearchInput, Skeleton, cn, focusRing, useBranding, useI18n } from '@typease/ui';
import { TILE_TONES, categoryIcon, usePublicCatalogue } from '@/components/catalogue';
import { PublicPage } from '@/components/public-shell';

/** "2 hours" below a day, "3 working days" above (8 working hours per day, rounded up). */
export function useProcessingTime() {
  const { tn } = useI18n();
  return (hours: number | null) => (hours === null ? null : hours < 8 ? tn('services.hours', hours) : tn('services.days', Math.ceil(hours / 8)));
}

export function ServicesList({ initialQuery, initialCategory }: { initialQuery: string; initialCategory: string }) {
  const { t, tn, pick, formatMoney } = useI18n();
  const { name, config } = useBranding();
  const catalogue = usePublicCatalogue();
  const processing = useProcessingTime();
  const [q, setQ] = React.useState(initialQuery);
  const [category, setCategory] = React.useState(initialCategory);

  // Keep the address shareable without a server round trip.
  React.useEffect(() => {
    const url = new URL(window.location.href);
    const set = (key: string, value: string) => (value ? url.searchParams.set(key, value) : url.searchParams.delete(key));
    set('q', q);
    set('category', category);
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`);
  }, [q, category]);

  const categories = (catalogue.data?.categories ?? []).filter((c) => c.serviceCount > 0);
  const services = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (catalogue.data?.services ?? []).filter((s: PublicService) => {
      if (category && s.category.key !== category) return false;
      if (!needle) return true;
      return [s.name, s.nameAr, s.description, s.descriptionAr, s.category.name, s.category.nameAr].some((text) => text?.toLowerCase().includes(needle));
    });
  }, [catalogue.data, q, category]);

  const chip = (key: string, label: string) => (
    <button
      key={key || 'all'}
      type="button"
      aria-pressed={category === key}
      onClick={() => setCategory(key)}
      className={cn(
        'shrink-0 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors',
        category === key ? 'border-secondary bg-secondary text-secondary-foreground' : 'bg-card text-foreground/80 hover:bg-muted',
        focusRing,
      )}
    >
      {label}
    </button>
  );

  return (
    <PublicPage title={t('services.title')} description={t('services.description', { name })}>
      {config?.publicCatalogueEnabled === false ? (
        <Alert tone="info">{t('home.catalogueClosed')}</Alert>
      ) : (
        <>
          <div className="mb-6 space-y-4">
            <div className="max-w-md">
              <SearchInput value={q} onChange={setQ} placeholder={t('services.searchPlaceholder')} aria-label={t('services.searchPlaceholder')} debounceMs={150} />
            </div>
            <div className="scroll-quiet -mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0" role="group" aria-label={t('home.categories')}>
              {chip('', t('services.allCategories'))}
              {categories.map((c) => chip(c.key, pick(c.name, c.nameAr)))}
            </div>
          </div>

          {catalogue.isPending ? (
            <div className="grid gap-4 md:grid-cols-2" role="status" aria-label={t('common.loading')}>
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-40" />
              ))}
            </div>
          ) : catalogue.isError ? (
            <Alert tone="danger" action={<Button size="sm" variant="outline" onClick={() => void catalogue.refetch()}>{t('common.retry')}</Button>}>
              {t('errors.network')}
            </Alert>
          ) : services.length === 0 ? (
            <Card>
              <EmptyState
                icon={<SearchX />}
                title={t('services.emptyTitle')}
                description={t('services.emptyText')}
                action={
                  <Button
                    variant="outline"
                    onClick={() => {
                      setQ('');
                      setCategory('');
                    }}
                  >
                    {t('services.clear')}
                  </Button>
                }
              />
            </Card>
          ) : (
            <>
              <p className="mb-3 text-sm text-muted-foreground" aria-live="polite">
                {tn('services.resultCount', services.length)}
              </p>
              <ul className="grid gap-4 md:grid-cols-2">
                {services.map((service) => {
                  const Icon = categoryIcon(service.category.icon);
                  const tone = TILE_TONES[Math.max(0, categories.findIndex((c) => c.key === service.category.key)) % TILE_TONES.length];
                  const time = processing(service.estimatedProcessingHours);
                  return (
                    <li key={service.id}>
                      <Link href={`/services/${service.id}`} className={cn('flex h-full flex-col gap-3 rounded-lg border bg-card p-5 shadow-xs transition-shadow hover:shadow-md', focusRing)}>
                        <div className="flex items-start gap-3.5">
                          <span aria-hidden="true" className={cn('flex size-10 shrink-0 items-center justify-center rounded-md', tone)}>
                            <Icon className="size-5" />
                          </span>
                          <div className="min-w-0">
                            <h2 className="text-md font-semibold leading-6 text-foreground">{pick(service.name, service.nameAr)}</h2>
                            <p className="text-sm text-muted-foreground">{pick(service.category.name, service.category.nameAr)}</p>
                          </div>
                        </div>
                        {pick(service.description, service.descriptionAr) ? <p dir="auto" className="line-clamp-2 text-base text-foreground/85">{pick(service.description, service.descriptionAr)}</p> : null}
                        <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-3 text-sm">
                          {service.feeEstimate ? (
                            Number(service.feeEstimate.totalEstimate) === 0 ? (
                              <span className="font-semibold text-foreground">{t('services.free')}</span>
                            ) : (
                              <span>
                                <span className="text-muted-foreground">{t('services.from')} </span>
                                <span className="tabular font-semibold text-foreground">{formatMoney(service.feeEstimate.totalEstimate, service.feeEstimate.currency)}</span>
                              </span>
                            )
                          ) : null}
                          {time ? (
                            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                              <Clock className="size-4" aria-hidden="true" />
                              {time}
                            </span>
                          ) : null}
                          <Badge tone={service.onlineAvailable ? 'success' : 'neutral'} className="ms-auto" icon={service.onlineAvailable ? <Globe /> : <Store />}>
                            {service.onlineAvailable ? t('services.online') : t('services.atCentre')}
                          </Badge>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </>
      )}
    </PublicPage>
  );
}
