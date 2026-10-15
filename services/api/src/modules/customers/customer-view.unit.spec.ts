import { customerContactSchema, customerSchema, normaliseContactValue, normalisePhoneSearch, updateOwnCustomerSchema } from '@typease/validation';
import { blindIndex, decryptText } from '../../common/crypto';
import { customerListItem, customerView, CustomerRow, dateOnly, identityColumns, normaliseName, ownCustomerView, parseDateOnly, searchConditions } from './customer-view';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const row = (over: Partial<CustomerRow> = {}): CustomerRow => ({
  id: 'c1', tenantId: TENANT, customerNo: 'CUS-000042', type: 'INDIVIDUAL', status: 'ACTIVE', fullName: 'Aisha Khan', fullNameAr: null, taxRegistrationNo: null, preferredLanguage: 'en',
  email: 'aisha@example.test', phone: '+971501234567', nationality: 'PK', dateOfBirth: new Date('1990-02-28T00:00:00Z'), address: { city: 'Dubai' },
  emiratesIdLast4: '5671', emiratesIdExpiry: new Date('2027-01-31T00:00:00Z'), passportNoLast4: '4567', passportCountry: 'PK', passportExpiry: null,
  corporateAccountId: null, communicationPrefs: { whatsapp: true }, marketingOptIn: false, mergedIntoId: null, lastActivityAt: null, createdById: 'u1',
  createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-02T00:00:00Z'), version: 3, ...over,
});

describe('customer views (masking)', () => {
  it('the staff view shows identity numbers masked and nothing else about them', () => {
    const view = customerView(row()) as Record<string, unknown>;
    expect(view).toMatchObject({ emiratesIdMasked: '•••• 5671', hasEmiratesId: true, emiratesIdExpiry: '2027-01-31', passportNoMasked: '•••• 4567', hasPassport: true, passportExpiry: null, dateOfBirth: '1990-02-28', version: 3 });
    expect(view.communicationPrefs).toEqual({ email: true, sms: true, whatsapp: true, push: true });
    for (const key of Object.keys(view)) expect(key).not.toMatch(/Enc$|Hash$|Last4$/);
  });
  it('a record without identity numbers has null masks', () => {
    expect(customerView(row({ emiratesIdLast4: null, passportNoLast4: null }))).toMatchObject({ emiratesIdMasked: null, hasEmiratesId: false, passportNoMasked: null, hasPassport: false });
  });
  it('list rows leave out date of birth and address', () => {
    const item = customerListItem(row()) as Record<string, unknown>;
    expect(item).toMatchObject({ customerNo: 'CUS-000042', emiratesIdMasked: '•••• 5671', passportNoMasked: '•••• 4567' });
    for (const key of ['dateOfBirth', 'address', 'createdById', 'version', 'communicationPrefs']) expect(item).not.toHaveProperty(key);
  });
  it('the customer\'s own view has no internal fields', () => {
    const own = ownCustomerView(row()) as Record<string, unknown>;
    expect(own).toMatchObject({ fullName: 'Aisha Khan', emiratesIdMasked: '•••• 5671', dateOfBirth: '1990-02-28' });
    for (const key of ['createdById', 'mergedIntoId', 'status', 'tenantId', 'version', 'corporateAccountId', 'lastActivityAt']) expect(own).not.toHaveProperty(key);
  });
  it('date-only values do not drift with time zones', () => {
    expect(dateOnly(parseDateOnly('2026-12-31'))).toBe('2026-12-31');
    expect(dateOnly(null)).toBeNull();
    expect(parseDateOnly(undefined)).toBeNull();
  });
});

