import { D, sum } from '../../common/pagination';
import {
  accrualForPayment, ageingBucket, calculateDocument, calculateLine, CalculationError, componentTotals, defaultTaxRate, invoiceState,
  daysOverdue, invoiceDueAt, isInvoiceOverdue, overdueInvoiceWhere, passThroughTargets, splitProportionally, splitRefund, totalsFromStoredLines, zeroComponents,
} from './finance.calc';

const s = (v: { toFixed(n: number): string }) => v.toFixed(2);

describe('finance calculation (pure)', () => {
  describe('lines', () => {
    it('computes net, tax (half-up, per line) and line total', () => {
      const l = calculateLine({ description: 'Typing', component: 'SERVICE_FEE', quantity: '3', unitAmount: '33.35', discountAmount: '0.05', taxRatePercent: '5' });
      expect(s(l.gross)).toBe('100.05');
      expect(s(l.lineNet)).toBe('100.00');
      expect(s(l.taxAmount)).toBe('5.00');
      expect(s(l.lineTotal)).toBe('105.00');
    });

    it('rounds tax half-up to fils', () => {
      // 10.10 * 5% = 0.505 -> 0.51 (half-up), 10.09 * 5% = 0.5045 -> 0.50
      expect(s(calculateLine({ description: 'a', component: 'SERVICE_FEE', unitAmount: '10.10', taxRatePercent: 5 }).taxAmount)).toBe('0.51');
      expect(s(calculateLine({ description: 'a', component: 'SERVICE_FEE', unitAmount: '10.09', taxRatePercent: 5 }).taxAmount)).toBe('0.50');
      // 0.1 + 0.2 style float traps do not exist with decimals
      expect(s(calculateLine({ description: 'a', component: 'SERVICE_FEE', quantity: '3', unitAmount: '0.10' }).gross)).toBe('0.30');
    });

    it('rounds fractional quantities to fils before discount and tax', () => {
      const l = calculateLine({ description: 'Pages', component: 'SERVICE_FEE', quantity: '2.5', unitAmount: '3.33', taxRatePercent: 5 });
      expect(s(l.gross)).toBe('8.33'); // 8.325 -> 8.33
      expect(s(l.taxAmount)).toBe('0.42'); // 0.4165 -> 0.42
      expect(s(l.lineTotal)).toBe('8.75');
    });

    it('uses the fallback tax rate only when the line has none', () => {
      expect(s(calculateLine({ description: 'a', component: 'SERVICE_FEE', unitAmount: 100 }, 0, 5).taxAmount)).toBe('5.00');
      expect(s(calculateLine({ description: 'a', component: 'SERVICE_FEE', unitAmount: 100, taxRatePercent: 0 }, 0, 5).taxAmount)).toBe('0.00');
    });

    it('rejects invalid lines with the line number', () => {
      const bad = (fn: () => unknown, code: string) => {
        try {
          fn();
          throw new Error('expected a CalculationError');
        } catch (e) {
          expect(e).toBeInstanceOf(CalculationError);
          expect((e as CalculationError).code).toBe(code);
        }
      };
      bad(() => calculateLine({ description: 'a', component: 'SERVICE_FEE', unitAmount: 10, discountAmount: '10.01' }), 'DISCOUNT_EXCEEDS_LINE');
      bad(() => calculateLine({ description: 'a', component: 'SERVICE_FEE', unitAmount: 10, quantity: 0 }), 'INVALID_QUANTITY');
      bad(() => calculateLine({ description: 'a', component: 'SERVICE_FEE', unitAmount: 10, quantity: '1.005' }), 'INVALID_QUANTITY');
      bad(() => calculateLine({ description: 'a', component: 'SERVICE_FEE', unitAmount: -1 }), 'INVALID_AMOUNT');
      bad(() => calculateLine({ description: 'a', component: 'SERVICE_FEE', unitAmount: '1.999' }), 'INVALID_AMOUNT');
      bad(() => calculateLine({ description: 'a', component: 'SERVICE_FEE', unitAmount: 1, taxRatePercent: 101 }), 'INVALID_TAX_RATE');
      bad(() => calculateDocument([]), 'NO_LINES');
    });
  });

  describe('default tax rate from the service tax mode', () => {
    it('SERVICE_FEE_ONLY taxes only the service fee', () => {
      expect(defaultTaxRate('SERVICE_FEE_ONLY', 'SERVICE_FEE', 5).toNumber()).toBe(5);
      expect(defaultTaxRate('SERVICE_FEE_ONLY', 'GOVERNMENT_FEE', 5).toNumber()).toBe(0);
      expect(defaultTaxRate('SERVICE_FEE_ONLY', 'THIRD_PARTY_FEE', 5).toNumber()).toBe(0);
      expect(defaultTaxRate(undefined, 'GOVERNMENT_FEE', 5).toNumber()).toBe(0);
    });
    it('ALL_COMPONENTS taxes every line, NONE taxes nothing', () => {
      expect(defaultTaxRate('ALL_COMPONENTS', 'GOVERNMENT_FEE', '5.00').toNumber()).toBe(5);
      expect(defaultTaxRate('NONE', 'SERVICE_FEE', 5).toNumber()).toBe(0);
    });
  });

  describe('document totals', () => {
    const doc = calculateDocument(
      [
        { description: 'Service fee', component: 'SERVICE_FEE', quantity: 1, unitAmount: '150.00', discountAmount: '20.00' },
        { description: 'Government fee', component: 'GOVERNMENT_FEE', quantity: 2, unitAmount: '250.25' },
        { description: 'Courier', component: 'THIRD_PARTY_FEE', quantity: 1, unitAmount: '35.00' },
        { description: 'Urgent handling', component: 'SERVICE_FEE', quantity: 1, unitAmount: '49.99' },
      ],
      (l) => defaultTaxRate('SERVICE_FEE_ONLY', l.component, 5),
    );

    it('keeps the three components apart, gross of discount', () => {
      expect(s(doc.subtotalServiceFee)).toBe('199.99');
      expect(s(doc.subtotalGovernmentFee)).toBe('500.50');
      expect(s(doc.subtotalThirdParty)).toBe('35.00');
      expect(s(doc.discountTotal)).toBe('20.00');
      // tax: (150-20)*5% = 6.50 ; 49.99*5% = 2.4995 -> 2.50
      expect(s(doc.taxTotal)).toBe('9.00');
      expect(doc.hasDiscount).toBe(true);
    });

    it('satisfies the database formula exactly', () => {
      expect(s(doc.total)).toBe('724.49');
      expect(doc.total.equals(doc.subtotalServiceFee.plus(doc.subtotalGovernmentFee).plus(doc.subtotalThirdParty).minus(doc.discountTotal).plus(doc.taxTotal))).toBe(true);
      expect(doc.total.equals(sum(doc.lines.map((l) => l.lineTotal)))).toBe(true);
      const again = totalsFromStoredLines(doc.lines);
      expect(s(again.total)).toBe('724.49');
      expect(s(again.subtotalGovernmentFee)).toBe('500.50');
    });

    it('government and third-party lines are not taxed by default', () => {
      expect(doc.lines[1].taxAmount.isZero()).toBe(true);
      expect(doc.lines[2].taxAmount.isZero()).toBe(true);
      const ct = componentTotals(doc.lines);
      expect(s(ct.SERVICE_FEE)).toBe('188.99');
      expect(s(ct.GOVERNMENT_FEE)).toBe('500.50');
      expect(s(ct.THIRD_PARTY_FEE)).toBe('35.00');
      expect(ct.SERVICE_FEE.plus(ct.GOVERNMENT_FEE).plus(ct.THIRD_PARTY_FEE).equals(doc.total)).toBe(true);
    });

    it('holds for many random documents', () => {
      let seed = 42;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
      for (let i = 0; i < 300; i++) {
        const n = 1 + Math.floor(rnd() * 6);
        const lines = Array.from({ length: n }, () => {
          const unit = (Math.floor(rnd() * 100000) / 100).toFixed(2);
          const qty = (1 + Math.floor(rnd() * 500) / 100).toFixed(2);
          const gross = D(unit).mul(D(qty)).toDecimalPlaces(2, 4);
          const discount = rnd() < 0.3 ? gross.mul(Math.floor(rnd() * 100)).div(100).toDecimalPlaces(2, 1).toFixed(2) : '0';
          return {
            description: 'x',
            component: (['SERVICE_FEE', 'GOVERNMENT_FEE', 'THIRD_PARTY_FEE'] as const)[Math.floor(rnd() * 3)],
            quantity: qty,
            unitAmount: unit,
            discountAmount: discount,
            taxRatePercent: [0, 5, 5, 12.5][Math.floor(rnd() * 4)],
          };
        });
        const d = calculateDocument(lines);
        expect(d.total.equals(d.subtotalServiceFee.plus(d.subtotalGovernmentFee).plus(d.subtotalThirdParty).minus(d.discountTotal).plus(d.taxTotal))).toBe(true);
        expect(d.total.decimalPlaces()).toBeLessThanOrEqual(2);
        expect(d.total.gte(0)).toBe(true);
        for (const l of d.lines) expect(l.lineTotal.gte(0)).toBe(true);
      }
    });
  });

  describe('pass-through share of collected money', () => {
    const effective = { SERVICE_FEE: D('105.00'), GOVERNMENT_FEE: D('200.00'), THIRD_PARTY_FEE: D('35.00') }; // total 340.00

    it('spreads a partial payment proportionally, remainder on the service fee', () => {
      const t = passThroughTargets('100.00', effective);
      expect(s(t.GOVERNMENT_FEE)).toBe('58.82'); // 58.8235
      expect(s(t.THIRD_PARTY_FEE)).toBe('10.29'); // 10.2941
      expect(s(t.SERVICE_FEE)).toBe('30.89'); // remainder, not 30.88
      expect(t.GOVERNMENT_FEE.plus(t.THIRD_PARTY_FEE).plus(t.SERVICE_FEE).toFixed(2)).toBe('100.00');
    });

    it('accrues exactly the component totals once fully paid, whatever the instalments', () => {
      const instalments = ['33.33', '33.33', '33.33', '0.01', '100.00', '140.00'];
      let paid = D(0);
      const accrued = { GOVERNMENT_FEE: D(0), THIRD_PARTY_FEE: D(0) };
      for (const i of instalments) {
        paid = paid.plus(i);
        const delta = accrualForPayment(paid, effective, accrued);
        expect(delta.GOVERNMENT_FEE.gte(0)).toBe(true);
        expect(delta.THIRD_PARTY_FEE.gte(0)).toBe(true);
        accrued.GOVERNMENT_FEE = accrued.GOVERNMENT_FEE.plus(delta.GOVERNMENT_FEE);
        accrued.THIRD_PARTY_FEE = accrued.THIRD_PARTY_FEE.plus(delta.THIRD_PARTY_FEE);
        expect(accrued.GOVERNMENT_FEE.plus(accrued.THIRD_PARTY_FEE).lte(paid)).toBe(true);
      }
      expect(s(paid)).toBe('340.00');
      expect(s(accrued.GOVERNMENT_FEE)).toBe('200.00');
      expect(s(accrued.THIRD_PARTY_FEE)).toBe('35.00');
    });

    it('never lets the pass-through shares exceed the money collected (one-fil payments)', () => {
      const passOnly = { SERVICE_FEE: D(0), GOVERNMENT_FEE: D('0.50'), THIRD_PARTY_FEE: D('0.50') };
      for (let fils = 1; fils <= 100; fils++) {
        const paid = D(fils).div(100);
        const t = passThroughTargets(paid, passOnly);
        expect(t.SERVICE_FEE.gte(0)).toBe(true);
        expect(t.GOVERNMENT_FEE.plus(t.THIRD_PARTY_FEE).plus(t.SERVICE_FEE).equals(paid)).toBe(true);
      }
      const full = passThroughTargets('1.00', passOnly);
      expect(s(full.GOVERNMENT_FEE)).toBe('0.50');
      expect(s(full.THIRD_PARTY_FEE)).toBe('0.50');
    });

    it('is zero when nothing is paid or the invoice has no value', () => {
      expect(s(passThroughTargets(0, effective).GOVERNMENT_FEE)).toBe('0.00');
      expect(s(passThroughTargets(50, zeroComponents()).GOVERNMENT_FEE)).toBe('0.00');
    });

    it('caps at the component totals when more than the invoice is collected', () => {
      const t = passThroughTargets('500.00', effective);
      expect(s(t.GOVERNMENT_FEE)).toBe('200.00');
      expect(s(t.THIRD_PARTY_FEE)).toBe('35.00');
    });
  });

  describe('refund split', () => {
    const effective = { SERVICE_FEE: D('100.00'), GOVERNMENT_FEE: D('200.00'), THIRD_PARTY_FEE: D(0) };
    it('reverses the proportional pass-through share and leaves the remainder on the service fee', () => {
      const split = splitRefund('150.00', '300.00', effective, { GOVERNMENT_FEE: D('200.00'), THIRD_PARTY_FEE: D(0) });
      expect(s(split.GOVERNMENT_FEE)).toBe('100.00');
      expect(s(split.THIRD_PARTY_FEE)).toBe('0.00');
      expect(s(split.SERVICE_FEE)).toBe('50.00');
    });
    it('a full refund reverses everything that was accrued', () => {
      const split = splitRefund('300.00', '300.00', effective, { GOVERNMENT_FEE: D('200.00'), THIRD_PARTY_FEE: D(0) });
      expect(s(split.GOVERNMENT_FEE)).toBe('200.00');
      expect(s(split.SERVICE_FEE)).toBe('100.00');
    });
    it('never reverses more than was accrued', () => {
      const split = splitRefund('300.00', '300.00', effective, { GOVERNMENT_FEE: D('120.00'), THIRD_PARTY_FEE: D(0) });
      expect(s(split.GOVERNMENT_FEE)).toBe('120.00');
      expect(s(split.SERVICE_FEE)).toBe('180.00');
    });
    it('parts always add up to the refund', () => {
      const eff = { SERVICE_FEE: D('33.33'), GOVERNMENT_FEE: D('33.33'), THIRD_PARTY_FEE: D('33.34') };
      const split = splitRefund('0.01', '100.00', eff, { GOVERNMENT_FEE: D('33.33'), THIRD_PARTY_FEE: D('33.34') });
      expect(split.GOVERNMENT_FEE.plus(split.THIRD_PARTY_FEE).plus(split.SERVICE_FEE).toFixed(2)).toBe('0.01');
    });
  });

  describe('proportional split (credit notes)', () => {
    it('keeps the remainder on the service fee and adds up', () => {
      const split = splitProportionally('100.00', { SERVICE_FEE: D('100'), GOVERNMENT_FEE: D('100'), THIRD_PARTY_FEE: D('100') });
      expect(s(split.GOVERNMENT_FEE)).toBe('33.33');
      expect(s(split.THIRD_PARTY_FEE)).toBe('33.33');
      expect(s(split.SERVICE_FEE)).toBe('33.34');
    });
    it('falls back to service fee when there are no weights', () => {
      expect(s(splitProportionally('10', zeroComponents()).SERVICE_FEE)).toBe('10.00');
    });
  });

  describe('invoice state from amounts', () => {
    const st = (total: string, paid: string, credited = '0', refunded = '0') => {
      const r = invoiceState({ total, amountPaid: paid, amountCredited: credited, amountRefunded: refunded });
      return `${r.status}:${r.balanceDue.toFixed(2)}`;
    };
    it('derives ISSUED / PARTIALLY_PAID / PAID / CREDITED', () => {
      expect(st('100', '0')).toBe('ISSUED:100.00');
      expect(st('100', '40')).toBe('PARTIALLY_PAID:60.00');
      expect(st('100', '100')).toBe('PAID:0.00');
      expect(st('100', '0', '100')).toBe('CREDITED:0.00');
      expect(st('100', '60', '40')).toBe('PAID:0.00');
      expect(st('100', '0', '30')).toBe('ISSUED:70.00');
      expect(st('0', '0')).toBe('PAID:0.00');
    });
    it('a refund without cancelling the charge re-opens the balance', () => {
      expect(st('100', '100', '0', '100')).toBe('ISSUED:100.00');
      expect(st('100', '100', '0', '30')).toBe('PARTIALLY_PAID:30.00');
    });
    it('a refund with a matching credit note keeps the balance closed', () => {
      expect(st('100', '100', '30', '30')).toBe('PAID:0.00');
      expect(st('100', '100', '100', '100')).toBe('CREDITED:0.00');
    });
    it('refuses over-settlement and over-refund', () => {
      expect(() => invoiceState({ total: 100, amountPaid: 101, amountCredited: 0, amountRefunded: 0 })).toThrow(CalculationError);
      expect(() => invoiceState({ total: 100, amountPaid: 50, amountCredited: 0, amountRefunded: 51 })).toThrow(CalculationError);
      expect(() => invoiceState({ total: 100, amountPaid: 80, amountCredited: 30, amountRefunded: 0 })).toThrow(CalculationError);
    });
  });

  describe('ageing', () => {
    const now = new Date('2026-06-30T12:00:00Z');
    const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
    it('buckets by days past due', () => {
      expect(ageingBucket(null, now)).toBe('current');
      expect(ageingBucket(new Date(now.getTime() + 1000), now)).toBe('current');
      expect(ageingBucket(daysAgo(1), now)).toBe('days1to30');
      expect(ageingBucket(daysAgo(30), now)).toBe('days1to30');
      expect(ageingBucket(daysAgo(31), now)).toBe('days31to60');
      expect(ageingBucket(daysAgo(60), now)).toBe('days31to60');
      expect(ageingBucket(daysAgo(61), now)).toBe('days61to90');
      expect(ageingBucket(daysAgo(90), now)).toBe('days61to90');
      expect(ageingBucket(daysAgo(91), now)).toBe('days90plus');
    });
  });
  describe('due dates and overdue', () => {
    const iso = (d: Date) => d.toISOString();

    it('an invoice falls due at the end of the due day on the centre\'s calendar', () => {
      // 09 Oct 2026 10:00 in Dubai (UTC+4) = 06:00 UTC. Due on receipt: end of 9 October Dubai time.
      expect(iso(invoiceDueAt(new Date('2026-10-09T06:00:00.000Z'), 0, 'Asia/Dubai'))).toBe('2026-10-09T19:59:59.999Z');
      expect(iso(invoiceDueAt(new Date('2026-10-09T06:00:00.000Z'), 30, 'Asia/Dubai'))).toBe('2026-11-08T19:59:59.999Z');
      // 23:30 in Dubai is still the 9th there although it is the 9th 19:30 UTC; 00:30 Dubai is already the 10th.
      expect(iso(invoiceDueAt(new Date('2026-10-09T19:30:00.000Z'), 0, 'Asia/Dubai'))).toBe('2026-10-09T19:59:59.999Z');
      expect(iso(invoiceDueAt(new Date('2026-10-09T20:30:00.000Z'), 0, 'Asia/Dubai'))).toBe('2026-10-10T19:59:59.999Z');
      // Month and year ends.
      expect(iso(invoiceDueAt(new Date('2026-12-31T12:00:00.000Z'), 1, 'Asia/Dubai'))).toBe('2027-01-01T19:59:59.999Z');
      expect(iso(invoiceDueAt(new Date('2028-02-28T12:00:00.000Z'), 1, 'Asia/Dubai'))).toBe('2028-02-29T19:59:59.999Z');
    });

    it('follows the zone, daylight saving included, and falls back to Asia/Dubai for an unknown zone', () => {
      expect(iso(invoiceDueAt(new Date('2026-10-09T06:00:00.000Z'), 0, 'Asia/Tokyo'))).toBe('2026-10-09T14:59:59.999Z');
      expect(iso(invoiceDueAt(new Date('2026-10-09T06:00:00.000Z'), 0, 'UTC'))).toBe('2026-10-09T23:59:59.999Z');
      // New York: UTC-4 in summer, UTC-5 after the clocks go back on 1 November 2026.
      expect(iso(invoiceDueAt(new Date('2026-10-30T15:00:00.000Z'), 0, 'America/New_York'))).toBe('2026-10-31T03:59:59.999Z');
      expect(iso(invoiceDueAt(new Date('2026-10-30T15:00:00.000Z'), 3, 'America/New_York'))).toBe('2026-11-03T04:59:59.999Z');
      // London: UTC+1 until 25 October 2026, UTC+0 afterwards. Terms that cross the change still end at local midnight.
      expect(iso(invoiceDueAt(new Date('2026-10-24T10:00:00.000Z'), 1, 'Europe/London'))).toBe('2026-10-25T23:59:59.999Z');
      for (const zone of ['Mars/Olympus', '', null, undefined]) expect(iso(invoiceDueAt(new Date('2026-10-09T06:00:00.000Z'), 0, zone))).toBe('2026-10-09T19:59:59.999Z');
      // Nonsense terms count as "on receipt".
      for (const terms of [-5, Number.NaN]) expect(iso(invoiceDueAt(new Date('2026-10-09T06:00:00.000Z'), terms, 'Asia/Dubai'))).toBe('2026-10-09T19:59:59.999Z');
      expect(iso(invoiceDueAt(new Date('2026-10-09T06:00:00.000Z'), 2.9, 'Asia/Dubai'))).toBe('2026-10-11T19:59:59.999Z');
    });

    it('a new invoice is never overdue at the moment it is issued', () => {
      for (const zone of ['Asia/Dubai', 'Asia/Tokyo', 'America/New_York', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
        for (let hour = 0; hour < 24; hour++) {
          const issuedAt = new Date(Date.UTC(2026, 9, 9, hour, 59, 59, 999));
          const dueAt = invoiceDueAt(issuedAt, 0, zone);
          expect([zone, hour, dueAt.getTime() >= issuedAt.getTime(), dueAt.getTime() - issuedAt.getTime() < 86_400_000]).toEqual([zone, hour, true, true]);
          expect(isInvoiceOverdue({ status: 'ISSUED', dueAt, balanceDue: '10.00' }, issuedAt)).toBe(false);
        }
      }
    });

    it('overdue = money is still expected and the due moment has passed', () => {
      const dueAt = new Date('2026-10-09T19:59:59.999Z');
      const before = new Date('2026-10-09T19:59:59.999Z');
      const after = new Date('2026-10-09T20:00:00.000Z');
      expect(isInvoiceOverdue({ status: 'ISSUED', dueAt, balanceDue: '305.00' }, before)).toBe(false); // now == dueAt is not "past"
      expect(isInvoiceOverdue({ status: 'ISSUED', dueAt, balanceDue: '305.00' }, after)).toBe(true);
      expect(isInvoiceOverdue({ status: 'PARTIALLY_PAID', dueAt, balanceDue: D('0.01') }, after)).toBe(true);
      for (const status of ['DRAFT', 'PAID', 'CREDITED', 'VOID']) expect([status, isInvoiceOverdue({ status, dueAt, balanceDue: '305.00' }, after)]).toEqual([status, false]);
      expect(isInvoiceOverdue({ status: 'ISSUED', dueAt, balanceDue: '0.00' }, after)).toBe(false);
      expect(isInvoiceOverdue({ status: 'ISSUED', dueAt, balanceDue: D(0) }, after)).toBe(false);
      expect(isInvoiceOverdue({ status: 'ISSUED', dueAt: null, balanceDue: '305.00' }, after)).toBe(false);
      // When the balance is not part of what was loaded, status and date decide.
      expect(isInvoiceOverdue({ status: 'ISSUED', dueAt }, after)).toBe(true);
      // The database filter says the same thing.
      expect(overdueInvoiceWhere(after)).toEqual({ status: { in: ['ISSUED', 'PARTIALLY_PAID'] }, dueAt: { lt: after }, balanceDue: { gt: 0 } });
      // Days overdue and the ageing buckets use the same boundary.
      expect(daysOverdue(dueAt, before)).toBe(0);
      expect(daysOverdue(dueAt, after)).toBe(1);
      expect(daysOverdue(null, after)).toBe(0);
      expect(ageingBucket(dueAt, before)).toBe('current');
      expect(ageingBucket(dueAt, after)).toBe('days1to30');
    });
  });
});
