'use client';

import * as React from 'react';
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import { PREFILL_SOURCES, type FormField, type FormFieldType, type FormSchema, type FormStep } from '@typease/types';
import { FORM_FIELD_TYPES, FORM_LIMITS, serviceFormSchema } from '@typease/validation';
import {
  Badge, Button, Card, Checkbox, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Input, Select, Textarea, cn, localiseValidationMessage, useI18n,
} from '@typease/ui';
import { Field, MoveButtons, SwitchRow, moveItem } from './common';

/**
 * The dynamic form builder of a service: steps, fields of every type, labels
 * in English and Arabic, options, "show only when", prefill source and
 * validation limits. It edits a `FormSchema` held by the parent and reports
 * the problems `serviceFormSchema` (the API's own check) finds, on the field
 * they belong to.
 */

const OPTION_TYPES: FormFieldType[] = ['select', 'multiselect', 'radio'];
const TEXT_TYPES: FormFieldType[] = ['text', 'textarea'];
const NONE = '__none__';

const camel = (text: string) => {
  const words = text
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5);
  const joined = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join('');
  return /^[A-Za-z]/.test(joined) ? joined.slice(0, 40) : '';
};
const slug = (text: string) =>
  text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);

function uniqueKey(base: string, taken: Set<string>): string {
  const root = base || 'field';
  if (!taken.has(root)) return root;
  for (let n = 2; ; n++) if (!taken.has(`${root}${n}`)) return `${root}${n}`;
}

/** Problems of a form, keyed by where they belong: "s0" (step), "s0.f2" (field), "" (whole form). */
export function formProblems(schema: FormSchema): Record<string, string[]> {
  const result = serviceFormSchema.safeParse(schema);
  const out: Record<string, string[]> = {};
  if (result.success) return out;
  for (const issue of result.error.issues) {
    const [a, s, b, f] = issue.path;
    const where = a === 'steps' && typeof s === 'number' ? (b === 'fields' && typeof f === 'number' ? `s${s}.f${f}` : `s${s}`) : '';
    const prop = String(issue.path[issue.path.length - 1] ?? '');
    (out[where] ??= []).push(`${prop && typeof issue.path[issue.path.length - 1] === 'string' ? `${prop}: ` : ''}${issue.message}`);
  }
  return out;
}

export interface FormBuilderProps {
  schema: FormSchema;
  onChange: (schema: FormSchema) => void;
  disabled?: boolean;
}

