'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  FolderTree,
  FileSpreadsheet,
  FileStack,
  Landmark,
  LayoutGrid,
  PackagePlus,
  Plus,
  RotateCcw,
  SearchX,
} from 'lucide-react';
import type { Page } from '@typease/types';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  PermissionGate,
  SearchInput,
  Select,
  Skeleton,
  cn,
  focusRing,
  useApi,
  useErrorMessage,
  useI18n,
  useSession,
} from '@typease/ui';
import { SwitchRow, useRun, useUrlState } from '@/components/ops/common';
import type { Service, ServiceCategory } from '@/components/ops/types';
import { opsKeys } from '@/lib/keys/ops';
import { AddServiceDialog } from './add-service-dialog';
import { CategoriesDialog } from './categories-dialog';
import { DocumentTypesDialog } from './document-types-dialog';
import { ImportDialog } from '@/components/import-dialog';

const ALL = 'all';

/** The service catalogue: every service of the centre, grouped by category. */
export function ServicesCatalogue() {
  const { t, tn, pick, formatMoney } = useI18n();
  const api = useApi();
  const session = useSession();
  const describe = useErrorMessage();
  const { run, busy } = useRun();
  const canManage = session.hasPermission('service.manage');

  const [q, setQ] = useUrlState('q', '');
  const [state, setState] = useUrlState('state', ALL);
  const [visibility, setVisibility] = useUrlState('visibility', ALL);
  const [deleted, setDeleted] = useUrlState('deleted', '');
  const [dialog, setDialog] = React.useState<'add' | 'categories' | 'documentTypes' | 'import' | null>(null);
  const [addInCategory, setAddInCategory] = React.useState<string | undefined>();

  const filters = React.useMemo(
    () => ({
      q: q || undefined,
      isActive: deleted ? undefined : state === ALL ? undefined : state === 'active',
      isPublic: visibility === 'public' ? true : visibility === 'hidden' ? false : undefined,
      onlineAvailable: visibility === 'online' ? true : visibility === 'counter' ? false : undefined,
      deleted: deleted ? true : undefined,
    }),
    [q, state, visibility, deleted],
  );
  const filtered = !!q || state !== ALL || visibility !== ALL || !!deleted;

  const categories = useQuery({
    queryKey: opsKeys.categories.list(true),
    queryFn: () =>
      api.client.get<ServiceCategory[]>('/service-categories', { query: { includeInactive: true } }),
  });
  // The list is grouped, so all pages are read (a catalogue has tens of services, at most a few hundred).
  const services = useQuery({
    queryKey: opsKeys.services.catalogue(filters),
    queryFn: async ({ signal }) => {
      const all: Service[] = [];
      for (let page = 1; page <= 10; page++) {
        const result = await api.client.get<Page<Service>>('/services', {
          query: { ...filters, page, pageSize: 100, sort: 'sortOrder:asc' },
          signal,
        });
        all.push(...result.data);
        if (page >= result.meta.totalPages) break;
      }
      return all;
    },
  });

  const groups = React.useMemo(() => {
    const byCategory = new Map<string, Service[]>();
    for (const service of services.data ?? [])
      byCategory.set(service.categoryId, [...(byCategory.get(service.categoryId) ?? []), service]);
    return (categories.data ?? [])
      .map((category) => ({ category, services: byCategory.get(category.id) ?? [] }))
      .filter((g) => g.services.length > 0 || (!filtered && g.category.isActive));
  }, [categories.data, services.data, filtered]);

  const openAdd = (categoryId?: string) => {
    setAddInCategory(categoryId);
    setDialog('add');
  };
  const addButton = (
    <PermissionGate permission="service.manage">
      <Button variant="accent" onClick={() => openAdd()}>
        <Plus aria-hidden="true" />
        {t('ops.services.add')}
      </Button>
    </PermissionGate>
  );
  const installStarter = () =>
    run(
      'starter',
      () => api.client.post<{ createdCount: number; skippedCount: number }>('/services/starter-catalogue'),
      {
        success: t('ops.services.starter.done'),
        description: (r) => tn('ops.services.starter.doneDescription', r.createdCount),
        invalidate: [opsKeys.services.all, opsKeys.categories.all],
      },
    );

  const emptyCatalogue = !filtered && services.data?.length === 0;

  return (
    <>
      <PageHeader
        title={t('ops.services.title')}
        description={t('ops.services.description')}
        action={addButton}
        secondary={
          <>
            <PermissionGate permission="service.manage">
              <Button variant="outline" onClick={() => setDialog('categories')}>
                <FolderTree aria-hidden="true" />
                {t('ops.services.categories.manage')}
              </Button>
              <Button variant="outline" onClick={() => setDialog('documentTypes')}>
                <FileStack aria-hidden="true" />
                {t('ops.services.documentTypes.manage')}
              </Button>
            <Button variant="outline" onClick={() => setDialog('import')}>
              <FileSpreadsheet aria-hidden="true" />
              {t('imports.services.button')}
            </Button>
            </PermissionGate>
            <FeeCatalogueButton />
          </>
        }
      />

      <Card className="mb-4 flex flex-wrap items-center gap-3 p-4">
        <div className="w-full sm:w-72">
          <SearchInput
            value={q}
            onChange={setQ}
            placeholder={t('ops.services.searchPlaceholder')}
            aria-label={t('ops.services.searchPlaceholder')}
          />
        </div>
        <Select
          aria-label={t('ops.services.filters.state')}
          className="w-full sm:w-44"
          value={state}
          onValueChange={setState}
          disabled={!!deleted}
          options={[
            { value: ALL, label: t('ops.services.filters.stateAll') },
            { value: 'active', label: t('ops.services.filters.active') },
            { value: 'inactive', label: t('ops.services.filters.inactive') },
          ]}
        />
        <Select
          aria-label={t('ops.services.filters.visibility')}
          className="w-full sm:w-56"
          value={visibility}
          onValueChange={setVisibility}
          options={[
            { value: ALL, label: t('ops.services.filters.visibilityAll') },
            { value: 'public', label: t('ops.services.filters.public') },
            { value: 'hidden', label: t('ops.services.filters.notPublic') },
            { value: 'online', label: t('ops.services.filters.online') },
            { value: 'counter', label: t('ops.services.filters.counterOnly') },
          ]}
        />
        {canManage ? (
          <SwitchRow
            className="sm:ms-auto"
            label={t('ops.services.filters.deleted')}
            checked={!!deleted}
            onCheckedChange={(on) => setDeleted(on ? '1' : '')}
          />
        ) : null}
      </Card>

      {services.isPending || categories.isPending ? (
        <div className="space-y-4" role="status" aria-label={t('common.loading')}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-40 w-full" />
          ))}
        </div>
      ) : services.isError || categories.isError ? (
        <Alert
          tone="danger"
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void services.refetch();
                void categories.refetch();
              }}
            >
              {t('common.retry')}
            </Button>
          }
        >
          {describe(services.error ?? categories.error)}
        </Alert>
      ) : emptyCatalogue ? (
        <Card>
          <EmptyState
            size="page"
            icon={<LayoutGrid />}
            title={t('ops.services.emptyTitle')}
            description={canManage ? t('ops.services.emptyText') : t('ops.services.emptyTextReadOnly')}
            action={
              <PermissionGate permission="service.manage">
                <Button
                  variant="accent"
                  loading={busy === 'starter'}
                  loadingText={t('common.loading')}
                  onClick={() => void installStarter()}
                >
                  <PackagePlus aria-hidden="true" />
                  {t('ops.services.starter.install')}
                </Button>
                <Button variant="outline" onClick={() => openAdd()}>
                  <Plus aria-hidden="true" />
                  {t('ops.services.add')}
                </Button>
              </PermissionGate>
            }
          />
        </Card>
      ) : groups.every((g) => g.services.length === 0) && filtered ? (
        <Card>
          <EmptyState
            icon={<SearchX />}
            title={t('table.emptyFilteredTitle')}
            description={t('table.emptyFilteredDescription')}
          />
        </Card>
      ) : (
        <div className="space-y-4">
          {groups.map(({ category, services: list }) => (
            <Card key={category.id} aria-labelledby={`cat-${category.id}`}>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-3.5">
                <h2
                  id={`cat-${category.id}`}
                  className="flex flex-wrap items-center gap-2 text-md font-semibold"
                >
                  {pick(category.name, category.nameAr)}
                  <span className="text-sm font-normal text-muted-foreground">
                    {tn('ops.services.count', list.length)}
                  </span>
                  {category.isActive ? null : (
                    <Badge tone="warning">{t('ops.services.categories.inactive')}</Badge>
                  )}
                </h2>
                {canManage && category.isActive && !deleted ? (
                  <Button variant="ghost" size="sm" onClick={() => openAdd(category.id)}>
                    <Plus aria-hidden="true" />
                    {t('ops.services.addHere')}
                  </Button>
                ) : null}
              </div>
              {list.length === 0 ? (
                <p className="px-5 py-4 text-sm text-muted-foreground">{t('ops.services.categoryEmpty')}</p>
              ) : (
                <ul className="divide-y">
                  {list.map((service) => (
                    <li
                      key={service.id}
                      className="grid grid-cols-1 gap-x-6 gap-y-2 px-5 py-3.5 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)] md:items-center"
                    >
                      <div className="min-w-0">
                        <Link
                          href={`/services/${service.id}`}
                          className={cn(
                            'rounded-sm font-medium text-secondary-text hover:underline',
                            focusRing,
                          )}
                        >
                          {pick(service.name, service.nameAr)}
                        </Link>
                        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
                          <span className="ltr-value tabular">{service.code}</span>
                          <span aria-hidden="true">·</span>
                          <span>{t(`ops.services.capability.${service.complianceCapability}.short`)}</span>
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {service.deletedAt ? (
                          <Badge tone="danger">{t('ops.services.flags.deleted')}</Badge>
                        ) : (
                          <Badge tone={service.isActive ? 'success' : 'neutral'}>
                            {t(
                              service.isActive ? 'ops.services.flags.active' : 'ops.services.flags.inactive',
                            )}
                          </Badge>
                        )}
                        {service.isPublic ? (
                          <Badge tone="info">{t('ops.services.flags.public')}</Badge>
                        ) : null}
                        {service.onlineAvailable ? (
                          <Badge tone="brand">{t('ops.services.flags.online')}</Badge>
                        ) : null}
                      </div>
                      <div className="flex items-center justify-between gap-3 md:justify-end md:text-end">
                        {service.price ? (
                          <div className="min-w-0">
                            <p className="tabular font-medium text-foreground">
                              {formatMoney(service.price.serviceFee, service.price.currency)}
                            </p>
                            {Number(service.price.governmentFeeEstimate) > 0 ||
                            Number(service.price.thirdPartyFeeEstimate) > 0 ? (
                              <p className="text-sm text-muted-foreground">
                                {Number(service.price.governmentFeeEstimate) > 0 &&
                                Number(service.price.thirdPartyFeeEstimate) > 0
                                  ? t('ops.services.priceEstimates', {
                                      government: formatMoney(
                                        service.price.governmentFeeEstimate,
                                        service.price.currency,
                                      ),
                                      thirdParty: formatMoney(
                                        service.price.thirdPartyFeeEstimate,
                                        service.price.currency,
                                      ),
                                    })
                                  : Number(service.price.governmentFeeEstimate) > 0
                                    ? t('ops.services.priceEstimateGovernment', {
                                        amount: formatMoney(
                                          service.price.governmentFeeEstimate,
                                          service.price.currency,
                                        ),
                                      })
                                    : t('ops.services.priceEstimateThirdParty', {
                                        amount: formatMoney(
                                          service.price.thirdPartyFeeEstimate,
                                          service.price.currency,
                                        ),
                                      })}
                              </p>
                            ) : (
                              <p className="text-sm text-muted-foreground">
                                {t('ops.services.priceFeeOnly')}
                              </p>
                            )}
                          </div>
                        ) : (
                          <Badge tone="warning">{t('ops.services.noPrice')}</Badge>
                        )}
                        {service.deletedAt && canManage ? (
                          <Button
                            variant="outline"
                            size="sm"
                            loading={busy === `restore-${service.id}`}
                            onClick={() =>
                              void run(
                                `restore-${service.id}`,
                                () => api.client.post(`/services/${service.id}/restore`),
                                {
                                  success: t('ops.services.restored'),
                                  description: t('ops.services.restoredDescription'),
                                  invalidate: [opsKeys.services.all, opsKeys.categories.all],
                                },
                              )
                            }
                          >
                            <RotateCcw aria-hidden="true" />
                            {t('ops.services.restore')}
                          </Button>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ))}
        </div>
      )}

      <AddServiceDialog
        open={dialog === 'add'}
        onOpenChange={(open) => setDialog(open ? 'add' : null)}
        categories={(categories.data ?? []).filter((c) => c.isActive)}
        categoryId={addInCategory}
      />
      <CategoriesDialog
        open={dialog === 'categories'}
        onOpenChange={(open) => setDialog(open ? 'categories' : null)}
      />
      <DocumentTypesDialog
        open={dialog === 'documentTypes'}
        onOpenChange={(open) => setDialog(open ? 'documentTypes' : null)}
      />
      {dialog === 'import' ? <ImportDialog base="/services" kind="services" invalidate={opsKeys.services.all} onClose={() => setDialog(null)} /> : null}
    </>
  );
}

/** Opens the TypEase fee catalogue; shows how many of this centre's services have a fee update waiting. */
function FeeCatalogueButton() {
  const { t } = useI18n();
  const api = useApi();
  const updates = useQuery({
    queryKey: ['authority-fees', 'updates'],
    queryFn: () => api.client.get<unknown[]>('/authority-fees/updates'),
  });
  const waiting = updates.data?.length ?? 0;
  return (
    <Button variant="outline" asChild>
      <Link href="/services/authority-fees">
        <Landmark aria-hidden="true" />
        {t('ops.services.fees.open')}
        {waiting ? <Badge tone="warning">{waiting}</Badge> : null}
      </Link>
    </Button>
  );
}
