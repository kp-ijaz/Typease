'use client';

import * as React from 'react';
import Link from 'next/link';
import { Check, ChevronRight, Copy } from 'lucide-react';
import { cn, focusRing } from '../lib/cn';
import { useI18n } from '../i18n/provider';
import type { Tone } from '../lib/status-meta';
import { Button, type ButtonProps } from './button';
import { Skeleton } from './skeleton';

// ---------------------------------------------------------------- PageHeader

export interface Crumb {
  label: string;
  href?: string;
}
export interface PageHeaderProps {
  title: React.ReactNode;
  /** One sentence: what this page is for. */
  description?: React.ReactNode;
  /** Trail to this page, without the page itself. */
  breadcrumbs?: Crumb[];
  /** The ONE primary action of the page (spec section 2: one clear primary action per screen). */
  action?: React.ReactNode;
  /** Secondary actions (outline / ghost buttons, a menu). */
  secondary?: React.ReactNode;
  /** A status badge or other short meta next to the title. */
  meta?: React.ReactNode;
  className?: string;
}

/** The top of every page: breadcrumbs, the page's single <h1>, a description and the primary action. */
export function PageHeader({ title, description, breadcrumbs, action, secondary, meta, className }: PageHeaderProps) {
  const { t } = useI18n();
  return (
    <header className={cn('mb-6 space-y-3', className)}>
      {breadcrumbs?.length ? (
        <nav aria-label={t('shell.breadcrumb')}>
          <ol className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
            {breadcrumbs.map((crumb, i) => (
              <li key={`${crumb.label}-${i}`} className="flex items-center gap-1">
                {crumb.href ? (
                  <Link href={crumb.href} className={cn('rounded-sm hover:text-foreground hover:underline', focusRing)}>
                    {crumb.label}
                  </Link>
                ) : (
                  <span>{crumb.label}</span>
                )}
                <ChevronRight className="rtl-mirror size-3.5 opacity-60" aria-hidden="true" />
              </li>
            ))}
          </ol>
        </nav>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="min-w-0 flex-1 basis-72">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
            {meta}
          </div>
          {description ? <p className="mt-1.5 max-w-2xl text-base text-muted-foreground">{description}</p> : null}
        </div>
        {action || secondary ? (
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto [&>*]:flex-1 sm:[&>*]:flex-none">
            {secondary}
            {action}
          </div>
        ) : null}
      </div>
    </header>
  );
}

// ---------------------------------------------------------------- StatCard

const STAT_TONES: Record<Tone | 'brand', { card: string; tile: string }> = {
  info: { card: 'bg-info-soft/70 border-info/15', tile: 'bg-info text-info-foreground' },
  warning: { card: 'bg-warning-soft/80 border-warning/25', tile: 'bg-warning text-warning-foreground' },
  success: { card: 'bg-success-soft/70 border-success/15', tile: 'bg-success text-success-foreground' },
  danger: { card: 'bg-destructive-soft/70 border-destructive/15', tile: 'bg-destructive text-destructive-foreground' },
  neutral: { card: 'bg-card', tile: 'bg-muted text-muted-foreground' },
  brand: { card: 'bg-primary-soft/60 border-primary/10', tile: 'bg-primary text-primary-foreground' },
};

export interface StatCardProps {
  label: string;
  /** Already formatted (formatNumber / formatMoney). */
  value: React.ReactNode;
  icon: React.ReactNode;
  tone?: Tone | 'brand';
  /** Makes the whole tile a link to the list it counts. */
  href?: string;
  /** A short qualifier under the label ("today", "this month"). */
  hint?: string;
  loading?: boolean;
  className?: string;
}

/** A dashboard KPI tile: coloured icon tile, big number, label. The colour repeats what the label says; it is not the only signal. */
export function StatCard({ label, value, icon, tone = 'info', href, hint, loading, className }: StatCardProps) {
  const tones = STAT_TONES[tone];
  const body = (
    <>
      <span aria-hidden="true" className={cn('flex size-9 shrink-0 items-center justify-center rounded-md sm:size-11 sm:rounded-[0.625rem] [&_svg]:size-[1.125rem] sm:[&_svg]:size-5', tones.tile)}>
        {icon}
      </span>
      <span className="min-w-0">
        {loading ? <Skeleton className="mb-1.5 h-7 w-12 bg-foreground/10" /> : <span className="tabular block text-2xl font-semibold leading-7 text-foreground sm:text-3xl sm:leading-8">{value}</span>}
        <span className="mt-0.5 block text-sm font-medium leading-[1.15rem] text-foreground/80">{label}</span>
        {hint ? <span className="block truncate text-xs text-muted-foreground">{hint}</span> : null}
      </span>
    </>
  );
  const classes = cn('flex items-center gap-3 rounded-lg border p-3 sm:gap-4 sm:p-4', tones.card, className);
  return href ? (
    <Link href={href} className={cn(classes, 'transition-shadow hover:shadow-sm', focusRing)}>
      {body}
    </Link>
  ) : (
    <div className={classes}>{body}</div>
  );
}

// ---------------------------------------------------------------- DescriptionList

export interface DescriptionItem {
  label: string;
  value: React.ReactNode;
  /** Take the full width in a multi-column list (long text, addresses). */
  wide?: boolean;
}

/** Label / value pairs of a record. Empty values show a dash so the layout stays stable. */
export function DescriptionList({ items, columns = 2, className }: { items: DescriptionItem[]; columns?: 1 | 2 | 3; className?: string }) {
  return (
    <dl className={cn('grid gap-x-8 gap-y-4', columns === 2 && 'sm:grid-cols-2', columns === 3 && 'sm:grid-cols-2 lg:grid-cols-3', className)}>
      {items.map((item) => (
        <div key={item.label} className={cn('min-w-0', item.wide && 'sm:col-span-full')}>
          <dt className="text-sm text-muted-foreground">{item.label}</dt>
          <dd className="mt-0.5 break-words text-base text-foreground">{item.value === null || item.value === undefined || item.value === '' ? '–' : item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------- CopyButton

export interface CopyButtonProps extends Omit<ButtonProps, 'onClick' | 'children' | 'value'> {
  /** The text that goes to the clipboard. */
  value: string;
  /** What is being copied, for screen readers and the tooltip: "Copy request number". */
  label?: string;
  /** Show the label next to the icon. */
  showLabel?: boolean;
}

export function CopyButton({ value, label, showLabel, variant = 'ghost', size, className, ...props }: CopyButtonProps) {
  const { t } = useI18n();
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<number | undefined>(undefined);
  React.useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard API unavailable (insecure context): fall back to a temporary field.
      const el = document.createElement('textarea');
      el.value = value;
      el.setAttribute('readonly', '');
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      el.remove();
    }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 2000);
  };
  const text = copied ? t('common.copied') : label ?? t('common.copy');
  return (
    <Button variant={variant} size={size ?? (showLabel ? 'sm' : 'icon-sm')} onClick={copy} aria-label={showLabel ? undefined : text} title={showLabel ? undefined : text} className={className} {...props}>
      {copied ? <Check className="text-success-text" aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {showLabel ? <span>{text}</span> : null}
      <span className="sr-only" aria-live="polite">
        {copied ? t('common.copied') : ''}
      </span>
    </Button>
  );
}

// ---------------------------------------------------------------- Timeline

export interface TimelineItem {
  id: string;
  title: React.ReactNode;
  /** Already formatted date / time. */
  time?: React.ReactNode;
  description?: React.ReactNode;
  /** "done" = happened, "current" = where things stand now, "upcoming" = not yet. */
  state?: 'done' | 'current' | 'upcoming';
  tone?: Tone;
}

/** A vertical history: status changes of a request, activity on a record. Newest or oldest first: the caller decides and keeps it consistent. */
export function Timeline({ items, className }: { items: TimelineItem[]; className?: string }) {
  return (
    <ol className={cn('relative', className)}>
      {items.map((item, i) => {
        const state = item.state ?? 'done';
        const last = i === items.length - 1;
        return (
          <li key={item.id} className="relative flex gap-3.5 pb-6 last:pb-0" aria-current={state === 'current' ? 'step' : undefined}>
            {!last ? <span aria-hidden="true" className={cn('absolute bottom-0 start-[0.6875rem] top-6 w-px', state === 'upcoming' ? 'bg-border' : 'bg-success/40')} /> : null}
            <span
              aria-hidden="true"
              className={cn(
                'relative z-10 mt-0.5 flex size-[1.4375rem] shrink-0 items-center justify-center rounded-full border-2',
                state === 'done' && 'border-success bg-success text-success-foreground',
                state === 'current' && 'border-secondary bg-secondary text-secondary-foreground',
                state === 'upcoming' && 'border-input bg-card',
                item.tone === 'danger' && state !== 'upcoming' && 'border-destructive bg-destructive text-destructive-foreground',
                item.tone === 'warning' && state !== 'upcoming' && 'border-warning bg-warning text-warning-foreground',
              )}
            >
              {state === 'done' ? <Check className="size-3" strokeWidth={3.5} /> : state === 'current' ? <span className="size-2 rounded-full bg-current" /> : null}
            </span>
            <div className="min-w-0 flex-1">
              <p className={cn('text-base font-medium leading-6', state === 'upcoming' ? 'text-muted-foreground' : 'text-foreground')}>{item.title}</p>
              {item.time ? <p className="tabular text-sm text-muted-foreground">{item.time}</p> : null}
              {item.description ? <div className="mt-1 text-sm text-foreground/85">{item.description}</div> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------- Stepper

export interface StepperStep {
  id: string;
  label: string;
  description?: string;
}

/**
 * Progress through a multi-step form (wizard) or a process. The steps really
 * are a sequence, so they are numbered. On narrow screens only the current
 * step's name is written out, with "Step 2 of 5".
 */
export function Stepper({ steps, current, onStepClick, orientation = 'horizontal', className }: {
  steps: StepperStep[];
  /** Index of the current step. */
  current: number;
  /** Allow going back to a finished step by clicking it. */
  onStepClick?: (index: number) => void;
  orientation?: 'horizontal' | 'vertical';
  className?: string;
}) {
  const { t, formatNumber } = useI18n();
  const marker = (index: number) => {
    const done = index < current;
    const active = index === current;
    return (
      <span
        aria-hidden="true"
        className={cn(
          'tabular flex size-7 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold',
          done && 'border-success bg-success text-success-foreground',
          active && 'border-secondary bg-secondary text-secondary-foreground',
          !done && !active && 'border-input bg-card text-muted-foreground',
        )}
      >
        {done ? <Check className="size-3.5" strokeWidth={3.5} /> : formatNumber(index + 1)}
      </span>
    );
  };
  const content = (step: StepperStep, index: number) => {
    const clickable = !!onStepClick && index < current;
    const inner = (
      <>
        {marker(index)}
        <span className={cn('min-w-0 text-start', orientation === 'horizontal' && index !== current && 'hidden md:block')}>
          <span className={cn('block truncate text-sm font-medium', index <= current ? 'text-foreground' : 'text-muted-foreground')}>{step.label}</span>
          {step.description && orientation === 'vertical' ? <span className="block text-sm text-muted-foreground">{step.description}</span> : null}
        </span>
      </>
    );
    return clickable ? (
      <button type="button" onClick={() => onStepClick?.(index)} className={cn('flex min-w-0 items-center gap-2.5 rounded-md', focusRing)}>
        {inner}
      </button>
    ) : (
      <span className="flex min-w-0 items-center gap-2.5">{inner}</span>
    );
  };

  if (orientation === 'vertical') {
    return (
      <ol className={cn('space-y-0', className)}>
        {steps.map((step, index) => (
          <li key={step.id} aria-current={index === current ? 'step' : undefined} className="relative pb-5 last:pb-0">
            {index < steps.length - 1 ? <span aria-hidden="true" className={cn('absolute bottom-0 start-[0.8125rem] top-8 w-px', index < current ? 'bg-success/50' : 'bg-border')} /> : null}
            {content(step, index)}
          </li>
        ))}
      </ol>
    );
  }
  return (
    <div className={className}>
      <p className="mb-2 text-sm text-muted-foreground md:hidden">{t('common.step', { current: formatNumber(current + 1), total: formatNumber(steps.length) })}</p>
      <ol className="flex items-center gap-2">
        {steps.map((step, index) => (
          <li key={step.id} aria-current={index === current ? 'step' : undefined} className={cn('flex min-w-0 items-center gap-2', index < steps.length - 1 && 'flex-1')}>
            {content(step, index)}
            {index < steps.length - 1 ? <span aria-hidden="true" className={cn('h-px min-w-3 flex-1', index < current ? 'bg-success/60' : 'bg-border')} /> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
