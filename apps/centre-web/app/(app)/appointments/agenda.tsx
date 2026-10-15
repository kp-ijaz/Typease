'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, CalendarX2, ChevronLeft, ChevronRight, X } from 'lucide-react';
import type { Page } from '@typease/types';
import { cancelAppointmentSchema, rescheduleAppointmentSchema, updateAppointmentSchema } from '@typease/validation';
import {
  Alert, Badge, Button, Card, DatePicker, DescriptionList, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState, Form, FormActions,
  FormError, FormField, Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle, Skeleton, StatusBadge, Textarea, addDays, cn, focusRing, formatPhone, statusMeta,
  useApi, useI18n, useSession, useToast, useZodForm, type Tone,
} from '@typease/ui';
import { StaffPicker } from '@/components/pickers';
import { ListSkeleton, Loadable, useRun, useUrlState } from '@/components/ops/common';
import type { Appointment, AppointmentStatus } from '@/components/ops/types';
import { opsKeys } from '@/lib/keys/ops';
import { SlotPicker } from './slot-picker';

const EDGE: Record<Tone, string> = { info: 'border-s-info', warning: 'border-s-warning', success: 'border-s-success', danger: 'border-s-destructive', neutral: 'border-s-border' };
const OPEN: AppointmentStatus[] = ['BOOKED', 'CONFIRMED', 'CHECKED_IN', 'IN_SERVICE'];

const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
/** Monday of the week a date is in. */
const mondayOf = (date: string) => addDays(date, -((weekdayOf(date) + 6) % 7));

type Action = 'confirm' | 'check-in' | 'start' | 'complete' | 'no-show';

/** The next sensible step of an appointment, and everything else that is possible in its status. */
function actionsFor(a: Appointment, today: string): { primary: Action | null; others: Action[]; canCancel: boolean; canReschedule: boolean } {
  const isToday = a.localDate === today;
  const started = new Date(a.startsAt).getTime() <= Date.now();
  switch (a.status) {
    case 'BOOKED':
      return { primary: isToday ? 'check-in' : 'confirm', others: [...(isToday ? (['confirm'] as Action[]) : []), ...(started ? (['no-show'] as Action[]) : [])], canCancel: true, canReschedule: true };
    case 'CONFIRMED':
      return { primary: isToday ? 'check-in' : null, others: started ? ['no-show'] : [], canCancel: true, canReschedule: true };
    case 'CHECKED_IN':
      return { primary: 'start', others: ['no-show'], canCancel: true, canReschedule: false };
    case 'IN_SERVICE':
      return { primary: 'complete', others: [], canCancel: false, canReschedule: false };
    case 'NO_SHOW':
      return { primary: isToday ? 'check-in' : null, others: [], canCancel: false, canReschedule: false };
    default:
      return { primary: null, others: [], canCancel: false, canReschedule: false };
  }
}

function useAppointmentActions() {
  const { t } = useI18n();
  const api = useApi();
  const { run, busy } = useRun();
  const act = (a: Appointment, action: Action) =>
    run(`${action}-${a.id}`, () => api.client.post<Appointment>(`/appointments/${a.id}/${action}`, action === 'check-in' ? { issueToken: true } : undefined), {
      success: (result) => (action === 'check-in' && result.queueToken ? t('ops.appointments.done.checkInToken', { token: result.queueToken.tokenNo }) : t(`ops.appointments.done.${action}`)),
      description: (result) => (action === 'check-in' && result.queueToken ? t('ops.appointments.done.checkInTokenText') : undefined),
      invalidate: [opsKeys.appointments.all, opsKeys.queue.all],
    });
  return { act, busy };
}

