import * as React from 'react';
import { cn } from '../lib/cn';

/** Plain table parts with the system's spacing. For server-backed lists use <DataTable>. */
export const Table = React.forwardRef<HTMLTableElement, React.TableHTMLAttributes<HTMLTableElement> & { containerClassName?: string }>(function Table(
  { className, containerClassName, ...props },
  ref,
) {
  return (
    // `relative`: visually hidden labels inside (an "Actions" heading, the caption) are absolutely positioned;
    // without a positioned ancestor they are laid out against the PAGE and widen it by the table's scroll width.
    <div className={cn('scroll-quiet relative w-full overflow-x-auto', containerClassName)}>
      <table ref={ref} className={cn('w-full caption-bottom border-collapse text-base', className)} {...props} />
    </div>
  );
});
export function TableHeader({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn('border-b bg-muted/50', className)} {...props} />;
}
export function TableBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn('[&_tr:last-child]:border-0', className)} {...props} />;
}
export function TableRow({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn('border-b transition-colors data-[clickable=true]:cursor-pointer hover:bg-muted/40', className)} {...props} />;
}
export function TableHead({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return <th scope="col" className={cn('relative h-10 whitespace-nowrap px-4 text-start align-middle text-xs font-semibold text-muted-foreground', className)} {...props} />;
}
export function TableCell({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('px-4 py-3 align-middle', className)} {...props} />;
}
export function TableCaption({ className, ...props }: React.HTMLAttributes<HTMLTableCaptionElement>) {
  return <caption className={cn('sr-only', className)} {...props} />;
}
