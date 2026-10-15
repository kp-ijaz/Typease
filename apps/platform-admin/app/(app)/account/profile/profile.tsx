'use client';

import { Card, CardContent, DescriptionList, PageHeader, ProfileForm, useI18n, useSession } from '@typease/ui';

export function ProfilePage() {
  const { t, has } = useI18n();
  const session = useSession();
  const role = session.user?.platformRole;
  return (
    <>
      <PageHeader title={t('account.profileTitle')} description={t('account.profileDescription')} breadcrumbs={[{ label: t('account.title') }]} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card>
          <CardContent>
            <ProfileForm />
          </CardContent>
        </Card>
        <Card className="h-fit">
          <CardContent>
            <DescriptionList columns={1} items={[{ label: t('account.role'), value: role ? (has(`account.roles.${role}`) ? t(`account.roles.${role}`) : role) : null }]} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
