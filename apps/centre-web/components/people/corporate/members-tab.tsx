'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, RotateCw, Send, UserCheck, UserMinus, UserPlus, UserX, Users } from 'lucide-react';
import { corporateMemberSchema } from '@typease/validation';
import { isApiError } from '@typease/api-client';
import {
  Badge, Button, Card, ConfirmDialog, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
  EmptyState, Form, FormError, FormField, Input, PhoneInput, Skeleton, StatusBadge, formatPhone, useApi, useI18n, useSession, useToast, useZodForm,
} from '@typease/ui';
import { peopleKeys } from '@/lib/keys/people';
import { BooleanField } from '../form-bits';
import { LoadError, Ltr, UpgradeAlert, isPlanLimit, usePlan } from '../shared';
import type { CorporateAccountDetail, CorporateMember } from '../types';

/**
 * Authorised contacts: the people who act for the company in the corporate portal. Inviting needs the
 * plan feature "corporate portal"; without it the upgrade message is shown instead of the form
 * (also when the API answers 402).
 */
export function MembersTab({ account }: { account: CorporateAccountDetail }) {
  const { t, formatDate } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const session = useSession();
  const queryClient = useQueryClient();
  const plan = usePlan();
  const [inviting, setInviting] = React.useState(false);
  const [removing, setRemoving] = React.useState<CorporateMember | null>(null);
  const [planBlocked, setPlanBlocked] = React.useState(false);
  const canManage = session.hasPermission('corporate.manage') && account.status !== 'ARCHIVED';
  const noPortal = planBlocked || plan.data?.plan.features.corporatePortal === false;

  const members = useQuery({ queryKey: peopleKeys.corporate.members(account.id), queryFn: () => api.client.get<CorporateMember[]>(`/corporate-accounts/${account.id}/members`) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: peopleKeys.corporate.detail(account.id) });
  const fail = (error: unknown) => {
    if (isPlanLimit(error, 'corporatePortal')) setPlanBlocked(true);
    else toasts.error(error);
  };

  const resend = useMutation({
    mutationFn: (member: CorporateMember) => api.client.post(`/corporate-accounts/${account.id}/members/${member.id}/resend-invitation`),
    onSuccess: (_r, member) => toasts.success(t('people.corporate.members.resent'), member.email),
    onError: fail,
  });
  const setStatus = useMutation({
    mutationFn: ({ member, status }: { member: CorporateMember; status: 'ACTIVE' | 'SUSPENDED' }) => api.client.patch<CorporateMember>(`/corporate-accounts/${account.id}/members/${member.id}`, { status }),
    onSuccess: async (_r, { member, status }) => {
      toasts.success(status === 'SUSPENDED' ? t('people.corporate.members.suspended') : t('people.corporate.members.reactivated'), member.fullName);
      await refresh();
    },
    onError: fail,
  });
  const remove = async (member: CorporateMember) => {
    try {
      await api.client.delete(`/corporate-accounts/${account.id}/members/${member.id}`);
      toasts.success(t('people.corporate.members.removed'), member.fullName);
      await refresh();
    } catch (error) {
      toasts.error(error);
      throw error;
    }
  };

  const invite =
    canManage && !noPortal ? (
      <Button variant="outline" onClick={() => setInviting(true)}>
        <UserPlus aria-hidden="true" />
        {t('people.corporate.members.invite')}
      </Button>
    ) : null;
  const list = members.data ?? [];

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <p className="max-w-2xl text-base text-muted-foreground">{t('people.corporate.members.text')}</p>
        {invite}
      </div>
      {noPortal ? (
        <UpgradeAlert className="mb-4" title={t('people.corporate.members.planTitle')}>
          {t('people.corporate.members.planText')}
        </UpgradeAlert>
      ) : null}
      {account.status === 'PENDING_VERIFICATION' && list.length > 0 ? <p className="mb-4 text-sm text-muted-foreground">{t('people.corporate.members.pendingNote')}</p> : null}

      <Card>
        {members.isPending ? (
          <div className="space-y-3 p-5" role="status" aria-label={t('common.loading')}>
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : members.isError ? (
          <div className="p-4">
            <LoadError error={members.error} onRetry={() => void members.refetch()} />
          </div>
        ) : list.length === 0 ? (
          <EmptyState icon={<Users />} title={t('people.corporate.members.empty')} description={noPortal ? undefined : t('people.corporate.members.emptyText')} action={invite} />
        ) : (
          <ul className="divide-y">
            {list.map((member) => (
              <li key={member.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
                <div className="min-w-0 flex-1 basis-64">
                  <p className="flex flex-wrap items-center gap-2 text-base font-medium text-foreground">
                    {member.fullName}
                    <StatusBadge kind="membership" status={member.status} />
                    {member.isAuthorisedSignatory ? <Badge tone="brand">{t('people.corporate.members.signatory')}</Badge> : null}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    <Ltr className="break-all">{member.email}</Ltr>
                    {member.phone ? (
                      <>
                        {' · '}
                        <Ltr>{formatPhone(member.phone)}</Ltr>
                      </>
                    ) : null}
                  </p>
                  <p className="text-sm text-muted-foreground">{t('people.corporate.members.role', { date: formatDate(member.createdAt) })}</p>
                </div>
                {canManage ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`${t('common.moreActions')}: ${member.fullName}`}>
                        <MoreHorizontal aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      {member.status === 'INVITED' ? (
                        <DropdownMenuItem onSelect={() => resend.mutate(member)}>
                          <Send aria-hidden="true" />
                          {t('people.corporate.members.resend')}
                        </DropdownMenuItem>
                      ) : null}
                      {member.status === 'ACTIVE' ? (
                        <DropdownMenuItem onSelect={() => setStatus.mutate({ member, status: 'SUSPENDED' })}>
                          <UserX aria-hidden="true" />
                          {t('people.corporate.members.suspend')}
                        </DropdownMenuItem>
                      ) : null}
                      {member.status === 'SUSPENDED' ? (
                        <DropdownMenuItem onSelect={() => setStatus.mutate({ member, status: 'ACTIVE' })}>
                          <UserCheck aria-hidden="true" />
                          {t('people.corporate.members.reactivate')}
                        </DropdownMenuItem>
                      ) : null}
                      <DropdownMenuItem destructive onSelect={() => setRemoving(member)}>
                        <UserMinus aria-hidden="true" />
                        {member.status === 'INVITED' ? t('people.corporate.members.withdraw') : t('people.corporate.members.remove')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {resend.isPending || setStatus.isPending ? (
        <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <RotateCw className="size-3.5 animate-spin" aria-hidden="true" />
          {t('common.saving')}
        </p>
      ) : null}

      {inviting ? <InviteMemberDialog account={account} open onOpenChange={setInviting} onPlanBlocked={() => setPlanBlocked(true)} /> : null}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(next) => !next && setRemoving(null)}
        title={t('people.corporate.members.removeTitle', { name: removing?.fullName ?? '' })}
        description={t('people.corporate.members.removeText')}
        confirmLabel={removing?.status === 'INVITED' ? t('people.corporate.members.withdraw') : t('people.corporate.members.remove')}
        onConfirm={() => (removing ? remove(removing) : undefined)}
      />
    </>
  );
}

function InviteMemberDialog({ account, open, onOpenChange, onPlanBlocked }: { account: CorporateAccountDetail; open: boolean; onOpenChange: (open: boolean) => void; onPlanBlocked: () => void }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const form = useZodForm(corporateMemberSchema, { defaultValues: { fullName: '', email: '', phone: '', isAuthorisedSignatory: false }, emptyAs: 'null' });

  const save = async (values: { fullName: string; email: string; phone?: string | null; isAuthorisedSignatory: boolean }) => {
    try {
      const member = await api.client.post<CorporateMember>(`/corporate-accounts/${account.id}/members`, values);
      toasts.success(t('people.corporate.members.invited'), t('people.corporate.members.invitedText', { email: member.email }));
      await queryClient.invalidateQueries({ queryKey: peopleKeys.corporate.detail(account.id) });
      onOpenChange(false);
    } catch (error) {
      if (isPlanLimit(error, 'corporatePortal')) {
        onPlanBlocked();
        onOpenChange(false);
        return;
      }
      if (isApiError(error) && (error.code === 'ALREADY_MEMBER' || error.code === 'EMAIL_IN_USE')) {
        form.setError('email', { type: 'server', message: error.message });
        form.setFocus('email');
        return;
      }
      throw error;
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <Form form={form} onSubmit={save} className="flex min-h-0 flex-1 flex-col space-y-0">
          <DialogHeader>
            <DialogTitle>{t('people.corporate.members.inviteTitle')}</DialogTitle>
            <DialogDescription>{t('people.corporate.members.inviteText', { name: account.companyName })}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="fullName" label={t('people.corporate.members.fullName')} required>
              {(field) => <Input {...field} autoComplete="off" dir="auto" autoFocus />}
            </FormField>
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField name="email" label={t('customers.form.email')} required>
                {(field) => <Input {...field} type="email" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false} dir="ltr" />}
              </FormField>
              <FormField name="phone" label={t('customers.form.phone')} optional>
                {(field) => <PhoneInput {...field} />}
              </FormField>
            </div>
            <BooleanField name="isAuthorisedSignatory" label={t('people.corporate.members.signatoryChoice')} description={t('people.corporate.members.signatoryHint')} />
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.loading')}>
              {t('people.corporate.members.inviteSubmit')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
