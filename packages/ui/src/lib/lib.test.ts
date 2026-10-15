import { describe, expect, it } from 'vitest';
import { addDays, formatDate, formatDateTime, formatFileSize, formatMoney, formatNumber, formatRelative, isIsoDate, todayInTimeZone, type FormatContext } from './format';
import { addMoney, compareMoney, fromMinorUnits, isMoneyAmount, normaliseMoney, sanitiseMoneyInput, subtractMoney, toMinorUnits } from './money';
import { formatPhone, isE164, joinPhone, splitPhone } from './phone';
import { COUNTRIES, countryName, dialCodeOf, sortedCountries } from './countries';
import { cn } from './cn';

const en: FormatContext = { locale: 'en', timeZone: 'Asia/Dubai', currency: 'AED' };
const ar: FormatContext = { locale: 'ar', timeZone: 'Asia/Dubai', currency: 'AED' };

describe('dates', () => {
  it('formats calendar dates without shifting the day in any time zone', () => {
    for (const timeZone of ['Asia/Dubai', 'America/Los_Angeles', 'Pacific/Kiritimati', 'UTC']) {
      expect(formatDate('2026-10-09', { ...en, timeZone })).toBe('9 Oct 2026');
      expect(formatDate('2026-01-01', { ...en, timeZone }, 'short')).toBe('01/01/2026');
    }
  });
  it('shows instants in the centre time zone, not the browser one', () => {
    // 21:30 UTC on the 8th is 01:30 on the 9th in Dubai.
    expect(formatDate('2026-10-08T21:30:00.000Z', en)).toBe('9 Oct 2026');
    expect(formatDate('2026-10-08T21:30:00.000Z', { ...en, timeZone: 'UTC' })).toBe('8 Oct 2026');
    expect(formatDateTime('2026-10-08T21:30:00.000Z', en)).toMatch(/9 Oct 2026, 1:30\s?am/i);
  });
  it('uses Arabic month names with Western digits by default', () => {
    const text = formatDate('2026-10-09', ar);
    expect(text).toContain('أكتوبر');
    expect(text).toContain('2026');
    expect(text).not.toMatch(/[٠-٩]/);
    expect(formatDate('2026-10-09', { ...ar, numerals: 'arab' })).toMatch(/[٠-٩]/);
  });
  it('returns the fallback for empty and invalid values', () => {
    expect(formatDate(null, en)).toBe('–');
    expect(formatDate('not a date', en)).toBe('–');
    expect(formatDateTime(undefined, en, 'medium', '')).toBe('');
  });
  it('survives an unknown time zone', () => {
    expect(formatDate('2026-10-08T10:00:00Z', { ...en, timeZone: 'Mars/Olympus' })).toBe('8 Oct 2026');
  });
  it('formats relative times', () => {
    const now = Date.parse('2026-10-09T12:00:00Z');
    expect(formatRelative('2026-10-09T09:00:00Z', en, now)).toBe('3 hours ago');
    expect(formatRelative('2026-10-12T12:00:00Z', en, now)).toBe('in 3 days');
    expect(formatRelative('2026-10-08T12:00:00Z', ar, now)).toBe('أمس');
  });
  it('helps with date-only arithmetic', () => {
    expect(addDays('2026-02-27', 2)).toBe('2026-03-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('09/10/2026')).toBe(false);
    expect(todayInTimeZone('Asia/Dubai', new Date('2026-10-08T21:30:00Z'))).toBe('2026-10-09');
    expect(todayInTimeZone('UTC', new Date('2026-10-08T21:30:00Z'))).toBe('2026-10-08');
  });
});

describe('numbers and money display', () => {
  it('formats money from decimal strings', () => {
    expect(formatMoney('1250.5', en).replace(/\u00a0/g, ' ')).toBe('AED 1,250.50');
    expect(formatMoney('0.00', en).replace(/\u00a0/g, ' ')).toBe('AED 0.00');
    expect(formatMoney('99999999999.99', en).replace(/\u00a0/g, ' ')).toBe('AED 99,999,999,999.99');
    expect(formatMoney('75.00', en, 'USD')).toContain('75.00');
    expect(formatMoney(null, en)).toBe('–');
    expect(formatMoney('abc', en)).toBe('–');
  });
  it('formats Arabic money with Western digits', () => {
    const text = formatMoney('1250.50', ar);
    expect(text).toContain('1,250.50');
    expect(text).toContain('د.إ');
  });
  it('formats counts and file sizes', () => {
    expect(formatNumber(12345, en)).toBe('12,345');
    expect(formatNumber('12345', ar)).toBe('12,345');
    expect(formatNumber(undefined, en)).toBe('–');
    expect(formatFileSize(482113, en)).toBe('470.8 KB');
    expect(formatFileSize(900, en)).toBe('900 B');
    expect(formatFileSize(15 * 1024 * 1024, en)).toBe('15 MB');
  });
});

describe('money arithmetic', () => {
  it('never uses floating point', () => {
    expect(addMoney('0.10', '0.20')).toBe('0.30');
    expect(addMoney('99999999999.99', '0.01')).toBe('100000000000.00');
    expect(subtractMoney('100.00', '33.35')).toBe('66.65');
    expect(subtractMoney('10', '10.5')).toBe('-0.50');
    expect(toMinorUnits('150')).toBe(15000n);
    expect(toMinorUnits('150.5')).toBe(15050n);
    expect(fromMinorUnits(5n)).toBe('0.05');
    expect(compareMoney('10.10', '10.1')).toBe(0);
    expect(compareMoney('9.99', '10')).toBe(-1);
    expect(() => toMinorUnits('1.234')).toThrow();
    expect(() => toMinorUnits('1e3')).toThrow();
  });
  it('cleans typed amounts without changing their value', () => {
    expect(sanitiseMoneyInput('1,250.50')).toBe('1250.50');
    expect(sanitiseMoneyInput('١٢٥٠٫٥')).toBe('1250.5');
    expect(sanitiseMoneyInput('12.345')).toBe('12.34');
    expect(sanitiseMoneyInput('1.2.3')).toBe('1.23');
    expect(sanitiseMoneyInput('.5')).toBe('0.5');
    expect(sanitiseMoneyInput('007')).toBe('7');
    expect(sanitiseMoneyInput('abc')).toBe('');
    expect(sanitiseMoneyInput('-5')).toBe('5');
    expect(normaliseMoney('150')).toBe('150.00');
    expect(normaliseMoney('150.5')).toBe('150.50');
    expect(normaliseMoney('150.')).toBe('150.00');
    expect(normaliseMoney('')).toBe('');
    expect(isMoneyAmount('150.00')).toBe(true);
    expect(isMoneyAmount('150.000')).toBe(false);
    expect(isMoneyAmount('-1')).toBe(false);
  });
});

describe('phone numbers', () => {
  it('builds E.164 from the many ways people type a number', () => {
    for (const typed of ['050 123 4567', '50-123-4567', '501234567', '00971 50 123 4567', '+971501234567', '971501234567', '٠٥٠١٢٣٤٥٦٧']) {
      expect(joinPhone('971', typed), typed).toBe('+971501234567');
    }
    expect(joinPhone('44', '07911 123456')).toBe('+447911123456');
    expect(joinPhone('971', '')).toBe('');
    expect(joinPhone('971', '   ')).toBe('');
  });
  it('splits by the longest dialling code', () => {
    expect(splitPhone('+971501234567')).toEqual({ dial: '971', national: '501234567' });
    expect(splitPhone('+447911123456')).toEqual({ dial: '44', national: '7911123456' });
    expect(splitPhone('+12025550123')).toEqual({ dial: '1', national: '2025550123' });
    expect(splitPhone('')).toEqual({ dial: '971', national: '' });
    expect(splitPhone(null, '966')).toEqual({ dial: '966', national: '' });
  });
  it('validates and formats', () => {
    expect(isE164('+971501234567')).toBe(true);
    expect(isE164('0501234567')).toBe(false);
    expect(isE164('+0501234567')).toBe(false);
    expect(formatPhone('+971501234567')).toBe('+971 50 123 4567');
    expect(formatPhone('+97143330001')).toBe('+971 4 333 0001');
    expect(formatPhone('050 123')).toBe('050 123');
    expect(formatPhone(null)).toBe('');
  });
});

describe('countries', () => {
  it('has unique ISO codes with dialling codes', () => {
    const codes = COUNTRIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.length).toBeGreaterThan(150);
    for (const c of COUNTRIES) {
      expect(c.code).toMatch(/^[A-Z]{2}$/);
      expect(c.dial).toMatch(/^[1-9]\d{0,3}$/);
    }
    expect(dialCodeOf('ae')).toBe('971');
  });
  it('names countries in the active language', () => {
    expect(countryName('AE', 'en')).toBe('United Arab Emirates');
    expect(countryName('AE', 'ar')).toBe('الإمارات العربية المتحدة');
    expect(countryName(null, 'en')).toBe('');
    expect(sortedCountries('en')[0].code).toBe('AE');
    expect(sortedCountries('ar').length).toBe(COUNTRIES.length);
  });
});

describe('cn', () => {
  it('lets the later Tailwind class win', () => {
    // eslint-disable-next-line no-constant-binary-expression -- a literal `false &&` is the case under test
    expect(cn('px-2 py-1', false && 'hidden', 'px-4')).toBe('py-1 px-4');
    expect(cn('ms-2', 'ms-4')).toBe('ms-4');
  });
});
