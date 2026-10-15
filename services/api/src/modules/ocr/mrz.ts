import { isKnownMrzCountry } from './countries';

/**
 * ICAO Doc 9303 machine readable zone (MRZ) parser.
 *
 *   TD3  passports           2 lines x 44 characters
 *   TD1  identity cards      3 lines x 30 characters (the back of the Emirates ID is a TD1)
 *
 * The parser is written for OCR output, which is rarely perfect:
 *   - `<` fillers read as `«`, `‹`, or `K`; spaces inserted between characters;
 *   - O/0, I/1, B/8, S/5, Z/2, G/6 confused.
 * Positions that can only hold digits (dates, check digits) or only letters
 * (names, country codes) are normalised directly. In alphanumeric fields
 * (document number, personal number) a character is repaired ONLY when
 *   - the field fails its check digit as read,
 *   - the character looks out of place (a letter next to digits, or a digit
 *     surrounded by letters) and has a classic look-alike (O/0, I/1, B/8, S/5,
 *     Z/2, G/6), and
 *   - exactly one such substitution makes the check digit valid.
 * Otherwise the value is returned as read and flagged. A value is never
 * invented: every field carries a confidence that drops sharply when its check
 * digit does not validate, and a repaired field is marked and scored lower.
 *
 * Limit of the check digit (inherent to ICAO 9303, not to this code): it works
 * modulo 10 on character values, so it cannot see a confusion between two
 * characters whose values differ by a multiple of ten: 1/L, 6/G, 8/S, 0/K and
 * so on. "L898902C3" and "1898902C3" have the same check digit. A valid check
 * digit is strong evidence, not proof, which is one more reason why a person
 * must compare every value with the document.
 *
 * Pure functions, no I/O.
 */

export type MrzFormat = 'TD3' | 'TD1';
export type MrzFieldKey = 'documentNumber' | 'issuingState' | 'nationality' | 'surname' | 'givenNames' | 'dateOfBirth' | 'sex' | 'expiryDate' | 'optionalData' | 'optionalData2';

export interface MrzCheck {
  /** Check digit computed from the field as returned. */
  expected: string;
  /** Check digit printed in the MRZ (as recognised). */
  found: string;
  valid: boolean;
}
export interface MrzField {
  /** Parsed value: dates as YYYY-MM-DD, fillers removed. null = not present or unreadable. */
  value: string | null;
  /** The characters of the field as used for the check digit (after any repair). */
  raw: string;
  /** 0..1 */
  confidence: number;
  check?: MrzCheck;
  /** True when characters were changed to repair an OCR confusion. */
  corrected: boolean;
}
export type MrzIssueCode =
  | 'CHECK_DIGIT_MISMATCH' | 'COMPOSITE_CHECK_MISMATCH' | 'INVALID_DATE' | 'UNKNOWN_COUNTRY_CODE' | 'NAME_POSSIBLY_TRUNCATED' | 'NAME_UNCERTAIN'
  | 'LINE_LENGTH_REPAIRED' | 'CHARACTER_REPAIRED' | 'FILLER_REPAIRED' | 'TRAILING_K_AMBIGUOUS' | 'STRAY_CHARACTERS' | 'INVALID_SEX';
export interface MrzIssue {
  code: MrzIssueCode;
  field?: MrzFieldKey;
  message: string;
}
export interface MrzResult {
  format: MrzFormat;
  /** Document code, e.g. "P", "PM", "I", "ID", "IL". */
  documentCode: string;
  fields: Record<MrzFieldKey, MrzField>;
  compositeCheck: MrzCheck;
  /** Every check digit that is present validates (including the composite). */
  valid: boolean;
  /** How many of the check digits validate, e.g. 5 of 5. */
  checksPassed: number;
  checksTotal: number;
  issues: MrzIssue[];
  /** The MRZ lines as interpreted (after normalisation and repair). Never persist these. */
  lines: string[];
}

const C = { CHECKED: 0.99, CHECKED_REPAIRED: 0.8, TRAILING_K: 0.7, CHECK_FAILED: 0.3, CODE_KNOWN: 0.92, CODE_UNKNOWN: 0.5, NAME: 0.9, NAME_TRUNCATED: 0.75, NAME_UNCERTAIN: 0.4, SEX: 0.9, UNCHECKED_TEXT: 0.8 };
/** Fields not covered by any check digit lose confidence when the composite check fails. */
const COMPOSITE_FAILED_FACTOR = 0.8;

