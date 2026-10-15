import { Actor, daysAgo, isoDay } from './runtime';
import { SampleFile, samplePdf, samplePng } from './sample-documents';
import { CustomerState, SeedContext, TenantState } from './state';

/** What a document type looks like in the sample vault. */
const TITLES: Record<string, string> = {
  passport: 'Passport copy',
  emirates_id: 'Emirates ID copy',
  residence_visa: 'Residence visa copy',
  trade_licence: 'Trade licence copy',
  labour_card: 'Labour card copy',
  employment_contract: 'Employment contract',
  photo: 'Personal photo',
  tenancy_contract: 'Tenancy contract',
  certificate: 'Certificate',
  completed_document: 'Prepared application',
  other: 'Supporting document',
};
/** Document types whose expiry date a reviewer confirms (and which get an expiry reminder). */
const EXPIRING = ['passport', 'emirates_id', 'residence_visa', 'trade_licence', 'labour_card', 'tenancy_contract'];

export interface BuiltSample {
  file: SampleFile;
  title: string;
  /** Expiry printed on the sample (YYYY-MM-DD), when the type has one. */
  expiryDate?: string;
}

/** Builds the sample file for a document type and a person. Deterministic per tenant, person and type. */
export async function buildSample(ctx: SeedContext, t: TenantState, typeKey: string, who: CustomerState, opts: { label?: string; variant?: string } = {}): Promise<BuiltSample> {
  const rng = t.rng(`doc:${who.key}:${typeKey}:${opts.variant ?? ''}`);
  const name = who.person.fullName;
  const title = `${opts.label ?? TITLES[typeKey] ?? 'Document'} - ${name}`;
  const initials = name
    .split(' ')
    .map((p) => p[0])
    .join('')
    .slice(0, 2);
  const heading = opts.label ?? TITLES[typeKey] ?? 'Document';
  switch (typeKey) {
    case 'photo':
      return { title, file: samplePng({ title: 'Personal photo', initials, lines: [name, 'White background', 'Placeholder instead of a face'], tone: '#5B6B7A' }) };
    case 'emirates_id': {
      const expiryDate = who.ids.emiratesIdExpiry ?? isoDay(daysAgo(-rng.int(60, 900)));
      return { title, expiryDate, file: samplePng({ title: 'Identity card copy', initials, lines: [name, `ID No. ${who.ids.emiratesId ?? ctx.fixtures.identity.emiratesId(900 + who.identityNo)}`, `Nationality: ${who.person.nationality}`, `Date of birth: ${who.person.dateOfBirth}`, `Expiry: ${expiryDate}`] }) };
    }
    case 'passport': {
      const expiryDate = who.ids.passportExpiry ?? isoDay(daysAgo(-rng.int(200, 2500)));
      return {
        title,
        expiryDate,
        file: await samplePdf({ title: heading, fields: [['Name', name], ['Nationality', who.person.nationality], ['Passport number', who.ids.passportNo ?? ctx.fixtures.identity.passportNo(900 + who.identityNo)], ['Date of birth', who.person.dateOfBirth], ['Date of expiry', expiryDate]], note: 'This page stands in for a passport copy in the demo. It has no machine-readable zone and no security features.' }),
      };
    }
    case 'residence_visa':
    case 'labour_card':
    case 'tenancy_contract':
    case 'trade_licence': {
      // A few documents are close to their expiry date so the reminder screens have something due soon.
      const expiryDate = isoDay(daysAgo(-(rng.chance(0.3) ? rng.int(8, 45) : rng.int(60, 700))));
      const ref = ctx.nextReference(typeKey === 'trade_licence' ? 'TL' : typeKey === 'tenancy_contract' ? 'TEN' : 'DOC');
      return { title, expiryDate, file: await samplePdf({ title: heading, fields: [['Holder', name], ['Reference (sample value)', ref], ['Valid until', expiryDate]], note: 'Sample text only. The reference number is invented and does not exist at any authority.' }) };
    }
    case 'completed_document':
      return {
        title,
        file: await samplePdf({
          title: heading,
          fields: [['Prepared for', name], ['Prepared by', t.fx.name], ['Reference (sample value)', ctx.nextReference('PREP')]],
          body: ['This is the document the centre prepared for the customer in this demo request.', 'In a real centre it would be the typed contract, letter or application form, ready for signature or for submission by the customer.', 'Sample text for demonstration only.'],
        }),
      };
    default:
      return { title, file: await samplePdf({ title: heading, fields: [['Provided by', name], ['Reference (sample value)', ctx.nextReference('DOC')]], note: 'Sample supporting document for the demo.' }) };
  }
}

export const hasExpiry = (typeKey: string) => EXPIRING.includes(typeKey);

export interface UploadTarget {
  customerId?: string;
  corporateAccountId?: string;
  requestId?: string;
  checklistItemId?: string;
  replacesDocumentId?: string;
  documentTypeKey: string;
  title?: string;
  category?: string;
  expiryDate?: string;
  customerVisible?: boolean;
}

/**
 * The three-step upload a browser performs: ask for an upload intent, PUT the
 * bytes to the one-time signed URL, confirm. The malware scan runs as a job
 * when the caller settles.
 */
export async function uploadDocument(ctx: SeedContext, actor: Actor, target: UploadTarget, file: SampleFile): Promise<{ documentId: string; versionId: string }> {
  const { rt } = ctx;
  const intent = await rt.as(actor).post('/documents/upload-intents', { ...target, filename: file.filename, mime: file.mime, sizeBytes: file.content.length });
  await rt.putBytes(intent.upload.url, intent.upload.headers ?? {}, file.content);
  await rt.as(actor).post(`/documents/${intent.documentId}/versions/${intent.versionId}/complete`);
  return { documentId: intent.documentId, versionId: intent.versionId };
}
