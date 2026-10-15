'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, CalendarPlus, ChevronDown, GitMerge, MailPlus, Pencil, Plus, UserX } from 'lucide-react';
import { isApiError } from '@typease/api-client';
import {
  Alert, Badge, Button, Card, ConfirmDialog, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState, Label, PageHeader, PermissionGate, StatusBadge, Tabs,
  TabsContent, TabsList, TabsTrigger, Textarea, useApi, useErrorMessage, useI18n, useSession, useToast,
} from '@typease/ui';
import { CustomerDocumentsTab } from '@/components/people/customer/documents-tab';
import { CustomerStatement } from '@/components/fin/customer-statement';
import { EditCustomerDialog } from '@/components/people/customer/edit-dialog';
import { MergeCustomerDialog } from '@/components/people/customer/merge-dialog';
import { CustomerOverviewTab, type CustomerTabId } from '@/components/people/customer/overview-tab';
import { PortalInvitationDialog } from '@/components/people/customer/portal-dialog';
import {
  CustomerActivityTab, CustomerAppointmentsTab, CustomerCommunicationsTab, CustomerInvoicesTab, CustomerPaymentsTab, CustomerRemindersTab, CustomerRequestsTab, CustomerTicketsTab,
} from '@/components/people/customer/record-tabs';
import { ActiveTabInView, DetailSkeleton, LoadError, RecordLink, TagChip, isErasedName, isNotFound, usePersonName, useUrlTab } from '@/components/people/shared';
import type { CustomerOverview, CustomerProfile } from '@/components/people/types';
import { peopleKeys } from '@/lib/keys/people';

const TABS: Array<{ id: CustomerTabId; anyOf: string[] }> = [
  { id: 'overview', anyOf: [] },
  { id: 'requests', anyOf: ['request.read.all', 'request.read.assigned'] },
  { id: 'documents', anyOf: ['document.read'] },
  { id: 'invoices', anyOf: ['invoice.read'] },
  { id: 'payments', anyOf: ['payment.read'] },
  { id: 'statement', anyOf: ['payment.read', 'report.financial'] },
  { id: 'appointments', anyOf: ['appointment.read', 'appointment.manage'] },
  { id: 'communications', anyOf: ['notification.manage'] },
  { id: 'reminders', anyOf: ['reminder.read', 'reminder.manage'] },
  { id: 'tickets', anyOf: ['ticket.read', 'ticket.manage'] },
  { id: 'activity', anyOf: [] },
];
const TAB_IDS = TABS.map((tab) => tab.id);

