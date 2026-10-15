import { COUNTRIES } from './countries';

/** E.164 as the API validates it: "+" and 7 to 15 digits, not starting with 0. */
export const E164 = /^\+[1-9][0-9]{6,14}$/;
export const isE164 = (value: string): boolean => E164.test(value);

export const DEFAULT_DIAL_CODE = '971';

const DIAL_CODES = Array.from(new Set(COUNTRIES.map((c) => c.dial))).sort((a, b) => b.length - a.length);

const toWesternDigits = (s: string) => s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));

/** Splits "+971501234567" into { dial: "971", national: "501234567" } using the longest known dialling code. */
export function splitPhone(value: string | null | undefined, fallbackDial: string = DEFAULT_DIAL_CODE): { dial: string; national: string } {
  const digits = toWesternDigits(value ?? '').replace(/[^\d+]/g, '');
  if (!digits.startsWith('+')) return { dial: fallbackDial, national: digits.replace(/\D/g, '') };
  const rest = digits.slice(1);
  const dial = DIAL_CODES.find((code) => rest.startsWith(code));
  return dial ? { dial, national: rest.slice(dial.length) } : { dial: fallbackDial, national: rest };
}

/**
 * Builds the E.164 value from the selected dialling code and what was typed.
 * People type national numbers in many ways: "050 123 4567", "50-123-4567",
 * "00971 50 123 4567", "+971501234567". All of those give "+971501234567".
 * Returns "" for an empty number so that optional fields stay empty.
 */
export function joinPhone(dial: string, typed: string): string {
  let v = toWesternDigits(typed).replace(/[\s().-]/g, '');
  if (!v) return '';
  if (v.startsWith('+')) return `+${v.slice(1).replace(/\D/g, '')}`;
  if (v.startsWith('00')) return `+${v.slice(2).replace(/\D/g, '')}`;
  v = v.replace(/\D/g, '');
  // A full number pasted with its country code but without "+".
  if (v.startsWith(dial) && v.length - dial.length >= 8) return `+${v}`;
  return `+${dial}${v.replace(/^0+/, '')}`;
}

/** "+971 50 123 4567": readable grouping for display. Unknown shapes are returned unchanged. */
export function formatPhone(value: string | null | undefined): string {
  if (!value) return '';
  if (!isE164(value)) return value;
  const { dial, national } = splitPhone(value);
  const groups = national.length === 9 ? [national.slice(0, 2), national.slice(2, 5), national.slice(5)] : national.length === 8 ? [national.slice(0, 1), national.slice(1, 4), national.slice(4)] : national.match(/.{1,4}/g) ?? [national];
  return `+${dial} ${groups.join(' ')}`;
}
