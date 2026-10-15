'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { isApiError } from '@typease/api-client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Send, ShieldCheck, ShieldOff, Trash2, UserX } from 'lucide-react';
import { updateStaffSchema } from '@typease/validation';
import {
  Alert, Badge, Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, ChoiceLabel, DescriptionList, EmptyState, Form, FormError, FormField, Input, PageHeader,
  PermissionGate, RadioGroup, RadioGroupItem, RequirePermission, Select, StatusBadge, Switch, formatPhone, useApi, useI18n, useSession, useToast, useZodForm,
} from '@typease/ui';
import { RoleSelect, useServiceOptions } from '@/components/pickers';
import { useRoleName } from '@/components/adm/permissions';
import { ActionError, CardSkeleton, CheckList, LoadError, TimeInput, WEEK_ORDER } from '@/components/adm/shared';
import { useStaffActions } from '@/components/adm/staff-dialogs';
import type { BranchRow, ScheduleEntry, StaffMember, WorkloadRow } from '@/components/adm/types';
import { admKeys } from '@/lib/keys/adm';

const profileSchema = updateStaffSchema.pick({ roleKey: true, jobTitle: true, isAvailable: true, allBranches: true, branchIds: true });

export function StaffDetail({ id }: { id: string }) {
  return (
    <RequirePermission anyOf={['staff.read']}>
      <Detail id={id} />
    </RequirePermission>
  );
}

