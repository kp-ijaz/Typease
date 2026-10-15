'use client';

import * as React from 'react';
import { documentDownloadLink, type ApiClient } from '@typease/api-client';
import { Badge, StatusBadge, useI18n } from '@typease/ui';
import { useDocumentTypes } from '@/components/pickers';
import type { DocumentRow } from '../types';

/**
 * Saves a document through a short-lived signed link. The link is requested at the moment of the click,
 * used once for the navigation and never stored.
 */
export async function downloadDocument(client: ApiClient, documentId: string, versionId?: string): Promise<void> {
  const link = await documentDownloadLink(client, documentId, versionId);
  const a = document.createElement('a');
  a.href = link.url;
  a.rel = 'noopener';
  a.download = link.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Name of a document type key in the active language ("passport" -> "Passport"). */
export function useDocumentTypeName(): (key: string) => string {
  const { pick } = useI18n();
  const types = useDocumentTypes();
  return React.useCallback(
    (key: string) => {
      const type = types.data?.find((d) => d.key === key);
      return type ? pick(type.name, type.nameAr) : key.replace(/_/g, ' ');
    },
    [types.data, pick],
  );
}

/** Days from today (centre time zone) to a YYYY-MM-DD date; negative when it has passed. */
export function daysUntil(isoDate: string, today: string): number {
  return Math.round((Date.parse(`${isoDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** File state and verification as chips. A blocked or deleted file shows only that: nothing else matters for it. */
export function DocumentStatusChips({ document: doc }: { document: Pick<DocumentRow, 'status' | 'verificationStatus' | 'legalHold'> }) {
  const { t } = useI18n();
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {doc.status === 'AVAILABLE' ? <StatusBadge kind="verification" status={doc.verificationStatus} /> : <StatusBadge kind="document" status={doc.status} />}
      {doc.legalHold ? <Badge tone="warning">{t('people.documents.legalHold.badge')}</Badge> : null}
    </span>
  );
}

/** Expiry date with "expired" / "in N days" when it is close. An unconfirmed date says so. */
export function ExpiryCell({ document: doc }: { document: Pick<DocumentRow, 'expiryDate' | 'expiryVerified'> }) {
  const { t, tn, formatDate, today } = useI18n();
  if (!doc.expiryDate) return null;
  const days = daysUntil(doc.expiryDate, today());
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <span className="tabular whitespace-nowrap">{formatDate(doc.expiryDate)}</span>
      {days < 0 ? <Badge tone="danger">{t('people.common.expired')}</Badge> : days <= 90 ? <Badge tone="warning">{tn('people.common.daysLeft', days)}</Badge> : null}
      {doc.expiryVerified ? null : <span className="text-xs text-muted-foreground">{t('people.documents.expiryUnconfirmed')}</span>}
    </span>
  );
}
