'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Download, Eye, FileX2, Pencil, RotateCcw, Scale, ShieldAlert, Trash2 } from 'lucide-react';
import { documentPreviewLink, isApiError } from '@typease/api-client';
import {
  Alert, Badge, Button, Card, ConfirmDialog, CopyButton, DescriptionList, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState, FileViewer, PageHeader,
  RequirePermission, StatusBadge, Tabs, TabsContent, TabsList, TabsTrigger, useApi, useApiClient, useErrorMessage, useI18n, useSession, useToast,
} from '@typease/ui';
import { useDocumentTypes } from '@/components/pickers';
import { AccessLogCard } from '@/components/people/documents/access-log';
import { AiPanel } from '@/components/people/documents/ai-panel';
import { DocumentStatusChips, ExpiryCell, downloadDocument, useDocumentTypeName } from '@/components/people/documents/doc-utils';
import { EditDocumentDialog, LegalHoldDialog } from '@/components/people/documents/edit-dialogs';
import { SharesCard } from '@/components/people/documents/shares-card';
import { VerificationCard } from '@/components/people/documents/verification-card';
import { VersionsCard } from '@/components/people/documents/versions-card';
import { CustomerNameCell, ActiveTabInView, DetailSkeleton, LoadError, Ltr, RecordLink, Section, isNotFound, useStaffNames, useUrlTab } from '@/components/people/shared';
import type { CorporateAccountDetail, DocumentDetail } from '@/components/people/types';
import { peopleKeys } from '@/lib/keys/people';

type TabId = 'details' | 'assistant' | 'sharing' | 'log';
const BLOCKING = ['LEGAL_HOLD', 'DOCUMENT_IN_USE', 'RETENTION_ACTIVE'];

export function DocumentDetailPage() {
  return (
    <RequirePermission anyOf={['document.read']}>
      <DocumentDetailView />
    </RequirePermission>
  );
}

