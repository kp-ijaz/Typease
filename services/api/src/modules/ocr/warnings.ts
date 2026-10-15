import type { OcrFieldKey } from '@typease/validation';
import { ExtractedField, Extraction, FIELD_LABELS } from './extractors';

/**
 * Warnings shown next to an extraction: expiry, failed check digits, missing
 * fields and differences from what is on file. Pure: the caller passes the
 * (decrypted) profile values in and nothing here logs or stores them. Warning
 * texts never contain a profile value or an identity number.
 */

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH';
export interface OcrWarning {
  code: string;
  severity: Severity;
  message: string;
  field?: OcrFieldKey;
  /** A suggested correction: copy this extracted field to that place AFTER a person has confirmed it. Never applied automatically. */
  suggestion?: { target: string; fieldKey: OcrFieldKey };
}
/** What is on file for the customer / document the extraction belongs to. */
export interface OnFile {
  fullName?: string | null;
  /** YYYY-MM-DD */
  dateOfBirth?: string | null;
  nationality?: string | null;
  passportNumber?: string | null;
  emiratesIdNumber?: string | null;
  /** The document's own expiry date as recorded in the vault (YYYY-MM-DD). */
  documentExpiryDate?: string | null;
}

const ISSUE_SEVERITY: Record<string, Severity> = {
  CHECK_DIGIT_MISMATCH: 'HIGH', COMPOSITE_CHECK_MISMATCH: 'HIGH', EMIRATES_ID_CHECK_FAILED: 'HIGH', INVALID_DATE: 'MEDIUM', MISSING_FIELD: 'MEDIUM',
  CLASSIFICATION_MISMATCH: 'MEDIUM', NAME_UNCERTAIN: 'MEDIUM', LINE_LENGTH_REPAIRED: 'MEDIUM', UNKNOWN_COUNTRY_CODE: 'LOW', NAME_POSSIBLY_TRUNCATED: 'LOW',
  CHARACTER_REPAIRED: 'LOW', FILLER_REPAIRED: 'LOW', TRAILING_K_AMBIGUOUS: 'MEDIUM', STRAY_CHARACTERS: 'MEDIUM', INVALID_SEX: 'LOW',
};
export const LOW_CONFIDENCE_BELOW = 0.6;
/** Many UAE procedures need at least six months of validity, so that is when the warning starts. */
export const EXPIRY_WARNING_MONTHS = 6;

// ---------------------------------------------------------------------------- comparisons

