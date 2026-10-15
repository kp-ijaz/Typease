import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  bulkCorporateEmployeesSchema, corporateAccountListQuery, corporateAccountSchema, corporateAgreementSchema, corporateCreditDecisionSchema, corporateEmployeeListQuery,
  corporateEmployeeLoginSchema, corporateEmployeeSchema, corporateMemberSchema, corporatePriceSchema, corporateStatusReasonSchema, updateCorporateAccountSchema, updateCorporateAgreementSchema,
  corporateRoleSchema, corporateUserRoleSchema, updateCorporateEmployeeSchema, updateCorporateMemberSchema, updateCorporateRoleSchema, verifyCorporateAccountSchema,
} from '@typease/validation';
import { Permissions, TenantMember } from '../../common/auth/access';
import { dto } from '../../common/zod';
import { CorporateAccountsService } from './accounts.service';
import { CorporateEmployeeLoginsService } from './employee-logins.service';
import { CorporateEmployeesService } from './employees.service';
import { CorporateMembersService } from './members.service';
import { CorporateRolesService } from './roles.service';
import { CorporateTermsService } from './terms.service';

class AccountDto extends dto(corporateAccountSchema) {}
class UpdateAccountDto extends dto(updateCorporateAccountSchema) {}
class AccountListQueryDto extends dto(corporateAccountListQuery) {}
class VerifyDto extends dto(verifyCorporateAccountSchema) {}
class CreditDto extends dto(corporateCreditDecisionSchema) {}
class ReasonDto extends dto(corporateStatusReasonSchema) {}
class MemberDto extends dto(corporateMemberSchema) {}
class UpdateMemberDto extends dto(updateCorporateMemberSchema) {}
class EmployeeDto extends dto(corporateEmployeeSchema) {}
class BulkEmployeesDto extends dto(bulkCorporateEmployeesSchema) {}
class UpdateEmployeeDto extends dto(updateCorporateEmployeeSchema) {}
class EmployeeListQueryDto extends dto(corporateEmployeeListQuery) {}
class EmployeeLoginDto extends dto(corporateEmployeeLoginSchema) {}
class AgreementDto extends dto(corporateAgreementSchema) {}
class UpdateAgreementDto extends dto(updateCorporateAgreementSchema) {}
class PriceDto extends dto(corporatePriceSchema) {}
class CorporateRoleDto extends dto(corporateRoleSchema) {}
class UpdateCorporateRoleDto extends dto(updateCorporateRoleSchema) {}
class CorporateUserRoleDto extends dto(corporateUserRoleSchema) {}

const ID = () => Param('id', ParseUUIDPipe);
const sub = (name: string) => Param(name, ParseUUIDPipe);

/** Staff side: the centre manages its corporate customers. */
@ApiTags('Corporate accounts')
@ApiBearerAuth()
@Controller('corporate-accounts')
export class CorporateAccountsController {
  constructor(
    private readonly accounts: CorporateAccountsService,
    private readonly members: CorporateMembersService,
    private readonly employees: CorporateEmployeesService,
    private readonly logins: CorporateEmployeeLoginsService,
    private readonly terms: CorporateTermsService,
  ) {}

