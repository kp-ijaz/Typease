'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ClipboardList, Plus } from 'lucide-react';
import type { RequestBucket, RequestListItem } from '@typease/api-client';
import {
  Button,
  Card,
  Combobox,
  DataTable,
  PageHeader,
  Skeleton,
  StatusBadge,
  useI18n,
  type ComboboxOption,
  type DataTableColumn,
  type DataTableFilter,
  type ListParams,
} from '@typease/ui';
import { CompanyStatusNotice, Gate, LoadError, Ltr, PersonName, retryUnlessFinal, useCompanyAccount, useRole } from '@/components/portal/shared';
import { usePortalApi } from '@/lib/api';
import { ROUTES } from '@/lib/config';
import { keys } from '@/lib/query-keys';

/**
 * What the "Show" filter offers. People think in "who has to act" rather than in sixteen statuses:
 * each choice is either one of the API's stages (`bucket`) or a set of statuses.
 */
const BUCKETS: RequestBucket[] = [
  'newRequests',
  'pendingVerification',
  'awaitingCustomer',
  'awaitingPayment',
  'readyForProcessing',
  'inProgress',
  'overdue',
  'completedToday',
];
const STATUS_SETS = { drafts: 'DRAFT', completed: 'COMPLETED', cancelled: 'CANCELLED' } as const;
const SHOW = [
  'drafts',
  'newRequests',
  'pendingVerification',
  'awaitingCustomer',
  'awaitingPayment',
  'readyForProcessing',
  'inProgress',
  'overdue',
  'completed',
  'cancelled',
] as const;

/** The table's `show` choice as the parameters GET /requests understands. */
function toApiParams(params: ListParams): ListParams {
  const { show, ...rest } = params;
  if (typeof show !== 'string' || !show) return rest;
  if ((BUCKETS as string[]).includes(show)) return { ...rest, bucket: show };
  const statuses = (STATUS_SETS as Record<string, string>)[show];
  return statuses ? { ...rest, status: statuses } : rest;
}

/** A draft opens in the step-by-step form where it stopped; everything else opens the request page. */
/** The person a list row is about; `erased` is sent by the API but not yet named in the shared type. */
export const rowPerson = (r: Pick<RequestListItem, 'customer' | 'customerName'>) => ({ name: r.customerName || r.customer?.fullName, erased: (r.customer as { erased?: boolean } | undefined)?.erased });

export const requestHref = (r: Pick<RequestListItem, 'id' | 'status'>) =>
  r.status === 'DRAFT' ? `${ROUTES.newRequest}?draft=${r.id}` : `${ROUTES.requests}/${r.id}`;

/**
 * Requests: all of the company's for an administrator (with a filter by employee), the person's
 * own for an employee. The API decides which rows exist for whom; this page never asks for more.
 */
export function RequestsList() {
  return (
    <Gate anyOf={['corp.requests.read', 'self.requests']}>
      <Requests />
    </Gate>
  );
}