/** Everything about one customer: profile, the records of the other modules, and the actions on the record. */
export function CustomerDetail() {
  const { id } = useParams<{ id: string }>();
  const { t, formatRelative, formatNumber } = useI18n();
  const api = useApi();
  const session = useSession();
  const toasts = useToast();
  const describe = useErrorMessage();
  const queryClient = useQueryClient();
  const [tab, setTab] = useUrlTab<CustomerTabId>(TAB_IDS, 'overview');
  const personName = usePersonName();

  const [editing, setEditing] = React.useState(false);
  const [inviting, setInviting] = React.useState(false);
  const [merging, setMerging] = React.useState<{ otherId: string | null } | null>(null);
  const [archiving, setArchiving] = React.useState(false);
  const [restoring, setRestoring] = React.useState(false);
  const [archiveReason, setArchiveReason] = React.useState('');
  const [archiveError, setArchiveError] = React.useState<{ code: string; message: string } | null>(null);
  const reasonId = React.useId();

  const query = useQuery({ queryKey: peopleKeys.customers.detail(id), queryFn: () => api.client.get<CustomerOverview>(`/customers/${id}`), retry: (count, error) => !isNotFound(error) && count < 2 });
  const crumbs = [{ label: t('nav.customers'), href: '/customers' }];

  if (query.isPending) return <DetailSkeleton />;
  if (query.isError) {
    return (
      <>
        <PageHeader title={t('people.customer.pageTitle')} breadcrumbs={crumbs} />
        {isNotFound(query.error) ? (
          <Card>
            <EmptyState
              size="page"
              icon={<UserX />}
              title={t('people.customer.notFoundTitle')}
              description={t('people.customer.notFoundText')}
              action={
                <Button asChild>
                  <Link href="/customers">{t('people.customer.backToList')}</Link>
                </Button>
              }
            />
          </Card>
        ) : (
          <LoadError error={query.error} onRetry={() => void query.refetch()} title={t('people.customer.loadError')} />
        )}
      </>
    );
  }

  const customer = query.data;
  const active = customer.status === 'ACTIVE';
  const visibleTabs = TABS.filter((item) => session.hasAnyPermission(item.anyOf)).map((item) => item.id);
  const current = visibleTabs.includes(tab) ? tab : 'overview';

  const archive = async () => {
    setArchiveError(null);
    try {
      await api.client.post<CustomerProfile>(`/customers/${customer.id}/archive`, archiveReason.trim() ? { reason: archiveReason.trim() } : {});
      toasts.success(t('people.customer.archive.done'), customer.fullName);
      setArchiveReason('');
      await queryClient.invalidateQueries({ queryKey: peopleKeys.customers.all });
    } catch (error) {
      // The API says why it refuses (open requests ...): shown inside the dialog, which stays open.
      setArchiveError({ code: isApiError(error) ? error.code : 'ERROR', message: describe(error) });
      throw error;
    }
  };
  const restore = async () => {
    try {
      await api.client.post<CustomerProfile>(`/customers/${customer.id}/restore`);
      toasts.success(t('people.customer.archive.restored'), customer.fullName);
      await queryClient.invalidateQueries({ queryKey: peopleKeys.customers.all });
    } catch (error) {
      toasts.error(error);
      throw error;
    }
  };

  const canArchive = session.hasPermission('customer.archive') && (active || customer.status === 'ARCHIVED');
  const canMerge = session.hasPermission('customer.merge') && (active || customer.status === 'ARCHIVED');
  const canInvite = session.hasPermission('customer.update') && active && (customer.portalAccess.status === 'NONE' || customer.portalAccess.status === 'INVITED');
  const canBook = session.hasAnyPermission(['appointment.manage']) && active;
  const hasMore = canArchive || canMerge || canInvite || canBook;

  const count = (tabId: CustomerTabId) => (tabId === 'requests' ? customer.counters.totalRequests : tabId === 'documents' ? customer.counters.documents : null);

  return (
    <>
      <PageHeader
        breadcrumbs={crumbs}
        title={
          <span className="inline-flex flex-wrap items-baseline gap-x-3">
            <span>{personName(customer.fullName)}</span>
            {customer.fullNameAr ? (
              <span lang="ar" dir="rtl" className="text-xl font-normal text-muted-foreground">
                {customer.fullNameAr}
              </span>
            ) : null}
          </span>
        }
        meta={
          <>
            {active ? null : <StatusBadge kind="customer" status={customer.status} />}
            <Badge tone={customer.type === 'BUSINESS' ? 'brand' : 'neutral'}>{t(`customers.types.${customer.type}`)}</Badge>
            {customer.portalAccess.status === 'NONE' ? null : <StatusBadge kind="portalAccess" status={customer.portalAccess.status} />}
          </>
        }
        description={
          <>
            <span className="tabular ltr-value font-medium text-foreground">{customer.customerNo}</span>
            <span aria-hidden="true"> · </span>
            {t('people.customer.lastActivity', { when: formatRelative(customer.lastActivityAt ?? customer.createdAt) })}
            {customer.tags.length ? (
              <span className="mt-2 flex flex-wrap gap-1.5">
                {customer.tags.map((tag) => (
                  <TagChip key={tag.id} tag={tag} />
                ))}
              </span>
            ) : null}
          </>
        }
        action={
          active ? (
            <PermissionGate permission="request.create">
              <Button asChild variant="accent">
                <Link href={`/requests/new?customerId=${customer.id}`}>
                  <Plus aria-hidden="true" />
                  {t('requests.new')}
                </Link>
              </Button>
            </PermissionGate>
          ) : null
        }
        secondary={
          <>
            {active ? (
              <PermissionGate permission="customer.update">
                <Button variant="outline" onClick={() => setEditing(true)}>
                  <Pencil aria-hidden="true" />
                  {t('common.edit')}
                </Button>
              </PermissionGate>
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
                  {canBook ? (
                    <DropdownMenuItem asChild>
                      <Link href={`/appointments?customerId=${customer.id}`}>
                        <CalendarPlus aria-hidden="true" />
                        {t('people.customer.actions.book')}
                      </Link>
                    </DropdownMenuItem>
                  ) : null}
                  {canInvite ? (
                    <DropdownMenuItem onSelect={() => setInviting(true)}>
                      <MailPlus aria-hidden="true" />
                      {customer.portalAccess.status === 'INVITED' ? t('people.customer.portal.resend') : t('people.customer.portal.invite')}
                    </DropdownMenuItem>
                  ) : null}
                  {canMerge ? (
                    <DropdownMenuItem onSelect={() => setMerging({ otherId: null })}>
                      <GitMerge aria-hidden="true" />
                      {t('people.customer.actions.merge')}
                    </DropdownMenuItem>
                  ) : null}
                  {canArchive ? (
                    <>
                      <DropdownMenuSeparator />
                      {active ? (
                        <DropdownMenuItem
                          destructive
                          onSelect={() => {
                            setArchiveError(null);
                            setArchiving(true);
                          }}
                        >
                          <Archive aria-hidden="true" />
                          {t('people.customer.archive.action')}
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem onSelect={() => setRestoring(true)}>
                          <ArchiveRestore aria-hidden="true" />
                          {t('people.customer.archive.restore')}
                        </DropdownMenuItem>
                      )}
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </>
        }
      />

      {customer.status === 'MERGED' ? (
        <Alert tone="info" className="mb-5" title={t('people.customer.banner.mergedTitle')}>
          {customer.mergedInto && isErasedName(customer.mergedInto.fullName) ? (
            // The kept record was erased after a deletion request: it no longer opens (404), so there is no link.
            t('people.customer.banner.mergedErased', { number: customer.mergedInto.customerNo })
          ) : customer.mergedInto ? (
            <>
              {t('people.customer.banner.mergedText')} <RecordLink href={`/customers/${customer.mergedInto.id}`}>{`${customer.mergedInto.fullName} (${customer.mergedInto.customerNo})`}</RecordLink>
            </>
          ) : (
            t('people.customer.banner.mergedText')
          )}
        </Alert>
      ) : null}
      {customer.status === 'ARCHIVED' ? (
        <Alert
          tone="warning"
          className="mb-5"
          title={t('people.customer.banner.archivedTitle')}
          action={
            session.hasPermission('customer.archive') ? (
              <Button size="sm" variant="outline" onClick={() => setRestoring(true)}>
                <ArchiveRestore aria-hidden="true" />
                {t('people.customer.archive.restore')}
              </Button>
            ) : undefined
          }
        >
          {t('people.customer.banner.archivedText')}
        </Alert>
      ) : null}
      {customer.status === 'ANONYMISED' ? (
        <Alert tone="info" className="mb-5" title={t('people.customer.banner.anonymisedTitle')}>
          {t('people.customer.banner.anonymisedText')}
        </Alert>
      ) : null}
      {customer.mergedFrom.length ? (
        <Alert tone="info" className="mb-5">
          {t('people.customer.banner.mergedFrom')}{' '}
          {customer.mergedFrom.map((source, index) => (
            <React.Fragment key={source.id}>
              {index ? ', ' : ''}
              <RecordLink href={`/customers/${source.id}`}>{`${personName(source.fullName)} (${source.customerNo})`}</RecordLink>
            </React.Fragment>
          ))}
        </Alert>
      ) : null}

      <Tabs value={current} onValueChange={(next) => setTab(next as CustomerTabId)}>
        <ActiveTabInView value={current} />
        <TabsList aria-label={t('people.customer.tabs.label')}>
          {visibleTabs.map((tabId) => (
            <TabsTrigger key={tabId} value={tabId}>
              {t(`people.customer.tabs.${tabId}`)}
              {count(tabId) ? <span className="tabular rounded-full bg-muted px-1.5 text-xs font-medium text-muted-foreground">{formatNumber(count(tabId))}</span> : null}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="overview">
          <CustomerOverviewTab customer={customer} readOnly={!active} visibleTabs={visibleTabs} onOpenTab={setTab} onInvite={() => setInviting(true)} onMerge={(otherId) => setMerging({ otherId })} />
        </TabsContent>
        <TabsContent value="requests">
          <CustomerRequestsTab customer={customer} />
        </TabsContent>
        <TabsContent value="documents">
          <CustomerDocumentsTab customer={customer} />
        </TabsContent>
        <TabsContent value="invoices">
          <CustomerInvoicesTab customer={customer} />
        </TabsContent>
        <TabsContent value="payments">
          <CustomerPaymentsTab customer={customer} />
        </TabsContent>
        <TabsContent value="statement">{current === 'statement' ? <CustomerStatement path={`/customers/${customer.id}/statement`} /> : null}</TabsContent>
        <TabsContent value="appointments">
          <CustomerAppointmentsTab customer={customer} />
        </TabsContent>
        <TabsContent value="communications">
          <CustomerCommunicationsTab customer={customer} />
        </TabsContent>
        <TabsContent value="reminders">
          <CustomerRemindersTab customer={customer} />
        </TabsContent>
        <TabsContent value="tickets">
          <CustomerTicketsTab customer={customer} />
        </TabsContent>
        <TabsContent value="activity">
          <CustomerActivityTab customer={customer} />
        </TabsContent>
      </Tabs>

      {editing ? <EditCustomerDialog customer={customer} open onOpenChange={setEditing} /> : null}
      {inviting ? <PortalInvitationDialog customer={customer} open onOpenChange={setInviting} /> : null}
      {merging ? <MergeCustomerDialog customer={customer} open onOpenChange={(next) => !next && setMerging(null)} initialOtherId={merging.otherId} /> : null}

      <ConfirmDialog
        open={archiving}
        onOpenChange={setArchiving}
        title={t('people.customer.archive.title', { name: customer.fullName })}
        description={t('people.customer.archive.text')}
        confirmLabel={t('people.customer.archive.action')}
        onConfirm={archive}
      >
        <div className="space-y-3">
          {archiveError ? (
            <Alert tone="danger" live title={archiveError.code === 'CUSTOMER_HAS_OPEN_REQUESTS' ? t('people.customer.archive.blockedTitle') : undefined}>
              {archiveError.message}
              {archiveError.code === 'CUSTOMER_HAS_OPEN_REQUESTS' && visibleTabs.includes('requests') ? (
                <Button
                  variant="link"
                  className="mt-1 block"
                  onClick={() => {
                    setArchiving(false);
                    setTab('requests');
                  }}
                >
                  {t('people.customer.archive.showRequests')}
                </Button>
              ) : null}
            </Alert>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor={reasonId} optionalText={t('common.optional')}>
              {t('people.customer.archive.reason')}
            </Label>
            <Textarea id={reasonId} rows={2} maxLength={500} value={archiveReason} onChange={(e) => setArchiveReason(e.target.value)} dir="auto" />
          </div>
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={restoring}
        onOpenChange={setRestoring}
        tone="default"
        title={t('people.customer.archive.restoreTitle', { name: customer.fullName })}
        description={t('people.customer.archive.restoreText')}
        confirmLabel={t('people.customer.archive.restore')}
        onConfirm={restore}
      />
    </>
  );
}
