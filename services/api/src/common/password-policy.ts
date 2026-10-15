import { env } from '../config/env';
import { Errors } from './errors';

/**
 * The one password policy of the API. Every place where a password is SET
 * (customer registration, centre sign-up, reset, change, invitation acceptance,
 * the platform-admin CLI) goes through `assertPasswordPolicy`. Sign-in never
 * does: an existing password that predates a stricter policy must still work.
 *
 * The shared request schema (`password` in @typease/validation) is the floor
 * that the web apps can check offline: 10 characters, upper-case, lower-case
 * and a digit. `PASSWORD_MIN_LENGTH` can raise the minimum length (it cannot be
 * set below 10); the apps read the effective policy from
 * `GET /public/tenant-config` (`passwordPolicy`) and from the invitation preview.
 */
export interface PasswordPolicy {
  minLength: number;
  maxLength: number;
  /** Character classes that must each appear at least once. */
  requires: Array<'lowercase' | 'uppercase' | 'digit'>;
}
export const PASSWORD_MAX_LENGTH = 128;

export function passwordPolicy(minLength: number = env().PASSWORD_MIN_LENGTH): PasswordPolicy {
  return { minLength, maxLength: PASSWORD_MAX_LENGTH, requires: ['lowercase', 'uppercase', 'digit'] };
}

/** What is wrong with a candidate password under the policy. Empty = acceptable. Never echoes the password. */
export function passwordProblems(plain: string, policy: PasswordPolicy = passwordPolicy()): string[] {
  const problems: string[] = [];
  if (typeof plain !== 'string' || plain.length < policy.minLength) problems.push(`Use at least ${policy.minLength} characters`);
  if (typeof plain === 'string' && plain.length > policy.maxLength) problems.push(`Use at most ${policy.maxLength} characters`);
  const missing: string[] = [];
  if (policy.requires.includes('uppercase') && !/[A-Z]/.test(plain ?? '')) missing.push('upper-case');
  if (policy.requires.includes('lowercase') && !/[a-z]/.test(plain ?? '')) missing.push('lower-case');
  if (policy.requires.includes('digit') && !/\d/.test(plain ?? '')) missing.push('a number');
  if (missing.length) problems.push('Include upper-case, lower-case and a number');
  return problems;
}

/**
 * Refuses a password that does not meet the policy with the same answer shape as a schema validation error
 * (400 VALIDATION_FAILED, `details: [{ path, message }]`), so forms show it next to the field.
 */
export function assertPasswordPolicy(plain: string, field = 'password'): void {
  const problems = passwordProblems(plain);
  if (problems.length) throw Errors.badRequest('VALIDATION_FAILED', 'Please check the highlighted fields.', problems.map((message) => ({ path: field, message })));
}
