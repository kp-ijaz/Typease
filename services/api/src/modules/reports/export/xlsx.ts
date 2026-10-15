import ExcelJS from 'exceljs';
import type { ReportColumn, ReportRow } from '../report.types';
import { exportCell, neutralise } from './sanitise';

export interface ExportModel {
  key: string;
  title: string;
  tenantName: string;
  generatedAt: Date;
  timeZone: string;
  currency: string;
  /** Filters the report was run with: label, value. */
  parameters: Array<[string, string]>;
  columns: ReportColumn[];
  rows: ReportRow[];
  totals?: ReportRow;
  notes: string[];
}

const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B2240' } };
const FORMATS: Record<ReportColumn['type'], string | undefined> = { text: undefined, number: '#,##0.##', money: '#,##0.00', percent: '0.0%', date: 'yyyy-mm-dd' };

function writeCell(cell: ExcelJS.Cell, column: ReportColumn, value: ReportRow[string] | undefined): void {
  const typed = exportCell(column, value);
  if (typed.kind === 'empty') return;
  if (typed.kind === 'text') {
    // Always an explicit string cell: never a formula, whatever the text looks like.
    cell.value = typed.text;
    cell.numFmt = '@';
    return;
  }
  if (typed.kind === 'date') {
    cell.value = typed.value;
    cell.numFmt = FORMATS.date!;
    return;
  }
  // Spreadsheets have no decimal type: amounts are written as numbers with a two-decimal format.
  // Every total in the file was computed on the server with exact decimal arithmetic, not by a spreadsheet formula.
  cell.value = column.type === 'percent' ? typed.value / 100 : typed.value;
  const format = FORMATS[column.type];
  if (format) cell.numFmt = format;
  cell.alignment = { horizontal: 'right' };
}

/**
 * Excel workbook of a report: sheet "Report" (styled header, typed cells,
 * totals row) and sheet "Parameters" (centre, filters, generated-at, notes).
 */
export async function buildXlsx(model: ExportModel): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'TypEase';
  workbook.created = model.generatedAt;
  workbook.modified = model.generatedAt;

  const sheet = workbook.addWorksheet('Report', { views: [{ state: 'frozen', ySplit: 1 }] });
  const header = sheet.addRow(model.columns.map((c) => neutralise(c.label)));
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = HEADER_FILL;
    cell.alignment = { vertical: 'middle', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF0B2240' } } };
  });
  header.height = 30;
  model.columns.forEach((c, i) => {
    const longest = Math.max(c.label.length, ...model.rows.slice(0, 500).map((r) => String(r[c.key] ?? '').length));
    sheet.getColumn(i + 1).width = Math.min(60, Math.max(c.type === 'text' ? 14 : 12, Math.ceil(longest * 1.1) + 2));
  });
  for (const row of model.rows) {
    const line = sheet.addRow([]);
    model.columns.forEach((c, i) => writeCell(line.getCell(i + 1), c, row[c.key]));
  }
  if (model.totals) {
    const line = sheet.addRow([]);
    model.columns.forEach((c, i) => {
      const cell = line.getCell(i + 1);
      writeCell(cell, c, model.totals![c.key]);
      cell.font = { bold: true };
      cell.border = { top: { style: 'thin' }, bottom: { style: 'double' } };
    });
  }
  if (model.columns.length) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: model.columns.length } };

  const info = workbook.addWorksheet('Parameters');
  info.getColumn(1).width = 26;
  info.getColumn(2).width = 90;
  const pair = (label: string, value: string | Date) => {
    const row = info.addRow([label]);
    row.getCell(1).font = { bold: true };
    const cell = row.getCell(2);
    if (value instanceof Date) {
      cell.value = value;
      cell.numFmt = 'yyyy-mm-dd hh:mm';
      cell.alignment = { horizontal: 'left' };
    } else {
      cell.value = neutralise(value);
      cell.numFmt = '@';
      cell.alignment = { wrapText: true, vertical: 'top' };
    }
  };
  pair('Report', model.title);
  pair('Centre', model.tenantName);
  pair('Generated at (UTC)', model.generatedAt);
  pair('Time zone of the report', model.timeZone);
  pair('Currency', model.currency);
  for (const [label, value] of model.parameters) pair(label, value);
  info.addRow([]);
  model.notes.forEach((note, i) => pair(i === 0 ? 'Notes' : '', note));

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
