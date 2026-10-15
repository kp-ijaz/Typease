'use client';

import * as React from 'react';
import type { FormField as SchemaField, FormSchema } from '@typease/types';
import { buildFormValidator, formFields, visibleFormFieldKeys } from '@typease/validation';
import { fieldErrorsOf, isApiError } from '@typease/api-client';
import {
  Badge, Checkbox, ChoiceLabel, Combobox, CountrySelect, DatePicker, Input, Label, PhoneInput, RadioGroup, RadioGroupItem, Select, Textarea, cn, useI18n, type I18nValue,
} from '@typease/ui';
import type { FormFieldValue } from '@/lib/types';

export type FormValuesState = Record<string, unknown>;
export type FormErrors = Record<string, string>;

const KNOWN_TYPES = new Set(['text', 'textarea', 'number', 'date', 'email', 'phone', 'select', 'multiselect', 'checkbox', 'radio', 'country']);

/** A field type this version of the app does not know is edited and checked as plain text; the server has the last word. */
function clientSchema(schema: FormSchema): FormSchema {
  return { steps: (schema.steps ?? []).map((step) => ({ ...step, fields: (step.fields ?? []).map((f) => (KNOWN_TYPES.has(f.type) ? f : { ...f, type: 'text' as const, pattern: undefined })) })) };
}

const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

/** What the inputs hold -> what the API stores: numbers typed as text become numbers. */
function normalise(field: SchemaField, value: unknown): unknown {
  if (field.type === 'number' && typeof value === 'string') {
    const text = value.trim().replace(/,/g, '');
    return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : value;
  }
  return value;
}

/** The validator writes English sentences that start with the field label; map the known endings to the dictionary. */
function localiseFormMessage(message: string, field: SchemaField | undefined, i18n: Pick<I18nValue, 't'>): string {
  const { t } = i18n;
  const rest = field && message.startsWith(field.label) ? message.slice(field.label.length).replace(/^[:\s]+/, '') : message;
  let m: RegExpExecArray | null;
  if (/^is required/.test(rest)) return t('validation.required');
  if (/^must be a number/.test(rest)) return t('my.form.errors.number');
  if ((m = /^must be at least (-?[\d.]+)/.exec(rest))) return t('validation.minNumber', { min: m[1] });
  if ((m = /^must be at most (-?[\d.]+)/.exec(rest))) return t('validation.maxNumber', { max: m[1] });
  if ((m = /^can have at most (\d+) characters/.exec(rest))) return t('validation.maxLength', { max: m[1] });
  if ((m = /^needs at least (\d+) characters/.exec(rest))) return t('validation.minLength', { min: m[1] });
  if (/^is not in the expected format/.test(rest)) return t('my.form.errors.format');
  if (/^must be a date/.test(rest)) return t('validation.date');
  if (/^must be a valid email/.test(rest)) return t('validation.email');
  if (/^must be in international format/.test(rest)) return t('validation.phone');
  if (/^must be a country code/.test(rest) || /^choose (one|only)/.test(rest) || /^must be a list/.test(rest)) return t('validation.option');
  if ((m = /^choose at least (\d+)/.exec(rest))) return t('my.form.errors.chooseMin', { count: m[1] });
  if ((m = /^choose at most (\d+)/.exec(rest))) return t('my.form.errors.chooseMax', { count: m[1] });
  if (/^must be ticked/.test(rest)) return t('validation.required');
  return message;
}

export interface FormCheck {
  ok: boolean;
  errors: FormErrors;
  /** Normalised values of the visible, filled-in fields. */
  values: FormValuesState;
}

/**
 * Checks values against the service's form with the SAME rules the API applies
 * (`buildFormValidator`). `partial` = a draft: required fields may still be empty.
 */
