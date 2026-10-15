import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  appointmentListQuery, appointmentSettingsSchema, availabilityQuery, cancelAppointmentSchema, checkInSchema, closureQuery, closureSchema,
  createAppointmentSchema, guestAppointmentSchema, guestCancelSchema, myAppointmentsQuery, publicAvailabilityQuery, rescheduleAppointmentSchema,
  selfAppointmentSchema, slotConfigQuery, slotConfigSchema, updateAppointmentSchema, updateSlotConfigSchema,
} from '@typease/validation';
import { Permissions, Public } from '../../common/auth/access';
import { RateLimit } from '../../common/rate-limit';
import { dto } from '../../common/zod';
import { AppointmentsService } from './appointments.service';
import { CalendarService } from './calendar.service';

class ListDto extends dto(appointmentListQuery) {}
class AvailabilityDto extends dto(availabilityQuery) {}
class PublicAvailabilityDto extends dto(publicAvailabilityQuery) {}
class CreateDto extends dto(createAppointmentSchema) {}
class UpdateDto extends dto(updateAppointmentSchema) {}
class RescheduleDto extends dto(rescheduleAppointmentSchema) {}
class CancelDto extends dto(cancelAppointmentSchema) {}
class CheckInDto extends dto(checkInSchema) {}
class SlotConfigDto extends dto(slotConfigSchema) {}
class UpdateSlotConfigDto extends dto(updateSlotConfigSchema) {}
class SlotConfigQueryDto extends dto(slotConfigQuery) {}
class ClosureDto extends dto(closureSchema) {}
class ClosureQueryDto extends dto(closureQuery) {}
class SettingsDto extends dto(appointmentSettingsSchema) {}
class SelfDto extends dto(selfAppointmentSchema) {}
class MyQueryDto extends dto(myAppointmentsQuery) {}
class GuestDto extends dto(guestAppointmentSchema) {}
class GuestCancelDto extends dto(guestCancelSchema) {}

@ApiTags('Appointments')
@ApiBearerAuth()
@Controller('appointments')
export class AppointmentsController {
  constructor(
    private readonly appointments: AppointmentsService,
    private readonly calendar: CalendarService,
  ) {}

  // ---- branch calendar configuration
  @Permissions('appointment.read', 'appointment.manage')
  @Get('slot-configs')
  slotConfigs(@Query() query: SlotConfigQueryDto) {
    return this.calendar.listSlotConfigs(query);
  }
  @Permissions('appointment.manage')
  @Post('slot-configs')
  @ApiOperation({ summary: 'Bookable hours of a branch on a weekday (optionally for one service)' })
  createSlotConfig(@Body() body: SlotConfigDto) {
    return this.calendar.createSlotConfig(body);
  }
  @Permissions('appointment.manage')
  @Patch('slot-configs/:id')
  updateSlotConfig(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateSlotConfigDto) {
    return this.calendar.updateSlotConfig(id, body);
  }
  @Permissions('appointment.manage')
  @Delete('slot-configs/:id')
  deleteSlotConfig(@Param('id', ParseUUIDPipe) id: string) {
    return this.calendar.deleteSlotConfig(id);
  }
  @Permissions('appointment.read', 'appointment.manage')
  @Get('closures')
  closures(@Query() query: ClosureQueryDto) {
    return this.calendar.listClosures(query);
  }
  @Permissions('appointment.manage')
  @Post('closures')
  @ApiOperation({ summary: 'Close a branch for a day (holiday)' })
  addClosure(@Body() body: ClosureDto) {
    return this.calendar.addClosure(body);
  }
  @Permissions('appointment.manage')
  @Delete('closures/:id')
  removeClosure(@Param('id', ParseUUIDPipe) id: string) {
    return this.calendar.removeClosure(id);
  }
  @Permissions('appointment.read', 'appointment.manage')
  @Get('settings')
  settings() {
    return this.calendar.getSettings();
  }
  @Permissions('appointment.manage')
  @Put('settings')
  @ApiOperation({ summary: 'Guest booking, no-show delay, cancellation cut-off, reminder times' })
  updateSettings(@Body() body: SettingsDto) {
    return this.calendar.updateSettings(body);
  }

