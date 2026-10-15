import { calculatePrice, selectPriceRow, taxOn, PriceRow } from './pricing';

const row = (over: Partial<PriceRow>): PriceRow => ({
  id: 'default', branchId: null, serviceFee: '100', governmentFeeEstimate: '0', thirdPartyFeeEstimate: '0', currency: 'AED',
  isActive: true, validFrom: new Date('2026-01-01T00:00:00Z'), validTo: null, ...over,
});
const NOW = new Date('2026-06-01T00:00:00Z');

describe('selectPriceRow (branch price > default price)', () => {
  it('uses the default price when no branch is given or the branch has no own price', () => {
    const rows = [row({}), row({ id: 'b1', branchId: 'branch-1', serviceFee: '80' })];
    expect(selectPriceRow(rows, null, NOW)).toMatchObject({ source: 'DEFAULT', row: { id: 'default' } });
    expect(selectPriceRow(rows, 'branch-2', NOW)).toMatchObject({ source: 'DEFAULT', row: { id: 'default' } });
  });
  it('prefers the branch price for that branch', () => {
    const rows = [row({}), row({ id: 'b1', branchId: 'branch-1', serviceFee: '80' })];
    expect(selectPriceRow(rows, 'branch-1', NOW)).toMatchObject({ source: 'BRANCH', row: { id: 'b1' } });
  });
  it('ignores closed and inactive rows', () => {
    const rows = [
      row({ id: 'old', validTo: new Date('2026-03-01T00:00:00Z') }),
      row({ id: 'off', isActive: false }),
      row({ id: 'b-old', branchId: 'branch-1', validTo: new Date('2026-02-01T00:00:00Z') }),
      row({ id: 'b-off', branchId: 'branch-1', isActive: false }),
    ];
    expect(selectPriceRow(rows, 'branch-1', NOW)).toBeNull();
    expect(selectPriceRow([...rows, row({ id: 'live' })], 'branch-1', NOW)).toMatchObject({ source: 'DEFAULT', row: { id: 'live' } });
  });
  it('the active flag decides, not the clock: a price set a moment "ahead" on another machine still applies', () => {
    const justSet = row({ id: 'new', validFrom: new Date(NOW.getTime() + 2_000) });
    expect(selectPriceRow([justSet], null, NOW)).toMatchObject({ source: 'DEFAULT', row: { id: 'new' } });
  });
  it('takes the most recent row if history left two in force', () => {
    const rows = [row({ id: 'a', validFrom: new Date('2026-01-01T00:00:00Z') }), row({ id: 'b', validFrom: new Date('2026-05-01T00:00:00Z') })];
    expect(selectPriceRow(rows, null, NOW)?.row.id).toBe('b');
  });
  it('returns null when there is no price at all', () => {
    expect(selectPriceRow([], null, NOW)).toBeNull();
  });
});

