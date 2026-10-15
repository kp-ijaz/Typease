import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { convertLeadSchema, leadActivitySchema, leadQuery, leadSchema, leadStatusSchema, updateLeadSchema } from '@typease/validation';
import { Permissions } from '../../common/auth/access';
import { dto } from '../../common/zod';
import { LeadsService } from './leads.service';

class LeadDto extends dto(leadSchema) {}
class UpdateLeadDto extends dto(updateLeadSchema) {}
class StatusDto extends dto(leadStatusSchema) {}
class ActivityDto extends dto(leadActivitySchema) {}
class ConvertDto extends dto(convertLeadSchema) {}
class QueryDto extends dto(leadQuery) {}

@ApiTags('Leads')
@ApiBearerAuth()
@Controller('leads')
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Permissions('lead.read', 'lead.manage')
  @Get()
  list(@Query() query: QueryDto) {
    return this.leads.list(query);
  }
  @Permissions('lead.manage')
  @Post()
  create(@Body() body: LeadDto) {
    return this.leads.create(body);
  }
  @Permissions('lead.read', 'lead.manage')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.leads.get(id);
  }
  @Permissions('lead.manage')
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateLeadDto) {
    return this.leads.update(id, body);
  }
  @Permissions('lead.manage')
  @Put(':id/status')
  status(@Param('id', ParseUUIDPipe) id: string, @Body() body: StatusDto) {
    return this.leads.setStatus(id, body.status, body.lostReason);
  }
  @Permissions('lead.manage')
  @Post(':id/activities')
  activity(@Param('id', ParseUUIDPipe) id: string, @Body() body: ActivityDto) {
    return this.leads.addActivity(id, body.kind, body.body, body.nextFollowUpAt);
  }
  @Permissions('lead.manage')
  @Post(':id/convert')
  @HttpCode(200)
  @ApiOperation({ summary: 'Win the lead: link or create the customer (duplicate-checked) and optionally open a request' })
  convert(@Param('id', ParseUUIDPipe) id: string, @Body() body: ConvertDto) {
    return this.leads.convert(id, body);
  }
}
