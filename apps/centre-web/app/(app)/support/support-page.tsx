'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, LifeBuoy, MessageSquarePlus, Star } from 'lucide-react';
import type { Page } from '@typease/types';
import { slaPoliciesSchema, staffOpenTicketSchema, supportSettingsSchema } from '@typease/validation';
import {
  Badge, Button, Card, Combobox, ChoiceLabel, DataTable, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormActions, FormError,
  FormField, Input, PageHeader, PermissionGate, RequirePermission, STATUS_META, Select, Skeleton, StatCard, StatusBadge, Switch, Tabs, TabsContent, TabsList, TabsTrigger, Textarea, useApi,
  useI18n, useSession, useToast, useZodForm, type DataTableColumn, type DataTableFilter,
} from '@typease/ui';
import { CustomerPicker, StaffPicker } from '@/components/pickers';
import { Loadable, Panel, useDuration, useUrlParam, useUrlState } from '@/components/ops/common';
import type { FeedbackRow, FeedbackSummary, SlaPolicy, Ticket, TicketPriority, TicketStatus } from '@/components/ops/types';
import { opsKeys } from '@/lib/keys/ops';

const STATUSES: TicketStatus[] = ['OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED'];
const PRIORITIES: TicketPriority[] = ['URGENT', 'HIGH', 'NORMAL', 'LOW'];

export function SupportPage() {
  return (
    <RequirePermission anyOf={['ticket.read', 'ticket.manage']}>
      <Support />
    </RequirePermission>
  );
}

/** Customer tickets, the feedback customers gave, and the response-time targets (SLA). */
function Support() {
  const { t } = useI18n();
  const session = useSession();
  const [tab, setTab] = useUrlState('tab', 'tickets');
  const [creating, setCreating] = React.useState(false);
  const active = ['tickets', 'feedback', 'sla'].includes(tab) ? tab : 'tickets';
  const customerId = useUrlParam('customerId');

  const newTicket = (
    <PermissionGate permission="ticket.manage">
      <Button variant="accent" onClick={() => setCreating(true)}>
        <MessageSquarePlus aria-hidden="true" />
        {t('ops.support.new')}
      </Button>
    </PermissionGate>
  );

  return (
    <>
      <PageHeader
        title={t('ops.support.title')}
        description={t('ops.support.description')}
        action={newTicket}
        secondary={
          session.hasAnyPermission(['settings.manage', 'ticket.manage']) ? (
            <Button asChild variant="outline">
              <Link href="/support/platform">
                <LifeBuoy aria-hidden="true" />
                {t('ops.support.platform.link')}
              </Link>
            </Button>
          ) : undefined
        }
      />
      <Tabs value={active} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="tickets">{t('ops.support.tabs.tickets')}</TabsTrigger>
          <TabsTrigger value="feedback">{t('ops.support.tabs.feedback')}</TabsTrigger>
          <TabsTrigger value="sla">{t('ops.support.tabs.sla')}</TabsTrigger>
        </TabsList>
        <TabsContent value="tickets">
          <TicketsTable newTicket={newTicket} customerId={customerId} />
        </TabsContent>
        <TabsContent value="feedback">
          <Feedback />
        </TabsContent>
        <TabsContent value="sla">
          <SlaSettings />
        </TabsContent>
      </Tabs>
      <NewTicketDialog open={creating} onOpenChange={setCreating} customerId={customerId} />
    </>
  );
}

/** Late first response / late resolution, as words. */
export function SlaFlags({ ticket }: { ticket: Pick<Ticket, 'firstResponseBreached' | 'resolutionBreached'> }) {
  const { t } = useI18n();
  if (!ticket.firstResponseBreached && !ticket.resolutionBreached) return null;
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {ticket.firstResponseBreached ? <Badge tone="danger">{t('ops.support.sla.firstLate')}</Badge> : null}
      {ticket.resolutionBreached ? <Badge tone="danger">{t('ops.support.sla.resolutionLate')}</Badge> : null}
    </span>
  );
}

