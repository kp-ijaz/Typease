import * as React from 'react';
import { cn } from '../lib/cn';

/** A grey placeholder with the shape of the content that is loading. Purely decorative: hidden from screen readers. */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
}

/** Lines of text of slightly different lengths. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  const widths = ['w-full', 'w-11/12', 'w-4/5', 'w-2/3', 'w-5/6'];
  return (
    <div aria-hidden="true" className={cn('space-y-2.5', className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn('h-3.5', i === lines - 1 ? 'w-1/2' : widths[i % widths.length])} />
      ))}
    </div>
  );
}
