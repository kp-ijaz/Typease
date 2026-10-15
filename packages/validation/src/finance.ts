import { z } from 'zod';
import { isoDate, isoDateTime, moneyAmount, optionalText, pageQuery, positiveMoney, queryBool, trimmed, uuid } from './common';

/**
 * Customer-facing finance (quotations, invoices, payments, refunds, credit notes,
 * expenses, liabilities, reconciliation). Money is always a decimal string with at
 * most two decimals; the API never accepts or returns floating point amounts.
 */

const feeComponentType = z.enum(['SERVICE_FEE', 'GOVERNMENT_FEE', 'THIRD_PARTY_FEE']);
const accountingTreatment = z.enum(['REVENUE', 'PASS_THROUGH_LIABILITY']);
const manualPaymentMethod = z.enum(['CASH', 'CARD_POS', 'BANK_TRANSFER', 'CHEQUE']);
const paymentMethod = z.enum(['CASH', 'CARD_POS', 'BANK_TRANSFER', 'CHEQUE', 'ONLINE_GATEWAY']);

const quantity = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .pipe(z.string().regex(/^\d{1,8}(\.\d{1,2})?$/, 'Enter a quantity such as 1 or 2.5'))
  .refine((v) => Number(v) > 0, 'Quantity must be greater than zero');
const taxRate = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .pipe(z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, 'Enter a tax rate such as 5'))
  .refine((v) => Number(v) <= 100, 'Tax rate cannot exceed 100%');

/** True when free text contains something that looks like a payment card number (13-19 digits passing the Luhn check). */
export function looksLikeCardNumber(text: string | null | undefined): boolean {
  if (!text) return false;
  for (const match of text.matchAll(/(?:\d[ -]?){13,19}/g)) {
    const digits = match[0].replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    let total = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      total += d;
    }
    if (total % 10 === 0) return true;
  }
  return false;
}
const noCardNumber = (max: number) =>
  optionalText(max).refine((v) => !looksLikeCardNumber(v), 'Never enter card numbers. Use the POS slip or approval number instead.');

// ---------------------------------------------------------------- fee components
export const feeComponentsUpdateSchema = z.object({
  components: z
    .array(
      z.object({
        type: feeComponentType,
        name: trimmed(120, 2).optional(),
        treatment: accountingTreatment.optional(),
        taxable: z.boolean().optional(),
        ledgerCode: optionalText(40),
      }),
    )
    .min(1)
    .max(3),
});
export type FeeComponentsUpdateInput = z.infer<typeof feeComponentsUpdateSchema>;

// ---------------------------------------------------------------- lines
export const financeLineSchema = z.object({
  serviceId: uuid.nullish(),
  description: trimmed(300, 1),
  component: feeComponentType,
  quantity: quantity.default('1'),
  unitAmount: moneyAmount,
  discountAmount: moneyAmount.default('0'),
  /** Omit to use the default from the service's tax mode and the centre's tax rate. */
  taxRatePercent: taxRate.optional(),
});
export type FinanceLineInput = z.infer<typeof financeLineSchema>;
const lines = z.array(financeLineSchema).min(1, 'Add at least one line').max(100);

// ---------------------------------------------------------------- quotations
export const createQuotationSchema = z.object({
  customerId: uuid,
  branchId: uuid.optional(),
  requestId: uuid.nullish(),
  corporateAccountId: uuid.nullish(),
  validUntil: isoDateTime.optional(),
  notes: optionalText(2000),
  /** Required when any line carries a discount. */
  discountReason: optionalText(500),
  items: lines,
});
export type CreateQuotationInput = z.infer<typeof createQuotationSchema>;

export const quotationFromRequestSchema = z.object({
  validUntil: isoDateTime.optional(),
  notes: optionalText(2000),
  /** Optional discount on the service-fee line (never on pass-through fees). Needs approval. */
  serviceFeeDiscount: moneyAmount.optional(),
  discountReason: optionalText(500),
});
export type QuotationFromRequestInput = z.infer<typeof quotationFromRequestSchema>;

export const updateQuotationSchema = z.object({
  validUntil: isoDateTime.optional(),
  notes: optionalText(2000),
  discountReason: optionalText(500),
  items: lines.optional(),
});
export type UpdateQuotationInput = z.infer<typeof updateQuotationSchema>;

