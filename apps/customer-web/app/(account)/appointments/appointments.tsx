'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, CalendarPlus, Clock, MapPin } from 'lucide-react';
import { isApiError } from '@typease/api-client';
import {
  Alert, Button, Card, Combobox, ConfirmDialog, DatePicker, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState, Label,
  PageHeader, Select, Skeleton, StatusBadge, Textarea, addDays, cn, focusRing, useErrorMessage, useI18n, useToast,
} from '@typease/ui';
import { LoadError, SectionTitle } from '@/components/portal/shared';
import { usePortalApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import type { AppointmentRow, AvailabilitySlot } from '@/lib/types';

const OPEN_STATUSES = ['BOOKED', 'CONFIRMED', 'CHECKED_IN', 'IN_SERVICE'];

/** Booking problems with one meaning, in the portal's words. */
const SLOT_ERRORS = ['SLOT_FULL', 'SLOT_UNAVAILABLE', 'SLOT_IN_PAST', 'BRANCH_CLOSED', 'TOO_FAR_AHEAD', 'ALREADY_BOOKED', 'TOO_LATE_TO_CHANGE'];

/** Visits to the centre: upcoming ones with reschedule / cancel, earlier ones, and booking against the branch's real calendar. */
export function Appointments() {
  const { t } = useI18n();
  const api = usePortalApi();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const queryClient = useQueryClient();
  const toasts = useToast();
  const list = useQuery({ queryKey: keys.appointments.all, queryFn: () => api.appointments({ pageSize: 100 }) });
  const [booking, setBooking] = React.useState<{ reschedule?: AppointmentRow; serviceId?: string } | null>(() => (search.get('book') ? { serviceId: search.get('serviceId') ?? undefined } : null));
  const [cancelling, setCancelling] = React.useState<AppointmentRow | null>(null);
  const [reason, setReason] = React.useState('');
  const reasonId = React.useId();

  // "?book=1" (a link from a request) opens the dialog once; closing it cleans the address.
  const closeBooking = () => {
    setBooking(null);
    if (search.get('book')) router.replace(pathname, { scroll: false });
  };

  const bookButton = (
    <Button variant="accent" size="lg" className="sm:h-10 sm:px-4 sm:text-base" onClick={() => setBooking({})}>
      <CalendarPlus aria-hidden="true" />
      {t('my.appointments.book')}
    </Button>
  );

  const now = Date.now();
  const rows = list.data?.data ?? [];
  const upcoming = rows.filter((a) => OPEN_STATUSES.includes(a.status) && Date.parse(a.endsAt) >= now).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const earlier = rows.filter((a) => !upcoming.includes(a)).sort((a, b) => b.startsAt.localeCompare(a.startsAt));

  return (
    <>
      <PageHeader title={t('nav.appointments')} description={t('account.sections.appointments')} action={bookButton} />
      {list.isPending ? (
        <div className="space-y-3" role="status" aria-label={t('common.loading')}>
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      ) : list.isError ? (
        <LoadError error={list.error} onRetry={() => void list.refetch()} />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState size="page" icon={<CalendarDays />} title={t('my.appointments.emptyTitle')} description={t('my.appointments.emptyText')} action={bookButton} />
        </Card>
      ) : (
        <div className="space-y-8">
          <section aria-labelledby="upcoming-h" className="space-y-3">
            <SectionTitle id="upcoming-h">{t('my.appointments.upcoming')}</SectionTitle>
            {upcoming.length ? (
              <ul className="space-y-3">
                {upcoming.map((a) => (
                  <AppointmentCard key={a.id} appointment={a} onReschedule={() => setBooking({ reschedule: a })} onCancel={() => (setReason(''), setCancelling(a))} />
                ))}
              </ul>
            ) : (
              <p className="rounded-lg border border-dashed p-4 text-base text-muted-foreground">{t('my.appointments.noUpcoming')}</p>
            )}
          </section>
          {earlier.length ? (
            <section aria-labelledby="earlier-h" className="space-y-3">
              <SectionTitle id="earlier-h">{t('my.appointments.earlier')}</SectionTitle>
              <ul className="space-y-3">
                {earlier.map((a) => (
                  <AppointmentCard key={a.id} appointment={a} />
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}

      {booking ? (
        <BookingDialog
          reschedule={booking.reschedule}
          initialServiceId={booking.serviceId}
          onClose={closeBooking}
          onBooked={async () => {
            await queryClient.invalidateQueries({ queryKey: keys.appointments.all });
            void queryClient.invalidateQueries({ queryKey: keys.notifications.all });
          }}
        />
      ) : null}
      <ConfirmDialog
        open={!!cancelling}
        onOpenChange={(open) => !open && setCancelling(null)}
        title={t('my.appointments.cancelTitle')}
        description={t('my.appointments.cancelText')}
        confirmLabel={t('my.appointments.cancel')}
        cancelLabel={t('my.appointments.keep')}
        onConfirm={async () => {
          if (!cancelling) return;
          try {
            await api.cancelAppointment(cancelling.id, reason.trim() || undefined);
          } catch (error) {
            toasts.error(error);
            await queryClient.invalidateQueries({ queryKey: keys.appointments.all });
            throw error;
          }
          toasts.success(t('my.appointments.cancelled'));
          await queryClient.invalidateQueries({ queryKey: keys.appointments.all });
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor={reasonId} optionalText={t('common.optional')}>
            {t('my.appointments.cancelReason')}
          </Label>
          <Textarea id={reasonId} rows={2} dir="auto" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      </ConfirmDialog>
    </>
  );
}

function AppointmentCard({ appointment: a, onReschedule, onCancel }: { appointment: AppointmentRow; onReschedule?: () => void; onCancel?: () => void }) {
  const { t, pick, formatDate, formatTime } = useI18n();
  const service = pick(a.serviceName, a.serviceNameAr);
  return (
    <li className="rounded-lg border bg-card p-4 shadow-xs" data-appointment-status={a.status}>
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1 basis-56 space-y-1.5">
          <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            {/* The day and time of the branch's calendar, as the API states them. */}
            <span className="text-md font-semibold text-foreground">{formatDate(a.localDate, 'long')}</span>
            <StatusBadge kind="appointment" status={a.status} />
          </p>
          <p className="flex items-center gap-2 text-base text-foreground">
            <Clock className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="tabular">
              {formatTime(a.startsAt)} – {formatTime(a.endsAt)}
            </span>
          </p>
          <p className="flex items-start gap-2 text-base text-foreground/85">
            <MapPin className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span>
              {pick(a.branchName, a.branchNameAr)}
              {service ? (
                <>
                  <span aria-hidden="true"> – </span>
                  {service}
                </>
              ) : null}
            </span>
          </p>
          {a.status === 'CANCELLED' && a.cancelledReason ? (
            <p className="text-sm text-muted-foreground" dir="auto">
              {a.cancelledReason}
            </p>
          ) : null}
        </div>
        {(a.canReschedule && onReschedule) || (a.canCancel && onCancel) ? (
          <div className="flex w-full gap-2 sm:w-auto">
            {a.canReschedule && onReschedule ? (
              <Button variant="outline" className="flex-1 sm:flex-none" onClick={onReschedule}>
                {t('my.appointments.reschedule')}
              </Button>
            ) : null}
            {a.canCancel && onCancel ? (
              <Button variant="destructive-outline" className="flex-1 sm:flex-none" onClick={onCancel}>
                {t('my.appointments.cancel')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------- book / reschedule

function BookingDialog({ reschedule, initialServiceId, onClose, onBooked }: { reschedule?: AppointmentRow; initialServiceId?: string; onClose: () => void; onBooked: () => Promise<void> }) {
  const { t, has, pick, today, formatDate, formatTime } = useI18n();
  const api = usePortalApi();
  const toasts = useToast();
  const describe = useErrorMessage();
  const queryClient = useQueryClient();
  const branches = useQuery({ queryKey: keys.branches, queryFn: () => api.branches(), staleTime: 10 * 60_000 });
  const catalogue = useQuery({ queryKey: keys.catalogue.all, queryFn: ({ signal }) => api.catalogue(signal), staleTime: 5 * 60_000, enabled: !reschedule });

  const [branchId, setBranchId] = React.useState(reschedule?.branchId ?? '');
  const [serviceId, setServiceId] = React.useState(reschedule?.serviceId ?? initialServiceId ?? '');
  // Moving an appointment usually means "another time that day": start on its own day.
  const [date, setDate] = React.useState(() => (reschedule && reschedule.localDate >= today() ? reschedule.localDate : today()));
  const [slot, setSlot] = React.useState<AvailabilitySlot | null>(null);
  const [notes, setNotes] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);
  const branchFieldId = React.useId();
  const serviceFieldId = React.useId();
  const dateFieldId = React.useId();
  const notesFieldId = React.useId();

  const branchList = branches.data ?? [];
  const branch = branchId || branchList.find((b) => b.isHeadOffice)?.id || branchList[0]?.id || '';
  const chosenBranch = branchList.find((b) => b.id === branch);
  const availability = useQuery({
    queryKey: keys.appointments.availability(branch, date, serviceId),
    queryFn: ({ signal }) => api.availability({ branchId: branch, date, ...(serviceId ? { serviceId } : {}) }, signal),
    enabled: !!branch && !!date,
    staleTime: 0,
  });
  const slots = availability.data?.slots ?? [];
  const free = slots.filter((s) => s.available);
  const lastDay = availability.data?.bookableUntil ?? addDays(today(), 60);

  const confirm = async () => {
    if (!slot || !branch) return;
    setBusy(true);
    setFailure(null);
    try {
      if (reschedule) await api.rescheduleAppointment(reschedule.id, { startsAt: slot.startsAt, ...(branch !== reschedule.branchId ? { branchId: branch } : {}) });
      else await api.bookAppointment({ branchId: branch, startsAt: slot.startsAt, ...(serviceId ? { serviceId } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}) });
      await onBooked();
      toasts.success(reschedule ? t('my.appointments.rescheduled') : t('my.appointments.booked'), t('my.appointments.bookedOn', { date: formatDate(date, 'long'), time: formatTime(slot.startsAt) }));
      onClose();
    } catch (error) {
      const code = isApiError(error) ? error.code : '';
      setFailure(SLOT_ERRORS.includes(code) && has(`my.appointments.errors.${code}`) ? t(`my.appointments.errors.${code}`) : describe(error));
      // Somebody else was faster, or the day changed: show the calendar as it is now.
      setSlot(null);
      void queryClient.invalidateQueries({ queryKey: keys.appointments.availability(branch, date, serviceId) });
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{reschedule ? t('my.appointments.rescheduleTitle') : t('my.appointments.book')}</DialogTitle>
          <DialogDescription>
            {reschedule ? t('my.appointments.rescheduleText', { date: formatDate(reschedule.localDate, 'long'), time: formatTime(reschedule.startsAt) }) : t('my.appointments.bookText')}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          {branches.isError ? <LoadError error={branches.error} onRetry={() => void branches.refetch()} /> : null}
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={branchFieldId}>{t('my.appointments.branch')}</Label>
              {branches.isPending ? (
                <Skeleton className="h-10" />
              ) : (
                <Select
                  id={branchFieldId}
                  value={branch}
                  onValueChange={(v) => {
                    setBranchId(v);
                    setSlot(null);
                  }}
                  options={branchList.map((b) => ({ value: b.id, label: pick(b.name, b.nameAr) }))}
                />
              )}
              {chosenBranch?.address ? (
                <p className="text-sm text-muted-foreground" dir="auto">
                  {chosenBranch.address}
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={dateFieldId}>{t('my.appointments.date')}</Label>
              <DatePicker
                id={dateFieldId}
                value={date}
                min={today()}
                max={lastDay}
                onChange={(v) => {
                  setDate(v || today());
                  setSlot(null);
                }}
              />
            </div>
          </div>
          {!reschedule ? (
            <div className="space-y-1.5">
              <Label htmlFor={serviceFieldId} optionalText={t('common.optional')}>
                {t('my.appointments.service')}
              </Label>
              <Combobox
                id={serviceFieldId}
                value={serviceId}
                clearable
                placeholder={t('my.appointments.servicePlaceholder')}
                onValueChange={(v) => {
                  setServiceId(v);
                  setSlot(null);
                }}
                options={(catalogue.data?.services ?? []).map((s) => ({ value: s.id, label: pick(s.name, s.nameAr), description: pick(s.category.name, s.category.nameAr) }))}
              />
            </div>
          ) : null}

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-foreground">{t('my.appointments.time', { date: formatDate(date, 'long') })}</legend>
            {availability.isPending ? (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5" role="status" aria-label={t('common.loading')}>
                {Array.from({ length: 10 }, (_, i) => (
                  <Skeleton key={i} className="h-11" />
                ))}
              </div>
            ) : availability.isError ? (
              <LoadError error={availability.error} onRetry={() => void availability.refetch()} />
            ) : availability.data.closed ? (
              <Alert tone="info">{t('my.appointments.closed')}</Alert>
            ) : free.length === 0 ? (
              <Alert tone="info">{slots.length ? t('my.appointments.full') : t('my.appointments.noSlots')}</Alert>
            ) : (
              <div className={cn('grid grid-cols-3 gap-2 sm:grid-cols-5', availability.isFetching && 'opacity-60')} role="radiogroup" aria-label={t('my.appointments.time', { date: formatDate(date, 'long') })}>
                {slots.map((s) => {
                  const selected = slot?.startsAt === s.startsAt;
                  return (
                    <button
                      key={s.startsAt}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      disabled={!s.available}
                      onClick={() => setSlot(s)}
                      className={cn(
                        'tabular h-11 rounded-md border text-base font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:line-through',
                        selected ? 'border-secondary bg-secondary text-secondary-foreground' : 'bg-card text-foreground hover:bg-muted',
                        focusRing,
                      )}
                    >
                      {formatTime(s.startsAt)}
                    </button>
                  );
                })}
              </div>
            )}
          </fieldset>

          {!reschedule ? (
            <div className="space-y-1.5">
              <Label htmlFor={notesFieldId} optionalText={t('common.optional')}>
                {t('my.appointments.notes')}
              </Label>
              <Textarea id={notesFieldId} rows={2} dir="auto" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          ) : null}
          {failure ? (
            <Alert tone="danger" live>
              {failure}
            </Alert>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button disabled={!slot} loading={busy} loadingText={t('common.saving')} onClick={() => void confirm()}>
            {slot ? t('my.appointments.confirmAt', { time: formatTime(slot.startsAt) }) : reschedule ? t('my.appointments.reschedule') : t('my.appointments.book')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
