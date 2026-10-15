'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Archive, Ban, Check, CheckCircle2, ChevronDown, CircleDashed, KeyRound, MailPlus, PauseCircle, PlayCircle, ShieldCheck, ShieldOff, ThumbsDown, ThumbsUp, Trash2, Undo2 } from 'lucide-react';
import { isApiError } from '@typease/api-client';
import {
  Alert, Badge, Button, DescriptionList, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, PageHeader, RequirePermission, StatusBadge, Tabs, TabsContent,
  TabsList, TabsTrigger, cn, focusRing, useApi, useI18n, useSession,
} from '@typease/ui';
import { AuditTable, SecurityEventsTable } from '@/components/audit-table';
import { BillingPanel } from '@/components/billing';
import { RequestAccessDialog } from '@/components/request-access-dialog';
import { DetailSkeleton, LoadError, Money, RelativeTime, Section, TextLink, useUrlState } from '@/components/shared';
import { DESTRUCTIVE_ACTIONS, availableTenantActions, suspensionOf, useTenantActions, useTenantRights, type TenantActionId } from '@/components/tenant-actions';
import { usePlatformApi } from '@/lib/api';
import { emirateKey } from '@/lib/emirates';
import { keys } from '@/lib/query-keys';
import type { TenantDetail, UsageLine } from '@/lib/types';
import { TenantAccess } from './tenant-access';
import { TenantFlags } from './tenant-flags';

const ACTION_ICONS: Record<TenantActionId, React.ReactNode> = {
  approve: <ThumbsUp aria-hidden="true" />,
  reject: <ThumbsDown aria-hidden="true" />,
  resendInvitation: <MailPlus aria-hidden="true" />,
  reactivate: <PlayCircle aria-hidden="true" />,
  suspend: <PauseCircle aria-hidden="true" />,
  archive: <Archive aria-hidden="true" />,
  offboard: <Trash2 aria-hidden="true" />,
  cancelOffboarding: <Undo2 aria-hidden="true" />,
};

export function TenantPage({ id }: { id: string }) {
  return (
    <RequirePermission anyOf={['platform.tenants.read']}>
      <TenantView id={id} />
    </RequirePermission>
  );
}

/**
 * One centre as TypEase staff may see it (GET /platform/tenants/:id): profile, owners,
 * subscription, usage against the plan, counts, domains, onboarding. No customers,
 * documents or cases: those need a support access request the centre approves.
 */