function Detail({ id }: { id: string }) {
  const { t, formatDateTime, formatNumber } = useI18n();
  const api = useApi();
  const router = useRouter();
  const session = useSession();
  const roleName = useRoleName();
  const staff = useQuery({
    queryKey: admKeys.staff.one(id),
    // 404 (removed, or of another centre) is an answer, not a failure: the page says the person was not found.
    queryFn: () => api.client.get<StaffMember>(`/staff/${id}`).catch((error: unknown) => (isApiError(error) && error.status === 404 ? null : Promise.reject(error))),
  });
  // Branch names need "branch.read" (a TypEase support session may hold "staff.read" alone): without it the cards show what they can.
  const branches = useQuery({ queryKey: admKeys.branches.admin, queryFn: () => api.client.get<BranchRow[]>('/branches', { query: { includeInactive: true } }), staleTime: 60_000, enabled: session.hasPermission('branch.read') });
  const workload = useQuery({ queryKey: admKeys.staff.workload(), queryFn: () => api.client.get<WorkloadRow[]>('/staff/workload') });
  const actions = useStaffActions({ onRemoved: () => router.replace('/staff') });
  const crumbs = [{ label: t('adm.staff.title'), href: '/staff' }];

  if (staff.isPending) {
    return (
      <>
        <PageHeader title={t('adm.staff.detail.title')} breadcrumbs={crumbs} />
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <CardSkeleton />
            <CardSkeleton lines={6} />
          </div>
          <CardSkeleton />
        </div>
      </>
    );
  }
  if (staff.isError) {
    return (
      <>
        <PageHeader title={t('adm.staff.detail.title')} breadcrumbs={crumbs} />
        <LoadError error={staff.error} onRetry={() => void staff.refetch()} />
      </>
    );
  }
  const member = staff.data;
  if (!member) {
    return (
      <>
        <PageHeader title={t('adm.staff.detail.title')} breadcrumbs={crumbs} />
        <Card>
          <EmptyState
            size="page"
            icon={<UserX />}
            title={t('adm.staff.detail.notFoundTitle')}
            description={t('adm.staff.detail.notFoundText')}
            action={
              <Button asChild variant="outline">
                <Link href="/staff">{t('adm.staff.detail.backToList')}</Link>
              </Button>
            }
          />
        </Card>
      </>
    );
  }

  const self = member.userId === session.user?.id;
  const canManage = session.hasPermission('staff.manage');
  const load = workload.data?.find((w) => w.membershipId === member.id);
  const activeBranches = (branches.data ?? []).filter((b) => b.isActive);
  const ownBranches = member.allBranches ? activeBranches : activeBranches.filter((b) => member.branchIds.includes(b.id));

  return (
    <>
      <PageHeader
        title={member.user.fullName}
        description={[roleName(member.role), member.jobTitle !== member.role.name ? member.jobTitle : null].filter(Boolean).join(' · ')}
        breadcrumbs={crumbs}
        meta={
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <StatusBadge kind="membership" status={member.status} label={member.status === 'INVITED' ? { en: t('adm.staff.status.INVITED'), ar: t('adm.staff.status.INVITED') } : undefined} />
            {self ? <Badge tone="brand">{t('adm.staff.you')}</Badge> : null}
          </span>
        }
        action={
          canManage && member.status === 'INVITED' ? (
            <Button onClick={() => actions.ask('resend', member)}>
              <Send aria-hidden="true" />
              {t('adm.staff.actions.resend')}
            </Button>
          ) : undefined
        }
        secondary={
          canManage && !self ? (
            <>
              {member.status === 'ACTIVE' ? (
                <Button variant="outline" onClick={() => actions.ask('suspend', member)}>
                  {t('adm.staff.actions.suspend')}
                </Button>
              ) : null}
              {member.status === 'SUSPENDED' ? (
                <Button variant="outline" onClick={() => actions.ask('reactivate', member)}>
                  {t('adm.staff.actions.reactivate')}
                </Button>
              ) : null}
              <Button variant="destructive-outline" onClick={() => actions.ask('remove', member)}>
                <Trash2 aria-hidden="true" />
                {t('adm.staff.actions.remove')}
              </Button>
            </>
          ) : undefined
        }
      />

      {member.status === 'INVITED' ? (
        <Alert tone="info" className="mb-6" title={t('adm.staff.detail.invitedTitle')}>
          {t('adm.staff.detail.invitedText', { email: member.user.email })}
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <ProfileCard key={`${member.id}-${member.updatedAt}`} member={member} self={self} branches={activeBranches} canManage={canManage} />
          <SkillsCard key={`skills-${member.serviceIds.join(',')}`} member={member} canManage={canManage} />
          <ScheduleCard member={member} branches={ownBranches} canManage={canManage} />
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>{t('adm.staff.detail.account')}</CardTitle>
            </CardHeader>
            <CardContent>
              <DescriptionList
                columns={1}
                items={[
                  { label: t('adm.staff.fields.email'), value: <span className="ltr-value break-all">{member.user.email}</span> },
                  { label: t('adm.staff.fields.phone'), value: member.user.phone ? <span className="ltr-value tabular">{formatPhone(member.user.phone)}</span> : null },
                  {
                    label: t('adm.staff.columns.mfa'),
                    value: member.user.mfaEnabled ? (
                      <Badge tone="success" icon={<ShieldCheck />}>
                        {t('adm.staff.mfa.on')}
                      </Badge>
                    ) : (
                      <Badge tone="neutral" icon={<ShieldOff />}>
                        {t('adm.staff.mfa.off')}
                      </Badge>
                    ),
                  },
                  { label: t('adm.staff.columns.lastLogin'), value: member.user.lastLoginAt ? formatDateTime(member.user.lastLoginAt) : t('adm.staff.neverSignedIn') },
                  { label: t('adm.staff.detail.invitedAt'), value: member.invitedAt ? formatDateTime(member.invitedAt) : null },
                  { label: t('adm.staff.detail.joinedAt'), value: member.joinedAt ? formatDateTime(member.joinedAt) : null },
                ]}
              />
              <p className="mt-4 text-sm text-muted-foreground">{t('adm.staff.detail.accountNote')}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('adm.staff.tabs.workload')}</CardTitle>
            </CardHeader>
            <CardContent>
              {workload.isError ? (
                <LoadError error={workload.error} onRetry={() => void workload.refetch()} />
              ) : (
                <DescriptionList
                  columns={1}
                  items={[
                    { label: t('adm.staff.workload.openRequests'), value: load ? <span className="tabular text-xl font-semibold">{formatNumber(load.openRequests)}</span> : workload.isPending ? '…' : formatNumber(0) },
                    { label: t('adm.staff.workload.openTasks'), value: load ? <span className="tabular text-xl font-semibold">{formatNumber(load.openTasks)}</span> : workload.isPending ? '…' : formatNumber(0) },
                    { label: t('adm.staff.workload.completed30'), value: load ? <span className="tabular text-xl font-semibold">{formatNumber(load.completedLast30Days)}</span> : workload.isPending ? '…' : formatNumber(0) },
                  ]}
                />
              )}
            </CardContent>
            <PermissionGate permission="audit.read">
              <CardFooter>
                <Button asChild variant="link">
                  <Link href={`/audit-log?resourceType=TenantMembership&resourceId=${member.id}`}>{t('adm.staff.detail.viewAudit')}</Link>
                </Button>
              </CardFooter>
            </PermissionGate>
          </Card>
        </div>
      </div>
      {actions.dialogs}
    </>
  );
}

/** Role, job title, availability and branches (PATCH /staff/:id). The role needs `role.manage`; nobody edits their own role. */
function ProfileCard({ member, self, branches, canManage }: { member: StaffMember; self: boolean; branches: BranchRow[]; canManage: boolean }) {
  const { t, pick } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const session = useSession();
  const queryClient = useQueryClient();
  const scopeId = React.useId();
  const availableId = React.useId();
  const canChangeRole = canManage && session.hasPermission('role.manage') && !self;
  const form = useZodForm(profileSchema, {
    emptyAs: 'null',
    defaultValues: { roleKey: member.role.key, jobTitle: member.jobTitle ?? '', isAvailable: member.isAvailable, allBranches: member.allBranches, branchIds: member.branchIds },
  });
  const allBranches = form.watch('allBranches');
  const isAvailable = form.watch('isAvailable');

  return (
    <Card>
      <Form
        form={form}
        className="space-y-0"
        onSubmit={async (values) => {
          // With one active branch (or without the right to see branches) the choice is not on screen: it is left as it is.
          const choosable = branches.length > 1;
          if (choosable && values.allBranches === false && !(values.branchIds ?? []).length) {
            form.setError('branchIds', { type: 'manual', message: t('adm.staff.invite.branchRequired') });
            return;
          }
          const { roleKey, allBranches: everywhere, branchIds, ...rest } = values;
          await api.client.patch(`/staff/${member.id}`, {
            ...rest,
            ...(choosable ? { allBranches: everywhere, branchIds: everywhere ? [] : branchIds } : {}),
            // The API refuses any role field on your own record, and a role change needs "manage roles".
            ...(canChangeRole && roleKey && roleKey !== member.role.key ? { roleKey } : {}),
          });
          toasts.success(t('adm.staff.detail.saved'), member.user.fullName);
          await queryClient.invalidateQueries({ queryKey: admKeys.staff.all });
        }}
      >
        <CardHeader>
          <div>
            <CardTitle>{t('adm.staff.detail.profile')}</CardTitle>
            <CardDescription>{t('adm.staff.detail.profileText')}</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <FormField name="roleKey" label={t('adm.staff.fields.role')} hint={self ? t('adm.staff.detail.ownRole') : !canChangeRole ? t('adm.staff.detail.roleNeedsPermission') : t('adm.staff.detail.roleHint')}>
              {(field) => <RoleSelect id={field.id} value={field.value || undefined} onChange={field.onChange} onBlur={field.onBlur} disabled={!canChangeRole} aria-invalid={field['aria-invalid']} aria-describedby={field['aria-describedby']} />}
            </FormField>
            <FormField name="jobTitle" label={t('adm.staff.fields.jobTitle')} optional>
              {(field) => <Input {...field} autoComplete="off" disabled={!canManage} />}
            </FormField>
          </div>

          <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
            <div>
              <label htmlFor={availableId} className="cursor-pointer text-base font-medium">
                {t('adm.staff.fields.available')}
              </label>
              <p className="mt-0.5 text-sm text-muted-foreground">{t('adm.staff.detail.availableText')}</p>
            </div>
            <Switch id={availableId} checked={!!isAvailable} disabled={!canManage} onCheckedChange={(checked) => form.setValue('isAvailable', checked, { shouldDirty: true })} />
          </div>

          {branches.length > 1 ? (
            <>
              <FormField name="allBranches" label={t('adm.staff.fields.branchAccess')}>
                {(field) => (
                  <RadioGroup id={field.id} value={field.value ? 'all' : 'some'} disabled={!canManage} onValueChange={(v) => field.onChange(v === 'all')} aria-label={t('adm.staff.fields.branchAccess')} className="flex flex-wrap gap-x-8 gap-y-2">
                    <ChoiceLabel htmlFor={`${scopeId}-all`} control={<RadioGroupItem id={`${scopeId}-all`} value="all" />} label={t('adm.staff.branches.all')} />
                    <ChoiceLabel htmlFor={`${scopeId}-some`} control={<RadioGroupItem id={`${scopeId}-some`} value="some" />} label={t('adm.staff.branches.some')} />
                  </RadioGroup>
                )}
              </FormField>
              {allBranches ? null : (
                <FormField name="branchIds" label={t('adm.staff.fields.branches')} required>
                  {(field) => <CheckList aria-label={t('adm.staff.fields.branches')} disabled={!canManage} options={branches.map((b) => ({ value: b.id, label: pick(b.name, b.nameAr), description: b.code }))} value={Array.isArray(field.value) ? field.value : []} onChange={field.onChange} />}
                </FormField>
              )}
            </>
          ) : null}
          <FormError />
        </CardContent>
        {canManage ? (
          <CardFooter className="justify-end">
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('common.saveChanges')}
            </Button>
          </CardFooter>
        ) : null}
      </Form>
    </Card>
  );
}

