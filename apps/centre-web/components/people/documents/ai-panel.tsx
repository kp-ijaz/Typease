'use client';

import * as React from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ScanText, Sparkles } from 'lucide-react';
import type { Page } from '@typease/types';
import { fieldErrorsOf, isApiError } from '@typease/api-client';
import {
  Alert, Badge, Button, Checkbox, Input, Label, Select, Skeleton, Spinner, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea, cn, useApi, useErrorMessage, useI18n, useSession, useToast,
  type Tone,
} from '@typease/ui';
import { peopleKeys } from '@/lib/keys/people';
import { LoadError, Ltr, Section, usePlan } from '../shared';
import type { DocumentDetail, OcrField, OcrResult, OcrSummary, OcrUsage } from '../types';

const PROFILES = ['AUTO', 'PASSPORT', 'EMIRATES_ID', 'TRADE_LICENCE'] as const;
const SEVERITY_TONE: Record<string, 'danger' | 'warning' | 'info'> = { HIGH: 'danger', MEDIUM: 'warning', LOW: 'info' };
const STATUS_TONE: Record<string, Tone> = { QUEUED: 'info', PROCESSING: 'info', COMPLETED: 'warning', REVIEWED: 'success', FAILED: 'danger' };

/**
 * Why the assistant cannot be used here, or null when it can. Read from the centre's own settings
 * (GET /tenant: `aiEnabled`), the plan (GET /tenant/usage) and, for roles that may see it, the
 * provider state (GET /ocr/usage). The API checks all of this again when a run is requested.
 */
function useAiAvailability() {
  const api = useApi();
  const session = useSession();
  const plan = usePlan();
  const tenant = useQuery({ queryKey: peopleKeys.tenant, queryFn: () => api.client.get<{ aiEnabled: boolean }>('/tenant'), staleTime: 60_000 });
  const usage = useQuery({
    queryKey: peopleKeys.ocrUsage,
    queryFn: () => api.client.get<OcrUsage>('/ocr/usage'),
    enabled: session.hasAnyPermission(['ocr.review', 'settings.manage', 'report.operational']),
    staleTime: 60_000,
    retry: false,
  });
  const loading = plan.isPending || tenant.isPending || (usage.isPending && usage.fetchStatus !== 'idle');
  let reason: 'PLAN' | 'DISABLED' | 'NOT_CONFIGURED' | 'LIMIT' | null = null;
  if (plan.data && plan.data.plan.features.aiAssistant === false) reason = 'PLAN';
  else if (usage.data && !usage.data.plan.includesAiAssistant) reason = 'PLAN';
  else if ((tenant.data && !tenant.data.aiEnabled) || (usage.data && !usage.data.aiEnabled)) reason = 'DISABLED';
  else if (usage.data && !usage.data.provider.configured) reason = 'NOT_CONFIGURED';
  else if (usage.data && usage.data.currentMonth.pagesRemaining !== null && usage.data.currentMonth.pagesRemaining <= 0) reason = 'LIMIT';
  return { loading, reason, usage: usage.data };
}

/**
 * AI document assistant: reads a document and SUGGESTS field values. Nothing it reads is used until a
 * person compared it with the document (review) and then chose which reviewed values to copy to the
 * profile (apply). The panel says "not verified" until that review exists.
 */
