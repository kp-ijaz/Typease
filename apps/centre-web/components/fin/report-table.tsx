'use client';

import * as React from 'react';
import { ChevronRight } from 'lucide-react';
import { Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn, useI18n } from '@typease/ui';
import { Money, TextLink } from './shared';
import type { ReportColumn, ReportRow } from './types';

/** Columns whose value names a record, the row field that holds its id and where that record lives. */
const COLUMN_LINKS: Record<string, { id: string; path: (id: string) => string }> = {
  refundNo: { id: 'refundId', path: (id) => `/refunds/${id}` },
  paymentNo: { id: 'paymentId', path: (id) => `/payments/${id}` },
  invoiceNo: { id: 'invoiceId', path: (id) => `/invoices/${id}` },
  requestNo: { id: 'requestId', path: (id) => `/requests/${id}` },
  customer: { id: 'customerId', path: (id) => `/customers/${id}` },
  company: { id: 'corporateAccountId', path: (id) => `/corporate/${id}` },
  service: { id: 'serviceId', path: (id) => `/services/${id}` },
  staff: { id: 'membershipId', path: (id) => `/staff/${id}` },
};
/** Drill-down rows carry `resourceType` + `id`: the record behind the line. */
const RESOURCE_PATHS: Record<string, (id: string) => string> = {
  Invoice: (id) => `/invoices/${id}`,
  Payment: (id) => `/payments/${id}`,
  Refund: (id) => `/refunds/${id}`,
  ServiceRequest: (id) => `/requests/${id}`,
  Customer: (id) => `/customers/${id}`,
};

/** Where a row of a drill-down (or a report whose rows are records) leads, if anywhere in this app. */
export function rowHref(row: ReportRow): string | null {
  const type = typeof row.resourceType === 'string' ? row.resourceType : null;
  const id = typeof row.id === 'string' ? row.id : null;
  if (type && id && RESOURCE_PATHS[type]) return RESOURCE_PATHS[type](id);
  if (type === 'ReminderSchedule' && typeof row.customerId === 'string') return `/reminders?customerId=${row.customerId}`;
  if (type === 'CustomerFeedback') {
    if (typeof row.requestId === 'string') return `/requests/${row.requestId}`;
    if (typeof row.ticketId === 'string') return `/support/${row.ticketId}`;
  }
  return null;
}

function useCell(currency: string) {
  const { formatNumber, formatDate } = useI18n();
  return React.useCallback(
    (column: ReportColumn, row: ReportRow, options: { links?: boolean; first?: boolean; totals?: boolean } = {}): React.ReactNode => {
      const value = row[column.key];
      if (value === null || value === undefined || value === '') return null;
      let node: React.ReactNode;
      switch (column.type) {
        case 'money':
          node = <Money amount={value as string} currency={currency} />;
          break;
        case 'number':
          node = <span className="tabular">{formatNumber(value as number, { maximumFractionDigits: 1 })}</span>;
          break;
        case 'percent':
          node = <span className="tabular">{formatNumber(value as number, { maximumFractionDigits: 1 })}%</span>;
          break;
        case 'date':
          // The totals row carries a caption ("Total") in the first column, whatever its type.
          node = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? <span className="tabular whitespace-nowrap">{formatDate(value)}</span> : <span dir="auto">{String(value)}</span>;
          break;
        default:
          node = <span dir="auto">{String(value)}</span>;
      }
      if (!options.links || options.totals) return node;
      const link = COLUMN_LINKS[column.key];
      const linkedId = link ? row[link.id] : null;
      if (link && typeof linkedId === 'string') return <TextLink href={link.path(linkedId)} className="font-normal">{node}</TextLink>;
      if (options.first) {
        const href = rowHref(row);
        if (href) return <TextLink href={href}>{node}</TextLink>;
      }
      return node;
    },
    [currency, formatNumber, formatDate],
  );
}

const isNumeric = (column: ReportColumn) => column.type === 'money' || column.type === 'number' || column.type === 'percent';

