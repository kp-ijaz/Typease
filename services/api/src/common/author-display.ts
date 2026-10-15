/**
 * How the author of a comment or message is shown to somebody OUTSIDE the
 * centre (a customer or a company user).
 *
 * Staff are people with a private life: a customer who reads a comment learns
 * that somebody at the centre wrote it and that person's first name, never the
 * full name, the role or the fact that it was TypEase support or an automation.
 * Staff themselves keep seeing full names and the real author type.
 */
export type AuthorKind = 'STAFF' | 'CUSTOMER' | 'SYSTEM';

const STAFF_SIDE = ['STAFF', 'PLATFORM'];
const MACHINE = ['SYSTEM', 'AUTOMATION'];
/** Role-neutral kind of an author type (STAFF / PLATFORM -> STAFF, CUSTOMER / CORPORATE -> CUSTOMER, SYSTEM / AUTOMATION -> SYSTEM). */
export const authorKindOf = (authorType: string | null | undefined): AuthorKind => (STAFF_SIDE.includes(String(authorType)) ? 'STAFF' : MACHINE.includes(String(authorType)) ? 'SYSTEM' : 'CUSTOMER');

const HONORIFICS = new Set(['mr', 'mr.', 'mrs', 'mrs.', 'ms', 'ms.', 'miss', 'dr', 'dr.', 'eng', 'eng.', 'prof', 'prof.', 'sheikh', 'sheikha', 'sayed', 'sayyid', 'السيد', 'السيدة', 'د.', 'م.']);
/** First parts that are not a name by themselves: "Abdul Rahman", "Abu Bakr", "Umm Kulthum" stay together. */
const COMPOUND_FIRST = new Set(['abd', 'abdul', 'abdel', 'abu', 'umm', 'um', 'bin', 'bint', 'ibn', 'عبد', 'أبو', 'ابو', 'أم', 'ام', 'بن', 'بنت']);

/**
 * The first name of a person from their full name: the first word, or two words when the first one cannot stand
 * alone. A label that is not a person's name ("automation:...", "system") gives null.
 */
export function firstNameOf(fullName: string | null | undefined): string | null {
  if (!fullName) return null;
  // "Sara Ahmad (TypEase support)" -> "Sara Ahmad"
  const cleaned = fullName.replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (!cleaned || /^(system|automation)\b/i.test(cleaned) || cleaned.includes(':')) return null;
  const words = cleaned.split(/\s+/).filter((w) => !HONORIFICS.has(w.toLowerCase()));
  if (!words.length) return null;
  const first = words[0];
  if (words.length > 1 && COMPOUND_FIRST.has(first.toLowerCase())) return `${first} ${words[1]}`;
  // Hyphenated compounds are one first name already ("Abdul-Rahman", "Jean-Pierre").
  return first;
}

/**
 * The author fields of a comment / message for the given audience.
 *  - staff:    the stored type and full name, plus `authorKind`;
 *  - external: `authorKind`; `authorType` reduced to the same role-neutral value; staff authors with their first
 *              name only; machine authors without a name; the customer's own side unchanged.
 */
export function presentAuthor(author: { authorType: string; authorName: string | null }, external: boolean): { authorType: string; authorKind: AuthorKind; authorName: string | null } {
  const kind = authorKindOf(author.authorType);
  if (!external) return { authorType: author.authorType, authorKind: kind, authorName: author.authorName };
  if (kind === 'CUSTOMER') return { authorType: author.authorType, authorKind: kind, authorName: author.authorName };
  return { authorType: kind, authorKind: kind, authorName: kind === 'STAFF' ? firstNameOf(author.authorName) : null };
}
