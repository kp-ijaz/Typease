import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  approvedProvidersSchema, authorisationReviewQuery, createIntegrationSchema, integrationListQuery, integrationLogQuery, integrationSecretsSchema,
  rejectAuthorisationSchema, updateIntegrationSchema, verifyAuthorisationSchema,
} from '@typease/validation';
import { Permissions, Platform } from '../../common/auth/access';
import { dto } from '../../common/zod';
import { IntegrationsService } from './integrations.service';
import { PlatformIntegrationsService } from './platform-integrations.service';

class CreateIntegrationDto extends dto(createIntegrationSchema) {}
class UpdateIntegrationDto extends dto(updateIntegrationSchema) {}
class SecretsDto extends dto(integrationSecretsSchema) {}
class ListDto extends dto(integrationListQuery) {}
class LogQueryDto extends dto(integrationLogQuery) {}
class ReviewQueryDto extends dto(authorisationReviewQuery) {}
class VerifyDto extends dto(verifyAuthorisationSchema) {}
class RejectDto extends dto(rejectAuthorisationSchema) {}
class ApprovedProvidersDto extends dto(approvedProvidersSchema) {}

/** Settings > Integrations of the signed-in centre. Only roles with `integration.manage` (the owner by default). */
@ApiTags('Integrations')
@ApiBearerAuth()
@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Permissions('integration.manage')
  @Get('catalogue')
  @ApiOperation({ summary: 'Providers a centre can configure, with their settings and credential fields' })
  catalogue() {
    return this.integrations.catalogue();
  }

  @Permissions('integration.manage')
  @Get('logs')
  @ApiOperation({ summary: 'Redacted log of calls to external services' })
  logs(@Query() query: LogQueryDto) {
    return this.integrations.logs(query);
  }

  @Permissions('integration.manage')
  @Get()
  @ApiOperation({ summary: 'Configured integrations (credentials are never returned)' })
  list(@Query() query: ListDto) {
    return this.integrations.list(query);
  }

  @Permissions('integration.manage')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.integrations.get(id);
  }

  @Permissions('integration.manage')
  @Post()
  create(@Body() body: CreateIntegrationDto) {
    return this.integrations.create(body);
  }

  @Permissions('integration.manage')
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateIntegrationDto) {
    return this.integrations.update(id, body);
  }

  @Permissions('integration.manage')
  @Put(':id/secrets')
  @ApiOperation({ summary: 'Store or remove credentials (write-only)' })
  setSecrets(@Param('id', ParseUUIDPipe) id: string, @Body() body: SecretsDto) {
    return this.integrations.setSecrets(id, body);
  }

  @Permissions('integration.manage')
  @Post(':id/enable')
  @HttpCode(200)
  enable(@Param('id', ParseUUIDPipe) id: string) {
    return this.integrations.enable(id);
  }

  @Permissions('integration.manage')
  @Post(':id/disable')
  @HttpCode(200)
  disable(@Param('id', ParseUUIDPipe) id: string) {
    return this.integrations.disable(id);
  }

  @Permissions('integration.manage')
  @Post(':id/test')
  @HttpCode(200)
  @ApiOperation({ summary: 'Harmless connection test (nothing is sent, charged or changed)' })
  test(@Param('id', ParseUUIDPipe) id: string) {
    return this.integrations.test(id);
  }

  @Permissions('integration.manage')
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.integrations.remove(id);
  }
}

/** TypEase administrators: which providers centres may use, and the review of authorisation records. */
@ApiTags('Platform')
@ApiBearerAuth()
@Controller('platform/integrations')
export class PlatformIntegrationsController {
  constructor(private readonly platform: PlatformIntegrationsService) {}

  @Platform('platform.integrations.manage')
  @Get('approved-providers')
  approved() {
    return this.platform.approvedView();
  }

  @Platform('platform.integrations.manage')
  @Put('approved-providers')
  @ApiOperation({ summary: 'Restrict which providers centres may configure (null = no restriction)' })
  setApproved(@Body() body: ApprovedProvidersDto) {
    return this.platform.setApproved(body);
  }

  @Platform('platform.integrations.manage')
  @Get('authorisations')
  @ApiOperation({ summary: 'GOVERNMENT / PARTNER authorisation records waiting for review (or already decided)' })
  authorisations(@Query() query: ReviewQueryDto) {
    return this.platform.listAuthorisations(query);
  }

  @Platform('platform.integrations.manage')
  @Get('authorisations/:id')
  authorisation(@Param('id', ParseUUIDPipe) id: string) {
    return this.platform.getAuthorisation(id);
  }

  @Platform('platform.integrations.manage')
  @Post('authorisations/:id/verify')
  @HttpCode(200)
  verify(@Param('id', ParseUUIDPipe) id: string, @Body() body: VerifyDto) {
    return this.platform.verify(id, body.note);
  }

  @Platform('platform.integrations.manage')
  @Post('authorisations/:id/reject')
  @HttpCode(200)
  reject(@Param('id', ParseUUIDPipe) id: string, @Body() body: RejectDto) {
    return this.platform.reject(id, body.note);
  }
}
