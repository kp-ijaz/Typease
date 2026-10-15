'use client';

import * as React from 'react';
import Link from 'next/link';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ChevronsUpDown, FilterX, Inbox, MoreHorizontal, SearchX } from 'lucide-react';
import type { Page, PageQuery } from '@typease/types';
import { parseSort, sortParam } from '@typease/api-client';
import { cn, focusRing } from '../lib/cn';
import { useI18n } from '../i18n/provider';
import { describeError } from '../lib/errors';
import { Alert } from '../components/alert';
import { Button } from '../components/button';
import { EmptyState } from '../components/empty-state';
import { DatePicker, SearchInput } from '../components/fields';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../components/menus';
import { Pagination } from '../components/pagination';
import { Select } from '../components/select';
import { Skeleton } from '../components/skeleton';

// ---------------------------------------------------------------- definitions

export interface DataTableColumn<Row> {
  id: string;
  /** Column heading, already translated. */
  header: string;
  /** The cell's content. Return null when there is no value: the table shows a dash, the phone card leaves an empty badge out. */
  cell: (row: Row) => React.ReactNode;
  /** The API's sort field; makes the heading a sort button ("createdAt", "fullName"). */
  sortField?: string;
  align?: 'start' | 'end';
  /** Classes for the cells of this column (widths, `tabular`, `whitespace-nowrap`). */
  className?: string;
  /**
   * How the column appears in the stacked cards on small screens:
   *  "title" the card's heading (one column), "badge" next to the heading (a status),
   *  "field" a labelled line (default), "hidden" left out.
   */
  mobile?: 'title' | 'badge' | 'field' | 'hidden';
}

function openPicker(event: React.MouseEvent<HTMLInputElement>) {
  try {
    event.currentTarget.showPicker?.();
  } catch {
    // Not allowed in this context (for example inside a cross-origin frame): typing the date still works.
  }
}

const isEmptyCell = (value: React.ReactNode) => value === null || value === undefined || value === '' || value === false;
/** A cell without a value shows a dash, so the row keeps its shape. Return null from `cell` instead of writing the dash. */
const orDash = (value: React.ReactNode) => (isEmptyCell(value) ? <span className="text-muted-foreground">–</span> : value);

export type DataTableFilter =
  | {
      id: string;
      type: 'select';
      label: string;
      options: Array<{ value: string; label: string }>;
      /** Text of the "no filter" choice. Default: the common "All". */
      allLabel?: string;
    }
  | {
      /** Used as the prefix of the two query parameters unless `fromKey` / `toKey` are given. */
      id: string;
      type: 'dateRange';
      label: string;
      fromKey: string;
      toKey: string;
    };

export interface RowAction<Row> {
  id: string;
  label: string;
  icon?: React.ReactNode;
  /** Navigate ... */
  href?: (row: Row) => string;
  /** ... or run something. */
  onSelect?: (row: Row) => void;
  destructive?: boolean;
  hidden?: (row: Row) => boolean;
  disabled?: (row: Row) => boolean;
}

export type ListParams = PageQuery & Record<string, string | number | boolean | undefined>;

