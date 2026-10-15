/**
 * Server-safe entry of @typease/ui: everything here can be imported from
 * server components, route handlers, middleware and next.config.
 * (Do not add anything that needs React state or browser APIs.)
 */
export { ThemeScript, themeInitScript, THEME_STORAGE_KEY, type ThemeChoice } from './providers/theme-script';
export { BrandStyle, BrandLogo, BRAND_STYLE_ID } from './providers/brand-style';
export { DEFAULT_LOCALE, LOCALES, LOCALE_COOKIE, dirOf, isLocale, mergeDictionaries, resolveLocale, translate, compareDictionaries, leafKeys, type Dictionaries, type Dictionary, type Locale } from './i18n/core';
export { en as uiEn } from './i18n/dictionaries/en';
export { ar as uiAr } from './i18n/dictionaries/ar';
export { safeNextPath } from './lib/safe-path';
export * from './lib/format';
export * from './lib/tenant';
