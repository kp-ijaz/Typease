'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { BellRing, CalendarDays, ClipboardList, CreditCard, History, LifeBuoy, MessageSquareText, Plus, Receipt } from 'lucide-react';
import type { Page } from '@typease/types';
import type { RequestListItem } from '@typease/api-client';
import {
  Badge, Button, Card, DataTable, EmptyState, Pagination, PermissionGate, Skeleton, StatusBadge, Timeline, useApi, useI18n, useSession, type DataTableColumn, type DataTableFilter, type Tone,
} from '@typease/ui';
import { peopleKeys } from '@/lib/keys/people';
import { LoadError, Ltr, RecordLink } from '../shared';
import type { ActivityEntry, AppointmentRow, CustomerOverview, InvoiceRow, NotificationRow, PaymentRow, ReminderRow, TicketRow } from '../types';

/** Heading row above a tab's table: one sentence and the action that belongs to the tab. */
function TabIntro({ text, children }: { text: string; children?: React.ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <p className="max-w-2xl text-base text-muted-foreground">{text}</p>
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  );
}

const TABLE = { syncUrl: false, searchable: false, defaultPageSize: 10 } as const;

// ---------------------------------------------------------------- requests

export function CustomerRequestsTab({ customer }: { customer: CustomerOverview }) {
  const { t, pick, formatDate } = useI18n();
  const api = useApi();
  const columns = React.useMemo<Array<DataTableColumn<RequestListItem>>>(
    () => [
      { id: 'number', header: t('requests.columns.number'), mobile: 'title', className: 'whitespace-nowrap', cell: (r) => <span className="tabular">{r.requestNo}</span> },
      { id: 'service', header: t('requests.columns.service'), cell: (r) => pick(r.service.name, r.service.nameAr) },
      {
        id: 'status',
        header: t('requests.columns.status'),
        mobile: 'badge',
        cell: (r) => (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <StatusBadge kind="request" status={r.status} label={r.statusLabel} />
            {r.overdue ? <Badge tone="danger">{t('requests.overdue')}</Badge> : null}
          </span>
        ),
      },
      { id: 'payment', header: t('people.customer.tabs.requestsPayment'), cell: (r) => <StatusBadge kind="requestPayment" status={r.paymentStatus} className="bg-transparent px-0" /> },
      { id: 'submitted', header: t('requests.columns.submitted'), className: 'whitespace-nowrap tabular', cell: (r) => (r.submittedAt ? formatDate(r.submittedAt) : <span className="text-muted-foreground">{t('requests.notSubmitted')}</span>) },
      { id: 'target', header: t('requests.columns.target'), className: 'whitespace-nowrap tabular', cell: (r) => (r.targetDate ? formatDate(r.targetDate) : null) },
    ],
    [t, pick, formatDate],
  );
  const newRequest =
    customer.status === 'ACTIVE' ? (
      <PermissionGate permission="request.create">
        <Button asChild variant="outline">
          <Link href={`/requests/new?customerId=${customer.id}`}>
            <Plus aria-hidden="true" />
            {t('requests.new')}
          </Link>
        </Button>
      </PermissionGate>
    ) : null;
  return (
    <>
      <TabIntro text={t('people.customer.tabs.requestsText')}>{newRequest}</TabIntro>
      <DataTable<RequestListItem>
        {...TABLE}
        caption={t('people.customer.tabs.requests')}
        queryKey={peopleKeys.customers.tab(customer.id, 'requests')}
        queryFn={(params, signal) => api.requests.list(params, signal)}
        fixedParams={{ customerId: customer.id }}
        columns={columns}
        rowKey={(r) => r.id}
        rowHref={(r) => `/requests/${r.id}`}
        defaultSort="createdAt:desc"
        empty={{ icon: <ClipboardList />, title: t('people.customer.tabs.requestsEmpty'), description: t('people.customer.tabs.requestsEmptyText'), action: newRequest }}
      />
    </>
  );
}

// ---------------------------------------------------------------- invoices

/**
 * Finance treats a person's merged records as one customer: the `customerId` filter of /invoices and /payments
 * follows the merge history in both directions (finance.md, "Merged customers"). Issued invoices and completed
 * payments keep the id of the record they were issued to, so such rows say which number that was.
 */
