import { z } from '@typease/validation';
import type { PasswordPolicy } from '@typease/types';

export type { PasswordPolicy };
type PasswordClass = PasswordPolicy['requires'][number];

/** The rules that always applied before the API published its policy; still the fallback and the floor. */
export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = { minLength: 10, maxLength: 128, requires: ['lowercase', 'uppercase', 'digit'] };

const CLASS_ORDER: PasswordClass[] = ['lowercase', 'uppercase', 'digit'];
const TESTS: Record<PasswordClass, RegExp> = { lowercase: /[a-z]/, uppercase: /[A-Z]/, digit: /\d/ };

/**
 * The policy to apply: what the API published (GET /public/tenant-config `passwordPolicy`, or the
 * invitation preview), tidied up; the built-in rules when it published nothing usable.
 */
export function resolvePasswordPolicy(policy?: Partial<PasswordPolicy> | null): PasswordPolicy {
  if (!policy || typeof policy !== 'object') return DEFAULT_PASSWORD_POLICY;
  const whole = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback);
  const minLength = whole(policy.minLength, DEFAULT_PASSWORD_POLICY.minLength);
  const maxLength = Math.max(minLength, whole(policy.maxLength, DEFAULT_PASSWORD_POLICY.maxLength));
  const requires = Array.isArray(policy.requires) ? CLASS_ORDER.filter((c) => (policy.requires as string[]).includes(c)) : DEFAULT_PASSWORD_POLICY.requires;
  return { minLength, maxLength, requires };
}

/** "lowercase_uppercase_digit", "lowercase_digit", ... or "none": the suffix of the dictionary keys below. */
export const passwordClassesKey = (policy: PasswordPolicy): string => CLASS_ORDER.filter((c) => policy.requires.includes(c)).join('_') || 'none';

/**
 * Zod schema for a NEW password under a policy. Its messages are the ones the API uses
 * ("Use at least 12 characters") or sentinels, and `localiseValidationMessage` turns both into the
 * reader's language.
 */
export function passwordSchema(policy?: Partial<PasswordPolicy> | null) {
  const p = resolvePasswordPolicy(policy);
  const classes = passwordClassesKey(p);
  return z
    .string()
    .min(p.minLength, `Use at least ${p.minLength} characters`)
    .max(p.maxLength, `Use at most ${p.maxLength} characters`)
    .refine((value) => p.requires.every((c) => TESTS[c].test(value)), `PASSWORD_NEEDS:${classes}`);
}

interface Translator {
  t: (key: string, vars?: Record<string, string | number>) => string;
}
/** The sentence under a "new password" field: "At least 12 characters, with upper-case and lower-case letters and a number." */
export function passwordHint(policy: Partial<PasswordPolicy> | null | undefined, i18n: Translator): string {
  const p = resolvePasswordPolicy(policy);
  return i18n.t(`form.passwordPolicy.${passwordClassesKey(p)}`, { min: p.minLength });
}