  // ---- availability and bookings
  @Permissions('appointment.read', 'appointment.manage', 'self.appointments')
  @Get('availability')
  @ApiOperation({ summary: 'Slots of a branch day in the branch time zone' })
  availability(@Query() query: AvailabilityDto) {
    return this.appointments.availability(query);
  }
  @Permissions('appointment.read', 'appointment.manage')
  @Get()
  list(@Query() query: ListDto) {
    return this.appointments.list(query);
  }
  @Permissions('appointment.manage')
  @Post()
  @ApiOperation({ summary: 'Book for a customer or a walk-in guest' })
  book(@Body() body: CreateDto) {
    return this.appointments.book(body);
  }
  @Permissions('appointment.read', 'appointment.manage')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.appointments.get(id);
  }
  @Permissions('appointment.manage')
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateDto) {
    return this.appointments.update(id, body);
  }
  @Permissions('appointment.manage')
  @Post(':id/confirm')
  @HttpCode(200)
  confirm(@Param('id', ParseUUIDPipe) id: string) {
    return this.appointments.confirm(id);
  }
  @Permissions('appointment.manage')
  @Post(':id/check-in')
  @HttpCode(200)
  @ApiOperation({ summary: 'The customer arrived; issues a queue token unless issueToken is false' })
  checkIn(@Param('id', ParseUUIDPipe) id: string, @Body() body: CheckInDto) {
    return this.appointments.checkIn(id, body.issueToken);
  }
  @Permissions('appointment.manage')
  @Post(':id/start')
  @HttpCode(200)
  start(@Param('id', ParseUUIDPipe) id: string) {
    return this.appointments.start(id);
  }
  @Permissions('appointment.manage')
  @Post(':id/complete')
  @HttpCode(200)
  complete(@Param('id', ParseUUIDPipe) id: string) {
    return this.appointments.complete(id);
  }
  @Permissions('appointment.manage')
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() body: CancelDto) {
    return this.appointments.cancel(id, body.reason);
  }
  @Permissions('appointment.manage')
  @Post(':id/no-show')
  @HttpCode(200)
  noShow(@Param('id', ParseUUIDPipe) id: string) {
    return this.appointments.noShow(id);
  }
  @Permissions('appointment.manage')
  @Post(':id/reschedule')
  @HttpCode(200)
  @ApiOperation({ summary: 'Creates a new appointment linked to this one; this one becomes RESCHEDULED' })
  reschedule(@Param('id', ParseUUIDPipe) id: string, @Body() body: RescheduleDto) {
    return this.appointments.reschedule(id, body);
  }
}

/** Customers manage their own appointments. */
@ApiTags('Appointments')
@ApiBearerAuth()
@Controller('me/appointments')
export class MyAppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  @Permissions('self.appointments')
  @Get()
  list(@Query() query: MyQueryDto) {
    return this.appointments.mine(query);
  }
  @Permissions('self.appointments')
  @Post()
  book(@Body() body: SelfDto) {
    return this.appointments.bookMine(body);
  }
  @Permissions('self.appointments')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.appointments.getMine(id);
  }
  @Permissions('self.appointments')
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() body: CancelDto) {
    return this.appointments.cancelMine(id, body.reason);
  }
  @Permissions('self.appointments')
  @Post(':id/reschedule')
  @HttpCode(200)
  reschedule(@Param('id', ParseUUIDPipe) id: string, @Body() body: RescheduleDto) {
    return this.appointments.rescheduleMine(id, body);
  }
}

/** Booking without an account, for centres that switched it on. */
@ApiTags('Public')
@Controller('public/appointments')
export class PublicAppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  @Public()
  @RateLimit({ name: 'guest-booking-options', limit: 60, windowSeconds: 60 })
  @Get('options')
  @ApiOperation({ summary: 'Whether the centre accepts guest bookings, with its branches and services' })
  options(@Query('tenant') tenant?: string) {
    return this.appointments.publicOptions(tenant?.slice(0, 60));
  }
  @Public()
  @RateLimit({ name: 'guest-booking-availability', limit: 60, windowSeconds: 60 })
  @Get('availability')
  availability(@Query() query: PublicAvailabilityDto) {
    return this.appointments.publicAvailability(query);
  }
  @Public()
  @RateLimit({ name: 'guest-booking', limit: 20, windowSeconds: 3600 })
  @Post()
  @ApiOperation({ summary: 'Book as a guest (name + phone)' })
  book(@Body() body: GuestDto) {
    return this.appointments.bookAsGuest(body);
  }
  @Public()
  @RateLimit({ name: 'guest-booking-cancel', limit: 10, windowSeconds: 3600 })
  @Post('cancel')
  @HttpCode(200)
  cancel(@Body() body: GuestCancelDto) {
    return this.appointments.cancelAsGuest(body.token, body.reason);
  }
}
