import { Body, Controller, Delete, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import {
  accessNoteSchema, approveAccessSchema, createPlatformStaffSchema, failedPaymentsQuery, featureFlagKey, featureFlagSchema, offboardTenantSchema, platformAccessGrantQuery,
  platformAuditQuery, platformCreateTenantSchema, platformDomainQuery, platformPeriodQuery, platformSettingSchema, platformStaffQuery, platformTenantListQuery, requestAccessSchema, securityEventQuery,
  tenantAccessGrantQuery, tenantDecisionSchema, tenantGrowthQuery, tenantReasonSchema, updatePlatformStaffSchema,
} from '@typease/validation';
import { Internal, Permissions, Platform, TenantMember } from '../../common/auth/access';
import { SupportSessionSafe } from '../../common/auth/support-session';
import { dto } from '../../common/zod';
import { BrandingService } from '../tenancy/branding.service';
import { AccessGrantsService } from './access-grants.service';
import { PlatformDashboardService } from './dashboard.service';
import { FeatureFlagAdminService, FeatureFlags } from './feature-flags.service';
import { PlatformMetricsService } from './metrics.service';
import { OffboardingService } from './offboarding.service';
import { PlatformAuditService } from './platform-audit.service';
import { PlatformSettingsService } from './settings.service';
import { PlatformStaffService } from './staff.service';
import { SupportAccessService } from './support-access.service';
import { SystemHealthService } from './health.service';
import { SystemProvidersService } from './system-providers.service';
import { PlatformTenantsService } from './tenants.service';

class PeriodDto extends dto(platformPeriodQuery) {}
class GrowthDto extends dto(tenantGrowthQuery) {}
class FailedPaymentsDto extends dto(failedPaymentsQuery) {}
class TenantListDto extends dto(platformTenantListQuery) {}
class CreateTenantDto extends dto(platformCreateTenantSchema) {}
class DecisionDto extends dto(tenantDecisionSchema) {}
class ReasonDto extends dto(tenantReasonSchema) {}
class DomainQueryDto extends dto(platformDomainQuery) {}
class OffboardDto extends dto(offboardTenantSchema) {}
class RequestAccessDto extends dto(requestAccessSchema) {}
class PlatformGrantQueryDto extends dto(platformAccessGrantQuery) {}
class TenantGrantQueryDto extends dto(tenantAccessGrantQuery) {}
class ApproveAccessDto extends dto(approveAccessSchema) {}
class AccessNoteDto extends dto(accessNoteSchema) {}
class FlagDto extends dto(featureFlagSchema) {}
class SettingDto extends dto(platformSettingSchema) {}
class StaffQueryDto extends dto(platformStaffQuery) {}
class CreateStaffDto extends dto(createPlatformStaffSchema) {}
class UpdateStaffDto extends dto(updatePlatformStaffSchema) {}
class PlatformAuditQueryDto extends dto(platformAuditQuery) {}
class SecurityEventQueryDto extends dto(securityEventQuery) {}

/** A malformed key is a 400 (the global filter turns the Zod error into VALIDATION_FAILED). */
const flagKey = (raw: string) => featureFlagKey.parse(raw);

// ====================================================================== dashboard + reports
@ApiTags('Platform')
@ApiBearerAuth()
@Controller('platform')
export class PlatformDashboardController {
  constructor(private readonly dashboard: PlatformDashboardService) {}

  @Platform('platform.metrics.read')
  @Get('dashboard')
  @ApiOperation({ summary: 'Tenants, MRR / ARR, churn, failed payments, usage, support tickets and system health' })
  overview(@Query() query: PeriodDto) {
    return this.dashboard.dashboard(query);
  }
  @Platform('platform.metrics.read')
  @Get('reports/tenant-growth')
  tenantGrowth(@Query() query: GrowthDto) {
    return this.dashboard.tenantGrowth(query);
  }
  @Platform('platform.metrics.read')
  @Get('reports/subscription-revenue')
  subscriptionRevenue(@Query() query: PeriodDto) {
    return this.dashboard.subscriptionRevenue(query);
  }
  @Platform('platform.metrics.read')
  @Get('reports/plan-distribution')
  planDistribution(@Query() query: PeriodDto) {
    return this.dashboard.planDistribution(query);
  }
  @Platform('platform.metrics.read')
  @Get('reports/churn')
  churn(@Query() query: PeriodDto) {
    return this.dashboard.churnSeries(query);
  }
  @Platform('platform.metrics.read')
  @Get('reports/usage')
  usage(@Query() query: PeriodDto) {
    return this.dashboard.usage(query);
  }
  @Platform('platform.metrics.read')
  @Get('reports/failed-payments')
  failedPayments(@Query() query: FailedPaymentsDto) {
    return this.dashboard.failedPayments(query);
  }
}

// ====================================================================== system status
/** What the installation runs on and what it is configured to use. Read-only; no secret is ever returned. */
@ApiTags('Platform')
@ApiBearerAuth()
@Controller('platform/system')
export class PlatformSystemController {
  constructor(
    private readonly providers: SystemProvidersService,
    private readonly health: SystemHealthService,
  ) {}

  @Platform('platform.metrics.read')
  @Get('providers')
  @ApiOperation({ summary: 'Mail, SMS, WhatsApp, push, storage, scanner, OCR, payments, webhooks: which driver is configured, and whether it can work' })
  list() {
    return this.providers.providers();
  }

  @Platform('platform.metrics.read')
  @Get('health')
  @ApiOperation({ summary: 'Databases, Redis, object storage, job queue figures, worker heartbeat and outbox (the systemHealth block of the dashboard on its own)' })
  status() {
    return this.health.health();
  }
}

// ====================================================================== tenants
@ApiTags('Platform')
@ApiBearerAuth()
@Controller('platform/tenants')
export class PlatformTenantsController {
  constructor(
    private readonly tenants: PlatformTenantsService,
    private readonly offboarding: OffboardingService,
    private readonly grants: AccessGrantsService,
    private readonly flags: FeatureFlagAdminService,
  ) {}

  @Platform('platform.tenants.read')
  @Get()
  list(@Query() query: TenantListDto) {
    return this.tenants.list(query);
  }
  @Platform('platform.tenants.manage')
  @Post()
  @ApiOperation({ summary: 'Set up a centre on behalf of a customer; the owner receives an invitation' })
  create(@Body() body: CreateTenantDto) {
    return this.tenants.create(body);
  }
  @Platform('platform.tenants.read')
  @Get(':id')
  @ApiOperation({ summary: 'Centre profile, owner contacts, subscription, usage and onboarding progress (no customer data)' })
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.tenants.detail(id);
  }
  @Platform('platform.tenants.manage')
  @Post(':id/owner-invitation')
  @HttpCode(200)
  resendInvitation(@Param('id', ParseUUIDPipe) id: string) {
    return this.tenants.resendOwnerInvitation(id);
  }
  @Platform('platform.tenants.manage')
  @Post(':id/approve')
  @HttpCode(200)
  approve(@Param('id', ParseUUIDPipe) id: string, @Body() body: DecisionDto) {
    return this.tenants.approve(id, body.note);
  }
  @Platform('platform.tenants.manage')
  @Post(':id/reject')
  @HttpCode(200)
  reject(@Param('id', ParseUUIDPipe) id: string, @Body() body: ReasonDto) {
    return this.tenants.reject(id, body.reason);
  }
  @Platform('platform.tenants.manage')
  @Post(':id/suspend')
  @HttpCode(200)
  suspend(@Param('id', ParseUUIDPipe) id: string, @Body() body: ReasonDto) {
    return this.tenants.suspend(id, body.reason);
  }
  @Platform('platform.tenants.manage')
  @Post(':id/reactivate')
  @HttpCode(200)
  reactivate(@Param('id', ParseUUIDPipe) id: string, @Body() body: DecisionDto) {
    return this.tenants.reactivate(id, body.note);
  }
  @Platform('platform.tenants.manage')
  @Post(':id/archive')
  @HttpCode(200)
  archive(@Param('id', ParseUUIDPipe) id: string, @Body() body: ReasonDto) {
    return this.tenants.archive(id, body.reason);
  }
  @Platform('platform.tenants.manage')
  @Post(':id/offboard')
  @HttpCode(200)
  @ApiOperation({ summary: 'Super Admin only: archive the centre and schedule the permanent deletion of its data' })
  offboard(@Param('id', ParseUUIDPipe) id: string, @Body() body: OffboardDto) {
    return this.offboarding.offboard(id, body);
  }
  @Platform('platform.tenants.manage')
  @Post(':id/cancel-offboarding')
  @HttpCode(200)
  cancelOffboarding(@Param('id', ParseUUIDPipe) id: string, @Body() body: ReasonDto) {
    return this.offboarding.cancel(id, body.reason);
  }

  // ---- support access: ask this centre for time-limited access
  @Platform('platform.access.request')
  @Post(':id/access-grants')
  @ApiOperation({ summary: 'Ask the centre for time-limited, read-only support access' })
  requestAccess(@Param('id', ParseUUIDPipe) id: string, @Body() body: RequestAccessDto) {
    return this.grants.request(id, body);
  }

  // ---- feature flags of one centre
  @Platform('platform.features.manage')
  @Get(':id/feature-flags')
  centreFlags(@Param('id', ParseUUIDPipe) id: string) {
    return this.flags.forCentre(id);
  }
  @Platform('platform.features.manage')
  @Put(':id/feature-flags/:key')
  setOverride(@Param('id', ParseUUIDPipe) id: string, @Param('key') key: string, @Body() body: FlagDto) {
    return this.flags.setOverride(id, flagKey(key), body);
  }
  @Platform('platform.features.manage')
  @Delete(':id/feature-flags/:key')
  clearOverride(@Param('id', ParseUUIDPipe) id: string, @Param('key') key: string) {
    return this.flags.clearOverride(id, flagKey(key));
  }
}

