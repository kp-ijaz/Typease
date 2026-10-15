'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, PauseCircle, PlayCircle, Plus, Send, X } from 'lucide-react';
import { Alert, Badge, Button, DatePicker, Label, Switch, useApiClient, useErrorMessage, useI18n, useSession, useToast } from '@typease/ui';
import { Money, Section } from './shared';

interface ReminderHistory {
  enabled: boolean;
  pausedUntil: string | null;
  next: { stage: number; date: string } | null;
  reminders: Array<{ id: string; automatic: boolean; stage: number | null; daysOverdue: number; amount: string; currency: string; createdAt: string }>;
}
interface ReminderSettings {
  enabled: boolean;
  days: number[];
}

const key = (invoiceId: string) => ['fin', 'invoice-reminders', invoiceId] as const;
const SETTINGS_KEY = ['fin', 'invoice-reminder-settings'] as const;

/** "On the due date", "3 days late", "2 days before the due date". */
function useStageLabel() {
  const { t, tn } = useI18n();
  return (days: number) => (days === 0 ? t('fin.reminders.onDueDate') : days > 0 ? tn('fin.reminders.daysLate', days) : tn('fin.reminders.daysBefore', -days));
}

/** Payment reminders of one invoice: what was sent, what comes next, send now, pause until a promised date. */
export function InvoiceRemindersCard({ invoiceId, payable }: { invoiceId: string; payable: boolean }) {
  const { t, formatDate, formatDateTime } = useI18n();
  const client = useApiClient();
  const session = useSession();
  const queryClient = useQueryClient();
  const toasts = useToast();
  const describe = useErrorMessage();
  const stageLabel = useStageLabel();
  const canAct = session.hasAnyPermission(['invoice.manage', 'payment.record']);
  const history = useQuery({ queryKey: key(invoiceId), queryFn: () => client.get<ReminderHistory>(`/invoices/${invoiceId}/reminders`) });
  const [pauseUntil, setPauseUntil] = React.useState('');
  const refresh = () => void queryClient.invalidateQueries({ queryKey: key(invoiceId) });
  const send = useMutation({
    mutationFn: () => client.post(`/invoices/${invoiceId}/reminders`),
    onSuccess: () => {
      toasts.success(t('fin.reminders.sent'));
      refresh();
    },
    onError: (e) => toasts.error(e),
  });
  const pause = useMutation({
    mutationFn: (until: string | null) => client.put(`/invoices/${invoiceId}/reminders/pause`, { until }),
    onSuccess: () => {
      setPauseUntil('');
      refresh();
    },
  });

  const h = history.data;
  return (
    <Section title={t('fin.reminders.title')} description={t('fin.reminders.description')}>
      {!h ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : (
        <div className="space-y-4">
          <div className="space-y-1 text-sm">
            {!h.enabled ? (
              <p className="text-muted-foreground">{t('fin.reminders.off')}</p>
            ) : h.pausedUntil ? (
              <p className="flex items-center gap-1.5 text-warning-text">
                <PauseCircle aria-hidden="true" className="size-4" />
                {t('fin.reminders.pausedUntil', { date: formatDate(h.pausedUntil) })}
              </p>
            ) : h.next && payable ? (
              <p className="flex items-center gap-1.5">
                <BellRing aria-hidden="true" className="size-4 text-secondary-text" />
                {t('fin.reminders.next', { date: formatDate(h.next.date), stage: stageLabel(h.next.stage) })}
              </p>
            ) : payable ? (
              <p className="text-muted-foreground">{t('fin.reminders.noMore')}</p>
            ) : null}
          </div>

          {h.reminders.length ? (
            <ul className="divide-y rounded-md border text-sm">
              {h.reminders.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="min-w-0">
                    <span className="block font-medium">{r.automatic && r.stage !== null ? stageLabel(r.stage) : t('fin.reminders.manual')}</span>
                    <span className="block text-xs text-muted-foreground">{formatDateTime(r.createdAt)}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <Money amount={r.amount} currency={r.currency} />
                    {r.automatic ? <Badge tone="neutral">{t('fin.reminders.auto')}</Badge> : <Badge tone="brand">{t('fin.reminders.byStaff')}</Badge>}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t('fin.reminders.none')}</p>
          )}

          {canAct && payable ? (
            <div className="space-y-3 border-t pt-4">
              <Button variant="outline" className="w-full" onClick={() => send.mutate()} loading={send.isPending}>
                <Send aria-hidden="true" />
                {t('fin.reminders.sendNow')}
              </Button>
              {h.pausedUntil ? (
                <Button variant="ghost" className="w-full" onClick={() => pause.mutate(null)} loading={pause.isPending}>
                  <PlayCircle aria-hidden="true" />
                  {t('fin.reminders.resume')}
                </Button>
              ) : (
                <div className="space-y-1.5">
                  <Label htmlFor={`pause-${invoiceId}`}>{t('fin.reminders.pauseLabel')}</Label>
                  <div className="flex gap-2">
                    <DatePicker id={`pause-${invoiceId}`} value={pauseUntil} onChange={setPauseUntil} className="min-w-0 flex-1" />
                    <Button variant="outline" disabled={!pauseUntil} loading={pause.isPending} onClick={() => pause.mutate(pauseUntil)}>
                      <PauseCircle aria-hidden="true" />
                      {t('fin.reminders.pause')}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t('fin.reminders.pauseHint')}</p>
                </div>
              )}
              {pause.error ? <Alert tone="danger">{describe(pause.error)}</Alert> : null}
            </div>
          ) : null}
        </div>
      )}
    </Section>
  );
}

