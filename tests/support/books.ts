import { aed, Fils, fils, percent, ratio, sum } from './money';

/**
 * The test's own set of books.
 *
 * Scenario 30 ("reports match underlying financial records") needs expected
 * figures that do not come from the code under test. This is a small, separate
 * model of a centre's finances: the test records every invoice, payment, refund,
 * credit note and expense it creates through the API in here, and the model
 * computes what each report must show from the DOCUMENTED rules
 * (docs/api/modules/finance.md "Money rules", docs/api/modules/reports.md "The
 * financial basis"), in integer fils. It shares no code with the API.
 */
export type Component = 'SERVICE_FEE' | 'GOVERNMENT_FEE' | 'THIRD_PARTY_FEE';
export const COMPONENTS: Component[] = ['SERVICE_FEE', 'GOVERNMENT_FEE', 'THIRD_PARTY_FEE'];

export interface BookLine {
  component: Component;
  unitAmount: string;
  quantity?: number;
  discountAmount?: string;
  /** Percent; pass-through lines are untaxed in these books (tax mode SERVICE_FEE_ONLY). */
  taxRatePercent?: number;
}
interface ComputedLine {
  component: Component;
  net: Fils;
  tax: Fils;
  total: Fils;
}
export interface BookInvoice {
  key: string;
  id: string;
  /** Calendar day in the centre's time zone on which it was issued. */
  day: string;
  branchId: string;
  customerId: string;
  corporateAccountId: string | null;
  /** The service its lines (or its request) belong to; null = not linked to a service. */
  serviceId: string | null;
  lines: ComputedLine[];
  voided: boolean;
}
export interface BookPayment {
  key: string;
  id: string;
  invoiceKey: string;
  amount: Fils;
  method: string;
  branchId: string;
  day: string;
}
export interface BookRefund {
  key: string;
  invoiceKey: string;
  paymentKey: string;
  amount: Fils;
  parts: Record<Component, Fils>;
  cancelCharge: boolean;
  day: string;
}
export interface BookCredit {
  invoiceKey: string;
  /** Amounts per component, tax included (that is how a credit note stores them). */
  parts: Record<Component, Fils>;
  day: string;
}
export interface BookExpense {
  amount: Fils;
  category: string;
  /** Service of the request the expense is linked to; null = an overhead. */
  serviceId: string | null;
  day: string;
}

export interface RevenueCells {
  invoices: number;
  serviceFeeInvoiced: Fils;
  serviceFeeCredited: Fils;
  serviceFeeRevenue: Fils;
  passThroughInvoiced: Fils;
  tax: Fils;
  totalInvoiced: Fils;
}
export interface CashCells {
  payments: Fils;
  refunds: Fils;
  grossCollections: Fils;
}

const zeroParts = (): Record<Component, Fils> => ({ SERVICE_FEE: 0n, GOVERNMENT_FEE: 0n, THIRD_PARTY_FEE: 0n });

export class Books {
  readonly invoices: BookInvoice[] = [];
  readonly payments: BookPayment[] = [];
  readonly refunds: BookRefund[] = [];
  readonly credits: BookCredit[] = [];
  readonly expenses: BookExpense[] = [];

  // ------------------------------------------------------------------ recording
  /** finance.md: gross = quantity x unit; net = gross - discount; tax = round2(net x rate / 100) half-up, per line. */
  static line(l: BookLine): ComputedLine {
    const gross = fils(l.unitAmount) * BigInt(l.quantity ?? 1);
    const net = gross - fils(l.discountAmount ?? '0');
    const tax = percent(net, l.taxRatePercent ?? 0);
    return { component: l.component, net, tax, total: net + tax };
  }
  invoice(i: Omit<BookInvoice, 'lines' | 'voided'> & { lines: BookLine[] }): BookInvoice {
    const row: BookInvoice = { ...i, lines: i.lines.map(Books.line), voided: false };
    this.invoices.push(row);
    return row;
  }
  void(key: string): void {
    this.find(key).voided = true;
  }
  payment(p: Omit<BookPayment, 'amount'> & { amount: string }): BookPayment {
    const row = { ...p, amount: fils(p.amount) };
    this.payments.push(row);
    return row;
  }
  /** A refund with an explicit split. With `cancelCharge` the API issues a credit note with the same split (finance.md, "Refunds"). */
  refund(r: { key: string; invoiceKey: string; paymentKey: string; amount: string; governmentFee?: string; thirdParty?: string; cancelCharge: boolean; day: string }): BookRefund {
    const amount = fils(r.amount);
    const parts = { ...zeroParts(), GOVERNMENT_FEE: fils(r.governmentFee ?? '0'), THIRD_PARTY_FEE: fils(r.thirdParty ?? '0') };
    parts.SERVICE_FEE = amount - parts.GOVERNMENT_FEE - parts.THIRD_PARTY_FEE; // tax travels with the service-fee part
    const row: BookRefund = { key: r.key, invoiceKey: r.invoiceKey, paymentKey: r.paymentKey, amount, parts, cancelCharge: r.cancelCharge, day: r.day };
    this.refunds.push(row);
    if (r.cancelCharge) this.credits.push({ invoiceKey: r.invoiceKey, parts: { ...parts }, day: r.day });
    return row;
  }
  credit(c: { invoiceKey: string; day: string; parts: Partial<Record<Component, string>> }): BookCredit {
    const row: BookCredit = { invoiceKey: c.invoiceKey, day: c.day, parts: { ...zeroParts(), ...Object.fromEntries(Object.entries(c.parts).map(([k, v]) => [k, fils(v!)])) } as Record<Component, Fils> };
    this.credits.push(row);
    return row;
  }
  expense(e: { amount: string; category: string; serviceId?: string | null; day: string }): void {
    this.expenses.push({ amount: fils(e.amount), category: e.category, serviceId: e.serviceId ?? null, day: e.day });
  }

