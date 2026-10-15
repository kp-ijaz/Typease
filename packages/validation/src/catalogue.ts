import { z } from 'zod';
import { PREFILL_SOURCES } from '@typease/types';
import type { FormField, FormSchema } from '@typease/types';
import { isoDate, moneyAmount, optionalText, pageQuery, queryBool, trimmed, uuid } from './common';

// ----------------------------------------------------------------------------
// Categories and document types
// ----------------------------------------------------------------------------

const categoryKey = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9-]{1,39}$/, 'Use 2-40 lowercase letters, numbers or hyphens, starting with a letter');
const documentTypeKey = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9_]{1,39}$/, 'Use 2-40 lowercase letters, numbers or underscores, starting with a letter');

export const serviceCategorySchema = z.object({
  /** Stable key. Derived from the name when omitted. */
  key: categoryKey.optional(),
  name: trimmed(80, 2),
  nameAr: optionalText(80),
  description: optionalText(500),
  icon: optionalText(40),
  sortOrder: z.number().int().min(0).max(99999).optional(),
  isActive: z.boolean().optional(),
});
export const updateServiceCategorySchema = serviceCategorySchema.omit({ key: true }).partial();
/** New display order: the ids in the order they should appear. */
export const catalogueOrderSchema = z.object({
  ids: z
    .array(uuid)
    .min(1)
    .max(500)
    .refine((ids) => new Set(ids).size === ids.length, 'Each id may appear only once'),
});

export const OCR_PROFILES = ['NONE', 'PASSPORT', 'EMIRATES_ID', 'TRADE_LICENCE'] as const;
export const catalogueDocumentTypeSchema = z.object({
  key: documentTypeKey,
  name: trimmed(80, 2),
  nameAr: optionalText(80),
  hasExpiry: z.boolean().default(false),
  ocrProfile: z.enum(OCR_PROFILES).default('NONE'),
  reminderEnabled: z.boolean().default(false),
  isActive: z.boolean().default(true),
});
export const updateCatalogueDocumentTypeSchema = catalogueDocumentTypeSchema.omit({ key: true }).partial();

// ----------------------------------------------------------------------------
// Services
// ----------------------------------------------------------------------------

export const COMPLIANCE_CAPABILITIES = ['DOCUMENT_PREPARATION_ONLY', 'PARTNER_COORDINATION', 'DIRECT_AUTHORISED', 'INFORMATIONAL_ONLY'] as const;
export const PAYMENT_POLICIES = ['BEFORE_PROCESSING', 'AFTER_COMPLETION', 'DEPOSIT'] as const;
export const TAX_MODES = ['SERVICE_FEE_ONLY', 'ALL_COMPONENTS', 'NONE'] as const;

/** Fee components of one price. Government and third-party amounts are ESTIMATES, never a quote from an authority. */
const priceComponents = {
  serviceFee: moneyAmount,
  governmentFeeEstimate: moneyAmount.default('0'),
  thirdPartyFeeEstimate: moneyAmount.default('0'),
};
export const servicePriceSchema = z.object({
  /** Omit / null = the default price for all branches. */
  branchId: uuid.nullish(),
  ...priceComponents,
});
export const servicePriceQuery = z.object({ branchId: uuid.optional(), corporateAccountId: uuid.optional() });