describe('calculatePrice', () => {
  const base = { serviceFee: '100.00', governmentFeeEstimate: '350.00', thirdPartyFeeEstimate: '50.00', taxRatePercent: '5' } as const;

  it('SERVICE_FEE_ONLY taxes the service fee and nothing else', () => {
    const p = calculatePrice({ ...base, taxMode: 'SERVICE_FEE_ONLY' });
    expect(p).toMatchObject({ subtotal: '500.00', taxableAmount: '100.00', taxAmount: '5.00', total: '505.00', taxRatePercent: '5.00', serviceFeeSource: 'CATALOGUE' });
    expect(p.components).toEqual([
      { component: 'SERVICE_FEE', amount: '100.00', isEstimate: false, taxable: true, taxAmount: '5.00', total: '105.00' },
      { component: 'GOVERNMENT_FEE', amount: '350.00', isEstimate: true, taxable: false, taxAmount: '0.00', total: '350.00' },
      { component: 'THIRD_PARTY_FEE', amount: '50.00', isEstimate: true, taxable: false, taxAmount: '0.00', total: '50.00' },
    ]);
  });
  it('ALL_COMPONENTS taxes every component', () => {
    const p = calculatePrice({ ...base, taxMode: 'ALL_COMPONENTS' });
    expect(p).toMatchObject({ taxableAmount: '500.00', taxAmount: '25.00', total: '525.00' });
    expect(p.components.every((c) => c.taxable)).toBe(true);
  });
  it('NONE charges no tax', () => {
    expect(calculatePrice({ ...base, taxMode: 'NONE' })).toMatchObject({ taxableAmount: '0.00', taxAmount: '0.00', total: '500.00' });
  });
  it('a zero tax rate gives zero tax in every mode', () => {
    expect(calculatePrice({ ...base, taxRatePercent: 0, taxMode: 'ALL_COMPONENTS' })).toMatchObject({ taxAmount: '0.00', total: '500.00', taxRatePercent: '0.00' });
  });

  it('a corporate contract price replaces only the service fee', () => {
    const p = calculatePrice({ ...base, corporateServiceFee: '80.00', taxMode: 'SERVICE_FEE_ONLY' });
    expect(p).toMatchObject({
      serviceFee: '80.00', listServiceFee: '100.00', serviceFeeSource: 'CORPORATE_CONTRACT',
      governmentFeeEstimate: '350.00', thirdPartyFeeEstimate: '50.00', taxAmount: '4.00', subtotal: '480.00', total: '484.00',
    });
  });
  it('a contract price of zero is honoured (free service fee), unlike "no contract"', () => {
    expect(calculatePrice({ ...base, corporateServiceFee: '0', taxMode: 'SERVICE_FEE_ONLY' })).toMatchObject({ serviceFee: '0.00', serviceFeeSource: 'CORPORATE_CONTRACT', taxAmount: '0.00', total: '400.00' });
    expect(calculatePrice({ ...base, corporateServiceFee: null, taxMode: 'SERVICE_FEE_ONLY' })).toMatchObject({ serviceFee: '100.00', serviceFeeSource: 'CATALOGUE' });
  });

  it('rounds tax half-up to fils, per component', () => {
    // 5% of 0.10 = 0.005 -> 0.01 ; 5% of 0.30 = 0.015 -> 0.02
    expect(taxOn('0.10', 5)).toBe('0.01');
    expect(taxOn('0.30', 5)).toBe('0.02');
    expect(taxOn('0.09', 5)).toBe('0.00');
    const p = calculatePrice({ serviceFee: '0.10', governmentFeeEstimate: '0.10', thirdPartyFeeEstimate: '0.10', taxRatePercent: 5, taxMode: 'ALL_COMPONENTS' });
    // Per component: 0.01 * 3 = 0.03 (tax on the 0.30 sum would be 0.02): lines must add up to the total.
    expect(p.taxAmount).toBe('0.03');
    expect(p.total).toBe('0.33');
    expect(p.components.map((c) => c.total)).toEqual(['0.11', '0.11', '0.11']);
  });
  it('is exact where binary floating point is not', () => {
    // 0.1 + 0.2 !== 0.3 in floats; 1.15 * 100 !== 115 in floats.
    expect(calculatePrice({ serviceFee: '0.10', governmentFeeEstimate: '0.20', taxRatePercent: 0, taxMode: 'NONE' }).total).toBe('0.30');
    expect(calculatePrice({ serviceFee: '1.15', taxRatePercent: '100', taxMode: 'SERVICE_FEE_ONLY' })).toMatchObject({ taxAmount: '1.15', total: '2.30' });
    expect(calculatePrice({ serviceFee: '99999999999.99', taxRatePercent: '5', taxMode: 'SERVICE_FEE_ONLY' })).toMatchObject({ taxAmount: '5000000000.00', total: '104999999999.99' });
  });
  it('supports fractional tax rates', () => {
    expect(calculatePrice({ serviceFee: '199.99', taxRatePercent: '7.25', taxMode: 'SERVICE_FEE_ONLY' })).toMatchObject({ taxAmount: '14.50', total: '214.49', taxRatePercent: '7.25' });
  });
  it('treats missing estimates as zero', () => {
    expect(calculatePrice({ serviceFee: 60, taxRatePercent: 5, taxMode: 'SERVICE_FEE_ONLY' })).toMatchObject({ governmentFeeEstimate: '0.00', thirdPartyFeeEstimate: '0.00', total: '63.00' });
  });

  describe('payment policy', () => {
    const input = { serviceFee: '200', governmentFeeEstimate: '150', thirdPartyFeeEstimate: '250', taxRatePercent: 5, taxMode: 'SERVICE_FEE_ONLY' } as const;
    it('BEFORE_PROCESSING (default): everything is due up front', () => {
      expect(calculatePrice(input)).toMatchObject({ total: '610.00', paymentPolicy: 'BEFORE_PROCESSING', dueBeforeProcessing: '610.00', depositPercent: null });
    });
    it('AFTER_COMPLETION: nothing is due up front', () => {
      expect(calculatePrice({ ...input, paymentPolicy: 'AFTER_COMPLETION' })).toMatchObject({ dueBeforeProcessing: '0.00', depositPercent: null });
    });
    it('DEPOSIT: the percentage of the total, rounded half-up', () => {
      expect(calculatePrice({ ...input, paymentPolicy: 'DEPOSIT', depositPercent: '50' })).toMatchObject({ dueBeforeProcessing: '305.00', depositPercent: '50.00' });
      expect(calculatePrice({ serviceFee: '0.03', taxRatePercent: 0, taxMode: 'NONE', paymentPolicy: 'DEPOSIT', depositPercent: 50 }).dueBeforeProcessing).toBe('0.02');
      expect(calculatePrice({ ...input, paymentPolicy: 'DEPOSIT', depositPercent: '33.33' }).dueBeforeProcessing).toBe('203.31');
    });
    it('DEPOSIT without a valid percentage is an error, not a silent zero', () => {
      expect(() => calculatePrice({ ...input, paymentPolicy: 'DEPOSIT' })).toThrow(RangeError);
      expect(() => calculatePrice({ ...input, paymentPolicy: 'DEPOSIT', depositPercent: 0 })).toThrow(RangeError);
      expect(() => calculatePrice({ ...input, paymentPolicy: 'DEPOSIT', depositPercent: 101 })).toThrow(RangeError);
    });
  });

  it('rejects negative amounts and impossible tax rates', () => {
    expect(() => calculatePrice({ serviceFee: '-1', taxRatePercent: 5, taxMode: 'NONE' })).toThrow(RangeError);
    expect(() => calculatePrice({ serviceFee: '1', governmentFeeEstimate: '-0.01', taxRatePercent: 5, taxMode: 'NONE' })).toThrow(RangeError);
    expect(() => calculatePrice({ serviceFee: '1', corporateServiceFee: '-5', taxRatePercent: 5, taxMode: 'NONE' })).toThrow(RangeError);
    expect(() => calculatePrice({ serviceFee: '1', taxRatePercent: 101, taxMode: 'NONE' })).toThrow(RangeError);
    expect(() => calculatePrice({ serviceFee: '1', taxRatePercent: -1, taxMode: 'NONE' })).toThrow(RangeError);
    expect(() => calculatePrice({ serviceFee: '1', taxRatePercent: 5, taxMode: 'EVERYTHING' as any })).toThrow(RangeError);
  });
  it('the total always equals the sum of the component totals', () => {
    for (const taxMode of ['SERVICE_FEE_ONLY', 'ALL_COMPONENTS', 'NONE'] as const) {
      for (const [a, b, c, r] of [['33.33', '66.67', '0.01', '5'], ['12.345', '0.005', '7.775', '7.5'], ['1', '2', '3', '12.5']]) {
        const p = calculatePrice({ serviceFee: a, governmentFeeEstimate: b, thirdPartyFeeEstimate: c, taxRatePercent: r, taxMode });
        const cents = (v: string) => Math.round(Number(v) * 100);
        expect(p.components.reduce((n, x) => n + cents(x.total), 0)).toBe(cents(p.total));
        expect(cents(p.subtotal) + cents(p.taxAmount)).toBe(cents(p.total));
      }
    }
  });
});
