import type { RelativeRange } from '@typease/validation';

/**
 * Calendar arithmetic in a centre's time zone, with nothing but Intl.
 *
 * Reports and the dashboard talk about "days" as the centre experiences them:
 * a day is a "YYYY-MM-DD" string in the tenant's time zone, and every query
 * uses the UTC instants at which that local day starts and ends.
 */
export const DEFAULT_TIME_ZONE = 'Asia/Dubai';
const DAY_MS = 86_400_000;

/** A time zone Intl (and PostgreSQL) accepts; anything else falls back to the UAE. */
export function safeTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone || !/^[A-Za-z0-9_+\-/]{1,64}$/.test(timeZone)) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}
function localParts(at: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** Offset of the zone at an instant, in milliseconds (local wall clock minus UTC). */
export function zoneOffsetMs(at: Date, timeZone: string): number {
  const p = localParts(at, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
export const isYmd = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));

/** The calendar day of an instant in a time zone, e.g. "2026-10-09". */
export function localYmd(at: Date, timeZone: string): string {
  const p = localParts(at, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** UTC instant of a local wall-clock time on a local calendar day. */
export function zonedDateTimeToUtc(ymd: string, hour: number, minute: number, timeZone: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, hour, minute, 0);
  // Two passes: the offset at the guessed instant can differ from the offset at the real one around a DST change.
  let instant = wall - zoneOffsetMs(new Date(wall), timeZone);
  instant = wall - zoneOffsetMs(new Date(instant), timeZone);
  return new Date(instant);
}
/** UTC instant at which a local calendar day starts. */
export const startOfLocalDay = (ymd: string, timeZone: string): Date => zonedDateTimeToUtc(ymd, 0, 0, timeZone);

export function addDays(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}
/** Whole days from `from` to `to` (0 when equal). */
export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS);
/** 0 = Sunday ... 6 = Saturday. */
export const weekdayOf = (ymd: string): number => new Date(`${ymd}T00:00:00.000Z`).getUTCDay();
export const firstOfMonth = (ymd: string): string => `${ymd.slice(0, 7)}-01`;
export function addMonths(ymd: string, months: number): string {
  const [y, m] = ymd.split('-').map(Number);
  const index = y * 12 + (m - 1) + months;
  return `${pad(Math.floor(index / 12), 4)}-${pad((index % 12) + 1)}-01`;
}
export const lastOfMonth = (ymd: string): string => addDays(addMonths(firstOfMonth(ymd), 1), -1);

/** Every calendar day from `from` to `to`, both included. */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
/** Every month ("YYYY-MM") touched by the period. */
export function eachMonth(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = firstOfMonth(from); m <= to; m = addMonths(m, 1)) out.push(m.slice(0, 7));
  return out;
}

export interface Period {
  /** First and last local day, both included. */
  from: string;
  to: string;
  /** UTC instants: start <= t < end. */
  start: Date;
  end: Date;
}
export function period(from: string, to: string, timeZone: string): Period {
  return { from, to, start: startOfLocalDay(from, timeZone), end: startOfLocalDay(addDays(to, 1), timeZone) };
}

/** A relative period, seen from `today` (a local calendar day). Weeks run Monday to Sunday. */
export function relativeRange(range: RelativeRange, today: string): { from: string; to: string } {
  switch (range) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday':
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case 'last_7_days':
      return { from: addDays(today, -7), to: addDays(today, -1) };
    case 'last_30_days':
      return { from: addDays(today, -30), to: addDays(today, -1) };
    case 'last_week': {
      const sinceMonday = (weekdayOf(today) + 6) % 7;
      const monday = addDays(today, -sinceMonday - 7);
      return { from: monday, to: addDays(monday, 6) };
    }
    case 'month_to_date':
      return { from: firstOfMonth(today), to: today };
    case 'last_month': {
      const first = addMonths(firstOfMonth(today), -1);
      return { from: first, to: lastOfMonth(first) };
    }
    case 'year_to_date':
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
  }
}

export const periodLabel = (from: string, to: string): string => (from === to ? from : `${from} to ${to}`);

export interface ScheduleTiming {
  frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  /** "HH:MM" in the centre's time zone. */
  timeOfDay: string;
  /** WEEKLY: 0 = Sunday ... 6 = Saturday. */
  weekday: number;
  /** MONTHLY: 1-28. */
  dayOfMonth: number;
}
export const DEFAULT_TIMING = { timeOfDay: '07:00', weekday: 1, dayOfMonth: 1 } as const;

/** The first run time strictly after `after`, on the centre's own clock. */
export function nextRunAfter(timing: ScheduleTiming, after: Date, timeZone: string): Date {
  const [hour, minute] = timing.timeOfDay.split(':').map(Number);
  const startDay = localYmd(after, timeZone);
  for (let i = 0; i <= 62; i++) {
    const day = addDays(startDay, i);
    if (timing.frequency === 'WEEKLY' && weekdayOf(day) !== timing.weekday) continue;
    if (timing.frequency === 'MONTHLY' && Number(day.slice(8, 10)) !== timing.dayOfMonth) continue;
    const at = zonedDateTimeToUtc(day, hour, minute, timeZone);
    if (at.getTime() > after.getTime()) return at;
  }
  // Unreachable for valid timings (every frequency recurs within 31 days).
  throw new Error('No next run time could be computed for this schedule.');
}
