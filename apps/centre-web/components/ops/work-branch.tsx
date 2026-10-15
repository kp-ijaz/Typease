'use client';

import * as React from 'react';
import { MapPin } from 'lucide-react';
import { Select, useI18n, useSession } from '@typease/ui';
import { useBranch, useBranches } from '@/components/branch';

/**
 * Appointments and the queue are worked one branch at a time. The branch is the one chosen in the
 * top bar; while that says "All branches" the page uses the first branch the person works at.
 * Changing it here changes the top-bar choice too, so every page agrees.
 */
export function useWorkBranch() {
  const session = useSession();
  const { branchId, setBranchId } = useBranch();
  const branches = useBranches();
  const allowed = React.useMemo(() => {
    const m = session.membership;
    return (branches.data ?? []).filter((b) => !m || m.allBranches || m.branchIds.includes(b.id));
  }, [branches.data, session.membership]);
  const current = allowed.find((b) => b.id === branchId) ?? allowed[0];
  return { branch: current, branchId: current?.id, branches: allowed, setBranchId, isLoading: branches.isPending && session.hasPermission('branch.read') };
}

export function WorkBranchSelect({ work, className }: { work: ReturnType<typeof useWorkBranch>; className?: string }) {
  const { t, pick } = useI18n();
  if (work.branches.length < 2) {
    return work.branch ? (
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <MapPin className="size-4" aria-hidden="true" />
        {pick(work.branch.name, work.branch.nameAr)}
      </p>
    ) : null;
  }
  return <Select aria-label={t('ops.common.branch')} className={className ?? 'w-full sm:w-56'} value={work.branchId ?? null} onValueChange={work.setBranchId} options={work.branches.map((b) => ({ value: b.id, label: pick(b.name, b.nameAr) }))} />;
}
