import { z } from 'zod';
import { countryCode, isoDate, isoDateTime, optionalText, pageQuery, queryBool, trimmed, uuid } from './common';

/**
 * Privacy module request shapes: data subject requests, retention policies,
 * consent overview, incident register and processor (vendor) register.
 */

// ---------------------------------------------------------------------------- data subject requests
export const PRIVACY_REQUEST_TYPES = ['ACCESS', 'CORRECTION', 'DELETION', 'EXPORT'] as const;
export const PRIVACY_REQUEST_STATUSES = ['RECEIVED', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'COMPLETED'] as const;

/** A customer asks for themselves. */
export const privacyRequestSchema = z.object({
  type: z.enum(PRIVACY_REQUEST_TYPES),
  /** What the customer wants, in their own words (for a correction: what is wrong). */
  details: optionalText(2000),
});
export type PrivacyRequestInput = z.infer<typeof privacyRequestSchema>;

/** Staff record a request received at the counter, by phone or by email. */
export const privacyStaffRequestSchema = privacyRequestSchema.extend({
  customerId: uuid,
  /** Defaults to 30 days from today. */
  dueAt: isoDate.optional(),
});
export type PrivacyStaffRequestInput = z.infer<typeof privacyStaffRequestSchema>;

export const privacyRequestListQuery = pageQuery.pick({ page: true, pageSize: true, sort: true }).extend({
  status: z.enum(PRIVACY_REQUEST_STATUSES).optional(),
  type: z.enum(PRIVACY_REQUEST_TYPES).optional(),
  customerId: uuid.optional(),
  /** Open requests past their due date. */
  overdue: queryBool,
});
export type PrivacyRequestListQuery = z.infer<typeof privacyRequestListQuery>;

export const privacyDecisionSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  /** Shown to the customer: why the request was approved or refused. */
  decisionNote: trimmed(1000, 5),
});
export type PrivacyDecisionInput = z.infer<typeof privacyDecisionSchema>;

export const privacyCompleteSchema = z.object({
  /** What was done. Mandatory for correction requests. */
  note: optionalText(1000),
});
export type PrivacyCompleteInput = z.infer<typeof privacyCompleteSchema>;

// ---------------------------------------------------------------------------- retention
export const RETENTION_ENTITIES = ['DOCUMENT', 'CUSTOMER', 'NOTIFICATION', 'SUPPORT_TICKET'] as const;
export const RETENTION_ACTIONS = ['DELETE', 'ANONYMISE'] as const;

export const privacyRetentionPolicySchema = z
  .object({
    entity: z.enum(RETENTION_ENTITIES),
    /** DOCUMENT policies only: limit the policy to one document type. Omit for the general policy. */
    documentTypeKey: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/)
      .nullish(),
    retainDays: z.coerce.number().int().min(1).max(36500),
    action: z.enum(RETENTION_ACTIONS).default('DELETE'),
    /** Why this period was chosen (e.g. the advice received). Not validated by the system. */
    legalBasisNote: optionalText(500),
    isActive: z.boolean().default(true),
  })
  .refine((v) => v.entity === 'DOCUMENT' || !v.documentTypeKey, { path: ['documentTypeKey'], message: 'Only document policies can be limited to a document type' })
  .refine((v) => v.entity !== 'DOCUMENT' || v.action === 'DELETE', { path: ['action'], message: 'Documents can only be deleted, not anonymised' });
export type PrivacyRetentionPolicyInput = z.infer<typeof privacyRetentionPolicySchema>;

