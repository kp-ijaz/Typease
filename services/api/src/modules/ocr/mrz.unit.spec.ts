import { buildTd1, buildTd3, emiratesIdFrom, ICAO_TD1, ICAO_TD3 } from './fixtures';
import { expandMrzDate, findMrz, mrzCharValue, mrzCheckDigit, normaliseMrzLine, parseTd1, parseTd3, repairTrailingFillers } from './mrz';

const TODAY = new Date('2026-06-15T00:00:00Z');
const values = (r: ReturnType<typeof parseTd3>) => Object.fromEntries(Object.entries(r.fields).map(([k, f]) => [k, f.value]));

describe('MRZ check digits (ICAO 9303 part 3)', () => {
  it('values characters and computes the 7-3-1 check digit', () => {
    expect([mrzCharValue('0'), mrzCharValue('9'), mrzCharValue('A'), mrzCharValue('Z'), mrzCharValue('<')]).toEqual([0, 9, 10, 35, 0]);
    // Published ICAO specimen values.
    expect(mrzCheckDigit('L898902C3')).toBe('6');
    expect(mrzCheckDigit('740812')).toBe('2');
    expect(mrzCheckDigit('120415')).toBe('9');
    expect(mrzCheckDigit('ZE184226B<<<<<')).toBe('1');
    expect(mrzCheckDigit('D23145890')).toBe('7');
    expect(mrzCheckDigit('')).toBe('0');
    expect(mrzCheckDigit('<<<<<<<<<<<<<<')).toBe('0');
  });

  it('expands two-digit years: births are in the past, expiry dates are near the present', () => {
    expect(expandMrzDate('740812', 'birth', TODAY)).toBe('1974-08-12');
    expect(expandMrzDate('250101', 'birth', TODAY)).toBe('2025-01-01');
    expect(expandMrzDate('260616', 'birth', TODAY)).toBe('1926-06-16'); // tomorrow is not a birth date
    expect(expandMrzDate('260615', 'birth', TODAY)).toBe('2026-06-15');
    expect(expandMrzDate('120415', 'expiry', TODAY)).toBe('2012-04-15');
    expect(expandMrzDate('340101', 'expiry', TODAY)).toBe('2034-01-01');
    expect(expandMrzDate('990101', 'expiry', TODAY)).toBe('1999-01-01'); // 2099 would be 73 years ahead
    expect(expandMrzDate('240229', 'expiry', TODAY)).toBe('2024-02-29');
    for (const bad of ['250230', '251301', '250100', '25010', '2501011', 'ABCDEF', '<<<<<<']) expect(expandMrzDate(bad, 'expiry', TODAY)).toBeNull();
    expect(expandMrzDate('000229', 'birth', TODAY)).toBe('2000-02-29');
    expect(expandMrzDate('270229', 'birth', TODAY)).toBeNull(); // neither 2027 nor 1927 is a leap year
  });
});

