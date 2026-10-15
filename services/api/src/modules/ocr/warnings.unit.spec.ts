import { extractDocument, formatEmiratesId } from './extractors';
import { buildTd1, buildTd3, daysFromNow, emiratesIdFrom, ICAO_TD3, isoDate, mrzDate } from './fixtures';
import { buildWarnings, compareNames, matchesOnFile, sameIdentityNumber } from './warnings';

const TODAY = new Date('2026-06-15T09:30:00Z');
const passport = (over: Partial<Parameters<typeof buildTd3>[0]> = {}) =>
  buildTd3({ issuing: 'IND', surname: 'Sampleson', given: 'Rahul Kumar', number: 'Z1234567', nationality: 'IND', dob: '900214', sex: 'M', expiry: '310530', ...over }).join('\n');
const codes = (w: Array<{ code: string }>) => w.map((x) => x.code);

describe('name comparison', () => {
  it('ignores order, case, accents, hyphens and apostrophes', () => {
    expect(compareNames('RAHUL KUMAR SAMPLESON', 'Sampleson Rahul Kumar')).toBe('MATCH');
    expect(compareNames('JOSE MARIA OBRIEN', "José-María O'Brien")).toBe('MATCH');
    expect(compareNames('AL MANSOORI AHMED', 'Ahmed Almansoori')).toBe('MATCH');
  });
  it('recognises partial matches and real differences', () => {
    expect(compareNames('RAHUL KUMAR SAMPLESON', 'Rahul Sampleson')).toBe('PARTIAL');
    expect(compareNames('RAHUL SAMPLESON', 'Rahul')).toBe('PARTIAL');
    expect(compareNames('RAHUL KUMAR SAMPLESON', 'Rahul')).toBe('MISMATCH'); // one shared word of three is not enough
    expect(compareNames('RAHUL KUMAR SAMPLESON', 'Priya Sampleson')).toBe('MISMATCH');
    expect(compareNames('RAHUL', '')).toBe('MISMATCH');
  });
  it('compares identity numbers ignoring separators and case', () => {
    expect(sameIdentityNumber('784-1990-1234567-1', '784199012345671')).toBe(true);
    expect(sameIdentityNumber('z1234567', 'Z 1234567')).toBe(true);
    expect(sameIdentityNumber('Z1234567', 'Z1234568')).toBe(false);
  });
  it('answers null when nothing comparable is on file', () => {
    expect(matchesOnFile('passportNumber', 'Z1234567', {})).toBeNull();
    expect(matchesOnFile('passportNumber', null, { passportNumber: 'Z1234567' })).toBeNull();
    expect(matchesOnFile('nationality', 'IND', { nationality: 'IN' })).toBeNull(); // 2- vs 3-letter codes are not compared
    expect(matchesOnFile('nationality', 'IND', { nationality: 'ind' })).toBe(true);
    expect(matchesOnFile('surname', 'X', { fullName: 'X' })).toBeNull();
  });
});

