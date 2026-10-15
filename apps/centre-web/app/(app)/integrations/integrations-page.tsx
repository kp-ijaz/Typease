'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  Bug, Building2, CreditCard, FileSearch, Landmark, Mail, MessageCircle, MessageSquareText, Plug, Plus, ScrollText, Settings2, Smartphone, Workflow,
} from 'lucide-react';
import type { Page } from '@typease/types';
import {
  Alert, Badge, Button, Card, CardContent, CardFooter, CopyButton, DataTable, PageHeader, RequirePermission, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger, useApi, useI18n,
  type DataTableColumn, type DataTableFilter,
} from '@typease/ui';
import { IntegrationDialog, integrationState } from '@/components/adm/integration-dialog';
import { LoadError } from '@/components/adm/shared';
import type { IntegrationCategory, IntegrationLogRow, IntegrationProvider, IntegrationRow } from '@/components/adm/types';
import { admKeys } from '@/lib/keys/adm';

const ICONS: Record<string, React.ReactNode> = {
  PAYMENT: <CreditCard />, EMAIL: <Mail />, SMS: <MessageSquareText />, WHATSAPP: <MessageCircle />, PUSH: <Smartphone />, OCR: <FileSearch />, MALWARE_SCAN: <Bug />, AUTOMATION: <Workflow />,
  PARTNER: <Building2 />, GOVERNMENT: <Landmark />,
};

export function IntegrationsPage() {
  return (
    <RequirePermission anyOf={['integration.manage']}>
      <Integrations />
    </RequirePermission>
  );
}

function Integrations() {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const tab = useSearchParams().get('tab') === 'logs' ? 'logs' : 'services';
  return (
    <>
      <PageHeader title={t('adm.integrations.title')} description={t('adm.integrations.description')} />
      <Tabs value={tab} onValueChange={(next) => router.replace(next === 'services' ? pathname : `${pathname}?tab=${next}`, { scroll: false })}>
        <TabsList>
          <TabsTrigger value="services">{t('adm.integrations.tabs.services')}</TabsTrigger>
          <TabsTrigger value="logs">{t('adm.integrations.tabs.logs')}</TabsTrigger>
        </TabsList>
        <TabsContent value="services">{tab === 'services' ? <Catalogue /> : null}</TabsContent>
        <TabsContent value="logs">{tab === 'logs' ? <Logs /> : null}</TabsContent>
      </Tabs>
    </>
  );
}