const SUGGESTED_DAYS = [-3, -1, 0, 1, 3, 5, 7, 10, 14, 21, 30];

/** Finance settings: automatic reminders on or off, and the days relative to the due date. */
export function InvoiceReminderSettingsCard() {
  const { t } = useI18n();
  const client = useApiClient();
  const session = useSession();
  const queryClient = useQueryClient();
  const toasts = useToast();
  const describe = useErrorMessage();
  const stageLabel = useStageLabel();
  const editable = session.hasPermission('finance.settings');
  const settings = useQuery({ queryKey: SETTINGS_KEY, queryFn: () => client.get<ReminderSettings>('/finance/invoice-reminders') });
  const [days, setDays] = React.useState<number[] | null>(null);
  const save = useMutation({
    mutationFn: (body: Partial<ReminderSettings>) => client.put<ReminderSettings>('/finance/invoice-reminders', body),
    onSuccess: (next) => {
      queryClient.setQueryData(SETTINGS_KEY, next);
      setDays(null);
      toasts.success(t('form.saved'));
    },
  });
  if (!settings.data) return null;
  const current = days ?? settings.data.days;
  const toggle = (d: number) => setDays(current.includes(d) ? current.filter((x) => x !== d) : [...current, d].sort((a, b) => a - b));
  return (
    <Section title={t('fin.reminders.settingsTitle')} description={t('fin.reminders.settingsText')} className="mt-8">
      <div className="space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <Label htmlFor="auto-reminders">{t('fin.reminders.enabled')}</Label>
            <p className="text-sm text-muted-foreground">{t('fin.reminders.enabledHint')}</p>
          </div>
          <Switch id="auto-reminders" checked={settings.data.enabled} disabled={!editable || save.isPending} onCheckedChange={(v) => save.mutate({ enabled: v })} />
        </div>
        <fieldset disabled={!editable || !settings.data.enabled} className="space-y-3">
          <legend className="text-sm font-medium">{t('fin.reminders.daysLabel')}</legend>
          <div className="flex flex-wrap gap-2">
            {[...new Set([...SUGGESTED_DAYS, ...current])].sort((a, b) => a - b).map((d) => {
              const on = current.includes(d);
              return (
                <Button key={d} type="button" size="sm" variant={on ? 'subtle' : 'outline'} aria-pressed={on} onClick={() => toggle(d)}>
                  {on ? <X aria-hidden="true" /> : <Plus aria-hidden="true" />}
                  {stageLabel(d)}
                </Button>
              );
            })}
          </div>
          {days !== null ? (
            <Button onClick={() => save.mutate({ days: current })} loading={save.isPending} disabled={current.length === 0}>
              {t('common.save')}
            </Button>
          ) : null}
        </fieldset>
        {save.error ? <Alert tone="danger">{describe(save.error)}</Alert> : null}
      </div>
    </Section>
  );
}
