'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { LifeBuoy } from 'lucide-react';
import { DataTable, PageHeader, RequirePermission, STATUS_META, StatusBadge, useI18n, useSession, type DataTableColumn, type DataTableFilter } from '@typease/ui';
import { RelativeTime, Segmented, useUrlState } from '@/components/shared';
import { TenantPicker } from '@/components/tenant-picker';
import { usePlatformApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import type { PlatformTicket, TicketPriority, TicketStatus } from '@/lib/types';

const STATUSES: TicketStatus[] = ['OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED'];
const PRIORITIES: TicketPriority[] = ['URGENT', 'HIGH', 'NORMAL', 'LOW'];

export function SupportDesk() {
  return (
    <RequirePermission anyOf={['platform.support.manage']}>
      <SupportList />
    </RequirePermission>
  );
}

/**
 * The TypEase support desk (GET /platform/support/tickets): questions centres raise with
 * TypEase. The conversation, the centre's name, status and plan; never a centre's customers.
 */
function SupportList() {
  const { t, pick } = useI18n();
  const api = usePlatformApi();
  const session = useSession();
  const [tenantId, setTenantId] = useUrlState('tenantId', '');
  const [show, setShow] = useUrlState('show', 'open');
  // The name of the centre in the filter, when the page was opened with ?tenantId= (from a centre's page).
  const tenant = useQuery({ queryKey: keys.tenants.detail(tenantId), queryFn: ({ signal }) => api.tenants.get(tenantId, signal), enabled: !!tenantId && session.hasPermission('platform.tenants.read'), staleTime: 60_000 });

  const columns = React.useMemo<Array<DataTableColumn<PlatformTicket>>>(
    () => [
      {
        id: 'subject',
        header: t('desk.columns.ticket'),
        mobile: 'title',
        className: 'min-w-64',
        cell: (ticket) => (
          <>
            <span className="block" dir="auto">
              {ticket.subject}
            </span>
            <span className="ltr-value tabular block text-sm font-normal text-muted-foreground">{ticket.ticketNo}</span>
          </>
        ),
      },
      {
        id: 'centre',
        header: t('pc.centre'),
        className: 'min-w-44',
        cell: (ticket) => (
          <>
            <bdi className="block">{ticket.tenant.name}</bdi>
            <span className="block text-sm text-muted-foreground">{ticket.tenant.plan?.name ?? t('tenants.noPlan')}</span>
          </>
        ),
      },
      { id: 'category', header: t('desk.columns.category'), mobile: 'hidden', cell: (ticket) => (ticket.category ? <span dir="auto">{ticket.category}</span> : null) },
      {
        id: 'priority',
        header: t('desk.columns.priority'),
        sortField: 'priority',
        cell: (ticket) => (ticket.priority === 'HIGH' || ticket.priority === 'URGENT' ? <StatusBadge kind="priority" status={ticket.priority} /> : pick(STATUS_META.priority[ticket.priority].en, STATUS_META.priority[ticket.priority].ar)),
      },
      { id: 'status', header: t('pc.status'), sortField: 'status', mobile: 'badge', cell: (ticket) => <StatusBadge kind="ticket" status={ticket.status} /> },
      {
        id: 'assignee',
        header: t('desk.columns.assignee'),
        cell: (ticket) => (ticket.platformAssigneeName ? <bdi>{ticket.platformAssigneeName}</bdi> : <span className="text-muted-foreground">{t('desk.unassigned')}</span>),
      },
      { id: 'updated', header: t('pc.updated'), sortField: 'updatedAt', className: 'whitespace-nowrap', cell: (ticket) => <RelativeTime value={ticket.updatedAt} /> },
    ],
    [t, pick],
  );

  const filters = React.useMemo<DataTableFilter[]>(
    () => [
      { id: 'status', type: 'select', label: t('pc.status'), options: STATUSES.map((s) => ({ value: s, label: pick(STATUS_META.ticket[s].en, STATUS_META.ticket[s].ar) })) },
      { id: 'priority', type: 'select', label: t('desk.columns.priority'), options: PRIORITIES.map((p) => ({ value: p, label: pick(STATUS_META.priority[p].en, STATUS_META.priority[p].ar) })) },
      {
        id: 'assignment',
        type: 'select',
        label: t('desk.columns.assignee'),
        options: [
          { value: 'me', label: t('desk.filters.mine') },
          { value: 'none', label: t('desk.unassigned') },
        ],
      },
    ],
    [t, pick],
  );

  // "Open" is the desk's working view; a status chosen in the filter bar is more specific and wins in the API.
  const fixed = React.useMemo(() => ({ tenantId: tenantId || undefined, open: show === 'all' ? undefined : true }), [tenantId, show]);

  return (
    <>
      <PageHeader title={t('nav.support')} description={t('desk.description')} />
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Segmented
          label={t('desk.filters.show')}
          value={show === 'all' ? 'all' : 'open'}
          onChange={setShow}
          options={[
            { value: 'open', label: t('desk.filters.openOnly') },
            { value: 'all', label: t('desk.filters.everything') },
          ]}
        />
        <div className="w-full sm:w-80">
          <TenantPicker aria-label={t('desk.filters.centre')} placeholder={t('desk.filters.allCentres')} value={tenantId} selectedLabel={tenant.data?.name} onChange={(id) => setTenantId(id)} />
        </div>
      </div>
      <DataTable<PlatformTicket>
        caption={t('nav.support')}
        queryKey={keys.tickets.all}
        queryFn={({ assignment, ...params }, signal) => api.tickets.list({ ...params, assignedToMe: assignment === 'me' ? true : undefined, unassigned: assignment === 'none' ? true : undefined }, signal)}
        fixedParams={fixed}
        columns={columns}
        rowKey={(ticket) => ticket.id}
        rowHref={(ticket) => `/support/${ticket.id}`}
        filters={filters}
        searchPlaceholder={t('desk.searchPlaceholder')}
        defaultSort="updatedAt:desc"
        empty={{ icon: <LifeBuoy />, title: t('desk.emptyTitle'), description: t('desk.emptyText') }}
      />
    </>
  );
}
