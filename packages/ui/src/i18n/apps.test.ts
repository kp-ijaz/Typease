import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareDictionaries, leafKeys, lookup, mergeDictionaries, uiDictionaries, type Dictionary } from './index';

/**
 * The four apps keep their own strings in apps/<app>/lib/dictionaries/{en,ar}.ts.
 * This test holds them to the same rules as the shared dictionaries, so a page
 * builder who adds an English string without its Arabic twin fails CI here.
 */
const APPS = ['centre-web', 'customer-web', 'corporate-portal', 'platform-admin'] as const;
const appsDir = resolve(__dirname, '../../../../apps');

async function load(app: string): Promise<{ en: Dictionary; ar: Dictionary }> {
  // Computed paths: the apps are not part of this package's TypeScript project.
  const base = join(appsDir, app, 'lib/dictionaries');
  const [en, ar] = await Promise.all([import(/* @vite-ignore */ join(base, 'en.ts')), import(/* @vite-ignore */ join(base, 'ar.ts'))]);
  return { en: en.en as Dictionary, ar: ar.ar as Dictionary };
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'dictionaries') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe.each(APPS)('dictionaries of %s', (app) => {
  it('exist', () => {
    expect(existsSync(join(appsDir, app, 'lib/dictionaries/en.ts'))).toBe(true);
    expect(existsSync(join(appsDir, app, 'lib/dictionaries/ar.ts'))).toBe(true);
  });

  it('have every English key in Arabic and the other way round, with the same placeholders', async () => {
    const { en, ar } = await load(app);
    expect(leafKeys(en).length).toBeGreaterThan(20);
    expect(compareDictionaries(en, ar)).toEqual([]);
  });

  it('contain Arabic script in every Arabic value', async () => {
    const { ar } = await load(app);
    // Values made only of placeholders and symbols (a copyright line) have nothing to translate.
    const hasWords = (value: string) => /\p{L}/u.test(value.replace(/\{\w+\}/g, ''));
    const arabic = /[\u0600-\u06FF]/;
    const missing = leafKeys(ar).filter((key) => hasWords(lookup(ar, key) as string) && !arabic.test(lookup(ar, key) as string));
    expect(missing).toEqual([]);
  });

  it('define every key the app uses', async () => {
    const { en } = await load(app);
    const merged = mergeDictionaries(uiDictionaries, { en }).en;
    const used = new Set<string>();
    for (const file of sourceFiles(join(appsDir, app))) {
      const source = readFileSync(file, 'utf8');
      // t('a.b'), tn('a.b', n), pageTitle('a.b'), translate(dictionaries, locale, 'a.b')
      // (keys without a dot belong to a namespaced `useT('namespace')` and are not checked here)
      for (const m of source.matchAll(/\b(?:t|tn|pageTitle)\(\s*'([a-zA-Z0-9_]+\.[a-zA-Z0-9_.]+)'/g)) used.add(m[1]);
      for (const m of source.matchAll(/translate\(dictionaries, locale, '([a-zA-Z0-9_.]+)'/g)) used.add(m[1]);
      // titleKey="a.b" descriptionKey="a.b" parentKey="a.b", labelKey: 'a.b', key: 'nav.x'
      for (const m of source.matchAll(/\b(?:titleKey|descriptionKey|parentKey)="([a-zA-Z0-9_.]+)"/g)) used.add(m[1]);
      for (const m of source.matchAll(/\b(?:labelKey|key): '([a-z][a-zA-Z0-9_]*\.[a-zA-Z0-9_.]+)'/g)) used.add(m[1]);
    }
    expect(used.size).toBeGreaterThan(15);
    // Keys ending in "." are prefixes of keys built at run time (t(`a.b.${x}`)).
    const undefinedKeys = [...used].filter((key) => !key.endsWith('.') && lookup(merged, key) === undefined);
    expect(undefinedKeys).toEqual([]);
  });
});