// ---------------------------------------------------------------------------- check digits

/** Character value per ICAO 9303: 0-9 as is, A-Z = 10-35, filler = 0. */
export function mrzCharValue(char: string): number {
  if (char >= '0' && char <= '9') return char.charCodeAt(0) - 48;
  if (char >= 'A' && char <= 'Z') return char.charCodeAt(0) - 55;
  return 0;
}
/** Check digit: weights 7, 3, 1 repeating, modulo 10. */
export function mrzCheckDigit(input: string): string {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < input.length; i++) sum += mrzCharValue(input[i]) * weights[i % 3];
  return String(sum % 10);
}

// ---------------------------------------------------------------------------- character normalisation

const TO_DIGIT: Record<string, string> = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', S: '5', B: '8', G: '6' };
const TO_ALPHA: Record<string, string> = { '0': 'O', '1': 'I', '2': 'Z', '5': 'S', '8': 'B', '6': 'G' };
/** Classic look-alike pairs tried when an alphanumeric field fails its check digit. */
const ALNUM_TO_DIGIT: Record<string, string> = { O: '0', I: '1', B: '8', S: '5', Z: '2', G: '6' };
const ALNUM_TO_LETTER: Record<string, string> = { '0': 'O', '1': 'I', '8': 'B', '5': 'S', '2': 'Z', '6': 'G' };
const digitsOnly = (s: string) => s.replace(/[A-Z]/g, (c) => TO_DIGIT[c] ?? c);
const alphaOnly = (s: string) => s.replace(/[0-9]/g, (c) => TO_ALPHA[c] ?? c);

/** Upper-cases, drops whitespace, maps look-alike characters to `<` and removes everything that cannot be in an MRZ. */
export function normaliseMrzLine(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[«»]/g, '<<')
    .replace(/[‹›〈〉《》＜≤]/g, '<')
    .replace(/\s+/g, '')
    .replace(/[^A-Z0-9<]/g, '');
}
/** Share of a raw text line that consists of MRZ characters: separates the MRZ from ordinary printed text. */
function mrzLikeness(raw: string): number {
  const compact = raw.replace(/\s+/g, '');
  if (!compact.length) return 0;
  return (compact.match(/[A-Z0-9<«»‹›]/g) ?? []).length / compact.length;
}

/**
 * OCR often reads the `<` filler as a letter: K most of all, and (seen with
 * Tesseract on machine-readable fonts) also L and C. Inside the trailing run
 * of filler look-alikes, everything from the first "<<" or the first three
 * look-alike letters in a row is filler. A single letter right after one `<`
 * is kept: it may be a real initial.
 *
 * `lookalikes` lists the letters to treat this way. K is special: its value 20
 * makes it invisible to check digits (see checkAlnum), L and C are not.
 */
export function repairTrailingFillers(field: string, lookalikes = 'K'): string {
  const tail = new RegExp(`[${lookalikes}<]+$`).exec(field);
  if (!tail) return field;
  const marks = [tail[0].indexOf('<<'), tail[0].search(new RegExp(`[${lookalikes}]{3}`))].filter((i) => i >= 0);
  if (!marks.length) return field;
  const from = tail.index + Math.min(...marks);
  return field.slice(0, from) + '<'.repeat(field.length - from);
}
/** Filler look-alikes in fields without a check digit of their own (names, optional data). */
const FILLER_LOOKALIKES = 'KLC';
const isFillerOnly = (s: string) => /^[<KLC]*$/.test(s) && (s.includes('<') || s.length >= 3 || s.length === 0);

// ---------------------------------------------------------------------------- dates

function validYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}
const iso = (y: number, m: number, d: number) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * YYMMDD -> YYYY-MM-DD. The MRZ has two-digit years: a date of birth is never
 * in the future; an expiry date is taken as 20YY unless that is more than 50
 * years ahead.
 */
