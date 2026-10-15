import type { Page } from '@typease/types';

export interface PageInput {
  page?: number;
  pageSize?: number;
  sort?: string;
}

/**
 * Translates ?page=&pageSize=&sort=field:dir into Prisma arguments.
 * Sorting is restricted to an allow-list so callers cannot sort by arbitrary
 * (possibly sensitive or unindexed) columns.
 */
export function pageArgs<K extends string>(
  query: PageInput,
  allowedSort: readonly K[],
  defaultSort: `${K}:asc` | `${K}:desc`,
): { skip: number; take: number; orderBy: Array<Record<string, 'asc' | 'desc'>> } {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
  const [field, dir] = (query.sort ?? defaultSort).split(':');
  const valid = (allowedSort as readonly string[]).includes(field);
  const [f, d] = valid ? [field, dir === 'asc' ? 'asc' : 'desc'] : defaultSort.split(':');
  return { skip: (page - 1) * pageSize, take: pageSize, orderBy: [{ [f]: d as 'asc' | 'desc' }, { id: 'asc' }] };
}

export function pageResult<T>(data: T[], total: number, query: PageInput): Page<T> {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
  return { data, meta: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) } };
}

/** Decimal-safe money helpers (never use floats for money). */
import { Prisma } from '@typease/database';
export type Money = Prisma.Decimal;
export type DecimalInput = string | number | Prisma.Decimal;
export const D = (v: DecimalInput | null | undefined) => new Prisma.Decimal(v ?? 0);
/** Round half-up to 2 decimals (fils). */
export const money = (v: DecimalInput) => new Prisma.Decimal(v).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
export const sum = (values: Array<DecimalInput | null | undefined>) => values.reduce<Prisma.Decimal>((a, b) => a.plus(D(b)), D(0));
