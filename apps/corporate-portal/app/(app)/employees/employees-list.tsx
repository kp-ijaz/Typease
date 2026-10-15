'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ExternalLink, ListPlus, MailPlus, Pencil, Send, ShieldOff, Upload, UserCheck, UserPlus, UserX, Users } from 'lucide-react';
import { Badge, Button, DataTable, PageHeader, StatusBadge, countryName, useI18n, type DataTableColumn, type DataTableFilter, type RowAction } from '@typease/ui';
import { EmployeeDialog, ImportEmployeesDialog, useEmployeeActions } from '@/components/portal/employee-dialogs';
import { CompanyStatusNotice, Expiry, Gate, Ltr, useCompanyAccount, useRole } from '@/components/portal/shared';
import { usePortalApi } from '@/lib/api';
import { ROUTES } from '@/lib/config';
import { keys } from '@/lib/query-keys';
import type { Employee } from '@/lib/types';

export function EmployeesList() {
  return (
    <Gate anyOf={['corp.employees.read']}>
      <Directory />
    </Gate>
  );
}

/** A masked identity number with its expiry date underneath; the number itself never reaches the browser. */
function IdentityCell({ masked, expiry }: { masked: string | null; expiry: string | null }) {
  if (!masked && !expiry) return null;
  return (
    <span className="flex flex-col gap-0.5">
      {masked ? <Ltr>{masked}</Ltr> : null}
      {expiry ? <Expiry date={expiry} className="text-sm text-muted-foreground" /> : null}
    </span>
  );
}

/**
 * The company's employee directory: who is on file with the centre, whose documents run out soon,
 * and who can sign in to this portal for their own requests.
 */
