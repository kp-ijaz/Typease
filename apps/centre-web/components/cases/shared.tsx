'use client';

import * as React from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { isApiError } from '@typease/api-client';
import { STATUS_SOURCE_LABEL } from '@typease/types';
import type { RequestStatus } from '@typease/types';
import { Badge, describeError, useI18n, useSession, type I18nValue } from '@typease/ui';
import { keys } from '@/lib/query-keys';
import { caseKeys } from '@/lib/keys/cases';
import { useCasesApi } from './api';
import type { Bilingual, CaseView, StatusSource } from './types';

/** Statuses in the order a request normally travels: used to tell "forward" actions from steps back. */
const RANK: Record<RequestStatus, number> = {
  DRAFT: 0, SUBMITTED: 1, AWAITING_CUSTOMER: 1, UNDER_REVIEW: 2, QUOTED: 3, AWAITING_PAYMENT: 4, READY_FOR_PROCESSING: 5, IN_PREPARATION: 6,
  PENDING_APPROVAL: 7, READY_TO_SUBMIT: 8, EXTERNAL_PROCESSING: 9, RETURNED: 9, REJECTED: 9, FINAL_REVIEW: 10, COMPLETED: 11, CANCELLED: 12,
};
/** Statuses that are a detour, never the "next step" of a case. */
const DETOURS: RequestStatus[] = ['AWAITING_CUSTOMER', 'RETURNED', 'REJECTED', 'CANCELLED'];
const RESOLVE_FROM: RequestStatus[] = ['AWAITING_CUSTOMER', 'RETURNED', 'REJECTED'];

/** True when moving `from -> to` continues the case (as opposed to sending it back, asking the customer or cancelling). */
export function isForward(from: RequestStatus, to: RequestStatus): boolean {
  if (DETOURS.includes(to)) return false;
  if (from === 'COMPLETED') return false;
  if (RESOLVE_FROM.includes(from)) return true;
  return RANK[to] > RANK[from];
}

export const isClosed = (status: RequestStatus) => status === 'COMPLETED' || status === 'CANCELLED';

/** One case, kept fresh while a just-uploaded file is still in its security check. */
export function useCase(id: string, enabled = true) {
  const api = useCasesApi();
  return useQuery({
    queryKey: caseKeys.detail(id),
    queryFn: ({ signal }) => api.get(id, signal),
    enabled: enabled && !!id,
    refetchInterval: (query) => (query.state.data?.checklist.some((line) => line.document && (line.document.status === 'PENDING_SCAN' || line.document.status === 'PENDING_UPLOAD')) ? 3000 : false),
  });
}

/** After a successful action: show the answer at once, then refresh everything the action may have touched. */
export function applyCaseView(queryClient: QueryClient, view: CaseView | null | undefined, id: string) {
  if (view && typeof view === 'object' && 'allowedActions' in view) queryClient.setQueryData(caseKeys.detail(id), view);
  void queryClient.invalidateQueries({ queryKey: keys.requests.all });
  void queryClient.invalidateQueries({ queryKey: caseKeys.documents });
  void queryClient.invalidateQueries({ queryKey: caseKeys.tasks });
}
export function useApplyCase(id: string) {
  const queryClient = useQueryClient();
  return React.useCallback((view?: CaseView | null) => applyCaseView(queryClient, view, id), [queryClient, id]);
}

/**
 * The sentence for a failed case action. Guard codes of the state machine have
 * wording in both languages here (`cases.errors.<CODE>`); everything else falls
 * back to the shared wording and then to the API's own message.
 */
export function caseErrorText(error: unknown, i18n: Pick<I18nValue, 't' | 'has'>): string {
  if (isApiError(error) && i18n.has(`cases.errors.${error.code}`)) return i18n.t(`cases.errors.${error.code}`);
  return describeError(error, i18n);
}
export function useCaseError() {
  const i18n = useI18n();
  return React.useCallback((error: unknown) => caseErrorText(error, i18n), [i18n]);
}

/** Wording for a guard verdict (`blocked: { code, message }`): ours when we have it, else the API's sentence. */
export function blockedText(blocked: { code: string; message: string } | null | undefined, i18n: Pick<I18nValue, 't' | 'has'>): string {
  if (!blocked) return '';
  // Messages with figures (amounts, names of documents) are more useful than the generic sentence.
  if (/\d/.test(blocked.message) || !i18n.has(`cases.errors.${blocked.code}`)) return blocked.message;
  return i18n.t(`cases.errors.${blocked.code}`);
}

/** Button label of a transition: translated per edge, else the verb the API sends. */
export function transitionLabel(i18n: Pick<I18nValue, 't' | 'has'>, from: RequestStatus, to: RequestStatus, fallback: string): string {
  const key = `cases.transitions.${from}.${to}`;
  return i18n.has(key) ? i18n.t(key) : fallback;
}

/**
 * An external (authority / partner) status is never shown without where it comes from.
 * Use this wherever such a status is rendered.
 */
