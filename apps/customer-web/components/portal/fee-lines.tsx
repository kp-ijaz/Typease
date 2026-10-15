'use client';

import * as React from 'react';
import { useI18n } from '@typease/ui';
import type { FeeComponent, FinanceLine } from '@/lib/types';
import { Money } from './shared';

const ORDER: FeeComponent[] = ['SERVICE_FEE', 'GOVERNMENT_FEE', 'THIRD_PARTY_FEE'];

export interface FeeTotals {
  currency: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
}

/**
 * The lines of a quotation or an invoice, grouped by who the money is for: the
 * centre's own fees, fees collected for an authority, and third-party charges.
 * All amounts and totals are the API's; nothing is calculated here.
 */
export function FeeLines({ lines, totals, children }: { lines: FinanceLine[]; totals: FeeTotals; /** Extra total rows (paid, credited, balance). */ children?: React.ReactNode }) {
  const { t, formatNumber } = useI18n();
  const sorted = [...lines].sort((a, b) => a.sortOrder - b.sortOrder);
  const groups = ORDER.map((component) => ({ component, lines: sorted.filter((line) => line.component === component) })).filter((group) => group.lines.length);
  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <section key={group.component} aria-label={t(`my.fees.groups.${group.component}`)}>
          <h3 className="text-sm font-semibold text-foreground">{t(`my.fees.groups.${group.component}`)}</h3>
          {group.component === 'GOVERNMENT_FEE' ? <p className="text-sm text-muted-foreground">{t('my.fees.governmentNote')}</p> : null}
          <ul className="mt-2 divide-y rounded-lg border">
            {group.lines.map((line) => {
              const quantity = Number(line.quantity);
              return (
                <li key={line.id} className="flex items-baseline justify-between gap-4 px-3.5 py-3">
                  <div className="min-w-0">
                    <p className="text-base text-foreground" dir="auto">
                      {line.description}
                    </p>
                    {quantity !== 1 || Number(line.discountAmount) > 0 ? (
                      <p className="text-sm text-muted-foreground">
                        {quantity !== 1 ? (
                          <>
                            {formatNumber(quantity, { maximumFractionDigits: 2 })} × <Money amount={line.unitAmount} currency={totals.currency} />
                          </>
                        ) : null}
                        {Number(line.discountAmount) > 0 ? (
                          <>
                            {quantity !== 1 ? <span aria-hidden="true"> – </span> : null}
                            {t('my.fees.discount')}: <Money amount={line.discountAmount} currency={totals.currency} />
                          </>
                        ) : null}
                      </p>
                    ) : null}
                  </div>
                  <Money amount={line.lineTotal} currency={totals.currency} className="text-base" />
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <dl className="space-y-2 border-t pt-4 text-base">
        {Number(totals.discountTotal) > 0 ? (
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{t('my.fees.discountIncluded')}</dt>
            <dd>
              <Money amount={totals.discountTotal} currency={totals.currency} />
            </dd>
          </div>
        ) : null}
        {Number(totals.taxTotal) > 0 ? (
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{t('my.fees.taxIncluded')}</dt>
            <dd>
              <Money amount={totals.taxTotal} currency={totals.currency} />
            </dd>
          </div>
        ) : null}
        <div className="flex justify-between gap-4 text-md font-semibold">
          <dt>{t('my.fees.total')}</dt>
          <dd>
            <Money amount={totals.total} currency={totals.currency} />
          </dd>
        </div>
        {children}
      </dl>
    </div>
  );
}
