'use client';

import { useQuery } from '@tanstack/react-query';
import { GitMerge } from 'lucide-react';
import type { DuplicateCandidate } from '@typease/api-client';
import { Button, Skeleton, useApi, useI18n, useSession } from '@typease/ui';
import { peopleKeys } from '@/lib/keys/people';
import { LoadError, RecordLink, Section } from '../shared';
import type { CustomerOverview } from '../types';
import { StrengthBadge, useSignalText } from './duplicate-warning';

export interface DuplicateCheckResult {
  candidates: DuplicateCandidate[];
  strongCount: number;
  weakCount: number;
}

/**
 * Other records of the centre that share the mobile, email or name of this customer
 * (POST /customers/duplicates/check). It only reports: nothing is ever merged automatically, and a
 * matching name alone is shown as a weak signal.
 */
export function useDuplicateCheck(customer: CustomerOverview, enabled = true) {
  const api = useApi();
  const session = useSession();
  const allowed = session.hasAnyPermission(['customer.create', 'customer.update', 'customer.merge']);
  return useQuery({
    queryKey: [...peopleKeys.customers.duplicates(customer.id), customer.fullName, customer.phone, customer.email],
    queryFn: () =>
      api.client.post<DuplicateCheckResult>('/customers/duplicates/check', {
        fullName: customer.fullName,
        ...(customer.phone ? { phone: customer.phone } : {}),
        ...(customer.email ? { email: customer.email } : {}),
        excludeId: customer.id,
      }),
    enabled: enabled && allowed && customer.status === 'ACTIVE',
    staleTime: 60_000,
  });
}

export function DuplicatesCard({ customer, onMerge }: { customer: CustomerOverview; onMerge: (otherId: string) => void }) {
  const { t } = useI18n();
  const session = useSession();
  const signalText = useSignalText();
  const check = useDuplicateCheck(customer);
  if (customer.status !== 'ACTIVE' || !session.hasAnyPermission(['customer.create', 'customer.update', 'customer.merge'])) return null;
  const candidates = check.data?.candidates ?? [];

  return (
    <Section title={t('people.customer.duplicates.title')}>
      {check.isPending ? (
        <div className="space-y-2" role="status" aria-label={t('common.loading')}>
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-12" />
        </div>
      ) : check.isError ? (
        <LoadError error={check.error} onRetry={() => void check.refetch()} />
      ) : candidates.length === 0 ? (
        <p className="text-base text-muted-foreground">{t('people.customer.duplicates.none')}</p>
      ) : (
        <>
          <p className="mb-3 text-sm text-muted-foreground">{t('people.customer.duplicates.text')}</p>
          <ul className="space-y-2.5">
            {candidates.map(({ customer: other, signals, strength }) => (
              <li key={other.id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <RecordLink href={`/customers/${other.id}`}>{other.fullName}</RecordLink>
                    <p className="tabular text-sm text-muted-foreground">{other.customerNo}</p>
                  </div>
                  <StrengthBadge strength={strength} />
                </div>
                <p className="mt-1.5 text-sm text-foreground/85">{signalText(signals)}</p>
                {strength === 'WEAK' ? <p className="mt-1 text-sm text-muted-foreground">{t('people.customer.duplicates.weakHint')}</p> : null}
                {session.hasPermission('customer.merge') ? (
                  <Button variant="outline" size="sm" className="mt-2.5" onClick={() => onMerge(other.id)}>
                    <GitMerge aria-hidden="true" />
                    {t('people.customer.duplicates.compare')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-muted-foreground">{t('people.customer.duplicates.never')}</p>
        </>
      )}
    </Section>
  );
}
