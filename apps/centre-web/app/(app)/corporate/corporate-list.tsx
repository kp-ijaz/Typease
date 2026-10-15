'use client';

import * as React from 'react';
import { Building2, ExternalLink, FilePlus2, Plus } from 'lucide-react';
import type { Page } from '@typease/types';
import { Badge, Button, DataTable, PageHeader, PermissionGate, RequirePermission, STATUS_META, StatusBadge, addDays, useApi, useI18n, useSession, type DataTableColumn, type DataTableFilter, type RowAction } from '@typease/ui';
import { CorporateAccountDialog } from '@/components/people/corporate/account-dialog';
import { UpgradeAlert, usePlan } from '@/components/people/shared';
import type { CorporateAccount } from '@/components/people/types';
import { peopleKeys } from '@/lib/keys/people';

const STATUSES = ['PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'ARCHIVED'] as const;

/** Companies the centre serves. */
export function CorporateList() {
  return (
    <RequirePermission anyOf={['corporate.read']}>
      <Companies />
    </RequirePermission>
  );
}

function Companies() {
  const { t, tn, pick, formatDate, formatMoney, formatNumber, today } = useI18n();
  const api = useApi();
  const session = useSession();
  const plan = usePlan();
  const [adding, setAdding] = React.useState(false);

  // Plan limit "corporateClients": archived companies do not count (the API decides; this is the message up front).
  const usage = plan.data?.usage.find((u) => u.metric === 'corporateClients');
  const limitReached = !!usage && usage.limit !== null && usage.used >= usage.limit;

  const columns = React.useMemo<Array<DataTableColumn<CorporateAccount>>>(
    () => [
      { id: 'number', header: t('people.corporate.columns.number'), sortField: 'accountNo', className: 'whitespace-nowrap tabular text-muted-foreground', cell: (a) => a.accountNo },
      {
        id: 'name',
        header: t('people.corporate.columns.company'),
        sortField: 'companyName',
        mobile: 'title',
        cell: (a) => (
          <>
            <span className="block">{a.companyName}</span>
            {a.companyNameAr ? (
              <span lang="ar" className="block text-sm font-normal text-muted-foreground">
                {a.companyNameAr}
              </span>
            ) : null}
          </>
        ),
      },
      { id: 'status', header: t('requests.columns.status'), mobile: 'badge', cell: (a) => <StatusBadge kind="corporate" status={a.status} /> },
      {
        id: 'licence',
        header: t('people.corporate.columns.licence'),
        cell: (a) =>
          a.tradeLicenceNo ? (
            <>
              <span className="ltr-value tabular block">{a.tradeLicenceNo}</span>
              {a.tradeLicenceExpiry ? (
                <span className={`tabular block text-sm ${a.tradeLicenceExpiry < today() ? 'font-medium text-destructive-text' : a.tradeLicenceExpiry < addDays(today(), 30) ? 'font-medium text-warning-text' : 'text-muted-foreground'}`}>{t('people.corporate.columns.licenceUntil', { date: formatDate(a.tradeLicenceExpiry) })}</span>
              ) : null}
            </>
          ) : null,
      },
      { id: 'employees', header: t('people.corporate.columns.employees'), align: 'end', className: 'tabular', cell: (a) => formatNumber(a.employeeCount ?? 0) },
      {
        id: 'credit',
        header: t('people.corporate.columns.credit'),
        className: 'whitespace-nowrap',
        cell: (a) => (a.creditApproved ? <span className="tabular">{formatMoney(a.creditLimit)}</span> : a.creditLimit && Number(a.creditLimit) > 0 ? <Badge tone="warning">{t('people.corporate.credit.notApproved')}</Badge> : null),
      },
      { id: 'created', header: t('customers.columns.created'), sortField: 'createdAt', className: 'whitespace-nowrap tabular', cell: (a) => formatDate(a.createdAt) },
    ],
    [t, formatDate, formatMoney, formatNumber, today],
  );

  const filters = React.useMemo<DataTableFilter[]>(
    () => [
      {
        id: 'status',
        type: 'select',
        label: t('requests.columns.status'),
        allLabel: t('people.corporate.filters.notArchived'),
        options: [...STATUSES.map((s) => ({ value: s as string, label: pick(STATUS_META.corporate[s].en, STATUS_META.corporate[s].ar) })), { value: 'ALL', label: t('people.corporate.filters.everything') }],
      },
    ],
    [t, pick],
  );

  const rowActions = React.useMemo<Array<RowAction<CorporateAccount>>>(
    () => [
      { id: 'open', label: t('people.corporate.open'), icon: <ExternalLink aria-hidden="true" />, href: (a) => `/corporate/${a.id}` },
      ...(session.hasPermission('request.create') ? [{ id: 'request', label: t('customers.newRequestFor'), icon: <FilePlus2 aria-hidden="true" />, hidden: (a: CorporateAccount) => a.status !== 'ACTIVE', href: (a: CorporateAccount) => `/requests/new?corporateAccountId=${a.id}` }] : []),
    ],
    [t, session],
  );

  const addButton = (
    <PermissionGate permission="corporate.manage">
      <Button variant="accent" onClick={() => setAdding(true)} disabled={limitReached}>
        <Plus aria-hidden="true" />
        {t('people.corporate.add')}
      </Button>
    </PermissionGate>
  );

  return (
    <>
      <PageHeader title={t('nav.corporate')} description={t('sections.corporate')} action={addButton} />
      {limitReached && usage ? (
        <UpgradeAlert className="mb-4" title={t('people.corporate.limit.title')}>
          {usage.limit === 0 ? t('people.corporate.limit.none') : tn('people.corporate.limit.text', usage.limit ?? 0)}
        </UpgradeAlert>
      ) : null}
      <DataTable<CorporateAccount>
        caption={t('nav.corporate')}
        queryKey={peopleKeys.corporate.all}
        queryFn={(params, signal) => api.client.get<Page<CorporateAccount>>('/corporate-accounts', { query: params, signal })}
        columns={columns}
        rowKey={(a) => a.id}
        rowHref={(a) => `/corporate/${a.id}`}
        rowActions={rowActions}
        filters={filters}
        searchPlaceholder={t('people.corporate.searchPlaceholder')}
        defaultSort="createdAt:desc"
        empty={{ icon: <Building2 />, title: t('people.corporate.emptyTitle'), description: t('people.corporate.emptyText'), action: addButton }}
      />
      {usage && usage.limit !== null && !limitReached ? <p className="mt-3 text-sm text-muted-foreground">{t('people.corporate.limit.usage', { used: formatNumber(usage.used), limit: formatNumber(usage.limit) })}</p> : null}
      {adding ? <CorporateAccountDialog open onOpenChange={setAdding} /> : null}
    </>
  );
}
