import { computeSlots, findSlot, localParts, reminderDue, rulesFor, slotGrid, SlotRule, weekdayOf, windowCovers, zonedTimeToUtc } from './slots';

const rule = (over: Partial<SlotRule> = {}): SlotRule => ({ id: 'r1', weekday: 1, startTime: '09:00', endTime: '11:00', slotMinutes: 30, capacity: 2, serviceId: null, isActive: true, ...over });
const DUBAI = 'Asia/Dubai';
// 2026-10-12 is a Monday.
const MONDAY = '2026-10-12';
const earlier = new Date('2026-10-01T00:00:00Z');

describe('appointment slots', () => {
  describe('time zones', () => {
    it('converts branch wall-clock time to UTC and back', () => {
      expect(zonedTimeToUtc(MONDAY, '09:00', DUBAI).toISOString()).toBe('2026-10-12T05:00:00.000Z');
      expect(zonedTimeToUtc(MONDAY, '00:30', DUBAI).toISOString()).toBe('2026-10-11T20:30:00.000Z');
      expect(localParts(new Date('2026-10-11T20:30:00Z'), DUBAI)).toEqual({ date: MONDAY, time: '00:30', weekday: 1, minutes: 30 });
      expect(weekdayOf(MONDAY)).toBe(1);
    });
    it('handles daylight-saving zones on both sides of a change', () => {
      // Europe/London: BST (UTC+1) until 25 Oct 2026, GMT afterwards.
      expect(zonedTimeToUtc('2026-10-24', '09:00', 'Europe/London').toISOString()).toBe('2026-10-24T08:00:00.000Z');
      expect(zonedTimeToUtc('2026-10-26', '09:00', 'Europe/London').toISOString()).toBe('2026-10-26T09:00:00.000Z');
      expect(zonedTimeToUtc('2026-03-29', '12:00', 'Europe/London').toISOString()).toBe('2026-03-29T11:00:00.000Z');
    });
    it('falls back to Asia/Dubai for an unknown zone', () => {
      expect(zonedTimeToUtc(MONDAY, '09:00', 'Mars/Olympus').toISOString()).toBe('2026-10-12T05:00:00.000Z');
    });
  });

  describe('slot grid', () => {
    it('cuts the working window into slots and drops a partial last slot', () => {
      const slots = computeSlots({ rules: [rule({ endTime: '10:50' })], date: MONDAY, timeZone: DUBAI, now: earlier });
      expect(slots.map((s) => `${s.localStart}-${s.localEnd}`)).toEqual(['09:00-09:30', '09:30-10:00', '10:00-10:30']);
      expect(slots[0]).toMatchObject({ startsAt: '2026-10-12T05:00:00.000Z', endsAt: '2026-10-12T05:30:00.000Z', capacity: 2, booked: 0, remaining: 2, available: true });
    });
    it('uses only the rules of the weekday and ignores inactive rules', () => {
      expect(computeSlots({ rules: [rule({ weekday: 2 })], date: MONDAY, timeZone: DUBAI, now: earlier })).toEqual([]);
      expect(computeSlots({ rules: [rule({ isActive: false })], date: MONDAY, timeZone: DUBAI, now: earlier })).toEqual([]);
    });
    it('joins a morning and an evening shift and adds up overlapping capacity', () => {
      const rules = [rule(), rule({ id: 'r2', startTime: '16:00', endTime: '17:00' }), rule({ id: 'r3', startTime: '10:00', endTime: '11:00', capacity: 3 })];
      const slots = computeSlots({ rules, date: MONDAY, timeZone: DUBAI, now: earlier });
      expect(slots.map((s) => [s.localStart, s.capacity])).toEqual([['09:00', 2], ['09:30', 2], ['10:00', 5], ['10:30', 5], ['16:00', 2], ['16:30', 2]]);
      expect(slotGrid(rules).size).toBe(6);
    });
    it('prefers the service calendar over the general one when the service has its own', () => {
      const rules = [rule(), rule({ id: 'svc', serviceId: 'medical', startTime: '14:00', endTime: '15:00', slotMinutes: 60, capacity: 1 })];
      expect(rulesFor(rules, 1, 'medical')).toMatchObject({ pool: 'SERVICE' });
      expect(computeSlots({ rules, date: MONDAY, timeZone: DUBAI, serviceId: 'medical', now: earlier }).map((s) => s.localStart)).toEqual(['14:00']);
      expect(computeSlots({ rules, date: MONDAY, timeZone: DUBAI, serviceId: 'typing', now: earlier }).map((s) => s.localStart)).toEqual(['09:00', '09:30', '10:00', '10:30']);
      expect(computeSlots({ rules, date: MONDAY, timeZone: DUBAI, now: earlier })).toHaveLength(4);
      expect(rulesFor(rules, 1, 'typing').pool).toBe('GENERAL');
    });
  });

  describe('availability', () => {
    it('excludes closures and dates beyond the booking horizon', () => {
      expect(computeSlots({ rules: [rule()], date: MONDAY, timeZone: DUBAI, now: earlier, closed: true })).toEqual([]);
      expect(computeSlots({ rules: [rule()], date: MONDAY, timeZone: DUBAI, now: earlier, lastDate: '2026-10-11' })).toEqual([]);
      expect(computeSlots({ rules: [rule()], date: MONDAY, timeZone: DUBAI, now: earlier, lastDate: MONDAY })).toHaveLength(4);
    });
    it('marks past slots and full slots as unavailable', () => {
      const booked = new Map([['2026-10-12T05:30:00.000Z', 2], ['2026-10-12T06:00:00.000Z', 1]]);
      const slots = computeSlots({ rules: [rule()], date: MONDAY, timeZone: DUBAI, now: new Date('2026-10-12T05:00:00.000Z'), booked });
      expect(slots.map((s) => [s.localStart, s.remaining, s.available])).toEqual([
        ['09:00', 2, false], // starts exactly now: already too late
        ['09:30', 0, false], // full
        ['10:00', 1, true],
        ['10:30', 2, true],
      ]);
    });
    it('applies an external cap such as staff on duty', () => {
      const slots = computeSlots({ rules: [rule({ capacity: 5 })], date: MONDAY, timeZone: DUBAI, now: earlier, cap: (start) => (start.toISOString() === '2026-10-12T05:00:00.000Z' ? 0 : 3) });
      expect(slots.map((s) => [s.capacity, s.available])).toEqual([[0, false], [3, true], [3, true], [3, true]]);
    });
    it('finds the slot for an exact start time only', () => {
      const input = { rules: [rule()], timeZone: DUBAI, now: earlier };
      expect(findSlot(input, new Date('2026-10-12T05:30:00.000Z'))?.localStart).toBe('09:30');
      expect(findSlot(input, new Date('2026-10-12T05:40:00.000Z'))).toBeUndefined();
      expect(findSlot(input, new Date('2026-10-13T05:30:00.000Z'))).toBeUndefined();
    });
  });

  it('checks whether a staff working window covers a slot', () => {
    const window = { weekday: 1, startTime: '09:00', endTime: '13:00' };
    expect(windowCovers(window, new Date('2026-10-12T05:00:00Z'), new Date('2026-10-12T05:30:00Z'), DUBAI)).toBe(true);
    expect(windowCovers(window, new Date('2026-10-12T08:30:00Z'), new Date('2026-10-12T09:00:00Z'), DUBAI)).toBe(true); // ends exactly at 13:00
    expect(windowCovers(window, new Date('2026-10-12T08:45:00Z'), new Date('2026-10-12T09:15:00Z'), DUBAI)).toBe(false);
    expect(windowCovers(window, new Date('2026-10-13T05:00:00Z'), new Date('2026-10-13T05:30:00Z'), DUBAI)).toBe(false);
  });

  describe('reminders', () => {
    const startsAt = new Date('2026-10-12T10:00:00Z');
    const base = { startsAt, createdAt: new Date('2026-10-01T00:00:00Z'), reminderSentAt: null as Date | null, hoursBefore: [24, 2] };
    it('is due 24 hours and 2 hours before, once per window', () => {
      expect(reminderDue({ ...base, now: new Date('2026-10-11T09:59:00Z') })).toBeNull();
      expect(reminderDue({ ...base, now: new Date('2026-10-11T10:05:00Z') })).toBe(24);
      expect(reminderDue({ ...base, now: new Date('2026-10-11T12:00:00Z'), reminderSentAt: new Date('2026-10-11T10:05:00Z') })).toBeNull();
      expect(reminderDue({ ...base, now: new Date('2026-10-12T08:10:00Z'), reminderSentAt: new Date('2026-10-11T10:05:00Z') })).toBe(2);
      expect(reminderDue({ ...base, now: new Date('2026-10-12T08:30:00Z'), reminderSentAt: new Date('2026-10-12T08:10:00Z') })).toBeNull();
      expect(reminderDue({ ...base, now: new Date('2026-10-12T10:00:00Z') })).toBeNull(); // already started
    });
    it('is skipped when the appointment was booked inside the window', () => {
      expect(reminderDue({ ...base, createdAt: new Date('2026-10-11T15:00:00Z'), now: new Date('2026-10-11T16:00:00Z') })).toBeNull(); // booked 19h ahead
      expect(reminderDue({ ...base, createdAt: new Date('2026-10-11T15:00:00Z'), now: new Date('2026-10-12T08:05:00Z') })).toBe(2);
      expect(reminderDue({ ...base, createdAt: new Date('2026-10-12T09:00:00Z'), now: new Date('2026-10-12T09:30:00Z') })).toBeNull(); // booked 1h ahead
    });
  });
});