export function checkForm(schema: FormSchema | null | undefined, values: FormValuesState, partial: boolean, i18n: Pick<I18nValue, 't'>): FormCheck {
  if (!schema || !formFields(schema).length) return { ok: true, errors: {}, values: {} };
  const safe = clientSchema(schema);
  const fields = formFields(safe);
  const input: FormValuesState = {};
  for (const field of fields) if (Object.prototype.hasOwnProperty.call(values, field.key)) input[field.key] = normalise(field, values[field.key]);
  const result = buildFormValidator(safe, { partial }).safeParse(input);
  if (result.success) return { ok: true, errors: {}, values: result.data };
  const errors: FormErrors = {};
  for (const issue of result.error.issues) {
    const key = String(issue.path[0] ?? '');
    if (key && !(key in errors)) errors[key] = localiseFormMessage(issue.message, fields.find((f) => f.key === key), i18n);
  }
  return { ok: false, errors, values: input };
}

/**
 * The body of PUT /requests/:id/fields: every visible value, and `null` for values
 * that were stored before and are now empty or hidden (so the server clears them).
 */
export function fieldsPayload(schema: FormSchema | null | undefined, values: FormValuesState, stored: FormValuesState): FormValuesState {
  if (!schema) return {};
  const visible = new Set(visibleFormFieldKeys(clientSchema(schema), Object.fromEntries(formFields(schema).map((f) => [f.key, normalise(f, values[f.key])]))));
  const out: FormValuesState = {};
  for (const field of formFields(schema)) {
    const value = normalise(field, values[field.key]);
    const had = Object.prototype.hasOwnProperty.call(stored, field.key) && !isBlank(stored[field.key]);
    if (!visible.has(field.key) || isBlank(value)) {
      // An unticked optional checkbox is a value (false), not "empty".
      if (visible.has(field.key) && field.type === 'checkbox' && value === false) out[field.key] = false;
      else if (had) out[field.key] = null;
      continue;
    }
    out[field.key] = typeof value === 'string' ? value.trim() : value;
  }
  return out;
}

/** Field errors of a 422 FORM_INVALID answer (`details: [{ field, code, message }]`), in the UI language where we can. */
export function formErrorsOf(error: unknown, schema: FormSchema | null | undefined, i18n: Pick<I18nValue, 't'>): FormErrors {
  if (!isApiError(error) || error.code !== 'FORM_INVALID') return {};
  const fields = schema ? formFields(schema) : [];
  const raw = fieldErrorsOf(error);
  const out: FormErrors = {};
  for (const [key, message] of Object.entries(raw)) if (key) out[key] = localiseFormMessage(message.replace(/\.$/, ''), fields.find((f) => f.key === key), i18n);
  return out;
}

/** Values as text for the read-only view of the form. */
export function displayFormValue(field: SchemaField, value: unknown, i18n: Pick<I18nValue, 't' | 'pick' | 'formatDate' | 'formatNumber'>, countryLabel: (code: string) => string): string {
  // An unticked box is an answer ("no"), not a gap.
  if (field.type === 'checkbox') return value === true ? i18n.t('common.yes') : i18n.t('common.no');
  if (isBlank(value)) return '';
  const option = (v: unknown) => {
    const o = (field.options ?? []).find((x) => x.value === String(v));
    return o ? i18n.pick(o.label, o.labelAr) : String(v);
  };
  switch (field.type) {
    case 'select':
    case 'radio':
      return option(value);
    case 'multiselect':
      return Array.isArray(value) ? value.map(option).join(', ') : option(value);
    case 'date':
      return typeof value === 'string' ? i18n.formatDate(value) : String(value);
    case 'number':
      return typeof value === 'number' ? i18n.formatNumber(value, { maximumFractionDigits: 6 }) : String(value);
    case 'country':
      return countryLabel(String(value));
    default:
      return Array.isArray(value) ? value.join(', ') : String(value);
  }
}

