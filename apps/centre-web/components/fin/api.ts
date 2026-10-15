'use client';

import * as React from 'react';
import type { ApiClient } from '@typease/api-client';
import type { Page } from '@typease/types';
import { useApiClient, type ListParams } from '@typease/ui';
import type {
  AuditEntry, AuditEntryDetail, CorporateStatement, CreditNoteCreated, CreditNoteRow, CustomerBrief, DashboardResponse, DashboardTrends, ExpensePage, ExpenseRow, FeeComponentsResponse,
  InvoiceDetail, InvoiceRow, LiabilitiesResponse, PaymentDetail, PaymentLink, PaymentRow, PlanChangeResult, PlanStartResult, QuotationDecision, QuotationDetail, QuotationRow,
  ReconciliationDetail, ReconciliationRow, RefundRow, ReportCatalogue, ReportDrilldown, ReportResult, RequestBrief, ScheduledReportRow, ScheduledRun, SubscriptionCheckout,
  SubscriptionInvoiceRow, SubscriptionView, TenantProfile,
} from './types';

type Query = Record<string, string | number | boolean | undefined | null>;

/**
 * Typed endpoints of the "fin" section. Paths and shapes follow docs/api/modules
 * (finance, reports, dashboard, subscriptions, audit). Payments and refunds take the
 * idempotency key of the form that sends them.
 */
