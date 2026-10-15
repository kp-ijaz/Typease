import { customerErasedError } from '../../common/customer-ref';
import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Prisma } from '@typease/database';
import type { DataSubjectRequest } from '@typease/database';
import type { PrivacyCompleteInput, PrivacyDecisionInput, PrivacyRequestInput, PrivacyRequestListQuery, PrivacyStaffRequestInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { decryptText } from '../../common/crypto';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { ErasureRegistry, ErasureReport, ErasureSubject, identifierPattern, scrubText } from '../../common/erasure';
import { Errors, found } from '../../common/errors';
import { JobQueue } from '../../common/jobs/job-queue';
import { pageArgs, pageResult } from '../../common/pagination';
import { DocumentStorePort } from '../../common/ports';
import { ownCustomerId } from '../../common/scope';
import { DocumentRetentionService } from '../documents/retention.service';
import { ErasureSystemService } from './erasure-system.service';

/** Default time allowed to answer a request. */
export const DSR_DUE_DAYS = 30;
const OPEN_STATUSES = ['RECEIVED', 'IN_REVIEW', 'APPROVED'] as const;
const OPEN_REQUEST: Prisma.ServiceRequestWhereInput = { status: { notIn: ['COMPLETED', 'CANCELLED'] }, deletedAt: null };
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
/** After an erasure committed: remove the files of the deleted documents now and close the person's logins (also the retry for both). */
export const ERASURE_FINALISE_JOB = 'privacy.erasure_finalise';
const nonEmpty = (values: Array<string | null | undefined>) => [...new Set(values.filter((v): v is string => !!v && !!v.trim()))];

interface ErasureOutcome {
  blocked: string | null;
  retained: string | null;
  counts: Record<string, unknown>;
  /** Accounts whose sessions end and which are anonymised when they are used for nothing else. */
  userIds: string[];
}

/**
 * Data subject requests: access, correction, deletion and export.
 *
 *   RECEIVED -> IN_REVIEW -> APPROVED -> COMPLETED
 *                        \-> REJECTED
 *
 * A request is decided by a person with a written note; completing it performs
 * the technical action (build the export, anonymise the customer) and records
 * what had to be retained. These are technical controls that support a
 * privacy process; they do not by themselves make a centre compliant.
 */
@Injectable()
export class DataSubjectRequestService implements OnModuleInit {
  private readonly logger = new Logger(DataSubjectRequestService.name);

  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly registry: ErasureRegistry,
    private readonly system: ErasureSystemService,
    private readonly jobs: JobQueue,
    private readonly retention: DocumentRetentionService,
    @Optional() private readonly store?: DocumentStorePort,
  ) {}

  onModuleInit() {
    // The privacy module's own tables.
    this.registry.register('privacy', async (tx, subject) => {
      // What the person wrote when asking; the notes staff wrote lose the person's identifiers.
      const pattern = identifierPattern(subject.identifiers);
      const rows = await tx.dataSubjectRequest.findMany({ where: { tenantId: this.db.tenantId, customerId: { in: subject.customerIds } }, select: { id: true, details: true, decisionNote: true, retentionException: true } });
      for (const row of rows) {
        await tx.dataSubjectRequest.update({ where: { id: row.id }, data: { details: null, decisionNote: scrubText(row.decisionNote, pattern), retentionException: scrubText(row.retentionException, pattern) } });
      }
      return { privacyRequests: rows.length };
    });
    this.jobs.register<{ tenantId: string; privacyRequestId: string; userIds: string[] }>(
      ERASURE_FINALISE_JOB,
      async (payload) => {
        await this.system.closeLogins(payload.tenantId, payload.userIds ?? [], payload.privacyRequestId);
        // No restore window for an erasure: the files go now, not with the nightly run.
        await this.retention.purgeTenant();
      },
      { attempts: 5, backoffMs: 60_000 },
    );
  }

  private present(r: DataSubjectRequest, forCustomer = false) {
    const overdue = !!r.dueAt && r.dueAt < new Date() && (OPEN_STATUSES as readonly string[]).includes(r.status);
    const base = {
      id: r.id,
      customerId: r.customerId,
      type: r.type,
      status: r.status,
      details: r.details,
      decisionNote: r.decisionNote,
      retentionException: r.retentionException,
      exportDocumentId: r.exportDocumentId,
      dueAt: r.dueAt,
      overdue,
      completedAt: r.completedAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
    return forCustomer ? base : { ...base, requestedByUserId: r.requestedByUserId, handledById: r.handledById };
  }

  // ------------------------------------------------------------------ create
  private async create(tx: Tx, customerId: string, input: PrivacyRequestInput, dueAt: Date, source: 'CUSTOMER' | 'STAFF') {
    const tenantId = this.db.tenantId;
    const customer = found(await tx.customer.findFirst({ where: { id: customerId, tenantId } }), 'Customer');
    if (customer.status === 'ANONYMISED') throw customerErasedError();
    const duplicate = await tx.dataSubjectRequest.findFirst({ where: { tenantId, customerId, type: input.type, status: { in: [...OPEN_STATUSES] } } });
    if (duplicate) throw Errors.conflict('REQUEST_ALREADY_OPEN', 'A request of this kind is already being handled. You will be told when it is finished.', { id: duplicate.id });
    const row = await tx.dataSubjectRequest.create({
      data: { tenantId, customerId, requestedByUserId: ctx().userId ?? null, type: input.type, status: 'RECEIVED', details: input.details ?? null, dueAt },
    });
    await this.audit.log({ action: 'privacy.request_received', resourceType: 'DataSubjectRequest', resourceId: row.id, after: { customerId, type: row.type, source, dueAt } }, tx);
    return row;
  }

  /** A customer files a request for their own data. */
  async createOwn(input: PrivacyRequestInput) {
    const customerId = ownCustomerId();
    return this.db.tx(async (tx) => this.present(await this.create(tx, customerId, input, new Date(Date.now() + DSR_DUE_DAYS * 86400_000), 'CUSTOMER'), true));
  }
  async listOwn() {
    const customerId = ownCustomerId();
    return this.db.tx(async (tx) => {
      const rows = await tx.dataSubjectRequest.findMany({ where: { tenantId: this.db.tenantId, customerId }, orderBy: { createdAt: 'desc' }, take: 100 });
      return rows.map((r) => this.present(r, true));
    });
  }
  async getOwn(id: string) {
    const customerId = ownCustomerId();
    return this.db.tx(async (tx) => this.present(found(await tx.dataSubjectRequest.findFirst({ where: { id, tenantId: this.db.tenantId, customerId } }), 'Privacy request'), true));
  }

  /** Staff record a request that reached the centre by another channel. */
  async createForCustomer(input: PrivacyStaffRequestInput) {
    const dueAt = input.dueAt ? new Date(`${input.dueAt}T23:59:59.999Z`) : new Date(Date.now() + DSR_DUE_DAYS * 86400_000);
    if (dueAt.getTime() < Date.now()) throw Errors.unprocessable('DUE_DATE_IN_PAST', 'The due date must be in the future.');
    return this.db.tx(async (tx) => this.present(await this.create(tx, input.customerId, input, dueAt, 'STAFF')));
  }

  // ------------------------------------------------------------------ staff read
  async list(query: PrivacyRequestListQuery) {
    return this.db.tx(async (tx) => {
      const where: Prisma.DataSubjectRequestWhereInput = {
        tenantId: this.db.tenantId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.type ? { type: query.type } : {}),
        ...(query.customerId ? { customerId: query.customerId } : {}),
        ...(query.overdue ? { status: { in: [...OPEN_STATUSES] }, dueAt: { lt: new Date() } } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.dataSubjectRequest.findMany({ where, ...pageArgs(query, ['createdAt', 'dueAt', 'updatedAt'] as const, 'createdAt:desc'), include: { customer: { select: { id: true, customerNo: true, fullName: true, status: true } } } }),
        tx.dataSubjectRequest.count({ where }),
      ]);
      return pageResult(rows.map((r) => ({ ...this.present(r), customer: r.customer })), total, query);
    });
  }

  async get(id: string) {
    return this.db.tx(async (tx) => {
      const row = found(await tx.dataSubjectRequest.findFirst({ where: { id, tenantId: this.db.tenantId }, include: { customer: { select: { id: true, customerNo: true, fullName: true, status: true } } } }), 'Privacy request');
      const impact = row.type === 'DELETION' && row.status !== 'COMPLETED' ? await this.erasureImpact(tx, row.customerId) : null;
      return { ...this.present(row), customer: row.customer, ...(impact ? { erasureImpact: impact } : {}) };
    });
  }

  // ------------------------------------------------------------------ workflow
  async startReview(id: string) {
    return this.db.tx(async (tx) => {
      const before = found(await tx.dataSubjectRequest.findFirst({ where: { id, tenantId: this.db.tenantId } }), 'Privacy request');
      if (before.status !== 'RECEIVED') throw Errors.conflict('INVALID_TRANSITION', `A request that is ${before.status} cannot be taken into review.`);
      const after = await tx.dataSubjectRequest.update({ where: { id: before.id }, data: { status: 'IN_REVIEW', handledById: ctx().userId ?? null } });
      await this.audit.log({ action: 'privacy.request_in_review', resourceType: 'DataSubjectRequest', resourceId: id, before: { status: before.status }, after: { status: after.status } }, tx);
      return this.present(after);
    });
  }

  async decide(id: string, input: PrivacyDecisionInput) {
    return this.db.tx(async (tx) => {
      const before = found(await tx.dataSubjectRequest.findFirst({ where: { id, tenantId: this.db.tenantId } }), 'Privacy request');
      if (!['RECEIVED', 'IN_REVIEW'].includes(before.status)) throw Errors.conflict('INVALID_TRANSITION', `A request that is ${before.status} has already been decided.`);
      const rejected = input.decision === 'REJECTED';
      const after = await tx.dataSubjectRequest.update({
        where: { id: before.id },
        data: { status: input.decision, decisionNote: input.decisionNote, handledById: ctx().userId ?? null, ...(rejected ? { completedAt: new Date() } : {}) },
      });
      await this.audit.log(
        { action: rejected ? 'privacy.request_rejected' : 'privacy.request_approved', resourceType: 'DataSubjectRequest', resourceId: id, summary: input.decisionNote, before: { status: before.status }, after: { status: after.status } },
        tx,
      );
      return this.present(after);
    });
  }

  /**
   * Carries out an approved request. A deletion that cannot go ahead (open
   * requests, unpaid invoices) is NOT completed: the reason is stored on the
   * request and the call answers 409.
   */
  async complete(id: string, input: PrivacyCompleteInput) {
    const outcome = await this.db.tx(
      async (tx) => {
        const tenantId = this.db.tenantId;
        const before = found(await tx.dataSubjectRequest.findFirst({ where: { id, tenantId } }), 'Privacy request');
        if (before.status === 'COMPLETED') return { row: before, blocked: null, erased: null };
        if (before.status !== 'APPROVED') throw Errors.conflict('NOT_APPROVED', 'Only an approved request can be completed. Record the decision first.');

        let exportDocumentId: string | null = before.exportDocumentId;
        let retentionException: string | null = null;
        let erasure: ErasureOutcome | null = null;
        if (before.type === 'ACCESS' || before.type === 'EXPORT') {
          exportDocumentId = await this.generateExport(tx, before);
        } else if (before.type === 'CORRECTION') {
          if (!input.note) throw Errors.unprocessable('NOTE_REQUIRED', 'Describe what was corrected (the profile itself is changed in the customer record).');
        } else {
          const erased = await this.erase(tx, before);
          if (erased.blocked) {
            await tx.dataSubjectRequest.update({ where: { id: before.id }, data: { retentionException: erased.blocked, handledById: ctx().userId ?? null } });
            await this.audit.log({ action: 'privacy.erasure_blocked', resourceType: 'DataSubjectRequest', resourceId: id, summary: erased.blocked, after: erased.counts }, tx);
            return { row: before, blocked: erased, erased: null };
          }
          retentionException = erased.retained;
          erasure = erased;
        }
        const note = input.note ? `${before.decisionNote ? `${before.decisionNote}\n\n` : ''}Completion: ${input.note}` : before.decisionNote;
        const row = await tx.dataSubjectRequest.update({
          where: { id: before.id },
          data: { status: 'COMPLETED', completedAt: new Date(), handledById: ctx().userId ?? null, exportDocumentId, retentionException, decisionNote: note },
        });
        await this.audit.log(
          { action: 'privacy.request_completed', resourceType: 'DataSubjectRequest', resourceId: id, summary: retentionException ?? undefined, before: { status: before.status }, after: { status: 'COMPLETED', type: before.type, exportDocumentId } },
          tx,
        );
        return { row, blocked: null, erased: erasure };
      },
      { timeoutMs: 180_000 },
    );
    if (outcome.blocked) {
      // Thrown after the transaction committed, so the recorded reason is kept.
      throw Errors.conflict('ERASURE_BLOCKED', outcome.blocked.blocked!, outcome.blocked.counts);
    }
    if (outcome.erased) await this.afterErasure(id, outcome.erased.userIds);
    return this.present(outcome.row);
  }

  // ------------------------------------------------------------------ export
  /** Everything the centre holds about the customer, as one JSON file in the vault (visible to the customer). */
  private async generateExport(tx: Tx, dsr: DataSubjectRequest): Promise<string> {
    if (!this.store) throw Errors.notConfigured('The document vault', 'The documents module must be enabled to store data exports.');
    const tenantId = this.db.tenantId;
    const customer = found(await tx.customer.findFirst({ where: { id: dsr.customerId, tenantId } }), 'Customer');
    const tenant = await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { name: true, legalName: true } });
    const [contacts, consents, consentHistory, requests, documents, hiddenDocuments, invoices, payments] = await Promise.all([
      tx.customerContact.findMany({ where: { tenantId, customerId: customer.id } }),
      tx.customerConsent.findMany({ where: { tenantId, customerId: customer.id } }),
      tx.consentRecord.findMany({ where: { tenantId, customerId: customer.id }, orderBy: { createdAt: 'asc' } }),
      tx.serviceRequest.findMany({ where: { tenantId, customerId: customer.id, deletedAt: null }, orderBy: { createdAt: 'asc' }, include: { requestFields: true } }),
      tx.document.findMany({ where: { tenantId, customerId: customer.id, status: { notIn: ['DELETED', 'PENDING_UPLOAD'] }, customerVisible: true }, orderBy: { createdAt: 'asc' }, include: { documentVersions: { orderBy: { versionNo: 'asc' } } } }),
      tx.document.count({ where: { tenantId, customerId: customer.id, status: { notIn: ['DELETED', 'PENDING_UPLOAD'] }, customerVisible: false } }),
      // What the customer could see in the portal: no drafts, no invoice that was voided before it was ever issued.
      tx.invoice.findMany({ where: { tenantId, customerId: customer.id, NOT: [{ status: 'DRAFT' }, { status: 'VOID', issuedAt: null }] }, orderBy: { createdAt: 'asc' } }),
      tx.payment.findMany({ where: { tenantId, customerId: customer.id }, orderBy: { createdAt: 'asc' } }),
    ]);
    const data = {
      meta: {
        format: 'typease.personal-data-export/v1',
        generatedAt: new Date().toISOString(),
        centre: tenant.legalName ?? tenant.name,
        privacyRequestId: dsr.id,
        requestType: dsr.type,
        notes: [
          'This file contains your personal data, including identity document numbers. Keep it safe.',
          'Files themselves are not embedded: download them from your documents list.',
          ...(hiddenDocuments ? [`${hiddenDocuments} internal working document(s) of the centre are not listed.`] : []),
          "Internal staff notes are not part of this export.",
        ],
      },
      profile: {
        customerNo: customer.customerNo,
        type: customer.type,
        status: customer.status,
        fullName: customer.fullName,
        fullNameAr: customer.fullNameAr,
        preferredLanguage: customer.preferredLanguage,
        email: customer.email,
        phone: customer.phone,
        nationality: customer.nationality,
        dateOfBirth: day(customer.dateOfBirth),
        address: customer.address,
        // Identity numbers are decrypted for this export only.
        emiratesId: customer.emiratesIdEnc ? decryptText(customer.emiratesIdEnc) : null,
        emiratesIdExpiry: day(customer.emiratesIdExpiry),
        passportNo: customer.passportNoEnc ? decryptText(customer.passportNoEnc) : null,
        passportCountry: customer.passportCountry,
        passportExpiry: day(customer.passportExpiry),
        communicationPrefs: customer.communicationPrefs,
        marketingOptIn: customer.marketingOptIn,
        registeredAt: customer.createdAt,
      },
      contacts: contacts.map((c) => ({ type: c.type, value: c.value, label: c.label, isPrimary: c.isPrimary })),
      consents: {
        current: consents.map((c) => ({ purpose: c.purpose, status: c.status, lawfulBasis: c.lawfulBasis, noticeVersion: c.noticeVersion, grantedAt: c.grantedAt, withdrawnAt: c.withdrawnAt })),
        history: consentHistory.map((c) => ({ purpose: c.purpose, status: c.status, lawfulBasis: c.lawfulBasis, noticeVersion: c.noticeVersion, capturedVia: c.capturedVia, at: c.createdAt })),
      },
      requests: requests.map((r) => ({
        requestNo: r.requestNo,
        service: (r.serviceSnapshot as any)?.name ?? null,
        status: r.status,
        source: r.source,
        createdAt: r.createdAt,
        submittedAt: r.submittedAt,
        completedAt: r.completedAt,
        cancelledAt: r.cancelledAt,
        instructions: r.customerInstructions,
        formData: r.requestFields.map((f) => ({ key: f.key, value: f.value, source: f.source })),
      })),
      documents: documents.map((d) => ({
        id: d.id,
        title: d.title,
        documentTypeKey: d.documentTypeKey,
        category: d.category,
        status: d.status,
        verificationStatus: d.verificationStatus,
        issuedDate: day(d.issuedDate),
        expiryDate: day(d.expiryDate),
        uploadedAt: d.createdAt,
        files: d.documentVersions.filter((v) => v.uploadStatus === 'COMPLETED').map((v) => ({ versionNo: v.versionNo, filename: v.originalFilename, mime: v.detectedMime ?? v.declaredMime, sizeBytes: Number(v.sizeBytes), uploadedAt: v.createdAt })),
      })),
      invoices: invoices.map((i) => ({ invoiceNo: i.invoiceNo, status: i.status, currency: i.currency, total: i.total.toFixed(2), amountPaid: i.amountPaid.toFixed(2), balanceDue: i.balanceDue.toFixed(2), issuedAt: i.issuedAt, dueAt: i.dueAt })),
      payments: payments.map((p) => ({ paymentNo: p.paymentNo, receiptNo: p.receiptNo, method: p.method, status: p.status, amount: p.amount.toFixed(2), refundedAmount: p.refundedAmount.toFixed(2), currency: p.currency, receivedAt: p.receivedAt })),
    };
    const stamp = new Date().toISOString().slice(0, 10);
    const stored = await this.store.storeGenerated({
      customerId: customer.id,
      documentTypeKey: 'data_export',
      title: `Personal data export ${stamp}`,
      filename: `personal-data-export-${customer.customerNo}-${stamp}.json`,
      mime: 'application/json',
      content: Buffer.from(JSON.stringify(data, null, 2), 'utf8'),
      customerVisible: true,
    });
    await this.audit.log(
      { action: 'privacy.export_generated', resourceType: 'Customer', resourceId: customer.id, summary: 'Personal data export created (identity numbers included in the file).', after: { documentId: stored.documentId, privacyRequestId: dsr.id, sections: Object.keys(data) } },
      tx,
    );
    return stored.documentId;
  }

  // ------------------------------------------------------------------ erasure
  /** The record a request is about plus every record merged into it: one person. */
  private async recordsOf(tx: Tx, customerId: string): Promise<string[]> {
    const tenantId = this.db.tenantId;
    const ids = new Set<string>([customerId]);
    let frontier = [customerId];
    // The merge keeps the history flat; the loop only guards against older data.
    for (let depth = 0; depth < 10 && frontier.length; depth++) {
      const merged = await tx.customer.findMany({ where: { tenantId, status: 'MERGED', mergedIntoId: { in: frontier } }, select: { id: true } });
      frontier = merged.map((m) => m.id).filter((id) => !ids.has(id));
      for (const id of frontier) ids.add(id);
    }
    return [...ids];
  }

  /** The one rule for what stands in the way of an erasure: open service requests and invoices with a balance due. */
  private async obstacles(tx: Tx, customerIds: string[]) {
    const tenantId = this.db.tenantId;
    const [requests, invoices] = await Promise.all([
      tx.serviceRequest.findMany({ where: { tenantId, customerId: { in: customerIds }, ...OPEN_REQUEST }, orderBy: { createdAt: 'asc' }, select: { id: true, requestNo: true, status: true } }),
      tx.invoice.findMany({ where: { tenantId, customerId: { in: customerIds }, status: { in: ['ISSUED', 'PARTIALLY_PAID'] }, balanceDue: { gt: 0 } }, orderBy: { createdAt: 'asc' }, select: { id: true, invoiceNo: true, balanceDue: true, currency: true } }),
    ]);
    return { requests, invoices: invoices.map((i) => ({ id: i.id, invoiceNo: i.invoiceNo, balanceDue: i.balanceDue.toFixed(2), currency: i.currency })) };
  }

  /** What stands in the way of, or survives, an erasure. Shown to staff before they decide. */
  async erasureImpact(tx: Tx, customerId: string) {
    const tenantId = this.db.tenantId;
    const now = new Date();
    const customerIds = await this.recordsOf(tx, customerId);
    const mine = { tenantId, customerId: { in: customerIds } };
    const [obstacles, closedRequests, invoices, payments, documents, heldDocuments] = await Promise.all([
      this.obstacles(tx, customerIds),
      tx.serviceRequest.count({ where: { ...mine, deletedAt: null, status: { in: ['COMPLETED', 'CANCELLED'] } } }),
      tx.invoice.count({ where: { ...mine, status: { not: 'DRAFT' } } }),
      tx.payment.count({ where: mine }),
      tx.document.count({ where: { ...mine, status: { not: 'DELETED' } } }),
      tx.document.count({ where: { ...mine, status: { not: 'DELETED' }, OR: [{ legalHold: true }, { retentionUntil: { gt: now } }] } }),
    ]);
    const openRequests = obstacles.requests.length;
    const unpaidInvoices = obstacles.invoices.length;
    return { openRequests, unpaidInvoices, closedRequests, invoices, payments, documents, heldDocuments, canProceed: openRequests === 0 && unpaidInvoices === 0 };
  }

  /**
   * Everything the erasure steps need to know about the person, read BEFORE anything is changed:
   * their records, logins and requests, what they were known by (to find copies in free text), and
   * the ids of everything that belongs to them (to find the entries about them in the trails).
   */
  private async subjectOf(tx: Tx, dsr: DataSubjectRequest, customerIds: string[]) {
    const tenantId = this.db.tenantId;
    const mine = { tenantId, customerId: { in: customerIds } };
    const records = await tx.customer.findMany({ where: { tenantId, id: { in: customerIds } } });
    const contacts = await tx.customerContact.findMany({ where: mine, select: { type: true, value: true } });
    // Portal logins: linked to one of the records directly, or through the person's employment record.
    const memberships = await tx.tenantMembership.findMany({
      where: { tenantId, kind: { in: ['CUSTOMER', 'CORPORATE'] }, OR: [{ customerId: { in: customerIds } }, { corporateEmployee: { customerId: { in: customerIds } } }] },
      select: { id: true, kind: true, userId: true, user: { select: { email: true, phone: true, fullName: true } } },
    });
    const requests = await tx.serviceRequest.findMany({ where: mine, select: { id: true } });
    const requestIds = requests.map((r) => r.id);
    const decrypt = (value: string | null) => {
      if (!value) return null;
      try {
        return decryptText(value);
      } catch {
        return null;
      }
    };
    const subject: ErasureSubject = {
      tenantId,
      privacyRequestId: dsr.id,
      customerId: dsr.customerId,
      customerIds,
      userIds: [...new Set(memberships.map((m) => m.userId))],
      requestIds,
      resourceIds: [],
      identifiers: {
        names: nonEmpty([...records.flatMap((r) => [r.fullName, r.fullNameAr]), ...memberships.map((m) => m.user.fullName)]),
        emails: nonEmpty([...records.map((r) => r.email), ...contacts.filter((c) => c.type === 'EMAIL').map((c) => c.value), ...memberships.map((m) => m.user.email)]),
        phones: nonEmpty([...records.map((r) => r.phone), ...contacts.filter((c) => c.type !== 'EMAIL').map((c) => c.value), ...memberships.map((m) => m.user.phone)]),
        identityNumbers: nonEmpty(records.flatMap((r) => [decrypt(r.emiratesIdEnc), decrypt(r.passportNoEnc)])),
      },
    };
    // Ids of everything that belongs to the person, for the entries about them in the audit trail.
    const ofRequests = requestIds.length ? [{ requestId: { in: requestIds } }] : [];
    const idsOf = async (rows: Promise<Array<{ id: string }>>) => (await rows).map((r) => r.id);
    const [documents, quotations, invoices, payments, appointments, tickets, schedules, dsrs, employees, tasks] = await Promise.all([
      idsOf(tx.document.findMany({ where: { tenantId, OR: [{ customerId: { in: customerIds } }, ...ofRequests] }, select: { id: true } })),
      idsOf(tx.quotation.findMany({ where: mine, select: { id: true } })),
      idsOf(tx.invoice.findMany({ where: mine, select: { id: true } })),
      idsOf(tx.payment.findMany({ where: mine, select: { id: true } })),
      idsOf(tx.appointment.findMany({ where: mine, select: { id: true } })),
      idsOf(tx.supportTicket.findMany({ where: mine, select: { id: true } })),
      idsOf(tx.reminderSchedule.findMany({ where: mine, select: { id: true } })),
      idsOf(tx.dataSubjectRequest.findMany({ where: mine, select: { id: true } })),
      idsOf(tx.corporateEmployee.findMany({ where: mine, select: { id: true } })),
      idsOf(tx.task.findMany({ where: { tenantId, OR: [{ customerId: { in: customerIds } }, ...ofRequests] }, select: { id: true } })),
    ]);
    const [refunds, creditNotes, extractions] = await Promise.all([
      payments.length ? idsOf(tx.refund.findMany({ where: { tenantId, paymentId: { in: payments } }, select: { id: true } })) : [],
      invoices.length ? idsOf(tx.creditNote.findMany({ where: { tenantId, invoiceId: { in: invoices } }, select: { id: true } })) : [],
      documents.length ? idsOf(tx.ocrExtractionResult.findMany({ where: { tenantId, documentId: { in: documents } }, select: { id: true } })) : [],
    ]);
    subject.resourceIds = [...new Set([...customerIds, ...requestIds, ...documents, ...quotations, ...invoices, ...payments, ...refunds, ...creditNotes, ...appointments, ...tickets, ...schedules, ...dsrs, ...employees, ...tasks, ...extractions, ...memberships.map((m) => m.id)])];
    return { subject, memberships };
  }

  /**
   * Carries out an erasure, inside the caller's tenant transaction:
   *   1. the one policy check (open requests, unpaid invoices) - a blocked erasure changes nothing;
   *   2. the person's values are taken out of the append-only trails (system connection);
   *   3. every module removes or anonymises what it holds about the person (ErasureRegistry);
   *   4. the portal logins of the person for this centre are removed.
   * What must be kept - financial records, the trails themselves, documents under legal hold - is
   * kept, pointing at a customer record that no longer says who it was.
   */
  private async erase(tx: Tx, dsr: DataSubjectRequest): Promise<ErasureOutcome> {
    const tenantId = this.db.tenantId;
    const customer = found(await tx.customer.findFirst({ where: { id: dsr.customerId, tenantId } }), 'Customer');
    const customerIds = await this.recordsOf(tx, customer.id);
    const counts = await this.erasureImpact(tx, customer.id);
    if (!counts.canProceed) {
      const blocking = await this.obstacles(tx, customerIds);
      const list = (values: string[]) => (values.length > 10 ? `${values.slice(0, 10).join(', ')} and ${values.length - 10} more` : values.join(', '));
      const reasons = [
        blocking.requests.length ? `${blocking.requests.length} service request(s) are still open (${list(blocking.requests.map((r) => r.requestNo))})` : null,
        blocking.invoices.length ? `${blocking.invoices.length} invoice(s) are unpaid (${list(blocking.invoices.map((i) => i.invoiceNo))})` : null,
      ].filter(Boolean);
      return {
        blocked: `The data cannot be deleted yet: ${reasons.join(' and ')}. Close or cancel the requests and settle or void the invoices, then complete this request again.`,
        retained: null,
        counts: { ...counts, blocking },
        userIds: [],
      };
    }

    const { subject, memberships } = await this.subjectOf(tx, dsr, customerIds);
    // Which login accounts are used for something else and therefore stay (read only; the change happens after the commit).
    const logins = await this.system.loginOutlook(subject.userIds, memberships.map((m) => m.id));

    // ---- trails first: after the steps below nobody knows any more which values to look for
    const trails = await this.system.redactTrails(subject);

    // ---- every module's own data
    const steps: Record<string, ErasureReport> = await this.registry.run(tx, subject);

    // ---- portal access for this centre ends: the memberships that linked a login to the person are removed
    for (const m of memberships) {
      if (m.kind === 'CUSTOMER') {
        await tx.membershipBranch.deleteMany({ where: { tenantId, membershipId: m.id } });
        await tx.tenantMembership.delete({ where: { id: m.id } });
      } else {
        await tx.tenantMembership.update({ where: { id: m.id }, data: { status: 'REMOVED', customerId: null, corporateEmployeeId: null } });
      }
    }

    const deletedDocuments = steps.documents?.deletedDocuments ?? 0;
    const keptDocuments = steps.documents?.keptDocuments ?? 0;
    const kept = [
      counts.invoices || counts.payments
        ? `${counts.invoices} issued invoice(s) and ${counts.payments} payment record(s) are kept unchanged because financial records are immutable; they remain linked to the anonymised customer record`
        : null,
      counts.closedRequests ? `${counts.closedRequests} closed service request(s) are kept as business records, without the submitted form data, instructions, comments and messages` : null,
      keptDocuments ? `${keptDocuments} document(s) are kept because they are under legal hold, a fixed retention date or used by another open request` : null,
      logins.keep.length ? 'the login account itself is kept because it is also used for another centre or another role; only the access to this centre was removed' : null,
    ].filter(Boolean);
    await this.audit.log(
      {
        action: 'privacy.customer_anonymised',
        resourceType: 'Customer',
        resourceId: customer.id,
        summary: `Erasure request ${dsr.id}`,
        // Numbers only: nothing in this entry says who the person was.
        after: { deletedDocuments, keptDocuments, invoices: counts.invoices, payments: counts.payments, closedRequests: counts.closedRequests, records: customerIds.length, loginsToAnonymise: logins.anonymise.length, loginsKept: logins.keep.length, steps, trails },
      },
      tx,
    );
    return { blocked: null, retained: kept.length ? `Retained: ${kept.join('; ')}.` : null, counts: { ...counts, deletedDocuments, keptDocuments }, userIds: subject.userIds };
  }

  /**
   * After the erasure committed. The logins are closed right away; the same work (and the removal of the
   * files of the deleted documents) is queued as a job, which is also the retry if this call fails half-way.
   */
  private async afterErasure(privacyRequestId: string, userIds: string[]): Promise<void> {
    const tenantId = this.db.tenantId;
    try {
      await this.system.closeLogins(tenantId, userIds, privacyRequestId);
    } catch (e: any) {
      this.logger.error(`erasure ${privacyRequestId}: closing the login accounts failed and will be retried by ${ERASURE_FINALISE_JOB}: ${e?.message ?? e}`);
    }
    await this.jobs.enqueue(ERASURE_FINALISE_JOB, { tenantId, privacyRequestId, userIds }, { jobId: `erasure-${privacyRequestId}` });
  }

  // ------------------------------------------------------------------ overview numbers
  async counts(tx: Tx) {
    const tenantId = this.db.tenantId;
    const now = new Date();
    const [open, overdue, byType, completedLast90Days] = await Promise.all([
      tx.dataSubjectRequest.count({ where: { tenantId, status: { in: [...OPEN_STATUSES] } } }),
      tx.dataSubjectRequest.count({ where: { tenantId, status: { in: [...OPEN_STATUSES] }, dueAt: { lt: now } } }),
      tx.dataSubjectRequest.groupBy({ by: ['type'], where: { tenantId, status: { in: [...OPEN_STATUSES] } }, _count: { _all: true } }),
      tx.dataSubjectRequest.count({ where: { tenantId, status: 'COMPLETED', completedAt: { gte: new Date(now.getTime() - 90 * 86400_000) } } }),
    ]);
    return { open, overdue, openByType: Object.fromEntries(byType.map((g) => [g.type, g._count._all])), completedLast90Days };
  }
}
