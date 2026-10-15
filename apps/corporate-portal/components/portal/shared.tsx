'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Paperclip, SearchX, ShieldAlert } from 'lucide-react';
import { documentDownloadLink, isApiError, saveBlob, type ApiClient } from '@typease/api-client';
import { Alert, Avatar, Badge, Button, Card, EmptyState, Skeleton, cn, focusRing, todayInTimeZone, useApiClient, useBranding, useErrorMessage, useI18n, useSession, useToast } from '@typease/ui';
import { usePortalApi } from '@/lib/api';
import { ROUTES } from '@/lib/config';
import { keys } from '@/lib/query-keys';
import type { Bilingual } from '@/lib/types';

/**
 * Who is signed in. A company administrator (`corp.*`) works for the whole company; an employee
 * (`self.*`) sees only their own requests and documents. The API enforces both; this only decides
 * what the screens offer.
 */
export function useRole() {
  const session = useSession();
  const { hasPermission } = session;
  const company = hasPermission('corp.requests.read') || hasPermission('corp.account.read') || hasPermission('corp.employees.read');
  return {
    /** Acts for the whole company. */
    company,
    /** Signed in for their own records only. */
    employee: !company,
    canCreateRequests: hasPermission('corp.requests.create') || hasPermission('self.requests'),
    canSeeMoney: hasPermission('corp.invoices.read'),
    canApprove: hasPermission('corp.requests.approve'),
    canManageEmployees: hasPermission('corp.employees.manage'),
    /** Ratings belong to a customer record: employees have one, company administrators do not. */
  };
}

/** A failed read, shown where the data would be, with "Try again". */
export function LoadError({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
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
      {describe(error)}
    </Alert>
  );
}

export const isNotFound = (error: unknown): boolean => isApiError(error) && error.status === 404;
export const isForbidden = (error: unknown): boolean => isApiError(error) && error.status === 403;
/** Neither "not found" nor "not allowed" gets better by asking again. */
export const retryUnlessFinal = (count: number, error: unknown) => !isNotFound(error) && !isForbidden(error) && count < 2;

/** The record does not exist or belongs to somebody else: the API answers 404 for both. */
export function NotFoundCard({ title, text, backHref, backLabel }: { title: string; text: string; backHref: string; backLabel: string }) {
  return (
    <Card>
      <EmptyState
        size="page"
        icon={<SearchX />}
        title={title}
        description={text}
        action={
          <Button asChild variant="outline">
            <Link href={backHref}>
              <ArrowLeft className="rtl-mirror" aria-hidden="true" />
              {backLabel}
            </Link>
          </Button>
        }
      />
    </Card>
  );
}

/**
 * A page of the company's administrators opened by somebody whose role does not include it
 * (an employee following a link, or the API answering 403): say so and offer the way back.
 */
export function NoAccess({ className }: { className?: string }) {
  const { t } = useI18n();
  return (
    <Card className={className} data-no-access>
      <EmptyState
        size="page"
        icon={<ShieldAlert />}
        title={t('my.common.noAccessTitle')}
        description={t('my.common.noAccessText')}
        action={
          <Button asChild variant="outline">
            <Link href={ROUTES.home}>
              <ArrowLeft className="rtl-mirror" aria-hidden="true" />
              {t('my.common.backToOverview')}
            </Link>
          </Button>
        }
      />
    </Card>
  );
}

/** Renders the page only for sessions that hold one of the permissions; everybody else gets <NoAccess>. */
export function Gate({ anyOf, children }: { anyOf: readonly string[]; children: React.ReactNode }) {
  const session = useSession();
  return session.hasAnyPermission(anyOf) ? <>{children}</> : <NoAccess />;
}

/** Skeleton of a detail page: a heading and two cards. */
export function DetailSkeleton() {
  const { t } = useI18n();
  return (
    <div className="space-y-5" role="status" aria-label={t('common.loading')}>
      <Skeleton className="h-8 w-2/3 max-w-sm" />
      <Skeleton className="h-5 w-1/2 max-w-xs" />
      <Skeleton className="h-40" />
      <Skeleton className="h-56" />
    </div>
  );
}

/** An amount as the API sends it (decimal string), formatted for the active language. */
export function Money({ amount, currency, className }: { amount: string | number | null | undefined; currency?: string | null; className?: string }) {
  const { formatMoney } = useI18n();
  return <span className={cn('tabular whitespace-nowrap', className)}>{formatMoney(amount, currency)}</span>;
}

/**
 * The name of a person as the portal may show it. When their data was erased the API sends a placeholder
 * and `erased: true`: a neutral label, no link and no actions (customers.md, "Erased customers").
 */
