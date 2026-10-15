'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isApiError } from '@typease/api-client';
import { RELATIVE_RANGES, email, hhmm, relativeRange, scheduledReportFormat, scheduledReportFrequency, z } from '@typease/validation';
import {
  Alert, Badge, Button, Checkbox, ChoiceLabel, Combobox, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError, FormField, Input,
  Select, useI18n, useSession, useToast, useZodForm,
} from '@typease/ui';
import { useBranches } from '@/components/branch';
import { useRoles, useStaffOptions } from '@/components/pickers';
import { finKeys } from '@/lib/keys/fin';
import { useFinApi } from './api';
import { FieldSelect } from './shared';
import type { ScheduledReportRow } from './types';

const ALL = '__all__';
const schema = z.object({
  reportKey: z.string().trim().min(2),
  range: relativeRange,
  branchId: z.string().optional(),
  withinDays: z
    .string()
    .regex(/^\d{1,3}$/)
    .optional(),
  format: scheduledReportFormat,
  frequency: scheduledReportFrequency,
  weekday: z.string(),
  dayOfMonth: z.string(),
  timeOfDay: hhmm,
  recipients: z.array(email).min(1, 'Required').max(20),
});

/** Whether the centre's plan includes scheduled reports (any staff member may read the plan's features). */
export function useScheduledReportsFeature() {
  const api = useFinApi();
  const usage = useQuery({
    queryKey: ['tenant', 'usage'],
    queryFn: ({ signal }) => api.client.get<{ plan: { key: string; features: Record<string, boolean> } | null }>('/tenant/usage', { signal }),
    staleTime: 5 * 60_000,
  });
  return { known: !!usage.data, included: usage.data?.plan?.features?.scheduledReports !== false };
}

/** The message shown instead of the form when the plan does not include scheduled reports (HTTP 402). */
export function UpgradeForSchedules({ className }: { className?: string }) {
  const { t } = useI18n();
  const session = useSession();
  return (
    <Alert
      tone="warning"
      className={className}
      title={t('fin.reports.scheduled.upgradeTitle')}
      action={
        session.hasPermission('subscription.manage') ? (
          <Button asChild size="sm">
            <Link href="/subscription">{t('fin.reports.scheduled.upgradeAction')}</Link>
          </Button>
        ) : undefined
      }
    >
      {session.hasPermission('subscription.manage') ? t('fin.reports.scheduled.upgradeText') : t('fin.reports.scheduled.upgradeAskOwner')}
    </Alert>
  );
}

/** "Daily at 07:00", "Every Monday at 07:00", "On day 1 of every month at 07:00". */
export function useScheduleText() {
  const { t } = useI18n();
  return React.useCallback(
    (s: Pick<ScheduledReportRow, 'frequency' | 'weekday' | 'dayOfMonth' | 'timeOfDay'>) =>
      s.frequency === 'DAILY'
        ? t('fin.reports.scheduled.when.daily', { time: s.timeOfDay })
        : s.frequency === 'WEEKLY'
          ? t('fin.reports.scheduled.when.weekly', { day: t(`fin.reports.scheduled.weekdays.${s.weekday ?? 1}`), time: s.timeOfDay })
          : t('fin.reports.scheduled.when.monthly', { day: s.dayOfMonth ?? 1, time: s.timeOfDay }),
    [t],
  );
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit this schedule ... */
  schedule?: ScheduledReportRow;
  /** ... or create one, optionally for this report. */
  reportKey?: string;
  onSaved?: (schedule: ScheduledReportRow) => void;
}

