import { classifyDocument, extractDocument, findDates, findEmiratesIds, formatEmiratesId, luhnValid, valueAfterLabel } from './extractors';
import { buildTd1, buildTd3, emiratesIdFrom, ICAO_TD1, ICAO_TD3, passportPageText } from './fixtures';
import { parseTd3 } from './mrz';

const TODAY = new Date('2026-06-15T00:00:00Z');
const byKey = (fields: Array<{ key: string; value: string }>) => Object.fromEntries(fields.map((f) => [f.key, f.value]));
const conf = (fields: Array<{ key: string; confidence: number }>, key: string) => fields.find((f) => f.key === key)?.confidence;

describe('date recognition', () => {
  it('recognises dd/mm/yyyy, yyyy-mm-dd and dd MMM yyyy', () => {
    const text = 'Issued 05/03/2024, valid until 2027-03-04. Born 12 Aug 1974; renewed 3 SEPTEMBER 2025 and 07.11.2023, also 1-2-2021 and 12-MAR-2030.';
    expect(findDates(text).map((d) => d.iso)).toEqual(['2024-03-05', '2027-03-04', '1974-08-12', '2025-09-03', '2023-11-07', '2021-02-01', '2030-03-12']);
  });

  it('reads day first (UAE convention) and flags dates that could be month first', () => {
    expect(findDates('05/03/2024')[0]).toMatchObject({ iso: '2024-03-05', ambiguous: true });
    expect(findDates('25/03/2024')[0]).toMatchObject({ iso: '2024-03-25', ambiguous: false });
    expect(findDates('03/25/2024')[0]).toMatchObject({ iso: '2024-03-25', ambiguous: false }); // cannot be day 3 of month 25
    expect(findDates('07/07/2024')[0]).toMatchObject({ iso: '2024-07-07', ambiguous: false });
  });

  it('ignores impossible dates and numbers that only look like dates', () => {
    expect(findDates('31/02/2024 and 2024-13-01 and 00/01/2024 and 32 JAN 2024 and 29/02/2023')).toEqual([]);
    expect(findDates('29/02/2024')[0].iso).toBe('2024-02-29');
    expect(findDates('Ref 123/45/20245 phone 04-123-4567 licence 784-1990-1234567-1')).toEqual([]);
    expect(findDates('12 XYZ 2024')).toEqual([]);
    expect(findDates('01/01/1850 or 01/01/2200')).toEqual([]);
  });

  it('does not report the same characters twice', () => {
    const found = findDates('2027-03-04');
    expect(found).toHaveLength(1);
    expect(findDates('12-03-2027 2027-03-12').map((d) => d.iso)).toEqual(['2027-03-12', '2027-03-12']);
  });
});

describe('Emirates ID number', () => {
  const valid = emiratesIdFrom('78419901234567');

  it('validates the Luhn check digit', () => {
    expect(valid).toHaveLength(15);
    expect(luhnValid(valid)).toBe(true);
    expect(luhnValid('4539578763621486')).toBe(true); // well-known Luhn test number
    expect(luhnValid('79927398713')).toBe(true);
    expect(luhnValid('79927398710')).toBe(false);
    expect(luhnValid(valid.slice(0, 14) + ((Number(valid[14]) + 1) % 10))).toBe(false);
    expect(luhnValid('')).toBe(false);
    expect(luhnValid('7841990A234567')).toBe(false);
    expect(formatEmiratesId(valid)).toBe(`784-1990-1234567-${valid[14]}`);
  });

  it('finds the number with or without separators', () => {
    const formatted = formatEmiratesId(valid);
    for (const text of [`ID Number ${formatted}`, `رقم الهوية ${valid}`, `ID Number: ${formatted.replace(/-/g, ' ')}`, `784 - 1990 - 1234567 - ${valid[14]}`.replace(/ - /g, '-')]) {
      expect(findEmiratesIds(text)).toEqual([{ digits: valid, formatted, luhnValid: true, repaired: false }]);
    }
  });

  it('reads look-alike letters as digits and says so', () => {
    const misread = formatEmiratesId(valid).replace('1990', 'I99O');
    expect(findEmiratesIds(`ID Number ${misread}`)).toEqual([{ digits: valid, formatted: formatEmiratesId(valid), luhnValid: true, repaired: true }]);
  });

  it('returns a number that fails the check digit, flagged, and ignores other digit runs', () => {
    const wrong = valid.slice(0, 14) + ((Number(valid[14]) + 1) % 10);
    expect(findEmiratesIds(`ID ${wrong}`)).toEqual([expect.objectContaining({ digits: wrong, luhnValid: false })]);
    expect(findEmiratesIds('Phone 971501234567890, account 785199012345671, ref 7841990123456')).toEqual([]);
    expect(findEmiratesIds(`A${valid}`)).toEqual([]); // part of a longer token
    expect(findEmiratesIds(`${valid}9`)).toEqual([]);
    // When several candidates are present, valid ones come first.
    expect(findEmiratesIds(`${wrong}\n${valid}`).map((i) => i.luhnValid)).toEqual([true, false]);
  });
});

