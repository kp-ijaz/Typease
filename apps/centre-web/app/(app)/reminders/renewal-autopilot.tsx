'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Send, Sparkles } from 'lucide-react';
import { Alert, Badge, Button, Card, Input, Label, Select, Switch, useApi, useErrorMessage, useI18n, useSession, useToast } from '@typease/ui';
import { useDocumentTypes, useServiceOptions } from '@/components/pickers';

interface Autopilot {
  enabled: boolean;
  daysBefore: number;
  services: Record<string, string>;
  candidates: Array<{ id: string; subjectLabel: string; documentTypeKey: string; expiryDate: string; customerName: string | null }>;
}
const KEY = ['reminders', 'autopilot'] as const;
const NONE = '__none__';

/** Renewal autopilot: on/off, the window, which service renews which document type, and what is due today. */
export function RenewalAutopilotCard() {
  const { t, pick, formatDate } = useI18n();
  const api = useApi();
  const session = useSession();
  const queryClient = useQueryClient();
  const toasts = useToast();
  const describe = useErrorMessage();
  const editable = session.hasPermission('reminder.manage');
  const types = useDocumentTypes();
  const services = useServiceOptions(editable);
  const data = useQuery({ queryKey: KEY, queryFn: () => api.client.get<Autopilot>('/renewals/autopilot') });
  const [days, setDays] = React.useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: Partial<{ enabled: boolean; daysBefore: number; services: Record<string, string | null> }>) => api.client.put('/renewals/autopilot', body),
    onSuccess: () => {
      setDays(null);
      void queryClient.invalidateQueries({ queryKey: KEY });
    },
  });
  const run = useMutation({
    mutationFn: () => api.client.post<{ offered: number; failed: Array<{ reason: string }> }>('/renewals/autopilot/run'),
    onSuccess: (r) => {
      (r.failed.length ? toasts.error : toasts.success)(t('ops.reminders.autopilot.ran', { offered: r.offered, failed: r.failed.length }));
      void queryClient.invalidateQueries({ queryKey: KEY });
      void queryClient.invalidateQueries({ queryKey: ['reminders'] });
    },
    onError: (e) => toasts.error(e),
  });
  const a = data.data;
  if (!a) return null;
  const expiring = (types.data ?? []).filter((d) => d.isActive && d.hasExpiry);
  const serviceOptions = [{ value: NONE, label: t('ops.reminders.autopilot.noService') }, ...(services.data ?? []).filter((s) => s.isActive).map((s) => ({ value: s.id, label: pick(s.name, s.nameAr) }))];
  return (
    <Card className="mb-4 space-y-5 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h2 className="flex items-center gap-2 text-md font-semibold">
            <Sparkles aria-hidden="true" className="size-4 text-secondary-text" />
            {t('ops.reminders.autopilot.title')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('ops.reminders.autopilot.description')}</p>
        </div>
        <div className="flex items-center gap-3">
          <Label htmlFor="autopilot-on" className="text-sm">
            {t('ops.reminders.autopilot.enabled')}
            <span className="block text-xs font-normal text-muted-foreground">{t('ops.reminders.autopilot.enabledHint')}</span>
          </Label>
          <Switch id="autopilot-on" checked={a.enabled} disabled={!editable || save.isPending} onCheckedChange={(v) => save.mutate({ enabled: v })} />
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
        <fieldset disabled={!editable} className="space-y-3">
          <legend className="text-sm font-medium">{t('ops.reminders.autopilot.mapping')}</legend>
          <p className="text-xs text-muted-foreground">{t('ops.reminders.autopilot.mappingHint')}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {expiring.map((d) => (
              <div key={d.key} className="space-y-1">
                <Label htmlFor={`map-${d.key}`} className="text-xs text-muted-foreground">
                  {pick(d.name, d.nameAr)}
                </Label>
                <Select id={`map-${d.key}`} size="sm" value={a.services[d.key] ?? NONE} options={serviceOptions} onValueChange={(v) => save.mutate({ services: { [d.key]: v === NONE ? null : v } })} />
              </div>
            ))}
          </div>
          <div className="flex items-end gap-2 pt-1">
            <div className="space-y-1">
              <Label htmlFor="autopilot-days">{t('ops.reminders.autopilot.daysBefore')}</Label>
              <Input id="autopilot-days" inputMode="numeric" className="w-28" value={days ?? String(a.daysBefore)} onChange={(e) => setDays(e.target.value.replace(/\D/g, '').slice(0, 3))} />
            </div>
            {days !== null && Number(days) >= 1 && Number(days) <= 120 && Number(days) !== a.daysBefore ? (
              <Button variant="outline" loading={save.isPending} onClick={() => save.mutate({ daysBefore: Number(days) })}>
                {t('common.save')}
              </Button>
            ) : null}
          </div>
          {save.error ? <Alert tone="danger">{describe(save.error)}</Alert> : null}
        </fieldset>

        <section aria-labelledby="autopilot-due" className="space-y-2 rounded-lg border bg-muted/30 p-3">
          <h3 id="autopilot-due" className="flex items-center justify-between text-sm font-semibold">
            {t('ops.reminders.autopilot.due')}
            <Badge tone={a.candidates.length ? 'warning' : 'neutral'}>{a.candidates.length}</Badge>
          </h3>
          {a.candidates.length ? (
            <ul className="max-h-48 space-y-1.5 overflow-y-auto text-sm">
              {a.candidates.map((c) => (
                <li key={c.id} className="min-w-0">
                  <span className="block truncate font-medium">{c.customerName ?? c.subjectLabel}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {c.subjectLabel} · {t('ops.reminders.autopilot.expires', { date: formatDate(c.expiryDate) })}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t('ops.reminders.autopilot.dueEmpty')}</p>
          )}
          {session.hasAnyPermission(['reminder.manage', 'quotation.manage']) ? (
            <Button className="w-full" size="sm" disabled={!a.enabled || !a.candidates.length} loading={run.isPending} onClick={() => run.mutate()}>
              <Send aria-hidden="true" />
              {t('ops.reminders.autopilot.runNow')}
            </Button>
          ) : null}
        </section>
      </div>
    </Card>
  );
}
