import ExcelJS from 'exceljs';
import { Errors } from './errors';

/** Most rows one import file may hold. Larger lists are split into several files. */
export const MAX_IMPORT_ROWS = 1000;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export interface ParsedTable {
  /** Normalised header keys in column order. */
  headers: string[];
  /** One object per non-empty row, keyed by normalised header. `rowNo` is the spreadsheet row (header = 1). */
  rows: Array<{ rowNo: number; values: Record<string, string> }>;
}

/** "Full Name", "full_name", "FULL-NAME" -> "fullname". */
export const headerKey = (h: string) => h.normalize('NFKC').toLowerCase().replace(/[^a-z0-9؀-ۿ]/g, '');

const ymd = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

/** RFC 4180 CSV (quoted fields, doubled quotes, CRLF), comma or semicolon separated, UTF-8 with or without BOM. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === sep) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      out.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    out.push(row);
  }
  return out;
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return ymd(value);
  if (typeof value === 'object') {
    if ('result' in value && value.result !== undefined) return cellText(value.result as ExcelJS.CellValue);
    if ('text' in value && typeof value.text === 'string') return value.text;
    if ('richText' in value) return value.richText.map((r) => r.text).join('');
    return '';
  }
  return String(value);
}

/** Reads the first sheet of an .xlsx file or a .csv file into header-keyed rows. Blank rows are skipped. */
export async function parseTable(file: { originalname: string; buffer: Buffer; size: number } | undefined): Promise<ParsedTable> {
  if (!file?.buffer?.length) throw Errors.badRequest('FILE_REQUIRED', 'Attach the CSV or Excel file in the "file" field.');
  if (file.size > MAX_IMPORT_BYTES) throw Errors.unprocessable('FILE_TOO_LARGE', 'The file is larger than 5 MB. Split it into smaller files.');
  const isXlsx = file.buffer.subarray(0, 2).toString('latin1') === 'PK';
  let grid: string[][];
  if (isXlsx) {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(file.buffer as unknown as ArrayBuffer);
    } catch {
      throw Errors.unprocessable('FILE_UNREADABLE', 'The Excel file could not be read. Save it again as .xlsx or .csv.');
    }
    const sheet = wb.worksheets[0];
    if (!sheet) throw Errors.unprocessable('FILE_EMPTY', 'The file has no sheet.');
    grid = [];
    sheet.eachRow({ includeEmpty: true }, (row, n) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => (cells[col - 1] = cellText(cell.value).trim()));
      grid[n - 1] = cells;
    });
    grid = Array.from(grid, (r) => r ?? []);
  } else {
    const text = file.buffer.toString('utf8');
    if (text.includes('\u0000')) throw Errors.unprocessable('FILE_UNREADABLE', 'Upload a CSV (UTF-8) or Excel (.xlsx) file.');
    grid = parseCsv(text);
  }
  const headerRow = grid.findIndex((r) => r.some((c) => c?.trim()));
  if (headerRow < 0) throw Errors.unprocessable('FILE_EMPTY', 'The file is empty.');
  const headers = grid[headerRow]!.map((h) => headerKey(h ?? ''));
  const rows: ParsedTable['rows'] = [];
  for (let i = headerRow + 1; i < grid.length; i++) {
    const cells = grid[i] ?? [];
    if (!cells.some((c) => c?.trim())) continue;
    const values: Record<string, string> = {};
    headers.forEach((h, j) => {
      if (h) values[h] = (cells[j] ?? '').trim();
    });
    rows.push({ rowNo: i + 1, values });
  }
  if (!rows.length) throw Errors.unprocessable('FILE_EMPTY', 'The file has a header but no rows.');
  if (rows.length > MAX_IMPORT_ROWS) throw Errors.unprocessable('TOO_MANY_ROWS', `The file has ${rows.length} rows; import at most ${MAX_IMPORT_ROWS} at a time.`);
  return { headers, rows };
}

/** The first of several possible header names that is present in a row. */
export function pickColumn(values: Record<string, string>, aliases: string[]): string {
  for (const a of aliases) {
    const v = values[headerKey(a)];
    if (v !== undefined && v !== '') return v;
  }
  return '';
}

/** 05x / 9715x / 009715x / +9715x -> +9715x. Other countries must already start with +. */
export function normalisePhone(raw: string): string {
  const v = raw.replace(/[\s()\-.]/g, '');
  if (!v) return '';
  if (/^\+/.test(v)) return v;
  if (/^00/.test(v)) return `+${v.slice(2)}`;
  if (/^0[1-9]\d{7,8}$/.test(v)) return `+971${v.slice(1)}`;
  if (/^971\d{8,9}$/.test(v)) return `+${v}`;
  if (/^5\d{8}$/.test(v)) return `+971${v}`;
  return v;
}

/** 2026-03-01, 01/03/2026, 1-3-2026, 01.03.2026 (day first, as in the UAE) -> 2026-03-01. */
export function normaliseDate(raw: string): string {
  const v = raw.trim();
  if (!v) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  return v;
}

/** yes / y / true / 1 / نعم -> true; no / n / false / 0 / لا -> false; empty -> undefined. */
export function parseYesNo(raw: string): boolean | undefined {
  const v = raw.trim().toLowerCase();
  if (!v) return undefined;
  if (['yes', 'y', 'true', '1', 'نعم'].includes(v)) return true;
  if (['no', 'n', 'false', '0', 'لا'].includes(v)) return false;
  return undefined;
}

/** A CSV text, quoted where needed, with a UTF-8 BOM so Excel opens Arabic correctly. */
export function toCsv(rows: string[][]): string {
  const q = (c: string) => (/[",\n\r;]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
  return `\uFEFF${rows.map((r) => r.map(q).join(',')).join('\r\n')}\r\n`;
}