const serviceFields = {
  categoryId: uuid,
  /** Internal code, unique per centre. */
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9_-]{1,29}$/, 'Use 2-30 letters, numbers, hyphens or underscores'),
  name: trimmed(120, 2),
  nameAr: optionalText(120),
  description: optionalText(2000),
  descriptionAr: optionalText(2000),
  eligibilityGuidance: optionalText(2000),
  /** What the centre does for this service. A business category, never a claim of government authorisation. */
  complianceCapability: z.enum(COMPLIANCE_CAPABILITIES).default('DOCUMENT_PREPARATION_ONLY'),
  estimatedProcessingHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 365)
    .nullish(),
  requiresApproval: z.boolean().default(false),
  paymentPolicy: z.enum(PAYMENT_POLICIES).default('BEFORE_PROCESSING'),
  /** Required when paymentPolicy is DEPOSIT. */
  depositPercent: z.coerce.number().gt(0, 'Deposit must be more than 0%').max(100).nullish(),
  taxMode: z.enum(TAX_MODES).default('SERVICE_FEE_ONLY'),
  /** Customers can request it from the portal / mobile app. */
  onlineAvailable: z.boolean().default(true),
  /** Shown in the public catalogue. */
  isPublic: z.boolean().default(true),
  isActive: z.boolean().default(true),
  allBranches: z.boolean().default(true),
  /** Branches offering the service when allBranches is false. */
  branchIds: z.array(uuid).max(100).default([]),
  /** Role key of the staff group that normally handles this service. */
  staffGroupRoleKey: z
    .string()
    .trim()
    .max(60)
    .nullish()
    .transform((v) => (v === '' ? null : v)),
  workflowDefinitionId: uuid.nullish(),
  sortOrder: z.number().int().min(0).max(99999).default(0),
};
export const serviceSchema = z
  .object({ ...serviceFields, price: z.object(priceComponents) })
  .superRefine((v, ctx) => {
    if (v.paymentPolicy === 'DEPOSIT' && (v.depositPercent === null || v.depositPercent === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['depositPercent'], message: 'Enter the deposit percentage' });
    }
    if (!v.allBranches && v.branchIds.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['branchIds'], message: 'Choose at least one branch, or offer the service in all branches' });
    }
  });
export const updateServiceSchema = z
  .object(serviceFields)
  .partial()
  .extend({
    /** Optimistic concurrency: the version the editor loaded. */
    version: z.number().int().positive().optional(),
  });

export const serviceListQuery = pageQuery.extend({
  categoryId: uuid.optional(),
  /** Only services offered at this branch. */
  branchId: uuid.optional(),
  isActive: queryBool,
  isPublic: queryBool,
  onlineAvailable: queryBool,
  complianceCapability: z.enum(COMPLIANCE_CAPABILITIES).optional(),
  /** true = list deleted services (to restore them). */
  deleted: queryBool,
});
export const serviceFullQuery = servicePriceQuery;
export const customerCatalogueQuery = z.object({
  branchId: uuid.optional(),
  categoryKey: z.string().trim().max(40).optional(),
  q: z.string().trim().max(120).optional(),
});
export const publicCatalogueQuery = z.object({
  /** Centre slug. Falls back to the request host (portal domain). */
  slug: z.string().trim().toLowerCase().max(50).optional(),
  categoryKey: z.string().trim().max(40).optional(),
  q: z.string().trim().max(120).optional(),
});

export const serviceRequirementSchema = z.object({
  documentTypeKey,
  label: trimmed(120, 2),
  labelAr: optionalText(120),
  description: optionalText(500),
  isMandatory: z.boolean().default(true),
  /** May a valid document already on the customer's file satisfy this item? */
  allowReuse: z.boolean().default(true),
  maxAgeDays: z.number().int().min(1).max(3650).nullish(),
});
export const updateServiceRequirementSchema = serviceRequirementSchema.partial();

// ----------------------------------------------------------------------------
// Dynamic forms: definition (FormSchema)
// ----------------------------------------------------------------------------

export const FORM_FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'email', 'phone', 'select', 'multiselect', 'checkbox', 'radio', 'country'] as const;
const OPTION_TYPES: ReadonlyArray<string> = ['select', 'multiselect', 'radio'];
const TEXT_TYPES: ReadonlyArray<string> = ['text', 'textarea'];
export const FORM_LIMITS = { steps: 20, fieldsPerStep: 60, fields: 200, options: 200, textLength: 500, textareaLength: 5000 } as const;

const formKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/, 'Use letters, numbers and underscores, starting with a letter (max 40)');
const formOption = z
  .object({ value: z.string().trim().min(1).max(100), label: trimmed(120), labelAr: z.string().trim().max(120).optional() })
  .strict();
