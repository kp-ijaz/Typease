import { z } from 'zod';
import { optionalText, pageQuery, trimmed, uuid } from './common';

/**
 * Ready-made documents: templates of a centre and the documents generated from them for customers
 * (salary certificates, NOCs, contracts, letters), signed electronically and handed over.
 */
export const DOCUMENT_TEMPLATE_KINDS = ['SALARY_CERTIFICATE', 'NOC', 'CONTRACT', 'LETTER'] as const;
export const templateFieldSchema = z.object({
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{1,39}$/, 'Use letters and digits, starting with a letter'),
  label: trimmed(80, 1),
  labelAr: optionalText(80),
  type: z.enum(['text', 'textarea', 'date', 'money', 'number']).default('text'),
  required: z.boolean().default(true),
});
export type TemplateField = z.infer<typeof templateFieldSchema>;

const templateFields = {
  name: trimmed(120, 2),
  nameAr: optionalText(120),
  titleEn: trimmed(160, 2),
  titleAr: optionalText(160),
  bodyEn: trimmed(20000, 10),
  bodyAr: optionalText(20000),
  fields: z.array(templateFieldSchema).max(40),
  requiresSignature: z.boolean(),
  isActive: z.boolean(),
};
export const documentTemplateSchema = z.object({ ...templateFields, kind: z.enum(DOCUMENT_TEMPLATE_KINDS), key: z.string().trim().regex(/^[a-z][a-z0-9_]{2,40}$/, 'Use lower-case letters, digits and _') });
export type DocumentTemplateInput = z.infer<typeof documentTemplateSchema>;
export const updateDocumentTemplateSchema = z.object(templateFields).partial().extend({ version: z.number().int().positive() });
export type UpdateDocumentTemplateInput = z.infer<typeof updateDocumentTemplateSchema>;

const values = z.record(z.string().max(40), z.string().max(2000));
export const createGeneratedDocumentSchema = z.object({ templateId: uuid, customerId: uuid, requestId: uuid.nullish(), branchId: uuid.nullish(), values });
export type CreateGeneratedDocumentInput = z.infer<typeof createGeneratedDocumentSchema>;
export const updateGeneratedDocumentSchema = z.object({ values });
export const generatedDocumentQuery = pageQuery.extend({ customerId: uuid.optional(), requestId: uuid.optional(), status: z.enum(['DRAFT', 'ISSUED', 'SIGNED', 'HANDED_OVER', 'VOID']).optional() });
export type GeneratedDocumentQuery = z.infer<typeof generatedDocumentQuery>;

/** A drawn signature as a PNG data URL (kept small: a signature is a few kilobytes). */
const signatureImage = z.string().max(400_000).regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/, 'The signature must be a PNG image');
export const signDocumentSchema = z.object({
  signerName: trimmed(120, 2),
  signatureImage,
  /** The signer confirms they read the document and sign it electronically. */
  agree: z.literal(true),
});
export type SignDocumentInput = z.infer<typeof signDocumentSchema>;
export const handOverDocumentSchema = z.object({ handedOverTo: trimmed(120, 2), note: optionalText(500) });
export const voidDocumentSchema = z.object({ reason: trimmed(300, 2) });
