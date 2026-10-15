'use client';

import * as React from 'react';
import type { ApiClient, RequestCounts, RequestListItem } from '@typease/api-client';
import type { Page } from '@typease/types';
import type {
  customerReplySchema, feedbackSchema, notificationPreferencesSchema, openTicketSchema, ownConsentsSchema, privacyRequestSchema, updateOwnCustomerSchema, z,
} from '@typease/validation';
import { useApiClient } from '@typease/ui';
import type {
  AppointmentRow, Availability, BranchDirectoryEntry, Catalogue, CatalogueServiceDetail, CheckoutSession, ChecklistAssist, ConsentState, CreatedRequest, DocumentRow, DocumentType,
  FeedbackEntry, Inbox, InvoiceDetail, InvoiceRow, NotificationPreferences, OwnCustomer, PaymentDetail, PaymentRow, PrivacyRequest, QuotationApproval, QuotationDetail, QuotationRow,
  ReminderRow, RequestComment, RequestView, SubmittedRequest, TicketDetail, TicketRow,
} from './types';

type In<T extends z.ZodTypeAny> = z.input<T>;
type Query = Record<string, string | number | boolean | undefined>;

/**
 * Every endpoint the signed-in part of the portal calls, typed. All of them are
 * routes a customer may use (`self.*`, "any tenant member" or "member kind CUSTOMER"
 * in docs/api/ENDPOINTS.md): no staff routes, no guessed paths.
 */