export function PersonName({ name, erased, className }: { name: string | null | undefined; erased?: boolean | null; className?: string }) {
  const { t } = useI18n();
  if (erased) {
    return (
      <span className={cn('italic text-muted-foreground', className)} title={t('my.common.erasedHint')} data-erased>
        {t('my.common.erasedPerson')}
      </span>
    );
  }
  if (!name) return null;
  return (
    <span dir="auto" className={className}>
      {name}
    </span>
  );
}

/** A value that is always written left to right: numbers, emails, phone numbers. */
export function Ltr({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn('ltr-value tabular', className)}>{children}</span>;
}

/** Title of a card section. */
export function SectionTitle({ id, children, className }: { id?: string; children: React.ReactNode; className?: string }) {
  return (
    <h2 id={id} className={cn('text-lg font-semibold text-foreground', className)}>
      {children}
    </h2>
  );
}

/** Saves a PDF (invoice, receipt, quotation) that the API produces for the signed-in user. */
export function usePdfDownload() {
  const client = useApiClient();
  const toasts = useToast();
  const [busy, setBusy] = React.useState<string | null>(null);
  const save = React.useCallback(
    async (path: string, fallbackFilename: string) => {
      setBusy(path);
      try {
        saveBlob(await client.download(path, { fallbackFilename }));
      } catch (error) {
        toasts.error(error);
      } finally {
        setBusy((current) => (current === path ? null : current));
      }
    },
    [client, toasts],
  );
  return { save, busy };
}

/**
 * Saves a document of the vault through a short-lived signed link. The link is asked
 * for at the moment of the click, used once and never kept.
 */
