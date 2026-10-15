import { Injectable } from '@nestjs/common';
import type { AppointmentSettingsInput, ClosureInput, SlotConfigInput, UpdateSlotConfigInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { assertBranchAccess, branchFilter } from '../../common/scope';
import { lockTenantSettings, saveTenantSettingsSection } from '../notifications/settings';
import { computeSlots, localParts, rulesFor, safeTimeZone, Slot, SlotRule, weekdayOf, windowCovers, zonedTimeToUtc } from './slots';

export interface AppointmentSettings {
  guestBookingEnabled: boolean;
  noShowAfterMinutes: number;
  customerCancelCutoffMinutes: number;
  reminderHoursBefore: number[];
  maxDaysAhead: number;
  limitToStaffOnDuty: boolean;
}
export const DEFAULT_APPOINTMENT_SETTINGS: AppointmentSettings = { guestBookingEnabled: false, noShowAfterMinutes: 30, customerCancelCutoffMinutes: 0, reminderHoursBefore: [24, 2], maxDaysAhead: 60, limitToStaffOnDuty: false };
/** Statuses that occupy a place in a slot. */
export const HOLDING = ['BOOKED', 'CONFIRMED', 'CHECKED_IN', 'IN_SERVICE', 'COMPLETED'] as const;

export function parseAppointmentSettings(raw: unknown): AppointmentSettings {
  const v = (raw && typeof raw === 'object' ? (raw as any).appointments : null) ?? {};
  const int = (value: unknown, min: number, max: number, fallback: number) => (Number.isInteger(value) && (value as number) >= min && (value as number) <= max ? (value as number) : fallback);
  const hours = Array.isArray(v.reminderHoursBefore) ? [...new Set(v.reminderHoursBefore.filter((h: unknown) => Number.isInteger(h) && (h as number) >= 1 && (h as number) <= 168))].sort((a: any, b: any) => b - a) : null;
  return {
    guestBookingEnabled: v.guestBookingEnabled === true,
    noShowAfterMinutes: int(v.noShowAfterMinutes, 5, 1440, DEFAULT_APPOINTMENT_SETTINGS.noShowAfterMinutes),
    customerCancelCutoffMinutes: int(v.customerCancelCutoffMinutes, 0, 10080, DEFAULT_APPOINTMENT_SETTINGS.customerCancelCutoffMinutes),
    reminderHoursBefore: (hours as number[] | null) ?? DEFAULT_APPOINTMENT_SETTINGS.reminderHoursBefore,
    maxDaysAhead: int(v.maxDaysAhead, 1, 365, DEFAULT_APPOINTMENT_SETTINGS.maxDaysAhead),
    limitToStaffOnDuty: v.limitToStaffOnDuty === true,
  };
}

export interface DayCalendar {
  branch: { id: string; name: string; nameAr: string | null; timezone: string; isActive: boolean };
  settings: AppointmentSettings;
  rules: SlotRule[];
  closed: { reason: string | null } | null;
  /** Booked places per slot start in the capacity pool of the requested service. */
  booked: Map<string, number>;
  /** Staff working windows at the branch on that weekday (available, active members only). */
  staffWindows: Array<{ membershipId: string; weekday: number; startTime: string; endTime: string }>;
  lastDate: string;
}

/** Branch calendars: bookable hours, closures, settings and the slot computation against the database. */
@Injectable()
export class CalendarService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ settings
  async settings(tx: Tx): Promise<AppointmentSettings> {
    const tenant = await tx.tenant.findFirstOrThrow({ where: { id: this.db.tenantId }, select: { settings: true } });
    return parseAppointmentSettings(tenant.settings);
  }
  getSettings() {
    return this.db.tx((tx) => this.settings(tx));
  }
  updateSettings(input: AppointmentSettingsInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const all = await lockTenantSettings(tx, tenantId);
      const before = parseAppointmentSettings(all);
      const next = parseAppointmentSettings({ appointments: { ...before, ...input } });
      await saveTenantSettingsSection(tx, tenantId, 'appointments', next);
      await this.audit.log({ action: 'appointment.settings_updated', resourceType: 'Tenant', resourceId: tenantId, before, after: input }, tx);
      return next;
    });
  }

  // ------------------------------------------------------------------ slot configs
  async branch(tx: Tx, branchId: string, opts: { requireActive?: boolean; checkAccess?: boolean } = {}) {
    const branch = found(await tx.branch.findFirst({ where: { id: branchId, tenantId: this.db.tenantId }, select: { id: true, name: true, nameAr: true, address: true, timezone: true, isActive: true } }), 'Branch');
    if (opts.checkAccess !== false) assertBranchAccess(branch.id);
    if (opts.requireActive && !branch.isActive) throw Errors.conflict('BRANCH_INACTIVE', 'This branch is not active.');
    return { ...branch, timezone: safeTimeZone(branch.timezone) };
  }
  private async assertService(tx: Tx, serviceId: string | null | undefined) {
    if (!serviceId) return null;
    return found(await tx.service.findFirst({ where: { id: serviceId, tenantId: this.db.tenantId, deletedAt: null }, select: { id: true, name: true, nameAr: true, isActive: true, categoryId: true } }), 'Service');
  }

  listSlotConfigs(filter: { branchId?: string; weekday?: number; includeInactive?: boolean }) {
    return this.db.tx((tx) =>
      tx.appointmentSlotConfig.findMany({
        where: {
          tenantId: this.db.tenantId,
          ...(filter.branchId ? { branchId: filter.branchId } : branchFilter() ? { branchId: branchFilter() } : {}),
          ...(filter.weekday !== undefined ? { weekday: filter.weekday } : {}),
          ...(filter.includeInactive ? {} : { isActive: true }),
        },
        orderBy: [{ branchId: 'asc' }, { weekday: 'asc' }, { startTime: 'asc' }],
      }),
    );
  }
  createSlotConfig(input: SlotConfigInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      await this.branch(tx, input.branchId);
      await this.assertService(tx, input.serviceId);
      const row = await tx.appointmentSlotConfig.create({ data: { tenantId, branchId: input.branchId, serviceId: input.serviceId ?? null, weekday: input.weekday, startTime: input.startTime, endTime: input.endTime, slotMinutes: input.slotMinutes, capacity: input.capacity, isActive: input.isActive } });
      await this.audit.log({ action: 'appointment.slot_config_created', resourceType: 'AppointmentSlotConfig', resourceId: row.id, after: input }, tx);
      return row;
    });
  }
  updateSlotConfig(id: string, input: UpdateSlotConfigInput) {
    return this.db.tx(async (tx) => {
      const before = found(await tx.appointmentSlotConfig.findFirst({ where: { id, tenantId: this.db.tenantId } }), 'Slot configuration');
      assertBranchAccess(before.branchId);
      if (input.serviceId) await this.assertService(tx, input.serviceId);
      const startTime = input.startTime ?? before.startTime;
      const endTime = input.endTime ?? before.endTime;
      if (startTime >= endTime) throw Errors.unprocessable('INVALID_HOURS', 'The end time must be after the start time.');
      const row = await tx.appointmentSlotConfig.update({ where: { id }, data: { ...input, serviceId: input.serviceId === undefined ? undefined : input.serviceId } });
      await this.audit.log({ action: 'appointment.slot_config_updated', resourceType: 'AppointmentSlotConfig', resourceId: id, before, after: input }, tx);
      return row;
    });
  }
  /** Existing appointments keep their time; only future availability changes. */
  deleteSlotConfig(id: string) {
    return this.db.tx(async (tx) => {
      const before = found(await tx.appointmentSlotConfig.findFirst({ where: { id, tenantId: this.db.tenantId } }), 'Slot configuration');
      assertBranchAccess(before.branchId);
      await tx.appointmentSlotConfig.delete({ where: { id } });
      await this.audit.log({ action: 'appointment.slot_config_deleted', resourceType: 'AppointmentSlotConfig', resourceId: id, before }, tx);
      return { id, deleted: true };
    });
  }

  // ------------------------------------------------------------------ closures
  listClosures(filter: { branchId?: string; from?: string; to?: string }) {
    return this.db.tx(async (tx) => {
      const rows = await tx.branchClosure.findMany({
        where: {
          tenantId: this.db.tenantId,
          ...(filter.branchId ? { branchId: filter.branchId } : branchFilter() ? { branchId: branchFilter() } : {}),
          ...(filter.from || filter.to ? { date: { ...(filter.from ? { gte: new Date(`${filter.from}T00:00:00Z`) } : {}), ...(filter.to ? { lte: new Date(`${filter.to}T00:00:00Z`) } : {}) } } : {}),
        },
        orderBy: [{ date: 'asc' }],
      });
      return rows.map((r) => ({ id: r.id, branchId: r.branchId, date: r.date.toISOString().slice(0, 10), reason: r.reason }));
    });
  }
  addClosure(input: ClosureInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const branch = await this.branch(tx, input.branchId);
      const date = new Date(`${input.date}T00:00:00Z`);
      const existing = await tx.branchClosure.findFirst({ where: { tenantId, branchId: branch.id, date } });
      if (existing) throw Errors.conflict('DUPLICATE', 'This branch is already marked as closed on that date.');
      const row = await tx.branchClosure.create({ data: { tenantId, branchId: branch.id, date, reason: input.reason ?? null } });
      // People already booked on that day need a call: tell the caller how many.
      const start = zonedTimeToUtc(input.date, '00:00', branch.timezone);
      const affected = await tx.appointment.count({ where: { tenantId, branchId: branch.id, status: { in: ['BOOKED', 'CONFIRMED'] }, startsAt: { gte: start, lt: new Date(start.getTime() + 86_400_000) } } });
      await this.audit.log({ action: 'appointment.closure_added', resourceType: 'BranchClosure', resourceId: row.id, after: input }, tx);
      return { id: row.id, branchId: row.branchId, date: input.date, reason: row.reason, affectedAppointments: affected };
    });
  }
  removeClosure(id: string) {
    return this.db.tx(async (tx) => {
      const before = found(await tx.branchClosure.findFirst({ where: { id, tenantId: this.db.tenantId } }), 'Closure');
      assertBranchAccess(before.branchId);
      await tx.branchClosure.delete({ where: { id } });
      await this.audit.log({ action: 'appointment.closure_removed', resourceType: 'BranchClosure', resourceId: id, before: { branchId: before.branchId, date: before.date.toISOString().slice(0, 10), reason: before.reason } }, tx);
      return { id, deleted: true };
    });
  }

  // ------------------------------------------------------------------ slot computation
  /**
   * Everything needed to compute the slots of one branch day. With `lock` the
   * day's slot rules are locked FOR UPDATE: every booking for the same branch
   * and weekday then runs one after the other, so the capacity check and the
   * insert cannot interleave.
   */
  async dayCalendar(tx: Tx, branchId: string, date: string, serviceId: string | null | undefined, opts: { lock?: boolean; checkAccess?: boolean; now?: Date } = {}): Promise<DayCalendar> {
    const tenantId = this.db.tenantId;
    const branch = await this.branch(tx, branchId, { checkAccess: opts.checkAccess });
    const weekday = weekdayOf(date);
    if (opts.lock) await tx.$queryRaw`SELECT "id" FROM "appointment_slot_configs" WHERE "tenantId" = ${tenantId}::uuid AND "branchId" = ${branch.id}::uuid AND "weekday" = ${weekday} ORDER BY "id" FOR UPDATE`;
    const rules = (await tx.appointmentSlotConfig.findMany({ where: { tenantId, branchId: branch.id, weekday, isActive: true }, orderBy: [{ startTime: 'asc' }, { id: 'asc' }] })) as SlotRule[];
    const settings = await this.settings(tx);
    const closure = await tx.branchClosure.findFirst({ where: { tenantId, branchId: branch.id, date: new Date(`${date}T00:00:00Z`) }, select: { reason: true } });
    const dayStart = zonedTimeToUtc(date, '00:00', branch.timezone);
    const dayEnd = new Date(dayStart.getTime() + 36 * 3_600_000); // generous: covers days with a clock change
    const appointments = await tx.appointment.findMany({ where: { tenantId, branchId: branch.id, status: { in: [...HOLDING] }, startsAt: { gte: dayStart, lt: dayEnd } }, select: { startsAt: true, serviceId: true } });
    // Capacity pools: a service with its own rules is counted separately from the general calendar.
    const { pool } = rulesFor(rules, weekday, serviceId);
    const ownCalendar = new Set(rules.filter((r) => r.serviceId).map((r) => r.serviceId as string));
    const booked = new Map<string, number>();
    for (const a of appointments) {
      const inPool = pool === 'SERVICE' ? a.serviceId === serviceId : !a.serviceId || !ownCalendar.has(a.serviceId);
      if (inPool) booked.set(a.startsAt.toISOString(), (booked.get(a.startsAt.toISOString()) ?? 0) + 1);
    }
    const schedules = await tx.staffSchedule.findMany({
      where: { tenantId, branchId: branch.id, weekday, isActive: true, membership: { kind: 'STAFF', status: 'ACTIVE', isAvailable: true } },
      select: { membershipId: true, weekday: true, startTime: true, endTime: true },
    });
    const today = localParts(opts.now ?? new Date(), branch.timezone).date;
    const lastDate = new Date(new Date(`${today}T00:00:00Z`).getTime() + settings.maxDaysAhead * 86_400_000).toISOString().slice(0, 10);
    return { branch, settings, rules, closed: closure ? { reason: closure.reason } : null, booked, staffWindows: schedules, lastDate };
  }

  /** Staff members scheduled for the whole slot. */
  staffOnDuty(calendar: DayCalendar, startsAt: Date, endsAt: Date): string[] {
    return [...new Set(calendar.staffWindows.filter((w) => windowCovers(w, startsAt, endsAt, calendar.branch.timezone)).map((w) => w.membershipId))];
  }

  slots(calendar: DayCalendar, date: string, serviceId: string | null | undefined, now: Date): Slot[] {
    return computeSlots({
      rules: calendar.rules,
      date,
      timeZone: calendar.branch.timezone,
      serviceId,
      closed: !!calendar.closed,
      now,
      booked: calendar.booked,
      lastDate: calendar.lastDate,
      cap: calendar.settings.limitToStaffOnDuty ? (start, end) => this.staffOnDuty(calendar, start, end).length : undefined,
    });
  }
}