export function FormBuilder({ schema, onChange, disabled }: FormBuilderProps) {
  const i18n = useI18n();
  const { t } = i18n;
  const [open, setOpen] = React.useState<string | null>(null);
  /** Fields added in this session: their key follows the label until the key is edited by hand. */
  const fresh = React.useRef(new Set<string>());
  const problems = React.useMemo(() => formProblems(schema), [schema]);
  const say = (message: string) => {
    const [prop, ...rest] = message.split(': ');
    return rest.length ? `${prop}: ${localiseValidationMessage(rest.join(': '), i18n)}` : localiseValidationMessage(message, i18n);
  };

  const steps = schema.steps;
  const allKeys = () => new Set(steps.flatMap((s) => s.fields.map((f) => f.key)));
  const totalFields = steps.reduce((n, s) => n + s.fields.length, 0);

  const setStep = (index: number, patch: Partial<FormStep>) => onChange({ steps: steps.map((s, i) => (i === index ? { ...s, ...patch } : s)) });

  const addStep = () => {
    const taken = new Set(steps.map((s) => s.key));
    onChange({ steps: [...steps, { key: uniqueKey(`step${steps.length + 1}`, taken), title: t('ops.forms.builder.newStepTitle', { number: steps.length + 1 }), fields: [] }] });
  };

  const addField = (stepIndex: number, type: FormFieldType) => {
    const key = uniqueKey('field', allKeys());
    fresh.current.add(key);
    const field: FormField = { key, label: '', type, ...(OPTION_TYPES.includes(type) ? { options: [{ value: 'option_1', label: '' }] } : {}) };
    setStep(stepIndex, { fields: [...steps[stepIndex].fields, field] });
    setOpen(key);
  };

  /** Replaces a field; a changed key is carried into the `showIf` of the fields that depend on it. */
  const setField = (stepIndex: number, fieldIndex: number, next: FormField) => {
    const previous = steps[stepIndex].fields[fieldIndex];
    const renamed = previous.key !== next.key;
    onChange({
      steps: steps.map((s, si) => ({
        ...s,
        fields: s.fields.map((f, fi) => {
          if (si === stepIndex && fi === fieldIndex) return next;
          if (renamed && f.showIf?.field === previous.key) return { ...f, showIf: { ...f.showIf, field: next.key } };
          return f;
        }),
      })),
    });
    if (renamed) {
      if (fresh.current.delete(previous.key)) fresh.current.add(next.key);
      if (open === previous.key) setOpen(next.key);
    }
  };

  const removeField = (stepIndex: number, fieldIndex: number) => {
    const removed = steps[stepIndex].fields[fieldIndex];
    onChange({
      steps: steps.map((s, si) => ({
        ...s,
        fields: s.fields.filter((_, fi) => !(si === stepIndex && fi === fieldIndex)).map((f) => (f.showIf?.field === removed.key ? { ...f, showIf: undefined } : f)),
      })),
    });
  };

  /** Fields that come before a given position: only those may control `showIf`. */
  const earlierFields = (stepIndex: number, fieldIndex: number) => steps.flatMap((s, si) => s.fields.filter((_, fi) => si < stepIndex || (si === stepIndex && fi < fieldIndex)));

  return (
    <div className="space-y-4">
      {problems['']?.length ? (
        <ul className="list-disc space-y-1 ps-5 text-sm text-destructive-text">
          {problems[''].map((m, i) => (
            <li key={i}>{say(m)}</li>
          ))}
        </ul>
      ) : null}

      {steps.map((step, si) => (
        <Card key={si} className="p-4 sm:p-5">
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm font-semibold text-muted-foreground">{t('ops.forms.builder.stepNumber', { number: si + 1 })}</p>
            <span className="flex items-center">
              <MoveButtons index={si} count={steps.length} onMove={(from, to) => onChange({ steps: moveItem(steps, from, to) })} name={step.title || t('ops.forms.builder.stepNumber', { number: si + 1 })} disabled={disabled} />
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={disabled || steps.length === 1}
                onClick={() => onChange({ steps: steps.filter((_, i) => i !== si) })}
                aria-label={t('ops.forms.builder.removeStep', { name: step.title })}
                title={t('ops.forms.builder.removeStep', { name: step.title })}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </span>
          </div>
          <div className="mt-2 grid gap-4 sm:grid-cols-2">
            <Field label={t('ops.forms.builder.stepTitle')} required>
              {(p) => <Input {...p} value={step.title} onChange={(e) => setStep(si, { title: e.target.value })} disabled={disabled} dir="ltr" lang="en" />}
            </Field>
            <Field label={t('ops.forms.builder.stepTitleAr')} optional>
              {(p) => <Input {...p} value={step.titleAr ?? ''} onChange={(e) => setStep(si, { titleAr: e.target.value || undefined })} disabled={disabled} dir="rtl" lang="ar" />}
            </Field>
            <Field label={t('ops.forms.builder.stepDescription')} optional className="sm:col-span-2">
              {(p) => <Input {...p} value={step.description ?? ''} onChange={(e) => setStep(si, { description: e.target.value || undefined })} disabled={disabled} dir="auto" />}
            </Field>
          </div>
          {problems[`s${si}`]?.length ? (
            <ul className="mt-2 list-disc space-y-1 ps-5 text-sm text-destructive-text">
              {problems[`s${si}`].map((m, i) => (
                <li key={i}>{say(m)}</li>
              ))}
            </ul>
          ) : null}

          <ul className="mt-4 space-y-2">
            {step.fields.map((field, fi) => {
              const isOpen = open === field.key;
              const issues = problems[`s${si}.f${fi}`] ?? [];
              const name = i18n.pick(field.label, field.labelAr) || t('ops.forms.builder.untitledField');
              return (
                <li key={`${si}-${fi}`} className={cn('rounded-md border', issues.length ? 'border-destructive/50' : '', isOpen && 'bg-muted/30')}>
                  <div className="flex items-center gap-2 px-3 py-2">
                    <button type="button" onClick={() => setOpen(isOpen ? null : field.key)} aria-expanded={isOpen} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-sm text-start outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      {isOpen ? <ChevronUp className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                      <span className="min-w-0 flex-1">
                        <span className={cn('block truncate font-medium', !field.label && 'text-muted-foreground')}>{name}</span>
                        <span className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
                          <span>{t(`ops.forms.types.${field.type}`)}</span>
                          {field.required ? <span>· {t('ops.forms.builder.requiredShort')}</span> : null}
                          {field.showIf ? <span>· {t('ops.forms.builder.conditionalShort')}</span> : null}
                          {field.prefillFrom ? <span>· {t('ops.forms.builder.prefilledShort')}</span> : null}
                        </span>
                      </span>
                      {issues.length ? <Badge tone="danger">{t('ops.forms.builder.needsAttention')}</Badge> : null}
                    </button>
                    <MoveButtons index={fi} count={step.fields.length} onMove={(from, to) => setStep(si, { fields: moveItem(step.fields, from, to) })} name={name} disabled={disabled} />
                    <Button variant="ghost" size="icon-sm" disabled={disabled} onClick={() => removeField(si, fi)} aria-label={t('ops.forms.builder.removeField', { name })} title={t('ops.forms.builder.removeField', { name })}>
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </div>
                  {issues.length ? (
                    <ul className="list-disc space-y-0.5 pb-2 pe-3 ps-10 text-sm text-destructive-text">
                      {issues.map((m, i) => (
                        <li key={i}>{say(m)}</li>
                      ))}
                    </ul>
                  ) : null}
                  {isOpen ? (
                    <div className="border-t p-3 sm:p-4">
                      <FieldEditor
                        field={field}
                        earlier={earlierFields(si, fi)}
                        disabled={disabled}
                        autoKey={fresh.current.has(field.key)}
                        takenKeys={() => {
                          const keys = allKeys();
                          keys.delete(field.key);
                          return keys;
                        }}
                        onKeyEdited={() => fresh.current.delete(field.key)}
                        onChange={(next) => setField(si, fi, next)}
                      />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {step.fields.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">{t('ops.forms.builder.noFields')}</p> : null}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="mt-3" disabled={disabled || step.fields.length >= FORM_LIMITS.fieldsPerStep || totalFields >= FORM_LIMITS.fields}>
                <Plus aria-hidden="true" />
                {t('ops.forms.builder.addField')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
              {FORM_FIELD_TYPES.map((type) => (
                <DropdownMenuItem key={type} onSelect={() => addField(si, type)}>
                  <span>
                    <span className="block">{t(`ops.forms.types.${type}`)}</span>
                    <span className="block text-sm text-muted-foreground">{t(`ops.forms.typeHints.${type}`)}</span>
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </Card>
      ))}

      <Button variant="outline" onClick={addStep} disabled={disabled || steps.length >= FORM_LIMITS.steps}>
        <Plus aria-hidden="true" />
        {t('ops.forms.builder.addStep')}
      </Button>
    </div>
  );
}

function FieldEditor({ field, earlier, disabled, autoKey, takenKeys, onKeyEdited, onChange }: {
  field: FormField;
  earlier: FormField[];
  disabled?: boolean;
  autoKey: boolean;
  takenKeys: () => Set<string>;
  onKeyEdited: () => void;
  onChange: (field: FormField) => void;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<FormField>) => {
    const next = { ...field, ...patch };
    for (const k of Object.keys(next) as Array<keyof FormField>) if (next[k] === undefined || next[k] === '') delete next[k];
    onChange({ ...next, key: next.key ?? field.key, label: next.label ?? '', type: next.type ?? field.type });
  };
  const number = (text: string) => (text.trim() === '' || Number.isNaN(Number(text)) ? undefined : Number(text));
  const hasOptions = OPTION_TYPES.includes(field.type);
  const isText = TEXT_TYPES.includes(field.type);
  const controller = field.showIf ? earlier.find((f) => f.key === field.showIf?.field) : undefined;

  const setType = (type: FormFieldType) => {
    const next: FormField = { ...field, type };
    if (OPTION_TYPES.includes(type)) next.options = field.options?.length ? field.options : [{ value: 'option_1', label: '' }];
    else delete next.options;
    if (!TEXT_TYPES.includes(type)) {
      delete next.maxLength;
      delete next.pattern;
    }
    if (type !== 'number' && type !== 'multiselect' && !TEXT_TYPES.includes(type)) {
      delete next.min;
      delete next.max;
    }
    onChange(next);
  };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t('ops.forms.field.label')} required>
          {(p) => (
            <Input
              {...p}
              value={field.label}
              dir="ltr"
              lang="en"
              disabled={disabled}
              autoFocus={!field.label}
              onChange={(e) => {
                const label = e.target.value;
                // A field added in this session takes its key from the label until the key is edited by hand.
                set(autoKey ? { label, key: uniqueKey(camel(label), takenKeys()) } : { label });
              }}
            />
          )}
        </Field>
        <Field label={t('ops.forms.field.labelAr')} optional>
          {(p) => <Input {...p} value={field.labelAr ?? ''} dir="rtl" lang="ar" disabled={disabled} onChange={(e) => set({ labelAr: e.target.value })} />}
        </Field>
        <Field label={t('ops.forms.field.type')}>
          {(p) => <Select {...p} value={field.type} onValueChange={(v) => setType(v as FormFieldType)} disabled={disabled} options={FORM_FIELD_TYPES.map((type) => ({ value: type, label: t(`ops.forms.types.${type}`) }))} />}
        </Field>
        <Field label={t('ops.forms.field.key')} hint={t('ops.forms.field.keyHint')}>
          {(p) => (
            <Input
              {...p}
              value={field.key}
              dir="ltr"
              className="font-mono text-sm"
              spellCheck={false}
              disabled={disabled}
              onChange={(e) => {
                onKeyEdited();
                onChange({ ...field, key: e.target.value.replace(/[^A-Za-z0-9_]/g, '') });
              }}
            />
          )}
        </Field>
      </div>

      <SwitchRow label={t('ops.forms.field.required')} description={field.type === 'checkbox' ? t('ops.forms.field.requiredCheckbox') : undefined} checked={!!field.required} onCheckedChange={(v) => set({ required: v || undefined })} disabled={disabled} />

      {field.type === 'checkbox' || field.type === 'radio' || field.type === 'multiselect' || field.type === 'date' || field.type === 'country' || field.type === 'phone' ? null : (
        <Field label={t('ops.forms.field.placeholder')} optional>
          {(p) => <Input {...p} value={field.placeholder ?? ''} dir="auto" disabled={disabled} onChange={(e) => set({ placeholder: e.target.value })} />}
        </Field>
      )}
      <Field label={t('ops.forms.field.help')} optional hint={t('ops.forms.field.helpHint')}>
        {(p) => <Textarea {...p} rows={2} value={field.help ?? ''} dir="auto" disabled={disabled} onChange={(e) => set({ help: e.target.value })} />}
      </Field>

      {hasOptions ? <OptionsEditor options={field.options ?? []} disabled={disabled} onChange={(options) => onChange({ ...field, options })} /> : null}

      {/* Validation limits */}
      {field.type === 'number' ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('ops.forms.field.minNumber')} optional>
            {(p) => <Input {...p} type="number" dir="ltr" className="tabular" value={field.min ?? ''} disabled={disabled} onChange={(e) => set({ min: number(e.target.value) })} />}
          </Field>
          <Field label={t('ops.forms.field.maxNumber')} optional>
            {(p) => <Input {...p} type="number" dir="ltr" className="tabular" value={field.max ?? ''} disabled={disabled} onChange={(e) => set({ max: number(e.target.value) })} />}
          </Field>
        </div>
      ) : null}
      {field.type === 'multiselect' ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('ops.forms.field.minChoices')} optional>
            {(p) => <Input {...p} type="number" min={0} dir="ltr" className="tabular" value={field.min ?? ''} disabled={disabled} onChange={(e) => set({ min: number(e.target.value) })} />}
          </Field>
          <Field label={t('ops.forms.field.maxChoices')} optional>
            {(p) => <Input {...p} type="number" min={1} dir="ltr" className="tabular" value={field.max ?? ''} disabled={disabled} onChange={(e) => set({ max: number(e.target.value) })} />}
          </Field>
        </div>
      ) : null}
      {isText ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('ops.forms.field.minLength')} optional>
            {(p) => <Input {...p} type="number" min={0} dir="ltr" className="tabular" value={field.min ?? ''} disabled={disabled} onChange={(e) => set({ min: number(e.target.value) })} />}
          </Field>
          <Field label={t('ops.forms.field.maxLength')} optional>
            {(p) => <Input {...p} type="number" min={1} dir="ltr" className="tabular" value={field.maxLength ?? ''} disabled={disabled} onChange={(e) => set({ maxLength: number(e.target.value) })} />}
          </Field>
          <Field label={t('ops.forms.field.pattern')} optional hint={t('ops.forms.field.patternHint')} className="sm:col-span-2">
            {(p) => <Input {...p} value={field.pattern ?? ''} dir="ltr" className="font-mono text-sm" spellCheck={false} placeholder="[A-Z]{2}[0-9]{6}" disabled={disabled} onChange={(e) => set({ pattern: e.target.value })} />}
          </Field>
        </div>
      ) : null}

      {/* Prefill */}
      <Field label={t('ops.forms.field.prefill')} hint={t('ops.forms.field.prefillHint')}>
        {(p) => (
          <Select
            {...p}
            value={field.prefillFrom ?? NONE}
            disabled={disabled}
            onValueChange={(v) => set({ prefillFrom: v === NONE ? undefined : v })}
            options={[{ value: NONE, label: t('ops.forms.field.prefillNone') }, ...PREFILL_SOURCES.map((source) => ({ value: source, label: t(`ops.forms.prefill.${source.split('.')[1]}`) }))]}
          />
        )}
      </Field>

      {/* Show only when */}
      <div className="space-y-3">
        <Field label={t('ops.forms.field.showIf')} hint={earlier.length ? t('ops.forms.field.showIfHint') : t('ops.forms.field.showIfNoEarlier')}>
          {(p) => (
            <Select
              {...p}
              value={field.showIf?.field ?? NONE}
              disabled={disabled || !earlier.length}
              onValueChange={(v) => {
                if (v === NONE) return set({ showIf: undefined });
                const target = earlier.find((f) => f.key === v);
                set({ showIf: { field: v, in: target?.type === 'checkbox' ? [true] : target?.options?.length ? [target.options[0].value] : [] } });
              }}
              options={[{ value: NONE, label: t('ops.forms.field.showAlways') }, ...earlier.map((f) => ({ value: f.key, label: f.label || f.key }))]}
            />
          )}
        </Field>
        {field.showIf ? (
          <ShowIfValues
            controller={controller}
            values={field.showIf.in}
            disabled={disabled}
            onChange={(values) => onChange({ ...field, showIf: { field: field.showIf!.field, in: values } })}
          />
        ) : null}
      </div>

      <SwitchRow label={t('ops.forms.field.sensitive')} description={t('ops.forms.field.sensitiveHint')} checked={!!field.sensitive} onCheckedChange={(v) => set({ sensitive: v || undefined })} disabled={disabled} />
    </div>
  );
}

function OptionsEditor({ options, disabled, onChange }: { options: NonNullable<FormField['options']>; disabled?: boolean; onChange: (options: NonNullable<FormField['options']>) => void }) {
  const { t } = useI18n();
  const setOption = (index: number, patch: Partial<NonNullable<FormField['options']>[number]>) =>
    onChange(
      options.map((o, i) => {
        if (i !== index) return o;
        const next = { ...o, ...patch };
        if (next.labelAr === '') delete next.labelAr;
        return next;
      }),
    );
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-foreground">{t('ops.forms.options.title')}</legend>
      <p className="text-sm text-muted-foreground">{t('ops.forms.options.hint')}</p>
      {options.map((option, index) => (
        <div key={index} className="grid grid-cols-1 items-center gap-2 rounded-md border bg-card p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_auto]">
          <Input
            aria-label={t('ops.forms.options.label')}
            placeholder={t('ops.forms.options.label')}
            value={option.label}
            dir="ltr"
            lang="en"
            disabled={disabled}
            onChange={(e) => {
              const label = e.target.value;
              // The stored value follows the label until it was given a value of its own.
              const follows = option.value === '' || option.value === slug(option.label) || /^option_\d+$/.test(option.value);
              setOption(index, follows ? { label, value: slug(label) || option.value } : { label });
            }}
          />
          <Input aria-label={t('ops.forms.options.labelAr')} placeholder={t('ops.forms.options.labelAr')} value={option.labelAr ?? ''} dir="rtl" lang="ar" disabled={disabled} onChange={(e) => setOption(index, { labelAr: e.target.value })} />
          <Input aria-label={t('ops.forms.options.value')} placeholder={t('ops.forms.options.value')} value={option.value} dir="ltr" className="font-mono text-sm" spellCheck={false} disabled={disabled} onChange={(e) => setOption(index, { value: e.target.value })} />
          <span className="flex justify-end">
            <MoveButtons index={index} count={options.length} onMove={(from, to) => onChange(moveItem(options, from, to))} name={option.label || option.value} disabled={disabled} />
            <Button variant="ghost" size="icon-sm" disabled={disabled || options.length === 1} onClick={() => onChange(options.filter((_, i) => i !== index))} aria-label={t('ops.forms.options.remove', { name: option.label || option.value })} title={t('ops.forms.options.remove', { name: option.label || option.value })}>
              <Trash2 aria-hidden="true" />
            </Button>
          </span>
        </div>
      ))}
      <Button variant="ghost" size="sm" disabled={disabled || options.length >= FORM_LIMITS.options} onClick={() => onChange([...options, { value: `option_${options.length + 1}`, label: '' }])}>
        <Plus aria-hidden="true" />
        {t('ops.forms.options.add')}
      </Button>
    </fieldset>
  );
}

function ShowIfValues({ controller, values, disabled, onChange }: { controller: FormField | undefined; values: Array<string | number | boolean>; disabled?: boolean; onChange: (values: Array<string | number | boolean>) => void }) {
  const { t } = useI18n();
  const id = React.useId();
  if (!controller) return <p className="text-sm text-destructive-text">{t('ops.forms.field.showIfMissing')}</p>;
  if (controller.type === 'checkbox') {
    return (
      <Field label={t('ops.forms.field.showIfWhen', { name: controller.label || controller.key })}>
        {(p) => (
          <Select
            {...p}
            value={values[0] === false ? 'false' : 'true'}
            disabled={disabled}
            onValueChange={(v) => onChange([v === 'true'])}
            options={[
              { value: 'true', label: t('ops.forms.field.ticked') },
              { value: 'false', label: t('ops.forms.field.notTicked') },
            ]}
          />
        )}
      </Field>
    );
  }
  if (controller.options?.length) {
    const list = values.map(String);
    return (
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-foreground">{t('ops.forms.field.showIfWhen', { name: controller.label || controller.key })}</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {controller.options.map((o) => (
            <label key={o.value} htmlFor={`${id}-${o.value}`} className="flex cursor-pointer items-center gap-2 text-base">
              <Checkbox id={`${id}-${o.value}`} checked={list.includes(o.value)} disabled={disabled} onCheckedChange={(on) => onChange(on === true ? [...list, o.value] : list.filter((v) => v !== o.value))} />
              {o.label || o.value}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }
  return (
    <Field label={t('ops.forms.field.showIfWhen', { name: controller.label || controller.key })} hint={t('ops.forms.field.showIfListHint')}>
      {(p) => (
        <Input
          {...p}
          defaultValue={values.join(', ')}
          dir="auto"
          disabled={disabled}
          onChange={(e) =>
            onChange(
              e.target.value
                .split(/[,،]/)
                .map((v) => v.trim())
                .filter(Boolean)
                .map((v) => (controller.type === 'number' && !Number.isNaN(Number(v)) ? Number(v) : v)),
            )
          }
        />
      )}
    </Field>
  );
}
