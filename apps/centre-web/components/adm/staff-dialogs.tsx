'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { inviteStaffSchema } from '@typease/validation';
import {
  Button, ChoiceLabel, ConfirmDialog, DevTokenHint, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError, FormField,
  Input, RadioGroup, RadioGroupItem, useApi, useI18n, useToast, useZodForm,
} from '@typease/ui';
import { RoleSelect } from '@/components/pickers';
import { admKeys } from '@/lib/keys/adm';
import { ActionError, CheckList, PlanLimitAlert, isPlanLimit, useFailToast } from './shared';
import type { BranchRow, DevTokenReply, StaffMember } from './types';

const EMPTY = { email: '', fullName: '', roleKey: '', jobTitle: '', allBranches: true, branchIds: [] as string[] };

/**
 * Invite a staff member (POST /staff/invitations). The plan limit (402) and the API's refusal of roles
 * above the inviter's own permissions are explained in place; what was typed stays.
 */
export function InviteStaffDialog({ open, onOpenChange, branches }: { open: boolean; onOpenChange: (open: boolean) => void; branches: BranchRow[] }) {
  const { t, pick } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const form = useZodForm(inviteStaffSchema, { defaultValues: EMPTY });
  const [limit, setLimit] = React.useState<unknown>(null);
  const [devToken, setDevToken] = React.useState<string | null>(null);
  const scopeId = React.useId();

  React.useEffect(() => {
    if (open) {
      // With one active branch there is nothing to choose (inactive branches do not count): the person works everywhere.
      form.reset({ ...EMPTY, allBranches: branches.filter((b) => b.isActive).length <= 1 });
      setLimit(null);
      setDevToken(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const allBranches = form.watch('allBranches');
  const active = branches.filter((b) => b.isActive);

  if (devToken) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('adm.staff.invite.sentTitle')}</DialogTitle>
            <DialogDescription>{t('adm.staff.invite.sentText')}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <DevTokenHint>
              <Link className="text-secondary-text underline-offset-4 hover:underline" href={`/accept-invitation?token=${encodeURIComponent(devToken)}`} target="_blank" rel="noreferrer">
                {t('adm.staff.invite.devLink')}
              </Link>
            </DevTokenHint>
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>{t('common.done')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            setLimit(null);
            const everywhere = values.allBranches || active.length <= 1;
            if (!everywhere && values.branchIds.length === 0) {
              form.setError('branchIds', { type: 'manual', message: t('adm.staff.invite.branchRequired') });
              return;
            }
            try {
              const reply = await api.client.post<{ id: string; status: string } & DevTokenReply>('/staff/invitations', { ...values, allBranches: everywhere, branchIds: everywhere ? [] : values.branchIds });
              toasts.success(t('adm.staff.invite.sent'), t('adm.staff.invite.sentTo', { email: values.email }));
              await queryClient.invalidateQueries({ queryKey: admKeys.staff.all });
              await queryClient.invalidateQueries({ queryKey: admKeys.tenant.usage });
              if (reply.dev?.invitationToken) setDevToken(reply.dev.invitationToken);
              else onOpenChange(false);
            } catch (error) {
              if (isPlanLimit(error)) {
                setLimit(error);
                return;
              }
              throw error;
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('adm.staff.invite.title')}</DialogTitle>
            <DialogDescription>{t('adm.staff.invite.description')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField name="fullName" label={t('adm.staff.fields.fullName')} required>
                {(field) => <Input {...field} autoComplete="off" autoFocus />}
              </FormField>
              <FormField name="email" label={t('adm.staff.fields.email')} required hint={t('adm.staff.invite.emailHint')}>
                {(field) => <Input {...field} type="email" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false} dir="ltr" />}
              </FormField>
              <FormField name="roleKey" label={t('adm.staff.fields.role')} required hint={t('adm.staff.invite.roleHint')}>
                {(field) => <RoleSelect id={field.id} value={field.value || undefined} onChange={field.onChange} onBlur={field.onBlur} aria-invalid={field['aria-invalid']} aria-describedby={field['aria-describedby']} placeholder={t('common.selectPlaceholder')} />}
              </FormField>
              <FormField name="jobTitle" label={t('adm.staff.fields.jobTitle')} optional>
                {(field) => <Input {...field} autoComplete="off" />}
              </FormField>
            </div>

            {active.length > 1 ? (
              <>
                <FormField name="allBranches" label={t('adm.staff.fields.branchAccess')}>
                  {(field) => (
                    <RadioGroup id={field.id} value={field.value ? 'all' : 'some'} onValueChange={(v) => field.onChange(v === 'all')} aria-label={t('adm.staff.fields.branchAccess')} className="flex flex-wrap gap-x-8 gap-y-2">
                      <ChoiceLabel htmlFor={`${scopeId}-all`} control={<RadioGroupItem id={`${scopeId}-all`} value="all" />} label={t('adm.staff.branches.all')} />
                      <ChoiceLabel htmlFor={`${scopeId}-some`} control={<RadioGroupItem id={`${scopeId}-some`} value="some" />} label={t('adm.staff.branches.some')} />
                    </RadioGroup>
                  )}
                </FormField>
                {allBranches ? null : (
                  <FormField name="branchIds" label={t('adm.staff.fields.branches')} required>
                    {(field) => <CheckList aria-label={t('adm.staff.fields.branches')} options={active.map((b) => ({ value: b.id, label: pick(b.name, b.nameAr), description: b.code }))} value={Array.isArray(field.value) ? field.value : []} onChange={field.onChange} />}
                  </FormField>
                )}
              </>
            ) : null}

            {limit ? <PlanLimitAlert error={limit} /> : null}
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('adm.staff.invite.submit')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

export type StaffActionKind = 'suspend' | 'reactivate' | 'remove' | 'resend';

/**
 * Suspend / reactivate / remove / resend-invitation for one staff member, shared by the list and the
 * detail page. Blocking reasons from the API (open requests, last owner, plan limit) stay in the dialog.
 */
export function useStaffActions(options: { onRemoved?: () => void } = {}) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const [pending, setPending] = React.useState<{ kind: StaffActionKind; member: StaffMember } | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [devToken, setDevToken] = React.useState<string | null>(null);

  const fail = useFailToast();

  const resend = async (member: StaffMember) => {
    try {
      const reply = await api.client.post<{ status: string } & DevTokenReply>(`/staff/${member.id}/resend-invitation`);
      toasts.success(t('adm.staff.actions.resent'), member.user.email);
      if (reply.dev?.invitationToken) setDevToken(reply.dev.invitationToken);
    } catch (e) {
      fail(e);
    }
  };

  /** Resending is harmless and happens at once; the other actions ask first. */
  const ask = (kind: StaffActionKind, member: StaffMember) => {
    if (kind === 'resend') {
      void resend(member);
      return;
    }
    setError(null);
    setPending({ kind, member });
  };

  const run = async () => {
    if (!pending) return;
    const { kind, member } = pending;
    setError(null);
    try {
      if (kind === 'remove') {
        await api.client.delete(`/staff/${member.id}`);
        toasts.success(t('adm.staff.actions.removed'), member.user.fullName);
      } else {
        await api.client.patch(`/staff/${member.id}`, { status: kind === 'suspend' ? 'SUSPENDED' : 'ACTIVE' });
        toasts.success(kind === 'suspend' ? t('adm.staff.actions.suspended') : t('adm.staff.actions.reactivated'), member.user.fullName);
      }
      await queryClient.invalidateQueries({ queryKey: admKeys.staff.all });
      await queryClient.invalidateQueries({ queryKey: admKeys.tenant.usage });
      if (kind === 'remove') options.onRemoved?.();
    } catch (e) {
      setError(e);
      throw e;
    }
  };

  const name = pending?.member.user.fullName ?? '';
  const kind = pending?.kind === 'reactivate' || pending?.kind === 'remove' ? pending.kind : 'suspend';
  const dialogs = (
    <>
      <ConfirmDialog
        open={!!pending}
        onOpenChange={(open) => !open && setPending(null)}
        tone={kind === 'remove' || kind === 'suspend' ? 'destructive' : 'default'}
        title={t(`adm.staff.confirm.${kind}Title`, { name })}
        description={t(`adm.staff.confirm.${kind}Text`, { name })}
        confirmLabel={t(`adm.staff.actions.${kind}`)}
        onConfirm={run}
      >
        {error ? <ActionError error={error} /> : null}
      </ConfirmDialog>
      <Dialog open={!!devToken} onOpenChange={(open) => !open && setDevToken(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('adm.staff.invite.sentTitle')}</DialogTitle>
            <DialogDescription>{t('adm.staff.invite.sentText')}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <DevTokenHint>
              <Link className="text-secondary-text underline-offset-4 hover:underline" href={`/accept-invitation?token=${encodeURIComponent(devToken ?? '')}`} target="_blank" rel="noreferrer">
                {t('adm.staff.invite.devLink')}
              </Link>
            </DevTokenHint>
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => setDevToken(null)}>{t('common.done')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
  return { ask, dialogs };
}
