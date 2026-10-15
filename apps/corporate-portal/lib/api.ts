'use client';

import * as React from 'react';
import type { ApiClient, RequestCounts, RequestListItem } from '@typease/api-client';
import type { Page } from '@typease/types';
import type {
  corporateEmployeeLoginSchema, corporateEmployeeSchema, corporateMemberSchema, corporateRoleSchema, customerReplySchema, feedbackSchema, notificationPreferencesSchema, openTicketSchema,
  updateCorporateEmployeeSchema, updateCorporateRoleSchema, z,
} from '@typease/validation';
import { useApiClient } from '@typease/ui';
import type {
  BranchDirectoryEntry, BulkEmployeesResult, Catalogue, CatalogueServiceDetail, CheckoutSession, ChecklistAssist, CompanyAccount, CompanyMember, CompanyRole, CompanyUser, ContractPrice, CreatedRequest, DocumentRow,
  DocumentType, Employee, FeedbackEntry, Inbox, InvitationResult, InvoiceDetail, InvoiceRow, NotificationPreferences, PaymentDetail, QuotationApproval, QuotationDetail, QuotationRow,
  ReminderRow, RequestComment, RequestView, RolePermissionDef, Statement, SubmittedRequest, TicketDetail, TicketRow,
} from './types';

type In<T extends z.ZodTypeAny> = z.input<T>;
type Query = Record<string, string | number | boolean | undefined>;

/** Who a new request is for: one employee of the company, or (neither field) the company itself. */
export interface NewRequestBody {
  serviceId: string;
  corporateEmployeeId?: string;
  branchId?: string;
  instructions?: string;
  renewalOfScheduleId?: string;
}

/**
 * Every endpoint the corporate portal calls, typed. All of them are routes a company user may
 * use (`corp.*`, `self.*`, "any tenant member" or "member kind CORPORATE" in docs/api/ENDPOINTS.md).
 * No path carries a company id: the API takes the company from the signed-in membership.
 */
