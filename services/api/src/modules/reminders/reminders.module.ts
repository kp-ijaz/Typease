import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { MyRemindersController, RemindersController } from './reminders.controller';
import { RemindersService } from './reminders.service';
import { RemindersErasure } from './reminders.erasure';

/** Document expiry automation: reminder schedules, the daily scan and renewal assistance. */
@Module({
  imports: [NotificationsModule],
  controllers: [RemindersController, MyRemindersController],
  providers: [RemindersService, RemindersErasure],
  exports: [RemindersService],
})
export class RemindersModule {}
