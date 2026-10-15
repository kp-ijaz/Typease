import { Module } from '@nestjs/common';
import { CashierService } from './cashier.service';
import { CommissionsService } from './commissions.service';
import { CreditNotesService } from './credit-notes.service';
import { InvoiceRemindersService } from './invoice-reminders.service';
import { ExpensesService } from './expenses.service';
import { AccountingController, CashierController, CommissionsController, FinanceController, InvoiceRemindersController, InvoicesController, PaymentsController, PaymentWebhookController, QuotationsController, ReconciliationController, RefundsController } from './finance.controller';
import { FinanceCore } from './finance.core';
import { PaymentGatewayModule } from './gateways/payment-gateways';
import { IdempotencyService } from './idempotency.service';
import { InvoicesService } from './invoices.service';
import { LedgerService } from './ledger.service';
import { PaymentWebhookService } from './payment-webhook.service';
import { PaymentsService } from './payments.service';
import { FinancePdfService } from './pdf.service';
import { QuotationsService } from './quotations.service';
import { StatementsService } from './statements.service';
import { ReconciliationService } from './reconciliation.service';
import { RefundsService } from './refunds.service';
import { FinanceErasure } from './finance.erasure';

/**
 * Customer-facing finance of a typing centre: quotations, invoices, payments,
 * refunds, credit notes, expenses, pass-through liabilities and reconciliation.
 * Completely separate from SaaS subscription billing (modules/subscriptions).
 */
@Module({
  imports: [PaymentGatewayModule],
  controllers: [AccountingController, CashierController, CommissionsController, InvoiceRemindersController, QuotationsController, InvoicesController, PaymentsController, RefundsController, FinanceController, ReconciliationController, PaymentWebhookController],
  providers: [
    CashierService,
    LedgerService,
    StatementsService,
    CommissionsService,
    InvoiceRemindersService,
    FinanceCore, IdempotencyService, QuotationsService, InvoicesService, PaymentsService, PaymentWebhookService, RefundsService, CreditNotesService,
    ExpensesService, ReconciliationService, FinancePdfService, FinanceErasure,
  ],
  exports: [PaymentGatewayModule, QuotationsService, PaymentsService, FinancePdfService, LedgerService],
})
export class FinanceModule {}