const formField = z
  .object({
    key: formKey,
    label: trimmed(160),
    labelAr: z.string().trim().max(160).optional(),
    type: z.enum(FORM_FIELD_TYPES),
    required: z.boolean().optional(),
    placeholder: z.string().max(160).optional(),
    help: z.string().max(500).optional(),
    options: z.array(formOption).max(FORM_LIMITS.options).optional(),
    showIf: z
      .object({ field: formKey, in: z.array(z.union([z.string().max(100), z.number().finite(), z.boolean()])).min(1).max(50) })
      .strict()
      .optional(),
    prefillFrom: z.enum(PREFILL_SOURCES).optional(),
    sensitive: z.boolean().optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    maxLength: z.number().int().min(1).max(10000).optional(),
    pattern: z.string().min(1).max(200).optional(),
  })
  .strict();
const formStep = z
  .object({
    key: formKey,
    title: trimmed(120),
    titleAr: z.string().trim().max(120).optional(),
    description: z.string().trim().max(500).optional(),
    fields: z.array(formField).max(FORM_LIMITS.fieldsPerStep),
  })
  .strict();

/** Full-match semantics, like the HTML `pattern` attribute. */
export function compileFormPattern(pattern: string): RegExp {
  return new RegExp(`^(?:${pattern})$`, 'u');
}
/** Rejects the classic catastrophic-backtracking shape "(x+)+" before a pattern is stored. */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,\d*\})/;

/** Validates a form definition against `FormSchema` (packages/types). */
export const serviceFormSchema: z.ZodType<FormSchema, z.ZodTypeDef, unknown> = z
  .object({ steps: z.array(formStep).max(FORM_LIMITS.steps) })
  .strict()
  .superRefine((form, ctx) => {
    const issue = (path: Array<string | number>, message: string) => ctx.addIssue({ code: 'custom', path, message });
    const stepKeys = new Set<string>();
    /** Fields defined so far, in order: showIf may only look backwards. */
    const earlier = new Map<string, FormField>();
    let total = 0;
    form.steps.forEach((step, s) => {
      if (stepKeys.has(step.key)) issue(['steps', s, 'key'], `Step key "${step.key}" is used more than once`);
      stepKeys.add(step.key);
      step.fields.forEach((field, f) => {
        const at = (prop: string) => ['steps', s, 'fields', f, prop];
        total += 1;
        if (earlier.has(field.key)) issue(at('key'), `Field key "${field.key}" is used more than once`);

        if (OPTION_TYPES.includes(field.type)) {
          if (!field.options?.length) issue(at('options'), `"${field.label}" needs at least one option`);
          else if (new Set(field.options.map((o) => o.value)).size !== field.options.length) issue(at('options'), `"${field.label}" has duplicate option values`);
        } else if (field.options !== undefined) {
          issue(at('options'), `Options are only for select, multiselect and radio fields`);
        }

        if (field.showIf) {
          const controller = earlier.get(field.showIf.field);
          if (!controller) issue(at('showIf'), `"${field.label}" can only depend on a field that comes before it`);
          else if (controller.options && field.showIf.in.some((v) => !controller.options!.some((o) => o.value === String(v)))) {
            issue(at('showIf'), `"${field.label}" depends on a value that is not an option of "${controller.label}"`);
          }
        }

        const bounded = field.type === 'number' || field.type === 'multiselect' || TEXT_TYPES.includes(field.type);
        if ((field.min !== undefined || field.max !== undefined) && !bounded) issue(at('min'), 'min / max apply to number, text and multiselect fields only');
        if (field.min !== undefined && field.max !== undefined && field.min > field.max) issue(at('max'), 'max must not be smaller than min');
        if (field.type !== 'number' && ((field.min !== undefined && (field.min < 0 || !Number.isInteger(field.min))) || (field.max !== undefined && (field.max < 0 || !Number.isInteger(field.max))))) {
          issue(at('min'), 'For text and multiselect fields min / max are whole numbers (length or number of choices)');
        }
        if (field.maxLength !== undefined && !TEXT_TYPES.includes(field.type)) issue(at('maxLength'), 'maxLength applies to text fields only');
        if (field.pattern !== undefined) {
          if (!TEXT_TYPES.includes(field.type)) issue(at('pattern'), 'pattern applies to text fields only');
          else if (NESTED_QUANTIFIER.test(field.pattern)) issue(at('pattern'), 'This pattern is too complex (nested repetition). Simplify it.');
          else {
            try {
              compileFormPattern(field.pattern);
            } catch {
              issue(at('pattern'), 'pattern is not a valid regular expression');
            }
          }
        }
        earlier.set(field.key, field);
      });
    });
    if (total > FORM_LIMITS.fields) issue(['steps'], `A form can have at most ${FORM_LIMITS.fields} fields`);
  }) as z.ZodType<FormSchema, z.ZodTypeDef, unknown>;

