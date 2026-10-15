'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, KeyRound, PlugZap, Trash2, XCircle } from 'lucide-react';
import { isApiError } from '@typease/api-client';
import {
  Alert, Badge, Button, ConfirmDialog, CopyButton, DatePicker, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, PasswordInput,
  PhoneInput, Select, Switch, Textarea, useApi, useI18n, useToast, type Tone,
} from '@typease/ui';
import { admKeys } from '@/lib/keys/adm';
import { ActionError, Field, useApiMessage } from './shared';
import type { IntegrationField, IntegrationProvider, IntegrationRow, IntegrationTestResult } from './types';

export interface IntegrationState {
  tone: Tone;
  /** Dictionary key of the status label. */
  labelKey: string;
}

/** One status word per card: the review state for authorisation records, the switch state for connections. */
export function integrationState(row: IntegrationRow | null | undefined): IntegrationState {
  if (!row) return { tone: 'neutral', labelKey: 'adm.integrations.status.NONE' };
  if (row.authorisation) {
    if (row.authorisation.expired) return { tone: 'danger', labelKey: 'adm.integrations.status.EXPIRED' };
    if (row.authorisation.state === 'PENDING') return { tone: 'warning', labelKey: 'adm.integrations.status.PENDING' };
    if (row.authorisation.state === 'REJECTED') return { tone: 'danger', labelKey: 'adm.integrations.status.REJECTED' };
    return row.status === 'ACTIVE' ? { tone: 'success', labelKey: 'adm.integrations.status.VERIFIED_ACTIVE' } : { tone: 'neutral', labelKey: 'adm.integrations.status.VERIFIED_OFF' };
  }
  if (row.status === 'ACTIVE') return { tone: 'success', labelKey: 'adm.integrations.status.ACTIVE' };
  if (row.status === 'CONFIGURED') return { tone: 'info', labelKey: 'adm.integrations.status.CONFIGURED' };
  if (row.status === 'ERROR') return { tone: 'danger', labelKey: 'adm.integrations.status.ERROR' };
  return { tone: 'neutral', labelKey: 'adm.integrations.status.DISABLED' };
}

type Values = Record<string, unknown>;
const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (typeof v === 'object' && Object.values(v as object).every((x) => x === '' || x == null));

/** A non-secret setting, rendered from the provider's field definition. */
function ConfigInput({ field, value, onChange, id, invalid }: { field: IntegrationField; value: unknown; onChange: (value: unknown) => void; id: string; invalid?: boolean }) {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  switch (field.type) {
    case 'boolean':
      return <Switch id={id} checked={value === true} onCheckedChange={onChange} />;
    case 'text':
      return <Textarea id={id} value={text} onChange={(e) => onChange(e.target.value)} maxLength={field.maxLength ?? undefined} rows={3} dir="auto" aria-invalid={invalid} />;
    case 'json':
      return <Textarea id={id} value={text} onChange={(e) => onChange(e.target.value)} rows={4} dir="ltr" spellCheck={false} className="font-mono text-sm" aria-invalid={invalid} />;
    case 'number':
      return <Input id={id} value={text} onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, ''))} inputMode="numeric" placeholder={field.example ?? undefined} dir="ltr" className="tabular sm:max-w-40" aria-invalid={invalid} autoComplete="off" />;
    case 'date':
      return <DatePicker id={id} value={text} onChange={onChange} aria-invalid={invalid} className="sm:max-w-52" />;
    case 'phone':
      return <PhoneInput id={id} value={text} onChange={onChange} aria-invalid={invalid} />;
    case 'languageCodes': {
      const codes = (value && typeof value === 'object' ? value : {}) as Record<string, string>;
      return (
        <div className="grid grid-cols-2 gap-3" dir="ltr">
          {(['en', 'ar'] as const).map((lang) => (
            <Input key={lang} id={lang === 'en' ? id : undefined} value={codes[lang] ?? ''} onChange={(e) => onChange({ ...codes, [lang]: e.target.value.trim() })} placeholder={lang} aria-label={`${field.label} (${lang})`} autoComplete="off" startAdornment={<span className="text-xs font-medium uppercase">{lang}</span>} />
          ))}
        </div>
      );
    }
    default:
      return (
        <Input
          id={id}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          type={field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : 'text'}
          inputMode={field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : undefined}
          maxLength={field.maxLength ?? undefined}
          placeholder={field.example ?? undefined}
          dir={field.type === 'string' ? 'auto' : 'ltr'}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={invalid}
        />
      );
  }
}