describe('labelled values', () => {
  it('takes the rest of the line or the next line, dropping Arabic text and separators', () => {
    expect(valueAfterLabel('Name: Sample Person One', /\bname\b/i)).toBe('Sample Person One');
    expect(valueAfterLabel('Nationality / الجنسية :  India', /nationality/i)).toBe('India');
    expect(valueAfterLabel('Licence No.\n\n  CN-1234567', /licen[cs]e no\.?/i)).toBe('CN-1234567');
    expect(valueAfterLabel('Something else', /name/i)).toBeNull();
    expect(valueAfterLabel('Name:\n\n\n\nToo far away', /name/i)).toBeNull();
  });
});

describe('classification', () => {
  it('recognises a passport from its machine readable zone', () => {
    expect(classifyDocument(passportPageText(ICAO_TD3))).toEqual({ classification: 'PASSPORT', confidence: 0.99 });
    // Check digits failing: still a passport, but less certain.
    const damaged = [ICAO_TD3[0], 'L898902C46UTO7408122F1204159ZE184226B<<<<<10'];
    const c = classifyDocument(damaged.join('\n'));
    expect(c.classification).toBe('PASSPORT');
    expect(c.confidence).toBeLessThan(0.9);
  });

  it('recognises an Emirates ID from the back (MRZ) or the front (number + wording)', () => {
    const eid = emiratesIdFrom('78419851234567');
    const back = buildTd1({ docCode: 'IL', issuing: 'ARE', number: '087654321', optional1: eid, dob: '850101', sex: 'F', expiry: '290101', nationality: 'PHL', surname: 'Sampleton', given: 'Maria' });
    expect(classifyDocument(back.join('\n'))).toEqual({ classification: 'EMIRATES_ID', confidence: 0.98 });
    const front = `UNITED ARAB EMIRATES\nFederal Authority for Identity\nIdentity Card\nID Number ${formatEmiratesId(eid)}\nName: Maria Sampleton`;
    expect(classifyDocument(front)).toEqual({ classification: 'EMIRATES_ID', confidence: 0.9 });
    expect(classifyDocument(`ID Number ${formatEmiratesId(eid)}`).classification).toBe('EMIRATES_ID');
  });

  it('recognises a trade licence from its wording', () => {
    const text = 'GOVERNMENT OF DUBAI\nDepartment of Economy and Tourism\nCommercial License\nLicense No. 1234567\nTrade Name  SAMPLE TRADING L.L.C\nLegal Type Limited Liability Company\nActivities: General Trading';
    const c = classifyDocument(text);
    expect(c).toEqual({ classification: 'TRADE_LICENCE', confidence: 0.75 });
  });

  it('answers UNKNOWN rather than guessing', () => {
    expect(classifyDocument('')).toEqual({ classification: 'UNKNOWN', confidence: 0 });
    expect(classifyDocument('TENANCY CONTRACT\nLandlord: Sample Properties\nAnnual rent AED 60,000')).toEqual({ classification: 'UNKNOWN', confidence: 0 });
    // A foreign identity card has an MRZ but is none of the supported classes.
    expect(classifyDocument(ICAO_TD1.join('\n')).classification).toBe('UNKNOWN');
    // One weak keyword is not enough.
    expect(classifyDocument('Please bring your passport to the counter.').classification).toBe('UNKNOWN');
    // A visa page that mentions a passport and a licence equally: no winner.
    expect(classifyDocument('Passport details\nLicense No. 5').classification).toBe('UNKNOWN');
  });
});