// ====================================================================== support access (platform side)
@ApiTags('Platform')
@ApiBearerAuth()
@Controller('platform/access-grants')
export class PlatformAccessController {
  constructor(private readonly grants: AccessGrantsService) {}

  @Platform('platform.access.request')
  @Get()
  list(@Query() query: PlatformGrantQueryDto) {
    return this.grants.list(query);
  }
  @Platform('platform.access.request')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.grants.get(id);
  }
  @Platform('platform.access.request')
  @Post(':id/enter')
  @HttpCode(200)
  @ApiOperation({ summary: 'Open a support session in the centre (only the requester, only while approved and unexpired)' })
  enter(@Param('id', ParseUUIDPipe) id: string) {
    return this.grants.enter(id);
  }
  @Platform('platform.access.request')
  @Post(':id/revoke')
  @HttpCode(200)
  revoke(@Param('id', ParseUUIDPipe) id: string) {
    return this.grants.revoke(id);
  }
}

// ====================================================================== custom domains of all centres
@ApiTags('Platform')
@ApiBearerAuth()
@Controller('platform/domains')
export class PlatformDomainsController {
  constructor(private readonly branding: BrandingService) {}

  @Platform('platform.tenants.read')
  @Get()
  @ApiOperation({ summary: 'Custom-domain claims of all centres (find who holds a domain)' })
  list(@Query() query: DomainQueryDto) {
    return this.branding.listDomainsForPlatform(query);
  }
  @Platform('platform.tenants.manage')
  @Delete(':id')
  @ApiOperation({ summary: 'Release a domain claim of any centre, verified or not. Needs a reason; audited on the platform trail and on the centre\'s trail.' })
  release(@Param('id', ParseUUIDPipe) id: string, @Body() body: ReasonDto) {
    return this.branding.releaseByPlatform(id, body.reason);
  }
}