export function AiPanel({ document: doc }: { document: DocumentDetail }) {
  const { t, tn, formatDateTime } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const session = useSession();
  const describe = useErrorMessage();
  const queryClient = useQueryClient();
  const availability = useAiAvailability();
  const [profile, setProfile] = React.useState<(typeof PROFILES)[number]>('AUTO');
  const [refusal, setRefusal] = React.useState<string | null>(null);
  const canRun = session.hasPermission('ocr.run');
  const canSee = session.hasAnyPermission(['ocr.run', 'ocr.review']);
  const usable = !availability.loading && availability.reason === null;

  const extractions = useQuery({
    queryKey: peopleKeys.documents.extractions(doc.id),
    queryFn: () => api.client.get<Page<OcrSummary>>(`/documents/${doc.id}/extractions`),
    enabled: canSee,
    // A queued or running extraction is polled until it finishes.
    refetchInterval: (query) => (query.state.data?.data.some((r) => r.status === 'QUEUED' || r.status === 'PROCESSING') ? 2500 : false),
  });
  const latest = extractions.data?.data[0];

  const run = useMutation({
    mutationFn: () => api.client.post<OcrSummary>(`/documents/${doc.id}/extract`, { profile }),
    onMutate: () => setRefusal(null),
    onSuccess: async () => {
      toasts.success(t('people.documents.ai.queued'));
      await queryClient.invalidateQueries({ queryKey: peopleKeys.documents.extractions(doc.id) });
    },
    // The API explains why it refuses (assistant off, plan, consent withdrawn, file type): shown in the panel.
    onError: (error) => setRefusal(describe(error)),
  });

  if (!canSee) return null;

  if (availability.loading) {
    return (
      <Section title={t('people.documents.ai.title')}>
        <div className="space-y-2" role="status" aria-label={t('common.loading')}>
          <Skeleton className="h-4 w-64 max-w-full" />
          <Skeleton className="h-9 w-40" />
        </div>
      </Section>
    );
  }

  // Off or not configured: the tools are hidden and the reason is stated. Earlier results stay readable.
  if (!usable && !latest) {
    return (
      <Section title={t('people.documents.ai.title')}>
        <div className="flex gap-3 text-base text-muted-foreground">
          <Sparkles className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <div>
            <p className="font-medium text-foreground">{t(`people.documents.ai.off.${availability.reason}.title`)}</p>
            <p className="mt-0.5">{t(`people.documents.ai.off.${availability.reason}.text`)}</p>
            {availability.reason === 'PLAN' && session.hasPermission('subscription.manage') ? (
              <Button asChild variant="link" className="mt-1">
                <Link href="/subscription">{t('people.common.viewPlans')}</Link>
              </Button>
            ) : null}
            {availability.reason === 'DISABLED' && session.hasPermission('settings.manage') ? (
              <Button asChild variant="link" className="mt-1">
                <Link href="/settings">{t('people.documents.ai.openSettings')}</Link>
              </Button>
            ) : null}
          </div>
        </div>
      </Section>
    );
  }

  const running = latest && (latest.status === 'QUEUED' || latest.status === 'PROCESSING');
  const runnable = usable && canRun && doc.status === 'AVAILABLE' && doc.downloadable && !running;

  return (
    <Section
      title={t('people.documents.ai.title')}
      description={t('people.documents.ai.description')}
      action={latest ? <Badge tone={STATUS_TONE[latest.status] ?? 'neutral'}>{t(`people.documents.ai.status.${latest.status}`)}</Badge> : null}
    >
      <div className="space-y-5">
        {!usable && availability.reason ? <Alert tone="info">{t(`people.documents.ai.off.${availability.reason}.text`)}</Alert> : null}
        {refusal ? (
          <Alert tone="danger" live title={t('people.documents.ai.refused')}>
            {refusal}
          </Alert>
        ) : null}

        {runnable ? (
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ai-profile">{t('people.documents.ai.profile')}</Label>
              <Select id="ai-profile" className="w-64" value={profile} onValueChange={(v) => setProfile(v as (typeof PROFILES)[number])} options={PROFILES.map((p) => ({ value: p, label: t(`people.documents.ai.profiles.${p}`) }))} />
            </div>
            <Button variant={latest ? 'outline' : 'default'} onClick={() => run.mutate()} loading={run.isPending} loadingText={t('common.loading')}>
              <ScanText aria-hidden="true" />
              {latest ? t('people.documents.ai.runAgain') : t('people.documents.ai.run')}
            </Button>
            {availability.usage && availability.usage.currentMonth.pagesRemaining !== null ? (
              <p className="basis-full text-sm text-muted-foreground">{tn('people.documents.ai.pagesLeft', availability.usage.currentMonth.pagesRemaining)}</p>
            ) : null}
          </div>
        ) : null}

        {extractions.isError ? <LoadError error={extractions.error} onRetry={() => void extractions.refetch()} /> : null}

        {running ? (
          <p className="flex items-center gap-3 rounded-lg border bg-muted/40 p-4 text-base text-muted-foreground" role="status">
            <Spinner size="sm" />
            {t('people.documents.ai.working')}
          </p>
        ) : null}

        {latest?.status === 'FAILED' ? (
          <Alert tone="danger" title={t('people.documents.ai.failed')}>
            {latest.error ?? t('people.documents.ai.failedText')}
          </Alert>
        ) : null}

        {latest && (latest.status === 'COMPLETED' || latest.status === 'REVIEWED') ? <ExtractionReview key={`${latest.id}-${latest.status}-${latest.reviewedAt ?? ''}`} resultId={latest.id} documentId={doc.id} /> : null}

        {!latest && !runnable && usable && !extractions.isPending ? <p className="text-base text-muted-foreground">{doc.status === 'AVAILABLE' ? t('people.documents.ai.noneYet') : t('people.documents.ai.notAvailable')}</p> : null}

        {extractions.data && extractions.data.data.length > 1 ? (
          <p className="text-sm text-muted-foreground">{tn('people.documents.ai.earlier', extractions.data.data.length - 1, { when: formatDateTime(extractions.data.data[1].createdAt) })}</p>
        ) : null}
      </div>
    </Section>
  );
}

