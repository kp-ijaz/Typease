import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  privacyCompleteSchema, privacyConsentQuery, privacyDecisionSchema, privacyIncidentListQuery, privacyIncidentSchema, privacyIncidentStatusSchema, privacyIncidentUpdateSchema,
  privacyProcessorListQuery, privacyProcessorReviewSchema, privacyProcessorSchema, privacyProcessorUpdateSchema, privacyRequestListQuery, privacyRequestSchema,
  privacyRetentionPolicySchema, privacyRetentionPolicyUpdateSchema, privacyStaffRequestSchema,
} from '@typease/validation';
import { Permissions, Platform } from '../../common/auth/access';
import { currentTenantId } from '../../common/context';
import { dto } from '../../common/zod';
import { DataSubjectRequestService } from './dsr.service';
import { IncidentService } from './incident.service';
import { PrivacyOverviewService } from './overview.service';
import { RetentionPolicyService } from './retention-policy.service';

class OwnRequestDto extends dto(privacyRequestSchema) {}
class StaffRequestDto extends dto(privacyStaffRequestSchema) {}
class RequestListDto extends dto(privacyRequestListQuery) {}
class DecisionDto extends dto(privacyDecisionSchema) {}
class CompleteDto extends dto(privacyCompleteSchema) {}
class PolicyDto extends dto(privacyRetentionPolicySchema) {}
class PolicyUpdateDto extends dto(privacyRetentionPolicyUpdateSchema) {}
class ConsentQueryDto extends dto(privacyConsentQuery) {}
class IncidentDto extends dto(privacyIncidentSchema) {}
class IncidentUpdateDto extends dto(privacyIncidentUpdateSchema) {}
class IncidentStatusDto extends dto(privacyIncidentStatusSchema) {}
class IncidentListDto extends dto(privacyIncidentListQuery) {}
class ProcessorDto extends dto(privacyProcessorSchema) {}
class ProcessorUpdateDto extends dto(privacyProcessorUpdateSchema) {}
class ProcessorReviewDto extends dto(privacyProcessorReviewSchema) {}
class ProcessorListDto extends dto(privacyProcessorListQuery) {}

/** Self-service: a customer's own privacy requests. */
@ApiTags('Privacy')
@ApiBearerAuth()
@Controller('privacy/my')
export class MyPrivacyController {
  constructor(private readonly requests: DataSubjectRequestService) {}

  @Permissions('self.privacy')
  @Post('requests')
  @ApiOperation({ summary: 'Ask for access to, correction, deletion or an export of my own data' })
  create(@Body() body: OwnRequestDto) {
    return this.requests.createOwn(body);
  }
  @Permissions('self.privacy')
  @Get('requests')
  list() {
    return this.requests.listOwn();
  }
  @Permissions('self.privacy')
  @Get('requests/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.requests.getOwn(id);
  }
}

/** The centre's privacy officer. Everything here needs `privacy.manage`. */
@ApiTags('Privacy')
@ApiBearerAuth()
@Controller('privacy')
export class PrivacyController {
  constructor(
    private readonly requests: DataSubjectRequestService,
    private readonly policies: RetentionPolicyService,
    private readonly views: PrivacyOverviewService,
    private readonly registers: IncidentService,
  ) {}

  @Permissions('privacy.manage')
  @Get('overview')
  @ApiOperation({ summary: 'Open / overdue privacy requests, incidents by status, consent statistics, retention policies in force' })
  overview() {
    return this.views.overview();
  }

  // ---- data subject requests
  @Permissions('privacy.manage')
  @Get('requests')
  listRequests(@Query() query: RequestListDto) {
    return this.requests.list(query);
  }
  @Permissions('privacy.manage')
  @Post('requests')
  @ApiOperation({ summary: 'Record a request received at the counter, by phone or by email' })
  createRequest(@Body() body: StaffRequestDto) {
    return this.requests.createForCustomer(body);
  }
  @Permissions('privacy.manage')
  @Get('requests/:id')
  getRequest(@Param('id', ParseUUIDPipe) id: string) {
    return this.requests.get(id);
  }
  @Permissions('privacy.manage')
  @Post('requests/:id/review')
  @HttpCode(200)
  startReview(@Param('id', ParseUUIDPipe) id: string) {
    return this.requests.startReview(id);
  }
  @Permissions('privacy.manage')
  @Post('requests/:id/decision')
  @HttpCode(200)
  decide(@Param('id', ParseUUIDPipe) id: string, @Body() body: DecisionDto) {
    return this.requests.decide(id, body);
  }
  @Permissions('privacy.manage')
  @Post('requests/:id/complete')
  @HttpCode(200)
  @ApiOperation({ summary: 'Carry out an approved request: build the export, or anonymise the customer and delete their documents' })
  complete(@Param('id', ParseUUIDPipe) id: string, @Body() body: CompleteDto) {
    return this.requests.complete(id, body);
  }

  // ---- retention
  @Permissions('privacy.manage')
  @Get('retention-policies')
  listPolicies() {
    return this.policies.list();
  }
  @Permissions('privacy.manage')
  @Post('retention-policies')
  createPolicy(@Body() body: PolicyDto) {
    return this.policies.create(body);
  }
  @Permissions('privacy.manage')
  @Patch('retention-policies/:id')
  updatePolicy(@Param('id', ParseUUIDPipe) id: string, @Body() body: PolicyUpdateDto) {
    return this.policies.update(id, body);
  }
  @Permissions('privacy.manage')
  @Delete('retention-policies/:id')
  removePolicy(@Param('id', ParseUUIDPipe) id: string) {
    return this.policies.remove(id);
  }