function Catalogue() {
  const { t, has } = useI18n();
  const api = useApi();
  const catalogue = useQuery({ queryKey: admKeys.integrations.catalogue, queryFn: () => api.client.get<IntegrationCategory[]>('/integrations/catalogue') });
  const rows = useQuery({ queryKey: admKeys.integrations.list, queryFn: () => api.client.get<IntegrationRow[]>('/integrations') });
  const [open, setOpen] = React.useState<{ provider: IntegrationProvider; rowId: string | null } | null>(null);

  if (catalogue.isPending || rows.isPending) {
    return (
      <div className="grid gap-4 md:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-48" />
        ))}
      </div>
    );
  }
  if (catalogue.isError || rows.isError) return <LoadError error={catalogue.error ?? rows.error} onRetry={() => void Promise.all([catalogue.refetch(), rows.refetch()])} />;

  const rowOf = (id: string) => rows.data.find((r) => r.id === id) ?? null;
  // Rows whose provider this installation no longer offers are still shown, so they can be removed.
  const unknown = rows.data.filter((r) => !r.known);

  return (
    <div className="space-y-10">
      <Alert tone="info" title={t('adm.integrations.introTitle')}>
        {t('adm.integrations.intro')}
      </Alert>

      {catalogue.data.map((category) => (
        <section key={category.category} aria-labelledby={`cat-${category.category}`}>
          <h2 id={`cat-${category.category}`} className="mb-3 flex items-center gap-2.5 text-lg font-semibold">
            <span aria-hidden="true" className="flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground [&_svg]:size-4">
              {ICONS[category.category] ?? <Plug />}
            </span>
            {has(`adm.integrations.categories.${category.category}`) ? t(`adm.integrations.categories.${category.category}`) : category.label}
          </h2>
          <div className="grid gap-4 md:grid-cols-2">
            {category.providers.map((provider) => {
              const configured = provider.configured.map((c) => rowOf(c.id)).filter((r): r is IntegrationRow => !!r);
              const record = provider.kind === 'AUTHORISATION_RECORD';
              const single = configured[0] ?? null;
              const state = integrationState(record ? null : single);
              return (
                <Card key={provider.provider} className="flex min-w-0 flex-col">
                  <CardContent className="flex-1 space-y-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <h3 className="text-md font-semibold" dir="auto">
                        {provider.name}
                      </h3>
                      <span className="flex flex-wrap gap-1.5">
                        {record ? <Badge tone="neutral">{t('adm.integrations.recordBadge')}</Badge> : <Badge tone={state.tone}>{t(state.labelKey)}</Badge>}
                        {!record && single?.mode === 'TEST' && single.status === 'ACTIVE' ? <Badge tone="warning">{t('adm.integrations.modes.TEST')}</Badge> : null}
                        {!provider.usage.effective ? <Badge tone="warning">{t('adm.integrations.recordedOnly')}</Badge> : null}
                        {!provider.approved ? <Badge tone="danger">{t('adm.integrations.notApproved')}</Badge> : null}
                      </span>
                    </div>
                    <p className="text-base text-muted-foreground" dir="auto">
                      {provider.description}
                    </p>
                    <p className="text-sm text-foreground/80" dir="auto">
                      {provider.usage.note}
                    </p>
                    {!record && single?.webhookUrl ? (
                      <div className="flex items-center gap-1 rounded-md bg-muted px-3 py-1.5">
                        <span className="shrink-0 text-sm text-muted-foreground">{t('adm.integrations.webhook')}</span>
                        <code className="ltr-value min-w-0 flex-1 truncate text-sm">{single.webhookUrl}</code>
                        <CopyButton value={single.webhookUrl} label={t('adm.integrations.copyWebhook')} />
                      </div>
                    ) : null}
                    {record && configured.length ? (
                      <ul className="divide-y rounded-lg border">
                        {configured.map((r) => {
                          const s = integrationState(r);
                          return (
                            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                              <span className="min-w-0 break-words font-medium" dir="auto">
                                {r.name}
                              </span>
                              <span className="flex items-center gap-2">
                                <Badge tone={s.tone}>{t(s.labelKey)}</Badge>
                                <Button variant="subtle" size="sm" onClick={() => setOpen({ provider, rowId: r.id })}>
                                  {t('adm.integrations.manage')}
                                </Button>
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                  </CardContent>
                  <CardFooter>
                    {record ? (
                      <Button variant="subtle" size="sm" disabled={!provider.approved} onClick={() => setOpen({ provider, rowId: null })}>
                        <Plus aria-hidden="true" />
                        {t('adm.integrations.record.add')}
                      </Button>
                    ) : single ? (
                      <Button variant="subtle" size="sm" onClick={() => setOpen({ provider, rowId: single.id })}>
                        <Settings2 aria-hidden="true" />
                        {t('adm.integrations.manage')}
                      </Button>
                    ) : (
                      <Button variant="subtle" size="sm" disabled={!provider.approved} onClick={() => setOpen({ provider, rowId: null })}>
                        <Plus aria-hidden="true" />
                        {t('adm.integrations.setUp')}
                      </Button>
                    )}
                  </CardFooter>
                </Card>
              );
            })}
          </div>
        </section>
      ))}

      {unknown.length ? (
        <section aria-labelledby="cat-unknown">
          <h2 id="cat-unknown" className="mb-3 text-lg font-semibold">
            {t('adm.integrations.unknownTitle')}
          </h2>
          <Card>
            <ul className="divide-y">
              {unknown.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                  <span className="min-w-0">
                    <span className="block font-medium" dir="auto">
                      {r.name}
                    </span>
                    <span className="ltr-value block text-sm text-muted-foreground">
                      {r.category} / {r.provider}
                    </span>
                  </span>
                  <Badge tone="neutral">{t('adm.integrations.unknownBadge')}</Badge>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      ) : null}

      {open ? <IntegrationDialog provider={open.provider} row={open.rowId ? rowOf(open.rowId) : null} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

/** What TypEase did with the integrations (connection tests and calls), with redacted request / response summaries. */
function Logs() {
  const { t, formatDateTime, formatNumber } = useI18n();
  const api = useApi();
  const columns = React.useMemo<Array<DataTableColumn<IntegrationLogRow>>>(
    () => [
      { id: 'time', header: t('adm.integrations.logs.time'), sortField: 'createdAt', mobile: 'title', className: 'whitespace-nowrap tabular', cell: (l) => formatDateTime(l.createdAt) },
      { id: 'provider', header: t('adm.integrations.logs.provider'), cell: (l) => <span className="ltr-value">{`${l.category} / ${l.provider}`}</span> },
      { id: 'operation', header: t('adm.integrations.logs.operation'), cell: (l) => <span className="ltr-value">{l.operation}</span> },
      { id: 'result', header: t('adm.integrations.logs.result'), mobile: 'badge', cell: (l) => <Badge tone={l.success ? 'success' : 'danger'}>{l.success ? t('adm.integrations.logs.ok') : t('adm.integrations.logs.failed')}</Badge> },
      { id: 'duration', header: t('adm.integrations.logs.duration'), align: 'end', className: 'tabular whitespace-nowrap', cell: (l) => (l.durationMs === null ? null : t('adm.integrations.logs.ms', { ms: formatNumber(l.durationMs) })) },
      { id: 'error', header: t('adm.integrations.logs.detail'), cell: (l) => (l.error ? <span className="line-clamp-2 max-w-md whitespace-normal text-sm" dir="auto" title={l.error}>{l.error}</span> : l.statusCode ? <span className="tabular text-sm text-muted-foreground">{l.statusCode}</span> : null) },
    ],
    [t, formatDateTime, formatNumber],
  );
  const filters = React.useMemo<DataTableFilter[]>(
    () => [
      { id: 'success', type: 'select', label: t('adm.integrations.logs.result'), options: [{ value: 'true', label: t('adm.integrations.logs.ok') }, { value: 'false', label: t('adm.integrations.logs.failed') }] },
    ],
    [t],
  );
  return (
    <DataTable<IntegrationLogRow>
      caption={t('adm.integrations.tabs.logs')}
      queryKey={admKeys.integrations.logs}
      queryFn={(params, signal) => api.client.get<Page<IntegrationLogRow>>('/integrations/logs', { query: params, signal })}
      columns={columns}
      rowKey={(l) => l.id}
      filters={filters}
      searchable={false}
      defaultSort="createdAt:desc"
      empty={{ icon: <ScrollText />, title: t('adm.integrations.logs.emptyTitle'), description: t('adm.integrations.logs.emptyText') }}
    />
  );
}