export const discountApproveSchema = z.object({ note: optionalText(500) });
export const discountRejectSchema = z.object({
  reason: trimmed(500, 3),
  /** true (default): remove the discounts so the quotation can be sent; false: keep them for a new request. */
  clearDiscounts: z.boolean().default(true),
});
export type DiscountRejectInput = z.infer<typeof discountRejectSchema>;

export const quotationApproveSchema = z.object({
  /** Mandatory when staff record the approval on the customer's behalf. */
  note: optionalText(500),
});
export const quotationRejectSchema = z.object({ reason: trimmed(500, 3) });

const quotationStatus = z.enum(['DRAFT', 'SENT', 'APPROVED', 'REJECTED', 'EXPIRED', 'SUPERSEDED', 'CANCELLED']);
export const quotationListQuery = pageQuery.extend({
  status: quotationStatus.optional(),
  customerId: uuid.optional(),
  requestId: uuid.optional(),
  corporateAccountId: uuid.optional(),
  branchId: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  discountApproval: z.enum(['NONE', 'PENDING', 'APPROVED', 'REJECTED']).optional(),
});
export type QuotationListQuery = z.infer<typeof quotationListQuery>;

// ---------------------------------------------------------------- invoices
export const createInvoiceSchema = z.object({
  customerId: uuid,
  branchId: uuid.optional(),
  requestId: uuid.nullish(),
  corporateAccountId: uuid.nullish(),
  notes: optionalText(2000),
  items: lines,
});
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
export const updateInvoiceSchema = z.object({ notes: optionalText(2000), items: lines.optional() });
export type UpdateInvoiceInput = z.infer<typeof updateInvoiceSchema>;
export const voidInvoiceSchema = z.object({ reason: trimmed(500, 3) });

const invoiceStatus = z.enum(['DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID', 'CREDITED']);
export const invoiceListQuery = pageQuery.extend({
  status: invoiceStatus.optional(),
  customerId: uuid.optional(),
  requestId: uuid.optional(),
  corporateAccountId: uuid.optional(),
  branchId: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  overdue: queryBool,
});
export type InvoiceListQuery = z.infer<typeof invoiceListQuery>;

// ---------------------------------------------------------------- payments
export const recordPaymentSchema = z.object({
  method: manualPaymentMethod,
  amount: positiveMoney,
  /** Free text only (cheque no., POS slip no., bank reference). Card numbers are rejected. */
  reference: noCardNumber(120),
  notes: noCardNumber(500),
  branchId: uuid,
  customerId: uuid.nullish(),
  receivedAt: isoDateTime.optional(),
  allocations: z
    .array(z.object({ invoiceId: uuid, amount: positiveMoney }))
    .min(1, 'Choose the invoice(s) this payment settles')
    .max(50),
});
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

export const payInvoiceSchema = z.object({
  /** Defaults to the full balance. */
  amount: positiveMoney.optional(),
  returnUrl: z.string().url().max(500).optional(),
});
export type PayInvoiceInput = z.infer<typeof payInvoiceSchema>;

const paymentStatus = z.enum(['PENDING', 'COMPLETED', 'FAILED', 'CANCELLED', 'PARTIALLY_REFUNDED', 'REFUNDED']);
export const paymentListQuery = pageQuery.extend({
  status: paymentStatus.optional(),
  method: paymentMethod.optional(),
  customerId: uuid.optional(),
  corporateAccountId: uuid.optional(),
  invoiceId: uuid.optional(),
  requestId: uuid.optional(),
  branchId: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  reconciled: queryBool,
});
export type PaymentListQuery = z.infer<typeof paymentListQuery>;

// ---------------------------------------------------------------- refunds
export const refundBreakdownSchema = z
  .object({
    SERVICE_FEE: moneyAmount.optional(),
    GOVERNMENT_FEE: moneyAmount.optional(),
    THIRD_PARTY_FEE: moneyAmount.optional(),
    TAX: moneyAmount.optional(),
  })
  .strict();
export type ComponentBreakdownInput = z.infer<typeof refundBreakdownSchema>;

