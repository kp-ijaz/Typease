/**
 * Appointment slot calculation. Pure functions: branch calendars are defined
 * in local wall-clock time ("09:00" in Asia/Dubai), appointments are stored in
 * UTC. Time-zone arithmetic uses Intl only.
 */
export interface SlotRule {
  id: string;
  /** 0 = Sunday ... 6 = Saturday */
  weekday: number;
  startTime: string;
  endTime: string;
  slotMinutes: number;
  capacity: number;
  /** null = the branch's general calendar */
  serviceId: string | null;
  isActive: boolean;
}
export interface Slot {
  /** UTC instants (ISO 8601). */
  startsAt: string;
  endsAt: string;
  /** Wall-clock times in the branch time zone. */
  localStart: string;
  localEnd: string;
  capacity: number;
  booked: number;
  remaining: number;
  available: boolean;
}

const DEFAULT_TZ = 'Asia/Dubai';
const pad = (n: number) => String(n).padStart(2, '0');
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const hhmmOf = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

export function safeTimeZone(timeZone: string | null | undefined): string {
  try {
    if (timeZone) {
      new Intl.DateTimeFormat('en-US', { timeZone });
      return timeZone;
    }
  } catch {
    /* fall through */
  }
  return DEFAULT_TZ;
}

/** Wall-clock parts of an instant in a time zone. */
export function localParts(instant: Date, timeZone: string): { date: string; time: string; weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: safeTimeZone(timeZone), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  return { date, time: `${pad(hour)}:${pad(minute)}`, weekday: weekdayOf(date), minutes: hour * 60 + minute };
}

/** Day of the week of a calendar date (0 = Sunday). */
export const weekdayOf = (date: string): number => new Date(`${date}T00:00:00.000Z`).getUTCDay();

/** The UTC instant at which the wall clock in `timeZone` shows `date` `time`. */
export function zonedTimeToUtc(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const wanted = Date.UTC(y, m - 1, d, hh, mm);
  const tz = safeTimeZone(timeZone);
  const offsetAt = (instant: number) => {
    const p = localParts(new Date(instant), tz);
    const [py, pm, pd] = p.date.split('-').map(Number);
    return Date.UTC(py, pm - 1, pd, Math.floor(p.minutes / 60), p.minutes % 60) - instant;
  };
  // Two passes settle the offset around daylight-saving changes.
  let utc = wanted - offsetAt(wanted);
  utc = wanted - offsetAt(utc);
  return new Date(utc);
}

/**
 * Which rules apply to a booking: the service's own rules for that weekday
 * when it has any, otherwise the branch's general calendar.
 */
export function rulesFor(rules: SlotRule[], weekday: number, serviceId: string | null | undefined): { rules: SlotRule[]; pool: 'SERVICE' | 'GENERAL' } {
  const day = rules.filter((r) => r.isActive && r.weekday === weekday);
  const specific = serviceId ? day.filter((r) => r.serviceId === serviceId) : [];
  if (specific.length) return { rules: specific, pool: 'SERVICE' };
  return { rules: day.filter((r) => r.serviceId === null), pool: 'GENERAL' };
}

/** Slot grid of one day: start minute -> { length, capacity }. Overlapping rules add up their capacity. */
export function slotGrid(rules: SlotRule[]): Map<number, { minutes: number; capacity: number }> {
  const grid = new Map<number, { minutes: number; capacity: number }>();
  for (const rule of rules) {
    const end = minutesOf(rule.endTime);
    for (let start = minutesOf(rule.startTime); start + rule.slotMinutes <= end; start += rule.slotMinutes) {
      const existing = grid.get(start);
      if (existing && existing.minutes === rule.slotMinutes) existing.capacity += rule.capacity;
      else if (!existing) grid.set(start, { minutes: rule.slotMinutes, capacity: rule.capacity });
    }
  }
  return grid;
}

export interface SlotInput {
  rules: SlotRule[];
  /** Calendar date in the branch time zone. */
  date: string;
  timeZone: string;
  serviceId?: string | null;
  /** The branch is closed on this date (holiday). */
  closed?: boolean;
  now: Date;
  /** Booked places per slot start (ISO instant) in the same capacity pool. */
  booked?: Map<string, number>;
  /** Optional cap per slot start (ISO instant), e.g. staff on duty. */
  cap?: (startsAt: Date, endsAt: Date) => number | undefined;
  /** Latest bookable date (inclusive). */
  lastDate?: string;
}

/** All slots of a day with remaining capacity. Past slots, closures and dates beyond the horizon are not available. */
export function computeSlots(input: SlotInput): Slot[] {
  if (input.closed) return [];
  if (input.lastDate && input.date > input.lastDate) return [];
  const { rules } = rulesFor(input.rules, weekdayOf(input.date), input.serviceId);
  const grid = slotGrid(rules);
  const slots: Slot[] = [];
  for (const start of [...grid.keys()].sort((a, b) => a - b)) {
    const cell = grid.get(start)!;
    const startsAt = zonedTimeToUtc(input.date, hhmmOf(start), input.timeZone);
    const endsAt = new Date(startsAt.getTime() + cell.minutes * 60_000);
    const limit = input.cap?.(startsAt, endsAt);
    const capacity = limit === undefined ? cell.capacity : Math.max(0, Math.min(cell.capacity, limit));
    const booked = input.booked?.get(startsAt.toISOString()) ?? 0;
    const remaining = Math.max(0, capacity - booked);
    slots.push({
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      localStart: hhmmOf(start),
      localEnd: hhmmOf(start + cell.minutes),
      capacity,
      booked,
      remaining,
      available: remaining > 0 && startsAt.getTime() > input.now.getTime(),
    });
  }
  return slots;
}

/** The slot that starts exactly at `startsAt`, if the calendar has one. */
export function findSlot(input: Omit<SlotInput, 'date'>, startsAt: Date): Slot | undefined {
  const date = localParts(startsAt, input.timeZone).date;
  return computeSlots({ ...input, date }).find((s) => s.startsAt === startsAt.toISOString());
}

/** Does a working window ("09:00"-"17:00" on a weekday) cover the whole slot? */
export function windowCovers(window: { weekday: number; startTime: string; endTime: string }, startsAt: Date, endsAt: Date, timeZone: string): boolean {
  const start = localParts(startsAt, timeZone);
  const end = localParts(new Date(endsAt.getTime() - 1), timeZone);
  if (start.weekday !== window.weekday || end.date !== start.date) return false;
  return minutesOf(window.startTime) <= start.minutes && end.minutes < minutesOf(window.endTime);
}

/**
 * Which reminder is due for an appointment right now.
 * `hoursBefore` e.g. [24, 2]: the reminder window that `now` is in is the
 * smallest H with now >= start - H. It is due when nothing was sent in that
 * window yet and the appointment was booked before the window opened (someone
 * who books 90 minutes ahead just got the confirmation and needs no reminder).
 */
export function reminderDue(input: { startsAt: Date; createdAt: Date; reminderSentAt: Date | null; hoursBefore: number[]; now: Date }): number | null {
  const { startsAt, now } = input;
  if (now.getTime() >= startsAt.getTime()) return null;
  const open = [...new Set(input.hoursBefore)].filter((h) => h > 0 && now.getTime() >= startsAt.getTime() - h * 3_600_000).sort((a, b) => a - b);
  if (!open.length) return null;
  const hours = open[0];
  const windowStart = startsAt.getTime() - hours * 3_600_000;
  if (input.reminderSentAt && input.reminderSentAt.getTime() >= windowStart) return null;
  if (input.createdAt.getTime() >= windowStart) return null;
  return hours;
}
