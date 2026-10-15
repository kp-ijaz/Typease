'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowUpCircle, Search } from 'lucide-react';
import { isApiError } from '@typease/api-client';
import { Alert, Button, Card, Checkbox, ChoiceLabel, Input, Skeleton, Switch, cn, useErrorMessage, useI18n, useToast } from '@typease/ui';
import type { WorkingHours } from './types';

// ---------------------------------------------------------------- errors

/**
 * Codes whose API message is specific to the situation ("Your plan includes 1 branches ...",
 * "Changing roles requires ..."), while the shared dictionary only has a general sentence for the code.
 */
const SPECIFIC_MESSAGE_CODES = new Set(['PLAN_LIMIT_REACHED', 'FORBIDDEN', 'CONFLICT']);

export const isPlanLimit = (error: unknown): boolean => isApiError(error) && (error.status === 402 || error.code === 'PLAN_LIMIT_REACHED');

/** The sentence for a failed call, preferring the API's own wording where it explains more than the general one. */
export function useApiMessage(): (error: unknown) => string {
  const describe = useErrorMessage();
  return React.useCallback((error: unknown) => (isApiError(error) && SPECIFIC_MESSAGE_CODES.has(error.code) && error.message ? error.message : describe(error)), [describe]);
}

/** `fail(error)` shows a failure toast with the API's own message. */
export function useFailToast(): (error: unknown) => void {
  const toasts = useToast();
  const message = useApiMessage();
  return React.useCallback((error: unknown) => toasts.error(message(error)), [toasts, message]);
}

/** "This is not in your plan / the limit is reached": the API's message and the way out. */
export function PlanLimitAlert({ error, message, className }: { error?: unknown; message?: string; className?: string }) {
  const { t } = useI18n();
  const text = message ?? (isApiError(error) ? error.message : '');
  return (
    <Alert
      tone="warning"
      live={!!error}
      className={className}
      title={t('adm.plan.limitTitle')}
      action={
        <Button asChild size="sm" variant="outline">
          <Link href="/subscription">
            <ArrowUpCircle aria-hidden="true" />
            {t('adm.plan.seePlans')}
          </Link>
        </Button>
      }
    >
      <span dir="auto">{text}</span>
    </Alert>
  );
}

/** A failed save inside a dialog that does not use <Form>: the plan-limit explanation or a plain error line. */
export function ActionError({ error, className }: { error: unknown; className?: string }) {
  const message = useApiMessage();
  if (!error) return null;
  if (isPlanLimit(error)) return <PlanLimitAlert error={error} className={className} />;
  return (
    <Alert tone="danger" live className={className}>
      <span dir="auto">{message(error)}</span>
    </Alert>
  );
}

/** A failed READ, shown where the data would be, with "Try again". */
export function LoadError({ error, onRetry, className }: { error: unknown; onRetry: () => void; className?: string }) {
  const { t } = useI18n();
  const message = useApiMessage();
  return (
    <Alert
      tone="danger"
      className={className}
      action={
        <Button size="sm" variant="outline" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      }
    >
      {message(error)}
    </Alert>
  );
}

/** Skeleton of a card with a few lines: the first load of a settings card. */
export function CardSkeleton({ lines = 4, className }: { lines?: number; className?: string }) {
  return (
    <Card className={cn('space-y-4 p-5', className)}>
      <Skeleton className="h-5 w-48" />
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn('h-10', i % 2 ? 'w-2/3' : 'w-full')} />
      ))}
    </Card>
  );
}

// ---------------------------------------------------------------- small inputs

/** A time of day as "HH:MM" (24 h), with the browser's own picker. */
export const TimeInput = React.forwardRef<HTMLInputElement, Omit<React.ComponentProps<typeof Input>, 'type' | 'onChange' | 'value'> & { value: string; onChange: (value: string) => void }>(
  function TimeInput({ value, onChange, className, ...props }, ref) {
    return <Input ref={ref} type="time" dir="ltr" value={value} onChange={(e) => onChange(e.target.value.slice(0, 5))} className={cn('tabular w-[6.75rem] min-w-0 max-sm:[&::-webkit-calendar-picker-indicator]:hidden sm:w-[7.5rem]', className)} {...props} />;
  },
);

