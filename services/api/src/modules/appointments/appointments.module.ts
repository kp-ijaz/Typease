import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { AppointmentsController, MyAppointmentsController, PublicAppointmentsController } from './appointments.controller';
import { AppointmentsService } from './appointments.service';
import { CalendarService } from './calendar.service';
import { AppointmentsErasure } from './appointments.erasure';

/** Branch calendars, appointment booking (staff, customers, guests), reminders and no-show tracking. */
@Module({
  imports: [QueueModule],
  controllers: [AppointmentsController, MyAppointmentsController, PublicAppointmentsController],
  providers: [CalendarService, AppointmentsService, AppointmentsErasure],
  exports: [AppointmentsService, CalendarService],
})
export class AppointmentsModule {}