export const portalApi = (c: ApiClient) => ({
  // ---- the company (corp.account.read)
  account: () => c.get<CompanyAccount>('/corporate/account'),
  members: () => c.get<CompanyMember[]>('/corporate/members'),
  inviteMember: (body: In<typeof corporateMemberSchema>) => c.post<InvitationResult & { id: string }>('/corporate/members', body),
  prices: () => c.get<ContractPrice[]>('/corporate/prices'),
  // ---- the company's roles (changes: the company administrator only)
  roles: () => c.get<CompanyRole[]>('/corporate/roles'),
  rolePermissions: () => c.get<RolePermissionDef[]>('/corporate/roles/permissions'),
  createRole: (body: In<typeof corporateRoleSchema>) => c.post<CompanyRole>('/corporate/roles', body),
  updateRole: (id: string, body: In<typeof updateCorporateRoleSchema>) => c.patch<CompanyRole>(`/corporate/roles/${id}`, body),
  deleteRole: (id: string) => c.delete<{ status: 'DELETED' }>(`/corporate/roles/${id}`),
  users: () => c.get<CompanyUser[]>('/corporate/users'),
  setUserRole: (membershipId: string, roleId: string) => c.put<{ status: 'UPDATED' }>(`/corporate/users/${membershipId}/role`, { roleId }),

  // ---- employees (corp.employees.*)
  employees: (query?: Query, signal?: AbortSignal) => c.get<Page<Employee>>('/corporate/employees', { query, signal }),
  employee: (id: string, signal?: AbortSignal) => c.get<Employee>(`/corporate/employees/${id}`, { signal }),
  createEmployee: (body: In<typeof corporateEmployeeSchema>) => c.post<Employee>('/corporate/employees', body),
  createEmployees: (employees: Array<Record<string, unknown>>) => c.post<BulkEmployeesResult>('/corporate/employees/bulk', { employees }),
  updateEmployee: (id: string, body: In<typeof updateCorporateEmployeeSchema>) => c.patch<Employee>(`/corporate/employees/${id}`, body),
  inviteEmployeeLogin: (id: string, body: In<typeof corporateEmployeeLoginSchema>) => c.post<InvitationResult & { employeeId: string }>(`/corporate/employees/${id}/login`, body),
  resendEmployeeLogin: (id: string) => c.post<{ status: 'SENT'; email: string; dev?: { invitationToken?: string } }>(`/corporate/employees/${id}/login/resend-invitation`),
  revokeEmployeeLogin: (id: string) => c.delete<{ employeeId: string; status: 'NONE' }>(`/corporate/employees/${id}/login`),

  // ---- catalogue (signed in: the company's contract prices, the form and the checklist of a service)
  catalogue: (signal?: AbortSignal) => c.get<Catalogue>('/catalogue', { signal }),
  service: (id: string) => c.get<CatalogueServiceDetail>(`/catalogue/${id}`),
  branches: () => c.get<BranchDirectoryEntry[]>('/branches/directory'),
  documentTypes: () => c.get<DocumentType[]>('/document-types'),

  // ---- requests (corp.requests.* for the company, self.requests for an employee's own)
  requests: (query?: Query, signal?: AbortSignal) => c.get<Page<RequestListItem>>('/requests', { query, signal }),
  requestCounts: () => c.get<RequestCounts>('/requests/counts'),
  request: (id: string, signal?: AbortSignal) => c.get<RequestView>(`/requests/${id}`, { signal }),
  createRequest: (body: NewRequestBody) => c.post<CreatedRequest>('/requests', body),
  updateRequest: (id: string, body: { instructions: string | null; version?: number }) => c.patch<RequestView>(`/requests/${id}`, body),
  saveFields: (id: string, values: Record<string, unknown>) => c.put<RequestView>(`/requests/${id}/fields`, { values }),
  submitRequest: (id: string) => c.post<SubmittedRequest>(`/requests/${id}/submit`),
  resubmitRequest: (id: string, note?: string) => c.post<RequestView>(`/requests/${id}/resubmit`, note ? { note } : {}),
  cancelRequest: (id: string, reason: string) => c.post<RequestView>(`/requests/${id}/cancel`, { reason }),
  addComment: (id: string, body: string) => c.post<RequestComment>(`/requests/${id}/comments`, { body, visibility: 'CUSTOMER' }),
  linkDocument: (id: string, itemId: string, documentId: string) => c.put<RequestView>(`/requests/${id}/checklist/${itemId}/document`, { documentId }),
  unlinkDocument: (id: string, itemId: string) => c.delete<RequestView>(`/requests/${id}/checklist/${itemId}/document`),
  checklistAssist: (requestId: string) => c.get<ChecklistAssist>('/documents/checklist-assist', { query: { requestId } }),

  // ---- documents and expiry reminders
  documents: (query?: Query, signal?: AbortSignal) => c.get<Page<DocumentRow>>('/documents', { query, signal }),
  reminders: (query?: Query, signal?: AbortSignal) => c.get<Page<ReminderRow>>('/me/reminders', { query: { pageSize: 100, sort: 'expiryDate:asc', ...query }, signal }),

  // ---- quotations waiting for the company's decision (corp.requests.approve)
  quotations: (query?: Query, signal?: AbortSignal) => c.get<Page<QuotationRow>>('/quotations', { query, signal }),
  quotation: (id: string) => c.get<QuotationDetail>(`/quotations/${id}`),
  approveQuotation: (id: string) => c.post<QuotationApproval>(`/quotations/${id}/approve`, {}),
  rejectQuotation: (id: string, reason: string) => c.post<QuotationDetail>(`/quotations/${id}/reject`, { reason }),

  // ---- invoices, statement, payments (corp.invoices.read)
  invoices: (query?: Query, signal?: AbortSignal) => c.get<Page<InvoiceRow>>('/corporate/invoices', { query, signal }),
  statement: () => c.get<Statement>('/corporate/invoices/statement'),
  invoice: (id: string) => c.get<InvoiceDetail>(`/invoices/${id}`),
  /** Opens a hosted checkout for the open balance. One idempotency key per press of "Pay". */
  payInvoice: (id: string, returnUrl: string, idempotencyKey: string) => c.post<CheckoutSession>(`/invoices/${id}/pay`, { returnUrl }, { idempotencyKey }),
  payment: (id: string, signal?: AbortSignal) => c.get<PaymentDetail>(`/payments/${id}`, { signal }),

  // ---- notifications (any member of the centre)
  inbox: (query?: Query, signal?: AbortSignal) => c.get<Inbox>('/me/notifications', { query, signal }),
  markRead: (id: string) => c.post<{ id: string; readAt: string }>(`/me/notifications/${id}/read`),
  markAllRead: () => c.post<{ updated: number }>('/me/notifications/read-all'),
  notificationPreferences: () => c.get<NotificationPreferences>('/me/notification-preferences'),
  saveNotificationPreferences: (body: In<typeof notificationPreferencesSchema>) => c.put<NotificationPreferences>('/me/notification-preferences', body),

  // ---- support (self.tickets)
  tickets: (query?: Query, signal?: AbortSignal) => c.get<Page<TicketRow>>('/me/tickets', { query, signal }),
  ticket: (id: string) => c.get<TicketDetail>(`/me/tickets/${id}`),
  openTicket: (body: In<typeof openTicketSchema>) => c.post<TicketDetail>('/me/tickets', body),
  replyTicket: (id: string, body: In<typeof customerReplySchema>) => c.post<TicketDetail>(`/me/tickets/${id}/messages`, body),
  /** Ratings need a customer record: employees have one, company administrators do not (403 NO_CUSTOMER_PROFILE). */
  feedback: () => c.get<Page<FeedbackEntry>>('/me/feedback', { query: { pageSize: 100 } }),
  sendFeedback: (body: In<typeof feedbackSchema>) => c.post<FeedbackEntry>('/me/feedback', body),
});
export type PortalApi = ReturnType<typeof portalApi>;

export function usePortalApi(): PortalApi {
  const client = useApiClient();
  return React.useMemo(() => portalApi(client), [client]);
}
