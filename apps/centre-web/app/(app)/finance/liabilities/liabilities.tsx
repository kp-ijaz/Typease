'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, HandCoins, Landmark } from 'lucide-react';
import { Alert, Card, DataTable, PageHeader, RequirePermission, Skeleton, StatusBadge, useI18n, useSession, type DataTableColumn, type DataTableFilter, type RowAction } from '@typease/ui';
import { useBranch } from '@/components/branch';
import { useFinApi } from '@/components/fin/api';
import { FinanceTabs } from '@/components/fin/finance-tabs';
import { LoadError, Money, useBranchFilter } from '@/components/fin/shared';
import type { LiabilityRequestRow } from '@/components/fin/types';
import { finKeys } from '@/lib/keys/fin';

/** Government and third-party money the centre has collected for others and not yet paid out. */
export function Liabilities() {
  return (
    <RequirePermission anyOf={['report.financial', 'payment.reconcile']}>
      <LiabilitiesInner />
    </RequirePermission>
  );
}

function LiabilitiesInner() {
  const { t } = useI18n();
  const api = useFinApi();
  const session = useSession();
  const { branchId } = useBranch();
  const branchFilter = useBranchFilter();
  const mayRemit = session.hasPermission('expense.manage');

  // Totals per fee component for the branch chosen in the top bar (the list below has its own filters).
  const summary = useQuery({ queryKey: finKeys.liabilities.summary(branchId), queryFn: ({ signal }) => api.liabilities({ branchId, pageSize: 1 }, signal) });

  const part = (amounts: LiabilityRequestRow['governmentFee'], currency: string) =>
    Number(amounts.accrued) === 0 && Number(amounts.outstanding) === 0 ? null : (
      <>
        <Money amount={amounts.outstanding} currency={currency} className={Number(amounts.outstanding) > 0 ? 'font-medium text-foreground' : 'text-muted-foreground'} />
        <span className="block whitespace-nowrap text-xs text-muted-foreground">
          {t('fin.liabilities.collectedShort')} <Money amount={amounts.accrued} currency={currency} />
          {Number(amounts.remitted) > 0 ? (
            <>
              {' · '}
              {t('fin.liabilities.remittedShort')} <Money amount={amounts.remitted} currency={currency} />
            </>
          ) : null}
        </span>
      </>
    );
  const currency = summary.data?.currency ?? session.tenant?.currency ?? 'AED';

  const columns = React.useMemo<Array<DataTableColumn<LiabilityRequestRow>>>(
    () => [
      { id: 'request', header: t('fin.common.request'), mobile: 'title', className: 'whitespace-nowrap', cell: (r) => <span className="tabular">{r.requestNo}</span> },
      { id: 'status', header: t('fin.common.status'), mobile: 'badge', cell: (r) => <StatusBadge kind="request" status={r.requestStatus} /> },
      {
        id: 'customer',
        header: t('fin.common.customer'),
        cell: (r) => (
          <>
            <span className="block font-medium text-foreground">{r.customer?.fullName}</span>
            {r.service ? <span className="block text-sm text-muted-foreground" dir="auto">{r.service}</span> : null}
          </>
        ),
      },
      { id: 'government', header: t('fin.liabilities.columns.government'), align: 'end', cell: (r) => part(r.governmentFee, currency) },
      { id: 'thirdParty', header: t('fin.liabilities.columns.thirdParty'), align: 'end', cell: (r) => part(r.thirdPartyFee, currency) },
      { id: 'outstanding', header: t('fin.liabilities.columns.outstanding'), align: 'end', cell: (r) => <Money amount={r.outstanding} currency={currency} className="font-semibold" /> },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, currency],
  );

  const filters = React.useMemo<DataTableFilter[]>(
    () => [
      ...branchFilter,
      { id: 'component', type: 'select', label: t('fin.liabilities.filters.component'), options: (['GOVERNMENT_FEE', 'THIRD_PARTY_FEE'] as const).map((c) => ({ value: c, label: t(`fin.components.${c}`) })) },
      { id: 'outstandingOnly', type: 'select', label: t('fin.liabilities.filters.show'), allLabel: t('fin.liabilities.filters.everything'), options: [{ value: 'true', label: t('fin.liabilities.filters.outstandingOnly') }] },
    ],
    [t, branchFilter],
  );

  const rowActions = React.useMemo<Array<RowAction<LiabilityRequestRow>>>(
    () => [
      { id: 'open', label: t('fin.common.openRequest'), icon: <ExternalLink aria-hidden="true" />, href: (r) => `/requests/${r.requestId}` },
      {
        id: 'remit-government',
        label: t('fin.liabilities.remitGovernment'),
        icon: <Landmark aria-hidden="true" />,
        href: (r) => `/finance/expenses?new=1&requestId=${r.requestId}&category=GOVERNMENT_FEE_REMITTANCE&amount=${r.governmentFee.outstanding}`,
        hidden: (r) => !mayRemit || Number(r.governmentFee.outstanding) <= 0,
      },
      {
        id: 'remit-third',
        label: t('fin.liabilities.remitThirdParty'),
        icon: <HandCoins aria-hidden="true" />,
        href: (r) => `/finance/expenses?new=1&requestId=${r.requestId}&category=THIRD_PARTY_PAYMENT&amount=${r.thirdPartyFee.outstanding}`,
        hidden: (r) => !mayRemit || Number(r.thirdPartyFee.outstanding) <= 0,
      },
    ],
    [t, mayRemit],
  );

  return (
    <>
      <PageHeader title={t('fin.liabilities.title')} description={t('fin.liabilities.description')} />
      <FinanceTabs current="liabilities" />

      <Alert tone="info" className="mb-6">
        {t('fin.liabilities.explain')}
      </Alert>

      {summary.isPending ? (
        <div className="mb-6 grid gap-4 md:grid-cols-3" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-36" />
          ))}
        </div>
      ) : summary.isError ? (
        <LoadError className="mb-6" error={summary.error} onRetry={() => void summary.refetch()} />
      ) : (
        <div className="mb-6 grid gap-4 md:grid-cols-3">
          {summary.data.components.map((c) => (
            <Card key={c.component} className="p-5">
              <p className="text-sm font-medium text-muted-foreground">{t(`fin.liabilities.owed.${c.component}`)}</p>
              <Money amount={c.outstanding} currency={summary.data.currency} className="mt-1 block text-2xl font-semibold text-foreground" />
              <dl className="mt-3 space-y-1 border-t pt-3 text-sm">
                {(
                  [
                    ['accrued', c.accrued],
                    ['reversed', c.reversed],
                    ['remitted', c.remitted],
                  ] as const
                ).map(([key, amount]) => (
                  <div key={key} className="flex items-baseline justify-between gap-3">
                    <dt className="text-muted-foreground">{t(`fin.liabilities.parts.${key}`)}</dt>
                    <dd>
                      <Money amount={amount} currency={summary.data.currency} />
                    </dd>
                  </div>
                ))}
              </dl>
              {c.treatment !== 'PASS_THROUGH_LIABILITY' ? <p className="mt-3 text-xs text-warning-text">{t('fin.liabilities.treatedAsRevenue')}</p> : null}
            </Card>
          ))}
          <Card className="flex flex-col justify-center bg-primary-soft/60 p-5">
            <p className="text-sm font-medium text-muted-foreground">{t('fin.liabilities.totalOutstanding')}</p>
            <Money amount={summary.data.totalOutstanding} currency={summary.data.currency} className="mt-1 block text-3xl font-semibold text-foreground" />
            <p className="mt-2 text-sm text-muted-foreground">{t('fin.liabilities.totalHint')}</p>
          </Card>
        </div>
      )}

      <h2 className="mb-3 text-lg font-semibold text-foreground">{t('fin.liabilities.perRequest')}</h2>
      <DataTable<LiabilityRequestRow>
        caption={t('fin.liabilities.perRequest')}
        queryKey={finKeys.liabilities.all}
        queryFn={async (params, signal) => (await api.liabilities({ branchId: params.branchId, component: params.component, outstandingOnly: params.outstandingOnly, page: params.page, pageSize: params.pageSize }, signal)).requests}
        columns={columns}
        rowKey={(r) => r.requestId}
        rowHref={(r) => `/requests/${r.requestId}`}
        rowActions={rowActions}
        filters={filters}
        searchable={false}
        empty={{ icon: <Landmark />, title: t('fin.liabilities.emptyTitle'), description: t('fin.liabilities.emptyText') }}
      />
    </>
  );
}