function TicketsTable({ newTicket, customerId }: { newTicket: React.ReactNode; customerId?: string }) {
  const { t, pick, formatRelative, formatDateTime } = useI18n();
  const api = useApi();
  const yes = [{ value: 'true', label: t('common.yes') }];

  const columns = React.useMemo<Array<DataTableColumn<Ticket>>>(
    () => [
      { id: 'number', header: t('ops.support.columns.ticket'), mobile: 'title', className: 'whitespace-nowrap', cell: (r) => <span className="tabular">{r.ticketNo}</span> },
      {
        id: 'subject',
        header: t('ops.support.columns.subject'),
        cell: (r) => (
          <>
            <span className="block max-w-80 truncate font-medium text-foreground" title={r.subject} dir="auto">
              {r.subject}
            </span>
            <span className="block text-sm text-muted-foreground">{[r.customerName, r.category].filter(Boolean).join(' · ')}</span>
          </>
        ),
      },
      { id: 'status', header: t('ops.common.status'), sortField: 'status', mobile: 'badge', cell: (r) => <StatusBadge kind="ticket" status={r.status} /> },
      { id: 'priority', header: t('ops.support.columns.priority'), sortField: 'priority', cell: (r) => <StatusBadge kind="priority" status={r.priority} className={r.priority === 'HIGH' || r.priority === 'URGENT' ? undefined : 'bg-transparent px-0'} /> },
      { id: 'assignee', header: t('ops.support.columns.assignee'), className: 'whitespace-nowrap', cell: (r) => r.assigneeName ?? <span className="text-muted-foreground">{t('ops.support.unassigned')}</span> },
      { id: 'sla', header: t('ops.support.columns.sla'), cell: (r) => (r.firstResponseBreached || r.resolutionBreached ? <SlaFlags ticket={r} /> : null) },
      { id: 'updated', header: t('ops.support.columns.updated'), sortField: 'updatedAt', className: 'whitespace-nowrap', cell: (r) => <span title={formatDateTime(r.updatedAt)}>{formatRelative(r.updatedAt)}</span> },
    ],
    [t, formatRelative, formatDateTime],
  );
  const filters = React.useMemo<DataTableFilter[]>(
    () => [
      { id: 'status', type: 'select', label: t('ops.common.status'), options: STATUSES.map((s) => ({ value: s, label: pick(STATUS_META.ticket[s].en, STATUS_META.ticket[s].ar) })) },
      { id: 'priority', type: 'select', label: t('ops.support.columns.priority'), options: PRIORITIES.map((p) => ({ value: p, label: pick(STATUS_META.priority[p].en, STATUS_META.priority[p].ar) })) },
      { id: 'open', type: 'select', label: t('ops.support.filters.open'), options: yes },
      { id: 'breached', type: 'select', label: t('ops.support.filters.breached'), options: yes },
      { id: 'unassigned', type: 'select', label: t('ops.support.filters.unassigned'), options: yes },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, pick],
  );

  return (
    <DataTable<Ticket>
      caption={t('ops.support.tabs.tickets')}
      queryKey={opsKeys.tickets.all}
      queryFn={(params, signal) => api.client.get<Page<Ticket>>('/support/tickets', { query: params, signal })}
      fixedParams={{ customerId }}
      columns={columns}
      rowKey={(r) => r.id}
      rowHref={(r) => `/support/${r.id}`}
      rowActions={[{ id: 'open', label: t('common.open'), icon: <ExternalLink aria-hidden="true" />, href: (r) => `/support/${r.id}` }]}
      filters={filters}
      searchPlaceholder={t('ops.support.searchPlaceholder')}
      defaultSort="updatedAt:desc"
      empty={{ icon: <LifeBuoy />, title: t('ops.support.emptyTitle'), description: t('ops.support.emptyText'), action: newTicket }}
    />
  );
}

/** What the request search of the new-ticket dialog needs from GET /requests. */
interface RequestOption {
  id: string;
  requestNo: string;
  serviceName?: string | null;
  service?: { name: string; nameAr: string | null } | null;
  statusLabel?: { en: string; ar: string } | null;
}

