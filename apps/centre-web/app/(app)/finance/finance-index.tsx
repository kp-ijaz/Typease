'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Wrench } from 'lucide-react';
import { Card, EmptyState, PageHeader, PageSkeleton, useI18n, useSession } from '@typease/ui';
import { useFinanceTools } from '@/components/fin/finance-tabs';

/** /finance has no page of its own: it opens the first finance tool the role may use. */
export function FinanceIndex() {
  const { t } = useI18n();
  const router = useRouter();
  const session = useSession();
  const tools = useFinanceTools();
  const first = tools[0]?.href;
  React.useEffect(() => {
    if (first) router.replace(first);
  }, [first, router]);
  if (first || !session.isAuthenticated) return <PageSkeleton label={t('common.loading')} />;
  return (
    <>
      <PageHeader title={t('fin.tools.nav')} />
      <Card>
        <EmptyState size="page" icon={<Wrench />} title={t('session.noPermissionTitle')} description={t('session.noPermissionDescription')} />
      </Card>
    </>
  );
}