export const requestRefundSchema = z.object({
  paymentId: uuid,
  /** Required when the payment settled more than one invoice. */
  invoiceId: uuid.nullish(),
  amount: positiveMoney,
  reason: trimmed(500, 3),
  /** Optional split of the amount; must add up to the amount. Without it the split is proportional. */
  breakdown: refundBreakdownSchema.optional(),
  /** true: the charge itself is cancelled (a credit note is issued); false: the amount becomes due again. */
  cancelCharge: z.boolean().default(false),
});
export type RequestRefundInput = z.infer<typeof requestRefundSchema>;

export const approveRefundSchema = z.object({
  /** Overrides the requester's choice. */
  cancelCharge: z.boolean().optional(),
  /** For manual methods: how the money was returned (cash voucher, transfer reference). Completes the refund. */
  reference: optionalText(120),
});
export type ApproveRefundInput = z.infer<typeof approveRefundSchema>;
export const completeRefundSchema = z.object({ reference: trimmed(120, 1) });
export const rejectRefundSchema = z.object({ reason: trimmed(500, 3) });

const refundStatus = z.enum(['REQUESTED', 'APPROVED', 'REJECTED', 'PROCESSING', 'COMPLETED', 'FAILED']);
export const refundListQuery = pageQuery.extend({
  status: refundStatus.optional(),
  paymentId: uuid.optional(),
  invoiceId: uuid.optional(),
  requestId: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type RefundListQuery = z.infer<typeof refundListQuery>;

// ---------------------------------------------------------------- credit notes
export const createCreditNoteSchema = z.object({
  invoiceId: uuid,
  amount: positiveMoney,
  reason: trimmed(500, 3),
  breakdown: refundBreakdownSchema.omit({ TAX: true }).optional(),
});
export type CreateCreditNoteInput = z.infer<typeof createCreditNoteSchema>;
export const creditNoteListQuery = pageQuery.extend({ invoiceId: uuid.optional(), from: isoDate.optional(), to: isoDate.optional() });
export type CreditNoteListQuery = z.infer<typeof creditNoteListQuery>;

// ---------------------------------------------------------------- expenses
const expenseCategory = z.enum(['GOVERNMENT_FEE_REMITTANCE', 'THIRD_PARTY_PAYMENT', 'RENT', 'SALARIES', 'SUPPLIES', 'UTILITIES', 'OTHER']);
export const createExpenseSchema = z.object({
  branchId: uuid,
  category: expenseCategory,
  /** Linking a remittance to a request settles that request's pass-through liability. */
  requestId: uuid.nullish(),
  description: trimmed(300, 2),
  amount: positiveMoney,
  paidOn: isoDate,
  payee: optionalText(160),
  reference: optionalText(120),
  method: z.enum(['CASH', 'CARD', 'BANK_TRANSFER', 'CHEQUE', 'E_WALLET', 'OTHER']).nullish(),
});
export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;
export const updateExpenseSchema = createExpenseSchema.partial();
export type UpdateExpenseInput = z.infer<typeof updateExpenseSchema>;
export const expenseListQuery = pageQuery.extend({
  category: expenseCategory.optional(),
  branchId: uuid.optional(),
  requestId: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type ExpenseListQuery = z.infer<typeof expenseListQuery>;

// ---------------------------------------------------------------- liabilities
export const liabilityQuery = z.object({
  branchId: uuid.optional(),
  requestId: uuid.optional(),
  component: z.enum(['GOVERNMENT_FEE', 'THIRD_PARTY_FEE']).optional(),
  /** Only requests that still have money to remit. */
  outstandingOnly: queryBool,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type LiabilityQuery = z.infer<typeof liabilityQuery>;

// ---------------------------------------------------------------- reconciliation
export const createReconciliationSchema = z
  .object({
    method: paymentMethod,
    /** Required for ONLINE_GATEWAY, e.g. "stripe". */
    gateway: optionalText(40),
    branchId: uuid.nullish(),
    periodStart: isoDateTime,
    periodEnd: isoDateTime,
    statementReference: optionalText(120),
    /** Net amount that reached the bank / till according to the statement. */
    settledAmount: moneyAmount,
    /** Gateway / bank fees deducted before settlement. */
    feeAmount: moneyAmount.default('0'),
    notes: optionalText(1000),
    /** Attach every completed, un-reconciled payment of the period straight away. */
    attachAll: z.boolean().default(false),
  })
  .refine((v) => new Date(v.periodEnd) > new Date(v.periodStart), { message: 'The period must end after it starts', path: ['periodEnd'] })
  .refine((v) => v.method !== 'ONLINE_GATEWAY' || !!v.gateway, { message: 'Choose the gateway', path: ['gateway'] });
export type CreateReconciliationInput = z.infer<typeof createReconciliationSchema>;
export const updateReconciliationSchema = z.object({
  statementReference: optionalText(120),
  settledAmount: moneyAmount.optional(),
  feeAmount: moneyAmount.optional(),
  notes: optionalText(1000),
});
export type UpdateReconciliationInput = z.infer<typeof updateReconciliationSchema>;
export const reconciliationPaymentsSchema = z.object({ paymentIds: z.array(uuid).min(1).max(500) });
export const closeReconciliationSchema = z.object({ notes: optionalText(1000) });
export const reconciliationListQuery = pageQuery.extend({
  status: z.enum(['OPEN', 'MATCHED', 'DISCREPANCY', 'CLOSED']).optional(),
  method: paymentMethod.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type ReconciliationListQuery = z.infer<typeof reconciliationListQuery>;

// ---------------------------------------------------------------- sandbox gateway (test adapter)
export const sandboxFailSchema = z.object({ reason: optionalText(200) });

// ---------------------------------------------------------------- cash register shifts
/** AED notes and coins a till is counted in; the key is the face value. */
export const AED_DENOMINATIONS = ['1000', '500', '200', '100', '50', '20', '10', '5', '1', '0.5', '0.25'] as const;
const denominationCounts = z.record(z.enum(AED_DENOMINATIONS), z.number().int().min(0).max(100_000));

export const openShiftSchema = z.object({
  branchId: uuid,
  /** Cash put in the drawer at the start (change float). */
  openingFloat: moneyAmount.default('0'),
  note: optionalText(300),
});
export type OpenShiftInput = z.infer<typeof openShiftSchema>;

export const closeShiftSchema = z.object({
  /** Cash counted in the drawer, float included. */
  countedCash: moneyAmount,
  /** Total of the card terminal's settlement slip; leave out when there is no terminal. */
  countedCard: moneyAmount.nullish(),
  /** The count by note / coin; when given it must add up to countedCash. */
  denominations: denominationCounts.nullish(),
  note: optionalText(500),
  version: z.number().int().min(1).optional(),
});
export type CloseShiftInput = z.infer<typeof closeShiftSchema>;

export const reviewShiftSchema = z.object({ note: optionalText(500) });
export type ReviewShiftInput = z.infer<typeof reviewShiftSchema>;

export const shiftListQuery = pageQuery.extend({
  branchId: uuid.optional(),
  status: z.enum(['OPEN', 'CLOSED', 'REVIEWED']).optional(),
  openedById: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type ShiftListQuery = z.infer<typeof shiftListQuery>;

export const dayEndQuery = z.object({ branchId: uuid.optional(), date: isoDate });
export type DayEndQuery = z.infer<typeof dayEndQuery>;

export const cashSettingsSchema = z
  .object({
    /** Refuse cash payments from staff who have no open shift. */
    requireShiftForCash: z.boolean().optional(),
    /** Differences above this (either way) are flagged to the managers. */
    cashVarianceTolerance: moneyAmount.optional(),
  })
  .refine((v) => v.requireShiftForCash !== undefined || v.cashVarianceTolerance !== undefined, 'Nothing to change');
export type CashSettingsInput = z.infer<typeof cashSettingsSchema>;

// ---------------------------------------------------------------- unpaid invoice reminders
export const invoiceReminderSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    /** Days from the due date: 0 = on the due date, 3 = three days late, -2 = two days before. */
    days: z
      .array(z.number().int().min(-14).max(90))
      .min(1, 'Choose at least one day')
      .max(8)
      .refine((d) => new Set(d).size === d.length, 'Each day can be chosen once')
      .optional(),
  })
  .refine((v) => v.enabled !== undefined || v.days !== undefined, 'Nothing to change');
export type InvoiceReminderSettingsInput = z.infer<typeof invoiceReminderSettingsSchema>;

/** Pause automatic reminders up to and including a day (null resumes them). */
export const pauseInvoiceRemindersSchema = z.object({ until: isoDate.nullable() });
export type PauseInvoiceRemindersInput = z.infer<typeof pauseInvoiceRemindersSchema>;

// ---------------------------------------------------------------- staff commission
export const commissionRuleSchema = z
  .object({
    /** Null: the default rule for every service without its own. */
    serviceId: uuid.nullable(),
    beneficiary: z.enum(['OPERATOR', 'REVIEWER', 'CREATOR']),
    kind: z.enum(['PERCENT', 'FIXED']),
    value: moneyAmount,
  })
  .refine((r) => r.kind !== 'PERCENT' || Number(r.value) <= 100, { message: 'A percentage cannot be above 100', path: ['value'] });
export type CommissionRuleInput = z.infer<typeof commissionRuleSchema>;
export const updateCommissionRuleSchema = z.object({ kind: z.enum(['PERCENT', 'FIXED']).optional(), value: moneyAmount.optional(), isActive: z.boolean().optional() });
export type UpdateCommissionRuleInput = z.infer<typeof updateCommissionRuleSchema>;

export const commissionEntryQuery = pageQuery.extend({
  membershipId: uuid.optional(),
  status: z.enum(['ACCRUED', 'PAID', 'VOID']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type CommissionEntryQuery = z.infer<typeof commissionEntryQuery>;
export const commissionSummaryQuery = z.object({ from: isoDate, to: isoDate });
export type CommissionSummaryQuery = z.infer<typeof commissionSummaryQuery>;

/** Pays out everything a person has accrued up to (and including) a day. */
export const commissionPayoutSchema = z.object({
  membershipId: uuid,
  upTo: isoDate,
  reference: trimmed(120, 1),
});
export type CommissionPayoutInput = z.infer<typeof commissionPayoutSchema>;

// ---------------------------------------------------------------- accounting
const accountCode = z.string().trim().regex(/^\d{3,6}$/, 'Use a number code of 3 to 6 digits, such as 5100');
export const ledgerAccountSchema = z.object({
  code: accountCode,
  name: trimmed(120, 1),
  nameAr: optionalText(120),
  type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']),
});
export type LedgerAccountInput = z.infer<typeof ledgerAccountSchema>;
export const updateLedgerAccountSchema = z.object({ name: trimmed(120, 1).optional(), nameAr: optionalText(120), isActive: z.boolean().optional() });
export type UpdateLedgerAccountInput = z.infer<typeof updateLedgerAccountSchema>;

/** A journal written by hand (opening balances, owner's drawings, depreciation...). Every line is either a debit or a credit. */
export const manualJournalSchema = z.object({
  date: isoDate,
  memo: trimmed(500, 1),
  lines: z
    .array(
      z
        .object({ accountId: uuid, debit: moneyAmount.optional(), credit: moneyAmount.optional(), memo: optionalText(200) })
        .refine((l) => (Number(l.debit ?? 0) > 0) !== (Number(l.credit ?? 0) > 0), { message: 'Enter either a debit or a credit on each line' }),
    )
    .min(2)
    .max(50),
});
export type ManualJournalInput = z.infer<typeof manualJournalSchema>;
export const reverseJournalSchema = z.object({ reason: trimmed(300, 1) });
export const journalQuery = pageQuery.extend({ from: isoDate.optional(), to: isoDate.optional(), accountId: uuid.optional(), sourceType: z.string().max(40).optional() });
export type JournalQuery = z.infer<typeof journalQuery>;
export const asOfQuery = z.object({ asOf: isoDate });
export const periodQuery = z.object({ from: isoDate, to: isoDate });
export const accountLedgerQuery = periodQuery.extend({ accountId: uuid });

// ---------------------------------------------------------------- customer statement
/** Statement of account of one customer for a period (defaults: the last 12 months). */
export const customerStatementQuery = z.object({ from: isoDate.optional(), to: isoDate.optional() });
export type CustomerStatementQuery = z.infer<typeof customerStatementQuery>;
