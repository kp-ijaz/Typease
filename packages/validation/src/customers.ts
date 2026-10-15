import { z } from 'zod';
import { countryCode, email, isoDate, language, optionalText, pageQuery, phone, queryBool, trimmed, uuid } from './common';

const identity = {
  /** 784-YYYY-NNNNNNN-C, dashes optional. */
  emiratesId: z
    .string()
    .trim()
    .transform((v) => v.replace(/[\s-]/g, ''))
    .pipe(z.string().regex(/^784\d{12}$/, 'Emirates ID has 15 digits starting with 784'))
    .nullish(),
  emiratesIdExpiry: isoDate.nullish(),
  passportNo: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{5,12}$/, 'Passport number has 5-12 letters or digits')
    .nullish(),
  passportCountry: countryCode.nullish(),
  passportExpiry: isoDate.nullish(),
};

/** Names are stored with single spaces so that equal names compare equal. */
const personName = (max = 160) => trimmed(max, 2).transform((v) => v.replace(/\s+/g, ' '));
export const customerAddressSchema = z.object({ line1: optionalText(200), city: optionalText(80), emirate: optionalText(40), country: countryCode.nullish() });
export const communicationPrefsSchema = z.object({ email: z.boolean(), sms: z.boolean(), whatsapp: z.boolean(), push: z.boolean() }).partial();

/** UAE Tax Registration Number: 15 digits (spaces are ignored). */
export const uaeTrn = z.preprocess(
  (v) => (typeof v === 'string' ? v.replace(/\s+/g, '') : v),
  z.string().regex(/^\d{15}$/, 'A UAE TRN has 15 digits'),
);

export const customerSchema = z.object({
  type: z.enum(['INDIVIDUAL', 'BUSINESS']).default('INDIVIDUAL'),
  fullName: personName(),
  fullNameAr: optionalText(160),
  preferredLanguage: language.default('en'),
  email: email.nullish(),
  phone: phone.nullish(),
  nationality: countryCode.nullish(),
  dateOfBirth: isoDate.nullish(),
  address: customerAddressSchema.nullish(),
  /** Business customers: printed on their tax invoices. */
  taxRegistrationNo: uaeTrn.nullish(),
  ...identity,
  corporateAccountId: uuid.nullish(),
  communicationPrefs: communicationPrefsSchema.optional(),
  marketingOptIn: z.boolean().optional(),
  tagIds: z.array(uuid).max(20).optional(),
  /** Staff confirm they reviewed possible duplicates and still want a new record. */
  confirmNotDuplicate: z.boolean().optional(),
});
export const updateCustomerSchema = customerSchema.partial().extend({ version: z.number().int().optional() });

/**
 * What customers may change about themselves. Name, language, address and communication preferences: always.
 * Phone, nationality and date of birth: while the field is empty or still holds what the customer entered; once
 * the centre entered or confirmed the value, a change is a correction request (409 CORRECTION_REQUIRED).
 * The email address (the login) and identity numbers are never changed here.
 */
export const updateOwnCustomerSchema = z.object({
  fullName: personName().optional(),
  fullNameAr: optionalText(160),
  preferredLanguage: language.optional(),
  address: customerAddressSchema.nullish(),
  communicationPrefs: communicationPrefsSchema.optional(),
  phone: phone.nullish(),
  nationality: countryCode.nullish(),
  /** YYYY-MM-DD, not in the future. */
  dateOfBirth: isoDate.nullish().refine((v) => !v || v <= new Date().toISOString().slice(0, 10), 'The date of birth cannot be in the future'),
});

export const customerListQuery = pageQuery.extend({
  /**
   * Default: ACTIVE. ALL = active, archived and merged records. Records whose personal data was erased are
   * stubs and are listed only when asked for explicitly: status=ANONYMISED.
   */
  status: z.enum(['ACTIVE', 'ARCHIVED', 'MERGED', 'ANONYMISED', 'ALL']).optional(),
  type: z.enum(['INDIVIDUAL', 'BUSINESS']).optional(),
  tagId: uuid.optional(),
  corporateAccountId: uuid.optional(),
  /** Exact-match search on identity numbers (never partial). */
  emiratesId: z.string().trim().max(20).optional(),
  passportNo: z.string().trim().max(20).optional(),
  phone: z.string().trim().max(20).optional(),
  email: z.string().trim().toLowerCase().max(254).optional(),
  requestNo: z.string().trim().max(30).optional(),
  hasAccount: queryBool,
});
export const duplicateCheckSchema = z
  .object({
    fullName: z.string().trim().max(160).optional(),
    email: email.optional(),
    phone: phone.optional(),
    emiratesId: z.string().trim().max(20).optional(),
    passportNo: z.string().trim().max(20).optional(),
    excludeId: uuid.optional(),
  })
  .refine((v) => !!(v.fullName || v.email || v.phone || v.emiratesId || v.passportNo), 'Give at least one detail to compare');
export const mergeCustomersSchema = z.object({
  /** The record that is kept. */
  targetId: uuid,
  /** The record that is merged into the target and retired. */
  sourceId: uuid,
  /** Typed confirmation: must equal the source customer number. */
  confirmSourceCustomerNo: trimmed(30),
  reason: trimmed(500, 5),
});
export const archiveCustomerSchema = z.object({ reason: optionalText(500) });

