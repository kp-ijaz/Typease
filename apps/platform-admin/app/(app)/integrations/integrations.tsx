'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, FileCheck2, Plug, ShieldQuestion } from 'lucide-react';
import {
  Alert, Badge, Button, Card, DataTable, DescriptionList, PageHeader, RequirePermission, Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, StatusBadge, Switch, Table,
  TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow, Tabs, TabsContent, TabsList, TabsTrigger, cn, useI18n, useSession, useToast, type DataTableColumn, type DataTableFilter, type Tone,
} from '@typease/ui';
import { CentreCell, Code, ConfirmAction, ConfirmReasonDialog, LoadError, RowsSkeleton, Segmented, useUrlState } from '@/components/shared';
import { usePlatformApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import type { ApprovedProviders, AuthorisationRecord, AuthorisationState } from '@/lib/types';
import { SystemProvidersPanel } from './system-providers';

const STATES: AuthorisationState[] = ['PENDING', 'VERIFIED', 'REJECTED'];
const STATE_TONE: Record<AuthorisationState, Tone> = { PENDING: 'warning', VERIFIED: 'success', REJECTED: 'danger' };

export function Integrations() {
  return (
    <RequirePermission anyOf={['platform.integrations.manage', 'platform.metrics.read']}>
      <IntegrationsScreen />
    </RequirePermission>
  );
}

/**
 * Integrations from TypEase's side: what the platform itself is configured to use (first
 * tab, from the environment of the API), the authorisation records centres submit for
 * review, and which providers centres may set up at all. Nothing on this page says that a
 * centre's provider is connected: connections and credentials belong to each centre and
 * are not readable here.
 */
function IntegrationsScreen() {
  const { t } = useI18n();
  const session = useSession();
  const may = { system: session.hasPermission('platform.metrics.read'), manage: session.hasPermission('platform.integrations.manage') };
  const tabs = [...(may.system ? ['system'] : []), ...(may.manage ? ['reviews', 'providers'] : [])];
  const [tab, setTab] = useUrlState('tab', tabs[0] ?? 'system');
  const current = tabs.includes(tab) ? tab : tabs[0];
  return (
    <>
      <PageHeader title={t('nav.integrations')} description={t('integ.description')} />
      <Tabs value={current} onValueChange={setTab}>
        <TabsList>
          {tabs.map((value) => (
            <TabsTrigger key={value} value={value}>
              {t(`integ.tabs.${value}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        {may.system ? <TabsContent value="system">{current === 'system' ? <SystemProvidersPanel /> : null}</TabsContent> : null}
        {may.manage ? <TabsContent value="reviews">{current === 'reviews' ? <Reviews /> : null}</TabsContent> : null}
        {may.manage ? <TabsContent value="providers">{current === 'providers' ? <Providers /> : null}</TabsContent> : null}
      </Tabs>
    </>
  );
}

// ---------------------------------------------------------------- authorisation reviews

function StateBadge({ state }: { state: AuthorisationState }) {
  const { t } = useI18n();
  return <Badge tone={STATE_TONE[state]}>{t(`integ.states.${state}`)}</Badge>;
}

function Reviews() {
  const { t, formatDate } = useI18n();
  const api = usePlatformApi();
  const [state, setState] = useUrlState('state', 'PENDING');
  const current = (STATES as string[]).includes(state) ? (state as AuthorisationState) : 'PENDING';
  const [open, setOpen] = React.useState<AuthorisationRecord | null>(null);

  const columns = React.useMemo<Array<DataTableColumn<AuthorisationRecord>>>(
    () => [
      {
        id: 'name',
        header: t('integ.columns.record'),
        mobile: 'title',
        className: 'min-w-56',
        cell: (r) => (
          <>
            <bdi className="block">{r.name}</bdi>
            <span className="block text-sm font-normal text-muted-foreground">{t(`integ.kinds.${r.category}`)}</span>
          </>
        ),
      },
      { id: 'centre', header: t('pc.centre'), className: 'min-w-44', cell: (r) => <CentreCell centre={r.centre} /> },
      { id: 'submitted', header: t('integ.columns.submitted'), className: 'whitespace-nowrap tabular', cell: (r) => formatDate(r.submittedAt) },
      { id: 'state', header: t('integ.columns.review'), mobile: 'badge', cell: (r) => <StateBadge state={r.state} /> },
      {
        id: 'reviewed',
        header: t('integ.columns.reviewed'),
        cell: (r) =>
          r.reviewedAt || r.verifiedAt ? (
            <>
              <span className="tabular block">{formatDate(r.reviewedAt ?? r.verifiedAt)}</span>
              {r.verifiedByName ? <bdi className="block text-sm text-muted-foreground">{r.verifiedByName}</bdi> : null}
            </>
          ) : null,
      },
    ],
    [t, formatDate],
  );
  const filters = React.useMemo<DataTableFilter[]>(
    () => [{ id: 'category', type: 'select', label: t('integ.columns.kind'), options: (['GOVERNMENT', 'PARTNER'] as const).map((c) => ({ value: c, label: t(`integ.kinds.${c}`) })) }],
    [t],
  );
  const fixed = React.useMemo(() => ({ state: current }), [current]);

  return (
    <>
      <Segmented className="mb-3" label={t('integ.columns.review')} value={current} onChange={setState} options={STATES.map((value) => ({ value, label: t(`integ.filters.${value}`) }))} />
      <DataTable<AuthorisationRecord>
        caption={t('integ.tabs.reviews')}
        queryKey={keys.integrations.authorisations}
        queryFn={(params, signal) => api.integrations.authorisations(params, signal)}
        fixedParams={fixed}
        columns={columns}
        rowKey={(r) => r.id}
        onRowClick={setOpen}
        filters={filters}
        searchPlaceholder={t('integ.searchPlaceholder')}
        empty={{ icon: <FileCheck2 />, title: t(`integ.empty.${current}`), description: t('integ.emptyText') }}
      />
      <p className="mt-3 text-sm text-muted-foreground">{t('integ.reviewNote')}</p>
      <RecordSheet record={open} onClose={() => setOpen(null)} />
    </>
  );
}

/** One authorisation record as the reviewer sees it: the record and the centre's name, nothing else of the centre. */
function RecordSheet({ record, onClose }: { record: AuthorisationRecord | null; onClose: () => void }) {
  const { t, formatDate, formatDateTime } = useI18n();
  const api = usePlatformApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const [action, setAction] = React.useState<'verify' | 'reject' | null>(null);
  const refresh = () => Promise.all([keys.integrations.all, keys.audit.all].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  const show = (value: unknown) => (value === null || value === undefined || value === '' ? null : typeof value === 'object' ? JSON.stringify(value) : String(value));

  return (
    <>
      <Sheet open={!!record} onOpenChange={(open) => !open && onClose()}>
        <SheetContent side="end" className="w-[min(38rem,96vw)]">
          <SheetHeader>
            <SheetTitle>
              <bdi>{record?.name}</bdi>
            </SheetTitle>
            <SheetDescription>{record ? t(`integ.kinds.${record.category}`) : ''}</SheetDescription>
          </SheetHeader>
          <SheetBody className="space-y-6">
            {record ? (
              <>
                <DescriptionList
                  columns={2}
                  items={[
                    { label: t('pc.centre'), value: <CentreCell centre={record.centre} /> },
                    { label: t('integ.columns.review'), value: <StateBadge state={record.state} /> },
                    { label: t('integ.columns.submitted'), value: record.submittedAt ? <span className="tabular">{formatDateTime(record.submittedAt)}</span> : null },
                    { label: t('integ.sheet.usable'), value: <StatusBadge kind="integration" status={record.status} /> },
                  ]}
                />

                <section aria-labelledby="record-fields">
                  <h3 id="record-fields" className="text-md font-semibold text-foreground">
                    {t('integ.sheet.declared')}
                  </h3>
                  <p className="mb-3 mt-1 text-sm text-muted-foreground">{t('integ.sheet.declaredText')}</p>
                  <dl className="divide-y rounded-lg border">
                    {record.fields.map((field) => (
                      <div key={field.key} className="grid gap-1 px-4 py-2.5 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:gap-4">
                        <dt className="text-sm text-muted-foreground">
                          <bdi>{field.label}</bdi>
                          {field.keyField ? <span className="ms-1.5 text-xs text-warning-text">{t('integ.sheet.keyField')}</span> : null}
                        </dt>
                        <dd className="break-words text-base text-foreground" dir="auto">
                          {show(field.value) ?? <span className="text-muted-foreground">–</span>}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>

                <section aria-labelledby="record-note">
                  <h3 id="record-note" className="mb-1.5 text-md font-semibold text-foreground">
                    {t('integ.sheet.note')}
                  </h3>
                  <p className="whitespace-pre-wrap text-base text-foreground" dir="auto">
                    {record.authorisationNote ?? '–'}
                  </p>
                </section>

                <Alert tone={record.evidenceDocumentId ? 'info' : 'warning'} title={t(record.evidenceDocumentId ? 'integ.sheet.evidenceYes' : 'integ.sheet.evidenceNo')}>
                  {t(record.evidenceDocumentId ? 'integ.sheet.evidenceYesText' : 'integ.sheet.evidenceNoText')}
                </Alert>

                {record.reviewNote || record.verifiedAt ? (
                  <section aria-labelledby="record-review">
                    <h3 id="record-review" className="mb-1.5 text-md font-semibold text-foreground">
                      {t('integ.sheet.lastReview')}
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      {record.state === 'VERIFIED' && record.verifiedAt ? t('integ.sheet.verifiedOn', { date: formatDate(record.verifiedAt), name: record.verifiedByName ?? t('pc.system') }) : record.reviewedAt ? t('integ.sheet.reviewedOn', { date: formatDate(record.reviewedAt) }) : null}
                    </p>
                    {record.reviewNote ? (
                      <p className="mt-1 whitespace-pre-wrap text-base text-foreground" dir="auto">
                        {record.reviewNote}
                      </p>
                    ) : null}
                  </section>
                ) : null}
              </>
            ) : null}
          </SheetBody>
          {record ? (
            <SheetFooter>
              {record.state !== 'REJECTED' ? (
                <Button variant="destructive-outline" onClick={() => setAction('reject')}>
                  {t(record.state === 'VERIFIED' ? 'integ.withdraw.action' : 'integ.reject.action')}
                </Button>
              ) : null}
              {record.state !== 'VERIFIED' ? (
                <Button onClick={() => setAction('verify')}>
                  <BadgeCheck aria-hidden="true" />
                  {t('integ.verify.action')}
                </Button>
              ) : null}
            </SheetFooter>
          ) : null}
        </SheetContent>
      </Sheet>

      <ConfirmReasonDialog
        open={action === 'verify' && !!record}
        onOpenChange={(open) => !open && setAction(null)}
        tone="default"
        required={false}
        minLength={1}
        maxLength={1000}
        title={t('integ.verify.title', { name: record?.name ?? '' })}
        description={t('integ.verify.text', { centre: record?.centre.name ?? '' })}
        confirmLabel={t('integ.verify.action')}
        label={t('integ.verify.note')}
        hint={t('integ.noteHint')}
        onConfirm={async (note) => {
          await api.integrations.verify(record!.id, note ? { note } : {});
          await refresh();
          toasts.success(t('integ.verify.done', { name: record!.name }));
          onClose();
        }}
      />
      <ConfirmReasonDialog
        open={action === 'reject' && !!record}
        onOpenChange={(open) => !open && setAction(null)}
        maxLength={1000}
        title={t(record?.state === 'VERIFIED' ? 'integ.withdraw.title' : 'integ.reject.title', { name: record?.name ?? '' })}
        description={t(record?.state === 'VERIFIED' ? 'integ.withdraw.text' : 'integ.reject.text', { centre: record?.centre.name ?? '' })}
        confirmLabel={t(record?.state === 'VERIFIED' ? 'integ.withdraw.action' : 'integ.reject.action')}
        label={t('pc.reason')}
        hint={t('integ.noteHint')}
        onConfirm={async (note) => {
          const withdrawn = record!.state === 'VERIFIED';
          await api.integrations.reject(record!.id, { note });
          await refresh();
          toasts.success(t(withdrawn ? 'integ.withdraw.done' : 'integ.reject.done', { name: record!.name }));
          onClose();
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------- approved providers

function Providers() {
  const { t, tn, has } = useI18n();
  const api = usePlatformApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const providers = useQuery({ queryKey: keys.integrations.providers, queryFn: ({ signal }) => api.integrations.approvedProviders(signal) });
  const [approved, setApproved] = React.useState<Set<string> | null>(null);
  const [confirm, setConfirm] = React.useState<'save' | 'open' | null>(null);
  const data = providers.data;
  React.useEffect(() => {
    if (data) setApproved(new Set(data.providers.filter((p) => p.approved).map((p) => p.code)));
  }, [data]);

  if (providers.isPending || !approved) return <Card><RowsSkeleton rows={8} /></Card>;
  if (providers.isError || !data) return <LoadError lead={t('integ.providers.loadError')} error={providers.error} onRetry={() => void providers.refetch()} />;

  const saved = new Set(data.providers.filter((p) => p.approved).map((p) => p.code));
  const removed = data.providers.filter((p) => saved.has(p.code) && !approved.has(p.code));
  const added = data.providers.filter((p) => !saved.has(p.code) && approved.has(p.code));
  const dirty = removed.length + added.length > 0;
  const groups = [...new Set(data.providers.map((p) => p.category))];
  const category = (id: string) => (has(`integ.categories.${id}`) ? t(`integ.categories.${id}`) : id);

  const apply = async (list: string[] | null) => {
    const result: ApprovedProviders = await api.integrations.setApprovedProviders(list);
    queryClient.setQueryData(keys.integrations.providers, result);
    await Promise.all([keys.settings.all, keys.audit.all].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
    toasts.success(t('integ.providers.saved'), result.switchedOff ? tn('integ.providers.switchedOff', result.switchedOff) : undefined);
  };

  return (
    <>
      <Alert tone={data.restricted ? 'warning' : 'info'} className="mb-4" title={data.restricted ? t('integ.providers.restrictedTitle', { approved: saved.size, total: data.providers.length }) : t('integ.providers.openTitle')}>
        {t('integ.providers.meaning')}
      </Alert>

      <Card className="overflow-hidden">
        <Table>
          <TableCaption className="sr-only">{t('integ.tabs.providers')}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>{t('integ.providers.provider')}</TableHead>
              <TableHead className="hidden sm:table-cell">{t('integ.columns.kind')}</TableHead>
              <TableHead className="sm:w-56">{t('integ.providers.allowed')}</TableHead>
            </TableRow>
          </TableHeader>
          {groups.map((group) => (
            <TableBody key={group}>
              <TableRow className="bg-muted/50 hover:bg-muted/50">
                <TableHead scope="colgroup" colSpan={3} className="h-9 text-sm font-semibold text-foreground">
                  {category(group)}
                </TableHead>
              </TableRow>
              {data.providers
                .filter((p) => p.category === group)
                .map((p) => (
                  <TableRow key={p.code}>
                    <TableCell className="min-w-40 sm:min-w-56">
                      <bdi className="block font-medium text-foreground">{p.name}</bdi>
                      <Code className="mt-1 inline-block">{p.code}</Code>
                      {/* On a phone the kind moves under the name, so that the switch stays on the screen. */}
                      <span className="mt-1 block text-sm text-muted-foreground sm:hidden">{t(p.kind === 'CONNECTION' ? 'integ.providers.connection' : 'integ.providers.record')}</span>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">{t(p.kind === 'CONNECTION' ? 'integ.providers.connection' : 'integ.providers.record')}</TableCell>
                    <TableCell>
                      <span className="flex items-center gap-3">
                        <Switch
                          aria-label={t('integ.providers.allowLabel', { name: p.name })}
                          checked={approved.has(p.code)}
                          onCheckedChange={(on) =>
                            setApproved((current) => {
                              const next = new Set(current);
                              if (on) next.add(p.code);
                              else next.delete(p.code);
                              return next;
                            })
                          }
                        />
                        <span className={cn('hidden text-base sm:inline', approved.has(p.code) ? 'text-foreground' : 'text-muted-foreground')}>{approved.has(p.code) ? t('integ.providers.yes') : t('integ.providers.no')}</span>
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          ))}
        </Table>
      </Card>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          <ShieldQuestion className="me-1.5 inline size-4 align-text-bottom" aria-hidden="true" />
          {t('integ.providers.note')}
        </p>
        <div className="flex flex-wrap gap-2">
          {data.restricted ? (
            <Button variant="outline" onClick={() => setConfirm('open')}>
              {t('integ.providers.allowAll')}
            </Button>
          ) : null}
          <Button disabled={!dirty} onClick={() => setConfirm('save')}>
            <Plug aria-hidden="true" />
            {t('common.saveChanges')}
          </Button>
        </div>
      </div>

      <ConfirmAction
        open={confirm === 'save'}
        onOpenChange={(open) => !open && setConfirm(null)}
        tone={removed.length ? 'destructive' : 'default'}
        title={t('integ.providers.saveTitle')}
        description={removed.length ? t('integ.providers.saveTextRemoved') : t('integ.providers.saveText')}
        confirmLabel={t('common.saveChanges')}
        onConfirm={() => apply([...approved])}
      >
        {removed.length ? (
          <div>
            <p className="text-sm font-medium text-foreground">{t('integ.providers.noLonger')}</p>
            <ul className="mt-1 list-disc space-y-0.5 ps-5 text-sm text-foreground/90">
              {removed.map((p) => (
                <li key={p.code}>
                  <bdi>{p.name}</bdi>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </ConfirmAction>
      <ConfirmAction open={confirm === 'open'} onOpenChange={(open) => !open && setConfirm(null)} tone="default" title={t('integ.providers.allowAllTitle')} description={t('integ.providers.allowAllText')} confirmLabel={t('integ.providers.allowAll')} onConfirm={() => apply(null)} />
    </>
  );
}
