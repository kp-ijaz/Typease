import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module';
import { RequestsModule } from '../requests/requests.module';
import { PublicRenewalsController, RenewalAutopilotController } from './renewals.controller';
import { RenewalAutopilotService } from './renewal-autopilot.service';

/** Renewal autopilot: expiring documents become quoted renewal requests with a one-tap approve-and-pay link. */
@Module({
  imports: [RequestsModule, FinanceModule],
  controllers: [RenewalAutopilotController, PublicRenewalsController],
  providers: [RenewalAutopilotService],
})
export class RenewalsModule {}
