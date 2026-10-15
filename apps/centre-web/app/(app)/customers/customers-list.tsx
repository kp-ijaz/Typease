'use client';

import * as React from 'react';
import { ExternalLink, FilePlus2, FileSpreadsheet, Plus, Users } from 'lucide-react';
import type { CustomerListItem } from '@typease/api-client';
import { useSearchParams } from 'next/navigation';
import {
  Badge, Button, DataTable, PageHeader, PermissionGate, STATUS_META, StatusBadge, countryName, formatPhone, useApi, useI18n, useSession, type DataTableColumn, type DataTableFilter,
  type RowAction,
} from '@typease/ui';
import { useCustomerTags } from '@/components/people/customer/tags-card';
import { usePersonName } from '@/components/people/shared';
import { keys } from '@/lib/query-keys';
import { AddCustomerDialog } from '@/components/add-customer-dialog';
import { ImportDialog } from '@/components/import-dialog';

export function CustomersList() {
  const { t, pick, locale, formatRelative, formatDate } = useI18n();
  const api = useApi();
  const [adding, setAdding] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const tags = useCustomerTags();
  const personName = usePersonName();
  const session = useSession();
  const canAdd = session.hasPermission('customer.create');

  // /customers?add=1 (the dashboard's quick action, links from other screens) opens the dialog.
  // The parameter is removed at once, so a reload or the back button does not open it again.
  const addRequested = useSearchParams().get('add') === '1';
  React.useEffect(() => {
    if (!addRequested) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('add');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    if (canAdd) setAdding(true);
  }, [addRequested, canAdd]);

  const columns = React.useMemo<Array<DataTableColumn<CustomerListItem>>>(
    () => [
      { id: 'number', header: t('customers.columns.number'), sortField: 'customerNo', className: 'whitespace-nowrap tabular text-muted-foreground', cell: (c) => c.customerNo },
      {
        id: 'name',
        header: t('customers.columns.name'),
        sortField: 'fullName',
        mobile: 'title',
        cell: (c) => (
          <>
            <span className="block">
              {personName(c.fullName)}
              {/* Only records that are not active say so (the default list shows active customers only). */}
              {c.status === 'ACTIVE' ? null : <StatusBadge kind="customer" status={c.status} className="ms-2 align-middle" />}
            </span>
            {c.fullNameAr ? (
              <span lang="ar" className="block text-sm font-normal text-muted-foreground">
                {c.fullNameAr}
              </span>
            ) : null}
          </>
        ),
      },
      {
        id: 'contact',
        header: t('customers.columns.contact'),
        cell: (c) => (
          <>
            {c.phone ? <span className="ltr-value tabular block">{formatPhone(c.phone)}</span> : null}
            {c.email ? (
              <span className="ltr-value block max-w-56 truncate text-sm text-muted-foreground" title={c.email}>
                {c.email}
              </span>
            ) : null}
            {!c.phone && !c.email ? <span className="text-muted-foreground">–</span> : null}
          </>
        ),
      },
      { id: 'type', header: t('customers.columns.type'), cell: (c) => <Badge tone={c.type === 'BUSINESS' ? 'brand' : 'neutral'}>{t(`customers.types.${c.type}`)}</Badge> },
      { id: 'nationality', header: t('customers.columns.nationality'), cell: (c) => countryName(c.nationality, locale) || <span className="text-muted-foreground">–</span> },
      {
        id: 'portal',
        header: t('customers.columns.portal'),
        mobile: 'badge',
        cell: (c) => {
          const status = typeof c.portalAccess === 'string' ? c.portalAccess : c.portalAccess?.status ?? 'NONE';
          return status === 'NONE' ? null : <StatusBadge kind="portalAccess" status={status} />;
        },
      },
      {
        id: 'activity',
        header: t('customers.columns.lastActivity'),
        sortField: 'lastActivityAt',
        className: 'whitespace-nowrap',
        cell: (c) => <span title={formatDate(c.lastActivityAt ?? c.createdAt)}>{formatRelative(c.lastActivityAt ?? c.createdAt)}</span>,
      },
    ],
    [t, locale, formatRelative, formatDate, personName],
  );

  const filters = React.useMemo<DataTableFilter[]>(
    () => [
      { id: 'type', type: 'select', label: t('customers.filters.type'), options: (['INDIVIDUAL', 'BUSINESS'] as const).map((v) => ({ value: v, label: t(`customers.types.${v}`) })) },
      {
        id: 'hasAccount',
        type: 'select',
        label: t('customers.filters.hasAccount'),
        options: [
          { value: 'true', label: t('customers.hasAccount.yes') },
          { value: 'false', label: t('customers.hasAccount.no') },
        ],
      },
      {
        id: 'status',
        type: 'select',
        label: t('customers.filters.status'),
        allLabel: pick(STATUS_META.customer.ACTIVE.en, STATUS_META.customer.ACTIVE.ar),
        options: [
          ...(['ARCHIVED', 'MERGED'] as const).map((v) => ({ value: v as string, label: pick(STATUS_META.customer[v].en, STATUS_META.customer[v].ar) })),
          { value: 'ALL', label: t('people.list.statusAll') },
        ],
      },
      ...(tags.data?.length ? [{ id: 'tagId', type: 'select' as const, label: t('people.list.tag'), options: tags.data.map((tag) => ({ value: tag.id, label: tag.name })) }] : []),
    ],
    [t, pick, tags.data],
  );

  const rowActions = React.useMemo<Array<RowAction<CustomerListItem>>>(
    () => [
      { id: 'open', label: t('customers.open'), icon: <ExternalLink aria-hidden="true" />, href: (c) => `/customers/${c.id}` },
      { id: 'request', label: t('customers.newRequestFor'), icon: <FilePlus2 aria-hidden="true" />, href: (c) => `/requests/new?customerId=${c.id}` },
    ],
    [t],
  );

  const addButton = (
    <PermissionGate permission="customer.create">
      <Button variant="accent" onClick={() => setAdding(true)}>
        <Plus aria-hidden="true" />
        {t('customers.add')}
      </Button>
    </PermissionGate>
  );

  return (
    <>
      <PageHeader
        title={t('customers.title')}
        description={t('customers.description')}
        action={addButton}
        secondary={
          <PermissionGate permission="customer.create">
            <Button variant="outline" onClick={() => setImporting(true)}>
              <FileSpreadsheet aria-hidden="true" />
              {t('imports.customers.button')}
            </Button>
          </PermissionGate>
        }
      />
      {importing ? <ImportDialog base="/customers" kind="customers" invalidate={keys.customers.all} onClose={() => setImporting(false)} /> : null}
      <DataTable<CustomerListItem>
        caption={t('customers.title')}
        queryKey={keys.customers.all}
        queryFn={(params, signal) => api.customers.list(params as Parameters<typeof api.customers.list>[0], signal)}
        columns={columns}
        rowKey={(c) => c.id}
        rowHref={(c) => `/customers/${c.id}`}
        rowActions={rowActions}
        filters={filters}
        searchPlaceholder={t('customers.searchPlaceholder')}
        defaultSort="createdAt:desc"
        empty={{ icon: <Users />, title: t('customers.emptyTitle'), description: t('customers.emptyText'), action: addButton }}
      />
      <AddCustomerDialog open={adding} onOpenChange={setAdding} />
    </>
  );
}
