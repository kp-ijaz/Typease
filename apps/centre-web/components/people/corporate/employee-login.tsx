'use client';

import * as React from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { MailPlus, Send, UserMinus } from 'lucide-react';
import { corporateEmployeeLoginSchema } from '@typease/validation';
import { isApiError } from '@typease/api-client';
import {
  Alert, Badge, Button, ConfirmDialog, DescriptionList, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError, FormField, Input, STATUS_META, StatusBadge, useApi, useI18n, useToast,
  useZodForm, type DescriptionItem,
} from '@typease/ui';
import { peopleKeys } from '@/lib/keys/people';
import { Ltr, UpgradeAlert, isPlanLimit, usePlan } from '../shared';
import type { CorporateAccountDetail, CorporateEmployee, EmployeeLogin, EmployeeLoginInvited } from '../types';

const NO_LOGIN: EmployeeLogin = { status: 'NONE', email: null, invitedAt: null, joinedAt: null, lastLoginAt: null };

/** The employee's personal data was erased after a deletion request: nothing can be done with the record any more. */
export const isErasedEmployee = (employee: Pick<CorporateEmployee, 'customerStatus'>) => employee.customerStatus === 'ANONYMISED';

/** Login state of an employee as a badge; nothing when the employee has no login. */
export function EmployeeLoginBadge({ login }: { login: EmployeeLogin | undefined }) {
  const { t, has } = useI18n();
  if (!login || login.status === 'NONE') return null;
  // The colours of the portal-access states; the words are those of a login ("Active"), not of a customer account.
  const key = `people.corporate.logins.states.${login.status}`;
  if (!has(key)) return <StatusBadge kind="portalAccess" status={login.status} />;
  return (
    <Badge tone={STATUS_META.portalAccess[login.status].tone} data-status={login.status}>
      {t(key)}
    </Badge>
  );
}

/**
 * The corporate-portal login of one employee (role "corporate employee": the person sees their own requests
 * and documents, nothing of their colleagues): its state, and - for staff who may manage companies -
 * inviting, sending the invitation again and taking the login away.
 */