describe('identityColumns', () => {
  it('stores an encrypted value, a tenant-scoped blind index and the last four characters', () => {
    const cols = identityColumns(TENANT, { emiratesId: '784199012345671', passportNo: 'AB1234567' });
    expect(Object.keys(cols).sort()).toEqual(['emiratesIdEnc', 'emiratesIdHash', 'emiratesIdLast4', 'passportNoEnc', 'passportNoHash', 'passportNoLast4']);
    expect(cols.emiratesIdEnc).not.toContain('784199012345671');
    expect(decryptText(cols.emiratesIdEnc!)).toBe('784199012345671');
    expect(decryptText(cols.passportNoEnc!)).toBe('AB1234567');
    expect(cols.emiratesIdLast4).toBe('5671');
    expect(cols.passportNoLast4).toBe('4567');
    expect(cols.emiratesIdHash).toBe(blindIndex(TENANT, 'emiratesId', '784-1990-1234567-1'));
    // The same number in another centre has a different index: hashes cannot be correlated across tenants.
    expect(cols.emiratesIdHash).not.toBe(blindIndex(OTHER, 'emiratesId', '784199012345671'));
    // Encryption is randomised; the index is what makes exact search possible.
    expect(identityColumns(TENANT, { emiratesId: '784199012345671' }).emiratesIdEnc).not.toBe(cols.emiratesIdEnc);
  });
  it('null clears all three columns; undefined leaves them alone', () => {
    expect(identityColumns(TENANT, { emiratesId: null })).toEqual({ emiratesIdEnc: null, emiratesIdHash: null, emiratesIdLast4: null });
    expect(identityColumns(TENANT, { passportNo: null })).toEqual({ passportNoEnc: null, passportNoHash: null, passportNoLast4: null });
    expect(identityColumns(TENANT, {})).toEqual({});
  });
});

