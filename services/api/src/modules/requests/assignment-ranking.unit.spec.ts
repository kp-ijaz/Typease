import { AssignmentCandidate, isOnShift, localWeekdayAndTime, rankCandidates, startOfLocalDay, workloadOf } from './assignment-ranking';

const c = (membershipId: string, extra: Partial<AssignmentCandidate> = {}): AssignmentCandidate => ({ membershipId, hasSkill: false, hasSchedule: false, onShift: false, workload: 0, ...extra });
const order = (list: AssignmentCandidate[]) => rankCandidates(list).map((x) => x.membershipId);

describe('automatic assignment ranking', () => {
  it('prefers staff skilled in the service, whatever their workload', () => {
    expect(order([c('a', { workload: 0 }), c('b', { hasSkill: true, workload: 9 })])).toEqual(['b', 'a']);
  });

  it('prefers staff who are on shift over staff who are scheduled but off', () => {
    expect(order([c('off', { hasSchedule: true, onShift: false }), c('on', { hasSchedule: true, onShift: true, workload: 5 })])).toEqual(['on', 'off']);
    // No schedule at all means "always available".
    expect(order([c('off', { hasSchedule: true, onShift: false }), c('free', { workload: 5 })])).toEqual(['free', 'off']);
    expect(order([c('b-free', { workload: 1 }), c('a-on', { hasSchedule: true, onShift: true, workload: 1 })])).toEqual(['a-on', 'b-free']);
  });

  it('then picks the lowest weighted workload', () => {
    expect(order([c('busy', { workload: 6 }), c('idle', { workload: 1 }), c('mid', { workload: 3 })])).toEqual(['idle', 'mid', 'busy']);
  });

  it('skill outranks shift, shift outranks workload', () => {
    expect(
      order([
        c('1', { workload: 0, hasSchedule: true, onShift: false }),
        c('2', { workload: 4 }),
        c('3', { hasSkill: true, hasSchedule: true, onShift: false, workload: 8 }),
        c('4', { hasSkill: true, workload: 7 }),
      ]),
    ).toEqual(['4', '3', '2', '1']);
  });

  it('breaks ties deterministically and does not change its input', () => {
    const input = [c('m-3'), c('m-1'), c('m-2')];
    expect(order(input)).toEqual(['m-1', 'm-2', 'm-3']);
    expect(order([...input].reverse())).toEqual(['m-1', 'm-2', 'm-3']);
    expect(input.map((x) => x.membershipId)).toEqual(['m-3', 'm-1', 'm-2']);
    expect(order([])).toEqual([]);
  });

  it('weighs urgent and high-priority requests more', () => {
    expect(workloadOf([])).toBe(0);
    expect(workloadOf(['NORMAL', 'LOW'])).toBe(2);
    expect(workloadOf(['URGENT', 'HIGH', 'NORMAL'])).toBe(6);
    // One urgent case is more work than two normal ones.
    expect(order([c('a', { workload: workloadOf(['URGENT']) }), c('b', { workload: workloadOf(['NORMAL', 'NORMAL']) })])).toEqual(['b', 'a']);
  });
});

describe('shift helpers', () => {
  // 2026-03-02 is a Monday. 06:30 UTC = 10:30 in Dubai.
  const now = new Date('2026-03-02T06:30:00Z');
  const shift = (weekday: number, startTime: string, endTime: string, extra: object = {}) => ({ branchId: 'b1', weekday, startTime, endTime, isActive: true, ...extra });

  it('reads the weekday and time in the branch time zone', () => {
    expect(localWeekdayAndTime(now, 'Asia/Dubai')).toEqual({ weekday: 1, time: '10:30' });
    expect(localWeekdayAndTime(new Date('2026-03-01T21:15:00Z'), 'Asia/Dubai')).toEqual({ weekday: 1, time: '01:15' });
    expect(localWeekdayAndTime(now, 'Not/AZone')).toEqual({ weekday: 1, time: '06:30' });
  });

  it('knows who is on shift', () => {
    expect(isOnShift([shift(1, '09:00', '18:00')], 'b1', now, 'Asia/Dubai')).toBe(true);
    expect(isOnShift([shift(1, '11:00', '18:00')], 'b1', now, 'Asia/Dubai')).toBe(false);
    expect(isOnShift([shift(1, '09:00', '10:30')], 'b1', now, 'Asia/Dubai')).toBe(false);
    expect(isOnShift([shift(2, '09:00', '18:00')], 'b1', now, 'Asia/Dubai')).toBe(false);
    expect(isOnShift([shift(1, '09:00', '18:00', { isActive: false })], 'b1', now, 'Asia/Dubai')).toBe(false);
    expect(isOnShift([shift(1, '09:00', '18:00', { branchId: 'b2' })], 'b1', now, 'Asia/Dubai')).toBe(false);
  });

  it('finds the start of the local day', () => {
    expect(startOfLocalDay(now, 'Asia/Dubai').toISOString()).toBe('2026-03-01T20:00:00.000Z');
    expect(startOfLocalDay(new Date('2026-03-01T21:15:00Z'), 'Asia/Dubai').toISOString()).toBe('2026-03-01T20:00:00.000Z');
    expect(startOfLocalDay(now, 'UTC').toISOString()).toBe('2026-03-02T00:00:00.000Z');
  });
});
