import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, RawBodyRequest, Req, Res, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  approveRefundSchema, closeReconciliationSchema, cashSettingsSchema, closeShiftSchema, dayEndQuery, invoiceReminderSettingsSchema, pauseInvoiceRemindersSchema, commissionEntryQuery, commissionPayoutSchema, commissionRuleSchema, commissionSummaryQuery, updateCommissionRuleSchema, openShiftSchema, reviewShiftSchema, shiftListQuery, completeRefundSchema, createCreditNoteSchema, createExpenseSchema, createInvoiceSchema, createQuotationSchema,
  createReconciliationSchema, creditNoteListQuery, discountApproveSchema, discountRejectSchema, expenseListQuery, feeComponentsUpdateSchema, invoiceListQuery,
  liabilityQuery, optionalReasonBody, payInvoiceSchema, paymentListQuery, quotationApproveSchema, quotationFromRequestSchema, quotationListQuery, quotationRejectSchema,
  reconciliationListQuery, reconciliationPaymentsSchema, recordPaymentSchema, refundListQuery, rejectRefundSchema, requestRefundSchema, updateExpenseSchema,
  updateInvoiceSchema, updateQuotationSchema, updateReconciliationSchema, voidInvoiceSchema,
  customerStatementQuery, accountLedgerQuery, asOfQuery, journalQuery, ledgerAccountSchema, manualJournalSchema, periodQuery, reverseJournalSchema, updateLedgerAccountSchema,
} from '@typease/validation';
import { Permissions, Public } from '../../common/auth/access';
import { RateLimit } from '../../common/rate-limit';
import { dto } from '../../common/zod';
import { CashierService } from './cashier.service';
import { CommissionsService } from './commissions.service';
import { CreditNotesService } from './credit-notes.service';
import { InvoiceRemindersService } from './invoice-reminders.service';
import { ExpensesService } from './expenses.service';
import { MoneyInterceptor } from './finance.serialise';
import { InvoicesService } from './invoices.service';
import { LedgerService } from './ledger.service';
import { PaymentWebhookService } from './payment-webhook.service';
import { PaymentsService } from './payments.service';
import { FinancePdfService, PdfFile } from './pdf.service';
import { QuotationsService } from './quotations.service';
import { ReconciliationService } from './reconciliation.service';
import { RefundsService } from './refunds.service';
import { StatementsService } from './statements.service';

class CreateQuotationDto extends dto(createQuotationSchema) {}
class QuotationFromRequestDto extends dto(quotationFromRequestSchema) {}
class UpdateQuotationDto extends dto(updateQuotationSchema) {}
class QuotationListDto extends dto(quotationListQuery) {}
class DiscountApproveDto extends dto(discountApproveSchema) {}
class DiscountRejectDto extends dto(discountRejectSchema) {}
class QuotationApproveDto extends dto(quotationApproveSchema) {}
class QuotationRejectDto extends dto(quotationRejectSchema) {}
class OptionalReasonDto extends dto(optionalReasonBody) {}
class CreateInvoiceDto extends dto(createInvoiceSchema) {}
class UpdateInvoiceDto extends dto(updateInvoiceSchema) {}
class InvoiceListDto extends dto(invoiceListQuery) {}
class VoidInvoiceDto extends dto(voidInvoiceSchema) {}
class PayInvoiceDto extends dto(payInvoiceSchema) {}
class RecordPaymentDto extends dto(recordPaymentSchema) {}
class PaymentListDto extends dto(paymentListQuery) {}
class RequestRefundDto extends dto(requestRefundSchema) {}
class ApproveRefundDto extends dto(approveRefundSchema) {}
class CompleteRefundDto extends dto(completeRefundSchema) {}
class RejectRefundDto extends dto(rejectRefundSchema) {}
class RefundListDto extends dto(refundListQuery) {}
class CreateCreditNoteDto extends dto(createCreditNoteSchema) {}
class CreditNoteListDto extends dto(creditNoteListQuery) {}
class CreateExpenseDto extends dto(createExpenseSchema) {}
class UpdateExpenseDto extends dto(updateExpenseSchema) {}
class ExpenseListDto extends dto(expenseListQuery) {}
class FeeComponentsDto extends dto(feeComponentsUpdateSchema) {}
class LiabilityQueryDto extends dto(liabilityQuery) {}
class CreateReconciliationDto extends dto(createReconciliationSchema) {}
class UpdateReconciliationDto extends dto(updateReconciliationSchema) {}
class ReconciliationPaymentsDto extends dto(reconciliationPaymentsSchema) {}
class CloseReconciliationDto extends dto(closeReconciliationSchema) {}
class ReconciliationListDto extends dto(reconciliationListQuery) {}