export function SourceLabel({ source, label, className }: { source: StatusSource; label?: Bilingual | null; className?: string }) {
  const { pick } = useI18n();
  const text = label ?? STATUS_SOURCE_LABEL[source] ?? STATUS_SOURCE_LABEL.STAFF_ENTERED;
  return (
    <Badge tone={source === 'VERIFIED_OFFICIAL' ? 'success' : source === 'PARTNER_PROVIDED' ? 'info' : 'warning'} className={className} data-status-source={source}>
      {pick(text.en, text.ar)}
    </Badge>
  );
}

/** GET /tenant (every staff member may read it): tells whether the centre switched the AI assistant on. */
export function useCentre() {
  const api = useCasesApi();
  return useQuery({ queryKey: caseKeys.centre, queryFn: () => api.centre(), staleTime: 5 * 60_000 });
}

const AI_UNAVAILABLE_CODES = new Set(['AI_DISABLED', 'INTEGRATION_NOT_CONFIGURED']);
/** The API says the assistant is switched off for the centre or has no OCR provider. */
export const isAiUnavailableError = (error: unknown) => isApiError(error) && AI_UNAVAILABLE_CODES.has(error.code);
const AI_OFF_KEY = ['ocr', 'switched-off'] as const;

/**
 * Whether the AI document assistant may be offered on this screen.
 * Hidden entirely when the role has no access, the centre switched AI off, or
 * the API reported that no OCR provider is configured.
 */
export function useAiAssistant() {
  const session = useSession();
  const api = useCasesApi();
  const queryClient = useQueryClient();
  const canRun = session.hasPermission('ocr.run');
  const canReview = session.hasPermission('ocr.review');
  const centre = useCentre();
  const mayAskUsage = canReview || session.hasPermission('settings.manage') || session.hasPermission('report.operational');
  const enabledByCentre = centre.data?.aiEnabled === true;
  const usage = useQuery({ queryKey: caseKeys.ocrUsage, queryFn: () => api.ocrUsage(), enabled: mayAskUsage && enabledByCentre && (canRun || canReview), staleTime: 5 * 60_000 });
  // Set when a call answered "switched off" / "not configured": the feature then disappears for this session.
  const off = useQuery({ queryKey: AI_OFF_KEY, queryFn: () => false, initialData: false, staleTime: Infinity });
  const reportUnavailable = React.useCallback(
    (error: unknown) => {
      if (isAiUnavailableError(error)) {
        queryClient.setQueryData(AI_OFF_KEY, true);
        return true;
      }
      return false;
    },
    [queryClient],
  );
  const configured = usage.data ? usage.data.aiEnabled && usage.data.provider.configured : true;
  const available = (canRun || canReview) && enabledByCentre && configured && !off.data && !(mayAskUsage && usage.isPending);
  return { available, canRun: available && canRun, canReview: available && canReview, reportUnavailable };
}

/** "2026-10-20T06:00:00.000Z" -> "2026-10-20" in the centre's time zone, for a DatePicker. */
export function isoToDateInput(value: string | null | undefined, timeZone: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * A calendar day chosen in a DatePicker -> the instant "end of that working day" (18:00) in the centre's
 * time zone, as the ISO date-time the API expects for a target date.
 */
export function dateInputToIso(day: string, timeZone: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  // Offset of the zone on that day, found by formatting noon UTC in the zone.
  const noon = new Date(`${day}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false, day: '2-digit' }).formatToParts(noon);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '12');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const zoneDay = Number(parts.find((p) => p.type === 'day')?.value ?? day.slice(8));
  let offsetMinutes = hour * 60 + minute - 12 * 60;
  if (zoneDay !== Number(day.slice(8))) offsetMinutes += zoneDay > Number(day.slice(8)) || zoneDay === 1 ? 24 * 60 : -24 * 60;
  return new Date(Date.parse(`${day}T18:00:00Z`) - offsetMinutes * 60_000).toISOString();
}

/** A recorded result is stored by the API as the status COMPLETED / RETURNED / REJECTED: show it in words. */
const EXTERNAL_RESULTS = new Set(['COMPLETED', 'RETURNED', 'REJECTED']);
export function externalStatusText(status: string, t: (key: string) => string): string {
  return EXTERNAL_RESULTS.has(status) ? t(`cases.external.outcomes.${status}`) : status;
}

/**
 * Whether a newer version of the request's workflow was published since the request started.
 * "Move to the current workflow" is only offered then (the API answers 409 otherwise).
 */
export function useNewerWorkflow(view: CaseView): { available: boolean; version: number | null } {
  const api = useCasesApi();
  const session = useSession();
  const definitionId = view.workflow.definition?.id ?? '';
  const allowed = view.allowedActions.other.includes('migrate_workflow') && !isClosed(view.status) && session.hasPermission('workflow.manage');
  const definition = useQuery({ queryKey: caseKeys.workflowDefinition(definitionId), queryFn: () => api.workflowDefinition(definitionId), enabled: allowed && !!definitionId, staleTime: 60_000 });
  const published = definition.data?.publishedVersionId ?? null;
  const available = allowed && !!published && !!view.workflow.versionId && published !== view.workflow.versionId;
  return { available, version: available ? definition.data?.publishedVersion?.version ?? null : null };
}
