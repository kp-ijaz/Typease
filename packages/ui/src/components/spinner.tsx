import * as React from 'react';
import { cn } from '../lib/cn';

const SIZES = { xs: 'size-3 border-[1.5px]', sm: 'size-4 border-2', md: 'size-6 border-2', lg: 'size-9 border-[3px]' } as const;

export interface SpinnerProps extends React.HTMLAttributes<HTMLSpanElement> {
  size?: keyof typeof SIZES;
  /** Read by screen readers; omit when a visible label sits next to the spinner. */
  label?: string;
}

/** A quiet circular activity indicator in the current text colour. */
export function Spinner({ size = 'md', label, className, ...props }: SpinnerProps) {
  return (
    <span role={label ? 'status' : undefined} aria-label={label} className={cn('inline-block', className)} {...props}>
      <span aria-hidden="true" className={cn('block animate-spin rounded-full border-current border-e-transparent opacity-80', SIZES[size])} />
    </span>
  );
}

/** Centred spinner with a caption, for a whole page or panel that is still loading. */
export function LoadingBlock({ label, className }: { label: string; className?: string }) {
  return (
    <div role="status" className={cn('flex min-h-40 flex-col items-center justify-center gap-3 text-muted-foreground', className)}>
      <Spinner size="lg" />
      <p className="text-sm">{label}</p>
    </div>
  );
}