export const privacyRetentionPolicyUpdateSchema = z
  .object({
    retainDays: z.coerce.number().int().min(1).max(36500),
    action: z.enum(RETENTION_ACTIONS),
    legalBasisNote: optionalText(500),
    isActive: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type PrivacyRetentionPolicyUpdateInput = z.infer<typeof privacyRetentionPolicyUpdateSchema>;

// ---------------------------------------------------------------------------- consent overview
export const privacyConsentQuery = pageQuery.pick({ page: true, pageSize: true }).extend({
  purpose: z.string().trim().max(60).optional(),
  status: z.enum(['GRANTED', 'WITHDRAWN']).optional(),
  customerId: uuid.optional(),
});
export type PrivacyConsentQuery = z.infer<typeof privacyConsentQuery>;

// ---------------------------------------------------------------------------- incident register
export const INCIDENT_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export const INCIDENT_STATUSES = ['OPEN', 'INVESTIGATING', 'CONTAINED', 'RESOLVED'] as const;

const incidentFields = {
  title: trimmed(200, 3),
  description: trimmed(5000, 10),
  severity: z.enum(INCIDENT_SEVERITIES),
  /** Which data / systems are affected. */
  affectedData: optionalText(2000),
  personalDataInvolved: z.boolean(),
  /** Decision whether the authority / individuals must be notified. null = not decided yet. */
  notificationRequired: z.boolean().nullable(),
  detectedAt: isoDateTime,
};
export const privacyIncidentSchema = z.object({
  ...incidentFields,
  severity: incidentFields.severity.default('MEDIUM'),
  personalDataInvolved: incidentFields.personalDataInvolved.default(false),
  notificationRequired: incidentFields.notificationRequired.optional(),
  detectedAt: incidentFields.detectedAt.optional(),
});
export type PrivacyIncidentInput = z.infer<typeof privacyIncidentSchema>;

export const privacyIncidentUpdateSchema = z
  .object({
    ...incidentFields,
    /** When the authority was notified. null clears the entry. */
    authorityNotifiedAt: isoDateTime.nullable(),
    /** When the affected individuals were notified. */
    individualsNotifiedAt: isoDateTime.nullable(),
    resolutionNotes: optionalText(5000),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type PrivacyIncidentUpdateInput = z.infer<typeof privacyIncidentUpdateSchema>;

export const privacyIncidentStatusSchema = z.object({
  status: z.enum(INCIDENT_STATUSES),
  /** Mandatory when resolving; explains a reopening. */
  resolutionNotes: optionalText(5000),
});
export type PrivacyIncidentStatusInput = z.infer<typeof privacyIncidentStatusSchema>;

export const privacyIncidentListQuery = pageQuery.pick({ page: true, pageSize: true, sort: true }).extend({
  status: z.enum(INCIDENT_STATUSES).optional(),
  severity: z.enum(INCIDENT_SEVERITIES).optional(),
});
export type PrivacyIncidentListQuery = z.infer<typeof privacyIncidentListQuery>;

// ---------------------------------------------------------------------------- processor / vendor register
export const PROCESSOR_STATUSES = ['PENDING_REVIEW', 'APPROVED', 'REJECTED'] as const;

const processorFields = {
  name: trimmed(160, 2),
  /** What the vendor does with the data. */
  purpose: trimmed(1000, 3),
  dataCategories: z.array(trimmed(60, 2)).min(1).max(30),
  /** Country where the data is processed or stored. */
  country: countryCode,
  /** Defaults to true whenever the country is not AE. */
  crossBorder: z.boolean().optional(),
  /** Contractual / technical safeguards for the transfer. Required to approve a cross-border processor. */
  safeguards: optionalText(2000),
};
export const privacyProcessorSchema = z.object(processorFields);
export type PrivacyProcessorInput = z.infer<typeof privacyProcessorSchema>;
export const privacyProcessorUpdateSchema = z
  .object(processorFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type PrivacyProcessorUpdateInput = z.infer<typeof privacyProcessorUpdateSchema>;

export const privacyProcessorReviewSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  safeguards: optionalText(2000),
});
export type PrivacyProcessorReviewInput = z.infer<typeof privacyProcessorReviewSchema>;

export const privacyProcessorListQuery = pageQuery.pick({ page: true, pageSize: true }).extend({
  status: z.enum(PROCESSOR_STATUSES).optional(),
  crossBorder: queryBool,
});
export type PrivacyProcessorListQuery = z.infer<typeof privacyProcessorListQuery>;