describe('extraction pipeline', () => {
  it('extracts passport fields from the MRZ with check-digit backed confidence', () => {
    const e = extractDocument(passportPageText(ICAO_TD3), { today: TODAY, ocrConfidence: 0.7 });
    expect(e.classification).toBe('PASSPORT');
    expect(e.profile).toBe('PASSPORT');
    expect(byKey(e.fields)).toEqual({
      passportNumber: 'L898902C3', fullName: 'ANNA MARIA ERIKSSON', surname: 'ERIKSSON', givenNames: 'ANNA MARIA', nationality: 'UTO', issuingState: 'UTO',
      dateOfBirth: '1974-08-12', sex: 'F', issueDate: '2022-04-16', expiryDate: '2012-04-15', personalNumber: 'ZE184226B',
    });
    expect(e.fields.filter((f) => f.key !== 'issueDate').every((f) => f.source === 'MRZ')).toBe(true);
    expect(conf(e.fields, 'passportNumber')).toBe(0.99);
    // The printed issue date has no check digit: it is scaled by how well the page was recognised.
    expect(e.fields.find((f) => f.key === 'issueDate')).toMatchObject({ source: 'TEXT', confidence: 0.42 });
    expect(e.issues).toEqual([]);
  });

  it('matches the parser output field for field', () => {
    const [l1, l2] = buildTd3({ issuing: 'IND', surname: 'Sampleson', given: 'Rahul Kumar', number: 'Z1234567', nationality: 'IND', dob: '900214', sex: 'M', expiry: '310530' });
    const mrz = parseTd3(l1, l2, TODAY);
    const e = extractDocument([l1, l2].join('\n'), { today: TODAY });
    expect(byKey(e.fields)).toMatchObject({ passportNumber: mrz.fields.documentNumber.value, dateOfBirth: '1990-02-14', expiryDate: '2031-05-30', fullName: 'RAHUL KUMAR SAMPLESON', nationality: 'IND' });
    expect(e.fields.some((f) => f.key === 'personalNumber')).toBe(false); // absent, not invented
  });

  it('carries check-digit problems through as issues and low confidence', () => {
    const damaged = [ICAO_TD3[0], 'L898902C46UTO7408122F1204159ZE184226B<<<<<10'].join('\n');
    const e = extractDocument(damaged, { today: TODAY });
    expect(conf(e.fields, 'passportNumber')).toBe(0.3);
    expect(conf(e.fields, 'dateOfBirth')).toBe(0.99);
    expect(e.issues.map((i) => [i.code, i.field])).toEqual(expect.arrayContaining([['CHECK_DIGIT_MISMATCH', 'passportNumber'], ['COMPOSITE_CHECK_MISMATCH', undefined]]));
  });

  it('extracts the back of an Emirates ID, validating the identity number twice', () => {
    const eid = emiratesIdFrom('78419901234567');
    const back = buildTd1({ docCode: 'IL', issuing: 'ARE', number: '123456789', optional1: eid, dob: '900214', sex: 'M', expiry: '280930', nationality: 'IND', surname: 'Sampleson', given: 'Rahul Kumar' });
    const e = extractDocument(back.join('\n'), { today: TODAY });
    expect(e.classification).toBe('EMIRATES_ID');
    expect(byKey(e.fields)).toEqual({
      emiratesIdNumber: formatEmiratesId(eid), cardNumber: '123456789', fullName: 'RAHUL KUMAR SAMPLESON', surname: 'SAMPLESON', givenNames: 'RAHUL KUMAR',
      nationality: 'IND', issuingState: 'ARE', dateOfBirth: '1990-02-14', sex: 'M', expiryDate: '2028-09-30',
    });
    expect(conf(e.fields, 'emiratesIdNumber')).toBe(0.95);
    expect(e.issues).toEqual([]);

    // An identity number that passes the MRZ composite check but not its own Luhn digit.
    const badEid = eid.slice(0, 14) + ((Number(eid[14]) + 1) % 10);
    const bad = buildTd1({ docCode: 'IL', issuing: 'ARE', number: '123456789', optional1: badEid, dob: '900214', sex: 'M', expiry: '280930', nationality: 'IND', surname: 'Sampleson', given: 'Rahul Kumar' });
    const b = extractDocument(bad.join('\n'), { today: TODAY });
    expect(conf(b.fields, 'emiratesIdNumber')).toBe(0.3);
    expect(b.issues.map((i) => i.code)).toEqual(['EMIRATES_ID_CHECK_FAILED']);
  });

  it('extracts the front of an Emirates ID from labelled text with moderate confidence', () => {
    const eid = emiratesIdFrom('78419851234567');
    const front = [
      'UNITED ARAB EMIRATES   الإمارات العربية المتحدة', 'Identity Card   بطاقة الهوية', `ID Number / رقم الهوية  ${formatEmiratesId(eid)}`, 'Name: Maria Sampleton',
      'Nationality: Philippines', 'Date of Birth 01/02/1985', 'Issuing Date 20/03/2024', 'Expiry Date 19/03/2029', 'Sex: F',
    ].join('\n');
    const e = extractDocument(front, { today: TODAY });
    expect(e.classification).toBe('EMIRATES_ID');
    expect(byKey(e.fields)).toEqual({ emiratesIdNumber: formatEmiratesId(eid), fullName: 'MARIA SAMPLETON', nationality: 'PHL', dateOfBirth: '1985-02-01', sex: 'F', issueDate: '2024-03-20', expiryDate: '2029-03-19' });
    expect(conf(e.fields, 'emiratesIdNumber')).toBe(0.9);
    expect(conf(e.fields, 'fullName')).toBe(0.6);
    expect(conf(e.fields, 'dateOfBirth')).toBe(0.45); // 01/02 could be read either way
    expect(conf(e.fields, 'expiryDate')).toBe(0.6);
    expect(e.fields.every((f) => f.source === 'TEXT')).toBe(true);
    expect(e.issues).toEqual([]);
    // A nationality we cannot map to a code is left out instead of being stored as free text.
    const odd = extractDocument(front.replace('Philippines', 'Republic of Elsewhere'), { today: TODAY });
    expect(odd.fields.some((f) => f.key === 'nationality')).toBe(false);
  });

  it('extracts trade licence fields with deliberately low confidence', () => {
    const text = [
      'GOVERNMENT OF DUBAI', 'Department of Economy and Tourism', 'Commercial License', 'License No. : 1234567', 'Trade Name : SAMPLE GENERAL TRADING L.L.C',
      'Legal Type : Limited Liability Company', 'Issue Date : 02/01/2025', 'Expiry Date : 01/01/2027', 'Activities: General Trading',
    ].join('\n');
    const e = extractDocument(text, { today: TODAY });
    expect(e.classification).toBe('TRADE_LICENCE');
    expect(byKey(e.fields)).toEqual({ licenceNumber: '1234567', companyName: 'SAMPLE GENERAL TRADING L.L.C', issueDate: '2025-01-02', expiryDate: '2027-01-01' });
    expect(e.fields.every((f) => f.source === 'HEURISTIC' && f.confidence <= 0.5)).toBe(true);
    expect(e.issues).toEqual([]);
  });

  it('reports expected fields it could not read instead of filling them in', () => {
    const e = extractDocument('TRADE LICENSE\nCommercial License\nDepartment of Economic Development\nTrade Name: Sample Cafe', { today: TODAY });
    expect(e.classification).toBe('TRADE_LICENCE');
    expect(byKey(e.fields)).toEqual({ companyName: 'Sample Cafe' });
    expect(e.issues.map((i) => [i.code, i.field])).toEqual([['MISSING_FIELD', 'licenceNumber'], ['MISSING_FIELD', 'expiryDate']]);

    // An unreadable scan uploaded as a passport: every expected field is reported missing.
    const blank = extractDocument('~~ .. ,,', { hint: 'PASSPORT', today: TODAY });
    expect(blank).toMatchObject({ classification: 'UNKNOWN', classificationConfidence: 0, profile: 'PASSPORT', fields: [] });
    expect(blank.issues.map((i) => i.field)).toEqual(['passportNumber', 'fullName', 'nationality', 'dateOfBirth', 'expiryDate']);
    // Nothing at all without a hint.
    expect(extractDocument('', { today: TODAY })).toMatchObject({ classification: 'UNKNOWN', profile: 'UNKNOWN', fields: [], issues: [] });
  });

  it('uses the upload hint when the text does not reveal the class, and flags a contradiction', () => {
    const licence = extractDocument('Licence Number 99-887766\nValid until 31 Dec 2026', { hint: 'TRADE_LICENCE', today: TODAY });
    expect(licence.classification).toBe('UNKNOWN');
    expect(byKey(licence.fields)).toEqual({ licenceNumber: '99-887766', expiryDate: '2026-12-31' });
    const mismatch = extractDocument(passportPageText(ICAO_TD3), { hint: 'EMIRATES_ID', today: TODAY });
    expect(mismatch.classification).toBe('PASSPORT');
    expect(mismatch.issues.map((i) => i.code)).toEqual(['CLASSIFICATION_MISMATCH']);
    expect(byKey(mismatch.fields).passportNumber).toBe('L898902C3');
  });

  it('shows the check-digit protected values of an identity card it has no profile for', () => {
    const e = extractDocument(ICAO_TD1.join('\n'), { today: TODAY });
    expect(e.classification).toBe('UNKNOWN');
    expect(byKey(e.fields)).toMatchObject({ cardNumber: 'D23145890', dateOfBirth: '1974-08-12', expiryDate: '2012-04-15', fullName: 'ANNA MARIA ERIKSSON' });
  });

  it('parses the public German specimen passport (Mustermann)', () => {
    const lines = ['P<D<<MUSTERMANN<<ERIKA<<<<<<<<<<<<<<<<<<<<<<', 'C01X00T478D<<6408125F2702283<<<<<<<<<<<<<<<4'];
    const e = extractDocument(lines.join('\n'), { today: TODAY });
    expect(e.classification).toBe('PASSPORT');
    expect(byKey(e.fields)).toMatchObject({ passportNumber: 'C01X00T47', nationality: 'D', issuingState: 'D', fullName: 'ERIKA MUSTERMANN', dateOfBirth: '1964-08-12', expiryDate: '2027-02-28', sex: 'F' });
    expect(e.issues).toEqual([]);
  });
});
