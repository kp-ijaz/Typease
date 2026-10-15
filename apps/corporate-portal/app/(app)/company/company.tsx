'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, LifeBuoy, UserPlus, Users } from 'lucide-react';
import { corporateMemberSchema } from '@typease/validation';
import { isApiError } from '@typease/api-client';
import {
  Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Checkbox, ChoiceLabel, DescriptionList, DevTokenHint, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, EmptyState, Form, FormError, FormField, Input, PageHeader, PhoneInput, Skeleton, StatusBadge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
  countryName, formatPhone, useBranding, useI18n, useSession, useToast, useZodForm,
} from '@typease/ui';
import { CompanyStatusNotice, Expiry, Gate, LoadError, Ltr, Money, NoAccess, isForbidden, retryUnlessFinal, useCompanyAccount } from '@/components/portal/shared';
import { usePortalApi } from '@/lib/api';
import { ROUTES } from '@/lib/config';
import { keys } from '@/lib/query-keys';
import type { CompanyAccount } from '@/lib/types';

export function Company() {
  return (
    <Gate anyOf={['corp.account.read']}>
      <CompanyPage />
    </Gate>
  );
}

/**
 * The company as the centre has it on file. The record itself (name, licence, billing details),
 * the payment terms and the contract prices are kept by the centre and are read-only here: the
 * API offers a company no way to change them. What the company does itself is invite colleagues.
 */
function CompanyPage() {
  const { t, pick } = useI18n();
  const { name: centre } = useBranding();
  const { account } = useCompanyAccount();

  if (account.isPending) {
    return (
      <>
        <PageHeader title={t('nav.company')} description={t('sections.company')} />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2" role="status" aria-label={t('common.loading')}>
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
          <Skeleton className="h-48 lg:col-span-2" />
        </div>
      </>
    );
  }
  if (account.isError) {
    return (
      <>
        <PageHeader title={t('nav.company')} description={t('sections.company')} />
        {isForbidden(account.error) ? <NoAccess /> : <LoadError error={account.error} onRetry={() => void account.refetch()} />}
      </>
    );
  }

  const a = account.data;
  return (
    <>
      <PageHeader
        title={pick(a.companyName, a.companyNameAr)}
        description={t('my.company.description', { centre })}
        meta={
          <>
            <StatusBadge kind="corporate" status={a.status} />
            {a.verified ? (
              <Badge tone="success" icon={<BadgeCheck />}>
                {t('overview.company.verified')}
              </Badge>
            ) : null}
          </>
        }
        secondary={
          <Button asChild variant="outline">
            <Link href={`${ROUTES.support}?new=1&topic=account`}>
              <LifeBuoy aria-hidden="true" />
              {t('my.company.askChange')}
            </Link>
          </Button>
        }
      />
      <CompanyStatusNotice className="mb-4" />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
        <Details account={a} />
        <div className="space-y-6">
          <Billing account={a} />
          <Terms account={a} />
        </div>
        <Prices />
        <PortalUsers account={a} />
      </div>
      <p className="mt-4 text-sm text-muted-foreground">{t('my.company.readOnlyNote', { centre })}</p>
    </>
  );
}

