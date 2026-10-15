import type { OcrFieldKey } from '@typease/validation';
import { countryNameToAlpha3 } from './countries';
import { findMrz, MrzField, MrzIssue, MrzResult } from './mrz';

/**
 * Turns recognised text into structured, confidence-scored field suggestions.
 * Pure functions: no I/O, no logging. Nothing here is ever "verified": the
 * output is a suggestion for a human reviewer, and a value that cannot be
 * found is simply absent (never guessed).
 */

export type DocumentClass = 'PASSPORT' | 'EMIRATES_ID' | 'TRADE_LICENCE' | 'UNKNOWN';
/** MRZ = machine readable zone (check digits). TEXT = labelled printed text. HEURISTIC = loose pattern match. */
export type FieldSource = 'MRZ' | 'TEXT' | 'HEURISTIC';
export interface ExtractedField {
  key: OcrFieldKey;
  value: string;
  /** 0..1 */
  confidence: number;
  source: FieldSource;
}
export interface ExtractionIssue {
  code: string;
  field?: OcrFieldKey;
  message: string;
}
export interface Extraction {
  classification: DocumentClass;
  classificationConfidence: number;
  fields: ExtractedField[];
  issues: ExtractionIssue[];
  /** The profile whose rules were used to extract (detected class, else the hint). */
  profile: DocumentClass;
}

const round = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 1000) / 1000;

// ---------------------------------------------------------------------------- dates

export interface FoundDate {
  /** YYYY-MM-DD */
  iso: string;
  raw: string;
  index: number;
  /** dd/mm vs mm/dd could not be told apart (both parts are 12 or less). Read as dd/mm, the UAE convention. */
  ambiguous: boolean;
}
const MONTHS: Record<string, number> = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const validDate = (y: number, m: number, d: number) => y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
const isoOf = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** Recognises yyyy-mm-dd, dd/mm/yyyy (also with - or .) and dd MMM yyyy. Impossible dates are ignored. */
export function findDates(text: string): FoundDate[] {
  const found: FoundDate[] = [];
  const taken: Array<[number, number]> = [];
  const add = (m: RegExpMatchArray, y: number, mo: number, d: number, ambiguous = false) => {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (!validDate(y, mo, d) || taken.some(([s, e]) => start < e && end > s)) return;
    taken.push([start, end]);
    found.push({ iso: isoOf(y, mo, d), raw: m[0], index: start, ambiguous });
  };
  for (const m of text.matchAll(/(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g)) add(m, Number(m[1]), Number(m[2]), Number(m[3]));
  for (const m of text.matchAll(/(?<!\d)(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?!\d)/g)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    // Day first, as written in the UAE. Only when that is impossible is it read as month first.
    if (b > 12 && a <= 12) add(m, Number(m[3]), a, b);
    else add(m, Number(m[3]), b, a, a <= 12 && b <= 12 && a !== b);
  }
  for (const m of text.matchAll(/(?<!\d)(\d{1,2})[\s.-]*([A-Za-z]{3,9})\.?,?[\s.-]*(\d{4})(?!\d)/g)) {
    const month = MONTHS[m[2].slice(0, 3).toUpperCase()];
    if (month) add(m, Number(m[3]), month, Number(m[1]));
  }
  return found.sort((x, y) => x.index - y.index);
}

// ---------------------------------------------------------------------------- Emirates ID number

/** Luhn (mod 10) check, as used for the last digit of the Emirates ID number. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}
export const formatEmiratesId = (digits: string) => `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7, 14)}-${digits.slice(14)}`;

export interface FoundEmiratesId {
  /** 15 digits, no separators. */
  digits: string;
  formatted: string;
  luhnValid: boolean;
  /** Look-alike letters had to be read as digits (O as 0, I as 1 ...). */
  repaired: boolean;
}
const EID_DIGIT = '[0-9OQDILSBZG]';
const EID_RE = new RegExp(`(?<![0-9A-Za-z])7[8B][4A][\\s-]{0,2}${EID_DIGIT}{4}[\\s-]{0,2}${EID_DIGIT}{7}[\\s-]{0,2}${EID_DIGIT}(?![0-9])`, 'g');
const EID_TO_DIGIT: Record<string, string> = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', S: '5', B: '8', G: '6', A: '4' };

