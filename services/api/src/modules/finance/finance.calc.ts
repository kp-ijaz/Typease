import { Prisma } from '@typease/database';
import { D, DecimalInput, money, sum } from '../../common/pagination';

/**
 * Pure money arithmetic for quotations, invoices, payments and refunds.
 * No database access: everything here is unit-tested in finance.calc.unit.spec.ts.
 *
 * Rules (they mirror the database check constraints in 0003_integrity.sql):
 *   gross      = round2(quantity * unitAmount)
 *   lineNet    = gross - discountAmount            (a discount can never exceed the line)
 *   taxAmount  = round2(lineNet * taxRatePercent / 100)      (half-up, per line)
 *   lineTotal  = lineNet + taxAmount
 *   subtotal<Component> = sum(gross) of the lines of that component   (gross of discount)
 *   discountTotal       = sum(discountAmount)
 *   taxTotal            = sum(taxAmount)
 *   total = subtotalServiceFee + subtotalGovernmentFee + subtotalThirdParty - discountTotal + taxTotal
 */

export type Component = 'SERVICE_FEE' | 'GOVERNMENT_FEE' | 'THIRD_PARTY_FEE';
export const COMPONENTS: Component[] = ['SERVICE_FEE', 'GOVERNMENT_FEE', 'THIRD_PARTY_FEE'];
export const PASS_THROUGH: Array<Exclude<Component, 'SERVICE_FEE'>> = ['GOVERNMENT_FEE', 'THIRD_PARTY_FEE'];
export type TaxMode = 'SERVICE_FEE_ONLY' | 'ALL_COMPONENTS' | 'NONE';
type Dec = Prisma.Decimal;

export class CalculationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly line?: number,
  ) {
    super(message);
  }
}

export interface LineInput {
  serviceId?: string | null;
  description: string;
  component: Component;
  quantity?: DecimalInput;
  unitAmount: DecimalInput;
  discountAmount?: DecimalInput;
  /** Explicit per-line rate. When omitted the caller's default (from the tax mode) applies. */
  taxRatePercent?: DecimalInput | null;
}
export interface CalculatedLine {
  serviceId: string | null;
  description: string;
  component: Component;
  quantity: Dec;
  unitAmount: Dec;
  discountAmount: Dec;
  taxRatePercent: Dec;
  taxAmount: Dec;
  lineTotal: Dec;
  sortOrder: number;
  /** quantity * unitAmount, before discount and tax. */
  gross: Dec;
  lineNet: Dec;
}
export interface DocumentTotals {
  subtotalServiceFee: Dec;
  subtotalGovernmentFee: Dec;
  subtotalThirdParty: Dec;
  discountTotal: Dec;
  taxTotal: Dec;
  total: Dec;
}
export interface CalculatedDocument extends DocumentTotals {
  lines: CalculatedLine[];
  hasDiscount: boolean;
}

/** Default tax rate of a line from the service's tax mode and the centre's rate. */
export function defaultTaxRate(taxMode: TaxMode | string | null | undefined, component: Component, tenantRatePercent: DecimalInput): Dec {
  const rate = D(tenantRatePercent);
  switch (taxMode) {
    case 'ALL_COMPONENTS':
      return rate;
    case 'NONE':
      return D(0);
    case 'SERVICE_FEE_ONLY':
    default:
      return component === 'SERVICE_FEE' ? rate : D(0);
  }
}

export function calculateLine(input: LineInput, index = 0, fallbackTaxRate: DecimalInput = 0): CalculatedLine {
  const quantity = D(input.quantity ?? 1);
  const unitAmount = D(input.unitAmount);
  const discountAmount = D(input.discountAmount ?? 0);
  const taxRatePercent = D(input.taxRatePercent ?? fallbackTaxRate);
  const n = index + 1;
  if (quantity.lte(0)) throw new CalculationError('INVALID_QUANTITY', `Line ${n}: the quantity must be greater than zero.`, index);
  if (quantity.decimalPlaces() > 2) throw new CalculationError('INVALID_QUANTITY', `Line ${n}: the quantity can have at most two decimals.`, index);
  if (unitAmount.lt(0) || unitAmount.decimalPlaces() > 2) throw new CalculationError('INVALID_AMOUNT', `Line ${n}: enter a valid amount.`, index);
  if (discountAmount.lt(0) || discountAmount.decimalPlaces() > 2) throw new CalculationError('INVALID_DISCOUNT', `Line ${n}: enter a valid discount.`, index);
  if (taxRatePercent.lt(0) || taxRatePercent.gt(100)) throw new CalculationError('INVALID_TAX_RATE', `Line ${n}: the tax rate must be between 0 and 100.`, index);
  const gross = money(quantity.mul(unitAmount));
  if (discountAmount.gt(gross)) {
    throw new CalculationError('DISCOUNT_EXCEEDS_LINE', `Line ${n}: the discount (${discountAmount.toFixed(2)}) is larger than the line amount (${gross.toFixed(2)}).`, index);
  }
  const lineNet = gross.minus(discountAmount);
  const taxAmount = money(lineNet.mul(taxRatePercent).div(100));
  return {
    serviceId: input.serviceId ?? null,
    description: input.description,
    component: input.component,
    quantity,
    unitAmount,
    discountAmount,
    taxRatePercent,
    taxAmount,
    lineTotal: lineNet.plus(taxAmount),
    sortOrder: index,
    gross,
    lineNet,
  };
}

