import { afterCustomerReply, breachState, DEFAULT_SLA, dueTimes, parseSupportSettings, TICKET_TRANSITIONS } from './sla';

describe('support SLA rules', () => {
  const opened = new Date('2026-10-09T08:00:00Z');
  const due = dueTimes(opened, DEFAULT_SLA.NORMAL);

  it('computes due times from the moment the ticket was opened', () => {
    expect(due.firstResponseDueAt!.toISOString()).toBe('2026-10-09T12:00:00.000Z');
    expect(due.resolutionDueAt!.toISOString()).toBe('2026-10-11T08:00:00.000Z');
    expect(dueTimes(opened, DEFAULT_SLA.URGENT).firstResponseDueAt!.toISOString()).toBe('2026-10-09T08:30:00.000Z');
    expect(dueTimes(opened, null)).toEqual({ firstResponseDueAt: null, resolutionDueAt: null });
  });

  it('flags a missing or late first response', () => {
    const base = { status: 'OPEN' as const, ...due, firstRespondedAt: null, resolvedAt: null };
    expect(breachState(base, new Date('2026-10-09T11:59:00Z'))).toEqual({ firstResponseBreached: false, resolutionBreached: false });
    expect(breachState(base, new Date('2026-10-09T12:01:00Z')).firstResponseBreached).toBe(true);
    expect(breachState({ ...base, firstRespondedAt: new Date('2026-10-09T09:00:00Z') }, new Date('2026-10-10T00:00:00Z')).firstResponseBreached).toBe(false);
    // Answered late: the breach stays visible afterwards.
    expect(breachState({ ...base, status: 'IN_PROGRESS', firstRespondedAt: new Date('2026-10-09T13:00:00Z') }, new Date('2026-10-09T14:00:00Z')).firstResponseBreached).toBe(true);
  });

  it('flags a missing or late resolution', () => {
    const base = { status: 'IN_PROGRESS' as const, ...due, firstRespondedAt: new Date('2026-10-09T09:00:00Z'), resolvedAt: null };
    expect(breachState(base, new Date('2026-10-11T07:00:00Z')).resolutionBreached).toBe(false);
    expect(breachState(base, new Date('2026-10-11T09:00:00Z')).resolutionBreached).toBe(true);
    expect(breachState({ ...base, status: 'RESOLVED', resolvedAt: new Date('2026-10-10T08:00:00Z') }, new Date('2026-12-01T00:00:00Z')).resolutionBreached).toBe(false);
    expect(breachState({ ...base, status: 'RESOLVED', resolvedAt: new Date('2026-10-12T08:00:00Z') }, new Date('2026-12-01T00:00:00Z')).resolutionBreached).toBe(true);
    // Resolved straight away without a separate reply: the resolution counts as the response.
    expect(breachState({ status: 'RESOLVED', ...due, firstRespondedAt: null, resolvedAt: new Date('2026-10-09T09:00:00Z') }, new Date('2026-12-01T00:00:00Z'))).toEqual({ firstResponseBreached: false, resolutionBreached: false });
    expect(breachState({ status: 'OPEN', firstResponseDueAt: null, resolutionDueAt: null, firstRespondedAt: null, resolvedAt: null }, new Date('2030-01-01T00:00:00Z'))).toEqual({ firstResponseBreached: false, resolutionBreached: false });
  });

  it('defines the staff state machine with CLOSED as the end', () => {
    expect(TICKET_TRANSITIONS.OPEN).toEqual(['IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED']);
    expect(TICKET_TRANSITIONS.RESOLVED).toEqual(['IN_PROGRESS', 'CLOSED']);
    expect(TICKET_TRANSITIONS.CLOSED).toEqual([]);
    expect(TICKET_TRANSITIONS.IN_PROGRESS).not.toContain('OPEN');
  });

  it('decides what a customer reply does', () => {
    const now = new Date('2026-10-20T00:00:00Z');
    expect(afterCustomerReply('OPEN', null, 7, now)).toEqual({ status: 'OPEN', reopened: false });
    expect(afterCustomerReply('IN_PROGRESS', null, 7, now)).toEqual({ status: 'IN_PROGRESS', reopened: false });
    expect(afterCustomerReply('WAITING_CUSTOMER', null, 7, now)).toEqual({ status: 'IN_PROGRESS', reopened: false });
    expect(afterCustomerReply('RESOLVED', new Date('2026-10-15T00:00:00Z'), 7, now)).toEqual({ status: 'IN_PROGRESS', reopened: true });
    expect(afterCustomerReply('RESOLVED', new Date('2026-10-12T00:00:00Z'), 7, now)).toBe('CLOSED');
    expect(afterCustomerReply('RESOLVED', new Date('2026-10-19T00:00:00Z'), 0, now)).toBe('CLOSED');
    expect(afterCustomerReply('CLOSED', new Date('2026-10-19T00:00:00Z'), 30, now)).toBe('CLOSED');
  });

  it('reads the reopen window from the centre settings', () => {
    expect(parseSupportSettings({ support: { reopenWindowDays: 14 } })).toEqual({ reopenWindowDays: 14 });
    expect(parseSupportSettings({ support: { reopenWindowDays: 0 } })).toEqual({ reopenWindowDays: 0 });
    expect(parseSupportSettings({})).toEqual({ reopenWindowDays: 7 });
    expect(parseSupportSettings({ support: { reopenWindowDays: 900 } })).toEqual({ reopenWindowDays: 7 });
  });
});