/** Finds 784-YYYY-NNNNNNN-C numbers in free text (separators optional). A number failing the Luhn check is still returned, flagged. */
export function findEmiratesIds(text: string): FoundEmiratesId[] {
  const out = new Map<string, FoundEmiratesId>();
  for (const m of text.toUpperCase().matchAll(EID_RE)) {
    const compact = m[0].replace(/[\s-]/g, '');
    const digits = compact.replace(/[A-Z]/g, (c) => EID_TO_DIGIT[c] ?? c);
    if (!/^784\d{12}$/.test(digits)) continue;
    const item = { digits, formatted: formatEmiratesId(digits), luhnValid: luhnValid(digits), repaired: digits !== compact };
    const existing = out.get(digits);
    if (!existing || (existing.repaired && !item.repaired)) out.set(digits, item);
  }
  // Valid numbers first.
  return [...out.values()].sort((a, b) => Number(b.luhnValid) - Number(a.luhnValid));
}

// ---------------------------------------------------------------------------- labelled text

const linesOf = (text: string) => text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim());
/**
 * The text that follows a label: the rest of the line, or the next non-empty
 * line when the label stands alone. Labels on UAE documents are bilingual, so
 * Arabic text and separators around the value are dropped.
 */
export function valueAfterLabel(text: string, label: RegExp): string | null {
  const lines = linesOf(text);
  for (let i = 0; i < lines.length; i++) {
    const m = label.exec(lines[i]);
    if (!m) continue;
    const clean = (s: string) => s.replace(/[؀-ۿݐ-ݿ]+/g, ' ').replace(/^[\s:.\-–|/]+/, '').replace(/\s+/g, ' ').trim();
    const rest = clean(lines[i].slice(m.index + m[0].length));
    if (rest) return rest;
    for (let j = i + 1; j < Math.min(lines.length, i + 3); j++) {
      const next = clean(lines[j]);
      if (next) return next;
    }
  }
  return null;
}
function dateAfterLabel(text: string, label: RegExp): FoundDate | null {
  const value = valueAfterLabel(text, label);
  return value ? (findDates(value)[0] ?? null) : null;
}

// ---------------------------------------------------------------------------- classification

