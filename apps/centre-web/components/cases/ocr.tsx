'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, RotateCw, ScanText, TriangleAlert } from 'lucide-react';
import { documentPreviewLink, fieldErrorsOf, isApiError } from '@typease/api-client';
import { OCR_DATE_FIELDS, type OcrFieldKey } from '@typease/validation';
import {
  Alert, Badge, Button, Checkbox, ChoiceLabel, DatePicker, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FileViewer, Input,
  LoadingBlock, Skeleton, Textarea, cn, useApiClient, useI18n, useToast,
} from '@typease/ui';
import { caseKeys } from '@/lib/keys/cases';
import { useCasesApi } from './api';
import { isAiUnavailableError, useAiAssistant, useCaseError } from './shared';
import type { OcrField, OcrResult, OcrRunSummary } from './types';

const RUNNING = new Set(['QUEUED', 'PROCESSING']);
const newest = (runs: OcrRunSummary[]) => [...runs].sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0];

/**
 * The AI document assistant for one document: start a reading, then the human
 * review screen (what the machine read, how sure it is, what is on file, what the
 * reviewer reads) and the explicit "apply" of reviewed values.
 * Everything the machine produced is labelled unverified until a person reviewed it.
 */
export function OcrDialog({ documentId, title, onClose, onApplied }: { documentId: string; title: string; onClose: () => void; onApplied: () => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const api = useCasesApi();
  const client = useApiClient();
  const toasts = useToast();
  const describe = useCaseError();
  const queryClient = useQueryClient();
  const ai = useAiAssistant();
  const [viewing, setViewing] = React.useState(false);

  const runs = useQuery({
    queryKey: caseKeys.ocrRuns(documentId),
    queryFn: () => api.ocrRuns(documentId),
    refetchInterval: (query) => {
      const latest = newest(query.state.data?.data ?? []);
      return latest && RUNNING.has(latest.status) ? 2000 : false;
    },
  });
  const latest = newest(runs.data?.data ?? []);
  const ready = latest && (latest.status === 'COMPLETED' || latest.status === 'REVIEWED');
  const result = useQuery({ queryKey: caseKeys.ocrResult(latest?.id ?? ''), queryFn: () => api.ocrResult(latest!.id), enabled: !!ready });

  const extract = useMutation({
    mutationFn: () => api.ocrExtract(documentId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: caseKeys.ocrRuns(documentId) }),
    onError: (error) => {
      // Switched off or not configured: the assistant disappears from the screen (spec: hidden entirely).
      if (ai.reportUnavailable(error)) {
        toasts.info(t('cases.ai.unavailableTitle'), t('cases.ai.unavailableText'));
        onClose();
      }
    },
  });

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2.5">
            {t('cases.ai.title')}
            {latest?.status === 'REVIEWED' ? <Badge tone="success">{t('cases.ai.reviewedBadge')}</Badge> : <Badge tone="warning">{t('cases.ai.unverifiedBadge')}</Badge>}
          </DialogTitle>
          <DialogDescription>
            <bdi>{title}</bdi>
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          {runs.isPending ? (
            <Skeleton className="h-40 w-full" />
          ) : runs.isError ? (
            <Alert tone="danger" action={<Button size="sm" variant="outline" onClick={() => void runs.refetch()}>{t('common.retry')}</Button>}>
              {describe(runs.error)}
            </Alert>
          ) : !latest ? (
            <div className="mx-auto max-w-lg space-y-4 py-6 text-center">
              <span aria-hidden="true" className="mx-auto flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                <ScanText className="size-6" />
              </span>
              <p className="text-md font-semibold text-foreground">{t('cases.ai.startTitle')}</p>
              <p className="text-base text-muted-foreground">{t('cases.ai.startText')}</p>
              {extract.isError && !isAiUnavailableError(extract.error) ? (
                <Alert tone="danger" live className="text-start">
                  {describe(extract.error)}
                </Alert>
              ) : null}
              {ai.canRun ? (
                <Button onClick={() => extract.mutate()} loading={extract.isPending} loadingText={t('common.loading')}>
                  <ScanText aria-hidden="true" />
                  {t('cases.ai.start')}
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">{t('cases.ai.noRunPermission')}</p>
              )}
            </div>
          ) : RUNNING.has(latest.status) ? (
            <LoadingBlock label={t('cases.ai.reading')} />
          ) : latest.status === 'FAILED' ? (
            <Alert
              tone="danger"
              title={t('cases.ai.failedTitle')}
              action={
                ai.canRun ? (
                  <Button size="sm" variant="outline" onClick={() => extract.mutate()} loading={extract.isPending}>
                    <RotateCw aria-hidden="true" />
                    {t('cases.ai.again')}
                  </Button>
                ) : undefined
              }
            >
              {latest.error || t('cases.ai.failedText')}
            </Alert>
          ) : result.isPending ? (
            <Skeleton className="h-64 w-full" />
          ) : result.isError ? (
            <Alert tone="danger" action={<Button size="sm" variant="outline" onClick={() => void result.refetch()}>{t('common.retry')}</Button>}>
              {describe(result.error)}
            </Alert>
          ) : (
            <OcrReview
              key={`${result.data.id}:${result.data.status}`}
              result={result.data}
              canReview={ai.canReview}
              onView={() => setViewing(true)}
              onRerun={ai.canRun ? () => extract.mutate() : undefined}
              rerunning={extract.isPending}
              onSaved={(next) => queryClient.setQueryData(caseKeys.ocrResult(next.id), next)}
              onApplied={(next) => {
                queryClient.setQueryData(caseKeys.ocrResult(next.id), next);
                void queryClient.invalidateQueries({ queryKey: caseKeys.ocrRuns(documentId) });
                onApplied();
              }}
            />
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
      {viewing ? (
        <FileViewer
          open
          onOpenChange={(next) => !next && setViewing(false)}
          title={title}
          getSource={async () => {
            const link = await documentPreviewLink(client, documentId);
            return { url: link.url, mime: link.mime, filename: link.filename };
          }}
        />
      ) : null}
    </Dialog>
  );
}

function confidenceTone(confidence: number): 'success' | 'warning' | 'danger' {
  return confidence >= 0.9 ? 'success' : confidence >= 0.6 ? 'warning' : 'danger';
}

function OcrReview({ result, canReview, onView, onRerun, rerunning, onSaved, onApplied }: {
  result: OcrResult;
  canReview: boolean;
  onView: () => void;
  onRerun?: () => void;
  rerunning: boolean;
  onSaved: (result: OcrResult) => void;
  onApplied: (result: OcrResult) => void;
}) {
  const i18n = useI18n();
  const { t, has, formatNumber, formatDate, formatDateTime } = i18n;
  const api = useCasesApi();
  const toasts = useToast();
  const describe = useCaseError();
  const reviewed = result.status === 'REVIEWED';

  // What the reviewer reads on the document: starts from an earlier review, else from the machine's reading.
  const [values, setValues] = React.useState<Record<string, string>>(() => Object.fromEntries(result.fields.map((f) => [f.key, f.reviewed ? f.reviewed.value ?? '' : f.extracted?.value ?? ''])));
  const [rejected, setRejected] = React.useState<Record<string, boolean>>(() => Object.fromEntries(result.fields.map((f) => [f.key, !!f.reviewed && f.reviewed.value === null])));
  const [note, setNote] = React.useState(result.reviewNote ?? '');
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [toApply, setToApply] = React.useState<Record<string, boolean>>({});

  const fieldLabel = (field: OcrField) => (has(`cases.ai.fields.${field.key}`) ? t(`cases.ai.fields.${field.key}`) : field.label);
  const isDate = (key: string) => OCR_DATE_FIELDS.includes(key as OcrFieldKey);
  const show = (key: string, value: string | null | undefined) => (value === null || value === undefined || value === '' ? null : isDate(key) && /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatDate(value) : value);

  const review = useMutation({
    mutationFn: () =>
      api.ocrReview(result.id, {
        fields: result.fields.map((f) => ({ key: f.key as OcrFieldKey, value: rejected[f.key] || !values[f.key]?.trim() ? null : values[f.key].trim() })),
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    onMutate: () => {
      setErrors({});
      setFormError(null);
    },
    onSuccess: (next) => {
      toasts.success(t('cases.ai.reviewSaved'));
      onSaved(next);
    },
    onError: (error) => {
      if (isApiError(error) && error.code === 'INVALID_REVIEW_VALUE') {
        const byPath = fieldErrorsOf(error);
        const mapped: Record<string, string> = {};
        for (const [path, message] of Object.entries(byPath)) {
          const index = Number(/^fields\.(\d+)\./.exec(path)?.[1] ?? -1);
          const key = result.fields[index]?.key;
          if (key) mapped[key] = message;
        }
        setErrors(mapped);
      }
      setFormError(describe(error));
    },
  });

  const applicable = result.fields.filter((f) => f.canApply && f.reviewed && f.reviewed.value !== null);
  const appliedKeys = new Set(result.applied.flatMap((a) => a.keys));
  const apply = useMutation({
    mutationFn: () => api.ocrApply(result.id, applicable.filter((f) => toApply[f.key]).map((f) => f.key)),
    onSuccess: (next) => {
      toasts.success(t('cases.ai.applied'));
      setToApply({});
      onApplied(next);
    },
    onError: (error) => setFormError(describe(error)),
  });
  const chosen = applicable.filter((f) => toApply[f.key]).length;

  return (
    <div className="space-y-5">
      {result.notice ? (
        <Alert tone="warning" title={t('cases.ai.noticeTitle')}>
          {t('cases.ai.noticeText')}
        </Alert>
      ) : (
        <Alert tone="success" title={t('cases.ai.reviewedTitle')}>
          {t('cases.ai.reviewedText')}
        </Alert>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {result.classification && result.classification !== 'UNKNOWN'
            ? t('cases.ai.classified', {
                type: has(`cases.ai.classes.${result.classification}`) ? t(`cases.ai.classes.${result.classification}`) : result.classification,
                confidence: formatNumber(result.classificationConfidence ?? 0, { style: 'percent', maximumFractionDigits: 0 }),
              })
            : t('cases.ai.classifiedUnknown')}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={onView}>
            <Eye aria-hidden="true" />
            {t('cases.ai.openDocument')}
          </Button>
          {onRerun ? (
            <Button variant="ghost" size="sm" onClick={onRerun} loading={rerunning}>
              <RotateCw aria-hidden="true" />
              {t('cases.ai.again')}
            </Button>
          ) : null}
        </div>
      </div>

      {result.warnings.length ? (
        <div className="rounded-lg border border-warning/40 bg-warning-soft p-3.5">
          <p className="flex items-center gap-2 font-semibold text-foreground">
            <TriangleAlert className="size-4 text-warning-text" aria-hidden="true" />
            {t('cases.ai.warningsTitle')}
          </p>
          <ul className="mt-2 space-y-1.5">
            {result.warnings.map((warning, index) => (
              <li key={`${warning.code}-${index}`} className="flex flex-wrap items-baseline gap-x-2 text-sm text-foreground/90">
                <Badge tone={warning.severity === 'HIGH' ? 'danger' : warning.severity === 'MEDIUM' ? 'warning' : 'neutral'}>{t(`cases.ai.severity.${warning.severity}`)}</Badge>
                <span>{warning.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {result.fields.length === 0 ? (
        <Alert tone="info">{t('cases.ai.noFields')}</Alert>
      ) : (
        <div role="table" aria-label={t('cases.ai.tableLabel')} className="rounded-lg border">
          <div role="row" className="hidden grid-cols-[minmax(0,0.9fr)_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.3fr)] gap-4 border-b bg-muted/50 px-4 py-2.5 text-xs font-semibold text-muted-foreground md:grid">
            <span role="columnheader">{t('cases.ai.columns.field')}</span>
            <span role="columnheader">{t('cases.ai.columns.extracted')}</span>
            <span role="columnheader">{t('cases.ai.columns.onFile')}</span>
            <span role="columnheader">{t('cases.ai.columns.reviewed')}</span>
          </div>
          {result.fields.map((field) => {
            const id = `ocr-${field.key}`;
            const tone = field.extracted ? confidenceTone(field.extracted.confidence) : 'danger';
            return (
              <div key={field.key} role="row" className="grid gap-x-4 gap-y-2 border-b px-4 py-3 last:border-0 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.3fr)] md:items-start">
                <div role="rowheader" className="text-base font-medium text-foreground">
                  <label htmlFor={id}>{fieldLabel(field)}</label>
                </div>
                <div role="cell" className="min-w-0">
                  <p className="text-xs text-muted-foreground md:hidden">{t('cases.ai.columns.extracted')}</p>
                  {field.extracted && field.extracted.value ? (
                    <>
                      <p className="ltr-value tabular break-words text-base text-foreground">{show(field.key, field.extracted.value)}</p>
                      <p className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Badge tone={tone}>
                          {t(`cases.ai.confidence.${tone}`)} · {formatNumber(field.extracted.confidence, { style: 'percent', maximumFractionDigits: 0 })}
                        </Badge>
                        <span className="text-xs text-muted-foreground">{has(`cases.ai.sources.${field.extracted.source}`) ? t(`cases.ai.sources.${field.extracted.source}`) : field.extracted.source}</span>
                      </p>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">{t('cases.ai.notRead')}</p>
                  )}
                </div>
                <div role="cell" className="min-w-0">
                  <p className="text-xs text-muted-foreground md:hidden">{t('cases.ai.columns.onFile')}</p>
                  {field.onFile === null ? (
                    <p className="text-sm text-muted-foreground">{t('cases.ai.noCounterpart')}</p>
                  ) : (
                    <>
                      <p className="ltr-value tabular break-words text-base text-foreground">{show(field.key, field.onFile.value) ?? <span className="text-muted-foreground">{t('cases.ai.nothingOnFile')}</span>}</p>
                      {field.onFile.matches === null ? null : (
                        <Badge tone={field.onFile.matches ? 'success' : 'danger'} className="mt-1">
                          {field.onFile.matches ? t('cases.ai.matches') : t('cases.ai.differs')}
                        </Badge>
                      )}
                    </>
                  )}
                </div>
                <div role="cell" className="min-w-0 space-y-1.5">
                  <p className="text-xs text-muted-foreground md:hidden">{t('cases.ai.columns.reviewed')}</p>
                  {canReview ? (
                    <>
                      {isDate(field.key) ? (
                        <DatePicker id={id} value={values[field.key]} disabled={rejected[field.key]} aria-invalid={!!errors[field.key]} onChange={(v) => setValues((s) => ({ ...s, [field.key]: v }))} />
                      ) : (
                        <Input
                          id={id}
                          dir="ltr"
                          autoComplete="off"
                          spellCheck={false}
                          className="tabular"
                          value={values[field.key] ?? ''}
                          disabled={rejected[field.key]}
                          aria-invalid={!!errors[field.key]}
                          onChange={(e) => setValues((s) => ({ ...s, [field.key]: e.target.value }))}
                        />
                      )}
                      {errors[field.key] ? (
                        <p role="alert" className="text-sm text-destructive-text">
                          {errors[field.key]}
                        </p>
                      ) : null}
                      <ChoiceLabel
                        htmlFor={`${id}-reject`}
                        control={<Checkbox id={`${id}-reject`} checked={!!rejected[field.key]} onCheckedChange={(on) => setRejected((s) => ({ ...s, [field.key]: on === true }))} />}
                        label={<span className="text-sm">{t('cases.ai.reject')}</span>}
                      />
                    </>
                  ) : field.reviewed ? (
                    <p className="ltr-value tabular text-base text-foreground">{show(field.key, field.reviewed.value) ?? <span className="text-muted-foreground">{t('cases.ai.rejectedValue')}</span>}</p>
                  ) : (
                    <p className="text-sm text-muted-foreground">{t('cases.ai.awaitingReview')}</p>
                  )}
                  {field.reviewed?.decision && has(`cases.ai.decisions.${field.reviewed.decision}`) ? <Badge tone="neutral">{t(`cases.ai.decisions.${field.reviewed.decision}`)}</Badge> : null}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {canReview && result.fields.length ? (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="ocr-note" className="text-sm font-medium text-foreground">
              {t('cases.ai.note')} <span className="font-normal text-muted-foreground">({t('common.optional')})</span>
            </label>
            <Textarea id="ocr-note" rows={2} value={note} maxLength={500} dir="auto" onChange={(e) => setNote(e.target.value)} />
          </div>
          {formError ? (
            <Alert tone="danger" live>
              {formError}
            </Alert>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-xl text-sm text-muted-foreground">{t('cases.ai.reviewHint')}</p>
            <Button onClick={() => review.mutate()} loading={review.isPending} loadingText={t('common.saving')}>
              {reviewed ? t('cases.ai.saveAgain') : t('cases.ai.save')}
            </Button>
          </div>
        </div>
      ) : !canReview ? (
        <Alert tone="info">{t('cases.ai.needsReviewer')}</Alert>
      ) : null}

      {reviewed && canReview && applicable.length ? (
        <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
          <div>
            <p className="text-md font-semibold text-foreground">{t('cases.ai.applyTitle')}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t('cases.ai.applyText')}</p>
          </div>
          <ul className="grid gap-2.5 sm:grid-cols-2">
            {applicable.map((field) => (
              <li key={field.key}>
                <ChoiceLabel
                  htmlFor={`apply-${field.key}`}
                  control={<Checkbox id={`apply-${field.key}`} checked={!!toApply[field.key]} onCheckedChange={(on) => setToApply((s) => ({ ...s, [field.key]: on === true }))} />}
                  label={fieldLabel(field)}
                  description={
                    <span className={cn('ltr-value tabular')}>
                      {show(field.key, field.reviewed?.value)}
                      {appliedKeys.has(field.key) ? ` · ${t('cases.ai.alreadyApplied')}` : ''}
                    </span>
                  }
                />
              </li>
            ))}
          </ul>
          <div className="flex justify-end">
            <Button variant="secondary" disabled={chosen === 0} onClick={() => apply.mutate()} loading={apply.isPending} loadingText={t('common.saving')}>
              {t('cases.ai.apply')}
            </Button>
          </div>
          {result.applied.length ? (
            <p className="text-sm text-muted-foreground">{t('cases.ai.appliedLast', { time: formatDateTime(result.applied[result.applied.length - 1].at) })}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
