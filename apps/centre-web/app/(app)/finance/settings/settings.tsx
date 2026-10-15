'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FeeComponentTypeValues, type FeeComponentType } from '@typease/types';
import { feeComponentsUpdateSchema } from '@typease/validation';
import {
  Alert, Badge, Button, Card, CardContent, ConfirmDialog, DescriptionList, Form, FormActions, FormError, FormField, Input, PageHeader, RequirePermission, Select, Skeleton, Switch, useI18n,
  useSession, useToast, useZodForm,
} from '@typease/ui';
import { useFinApi } from '@/components/fin/api';
import { FinanceTabs } from '@/components/fin/finance-tabs';
import { LoadError, Section } from '@/components/fin/shared';
import type { FeeComponentsResponse } from '@/components/fin/types';
import { finKeys } from '@/lib/keys/fin';

/** How each fee component is treated in the books, and the centre's tax rate. */
export function FeeSettings() {
  return (
    <RequirePermission anyOf={['finance.settings', 'report.financial', 'payment.reconcile']}>
      <FeeSettingsInner />
    </RequirePermission>
  );
}

function FeeSettingsInner() {
  const { t, formatNumber } = useI18n();
  const api = useFinApi();
  const session = useSession();
  const components = useQuery({ queryKey: finKeys.feeComponents, queryFn: ({ signal }) => api.feeComponents.get(signal) });
  const tenant = useQuery({ queryKey: finKeys.tenant, queryFn: ({ signal }) => api.tenant(signal), staleTime: 5 * 60_000 });

  return (
    <>
      <PageHeader title={t('fin.feeSettings.title')} description={t('fin.feeSettings.description')} />
      <FinanceTabs current="settings" />

      {/* The treatment is an accounting and tax decision of the centre, not of the software. */}
      <Alert tone="warning" className="mb-6" title={t('fin.feeSettings.adviserTitle')}>
        {t('fin.feeSettings.adviserText')}
      </Alert>

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          {components.isPending ? (
            <div className="space-y-4" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-44" />
              ))}
            </div>
          ) : components.isError ? (
            <LoadError error={components.error} onRetry={() => void components.refetch()} />
          ) : (
            <ComponentsForm data={components.data} editable={session.hasPermission('finance.settings')} />
          )}
        </div>

        <Section title={t('fin.feeSettings.tax.title')}>
          {tenant.isPending ? (
            <Skeleton className="h-20" />
          ) : tenant.isError ? (
            <LoadError error={tenant.error} onRetry={() => void tenant.refetch()} />
          ) : (
            <>
              <DescriptionList
                columns={1}
                items={[
                  { label: t('fin.feeSettings.tax.rate'), value: tenant.data.taxRatePercent !== null ? <span className="tabular text-xl font-semibold">{formatNumber(tenant.data.taxRatePercent, { maximumFractionDigits: 2 })}%</span> : null },
                  { label: t('fin.feeSettings.tax.registration'), value: tenant.data.taxRegistrationNo ? <span className="ltr-value">{tenant.data.taxRegistrationNo}</span> : t('fin.feeSettings.tax.notRegistered') },
                ]}
              />
              <p className="mt-4 text-sm text-muted-foreground">{t('fin.feeSettings.tax.text')}</p>
              {session.hasPermission('settings.manage') ? (
                <Button asChild variant="link" className="mt-2">
                  <Link href="/settings">{t('fin.feeSettings.tax.change')}</Link>
                </Button>
              ) : null}
            </>
          )}
        </Section>
      </div>
    </>
  );
}