function useIssuedTo(customer: CustomerOverview): (rowCustomerId: string | null | undefined) => React.ReactNode {
  const { t } = useI18n();
  return React.useCallback(
    (rowCustomerId) => {
      if (!rowCustomerId || rowCustomerId === customer.id) return null;
      const other = customer.mergedFrom.find((source) => source.id === rowCustomerId) ?? (customer.mergedInto?.id === rowCustomerId ? customer.mergedInto : null);
      return <span className="block text-sm font-normal text-muted-foreground">{other ? t('people.customer.tabs.issuedTo', { number: other.customerNo }) : t('people.customer.tabs.issuedToOther')}</span>;
    },
    [t, customer.id, customer.mergedFrom, customer.mergedInto],
  );
}
function MergedNote({ customer }: { customer: CustomerOverview }) {
  const { t } = useI18n();
  if (customer.mergedInto) return <p className="mb-4 max-w-3xl text-sm text-muted-foreground">{t('people.customer.tabs.retiredNote', { number: customer.mergedInto.customerNo })}</p>;
  if (customer.mergedFrom.length) return <p className="mb-4 max-w-3xl text-sm text-muted-foreground">{t('people.customer.tabs.mergedNote', { numbers: customer.mergedFrom.map((source) => source.customerNo).join(', ') })}</p>;
  return null;
}

export function CustomerInvoicesTab({ customer }: { customer: CustomerOverview }) {
  const { t, formatDate, formatMoney } = useI18n();
  const api = useApi();
  const issuedTo = useIssuedTo(customer);
  const columns = React.useMemo<Array<DataTableColumn<InvoiceRow>>>(
    () => [
      {
        id: 'number',
        header: t('people.customer.tabs.invoiceNo'),
        mobile: 'title',
        className: 'whitespace-nowrap',
        cell: (i) => (
          <>
            <span className="tabular">{i.invoiceNo}</span>
            {issuedTo(i.customerId)}
          </>
        ),
      },
      {
        id: 'status',
        header: t('requests.columns.status'),
        mobile: 'badge',
        cell: (i) => (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <StatusBadge kind="invoice" status={i.status} />
            {i.overdue ? <Badge tone="danger">{t('requests.overdue')}</Badge> : null}
          </span>
        ),
      },
      { id: 'request', header: t('people.customer.tabs.request'), className: 'whitespace-nowrap', cell: (i) => (i.request ? <RecordLink href={`/requests/${i.request.id}`} className="tabular relative z-10 font-normal">{i.request.requestNo}</RecordLink> : null) },
      { id: 'issued', header: t('people.customer.tabs.issued'), className: 'whitespace-nowrap tabular', cell: (i) => (i.issuedAt ? formatDate(i.issuedAt) : null) },
      { id: 'due', header: t('people.customer.tabs.due'), className: 'whitespace-nowrap tabular', cell: (i) => (i.dueAt ? formatDate(i.dueAt) : null) },
      { id: 'total', header: t('people.customer.tabs.total'), align: 'end', className: 'whitespace-nowrap tabular', cell: (i) => formatMoney(i.total, i.currency) },
      { id: 'balance', header: t('people.customer.tabs.balance'), align: 'end', className: 'whitespace-nowrap tabular', cell: (i) => (Number(i.balanceDue) === 0 ? null : <span className="font-medium text-foreground">{formatMoney(i.balanceDue, i.currency)}</span>) },
    ],
    [t, formatDate, formatMoney, issuedTo],
  );
  return (
    <>
      <TabIntro text={t('people.customer.tabs.invoicesText')}>
        {customer.status === 'ACTIVE' ? (
          <PermissionGate permission="invoice.manage">
            <Button asChild variant="outline">
              <Link href={`/invoices/new?customerId=${customer.id}`}>
                <Plus aria-hidden="true" />
                {t('people.customer.tabs.newInvoice')}
              </Link>
            </Button>
          </PermissionGate>
        ) : null}
      </TabIntro>
      <MergedNote customer={customer} />
      <DataTable<InvoiceRow>
        {...TABLE}
        caption={t('people.customer.tabs.invoices')}
        queryKey={peopleKeys.customers.tab(customer.id, 'invoices')}
        queryFn={(params, signal) => api.client.get<Page<InvoiceRow>>('/invoices', { query: params, signal })}
        fixedParams={{ customerId: customer.id }}
        columns={columns}
        rowKey={(i) => i.id}
        rowHref={(i) => `/invoices/${i.id}`}
        defaultSort="createdAt:desc"
        empty={{ icon: <Receipt />, title: t('people.customer.tabs.invoicesEmpty'), description: t('people.customer.tabs.invoicesEmptyText') }}
      />
    </>
  );
}

