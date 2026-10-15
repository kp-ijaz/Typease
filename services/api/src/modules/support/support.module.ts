import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { FeedbackService } from './feedback.service';
import { PlatformSupportService } from './platform-support.service';
import { MySupportController, PlatformSupportController, SupportController } from './support.controller';
import { SupportService } from './support.service';
import { SupportErasure } from './support.erasure';

/** Support tickets (customer -> centre, centre -> TypEase), SLA policies and customer feedback. */
@Module({
  imports: [TasksModule],
  controllers: [SupportController, MySupportController, PlatformSupportController],
  providers: [SupportService, FeedbackService, PlatformSupportService, SupportErasure],
})
export class SupportModule {}
