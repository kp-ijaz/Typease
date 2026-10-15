'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient, type QueryKey, type UseQueryResult } from '@tanstack/react-query';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { isApiError } from '@typease/api-client';
import {
  Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ChoiceLabel, ConfirmDialog, Label, Skeleton, Switch, cn, useErrorMessage, useI18n, useToast, type Tone,
} from '@typease/ui';

// ---------------------------------------------------------------- loading / error of a read

/**
 * The three states of a read, where the data would be: a skeleton of the same
 * shape while loading, an alert with "Try again" on failure, the content otherwise.
 */
export function Loadable<T>({ query, skeleton, children }: { query: UseQueryResult<T>; skeleton?: React.ReactNode; children: (data: T) => React.ReactNode }) {
  const { t } = useI18n();
  const describe = useErrorMessage();
  if (query.isPending) return <>{skeleton ?? <Skeleton className="h-40 w-full" />}</>;
  if (query.isError) {
    return (
      <Alert
        tone="danger"
        action={
          <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
            {t('common.retry')}
          </Button>
        }
      >
        {describe(query.error)}
      </Alert>
    );
  }
  return <>{children(query.data)}</>;
}

export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
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
  /** Handle a specific failure yourself; return true when it was handled (no toast). */
  onError?: (error: unknown) => boolean;
}

/**
 * Runs a write that does not live in a `<Form>`: shows progress on the button
 * that was pressed (`busy === id`), the API's own message on failure, a toast on success.
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
        if (!options.onError?.(error)) toasts.error(error);
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

/** 402: the centre's plan does not include the feature. */
export const isPlanError = (error: unknown) => isApiError(error) && (error.status === 402 || error.code === 'PLAN_LIMIT_REACHED');

// ---------------------------------------------------------------- URL state

/**
 * One query parameter as state (`?tab=pricing`). The pages of the staff shell
 * mount in the browser only (after the session check), so reading the URL in
 * the initial state cannot cause a hydration mismatch. After a client-side
 * navigation the address bar is updated while the new page mounts, so the URL
 * is read once more right after mount.
 */
const readParam = (key: string) => (typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get(key));

export function useUrlState(key: string, fallback: string): [string, (value: string) => void] {
  const [value, setValue] = React.useState<string>(() => readParam(key) || fallback);
  React.useEffect(() => {
    setValue(readParam(key) || fallback);
  }, [key, fallback]);
  const set = React.useCallback(
    (next: string) => {
      setValue(next);
      const url = new URL(window.location.href);
      if (!next || next === fallback) url.searchParams.delete(key);
      else url.searchParams.set(key, next);
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    },
    [key, fallback],
  );
  return [value, set];
}

/** Reads a query parameter (deep links such as /reminders?customerId=). */
export function useUrlParam(key: string): string | undefined {
  const [value, setValue] = React.useState(() => readParam(key) || undefined);
  React.useEffect(() => {
    setValue(readParam(key) || undefined);
  }, [key]);
  return value;
}

// ---------------------------------------------------------------- leaving an editor with unsaved changes

/**
 * Put it inside an editor that keeps its own draft: while `when` is true, closing or
 * reloading the tab asks the browser's own question, and a click on a link to another
 * page of the app first asks "Leave without saving?".
 */
export function LeaveGuard({ when }: { when: boolean }) {
  const { t } = useI18n();
  const router = useRouter();
  const [href, setHref] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!when) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!link || link.target === '_blank' || link.hasAttribute('download') || link.origin !== window.location.origin || link.pathname === window.location.pathname) return;
      e.preventDefault();
      e.stopPropagation();
      setHref(`${link.pathname}${link.search}${link.hash}`);
    };
    window.addEventListener('beforeunload', warn);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', warn);
      document.removeEventListener('click', onClick, true);
    };
  }, [when]);
  return (
    <ConfirmDialog
      open={!!href}
      onOpenChange={(open) => !open && setHref(null)}
      title={t('ops.common.leaveTitle')}
      description={t('ops.common.leaveText')}
      confirmLabel={t('ops.common.leaveConfirm')}
      cancelLabel={t('ops.common.leaveStay')}
      onConfirm={() => {
        const to = href;
        setHref(null);
        if (to) router.push(to);
      }}
    />
  );
}

// ---------------------------------------------------------------- small building blocks

/** A titled card: the standard section of a detail or settings page. */
export function Panel({ title, description, action, children, className, bodyClassName }: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader>
        <div className="min-w-0 flex-1 basis-60">
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        {action ? <div className="flex flex-wrap items-center gap-2">{action}</div> : null}
      </CardHeader>
      <CardContent className={bodyClassName}>{children}</CardContent>
    </Card>
  );
}

