'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { MailPlus, Pencil, Send, ShieldCheck, ShieldOff, UserCheck, UserCog, UserX } from 'lucide-react';
import { createPlatformStaffSchema, updatePlatformStaffSchema } from '@typease/validation';
import {
  Alert, Avatar, Badge, Button, DataTable, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError, FormField, Input, Label, PageHeader, RadioGroup,
  RadioGroupItem, RequirePermission, ChoiceLabel, useI18n, useToast, useZodForm, type DataTableColumn, type DataTableFilter, type RowAction,
} from '@typease/ui';
import { ConfirmAction, RelativeTime, matches, pageOf } from '@/components/shared';
import { usePlatformApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import type { PlatformRole, PlatformStaffMember } from '@/lib/types';

const ROLES: PlatformRole[] = ['SUPER_ADMIN', 'SUPPORT_AGENT'];
type Pending = { kind: 'role' | 'disable' | 'enable' | 'resend'; member: PlatformStaffMember };

export function StaffPage() {
  return (
    <RequirePermission anyOf={['platform.staff.manage']}>
      <StaffScreen />
    </RequirePermission>
  );
}

/** TypEase staff accounts (GET /platform/staff): invite, change role, disable. Nobody can change their own account. */
function StaffScreen() {
  const { t, formatDate } = useI18n();
  const api = usePlatformApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const [inviting, setInviting] = React.useState(false);
  const [renaming, setRenaming] = React.useState<PlatformStaffMember | null>(null);
  const [pending, setPending] = React.useState<Pending | null>(null);
  const [role, setRole] = React.useState<PlatformRole>('SUPPORT_AGENT');
  const roleId = React.useId();
  const refresh = () => Promise.all([keys.staff.all, keys.audit.all, keys.security.all].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  const ask = (kind: Pending['kind'], member: PlatformStaffMember) => {
    setRole(member.role === 'SUPER_ADMIN' ? 'SUPPORT_AGENT' : 'SUPER_ADMIN');
    setPending({ kind, member });
  };

  const columns = React.useMemo<Array<DataTableColumn<PlatformStaffMember>>>(
    () => [
      {
        id: 'name',
        header: t('staff.columns.name'),
        sortField: 'name',
        mobile: 'title',
        className: 'min-w-60',
        cell: (m) => (
          <span className="flex items-center gap-3">
            <Avatar name={m.fullName} size="sm" className="hidden sm:inline-flex" />
            <span className="min-w-0">
              <span className="block font-medium text-foreground">
                <bdi>{m.fullName}</bdi>
                {m.isYou ? <span className="ms-2 text-sm font-normal text-muted-foreground">({t('pc.you')})</span> : null}
              </span>
              <span className="ltr-value block max-w-64 truncate text-sm font-normal text-muted-foreground">{m.email}</span>
            </span>
          </span>
        ),
      },
      { id: 'role', header: t('account.role'), sortField: 'role', cell: (m) => t(`account.roles.${m.role}`) },
      {
        id: 'status',
        header: t('pc.status'),
        mobile: 'badge',
        cell: (m) => (m.status === 'DISABLED' ? <Badge tone="danger">{t('staff.status.DISABLED')}</Badge> : m.invitationPending ? <Badge tone="warning">{t('staff.status.INVITED')}</Badge> : <Badge tone="success">{t('staff.status.ACTIVE')}</Badge>),
      },
      {
        id: 'mfa',
        header: t('account.twoStep'),
        cell: (m) =>
          m.invitationPending ? null : m.mfaEnabled ? (
            <Badge tone="success" icon={<ShieldCheck />}>
              {t('pc.on')}
            </Badge>
          ) : (
            <Badge tone="warning" icon={<ShieldOff />}>
              {t('staff.mfaOff')}
            </Badge>
          ),
      },
      { id: 'lastLogin', header: t('staff.columns.lastLogin'), sortField: 'lastLoginAt', className: 'whitespace-nowrap', cell: (m) => (m.lastLoginAt ? <RelativeTime value={m.lastLoginAt} /> : <span className="text-muted-foreground">{t('staff.neverSignedIn')}</span>) },
      { id: 'added', header: t('staff.columns.added'), sortField: 'createdAt', className: 'whitespace-nowrap tabular', cell: (m) => formatDate(m.createdAt) },
    ],
    [t, formatDate],
  );

  const filters = React.useMemo<DataTableFilter[]>(
    () => [
      { id: 'role', type: 'select', label: t('account.role'), options: ROLES.map((r) => ({ value: r, label: t(`account.roles.${r}`) })) },
      { id: 'status', type: 'select', label: t('pc.status'), options: (['ACTIVE', 'DISABLED'] as const).map((s) => ({ value: s, label: t(`staff.status.${s}`) })) },
    ],
    [t],
  );

  const rowActions = React.useMemo<Array<RowAction<PlatformStaffMember>>>(
    () => [
      { id: 'rename', label: t('staff.rename.action'), icon: <Pencil aria-hidden="true" />, onSelect: setRenaming },
      { id: 'role', label: t('staff.role.action'), icon: <UserCog aria-hidden="true" />, hidden: (m) => m.isYou || m.status === 'DISABLED', onSelect: (m) => ask('role', m) },
      { id: 'resend', label: t('staff.resend.action'), icon: <Send aria-hidden="true" />, hidden: (m) => !m.invitationPending || m.status === 'DISABLED', onSelect: (m) => ask('resend', m) },
      { id: 'disable', label: t('staff.disable.action'), icon: <UserX aria-hidden="true" />, destructive: true, hidden: (m) => m.isYou || m.status === 'DISABLED', onSelect: (m) => ask('disable', m) },
      { id: 'enable', label: t('staff.enable.action'), icon: <UserCheck aria-hidden="true" />, hidden: (m) => m.isYou || m.status !== 'DISABLED', onSelect: (m) => ask('enable', m) },
    ],
    [t],
  );

  const invite = (
    <Button variant="accent" onClick={() => setInviting(true)}>
      <MailPlus aria-hidden="true" />
      {t('staff.invite.action')}
    </Button>
  );
  const member = pending?.member;
  const name = member?.fullName ?? '';

  return (
    <>
      <PageHeader title={t('nav.staff')} description={t('staff.description')} action={invite} />
      <DataTable<PlatformStaffMember>
        caption={t('nav.staff')}
        queryKey={keys.staff.all}
        queryFn={async (params, signal) => {
          const rows = await api.staff.list({ role: params.role as string | undefined, status: params.status as string | undefined }, signal);
          const visible = rows.filter((m) => matches(params.q as string | undefined, m.fullName, m.email));
          return pageOf(visible, params, { name: (m) => m.fullName, role: (m) => m.role, lastLoginAt: (m) => m.lastLoginAt, createdAt: (m) => m.createdAt });
        }}
        columns={columns}
        rowKey={(m) => m.id}
        rowActions={rowActions}
        filters={filters}
        searchPlaceholder={t('staff.searchPlaceholder')}
        defaultSort="name:asc"
        empty={{ icon: <UserCog />, title: t('staff.emptyTitle'), description: t('staff.emptyText'), action: invite }}
      />
      <p className="mt-3 text-sm text-muted-foreground">{t('staff.note')}</p>

      <InviteDialog open={inviting} onOpenChange={setInviting} />
      <RenameDialog member={renaming} onClose={() => setRenaming(null)} />

      <ConfirmAction
        open={pending?.kind === 'role'}
        onOpenChange={(open) => !open && setPending(null)}
        tone="default"
        title={t('staff.role.title', { name })}
        description={t('staff.role.text')}
        confirmLabel={t('staff.role.action')}
        onConfirm={async () => {
          if (role === member!.role) throw new Error(t('staff.role.same'));
          await api.staff.update(member!.id, { role });
          await refresh();
          toasts.success(t('staff.role.done', { name, role: t(`account.roles.${role}`) }));
        }}
      >
        <div className="space-y-2">
          <Label id={`${roleId}-label`}>{t('staff.role.newRole')}</Label>
          <RadioGroup value={role} onValueChange={(next) => setRole(next as PlatformRole)} aria-labelledby={`${roleId}-label`} className="space-y-3">
            {ROLES.map((value) => (
              <ChoiceLabel key={value} htmlFor={`${roleId}-${value}`} control={<RadioGroupItem id={`${roleId}-${value}`} value={value} />} label={t(`account.roles.${value}`)} description={t(`staff.roles.${value}`)} />
            ))}
          </RadioGroup>
        </div>
      </ConfirmAction>
      <ConfirmAction
        open={pending?.kind === 'disable'}
        onOpenChange={(open) => !open && setPending(null)}
        title={t('staff.disable.title', { name })}
        description={t('staff.disable.text')}
        confirmLabel={t('staff.disable.action')}
        onConfirm={async () => {
          await api.staff.disable(member!.id);
          await Promise.all([refresh(), queryClient.invalidateQueries({ queryKey: keys.access.all })]);
          toasts.success(t('staff.disable.done', { name }));
        }}
      />
      <ConfirmAction
        open={pending?.kind === 'enable'}
        onOpenChange={(open) => !open && setPending(null)}
        tone="default"
        title={t('staff.enable.title', { name })}
        description={t('staff.enable.text')}
        confirmLabel={t('staff.enable.action')}
        onConfirm={async () => {
          await api.staff.enable(member!.id);
          await refresh();
          toasts.success(t('staff.enable.done', { name }));
        }}
      />
      <ConfirmAction
        open={pending?.kind === 'resend'}
        onOpenChange={(open) => !open && setPending(null)}
        tone="default"
        title={t('staff.resend.title')}
        description={t('staff.resend.text', { email: member?.email ?? '' })}
        confirmLabel={t('staff.resend.action')}
        onConfirm={async () => {
          const result = await api.staff.resendInvitation(member!.id);
          toasts.success(t('staff.resend.done', { email: result.email }));
        }}
      />
    </>
  );
}

function InviteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const api = usePlatformApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const form = useZodForm(createPlatformStaffSchema, { defaultValues: { fullName: '', email: '', role: 'SUPPORT_AGENT' } });
  const id = React.useId();
  React.useEffect(() => {
    if (open) form.reset({ fullName: '', email: '', role: 'SUPPORT_AGENT' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={(next) => !form.formState.isSubmitting && onOpenChange(next)}>
      <DialogContent>
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            const created = await api.staff.create(values);
            await Promise.all([keys.staff.all, keys.audit.all, keys.security.all].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
            toasts.success(t('staff.invite.done', { name: created.fullName }), t('staff.invite.doneText', { email: created.email }));
            onOpenChange(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('staff.invite.title')}</DialogTitle>
            <DialogDescription>{t('staff.invite.text')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="fullName" label={t('staff.invite.fullName')} required>
              {(field) => <Input {...field} autoComplete="off" dir="auto" autoFocus />}
            </FormField>
            <FormField name="email" label={t('staff.invite.email')} required hint={t('staff.invite.emailHint')}>
              {(field) => <Input {...field} type="email" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false} dir="ltr" />}
            </FormField>
            <FormField name="role" label={t('account.role')} required>
              {(field) => (
                <RadioGroup id={field.id} value={field.value} onValueChange={field.onChange} aria-label={t('account.role')} className="space-y-3">
                  {[...ROLES].reverse().map((value) => (
                    <ChoiceLabel key={value} htmlFor={`${id}-${value}`} control={<RadioGroupItem id={`${id}-${value}`} value={value} />} label={t(`account.roles.${value}`)} description={t(`staff.roles.${value}`)} />
                  ))}
                </RadioGroup>
              )}
            </FormField>
            <Alert tone="info">{t('staff.invite.mfaNote')}</Alert>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={form.formState.isSubmitting}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('staff.invite.submit')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function RenameDialog({ member, onClose }: { member: PlatformStaffMember | null; onClose: () => void }) {
  const { t } = useI18n();
  const api = usePlatformApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  // Only the name is sent: the role is changed on its own, behind a confirmation.
  const form = useZodForm(updatePlatformStaffSchema, { defaultValues: { fullName: '' } });
  React.useEffect(() => {
    if (member) form.reset({ fullName: member.fullName });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [member]);
  return (
    <Dialog open={!!member} onOpenChange={(open) => !open && !form.formState.isSubmitting && onClose()}>
      <DialogContent size="sm">
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            await api.staff.update(member!.id, values);
            await Promise.all([keys.staff.all, keys.audit.all].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
            toasts.success(t('staff.rename.done'));
            onClose();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('staff.rename.title')}</DialogTitle>
            <DialogDescription>
              <span className="ltr-value">{member?.email}</span>
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="fullName" label={t('staff.invite.fullName')} required>
              {(field) => <Input {...field} autoComplete="off" dir="auto" autoFocus />}
            </FormField>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={form.formState.isSubmitting}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