function sendPdf(res: Response, file: PdfFile) {
  res.status(200);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${file.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
  res.setHeader('Content-Length', String(file.content.length));
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(file.content);
}
/** Replays of an idempotent request are marked so clients and logs can tell them apart. */
function idempotent<T>(res: Response, result: { replayed: boolean; status: number; body: T }): T {
  res.status(result.status);
  if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
  return result.body;
}

// ====================================================================== quotations
@ApiTags('Quotations')
@ApiBearerAuth()
@UseInterceptors(MoneyInterceptor)
@Controller('quotations')
export class QuotationsController {
  constructor(
    private readonly quotations: QuotationsService,
    private readonly pdf: FinancePdfService,
  ) {}

  @Permissions('quotation.read', 'self.payments', 'corp.requests.read', 'corp.requests.approve', 'corp.invoices.read')
  @Get()
  @ApiOperation({ summary: 'Quotations (staff: by branch; customers: their own; corporate: their company)' })
  list(@Query() query: QuotationListDto) {
    return this.quotations.list(query);
  }
  @Permissions('quotation.manage')
  @Post()
  create(@Body() body: CreateQuotationDto) {
    return this.quotations.create(body);
  }
  @Permissions('quotation.manage')
  @Post('from-request/:requestId')
  @ApiOperation({ summary: 'Build a quotation from the request\'s service price (branch price, corporate contract price, fee estimates)' })
  fromRequest(@Param('requestId', ParseUUIDPipe) requestId: string, @Body() body: QuotationFromRequestDto) {
    return this.quotations.createFromRequest(requestId, body);
  }
  @Permissions('quotation.read', 'self.payments', 'corp.requests.read', 'corp.requests.approve', 'corp.invoices.read')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.quotations.get(id);
  }
  @Permissions('quotation.read', 'self.payments', 'corp.requests.read', 'corp.requests.approve', 'corp.invoices.read')
  @Get(':id/pdf')
  @ApiProduces('application/pdf')
  async pdfFile(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    sendPdf(res, await this.pdf.quotation(id));
  }
  @Permissions('quotation.manage')
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateQuotationDto) {
    return this.quotations.update(id, body);
  }
  @Permissions('discount.approve')
  @Post(':id/discount/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve the discount (never by the person who requested it, unless they are the only approver)' })
  approveDiscount(@Param('id', ParseUUIDPipe) id: string, @Body() body: DiscountApproveDto) {
    return this.quotations.approveDiscount(id, body.note);
  }
  @Permissions('discount.approve')
  @Post(':id/discount/reject')
  @HttpCode(200)
  rejectDiscount(@Param('id', ParseUUIDPipe) id: string, @Body() body: DiscountRejectDto) {
    return this.quotations.rejectDiscount(id, body);
  }
  @Permissions('quotation.manage')
  @Post(':id/send')
  @HttpCode(200)
  send(@Param('id', ParseUUIDPipe) id: string) {
    return this.quotations.send(id);
  }
  @Permissions('quotation.manage')
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() body: OptionalReasonDto) {
    return this.quotations.cancel(id, body.reason);
  }
  @Permissions('self.payments', 'corp.requests.approve', 'quotation.manage')
  @Post(':id/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Customer decision: approve (creates and issues the invoice). Staff must add a note.' })
  approve(@Param('id', ParseUUIDPipe) id: string, @Body() body: QuotationApproveDto) {
    return this.quotations.approve(id, body.note);
  }
  @Permissions('self.payments', 'corp.requests.approve', 'quotation.manage')
  @Post(':id/reject')
  @HttpCode(200)
  reject(@Param('id', ParseUUIDPipe) id: string, @Body() body: QuotationRejectDto) {
    return this.quotations.reject(id, body.reason);
  }
}

// ====================================================================== invoices
class StatementQueryDto extends dto(customerStatementQuery) {}

