'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { tenantSettingsSchema } from '@typease/validation';
import { Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, Form, FormError, FormField, Input, useApi, useI18n, useToast, useZodForm } from '@typease/ui';
import { ActionError, CardSkeleton, LoadError, SettingSwitch } from '@/components/adm/shared';
import type { TenantDetail, TenantUsage } from '@/components/adm/types';
import { admKeys } from '@/lib/keys/adm';

const schema = tenantSettingsSchema.omit({ queueDisplayLanguage: true, reminderOffsetsDays: true });

/** Preferences of the centre (PATCH /tenant/settings) and the AI assistant switch (PATCH /tenant). */
export function PreferencesTab() {
  const api = useApi();
  const tenant = useQuery({ queryKey: admKeys.tenant.detail, queryFn: () => api.client.get<TenantDetail>('/tenant') });
  if (tenant.isPending) {
    return (
      <div className="space-y-6">
        <CardSkeleton lines={6} />
        <CardSkeleton lines={2} />
      </div>
    );
  }
  if (tenant.isError) return <LoadError error={tenant.error} onRetry={() => void tenant.refetch()} />;
  return (
    <div className="space-y-6">
      <PreferencesForm key={tenant.data.updatedAt} tenant={tenant.data} />
      <AiCard tenant={tenant.data} />
    </div>
  );
}

/** A whole number typed into a text field: "" stays "" (not set), anything else becomes a number for the schema. */
const numeric = (onChange: (value: unknown) => void) => (event: React.ChangeEvent<HTMLInputElement>) => {
  const digits = event.target.value.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/\D/g, '');
  onChange(digits === '' ? '' : Number(digits));
};