export function Agenda({ branchId, customerId, onBook }: { branchId: string; customerId?: string; onBook: () => void }) {
  const { t, tn, today, formatDate } = useI18n();
  const api = useApi();
  const session = useSession();
  const canManage = session.hasPermission('appointment.manage');
  const todayDate = today();
  const [view, setView] = useUrlState('view', 'day');
  const [date, setDate] = useUrlState('date', todayDate);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [cancelling, setCancelling] = React.useState<Appointment | null>(null);
  const [rescheduling, setRescheduling] = React.useState<Appointment | null>(null);
  const [customerFilter, setCustomerFilter] = React.useState(true);
  const { act, busy } = useAppointmentActions();

  const byCustomer = customerFilter && customerId ? customerId : undefined;
  const week = view === 'week';
  const monday = mondayOf(date);
  const days = week ? Array.from({ length: 7 }, (_, i) => addDays(monday, i)) : [date];
  // A range is given in UTC days: one day more on both sides, then cut to the branch's own dates.
  const params = byCustomer ? { customerId: byCustomer, sort: 'startsAt:desc' } : week ? { branchId, from: addDays(monday, -1), to: addDays(monday, 7), sort: 'startsAt:asc' } : { branchId, date, sort: 'startsAt:asc' };

  const agenda = useQuery({
    queryKey: opsKeys.appointments.agenda(params),
    queryFn: async ({ signal }) => {
      const all: Appointment[] = [];
      for (let page = 1; page <= 5; page++) {
        const result = await api.client.get<Page<Appointment>>('/appointments', { query: { ...params, page, pageSize: 100 }, signal });
        all.push(...result.data);
        if (page >= result.meta.totalPages) break;
      }
      return all;
    },
    refetchInterval: 60_000,
  });
  const customer = useQuery({
    queryKey: ['customers', 'name', customerId],
    queryFn: () => api.client.get<{ id: string; fullName: string; customerNo: string }>(`/customers/${customerId}`),
    enabled: !!byCustomer && session.hasPermission('customer.read'),
    staleTime: 5 * 60_000,
  });

  const row = (a: Appointment, compact = false) => {
    const { primary } = actionsFor(a, todayDate);
    const tone = statusMeta('appointment', a.status).tone;
    const name = a.customerName ?? a.guestName ?? t('ops.common.guest');
    return (
      <li key={a.id} className={cn('flex flex-wrap items-center gap-x-4 gap-y-2 border-s-4 bg-card px-4 py-3', EDGE[tone], !OPEN.includes(a.status) && 'opacity-80', compact && 'rounded-md border px-3 py-2')}>
        <div className={cn('tabular shrink-0 font-semibold text-foreground', compact ? 'w-full text-sm' : 'w-28')}>
          <span dir="ltr">
            {a.localTime}–{a.localEndTime}
          </span>
          {byCustomer ? <span className="block text-sm font-normal text-muted-foreground">{formatDate(a.localDate)}</span> : null}
        </div>
        <button type="button" onClick={() => setSelected(a.id)} className={cn('min-w-0 flex-1 basis-40 rounded-sm text-start', focusRing)}>
          <span className="block truncate font-medium text-secondary-text hover:underline">{name}</span>
          <span className="block truncate text-sm text-muted-foreground">{[a.serviceName, compact ? null : a.staffName, byCustomer ? a.branchName : null].filter(Boolean).join(' · ') || t('ops.appointments.noService')}</span>
        </button>
        <span className="flex flex-wrap items-center gap-1.5">
          <StatusBadge kind="appointment" status={a.status} />
          {!a.customerId ? <Badge tone="outline">{t('ops.common.guest')}</Badge> : null}
          {a.customerNoShowCount > 0 && !compact ? <Badge tone="danger">{tn('ops.appointments.noShows', a.customerNoShowCount)}</Badge> : null}
        </span>
        {canManage && primary && !compact ? (
          <Button size="sm" variant={primary === 'confirm' ? 'outline' : 'default'} loading={busy === `${primary}-${a.id}`} onClick={() => void act(a, primary)}>
            {t(`ops.appointments.actions.${primary}`)}
          </Button>
        ) : null}
      </li>
    );
  };

  return (
    <div className="space-y-4">
      {byCustomer ? (
        <Alert
          tone="info"
          action={
            <Button size="sm" variant="outline" onClick={() => setCustomerFilter(false)}>
              <X aria-hidden="true" />
              {t('ops.appointments.customerFilterClear')}
            </Button>
          }
        >
          {t('ops.appointments.customerFilter', { name: customer.data ? `${customer.data.fullName} (${customer.data.customerNo})` : t('ops.appointments.thisCustomer') })}
        </Alert>
      ) : (
        <Card className="flex flex-wrap items-center gap-3 p-3 sm:p-4">
          <div role="group" aria-label={t('ops.appointments.view')} className="inline-flex rounded-md border bg-card p-0.5">
            {(['day', 'week'] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v || (v === 'day' && !week)}
                onClick={() => setView(v)}
                className={cn('rounded-sm px-3 py-1.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring', (v === 'week') === week ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground hover:text-foreground')}
              >
                {t(`ops.appointments.views.${v}`)}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="icon" onClick={() => setDate(addDays(date, week ? -7 : -1))} aria-label={t(week ? 'ops.appointments.previousWeek' : 'ops.appointments.previousDay')}>
              <ChevronLeft className="rtl-mirror" aria-hidden="true" />
            </Button>
            <Button variant="outline" onClick={() => setDate(todayDate)} disabled={week ? mondayOf(todayDate) === monday : date === todayDate}>
              {t('common.today')}
            </Button>
            <Button variant="outline" size="icon" onClick={() => setDate(addDays(date, week ? 7 : 1))} aria-label={t(week ? 'ops.appointments.nextWeek' : 'ops.appointments.nextDay')}>
              <ChevronRight className="rtl-mirror" aria-hidden="true" />
            </Button>
          </div>
          <DatePicker value={date} onChange={(v) => v && setDate(v)} aria-label={t('ops.common.date')} className="w-auto" />
          <p className="basis-full text-md font-semibold text-foreground sm:ms-auto sm:basis-auto">{week ? t('ops.appointments.weekOf', { from: formatDate(days[0]), to: formatDate(days[6]) }) : formatDate(date, 'long')}</p>
        </Card>
      )}

      <Loadable query={agenda} skeleton={<ListSkeleton rows={5} />}>
        {(all) => {
          const list = byCustomer ? all : all.filter((a) => days.includes(a.localDate));
          if (list.length === 0) {
            return (
              <Card>
                <EmptyState
                  icon={<CalendarX2 />}
                  title={t(byCustomer ? 'ops.appointments.emptyCustomerTitle' : week ? 'ops.appointments.emptyWeekTitle' : 'ops.appointments.emptyDayTitle')}
                  description={t('ops.appointments.emptyText')}
                  action={
                    canManage ? (
                      <Button variant="outline" onClick={onBook}>
                        {t('ops.appointments.book')}
                      </Button>
                    ) : undefined
                  }
                />
              </Card>
            );
          }
          if (week && !byCustomer) {
            return (
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-7">
                {days.map((day) => {
                  const items = list.filter((a) => a.localDate === day);
                  return (
                    <section key={day} aria-label={formatDate(day, 'long')} className={cn('min-w-0 rounded-lg border bg-muted/30', day === todayDate && 'border-secondary')}>
                      <button type="button" onClick={() => { setDate(day); setView('day'); }} className={cn('flex w-full items-baseline justify-between gap-2 rounded-t-lg border-b px-3 py-2 text-start hover:bg-muted', focusRing)}>
                        <span className="text-sm font-semibold">{t(`ops.appointments.weekdaysShort.${weekdayOf(day)}`)}</span>
                        <span className="tabular text-sm text-muted-foreground">{formatDate(day, 'short').slice(0, 5)}</span>
                      </button>
                      {items.length ? <ul className="space-y-1.5 p-1.5">{items.map((a) => row(a, true))}</ul> : <p className="px-3 py-4 text-center text-sm text-muted-foreground">–</p>}
                    </section>
                  );
                })}
              </div>
            );
          }
          return (
            <Card className="overflow-hidden">
              <p className="border-b px-4 py-2.5 text-sm text-muted-foreground">{tn('ops.appointments.count', list.length)}</p>
              <ul className="divide-y">{list.map((a) => row(a))}</ul>
            </Card>
          );
        }}
      </Loadable>

      <AppointmentSheet id={selected} onClose={() => setSelected(null)} onCancel={setCancelling} onReschedule={setRescheduling} />
      <CancelDialog appointment={cancelling} onClose={() => setCancelling(null)} />
      <RescheduleDialog appointment={rescheduling} onClose={() => setRescheduling(null)} />
    </div>
  );
}

/** Everything about one appointment, with every action its status allows. */
function AppointmentSheet({ id, onClose, onCancel, onReschedule }: { id: string | null; onClose: () => void; onCancel: (a: Appointment) => void; onReschedule: (a: Appointment) => void }) {
  const { t, tn, today, formatDate, formatDateTime } = useI18n();
  const api = useApi();
  const session = useSession();
  const canManage = session.hasPermission('appointment.manage');
  const { act, busy } = useAppointmentActions();
  const appointment = useQuery({ queryKey: [...opsKeys.appointments.all, 'detail', id], queryFn: () => api.client.get<Appointment>(`/appointments/${id}`), enabled: !!id });

  return (
    <Sheet open={!!id} onOpenChange={(open) => !open && onClose()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{t('ops.appointments.detailTitle')}</SheetTitle>
          <SheetDescription>{appointment.data ? `${formatDate(appointment.data.localDate, 'long')}` : t('common.loading')}</SheetDescription>
        </SheetHeader>
        <SheetBody className="space-y-6">
          {id ? (
            <Loadable query={appointment} skeleton={<Skeleton className="h-64 w-full" />}>
              {(a) => {
                const { primary, others, canCancel, canReschedule } = actionsFor(a, today());
                const closed = ['COMPLETED', 'CANCELLED', 'RESCHEDULED'].includes(a.status);
                return (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge kind="appointment" status={a.status} />
                      {!a.customerId ? <Badge tone="outline">{t('ops.common.guest')}</Badge> : null}
                      {a.customerNoShowCount > 0 ? <Badge tone="danger">{tn('ops.appointments.noShows', a.customerNoShowCount)}</Badge> : null}
                      {a.queueToken ? (
                        <Badge tone="brand">
                          {t('ops.appointments.token', { token: a.queueToken.tokenNo })}
                        </Badge>
                      ) : null}
                    </div>
                    <DescriptionList
                      columns={1}
                      items={[
                        { label: t('ops.appointments.fields.time'), value: <span dir="ltr" className="tabular">{`${a.localTime}–${a.localEndTime}`}</span> },
                        {
                          label: t('ops.appointments.fields.who'),
                          value: a.customerId ? (
                            <Link href={`/customers/${a.customerId}`} className={cn('rounded-sm text-secondary-text hover:underline', focusRing)}>
                              {a.customerName}
                            </Link>
                          ) : (
                            a.guestName
                          ),
                        },
                        { label: t('ops.appointments.fields.phone'), value: a.customerPhone || a.guestPhone ? <span className="ltr-value tabular">{formatPhone(a.customerPhone ?? a.guestPhone)}</span> : null },
                        { label: t('ops.appointments.fields.service'), value: a.serviceName },
                        { label: t('ops.common.branch'), value: a.branchName },
                        { label: t('ops.appointments.fields.checkedIn'), value: a.checkedInAt ? formatDateTime(a.checkedInAt) : null },
                        ...(a.cancelledReason ? [{ label: t('ops.appointments.fields.cancelReason'), value: a.cancelledReason }] : []),
                        ...(a.requestId ? [{ label: t('ops.appointments.fields.request'), value: <Link href={`/requests/${a.requestId}`} className="text-secondary-text hover:underline">{t('ops.appointments.openRequest')}</Link> }] : []),
                      ]}
                    />

                    {canManage && (primary || others.length || canCancel || canReschedule) ? (
                      <div className="flex flex-wrap gap-2">
                        {primary ? (
                          <Button loading={busy === `${primary}-${a.id}`} onClick={() => void act(a, primary)}>
                            {t(`ops.appointments.actions.${primary}`)}
                          </Button>
                        ) : null}
                        {others.map((action) => (
                          <Button key={action} variant="outline" loading={busy === `${action}-${a.id}`} onClick={() => void act(a, action)}>
                            {t(`ops.appointments.actions.${action}`)}
                          </Button>
                        ))}
                        {canReschedule ? (
                          <Button variant="outline" onClick={() => onReschedule(a)}>
                            <CalendarDays aria-hidden="true" />
                            {t('ops.appointments.actions.reschedule')}
                          </Button>
                        ) : null}
                        {canCancel ? (
                          <Button variant="destructive-outline" onClick={() => onCancel(a)}>
                            {t('ops.appointments.actions.cancel')}
                          </Button>
                        ) : null}
                      </div>
                    ) : null}

                    {canManage && !closed ? <NotesForm key={a.id} appointment={a} /> : a.notes ? <DescriptionList columns={1} items={[{ label: t('ops.appointments.fields.notes'), value: a.notes }, { label: t('ops.appointments.fields.staff'), value: a.staffName }]} /> : null}
                  </>
                );
              }}
            </Loadable>
          ) : null}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

function NotesForm({ appointment }: { appointment: Appointment }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const form = useZodForm(updateAppointmentSchema.pick({ notes: true, staffId: true }), { defaultValues: { notes: appointment.notes ?? '', staffId: appointment.staffId ?? '' }, emptyAs: 'null' });
  return (
    <Form
      form={form}
      onSubmit={async (values) => {
        await api.client.patch(`/appointments/${appointment.id}`, values);
        toasts.success(t('ops.appointments.saved'));
        await queryClient.invalidateQueries({ queryKey: opsKeys.appointments.all });
        form.reset(values as { notes: string; staffId: string });
      }}
    >
      <FormField name="staffId" label={t('ops.appointments.fields.staff')} optional>
        {(field) => <StaffPicker {...field} value={field.value} onChange={(id) => field.onChange(id)} branchId={appointment.branchId} selectedLabel={appointment.staffName} />}
      </FormField>
      <FormField name="notes" label={t('ops.appointments.fields.notes')} optional hint={t('ops.appointments.fields.notesHint')}>
        {(field) => <Textarea {...field} rows={3} dir="auto" />}
      </FormField>
      <FormError />
      <FormActions>
        <Button type="submit" variant="outline" disabled={!form.formState.isDirty} loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
          {t('common.save')}
        </Button>
      </FormActions>
    </Form>
  );
}

function CancelDialog({ appointment, onClose }: { appointment: Appointment | null; onClose: () => void }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const form = useZodForm(cancelAppointmentSchema, { defaultValues: { reason: '' } });
  React.useEffect(() => {
    if (appointment) form.reset({ reason: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appointment?.id]);
  return (
    <Dialog open={!!appointment} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="sm">
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            await api.client.post(`/appointments/${appointment!.id}/cancel`, values);
            toasts.success(t('ops.appointments.done.cancel'));
            await Promise.all([queryClient.invalidateQueries({ queryKey: opsKeys.appointments.all }), queryClient.invalidateQueries({ queryKey: opsKeys.queue.all })]);
            onClose();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('ops.appointments.cancelTitle')}</DialogTitle>
            <DialogDescription>{t('ops.appointments.cancelText', { name: appointment?.customerName ?? appointment?.guestName ?? '' })}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="reason" label={t('ops.appointments.cancelReason')} optional>
              {(field) => <Textarea {...field} rows={2} dir="auto" autoFocus />}
            </FormField>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t('ops.appointments.keep')}
            </Button>
            <Button type="submit" variant="destructive" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('ops.appointments.actions.cancel')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function RescheduleDialog({ appointment, onClose }: { appointment: Appointment | null; onClose: () => void }) {
  const { t, today, formatDate } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const form = useZodForm(rescheduleAppointmentSchema.pick({ startsAt: true, reason: true }), { defaultValues: { startsAt: '', reason: '' } });
  const [date, setDate] = React.useState(today());
  React.useEffect(() => {
    if (appointment) {
      form.reset({ startsAt: '', reason: '' });
      setDate(appointment.localDate > today() ? appointment.localDate : today());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appointment?.id]);
  return (
    <Dialog open={!!appointment} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg">
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            const next = await api.client.post<Appointment>(`/appointments/${appointment!.id}/reschedule`, values);
            toasts.success(t('ops.appointments.done.reschedule'), t('ops.appointments.done.rescheduleText', { date: formatDate(next.localDate, 'long'), time: next.localTime }));
            await queryClient.invalidateQueries({ queryKey: opsKeys.appointments.all });
            onClose();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('ops.appointments.rescheduleTitle')}</DialogTitle>
            <DialogDescription>{appointment ? t('ops.appointments.rescheduleText', { name: appointment.customerName ?? appointment.guestName ?? '', date: formatDate(appointment.localDate), time: appointment.localTime }) : ''}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <div className="space-y-1.5">
              <label htmlFor="reschedule-date" className="text-sm font-medium">
                {t('ops.appointments.fields.newDate')}
              </label>
              <DatePicker
                id="reschedule-date"
                value={date}
                min={today()}
                className="sm:w-56"
                onChange={(v) => {
                  if (!v) return;
                  setDate(v);
                  form.setValue('startsAt', '');
                }}
              />
            </div>
            <FormField name="startsAt" label={t('ops.appointments.fields.slot')} required>
              {(field) => <SlotPicker id={field.id} aria-describedby={field['aria-describedby']} branchId={appointment?.branchId} serviceId={appointment?.serviceId} date={date} value={field.value} onChange={field.onChange} />}
            </FormField>
            <FormField name="reason" label={t('ops.appointments.rescheduleReason')} optional>
              {(field) => <Textarea {...field} rows={2} dir="auto" />}
            </FormField>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('ops.appointments.actions.reschedule')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
