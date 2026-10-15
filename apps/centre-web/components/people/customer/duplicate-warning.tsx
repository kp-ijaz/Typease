'use client';

import Link from 'next/link';
import type { DuplicateCandidate } from '@typease/api-client';
import { Alert, Badge, Button, useI18n } from '@typease/ui';

/** The words for the signals of one candidate: "same mobile, same name". */
export function useSignalText() {
  const { t } = useI18n();
  return (signals: DuplicateCandidate['signals']) => signals.map((s) => t(`customers.duplicate.signals.${s}`)).join(', ');
}

/** "Strong match" for an identifying detail, "Weak: name only" when nothing but the name is the same. */
export function StrengthBadge({ strength }: { strength: DuplicateCandidate['strength'] }) {
  const { t } = useI18n();
  return strength === 'STRONG' ? <Badge tone="warning">{t('people.customer.duplicates.strong')}</Badge> : <Badge tone="neutral">{t('people.customer.duplicates.weak')}</Badge>;
}

/**
 * The API refused a save with 409 POSSIBLE_DUPLICATE: show the records it found and let the person either open
 * one of them or confirm that this is somebody else (the save is then repeated with `confirmNotDuplicate`).
 */
export function DuplicateWarning({ candidates, onConfirm, confirming, confirmLabel }: { candidates: DuplicateCandidate[]; onConfirm: () => void; confirming?: boolean; confirmLabel: string }) {
  const { t } = useI18n();
  const signalText = useSignalText();
  return (
    <Alert tone="warning" live title={t('customers.duplicate.title')}>
      <p>{t('customers.duplicate.text')}</p>
      <ul className="mt-3 space-y-2">
        {candidates.map(({ customer, signals }) => (
          <li key={customer.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-md border border-warning/40 bg-card px-3 py-2">
            <span className="min-w-0">
              <span className="block font-medium text-foreground">
                {customer.fullName} <span className="tabular font-normal text-muted-foreground">{customer.customerNo}</span>
              </span>
              <span className="block text-sm text-muted-foreground">{signalText(signals)}</span>
            </span>
            <Button asChild variant="outline" size="sm">
              <Link href={`/customers/${customer.id}`} target="_blank" rel="noopener">
                {t('customers.duplicate.open')}
              </Link>
            </Button>
          </li>
        ))}
      </ul>
      <Button variant="link" className="mt-3 whitespace-normal text-start" loading={confirming} onClick={onConfirm}>
        {confirmLabel}
      </Button>
    </Alert>
  );
}
