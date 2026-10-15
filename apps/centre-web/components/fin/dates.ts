/**
 * Calendar-date helpers for forms. The API takes ISO timestamps with an offset for
 * "valid until", "received at" and reconciliation periods; people choose calendar days
 * on the centre's clock. These convert between the two without the browser's own zone.
 */

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Offset of `timeZone` at the given instant, in minutes east of UTC. */
function offsetMinutes(instant: Date, timeZone: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(instant);
  } catch {
    return 0;
  }
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/** "2026-10-09" + "23:59:59" on the centre's clock -> "2026-10-09T19:59:59.000Z". */
export function zonedToIso(date: string, time: '00:00:00' | '23:59:59' | '12:00:00', timeZone: string): string {
  const m = DATE.exec(date);
  if (!m) throw new Error(`Not a YYYY-MM-DD date: ${date}`);
  const [h, min, s] = time.split(':').map(Number);
  const naive = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), h, min, s);
  // Two passes settle the offset across a daylight-saving change.
  let instant = naive - offsetMinutes(new Date(naive), timeZone) * 60_000;
  instant = naive - offsetMinutes(new Date(instant), timeZone) * 60_000;
  return new Date(instant).toISOString();
}

/** The calendar day of an instant on the centre's clock, as YYYY-MM-DD. */
export function isoToZonedDate(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return '';
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return '';
  const local = new Date(instant.getTime() + offsetMinutes(instant, timeZone) * 60_000);
  return local.toISOString().slice(0, 10);
}
