import { Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@typease/database';
import { OPEN_STATUSES } from '@typease/types';
import type { CustomerInput, CustomerListQuery, UpdateCustomerInput } from '@typease/validation';
import { normalisePhoneSearch } from '@typease/validation';
import type { PageQueryInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { can, ctx } from '../../common/context';
import { blindIndex, decryptText } from '../../common/crypto';
import { customerErasedError, customerRef, ERASED_CUSTOMER_STATUS, isErasedCustomer } from '../../common/customer-ref';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { DomainEvents } from '../../common/events.service';
import { Errors, found } from '../../common/errors';
import { pageArgs, pageResult, sum } from '../../common/pagination';
import { SequenceService } from '../../common/sequence.service';
import { ConsentsService } from './consents.service';
import {
  CUSTOMER_COLUMNS, CustomerRow, customerListItem, customerView, dateOnly, DEFAULT_COMMUNICATION_PREFS, identityColumns, parseDateOnly, searchConditions,
} from './customer-view';
import { DuplicateCandidate, DuplicatesService } from './duplicates.service';

const CUSTOMER_SORT = ['createdAt', 'fullName', 'customerNo', 'lastActivityAt'] as const;
const ACTIVITY_SORT = ['createdAt'] as const;
/** Events of other modules that count as "the customer did something / something happened for them". */
const ACTIVITY_EVENTS = ['request.created', 'request.submitted', 'request.completed', 'document.uploaded', 'quotation.approved', 'payment.completed', 'appointment.created', 'ticket.created'] as const;
/** Changing one of these can turn a record into a duplicate of another. */
const IDENTIFYING = ['emiratesId', 'passportNo', 'phone', 'email'] as const;

export type CustomerSource = 'STAFF' | 'CORPORATE' | 'IMPORT';
export interface CreateOptions {
  source?: CustomerSource;
  /** Skip the duplicate gate (used where the caller has its own matching rule, e.g. corporate employees). */
  allowDuplicates?: boolean;
  /** Do not record the service-processing basis for people who were not present themselves. */
  recordConsents?: boolean;
}

export const versionConflict = () =>
  Errors.conflict('VERSION_CONFLICT', 'Someone else changed this customer while you were editing. Reload the record and apply your changes again.');

@Injectable()
export class CustomersService implements OnModuleInit {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly sequences: SequenceService,
    private readonly events: DomainEvents,
    private readonly duplicates: DuplicatesService,
    private readonly consents: ConsentsService,
  ) {}

  onModuleInit() {
    // "Last activity" is fed by what happens in other modules; they never write to customers themselves.
    this.events.subscribe('customers.last-activity', [...ACTIVITY_EVENTS], async (event) => {
      const customerId = (event.payload as { customerId?: string | null }).customerId;
      if (!customerId || !event.tenantId) return;
      await this.db.tx((tx) => this.touchActivity(tx, customerId, event.createdAt));
    });
  }

  /** Moves lastActivityAt forward (never backwards). Not a profile change: version and updatedAt stay as they are. */
  async touchActivity(tx: Tx, customerId: string, at: Date = new Date()): Promise<void> {
    await tx.$executeRaw`
      UPDATE "customers" SET "lastActivityAt" = GREATEST(COALESCE("lastActivityAt", ${at}::timestamptz), ${at}::timestamptz)
      WHERE "id" = ${customerId}::uuid AND "tenantId" = ${this.db.tenantId}::uuid`;
  }

  // ------------------------------------------------------------------ lookups
  /**
   * A customer of this centre (any status), or 404. A record whose personal data was erased is found as
   * well - as the stub that is left of it (status ANONYMISED, placeholder name, no personal field): staff
   * reach it from the invoices, payments and requests that still point at it. Nothing can be changed on it
   * (`assertEditable` answers 409 CUSTOMER_ERASED).
   */
  async require(tx: Tx, id: string): Promise<CustomerRow> {
    return found(await tx.customer.findFirst({ where: { id, tenantId: this.db.tenantId, OR: [{ deletedAt: null }, { status: ERASED_CUSTOMER_STATUS }] }, select: CUSTOMER_COLUMNS }), 'Customer') as CustomerRow;
  }
  /** For the person's own portal routes: an erased record does not exist any more. */
  async requireOwn(tx: Tx, id: string): Promise<CustomerRow> {
    return found(await tx.customer.findFirst({ where: { id, tenantId: this.db.tenantId, deletedAt: null }, select: CUSTOMER_COLUMNS }), 'Customer') as CustomerRow;
  }
  /** Same, but the record must still be editable. */
  async requireActive(tx: Tx, id: string): Promise<CustomerRow> {
    const customer = await this.require(tx, id);
    assertEditable(customer);
    return customer;
  }

  private async portalAccess(tx: Tx, customerIds: string[]) {
    const out = new Map<string, { status: 'ACTIVE' | 'INVITED' | 'SUSPENDED'; membershipId: string; email: string | null; lastLoginAt: Date | null }>();
    if (!customerIds.length) return out;
    const rows = await tx.tenantMembership.findMany({
      where: { tenantId: this.db.tenantId, customerId: { in: customerIds }, status: { in: ['ACTIVE', 'INVITED', 'SUSPENDED'] } },
      select: { id: true, customerId: true, status: true, kind: true, user: { select: { email: true, lastLoginAt: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const rank = { ACTIVE: 3, INVITED: 2, SUSPENDED: 1 } as const;
    for (const m of rows) {
      const status = m.status as 'ACTIVE' | 'INVITED' | 'SUSPENDED';
      const current = out.get(m.customerId!);
      if (!current || rank[status] > rank[current.status]) out.set(m.customerId!, { status, membershipId: m.id, email: m.user.email, lastLoginAt: m.user.lastLoginAt });
    }
    return out;
  }

  // ------------------------------------------------------------------ list + search
  list(query: CustomerListQuery) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const and: Array<Record<string, unknown>> = [];
      if (query.q) and.push({ OR: searchConditions(tenantId, query.q) });
      if (query.phone) {
        // Exact match on the normalised number. Text that cannot be a phone number matches nothing.
        const phone = normalisePhoneSearch(query.phone);
        and.push(phone ? { phone } : { id: { in: [] } });
      }
      if (query.email) and.push({ email: query.email });
      if (query.emiratesId) and.push({ emiratesIdHash: blindIndex(tenantId, 'emiratesId', query.emiratesId) });
      if (query.passportNo) and.push({ passportNoHash: blindIndex(tenantId, 'passport', query.passportNo) });
      if (query.requestNo) and.push({ serviceRequests: { some: { requestNo: query.requestNo.toUpperCase(), deletedAt: null } } });
      if (query.tagId) and.push({ customerTagAssignments: { some: { tagId: query.tagId } } });
      if (query.hasAccount !== undefined) {
        const linked = { status: { in: ['ACTIVE', 'INVITED'] as Array<'ACTIVE' | 'INVITED'> } };
        and.push({ tenantMemberships: query.hasAccount ? { some: linked } : { none: linked } });
      }
      const where = {
        tenantId,
        // Erased records are stubs: they appear only when somebody asks for exactly them (status=ANONYMISED),
        // never in the default list, in a search, in a picker or under "ALL".
        ...(query.status === ERASED_CUSTOMER_STATUS
          ? { status: ERASED_CUSTOMER_STATUS }
          : { deletedAt: null, ...(query.status === 'ALL' ? { status: { not: ERASED_CUSTOMER_STATUS } } : { status: query.status ?? ('ACTIVE' as const) }) }),
        ...(query.type ? { type: query.type } : {}),
        ...(query.corporateAccountId ? { corporateAccountId: query.corporateAccountId } : {}),
        ...(and.length ? { AND: and } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.customer.findMany({
          where,
          select: { ...CUSTOMER_COLUMNS, customerTagAssignments: { select: { tag: { select: { id: true, name: true, color: true } } } } },
          ...pageArgs(query, CUSTOMER_SORT, 'createdAt:desc'),
        }),
        tx.customer.count({ where }),
      ]);
      const access = await this.portalAccess(tx, rows.map((r) => r.id));
      const data = rows.map(({ customerTagAssignments, ...row }) => ({
        ...customerListItem(row as CustomerRow),
        tags: customerTagAssignments.map((a) => a.tag),
        portalAccess: access.get(row.id)?.status ?? ('NONE' as const),
      }));
      return pageResult(data, total, query);
    });
  }

  // ------------------------------------------------------------------ detail overview
  get(id: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const customer = await this.require(tx, id);
      const mergedRows = await tx.customer.findMany({ where: { tenantId, mergedIntoId: id }, select: { id: true, customerNo: true, fullName: true, status: true } });
      const mergedFrom = mergedRows.map((m) => customerRef(m));
      const erasedAt = isErasedCustomer(customer) ? ((await tx.customer.findFirst({ where: { id, tenantId }, select: { deletedAt: true } }))?.deletedAt ?? null) : null;
      // Issued invoices of a merged-away record stay on that record (they are immutable), so money questions look at both.
      const financeIds = [id, ...mergedFrom.map((m) => m.id)];
      const now = new Date();
      const [tags, pinnedNotes, contacts, corporateAccount, mergedInto, access, openRequests, totalRequests, documents, unpaid, upcomingAppointments, openTickets] = await Promise.all([
        tx.customerTagAssignment.findMany({ where: { tenantId, customerId: id }, select: { tag: { select: { id: true, name: true, color: true } } }, orderBy: { tag: { name: 'asc' } } }),
        tx.customerNote.findMany({ where: { tenantId, customerId: id, isPinned: true }, orderBy: { createdAt: 'desc' }, take: 20 }),
        tx.customerContact.findMany({ where: { tenantId, customerId: id }, orderBy: [{ type: 'asc' }, { isPrimary: 'desc' }, { createdAt: 'asc' }] }),
        customer.corporateAccountId ? tx.corporateAccount.findFirst({ where: { id: customer.corporateAccountId, tenantId }, select: { id: true, accountNo: true, companyName: true, status: true } }) : null,
        customer.mergedIntoId ? tx.customer.findFirst({ where: { id: customer.mergedIntoId, tenantId }, select: { id: true, customerNo: true, fullName: true, status: true } }) : null,
        this.portalAccess(tx, [id]),
        tx.serviceRequest.count({ where: { tenantId, customerId: id, deletedAt: null, status: { in: OPEN_STATUSES } } }),
        tx.serviceRequest.count({ where: { tenantId, customerId: id, deletedAt: null } }),
        tx.document.count({ where: { tenantId, customerId: id, deletedAt: null, status: { not: 'DELETED' } } }),
        tx.invoice.findMany({ where: { tenantId, customerId: { in: financeIds }, status: { in: ['ISSUED', 'PARTIALLY_PAID'] } }, select: { balanceDue: true, currency: true } }),
        tx.appointment.count({ where: { tenantId, customerId: id, startsAt: { gte: now }, status: { in: ['BOOKED', 'CONFIRMED'] } } }),
        tx.supportTicket.count({ where: { tenantId, customerId: id, scope: 'CUSTOMER', status: { notIn: ['RESOLVED', 'CLOSED'] } } }),
      ]);
      const authors = await this.authorNames(tx, pinnedNotes.map((n) => n.authorId));
      const portal = access.get(id);
      return {
        ...customerView(customer),
        /** When the personal data was erased (null for every other record). */
        erasedAt,
        corporateAccount,
        mergedInto: customerRef(mergedInto),
        mergedFrom,
        tags: tags.map((t) => t.tag),
        pinnedNotes: pinnedNotes.map((n) => ({ ...n, authorName: authors.get(n.authorId) ?? null })),
        contacts,
        portalAccess: portal ? { status: portal.status, email: portal.email, lastLoginAt: portal.lastLoginAt } : { status: 'NONE' as const, email: null, lastLoginAt: null },
        counters: {
          openRequests,
          totalRequests,
          documents,
          unpaidInvoices: unpaid.length,
          unpaidInvoicesBalance: sum(unpaid.map((i) => i.balanceDue)).toFixed(2),
          currency: unpaid[0]?.currency ?? null,
          upcomingAppointments,
          openTickets,
        },
        lastActivityAt: customer.lastActivityAt,
      };
    });
  }

  async authorNames(tx: Tx, userIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(userIds)];
    if (!ids.length) return new Map();
    const users = await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } });
    return new Map(users.map((u) => [u.id, u.fullName]));
  }

  // ------------------------------------------------------------------ create
  private async assertCorporateAccount(tx: Tx, corporateAccountId: string) {
    const account = found(await tx.corporateAccount.findFirst({ where: { id: corporateAccountId, tenantId: this.db.tenantId, deletedAt: null }, select: { id: true, status: true } }), 'Corporate account');
    if (account.status === 'ARCHIVED') throw Errors.unprocessable('CORPORATE_ACCOUNT_ARCHIVED', 'That corporate account is archived.');
  }
  private async assertTags(tx: Tx, tagIds: string[]) {
    if (!tagIds.length) return;
    const n = await tx.customerTag.count({ where: { tenantId: this.db.tenantId, id: { in: tagIds } } });
    if (n !== new Set(tagIds).size) throw Errors.notFound('Tag');
  }
  private duplicateError(candidates: DuplicateCandidate[]) {
    const strong = candidates.filter((c) => c.strength === 'STRONG');
    return Errors.conflict(
      'POSSIBLE_DUPLICATE',
      `${strong.length === 1 ? 'A customer' : `${strong.length} customers`} with the same Emirates ID, passport, phone or email already exist${strong.length === 1 ? 's' : ''}. Open the existing record, or confirm that this is a different person to continue.`,
      { candidates },
    );
  }

  /**
   * Registers a customer. Joins the caller's transaction, so other parts of
   * this workstream (corporate employees) create customers through here.
   */
  create(input: CustomerInput, opts: CreateOptions = {}) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const c = ctx();
      const { tagIds = [], confirmNotDuplicate, emiratesId, passportNo, communicationPrefs, dateOfBirth, emiratesIdExpiry, passportExpiry, address, ...fields } = input;

      let reviewed: DuplicateCandidate[] = [];
      if (!opts.allowDuplicates) {
        await this.duplicates.lock(tx, { emiratesId, passportNo, phone: fields.phone, email: fields.email });
        const candidates = await this.duplicates.find(tx, { fullName: fields.fullName, email: fields.email, phone: fields.phone, emiratesId, passportNo });
        reviewed = candidates.filter((d) => d.strength === 'STRONG');
        // Only strong signals stop the registration. A matching name alone never does.
        if (reviewed.length && !confirmNotDuplicate) throw this.duplicateError(candidates);
      }
      if (fields.corporateAccountId) await this.assertCorporateAccount(tx, fields.corporateAccountId);
      await this.assertTags(tx, tagIds);

      const prefs = { ...DEFAULT_COMMUNICATION_PREFS, ...(communicationPrefs ?? {}) };
      const customer = (await tx.customer.create({
        data: {
          tenantId,
          customerNo: await this.sequences.next(tx, 'customer'),
          type: fields.type,
          fullName: fields.fullName,
          fullNameAr: fields.fullNameAr ?? null,
          preferredLanguage: fields.preferredLanguage,
          email: fields.email ?? null,
          phone: fields.phone ?? null,
          nationality: fields.nationality ?? null,
          dateOfBirth: parseDateOnly(dateOfBirth),
          ...(address ? { address: address as Prisma.InputJsonValue } : {}),
          taxRegistrationNo: fields.taxRegistrationNo ?? null,
          ...identityColumns(tenantId, { emiratesId: emiratesId ?? null, passportNo: passportNo ?? null }),
          emiratesIdExpiry: parseDateOnly(emiratesIdExpiry),
          passportCountry: fields.passportCountry ?? null,
          passportExpiry: parseDateOnly(passportExpiry),
          corporateAccountId: fields.corporateAccountId ?? null,
          communicationPrefs: prefs,
          marketingOptIn: fields.marketingOptIn ?? false,
          lastActivityAt: new Date(),
          createdById: c.userId ?? null,
        },
        select: CUSTOMER_COLUMNS,
      })) as CustomerRow;
      if (tagIds.length) await tx.customerTagAssignment.createMany({ data: [...new Set(tagIds)].map((tagId) => ({ tenantId, customerId: customer.id, tagId })) });

      if (opts.recordConsents !== false) {
        // The person is at the counter asking for a service: staff record the basis for handling it, and any opt-ins.
        await this.consents.apply(tx, customer.id, { purpose: 'SERVICE_PROCESSING', granted: true, capturedVia: 'STAFF_RECORDED' }, { mirror: false });
        if (customer.marketingOptIn) await this.consents.apply(tx, customer.id, { purpose: 'MARKETING', granted: true, capturedVia: 'STAFF_RECORDED' }, { mirror: false });
        if (prefs.whatsapp) await this.consents.apply(tx, customer.id, { purpose: 'WHATSAPP', granted: true, capturedVia: 'STAFF_RECORDED' }, { mirror: false });
      }

      const source = opts.source ?? 'STAFF';
      await this.audit.log(
        {
          action: 'customer.created',
          resourceType: 'Customer',
          resourceId: customer.id,
          summary: `${customer.customerNo} ${customer.fullName}`,
          after: { ...auditProfile(customer), source, tagIds, ...(reviewed.length ? { confirmedNotDuplicateOf: reviewed.map((d) => d.customer.customerNo) } : {}) },
        },
        tx,
      );
      await this.events.emit(tx, 'customer.created', { customerId: customer.id, source });
      return customerView(customer);
    });
  }

  // ------------------------------------------------------------------ update
  update(id: string, input: UpdateCustomerInput, opts: Pick<CreateOptions, 'allowDuplicates'> = {}) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const before = await this.requireActive(tx, id);
      const { version, tagIds, confirmNotDuplicate, emiratesId, passportNo, communicationPrefs, dateOfBirth, emiratesIdExpiry, passportExpiry, address, marketingOptIn, ...fields } = input;
      if (version !== undefined && version !== before.version) throw versionConflict();

      // Did this edit touch something that identifies a person? Then it may have created a duplicate.
      const changedIdentifiers = IDENTIFYING.filter((k) => input[k] !== undefined && input[k] !== null && (k === 'emiratesId' || k === 'passportNo' || input[k] !== before[k as 'phone' | 'email']));
      let reviewed: DuplicateCandidate[] = [];
      if (changedIdentifiers.length && !opts.allowDuplicates) {
        const probe = { emiratesId: emiratesId ?? undefined, passportNo: passportNo ?? undefined, phone: changedIdentifiers.includes('phone') ? fields.phone : undefined, email: changedIdentifiers.includes('email') ? fields.email : undefined };
        await this.duplicates.lock(tx, probe);
        const candidates = await this.duplicates.find(tx, { ...probe, excludeId: id });
        reviewed = candidates.filter((d) => d.strength === 'STRONG');
        if (reviewed.length && !confirmNotDuplicate) throw this.duplicateError(candidates);
      }
      if (fields.corporateAccountId && fields.corporateAccountId !== before.corporateAccountId) await this.assertCorporateAccount(tx, fields.corporateAccountId);
      if (tagIds) await this.assertTags(tx, tagIds);

      const data: Record<string, unknown> = { ...fields, ...identityColumns(tenantId, { emiratesId, passportNo }) };
      if (dateOfBirth !== undefined) data.dateOfBirth = parseDateOnly(dateOfBirth);
      if (emiratesIdExpiry !== undefined) data.emiratesIdExpiry = parseDateOnly(emiratesIdExpiry);
      if (passportExpiry !== undefined) data.passportExpiry = parseDateOnly(passportExpiry);
      if (address !== undefined) data.address = address === null ? Prisma.DbNull : address;
      const prefsBefore = { ...DEFAULT_COMMUNICATION_PREFS, ...((before.communicationPrefs as object) ?? {}) };
      const prefsAfter = communicationPrefs ? { ...prefsBefore, ...communicationPrefs } : prefsBefore;
      if (communicationPrefs) data.communicationPrefs = prefsAfter;
      if (marketingOptIn !== undefined) data.marketingOptIn = marketingOptIn;

      const changed = await tx.customer.updateMany({ where: { id, tenantId, version: before.version, status: 'ACTIVE' }, data: { ...data, version: { increment: 1 }, lastActivityAt: new Date() } });
      if (changed.count !== 1) throw versionConflict();
      if (tagIds) {
        const next = [...new Set(tagIds)];
        await tx.customerTagAssignment.deleteMany({ where: { tenantId, customerId: id, tagId: { notIn: next } } });
        const existing = new Set((await tx.customerTagAssignment.findMany({ where: { tenantId, customerId: id }, select: { tagId: true } })).map((a) => a.tagId));
        const add = next.filter((t) => !existing.has(t));
        if (add.length) await tx.customerTagAssignment.createMany({ data: add.map((tagId) => ({ tenantId, customerId: id, tagId })) });
      }
      // Opt-ins changed through the profile are consent decisions and are recorded as such.
      if (marketingOptIn !== undefined && marketingOptIn !== before.marketingOptIn) {
        await this.consents.apply(tx, id, { purpose: 'MARKETING', granted: marketingOptIn, capturedVia: 'STAFF_RECORDED' }, { mirror: false });
      }
      if (prefsAfter.whatsapp !== prefsBefore.whatsapp) await this.consents.apply(tx, id, { purpose: 'WHATSAPP', granted: prefsAfter.whatsapp, capturedVia: 'STAFF_RECORDED' }, { mirror: false });

      const after = await this.require(tx, id);
      const keys = Object.keys(input).filter((k) => !['version', 'confirmNotDuplicate'].includes(k));
      await this.audit.log(
        {
          action: 'customer.updated',
          resourceType: 'Customer',
          resourceId: id,
          summary: `${before.customerNo}: ${keys.join(', ')}`,
          before: pickAudit(before, keys),
          after: { ...pickAudit(after, keys), ...(tagIds ? { tagIds } : {}), ...(reviewed.length ? { confirmedNotDuplicateOf: reviewed.map((d) => d.customer.customerNo) } : {}) },
        },
        tx,
      );
      return customerView(after);
    });
  }

  // ------------------------------------------------------------------ sensitive identity numbers
  /** Full identity numbers. Every call is written to the audit trail, whoever makes it. */
  revealIdentity(id: string) {
    return this.db.tx(async (tx) => {
      const row = found(
        await tx.customer.findFirst({
          where: { id, tenantId: this.db.tenantId, OR: [{ deletedAt: null }, { status: ERASED_CUSTOMER_STATUS }] },
          select: { id: true, customerNo: true, status: true, emiratesIdEnc: true, emiratesIdExpiry: true, passportNoEnc: true, passportCountry: true, passportExpiry: true },
        }),
        'Customer',
      );
      // Nothing is left to reveal, and the audit trail should not suggest that somebody looked at identity numbers.
      if (isErasedCustomer(row)) throw customerErasedError();
      const fields = [row.emiratesIdEnc ? 'emiratesId' : null, row.passportNoEnc ? 'passportNo' : null].filter(Boolean);
      await this.audit.log({ action: 'customer.identity_revealed', resourceType: 'Customer', resourceId: id, summary: `${row.customerNo}: full identity numbers viewed`, after: { fields } }, tx);
      return {
        customerId: row.id,
        customerNo: row.customerNo,
        emiratesId: row.emiratesIdEnc ? decryptText(row.emiratesIdEnc) : null,
        emiratesIdExpiry: dateOnly(row.emiratesIdExpiry),
        passportNo: row.passportNoEnc ? decryptText(row.passportNoEnc) : null,
        passportCountry: row.passportCountry,
        passportExpiry: dateOnly(row.passportExpiry),
      };
    });
  }

  // ------------------------------------------------------------------ archive / restore
  archive(id: string, reason?: string | null) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const customer = await this.require(tx, id);
      if (customer.status === 'ARCHIVED') throw Errors.conflict('ALREADY_ARCHIVED', 'This customer is already archived.');
      assertEditable(customer);
      const open = await tx.serviceRequest.count({ where: { tenantId, customerId: id, deletedAt: null, status: { in: OPEN_STATUSES } } });
      if (open) throw Errors.conflict('CUSTOMER_HAS_OPEN_REQUESTS', `This customer still has ${open} open request(s). Complete or cancel them before archiving.`);
      await tx.customer.update({ where: { id }, data: { status: 'ARCHIVED', version: { increment: 1 } } });
      await this.audit.log({ action: 'customer.archived', resourceType: 'Customer', resourceId: id, summary: `${customer.customerNo} archived`, before: { status: customer.status }, after: { status: 'ARCHIVED', reason: reason ?? null } }, tx);
      return customerView(await this.require(tx, id));
    });
  }

  restore(id: string) {
    return this.db.tx(async (tx) => {
      const customer = await this.require(tx, id);
      if (isErasedCustomer(customer)) throw customerErasedError();
      if (customer.status !== 'ARCHIVED') {
        throw Errors.conflict('NOT_ARCHIVED', customer.status === 'ACTIVE' ? 'This customer is not archived.' : 'A merged or anonymised record cannot be restored.');
      }
      await tx.customer.update({ where: { id }, data: { status: 'ACTIVE', version: { increment: 1 } } });
      await this.audit.log({ action: 'customer.restored', resourceType: 'Customer', resourceId: id, summary: `${customer.customerNo} restored`, before: { status: 'ARCHIVED' }, after: { status: 'ACTIVE' } }, tx);
      return customerView(await this.require(tx, id));
    });
  }

  // ------------------------------------------------------------------ activity history
  /** The audit trail of one customer. Field-level before / after values need the audit permission. */
  activity(id: string, query: PageQueryInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      await this.require(tx, id);
      const mergedFrom = await tx.customer.findMany({ where: { tenantId, mergedIntoId: id }, select: { id: true } });
      const where = { tenantId, resourceType: 'Customer', resourceId: { in: [id, ...mergedFrom.map((m) => m.id)] } };
      const detailed = can('audit.read');
      const [rows, total] = await Promise.all([
        tx.auditLog.findMany({
          where,
          select: { id: true, action: true, summary: true, actorType: true, actorLabel: true, actorUserId: true, resourceId: true, createdAt: true, ...(detailed ? { before: true, after: true } : {}) },
          ...pageArgs(query, ACTIVITY_SORT, 'createdAt:desc'),
        }),
        tx.auditLog.count({ where }),
      ]);
      return pageResult(rows, total, query);
    });
  }
}

