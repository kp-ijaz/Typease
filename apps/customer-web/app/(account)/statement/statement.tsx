'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { Button, Card, CardContent, DatePicker, EmptyState, Label, PageHeader, Skeleton, useApiClient, useErrorMessage, useI18n, useToast } from '@typease/ui';

interface Statement {
  from: string;
  to: string;
  currency: string;
  openingBalance: string;
  charged: string;
  received: string;
  closingBalance: string;
  lines: Array<{ date: string; type: string; reference: string; debit: string; credit: string; balance: string }>;
}

/** The customer's own statement of account: what was charged, what was paid, and the balance. */
export function MyStatement() {
  const { t, formatMoney, formatDate, today } = useI18n();
  const client = useApiClient();
  const toasts = useToast();
  const describe = useErrorMessage();
  const end = today();
  const [from, setFrom] = React.useState(`${Number(end.slice(0, 4)) - 1}${end.slice(4)}`);
  const [to, setTo] = React.useState(end);
  const st = useQuery({ queryKey: ['my-statement', from, to], queryFn: () => client.get<Statement>('/statement', { query: { from, to } }), enabled: !!from && !!to });
  const s = st.data;
  const download = async () => {
    try {
      const file = await client.download(`/statement/pdf?from=${from}&to=${to}`, { fallbackFilename: 'statement.pdf' });
      const url = URL.createObjectURL(new Blob([file.blob], { type: 'application/pdf' }));
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      toasts.error(describe(e));
    }
  };
  const summary: Array<[string, string | undefined]> = [
    ['my.statement.opening', s?.openingBalance],
    ['my.statement.charged', s?.charged],
    ['my.statement.received', s?.received],
    ['my.statement.closing', s?.closingBalance],
  ];
  return (
    <>
      <PageHeader title={t('nav.statement')} description={t('my.statement.description')} />
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="ms-from">{t('my.statement.from')}</Label>
            <DatePicker id="ms-from" value={from} onChange={setFrom} max={to} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ms-to">{t('my.statement.to')}</Label>
            <DatePicker id="ms-to" value={to} onChange={setTo} min={from} />
          </div>
        </div>
        <Button variant="outline" onClick={() => void download()} disabled={!s}>
          <Download aria-hidden="true" />
          {t('my.statement.download')}
        </Button>
      </div>
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {summary.map(([k, v], i) => (
          <Card key={k}>
            <CardContent className="py-4">
              <p className="text-xs text-muted-foreground">{t(k)}</p>
              {s ? <p className={`text-lg font-semibold tabular ${i === 3 && Number(v) > 0 ? 'text-destructive' : ''}`}>{formatMoney(v, s.currency)}</p> : <Skeleton className="mt-1 h-6 w-24" />}
            </CardContent>
          </Card>
        ))}
      </div>
      {!s ? (
        <Skeleton className="h-64 w-full" />
      ) : s.lines.length === 0 ? (
        <EmptyState title={t('my.statement.empty')} description={t('my.statement.emptyText')} />
      ) : (
        <Card>
          <ul className="divide-y">
            {s.lines.map((l, i) => (
              <li key={i} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                <span className="min-w-0">
                  <span className="block font-medium">{t(`my.statement.types.${l.type}`)}</span>
                  <span className="block text-xs text-muted-foreground tabular">
                    {formatDate(l.date)} · {l.reference}
                  </span>
                </span>
                <span className="text-end tabular">
                  <span className={`block font-medium ${Number(l.debit) > 0 ? '' : 'text-success-text'}`}>{Number(l.debit) > 0 ? formatMoney(l.debit, s.currency) : `− ${formatMoney(l.credit, s.currency)}`}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t('my.statement.balance')} {formatMoney(l.balance, s.currency)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