/** New draft. Without `schema` the draft is a copy of the published version (or empty). */
export const createServiceFormSchema = z.object({ schema: serviceFormSchema.optional() });
export const updateServiceFormSchema = z.object({ schema: serviceFormSchema });

// ----------------------------------------------------------------------------
// Dynamic forms: validating submitted values
// ----------------------------------------------------------------------------

export type FormValue = string | number | boolean | string[];
export type FormValues = Record<string, FormValue>;
export interface FormValidatorOptions {
  /** Draft saving: required fields may still be empty. Everything that IS filled in is validated. */
  partial?: boolean;
  /** Keys that are not fields of the form: silently dropped (default) or reported. */
  unknownKeys?: 'strip' | 'reject';
}

/** Own properties only: a field called "constructor" must not pick up Object.prototype.constructor. */
const own = (values: Record<string, unknown> | null | undefined, key: string) => (values && Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined);
const isEmpty = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);
const sameValue = (a: unknown, b: unknown) => a === b || String(a) === String(b);
const EMAIL = z.string().email();
const E164 = /^\+[1-9][0-9]{6,14}$/;

function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Is the field shown, given the (already cleaned) values of the fields before it? */
function isShown(field: FormField, values: Record<string, unknown>): boolean {
  if (!field.showIf) return true;
  // A hidden or invalid controlling field has no value, so everything depending on it is hidden too.
  if (!Object.prototype.hasOwnProperty.call(values, field.showIf.field)) return false;
  const current = values[field.showIf.field];
  const candidates = Array.isArray(current) ? current : [current];
  return candidates.some((c) => field.showIf!.in.some((v) => sameValue(v, c)));
}