export function expandMrzDate(yymmdd: string, kind: 'birth' | 'expiry', today: Date): string | null {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = Number(yymmdd.slice(0, 2));
  const mm = Number(yymmdd.slice(2, 4));
  const dd = Number(yymmdd.slice(4, 6));
  let year = 2000 + yy;
  if (kind === 'birth') {
    if (!validYmd(year, mm, dd) || Date.UTC(year, mm - 1, dd) > today.getTime()) year -= 100;
  } else if (year > today.getUTCFullYear() + 50) {
    year -= 100;
  }
  return validYmd(year, mm, dd) ? iso(year, mm, dd) : null;
}

// ---------------------------------------------------------------------------- field helpers

interface Checked {
  raw: string;
  found: string;
  valid: boolean;
  /** A look-alike character was replaced (proven by the check digit). */
  corrected: boolean;
  /** More than one repair was possible: the value was left as read. */
  ambiguous: boolean;
  /** A trailing run of K was taken as filler (plausible, but the check digit cannot confirm it). */
  fillerRepaired?: boolean;
  /** The field ends in one or two K that might be fillers. Left as read. */
  trailingK?: boolean;
}

const charClass = (c: string | undefined) => (c === undefined ? null : c >= '0' && c <= '9' ? 'digit' : c >= 'A' && c <= 'Z' ? 'letter' : null);

/**
 * Validates an alphanumeric field against its check digit.
 *
 * Fillers read as K: the letter K has the value 20, and 20 x (7 | 3 | 1) is a
 * multiple of 10, so the check digit can NEVER tell a K from a filler. A
 * trailing run of three or more K (or K after "<<") is therefore treated as
 * filler by plausibility alone and marked; one or two trailing K are left as
 * read and flagged for the reviewer.
 *
 * Look-alike characters: when the check digit fails, out-of-place characters
 * are tried one at a time: a letter that touches a digit may be a misread
 * digit, a digit whose neighbours are all letters may be a misread letter. A
 * repair is accepted only if it is the single one that satisfies the check
 * digit. (The composite check digit cannot arbitrate: in TD1 and TD3 these
 * fields sit at a weight-aligned offset of the composite, so it changes
 * exactly as the field's own check digit does.)
 */
function checkAlnum(asRead: string, checkChar: string): Checked {
  const found = digitsOnly(checkChar);
  const ok = (candidate: string) => mrzCheckDigit(candidate) === found;
  const raw = repairTrailingFillers(asRead);
  const flags = { fillerRepaired: raw !== asRead, trailingK: /[^K<]K{1,2}$/.test(raw) };
  if (ok(raw)) return { raw, found, valid: true, corrected: false, ambiguous: false, ...flags };

  // Fillers read as L or C do change the check digit, so this repair is confirmed by it.
  const fillers = repairTrailingFillers(raw, FILLER_LOOKALIKES);
  if (fillers !== raw && ok(fillers)) return { raw: fillers, found, valid: true, corrected: false, ambiguous: false, fillerRepaired: true, trailingK: false };

  const candidates: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const neighbours = [charClass(raw[i - 1]), charClass(raw[i + 1])].filter(Boolean);
    const self = charClass(raw[i]);
    let alt: string | undefined;
    if (self === 'letter' && neighbours.includes('digit')) alt = ALNUM_TO_DIGIT[raw[i]];
    else if (self === 'digit' && neighbours.length > 0 && neighbours.every((n) => n === 'letter')) alt = ALNUM_TO_LETTER[raw[i]];
    if (!alt) continue;
    const candidate = raw.slice(0, i) + alt + raw.slice(i + 1);
    if (ok(candidate)) candidates.push(candidate);
  }
  if (candidates.length === 1) return { raw: candidates[0], found, valid: true, corrected: true, ambiguous: false, ...flags };
  return { raw, found, valid: false, corrected: false, ambiguous: candidates.length > 1, ...flags };
}

const strip = (s: string) => s.replace(/<+$/g, '').replace(/</g, ' ').trim();

