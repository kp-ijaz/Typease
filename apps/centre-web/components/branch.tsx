'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { MapPin } from 'lucide-react';
import { Select, useApi, useI18n, useSession } from '@typease/ui';
import { keys } from '@/lib/query-keys';

const STORAGE_KEY = 'te_branch';
const ALL = '__all__';

interface BranchContextValue {
  /** The branch the person is working in, or undefined for all their branches. */
  branchId: string | undefined;
  setBranchId: (id: string | undefined) => void;
}
const BranchContext = React.createContext<BranchContextValue>({ branchId: undefined, setBranchId: () => undefined });

/** Remembers which branch the person is looking at (per browser). Dashboards and "new" forms read it. */
export function BranchProvider({ children }: { children: React.ReactNode }) {
  const [branchId, setBranch] = React.useState<string | undefined>(undefined);
  React.useEffect(() => {
    try {
      setBranch(window.localStorage.getItem(STORAGE_KEY) || undefined);
    } catch {
      /* ignore */
    }
  }, []);
  const setBranchId = React.useCallback((id: string | undefined) => {
    setBranch(id);
    try {
      if (id) window.localStorage.setItem(STORAGE_KEY, id);
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, []);
  const value = React.useMemo(() => ({ branchId, setBranchId }), [branchId, setBranchId]);
  return <BranchContext.Provider value={value}>{children}</BranchContext.Provider>;
}
export const useBranch = () => React.useContext(BranchContext);

/** The centre's active branches (cached for the session). */
export function useBranches() {
  const api = useApi();
  const session = useSession();
  return useQuery({
    queryKey: keys.branches.all,
    queryFn: () => api.organisation.branches(),
    enabled: session.hasPermission('branch.read'),
    staleTime: 5 * 60_000,
    select: (branches) => branches.filter((b) => b.isActive),
  });
}

/** Top-bar branch switcher. Hidden for centres with a single branch. */
export function BranchSwitcher() {
  const { t, pick } = useI18n();
  const { branchId, setBranchId } = useBranch();
  const branches = useBranches();
  const list = branches.data ?? [];

  // A remembered branch that no longer exists (deactivated, other centre) falls back to "all".
  React.useEffect(() => {
    if (branchId && branches.data && !branches.data.some((b) => b.id === branchId)) setBranchId(undefined);
  }, [branchId, branches.data, setBranchId]);

  if (list.length < 2) return null;
  return (
    <div className="flex items-center gap-1.5">
      <MapPin className="size-4 text-muted-foreground" aria-hidden="true" />
      <Select
        aria-label={t('shell.branch')}
        size="sm"
        className="w-44"
        value={branchId ?? ALL}
        onValueChange={(v) => setBranchId(v === ALL ? undefined : v)}
        options={[{ value: ALL, label: t('shell.allBranches') }, ...list.map((b) => ({ value: b.id, label: pick(b.name, b.nameAr) }))]}
      />
    </div>
  );
}
