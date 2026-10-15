import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type {
  AppointmentListQuery, AvailabilityQuery, CreateAppointmentInput, GuestAppointmentInput, MyAppointmentsQuery, RescheduleAppointmentInput,
  SelfAppointmentInput, UpdateAppointmentInput,
} from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { ctx, isStaff, runAsTenant } from '../../common/context';
import { signPayload, verifyPayload } from '../../common/crypto';
import { Prisma, TenantDb, Tx } from '../../common/db/prisma.service';
import { DomainEvents } from '../../common/events.service';
import { Errors, found } from '../../common/errors';
import { assertCustomerNotErased, isErasedCustomer } from '../../common/customer-ref';
import { JobQueue } from '../../common/jobs/job-queue';
import { pageArgs, pageResult } from '../../common/pagination';
import { assertBranchAccess, branchFilter, ownCustomerId } from '../../common/scope';
import { TenantDirectory } from '../../common/tenant-directory';
import { QueueService } from '../queue/queue.service';
import { TenantResolver } from '../tenancy/tenant-resolver.service';
import { CalendarService, HOLDING } from './calendar.service';
import { localParts, reminderDue, safeTimeZone, windowCovers, zonedTimeToUtc } from './slots';

export const REMINDER_JOB = 'appointments.reminders';
export const NO_SHOW_JOB = 'appointments.no_shows';
const SORT = ['startsAt', 'createdAt', 'status'] as const;
const GUEST_KIND = 'guest-appointment';
const CUSTOMER_FACING = ['TRIAL', 'ACTIVE', 'PAST_DUE'];

type Status = 'BOOKED' | 'CONFIRMED' | 'CHECKED_IN' | 'IN_SERVICE' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW' | 'RESCHEDULED';
/** Allowed status changes. Anything else is rejected with INVALID_TRANSITION. */
export const APPOINTMENT_TRANSITIONS: Record<Status, Status[]> = {
  BOOKED: ['CONFIRMED', 'CHECKED_IN', 'CANCELLED', 'NO_SHOW', 'RESCHEDULED'],
  CONFIRMED: ['CHECKED_IN', 'CANCELLED', 'NO_SHOW', 'RESCHEDULED'],
  CHECKED_IN: ['IN_SERVICE', 'COMPLETED', 'CANCELLED', 'NO_SHOW'],
  IN_SERVICE: ['COMPLETED'],
  // A late arrival can still be checked in.
  NO_SHOW: ['CHECKED_IN'],
  COMPLETED: [],
  CANCELLED: [],
  RESCHEDULED: [],
};
const LABEL: Record<Status, string> = { BOOKED: 'booked', CONFIRMED: 'confirmed', CHECKED_IN: 'checked in', IN_SERVICE: 'in service', COMPLETED: 'completed', CANCELLED: 'cancelled', NO_SHOW: 'marked as a no-show', RESCHEDULED: 'rescheduled' };

const include = {
  branch: { select: { name: true, nameAr: true, timezone: true } },
  customer: { select: { fullName: true, phone: true, status: true } },
  service: { select: { name: true, nameAr: true } },
  staff: { select: { user: { select: { fullName: true } } } },
  rescheduledTo: { select: { id: true } },
} as const;
type Row = Prisma.AppointmentGetPayload<{ include: typeof include }>;

interface Placement {
  branchId: string;
  serviceId?: string | null;
  startsAt: Date;
  customerId?: string | null;
  guestName?: string | null;
  guestPhone?: string | null;
  staffId?: string | null;
  requestId?: string | null;
  notes?: string | null;
  source: 'STAFF' | 'CUSTOMER' | 'GUEST';
  rescheduledFromId?: string | null;
  /** Appointment being replaced: it does not count as a clash for the customer or the staff member. */
  ignoreAppointmentId?: string | null;
  checkAccess?: boolean;
}