function parseNames(field: string, issues: MrzIssue[]): { surname: MrzField; givenNames: MrzField } {
  const asRead = alphaOnly(field);
  let text = repairTrailingFillers(asRead, FILLER_LOOKALIKES);
  let confidence = C.NAME;
  const hadFiller = asRead.includes('<');
  if (text !== asRead && !hadFiller) {
    // Not a single filler was recognised as such: a real letter at the end of the name cannot be told apart from the run.
    confidence = C.NAME_UNCERTAIN;
    issues.push({ code: 'NAME_UNCERTAIN', field: 'surname', message: 'Filler characters in the name were read as letters. Check the name against the document.' });
  } else if (text !== asRead) {
    confidence = C.CHECKED_REPAIRED;
    issues.push({ code: 'FILLER_REPAIRED', field: 'givenNames', message: 'Letters after the name were taken as filler characters. Check the name against the document.' });
  }
  const body = text.replace(/<+$/, '');
  if (!hadFiller && !body.includes('<') && body.includes('KK')) {
    // Every filler was read as "K": the first "KK" is taken as the surname / given-name separator.
    text = text.replace('KK', '<<');
  }
  if (!text.endsWith('<') && text.length >= 20) {
    confidence = Math.min(confidence, C.NAME_TRUNCATED);
    issues.push({ code: 'NAME_POSSIBLY_TRUNCATED', field: 'givenNames', message: 'The name fills the whole machine readable zone and may be cut short.' });
  }
  const [primary, ...rest] = text.split('<<');
  const surname = strip(primary ?? '');
  const given = strip(rest.join('<<').replace(/<{2,}/g, '<'));
  if (/[^A-Z ]/.test(surname + given)) confidence = Math.min(confidence, C.NAME_UNCERTAIN);
  if (/(^| )[KLC]$/.test(given || surname) && !issues.some((i) => i.code === 'NAME_UNCERTAIN')) {
    // "MARIA<K<<<<": a real initial, or the second filler read as a letter? Kept as read, but flagged.
    confidence = Math.min(confidence, 0.6);
    issues.push({ code: 'NAME_UNCERTAIN', field: 'givenNames', message: 'The name ends in a single letter that may be a misread filler character. Check the name against the document.' });
  }
  return {
    surname: { value: surname || null, raw: primary ?? '', confidence: surname ? confidence : 0, corrected: text !== asRead },
    givenNames: { value: given || null, raw: rest.join('<<'), confidence: given ? confidence : 0, corrected: text !== asRead },
  };
}

function countryField(raw: string, key: 'issuingState' | 'nationality', issues: MrzIssue[]): MrzField {
  const code = alphaOnly(raw).replace(/</g, '');
  if (!code) return { value: null, raw, confidence: 0, corrected: false };
  if (isKnownMrzCountry(code)) return { value: code, raw, confidence: C.CODE_KNOWN, corrected: false };
  issues.push({ code: 'UNKNOWN_COUNTRY_CODE', field: key, message: `"${code}" is not a known country code. Check it against the document.` });
  return { value: code, raw, confidence: C.CODE_UNKNOWN, corrected: false };
}

function sexField(raw: string, issues: MrzIssue[]): MrzField {
  const c = alphaOnly(raw);
  if (c === 'M' || c === 'F') return { value: c, raw, confidence: C.SEX, corrected: false };
  if (c === '<' || c === 'X') return { value: 'X', raw, confidence: C.SEX, corrected: false };
  issues.push({ code: 'INVALID_SEX', field: 'sex', message: 'The sex field could not be read.' });
  return { value: null, raw, confidence: 0, corrected: false };
}

function dateField(raw: string, checkChar: string, kind: 'birth' | 'expiry', key: 'dateOfBirth' | 'expiryDate', today: Date, issues: MrzIssue[]): MrzField {
  const digits = digitsOnly(raw);
  const found = digitsOnly(checkChar);
  const expected = mrzCheckDigit(digits);
  const valid = expected === found;
  const value = expandMrzDate(digits, kind, today);
  if (!valid) issues.push({ code: 'CHECK_DIGIT_MISMATCH', field: key, message: `The check digit of the ${kind === 'birth' ? 'date of birth' : 'expiry date'} does not match.` });
  if (!value && !/^<+$/.test(raw)) issues.push({ code: 'INVALID_DATE', field: key, message: `The ${kind === 'birth' ? 'date of birth' : 'expiry date'} is not a valid date.` });
  return { value, raw: digits, confidence: !value ? 0 : valid ? (digits === raw ? C.CHECKED : C.CHECKED - 0.02) : C.CHECK_FAILED, check: { expected, found, valid }, corrected: digits !== raw };
}

