'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isApiError } from '@typease/api-client';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, PermissionGate, Skeleton, useErrorMessage, useI18n, useToast } from '@typease/ui';
import { ConfirmAction, LoadError } from '@/components/shared';
import { usePlatformApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import type { PlatformSetting } from '@/lib/types';

interface FieldDef {
  name: string;
  min: number;
  max: number;
  /** "list" = several numbers separated by commas (the retry schedule). */
  kind?: 'integer' | 'decimal' | 'list';
}
/** The policy settings the API exposes (docs/api/modules/platform.md, section 5) and the limits it enforces. */
const POLICIES: Array<{ id: string; setting: string; fields: FieldDef[] }> = [
  {
    id: 'billing',
    setting: 'subscriptions.policy',
    fields: [
      { name: 'renewalLeadDays', min: 0, max: 60 },
      { name: 'trialReminderDays', min: 0, max: 30 },
      { name: 'retryDelaysDays', min: 0, max: 30, kind: 'list' },
      { name: 'graceDays', min: 0, max: 90 },
      { name: 'taxRatePercent', min: 0, max: 100, kind: 'decimal' },
    ],
  },
  {
    id: 'access',
    setting: 'supportAccess.policy',
    fields: [
      { name: 'maxDurationMinutes', min: 5, max: 1440 },
      { name: 'pendingExpiryDays', min: 1, max: 30 },
    ],
  },
  { id: 'offboarding', setting: 'offboarding.policy', fields: [{ name: 'minPurgeDelayDays', min: 30, max: 3650 }] },
];

const asText = (value: unknown): string => (Array.isArray(value) ? value.join(', ') : value === null || value === undefined ? '' : String(value));

/**
 * Platform policy settings (GET /platform/settings): dunning and tax of subscription
 * invoices, limits of support access, the waiting time before a closed centre is deleted.
 * They apply to every centre, so each change is confirmed and recorded.
 */
export function PlatformSettings() {
  const { t } = useI18n();
  const api = usePlatformApi();
  const settings = useQuery({ queryKey: keys.settings.all, queryFn: ({ signal }) => api.settings.list(signal) });

  if (settings.isPending) {
    return (
      <div className="grid gap-6 xl:grid-cols-2" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-64" />
        ))}
      </div>
    );
  }
  if (settings.isError) return <LoadError lead={t('flags.settings.loadError')} error={settings.error} onRetry={() => void settings.refetch()} />;

  const providers = settings.data.find((s) => s.key === 'integrations.approvedProviders');
  return (
    <div className="space-y-6">
      <div className="grid items-start gap-6 xl:grid-cols-2">
        {POLICIES.map((policy) => {
          const setting = settings.data.find((s) => s.key === policy.setting);
          return setting ? <PolicyCard key={policy.id} id={policy.id} fields={policy.fields} setting={setting as PlatformSetting<Record<string, unknown>>} /> : null;
        })}
        {providers ? (
          <Card>
            <CardHeader className="flex-nowrap">
              <CardTitle>{t('flags.settings.providers.title')}</CardTitle>
              <Badge className="shrink-0" tone={providers.value === null ? 'neutral' : 'warning'}>{providers.value === null ? t('flags.settings.providers.open') : t('flags.settings.providers.restricted')}</Badge>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-base text-muted-foreground">{t('flags.settings.providers.text')}</p>
              <PermissionGate permission="platform.integrations.manage">
                <Button asChild variant="outline">
                  <Link href="/integrations?tab=providers">{t('flags.settings.providers.open2')}</Link>
                </Button>
              </PermissionGate>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

function PolicyCard({ id, fields, setting }: { id: string; fields: FieldDef[]; setting: PlatformSetting<Record<string, unknown>> }) {
  const { t, formatDateTime } = useI18n();
  const api = usePlatformApi();
  const toasts = useToast();
  const describe = useErrorMessage();
  const queryClient = useQueryClient();
  const formId = React.useId();
  const stored = React.useMemo(() => ({ ...(setting.defaultValue ?? {}), ...(setting.value ?? {}) }), [setting]);
  const [values, setValues] = React.useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.name, asText(stored[f.name])])));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [failure, setFailure] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<'save' | 'reset' | null>(null);
  React.useEffect(() => {
    setValues(Object.fromEntries(fields.map((f) => [f.name, asText(stored[f.name])])));
    setErrors({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored]);
  const dirty = fields.some((f) => values[f.name] !== asText(stored[f.name]));

  /** The value to send, or null (with the messages set) when something is out of range. */
  const parse = (): Record<string, unknown> | null => {
    const out: Record<string, unknown> = {};
    const problems: Record<string, string> = {};
    const range = (f: FieldDef) => t('flags.settings.range', { min: f.min, max: f.max });
    for (const f of fields) {
      const raw = (values[f.name] ?? '').trim();
      if (f.kind === 'list') {
        const parts = raw ? raw.split(/[,،\s]+/).filter(Boolean) : [];
        const numbers = parts.map(Number);
        if (numbers.some((n) => !Number.isFinite(n) || n < f.min || n > f.max) || numbers.length > 10) problems[f.name] = t('flags.settings.listInvalid', { min: f.min, max: f.max });
        else out[f.name] = numbers;
        continue;
      }
      const n = Number(raw);
      if (raw === '' || !Number.isFinite(n) || n < f.min || n > f.max || (f.kind !== 'decimal' && !Number.isInteger(n))) problems[f.name] = range(f);
      else out[f.name] = n;
    }
    setErrors(problems);
    return Object.keys(problems).length ? null : out;
  };

  const done = async (message: string) => {
    await Promise.all([keys.settings.all, keys.audit.all].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
    toasts.success(message);
  };

  return (
    <Card>
      <CardHeader className="flex-nowrap">
        <div className="min-w-0">
          <CardTitle>{t(`flags.settings.${id}.title`)}</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">{t(`flags.settings.${id}.text`)}</p>
        </div>
        <Badge className="shrink-0" tone={setting.isDefault ? 'neutral' : 'info'}>{setting.isDefault ? t('flags.settings.default') : t('flags.settings.changed')}</Badge>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            setFailure(null);
            if (parse()) setConfirm('save');
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            {fields.map((f) => (
              <div key={f.name} className="space-y-1.5">
                <Label htmlFor={`${formId}-${f.name}`}>{t(`flags.settings.${id}.${f.name}`)}</Label>
                <Input
                  id={`${formId}-${f.name}`}
                  dir="ltr"
                  inputMode={f.kind === 'list' ? 'text' : f.kind === 'decimal' ? 'decimal' : 'numeric'}
                  autoComplete="off"
                  className="tabular"
                  value={values[f.name] ?? ''}
                  aria-invalid={!!errors[f.name]}
                  aria-describedby={`${formId}-${f.name}-hint`}
                  onChange={(e) => {
                    setValues((current) => ({ ...current, [f.name]: e.target.value }));
                    if (errors[f.name]) setErrors(({ [f.name]: _removed, ...rest }) => rest);
                  }}
                />
                {errors[f.name] ? (
                  <p id={`${formId}-${f.name}-hint`} role="alert" className="text-sm text-destructive-text">
                    {errors[f.name]}
                  </p>
                ) : (
                  <p id={`${formId}-${f.name}-hint`} className="text-sm text-muted-foreground">
                    {t(`flags.settings.${id}.${f.name}Hint`)}
                  </p>
                )}
              </div>
            ))}
          </div>
          {failure ? (
            <Alert tone="danger" live>
              {failure}
            </Alert>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">{setting.updatedAt ? t('flags.settings.updated', { time: formatDateTime(setting.updatedAt) }) : t('flags.settings.neverChanged')}</p>
            <div className="flex flex-wrap gap-2">
              {setting.isDefault ? null : (
                <Button type="button" variant="outline" onClick={() => setConfirm('reset')}>
                  {t('flags.settings.reset')}
                </Button>
              )}
              <Button type="submit" disabled={!dirty}>
                {t('common.saveChanges')}
              </Button>
            </div>
          </div>
        </form>
      </CardContent>

      <ConfirmAction
        open={confirm === 'save'}
        onOpenChange={(open) => !open && setConfirm(null)}
        tone="default"
        title={t('flags.settings.saveTitle', { name: t(`flags.settings.${id}.title`) })}
        description={t('flags.settings.saveText')}
        confirmLabel={t('common.saveChanges')}
        onConfirm={async () => {
          const value = parse();
          if (!value) return;
          try {
            await api.settings.set(setting.key, value);
          } catch (error) {
            // INVALID_SETTING names the entries: show them next to their fields as well.
            if (isApiError(error) && error.code === 'INVALID_SETTING' && Array.isArray(error.details)) {
              const problems: Record<string, string> = {};
              for (const item of error.details as Array<{ path?: unknown; message?: unknown }>) {
                const path = Array.isArray(item.path) ? String(item.path[0]) : String(item.path ?? '').split('.')[0];
                if (path && typeof item.message === 'string') problems[path] = item.message;
              }
              setErrors(problems);
            }
            setFailure(describe(error));
            throw error;
          }
          await done(t('flags.settings.saved', { name: t(`flags.settings.${id}.title`) }));
        }}
      />
      <ConfirmAction
        open={confirm === 'reset'}
        onOpenChange={(open) => !open && setConfirm(null)}
        tone="default"
        title={t('flags.settings.resetTitle', { name: t(`flags.settings.${id}.title`) })}
        description={t('flags.settings.resetText')}
        confirmLabel={t('flags.settings.reset')}
        onConfirm={async () => {
          await api.settings.reset(setting.key);
          await done(t('flags.settings.resetDone', { name: t(`flags.settings.${id}.title`) }));
        }}
      />
    </Card>
  );
}