// ---------------------------------------------------------------- payments

export function CustomerPaymentsTab({ customer }: { customer: CustomerOverview }) {
  const { t, has, formatDate, formatMoney } = useI18n();
  const api = useApi();
  const issuedTo = useIssuedTo(customer);
  const columns = React.useMemo<Array<DataTableColumn<PaymentRow>>>(
    () => [
      {
        id: 'number',
        header: t('people.customer.tabs.paymentNo'),
        mobile: 'title',
        className: 'whitespace-nowrap',
        cell: (p) => (
          <>
            <span className="tabular">{p.paymentNo}</span>
            {issuedTo(p.customerId)}
          </>
        ),
      },
      { id: 'status', header: t('requests.columns.status'), mobile: 'badge', cell: (p) => <StatusBadge kind="payment" status={p.status} /> },
      { id: 'method', header: t('people.customer.tabs.method'), cell: (p) => (has(`people.paymentMethods.${p.method}`) ? t(`people.paymentMethods.${p.method}`) : p.method) },
      { id: 'receipt', header: t('people.customer.tabs.receipt'), className: 'whitespace-nowrap tabular', cell: (p) => p.receiptNo },
      { id: 'date', header: t('people.customer.tabs.received'), className: 'whitespace-nowrap tabular', cell: (p) => formatDate(p.receivedAt ?? p.createdAt) },
      { id: 'amount', header: t('people.customer.tabs.amount'), align: 'end', className: 'whitespace-nowrap tabular', cell: (p) => <span className="font-medium text-foreground">{formatMoney(p.amount, p.currency)}</span> },
    ],
    [t, has, formatDate, formatMoney, issuedTo],
  );
  return (
    <>
      <TabIntro text={t('people.customer.tabs.paymentsText')}>
        {customer.status === 'ACTIVE' ? (
          <PermissionGate permission="payment.record">
            <Button asChild variant="outline">
              <Link href={`/payments/new?customerId=${customer.id}`}>
                <Plus aria-hidden="true" />
                {t('people.customer.tabs.recordPayment')}
              </Link>
            </Button>
          </PermissionGate>
        ) : null}
      </TabIntro>
      <MergedNote customer={customer} />
      <DataTable<PaymentRow>
        {...TABLE}
        caption={t('people.customer.tabs.payments')}
        queryKey={peopleKeys.customers.tab(customer.id, 'payments')}
        queryFn={(params, signal) => api.client.get<Page<PaymentRow>>('/payments', { query: params, signal })}
        fixedParams={{ customerId: customer.id }}
        columns={columns}
        rowKey={(p) => p.id}
        rowHref={(p) => `/payments/${p.id}`}
        defaultSort="createdAt:desc"
        empty={{ icon: <CreditCard />, title: t('people.customer.tabs.paymentsEmpty'), description: t('people.customer.tabs.paymentsEmptyText') }}
      />
    </>
  );
}

// ---------------------------------------------------------------- appointments

export function CustomerAppointmentsTab({ customer }: { customer: CustomerOverview }) {
  const { t, formatDate, formatTime } = useI18n();
  const api = useApi();
  const columns = React.useMemo<Array<DataTableColumn<AppointmentRow>>>(
    () => [
      {
        id: 'when',
        header: t('people.customer.tabs.when'),
        mobile: 'title',
        className: 'whitespace-nowrap',
        cell: (a) => (
          <>
            <span className="tabular block font-medium text-foreground">{formatDate(a.startsAt)}</span>
            <span className="tabular block text-sm font-normal text-muted-foreground">{formatTime(a.startsAt)}</span>
          </>
        ),
      },
      { id: 'status', header: t('requests.columns.status'), mobile: 'badge', cell: (a) => <StatusBadge kind="appointment" status={a.status} /> },
      { id: 'service', header: t('requests.columns.service'), cell: (a) => a.serviceName },
      { id: 'branch', header: t('requests.filters.branch'), cell: (a) => a.branchName },
      { id: 'staff', header: t('people.customer.tabs.staff'), cell: (a) => a.staffName },
    ],
    [t, formatDate, formatTime],
  );
  const open = (
    <Button asChild variant="outline">
      <Link href={`/appointments?customerId=${customer.id}`}>
        <CalendarDays aria-hidden="true" />
        {t('people.customer.tabs.openAppointments')}
      </Link>
    </Button>
  );
  return (
    <>
      <TabIntro text={t('people.customer.tabs.appointmentsText')}>{open}</TabIntro>
      <DataTable<AppointmentRow>
        {...TABLE}
        caption={t('people.customer.tabs.appointments')}
        queryKey={peopleKeys.customers.tab(customer.id, 'appointments')}
        queryFn={(params, signal) => api.client.get<Page<AppointmentRow>>('/appointments', { query: params, signal })}
        fixedParams={{ customerId: customer.id }}
        columns={columns}
        rowKey={(a) => a.id}
        defaultSort="startsAt:desc"
        empty={{ icon: <CalendarDays />, title: t('people.customer.tabs.appointmentsEmpty'), description: t('people.customer.tabs.appointmentsEmptyText'), action: open }}
      />
    </>
  );
}