export interface DataTableProps<Row> {
  /** Accessible name of the table ("Requests"). */
  caption: string;
  /** Base of the TanStack Query key, e.g. ['requests']. Invalidate it after mutations: the list refetches. */
  queryKey: readonly unknown[];
  /** Fetches one page: `(params, signal) => api.requests.list(params, signal)`. */
  queryFn: (params: ListParams, signal: AbortSignal) => Promise<Page<Row>>;
  columns: Array<DataTableColumn<Row>>;
  rowKey: (row: Row) => string;
  filters?: DataTableFilter[];
  /**
   * Filter values to start with (`{ status: 'UNPAID' }`), for keys the URL does not already carry.
   * The keys need no control in the filter bar: a page can drive them with its own tabs.
   */
  initialFilterValues?: Record<string, string>;
  /**
   * Filter values owned by the page (controlled). Whenever this object's CONTENT changes, the table adopts it
   * and goes back to page 1. Use together with `onFilterValuesChange` to keep your state in step with what the
   * person changes in the filter bar. For "the URL decides, I only want to know", use `initialFilterValues`
   * and `onFilterValuesChange` instead.
   */
  filterValues?: Record<string, string>;
  /** Called with the current filter values once the table has read the URL, and after every change. */
  onFilterValuesChange?: (values: Record<string, string>) => void;
  /** Show the search box (sent as `q`). */
  searchable?: boolean;
  searchPlaceholder?: string;
  /** "createdAt:desc" */
  defaultSort?: string;
  defaultPageSize?: number;
  /** Parameters that always apply and cannot be changed by the person (scope of the page). */
  fixedParams?: Record<string, string | number | boolean | undefined>;
  /** Opens the record: the title cell becomes a link (on phones the whole card is the link). */
  rowHref?: (row: Row) => string;
  /**
   * Does something with the record without leaving the page (open a side panel, select it). The row reacts to a
   * click anywhere outside its own buttons and links, and the title cell becomes a button for the keyboard.
   * With `rowHref` as well, the link keeps the title and `onRowClick` takes the rest of the row.
   */
  onRowClick?: (row: Row) => void;
  /** Called whenever a page of rows has arrived: the rows, the paging figures and the parameters they were asked with. */
  onPageLoaded?: (info: DataTablePageInfo<Row>) => void;
  rowActions?: Array<RowAction<Row>>;
  /** What to show when there is nothing at all (no filters active). */
  empty?: { icon?: React.ReactNode; title: string; description?: string; action?: React.ReactNode };
  /** Keep page, sort, search and filters in the URL so that reload, back and shared links restore the view. Default true. */
  syncUrl?: boolean;
  /** Extra controls at the end of the filter bar (export button ...). */
  toolbar?: React.ReactNode;
  /** false for short "latest N" lists on dashboards: no pager, no rows-per-page. Default true. */
  pagination?: boolean;
  /** Render without the card frame, inside a Card that already provides one. */
  bare?: boolean;
  className?: string;
}

export interface DataTablePageInfo<Row> {
  rows: Row[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  /** What the server was asked: paging, sort, search, filters and the fixed parameters. */
  params: ListParams;
}

// ---------------------------------------------------------------- state

export interface ListState {
  page: number;
  pageSize: number;
  sort: string | undefined;
  q: string;
  filters: Record<string, string>;
}

const RESERVED = new Set(['page', 'pageSize', 'sort', 'q']);

function readUrl(defaults: ListState, filterKeys: string[]): ListState {
  const params = new URLSearchParams(window.location.search);
  const num = (key: string, fallback: number, max: number) => {
    const n = Number(params.get(key));
    return Number.isInteger(n) && n >= 1 && n <= max ? n : fallback;
  };
  const filters: Record<string, string> = {};
  for (const key of filterKeys) {
    const v = params.get(key);
    if (v) filters[key] = v;
  }
  const sort = params.get('sort');
  return { page: num('page', 1, 1_000_000), pageSize: num('pageSize', defaults.pageSize, 100), sort: sort && parseSort(sort) ? sort : defaults.sort, q: params.get('q') ?? '', filters };
}

function writeUrl(state: ListState, defaults: ListState, filterKeys: string[]) {
  const url = new URL(window.location.href);
  const set = (key: string, value: string | undefined, fallback?: string) => {
    if (value && value !== fallback) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  };
  set('page', String(state.page), '1');
  set('pageSize', String(state.pageSize), String(defaults.pageSize));
  set('sort', state.sort, defaults.sort);
  set('q', state.q);
  for (const key of filterKeys) set(key, state.filters[key]);
  const next = `${url.pathname}${url.search}${url.hash}`;
  if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) window.history.replaceState(window.history.state, '', next);
}

const sameRecord = (a: Record<string, string>, b: Record<string, string>) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};
const sameState = (a: ListState, b: ListState) => a.page === b.page && a.pageSize === b.pageSize && a.sort === b.sort && a.q === b.q && sameRecord(a.filters, b.filters);
/** Drops empty values, so `{ status: '' }` and `{}` are the same thing. */
const cleanFilters = (values: Record<string, string | undefined> | undefined) => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values ?? {})) if (value && !RESERVED.has(key)) out[key] = value;
  return out;
};
const SEPARATOR = '\u0000';

/**
 * Page / sort / search / filter state of a list, optionally mirrored in the URL.
 * Changing the search, a filter, the sort order or the page size goes back to page 1.
 *
 * `filterKeys` and `initialFilters` are compared by CONTENT: passing a new array or
 * object with the same entries on every render is fine and restarts nothing.
 */