/** Normalises one value. Returns `{ value }` or `{ error }` (a plain-language message). */
function checkField(field: FormField, raw: unknown): { value: FormValue } | { error: string } {
  const name = field.label;
  const fail = (error: string) => ({ error });
  switch (field.type) {
    case 'text':
    case 'textarea': {
      if (typeof raw !== 'string') return fail(`${name} must be text`);
      const value = raw.trim();
      const limit = field.maxLength ?? (field.type === 'text' ? FORM_LIMITS.textLength : FORM_LIMITS.textareaLength);
      if (value.length > limit) return fail(`${name} can have at most ${limit} characters`);
      if (field.max !== undefined && value.length > field.max) return fail(`${name} can have at most ${field.max} characters`);
      if (field.min !== undefined && value.length < field.min) return fail(`${name} needs at least ${field.min} characters`);
      if (field.pattern) {
        let re: RegExp;
        try {
          re = compileFormPattern(field.pattern);
        } catch {
          return fail(`${name} cannot be checked: the form has an invalid pattern`);
        }
        if (!re.test(value)) return fail(`${name} is not in the expected format`);
      }
      return { value };
    }
    case 'number': {
      const value = typeof raw === 'number' ? raw : typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
      if (!Number.isFinite(value)) return fail(`${name} must be a number`);
      if (field.min !== undefined && value < field.min) return fail(`${name} must be at least ${field.min}`);
      if (field.max !== undefined && value > field.max) return fail(`${name} must be at most ${field.max}`);
      return { value };
    }
    case 'date': {
      if (typeof raw !== 'string' || !validCalendarDate(raw.trim())) return fail(`${name} must be a date (YYYY-MM-DD)`);
      return { value: raw.trim() };
    }
    case 'email': {
      const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
      if (value.length > 254 || !EMAIL.safeParse(value).success) return fail(`${name} must be a valid email address`);
      return { value };
    }
    case 'phone': {
      const value = typeof raw === 'string' ? raw.replace(/[\s()-]/g, '') : '';
      if (!E164.test(value)) return fail(`${name} must be in international format, e.g. +971501234567`);
      return { value };
    }
    case 'country': {
      const value = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
      if (!/^[A-Z]{2,3}$/.test(value)) return fail(`${name} must be a country code such as AE`);
      return { value };
    }
    case 'select':
    case 'radio': {
      const value = typeof raw === 'number' ? String(raw) : raw;
      if (typeof value !== 'string' || !(field.options ?? []).some((o) => o.value === value)) return fail(`${name}: choose one of the listed options`);
      return { value };
    }
    case 'multiselect': {
      if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) return fail(`${name} must be a list of options`);
      const value = [...new Set(raw as string[])];
      if (value.some((v) => !(field.options ?? []).some((o) => o.value === v))) return fail(`${name}: choose only from the listed options`);
      if (field.min !== undefined && value.length < field.min) return fail(`${name}: choose at least ${field.min}`);
      if (field.max !== undefined && value.length > field.max) return fail(`${name}: choose at most ${field.max}`);
      return { value };
    }
    case 'checkbox': {
      if (typeof raw !== 'boolean') return fail(`${name} must be ticked or unticked`);
      return { value: raw };
    }
    default:
      return fail(`${name} has an unsupported field type`);
  }
}

/** All fields of a form in display order. */
export function formFields(schema: FormSchema): FormField[] {
  return (schema?.steps ?? []).flatMap((s) => s.fields ?? []);
}

/**
 * Keys of the fields that are visible for the given values (evaluates showIf
 * chains in order). The web apps use it to render, the API to validate.
 */
export function visibleFormFieldKeys(schema: FormSchema, values: Record<string, unknown>): string[] {
  const seen: Record<string, unknown> = {};
  const keys: string[] = [];
  for (const field of formFields(schema)) {
    if (!isShown(field, seen)) continue;
    keys.push(field.key);
    const raw = own(values, field.key);
    if (isEmpty(raw)) continue;
    const checked = checkField(field, raw);
    if ('value' in checked) seen[field.key] = checked.value;
  }
  return keys;
}

/**
 * Builds the validator for values submitted against a form definition.
 *
 *  - required fields must be filled (a required checkbox must be ticked);
 *  - every value is checked and normalised for its field type, min / max,
 *    maxLength, pattern (full match) and options;
 *  - a field hidden by `showIf` is optional and its value is dropped;
 *  - empty values ("", null, []) count as "not filled in" and are dropped.
 *
 * The parsed output contains only the visible, filled-in fields.
 */
export function buildFormValidator(schema: FormSchema, options: FormValidatorOptions = {}): z.ZodType<FormValues, z.ZodTypeDef, unknown> {
  const fields = formFields(schema);
  const known = new Set(fields.map((f) => f.key));
  return z.record(z.string(), z.unknown(), { invalid_type_error: 'Form values must be an object', required_error: 'Form values are required' }).transform((input, ctx) => {
    const out: FormValues = {};
    let failed = false;
    const issue = (key: string, message: string) => {
      failed = true;
      ctx.addIssue({ code: 'custom', path: [key], message });
    };
    if (options.unknownKeys === 'reject') {
      for (const key of Object.keys(input)) if (!known.has(key)) issue(key, `"${key}" is not a field of this form`);
    }
    for (const field of fields) {
      if (!isShown(field, out)) continue;
      const raw = own(input, field.key);
      const unticked = field.type === 'checkbox' && raw === false;
      if (isEmpty(raw) || (unticked && field.required)) {
        if (field.required && !options.partial) issue(field.key, `${field.label} is required`);
        else if (unticked) out[field.key] = false;
        continue;
      }
      const checked = checkField(field, raw);
      if ('error' in checked) issue(field.key, checked.error);
      else out[field.key] = checked.value;
    }
    return failed ? z.NEVER : out;
  });
}

