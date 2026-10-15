'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Check, Clock, FileText, Info } from 'lucide-react';
import { isApiError } from '@typease/api-client';
import { Alert, Badge, Button, Card, CardContent, EmptyState, Skeleton, SkeletonText, useApi, useBranding, useI18n } from '@typease/ui';
import { ROUTES } from '@/lib/config';
import { useProcessingTime } from '../services-list';

export function ServiceDetail({ id }: { id: string }) {
  const { t, pick, formatMoney } = useI18n();
  const api = useApi();
  const { config } = useBranding();
  const processing = useProcessingTime();
  const query = useQuery({ queryKey: ['public-service', config?.slug, id], queryFn: () => api.public.service(id, config?.slug), enabled: !!config?.slug, retry: false });

  const back = (
    <Button asChild variant="link" className="mb-4">
      <Link href="/services">
        <ArrowLeft className="rtl-mirror" aria-hidden="true" />
        {t('services.back')}
      </Link>
    </Button>
  );

  if (query.isPending) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6" role="status" aria-label={t('common.loading')}>
        <Skeleton className="mb-6 h-9 w-2/3" />
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <SkeletonText lines={8} />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }
  if (query.isError) {
    const missing = isApiError(query.error) && query.error.status === 404;
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        {back}
        {missing ? (
          <Card>
            <EmptyState size="page" icon={<FileText />} title={t('services.notFoundTitle')} description={t('services.notFoundText')} />
          </Card>
        ) : (
          <Alert tone="danger" action={<Button size="sm" variant="outline" onClick={() => void query.refetch()}>{t('common.retry')}</Button>}>
            {t('errors.network')}
          </Alert>
        )}
      </div>
    );
  }

  const { service } = query.data;
  const fees = service.feeEstimate;
  const time = processing(service.estimatedProcessingHours);
  const description = pick(service.description, service.descriptionAr);
  const feeRows = fees
    ? [
        [t('services.serviceFee'), fees.serviceFee],
        [t('services.governmentFee'), fees.governmentFeeEstimate],
        [t('services.thirdPartyFee'), fees.thirdPartyFeeEstimate],
        [t('services.tax'), fees.taxEstimate],
      ].filter(([, amount]) => Number(amount) > 0)
    : [];

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      {back}
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <article className="min-w-0 space-y-8">
          <header>
            <p className="text-sm font-medium text-secondary-text">{pick(service.category.name, service.category.nameAr)}</p>
            <h1 className="mt-1 text-3xl font-semibold">{pick(service.name, service.nameAr)}</h1>
            {description ? <p dir="auto" className="mt-3 max-w-2xl text-md text-foreground/85">{description}</p> : null}
          </header>

          {/* Say plainly what the centre does and what stays with the customer or the authority. */}
          <Alert tone="info">{t(`services.capability.${service.complianceCapability}`)}</Alert>

          <section aria-labelledby="docs-h">
            <h2 id="docs-h" className="text-xl font-semibold">
              {t('services.documentsTitle')}
            </h2>
            {service.requiredDocuments.length === 0 ? (
              <p className="mt-3 text-base text-muted-foreground">{t('services.documentsNone')}</p>
            ) : (
              <ul className="mt-3 divide-y rounded-lg border bg-card">
                {service.requiredDocuments.map((doc) => (
                  <li key={doc.label} className="flex items-start gap-3 p-4">
                    <Check className="mt-0.5 size-5 shrink-0 text-success-text" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <p className="text-base font-medium">{pick(doc.label, doc.labelAr)}</p>
                      {doc.description ? <p className="text-sm text-muted-foreground">{doc.description}</p> : null}
                    </div>
                    <Badge tone={doc.isMandatory ? 'brand' : 'neutral'}>{doc.isMandatory ? t('services.mandatory') : t('services.optionalDoc')}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {service.eligibilityGuidance ? (
            <section aria-labelledby="elig-h">
              <h2 id="elig-h" className="text-xl font-semibold">
                {t('services.eligibility')}
              </h2>
              <p className="mt-3 max-w-2xl text-base text-foreground/85">{service.eligibilityGuidance}</p>
            </section>
          ) : null}
        </article>

        <aside className="lg:sticky lg:top-24">
          <Card>
            <CardContent className="space-y-5">
              {fees ? (
                <div>
                  <h2 className="text-md font-semibold">{t('services.feesTitle')}</h2>
                  <dl className="mt-3 space-y-2 text-base">
                    {feeRows.map(([label, amount]) => (
                      <div key={label} className="flex justify-between gap-4">
                        <dt className="text-muted-foreground">{label}</dt>
                        <dd className="tabular">{formatMoney(amount, fees.currency)}</dd>
                      </div>
                    ))}
                    <div className="flex justify-between gap-4 border-t pt-2 font-semibold">
                      <dt>{t('services.total')}</dt>
                      <dd className="tabular">{formatMoney(fees.totalEstimate, fees.currency)}</dd>
                    </div>
                  </dl>
                  <p className="mt-3 flex gap-2 text-sm text-muted-foreground">
                    <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    {t('services.feesNote')}
                  </p>
                </div>
              ) : null}
              {time ? (
                <p className="flex items-center gap-2 text-base">
                  <Clock className="size-4 text-muted-foreground" aria-hidden="true" />
                  <span className="text-muted-foreground">{t('services.processing')}:</span>
                  <span className="font-medium">{time}</span>
                </p>
              ) : null}
              {service.onlineAvailable ? (
                <div className="space-y-2">
                  <Button asChild variant="accent" size="lg" className="w-full">
                    <Link href={`${ROUTES.newRequest}?serviceId=${service.id}`}>{t('services.start')}</Link>
                  </Button>
                  <p className="text-sm text-muted-foreground">{t('services.startHint')}</p>
                </div>
              ) : (
                <Alert tone="warning" action={<Button asChild size="sm" variant="outline"><Link href="/contact">{t('nav.contact')}</Link></Button>}>
                  {t('services.centreOnly')}
                </Alert>
              )}
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
