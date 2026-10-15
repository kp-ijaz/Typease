'use client';

import * as React from 'react';
import { ChoiceLabel, RadioGroup, RadioGroupItem, useI18n } from '@typease/ui';

/**
 * The one question a refund needs answered in plain words: does the customer still owe the
 * amount afterwards? "cancel" = the charge itself is cancelled (a credit note is issued, the
 * invoice stays settled); "keep" = only the money goes back and the invoice is unpaid again.
 */
export function ChargeChoice({ value, onChange, id, invalid }: { value: 'cancel' | 'keep' | ''; onChange: (value: 'cancel' | 'keep') => void; id?: string; invalid?: boolean }) {
  const { t } = useI18n();
  const base = React.useId();
  return (
    <RadioGroup id={id} value={value} onValueChange={(v) => onChange(v as 'cancel' | 'keep')} aria-label={t('fin.refunds.charge.label')} aria-invalid={invalid} className="gap-3">
      {(['cancel', 'keep'] as const).map((option) => (
        <div key={option} className="rounded-lg border p-3.5 has-[[data-state=checked]]:border-secondary has-[[data-state=checked]]:bg-secondary-soft/50">
          <ChoiceLabel
            htmlFor={`${base}-${option}`}
            control={<RadioGroupItem id={`${base}-${option}`} value={option} />}
            label={<span className="font-medium">{t(`fin.refunds.charge.${option}.label`)}</span>}
            description={
              <>
                {t(`fin.refunds.charge.${option}.text`)}
                <span className="mt-1 block">{t(`fin.refunds.charge.${option}.example`)}</span>
              </>
            }
          />
        </div>
      ))}
    </RadioGroup>
  );
}
