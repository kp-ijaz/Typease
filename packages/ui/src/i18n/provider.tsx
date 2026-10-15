'use client';

import * as React from 'react';
import {
  formatDate as fmtDate, formatDateTime as fmtDateTime, formatFileSize as fmtFileSize, formatMoney as fmtMoney, formatNumber as fmtNumber,
  formatRelative as fmtRelative, formatTime as fmtTime, todayInTimeZone, type DateStyle, type FormatContext, type Numerals,
} from '../lib/format';
import { DEFAULT_LOCALE, LOCALE_COOKIE, dirOf, hasKey, isLocale, translate, translatePlural, type Dictionaries, type Locale, type Vars } from './core';

type DateInput = string | number | Date | null | undefined;

export interface I18nValue {
  locale: Locale;
  dir: 'ltr' | 'rtl';
  isRtl: boolean;
  setLocale: (locale: Locale) => void;
  /** Text for a key, with {placeholders} filled in. */
  t: (key: string, vars?: Vars) => string;
  /** Plural-safe text: picks the right form for `count` and exposes it as {count}. */
  tn: (key: string, count: number, vars?: Vars) => string;
  /** Whether a key exists (in the active language or in English). Use it before optional lookups such as error codes. */
  has: (key: string) => boolean;
  /** One of two bilingual values the API sends ({ en, ar } labels, name / nameAr pairs). */
  pick: (en: string | null | undefined, ar: string | null | undefined) => string;
  formatDate: (value: DateInput, style?: DateStyle) => string;
  formatDateTime: (value: DateInput, style?: DateStyle) => string;
  formatTime: (value: DateInput) => string;
  formatRelative: (value: DateInput) => string;
  formatNumber: (value: number | string | null | undefined, options?: Intl.NumberFormatOptions) => string;
  /** Amount as the API sends it (decimal string). Currency defaults to the centre's. */
  formatMoney: (amount: string | number | null | undefined, currency?: string | null) => string;
  formatFileSize: (bytes: number | null | undefined) => string;
  /** Today in the centre's time zone, YYYY-MM-DD. */
  today: () => string;
  timeZone: string;
  currency: string;
  /** Set by the session / tenant providers once the centre is known. */
  setRegional: (regional: { timeZone?: string | null; currency?: string | null }) => void;
}

const I18nContext = React.createContext<I18nValue | null>(null);

export interface I18nProviderProps {
  /** The locale the server rendered with (from the cookie): avoids a flash of the wrong language. */
  locale?: Locale;
  dictionaries: Dictionaries;
  timeZone?: string;
  currency?: string;
  /** "latn" (0-9, default) or "arab" (Arabic-Indic digits) when the UI is in Arabic. */
  numerals?: Numerals;
  children: React.ReactNode;
}

function persistLocale(locale: Locale) {
  try {
    document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax`;
    window.localStorage.setItem(LOCALE_COOKIE, locale);
  } catch {
    /* private mode: the cookie alone is enough */
  }
}

export function I18nProvider({ locale: initial = DEFAULT_LOCALE, dictionaries, timeZone = 'Asia/Dubai', currency = 'AED', numerals = 'latn', children }: I18nProviderProps) {
  const [locale, setLocaleState] = React.useState<Locale>(initial);
  const [regional, setRegionalState] = React.useState({ timeZone, currency });

  // A locale saved in this browser wins over the server's guess when there was no cookie yet.
  React.useEffect(() => {
    try {
      const hasCookie = document.cookie.split('; ').some((c) => c.startsWith(`${LOCALE_COOKIE}=`));
      const saved = window.localStorage.getItem(LOCALE_COOKIE);
      if (!hasCookie && isLocale(saved) && saved !== locale) setLocaleState(saved);
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    const root = document.documentElement;
    root.lang = locale;
    root.dir = dirOf(locale);
  }, [locale]);

  const setLocale = React.useCallback((next: Locale) => {
    setLocaleState(next);
    persistLocale(next);
  }, []);
  const setRegional = React.useCallback((next: { timeZone?: string | null; currency?: string | null }) => {
    setRegionalState((prev) => {
      const merged = { timeZone: next.timeZone || prev.timeZone, currency: next.currency || prev.currency };
      return merged.timeZone === prev.timeZone && merged.currency === prev.currency ? prev : merged;
    });
  }, []);

  const value = React.useMemo<I18nValue>(() => {
    const ctx: FormatContext = { locale, timeZone: regional.timeZone, currency: regional.currency, numerals };
    const dir = dirOf(locale);
    return {
      locale,
      dir,
      isRtl: dir === 'rtl',
      setLocale,
      t: (key, vars) => translate(dictionaries, locale, key, vars),
      has: (key) => hasKey(dictionaries, locale, key) || hasKey(dictionaries, DEFAULT_LOCALE, key),
      tn: (key, count, vars) => translatePlural(dictionaries, locale, key, count, vars, (n) => fmtNumber(n, ctx)),
      pick: (en, ar) => (locale === 'ar' ? ar || en || '' : en || ar || ''),
      formatDate: (v, style) => fmtDate(v, ctx, style),
      formatDateTime: (v, style) => fmtDateTime(v, ctx, style),
      formatTime: (v) => fmtTime(v, ctx),
      formatRelative: (v) => fmtRelative(v, ctx),
      formatNumber: (v, options) => fmtNumber(v, ctx, options),
      formatMoney: (amount, cur) => fmtMoney(amount, ctx, cur),
      formatFileSize: (bytes) => fmtFileSize(bytes, ctx),
      today: () => todayInTimeZone(regional.timeZone),
      timeZone: regional.timeZone,
      currency: regional.currency,
      setRegional,
    };
  }, [locale, regional, numerals, dictionaries, setLocale, setRegional]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Translation, direction and locale-aware formatting. Every user-visible string goes through `t`. */
export function useI18n(): I18nValue {
  const value = React.useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside <I18nProvider>.');
  return value;
}

/**
 * `const t = useT();` then `t('common.save')`.
 * With a namespace the keys are relative to it: after `useT('auth.signIn')` the key "title" means "auth.signIn.title".
 * Use a second `useT()` for strings of other namespaces.
 */
export function useT(namespace?: string): I18nValue['t'] {
  const { t } = useI18n();
  return React.useMemo(() => (namespace ? (key: string, vars?: Vars) => t(`${namespace}.${key}`, vars) : t), [t, namespace]);
}

/** Text direction for primitives that need it (Radix `dir` props). Works without a provider: falls back to left-to-right. */
export function useDirection(): 'ltr' | 'rtl' {
  return React.useContext(I18nContext)?.dir ?? 'ltr';
}
