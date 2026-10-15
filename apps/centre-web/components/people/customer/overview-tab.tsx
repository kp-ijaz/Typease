'use client';

import * as React from 'react';
import { CalendarClock, Check, ClipboardList, FolderOpen, LifeBuoy, Minus, Receipt } from 'lucide-react';
import { Button, DescriptionList, PermissionGate, StatCard, StatusBadge, cn, countryName, focusRing, useI18n, useSession } from '@typease/ui';
import { Ltr, RecordLink, Section } from '../shared';
import type { CustomerOverview } from '../types';
import { ConsentsCard } from './consents-card';
import { ContactsCard } from './contacts-card';
import { DuplicatesCard } from './duplicates-card';
import { IdentityCard } from './identity-card';
import { NotesCard } from './notes-card';
import { TagsCard } from './tags-card';

export type CustomerTabId = 'overview' | 'requests' | 'documents' | 'invoices' | 'payments' | 'statement' | 'appointments' | 'communications' | 'reminders' | 'tickets' | 'activity';

const CHANNELS = ['email', 'sms', 'whatsapp', 'push'] as const;
const CHANNEL_KEYS = { email: 'EMAIL', sms: 'SMS', whatsapp: 'WHATSAPP', push: 'PUSH' } as const;

/** The overview of one customer: counters, profile, identity (masked), notes, consents, contacts, tags, online account, possible duplicates. */
export function CustomerOverviewTab({
  customer, readOnly, visibleTabs, onOpenTab, onInvite, onMerge,
}: {
  customer: CustomerOverview;
  /** Archived, merged and anonymised records cannot be changed. */
  readOnly: boolean;
  visibleTabs: CustomerTabId[];
  onOpenTab: (tab: CustomerTabId) => void;
  onInvite: () => void;
  onMerge: (otherId: string) => void;
}) {
  const { t, tn, locale, formatDate, formatDateTime, formatRelative, formatNumber, formatMoney } = useI18n();
  const session = useSession();
  const c = customer.counters;

  const counter = (tab: CustomerTabId, node: React.ReactNode) =>
    visibleTabs.includes(tab) ? (
      <button type="button" key={tab} onClick={() => onOpenTab(tab)} className={cn('rounded-lg text-start transition-shadow hover:shadow-sm', focusRing)}>
        {node}
      </button>
    ) : (
      <div key={tab}>{node}</div>
    );

  const address = customer.address ? [customer.address.line1, customer.address.city, customer.address.emirate, countryName(customer.address.country, locale)].filter(Boolean).join(', ') : '';
  const prefs = customer.communicationPrefs ?? {};
  const portal = customer.portalAccess;

  return (
    <div className="space-y-6">
      <section aria-label={t('people.customer.counters.title')} className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-5">
        {counter('requests', <StatCard className="h-full" tone={c.openRequests ? 'info' : 'neutral'} icon={<ClipboardList />} value={formatNumber(c.openRequests)} label={t('people.customer.counters.openRequests')} hint={tn('people.customer.counters.totalRequests', c.totalRequests)} />)}
        {counter('documents', <StatCard className="h-full" tone="neutral" icon={<FolderOpen />} value={formatNumber(c.documents)} label={t('people.customer.counters.documents')} />)}
        {counter(
          'invoices',
          <StatCard
            className="h-full"
            tone={c.unpaidInvoices ? 'danger' : 'neutral'}
            icon={<Receipt />}
            value={formatNumber(c.unpaidInvoices)}
            label={t('people.customer.counters.unpaidInvoices')}
            hint={c.unpaidInvoices ? formatMoney(c.unpaidInvoicesBalance, c.currency) : undefined}
          />,
        )}
        {counter('appointments', <StatCard className="h-full" tone={c.upcomingAppointments ? 'info' : 'neutral'} icon={<CalendarClock />} value={formatNumber(c.upcomingAppointments)} label={t('people.customer.counters.upcomingAppointments')} />)}
        {counter('tickets', <StatCard className="h-full" tone={c.openTickets ? 'warning' : 'neutral'} icon={<LifeBuoy />} value={formatNumber(c.openTickets)} label={t('people.customer.counters.openTickets')} />)}
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          <Section title={t('people.customer.profile.title')}>
            <DescriptionList
              columns={2}
              items={[
                { label: t('customers.form.type'), value: t(`customers.types.${customer.type}`) },
                { label: t('customers.form.preferredLanguage'), value: customer.preferredLanguage === 'ar' ? 'العربية' : 'English' },
                ...(customer.type === 'BUSINESS'
                  ? []
                  : [
                      { label: t('customers.form.nationality'), value: countryName(customer.nationality, locale) || null },
                      { label: t('people.customer.fields.dateOfBirth'), value: customer.dateOfBirth ? formatDate(customer.dateOfBirth) : null },
                    ]),
                {
                  label: t('people.customer.fields.company'),
                  value: customer.corporateAccount ? (
                    session.hasPermission('corporate.read') ? (
                      <RecordLink href={`/corporate/${customer.corporateAccount.id}`}>{customer.corporateAccount.companyName}</RecordLink>
                    ) : (
                      customer.corporateAccount.companyName
                    )
                  ) : null,
                },
                { label: t('customers.columns.created'), value: formatDate(customer.createdAt) },
                { label: t('people.customer.fields.address'), value: address ? <span dir="auto">{address}</span> : null, wide: true },
              ]}
            />
          </Section>

          {customer.type === 'BUSINESS' && !customer.hasEmiratesId && !customer.hasPassport ? null : <IdentityCard customer={customer} />}
          <NotesCard customer={customer} readOnly={readOnly} />
          <ConsentsCard customer={customer} readOnly={readOnly} />
        </div>

        <div className="min-w-0 space-y-6">
          <ContactsCard customer={customer} readOnly={readOnly} />

          <Section title={t('people.customer.prefs.title')} description={readOnly || !session.hasPermission('customer.update') ? t('people.customer.prefs.descriptionReadOnly') : t('people.customer.prefs.description')}>
            <ul className="space-y-2">
              {CHANNELS.map((channel) => {
                const on = prefs[channel] !== false;
                return (
                  <li key={channel} className="flex items-center justify-between gap-3 text-base">
                    <span>{t(`people.channels.${CHANNEL_KEYS[channel]}`)}</span>
                    <span className={cn('inline-flex items-center gap-1.5 text-sm', on ? 'text-success-text' : 'text-muted-foreground')}>
                      {on ? <Check className="size-4" aria-hidden="true" /> : <Minus className="size-4" aria-hidden="true" />}
                      {on ? t('people.customer.prefs.on') : t('people.customer.prefs.off')}
                    </span>
                  </li>
                );
              })}
              <li className="flex items-center justify-between gap-3 border-t pt-2 text-base">
                <span>{t('people.customer.prefs.marketing')}</span>
                <span className={cn('inline-flex items-center gap-1.5 text-sm', customer.marketingOptIn ? 'text-success-text' : 'text-muted-foreground')}>
                  {customer.marketingOptIn ? <Check className="size-4" aria-hidden="true" /> : <Minus className="size-4" aria-hidden="true" />}
                  {customer.marketingOptIn ? t('people.customer.prefs.on') : t('people.customer.prefs.off')}
                </span>
              </li>
            </ul>
          </Section>

          <TagsCard customer={customer} readOnly={readOnly} />

          <Section title={t('people.customer.portal.title')}>
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge kind="portalAccess" status={portal.status} />
              </div>
              <p className="text-sm text-muted-foreground">{t(`people.customer.portal.state.${portal.status}`)}</p>
              {portal.email ? (
                <p className="text-base">
                  <Ltr className="break-all">{portal.email}</Ltr>
                </p>
              ) : null}
              {portal.status === 'ACTIVE' ? (
                <p className="text-sm text-muted-foreground">{portal.lastLoginAt ? t('people.customer.portal.lastLogin', { when: formatRelative(portal.lastLoginAt) }) : t('people.customer.portal.neverSignedIn')}</p>
              ) : null}
              {!readOnly && (portal.status === 'NONE' || portal.status === 'INVITED') ? (
                <PermissionGate permission="customer.update">
                  <Button variant="outline" size="sm" onClick={onInvite}>
                    {portal.status === 'INVITED' ? t('people.customer.portal.resend') : t('people.customer.portal.invite')}
                  </Button>
                </PermissionGate>
              ) : null}
            </div>
          </Section>

          <DuplicatesCard customer={customer} onMerge={onMerge} />

          <p className="px-1 text-sm text-muted-foreground">
            {t('people.customer.profile.lastActivity', { when: customer.lastActivityAt ? formatDateTime(customer.lastActivityAt) : formatDateTime(customer.createdAt) })}
          </p>
        </div>
      </div>
    </div>
  );
}
