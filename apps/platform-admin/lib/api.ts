'use client';

import * as React from 'react';
import type { ApiClient } from '@typease/api-client';
import type { Page } from '@typease/types';
import { useApiClient, type ListParams } from '@typease/ui';
import type {
  AccessGrant, ApprovedProviders, AuditEntry, AuditEntryDetail, AuthorisationRecord, BillingHistory, Coupon, FailedPaymentRow, FailedPaymentTotals, FeatureFlag, FlagOverride, PlanChangeResult,
  PlanDistributionReport, PlatformDashboard, PlatformIncident, PlatformPlan, PlatformSetting, PlatformStaffMember, PlatformTicket, ProcessorRecord, SecurityEvent, SecuritySummary,
  SubscriptionRevenueReport, SubscriptionRow, SystemHealth, SystemProviders, TenantCreated, TenantDetail, TenantFlag, TenantGrowthReport, TenantRow, UsageReport,
} from './types';

type Query = Record<string, string | number | boolean | undefined | null>;

/**
 * Typed endpoints of the platform console. Every path is a `Platform(...)` route of
 * docs/api/ENDPOINTS.md: centre-level metadata only. Nothing here reads a centre's
 * customers, documents or cases. A support session is only ever opened through `access.enter`, in the centre's own app.
 */
