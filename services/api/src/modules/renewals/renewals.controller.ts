import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { declineRenewalSchema, payInvoiceSchema, renewalAutopilotSettingsSchema } from '@typease/validation';
import { Permissions, Public } from '../../common/auth/access';
import { RateLimit } from '../../common/rate-limit';
import { dto } from '../../common/zod';
import { RenewalAutopilotService } from './renewal-autopilot.service';

class SettingsDto extends dto(renewalAutopilotSettingsSchema) {}
class AcceptDto extends dto(payInvoiceSchema.pick({ returnUrl: true })) {}
class DeclineDto extends dto(declineRenewalSchema) {}

@ApiTags('Reminders')
@ApiBearerAuth()
@Controller('renewals/autopilot')
export class RenewalAutopilotController {
  constructor(private readonly autopilot: RenewalAutopilotService) {}

  @Permissions('reminder.read', 'reminder.manage')
  @Get()
  @ApiOperation({ summary: 'Autopilot settings and the documents it would renew today' })
  async get() {
    const { settings, rows } = await this.autopilot.candidates();
    return { ...settings, candidates: rows };
  }
  @Permissions('reminder.manage')
  @Put()
  update(@Body() body: SettingsDto) {
    return this.autopilot.updateSettings(body);
  }
  @Permissions('reminder.manage', 'quotation.manage')
  @Post('run')
  @HttpCode(200)
  @ApiOperation({ summary: 'Prepare and offer every due renewal now (the job does this every morning)' })
  run() {
    return this.autopilot.run();
  }
  @Permissions('reminder.manage', 'quotation.manage')
  @Post('offer/:scheduleId')
  @ApiOperation({ summary: 'Prepare and offer the renewal of one tracked document now' })
  offer(@Param('scheduleId', ParseUUIDPipe) scheduleId: string) {
    return this.autopilot.offer(scheduleId);
  }
}

/** The one-tap link a customer receives on WhatsApp, SMS or email. The signed token is the only key. */
@ApiTags('Public')
@Controller('public/renewals')
export class PublicRenewalsController {
  constructor(private readonly autopilot: RenewalAutopilotService) {}

  @Public()
  @RateLimit({ name: 'public-renewal', limit: 60, windowSeconds: 900 })
  @Get(':token')
  view(@Param('token') token: string) {
    return this.autopilot.view(token);
  }
  @Public()
  @RateLimit({ name: 'public-renewal-decide', limit: 10, windowSeconds: 900 })
  @Post(':token/accept')
  @HttpCode(200)
  accept(@Param('token') token: string, @Body() body: AcceptDto) {
    return this.autopilot.accept(token, body.returnUrl);
  }
  @Public()
  @RateLimit({ name: 'public-renewal-decide', limit: 10, windowSeconds: 900 })
  @Post(':token/decline')
  @HttpCode(200)
  decline(@Param('token') token: string, @Body() body: DeclineDto) {
    return this.autopilot.decline(token, body.reason);
  }
}
