/**
 * Money is a decimal STRING everywhere ("150.00"), exactly as the API sends and
 * expects it. Never parseFloat an amount: arithmetic happens in integer minor
 * units (fils) with BigInt, display goes through Intl.
 */

const AMOUNT = /^\d{1,11}(\.\d{1,2})?$/;

/** True for what the API accepts: up to 11 digits, at most two decimals, not negative. */
export const isMoneyAmount = (value: string): boolean => AMOUNT.test(value);

/**
 * Cleans what a person types into an amount field without changing its meaning:
 * Arabic-Indic digits and separators become Western, grouping commas and spaces
 * are removed, and anything after two decimals is cut (not rounded).
 */
export function sanitiseMoneyInput(raw: string): string {
  let v = raw
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.')
    .replace(/[٬,\s]/g, '')
    .replace(/[^\d.]/g, '');
  const dot = v.indexOf('.');
  if (dot !== -1) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '').slice(0, 2);
  const [int = '', frac] = v.split('.');
  const trimmedInt = int.replace(/^0+(?=\d)/, '').slice(0, 11);
  return frac === undefined ? trimmedInt : `${trimmedInt || '0'}.${frac}`;
}

/** "150" -> "150.00", "150.5" -> "150.50", "" -> "". Applied when the field loses focus. */
export function normaliseMoney(value: string): string {
  const v = sanitiseMoneyInput(value).replace(/\.$/, '');
  if (!v) return '';
  const [int, frac = ''] = v.split('.');
  return `${int}.${frac.padEnd(2, '0')}`;
}

/** Amount in minor units (fils). Throws on anything that is not a plain decimal with <= 2 places. */
export function toMinorUnits(value: string | number): bigint {
  const text = typeof value === 'number' ? value.toFixed(2) : value.trim();
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) throw new Error(`Not a money amount: "${value}"`);
  const minor = BigInt(m[2]) * 100n + BigInt((m[3] ?? '').padEnd(2, '0') || '0');
  return m[1] ? -minor : minor;
}

export function fromMinorUnits(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  return `${negative ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

export const addMoney = (...amounts: Array<string | number>): string => fromMinorUnits(amounts.reduce<bigint>((sum, a) => sum + toMinorUnits(a), 0n));
export const subtractMoney = (a: string | number, b: string | number): string => fromMinorUnits(toMinorUnits(a) - toMinorUnits(b));
/** -1, 0 or 1. */
export function compareMoney(a: string | number, b: string | number): number {
  const d = toMinorUnits(a) - toMinorUnits(b);
  return d === 0n ? 0 : d < 0n ? -1 : 1;
}
export const isZeroMoney = (a: string | number): boolean => toMinorUnits(a) === 0n;