/** A labelled control for editors that keep their own state (builders); forms use `<FormField>`. */
export function Field({ label, hint, error, optional, required, className, children }: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  optional?: boolean;
  required?: boolean;
  className?: string;
  children: (props: { id: string; 'aria-invalid': boolean; 'aria-describedby': string | undefined }) => React.ReactNode;
}) {
  const { t } = useI18n();
  const id = React.useId();
  const noteId = `${id}-note`;
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id} required={required} optionalText={optional ? t('common.optional') : undefined}>
        {label}
      </Label>
      {children({ id, 'aria-invalid': !!error, 'aria-describedby': error || hint ? noteId : undefined })}
      {error ? (
        <p id={noteId} role="alert" className="text-sm text-destructive-text">
          {error}
        </p>
      ) : hint ? (
        <p id={noteId} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** A switch with its label and a sentence about what it does. */
export function SwitchRow({ label, description, checked, onCheckedChange, disabled, className }: {
  label: React.ReactNode;
  description?: React.ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  const id = React.useId();
  return <ChoiceLabel className={className} htmlFor={id} control={<Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />} label={label} description={description} />;
}

/** "Move up" / "Move down" for ordered lists (keyboard-friendly alternative to dragging). */
export function MoveButtons({ index, count, onMove, name, disabled }: { index: number; count: number; onMove: (from: number, to: number) => void; name: string; disabled?: boolean }) {
  const { t } = useI18n();
  return (
    <span className="inline-flex shrink-0">
      <Button variant="ghost" size="icon-sm" disabled={disabled || index === 0} onClick={() => onMove(index, index - 1)} aria-label={t('ops.common.moveUp', { name })} title={t('ops.common.moveUp', { name })}>
        <ArrowUp aria-hidden="true" />
      </Button>
      <Button variant="ghost" size="icon-sm" disabled={disabled || index === count - 1} onClick={() => onMove(index, index + 1)} aria-label={t('ops.common.moveDown', { name })} title={t('ops.common.moveDown', { name })}>
        <ArrowDown aria-hidden="true" />
      </Button>
    </span>
  );
}

export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length || from === to) return list;
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

// ---------------------------------------------------------------- statuses of this section

/**
 * Statuses that the shared status-meta does not cover yet (queue tokens, reminder
 * schedules and their dispatches, notification deliveries, automation executions,
 * form / workflow versions). The words come from the section dictionary
 * (`ops.status.<kind>.<STATUS>`); the tone is fixed here.
 */
const TONES: Record<string, Record<string, Tone>> = {
  queue: { WAITING: 'info', CALLED: 'warning', SERVING: 'warning', COMPLETED: 'success', NO_SHOW: 'danger', CANCELLED: 'neutral' },
  reminder: { ACTIVE: 'success', PAUSED: 'warning', COMPLETED: 'neutral', CANCELLED: 'neutral' },
  dispatch: { SENT: 'success', FAILED: 'danger', CANCELLED: 'neutral', SKIPPED_NO_CONSENT: 'warning', SKIPPED_OPT_OUT: 'warning', PENDING: 'info' },
  delivery: { QUEUED: 'info', SENT: 'success', DELIVERED: 'success', FAILED: 'danger', SUPPRESSED: 'neutral' },
  execution: { PENDING: 'info', RUNNING: 'info', SUCCEEDED: 'success', FAILED: 'warning', SKIPPED: 'neutral', DEAD_LETTER: 'danger' },
  version: { DRAFT: 'warning', PUBLISHED: 'success', ARCHIVED: 'neutral' },
};
export type OpsStatusKind = 'queue' | 'reminder' | 'dispatch' | 'delivery' | 'execution' | 'version';

export function OpsStatusBadge({ kind, status, className }: { kind: OpsStatusKind; status: string; className?: string }) {
  const { t, has } = useI18n();
  const key = `ops.status.${kind}.${status}`;
  const label = has(key) ? t(key) : status.toLowerCase().replace(/_/g, ' ');
  return (
    <Badge tone={TONES[kind]?.[status] ?? 'neutral'} className={className} data-status={status}>
      {label}
    </Badge>
  );
}

/** Seconds as "4 min" / "1 h 20 min" for waiting-time figures. */
export function useDuration() {
  const { t, formatNumber } = useI18n();
  return React.useCallback(
    (seconds: number | null | undefined) => {
      if (seconds === null || seconds === undefined) return '–';
      const minutes = Math.round(seconds / 60);
      if (minutes < 60) return t('ops.common.minutes', { count: formatNumber(minutes) });
      return t('ops.common.hoursMinutes', { hours: formatNumber(Math.floor(minutes / 60)), minutes: formatNumber(minutes % 60) });
    },
    [t, formatNumber],
  );
}