const nameTokens = (name: string) =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/['’`]/g, '')
    .replace(/[^A-Z]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

/**
 * Compares a name read from a document with the name on file. Word order,
 * case, accents, hyphens and apostrophes are ignored (the MRZ drops them).
 * PARTIAL = one name is contained in the other (middle names missing).
 */
export function compareNames(a: string, b: string): 'MATCH' | 'PARTIAL' | 'MISMATCH' {
  const x = nameTokens(a);
  const y = nameTokens(b);
  if (!x.length || !y.length) return 'MISMATCH';
  // Same words in any order; a name part written as one or two words ("AL MANSOORI" / "ALMANSOORI") counts as the same.
  const merges = (t: string[]) => [t, ...t.slice(1).map((_, i) => [...t.slice(0, i), t[i] + t[i + 1], ...t.slice(i + 2)])].map((v) => [...v].sort().join(' '));
  const xs = merges(x);
  if (x.join('') === y.join('') || merges(y).some((v) => xs.includes(v))) return 'MATCH';
  const [small, large] = x.length <= y.length ? [x, y] : [y, x];
  const contained = small.every((t) => large.includes(t));
  if (contained && (small.length >= 2 || large.length <= 2)) return 'PARTIAL';
  return 'MISMATCH';
}
export const sameIdentityNumber = (a: string, b: string) => a.replace(/[^A-Za-z0-9]/g, '').toUpperCase() === b.replace(/[^A-Za-z0-9]/g, '').toUpperCase();

/** Does an extracted (or reviewed) value agree with what is on file? null = nothing on file, or not comparable. */
export function matchesOnFile(key: OcrFieldKey, value: string | null | undefined, onFile: OnFile): boolean | null {
  if (!value) return null;
  switch (key) {
    case 'fullName':
      return onFile.fullName ? compareNames(value, onFile.fullName) !== 'MISMATCH' : null;
    case 'dateOfBirth':
      return onFile.dateOfBirth ? value === onFile.dateOfBirth : null;
    case 'nationality':
      return onFile.nationality && onFile.nationality.length === value.length ? onFile.nationality.toUpperCase() === value.toUpperCase() : null;
    case 'passportNumber':
      return onFile.passportNumber ? sameIdentityNumber(value, onFile.passportNumber) : null;
    case 'emiratesIdNumber':
      return onFile.emiratesIdNumber ? sameIdentityNumber(value, onFile.emiratesIdNumber) : null;
    case 'expiryDate':
      return onFile.documentExpiryDate ? value === onFile.documentExpiryDate : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------- warnings

function addMonths(date: Date, months: number): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return d;
}
const dayStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export function buildWarnings(extraction: Pick<Extraction, 'fields' | 'issues'>, onFile: OnFile | null, today: Date = new Date()): OcrWarning[] {
  const warnings: OcrWarning[] = [];
  const field = (key: OcrFieldKey): ExtractedField | undefined => extraction.fields.find((f) => f.key === key);

  for (const issue of extraction.issues) {
    warnings.push({ code: issue.code, severity: ISSUE_SEVERITY[issue.code] ?? 'MEDIUM', message: issue.message, ...(issue.field ? { field: issue.field } : {}) });
  }

  const expiry = field('expiryDate');
  if (expiry) {
    const start = dayStart(today);
    const date = new Date(`${expiry.value}T00:00:00.000Z`);
    const days = Math.round((date.getTime() - start.getTime()) / 86400_000);
    if (days < 0) {
      warnings.push({ code: 'DOCUMENT_EXPIRED', severity: 'HIGH', field: 'expiryDate', message: `The document appears to have expired on ${expiry.value}.` });
    } else if (date.getTime() <= addMonths(start, EXPIRY_WARNING_MONTHS).getTime()) {
      warnings.push({ code: 'DOCUMENT_EXPIRING_SOON', severity: 'MEDIUM', field: 'expiryDate', message: `The document appears to expire on ${expiry.value} (${days} day${days === 1 ? '' : 's'} left, less than ${EXPIRY_WARNING_MONTHS} months).` });
    }
  }

  for (const f of extraction.fields) {
    if (f.confidence < LOW_CONFIDENCE_BELOW) {
      warnings.push({ code: 'LOW_CONFIDENCE', severity: 'LOW', field: f.key, message: `${FIELD_LABELS[f.key]} was read with low confidence. Check it against the document.` });
    }
  }

  if (onFile) {
    const name = field('fullName');
    if (name && onFile.fullName) {
      const result = compareNames(name.value, onFile.fullName);
      if (result === 'MISMATCH') {
        warnings.push({ code: 'NAME_MISMATCH', severity: 'HIGH', field: 'fullName', message: 'The name on the document differs from the name on the customer profile.', suggestion: { target: 'customer.fullName', fieldKey: 'fullName' } });
      } else if (result === 'PARTIAL') {
        warnings.push({ code: 'NAME_PARTIAL_MATCH', severity: 'LOW', field: 'fullName', message: 'The name on the document and on the customer profile only match in part (for example a missing middle name).', suggestion: { target: 'customer.fullName', fieldKey: 'fullName' } });
      }
    }
    const compare = (key: OcrFieldKey, onFileValue: string | null | undefined, code: string, what: string, target: string, severity: Severity) => {
      const f = field(key);
      if (!f) return;
      if (!onFileValue) {
        warnings.push({ code: 'NOT_ON_FILE', severity: 'LOW', field: key, message: `${what} is not on file yet. It can be added after review.`, suggestion: { target, fieldKey: key } });
        return;
      }
      if (matchesOnFile(key, f.value, onFile) === false) {
        warnings.push({ code, severity, field: key, message: `${what} on the document differs from the one on file.`, suggestion: { target, fieldKey: key } });
      }
    };
    compare('dateOfBirth', onFile.dateOfBirth, 'DATE_OF_BIRTH_MISMATCH', 'The date of birth', 'customer.dateOfBirth', 'HIGH');
    compare('passportNumber', onFile.passportNumber, 'DOCUMENT_NUMBER_MISMATCH', 'The passport number', 'customer.passportNo', 'HIGH');
    compare('emiratesIdNumber', onFile.emiratesIdNumber, 'DOCUMENT_NUMBER_MISMATCH', 'The Emirates ID number', 'customer.emiratesId', 'HIGH');
    compare('expiryDate', onFile.documentExpiryDate, 'EXPIRY_DATE_MISMATCH', 'The expiry date', 'document.expiryDate', 'MEDIUM');
    const nationality = field('nationality');
    if (nationality && onFile.nationality && matchesOnFile('nationality', nationality.value, onFile) === false) {
      warnings.push({ code: 'NATIONALITY_MISMATCH', severity: 'MEDIUM', field: 'nationality', message: 'The nationality on the document differs from the one on the customer profile.', suggestion: { target: 'customer.nationality', fieldKey: 'nationality' } });
    }
  }
  const rank: Record<Severity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  return warnings.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
