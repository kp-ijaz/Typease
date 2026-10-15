'use client';

import { useRouter } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, ChangePasswordForm, MfaSetupPanel, PageHeader, SessionsPanel, useI18n, useSession } from '@typease/ui';
import { ROUTES } from '@/lib/config';

export function SecurityPage({ setupRequested }: { setupRequested: boolean }) {
  const { t } = useI18n();
  const session = useSession();
  const router = useRouter();
  const required = !!session.session?.mfaRequiredSetup;
  return (
    <>
      <PageHeader title={t('account.securityTitle')} description={t('account.securityDescription')} breadcrumbs={[{ label: t('account.title') }]} />
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>{t('account.twoStep')}</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <MfaSetupPanel required={required || setupRequested} onCompleted={() => (required || setupRequested ? router.replace(ROUTES.home) : undefined)} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div>
              <CardTitle>{t('auth.changePassword.title')}</CardTitle>
              <CardDescription>{t('auth.changePassword.subtitle')}</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <ChangePasswordForm />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div>
              <CardTitle>{t('auth.sessions.title')}</CardTitle>
              <CardDescription>{t('auth.sessions.subtitle')}</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <SessionsPanel />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
