'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  BellRing,
  ClipboardList,
  IdCard,
  MailPlus,
  MoreHorizontal,
  Pencil,
  Plus,
  Send,
  ShieldOff,
  UserCheck,
  UserX,
} from 'lucide-react';
import type { RequestListItem } from '@typease/api-client';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DataTable,
  DescriptionList,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  PageHeader,
  Skeleton,
  StatusBadge,
  countryName,
  formatPhone,
  useI18n,
  type DataTableColumn,
} from '@typease/ui';
import { DocumentsTable } from '@/components/portal/documents-table';
import { useEmployeeActions } from '@/components/portal/employee-dialogs';
import {
  CompanyStatusNotice,
  DetailSkeleton,
  Expiry,
  Gate,
  LoadError,
  Ltr,
  NoAccess,
  NotFoundCard,
  isForbidden,
  isNotFound,
  retryUnlessFinal,
  useCompanyAccount,
  useRole,
} from '@/components/portal/shared';
import { usePortalApi } from '@/lib/api';
import { ROUTES } from '@/lib/config';
import { keys } from '@/lib/query-keys';
import type { Employee } from '@/lib/types';
import { requestHref } from '../../requests/requests-list';

export function EmployeeDetail({ id }: { id: string }) {
  return (
    <Gate anyOf={['corp.employees.read']}>
      <Detail id={id} />
    </Gate>
  );
}

/**
 * One employee as the company's administrators see them: who they are, what is on their identity
 * documents and when it runs out, their portal access, their requests, the files the centre holds
 * for them and the expiry reminders in their name. Identity numbers arrive masked and stay masked.
 */
