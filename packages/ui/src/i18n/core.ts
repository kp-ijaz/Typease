/**
 * Dictionary-based i18n core: no React, safe on the server and in tests.
 *
 * A dictionary is a tree of strings. Keys are dotted paths ("auth.signIn.title").
 * Values may contain {placeholders}. A plural entry is an object keyed by the
 * CLDR plural categories of the language ("one" / "other" for English; Arabic
 * uses all six: zero, one, two, few, many, other).
 */
import type { Locale } from '../lib/format';

export type { Locale };
export const LOCALES: readonly Locale[] = ['en', 'ar'] as const;
export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_COOKIE = 'te_locale';
export const isLocale = (value: unknown): value is Locale => value === 'en' || value === 'ar';
export const dirOf = (locale: Locale): 'ltr' | 'rtl' => (locale === 'ar' ? 'rtl' : 'ltr');

export interface Dictionary {
  [key: string]: string | Dictionary;
}
export type Dictionaries = Record<Locale, Dictionary>;
export type Vars = Record<string, string | number | null | undefined>;

/** Deep-merges dictionaries; later sources win. Apps add their namespaces to the shared ones with this. */
export function mergeDictionaries(...sources: Array<Partial<Dictionaries>>): Dictionaries {
  const merge = (target: Dictionary, source: Dictionary) => {
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'string') target[key] = value;
      else {
        const existing = target[key];
        const next: Dictionary = existing && typeof existing !== 'string' ? existing : {};
        target[key] = next;
        merge(next, value);
      }
    }
    return target;
  };
  const out: Dictionaries = { en: {}, ar: {} };
  for (const source of sources) for (const locale of LOCALES) if (source[locale]) merge(out[locale], source[locale] as Dictionary);
  return out;
}

export function lookup(dictionary: Dictionary | undefined, key: string): string | Dictionary | undefined {
  let node: string | Dictionary | undefined = dictionary;
  for (const part of key.split('.')) {
    if (!node || typeof node === 'string') return undefined;
    node = node[part];
  }
  return node;
}

export function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (vars[name] === undefined || vars[name] === null ? whole : String(vars[name])));
}

const pluralRules = new Map<Locale, Intl.PluralRules>();
export function pluralCategory(locale: Locale, count: number): Intl.LDMLPluralRule {
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  return rules.select(count);
}

const warned = new Set<string>();
/** Development aid: a missing key is reported once in the console; production stays silent. */
function warnMissing(locale: Locale, key: string, kind: 'missing' | 'not-a-string') {
  if (process.env.NODE_ENV === 'production') return;
  const id = `${locale}:${key}`;
  if (warned.has(id)) return;
  warned.add(id);
  console.warn(`[i18n] ${kind === 'missing' ? 'Missing' : 'Not a text'} "${key}" for locale "${locale}". Add it to the dictionaries (English and Arabic).`);
}
export const resetMissingKeyWarnings = () => warned.clear();

/** The text for a key: active locale, else English, else the key itself (so a gap is visible, never a crash). */
export function translate(dictionaries: Dictionaries, locale: Locale, key: string, vars?: Vars): string {
  let value = lookup(dictionaries[locale], key);
  if (value === undefined) {
    warnMissing(locale, key, 'missing');
    if (locale !== DEFAULT_LOCALE) value = lookup(dictionaries[DEFAULT_LOCALE], key);
  }
  if (typeof value === 'string') return interpolate(value, vars);
  if (value !== undefined) warnMissing(locale, key, 'not-a-string');
  return key;
}

/**
 * Plural-safe text. The entry at `key` is an object of plural categories; the
 * right one for `count` is chosen with Intl.PluralRules, falling back to "other".
 * `{count}` is available in the text, formatted by the caller-supplied function.
 */
