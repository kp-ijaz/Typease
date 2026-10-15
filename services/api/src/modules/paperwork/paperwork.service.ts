import { Injectable, OnModuleInit } from '@nestjs/common';
import type { CreateGeneratedDocumentInput, DocumentTemplateInput, GeneratedDocumentQuery, SignDocumentInput, TemplateField, UpdateDocumentTemplateInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { ctx, runAsTenant } from '../../common/context';
import { decryptText, sha256, signPayload, verifyPayload } from '../../common/crypto';
import { Prisma, TenantDb, Tx } from '../../common/db/prisma.service';
import { ErasureRegistry, ErasureSubject } from '../../common/erasure';
import { Errors, found } from '../../common/errors';
import { DomainEvents } from '../../common/events.service';
import { pageArgs, pageResult } from '../../common/pagination';
import { SequenceService } from '../../common/sequence.service';
import { FinancePdfService } from '../finance/pdf.service';
import { localDate } from '../reminders/dates';
import { ProvisioningService } from '../tenancy/provisioning.service';
import { TenantResolver } from '../tenancy/tenant-resolver.service';
import { BUILT_IN_TEMPLATES } from './builtin-templates';
import { renderLetter } from './letter.renderer';

const ERASED = 'Erased at the request of the data subject';
const SIGN_LINK_TTL = 30 * 86_400;
type Doc = Prisma.GeneratedDocumentGetPayload<object>;

type Lang = 'en' | 'ar';
const longDate = (ymd: string, lang: Lang = 'en') => new Intl.DateTimeFormat(lang === 'ar' ? 'ar-AE-u-nu-latn' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${ymd}T00:00:00.000Z`));
/** "PK" -> "Pakistan" / "باكستان"; anything that is not a country code is printed as typed. */
const country = (code: string | null, lang: Lang) => {
  if (!code) return '';
  try {
    return /^[A-Z]{2}$/.test(code) ? (new Intl.DisplayNames([lang], { type: 'region' }).of(code) ?? code) : code;
  } catch {
    return code;
  }
};
const money = (v: string) => (Number.isFinite(Number(v)) && v.trim() !== '' ? Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : v);
/** Replaces {{placeholders}}; an unknown or empty one stays visible as a blank line to fill by hand. */
export const fill = (text: string, vars: Record<string, string>) => text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => (vars[key]?.trim() ? vars[key]! : '__________'));

/**
 * Ready-made documents. A draft is filled from the customer's record and the fields staff type; issuing freezes the
 * text (with its hash). The signer signs from a link (WhatsApp, SMS or e-mail) or at the counter, then the document
 * is handed over. Every step is audited; nothing issued is ever changed or deleted.
 */
@Injectable()
export class PaperworkService implements OnModuleInit {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly sequences: SequenceService,
    private readonly provisioning: ProvisioningService,
    private readonly resolver: TenantResolver,
    private readonly pdfs: FinancePdfService,
    private readonly erasure: ErasureRegistry,
  ) {}

  onModuleInit() {
    this.provisioning.registerTenantStep('paperwork.templates', (tx, tenant) => this.ensureTemplates(tx, tenant.id));
    this.provisioning.registerGlobalStep('paperwork.templates', async (tx) => {
      for (const t of await tx.tenant.findMany({ select: { id: true } })) await this.ensureTemplates(tx, t.id);
    });
    this.erasure.register('paperwork', (tx, subject) => this.erase(tx, subject));
  }

  async ensureTemplates(tx: Tx, tenantId: string) {
    const have = new Set((await tx.documentTemplate.findMany({ where: { tenantId }, select: { key: true } })).map((t) => t.key));
    const missing = BUILT_IN_TEMPLATES.filter((t) => !have.has(t.key));
    if (missing.length) await tx.documentTemplate.createMany({ data: missing.map((t) => ({ ...t, fields: t.fields as unknown as Prisma.InputJsonValue, tenantId, isBuiltIn: true })) });
  }

  // ------------------------------------------------------------------ templates
  async templates(includeInactive = false) {
    return this.db.tx(async (tx) => {
      await this.ensureTemplates(tx, this.db.tenantId);
      return tx.documentTemplate.findMany({ where: { tenantId: this.db.tenantId, ...(includeInactive ? {} : { isActive: true }) }, orderBy: [{ isBuiltIn: 'desc' }, { name: 'asc' }] });
    });
  }

  async createTemplate(input: DocumentTemplateInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      if (await tx.documentTemplate.findFirst({ where: { tenantId, key: input.key } })) throw Errors.conflict('TEMPLATE_KEY_TAKEN', `A template with the key ${input.key} already exists.`);
      const t = await tx.documentTemplate.create({ data: { ...input, fields: input.fields as unknown as Prisma.InputJsonValue, tenantId } });
      await this.audit.log({ action: 'paperwork.template_created', resourceType: 'DocumentTemplate', resourceId: t.id, summary: t.name }, tx);
      return t;
    });
  }

  async updateTemplate(id: string, input: UpdateDocumentTemplateInput) {
    return this.db.tx(async (tx) => {
      const before = found(await tx.documentTemplate.findFirst({ where: { id, tenantId: this.db.tenantId } }), 'Template');
      if (before.version !== input.version) throw Errors.conflict('STALE_VERSION', 'This template was changed in the meantime. Reload it and try again.');
      const { version: _v, fields, ...rest } = input;
      const t = await tx.documentTemplate.update({ where: { id }, data: { ...rest, ...(fields ? { fields: fields as unknown as Prisma.InputJsonValue } : {}), version: { increment: 1 } } });
      await this.audit.log({ action: 'paperwork.template_updated', resourceType: 'DocumentTemplate', resourceId: id, summary: `${t.name} (version ${t.version})`, before: { titleEn: before.titleEn, bodyEn: before.bodyEn }, after: { titleEn: t.titleEn, bodyEn: t.bodyEn } }, tx);
      return t;
    });
  }

  // ------------------------------------------------------------------ rendering
  private async variables(tx: Tx, customerId: string, fields: TemplateField[], values: Record<string, string>, lang: Lang) {
    const tenantId = this.db.tenantId;
    const c = found(await tx.customer.findFirst({ where: { id: customerId, tenantId, deletedAt: null } }), 'Customer');
    const tenant = await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { name: true, timezone: true } });
    const reveal = (enc: string | null) => {
      try {
        return enc ? decryptText(enc) : '';
      } catch {
        return '';
      }
    };
    const vars: Record<string, string> = {
      'customer.fullName': c.fullName,
      'customer.fullNameAr': c.fullNameAr || c.fullName,
      'customer.nationality': country(c.nationality, lang),
      'customer.passportNo': reveal(c.passportNoEnc),
      'customer.emiratesId': reveal(c.emiratesIdEnc),
      'customer.dateOfBirth': c.dateOfBirth ? longDate(c.dateOfBirth.toISOString().slice(0, 10), lang) : '',
      'customer.phone': c.phone ?? '',
      'customer.email': c.email ?? '',
      'centre.name': tenant.name,
      today: longDate(localDate(new Date(), tenant.timezone), lang),
    };
    for (const field of fields) {
      const raw = values[field.key] ?? '';
      vars[field.key] = field.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? longDate(raw, lang) : field.type === 'money' ? money(raw) : raw;
    }
    return { vars, customer: c };
  }

  private async render(tx: Tx, template: Prisma.DocumentTemplateGetPayload<object>, customerId: string, values: Record<string, string>) {
    const fields = template.fields as unknown as TemplateField[];
    const known = new Set(fields.map((f) => f.key));
    const clean = Object.fromEntries(Object.entries(values).filter(([k]) => known.has(k)).map(([k, v]) => [k, v.trim()]));
    const en = (await this.variables(tx, customerId, fields, clean, 'en')).vars;
    const ar = (await this.variables(tx, customerId, fields, clean, 'ar')).vars;
    return { values: clean, titleEn: fill(template.titleEn, en), titleAr: template.titleAr ? fill(template.titleAr, ar) : null, bodyEn: fill(template.bodyEn, en), bodyAr: template.bodyAr ? fill(template.bodyAr, ar) : null };
  }

  // ------------------------------------------------------------------ documents (staff)
  private present(d: Doc & { customer?: { fullName: string; customerNo: string } | null; template?: { name: string; nameAr: string | null; kind: string } | null }) {
    const { signatureImage, signedIp: _ip, ...rest } = d;
    return { ...rest, hasSignature: !!signatureImage, signatureImage: undefined };
  }

  async list(query: GeneratedDocumentQuery) {
    return this.db.tx(async (tx) => {
      const where: Prisma.GeneratedDocumentWhereInput = {
        tenantId: this.db.tenantId,
        ...(query.customerId ? { customerId: query.customerId } : {}),
        ...(query.requestId ? { requestId: query.requestId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.q ? { OR: [{ documentNo: { contains: query.q, mode: 'insensitive' } }, { titleEn: { contains: query.q, mode: 'insensitive' } }, { customer: { fullName: { contains: query.q, mode: 'insensitive' } } }] } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.generatedDocument.findMany({ where, ...pageArgs(query, ['createdAt', 'documentNo', 'status'], 'createdAt:desc'), include: { customer: { select: { fullName: true, customerNo: true } }, template: { select: { name: true, nameAr: true, kind: true } } } }),
        tx.generatedDocument.count({ where }),
      ]);
      return pageResult(rows.map((r) => this.present(r)), total, query);
    });
  }

  private async load(tx: Tx, id: string) {
    return found(await tx.generatedDocument.findFirst({ where: { id, tenantId: this.db.tenantId }, include: { customer: { select: { fullName: true, customerNo: true } }, template: { select: { name: true, nameAr: true, kind: true, fields: true } } } }), 'Document');
  }
  async get(id: string) {
    return this.db.tx(async (tx) => this.present(await this.load(tx, id)));
  }

  async create(input: CreateGeneratedDocumentInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const template = found(await tx.documentTemplate.findFirst({ where: { id: input.templateId, tenantId, isActive: true } }), 'Template');
      if (input.requestId) found(await tx.serviceRequest.findFirst({ where: { id: input.requestId, tenantId, customerId: input.customerId }, select: { id: true } }), 'Request');
      const rendered = await this.render(tx, template, input.customerId, input.values);
      const doc = await tx.generatedDocument.create({
        data: {
          tenantId, templateId: template.id, templateVersion: template.version, customerId: input.customerId, requestId: input.requestId ?? null, branchId: input.branchId ?? null,
          documentNo: await this.sequences.next(tx, 'paperwork'), requiresSignature: template.requiresSignature, createdById: ctx().userId ?? null,
          ...rendered, values: rendered.values as Prisma.InputJsonValue,
        },
      });
      await this.audit.log({ action: 'paperwork.drafted', resourceType: 'GeneratedDocument', resourceId: doc.id, summary: `${doc.documentNo} ${doc.titleEn} drafted` }, tx);
      return this.present(await this.load(tx, doc.id));
    });
  }

  async update(id: string, values: Record<string, string>) {
    return this.db.tx(async (tx) => {
      const doc = await this.load(tx, id);
      if (doc.status !== 'DRAFT') throw Errors.conflict('DOCUMENT_ISSUED', 'This document is issued and final. Void it and create a new one.');
      const template = await tx.documentTemplate.findFirstOrThrow({ where: { id: doc.templateId } });
      const rendered = await this.render(tx, template, doc.customerId, values);
      await tx.generatedDocument.update({ where: { id }, data: { ...rendered, values: rendered.values as Prisma.InputJsonValue, templateVersion: template.version } });
      return this.present(await this.load(tx, id));
    });
  }

  async removeDraft(id: string) {
    return this.db.tx(async (tx) => {
      const doc = await this.load(tx, id);
      if (doc.status !== 'DRAFT') throw Errors.conflict('DOCUMENT_ISSUED', 'An issued document is never deleted. Void it instead.');
      await tx.generatedDocument.delete({ where: { id } });
      await this.audit.log({ action: 'paperwork.draft_deleted', resourceType: 'GeneratedDocument', resourceId: id, summary: doc.documentNo }, tx);
      return { deleted: true };
    });
  }

  /** Freezes the text. Fields marked required must be filled; when a signature is needed the signer is sent the link. */
  async issue(id: string) {
    return this.db.tx(async (tx) => {
      const doc = await this.load(tx, id);
      if (doc.status !== 'DRAFT') throw Errors.conflict('DOCUMENT_ISSUED', 'This document is already issued.');
      const fields = doc.template!.fields as unknown as TemplateField[];
      const values = doc.values as Record<string, string>;
      const missing = fields.filter((f) => f.required && !values[f.key]?.trim());
      if (missing.length) throw Errors.unprocessable('FIELDS_MISSING', `Fill in: ${missing.map((f) => f.label).join(', ')}.`, { fields: missing.map((f) => f.key) });
      const contentHash = sha256([doc.titleEn, doc.titleAr ?? '', doc.bodyEn, doc.bodyAr ?? ''].join('\u0000'));
      await tx.generatedDocument.update({ where: { id }, data: { status: 'ISSUED', issuedAt: new Date(), contentHash } });
      await this.audit.log({ action: 'paperwork.issued', resourceType: 'GeneratedDocument', resourceId: id, summary: `${doc.documentNo} issued`, after: { contentHash } }, tx);
      if (doc.requiresSignature) {
        await this.events.emit(tx, 'paperwork.signature_requested', { documentId: id, documentNo: doc.documentNo, customerId: doc.customerId, title: doc.titleEn, titleAr: doc.titleAr, signLink: await this.signLink(id) });
      }
      return this.present(await this.load(tx, id));
    });
  }

  async signLink(id: string) {
    return this.resolver.portalLink(this.db.tenantId, '/sign', { t: signPayload({ k: 'sign', t: this.db.tenantId, d: id }, SIGN_LINK_TTL) });
  }

  private async applySignature(tx: Tx, id: string, input: SignDocumentInput, via: 'LINK' | 'COUNTER') {
    const doc = await this.load(tx, id);
    if (doc.status === 'SIGNED' || doc.status === 'HANDED_OVER') throw Errors.conflict('ALREADY_SIGNED', 'This document is already signed.');
    if (doc.status !== 'ISSUED') throw Errors.conflict('NOT_SIGNABLE', doc.status === 'VOID' ? 'This document was withdrawn.' : 'This document is not ready to sign yet.');
    if (!doc.requiresSignature) throw Errors.conflict('NO_SIGNATURE_NEEDED', 'This document does not need a signature.');
    const png = Buffer.from(input.signatureImage.split(',')[1] ?? '', 'base64');
    // A real PNG of reasonable size, not an empty canvas.
    if (png.length < 200 || png.subarray(1, 4).toString('latin1') !== 'PNG') throw Errors.unprocessable('SIGNATURE_INVALID', 'Please draw your signature.');
    const changed = await tx.generatedDocument.updateMany({ where: { id, tenantId: this.db.tenantId, status: 'ISSUED' }, data: { status: 'SIGNED', signerName: input.signerName, signatureImage: input.signatureImage, signedAt: new Date(), signedVia: via, signedIp: ctx().ip ?? null } });
    if (!changed.count) throw Errors.conflict('ALREADY_SIGNED', 'This document was just signed.');
    await this.audit.log({ action: 'paperwork.signed', resourceType: 'GeneratedDocument', resourceId: id, summary: `${doc.documentNo} signed by ${input.signerName} (${via === 'LINK' ? 'link' : 'counter'})`, after: { signerName: input.signerName, via, contentHash: doc.contentHash } }, tx);
    await this.events.emit(tx, 'paperwork.signed', { documentId: id, documentNo: doc.documentNo, customerId: doc.customerId, via });
  }

  async signAtCounter(id: string, input: SignDocumentInput) {
    return this.db.tx(async (tx) => {
      await this.applySignature(tx, id, input, 'COUNTER');
      return this.present(await this.load(tx, id));
    });
  }

  async handOver(id: string, handedOverTo: string, note?: string | null) {
    return this.db.tx(async (tx) => {
      const doc = await this.load(tx, id);
      const ready = doc.status === 'SIGNED' || (doc.status === 'ISSUED' && !doc.requiresSignature);
      if (!ready) throw Errors.conflict('NOT_READY', doc.status === 'ISSUED' ? 'Wait for the signature before handing the document over.' : `This document is ${doc.status.toLowerCase().replace('_', ' ')}.`);
      await tx.generatedDocument.update({ where: { id }, data: { status: 'HANDED_OVER', handedOverAt: new Date(), handedOverById: ctx().userId ?? null, handedOverTo, handoverNote: note ?? null } });
      await this.audit.log({ action: 'paperwork.handed_over', resourceType: 'GeneratedDocument', resourceId: id, summary: `${doc.documentNo} handed over to ${handedOverTo}`, after: { handedOverTo, note: note ?? null } }, tx);
      return this.present(await this.load(tx, id));
    });
  }

  async void(id: string, reason: string) {
    return this.db.tx(async (tx) => {
      const doc = await this.load(tx, id);
      if (doc.status === 'DRAFT') throw Errors.conflict('IS_DRAFT', 'Delete a draft instead of voiding it.');
      if (doc.status === 'VOID') throw Errors.conflict('ALREADY_VOID', 'This document is already void.');
      await tx.generatedDocument.update({ where: { id }, data: { status: 'VOID', voidedAt: new Date(), voidReason: reason } });
      await this.audit.log({ action: 'paperwork.voided', resourceType: 'GeneratedDocument', resourceId: id, summary: `${doc.documentNo} voided: ${reason}`, before: { status: doc.status } }, tx);
      return this.present(await this.load(tx, id));
    });
  }

  async pdf(id: string) {
    const doc = await this.db.tx((tx) => this.load(tx, id));
    return this.renderPdf(doc);
  }

  private async renderPdf(doc: Doc) {
    const brand = await this.pdfs.brand(doc.branchId, 'invoiceFooter');
    const tz = await this.db.tx(async (tx) => (await tx.tenant.findFirstOrThrow({ where: { id: this.db.tenantId }, select: { timezone: true } })).timezone);
    const stamp = (d: Date) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: tz }).format(d);
    const content = await renderLetter({
      brand,
      documentNo: doc.documentNo,
      date: longDate(localDate(doc.issuedAt ?? doc.createdAt, tz)),
      titleEn: doc.titleEn,
      titleAr: doc.titleAr,
      bodyEn: doc.bodyEn,
      bodyAr: doc.bodyAr,
      requiresSignature: doc.requiresSignature,
      signature: doc.signedAt && doc.signerName ? { name: doc.signerName, image: doc.signatureImage ? Buffer.from(doc.signatureImage.split(',')[1] ?? '', 'base64') : null, at: stamp(doc.signedAt), via: doc.signedVia ?? 'COUNTER' } : null,
      reference: doc.contentHash ? doc.contentHash.slice(0, 16).toUpperCase() : null,
      draft: doc.status === 'DRAFT' || doc.status === 'VOID',
    });
    return { filename: `${doc.documentNo}.pdf`, content };
  }

  // ------------------------------------------------------------------ signing link (public)
  private decode(token: string) {
    const p = verifyPayload<{ k: string; t: string; d: string }>(token);
    if (!p || p.k !== 'sign' || typeof p.t !== 'string' || typeof p.d !== 'string') throw Errors.notFound('Document');
    return p;
  }

  /** What the signer reads before signing: the full text, nothing else of the customer's record. */
  async publicView(token: string) {
    const p = this.decode(token);
    return runAsTenant(p.t, () =>
      this.db.tx(async (tx) => {
        const doc = await this.load(tx, p.d);
        const tenant = await tx.tenant.findFirstOrThrow({ where: { id: p.t }, select: { name: true } });
        return { centreName: tenant.name, documentNo: doc.documentNo, status: doc.status, titleEn: doc.titleEn, titleAr: doc.titleAr, bodyEn: doc.bodyEn, bodyAr: doc.bodyAr, requiresSignature: doc.requiresSignature, signerName: doc.signerName, signedAt: doc.signedAt, suggestedSigner: doc.customer?.fullName ?? null };
      }),
    );
  }

  async publicSign(token: string, input: SignDocumentInput) {
    const p = this.decode(token);
    return runAsTenant(p.t, () =>
      this.db.tx(async (tx) => {
        await this.applySignature(tx, p.d, input, 'LINK');
        return { signed: true };
      }),
    );
  }

  /** The signed copy, for the person holding the link. */
  async publicPdf(token: string) {
    const p = this.decode(token);
    return runAsTenant(p.t, async () => {
      const doc = await this.db.tx((tx) => this.load(tx, p.d));
      if (!['SIGNED', 'HANDED_OVER', 'ISSUED'].includes(doc.status)) throw Errors.notFound('Document');
      return this.renderPdf(doc);
    });
  }

  // ------------------------------------------------------------------ privacy
  async erase(tx: Tx, subject: ErasureSubject) {
    const tenantId = this.db.tenantId;
    const where = { tenantId, customerId: { in: subject.customerIds } };
    const drafts = await tx.generatedDocument.deleteMany({ where: { ...where, status: 'DRAFT' } });
    const redacted = await tx.generatedDocument.updateMany({
      where: { ...where, status: { not: 'DRAFT' } },
      data: { status: 'VOID', voidReason: ERASED, voidedAt: new Date(), titleEn: '[erased]', titleAr: null, bodyEn: '[erased]', bodyAr: null, values: {}, signatureImage: null, signerName: null, signedIp: null, handedOverTo: null, handoverNote: null },
    });
    return { draftsDeleted: drafts.count, documentsRedacted: redacted.count };
  }
}