export type ServiceCategoryInput = z.infer<typeof serviceCategorySchema>;
export type UpdateServiceCategoryInput = z.infer<typeof updateServiceCategorySchema>;
export type CatalogueDocumentTypeInput = z.infer<typeof catalogueDocumentTypeSchema>;
export type UpdateCatalogueDocumentTypeInput = z.infer<typeof updateCatalogueDocumentTypeSchema>;
export type ServiceInput = z.infer<typeof serviceSchema>;
export type UpdateServiceInput = z.infer<typeof updateServiceSchema>;
export type ServiceListQuery = z.infer<typeof serviceListQuery>;
export type ServicePriceInput = z.infer<typeof servicePriceSchema>;
export type ServicePriceQuery = z.infer<typeof servicePriceQuery>;
export type ServiceRequirementInput = z.infer<typeof serviceRequirementSchema>;
export type UpdateServiceRequirementInput = z.infer<typeof updateServiceRequirementSchema>;
export type CustomerCatalogueQuery = z.infer<typeof customerCatalogueQuery>;
export type PublicCatalogueQuery = z.infer<typeof publicCatalogueQuery>;

// ---------------------------------------------------------------- authority fee catalogue (maintained by TypEase)
export const AUTHORITIES = ['AMER', 'TASHEEL', 'ICP', 'MOHRE', 'GDRFA', 'DED', 'MOFA', 'DHA', 'MOHAP', 'POLICE', 'COURTS', 'OTHER'] as const;
const authorityFeeFields = {
  authority: z.enum(AUTHORITIES),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{1,39}$/, 'Use 2-40 letters, numbers, hyphens or underscores'),
  name: trimmed(160, 2),
  nameAr: optionalText(160),
  category: optionalText(60),
  governmentFee: moneyAmount,
  thirdPartyFee: moneyAmount.default('0'),
  notes: optionalText(1000),
  sourceUrl: z.string().trim().url().max(500).nullish(),
  verifiedAt: isoDate.nullish(),
  isSample: z.boolean().default(true),
  isActive: z.boolean().default(true),
};
export const authorityFeeSchema = z.object(authorityFeeFields);
export type AuthorityFeeInput = z.infer<typeof authorityFeeSchema>;
export const updateAuthorityFeeSchema = z
  .object(authorityFeeFields)
  .omit({ code: true })
  .partial()
  .extend({ /** Why the amounts changed (shown to centres with the update). */ changeNote: optionalText(500), version: z.number().int().positive() });
export type UpdateAuthorityFeeInput = z.infer<typeof updateAuthorityFeeSchema>;
export const authorityFeeQuery = z.object({ authority: z.enum(AUTHORITIES).optional(), q: z.string().trim().max(100).optional(), includeInactive: queryBool });
export type AuthorityFeeQuery = z.infer<typeof authorityFeeQuery>;
/** Add a catalogue entry to the centre's own services, with the centre's service fee. */
export const importAuthorityFeeSchema = z.object({ categoryId: uuid, code: serviceFields.code, serviceFee: moneyAmount, name: trimmed(120, 2).optional(), nameAr: optionalText(120) });
export type ImportAuthorityFeeInput = z.infer<typeof importAuthorityFeeSchema>;
export const linkAuthorityFeeSchema = z.object({ authorityFeeId: uuid.nullable() });
export const applyAuthorityFeeUpdatesSchema = z.object({ serviceIds: z.array(uuid).min(1).max(200) });

// ---------------------------------------------------------------- bulk import of services
export const serviceImportSchema = z.object({
  rows: z.array(z.object({ rowNo: z.number().int().positive(), data: z.record(z.string(), z.unknown()) })).min(1).max(1000),
});
export type ServiceImportInput = z.infer<typeof serviceImportSchema>;
