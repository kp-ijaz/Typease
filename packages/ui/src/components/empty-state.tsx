import * as React from 'react';
import { cn } from '../lib/cn';

export interface EmptyStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  /** A lucide icon element. */
  icon?: React.ReactNode;
  title: React.ReactNode;
  /** What this place is for and what to do next. */
  description?: React.ReactNode;
  /** The one action that fills the emptiness ("Add customer"). */
  action?: React.ReactNode;
  /** "page" for a whole empty page, "inline" inside a card or table. */
  size?: 'page' | 'inline';
}

/** An empty screen is an invitation to act: say what belongs here and offer the next step. */
export function EmptyState({ icon, title, description, action, size = 'inline', className, ...props }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', size === 'page' ? 'px-6 py-20' : 'px-6 py-12', className)} {...props}>
      {icon ? (
        <span aria-hidden="true" className="mb-4 flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground [&_svg]:size-6">
          {icon}
        </span>
      ) : null}
      <p className="text-md font-semibold text-foreground">{title}</p>
      {description ? <p className="mt-1.5 max-w-md text-base text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}
