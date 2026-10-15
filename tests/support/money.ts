/**
 * Decimal money arithmetic for expected values, independent of the code under
 * test: amounts are held as an integer number of fils (1/100 AED) in a bigint,
 * parsed from and printed as the two-decimal strings the API uses. No floating
 * point is involved anywhere.
 */
export type Fils = bigint;

/** "1,234.50" is not accepted on purpose: the API never prints thousands separators. */
export function fils(amount: string | number): Fils {
  const text = typeof amount === 'number' ? amount.toFixed(2) : amount.trim();
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) throw new Error(`Not a money amount with at most two decimals: "${amount}"`);
  const value = BigInt(m[2]) * 100n + BigInt((m[3] ?? '').padEnd(2, '0') || '0');
  return m[1] ? -value : value;
}

/** Two-decimal string, the format of every amount in an API response. */
export function aed(value: Fils): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  return `${negative ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

export const sum = (values: Fils[]): Fils => values.reduce((a, b) => a + b, 0n);

/** value x numerator / denominator, rounded half-up to the fils (for non-negative operands). */
export function ratio(value: Fils, numerator: bigint, denominator: bigint): Fils {
  if (value < 0n || numerator < 0n || denominator <= 0n) throw new Error('ratio() is defined for non-negative operands');
  return (value * numerator * 2n + denominator) / (denominator * 2n);
}

/** Percentage of an amount, rounded half-up to the fils: percent(fils('100.00'), 5) = 5.00. `rate` may have two decimals. */
export function percent(value: Fils, rate: string | number): Fils {
  return ratio(value, fils(rate), 10000n);
}

/** Shorthand used all over the reconciliation spec. */
export const m = (amount: string | number): Fils => fils(amount);