  // ------------------------------------------------------------------ single documents
  find(key: string): BookInvoice {
    const row = this.invoices.find((i) => i.key === key);
    if (!row) throw new Error(`The books have no invoice "${key}".`);
    return row;
  }
  total(key: string): Fils {
    return sum(this.find(key).lines.map((l) => l.total));
  }
  taxOf(key: string): Fils {
    return sum(this.find(key).lines.map((l) => l.tax));
  }
  private componentOf(inv: BookInvoice, c: Component) {
    const lines = inv.lines.filter((l) => l.component === c);
    return { net: sum(lines.map((l) => l.net)), gross: sum(lines.map((l) => l.total)), tax: sum(lines.map((l) => l.tax)) };
  }
  credited(key: string): Fils {
    return sum(this.credits.filter((c) => c.invoiceKey === key).flatMap((c) => COMPONENTS.map((k) => c.parts[k])));
  }
  paid(key: string): Fils {
    return sum(this.payments.filter((p) => p.invoiceKey === key).map((p) => p.amount));
  }
  refunded(key: string): Fils {
    return sum(this.refunds.filter((r) => r.invoiceKey === key).map((r) => r.amount));
  }
  /** finance.md: balanceDue = total - amountCredited - amountPaid + amountRefunded. */
  balance(key: string): Fils {
    return this.find(key).voided ? 0n : this.total(key) - this.credited(key) - this.paid(key) + this.refunded(key);
  }

  // ------------------------------------------------------------------ revenue (accrual)
  /**
   * reports.md, "The financial basis": lines of invoices issued in the period (void and draft never count),
   * net of discounts, tax apart; credit notes issued in the period are taken off, their tax share removed in
   * the proportion of the invoice's own lines of that component: round2(part x net / gross).
   */
  revenue(days: string[], groupBy: (i: BookInvoice) => string | null = () => 'all'): Map<string | null, RevenueCells> {
    const out = new Map<string | null, RevenueCells & { seen: Set<string> }>();
    const cell = (key: string | null) => {
      if (!out.has(key)) out.set(key, { invoices: 0, serviceFeeInvoiced: 0n, serviceFeeCredited: 0n, serviceFeeRevenue: 0n, passThroughInvoiced: 0n, tax: 0n, totalInvoiced: 0n, seen: new Set() });
      return out.get(key)!;
    };
    for (const inv of this.invoices.filter((i) => !i.voided && days.includes(i.day))) {
      const c = cell(groupBy(inv));
      c.seen.add(inv.key);
      for (const l of inv.lines) {
        if (l.component === 'SERVICE_FEE') c.serviceFeeInvoiced += l.net;
        else c.passThroughInvoiced += l.net;
        c.tax += l.tax;
        c.totalInvoiced += l.total;
      }
    }
    for (const credit of this.credits.filter((x) => days.includes(x.day))) {
      const inv = this.find(credit.invoiceKey);
      const c = cell(groupBy(inv));
      for (const k of COMPONENTS) {
        const part = credit.parts[k];
        if (part === 0n) continue;
        const { net, gross } = this.componentOf(inv, k);
        const netShare = gross > 0n ? ratio(part, net, gross) : part;
        if (k === 'SERVICE_FEE') c.serviceFeeCredited += netShare;
        else c.passThroughInvoiced -= netShare;
        c.tax -= part - netShare;
        c.totalInvoiced -= part;
      }
    }
    const result = new Map<string | null, RevenueCells>();
    for (const [key, c] of out) result.set(key, { ...c, invoices: c.seen.size, serviceFeeRevenue: c.serviceFeeInvoiced - c.serviceFeeCredited });
    return result;
  }
  revenueTotal(days: string[]): RevenueCells {
    return this.revenue(days).get('all') ?? { invoices: 0, serviceFeeInvoiced: 0n, serviceFeeCredited: 0n, serviceFeeRevenue: 0n, passThroughInvoiced: 0n, tax: 0n, totalInvoiced: 0n };
  }

