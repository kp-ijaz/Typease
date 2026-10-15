'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, BadgeCheck, Building2, ChevronDown, ClipboardList, CreditCard, Pause, Pencil, Play, Plus, Receipt, UserCog, Users } from 'lucide-react';
import {
  Alert, Badge, Button, Card, ConfirmDialog, DescriptionList, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState, PageHeader, PermissionGate,
  RequirePermission, StatCard, StatusBadge, Tabs, TabsContent, TabsList, TabsTrigger, cn, countryName, focusRing, useApi, useI18n, useSession, useToast,
} from '@typease/ui';
import { CorporateAccountDialog } from '@/components/people/corporate/account-dialog';
import { AgreementsTab } from '@/components/people/corporate/agreements-tab';
import { EmployeesTab } from '@/components/people/corporate/employees-tab';
import { MembersTab } from '@/components/people/corporate/members-tab';
import { PricesTab } from '@/components/people/corporate/prices-tab';
import { CorporateInvoicesTab, CorporateRequestsTab } from '@/components/people/corporate/records-tabs';
import { CreditDecisionDialog, StatusReasonDialog, VerifyCorporateDialog } from '@/components/people/corporate/status-dialogs';
import { ActiveTabInView, DetailSkeleton, LoadError, Ltr, Section, isNotFound, isPlanLimit, useStaffNames, useUrlTab } from '@/components/people/shared';
import type { CorporateAccount, CorporateAccountDetail } from '@/components/people/types';
import { peopleKeys } from '@/lib/keys/people';

type TabId = 'overview' | 'contacts' | 'employees' | 'agreements' | 'prices' | 'requests' | 'invoices';
const TABS: Array<{ id: TabId; anyOf: string[] }> = [
  { id: 'overview', anyOf: [] },
  { id: 'contacts', anyOf: [] },
  { id: 'employees', anyOf: [] },
  { id: 'agreements', anyOf: [] },
  { id: 'prices', anyOf: [] },
  { id: 'requests', anyOf: ['request.read.all', 'request.read.assigned'] },
  { id: 'invoices', anyOf: ['invoice.read', 'report.financial'] },
];
const TAB_IDS = TABS.map((tab) => tab.id);

export function CorporateDetail() {
  return (
    <RequirePermission anyOf={['corporate.read']}>
      <Company />
    </RequirePermission>
  );
}