function Directory() {
  const { t, locale } = useI18n();
  const api = usePortalApi();
  const role = useRole();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const { active } = useCompanyAccount();
  const actions = useEmployeeActions();
  const canManage = role.canManageEmployees && active;
  const [adding, setAdding] = React.useState(() => search.get('add') === '1');
  const [importing, setImporting] = React.useState(false);

  const closeAdd = () => {
    setAdding(false);
    if (search.get('add')) router.replace(pathname, { scroll: false });
  };

  const columns = React.useMemo<Array<DataTableColumn<Employee>>>(
    () => [
      {
        id: 'name',
        header: t('my.employees.columns.name'),
        sortField: 'fullName',
        mobile: 'title',
        cell: (e) => (
          <>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span dir="auto">{e.fullName}</span>
              {e.status === 'INACTIVE' ? <Badge tone="neutral">{t('my.employees.inactive')}</Badge> : null}
            </span>
            {e.designation ? (
              <span className="block text-sm font-normal text-muted-foreground" dir="auto">
                {e.designation}
              </span>
            ) : null}
          </>
        ),
      },
      { id: 'employeeNo', header: t('my.employees.columns.employeeNo'), sortField: 'employeeNo', className: 'whitespace-nowrap', cell: (e) => (e.employeeNo ? <Ltr>{e.employeeNo}</Ltr> : null) },
      { id: 'nationality', header: t('my.employees.fields.nationality'), cell: (e) => countryName(e.nationality, locale) || null },
      { id: 'emiratesId', header: t('my.employees.fields.emiratesId'), cell: (e) => (e.emiratesIdMasked || e.emiratesIdExpiry ? <IdentityCell masked={e.emiratesIdMasked} expiry={e.emiratesIdExpiry} /> : null) },
      { id: 'passport', header: t('my.employees.fields.passportNo'), cell: (e) => (e.passportNoMasked || e.passportExpiry ? <IdentityCell masked={e.passportNoMasked} expiry={e.passportExpiry} /> : null) },
      { id: 'login', header: t('my.employees.columns.login'), mobile: 'badge', cell: (e) => (e.login ? <StatusBadge kind="portalAccess" status={e.login.status} data-login-status={e.login.status} /> : null) },
    ],
    [t, locale],
  );
  const filters = React.useMemo<DataTableFilter[]>(
    () => [
      {
        id: 'status',
        type: 'select',
        label: t('my.employees.filter.label'),
        allLabel: t('my.employees.filter.active'),
        options: [
          { value: 'INACTIVE', label: t('my.employees.filter.inactive') },
          { value: 'ALL', label: t('my.employees.filter.everyone') },
        ],
      },
    ],
    [t],
  );
  const rowActions = React.useMemo<Array<RowAction<Employee>>>(
    () => [
      { id: 'open', label: t('common.open'), icon: <ExternalLink aria-hidden="true" />, href: (e) => `${ROUTES.employees}/${e.id}` },
      ...(role.canCreateRequests && active
        ? [{ id: 'request', label: t('my.employees.newRequest'), icon: <ListPlus aria-hidden="true" />, hidden: (e: Employee) => e.status !== 'ACTIVE', href: (e: Employee) => `${ROUTES.newRequest}?employee=${e.id}` }]
        : []),
      ...(canManage
        ? [
            { id: 'edit', label: t('common.edit'), icon: <Pencil aria-hidden="true" />, onSelect: (e: Employee) => actions.open({ kind: 'edit', employee: e }) },
            {
              id: 'invite',
              label: t('my.employees.login.invite'),
              icon: <MailPlus aria-hidden="true" />,
              hidden: (e: Employee) => e.status !== 'ACTIVE' || (e.login?.status !== 'NONE' && e.login?.status !== 'SUSPENDED'),
              onSelect: (e: Employee) => actions.open({ kind: 'invite', employee: e }),
            },
            { id: 'resend', label: t('my.employees.login.resend'), icon: <Send aria-hidden="true" />, hidden: (e: Employee) => e.login?.status !== 'INVITED', onSelect: (e: Employee) => actions.resend(e) },
          ]
        : []),
      // Taking access away stays possible while the company's account is paused.
      ...(role.canManageEmployees
        ? [
            {
              id: 'revoke',
              label: t('my.employees.login.revoke'),
              icon: <ShieldOff aria-hidden="true" />,
              destructive: true,
              hidden: (e: Employee) => !e.login || e.login.status === 'NONE' || e.login.status === 'INVITED',
              onSelect: (e: Employee) => actions.open({ kind: 'revoke', employee: e }),
            },
            {
              id: 'withdraw',
              label: t('my.employees.login.withdraw'),
              icon: <ShieldOff aria-hidden="true" />,
              destructive: true,
              hidden: (e: Employee) => e.login?.status !== 'INVITED',
              onSelect: (e: Employee) => actions.open({ kind: 'revoke', employee: e }),
            },
          ]
        : []),
      ...(canManage
        ? [
            { id: 'deactivate', label: t('my.employees.deactivate'), icon: <UserX aria-hidden="true" />, destructive: true, hidden: (e: Employee) => e.status !== 'ACTIVE', onSelect: (e: Employee) => actions.open({ kind: 'deactivate', employee: e }) },
            { id: 'reactivate', label: t('my.employees.reactivate'), icon: <UserCheck aria-hidden="true" />, hidden: (e: Employee) => e.status !== 'INACTIVE', onSelect: (e: Employee) => actions.reactivate(e) },
          ]
        : []),
    ],
    [t, role.canCreateRequests, role.canManageEmployees, active, canManage, actions],
  );

  const add = canManage ? (
    <Button variant="accent" size="lg" className="sm:h-10 sm:px-4 sm:text-base" onClick={() => setAdding(true)} data-action="add-employee">
      <UserPlus aria-hidden="true" />
      {t('my.employees.add')}
    </Button>
  ) : undefined;

  return (
    <>
      <PageHeader
        title={t('nav.employees')}
        description={t('sections.employees')}
        action={add}
        secondary={
          canManage ? (
            <Button variant="outline" onClick={() => setImporting(true)} data-action="import-employees">
              <Upload aria-hidden="true" />
              {t('my.employees.import.open')}
            </Button>
          ) : undefined
        }
      />
      <CompanyStatusNotice className="mb-4" />
      <DataTable<Employee>
        caption={t('nav.employees')}
        queryKey={keys.employees.all}
        queryFn={(params, signal) => api.employees(params, signal)}
        columns={columns}
        filters={filters}
        rowKey={(e) => e.id}
        rowHref={(e) => `${ROUTES.employees}/${e.id}`}
        rowActions={rowActions}
        searchPlaceholder={t('my.employees.search')}
        defaultSort="fullName:asc"
        empty={{ icon: <Users />, title: t('my.employees.emptyTitle'), description: t('my.employees.emptyText'), action: add }}
      />
      <p className="mt-3 text-sm text-muted-foreground">{t('my.employees.privacyNote')}</p>

      {adding ? <EmployeeDialog employee={null} onClose={closeAdd} /> : null}
      {importing ? <ImportEmployeesDialog onClose={() => setImporting(false)} /> : null}
      {actions.dialogs}
    </>
  );
}