export async function downloadDocument(client: ApiClient, documentId: string): Promise<void> {
  const link = await documentDownloadLink(client, documentId);
  const a = document.createElement('a');
  a.href = link.url;
  a.rel = 'noopener';
  a.download = link.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function useDocumentDownload() {
  const client = useApiClient();
  const toasts = useToast();
  const [busy, setBusy] = React.useState<string | null>(null);
  const download = React.useCallback(
    async (documentId: string) => {
      setBusy(documentId);
      try {
        await downloadDocument(client, documentId);
      } catch (error) {
        toasts.error(error);
      } finally {
        setBusy((current) => (current === documentId ? null : current));
      }
    },
    [client, toasts],
  );
  return { download, busy };
}

/** Names of document types in the active language ("passport" -> "Passport"). */
export function useDocumentTypeName(): (key: string) => string {
  const { pick } = useI18n();
  const api = usePortalApi();
  const types = useQuery({ queryKey: keys.documentTypes, queryFn: () => api.documentTypes(), staleTime: 10 * 60_000 });
  return React.useCallback(
    (key: string) => {
      const type = types.data?.find((d) => d.key === key);
      return type ? pick(type.name, type.nameAr) : key.replace(/_/g, ' ');
    },
    [types.data, pick],
  );
}

/** The name of a branch in the reader's language (invoices and quotations carry the English name only). */
export function useBranchName(): (branch: { id: string; name: string }) => string {
  const { pick } = useI18n();
  const api = usePortalApi();
  const branches = useQuery({ queryKey: keys.branches, queryFn: () => api.branches(), staleTime: 10 * 60_000 });
  return React.useCallback(
    (branch) => {
      const known = branches.data?.find((b) => b.id === branch.id);
      return known ? pick(known.name, known.nameAr) : branch.name;
    },
    [branches.data, pick],
  );
}

/** Days from today (centre time zone) to a date; negative when it has passed. */
export function daysUntil(date: string, today: string): number {
  return Math.round((Date.parse(`${date.slice(0, 10)}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** From how many days before the date an expiry is pointed out. */
export const EXPIRY_WARNING_DAYS = 90;

/**
 * An expiry date with what it means today: "Expired" in red, "in 14 days" in amber while it is
 * close, nothing more when it is far away. The words carry the meaning, the colour repeats it.
 */
export function Expiry({ date, className, stacked }: { date: string | null | undefined; className?: string; /** Badge under the date instead of beside it. */ stacked?: boolean }) {
  const { t, tn, formatDate, today } = useI18n();
  if (!date) return null;
  const days = daysUntil(date, today());
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-x-2 gap-y-0.5', stacked && 'flex-col items-start', className)} data-expiry={days < 0 ? 'expired' : days <= EXPIRY_WARNING_DAYS ? 'soon' : 'ok'}>
      <span className="tabular whitespace-nowrap">{formatDate(date)}</span>
      {days < 0 ? <Badge tone="danger">{t('my.expiry.expired')}</Badge> : days <= EXPIRY_WARNING_DAYS ? <Badge tone="warning">{tn('my.expiry.inDays', days)}</Badge> : null}
    </span>
  );
}

/**
 * "Overdue" as a company understands it: the due DAY (centre time zone) is over. The API flag
 * turns on the moment the due time passes; nobody is late on the day an invoice is due.
 */
export function usePastDue(): (invoice: { overdue?: boolean; dueAt: string | null }) => boolean {
  const { timeZone, today } = useI18n();
  return (invoice) => !!invoice.dueAt && invoice.overdue !== false && todayInTimeZone(timeZone, new Date(invoice.dueAt)) < today();
}

/**
 * A status that comes from outside the centre's own process, ALWAYS with where it
 * comes from ("Entered by staff (not verified by the authority)", "Provided by partner",
 * "Verified by the authority"). Never shown without its source.
 */
export function ExternalStatus({ status, sourceLabel, at, className }: { status: string; sourceLabel: Bilingual; at?: string | null; className?: string }) {
  const { t, pick, formatDateTime } = useI18n();
  return (
    <div className={cn('rounded-md border bg-muted/40 p-3', className)} data-external-source>
      <p className="text-base text-foreground" dir="auto">
        {status}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        <span className="font-medium text-foreground/80">{t('my.common.source')}:</span> {pick(sourceLabel.en, sourceLabel.ar)}
        {at ? (
          <>
            <span aria-hidden="true"> – </span>
            <span className="tabular">{formatDateTime(at)}</span>
          </>
        ) : null}
      </p>
    </div>
  );
}

export interface ThreadMessage {
  id: string;
  /** true = written by the centre, false = written by the company's side. */
  fromCentre: boolean;
  authorName?: string | null;
  body: string;
  attachments?: Array<{ documentId: string; title: string | null }>;
  createdAt: string;
}

/** A conversation between the company and the centre, oldest first. */
export function MessageThread({ messages, onOpenAttachment }: { messages: ThreadMessage[]; onOpenAttachment?: (documentId: string) => void }) {
  const { t, formatDateTime } = useI18n();
  const { name } = useBranding();
  const me = useSession().user?.fullName ?? '';
  return (
    <ol className="space-y-3">
      {messages.map((m) => {
        // Colleagues of the same company write in the same thread: their name tells them apart.
        const mine = !m.fromCentre && (!m.authorName || m.authorName === me);
        const author = m.fromCentre ? name : mine ? t('my.common.you') : m.authorName ?? t('my.common.yourCompany');
        return (
          <li key={m.id} className={cn('flex gap-2.5', !m.fromCentre && 'flex-row-reverse')}>
            <Avatar name={m.fromCentre ? name : m.authorName ?? me ?? author} size="sm" className="mt-1 hidden sm:flex" />
            <div className={cn('min-w-0 max-w-[min(38rem,92%)] rounded-lg border px-3.5 py-2.5', m.fromCentre ? 'bg-card' : 'border-secondary/20 bg-secondary-soft/60')}>
              <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="font-semibold text-foreground">{author}</span>
                <span className="tabular text-muted-foreground">{formatDateTime(m.createdAt)}</span>
              </p>
              <p className="mt-1 whitespace-pre-wrap break-words text-base text-foreground" dir="auto">
                {m.body}
              </p>
              {m.attachments?.length ? (
                <ul className="mt-2 flex flex-wrap gap-2">
                  {m.attachments.map((a) => (
                    <li key={a.documentId} className="min-w-0">
                      <button
                        type="button"
                        onClick={() => onOpenAttachment?.(a.documentId)}
                        className={cn('inline-flex max-w-full items-center gap-1.5 rounded-md border bg-card px-2.5 py-1 text-sm text-secondary-text hover:underline', focusRing)}
                      >
                        <Paperclip className="size-3.5 shrink-0" aria-hidden="true" />
                        <span className="truncate" dir="auto">
                          {a.title ?? t('my.common.attachment')}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Whether the company may change things right now. Employees, colleagues and requests can only
 * be added while the centre has the account ACTIVE (403 CORPORATE_ACCOUNT_NOT_ACTIVE otherwise);
 * reading always stays possible. Only asked for sessions that may read the account.
 */
export function useCompanyAccount() {
  const api = usePortalApi();
  const session = useSession();
  const enabled = session.hasPermission('corp.account.read');
  const account = useQuery({ queryKey: keys.account, queryFn: () => api.account(), enabled, staleTime: 60_000, retry: retryUnlessFinal });
  return { account, active: !enabled || !account.data ? true : account.data.status === 'ACTIVE' };
}

/** The reason new work is paused, for the pages that offer it. Nothing while the account is active. */
export function CompanyStatusNotice({ className }: { className?: string }) {
  const { t } = useI18n();
  const { account } = useCompanyAccount();
  const status = account.data?.status;
  if (!status || status === 'ACTIVE') return null;
  const key = status === 'PENDING_VERIFICATION' ? 'pending' : status === 'SUSPENDED' ? 'suspended' : 'archived';
  return (
    <Alert tone={status === 'SUSPENDED' ? 'danger' : status === 'PENDING_VERIFICATION' ? 'warning' : 'info'} className={className} title={t(`my.company.notice.${key}Title`)} data-company-status={status}>
      {t(`my.company.notice.${key}Text`)}
    </Alert>
  );
}
