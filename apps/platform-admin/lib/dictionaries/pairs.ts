import type { Dictionary } from '@typease/ui/server';

/**
 * The sections of the console write every text ONCE as a pair [English, Arabic], so the
 * two languages can never drift apart: the English and the Arabic dictionary are derived
 * from the same tree and always have exactly the same keys (also checked by
 * packages/ui/src/i18n/apps.test.ts). A plural entry is written with
 * `plural({ one, other }, { zero, one, two, few, many, other })`.
 */
export type Pair = readonly [en: string, ar: string];
export interface PluralPair {
  readonly __plural: readonly [Dictionary, Dictionary];
}
export interface Tree {
  readonly [key: string]: Pair | PluralPair | Tree;
}

export const plural = (en: { one: string; other: string }, ar: { zero: string; one: string; two: string; few: string; many: string; other: string }): PluralPair => ({ __plural: [en, ar] });

export function side(tree: Tree, index: 0 | 1): Dictionary {
  const out: Dictionary = {};
  for (const [key, value] of Object.entries(tree)) {
    if (Array.isArray(value)) out[key] = (value as unknown as Pair)[index];
    else if ('__plural' in value) out[key] = (value as PluralPair).__plural[index];
    else out[key] = side(value as Tree, index);
  }
  return out;
}