  // ---- consent overview
  @Permissions('privacy.manage')
  @Get('consents')
  consents(@Query() query: ConsentQueryDto) {
    return this.views.consents(query);
  }
  @Permissions('privacy.manage')
  @Get('consents/customers/:customerId/history')
  consentHistory(@Param('customerId', ParseUUIDPipe) customerId: string) {
    return this.views.consentHistory(customerId);
  }

  // ---- incident register (the centre's own)
  @Permissions('privacy.manage')
  @Get('incidents')
  listIncidents(@Query() query: IncidentListDto) {
    return this.registers.listIncidents(currentTenantId(), query);
  }
  @Permissions('privacy.manage')
  @Post('incidents')
  createIncident(@Body() body: IncidentDto) {
    return this.registers.createIncident(currentTenantId(), body);
  }
  @Permissions('privacy.manage')
  @Get('incidents/:id')
  getIncident(@Param('id', ParseUUIDPipe) id: string) {
    return this.registers.getIncident(currentTenantId(), id);
  }
  @Permissions('privacy.manage')
  @Patch('incidents/:id')
  updateIncident(@Param('id', ParseUUIDPipe) id: string, @Body() body: IncidentUpdateDto) {
    return this.registers.updateIncident(currentTenantId(), id, body);
  }
  @Permissions('privacy.manage')
  @Post('incidents/:id/status')
  @HttpCode(200)
  incidentStatus(@Param('id', ParseUUIDPipe) id: string, @Body() body: IncidentStatusDto) {
    return this.registers.changeIncidentStatus(currentTenantId(), id, body);
  }

  // ---- processor / vendor register (the centre's own)
  @Permissions('privacy.manage')
  @Get('processors')
  listProcessors(@Query() query: ProcessorListDto) {
    return this.registers.listProcessors(currentTenantId(), query);
  }
  @Permissions('privacy.manage')
  @Post('processors')
  createProcessor(@Body() body: ProcessorDto) {
    return this.registers.createProcessor(currentTenantId(), body);
  }
  @Permissions('privacy.manage')
  @Patch('processors/:id')
  updateProcessor(@Param('id', ParseUUIDPipe) id: string, @Body() body: ProcessorUpdateDto) {
    return this.registers.updateProcessor(currentTenantId(), id, body);
  }
  @Permissions('privacy.manage')
  @Post('processors/:id/review')
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve or reject a vendor (cross-border processing review)' })
  reviewProcessor(@Param('id', ParseUUIDPipe) id: string, @Body() body: ProcessorReviewDto) {
    return this.registers.reviewProcessor(currentTenantId(), id, body);
  }
  @Permissions('privacy.manage')
  @Delete('processors/:id')
  removeProcessor(@Param('id', ParseUUIDPipe) id: string) {
    return this.registers.removeProcessor(currentTenantId(), id);
  }
}

/**
 * Platform-level registers kept by TypEase staff (rows without a tenant).
 * Reading needs platform.audit.read. No dedicated platform permission exists
 * for maintaining them, so changes need platform.tenants.manage (incidents)
 * or platform.integrations.manage (vendors).
 */
@ApiTags('Platform')
@ApiBearerAuth()
@Controller('platform/privacy')
export class PlatformPrivacyController {
  constructor(private readonly registers: IncidentService) {}

  @Platform('platform.audit.read')
  @Get('incidents')
  listIncidents(@Query() query: IncidentListDto) {
    return this.registers.listIncidents(null, query);
  }
  @Platform('platform.audit.read')
  @Get('incidents/:id')
  getIncident(@Param('id', ParseUUIDPipe) id: string) {
    return this.registers.getIncident(null, id);
  }
  @Platform('platform.tenants.manage')
  @Post('incidents')
  createIncident(@Body() body: IncidentDto) {
    return this.registers.createIncident(null, body);
  }
  @Platform('platform.tenants.manage')
  @Patch('incidents/:id')
  updateIncident(@Param('id', ParseUUIDPipe) id: string, @Body() body: IncidentUpdateDto) {
    return this.registers.updateIncident(null, id, body);
  }
  @Platform('platform.tenants.manage')
  @Post('incidents/:id/status')
  @HttpCode(200)
  incidentStatus(@Param('id', ParseUUIDPipe) id: string, @Body() body: IncidentStatusDto) {
    return this.registers.changeIncidentStatus(null, id, body);
  }

  @Platform('platform.audit.read')
  @Get('processors')
  listProcessors(@Query() query: ProcessorListDto) {
    return this.registers.listProcessors(null, query);
  }
  @Platform('platform.integrations.manage')
  @Post('processors')
  createProcessor(@Body() body: ProcessorDto) {
    return this.registers.createProcessor(null, body);
  }
  @Platform('platform.integrations.manage')
  @Patch('processors/:id')
  updateProcessor(@Param('id', ParseUUIDPipe) id: string, @Body() body: ProcessorUpdateDto) {
    return this.registers.updateProcessor(null, id, body);
  }
  @Platform('platform.integrations.manage')
  @Post('processors/:id/review')
  @HttpCode(200)
  reviewProcessor(@Param('id', ParseUUIDPipe) id: string, @Body() body: ProcessorReviewDto) {
    return this.registers.reviewProcessor(null, id, body);
  }
  @Platform('platform.integrations.manage')
  @Delete('processors/:id')
  removeProcessor(@Param('id', ParseUUIDPipe) id: string) {
    return this.registers.removeProcessor(null, id);
  }
}
