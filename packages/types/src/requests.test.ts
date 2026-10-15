import { describe, expect, it } from 'vitest';
import { REQUEST_TRANSITIONS, findTransition, TERMINAL_STATUSES } from './requests';
import { RequestStatusValues } from './generated/models';

describe('request state machine', () => {
  it('covers every status', () => {
    for (const s of RequestStatusValues) expect(REQUEST_TRANSITIONS[s]).toBeDefined();
  });
  it('has no arbitrary jumps', () => {
    expect(findTransition('DRAFT', 'COMPLETED')).toBeUndefined();
    expect(findTransition('SUBMITTED', 'EXTERNAL_PROCESSING')).toBeUndefined();
    expect(findTransition('AWAITING_PAYMENT', 'COMPLETED')).toBeUndefined();
    expect(findTransition('CANCELLED', 'IN_PREPARATION')).toBeUndefined();
  });
  it('only allows completion from final review', () => {
    const sources = RequestStatusValues.filter((s) => findTransition(s, 'COMPLETED'));
    expect(sources).toEqual(['FINAL_REVIEW']);
  });
  it('every non-terminal status can be reached and left', () => {
    const reachable = new Set<string>(['DRAFT']);
    for (const rules of Object.values(REQUEST_TRANSITIONS)) rules.forEach((r) => reachable.add(r.to));
    for (const s of RequestStatusValues) {
      expect(reachable.has(s)).toBe(true);
      if (!TERMINAL_STATUSES.includes(s) ) expect(REQUEST_TRANSITIONS[s].length).toBeGreaterThan(0);
    }
  });
  it('customers can never move a case through processing', () => {
    for (const from of ['READY_FOR_PROCESSING', 'IN_PREPARATION', 'PENDING_APPROVAL', 'READY_TO_SUBMIT', 'EXTERNAL_PROCESSING', 'FINAL_REVIEW'] as const)
      for (const r of REQUEST_TRANSITIONS[from]) expect(r.customer ?? false).toBe(false);
  });
});
