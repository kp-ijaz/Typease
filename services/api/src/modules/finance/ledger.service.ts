import { Injectable, OnModuleInit } from '@nestjs/common';
import type { LedgerAccountInput, ManualJournalInput, UpdateLedgerAccountInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { Prisma, TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { DomainEvent, DomainEvents } from '../../common/events.service';
import { D, sum } from '../../common/pagination';
import { SequenceService } from '../../common/sequence.service';
import { ProvisioningService } from '../tenancy/provisioning.service';
import { localYmd, safeTimeZone } from '../reports/time';
import { fmt } from './finance.calc';

type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
type Dec = Prisma.Decimal;

/** The accounts the automatic postings use. Centres may rename them and add their own; these keys stay. */
export const SYSTEM_ACCOUNTS: Array<{ key: string; code: string; name: string; nameAr: string; type: AccountType }> = [
  { key: 'CASH', code: '1000', name: 'Cash on hand', nameAr: 'النقد في الصندوق', type: 'ASSET' },
  { key: 'CARD_CLEARING', code: '1010', name: 'Card machine clearing', nameAr: 'تسوية أجهزة البطاقات', type: 'ASSET' },
  { key: 'BANK', code: '1020', name: 'Bank', nameAr: 'البنك', type: 'ASSET' },
  { key: 'CHEQUES', code: '1030', name: 'Cheques to deposit', nameAr: 'شيكات برسم الإيداع', type: 'ASSET' },
  { key: 'GATEWAY_CLEARING', code: '1040', name: 'Online payments clearing', nameAr: 'تسوية المدفوعات الإلكترونية', type: 'ASSET' },
  { key: 'AR', code: '1100', name: 'Accounts receivable', nameAr: 'الذمم المدينة', type: 'ASSET' },
  { key: 'GOV_PAYABLE', code: '2000', name: 'Government fees payable', nameAr: 'رسوم حكومية مستحقة الدفع', type: 'LIABILITY' },
  { key: 'THIRD_PARTY_PAYABLE', code: '2010', name: 'Third-party charges payable', nameAr: 'رسوم أطراف أخرى مستحقة الدفع', type: 'LIABILITY' },
  { key: 'VAT_PAYABLE', code: '2100', name: 'VAT payable', nameAr: 'ضريبة القيمة المضافة المستحقة', type: 'LIABILITY' },
  { key: 'CUSTOMER_ADVANCES', code: '2200', name: 'Customer advances', nameAr: 'دفعات مقدمة من العملاء', type: 'LIABILITY' },
  { key: 'COMMISSION_PAYABLE', code: '2300', name: 'Staff commission payable', nameAr: 'عمولات موظفين مستحقة', type: 'LIABILITY' },
  { key: 'OWNER_EQUITY', code: '3000', name: "Owner's equity", nameAr: 'حقوق الملكية', type: 'EQUITY' },
  { key: 'RETAINED_EARNINGS', code: '3100', name: 'Retained earnings', nameAr: 'الأرباح المحتجزة', type: 'EQUITY' },
  { key: 'SERVICE_REVENUE', code: '4000', name: 'Service fee revenue', nameAr: 'إيرادات رسوم الخدمة', type: 'REVENUE' },
  { key: 'GOV_REVENUE', code: '4100', name: 'Government fees (as revenue)', nameAr: 'رسوم حكومية (كإيراد)', type: 'REVENUE' },
  { key: 'THIRD_PARTY_REVENUE', code: '4110', name: 'Third-party charges (as revenue)', nameAr: 'رسوم أطراف أخرى (كإيراد)', type: 'REVENUE' },
  { key: 'EXP_RENT', code: '5000', name: 'Rent', nameAr: 'الإيجار', type: 'EXPENSE' },
  { key: 'EXP_SALARIES', code: '5010', name: 'Salaries', nameAr: 'الرواتب', type: 'EXPENSE' },
  { key: 'EXP_SUPPLIES', code: '5020', name: 'Supplies', nameAr: 'المستلزمات', type: 'EXPENSE' },
  { key: 'EXP_UTILITIES', code: '5030', name: 'Utilities', nameAr: 'المرافق', type: 'EXPENSE' },
  { key: 'EXP_COMMISSION', code: '5040', name: 'Staff commission', nameAr: 'عمولات الموظفين', type: 'EXPENSE' },
  { key: 'EXP_CASH_DIFF', code: '5050', name: 'Cash over / short', nameAr: 'فروقات الصندوق', type: 'EXPENSE' },
  { key: 'EXP_OTHER', code: '5900', name: 'Other expenses', nameAr: 'مصروفات أخرى', type: 'EXPENSE' },
];
const PAYMENT_ACCOUNT: Record<string, string> = { CASH: 'CASH', CARD_POS: 'CARD_CLEARING', BANK_TRANSFER: 'BANK', CHEQUE: 'CHEQUES', ONLINE_GATEWAY: 'GATEWAY_CLEARING' };
const EXPENSE_ACCOUNT: Record<string, string> = { RENT: 'EXP_RENT', SALARIES: 'EXP_SALARIES', SUPPLIES: 'EXP_SUPPLIES', UTILITIES: 'EXP_UTILITIES', OTHER: 'EXP_OTHER', GOVERNMENT_FEE_REMITTANCE: 'GOV_PAYABLE', THIRD_PARTY_PAYMENT: 'THIRD_PARTY_PAYABLE' };
/** Money paid out for an expense: cash from the drawer, everything else through the bank. */
const expensePaidFrom = (method: string | null) => (method === 'CASH' ? 'CASH' : 'BANK');
/** Event payloads are not trusted to carry well-formed ids: a malformed one must not abort the business transaction. */
const isId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
/** Debit-normal accounts grow with debits. */
const DEBIT_NORMAL: AccountType[] = ['ASSET', 'EXPENSE'];

export interface PostingLine {
  account: string;
  debit?: Dec | string | number;
  credit?: Dec | string | number;
  memo?: string;
  customerId?: string | null;
}

/**
 * Double-entry accounting (accrual basis).
 *
 *   invoice issued   Dr receivable           Cr service revenue, VAT payable, government / third-party fees payable
 *                                            (or revenue, when the centre treats those fees as revenue)
 *   payment          Dr cash / card / bank   Cr receivable (and customer advances for an unallocated part)
 *   refund paid      Dr receivable           Cr cash / bank (a credit note issued with it reverses the revenue)
 *   credit note      Dr revenue, VAT, fees   Cr receivable
 *   invoice voided   the issue posting reversed
 *   expense          Dr expense (or the fee payable for remittances)   Cr cash / bank
 *   commission       accrued Dr commission expense Cr commission payable; paid Dr payable Cr bank; voided reversed
 *   till difference  short Dr cash over/short Cr cash; over the opposite
 *
 * Postings run inside the business transaction (in-transaction listeners or direct calls), so a document and its
 * journal are committed together. Each automatic posting exists once (unique index on its source), which also
 * makes "build from history" safe to run again.
 */
@Injectable()
export class LedgerService implements OnModuleInit {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly sequences: SequenceService,
    private readonly provisioning: ProvisioningService,
  ) {}

  onModuleInit() {
    this.provisioning.registerTenantStep('ledger.accounts', (tx, tenant) => this.ensureAccounts(tx, tenant.id));
    this.provisioning.registerGlobalStep('ledger.accounts', async (tx) => {
      for (const t of await tx.tenant.findMany({ select: { id: true } })) await this.ensureAccounts(tx, t.id);
    });
    this.events.on('invoice.issued', (e, tx) => this.onInvoiceIssued(e, tx));
    this.events.on('invoice.voided', (e, tx) => this.onInvoiceVoided(e, tx));
    this.events.on('payment.completed', (e, tx) => this.onPayment(e, tx));
    this.events.on('refund.completed', (e, tx) => this.onRefund(e, tx));
    this.events.on('creditnote.issued', (e, tx) => this.onCreditNote(e, tx));
    this.events.on('cash.shift_closed', (e, tx) => this.onShiftClosed(e, tx));
  }

  // ------------------------------------------------------------------ accounts
  async ensureAccounts(tx: Tx, tenantId: string): Promise<void> {
    const existing = new Set((await tx.ledgerAccount.findMany({ where: { tenantId, systemKey: { not: null } }, select: { systemKey: true } })).map((a) => a.systemKey));
    const taken = new Set((await tx.ledgerAccount.findMany({ where: { tenantId }, select: { code: true } })).map((a) => a.code));
    for (const a of SYSTEM_ACCOUNTS) {
      if (existing.has(a.key)) continue;
      // A centre may already use the code for an account of its own: take the next free one.
      let code = a.code;
      while (taken.has(code)) code = String(Number(code) + 1);
      taken.add(code);
      await tx.ledgerAccount.create({ data: { tenantId, code, name: a.name, nameAr: a.nameAr, type: a.type, systemKey: a.key } });
    }
  }

  private async accountIds(tx: Tx, tenantId: string): Promise<Map<string, string>> {
    let rows = await tx.ledgerAccount.findMany({ where: { tenantId, systemKey: { not: null } }, select: { id: true, systemKey: true } });
    if (rows.length < SYSTEM_ACCOUNTS.length) {
      await this.ensureAccounts(tx, tenantId);
      rows = await tx.ledgerAccount.findMany({ where: { tenantId, systemKey: { not: null } }, select: { id: true, systemKey: true } });
    }
    return new Map(rows.map((r) => [r.systemKey!, r.id]));
  }

  private async localDate(tx: Tx, tenantId: string, at: Date | null | undefined): Promise<Date> {
    const tz = safeTimeZone((await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { timezone: true } })).timezone);
    return new Date(`${localYmd(at ?? new Date(), tz)}T00:00:00.000Z`);
  }

  /**
   * Writes one balanced journal. Lines with a zero amount are left out; system account keys or account ids are
   * accepted. Returns null when an automatic posting for the same source already exists.
   */
  async post(
    tx: Tx,
    tenantId: string,
    entry: { date: Date; memo: string; sourceType: string; sourceId?: string | null; branchId?: string | null; reversalOfId?: string | null },
    lines: PostingLine[],
  ): Promise<string | null> {
    const ids = await this.accountIds(tx, tenantId);
    const resolved = lines
      .map((l) => ({ ...l, debit: D(l.debit ?? 0).toDecimalPlaces(2), credit: D(l.credit ?? 0).toDecimalPlaces(2) }))
      .flatMap((l) => {
        // A negative amount is the same amount on the other side.
        const net = l.debit.minus(l.credit);
        if (net.isZero()) return [];
        return [{ ...l, debit: net.gt(0) ? net : D(0), credit: net.lt(0) ? net.neg() : D(0) }];
      });
    if (!resolved.length) return null;
    const debit = sum(resolved.map((l) => l.debit));
    const credit = sum(resolved.map((l) => l.credit));
    if (!debit.equals(credit)) throw new Error(`Unbalanced posting ${entry.sourceType} ${entry.sourceId ?? ''}: ${fmt(debit)} / ${fmt(credit)}`);
    if (entry.sourceId) {
      const dup = await tx.journalEntry.findFirst({ where: { tenantId, sourceType: entry.sourceType, sourceId: entry.sourceId }, select: { id: true } });
      if (dup && !['EXPENSE', 'EXPENSE_REVERSAL', 'MANUAL', 'MANUAL_REVERSAL'].includes(entry.sourceType)) return null;
    }
    const created = await tx.journalEntry.create({
      data: {
        tenantId,
        entryNo: await this.sequences.next(tx, 'journal'),
        date: entry.date,
        memo: entry.memo.slice(0, 500),
        sourceType: entry.sourceType,
        sourceId: entry.sourceId ?? null,
        branchId: entry.branchId ?? null,
        reversalOfId: entry.reversalOfId ?? null,
        createdById: ctx()?.userId ?? null,
      },
    });
    await tx.journalLine.createMany({
      data: resolved.map((l) => {
        const accountId = ids.get(l.account) ?? l.account;
        return { tenantId, entryId: created.id, accountId, debit: l.debit, credit: l.credit, memo: l.memo ?? null, customerId: l.customerId ?? null };
      }),
    });
    return created.id;
  }

  /** Posts the mirror image of an entry (debits become credits) and links it. */
  async reverse(tx: Tx, tenantId: string, entryId: string, sourceType: string, memo: string, date?: Date): Promise<string | null> {
    const original = await tx.journalEntry.findFirst({ where: { id: entryId, tenantId }, include: { lines: true } });
    if (!original) return null;
    const already = await tx.journalEntry.findFirst({ where: { tenantId, reversalOfId: entryId }, select: { id: true } });
    if (already) return null;
    return this.post(
      tx,
      tenantId,
      { date: date ?? (await this.localDate(tx, tenantId, new Date())), memo, sourceType, sourceId: original.sourceId, branchId: original.branchId, reversalOfId: original.id },
      original.lines.map((l) => ({ account: l.accountId, debit: l.credit, credit: l.debit, memo: l.memo ?? undefined, customerId: l.customerId })),
    );
  }

  // ------------------------------------------------------------------ automatic postings
  /** Per-component amounts of an invoice: net of line discounts, VAT separately. */
  private async invoiceParts(tx: Tx, invoiceId: string) {
    const items = await tx.invoiceItem.findMany({ where: { invoiceId }, select: { component: true, quantity: true, unitAmount: true, discountAmount: true, taxAmount: true } });
    const net = (c: string) => sum(items.filter((i) => i.component === c).map((i) => D(i.quantity).mul(i.unitAmount).minus(i.discountAmount))).toDecimalPlaces(2);
    return { service: net('SERVICE_FEE'), government: net('GOVERNMENT_FEE'), thirdParty: net('THIRD_PARTY_FEE'), tax: sum(items.map((i) => i.taxAmount)).toDecimalPlaces(2) };
  }

  private async treatment(tx: Tx, tenantId: string) {
    const rows = await tx.feeComponent.findMany({ where: { tenantId }, select: { type: true, treatment: true } });
    const asRevenue = (type: string) => rows.find((r) => r.type === type)?.treatment === 'REVENUE';
    return { governmentAccount: asRevenue('GOVERNMENT_FEE') ? 'GOV_REVENUE' : 'GOV_PAYABLE', thirdPartyAccount: asRevenue('THIRD_PARTY_FEE') ? 'THIRD_PARTY_REVENUE' : 'THIRD_PARTY_PAYABLE' };
  }

  async postInvoice(tx: Tx, tenantId: string, invoiceId: string) {
    const inv = await tx.invoice.findFirst({ where: { id: invoiceId, tenantId }, select: { id: true, invoiceNo: true, total: true, issuedAt: true, customerId: true, branchId: true, status: true } });
    if (!inv || inv.status === 'DRAFT') return null;
    const parts = await this.invoiceParts(tx, inv.id);
    const t = await this.treatment(tx, tenantId);
    // Rounding: whatever the line arithmetic leaves goes to the service revenue, so the entry equals the invoice total.
    const service = D(inv.total).minus(parts.government).minus(parts.thirdParty).minus(parts.tax);
    return this.post(tx, tenantId, { date: await this.localDate(tx, tenantId, inv.issuedAt), memo: `Invoice ${inv.invoiceNo}`, sourceType: 'INVOICE_ISSUED', sourceId: inv.id, branchId: inv.branchId }, [
      { account: 'AR', debit: inv.total, customerId: inv.customerId },
      { account: 'SERVICE_REVENUE', credit: service },
      { account: 'VAT_PAYABLE', credit: parts.tax },
      { account: t.governmentAccount, credit: parts.government },
      { account: t.thirdPartyAccount, credit: parts.thirdParty },
    ]);
  }

  async postPayment(tx: Tx, tenantId: string, paymentId: string) {
    const p = await tx.payment.findFirst({
      where: { id: paymentId, tenantId },
      select: { id: true, paymentNo: true, method: true, amount: true, receivedAt: true, customerId: true, branchId: true, status: true, paymentAllocations: { select: { amount: true } } },
    });
    if (!p || !['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(p.status)) return null;
    const allocated = sum(p.paymentAllocations.map((a) => a.amount));
    return this.post(tx, tenantId, { date: await this.localDate(tx, tenantId, p.receivedAt), memo: `Payment ${p.paymentNo}`, sourceType: 'PAYMENT', sourceId: p.id, branchId: p.branchId }, [
      { account: PAYMENT_ACCOUNT[p.method] ?? 'BANK', debit: p.amount },
      { account: 'AR', credit: allocated, customerId: p.customerId },
      { account: 'CUSTOMER_ADVANCES', credit: D(p.amount).minus(allocated), customerId: p.customerId },
    ]);
  }

  async postRefund(tx: Tx, tenantId: string, refundId: string) {
    const r = await tx.refund.findFirst({ where: { id: refundId, tenantId }, select: { id: true, refundNo: true, amount: true, processedAt: true, status: true, payment: { select: { method: true, customerId: true, branchId: true } } } });
    if (!r || r.status !== 'COMPLETED') return null;
    return this.post(tx, tenantId, { date: await this.localDate(tx, tenantId, r.processedAt), memo: `Refund ${r.refundNo}`, sourceType: 'REFUND', sourceId: r.id, branchId: r.payment.branchId }, [
      { account: 'AR', debit: r.amount, customerId: r.payment.customerId },
      { account: PAYMENT_ACCOUNT[r.payment.method] ?? 'BANK', credit: r.amount },
    ]);
  }

  async postCreditNote(tx: Tx, tenantId: string, creditNoteId: string) {
    const cn = await tx.creditNote.findFirst({ where: { id: creditNoteId, tenantId }, select: { id: true, creditNoteNo: true, amount: true, taxAmount: true, breakdown: true, issuedAt: true, status: true, invoice: { select: { customerId: true, branchId: true } } } });
    if (!cn || cn.status === 'VOID') return null;
    const b = (cn.breakdown ?? {}) as Record<string, string>;
    const t = await this.treatment(tx, tenantId);
    const service = D(b.SERVICE_FEE ?? 0);
    // The breakdown includes VAT; the VAT share belongs to the (taxable) service fee.
    const vat = Prisma.Decimal.min(D(cn.taxAmount), service);
    return this.post(tx, tenantId, { date: await this.localDate(tx, tenantId, cn.issuedAt), memo: `Credit note ${cn.creditNoteNo}`, sourceType: 'CREDIT_NOTE', sourceId: cn.id, branchId: cn.invoice.branchId }, [
      { account: 'SERVICE_REVENUE', debit: service.minus(vat) },
      { account: 'VAT_PAYABLE', debit: vat },
      { account: t.governmentAccount, debit: b.GOVERNMENT_FEE ?? 0 },
      { account: t.thirdPartyAccount, debit: b.THIRD_PARTY_FEE ?? 0 },
      { account: 'AR', credit: cn.amount, customerId: cn.invoice.customerId },
    ]);
  }

  async postExpense(tx: Tx, tenantId: string, expenseId: string) {
    const e = await tx.expense.findFirst({ where: { id: expenseId, tenantId }, select: { id: true, category: true, description: true, amount: true, method: true, paidOn: true, branchId: true, deletedAt: true } });
    if (!e || e.deletedAt) return null;
    return this.post(tx, tenantId, { date: e.paidOn, memo: `Expense: ${e.description}`, sourceType: 'EXPENSE', sourceId: e.id, branchId: e.branchId }, [
      { account: EXPENSE_ACCOUNT[e.category] ?? 'EXP_OTHER', debit: e.amount },
      { account: expensePaidFrom(e.method), credit: e.amount },
    ]);
  }

  /** An expense was changed or deleted: its current posting is reversed and (unless deleted) posted again. */
  async repostExpense(tx: Tx, tenantId: string, expenseId: string) {
    const live = await tx.journalEntry.findMany({ where: { tenantId, sourceType: 'EXPENSE', sourceId: expenseId }, select: { id: true } });
    const reversed = new Set((await tx.journalEntry.findMany({ where: { tenantId, reversalOfId: { in: live.map((l) => l.id) } }, select: { reversalOfId: true } })).map((r) => r.reversalOfId));
    for (const entry of live.filter((l) => !reversed.has(l.id))) await this.reverse(tx, tenantId, entry.id, 'EXPENSE_REVERSAL', 'Expense changed or deleted');
    await this.postExpense(tx, tenantId, expenseId);
  }

  async postCommission(tx: Tx, tenantId: string, entryIds: string[], kind: 'ACCRUED' | 'VOIDED' | 'PAID') {
    for (const id of entryIds) {
      const e = await tx.commissionEntry.findFirst({ where: { id, tenantId }, select: { id: true, amount: true, earnedAt: true, paidAt: true, voidedAt: true, request: { select: { requestNo: true, branchId: true } }, membership: { select: { user: { select: { fullName: true } } } } } });
      if (!e) continue;
      const who = `${e.membership.user.fullName} on ${e.request.requestNo}`;
      const date = await this.localDate(tx, tenantId, kind === 'PAID' ? e.paidAt : kind === 'VOIDED' ? e.voidedAt : e.earnedAt);
      const lines: PostingLine[] =
        kind === 'ACCRUED'
          ? [{ account: 'EXP_COMMISSION', debit: e.amount }, { account: 'COMMISSION_PAYABLE', credit: e.amount }]
          : kind === 'VOIDED'
            ? [{ account: 'COMMISSION_PAYABLE', debit: e.amount }, { account: 'EXP_COMMISSION', credit: e.amount }]
            : [{ account: 'COMMISSION_PAYABLE', debit: e.amount }, { account: 'BANK', credit: e.amount }];
      await this.post(tx, tenantId, { date, memo: `Commission ${kind.toLowerCase()}: ${who}`, sourceType: `COMMISSION_${kind}`, sourceId: e.id, branchId: e.request.branchId }, lines);
    }
  }

  async postShiftVariance(tx: Tx, tenantId: string, shiftId: string) {
    const s = await tx.cashierShift.findFirst({ where: { id: shiftId, tenantId }, select: { id: true, shiftNo: true, cashVariance: true, closedAt: true, branchId: true } });
    if (!s || !s.cashVariance || D(s.cashVariance).isZero()) return null;
    const v = D(s.cashVariance);
    // Short (negative): the expense grows and the cash account comes down to what was counted.
    return this.post(tx, tenantId, { date: await this.localDate(tx, tenantId, s.closedAt), memo: `Till difference ${s.shiftNo}`, sourceType: 'CASH_VARIANCE', sourceId: s.id, branchId: s.branchId }, [
      { account: 'EXP_CASH_DIFF', debit: v.neg() },
      { account: 'CASH', debit: v },
    ]);
  }

  private async onInvoiceIssued(e: DomainEvent, tx: Tx) {
    if (isId(e.payload?.invoiceId) && e.tenantId) await this.postInvoice(tx, e.tenantId, e.payload.invoiceId);
  }
  private async onInvoiceVoided(e: DomainEvent, tx: Tx) {
    if (!isId(e.payload?.invoiceId) || !e.tenantId) return;
    const issued = await tx.journalEntry.findFirst({ where: { tenantId: e.tenantId, sourceType: 'INVOICE_ISSUED', sourceId: e.payload.invoiceId }, select: { id: true } });
    if (!issued) return;
    const voidedNo = await tx.invoice.findFirst({ where: { id: e.payload.invoiceId }, select: { invoiceNo: true } });
    await this.post(
      tx,
      e.tenantId,
      { date: await this.localDate(tx, e.tenantId, new Date()), memo: `Invoice ${voidedNo?.invoiceNo ?? ''} voided`, sourceType: 'INVOICE_VOIDED', sourceId: e.payload.invoiceId, reversalOfId: issued.id },
      (await tx.journalLine.findMany({ where: { entryId: issued.id } })).map((l) => ({ account: l.accountId, debit: l.credit, credit: l.debit, customerId: l.customerId })),
    );
  }
  private async onPayment(e: DomainEvent, tx: Tx) {
    if (isId(e.payload?.paymentId) && e.tenantId) await this.postPayment(tx, e.tenantId, e.payload.paymentId);
  }
  private async onRefund(e: DomainEvent, tx: Tx) {
    if (isId(e.payload?.refundId) && e.tenantId) await this.postRefund(tx, e.tenantId, e.payload.refundId);
  }
  private async onCreditNote(e: DomainEvent, tx: Tx) {
    if (isId(e.payload?.creditNoteId) && e.tenantId) await this.postCreditNote(tx, e.tenantId, e.payload.creditNoteId);
  }
  private async onShiftClosed(e: DomainEvent, tx: Tx) {
    if (isId(e.payload?.shiftId) && e.tenantId) await this.postShiftVariance(tx, e.tenantId, e.payload.shiftId);
  }

  // ------------------------------------------------------------------ history
  /**
   * Posts everything recorded before accounting existed (or that has no posting for any other reason), in date
   * order, with the original dates. Safe to run again: automatic postings exist once per document.
   */
  async buildFromHistory() {
    return this.db.tx(
      async (tx) => {
        const tenantId = this.db.tenantId;
        await this.ensureAccounts(tx, tenantId);
        const posted = await tx.journalEntry.findMany({ where: { tenantId, sourceId: { not: null } }, select: { sourceType: true, sourceId: true } });
        const has = new Set(posted.map((p) => `${p.sourceType}:${p.sourceId}`));
        const counts: Record<string, number> = {};
        const run = async (type: string, ids: string[], fn: (id: string) => Promise<unknown>) => {
          let n = 0;
          for (const id of ids) {
            if (has.has(`${type}:${id}`)) continue;
            if (await fn(id)) n += 1;
          }
          counts[type] = n;
        };
        const ids = <T extends { id: string }>(rows: T[]) => rows.map((r) => r.id);
        await run('INVOICE_ISSUED', ids(await tx.invoice.findMany({ where: { tenantId, status: { not: 'DRAFT' } }, orderBy: { issuedAt: 'asc' }, select: { id: true } })), (id) => this.postInvoice(tx, tenantId, id));
        const voided = await tx.invoice.findMany({ where: { tenantId, status: 'VOID' }, select: { id: true } });
        for (const v of voided) if (!has.has(`INVOICE_VOIDED:${v.id}`)) await this.onInvoiceVoided({ id: '', tenantId, type: 'invoice.voided', payload: { invoiceId: v.id }, createdAt: new Date() } as DomainEvent, tx);
        counts.INVOICE_VOIDED = voided.length;
        await run('CREDIT_NOTE', ids(await tx.creditNote.findMany({ where: { tenantId, status: { not: 'VOID' } }, orderBy: { issuedAt: 'asc' }, select: { id: true } })), (id) => this.postCreditNote(tx, tenantId, id));
        await run('PAYMENT', ids(await tx.payment.findMany({ where: { tenantId, status: { in: ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'] } }, orderBy: { receivedAt: 'asc' }, select: { id: true } })), (id) => this.postPayment(tx, tenantId, id));
        await run('REFUND', ids(await tx.refund.findMany({ where: { tenantId, status: 'COMPLETED' }, orderBy: { processedAt: 'asc' }, select: { id: true } })), (id) => this.postRefund(tx, tenantId, id));
        await run('EXPENSE', ids(await tx.expense.findMany({ where: { tenantId, deletedAt: null }, orderBy: { paidOn: 'asc' }, select: { id: true } })), (id) => this.postExpense(tx, tenantId, id));
        const commission = await tx.commissionEntry.findMany({ where: { tenantId }, orderBy: { earnedAt: 'asc' }, select: { id: true, status: true } });
        let c = 0;
        for (const e of commission) {
          if (!has.has(`COMMISSION_ACCRUED:${e.id}`)) {
            await this.postCommission(tx, tenantId, [e.id], 'ACCRUED');
            c += 1;
          }
          if (e.status === 'VOID' && !has.has(`COMMISSION_VOIDED:${e.id}`)) await this.postCommission(tx, tenantId, [e.id], 'VOIDED');
          if (e.status === 'PAID' && !has.has(`COMMISSION_PAID:${e.id}`)) await this.postCommission(tx, tenantId, [e.id], 'PAID');
        }
        counts.COMMISSION = c;
        await run('CASH_VARIANCE', ids(await tx.cashierShift.findMany({ where: { tenantId, status: { not: 'OPEN' } }, select: { id: true } })), (id) => this.postShiftVariance(tx, tenantId, id));
        await this.audit.log({ action: 'accounting.history_built', resourceType: 'Tenant', resourceId: tenantId, after: counts }, tx);
        return { posted: counts };
      },
      { timeoutMs: 300_000 },
    );
  }

  // ------------------------------------------------------------------ chart of accounts (staff)
  async accounts(asOf?: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      await this.ensureAccounts(tx, tenantId);
      const accounts = await tx.ledgerAccount.findMany({ where: { tenantId }, orderBy: { code: 'asc' } });
      const totals = await this.balances(tx, tenantId, asOf ? { lte: new Date(`${asOf}T00:00:00.000Z`) } : undefined);
      return accounts.map((a) => {
        const t = totals.get(a.id) ?? { debit: D(0), credit: D(0) };
        const balance = DEBIT_NORMAL.includes(a.type) ? t.debit.minus(t.credit) : t.credit.minus(t.debit);
        return { id: a.id, code: a.code, name: a.name, nameAr: a.nameAr, type: a.type, systemKey: a.systemKey, isActive: a.isActive, debit: fmt(t.debit), credit: fmt(t.credit), balance: fmt(balance) };
      });
    });
  }

  async createAccount(input: LedgerAccountInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      if (await tx.ledgerAccount.findFirst({ where: { tenantId, code: input.code } })) throw Errors.conflict('ACCOUNT_CODE_TAKEN', `Account code ${input.code} is already used.`);
      const a = await tx.ledgerAccount.create({ data: { tenantId, code: input.code, name: input.name, nameAr: input.nameAr ?? null, type: input.type } });
      await this.audit.log({ action: 'accounting.account_created', resourceType: 'LedgerAccount', resourceId: a.id, after: { code: a.code, name: a.name, type: a.type } }, tx);
      return a;
    });
  }

  async updateAccount(id: string, input: UpdateLedgerAccountInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const a = found(await tx.ledgerAccount.findFirst({ where: { id, tenantId } }), 'Account');
      if (input.isActive === false && a.systemKey) throw Errors.conflict('SYSTEM_ACCOUNT', 'This account is used by the automatic postings and cannot be switched off. You can rename it.');
      const updated = await tx.ledgerAccount.update({ where: { id }, data: { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.nameAr !== undefined ? { nameAr: input.nameAr } : {}), ...(input.isActive !== undefined ? { isActive: input.isActive } : {}) } });
      await this.audit.log({ action: 'accounting.account_updated', resourceType: 'LedgerAccount', resourceId: id, before: { name: a.name, isActive: a.isActive }, after: input }, tx);
      return updated;
    });
  }

  // ------------------------------------------------------------------ journals (staff)
  async journal(query: { from?: string; to?: string; accountId?: string; sourceType?: string; page?: number; pageSize?: number }) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const where: Prisma.JournalEntryWhereInput = {
        tenantId,
        ...(query.from || query.to ? { date: { ...(query.from ? { gte: new Date(`${query.from}T00:00:00.000Z`) } : {}), ...(query.to ? { lte: new Date(`${query.to}T00:00:00.000Z`) } : {}) } } : {}),
        ...(query.sourceType ? { sourceType: query.sourceType } : {}),
        ...(query.accountId ? { lines: { some: { accountId: query.accountId } } } : {}),
      };
      const page = query.page ?? 1;
      const size = Math.min(query.pageSize ?? 50, 200);
      const [rows, total] = await Promise.all([
        tx.journalEntry.findMany({ where, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], skip: (page - 1) * size, take: size, include: { lines: { include: { account: { select: { code: true, name: true, nameAr: true } } } } } }),
        tx.journalEntry.count({ where }),
      ]);
      return {
        data: rows.map((e) => ({
          id: e.id,
          entryNo: e.entryNo,
          date: e.date.toISOString().slice(0, 10),
          memo: e.memo,
          sourceType: e.sourceType,
          sourceId: e.sourceId,
          reversalOfId: e.reversalOfId,
          lines: e.lines.map((l) => ({ accountId: l.accountId, code: l.account.code, name: l.account.name, nameAr: l.account.nameAr, debit: fmt(l.debit), credit: fmt(l.credit), memo: l.memo })),
        })),
        meta: { page, pageSize: size, total },
      };
    });
  }

  async manualJournal(input: ManualJournalInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const accounts = await tx.ledgerAccount.findMany({ where: { tenantId, id: { in: input.lines.map((l) => l.accountId) } }, select: { id: true, isActive: true, code: true } });
      if (accounts.length !== new Set(input.lines.map((l) => l.accountId)).size) throw Errors.notFound('Account');
      const inactive = accounts.find((a) => !a.isActive);
      if (inactive) throw Errors.unprocessable('ACCOUNT_INACTIVE', `Account ${inactive.code} is switched off.`);
      const debit = sum(input.lines.map((l) => D(l.debit ?? 0)));
      const credit = sum(input.lines.map((l) => D(l.credit ?? 0)));
      if (!debit.equals(credit)) throw Errors.unprocessable('JOURNAL_NOT_BALANCED', `Debits (${fmt(debit)}) and credits (${fmt(credit)}) must be equal.`);
      const id = await this.post(
        tx,
        tenantId,
        { date: new Date(`${input.date}T00:00:00.000Z`), memo: input.memo, sourceType: 'MANUAL', sourceId: null },
        input.lines.map((l) => ({ account: l.accountId, debit: l.debit ?? 0, credit: l.credit ?? 0, memo: l.memo ?? undefined })),
      );
      await this.audit.log({ action: 'accounting.journal_posted', resourceType: 'JournalEntry', resourceId: id ?? undefined, summary: `Manual journal: ${input.memo} (${fmt(debit)})` }, tx);
      return { id };
    });
  }

  async reverseManual(id: string, reason: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const entry = found(await tx.journalEntry.findFirst({ where: { id, tenantId } }), 'Journal');
      if (entry.sourceType !== 'MANUAL') throw Errors.conflict('AUTOMATIC_JOURNAL', 'Automatic journals follow their documents: void the invoice, issue a credit note or change the expense instead.');
      const reversal = await this.reverse(tx, tenantId, id, 'MANUAL_REVERSAL', `Reversal of ${entry.entryNo}: ${reason}`);
      if (!reversal) throw Errors.conflict('ALREADY_REVERSED', `Journal ${entry.entryNo} has already been reversed.`);
      await this.audit.log({ action: 'accounting.journal_reversed', resourceType: 'JournalEntry', resourceId: id, summary: `${entry.entryNo} reversed: ${reason}` }, tx);
      return { id: reversal };
    });
  }

  // ------------------------------------------------------------------ reports
  private async balances(tx: Tx, tenantId: string, date?: Prisma.DateTimeFilter): Promise<Map<string, { debit: Dec; credit: Dec }>> {
    const rows = await tx.journalLine.groupBy({ by: ['accountId'], where: { tenantId, ...(date ? { entry: { date } } : {}) }, _sum: { debit: true, credit: true } });
    return new Map(rows.map((r) => [r.accountId, { debit: D(r._sum.debit ?? 0), credit: D(r._sum.credit ?? 0) }]));
  }

  async trialBalance(asOf: string) {
    const accounts = await this.accounts(asOf);
    const rows = accounts.filter((a) => Number(a.debit) !== 0 || Number(a.credit) !== 0);
    const debit = sum(rows.map((a) => D(a.debit)));
    const credit = sum(rows.map((a) => D(a.credit)));
    return { asOf, rows, totals: { debit: fmt(debit), credit: fmt(credit) }, balanced: debit.equals(credit) };
  }

  async profitAndLoss(from: string, to: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const accounts = await tx.ledgerAccount.findMany({ where: { tenantId, type: { in: ['REVENUE', 'EXPENSE'] } }, orderBy: { code: 'asc' } });
      const totals = await this.balances(tx, tenantId, { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) });
      const line = (a: (typeof accounts)[number]) => {
        const t = totals.get(a.id) ?? { debit: D(0), credit: D(0) };
        return { id: a.id, code: a.code, name: a.name, nameAr: a.nameAr, amount: a.type === 'REVENUE' ? t.credit.minus(t.debit) : t.debit.minus(t.credit) };
      };
      const revenue = accounts.filter((a) => a.type === 'REVENUE').map(line).filter((l) => !l.amount.isZero());
      const expenses = accounts.filter((a) => a.type === 'EXPENSE').map(line).filter((l) => !l.amount.isZero());
      const totalRevenue = sum(revenue.map((l) => l.amount));
      const totalExpenses = sum(expenses.map((l) => l.amount));
      const out = (l: { amount: Dec }) => ({ ...l, amount: fmt(l.amount) });
      return { from, to, revenue: revenue.map(out), expenses: expenses.map(out), totalRevenue: fmt(totalRevenue), totalExpenses: fmt(totalExpenses), netProfit: fmt(totalRevenue.minus(totalExpenses)) };
    });
  }

  async balanceSheet(asOf: string) {
    const accounts = await this.accounts(asOf);
    const pick = (type: AccountType) => accounts.filter((a) => a.type === type && Number(a.balance) !== 0).map((a) => ({ id: a.id, code: a.code, name: a.name, nameAr: a.nameAr, amount: a.balance }));
    // Profit not yet closed into retained earnings is shown inside equity.
    const earnings = sum(accounts.filter((a) => a.type === 'REVENUE').map((a) => D(a.balance))).minus(sum(accounts.filter((a) => a.type === 'EXPENSE').map((a) => D(a.balance))));
    const assets = pick('ASSET');
    const liabilities = pick('LIABILITY');
    const equity = pick('EQUITY');
    const totalAssets = sum(assets.map((a) => D(a.amount)));
    const totalLiabilities = sum(liabilities.map((a) => D(a.amount)));
    const totalEquity = sum(equity.map((a) => D(a.amount))).plus(earnings);
    return {
      asOf,
      assets,
      liabilities,
      equity,
      currentEarnings: fmt(earnings),
      totalAssets: fmt(totalAssets),
      totalLiabilities: fmt(totalLiabilities),
      totalEquity: fmt(totalEquity),
      balanced: totalAssets.equals(totalLiabilities.plus(totalEquity)),
    };
  }

  /** Lines of one account in a period with the running balance (opening balance included). */
  async accountLedger(accountId: string, from: string, to: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const account = found(await tx.ledgerAccount.findFirst({ where: { id: accountId, tenantId } }), 'Account');
      const sign = DEBIT_NORMAL.includes(account.type) ? 1 : -1;
      const opening = await tx.journalLine.aggregate({ where: { tenantId, accountId, entry: { date: { lt: new Date(`${from}T00:00:00.000Z`) } } }, _sum: { debit: true, credit: true } });
      let running = D(opening._sum.debit ?? 0).minus(opening._sum.credit ?? 0).mul(sign);
      const openingBalance = running;
      const lines = await tx.journalLine.findMany({
        where: { tenantId, accountId, entry: { date: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) } } },
        include: { entry: { select: { entryNo: true, date: true, memo: true, sourceType: true } } },
        orderBy: [{ entry: { date: 'asc' } }, { createdAt: 'asc' }],
      });
      return {
        account: { id: account.id, code: account.code, name: account.name, nameAr: account.nameAr, type: account.type },
        from,
        to,
        openingBalance: fmt(openingBalance),
        lines: lines.map((l) => {
          running = running.plus(D(l.debit).minus(l.credit).mul(sign));
          return { entryNo: l.entry.entryNo, date: l.entry.date.toISOString().slice(0, 10), memo: l.memo ?? l.entry.memo, sourceType: l.entry.sourceType, debit: fmt(l.debit), credit: fmt(l.credit), balance: fmt(running) };
        }),
        closingBalance: fmt(running),
      };
    });
  }

  /** Output VAT for a period (VAT charged on invoices less VAT reversed by credit notes) and what is still payable. */
  async vatReport(from: string, to: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const vat = (await this.accountIds(tx, tenantId)).get('VAT_PAYABLE')!;
      const period = await tx.journalLine.aggregate({ where: { tenantId, accountId: vat, entry: { date: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) } } }, _sum: { debit: true, credit: true } });
      const tax = await tx.invoice.aggregate({ where: { tenantId, status: { notIn: ['DRAFT', 'VOID'] }, issuedAt: { gte: new Date(`${from}T00:00:00.000Z`), lt: new Date(Date.parse(`${to}T00:00:00.000Z`) + 86_400_000) } }, _sum: { taxTotal: true, total: true }, _count: { _all: true } });
      const charged = D(period._sum.credit ?? 0);
      const reversed = D(period._sum.debit ?? 0);
      return { from, to, outputVat: fmt(charged), reversed: fmt(reversed), netOutputVat: fmt(charged.minus(reversed)), invoices: tax._count._all, invoicedTotal: fmt(tax._sum.total ?? 0) };
    });
  }
}