@ApiTags('Invoices')
@ApiBearerAuth()
@UseInterceptors(MoneyInterceptor)
@Controller()
export class InvoicesController {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly payments: PaymentsService,
    private readonly pdf: FinancePdfService,
    private readonly statements: StatementsService,
  ) {}

  @Permissions('invoice.read', 'self.payments', 'corp.invoices.read')
  @Get('invoices')
  list(@Query() query: InvoiceListDto) {
    return this.invoices.list(query);
  }
  @Permissions('invoice.manage')
  @Post('invoices')
  create(@Body() body: CreateInvoiceDto) {
    return this.invoices.create(body);
  }
  @Permissions('invoice.read', 'self.payments', 'corp.invoices.read')
  @Get('invoices/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.get(id);
  }
  @Permissions('invoice.read', 'self.payments', 'corp.invoices.read')
  @Get('invoices/:id/pdf')
  @ApiProduces('application/pdf')
  async pdfFile(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    sendPdf(res, await this.pdf.invoice(id));
  }
  @Permissions('invoice.manage')
  @Patch('invoices/:id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateInvoiceDto) {
    return this.invoices.update(id, body);
  }
  @Permissions('invoice.manage')
  @Post('invoices/:id/issue')
  @HttpCode(200)
  issue(@Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.issue(id);
  }
  @Permissions('invoice.manage')
  @Post('invoices/:id/void')
  @HttpCode(200)
  void(@Param('id', ParseUUIDPipe) id: string, @Body() body: VoidInvoiceDto) {
    return this.invoices.void(id, body.reason);
  }
  @Permissions('self.payments', 'corp.invoices.read', 'payment.record')
  @Post('invoices/:id/pay')
  @ApiOperation({ summary: 'Start an online payment (hosted checkout). Staff use it to create a payment link.' })
  pay(@Param('id', ParseUUIDPipe) id: string, @Body() body: PayInvoiceDto) {
    return this.payments.startOnline(id, body);
  }

  // ---- corporate portal
  @Permissions('corp.invoices.read')
  @Get('corporate/invoices')
  @ApiOperation({ summary: 'Invoices of the signed-in corporate user\'s own company' })
  corporateInvoices(@Query() query: InvoiceListDto) {
    return this.invoices.list(query);
  }
  @Permissions('corp.invoices.read')
  @Get('corporate/invoices/statement')
  corporateStatement() {
    return this.invoices.statement();
  }
  @Permissions('payment.read', 'report.financial')
  @Get('customers/:id/statement')
  @ApiOperation({ summary: 'Statement of account of an individual customer: movements with a running balance, and ageing' })
  customerStatement(@Param('id', ParseUUIDPipe) id: string, @Query() query: StatementQueryDto) {
    return this.statements.customerStatement(id, query);
  }
  @Permissions('payment.read', 'report.financial')
  @Get('customers/:id/statement/pdf')
  @ApiProduces('application/pdf')
  async customerStatementPdf(@Param('id', ParseUUIDPipe) id: string, @Query() query: StatementQueryDto, @Res() res: Response) {
    sendPdf(res, await this.pdf.customerStatement(id, query));
  }
  @Permissions('self.payments')
  @Get('statement')
  @ApiOperation({ summary: 'The signed-in customer\'s own statement of account' })
  myStatement(@Query() query: StatementQueryDto) {
    return this.statements.customerStatement(null, query);
  }
  @Permissions('self.payments')
  @Get('statement/pdf')
  @ApiProduces('application/pdf')
  async myStatementPdf(@Query() query: StatementQueryDto, @Res() res: Response) {
    sendPdf(res, await this.pdf.customerStatement(null, query));
  }
  @Permissions('invoice.read', 'report.financial')
  @Get('finance/corporate-accounts/:id/statement')
  @ApiOperation({ summary: 'Open invoices and ageing (current, 1-30, 31-60, 61-90, 90+) of one corporate account' })
  statement(@Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.statement(id);
  }
}

// ====================================================================== payments
@ApiTags('Payments')
@ApiBearerAuth()
@UseInterceptors(MoneyInterceptor)
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly pdf: FinancePdfService,
  ) {}

  @Permissions('payment.read', 'self.payments', 'corp.invoices.read')
  @Get()
  list(@Query() query: PaymentListDto) {
    return this.payments.list(query);
  }
  @Permissions('payment.record')
  @Post()
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'Unique per attempt; a retry with the same key and body returns the first result.' })
  @ApiOperation({ summary: 'Record a cash / card-machine / bank-transfer / cheque payment' })
  async record(@Body() body: RecordPaymentDto, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Response) {
    return idempotent(res, await this.payments.record(body, key));
  }
  @Permissions('payment.read', 'self.payments', 'corp.invoices.read')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.payments.get(id);
  }
  @Permissions('payment.read', 'payment.record', 'self.payments', 'corp.invoices.read')
  @Get(':id/receipt/pdf')
  @ApiProduces('application/pdf')
  async receipt(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    sendPdf(res, await this.pdf.receipt(id));
  }
}

