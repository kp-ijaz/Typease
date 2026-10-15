import type { RequestPaymentStatus } from '@typease/types';
import { D, DecimalInput, Money, money, sum } from '../../common/pagination';

/**
 * Pure payment arithmetic of a request, derived from the invoices that the
 * finance module maintains (the requests module only reads them).
 */
export interface InvoiceFigures {
  status: string;
  total: DecimalInput;
  amountPaid: DecimalInput;
  amountCredited: DecimalInput;
  amountRefunded: DecimalInput;
  balanceDue: DecimalInput;
}
/** Drafts are not yet owed and void invoices no longer are. */
export const COUNTED_INVOICE_STATUSES = ['ISSUED', 'PARTIALLY_PAID', 'PAID', 'CREDITED'];

export interface PaymentPosition {
  hasInvoice: boolean;
  /** Invoiced total after credit notes. */
  invoiced: Money;
  /** Payments received, before refunds. */
  received: Money;
  refunded: Money;
  /** Money the centre currently holds for this request (received - refunded). */
  paid: Money;
  balance: Money;
}

export function paymentPosition(invoices: InvoiceFigures[]): PaymentPosition {
  const counted = invoices.filter((i) => COUNTED_INVOICE_STATUSES.includes(i.status));
  const received = sum(counted.map((i) => i.amountPaid));
  const refunded = sum(counted.map((i) => i.amountRefunded));
  return {
    hasInvoice: counted.length > 0,
    invoiced: sum(counted.map((i) => D(i.total).minus(D(i.amountCredited)))),
    received,
    refunded,
    paid: received.minus(refunded),
    balance: sum(counted.map((i) => i.balanceDue)),
  };
}

export function derivePaymentStatus(p: PaymentPosition): RequestPaymentStatus {
  if (!p.hasInvoice) return 'UNPAID';
  if (p.refunded.gt(0)) return p.paid.lte(0) ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  if (p.invoiced.lte(0)) return 'NOT_REQUIRED';
  if (p.balance.lte(0)) return 'PAID';
  return p.paid.gt(0) ? 'PARTIALLY_PAID' : 'UNPAID';
}

export type PaymentStage = 'PROCESSING' | 'COMPLETION';
export interface PaymentRequirement {
  satisfied: boolean;
  /** Why nothing (more) is needed, or why it is not satisfied. */
  basis: 'CORPORATE_CREDIT' | 'NOT_DUE_YET' | 'NOTHING_CHARGED' | 'PAID' | 'DEPOSIT_PAID' | 'NO_INVOICE' | 'BALANCE_DUE' | 'DEPOSIT_DUE';
  /** Amount that must have been paid at this stage. */
  required: Money;
  /** Still missing to satisfy the requirement. */
  outstanding: Money;
}

/**
 * Is the payment policy of the service satisfied at this stage?
 *
 *  PROCESSING (before work starts):
 *    BEFORE_PROCESSING  the request's invoices are fully paid
 *    DEPOSIT            paid >= depositPercent of the invoiced total (100% when no percentage is set)
 *    AFTER_COMPLETION   nothing is due yet
 *  COMPLETION (before the case can be closed): every policy needs a zero balance.
 *
 * A corporate request on an ACTIVE account with approved credit is invoiced on
 * account and never blocked. "No invoice" only counts as "nothing to pay" when
 * nothing was quoted either: an approved quotation above zero without an invoice
 * means finance has not issued it yet, so the request waits.
 */
export function paymentRequirement(input: {
  policy: string;
  depositPercent?: DecimalInput | null;
  stage: PaymentStage;
  position: PaymentPosition;
  corporateCredit: boolean;
  /** Total of the approved quotation, or null when there is none. */
  approvedQuotationTotal: DecimalInput | null;
}): PaymentRequirement {
  const { position: p, stage } = input;
  const zero = D(0);
  const ok = (basis: PaymentRequirement['basis'], required: Money = zero): PaymentRequirement => ({ satisfied: true, basis, required, outstanding: zero });
  if (input.corporateCredit) return ok('CORPORATE_CREDIT');
  if (stage === 'PROCESSING' && input.policy === 'AFTER_COMPLETION') return ok('NOT_DUE_YET');

  const quoted = input.approvedQuotationTotal === null ? null : D(input.approvedQuotationTotal);
  if (!p.hasInvoice) {
    if (quoted !== null && quoted.lte(0)) return ok('NOTHING_CHARGED');
    if (quoted === null && stage === 'COMPLETION') return ok('NOTHING_CHARGED');
    const expected = stage === 'PROCESSING' && input.policy === 'DEPOSIT' ? depositOf(quoted ?? zero, input.depositPercent) : (quoted ?? zero);
    return { satisfied: false, basis: 'NO_INVOICE', required: expected, outstanding: expected };
  }

  if (stage === 'PROCESSING' && input.policy === 'DEPOSIT') {
    const required = depositOf(p.invoiced, input.depositPercent);
    if (p.paid.gte(required)) return ok('DEPOSIT_PAID', required);
    return { satisfied: false, basis: 'DEPOSIT_DUE', required, outstanding: required.minus(p.paid) };
  }
  if (p.balance.lte(0)) return ok('PAID', p.invoiced);
  return { satisfied: false, basis: 'BALANCE_DUE', required: p.invoiced, outstanding: p.balance };
}

function depositOf(total: Money, percent: DecimalInput | null | undefined): Money {
  const pct = percent === null || percent === undefined ? D(100) : D(percent);
  return money(total.mul(pct).div(100));
}
