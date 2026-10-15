import { fromMinorUnits, toMinorUnits } from '@typease/ui';
import type { FeeComponentType } from './types';

/**
 * Preview arithmetic for the line editor and the allocation form. Integer minor units
 * (BigInt) only: no floating point touches an amount. The API calculates the real totals
 * with the same rules (docs/api/modules/finance.md, "Lines and totals"); what the browser
 * shows before saving is labelled as a preview.
 */

const DECIMAL = /^\d{1,11}(\.\d{1,2})?$/;
/** "2.5" -> 250n (hundredths). Null for anything that is not a plain decimal with at most two places. */
export function hundredths(value: string | number | null | undefined): bigint | null {
  const text = String(value ?? '').trim();
  if (!DECIMAL.test(text)) return null;
  return toMinorUnits(text);
}

/** Integer division rounded half-up (both operands non-negative). */
const divHalfUp = (n: bigint, d: bigint) => (n * 2n + d) / (d * 2n);

export interface LineDraft {
  component: FeeComponentType;
  quantity?: string | number | null;
  unitAmount?: string | number | null;
  discountAmount?: string | number | null;
  /** Empty = the default rate for the component. */
  taxRatePercent?: string | number | null;
}
export interface LinePreview {
  valid: boolean;
  gross: bigint;
  discount: bigint;
  tax: bigint;
  total: bigint;
  /** The discount is larger than the line, or sits on a pass-through fee. */
  discountProblem: 'EXCEEDS_LINE' | 'PASS_THROUGH' | null;
}

export function previewLine(line: LineDraft, defaultRates: Record<FeeComponentType, string>): LinePreview {
  const quantity = hundredths(line.quantity === '' || line.quantity == null ? '1' : line.quantity);
  const unit = hundredths(line.unitAmount);
  const discount = hundredths(line.discountAmount === '' || line.discountAmount == null ? '0' : line.discountAmount);
  const rate = hundredths(line.taxRatePercent === '' || line.taxRatePercent == null ? defaultRates[line.component] ?? '0' : line.taxRatePercent);
  if (quantity === null || unit === null || discount === null || rate === null || quantity === 0n) {
    return { valid: false, gross: 0n, discount: 0n, tax: 0n, total: 0n, discountProblem: null };
  }
  // quantity and unit are both in hundredths: the product is in ten-thousandths.
  const gross = divHalfUp(quantity * unit, 100n);
  const discountProblem = discount > gross ? 'EXCEEDS_LINE' : discount > 0n && line.component !== 'SERVICE_FEE' ? 'PASS_THROUGH' : null;
  const net = discount > gross ? 0n : gross - discount;
  const tax = divHalfUp(net * rate, 10_000n);
  return { valid: true, gross, discount, tax, total: net + tax, discountProblem };
}

export interface TotalsPreview {
  subtotalServiceFee: string;
  subtotalGovernmentFee: string;
  subtotalThirdParty: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  /** False while a line is incomplete: the totals then cover the complete lines only. */
  complete: boolean;
  hasDiscount: boolean;
}

export function previewTotals(lines: LineDraft[], defaultRates: Record<FeeComponentType, string>): TotalsPreview {
  const sum: Record<FeeComponentType, bigint> = { SERVICE_FEE: 0n, GOVERNMENT_FEE: 0n, THIRD_PARTY_FEE: 0n };
  let discount = 0n;
  let tax = 0n;
  let complete = lines.length > 0;
  for (const line of lines) {
    const p = previewLine(line, defaultRates);
    if (!p.valid) {
      complete = false;
      continue;
    }
    sum[line.component] += p.gross;
    discount += p.discount > p.gross ? p.gross : p.discount;
    tax += p.tax;
  }
  const total = sum.SERVICE_FEE + sum.GOVERNMENT_FEE + sum.THIRD_PARTY_FEE - discount + tax;
  return {
    subtotalServiceFee: fromMinorUnits(sum.SERVICE_FEE),
    subtotalGovernmentFee: fromMinorUnits(sum.GOVERNMENT_FEE),
    subtotalThirdParty: fromMinorUnits(sum.THIRD_PARTY_FEE),
    discountTotal: fromMinorUnits(discount),
    taxTotal: fromMinorUnits(tax),
    total: fromMinorUnits(total),
    complete,
    hasDiscount: discount > 0n,
  };
}

/** Sum of decimal strings that may still be incomplete while typing (invalid entries count as zero). */
export function sumAmounts(values: Array<string | null | undefined>): string {
  let total = 0n;
  for (const v of values) total += hundredths(v) ?? 0n;
  return fromMinorUnits(total);
}

/** a - b as a signed decimal string; invalid input counts as zero. */
export function diffAmounts(a: string | null | undefined, b: string | null | undefined): string {
  return fromMinorUnits((hundredths(a) ?? 0n) - (hundredths(b) ?? 0n));
}

/**
 * Spreads an amount over open balances, first entry first (the caller sorts oldest first).
 * Returns one amount per balance ("0.00" where nothing is left) and what could not be placed.
 */
export function allocateOldestFirst(amount: string | null | undefined, balances: string[]): { amounts: string[]; unplaced: string } {
  let left = hundredths(amount) ?? 0n;
  const amounts = balances.map((balance) => {
    const open = hundredths(balance) ?? 0n;
    const take = left < open ? left : open;
    left -= take;
    return fromMinorUnits(take);
  });
  return { amounts, unplaced: fromMinorUnits(left) };
}

export const isPositiveAmount = (value: string | null | undefined) => (hundredths(value) ?? 0n) > 0n;
export const minAmount = (a: string, b: string) => ((hundredths(a) ?? 0n) <= (hundredths(b) ?? 0n) ? a : b);
