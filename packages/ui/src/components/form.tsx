'use client';

import * as React from 'react';
import {
  FormProvider, useController, useForm, useFormContext, type DefaultValues, type FieldPath, type FieldValues, type Path, type UseFormProps, type UseFormReturn,
} from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { fieldErrorsOf, isApiError } from '@typease/api-client';
import { cn } from '../lib/cn';
import { useI18n } from '../i18n/provider';
import { describeError } from '../lib/errors';
import { useHeldWhilePressing } from '../lib/press';
import { localiseValidationMessage } from '../lib/validation-messages';
import { Alert } from './alert';
import { Label } from './label';

/** What an emptied text field means to the schema. */
export type EmptyAs = 'undefined' | 'null' | 'keep';

/** Replaces "" (an emptied text field) by undefined or null, at any depth. Arrays keep their length. */
export function normaliseEmpty<T>(value: T, emptyAs: EmptyAs): T {
  if (emptyAs === 'keep') return value;
  const walk = (v: unknown): unknown => {
    if (v === '') return emptyAs === 'null' ? null : undefined;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/**
 * React Hook Form wired to a shared Zod schema from @typease/validation.
 * The same schema validates in the browser and in the API, so the two can not
 * drift apart. Validation runs when a field is left and on submit.
 *
 *   const form = useZodForm(customerSchema, { defaultValues: { type: 'INDIVIDUAL', fullName: '' } });
 *
 * HTML inputs hold "" when they are empty, but the schemas mean "absent" by
 * undefined / null (`email.nullish()` rejects ""). `emptyAs` decides what an
 * emptied field becomes before validation:
 *   "undefined" (default)  create forms: the field is simply left out;
 *   "null"                 edit forms: the stored value is cleared (PATCH with null);
 *   "keep"                 "" is a meaningful value.
 */
export function useZodForm<S extends z.ZodTypeAny>(
  schema: S,
  options: Omit<UseFormProps<z.input<S>, unknown, z.output<S>>, 'resolver'> & { defaultValues?: DefaultValues<z.input<S>>; emptyAs?: EmptyAs } = {},
): UseFormReturn<z.input<S>, unknown, z.output<S>> {
  const { emptyAs = 'undefined', ...rest } = options;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base = React.useMemo(() => zodResolver(schema as any) as any, [schema]);
  return useForm<z.input<S>, unknown, z.output<S>>({
    mode: 'onTouched',
    reValidateMode: 'onChange',
    ...rest,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: ((values: unknown, context: unknown, resolverOptions: unknown) => base(normaliseEmpty(values, emptyAs), context, resolverOptions)) as any,
  });
}

/**
 * Puts the errors of a failed API call onto the form:
 *  - VALIDATION_FAILED / FORM_INVALID field errors go to their fields (and the first one gets focus);
 *  - anything else, and field errors for fields this form does not show, become the form-level message.
 * Everything the person typed stays in place.
 */
export function applyApiErrors<T extends FieldValues>(
  form: UseFormReturn<T, unknown, any>, // eslint-disable-line @typescript-eslint/no-explicit-any
  error: unknown,
  i18n: { t: (key: string, vars?: Record<string, string | number>) => string; has: (key: string) => boolean },
): void {
  const fieldErrors = fieldErrorsOf(error);
  const names = new Set<string>([...((form.control as unknown as { _names?: { mount?: Set<string> } })._names?.mount ?? [])]);
  const unplaced: string[] = [];
  let first: string | null = null;
  for (const [path, message] of Object.entries(fieldErrors)) {
    const text = localiseValidationMessage(message, i18n);
    if (path && names.has(path)) {
      form.setError(path as Path<T>, { type: 'server', message: text });
      first ??= path;
    } else unplaced.push(path ? `${path}: ${text}` : text);
  }
  if (first) {
    try {
      form.setFocus(first as Path<T>);
    } catch {
      /* custom controls without a focusable ref */
    }
  }
  const validation = isApiError(error) && Object.keys(fieldErrors).length > 0;
  const summary = validation ? (unplaced.length ? unplaced.join(' ') : first ? '' : describeError(error, i18n)) : describeError(error, i18n);
  if (summary) form.setError('root.server' as Path<T>, { type: isApiError(error) ? error.code : 'error', message: summary });
}

export interface FormProps<TIn extends FieldValues, TOut> extends Omit<React.FormHTMLAttributes<HTMLFormElement>, 'onSubmit' | 'children'> {
  form: UseFormReturn<TIn, unknown, TOut>;
  /**
   * Called with the parsed values. Await the API call here. If it throws, the
   * error is shown on the form (see applyApiErrors); catch specific codes
   * yourself first when a screen has its own handling (e.g. POSSIBLE_DUPLICATE).
   */
  onSubmit: (values: TOut) => void | Promise<void>;
  children: React.ReactNode;
}

/** `<form>` + context + error handling. Native browser validation bubbles are off: errors appear inline, in the UI language. */
export function Form<TIn extends FieldValues, TOut>({ form, onSubmit, children, className, ...props }: FormProps<TIn, TOut>) {
  const i18n = useI18n();
  const submit = form.handleSubmit(async (values) => {
    form.clearErrors('root' as Path<TIn>);
    try {
      await onSubmit(values as TOut);
    } catch (error) {
      applyApiErrors(form, error, i18n);
    }
  });
  return (
    <FormProvider {...(form as unknown as UseFormReturn<FieldValues>)}>
      <form noValidate onSubmit={submit} className={cn('space-y-5', className)} {...props}>
        {children}
      </form>
    </FormProvider>
  );
}

/** Props to spread on the control inside a FormField. */
export interface FieldControlProps<V = unknown> {
  id: string;
  name: string;
  value: V;
  onChange: (value: V | React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => void;
  onBlur: () => void;
  ref: React.Ref<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  disabled?: boolean;
  'aria-invalid': boolean;
  'aria-describedby': string | undefined;
  'aria-required': boolean | undefined;
}

export interface FormFieldProps<T extends FieldValues = FieldValues> {
  name: FieldPath<T>;
  label: React.ReactNode;
  /** Marks the label and announces the field as required. The schema decides what is actually required. */
  required?: boolean;
  /** Adds "(optional)" to the label: use it sparingly, when most fields of the form are required. */
  optional?: boolean;
  /** A short sentence under the field: format, example, why we ask. */
  hint?: React.ReactNode;
  /** Hide the label visually (it still exists for screen readers). */
  hideLabel?: boolean;
  className?: string;
  /** Render the control: `{(field) => <Input {...field} />}`. */
  children: (field: FieldControlProps<any>) => React.ReactElement; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/**
 * One labelled field: label (with required marker), control, hint and the
 * inline error. The error replaces the hint, is linked with aria-describedby
 * and announced when it appears. When the error is caused by clicking another
 * control (blur validation), it appears after that click, so the control does
 * not move away from under the pointer.
 */
export function FormField<T extends FieldValues = FieldValues>({ name, label, required, optional, hint, hideLabel, className, children }: FormFieldProps<T>) {
  const i18n = useI18n();
  const { control } = useFormContext<T>();
  const { field, fieldState } = useController({ name, control });
  const id = React.useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const current = fieldState.error ? localiseValidationMessage(fieldState.error.message, i18n) : null;
  // A message caused by leaving the field must not move the control that is being clicked (see useHeldWhilePressing).
  const error = useHeldWhilePressing(current);
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id} required={required} optionalText={optional ? i18n.t('common.optional') : undefined} className={hideLabel ? 'sr-only' : undefined}>
        {label}
      </Label>
      {children({
        id,
        name: field.name,
        value: field.value ?? '',
        onChange: field.onChange,
        onBlur: field.onBlur,
        ref: field.ref,
        disabled: field.disabled,
        'aria-invalid': !!current,
        'aria-describedby': error ? errorId : hint ? hintId : undefined,
        'aria-required': required || undefined,
      })}
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-destructive-text">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** The form-level message: a failed save that is not about one field. Place it above the buttons. */
export function FormError({ className }: { className?: string }) {
  const { formState } = useFormContext();
  const message = (formState.errors.root as { server?: { message?: string } } | undefined)?.server?.message;
  if (!message) return null;
  return (
    <Alert tone="danger" live className={className}>
      {message}
    </Alert>
  );
}

/** Button row of a form: primary action at the end, full-width stacked on phones. */
export function FormActions({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end [&>*]:w-full sm:[&>*]:w-auto', className)} {...props} />;
}

/** A titled group of fields inside a longer form. */
export function FormSection({ title, description, children, className }: { title: React.ReactNode; description?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <fieldset className={cn('space-y-4', className)}>
      <legend className="text-md font-semibold text-foreground">{title}</legend>
      {description ? <p className="!mt-1 text-sm text-muted-foreground">{description}</p> : null}
      {children}
    </fieldset>
  );
}