// ====================================================================== refunds
@ApiTags('Refunds')
@ApiBearerAuth()
@UseInterceptors(MoneyInterceptor)
@Controller('refunds')
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Permissions('refund.request', 'refund.approve')
  @Get()
  list(@Query() query: RefundListDto) {
    return this.refunds.list(query);
  }
  @Permissions('refund.request')
  @Post()
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async request(@Body() body: RequestRefundDto, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Response) {
    return idempotent(res, await this.refunds.request(body, key));
  }
  @Permissions('refund.request', 'refund.approve')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.refunds.get(id);
  }
  @Permissions('refund.approve')
  @Post(':id/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve a refund (never the requester). Gateway payments are refunded at the gateway straight away.' })
  approve(@Param('id', ParseUUIDPipe) id: string, @Body() body: ApproveRefundDto) {
    return this.refunds.approve(id, body);
  }
  @Permissions('refund.approve')
  @Post(':id/reject')
  @HttpCode(200)
  reject(@Param('id', ParseUUIDPipe) id: string, @Body() body: RejectRefundDto) {
    return this.refunds.reject(id, body.reason);
  }
  @Permissions('refund.approve')
  @Post(':id/complete')
  @HttpCode(200)
  @ApiOperation({ summary: 'Manual pay-out done: complete an approved refund with its reference' })
  complete(@Param('id', ParseUUIDPipe) id: string, @Body() body: CompleteRefundDto) {
    return this.refunds.complete(id, body.reference);
  }
  @Permissions('refund.approve')
  @Post(':id/process')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send (or re-check) an approved gateway refund' })
  process(@Param('id', ParseUUIDPipe) id: string) {
    return this.refunds.process(id);
  }
}

// ====================================================================== credit notes, expenses, liabilities, settings
@ApiTags('Finance')
@ApiBearerAuth()
@UseInterceptors(MoneyInterceptor)
@Controller()
export class FinanceController {
  constructor(
    private readonly creditNotes: CreditNotesService,
    private readonly expenses: ExpensesService,
    private readonly pdf: FinancePdfService,
  ) {}

  @Permissions('finance.settings', 'report.financial', 'payment.reconcile')
  @Get('finance/fee-components')
  @ApiOperation({ summary: 'Accounting treatment of service, government and third-party fees' })
  feeComponents() {
    return this.expenses.feeComponents();
  }
  @Permissions('finance.settings')
  @Put('finance/fee-components')
  updateFeeComponents(@Body() body: FeeComponentsDto) {
    return this.expenses.updateFeeComponents(body);
  }
  @Permissions('report.financial', 'payment.reconcile')
  @Get('finance/liabilities')
  @ApiOperation({ summary: 'Pass-through money still held: per component and per request' })
  liabilities(@Query() query: LiabilityQueryDto) {
    return this.expenses.liabilities(query);
  }

  @Permissions('creditnote.manage', 'invoice.read', 'self.payments', 'corp.invoices.read')
  @Get('credit-notes')
  listCreditNotes(@Query() query: CreditNoteListDto) {
    return this.creditNotes.list(query);
  }
  @Permissions('creditnote.manage')
  @Post('credit-notes')
  createCreditNote(@Body() body: CreateCreditNoteDto) {
    return this.creditNotes.create(body);
  }
  @Permissions('creditnote.manage', 'invoice.read', 'self.payments', 'corp.invoices.read')
  @Get('credit-notes/:id')
  getCreditNote(@Param('id', ParseUUIDPipe) id: string) {
    return this.creditNotes.get(id);
  }
  @Permissions('creditnote.manage', 'invoice.read', 'self.payments', 'corp.invoices.read')
  @Get('credit-notes/:id/pdf')
  @ApiProduces('application/pdf')
  async creditNotePdf(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    sendPdf(res, await this.pdf.creditNote(id));
  }