export function translatePlural(dictionaries: Dictionaries, locale: Locale, key: string, count: number, vars?: Vars, formatCount: (n: number) => string = String): string {
  const pick = (loc: Locale): string | undefined => {
    const entry = lookup(dictionaries[loc], key);
    if (!entry || typeof entry === 'string') return typeof entry === 'string' ? entry : undefined;
    const value = entry[pluralCategory(loc, count)] ?? entry.other;
    return typeof value === 'string' ? value : undefined;
  };
  let template = pick(locale);
  if (template === undefined) {
    warnMissing(locale, key, 'missing');
    if (locale !== DEFAULT_LOCALE) template = pick(DEFAULT_LOCALE);
  }
  return template === undefined ? key : interpolate(template, { ...vars, count: formatCount(count) });
}

export const hasKey = (dictionaries: Dictionaries, locale: Locale, key: string): boolean => lookup(dictionaries[locale], key) !== undefined;

/** Every leaf path of a dictionary ("common.save", "table.rows.one" ...). Used by the completeness tests. */
export function leafKeys(dictionary: Dictionary, prefix = ''): string[] {
  return Object.entries(dictionary).flatMap(([key, value]) => (typeof value === 'string' ? [`${prefix}${key}`] : leafKeys(value, `${prefix}${key}.`)));
}

const PLURAL_CATEGORIES = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
/** A node whose children are all plural categories. */
export const isPluralEntry = (node: string | Dictionary | undefined): node is Dictionary =>
  !!node && typeof node !== 'string' && Object.keys(node).length > 0 && Object.keys(node).every((k) => PLURAL_CATEGORIES.has(k));

/**
 * Compares two dictionaries for the completeness test of an app:
 *  - every English text key must exist in Arabic and the other way round
 *    (plural entries are compared as a whole: the languages need different categories);
 *  - both sides must use the same {placeholders};
 *  - Arabic plural entries must have all six categories, English ones "one" and "other".
 */
export function compareDictionaries(en: Dictionary, ar: Dictionary): string[] {
  const problems: string[] = [];
  const collapse = (dictionary: Dictionary, prefix = ''): Map<string, string | Dictionary> => {
    const out = new Map<string, string | Dictionary>();
    for (const [key, value] of Object.entries(dictionary)) {
      const path = `${prefix}${key}`;
      if (typeof value === 'string' || isPluralEntry(value)) out.set(path, value);
      else for (const [k, v] of collapse(value, `${path}.`)) out.set(k, v);
    }
    return out;
  };
  const a = collapse(en);
  const b = collapse(ar);
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const [key, value] of a) {
    const other = b.get(key);
    if (other === undefined) {
      problems.push(`missing in ar: ${key}`);
      continue;
    }
    if (typeof value === 'string' && typeof other === 'string') {
      if (placeholders(value) !== placeholders(other)) problems.push(`placeholders differ: ${key}`);
      if (!other.trim()) problems.push(`empty in ar: ${key}`);
    } else if (typeof value !== 'string' && typeof other !== 'string') {
      for (const c of ['one', 'other']) if (typeof value[c] !== 'string') problems.push(`en plural "${key}" lacks "${c}"`);
      for (const c of ['zero', 'one', 'two', 'few', 'many', 'other']) if (typeof other[c] !== 'string') problems.push(`ar plural "${key}" lacks "${c}"`);
    } else problems.push(`shape differs (text vs plural): ${key}`);
  }
  for (const key of b.keys()) if (!a.has(key)) problems.push(`missing in en: ${key}`);
  return problems;
}

/** Picks the UI language for a first visit: saved cookie, else the centre's default, else the browser's preference. */
export function resolveLocale(input: { cookie?: string | null; tenantDefault?: string | null; acceptLanguage?: string | null }): Locale {
  if (isLocale(input.cookie)) return input.cookie;
  if (isLocale(input.tenantDefault)) return input.tenantDefault;
  const first = (input.acceptLanguage ?? '').split(',')[0]?.trim().slice(0, 2).toLowerCase();
  return isLocale(first) ? first : DEFAULT_LOCALE;
}