function checkedTextField(checked: Checked, key: MrzFieldKey, label: string, issues: MrzIssue[]): MrzField {
  const value = checked.raw.replace(/</g, '') || null;
  let confidence = !value ? 0 : !checked.valid ? C.CHECK_FAILED : checked.corrected || checked.fillerRepaired ? C.CHECKED_REPAIRED : C.CHECKED;
  if (!checked.valid) {
    issues.push({
      code: 'CHECK_DIGIT_MISMATCH',
      field: key,
      message: checked.ambiguous ? `The check digit of the ${label} does not match and more than one correction is possible.` : `The check digit of the ${label} does not match.`,
    });
  } else if (checked.corrected) {
    issues.push({ code: 'CHARACTER_REPAIRED', field: key, message: `A look-alike character in the ${label} was corrected using its check digit.` });
  }
  if (checked.fillerRepaired && value) {
    issues.push({ code: 'FILLER_REPAIRED', field: key, message: `Letters K at the end of the ${label} were taken as filler characters. Check it against the document.` });
  }
  if (checked.trailingK && value) {
    confidence = Math.min(confidence, C.TRAILING_K);
    issues.push({ code: 'TRAILING_K_AMBIGUOUS', field: key, message: `The ${label} ends in the letter K, which cannot be told apart from a filler character. Check it against the document.` });
  }
  return {
    value,
    raw: checked.raw,
    confidence,
    check: { expected: mrzCheckDigit(checked.raw), found: checked.found, valid: checked.valid },
    corrected: checked.corrected || !!checked.fillerRepaired,
  };
}

function finish(format: MrzFormat, documentCode: string, fields: Record<MrzFieldKey, MrzField>, composite: MrzCheck, issues: MrzIssue[], lines: string[]): MrzResult {
  if (!composite.valid) {
    issues.push({ code: 'COMPOSITE_CHECK_MISMATCH', message: 'The overall check digit of the machine readable zone does not match.' });
    for (const key of ['issuingState', 'nationality', 'surname', 'givenNames', 'sex'] as MrzFieldKey[]) fields[key].confidence = round(fields[key].confidence * COMPOSITE_FAILED_FACTOR);
  }
  const checks = [composite, ...Object.values(fields).map((f) => f.check).filter((c): c is MrzCheck => !!c)];
  for (const f of Object.values(fields)) f.confidence = round(f.confidence);
  return { format, documentCode, fields, compositeCheck: composite, valid: checks.every((c) => c.valid), checksPassed: checks.filter((c) => c.valid).length, checksTotal: checks.length, issues, lines };
}
const round = (n: number) => Math.round(n * 1000) / 1000;
const empty = (): MrzField => ({ value: null, raw: '', confidence: 0, corrected: false });

// ---------------------------------------------------------------------------- TD3 (passport)

