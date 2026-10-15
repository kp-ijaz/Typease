/**
 * Locale-aware formatting. Every function takes the active locale and the
 * centre's time zone / currency explicitly; components get them pre-bound from
 * `useI18n()`.
 *
 * Arabic uses Western digits (0-9) by default, as is usual for UAE business
 * documents; pass `numerals: 'arab'` to switch to Arabic-Indic digits.
 */

export type Locale = 'en' | 'ar';
export type Numerals = 'latn' | 'arab';

export interface FormatContext {
  locale: Locale;
  /** IANA zone of the centre, e.g. "Asia/Dubai". Dates are shown in the centre's time, not the browser's. */
  timeZone: string;
  /** ISO 4217, e.g. "AED". */
  currency: string;
  numerals?: Numerals;
}

export const intlLocale = (locale: Locale, numerals: Numerals = 'latn'): string => (locale === 'ar' ? `ar-AE-u-nu-${numerals}` : 'en-AE');

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

type DateInput = string | number | Date | null | undefined;

/**
 * A calendar date ("2026-10-09") has no time zone: it is anchored at noon UTC
 * and formatted in UTC so that it can never slip to the day before or after.
 */
function resolve(value: DateInput, timeZone: string): { date: Date; timeZone: string } | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') {
    const m = DATE_ONLY.exec(value);
    if (m) return { date: new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)), timeZone: 'UTC' };
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : { date, timeZone };
}

const cache = new Map<string, Intl.DateTimeFormat | Intl.NumberFormat>();
function dateFormatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `d|${locale}|${JSON.stringify(options)}`;
  let f = cache.get(key) as Intl.DateTimeFormat | undefined;
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(locale, options);
    } catch {
      // An unknown time zone must not break the page: fall back to UTC.
      f = new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' });
    }
    cache.set(key, f);
  }
  return f;
}
function numberFormatter(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `n|${locale}|${JSON.stringify(options)}`;
  let f = cache.get(key) as Intl.NumberFormat | undefined;
  if (!f) {
    try {
      f = new Intl.NumberFormat(locale, options);
    } catch {
      f = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    cache.set(key, f);
  }
  return f;
}

export type DateStyle = 'short' | 'medium' | 'long';
const DATE_STYLES: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  /** 09/10/2026 */
  short: { day: '2-digit', month: '2-digit', year: 'numeric' },
  /** 9 Oct 2026 */
  medium: { day: 'numeric', month: 'short', year: 'numeric' },
  /** Friday, 9 October 2026 */
  long: { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' },
};

/** "9 Oct 2026". Returns `fallback` (default an en dash) for empty or invalid values. */
export function formatDate(value: DateInput, ctx: FormatContext, style: DateStyle = 'medium', fallback = '–'): string {
  const r = resolve(value, ctx.timeZone);
  if (!r) return fallback;
  return dateFormatter(intlLocale(ctx.locale, ctx.numerals), { ...DATE_STYLES[style], timeZone: r.timeZone }).format(r.date);
}

/** "9 Oct 2026, 2:30 pm" in the centre's time zone. */
export function formatDateTime(value: DateInput, ctx: FormatContext, style: DateStyle = 'medium', fallback = '–'): string {
  const r = resolve(value, ctx.timeZone);
  if (!r) return fallback;
  return dateFormatter(intlLocale(ctx.locale, ctx.numerals), { ...DATE_STYLES[style], hour: 'numeric', minute: '2-digit', timeZone: r.timeZone }).format(r.date);
}

export function formatTime(value: DateInput, ctx: FormatContext, fallback = '–'): string {
  const r = resolve(value, ctx.timeZone);
  if (!r) return fallback;
  return dateFormatter(intlLocale(ctx.locale, ctx.numerals), { hour: 'numeric', minute: '2-digit', timeZone: r.timeZone }).format(r.date);
}

/** "3 days ago", "in 2 hours". `now` is injectable for tests. */
export function formatRelative(value: DateInput, ctx: FormatContext, now: number = Date.now(), fallback = '–'): string {
  const r = resolve(value, ctx.timeZone);
  if (!r) return fallback;
  const seconds = Math.round((r.date.getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  const [amount, unit]: [number, Intl.RelativeTimeFormatUnit] =
    abs < 60 ? [seconds, 'second'] : abs < 3600 ? [Math.round(seconds / 60), 'minute'] : abs < 86400 ? [Math.round(seconds / 3600), 'hour'] : abs < 2592000 ? [Math.round(seconds / 86400), 'day'] : abs < 31536000 ? [Math.round(seconds / 2592000), 'month'] : [Math.round(seconds / 31536000), 'year'];
  return new Intl.RelativeTimeFormat(intlLocale(ctx.locale, ctx.numerals), { numeric: 'auto' }).format(amount, unit);
}

export function formatNumber(value: number | string | null | undefined, ctx: Pick<FormatContext, 'locale' | 'numerals'>, options: Intl.NumberFormatOptions = {}, fallback = '–'): string {
  if (value === null || value === undefined || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return numberFormatter(intlLocale(ctx.locale, ctx.numerals), options).format(n);
}

/**
 * "AED 1,250.00" / "1,250.00 د.إ.". The amount is the API's decimal string;
 * converting to a number here is display-only (13 significant digits at most).
 */
export function formatMoney(amount: string | number | null | undefined, ctx: FormatContext, currency?: string | null, fallback = '–'): string {
  if (amount === null || amount === undefined || amount === '') return fallback;
  const n = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(n)) return fallback;
  return numberFormatter(intlLocale(ctx.locale, ctx.numerals), { style: 'currency', currency: currency || ctx.currency || 'AED', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

/** Today's calendar date in the centre's time zone as YYYY-MM-DD (for date inputs and "from / to" filters). */
export function todayInTimeZone(timeZone: string, now: Date = new Date()): string {
  const parts = dateFormatter('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Adds days to a YYYY-MM-DD date without involving time zones. */
export function addDays(isoDate: string, days: number): string {
  const m = DATE_ONLY.exec(isoDate);
  if (!m) throw new Error(`Not a YYYY-MM-DD date: ${isoDate}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return d.toISOString().slice(0, 10);
}

export const isIsoDate = (value: string): boolean => {
  const m = DATE_ONLY.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
};

export function formatFileSize(bytes: number | null | undefined, ctx: Pick<FormatContext, 'locale' | 'numerals'>): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '–';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${formatNumber(v, ctx, { maximumFractionDigits: u === 0 ? 0 : 1 })} ${units[u]}`;
}