/** Create or edit a scheduled report: which report, for which (relative) period, how often, as what file, to whom. */
export function ScheduleDialog({ open, onOpenChange, schedule, reportKey, onSaved }: Props) {
  const { t, pick } = useI18n();
  const api = useFinApi();
  const session = useSession();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const branches = useBranches();
  const catalogue = useQuery({ queryKey: finKeys.reports.catalogue, queryFn: ({ signal }) => api.reports.catalogue(signal), staleTime: 5 * 60_000 });
  const maySeeStaff = session.hasPermission('staff.read');
  const staff = useStaffOptions(maySeeStaff && open);
  const roles = useRoles(maySeeStaff && open);
  const [upgrade, setUpgrade] = React.useState(false);
  const baseId = React.useId();

  const defaults = React.useMemo(
    () => ({
      reportKey: schedule?.reportKey ?? reportKey ?? '',
      range: schedule?.params.range ?? 'last_month',
      branchId: schedule?.params.branchId ?? '',
      withinDays: schedule?.params.withinDays ? String(schedule.params.withinDays) : '',
      format: schedule?.format ?? 'XLSX',
      frequency: schedule?.frequency ?? 'MONTHLY',
      weekday: String(schedule?.weekday ?? 1),
      dayOfMonth: String(schedule?.dayOfMonth ?? 1),
      timeOfDay: schedule?.timeOfDay ?? '07:00',
      recipients: schedule?.recipients ?? (session.user?.email ? [session.user.email] : []),
    }),
    [schedule, reportKey, session.user?.email],
  );
  const form = useZodForm(schema, { defaultValues: defaults });
  React.useEffect(() => {
    if (open) {
      form.reset(defaults);
      setUpgrade(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const selectedKey = form.watch('reportKey');
  const frequency = form.watch('frequency');
  const branchId = form.watch('branchId');
  const definition = catalogue.data?.reports.find((r) => r.key === selectedKey);
  const hasWithinDays = !!definition?.parameters.some((p) => p.key === 'withinDays' && !p.drilldownOnly);

  // Staff who may receive this report: active, a role that holds the report's permission, access to the chosen branch.
  const eligible = React.useMemo(() => {
    if (!maySeeStaff || !staff.data || !roles.data || !definition) return null;
    const holders = new Set(roles.data.filter((r) => r.permissions.includes(definition.permission)).map((r) => r.key));
    return staff.data.filter((m) => holders.has(m.role.key) && (!branchId || !definition.branchScoped || m.allBranches || m.branchIds.includes(branchId)));
  }, [maySeeStaff, staff.data, roles.data, definition, branchId]);

  const submit = async (values: z.output<typeof schema>) => {
    // Only people who are still eligible for the chosen report and branch stay on the list.
    const allowed = eligible ? new Set(eligible.map((m) => m.user.email.toLowerCase())) : null;
    const recipients = allowed ? values.recipients.filter((address) => allowed.has(address)) : values.recipients;
    if (!recipients.length) {
      form.setError('recipients', { type: 'required', message: t('fin.reports.scheduled.recipientsRequired') });
      return;
    }
    const params = {
      // Filters of an existing schedule that this form does not show are kept as they are.
      ...(schedule?.params ?? {}),
      range: values.range,
      branchId: values.branchId || undefined,
      withinDays: hasWithinDays && values.withinDays ? Number(values.withinDays) : undefined,
    };
    const timing = { timeOfDay: values.timeOfDay, ...(values.frequency === 'WEEKLY' ? { weekday: Number(values.weekday) } : {}), ...(values.frequency === 'MONTHLY' ? { dayOfMonth: Number(values.dayOfMonth) } : {}) };
    try {
      const saved = schedule
        ? await api.reports.updateSchedule(schedule.id, { params, format: values.format, frequency: values.frequency, recipients, ...timing })
        : await api.reports.createSchedule({ reportKey: values.reportKey, params, format: values.format, frequency: values.frequency, recipients, ...timing });
      toasts.success(schedule ? t('fin.reports.scheduled.updated') : t('fin.reports.scheduled.created'), t('fin.reports.scheduled.savedDescription', { title: saved.reportTitle }));
      await queryClient.invalidateQueries({ queryKey: finKeys.reports.scheduled });
      onSaved?.(saved);
      onOpenChange(false);
    } catch (error) {
      if (isApiError(error) && error.code === 'PLAN_LIMIT_REACHED') {
        setUpgrade(true);
        return;
      }
      if (isApiError(error) && error.code === 'INVALID_RECIPIENTS') {
        const problems = ((error.details as { recipients?: Array<{ message?: string }> } | undefined)?.recipients ?? []).map((r) => r.message).filter(Boolean);
        form.setError('recipients', { type: 'server', message: problems.length ? problems.join(' ') : error.message });
        return;
      }
      throw error;
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !form.formState.isSubmitting && onOpenChange(next)}>
      <DialogContent size="lg">
        <Form form={form} onSubmit={submit} className="flex min-h-0 flex-1 flex-col space-y-0">
          <DialogHeader>
            <DialogTitle>{schedule ? t('fin.reports.scheduled.editTitle') : t('fin.reports.scheduled.newTitle')}</DialogTitle>
            <DialogDescription>{t('fin.reports.scheduled.formDescription')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            {upgrade ? <UpgradeForSchedules /> : null}
            <FormField name="reportKey" label={t('fin.reports.scheduled.report')} required>
              {(field) => (
                <Combobox
                  {...field}
                  value={field.value}
                  disabled={!!schedule}
                  onValueChange={(value) => field.onChange(value)}
                  selectedLabel={schedule?.reportTitle}
                  placeholder={t('fin.reports.scheduled.reportPlaceholder')}
                  options={(catalogue.data?.reports ?? []).map((r) => ({ value: r.key, label: r.title, description: r.description }))}
                />
              )}
            </FormField>
            <div className="grid gap-5 sm:grid-cols-2">
              {definition?.asOfNow ? (
                // A balance-style report has no period: it shows the position at the moment it is sent.
                <p className="self-center text-sm text-muted-foreground sm:col-span-2">{t('fin.reports.scheduled.asOfNote')}</p>
              ) : (
                <FormField name="range" label={t('fin.reports.scheduled.range')} required hint={t('fin.reports.scheduled.rangeHint')}>
                  {(field) => <FieldSelect {...field} onValueChange={field.onChange} options={RELATIVE_RANGES.map((r) => ({ value: r, label: t(`fin.reports.ranges.${r}`) }))} />}
                </FormField>
              )}
              {definition?.branchScoped !== false && branches.data && branches.data.length > 1 ? (
                <FormField name="branchId" label={t('fin.common.branch')}>
                  {(field) => (
                    <Select
                      {...field}
                      value={field.value || ALL}
                      onValueChange={(v) => field.onChange(v === ALL ? '' : v)}
                      options={[{ value: ALL, label: t('shell.allBranches') }, ...branches.data.map((b) => ({ value: b.id, label: pick(b.name, b.nameAr) }))]}
                    />
                  )}
                </FormField>
              ) : null}
              {hasWithinDays ? (
                <FormField name="withinDays" label={t('fin.reports.params.withinDays')} optional>
                  {(field) => <Input {...field} inputMode="numeric" dir="ltr" placeholder="30" className="tabular" />}
                </FormField>
              ) : null}
              <FormField name="format" label={t('fin.reports.scheduled.format')} required>
                {(field) => <FieldSelect {...field} onValueChange={field.onChange} options={(['XLSX', 'PDF'] as const).map((f) => ({ value: f, label: t(`fin.reports.formats.${f.toLowerCase()}`) }))} />}
              </FormField>
            </div>
            <div className="grid gap-5 sm:grid-cols-3">
              <FormField name="frequency" label={t('fin.reports.scheduled.frequency')} required>
                {(field) => <FieldSelect {...field} onValueChange={field.onChange} options={(['DAILY', 'WEEKLY', 'MONTHLY'] as const).map((f) => ({ value: f, label: t(`fin.reports.scheduled.frequencies.${f}`) }))} />}
              </FormField>
              {frequency === 'WEEKLY' ? (
                <FormField name="weekday" label={t('fin.reports.scheduled.weekday')} required>
                  {(field) => <FieldSelect {...field} onValueChange={field.onChange} options={[1, 2, 3, 4, 5, 6, 0].map((d) => ({ value: String(d), label: t(`fin.reports.scheduled.weekdays.${d}`) }))} />}
                </FormField>
              ) : null}
              {frequency === 'MONTHLY' ? (
                <FormField name="dayOfMonth" label={t('fin.reports.scheduled.dayOfMonth')} required hint={t('fin.reports.scheduled.dayOfMonthHint')}>
                  {(field) => <FieldSelect {...field} onValueChange={field.onChange} options={Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))} />}
                </FormField>
              ) : null}
              <FormField name="timeOfDay" label={t('fin.reports.scheduled.time')} required hint={t('fin.reports.scheduled.timeHint')}>
                {(field) => <Input {...field} type="time" dir="ltr" className="tabular" />}
              </FormField>
            </div>
            <FormField name="recipients" label={t('fin.reports.scheduled.recipients')} required hint={eligible ? t('fin.reports.scheduled.recipientsHint') : t('fin.reports.scheduled.recipientsTextHint')}>
              {(field) =>
                eligible ? (
                  eligible.length === 0 ? (
                    <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">{definition ? t('fin.reports.scheduled.noEligible') : t('fin.reports.scheduled.chooseReportFirst')}</p>
                  ) : (
                    <ul id={field.id} className="scroll-quiet max-h-56 space-y-2.5 overflow-y-auto rounded-md border p-3" aria-invalid={field['aria-invalid']}>
                      {eligible.map((member) => {
                        const address = member.user.email.toLowerCase();
                        const selected = (field.value as string[]).includes(address);
                        return (
                          <li key={member.id}>
                            <ChoiceLabel
                              htmlFor={`${baseId}-${member.id}`}
                              control={
                                <Checkbox
                                  id={`${baseId}-${member.id}`}
                                  checked={selected}
                                  onCheckedChange={(checked) => field.onChange(checked === true ? [...(field.value as string[]), address] : (field.value as string[]).filter((a) => a !== address))}
                                />
                              }
                              label={
                                <>
                                  {member.user.fullName} <Badge className="ms-1.5 align-middle">{member.role.name}</Badge>
                                </>
                              }
                              description={<span className="ltr-value">{member.user.email}</span>}
                            />
                          </li>
                        );
                      })}
                    </ul>
                  )
                ) : (
                  <Input
                    id={field.id}
                    dir="ltr"
                    autoComplete="off"
                    aria-invalid={field['aria-invalid']}
                    aria-describedby={field['aria-describedby']}
                    defaultValue={(field.value as string[]).join(', ')}
                    onChange={(e) => field.onChange(e.target.value.split(/[,;\s]+/).map((a) => a.trim()).filter(Boolean))}
                    onBlur={field.onBlur}
                    placeholder="accountant@your-centre.ae"
                  />
                )
              }
            </FormField>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={form.formState.isSubmitting}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {schedule ? t('common.saveChanges') : t('fin.reports.scheduled.submit')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