/** Parses two 44-character lines. Use `findMrz` for raw OCR text. */
export function parseTd3(line1: string, line2: string, today: Date = new Date()): MrzResult {
  if (line1.length !== 44 || line2.length !== 44) throw new Error('TD3 lines must be 44 characters long.');
  const issues: MrzIssue[] = [];
  // "PK" is far more likely a misread "P<" than a real document sub-type.
  const code = alphaOnly(line1.slice(0, 2)).replace(/^PK$/, 'P<');
  const issuingState = countryField(line1.slice(2, 5), 'issuingState', issues);
  const names = parseNames(line1.slice(5, 44), issues);

  const birth = dateField(line2.slice(13, 19), line2[19], 'birth', 'dateOfBirth', today, issues);
  const expiry = dateField(line2.slice(21, 27), line2[27], 'expiry', 'expiryDate', today, issues);
  const expiryCheck = digitsOnly(line2[27]);
  const birthCheck = digitsOnly(line2[19]);
  const compositeFound = digitsOnly(line2[43]);

  // Personal number: optional. When empty, its check digit may be a filler instead of 0.
  let personalRaw = line2.slice(28, 42);
  let personalCheckChar = line2[42];
  if (isFillerOnly(personalRaw)) {
    personalRaw = '<'.repeat(14);
    if (/[KLC]/.test(personalCheckChar)) personalCheckChar = '<';
  }
  const personalEmpty = /^<+$/.test(personalRaw);
  const compositeOf = (number: string, numberCheck: string, personal: string, personalCheck: string) =>
    mrzCheckDigit(number + numberCheck + birth.raw + birthCheck + expiry.raw + expiryCheck + personal + personalCheck);

  const numberCheckChar = digitsOnly(line2[9]);
  const personalCheckDigit = personalEmpty && personalCheckChar === '<' ? '<' : digitsOnly(personalCheckChar);
  const number = checkAlnum(line2.slice(0, 9), line2[9]);
  const personal: Checked =
    personalEmpty && (personalCheckDigit === '<' || personalCheckDigit === '0')
      ? { raw: personalRaw, found: personalCheckDigit, valid: true, corrected: false, ambiguous: false }
      : checkAlnum(personalRaw, personalCheckChar);

  const compositeExpected = compositeOf(number.raw, numberCheckChar, personal.raw, personalCheckDigit);
  const fields: Record<MrzFieldKey, MrzField> = {
    documentNumber: checkedTextField(number, 'documentNumber', 'document number', issues),
    issuingState,
    nationality: countryField(line2.slice(10, 13), 'nationality', issues),
    surname: names.surname,
    givenNames: names.givenNames,
    dateOfBirth: birth,
    sex: sexField(line2[20], issues),
    expiryDate: expiry,
    optionalData: personalEmpty ? { ...empty(), raw: personalRaw, check: { expected: '0', found: personalCheckDigit, valid: personal.valid } } : checkedTextField(personal, 'optionalData', 'personal number', issues),
    optionalData2: empty(),
  };
  const repaired2 = number.raw + numberCheckChar + alphaOnly(line2.slice(10, 13)) + birth.raw + birthCheck + line2[20] + expiry.raw + expiryCheck + personal.raw + personalCheckDigit + compositeFound;
  return finish('TD3', code.replace(/<+$/, ''), fields, { expected: compositeExpected, found: compositeFound, valid: compositeExpected === compositeFound }, issues, [line1, repaired2]);
}

// ---------------------------------------------------------------------------- TD1 (identity card)