function Company() {
  const { id } = useParams<{ id: string }>();
  const { t, tn, locale, formatDate, formatDateTime, formatMoney, formatNumber, today } = useI18n();
  const api = useApi();
  const session = useSession();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const staffName = useStaffNames();
  const [tab, setTab] = useUrlTab<TabId>(TAB_IDS, 'overview');

  const [editing, setEditing] = React.useState(false);
  const [verifying, setVerifying] = React.useState(false);
  const [credit, setCredit] = React.useState(false);
  const [reasonFor, setReasonFor] = React.useState<'suspend' | 'archive' | null>(null);
  const [reactivating, setReactivating] = React.useState(false);
  const [limitOnReactivate, setLimitOnReactivate] = React.useState(false);

  const query = useQuery({ queryKey: peopleKeys.corporate.detail(id), queryFn: () => api.client.get<CorporateAccountDetail>(`/corporate-accounts/${id}`), retry: (count, error) => !isNotFound(error) && count < 2 });
  const crumbs = [{ label: t('nav.corporate'), href: '/corporate' }];

  if (query.isPending) return <DetailSkeleton />;
  if (query.isError) {
    return (
      <>
        <PageHeader title={t('people.corporate.pageTitle')} breadcrumbs={crumbs} />
        {isNotFound(query.error) ? (
          <Card>
            <EmptyState
              size="page"
              icon={<Building2 />}
              title={t('people.corporate.notFoundTitle')}
              description={t('people.corporate.notFoundText')}
              action={
                <Button asChild>
                  <Link href="/corporate">{t('people.corporate.backToList')}</Link>
                </Button>
              }
            />
          </Card>
        ) : (
          <LoadError error={query.error} onRetry={() => void query.refetch()} />
        )}
      </>
    );
  }

  const account = query.data;
  const archived = account.status === 'ARCHIVED';
  const verified = !!account.verifiedAt;
  const canManage = session.hasPermission('corporate.manage');
  const canVerify = session.hasPermission('corporate.verify');
  const visibleTabs = TABS.filter((item) => session.hasAnyPermission(item.anyOf)).map((item) => item.id);
  const current = visibleTabs.includes(tab) ? tab : 'overview';
  const c = account.counters;

  const reactivate = async () => {
    setLimitOnReactivate(false);
    try {
      const saved = await api.client.post<CorporateAccount>(`/corporate-accounts/${account.id}/reactivate`);
      toasts.success(t('people.corporate.status.reactivate.done'), saved.companyName);
      await Promise.all([queryClient.invalidateQueries({ queryKey: peopleKeys.corporate.all }), queryClient.invalidateQueries({ queryKey: peopleKeys.plan })]);
    } catch (error) {
      if (isPlanLimit(error)) setLimitOnReactivate(true);
      else toasts.error(error);
      throw error;
    }
  };

  const address = account.billingAddress ? [account.billingAddress.line1, account.billingAddress.city, account.billingAddress.emirate, countryName(account.billingAddress.country, locale)].filter(Boolean).join(', ') : '';
  const licenceExpired = !!account.tradeLicenceExpiry && account.tradeLicenceExpiry < today();
  const showVerify = canVerify && !verified && !archived;
  const showCredit = canVerify && !archived;
  const showSuspend = canManage && account.status === 'ACTIVE';
  const showReactivate = canManage && (account.status === 'SUSPENDED' || archived);
  const showArchive = canManage && !archived;
  const hasMore = showVerify || showCredit || showSuspend || showReactivate || showArchive;

  const counter = (target: TabId, node: React.ReactNode) =>
    visibleTabs.includes(target) ? (
      <button type="button" onClick={() => setTab(target)} className={cn('rounded-lg text-start transition-shadow hover:shadow-sm', focusRing)}>
        {node}
      </button>
    ) : (
      <div>{node}</div>
    );

  return (
    <>
      <PageHeader
        breadcrumbs={crumbs}
        title={
          <span className="inline-flex flex-wrap items-baseline gap-x-3">
            <span>{account.companyName}</span>
            {account.companyNameAr ? (
              <span lang="ar" dir="rtl" className="text-xl font-normal text-muted-foreground">
                {account.companyNameAr}
              </span>
            ) : null}
          </span>
        }
        meta={
          <>
            <StatusBadge kind="corporate" status={account.status} />
            {account.creditApproved ? <Badge tone="success">{t('people.corporate.credit.approvedBadge')}</Badge> : null}
          </>
        }
        description={<span className="tabular ltr-value font-medium text-foreground">{account.accountNo}</span>}
        action={
          account.status === 'ACTIVE' ? (
            <PermissionGate permission="request.create">
              <Button asChild variant="accent">
                <Link href={`/requests/new?corporateAccountId=${account.id}`}>
                  <Plus aria-hidden="true" />
                  {t('requests.new')}
                </Link>
              </Button>
            </PermissionGate>
          ) : showVerify && account.status === 'PENDING_VERIFICATION' ? (
            <Button variant="accent" onClick={() => setVerifying(true)}>
              <BadgeCheck aria-hidden="true" />
              {t('people.corporate.verify.action')}
            </Button>
          ) : null
        }
        secondary={
          <>
            {canManage && !archived ? (
              <Button variant="outline" onClick={() => setEditing(true)}>
                <Pencil aria-hidden="true" />
                {t('common.edit')}
              </Button>
            ) : null}
            {hasMore ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline">
                    {t('people.common.more')}
                    <ChevronDown aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  {showVerify ? (
                    <DropdownMenuItem onSelect={() => setVerifying(true)}>
                      <BadgeCheck aria-hidden="true" />
                      {t('people.corporate.verify.action')}
                    </DropdownMenuItem>
                  ) : null}
                  {showCredit ? (
                    <DropdownMenuItem onSelect={() => setCredit(true)}>
                      <CreditCard aria-hidden="true" />
                      {account.creditApproved ? t('people.corporate.credit.change') : t('people.corporate.credit.action')}
                    </DropdownMenuItem>
                  ) : null}
                  {showReactivate ? (
                    <DropdownMenuItem
                      onSelect={() => {
                        setLimitOnReactivate(false);
                        setReactivating(true);
                      }}
                    >
                      <Play aria-hidden="true" />
                      {t('people.corporate.status.reactivate.action')}
                    </DropdownMenuItem>
                  ) : null}
                  {showSuspend || showArchive ? <DropdownMenuSeparator /> : null}
                  {showSuspend ? (
                    <DropdownMenuItem destructive onSelect={() => setReasonFor('suspend')}>
                      <Pause aria-hidden="true" />
                      {t('people.corporate.status.suspend.action')}
                    </DropdownMenuItem>
                  ) : null}
                  {showArchive ? (
                    <DropdownMenuItem destructive onSelect={() => setReasonFor('archive')}>
                      <Archive aria-hidden="true" />
                      {t('people.corporate.status.archive.action')}
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </>
        }
      />

      {account.status === 'PENDING_VERIFICATION' ? (
        <Alert tone="warning" className="mb-5" title={t('people.corporate.banner.pendingTitle')}>
          {canVerify ? t('people.corporate.banner.pendingText') : t('people.corporate.banner.pendingTextOther')}
        </Alert>
      ) : null}
      {account.status === 'SUSPENDED' ? (
        <Alert tone="danger" className="mb-5" title={t('people.corporate.banner.suspendedTitle')}>
          {t('people.corporate.banner.suspendedText')}
        </Alert>
      ) : null}
      {archived ? (
        <Alert tone="info" className="mb-5" title={t('people.corporate.banner.archivedTitle')}>
          {t('people.corporate.banner.archivedText')}
        </Alert>
      ) : null}

      <Tabs value={current} onValueChange={(next) => setTab(next as TabId)}>
        <ActiveTabInView value={current} />
        <TabsList aria-label={t('people.corporate.tabs.label')}>
          {visibleTabs.map((tabId) => (
            <TabsTrigger key={tabId} value={tabId}>
              {t(`people.corporate.tabs.${tabId}`)}
              {tabId === 'employees' && c.employees ? <span className="tabular rounded-full bg-muted px-1.5 text-xs font-medium text-muted-foreground">{formatNumber(c.employees)}</span> : null}
              {tabId === 'contacts' && c.members ? <span className="tabular rounded-full bg-muted px-1.5 text-xs font-medium text-muted-foreground">{formatNumber(c.members)}</span> : null}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview">
          <div className="space-y-6">
            <section aria-label={t('people.corporate.counters.title')} className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
              {counter('employees', <StatCard className="h-full" tone="neutral" icon={<Users />} value={formatNumber(c.employees)} label={t('people.corporate.counters.employees')} />)}
              {counter('contacts', <StatCard className="h-full" tone="neutral" icon={<UserCog />} value={formatNumber(c.members)} label={t('people.corporate.counters.members')} />)}
              {counter('requests', <StatCard className="h-full" tone={c.openRequests ? 'info' : 'neutral'} icon={<ClipboardList />} value={formatNumber(c.openRequests)} label={t('people.corporate.counters.openRequests')} hint={tn('people.corporate.counters.totalRequests', c.totalRequests)} />)}
              {counter(
                'invoices',
                <StatCard
                  className="h-full"
                  tone={c.unpaidInvoices ? 'danger' : 'neutral'}
                  icon={<Receipt />}
                  value={formatNumber(c.unpaidInvoices)}
                  label={t('people.corporate.counters.unpaidInvoices')}
                  hint={c.unpaidInvoices ? formatMoney(c.unpaidInvoicesBalance) : undefined}
                />,
              )}
            </section>

            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
              <div className="min-w-0 space-y-6">
                <Section title={t('people.corporate.sections.company')}>
                  <DescriptionList
                    columns={2}
                    items={[
                      { label: t('people.corporate.fields.tradeLicenceNo'), value: account.tradeLicenceNo ? <Ltr>{account.tradeLicenceNo}</Ltr> : null },
                      {
                        label: t('people.corporate.fields.tradeLicenceExpiry'),
                        value: account.tradeLicenceExpiry ? (
                          <span className={licenceExpired ? 'font-medium text-destructive-text' : undefined}>
                            {formatDate(account.tradeLicenceExpiry)}
                            {licenceExpired ? ` (${t('people.common.expired')})` : ''}
                          </span>
                        ) : null,
                      },
                      { label: t('people.corporate.fields.tradeLicenceAuthority'), value: account.tradeLicenceAuthority ? <span dir="auto">{account.tradeLicenceAuthority}</span> : null },
                      { label: t('people.corporate.fields.taxRegistrationNo'), value: account.taxRegistrationNo ? <Ltr>{account.taxRegistrationNo}</Ltr> : null },
                      { label: t('customers.columns.created'), value: formatDate(account.createdAt) },
                    ]}
                  />
                </Section>

                <Section title={t('people.corporate.sections.billing')}>
                  <DescriptionList
                    columns={2}
                    items={[
                      { label: t('people.corporate.fields.billingEmail'), value: account.billingEmail ? <Ltr className="break-all">{account.billingEmail}</Ltr> : null },
                      { label: t('people.corporate.fields.poBox'), value: account.billingAddress?.poBox ? <Ltr>{account.billingAddress.poBox}</Ltr> : null },
                      { label: t('people.customer.fields.address'), value: address ? <span dir="auto">{address}</span> : null, wide: true },
                    ]}
                  />
                </Section>

                {account.notes ? (
                  <Section title={t('people.corporate.fields.notes')} description={t('people.corporate.form.notesHint')}>
                    <p className="whitespace-pre-wrap break-words text-base text-foreground/90" dir="auto">
                      {account.notes}
                    </p>
                  </Section>
                ) : null}
              </div>

              <div className="min-w-0 space-y-6">
                <Section
                  title={t('people.corporate.verify.cardTitle')}
                  action={verified ? <Badge tone="success" icon={<BadgeCheck />}>{t('people.corporate.verify.verified')}</Badge> : <Badge tone="warning">{t('people.corporate.verify.notVerified')}</Badge>}
                >
                  {verified ? (
                    <p className="text-base text-foreground/90">{staffName(account.verifiedById) ? t('people.corporate.verify.verifiedBy', { name: staffName(account.verifiedById) ?? '', when: formatDateTime(account.verifiedAt) }) : t('people.corporate.verify.verifiedOn', { when: formatDateTime(account.verifiedAt) })}</p>
                  ) : (
                    <>
                      <p className="text-base text-muted-foreground">{t('people.corporate.verify.cardText')}</p>
                      {showVerify ? (
                        <Button variant="outline" size="sm" className="mt-3" onClick={() => setVerifying(true)}>
                          <BadgeCheck aria-hidden="true" />
                          {t('people.corporate.verify.action')}
                        </Button>
                      ) : null}
                    </>
                  )}
                </Section>

                <Section
                  title={t('people.corporate.sections.credit')}
                  action={account.creditApproved ? <Badge tone="success">{t('people.corporate.credit.approvedBadge')}</Badge> : <Badge tone="neutral">{t('people.corporate.credit.notApproved')}</Badge>}
                >
                  <DescriptionList
                    columns={1}
                    items={[
                      { label: account.creditApproved ? t('people.corporate.credit.limitApproved') : t('people.corporate.credit.limitProposed'), value: account.creditLimit && Number(account.creditLimit) > 0 ? <span className="tabular">{formatMoney(account.creditLimit)}</span> : null },
                      { label: t('people.corporate.fields.paymentTermsDays'), value: account.paymentTermsDays > 0 ? t('people.corporate.credit.terms', { days: formatNumber(account.paymentTermsDays) }) : t('people.corporate.credit.termsImmediate') },
                      ...(account.creditApproved ? [{ label: t('people.corporate.credit.available'), value: c.creditAvailable !== null ? <span className="tabular font-semibold">{formatMoney(c.creditAvailable)}</span> : null }] : []),
                    ]}
                  />
                  {account.creditApproved ? null : <p className="mt-3 text-sm text-muted-foreground">{t('people.corporate.credit.proposedNote')}</p>}
                  {showCredit ? (
                    <Button variant="outline" size="sm" className="mt-3" onClick={() => setCredit(true)}>
                      <CreditCard aria-hidden="true" />
                      {account.creditApproved ? t('people.corporate.credit.change') : t('people.corporate.credit.action')}
                    </Button>
                  ) : null}
                </Section>
              </div>
            </div>
          </div>
        </TabsContent>
        <TabsContent value="contacts">
          <MembersTab account={account} />
        </TabsContent>
        <TabsContent value="employees">
          <EmployeesTab account={account} />
        </TabsContent>
        <TabsContent value="agreements">
          <AgreementsTab account={account} />
        </TabsContent>
        <TabsContent value="prices">
          <PricesTab account={account} />
        </TabsContent>
        <TabsContent value="requests">
          <CorporateRequestsTab account={account} />
        </TabsContent>
        <TabsContent value="invoices">
          <CorporateInvoicesTab account={account} />
        </TabsContent>
      </Tabs>

      {editing ? <CorporateAccountDialog account={account} open onOpenChange={setEditing} /> : null}
      {verifying ? <VerifyCorporateDialog account={account} open onOpenChange={setVerifying} /> : null}
      {credit ? <CreditDecisionDialog account={account} open onOpenChange={setCredit} /> : null}
      {reasonFor ? <StatusReasonDialog account={account} action={reasonFor} open onOpenChange={(next) => !next && setReasonFor(null)} /> : null}
      <ConfirmDialog
        open={reactivating}
        onOpenChange={setReactivating}
        tone="default"
        title={t('people.corporate.status.reactivate.title', { name: account.companyName })}
        description={archived ? t('people.corporate.status.reactivate.textArchived') : t('people.corporate.status.reactivate.text')}
        confirmLabel={t('people.corporate.status.reactivate.action')}
        onConfirm={reactivate}
      >
        {limitOnReactivate ? <Alert tone="warning">{t('people.corporate.limit.apiText')}</Alert> : null}
      </ConfirmDialog>
    </>
  );
}