export const customerNoteSchema = z.object({ body: trimmed(4000, 1), isPinned: z.boolean().default(false) });
export const updateCustomerNoteSchema = z.object({ body: trimmed(4000, 1).optional(), isPinned: z.boolean().optional() });
export const customerTagSchema = z.object({ name: trimmed(40, 1), color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullish() });
export const updateCustomerTagSchema = customerTagSchema.partial();
export const customerTagIdsSchema = z.object({ tagIds: z.array(uuid).max(20) });

export const CONTACT_TYPES = ['EMAIL', 'PHONE', 'WHATSAPP'] as const;
export type ContactType = (typeof CONTACT_TYPES)[number];
/** Checks and normalises a contact value for its type (lower-case email, E.164 phone). */
export function normaliseContactValue(type: ContactType, value: string): { ok: true; value: string } | { ok: false; message: string } {
  const parsed = type === 'EMAIL' ? email.safeParse(value) : phone.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, message: type === 'EMAIL' ? 'Enter a valid email address' : 'Use international format, e.g. +971501234567' };
}
const contactFields = {
  type: z.enum(CONTACT_TYPES),
  value: trimmed(254),
  label: optionalText(40),
  isPrimary: z.boolean().default(false),
};
export const customerContactSchema = z.object(contactFields).transform((v, ctx) => {
  const checked = normaliseContactValue(v.type, v.value);
  if (!checked.ok) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: checked.message });
    return z.NEVER;
  }
  return { ...v, value: checked.value };
});
/** The type of a contact cannot change; the value is re-checked against the stored type by the API. */
export const updateCustomerContactSchema = z.object({ value: trimmed(254).optional(), label: optionalText(40), isPrimary: z.boolean().optional() });

export const CONSENT_PURPOSES = ['SERVICE_PROCESSING', 'REMINDERS', 'MARKETING', 'AI_PROCESSING', 'DOCUMENT_REUSE', 'WHATSAPP'] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];
export const LAWFUL_BASES = ['CONSENT', 'CONTRACT', 'LEGAL_OBLIGATION', 'LEGITIMATE_INTEREST'] as const;
export type LawfulBasis = (typeof LAWFUL_BASES)[number];
export const consentSchema = z.object({
  purpose: z.enum(CONSENT_PURPOSES),
  granted: z.boolean(),
  noticeVersion: z.string().max(20).optional(),
});
/** Staff record a consent decision the customer gave at the counter or by phone. */
export const staffConsentSchema = consentSchema.extend({ lawfulBasis: z.enum(LAWFUL_BASES).optional() });
/** Customers set one or several of their own consents. */
export const ownConsentsSchema = z.object({
  consents: z
    .array(consentSchema)
    .min(1)
    .max(CONSENT_PURPOSES.length)
    .refine((list) => new Set(list.map((c) => c.purpose)).size === list.length, 'Each purpose may appear only once'),
});
export const inviteCustomerPortalSchema = z.object({ email: email.optional() });

/**
 * Turns what a receptionist types into the stored E.164 form for an exact
 * phone search: "050 123 4567" and "00971501234567" both become "+971501234567".
 * Returns null when the text cannot be a phone number.
 */
export function normalisePhoneSearch(input: string, defaultCountryCode = '971'): string | null {
  let v = (input ?? '').replace(/[\s().-]/g, '');
  if (v.startsWith('00')) v = `+${v.slice(2)}`;
  else if (/^0\d{8,10}$/.test(v)) v = `+${defaultCountryCode}${v.slice(1)}`;
  else if (new RegExp(`^${defaultCountryCode}\\d{8,9}$`).test(v)) v = `+${v}`;
  return /^\+[1-9][0-9]{6,14}$/.test(v) ? v : null;
}

export type CustomerInput = z.infer<typeof customerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
export type UpdateOwnCustomerInput = z.infer<typeof updateOwnCustomerSchema>;
export type CustomerListQuery = z.infer<typeof customerListQuery>;
export type DuplicateCheckInput = z.infer<typeof duplicateCheckSchema>;
export type MergeCustomersInput = z.infer<typeof mergeCustomersSchema>;
export type CustomerNoteInput = z.infer<typeof customerNoteSchema>;
export type UpdateCustomerNoteInput = z.infer<typeof updateCustomerNoteSchema>;
export type CustomerTagInput = z.infer<typeof customerTagSchema>;
export type CustomerContactInput = z.infer<typeof customerContactSchema>;
export type UpdateCustomerContactInput = z.infer<typeof updateCustomerContactSchema>;
export type ConsentInput = z.infer<typeof consentSchema>;
export type StaffConsentInput = z.infer<typeof staffConsentSchema>;

// ---------------------------------------------------------------- bulk import
/** The rows a preview returned (already mapped to customer fields), sent back to be imported. */
export const customerImportSchema = z.object({
  rows: z.array(z.object({ rowNo: z.number().int().positive(), data: z.record(z.string(), z.unknown()) })).min(1).max(1000),
  /** Rows that look like an existing customer are skipped (true) or imported anyway (false). */
  skipDuplicates: z.boolean().default(true),
});
export type CustomerImportInput = z.infer<typeof customerImportSchema>;