  @Permissions('expense.manage')
  @Get('expenses')
  listExpenses(@Query() query: ExpenseListDto) {
    return this.expenses.list(query);
  }
  @Permissions('expense.manage')
  @Post('expenses')
  createExpense(@Body() body: CreateExpenseDto) {
    return this.expenses.create(body);
  }
  @Permissions('expense.manage')
  @Get('expenses/:id')
  getExpense(@Param('id', ParseUUIDPipe) id: string) {
    return this.expenses.get(id);
  }
  @Permissions('expense.manage')
  @Patch('expenses/:id')
  updateExpense(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateExpenseDto) {
    return this.expenses.update(id, body);
  }
  @Permissions('expense.manage')
  @Delete('expenses/:id')
  removeExpense(@Param('id', ParseUUIDPipe) id: string) {
    return this.expenses.remove(id);
  }
}

// ====================================================================== reconciliation
@ApiTags('Reconciliation')
@ApiBearerAuth()
@UseInterceptors(MoneyInterceptor)
@Controller('reconciliations')
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Permissions('payment.reconcile')
  @Get()
  list(@Query() query: ReconciliationListDto) {
    return this.reconciliation.list(query);
  }
  @Permissions('payment.reconcile')
  @Post()
  create(@Body() body: CreateReconciliationDto) {
    return this.reconciliation.create(body);
  }
  @Permissions('payment.reconcile')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.reconciliation.get(id);
  }
  @Permissions('payment.reconcile')
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateReconciliationDto) {
    return this.reconciliation.update(id, body);
  }
  @Permissions('payment.reconcile')
  @Post(':id/payments')
  @HttpCode(200)
  @ApiOperation({ summary: 'Attach payments covered by the statement' })
  attach(@Param('id', ParseUUIDPipe) id: string, @Body() body: ReconciliationPaymentsDto) {
    return this.reconciliation.attach(id, body.paymentIds);
  }
  @Permissions('payment.reconcile')
  @Post(':id/payments/remove')
  @HttpCode(200)
  detach(@Param('id', ParseUUIDPipe) id: string, @Body() body: ReconciliationPaymentsDto) {
    return this.reconciliation.detach(id, body.paymentIds);
  }
  @Permissions('payment.reconcile')
  @Post(':id/close')
  @HttpCode(200)
  close(@Param('id', ParseUUIDPipe) id: string, @Body() body: CloseReconciliationDto) {
    return this.reconciliation.close(id, body.notes);
  }
}

// ====================================================================== gateway webhooks (customer payments)
@ApiTags('Public')
@Controller('public/webhooks/payments')
export class PaymentWebhookController {
  constructor(private readonly webhooks: PaymentWebhookService) {}

  @Public()
  @RateLimit({ name: 'payment-webhook', limit: 300, windowSeconds: 60 })
  @Post(':gateway')
  @HttpCode(200)
  @ApiOperation({ summary: 'Payment gateway webhook: signature-verified over the raw body, idempotent, replay resistant' })
  receive(@Param('gateway') gateway: string, @Req() req: RawBodyRequest<Request>) {
    return this.webhooks.handle(gateway, req.rawBody, req.headers);
  }
}

// ====================================================================== cash register shifts
class OpenShiftDto extends dto(openShiftSchema) {}
class CloseShiftDto extends dto(closeShiftSchema) {}
class ReviewShiftDto extends dto(reviewShiftSchema) {}
class ShiftListDto extends dto(shiftListQuery) {}
class DayEndDto extends dto(dayEndQuery) {}
class CashSettingsDto extends dto(cashSettingsSchema) {}

@ApiTags('Cash register')
@ApiBearerAuth()
@Controller('cash')
export class CashierController {
  constructor(private readonly cashier: CashierService) {}