describe('TD3: passports (2 x 44)', () => {
  it('parses the ICAO specimen with every check digit valid', () => {
    const r = parseTd3(ICAO_TD3[0], ICAO_TD3[1], TODAY);
    expect(r.format).toBe('TD3');
    expect(r.documentCode).toBe('P');
    expect(values(r)).toEqual({
      documentNumber: 'L898902C3', issuingState: 'UTO', nationality: 'UTO', surname: 'ERIKSSON', givenNames: 'ANNA MARIA',
      dateOfBirth: '1974-08-12', sex: 'F', expiryDate: '2012-04-15', optionalData: 'ZE184226B', optionalData2: null,
    });
    expect(r.valid).toBe(true);
    expect([r.checksPassed, r.checksTotal]).toEqual([5, 5]);
    expect(r.compositeCheck).toEqual({ expected: '0', found: '0', valid: true });
    expect(r.fields.documentNumber.check).toEqual({ expected: '6', found: '6', valid: true });
    expect(r.issues).toEqual([]);
    for (const key of ['documentNumber', 'dateOfBirth', 'expiryDate', 'optionalData'] as const) expect(r.fields[key].confidence).toBeGreaterThanOrEqual(0.97);
    // Names and country codes have no check digit of their own: slightly lower.
    expect(r.fields.surname.confidence).toBe(0.9);
    expect(r.fields.nationality.confidence).toBe(0.92);
  });

  it('accepts an empty personal number with a filler or zero check digit', () => {
    const [l1, l2] = buildTd3({ issuing: 'UTO', surname: 'Sample', given: 'Person One', number: 'X1234567', nationality: 'UTO', dob: '900101', sex: 'M', expiry: '300101' });
    expect(l2[42]).toBe('<');
    const r = parseTd3(l1, l2, TODAY);
    expect(r.valid).toBe(true);
    expect(r.fields.documentNumber.value).toBe('X1234567'); // shorter than nine characters: fillers removed
    expect(r.fields.optionalData.value).toBeNull();
    expect(r.fields.sex.value).toBe('M');
    const withZero = l2.slice(0, 42) + '0' + l2[43];
    expect(parseTd3(l1, withZero, TODAY).valid).toBe(true);
  });

  it('handles a surname-only holder, an unspecified sex and long truncated names', () => {
    const single = buildTd3({ issuing: 'UTO', surname: 'Mononym', given: '', number: 'A0000001', nationality: 'UTO', dob: '850505', sex: '<', expiry: '290909' });
    const r = parseTd3(single[0], single[1], TODAY);
    expect([r.fields.surname.value, r.fields.givenNames.value, r.fields.sex.value]).toEqual(['MONONYM', null, 'X']);
    const long = buildTd3({ issuing: 'UTO', surname: 'Verylongfamilyname Withtwoparts', given: 'Firstname Secondname', number: 'A0000002', nationality: 'UTO', dob: '850505', sex: 'F', expiry: '290909' });
    const t = parseTd3(long[0], long[1], TODAY);
    expect(t.fields.surname.value).toBe('VERYLONGFAMILYNAME WITHTWOPARTS');
    expect(t.issues.map((i) => i.code)).toContain('NAME_POSSIBLY_TRUNCATED');
    expect(t.fields.givenNames.confidence).toBe(0.75);
    expect(t.valid).toBe(true); // truncation is a note, not a check failure
  });

  it('drops confidence sharply and reports the field when a check digit fails', () => {
    // Document number changed by a non-look-alike character: cannot be repaired.
    const tampered = 'L898902C4' + ICAO_TD3[1].slice(9);
    const r = parseTd3(ICAO_TD3[0], tampered, TODAY);
    expect(r.valid).toBe(false);
    expect(r.fields.documentNumber.value).toBe('L898902C4'); // returned as read, never "fixed" by guessing
    expect(r.fields.documentNumber.check).toEqual({ expected: '7', found: '6', valid: false });
    expect(r.fields.documentNumber.confidence).toBe(0.3);
    expect(r.issues.map((i) => [i.code, i.field])).toEqual(expect.arrayContaining([['CHECK_DIGIT_MISMATCH', 'documentNumber'], ['COMPOSITE_CHECK_MISMATCH', undefined]]));
    // The other fields still validate and keep their confidence; unchecked ones are discounted.
    expect(r.fields.dateOfBirth.confidence).toBe(0.99);
    expect(r.fields.surname.confidence).toBe(0.72);
    expect([r.checksPassed, r.checksTotal]).toEqual([3, 5]);

    const badDate = ICAO_TD3[1].slice(0, 13) + '740813' + ICAO_TD3[1].slice(19);
    const d = parseTd3(ICAO_TD3[0], badDate, TODAY);
    expect(d.fields.dateOfBirth).toMatchObject({ value: '1974-08-13', confidence: 0.3 });
    expect(d.fields.documentNumber.confidence).toBe(0.99);
    const impossible = ICAO_TD3[1].slice(0, 21) + '121345' + ICAO_TD3[1].slice(27);
    const e = parseTd3(ICAO_TD3[0], impossible, TODAY);
    expect(e.fields.expiryDate).toMatchObject({ value: null, confidence: 0 });
    expect(e.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['INVALID_DATE', 'CHECK_DIGIT_MISMATCH']));
  });

  describe('OCR confusions', () => {
    it('normalises digits and letters by position (O/0, I/1, B/8, S/5 ...)', () => {
      // Letters read where only digits can stand: date of birth, expiry, check digits.
      const l2 = 'L898902C36UTO74O8I22FI2O4I59ZE184226B<<<<<1O';
      const r = parseTd3(ICAO_TD3[0], l2, TODAY);
      expect(r.valid).toBe(true);
      expect([r.fields.dateOfBirth.value, r.fields.expiryDate.value]).toEqual(['1974-08-12', '2012-04-15']);
      expect(r.fields.dateOfBirth.corrected).toBe(true);
      expect(r.fields.dateOfBirth.confidence).toBe(0.97);
      // Digits read where only letters can stand: names and country codes.
      const l1 = 'P<UT0ER1KSS0N<<ANNA<MAR1A<<<<<<<<<<<<<<<<<<<';
      const n = parseTd3(l1, ICAO_TD3[1].replace('UTO', 'UT0'), TODAY);
      expect([n.fields.issuingState.value, n.fields.nationality.value, n.fields.surname.value, n.fields.givenNames.value]).toEqual(['UTO', 'UTO', 'ERIKSSON', 'ANNA MARIA']);
    });

    it('repairs an out-of-place look-alike character only when the check digit proves it', () => {
      for (const misread of ['L8989O2C3', 'LB98902C3', 'L89B902C3', 'L89890ZC3']) {
        const r = parseTd3(ICAO_TD3[0], misread + ICAO_TD3[1].slice(9), TODAY);
        expect([misread, r.fields.documentNumber.value, r.valid]).toEqual([misread, 'L898902C3', true]);
        // Marked and scored lower than a value that validated as read.
        expect(r.fields.documentNumber).toMatchObject({ corrected: true, confidence: 0.8 });
        expect(r.issues.map((i) => i.code)).toEqual(['CHARACTER_REPAIRED']);
      }
      // "5" read as "S" in the personal number.
      const [l1, l2] = buildTd3({ issuing: 'UTO', surname: 'Sample', given: 'Person', number: 'AB1205', nationality: 'UTO', dob: '900101', sex: 'F', expiry: '300101', personal: '1985123456' });
      const misreadPersonal = l2.slice(0, 28) + '198S123456' + l2.slice(38);
      const p = parseTd3(l1, misreadPersonal, TODAY);
      expect(p.fields.optionalData).toMatchObject({ value: '1985123456', corrected: true });
      expect(p.valid).toBe(true);
      // "O" read as "0" between letters.
      const [m1, m2] = buildTd3({ issuing: 'UTO', surname: 'Sample', given: 'Person', number: 'ROM12345', nationality: 'UTO', dob: '900101', sex: 'F', expiry: '300101' });
      const o = parseTd3(m1, m2.replace('ROM12345', 'R0M12345'), TODAY);
      expect(o.fields.documentNumber).toMatchObject({ value: 'ROM12345', corrected: true });
    });

    it('leaves characters alone when they are not out of place, even if a swap would fit', () => {
      // The document number is wrong in a way no look-alike explains (3 read as 4). Its digits 8, 0 and 2
      // have look-alikes (B, O, Z) but sit among digits, so nothing is swapped to "make it fit".
      const number = 'L898902C4';
      const r = parseTd3(ICAO_TD3[0], number + ICAO_TD3[1].slice(9), TODAY);
      expect(r.fields.documentNumber).toMatchObject({ value: number, corrected: false, confidence: 0.3 });
    });

    it('does not guess when more than one repair would satisfy the check digit', () => {
      // Both letters O are out of place and sit on positions with the same weight: turning either one
      // into a zero yields the same check digit, so the check digit cannot tell which one was misread.
      const check = mrzCheckDigit('A000O0000');
      expect(mrzCheckDigit('AO0000000')).toBe(check);
      const asRead = 'AO00O0000';
      expect(mrzCheckDigit(asRead)).not.toBe(check);
      const rest = `UTO9001011M3001019${'<'.repeat(15)}`;
      const composite = mrzCheckDigit('A000O0000' + check + rest.slice(3, 10) + rest.slice(11, 33));
      const r = parseTd3(ICAO_TD3[0], asRead + check + rest + composite, TODAY);
      expect(r.fields.documentNumber).toMatchObject({ value: asRead, corrected: false, confidence: 0.3 });
      expect(r.fields.documentNumber.check!.valid).toBe(false);
      expect(r.issues.find((i) => i.field === 'documentNumber')!.message).toMatch(/more than one correction is possible/);
      expect(r.valid).toBe(false);
    });

    it('treats K read for the filler character as filler, without eating real letters', () => {
      expect(repairTrailingFillers('ERIKSSON<<ANNA<MARIA<<<KKKK<<<K<')).toBe('ERIKSSON<<ANNA<MARIA<<<<<<<<<<<<');
      expect(repairTrailingFillers('JACK<<<<<<')).toBe('JACK<<<<<<');
      expect(repairTrailingFillers('NOVAK<<MAREK<<<<')).toBe('NOVAK<<MAREK<<<<');
      expect(repairTrailingFillers('ANNA<K<<<<<')).toBe('ANNA<K<<<<<'); // an initial K stays
      expect(repairTrailingFillers('MARIAKKKKKK')).toBe('MARIA<<<<<<');
      expect(repairTrailingFillers('NOFILLERS')).toBe('NOFILLERS');

      // K has the value 20, and 20 x 7, 20 x 3 and 20 x 1 are all multiples of ten: a check digit
      // can never distinguish K from the filler. These repairs rest on plausibility and are marked.
      expect(mrzCheckDigit('ZE184226BKKKKK')).toBe(mrzCheckDigit('ZE184226B<<<<<'));

      const l1 = 'PKUTOERIKSSON<<ANNA<MARIA<<<<KKKKKKKK<<<KKKK';
      const l2 = 'L898902C36UTO7408122F1204159ZE184226BKKKKK10';
      const r = parseTd3(l1, l2, TODAY);
      expect(r.documentCode).toBe('P');
      expect(values(r)).toMatchObject({ documentNumber: 'L898902C3', surname: 'ERIKSSON', givenNames: 'ANNA MARIA', optionalData: 'ZE184226B' });
      expect(r.valid).toBe(true);
      expect(r.fields.optionalData).toMatchObject({ corrected: true, confidence: 0.8 });
      expect(r.issues.map((i) => [i.code, i.field])).toEqual([['FILLER_REPAIRED', 'givenNames'], ['FILLER_REPAIRED', 'optionalData']]);
      expect(r.fields.givenNames.confidence).toBe(0.8);

      // A run of three K at the end of a short document number, and an empty personal number read as K.
      const [a1, a2] = buildTd3({ issuing: 'UTO', surname: 'Novak', given: 'Marek', number: 'AB1234', nationality: 'UTO', dob: '900101', sex: 'M', expiry: '300101' });
      const kk = a2.replace('AB1234<<<', 'AB1234KKK').replace(/<{15}/, 'K'.repeat(15));
      const k = parseTd3(a1, kk, TODAY);
      expect(k.fields.documentNumber).toMatchObject({ value: 'AB1234', corrected: true, confidence: 0.8 });
      expect(k.fields.optionalData.value).toBeNull();
      expect(k.valid).toBe(true);
      expect(k.fields.surname.value).toBe('NOVAK');

      // One or two trailing K could be either: the value is left as read and flagged.
      const [b1, b2] = buildTd3({ issuing: 'UTO', surname: 'Novak', given: 'Marek', number: 'AB12345', nationality: 'UTO', dob: '900101', sex: 'M', expiry: '300101' });
      const two = parseTd3(b1, b2.replace('AB12345<<', 'AB12345KK'), TODAY);
      expect(two.fields.documentNumber).toMatchObject({ value: 'AB12345KK', corrected: false, confidence: 0.7 });
      expect(two.issues.map((i) => i.code)).toEqual(['TRAILING_K_AMBIGUOUS']);
      expect(two.valid).toBe(true); // every check digit is satisfied either way
    });

    it('flags names as uncertain when every filler was read as K', () => {
      const l1 = 'PKUTOERIKSSONKKANNAKMARIAKKKKKKKKKKKKKKKKKKK';
      const r = parseTd3(l1, ICAO_TD3[1], TODAY);
      expect(r.fields.surname.value).toBe('ERIKSSON');
      expect(r.fields.givenNames.value).toBe('ANNAKMARIA'); // the single K cannot be told from a letter
      expect(r.fields.givenNames.confidence).toBe(0.4);
      expect(r.issues.map((i) => i.code)).toContain('NAME_UNCERTAIN');
      // The check-digit protected line is unaffected.
      expect(r.fields.documentNumber.confidence).toBe(0.99);
    });

    it('maps chevron look-alikes and removes spaces and stray punctuation', () => {
      expect(normaliseMrzLine('P<UTO ERIKSSON«ANNA‹MARIA ‹‹‹')).toBe('P<UTOERIKSSON<<ANNA<MARIA<<<');
      expect(normaliseMrzLine(' l898902c3 6uto.7408122|F ')).toBe('L898902C36UTO7408122F');
    });
  });

  it('rejects lines of the wrong length', () => {
    expect(() => parseTd3('P<UTO', ICAO_TD3[1])).toThrow(/44/);
    expect(() => parseTd1(ICAO_TD1[0], ICAO_TD1[1], 'SHORT')).toThrow(/30/);
  });
});