describe('warnings', () => {
  it('raises nothing for a clean, valid document that agrees with the profile', () => {
    const e = extractDocument(passport(), { today: TODAY });
    const w = buildWarnings(e, { fullName: 'Rahul Kumar Sampleson', dateOfBirth: '1990-02-14', nationality: 'IND', passportNumber: 'Z1234567', documentExpiryDate: '2031-05-30' }, TODAY);
    expect(w).toEqual([]);
  });

  it('warns about expired documents and documents expiring within six months', () => {
    const at = (expiry: Date) => buildWarnings(extractDocument(passport({ expiry: mrzDate(expiry) }), { today: TODAY }), null, TODAY);
    const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
    expect(at(day('2026-06-14'))).toEqual([expect.objectContaining({ code: 'DOCUMENT_EXPIRED', severity: 'HIGH', field: 'expiryDate', message: 'The document appears to have expired on 2026-06-14.' })]);
    expect(codes(at(day('2026-06-15')))).toEqual(['DOCUMENT_EXPIRING_SOON']); // expires today: not yet expired
    expect(at(day('2026-06-16'))[0].message).toContain('1 day left');
    expect(codes(at(day('2026-12-15')))).toEqual(['DOCUMENT_EXPIRING_SOON']); // exactly six months
    expect(codes(at(day('2026-12-16')))).toEqual([]);
    expect(at(day('2026-09-01'))[0]).toMatchObject({ severity: 'MEDIUM', field: 'expiryDate' });
    // Month ends are handled: six months after 31 August is the end of February.
    const endOfAugust = new Date('2026-08-31T12:00:00Z');
    const feb = (d: string) => codes(buildWarnings(extractDocument(passport({ expiry: d }), { today: endOfAugust }), null, endOfAugust));
    expect(feb('270228')).toEqual(['DOCUMENT_EXPIRING_SOON']);
    expect(feb('270301')).toEqual([]);
  });

  it('reports check-digit failures as high severity, on the right field', () => {
    const damaged = [ICAO_TD3[0], 'L898902C46UTO7408122F1204159ZE184226B<<<<<10'].join('\n');
    const w = buildWarnings(extractDocument(damaged, { today: new Date('2011-01-01T00:00:00Z') }), null, new Date('2011-01-01T00:00:00Z'));
    expect(w.filter((x) => x.severity === 'HIGH').map((x) => [x.code, x.field])).toEqual([['CHECK_DIGIT_MISMATCH', 'passportNumber'], ['COMPOSITE_CHECK_MISMATCH', undefined]]);
    expect(w.find((x) => x.code === 'LOW_CONFIDENCE')).toMatchObject({ field: 'passportNumber', severity: 'LOW' });
    // Most severe first.
    expect(w.map((x) => x.severity)).toEqual([...w.map((x) => x.severity)].sort((a, b) => 'HML'.indexOf(a[0]) - 'HML'.indexOf(b[0])));
  });

  it('compares with the customer profile and suggests corrections without repeating any value', () => {
    const e = extractDocument(passport(), { today: TODAY });
    const onFile = { fullName: 'Priya Sharma', dateOfBirth: '1990-02-15', nationality: 'PAK', passportNumber: 'Z7654321', documentExpiryDate: '2030-01-01' };
    const w = buildWarnings(e, onFile, TODAY);
    expect(w.map((x) => [x.code, x.severity, x.field, x.suggestion?.target])).toEqual([
      ['NAME_MISMATCH', 'HIGH', 'fullName', 'customer.fullName'],
      ['DATE_OF_BIRTH_MISMATCH', 'HIGH', 'dateOfBirth', 'customer.dateOfBirth'],
      ['DOCUMENT_NUMBER_MISMATCH', 'HIGH', 'passportNumber', 'customer.passportNo'],
      ['EXPIRY_DATE_MISMATCH', 'MEDIUM', 'expiryDate', 'document.expiryDate'],
      ['NATIONALITY_MISMATCH', 'MEDIUM', 'nationality', 'customer.nationality'],
    ]);
    // Suggestions point at the extracted field; warning texts never contain profile data or identity numbers.
    const text = JSON.stringify(w);
    for (const secret of ['Priya', 'Sharma', 'Z7654321', 'Z1234567', '1990-02-15', 'PAK']) expect(text).not.toContain(secret);
    expect(w.every((x) => !x.suggestion || x.suggestion.fieldKey === x.field)).toBe(true);
  });

  it('distinguishes a partial name match and values that are simply not on file yet', () => {
    const e = extractDocument(passport(), { today: TODAY });
    const w = buildWarnings(e, { fullName: 'Rahul Sampleson', dateOfBirth: null, passportNumber: null, nationality: null }, TODAY);
    expect(w.map((x) => [x.code, x.severity, x.field])).toEqual([
      ['NAME_PARTIAL_MATCH', 'LOW', 'fullName'],
      ['NOT_ON_FILE', 'LOW', 'dateOfBirth'],
      ['NOT_ON_FILE', 'LOW', 'passportNumber'],
      ['NOT_ON_FILE', 'LOW', 'expiryDate'],
    ]);
    // No profile at all (e.g. a company document): no comparison warnings.
    expect(buildWarnings(e, null, TODAY)).toEqual([]);
  });

  it('checks the Emirates ID number against the profile and reports missing fields', () => {
    const eid = emiratesIdFrom('78419901234567');
    const other = emiratesIdFrom('78419907654321');
    const back = buildTd1({ docCode: 'IL', issuing: 'ARE', number: '123456789', optional1: eid, dob: '900214', sex: 'M', expiry: mrzDate(daysFromNow(900)), nationality: 'IND', surname: 'Sampleson', given: 'Rahul Kumar' });
    const e = extractDocument(back.join('\n'));
    expect(codes(buildWarnings(e, { emiratesIdNumber: formatEmiratesId(eid), fullName: 'Rahul Kumar Sampleson', dateOfBirth: '1990-02-14', documentExpiryDate: isoDate(daysFromNow(900)) }))).toEqual([]);
    expect(buildWarnings(e, { emiratesIdNumber: other, fullName: 'Rahul Kumar Sampleson', dateOfBirth: '1990-02-14', documentExpiryDate: isoDate(daysFromNow(900)) }).map((x) => [x.code, x.field])).toEqual([['DOCUMENT_NUMBER_MISMATCH', 'emiratesIdNumber']]);

    const unreadable = extractDocument('UNITED ARAB EMIRATES\nIdentity Card\nEmirates ID\nName: Rahul Sampleson', { hint: 'EMIRATES_ID' });
    const w = buildWarnings(unreadable, null);
    expect(w.filter((x) => x.code === 'MISSING_FIELD').map((x) => x.field)).toEqual(['emiratesIdNumber', 'expiryDate']);
    expect(w.every((x) => x.severity !== 'HIGH')).toBe(true);
  });
});