export function EmployeeLoginDialog({
  account, employee: row, canManage, open, onOpenChange, onChanged,
}: {
  account: CorporateAccountDetail;
  employee: CorporateEmployee;
  canManage: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => Promise<unknown>;
}) {
  const { t, formatDateTime } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const plan = usePlan();
  const base = `/corporate-accounts/${account.id}/employees/${row.id}`;
  // The row of the list may be a minute old; the dialog works on the employee as it is now.
  const query = useQuery({ queryKey: peopleKeys.corporate.employee(account.id, row.id), queryFn: () => api.client.get<CorporateEmployee>(base), initialData: row });
  const employee = query.data;
  const login = employee.login ?? NO_LOGIN;

  /** The API's own words when the plan has no corporate portal (402). */
  const [planMessage, setPlanMessage] = React.useState<string | null>(null);
  const [otherAddress, setOtherAddress] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);
  const noPortal = planMessage !== null || plan.data?.plan.features.corporatePortal === false;

  const form = useZodForm(corporateEmployeeLoginSchema, { defaultValues: { email: row.email ?? '' }, emptyAs: 'null', mode: 'onSubmit' });
  const changed = async () => {
    await Promise.all([query.refetch(), onChanged()]);
  };
  const blocked = (error: unknown) => {
    if (!isPlanLimit(error, 'corporatePortal')) return false;
    setPlanMessage(isApiError(error) ? error.message : '');
    return true;
  };

  const invite = async (values: { email?: string | null }) => {
    try {
      const result = await api.client.post<EmployeeLoginInvited>(`${base}/login`, values.email ? { email: values.email } : {});
      toasts.success(t('people.corporate.logins.invited'), t('people.corporate.logins.invitedText', { email: result.email }));
      setOtherAddress(false);
      await changed();
    } catch (error) {
      if (blocked(error)) return;
      if (isApiError(error) && ['EMAIL_REQUIRED', 'EMAIL_IN_USE', 'INVITATION_PENDING'].includes(error.code)) {
        form.setError('email', { type: 'server', message: error.message });
        form.setFocus('email');
        return;
      }
      // Another colleague may have changed the login in the meantime: show the state as it is now.
      if (isApiError(error) && error.status === 409) void query.refetch();
      throw error;
    }
  };
  const resend = useMutation({
    mutationFn: () => api.client.post<{ status: 'SENT'; email: string }>(`${base}/login/resend-invitation`),
    onSuccess: (result) => toasts.success(t('people.corporate.logins.resent'), result.email),
    onError: (error) => {
      if (blocked(error)) return;
      toasts.error(error);
      void query.refetch();
    },
  });
  const remove = async () => {
    try {
      await api.client.delete(`${base}/login`);
      toasts.success(login.status === 'INVITED' ? t('people.corporate.logins.withdrawn') : t('people.corporate.logins.removed'), employee.fullName);
      await changed();
    } catch (error) {
      toasts.error(error);
      void query.refetch();
      throw error;
    }
  };

  const inactive = employee.status !== 'ACTIVE';
  const locked = employee.customerStatus !== 'ACTIVE';
  const mayInvite = canManage && !noPortal && !inactive && !locked && (login.status === 'NONE' || login.status === 'SUSPENDED' || (login.status === 'INVITED' && otherAddress));
  const stamp = (value: string | null) => (value ? <span className="tabular">{formatDateTime(value)}</span> : null);
  const items: DescriptionItem[] =
    login.status === 'NONE'
      ? []
      : [
          { label: t('people.corporate.logins.status'), value: <EmployeeLoginBadge login={login} />, wide: true },
          { label: t('people.corporate.logins.email'), value: login.email ? <Ltr className="break-all">{login.email}</Ltr> : null, wide: true },
          { label: t('people.corporate.logins.invitedAt'), value: stamp(login.invitedAt) },
          { label: t('people.corporate.logins.joinedAt'), value: login.joinedAt ? stamp(login.joinedAt) : <span className="text-muted-foreground">{t('people.corporate.logins.notJoined')}</span> },
          { label: t('people.corporate.logins.lastLoginAt'), value: login.lastLoginAt ? stamp(login.lastLoginAt) : <span className="text-muted-foreground">{t('people.corporate.logins.never')}</span> },
        ];

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>{t('people.corporate.logins.title')}</DialogTitle>
            <DialogDescription>
              {employee.fullName} · <span className="tabular ltr-value">{employee.customerNo}</span> · {account.companyName}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            {login.status === 'NONE' ? <p className="text-base text-foreground">{t('people.corporate.logins.none')}</p> : <DescriptionList items={items} />}
            <p className="text-sm text-muted-foreground">
              {login.status === 'INVITED'
                ? t('people.corporate.logins.invitedHint')
                : login.status === 'SUSPENDED'
                  ? t('people.corporate.logins.suspendedHint')
                  : t('people.corporate.logins.what')}
            </p>

            {noPortal ? (
              <UpgradeAlert title={t('people.corporate.members.planTitle')}>{planMessage || t('people.corporate.logins.planText')}</UpgradeAlert>
            ) : canManage && inactive && login.status !== 'ACTIVE' ? (
              <Alert tone="info">{t('people.corporate.logins.inactive')}</Alert>
            ) : canManage && locked && login.status !== 'ACTIVE' ? (
              <Alert tone="info">{t('people.corporate.logins.locked')}</Alert>
            ) : null}

            {mayInvite ? (
              <Form form={form} onSubmit={invite} className="space-y-4 rounded-lg border bg-muted/40 p-4">
                <FormField
                  name="email"
                  label={t('people.corporate.logins.inviteEmail')}
                  hint={login.status === 'INVITED' ? t('people.corporate.logins.otherAddressHint') : row.email ? t('people.corporate.logins.inviteEmailHint') : t('people.corporate.logins.inviteEmailMissing')}
                >
                  {(field) => <Input {...field} type="email" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false} dir="ltr" />}
                </FormField>
                <FormError />
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.loading')}>
                    <MailPlus aria-hidden="true" />
                    {login.status === 'SUSPENDED' ? t('people.corporate.logins.inviteAgain') : t('people.corporate.logins.invite')}
                  </Button>
                  {login.status === 'INVITED' ? (
                    <Button variant="ghost" onClick={() => setOtherAddress(false)}>
                      {t('common.cancel')}
                    </Button>
                  ) : null}
                </div>
              </Form>
            ) : null}

            {canManage && login.status === 'INVITED' && !otherAddress ? (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => resend.mutate()} loading={resend.isPending} loadingText={t('common.loading')} disabled={inactive || locked}>
                  <Send aria-hidden="true" />
                  {t('people.corporate.members.resend')}
                </Button>
                {noPortal || inactive || locked ? null : (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      form.reset({ email: '' });
                      setOtherAddress(true);
                    }}
                  >
                    {t('people.corporate.logins.otherAddress')}
                  </Button>
                )}
              </div>
            ) : null}
          </DialogBody>
          <DialogFooter>
            {/* "Close" comes first in the document so that the dialog does not open with the focus on the destructive action. */}
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.close')}
            </Button>
            {canManage && login.status !== 'NONE' ? (
              <Button variant="destructive-outline" className="sm:order-first sm:me-auto" onClick={() => setRemoving(true)}>
                <UserMinus aria-hidden="true" />
                {login.status === 'INVITED' ? t('people.corporate.members.withdraw') : t('people.corporate.logins.remove')}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={login.status === 'INVITED' ? t('people.corporate.logins.withdrawTitle', { name: employee.fullName }) : t('people.corporate.logins.removeTitle', { name: employee.fullName })}
        description={login.status === 'INVITED' ? t('people.corporate.logins.withdrawText') : t('people.corporate.logins.removeText')}
        confirmLabel={login.status === 'INVITED' ? t('people.corporate.members.withdraw') : t('people.corporate.logins.remove')}
        onConfirm={remove}
      />
    </>
  );
}
