'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, ConfirmDialog, Label, Skeleton, Textarea, cn, focusRing, useErrorMessage, useI18n, useToast } from '@typease/ui';

// ---------------------------------------------------------------- small pieces

/** An amount from the API (decimal string). Always left-to-right digits, never wrapped. */
export function Money({ amount, currency, className }: { amount: string | number | null | undefined; currency?: string | null; className?: string }) {
  const { formatMoney } = useI18n();
  return <span className={cn('tabular whitespace-nowrap', className)}>{formatMoney(amount, currency)}</span>;
}

/** A link that reads as text inside tables and lists. */
export function TextLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <Link href={href} className={cn('rounded-sm font-medium text-secondary-text hover:underline', focusRing, className)}>
      {children}
    </Link>
  );
}

/** A centre by name with its address part underneath, linked to its page. Names are data: shown as stored. */
export function CentreCell({ centre, link = true }: { centre: { id: string; name: string | null; slug: string | null }; link?: boolean }) {
  const name = <bdi>{centre.name ?? centre.slug ?? centre.id.slice(0, 8)}</bdi>;
  return (
    <span className="block min-w-0">
      {link ? <TextLink href={`/tenants/${centre.id}`}>{name}</TextLink> : <span className="font-medium text-foreground">{name}</span>}
      {centre.slug ? <span className="ltr-value block truncate text-sm font-normal text-muted-foreground">{centre.slug}</span> : null}
    </span>
  );
}

/** "3 hours ago", written after mount: relative time depends on the clock and must not differ between server and browser. */
export function RelativeTime({ value, className }: { value: string | null | undefined; className?: string }) {
  const { formatRelative, formatDateTime } = useI18n();
  const [text, setText] = React.useState('');
  React.useEffect(() => setText(value ? formatRelative(value) : ''), [value, formatRelative]);
  if (!value) return null;
  return (
    <time dateTime={value} title={formatDateTime(value)} className={cn('tabular', className)}>
      {text || formatDateTime(value)}
    </time>
  );
}

/** A code-like value (flag key, audit action, provider code): monospace, always left to right. */
export function Code({ children, className }: { children: React.ReactNode; className?: string }) {
  return <code className={cn('ltr-value rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground', className)}>{children}</code>;
}

