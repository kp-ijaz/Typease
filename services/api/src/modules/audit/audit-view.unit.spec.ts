import { auditWhere, csvCell, rangeBound, toCsv } from './audit-view';

describe('audit view helpers', () => {
  it('rangeBound treats a date as the whole UTC day and keeps timestamps exact', () => {
    expect(rangeBound(undefined, false)).toBeUndefined();
    expect(rangeBound('2026-06-01', false)!.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(rangeBound('2026-06-01', true)!.toISOString()).toBe('2026-06-01T23:59:59.999Z');
    expect(rangeBound('2026-06-01T10:15:00+04:00', true)!.toISOString()).toBe('2026-06-01T06:15:00.000Z');
  });

  it('auditWhere builds only the filters that were asked for', () => {
    expect(auditWhere({})).toEqual({});
    expect(auditWhere({ action: 'invoice.', resourceType: 'Invoice', resourceId: 'abc', actorType: 'STAFF' })).toEqual({ action: { startsWith: 'invoice.' }, resourceType: 'Invoice', resourceId: 'abc', actorType: 'STAFF' });
    expect(auditWhere({ from: '2026-01-01' })).toEqual({ createdAt: { gte: new Date('2026-01-01T00:00:00.000Z') } });
    expect(auditWhere({ supportAccess: true })).toEqual({ supportGrantId: { not: null } });
    expect(auditWhere({ supportAccess: false })).toEqual({ supportGrantId: null });
    // An explicit grant wins over the yes / no switch.
    // One grant: what was done under it, and what the centre did about it (approve, deny, revoke).
    const oneGrant = { OR: [{ supportGrantId: 'g1' }, { resourceType: 'AccessGrant', resourceId: 'g1' }] };
    expect(auditWhere({ supportAccess: false, supportGrantId: 'g1' })).toEqual(oneGrant);
    expect(auditWhere({ q: 'visa' }).OR).toHaveLength(3);
    // Both a grant and a search text: the two alternatives are combined, never merged into one OR.
    const both = auditWhere({ supportGrantId: 'g1', q: 'visa' });
    expect(both.OR).toBeUndefined();
    expect(both.AND).toEqual([oneGrant, { OR: expect.any(Array) }]);
  });

  it('csvCell quotes what needs quoting and defuses spreadsheet formulas', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell(new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02T03:04:05.000Z');
    expect(csvCell(42)).toBe('42');
    for (const formula of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx']) expect(csvCell(formula).replace(/^"/, '').startsWith("'")).toBe(true);
    expect(csvCell('=A1,"x"')).toBe('"\'=A1,""x"""');
    // An ordinary value containing these characters later on is untouched.
    expect(csvCell('a=b')).toBe('a=b');
    expect(csvCell('محمد')).toBe('محمد');
  });

  it('toCsv writes a header, CRLF lines and a byte-order mark', () => {
    const csv = toCsv([{ a: 1, b: 'x,y' }, { a: null, b: 'z' }], ['a', 'b']);
    expect(csv).toBe('﻿a,b\r\n1,"x,y"\r\n,z\r\n');
    expect(toCsv([], ['a'])).toBe('﻿a\r\n');
  });
});
