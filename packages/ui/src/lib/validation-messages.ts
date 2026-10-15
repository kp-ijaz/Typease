/**
 * Turns validation messages into the active language.
 *
 * The shared Zod schemas (@typease/validation) carry English messages, and the
 * API answers VALIDATION_FAILED with the same texts. Instead of duplicating the
 * schemas per language, the known messages are mapped to dictionary keys here.
 * An unknown message is shown as it is (English), never dropped.
 */
interface Translator {
  t: (key: string, vars?: Record<string, string | number>) => string;
}

/** Exact messages written in packages/validation -> dictionary key. */
const EXACT: Record<string, string> = {
  Required: 'validation.required',
  PASSWORDS_DIFFER: 'auth.reset.mismatch',
  TRACKING_CODE_LENGTH: 'validation.trackingCode',
  'Use international format, e.g. +971501234567': 'validation.phone',
  'Enter a valid email address': 'validation.email',
  'Invalid email': 'validation.email',
  'Include upper-case, lower-case and a number': 'validation.passwordMix',
  'Use 3-50 lowercase letters, numbers or hyphens': 'validation.slug',
  'Use YYYY-MM-DD': 'validation.date',
  'Invalid date': 'validation.date',
  'Invalid datetime': 'validation.date',
  'Use HH:MM (24h)': 'validation.time',
  'Enter an amount such as 150.00': 'validation.amount',
  'Amount must be greater than zero': 'validation.amountPositive',
  'Emirates ID has 15 digits starting with 784': 'validation.emiratesId',
  'Passport number has 5-12 letters or digits': 'validation.passport',
  'Use a hex colour such as #0B7AD1': 'validation.hexColor',
  'Enter a domain such as portal.yourcentre.ae': 'validation.domain',
  'Use 2-12 letters or numbers': 'validation.code',
  'You must accept the terms and privacy notice': 'validation.acceptTerms',
  'You must accept the terms': 'validation.acceptTerms',
  Invalid: 'validation.invalid',
  'Invalid uuid': 'validation.option',
  'Invalid input': 'validation.invalid',
};

/** Zod's built-in English messages, with the number they mention. */
const PATTERNS: Array<[RegExp, (m: RegExpExecArray) => [string, Record<string, string | number>?]]> = [
  // Password policy (the API's wording and the sentinels of lib/password-policy.ts).
  [/^Use at least (\d+) characters$/, (m) => ['validation.passwordMin', { min: m[1] }]],
  [/^Use at most (\d+) characters$/, (m) => ['validation.maxLength', { max: m[1] }]],
  [/^PASSWORD_NEEDS:(lowercase_uppercase_digit|lowercase_uppercase|lowercase_digit|uppercase_digit|lowercase|uppercase|digit)$/, (m) => [`validation.passwordNeeds.${m[1]}`]],
  [/^String must contain at least (\d+) character/, (m) => (m[1] === '1' ? ['validation.required'] : ['validation.minLength', { min: m[1] }])],
  [/^String must contain at most (\d+) character/, (m) => ['validation.maxLength', { max: m[1] }]],
  [/^Number must be greater than or equal to (-?[\d.]+)/, (m) => ['validation.minNumber', { min: m[1] }]],
  [/^Number must be less than or equal to (-?[\d.]+)/, (m) => ['validation.maxNumber', { max: m[1] }]],
  [/^Expected .+, received (undefined|null|nan)$/i, () => ['validation.required']],
  [/^Expected .+, received /, () => ['validation.invalid']],
  [/^Invalid enum value/, () => ['validation.option']],
  [/^Invalid literal value/, () => ['validation.invalid']],
];

export function localiseValidationMessage(message: string | undefined | null, i18n: Translator): string {
  if (!message) return i18n.t('validation.invalid');
  const exact = EXACT[message];
  if (exact) return i18n.t(exact);
  for (const [pattern, map] of PATTERNS) {
    const m = pattern.exec(message);
    if (m) {
      const [key, vars] = map(m);
      return i18n.t(key, vars);
    }
  }
  return message;
}