describe('TD1: identity cards (3 x 30)', () => {
  it('parses the ICAO specimen with every check digit valid', () => {
    const r = parseTd1(ICAO_TD1[0], ICAO_TD1[1], ICAO_TD1[2], TODAY);
    expect(r.format).toBe('TD1');
    expect(r.documentCode).toBe('I');
    expect(values(r)).toEqual({
      documentNumber: 'D23145890', issuingState: 'UTO', nationality: 'UTO', surname: 'ERIKSSON', givenNames: 'ANNA MARIA',
      dateOfBirth: '1974-08-12', sex: 'F', expiryDate: '2012-04-15', optionalData: null, optionalData2: null,
    });
    expect(r.valid).toBe(true);
    expect(r.compositeCheck).toEqual({ expected: '6', found: '6', valid: true });
    expect([r.checksPassed, r.checksTotal]).toEqual([4, 4]);
  });

  it('parses the back of an (invented) Emirates ID: card number, identity number, dates, nationality', () => {
    const eid = emiratesIdFrom('78419901234567');
    const lines = buildTd1({ docCode: 'IL', issuing: 'ARE', number: '123456789', optional1: eid, dob: '900214', sex: 'M', expiry: '280930', nationality: 'IND', surname: 'Sampleson', given: 'Rahul Kumar' });
    const r = parseTd1(lines[0], lines[1], lines[2], TODAY);
    expect(r.valid).toBe(true);
    expect(r.documentCode).toBe('IL');
    expect(values(r)).toMatchObject({ documentNumber: '123456789', issuingState: 'ARE', nationality: 'IND', optionalData: eid, dateOfBirth: '1990-02-14', expiryDate: '2028-09-30', sex: 'M', surname: 'SAMPLESON', givenNames: 'RAHUL KUMAR' });
    expect(r.fields.optionalData.confidence).toBe(0.95);

    // Look-alike letters inside the identity number are read as digits because the field is numeric.
    const misread = lines[0].slice(0, 15) + eid.replace('0', 'O').replace('1', 'I') + '';
    const m = parseTd1(misread, lines[1], lines[2], TODAY);
    expect(m.fields.optionalData.value).toBe(eid);
    expect(m.valid).toBe(true);
    // A wrong digit there is caught by the composite check only.
    const wrong = lines[0].slice(0, 20) + (lines[0][20] === '9' ? '8' : '9') + lines[0].slice(21);
    const w = parseTd1(wrong, lines[1], lines[2], TODAY);
    expect(w.compositeCheck.valid).toBe(false);
    expect(w.fields.optionalData.confidence).toBe(0.4);
    expect(w.fields.documentNumber.check!.valid).toBe(true);
  });

  it('supports document numbers longer than nine characters (continued in the optional field)', () => {
    const number = 'D23145890734';
    const check = mrzCheckDigit(number);
    const line1 = `IDUTO${number.slice(0, 9)}<${number.slice(9)}${check}`.padEnd(30, '<');
    const partial = `800101${mrzCheckDigit('800101')}F311231${mrzCheckDigit('311231')}UTO${'<'.repeat(11)}`;
    const composite = mrzCheckDigit(line1.slice(5, 30) + partial.slice(0, 7) + partial.slice(8, 15) + partial.slice(18, 29));
    const r = parseTd1(line1, partial + composite, 'TESTER<<LONG<NUMBER<<<<<<<<<<<', TODAY);
    expect(r.fields.documentNumber.value).toBe(number);
    expect(r.fields.documentNumber.check!.valid).toBe(true);
    expect(r.valid).toBe(true);
    expect(r.documentCode).toBe('ID');
    expect(r.fields.optionalData.value).toBeNull();
  });

  it('reports failing check digits per field', () => {
    const r = parseTd1(ICAO_TD1[0].replace('D23145890', 'D23145899'), ICAO_TD1[1], ICAO_TD1[2], TODAY);
    expect(r.valid).toBe(false);
    expect(r.fields.documentNumber.confidence).toBe(0.3);
    expect(r.fields.expiryDate.confidence).toBe(0.99);
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['CHECK_DIGIT_MISMATCH', 'COMPOSITE_CHECK_MISMATCH']));
  });
});