  @Permissions('cash.shift', 'cash.manage')
  @Get('shifts/current')
  @ApiOperation({ summary: 'My open shift with the live expected cash (null when none is open)' })
  current() {
    return this.cashier.current();
  }
  @Permissions('cash.shift', 'cash.manage')
  @Post('shifts')
  @ApiOperation({ summary: 'Open my cash register shift with an opening float' })
  open(@Body() body: OpenShiftDto) {
    return this.cashier.open(body);
  }
  @Permissions('cash.shift', 'cash.manage')
  @Get('shifts')
  @ApiOperation({ summary: 'Shifts: my own, or every shift of my branches with cash.manage' })
  list(@Query() query: ShiftListDto) {
    return this.cashier.list(query);
  }
  @Permissions('cash.shift', 'cash.manage')
  @Get('shifts/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.cashier.get(id);
  }
  @Permissions('cash.shift', 'cash.manage')
  @Post('shifts/:id/close')
  @HttpCode(200)
  @ApiOperation({ summary: 'Close a shift with the counted cash (and card settlement); the difference is recorded and flagged above the tolerance' })
  close(@Param('id', ParseUUIDPipe) id: string, @Body() body: CloseShiftDto) {
    return this.cashier.close(id, body);
  }
  @Permissions('cash.manage')
  @Post('shifts/:id/review')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign off a closed shift (never by the cashier)' })
  review(@Param('id', ParseUUIDPipe) id: string, @Body() body: ReviewShiftDto) {
    return this.cashier.review(id, body);
  }
  @Permissions('cash.shift', 'cash.manage', 'finance.settings')
  @Get('settings')
  settings() {
    return this.cashier.settings();
  }
  @Permissions('finance.settings')
  @Put('settings')
  @ApiOperation({ summary: 'Whether cash needs an open shift, and the difference that is flagged to managers' })
  updateSettings(@Body() body: CashSettingsDto) {
    return this.cashier.updateSettings(body);
  }
  @Permissions('cash.manage')
  @Get('day-end')
  @ApiOperation({ summary: 'Day-end closing of one local day: collections by method, shifts, differences, refunds and expenses' })
  dayEnd(@Query() query: DayEndDto) {
    return this.cashier.dayEnd(query);
  }
}

// ====================================================================== unpaid invoice reminders
class ReminderSettingsDto extends dto(invoiceReminderSettingsSchema) {}
class PauseRemindersDto extends dto(pauseInvoiceRemindersSchema) {}

@ApiTags('Invoices')
@ApiBearerAuth()
@Controller()
export class InvoiceRemindersController {
  constructor(private readonly reminders: InvoiceRemindersService) {}

  @Permissions('finance.settings', 'invoice.manage')
  @Get('finance/invoice-reminders')
  @ApiOperation({ summary: 'Automatic payment reminders: on or off, and on which days relative to the due date' })
  settings() {
    return this.reminders.settings();
  }
  @Permissions('finance.settings')
  @Put('finance/invoice-reminders')
  updateSettings(@Body() body: ReminderSettingsDto) {
    return this.reminders.updateSettings(body);
  }
  @Permissions('invoice.read')
  @Get('invoices/:id/reminders')
  @ApiOperation({ summary: 'Reminders sent for an invoice, the next one planned and any pause' })
  history(@Param('id', ParseUUIDPipe) id: string) {
    return this.reminders.history(id);
  }
  @Permissions('invoice.manage', 'payment.record')
  @Post('invoices/:id/reminders')
  @ApiOperation({ summary: 'Send a payment reminder now (by the customer\'s notification channels, with the payment link)' })
  sendNow(@Param('id', ParseUUIDPipe) id: string) {
    return this.reminders.sendNow(id);
  }
  @Permissions('invoice.manage', 'payment.record')
  @Put('invoices/:id/reminders/pause')
  @ApiOperation({ summary: 'Pause automatic reminders up to a day (a promise to pay), or resume them with null' })
  pause(@Param('id', ParseUUIDPipe) id: string, @Body() body: PauseRemindersDto) {
    return this.reminders.pause(id, body);
  }
}

// ====================================================================== staff commission
class CommissionRuleDto extends dto(commissionRuleSchema) {}
class UpdateCommissionRuleDto extends dto(updateCommissionRuleSchema) {}
class CommissionEntryDto extends dto(commissionEntryQuery) {}
class CommissionSummaryDto extends dto(commissionSummaryQuery) {}
class CommissionPayoutDto extends dto(commissionPayoutSchema) {}

@ApiTags('Commission')
@ApiBearerAuth()
@Controller('commissions')
export class CommissionsController {
  constructor(private readonly commissions: CommissionsService) {}

