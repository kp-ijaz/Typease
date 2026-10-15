'use client';

import * as React from 'react';
import { Check, Clock, Info } from 'lucide-react';
import { Badge, cn, useI18n } from '@typease/ui';
import type { ComplianceCapability, EffectivePrice, PaymentPolicy, ServiceRequirement } from '@/lib/types';
import { Money } from './shared';

/** "2 hours" below a day, "3 working days" above (8 working hours per day, rounded up). */
export function useProcessingTime() {
  const { tn } = useI18n();
  return (hours: number | null | undefined) => (hours === null || hours === undefined ? null : hours < 8 ? tn('services.hours', hours) : tn('services.days', Math.ceil(hours / 8)));
}

/**
 * The fees of a service before there is a quotation: the centre's own fee is fixed,
 * what authorities and third parties charge is an estimate. Says when money is due.
 */
export function FeeEstimate({ price, className }: { price: EffectivePrice; className?: string }) {
  const { t } = useI18n();
  const rows: Array<[string, string, boolean]> = (
    [
      [t('services.serviceFee'), price.serviceFee, false],
      [t('services.governmentFee'), price.governmentFeeEstimate, true],
      [t('services.thirdPartyFee'), price.thirdPartyFeeEstimate, true],
      [t('services.tax'), price.taxAmount, false],
    ] as Array<[string, string, boolean]>
  ).filter(([, amount]) => Number(amount) > 0);
  const free = Number(price.total) === 0;
  return (
    <div className={className}>
      {free ? (
        <p className="text-base font-medium text-foreground">{t('services.free')}</p>
      ) : (
        <dl className="space-y-2 text-base">
          {rows.map(([label, amount, estimate]) => (
            <div key={label} className="flex items-baseline justify-between gap-4">
              <dt className="text-muted-foreground">
                {label}
                {estimate ? <span className="text-sm"> ({t('services.estimate')})</span> : null}
              </dt>
              <dd>
                <Money amount={amount} currency={price.currency} />
              </dd>
            </div>
          ))}
          <div className="flex items-baseline justify-between gap-4 border-t pt-2 font-semibold">
            <dt>{price.containsEstimates ? t('services.total') : t('my.price.total')}</dt>
            <dd>
              <Money amount={price.total} currency={price.currency} />
            </dd>
          </div>
        </dl>
      )}
      <p className="mt-3 flex gap-2 text-sm text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>
          {free ? t('my.price.freeNote') : price.containsEstimates ? t('services.feesNote') : t('my.price.fixedNote')} {free ? null : <PaymentPolicyText policy={price.paymentPolicy} percent={price.depositPercent} />}
        </span>
      </p>
    </div>
  );
}

function PaymentPolicyText({ policy, percent }: { policy: PaymentPolicy; percent: string | null }) {
  const { t, formatNumber } = useI18n();
  if (policy === 'DEPOSIT') return <>{t('my.price.policy.DEPOSIT', { percent: formatNumber(percent ?? '0', { maximumFractionDigits: 2 }) })}</>;
  return <>{t(`my.price.policy.${policy}`)}</>;
}

/** What the customer has to bring, with required / if available. */
export function RequirementList({ requirements, className }: { requirements: ServiceRequirement[]; className?: string }) {
  const { t, pick } = useI18n();
  if (!requirements.length) return <p className={cn('text-base text-muted-foreground', className)}>{t('services.documentsNone')}</p>;
  return (
    <ul className={cn('divide-y rounded-lg border bg-card', className)}>
      {requirements.map((doc) => (
        <li key={doc.id} className="flex items-start gap-3 p-3.5">
          <Check className="mt-0.5 size-5 shrink-0 text-success-text" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-base font-medium">{pick(doc.label, doc.labelAr)}</p>
            {doc.description ? (
              <p className="text-sm text-muted-foreground" dir="auto">
                {doc.description}
              </p>
            ) : null}
          </div>
          <Badge tone={doc.isMandatory ? 'brand' : 'neutral'}>{doc.isMandatory ? t('services.mandatory') : t('services.optionalDoc')}</Badge>
        </li>
      ))}
    </ul>
  );
}

/** The steps after submission, in plain words, for this service's payment rule and what the centre is allowed to do. */
export function WhatHappensNext({ policy, capability, className }: { policy: PaymentPolicy | null | undefined; capability: ComplianceCapability | null | undefined; className?: string }) {
  const { t } = useI18n();
  const steps = [
    t('my.next.check'),
    t('my.next.quotation'),
    t(`my.next.pay.${policy ?? 'BEFORE_PROCESSING'}`),
    t(`my.next.work.${capability ?? 'DOCUMENT_PREPARATION_ONLY'}`),
    t('my.next.follow'),
  ];
  return (
    <ol className={cn('space-y-2.5', className)}>
      {steps.map((text, index) => (
        <li key={text} className="flex gap-3 text-base text-foreground/90">
          <span aria-hidden="true" className="tabular mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary-soft text-xs font-semibold text-secondary-text">
            {index + 1}
          </span>
          <span>{text}</span>
        </li>
      ))}
    </ol>
  );
}

export function ProcessingTime({ hours }: { hours: number | null | undefined }) {
  const { t } = useI18n();
  const processing = useProcessingTime();
  const time = processing(hours);
  if (!time) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-base">
      <Clock className="size-4 text-muted-foreground" aria-hidden="true" />
      <span className="text-muted-foreground">{t('services.processing')}:</span>
      <span className="font-medium">{time}</span>
    </p>
  );
}
