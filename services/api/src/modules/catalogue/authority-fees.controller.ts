import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { applyAuthorityFeeUpdatesSchema, authorityFeeQuery, authorityFeeSchema, importAuthorityFeeSchema, linkAuthorityFeeSchema, updateAuthorityFeeSchema } from '@typease/validation';
import { Permissions, Platform } from '../../common/auth/access';
import { dto } from '../../common/zod';
import { AuthorityFeesService } from './authority-fees.service';

class FeeQueryDto extends dto(authorityFeeQuery) {}
class FeeDto extends dto(authorityFeeSchema) {}
class UpdateFeeDto extends dto(updateAuthorityFeeSchema) {}
class ImportDto extends dto(importAuthorityFeeSchema) {}
class LinkDto extends dto(linkAuthorityFeeSchema) {}
class ApplyDto extends dto(applyAuthorityFeeUpdatesSchema) {}

/** The TypEase authority fee catalogue as a centre sees it: browse, import, follow, apply updates. */
@ApiTags('Services')
@ApiBearerAuth()
@Controller()
export class AuthorityFeesController {
  constructor(private readonly fees: AuthorityFeesService) {}

  @Permissions('service.read')
  @Get('authority-fees')
  @ApiOperation({ summary: 'Authority fees maintained by TypEase, with the services of this centre that follow each' })
  browse(@Query() query: FeeQueryDto) {
    return this.fees.browse(query);
  }
  @Permissions('service.read')
  @Get('authority-fees/updates')
  @ApiOperation({ summary: 'Services whose prices do not carry the current catalogue amounts yet' })
  updates() {
    return this.fees.updates();
  }
  @Permissions('service.manage')
  @Post('authority-fees/updates/apply')
  apply(@Body() body: ApplyDto) {
    return this.fees.apply(body.serviceIds);
  }
  @Permissions('service.manage')
  @Post('authority-fees/:id/import')
  @ApiOperation({ summary: 'Add a catalogue entry as a new service with your own service fee' })
  import(@Param('id', ParseUUIDPipe) id: string, @Body() body: ImportDto) {
    return this.fees.importFee(id, body);
  }
  @Permissions('service.manage')
  @Put('services/:id/authority-fee')
  link(@Param('id', ParseUUIDPipe) id: string, @Body() body: LinkDto) {
    return this.fees.link(id, body.authorityFeeId);
  }
}

@ApiTags('Platform')
@ApiBearerAuth()
@Controller('platform/authority-fees')
export class PlatformAuthorityFeesController {
  constructor(private readonly fees: AuthorityFeesService) {}

  @Platform('platform.fees.manage')
  @Get()
  list(@Query() query: FeeQueryDto) {
    return this.fees.platformList(query);
  }
  @Platform('platform.fees.manage')
  @Post()
  create(@Body() body: FeeDto) {
    return this.fees.create(body);
  }
  @Platform('platform.fees.manage')
  @Patch(':id')
  @ApiOperation({ summary: 'Change an entry; a change of the amounts is a new version that centres are offered' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateFeeDto) {
    return this.fees.update(id, body);
  }
  @Platform('platform.fees.manage')
  @Get(':id/history')
  history(@Param('id', ParseUUIDPipe) id: string) {
    return this.fees.history(id);
  }
}
