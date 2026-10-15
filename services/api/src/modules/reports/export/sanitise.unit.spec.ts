import { buildCsv, displayText, exportCell, neutralise } from './sanitise';

const text = { key: 'name', label: 'Name', type: 'text' as const };
const money = { key: 'amount', label: 'Amount', type: 'money' as const };
const number = { key: 'n', label: 'Count', type: 'number' as const };
const date = { key: 'd', label: 'Date', type: 'date' as const };
const pct = { key: 'p', label: 'Share', type: 'percent' as const };

describe('formula-injection guard', () => {
  it('neutralises text that a spreadsheet would run as a formula', () => {
    for (const evil of ['=HYPERLINK("http://evil","x")', '+1+1', '-2+3', '@SUM(A1:A9)', '  =cmd|\' /C calc\'!A0', '\t=1+1', '\r=1+1', '=1+1']) {
      expect(neutralise(evil)).toBe(`'${evil}`);
      expect(neutralise(evil).startsWith("'")).toBe(true);
    }
  });
  it('leaves ordinary text alone', () => {
    for (const fine of ['Fatima Al Mansoori', 'A=B', 'Visa - renewal', 'mail@example.com', '100.00', 'فاطمة', '']) expect(neutralise(fine)).toBe(fine);
  });

  it('types cells by column, and treats everything that is not what the column promises as text', () => {
    expect(exportCell(money, '1250.50')).toEqual({ kind: 'number', value: 1250.5, raw: '1250.50' });
    expect(exportCell(money, '-12.00')).toEqual({ kind: 'number', value: -12, raw: '-12.00' });
    expect(exportCell(number, 7)).toEqual({ kind: 'number', value: 7, raw: '7' });
    expect(exportCell(pct, 45.5)).toMatchObject({ kind: 'number', value: 45.5 });
    expect(exportCell(date, '2026-10-09')).toMatchObject({ kind: 'date', raw: '2026-10-09' });
    expect(exportCell(text, null)).toEqual({ kind: 'empty' });
    // A "number" that is really a formula never becomes a numeric or formula cell.
    expect(exportCell(money, '=1+1')).toEqual({ kind: 'text', text: "'=1+1" });
    expect(exportCell(number, '+971501234567')).toEqual({ kind: 'text', text: "'+971501234567" });
    expect(exportCell(date, '=TODAY()')).toEqual({ kind: 'text', text: "'=TODAY()" });
    expect(exportCell(text, '-negative looking name')).toEqual({ kind: 'text', text: "'-negative looking name" });
    expect(exportCell(money, 'Total')).toEqual({ kind: 'text', text: 'Total' });
  });

  it('renders display text for PDF cells', () => {
    expect(displayText(money, '1250.5')).toBe('1250.50');
    expect(displayText(pct, 45.5)).toBe('45.5%');
    expect(displayText(date, '2026-10-09T10:00:00.000Z')).toBe('2026-10-09');
    expect(displayText(text, '=SUM(1)')).toBe("'=SUM(1)");
    expect(displayText(text, undefined)).toBe('');
  });

  it('builds CSV with quoting, a byte-order mark and neutralised text', () => {
    const csv = buildCsv(
      [text, money, date],
      [
        { name: '=cmd|\' /C calc\'!A0', amount: '10.00', d: '2026-10-09' },
        { name: 'Al Noor, "Typing"', amount: '-5.50', d: null },
        { name: '@import', amount: '=2*3', d: '2026-10-10' },
      ],
      { name: 'Total', amount: '4.50' },
    ).toString('utf8');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe('Name,Amount,Date');
    expect(lines[1]).toBe("'=cmd|' /C calc'!A0,10.00,2026-10-09");
    expect(lines[2]).toBe('"Al Noor, ""Typing""",-5.50,');
    expect(lines[3]).toBe("'@import,'=2*3,2026-10-10");
    expect(lines[4]).toBe('Total,4.50,');
    // No data line starts with a formula trigger.
    expect(lines.slice(1, 4).every((l) => !/^[=+@]/.test(l))).toBe(true);
  });
});
