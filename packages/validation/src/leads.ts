import { z } from 'zod';
import { email, isoDateTime, moneyAmount, optionalText, pageQuery, phone, queryBool, trimmed, uuid } from './common';

/** CRM leads: enquiries before they become customers and requests. */
export const LEAD_SOURCES = ['WALK_IN', 'PHONE', 'WHATSAPP', 'WEBSITE', 'REFERRAL', 'CORPORATE', 'SOCIAL', 'OTHER'] as const;
export const LEAD_STATUSES = ['NEW', 'CONTACTED', 'QUOTED', 'WON', 'LOST'] as const;
const leadFields = {
  name: trimmed(160, 2),
  phone: phone.nullish(),
  email: email.nullish(),
  source: z.enum(LEAD_SOURCES).default('WALK_IN'),
  serviceId: uuid.nullish(),
  interest: optionalText(1000),
  estimatedValue: moneyAmount.nullish(),
  ownerId: uuid.nullish(),
  nextFollowUpAt: isoDateTime.nullish(),
};
export const leadSchema = z.object({ ...leadFields, conversationId: uuid.nullish() }).refine((v) => v.phone || v.email, { message: 'Enter a phone number or an email', path: ['phone'] });
export type LeadInput = z.infer<typeof leadSchema>;
export const updateLeadSchema = z.object(leadFields).partial();
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;
export const leadStatusSchema = z
  .object({ status: z.enum(LEAD_STATUSES), lostReason: optionalText(300) })
  .refine((v) => v.status !== 'LOST' || v.lostReason, { message: 'Say why the lead was lost', path: ['lostReason'] });
export const leadActivitySchema = z.object({ kind: z.enum(['NOTE', 'CALL', 'WHATSAPP', 'EMAIL', 'MEETING']), body: trimmed(2000, 1), nextFollowUpAt: isoDateTime.nullish() });
export const leadQuery = pageQuery.extend({ status: z.enum(LEAD_STATUSES).optional(), ownerId: uuid.optional(), mine: queryBool, due: queryBool, source: z.enum(LEAD_SOURCES).optional() });
export type LeadQuery = z.infer<typeof leadQuery>;
/** Won: the lead becomes (or is linked to) a customer, optionally with a first request. */
export const convertLeadSchema = z.object({ customerId: uuid.nullish(), serviceId: uuid.nullish() });
export type ConvertLeadInput = z.infer<typeof convertLeadSchema>;
