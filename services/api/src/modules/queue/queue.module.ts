import { Module } from '@nestjs/common';
import { PublicQueueController, QueueController } from './queue.controller';
import { QueueService } from './queue.service';

/** Walk-in queue: tokens, counters, the public display (JSON + Server-Sent Events) and waiting-time statistics. */
@Module({
  controllers: [QueueController, PublicQueueController],
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}