function TenantView({ id }: { id: string }) {
  const { t, formatDate } = useI18n();
  const api = usePlatformApi();
  const session = useSession();
  const rights = useTenantRights();
  const actions = useTenantActions();
  const [tab, setTab] = useUrlState('tab', 'overview');
  const [requesting, setRequesting] = React.useState(false);
  const tenant = useQuery({ queryKey: keys.tenants.detail(id), queryFn: ({ signal }) => api.tenants.get(id, signal), retry: (count, error) => !(isApiError(error) && error.status === 404) && count < 2 });
  const crumbs = [{ label: t('nav.tenants'), href: '/tenants' }];

  if (tenant.isPending) return <DetailSkeleton />;
  if (tenant.isError) {
    return (
      <>
        <PageHeader title={t('titles.tenantDetail')} breadcrumbs={crumbs} />
        <LoadError error={tenant.error} onRetry={() => void tenant.refetch()} />
      </>
    );
  }

  const data = tenant.data;
  const may = {
    billing: session.hasPermission('platform.billing.manage'),
    flags: session.hasPermission('platform.features.manage'),
    access: session.hasPermission('platform.access.request'),
    audit: session.hasPermission('platform.audit.read'),
  };
  const tabs = ['overview', ...(may.billing ? ['billing'] : []), ...(may.flags ? ['flags'] : []), ...(may.access ? ['access'] : []), ...(may.audit ? ['audit'] : [])];
  const current = tabs.includes(tab) ? tab : 'overview';
  const available = availableTenantActions(data, { ...rights, ownerInvited: data.owners.some((owner) => owner.status === 'INVITED') });
  const suspension = suspensionOf(data);
  const subject = { id: data.id, name: data.name, slug: data.slug, status: data.status, suspensionReason: data.suspensionReason, offboardingAt: data.offboardingAt };

  return (
    <>
      <PageHeader
        title={<bdi>{data.name}</bdi>}
        breadcrumbs={crumbs}
        meta={<StatusBadge kind="tenant" status={data.status} />}
        description={
          <>
            <span className="ltr-value tabular">{data.slug}</span> · {t('tenants.detail.signedUp', { date: formatDate(data.createdAt) })}
          </>
        }
        action={
          may.access && data.status !== 'ARCHIVED' ? (
            <Button variant="accent" onClick={() => setRequesting(true)}>
              <KeyRound aria-hidden="true" />
              {t('access.request.action')}
            </Button>
          ) : undefined
        }
        secondary={
          available.length ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">
                  {t('tenants.detail.lifecycle')}
                  <ChevronDown aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {available.map((action, index) => (
                  <React.Fragment key={action}>
                    {index > 0 && DESTRUCTIVE_ACTIONS.has(action) && !DESTRUCTIVE_ACTIONS.has(available[index - 1]) ? <DropdownMenuSeparator /> : null}
                    <DropdownMenuItem destructive={DESTRUCTIVE_ACTIONS.has(action)} onSelect={() => actions.ask(action, subject)}>
                      {ACTION_ICONS[action]}
                      {t(`tenants.actions.${action}.label`)}
                    </DropdownMenuItem>
                  </React.Fragment>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : undefined
        }
      />

      <div className="mb-5 space-y-3 empty:hidden">
        {data.offboarding || data.offboardingAt ? (
          <Alert
            tone="danger"
            title={t('tenants.detail.deletionTitle', { date: formatDate(data.offboarding?.purgeAt ?? data.offboardingAt) })}
            action={
              available.includes('cancelOffboarding') ? (
                <Button size="sm" variant="outline" onClick={() => actions.ask('cancelOffboarding', subject)}>
                  {t('tenants.actions.cancelOffboarding.label')}
                </Button>
              ) : undefined
            }
          >
            {t('tenants.detail.deletionText')}
            {data.offboarding?.reason ? (
              <span className="mt-1 block" dir="auto">
                {t('pc.reason')}: {data.offboarding.reason}
              </span>
            ) : null}
          </Alert>
        ) : null}
        {suspension ? (
          <Alert
            tone={suspension.kind === 'billing' ? 'warning' : 'danger'}
            title={t(`tenants.suspension.${suspension.kind}`)}
            action={
              suspension.kind === 'billing' && may.billing ? (
                <Button size="sm" variant="outline" onClick={() => setTab('billing')}>
                  {t('tenants.detail.openBilling')}
                </Button>
              ) : available.includes('reactivate') ? (
                <Button size="sm" variant="outline" onClick={() => actions.ask('reactivate', subject)}>
                  {t('tenants.actions.reactivate.label')}
                </Button>
              ) : undefined
            }
          >
            {suspension.text ? <span dir="auto">{suspension.text}</span> : t('tenants.suspension.billingText')}
            {data.suspendedAt ? <span className="mt-1 block text-sm text-muted-foreground">{t('tenants.detail.since', { date: formatDate(data.suspendedAt) })}</span> : null}
          </Alert>
        ) : null}
        {data.status === 'PENDING_APPROVAL' ? (
          <Alert
            tone="warning"
            title={t('tenants.detail.approvalTitle')}
            action={
              available.includes('approve') ? (
                <>
                  <Button size="sm" onClick={() => actions.ask('approve', subject)}>
                    {t('tenants.actions.approve.label')}
                  </Button>
                  <Button size="sm" variant="destructive-outline" onClick={() => actions.ask('reject', subject)}>
                    {t('tenants.actions.reject.label')}
                  </Button>
                </>
              ) : undefined
            }
          >
            {t('tenants.detail.approvalText')}
          </Alert>
        ) : null}
        {data.status === 'ARCHIVED' && !data.offboardingAt ? <Alert tone="warning" title={t('tenants.detail.archivedTitle', { date: formatDate(data.archivedAt) })}>{t('tenants.detail.archivedText')}</Alert> : null}
      </div>

      <Tabs value={current} onValueChange={setTab}>
        <TabsList>
          {tabs.map((value) => (
            <TabsTrigger key={value} value={value}>
              {t(`tenants.tabs.${value}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="overview">{current === 'overview' ? <Overview data={data} onOpenTab={setTab} may={may} /> : null}</TabsContent>
        {may.billing ? <TabsContent value="billing">{current === 'billing' ? <BillingPanel tenantId={data.id} tenantName={data.name} /> : null}</TabsContent> : null}
        {may.flags ? <TabsContent value="flags">{current === 'flags' ? <TenantFlags tenantId={data.id} tenantName={data.name} /> : null}</TabsContent> : null}
        {may.access ? <TabsContent value="access">{current === 'access' ? <TenantAccess tenant={data} onRequest={() => setRequesting(true)} /> : null}</TabsContent> : null}
        {may.audit ? (
          <TabsContent value="audit" className="space-y-6">
            {current === 'audit' ? (
              <>
                <section aria-labelledby="tenant-audit" className="space-y-3">
                  <div>
                    <h2 id="tenant-audit" className="text-md font-semibold text-foreground">
                      {t('tenants.audit.title')}
                    </h2>
                    <p className="mt-1 text-sm text-muted-foreground">{t('tenants.audit.text')}</p>
                  </div>
                  <AuditTable centreSlug={data.slug} embedded />
                </section>
                <section aria-labelledby="tenant-security" className="space-y-3">
                  <div>
                    <h2 id="tenant-security" className="text-md font-semibold text-foreground">
                      {t('tenants.audit.securityTitle')}
                    </h2>
                    <p className="mt-1 text-sm text-muted-foreground">{t('tenants.audit.securityText')}</p>
                  </div>
                  <SecurityEventsTable centreId={data.id} embedded />
                </section>
              </>
            ) : null}
          </TabsContent>
        ) : null}
      </Tabs>

      <RequestAccessDialog open={requesting} onOpenChange={setRequesting} centre={{ id: data.id, name: data.name, slug: data.slug }} />
      {actions.dialogs}
    </>
  );
}

// ---------------------------------------------------------------- overview

function Overview({ data, onOpenTab, may }: { data: TenantDetail; onOpenTab: (tab: string) => void; may: { billing: boolean; access: boolean } }) {
  const { t, has, formatDate, formatDateTime, formatNumber } = useI18n();
  const session = useSession();
  const publicApi = useApi();
  const plans = useQuery({ queryKey: keys.plans.all, queryFn: () => publicApi.public.plans(), staleTime: 5 * 60_000 });
  const sub = data.subscription;
  const plan = sub ? (plans.data ?? []).find((p) => p.key === sub.plan.key) : undefined;
  const emirate = data.profile.emirate ? (has(emirateKey(data.profile.emirate)) ? t(emirateKey(data.profile.emirate)) : data.profile.emirate) : null;
  const steps = data.onboarding?.steps ?? [];
  const stepsDone = steps.filter((step) => step.done).length;

  return (
    <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-3">
      <div className="min-w-0 space-y-6 xl:col-span-2">
        <Section title={t('tenants.usage.title')} description={sub ? t('tenants.usage.text', { plan: sub.plan.name }) : t('tenants.usage.textNoPlan')}>
          {data.usage.length ? (
            <ul className="mt-4 grid gap-x-8 gap-y-4 sm:grid-cols-2">
              {data.usage.map((line) => (
                <UsageMeter key={line.metric} line={line} />
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">{t('tenants.usage.empty')}</p>
          )}
        </Section>

        <Section title={t('tenants.owners.title')} description={t('tenants.owners.text')} flush>
          {data.owners.length ? (
            <ul className="divide-y">
              {data.owners.map((owner) => (
                <li key={owner.membershipId} className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 px-5 py-3.5">
                  <div className="min-w-0">
                    <p className="font-medium text-foreground">
                      <bdi>{owner.fullName}</bdi>
                    </p>
                    <p className="ltr-value block truncate text-sm text-muted-foreground">{owner.email}</p>
                    {owner.phone ? <p className="ltr-value tabular block text-sm text-muted-foreground">{owner.phone}</p> : null}
                  </div>
                  <div className="flex flex-col items-start gap-1.5 sm:items-end">
                    <div className="flex flex-wrap gap-1.5">
                      <StatusBadge kind="membership" status={owner.status} />
                      {owner.accountStatus === 'DISABLED' ? <Badge tone="danger">{t('tenants.owners.disabled')}</Badge> : null}
                      {owner.status !== 'INVITED' ? (
                        owner.mfaEnabled ? (
                          <Badge tone="success" icon={<ShieldCheck />}>
                            {t('tenants.owners.mfaOn')}
                          </Badge>
                        ) : (
                          <Badge tone="neutral" icon={<ShieldOff />}>
                            {t('tenants.owners.mfaOff')}
                          </Badge>
                        )
                      ) : null}
                      {owner.emailVerified ? null : <Badge tone="warning">{t('tenants.owners.emailUnverified')}</Badge>}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {owner.status === 'INVITED'
                        ? t('tenants.owners.invitedOn', { date: formatDate(owner.invitedAt) })
                        : owner.lastLoginAt
                          ? t('tenants.owners.lastLogin', { time: formatDateTime(owner.lastLoginAt) })
                          : t('tenants.owners.neverSignedIn')}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-5 py-4 text-sm text-muted-foreground">{t('tenants.owners.empty')}</p>
          )}
        </Section>

        <Section title={t('tenants.domains.title')} description={t('tenants.domains.text')} flush>
          <dl className="grid gap-x-8 gap-y-3 px-5 py-4 sm:grid-cols-2">
            <div>
              <dt className="text-sm text-muted-foreground">{t('plans.features.whiteLabel')}</dt>
              <dd className="mt-0.5">
                <PlanFeature included={plan?.features.whiteLabel} planName={sub?.plan.name} loading={plans.isPending && !!sub} />
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">{t('plans.features.customDomains')}</dt>
              <dd className="mt-0.5">
                <PlanFeature included={plan?.features.customDomains} planName={sub?.plan.name} loading={plans.isPending && !!sub} />
              </dd>
            </div>
          </dl>
          {data.domains.length ? (
            <ul className="divide-y border-t">
              {data.domains.map((domain) => (
                <li key={domain.id} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1.5 px-5 py-3">
                  <div className="min-w-0">
                    <p className="ltr-value block truncate font-medium text-foreground">{domain.domain}</p>
                    <p className="text-sm text-muted-foreground">
                      {has(`tenants.domains.kinds.${domain.kind}`) ? t(`tenants.domains.kinds.${domain.kind}`) : domain.kind} · {has(`tenants.domains.apps.${domain.app}`) ? t(`tenants.domains.apps.${domain.app}`) : domain.app}
                      {domain.isPrimary ? ` · ${t('tenants.domains.primary')}` : ''}
                    </p>
                    {domain.lastCheckError ? (
                      <p className="text-sm text-destructive-text" dir="auto">
                        {domain.lastCheckError}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-col items-start gap-1 sm:items-end">
                    <StatusBadge kind="domain" status={domain.status} />
                    <span className="tabular text-sm text-muted-foreground">
                      {domain.verifiedAt ? t('tenants.domains.verifiedOn', { date: formatDate(domain.verifiedAt) }) : domain.lastCheckedAt ? t('tenants.domains.checkedOn', { date: formatDate(domain.lastCheckedAt) }) : t('tenants.domains.neverChecked')}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="border-t px-5 py-4 text-sm text-muted-foreground">{t('tenants.domains.empty')}</p>
          )}
        </Section>

        {data.onboarding ? (
          <Section
            title={t('tenants.onboarding.title')}
            description={data.onboarding.completed ? t('tenants.onboarding.completed') : t('tenants.onboarding.progress', { done: formatNumber(stepsDone), total: formatNumber(steps.length) })}
            action={data.onboarding.completed ? <Badge tone="success">{t('tenants.onboarding.done')}</Badge> : <Badge tone="info">{t('tenants.onboarding.open')}</Badge>}
          >
            <ol className="mt-4 grid gap-x-8 gap-y-2.5 sm:grid-cols-2">
              {steps.map((step) => (
                <li key={step.key} className="flex items-start gap-2.5 text-base">
                  {step.done ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success-text" aria-hidden="true" /> : <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                  <span className={cn('min-w-0', !step.done && 'text-muted-foreground')}>
                    {has(`tenants.onboarding.steps.${step.key}`) ? t(`tenants.onboarding.steps.${step.key}`) : step.title}
                    <span className="sr-only"> – {step.done ? t('tenants.onboarding.stepDone') : t('tenants.onboarding.stepOpen')}</span>
                    {step.required ? null : <span className="ms-1.5 text-sm text-muted-foreground">({t('common.optional')})</span>}
                  </span>
                </li>
              ))}
            </ol>
          </Section>
        ) : null}
      </div>

      <div className="min-w-0 space-y-6">
        <Section
          title={t('billing.subscription')}
          action={
            may.billing ? (
              <Button variant="link" onClick={() => onOpenTab('billing')}>
                {t('tenants.tabs.billing')}
              </Button>
            ) : undefined
          }
        >
          {sub ? (
            <DescriptionList
              columns={1}
              className="mt-4"
              items={[
                {
                  label: t('billing.columns.plan'),
                  value: (
                    <span className="flex flex-wrap items-center gap-2">
                      {sub.plan.name}
                      <StatusBadge kind="subscription" status={sub.status} />
                    </span>
                  ),
                },
                {
                  label: t('billing.price'),
                  value: (
                    <>
                      <Money amount={sub.billingCycle === 'ANNUAL' ? sub.plan.annualPrice : sub.plan.monthlyPrice} currency={sub.plan.currency} /> · {t(`pc.cycle.${sub.billingCycle}`)}
                    </>
                  ),
                },
                sub.status === 'TRIALING'
                  ? { label: t('billing.trialEnds'), value: <span className="tabular">{formatDate(sub.trialEndsAt)}</span> }
                  : { label: t('billing.period'), value: sub.currentPeriodStart && sub.currentPeriodEnd ? <span className="tabular">{`${formatDate(sub.currentPeriodStart)} – ${formatDate(sub.currentPeriodEnd)}`}</span> : null },
                ...(sub.graceEndsAt ? [{ label: t('billing.graceEnds'), value: <span className="tabular">{formatDate(sub.graceEndsAt)}</span> }] : []),
                ...(sub.pendingPlan ? [{ label: t('billing.pending'), value: sub.pendingPlan.name }] : []),
                ...(sub.cancelAtPeriodEnd || sub.cancelledAt ? [{ label: t('billing.cancellation'), value: sub.cancelledAt ? <span className="tabular">{formatDate(sub.cancelledAt)}</span> : <Badge tone="warning">{t('billing.cancelAtPeriodEnd')}</Badge> }] : []),
              ]}
            />
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">{t('billing.noSubscriptionText')}</p>
          )}
        </Section>

        <Section title={t('tenants.team.title')}>
          <dl className="mt-4 grid grid-cols-2 gap-4">
            <Figure label={t('tenants.team.branches')} value={formatNumber(data.counts.branches.active)} note={data.counts.branches.total !== data.counts.branches.active ? t('tenants.team.ofTotal', { total: formatNumber(data.counts.branches.total) }) : undefined} />
            <Figure label={t('tenants.team.staff')} value={formatNumber(data.counts.staff.active)} note={[data.counts.staff.invited ? t('tenants.team.invited', { count: formatNumber(data.counts.staff.invited) }) : '', data.counts.staff.suspended ? t('tenants.team.suspended', { count: formatNumber(data.counts.staff.suspended) }) : ''].filter(Boolean).join(' · ') || undefined} />
          </dl>
        </Section>

        <Section title={t('tenants.support.title')}>
          <ul className="mt-3 space-y-2.5 text-base">
            <li className="flex items-center justify-between gap-3">
              {session.hasPermission('platform.support.manage') ? <TextLink href={`/support?tenantId=${data.id}`}>{t('tenants.support.tickets')}</TextLink> : <span>{t('tenants.support.tickets')}</span>}
              <span className="tabular font-medium">{formatNumber(data.support.openPlatformTickets)}</span>
            </li>
            <li className="flex items-center justify-between gap-3">
              {may.access ? (
                <button type="button" onClick={() => onOpenTab('access')} className={cn('rounded-sm text-start font-medium text-secondary-text hover:underline', focusRing)}>
                  {t('tenants.support.pendingAccess')}
                </button>
              ) : (
                <span>{t('tenants.support.pendingAccess')}</span>
              )}
              <span className="tabular font-medium">{formatNumber(data.support.pendingAccessRequests)}</span>
            </li>
            <li className="flex items-center justify-between gap-3">
              <span>{t('tenants.support.activeAccess')}</span>
              {data.support.activeAccessGrants > 0 ? <Badge tone="warning">{formatNumber(data.support.activeAccessGrants)}</Badge> : <span className="tabular font-medium">{formatNumber(0)}</span>}
            </li>
          </ul>
        </Section>

        <Section title={t('tenants.profile.title')}>
          <DescriptionList
            columns={1}
            className="mt-4"
            items={[
              { label: t('tenants.add.legalName'), value: data.legalName ? <bdi>{data.legalName}</bdi> : null },
              { label: t('tenants.columns.emirate'), value: emirate },
              { label: t('tenants.profile.contactEmail'), value: data.profile.contactEmail ? <span className="ltr-value">{data.profile.contactEmail}</span> : null },
              { label: t('tenants.profile.contactPhone'), value: data.profile.contactPhone ? <span className="ltr-value tabular">{data.profile.contactPhone}</span> : null },
              { label: t('tenants.profile.tradeLicence'), value: data.profile.tradeLicenceNo ? <span className="ltr-value tabular">{data.profile.tradeLicenceNo}</span> : null },
              { label: t('tenants.profile.taxNumber'), value: data.profile.taxRegistrationNo ? <span className="ltr-value tabular">{data.profile.taxRegistrationNo}</span> : null },
              { label: t('tenants.profile.regional'), value: <span className="ltr-value">{`${data.profile.timezone} · ${data.profile.defaultCurrency} · ${data.profile.defaultLanguage.toUpperCase()}`}</span> },
              { label: t('tenants.profile.ai'), value: data.profile.aiEnabled ? t('pc.on') : t('pc.off') },
              { label: t('tenants.profile.approved'), value: data.approvedAt ? <span className="tabular">{formatDate(data.approvedAt)}</span> : null },
            ]}
          />
        </Section>

        {data.lastActivity ? (
          <Section title={t('tenants.activity.title')} description={t('tenants.activity.text')}>
            <DescriptionList
              columns={1}
              className="mt-4"
              items={[
                { label: t('tenants.activity.last'), value: data.lastActivity.at ? <RelativeTime value={data.lastActivity.at} /> : t('pc.never') },
                { label: t('tenants.activity.lastLogin'), value: data.lastActivity.lastLoginAt ? <span className="tabular">{formatDateTime(data.lastActivity.lastLoginAt)}</span> : t('pc.never') },
                { label: t('tenants.activity.lastAction'), value: data.lastActivity.lastAuditedActionAt ? <span className="tabular">{formatDateTime(data.lastActivity.lastAuditedActionAt)}</span> : t('pc.never') },
              ]}
            />
          </Section>
        ) : null}
      </div>
    </div>
  );
}

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="tabular mt-0.5 text-2xl font-semibold text-foreground">{value}</dd>
      {note ? <dd className="text-sm text-muted-foreground">{note}</dd> : null}
    </div>
  );
}

/** Whether the centre's plan includes a feature. This is the plan, not what the centre has switched on. */
function PlanFeature({ included, planName, loading }: { included: boolean | undefined; planName: string | undefined; loading: boolean }) {
  const { t } = useI18n();
  if (loading) return <span className="text-muted-foreground">{t('common.loading')}</span>;
  if (included === undefined || !planName) return <span className="text-muted-foreground">{t('tenants.domains.planUnknown')}</span>;
  return included ? (
    <span className="inline-flex items-center gap-1.5 text-success-text">
      <Check className="size-4" aria-hidden="true" />
      {t('tenants.domains.inPlan', { plan: planName })}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <Ban className="size-4" aria-hidden="true" />
      {t('tenants.domains.notInPlan', { plan: planName })}
    </span>
  );
}

/** One metric against the plan's limit: -1 = unlimited, 0 = not part of the plan. */
function UsageMeter({ line }: { line: UsageLine }) {
  const { t, formatNumber, formatFileSize } = useI18n();
  const amount = (value: number) => (line.metric === 'storageMb' ? formatFileSize(value * 1024 * 1024) : formatNumber(value));
  const unlimited = line.limit < 0;
  const excluded = line.limit === 0;
  const ratio = unlimited || excluded ? 0 : Math.min(1, line.used / line.limit);
  const over = !unlimited && !excluded && line.used >= line.limit;
  const near = !over && ratio >= 0.8;
  return (
    <li className="min-w-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-base text-foreground">{t(`plans.limits.${line.metric}`)}</span>
        <span className="tabular ltr-value shrink-0 text-sm text-muted-foreground">
          <span className={cn('font-medium', over ? 'text-destructive-text' : 'text-foreground')}>{amount(line.used)}</span>
          {unlimited || excluded ? null : ` / ${amount(line.limit)}`}
        </span>
      </div>
      {unlimited ? (
        <p className="mt-1 text-sm text-muted-foreground">{t('pc.unlimited')}</p>
      ) : excluded ? (
        <p className="mt-1 text-sm text-muted-foreground">{t('pc.notIncluded')}</p>
      ) : (
        <>
          <div
            role="meter"
            aria-label={t(`plans.limits.${line.metric}`)}
            aria-valuemin={0}
            aria-valuemax={line.limit}
            aria-valuenow={Math.min(line.used, line.limit)}
            aria-valuetext={`${amount(line.used)} / ${amount(line.limit)}`}
            className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted"
          >
            <div className={cn('h-full rounded-full', over ? 'bg-destructive' : near ? 'bg-warning' : 'bg-secondary')} style={{ width: `${Math.max(line.used > 0 ? 2 : 0, ratio * 100)}%` }} />
          </div>
          {over ? <p className="mt-1 text-sm font-medium text-destructive-text">{t('tenants.usage.limitReached')}</p> : near ? <p className="mt-1 text-sm text-warning-text">{t('tenants.usage.nearLimit')}</p> : null}
        </>
      )}
    </li>
  );
}
