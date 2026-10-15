import { PREFILL_SOURCES } from '@typease/types';
import type { FormField, FormSchema } from '@typease/types';

/**
 * Strict server-side validation of dynamic form values against the published
 * FormSchema of a service. Pure (no database).
 *
 *  - `partial: true` (saving a draft): only the values that are present are
 *    checked; nothing is required yet.
 *  - strict (submission and later edits): required fields must be filled,
 *    unless the field is hidden by `showIf`.
 *
 * Values of hidden fields are ignored and left out of `values`.
 */
export interface FormFieldError {
  field: string;
  code: 'REQUIRED' | 'INVALID_TYPE' | 'INVALID_OPTION' | 'TOO_SHORT' | 'TOO_LONG' | 'TOO_SMALL' | 'TOO_LARGE' | 'INVALID_FORMAT' | 'UNKNOWN_FIELD';
  message: string;
}
export interface FormValidationResult {
  valid: boolean;
  errors: FormFieldError[];
  /** Normalised values of visible fields (trimmed strings, numbers as numbers). */
  values: Record<string, unknown>;
}

const DEFAULT_MAX_LENGTH: Partial<Record<FormField['type'], number>> = { text: 500, textarea: 5000, email: 254, phone: 20 };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^\+[1-9][0-9]{6,14}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const COUNTRY = /^[A-Z]{2,3}$/;

export function formFieldsOf(schema: FormSchema | null | undefined): FormField[] {
  return (schema?.steps ?? []).flatMap((step) => step.fields ?? []);
}

export function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);
}

function isValidDate(value: string): boolean {
  const m = DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** Tenant-supplied patterns are anchored and applied to bounded input only. */
function matchesPattern(pattern: string, value: string): boolean | null {
  try {
    return new RegExp(`^(?:${pattern})$`, 'u').test(value.slice(0, 1000));
  } catch {
    return null; // a broken pattern never blocks a customer
  }
}

/** Which fields are visible for these values (`showIf` chains are followed; cycles count as hidden). */
export function visibleFieldKeys(schema: FormSchema | null | undefined, values: Record<string, unknown>): Set<string> {
  const fields = formFieldsOf(schema);
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const state = new Map<string, boolean | 'visiting'>();
  const visible = (key: string): boolean => {
    const known = state.get(key);
    if (known === 'visiting') return false;
    if (known !== undefined) return known;
    const field = byKey.get(key);
    if (!field) return false;
    if (!field.showIf) {
      state.set(key, true);
      return true;
    }
    state.set(key, 'visiting');
    let result = false;
    if (visible(field.showIf.field)) {
      const controlling = values[field.showIf.field];
      const allowed = field.showIf.in ?? [];
      const matches = (v: unknown) => allowed.some((a) => a === v || (typeof a !== 'boolean' && typeof v !== 'boolean' && v !== null && v !== undefined && String(a) === String(v)));
      result = Array.isArray(controlling) ? controlling.some(matches) : matches(controlling);
    }
    state.set(key, result);
    return result;
  };
  return new Set(fields.filter((f) => visible(f.key)).map((f) => f.key));
}

function checkField(field: FormField, raw: unknown): { value?: unknown; error?: Omit<FormFieldError, 'field'> } {
  const name = field.label || field.key;
  const fail = (code: FormFieldError['code'], message: string) => ({ error: { code, message } });
  const options = (field.options ?? []).map((o) => o.value);

  switch (field.type) {
    case 'text':
    case 'textarea':
    case 'email':
    case 'phone':
    case 'date':
    case 'country':
    case 'select':
    case 'radio': {
      if (typeof raw !== 'string' && typeof raw !== 'number') return fail('INVALID_TYPE', `${name} must be text.`);
      let value = String(raw).trim();
      if (field.type === 'select' || field.type === 'radio') {
        return options.includes(value) ? { value } : fail('INVALID_OPTION', `${name}: choose one of the listed options.`);
      }
      if (field.type === 'email') {
        value = value.toLowerCase();
        if (!EMAIL.test(value)) return fail('INVALID_FORMAT', `${name} must be a valid email address.`);
      }
      if (field.type === 'phone') {
        value = value.replace(/[\s()-]/g, '');
        if (!PHONE.test(value)) return fail('INVALID_FORMAT', `${name} must be a phone number in international format, e.g. +971501234567.`);
      }
      if (field.type === 'date' && !isValidDate(value)) return fail('INVALID_FORMAT', `${name} must be a date (YYYY-MM-DD).`);
      if (field.type === 'country') {
        value = value.toUpperCase();
        if (!COUNTRY.test(value)) return fail('INVALID_FORMAT', `${name} must be a country code such as AE.`);
      }
      if (field.type === 'text' || field.type === 'textarea') {
        if (field.min !== undefined && value.length < field.min) return fail('TOO_SHORT', `${name} must have at least ${field.min} characters.`);
      }
      const maxLength = field.maxLength ?? (field.type === 'text' || field.type === 'textarea' ? field.max : undefined) ?? DEFAULT_MAX_LENGTH[field.type];
      if (maxLength !== undefined && value.length > maxLength) return fail('TOO_LONG', `${name} can have at most ${maxLength} characters.`);
      if (field.pattern) {
        const ok = matchesPattern(field.pattern, value);
        if (ok === false) return fail('INVALID_FORMAT', `${name} is not in the expected format.`);
      }
      return { value };
    }
    case 'number': {
      const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
      if (!Number.isFinite(value)) return fail('INVALID_TYPE', `${name} must be a number.`);
      if (field.min !== undefined && value < field.min) return fail('TOO_SMALL', `${name} must be at least ${field.min}.`);
      if (field.max !== undefined && value > field.max) return fail('TOO_LARGE', `${name} must be at most ${field.max}.`);
      return { value };
    }
    case 'checkbox': {
      if (typeof raw !== 'boolean') return fail('INVALID_TYPE', `${name} must be ticked or unticked.`);
      return { value: raw };
    }
    case 'multiselect': {
      if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) return fail('INVALID_TYPE', `${name} must be a list of options.`);
      const value = [...new Set(raw as string[])];
      if (value.some((v) => !options.includes(v))) return fail('INVALID_OPTION', `${name}: choose only from the listed options.`);
      if (field.min !== undefined && value.length < field.min) return fail('TOO_SMALL', `${name}: choose at least ${field.min}.`);
      if (field.max !== undefined && value.length > field.max) return fail('TOO_LARGE', `${name}: choose at most ${field.max}.`);
      return { value };
    }
    default:
      return fail('INVALID_TYPE', `${name} has a field type this version does not support.`);
  }
}

