import { D, DecimalInput, money, sum } from '../../common/pagination';

/**
 * Service price calculation. Pure and decimal-safe: no database, no floats.
 *
 * The finance module mirrors exactly this rule when it builds quotation and
 * invoice lines, so the rule lives in one small file:
 *
 *  1. Price row:    a branch-specific price beats the default price. The row in force
 *                   is the ACTIVE one (isActive, not ended). validFrom / validTo record
 *                   the history; a price takes effect the moment it is set, so two
 *                   machines with slightly different clocks always pick the same row.
 *  2. Service fee:  a corporate contract price replaces ONLY the service fee.
 *                   Government and third-party amounts are pass-through estimates
 *                   and are never discounted by a contract.
 *  3. Tax:          per component, rounded half-up to 2 decimals, then added up
 *                     SERVICE_FEE_ONLY  tax on the service fee only
 *                     ALL_COMPONENTS    tax on every component
 *                     NONE              no tax
 *  4. Due up front: BEFORE_PROCESSING = the total, AFTER_COMPLETION = nothing,
 *                   DEPOSIT = depositPercent of the total (rounded half-up).
 */

export type TaxMode = 'SERVICE_FEE_ONLY' | 'ALL_COMPONENTS' | 'NONE';
export type PaymentPolicy = 'BEFORE_PROCESSING' | 'AFTER_COMPLETION' | 'DEPOSIT';
export type FeeComponentKey = 'SERVICE_FEE' | 'GOVERNMENT_FEE' | 'THIRD_PARTY_FEE';

export interface PriceRow {
  id: string;
  branchId: string | null;
  serviceFee: DecimalInput;
  governmentFeeEstimate: DecimalInput;
  thirdPartyFeeEstimate: DecimalInput;
  currency: string;
  isActive: boolean;
  validFrom: Date;
  validTo: Date | null;
}

/** Rule 1. Among the active rows, the branch row wins over the default row. */
export function selectPriceRow<T extends PriceRow>(rows: T[], branchId?: string | null, at: Date = new Date()): { row: T; source: 'BRANCH' | 'DEFAULT' } | null {
  const inForce = rows
    .filter((r) => r.isActive && (r.validTo === null || r.validTo.getTime() > at.getTime()))
    // Should history ever leave two active rows for one scope, the most recent one applies.
    .sort((a, b) => b.validFrom.getTime() - a.validFrom.getTime());
  const branch = branchId ? inForce.find((r) => r.branchId === branchId) : undefined;
  if (branch) return { row: branch, source: 'BRANCH' };
  const fallback = inForce.find((r) => r.branchId === null);
  return fallback ? { row: fallback, source: 'DEFAULT' } : null;
}

export interface PriceInput {
  serviceFee: DecimalInput;
  governmentFeeEstimate?: DecimalInput | null;
  thirdPartyFeeEstimate?: DecimalInput | null;
  /** Contract service fee of a corporate account, when one exists for this service. */
  corporateServiceFee?: DecimalInput | null;
  taxMode: TaxMode;
  /** The centre's tax rate in percent, e.g. 5 for 5%. */
  taxRatePercent: DecimalInput;
  paymentPolicy?: PaymentPolicy;
  depositPercent?: DecimalInput | null;
}
export interface PriceComponent {
  component: FeeComponentKey;
  amount: string;
  /** Government and third-party amounts are estimates until the real charge is known. */
  isEstimate: boolean;
  taxable: boolean;
  taxAmount: string;
  total: string;
}
export interface PriceBreakdown {
  serviceFee: string;
  /** Where the service fee came from. */
  serviceFeeSource: 'CATALOGUE' | 'CORPORATE_CONTRACT';
  /** The catalogue service fee before any contract price. */
  listServiceFee: string;
  governmentFeeEstimate: string;
  thirdPartyFeeEstimate: string;
  taxMode: TaxMode;
  taxRatePercent: string;
  components: PriceComponent[];
  subtotal: string;
  taxableAmount: string;
  taxAmount: string;
  total: string;
  paymentPolicy: PaymentPolicy;
  depositPercent: string | null;
  /** What must be paid before work starts, according to the payment policy. */
  dueBeforeProcessing: string;
}

