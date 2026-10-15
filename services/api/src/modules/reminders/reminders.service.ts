import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { CreateReminderInput, ReminderListQuery, UpdateReminderInput, MyRemindersQuery } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { can, ctx } from '../../common/context';
import { Prisma, TenantDb, Tx } from '../../common/db/prisma.service';
import { DomainEvent, DomainEvents } from '../../common/events.service';
import { Errors, found } from '../../common/errors';
import { assertCustomerNotErased, isErasedCustomer } from '../../common/customer-ref';
import { JobQueue } from '../../common/jobs/job-queue';
import { pageArgs, pageResult } from '../../common/pagination';
import { TenantDirectory } from '../../common/tenant-directory';
import { NotificationService, Recipient } from '../notifications/notification.service';
import { TenantResolver } from '../tenancy/tenant-resolver.service';
import { addDays, daysBetween, fromYmd, localDate, nextReminderOn, normaliseOffsets, planDispatches, tenantOffsets, ymd } from './dates';

export const SCAN_JOB = 'reminders.scan';
const SORT = ['expiryDate', 'createdAt', 'status'] as const;
const OPEN = ['ACTIVE', 'PAUSED'] as const;
const HANDLED = ['SENT', 'SKIPPED_NO_CONSENT', 'SKIPPED_OPT_OUT', 'FAILED', 'CANCELLED'];

type ScheduleRow = Prisma.ReminderScheduleGetPayload<{
  include: { customer: { select: { fullName: true; customerNo: true; status: true } }; reminderDispatches: true };
}>;

/**
 * Document expiry reminders: schedules (one per tracked document), the daily
 * scan that turns due offsets into `document.expiring` events, and automatic
 * schedules from verified documents.
 */