const count = (text: string, patterns: RegExp[]) => patterns.filter((p) => p.test(text)).length;
const PASSPORT_WORDS = [/\bPASSPORT\b/i, /\bPASSEPORT\b/i, /جواز/, /\bTYPE\b.{0,12}\bP\b/i, /\bPLACE OF BIRTH\b/i];
const EID_WORDS = [/UNITED ARAB EMIRATES/i, /\bIDENTITY CARD\b/i, /\bEMIRATES ID\b/i, /\bID NUMBER\b/i, /الإمارات|الامارات/, /بطاقة الهوية|بطاقة هوية/, /FEDERAL AUTHORITY FOR IDENTITY/i];
const LICENCE_WORDS = [/\b(TRADE|COMMERCIAL|PROFESSIONAL|INDUSTRIAL)\s+LICEN[CS]E\b/i, /\bLICEN[CS]E\s*(NO|NUMBER|#)/i, /DEPARTMENT OF ECONOM/i, /\bTRADE NAME\b/i, /\bLEGAL (TYPE|FORM)\b/i, /رخصة/, /\bACTIVIT(Y|IES)\b/i, /\bFREE ZONE\b/i];

/** What kind of document is this text from? UNKNOWN when the evidence is weak: a wrong label is worse than none. */
export function classifyDocument(text: string, mrz: MrzResult | null = findMrz(text)): { classification: DocumentClass; confidence: number } {
  if (mrz?.format === 'TD3' && mrz.documentCode.startsWith('P')) return { classification: 'PASSPORT', confidence: round(mrz.valid ? 0.99 : 0.6 + 0.07 * mrz.checksPassed) };
  if (mrz?.format === 'TD1' && mrz.fields.issuingState.value === 'ARE' && /^I/.test(mrz.documentCode)) {
    return { classification: 'EMIRATES_ID', confidence: round(mrz.valid ? 0.98 : 0.6 + 0.07 * mrz.checksPassed) };
  }
  const ids = findEmiratesIds(text);
  const eidWords = count(text, EID_WORDS);
  const passportWords = count(text, PASSPORT_WORDS);
  const licenceWords = count(text, LICENCE_WORDS);
  const scores: Array<[DocumentClass, number]> = [
    ['EMIRATES_ID', ids.some((i) => i.luhnValid) ? Math.min(0.9, 0.7 + 0.1 * eidWords) : ids.length ? Math.min(0.6, 0.4 + 0.1 * eidWords) : eidWords >= 2 ? 0.45 : 0],
    // A single keyword proves nothing (many documents mention a passport or a licence).
    ['PASSPORT', passportWords >= 2 ? 0.6 : 0],
    ['TRADE_LICENCE', licenceWords >= 3 ? 0.75 : licenceWords === 2 ? 0.6 : 0],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  const [top, second] = scores;
  // Too weak, or two classes equally likely: do not pretend to know.
  if (top[1] < 0.4 || top[1] - second[1] < 0.1) return { classification: 'UNKNOWN', confidence: 0 };
  return { classification: top[0], confidence: round(top[1]) };
}

// ---------------------------------------------------------------------------- field extraction

const push = (fields: ExtractedField[], key: OcrFieldKey, value: string | null | undefined, confidence: number, source: FieldSource) => {
  if (!value) return;
  const existing = fields.find((f) => f.key === key);
  // One value per key: the stronger evidence wins (MRZ beats printed text).
  if (existing) {
    if (existing.confidence >= confidence) return;
    fields.splice(fields.indexOf(existing), 1);
  }
  fields.push({ key, value, confidence: round(confidence), source });
};
const fromMrz = (fields: ExtractedField[], key: OcrFieldKey, f: MrzField) => push(fields, key, f.value, f.confidence, 'MRZ');
const mrzIssues = (mrz: MrzResult, map: Partial<Record<string, OcrFieldKey>>): ExtractionIssue[] =>
  mrz.issues.map((i: MrzIssue) => ({ code: i.code, field: i.field ? map[i.field] : undefined, message: i.message }));

function mrzNames(fields: ExtractedField[], mrz: MrzResult) {
  fromMrz(fields, 'surname', mrz.fields.surname);
  fromMrz(fields, 'givenNames', mrz.fields.givenNames);
  const parts = [mrz.fields.givenNames.value, mrz.fields.surname.value].filter(Boolean);
  const confidences = [mrz.fields.givenNames, mrz.fields.surname].filter((f) => f.value).map((f) => f.confidence);
  if (parts.length) push(fields, 'fullName', parts.join(' '), Math.min(...confidences), 'MRZ');
}

function extractPassport(text: string, mrz: MrzResult | null, fields: ExtractedField[], issues: ExtractionIssue[]) {
  if (mrz?.format !== 'TD3') return;
  fromMrz(fields, 'passportNumber', mrz.fields.documentNumber);
  fromMrz(fields, 'issuingState', mrz.fields.issuingState);
  fromMrz(fields, 'nationality', mrz.fields.nationality);
  fromMrz(fields, 'dateOfBirth', mrz.fields.dateOfBirth);
  fromMrz(fields, 'sex', mrz.fields.sex);
  fromMrz(fields, 'expiryDate', mrz.fields.expiryDate);
  fromMrz(fields, 'personalNumber', mrz.fields.optionalData);
  mrzNames(fields, mrz);
  issues.push(...mrzIssues(mrz, { documentNumber: 'passportNumber', optionalData: 'personalNumber', dateOfBirth: 'dateOfBirth', expiryDate: 'expiryDate', nationality: 'nationality', issuingState: 'issuingState', surname: 'surname', givenNames: 'givenNames', sex: 'sex' }));
  // The date of issue is not in the MRZ; take it from the printed page when it is labelled.
  const issued = dateAfterLabel(text, /date of issue|issue date|issuing date/i);
  if (issued) push(fields, 'issueDate', issued.iso, issued.ambiguous ? 0.45 : 0.6, 'TEXT');
}

function extractEmiratesId(text: string, mrz: MrzResult | null, fields: ExtractedField[], issues: ExtractionIssue[]) {
  if (mrz?.format === 'TD1') {
    // Back of the card.
    fromMrz(fields, 'cardNumber', mrz.fields.documentNumber);
    fromMrz(fields, 'issuingState', mrz.fields.issuingState);
    fromMrz(fields, 'nationality', mrz.fields.nationality);
    fromMrz(fields, 'dateOfBirth', mrz.fields.dateOfBirth);
    fromMrz(fields, 'sex', mrz.fields.sex);
    fromMrz(fields, 'expiryDate', mrz.fields.expiryDate);
    mrzNames(fields, mrz);
    issues.push(...mrzIssues(mrz, { documentNumber: 'cardNumber', optionalData: 'emiratesIdNumber', dateOfBirth: 'dateOfBirth', expiryDate: 'expiryDate', nationality: 'nationality', issuingState: 'issuingState', surname: 'surname', givenNames: 'givenNames', sex: 'sex' }));
    const optional = mrz.fields.optionalData;
    if (optional.value && /^784\d{12}$/.test(optional.value)) {
      const ok = luhnValid(optional.value);
      // Two independent checks: the MRZ composite digit and the number's own Luhn digit.
      push(fields, 'emiratesIdNumber', formatEmiratesId(optional.value), ok ? optional.confidence : Math.min(optional.confidence, 0.3), 'MRZ');
      if (!ok) issues.push({ code: 'EMIRATES_ID_CHECK_FAILED', field: 'emiratesIdNumber', message: 'The Emirates ID number does not pass its check digit. It was probably misread.' });
    }
  }
  // Front of the card (or any text that prints the number).
  const [id] = findEmiratesIds(text);
  if (id) {
    push(fields, 'emiratesIdNumber', id.formatted, id.luhnValid ? (id.repaired ? 0.8 : 0.9) : 0.3, 'TEXT');
    if (!id.luhnValid && !fields.some((f) => f.key === 'emiratesIdNumber' && f.source === 'MRZ' && f.confidence > 0.3)) {
      if (!issues.some((i) => i.code === 'EMIRATES_ID_CHECK_FAILED')) issues.push({ code: 'EMIRATES_ID_CHECK_FAILED', field: 'emiratesIdNumber', message: 'The Emirates ID number does not pass its check digit. It was probably misread.' });
    }
  }
  const name = valueAfterLabel(text, /\bname\b/i);
  if (name && /^[A-Za-z][A-Za-z .'-]{2,80}$/.test(name)) push(fields, 'fullName', name.toUpperCase().replace(/\s+/g, ' '), 0.6, 'TEXT');
  const nationality = valueAfterLabel(text, /\bnationality\b/i);
  if (nationality) {
    const code = countryNameToAlpha3(nationality);
    if (code) push(fields, 'nationality', code, 0.6, 'TEXT');
  }
  for (const [key, label] of [
    ['dateOfBirth', /date of birth|birth date|\bDOB\b/i],
    ['expiryDate', /expiry date|date of expiry|expiry|expires/i],
    ['issueDate', /issuing date|issue date|date of issue/i],
  ] as Array<[OcrFieldKey, RegExp]>) {
    const d = dateAfterLabel(text, label);
    if (d) push(fields, key, d.iso, d.ambiguous ? 0.45 : 0.6, 'TEXT');
  }
  const sex = valueAfterLabel(text, /\b(sex|gender)\b/i);
  if (sex && /^(M|F|MALE|FEMALE)\b/i.test(sex)) push(fields, 'sex', sex[0].toUpperCase(), 0.6, 'TEXT');
}

/** Trade licences have no standard layout across the emirates and free zones: label matching only, with deliberately low confidence. */
function extractTradeLicence(text: string, fields: ExtractedField[]) {
  const number = valueAfterLabel(text, /\b(?:(?:trade|commercial|professional|industrial)\s+)?licen[cs]e\s*(?:no|number|num|#)\b\.?/i) ?? valueAfterLabel(text, /\bregistration\s*(?:no|number)\b\.?/i);
  const token = number ? /[A-Z0-9][A-Z0-9/-]{2,24}/i.exec(number)?.[0] : null;
  if (token && /\d/.test(token)) push(fields, 'licenceNumber', token.toUpperCase(), 0.5, 'HEURISTIC');
  const expiry = dateAfterLabel(text, /expiry date|date of expiry|expires on|expiry|valid (?:until|till|up ?to)/i);
  if (expiry) push(fields, 'expiryDate', expiry.iso, expiry.ambiguous ? 0.35 : 0.5, 'HEURISTIC');
  const issued = dateAfterLabel(text, /issue date|date of issue|issued on|issuance date/i);
  if (issued) push(fields, 'issueDate', issued.iso, issued.ambiguous ? 0.35 : 0.5, 'HEURISTIC');
  const name = valueAfterLabel(text, /\b(?:trade name|company name|business name|commercial name|licensee)\b/i);
  if (name && name.length >= 3 && name.length <= 160 && /[A-Za-z]{2}/.test(name)) push(fields, 'companyName', name, 0.4, 'HEURISTIC');
}

/** Fields a reviewer expects for each kind of document. Missing ones are reported, never filled in. */
export const EXPECTED_FIELDS: Record<Exclude<DocumentClass, 'UNKNOWN'>, OcrFieldKey[]> = {
  PASSPORT: ['passportNumber', 'fullName', 'nationality', 'dateOfBirth', 'expiryDate'],
  EMIRATES_ID: ['emiratesIdNumber', 'expiryDate'],
  TRADE_LICENCE: ['licenceNumber', 'companyName', 'expiryDate'],
};

/**
 * The whole pure pipeline: classify, then extract with the rules of that class.
 * `hint` is the OCR profile of the document type chosen at upload; it is used
 * when the text itself does not reveal the class.
 */
export function extractDocument(text: string, options: { hint?: DocumentClass | null; today?: Date; ocrConfidence?: number } = {}): Extraction {
  const today = options.today ?? new Date();
  const mrz = findMrz(text, today);
  const { classification, confidence } = classifyDocument(text, mrz);
  const hint = options.hint && options.hint !== 'UNKNOWN' ? options.hint : null;
  const profile = classification !== 'UNKNOWN' ? classification : (hint ?? 'UNKNOWN');
  const fields: ExtractedField[] = [];
  const issues: ExtractionIssue[] = [];

  if (profile === 'PASSPORT') extractPassport(text, mrz, fields, issues);
  else if (profile === 'EMIRATES_ID') extractEmiratesId(text, mrz, fields, issues);
  else if (profile === 'TRADE_LICENCE') extractTradeLicence(text, fields);
  else if (mrz) {
    // A machine readable zone of a document we have no profile for (e.g. a foreign identity card):
    // its check-digit protected values are still worth showing to the reviewer.
    fromMrz(fields, 'cardNumber', mrz.fields.documentNumber);
    fromMrz(fields, 'issuingState', mrz.fields.issuingState);
    fromMrz(fields, 'nationality', mrz.fields.nationality);
    fromMrz(fields, 'dateOfBirth', mrz.fields.dateOfBirth);
    fromMrz(fields, 'sex', mrz.fields.sex);
    fromMrz(fields, 'expiryDate', mrz.fields.expiryDate);
    mrzNames(fields, mrz);
    issues.push(...mrzIssues(mrz, { documentNumber: 'cardNumber', dateOfBirth: 'dateOfBirth', expiryDate: 'expiryDate' }));
  }

  // Values that are not protected by a check digit can only be as good as the recognition itself.
  const ocr = options.ocrConfidence;
  if (typeof ocr === 'number' && ocr >= 0 && ocr < 1) {
    for (const f of fields) if (f.source !== 'MRZ') f.confidence = round(f.confidence * Math.max(0.5, ocr));
  }
  if (hint && classification !== 'UNKNOWN' && hint !== classification) {
    issues.push({ code: 'CLASSIFICATION_MISMATCH', message: `This was uploaded as ${label(hint)} but looks like ${label(classification)}.` });
  }
  if (profile !== 'UNKNOWN') {
    for (const key of EXPECTED_FIELDS[profile]) {
      if (!fields.some((f) => f.key === key)) issues.push({ code: 'MISSING_FIELD', field: key, message: `${FIELD_LABELS[key]} could not be read from the document.` });
    }
  }
  const order = (k: OcrFieldKey) => FIELD_ORDER.indexOf(k);
  fields.sort((a, b) => order(a.key) - order(b.key));
  return { classification, classificationConfidence: confidence, fields, issues, profile };
}

const label = (c: DocumentClass) => ({ PASSPORT: 'a passport', EMIRATES_ID: 'an Emirates ID', TRADE_LICENCE: 'a trade licence', UNKNOWN: 'an unknown document' })[c];
export const FIELD_LABELS: Record<OcrFieldKey, string> = {
  passportNumber: 'Passport number', cardNumber: 'Card number', emiratesIdNumber: 'Emirates ID number', surname: 'Surname', givenNames: 'Given names', fullName: 'Full name',
  nationality: 'Nationality', issuingState: 'Issuing country', dateOfBirth: 'Date of birth', sex: 'Sex', expiryDate: 'Expiry date', issueDate: 'Issue date',
  personalNumber: 'Personal number', licenceNumber: 'Licence number', companyName: 'Company name',
};
const FIELD_ORDER: OcrFieldKey[] = ['passportNumber', 'emiratesIdNumber', 'cardNumber', 'licenceNumber', 'companyName', 'fullName', 'surname', 'givenNames', 'nationality', 'issuingState', 'dateOfBirth', 'sex', 'issueDate', 'expiryDate', 'personalNumber'];
