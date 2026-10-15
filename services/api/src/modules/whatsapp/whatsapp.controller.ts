import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, RawBodyRequest, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { conversationQuery, inboxIntakeSchema, inboxAssignSchema, inboxLinkCustomerSchema, inboxNoteSchema, inboxReplySchema, inboxStatusSchema, quickRepliesSchema, simulateInboundSchema } from '@typease/validation';
import { Permissions, Public } from '../../common/auth/access';
import { RateLimit } from '../../common/rate-limit';
import { dto } from '../../common/zod';
import { WhatsAppInboxService } from './inbox.service';
import { WhatsAppIntakeService } from './intake.service';

class ListDto extends dto(conversationQuery) {}
class ReplyDto extends dto(inboxReplySchema) {}
class NoteDto extends dto(inboxNoteSchema) {}
class AssignDto extends dto(inboxAssignSchema) {}
class StatusDto extends dto(inboxStatusSchema) {}
class LinkDto extends dto(inboxLinkCustomerSchema) {}
class QuickRepliesDto extends dto(quickRepliesSchema) {}
class SimulateDto extends dto(simulateInboundSchema) {}
class IntakeDto extends dto(inboxIntakeSchema) {}

@ApiTags('WhatsApp inbox')
@ApiBearerAuth()
@Controller('inbox')
export class WhatsAppInboxController {
  constructor(
    private readonly inbox: WhatsAppInboxService,
    private readonly intakes: WhatsAppIntakeService,
  ) {}

  @Permissions('request.create')
  @Post('messages/:id/intake')
  @ApiOperation({ summary: 'Start a draft request from a photo or PDF the customer sent: checklist line and OCR included' })
  intake(@Param('id', ParseUUIDPipe) id: string, @Body() body: IntakeDto) {
    return this.intakes.intake(id, body);
  }

  @Permissions('inbox.read', 'inbox.reply', 'inbox.manage')
  @Get('conversations')
  list(@Query() query: ListDto) {
    return this.inbox.list(query);
  }
  @Permissions('inbox.read', 'inbox.reply', 'inbox.manage')
  @Get('conversations/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.inbox.get(id);
  }
  @Permissions('inbox.reply', 'inbox.manage')
  @Post('conversations/:id/reply')
  @ApiOperation({ summary: 'Free-form WhatsApp reply (within 24 hours of the customer\'s last message)' })
  reply(@Param('id', ParseUUIDPipe) id: string, @Body() body: ReplyDto) {
    return this.inbox.reply(id, body.text);
  }
  @Permissions('inbox.read', 'inbox.reply', 'inbox.manage')
  @Post('conversations/:id/notes')
  note(@Param('id', ParseUUIDPipe) id: string, @Body() body: NoteDto) {
    return this.inbox.note(id, body.text);
  }
  @Permissions('inbox.reply', 'inbox.manage')
  @Put('conversations/:id/assignee')
  assign(@Param('id', ParseUUIDPipe) id: string, @Body() body: AssignDto) {
    return this.inbox.assign(id, body.membershipId);
  }
  @Permissions('inbox.reply', 'inbox.manage')
  @Put('conversations/:id/status')
  status(@Param('id', ParseUUIDPipe) id: string, @Body() body: StatusDto) {
    return this.inbox.setStatus(id, body.status);
  }
  @Permissions('inbox.reply', 'inbox.manage')
  @Put('conversations/:id/customer')
  link(@Param('id', ParseUUIDPipe) id: string, @Body() body: LinkDto) {
    return this.inbox.linkCustomer(id, body.customerId);
  }
  @Permissions('inbox.read', 'inbox.reply', 'inbox.manage')
  @Get('quick-replies')
  quickReplies() {
    return this.inbox.quickReplies();
  }
  @Permissions('inbox.manage')
  @Put('quick-replies')
  setQuickReplies(@Body() body: QuickRepliesDto) {
    return this.inbox.setQuickReplies(body);
  }
  @Permissions('inbox.manage')
  @Post('simulate')
  @ApiOperation({ summary: 'Development sandbox only: a WhatsApp message as if a customer had sent it' })
  simulate(@Body() body: SimulateDto) {
    return this.inbox.simulate(body);
  }
}

/** Meta webhook of one centre's WhatsApp integration: Callback URL .../public/webhooks/whatsapp/<integration id>. */
@ApiTags('Public')
@Controller('public/webhooks/whatsapp')
export class WhatsAppWebhookController {
  constructor(private readonly inbox: WhatsAppInboxService) {}

  @Public()
  @RateLimit({ name: 'whatsapp-webhook-verify', limit: 30, windowSeconds: 60 })
  @Get(':integrationId')
  verify(@Param('integrationId', ParseUUIDPipe) id: string, @Query('hub.mode') mode?: string, @Query('hub.verify_token') token?: string, @Query('hub.challenge') challenge?: string) {
    return this.inbox.verify(id, mode, token, challenge);
  }
  @Public()
  @RateLimit({ name: 'whatsapp-webhook', limit: 600, windowSeconds: 60 })
  @Post(':integrationId')
  @HttpCode(200)
  receive(@Param('integrationId', ParseUUIDPipe) id: string, @Req() req: RawBodyRequest<Request>, @Headers() headers: Record<string, string>) {
    return this.inbox.receive(id, req.rawBody, headers);
  }
}
