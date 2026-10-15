import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  branchSchema, brandingSchema, domainSchema, inviteStaffSchema, onboardingBusinessSchema, onboardingDraftSchema, roleSchema,
  staffScheduleSchema, tenantSettingsSchema, updateBranchSchema, updateRoleSchema, updateStaffSchema, updateTenantSchema,
} from '@typease/validation';
import { Permissions, TenantMember } from '../../common/auth/access';
import { SupportSessionSafe } from '../../common/auth/support-session';
import { dto } from '../../common/zod';
import { UsageService } from '../../common/usage.service';
import { BrandingService } from './branding.service';
import { OnboardingService } from './onboarding.service';
import { OrganisationService } from './organisation.service';

class UpdateTenantDto extends dto(updateTenantSchema) {}
class TenantSettingsDto extends dto(tenantSettingsSchema) {}
class DraftDto extends dto(onboardingDraftSchema) {}
class BusinessDto extends dto(onboardingBusinessSchema) {}
class BranchDto extends dto(branchSchema) {}
class UpdateBranchDto extends dto(updateBranchSchema) {}
class InviteStaffDto extends dto(inviteStaffSchema) {}
class UpdateStaffDto extends dto(updateStaffSchema) {}
class ScheduleDto extends dto(staffScheduleSchema) {}
class RoleDto extends dto(roleSchema) {}
class UpdateRoleDto extends dto(updateRoleSchema) {}
class BrandingDto extends dto(brandingSchema) {}
class DomainDto extends dto(domainSchema) {}

const upload = () => UseInterceptors(FileInterceptor('file', { limits: { fileSize: 1024 * 1024 + 1024, files: 1 } }));

@ApiTags('Tenants')
@ApiBearerAuth()
@Controller()
export class TenancyController {
  constructor(
    private readonly org: OrganisationService,
    private readonly onboarding: OnboardingService,
    private readonly usage: UsageService,
  ) {}

  @TenantMember({ kinds: ['STAFF'], allowSuspended: true })
  @SupportSessionSafe('The profile of the centre itself (name, language, time zone, currency, settings) for the frame of the staff app. No customer data.')
  @Get('tenant')
  @ApiOperation({ summary: 'The current centre' })
  tenant() {
    return this.org.getTenant();
  }
  @Permissions('settings.manage')
  @Patch('tenant')
  updateTenant(@Body() body: UpdateTenantDto) {
    return this.org.updateTenant(body as Record<string, any>);
  }
  @Permissions('settings.manage')
  @Patch('tenant/settings')
  updateSettings(@Body() body: TenantSettingsDto) {
    return this.org.updateSettings(body as Record<string, any>);
  }
  @TenantMember({ kinds: ['STAFF'], allowSuspended: true })
  @Get('tenant/usage')
  @ApiOperation({ summary: 'Plan limits and current usage' })
  async usageSummary() {
    return { plan: await this.usage.plan(), usage: await this.usage.summary() };
  }

  // ---- onboarding
  @Permissions('settings.manage')
  @Get('onboarding')
  onboardingStatus() {
    return this.onboarding.status();
  }
  @Permissions('settings.manage')
  @Put('onboarding/draft')
  saveDraft(@Body() body: DraftDto) {
    return this.onboarding.saveDraft(body.step, body.data);
  }
  @Permissions('settings.manage')
  @Put('onboarding/business')
  saveBusiness(@Body() body: BusinessDto) {
    return this.onboarding.saveBusiness(body);
  }
  @Permissions('settings.manage')
  @Post('onboarding/complete')
  @HttpCode(200)
  complete() {
    return this.onboarding.complete();
  }
}

@ApiTags('Branches')
@ApiBearerAuth()
@Controller('branches')
export class BranchesController {
  constructor(private readonly org: OrganisationService) {}

  @Permissions('branch.read')
  @Get()
  list(@Query('includeInactive') includeInactive?: string) {
    return this.org.listBranches(includeInactive === 'true');
  }
  /** Branch directory for signed-in customers and corporate users (booking, choosing where to be served). */
  @TenantMember({ kinds: ['CUSTOMER', 'CORPORATE'] })
  @SupportSessionSafe('Names, addresses and opening hours of the branches as the centre publishes them to its customers.')
  @Get('directory')
  directory() {
    return this.org.branchDirectory();
  }

  @Permissions('branch.manage')
  @Post()
  create(@Body() body: BranchDto) {
    return this.org.createBranch(body);
  }
  @Permissions('branch.manage')
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateBranchDto) {
    return this.org.updateBranch(id, body);
  }
}

@ApiTags('Users')
@ApiBearerAuth()
@Controller('staff')
export class StaffController {
  constructor(private readonly org: OrganisationService) {}

