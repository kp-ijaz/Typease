'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, MailPlus, PauseCircle, PlayCircle, Send, ShieldCheck, ShieldOff, Trash2, UserCog } from 'lucide-react';
import {
  Avatar, Badge, Button, Card, DataTable, EmptyState, PageHeader, PermissionGate, RequirePermission, Select, Skeleton, StatusBadge, Table, TableBody, TableCaption, TableCell, TableHead,
  TableHeader, TableRow, Tabs, TabsContent, TabsList, TabsTrigger, useApi, useI18n, useSession, type DataTableColumn, type DataTableFilter, type RowAction,
} from '@typease/ui';
import { useBranch } from '@/components/branch';
import { useRoles } from '@/components/pickers';
import { useRoleName } from '@/components/adm/permissions';
import { LoadError, pageOf } from '@/components/adm/shared';
import { InviteStaffDialog, useStaffActions } from '@/components/adm/staff-dialogs';
import type { BranchRow, StaffMember, WorkloadRow } from '@/components/adm/types';
import { admKeys } from '@/lib/keys/adm';

const ALL = '__all__';

export function StaffPage() {
  return (
    <RequirePermission anyOf={['staff.read']}>
      <StaffScreen />
    </RequirePermission>
  );
}

function StaffScreen() {
  const { t } = useI18n();
  const api = useApi();
  const session = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const tab = useSearchParams().get('tab') === 'workload' ? 'workload' : 'team';
  const [inviting, setInviting] = React.useState(false);
  // Without "branch.read" (possible in a TypEase support session) the branch names are simply not asked for.
  const branches = useQuery({ queryKey: admKeys.branches.admin, queryFn: () => api.client.get<BranchRow[]>('/branches', { query: { includeInactive: true } }), staleTime: 60_000, enabled: session.hasPermission('branch.read') });

  const invite = (
    <PermissionGate permission="staff.manage">
      <Button variant="accent" onClick={() => setInviting(true)}>
        <MailPlus aria-hidden="true" />
        {t('adm.staff.invite.action')}
      </Button>
    </PermissionGate>
  );

  return (
    <>
      <PageHeader title={t('adm.staff.title')} description={t('adm.staff.description')} action={invite} />
      <Tabs value={tab} onValueChange={(next) => router.replace(next === 'team' ? pathname : `${pathname}?tab=${next}`, { scroll: false })}>
        <TabsList>
          <TabsTrigger value="team">{t('adm.staff.tabs.team')}</TabsTrigger>
          <TabsTrigger value="workload">{t('adm.staff.tabs.workload')}</TabsTrigger>
        </TabsList>
        <TabsContent value="team">{tab === 'team' ? <Team branches={branches.data ?? []} invite={invite} /> : null}</TabsContent>
        <TabsContent value="workload">{tab === 'workload' ? <Workload branches={branches.data ?? []} /> : null}</TabsContent>
      </Tabs>
      <InviteStaffDialog open={inviting} onOpenChange={setInviting} branches={branches.data ?? []} />
    </>
  );
}

