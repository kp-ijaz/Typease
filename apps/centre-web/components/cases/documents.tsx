'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, CheckCircle2, CircleDashed, Download, Eye, FileCheck2, FilePlus2, FileX2, History, Link2, MoreHorizontal, ScanText, ShieldCheck, Unlink, Upload, XCircle,
} from 'lucide-react';
import { documentDownloadLink, documentPreviewLink, uploadDocument } from '@typease/api-client';
import { addChecklistItemSchema, documentVerifySchema, requestReasonSchema } from '@typease/validation';
import {
  Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, ChoiceLabel, DatePicker, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader,
  DialogTitle, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState, FileUpload, FileViewer, Form, FormError, FormField,
  Input, RadioGroup, RadioGroupItem, Select, Skeleton, StatusBadge, Switch, Textarea, cn, useApiClient, useI18n, useSession, useToast, useZodForm,
} from '@typease/ui';
import { DocumentTypePicker, useDocumentTypes } from '@/components/pickers';
import { caseKeys } from '@/lib/keys/cases';
import { useCasesApi } from './api';
import { OcrDialog } from './ocr';
import { isClosed, useAiAssistant, useCaseError } from './shared';
import type { AssistItem, CaseChecklistItem, CaseView, DocumentRow } from './types';

const ACCEPT = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const ACCEPT_LABEL = 'PDF, JPG, PNG';

type LineDialog =
  | { type: 'verify'; line: CaseChecklistItem }
  | { type: 'waive'; line: CaseChecklistItem }
  | { type: 'versions'; documentId: string; title: string }
  | { type: 'ocr'; documentId: string; title: string }
  | { type: 'add'; kind?: 'INPUT' | 'COMPLETION' }
  | null;

export interface DocumentChecklistProps {
  view: CaseView;
  /** Called after anything changed (upload finished, verified, linked ...). Pass the new case view when the API returned one. */
  onChanged: (view?: CaseView) => void;
  /** "intake": the wizard step (inputs only, plain wording). "case": the case page (also completed documents and other files). */
  mode?: 'intake' | 'case';
  /**
   * Given when the request can be sent back to the customer right now: a rejected document then comes with
   * the offer to ask the customer for a new one (the request does not always start waiting by itself).
   */
  onAskCustomer?: () => void;
}

/**
 * The document checklist of a request: what is needed, what is there, and
 * everything a person may do with a line. Used by the wizard and the case page.
 * Every control is driven by the session's permissions and by `allowedActions`
 * of the case, so the same component serves a receptionist and a reviewer.
 */
