/**
 * Calendar-day arithmetic for expiry reminders. Dates are plain "YYYY-MM-DD"
 * strings (the expiry date of a document has no time zone); "today" is the
 * current date in the centre's time zone.
 */
export const DEFAULT_OFFSETS = [90, 60, 30, 15, 7];

/** Date part of a database DATE value (stored as UTC midnight). */
export const ymd = (date: Date): string => date.toISOString().slice(0, 10);
export const fromYmd = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

/** Today's date in a time zone, e.g. "2026-10-09" for Asia/Dubai. */
export function localDate(now: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  }
}
/** Whole days from `from` to `to` (negative when `to` is earlier). */
export const daysBetween = (from: string, to: string): number => Math.round((fromYmd(to).getTime() - fromYmd(from).getTime()) / 86_400_000);
export const addDays = (date: string, days: number): string => ymd(new Date(fromYmd(date).getTime() + days * 86_400_000));

/** Unique, valid offsets, largest first. */
export function normaliseOffsets(offsets: unknown, fallback: number[] = DEFAULT_OFFSETS): number[] {
  const list = Array.isArray(offsets) ? offsets.filter((n): n is number => Number.isInteger(n) && n >= 0 && n <= 730) : [];
  const unique = [...new Set(list.length ? list : fallback)];
  return unique.sort((a, b) => b - a);
}
/** Centre default from tenant.settings.reminderOffsetsDays, else 90 / 60 / 30 / 15 / 7. */
export const tenantOffsets = (settings: unknown): number[] => normaliseOffsets((settings as any)?.reminderOffsetsDays, DEFAULT_OFFSETS);

export interface DispatchPlan {
  daysLeft: number;
  /** The expiry date has passed: no more reminders, the schedule is finished. */
  expired: boolean;
  /** Offset to remind for now (the most recent one that is due and not yet handled), if any. */
  send: number | null;
  /** Earlier offsets that were missed: recorded as superseded, never sent late. */
  superseded: number[];
}

/**
 * What the daily scan has to do for one schedule.
 *
 * An offset is due once `expiry - offset <= today`. When several are due and
 * unhandled (a schedule created late, or the job did not run for a few days)
 * only the closest one to the expiry date is sent, so nobody receives three
 * reminders at once; the others are marked superseded.
 */
export function planDispatches(expiryDate: string, offsets: number[], today: string, handledOffsets: number[]): DispatchPlan {
  const daysLeft = daysBetween(today, expiryDate);
  const handled = new Set(handledOffsets);
  const due = normaliseOffsets(offsets).filter((o) => o >= daysLeft && !handled.has(o));
  if (daysLeft < 0) return { daysLeft, expired: true, send: null, superseded: due };
  if (!due.length) return { daysLeft, expired: false, send: null, superseded: [] };
  const send = Math.min(...due);
  return { daysLeft, expired: false, send, superseded: due.filter((o) => o !== send) };
}

/** Date of the next reminder that has not been handled yet, or null. */
export function nextReminderOn(expiryDate: string, offsets: number[], today: string, handledOffsets: number[]): string | null {
  const handled = new Set(handledOffsets);
  const upcoming = normaliseOffsets(offsets)
    .filter((o) => !handled.has(o))
    .map((o) => addDays(expiryDate, -o))
    .filter((d) => d <= expiryDate && expiryDate >= today)
    .sort();
  if (!upcoming.length) return null;
  // Something already due goes out with the next scan.
  const future = upcoming.find((d) => d > today);
  return upcoming.some((d) => d <= today) ? today : (future ?? null);
}
