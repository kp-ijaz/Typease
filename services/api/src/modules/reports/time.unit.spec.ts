import {
  addDays, addMonths, daysBetween, eachDay, eachMonth, firstOfMonth, lastOfMonth, localYmd, nextRunAfter, period, periodLabel, relativeRange, safeTimeZone, startOfLocalDay, weekdayOf, zonedDateTimeToUtc, zoneOffsetMs,
} from './time';

describe('calendar arithmetic in a time zone', () => {
  it('falls back to the UAE for a missing or invalid time zone', () => {
    expect(safeTimeZone('Asia/Dubai')).toBe('Asia/Dubai');
    expect(safeTimeZone('Europe/Berlin')).toBe('Europe/Berlin');
    expect(safeTimeZone('Mars/Olympus')).toBe('Asia/Dubai');
    expect(safeTimeZone("Asia/Dubai'; DROP TABLE x; --")).toBe('Asia/Dubai');
    expect(safeTimeZone(null)).toBe('Asia/Dubai');
  });

  it('knows the local calendar day of an instant', () => {
    // 20:30 UTC is already the next day in Dubai (UTC+4), still the same day in New York.
    const at = new Date('2026-10-09T20:30:00.000Z');
    expect(localYmd(at, 'Asia/Dubai')).toBe('2026-10-10');
    expect(localYmd(at, 'America/New_York')).toBe('2026-10-09');
    expect(localYmd(new Date('2026-10-09T19:59:59.000Z'), 'Asia/Dubai')).toBe('2026-10-09');
  });

  it('finds the UTC instant at which a local day starts', () => {
    expect(startOfLocalDay('2026-10-09', 'Asia/Dubai').toISOString()).toBe('2026-10-08T20:00:00.000Z');
    expect(startOfLocalDay('2026-10-09', 'UTC').toISOString()).toBe('2026-10-09T00:00:00.000Z');
    expect(startOfLocalDay('2026-01-15', 'America/New_York').toISOString()).toBe('2026-01-15T05:00:00.000Z');
    expect(startOfLocalDay('2026-07-15', 'America/New_York').toISOString()).toBe('2026-07-15T04:00:00.000Z');
    expect(zoneOffsetMs(new Date('2026-10-09T00:00:00Z'), 'Asia/Dubai')).toBe(4 * 3_600_000);
  });

  it('handles days that are 23 or 25 hours long (daylight saving)', () => {
    // Berlin: clocks go forward on 2026-03-29 and back on 2026-10-25.
    const spring = period('2026-03-29', '2026-03-29', 'Europe/Berlin');
    expect(spring.start.toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(spring.end.toISOString()).toBe('2026-03-29T22:00:00.000Z');
    expect((spring.end.getTime() - spring.start.getTime()) / 3_600_000).toBe(23);
    const autumn = period('2026-10-25', '2026-10-25', 'Europe/Berlin');
    expect((autumn.end.getTime() - autumn.start.getTime()) / 3_600_000).toBe(25);
    expect(zonedDateTimeToUtc('2026-10-25', 9, 30, 'Europe/Berlin').toISOString()).toBe('2026-10-25T08:30:00.000Z');
  });

  it('a period includes its last day completely', () => {
    const p = period('2026-10-01', '2026-10-09', 'Asia/Dubai');
    expect(p.start.toISOString()).toBe('2026-09-30T20:00:00.000Z');
    expect(p.end.toISOString()).toBe('2026-10-09T20:00:00.000Z');
  });

  it('adds days and months across month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(daysBetween('2026-10-01', '2026-10-09')).toBe(8);
    expect(weekdayOf('2026-10-09')).toBe(5); // a Friday
    expect(firstOfMonth('2026-10-09')).toBe('2026-10-01');
    expect(lastOfMonth('2026-02-10')).toBe('2026-02-28');
    expect(lastOfMonth('2028-02-10')).toBe('2028-02-29');
    expect(addMonths('2026-01-01', -1)).toBe('2025-12-01');
    expect(addMonths('2026-11-01', 3)).toBe('2027-02-01');
    expect(eachDay('2026-02-27', '2026-03-01')).toEqual(['2026-02-27', '2026-02-28', '2026-03-01']);
    expect(eachMonth('2025-11-20', '2026-02-03')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(periodLabel('2026-10-09', '2026-10-09')).toBe('2026-10-09');
    expect(periodLabel('2026-10-01', '2026-10-09')).toBe('2026-10-01 to 2026-10-09');
  });

  it('resolves relative periods from "today"', () => {
    const today = '2026-10-09'; // Friday
    expect(relativeRange('today', today)).toEqual({ from: '2026-10-09', to: '2026-10-09' });
    expect(relativeRange('yesterday', today)).toEqual({ from: '2026-10-08', to: '2026-10-08' });
    expect(relativeRange('last_7_days', today)).toEqual({ from: '2026-10-02', to: '2026-10-08' });
    expect(relativeRange('last_30_days', today)).toEqual({ from: '2026-09-09', to: '2026-10-08' });
    expect(relativeRange('last_week', today)).toEqual({ from: '2026-09-28', to: '2026-10-04' }); // Monday to Sunday
    expect(relativeRange('last_week', '2026-10-05')).toEqual({ from: '2026-09-28', to: '2026-10-04' }); // seen from a Monday
    expect(relativeRange('month_to_date', today)).toEqual({ from: '2026-10-01', to: '2026-10-09' });
    expect(relativeRange('last_month', today)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(relativeRange('last_month', '2026-01-15')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(relativeRange('last_month', '2026-03-31')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(relativeRange('year_to_date', today)).toEqual({ from: '2026-01-01', to: '2026-10-09' });
  });
});

describe('next run time of a schedule', () => {
  const dubai = 'Asia/Dubai';
  const timing = { timeOfDay: '07:00', weekday: 1, dayOfMonth: 1 };

  it('daily: today when the time is still ahead, otherwise tomorrow', () => {
    // 07:00 in Dubai is 03:00 UTC.
    expect(nextRunAfter({ frequency: 'DAILY', ...timing }, new Date('2026-10-09T02:00:00Z'), dubai).toISOString()).toBe('2026-10-09T03:00:00.000Z');
    expect(nextRunAfter({ frequency: 'DAILY', ...timing }, new Date('2026-10-09T03:00:00Z'), dubai).toISOString()).toBe('2026-10-10T03:00:00.000Z');
    expect(nextRunAfter({ frequency: 'DAILY', ...timing }, new Date('2026-10-09T21:00:00Z'), dubai).toISOString()).toBe('2026-10-10T03:00:00.000Z');
  });

  it('weekly: the next such weekday on the centre\'s calendar', () => {
    // Friday 2026-10-09 -> Monday 2026-10-12
    expect(nextRunAfter({ frequency: 'WEEKLY', ...timing }, new Date('2026-10-09T12:00:00Z'), dubai).toISOString()).toBe('2026-10-12T03:00:00.000Z');
    // Monday morning before 07:00 local: the same day
    expect(nextRunAfter({ frequency: 'WEEKLY', ...timing }, new Date('2026-10-11T22:00:00Z'), dubai).toISOString()).toBe('2026-10-12T03:00:00.000Z');
    expect(nextRunAfter({ frequency: 'WEEKLY', ...timing, weekday: 5 }, new Date('2026-10-09T12:00:00Z'), dubai).toISOString()).toBe('2026-10-16T03:00:00.000Z');
  });

  it('monthly: the chosen day of the month', () => {
    expect(nextRunAfter({ frequency: 'MONTHLY', ...timing }, new Date('2026-10-09T12:00:00Z'), dubai).toISOString()).toBe('2026-11-01T03:00:00.000Z');
    expect(nextRunAfter({ frequency: 'MONTHLY', ...timing, dayOfMonth: 28, timeOfDay: '18:30' }, new Date('2026-02-28T15:00:00Z'), dubai).toISOString()).toBe('2026-03-28T14:30:00.000Z');
    expect(nextRunAfter({ frequency: 'MONTHLY', ...timing, dayOfMonth: 28, timeOfDay: '18:30' }, new Date('2026-02-28T14:00:00Z'), dubai).toISOString()).toBe('2026-02-28T14:30:00.000Z');
  });

  it('keeps the local time of day across a daylight-saving change', () => {
    const berlin = 'Europe/Berlin';
    // 07:00 in Berlin is 06:00 UTC in winter and 05:00 UTC in summer.
    expect(nextRunAfter({ frequency: 'DAILY', ...timing }, new Date('2026-03-28T12:00:00Z'), berlin).toISOString()).toBe('2026-03-29T05:00:00.000Z');
    expect(nextRunAfter({ frequency: 'DAILY', ...timing }, new Date('2026-10-24T12:00:00Z'), berlin).toISOString()).toBe('2026-10-25T06:00:00.000Z');
  });
});