  @Permissions('staff.read', 'request.assign', 'task.manage')
  @Get()
  list(@Query('status') status?: string, @Query('branchId') branchId?: string, @Query('roleKey') roleKey?: string, @Query('q') q?: string) {
    return this.org.listStaff({ status, branchId, roleKey, q });
  }
  @Permissions('staff.read', 'request.assign')
  @Get('workload')
  workload(@Query('branchId') branchId?: string) {
    return this.org.workload(branchId);
  }
  @Permissions('staff.read')
  @Get(':id')
  one(@Param('id', ParseUUIDPipe) id: string) {
    return this.org.getStaff(id);
  }
  @Permissions('staff.manage')
  @Post('invitations')
  invite(@Body() body: InviteStaffDto) {
    return this.org.inviteStaff(body);
  }
  @Permissions('staff.manage')
  @Post(':id/resend-invitation')
  @HttpCode(200)
  resend(@Param('id', ParseUUIDPipe) id: string) {
    return this.org.resendInvitation(id);
  }
  @Permissions('staff.manage')
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateStaffDto) {
    return this.org.updateStaff(id, body);
  }
  @Permissions('staff.manage')
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.org.removeStaff(id);
  }
  @Permissions('staff.read')
  @Get(':id/schedule')
  schedule(@Param('id', ParseUUIDPipe) id: string) {
    return this.org.getSchedule(id);
  }
  @Permissions('staff.manage')
  @Put(':id/schedule')
  setSchedule(@Param('id', ParseUUIDPipe) id: string, @Body() body: ScheduleDto) {
    return this.org.setSchedule(id, body.entries);
  }
}

@ApiTags('Roles')
@ApiBearerAuth()
@Controller('roles')
export class RolesController {
  constructor(private readonly org: OrganisationService) {}

  @Permissions('staff.read', 'role.manage', 'task.manage')
  @Get()
  list() {
    return this.org.listRoles();
  }
  @Permissions('staff.read', 'role.manage')
  @Get('permissions')
  @ApiOperation({ summary: 'Permissions a role can be given; ?kind=STAFF (default), CUSTOMER or CORPORATE' })
  permissions(@Query('kind') kind?: string) {
    return this.org.permissionCatalogue(kind);
  }
  @Permissions('role.manage')
  @Post()
  @ApiOperation({ summary: 'Create a staff role (centre owner only: 403 OWNER_ONLY)' })
  create(@Body() body: RoleDto) {
    return this.org.createRole(body);
  }
  @Permissions('role.manage')
  @Patch(':id')
  @ApiOperation({ summary: 'Change any role of the centre, built-in ones included (owner only; the owner role keeps every permission: 409 PERMISSIONS_FIXED)' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateRoleDto) {
    return this.org.updateRole(id, body);
  }
  @Permissions('role.manage')
  @Delete(':id')
  @ApiOperation({ summary: 'Delete a staff role nobody holds any more, built-in ones included (owner only; people who were removed do not count; owner role: 409 ROLE_LOCKED; portal roles: 409 ROLE_REQUIRED; still held: 409 ROLE_IN_USE)' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.org.deleteRole(id);
  }
}

@ApiTags('Branding')
@ApiBearerAuth()
@Controller()
export class BrandingController {
  constructor(private readonly branding: BrandingService) {}

  @Permissions('branding.manage', 'settings.manage')
  @Get('branding')
  get() {
    return this.branding.get();
  }
  @Permissions('branding.manage')
  @Put('branding')
  update(@Body() body: BrandingDto) {
    return this.branding.update(body);
  }
  @Permissions('branding.manage')
  @Put('branding/branches/:branchId')
  @ApiOperation({ summary: 'Branch-level branding override' })
  updateBranch(@Param('branchId', ParseUUIDPipe) branchId: string, @Body() body: BrandingDto) {
    return this.branding.update(body, branchId);
  }
  @Permissions('branding.manage')
  @Post('branding/logo')
  @ApiConsumes('multipart/form-data')
  @upload()
  logo(@UploadedFile() file: Express.Multer.File) {
    return this.branding.uploadAsset('logo', file);
  }
  @Permissions('branding.manage')
  @Post('branding/favicon')
  @ApiConsumes('multipart/form-data')
  @upload()
  favicon(@UploadedFile() file: Express.Multer.File) {
    return this.branding.uploadAsset('favicon', file);
  }

  @Permissions('domain.manage')
  @Get('domains')
  domains() {
    return this.branding.listDomains();
  }
  @Permissions('domain.manage')
  @Post('domains')
  addDomain(@Body() body: DomainDto) {
    return this.branding.addDomain(body);
  }
  @Permissions('domain.manage')
  @Post('domains/:id/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Check the DNS TXT record and verify domain ownership' })
  verifyDomain(@Param('id', ParseUUIDPipe) id: string) {
    return this.branding.verifyDomain(id);
  }
  @Permissions('domain.manage')
  @Delete('domains/:id')
  removeDomain(@Param('id', ParseUUIDPipe) id: string) {
    return this.branding.removeDomain(id);
  }
}