/** Which services this person handles: used when requests are assigned automatically by expertise. */
function SkillsCard({ member, canManage }: { member: StaffMember; canManage: boolean }) {
  const { t, pick } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const session = useSession();
  const queryClient = useQueryClient();
  const canSeeServices = session.hasPermission('service.read');
  const services = useServiceOptions(canSeeServices);
  const [value, setValue] = React.useState<string[]>(member.serviceIds);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const dirty = value.length !== member.serviceIds.length || value.some((v) => !member.serviceIds.includes(v));
  if (!canSeeServices) return null;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.client.patch(`/staff/${member.id}`, { serviceIds: value });
      toasts.success(t('adm.staff.skills.saved'), member.user.fullName);
      await queryClient.invalidateQueries({ queryKey: admKeys.staff.all });
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{t('adm.staff.skills.title')}</CardTitle>
          <CardDescription>{t('adm.staff.skills.text')}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {services.isError ? (
          <LoadError error={services.error} onRetry={() => void services.refetch()} />
        ) : (
          <CheckList
            aria-label={t('adm.staff.skills.title')}
            disabled={!canManage || services.isPending}
            searchPlaceholder={t('adm.staff.skills.search')}
            emptyText={services.isPending ? t('common.loading') : t('adm.staff.skills.empty')}
            options={(services.data ?? []).filter((s) => s.isActive || member.serviceIds.includes(s.id)).map((s) => ({ value: s.id, label: pick(s.name, s.nameAr), description: s.code }))}
            value={value}
            onChange={setValue}
          />
        )}
        <ActionError error={error} />
      </CardContent>
      {canManage ? (
        <CardFooter className="justify-end">
          <Button onClick={() => void save()} disabled={!dirty} loading={saving} loadingText={t('common.saving')}>
            {t('adm.staff.skills.save')}
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}

type Shift = ScheduleEntry & { uid: number };
let shiftUid = 0;

/** Work schedule: shifts per weekday, each at one branch (GET / PUT /staff/:id/schedule). */
function ScheduleCard({ member, branches, canManage }: { member: StaffMember; branches: BranchRow[]; canManage: boolean }) {
  const { t, pick } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const schedule = useQuery({ queryKey: admKeys.staff.schedule(member.id), queryFn: () => api.client.get<ScheduleEntry[]>(`/staff/${member.id}/schedule`) });
  const [shifts, setShifts] = React.useState<Shift[] | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);

  React.useEffect(() => {
    if (schedule.data) setShifts(schedule.data.map((e) => ({ branchId: e.branchId, weekday: e.weekday, startTime: e.startTime, endTime: e.endTime, uid: ++shiftUid })));
  }, [schedule.data]);

  const list = shifts ?? [];
  const patch = (uid: number, change: Partial<Shift>) => setShifts(list.map((s) => (s.uid === uid ? { ...s, ...change } : s)));
  const invalid = list.some((s) => !s.branchId || !s.startTime || !s.endTime || s.startTime >= s.endTime);
  const defaultBranch = branches[0]?.id ?? '';
  const branchOptions = branches.map((b) => ({ value: b.id, label: pick(b.name, b.nameAr) }));

  const add = (weekday: number) => {
    const previous = [...list].reverse().find((s) => s.weekday === weekday) ?? list[list.length - 1];
    setShifts([...list, { uid: ++shiftUid, weekday, branchId: previous?.branchId ?? defaultBranch, startTime: previous && previous.weekday === weekday ? previous.endTime : (previous?.startTime ?? '09:00'), endTime: previous && previous.weekday === weekday ? '21:00' : (previous?.endTime ?? '18:00') }]);
  };
  const copyFirstDay = () => {
    const source = WEEK_ORDER.map((d) => list.filter((s) => s.weekday === Number(d))).find((day) => day.length);
    if (!source) return;
    const from = source[0].weekday;
    const days = [...new Set(list.map((s) => s.weekday))];
    setShifts(days.flatMap((weekday) => (weekday === from ? source : source.map((s) => ({ ...s, weekday, uid: ++shiftUid })))));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await api.client.put<ScheduleEntry[]>(`/staff/${member.id}/schedule`, { entries: list.map(({ uid: _uid, ...entry }) => entry) });
      queryClient.setQueryData(admKeys.staff.schedule(member.id), saved);
      toasts.success(t('adm.staff.schedule.saved'), member.user.fullName);
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{t('adm.staff.schedule.title')}</CardTitle>
          <CardDescription>{t('adm.staff.schedule.text')}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {schedule.isPending ? (
          <CardSkeleton lines={3} className="border-0 p-0 shadow-none" />
        ) : schedule.isError ? (
          <LoadError error={schedule.error} onRetry={() => void schedule.refetch()} />
        ) : branches.length === 0 ? (
          <Alert tone="warning">{t('adm.staff.schedule.noBranch')}</Alert>
        ) : (
          <>
            <ul className="divide-y rounded-lg border">
              {WEEK_ORDER.map((day) => {
                const dayShifts = list.filter((s) => s.weekday === Number(day));
                return (
                  <li key={day} className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-start sm:gap-4">
                    <span className="w-28 shrink-0 pt-2 text-base font-medium">{t(`adm.days.${day}`)}</span>
                    <div className="min-w-0 flex-1 space-y-2">
                      {dayShifts.length === 0 ? <p className="pt-2 text-base text-muted-foreground">{t('adm.staff.schedule.dayOff')}</p> : null}
                      {dayShifts.map((s) => {
                        const bad = !!s.startTime && !!s.endTime && s.startTime >= s.endTime;
                        return (
                          <div key={s.uid} className="flex flex-wrap items-center gap-2">
                            <TimeInput value={s.startTime} disabled={!canManage} aria-invalid={bad} aria-label={t('adm.staff.schedule.from', { day: t(`adm.days.${day}`) })} onChange={(startTime) => patch(s.uid, { startTime })} />
                            <span aria-hidden="true" className="text-muted-foreground">
                              –
                            </span>
                            <TimeInput value={s.endTime} disabled={!canManage} aria-invalid={bad} aria-label={t('adm.staff.schedule.to', { day: t(`adm.days.${day}`) })} onChange={(endTime) => patch(s.uid, { endTime })} />
                            {branchOptions.length > 1 || !branchOptions.some((b) => b.value === s.branchId) ? (
                              <Select aria-label={t('adm.staff.schedule.branch')} className="w-full sm:w-52" disabled={!canManage} value={s.branchId} onValueChange={(branchId) => patch(s.uid, { branchId })} options={branchOptions} placeholder={t('adm.staff.schedule.branch')} />
                            ) : null}
                            {canManage ? (
                              <Button variant="ghost" size="icon-sm" aria-label={t('adm.staff.schedule.removeShift', { day: t(`adm.days.${day}`) })} onClick={() => setShifts(list.filter((x) => x.uid !== s.uid))}>
                                <Trash2 aria-hidden="true" />
                              </Button>
                            ) : null}
                            {bad ? (
                              <span role="alert" className="basis-full text-sm text-destructive-text">
                                {t('adm.hours.invalid')}
                              </span>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                    {canManage ? (
                      <Button variant="subtle" size="sm" className="self-start" onClick={() => add(Number(day))} aria-label={t('adm.staff.schedule.addShiftOn', { day: t(`adm.days.${day}`) })}>
                        <Plus aria-hidden="true" />
                        {t('adm.staff.schedule.addShift')}
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {canManage && list.length > 0 && new Set(list.map((s) => s.weekday)).size > 1 ? (
              <Button variant="link" size="sm" onClick={copyFirstDay}>
                {t('adm.staff.schedule.copyFirst')}
              </Button>
            ) : null}
            <ActionError error={error} />
          </>
        )}
      </CardContent>
      {canManage && branches.length > 0 && !schedule.isPending && !schedule.isError ? (
        <CardFooter className="justify-end">
          <Button onClick={() => void save()} disabled={invalid} loading={saving} loadingText={t('common.saving')}>
            {t('adm.staff.schedule.save')}
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}