export function DocumentChecklist({ view, onChanged, mode = 'case', onAskCustomer }: DocumentChecklistProps) {
  const i18n = useI18n();
  const { t, tn } = i18n;
  const api = useCasesApi();
  const client = useApiClient();
  const session = useSession();
  const toasts = useToast();
  const describe = useCaseError();
  const queryClient = useQueryClient();
  const ai = useAiAssistant();

  const closed = isClosed(view.status);
  const other = view.allowedActions.other;
  const canRead = session.hasPermission('document.read');
  const canUpload = session.hasPermission('document.upload') && !closed;
  const canVerify = session.hasPermission('document.verify') && !closed;
  const canManage = other.includes('manage_checklist');
  const canWaive = other.includes('waive_checklist_item');
  const canComplete = session.hasPermission('request.process');

  const assist = useQuery({ queryKey: caseKeys.checklistAssist(view.id), queryFn: () => api.checklistAssist(view.id), enabled: canRead });
  const extra = useQuery({ queryKey: caseKeys.requestDocuments(view.id), queryFn: () => api.requestDocuments(view.id), enabled: canRead && mode === 'case' });
  const assistOf = React.useMemo(() => new Map((assist.data?.items ?? []).map((item) => [item.checklistItemId, item])), [assist.data]);

  const [dialog, setDialog] = React.useState<LineDialog>(null);
  const [uploading, setUploading] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [viewer, setViewer] = React.useState<{ id: string; title: string } | null>(null);

  const refresh = React.useCallback(
    (next?: CaseView) => {
      onChanged(next);
      void queryClient.invalidateQueries({ queryKey: caseKeys.documents });
    },
    [onChanged, queryClient],
  );

  const run = async (key: string, action: () => Promise<CaseView>, done: string) => {
    setBusy(key);
    try {
      refresh(await action());
      toasts.success(done);
    } catch (error) {
      toasts.error(describe(error));
    } finally {
      setBusy(null);
    }
  };

  const download = async (documentId: string) => {
    try {
      const link = await documentDownloadLink(client, documentId);
      const a = document.createElement('a');
      a.href = link.url;
      a.rel = 'noopener';
      a.download = link.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (error) {
      toasts.error(describe(error));
    }
  };

  const inputs = view.checklist.filter((line) => line.kind === 'INPUT');
  const completion = view.checklist.filter((line) => line.kind === 'COMPLETION');
  const linkedIds = new Set(view.checklist.map((line) => line.document?.id).filter(Boolean));
  const otherFiles = (extra.data?.data ?? []).filter((doc) => !linkedIds.has(doc.id) && doc.status !== 'DELETED');
  const summary = assist.data?.summary;
  const missingMandatory = inputs.filter((line) => line.isMandatory && (line.status === 'MISSING' || line.status === 'REJECTED')).length;
  const missingRequired = inputs.filter((line) => line.isMandatory && line.status === 'MISSING').length;
  const rejectedCount = inputs.filter((line) => line.status === 'REJECTED').length;

  const renderLine = (line: CaseChecklistItem) => {
    const hint = assistOf.get(line.id);
    const doc = line.document;
    const rejected = line.status === 'REJECTED';
    const needsFile = line.status === 'MISSING' || rejected;
    const completionLine = line.kind === 'COMPLETION';
    const mayUploadHere = canUpload && (!completionLine || canComplete);
    const mayLink = canManage && (!completionLine || canComplete) && line.status !== 'VERIFIED' && line.status !== 'WAIVED';
    // A rejected document cannot be used again (the API refuses with DOCUMENT_REJECTED), so it is not offered.
    const candidates = needsFile && mayLink ? (hint?.candidates ?? []).filter((c) => c.documentId !== doc?.id && c.verificationStatus !== 'REJECTED') : [];
    const available = doc?.status === 'AVAILABLE';
    const open = uploading === line.id;
    return (
      <li key={line.id} className="px-4 py-4 sm:px-5" data-checklist-line={line.id} data-status={line.status}>
        <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
          <LineIcon line={line} />
          <div className="min-w-0 flex-1 basis-56">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <p className="text-base font-medium text-foreground" dir="auto">
                {i18n.pick(line.label, line.labelAr)}
              </p>
              <StatusBadge kind="checklist" status={line.status} />
              {line.isMandatory ? <Badge tone="outline">{t('cases.docs.mandatory')}</Badge> : <span className="text-sm text-muted-foreground">{t('cases.docs.optional')}</span>}
              {line.actionRequired ? <Badge tone="warning">{t('cases.docs.actionRequired')}</Badge> : null}
            </div>
            {doc ? (
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                <span className="min-w-0 truncate" dir="auto" title={doc.title}>
                  {doc.title}
                </span>
                {doc.status !== 'AVAILABLE' ? <StatusBadge kind="document" status={doc.status} /> : null}
                {doc.expiryDate ? <span className="whitespace-nowrap">{t('cases.docs.expires', { date: i18n.formatDate(doc.expiryDate) })}</span> : null}
                <span className="whitespace-nowrap">{t('cases.docs.uploadedOn', { date: i18n.formatDate(doc.uploadedAt) })}</span>
              </p>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">{line.status === 'WAIVED' ? t('cases.docs.waivedText') : t('cases.docs.nothingYet')}</p>
            )}
            {line.note ? (
              <p className={cn('mt-1.5 text-sm', rejected ? 'text-destructive-text' : 'text-foreground/85')} dir="auto">
                <span className="font-medium">{rejected ? t('cases.docs.rejectedBecause') : t('cases.docs.waivedBecause')}</span> {line.note}
              </p>
            ) : null}
            {hint && WARN_STATES.has(hint.state) ? <AssistHint item={hint} /> : null}
            {candidates.length ? (
              <div className="mt-2.5 space-y-1.5 rounded-md border border-info/25 bg-info-soft/60 px-3 py-2.5">
                <p className="text-sm font-medium text-foreground">{t('cases.docs.reuseTitle')}</p>
                <ul className="space-y-1.5">
                  {candidates.map((candidate) => (
                    <li key={candidate.documentId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                      <span className="min-w-0 text-sm text-foreground/90">
                        <span dir="auto">{candidate.title}</span>
                        <span className="text-muted-foreground">
                          {' · '}
                          {candidate.verificationStatus === 'VERIFIED' ? t('cases.docs.candidateVerified') : t('cases.docs.candidateUnverified')}
                          {candidate.expiryDate ? ` · ${t('cases.docs.expires', { date: i18n.formatDate(candidate.expiryDate) })}` : ''}
                        </span>
                      </span>
                      <span className="flex gap-1.5">
                        <Button variant="ghost" size="sm" onClick={() => setViewer({ id: candidate.documentId, title: candidate.title })}>
                          <Eye aria-hidden="true" />
                          {t('common.view')}
                        </Button>
                        <Button
                          variant="subtle"
                          size="sm"
                          loading={busy === `link:${line.id}:${candidate.documentId}`}
                          onClick={() => void run(`link:${line.id}:${candidate.documentId}`, () => api.linkDocument(view.id, line.id, candidate.documentId), t('cases.docs.linked'))}
                        >
                          <Link2 aria-hidden="true" />
                          {t('cases.docs.useThis')}
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>

          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
            {doc && canRead ? (
              <Button variant="ghost" size="sm" onClick={() => setViewer({ id: doc.id, title: doc.title })} disabled={!available}>
                <Eye aria-hidden="true" />
                {t('common.view')}
              </Button>
            ) : null}
            {doc && available && canVerify && !completionLine && line.status === 'UPLOADED' ? (
              <Button variant="subtle" size="sm" onClick={() => setDialog({ type: 'verify', line })}>
                <ShieldCheck aria-hidden="true" />
                {t('cases.docs.check')}
              </Button>
            ) : null}
            {mayUploadHere && line.status !== 'WAIVED' ? (
              <Button variant={needsFile ? 'outline' : 'ghost'} size="sm" aria-expanded={open} onClick={() => setUploading(open ? null : line.id)}>
                <Upload aria-hidden="true" />
                {needsFile ? (completionLine ? t('cases.docs.attach') : t('common.upload')) : t('cases.docs.replace')}
              </Button>
            ) : null}
            <LineMenu
              line={line}
              canRead={canRead}
              canVerify={canVerify && !completionLine}
              canWaive={canWaive && !completionLine}
              canUnlink={canManage && !!doc && (!completionLine || canComplete) && line.status !== 'VERIFIED'}
              aiAvailable={ai.available && !completionLine}
              onDownload={() => doc && void download(doc.id)}
              onVerify={() => setDialog({ type: 'verify', line })}
              onWaive={() => setDialog({ type: 'waive', line })}
              onVersions={() => doc && setDialog({ type: 'versions', documentId: doc.id, title: doc.title })}
              onOcr={() => doc && setDialog({ type: 'ocr', documentId: doc.id, title: doc.title })}
              onUnlink={() => void run(`unlink:${line.id}`, () => api.unlinkDocument(view.id, line.id), t('cases.docs.unlinked'))}
            />
          </div>
        </div>

        {open ? (
          <div className="mt-3 sm:ms-9">
            <FileUpload
              multiple={false}
              accept={ACCEPT}
              acceptLabel={ACCEPT_LABEL}
              capture="environment"
              upload={(file, o) =>
                uploadDocument(client, {
                  file,
                  requestId: view.id,
                  customerId: view.customer.id,
                  checklistItemId: line.id,
                  documentTypeKey: line.documentTypeKey,
                  // A document that is in use gets a new version (its history is kept); a rejected or missing one is a fresh upload.
                  ...(doc && !rejected && doc.status === 'AVAILABLE' ? { replacesDocumentId: doc.id } : {}),
                  ...o,
                })
              }
              onUploaded={() => {
                toasts.success(t('cases.docs.uploaded'), i18n.pick(line.label, line.labelAr));
                setUploading(null);
                refresh();
              }}
            />
          </div>
        ) : null}
      </li>
    );
  };

  return (
    <div className="space-y-5">
      {mode === 'intake' ? null : closed ? <Alert tone="info">{t('cases.docs.closedNote')}</Alert> : null}

      {summary && !closed && (missingRequired > 0 || rejectedCount > 0 || summary.expired > 0 || summary.expiring > 0) ? (
        <Alert
          tone={rejectedCount > 0 || summary.expired > 0 ? 'warning' : 'info'}
          title={t('cases.docs.assistTitle')}
          action={
            rejectedCount > 0 && onAskCustomer ? (
              <Button size="sm" variant="outline" onClick={onAskCustomer} data-ask-customer>
                {t('cases.next.askForDocuments')}
              </Button>
            ) : undefined
          }
        >
          <ul className="list-inside list-disc space-y-0.5">
            {missingRequired > 0 ? <li>{tn('cases.docs.assistMissing', missingRequired)}</li> : null}
            {rejectedCount > 0 ? (
              <li>
                {tn('cases.docs.assistRejected', rejectedCount)}
                {onAskCustomer ? ` ${t('cases.docs.assistNotAsked')}` : ''}
              </li>
            ) : null}
            {summary.expired > 0 ? <li>{tn('cases.docs.assistExpired', summary.expired)}</li> : null}
            {summary.expiring > 0 ? <li>{tn('cases.docs.assistExpiring', summary.expiring)}</li> : null}
          </ul>
        </Alert>
      ) : null}

      <Card>
        <CardHeader className="items-center pb-4">
          <div>
            <CardTitle>{t('cases.docs.inputsTitle')}</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {inputs.length === 0 ? t('cases.docs.inputsNone') : missingMandatory > 0 ? tn('cases.docs.inputsMissing', missingMandatory) : t('cases.docs.inputsComplete')}
            </p>
          </div>
          {canManage ? (
            <Button variant="outline" size="sm" onClick={() => setDialog({ type: 'add' })}>
              <FilePlus2 aria-hidden="true" />
              {t('cases.docs.addLine')}
            </Button>
          ) : null}
        </CardHeader>
        {inputs.length ? (
          <ul className="divide-y border-t">{inputs.map(renderLine)}</ul>
        ) : (
          <EmptyState className="border-t" icon={<FileCheck2 />} title={t('cases.docs.inputsEmptyTitle')} description={t('cases.docs.inputsEmptyText')} />
        )}
      </Card>

      {mode === 'case' && (completion.length > 0 || (canManage && canComplete)) ? (
        <Card>
          <CardHeader className="items-center pb-4">
            <div>
              <CardTitle>{t('cases.docs.completionTitle')}</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">{t('cases.docs.completionText')}</p>
            </div>
            {canManage && canComplete ? (
              <Button variant="outline" size="sm" onClick={() => setDialog({ type: 'add', kind: 'COMPLETION' })}>
                <FilePlus2 aria-hidden="true" />
                {t('cases.docs.addCompletion')}
              </Button>
            ) : null}
          </CardHeader>
          {completion.length ? <ul className="divide-y border-t">{completion.map(renderLine)}</ul> : <p className="border-t px-5 py-4 text-sm text-muted-foreground">{t('cases.docs.completionEmpty')}</p>}
        </Card>
      ) : null}

      {canUpload ? <OtherUpload view={view} onUploaded={() => refresh()} /> : null}

      {mode === 'case' && canRead ? (
        extra.isPending ? (
          <Skeleton className="h-20 w-full" />
        ) : otherFiles.length ? (
          <Card>
            <CardHeader className="pb-4">
              <div>
                <CardTitle>{t('cases.docs.otherTitle')}</CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">{t('cases.docs.otherText')}</p>
              </div>
            </CardHeader>
            <ul className="divide-y border-t">
              {otherFiles.map((doc) => (
                <OtherFile key={doc.id} doc={doc} onView={() => setViewer({ id: doc.id, title: doc.title })} onDownload={() => void download(doc.id)} onVersions={() => setDialog({ type: 'versions', documentId: doc.id, title: doc.title })} />
              ))}
            </ul>
          </Card>
        ) : null
      ) : null}

      {viewer ? (
        <FileViewer
          open
          onOpenChange={(next) => !next && setViewer(null)}
          title={viewer.title}
          getSource={async () => {
            const link = await documentPreviewLink(client, viewer.id);
            return { url: link.url, mime: link.mime, filename: link.filename };
          }}
          onDownload={() => void download(viewer.id)}
        />
      ) : null}
      {dialog?.type === 'verify' && dialog.line.document ? (
        <VerifyDialog line={dialog.line} onClose={() => setDialog(null)} onDone={() => refresh()} onView={() => dialog.line.document && setViewer({ id: dialog.line.document.id, title: dialog.line.document.title })} />
      ) : null}
      {dialog?.type === 'waive' ? <WaiveDialog requestId={view.id} line={dialog.line} onClose={() => setDialog(null)} onDone={refresh} /> : null}
      {dialog?.type === 'versions' ? <VersionsDialog documentId={dialog.documentId} title={dialog.title} onClose={() => setDialog(null)} /> : null}
      {dialog?.type === 'ocr' ? <OcrDialog documentId={dialog.documentId} title={dialog.title} onClose={() => setDialog(null)} onApplied={() => refresh()} /> : null}
      {dialog?.type === 'add' ? <AddLineDialog requestId={view.id} kind={dialog.kind ?? 'INPUT'} allowCompletion={canComplete && mode === 'case'} onClose={() => setDialog(null)} onDone={refresh} /> : null}
    </div>
  );
}

const WARN_STATES = new Set(['EXPIRED', 'EXPIRING', 'BLOCKED', 'PROCESSING']);

function LineIcon({ line }: { line: CaseChecklistItem }) {
  const cls = 'mt-0.5 size-5 shrink-0';
  if (line.status === 'VERIFIED') return <CheckCircle2 className={cn(cls, 'text-success-text')} aria-hidden="true" />;
  if (line.status === 'REJECTED') return <XCircle className={cn(cls, 'text-destructive-text')} aria-hidden="true" />;
  if (line.status === 'UPLOADED') return <FileCheck2 className={cn(cls, 'text-info-text')} aria-hidden="true" />;
  if (line.status === 'WAIVED') return <FileX2 className={cn(cls, 'text-muted-foreground')} aria-hidden="true" />;
  return <CircleDashed className={cn(cls, line.isMandatory ? 'text-warning-text' : 'text-muted-foreground')} aria-hidden="true" />;
}

/** The checklist assistant's finding for a line (expiry, blocked file ...). Deterministic, from GET /documents/checklist-assist. */
function AssistHint({ item }: { item: AssistItem }) {
  const { t, tn, has } = useI18n();
  const key = `cases.docs.assist.${item.state}`;
  const text =
    item.state === 'EXPIRING' && item.daysToExpiry !== null ? tn('cases.docs.assistExpiresIn', item.daysToExpiry) : has(key) ? t(key) : item.hint;
  return (
    <p className={cn('mt-1.5 flex items-start gap-1.5 text-sm', item.state === 'EXPIRED' || item.state === 'BLOCKED' ? 'text-destructive-text' : 'text-warning-text')}>
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>{text}</span>
    </p>
  );
}

function LineMenu({ line, canRead, canVerify, canWaive, canUnlink, aiAvailable, onDownload, onVerify, onWaive, onVersions, onOcr, onUnlink }: {
  line: CaseChecklistItem;
  canRead: boolean;
  canVerify: boolean;
  canWaive: boolean;
  canUnlink: boolean;
  aiAvailable: boolean;
  onDownload: () => void;
  onVerify: () => void;
  onWaive: () => void;
  onVersions: () => void;
  onOcr: () => void;
  onUnlink: () => void;
}) {
  const { t, pick } = useI18n();
  const types = useDocumentTypes();
  const doc = line.document;
  const available = doc?.status === 'AVAILABLE';
  const profile = types.data?.find((d) => d.key === line.documentTypeKey)?.ocrProfile;
  const items: React.ReactNode[] = [];
  if (doc && canRead && available) {
    items.push(
      <DropdownMenuItem key="download" onSelect={onDownload}>
        <Download aria-hidden="true" />
        {t('common.download')}
      </DropdownMenuItem>,
      <DropdownMenuItem key="versions" onSelect={onVersions}>
        <History aria-hidden="true" />
        {t('cases.docs.versions')}
      </DropdownMenuItem>,
    );
  }
  if (doc && available && canVerify && (line.status === 'VERIFIED' || line.status === 'REJECTED')) {
    items.push(
      <DropdownMenuItem key="recheck" onSelect={onVerify}>
        <ShieldCheck aria-hidden="true" />
        {t('cases.docs.checkAgain')}
      </DropdownMenuItem>,
    );
  }
  if (doc && available && aiAvailable && profile !== 'NONE') {
    items.push(
      <DropdownMenuItem key="ocr" onSelect={onOcr}>
        <ScanText aria-hidden="true" />
        {t('cases.ai.menu')}
      </DropdownMenuItem>,
    );
  }
  const waivable = canWaive && line.status !== 'WAIVED' && line.status !== 'VERIFIED';
  if ((waivable || (canUnlink && doc)) && items.length) items.push(<DropdownMenuSeparator key="sep" />);
  if (canUnlink && doc) {
    items.push(
      <DropdownMenuItem key="unlink" onSelect={onUnlink}>
        <Unlink aria-hidden="true" />
        {t('cases.docs.unlink')}
      </DropdownMenuItem>,
    );
  }
  if (waivable) {
    items.push(
      <DropdownMenuItem key="waive" onSelect={onWaive}>
        <FileX2 aria-hidden="true" />
        {t('cases.docs.waive')}
      </DropdownMenuItem>,
    );
  }
  if (!items.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={t('cases.docs.moreFor', { name: pick(line.label, line.labelAr) })}>
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>{items}</DropdownMenuContent>
    </DropdownMenu>
  );
}

function OtherFile({ doc, onView, onDownload, onVersions }: { doc: DocumentRow; onView: () => void; onDownload: () => void; onVersions: () => void }) {
  const { t, pick, formatDate } = useI18n();
  const types = useDocumentTypes();
  const type = types.data?.find((d) => d.key === doc.documentTypeKey);
  const available = doc.status === 'AVAILABLE';
  const typeName = type ? pick(type.name, type.nameAr) : doc.documentTypeKey;
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-5">
      <div className="min-w-0 flex-1 basis-56">
        <p className="truncate text-base font-medium text-foreground">
          <bdi>{doc.title}</bdi>
        </p>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          {typeName !== doc.title ? <span>{typeName}</span> : null}
          {doc.currentVersion?.filename ? (
            <span className="ltr-value max-w-full truncate" dir="ltr">
              {doc.currentVersion.filename}
            </span>
          ) : null}
          <span>{t('cases.docs.uploadedOn', { date: formatDate(doc.createdAt) })}</span>
          {doc.isCompletionDocument ? <Badge tone="success">{t('cases.docs.completedDocument')}</Badge> : null}
          {doc.status !== 'AVAILABLE' ? <StatusBadge kind="document" status={doc.status} /> : <StatusBadge kind="verification" status={doc.verificationStatus} />}
        </p>
      </div>
      <div className="flex gap-1.5">
        <Button variant="ghost" size="sm" onClick={onView} disabled={!available}>
          <Eye aria-hidden="true" />
          {t('common.view')}
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onDownload} disabled={!available} aria-label={`${t('common.download')}: ${doc.title}`}>
          <Download aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onVersions} aria-label={`${t('cases.docs.versions')}: ${doc.title}`}>
          <History aria-hidden="true" />
        </Button>
      </div>
    </li>
  );
}

/** Several files at once that are not tied to one line: each is filed under the request with the chosen type. */
function OtherUpload({ view, onUploaded }: { view: CaseView; onUploaded: () => void }) {
  const { t } = useI18n();
  const client = useApiClient();
  const [type, setType] = React.useState('other');
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  return (
    <Card>
      <CardHeader className="items-center pb-4">
        <div className="min-w-0 flex-1 basis-56">
          <CardTitle>{t('cases.docs.moreTitle')}</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">{t('cases.docs.moreText')}</p>
        </div>
        {open ? null : (
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            <Upload aria-hidden="true" />
            {t('cases.docs.moreOpen')}
          </Button>
        )}
      </CardHeader>
      {open ? (
        <CardContent className="space-y-4 border-t">
          <div className="space-y-1.5 sm:max-w-xs">
            <label htmlFor={id} className="text-sm font-medium text-foreground">
              {t('cases.docs.moreType')}
            </label>
            <DocumentTypePicker id={id} value={type} onChange={(key) => setType(key || 'other')} />
          </div>
          <FileUpload
            accept={ACCEPT}
            acceptLabel={ACCEPT_LABEL}
            capture="environment"
            maxFiles={10}
            upload={(file, o) => uploadDocument(client, { file, requestId: view.id, customerId: view.customer.id, documentTypeKey: type, ...o })}
            onUploaded={onUploaded}
          />
        </CardContent>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------- dialogs

function VerifyDialog({ line, onClose, onDone, onView }: { line: CaseChecklistItem; onClose: () => void; onDone: () => void; onView: () => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const api = useCasesApi();
  const toasts = useToast();
  const types = useDocumentTypes();
  const doc = line.document!;
  const hasExpiry = types.data?.find((d) => d.key === line.documentTypeKey)?.hasExpiry ?? !!doc.expiryDate;
  const form = useZodForm(documentVerifySchema, {
    defaultValues: { decision: 'APPROVED', reason: '', expiryDate: doc.expiryDate ? doc.expiryDate.slice(0, 10) : '', issuedDate: '' },
  });
  const decision = form.watch('decision');
  const groupId = React.useId();
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="md">
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            const approved = values.decision === 'APPROVED';
            await api.verifyDocument(doc.id, {
              decision: values.decision,
              ...(approved ? {} : { reason: values.reason }),
              ...(approved && values.expiryDate ? { expiryDate: values.expiryDate } : {}),
              ...(approved && values.issuedDate ? { issuedDate: values.issuedDate } : {}),
            });
            toasts.success(approved ? t('cases.docs.verify.approved') : t('cases.docs.verify.rejected'), i18n.pick(line.label, line.labelAr));
            onDone();
            onClose();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('cases.docs.verify.title')}</DialogTitle>
            <DialogDescription>
              <bdi>{i18n.pick(line.label, line.labelAr)}</bdi>
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2.5">
              <p className="min-w-0 truncate text-sm text-foreground" dir="auto">
                {doc.title}
              </p>
              <Button variant="outline" size="sm" onClick={onView}>
                <Eye aria-hidden="true" />
                {t('cases.docs.verify.open')}
              </Button>
            </div>
            <FormField name="decision" label={t('cases.docs.verify.decision')}>
              {(field) => (
                <RadioGroup id={field.id} value={field.value} onValueChange={field.onChange} aria-label={t('cases.docs.verify.decision')}>
                  {(['APPROVED', 'CORRECTION_REQUESTED', 'REJECTED'] as const).map((value) => (
                    <ChoiceLabel
                      key={value}
                      htmlFor={`${groupId}-${value}`}
                      control={<RadioGroupItem id={`${groupId}-${value}`} value={value} />}
                      label={t(`cases.docs.verify.decisions.${value}`)}
                      description={t(`cases.docs.verify.decisionHints.${value}`)}
                    />
                  ))}
                </RadioGroup>
              )}
            </FormField>
            {decision === 'APPROVED' ? (
              <div className="grid gap-5 sm:grid-cols-2">
                {hasExpiry ? (
                  <FormField name="expiryDate" label={t('cases.docs.verify.expiry')} hint={t('cases.docs.verify.expiryHint')}>
                    {(field) => <DatePicker {...field} onChange={field.onChange} />}
                  </FormField>
                ) : null}
                <FormField name="issuedDate" label={t('cases.docs.verify.issued')} optional>
                  {(field) => <DatePicker {...field} onChange={field.onChange} max={i18n.today()} />}
                </FormField>
              </div>
            ) : (
              <FormField name="reason" label={t('cases.docs.verify.reason')} required hint={t('cases.docs.verify.reasonHint')}>
                {(field) => <Textarea {...field} rows={3} dir="auto" />}
              </FormField>
            )}
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant={decision === 'APPROVED' ? 'default' : 'destructive'} loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {decision === 'APPROVED' ? t('cases.docs.verify.submitApprove') : t('cases.docs.verify.submitReject')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function WaiveDialog({ requestId, line, onClose, onDone }: { requestId: string; line: CaseChecklistItem; onClose: () => void; onDone: (view?: CaseView) => void }) {
  const { t, pick } = useI18n();
  const api = useCasesApi();
  const toasts = useToast();
  const form = useZodForm(requestReasonSchema, { defaultValues: { reason: '' } });
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="sm">
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async ({ reason }) => {
            onDone(await api.waiveChecklistItem(requestId, line.id, reason));
            toasts.success(t('cases.docs.waived'), pick(line.label, line.labelAr));
            onClose();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('cases.docs.waiveTitle')}</DialogTitle>
            <DialogDescription>{t('cases.docs.waiveText', { name: pick(line.label, line.labelAr) })}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="reason" label={t('cases.docs.waiveReason')} required hint={t('cases.docs.waiveHint')}>
              {(field) => <Textarea {...field} rows={3} dir="auto" autoFocus />}
            </FormField>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('cases.docs.waiveSubmit')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function VersionsDialog({ documentId, title, onClose }: { documentId: string; title: string; onClose: () => void }) {
  const { t, formatDateTime, formatFileSize, formatNumber } = useI18n();
  const api = useCasesApi();
  const client = useApiClient();
  const toasts = useToast();
  const describe = useCaseError();
  const query = useQuery({ queryKey: caseKeys.document(documentId), queryFn: () => api.document(documentId) });
  const save = async (versionId: string) => {
    try {
      const link = await documentDownloadLink(client, documentId, versionId);
      const a = document.createElement('a');
      a.href = link.url;
      a.rel = 'noopener';
      a.download = link.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (error) {
      toasts.error(describe(error));
    }
  };
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{t('cases.docs.versionsTitle')}</DialogTitle>
          <DialogDescription>
            <bdi>{title}</bdi>
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          {query.isPending ? (
            <div className="space-y-2">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : query.isError ? (
            <Alert tone="danger" action={<Button size="sm" variant="outline" onClick={() => void query.refetch()}>{t('common.retry')}</Button>}>
              {describe(query.error)}
            </Alert>
          ) : (
            <>
              <ul className="divide-y rounded-md border">
                {query.data.versions.map((version) => (
                  <li key={version.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5">
                    <div className="min-w-0 flex-1 basis-52">
                      <p className="flex flex-wrap items-center gap-2 text-base font-medium text-foreground">
                        {t('cases.docs.versionNo', { number: formatNumber(version.versionNo) })}
                        {version.isCurrent ? <Badge tone="success">{t('cases.docs.versionCurrent')}</Badge> : null}
                        {version.scanStatus === 'INFECTED' ? <Badge tone="danger">{t('cases.docs.versionBlocked')}</Badge> : null}
                      </p>
                      <p className="truncate text-sm text-muted-foreground">
                        <span className="ltr-value">{version.filename}</span> · {formatFileSize(version.sizeBytes)} · {formatDateTime(version.createdAt)}
                      </p>
                    </div>
                    <Button variant="ghost" size="sm" disabled={!version.downloadable} onClick={() => void save(version.id)}>
                      <Download aria-hidden="true" />
                      {t('common.download')}
                    </Button>
                  </li>
                ))}
              </ul>
              {query.data.verifications?.length ? (
                <div>
                  <p className="mb-2 text-sm font-medium text-foreground">{t('cases.docs.checksTitle')}</p>
                  <ul className="space-y-2">
                    {query.data.verifications.map((check) => (
                      <li key={check.id} className="text-sm text-foreground/90">
                        <Badge tone={check.decision === 'APPROVED' ? 'success' : 'danger'}>{t(`cases.docs.verify.past.${check.decision}`)}</Badge>{' '}
                        <span className="text-muted-foreground">{formatDateTime(check.createdAt)}</span>
                        {check.reason ? (
                          <span className="block" dir="auto">
                            {check.reason}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddLineDialog({ requestId, kind, allowCompletion, onClose, onDone }: { requestId: string; kind: 'INPUT' | 'COMPLETION'; allowCompletion: boolean; onClose: () => void; onDone: (view?: CaseView) => void }) {
  const { t } = useI18n();
  const api = useCasesApi();
  const toasts = useToast();
  const form = useZodForm(addChecklistItemSchema, { defaultValues: { documentTypeKey: '', label: '', labelAr: '', isMandatory: true, kind } });
  const mandatoryId = React.useId();
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="md">
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            onDone(await api.addChecklistItem(requestId, values));
            toasts.success(t('cases.docs.lineAdded'), values.label);
            onClose();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('cases.docs.addLineTitle')}</DialogTitle>
            <DialogDescription>{t('cases.docs.addLineText')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            {allowCompletion ? (
              <FormField name="kind" label={t('cases.docs.lineKind')}>
                {(field) => (
                  <Select
                    {...field}
                    onValueChange={field.onChange}
                    options={[
                      { value: 'INPUT', label: t('cases.docs.kinds.INPUT') },
                      { value: 'COMPLETION', label: t('cases.docs.kinds.COMPLETION') },
                    ]}
                  />
                )}
              </FormField>
            ) : null}
            <FormField name="documentTypeKey" label={t('cases.docs.lineType')} required>
              {(field) => (
                <DocumentTypePicker
                  {...field}
                  onChange={(key, type) => {
                    field.onChange(key);
                    if (type && !form.getValues('label')) {
                      form.setValue('label', type.name, { shouldValidate: true });
                      if (type.nameAr) form.setValue('labelAr', type.nameAr);
                    }
                  }}
                />
              )}
            </FormField>
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField name="label" label={t('cases.docs.lineLabel')} required hint={t('cases.docs.lineLabelHint')}>
                {(field) => <Input {...field} dir="ltr" lang="en" autoComplete="off" />}
              </FormField>
              <FormField name="labelAr" label={t('cases.docs.lineLabelAr')} optional>
                {(field) => <Input {...field} dir="rtl" lang="ar" autoComplete="off" />}
              </FormField>
            </div>
            <FormField name="isMandatory" label={t('cases.docs.lineMandatory')} hideLabel>
              {(field) => (
                <ChoiceLabel
                  htmlFor={mandatoryId}
                  control={<Switch id={mandatoryId} checked={field.value === true} onCheckedChange={field.onChange} />}
                  label={t('cases.docs.lineMandatory')}
                  description={form.watch('kind') === 'COMPLETION' ? t('cases.docs.lineMandatoryHintCompletion') : t('cases.docs.lineMandatoryHint')}
                />
              )}
            </FormField>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('cases.docs.addLineSubmit')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
