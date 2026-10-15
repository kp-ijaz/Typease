import { Injectable } from '@nestjs/common';
import type { MergeCustomersInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { DomainEvents } from '../../common/events.service';
import { Errors, found } from '../../common/errors';
import { CUSTOMER_COLUMNS, CustomerRow, customerView, DEFAULT_COMMUNICATION_PREFS } from './customer-view';

/** Columns copied from the retired record when the kept record has nothing there. */
const FILLABLE = ['fullNameAr', 'email', 'phone', 'nationality', 'dateOfBirth', 'address', 'corporateAccountId'] as const;
const MERGE_COLUMNS = { ...CUSTOMER_COLUMNS, emiratesIdEnc: true, emiratesIdHash: true, passportNoEnc: true, passportNoHash: true } as const;
type MergeRow = CustomerRow & { emiratesIdEnc: string | null; emiratesIdHash: string | null; passportNoEnc: string | null; passportNoHash: string | null };

/**
 * Merging two customer records. Never automatic: a person with the merge
 * permission names both records, types the number of the record that will be
 * retired and gives a reason. Everything happens in one transaction; if any
 * step fails nothing has moved.
 */
@Injectable()
export class MergeService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
  ) {}

  merge(input: MergeCustomersInput) {
    if (input.sourceId === input.targetId) throw Errors.unprocessable('MERGE_SAME_RECORD', 'A customer cannot be merged into itself. Choose two different records.');
    return this.db.tx(
      async (tx) => {
        const tenantId = this.db.tenantId;
        // Lock both rows in a fixed order so two merges that involve the same records cannot deadlock or interleave.
        await tx.$queryRaw`SELECT "id" FROM "customers" WHERE "tenantId" = ${tenantId}::uuid AND "id" IN (${input.sourceId}::uuid, ${input.targetId}::uuid) ORDER BY "id" FOR UPDATE`;
        // An erased record is found (staff can open its stub) and refused below with 409 CUSTOMER_ERASED.
        const load = async (id: string, what: string) => found(await tx.customer.findFirst({ where: { id, tenantId, OR: [{ deletedAt: null }, { status: 'ANONYMISED' }] }, select: MERGE_COLUMNS }), what) as MergeRow;
        const source = await load(input.sourceId, 'Source customer');
        const target = await load(input.targetId, 'Target customer');

        for (const [record, role] of [[source, 'source'], [target, 'target']] as const) {
          if (record.status === 'MERGED') throw Errors.conflict('ALREADY_MERGED', `${record.customerNo} has already been merged into another record and cannot be used as the ${role} of a merge.`);
          if (record.status === 'ANONYMISED') throw Errors.conflict('CUSTOMER_ERASED', `The personal data of ${record.customerNo} was erased: the record cannot be the ${role} of a merge.`);
        }
        if (target.status !== 'ACTIVE') throw Errors.conflict('CUSTOMER_ARCHIVED', `${target.customerNo} is archived. Restore it before merging another record into it.`);
        if (input.confirmSourceCustomerNo.trim().toUpperCase() !== source.customerNo.toUpperCase()) {
          throw Errors.unprocessable('MERGE_CONFIRMATION_MISMATCH', `To confirm, type the number of the record that will be retired (${source.customerNo}).`);
        }

        // Two different people's logins must never end up on one record.
        const logins = await tx.tenantMembership.findMany({ where: { tenantId, customerId: { in: [source.id, target.id] }, status: { not: 'REMOVED' } }, select: { id: true, customerId: true, userId: true } });
        const sourceUsers = new Set(logins.filter((m) => m.customerId === source.id).map((m) => m.userId));
        const targetUsers = new Set(logins.filter((m) => m.customerId === target.id).map((m) => m.userId));
        if (sourceUsers.size && targetUsers.size && [...sourceUsers].some((u) => !targetUsers.has(u))) {
          throw Errors.conflict('MERGE_BOTH_HAVE_LOGINS', 'Both records are linked to different portal logins. Remove the portal access of the record that will be retired first, then merge.');
        }

        const moved = await this.moveEverything(tx, source, target);
        const retainedOnSource = {
          invoices: await tx.invoice.count({ where: { tenantId, customerId: source.id } }),
          payments: await tx.payment.count({ where: { tenantId, customerId: source.id } }),
        };
        const filledFields = await this.fillEmptyFields(tx, source, target);

        // Records merged into the source earlier now point at the surviving record.
        await tx.customer.updateMany({ where: { tenantId, mergedIntoId: source.id }, data: { mergedIntoId: target.id } });
        await tx.customer.update({ where: { id: source.id }, data: { status: 'MERGED', mergedIntoId: target.id, version: { increment: 1 } } });
        const latest = [source.lastActivityAt, target.lastActivityAt, new Date()].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0];
        await tx.customer.update({ where: { id: target.id }, data: { lastActivityAt: latest, version: { increment: 1 } } });

        const detail = { sourceId: source.id, sourceCustomerNo: source.customerNo, targetId: target.id, targetCustomerNo: target.customerNo, reason: input.reason, moved, retainedOnSource, filledFields };
        await this.audit.log(
          { action: 'customer.merged', resourceType: 'Customer', resourceId: target.id, summary: `${source.customerNo} merged into ${target.customerNo}: ${input.reason}`, before: { sourceStatus: source.status, sourceName: source.fullName, targetName: target.fullName }, after: detail },
          tx,
        );
        await this.audit.log(
          { action: 'customer.merged_into', resourceType: 'Customer', resourceId: source.id, summary: `${source.customerNo} retired: merged into ${target.customerNo}`, before: { status: source.status }, after: { status: 'MERGED', mergedIntoId: target.id, reason: input.reason } },
          tx,
        );
        await this.events.emit(tx, 'customer.merged', { sourceId: source.id, targetId: target.id, sourceCustomerNo: source.customerNo, targetCustomerNo: target.customerNo });

        const kept = (await tx.customer.findFirstOrThrow({ where: { id: target.id, tenantId }, select: CUSTOMER_COLUMNS })) as CustomerRow;
        return { target: customerView(kept), source: { id: source.id, customerNo: source.customerNo, status: 'MERGED' as const, mergedIntoId: target.id }, moved, retainedOnSource, filledFields };
      },
      { timeoutMs: 60_000 },
    );
  }

  /** Re-points every row that hangs off the source. Returns how many rows moved per table. */
  private async moveEverything(tx: Tx, source: MergeRow, target: MergeRow) {
    const tenantId = this.db.tenantId;
    const from = { tenantId, customerId: source.id };
    const to = { customerId: target.id };
    const n = (r: { count: number }) => r.count;

    const moved: Record<string, number> = {
      serviceRequests: n(await tx.serviceRequest.updateMany({ where: from, data: to })),
      documents: n(await tx.document.updateMany({ where: from, data: to })),
      quotations: n(await tx.quotation.updateMany({ where: from, data: to })),
      // Issued invoices and completed payments are immutable records (the database refuses to change their
      // customer). Only drafts and unfinished payments move; the rest stays on the retired record and is
      // reported as `retainedOnSource`.
      invoices: n(await tx.invoice.updateMany({ where: { ...from, status: 'DRAFT' }, data: to })),
      payments: n(await tx.payment.updateMany({ where: { ...from, status: { in: ['PENDING', 'FAILED', 'CANCELLED'] } }, data: to })),
      appointments: n(await tx.appointment.updateMany({ where: from, data: to })),
      queueTokens: n(await tx.queueToken.updateMany({ where: from, data: to })),
      reminderSchedules: n(await tx.reminderSchedule.updateMany({ where: from, data: to })),
      supportTickets: n(await tx.supportTicket.updateMany({ where: from, data: to })),
      customerFeedback: n(await tx.customerFeedback.updateMany({ where: from, data: to })),
      dataSubjectRequests: n(await tx.dataSubjectRequest.updateMany({ where: from, data: to })),
      tasks: n(await tx.task.updateMany({ where: from, data: to })),
      notifications: n(await tx.notification.updateMany({ where: { tenantId, recipientCustomerId: source.id }, data: { recipientCustomerId: target.id } })),
      notes: n(await tx.customerNote.updateMany({ where: from, data: to })),
    };

    // Contacts: drop exact duplicates, keep the target's primaries, and keep the source's main email / phone as extra contacts.
    const targetContacts = await tx.customerContact.findMany({ where: { tenantId, customerId: target.id } });
    const has = (type: string, value: string) => targetContacts.some((c) => c.type === type && c.value.toLowerCase() === value.toLowerCase());
    const primaryTypes = new Set(targetContacts.filter((c) => c.isPrimary).map((c) => c.type));
    moved.contacts = 0;
    for (const contact of await tx.customerContact.findMany({ where: from })) {
      if (has(contact.type, contact.value)) {
        await tx.customerContact.delete({ where: { id: contact.id } });
        continue;
      }
      const keepPrimary = contact.isPrimary && !primaryTypes.has(contact.type);
      await tx.customerContact.update({ where: { id: contact.id }, data: { customerId: target.id, isPrimary: keepPrimary } });
      if (keepPrimary) primaryTypes.add(contact.type);
      targetContacts.push({ ...contact, customerId: target.id });
      moved.contacts += 1;
    }
    const label = `From ${source.customerNo}`.slice(0, 40);
    if (source.email && target.email && source.email !== target.email && !has('EMAIL', source.email)) {
      await tx.customerContact.create({ data: { tenantId, customerId: target.id, type: 'EMAIL', value: source.email, label } });
      moved.contacts += 1;
    }
    if (source.phone && target.phone && source.phone !== target.phone && !has('PHONE', source.phone)) {
      await tx.customerContact.create({ data: { tenantId, customerId: target.id, type: 'PHONE', value: source.phone, label } });
      moved.contacts += 1;
    }

    // Tags: the pair (customer, tag) is unique.
    const targetTags = new Set((await tx.customerTagAssignment.findMany({ where: { tenantId, customerId: target.id }, select: { tagId: true } })).map((a) => a.tagId));
    await tx.customerTagAssignment.deleteMany({ where: { ...from, tagId: { in: [...targetTags] } } });
    moved.tagAssignments = n(await tx.customerTagAssignment.updateMany({ where: from, data: to }));

    // Employee records: the pair (company, customer) is unique.
    const targetEmployees = await tx.corporateEmployee.findMany({ where: { tenantId, customerId: target.id }, select: { id: true, corporateAccountId: true } });
    moved.corporateEmployees = 0;
    for (const employee of await tx.corporateEmployee.findMany({ where: from, select: { id: true, corporateAccountId: true } })) {
      const twin = targetEmployees.find((e) => e.corporateAccountId === employee.corporateAccountId);
      if (twin) {
        await tx.tenantMembership.updateMany({ where: { tenantId, corporateEmployeeId: employee.id }, data: { corporateEmployeeId: twin.id } });
        await tx.corporateEmployee.delete({ where: { id: employee.id } });
      } else {
        await tx.corporateEmployee.update({ where: { id: employee.id }, data: to });
        moved.corporateEmployees += 1;
      }
    }

    // Portal logins (the caller made sure they do not belong to two different people).
    moved.memberships = n(await tx.tenantMembership.updateMany({ where: from, data: to }));

    // Consents: one row per purpose. Where both records decided, the more recent decision stands.
    const targetConsents = await tx.customerConsent.findMany({ where: { tenantId, customerId: target.id } });
    moved.consents = 0;
    for (const consent of await tx.customerConsent.findMany({ where: from })) {
      const existing = targetConsents.find((t) => t.purpose === consent.purpose);
      if (!existing) {
        await tx.customerConsent.update({ where: { id: consent.id }, data: to });
        moved.consents += 1;
        continue;
      }
      if (consent.updatedAt > existing.updatedAt && consent.status !== existing.status) {
        await tx.customerConsent.update({ where: { id: existing.id }, data: { status: consent.status, lawfulBasis: consent.lawfulBasis, noticeVersion: consent.noticeVersion, grantedAt: consent.grantedAt, withdrawnAt: consent.withdrawnAt } });
        // The history table is append-only: the carried-over decision is added for the kept record.
        await tx.consentRecord.create({ data: { tenantId, customerId: target.id, purpose: consent.purpose, status: consent.status, lawfulBasis: consent.lawfulBasis, noticeVersion: consent.noticeVersion, capturedVia: 'STAFF_RECORDED' } });
        moved.consents += 1;
      }
      await tx.customerConsent.delete({ where: { id: consent.id } });
    }
    return moved;
  }

  /** Copies details the kept record lacks. Never overwrites what the kept record already has. */
  private async fillEmptyFields(tx: Tx, source: MergeRow, target: MergeRow): Promise<string[]> {
    const data: Record<string, unknown> = {};
    const filled: string[] = [];
    for (const key of FILLABLE) {
      if ((target[key] === null || target[key] === undefined) && source[key] !== null && source[key] !== undefined) {
        data[key] = source[key];
        filled.push(key);
      }
    }
    if (!target.emiratesIdEnc && source.emiratesIdEnc) {
      // The blind index is keyed per tenant, so the stored hash is valid for the kept record as it is.
      Object.assign(data, { emiratesIdEnc: source.emiratesIdEnc, emiratesIdHash: source.emiratesIdHash, emiratesIdLast4: source.emiratesIdLast4, emiratesIdExpiry: target.emiratesIdExpiry ?? source.emiratesIdExpiry });
      filled.push('emiratesId');
    }
    if (!target.passportNoEnc && source.passportNoEnc) {
      Object.assign(data, { passportNoEnc: source.passportNoEnc, passportNoHash: source.passportNoHash, passportNoLast4: source.passportNoLast4, passportCountry: target.passportCountry ?? source.passportCountry, passportExpiry: target.passportExpiry ?? source.passportExpiry });
      filled.push('passportNo');
    }
    // The mirrored opt-in columns follow the consent rows that now belong to the kept record.
    const consents = await tx.customerConsent.findMany({ where: { tenantId: this.db.tenantId, customerId: target.id, purpose: { in: ['MARKETING', 'WHATSAPP'] } } });
    const marketing = consents.find((c) => c.purpose === 'MARKETING');
    const whatsapp = consents.find((c) => c.purpose === 'WHATSAPP');
    if (marketing) data.marketingOptIn = marketing.status === 'GRANTED';
    if (whatsapp) data.communicationPrefs = { ...DEFAULT_COMMUNICATION_PREFS, ...((target.communicationPrefs as object) ?? {}), whatsapp: whatsapp.status === 'GRANTED' };
    if (Object.keys(data).length) await tx.customer.update({ where: { id: target.id }, data });
    return filled;
  }
}
