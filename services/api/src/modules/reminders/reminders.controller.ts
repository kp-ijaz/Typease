import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createReminderSchema, optionalReasonBody, reminderListQuery, updateReminderSchema, myRemindersQuery } from '@typease/validation';
import { Permissions, TenantMember } from '../../common/auth/access';
import { SupportSessionRead } from '../../common/auth/support-session';
import { dto } from '../../common/zod';
import { RemindersService } from './reminders.service';

class ListDto extends dto(reminderListQuery) {}
class CreateDto extends dto(createReminderSchema) {}
class UpdateDto extends dto(updateReminderSchema) {}
class ReasonDto extends dto(optionalReasonBody) {}
class MyRemindersDto extends dto(myRemindersQuery) {}

@ApiTags('Reminders')
@ApiBearerAuth()
@Controller('reminders')
export class RemindersController {
  constructor(private readonly reminders: RemindersService) {}

  @Permissions('reminder.read', 'reminder.manage')
  @Get()
  @ApiOperation({ summary: 'Expiry reminder schedules; withinDays=N gives the "upcoming expiries" list' })
  list(@Query() query: ListDto) {
    return this.reminders.list(query);
  }
  @Permissions('reminder.manage')
  @Post()
  create(@Body() body: CreateDto) {
    return this.reminders.create(body);
  }
  @Permissions('reminder.read', 'reminder.manage')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.reminders.get(id);
  }
  @Permissions('reminder.manage')
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateDto) {
    return this.reminders.update(id, body);
  }
  @Permissions('reminder.manage')
  @Post(':id/pause')
  @HttpCode(200)
  pause(@Param('id', ParseUUIDPipe) id: string) {
    return this.reminders.setStatus(id, 'PAUSED');
  }
  @Permissions('reminder.manage')
  @Post(':id/resume')
  @HttpCode(200)
  resume(@Param('id', ParseUUIDPipe) id: string) {
    return this.reminders.setStatus(id, 'ACTIVE');
  }
  @Permissions('reminder.manage')
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() body: ReasonDto) {
    return this.reminders.cancel(id, body.reason);
  }
  @Permissions('reminder.read', 'reminder.manage')
  @SupportSessionRead('Builds the portal address for a renewal; nothing is stored or sent.')
  @Post(':id/renewal-link')
  @HttpCode(200)
  @ApiOperation({ summary: 'Portal link that starts a renewal request for this document' })
  renewalLink(@Param('id', ParseUUIDPipe) id: string) {
    return this.reminders.renewalLink(id);
  }
}

@ApiTags('Reminders')
@ApiBearerAuth()
@Controller('me')
export class MyRemindersController {
  constructor(private readonly reminders: RemindersService) {}

  @TenantMember({ kinds: ['CUSTOMER', 'CORPORATE'] })
  @Get('reminders')
  @ApiOperation({ summary: 'Expiry reminders for my own documents (or my company\'s)' })
  mine(@Query() query: MyRemindersDto) {
    return this.reminders.mine(query);
  }
}
