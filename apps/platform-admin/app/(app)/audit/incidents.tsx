'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Siren } from 'lucide-react';
import { privacyIncidentSchema } from '@typease/validation';
import {
  Badge, Button, Checkbox, ChoiceLabel, DataTable, DatePicker, DescriptionList, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError, FormField, Input,
  PermissionGate, Select, Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, Textarea, useI18n, useSession, useToast, useZodForm, type DataTableColumn,
  type DataTableFilter, type Tone,
} from '@typease/ui';
import { ConfirmReasonDialog, Field } from '@/components/shared';
import { usePlatformApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import type { IncidentSeverity, IncidentStatus, PlatformIncident } from '@/lib/types';

const SEVERITIES: IncidentSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const STATUSES: IncidentStatus[] = ['OPEN', 'INVESTIGATING', 'CONTAINED', 'RESOLVED'];
const SEVERITY_TONE: Record<IncidentSeverity, Tone> = { CRITICAL: 'danger', HIGH: 'danger', MEDIUM: 'warning', LOW: 'neutral' };
const STATUS_TONE: Record<IncidentStatus, Tone> = { OPEN: 'danger', INVESTIGATING: 'warning', CONTAINED: 'info', RESOLVED: 'success' };
/** The workflow of the register: no step can be skipped; contained and resolved incidents can be reopened. */
const NEXT: Record<IncidentStatus, IncidentStatus[]> = { OPEN: ['INVESTIGATING'], INVESTIGATING: ['CONTAINED'], CONTAINED: ['RESOLVED', 'INVESTIGATING'], RESOLVED: ['INVESTIGATING'] };

/**
 * The platform's own incident register (GET /platform/privacy/incidents): incidents that
 * concern TypEase as a whole. It records facts and decisions; it notifies nobody.
 */
export function Incidents() {
  const { t, formatDate } = useI18n();
  const api = usePlatformApi();
  const [open, setOpen] = React.useState<PlatformIncident | null>(null);
  const [reporting, setReporting] = React.useState(false);

  const columns = React.useMemo<Array<DataTableColumn<PlatformIncident>>>(
    () => [
      { id: 'title', header: t('audit.incidents.incident'), mobile: 'title', className: 'min-w-64', cell: (i) => <span dir="auto">{i.title}</span> },
      { id: 'severity', header: t('audit.security.severityLabel'), cell: (i) => <Badge tone={SEVERITY_TONE[i.severity]}>{t(`audit.security.severity.${i.severity}`)}</Badge> },
      { id: 'status', header: t('pc.status'), mobile: 'badge', cell: (i) => <Badge tone={STATUS_TONE[i.status]}>{t(`audit.incidents.status.${i.status}`)}</Badge> },
      { id: 'personal', header: t('audit.incidents.personalData'), cell: (i) => (i.personalDataInvolved ? <Badge tone="warning">{t('common.yes')}</Badge> : t('common.no')) },
      { id: 'detected', header: t('audit.incidents.detected'), sortField: 'detectedAt', className: 'whitespace-nowrap tabular', cell: (i) => formatDate(i.detectedAt) },
      { id: 'resolved', header: t('audit.incidents.resolved'), className: 'whitespace-nowrap tabular', cell: (i) => (i.resolvedAt ? formatDate(i.resolvedAt) : null) },
    ],
    [t, formatDate],
  );
  const filters = React.useMemo<DataTableFilter[]>(
    () => [
      { id: 'status', type: 'select', label: t('pc.status'), options: STATUSES.map((s) => ({ value: s, label: t(`audit.incidents.status.${s}`) })) },
      { id: 'severity', type: 'select', label: t('audit.security.severityLabel'), options: SEVERITIES.map((s) => ({ value: s, label: t(`audit.security.severity.${s}`) })) },
    ],
    [t],
  );
  const report = (
    <PermissionGate permission="platform.tenants.manage">
      <Button variant="outline" onClick={() => setReporting(true)}>
        <Plus aria-hidden="true" />
        {t('audit.incidents.report.action')}
      </Button>
    </PermissionGate>
  );

  return (
    <>
      <DataTable<PlatformIncident>
        caption={t('audit.tabs.incidents')}
        queryKey={keys.incidents.all}
        queryFn={(params, signal) => api.incidents.list(params, signal)}
        columns={columns}
        rowKey={(i) => i.id}
        onRowClick={setOpen}
        filters={filters}
        searchable={false}
        defaultSort="detectedAt:desc"
        toolbar={report}
        empty={{ icon: <Siren />, title: t('audit.incidents.emptyTitle'), description: t('audit.incidents.emptyText'), action: report }}
      />
      <p className="mt-3 text-sm text-muted-foreground">{t('audit.incidents.note')}</p>
      <IncidentSheet incident={open} onClose={() => setOpen(null)} onChanged={setOpen} />
      <ReportDialog open={reporting} onOpenChange={setReporting} />
    </>
  );
}

function ReportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const api = usePlatformApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const form = useZodForm(privacyIncidentSchema, { defaultValues: { title: '', description: '', severity: 'MEDIUM', affectedData: '', personalDataInvolved: false } });
  React.useEffect(() => {
    if (open) form.reset({ title: '', description: '', severity: 'MEDIUM', affectedData: '', personalDataInvolved: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={(next) => !form.formState.isSubmitting && onOpenChange(next)}>
      <DialogContent size="lg">
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            await api.incidents.create(values);
            await Promise.all([keys.incidents.all, keys.audit.all].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
            toasts.success(t('audit.incidents.report.done'));
            onOpenChange(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('audit.incidents.report.title')}</DialogTitle>
            <DialogDescription>{t('audit.incidents.report.text')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="title" label={t('audit.incidents.report.what')} required>
              {(field) => <Input {...field} autoComplete="off" dir="auto" maxLength={200} autoFocus />}
            </FormField>
            <FormField name="description" label={t('audit.incidents.report.description')} required hint={t('audit.incidents.report.descriptionHint')}>
              {(field) => <Textarea {...field} rows={4} dir="auto" maxLength={5000} />}
            </FormField>
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField name="severity" label={t('audit.security.severityLabel')}>
                {(field) => <Select {...field} onValueChange={field.onChange} options={SEVERITIES.map((s) => ({ value: s, label: t(`audit.security.severity.${s}`) }))} />}
              </FormField>
              <FormField name="affectedData" label={t('audit.incidents.affected')} optional>
                {(field) => <Input {...field} autoComplete="off" dir="auto" />}
              </FormField>
            </div>
            <FormField name="personalDataInvolved" label={t('audit.incidents.personalData')}>
              {(field) => (
                <ChoiceLabel
                  htmlFor={field.id}
                  control={<Checkbox id={field.id} ref={field.ref} checked={!!field.value} onCheckedChange={(checked) => field.onChange(checked === true)} />}
                  label={t('audit.incidents.report.personalYes')}
                  description={t('audit.incidents.report.personalHint')}
                />
              )}
            </FormField>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={form.formState.isSubmitting}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('audit.incidents.report.submit')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

const DECISIONS = ['undecided', 'yes', 'no'] as const;
type Decision = (typeof DECISIONS)[number];
const decisionOf = (value: boolean | null): Decision => (value === null ? 'undecided' : value ? 'yes' : 'no');
const dayIn = (iso: string | null, timeZone: string) => (iso ? new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso)) : '');

function IncidentSheet({ incident, onClose, onChanged }: { incident: PlatformIncident | null; onClose: () => void; onChanged: (incident: PlatformIncident) => void }) {
  const { t, formatDateTime, formatDate, today, timeZone } = useI18n();
  const api = usePlatformApi();
  const session = useSession();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const mayManage = session.hasPermission('platform.tenants.manage');
  const [target, setTarget] = React.useState<IncidentStatus | null>(null);
  const [decision, setDecision] = React.useState<Decision>('undecided');
  const [authority, setAuthority] = React.useState('');
  const [individuals, setIndividuals] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  React.useEffect(() => {
    if (!incident) return;
    setDecision(decisionOf(incident.notificationRequired));
    setAuthority(dayIn(incident.authorityNotifiedAt, timeZone));
    setIndividuals(dayIn(incident.individualsNotifiedAt, timeZone));
  }, [incident, timeZone]);
  const refresh = () => Promise.all([keys.incidents.all, keys.audit.all].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  const dirty = !!incident && (decision !== decisionOf(incident.notificationRequired) || authority !== dayIn(incident.authorityNotifiedAt, timeZone) || individuals !== dayIn(incident.individualsNotifiedAt, timeZone));
  // A day is recorded as its start in UAE time; today is recorded as "now", so it can never lie in the future.
  const at = (day: string) => (day ? (day >= today() ? new Date().toISOString() : `${day}T12:00:00+04:00`) : null);

  const saveNotification = async () => {
    if (!incident) return;
    setSaving(true);
    try {
      const updated = await api.incidents.update(incident.id, { notificationRequired: decision === 'undecided' ? null : decision === 'yes', authorityNotifiedAt: at(authority), individualsNotifiedAt: at(individuals) });
      await refresh();
      onChanged(updated);
      toasts.success(t('audit.incidents.notification.saved'));
    } catch (error) {
      toasts.error(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Sheet open={!!incident} onOpenChange={(open) => !open && onClose()}>
        <SheetContent side="end" className="w-[min(38rem,96vw)]">
          <SheetHeader>
            <SheetTitle dir="auto">{incident?.title}</SheetTitle>
            <SheetDescription>{incident ? t('audit.incidents.detectedOn', { date: formatDateTime(incident.detectedAt) }) : ''}</SheetDescription>
          </SheetHeader>
          <SheetBody className="space-y-6">
            {incident ? (
              <>
                <DescriptionList
                  columns={2}
                  items={[
                    { label: t('pc.status'), value: <Badge tone={STATUS_TONE[incident.status]}>{t(`audit.incidents.status.${incident.status}`)}</Badge> },
                    { label: t('audit.security.severityLabel'), value: <Badge tone={SEVERITY_TONE[incident.severity]}>{t(`audit.security.severity.${incident.severity}`)}</Badge> },
                    { label: t('audit.incidents.report.description'), wide: true, value: <span className="whitespace-pre-wrap" dir="auto">{incident.description}</span> },
                    { label: t('audit.incidents.affected'), value: incident.affectedData ? <span dir="auto">{incident.affectedData}</span> : null },
                    { label: t('audit.incidents.personalData'), value: incident.personalDataInvolved ? t('common.yes') : t('common.no') },
                    { label: t('audit.incidents.resolved'), value: incident.resolvedAt ? <span className="tabular">{formatDateTime(incident.resolvedAt)}</span> : null },
                    ...(incident.resolutionNotes ? [{ label: t('audit.incidents.resolutionNotes'), wide: true, value: <span className="whitespace-pre-wrap" dir="auto">{incident.resolutionNotes}</span> }] : []),
                  ]}
                />

                <section aria-labelledby="incident-notification" className="space-y-4 rounded-lg border p-4">
                  <div>
                    <h3 id="incident-notification" className="text-md font-semibold text-foreground">
                      {t('audit.incidents.notification.title')}
                    </h3>
                    <p className="mt-1 text-sm text-muted-foreground">{t('audit.incidents.notification.text')}</p>
                  </div>
                  {mayManage ? (
                    <>
                      <Field label={t('audit.incidents.notification.required')} htmlFor="incident-decision">
                        <Select id="incident-decision" value={decision} onValueChange={(value) => setDecision(value as Decision)} options={DECISIONS.map((d) => ({ value: d, label: t(`audit.incidents.notification.${d}`) }))} />
                      </Field>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <Field label={t('audit.incidents.notification.authority')} htmlFor="incident-authority">
                          <DatePicker id="incident-authority" value={authority} max={today()} onChange={setAuthority} />
                        </Field>
                        <Field label={t('audit.incidents.notification.individuals')} htmlFor="incident-individuals">
                          <DatePicker id="incident-individuals" value={individuals} max={today()} onChange={setIndividuals} />
                        </Field>
                      </div>
                      <div className="flex justify-end">
                        <Button variant="outline" disabled={!dirty} loading={saving} loadingText={t('common.saving')} onClick={() => void saveNotification()}>
                          {t('common.saveChanges')}
                        </Button>
                      </div>
                    </>
                  ) : (
                    <DescriptionList
                      columns={1}
                      items={[
                        { label: t('audit.incidents.notification.required'), value: t(`audit.incidents.notification.${decisionOf(incident.notificationRequired)}`) },
                        { label: t('audit.incidents.notification.authority'), value: incident.authorityNotifiedAt ? formatDate(incident.authorityNotifiedAt) : null },
                        { label: t('audit.incidents.notification.individuals'), value: incident.individualsNotifiedAt ? formatDate(incident.individualsNotifiedAt) : null },
                      ]}
                    />
                  )}
                </section>
              </>
            ) : null}
          </SheetBody>
          {incident && mayManage ? (
            <SheetFooter>
              {NEXT[incident.status].map((status) => (
                <Button key={status} variant={status === 'RESOLVED' ? 'default' : 'outline'} onClick={() => setTarget(status)}>
                  {t(incident.status !== 'OPEN' && status === 'INVESTIGATING' && incident.status !== 'INVESTIGATING' ? 'audit.incidents.step.reopen' : `audit.incidents.step.${status}`)}
                </Button>
              ))}
            </SheetFooter>
          ) : null}
        </SheetContent>
      </Sheet>

      <ConfirmReasonDialog
        open={!!target && !!incident}
        onOpenChange={(open) => !open && setTarget(null)}
        tone="default"
        required={target === 'RESOLVED'}
        minLength={target === 'RESOLVED' ? 5 : 1}
        maxLength={5000}
        title={target ? t(`audit.incidents.confirm.${target}`) : ''}
        description={target === 'RESOLVED' ? t('audit.incidents.confirm.resolvedText') : t('audit.incidents.confirm.text')}
        confirmLabel={target ? t(incident && incident.status !== 'OPEN' && target === 'INVESTIGATING' ? 'audit.incidents.step.reopen' : `audit.incidents.step.${target}`) : ''}
        label={target === 'RESOLVED' ? t('audit.incidents.resolutionNotes') : t('pc.note')}
        onConfirm={async (notes) => {
          const updated = await api.incidents.setStatus(incident!.id, { status: target, resolutionNotes: notes || undefined });
          await refresh();
          onChanged(updated);
          toasts.success(t('audit.incidents.stepDone', { status: t(`audit.incidents.status.${target}`) }));
        }}
      />
    </>
  );
}
