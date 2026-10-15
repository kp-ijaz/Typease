import { headerKey, normaliseDate, normalisePhone, parseCsv, parseYesNo, toCsv } from './tabular';

describe('tabular import helpers', () => {
  it('reads CSV with quotes, embedded commas and new lines, semicolons and a BOM', () => {
    expect(parseCsv('﻿name,note\r\n"Al Noor, LLC","said ""hi""\nthen left"\r\nB,\r\n')).toEqual([['name', 'note'], ['Al Noor, LLC', 'said "hi"\nthen left'], ['B', '']]);
    expect(parseCsv('a;b\n1;2')).toEqual([['a', 'b'], ['1', '2']]);
  });
  it('normalises headers, UAE phone numbers, day-first dates and yes/no', () => {
    expect(headerKey(' Full_Name ')).toBe('fullname');
    expect(['0501234567', '971501234567', '00971501234567', '+971 50 123 4567', '501234567'].map(normalisePhone)).toEqual(Array(5).fill('+971501234567'));
    expect(normalisePhone('+44 7700 900123')).toBe('+447700900123');
    expect(['01/03/2026', '1-3-2026', '01.03.2026', '2026-03-01'].map(normaliseDate)).toEqual(Array(4).fill('2026-03-01'));
    expect([parseYesNo('Yes'), parseYesNo('لا'), parseYesNo('')]).toEqual([true, false, undefined]);
  });
  it('writes CSV Excel opens correctly', () => {
    expect(toCsv([['a', 'b,c'], ['"q"', 'x']])).toBe('﻿a,"b,c"\r\n"""q""",x\r\n');
  });
});
