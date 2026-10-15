import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { callNextSchema, displayQuery, displayTokenSchema, issueTokenSchema, queueBranchQuery, queueListQuery, queueStatsQuery, recallTokenSchema } from '@typease/validation';
import { Permissions, Public } from '../../common/auth/access';
import { RateLimit } from '../../common/rate-limit';
import { dto } from '../../common/zod';
import { QueueService } from './queue.service';

class IssueDto extends dto(issueTokenSchema) {}
class CallNextDto extends dto(callNextSchema) {}
class RecallDto extends dto(recallTokenSchema) {}
class ListDto extends dto(queueListQuery) {}
class BranchDto extends dto(queueBranchQuery) {}
class StatsDto extends dto(queueStatsQuery) {}
class DisplayTokenDto extends dto(displayTokenSchema) {}
class DisplayDto extends dto(displayQuery) {}

@ApiTags('Queue')
@ApiBearerAuth()
@Controller('queue')
export class QueueController {
  constructor(private readonly queue: QueueService) {}

  @Permissions('queue.manage')
  @Get('tokens')
  @ApiOperation({ summary: 'Tokens of a branch for one day (default today) with a status summary' })
  list(@Query() query: ListDto) {
    return this.queue.list(query);
  }
  @Permissions('queue.manage')
  @Post('tokens')
  @ApiOperation({ summary: 'Issue a walk-in token (e.g. A-001)' })
  issue(@Body() body: IssueDto) {
    return this.queue.issue(body);
  }
  @Permissions('queue.manage')
  @Post('call-next')
  @HttpCode(200)
  @ApiOperation({ summary: 'Call the longest-waiting token to a counter' })
  callNext(@Body() body: CallNextDto) {
    return this.queue.callNext(body);
  }
  @Permissions('queue.manage')
  @Post('tokens/:id/recall')
  @HttpCode(200)
  recall(@Param('id', ParseUUIDPipe) id: string, @Body() body: RecallDto) {
    return this.queue.recall(id, body.counter);
  }
  @Permissions('queue.manage')
  @Post('tokens/:id/start')
  @HttpCode(200)
  start(@Param('id', ParseUUIDPipe) id: string) {
    return this.queue.startServing(id);
  }
  @Permissions('queue.manage')
  @Post('tokens/:id/complete')
  @HttpCode(200)
  complete(@Param('id', ParseUUIDPipe) id: string) {
    return this.queue.complete(id);
  }
  @Permissions('queue.manage')
  @Post('tokens/:id/no-show')
  @HttpCode(200)
  noShow(@Param('id', ParseUUIDPipe) id: string) {
    return this.queue.noShow(id);
  }
  @Permissions('queue.manage')
  @Post('tokens/:id/cancel')
  @HttpCode(200)
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.queue.cancel(id);
  }
  @Permissions('queue.manage')
  @Get('counters')
  @ApiOperation({ summary: 'Counters in use today and the token at each one' })
  counters(@Query() query: BranchDto) {
    return this.queue.counters(query.branchId);
  }
  @Permissions('queue.manage', 'report.operational')
  @Get('stats')
  @ApiOperation({ summary: 'Waiting and service times, tokens per hour and no-show rate' })
  stats(@Query() query: StatsDto) {
    return this.queue.stats(query);
  }
  @Permissions('queue.manage')
  @Post('display-tokens')
  @ApiOperation({ summary: 'Create a signed link for the public queue screen of a branch' })
  displayToken(@Body() body: DisplayTokenDto) {
    return this.queue.createDisplayToken(body);
  }
  @Permissions('queue.manage')
  @Post('display-tokens/revoke')
  @HttpCode(200)
  @ApiOperation({ summary: 'Invalidate all display links of a branch' })
  revoke(@Body() body: BranchDto) {
    return this.queue.revokeDisplayTokens(body.branchId);
  }
}

/** Public queue screen: token numbers, counters and statuses only. */
@ApiTags('Public')
@Controller('public/queue')
export class PublicQueueController {
  constructor(private readonly queue: QueueService) {}

  @Public()
  @RateLimit({ name: 'queue-display', limit: 120, windowSeconds: 60 })
  @Get('display')
  @ApiOperation({ summary: 'Now serving / next up for a queue screen (signed display token)' })
  display(@Query() query: DisplayDto) {
    return this.queue.displayState(this.queue.parseDisplayToken(query.token));
  }

  @Public()
  @RateLimit({ name: 'queue-display-stream', limit: 30, windowSeconds: 60 })
  @Get('display/stream')
  @ApiOperation({ summary: 'Server-Sent Events: pushes the display state whenever it changes' })
  async stream(@Query() query: DisplayDto, @Req() req: Request, @Res() res: Response) {
    const access = this.queue.parseDisplayToken(query.token);
    let opened = false;
    const stream = await this.queue.openDisplayStream(
      access,
      (chunk) => {
        if (!opened) {
          opened = true;
          res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          res.flushHeaders();
        }
        if (!res.writableEnded) res.write(chunk);
      },
      () => {
        if (!res.writableEnded) res.end();
      },
    );
    // The screen went away (closed tab, lost network): stop polling immediately.
    req.on('close', () => stream.close());
    if (req.destroyed) stream.close();
  }
}
