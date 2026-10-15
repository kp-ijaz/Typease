import { mergeDictionaries, uiAr, uiEn } from '@typease/ui/server';
import { ar } from './ar';
import { en } from './en';

/** Shared UI strings + this app's namespaces. */
export const dictionaries = mergeDictionaries({ en: uiEn, ar: uiAr }, { en, ar });
export { en as appEn, ar as appAr };
