'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, RotateCcw } from 'lucide-react';
import { fieldErrorsOf } from '@typease/api-client';
import { templateOverrideSchema } from '@typease/validation';
import { Alert, Badge, Button, Card, Combobox, ConfirmDialog, Input, Select, Skeleton, Textarea, cn, localiseValidationMessage, useApi, useErrorMessage, useI18n, useToast } from '@typease/ui';
import { Field, Loadable, Panel, useRun, useUrlState } from '@/components/ops/common';
import type { NotificationChannel, NotificationEvent, TemplatePreview, TemplateRow } from '@/components/ops/types';
import { opsKeys } from '@/lib/keys/ops';
import { CHANNELS, useEventLabel } from './settings-page';

const WITH_SUBJECT: NotificationChannel[] = ['EMAIL', 'IN_APP', 'PUSH'];

/**
 * The wording of every message, per event, channel and language. What is shown is the
 * effective template: the centre's own wording when there is one, otherwise the TypEase default.
 */
export function TemplatesTab() {
  const { t } = useI18n();
  const api = useApi();
  const eventLabel = useEventLabel();
  const [eventKey, setEventKey] = useUrlState('event', 'request.completed');
  const [channel, setChannel] = useUrlState('channel', 'EMAIL');
  const [language, setLanguage] = useUrlState('lang', 'en');
  const events = useQuery({ queryKey: opsKeys.notifications.events, queryFn: () => api.client.get<NotificationEvent[]>('/notifications/events'), staleTime: 10 * 60_000 });
  const templates = useQuery({ queryKey: opsKeys.notifications.templates(eventKey), queryFn: () => api.client.get<TemplateRow[]>('/notifications/templates', { query: { eventKey } }), enabled: !!eventKey });

  const rows = templates.data ?? [];
  const available = CHANNELS.filter((c) => rows.some((r) => r.channel === c));
  const activeChannel = (available.includes(channel as NotificationChannel) ? channel : available[0]) as NotificationChannel | undefined;
  const row = rows.find((r) => r.channel === activeChannel && r.language === language) ?? rows.find((r) => r.channel === activeChannel);
  const event = (events.data ?? []).find((e) => e.eventKey === eventKey);

  return (
    <div className="space-y-4">
      <Card className="grid grid-cols-1 gap-4 p-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] md:items-end">
        <Field label={t('ops.notify.templates.event')}>
          {(p) => (
            <Combobox
              {...p}
              value={eventKey}
              onValueChange={(v) => v && setEventKey(v)}
              options={(events.data ?? []).map((e) => ({ value: e.eventKey, label: eventLabel(e.eventKey, e.label), description: e.eventKey, keywords: [e.label] }))}
              selectedLabel={eventLabel(eventKey)}
            />
          )}
        </Field>
        <Field label={t('ops.notify.templates.channel')}>
          {(p) => <Select {...p} value={activeChannel ?? null} onValueChange={setChannel} disabled={!available.length} options={available.map((c) => ({ value: c, label: t(`ops.notify.channelNames.${c}`) }))} />}
        </Field>
        <div role="group" aria-label={t('ops.notify.templates.language')} className="inline-flex h-10 rounded-md border bg-card p-0.5">
          {(['en', 'ar'] as const).map((l) => (
            <button
              key={l}
              type="button"
              aria-pressed={language === l}
              onClick={() => setLanguage(l)}
              className={cn('rounded-sm px-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring', language === l ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground hover:text-foreground')}
            >
              {l === 'en' ? 'English' : 'العربية'}
            </button>
          ))}
        </div>
      </Card>

      <Loadable query={templates} skeleton={<Skeleton className="h-96 w-full" />}>
        {() =>
          row ? (
            <TemplateEditor key={`${row.eventKey}-${row.channel}-${row.language}-${row.source}`} row={row} variables={event?.variables ?? row.variables.map((name) => ({ name, description: '' }))} />
          ) : (
            <Alert tone="info">{t('ops.notify.templates.none')}</Alert>
          )
        }
      </Loadable>
    </div>
  );
}

function TemplateEditor({ row, variables }: { row: TemplateRow; variables: Array<{ name: string; description: string }> }) {
  const i18n = useI18n();
  const { t } = i18n;
  const api = useApi();
  const toasts = useToast();
  const describe = useErrorMessage();
  const queryClient = useQueryClient();
  const { run } = useRun();
  const eventLabel = useEventLabel();
  const withSubject = WITH_SUBJECT.includes(row.channel);
  const [subject, setSubject] = React.useState(row.subject ?? '');
  const [body, setBody] = React.useState(row.body);
  const [whatsapp, setWhatsapp] = React.useState(row.whatsappTemplateName ?? '');
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [failure, setFailure] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [previewing, setPreviewing] = React.useState(false);
  const [preview, setPreview] = React.useState<TemplatePreview | null>(null);
  const [resetting, setResetting] = React.useState(false);
  const [unknown, setUnknown] = React.useState<string[]>([]);
  const bodyRef = React.useRef<HTMLTextAreaElement>(null);
  const path = `/notifications/templates/${encodeURIComponent(row.eventKey)}/${row.channel}/${row.language}`;
  const dirty = subject !== (row.subject ?? '') || body !== row.body || whatsapp !== (row.whatsappTemplateName ?? '');
  const rtl = row.language === 'ar';

  const insert = (name: string) => {
    const el = bodyRef.current;
    const token = `{{${name}}}`;
    if (!el) return setBody((b) => `${b}${token}`);
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    setBody(`${body.slice(0, start)}${token}${body.slice(end)}`);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const showPreview = async () => {
    setPreviewing(true);
    setFailure(null);
    try {
      setPreview(await api.client.post<TemplatePreview>('/notifications/templates/preview', { eventKey: row.eventKey, channel: row.channel, language: row.language, subject: withSubject ? subject || undefined : undefined, body }));
    } catch (error) {
      setFailure(describe(error));
    } finally {
      setPreviewing(false);
    }
  };

  const save = async () => {
    setFailure(null);
    // The same rules as the API: a body, a subject for email, a valid WhatsApp template name.
    const parsed = templateOverrideSchema.safeParse({ subject: withSubject ? subject : undefined, body, whatsappTemplateName: row.channel === 'WHATSAPP' && whatsapp ? whatsapp : undefined });
    const found: Record<string, string> = {};
    if (!parsed.success) for (const issue of parsed.error.issues) found[String(issue.path[0])] ??= localiseValidationMessage(issue.message, i18n);
    if (row.channel === 'EMAIL' && !subject.trim()) found.subject = t('validation.required');
    setErrors(found);
    if (Object.keys(found).length || !parsed.success) return;
    setSaving(true);
    try {
      const saved = await api.client.put<{ unknownVariables?: string[] }>(path, parsed.data);
      setUnknown(saved.unknownVariables ?? []);
      toasts.success(t('ops.notify.templates.saved'), t('ops.notify.templates.savedText'));
      await queryClient.invalidateQueries({ queryKey: opsKeys.notifications.templates(row.eventKey) });
    } catch (error) {
      const fields = fieldErrorsOf(error);
      if (Object.keys(fields).length) setErrors(Object.fromEntries(Object.entries(fields).map(([k, m]) => [k, localiseValidationMessage(m, i18n)])));
      else setFailure(describe(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
      <Panel
        title={`${eventLabel(row.eventKey, row.label)} · ${t(`ops.notify.channelNames.${row.channel}`)}`}
        description={t(row.source === 'TENANT' ? 'ops.notify.templates.sourceOwnText' : 'ops.notify.templates.sourceDefaultText')}
        action={<Badge tone={row.source === 'TENANT' ? 'brand' : 'neutral'}>{t(row.source === 'TENANT' ? 'ops.notify.templates.sourceOwn' : 'ops.notify.templates.sourceDefault')}</Badge>}
      >
        <div className="space-y-5">
          {row.enabled ? null : <Alert tone="warning">{t('ops.notify.templates.disabledNote')}</Alert>}
          {withSubject ? (
            <Field label={t('ops.notify.templates.subject')} required={row.channel === 'EMAIL'} error={errors.subject}>
              {(p) => <Input {...p} value={subject} onChange={(e) => setSubject(e.target.value)} dir={rtl ? 'rtl' : 'ltr'} lang={row.language} maxLength={200} />}
            </Field>
          ) : null}
          <Field label={t('ops.notify.templates.body')} required error={errors.body} hint={t('ops.notify.templates.bodyHint')}>
            {(p) => <Textarea {...p} ref={bodyRef} value={body} onChange={(e) => setBody(e.target.value)} rows={row.channel === 'EMAIL' ? 12 : 5} dir={rtl ? 'rtl' : 'ltr'} lang={row.language} className="font-mono text-sm leading-6" />}
          </Field>
          {row.channel === 'WHATSAPP' ? (
            <Field label={t('ops.notify.templates.whatsappName')} error={errors.whatsappTemplateName} hint={t('ops.notify.templates.whatsappHint')}>
              {(p) => <Input {...p} value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} dir="ltr" className="font-mono text-sm" spellCheck={false} placeholder="request_completed_v1" />}
            </Field>
          ) : null}

          <div>
            <p className="text-sm font-medium">{t('ops.notify.templates.variables')}</p>
            <p className="text-sm text-muted-foreground">{t('ops.notify.templates.variablesHint')}</p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {variables.map((v) => (
                <li key={v.name}>
                  <button type="button" onClick={() => insert(v.name)} title={v.description || undefined} className="ltr-value rounded-md border bg-muted/50 px-2 py-1 font-mono text-xs text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
                    {`{{${v.name}}}`}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {unknown.length ? <Alert tone="warning">{t('ops.notify.templates.unknownVariables', { list: unknown.join(', ') })}</Alert> : null}
          {failure ? (
            <Alert tone="danger" live>
              {failure}
            </Alert>
          ) : null}

          <div className="flex flex-wrap justify-end gap-2">
            {row.source === 'TENANT' ? (
              <Button variant="destructive-outline" onClick={() => setResetting(true)}>
                <RotateCcw aria-hidden="true" />
                {t('ops.notify.templates.reset')}
              </Button>
            ) : null}
            <Button variant="outline" loading={previewing} loadingText={t('common.loading')} onClick={() => void showPreview()}>
              <Eye aria-hidden="true" />
              {t('ops.notify.templates.preview')}
            </Button>
            <Button disabled={!dirty} loading={saving} loadingText={t('common.saving')} onClick={() => void save()}>
              {t('common.saveChanges')}
            </Button>
          </div>
        </div>
      </Panel>

      <Panel title={t('ops.notify.templates.previewTitle')} description={t('ops.notify.templates.previewText')}>
        {preview ? (
          <PreviewPane preview={preview} channel={row.channel} rtl={rtl} />
        ) : (
          <p className="text-sm text-muted-foreground">{t('ops.notify.templates.previewEmpty')}</p>
        )}
      </Panel>

      <ConfirmDialog
        open={resetting}
        onOpenChange={setResetting}
        title={t('ops.notify.templates.resetTitle')}
        description={t('ops.notify.templates.resetText')}
        confirmLabel={t('ops.notify.templates.reset')}
        onConfirm={async () => {
          await run('reset', () => api.client.delete(path), { success: t('ops.notify.templates.resetDone'), invalidate: [opsKeys.notifications.templates(row.eventKey)], rethrow: true });
        }}
      />
    </div>
  );
}

function PreviewPane({ preview, channel, rtl }: { preview: TemplatePreview; channel: NotificationChannel; rtl: boolean }) {
  const { t } = useI18n();
  // The branded email is a complete HTML page: shown in a sandboxed frame from an in-memory blob (no scripts run).
  const [frame, setFrame] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!preview.html) return setFrame(null);
    const url = URL.createObjectURL(new Blob([preview.html], { type: 'text/html' }));
    setFrame(url);
    return () => URL.revokeObjectURL(url);
  }, [preview.html]);
  return (
    <div className="space-y-4">
      {preview.unknownVariables.length ? <Alert tone="warning">{t('ops.notify.templates.unknownVariables', { list: preview.unknownVariables.join(', ') })}</Alert> : null}
      {preview.subject ? (
        <div>
          <p className="text-sm text-muted-foreground">{t('ops.notify.templates.subject')}</p>
          <p className="font-medium" dir={rtl ? 'rtl' : 'ltr'}>
            {preview.subject}
          </p>
        </div>
      ) : null}
      {channel === 'EMAIL' && frame ? (
        <iframe title={t('ops.notify.templates.previewTitle')} src={frame} sandbox="" className="h-[32rem] w-full rounded-md border bg-white" />
      ) : (
        <p className="whitespace-pre-wrap rounded-md border bg-muted/40 p-4 text-base" dir={rtl ? 'rtl' : 'ltr'}>
          {preview.text}
        </p>
      )}
      {preview.whatsappParameters?.length ? (
        <div>
          <p className="text-sm text-muted-foreground">{t('ops.notify.templates.whatsappParameters')}</p>
          <ol className="mt-1 list-decimal space-y-0.5 ps-5 text-sm">
            {preview.whatsappParameters.map((p, i) => (
              <li key={i}>
                {typeof p === 'string' ? (
                  p
                ) : (
                  <>
                    <span className="ltr-value font-mono text-xs text-muted-foreground">{`{{${p.name}}}`}</span> <bdi>{p.value}</bdi>
                  </>
                )}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      <p className="text-sm text-muted-foreground">{t('ops.notify.templates.sampleNote')}</p>
    </div>
  );
}
