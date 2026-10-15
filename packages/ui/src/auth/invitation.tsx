'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { LoginResult } from '@typease/types';
import { trimmed, z } from '@typease/validation';
import type { LoginOk } from '@typease/api-client';
import { useI18n } from '../i18n/provider';
import { useApi, useSession } from '../providers/auth';
import { Alert } from '../components/alert';
import { Button } from '../components/button';
import { PasswordInput } from '../components/fields';
import { Form, FormError, FormField, useZodForm } from '../components/form';
import { Input } from '../components/input';
import { LoadingBlock } from '../components/spinner';
import { AuthCard, AuthLink } from './layout';
import { useNewPasswordRules } from './password-rules';
import { MfaChallenge } from './sign-in';

const existingAccount = z.object({ fullName: trimmed(120, 2).optional(), password: z.string().optional() });

/**
 * Opened from an invitation email (staff, corporate contacts, portal customers).
 * New people set their name and a password; people who already have a TypEase
 * account only confirm. A successful acceptance signs them in.
 */
export function AcceptInvitationForm({ token, signInHref, onSignedIn }: { token: string | null | undefined; signInHref: string; onSignedIn: (result: LoginOk) => void }) {
  const { t } = useI18n();
  const api = useApi();
  const session = useSession();
  const preview = useQuery({ queryKey: ['invitation', token], queryFn: () => api.auth.previewInvitation(token as string), enabled: !!token, retry: false, staleTime: Infinity });
  const [challenge, setChallenge] = React.useState<string | null>(null);
  const needsPassword = preview.data?.needsPassword ?? true;
  // The invitation says which rules the new password must meet; the centre's policy or the built-in rules otherwise.
  const rules = useNewPasswordRules(preview.data?.passwordPolicy);
  const newAccount = React.useMemo(() => z.object({ fullName: trimmed(120, 2), password: rules.field }), [rules.field]);
  const form = useZodForm(needsPassword ? newAccount : existingAccount, { defaultValues: { fullName: '', password: '' } });

  React.useEffect(() => {
    if (preview.data?.fullName) form.setValue('fullName', preview.data.fullName);
  }, [preview.data, form]);

  const handle = (result: LoginResult) => {
    if (result.status === 'OK') {
      session.acceptLogin(result);
      onSignedIn(result);
    } else if (result.status === 'MFA_REQUIRED') setChallenge(result.challengeToken);
  };

  if (challenge) return <MfaChallenge challengeToken={challenge} onResult={handle} onRestart={() => setChallenge(null)} />;

  if (!token || preview.isError) {
    return (
      <AuthCard title={t('auth.invitation.invalidTitle')} footer={<AuthLink href={signInHref}>{t('auth.forgot.backToSignIn')}</AuthLink>}>
        <Alert tone="warning">{t('auth.invitation.invalid')}</Alert>
      </AuthCard>
    );
  }
  if (preview.isPending) {
    return (
      <AuthCard title={t('auth.invitation.title')}>
        <LoadingBlock label={t('auth.invitation.loading')} className="min-h-24" />
      </AuthCard>
    );
  }
  const data = preview.data;
  return (
    <AuthCard title={t('auth.invitation.title')} subtitle={needsPassword ? t('auth.invitation.subtitle', { centre: data.centreName, role: data.roleName }) : t('auth.invitation.subtitleExisting', { centre: data.centreName })}>
      <Form
        form={form}
        onSubmit={async (values) => {
          handle(await api.auth.acceptInvitation({ token, fullName: values.fullName || undefined, password: needsPassword ? values.password : undefined }));
        }}
      >
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">{t('auth.email')}</p>
          <p className="ltr-value rounded-md border bg-muted/60 px-3 py-2 text-base text-foreground">{data.email}</p>
        </div>
        {needsPassword ? (
          <>
            <FormField name="fullName" label={t('auth.fullName')} required>
              {(field) => <Input {...field} autoComplete="name" autoFocus />}
            </FormField>
            <FormField name="password" label={t('auth.invitation.setPassword')} required hint={rules.hint}>
              {(field) => <PasswordInput {...field} autoComplete="new-password" dir="ltr" />}
            </FormField>
          </>
        ) : null}
        <FormError />
        <Button type="submit" size="lg" className="w-full" loading={form.formState.isSubmitting} loadingText={t('common.loading')}>
          {t('auth.invitation.accept')}
        </Button>
      </Form>
    </AuthCard>
  );
}