/** Parses three 30-character lines. Use `findMrz` for raw OCR text. */
export function parseTd1(line1: string, line2: string, line3: string, today: Date = new Date()): MrzResult {
  if (line1.length !== 30 || line2.length !== 30 || line3.length !== 30) throw new Error('TD1 lines must be 30 characters long.');
  const issues: MrzIssue[] = [];
  const code = alphaOnly(line1.slice(0, 2)).replace(/^([ACI])K$/, '$1<');
  const issuingState = countryField(line1.slice(2, 5), 'issuingState', issues);
  const birth = dateField(line2.slice(0, 6), line2[6], 'birth', 'dateOfBirth', today, issues);
  const expiry = dateField(line2.slice(8, 14), line2[14], 'expiry', 'expiryDate', today, issues);
  const birthCheck = digitsOnly(line2[6]);
  const expiryCheck = digitsOnly(line2[14]);
  const compositeFound = digitsOnly(line2[29]);

  let optional1 = line1.slice(15, 30);
  if (isFillerOnly(optional1)) optional1 = '<'.repeat(15);
  else optional1 = repairTrailingFillers(optional1, FILLER_LOOKALIKES);
  let optional2 = line2.slice(18, 29);
  if (isFillerOnly(optional2)) optional2 = '<'.repeat(11);
  else optional2 = repairTrailingFillers(optional2, FILLER_LOOKALIKES);
  // The optional field of UAE cards carries the 15-digit identity number: digits only.
  if (issuingState.value === 'ARE' && /^[0-9OQDILZSBG]{15}$/.test(optional1)) optional1 = digitsOnly(optional1);

  const upper = (numberPart: string, numberCheck: string, opt1: string) => numberPart + numberCheck + opt1;
  const compositeOf = (upperPart: string) => mrzCheckDigit(upperPart + birth.raw + birthCheck + expiry.raw + expiryCheck + optional2);

  let number: Checked;
  let numberValue: string | null;
  let upperPart: string;
  const longNumber = line1[14] === '<' && /^[A-Z0-9]+<?/.test(optional1) && !/^<+$/.test(optional1);
  if (longNumber) {
    // Document numbers longer than nine characters continue in the optional field; the last character before the filler is the check digit.
    const continuation = /^[A-Z0-9]+/.exec(optional1)![0];
    const body = line1.slice(5, 14) + continuation.slice(0, -1);
    number = checkAlnum(body, continuation.slice(-1));
    numberValue = number.raw.replace(/</g, '') || null;
    upperPart = number.raw.slice(0, 9) + '<' + number.raw.slice(9) + number.found + optional1.slice(continuation.length);
  } else {
    const numberCheckChar = digitsOnly(line1[14]);
    number = checkAlnum(line1.slice(5, 14), line1[14]);
    numberValue = number.raw.replace(/</g, '') || null;
    upperPart = upper(number.raw, numberCheckChar, optional1);
  }
  const compositeExpected = compositeOf(upperPart);
  const names = parseNames(line3, issues);
  const documentNumber = checkedTextField(number, 'documentNumber', 'document number', issues);
  documentNumber.value = numberValue;
  const optionalValue = longNumber ? null : optional1.replace(/</g, '') || null;
  const composite = { expected: compositeExpected, found: compositeFound, valid: compositeExpected === compositeFound };
  // Optional data has no check digit of its own; it is covered by the composite check only.
  const optionalConfidence = composite.valid ? C.CHECKED - 0.04 : C.CHECK_FAILED + 0.1;
  const fields: Record<MrzFieldKey, MrzField> = {
    documentNumber,
    issuingState,
    nationality: countryField(line2.slice(15, 18), 'nationality', issues),
    surname: names.surname,
    givenNames: names.givenNames,
    dateOfBirth: birth,
    sex: sexField(line2[7], issues),
    expiryDate: expiry,
    optionalData: { value: optionalValue, raw: optional1, confidence: optionalValue ? optionalConfidence : 0, corrected: optional1 !== line1.slice(15, 30) },
    optionalData2: { value: optional2.replace(/</g, '') || null, raw: optional2, confidence: optional2.replace(/</g, '') ? optionalConfidence : 0, corrected: optional2 !== line2.slice(18, 29) },
  };
  const repaired1 = line1.slice(0, 5) + upperPart;
  const repaired2 = birth.raw + birthCheck + line2[7] + expiry.raw + expiryCheck + alphaOnly(line2.slice(15, 18)) + optional2 + compositeFound;
  return finish('TD1', code.replace(/<+$/, ''), fields, composite, issues, [repaired1, repaired2, line3]);
}

// ---------------------------------------------------------------------------- locating the MRZ in OCR text

/** Name lines only lose or gain fillers at the end. */
function fitNameLine(line: string, length: number): string {
  if (line.length < length) return line.padEnd(length, '<');
  return line.slice(0, length);
}
/**
 * Data lines of the wrong length.
 *
 * `guesses`: OCR usually drops or doubles a filler inside the longest filler
 * run, so that is repaired first (then plain padding / cutting).
 * `strict`: every way of removing one stray character (or inserting one
 * filler). These are only believed when EVERY check digit of the zone then
 * validates, which a wrong alignment practically never achieves.
 */
function fitDataLine(line: string, length: number): { guesses: string[]; strict: string[] } {
  if (line.length === length) return { guesses: [line], strict: [] };
  const guesses: string[] = [];
  const runs = [...line.matchAll(/[<K]{2,}/g)].sort((a, b) => b[0].length - a[0].length);
  const run = runs[0];
  const diff = length - line.length;
  if (run && run.index !== undefined) {
    if (diff > 0) guesses.push(line.slice(0, run.index) + '<'.repeat(diff) + line.slice(run.index));
    else if (run[0].length > -diff) guesses.push(line.slice(0, run.index) + line.slice(run.index - diff));
  }
  guesses.push(diff > 0 ? line.padEnd(length, '<') : line.slice(0, length));
  if (diff < 0) guesses.push(line.slice(-length));
  const strict: string[] = [];
  if (diff === -1) for (let i = 0; i < line.length; i++) strict.push(line.slice(0, i) + line.slice(i + 1));
  if (diff === 1) for (let i = 0; i <= line.length; i++) strict.push(line.slice(0, i) + '<' + line.slice(i));
  const unique = (list: string[]) => [...new Set(list)].filter((o) => o.length === length);
  return { guesses: unique(guesses), strict: unique(strict).filter((o) => !guesses.includes(o)) };
}
const score = (r: MrzResult) => r.checksPassed * 10 - r.issues.length;