function Requests() {
  const { t, pick, formatDate } = useI18n();
  const api = usePortalApi();
  const role = useRole();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const { active } = useCompanyAccount();
  const employeeId = role.company ? (search.get('employee') ?? '') : '';

  // The employee the list is narrowed to (administrators only): their record carries the filter key.
  const employee = useQuery({
    queryKey: keys.employees.detail(employeeId),
    queryFn: ({ signal }) => api.employee(employeeId, signal),
    enabled: !!employeeId,
    retry: retryUnlessFinal,
  });

  const setEmployee = (id: string) => {
    const params = new URLSearchParams(window.location.search);
    if (id) params.set('employee', id);
    else params.delete('employee');
    params.delete('page');
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const newHref = employeeId ? `${ROUTES.newRequest}?employee=${employeeId}` : ROUTES.newRequest;
  const newRequest =
    role.canCreateRequests && active ? (
      <Button asChild variant="accent" size="lg" className="sm:h-10 sm:px-4 sm:text-base">
        <Link href={newHref}>
          <Plus aria-hidden="true" />
          {t('nav.newRequest')}
        </Link>
      </Button>
    ) : undefined;

  const columns = React.useMemo<Array<DataTableColumn<RequestListItem>>>(
    () => [
      {
        id: 'service',
        header: t('my.requests.columns.service'),
        mobile: 'title',
        cell: (r) => pick(r.service.name, r.service.nameAr),
      },
      // The API words the status for the company ("Action needed from you").
      {
        id: 'status',
        header: t('my.requests.columns.status'),
        mobile: 'badge',
        cell: (r) => <StatusBadge kind="requestCustomer" status={r.status} label={r.statusLabel} />,
      },
      ...(role.company
        ? [
            {
              id: 'person',
              header: t('my.requests.columns.person'),
              cell: (r: RequestListItem) => <PersonName {...rowPerson(r)} />,
            },
          ]
        : [
            {
              // An employee sees the requests their company made for them next to the ones they made themselves.
              id: 'madeBy',
              header: t('my.requests.columns.madeBy'),
              cell: (r: RequestListItem) => (
                <span data-made-by={r.corporateAccountId ? 'company' : 'self'}>
                  {r.corporateAccountId ? t('my.requests.madeBy.company') : t('my.requests.madeBy.self')}
                </span>
              ),
            },
          ]),
      {
        id: 'number',
        header: t('my.requests.columns.number'),
        sortField: 'requestNo',
        className: 'whitespace-nowrap',
        cell: (r) => <Ltr>{r.requestNo}</Ltr>,
      },
      {
        id: 'created',
        header: t('my.requests.columns.created'),
        sortField: 'createdAt',
        className: 'whitespace-nowrap',
        cell: (r) => formatDate(r.createdAt),
      },
      ...(role.canSeeMoney
        ? [
            {
              id: 'payment',
              header: t('my.requests.columns.payment'),
              // "Unpaid" only means something once there is an invoice: before that the column stays empty.
              cell: (r: RequestListItem) =>
                r.status === 'DRAFT' ||
                r.status === 'CANCELLED' ||
                r.paymentStatus === 'NOT_REQUIRED' ||
                (r.paymentStatus === 'UNPAID' &&
                  ['SUBMITTED', 'UNDER_REVIEW', 'QUOTED', 'AWAITING_CUSTOMER'].includes(r.status)) ? null : (
                  <StatusBadge kind="requestPayment" status={r.paymentStatus} />
                ),
            },
          ]
        : []),
    ],
    [t, pick, formatDate, role.company, role.canSeeMoney],
  );
  const filters = React.useMemo<DataTableFilter[]>(
    () => [
      {
        id: 'show',
        type: 'select',
        label: t('my.requests.filter.label'),
        options: SHOW.map((key) => ({ value: key, label: t(`my.requests.filter.${key}`) })),
      },
    ],
    [t],
  );

  const loadEmployees = React.useCallback(
    async (q: string, signal: AbortSignal): Promise<ComboboxOption[]> => {
      const page = await api.employees(
        { q: q || undefined, status: 'ALL', pageSize: 20, sort: 'fullName:asc' },
        signal,
      );
      return page.data.map((e) => ({
        value: e.id,
        label: e.fullName,
        description: [e.employeeNo, e.designation].filter(Boolean).join(' – ') || undefined,
      }));
    },
    [api],
  );
  const employeeFilter = role.company ? (
    <div className="w-full sm:w-64" data-employee-filter>
      <Combobox
        aria-label={t('my.requests.employeeFilter')}
        value={employeeId}
        selectedLabel={employee.data?.fullName ?? (employeeId ? t('common.loading') : null)}
        onValueChange={(id) => setEmployee(id)}
        loadOptions={loadEmployees}
        placeholder={t('my.requests.employeeAll')}
        searchPlaceholder={t('my.requests.employeeSearch')}
        emptyText={t('my.requests.employeeNone')}
        clearable
      />
    </div>
  ) : null;

  const customerId = employee.data?.customerId ?? '';
  const fixed = React.useMemo(() => (customerId ? { customerId } : undefined), [customerId]);
  const waiting = !!employeeId && employee.isPending;

  return (
    <>
      <PageHeader
        title={role.company ? t('nav.requests') : t('my.requests.mineTitle')}
        description={role.company ? t('sections.requests') : t('my.requests.mineText')}
        action={newRequest}
      />
      <CompanyStatusNotice className="mb-4" />

      {employeeId && employee.isError ? (
        <LoadError className="mb-4" error={employee.error} onRetry={() => void employee.refetch()} />
      ) : null}
      {waiting ? (
        <Card className="space-y-3 p-4" role="status" aria-label={t('common.loading')}>
          <div className="flex flex-wrap gap-3">{employeeFilter}</div>
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </Card>
      ) : (
        <DataTable<RequestListItem>
          caption={t('nav.requests')}
          queryKey={keys.requests.all}
          queryFn={(params, signal) => api.requests(toApiParams(params), signal)}
          columns={columns}
          rowKey={(r) => r.id}
          rowHref={requestHref}
          filters={filters}
          fixedParams={fixed}
          searchPlaceholder={role.company ? t('my.requests.searchCompany') : t('my.requests.search')}
          defaultSort="createdAt:desc"
          toolbar={employeeFilter}
          empty={{
            icon: <ClipboardList />,
            title: employee.data
              ? t('my.requests.employeeEmptyTitle', { name: employee.data.fullName })
              : role.company
                ? t('my.requests.emptyTitle')
                : t('my.requests.mineEmptyTitle'),
            description: employee.data
              ? t('my.requests.employeeEmptyText')
              : role.canCreateRequests
                ? t('my.requests.emptyText')
                : undefined,
            action: newRequest,
          }}
        />
      )}
    </>
  );
}
