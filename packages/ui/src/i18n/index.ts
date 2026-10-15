export * from './core';
export * from './provider';
export { en as uiEn } from './dictionaries/en';
export { ar as uiAr } from './dictionaries/ar';
import { en } from './dictionaries/en';
import { ar } from './dictionaries/ar';
import type { Dictionaries } from './core';

/** The shared dictionaries. Apps extend them: `mergeDictionaries(uiDictionaries, { en: appEn, ar: appAr })`. */
export const uiDictionaries: Dictionaries = { en, ar };
