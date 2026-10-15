'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileText, Printer, Scale, TrendingDown, TrendingUp } from 'lucide-react';
import { Button, DatePicker, EmptyState, Label, Skeleton, StatCard, useApiClient, useI18n } from '@typease/ui';
import { PdfDialog } from './shared';

interface Statement {
  from: string;
  to: string;
  currency: string;
  openingBalance: string;
  charged: string;
  received: string;
  closingBalance: string;
  lines: Array<{ date: string; type: string; reference: string; description: string; debit: string; credit: string; balance: string }>;
  ageing: Record<'current' | 'days1to30' | 'days31to60' | 'days61to90' | 'days90plus', string>;
}

/**
 * Statement of account of one individual customer. `path` is `/customers/:id/statement` for staff and `/statement`
 * for the signed-in customer; the PDF lives under the same path.
 */
export function CustomerStatement({ path }: { path: string }) {
  const { t, formatMoney, formatDate, today } = useI18n();
  const client = useApiClient();
  const end = today();
  const [from, setFrom] = React.useState(`${Number(end.slice(0, 4)) - 1}${end.slice(4)}`);
  const [to, setTo] = React.useState(end);
  const [pdf, setPdf] = React.useState(false);
  const st = useQuery({ queryKey: ['statement', path, from, to], queryFn: () => client.get<Statement>(path, { query: { from, to } }), enabled: !!from && !!to });
  const s = st.data;
  const nz = (v: string) => (Number(v) === 0 ? '' : formatMoney(v, s?.currency));
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="st-from">{t('statement.from')}</Label>
            <DatePicker id="st-from" value={from} onChange={setFrom} max={to} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="st-to">{t('statement.to')}</Label>
            <DatePicker id="st-to" value={to} onChange={setTo} min={from} />
          </div>
        </div>
        <Button variant="outline" onClick={() => setPdf(true)} disabled={!s}>
          <Printer aria-hidden="true" />
          {t('statement.pdf')}
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
        <StatCard tone="neutral" icon={<FileText />} label={t('statement.opening')} value={formatMoney(s?.openingBalance, s?.currency)} loading={!s} />
        <StatCard tone="warning" icon={<TrendingUp />} label={t('statement.charged')} value={formatMoney(s?.charged, s?.currency)} loading={!s} />
        <StatCard tone="success" icon={<TrendingDown />} label={t('statement.received')} value={formatMoney(s?.received, s?.currency)} loading={!s} />
        <StatCard tone={s && Number(s.closingBalance) > 0 ? 'danger' : 'brand'} icon={<Scale />} label={t('statement.closing')} value={formatMoney(s?.closingBalance, s?.currency)} loading={!s} />
      </div>
      {!s ? (
        <Skeleton className="h-64 w-full" />
      ) : s.lines.length === 0 && Number(s.openingBalance) === 0 ? (
        <EmptyState icon={<FileText />} title={t('statement.empty')} description={t('statement.emptyText')} />
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('statement.title')}</caption>
            <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                {(['date', 'reference', 'description', 'debit', 'credit', 'balance'] as const).map((c) => (
                  <th key={c} scope="col" className={`px-3 py-2.5 font-medium ${['debit', 'credit', 'balance'].includes(c) ? 'text-end' : 'text-start'}`}>
                    {t(`statement.columns.${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              <tr className="bg-muted/20 font-medium">
                <td className="px-3 py-2 tabular">{formatDate(s.from)}</td>
                <td className="px-3 py-2" />
                <td className="px-3 py-2">{t('statement.opening')}</td>
                <td className="px-3 py-2" />
                <td className="px-3 py-2" />
                <td className="px-3 py-2 text-end tabular">{formatMoney(s.openingBalance, s.currency)}</td>
              </tr>
              {s.lines.map((l, i) => (
                <tr key={i}>
                  <td className="whitespace-nowrap px-3 py-2 tabular">{formatDate(l.date)}</td>
                  <td className="px-3 py-2 tabular">{l.reference}</td>
                  <td className="px-3 py-2">{t(`statement.types.${l.type}`)}</td>
                  <td className="px-3 py-2 text-end tabular">{nz(l.debit)}</td>
                  <td className="px-3 py-2 text-end tabular">{nz(l.credit)}</td>
                  <td className="px-3 py-2 text-end font-medium tabular">{formatMoney(l.balance, s.currency)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t bg-muted/30 font-semibold">
              <tr>
                <td className="px-3 py-2.5 tabular">{formatDate(s.to)}</td>
                <td className="px-3 py-2.5" />
                <td className="px-3 py-2.5">{t('statement.closing')}</td>
                <td className="px-3 py-2.5 text-end tabular">{formatMoney(s.charged, s.currency)}</td>
                <td className="px-3 py-2.5 text-end tabular">{formatMoney(s.received, s.currency)}</td>
                <td className="px-3 py-2.5 text-end tabular">{formatMoney(s.closingBalance, s.currency)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {s ? (
        <section aria-labelledby="st-ageing" className="space-y-2">
          <h3 id="st-ageing" className="text-sm font-semibold">
            {t('statement.ageing')}
          </h3>
          <dl className="grid gap-2 sm:grid-cols-5">
            {(['current', 'days1to30', 'days31to60', 'days61to90', 'days90plus'] as const).map((k) => (
              <div key={k} className="rounded-lg border bg-card px-3 py-2">
                <dt className="text-xs text-muted-foreground">{t(`statement.buckets.${k}`)}</dt>
                <dd className={`font-semibold tabular ${k === 'days90plus' && Number(s.ageing[k]) > 0 ? 'text-destructive' : ''}`}>{formatMoney(s.ageing[k], s.currency)}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-muted-foreground">{t('statement.companyNote')}</p>
        </section>
      ) : null}
      <PdfDialog open={pdf} onOpenChange={setPdf} path={`${path}/pdf?from=${from}&to=${to}`} title={t('statement.title')} fallbackFilename="statement.pdf" />
    </div>
  );
}