export function useListState(options: {
  defaultSort?: string;
  defaultPageSize?: number;
  filterKeys?: string[];
  syncUrl?: boolean;
  /** Starting values for filters the URL says nothing about. */
  initialFilters?: Record<string, string>;
  /** Filters owned by the caller: they are the starting point, whatever the URL says (later changes go through `setFilters`). */
  ownedFilters?: Record<string, string>;
}) {
  const { defaultSort, defaultPageSize = 20, syncUrl = true } = options;
  const keysSignature = (options.filterKeys ?? []).filter((k) => !RESERVED.has(k)).join(SEPARATOR);
  const filterKeys = React.useMemo(() => (keysSignature ? keysSignature.split(SEPARATOR) : []), [keysSignature]);
  const defaults = React.useMemo<ListState>(() => ({ page: 1, pageSize: defaultPageSize, sort: defaultSort, q: '', filters: {} }), [defaultPageSize, defaultSort]);
  // Only the first value counts: initial filters are a starting point, not a prop to follow.
  const initialFilters = React.useRef(cleanFilters(options.initialFilters));
  const ownedFilters = React.useRef(options.ownedFilters ? cleanFilters(options.ownedFilters) : undefined);
  const [state, setState] = React.useState<ListState>(() => (syncUrl && !ownedFilters.current ? defaults : { ...defaults, filters: ownedFilters.current ?? initialFilters.current }));
  // The URL is read after mount (the server cannot see it the same way); the first fetch waits for it.
  const [ready, setReady] = React.useState(!syncUrl);
  const urlRead = React.useRef(false);
  const urlWritten = React.useRef(false);

  React.useEffect(() => {
    if (!syncUrl) return;
    const read = (first: boolean) => {
      const next = readUrl(defaults, filterKeys);
      // On the first read the initial filters fill what the URL leaves open (filters owned by the caller replace
      // the URL's altogether); afterwards the URL is complete, and back / forward restore what it says.
      if (first) next.filters = ownedFilters.current ?? { ...initialFilters.current, ...next.filters };
      // Same content: keep the same object, so nothing re-renders (and nothing can loop).
      setState((current) => (sameState(current, next) ? current : next));
    };
    read(!urlRead.current);
    urlRead.current = true;
    setReady(true);
    const onPop = () => read(false);
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      // Until the state has been written to the URL, a re-run of this effect is still "the first read".
      // React's StrictMode (development) runs every effect twice on mount: without this, the second run
      // read a URL that knew nothing of the initial filters yet and dropped them.
      if (!urlWritten.current) urlRead.current = false;
    };
  }, [syncUrl, defaults, filterKeys]);

  React.useEffect(() => {
    if (!syncUrl || !ready) return;
    writeUrl(state, defaults, filterKeys);
    urlWritten.current = true;
  }, [state, syncUrl, ready, defaults, filterKeys]);

  return React.useMemo(
    () => ({
      state,
      ready,
      setPage: (page: number) => setState((s) => (s.page === page ? s : { ...s, page })),
      setPageSize: (pageSize: number) => setState((s) => ({ ...s, pageSize, page: 1 })),
      setSort: (sort: string | undefined) => setState((s) => ({ ...s, sort, page: 1 })),
      setSearch: (q: string) => setState((s) => (s.q === q ? s : { ...s, q, page: 1 })),
      setFilter: (key: string, value: string | undefined) =>
        setState((s) => {
          const filters = { ...s.filters };
          if (value) filters[key] = value;
          else delete filters[key];
          return sameRecord(filters, s.filters) ? s : { ...s, filters, page: 1 };
        }),
      /** Replaces all filter values at once (a page that owns the filters). */
      setFilters: (values: Record<string, string | undefined>) =>
        setState((s) => {
          const filters = cleanFilters(values);
          return sameRecord(filters, s.filters) ? s : { ...s, filters, page: 1 };
        }),
      clear: () => setState((s) => (s.q === '' && Object.keys(s.filters).length === 0 ? s : { ...s, q: '', filters: {}, page: 1 })),
      activeCount: Object.keys(state.filters).length + (state.q ? 1 : 0),
    }),
    [state, ready],
  );
}