@Injectable()
export class AppointmentsService implements OnModuleInit {
  private readonly logger = new Logger(AppointmentsService.name);

  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly jobs: JobQueue,
    private readonly tenants: TenantDirectory,
    private readonly resolver: TenantResolver,
    private readonly calendar: CalendarService,
    private readonly queue: QueueService,
  ) {}

  onModuleInit() {
    const at = (payload: { now?: string } | undefined) => (payload?.now ? new Date(payload.now) : new Date());
    this.jobs.register(REMINDER_JOB, async (payload: { now?: string }) => void (await this.tenants.forEachTenant(REMINDER_JOB, async () => void (await this.sendReminders(at(payload))))), { attempts: 1 });
    this.jobs.register(NO_SHOW_JOB, async (payload: { now?: string }) => void (await this.tenants.forEachTenant(NO_SHOW_JOB, async () => void (await this.markNoShows(at(payload))))), { attempts: 1 });
    this.jobs.schedule({ name: REMINDER_JOB, everySeconds: 900, description: 'Emit appointment reminders (24 h and 2 h before by default)' });
    this.jobs.schedule({ name: NO_SHOW_JOB, everySeconds: 900, description: 'Mark appointments nobody checked in for as no-shows' });
  }

  // ------------------------------------------------------------------ shapes
  private local(row: { startsAt: Date; endsAt: Date; branch: { timezone: string } }) {
    const tz = safeTimeZone(row.branch.timezone);
    const start = localParts(row.startsAt, tz);
    return { localDate: start.date, localTime: start.time, localEndTime: localParts(row.endsAt, tz).time, timezone: tz };
  }
  private staffView(row: Row, noShows?: Map<string, number>) {
    return {
      id: row.id,
      branchId: row.branchId,
      branchName: row.branch.name,
      customerId: row.customerId,
      customerName: row.customer?.fullName ?? null,
      customerErased: isErasedCustomer(row.customer),
      customerPhone: row.customer?.phone ?? null,
      guestName: row.guestName,
      guestPhone: row.guestPhone,
      serviceId: row.serviceId,
      serviceName: row.service?.name ?? null,
      requestId: row.requestId,
      staffId: row.staffId,
      staffName: row.staff?.user.fullName ?? null,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      ...this.local(row),
      status: row.status,
      source: row.source,
      notes: row.notes,
      cancelledReason: row.cancelledReason,
      rescheduledFromId: row.rescheduledFromId,
      rescheduledToId: row.rescheduledTo[0]?.id ?? null,
      checkedInAt: row.checkedInAt,
      reminderSentAt: row.reminderSentAt,
      createdAt: row.createdAt,
      /** How often this customer did not show up before (all branches). */
      customerNoShowCount: row.customerId ? (noShows?.get(row.customerId) ?? 0) : 0,
    };
  }
  /** What a customer sees of their own appointment: no staff notes, no staff names. */
  private customerView(row: Row, cutoffMinutes: number, now = new Date()) {
    const changeable = ['BOOKED', 'CONFIRMED'].includes(row.status) && now.getTime() < row.startsAt.getTime() - cutoffMinutes * 60_000;
    return {
      id: row.id,
      branchId: row.branchId,
      branchName: row.branch.name,
      branchNameAr: row.branch.nameAr,
      serviceId: row.serviceId,
      serviceName: row.service?.name ?? null,
      serviceNameAr: row.service?.nameAr ?? null,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      ...this.local(row),
      status: row.status,
      cancelledReason: row.cancelledReason,
      rescheduledFromId: row.rescheduledFromId,
      rescheduledToId: row.rescheduledTo[0]?.id ?? null,
      canCancel: changeable,
      canReschedule: changeable,
    };
  }
  private async noShowCounts(tx: Tx, customerIds: string[]): Promise<Map<string, number>> {
    if (!customerIds.length) return new Map();
    const rows = await tx.appointment.groupBy({ by: ['customerId'], where: { tenantId: this.db.tenantId, status: 'NO_SHOW', customerId: { in: customerIds } }, _count: { _all: true } });
    return new Map(rows.map((r) => [r.customerId as string, r._count._all]));
  }
  private async load(tx: Tx, id: string, opts: { checkAccess?: boolean } = {}): Promise<Row> {
    const row = found(await tx.appointment.findFirst({ where: { id, tenantId: this.db.tenantId }, include }), 'Appointment');
    if (opts.checkAccess !== false) assertBranchAccess(row.branchId);
    return row;
  }
  private async lock(tx: Tx, id: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "appointments" WHERE "id" = ${id}::uuid AND "tenantId" = ${this.db.tenantId}::uuid FOR UPDATE`;
    if (!rows.length) throw Errors.notFound('Appointment');
  }

  // ------------------------------------------------------------------ availability
  /** Free and full slots of a branch day, in the branch time zone. */
  async availability(query: AvailabilityQuery, options: { checkAccess?: boolean; publicView?: boolean } = {}) {
    // Customers get the same reduced view as the public page: free or not, nothing about staff or load.
    const opts = { ...options, publicView: options.publicView ?? !isStaff() };
    return this.db.tx(async (tx) => {
      const now = new Date();
      const calendar = await this.calendar.dayCalendar(tx, query.branchId, query.date, query.serviceId, { checkAccess: opts.checkAccess, now });
      if (!calendar.branch.isActive) throw Errors.notFound('Branch');
      if (query.serviceId) found(await tx.service.findFirst({ where: { id: query.serviceId, tenantId: this.db.tenantId, deletedAt: null, isActive: true }, select: { id: true } }), 'Service');
      let slots = this.calendar.slots(calendar, query.date, query.serviceId, now);
      // Optional: only times at which one particular staff member is on duty and free.
      let staffBusy: Array<{ startsAt: Date; endsAt: Date }> = [];
      if (query.staffId && !opts.publicView) {
        found(await tx.tenantMembership.findFirst({ where: { id: query.staffId, tenantId: this.db.tenantId, kind: 'STAFF' }, select: { id: true } }), 'Staff member');
        const dayStart = zonedTimeToUtc(query.date, '00:00', calendar.branch.timezone);
        staffBusy = await tx.appointment.findMany({ where: { tenantId: this.db.tenantId, staffId: query.staffId, status: { in: ['BOOKED', 'CONFIRMED', 'CHECKED_IN', 'IN_SERVICE'] }, startsAt: { gte: dayStart, lt: new Date(dayStart.getTime() + 36 * 3_600_000) } }, select: { startsAt: true, endsAt: true } });
      }
      // A staff member without any working schedule is not restricted to particular hours.
      const staffHasSchedule = query.staffId && !opts.publicView ? (await tx.staffSchedule.count({ where: { tenantId: this.db.tenantId, membershipId: query.staffId, isActive: true } })) > 0 : false;
      slots = slots.map((slot) => {
        if (!query.staffId || opts.publicView) return slot;
        const start = new Date(slot.startsAt);
        const end = new Date(slot.endsAt);
        const onDuty = !staffHasSchedule || this.calendar.staffOnDuty(calendar, start, end).includes(query.staffId);
        const free = !staffBusy.some((b) => b.startsAt < end && b.endsAt > start);
        return onDuty && free ? slot : { ...slot, available: false };
      });
      return {
        branchId: calendar.branch.id,
        branchName: calendar.branch.name,
        date: query.date,
        timezone: calendar.branch.timezone,
        serviceId: query.serviceId ?? null,
        closed: !!calendar.closed,
        closedReason: opts.publicView ? null : (calendar.closed?.reason ?? null),
        bookableUntil: calendar.lastDate,
        slots: slots.map((slot) => ({
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          localStart: slot.localStart,
          localEnd: slot.localEnd,
          available: slot.available,
          remaining: slot.remaining,
          // How busy a slot is, and who works when, is for staff only.
          ...(opts.publicView ? {} : { capacity: slot.capacity, booked: slot.booked, staffOnDuty: this.calendar.staffOnDuty(calendar, new Date(slot.startsAt), new Date(slot.endsAt)).length }),
        })),
      };
    });
  }

  // ------------------------------------------------------------------ booking
  /**
   * Creates the appointment if the slot exists, is in the future and has a
   * free place. The slot rules of the branch day are locked first, so two
   * people can never take the last place.
   */
  private async place(tx: Tx, input: Placement, now = new Date()): Promise<Row> {
    const tenantId = this.db.tenantId;
    const branch = await this.calendar.branch(tx, input.branchId, { requireActive: true, checkAccess: input.checkAccess });
    const local = localParts(input.startsAt, branch.timezone);
    const calendar = await this.calendar.dayCalendar(tx, branch.id, local.date, input.serviceId, { lock: true, checkAccess: input.checkAccess, now });

    if (input.serviceId) {
      const service = found(await tx.service.findFirst({ where: { id: input.serviceId, tenantId, deletedAt: null }, select: { id: true, isActive: true } }), 'Service');
      if (!service.isActive) throw Errors.conflict('SERVICE_INACTIVE', 'This service is not offered at the moment.');
    }
    if (input.customerId) {
      await assertCustomerNotErased(tx, tenantId, input.customerId);
      const customer = found(await tx.customer.findFirst({ where: { id: input.customerId, tenantId, deletedAt: null }, select: { id: true, status: true } }), 'Customer');
      if (customer.status !== 'ACTIVE') throw Errors.conflict('CUSTOMER_INACTIVE', 'This customer record is archived. Restore it before booking.');
    }
    if (input.requestId) found(await tx.serviceRequest.findFirst({ where: { id: input.requestId, tenantId, ...(input.customerId ? { customerId: input.customerId } : {}) }, select: { id: true } }), 'Request');

    if (input.startsAt.getTime() <= now.getTime()) throw Errors.unprocessable('SLOT_IN_PAST', 'That time has already passed. Please choose a later time.');
    if (calendar.closed) throw Errors.unprocessable('BRANCH_CLOSED', `The branch is closed on that day${calendar.closed.reason ? ` (${calendar.closed.reason})` : ''}. Please choose another day.`);
    if (local.date > calendar.lastDate) throw Errors.unprocessable('TOO_FAR_AHEAD', `Appointments can be booked up to ${calendar.settings.maxDaysAhead} days ahead.`);
    const slot = this.calendar.slots(calendar, local.date, input.serviceId, now).find((s) => s.startsAt === input.startsAt.toISOString());
    if (!slot) throw Errors.unprocessable('SLOT_UNAVAILABLE', 'That time is not offered for booking. Please choose one of the available times.');
    if (slot.remaining <= 0) throw Errors.conflict('SLOT_FULL', 'That time has just been taken. Please choose another time.');
    const endsAt = new Date(slot.endsAt);

    const active = { in: ['BOOKED', 'CONFIRMED', 'CHECKED_IN', 'IN_SERVICE'] as Status[] };
    const overlapping = { startsAt: { lt: endsAt }, endsAt: { gt: input.startsAt }, ...(input.ignoreAppointmentId ? { id: { not: input.ignoreAppointmentId } } : {}) };
    if (input.customerId) {
      const clash = await tx.appointment.findFirst({ where: { tenantId, customerId: input.customerId, status: active, ...overlapping }, select: { id: true } });
      if (clash) throw Errors.conflict('ALREADY_BOOKED', 'There is already an appointment at that time.', { appointmentId: clash.id });
    } else if (input.guestPhone) {
      const clash = await tx.appointment.findFirst({ where: { tenantId, guestPhone: input.guestPhone, status: active, ...overlapping }, select: { id: true } });
      if (clash) throw Errors.conflict('ALREADY_BOOKED', 'There is already an appointment at that time for this phone number.');
    }
    if (input.staffId) await this.assertStaffFree(tx, input.staffId, calendar, input.startsAt, endsAt, input.ignoreAppointmentId ?? null);

    const row = await tx.appointment.create({
      data: {
        tenantId,
        branchId: branch.id,
        customerId: input.customerId ?? null,
        guestName: input.customerId ? null : (input.guestName ?? null),
        guestPhone: input.customerId ? null : (input.guestPhone ?? null),
        serviceId: input.serviceId ?? null,
        requestId: input.requestId ?? null,
        staffId: input.staffId ?? null,
        startsAt: input.startsAt,
        endsAt,
        status: 'BOOKED',
        source: input.source,
        notes: input.notes ?? null,
        rescheduledFromId: input.rescheduledFromId ?? null,
        createdById: ctx().userId ?? null,
      },
      include,
    });
    await this.audit.log(
      { action: input.rescheduledFromId ? 'appointment.rescheduled' : 'appointment.booked', resourceType: 'Appointment', resourceId: row.id, after: { branchId: row.branchId, customerId: row.customerId, guest: !!row.guestName, serviceId: row.serviceId, startsAt: row.startsAt, source: row.source, rescheduledFromId: row.rescheduledFromId } },
      tx,
    );
    await this.events.emit(tx, 'appointment.created', { appointmentId: row.id, customerId: row.customerId, branchId: row.branchId, startsAt: row.startsAt.toISOString() });
    return row;
  }

  /** The staff member exists, is available, works at that time (when they have a schedule) and is not double-booked. */
  private async assertStaffFree(tx: Tx, staffId: string, calendar: Awaited<ReturnType<CalendarService['dayCalendar']>>, startsAt: Date, endsAt: Date, ignoreAppointmentId: string | null) {
    const tenantId = this.db.tenantId;
    const member = found(await tx.tenantMembership.findFirst({ where: { id: staffId, tenantId, kind: 'STAFF' }, select: { id: true, status: true, isAvailable: true, allBranches: true, membershipBranches: { select: { branchId: true } }, user: { select: { fullName: true } } } }), 'Staff member');
    const name = member.user.fullName;
    if (member.status !== 'ACTIVE' || !member.isAvailable) throw Errors.conflict('STAFF_UNAVAILABLE', `${name} is not available at the moment.`);
    if (!member.allBranches && !member.membershipBranches.some((b) => b.branchId === calendar.branch.id)) throw Errors.conflict('STAFF_UNAVAILABLE', `${name} does not work at this branch.`);
    const anySchedule = await tx.staffSchedule.count({ where: { tenantId, membershipId: staffId, isActive: true } });
    if (anySchedule) {
      const covered = calendar.staffWindows.some((w) => w.membershipId === staffId && windowCovers(w, startsAt, endsAt, calendar.branch.timezone));
      if (!covered) throw Errors.conflict('STAFF_UNAVAILABLE', `${name} is not scheduled to work at that time.`);
    }
    const busy = await tx.appointment.findFirst({
      where: { tenantId, staffId, status: { in: ['BOOKED', 'CONFIRMED', 'CHECKED_IN', 'IN_SERVICE'] }, startsAt: { lt: endsAt }, endsAt: { gt: startsAt }, ...(ignoreAppointmentId ? { id: { not: ignoreAppointmentId } } : {}) },
      select: { id: true },
    });
    if (busy) throw Errors.conflict('STAFF_UNAVAILABLE', `${name} already has an appointment at that time.`);
  }

  /** Staff books for a customer or a walk-in guest. */
  async book(input: CreateAppointmentInput) {
    return this.db.tx(async (tx) => {
      const row = await this.place(tx, { ...input, startsAt: new Date(input.startsAt), source: 'STAFF' });
      return this.staffView(row, await this.noShowCounts(tx, row.customerId ? [row.customerId] : []));
    });
  }

  // ------------------------------------------------------------------ staff: list / read / update
  async list(query: AppointmentListQuery) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const where: Prisma.AppointmentWhereInput = {
        tenantId,
        ...(branchFilter() ? { branchId: branchFilter() } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.customerId ? { customerId: query.customerId } : {}),
        ...(query.staffId ? { staffId: query.staffId } : {}),
        ...(query.serviceId ? { serviceId: query.serviceId } : {}),
        ...(query.q ? { OR: [{ guestName: { contains: query.q, mode: 'insensitive' } }, { guestPhone: { contains: query.q } }, { customer: { fullName: { contains: query.q, mode: 'insensitive' } } }] } : {}),
      };
      if (query.branchId) {
        assertBranchAccess(query.branchId);
        where.branchId = query.branchId;
      }
      if (query.date) {
        // One day of the branch calendar (centre time zone when no branch is chosen).
        const tz = query.branchId ? (await this.calendar.branch(tx, query.branchId)).timezone : safeTimeZone((await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { timezone: true } })).timezone);
        const start = zonedTimeToUtc(query.date, '00:00', tz);
        const next = new Date(new Date(`${query.date}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
        where.startsAt = { gte: start, lt: zonedTimeToUtc(next, '00:00', tz) };
      } else if (query.from || query.to) {
        where.startsAt = { ...(query.from ? { gte: new Date(`${query.from}T00:00:00.000Z`) } : {}), ...(query.to ? { lte: new Date(`${query.to}T23:59:59.999Z`) } : {}) };
      }
      const rows = await tx.appointment.findMany({ where, ...pageArgs(query, SORT, 'startsAt:asc'), include });
      const total = await tx.appointment.count({ where });
      const noShows = await this.noShowCounts(tx, [...new Set(rows.map((r) => r.customerId).filter((v): v is string => !!v))]);
      return pageResult(rows.map((r) => this.staffView(r, noShows)), total, query);
    });
  }

  async get(id: string) {
    return this.db.tx(async (tx) => {
      const row = await this.load(tx, id);
      const token = await tx.queueToken.findFirst({ where: { tenantId: this.db.tenantId, appointmentId: id }, orderBy: { issuedAt: 'desc' }, select: { id: true, tokenNo: true, status: true, counter: true } });
      return { ...this.staffView(row, await this.noShowCounts(tx, row.customerId ? [row.customerId] : [])), queueToken: token };
    });
  }

  async update(id: string, input: UpdateAppointmentInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      await this.lock(tx, id);
      const before = await this.load(tx, id);
      if (['COMPLETED', 'CANCELLED', 'RESCHEDULED'].includes(before.status)) throw Errors.conflict('APPOINTMENT_CLOSED', `This appointment is ${LABEL[before.status as Status]} and can no longer be changed.`);
      if (input.staffId) {
        const calendar = await this.calendar.dayCalendar(tx, before.branchId, localParts(before.startsAt, safeTimeZone(before.branch.timezone)).date, before.serviceId);
        await this.assertStaffFree(tx, input.staffId, calendar, before.startsAt, before.endsAt, id);
      }
      if (input.requestId) found(await tx.serviceRequest.findFirst({ where: { id: input.requestId, tenantId }, select: { id: true } }), 'Request');
      const row = await tx.appointment.update({
        where: { id },
        data: { ...(input.notes !== undefined ? { notes: input.notes } : {}), ...(input.staffId !== undefined ? { staffId: input.staffId } : {}), ...(input.requestId !== undefined ? { requestId: input.requestId } : {}) },
        include,
      });
      await this.audit.log({ action: 'appointment.updated', resourceType: 'Appointment', resourceId: id, before: { notes: before.notes, staffId: before.staffId, requestId: before.requestId }, after: input }, tx);
      return this.staffView(row, await this.noShowCounts(tx, row.customerId ? [row.customerId] : []));
    });
  }

  // ------------------------------------------------------------------ status changes
  private async move(tx: Tx, id: string, to: Status, data: Prisma.AppointmentUncheckedUpdateInput = {}, opts: { checkAccess?: boolean; summary?: string } = {}): Promise<Row> {
    await this.lock(tx, id);
    const before = await this.load(tx, id, { checkAccess: opts.checkAccess });
    const from = before.status as Status;
    if (!APPOINTMENT_TRANSITIONS[from].includes(to)) {
      throw Errors.conflict('INVALID_TRANSITION', `This appointment is ${LABEL[from]} and cannot be ${LABEL[to]}.`, { from, to });
    }
    const row = await tx.appointment.update({ where: { id }, data: { ...data, status: to }, include });
    await this.audit.log({ action: `appointment.${to.toLowerCase()}`, resourceType: 'Appointment', resourceId: id, summary: opts.summary, before: { status: from }, after: { status: to } }, tx);
    return row;
  }
  private async view(tx: Tx, row: Row) {
    return this.staffView(row, await this.noShowCounts(tx, row.customerId ? [row.customerId] : []));
  }

  confirm(id: string) {
    return this.db.tx(async (tx) => this.view(tx, await this.move(tx, id, 'CONFIRMED')));
  }
  /** The customer arrived. By default a queue token is issued in the same transaction. */
  checkIn(id: string, issueToken = true) {
    return this.db.tx(async (tx) => {
      const current = await this.load(tx, id);
      const tz = safeTimeZone(current.branch.timezone);
      if (localParts(current.startsAt, tz).date !== localParts(new Date(), tz).date) {
        throw Errors.unprocessable('CHECK_IN_WRONG_DAY', 'Customers can only be checked in on the day of their appointment.');
      }
      const row = await this.move(tx, id, 'CHECKED_IN', { checkedInAt: new Date() });
      const queueToken = issueToken ? await this.queue.issue({ branchId: row.branchId, appointmentId: row.id }) : null;
      return { ...(await this.view(tx, row)), queueToken: queueToken ? { id: queueToken.id, tokenNo: queueToken.tokenNo, status: queueToken.status, counter: queueToken.counter } : null };
    });
  }
  start(id: string) {
    return this.db.tx(async (tx) => this.view(tx, await this.move(tx, id, 'IN_SERVICE')));
  }
  complete(id: string) {
    return this.db.tx(async (tx) => {
      const row = await this.move(tx, id, 'COMPLETED');
      // Somebody who was served without the queue screen still leaves the queue.
      await tx.queueToken.updateMany({ where: { tenantId: this.db.tenantId, appointmentId: id, status: { in: ['WAITING', 'CALLED', 'SERVING'] } }, data: { status: 'COMPLETED', completedAt: new Date() } });
      return this.view(tx, row);
    });
  }
  noShow(id: string) {
    return this.db.tx(async (tx) => {
      const current = await this.load(tx, id);
      if (current.startsAt.getTime() > Date.now()) throw Errors.unprocessable('TOO_EARLY', 'The appointment has not started yet.');
      const row = await this.move(tx, id, 'NO_SHOW');
      await tx.queueToken.updateMany({ where: { tenantId: this.db.tenantId, appointmentId: id, status: { in: ['WAITING', 'CALLED'] } }, data: { status: 'NO_SHOW', completedAt: new Date() } });
      return this.view(tx, row);
    });
  }
  private async cancelRow(tx: Tx, id: string, reason: string | null | undefined, opts: { checkAccess?: boolean } = {}) {
    const row = await this.move(tx, id, 'CANCELLED', { cancelledReason: reason ?? null }, { ...opts, summary: reason ?? undefined });
    await tx.queueToken.updateMany({ where: { tenantId: this.db.tenantId, appointmentId: id, status: { in: ['WAITING', 'CALLED'] } }, data: { status: 'CANCELLED', completedAt: new Date() } });
    return row;
  }
  cancel(id: string, reason?: string | null) {
    return this.db.tx(async (tx) => this.view(tx, await this.cancelRow(tx, id, reason)));
  }

  /** Moves the booking to another time: a NEW appointment linked by rescheduledFromId; the old one becomes RESCHEDULED. */
  private async rescheduleRow(tx: Tx, id: string, input: RescheduleAppointmentInput, source: Placement['source'], opts: { checkAccess?: boolean } = {}): Promise<Row> {
    await this.lock(tx, id);
    const old = await this.load(tx, id, opts);
    if (!APPOINTMENT_TRANSITIONS[old.status as Status].includes('RESCHEDULED')) {
      throw Errors.conflict('INVALID_TRANSITION', `This appointment is ${LABEL[old.status as Status]} and cannot be rescheduled.`, { from: old.status, to: 'RESCHEDULED' });
    }
    const startsAt = new Date(input.startsAt);
    const branchId = input.branchId ?? old.branchId;
    if (startsAt.getTime() === old.startsAt.getTime() && branchId === old.branchId) throw Errors.unprocessable('SAME_SLOT', 'Choose a different time to reschedule.');
    const fresh = await this.place(tx, {
      branchId,
      serviceId: old.serviceId,
      startsAt,
      customerId: old.customerId,
      guestName: old.guestName,
      guestPhone: old.guestPhone,
      requestId: old.requestId,
      notes: old.notes,
      source,
      rescheduledFromId: old.id,
      ignoreAppointmentId: old.id,
      checkAccess: opts.checkAccess,
    });
    await this.move(tx, id, 'RESCHEDULED', {}, { ...opts, summary: input.reason ?? undefined });
    return fresh;
  }
  reschedule(id: string, input: RescheduleAppointmentInput) {
    return this.db.tx(async (tx) => this.view(tx, await this.rescheduleRow(tx, id, input, 'STAFF')));
  }

  // ------------------------------------------------------------------ customers (own appointments only)
  async mine(query: MyAppointmentsQuery) {
    const customerId = ownCustomerId();
    return this.db.tx(async (tx) => {
      const settings = await this.calendar.settings(tx);
      const where: Prisma.AppointmentWhereInput = { tenantId: this.db.tenantId, customerId, ...(query.upcoming ? { startsAt: { gte: new Date() }, status: { in: ['BOOKED', 'CONFIRMED'] } } : {}) };
      const rows = await tx.appointment.findMany({ where, ...pageArgs(query, SORT, query.upcoming ? 'startsAt:asc' : 'startsAt:desc'), include });
      const total = await tx.appointment.count({ where });
      return pageResult(rows.map((r) => this.customerView(r, settings.customerCancelCutoffMinutes)), total, query);
    });
  }
  private async own(tx: Tx, id: string): Promise<Row> {
    return found(await tx.appointment.findFirst({ where: { id, tenantId: this.db.tenantId, customerId: ownCustomerId() }, include }), 'Appointment');
  }
  async getMine(id: string) {
    return this.db.tx(async (tx) => this.customerView(await this.own(tx, id), (await this.calendar.settings(tx)).customerCancelCutoffMinutes));
  }
  async bookMine(input: SelfAppointmentInput) {
    const customerId = ownCustomerId();
    return this.db.tx(async (tx) => {
      const row = await this.place(tx, { ...input, startsAt: new Date(input.startsAt), customerId, source: 'CUSTOMER', checkAccess: false });
      return this.customerView(row, (await this.calendar.settings(tx)).customerCancelCutoffMinutes);
    });
  }
  /** Customers may change a booking until it starts (minus the centre's cut-off). */
  private assertCustomerMayChange(row: { status: string; startsAt: Date }, cutoffMinutes: number, action: 'cancelled' | 'rescheduled') {
    if (!['BOOKED', 'CONFIRMED'].includes(row.status)) throw Errors.conflict('INVALID_TRANSITION', `This appointment is ${LABEL[row.status as Status]} and cannot be ${action}.`);
    if (Date.now() >= row.startsAt.getTime()) throw Errors.conflict('TOO_LATE_TO_CHANGE', `This appointment has already started and can no longer be ${action}. Please contact the centre.`);
    if (Date.now() >= row.startsAt.getTime() - cutoffMinutes * 60_000) {
      throw Errors.conflict('TOO_LATE_TO_CHANGE', `Appointments can be ${action} online until ${cutoffMinutes} minutes before they start. Please contact the centre.`);
    }
  }
  async cancelMine(id: string, reason?: string | null) {
    return this.db.tx(async (tx) => {
      const settings = await this.calendar.settings(tx);
      this.assertCustomerMayChange(await this.own(tx, id), settings.customerCancelCutoffMinutes, 'cancelled');
      return this.customerView(await this.cancelRow(tx, id, reason ?? 'Cancelled by the customer', { checkAccess: false }), settings.customerCancelCutoffMinutes);
    });
  }
  async rescheduleMine(id: string, input: RescheduleAppointmentInput) {
    return this.db.tx(async (tx) => {
      const settings = await this.calendar.settings(tx);
      this.assertCustomerMayChange(await this.own(tx, id), settings.customerCancelCutoffMinutes, 'rescheduled');
      return this.customerView(await this.rescheduleRow(tx, id, input, 'CUSTOMER', { checkAccess: false }), settings.customerCancelCutoffMinutes);
    });
  }

  // ------------------------------------------------------------------ public guest booking
  /** Runs `fn` inside the centre a public page belongs to, if that centre accepts guest bookings. */
  private async asGuestOf<T>(slug: string | undefined, fn: () => Promise<T>, opts: { requireEnabled?: boolean } = {}): Promise<T> {
    const tenant = await this.resolver.require(slug);
    if (!CUSTOMER_FACING.includes(tenant.status)) throw Errors.forbidden('TENANT_UNAVAILABLE', 'This centre is currently not available.');
    return runAsTenant(
      tenant.id,
      async () => {
        if (opts.requireEnabled !== false && !(await this.calendar.getSettings()).guestBookingEnabled) {
          throw Errors.forbidden('GUEST_BOOKING_DISABLED', 'This centre does not accept online bookings without an account. Please sign in or contact the centre.');
        }
        return fn();
      },
      { actorType: 'CUSTOMER', actorLabel: 'guest', ip: ctx().ip, requestId: ctx().requestId },
    );
  }
  /** Branches and services a visitor can choose from. */
  publicOptions(slug?: string) {
    return this.asGuestOf(
      slug,
      () =>
        this.db.tx(async (tx) => {
          const tenantId = this.db.tenantId;
          const settings = await this.calendar.settings(tx);
          const branches = await tx.branch.findMany({ where: { tenantId, isActive: true }, orderBy: [{ isHeadOffice: 'desc' }, { name: 'asc' }], select: { id: true, name: true, nameAr: true, address: true, timezone: true } });
          const services = settings.guestBookingEnabled
            ? await tx.service.findMany({ where: { tenantId, isActive: true, isPublic: true, deletedAt: null }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { id: true, name: true, nameAr: true } })
            : [];
          return { guestBookingEnabled: settings.guestBookingEnabled, maxDaysAhead: settings.maxDaysAhead, branches: settings.guestBookingEnabled ? branches : [], services };
        }),
      { requireEnabled: false },
    );
  }
  publicAvailability(query: AvailabilityQuery & { tenant?: string }) {
    return this.asGuestOf(query.tenant, () => this.availability({ branchId: query.branchId, date: query.date, serviceId: query.serviceId }, { checkAccess: false, publicView: true }));
  }
  bookAsGuest(input: GuestAppointmentInput) {
    return this.asGuestOf(input.tenant, () =>
      this.db.tx(async (tx) => {
        const tenantId = this.db.tenantId;
        // One phone number cannot fill the calendar.
        const pending = await tx.appointment.count({ where: { tenantId, guestPhone: input.guestPhone, status: { in: ['BOOKED', 'CONFIRMED'] }, startsAt: { gt: new Date() } } });
        if (pending >= 2) throw Errors.conflict('TOO_MANY_BOOKINGS', 'There are already two upcoming appointments for this phone number. Please cancel one or contact the centre.');
        if (input.serviceId) found(await tx.service.findFirst({ where: { id: input.serviceId, tenantId, isActive: true, isPublic: true, deletedAt: null }, select: { id: true } }), 'Service');
        const row = await this.place(tx, { branchId: input.branchId, serviceId: input.serviceId, startsAt: new Date(input.startsAt), guestName: input.guestName, guestPhone: input.guestPhone, notes: input.notes, source: 'GUEST', checkAccess: false });
        const ttl = Math.max(3600, Math.ceil((row.startsAt.getTime() - Date.now()) / 1000) + 86_400);
        return {
          id: row.id,
          status: row.status,
          branchName: row.branch.name,
          branchNameAr: row.branch.nameAr,
          serviceName: row.service?.name ?? null,
          startsAt: row.startsAt,
          endsAt: row.endsAt,
          ...this.local(row),
          /** Keep this to cancel the booking later without an account. */
          manageToken: signPayload({ k: GUEST_KIND, t: tenantId, a: row.id }, ttl),
        };
      }),
    );
  }
  async cancelAsGuest(token: string, reason?: string | null) {
    const payload = verifyPayload<{ k?: string; t?: string; a?: string }>(token);
    if (!payload || payload.k !== GUEST_KIND || !payload.t || !payload.a) throw Errors.unauthorized('TOKEN_INVALID', 'This link is not valid or has expired. Please contact the centre.');
    return runAsTenant(
      payload.t,
      () =>
        this.db.tx(async (tx) => {
          const row = found(await tx.appointment.findFirst({ where: { id: payload.a, tenantId: payload.t, customerId: null }, select: { id: true, status: true, startsAt: true } }), 'Appointment');
          this.assertCustomerMayChange(row, (await this.calendar.settings(tx)).customerCancelCutoffMinutes, 'cancelled');
          const cancelled = await this.cancelRow(tx, row.id, reason ?? 'Cancelled by the visitor', { checkAccess: false });
          return { id: cancelled.id, status: cancelled.status };
        }),
      { actorType: 'CUSTOMER', actorLabel: 'guest', ip: ctx().ip, requestId: ctx().requestId },
    );
  }

  // ------------------------------------------------------------------ jobs (one tenant)
  /** Emits `appointment.reminder_due` for appointments entering a reminder window. `reminderSentAt` prevents repeats. */
  async sendReminders(now = new Date()): Promise<number> {
    const tenantId = this.db.tenantId;
    const settings = await this.calendar.getSettings();
    if (!settings.reminderHoursBefore.length) return 0;
    const horizon = new Date(now.getTime() + Math.max(...settings.reminderHoursBefore) * 3_600_000);
    const candidates = await this.db.tx((tx) =>
      tx.appointment.findMany({ where: { tenantId, status: { in: ['BOOKED', 'CONFIRMED'] }, startsAt: { gt: now, lte: horizon } }, select: { id: true, startsAt: true, createdAt: true, reminderSentAt: true }, orderBy: { startsAt: 'asc' }, take: 500 }),
    );
    let sent = 0;
    for (const candidate of candidates) {
      if (reminderDue({ ...candidate, hoursBefore: settings.reminderHoursBefore, now }) === null) continue;
      try {
        sent += await this.db.tx(async (tx) => {
          // Another worker may be handling the same appointment: skip it rather than wait.
          const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "appointments" WHERE "id" = ${candidate.id}::uuid AND "tenantId" = ${tenantId}::uuid FOR UPDATE SKIP LOCKED`;
          if (!locked.length) return 0;
          const a = await tx.appointment.findFirstOrThrow({ where: { id: candidate.id, tenantId }, select: { id: true, status: true, startsAt: true, createdAt: true, reminderSentAt: true, customerId: true, branchId: true } });
          if (!['BOOKED', 'CONFIRMED'].includes(a.status)) return 0;
          const hours = reminderDue({ ...a, hoursBefore: settings.reminderHoursBefore, now });
          if (hours === null) return 0;
          await tx.appointment.update({ where: { id: a.id }, data: { reminderSentAt: now } });
          await this.events.emit(tx, 'appointment.reminder_due', { appointmentId: a.id, customerId: a.customerId, branchId: a.branchId, startsAt: a.startsAt.toISOString(), hoursBefore: hours });
          return 1;
        });
      } catch (e: any) {
        this.logger.error(`appointment reminder ${candidate.id} failed: ${e?.message ?? e}`);
      }
    }
    return sent;
  }

  /** BOOKED / CONFIRMED appointments whose start passed `noShowAfterMinutes` ago without a check-in become NO_SHOW. */
  async markNoShows(now = new Date()): Promise<number> {
    const tenantId = this.db.tenantId;
    return this.db.tx(async (tx) => {
      const settings = await this.calendar.settings(tx);
      const cutoff = new Date(now.getTime() - settings.noShowAfterMinutes * 60_000);
      const rows = await tx.appointment.findMany({ where: { tenantId, status: { in: ['BOOKED', 'CONFIRMED'] }, startsAt: { lt: cutoff } }, select: { id: true, status: true }, take: 500 });
      let marked = 0;
      for (const row of rows) {
        const changed = await tx.appointment.updateMany({ where: { id: row.id, tenantId, status: { in: ['BOOKED', 'CONFIRMED'] } }, data: { status: 'NO_SHOW' } });
        if (!changed.count) continue;
        marked += 1;
        await this.audit.log({ action: 'appointment.no_show', resourceType: 'Appointment', resourceId: row.id, summary: `No check-in within ${settings.noShowAfterMinutes} minutes of the start time`, before: { status: row.status }, after: { status: 'NO_SHOW' } }, tx);
      }
      return marked;
    });
  }
}

export { HOLDING };