// ---------------------------------------------------------------- communications (notification delivery log)

const NOTIFICATION_TONE: Record<string, Tone> = { QUEUED: 'info', SENT: 'success', DELIVERED: 'success', FAILED: 'danger', SUPPRESSED: 'neutral' };
const CHANNELS = ['EMAIL', 'SMS', 'WHATSAPP', 'IN_APP', 'PUSH'] as const;

export function CustomerCommunicationsTab({ customer }: { customer: CustomerOverview }) {
  const { t, has, formatDateTime } = useI18n();
  const api = useApi();
  const columns = React.useMemo<Array<DataTableColumn<NotificationRow>>>(
    () => [
      {
        id: 'subject',
        header: t('people.customer.tabs.message'),
        mobile: 'title',
        cell: (n) => (
          <>
            <span className="block font-medium text-foreground" dir="auto">
              {n.subject || n.eventLabel || n.eventKey}
            </span>
            {n.subject && n.eventLabel && n.eventLabel !== n.subject ? <span className="block text-sm font-normal text-muted-foreground">{n.eventLabel}</span> : null}
          </>
        ),
      },
      {
        id: 'status',
        header: t('requests.columns.status'),
        mobile: 'badge',
        cell: (n) => <Badge tone={NOTIFICATION_TONE[n.status] ?? 'neutral'}>{has(`people.notificationStatus.${n.status}`) ? t(`people.notificationStatus.${n.status}`) : n.status}</Badge>,
      },
      { id: 'channel', header: t('people.customer.tabs.channel'), className: 'whitespace-nowrap', cell: (n) => (has(`people.channels.${n.channel}`) ? t(`people.channels.${n.channel}`) : n.channel) },
      { id: 'to', header: t('people.customer.tabs.sentTo'), cell: (n) => (n.recipientAddress ? <Ltr className="block max-w-56 truncate">{n.recipientAddress}</Ltr> : null) },
      { id: 'when', header: t('people.customer.tabs.when'), sortField: 'createdAt', className: 'whitespace-nowrap tabular', cell: (n) => formatDateTime(n.sentAt ?? n.createdAt) },
    ],
    [t, has, formatDateTime],
  );
  const filters = React.useMemo<DataTableFilter[]>(() => [{ id: 'channel', type: 'select', label: t('people.customer.tabs.channel'), options: CHANNELS.map((c) => ({ value: c, label: t(`people.channels.${c}`) })) }], [t]);
  return (
    <>
      <TabIntro text={t('people.customer.tabs.communicationsText')} />
      <DataTable<NotificationRow>
        {...TABLE}
        caption={t('people.customer.tabs.communications')}
        queryKey={peopleKeys.customers.tab(customer.id, 'communications')}
        queryFn={(params, signal) => api.client.get<Page<NotificationRow>>('/notifications', { query: params, signal })}
        fixedParams={{ customerId: customer.id }}
        columns={columns}
        filters={filters}
        rowKey={(n) => n.id}
        defaultSort="createdAt:desc"
        empty={{ icon: <MessageSquareText />, title: t('people.customer.tabs.communicationsEmpty'), description: t('people.customer.tabs.communicationsEmptyText') }}
      />
    </>
  );
}

// ---------------------------------------------------------------- expiry reminders

const REMINDER_TONE: Record<string, Tone> = { ACTIVE: 'success', PAUSED: 'warning', COMPLETED: 'neutral', CANCELLED: 'neutral' };