  // ------------------------------------------------------------------ cash
  /** reports.md: gross collections = payments completed in the period - refunds completed in the period. A refund counts in the branch of its payment. */
  cash(days: string[], branchId?: string): CashCells {
    const payments = sum(this.payments.filter((p) => days.includes(p.day) && (!branchId || p.branchId === branchId)).map((p) => p.amount));
    const refunds = sum(this.refunds.filter((r) => days.includes(r.day) && (!branchId || this.payments.find((p) => p.key === r.paymentKey)!.branchId === branchId)).map((r) => r.amount));
    return { payments, refunds, grossCollections: payments - refunds };
  }

  // ------------------------------------------------------------------ receivables
  open(filter: (i: BookInvoice) => boolean = () => true): BookInvoice[] {
    return this.invoices.filter((i) => !i.voided && filter(i) && this.balance(i.key) > 0n);
  }
  outstanding(filter: (i: BookInvoice) => boolean = () => true): Fils {
    return sum(this.open(filter).map((i) => this.balance(i.key)));
  }

  // ------------------------------------------------------------------ pass-through liabilities
  /**
   * finance.md, "Pass-through liabilities": on a payment the accrued liability of the invoice is brought up to
   * round2(netPaid x componentTotal / invoiceTotal); a refund reverses its explicit split; a remittance expense
   * pays it out. This model covers what the scenario uses - invoices with ONE payment that came before any
   * credit note - and refuses anything else rather than guess.
   */
  liabilities(): Record<'GOVERNMENT_FEE' | 'THIRD_PARTY_FEE', { accrued: Fils; reversed: Fils; remitted: Fils; outstanding: Fils }> {
    const out = { GOVERNMENT_FEE: { accrued: 0n, reversed: 0n, remitted: 0n, outstanding: 0n }, THIRD_PARTY_FEE: { accrued: 0n, reversed: 0n, remitted: 0n, outstanding: 0n } };
    for (const inv of this.invoices.filter((i) => !i.voided)) {
      const payments = this.payments.filter((p) => p.invoiceKey === inv.key);
      if (payments.length > 1) throw new Error(`The liability model handles one payment per invoice; ${inv.key} has ${payments.length}.`);
      for (const p of payments) {
        for (const k of ['GOVERNMENT_FEE', 'THIRD_PARTY_FEE'] as const) out[k].accrued += ratio(p.amount, this.componentOf(inv, k).gross, this.total(inv.key));
      }
    }
    for (const r of this.refunds) for (const k of ['GOVERNMENT_FEE', 'THIRD_PARTY_FEE'] as const) out[k].reversed += r.parts[k];
    for (const e of this.expenses) {
      if (e.category === 'GOVERNMENT_FEE_REMITTANCE') out.GOVERNMENT_FEE.remitted += e.amount;
      if (e.category === 'THIRD_PARTY_PAYMENT') out.THIRD_PARTY_FEE.remitted += e.amount;
    }
    for (const k of ['GOVERNMENT_FEE', 'THIRD_PARTY_FEE'] as const) out[k].outstanding = out[k].accrued - out[k].reversed - out[k].remitted;
    return out;
  }

  // ------------------------------------------------------------------ expenses
  /** reports.md, "Service profitability": expenses linked to requests of the service; remittances of pass-through fees are not a cost. */
  directExpenses(days: string[], serviceId: string): Fils {
    return sum(this.expenses.filter((e) => days.includes(e.day) && e.serviceId === serviceId && !['GOVERNMENT_FEE_REMITTANCE', 'THIRD_PARTY_PAYMENT'].includes(e.category)).map((e) => e.amount));
  }
  remittances(days: string[], serviceId: string): Fils {
    return sum(this.expenses.filter((e) => days.includes(e.day) && e.serviceId === serviceId && ['GOVERNMENT_FEE_REMITTANCE', 'THIRD_PARTY_PAYMENT'].includes(e.category)).map((e) => e.amount));
  }
}

/** The money cells of a revenue row, printed like the API prints them. */
export function printRevenue(c: RevenueCells) {
  return {
    invoices: c.invoices,
    serviceFeeRevenue: aed(c.serviceFeeRevenue),
    otherRevenue: '0.00', // these books keep the default treatment: government and third-party fees are pass-through
    passThroughInvoiced: aed(c.passThroughInvoiced),
    tax: aed(c.tax),
    totalInvoiced: aed(c.totalInvoiced),
  };
}
export function printCash(c: CashCells) {
  return { payments: aed(c.payments), refunds: aed(c.refunds), grossCollections: aed(c.grossCollections) };
}
/** Percentage with one decimal, half-up - or null when there is nothing to divide by (reports.md). */
export function onePercent(part: Fils, whole: Fils): number | null {
  if (whole === 0n) return null;
  const negative = part < 0n !== whole < 0n;
  const abs = (x: Fils) => (x < 0n ? -x : x);
  const tenths = (abs(part) * 1000n * 2n + abs(whole)) / (abs(whole) * 2n);
  return (negative ? -1 : 1) * (Number(tenths) / 10);
}