// ====================================================================== support access (the centre decides)
@ApiTags('Support access')
@ApiBearerAuth()
@Controller('support-access')
export class SupportAccessController {
  constructor(private readonly access: SupportAccessService) {}

  @Permissions('support_access.decide')
  @Get()
  @ApiOperation({ summary: 'Requests of TypEase support to access this centre: pending and past' })
  list(@Query() query: TenantGrantQueryDto) {
    return this.access.list(query);
  }
  @Permissions('support_access.decide')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.access.get(id);
  }
  @Permissions('support_access.decide')
  @Post(':id/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve: the clock starts now' })
  approve(@Param('id', ParseUUIDPipe) id: string, @Body() body: ApproveAccessDto) {
    return this.access.approve(id, body);
  }
  @Permissions('support_access.decide')
  @Post(':id/deny')
  @HttpCode(200)
  deny(@Param('id', ParseUUIDPipe) id: string, @Body() body: AccessNoteDto) {
    return this.access.deny(id, body.note);
  }
  @Permissions('support_access.decide')
  @Post(':id/revoke')
  @HttpCode(200)
  @ApiOperation({ summary: 'End the access at any time; it stops working immediately' })
  revoke(@Param('id', ParseUUIDPipe) id: string, @Body() body: AccessNoteDto) {
    return this.access.revoke(id, body.note);
  }
}

// ====================================================================== feature flags + settings
@ApiTags('Platform')
@ApiBearerAuth()
@Controller('platform/feature-flags')
export class PlatformFeatureFlagsController {
  constructor(private readonly flags: FeatureFlagAdminService) {}