/** One extraction, side by side: what was read, what is on file, and what the reviewer read on the document. */
function ExtractionReview({ resultId, documentId }: { resultId: string; documentId: string }) {
  const { t, has, formatNumber, formatDateTime } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const session = useSession();
  const describe = useErrorMessage();
  const queryClient = useQueryClient();
  const canReview = session.hasPermission('ocr.review');

  const result = useQuery({ queryKey: peopleKeys.documents.extraction(resultId), queryFn: () => api.client.get<OcrResult>(`/ocr/results/${resultId}`) });
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [note, setNote] = React.useState('');
  const [selected, setSelected] = React.useState<string[]>([]);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState(false);

  const data = result.data;
  // Start the reviewer's column from the earlier review, else from what was read.
  React.useEffect(() => {
    if (!data) return;
    setValues(Object.fromEntries(data.fields.map((f) => [f.key, f.reviewed ? f.reviewed.value ?? '' : f.extracted?.value ?? ''])));
    setNote(data.reviewNote ?? '');
    setSelected([]);
    setEditing(data.status === 'COMPLETED');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.id, data?.status, data?.reviewedAt]);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: peopleKeys.documents.extraction(resultId) }),
      queryClient.invalidateQueries({ queryKey: peopleKeys.documents.detail(documentId) }),
      queryClient.invalidateQueries({ queryKey: peopleKeys.customers.all }),
    ]);
  };

  const review = useMutation({
    mutationFn: () => api.client.post<OcrResult>(`/ocr/results/${resultId}/review`, { fields: (data?.fields ?? []).map((f) => ({ key: f.key, value: values[f.key]?.trim() ? values[f.key].trim() : null })), ...(note.trim() ? { note: note.trim() } : {}) }),
    onMutate: () => {
      setErrors({});
      setFormError(null);
    },
    onSuccess: async () => {
      toasts.success(t('people.documents.ai.reviewSaved'));
      await refresh();
    },
    onError: (error) => {
      // 422 INVALID_REVIEW_VALUE names the fields by position: fields.<index>.value
      const byPath = fieldErrorsOf(error);
      const mapped: Record<string, string> = {};
      for (const [path, message] of Object.entries(byPath)) {
        const index = /^fields\.(\d+)\.value$/.exec(path)?.[1];
        const key = index !== undefined ? data?.fields[Number(index)]?.key : undefined;
        if (key) mapped[key] = message;
      }
      setErrors(mapped);
      setFormError(Object.keys(mapped).length ? (isApiError(error) ? error.message : describe(error)) : describe(error));
    },
  });

  const apply = useMutation({
    mutationFn: () => api.client.post<OcrResult>(`/ocr/results/${resultId}/apply`, { fields: selected }),
    onMutate: () => setFormError(null),
    onSuccess: async () => {
      toasts.success(t('people.documents.ai.applied'));
      await refresh();
    },
    onError: (error) => setFormError(describe(error)),
  });

  if (result.isPending) {
    return (
      <div className="space-y-2" role="status" aria-label={t('common.loading')}>
        <Skeleton className="h-10" />
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (result.isError || !data) return <LoadError error={result.error} onRetry={() => void result.refetch()} />;

  const reviewed = data.status === 'REVIEWED';
  const appliedKeys = new Set(data.applied.flatMap((a) => a.keys));
  const fieldLabel = (f: OcrField) => (has(`people.documents.ai.fields.${f.key}`) ? t(`people.documents.ai.fields.${f.key}`) : f.label);
  const applicable = (f: OcrField) => reviewed && !editing && f.canApply && !!f.reviewed && f.reviewed.decision !== 'REJECTED' && !!f.reviewed.value;
  const confidenceTone = (c: number): Tone => (c >= 0.9 ? 'success' : c >= 0.6 ? 'warning' : 'danger');

  return (
    <div className="space-y-4">
      {reviewed ? (
        <Alert tone="success" title={t('people.documents.ai.reviewedTitle')}>
          {t('people.documents.ai.reviewedText', { when: data.reviewedAt ? formatDateTime(data.reviewedAt) : '' })}
        </Alert>
      ) : (
        <Alert tone="warning" title={t('people.documents.ai.unverifiedTitle')}>
          {t('people.documents.ai.unverifiedText')}
        </Alert>
      )}

      {data.classification ? (
        <p className="text-sm text-muted-foreground">
          {t('people.documents.ai.classified', {
            type: has(`people.documents.ai.profiles.${data.classification}`) ? t(`people.documents.ai.profiles.${data.classification}`) : t('people.documents.ai.classUnknown'),
            confidence: data.classificationConfidence === null ? '–' : formatNumber(data.classificationConfidence, { style: 'percent', maximumFractionDigits: 0 }),
          })}
        </p>
      ) : null}

      {data.warnings.length ? (
        <ul className="space-y-2" aria-label={t('people.documents.ai.warnings')}>
          {data.warnings.map((w, i) => (
            <li key={`${w.code}-${i}`}>
              <Alert tone={SEVERITY_TONE[w.severity] ?? 'info'}>
                <span className="font-medium">{t(`people.documents.ai.severity.${w.severity in SEVERITY_TONE ? w.severity : 'LOW'}`)}: </span>
                {w.message}
                {w.suggestion ? <span className="mt-0.5 block text-sm">{t('people.documents.ai.suggestion')}</span> : null}
              </Alert>
            </li>
          ))}
        </ul>
      ) : null}

      {data.fields.length === 0 ? (
        <p className="text-base text-muted-foreground">{t('people.documents.ai.nothingRead')}</p>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <caption className="sr-only">{t('people.documents.ai.tableCaption')}</caption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {data.fields.some(applicable) ? <TableHead className="w-10" /> : null}
                <TableHead>{t('people.documents.ai.columns.field')}</TableHead>
                <TableHead>{t('people.documents.ai.columns.read')}</TableHead>
                <TableHead>{t('people.documents.ai.columns.onFile')}</TableHead>
                <TableHead className="min-w-48">{t('people.documents.ai.columns.yours')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.fields.map((f) => {
                const name = fieldLabel(f);
                const mismatch = f.onFile?.matches === false;
                return (
                  <TableRow key={f.key} className={cn('hover:bg-transparent', mismatch && 'bg-warning-soft/40 hover:bg-warning-soft/40')}>
                    {data.fields.some(applicable) ? (
                      <TableCell className="py-2 align-top">
                        {applicable(f) ? (
                          <Checkbox
                            aria-label={t('people.documents.ai.applyField', { field: name })}
                            checked={selected.includes(f.key)}
                            onCheckedChange={(v) => setSelected((list) => (v === true ? [...list, f.key] : list.filter((k) => k !== f.key)))}
                          />
                        ) : null}
                      </TableCell>
                    ) : null}
                    <TableCell className="py-2 align-top text-sm font-medium text-foreground">
                      {name}
                      {appliedKeys.has(f.key) ? <Badge tone="success" className="ms-2">{t('people.documents.ai.appliedBadge')}</Badge> : null}
                    </TableCell>
                    <TableCell className="py-2 align-top">
                      {f.extracted ? (
                        <>
                          <Ltr className="block break-all">{f.extracted.value}</Ltr>
                          <span className="mt-1 inline-flex flex-wrap items-center gap-1.5">
                            <Badge tone={confidenceTone(f.extracted.confidence)}>{t('people.documents.ai.confidence', { percent: formatNumber(f.extracted.confidence, { style: 'percent', maximumFractionDigits: 0 }) })}</Badge>
                            <span className="text-xs text-muted-foreground">{has(`people.documents.ai.sources.${f.extracted.source}`) ? t(`people.documents.ai.sources.${f.extracted.source}`) : f.extracted.source}</span>
                          </span>
                        </>
                      ) : (
                        <span className="text-sm text-muted-foreground">{t('people.documents.ai.notRead')}</span>
                      )}
                    </TableCell>
                    <TableCell className="py-2 align-top">
                      {f.onFile ? (
                        <>
                          {f.onFile.value ? <Ltr className="block break-all">{f.onFile.value}</Ltr> : <span className="text-sm text-muted-foreground">{t('people.documents.ai.nothingOnFile')}</span>}
                          {f.onFile.matches === true ? <Badge tone="success" className="mt-1">{t('people.documents.ai.matches')}</Badge> : null}
                          {mismatch ? <Badge tone="warning" className="mt-1">{t('people.documents.ai.differs')}</Badge> : null}
                        </>
                      ) : (
                        <span className="text-muted-foreground">–</span>
                      )}
                    </TableCell>
                    <TableCell className="py-2 align-top">
                      {editing && canReview ? (
                        <>
                          <Input
                            aria-label={t('people.documents.ai.yourReading', { field: name })}
                            value={values[f.key] ?? ''}
                            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                            aria-invalid={!!errors[f.key]}
                            autoComplete="off"
                            spellCheck={false}
                            dir="ltr"
                            className="tabular"
                          />
                          {errors[f.key] ? (
                            <p role="alert" className="mt-1 text-sm text-destructive-text">
                              {errors[f.key]}
                            </p>
                          ) : null}
                        </>
                      ) : f.reviewed ? (
                        <>
                          {f.reviewed.value ? <Ltr className="block break-all">{f.reviewed.value}</Ltr> : null}
                          <Badge tone={f.reviewed.decision === 'REJECTED' ? 'danger' : f.reviewed.decision === 'CONFIRMED' ? 'success' : 'info'} className="mt-1">
                            {t(`people.documents.ai.decisions.${f.reviewed.decision}`)}
                          </Badge>
                        </>
                      ) : (
                        <span className="text-sm text-muted-foreground">{t('people.documents.ai.notReviewed')}</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {formError ? (
        <Alert tone="danger" live>
          {formError}
        </Alert>
      ) : null}

      {canReview && data.fields.length ? (
        editing ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{t('people.documents.ai.reviewHint')}</p>
            <div className="space-y-1.5">
              <Label htmlFor={`ai-note-${resultId}`} optionalText={t('common.optional')}>
                {t('people.documents.ai.note')}
              </Label>
              <Textarea id={`ai-note-${resultId}`} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} dir="auto" />
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              {reviewed ? (
                <Button variant="outline" onClick={() => setEditing(false)} disabled={review.isPending}>
                  {t('common.cancel')}
                </Button>
              ) : null}
              <Button onClick={() => review.mutate()} loading={review.isPending} loadingText={t('common.saving')}>
                {t('people.documents.ai.saveReview')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-xl text-sm text-muted-foreground">{data.fields.some(applicable) ? t('people.documents.ai.applyHint') : t('people.documents.ai.nothingToApply')}</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setEditing(true)} disabled={apply.isPending}>
                {t('people.documents.ai.reviewAgain')}
              </Button>
              {data.fields.some(applicable) ? (
                <Button onClick={() => apply.mutate()} disabled={selected.length === 0} loading={apply.isPending} loadingText={t('common.saving')}>
                  {t('people.documents.ai.apply')}
                </Button>
              ) : null}
            </div>
          </div>
        )
      ) : !canReview ? (
        <p className="text-sm text-muted-foreground">{t('people.documents.ai.needsReviewer')}</p>
      ) : null}

      {data.reviewNote && !editing ? (
        <p className="text-sm text-muted-foreground" dir="auto">
          {t('people.documents.ai.noteShown', { note: data.reviewNote })}
        </p>
      ) : null}
    </div>
  );
}