describe('searchConditions (the search box)', () => {
  const kinds = (q: string) => searchConditions(TENANT, q).map((c) => Object.keys(c)[0]);
  it('always searches names (partially) and the customer number (exactly)', () => {
    const or = searchConditions(TENANT, 'aisha');
    expect(or).toEqual([{ fullName: { contains: 'aisha', mode: 'insensitive' } }, { fullNameAr: { contains: 'aisha' } }, { customerNo: 'AISHA' }]);
    expect(searchConditions(TENANT, '   ')).toEqual([]);
  });
  it('a short number finds the customer number', () => {
    expect(searchConditions(TENANT, '42')).toContainEqual({ customerNo: 'CUS-000042' });
    expect(searchConditions(TENANT, 'cus-000042')).toContainEqual({ customerNo: 'CUS-000042' });
  });
  it('phone numbers match exactly in normalised form, never partially', () => {
    expect(searchConditions(TENANT, '050 123 4567')).toContainEqual({ phone: '+971501234567' });
    expect(searchConditions(TENANT, '+971501234567')).toContainEqual({ phone: '+971501234567' });
    expect(kinds('1234')).not.toContain('phone');
    expect(JSON.stringify(searchConditions(TENANT, '0501234'))).not.toMatch(/"phone":\{"contains"/);
  });
  it('identity numbers go through the blind index only', () => {
    const eid = searchConditions(TENANT, '784-1990-1234567-1');
    expect(eid).toContainEqual({ emiratesIdHash: blindIndex(TENANT, 'emiratesId', '784199012345671') });
    expect(searchConditions(TENANT, 'ab1234567')).toContainEqual({ passportNoHash: blindIndex(TENANT, 'passport', 'AB1234567') });
    // Fragments of an identity number are never turned into a search.
    expect(kinds('7841990')).not.toContain('emiratesIdHash');
    expect(kinds('5671')).toEqual(['fullName', 'fullNameAr', 'customerNo', 'customerNo']);
    for (const q of ['784199012345671', 'AB1234567', '5671']) {
      const text = JSON.stringify(searchConditions(TENANT, q));
      expect(text).not.toMatch(/emiratesIdLast4|passportNoLast4|emiratesIdEnc|passportNoEnc/);
    }
  });
  it('a request reference leads to the customer of that request', () => {
    expect(searchConditions(TENANT, 'te-000123')).toContainEqual({ serviceRequests: { some: { requestNo: 'TE-000123', deletedAt: null } } });
    expect(kinds('Aisha Khan')).not.toContain('serviceRequests');
  });
  it('email is searched only when the text looks like one', () => {
    expect(searchConditions(TENANT, 'Aisha@Example.test')).toContainEqual({ email: { contains: 'aisha@example.test' } });
    expect(kinds('aisha')).not.toContain('email');
  });
});

describe('validation helpers', () => {
  it('normalisePhoneSearch understands local and international notations', () => {
    expect(normalisePhoneSearch('050 123 4567')).toBe('+971501234567');
    expect(normalisePhoneSearch('00971 50 123 4567')).toBe('+971501234567');
    expect(normalisePhoneSearch('971501234567')).toBe('+971501234567');
    expect(normalisePhoneSearch('+44 20 7946 0958')).toBe('+442079460958');
    expect(normalisePhoneSearch('(050) 123-4567')).toBe('+971501234567');
    for (const bad of ['', 'aisha', '1234', '+0123456789', '784199012345671']) expect(normalisePhoneSearch(bad)).toBeNull();
  });
  it('normaliseName ignores case and spacing', () => {
    expect(normaliseName('  AISHA   Khan ')).toBe('aisha khan');
    expect(normaliseName('Aisha Khan')).toBe(normaliseName('aisha\tkhan'));
  });
  it('customerSchema normalises names, identity numbers and contact details', () => {
    const parsed = customerSchema.parse({ fullName: '  Aisha    Khan ', email: ' AISHA@Example.TEST ', phone: '+971 50 123 4567', emiratesId: '784-1990-1234567-1', passportNo: ' ab1234567 ', nationality: 'pk' });
    expect(parsed).toMatchObject({ fullName: 'Aisha Khan', email: 'aisha@example.test', phone: '+971501234567', emiratesId: '784199012345671', passportNo: 'AB1234567', nationality: 'PK', type: 'INDIVIDUAL', preferredLanguage: 'en' });
    expect(customerSchema.safeParse({ fullName: 'A B', emiratesId: '123456789012345' }).success).toBe(false);
    expect(customerSchema.safeParse({ fullName: 'A B', emiratesId: '78419901234567' }).success).toBe(false);
    expect(customerSchema.safeParse({ fullName: 'A B', passportNo: 'AB-12' }).success).toBe(false);
    expect(customerSchema.safeParse({ fullName: 'A B', phone: '0501234567' }).success).toBe(false);
    expect(customerSchema.safeParse({ fullName: 'A B', dateOfBirth: '28/02/1990' }).success).toBe(false);
  });
  it('the self-service schema carries phone, nationality and date of birth, but never the login address, identity numbers or internal fields', () => {
    const parsed = updateOwnCustomerSchema.parse({
      fullName: 'New Name', phone: '+971500000000', nationality: 'IN', dateOfBirth: '1991-07-23',
      email: 'evil@example.test', emiratesId: '784199012345671', passportNo: 'AB123456', passportCountry: 'IN', emiratesIdExpiry: '2031-01-01', status: 'ACTIVE', corporateAccountId: OTHER, marketingOptIn: true, type: 'BUSINESS',
    });
    expect(parsed).toEqual({ fullName: 'New Name', phone: '+971500000000', nationality: 'IN', dateOfBirth: '1991-07-23' });
    // The same validation as at the counter; a date of birth cannot be in the future; null clears a value.
    expect(updateOwnCustomerSchema.safeParse({ phone: '0501234567' }).success).toBe(false);
    expect(updateOwnCustomerSchema.safeParse({ nationality: 'Indian' }).success).toBe(false);
    expect(updateOwnCustomerSchema.safeParse({ dateOfBirth: '23/07/1991' }).success).toBe(false);
    expect(updateOwnCustomerSchema.safeParse({ dateOfBirth: '2999-01-01' }).success).toBe(false);
    expect(updateOwnCustomerSchema.parse({ nationality: null, dateOfBirth: null })).toEqual({ nationality: null, dateOfBirth: null });
  });
  it('contacts are checked against their type', () => {
    expect(customerContactSchema.parse({ type: 'EMAIL', value: ' Second@Example.TEST ' })).toMatchObject({ value: 'second@example.test', isPrimary: false });
    expect(customerContactSchema.parse({ type: 'WHATSAPP', value: '+971 55 123 4567' }).value).toBe('+971551234567');
    expect(customerContactSchema.safeParse({ type: 'PHONE', value: 'call me' }).success).toBe(false);
    expect(customerContactSchema.safeParse({ type: 'EMAIL', value: '+971551234567' }).success).toBe(false);
    expect(normaliseContactValue('PHONE', '0551234567')).toEqual({ ok: false, message: 'Use international format, e.g. +971501234567' });
  });
});