function Details({ account: a }: { account: CompanyAccount }) {
  const { t, formatDate } = useI18n();
  return (
    <Card data-company-details>
      <CardHeader>
        <CardTitle className="text-lg">{t('my.company.details.title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <DescriptionList
          items={[
            { label: t('my.company.details.name'), value: <span dir="auto">{a.companyName}</span> },
            { label: t('my.company.details.nameAr'), value: a.companyNameAr ? <span dir="rtl" lang="ar">{a.companyNameAr}</span> : null },
            { label: t('overview.accountNo'), value: <Ltr>{a.accountNo}</Ltr> },
            { label: t('my.company.details.verified'), value: a.verified ? (a.verifiedAt ? t('my.company.details.verifiedOn', { date: formatDate(a.verifiedAt) }) : t('common.yes')) : t('overview.company.notVerified') },
          ]}
        />
        <div className="border-t pt-5">
          <h3 className="mb-3 text-md font-semibold text-foreground">{t('my.company.licence.title')}</h3>
          <DescriptionList
            items={[
              { label: t('my.company.licence.number'), value: a.tradeLicenceNo ? <Ltr>{a.tradeLicenceNo}</Ltr> : null },
              { label: t('my.company.licence.authority'), value: a.tradeLicenceAuthority ? <span dir="auto">{a.tradeLicenceAuthority}</span> : null },
              { label: t('my.company.licence.expiry'), value: a.tradeLicenceExpiry ? <Expiry date={a.tradeLicenceExpiry} /> : null, wide: true },
            ]}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function Billing({ account: a }: { account: CompanyAccount }) {
  const { t, locale } = useI18n();
  const address = a.billingAddress ?? {};
  const lines = [address.line1, [address.city, address.emirate].filter(Boolean).join(', '), countryName(address.country, locale), address.poBox ? t('my.company.billing.poBox', { number: address.poBox }) : ''].filter(Boolean);
  return (
    <Card data-company-billing>
      <CardHeader>
        <CardTitle className="text-lg">{t('my.company.billing.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <DescriptionList
          items={[
            { label: t('my.company.billing.email'), value: a.billingEmail ? <Ltr className="break-all">{a.billingEmail}</Ltr> : null },
            { label: t('my.company.billing.trn'), value: a.taxRegistrationNo ? <Ltr>{a.taxRegistrationNo}</Ltr> : null },
            {
              label: t('my.company.billing.address'),
              wide: true,
              value: lines.length ? (
                <span className="block">
                  {lines.map((line) => (
                    <span key={line} className="block" dir="auto">
                      {line}
                    </span>
                  ))}
                </span>
              ) : null,
            },
          ]}
        />
      </CardContent>
    </Card>
  );
}

/** Payment terms and credit as the centre approved them. While no credit is approved, every invoice is due when it is issued. */
function Terms({ account: a }: { account: CompanyAccount }) {
  const { t, tn } = useI18n();
  const session = useSession();
  return (
    <Card data-company-terms>
      <CardHeader className="items-center">
        <CardTitle className="text-lg">{t('my.company.terms.title')}</CardTitle>
        {session.hasPermission('corp.invoices.read') ? (
          <Button asChild variant="link">
            <Link href={ROUTES.invoices}>{t('my.company.terms.statement')}</Link>
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {a.credit.approved ? (
          <DescriptionList
            items={[
              { label: t('my.company.terms.due'), value: a.credit.paymentTermsDays > 0 ? tn('my.company.termsDays', a.credit.paymentTermsDays) : t('my.company.termsOnInvoice') },
              { label: t('my.company.terms.limit'), value: a.credit.limit ? <Money amount={a.credit.limit} /> : t('my.company.terms.noLimit') },
              { label: t('my.company.terms.available'), value: a.counters.creditAvailable !== null ? <Money amount={a.counters.creditAvailable} /> : null },
              { label: t('my.company.terms.open'), value: <Money amount={a.counters.unpaidInvoicesBalance} /> },
            ]}
          />
        ) : (
          <p className="text-base text-muted-foreground">{t('my.company.terms.none')}</p>
        )}
      </CardContent>
    </Card>
  );
}

/** The service fees agreed with the centre. A contract price replaces the centre's own fee only; authority and third-party fees stay as charged. */
function Prices() {
  const { t, pick } = useI18n();
  const api = usePortalApi();
  const prices = useQuery({ queryKey: keys.prices, queryFn: () => api.prices(), retry: retryUnlessFinal });
  return (
    <Card className="lg:col-span-2" data-company-prices>
      <CardHeader>
        <div>
          <CardTitle className="text-lg">{t('my.company.prices.title')}</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">{t('my.company.prices.text')}</p>
        </div>
      </CardHeader>
      <CardContent>
        {prices.isPending ? (
          <Skeleton className="h-24" role="status" aria-label={t('common.loading')} />
        ) : prices.isError ? (
          <LoadError error={prices.error} onRetry={() => void prices.refetch()} />
        ) : prices.data.length === 0 ? (
          <p className="text-base text-muted-foreground">{t('my.company.prices.empty')}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <caption className="sr-only">{t('my.company.prices.title')}</caption>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('my.requests.columns.service')}</TableHead>
                  <TableHead className="text-end">{t('my.company.prices.contract')}</TableHead>
                  <TableHead className="text-end">{t('my.company.prices.list')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {prices.data.map((p) => (
                  <TableRow key={p.id} className="hover:bg-transparent">
                    <TableCell className="min-w-32">{pick(p.serviceName, p.serviceNameAr)}</TableCell>
                    <TableCell className="text-end font-medium">
                      <Money amount={p.contractServiceFee} currency={p.currency} />
                    </TableCell>
                    <TableCell className="text-end text-muted-foreground">{p.catalogueServiceFee ? <Money amount={p.catalogueServiceFee} currency={p.currency} /> : '–'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- people who can act for the company here

function PortalUsers({ account }: { account: CompanyAccount }) {
  const { t, formatDate } = useI18n();
  const api = usePortalApi();
  const session = useSession();
  const { name: centre } = useBranding();
  const members = useQuery({ queryKey: keys.members, queryFn: () => api.members(), retry: retryUnlessFinal });
  const [inviting, setInviting] = React.useState(false);
  const canInvite = session.hasPermission('corp.account.manage') && account.status === 'ACTIVE';
  const invite = canInvite ? (
    <Button variant="outline" onClick={() => setInviting(true)} data-action="invite-colleague">
      <UserPlus aria-hidden="true" />
      {t('my.company.users.invite')}
    </Button>
  ) : null;
  return (
    <Card className="lg:col-span-2" data-company-users>
      <CardHeader className="items-center">
        <div>
          <CardTitle className="text-lg">{t('my.company.users.title')}</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">{t('my.company.users.text')}</p>
        </div>
        {invite}
      </CardHeader>
      <CardContent className="space-y-4">
        {members.isPending ? (
          <div className="space-y-3" role="status" aria-label={t('common.loading')}>
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : members.isError ? (
          <LoadError error={members.error} onRetry={() => void members.refetch()} />
        ) : members.data.length === 0 ? (
          <EmptyState icon={<Users />} title={t('my.company.users.empty')} action={invite} />
        ) : (
          <ul className="divide-y rounded-lg border">
            {members.data.map((member) => (
              <li key={member.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5" data-member={member.email}>
                <div className="min-w-0 flex-1 basis-64">
                  <p className="flex flex-wrap items-center gap-2 text-base font-medium text-foreground">
                    <span dir="auto">{member.fullName}</span>
                    <StatusBadge kind="membership" status={member.status} />
                    {member.isAuthorisedSignatory ? <Badge tone="brand">{t('my.company.users.signatory')}</Badge> : null}
                    {member.email === session.user?.email ? <Badge tone="neutral">{t('my.common.you')}</Badge> : null}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    <Ltr className="break-all">{member.email}</Ltr>
                    {member.phone ? (
                      <>
                        <span aria-hidden="true"> – </span>
                        <Ltr>{formatPhone(member.phone)}</Ltr>
                      </>
                    ) : null}
                  </p>
                </div>
                <p className="text-sm text-muted-foreground">{t('my.company.users.since', { date: formatDate(member.createdAt) })}</p>
              </li>
            ))}
          </ul>
        )}
        <p className="text-sm text-muted-foreground">
          {t('my.company.users.manageNote', { centre })}{' '}
          {session.hasPermission('corp.employees.read') ? (
            <Link href={ROUTES.employees} className="font-medium text-secondary-text underline-offset-4 hover:underline">
              {t('my.company.users.employeesLink')}
            </Link>
          ) : null}
        </p>
      </CardContent>
      {inviting ? <InviteColleagueDialog onClose={() => setInviting(false)} /> : null}
    </Card>
  );
}

function InviteColleagueDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const api = usePortalApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const form = useZodForm(corporateMemberSchema, { defaultValues: { fullName: '', email: '', phone: '', isAuthorisedSignatory: false }, emptyAs: 'null' });
  const [devToken, setDevToken] = React.useState<string | null>(null);
  const signatoryId = React.useId();

  if (devToken) {
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t('my.company.users.invited')}</DialogTitle>
            <DialogDescription>{t('my.company.users.sentText')}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <DevTokenHint>
              <Link className="text-secondary-text underline-offset-4 hover:underline" href={`/accept-invitation?token=${encodeURIComponent(devToken)}`} target="_blank" rel="noreferrer" data-invitation-link>
                {t('my.employees.login.devLink')}
              </Link>
            </DevTokenHint>
          </DialogBody>
          <DialogFooter>
            <Button onClick={onClose}>{t('common.done')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !form.formState.isSubmitting && onClose()}>
      <DialogContent size="md">
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            try {
              const reply = await api.inviteMember(values);
              toasts.success(t('my.company.users.invited'), t('my.company.users.invitedTo', { email: reply.email }));
              await Promise.all([queryClient.invalidateQueries({ queryKey: keys.members }), queryClient.invalidateQueries({ queryKey: keys.account })]);
              if (reply.dev?.invitationToken) setDevToken(reply.dev.invitationToken);
              else onClose();
            } catch (error) {
              if (isApiError(error) && (error.code === 'ALREADY_MEMBER' || error.code === 'EMAIL_IN_USE')) {
                form.setError('email', { type: 'server', message: error.code === 'ALREADY_MEMBER' ? t('my.company.users.alreadyMember') : t('my.employees.login.emailInUse') });
                form.setFocus('email');
                return;
              }
              if (isApiError(error) && error.code === 'CORPORATE_ACCOUNT_NOT_ACTIVE') {
                form.setError('root.server', { type: error.code, message: t('my.employees.errors.accountNotActive') });
                return;
              }
              if (isApiError(error) && error.code === 'PLAN_LIMIT_REACHED') {
                form.setError('root.server', { type: error.code, message: t('my.employees.errors.portalNotIncluded') });
                return;
              }
              throw error;
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('my.company.users.invite')}</DialogTitle>
            <DialogDescription>{t('my.company.users.inviteText')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="fullName" label={t('my.company.users.fullName')} required>
              {(field) => <Input {...field} autoComplete="off" dir="auto" autoFocus />}
            </FormField>
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField name="email" label={t('my.employees.fields.email')} required>
                {(field) => <Input {...field} type="email" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false} dir="ltr" />}
              </FormField>
              <FormField name="phone" label={t('my.employees.fields.phone')} optional>
                {(field) => <PhoneInput {...field} />}
              </FormField>
            </div>
            <ChoiceLabel
              htmlFor={signatoryId}
              control={<Checkbox id={signatoryId} checked={!!form.watch('isAuthorisedSignatory')} onCheckedChange={(on) => form.setValue('isAuthorisedSignatory', on === true, { shouldDirty: true })} />}
              label={t('my.company.users.signatoryChoice')}
              description={t('my.company.users.signatoryHint')}
            />
            <Alert tone="info">{t('my.company.users.inviteNote')}</Alert>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={form.formState.isSubmitting}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.loading')}>
              {t('my.company.users.send')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
