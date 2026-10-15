import { addDays, daysBetween, localDate, nextReminderOn, normaliseOffsets, planDispatches, tenantOffsets, ymd } from './dates';

describe('expiry reminder dates', () => {
  it('computes the local date of a time zone', () => {
    // 21:30 UTC is already the next day in Dubai (UTC+4).
    expect(localDate(new Date('2026-10-09T21:30:00Z'), 'Asia/Dubai')).toBe('2026-10-10');
    expect(localDate(new Date('2026-10-09T19:30:00Z'), 'Asia/Dubai')).toBe('2026-10-09');
    expect(localDate(new Date('2026-10-09T21:30:00Z'), 'Not/AZone')).toBe('2026-10-10');
  });
  it('counts whole calendar days', () => {
    expect(daysBetween('2026-10-09', '2026-10-09')).toBe(0);
    expect(daysBetween('2026-10-09', '2027-01-07')).toBe(90);
    expect(daysBetween('2026-10-09', '2026-10-01')).toBe(-8);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(ymd(new Date('2026-10-09T00:00:00Z'))).toBe('2026-10-09');
  });
  it('normalises offsets and falls back to 90 / 60 / 30 / 15 / 7', () => {
    expect(normaliseOffsets([7, 30, 30, 90])).toEqual([90, 30, 7]);
    expect(normaliseOffsets([])).toEqual([90, 60, 30, 15, 7]);
    expect(normaliseOffsets([-1, 1.5, 9999, 'x'])).toEqual([90, 60, 30, 15, 7]);
    expect(tenantOffsets({ reminderOffsetsDays: [45, 10] })).toEqual([45, 10]);
    expect(tenantOffsets({})).toEqual([90, 60, 30, 15, 7]);
    expect(tenantOffsets(null)).toEqual([90, 60, 30, 15, 7]);
  });

  describe('planDispatches', () => {
    const offsets = [90, 60, 30, 15, 7];
    it('does nothing before the first offset', () => {
      expect(planDispatches('2027-01-08', offsets, '2026-10-09', [])).toEqual({ daysLeft: 91, expired: false, send: null, superseded: [] });
    });
    it('sends exactly on the offset day and not again once handled', () => {
      expect(planDispatches('2027-01-07', offsets, '2026-10-09', [])).toEqual({ daysLeft: 90, expired: false, send: 90, superseded: [] });
      expect(planDispatches('2027-01-07', offsets, '2026-10-09', [90])).toEqual({ daysLeft: 90, expired: false, send: null, superseded: [] });
      expect(planDispatches('2027-01-07', offsets, '2026-10-10', [90])).toEqual({ daysLeft: 89, expired: false, send: null, superseded: [] });
    });
    it('catches up with one reminder when several were missed', () => {
      expect(planDispatches('2026-10-29', offsets, '2026-10-09', [])).toEqual({ daysLeft: 20, expired: false, send: 30, superseded: [90, 60] });
      expect(planDispatches('2026-10-29', offsets, '2026-10-09', [90, 60, 30])).toEqual({ daysLeft: 20, expired: false, send: null, superseded: [] });
      expect(planDispatches('2026-10-29', offsets, '2026-10-14', [90, 60, 30])).toMatchObject({ daysLeft: 15, send: 15 });
    });
    it('supports a reminder on the expiry day itself and stops after it', () => {
      expect(planDispatches('2026-10-09', [7, 0], '2026-10-09', [7])).toEqual({ daysLeft: 0, expired: false, send: 0, superseded: [] });
      expect(planDispatches('2026-10-09', [7, 0], '2026-10-10', [7])).toEqual({ daysLeft: -1, expired: true, send: null, superseded: [0] });
      expect(planDispatches('2026-10-01', offsets, '2026-10-09', [90, 60, 30, 15, 7])).toEqual({ daysLeft: -8, expired: true, send: null, superseded: [] });
    });
  });

  it('tells when the next reminder goes out', () => {
    const offsets = [90, 60, 30, 15, 7];
    expect(nextReminderOn('2027-01-08', offsets, '2026-10-09', [])).toBe('2026-10-10');
    expect(nextReminderOn('2027-01-07', offsets, '2026-10-09', [])).toBe('2026-10-09');
    expect(nextReminderOn('2027-01-07', offsets, '2026-10-09', [90])).toBe('2026-11-08');
    expect(nextReminderOn('2026-10-12', offsets, '2026-10-09', [90, 60, 30, 15, 7])).toBeNull();
    expect(nextReminderOn('2026-10-01', offsets, '2026-10-09', [])).toBeNull();
  });
});
