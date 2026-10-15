'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Paperclip, SearchX } from 'lucide-react';
import { documentDownloadLink, isApiError, saveBlob, type ApiClient } from '@typease/api-client';
import { Alert, Avatar, Button, Card, EmptyState, Skeleton, cn, focusRing, todayInTimeZone, useApiClient, useBranding, useErrorMessage, useI18n, useToast } from '@typease/ui';
import { usePortalApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import type { Bilingual } from '@/lib/types';

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

/** Title of a card section. */
export function SectionTitle({ id, children, className }: { id?: string; children: React.ReactNode; className?: string }) {
  return (
    <h2 id={id} className={cn('text-lg font-semibold text-foreground', className)}>
      {children}
    </h2>
  );
}

/** Saves a PDF (invoice, receipt, quotation) that the API produces for the signed-in customer. */
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

/**
 * "Overdue" as a customer understands it: the due DAY (centre time zone) is over. The API flag
 * turns on the moment the due time passes, which for an invoice that is due at once is the
 * minute it is created; nobody is late on the day an invoice arrives.
 */
export function usePastDue(): (invoice: { overdue: boolean; dueAt: string | null }) => boolean {
  const { timeZone, today } = useI18n();
  return (invoice) => invoice.overdue && !!invoice.dueAt && todayInTimeZone(timeZone, new Date(invoice.dueAt)) < today();
}

/**
 * A status that comes from outside the centre's own process, ALWAYS with where it
 * comes from ("Entered by staff (not verified by the authority)", "Provided by partner",
 * "Verified by the authority"). Never shown without its source.
 */
export function ExternalStatus({ status, sourceLabel, at, className }: { status: string; sourceLabel: Bilingual; at?: string | null; className?: string }) {
  const { t, pick, formatDateTime } = useI18n();
  return (
    <div className={cn('rounded-md border bg-muted/40 p-3', className)}>
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
  /** true = written by the centre, false = written by the customer. */
  fromCentre: boolean;
  authorName?: string | null;
  body: string;
  attachments?: Array<{ documentId: string; title: string | null }>;
  createdAt: string;
}

/** A conversation between the customer and the centre, oldest first. */
export function MessageThread({ messages, onOpenAttachment }: { messages: ThreadMessage[]; onOpenAttachment?: (documentId: string) => void }) {
  const { t, formatDateTime } = useI18n();
  const { name } = useBranding();
  return (
    <ol className="space-y-3">
      {messages.map((m) => {
        const author = m.fromCentre ? name : t('my.common.you');
        return (
          <li key={m.id} className={cn('flex gap-2.5', !m.fromCentre && 'flex-row-reverse')}>
            <Avatar name={m.fromCentre ? name : m.authorName ?? author} size="sm" className="mt-1 hidden sm:flex" />
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

/** "Back to ..." link above a detail page on phones, where breadcrumbs are easy to miss. */
export function BackLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Button asChild variant="link" className="mb-3">
      <Link href={href}>
        <ArrowLeft className="rtl-mirror" aria-hidden="true" />
        {children}
      </Link>
    </Button>
  );
}