function Team({ branches, invite }: { branches: BranchRow[]; invite: React.ReactNode }) {
  const { t, pick, locale, formatRelative, formatDateTime } = useI18n();
  const api = useApi();
  const session = useSession();
  const roles = useRoles();
  const roleName = useRoleName();
  const actions = useStaffActions();
  const canManage = session.hasPermission('staff.manage');
  const branchName = React.useMemo(() => new Map(branches.map((b) => [b.id, b])), [branches]);

  const columns = React.useMemo<Array<DataTableColumn<StaffMember>>>(
    () => [
      {
        id: 'name',
        header: t('adm.staff.columns.name'),
        sortField: 'name',
        mobile: 'title',
        cell: (m) => (
          <span className="flex items-center gap-3">
            <Avatar name={m.user.fullName} size="sm" className="hidden sm:inline-flex" />
            <span className="min-w-0">
              <span className="block">
                {m.user.fullName}
                {m.userId === session.user?.id ? <span className="ms-2 text-sm font-normal text-muted-foreground">{t('adm.staff.you')}</span> : null}
              </span>
              <span className="ltr-value block max-w-64 truncate text-sm font-normal text-muted-foreground">{m.user.email}</span>
            </span>
          </span>
        ),
      },
      {
        id: 'role',
        header: t('adm.staff.columns.role'),
        sortField: 'role',
        cell: (m) => (
          <>
            <span className="block">{roleName(m.role)}</span>
            {m.jobTitle && m.jobTitle !== m.role.name ? <span className="block text-sm text-muted-foreground">{m.jobTitle}</span> : null}
          </>
        ),
      },
      {
        id: 'branches',
        header: t('adm.staff.columns.branches'),
        cell: (m) =>
          m.allBranches
            ? t('adm.staff.branches.allShort')
            : m.branchIds.length
              ? m.branchIds.map((id) => (branchName.get(id) ? pick(branchName.get(id)!.name, branchName.get(id)!.nameAr) : '')).filter(Boolean).join(locale === 'ar' ? '، ' : ', ')
              : null,
      },
      {
        id: 'status',
        header: t('adm.staff.columns.status'),
        mobile: 'badge',
        cell: (m) => (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <StatusBadge kind="membership" status={m.status} label={m.status === 'INVITED' ? { en: t('adm.staff.status.INVITED'), ar: t('adm.staff.status.INVITED') } : undefined} />
            {m.status === 'ACTIVE' && !m.isAvailable ? <Badge tone="neutral">{t('adm.staff.unavailable')}</Badge> : null}
          </span>
        ),
      },
      {
        id: 'mfa',
        header: t('adm.staff.columns.mfa'),
        cell: (m) =>
          m.status === 'INVITED' ? null : m.user.mfaEnabled ? (
            <Badge tone="success" icon={<ShieldCheck />}>
              {t('adm.staff.mfa.on')}
            </Badge>
          ) : (
            <Badge tone="neutral" icon={<ShieldOff />}>
              {t('adm.staff.mfa.off')}
            </Badge>
          ),
      },
      {
        id: 'lastLogin',
        header: t('adm.staff.columns.lastLogin'),
        sortField: 'lastLoginAt',
        className: 'whitespace-nowrap',
        cell: (m) => (m.user.lastLoginAt ? <span title={formatDateTime(m.user.lastLoginAt)}>{formatRelative(m.user.lastLoginAt)}</span> : <span className="text-muted-foreground">{t('adm.staff.neverSignedIn')}</span>),
      },
    ],
    [t, pick, locale, roleName, formatRelative, formatDateTime, branchName, session.user?.id],
  );

  const filters = React.useMemo<DataTableFilter[]>(
    () => [
      { id: 'roleKey', type: 'select', label: t('adm.staff.columns.role'), options: (roles.data ?? []).filter((r) => r.kind === 'STAFF').map((r) => ({ value: r.key, label: roleName(r) })) },
      ...(branches.filter((b) => b.isActive).length > 1 ? [{ id: 'branchId', type: 'select' as const, label: t('adm.staff.filters.branch'), options: branches.filter((b) => b.isActive).map((b) => ({ value: b.id, label: pick(b.name, b.nameAr) })) }] : []),
      { id: 'status', type: 'select', label: t('adm.staff.columns.status'), options: (['ACTIVE', 'INVITED', 'SUSPENDED'] as const).map((s) => ({ value: s, label: t(`adm.staff.status.${s}`) })) },
      { id: 'mfa', type: 'select', label: t('adm.staff.columns.mfa'), options: [{ value: 'on', label: t('adm.staff.mfa.on') }, { value: 'off', label: t('adm.staff.mfa.off') }] },
    ],
    [t, pick, roleName, roles.data, branches],
  );

  const self = (m: StaffMember) => m.userId === session.user?.id;
  const rowActions = React.useMemo<Array<RowAction<StaffMember>>>(
    () => [
      { id: 'open', label: t('adm.staff.actions.open'), icon: <ExternalLink aria-hidden="true" />, href: (m) => `/staff/${m.id}` },
      { id: 'resend', label: t('adm.staff.actions.resend'), icon: <Send aria-hidden="true" />, hidden: (m) => !canManage || m.status !== 'INVITED', onSelect: (m) => actions.ask('resend', m) },
      { id: 'suspend', label: t('adm.staff.actions.suspend'), icon: <PauseCircle aria-hidden="true" />, hidden: (m) => !canManage || m.status !== 'ACTIVE' || self(m), onSelect: (m) => actions.ask('suspend', m) },
      { id: 'reactivate', label: t('adm.staff.actions.reactivate'), icon: <PlayCircle aria-hidden="true" />, hidden: (m) => !canManage || m.status !== 'SUSPENDED', onSelect: (m) => actions.ask('reactivate', m) },
      { id: 'remove', label: t('adm.staff.actions.remove'), icon: <Trash2 aria-hidden="true" />, destructive: true, hidden: (m) => !canManage || self(m), onSelect: (m) => actions.ask('remove', m) },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, canManage, session.user?.id],
  );

  return (
    <>
      <DataTable<StaffMember>
        caption={t('adm.staff.title')}
        queryKey={admKeys.staff.all}
        queryFn={async (params, signal) => {
          const rows = await api.client.get<StaffMember[]>('/staff', { query: { status: params.status, branchId: params.branchId, roleKey: params.roleKey, q: params.q }, signal });
          const filtered = params.mfa ? rows.filter((m) => m.status !== 'INVITED' && m.user.mfaEnabled === (params.mfa === 'on')) : rows;
          return pageOf(filtered, params, { name: (m) => m.user.fullName, role: (m) => m.role.name, lastLoginAt: (m) => m.user.lastLoginAt });
        }}
        columns={columns}
        rowKey={(m) => m.id}
        rowHref={(m) => `/staff/${m.id}`}
        rowActions={rowActions}
        filters={filters}
        searchPlaceholder={t('adm.staff.searchPlaceholder')}
        defaultSort="name:asc"
        empty={{ icon: <UserCog />, title: t('adm.staff.emptyTitle'), description: t('adm.staff.emptyText'), action: invite }}
      />
      {actions.dialogs}
    </>
  );
}