export const platformApi = (c: ApiClient) => ({
  client: c,

  // ---- dashboard and SaaS reports (platform.metrics.read)
  dashboard: (signal?: AbortSignal) => c.get<PlatformDashboard>('/platform/dashboard', { signal }),
  // ---- system status (platform.metrics.read): read-only, nothing is contacted that costs anything
  system: {
    health: (signal?: AbortSignal) => c.get<SystemHealth>('/platform/system/health', { signal }),
    providers: (signal?: AbortSignal) => c.get<SystemProviders>('/platform/system/providers', { signal }),
  },
  reports: {
    tenantGrowth: (signal?: AbortSignal) => c.get<TenantGrowthReport>('/platform/reports/tenant-growth', { signal }),
    revenue: (signal?: AbortSignal) => c.get<SubscriptionRevenueReport>('/platform/reports/subscription-revenue', { signal }),
    planDistribution: (signal?: AbortSignal) => c.get<PlanDistributionReport>('/platform/reports/plan-distribution', { signal }),
    usage: (signal?: AbortSignal) => c.get<UsageReport>('/platform/reports/usage', { signal }),
    failedPayments: (query: ListParams | Query, signal?: AbortSignal) => c.get<Page<FailedPaymentRow> & { totals: FailedPaymentTotals }>('/platform/reports/failed-payments', { query, signal }),
  },

  // ---- centres
  tenants: {
    list: (query: ListParams | Query, signal?: AbortSignal) => c.get<Page<TenantRow>>('/platform/tenants', { query, signal }),
    get: (id: string, signal?: AbortSignal) => c.get<TenantDetail>(`/platform/tenants/${id}`, { signal }),
    create: (body: unknown) => c.post<TenantCreated>('/platform/tenants', body),
    resendOwnerInvitation: (id: string) => c.post<{ email: string; status: string }>(`/platform/tenants/${id}/owner-invitation`),
    approve: (id: string, body: { note?: string }) => c.post<TenantDetail>(`/platform/tenants/${id}/approve`, body),
    reject: (id: string, body: { reason: string }) => c.post<TenantDetail>(`/platform/tenants/${id}/reject`, body),
    suspend: (id: string, body: { reason: string }) => c.post<TenantDetail>(`/platform/tenants/${id}/suspend`, body),
    reactivate: (id: string, body: { note?: string }) => c.post<TenantDetail>(`/platform/tenants/${id}/reactivate`, body),
    archive: (id: string, body: { reason: string }) => c.post<TenantDetail>(`/platform/tenants/${id}/archive`, body),
    offboard: (id: string, body: unknown) => c.post<TenantDetail>(`/platform/tenants/${id}/offboard`, body),
    cancelOffboarding: (id: string, body: { reason: string }) => c.post<TenantDetail>(`/platform/tenants/${id}/cancel-offboarding`, body),
    flags: (id: string, signal?: AbortSignal) => c.get<TenantFlag[]>(`/platform/tenants/${id}/feature-flags`, { signal }),
    setFlag: (id: string, flag: string, body: { enabled: boolean }) => c.put<TenantFlag>(`/platform/tenants/${id}/feature-flags/${encodeURIComponent(flag)}`, body),
    clearFlag: (id: string, flag: string) => c.delete<TenantFlag>(`/platform/tenants/${id}/feature-flags/${encodeURIComponent(flag)}`),
  },

  // ---- plans, coupons, SaaS billing
  plans: {
    list: (signal?: AbortSignal) => c.get<PlatformPlan[]>('/platform/plans', { signal }),
    create: (body: unknown) => c.post<PlatformPlan>('/platform/plans', body),
    update: (id: string, body: unknown) => c.patch<PlatformPlan>(`/platform/plans/${id}`, body),
    remove: (id: string) => c.delete<{ status: string }>(`/platform/plans/${id}`),
  },
  coupons: {
    list: (signal?: AbortSignal) => c.get<Coupon[]>('/platform/coupons', { signal }),
    create: (body: unknown) => c.post<Coupon>('/platform/coupons', body),
    update: (id: string, body: unknown) => c.patch<Coupon>(`/platform/coupons/${id}`, body),
    remove: (id: string) => c.delete<{ status: string }>(`/platform/coupons/${id}`),
  },
  billing: {
    subscriptions: (query: ListParams | Query, signal?: AbortSignal) => c.get<Page<SubscriptionRow>>('/platform/billing/subscriptions', { query, signal }),
    history: (tenantId: string, signal?: AbortSignal) => c.get<BillingHistory>(`/platform/billing/tenants/${tenantId}`, { signal }),
    changePlan: (tenantId: string, body: unknown) => c.post<PlanChangeResult>(`/platform/billing/tenants/${tenantId}/change-plan`, body),
    extendTrial: (tenantId: string, body: unknown) => c.post<BillingHistory>(`/platform/billing/tenants/${tenantId}/extend-trial`, body),
    applyCoupon: (tenantId: string, body: { code: string }) => c.post<BillingHistory>(`/platform/billing/tenants/${tenantId}/coupon`, body),
    payOffline: (invoiceId: string, body: unknown) => c.post<BillingHistory>(`/platform/billing/invoices/${invoiceId}/pay-offline`, body),
    voidInvoice: (invoiceId: string, body: { reason: string }) => c.post<BillingHistory>(`/platform/billing/invoices/${invoiceId}/void`, body),
    invoicePdfPath: (tenantId: string, invoiceId: string) => `/platform/billing/tenants/${tenantId}/invoices/${invoiceId}/pdf`,
  },

  // ---- support desk
  tickets: {
    list: (query: ListParams | Query, signal?: AbortSignal) => c.get<Page<PlatformTicket>>('/platform/support/tickets', { query, signal }),
    get: (id: string, signal?: AbortSignal) => c.get<PlatformTicket>(`/platform/support/tickets/${id}`, { signal }),
    reply: (id: string, body: unknown) => c.post<PlatformTicket>(`/platform/support/tickets/${id}/messages`, body),
    update: (id: string, body: unknown) => c.patch<PlatformTicket>(`/platform/support/tickets/${id}`, body),
  },

  // ---- support access (request, follow, withdraw: the centre decides)
  access: {
    list: (query: ListParams | Query, signal?: AbortSignal) => c.get<Page<AccessGrant>>('/platform/access-grants', { query, signal }),
    get: (id: string, signal?: AbortSignal) => c.get<AccessGrant>(`/platform/access-grants/${id}`, { signal }),
    request: (tenantId: string, body: unknown) => c.post<AccessGrant>(`/platform/tenants/${tenantId}/access-grants`, body),
    revoke: (id: string) => c.post<AccessGrant>(`/platform/access-grants/${id}/revoke`),
    /**
     * Opens an approved, current grant for its requester. The answer carries tokens for API
     * clients and a one-time hand-off for the browser; the console uses `handoff.url` only
     * (the code sits in its fragment) and keeps nothing of the answer.
     */
    enter: (id: string) => c.post<{ handoff: { url: string; expiresAt: string } }>(`/platform/access-grants/${id}/enter`),
  },

  // ---- feature flags and platform settings
  flags: {
    list: (signal?: AbortSignal) => c.get<FeatureFlag[]>('/platform/feature-flags', { signal }),
    set: (flag: string, body: { enabled: boolean; payload?: Record<string, unknown> }) => c.put<FeatureFlag>(`/platform/feature-flags/${encodeURIComponent(flag)}`, body),
    remove: (flag: string) => c.delete<{ status: string }>(`/platform/feature-flags/${encodeURIComponent(flag)}`),
    overrides: (flag: string, signal?: AbortSignal) => c.get<FlagOverride[]>(`/platform/feature-flags/${encodeURIComponent(flag)}/overrides`, { signal }),
  },
  settings: {
    list: (signal?: AbortSignal) => c.get<PlatformSetting[]>('/platform/settings', { signal }),
    set: (name: string, value: unknown) => c.put<PlatformSetting>(`/platform/settings/${encodeURIComponent(name)}`, { value }),
    reset: (name: string) => c.delete<PlatformSetting>(`/platform/settings/${encodeURIComponent(name)}`),
  },

  // ---- platform staff
  staff: {
    list: (query?: Query, signal?: AbortSignal) => c.get<PlatformStaffMember[]>('/platform/staff', { query, signal }),
    create: (body: unknown) => c.post<PlatformStaffMember>('/platform/staff', body),
    update: (id: string, body: unknown) => c.patch<PlatformStaffMember>(`/platform/staff/${id}`, body),
    resendInvitation: (id: string) => c.post<{ status: string; email: string }>(`/platform/staff/${id}/invitation`),
    disable: (id: string) => c.post<PlatformStaffMember>(`/platform/staff/${id}/disable`),
    enable: (id: string) => c.post<PlatformStaffMember>(`/platform/staff/${id}/enable`),
  },

  // ---- audit and security
  audit: {
    list: (query: ListParams | Query, signal?: AbortSignal) => c.get<Page<AuditEntry>>('/platform/audit-logs', { query, signal }),
    get: (id: string, signal?: AbortSignal) => c.get<AuditEntryDetail>(`/platform/audit-logs/${id}`, { signal }),
  },
  security: {
    list: (query: ListParams | Query, signal?: AbortSignal) => c.get<Page<SecurityEvent>>('/platform/security-events', { query, signal }),
    summary: (signal?: AbortSignal) => c.get<SecuritySummary>('/platform/security-events/summary', { signal }),
  },
  incidents: {
    list: (query: ListParams | Query, signal?: AbortSignal) => c.get<Page<PlatformIncident>>('/platform/privacy/incidents', { query, signal }),
    create: (body: unknown) => c.post<PlatformIncident>('/platform/privacy/incidents', body),
    update: (id: string, body: unknown) => c.patch<PlatformIncident>(`/platform/privacy/incidents/${id}`, body),
    setStatus: (id: string, body: unknown) => c.post<PlatformIncident>(`/platform/privacy/incidents/${id}/status`, body),
  },
  processors: {
    list: (query: ListParams | Query, signal?: AbortSignal) => c.get<Page<ProcessorRecord>>('/platform/privacy/processors', { query, signal }),
    create: (body: unknown) => c.post<ProcessorRecord>('/platform/privacy/processors', body),
    review: (id: string, body: unknown) => c.post<ProcessorRecord>(`/platform/privacy/processors/${id}/review`, body),
    remove: (id: string) => c.delete<unknown>(`/platform/privacy/processors/${id}`),
  },

  // ---- integrations (authorisation records of centres, approved providers)
  integrations: {
    authorisations: (query: ListParams | Query, signal?: AbortSignal) => c.get<Page<AuthorisationRecord>>('/platform/integrations/authorisations', { query, signal }),
    verify: (id: string, body: { note?: string }) => c.post<AuthorisationRecord>(`/platform/integrations/authorisations/${id}/verify`, body),
    reject: (id: string, body: { note: string }) => c.post<AuthorisationRecord>(`/platform/integrations/authorisations/${id}/reject`, body),
    approvedProviders: (signal?: AbortSignal) => c.get<ApprovedProviders>('/platform/integrations/approved-providers', { signal }),
    setApprovedProviders: (providers: string[] | null) => c.put<ApprovedProviders>('/platform/integrations/approved-providers', { providers }),
  },
});

export type PlatformApi = ReturnType<typeof platformApi>;

export function usePlatformApi(): PlatformApi {
  const client = useApiClient();
  return React.useMemo(() => platformApi(client), [client]);
}
