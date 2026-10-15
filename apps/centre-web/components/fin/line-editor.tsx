'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useFieldArray, useFormContext, useWatch } from 'react-hook-form';
import { Plus, Trash2 } from 'lucide-react';
import { Alert, Button, FormField, Input, MoneyInput, Select, fromMinorUnits, useI18n, useSession } from '@typease/ui';
import { finKeys } from '@/lib/keys/fin';
import { useFinApi } from './api';
import { previewLine, previewTotals, type LineDraft, type TotalsPreview } from './calc';
import { FeeBreakdown, Money } from './shared';
import type { FeeComponentType, LineItem } from './types';

const COMPONENTS: FeeComponentType[] = ['SERVICE_FEE', 'GOVERNMENT_FEE', 'THIRD_PARTY_FEE'];

/** One editable line as the form holds it (everything is text while it is being typed). */
export interface LineFormValue {
  serviceId?: string | null;
  description: string;
  component: FeeComponentType;
  quantity: string;
  unitAmount: string;
  discountAmount: string;
  taxRatePercent: string;
}
export const emptyLine = (component: FeeComponentType = 'SERVICE_FEE'): LineFormValue => ({ serviceId: null, description: '', component, quantity: '1', unitAmount: '', discountAmount: '', taxRatePercent: '' });

const trimNumber = (value: string) => (value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value);
/** Saved lines back into the form. The stored tax rate is kept explicit so that saving again changes nothing by accident. */
export const linesToForm = (items: LineItem[]): LineFormValue[] =>
  [...items]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((item) => ({
      serviceId: item.serviceId,
      description: item.description,
      component: item.component,
      quantity: trimNumber(item.quantity),
      unitAmount: item.unitAmount,
      discountAmount: Number(item.discountAmount) > 0 ? item.discountAmount : '',
      taxRatePercent: trimNumber(item.taxRatePercent),
    }));

/**
 * The tax rate a free-form line gets when its own rate is left empty: the centre's rate for
 * taxable fee components, 0 for the others. Viewers who may not read the fee settings get the
 * standard treatment (service fee taxable) for the preview; the API applies the real setting.
 */
export function useDefaultTaxRates(): { rates: Record<FeeComponentType, string>; centreRate: string | null } {
  const api = useFinApi();
  const session = useSession();
  const tenant = useQuery({ queryKey: finKeys.tenant, queryFn: ({ signal }) => api.tenant(signal), staleTime: 5 * 60_000 });
  const mayReadSettings = session.hasAnyPermission(['finance.settings', 'report.financial', 'payment.reconcile']);
  const components = useQuery({ queryKey: finKeys.feeComponents, queryFn: ({ signal }) => api.feeComponents.get(signal), staleTime: 5 * 60_000, enabled: mayReadSettings });
  return React.useMemo(() => {
    const centreRate = tenant.data?.taxRatePercent ?? null;
    const rate = centreRate ?? '0';
    const taxable = (type: FeeComponentType) => components.data?.components.find((c) => c.type === type)?.taxable ?? type === 'SERVICE_FEE';
    return { centreRate, rates: { SERVICE_FEE: taxable('SERVICE_FEE') ? rate : '0', GOVERNMENT_FEE: taxable('GOVERNMENT_FEE') ? rate : '0', THIRD_PARTY_FEE: taxable('THIRD_PARTY_FEE') ? rate : '0' } };
  }, [tenant.data, components.data]);
}

/** Live preview of the totals of the lines in the form (name `items`). */
export function useLinesPreview(rates: Record<FeeComponentType, string>): TotalsPreview {
  const { control } = useFormContext();
  const items = (useWatch({ control, name: 'items' }) ?? []) as LineDraft[];
  return React.useMemo(() => previewTotals(items, rates), [items, rates]);
}

/**
 * Editor for the lines of a draft quotation or invoice. Lives inside a <Form> whose values
 * have an `items` array of LineFormValue. Each line says which fee component it is, because
 * that decides tax, discounts and whether the money is the centre's revenue at all.
 */
