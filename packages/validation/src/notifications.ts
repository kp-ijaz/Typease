import { z } from 'zod';
import { isoDate, language, optionalText, pageQuery, queryBool, trimmed, uuid } from './common';

/** Notification channels. IN_APP is stored only; the others go through a provider. */
export const notificationChannel = z.enum(['EMAIL', 'SMS', 'WHATSAPP', 'IN_APP', 'PUSH']);
export type NotificationChannelKey = z.infer<typeof notificationChannel>;
export const notificationStatus = z.enum(['QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'SUPPRESSED']);
/** Preference groups a person can opt in / out of. Security messages cannot be switched off. */
export const NOTIFICATION_GROUPS = ['account', 'requests', 'payments', 'appointments', 'reminders', 'support', 'billing', 'reports', 'marketing'] as const;
export const notificationGroup = z.enum(NOTIFICATION_GROUPS);
export type NotificationGroupKey = z.infer<typeof notificationGroup>;

const eventKey = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, 'Use an event key such as request.completed')
  .max(80);

// ------------------------------------------------------------------ delivery log
export const notificationLogQuery = pageQuery.extend({
  status: notificationStatus.optional(),
  channel: notificationChannel.optional(),
  eventKey: eventKey.optional(),
  customerId: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type NotificationLogQuery = z.infer<typeof notificationLogQuery>;

export const notificationFailureQuery = pageQuery.extend({
  channel: notificationChannel.optional(),
  eventKey: eventKey.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type NotificationFailureQuery = z.infer<typeof notificationFailureQuery>;

// ------------------------------------------------------------------ templates
export const templateListQuery = z.object({
  eventKey: eventKey.optional(),
  channel: notificationChannel.optional(),
  language: language.optional(),
});
export type TemplateListQuery = z.infer<typeof templateListQuery>;

export const templateOverrideSchema = z.object({
  name: trimmed(120, 2).optional(),
  subject: optionalText(200),
  body: z.string().trim().min(3).max(8000),
  /** Name of the pre-approved WhatsApp Business template (required to send business-initiated WhatsApp messages). */
  whatsappTemplateName: z
    .string()
    .trim()
    .regex(/^[a-z0-9_]{1,512}$/, 'Use the template name exactly as approved by Meta (lower-case letters, numbers and underscores)')
    .nullish(),
});
export type TemplateOverrideInput = z.infer<typeof templateOverrideSchema>;

export const templatePreviewSchema = z.object({
  eventKey,
  channel: notificationChannel,
  language: language.default('en'),
  /** Unsaved draft to preview. When omitted the effective template is rendered. */
  subject: optionalText(200),
  body: z.string().max(8000).optional(),
  /** Sample values that replace the built-in sample data. */
  data: z.record(z.union([z.string().max(500), z.number(), z.null()])).optional(),
});
export type TemplatePreviewInput = z.infer<typeof templatePreviewSchema>;

export const eventChannelToggleSchema = z.object({ enabled: z.boolean() });

// ------------------------------------------------------------------ settings
export const notificationSettingsSchema = z.object({
  /** eventKey -> channel -> enabled. Missing entries keep the platform default. */
  events: z.record(eventKey, z.record(notificationChannel, z.boolean())).optional(),
  /** Maximum messages per recipient, channel and hour (anti-spam). */
  rateLimitPerHour: z.number().int().min(1).max(200).optional(),
});
export type NotificationSettingsInput = z.infer<typeof notificationSettingsSchema>;

// ------------------------------------------------------------------ inbox / preferences / devices
export const inboxQuery = pageQuery.extend({ unreadOnly: queryBool });
export type InboxQuery = z.infer<typeof inboxQuery>;

export const notificationPreferencesSchema = z.object({
  preferences: z
    .array(
      z.object({
        channel: notificationChannel,
        /** "*" = every group on that channel. */
        eventGroup: z.union([z.literal('*'), notificationGroup]).default('*'),
        enabled: z.boolean(),
      }),
    )
    .min(1)
    .max(60),
});
export type NotificationPreferencesInput = z.infer<typeof notificationPreferencesSchema>;

export const registerDeviceSchema = z.object({
  token: z.string().trim().min(16).max(4096),
  platform: z.enum(['ios', 'android', 'web']),
});
export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>;
export const removeDeviceSchema = z.object({ token: z.string().trim().min(16).max(4096) });

// ------------------------------------------------------------------ reminders (document expiry)
const offsets = z
  .array(z.number().int().min(0).max(730))
  .min(1)
  .max(12)
  .transform((v) => [...new Set(v)].sort((a, b) => b - a));
const documentTypeKey = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{1,59}$/, 'Use a document type key such as passport');

export const createReminderSchema = z
  .object({
    customerId: uuid.nullish(),
    corporateAccountId: uuid.nullish(),
    documentId: uuid.nullish(),
    documentTypeKey,
    /** Whose document it is, shown in the reminder (e.g. "Ahmed's passport"). Defaults to the customer / company name. */
    subjectLabel: optionalText(160),
    expiryDate: isoDate,
    /** Days before expiry on which a reminder is sent. Defaults to the centre setting, else 90, 60, 30, 15, 7. */
    offsetsDays: offsets.optional(),
  })
  .refine((v) => !!v.customerId || !!v.corporateAccountId, { message: 'Choose a customer or a corporate account', path: ['customerId'] });
export type CreateReminderInput = z.infer<typeof createReminderSchema>;

export const updateReminderSchema = z.object({
  subjectLabel: optionalText(160),
  expiryDate: isoDate.optional(),
  offsetsDays: offsets.optional(),
  /** ACTIVE <-> PAUSED. Use the cancel endpoint to stop a schedule for good. */
  status: z.enum(['ACTIVE', 'PAUSED']).optional(),
});
export type UpdateReminderInput = z.infer<typeof updateReminderSchema>;

export const reminderListQuery = pageQuery.extend({
  status: z.enum(['ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED']).optional(),
  customerId: uuid.optional(),
  corporateAccountId: uuid.optional(),
  documentTypeKey: documentTypeKey.optional(),
  /** Only schedules expiring within this many days from today (the "upcoming expiries" widget). */
  withinDays: z.coerce.number().int().min(0).max(730).optional(),
  /** Include documents that already expired (default false when withinDays is used). */
  includeExpired: queryBool,
});
export type ReminderListQuery = z.infer<typeof reminderListQuery>;
/**
 * GET /me/reminders. `customerId` narrows a company administrator's list to one employee (the `customerId` of
 * the employee object); a person asking with their own id gets their own list. Any other id gives an empty page.
 */
export const myRemindersQuery = pageQuery.extend({ customerId: uuid.optional() });
export type MyRemindersQuery = z.infer<typeof myRemindersQuery>;

// ---------------------------------------------------------------- renewal autopilot
/**
 * Renewal autopilot: so many days before a tracked document expires, a renewal request for the mapped service is
 * opened, quoted from the service price and offered to the customer with a one-tap approve-and-pay link.
 */
export const renewalAutopilotSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  daysBefore: z.number().int().min(1).max(120).optional(),
  /** Document type key -> the service that renews it (null removes the mapping). */
  services: z.record(z.string().trim().regex(/^[a-z0-9_]{2,60}$/), uuid.nullable()).optional(),
});
export type RenewalAutopilotSettingsInput = z.infer<typeof renewalAutopilotSettingsSchema>;
export const declineRenewalSchema = z.object({ reason: optionalText(300) });
