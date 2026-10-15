import ExcelJS from 'exceljs';
import type { ReportColumn, ReportRow } from '../report.types';
import { buildPdf } from './pdf';
import { buildXlsx, ExportModel } from './xlsx';

/** Text drawn in an uncompressed pdfkit document: hex strings inside TJ arrays. */
function textOf(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const out: string[] = [];
  for (const tj of raw.matchAll(/\[((?:<[0-9a-fA-F]*>|[^\]])*)\]\s*TJ/g)) {
    let line = '';
    for (const hex of tj[1].matchAll(/<([0-9a-fA-F]*)>/g)) line += Buffer.from(hex[1], 'hex').toString('latin1');
    out.push(line);
  }
  return out.join('\n');
}
const squash = (s: string) => s.replace(/\s+/g, '');
const pages = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;

const columns: ReportColumn[] = [
  { key: 'date', label: 'Date', type: 'date' },
  { key: 'customer', label: 'Customer', type: 'text' },
  { key: 'count', label: 'Invoices', type: 'number' },
  { key: 'amount', label: 'Amount', type: 'money' },
  { key: 'share', label: 'Share', type: 'percent' },
];
const rows: ReportRow[] = [
  { date: '2026-10-01', customer: 'Fatima Al Mansoori', count: 2, amount: '1250.50', share: 62.5, invoiceId: 'not-a-column' },
  { date: '2026-10-02', customer: '=HYPERLINK("http://evil.example","Pay here")', count: 1, amount: '-12.00', share: 37.5 },
  { date: '2026-10-03', customer: '+971501234567', count: 0, amount: '0.00', share: null },
  { date: '2026-10-04', customer: "@SUM(1+1)*cmd|' /C calc'!A0", count: 3, amount: '99999999999.99', share: 0 },
];
const model = (over: Partial<ExportModel> = {}): ExportModel => ({
  key: 'daily-sales', title: 'Daily sales', tenantName: '=Evil Centre', generatedAt: new Date('2026-10-09T08:30:00.000Z'), timeZone: 'Asia/Dubai', currency: 'AED',
  parameters: [['Period', '2026-10-01 to 2026-10-04'], ['Branch', 'All branches']],
  columns, rows, totals: { date: 'Total', customer: null, count: 6, amount: '100000001238.49', share: 100 },
  notes: ['Gross collections are on a cash basis.', 'Tax is reported separately.'],
  ...over,
});

describe('XLSX export', () => {
  const load = async (buffer: Buffer) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    return wb;
  };

  it('writes typed cells: numbers as numbers, money with two decimals, dates as dates', async () => {
    const wb = await load(await buildXlsx(model()));
    const sheet = wb.getWorksheet('Report')!;
    expect(sheet.getRow(1).values).toEqual([undefined, 'Date', 'Customer', 'Invoices', 'Amount', 'Share']);
    expect(sheet.getRow(1).getCell(1).font?.bold).toBe(true);
    expect((sheet.getRow(1).getCell(1).fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FF0B2240');
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });

    const first = sheet.getRow(2);
    expect(first.getCell(1).value).toBeInstanceOf(Date);
    expect((first.getCell(1).value as Date).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(first.getCell(1).numFmt).toBe('yyyy-mm-dd');
    expect(first.getCell(2).value).toBe('Fatima Al Mansoori');
    expect(first.getCell(3).value).toBe(2);
    expect(first.getCell(3).type).toBe(ExcelJS.ValueType.Number);
    expect(first.getCell(4).value).toBe(1250.5);
    expect(first.getCell(4).type).toBe(ExcelJS.ValueType.Number);
    expect(first.getCell(4).numFmt).toBe('#,##0.00');
    expect(first.getCell(5).value).toBe(0.625);
    expect(first.getCell(5).numFmt).toBe('0.0%');
    expect(sheet.getRow(3).getCell(4).value).toBe(-12);
    expect(sheet.getRow(5).getCell(4).value).toBe(99999999999.99);
    expect(sheet.getRow(4).getCell(5).value).toBeNull();
    // Keys that are not columns (ids for linking) are not exported.
    expect(sheet.columnCount).toBe(5);
  });

  it('adds a bold totals row computed on the server', async () => {
    const sheet = (await load(await buildXlsx(model()))).getWorksheet('Report')!;
    const totals = sheet.getRow(6);
    expect(totals.getCell(1).value).toBe('Total');
    expect(totals.getCell(3).value).toBe(6);
    expect(totals.getCell(4).value).toBe(100000001238.49);
    expect(totals.getCell(4).font?.bold).toBe(true);
    expect(totals.getCell(4).type).toBe(ExcelJS.ValueType.Number); // a value, not a spreadsheet formula
    expect(sheet.rowCount).toBe(6);
  });

  it('neutralises formula injection in every text cell and never writes a formula', async () => {
    const wb = await load(await buildXlsx(model()));
    const sheet = wb.getWorksheet('Report')!;
    expect(sheet.getRow(3).getCell(2).value).toBe('\'=HYPERLINK("http://evil.example","Pay here")');
    expect(sheet.getRow(4).getCell(2).value).toBe("'+971501234567");
    expect(sheet.getRow(5).getCell(2).value).toBe("'@SUM(1+1)*cmd|' /C calc'!A0");
    for (const ws of wb.worksheets) {
      ws.eachRow((row) => row.eachCell((cell) => {
        expect(cell.type).not.toBe(ExcelJS.ValueType.Formula);
        expect(cell.type).not.toBe(ExcelJS.ValueType.Hyperlink);
        if (typeof cell.value === 'string') expect(/^[\s]*[=+\-@]/.test(cell.value)).toBe(false);
      }));
    }
    // A header label or a "number" that is really a formula is text too.
    const odd = await load(await buildXlsx(model({ columns: [{ key: 'amount', label: '=1+1', type: 'money' }], rows: [{ amount: '=2*3' }], totals: undefined })));
    expect(odd.getWorksheet('Report')!.getRow(1).getCell(1).value).toBe("'=1+1");
    expect(odd.getWorksheet('Report')!.getRow(2).getCell(1).value).toBe("'=2*3");
    expect(odd.getWorksheet('Report')!.getRow(2).getCell(1).type).toBe(ExcelJS.ValueType.String);
  });

  it('has a "Parameters" sheet with the centre, filters, generated-at and the notes', async () => {
    const info = (await load(await buildXlsx(model()))).getWorksheet('Parameters')!;
    const pairs: Record<string, unknown> = {};
    const notes: unknown[] = [];
    info.eachRow((row) => {
      const label = String(row.getCell(1).value ?? '');
      if (label) pairs[label] = row.getCell(2).value;
      if (label === 'Notes' || (!label && row.getCell(2).value)) notes.push(row.getCell(2).value);
    });
    expect(pairs).toMatchObject({ Report: 'Daily sales', Centre: "'=Evil Centre", 'Time zone of the report': 'Asia/Dubai', Currency: 'AED', Period: '2026-10-01 to 2026-10-04', Branch: 'All branches' });
    expect(pairs['Generated at (UTC)']).toBeInstanceOf(Date);
    expect((pairs['Generated at (UTC)'] as Date).toISOString()).toBe('2026-10-09T08:30:00.000Z');
    expect(notes).toEqual(['Gross collections are on a cash basis.', 'Tax is reported separately.']);
  });
});