export function LineEditor({ currency, rates, allowDiscount = true }: { currency: string; rates: Record<FeeComponentType, string>; allowDiscount?: boolean }) {
  const { t, formatNumber } = useI18n();
  const { control, setValue, getValues } = useFormContext();
  const { fields, append, remove } = useFieldArray({ control, name: 'items' });
  const items = (useWatch({ control, name: 'items' }) ?? []) as LineFormValue[];

  const componentOptions = COMPONENTS.map((c) => ({ value: c, label: t(`fin.components.${c}`) }));

  return (
    <div className="space-y-4">
      <ol className="space-y-4">
        {fields.map((field, index) => {
          const line = items[index] ?? emptyLine();
          const preview = previewLine(line, rates);
          const passThrough = line.component !== 'SERVICE_FEE';
          return (
            <li key={field.id} className="rounded-lg border bg-card p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-muted-foreground">{t('fin.lines.lineNumber', { number: formatNumber(index + 1) })}</p>
                <Button variant="ghost" size="sm" onClick={() => remove(index)} disabled={fields.length <= 1} className="text-muted-foreground">
                  <Trash2 aria-hidden="true" />
                  {t('fin.lines.remove')}
                </Button>
              </div>
              <div className="grid gap-4 sm:grid-cols-12">
                <FormField name={`items.${index}.description`} label={t('fin.lines.description')} required className="sm:col-span-8">
                  {(f) => <Input {...f} autoComplete="off" maxLength={300} dir="auto" />}
                </FormField>
                <FormField name={`items.${index}.component`} label={t('fin.lines.component')} required className="sm:col-span-4">
                  {(f) => (
                    <Select
                      {...f}
                      onValueChange={(value) => {
                        f.onChange(value);
                        // Discounts exist on the centre's own fee only: moving a line to a pass-through fee drops its discount.
                        if (value !== 'SERVICE_FEE' && getValues(`items.${index}.discountAmount`)) setValue(`items.${index}.discountAmount`, '', { shouldDirty: true });
                      }}
                      options={componentOptions}
                    />
                  )}
                </FormField>
                <FormField name={`items.${index}.quantity`} label={t('fin.lines.quantity')} required className="col-span-1 sm:col-span-2">
                  {(f) => <Input {...f} inputMode="decimal" autoComplete="off" dir="ltr" className="tabular text-end" />}
                </FormField>
                <FormField name={`items.${index}.unitAmount`} label={t('fin.lines.unitAmount')} required className="sm:col-span-3">
                  {(f) => <MoneyInput {...f} currency={currency} />}
                </FormField>
                {allowDiscount ? (
                  <FormField name={`items.${index}.discountAmount`} label={t('fin.lines.discount')} optional={!passThrough} className="sm:col-span-3" hint={passThrough ? t('fin.lines.noDiscountOnPassThrough') : undefined}>
                    {(f) => <MoneyInput {...f} currency={currency} disabled={passThrough} />}
                  </FormField>
                ) : null}
                <FormField name={`items.${index}.taxRatePercent`} label={t('fin.lines.taxRate')} className="sm:col-span-2">
                  {(f) => (
                    <Input
                      {...f}
                      inputMode="decimal"
                      autoComplete="off"
                      dir="ltr"
                      placeholder={formatNumber(rates[line.component], { maximumFractionDigits: 2 })}
                      endAdornment={<span className="pe-1.5 text-sm">%</span>}
                      className="tabular"
                    />
                  )}
                </FormField>
                <div className={allowDiscount ? 'sm:col-span-2' : 'sm:col-span-5'}>
                  <p className="text-sm font-medium leading-5 text-foreground">{t('fin.lines.lineTotal')}</p>
                  <p className="mt-1.5 flex h-10 items-center justify-end text-base font-semibold" aria-live="polite">
                    {preview.valid ? <Money amount={fromMinorUnits(preview.total)} currency={currency} /> : <span className="font-normal text-muted-foreground">–</span>}
                  </p>
                </div>
              </div>
              {preview.discountProblem === 'EXCEEDS_LINE' ? (
                <p role="alert" className="mt-3 text-sm text-destructive-text">
                  {t('fin.lines.discountTooLarge')}
                </p>
              ) : null}
              {passThrough ? <p className="mt-3 text-sm text-muted-foreground">{t(line.component === 'GOVERNMENT_FEE' ? 'fin.lines.governmentNote' : 'fin.lines.thirdPartyNote')}</p> : null}
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => append(emptyLine('SERVICE_FEE'))}>
          <Plus aria-hidden="true" />
          {t('fin.lines.addService')}
        </Button>
        <Button variant="outline" onClick={() => append(emptyLine('GOVERNMENT_FEE'))}>
          <Plus aria-hidden="true" />
          {t('fin.lines.addGovernment')}
        </Button>
        <Button variant="outline" onClick={() => append(emptyLine('THIRD_PARTY_FEE'))}>
          <Plus aria-hidden="true" />
          {t('fin.lines.addThirdParty')}
        </Button>
      </div>
    </div>
  );
}

/** The preview card next to the editor. */
export function LinesPreview({ currency, rates, centreRate }: { currency: string; rates: Record<FeeComponentType, string>; centreRate: string | null }) {
  const { t, formatNumber } = useI18n();
  const totals = useLinesPreview(rates);
  return (
    <div className="space-y-3">
      <FeeBreakdown totals={{ ...totals, currency }} preview />
      {!totals.complete ? <p className="text-sm text-muted-foreground">{t('fin.lines.previewIncomplete')}</p> : null}
      <Alert tone="info">
        {t('fin.lines.previewNote')}
        {centreRate !== null ? ` ${t('fin.lines.previewTaxNote', { rate: formatNumber(centreRate, { maximumFractionDigits: 2 }) })}` : ''}
      </Alert>
    </div>
  );
}

/** Form lines -> API lines: empty optional fields are left out so that the API applies its defaults. */
export function linesToApi(items: Array<{ serviceId?: string | null; description: string; component: FeeComponentType; quantity?: string; unitAmount: string; discountAmount?: string; taxRatePercent?: string }>) {
  return items.map((item) => ({
    ...(item.serviceId ? { serviceId: item.serviceId } : {}),
    description: item.description,
    component: item.component,
    quantity: item.quantity || '1',
    unitAmount: item.unitAmount,
    discountAmount: item.component === 'SERVICE_FEE' && item.discountAmount ? item.discountAmount : '0',
    ...(item.taxRatePercent !== undefined && item.taxRatePercent !== '' ? { taxRatePercent: item.taxRatePercent } : {}),
  }));
}