export function CustomerRemindersTab({ customer }: { customer: CustomerOverview }) {
  const { t, tn, has, pick, formatDate } = useI18n();
  const api = useApi();
  const columns = React.useMemo<Array<DataTableColumn<ReminderRow>>>(
    () => [
      { id: 'document', header: t('people.customer.tabs.document'), mobile: 'title', cell: (r) => <span className="font-medium text-foreground">{pick(r.documentTypeName, r.documentTypeNameAr)}</span> },
      { id: 'status', header: t('requests.columns.status'), mobile: 'badge', cell: (r) => <Badge tone={REMINDER_TONE[r.status] ?? 'neutral'}>{has(`people.reminderStatus.${r.status}`) ? t(`people.reminderStatus.${r.status}`) : r.status}</Badge> },
      { id: 'expiry', header: t('people.customer.tabs.expires'), sortField: 'expiryDate', className: 'whitespace-nowrap tabular', cell: (r) => formatDate(r.expiryDate) },
      {
        id: 'left',
        header: t('people.customer.tabs.timeLeft'),
        className: 'whitespace-nowrap',
        cell: (r) => (r.daysLeft < 0 ? <Badge tone="danger">{t('people.common.expired')}</Badge> : <span className={r.daysLeft <= 30 ? 'font-medium text-warning-text' : undefined}>{tn('people.common.daysLeft', r.daysLeft)}</span>),
      },
      { id: 'next', header: t('people.customer.tabs.nextReminder'), className: 'whitespace-nowrap tabular', cell: (r) => (r.nextReminderOn ? formatDate(r.nextReminderOn) : null) },
      { id: 'file', header: t('people.customer.tabs.file'), mobile: 'hidden', cell: (r) => (r.documentId ? <RecordLink href={`/documents/${r.documentId}`} className="font-normal">{t('people.customer.tabs.openDocument')}</RecordLink> : null) },
    ],
    [t, tn, has, pick, formatDate],
  );
  const open = (
    <Button asChild variant="outline">
      <Link href={`/reminders?customerId=${customer.id}`}>
        <BellRing aria-hidden="true" />
        {t('people.customer.tabs.openReminders')}
      </Link>
    </Button>
  );
  return (
    <>
      <TabIntro text={t('people.customer.tabs.remindersText')}>{open}</TabIntro>
      <DataTable<ReminderRow>
        {...TABLE}
        caption={t('people.customer.tabs.reminders')}
        queryKey={peopleKeys.customers.tab(customer.id, 'reminders')}
        queryFn={(params, signal) => api.client.get<Page<ReminderRow>>('/reminders', { query: params, signal })}
        fixedParams={{ customerId: customer.id, includeExpired: true }}
        columns={columns}
        rowKey={(r) => r.id}
        defaultSort="expiryDate:asc"
        empty={{ icon: <BellRing />, title: t('people.customer.tabs.remindersEmpty'), description: t('people.customer.tabs.remindersEmptyText') }}
      />
    </>
  );
}

// ---------------------------------------------------------------- support tickets

export function CustomerTicketsTab({ customer }: { customer: CustomerOverview }) {
  const { t, formatDate } = useI18n();
  const api = useApi();
  const columns = React.useMemo<Array<DataTableColumn<TicketRow>>>(
    () => [
      {
        id: 'subject',
        header: t('people.customer.tabs.ticket'),
        mobile: 'title',
        cell: (k) => (
          <>
            <span className="block" dir="auto">
              {k.subject}
            </span>
            <span className="tabular block text-sm font-normal text-muted-foreground">{k.ticketNo}</span>
          </>
        ),
      },
      {
        id: 'status',
        header: t('requests.columns.status'),
        mobile: 'badge',
        cell: (k) => (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <StatusBadge kind="ticket" status={k.status} />
            {k.resolutionBreached && !['RESOLVED', 'CLOSED'].includes(k.status) ? <Badge tone="danger">{t('requests.overdue')}</Badge> : null}
          </span>
        ),
      },
      { id: 'priority', header: t('requests.columns.priority'), cell: (k) => <StatusBadge kind="priority" status={k.priority} className={k.priority === 'HIGH' || k.priority === 'URGENT' ? undefined : 'bg-transparent px-0'} /> },
      { id: 'request', header: t('people.customer.tabs.request'), className: 'whitespace-nowrap', cell: (k) => (k.requestId && k.requestNo ? <RecordLink href={`/requests/${k.requestId}`} className="tabular relative z-10 font-normal">{k.requestNo}</RecordLink> : null) },
      { id: 'assignee', header: t('requests.columns.assignee'), cell: (k) => k.assigneeName },
      { id: 'created', header: t('people.customer.tabs.opened'), className: 'whitespace-nowrap tabular', cell: (k) => formatDate(k.createdAt) },
    ],
    [t, formatDate],
  );
  return (
    <>
      <TabIntro text={t('people.customer.tabs.ticketsText')} />
      <DataTable<TicketRow>
        {...TABLE}
        caption={t('people.customer.tabs.tickets')}
        queryKey={peopleKeys.customers.tab(customer.id, 'tickets')}
        queryFn={(params, signal) => api.client.get<Page<TicketRow>>('/support/tickets', { query: params, signal })}
        fixedParams={{ customerId: customer.id }}
        columns={columns}
        rowKey={(k) => k.id}
        rowHref={(k) => `/support/${k.id}`}
        defaultSort="createdAt:desc"
        empty={{ icon: <LifeBuoy />, title: t('people.customer.tabs.ticketsEmpty'), description: t('people.customer.tabs.ticketsEmptyText') }}
      />
    </>
  );
}