/** Open requests and tasks per person (GET /staff/workload), with a bar that compares people at a glance. */
function Workload({ branches }: { branches: BranchRow[] }) {
  const { t, pick, formatNumber } = useI18n();
  const api = useApi();
  const roleName = useRoleName();
  const { branchId: currentBranch } = useBranch();
  const [branchId, setBranchId] = React.useState<string | undefined>(currentBranch);
  const active = branches.filter((b) => b.isActive);
  const workload = useQuery({ queryKey: admKeys.staff.workload(branchId), queryFn: () => api.client.get<WorkloadRow[]>('/staff/workload', { query: { branchId } }) });
  const rows = React.useMemo(() => [...(workload.data ?? [])].sort((a, b) => b.openRequests + b.openTasks - (a.openRequests + a.openTasks) || a.name.localeCompare(b.name)), [workload.data]);
  const max = Math.max(1, ...rows.map((r) => r.openRequests));

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
        <p className="max-w-2xl text-sm text-muted-foreground">{t('adm.staff.workload.intro')}</p>
        {active.length > 1 ? (
          <Select
            aria-label={t('adm.staff.filters.branch')}
            className="w-full sm:w-56"
            value={branchId ?? ALL}
            onValueChange={(v) => setBranchId(v === ALL ? undefined : v)}
            options={[{ value: ALL, label: t('shell.allBranches') }, ...active.map((b) => ({ value: b.id, label: pick(b.name, b.nameAr) }))]}
          />
        ) : null}
      </div>
      {workload.isPending ? (
        <div className="space-y-3 p-4">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : workload.isError ? (
        <LoadError error={workload.error} onRetry={() => void workload.refetch()} className="m-4" />
      ) : rows.length === 0 ? (
        <EmptyState icon={<UserCog />} title={t('adm.staff.workload.emptyTitle')} description={t('adm.staff.workload.emptyText')} />
      ) : (
        <Table>
          <TableCaption>{t('adm.staff.tabs.workload')}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>{t('adm.staff.columns.name')}</TableHead>
              <TableHead className="w-2/5 min-w-48">{t('adm.staff.workload.openRequests')}</TableHead>
              <TableHead className="text-end">{t('adm.staff.workload.openTasks')}</TableHead>
              <TableHead className="text-end">{t('adm.staff.workload.completed30')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.membershipId}>
                <TableCell>
                  <Link href={`/staff/${r.membershipId}`} className="font-medium text-secondary-text underline-offset-4 hover:underline">
                    {r.name}
                  </Link>
                  <span className="block text-sm text-muted-foreground">
                    {roleName({ key: r.roleKey, name: r.roleName })}
                    {r.isAvailable ? '' : ` · ${t('adm.staff.unavailable')}`}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="flex items-center gap-3">
                    <span className="tabular w-7 shrink-0 text-end font-medium">{formatNumber(r.openRequests)}</span>
                    <span aria-hidden="true" className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                      <span className="block h-full rounded-full bg-secondary" style={{ width: `${Math.round((r.openRequests / max) * 100)}%` }} />
                    </span>
                  </span>
                </TableCell>
                <TableCell className="tabular text-end">{formatNumber(r.openTasks)}</TableCell>
                <TableCell className="tabular text-end">{formatNumber(r.completedLast30Days)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}