/** Turns the form state into the `config` object the API expects (empty values left out, numbers as numbers). */
function buildConfig(provider: IntegrationProvider, values: Values): Values {
  const config: Values = {};
  for (const field of provider.configFields) {
    const v = values[field.key];
    if (field.type === 'boolean') {
      if (typeof v === 'boolean') config[field.key] = v;
    } else if (isEmpty(v)) continue;
    else if (field.type === 'number') config[field.key] = Number(v);
    else if (field.type === 'languageCodes') config[field.key] = Object.fromEntries(Object.entries(v as Record<string, string>).filter(([, x]) => x));
    else config[field.key] = typeof v === 'string' ? v.trim() : v;
  }
  return config;
}

/**
 * Set up or manage one integration. The form is generated from the provider's field definitions:
 *  - settings (not secret) are shown and can be edited;
 *  - credentials are write-only: a stored value is never displayed, only "saved on <date>";
 *  - authorisation records (partner / government) hold no credentials at all and are reviewed by TypEase.
 */
export function IntegrationDialog({ provider, row, onClose }: { provider: IntegrationProvider | null; row: IntegrationRow | null; onClose: () => void }) {
  const { t, formatDateTime, formatDate } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const message = useApiMessage();
  const queryClient = useQueryClient();
  const id = React.useId();
  const [current, setCurrent] = React.useState<IntegrationRow | null>(row);
  const [name, setName] = React.useState('');
  const [mode, setMode] = React.useState<'TEST' | 'LIVE'>('TEST');
  const [values, setValues] = React.useState<Values>({});
  const [secrets, setSecrets] = React.useState<Record<string, string>>({});
  const [removeSecrets, setRemoveSecrets] = React.useState<string[]>([]);
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState<'save' | 'test' | 'toggle' | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [fieldError, setFieldError] = React.useState<string | null>(null);
  const [touched, setTouched] = React.useState(false);
  const [test, setTest] = React.useState<IntegrationTestResult | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [deleteError, setDeleteError] = React.useState<unknown>(null);

  const load = React.useCallback(
    (next: IntegrationRow | null) => {
      setCurrent(next);
      setName(next?.name ?? '');
      setMode(next?.mode ?? (provider?.modes.includes('TEST') ? 'TEST' : 'LIVE'));
      setValues({ ...(next?.config ?? {}) });
      setSecrets({});
      setRemoveSecrets([]);
      setNote(next?.authorisation?.note ?? '');
      setError(null);
      setFieldError(null);
      setTouched(false);
    },
    [provider],
  );
  React.useEffect(() => {
    if (provider) {
      load(row);
      setTest(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, row?.id]);

  if (!provider) return null;
  const record = provider.kind === 'AUTHORISATION_RECORD';
  const state = integrationState(current);
  const missingRequired = provider.configFields.filter((f) => f.required && f.type !== 'boolean' && isEmpty(values[f.key]));
  const noteTooShort = record && note.trim().length < 10;
  const refresh = () => queryClient.invalidateQueries({ queryKey: admKeys.integrations.all });

  const fail = (e: unknown) => {
    setError(e);
    const field = isApiError(e) ? (e.details as { field?: string } | undefined)?.field : undefined;
    setFieldError(typeof field === 'string' ? field : null);
  };

  const save = async () => {
    setTouched(true);
    if (missingRequired.length || noteTooShort) return;
    setBusy('save');
    setError(null);
    setFieldError(null);
    try {
      const config = buildConfig(provider, values);
      const typed = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v.trim() !== ''));
      let saved: IntegrationRow;
      if (current) {
        saved = await api.client.patch<IntegrationRow>(`/integrations/${current.id}`, { name: name.trim() || undefined, ...(provider.modes.length > 1 ? { mode } : {}), config, ...(record ? { authorisationNote: note.trim() } : {}) });
        const change: Record<string, string | null> = { ...typed, ...Object.fromEntries(removeSecrets.filter((k) => !(k in typed)).map((k) => [k, null])) };
        if (Object.keys(change).length) saved = await api.client.put<IntegrationRow>(`/integrations/${current.id}/secrets`, { secrets: change });
        toasts.success(t('adm.integrations.saved'), saved.name);
      } else {
        saved = await api.client.post<IntegrationRow>('/integrations', {
          category: provider.category,
          provider: provider.provider,
          name: name.trim() || undefined,
          mode,
          config,
          ...(Object.keys(typed).length ? { secrets: typed } : {}),
          ...(record ? { authorisationNote: note.trim() } : {}),
        });
        toasts.success(record ? t('adm.integrations.recordSubmitted') : t('adm.integrations.added'), saved.name);
      }
      await refresh();
      load(saved);
      setTest(null);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const toggle = async () => {
    if (!current) return;
    setBusy('toggle');
    setError(null);
    try {
      if (current.status === 'ACTIVE') {
        const saved = await api.client.post<IntegrationRow>(`/integrations/${current.id}/disable`);
        toasts.success(t('adm.integrations.disabled'), saved.name);
        load(saved);
      } else {
        const saved = await api.client.post<IntegrationRow & { switchedOff?: Array<{ id: string; name: string }> }>(`/integrations/${current.id}/enable`);
        toasts.success(t('adm.integrations.enabled'), saved.switchedOff?.length ? t('adm.integrations.switchedOff', { names: saved.switchedOff.map((s) => s.name).join(', ') }) : saved.name);
        load(saved);
      }
      await refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const runTest = async () => {
    if (!current) return;
    setBusy('test');
    setError(null);
    try {
      setTest(await api.client.post<IntegrationTestResult>(`/integrations/${current.id}/test`));
      await refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const lastTest = test ?? (current?.lastTestedAt ? { supported: true, ok: current.lastTestOk, message: current.lastTestMessage ?? '', testedAt: current.lastTestedAt } : null);
  const authorisation = current?.authorisation ?? null;

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span dir="auto">{current?.name ?? provider.name}</span>
              <Badge tone={state.tone}>{t(state.labelKey)}</Badge>
            </DialogTitle>
            <DialogDescription dir="auto">{provider.description}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-6">
            {record ? (
              <Alert tone="info" title={t('adm.integrations.record.title')}>
                {t('adm.integrations.record.text')}
              </Alert>
            ) : null}

            {authorisation ? (
              <div className="rounded-lg border p-4">
                <p className="flex flex-wrap items-center gap-2 text-base font-medium">
                  {t('adm.integrations.record.review')}
                  <Badge tone={state.tone}>{t(`adm.integrations.record.state.${authorisation.expired ? 'EXPIRED' : authorisation.state}`)}</Badge>
                </p>
                <dl className="mt-2 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-muted-foreground">{t('adm.integrations.record.submitted')}</dt>
                    <dd>{authorisation.submittedAt ? formatDateTime(authorisation.submittedAt) : '–'}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('adm.integrations.record.reviewed')}</dt>
                    <dd>{authorisation.reviewedAt ? formatDateTime(authorisation.reviewedAt) : t('adm.integrations.record.notReviewed')}</dd>
                  </div>
                  {authorisation.reviewNote ? (
                    <div className="sm:col-span-2">
                      <dt className="text-muted-foreground">{t('adm.integrations.record.reviewNote')}</dt>
                      <dd className="text-base" dir="auto">
                        {authorisation.reviewNote}
                      </dd>
                    </div>
                  ) : null}
                </dl>
                {authorisation.state === 'VERIFIED' ? <p className="mt-2 text-sm text-muted-foreground">{t('adm.integrations.record.keyFields')}</p> : null}
              </div>
            ) : null}

            {/* ---- settings */}
            <section className="space-y-4">
              <h3 className="text-md font-semibold">{record ? t('adm.integrations.record.details') : t('adm.integrations.settings')}</h3>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label={t('adm.integrations.name')} htmlFor={`${id}-name`} hint={t('adm.integrations.nameHint')}>
                  <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder={provider.name} autoComplete="off" dir="auto" />
                </Field>
                {provider.modes.length > 1 ? (
                  <Field label={t('adm.integrations.mode')} htmlFor={`${id}-mode`} hint={t('adm.integrations.modeHint')}>
                    <Select id={`${id}-mode`} value={mode} onValueChange={(v) => setMode(v as 'TEST' | 'LIVE')} options={provider.modes.map((m) => ({ value: m, label: t(`adm.integrations.modes.${m}`) }))} />
                  </Field>
                ) : null}
                {provider.configFields.map((field) => {
                  const missing = touched && field.required && field.type !== 'boolean' && isEmpty(values[field.key]);
                  const wide = field.type === 'text' || field.type === 'json' || field.type === 'languageCodes';
                  return (
                    <Field
                      key={field.key}
                      className={wide ? 'sm:col-span-2' : undefined}
                      htmlFor={`${id}-c-${field.key}`}
                      label={
                        <span dir="auto">
                          {field.label}
                          {field.required ? (
                            <span aria-hidden="true" className="ms-0.5 text-destructive-text">
                              *
                            </span>
                          ) : null}
                        </span>
                      }
                      hint={field.help ? <span dir="auto">{field.help}</span> : undefined}
                      error={missing ? t('validation.required') : undefined}
                    >
                      <ConfigInput field={field} id={`${id}-c-${field.key}`} value={values[field.key]} onChange={(v) => setValues((old) => ({ ...old, [field.key]: v }))} invalid={missing || fieldError === field.key} />
                    </Field>
                  );
                })}
                {record ? (
                  <Field className="sm:col-span-2" htmlFor={`${id}-note`} label={t('adm.integrations.record.note')} hint={t('adm.integrations.record.noteHint')} error={touched && noteTooShort ? t('adm.integrations.record.noteShort') : undefined}>
                    <Textarea id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={3} dir="auto" aria-invalid={touched && noteTooShort} />
                  </Field>
                ) : null}
              </div>
            </section>

            {/* ---- credentials (write-only) */}
            {record ? (
              <Alert tone="warning" title={t('adm.integrations.record.noCredentialsTitle')}>
                {t('adm.integrations.record.noCredentials')}
              </Alert>
            ) : provider.secretFields.length ? (
              <section className="space-y-4">
                <div>
                  <h3 className="flex items-center gap-2 text-md font-semibold">
                    <KeyRound className="size-4 text-muted-foreground" aria-hidden="true" />
                    {t('adm.integrations.credentials')}
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">{t('adm.integrations.credentialsText')}</p>
                </div>
                <div className="grid gap-5 sm:grid-cols-2">
                  {provider.secretFields.map((field) => {
                    const stored = !!current?.secretKeys.includes(field.key);
                    const removing = removeSecrets.includes(field.key);
                    const wide = field.type === 'json' || field.type === 'text';
                    return (
                      <Field
                        key={field.key}
                        className={wide ? 'sm:col-span-2' : undefined}
                        htmlFor={`${id}-s-${field.key}`}
                        label={
                          <span dir="auto">
                            {field.label}
                            {field.required ? (
                              <span aria-hidden="true" className="ms-0.5 text-destructive-text">
                                *
                              </span>
                            ) : null}
                          </span>
                        }
                        hint={
                          <>
                            {stored ? (
                              <span className="flex flex-wrap items-center gap-x-2 text-success-text">
                                <span className="inline-flex items-center gap-1">
                                  <CheckCircle2 className="size-3.5" aria-hidden="true" />
                                  {removing ? t('adm.integrations.secretRemoving') : t('adm.integrations.secretSaved', { date: formatDate(current?.secretsUpdatedAt) })}
                                </span>
                                {!field.required ? (
                                  <button type="button" className="text-secondary-text underline-offset-4 hover:underline" onClick={() => setRemoveSecrets(removing ? removeSecrets.filter((k) => k !== field.key) : [...removeSecrets, field.key])}>
                                    {removing ? t('adm.integrations.secretKeep') : t('adm.integrations.secretRemove')}
                                  </button>
                                ) : null}
                              </span>
                            ) : (
                              <span>{t('adm.integrations.secretNotSaved')}</span>
                            )}
                            {field.help ? (
                              <span className="block" dir="auto">
                                {field.help}
                              </span>
                            ) : null}
                          </>
                        }
                      >
                        {wide ? (
                          <Textarea id={`${id}-s-${field.key}`} value={secrets[field.key] ?? ''} onChange={(e) => setSecrets({ ...secrets, [field.key]: e.target.value })} rows={4} dir="ltr" spellCheck={false} autoComplete="off" className="font-mono text-sm" placeholder={stored ? t('adm.integrations.secretReplace') : undefined} aria-invalid={fieldError === field.key} />
                        ) : (
                          <PasswordInput id={`${id}-s-${field.key}`} value={secrets[field.key] ?? ''} onChange={(e) => setSecrets({ ...secrets, [field.key]: e.target.value })} dir="ltr" autoComplete="new-password" placeholder={stored ? t('adm.integrations.secretReplace') : undefined} aria-invalid={fieldError === field.key} />
                        )}
                      </Field>
                    );
                  })}
                </div>
              </section>
            ) : null}

            {current?.webhookUrl ? (
              <section className="space-y-1.5">
                <h3 className="text-md font-semibold">{t('adm.integrations.webhook')}</h3>
                <p className="text-sm text-muted-foreground">{t('adm.integrations.webhookText')}</p>
                <div className="flex items-center gap-1 rounded-md bg-muted px-3 py-2">
                  <code className="ltr-value min-w-0 flex-1 break-all text-sm">{current.webhookUrl}</code>
                  <CopyButton value={current.webhookUrl} label={t('adm.integrations.copyWebhook')} />
                </div>
              </section>
            ) : null}

            {/* ---- usage note, exactly as the API reports it */}
            <Alert tone={provider.usage.effective ? 'info' : 'warning'} title={provider.usage.effective ? t('adm.integrations.usage') : t('adm.integrations.recordedOnly')}>
              <span dir="auto">{(current ?? provider).usage.note}</span>
            </Alert>

            {current && (current.missing.config.length || current.missing.secrets.length) ? (
              <Alert tone="warning" title={t('adm.integrations.incomplete')}>
                <span dir="auto">{[...current.missing.config, ...current.missing.secrets].map((key) => [...provider.configFields, ...provider.secretFields].find((f) => f.key === key)?.label ?? key).join(', ')}</span>
              </Alert>
            ) : null}

            {/* ---- connection test */}
            {current && !record ? (
              <section className="space-y-3 rounded-lg border p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-md font-semibold">{t('adm.integrations.test.title')}</h3>
                    {provider.testNote ? (
                      <p className="mt-0.5 text-sm text-muted-foreground" dir="auto">
                        {provider.testNote}
                      </p>
                    ) : null}
                  </div>
                  {provider.testable ? (
                    <Button variant="outline" size="sm" loading={busy === 'test'} loadingText={t('adm.integrations.test.running')} disabled={!!busy} onClick={() => void runTest()}>
                      <PlugZap aria-hidden="true" />
                      {t('adm.integrations.test.run')}
                    </Button>
                  ) : null}
                </div>
                {lastTest && lastTest.supported ? (
                  <p role="status" className={lastTest.ok ? 'flex items-start gap-2 text-base text-success-text' : 'flex items-start gap-2 text-base text-destructive-text'}>
                    {lastTest.ok ? <CheckCircle2 className="mt-1 size-4 shrink-0" aria-hidden="true" /> : <XCircle className="mt-1 size-4 shrink-0" aria-hidden="true" />}
                    <span>
                      <span className="font-medium">{lastTest.ok ? t('adm.integrations.test.ok') : t('adm.integrations.test.failed')}</span>{' '}
                      <span dir="auto">{lastTest.message}</span>
                      {lastTest.testedAt ? <span className="block text-sm text-muted-foreground">{t('adm.integrations.test.at', { date: formatDateTime(lastTest.testedAt) })}</span> : null}
                    </span>
                  </p>
                ) : lastTest && !lastTest.supported ? (
                  <p role="status" className="text-base text-muted-foreground" dir="auto">
                    {lastTest.message}
                  </p>
                ) : null}
              </section>
            ) : null}

            {error ? (
              <Alert tone="danger" live>
                <span dir="auto">{message(error)}</span>
              </Alert>
            ) : null}
          </DialogBody>
          <DialogFooter className="sm:justify-between">
            <span className="flex flex-col-reverse gap-2 sm:flex-row">
              {current ? (
                <Button
                  variant="destructive-outline"
                  disabled={!!busy}
                  onClick={() => {
                    setDeleteError(null);
                    setDeleting(true);
                  }}
                >
                  <Trash2 aria-hidden="true" />
                  {t('common.delete')}
                </Button>
              ) : null}
            </span>
            <span className="grid grid-cols-2 gap-2 sm:flex sm:flex-row [&>*:last-child]:max-sm:order-first [&>*:last-child]:max-sm:col-span-2 [&>*:only-child]:col-span-2">
              <Button variant="outline" onClick={onClose} disabled={!!busy} className="max-sm:[&:nth-last-child(2)]:col-span-2">
                {t('common.close')}
              </Button>
              {current && (!record || authorisation?.state === 'VERIFIED') ? (
                <Button variant="outline" loading={busy === 'toggle'} loadingText={t('common.saving')} disabled={!!busy || (!current.approved && current.status !== 'ACTIVE')} onClick={() => void toggle()}>
                  {current.status === 'ACTIVE' ? t('adm.integrations.disable') : t('adm.integrations.enable')}
                </Button>
              ) : null}
              <Button loading={busy === 'save'} loadingText={t('common.saving')} disabled={!!busy || !provider.approved} onClick={() => void save()}>
                {current ? t('common.saveChanges') : record ? t('adm.integrations.record.submit') : t('adm.integrations.add')}
              </Button>
            </span>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('adm.integrations.deleteTitle', { name: current?.name ?? '' })}
        description={record ? t('adm.integrations.deleteRecordText') : t('adm.integrations.deleteText')}
        confirmLabel={t('adm.integrations.deleteConfirm')}
        onConfirm={async () => {
          if (!current) return;
          setDeleteError(null);
          try {
            await api.client.delete(`/integrations/${current.id}`);
            toasts.success(t('adm.integrations.deleted'), current.name);
            await refresh();
            onClose();
          } catch (e) {
            setDeleteError(e);
            throw e;
          }
        }}
      >
        {deleteError ? <ActionError error={deleteError} /> : null}
      </ConfirmDialog>
    </>
  );
}