describe('PDF export', () => {
  const brand = { name: 'Al Noor Typing', colors: { primary: '#7A1F5C', secondary: '#0B7AD1', accent: '#F59E0B' }, supportEmail: 'help@alnoor.example', supportPhone: '+97141234567', poweredBy: true };

  it('is a valid PDF with the branded header, the table, totals and notes', async () => {
    const pdf = await buildPdf(model({ tenantName: 'Al Noor Typing' }), brand, { compress: false });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.subarray(-6).toString()).toContain('%%EOF');
    const flat = squash(textOf(pdf));
    for (const expected of [
      'Al Noor Typing', '+97141234567 | help@alnoor.example', 'Daily sales', 'Generated 2026-10-09 08:30 UTC', 'Period: 2026-10-01 to 2026-10-04', 'Branch: All branches', 'Currency: AED',
      'Date', 'Customer', 'Invoices', 'Amount', 'Share', 'Fatima Al Mansoori', '2026-10-01', '1250.50', '62.5%', '-12.00',
      'Total', '100000001238.49', 'Notes', 'Gross collections are on a cash basis.', 'Powered by TypEase', 'Page 1 of 1',
    ]) expect(flat).toContain(squash(expected));
    // The brand colour fills the header band (0.478 0.122 0.361 = #7A1F5C).
    expect(pdf.toString('latin1')).toMatch(/0\.478\d* 0\.121\d* 0\.360\d* scn/);
  });

  it('breaks long tables over pages and repeats the header row', async () => {
    const many: ReportRow[] = Array.from({ length: 180 }, (_, i) => ({ date: '2026-10-01', customer: `Customer ${i + 1}`, count: i, amount: `${i}.00`, share: 1 }));
    // Without notes every page carries table rows, so the header row appears once per page.
    const pdf = await buildPdf(model({ rows: many, notes: [] }), { ...brand, poweredBy: false }, { compress: false });
    const count = pages(pdf);
    expect(count).toBeGreaterThanOrEqual(4);
    const text = textOf(pdf);
    expect(text.split('\n').filter((l) => squash(l) === 'Customer').length).toBe(count);
    expect(squash(text)).toContain(`Page${count}of${count}`);
    expect(squash(text)).toContain('Customer180');
    expect(squash(text)).not.toContain('PoweredbyTypEase');
  });

  it('uses landscape for wide reports and survives an empty one', async () => {
    const wide: ReportColumn[] = Array.from({ length: 9 }, (_, i) => ({ key: `c${i}`, label: `Column ${i}`, type: i ? 'money' : 'text' }));
    const pdf = await buildPdf(model({ columns: wide, rows: [], totals: undefined }), brand, { compress: false });
    expect(pdf.toString('latin1')).toMatch(/MediaBox \[0 0 841\.89 595\.28\]/);
    expect(squash(textOf(pdf))).toContain('Nodataforthechosenfilters.');
  });
});
