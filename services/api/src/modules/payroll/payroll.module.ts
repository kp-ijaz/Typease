import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module';
import { PayrollController } from './payroll.controller';
import { PayrollService } from './payroll.service';

/** Payroll: pay set-up, monthly runs, payslips, WPS salary file. */
@Module({ imports: [FinanceModule], controllers: [PayrollController], providers: [PayrollService] })
export class PayrollModule {}
