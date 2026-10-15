import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { CorporateAccountsService } from './accounts.service';
import { CorporateAccess } from './corporate-access.service';
import { CorporateAccountsController, CorporatePortalController } from './corporate.controller';
import { CorporateEmployeeLoginsService } from './employee-logins.service';
import { CorporateEmployeesService } from './employees.service';
import { CorporateMembersService } from './members.service';
import { CorporateRolesService } from './roles.service';
import { CorporateTermsService } from './terms.service';
import { CorporateErasure } from './corporate.erasure';

/** Corporate customers: accounts, authorised contacts, employee directory, agreements, contract prices and the corporate portal. */
@Module({
  imports: [CustomersModule],
  controllers: [CorporateAccountsController, CorporatePortalController],
  providers: [CorporateAccess, CorporateAccountsService, CorporateMembersService, CorporateRolesService, CorporateEmployeeLoginsService, CorporateEmployeesService, CorporateTermsService, CorporateErasure],
  exports: [CorporateAccountsService, CorporateEmployeesService],
})
export class CorporateModule {}