export interface DynamicFormProps {
  schema: FormSchema;
  values: FormValuesState;
  onChange: (key: string, value: unknown) => void;
  errors?: FormErrors;
  /** Where each stored value came from: values copied from the customer's profile are marked so they get checked. */
  sources?: FormFieldValue[];
  disabled?: boolean;
  /** Called when a field is left: the page uses it to save the draft. */
  onBlurField?: (key: string) => void;
  className?: string;
}

/**
 * Renders a service's dynamic form from its FormSchema: sections, every field
 * type, `showIf`, required markers, help texts and English / Arabic labels.
 * Controlled: the page owns the values, validates them with `checkForm` and
 * decides when to save.
 */
export function DynamicForm({ schema, values, onChange, errors = {}, sources, disabled, onBlurField, className }: DynamicFormProps) {
  const { pick } = useI18n();
  const visible = React.useMemo(() => {
    const normalised = Object.fromEntries(formFields(schema).map((f) => [f.key, normalise(f, values[f.key])]));
    return new Set(visibleFormFieldKeys(clientSchema(schema), normalised));
  }, [schema, values]);
  const sourceOf = React.useMemo(() => new Map((sources ?? []).map((s) => [s.key, s])), [sources]);
  const steps = (schema.steps ?? []).filter((step) => (step.fields ?? []).some((f) => visible.has(f.key)));
  const titled = steps.length > 1 || steps.some((s) => s.title);
  return (
    <div className={cn('space-y-8', className)}>
      {steps.map((step) => (
        <fieldset key={step.key} className="space-y-4" disabled={disabled}>
          {titled && step.title ? <legend className="text-md font-semibold text-foreground">{pick(step.title, step.titleAr)}</legend> : null}
          {step.description ? (
            <p className="!mt-1 text-sm text-muted-foreground">
              <bdi>{step.description}</bdi>
            </p>
          ) : null}
          <div className="grid gap-x-5 gap-y-5 sm:grid-cols-2">
            {step.fields
              .filter((f) => visible.has(f.key))
              .map((field) => (
                <DynamicField
                  key={field.key}
                  field={field}
                  value={values[field.key]}
                  onChange={(v) => onChange(field.key, v)}
                  onBlur={() => onBlurField?.(field.key)}
                  error={errors[field.key]}
                  stored={sourceOf.get(field.key)}
                  disabled={disabled}
                />
              ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

function DynamicField({ field, value, onChange, onBlur, error, stored, disabled }: {
  field: SchemaField;
  value: unknown;
  onChange: (value: unknown) => void;
  onBlur: () => void;
  error?: string;
  stored?: FormFieldValue;
  disabled?: boolean;
}) {
  const { t, pick } = useI18n();
  const id = React.useId();
  const label = pick(field.label, field.labelAr);
  const describedBy = error ? `${id}-error` : field.help ? `${id}-hint` : undefined;
  const common = { id, disabled, 'aria-invalid': !!error, 'aria-describedby': describedBy, 'aria-required': field.required || undefined } as const;
  const text = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  const options = (field.options ?? []).map((o) => ({ value: o.value, label: pick(o.label, o.labelAr) }));
  // A value that came from the customer's file and was not touched since: say so, it should be double-checked.
  const prefilled = stored?.source === 'PREFILL' && String(stored.value ?? '') === text.trim();
  const wide = field.type === 'textarea' || field.type === 'multiselect' || (field.type === 'radio' && options.length > 3);

  let control: React.ReactNode;
  switch (field.type) {
    case 'textarea':
      control = <Textarea {...common} value={text} placeholder={field.placeholder} maxLength={field.maxLength} onChange={(e) => onChange(e.target.value)} onBlur={onBlur} dir="auto" />;
      break;
    case 'number':
      control = <Input {...common} value={text} placeholder={field.placeholder} inputMode="decimal" dir="ltr" className="tabular" onChange={(e) => onChange(e.target.value)} onBlur={onBlur} />;
      break;
    case 'date':
      control = <DatePicker {...common} value={text} onChange={(v) => onChange(v)} onBlur={onBlur} />;
      break;
    case 'email':
      control = <Input {...common} type="email" inputMode="email" autoCapitalize="none" spellCheck={false} dir="ltr" value={text} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} onBlur={onBlur} />;
      break;
    case 'phone':
      control = <PhoneInput {...common} value={text} onChange={(v) => onChange(v)} onBlur={onBlur} />;
      break;
    case 'country':
      control = <CountrySelect {...common} value={text} onValueChange={(v) => onChange(v)} onBlur={onBlur} />;
      break;
    case 'select':
      control =
        options.length > 10 ? (
          <Combobox {...common} value={text} options={options} clearable={!field.required} onValueChange={(v) => onChange(v)} onBlur={onBlur} />
        ) : (
          <Select {...common} value={text} options={options} placeholder={field.placeholder ?? t('common.selectPlaceholder')} onValueChange={(v) => onChange(v)} onBlur={onBlur} />
        );
      break;
    case 'radio':
      control = (
        <RadioGroup id={id} value={text} onValueChange={(v) => onChange(v)} aria-label={label} aria-describedby={describedBy} disabled={disabled} className={options.length > 3 ? 'grid gap-2.5 sm:grid-cols-2' : 'flex flex-wrap gap-x-8 gap-y-2'}>
          {options.map((o) => (
            <ChoiceLabel key={o.value} htmlFor={`${id}-${o.value}`} control={<RadioGroupItem id={`${id}-${o.value}`} value={o.value} aria-invalid={!!error} />} label={o.label} />
          ))}
        </RadioGroup>
      );
      break;
    case 'multiselect': {
      const chosen = Array.isArray(value) ? (value as string[]) : [];
      control = (
        <div role="group" aria-label={label} aria-describedby={describedBy} className="grid gap-2.5 sm:grid-cols-2">
          {options.map((o) => (
            <ChoiceLabel
              key={o.value}
              htmlFor={`${id}-${o.value}`}
              control={
                <Checkbox
                  id={`${id}-${o.value}`}
                  disabled={disabled}
                  checked={chosen.includes(o.value)}
                  onCheckedChange={(on) => {
                    onChange(on === true ? [...chosen, o.value] : chosen.filter((v) => v !== o.value));
                    onBlur();
                  }}
                />
              }
              label={o.label}
            />
          ))}
        </div>
      );
      break;
    }
    case 'checkbox':
      return (
        <div className="space-y-1.5 sm:col-span-full">
          <ChoiceLabel
            htmlFor={id}
            control={
              <Checkbox
                {...common}
                checked={value === true}
                onCheckedChange={(on) => {
                  onChange(on === true);
                  onBlur();
                }}
              />
            }
            label={
              <>
                {label}
                {field.required ? (
                  <span aria-hidden="true" className="ms-0.5 text-destructive-text">
                    *
                  </span>
                ) : null}
              </>
            }
            description={field.help}
          />
          {error ? (
            <p id={`${id}-error`} role="alert" className="text-sm text-destructive-text">
              {error}
            </p>
          ) : null}
        </div>
      );
    default:
      // "text" and any field type this app version does not know yet.
      control = <Input {...common} value={text} placeholder={field.placeholder} maxLength={field.maxLength} dir="auto" autoComplete="off" onChange={(e) => onChange(e.target.value)} onBlur={onBlur} />;
  }

  return (
    <div className={cn('min-w-0 space-y-1.5', wide && 'sm:col-span-full')}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <Label htmlFor={id} required={field.required}>
          {label}
        </Label>
        {prefilled ? <Badge tone="neutral">{t('my.form.prefilled')}</Badge> : null}
      </div>
      {control}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive-text">
          {error}
        </p>
      ) : field.help ? (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          <bdi>{field.help}</bdi>
        </p>
      ) : null}
    </div>
  );
}