export function assertEditable(customer: { status: string }) {
  if (isErasedCustomer(customer)) throw customerErasedError();
  if (customer.status === 'MERGED') throw Errors.conflict('CUSTOMER_MERGED', 'This record was merged into another customer and can no longer be changed.');
  if (customer.status === 'ARCHIVED') throw Errors.conflict('CUSTOMER_ARCHIVED', 'This customer is archived. Restore the record before changing it.');
}

/** Profile fields for the audit trail. Identity numbers appear only as "ends in 1234". */
export function auditProfile(c: CustomerRow) {
  return {
    customerNo: c.customerNo,
    type: c.type,
    status: c.status,
    fullName: c.fullName,
    fullNameAr: c.fullNameAr,
    preferredLanguage: c.preferredLanguage,
    email: c.email,
    phone: c.phone,
    nationality: c.nationality,
    dateOfBirth: dateOnly(c.dateOfBirth),
    address: c.address ?? null,
    taxRegistrationNo: c.taxRegistrationNo,
    emiratesId: c.emiratesIdLast4 ? `ends in ${c.emiratesIdLast4}` : null,
    emiratesIdExpiry: dateOnly(c.emiratesIdExpiry),
    passportNo: c.passportNoLast4 ? `ends in ${c.passportNoLast4}` : null,
    passportCountry: c.passportCountry,
    passportExpiry: dateOnly(c.passportExpiry),
    corporateAccountId: c.corporateAccountId,
    communicationPrefs: c.communicationPrefs,
    marketingOptIn: c.marketingOptIn,
  };
}
function pickAudit(c: CustomerRow, keys: string[]) {
  const profile = auditProfile(c) as Record<string, unknown>;
  return Object.fromEntries(keys.filter((k) => k in profile).map((k) => [k, profile[k]]));
}
