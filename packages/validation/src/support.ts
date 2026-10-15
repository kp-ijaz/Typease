import { z } from 'zod';
import { optionalText, pageQuery, queryBool, trimmed, uuid } from './common';

export const ticketStatus = z.enum(['OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED']);
export const ticketPriority = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']);
const ticketCategory = z.string().trim().min(2).max(60);
const attachments = z.array(uuid).max(10).default([]);
const messageBody = z.string().trim().min(1).max(5000);

// ------------------------------------------------------------------ customers
/** A customer or company user opens a ticket. */
export const openTicketSchema = z.object({
  subject: trimmed(160, 3),
  message: messageBody,
  category: ticketCategory.optional(),
  /** One of the customer's own requests this conversation is about. */
  requestId: uuid.nullish(),
  /** Ids of the customer's own documents. */
  attachments,
});
export type OpenTicketInput = z.infer<typeof openTicketSchema>;
export const customerReplySchema = z.object({ body: messageBody, attachments });
export type CustomerReplyInput = z.infer<typeof customerReplySchema>;
export const myTicketsQuery = pageQuery.extend({ status: ticketStatus.optional() });
export type MyTicketsQuery = z.infer<typeof myTicketsQuery>;

// ------------------------------------------------------------------ staff
/** Staff opens a ticket for a customer (phone call, counter). */
export const staffOpenTicketSchema = openTicketSchema.extend({ customerId: uuid, priority: ticketPriority.default('NORMAL'), assigneeId: uuid.nullish() });
export type StaffOpenTicketInput = z.infer<typeof staffOpenTicketSchema>;
export const staffReplySchema = z.object({
  body: messageBody,
  /** INTERNAL notes are never shown to the customer. */
  visibility: z.enum(['CUSTOMER', 'INTERNAL']).default('CUSTOMER'),
  attachments,
  /** Optional status to set together with a customer-visible reply. */
  status: z.enum(['WAITING_CUSTOMER', 'RESOLVED']).optional(),
  resolutionSummary: optionalText(1000),
});
export type StaffReplyInput = z.infer<typeof staffReplySchema>;
export const updateTicketSchema = z.object({
  priority: ticketPriority.optional(),
  category: ticketCategory.nullish(),
  /** Staff member (membership id) responsible for the ticket; null = unassigned. */
  assigneeId: uuid.nullish(),
});
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;
export const ticketStatusSchema = z.object({ status: ticketStatus, resolutionSummary: optionalText(1000) });
export type TicketStatusInput = z.infer<typeof ticketStatusSchema>;
export const ticketListQuery = pageQuery.extend({
  status: ticketStatus.optional(),
  /** Everything that is not RESOLVED or CLOSED. */
  open: queryBool,
  priority: ticketPriority.optional(),
  category: ticketCategory.optional(),
  assigneeId: uuid.optional(),
  unassigned: queryBool,
  customerId: uuid.optional(),
  requestId: uuid.optional(),
  /** Tickets that missed (or are missing) a first-response or resolution target. */
  breached: queryBool,
});
export type TicketListQuery = z.infer<typeof ticketListQuery>;

// ------------------------------------------------------------------ SLA and settings
export const slaPoliciesSchema = z.object({
  policies: z
    .array(
      z
        .object({
          priority: ticketPriority,
          name: trimmed(80, 2).optional(),
          firstResponseMinutes: z.number().int().min(1).max(60 * 24 * 30),
          resolutionMinutes: z.number().int().min(1).max(60 * 24 * 90),
          isActive: z.boolean().default(true),
        })
        .refine((p) => p.resolutionMinutes >= p.firstResponseMinutes, { message: 'The resolution time cannot be shorter than the first-response time', path: ['resolutionMinutes'] }),
    )
    .min(1)
    .max(4)
    .refine((list) => new Set(list.map((p) => p.priority)).size === list.length, 'Each priority may appear only once'),
});
export type SlaPoliciesInput = z.infer<typeof slaPoliciesSchema>;
export const supportSettingsSchema = z.object({
  /** A customer reply reopens a resolved ticket within this many days; afterwards the ticket is closed. */
  reopenWindowDays: z.number().int().min(0).max(90),
});
export type SupportSettingsInput = z.infer<typeof supportSettingsSchema>;

// ------------------------------------------------------------------ feedback
export const feedbackSchema = z
  .object({
    ticketId: uuid.nullish(),
    requestId: uuid.nullish(),
    rating: z.number().int().min(1).max(5),
    comment: optionalText(1000),
  })
  .refine((v) => (v.ticketId ? 1 : 0) + (v.requestId ? 1 : 0) === 1, { message: 'Rate either a ticket or a request', path: ['ticketId'] });
export type FeedbackInput = z.infer<typeof feedbackSchema>;
export const feedbackListQuery = pageQuery.extend({ customerId: uuid.optional(), maxRating: z.coerce.number().int().min(1).max(5).optional(), kind: z.enum(['TICKET', 'REQUEST']).optional() });
export type FeedbackListQuery = z.infer<typeof feedbackListQuery>;
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');
export const feedbackSummaryQuery = z.object({ from: month.optional(), to: month.optional() });
export type FeedbackSummaryQuery = z.infer<typeof feedbackSummaryQuery>;

// ------------------------------------------------------------------ platform tickets (centre -> TypEase support)
export const openPlatformTicketSchema = z.object({ subject: trimmed(160, 3), message: messageBody, category: ticketCategory.optional(), priority: ticketPriority.default('NORMAL') });
export type OpenPlatformTicketInput = z.infer<typeof openPlatformTicketSchema>;
export const platformTicketReplySchema = z.object({ body: messageBody });
export const platformStaffReplySchema = z.object({
  body: messageBody,
  /** INTERNAL notes stay inside the TypEase support team. */
  visibility: z.enum(['CUSTOMER', 'INTERNAL']).default('CUSTOMER'),
  status: z.enum(['WAITING_CUSTOMER', 'RESOLVED']).optional(),
  resolutionSummary: optionalText(1000),
});
export type PlatformStaffReplyInput = z.infer<typeof platformStaffReplySchema>;
export const platformTicketUpdateSchema = z.object({
  /** Platform staff user id; null = unassigned. */
  platformAssigneeId: uuid.nullish(),
  priority: ticketPriority.optional(),
  status: ticketStatus.optional(),
  resolutionSummary: optionalText(1000),
});
export type PlatformTicketUpdateInput = z.infer<typeof platformTicketUpdateSchema>;
export const platformTicketListQuery = pageQuery.extend({ status: ticketStatus.optional(), open: queryBool, tenantId: uuid.optional(), priority: ticketPriority.optional(), assignedToMe: queryBool, unassigned: queryBool });
export type PlatformTicketListQuery = z.infer<typeof platformTicketListQuery>;