  // ---- accounts
  @Permissions('corporate.read')
  @Get()
  list(@Query() query: AccountListQueryDto) {
    return this.accounts.list(query);
  }
  @Permissions('corporate.manage')
  @Post()
  @ApiOperation({ summary: 'Register a company (starts as PENDING_VERIFICATION; counts against the plan limit)' })
  create(@Body() body: AccountDto) {
    return this.accounts.create(body);
  }
  @Permissions('corporate.read')
  @Get(':id')
  get(@ID() id: string) {
    return this.accounts.get(id);
  }
  @Permissions('corporate.manage')
  @Patch(':id')
  update(@ID() id: string, @Body() body: UpdateAccountDto) {
    return this.accounts.update(id, body);
  }
  @Permissions('corporate.verify')
  @Post(':id/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirm that the company and its contacts were checked' })
  verify(@ID() id: string, @Body() body: VerifyDto) {
    return this.accounts.verify(id, body.note);
  }
  @Permissions('corporate.verify')
  @Post(':id/credit')
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve or withdraw credit terms' })
  credit(@ID() id: string, @Body() body: CreditDto) {
    return this.accounts.decideCredit(id, body);
  }
  @Permissions('corporate.manage')
  @Post(':id/suspend')
  @HttpCode(200)
  suspend(@ID() id: string, @Body() body: ReasonDto) {
    return this.accounts.suspend(id, body.reason);
  }
  @Permissions('corporate.manage')
  @Post(':id/reactivate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Lift a suspension or restore an archived account' })
  reactivate(@ID() id: string) {
    return this.accounts.reactivate(id);
  }
  @Permissions('corporate.manage')
  @Post(':id/archive')
  @HttpCode(200)
  archive(@ID() id: string, @Body() body: ReasonDto) {
    return this.accounts.archive(id, body.reason);
  }

  // ---- members (authorised contacts)
  @Permissions('corporate.read')
  @Get(':id/members')
  listMembers(@ID() id: string) {
    return this.members.list(id);
  }
  @Permissions('corporate.manage')
  @Post(':id/members')
  @ApiOperation({ summary: 'Invite an authorised contact to the corporate portal (plan feature corporatePortal)' })
  inviteMember(@ID() id: string, @Body() body: MemberDto) {
    return this.members.inviteByStaff(id, body);
  }
  @Permissions('corporate.manage')
  @Patch(':id/members/:memberId')
  @ApiOperation({ summary: 'Edit, suspend or reactivate a member' })
  updateMember(@ID() id: string, @sub('memberId') memberId: string, @Body() body: UpdateMemberDto) {
    return this.members.update(id, memberId, body);
  }
  @Permissions('corporate.manage')
  @Post(':id/members/:memberId/resend-invitation')
  @HttpCode(200)
  resendInvitation(@ID() id: string, @sub('memberId') memberId: string) {
    return this.members.resend(id, memberId);
  }
  @Permissions('corporate.manage')
  @Delete(':id/members/:memberId')
  removeMember(@ID() id: string, @sub('memberId') memberId: string) {
    return this.members.remove(id, memberId);
  }

  // ---- employees
  @Permissions('corporate.read')
  @Get(':id/employees')
  listEmployees(@ID() id: string, @Query() query: EmployeeListQueryDto) {
    return this.employees.list(id, query);
  }
  @Permissions('corporate.manage')
  @Post(':id/employees')
  createEmployee(@ID() id: string, @Body() body: EmployeeDto) {
    return this.employees.create(id, body);
  }
  @Permissions('corporate.manage')
  @Post(':id/employees/bulk')
  @ApiOperation({ summary: 'Add up to 200 employees in one call' })
  createEmployees(@ID() id: string, @Body() body: BulkEmployeesDto) {
    return this.employees.createMany(id, body.employees);
  }
  @Permissions('corporate.read')
  @Get(':id/employees/:employeeId')
  getEmployee(@ID() id: string, @sub('employeeId') employeeId: string) {
    return this.employees.get(id, employeeId);
  }
  @Permissions('corporate.manage')
  @Patch(':id/employees/:employeeId')
  @ApiOperation({ summary: 'Edit an employee, or deactivate / reactivate with status' })
  updateEmployee(@ID() id: string, @sub('employeeId') employeeId: string, @Body() body: UpdateEmployeeDto) {
    return this.employees.update(id, employeeId, body);
  }

  // ---- employee logins (role corporate_employee)
  @Permissions('corporate.manage')
  @Post(':id/employees/:employeeId/login')
  @ApiOperation({ summary: 'Invite an employee to the corporate portal (sees only their own requests and documents; plan feature corporatePortal)' })
  inviteEmployeeLogin(@ID() id: string, @sub('employeeId') employeeId: string, @Body() body: EmployeeLoginDto) {
    return this.logins.invite(id, employeeId, body);
  }
  @Permissions('corporate.manage')
  @Post(':id/employees/:employeeId/login/resend-invitation')
  @HttpCode(200)
  resendEmployeeLogin(@ID() id: string, @sub('employeeId') employeeId: string) {
    return this.logins.resend(id, employeeId);
  }
  @Permissions('corporate.manage')
  @Delete(':id/employees/:employeeId/login')
  @ApiOperation({ summary: 'Withdraw a pending invitation or take away the portal access of an employee' })
  revokeEmployeeLogin(@ID() id: string, @sub('employeeId') employeeId: string) {
    return this.logins.revoke(id, employeeId);
  }

  // ---- agreements
  @Permissions('corporate.read')
  @Get(':id/agreements')
  listAgreements(@ID() id: string) {
    return this.terms.listAgreements(id);
  }
  @Permissions('corporate.manage')
  @Post(':id/agreements')
  createAgreement(@ID() id: string, @Body() body: AgreementDto) {
    return this.terms.createAgreement(id, body);
  }
  @Permissions('corporate.manage')
  @Patch(':id/agreements/:agreementId')
  updateAgreement(@ID() id: string, @sub('agreementId') agreementId: string, @Body() body: UpdateAgreementDto) {
    return this.terms.updateAgreement(id, agreementId, body);
  }
  @Permissions('corporate.manage')
  @Delete(':id/agreements/:agreementId')
  deleteAgreement(@ID() id: string, @sub('agreementId') agreementId: string) {
    return this.terms.deleteAgreement(id, agreementId);
  }

  // ---- contract prices
  @Permissions('corporate.read')
  @Get(':id/prices')
  listPrices(@ID() id: string) {
    return this.terms.listPrices(id);
  }
  @Permissions('corporate.manage')
  @Put(':id/prices')
  @ApiOperation({ summary: 'Set the contract service fee for one service (replaces an existing one)' })
  setPrice(@ID() id: string, @Body() body: PriceDto) {
    return this.terms.setPrice(id, body);
  }
  @Permissions('corporate.manage')
  @Delete(':id/prices/:priceId')
  removePrice(@ID() id: string, @sub('priceId') priceId: string) {
    return this.terms.removePrice(id, priceId);
  }
}

