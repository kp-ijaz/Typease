/**
 * Pure ranking for automatic assignment. The service gathers the facts
 * (skills, schedules, open work) and this module decides the order.
 */
export interface AssignmentCandidate {
  membershipId: string;
  /** Has a staff_skills row for the service. */
  hasSkill: boolean;
  /** Has any active schedule rows. Staff without a schedule are treated as always on shift. */
  hasSchedule: boolean;
  onShift: boolean;
  /** Weighted number of open requests already assigned. */
  workload: number;
}

/** Urgent and high-priority cases take more attention, so they weigh more. */
export const PRIORITY_WEIGHT: Record<string, number> = { URGENT: 3, HIGH: 2, NORMAL: 1, LOW: 1 };

export function workloadOf(priorities: string[]): number {
  return priorities.reduce((total, p) => total + (PRIORITY_WEIGHT[p] ?? 1), 0);
}

const availableNow = (c: AssignmentCandidate) => !c.hasSchedule || c.onShift;

/**
 * Best candidate first:
 *   1. people skilled in the service,
 *   2. people on shift now (or without a schedule) before people who are off shift,
 *   3. the lowest weighted workload,
 *   4. membership id (so the result is deterministic).
 */
export function rankCandidates(candidates: AssignmentCandidate[]): AssignmentCandidate[] {
  return [...candidates].sort(
    (a, b) =>
      Number(b.hasSkill) - Number(a.hasSkill) ||
      Number(availableNow(b)) - Number(availableNow(a)) ||
      a.workload - b.workload ||
      (a.membershipId < b.membershipId ? -1 : a.membershipId > b.membershipId ? 1 : 0),
  );
}

/** Weekday (0 = Sunday) and HH:MM of `now` in an IANA time zone. */
export function localWeekdayAndTime(now: Date, timeZone: string): { weekday: number; time: string } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { weekday, time: `${get('hour')}:${get('minute')}` };
}

export interface ShiftRow {
  branchId: string;
  weekday: number;
  startTime: string;
  endTime: string;
  isActive: boolean;
}
/** Is the person scheduled at this branch right now? (`endTime` is exclusive.) */
export function isOnShift(schedules: ShiftRow[], branchId: string, now: Date, timeZone: string): boolean {
  const { weekday, time } = localWeekdayAndTime(now, timeZone);
  return schedules.some((s) => s.isActive && s.branchId === branchId && s.weekday === weekday && s.startTime <= time && time < s.endTime);
}

/** Start of the calendar day of `now` in a time zone, as a UTC instant. */
export function startOfLocalDay(now: Date, timeZone: string): Date {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  } catch {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const elapsedMs = ((n('hour') * 60 + n('minute')) * 60 + n('second')) * 1000 + now.getUTCMilliseconds();
  return new Date(now.getTime() - elapsedMs);
}
