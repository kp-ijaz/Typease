import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  customerReplySchema, feedbackListQuery, feedbackSchema, feedbackSummaryQuery, myTicketsQuery, openPlatformTicketSchema, openTicketSchema, pageQuery,
  platformStaffReplySchema, platformTicketListQuery, platformTicketReplySchema, platformTicketUpdateSchema, slaPoliciesSchema, staffOpenTicketSchema,
  staffReplySchema, supportSettingsSchema, ticketListQuery, ticketStatusSchema, updateTicketSchema,
} from '@typease/validation';
import { Permissions, Platform } from '../../common/auth/access';
import { dto } from '../../common/zod';
import { FeedbackService } from './feedback.service';
import { PlatformSupportService } from './platform-support.service';
import { SupportService } from './support.service';

class TicketListDto extends dto(ticketListQuery) {}
class StaffOpenDto extends dto(staffOpenTicketSchema) {}
class UpdateTicketDto extends dto(updateTicketSchema) {}
class StaffReplyDto extends dto(staffReplySchema) {}
class StatusDto extends dto(ticketStatusSchema) {}
class SlaDto extends dto(slaPoliciesSchema) {}
class SettingsDto extends dto(supportSettingsSchema) {}
class FeedbackListDto extends dto(feedbackListQuery) {}
class FeedbackSummaryDto extends dto(feedbackSummaryQuery) {}
class OpenPlatformDto extends dto(openPlatformTicketSchema) {}
class PlatformReplyDto extends dto(platformTicketReplySchema) {}
class MyTicketsDto extends dto(myTicketsQuery) {}
class OpenTicketDto extends dto(openTicketSchema) {}
class CustomerReplyDto extends dto(customerReplySchema) {}
class FeedbackDto extends dto(feedbackSchema) {}
class PageDto extends dto(pageQuery) {}
class PlatformListDto extends dto(platformTicketListQuery) {}
class PlatformStaffReplyDto extends dto(platformStaffReplySchema) {}
class PlatformUpdateDto extends dto(platformTicketUpdateSchema) {}

/** Centre staff: customer tickets, SLA, feedback, and the centre's own tickets to TypEase support. */
@ApiTags('Support')
@ApiBearerAuth()
@Controller('support')
export class SupportController {
  constructor(
    private readonly support: SupportService,
    private readonly feedback: FeedbackService,
  ) {}