  @Permissions('commission.manage')
  @Get('rules')
  rules() {
    return this.commissions.rules();
  }
  @Permissions('commission.manage')
  @Post('rules')
  @ApiOperation({ summary: 'Commission for a service (or the default for all services): percentage of the service fee or a fixed amount' })
  createRule(@Body() body: CommissionRuleDto) {
    return this.commissions.createRule(body);
  }
  @Permissions('commission.manage')
  @Patch('rules/:id')
  updateRule(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateCommissionRuleDto) {
    return this.commissions.updateRule(id, body);
  }
  @Permissions('commission.view_own', 'commission.manage')
  @Get('entries')
  @ApiOperation({ summary: 'Commission entries: own, or everybody\'s with commission.manage' })
  entries(@Query() query: CommissionEntryDto) {
    return this.commissions.entries(query);
  }
  @Permissions('commission.manage')
  @Get('summary')
  @ApiOperation({ summary: 'Per staff member for a period: earned, still to pay and paid' })
  summary(@Query() query: CommissionSummaryDto) {
    return this.commissions.summary(query);
  }
  @Permissions('commission.manage')
  @Post('payouts')
  @ApiOperation({ summary: 'Mark everything a person accrued up to a day as paid, with the payout reference' })
  payout(@Body() body: CommissionPayoutDto) {
    return this.commissions.payout(body);
  }
}

// ====================================================================== accounting
class LedgerAccountDto extends dto(ledgerAccountSchema) {}
class UpdateLedgerAccountDto extends dto(updateLedgerAccountSchema) {}
class ManualJournalDto extends dto(manualJournalSchema) {}
class ReverseJournalDto extends dto(reverseJournalSchema) {}
class JournalQueryDto extends dto(journalQuery) {}
class AsOfDto extends dto(asOfQuery) {}
class PeriodDto extends dto(periodQuery) {}
class AccountLedgerDto extends dto(accountLedgerQuery) {}

@ApiTags('Accounting')
@ApiBearerAuth()
@Controller('accounting')
export class AccountingController {
  constructor(private readonly ledger: LedgerService) {}

  @Permissions('accounting.read')
  @Get('accounts')
  @ApiOperation({ summary: 'Chart of accounts with balances (optionally as of a day)' })
  accounts(@Query('asOf') asOf?: string) {
    return this.ledger.accounts(asOf && /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? asOf : undefined);
  }
  @Permissions('accounting.manage')
  @Post('accounts')
  createAccount(@Body() body: LedgerAccountDto) {
    return this.ledger.createAccount(body);
  }
  @Permissions('accounting.manage')
  @Patch('accounts/:id')
  updateAccount(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateLedgerAccountDto) {
    return this.ledger.updateAccount(id, body);
  }
  @Permissions('accounting.read')
  @Get('journal')
  journal(@Query() query: JournalQueryDto) {
    return this.ledger.journal(query);
  }
  @Permissions('accounting.manage')
  @Post('journal')
  @ApiOperation({ summary: 'Post a manual journal; debits must equal credits' })
  manualJournal(@Body() body: ManualJournalDto) {
    return this.ledger.manualJournal(body);
  }
  @Permissions('accounting.manage')
  @Post('journal/:id/reverse')
  @HttpCode(200)
  reverse(@Param('id', ParseUUIDPipe) id: string, @Body() body: ReverseJournalDto) {
    return this.ledger.reverseManual(id, body.reason);
  }
  @Permissions('accounting.manage')
  @Post('rebuild')
  @HttpCode(200)
  @ApiOperation({ summary: 'Post every document that has no journal yet, with its original date. Safe to repeat.' })
  rebuild() {
    return this.ledger.buildFromHistory();
  }
  @Permissions('accounting.read')
  @Get('reports/trial-balance')
  trialBalance(@Query() q: AsOfDto) {
    return this.ledger.trialBalance(q.asOf);
  }
  @Permissions('accounting.read')
  @Get('reports/profit-and-loss')
  profitAndLoss(@Query() q: PeriodDto) {
    return this.ledger.profitAndLoss(q.from, q.to);
  }
  @Permissions('accounting.read')
  @Get('reports/balance-sheet')
  balanceSheet(@Query() q: AsOfDto) {
    return this.ledger.balanceSheet(q.asOf);
  }
  @Permissions('accounting.read')
  @Get('reports/ledger')
  accountLedger(@Query() q: AccountLedgerDto) {
    return this.ledger.accountLedger(q.accountId, q.from, q.to);
  }
  @Permissions('accounting.read')
  @Get('reports/vat')
  vat(@Query() q: PeriodDto) {
    return this.ledger.vatReport(q.from, q.to);
  }
}