// ---------------------------------------------------------------- activity history

const ACTOR_TYPES = ['STAFF', 'CUSTOMER', 'CORPORATE', 'PLATFORM', 'SYSTEM', 'AUTOMATION'];

/** What happened to this record, newest first (GET /customers/:id/activity: the audit entries of the customer). */
export function CustomerActivityTab({ customer }: { customer: CustomerOverview }) {
  const { t, has, formatDateTime } = useI18n();
  const api = useApi();
  const session = useSession();
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(20);
  const activity = useQuery({
    queryKey: [...peopleKeys.customers.activity(customer.id), page, pageSize],
    queryFn: () => api.client.get<Page<ActivityEntry>>(`/customers/${customer.id}/activity`, { query: { page, pageSize } }),
  });

  const title = (entry: ActivityEntry) => {
    const key = `people.customer.activity.actions.${entry.action.replace(/^customer\./, '').replace(/\./g, '_')}`;
    if (has(key)) return t(key);
    return entry.summary ?? entry.action;
  };
  const actor = (entry: ActivityEntry) => {
    const type = ACTOR_TYPES.includes(entry.actorType) ? t(`people.actorTypes.${entry.actorType}`) : entry.actorType;
    return entry.actorLabel ? t('people.customer.activity.by', { name: entry.actorLabel, type }) : type;
  };

  return (
    <>
      <TabIntro text={t('people.customer.activity.text')}>
        {session.hasPermission('audit.read') ? (
          <Button asChild variant="outline">
            <Link href={`/audit-log?resourceType=Customer&resourceId=${customer.id}`}>
              <History aria-hidden="true" />
              {t('people.customer.activity.openAudit')}
            </Link>
          </Button>
        ) : null}
      </TabIntro>
      <Card>
        {activity.isPending ? (
          <div className="space-y-5 p-5" role="status" aria-label={t('common.loading')}>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex gap-3.5">
                <Skeleton className="size-6 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-64 max-w-full" />
                  <Skeleton className="h-3.5 w-40" />
                </div>
              </div>
            ))}
          </div>
        ) : activity.isError ? (
          <div className="p-4">
            <LoadError error={activity.error} onRetry={() => void activity.refetch()} />
          </div>
        ) : activity.data.data.length === 0 ? (
          <EmptyState icon={<History />} title={t('people.customer.activity.empty')} description={t('people.customer.activity.emptyText')} />
        ) : (
          <>
            <div className="p-5">
              <Timeline items={activity.data.data.map((entry) => ({ id: entry.id, title: title(entry), time: formatDateTime(entry.createdAt), description: <span className="text-muted-foreground">{actor(entry)}</span> }))} />
            </div>
            {activity.data.meta.total > activity.data.meta.pageSize || page > 1 ? (
              <div className="border-t px-4 py-3">
                <Pagination
                  meta={activity.data.meta}
                  onPageChange={setPage}
                  onPageSizeChange={(size) => {
                    setPageSize(size);
                    setPage(1);
                  }}
                />
              </div>
            ) : null}
          </>
        )}
      </Card>
    </>
  );
}