/**
 * Corporate portal: a company's own users. There is no company id in any path:
 * the company is always the one bound to the signed-in membership.
 */
@ApiTags('Corporate portal')
@ApiBearerAuth()
@Controller('corporate')
export class CorporatePortalController {
  constructor(
    private readonly accounts: CorporateAccountsService,
    private readonly members: CorporateMembersService,
    private readonly employees: CorporateEmployeesService,
    private readonly logins: CorporateEmployeeLoginsService,
    private readonly terms: CorporateTermsService,
    private readonly roles: CorporateRolesService,
  ) {}

  @TenantMember({ kinds: ['CORPORATE'], any: ['corp.account.read'] })
  @Get('account')
  @ApiOperation({ summary: 'My company account' })
  account() {
    return this.accounts.own();
  }

  @TenantMember({ kinds: ['CORPORATE'], any: ['corp.employees.read'] })
  @Get('employees')
  listEmployees(@Query() query: EmployeeListQueryDto) {
    return this.employees.list(null, query);
  }
  @TenantMember({ kinds: ['CORPORATE'], any: ['corp.employees.manage'] })
  @Post('employees')
  createEmployee(@Body() body: EmployeeDto) {
    return this.employees.create(null, body);
  }
  @TenantMember({ kinds: ['CORPORATE'], any: ['corp.employees.manage'] })
  @Post('employees/bulk')
  @ApiOperation({ summary: 'Upload up to 200 employees in one call' })
  createEmployees(@Body() body: BulkEmployeesDto) {
    return this.employees.createMany(null, body.employees);
  }
  @TenantMember({ kinds: ['CORPORATE'], any: ['corp.employees.read'] })
  @Get('employees/:employeeId')
  getEmployee(@sub('employeeId') employeeId: string) {
    return this.employees.get(null, employeeId);
  }
  @TenantMember({ kinds: ['CORPORATE'], any: ['corp.employees.manage'] })
  @Patch('employees/:employeeId')
  updateEmployee(@sub('employeeId') employeeId: string, @Body() body: UpdateEmployeeDto) {
    return this.employees.update(null, employeeId, body);
  }

