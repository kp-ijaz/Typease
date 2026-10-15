import { describe, expect, it } from 'vitest';
import { buildQuery, parseSort, sortParam } from './query';

describe('buildQuery', () => {
  it('returns an empty string for nothing', () => {
    expect(buildQuery()).toBe('');
    expect(buildQuery(null)).toBe('');
    expect(buildQuery({})).toBe('');
    expect(buildQuery({ q: '', status: undefined, branchId: null, tags: [] })).toBe('');
  });
  it('writes the page query and filters, sorted by key', () => {
    expect(buildQuery({ pageSize: 20, page: 2, sort: 'createdAt:desc', q: 'ahmed' })).toBe('?page=2&pageSize=20&q=ahmed&sort=createdAt%3Adesc');
  });
  it('joins arrays with commas and drops empty items', () => {
    expect(buildQuery({ status: ['SUBMITTED', 'UNDER_REVIEW', ''] })).toBe('?status=SUBMITTED%2CUNDER_REVIEW');
  });
  it('keeps false and zero, formats booleans and dates', () => {
    expect(buildQuery({ hasAccount: false, page: 0 })).toBe('?hasAccount=false&page=0');
    expect(buildQuery({ from: new Date('2026-10-09T00:00:00.000Z') })).toBe('?from=2026-10-09T00%3A00%3A00.000Z');
  });
  it('encodes keys and values', () => {
    expect(buildQuery({ q: 'علي & co', 'a b': 'x/y' })).toBe(`?a%20b=x%2Fy&q=${encodeURIComponent('علي & co')}`);
  });
  it('gives the same string for the same filters in any order', () => {
    expect(buildQuery({ b: 1, a: 2 })).toBe(buildQuery({ a: 2, b: 1 }));
  });
  it('rejects nested objects instead of sending [object Object]', () => {
    expect(() => buildQuery({ filter: { a: 1 } as never })).toThrow(/filter/);
  });
});

describe('sort helpers', () => {
  it('builds and parses "field:direction"', () => {
    expect(sortParam('createdAt', 'desc')).toBe('createdAt:desc');
    expect(sortParam('fullName')).toBe('fullName:asc');
    expect(parseSort('requestNo:asc')).toEqual({ field: 'requestNo', direction: 'asc' });
    expect(parseSort('requestNo')).toBeNull();
    expect(parseSort(undefined)).toBeNull();
  });
});
