'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ShieldAlert } from 'lucide-react';
import type { Page } from '@typease/types';
import { isApiError } from '@typease/api-client';
import { INCIDENT_SEVERITIES, INCIDENT_STATUSES, privacyIncidentSchema } from '@typease/validation';
import {
  Alert, Badge, Button, DataTable, DescriptionList, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError, FormField, Input, Select,
  Skeleton, Stepper, Textarea, useApi, useI18n, useToast, useZodForm, type DataTableColumn, type DataTableFilter,
} from '@typease/ui';
import { ActionError, Field, LoadError, SettingSwitch } from '@/components/adm/shared';
import type { IncidentRow } from '@/components/adm/types';
import { admKeys } from '@/lib/keys/adm';
import { INCIDENT_STATUS_TONE, SEVERITY_TONE, fromLocalInput, toLocalInput, usePrivacyLabels } from './labels';

const NEXT: Record<string, string[]> = { OPEN: ['INVESTIGATING'], INVESTIGATING: ['CONTAINED'], CONTAINED: ['RESOLVED', 'INVESTIGATING'], RESOLVED: ['INVESTIGATING'] };
const DECISION = { undecided: null, yes: true, no: false } as const;

/** The centre's incident register: record an incident, move it through its steps, note when who was notified. */
export function IncidentsTab() {
  const { t, formatDateTime } = useI18n();
  const api = useApi();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const labels = usePrivacyLabels();
  const openId = params.get('incident');
  const [adding, setAdding] = React.useState(false);
  const href = (id: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (id) next.set('incident', id);
    else next.delete('incident');
    return `${pathname}?${next.toString()}`;
  };

  const columns = React.useMemo<Array<DataTableColumn<IncidentRow>>>(
    () => [
      { id: 'title', header: t('adm.privacy.incidents.titleField'), mobile: 'title', cell: (i) => <span dir="auto">{i.title}</span> },
      { id: 'severity', header: t('adm.privacy.incidents.severity'), cell: (i) => <Badge tone={SEVERITY_TONE[i.severity] ?? 'neutral'}>{labels.severity(i.severity)}</Badge> },
      { id: 'status', header: t('adm.privacy.requests.status'), mobile: 'badge', cell: (i) => <Badge tone={INCIDENT_STATUS_TONE[i.status] ?? 'neutral'}>{labels.incidentStatus(i.status)}</Badge> },
      { id: 'personal', header: t('adm.privacy.incidents.personalShort'), cell: (i) => (i.personalDataInvolved ? t('common.yes') : t('common.no')) },
      { id: 'detected', header: t('adm.privacy.incidents.detected'), sortField: 'detectedAt', className: 'whitespace-nowrap tabular', cell: (i) => formatDateTime(i.detectedAt) },
    ],
    [t, labels, formatDateTime],
  );
  const filters = React.useMemo<DataTableFilter[]>(
    () => [
      { id: 'status', type: 'select', label: t('adm.privacy.requests.status'), options: INCIDENT_STATUSES.map((s) => ({ value: s, label: labels.incidentStatus(s) })) },
      { id: 'severity', type: 'select', label: t('adm.privacy.incidents.severity'), options: INCIDENT_SEVERITIES.map((s) => ({ value: s, label: labels.severity(s) })) },
    ],
    [t, labels],
  );
  const add = (
    <Button variant="accent" onClick={() => setAdding(true)}>
      <Plus aria-hidden="true" />
      {t('adm.privacy.incidents.add')}
    </Button>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-base text-muted-foreground">{t('adm.privacy.incidents.intro')}</p>
        {add}
      </div>
      <DataTable<IncidentRow>
        caption={t('adm.privacy.tabs.incidents')}
        queryKey={admKeys.privacy.incidents}
        queryFn={({ q: _q, ...query }, signal) => api.client.get<Page<IncidentRow>>('/privacy/incidents', { query, signal })}
        columns={columns}
        rowKey={(i) => i.id}
        rowHref={(i) => href(i.id)}
        filters={filters}
        searchable={false}
        defaultSort="detectedAt:desc"
        empty={{ icon: <ShieldAlert />, title: t('adm.privacy.incidents.emptyTitle'), description: t('adm.privacy.incidents.emptyText'), action: add }}
      />
      <NewIncidentDialog open={adding} onOpenChange={setAdding} />
      <IncidentDialog id={openId} onClose={() => router.replace(href(null), { scroll: false })} />
    </div>
  );
}

function NewIncidentDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const labels = usePrivacyLabels();
  const form = useZodForm(privacyIncidentSchema, { defaultValues: { title: '', description: '', severity: 'MEDIUM', affectedData: '', personalDataInvolved: false } });
  const [detected, setDetected] = React.useState('');
  const personalId = React.useId();
  const detectedId = React.useId();
  React.useEffect(() => {
    if (open) {
      form.reset({ title: '', description: '', severity: 'MEDIUM', affectedData: '', personalDataInvolved: false });
      setDetected(toLocalInput(new Date().toISOString()));
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
            await api.client.post('/privacy/incidents', { ...values, detectedAt: fromLocalInput(detected) ?? undefined });
            toasts.success(t('adm.privacy.incidents.added'), values.title);
            await queryClient.invalidateQueries({ queryKey: admKeys.privacy.all });
            onOpenChange(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('adm.privacy.incidents.addTitle')}</DialogTitle>
            <DialogDescription>{t('adm.privacy.incidents.addText')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="title" label={t('adm.privacy.incidents.titleField')} required>
              {(field) => <Input {...field} autoComplete="off" dir="auto" autoFocus placeholder={t('adm.privacy.incidents.titlePlaceholder')} />}
            </FormField>
            <FormField name="description" label={t('adm.privacy.incidents.description')} required hint={t('adm.privacy.incidents.descriptionHint')}>
              {(field) => <Textarea {...field} rows={4} dir="auto" />}
            </FormField>
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField name="severity" label={t('adm.privacy.incidents.severity')}>
                {(field) => <Select {...field} onValueChange={field.onChange} options={INCIDENT_SEVERITIES.map((s) => ({ value: s, label: labels.severity(s) }))} />}
              </FormField>
              <Field label={t('adm.privacy.incidents.detected')} htmlFor={detectedId}>
                <Input id={detectedId} type="datetime-local" dir="ltr" value={detected} max={toLocalInput(new Date().toISOString())} onChange={(e) => setDetected(e.target.value)} className="tabular" />
              </Field>
            </div>
            <FormField name="affectedData" label={t('adm.privacy.incidents.affected')} optional hint={t('adm.privacy.incidents.affectedHint')}>
              {(field) => <Textarea {...field} rows={2} dir="auto" />}
            </FormField>
            <div className="rounded-lg border p-4">
              <SettingSwitch id={personalId} label={t('adm.privacy.incidents.personal')} description={t('adm.privacy.incidents.personalText')} checked={!!form.watch('personalDataInvolved')} onCheckedChange={(checked) => form.setValue('personalDataInvolved', checked, { shouldDirty: true })} />
            </div>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('adm.privacy.incidents.add')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

/** One incident: where it stands, the facts needed to close it, and the next step. */
function IncidentDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { t, formatDateTime } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const labels = usePrivacyLabels();
  const incident = useQuery({ queryKey: [...admKeys.privacy.incidents, 'detail', id], queryFn: () => api.client.get<IncidentRow>(`/privacy/incidents/${id}`), enabled: !!id });
  const uid = React.useId();
  const [personal, setPersonal] = React.useState(false);
  const [decision, setDecision] = React.useState<keyof typeof DECISION>('undecided');
  const [authority, setAuthority] = React.useState('');
  const [individuals, setIndividuals] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<unknown>(null);

  const i = incident.data;
  React.useEffect(() => {
    if (!i) return;
    setPersonal(i.personalDataInvolved);
    setDecision(i.notificationRequired === null ? 'undecided' : i.notificationRequired ? 'yes' : 'no');
    setAuthority(toLocalInput(i.authorityNotifiedAt));
    setIndividuals(toLocalInput(i.individualsNotifiedAt));
    setNotes(i.resolutionNotes ?? '');
    // Only when the record itself changed: a refetch after a refused step must not wipe the API's explanation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i?.id, i?.updatedAt]);
  React.useEffect(() => setError(null), [id]);

  const facts = () => ({
    personalDataInvolved: personal,
    notificationRequired: DECISION[decision],
    authorityNotifiedAt: fromLocalInput(authority),
    individualsNotifiedAt: fromLocalInput(individuals),
    resolutionNotes: notes.trim() || null,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: admKeys.privacy.all });

  const save = async () => {
    if (!id) return;
    setBusy('save');
    setError(null);
    try {
      await api.client.patch(`/privacy/incidents/${id}`, facts());
      toasts.success(t('adm.privacy.incidents.saved'));
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  /** Moving on first saves the facts on screen, so that closing does not fail on something that was just typed. */
  const move = async (status: string) => {
    if (!id) return;
    setBusy(status);
    setError(null);
    try {
      await api.client.patch(`/privacy/incidents/${id}`, facts());
      await api.client.post(`/privacy/incidents/${id}/status`, { status, resolutionNotes: notes.trim() || undefined });
      toasts.success(t('adm.privacy.incidents.moved'), labels.incidentStatus(status));
    } catch (e) {
      setError(e);
    } finally {
      await refresh();
      setBusy(null);
    }
  };

  const allowed = isApiError(error) ? ((error.details as { allowed?: string[] } | undefined)?.allowed ?? null) : null;
  const stepIndex = i ? INCIDENT_STATUSES.indexOf(i.status as (typeof INCIDENT_STATUSES)[number]) : 0;

  return (
    <Dialog open={!!id} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span dir="auto">{i?.title ?? t('adm.privacy.tabs.incidents')}</span>
            {i ? <Badge tone={SEVERITY_TONE[i.severity] ?? 'neutral'}>{labels.severity(i.severity)}</Badge> : null}
          </DialogTitle>
          <DialogDescription>{i ? t('adm.privacy.incidents.detectedAt', { date: formatDateTime(i.detectedAt) }) : ''}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          {incident.isPending ? (
            <Skeleton className="h-56" />
          ) : incident.isError ? (
            <LoadError error={incident.error} onRetry={() => void incident.refetch()} />
          ) : i ? (
            <>
              <Stepper steps={INCIDENT_STATUSES.map((s) => ({ id: s, label: labels.incidentStatus(s) }))} current={i.status === 'RESOLVED' ? INCIDENT_STATUSES.length : stepIndex} />
              <DescriptionList
                items={[
                  { label: t('adm.privacy.incidents.description'), value: <span className="whitespace-pre-line" dir="auto">{i.description}</span>, wide: true },
                  { label: t('adm.privacy.incidents.affected'), value: i.affectedData ? <span dir="auto">{i.affectedData}</span> : null, wide: true },
                  ...(i.resolvedAt ? [{ label: t('adm.privacy.incidents.resolvedAt'), value: formatDateTime(i.resolvedAt) }] : []),
                ]}
              />

              <section className="space-y-4 rounded-lg border p-4">
                <h3 className="text-md font-semibold">{t('adm.privacy.incidents.factsTitle')}</h3>
                <SettingSwitch id={`${uid}-personal`} label={t('adm.privacy.incidents.personal')} description={t('adm.privacy.incidents.personalText')} checked={personal} onCheckedChange={setPersonal} />
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field label={t('adm.privacy.incidents.notification')} htmlFor={`${uid}-decision`} hint={t('adm.privacy.incidents.notificationHint')} className="sm:col-span-2">
                    <Select
                      id={`${uid}-decision`}
                      className="sm:max-w-sm"
                      value={decision}
                      onValueChange={(v) => setDecision(v as keyof typeof DECISION)}
                      options={[
                        { value: 'undecided', label: t('adm.privacy.incidents.decision.undecided') },
                        { value: 'yes', label: t('adm.privacy.incidents.decision.yes') },
                        { value: 'no', label: t('adm.privacy.incidents.decision.no') },
                      ]}
                    />
                  </Field>
                  <Field label={t('adm.privacy.incidents.authorityAt')} htmlFor={`${uid}-authority`} hint={t('adm.privacy.incidents.notifiedHint')}>
                    <Input id={`${uid}-authority`} type="datetime-local" dir="ltr" value={authority} max={toLocalInput(new Date().toISOString())} onChange={(e) => setAuthority(e.target.value)} className="tabular" />
                  </Field>
                  <Field label={t('adm.privacy.incidents.individualsAt')} htmlFor={`${uid}-individuals`}>
                    <Input id={`${uid}-individuals`} type="datetime-local" dir="ltr" value={individuals} max={toLocalInput(new Date().toISOString())} onChange={(e) => setIndividuals(e.target.value)} className="tabular" />
                  </Field>
                </div>
                <Field label={t('adm.privacy.incidents.resolution')} htmlFor={`${uid}-notes`} hint={t('adm.privacy.incidents.resolutionHint')}>
                  <Textarea id={`${uid}-notes`} value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} dir="auto" maxLength={5000} />
                </Field>
                <p className="text-sm text-muted-foreground">{t('adm.privacy.incidents.recordOnly')}</p>
              </section>

              <ActionError error={error} />
              {allowed?.length ? <Alert tone="info">{t('adm.privacy.incidents.allowedNext', { steps: allowed.map((s) => labels.incidentStatus(s)).join(', ') })}</Alert> : null}
            </>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={!!busy}>
            {t('common.close')}
          </Button>
          {i ? (
            <>
              <Button variant="outline" loading={busy === 'save'} disabled={!!busy} onClick={() => void save()}>
                {t('common.save')}
              </Button>
              {(NEXT[i.status] ?? []).map((status, n) => (
                <Button key={status} variant={n === 0 && i.status !== 'RESOLVED' ? 'default' : 'outline'} loading={busy === status} disabled={!!busy} onClick={() => void move(status)}>
                  {t(`adm.privacy.incidents.moveTo.${i.status === 'RESOLVED' || (i.status === 'CONTAINED' && status === 'INVESTIGATING') ? 'REOPEN' : status}`)}
                </Button>
              ))}
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