  @TenantMember({ kinds: ['CORPORATE'], any: ['corp.employees.manage'] })
  @Post('employees/:employeeId/login')
  @ApiOperation({ summary: 'Invite one of my company\'s employees to the portal (own requests and documents only)' })
  inviteEmployeeLogin(@sub('employeeId') employeeId: string, @Body() body: EmployeeLoginDto) {
    return this.logins.invite(null, employeeId, body);
  }
  @TenantMember({ kinds: ['CORPORATE'], any: ['corp.employees.manage'] })
  @Post('employees/:employeeId/login/resend-invitation')
  @HttpCode(200)
  resendEmployeeLogin(@sub('employeeId') employeeId: string) {
    return this.logins.resend(null, employeeId);
  }
  @TenantMember({ kinds: ['CORPORATE'], any: ['corp.employees.manage'] })
  @Delete('employees/:employeeId/login')
  revokeEmployeeLogin(@sub('employeeId') employeeId: string) {
    return this.logins.revoke(null, employeeId);
  }

  @TenantMember({ kinds: ['CORPORATE'], any: ['corp.account.read'] })
  @Get('members')
  listMembers() {
    return this.members.listOwn();
  }
  @TenantMember({ kinds: ['CORPORATE'], any: ['corp.account.manage'] })
  @Post('members')
  @ApiOperation({ summary: 'Invite a colleague to the company account' })
  inviteColleague(@Body() body: MemberDto) {
    return this.members.inviteColleague(body);
  }

  // The company's roles and who holds them. Changes: the company administrator only (403 COMPANY_ADMIN_ONLY).
  @TenantMember({ kinds: ['CORPORATE'], any: ['corp.account.read'] })
  @Get('roles')
  @ApiOperation({ summary: "My company's roles (the centre defaults until the company changes one, then its own copies)" })
  listRoles() {
    return this.roles.list();
  }
  @TenantMember({ kinds: ['CORPORATE'], any: ['corp.account.read'] })
  @Get('roles/permissions')
  rolePermissions() {
    return this.roles.permissionCatalogue();
  }
  @TenantMember({ kinds: ['CORPORATE'], any: ['corp.account.manage'] })
  @Post('roles')
  createRole(@Body() body: CorporateRoleDto) {
    return this.roles.create(body);
  }
  @TenantMember({ kinds: ['CORPORATE'], any: ['corp.account.manage'] })
  @Patch('roles/:roleId')
  @ApiOperation({ summary: 'Change a role (a centre default is copied for the company first; the administrator role keeps every permission: 409 PERMISSIONS_FIXED)' })
  updateRole(@sub('roleId') roleId: string, @Body() body: UpdateCorporateRoleDto) {
    return this.roles.update(roleId, body);
  }
  @TenantMember({ kinds: ['CORPORATE'], any: ['corp.account.manage'] })
  @Delete('roles/:roleId')
  @ApiOperation({ summary: 'Delete a role the company created (built-in: 409 ROLE_REQUIRED; still held: 409 ROLE_IN_USE)' })
  deleteRole(@sub('roleId') roleId: string) {
    return this.roles.remove(roleId);
  }
  @TenantMember({ kinds: ['CORPORATE'], any: ['corp.account.read'] })
  @Get('users')
  @ApiOperation({ summary: 'Everybody with access to my company portal, with their role' })
  listUsers() {
    return this.roles.users();
  }
  @TenantMember({ kinds: ['CORPORATE'], any: ['corp.account.manage'] })
  @Put('users/:membershipId/role')
  @ApiOperation({ summary: "Change a person's role (not your own: the administrator making the change always stays one)" })
  setUserRole(@sub('membershipId') membershipId: string, @Body() body: CorporateUserRoleDto) {
    return this.roles.setUserRole(membershipId, body.roleId);
  }

  @TenantMember({ kinds: ['CORPORATE'], any: ['corp.account.read'] })
  @Get('prices')
  @ApiOperation({ summary: 'Contract prices agreed with the centre' })
  prices() {
    return this.terms.ownPrices();
  }
}