/** Staff open a ticket for a customer (a phone call, something said at the counter). */
function NewTicketDialog({ open, onOpenChange, customerId }: { open: boolean; onOpenChange: (open: boolean) => void; customerId?: string }) {
  const { t, pick } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const router = useRouter();
  const queryClient = useQueryClient();
  const form = useZodForm(staffOpenTicketSchema);
  const [requestLabel, setRequestLabel] = React.useState<string | null>(null);
  const chosenCustomer = form.watch('customerId');
  React.useEffect(() => {
    if (open) {
      form.reset({ customerId: customerId ?? '', requestId: '', subject: '', message: '', category: '', priority: 'NORMAL', assigneeId: '', attachments: [] });
      setRequestLabel(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            const ticket = await api.client.post<Ticket>('/support/tickets', values);
            toasts.success(t('ops.support.created'), t('ops.support.createdText', { number: ticket.ticketNo }));
            await queryClient.invalidateQueries({ queryKey: opsKeys.tickets.all });
            onOpenChange(false);
            router.push(`/support/${ticket.id}`);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('ops.support.new')}</DialogTitle>
            <DialogDescription>{t('ops.support.newText')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="customerId" label={t('ops.common.customer')} required>
              {(field) => (
                <CustomerPicker
                  {...field}
                  value={field.value}
                  onChange={(value) => {
                    field.onChange(value);
                    // A ticket can only be about one of the customer's own requests.
                    form.setValue('requestId', '');
                    setRequestLabel(null);
                  }}
                />
              )}
            </FormField>
            <FormField name="requestId" label={t('ops.support.fields.request')} optional hint={t(chosenCustomer ? 'ops.support.fields.requestHint' : 'ops.support.fields.requestNeedsCustomer')}>
              {(field) => (
                <Combobox
                  {...field}
                  // The list is read again for another customer.
                  key={chosenCustomer || 'none'}
                  value={field.value}
                  disabled={!chosenCustomer}
                  clearable
                  placeholder={t('ops.support.fields.requestPlaceholder')}
                  searchPlaceholder={t('ops.support.fields.requestSearch')}
                  emptyText={t('ops.support.fields.requestEmpty')}
                  selectedLabel={requestLabel}
                  loadOptions={async (q, signal) => {
                    const page = await api.client.get<Page<RequestOption>>('/requests', { query: { q: q || undefined, customerId: chosenCustomer, page: 1, pageSize: 10 }, signal });
                    return page.data.map((r) => ({ value: r.id, label: `${r.requestNo} · ${pick(r.service?.name ?? r.serviceName ?? '', r.service?.nameAr)}`, description: pick(r.statusLabel?.en ?? '', r.statusLabel?.ar) }));
                  }}
                  onValueChange={(value, option) => {
                    field.onChange(value);
                    setRequestLabel(option?.label ?? null);
                  }}
                />
              )}
            </FormField>
            <FormField name="subject" label={t('ops.support.fields.subject')} required>
              {(field) => <Input {...field} dir="auto" autoComplete="off" />}
            </FormField>
            <FormField name="message" label={t('ops.support.fields.message')} required hint={t('ops.support.fields.messageHint')}>
              {(field) => <Textarea {...field} rows={4} dir="auto" />}
            </FormField>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
              <FormField name="category" label={t('ops.support.fields.category')} optional>
                {(field) => <Input {...field} dir="auto" autoComplete="off" placeholder={t('ops.support.fields.categoryPlaceholder')} />}
              </FormField>
              <FormField name="priority" label={t('ops.support.columns.priority')}>
                {(field) => <Select {...field} onValueChange={field.onChange} options={PRIORITIES.map((p) => ({ value: p, label: pick(STATUS_META.priority[p].en, STATUS_META.priority[p].ar) }))} />}
              </FormField>
              <FormField name="assigneeId" label={t('ops.support.columns.assignee')} optional>
                {(field) => <StaffPicker {...field} value={field.value} onChange={(value) => field.onChange(value)} />}
              </FormField>
            </div>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('ops.support.open')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

export function Stars({ rating }: { rating: number }) {
  const { t } = useI18n();
  return (
    <span className="inline-flex items-center gap-0.5" role="img" aria-label={t('ops.support.feedback.stars', { rating })}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} aria-hidden="true" className={n <= rating ? 'size-4 fill-warning text-warning' : 'size-4 text-border'} />
      ))}
    </span>
  );
}

function Feedback() {
  const { t, formatNumber, formatDate } = useI18n();
  const api = useApi();
  const summary = useQuery({ queryKey: opsKeys.feedback.summary, queryFn: () => api.client.get<FeedbackSummary>('/support/feedback/summary') });

  const columns = React.useMemo<Array<DataTableColumn<FeedbackRow>>>(
    () => [
      { id: 'rating', header: t('ops.support.feedback.rating'), sortField: 'rating', mobile: 'badge', className: 'whitespace-nowrap', cell: (r) => <Stars rating={r.rating} /> },
      { id: 'customer', header: t('ops.common.customer'), mobile: 'title', cell: (r) => r.customerName },
      { id: 'comment', header: t('ops.support.feedback.comment'), cell: (r) => (r.comment ? <span dir="auto">{r.comment}</span> : null) },
      {
        id: 'about',
        header: t('ops.support.feedback.about'),
        className: 'whitespace-nowrap',
        cell: (r) =>
          r.ticketId ? (
            <Link href={`/support/${r.ticketId}`} className="text-secondary-text hover:underline">
              {t('ops.support.feedback.ticket', { number: r.ticketNo ?? '' })}
            </Link>
          ) : r.requestId ? (
            <Link href={`/requests/${r.requestId}`} className="text-secondary-text hover:underline">
              {t('ops.support.feedback.request', { number: r.requestNo ?? '' })}
            </Link>
          ) : null,
      },
      { id: 'date', header: t('ops.common.date'), sortField: 'createdAt', className: 'whitespace-nowrap tabular', cell: (r) => formatDate(r.createdAt) },
    ],
    [t, formatDate],
  );
  const filters = React.useMemo<DataTableFilter[]>(
    () => [
      { id: 'kind', type: 'select', label: t('ops.support.feedback.about'), options: [{ value: 'TICKET', label: t('ops.support.feedback.kindTicket') }, { value: 'REQUEST', label: t('ops.support.feedback.kindRequest') }] },
      { id: 'maxRating', type: 'select', label: t('ops.support.feedback.rating'), options: [1, 2, 3, 4].map((n) => ({ value: String(n), label: t('ops.support.feedback.maxRating', { rating: formatNumber(n) }) })) },
    ],
    [t, formatNumber],
  );

  return (
    <div className="space-y-4">
      <Loadable query={summary} skeleton={<Skeleton className="h-28 w-full" />}>
        {(s) => {
          const months = s.months.filter((m) => m.count > 0);
          return (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
              <StatCard label={t('ops.support.feedback.average')} value={s.overall.average === null ? '–' : formatNumber(s.overall.average, { maximumFractionDigits: 2 })} icon={<Star />} tone="warning" hint={t('ops.support.feedback.count', { count: formatNumber(s.overall.count) })} />
              <Card className="p-4">
                <h2 className="text-sm font-medium text-muted-foreground">{t('ops.support.feedback.byMonth')}</h2>
                {months.length === 0 ? (
                  <p className="mt-2 text-sm text-muted-foreground">{t('ops.support.feedback.noMonths')}</p>
                ) : (
                  <ul className="mt-2 space-y-1.5">
                    {months.map((m) => (
                      <li key={m.month} className="grid grid-cols-[6.5rem_minmax(0,1fr)_auto] items-center gap-3 text-sm">
                        <span className="text-muted-foreground">{formatDate(`${m.month}-01`).replace(/^\d+\s/, '')}</span>
                        <span className="h-2.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                          <span className="block h-full rounded-full bg-warning" style={{ width: `${Math.round(((m.average ?? 0) / 5) * 100)}%` }} />
                        </span>
                        <span className="tabular whitespace-nowrap">{t('ops.support.feedback.monthLine', { average: formatNumber(m.average, { maximumFractionDigits: 1 }), count: formatNumber(m.count) })}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          );
        }}
      </Loadable>
      <DataTable<FeedbackRow>
        caption={t('ops.support.tabs.feedback')}
        queryKey={opsKeys.feedback.all}
        queryFn={(params, signal) => api.client.get<Page<FeedbackRow>>('/support/feedback', { query: params, signal })}
        columns={columns}
        rowKey={(r) => r.id}
        filters={filters}
        searchPlaceholder={t('ops.support.feedback.search')}
        defaultSort="createdAt:desc"
        empty={{ icon: <Star />, title: t('ops.support.feedback.emptyTitle'), description: t('ops.support.feedback.emptyText') }}
      />
    </div>
  );
}

function SlaSettings() {
  const { t } = useI18n();
  const api = useApi();
  const session = useSession();
  const editable = session.hasPermission('ticket.manage');
  const policies = useQuery({ queryKey: opsKeys.tickets.sla, queryFn: () => api.client.get<SlaPolicy[]>('/support/sla-policies') });
  const settings = useQuery({ queryKey: opsKeys.tickets.settings, queryFn: () => api.client.get<{ reopenWindowDays: number }>('/support/settings') });
  return (
    <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <Panel title={t('ops.support.sla.title')} description={t('ops.support.sla.text')}>
        <Loadable query={policies} skeleton={<Skeleton className="h-64 w-full" />}>
          {(data) => <SlaForm policies={data} editable={editable} />}
        </Loadable>
      </Panel>
      <Panel title={t('ops.support.reopen.title')} description={t('ops.support.reopen.text')}>
        <Loadable query={settings} skeleton={<Skeleton className="h-24 w-full" />}>
          {(data) => <ReopenForm days={data.reopenWindowDays} editable={editable} />}
        </Loadable>
      </Panel>
    </div>
  );
}

function SlaForm({ policies, editable }: { policies: SlaPolicy[]; editable: boolean }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const duration = useDuration();
  const queryClient = useQueryClient();
  const ordered = PRIORITIES.map((p) => policies.find((x) => x.priority === p)).filter((p): p is SlaPolicy => !!p);
  const toValues = () => ({ policies: ordered.map(({ priority, firstResponseMinutes, resolutionMinutes, isActive }) => ({ priority, firstResponseMinutes, resolutionMinutes, isActive })) });
  const form = useZodForm(slaPoliciesSchema, { defaultValues: toValues(), disabled: !editable });
  React.useEffect(() => {
    form.reset(toValues());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policies]);
  const values = form.watch('policies');
  const number = (onChange: (v: unknown) => void) => (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value === '' ? '' : Number(e.target.value));
  return (
    <Form
      form={form}
      onSubmit={async (input) => {
        await api.client.put('/support/sla-policies', input);
        toasts.success(t('ops.support.sla.saved'), t('ops.support.sla.savedText'));
        await queryClient.invalidateQueries({ queryKey: opsKeys.tickets.sla });
      }}
    >
      <ul className="divide-y rounded-md border">
        {ordered.map((policy, i) => (
          <li key={policy.priority} className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-[9rem_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-start">
            <div className="pt-1">
              <StatusBadge kind="priority" status={policy.priority} />
            </div>
            <FormField name={`policies.${i}.firstResponseMinutes`} label={t('ops.support.sla.firstResponse')} hint={duration(Number(values?.[i]?.firstResponseMinutes ?? 0) * 60)}>
              {(field) => <Input {...field} type="number" min={1} inputMode="numeric" dir="ltr" className="tabular" onChange={number(field.onChange)} />}
            </FormField>
            <FormField name={`policies.${i}.resolutionMinutes`} label={t('ops.support.sla.resolution')} hint={duration(Number(values?.[i]?.resolutionMinutes ?? 0) * 60)}>
              {(field) => <Input {...field} type="number" min={1} inputMode="numeric" dir="ltr" className="tabular" onChange={number(field.onChange)} />}
            </FormField>
            <FormField name={`policies.${i}.isActive`} label={t('ops.support.sla.active')} hideLabel className="sm:pt-7">
              {(field) => <ChoiceLabel htmlFor={field.id} control={<Switch id={field.id} checked={field.value === true} onCheckedChange={field.onChange} disabled={field.disabled} />} label={t('ops.support.sla.active')} />}
            </FormField>
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted-foreground">{t('ops.support.sla.note')}</p>
      <FormError />
      {editable ? (
        <FormActions>
          <Button type="submit" disabled={!form.formState.isDirty} loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
            {t('common.saveChanges')}
          </Button>
        </FormActions>
      ) : null}
    </Form>
  );
}

function ReopenForm({ days, editable }: { days: number; editable: boolean }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const form = useZodForm(supportSettingsSchema, { defaultValues: { reopenWindowDays: days }, disabled: !editable });
  React.useEffect(() => {
    form.reset({ reopenWindowDays: days });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);
  return (
    <Form
      form={form}
      onSubmit={async (input) => {
        await api.client.put('/support/settings', input);
        toasts.success(t('ops.support.reopen.saved'));
        await queryClient.invalidateQueries({ queryKey: opsKeys.tickets.settings });
      }}
    >
      <FormField name="reopenWindowDays" label={t('ops.support.reopen.days')} hint={t('ops.support.reopen.daysHint')}>
        {(field) => <Input {...field} type="number" min={0} max={90} inputMode="numeric" dir="ltr" className="tabular max-w-32" onChange={(e) => field.onChange(e.target.value === '' ? '' : Number(e.target.value))} />}
      </FormField>
      <FormError />
      {editable ? (
        <FormActions>
          <Button type="submit" disabled={!form.formState.isDirty} loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
            {t('common.save')}
          </Button>
        </FormActions>
      ) : null}
    </Form>
  );
}