export interface ReportTableProps {
  caption: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  totals?: ReportRow | null;
  currency: string;
  /** Adds a "Details" button per row (report rows that can be drilled into). */
  onDrill?: (row: ReportRow) => void;
  drillLabel?: string;
  /** Turn record numbers and names into links (drill-downs and record-level reports). */
  links?: boolean;
  rowKey?: (row: ReportRow, index: number) => string;
}

/**
 * A report as the API describes it: typed columns (text, number, money, date, percent),
 * the rows, and a totals row. A table from `md` up; below that each row is a small card.
 */
export function ReportTable({ caption, columns, rows, totals, currency, onDrill, drillLabel, links, rowKey = (_, i) => String(i) }: ReportTableProps) {
  const cell = useCell(currency);
  const dash = <span className="text-muted-foreground">–</span>;
  const [first, ...rest] = columns;
  return (
    <>
      <div className="hidden md:block">
        <Table>
          <caption className="sr-only">{caption}</caption>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {columns.map((column) => (
                <TableHead key={column.key} className={cn('whitespace-normal py-2 leading-4', isNumeric(column) && 'text-end')}>
                  <span dir="auto">{column.label}</span>
                </TableHead>
              ))}
              {onDrill ? (
                // `relative`: keeps the visually hidden label inside the scrolling table instead of widening the page.
                <TableHead className="relative w-10">
                  <span className="sr-only">{drillLabel}</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, index) => (
              <TableRow key={rowKey(row, index)}>
                {columns.map((column, c) => (
                  <TableCell key={column.key} className={cn(isNumeric(column) && 'text-end', c === 0 && 'font-medium text-foreground', column.type === 'text' && c > 0 && 'max-w-xs')}>
                    {cell(column, row, { links, first: c === 0 }) ?? dash}
                  </TableCell>
                ))}
                {onDrill ? (
                  <TableCell className="px-2 text-end">
                    <Button variant="ghost" size="icon-sm" onClick={() => onDrill(row)} aria-label={`${drillLabel}: ${String(row[first.key] ?? '')}`} title={drillLabel}>
                      <ChevronRight className="rtl-mirror" aria-hidden="true" />
                    </Button>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
          {totals && rows.length > 0 ? (
            <tfoot className="border-t-2 bg-muted/50 font-semibold">
              <tr>
                {columns.map((column) => (
                  <td key={column.key} className={cn('px-4 py-3 align-middle', isNumeric(column) && 'text-end')}>
                    {cell(column, totals, { totals: true })}
                  </td>
                ))}
                {onDrill ? <td /> : null}
              </tr>
            </tfoot>
          ) : null}
        </Table>
      </div>

      <div className="md:hidden">
        <ul className="divide-y" aria-label={caption}>
          {rows.map((row, index) => (
            <li key={rowKey(row, index)} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 text-md font-semibold text-foreground">{cell(first, row, { links, first: true }) ?? dash}</p>
                {onDrill ? (
                  <Button variant="subtle" size="sm" onClick={() => onDrill(row)}>
                    {drillLabel}
                  </Button>
                ) : null}
              </div>
              <dl className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-sm">
                {rest.map((column) => {
                  const value = cell(column, row, { links });
                  return value === null ? null : (
                    <React.Fragment key={column.key}>
                      <dt className="text-muted-foreground" dir="auto">
                        {column.label}
                      </dt>
                      <dd className="min-w-0 text-end text-foreground">{value}</dd>
                    </React.Fragment>
                  );
                })}
              </dl>
            </li>
          ))}
        </ul>
        {totals && rows.length > 0 ? (
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 border-t-2 bg-muted/50 p-4 text-sm font-semibold">
            {columns.map((column) => {
              const value = cell(column, totals, { totals: true });
              return value === null ? null : (
                <React.Fragment key={column.key}>
                  <dt dir="auto">{column.label}</dt>
                  <dd className="text-end">{value}</dd>
                </React.Fragment>
              );
            })}
          </dl>
        ) : null}
      </div>
    </>
  );
}
