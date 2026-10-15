import { derivePaymentStatus, InvoiceFigures, paymentPosition, paymentRequirement } from './payment-policy';

const inv = (total: number, paid = 0, extra: Partial<InvoiceFigures> = {}): InvoiceFigures => {
  const credited = Number(extra.amountCredited ?? 0);
  const refunded = Number(extra.amountRefunded ?? 0);
  return { status: paid >= total - credited ? 'PAID' : paid > 0 ? 'PARTIALLY_PAID' : 'ISSUED', total, amountPaid: paid, amountCredited: credited, amountRefunded: refunded, balanceDue: total - credited - paid + refunded, ...extra };
};
const need = (invoices: InvoiceFigures[], policy: string, stage: 'PROCESSING' | 'COMPLETION', extra: { depositPercent?: number | null; corporateCredit?: boolean; quoted?: number | null } = {}) =>
  paymentRequirement({ policy, stage, position: paymentPosition(invoices), depositPercent: extra.depositPercent, corporateCredit: extra.corporateCredit ?? false, approvedQuotationTotal: extra.quoted === undefined ? null : extra.quoted });

describe('payment position and status', () => {
  it('adds up issued invoices and ignores drafts and void invoices', () => {
    const p = paymentPosition([inv(100, 40), inv(50, 50), inv(999, 0, { status: 'DRAFT' }), inv(500, 0, { status: 'VOID' })]);
    expect([p.invoiced.toFixed(2), p.paid.toFixed(2), p.balance.toFixed(2), p.hasInvoice]).toEqual(['150.00', '90.00', '60.00', true]);
    expect(paymentPosition([inv(10, 0, { status: 'DRAFT' })]).hasInvoice).toBe(false);
  });

  it('never loses fils to floating point', () => {
    const p = paymentPosition([{ status: 'ISSUED', total: '0.10', amountPaid: '0.00', amountCredited: '0.00', amountRefunded: '0.00', balanceDue: '0.10' }, { status: 'ISSUED', total: '0.20', amountPaid: '0.00', amountCredited: '0.00', amountRefunded: '0.00', balanceDue: '0.20' }]);
    expect(p.balance.toString()).toBe('0.3');
  });

  it('derives the request payment status', () => {
    const status = (invoices: InvoiceFigures[]) => derivePaymentStatus(paymentPosition(invoices));
    expect(status([])).toBe('UNPAID');
    expect(status([inv(100)])).toBe('UNPAID');
    expect(status([inv(100, 30)])).toBe('PARTIALLY_PAID');
    expect(status([inv(100, 100)])).toBe('PAID');
    expect(status([inv(100, 100), inv(50)])).toBe('PARTIALLY_PAID');
    expect(status([inv(0, 0)])).toBe('NOT_REQUIRED');
    expect(status([inv(100, 0, { amountCredited: 100, status: 'CREDITED' })])).toBe('NOT_REQUIRED');
    expect(status([inv(100, 100, { amountRefunded: 40 })])).toBe('PARTIALLY_REFUNDED');
    expect(status([inv(100, 100, { amountRefunded: 100 })])).toBe('REFUNDED');
  });
});

describe('payment policy', () => {
  it('BEFORE_PROCESSING needs the invoices fully paid before work starts', () => {
    expect(need([inv(200, 200)], 'BEFORE_PROCESSING', 'PROCESSING')).toMatchObject({ satisfied: true, basis: 'PAID' });
    const due = need([inv(200, 150)], 'BEFORE_PROCESSING', 'PROCESSING');
    expect(due).toMatchObject({ satisfied: false, basis: 'BALANCE_DUE' });
    expect(due.outstanding.toFixed(2)).toBe('50.00');
  });

  it('DEPOSIT needs the percentage of the invoiced total (everything when no percentage is set)', () => {
    expect(need([inv(200, 60)], 'DEPOSIT', 'PROCESSING', { depositPercent: 30 })).toMatchObject({ satisfied: true, basis: 'DEPOSIT_PAID' });
    const short = need([inv(200, 59.99)], 'DEPOSIT', 'PROCESSING', { depositPercent: 30 });
    expect(short.satisfied).toBe(false);
    expect([short.required.toFixed(2), short.outstanding.toFixed(2)]).toEqual(['60.00', '0.01']);
    expect(need([inv(200, 199)], 'DEPOSIT', 'PROCESSING', { depositPercent: null }).satisfied).toBe(false);
    // A refund reduces what counts as paid.
    expect(need([inv(200, 60, { amountRefunded: 10 })], 'DEPOSIT', 'PROCESSING', { depositPercent: 30 }).satisfied).toBe(false);
  });

  it('AFTER_COMPLETION needs nothing before processing but everything before completion', () => {
    expect(need([inv(200)], 'AFTER_COMPLETION', 'PROCESSING')).toMatchObject({ satisfied: true, basis: 'NOT_DUE_YET' });
    expect(need([], 'AFTER_COMPLETION', 'PROCESSING', { quoted: 200 })).toMatchObject({ satisfied: true, basis: 'NOT_DUE_YET' });
    expect(need([inv(200)], 'AFTER_COMPLETION', 'COMPLETION')).toMatchObject({ satisfied: false, basis: 'BALANCE_DUE' });
    expect(need([inv(200, 200)], 'AFTER_COMPLETION', 'COMPLETION').satisfied).toBe(true);
  });

  it('every policy needs a zero balance before completion', () => {
    for (const policy of ['BEFORE_PROCESSING', 'DEPOSIT', 'AFTER_COMPLETION']) {
      expect(need([inv(200, 60)], policy, 'COMPLETION', { depositPercent: 30 }).satisfied).toBe(false);
      expect(need([inv(200, 200)], policy, 'COMPLETION', { depositPercent: 30 }).satisfied).toBe(true);
    }
  });

  it('a missing invoice is never mistaken for "paid"', () => {
    expect(need([], 'BEFORE_PROCESSING', 'PROCESSING', { quoted: 150 })).toMatchObject({ satisfied: false, basis: 'NO_INVOICE' });
    expect(need([], 'BEFORE_PROCESSING', 'PROCESSING')).toMatchObject({ satisfied: false, basis: 'NO_INVOICE' });
    expect(need([], 'DEPOSIT', 'PROCESSING', { quoted: 150, depositPercent: 50 }).outstanding.toFixed(2)).toBe('75.00');
    expect(need([], 'AFTER_COMPLETION', 'COMPLETION', { quoted: 150 })).toMatchObject({ satisfied: false, basis: 'NO_INVOICE' });
    // Nothing quoted and nothing invoiced: there is nothing to collect.
    expect(need([], 'BEFORE_PROCESSING', 'PROCESSING', { quoted: 0 })).toMatchObject({ satisfied: true, basis: 'NOTHING_CHARGED' });
    expect(need([], 'AFTER_COMPLETION', 'COMPLETION')).toMatchObject({ satisfied: true, basis: 'NOTHING_CHARGED' });
  });

  it('approved corporate credit satisfies every stage', () => {
    expect(need([inv(200)], 'BEFORE_PROCESSING', 'PROCESSING', { corporateCredit: true })).toMatchObject({ satisfied: true, basis: 'CORPORATE_CREDIT' });
    expect(need([inv(200)], 'BEFORE_PROCESSING', 'COMPLETION', { corporateCredit: true }).satisfied).toBe(true);
    expect(need([], 'DEPOSIT', 'PROCESSING', { corporateCredit: true, quoted: 500 }).satisfied).toBe(true);
  });
});
