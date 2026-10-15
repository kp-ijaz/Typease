import { normalisePhoneSearch } from '@typease/validation';
import { blindIndex, encryptText, last4, maskTail } from '../../common/crypto';
import { isErasedCustomer } from '../../common/customer-ref';

/**
 * Everything about what a customer record looks like outside the database.
 *
 * Identity numbers exist in three columns each: `*Enc` (AES-256-GCM), `*Hash`
 * (keyed blind index for exact-match search) and `*Last4`. Only `*Last4` is ever
 * selected for normal reads, and it leaves the API as a masked string. The
 * encrypted and hashed columns are not part of CUSTOMER_COLUMNS on purpose.
 */
export const CUSTOMER_COLUMNS = {
  id: true, tenantId: true, customerNo: true, type: true, status: true, fullName: true, fullNameAr: true, preferredLanguage: true,
  email: true, phone: true, nationality: true, dateOfBirth: true, address: true, taxRegistrationNo: true,
  emiratesIdLast4: true, emiratesIdExpiry: true, passportNoLast4: true, passportCountry: true, passportExpiry: true,
  corporateAccountId: true, communicationPrefs: true, marketingOptIn: true, mergedIntoId: true, lastActivityAt: true,
  createdById: true, createdAt: true, updatedAt: true, version: true,
} as const;

