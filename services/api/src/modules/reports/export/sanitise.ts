import type { ReportColumn, ReportRow } from '../report.types';

/**
 * Formula-injection guard for spreadsheet exports.
 *
 * Excel, LibreOffice and Google Sheets evaluate a cell whose text starts with
 * `=`, `+`, `-` or `@` (also after leading white space, and after a tab or
 * carriage return) as a formula. Customer names, refund reasons, service names
 * and comments are typed by people, so every TEXT cell passes through here: a
 * dangerous value is prefixed with an apostrophe, which spreadsheets show as
 * plain text. Numbers, money, percentages and dates never reach this function:
 * they are written as typed numeric / date cells.
 */
const DANGEROUS = /^[\s]*[=+\-@]|^[\t\r\n]/;
export function neutralise(value: string): string {
  return DANGEROUS.test(value) ? `'${value}` : value;
}

export const isNumeric = (value: unknown): value is string | number => (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value));
export const isDay = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

/** A cell as an export sees it: typed, with text already neutralised. */
export type ExportCell = { kind: 'empty' } | { kind: 'text'; text: string } | { kind: 'number'; value: number; raw: string } | { kind: 'date'; value: Date; raw: string };

export function exportCell(column: ReportColumn, value: ReportRow[string] | undefined): ExportCell {
  if (value === null || value === undefined || value === '') return { kind: 'empty' };
  if ((column.type === 'number' || column.type === 'money' || column.type === 'percent') && isNumeric(value)) return { kind: 'number', value: Number(value), raw: String(value) };
  if (column.type === 'date') {
    if (isDay(value)) return { kind: 'date', value: new Date(`${value}T00:00:00.000Z`), raw: value };
    if (typeof value === 'string' && !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value)) return { kind: 'date', value: new Date(value), raw: value };
  }
  // Anything else (labels such as "Total", or a value that is not what its column promises) is text, and text is neutralised.
  return { kind: 'text', text: neutralise(String(value)) };
}

/** Text for a CSV / PDF cell. */
export function displayText(column: ReportColumn, value: ReportRow[string] | undefined): string {
  const cell = exportCell(column, value);
  if (cell.kind === 'empty') return '';
  if (cell.kind === 'text') return cell.text;
  if (cell.kind === 'date') return cell.raw.slice(0, 10);
  if (column.type === 'money') return cell.value.toFixed(2);
  if (column.type === 'percent') return `${cell.raw}%`;
  return cell.raw;
}

const csvField = (text: string) => (/[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);

/** RFC 4180 CSV (UTF-8 with a byte-order mark so Excel reads Arabic names correctly). */
export function buildCsv(columns: ReportColumn[], rows: ReportRow[], totals?: ReportRow): Buffer {
  const line = (row: ReportRow) =>
    columns
      .map((c) => {
        const cell = exportCell(c, row[c.key]);
        if (cell.kind === 'empty') return '';
        // Numeric cells are emitted as bare numbers (a leading minus is a number here, not a formula).
        if (cell.kind === 'number') return c.type === 'money' ? cell.value.toFixed(2) : cell.raw;
        if (cell.kind === 'date') return cell.raw.slice(0, 10);
        return csvField(cell.text);
      })
      .join(',');
  const out = [columns.map((c) => csvField(neutralise(c.label))).join(','), ...rows.map(line)];
  if (totals) out.push(line(totals));
  return Buffer.from(`\uFEFF${out.join('\r\n')}\r\n`, 'utf8');
}
