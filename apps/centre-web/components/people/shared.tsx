'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { isApiError } from '@typease/api-client';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton, cn, focusRing, useApi, useErrorMessage, useI18n, useSession } from '@typease/ui';
import { useStaffOptions } from '@/components/pickers';
import { peopleKeys } from '@/lib/keys/people';
import type { CustomerOverview, CustomerTag, PlanUsage } from './types';

/**
 * The active tab of a detail page, kept in the URL (`?tab=documents`) so that a link or a reload opens the
 * same tab. Read after mount, like the list state of DataTable, so that server and first client render agree.
 */
export function useUrlTab<T extends string>(tabs: readonly T[], fallback: T): [T, (tab: T) => void] {
  const [tab, setTabState] = React.useState<T>(fallback);
  React.useEffect(() => {
    const read = () => {
      const value = new URLSearchParams(window.location.search).get('tab') as T | null;
      setTabState(value && tabs.includes(value) ? value : fallback);
    };
    read();
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const setTab = React.useCallback(
    (next: T) => {
      setTabState(next);
      const url = new URL(window.location.href);
      if (next === fallback) url.searchParams.delete('tab');
      else url.searchParams.set('tab', next);
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    },
    [fallback],
  );
  return [tab, setTab];
}

/**
 * On a phone the tab strip scrolls sideways: the tab opened by a link (or the one just chosen) must be in view.
 * Rendered inside the tabs, so it runs once the record has loaded and the strip exists.
 */
export function ActiveTabInView({ value }: { value: string }) {
  React.useEffect(() => {
    const frame = requestAnimationFrame(() => document.querySelector('main [role="tablist"] [role="tab"][aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return null;
}

/** A failed read, shown where the data would be, with "Try again". */
export function LoadError({ error, onRetry, title, className }: { error: unknown; onRetry?: () => void; title?: string; className?: string }) {
  const { t } = useI18n();
  const describe = useErrorMessage();
  return (
    <Alert
      tone="danger"
      live
      title={title}
      className={className}
      action={
        onRetry ? (
          <Button size="sm" variant="outline" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        ) : undefined
      }
    >
      {describe(error)}
    </Alert>
  );
}

/** The API answered 404: the record does not exist or this person may not see it. */
export const isNotFound = (error: unknown) => isApiError(error) && error.status === 404;

/** A card with a heading row (title, optional description, optional action) and its content. */
export function Section({
  title, description, action, children, className, contentClassName, flush,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
  /** No padding around the content (tables, lists with their own dividers). */
  flush?: boolean;
}) {
  return (
    <Card className={className}>
      <CardHeader className={cn('items-center', flush && 'pb-4')}>
        <div className="min-w-0">
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        {action ? <div className="flex flex-wrap items-center gap-2">{action}</div> : null}
      </CardHeader>
      {flush ? <div className={cn('border-t', contentClassName)}>{children}</div> : <CardContent className={contentClassName}>{children}</CardContent>}
    </Card>
  );
}

/** Skeleton of a detail page: header, tab strip, two columns of cards. */
export function DetailSkeleton() {
  const { t } = useI18n();
  return (
    <div role="status" aria-label={t('common.loading')} className="space-y-6">
      <div className="space-y-2.5">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-8 w-72 max-w-full" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <Skeleton className="h-10 w-full" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          <Skeleton className="h-24" />
          <Skeleton className="h-64" />
        </div>
        <div className="space-y-6">
          <Skeleton className="h-40" />
          <Skeleton className="h-32" />
        </div>
      </div>
    </div>
  );
}

/** A customer tag: a dot in the tag's own colour and its name. The colour is decoration; the name is the information. */
export function TagChip({ tag, onRemove, removeLabel, className }: { tag: Pick<CustomerTag, 'name' | 'color'>; onRemove?: () => void; removeLabel?: string; className?: string }) {
  return (
    <span className={cn('inline-flex max-w-full items-center gap-1.5 rounded-full border bg-card py-0.5 pe-2.5 ps-2 text-xs font-medium leading-5 text-foreground', onRemove && 'pe-1', className)}>
      {/* The tag colour is data chosen by the centre (a hex value from the API), not a design token. */}
      <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-muted-foreground" style={tag.color ? { backgroundColor: tag.color } : undefined} />
      <span className="truncate" dir="auto">
        {tag.name}
      </span>
      {onRemove ? (
        <button type="button" onClick={onRemove} aria-label={removeLabel} title={removeLabel} className={cn('inline-flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground', focusRing)}>
          <svg viewBox="0 0 12 12" className="size-2.5" aria-hidden="true">
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      ) : null}
    </span>
  );
}

/** A value that is always written left to right (numbers, emails, ids), safe inside Arabic text. */
export function Ltr({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn('ltr-value tabular', className)}>{children}</span>;
}

/**
 * The API blanks the name of a record whose personal data was erased to this fixed English text
 * (customers.erasure: ERASED_CUSTOMER_NAME). It is shown in the reader's language instead.
 */
const ERASED_NAME = 'Erased customer';
export const isErasedName = (name: string | null | undefined) => name === ERASED_NAME;
/** Name of a person for display: the placeholder of an erased record is translated. */
export function usePersonName(): (name: string | null | undefined) => string {
  const { t } = useI18n();
  return React.useCallback((name) => (isErasedName(name) ? t('people.common.erasedCustomer') : name ?? ''), [t]);
}

/** Text link in the secondary colour, for links to other records inside tables and lists. */
export function RecordLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <Link href={href} className={cn('rounded-sm font-medium text-secondary-text hover:underline', focusRing, className)}>
      {children}
    </Link>
  );
}

/** The centre's plan with its limits and features (GET /tenant/usage, any staff member). */
export function usePlan() {
  const api = useApi();
  return useQuery({ queryKey: peopleKeys.plan, queryFn: () => api.client.get<PlanUsage>('/tenant/usage'), staleTime: 5 * 60_000 });
}

/** Name and number of one customer, for lists of other modules that only carry `customerId` (cached per customer). */
export function useCustomerName(id: string | null | undefined) {
  const api = useApi();
  const session = useSession();
  return useQuery({
    queryKey: peopleKeys.customers.name(id ?? ''),
    queryFn: async () => {
      const c = await api.client.get<CustomerOverview>(`/customers/${id}`);
      return { id: c.id, customerNo: c.customerNo, fullName: c.fullName, fullNameAr: c.fullNameAr };
    },
    enabled: !!id && session.hasPermission('customer.read'),
    staleTime: 10 * 60_000,
    retry: false,
  });
}
export function CustomerNameCell({ id, link = true }: { id: string | null | undefined; link?: boolean }) {
  const { t } = useI18n();
  const customer = useCustomerName(id);
  const personName = usePersonName();
  if (!id) return null;
  if (customer.isPending && customer.fetchStatus !== 'idle') return <Skeleton className="h-4 w-28" />;
  // A record that was erased after a deletion request no longer answers (404), while what had to be kept still points at it.
  if (isNotFound(customer.error)) return <span className="font-normal text-muted-foreground">{t('people.common.erasedCustomer')}</span>;
  if (!customer.data) return null;
  const body = (
    <>
      <span className="block">{personName(customer.data.fullName)}</span>
      <span className="tabular block text-sm font-normal text-muted-foreground">{customer.data.customerNo}</span>
    </>
  );
  return link ? <RecordLink href={`/customers/${id}`}>{body}</RecordLink> : body;
}

/** Staff user id -> name, for records that only carry an actor / reviewer id (needs `staff.read`; otherwise empty). */
export function useStaffNames(): (userId: string | null | undefined) => string | null {
  const session = useSession();
  const staff = useStaffOptions(session.hasPermission('staff.read'));
  return React.useCallback((userId) => (userId ? staff.data?.find((m) => m.user.id === userId)?.user.fullName ?? null : null), [staff.data]);
}

/** The plan does not include something, or its limit is reached: say so and point to the subscription page. */
export function UpgradeAlert({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  const { t } = useI18n();
  const session = useSession();
  return (
    <Alert
      tone="warning"
      title={title}
      className={className}
      action={
        session.hasPermission('subscription.manage') ? (
          <Button asChild size="sm" variant="outline">
            <Link href="/subscription">{t('people.common.viewPlans')}</Link>
          </Button>
        ) : undefined
      }
    >
      {children}
      {session.hasPermission('subscription.manage') ? null : <span className="mt-1 block">{t('people.common.askOwner')}</span>}
    </Alert>
  );
}

/** 402 PLAN_LIMIT_REACHED, optionally for one limit / feature (`details.limit`). */
export function isPlanLimit(error: unknown, limit?: string): boolean {
  if (!isApiError(error) || error.code !== 'PLAN_LIMIT_REACHED') return false;
  if (!limit) return true;
  const named = (error.details as { limit?: string } | undefined)?.limit;
  return !named || named === limit;
}