function ComponentsForm({ data, editable }: { data: FeeComponentsResponse; editable: boolean }) {
  const { t } = useI18n();
  const api = useFinApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const ordered = React.useMemo(() => FeeComponentTypeValues.map((type) => data.components.find((c) => c.type === type)).filter((c): c is FeeComponentsResponse['components'][number] => !!c), [data]);
  const toValues = React.useCallback(
    (list: typeof ordered) => ({ components: list.map((c) => ({ type: c.type, name: c.name, treatment: c.treatment, taxable: c.taxable, ledgerCode: c.ledgerCode ?? '' })) }),
    [],
  );
  const form = useZodForm(feeComponentsUpdateSchema, { emptyAs: 'null', defaultValues: toValues(ordered) });
  const [confirm, setConfirm] = React.useState<null | { values: Parameters<typeof api.feeComponents.update>[0]; changed: FeeComponentType[] }>(null);

  const save = async (values: unknown) => {
    const saved = await api.feeComponents.update(values);
    queryClient.setQueryData(finKeys.feeComponents, saved);
    form.reset(toValues(FeeComponentTypeValues.map((type) => saved.components.find((c) => c.type === type)).filter((c): c is FeeComponentsResponse['components'][number] => !!c)));
    toasts.success(t('fin.feeSettings.saved'), t('fin.feeSettings.savedDescription'));
    await Promise.all([finKeys.liabilities.all, finKeys.reports.all, finKeys.dashboard.all].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  };

  return (
    <>
      <Form
        form={form}
        className="space-y-4"
        onSubmit={async (values) => {
          const changed = values.components.filter((c, i) => c.treatment !== ordered[i]?.treatment || c.taxable !== ordered[i]?.taxable).map((c) => c.type);
          // A change of treatment moves money between "our revenue" and "held for others", and the tax switch
          // changes what customers are charged: ask once more. A new name or ledger code is saved directly.
          if (changed.length) {
            setConfirm({ values, changed });
            return;
          }
          await save(values);
        }}
      >
        {ordered.map((component, index) => {
          const isService = component.type === 'SERVICE_FEE';
          return (
            <Card key={component.type}>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-md font-semibold text-foreground">{t(`fin.feeSettings.types.${component.type}.title`)}</h2>
                  <Badge tone={component.treatment === 'REVENUE' ? 'success' : 'info'}>{t(`fin.feeSettings.treatments.${component.treatment}`)}</Badge>
                </div>
                <p className="text-sm text-muted-foreground">{t(`fin.feeSettings.types.${component.type}.text`)}</p>
                <div className="grid gap-5 sm:grid-cols-2">
                  <FormField name={`components.${index}.name`} label={t('fin.feeSettings.name')} hint={t('fin.feeSettings.nameHint')}>
                    {(field) => <Input {...field} disabled={!editable} maxLength={120} dir="auto" />}
                  </FormField>
                  <FormField name={`components.${index}.treatment`} label={t('fin.feeSettings.treatment')} hint={isService ? t('fin.feeSettings.serviceAlwaysRevenue') : undefined}>
                    {(field) => (
                      <Select
                        {...field}
                        disabled={!editable || isService}
                        onValueChange={(v) => v && field.onChange(v)}
                        options={(['REVENUE', 'PASS_THROUGH_LIABILITY'] as const).map((v) => ({ value: v, label: t(`fin.feeSettings.treatments.${v}`) }))}
                      />
                    )}
                  </FormField>
                  <FormField name={`components.${index}.ledgerCode`} label={t('fin.feeSettings.ledgerCode')} optional hint={t('fin.feeSettings.ledgerCodeHint')}>
                    {(field) => <Input {...field} disabled={!editable} maxLength={40} dir="ltr" className="tabular" />}
                  </FormField>
                  <FormField name={`components.${index}.taxable`} label={t('fin.feeSettings.taxable')} hint={t('fin.feeSettings.taxableHint')}>
                    {(field) => (
                      <div className="flex h-10 items-center gap-3">
                        <Switch id={field.id} checked={field.value === true} onCheckedChange={(v) => field.onChange(v)} disabled={!editable} aria-describedby={field['aria-describedby']} />
                        <span className="text-base">{field.value === true ? t('fin.feeSettings.taxableYes') : t('fin.feeSettings.taxableNo')}</span>
                      </div>
                    )}
                  </FormField>
                </div>
                {component.reviewNote ? (
                  <p className="rounded-md bg-muted/60 px-3 py-2 text-sm text-muted-foreground" dir="auto">
                    {component.reviewNote}
                  </p>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
        <FormError />
        {editable ? (
          <FormActions>
            <Button variant="outline" onClick={() => form.reset(toValues(ordered))} disabled={!form.formState.isDirty || form.formState.isSubmitting}>
              {t('common.reset')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')} disabled={!form.formState.isDirty}>
              {t('common.saveChanges')}
            </Button>
          </FormActions>
        ) : (
          <p className="text-sm text-muted-foreground">{t('fin.feeSettings.readOnly')}</p>
        )}
      </Form>

      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(open) => !open && setConfirm(null)}
        tone="default"
        title={t('fin.feeSettings.confirmTitle')}
        description={t('fin.feeSettings.confirmText')}
        confirmLabel={t('fin.feeSettings.confirmAction')}
        onConfirm={async () => {
          if (!confirm) return;
          try {
            await save(confirm.values);
          } catch (error) {
            toasts.error(error);
            throw error;
          }
        }}
      >
        <ul className="list-disc space-y-1 ps-5 text-base">
          {confirm?.changed.map((type) => (
            <li key={type}>{t(`fin.feeSettings.types.${type}.title`)}</li>
          ))}
        </ul>
      </ConfirmDialog>
    </>
  );
}
