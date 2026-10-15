import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  eventChannelToggleSchema, inboxQuery, language as languageSchema, notificationChannel, notificationFailureQuery, notificationLogQuery,
  notificationPreferencesSchema, notificationSettingsSchema, registerDeviceSchema, removeDeviceSchema, templateListQuery,
  templateOverrideSchema, templatePreviewSchema,
} from '@typease/validation';
import { Permissions, TenantMember } from '../../common/auth/access';
import { dto } from '../../common/zod';
import { NotificationAdminService } from './admin.service';
import { InboxService } from './inbox.service';
import { TemplateService } from './template.service';

class LogQueryDto extends dto(notificationLogQuery) {}
class FailureQueryDto extends dto(notificationFailureQuery) {}
class TemplateListDto extends dto(templateListQuery) {}
class TemplateOverrideDto extends dto(templateOverrideSchema) {}
class TemplatePreviewDto extends dto(templatePreviewSchema) {}
class ToggleDto extends dto(eventChannelToggleSchema) {}
class SettingsDto extends dto(notificationSettingsSchema) {}
class InboxQueryDto extends dto(inboxQuery) {}
class PreferencesDto extends dto(notificationPreferencesSchema) {}
class RegisterDeviceDto extends dto(registerDeviceSchema) {}
class RemoveDeviceDto extends dto(removeDeviceSchema) {}

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly admin: NotificationAdminService,
    private readonly templates: TemplateService,
  ) {}

  @Permissions('notification.manage')
  @Get()
  @ApiOperation({ summary: 'Delivery log (filters: status, channel, eventKey, customerId, from, to, q)' })
  log(@Query() query: LogQueryDto) {
    return this.admin.log(query);
  }
  @Permissions('notification.manage')
  @Get('failures')
  @ApiOperation({ summary: 'Failure report: failed notifications with the last error and totals' })
  failures(@Query() query: FailureQueryDto) {
    return this.admin.failures(query);
  }
  @Permissions('notification.manage')
  @Get('channels')
  @ApiOperation({ summary: 'Provider per channel and whether it is configured (no credentials)' })
  channels() {
    return this.admin.channels();
  }
  @Permissions('notification.manage')
  @Get('settings')
  settings() {
    return this.admin.getSettings();
  }
  @Permissions('notification.manage')
  @Put('settings')
  @ApiOperation({ summary: 'Enable / disable events per channel, set the per-recipient rate limit' })
  updateSettings(@Body() body: SettingsDto) {
    return this.admin.updateSettings(body);
  }

  // ---- template editor
  @Permissions('notification.manage')
  @Get('events')
  @ApiOperation({ summary: 'Notification events with the variables each template may use' })
  events() {
    return this.templates.events();
  }
  @Permissions('notification.manage')
  @Patch('events/:eventKey/channels/:channel')
  @ApiOperation({ summary: 'Switch one event on or off for one channel' })
  toggle(@Param('eventKey') eventKey: string, @Param('channel') channel: string, @Body() body: ToggleDto) {
    return this.admin.setEventChannel(eventKey, notificationChannel.parse(channel), body.enabled);
  }
  @Permissions('notification.manage')
  @Get('templates')
  @ApiOperation({ summary: 'Effective templates: the centre override when there is one, else the platform default' })
  listTemplates(@Query() query: TemplateListDto) {
    return this.templates.list(query);
  }
  @Permissions('notification.manage')
  @Post('templates/preview')
  @HttpCode(200)
  @ApiOperation({ summary: 'Render a draft or the effective template with sample data' })
  preview(@Body() body: TemplatePreviewDto) {
    return this.templates.preview(body);
  }
  @Permissions('notification.manage')
  @Put('templates/:eventKey/:channel/:language')
  @ApiOperation({ summary: 'Create or update the centre override for an event / channel / language' })
  saveTemplate(@Param('eventKey') eventKey: string, @Param('channel') channel: string, @Param('language') language: string, @Body() body: TemplateOverrideDto) {
    return this.templates.saveOverride(eventKey, notificationChannel.parse(channel), languageSchema.parse(language), body);
  }
  @Permissions('notification.manage')
  @Delete('templates/:eventKey/:channel/:language')
  @ApiOperation({ summary: 'Reset to the platform default' })
  resetTemplate(@Param('eventKey') eventKey: string, @Param('channel') channel: string, @Param('language') language: string) {
    return this.templates.resetOverride(eventKey, notificationChannel.parse(channel), languageSchema.parse(language));
  }

  // ---- single notification (declared last so the static paths above win)
  @Permissions('notification.manage')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.get(id);
  }
  @Permissions('notification.manage')
  @Post(':id/retry')
  @HttpCode(200)
  @ApiOperation({ summary: 'Retry a failed notification' })
  retry(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.retry(id);
  }
}

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('me')
export class MyNotificationsController {
  constructor(private readonly inbox: InboxService) {}

  @TenantMember()
  @Get('notifications')
  @ApiOperation({ summary: 'In-app inbox with unread count' })
  list(@Query() query: InboxQueryDto) {
    return this.inbox.list(query);
  }
  @TenantMember()
  @Post('notifications/read-all')
  @HttpCode(200)
  readAll() {
    return this.inbox.markAllRead();
  }
  @TenantMember()
  @Post('notifications/:id/read')
  @HttpCode(200)
  read(@Param('id', ParseUUIDPipe) id: string) {
    return this.inbox.markRead(id);
  }

  @TenantMember()
  @Get('notification-preferences')
  preferences() {
    return this.inbox.preferences();
  }
  @TenantMember()
  @Put('notification-preferences')
  updatePreferences(@Body() body: PreferencesDto) {
    return this.inbox.updatePreferences(body);
  }

  @TenantMember()
  @Get('devices')
  devices() {
    return this.inbox.devices();
  }
  @TenantMember()
  @Post('devices')
  @ApiOperation({ summary: 'Register this device for push notifications (mobile app)' })
  registerDevice(@Body() body: RegisterDeviceDto) {
    return this.inbox.registerDevice(body);
  }
  @TenantMember()
  @Delete('devices')
  @ApiOperation({ summary: 'Remove a device token (sign-out)' })
  removeDevice(@Body() body: RemoveDeviceDto) {
    return this.inbox.removeDevice(body.token);
  }
}
