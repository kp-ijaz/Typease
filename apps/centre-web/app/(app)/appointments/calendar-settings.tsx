'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarOff, Pencil, Plus, Trash2 } from 'lucide-react';
import { appointmentSettingsSchema, closureSchema, slotConfigSchema } from '@typease/validation';
import {
  Badge, Button, ChoiceLabel, ConfirmDialog, DatePicker, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState, Form, FormActions,
  FormError, FormField, Input, Select, Skeleton, Switch, useApi, useI18n, useSession, useToast, useZodForm,
} from '@typease/ui';
import { ServicePicker, useServiceOptions } from '@/components/pickers';
import { Loadable, Panel, useRun } from '@/components/ops/common';
import type { AppointmentSettings, Closure, SlotConfig } from '@/components/ops/types';
import { opsKeys } from '@/lib/keys/ops';

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];

/** The branch calendar: bookable hours per weekday (optionally per service), closures, and the booking rules of the centre. */
export function CalendarSettings({ branchId }: { branchId: string }) {
  const { t, tn, pick, today, formatDate, formatNumber } = useI18n();
  const api = useApi();
  const session = useSession();
  const canManage = session.hasPermission('appointment.manage');
  const { run, busy } = useRun();
  const [editing, setEditing] = React.useState<SlotConfig | { weekday: number } | null>(null);
  const [removing, setRemoving] = React.useState<SlotConfig | null>(null);
  const [closing, setClosing] = React.useState(false);
  const [reopening, setReopening] = React.useState<Closure | null>(null);
  const services = useServiceOptions();

  const configs = useQuery({ queryKey: opsKeys.appointments.slotConfigs(branchId), queryFn: () => api.client.get<SlotConfig[]>('/appointments/slot-configs', { query: { branchId, includeInactive: true } }) });
  const closures = useQuery({ queryKey: opsKeys.appointments.closures(branchId), queryFn: () => api.client.get<Closure[]>('/appointments/closures', { query: { branchId, from: today() } }) });
  const invalidate = [opsKeys.appointments.all];
  const serviceName = (id: string | null) => {
    if (!id) return t('ops.appointments.calendar.general');
    const s = (services.data ?? []).find((x) => x.id === id);
    return s ? pick(s.name, s.nameAr) : t('ops.appointments.calendar.oneService');
  };

  return (
    <div className="space-y-4">
      <Panel title={t('ops.appointments.calendar.hoursTitle')} description={t('ops.appointments.calendar.hoursText')}>
        <Loadable query={configs} skeleton={<Skeleton className="h-64 w-full" />}>
          {(list) => (
            <ul className="divide-y rounded-md border">
              {WEEKDAYS.map((weekday) => {
                const day = list.filter((c) => c.weekday === weekday).sort((a, b) => a.startTime.localeCompare(b.startTime));
                return (
                  <li key={weekday} className="grid grid-cols-1 gap-x-4 gap-y-2 px-4 py-3 sm:grid-cols-[8rem_minmax(0,1fr)_auto] sm:items-start">
                    <p className="pt-1 font-medium">{t(`ops.appointments.weekdays.${weekday}`)}</p>
                    <div className="space-y-2">
                      {day.length === 0 ? <p className="pt-1 text-sm text-muted-foreground">{t('ops.appointments.calendar.noHours')}</p> : null}
                      {day.map((config) => (
                        <div key={config.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                          <span className="tabular font-medium" dir="ltr">
                            {config.startTime}–{config.endTime}
                          </span>
                          <span className="text-sm text-muted-foreground">
                            {t('ops.appointments.calendar.slotLine', { minutes: formatNumber(config.slotMinutes) })} · {tn('ops.appointments.calendar.capacity', config.capacity)}
                          </span>
                          <Badge tone={config.serviceId ? 'brand' : 'neutral'}>{serviceName(config.serviceId)}</Badge>
                          {canManage ? (
                            <span className="ms-auto flex items-center gap-1">
                              <Switch
                                checked={config.isActive}
                                disabled={busy !== null}
                                aria-label={t('ops.appointments.calendar.activeLabel')}
                                onCheckedChange={(isActive) => void run(`active-${config.id}`, () => api.client.patch(`/appointments/slot-configs/${config.id}`, { isActive }), { success: t(isActive ? 'ops.appointments.calendar.switchedOn' : 'ops.appointments.calendar.switchedOff'), invalidate })}
                              />
                              <Button variant="ghost" size="icon-sm" onClick={() => setEditing(config)} aria-label={t('common.edit')} title={t('common.edit')}>
                                <Pencil aria-hidden="true" />
                              </Button>
                              <Button variant="ghost" size="icon-sm" onClick={() => setRemoving(config)} aria-label={t('common.delete')} title={t('common.delete')}>
                                <Trash2 aria-hidden="true" />
                              </Button>
                            </span>
                          ) : config.isActive ? null : (
                            <Badge tone="warning">{t('ops.common.disabled')}</Badge>
                          )}
                        </div>
                      ))}
                    </div>
                    {canManage ? (
                      <Button variant="ghost" size="sm" onClick={() => setEditing({ weekday })}>
                        <Plus aria-hidden="true" />
                        {t('ops.appointments.calendar.addHours')}
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Loadable>
      </Panel>

      <Panel
        title={t('ops.appointments.calendar.closuresTitle')}
        description={t('ops.appointments.calendar.closuresText')}
        action={
          canManage ? (
            <Button variant="outline" size="sm" onClick={() => setClosing(true)}>
              <Plus aria-hidden="true" />
              {t('ops.appointments.calendar.addClosure')}
            </Button>
          ) : undefined
        }
      >
        <Loadable query={closures} skeleton={<Skeleton className="h-20 w-full" />}>
          {(list) =>
            list.length === 0 ? (
              <EmptyState icon={<CalendarOff />} title={t('ops.appointments.calendar.noClosures')} description={t('ops.appointments.calendar.noClosuresText')} />
            ) : (
              <ul className="divide-y rounded-md border">
                {list.map((closure) => (
                  <li key={closure.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
                    <div>
                      <p className="font-medium">{formatDate(closure.date, 'long')}</p>
                      {closure.reason ? <p className="text-sm text-muted-foreground">{closure.reason}</p> : null}
                    </div>
                    {canManage ? (
                      <Button variant="ghost" size="sm" onClick={() => setReopening(closure)}>
                        <Trash2 aria-hidden="true" />
                        {t('ops.appointments.calendar.removeClosure')}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )
          }
        </Loadable>
      </Panel>

      <BookingRules editable={canManage} />

      <SlotConfigDialog branchId={branchId} target={editing} onClose={() => setEditing(null)} />
      <ClosureDialog branchId={branchId} open={closing} onOpenChange={setClosing} />
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t('ops.appointments.calendar.deleteHoursTitle')}
        description={t('ops.appointments.calendar.deleteHoursText')}
        confirmLabel={t('common.delete')}
        onConfirm={async () => {
          await run('delete', () => api.client.delete(`/appointments/slot-configs/${removing!.id}`), { success: t('ops.appointments.calendar.hoursDeleted'), invalidate, rethrow: true });
        }}
      />
      <ConfirmDialog
        open={!!reopening}
        onOpenChange={(open) => !open && setReopening(null)}
        tone="default"
        title={t('ops.appointments.calendar.removeClosureTitle', { date: reopening ? formatDate(reopening.date, 'long') : '' })}
        description={t('ops.appointments.calendar.removeClosureText')}
        confirmLabel={t('ops.appointments.calendar.removeClosure')}
        onConfirm={async () => {
          await run('reopen', () => api.client.delete(`/appointments/closures/${reopening!.id}`), { success: t('ops.appointments.calendar.closureRemoved'), invalidate, rethrow: true });
        }}
      />
    </div>
  );
}

function SlotConfigDialog({ branchId, target, onClose }: { branchId: string; target: SlotConfig | { weekday: number } | null; onClose: () => void }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const existing = target && 'id' in target ? target : null;
  const form = useZodForm(slotConfigSchema, { emptyAs: 'null' });
  React.useEffect(() => {
    if (target) {
      form.reset({
        branchId,
        weekday: target.weekday,
        serviceId: existing?.serviceId ?? '',
        startTime: existing?.startTime ?? '09:00',
        endTime: existing?.endTime ?? '17:00',
        slotMinutes: existing?.slotMinutes ?? 30,
        capacity: existing?.capacity ?? 1,
        isActive: existing?.isActive ?? true,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  const number = (onChange: (v: unknown) => void) => (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value === '' ? '' : Number(e.target.value));
  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            if (existing) {
              const { branchId: _branch, ...patch } = values;
              await api.client.patch(`/appointments/slot-configs/${existing.id}`, patch);
            } else await api.client.post('/appointments/slot-configs', values);
            toasts.success(t('ops.appointments.calendar.hoursSaved'));
            await queryClient.invalidateQueries({ queryKey: opsKeys.appointments.all });
            onClose();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t(existing ? 'ops.appointments.calendar.editHours' : 'ops.appointments.calendar.addHours')}</DialogTitle>
            <DialogDescription>{t('ops.appointments.calendar.hoursDialogText')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="weekday" label={t('ops.appointments.calendar.weekday')} required>
              {(field) => <Select {...field} value={String(field.value)} onValueChange={(v) => field.onChange(Number(v))} options={WEEKDAYS.map((d) => ({ value: String(d), label: t(`ops.appointments.weekdays.${d}`) }))} />}
            </FormField>
            <div className="grid grid-cols-2 gap-5">
              <FormField name="startTime" label={t('ops.appointments.calendar.from')} required>
                {(field) => <Input {...field} type="time" dir="ltr" className="tabular" />}
              </FormField>
              <FormField name="endTime" label={t('ops.appointments.calendar.until')} required>
                {(field) => <Input {...field} type="time" dir="ltr" className="tabular" />}
              </FormField>
              <FormField name="slotMinutes" label={t('ops.appointments.calendar.slotMinutes')} required>
                {(field) => <Input {...field} type="number" min={5} max={480} step={5} inputMode="numeric" dir="ltr" className="tabular" onChange={number(field.onChange)} />}
              </FormField>
              <FormField name="capacity" label={t('ops.appointments.calendar.capacityField')} required hint={t('ops.appointments.calendar.capacityHint')}>
                {(field) => <Input {...field} type="number" min={1} max={200} inputMode="numeric" dir="ltr" className="tabular" onChange={number(field.onChange)} />}
              </FormField>
            </div>
            <FormField name="serviceId" label={t('ops.appointments.calendar.service')} optional hint={t('ops.appointments.calendar.serviceHint')}>
              {(field) => <ServicePicker {...field} value={field.value} onChange={(id) => field.onChange(id)} clearable placeholder={t('ops.appointments.calendar.general')} />}
            </FormField>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function ClosureDialog({ branchId, open, onOpenChange }: { branchId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, tn, today } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const form = useZodForm(closureSchema);
  React.useEffect(() => {
    if (open) form.reset({ branchId, date: '', reason: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            const closure = await api.client.post<Closure>('/appointments/closures', values);
            const affected = closure.affectedAppointments ?? 0;
            if (affected > 0) toasts.warning(t('ops.appointments.calendar.closureAdded'), tn('ops.appointments.calendar.closureAffected', affected));
            else toasts.success(t('ops.appointments.calendar.closureAdded'));
            await queryClient.invalidateQueries({ queryKey: opsKeys.appointments.all });
            onOpenChange(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('ops.appointments.calendar.addClosure')}</DialogTitle>
            <DialogDescription>{t('ops.appointments.calendar.closureDialogText')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="date" label={t('ops.common.date')} required>
              {(field) => <DatePicker {...field} min={today()} />}
            </FormField>
            <FormField name="reason" label={t('ops.appointments.calendar.reason')} optional hint={t('ops.appointments.calendar.reasonHint')}>
              {(field) => <Input {...field} dir="auto" autoComplete="off" />}
            </FormField>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('ops.appointments.calendar.addClosure')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

/** Rules for the whole centre: guest booking, no-shows, cancellation cut-off, reminders. */
function BookingRules({ editable }: { editable: boolean }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: opsKeys.appointments.settings, queryFn: () => api.client.get<AppointmentSettings>('/appointments/settings') });
  return (
    <Panel title={t('ops.appointments.rules.title')} description={t('ops.appointments.rules.text')}>
      <Loadable query={settings} skeleton={<Skeleton className="h-56 w-full" />}>
        {(data) => (
          <RulesForm
            data={data}
            editable={editable}
            onSave={async (values) => {
              await api.client.put('/appointments/settings', values);
              toasts.success(t('ops.appointments.rules.saved'));
              await queryClient.invalidateQueries({ queryKey: opsKeys.appointments.all });
            }}
          />
        )}
      </Loadable>
    </Panel>
  );
}

function RulesForm({ data, editable, onSave }: { data: AppointmentSettings; editable: boolean; onSave: (values: object) => Promise<void> }) {
  const { t } = useI18n();
  const toValues = (d: AppointmentSettings) => ({ ...d });
  const form = useZodForm(appointmentSettingsSchema, { defaultValues: toValues(data), disabled: !editable });
  React.useEffect(() => {
    form.reset(toValues(data));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  const number = (onChange: (v: unknown) => void) => (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value === '' ? '' : Number(e.target.value));
  return (
    <Form form={form} onSubmit={onSave} className="space-y-6">
      <div className="grid gap-4">
        <FormField name="guestBookingEnabled" label={t('ops.appointments.rules.guest')} hideLabel>
          {(field) => <ChoiceLabel htmlFor={field.id} control={<Switch id={field.id} checked={field.value === true} onCheckedChange={field.onChange} disabled={field.disabled} />} label={t('ops.appointments.rules.guest')} description={t('ops.appointments.rules.guestHint')} />}
        </FormField>
        <FormField name="limitToStaffOnDuty" label={t('ops.appointments.rules.staffOnDuty')} hideLabel>
          {(field) => <ChoiceLabel htmlFor={field.id} control={<Switch id={field.id} checked={field.value === true} onCheckedChange={field.onChange} disabled={field.disabled} />} label={t('ops.appointments.rules.staffOnDuty')} description={t('ops.appointments.rules.staffOnDutyHint')} />}
        </FormField>
      </div>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
        <FormField name="maxDaysAhead" label={t('ops.appointments.rules.maxDaysAhead')} hint={t('ops.appointments.rules.maxDaysAheadHint')}>
          {(field) => <Input {...field} type="number" min={1} max={365} inputMode="numeric" dir="ltr" className="tabular" onChange={number(field.onChange)} />}
        </FormField>
        <FormField name="noShowAfterMinutes" label={t('ops.appointments.rules.noShowAfter')} hint={t('ops.appointments.rules.noShowAfterHint')}>
          {(field) => <Input {...field} type="number" min={5} max={1440} inputMode="numeric" dir="ltr" className="tabular" onChange={number(field.onChange)} />}
        </FormField>
        <FormField name="customerCancelCutoffMinutes" label={t('ops.appointments.rules.cancelCutoff')} hint={t('ops.appointments.rules.cancelCutoffHint')}>
          {(field) => <Input {...field} type="number" min={0} max={10080} inputMode="numeric" dir="ltr" className="tabular" onChange={number(field.onChange)} />}
        </FormField>
        <FormField name="reminderHoursBefore" label={t('ops.appointments.rules.reminders')} hint={t('ops.appointments.rules.remindersHint')}>
          {(field) => (
            <Input
              id={field.id}
              aria-invalid={field['aria-invalid']}
              aria-describedby={field['aria-describedby']}
              disabled={field.disabled}
              dir="ltr"
              className="tabular"
              defaultValue={Array.isArray(field.value) ? field.value.join(', ') : ''}
              key={Array.isArray(field.value) ? `v-${data.reminderHoursBefore.join('-')}` : 'empty'}
              onBlur={field.onBlur}
              onChange={(e) =>
                field.onChange(
                  e.target.value
                    .split(/[,،\s]+/)
                    .filter(Boolean)
                    .map(Number),
                )
              }
            />
          )}
        </FormField>
      </div>
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
