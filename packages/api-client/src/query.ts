import type { PageQuery } from '@typease/types';

export type QueryValue = string | number | boolean | Date | null | undefined | ReadonlyArray<string | number | boolean>;
export type QueryParams = Record<string, QueryValue>;

/**
 * Builds a query string ("" or "?a=1&b=x") for the API:
 *  - undefined, null and "" are left out (an empty filter means "no filter")
 *  - arrays become a comma-separated list (`status=SUBMITTED,UNDER_REVIEW`); empty arrays are left out
 *  - booleans become "true" / "false", dates ISO-8601
 *  - keys are sorted so that equal filters give equal URLs (stable cache keys)
 */
export function buildQuery(params?: object | null): string {
  if (!params) return '';
  const parts: string[] = [];
  const source = params as Record<string, QueryValue>;
  for (const key of Object.keys(source).sort()) {
    const value = source[key];
    if (value === undefined || value === null || value === '') continue;
    let text: string;
    if (Array.isArray(value)) {
      const items = value.filter((v) => v !== undefined && v !== null && v !== '').map(String);
      if (!items.length) continue;
      text = items.join(',');
    } else if (value instanceof Date) {
      text = value.toISOString();
    } else if (typeof value === 'object') {
      throw new TypeError(`Query parameter "${key}" must be a string, number, boolean, Date or an array of those.`);
    } else {
      text = String(value);
    }
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(text)}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

export type SortDirection = 'asc' | 'desc';
/** "createdAt:desc": the form every list endpoint expects. */
export const sortParam = (field: string, direction: SortDirection = 'asc') => `${field}:${direction}`;
export function parseSort(sort: string | undefined | null): { field: string; direction: SortDirection } | null {
  const m = /^([A-Za-z]+):(asc|desc)$/.exec(sort ?? '');
  return m ? { field: m[1], direction: m[2] as SortDirection } : null;
}

/** Page query plus list-specific filters. */
export type ListQuery<F extends object = Record<string, never>> = PageQuery & F;
