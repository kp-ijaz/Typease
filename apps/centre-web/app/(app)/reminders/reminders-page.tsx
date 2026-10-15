'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { BellPlus, BellRing, CalendarClock, Eye } from 'lucide-react';
import type { Page } from '@typease/types';
import {
  Button, Card, DataTable, PageHeader, PermissionGate, RequirePermission, StatCard, cn, focusRing, useApi, useI18n, useSession, type DataTableColumn, type DataTableFilter,
} from '@typease/ui';
import { CorporateAccountPicker, CustomerPicker, useDocumentTypes } from '@/components/pickers';
import { RenewalAutopilotCard } from './renewal-autopilot';
import { Field, OpsStatusBadge, useUrlParam } from '@/components/ops/common';
import type { Reminder } from '@/components/ops/types';
import { opsKeys } from '@/lib/keys/ops';
import { ReminderDialog } from './reminder-dialog';
import { ReminderSheet } from './reminder-sheet';

const WINDOWS = [7, 30, 60, 90];

export function RemindersPage() {
  return (
    <RequirePermission anyOf={['reminder.read', 'reminder.manage']}>
      <Reminders />
    </RequirePermission>
  );
}

/** Expiry reminders: which documents run out soon, who is reminded when, and what was sent. */
function Reminders() {
  const { t, tn, pick, formatDate, formatNumber } = useI18n();
  const api = useApi();
  const session = useSession();
  const types = useDocumentTypes();
  const urlCustomer = useUrlParam('customerId');
  const [customerId, setCustomerId] = React.useState('');
  const [customerLabel, setCustomerLabel] = React.useState<string | null>(null);
  const [corporateId, setCorporateId] = React.useState('');
  const [selected, setSelected] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<Reminder | 'new' | null>(null);
  const [tableKey, setTableKey] = React.useState(0);

  // Deep link from a customer's page: /reminders?customerId=...
  React.useEffect(() => {
    if (urlCustomer) setCustomerId(urlCustomer);
  }, [urlCustomer]);
  const linked = useQuery({
    queryKey: ['customers', 'name', customerId],
    queryFn: () => api.client.get<{ id: string; fullName: string }>(`/customers/${customerId}`),
    enabled: !!customerId && !customerLabel && session.hasPermission('customer.read'),
    staleTime: 5 * 60_000,
  });
  const scope = React.useMemo(() => ({ customerId: customerId || undefined, corporateAccountId: corporateId || undefined }), [customerId, corporateId]);

  const columns = React.useMemo<Array<DataTableColumn<Reminder>>>(
    () => [
      {
        id: 'subject',
        header: t('ops.reminders.columns.subject'),
        mobile: 'title',
        cell: (r) => (
          <>
            <button type="button" onClick={() => setSelected(r.id)} className={cn('block max-w-80 truncate rounded-sm text-start font-medium text-secondary-text hover:underline', focusRing)} dir="auto">
              {r.subjectLabel}
            </button>
            <span className="block text-sm font-normal text-muted-foreground">{r.corporateName ?? r.customerName ?? ''}</span>
          </>
        ),
      },
      { id: 'type', header: t('ops.reminders.columns.type'), cell: (r) => pick(r.documentTypeName, r.documentTypeNameAr) },
      {
        id: 'expiry',
        header: t('ops.reminders.columns.expiry'),
        sortField: 'expiryDate',
        className: 'whitespace-nowrap',
        cell: (r) => (
          <>
            <span className="tabular block">{formatDate(r.expiryDate)}</span>
            <span className={cn('block text-sm', r.daysLeft <= 30 && (r.status === 'ACTIVE' || r.status === 'PAUSED') ? 'font-medium text-warning-text' : 'text-muted-foreground')}>
              {r.daysLeft < 0 ? t('ops.reminders.expired') : r.daysLeft === 0 ? t('ops.reminders.expiresToday') : tn('ops.reminders.daysLeft', r.daysLeft)}
            </span>
          </>
        ),
      },
      { id: 'next', header: t('ops.reminders.columns.next'), className: 'whitespace-nowrap tabular', cell: (r) => (r.status === 'ACTIVE' && r.nextReminderOn ? formatDate(r.nextReminderOn) : null) },
      { id: 'status', header: t('ops.common.status'), sortField: 'status', mobile: 'badge', cell: (r) => <OpsStatusBadge kind="reminder" status={r.status} /> },
      { id: 'offsets', header: t('ops.reminders.columns.offsets'), mobile: 'hidden', cell: (r) => <span className="tabular text-sm text-muted-foreground">{r.offsetsDays.map((d) => formatNumber(d)).join(' · ')}</span> },
    ],
    [t, tn, pick, formatDate, formatNumber],
  );

  const filters = React.useMemo<DataTableFilter[]>(
    () => [
      { id: 'withinDays', type: 'select', label: t('ops.reminders.filters.within'), options: WINDOWS.map((d) => ({ value: String(d), label: t('ops.reminders.filters.withinDays', { days: formatNumber(d) }) })) },
      { id: 'status', type: 'select', label: t('ops.common.status'), options: ['ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED'].map((s) => ({ value: s, label: t(`ops.status.reminder.${s}`) })) },
      { id: 'documentTypeKey', type: 'select', label: t('ops.reminders.columns.type'), options: (types.data ?? []).filter((d) => d.hasExpiry).map((d) => ({ value: d.key, label: pick(d.name, d.nameAr) })) },
    ],
    [t, pick, formatNumber, types.data],
  );

  const addButton = (
    <PermissionGate permission="reminder.manage">
      <Button variant="accent" onClick={() => setEditing('new')}>
        <BellPlus aria-hidden="true" />
        {t('ops.reminders.add')}
      </Button>
    </PermissionGate>
  );

  return (
    <>
      <PageHeader title={t('ops.reminders.title')} description={t('ops.reminders.description')} action={addButton} />

      <section aria-label={t('ops.reminders.upcoming')} className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {WINDOWS.map((days) => (
          <UpcomingTile
            key={days}
            days={days}
            scope={scope}
            onSelect={() => {
              // The table keeps its filters in the URL: set the window there and let the table read it again.
              const url = new URL(window.location.href);
              url.searchParams.set('withinDays', String(days));
              url.searchParams.delete('page');
              window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`);
              setTableKey((k) => k + 1);
            }}
          />
        ))}
      </section>

      {session.hasAnyPermission(['reminder.read', 'reminder.manage']) ? <RenewalAutopilotCard /> : null}

      {session.hasAnyPermission(['customer.read', 'corporate.read']) ? (
        <Card className="mb-4 grid gap-4 p-4 sm:grid-cols-2 lg:max-w-3xl">
          {session.hasPermission('customer.read') ? (
            <Field label={t('ops.reminders.filters.customer')}>
              {(p) => (
                <CustomerPicker
                  {...p}
                  value={customerId}
                  selectedLabel={customerLabel ?? linked.data?.fullName ?? null}
                  onChange={(id, customer) => {
                    setCustomerId(id);
                    setCustomerLabel(customer?.fullName ?? null);
                  }}
                />
              )}
            </Field>
          ) : null}
          {session.hasPermission('corporate.read') ? (
            <Field label={t('ops.reminders.filters.company')}>
              {(p) => <CorporateAccountPicker {...p} value={corporateId} onChange={(id) => setCorporateId(id)} />}
            </Field>
          ) : null}
        </Card>
      ) : null}

      <DataTable<Reminder>
        key={tableKey}
        caption={t('ops.reminders.title')}
        queryKey={opsKeys.reminders.all}
        queryFn={(params, signal) => api.client.get<Page<Reminder>>('/reminders', { query: params, signal })}
        fixedParams={scope}
        columns={columns}
        rowKey={(r) => r.id}
        rowActions={[{ id: 'view', label: t('ops.reminders.view'), icon: <Eye aria-hidden="true" />, onSelect: (r) => setSelected(r.id) }]}
        filters={filters}
        searchPlaceholder={t('ops.reminders.searchPlaceholder')}
        defaultSort="expiryDate:asc"
        empty={{ icon: <BellRing />, title: t('ops.reminders.emptyTitle'), description: t('ops.reminders.emptyText'), action: addButton }}
      />
      <p className="mt-3 text-sm text-muted-foreground">
        {t('ops.reminders.wordingNote')}{' '}
        {session.hasPermission('notification.manage') ? (
          <Link href="/notification-settings?tab=templates&event=document.expiry" className="text-secondary-text hover:underline">
            {t('ops.reminders.editTemplate')}
          </Link>
        ) : null}
      </p>

      <ReminderSheet id={selected} onClose={() => setSelected(null)} onEdit={(r) => setEditing(r)} />
      <ReminderDialog target={editing} onClose={() => setEditing(null)} defaultCustomerId={customerId || undefined} defaultCustomerLabel={customerLabel ?? linked.data?.fullName} />
    </>
  );
}

/** How many tracked documents expire within N days (from the list endpoint's total). */
function UpcomingTile({ days, scope, onSelect }: { days: number; scope: { customerId?: string; corporateAccountId?: string }; onSelect: () => void }) {
  const { t, formatNumber } = useI18n();
  const api = useApi();
  const count = useQuery({
    queryKey: opsKeys.reminders.upcoming(days, scope),
    queryFn: () => api.client.get<Page<Reminder>>('/reminders', { query: { ...scope, withinDays: days, pageSize: 1 } }),
    select: (page) => page.meta.total,
  });
  return (
    <button type="button" onClick={onSelect} className={cn('rounded-lg text-start transition-shadow hover:shadow-sm', focusRing)}>
      <StatCard
        label={t('ops.reminders.withinTile', { days: formatNumber(days) })}
        value={count.data === undefined ? '–' : formatNumber(count.data)}
        icon={<CalendarClock />}
        tone={days <= 7 && (count.data ?? 0) > 0 ? 'danger' : days <= 30 ? 'warning' : 'info'}
        loading={count.isPending}
      />
    </button>
  );
}

