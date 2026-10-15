import { CustomersImportService } from './customers-import.service';
import { Module } from '@nestjs/common';
import { ConsentsService } from './consents.service';
import { CustomersController, CustomerTagsController, OwnCustomerController } from './customers.controller';
import { CustomersService } from './customers.service';
import { DuplicatesService } from './duplicates.service';
import { MergeService } from './merge.service';
import { CustomerPortalService } from './portal.service';
import { CustomerRecordsService } from './records.service';
import { CustomersErasure } from './customers.erasure';

/** Customer profiles, duplicate detection and merging, notes, tags, contacts, consents and portal access. */
@Module({
  controllers: [CustomerTagsController, CustomersController, OwnCustomerController],
  providers: [CustomersImportService, CustomersService, DuplicatesService, MergeService, CustomerRecordsService, ConsentsService, CustomerPortalService, CustomersErasure],
  exports: [CustomersService, DuplicatesService, ConsentsService],
})
export class CustomersModule {}
