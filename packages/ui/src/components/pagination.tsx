'use client';

import * as React from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import type { PageMeta } from '@typease/types';
import { cn } from '../lib/cn';
import { useI18n } from '../i18n/provider';
import { Button } from './button';
import { Select } from './select';

export interface PaginationProps {
  meta: PageMeta;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  pageSizeOptions?: number[];
  disabled?: boolean;
  className?: string;
}

/** Pager for the API's `{ data, meta }` page shape: range summary, rows per page, first / previous / next / last. */
export function Pagination({ meta, onPageChange, onPageSizeChange, pageSizeOptions = [10, 20, 50, 100], disabled, className }: PaginationProps) {
  const { t, formatNumber } = useI18n();
  const selectId = React.useId();
  const pages = Math.max(1, meta.totalPages);
  const from = meta.total === 0 ? 0 : (meta.page - 1) * meta.pageSize + 1;
  const to = Math.min(meta.total, meta.page * meta.pageSize);
  const go = (page: number) => onPageChange(Math.min(pages, Math.max(1, page)));
  const nav = (label: string, Icon: typeof ChevronLeft, page: number, off: boolean, extra = '') => (
    <Button variant="outline" size="icon-sm" aria-label={label} title={label} disabled={disabled || off} onClick={() => go(page)} className={extra}>
      <Icon className="rtl-mirror" aria-hidden="true" />
    </Button>
  );
  return (
    <nav aria-label={t('table.pageOf', { page: formatNumber(meta.page), pages: formatNumber(pages) })} className={cn('flex flex-wrap items-center justify-between gap-x-6 gap-y-3 text-sm text-muted-foreground', className)}>
      <p className="tabular" aria-live="polite">
        {t('table.showing', { from: formatNumber(from), to: formatNumber(to), total: formatNumber(meta.total) })}
      </p>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        {onPageSizeChange ? (
          <div className="hidden items-center gap-2 sm:flex">
            <label htmlFor={selectId}>{t('table.rowsPerPage')}</label>
            <Select
              id={selectId}
              size="sm"
              className="w-[4.5rem]"
              value={String(meta.pageSize)}
              onValueChange={(v) => onPageSizeChange(Number(v))}
              // A page size that is not one of the choices (set by the page) is still shown as selected.
              options={Array.from(new Set([...pageSizeOptions, meta.pageSize]))
                .sort((a, b) => a - b)
                .map((n) => ({ value: String(n), label: formatNumber(n) }))}
              disabled={disabled}
            />
          </div>
        ) : null}
        <div className="flex items-center gap-1.5">
          {nav(t('table.firstPage'), ChevronsLeft, 1, meta.page <= 1, 'hidden sm:inline-flex')}
          {nav(t('table.previousPage'), ChevronLeft, meta.page - 1, meta.page <= 1)}
          <span className="tabular min-w-24 px-1 text-center text-foreground">{t('table.pageOf', { page: formatNumber(meta.page), pages: formatNumber(pages) })}</span>
          {nav(t('table.nextPage'), ChevronRight, meta.page + 1, meta.page >= pages)}
          {nav(t('table.lastPage'), ChevronsRight, pages, meta.page >= pages, 'hidden sm:inline-flex')}
        </div>
      </div>
    </nav>
  );
}