export interface CustomerRow {
  id: string;
  tenantId: string;
  customerNo: string;
  type: string;
  status: string;
  fullName: string;
  fullNameAr: string | null;
  taxRegistrationNo: string | null;
  preferredLanguage: string;
  email: string | null;
  phone: string | null;
  nationality: string | null;
  dateOfBirth: Date | null;
  address: unknown;
  emiratesIdLast4: string | null;
  emiratesIdExpiry: Date | null;
  passportNoLast4: string | null;
  passportCountry: string | null;
  passportExpiry: Date | null;
  corporateAccountId: string | null;
  communicationPrefs: unknown;
  marketingOptIn: boolean;
  mergedIntoId: string | null;
  lastActivityAt: Date | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export const DEFAULT_COMMUNICATION_PREFS = { email: true, sms: true, whatsapp: false, push: true };
/** Date-only columns travel as YYYY-MM-DD, never as a timestamp that shifts with the time zone. */
export const dateOnly = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
export const parseDateOnly = (v: string | null | undefined) => (v ? new Date(`${v}T00:00:00.000Z`) : null);

function masked(row: Pick<CustomerRow, 'emiratesIdLast4' | 'emiratesIdExpiry' | 'passportNoLast4' | 'passportCountry' | 'passportExpiry'>) {
  return {
    emiratesIdMasked: maskTail(row.emiratesIdLast4),
    hasEmiratesId: !!row.emiratesIdLast4,
    emiratesIdExpiry: dateOnly(row.emiratesIdExpiry),
    passportNoMasked: maskTail(row.passportNoLast4),
    hasPassport: !!row.passportNoLast4,
    passportCountry: row.passportCountry,
    passportExpiry: dateOnly(row.passportExpiry),
  };
}

/** Staff view of a profile: identity numbers masked. */
export function customerView(row: CustomerRow) {
  const { emiratesIdLast4: _e, passportNoLast4: _p, emiratesIdExpiry: _ee, passportExpiry: _pe, passportCountry: _pc, dateOfBirth, communicationPrefs, ...rest } = row;
  // `erased`: the personal data was erased on request; what is left is a stub with a placeholder name.
  return { ...rest, erased: isErasedCustomer(row), dateOfBirth: dateOnly(dateOfBirth), communicationPrefs: { ...DEFAULT_COMMUNICATION_PREFS, ...((communicationPrefs as object) ?? {}) }, ...masked(row) };
}

/** List rows carry less personal data than the profile: no date of birth, no address. */
export function customerListItem(row: CustomerRow) {
  return {
    id: row.id,
    customerNo: row.customerNo,
    type: row.type,
    status: row.status,
    erased: isErasedCustomer(row),
    fullName: row.fullName,
    fullNameAr: row.fullNameAr,
    preferredLanguage: row.preferredLanguage,
    email: row.email,
    phone: row.phone,
    nationality: row.nationality,
    corporateAccountId: row.corporateAccountId,
    mergedIntoId: row.mergedIntoId,
    lastActivityAt: row.lastActivityAt,
    createdAt: row.createdAt,
    emiratesIdMasked: maskTail(row.emiratesIdLast4),
    passportNoMasked: maskTail(row.passportNoLast4),
  };
}

/** What a customer sees of their own record: no internal fields (tags, notes, who created it, merge links). */
export function ownCustomerView(row: CustomerRow) {
  return {
    id: row.id,
    customerNo: row.customerNo,
    type: row.type,
    fullName: row.fullName,
    fullNameAr: row.fullNameAr,
    preferredLanguage: row.preferredLanguage,
    email: row.email,
    phone: row.phone,
    nationality: row.nationality,
    dateOfBirth: dateOnly(row.dateOfBirth),
    address: row.address ?? null,
    communicationPrefs: { ...DEFAULT_COMMUNICATION_PREFS, ...((row.communicationPrefs as object) ?? {}) },
    marketingOptIn: row.marketingOptIn,
    ...masked(row),
  };
}

/** Columns for storing identity numbers: encrypted value + blind index + last four characters. */
export function identityColumns(tenantId: string, input: { emiratesId?: string | null; passportNo?: string | null }) {
  const data: Record<string, string | null> = {};
  if (input.emiratesId !== undefined) {
    const v = input.emiratesId;
    Object.assign(data, v ? { emiratesIdEnc: encryptText(v), emiratesIdHash: blindIndex(tenantId, 'emiratesId', v), emiratesIdLast4: last4(v) } : { emiratesIdEnc: null, emiratesIdHash: null, emiratesIdLast4: null });
  }
  if (input.passportNo !== undefined) {
    const v = input.passportNo;
    Object.assign(data, v ? { passportNoEnc: encryptText(v), passportNoHash: blindIndex(tenantId, 'passport', v), passportNoLast4: last4(v) } : { passportNoEnc: null, passportNoHash: null, passportNoLast4: null });
  }
  return data;
}

/** Same person written slightly differently ("  AISHA   Khan " / "Aisha Khan") compares equal. */
export const normaliseName = (name: string) => name.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

const compact = (v: string) => v.replace(/[\s-]/g, '').toUpperCase();
export const looksLikeEmiratesId = (v: string) => /^784\d{12}$/.test(compact(v));
export const looksLikePassport = (v: string) => /^[A-Z0-9]{5,12}$/.test(compact(v)) && /\d/.test(v);

/**
 * The search box: one text, several ways to match. Names match partially;
 * everything that identifies a person (phone, Emirates ID, passport) matches
 * only exactly, and identity numbers only through the blind index.
 */
export function searchConditions(tenantId: string, q: string): Array<Record<string, unknown>> {
  const text = q.trim();
  if (!text) return [];
  const or: Array<Record<string, unknown>> = [
    { fullName: { contains: text, mode: 'insensitive' } },
    { fullNameAr: { contains: text } },
    { customerNo: text.toUpperCase() },
  ];
  // "42" finds CUS-000042.
  if (/^\d{1,9}$/.test(text)) or.push({ customerNo: `CUS-${text.padStart(6, '0')}` });
  if (text.includes('@')) or.push({ email: { contains: text.toLowerCase() } });
  const phone = normalisePhoneSearch(text);
  if (phone) or.push({ phone });
  if (looksLikeEmiratesId(text)) or.push({ emiratesIdHash: blindIndex(tenantId, 'emiratesId', text) });
  if (looksLikePassport(text)) or.push({ passportNoHash: blindIndex(tenantId, 'passport', text) });
  // A request reference such as TE-000123 leads to the customer of that request.
  if (/^[A-Za-z0-9]{1,6}-\d{3,}$/.test(text)) or.push({ serviceRequests: { some: { requestNo: text.toUpperCase(), deletedAt: null } } });
  return or;
}
