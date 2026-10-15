import { z } from 'zod';
import { optionalText, pageQuery, queryBool, trimmed, uuid } from './common';

/**
 * Settings > Integrations. The provider catalogue (which fields a provider has)
 * lives in the API (`modules/integrations/catalogue.ts`); these schemas only
 * fix the envelope. `config` and `secrets` are validated against the catalogue
 * entry of the chosen provider on the server.
 */
export const integrationCategory = z.enum(['PAYMENT', 'EMAIL', 'SMS', 'WHATSAPP', 'PUSH', 'OCR', 'MALWARE_SCAN', 'AUTOMATION', 'PARTNER', 'GOVERNMENT']);
export type IntegrationCategoryKey = z.infer<typeof integrationCategory>;
export const integrationMode = z.enum(['TEST', 'LIVE']);
const providerCode = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,48}$/, 'Use the provider code from the catalogue');
/** Distinguishes several records of the same kind (one per partner / authority). */
const instanceKey = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/, 'Use 2-40 lowercase letters, numbers or hyphens');

const scalar = z.union([z.string().max(4000), z.number().finite(), z.boolean(), z.null()]);
/** Non-secret settings. One level of nesting is allowed (e.g. WhatsApp languageCodes). */
const configObject = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,40}$/), z.union([scalar, z.record(z.string().max(40), scalar)])).refine((v) => Object.keys(v).length <= 40, 'Too many fields');
/** Write-only credentials. `null` removes a stored value. */
const secretsObject = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,40}$/), z.union([z.string().min(1).max(20_000), z.null()])).refine((v) => Object.keys(v).length <= 20, 'Too many fields');

export const createIntegrationSchema = z.object({
  category: integrationCategory,
  provider: providerCode,
  /** Display name; defaults to the catalogue name of the provider. */
  name: trimmed(120, 2).optional(),
  mode: integrationMode.default('TEST'),
  config: configObject.default({}),
  secrets: secretsObject.optional(),
  /** GOVERNMENT / PARTNER records: what the authorisation consists of. */
  authorisationNote: optionalText(2000),
  /** GOVERNMENT / PARTNER records: an uploaded document of this centre that proves the authorisation. */
  evidenceDocumentId: uuid.nullish(),
  /** GOVERNMENT / PARTNER records: one record per authority / partner. */
  instanceKey: instanceKey.optional(),
});
export type CreateIntegrationInput = z.infer<typeof createIntegrationSchema>;

export const updateIntegrationSchema = z
  .object({
    name: trimmed(120, 2).optional(),
    mode: integrationMode.optional(),
    /** Replaces the whole non-secret configuration. */
    config: configObject.optional(),
    authorisationNote: optionalText(2000),
    evidenceDocumentId: uuid.nullish(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nothing to change');
export type UpdateIntegrationInput = z.infer<typeof updateIntegrationSchema>;

export const integrationSecretsSchema = z.object({ secrets: secretsObject.refine((v) => Object.keys(v).length > 0, 'Send at least one credential') });
export type IntegrationSecretsInput = z.infer<typeof integrationSecretsSchema>;

export const integrationListQuery = z.object({
  category: integrationCategory.optional(),
  status: z.enum(['DISABLED', 'CONFIGURED', 'ACTIVE', 'ERROR']).optional(),
});
export type IntegrationListQuery = z.infer<typeof integrationListQuery>;

export const integrationLogQuery = pageQuery.extend({
  integrationId: uuid.optional(),
  category: integrationCategory.optional(),
  provider: z.string().trim().max(100).optional(),
  operation: z.string().trim().max(60).optional(),
  success: queryBool,
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});
export type IntegrationLogQuery = z.infer<typeof integrationLogQuery>;

// ------------------------------------------------------------------ platform review
export const authorisationState = z.enum(['PENDING', 'VERIFIED', 'REJECTED']);
export const authorisationReviewQuery = pageQuery.extend({
  state: authorisationState.default('PENDING'),
  category: z.enum(['GOVERNMENT', 'PARTNER']).optional(),
  /** Platform staff filter; this is not an authorisation input. */
  centreId: uuid.optional(),
});
export type AuthorisationReviewQuery = z.infer<typeof authorisationReviewQuery>;
export const verifyAuthorisationSchema = z.object({ note: optionalText(1000) });
export type VerifyAuthorisationInput = z.infer<typeof verifyAuthorisationSchema>;
export const rejectAuthorisationSchema = z.object({ note: trimmed(1000, 5) });
export type RejectAuthorisationInput = z.infer<typeof rejectAuthorisationSchema>;

/** `null` = no restriction (every provider of the catalogue may be configured). */
export const approvedProvidersSchema = z.object({
  providers: z.array(z.string().trim().regex(/^[A-Z_]{2,20}\/[a-z0-9][a-z0-9-]{1,48}$/, 'Use CATEGORY/provider')).max(100).nullable(),
});
export type ApprovedProvidersInput = z.infer<typeof approvedProvidersSchema>;