@Injectable()
export class RemindersService implements OnModuleInit {
  private readonly logger = new Logger(RemindersService.name);

  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly jobs: JobQueue,
    private readonly tenants: TenantDirectory,
    private readonly notifications: NotificationService,
    private readonly resolver: TenantResolver,
  ) {}

  onModuleInit() {
    this.jobs.register(
      SCAN_JOB,
      async (payload: { today?: string }) => {
        const result = await this.tenants.forEachTenant(SCAN_JOB, async () => void (await this.scan(payload?.today)));
        if (result.failed) this.logger.warn(`${SCAN_JOB}: ${result.failed} tenant(s) failed, ${result.ok} ok`);
      },
      { attempts: 1 },
    );
    // 04:00 UTC = 08:00 in the UAE: reminders arrive at the start of the working day.
    this.jobs.schedule({ name: SCAN_JOB, cron: '0 4 * * *', description: 'Send document expiry reminders that are due today' });
    this.events.subscribe('reminders', ['document.verified'], (event) => this.onDocumentVerified(event));
    this.events.subscribe('reminders.expiry', ['document.expiry_changed'], (event) => this.onDocumentExpiryChanged(event));
    // In the request's own transaction: a cancelled renewal and the reminder that points at it never disagree.
    this.events.on('request.cancelled', (event, tx) => this.onRenewalCancelled(event, tx));
  }

  /**
   * A reminder remembers the renewal request that was started from it (`renewalRequestId`), which is what stops a
   * second renewal from being started. When that request is cancelled, the reminder is free again: the link is
   * removed, so the document can be renewed with a new request and the reminders keep coming.
   */
  async onRenewalCancelled(event: DomainEvent, tx: Tx): Promise<void> {
    const requestId = event.payload?.requestId;
    if (typeof requestId !== 'string' || !event.tenantId) return;
    const linked = await tx.reminderSchedule.findMany({ where: { tenantId: event.tenantId, renewalRequestId: requestId }, select: { id: true, subjectLabel: true } });
    if (!linked.length) return;
    await tx.reminderSchedule.updateMany({ where: { tenantId: event.tenantId, id: { in: linked.map((l) => l.id) }, renewalRequestId: requestId }, data: { renewalRequestId: null } });
    for (const schedule of linked) {
      await this.audit.log({ action: 'reminder.renewal_cleared', resourceType: 'ReminderSchedule', resourceId: schedule.id, summary: `${schedule.subjectLabel}: the renewal request was cancelled, a new renewal can be started`, before: { renewalRequestId: requestId }, after: { renewalRequestId: null } }, tx);
    }
  }

  // ------------------------------------------------------------------ helpers
  private async today(tx: Tx, override?: string): Promise<string> {
    if (override) return override;
    const tenant = await tx.tenant.findFirstOrThrow({ where: { id: this.db.tenantId }, select: { timezone: true } });
    return localDate(new Date(), tenant.timezone);
  }
  /** Tenant document type (wins) or platform default, by key. */
  private async documentType(tx: Tx, key: string) {
    const rows = await tx.documentType.findMany({ where: { key, OR: [{ tenantId: this.db.tenantId }, { tenantId: null }] } });
    return rows.find((r) => r.tenantId !== null) ?? rows[0] ?? null;
  }
  private async typeNames(tx: Tx, keys: string[]) {
    const rows = keys.length ? await tx.documentType.findMany({ where: { key: { in: keys }, OR: [{ tenantId: this.db.tenantId }, { tenantId: null }] }, select: { key: true, tenantId: true, name: true, nameAr: true } }) : [];
    const map = new Map<string, { name: string; nameAr: string | null }>();
    for (const r of rows) if (r.tenantId !== null || !map.has(r.key)) map.set(r.key, { name: r.name, nameAr: r.nameAr });
    return map;
  }
  private async companyNames(tx: Tx, ids: string[]) {
    const rows = ids.length ? await tx.corporateAccount.findMany({ where: { tenantId: this.db.tenantId, id: { in: ids } }, select: { id: true, companyName: true } }) : [];
    return new Map(rows.map((r) => [r.id, r.companyName]));
  }

  private shape(row: ScheduleRow, today: string, types: Map<string, { name: string; nameAr: string | null }>, companies: Map<string, string>, detail = false) {
    const expiryDate = ymd(row.expiryDate);
    const handled = row.reminderDispatches.filter((d) => HANDLED.includes(d.status)).map((d) => d.offsetDays);
    const lastSent = row.reminderDispatches.filter((d) => d.status === 'SENT' && d.processedAt).sort((a, b) => b.processedAt!.getTime() - a.processedAt!.getTime())[0];
    return {
      id: row.id,
      customerId: row.customerId,
      customerName: row.customer?.fullName ?? null,
      customerErased: isErasedCustomer(row.customer),
      customerNo: row.customer?.customerNo ?? null,
      corporateAccountId: row.corporateAccountId,
      corporateName: row.corporateAccountId ? (companies.get(row.corporateAccountId) ?? null) : null,
      documentId: row.documentId,
      documentTypeKey: row.documentTypeKey,
      documentTypeName: types.get(row.documentTypeKey)?.name ?? row.documentTypeKey,
      documentTypeNameAr: types.get(row.documentTypeKey)?.nameAr ?? null,
      subjectLabel: row.subjectLabel,
      expiryDate,
      daysLeft: daysBetween(today, expiryDate),
      offsetsDays: normaliseOffsets(row.offsetsDays),
      status: row.status,
      nextReminderOn: row.status === 'ACTIVE' ? nextReminderOn(expiryDate, row.offsetsDays, today, handled) : null,
      lastReminderAt: lastSent?.processedAt ?? null,
      renewalRequestId: row.renewalRequestId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(detail
        ? {
            dispatches: [...row.reminderDispatches]
              .sort((a, b) => b.offsetDays - a.offsetDays)
              .map((d) => ({ id: d.id, offsetDays: d.offsetDays, dueOn: ymd(d.dueOn), status: d.status, detail: d.detail, notificationId: d.notificationId, processedAt: d.processedAt })),
          }
        : {}),
    };
  }
  private readonly include = { customer: { select: { fullName: true, customerNo: true, status: true } }, reminderDispatches: true } as const;

  private async shapeMany(tx: Tx, rows: ScheduleRow[], today: string, detail = false) {
    const types = await this.typeNames(tx, [...new Set(rows.map((r) => r.documentTypeKey))]);
    const companies = await this.companyNames(tx, [...new Set(rows.map((r) => r.corporateAccountId).filter((v): v is string => !!v))]);
    return rows.map((r) => this.shape(r, today, types, companies, detail));
  }

  // ------------------------------------------------------------------ staff API
  async list(query: ReminderListQuery) {
    return this.db.tx(async (tx) => {
      const today = await this.today(tx);
      const where: Prisma.ReminderScheduleWhereInput = {
        tenantId: this.db.tenantId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.customerId ? { customerId: query.customerId } : {}),
        ...(query.corporateAccountId ? { corporateAccountId: query.corporateAccountId } : {}),
        ...(query.documentTypeKey ? { documentTypeKey: query.documentTypeKey } : {}),
        ...(query.q ? { subjectLabel: { contains: query.q, mode: 'insensitive' } } : {}),
      };
      if (query.withinDays !== undefined) {
        // "Upcoming expiries": still running schedules that expire within N days.
        where.expiryDate = { lte: fromYmd(addDays(today, query.withinDays)), ...(query.includeExpired ? {} : { gte: fromYmd(today) }) };
        if (!query.status) where.status = { in: [...OPEN] };
      }
      const rows = await tx.reminderSchedule.findMany({ where, ...pageArgs(query, SORT, 'expiryDate:asc'), include: this.include });
      const total = await tx.reminderSchedule.count({ where });
      return pageResult(await this.shapeMany(tx, rows, today), total, query);
    });
  }

  async get(id: string) {
    return this.db.tx(async (tx) => {
      const row = found(await tx.reminderSchedule.findFirst({ where: { id, tenantId: this.db.tenantId }, include: this.include }), 'Reminder');
      return (await this.shapeMany(tx, [row], await this.today(tx), true))[0];
    });
  }

  async create(input: CreateReminderInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const tenant = await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { settings: true, timezone: true } });
      const today = localDate(new Date(), tenant.timezone);
      if (input.expiryDate < today) throw Errors.unprocessable('EXPIRY_IN_PAST', 'The expiry date has already passed. A reminder can only be scheduled for a date in the future.');
      const type = await this.documentType(tx, input.documentTypeKey);
      if (!type || !type.isActive) throw Errors.unprocessable('UNKNOWN_DOCUMENT_TYPE', 'Choose one of the document types configured for your centre.');

      let ownerName: string | undefined;
      const corporateAccountId = input.corporateAccountId ?? null;
      if (input.customerId) {
        await assertCustomerNotErased(tx, tenantId, input.customerId);
        const customer = found(await tx.customer.findFirst({ where: { id: input.customerId, tenantId, deletedAt: null }, select: { id: true, fullName: true, status: true } }), 'Customer');
        if (customer.status !== 'ACTIVE') throw Errors.conflict('CUSTOMER_INACTIVE', 'This customer record is archived. Restore it before adding a reminder.');
        ownerName = customer.fullName;
      }
      if (corporateAccountId) {
        const account = found(await tx.corporateAccount.findFirst({ where: { id: corporateAccountId, tenantId, deletedAt: null }, select: { id: true, companyName: true } }), 'Corporate account');
        ownerName ??= account.companyName;
      }
      if (input.documentId) {
        const document = found(await tx.document.findFirst({ where: { id: input.documentId, tenantId, deletedAt: null }, select: { id: true, customerId: true, corporateAccountId: true } }), 'Document');
        const sameOwner = (input.customerId && document.customerId === input.customerId) || (corporateAccountId && document.corporateAccountId === corporateAccountId);
        if (!sameOwner) throw Errors.unprocessable('DOCUMENT_OWNER_MISMATCH', 'That document belongs to a different customer or company.');
      }
      const subjectLabel = input.subjectLabel ?? ownerName ?? type.name;
      const duplicate = await tx.reminderSchedule.findFirst({
        where: { tenantId, status: { in: [...OPEN] }, documentTypeKey: input.documentTypeKey, customerId: input.customerId ?? null, corporateAccountId, subjectLabel: { equals: subjectLabel, mode: 'insensitive' } },
        select: { id: true },
      });
      if (duplicate) throw Errors.conflict('DUPLICATE_REMINDER', 'A reminder for this document already exists. Edit the existing reminder instead.', { id: duplicate.id });

      const row = await tx.reminderSchedule.create({
        data: {
          tenantId,
          customerId: input.customerId ?? null,
          corporateAccountId,
          documentId: input.documentId ?? null,
          documentTypeKey: input.documentTypeKey,
          subjectLabel,
          expiryDate: fromYmd(input.expiryDate),
          offsetsDays: input.offsetsDays ?? tenantOffsets(tenant.settings),
          createdById: ctx().userId ?? null,
        },
        include: this.include,
      });
      await this.audit.log({ action: 'reminder.created', resourceType: 'ReminderSchedule', resourceId: row.id, after: { ...input, offsetsDays: row.offsetsDays, subjectLabel } }, tx);
      return (await this.shapeMany(tx, [row], today, true))[0];
    });
  }

  async update(id: string, input: UpdateReminderInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const before = found(await tx.reminderSchedule.findFirst({ where: { id, tenantId } }), 'Reminder');
      if (before.status === 'CANCELLED' || before.status === 'COMPLETED') {
        throw Errors.conflict('REMINDER_CLOSED', `This reminder is ${before.status.toLowerCase()} and can no longer be changed. Create a new reminder instead.`);
      }
      const today = await this.today(tx);
      if (input.expiryDate && input.expiryDate < today) throw Errors.unprocessable('EXPIRY_IN_PAST', 'The expiry date has already passed. Choose a date in the future.');
      const expiryChanged = !!input.expiryDate && input.expiryDate !== ymd(before.expiryDate);
      // A new expiry date starts a new round of reminders: the dispatch history of the old date is cleared
      // (each offset can exist once per schedule) and stays documented in the audit trail.
      let cleared = 0;
      if (expiryChanged) cleared = (await tx.reminderDispatch.deleteMany({ where: { tenantId, scheduleId: id } })).count;
      const row = await tx.reminderSchedule.update({
        where: { id },
        data: {
          ...(input.subjectLabel ? { subjectLabel: input.subjectLabel } : {}),
          ...(input.expiryDate ? { expiryDate: fromYmd(input.expiryDate) } : {}),
          ...(input.offsetsDays ? { offsetsDays: input.offsetsDays } : {}),
          ...(input.status ? { status: input.status } : {}),
        },
        include: this.include,
      });
      await this.audit.log(
        {
          action: 'reminder.updated',
          resourceType: 'ReminderSchedule',
          resourceId: id,
          before: { subjectLabel: before.subjectLabel, expiryDate: ymd(before.expiryDate), offsetsDays: before.offsetsDays, status: before.status },
          after: { ...input, ...(expiryChanged ? { dispatchesCleared: cleared } : {}) },
        },
        tx,
      );
      return (await this.shapeMany(tx, [row], today, true))[0];
    });
  }

  setStatus(id: string, status: 'ACTIVE' | 'PAUSED') {
    return this.db.tx(async (tx) => {
      const before = found(await tx.reminderSchedule.findFirst({ where: { id, tenantId: this.db.tenantId }, select: { status: true } }), 'Reminder');
      if (before.status === status) throw Errors.conflict('NO_CHANGE', status === 'PAUSED' ? 'This reminder is already paused.' : 'This reminder is already active.');
      return this.update(id, { status });
    });
  }

  async cancel(id: string, reason?: string | null) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const before = found(await tx.reminderSchedule.findFirst({ where: { id, tenantId } }), 'Reminder');
      if (before.status === 'CANCELLED') throw Errors.conflict('REMINDER_CLOSED', 'This reminder is already cancelled.');
      if (before.status === 'COMPLETED') throw Errors.conflict('REMINDER_CLOSED', 'This reminder is already completed.');
      await tx.reminderDispatch.updateMany({ where: { tenantId, scheduleId: id, status: 'PENDING' }, data: { status: 'CANCELLED', detail: 'The reminder was cancelled.', processedAt: new Date() } });
      const row = await tx.reminderSchedule.update({ where: { id }, data: { status: 'CANCELLED' }, include: this.include });
      await this.audit.log({ action: 'reminder.cancelled', resourceType: 'ReminderSchedule', resourceId: id, summary: reason ?? undefined, before: { status: before.status }, after: { status: 'CANCELLED' } }, tx);
      return (await this.shapeMany(tx, [row], await this.today(tx), true))[0];
    });
  }

  /** Portal link that opens "new request" pre-linked to this reminder (renewal assistance). */
  async renewalLink(id: string) {
    const schedule = await this.db.tx(async (tx) => found(await tx.reminderSchedule.findFirst({ where: { id, tenantId: this.db.tenantId }, select: { id: true, customerId: true, corporateAccountId: true, status: true } }), 'Reminder'));
    if (schedule.status === 'CANCELLED') throw Errors.conflict('REMINDER_CLOSED', 'This reminder was cancelled.');
    const app = !schedule.customerId && schedule.corporateAccountId ? 'corporate' : 'customer';
    return { scheduleId: schedule.id, app, link: await this.resolver.portalLink(this.db.tenantId, '/requests/new', { renewalOf: schedule.id }, app) };
  }

  // ------------------------------------------------------------------ customers / company users
  async mine(query: MyRemindersQuery) {
    const c = ctx();
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      let scope: Prisma.ReminderScheduleWhereInput;
      if (c.customerId) scope = { customerId: c.customerId };
      else if (c.actorType === 'CORPORATE' && c.corporateAccountId) {
        // Company users see the company's own documents; those who may see employee records also see theirs.
        const employeeCustomerIds = can('corp.employees.read')
          ? (await tx.corporateEmployee.findMany({ where: { tenantId, corporateAccountId: c.corporateAccountId }, select: { customerId: true } })).map((e) => e.customerId)
          : [];
        scope = { OR: [{ corporateAccountId: c.corporateAccountId }, ...(employeeCustomerIds.length ? [{ customerId: { in: employeeCustomerIds } }] : [])] };
      } else throw Errors.forbidden('NO_CUSTOMER_PROFILE', 'Your account is not linked to a customer profile.');
      // The filter narrows the scope and never widens it: a person of another company, of another centre or an
      // unknown id simply matches nothing (the answer is the same empty page in all three cases).
      const where: Prisma.ReminderScheduleWhereInput = { tenantId, status: { not: 'CANCELLED' }, AND: [scope, ...(query.customerId ? [{ customerId: query.customerId }] : [])] };
      const today = await this.today(tx);
      const rows = await tx.reminderSchedule.findMany({ where, ...pageArgs(query, SORT, 'expiryDate:asc'), include: this.include });
      const total = await tx.reminderSchedule.count({ where });
      const shaped = await this.shapeMany(tx, rows, today);
      return pageResult(
        shaped.map((s) => ({
          id: s.id,
          /** Whose document it is: a person's record (`customerId`, `customerName`) or the company itself (both null). */
          customerId: s.customerId,
          customerName: s.customerName,
          documentTypeKey: s.documentTypeKey,
          documentTypeName: s.documentTypeName,
          documentTypeNameAr: s.documentTypeNameAr,
          subjectLabel: s.subjectLabel,
          expiryDate: s.expiryDate,
          daysLeft: s.daysLeft,
          status: s.status,
          nextReminderOn: s.nextReminderOn,
          renewalRequestId: s.renewalRequestId,
          /** Path in the portal that starts a renewal request for this document. */
          renewalPath: `/requests/new?renewalOf=${s.id}`,
        })),
        total,
        query,
      );
    });
  }

  // ------------------------------------------------------------------ automatic schedules
  /**
   * A verified document with an expiry date gets a schedule when its type has
   * reminders switched on. A newer document of the same type for the same
   * person or company completes the older schedules ("renewed").
   */
  async onDocumentVerified(event: DomainEvent): Promise<void> {
    await this.syncDocumentSchedule(event, { current: false, origin: 'the verified document', createdBy: 'Created automatically from a verified document' });
  }

  /**
   * The expiry date of a document was typed by staff or applied from a reviewed
   * extraction. A running schedule of that document always follows the new date.
   * A new schedule is only started when a person confirmed the date against the
   * document (`expiryVerified`, which a reviewed extraction sets): a date that
   * was merely typed waits for the verify action, as before.
   */
  async onDocumentExpiryChanged(event: DomainEvent): Promise<void> {
    const fromExtraction = event.payload?.source === 'OCR';
    await this.syncDocumentSchedule(event, {
      // Events are delivered at least once and possibly late: the date on the document row is the truth.
      current: true,
      origin: fromExtraction ? 'the reviewed extraction of the document' : 'the document',
      createdBy: fromExtraction ? 'Created automatically from an expiry date confirmed in a reviewed extraction' : 'Created automatically from a confirmed expiry date',
    });
  }

  /**
   * `current: false` takes the date from the event (document.verified carries the date the reviewer
   * confirmed); `current: true` reads date and confirmation from the document row.
   */
  private async syncDocumentSchedule(event: DomainEvent, options: { current: boolean; origin: string; createdBy: string }): Promise<void> {
    const p = event.payload ?? {};
    if (!event.tenantId || typeof p.documentId !== 'string') return;
    if (!options.current && !p.expiryDate) return;
    await this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const document = await tx.document.findFirst({
        where: { id: p.documentId, tenantId, deletedAt: null },
        select: { id: true, customerId: true, corporateAccountId: true, documentTypeKey: true, expiryDate: true, expiryVerified: true },
      });
      if (!document || (!document.customerId && !document.corporateAccountId)) return;
      const expiryDate = options.current ? (document.expiryDate ? ymd(document.expiryDate) : null) : String(p.expiryDate).slice(0, 10);
      // A removed date changes nothing here: a running schedule keeps its date until staff edit or pause it.
      if (!expiryDate || !/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) return;
      const create = options.current ? document.expiryVerified : true;
      const type = await this.documentType(tx, document.documentTypeKey);
      if (!type?.reminderEnabled) return;
      const tenant = await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { settings: true, timezone: true } });
      const today = localDate(new Date(), tenant.timezone);
      // The customer owns personal documents; the company owns the rest.
      const owner = document.customerId ? { customerId: document.customerId, corporateAccountId: null } : { customerId: null, corporateAccountId: document.corporateAccountId };

      const existing = await tx.reminderSchedule.findFirst({ where: { tenantId, documentId: document.id, status: { in: [...OPEN] } } });
      let scheduleId: string | null = existing?.id ?? null;
      if (existing) {
        if (ymd(existing.expiryDate) !== expiryDate) {
          await tx.reminderDispatch.deleteMany({ where: { tenantId, scheduleId: existing.id } });
          await tx.reminderSchedule.update({ where: { id: existing.id }, data: { expiryDate: fromYmd(expiryDate) } });
          await this.audit.log({ action: 'reminder.updated', resourceType: 'ReminderSchedule', resourceId: existing.id, summary: `Expiry date updated from ${options.origin}`, before: { expiryDate: ymd(existing.expiryDate) }, after: { expiryDate } }, tx);
        }
      } else if (create && expiryDate >= today) {
        // An older document verified after a newer one does not need its own schedule.
        const newer = await tx.reminderSchedule.findFirst({ where: { tenantId, ...owner, documentTypeKey: document.documentTypeKey, status: { in: [...OPEN] }, expiryDate: { gt: fromYmd(expiryDate) } }, select: { id: true } });
        if (!newer) {
          const name = document.customerId
            ? (await tx.customer.findFirst({ where: { id: document.customerId, tenantId }, select: { fullName: true } }))?.fullName
            : (await tx.corporateAccount.findFirst({ where: { id: document.corporateAccountId!, tenantId }, select: { companyName: true } }))?.companyName;
          const created = await tx.reminderSchedule.create({
            data: { tenantId, ...owner, documentId: document.id, documentTypeKey: document.documentTypeKey, subjectLabel: name ?? type.name, expiryDate: fromYmd(expiryDate), offsetsDays: tenantOffsets(tenant.settings) },
          });
          scheduleId = created.id;
          await this.audit.log({ action: 'reminder.created', resourceType: 'ReminderSchedule', resourceId: created.id, summary: options.createdBy, after: { documentId: document.id, documentTypeKey: document.documentTypeKey, expiryDate } }, tx);
        }
      }
      if (!scheduleId) return;
      // Renewal: schedules for older documents of the same type stop.
      const older = await tx.reminderSchedule.findMany({
        where: { tenantId, ...owner, documentTypeKey: document.documentTypeKey, status: { in: [...OPEN] }, id: { not: scheduleId }, expiryDate: { lt: fromYmd(expiryDate) }, OR: [{ documentId: null }, { documentId: { not: document.id } }] },
        select: { id: true },
      });
      // A company tracks many documents of one type (one per employee): only the one this document replaces may stop.
      const replaceable = document.customerId ? older : [];
      for (const schedule of replaceable) {
        await tx.reminderDispatch.updateMany({ where: { tenantId, scheduleId: schedule.id, status: 'PENDING' }, data: { status: 'CANCELLED', detail: 'The document was renewed.', processedAt: new Date() } });
        await tx.reminderSchedule.update({ where: { id: schedule.id }, data: { status: 'COMPLETED' } });
        await this.audit.log({ action: 'reminder.completed', resourceType: 'ReminderSchedule', resourceId: schedule.id, summary: 'A newer document of the same type was verified (renewed)', after: { replacedByScheduleId: scheduleId } }, tx);
      }
    });
  }

  // ------------------------------------------------------------------ daily scan (one tenant)
  /**
   * For every ACTIVE schedule of the current tenant: record the reminder that
   * is due, check consent and preferences, and emit `document.expiring` (the
   * notifications module sends). Idempotent: `reminder_dispatches` is unique
   * per schedule and offset, so a second run on the same day does nothing.
   */
  async scan(todayOverride?: string): Promise<{ schedules: number; sent: number; skipped: number; completed: number }> {
    const tenantId = this.db.tenantId;
    const stats = { schedules: 0, sent: 0, skipped: 0, completed: 0 };
    const today = await this.db.tx((tx) => this.today(tx, todayOverride));
    let cursor: string | undefined;
    for (;;) {
      const batch = await this.db.tx((tx) =>
        tx.reminderSchedule.findMany({ where: { tenantId, status: 'ACTIVE', ...(cursor ? { id: { gt: cursor } } : {}) }, orderBy: { id: 'asc' }, take: 200, select: { id: true } }),
      );
      if (!batch.length) break;
      cursor = batch[batch.length - 1].id;
      for (const { id } of batch) {
        stats.schedules += 1;
        try {
          const outcome = await this.scanSchedule(id, today);
          if (outcome === 'SENT') stats.sent += 1;
          else if (outcome === 'SKIPPED') stats.skipped += 1;
          else if (outcome === 'COMPLETED') stats.completed += 1;
        } catch (e: any) {
          this.logger.error(`reminder schedule ${id} could not be processed: ${e?.message ?? e}`);
        }
      }
      if (batch.length < 200) break;
    }
    return stats;
  }

  private scanSchedule(id: string, today: string): Promise<'SENT' | 'SKIPPED' | 'COMPLETED' | 'NONE'> {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      // Lock the schedule so two scans running at the same time handle it one after the other.
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "reminder_schedules" WHERE "id" = ${id}::uuid AND "tenantId" = ${tenantId}::uuid AND "status" = 'ACTIVE' FOR UPDATE`;
      if (!locked.length) return 'NONE';
      const schedule = await tx.reminderSchedule.findFirstOrThrow({ where: { id, tenantId }, include: { reminderDispatches: { select: { offsetDays: true, status: true } } } });
      const expiryDate = ymd(schedule.expiryDate);
      const plan = planDispatches(expiryDate, schedule.offsetsDays, today, schedule.reminderDispatches.map((d) => d.offsetDays));
      const now = new Date();
      if (plan.superseded.length) {
        await tx.reminderDispatch.createMany({
          data: plan.superseded.map((offsetDays) => ({ tenantId, scheduleId: id, offsetDays, dueOn: fromYmd(addDays(expiryDate, -offsetDays)), status: 'CANCELLED', detail: plan.expired ? 'The document expired before this reminder was due to be sent.' : 'Replaced by a later reminder.', processedAt: now })),
          skipDuplicates: true,
        });
      }
      if (plan.expired) {
        await tx.reminderDispatch.updateMany({ where: { tenantId, scheduleId: id, status: 'PENDING' }, data: { status: 'CANCELLED', detail: 'The document expired.', processedAt: now } });
        await tx.reminderSchedule.update({ where: { id }, data: { status: 'COMPLETED' } });
        return 'COMPLETED';
      }
      if (plan.send === null) return 'NONE';

      const inserted = await tx.reminderDispatch.createMany({ data: [{ tenantId, scheduleId: id, offsetDays: plan.send, dueOn: fromYmd(addDays(expiryDate, -plan.send)), status: 'PENDING' }], skipDuplicates: true });
      if (!inserted.count) return 'NONE';
      const dispatch = await tx.reminderDispatch.findFirstOrThrow({ where: { tenantId, scheduleId: id, offsetDays: plan.send } });

      // Consent and preferences are checked before anything is emitted.
      const recipients: Recipient[] = schedule.customerId
        ? [{ kind: 'CUSTOMER', customerId: schedule.customerId }]
        : schedule.corporateAccountId
          ? await this.notifications.corporateRecipients(tx, schedule.corporateAccountId)
          : [];
      const outcomes = [];
      for (const recipient of recipients) outcomes.push(await this.notifications.evaluate(tx, recipient, 'document.expiry'));
      let status: string;
      let detail: string | null = null;
      if (outcomes.includes('ALLOWED')) status = 'SENT';
      else if (outcomes.includes('NO_CONSENT')) {
        status = 'SKIPPED_NO_CONSENT';
        detail = 'The customer has not agreed to receive expiry reminders.';
      } else if (outcomes.includes('OPT_OUT')) {
        status = 'SKIPPED_OPT_OUT';
        detail = 'The customer opted out of reminders on every available channel.';
      } else {
        status = 'FAILED';
        detail = 'There is no email address, phone number or portal account to send the reminder to.';
      }
      await tx.reminderDispatch.update({ where: { id: dispatch.id }, data: { status, detail, processedAt: now } });
      if (status !== 'SENT') return 'SKIPPED';
      await this.events.emit(tx, 'document.expiring', {
        scheduleId: id,
        dispatchId: dispatch.id,
        documentId: schedule.documentId,
        customerId: schedule.customerId,
        corporateAccountId: schedule.corporateAccountId,
        documentTypeKey: schedule.documentTypeKey,
        subjectLabel: schedule.subjectLabel,
        expiryDate,
        daysLeft: plan.daysLeft,
        offsetDays: plan.send,
      });
      return 'SENT';
    });
  }
}