function DocumentDetailView() {
  const { id } = useParams<{ id: string }>();
  const { t, has, formatDate, formatDateTime, formatFileSize } = useI18n();
  const api = useApi();
  const client = useApiClient();
  const session = useSession();
  const toasts = useToast();
  const describe = useErrorMessage();
  const queryClient = useQueryClient();
  const typeName = useDocumentTypeName();
  const types = useDocumentTypes();
  const staffName = useStaffNames();

  const [previewing, setPreviewing] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [holding, setHolding] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [deleteError, setDeleteError] = React.useState<{ code: string; message: string } | null>(null);

  const showAssistant = session.hasAnyPermission(['ocr.run', 'ocr.review']);
  const showSharing = session.hasPermission('document.share');
  const showLog = session.hasAnyPermission(['audit.read', 'privacy.manage']);
  const tabs = React.useMemo<TabId[]>(() => ['details', ...(showAssistant ? (['assistant'] as const) : []), ...(showSharing ? (['sharing'] as const) : []), ...(showLog ? (['log'] as const) : [])], [showAssistant, showSharing, showLog]);
  const [tab, setTab] = useUrlTab<TabId>(['details', 'assistant', 'sharing', 'log'], 'details');

  // Every read of a document is written to its access log, so it is not re-read just because the window got focus.
  const query = useQuery({ queryKey: peopleKeys.documents.detail(id), queryFn: () => api.client.get<DocumentDetail>(`/documents/${id}`), retry: (count, error) => !isNotFound(error) && count < 2, refetchOnWindowFocus: false, staleTime: 30_000 });
  const doc = query.data;
  const company = useQuery({
    queryKey: peopleKeys.corporate.detail(doc?.corporateAccountId ?? ''),
    queryFn: () => api.client.get<CorporateAccountDetail>(`/corporate-accounts/${doc?.corporateAccountId}`),
    enabled: !!doc?.corporateAccountId && session.hasPermission('corporate.read'),
    staleTime: 60_000,
    retry: false,
  });
  const request = useQuery({
    queryKey: ['requests', 'number', doc?.requestId],
    queryFn: () => api.client.get<{ id: string; requestNo: string }>(`/requests/${doc?.requestId}`),
    enabled: !!doc?.requestId,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: peopleKeys.documents.all });
  const rescan = useMutation({
    mutationFn: () => api.client.post(`/documents/${id}/rescan`),
    onSuccess: async () => {
      toasts.success(t('people.documents.scanAgainDone'));
      await refresh();
    },
    onError: (error) => toasts.error(error),
  });
  const restore = useMutation({
    mutationFn: () => api.client.post(`/documents/${id}/restore`),
    onSuccess: async () => {
      toasts.success(t('people.documents.delete.restored'));
      await refresh();
    },
    onError: (error) => toasts.error(error),
  });

  const crumbs = [{ label: t('nav.documents'), href: '/documents' }];
  if (query.isPending) return <DetailSkeleton />;
  if (query.isError || !doc) {
    return (
      <>
        <PageHeader title={t('people.documents.pageTitle')} breadcrumbs={crumbs} />
        {isNotFound(query.error) ? (
          <Card>
            <EmptyState
              size="page"
              icon={<FileX2 />}
              title={t('people.documents.notFoundTitle')}
              description={t('people.documents.notFoundText')}
              action={
                <Button asChild>
                  <Link href="/documents">{t('people.documents.backToList')}</Link>
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

  const version = doc.currentVersion;
  const quarantined = doc.status === 'QUARANTINED';
  const deleted = doc.status === 'DELETED';
  const canOpen = doc.downloadable && !quarantined && !deleted;
  const canEdit = session.hasAnyPermission(['document.upload', 'document.verify']) && !deleted && !quarantined;
  const canDelete = session.hasPermission('document.delete');
  const canHold = session.hasPermission('privacy.manage') && !deleted;
  const hasExpiry = !!types.data?.find((d) => d.key === doc.documentTypeKey)?.hasExpiry;
  const current = tabs.includes(tab) ? tab : 'details';

  const download = () => void downloadDocument(client, doc.id).catch((error) => toasts.error(error));
  const remove = async () => {
    setDeleteError(null);
    try {
      await api.client.delete(`/documents/${doc.id}`);
      toasts.success(t('people.documents.delete.done'), doc.title);
      await refresh();
    } catch (error) {
      // Legal hold, retention period or an open request: the API's reason is shown in the dialog.
      setDeleteError({ code: isApiError(error) ? error.code : 'ERROR', message: describe(error) });
      throw error;
    }
  };

  const uploadedBy = ['STAFF', 'CUSTOMER', 'CORPORATE', 'SYSTEM'].includes(doc.uploadedByType) ? doc.uploadedByType : 'OTHER';

  return (
    <>
      <PageHeader
        breadcrumbs={crumbs}
        title={<span dir="auto">{doc.title}</span>}
        meta={
          <>
            <DocumentStatusChips document={doc} />
            {doc.isCompletionDocument ? <Badge tone="brand">{t('people.documents.completion')}</Badge> : null}
          </>
        }
        description={typeName(doc.documentTypeKey)}
        action={
          canOpen ? (
            <Button variant="accent" onClick={() => setPreviewing(true)}>
              <Eye aria-hidden="true" />
              {t('people.documents.preview')}
            </Button>
          ) : null
        }
        secondary={
          <>
            {canOpen ? (
              <Button variant="outline" onClick={download}>
                <Download aria-hidden="true" />
                {t('common.download')}
              </Button>
            ) : null}
            {canEdit || canDelete || canHold ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline">
                    {t('people.common.more')}
                    <ChevronDown aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  {canEdit ? (
                    <DropdownMenuItem onSelect={() => setEditing(true)}>
                      <Pencil aria-hidden="true" />
                      {t('people.documents.edit.action')}
                    </DropdownMenuItem>
                  ) : null}
                  {canHold ? (
                    <DropdownMenuItem onSelect={() => setHolding(true)}>
                      <Scale aria-hidden="true" />
                      {doc.legalHold ? t('people.documents.legalHold.release') : t('people.documents.legalHold.set')}
                    </DropdownMenuItem>
                  ) : null}
                  {canDelete ? (
                    <>
                      {canEdit || canHold ? <DropdownMenuSeparator /> : null}
                      {deleted ? (
                        <DropdownMenuItem onSelect={() => restore.mutate()}>
                          <RotateCcw aria-hidden="true" />
                          {t('people.documents.delete.restore')}
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem
                          destructive
                          onSelect={() => {
                            setDeleteError(null);
                            setDeleting(true);
                          }}
                        >
                          <Trash2 aria-hidden="true" />
                          {t('people.documents.delete.action')}
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

      {quarantined ? (
        <Alert tone="danger" className="mb-5" title={t('people.documents.quarantine.title')}>
          <p>{t('people.documents.quarantine.text')}</p>
          {version?.scanDetail ? (
            <p className="mt-1.5">
              {t('people.documents.quarantine.finding')} <Ltr className="font-medium">{version.scanDetail}</Ltr>
              {version.scanEngine ? <span className="text-sm text-muted-foreground"> ({version.scanEngine})</span> : null}
            </p>
          ) : null}
          <p className="mt-1.5">{t('people.documents.quarantine.next')}</p>
        </Alert>
      ) : null}
      {doc.status === 'PENDING_SCAN' || doc.status === 'PENDING_UPLOAD' ? (
        <Alert
          tone="info"
          className="mb-5"
          title={doc.status === 'PENDING_SCAN' ? t('people.documents.pendingScan.title') : t('people.documents.pendingUpload.title')}
          action={
            doc.status === 'PENDING_SCAN' && session.hasPermission('document.verify') && version && ['ERROR', 'PENDING'].includes(version.scanStatus) ? (
              <Button size="sm" variant="outline" onClick={() => rescan.mutate()} loading={rescan.isPending} loadingText={t('common.loading')}>
                {t('people.documents.scanAgain')}
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => void query.refetch()} loading={query.isFetching} loadingText={t('common.loading')}>
                {t('common.refresh')}
              </Button>
            )
          }
        >
          {doc.status === 'PENDING_SCAN' ? (version?.scanStatus === 'ERROR' ? t('people.documents.pendingScan.error') : t('people.documents.pendingScan.text')) : t('people.documents.pendingUpload.text')}
        </Alert>
      ) : null}
      {deleted ? (
        <Alert
          tone="warning"
          className="mb-5"
          title={t('people.documents.delete.deletedTitle')}
          action={
            canDelete ? (
              <Button size="sm" variant="outline" onClick={() => restore.mutate()} loading={restore.isPending} loadingText={t('common.loading')}>
                <RotateCcw aria-hidden="true" />
                {t('people.documents.delete.restore')}
              </Button>
            ) : undefined
          }
        >
          {doc.purgeAfter ? t('people.documents.delete.deletedText', { date: formatDate(doc.purgeAfter) }) : t('people.documents.delete.deletedTextNoDate')}
        </Alert>
      ) : null}
      {doc.legalHold ? (
        <Alert tone="warning" className="mb-5" title={t('people.documents.legalHold.bannerTitle')}>
          {t('people.documents.legalHold.bannerText')}
        </Alert>
      ) : null}

      <Tabs value={current} onValueChange={(next) => setTab(next as TabId)}>
        <ActiveTabInView value={current} />
        {tabs.length > 1 ? (
          <TabsList aria-label={t('people.documents.tabs.label')}>
            {tabs.map((tabId) => (
              <TabsTrigger key={tabId} value={tabId}>
                {t(`people.documents.tabs.${tabId}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        ) : null}

        <TabsContent value="details">
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
            <div className="min-w-0 space-y-6">
              <Section title={t('people.documents.details.title')}>
                <DescriptionList
                  columns={2}
                  items={[
                    { label: t('people.documents.fields.type'), value: typeName(doc.documentTypeKey) },
                    { label: t('people.documents.fields.category'), value: doc.category ? <span dir="auto">{doc.category}</span> : null },
                    {
                      label: t('people.documents.columns.owner'),
                      value: doc.customerId ? (
                        <CustomerNameCell id={doc.customerId} />
                      ) : doc.corporateAccountId ? (
                        company.data ? (
                          <RecordLink href={`/corporate/${doc.corporateAccountId}`}>{company.data.companyName}</RecordLink>
                        ) : (
                          t('people.documents.companyFile')
                        )
                      ) : null,
                    },
                    {
                      label: t('people.documents.fields.request'),
                      value: doc.requestId ? <RecordLink href={`/requests/${doc.requestId}`} className="tabular">{request.data?.requestNo ?? t('people.documents.openRequest')}</RecordLink> : null,
                    },
                    { label: t('people.documents.fields.issuedDate'), value: doc.issuedDate ? formatDate(doc.issuedDate) : null },
                    { label: t('people.documents.fields.expiryDate'), value: doc.expiryDate ? <ExpiryCell document={doc} /> : null },
                    { label: t('people.documents.fields.customerVisible'), value: doc.customerVisible === false ? t('people.documents.visibility.hidden') : t('people.documents.visibility.visible') },
                    { label: t('people.documents.columns.uploaded'), value: `${formatDateTime(doc.createdAt)} · ${staffName(doc.uploadedById) ?? t(`people.documents.uploadedBy.${uploadedBy}`)}` },
                    ...(doc.retentionUntil ? [{ label: t('people.documents.fields.retentionUntil'), value: formatDate(doc.retentionUntil) }] : []),
                  ]}
                />
                {doc.checklist.length ? (
                  <div className="mt-5 border-t pt-4">
                    <h3 className="text-sm font-semibold text-muted-foreground">{t('people.documents.details.checklist')}</h3>
                    <ul className="mt-2 space-y-1.5">
                      {doc.checklist.map((line) => (
                        <li key={line.id} className="flex flex-wrap items-center justify-between gap-2 text-base">
                          <RecordLink href={`/requests/${line.requestId}`} className="font-normal">
                            <span dir="auto">{line.label}</span>
                          </RecordLink>
                          <StatusBadge kind="checklist" status={line.status} />
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </Section>

              {version ? (
                <Section title={t('people.documents.details.file')}>
                  <DescriptionList
                    columns={2}
                    items={[
                      { label: t('people.documents.fields.filename'), value: <span dir="auto" className="break-all">{version.filename}</span> },
                      { label: t('people.documents.fields.size'), value: `${version.mime.split('/')[1]?.toUpperCase() ?? version.mime} · ${formatFileSize(version.sizeBytes)}` },
                      {
                        label: t('people.documents.fields.scan'),
                        value: (
                          <>
                            {has(`people.documents.scan.${version.scanStatus}`) ? t(`people.documents.scan.${version.scanStatus}`) : version.scanStatus}
                            {version.scannedAt ? <span className="block text-sm text-muted-foreground">{formatDateTime(version.scannedAt)}</span> : null}
                          </>
                        ),
                      },
                      {
                        label: t('people.documents.fields.fingerprint'),
                        value: version.sha256 ? (
                          <span className="inline-flex items-center gap-1">
                            <Ltr className="text-sm" >{`${version.sha256.slice(0, 12)}…`}</Ltr>
                            <CopyButton value={version.sha256} label={t('people.documents.copyFingerprint')} />
                          </span>
                        ) : null,
                      },
                    ]}
                  />
                  {quarantined ? null : (
                    <p className="mt-4 flex items-start gap-2 text-sm text-muted-foreground">
                      <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                      {t('people.documents.details.linksNote')}
                    </p>
                  )}
                </Section>
              ) : null}

              <VersionsCard document={doc} />
            </div>
            <div className="min-w-0 space-y-6">
              <VerificationCard document={doc} hasExpiry={hasExpiry} />
            </div>
          </div>
        </TabsContent>

        {showAssistant ? (
          <TabsContent value="assistant">
            <AiPanel document={doc} />
          </TabsContent>
        ) : null}
        {showSharing ? (
          <TabsContent value="sharing">
            <SharesCard document={doc} />
          </TabsContent>
        ) : null}
        {showLog ? (
          <TabsContent value="log">
            <AccessLogCard documentId={doc.id} />
          </TabsContent>
        ) : null}
      </Tabs>

      {previewing ? (
        <FileViewer
          open
          onOpenChange={setPreviewing}
          title={doc.title}
          getSource={async () => {
            const link = await documentPreviewLink(client, doc.id);
            return { url: link.url, mime: link.mime, filename: link.filename };
          }}
          onDownload={download}
        />
      ) : null}
      {editing ? <EditDocumentDialog document={doc} open onOpenChange={setEditing} /> : null}
      {holding ? <LegalHoldDialog document={doc} open onOpenChange={setHolding} /> : null}
      <ConfirmDialog open={deleting} onOpenChange={setDeleting} title={t('people.documents.delete.title')} description={t('people.documents.delete.text')} confirmLabel={t('people.documents.delete.action')} onConfirm={remove}>
        {deleteError ? (
          <Alert tone="danger" live title={BLOCKING.includes(deleteError.code) ? t(`people.documents.delete.blocked.${deleteError.code}`) : undefined}>
            {deleteError.message}
          </Alert>
        ) : null}
      </ConfirmDialog>
    </>
  );
}