export const finApi = (c: ApiClient) => ({
  client: c,

  // ---- quotations
  quotations: {
    list: (query: ListParams, signal?: AbortSignal) => c.get<Page<QuotationRow>>('/quotations', { query, signal }),
    get: (id: string, signal?: AbortSignal) => c.get<QuotationDetail>(`/quotations/${id}`, { signal }),
    create: (body: unknown) => c.post<QuotationDetail>('/quotations', body),
    fromRequest: (requestId: string, body: unknown) => c.post<QuotationDetail>(`/quotations/from-request/${requestId}`, body),
    update: (id: string, body: unknown) => c.patch<QuotationDetail>(`/quotations/${id}`, body),
    approveDiscount: (id: string, body: { note?: string | null }) => c.post<QuotationDetail>(`/quotations/${id}/discount/approve`, body),
    rejectDiscount: (id: string, body: { reason: string; clearDiscounts: boolean }) => c.post<QuotationDetail>(`/quotations/${id}/discount/reject`, body),
    send: (id: string) => c.post<QuotationDetail>(`/quotations/${id}/send`),
    cancel: (id: string, body: { reason?: string | null }) => c.post<QuotationDetail>(`/quotations/${id}/cancel`, body),
    approve: (id: string, body: { note: string }) => c.post<QuotationDecision>(`/quotations/${id}/approve`, body),
    reject: (id: string, body: { reason: string }) => c.post<QuotationDetail>(`/quotations/${id}/reject`, body),
    pdfPath: (id: string) => `/quotations/${id}/pdf`,
  },

  // ---- invoices
  invoices: {
    list: (query: ListParams | Query, signal?: AbortSignal) => c.get<Page<InvoiceRow>>('/invoices', { query, signal }),
    get: (id: string, signal?: AbortSignal) => c.get<InvoiceDetail>(`/invoices/${id}`, { signal }),
    create: (body: unknown) => c.post<InvoiceDetail>('/invoices', body),
    update: (id: string, body: unknown) => c.patch<InvoiceDetail>(`/invoices/${id}`, body),
    issue: (id: string) => c.post<InvoiceDetail>(`/invoices/${id}/issue`),
    void: (id: string, body: { reason: string }) => c.post<InvoiceDetail>(`/invoices/${id}/void`, body),
    /** Online payment link at the centre's gateway. 503 INTEGRATION_NOT_CONFIGURED when there is none. */
    pay: (id: string, body: { amount?: string }, idempotencyKey: string) => c.post<PaymentLink>(`/invoices/${id}/pay`, body, { idempotencyKey }),
    pdfPath: (id: string) => `/invoices/${id}/pdf`,
    corporateStatement: (accountId: string, signal?: AbortSignal) => c.get<CorporateStatement>(`/finance/corporate-accounts/${accountId}/statement`, { signal }),
  },

  // ---- payments
  payments: {
    list: (query: ListParams | Query, signal?: AbortSignal) => c.get<Page<PaymentRow>>('/payments', { query, signal }),
    get: (id: string, signal?: AbortSignal) => c.get<PaymentDetail>(`/payments/${id}`, { signal }),
    record: (body: unknown, idempotencyKey: string) => c.post<PaymentRow>('/payments', body, { idempotencyKey }),
    receiptPath: (id: string) => `/payments/${id}/receipt/pdf`,
  },

  // ---- refunds
  refunds: {
    list: (query: ListParams | Query, signal?: AbortSignal) => c.get<Page<RefundRow>>('/refunds', { query, signal }),
    get: (id: string, signal?: AbortSignal) => c.get<RefundRow>(`/refunds/${id}`, { signal }),
    request: (body: unknown, idempotencyKey: string) => c.post<RefundRow>('/refunds', body, { idempotencyKey }),
    approve: (id: string, body: { cancelCharge?: boolean; reference?: string | null }) => c.post<RefundRow>(`/refunds/${id}/approve`, body),
    reject: (id: string, body: { reason: string }) => c.post<RefundRow>(`/refunds/${id}/reject`, body),
    complete: (id: string, body: { reference: string }) => c.post<RefundRow>(`/refunds/${id}/complete`, body),
    process: (id: string) => c.post<RefundRow>(`/refunds/${id}/process`),
  },

  // ---- credit notes
  creditNotes: {
    list: (query: Query, signal?: AbortSignal) => c.get<Page<CreditNoteRow>>('/credit-notes', { query, signal }),
    create: (body: unknown) => c.post<CreditNoteCreated>('/credit-notes', body),
    pdfPath: (id: string) => `/credit-notes/${id}/pdf`,
  },

  // ---- expenses, liabilities, reconciliation, settings
  expenses: {
    list: (query: ListParams, signal?: AbortSignal) => c.get<ExpensePage>('/expenses', { query, signal }),
    create: (body: unknown) => c.post<ExpenseRow & { liabilitySettled?: unknown }>('/expenses', body),
    update: (id: string, body: unknown) => c.patch<ExpenseRow>(`/expenses/${id}`, body),
    remove: (id: string) => c.delete<{ status: 'DELETED'; remittanceReversed?: boolean }>(`/expenses/${id}`),
  },
  liabilities: (query: Query, signal?: AbortSignal) => c.get<LiabilitiesResponse>('/finance/liabilities', { query, signal }),
  reconciliations: {
    list: (query: ListParams, signal?: AbortSignal) => c.get<Page<ReconciliationRow>>('/reconciliations', { query, signal }),
    get: (id: string, signal?: AbortSignal) => c.get<ReconciliationDetail>(`/reconciliations/${id}`, { signal }),
    create: (body: unknown) => c.post<ReconciliationDetail>('/reconciliations', body),
    update: (id: string, body: unknown) => c.patch<ReconciliationDetail>(`/reconciliations/${id}`, body),
    attach: (id: string, paymentIds: string[]) => c.post<ReconciliationDetail>(`/reconciliations/${id}/payments`, { paymentIds }),
    detach: (id: string, paymentIds: string[]) => c.post<ReconciliationDetail>(`/reconciliations/${id}/payments/remove`, { paymentIds }),
    close: (id: string, body: { notes?: string | null }) => c.post<ReconciliationDetail>(`/reconciliations/${id}/close`, body),
  },
  feeComponents: {
    get: (signal?: AbortSignal) => c.get<FeeComponentsResponse>('/finance/fee-components', { signal }),
    update: (body: unknown) => c.put<FeeComponentsResponse>('/finance/fee-components', body),
  },
  tenant: (signal?: AbortSignal) => c.get<TenantProfile>('/tenant', { signal }),
  /** Needs integration.manage: the centre's ACTIVE payment gateways. */
  paymentGateways: (signal?: AbortSignal) => c.get<Array<{ id: string; provider: string; name: string; status: string; mode: string }>>('/integrations', { query: { category: 'PAYMENT', status: 'ACTIVE' }, signal }),
  requestBrief: (id: string, signal?: AbortSignal) => c.get<RequestBrief>(`/requests/${id}`, { signal }),
  customerBrief: (id: string, signal?: AbortSignal) => c.get<CustomerBrief>(`/customers/${id}`, { signal }),

  // ---- dashboard
  dashboard: (query: Query, signal?: AbortSignal) => c.get<DashboardResponse>('/dashboard', { query, signal }),
  dashboardTrends: (query: Query, signal?: AbortSignal) => c.get<DashboardTrends>('/dashboard/trends', { query, signal }),

  // ---- reports
  reports: {
    catalogue: (signal?: AbortSignal) => c.get<ReportCatalogue>('/reports', { signal }),
    run: (key: string, query: Query, signal?: AbortSignal) => c.get<ReportResult>(`/reports/${key}`, { query, signal }),
    drilldown: (key: string, query: Query, signal?: AbortSignal) => c.get<ReportDrilldown>(`/reports/${key}/drilldown`, { query, signal }),
    exportPath: (key: string) => `/reports/${key}/export`,
    scheduled: (query: Query, signal?: AbortSignal) => c.get<Page<ScheduledReportRow>>('/reports/scheduled', { query, signal }),
    schedule: (id: string, signal?: AbortSignal) => c.get<ScheduledReportRow>(`/reports/scheduled/${id}`, { signal }),
    createSchedule: (body: unknown) => c.post<ScheduledReportRow>('/reports/scheduled', body),
    updateSchedule: (id: string, body: unknown) => c.patch<ScheduledReportRow>(`/reports/scheduled/${id}`, body),
    deleteSchedule: (id: string) => c.delete<{ status: 'DELETED' }>(`/reports/scheduled/${id}`),
    runs: (id: string, query: Query, signal?: AbortSignal) => c.get<Page<ScheduledRun>>(`/reports/scheduled/${id}/runs`, { query, signal }),
  },

  // ---- subscription (works while the centre is suspended)
  subscription: {
    get: (signal?: AbortSignal) => c.get<SubscriptionView>('/subscription', { signal }),
    invoices: (query: ListParams, signal?: AbortSignal) => c.get<Page<SubscriptionInvoiceRow>>('/subscription/invoices', { query, signal }),
    invoicePdfPath: (id: string) => `/subscription/invoices/${id}/pdf`,
    pay: (id: string) => c.post<SubscriptionCheckout>(`/subscription/invoices/${id}/pay`),
    changePlan: (body: { planKey: string; billingCycle?: string }) => c.post<PlanChangeResult>('/subscription/change-plan', body),
    restart: (body: { planKey: string; billingCycle: string; couponCode?: string }) => c.post<PlanStartResult>('/subscription/restart', body),
    cancel: (body: { reason: string }) => c.post<SubscriptionView>('/subscription/cancel', body),
    resume: () => c.post<SubscriptionView>('/subscription/resume'),
    coupon: (body: { code: string }) => c.post<SubscriptionView>('/subscription/coupon', body),
  },

  // ---- audit
  audit: {
    list: (query: ListParams, signal?: AbortSignal) => c.get<Page<AuditEntry>>('/audit-logs', { query, signal }),
    get: (id: string, signal?: AbortSignal) => c.get<AuditEntryDetail>(`/audit-logs/${id}`, { signal }),
    exportPath: '/audit-logs/export',
  },
});
export type FinApi = ReturnType<typeof finApi>;

export function useFinApi(): FinApi {
  const client = useApiClient();
  return React.useMemo(() => finApi(client), [client]);
}