export const portalApi = (c: ApiClient) => ({
  // ---- catalogue (signed in: includes the form and the checklist of a service)
  catalogue: (signal?: AbortSignal) => c.get<Catalogue>('/catalogue', { signal }),
  service: (id: string) => c.get<CatalogueServiceDetail>(`/catalogue/${id}`),
  branches: () => c.get<BranchDirectoryEntry[]>('/branches/directory'),
  documentTypes: () => c.get<DocumentType[]>('/document-types'),

  // ---- requests
  requests: (query?: Query, signal?: AbortSignal) => c.get<Page<RequestListItem>>('/requests', { query, signal }),
  requestCounts: () => c.get<RequestCounts>('/requests/counts'),
  request: (id: string, signal?: AbortSignal) => c.get<RequestView>(`/requests/${id}`, { signal }),
  createRequest: (body: { serviceId: string; branchId?: string; instructions?: string; renewalOfScheduleId?: string }) => c.post<CreatedRequest>('/requests', body),
  updateRequest: (id: string, body: { instructions: string | null; version?: number }) => c.patch<RequestView>(`/requests/${id}`, body),
  saveFields: (id: string, values: Record<string, unknown>) => c.put<RequestView>(`/requests/${id}/fields`, { values }),
  submitRequest: (id: string) => c.post<SubmittedRequest>(`/requests/${id}/submit`),
  resubmitRequest: (id: string, note?: string) => c.post<RequestView>(`/requests/${id}/resubmit`, note ? { note } : {}),
  cancelRequest: (id: string, reason: string) => c.post<RequestView>(`/requests/${id}/cancel`, { reason }),
  comments: (id: string, signal?: AbortSignal) => c.get<RequestComment[]>(`/requests/${id}/comments`, { signal }),
  addComment: (id: string, body: string) => c.post<RequestComment>(`/requests/${id}/comments`, { body, visibility: 'CUSTOMER' }),
  linkDocument: (id: string, itemId: string, documentId: string) => c.put<RequestView>(`/requests/${id}/checklist/${itemId}/document`, { documentId }),
  unlinkDocument: (id: string, itemId: string) => c.delete<RequestView>(`/requests/${id}/checklist/${itemId}/document`),
  checklistAssist: (requestId: string) => c.get<ChecklistAssist>('/documents/checklist-assist', { query: { requestId } }),

  // ---- documents
  documents: (query?: Query, signal?: AbortSignal) => c.get<Page<DocumentRow>>('/documents', { query, signal }),
  reminders: () => c.get<Page<ReminderRow>>('/me/reminders', { query: { pageSize: 50 } }),

  // ---- quotations, invoices, payments
  quotations: (query?: Query, signal?: AbortSignal) => c.get<Page<QuotationRow>>('/quotations', { query, signal }),
  quotation: (id: string) => c.get<QuotationDetail>(`/quotations/${id}`),
  approveQuotation: (id: string) => c.post<QuotationApproval>(`/quotations/${id}/approve`, {}),
  rejectQuotation: (id: string, reason: string) => c.post<QuotationDetail>(`/quotations/${id}/reject`, { reason }),
  invoices: (query?: Query, signal?: AbortSignal) => c.get<Page<InvoiceRow>>('/invoices', { query, signal }),
  invoice: (id: string) => c.get<InvoiceDetail>(`/invoices/${id}`),
  /** Opens a hosted checkout for the open balance. One idempotency key per press of "Pay". */
  payInvoice: (id: string, returnUrl: string, idempotencyKey: string) => c.post<CheckoutSession>(`/invoices/${id}/pay`, { returnUrl }, { idempotencyKey }),
  payments: (query?: Query, signal?: AbortSignal) => c.get<Page<PaymentRow>>('/payments', { query, signal }),
  payment: (id: string, signal?: AbortSignal) => c.get<PaymentDetail>(`/payments/${id}`, { signal }),

  // ---- appointments
  appointments: (query?: Query) => c.get<Page<AppointmentRow>>('/me/appointments', { query }),
  availability: (query: { branchId: string; date: string; serviceId?: string }, signal?: AbortSignal) => c.get<Availability>('/appointments/availability', { query, signal }),
  bookAppointment: (body: { branchId: string; startsAt: string; serviceId?: string; notes?: string }) => c.post<AppointmentRow>('/me/appointments', body),
  cancelAppointment: (id: string, reason?: string) => c.post<AppointmentRow>(`/me/appointments/${id}/cancel`, reason ? { reason } : {}),
  rescheduleAppointment: (id: string, body: { startsAt: string; branchId?: string }) => c.post<AppointmentRow>(`/me/appointments/${id}/reschedule`, body),

  // ---- notifications
  inbox: (query?: Query, signal?: AbortSignal) => c.get<Inbox>('/me/notifications', { query, signal }),
  markRead: (id: string) => c.post<{ id: string; readAt: string }>(`/me/notifications/${id}/read`),
  markAllRead: () => c.post<{ updated: number }>('/me/notifications/read-all'),
  notificationPreferences: () => c.get<NotificationPreferences>('/me/notification-preferences'),
  saveNotificationPreferences: (body: In<typeof notificationPreferencesSchema>) => c.put<NotificationPreferences>('/me/notification-preferences', body),

  // ---- support
  tickets: (query?: Query, signal?: AbortSignal) => c.get<Page<TicketRow>>('/me/tickets', { query, signal }),
  ticket: (id: string) => c.get<TicketDetail>(`/me/tickets/${id}`),
  openTicket: (body: In<typeof openTicketSchema>) => c.post<TicketDetail>('/me/tickets', body),
  replyTicket: (id: string, body: In<typeof customerReplySchema>) => c.post<TicketDetail>(`/me/tickets/${id}/messages`, body),
  feedback: () => c.get<Page<FeedbackEntry>>('/me/feedback', { query: { pageSize: 100 } }),
  sendFeedback: (body: In<typeof feedbackSchema>) => c.post<FeedbackEntry>('/me/feedback', body),

  // ---- profile and privacy
  me: () => c.get<OwnCustomer>('/me/customer'),
  updateMe: (body: In<typeof updateOwnCustomerSchema>) => c.patch<OwnCustomer>('/me/customer', body),
  consents: () => c.get<{ consents: ConsentState[] }>('/me/consents'),
  saveConsents: (body: In<typeof ownConsentsSchema>) => c.put<{ changed: string[]; consents: ConsentState[] }>('/me/consents', body),
  privacyRequests: () => c.get<PrivacyRequest[]>('/privacy/my/requests'),
  createPrivacyRequest: (body: In<typeof privacyRequestSchema>) => c.post<PrivacyRequest>('/privacy/my/requests', body),
});
export type PortalApi = ReturnType<typeof portalApi>;

export function usePortalApi(): PortalApi {
  const client = useApiClient();
  return React.useMemo(() => portalApi(client), [client]);
}
