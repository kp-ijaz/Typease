'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import type { Page } from '@typease/types';
import { Badge, cn, focusRing, useI18n, useSession } from '@typease/ui';
import { CorporateAccountPicker, CustomerPicker } from '@/components/pickers';
import { finKeys } from '@/lib/keys/fin';
import { useFinApi } from './api';

export type ScopeKey = 'customerId' | 'corporateAccountId' | 'requestId' | 'paymentId' | 'invoiceId' | 'resourceType' | 'resourceId' | 'actorUserId';

/**
 * Record filters that arrive as links from other pages (`/invoices?customerId=...`,
 * `/payments?invoiceId=...`). They live in the URL next to the DataTable's own state:
 * the table only rewrites its own parameters, and so does this hook.
 */
export function useScopeParams(keys: readonly ScopeKey[]) {
  const [values, setValues] = React.useState<Partial<Record<ScopeKey, string>>>({});
  const [ready, setReady] = React.useState(false);
  const keyList = keys.join(',');
  React.useEffect(() => {
    const read = () => {
      const params = new URLSearchParams(window.location.search);
      const next: Partial<Record<ScopeKey, string>> = {};
      for (const key of keyList.split(',') as ScopeKey[]) {
        const v = params.get(key);
        if (v) next[key] = v;
      }
      setValues(next);
    };
    read();
    setReady(true);
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, [keyList]);

  const set = React.useCallback((key: ScopeKey, value: string | undefined) => {
    setValues((current) => {
      const next = { ...current };
      if (value) next[key] = value;
      else delete next[key];
      return next;
    });
    const url = new URL(window.location.href);
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
    url.searchParams.delete('page');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, []);

  /** Stable object for DataTable `fixedParams`. */
  const params = React.useMemo(() => ({ ...values }) as Record<string, string | undefined>, [values]);
  return { values, params, set, ready };
}

function Chip({ label, onRemove }: { label: React.ReactNode; onRemove: () => void }) {
  const { t } = useI18n();
  return (
    <Badge tone="brand" className="h-8 gap-1 pe-1 text-sm">
      {label}
      <button type="button" onClick={onRemove} aria-label={t('fin.scope.remove')} className={cn('inline-flex size-6 items-center justify-center rounded-full hover:bg-secondary-soft', focusRing)}>
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </Badge>
  );
}

/**
 * The row above a money list: choose a customer or company, and see (and remove) the
 * request / payment / invoice the list was opened for.
 */
export function ScopeBar({ scope, show }: { scope: ReturnType<typeof useScopeParams>; show: readonly ScopeKey[] }) {
  const { t } = useI18n();
  const api = useFinApi();
  const session = useSession();
  const { values, set } = scope;

  const customer = useQuery({
    queryKey: finKeys.customerBrief(values.customerId ?? ''),
    queryFn: ({ signal }) => api.customerBrief(values.customerId as string, signal),
    enabled: !!values.customerId && session.hasPermission('customer.read'),
    staleTime: 5 * 60_000,
  });
  const mayReadCompanies = session.hasPermission('corporate.read');
  const company = useQuery({
    queryKey: ['corporate-accounts', 'brief', values.corporateAccountId ?? ''],
    queryFn: ({ signal }) => api.client.get<{ id: string; companyName: string }>(`/corporate-accounts/${values.corporateAccountId}`, { signal }),
    enabled: !!values.corporateAccountId && mayReadCompanies,
    staleTime: 5 * 60_000,
  });
  const request = useQuery({
    queryKey: finKeys.requestBrief(values.requestId ?? ''),
    queryFn: ({ signal }) => api.requestBrief(values.requestId as string, signal),
    enabled: !!values.requestId && session.hasAnyPermission(['request.read.all', 'request.read.assigned']),
    staleTime: 5 * 60_000,
  });
  const invoice = useQuery({
    queryKey: finKeys.invoices.detail(values.invoiceId ?? ''),
    queryFn: ({ signal }) => api.invoices.get(values.invoiceId as string, signal),
    enabled: !!values.invoiceId && show.includes('invoiceId') && session.hasPermission('invoice.read'),
  });
  const payment = useQuery({
    queryKey: finKeys.payments.detail(values.paymentId ?? ''),
    queryFn: ({ signal }) => api.payments.get(values.paymentId as string, signal),
    enabled: !!values.paymentId && show.includes('paymentId') && session.hasPermission('payment.read'),
  });

  const showCustomer = show.includes('customerId') && session.hasPermission('customer.read');
  const showCompany = show.includes('corporateAccountId') && mayReadCompanies;
  const chips = [
    show.includes('requestId') && values.requestId ? <Chip key="request" label={t('fin.scope.request', { number: request.data?.requestNo ?? '…' })} onRemove={() => set('requestId', undefined)} /> : null,
    show.includes('invoiceId') && values.invoiceId ? <Chip key="invoice" label={t('fin.scope.invoice', { number: invoice.data?.invoiceNo ?? '…' })} onRemove={() => set('invoiceId', undefined)} /> : null,
    show.includes('paymentId') && values.paymentId ? <Chip key="payment" label={t('fin.scope.payment', { number: payment.data?.paymentNo ?? '…' })} onRemove={() => set('paymentId', undefined)} /> : null,
  ].filter(Boolean);

  if (!showCustomer && !showCompany && chips.length === 0) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3">
      {showCustomer ? (
        <div className="w-full sm:w-72">
          <CustomerPicker
            aria-label={t('fin.scope.customer')}
            placeholder={t('fin.scope.customerAll')}
            value={values.customerId ?? ''}
            selectedLabel={customer.data?.fullName ?? (values.customerId ? '…' : null)}
            onChange={(id) => set('customerId', id || undefined)}
          />
        </div>
      ) : null}
      {showCompany ? (
        <div className="w-full sm:w-64">
          <CorporateAccountPicker
            aria-label={t('fin.scope.company')}
            placeholder={t('fin.scope.companyAll')}
            value={values.corporateAccountId ?? ''}
            selectedLabel={company.data?.companyName ?? (values.corporateAccountId ? '…' : null)}
            onChange={(id) => set('corporateAccountId', id || undefined)}
          />
        </div>
      ) : null}
      {chips}
    </div>
  );
}

/**
 * The page of rows a DataTable with this query key currently shows (read from the query
 * cache), for totals under the table. Undefined while the first page loads.
 */
export function useActiveListPage<Row>(queryKey: readonly unknown[]): Page<Row> | undefined {
  const queryClient = useQueryClient();
  const key = React.useMemo(() => [...queryKey, 'list'], [queryKey]);
  const read = React.useCallback(() => {
    const active = queryClient.getQueryCache().findAll({ queryKey: key, type: 'active' });
    // With "keep previous data" the newest observer may still be loading: show the page that is on screen.
    for (const query of active) if (query.state.data) return query.state.data as Page<Row>;
    return undefined;
  }, [queryClient, key]);
  const page = React.useSyncExternalStore(
    React.useCallback((notify) => queryClient.getQueryCache().subscribe(notify), [queryClient]),
    read,
    () => undefined,
  );
  // While the next page loads the table keeps showing the previous rows; so do the totals.
  const last = React.useRef(page);
  if (page) last.current = page;
  return page ?? last.current;
}
