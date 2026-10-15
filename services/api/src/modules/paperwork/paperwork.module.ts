import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module';
import { PaperworkController, PublicSigningController } from './paperwork.controller';
import { PaperworkService } from './paperwork.service';

/** Ready-made documents: templates, generated certificates and contracts, e-signature and hand-over. */
@Module({
  imports: [FinanceModule],
  controllers: [PaperworkController, PublicSigningController],
  providers: [PaperworkService],
})
export class PaperworkModule {}
