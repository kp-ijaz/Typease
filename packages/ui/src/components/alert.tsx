import * as React from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { cn } from '../lib/cn';

const TONES = {
  info: { box: 'border-info/25 bg-info-soft', icon: 'text-info-text', Icon: Info },
  success: { box: 'border-success/25 bg-success-soft', icon: 'text-success-text', Icon: CheckCircle2 },
  warning: { box: 'border-warning/40 bg-warning-soft', icon: 'text-warning-text', Icon: AlertTriangle },
  danger: { box: 'border-destructive/25 bg-destructive-soft', icon: 'text-destructive-text', Icon: XCircle },
} as const;

export interface AlertProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  tone?: keyof typeof TONES;
  title?: React.ReactNode;
  /** A button or link that resolves the situation ("Try again", "Upgrade plan"). */
  action?: React.ReactNode;
  /** Errors and warnings that appear after an action are announced immediately. */
  live?: boolean;
}

/** An inline banner: explains a state of the page or the result of an action, next to where it matters. */
export function Alert({ tone = 'info', title, action, live, className, children, ...props }: AlertProps) {
  const { box, icon, Icon } = TONES[tone];
  return (
    <div role={live ? (tone === 'danger' || tone === 'warning' ? 'alert' : 'status') : undefined} className={cn('flex gap-3 rounded-lg border p-3.5 text-base text-foreground', box, className)} {...props}>
      <Icon className={cn('mt-0.5 size-5 shrink-0', icon)} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold leading-6">{title}</p> : null}
        {children ? <div className={cn('text-foreground/90', title && 'mt-0.5')}>{children}</div> : null}
        {action ? <div className="mt-2.5 flex flex-wrap gap-2">{action}</div> : null}
      </div>
    </div>
  );
}