/**
 * Finds and parses the machine readable zone in OCR text. Returns null when
 * the text contains nothing that looks like one (nothing is guessed).
 */
export function findMrz(text: string, today: Date = new Date()): MrzResult | null {
  const kept = text
    .split(/\r?\n/)
    .filter((raw) => mrzLikeness(raw) >= 0.85)
    .map((raw) => ({ row: normaliseMrzLine(raw), noisy: /[^A-Za-z0-9<«»‹›\s]/.test(raw) }))
    .filter(({ row }) => row.length >= 26 && row.length <= 92);
  const rows = kept.map((k) => k.row);
  let best: MrzResult | null = null;
  let noisyLines = false;
  const consider = (candidate: MrzResult, lengthRepaired: boolean) => {
    if (lengthRepaired) candidate.issues.push({ code: 'LINE_LENGTH_REPAIRED', message: 'A line of the machine readable zone had the wrong length and was aligned. Check every value against the document.' });
    if (noisyLines) {
      // Punctuation inside an MRZ line means the recognition stumbled there. A valid check digit does not
      // rule out a wrong character (see the note on its limits above), so every value is scored lower.
      candidate.issues.push({ code: 'STRAY_CHARACTERS', message: 'Unexpected characters were found in the machine readable zone and ignored. Check every value against the document.' });
      for (const f of Object.values(candidate.fields)) f.confidence = round(f.confidence * 0.9);
    }
    if (!best || score(candidate) > score(best)) best = candidate;
  };

  for (let i = 0; i < rows.length; i++) {
    const a = rows[i];
    noisyLines = kept[i].noisy;
    // TD3 recognised as one 88-character run.
    if (/^P[A-Z<]/.test(a) && a.length === 88) consider(parseTd3(a.slice(0, 44), a.slice(44), today), false);

    const b = rows[i + 1];
    noisyLines = kept[i].noisy || !!kept[i + 1]?.noisy;
    // The name line may have lost many of its trailing fillers; the data line may be off by a few characters.
    if (b && /^P[A-Z<]/.test(a) && a.length >= 30 && a.length <= 48 && b.length >= 41 && b.length <= 47 && (b.match(/[0-9]/g) ?? []).length >= 10) {
      const repaired = a.length !== 44 || b.length !== 44;
      const line1 = fitNameLine(a, 44);
      const fit = fitDataLine(b, 44);
      for (const line2 of fit.guesses) consider(parseTd3(line1, line2, today), repaired);
      for (const line2 of fit.strict) {
        const candidate = parseTd3(line1, line2, today);
        if (candidate.valid) consider(candidate, true);
      }
    }
    const c = rows[i + 2];
    noisyLines = kept[i].noisy || !!kept[i + 1]?.noisy || !!kept[i + 2]?.noisy;
    if (b && c && /^[ACI][A-Z<]/.test(a) && [a, b, c].every((r) => r.length >= 27 && r.length <= 33) && /^[0-9OQDILZSBG]{6}/.test(b)) {
      const repaired = [a, b, c].some((r) => r.length !== 30);
      const line3 = fitNameLine(c, 30);
      const fit1 = fitDataLine(a, 30);
      const fit2 = fitDataLine(b, 30);
      for (const line1 of fit1.guesses) for (const line2 of fit2.guesses) consider(parseTd1(line1, line2, line3, today), repaired);
      for (const line1 of [...fit1.guesses, ...fit1.strict]) {
        for (const line2 of [...fit2.guesses, ...fit2.strict]) {
          if (fit1.guesses.includes(line1) && fit2.guesses.includes(line2)) continue;
          const candidate = parseTd1(line1, line2, line3, today);
          if (candidate.valid) consider(candidate, true);
        }
      }
    }
  }
  const found = best as MrzResult | null;
  // A zone in which not a single check digit validates is noise, not an MRZ.
  if (found && found.checksPassed === 0) return null;
  return found;
}