/** Two to four mutually exclusive views of a list ("Open / All"), as one compact control. */
export function Segmented<V extends string>({ label, value, onChange, options, className }: { label: string; value: V; onChange: (value: V) => void; options: Array<{ value: V; label: string }>; className?: string }) {
  return (
    <div role="group" aria-label={label} className={cn('inline-flex max-w-full rounded-lg border bg-card p-1', className)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn('min-h-8 rounded-md px-3 py-1 text-sm font-medium transition-colors', value === option.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground', focusRing)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- reads

/** Failed read: the message where the data would be, with a retry. */
export function LoadError({ error, onRetry, className, lead }: { error: unknown; onRetry?: () => void; className?: string; lead?: string }) {
  const { t } = useI18n();
  const describe = useErrorMessage();
  return (
    <Alert
      tone="danger"
      className={className}
      action={
        onRetry ? (
          <Button size="sm" variant="outline" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        ) : undefined
      }
    >
      {lead ? `${lead} ` : null}
      {describe(error)}
    </Alert>
  );
}

export function RowsSkeleton({ rows = 4, className }: { rows?: number; className?: string }) {
  const { t } = useI18n();
  return (
    <div role="status" aria-label={t('common.loading')} className={cn('space-y-3 p-5', className)}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

/** Shape of a detail page while it loads: header, a wide card and a side card. */
export function DetailSkeleton() {
  const { t } = useI18n();
  return (
    <div role="status" aria-label={t('common.loading')} className="space-y-6">
      <div className="space-y-2.5">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <Skeleton className="h-80 lg:col-span-2" />
        <Skeleton className="h-80" />
      </div>
    </div>
  );
}

/** A plain titled card. `flush` = the content brings its own padding (tables, lists). */
export function Section({ title, description, action, children, className, flush }: { title: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string; flush?: boolean }) {
  return (
    <Card className={cn('min-w-0', className)}>
      <CardHeader className={cn('items-center', flush ? 'pb-4' : 'pb-0')}>
        <div className="min-w-0">
          <CardTitle>{title}</CardTitle>
          {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {action}
      </CardHeader>
      {flush ? <div className="border-t">{children}</div> : <CardContent className="pt-0">{children}</CardContent>}
    </Card>
  );
}

/** A labelled control that is not part of a React Hook Form. */
export function Field({ label, hint, htmlFor, children, className }: { label: React.ReactNode; hint?: React.ReactNode; htmlFor?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={htmlFor} className="block text-sm font-medium leading-5 text-foreground">
        {label}
      </label>
      {children}
      {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------- writes outside a form

export interface RunOptions<T> {
  /** Toast after success. */
  success?: string | ((result: T) => string);
  description?: string | ((result: T) => string | undefined);
  /** Query key prefixes to refresh. */
  invalidate?: QueryKey[];
  /** Re-throw after the error toast (ConfirmDialog stays open when its onConfirm throws). */
  rethrow?: boolean;
}

/**
 * Runs a write that does not live in a `<Form>`: progress on the button that was
 * pressed (`busy === id`), the API's own message on failure, a toast on success.
 */
export function useRun() {
  const toasts = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = React.useState<string | null>(null);
  const run = React.useCallback(
    async <T,>(id: string, fn: () => Promise<T>, options: RunOptions<T> = {}): Promise<T | undefined> => {
      setBusy(id);
      try {
        const result = await fn();
        if (options.invalidate) await Promise.all(options.invalidate.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
        if (options.success) {
          const description = typeof options.description === 'function' ? options.description(result) : options.description;
          toasts.success(typeof options.success === 'function' ? options.success(result) : options.success, description);
        }
        return result;
      } catch (error) {
        toasts.error(error);
        if (options.rethrow) throw error;
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [toasts, queryClient],
  );
  return { run, busy };
}

// ---------------------------------------------------------------- confirmation with a reason

/**
 * <ConfirmDialog> for far-reaching actions the API wants a reason for (suspend, close,
 * reject, void, change plan ...). The reason is mandatory unless `required` is false; it
 * goes to the API and from there to the audit trail. `onConfirm` may throw: the dialog
 * stays open, what was typed stays, and the API's own message appears under the field.
 */
export function ConfirmReasonDialog({
  open, onOpenChange, title, description, confirmLabel, tone = 'destructive', label, hint, required = true, minLength = 5, maxLength = 500, typedConfirmation, onConfirm, children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  tone?: 'destructive' | 'default';
  /** Label of the text field ("Reason", "Note for the centre"). */
  label: string;
  hint?: string;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  typedConfirmation?: string;
  onConfirm: (reason: string) => Promise<void>;
  /** Extra content above the field (further inputs, what will happen). */
  children?: React.ReactNode;
}) {
  const { t } = useI18n();
  const describe = useErrorMessage();
  const id = React.useId();
  const [reason, setReason] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (open) {
      setReason('');
      setError(null);
    }
  }, [open]);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      tone={tone}
      typedConfirmation={typedConfirmation}
      onConfirm={async () => {
        const text = reason.trim();
        if ((required || text.length > 0) && text.length < minLength) {
          setError(text.length === 0 ? t('validation.required') : t('validation.minLength', { min: minLength }));
          document.getElementById(id)?.focus();
          throw new Error('invalid');
        }
        setError(null);
        try {
          await onConfirm(text);
        } catch (e) {
          setError(describe(e));
          throw e;
        }
      }}
    >
      <div className="space-y-4">
        {children}
        <div className="space-y-1.5">
          <Label htmlFor={id} required={required} optionalText={required ? undefined : t('common.optional')}>
            {label}
          </Label>
          <Textarea
            id={id}
            rows={3}
            dir="auto"
            value={reason}
            maxLength={maxLength}
            aria-invalid={!!error}
            aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
            aria-required={required || undefined}
            onChange={(e) => {
              setReason(e.target.value);
              if (error) setError(null);
            }}
          />
          {error ? (
            <p id={`${id}-error`} role="alert" className="text-sm text-destructive-text">
              {error}
            </p>
          ) : hint ? (
            <p id={`${id}-hint`} className="text-sm text-muted-foreground">
              {hint}
            </p>
          ) : null}
        </div>
      </div>
    </ConfirmDialog>
  );
}

/**
 * <ConfirmDialog> for an action without a reason. The failure message is shown inside the
 * dialog (it stays open), so nothing is lost behind a toast.
 */
export function ConfirmAction({
  open, onOpenChange, title, description, confirmLabel, tone = 'destructive', typedConfirmation, onConfirm, children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  tone?: 'destructive' | 'default';
  typedConfirmation?: string;
  onConfirm: () => Promise<void>;
  children?: React.ReactNode;
}) {
  const describe = useErrorMessage();
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (open) setError(null);
  }, [open]);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      tone={tone}
      typedConfirmation={typedConfirmation}
      onConfirm={async () => {
        setError(null);
        try {
          await onConfirm();
        } catch (e) {
          setError(describe(e));
          throw e;
        }
      }}
    >
      {children || error ? (
        <div className="space-y-3">
          {children}
          {error ? (
            <Alert tone="danger" live>
              {error}
            </Alert>
          ) : null}
        </div>
      ) : null}
    </ConfirmDialog>
  );
}

// ---------------------------------------------------------------- URL state

const readParam = (name: string) => (typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get(name));

/**
 * One query parameter as state (`?tab=billing`). The pages of the console mount in the
 * browser only (after the session check), so reading the URL in the initial state cannot
 * cause a hydration mismatch.
 */
export function useUrlState(name: string, fallback: string): [string, (value: string) => void] {
  const [value, setValue] = React.useState<string>(() => readParam(name) || fallback);
  React.useEffect(() => {
    setValue(readParam(name) || fallback);
  }, [name, fallback]);
  const set = React.useCallback(
    (next: string) => {
      setValue(next);
      const url = new URL(window.location.href);
      if (!next || next === fallback) url.searchParams.delete(name);
      else url.searchParams.set(name, next);
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    },
    [name, fallback],
  );
  return [value, set];
}

// ---------------------------------------------------------------- lists that the API returns whole

type SortValue = string | number | null | undefined;

/**
 * Some platform endpoints return a plain array (staff, coupons, flags). This turns such an
 * array into the `{ data, meta }` page <DataTable> expects: sorted and cut in the browser.
 */
export function pageOf<T>(rows: T[], params: { page?: number; pageSize?: number; sort?: string }, sorters: Record<string, (row: T) => SortValue> = {}) {
  const [field, direction] = (params.sort ?? '').split(':');
  const by = sorters[field];
  const sorted = by
    ? [...rows].sort((a, b) => {
        const x = by(a);
        const y = by(b);
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        const order = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { sensitivity: 'base', numeric: true });
        return direction === 'desc' ? -order : order;
      })
    : rows;
  const pageSize = params.pageSize ?? 20;
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const page = Math.min(params.page ?? 1, totalPages);
  return { data: sorted.slice((page - 1) * pageSize, page * pageSize), meta: { page, pageSize, total: sorted.length, totalPages } };
}

/** Text search over an array, in the browser, for endpoints without a `q` parameter. */
export function matches(needle: string | undefined, ...haystack: Array<string | null | undefined>): boolean {
  const q = (needle ?? '').trim().toLowerCase();
  return !q || haystack.some((h) => (h ?? '').toLowerCase().includes(q));
}