  @Platform('platform.features.manage')
  @Get()
  list() {
    return this.flags.list();
  }
  @Platform('platform.features.manage')
  @Put(':key')
  @ApiOperation({ summary: 'Create or change the global default of a feature flag' })
  set(@Param('key') key: string, @Body() body: FlagDto) {
    return this.flags.setGlobal(flagKey(key), body);
  }
  @Platform('platform.features.manage')
  @Delete(':key')
  remove(@Param('key') key: string) {
    return this.flags.remove(flagKey(key));
  }
  @Platform('platform.features.manage')
  @Get(':key/overrides')
  overrides(@Param('key') key: string) {
    return this.flags.overrides(flagKey(key));
  }
}

/** What the signed-in member's own centre has switched on: `{ key: boolean }`. */
@ApiTags('Feature flags')
@ApiBearerAuth()
@Controller('feature-flags')
export class FeatureFlagsController {
  constructor(private readonly flags: FeatureFlags) {}

  @TenantMember({ allowSuspended: true })
  @SupportSessionSafe('The staff app hides screens the centre has not switched on. Booleans only.')
  @Get()
  mine() {
    return this.flags.all();
  }
}

@ApiTags('Platform')
@ApiBearerAuth()
@Controller('platform/settings')
export class PlatformSettingsController {
  constructor(private readonly settings: PlatformSettingsService) {}

  @Platform('platform.features.manage')
  @Get()
  list() {
    return this.settings.list();
  }
  @Platform('platform.features.manage')
  @Get(':key')
  get(@Param('key') key: string) {
    return this.settings.get(key);
  }
  @Platform('platform.features.manage')
  @Put(':key')
  set(@Param('key') key: string, @Body() body: SettingDto) {
    return this.settings.set(key, body.value);
  }
  @Platform('platform.features.manage')
  @Delete(':key')
  @ApiOperation({ summary: 'Reset a setting to its default' })
  reset(@Param('key') key: string) {
    return this.settings.reset(key);
  }
}

// ====================================================================== platform staff
@ApiTags('Platform')
@ApiBearerAuth()
@Controller('platform/staff')
export class PlatformStaffController {
  constructor(private readonly staff: PlatformStaffService) {}

  @Platform('platform.staff.manage')
  @Get()
  list(@Query() query: StaffQueryDto) {
    return this.staff.list(query);
  }
  @Platform('platform.staff.manage')
  @Post()
  create(@Body() body: CreateStaffDto) {
    return this.staff.create(body);
  }
  @Platform('platform.staff.manage')
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateStaffDto) {
    return this.staff.update(id, body);
  }
  @Platform('platform.staff.manage')
  @Post(':id/invitation')
  @HttpCode(200)
  resendInvitation(@Param('id', ParseUUIDPipe) id: string) {
    return this.staff.resendInvitation(id);
  }
  @Platform('platform.staff.manage')
  @Post(':id/disable')
  @HttpCode(200)
  disable(@Param('id', ParseUUIDPipe) id: string) {
    return this.staff.disable(id);
  }
  @Platform('platform.staff.manage')
  @Post(':id/enable')
  @HttpCode(200)
  enable(@Param('id', ParseUUIDPipe) id: string) {
    return this.staff.enable(id);
  }
}

// ====================================================================== platform audit + security
@ApiTags('Platform')
@ApiBearerAuth()
@Controller('platform')
export class PlatformAuditController {
  constructor(private readonly audit: PlatformAuditService) {}

  @Platform('platform.audit.read')
  @Get('audit-logs')
  @ApiOperation({ summary: 'Platform-level audit entries only (never a centre\'s own trail)' })
  auditLogs(@Query() query: PlatformAuditQueryDto) {
    return this.audit.list(query);
  }
  @Platform('platform.audit.read')
  @Get('audit-logs/:id')
  auditLog(@Param('id', ParseUUIDPipe) id: string) {
    return this.audit.get(id);
  }
  @Platform('platform.audit.read')
  @Get('security-events/summary')
  securitySummary(@Query() query: PeriodDto) {
    return this.audit.securitySummary(query);
  }
  @Platform('platform.audit.read')
  @Get('security-events')
  securityEvents(@Query() query: SecurityEventQueryDto) {
    return this.audit.securityEvents(query);
  }
}

// ====================================================================== monitoring
@ApiTags('Internal')
@Controller('internal')
export class InternalMetricsController {
  constructor(private readonly metrics: PlatformMetricsService) {}

  @Internal()
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Prometheus metrics (machine-to-machine: needs the x-internal-token header)' })
  @ApiHeader({ name: 'x-internal-token', required: true })
  @ApiProduces('text/plain')
  metricsText() {
    return this.metrics.text();
  }
}