// ---------------------------------------------------------------- component

const ALL = '__all__';
/** One array for every table without filters: a new `[]` per render would look like a change to every effect. */
const NO_FILTERS: DataTableFilter[] = [];
/** Clicks on these belong to the control, not to the row. */
const INTERACTIVE = 'a, button, input, select, textarea, label, [role="menuitem"], [role="checkbox"], [role="switch"], [data-row-click-ignore]';

/**
 * The standard list of the staff apps: server-side pagination, sorting and
 * filtering against an endpoint that answers `{ data, meta }`.
 *
 *  - Filter bar: search + selects + date ranges, "Clear filters" when any is set.
 *  - Loading: skeleton rows on the first load; later pages keep the previous rows visible, dimmed.
 *  - Empty: different words for "nothing yet" and "nothing matches".
 *  - Error: an inline alert with "Try again"; the filters stay as they were.
 *  - Below the `md` breakpoint each row becomes a stacked card.
 */
export function DataTable<Row>({
  caption, queryKey, queryFn, columns, rowKey, filters = NO_FILTERS, initialFilterValues, filterValues, onFilterValuesChange, searchable = true, searchPlaceholder, defaultSort,
  defaultPageSize = 20, fixedParams, rowHref, onRowClick, onPageLoaded, rowActions, empty, syncUrl = true, toolbar, pagination = true, bare = false, className,
}: DataTableProps<Row>) {
  const i18n = useI18n();
  const { t, tn } = i18n;
  // Keys of the filter bar, plus the keys a page drives itself. (useListState compares them by content.)
  const filterKeys = [
    ...filters.flatMap((f) => (f.type === 'dateRange' ? [f.fromKey, f.toKey] : [f.id])),
    ...Object.keys(initialFilterValues ?? {}),
    ...Object.keys(filterValues ?? {}),
  ].filter((key, index, all) => all.indexOf(key) === index);
  // Controlled filters: the table starts with the page's values and adopts them whenever their content changes.
  const controlled = filterValues ? cleanFilters(filterValues) : undefined;
  const controlledSignature = controlled ? JSON.stringify(Object.entries(controlled).sort()) : undefined;
  const list = useListState({ defaultSort, defaultPageSize, filterKeys, syncUrl, initialFilters: initialFilterValues, ownedFilters: controlled });
  const { state } = list;

  const { setFilters } = list;
  React.useEffect(() => {
    if (controlledSignature !== undefined) setFilters(Object.fromEntries(JSON.parse(controlledSignature) as Array<[string, string]>));
    // `setFilters` changes identity with the state; only a change of the page's values may trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlledSignature]);

  // Tell the page what the filters are: once the URL has been read, then after every change.
  const notify = React.useRef(onFilterValuesChange);
  notify.current = onFilterValuesChange;
  const notified = React.useRef<string | undefined>(undefined);
  React.useEffect(() => {
    if (!list.ready) return;
    const signature = JSON.stringify(Object.entries(state.filters).sort());
    if (signature === notified.current) return;
    notified.current = signature;
    // The page already has these values (it just handed them over): nothing to report.
    if (signature !== controlledSignature) notify.current?.(state.filters);
  }, [list.ready, state.filters, controlledSignature]);

  const params = React.useMemo<ListParams>(
    () => ({ ...state.filters, ...fixedParams, page: state.page, pageSize: state.pageSize, sort: state.sort, q: state.q || undefined }),
    [state, fixedParams],
  );
  const query = useQuery({
    queryKey: [...queryKey, 'list', params],
    queryFn: ({ signal }) => queryFn(params, signal),
    placeholderData: keepPreviousData,
    enabled: list.ready,
  });

  const rows = query.data?.data ?? [];
  const meta = query.data?.meta;
  const firstLoad = !query.data && (query.isPending || !list.ready);
  const refetching = query.isFetching && !!query.data;
  const filtered = list.activeCount > 0;
  const sort = parseSort(state.sort);

  const loaded = React.useRef(onPageLoaded);
  loaded.current = onPageLoaded;
  React.useEffect(() => {
    // Not while the previous page is still shown as a placeholder: only real answers for the current view.
    if (!query.data || query.isPlaceholderData) return;
    const { data, meta: m } = query.data;
    loaded.current?.({ rows: data, page: m.page, pageSize: m.pageSize, total: m.total, totalPages: m.totalPages, params });
    // `params` belongs to `query.data` (it is part of the query key).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data, query.isPlaceholderData]);

  const rowClick = onRowClick
    ? (row: Row) => (event: React.MouseEvent<HTMLElement>) => {
        // A click on a link, a button or the row menu is for that control; so is the end of a text selection.
        if ((event.target as HTMLElement).closest(INTERACTIVE) || window.getSelection()?.toString()) return;
        onRowClick(row);
      }
    : undefined;

  // If rows were deleted and the current page no longer exists, step back to the last one.
  React.useEffect(() => {
    if (meta && meta.totalPages > 0 && state.page > meta.totalPages) list.setPage(meta.totalPages);
  }, [meta, state.page, list]);

  const toggleSort = (field: string) => {
    if (sort?.field !== field) list.setSort(sortParam(field, 'asc'));
    else if (sort.direction === 'asc') list.setSort(sortParam(field, 'desc'));
    else list.setSort(defaultSort && parseSort(defaultSort)?.field !== field ? defaultSort : undefined);
  };

  const visibleActions = (row: Row) => (rowActions ?? []).filter((a) => !a.hidden?.(row));
  const actionsMenu = (row: Row) => {
    const actions = visibleActions(row);
    if (!actions.length) return null;
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={t('common.moreActions')} onClick={(e) => e.stopPropagation()}>
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent onClick={(e) => e.stopPropagation()}>
          {actions.map((action) =>
            action.href ? (
              <DropdownMenuItem key={action.id} asChild destructive={action.destructive} disabled={action.disabled?.(row)}>
                <Link href={action.href(row)}>
                  {action.icon}
                  {action.label}
                </Link>
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem key={action.id} destructive={action.destructive} disabled={action.disabled?.(row)} onSelect={() => action.onSelect?.(row)}>
                {action.icon}
                {action.label}
              </DropdownMenuItem>
            ),
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  const titleColumn = columns.find((c) => c.mobile === 'title') ?? columns[0];
  const badgeColumns = columns.filter((c) => c.mobile === 'badge');
  const fieldColumns = columns.filter((c) => c !== titleColumn && c.mobile !== 'badge' && c.mobile !== 'hidden');
  const hasActions = !!rowActions?.length;
  const skeletonRows = Math.min(state.pageSize, 6);

  const emptyNode = filtered ? (
    <EmptyState
      icon={<SearchX />}
      title={t('table.emptyFilteredTitle')}
      description={t('table.emptyFilteredDescription')}
      action={
        <Button variant="outline" onClick={list.clear}>
          <FilterX aria-hidden="true" />
          {t('table.clearFilters')}
        </Button>
      }
    />
  ) : (
    <EmptyState icon={empty?.icon ?? <Inbox />} title={empty?.title ?? t('table.emptyTitle')} description={empty?.description ?? t('table.emptyDescription')} action={empty?.action} />
  );

  return (
    <section aria-label={caption} className={cn(!bare && 'rounded-lg border bg-card shadow-xs', className)}>
      {searchable || filters.length || toolbar ? (
        <div className="flex flex-wrap items-end gap-3 border-b p-3 sm:p-4">
          {searchable ? (
            <div className="w-full sm:w-72">
              <SearchInput value={state.q} onChange={list.setSearch} placeholder={searchPlaceholder} aria-label={searchPlaceholder ?? t('common.search')} />
            </div>
          ) : null}
          {filters.map((filter) =>
            filter.type === 'select' ? (
              <div key={filter.id} className="min-w-0 flex-1 basis-[calc(50%-0.375rem)] sm:max-w-56 sm:flex-none sm:basis-auto">
                <Select
                  aria-label={filter.label}
                  value={state.filters[filter.id] ?? ALL}
                  onValueChange={(v) => list.setFilter(filter.id, v === ALL ? undefined : v)}
                  options={[{ value: ALL, label: `${filter.label}: ${filter.allLabel ?? t('common.all')}` }, ...filter.options]}
                  className="sm:min-w-44 [&>span]:truncate"
                />
              </div>
            ) : (
              // On a phone the two date fields share a row: there is no room for the calendar icon, so a tap on the field opens the picker.
              <fieldset key={filter.id} className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
                <legend className="sr-only">{filter.label}</legend>
                <DatePicker
                  aria-label={`${filter.label}: ${t('common.from')}`}
                  title={`${filter.label}: ${t('common.from')}`}
                  value={state.filters[filter.fromKey] ?? ''}
                  max={state.filters[filter.toKey]}
                  onChange={(v) => list.setFilter(filter.fromKey, v || undefined)}
                  className="min-w-0 flex-1 px-2 max-sm:[&::-webkit-calendar-picker-indicator]:hidden sm:w-40 sm:flex-none sm:px-3"
                  onClick={openPicker}
                />
                <span aria-hidden="true" className="text-muted-foreground">
                  –
                </span>
                <DatePicker
                  aria-label={`${filter.label}: ${t('common.to')}`}
                  title={`${filter.label}: ${t('common.to')}`}
                  value={state.filters[filter.toKey] ?? ''}
                  min={state.filters[filter.fromKey]}
                  onChange={(v) => list.setFilter(filter.toKey, v || undefined)}
                  className="min-w-0 flex-1 px-2 max-sm:[&::-webkit-calendar-picker-indicator]:hidden sm:w-40 sm:flex-none sm:px-3"
                  onClick={openPicker}
                />
              </fieldset>
            ),
          )}
          {filtered ? (
            <Button variant="ghost" onClick={list.clear} className="text-muted-foreground">
              <FilterX aria-hidden="true" />
              {t('table.clearFilters')}
            </Button>
          ) : null}
          {toolbar ? <div className="ms-auto flex items-center gap-2">{toolbar}</div> : null}
        </div>
      ) : null}

      {query.isError && !query.data ? (
        <div className="p-4">
          <Alert
            tone="danger"
            live
            title={t('table.errorTitle')}
            action={
              <Button size="sm" variant="outline" onClick={() => void query.refetch()} loading={query.isFetching}>
                {t('common.retry')}
              </Button>
            }
          >
            {describeError(query.error, i18n)}
          </Alert>
        </div>
      ) : (
        <>
          {query.isError ? (
            <div className="border-b p-3">
              <Alert tone="warning" live action={<Button size="sm" variant="outline" onClick={() => void query.refetch()}>{t('common.retry')}</Button>}>
                {describeError(query.error, i18n)}
              </Alert>
            </div>
          ) : null}

          {/* Table: md and up */}
          <div className={cn('scroll-quiet relative hidden overflow-x-auto md:block', refetching && 'opacity-60 transition-opacity')} aria-busy={query.isFetching}>
            <table className="w-full border-collapse text-base">
              <caption className="sr-only">
                {caption}
                {meta ? ` – ${tn('table.results', meta.total)}` : ''}
              </caption>
              <thead className="border-b bg-muted/50">
                <tr>
                  {columns.map((column) => {
                    const active = !!column.sortField && sort?.field === column.sortField;
                    return (
                      <th
                        key={column.id}
                        scope="col"
                        aria-sort={active ? (sort?.direction === 'asc' ? 'ascending' : 'descending') : undefined}
                        className={cn('h-10 whitespace-nowrap px-4 text-xs font-semibold text-muted-foreground', column.align === 'end' ? 'text-end' : 'text-start')}
                      >
                        {column.sortField ? (
                          <button
                            type="button"
                            onClick={() => toggleSort(column.sortField as string)}
                            title={active ? (sort?.direction === 'asc' ? t('table.sortAscending') : t('table.sortDescending')) : t('table.sortBy', { column: column.header })}
                            className={cn('-mx-1.5 inline-flex items-center gap-1 rounded-sm px-1.5 py-1 hover:text-foreground', active && 'text-foreground', focusRing)}
                          >
                            {column.header}
                            {active ? sort?.direction === 'asc' ? <ArrowUp className="size-3.5" aria-hidden="true" /> : <ArrowDown className="size-3.5" aria-hidden="true" /> : <ChevronsUpDown className="size-3.5 opacity-50" aria-hidden="true" />}
                          </button>
                        ) : (
                          column.header
                        )}
                      </th>
                    );
                  })}
                  {hasActions ? (
                    <th scope="col" className="relative w-12 px-2">
                      <span className="sr-only">{t('common.actions')}</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {firstLoad
                  ? Array.from({ length: skeletonRows }, (_, r) => (
                      <tr key={r} className="border-b last:border-0">
                        {columns.map((column, c) => (
                          <td key={column.id} className="px-4 py-3.5">
                            <Skeleton className={cn('h-4', c === 0 ? 'w-20' : c % 3 === 1 ? 'w-36' : 'w-24')} />
                          </td>
                        ))}
                        {hasActions ? <td /> : null}
                      </tr>
                    ))
                  : rows.map((row) => {
                      const href = rowHref?.(row);
                      return (
                        <tr key={rowKey(row)} onClick={rowClick?.(row)} className={cn('group border-b transition-colors last:border-0 hover:bg-muted/40', rowClick && 'cursor-pointer')}>
                          {columns.map((column) => (
                            <td key={column.id} className={cn('px-4 py-3 align-middle', column.align === 'end' && 'text-end', column.className)}>
                              {href && column === titleColumn ? (
                                <Link href={href} className={cn('rounded-sm font-medium text-secondary-text hover:underline', focusRing)}>
                                  {column.cell(row)}
                                </Link>
                              ) : onRowClick && column === titleColumn ? (
                                // The keyboard's way to what a click on the row does.
                                <button type="button" onClick={() => onRowClick(row)} className={cn('rounded-sm text-start font-medium text-secondary-text hover:underline', focusRing)}>
                                  {column.cell(row)}
                                </button>
                              ) : (
                                orDash(column.cell(row))
                              )}
                            </td>
                          ))}
                          {hasActions ? <td className="px-2 text-end align-middle">{actionsMenu(row)}</td> : null}
                        </tr>
                      );
                    })}
              </tbody>
            </table>
            {firstLoad ? <span className="sr-only" role="status">{t('table.loadingRows')}</span> : null}
            {!firstLoad && rows.length === 0 ? emptyNode : null}
          </div>

          {/* Stacked cards: below md */}
          <div className={cn('md:hidden', refetching && 'opacity-60 transition-opacity')} aria-busy={query.isFetching}>
            {firstLoad ? (
              <ul className="divide-y">
                {Array.from({ length: Math.min(skeletonRows, 4) }, (_, r) => (
                  <li key={r} className="space-y-3 p-4">
                    <div className="flex justify-between gap-4">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-5 w-20 rounded-full" />
                    </div>
                    <Skeleton className="h-3.5 w-48" />
                    <Skeleton className="h-3.5 w-40" />
                  </li>
                ))}
              </ul>
            ) : rows.length === 0 ? (
              emptyNode
            ) : (
              <ul className="divide-y">
                {rows.map((row) => {
                  const href = rowHref?.(row);
                  return (
                    <li key={rowKey(row)} className="relative p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            {href ? (
                              <Link href={href} className={cn('rounded-sm text-md font-semibold text-foreground after:absolute after:inset-0', focusRing)}>
                                {titleColumn.cell(row)}
                              </Link>
                            ) : onRowClick ? (
                              <button type="button" onClick={() => onRowClick(row)} className={cn('rounded-sm text-start text-md font-semibold text-foreground after:absolute after:inset-0', focusRing)}>
                                {titleColumn.cell(row)}
                              </button>
                            ) : (
                              <span className="text-md font-semibold text-foreground">{titleColumn.cell(row)}</span>
                            )}
                            {badgeColumns.map((c) => {
                              // Nothing to show (no status): no badge and no dash beside the heading.
                              const badge = c.cell(row);
                              return isEmptyCell(badge) ? null : (
                                <span key={c.id} className="relative">
                                  {badge}
                                </span>
                              );
                            })}
                          </div>
                          <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                            {fieldColumns.map((c) => (
                              <React.Fragment key={c.id}>
                                <dt className="text-muted-foreground">{c.header}</dt>
                                <dd className="min-w-0 truncate text-foreground">{orDash(c.cell(row))}</dd>
                              </React.Fragment>
                            ))}
                          </dl>
                        </div>
                        {hasActions ? <div className="relative z-10 -me-1.5 -mt-1">{actionsMenu(row)}</div> : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {pagination && meta && meta.total > 0 ? (
            <div className="border-t px-4 py-3">
              <Pagination meta={meta} onPageChange={list.setPage} onPageSizeChange={list.setPageSize} disabled={query.isFetching && !query.data} />
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
