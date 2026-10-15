import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { RequestsModule } from '../requests/requests.module';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';

/** CRM leads: enquiries, follow-ups and conversion to customers and requests. */
@Module({ imports: [CustomersModule, RequestsModule], controllers: [LeadsController], providers: [LeadsService] })
export class LeadsModule {}