/**
 * Calculates every line and the header totals.
 * `fallbackTaxRate(line)` supplies the rate for lines without an explicit one.
 */
export function calculateDocument(inputs: LineInput[], fallbackTaxRate: (line: LineInput) => DecimalInput = () => 0): CalculatedDocument {
  if (!inputs.length) throw new CalculationError('NO_LINES', 'Add at least one line.');
  const lines = inputs.map((l, i) => calculateLine(l, i, fallbackTaxRate(l)));
  const of = (c: Component) => sum(lines.filter((l) => l.component === c).map((l) => l.gross));
  const subtotalServiceFee = of('SERVICE_FEE');
  const subtotalGovernmentFee = of('GOVERNMENT_FEE');
  const subtotalThirdParty = of('THIRD_PARTY_FEE');
  const discountTotal = sum(lines.map((l) => l.discountAmount));
  const taxTotal = sum(lines.map((l) => l.taxAmount));
  const total = subtotalServiceFee.plus(subtotalGovernmentFee).plus(subtotalThirdParty).minus(discountTotal).plus(taxTotal);
  return { lines, subtotalServiceFee, subtotalGovernmentFee, subtotalThirdParty, discountTotal, taxTotal, total, hasDiscount: discountTotal.gt(0) };
}

/** Re-derives totals from stored lines (used to verify persisted documents). */
export function totalsFromStoredLines(
  lines: Array<{ component: Component; quantity: DecimalInput; unitAmount: DecimalInput; discountAmount: DecimalInput; taxAmount: DecimalInput }>,
): DocumentTotals {
  const gross = (c: Component) => sum(lines.filter((l) => l.component === c).map((l) => money(D(l.quantity).mul(D(l.unitAmount)))));
  const subtotalServiceFee = gross('SERVICE_FEE');
  const subtotalGovernmentFee = gross('GOVERNMENT_FEE');
  const subtotalThirdParty = gross('THIRD_PARTY_FEE');
  const discountTotal = sum(lines.map((l) => l.discountAmount));
  const taxTotal = sum(lines.map((l) => l.taxAmount));
  return {
    subtotalServiceFee,
    subtotalGovernmentFee,
    subtotalThirdParty,
    discountTotal,
    taxTotal,
    total: subtotalServiceFee.plus(subtotalGovernmentFee).plus(subtotalThirdParty).minus(discountTotal).plus(taxTotal),
  };
}

export type ComponentAmounts = Record<Component, Dec>;
export const zeroComponents = (): ComponentAmounts => ({ SERVICE_FEE: D(0), GOVERNMENT_FEE: D(0), THIRD_PARTY_FEE: D(0) });

/** What the customer owes per component: sum of lineTotal (net of discount, including tax) of that component. */
export function componentTotals(lines: Array<{ component: Component; lineTotal: DecimalInput }>): ComponentAmounts {
  const out = zeroComponents();
  for (const l of lines) out[l.component] = out[l.component].plus(D(l.lineTotal));
  return out;
}

/**
 * Pass-through share of the money collected so far.
 *
 * For an invoice whose (credit-adjusted) component totals are `effective`, and on
 * which `netPaid` (payments - refunds) has been collected, the government-fee and
 * third-party shares are
 *
 *     round2(netPaid * effective[component] / effectiveTotal)       (half-up)
 *
 * computed on the CUMULATIVE amount, so that:
 *   - a partial payment is spread over the components in proportion to the invoice;
 *   - once the invoice is fully paid the accrued shares equal the component totals
 *     exactly (no drift from rounding each instalment separately);
 *   - the rounding remainder always falls on the service-fee share
 *     (serviceFee = netPaid - governmentFee - thirdParty, never negative).
 */
