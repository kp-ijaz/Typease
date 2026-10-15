import { z } from 'zod';
import { pageQuery, phone, queryBool, trimmed, uuid } from './common';

/** WhatsApp team inbox. */
export const conversationQuery = pageQuery.extend({ status: z.enum(['OPEN', 'PENDING', 'CLOSED']).optional(), mine: queryBool, unassigned: queryBool });
export type ConversationQuery = z.infer<typeof conversationQuery>;
export const inboxReplySchema = z.object({ text: trimmed(4096, 1) });
export const inboxNoteSchema = z.object({ text: trimmed(2000, 1) });
export const inboxAssignSchema = z.object({ membershipId: uuid.nullable() });
export const inboxStatusSchema = z.object({ status: z.enum(['OPEN', 'PENDING', 'CLOSED']) });
export const inboxLinkCustomerSchema = z.object({ customerId: uuid.nullable() });
export const quickRepliesSchema = z.object({ replies: z.array(z.object({ title: trimmed(60, 1), body: trimmed(1000, 1) })).max(30) });
export type QuickRepliesInput = z.infer<typeof quickRepliesSchema>;
/** Development sandbox: a message as if the customer had sent it on WhatsApp. */
export const simulateInboundSchema = z.object({
  phone,
  name: trimmed(80, 1).optional(),
  text: z.string().trim().max(4096).optional(),
  /** A photo or PDF the "customer" sends, as a data URL. */
  media: z.string().max(8_000_000).regex(/^data:(image\/(png|jpeg)|application\/pdf);base64,/).optional(),
  mediaName: trimmed(120, 1).optional(),
}).refine((v) => v.text || v.media, { message: 'Send a text or a file' });
export type SimulateInboundInput = z.infer<typeof simulateInboundSchema>;
/** WhatsApp intake: a photo or PDF a customer sent becomes a draft request with the file on its checklist (and OCR). */
export const inboxIntakeSchema = z.object({
  serviceId: uuid,
  /** What the file is (passport, emirates_id ...): picks the checklist line and the OCR profile. */
  documentTypeKey: z.string().trim().regex(/^[a-z0-9_]{2,60}$/),
  runOcr: z.boolean().default(true),
});
export type InboxIntakeInput = z.infer<typeof inboxIntakeSchema>;