const TAXED: Record<TaxMode, FeeComponentKey[]> = {
  SERVICE_FEE_ONLY: ['SERVICE_FEE'],
  ALL_COMPONENTS: ['SERVICE_FEE', 'GOVERNMENT_FEE', 'THIRD_PARTY_FEE'],
  NONE: [],
};
const nonNegative = (value: DecimalInput | null | undefined, what: string) => {
  const d = D(value);
  if (d.isNaN() || !d.isFinite() || d.isNegative()) throw new RangeError(`${what} must be a non-negative amount.`);
  return d;
};

/** Tax on one amount: rate percent of the amount, rounded half-up to 2 decimals. */
export function taxOn(amount: DecimalInput, taxRatePercent: DecimalInput): string {
  return money(D(amount).times(D(taxRatePercent)).dividedBy(100)).toFixed(2);
}

/** Rules 2 - 4. Throws RangeError on negative amounts or a tax rate / deposit outside 0-100. */
export function calculatePrice(input: PriceInput): PriceBreakdown {
  const listFee = money(nonNegative(input.serviceFee, 'Service fee'));
  const contract = input.corporateServiceFee === null || input.corporateServiceFee === undefined ? null : money(nonNegative(input.corporateServiceFee, 'Contract service fee'));
  const serviceFee = contract ?? listFee;
  const government = money(nonNegative(input.governmentFeeEstimate, 'Government fee estimate'));
  const thirdParty = money(nonNegative(input.thirdPartyFeeEstimate, 'Third-party fee estimate'));
  const rate = nonNegative(input.taxRatePercent, 'Tax rate');
  if (rate.greaterThan(100)) throw new RangeError('Tax rate must be between 0 and 100.');
  if (!TAXED[input.taxMode]) throw new RangeError(`Unknown tax mode "${input.taxMode}".`);

  const amounts: Array<[FeeComponentKey, ReturnType<typeof D>, boolean]> = [
    ['SERVICE_FEE', serviceFee, false],
    ['GOVERNMENT_FEE', government, true],
    ['THIRD_PARTY_FEE', thirdParty, true],
  ];
  const components = amounts.map(([component, amount, isEstimate]) => {
    const taxable = TAXED[input.taxMode].includes(component);
    const tax = taxable ? money(amount.times(rate).dividedBy(100)) : D(0);
    return { component, amount, isEstimate, taxable, tax };
  });
  const subtotal = sum(components.map((c) => c.amount));
  const taxableAmount = sum(components.filter((c) => c.taxable).map((c) => c.amount));
  const taxAmount = sum(components.map((c) => c.tax));
  const total = subtotal.plus(taxAmount);

  const paymentPolicy = input.paymentPolicy ?? 'BEFORE_PROCESSING';
  let depositPercent: ReturnType<typeof D> | null = null;
  let due = total;
  if (paymentPolicy === 'AFTER_COMPLETION') due = D(0);
  else if (paymentPolicy === 'DEPOSIT') {
    depositPercent = nonNegative(input.depositPercent, 'Deposit percent');
    if (depositPercent.isZero() || depositPercent.greaterThan(100)) throw new RangeError('Deposit percent must be more than 0 and at most 100.');
    due = money(total.times(depositPercent).dividedBy(100));
  }

  return {
    serviceFee: serviceFee.toFixed(2),
    serviceFeeSource: contract ? 'CORPORATE_CONTRACT' : 'CATALOGUE',
    listServiceFee: listFee.toFixed(2),
    governmentFeeEstimate: government.toFixed(2),
    thirdPartyFeeEstimate: thirdParty.toFixed(2),
    taxMode: input.taxMode,
    taxRatePercent: rate.toFixed(2),
    components: components.map((c) => ({
      component: c.component,
      amount: c.amount.toFixed(2),
      isEstimate: c.isEstimate,
      taxable: c.taxable,
      taxAmount: c.tax.toFixed(2),
      total: c.amount.plus(c.tax).toFixed(2),
    })),
    subtotal: subtotal.toFixed(2),
    taxableAmount: taxableAmount.toFixed(2),
    taxAmount: taxAmount.toFixed(2),
    total: total.toFixed(2),
    paymentPolicy,
    depositPercent: depositPercent ? depositPercent.toFixed(2) : null,
    dueBeforeProcessing: due.toFixed(2),
  };
}