export function passThroughTargets(netPaid: DecimalInput, effective: ComponentAmounts): ComponentAmounts {
  const paid = D(netPaid);
  const total = effective.SERVICE_FEE.plus(effective.GOVERNMENT_FEE).plus(effective.THIRD_PARTY_FEE);
  if (paid.lte(0) || total.lte(0)) return zeroComponents();
  const capped = Prisma.Decimal.min(paid, total);
  const share = (c: Component) => Prisma.Decimal.min(money(capped.mul(effective[c]).div(total)), effective[c]);
  const government = Prisma.Decimal.min(share('GOVERNMENT_FEE'), capped);
  const thirdParty = Prisma.Decimal.min(share('THIRD_PARTY_FEE'), capped.minus(government));
  return { GOVERNMENT_FEE: government, THIRD_PARTY_FEE: thirdParty, SERVICE_FEE: capped.minus(government).minus(thirdParty) };
}

/**
 * Liability movement needed after a payment: brings the net accrued amount of each
 * pass-through component up to its target. Never negative (a payment never reverses).
 */
export function accrualForPayment(netPaidAfter: DecimalInput, effective: ComponentAmounts, netAccrued: Pick<ComponentAmounts, 'GOVERNMENT_FEE' | 'THIRD_PARTY_FEE'>) {
  const target = passThroughTargets(netPaidAfter, effective);
  const delta = (c: 'GOVERNMENT_FEE' | 'THIRD_PARTY_FEE') => Prisma.Decimal.max(target[c].minus(netAccrued[c]), 0);
  return { GOVERNMENT_FEE: delta('GOVERNMENT_FEE'), THIRD_PARTY_FEE: delta('THIRD_PARTY_FEE') };
}

/**
 * Splits a refund of `amount` across the components.
 * Without an explicit breakdown the pass-through parts are whatever brings the net
 * accrued liability down to the target for the reduced `netPaid`; the rest
 * (including any rounding remainder) is service fee.
 */
export function splitRefund(
  amount: DecimalInput,
  netPaidBefore: DecimalInput,
  effective: ComponentAmounts,
  netAccrued: Pick<ComponentAmounts, 'GOVERNMENT_FEE' | 'THIRD_PARTY_FEE'>,
): ComponentAmounts {
  const refund = D(amount);
  const target = passThroughTargets(D(netPaidBefore).minus(refund), effective);
  let left = refund;
  const part = (c: 'GOVERNMENT_FEE' | 'THIRD_PARTY_FEE') => {
    const p = Prisma.Decimal.min(Prisma.Decimal.max(netAccrued[c].minus(target[c]), 0), left);
    left = left.minus(p);
    return p;
  };
  const government = part('GOVERNMENT_FEE');
  const thirdParty = part('THIRD_PARTY_FEE');
  return { GOVERNMENT_FEE: government, THIRD_PARTY_FEE: thirdParty, SERVICE_FEE: left };
}

/**
 * Splits an amount across components in proportion to `weights`, remainder on the
 * service fee. Used for credit notes without an explicit breakdown.
 */
export function splitProportionally(amount: DecimalInput, weights: ComponentAmounts): ComponentAmounts {
  const value = D(amount);
  const total = weights.SERVICE_FEE.plus(weights.GOVERNMENT_FEE).plus(weights.THIRD_PARTY_FEE);
  if (total.lte(0)) return { ...zeroComponents(), SERVICE_FEE: value };
  const government = Prisma.Decimal.min(money(value.mul(weights.GOVERNMENT_FEE).div(total)), weights.GOVERNMENT_FEE, value);
  const thirdParty = Prisma.Decimal.min(money(value.mul(weights.THIRD_PARTY_FEE).div(total)), weights.THIRD_PARTY_FEE, value.minus(government));
  return { GOVERNMENT_FEE: government, THIRD_PARTY_FEE: thirdParty, SERVICE_FEE: value.minus(government).minus(thirdParty) };
}

export type InvoiceMoneyStatus = 'ISSUED' | 'PARTIALLY_PAID' | 'PAID' | 'CREDITED';
export interface InvoiceAmounts {
  total: DecimalInput;
  amountPaid: DecimalInput;
  amountCredited: DecimalInput;
  amountRefunded: DecimalInput;
}
/**
 * balanceDue and status of an issued invoice from its amounts
 * (database rule: balanceDue = total - amountCredited - amountPaid + amountRefunded >= 0).
 */