function Detail({ id }: { id: string }) {
  const { t, locale, formatDate } = useI18n();
  const api = usePortalApi();
  const role = useRole();
  const { active } = useCompanyAccount();
  const actions = useEmployeeActions();
  const query = useQuery({
    queryKey: keys.employees.detail(id),
    queryFn: ({ signal }) => api.employee(id, signal),
    retry: retryUnlessFinal,
  });

  const crumbs = [{ label: t('nav.employees'), href: ROUTES.employees }];
  if (query.isPending) {
    return (
      <>
        <PageHeader breadcrumbs={crumbs} title={t('titles.employeeDetail')} />
        <DetailSkeleton />
      </>
    );
  }
  if (query.isError) {
    return (
      <>
        <PageHeader breadcrumbs={crumbs} title={t('titles.employeeDetail')} />
        {isNotFound(query.error) ? (
          <NotFoundCard
            title={t('my.employees.notFoundTitle')}
            text={t('my.employees.notFoundText')}
            backHref={ROUTES.employees}
            backLabel={t('nav.employees')}
          />
        ) : isForbidden(query.error) ? (
          <NoAccess />
        ) : (
          <LoadError error={query.error} onRetry={() => void query.refetch()} />
        )}
      </>
    );
  }

  const e = query.data;
  const canManage = role.canManageEmployees && active;
  const canRequest = role.canCreateRequests && active && e.status === 'ACTIVE';
  const newRequestHref = `${ROUTES.newRequest}?employee=${e.id}`;

  return (
    <>
      <PageHeader
        breadcrumbs={crumbs}
        title={<span dir="auto">{e.fullName}</span>}
        meta={
          e.status === 'INACTIVE' ? <Badge tone="neutral">{t('my.employees.inactive')}</Badge> : undefined
        }
        description={
          e.designation || e.employeeNo ? (
            <>
              {e.designation ? <span dir="auto">{e.designation}</span> : null}
              {e.designation && e.employeeNo ? <span aria-hidden="true"> – </span> : null}
              {e.employeeNo ? (
                <>
                  {t('my.employees.columns.employeeNo')} <Ltr>{e.employeeNo}</Ltr>
                </>
              ) : null}
            </>
          ) : undefined
        }
        action={
          canRequest ? (
            <Button asChild variant="accent" size="lg" className="sm:h-10 sm:px-4 sm:text-base">
              <Link href={newRequestHref}>
                <Plus aria-hidden="true" />
                {t('nav.newRequest')}
              </Link>
            </Button>
          ) : undefined
        }
        secondary={
          canManage ? (
            <>
              <Button
                variant="outline"
                onClick={() => actions.open({ kind: 'edit', employee: e })}
                data-action="edit-employee"
              >
                <Pencil aria-hidden="true" />
                {t('common.edit')}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label={t('common.moreActions')}
                    className="!flex-none"
                  >
                    <MoreHorizontal aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {e.status === 'ACTIVE' ? (
                    <DropdownMenuItem
                      destructive
                      onSelect={() => actions.open({ kind: 'deactivate', employee: e })}
                    >
                      <UserX aria-hidden="true" />
                      {t('my.employees.deactivate')}
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem onSelect={() => actions.reactivate(e)}>
                      <UserCheck aria-hidden="true" />
                      {t('my.employees.reactivate')}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : undefined
        }
      />
      <CompanyStatusNotice className="mb-4" />
      {e.status === 'INACTIVE' ? (
        <Alert tone="info" className="mb-4">
          {t('my.employees.inactiveText')}
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{t('my.employees.details.title')}</CardTitle>
            </CardHeader>
            <CardContent>
              <DescriptionList
                items={[
                  {
                    label: t('my.employees.fields.fullNameAr'),
                    value: e.fullNameAr ? (
                      <span dir="rtl" lang="ar">
                        {e.fullNameAr}
                      </span>
                    ) : null,
                  },
                  {
                    label: t('my.employees.fields.nationality'),
                    value: countryName(e.nationality, locale) || null,
                  },
                  {
                    label: t('my.employees.fields.dateOfBirth'),
                    value: e.dateOfBirth ? formatDate(e.dateOfBirth) : null,
                  },
                  {
                    label: t('my.employees.fields.phone'),
                    value: e.phone ? <Ltr>{formatPhone(e.phone)}</Ltr> : null,
                  },
                  {
                    label: t('my.employees.fields.email'),
                    value: e.email ? <Ltr className="break-all">{e.email}</Ltr> : null,
                  },
                  { label: t('my.employees.details.added'), value: formatDate(e.createdAt) },
                ]}
              />
            </CardContent>
          </Card>

          <Card data-identity>
            <CardHeader>
              <div>
                <CardTitle className="text-lg">{t('my.employees.identity.title')}</CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">{t('my.employees.identity.maskedNote')}</p>
              </div>
            </CardHeader>
            <CardContent>
              <ul className="divide-y rounded-lg border">
                <IdentityRow
                  label={t('my.employees.fields.emiratesId')}
                  masked={e.emiratesIdMasked}
                  expiry={e.emiratesIdExpiry}
                />
                <IdentityRow
                  label={t('my.employees.fields.passportNo')}
                  masked={e.passportNoMasked}
                  expiry={e.passportExpiry}
                  extra={countryName(e.passportCountry, locale) || null}
                />
              </ul>
            </CardContent>
          </Card>

          <EmployeeRecords employee={e} canRequest={canRequest} newRequestHref={newRequestHref} />
        </div>

        <aside className="space-y-6">
          <LoginCard
            employee={e}
            canManage={canManage}
            canRevoke={role.canManageEmployees}
            actions={actions}
          />
          <RemindersCard employee={e} canRequest={canRequest} />
        </aside>
      </div>
      {actions.dialogs}
    </>
  );
}

function IdentityRow({
  label,
  masked,
  expiry,
  extra,
}: {
  label: string;
  masked: string | null;
  expiry: string | null;
  extra?: string | null;
}) {
  const { t } = useI18n();
  return (
    <li className="flex flex-wrap items-center gap-x-6 gap-y-2 p-4">
      <IdCard className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1 basis-40">
        <p className="text-base font-medium text-foreground">{label}</p>
        <p className="text-sm text-muted-foreground">
          {masked ? (
            <span data-masked>
              <Ltr>{masked}</Ltr>
            </span>
          ) : (
            t('my.employees.identity.notOnFile')
          )}
          {extra ? (
            <>
              <span aria-hidden="true"> – </span>
              {extra}
            </>
          ) : null}
        </p>
      </div>
      <div className="text-base">
        {expiry ? (
          <>
            <span className="me-2 text-sm text-muted-foreground">{t('my.employees.identity.expires')}</span>
            <Expiry date={expiry} />
          </>
        ) : (
          <span className="text-sm text-muted-foreground">{t('my.employees.identity.noExpiry')}</span>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------- portal access

function LoginCard({
  employee,
  canManage,
  canRevoke,
  actions,
}: {
  employee: Employee;
  canManage: boolean;
  canRevoke: boolean;
  actions: ReturnType<typeof useEmployeeActions>;
}) {
  const { t, formatDate, formatRelative } = useI18n();
  const login = employee.login ?? {
    status: 'NONE' as const,
    email: null,
    invitedAt: null,
    joinedAt: null,
    lastLoginAt: null,
  };
  const canInvite = canManage && employee.status === 'ACTIVE';
  return (
    <Card data-login-card={login.status}>
      <CardHeader className="items-center">
        <CardTitle className="text-lg">{t('my.employees.login.title')}</CardTitle>
        <StatusBadge kind="portalAccess" status={login.status} />
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-base text-muted-foreground">{t(`my.employees.login.state.${login.status}`)}</p>
        {login.status !== 'NONE' ? (
          <DescriptionList
            columns={1}
            items={[
              {
                label: t('my.employees.login.email'),
                value: login.email ? <Ltr className="break-all">{login.email}</Ltr> : null,
              },
              ...(login.invitedAt
                ? [{ label: t('my.employees.login.invitedAt'), value: formatDate(login.invitedAt) }]
                : []),
              ...(login.joinedAt
                ? [{ label: t('my.employees.login.joinedAt'), value: formatDate(login.joinedAt) }]
                : []),
              ...(login.status === 'ACTIVE'
                ? [
                    {
                      label: t('my.employees.login.lastLogin'),
                      value: login.lastLoginAt
                        ? formatRelative(login.lastLoginAt)
                        : t('my.employees.login.never'),
                    },
                  ]
                : []),
            ]}
          />
        ) : null}
        <div className="flex flex-col gap-2">
          {canInvite && (login.status === 'NONE' || login.status === 'SUSPENDED') ? (
            <Button onClick={() => actions.open({ kind: 'invite', employee })} data-action="invite-login">
              <MailPlus aria-hidden="true" />
              {login.status === 'SUSPENDED'
                ? t('my.employees.login.inviteAgain')
                : t('my.employees.login.invite')}
            </Button>
          ) : null}
          {canInvite && login.status === 'INVITED' ? (
            <>
              <Button
                onClick={() => actions.resend(employee)}
                loading={actions.busy}
                loadingText={t('common.loading')}
                data-action="resend-login"
              >
                <Send aria-hidden="true" />
                {t('my.employees.login.resend')}
              </Button>
              <Button variant="outline" onClick={() => actions.open({ kind: 'invite', employee })}>
                {t('my.employees.login.inviteOther')}
              </Button>
            </>
          ) : null}
          {canRevoke && login.status !== 'NONE' ? (
            <Button
              variant="destructive-outline"
              onClick={() => actions.open({ kind: 'revoke', employee })}
              data-action="revoke-login"
            >
              <ShieldOff aria-hidden="true" />
              {login.status === 'INVITED' ? t('my.employees.login.withdraw') : t('my.employees.login.revoke')}
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- requests and files of this person

function EmployeeRecords({
  employee,
  canRequest,
  newRequestHref,
}: {
  employee: Employee;
  canRequest: boolean;
  newRequestHref: string;
}) {
  const { t, pick, formatDate } = useI18n();
  const api = usePortalApi();
  // The person's record: the filter key of their requests, documents and reminders (GET …?customerId=).
  const customerId = employee.customerId;
  const fixed = React.useMemo(() => ({ customerId }), [customerId]);

  const columns = React.useMemo<Array<DataTableColumn<RequestListItem>>>(
    () => [
      {
        id: 'service',
        header: t('my.requests.columns.service'),
        mobile: 'title',
        cell: (r) => pick(r.service.name, r.service.nameAr),
      },
      {
        id: 'status',
        header: t('my.requests.columns.status'),
        mobile: 'badge',
        cell: (r) => <StatusBadge kind="requestCustomer" status={r.status} label={r.statusLabel} />,
      },
      {
        id: 'number',
        header: t('my.requests.columns.number'),
        className: 'whitespace-nowrap',
        cell: (r) => <Ltr>{r.requestNo}</Ltr>,
      },
      {
        id: 'created',
        header: t('my.requests.columns.created'),
        className: 'whitespace-nowrap',
        cell: (r) => formatDate(r.createdAt),
      },
    ],
    [t, pick, formatDate],
  );

  const newRequest = canRequest ? (
    <Button asChild variant="outline">
      <Link href={newRequestHref}>
        <Plus aria-hidden="true" />
        {t('my.requests.newFor', { name: employee.fullName })}
      </Link>
    </Button>
  ) : undefined;

  return (
    <>
      <Card data-employee-requests>
        <CardHeader className="items-center pb-4">
          <CardTitle className="text-lg">{t('my.employees.requests.title')}</CardTitle>
          <Button asChild variant="link">
            <Link href={`${ROUTES.requests}?employee=${employee.id}`}>{t('my.employees.requests.all')}</Link>
          </Button>
        </CardHeader>
        <DataTable<RequestListItem>
          bare
          caption={t('my.employees.requests.title')}
          queryKey={keys.requests.of(customerId)}
          queryFn={(params, signal) => api.requests(params, signal)}
          columns={columns}
          rowKey={(r) => r.id}
          rowHref={requestHref}
          fixedParams={fixed}
          defaultSort="createdAt:desc"
          defaultPageSize={5}
          searchable={false}
          pagination={false}
          syncUrl={false}
          className="border-t"
          empty={{
            icon: <ClipboardList />,
            title: t('my.employees.requests.emptyTitle'),
            description: t('my.employees.requests.emptyText'),
            action: newRequest,
          }}
        />
      </Card>

      <Card data-employee-documents>
        <CardHeader className="pb-4">
          <div>
            <CardTitle className="text-lg">{t('my.employees.documents.title')}</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">{t('my.employees.documents.text')}</p>
          </div>
        </CardHeader>
        <DocumentsTable
          compact
          caption={t('my.employees.documents.title')}
          queryKey={keys.documents.of(customerId)}
          fixedParams={fixed}
          empty={{
            title: t('my.employees.documents.emptyTitle'),
            description: t('my.employees.documents.emptyText'),
          }}
        />
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- expiry reminders in this person's name

/** The expiry schedule the centre keeps for this person (GET /me/reminders?customerId=). */
function RemindersCard({ employee, canRequest }: { employee: Employee; canRequest: boolean }) {
  const { t, pick } = useI18n();
  const api = usePortalApi();
  const reminders = useQuery({
    queryKey: keys.reminders.of(employee.customerId),
    queryFn: ({ signal }) => api.reminders({ customerId: employee.customerId }, signal),
  });
  const mine = React.useMemo(
    () => [...(reminders.data?.data ?? [])].sort((a, b) => a.daysLeft - b.daysLeft),
    [reminders.data],
  );
  return (
    <Card data-employee-reminders>
      <CardHeader className="items-center">
        <CardTitle className="text-lg">{t('my.employees.reminders.title')}</CardTitle>
        <Button asChild variant="link">
          <Link href={ROUTES.reminders}>{t('my.employees.reminders.all')}</Link>
        </Button>
      </CardHeader>
      <CardContent>
        {reminders.isPending ? (
          <Skeleton className="h-16" role="status" aria-label={t('common.loading')} />
        ) : reminders.isError ? (
          <LoadError error={reminders.error} onRetry={() => void reminders.refetch()} />
        ) : mine.length === 0 ? (
          <p className="flex gap-2.5 text-base text-muted-foreground">
            <BellRing className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
            {t('my.employees.reminders.empty')}
          </p>
        ) : (
          <ul className="space-y-4">
            {mine.map((r) => (
              <li key={r.id} className="space-y-1.5">
                <p className="text-base font-medium text-foreground">
                  {pick(r.documentTypeName, r.documentTypeNameAr)}
                </p>
                <p className="text-base">
                  <Expiry date={r.expiryDate} />
                </p>
                {r.renewalRequestId ? (
                  <Button asChild size="sm" variant="outline">
                    <Link href={`${ROUTES.requests}/${r.renewalRequestId}`}>
                      {t('my.reminders.openRenewal')}
                    </Link>
                  </Button>
                ) : canRequest && r.status === 'ACTIVE' ? (
                  <Button asChild size="sm" variant="outline">
                    <Link href={`${ROUTES.newRequest}?renewalOf=${r.id}&employee=${employee.id}`}>
                      {t('my.reminders.renew')}
                    </Link>
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
