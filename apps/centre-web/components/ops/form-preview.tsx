'use client';

import * as React from 'react';
import type { FormField, FormSchema } from '@typease/types';
import { buildFormValidator, visibleFormFieldKeys } from '@typease/validation';
import {
  Alert, Button, Checkbox, Combobox, CountrySelect, DatePicker, EmptyState, Input, Label, PhoneInput, RadioGroup, RadioGroupItem, Select, Stepper, Textarea, cn, useI18n,
} from '@typease/ui';
import { FileQuestion } from 'lucide-react';

/**
 * Renders a service form the way a customer meets it: one step at a time,
 * labels in the chosen language, fields that appear and disappear with
 * `showIf`, and the same validation the API applies (`buildFormValidator`).
 * Nothing is saved: it is a preview for the person building the form.
 */
export function FormPreview({ schema, lang }: { schema: FormSchema; lang: 'en' | 'ar' }) {
  const { t } = useI18n();
  const [values, setValues] = React.useState<Record<string, unknown>>({});
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [step, setStep] = React.useState(0);
  const [valid, setValid] = React.useState(false);

  const steps = schema.steps ?? [];
  const current = Math.min(step, Math.max(0, steps.length - 1));
  const visible = React.useMemo(() => new Set(visibleFormFieldKeys(schema, values)), [schema, values]);
  const pick = (en: string | undefined, ar: string | undefined) => (lang === 'ar' ? ar || en || '' : en || ar || '');

  const set = (key: string, value: unknown) => {
    setValid(false);
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  /** Validates with the API's rules and keeps only the problems of the given fields. */
  const check = (keys: string[] | null): boolean => {
    const result = buildFormValidator(schema).safeParse(values);
    const found: Record<string, string> = {};
    if (!result.success) {
      for (const issue of result.error.issues) {
        const key = String(issue.path[0] ?? '');
        if (key && (!keys || keys.includes(key)) && !(key in found)) found[key] = issue.message;
      }
    }
    setErrors(found);
    return Object.keys(found).length === 0;
  };

  if (!steps.length || steps.every((s) => !s.fields.length)) {
    return <EmptyState icon={<FileQuestion />} title={t('ops.forms.preview.emptyTitle')} description={t('ops.forms.preview.emptyText')} />;
  }

  const active = steps[current];
  const shown = active.fields.filter((f) => visible.has(f.key));
  const last = current === steps.length - 1;

  return (
    <div dir={lang === 'ar' ? 'rtl' : 'ltr'} lang={lang} className="space-y-5">
      {steps.length > 1 ? <Stepper steps={steps.map((s) => ({ id: s.key, label: pick(s.title, s.titleAr) }))} current={current} onStepClick={setStep} /> : null}
      <div>
        <h3 className="text-md font-semibold text-foreground">{pick(active.title, active.titleAr)}</h3>
        {active.description ? <p className="mt-1 text-sm text-muted-foreground">{active.description}</p> : null}
      </div>
      {shown.length ? (
        <div className="space-y-4">
          {shown.map((field) => (
            <PreviewField key={field.key} field={field} lang={lang} value={values[field.key]} error={errors[field.key]} onChange={(v) => set(field.key, v)} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t('ops.forms.preview.noVisibleFields')}</p>
      )}
      {valid ? (
        <Alert tone="success" live>
          {t('ops.forms.preview.valid')}
        </Alert>
      ) : null}
      <div className="flex flex-wrap justify-between gap-2">
        <Button variant="outline" disabled={current === 0} onClick={() => setStep(current - 1)}>
          {t('common.back')}
        </Button>
        {last ? (
          <Button onClick={() => setValid(check(null))}>{t('ops.forms.preview.check')}</Button>
        ) : (
          <Button
            onClick={() => {
              if (check(shown.map((f) => f.key))) setStep(current + 1);
            }}
          >
            {t('common.continue')}
          </Button>
        )}
      </div>
    </div>
  );
}

function PreviewField({ field, lang, value, error, onChange }: { field: FormField; lang: 'en' | 'ar'; value: unknown; error?: string; onChange: (value: unknown) => void }) {
  const id = React.useId();
  const pick = (en: string | undefined, ar: string | undefined) => (lang === 'ar' ? ar || en || '' : en || ar || '');
  const label = pick(field.label, field.labelAr) || field.key;
  const noteId = `${id}-note`;
  const aria = { id, 'aria-invalid': !!error, 'aria-describedby': error || field.help ? noteId : undefined, 'aria-required': field.required || undefined };
  const text = typeof value === 'string' ? value : '';
  const options = (field.options ?? []).map((o) => ({ value: o.value, label: pick(o.label, o.labelAr) || o.value }));

  let control: React.ReactNode;
  switch (field.type) {
    case 'textarea':
      control = <Textarea {...aria} value={text} placeholder={field.placeholder} maxLength={field.maxLength} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'number':
      control = <Input {...aria} type="number" inputMode="decimal" dir="ltr" className="tabular" value={typeof value === 'number' || typeof value === 'string' ? value : ''} placeholder={field.placeholder} min={field.min} max={field.max} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'date':
      control = <DatePicker {...aria} value={text} onChange={onChange} />;
      break;
    case 'email':
      control = <Input {...aria} type="email" inputMode="email" dir="ltr" autoCapitalize="none" spellCheck={false} value={text} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'phone':
      control = <PhoneInput {...aria} value={text} onChange={onChange} />;
      break;
    case 'country':
      control = <CountrySelect {...aria} value={text} onValueChange={onChange} />;
      break;
    case 'select':
      control =
        options.length > 10 ? (
          <Combobox {...aria} value={text} onValueChange={onChange} options={options} placeholder={field.placeholder} clearable />
        ) : (
          <Select {...aria} value={text} onValueChange={onChange} options={options} placeholder={field.placeholder} />
        );
      break;
    case 'radio':
      control = (
        <RadioGroup dir={lang === 'ar' ? 'rtl' : 'ltr'} value={text} onValueChange={onChange} aria-labelledby={`${id}-label`} aria-invalid={!!error}>
          {options.map((o) => (
            <label key={o.value} htmlFor={`${id}-${o.value}`} className="flex cursor-pointer items-center gap-2.5 text-base">
              <RadioGroupItem id={`${id}-${o.value}`} value={o.value} />
              {o.label}
            </label>
          ))}
        </RadioGroup>
      );
      break;
    case 'multiselect': {
      const list = Array.isArray(value) ? (value as string[]) : [];
      control = (
        <div role="group" aria-labelledby={`${id}-label`} className="grid gap-2.5">
          {options.map((o) => (
            <label key={o.value} htmlFor={`${id}-${o.value}`} className="flex cursor-pointer items-center gap-2.5 text-base">
              <Checkbox id={`${id}-${o.value}`} checked={list.includes(o.value)} onCheckedChange={(on) => onChange(on === true ? [...list, o.value] : list.filter((v) => v !== o.value))} />
              {o.label}
            </label>
          ))}
        </div>
      );
      break;
    }
    case 'checkbox':
      control = (
        <label htmlFor={id} className="flex cursor-pointer items-start gap-2.5 text-base">
          <span className="flex h-6 items-center">
            <Checkbox {...aria} checked={value === true} onCheckedChange={(on) => onChange(on === true)} />
          </span>
          <span>
            {label}
            {field.required ? (
              <span aria-hidden="true" className="ms-0.5 text-destructive-text">
                *
              </span>
            ) : null}
          </span>
        </label>
      );
      break;
    default:
      control = <Input {...aria} value={text} placeholder={field.placeholder} maxLength={field.maxLength} onChange={(e) => onChange(e.target.value)} />;
  }

  return (
    <div className="space-y-1.5">
      {field.type === 'checkbox' ? null : (
        <Label id={`${id}-label`} htmlFor={field.type === 'radio' || field.type === 'multiselect' ? undefined : id} required={field.required}>
          {label}
        </Label>
      )}
      {control}
      {error ? (
        <p id={noteId} role="alert" className="text-sm text-destructive-text">
          {error}
        </p>
      ) : field.help ? (
        <p id={noteId} className={cn('text-sm text-muted-foreground')}>
          {field.help}
        </p>
      ) : null}
    </div>
  );
}