export function invoiceState(a: InvoiceAmounts): { balanceDue: Dec; status: InvoiceMoneyStatus; netPaid: Dec } {
  const netPaid = D(a.amountPaid).minus(D(a.amountRefunded));
  const balanceDue = D(a.total).minus(D(a.amountCredited)).minus(netPaid);
  if (netPaid.lt(0)) throw new CalculationError('REFUND_EXCEEDS_PAID', 'More would be refunded than was paid on this invoice.');
  if (balanceDue.lt(0)) throw new CalculationError('OVER_SETTLED', 'Payments and credits would exceed the invoice total.');
  let status: InvoiceMoneyStatus;
  if (balanceDue.isZero()) status = netPaid.isZero() && D(a.amountCredited).gt(0) ? 'CREDITED' : 'PAID';
  else status = netPaid.gt(0) ? 'PARTIALLY_PAID' : 'ISSUED';
  return { balanceDue, status, netPaid };
}

// ---------------------------------------------------------------------------------------------
// Due dates and "overdue"
// ---------------------------------------------------------------------------------------------
/** Statuses in which an invoice still expects money. */
export const OPEN_INVOICE_STATUSES: Array<'ISSUED' | 'PARTIALLY_PAID'> = ['ISSUED', 'PARTIALLY_PAID'];
export const DEFAULT_FINANCE_TIME_ZONE = 'Asia/Dubai';

function zoneParts(at: Date, timeZone: string): { y: number; m: number; d: number; offsetMs: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return { y: n('year'), m: n('month'), d: n('day'), offsetMs: asUtc - Math.floor(at.getTime() / 1000) * 1000 };
}
const validZone = (timeZone: string | null | undefined): string => {
  try {
    if (timeZone) new Intl.DateTimeFormat('en-CA', { timeZone });
    return timeZone || DEFAULT_FINANCE_TIME_ZONE;
  } catch {
    return DEFAULT_FINANCE_TIME_ZONE;
  }
};

/**
 * When an invoice issued at `issuedAt` with payment terms of `termsDays` falls due: the END of the due day
 * (23:59:59.999) on the centre's calendar. Terms of 0 days ("due on receipt") therefore mean "by the end of
 * today", never "already overdue the moment it exists".
 */
export function invoiceDueAt(issuedAt: Date, termsDays: number, timeZone: string | null | undefined): Date {
  const zone = validZone(timeZone);
  const local = zoneParts(issuedAt, zone);
  const days = Number.isFinite(termsDays) && termsDays > 0 ? Math.floor(termsDays) : 0;
  // Midnight that ends the due day, as if the local wall clock were UTC ...
  const nextMidnightWall = Date.UTC(local.y, local.m - 1, local.d + days + 1, 0, 0, 0);
  // ... moved to the real instant with the zone's offset at that time (two passes settle a DST change).
  let instant = nextMidnightWall - local.offsetMs;
  instant = nextMidnightWall - zoneParts(new Date(instant), zone).offsetMs;
  return new Date(instant - 1);
}

/**
 * The one definition of "overdue" for customer invoices: the invoice still expects money (issued or partly
 * paid, balance above zero) and the due moment has passed (`now > dueAt`). An invoice without a due date, a
 * draft, a paid, credited or void invoice is never overdue.
 */
export function isInvoiceOverdue(invoice: { status: string; dueAt?: Date | null; balanceDue?: DecimalInput | null }, now: Date = new Date()): boolean {
  if (!(OPEN_INVOICE_STATUSES as string[]).includes(invoice.status) || !invoice.dueAt) return false;
  if (invoice.balanceDue !== undefined && invoice.balanceDue !== null && !D(invoice.balanceDue).gt(0)) return false;
  return now.getTime() > invoice.dueAt.getTime();
}
/** The same definition as a database filter. */
export const overdueInvoiceWhere = (now: Date = new Date()) => ({ status: { in: OPEN_INVOICE_STATUSES }, dueAt: { lt: now }, balanceDue: { gt: 0 } });
/** Whole days an invoice is past due (0 when it is not). */
export const daysOverdue = (dueAt: Date | null | undefined, now: Date): number => (dueAt && now.getTime() > dueAt.getTime() ? Math.ceil((now.getTime() - dueAt.getTime()) / 86_400_000) : 0);

/** Ageing bucket of an open invoice by days past its due date. */
export type AgeingBucket = 'current' | 'days1to30' | 'days31to60' | 'days61to90' | 'days90plus';
export function ageingBucket(dueAt: Date | null | undefined, now: Date): AgeingBucket {
  const days = daysOverdue(dueAt, now);
  if (!days) return 'current';
  if (days <= 30) return 'days1to30';
  if (days <= 60) return 'days31to60';
  if (days <= 90) return 'days61to90';
  return 'days90plus';
}

export const fmt = (v: DecimalInput | null | undefined) => D(v).toFixed(2);