export function validateFormValues(schema: FormSchema | null | undefined, input: Record<string, unknown>, options: { partial?: boolean } = {}): FormValidationResult {
  const fields = formFieldsOf(schema);
  const known = new Set(fields.map((f) => f.key));
  const errors: FormFieldError[] = [];
  const values: Record<string, unknown> = {};

  for (const key of Object.keys(input)) {
    if (!known.has(key)) errors.push({ field: key, code: 'UNKNOWN_FIELD', message: `"${key}" is not a field of this form.` });
  }

  const visible = visibleFieldKeys(schema, input);
  for (const field of fields) {
    const raw = input[field.key];
    // While a draft is being filled in, a value may be saved before the field that reveals it.
    if (!visible.has(field.key) && !options.partial) continue;
    const empty = isEmptyValue(raw) || (field.type === 'checkbox' && raw === false && !!field.required);
    if (empty) {
      if (field.required && !options.partial && visible.has(field.key)) {
        errors.push({ field: field.key, code: 'REQUIRED', message: field.type === 'checkbox' ? `${field.label || field.key} must be ticked.` : `${field.label || field.key} is required.` });
      } else if (field.type === 'checkbox' && raw === false) {
        values[field.key] = false;
      }
      continue;
    }
    const { value, error } = checkField(field, raw);
    if (error) errors.push({ field: field.key, ...error });
    else values[field.key] = value;
  }
  return { valid: errors.length === 0, errors, values };
}

/** Customer profile values for fields with `prefillFrom` ("customer.fullName" ...). */
export function prefillValues(schema: FormSchema | null | undefined, customer: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of formFieldsOf(schema)) {
    // Only the documented, non-sensitive profile attributes can be copied into a form.
    if (!field.prefillFrom || !(PREFILL_SOURCES as readonly string[]).includes(field.prefillFrom)) continue;
    let raw = customer[field.prefillFrom.slice('customer.'.length)];
    if (raw instanceof Date) raw = raw.toISOString().slice(0, 10);
    if (isEmptyValue(raw)) continue;
    // Only prefill what the field itself would accept.
    const { value, error } = checkField(field, raw);
    if (!error) out[field.key] = value;
  }
  return out;
}