describe('finding the MRZ in OCR text', () => {
  const page = (mrz: string[]) => ['UTOPIA', 'PASSPORT    Passeport', 'Surname  ERIKSSON', 'Given names Anna Maria', 'Date of birth 12 AUG 74     Sex F', '', ...mrz, ''].join('\n');

  it('finds a passport MRZ among the printed text', () => {
    const r = findMrz(page(ICAO_TD3), TODAY)!;
    expect(r.format).toBe('TD3');
    expect(r.valid).toBe(true);
    expect(r.fields.documentNumber.value).toBe('L898902C3');
  });

  it('finds an identity-card MRZ, also with Windows line endings and spaces inside the lines', () => {
    const spaced = ICAO_TD1.map((l) => l.replace(/(.{10})/g, '$1 '));
    const r = findMrz(`REPUBLIC OF UTOPIA\r\nIdentity card\r\n${spaced.join('\r\n')}\r\n`, TODAY)!;
    expect(r.format).toBe('TD1');
    expect(r.valid).toBe(true);
    expect(r.fields.documentNumber.value).toBe('D23145890');
  });

  it('realigns lines that lost or gained filler characters', () => {
    const shortName = ICAO_TD3[0].slice(0, 40); // four trailing fillers missing
    const lostFiller = ICAO_TD3[1].replace('B<<<<<1', 'B<<<<1'); // 43 characters
    const extraFiller = ICAO_TD3[1].replace('B<<<<<1', 'B<<<<<<1'); // 45 characters
    for (const l2 of [lostFiller, extraFiller]) {
      const r = findMrz([shortName, l2].join('\n'), TODAY)!;
      expect(r.valid).toBe(true);
      expect(r.fields.optionalData.value).toBe('ZE184226B');
      expect(r.issues.map((i) => i.code)).toEqual(['LINE_LENGTH_REPAIRED']);
    }
  });

  it('reads chevrons recognised as « and a zone recognised as one 88-character run', () => {
    const guillemets = ICAO_TD3.map((l) => l.replace(/<</g, '«'));
    expect(findMrz(guillemets.join('\n'), TODAY)!.valid).toBe(true);
    expect(findMrz(ICAO_TD3.join(''), TODAY)!.fields.surname.value).toBe('ERIKSSON');
  });

  it('returns null when there is no MRZ (nothing is invented)', () => {
    expect(findMrz('', TODAY)).toBeNull();
    expect(findMrz('TRADE LICENCE\nLicence No. 123456\nExpiry Date 01/01/2027', TODAY)).toBeNull();
    expect(findMrz('This is an ordinary paragraph of text that is longer than forty-four characters.\nAnd another one of similar length that contains 1234567890 digits.', TODAY)).toBeNull();
    // Two upper-case lines of the right length but with no valid check digit at all.
    expect(findMrz('PXABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQR\n1234567891ABC1234567X1234567ABCDEFGHIJKLMN99', TODAY)).toBeNull();
  });

  describe('output actually produced by Tesseract 5 for the rendered ICAO specimen (regression corpus)', () => {
    const NAME_OK = 'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<';
    const parse = (l1: string, l2: string) => findMrz(`${l1}\n${l2}\n`, TODAY);

    it('fillers after the name read as L, C and K', () => {
      for (const l1 of [
        'P<UTOERIKSSON<<ANNA<MARIA<<<<LLLLLLLLLLLLLLL',
        'P<UTOERIKSSON<<ANNA<MARIA<KKLLLLLLLLLLLLLLLKL',
        'P<UTOERIKSSON<<ANNA<MARIA<<CLCLLLLLLCLLLLLLLKL',
        'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<LLLLLLLLLLLL',
        'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<', // six fillers lost at the end
      ]) {
        const r = parse(l1, ICAO_TD3[1])!;
        expect([l1, r.fields.surname.value, r.fields.givenNames.value]).toEqual([l1, 'ERIKSSON', 'ANNA MARIA']);
        expect(r.fields.documentNumber).toMatchObject({ value: 'L898902C3', confidence: 0.99 });
        expect(r.checksPassed).toBe(5);
      }
    });

    it('a single letter between fillers is kept as read but flagged: it could be an initial', () => {
      const r = parse('P<UTOERIKSSON<<ANNA<MARIA<K<<<LLLLLLLLLLLLLLL', ICAO_TD3[1])!;
      expect(r.fields.givenNames).toMatchObject({ value: 'ANNA MARIA K', confidence: 0.6 });
      expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['NAME_UNCERTAIN']));
    });

    it('"UTO" read as "UT0" in the nationality', () => {
      const r = parse(NAME_OK, 'L898902C36UT07408122F1204159ZE184226B<<<<<10')!;
      expect(r.valid).toBe(true);
      expect(r.fields.nationality.value).toBe('UTO');
    });

    it('a stray character inserted into the data line is removed when all five check digits then agree', () => {
      for (const l2 of [
        'L898902C36UT07408122F12041597ZE184226B<<<<<10', // extra 7 after the expiry check digit
        'L898902C36UTO7408122F1204159Z2E184226B<<<<<10', // extra 2 inside the personal number
        'L898902C36UT0O7408122F1204159ZE184226B<<<<<10', // extra O after the nationality
      ]) {
        expect(l2).toHaveLength(45);
        const r = parse(NAME_OK, l2)!;
        expect([l2, r.valid]).toEqual([l2, true]);
        expect(Object.fromEntries(['documentNumber', 'nationality', 'dateOfBirth', 'expiryDate', 'optionalData'].map((k) => [k, (r.fields as any)[k].value]))).toEqual({
          documentNumber: 'L898902C3', nationality: 'UTO', dateOfBirth: '1974-08-12', expiryDate: '2012-04-15', optionalData: 'ZE184226B',
        });
        expect(r.issues.map((i) => i.code)).toEqual(['LINE_LENGTH_REPAIRED']);
      }
    });

    it('"Z" read as "2" at the start of the personal number is repaired; "Z" read as "7" is only flagged', () => {
      const two = parse(NAME_OK, 'L898902C36UTO7408122F12041592E184226B<<<<<10')!;
      expect(two.valid).toBe(true);
      expect(two.fields.optionalData).toMatchObject({ value: 'ZE184226B', corrected: true, confidence: 0.8 });

      const seven = parse(NAME_OK, 'L898902C36UT07408122F12041597E184226B<<<<<10')!;
      expect(seven.valid).toBe(false);
      expect(seven.fields.optionalData).toMatchObject({ value: '7E184226B', corrected: false, confidence: 0.3 });
      // The fields with their own check digit are unaffected.
      expect(seven.fields.documentNumber).toMatchObject({ value: 'L898902C3', confidence: 0.99 });
      expect(seven.fields.expiryDate.confidence).toBe(0.99);
      expect(seven.issues.map((i) => i.code)).toEqual(['CHECK_DIGIT_MISMATCH', 'COMPOSITE_CHECK_MISMATCH']);
    });

    it('"L" read as "1." passes the check digit (a limit of ICAO 9303); the stray "." lowers every confidence', () => {
      // L = 21 and 1 = 1 differ by 20, and the check digit works modulo 10: it cannot see this confusion.
      expect(mrzCheckDigit('1898902C3')).toBe(mrzCheckDigit('L898902C3'));
      const r = parse(NAME_OK, '1.898902C36UTO7408122F1204159ZE184226B<<<<<10')!;
      expect(r.fields.documentNumber.value).toBe('1898902C3');
      expect(r.fields.documentNumber.check!.valid).toBe(true);
      expect(r.fields.documentNumber.confidence).toBe(0.891);
      expect(r.fields.dateOfBirth.confidence).toBe(0.891);
      expect(r.issues.map((i) => i.code)).toEqual(['STRAY_CHARACTERS']);
      // The same line without the stray character gives no hint at all: only a person can catch it.
      expect(parse(NAME_OK, '1898902C36UTO7408122F1204159ZE184226B<<<<<10')!.fields.documentNumber.confidence).toBe(0.99);
    });

    it('a data line that lost its final check digits still yields the fields that validate', () => {
      const r = parse(NAME_OK, 'L898902C36UTO7408122F1204159ZE184226B<<<<<')!;
      expect(r.valid).toBe(false);
      expect(r.fields.documentNumber).toMatchObject({ value: 'L898902C3', confidence: 0.99 });
      expect(r.fields.dateOfBirth.value).toBe('1974-08-12');
      expect(r.issues.map((i) => i.code)).toContain('LINE_LENGTH_REPAIRED');
    });

    it('letters inserted into the name cannot be repaired and are returned as read', () => {
      const r = parse('P<UTOERIKSSON<<ANNA<MARTIA<LLLLLLLLLLLLLLLLL', ICAO_TD3[1])!;
      expect(r.fields.givenNames.value).toBe('ANNA MARTIA');
      expect(r.fields.documentNumber.value).toBe('L898902C3');
    });
  });

  it('prefers the candidate with more valid check digits', () => {
    const damagedCopy = ['P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<', 'L898902C46UTO7408132F1204158ZE184226B<<<<<10'];
    const r = findMrz([...damagedCopy, 'some text in between', ...ICAO_TD3].join('\n'), TODAY)!;
    expect(r.valid).toBe(true);
  });
});
