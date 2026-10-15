'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn';
import { useI18n } from '../i18n/provider';
import { statusMeta, type StatusKind, type Tone } from '../lib/status-meta';

export const badgeVariants = cva('inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium leading-5', {
  variants: {
    tone: {
      neutral: 'bg-muted text-muted-foreground',
      info: 'bg-info-soft text-info-text',
      warning: 'bg-warning-soft text-warning-text',
      success: 'bg-success-soft text-success-text',
      danger: 'bg-destructive-soft text-destructive-text',
      brand: 'bg-secondary-soft text-secondary-text',
      outline: 'border bg-transparent text-foreground',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  /** A small dot in the tone's colour before the text. */
  dot?: boolean;
  /** A small icon before the text (sized by the badge). */
  icon?: React.ReactNode;
}

export function Badge({ className, tone, dot, icon, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props}>
      {dot ? <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current opacity-80" /> : null}
      {icon ? <span aria-hidden="true" className="shrink-0 [&_svg]:size-3">{icon}</span> : null}
      <span className="truncate">{children}</span>
    </span>
  );
}

export interface StatusBadgeProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
  /** Which family the status belongs to. Request statuses use REQUEST_STATUS_META from @typease/types. */
  kind: StatusKind;
  status: string;
  /**
   * A label already worded by the API for this viewer ({ en, ar }, e.g. `statusLabel`
   * of a request, which is the customer wording for customers). Wins over the built-in label.
   */
  label?: { en: string; ar: string } | null;
  dot?: boolean;
}

/**
 * The status of a request, invoice, payment, document ... as a tinted pill.
 * Colour is never the only signal: the pill always carries the status in words.
 *
 *   <StatusBadge kind="request" status={row.status} label={row.statusLabel} />
 *   <StatusBadge kind="invoice" status={invoice.status} />
 */
export function StatusBadge({ kind, status, label, dot = false, className, ...props }: StatusBadgeProps) {
  const { pick } = useI18n();
  const meta = statusMeta(kind, status);
  const tone: Tone = meta.tone;
  return (
    <Badge tone={tone} dot={dot} className={className} data-status={status} {...props}>
      {label ? pick(label.en, label.ar) : pick(meta.en, meta.ar)}
    </Badge>
  );
}