  @Permissions('ticket.read', 'ticket.manage')
  @Get('tickets')
  @ApiOperation({ summary: 'Customer tickets with SLA due times and breach flags' })
  list(@Query() query: TicketListDto) {
    return this.support.list(query);
  }
  @Permissions('ticket.manage')
  @Post('tickets')
  @ApiOperation({ summary: 'Open a ticket for a customer' })
  open(@Body() body: StaffOpenDto) {
    return this.support.open(body);
  }
  @Permissions('ticket.read', 'ticket.manage')
  @Get('tickets/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.support.get(id);
  }
  @Permissions('ticket.manage')
  @Patch('tickets/:id')
  @ApiOperation({ summary: 'Assign, set priority or category' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateTicketDto) {
    return this.support.update(id, body);
  }
  @Permissions('ticket.manage')
  @Post('tickets/:id/messages')
  @ApiOperation({ summary: 'Reply to the customer, or add an internal note (visibility INTERNAL)' })
  reply(@Param('id', ParseUUIDPipe) id: string, @Body() body: StaffReplyDto) {
    return this.support.reply(id, body);
  }
  @Permissions('ticket.manage')
  @Post('tickets/:id/status')
  @HttpCode(200)
  status(@Param('id', ParseUUIDPipe) id: string, @Body() body: StatusDto) {
    return this.support.setStatus(id, body);
  }

  @Permissions('ticket.read', 'ticket.manage')
  @Get('sla-policies')
  slaPolicies() {
    return this.support.slaPolicies();
  }
  @Permissions('ticket.manage')
  @Put('sla-policies')
  @ApiOperation({ summary: 'First-response and resolution targets per priority' })
  saveSlaPolicies(@Body() body: SlaDto) {
    return this.support.saveSlaPolicies(body);
  }
  @Permissions('ticket.read', 'ticket.manage')
  @Get('settings')
  settings() {
    return this.support.getSettings();
  }
  @Permissions('ticket.manage')
  @Put('settings')
  updateSettings(@Body() body: SettingsDto) {
    return this.support.updateSettings(body);
  }

  @Permissions('ticket.read', 'ticket.manage')
  @Get('feedback')
  feedbackList(@Query() query: FeedbackListDto) {
    return this.feedback.list(query);
  }
  @Permissions('ticket.read', 'ticket.manage', 'report.operational')
  @Get('feedback/summary')
  @ApiOperation({ summary: 'Average customer rating per month' })
  feedbackSummary(@Query() query: FeedbackSummaryDto) {
    return this.feedback.summary(query);
  }

  // ---- the centre's own tickets to TypEase support
  @Permissions('settings.manage', 'ticket.manage')
  @Get('platform-tickets')
  platformList(@Query() query: MyTicketsDto) {
    return this.support.listPlatform(query);
  }
  @Permissions('settings.manage', 'ticket.manage')
  @Post('platform-tickets')
  @ApiOperation({ summary: 'Ask TypEase support for help' })
  platformOpen(@Body() body: OpenPlatformDto) {
    return this.support.openPlatform(body);
  }
  @Permissions('settings.manage', 'ticket.manage')
  @Get('platform-tickets/:id')
  platformGet(@Param('id', ParseUUIDPipe) id: string) {
    return this.support.getPlatform(id);
  }
  @Permissions('settings.manage', 'ticket.manage')
  @Post('platform-tickets/:id/messages')
  platformReply(@Param('id', ParseUUIDPipe) id: string, @Body() body: PlatformReplyDto) {
    return this.support.replyPlatform(id, body.body);
  }
}

/** Customers and company users: their own tickets and feedback. */
@ApiTags('Support')
@ApiBearerAuth()
@Controller('me')
export class MySupportController {
  constructor(
    private readonly support: SupportService,
    private readonly feedback: FeedbackService,
  ) {}

  @Permissions('self.tickets')
  @Get('tickets')
  list(@Query() query: MyTicketsDto) {
    return this.support.listMine(query);
  }
  @Permissions('self.tickets')
  @Post('tickets')
  open(@Body() body: OpenTicketDto) {
    return this.support.openMine(body);
  }
  @Permissions('self.tickets')
  @Get('tickets/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.support.getMine(id);
  }
  @Permissions('self.tickets')
  @Post('tickets/:id/messages')
  reply(@Param('id', ParseUUIDPipe) id: string, @Body() body: CustomerReplyDto) {
    return this.support.replyMine(id, body);
  }
  @Permissions('self.tickets', 'self.requests')
  @Get('feedback')
  myFeedback(@Query() query: PageDto) {
    return this.feedback.mine(query);
  }
  @Permissions('self.tickets', 'self.requests')
  @Post('feedback')
  @ApiOperation({ summary: 'Rate a resolved ticket or a completed request of my own (1-5), once' })
  rate(@Body() body: FeedbackDto) {
    return this.feedback.rate(body);
  }
}

/** TypEase support desk (platform staff). No tenant data beyond the ticket conversation, centre name and plan. */
@ApiTags('Platform')
@ApiBearerAuth()
@Controller('platform/support/tickets')
export class PlatformSupportController {
  constructor(private readonly desk: PlatformSupportService) {}

  @Platform('platform.support.manage')
  @Get()
  list(@Query() query: PlatformListDto) {
    return this.desk.list(query);
  }
  @Platform('platform.support.manage')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.desk.get(id);
  }
  @Platform('platform.support.manage')
  @Post(':id/messages')
  reply(@Param('id', ParseUUIDPipe) id: string, @Body() body: PlatformStaffReplyDto) {
    return this.desk.reply(id, body);
  }
  @Platform('platform.support.manage')
  @Patch(':id')
  @ApiOperation({ summary: 'Assign to platform staff, change priority, resolve or close' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: PlatformUpdateDto) {
    return this.desk.update(id, body);
  }
}