function PreferencesForm({ tenant }: { tenant: TenantDetail }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const s = tenant.settings;
  const form = useZodForm(schema, {
    defaultValues: {
      allowSelfRegistration: s.allowSelfRegistration !== false,
      autoAssign: s.autoAssign === true,
      defaultTargetHours: s.defaultTargetHours ?? ('' as unknown as number),
      quotationValidityDays: s.quotationValidityDays ?? ('' as unknown as number),
      invoiceDueDays: s.invoiceDueDays ?? ('' as unknown as number),
      requestNumberPrefix: s.requestNumberPrefix ?? '',
    },
  });
  const [offsets, setOffsets] = React.useState((s.reminderOffsetsDays ?? []).join(', '));
  const [offsetsError, setOffsetsError] = React.useState<string | null>(null);
  const offsetsId = React.useId();
  const selfId = React.useId();
  const autoId = React.useId();

  const parseOffsets = (): number[] | null => {
    const parts = offsets
      .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
      .split(/[\s,،;]+/)
      .filter(Boolean);
    const numbers = parts.map(Number);
    if (numbers.some((n) => !Number.isInteger(n) || n < 1 || n > 365) || numbers.length > 8) return null;
    return [...new Set(numbers)].sort((a, b) => b - a);
  };

  return (
    <Card>
      <Form
        form={form}
        className="space-y-0"
        onSubmit={async (values) => {
          const reminderOffsetsDays = parseOffsets();
          if (!reminderOffsetsDays) {
            setOffsetsError(t('adm.settings.preferences.offsetsInvalid'));
            return;
          }
          setOffsetsError(null);
          await api.client.patch('/tenant/settings', { ...values, ...(reminderOffsetsDays.length || s.reminderOffsetsDays ? { reminderOffsetsDays } : {}) });
          toasts.success(t('adm.settings.preferences.saved'));
          await queryClient.invalidateQueries({ queryKey: admKeys.tenant.all });
        }}
      >
        <CardHeader>
          <div>
            <CardTitle>{t('adm.settings.preferences.title')}</CardTitle>
            <CardDescription>{t('adm.settings.preferences.text')}</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-5 rounded-lg border p-4">
            <SettingSwitch
              id={selfId}
              label={t('adm.settings.preferences.selfRegistration')}
              description={t('adm.settings.preferences.selfRegistrationText')}
              checked={!!form.watch('allowSelfRegistration')}
              onCheckedChange={(checked) => form.setValue('allowSelfRegistration', checked, { shouldDirty: true })}
            />
            <SettingSwitch
              id={autoId}
              label={t('adm.settings.preferences.autoAssign')}
              description={t('adm.settings.preferences.autoAssignText')}
              checked={!!form.watch('autoAssign')}
              onCheckedChange={(checked) => form.setValue('autoAssign', checked, { shouldDirty: true })}
            />
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <FormField name="defaultTargetHours" label={t('adm.settings.preferences.targetHours')} hint={t('adm.settings.preferences.targetHoursHint')}>
              {(field) => <Input {...field} onChange={numeric(field.onChange)} inputMode="numeric" autoComplete="off" dir="ltr" className="tabular sm:max-w-40" placeholder="48" />}
            </FormField>
            <FormField name="requestNumberPrefix" label={t('adm.settings.preferences.prefix')} hint={t('adm.settings.preferences.prefixHint', { example: `${form.watch('requestNumberPrefix') || 'TE'}-000123` })}>
              {(field) => <Input {...field} onChange={(e: React.ChangeEvent<HTMLInputElement>) => field.onChange(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))} autoComplete="off" dir="ltr" className="tabular sm:max-w-40" />}
            </FormField>
            <FormField name="quotationValidityDays" label={t('adm.settings.preferences.quotationDays')} hint={t('adm.settings.preferences.quotationDaysHint')}>
              {(field) => <Input {...field} onChange={numeric(field.onChange)} inputMode="numeric" autoComplete="off" dir="ltr" className="tabular sm:max-w-40" />}
            </FormField>
            <FormField name="invoiceDueDays" label={t('adm.settings.preferences.invoiceDays')} hint={t('adm.settings.preferences.invoiceDaysHint')}>
              {(field) => <Input {...field} onChange={numeric(field.onChange)} inputMode="numeric" autoComplete="off" dir="ltr" className="tabular sm:max-w-40" />}
            </FormField>
          </div>

          <div className="space-y-1.5">
            <label htmlFor={offsetsId} className="block text-sm font-medium leading-5">
              {t('adm.settings.preferences.offsets')}
            </label>
            <Input id={offsetsId} value={offsets} onChange={(e) => setOffsets(e.target.value)} aria-invalid={!!offsetsError} autoComplete="off" dir="ltr" className="tabular sm:max-w-sm" placeholder="60, 30, 14, 7" />
            {offsetsError ? (
              <p role="alert" className="text-sm text-destructive-text">
                {offsetsError}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">{t('adm.settings.preferences.offsetsHint')}</p>
            )}
          </div>
          <FormError />
        </CardContent>
        <CardFooter className="justify-end">
          <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
            {t('common.saveChanges')}
          </Button>
        </CardFooter>
      </Form>
    </Card>
  );
}

/** The AI document assistant is a plan feature: switching it on without it answers 402, shown here with the way out. */
function AiCard({ tenant }: { tenant: TenantDetail }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const usage = useQuery({ queryKey: admKeys.tenant.usage, queryFn: () => api.client.get<TenantUsage>('/tenant/usage'), staleTime: 60_000 });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const id = React.useId();
  const included = usage.data?.plan?.features.aiAssistant;

  const toggle = async (aiEnabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api.client.patch('/tenant', { aiEnabled });
      toasts.success(aiEnabled ? t('adm.settings.ai.enabled') : t('adm.settings.ai.disabled'));
      await queryClient.invalidateQueries({ queryKey: admKeys.tenant.all });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-4">
        <SettingSwitch id={id} label={t('adm.settings.ai.title')} description={t('adm.settings.ai.text')} checked={tenant.aiEnabled} disabled={busy} onCheckedChange={(checked) => void toggle(checked)}>
          <ul className="mt-2 list-disc space-y-1 ps-5 text-sm text-muted-foreground">
            <li>{t('adm.settings.ai.point1')}</li>
            <li>{t('adm.settings.ai.point2')}</li>
            <li>{t('adm.settings.ai.point3')}</li>
          </ul>
          {included === false && !error ? <p className="mt-2 text-sm font-medium text-warning-text">{t('adm.settings.ai.notIncluded')}</p> : null}
        </SettingSwitch>
        <ActionError error={error} />
      </CardContent>
    </Card>
  );
}