/** Keeps the selected tab visible when the row of tabs scrolls sideways (phones, long Arabic labels). */
export function useActiveTabInView(tab: string) {
  React.useEffect(() => {
    document.querySelector<HTMLElement>('main [role="tablist"] [role="tab"][data-state="active"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [tab]);
}

export const WEEKDAYS = ['0', '1', '2', '3', '4', '5', '6'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
/** The week as people in the UAE read it: Monday first, the weekend last. */
export const WEEK_ORDER: Weekday[] = ['1', '2', '3', '4', '5', '6', '0'];

const DEFAULT_DAY = { open: '09:00', close: '18:00' };

/**
 * Opening hours per weekday: a switch for open / closed and two times. "Same hours every day" copies the
 * first open day to the others. A day whose closing time is not after its opening time is marked.
 */
export function WorkingHoursEditor({ value, onChange, disabled }: { value: WorkingHours; onChange: (next: WorkingHours) => void; disabled?: boolean }) {
  const { t } = useI18n();
  const id = React.useId();
  const firstOpen = WEEK_ORDER.map((d) => value[d]).find(Boolean) ?? null;
  return (
    <div className="space-y-2">
      <ul className="divide-y rounded-lg border">
        {WEEK_ORDER.map((day) => {
          const hours = value[day] ?? null;
          const invalid = !!hours && hours.open >= hours.close;
          return (
            <li key={day} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5">
              <div className="flex w-36 shrink-0 items-center gap-3">
                <Switch
                  id={`${id}-${day}`}
                  checked={!!hours}
                  disabled={disabled}
                  onCheckedChange={(open) => onChange({ ...value, [day]: open ? (firstOpen ?? DEFAULT_DAY) : null })}
                  aria-label={t('adm.hours.openOn', { day: t(`adm.days.${day}`) })}
                />
                <label htmlFor={`${id}-${day}`} className="cursor-pointer text-base font-medium">
                  {t(`adm.days.${day}`)}
                </label>
              </div>
              {hours ? (
                <div className="flex flex-wrap items-center gap-2">
                  <TimeInput value={hours.open} disabled={disabled} aria-label={t('adm.hours.opensAt', { day: t(`adm.days.${day}`) })} aria-invalid={invalid} onChange={(open) => onChange({ ...value, [day]: { ...hours, open } })} />
                  <span aria-hidden="true" className="text-muted-foreground">
                    –
                  </span>
                  <TimeInput value={hours.close} disabled={disabled} aria-label={t('adm.hours.closesAt', { day: t(`adm.days.${day}`) })} aria-invalid={invalid} onChange={(close) => onChange({ ...value, [day]: { ...hours, close } })} />
                  {invalid ? (
                    <span role="alert" className="text-sm text-destructive-text">
                      {t('adm.hours.invalid')}
                    </span>
                  ) : null}
                </div>
              ) : (
                <span className="text-base text-muted-foreground">{t('adm.hours.closed')}</span>
              )}
            </li>
          );
        })}
      </ul>
      {firstOpen ? (
        <Button variant="link" size="sm" disabled={disabled} onClick={() => onChange(Object.fromEntries(WEEKDAYS.map((d) => [d, value[d] ? { ...firstOpen } : null])) as WorkingHours)}>
          {t('adm.hours.copyToOpenDays')}
        </Button>
      ) : null}
    </div>
  );
}

export const workingHoursValid = (hours: WorkingHours): boolean => WEEKDAYS.every((d) => !hours[d] || hours[d]!.open < hours[d]!.close);

/** "Sun–Thu 08:30–20:30, Fri 16:00–20:30": consecutive days with the same hours are grouped. */
export function useHoursSummary(): (hours: WorkingHours | null | undefined) => string {
  const { t } = useI18n();
  return React.useCallback(
    (hours) => {
      if (!hours) return '';
      const groups: Array<{ from: Weekday; to: Weekday; text: string }> = [];
      for (const day of WEEK_ORDER) {
        const h = hours[day];
        if (!h) continue;
        const text = `${h.open}–${h.close}`;
        const last = groups[groups.length - 1];
        const previousDay = WEEK_ORDER[WEEK_ORDER.indexOf(day) - 1];
        if (last && last.text === text && last.to === previousDay) last.to = day;
        else groups.push({ from: day, to: day, text });
      }
      // "Sun 08:30 ... Mon-Thu 08:30" reads better as one run across the week boundary: "Sun-Thu".
      const first = groups[0];
      const last = groups[groups.length - 1];
      if (groups.length > 1 && first.from === WEEK_ORDER[0] && last.to === WEEK_ORDER[6] && first.text === last.text) {
        first.from = last.from;
        groups.pop();
      }
      return groups.map((g) => `${g.from === g.to ? t(`adm.daysShort.${g.from}`) : `${t(`adm.daysShort.${g.from}`)}–${t(`adm.daysShort.${g.to}`)}`} ${g.text}`).join(' · ');
    },
    [t],
  );
}

export interface CheckOption {
  value: string;
  label: string;
  description?: string;
}

/**
 * A multi-select as a list of checkboxes, with a search box once the list is long
 * (spec: searchable choices for large lists). Used for branches and service skills.
 */
export function CheckList({
  options, value, onChange, searchPlaceholder, emptyText, disabled, className, 'aria-label': ariaLabel,
}: {
  options: CheckOption[];
  value: string[];
  onChange: (next: string[]) => void;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
}) {
  const { t, tn } = useI18n();
  const id = React.useId();
  const [q, setQ] = React.useState('');
  const searchable = options.length > 8;
  const needle = q.trim().toLowerCase();
  const visible = needle ? options.filter((o) => `${o.label} ${o.description ?? ''}`.toLowerCase().includes(needle)) : options;
  const selected = new Set(value);
  const toggle = (v: string, on: boolean) => onChange(on ? [...value.filter((x) => x !== v), v] : value.filter((x) => x !== v));
  return (
    <div className={cn('rounded-lg border', className)} role="group" aria-label={ariaLabel}>
      {searchable ? (
        <div className="flex items-center gap-3 border-b p-2">
          <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={searchPlaceholder ?? t('common.searchPlaceholder')} aria-label={searchPlaceholder ?? t('common.search')} startAdornment={<Search aria-hidden="true" />} className="[&::-webkit-search-cancel-button]:hidden" />
          <span className="shrink-0 pe-1 text-sm text-muted-foreground">{tn('adm.common.selected', value.length)}</span>
        </div>
      ) : null}
      <ul className={cn('scroll-quiet space-y-2.5 overflow-y-auto p-3', searchable && 'max-h-60')}>
        {visible.map((o) => (
          <li key={o.value}>
            <ChoiceLabel
              htmlFor={`${id}-${o.value}`}
              control={<Checkbox id={`${id}-${o.value}`} checked={selected.has(o.value)} disabled={disabled} onCheckedChange={(c) => toggle(o.value, c === true)} />}
              label={o.label}
              description={o.description}
            />
          </li>
        ))}
        {visible.length === 0 ? <li className="py-3 text-center text-sm text-muted-foreground">{options.length ? t('common.noResults') : (emptyText ?? t('common.noResults'))}</li> : null}
      </ul>
    </div>
  );
}

/** A labelled control that is not part of a React Hook Form (editors with their own state). */
export function Field({ label, hint, error, htmlFor, children, className }: { label: React.ReactNode; hint?: React.ReactNode; error?: React.ReactNode; htmlFor?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={htmlFor} className="block text-sm font-medium leading-5 text-foreground">
        {label}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-sm text-destructive-text">
          {error}
        </p>
      ) : hint ? (
        <p className="text-sm text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/** A switch with its label and an explanation: one setting per row. */
export function SettingSwitch({ id, label, description, checked, onCheckedChange, disabled, children }: { id: string; label: React.ReactNode; description?: React.ReactNode; checked: boolean; onCheckedChange: (checked: boolean) => void; disabled?: boolean; children?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className="cursor-pointer text-base font-medium text-foreground">
          {label}
        </label>
        {description ? <p className="mt-0.5 text-sm text-muted-foreground">{description}</p> : null}
        {children}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} className="mt-0.5" />
    </div>
  );
}

export const EMIRATES = ['Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah'] as const;
/** Dictionary key of an emirate name ("Abu Dhabi" -> adm.emirates.abu_dhabi). */
export const emirateKey = (name: string) => `adm.emirates.${name.toLowerCase().replace(/[^a-z]+/g, '_')}`;
export function useEmirateOptions() {
  const { t } = useI18n();
  return React.useMemo(() => EMIRATES.map((e) => ({ value: e, label: t(emirateKey(e)) })), [t]);
}
export function useEmirateName(): (name: string | null | undefined) => string {
  const { t, has } = useI18n();
  return React.useCallback((name) => (name ? (has(emirateKey(name)) ? t(emirateKey(name)) : name) : ''), [t, has]);
}

// ---------------------------------------------------------------- lists that the API returns whole

type SortValue = string | number | null | undefined;

/**
 * Some organisation endpoints return a plain array (staff, roles, branches). This turns such an array
 * into the `{ data, meta }` page <DataTable> expects: sorted and cut in the browser.
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
