'use client';

import * as React from 'react';
import type { ApiClient } from '@typease/api-client';
import type { Page } from '@typease/types';
import type {
  addChecklistItemSchema, assignRequestSchema, assignTaskSchema, createServiceRequestSchema, createTaskSchema, decideRequestApprovalSchema, documentVerifySchema,
  ocrReviewSchema, recordExternalReferenceSchema, recordExternalResultSchema, requestInformationSchema, updateExternalReferenceSchema, updateServiceRequestSchema, z,
} from '@typease/validation';
import { useApiClient } from '@typease/ui';
import type {
  CaseComment, CaseView, CentreSettings, ChecklistAssist, CreatedCase, CustomerDetail, DocumentDetail, DocumentRow, InvoiceRow, OcrResult, OcrRunSummary, OcrUsage,
  QuotationRow, ServiceFull, ServiceRow, SubmittedCase, TaskRow,
} from './types';

type In<T extends z.ZodTypeAny> = z.input<T>;

/**
 * Every endpoint the case screens call, typed. One function per endpoint of
 * docs/api/modules/{requests,documents,ocr,tasks,catalogue,finance,customers}.md
 * that this section uses: no guessed paths.
 */
export const casesApi = (c: ApiClient) => ({
  // ---- requests
  get: (id: string, signal?: AbortSignal) => c.get<CaseView>(`/requests/${id}`, { signal }),
  create: (body: In<typeof createServiceRequestSchema>) => c.post<CreatedCase>('/requests', body),
  update: (id: string, body: In<typeof updateServiceRequestSchema>) => c.patch<CaseView>(`/requests/${id}`, body),
  saveFields: (id: string, values: Record<string, unknown>) => c.put<CaseView>(`/requests/${id}/fields`, { values }),
  submit: (id: string) => c.post<SubmittedCase>(`/requests/${id}/submit`),
  transition: (id: string, body: { to: string; reason?: string; customerMessage?: string }) => c.post<CaseView>(`/requests/${id}/transition`, body),
  cancel: (id: string, reason: string) => c.post<CaseView>(`/requests/${id}/cancel`, { reason }),
  reopen: (id: string, reason: string) => c.post<CaseView>(`/requests/${id}/reopen`, { reason }),
  complete: (id: string) => c.post<CaseView>(`/requests/${id}/complete`),
  markDuplicate: (id: string, duplicateOfId: string) => c.post<CaseView>(`/requests/${id}/mark-duplicate`, { duplicateOfId }),
  requestInformation: (id: string, body: In<typeof requestInformationSchema>) => c.post<CaseView>(`/requests/${id}/request-information`, body),
  resubmit: (id: string, note?: string) => c.post<CaseView>(`/requests/${id}/resubmit`, note ? { note } : {}),
  comments: (id: string) => c.get<CaseComment[]>(`/requests/${id}/comments`),
  addComment: (id: string, body: { body: string; visibility: 'INTERNAL' | 'CUSTOMER' }) => c.post<CaseComment>(`/requests/${id}/comments`, body),
  assign: (id: string, body: In<typeof assignRequestSchema>) => c.post<CaseView>(`/requests/${id}/assign`, body),
  autoAssign: (id: string) => c.post<CaseView & { autoAssignment?: { chosen?: { name?: string } | null } }>(`/requests/${id}/auto-assign`),
  addChecklistItem: (id: string, body: In<typeof addChecklistItemSchema>) => c.post<CaseView>(`/requests/${id}/checklist`, body),
  waiveChecklistItem: (id: string, itemId: string, reason: string) => c.post<CaseView>(`/requests/${id}/checklist/${itemId}/waive`, { reason }),
  linkDocument: (id: string, itemId: string, documentId: string) => c.put<CaseView>(`/requests/${id}/checklist/${itemId}/document`, { documentId }),
  unlinkDocument: (id: string, itemId: string) => c.delete<CaseView>(`/requests/${id}/checklist/${itemId}/document`),
  decideApproval: (id: string, approvalId: string, body: In<typeof decideRequestApprovalSchema>) => c.post<CaseView>(`/requests/${id}/approvals/${approvalId}/decide`, body),
  recordSubmission: (id: string, body: In<typeof recordExternalReferenceSchema>) => c.post<CaseView>(`/requests/${id}/external-references`, body),
  updateExternalReference: (id: string, refId: string, body: In<typeof updateExternalReferenceSchema>) => c.patch<CaseView>(`/requests/${id}/external-references/${refId}`, body),
  recordExternalResult: (id: string, body: In<typeof recordExternalResultSchema>) => c.post<CaseView>(`/requests/${id}/external-result`, body),
  completeStep: (id: string, note?: string) => c.post<CaseView>(`/requests/${id}/workflow/complete-step`, note ? { note } : {}),
  migrateWorkflow: (id: string) => c.post<CaseView & { migration?: { fromVersion: number; toVersion: number } }>(`/requests/${id}/workflow/migrate`),
  search: (query: Record<string, string | number | undefined>, signal?: AbortSignal) =>
    c.get<Page<{ id: string; requestNo: string; status: string; serviceName: string; customerName: string; createdAt: string }>>('/requests', { query, signal }),

  // ---- documents
  checklistAssist: (requestId: string) => c.get<ChecklistAssist>('/documents/checklist-assist', { query: { requestId } }),
  requestDocuments: (requestId: string) => c.get<Page<DocumentRow>>('/documents', { query: { requestId, pageSize: 100, sort: 'createdAt:desc' } }),
  document: (id: string) => c.get<DocumentDetail>(`/documents/${id}`),
  verifyDocument: (id: string, body: In<typeof documentVerifySchema>) => c.post<DocumentRow>(`/documents/${id}/verify`, body),

  // ---- AI document assistant
  ocrUsage: () => c.get<OcrUsage>('/ocr/usage'),
  ocrRuns: (documentId: string) => c.get<Page<OcrRunSummary>>(`/documents/${documentId}/extractions`),
  ocrExtract: (documentId: string) => c.post<OcrRunSummary>(`/documents/${documentId}/extract`, {}),
  ocrResult: (id: string) => c.get<OcrResult>(`/ocr/results/${id}`),
  ocrReview: (id: string, body: In<typeof ocrReviewSchema>) => c.post<OcrResult>(`/ocr/results/${id}/review`, body),
  ocrApply: (id: string, fields: string[]) => c.post<OcrResult>(`/ocr/results/${id}/apply`, { fields }),

  // ---- catalogue, customers, finance (read side), centre
  services: () => c.get<Page<ServiceRow>>('/services', { query: { pageSize: 100, sort: 'sortOrder:asc', isActive: true } }),
  serviceFull: (id: string, query: { branchId?: string; corporateAccountId?: string }) => c.get<ServiceFull>(`/services/${id}/full`, { query }),
  customer: (id: string) => c.get<CustomerDetail>(`/customers/${id}`),
  corporateAccount: (id: string) => c.get<{ id: string; accountNo: string; companyName: string; companyNameAr: string | null; status: string }>(`/corporate-accounts/${id}`),
  quotations: (requestId: string) => c.get<Page<QuotationRow>>('/quotations', { query: { requestId, pageSize: 20, sort: 'createdAt:desc' } }),
  invoices: (requestId: string) => c.get<Page<InvoiceRow>>('/invoices', { query: { requestId, pageSize: 20, sort: 'createdAt:desc' } }),
  centre: () => c.get<CentreSettings>('/tenant'),
  /** The workflow a request follows: only read to know whether a newer version was published. */
  workflowDefinition: (id: string) => c.get<{ id: string; publishedVersionId: string | null; publishedVersion?: { id: string; version: number } | null }>(`/workflows/${id}`),

  // ---- tasks
  tasks: (query: Record<string, string | number | boolean | undefined>, signal?: AbortSignal) => c.get<Page<TaskRow>>('/tasks', { query, signal }),
  myTasks: (query: Record<string, string | number | boolean | undefined>, signal?: AbortSignal) => c.get<Page<TaskRow> & { overdueCount: number }>('/tasks/mine', { query, signal }),
  createTask: (body: In<typeof createTaskSchema>) => c.post<TaskRow>('/tasks', body),
  assignTask: (id: string, body: In<typeof assignTaskSchema>) => c.put<TaskRow>(`/tasks/${id}/assignees`, body),
  claimTask: (id: string) => c.post<TaskRow>(`/tasks/${id}/claim`),
  setTaskStatus: (id: string, status: 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED', reason?: string) => c.post<TaskRow>(`/tasks/${id}/status`, reason ? { status, reason } : { status }),
});
export type CasesApi = ReturnType<typeof casesApi>;

export function useCasesApi(): CasesApi {
  const client = useApiClient();
  return React.useMemo(() => casesApi(client), [client]);
}
