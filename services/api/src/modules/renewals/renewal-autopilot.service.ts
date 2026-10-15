import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { RenewalAutopilotSettingsInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { runAsTenant } from '../../common/context';
import { signPayload, verifyPayload } from '../../common/crypto';
import { Prisma, TenantDb, Tx } from '../../common/db/prisma.service';
import { AppError, Errors, found } from '../../common/errors';
import { DomainEvents } from '../../common/events.service';
import { JobQueue } from '../../common/jobs/job-queue';
import { TenantDirectory } from '../../common/tenant-directory';
import { fmt } from '../finance/finance.calc';
import { PaymentGateways } from '../finance/gateways/payment-gateways';
import { PaymentsService } from '../finance/payments.service';
import { QuotationsService } from '../finance/quotations.service';
import { addDays, localDate, ymd } from '../reminders/dates';
import { RequestsService } from '../requests/requests.service';
import { TenantResolver } from '../tenancy/tenant-resolver.service';

export const AUTOPILOT_JOB = 'renewals.autopilot';
const DEFAULT_DAYS_BEFORE = 30;
/** Documents that expired longer ago than this are left to the staff: the customer has most likely renewed elsewhere. */
const EXPIRED_GRACE_DAYS = 30;
/** The one-tap link outlives the quotation validity a little, so an expired quotation is explained instead of a dead link. */
const LINK_TTL_SECONDS = 60 * 86_400;

interface Settings {
  enabled: boolean;
  daysBefore: number;
  services: Record<string, string>;
}
interface LinkPayload {
  k: 'renewal';
  t: string;
  q: string;
}

/**
 * Renewal autopilot. Every morning, for each tracked document of an individual customer that expires within the
 * configured window and whose document type is mapped to a renewal service: open the renewal request (linked to the
 * reminder, so it happens once), quote it from the service price, send the quotation and give the customer a signed
 * one-tap link. The link shows the price and lets the customer approve and pay online without signing in.
 *
 * Company documents are left out on purpose: a company's administrators approve its quotations in their own portal.
 */
@Injectable()
export class RenewalAutopilotService implements OnModuleInit {
  private readonly logger = new Logger(RenewalAutopilotService.name);

  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly jobs: JobQueue,
    private readonly tenants: TenantDirectory,
    private readonly requests: RequestsService,
    private readonly quotations: QuotationsService,
    private readonly payments: PaymentsService,
    private readonly gateways: PaymentGateways,
    private readonly resolver: TenantResolver,
  ) {}

  onModuleInit() {
    this.jobs.register(
      AUTOPILOT_JOB,
      async (payload: { today?: string }) => {
        const result = await this.tenants.forEachTenant(AUTOPILOT_JOB, async () => void (await this.run(payload?.today)));
        if (result.failed) this.logger.warn(`${AUTOPILOT_JOB}: ${result.failed} tenant(s) failed, ${result.ok} ok`);
      },
      { attempts: 1 },
    );
    // 04:30 UTC = 08:30 in the UAE, after the expiry reminders of the morning.
    this.jobs.schedule({ name: AUTOPILOT_JOB, cron: '30 4 * * *', description: 'Prepare renewals for documents that expire soon and send the one-tap link' });
  }

  // ------------------------------------------------------------------ settings
  private read(raw: unknown): Settings {
    const s = (raw ?? {}) as Record<string, unknown>;
    const services = s.renewalAutopilotServices && typeof s.renewalAutopilotServices === 'object' ? (s.renewalAutopilotServices as Record<string, string>) : {};
    return { enabled: s.renewalAutopilotEnabled === true, daysBefore: Number(s.renewalAutopilotDaysBefore) || DEFAULT_DAYS_BEFORE, services };
  }

  async settings(): Promise<Settings> {
    return this.db.tx(async (tx) => this.read((await tx.tenant.findFirstOrThrow({ where: { id: this.db.tenantId }, select: { settings: true } })).settings));
  }

  async updateSettings(input: RenewalAutopilotSettingsInput): Promise<Settings> {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const t = await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { settings: true } });
      const before = this.read(t.settings);
      const services = { ...before.services };
      for (const [key, serviceId] of Object.entries(input.services ?? {})) {
        if (serviceId === null) delete services[key];
        else {
          found(await tx.service.findFirst({ where: { id: serviceId, tenantId, deletedAt: null }, select: { id: true } }), 'Service');
          services[key] = serviceId;
        }
      }
      const next = {
        ...((t.settings ?? {}) as Record<string, unknown>),
        renewalAutopilotEnabled: input.enabled ?? before.enabled,
        renewalAutopilotDaysBefore: input.daysBefore ?? before.daysBefore,
        renewalAutopilotServices: services,
      };
      await tx.tenant.update({ where: { id: tenantId }, data: { settings: next as Prisma.InputJsonValue } });
      const after = this.read(next);
      await this.audit.log({ action: 'renewals.autopilot_updated', resourceType: 'Tenant', resourceId: tenantId, before: { ...before }, after: { ...after } }, tx);
      return after;
    });
  }

  /** "Residence Visa - Tariq Mahmood": reminders made from a verified document are labelled with the person only. */
  private async documentName(tx: Tx, tenantId: string, key: string, label: string) {
    const types = await tx.documentType.findMany({ where: { key, OR: [{ tenantId }, { tenantId: null }] }, select: { tenantId: true, name: true, nameAr: true } });
    const type = types.find((x) => x.tenantId !== null) ?? types[0];
    if (!type) return { en: label, ar: label };
    const has = (name: string | null) => !!name && label.toLowerCase().includes(name.toLowerCase());
    const en = has(type.name) ? label : `${type.name} - ${label}`;
    return { en, ar: type.nameAr && !has(type.nameAr) && !has(type.name) ? `${type.nameAr} - ${label}` : en };
  }

  // ------------------------------------------------------------------ the daily run
  /** Documents the autopilot would renew now: individual customers, no renewal yet, inside the window, type mapped. */
  async candidates(todayOverride?: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const t = await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { settings: true, timezone: true } });
      const s = this.read(t.settings);
      const today = todayOverride ?? localDate(new Date(), t.timezone);
      const rows = await tx.reminderSchedule.findMany({
        where: {
          tenantId,
          status: 'ACTIVE',
          renewalRequestId: null,
          corporateAccountId: null,
          customerId: { not: null },
          customer: { status: 'ACTIVE', deletedAt: null },
          documentTypeKey: { in: Object.keys(s.services) },
          expiryDate: { gte: new Date(`${addDays(today, -EXPIRED_GRACE_DAYS)}T00:00:00.000Z`), lte: new Date(`${addDays(today, s.daysBefore)}T00:00:00.000Z`) },
        },
        orderBy: { expiryDate: 'asc' },
        take: 200,
        select: { id: true, subjectLabel: true, documentTypeKey: true, expiryDate: true, customer: { select: { fullName: true } } },
      });
      return { settings: s, today, rows: rows.map((r) => ({ id: r.id, subjectLabel: r.subjectLabel, documentTypeKey: r.documentTypeKey, expiryDate: ymd(r.expiryDate), customerName: r.customer?.fullName ?? null })) };
    });
  }

  /** One centre: offers every candidate. One failure (no price, inactive service...) never stops the others. */
  async run(todayOverride?: string): Promise<{ offered: number; failed: Array<{ scheduleId: string; reason: string }> }> {
    const { settings, rows } = await this.candidates(todayOverride);
    if (!settings.enabled) return { offered: 0, failed: [] };
    let offered = 0;
    const failed: Array<{ scheduleId: string; reason: string }> = [];
    for (const row of rows) {
      try {
        await this.offer(row.id);
        offered += 1;
      } catch (e) {
        const reason = e instanceof AppError ? e.message : 'Unexpected error';
        failed.push({ scheduleId: row.id, reason });
        if (!(e instanceof AppError)) this.logger.error(`renewal offer for ${row.id} failed`, e as Error);
        await this.db.tx((tx) => this.audit.log({ action: 'renewals.offer_failed', resourceType: 'ReminderSchedule', resourceId: row.id, summary: `${row.subjectLabel}: the renewal could not be prepared - ${reason}` }, tx));
      }
    }
    return { offered, failed };
  }

  /**
   * Opens the renewal request, quotes and sends it, and emits `renewal.offered` with the one-tap link - all in one
   * transaction, so a failure leaves nothing half-made behind.
   */
  async offer(scheduleId: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const s = this.read((await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { settings: true } })).settings);
      // Locked: two runs (the job and a member of staff) can never both renew the same document.
      await tx.$queryRaw`SELECT 1 FROM "reminder_schedules" WHERE "id" = ${scheduleId}::uuid AND "tenantId" = ${tenantId}::uuid FOR UPDATE`;
      const schedule = found(await tx.reminderSchedule.findFirst({ where: { id: scheduleId, tenantId } }), 'Reminder');
      if (schedule.renewalRequestId) throw Errors.conflict('RENEWAL_EXISTS', 'A renewal request was already started for this document.');
      if (!schedule.customerId || schedule.corporateAccountId) throw Errors.unprocessable('RENEWAL_NOT_FOR_COMPANIES', 'The autopilot renews documents of individual customers. Start a company renewal from the company\'s page.');
      const serviceId = s.services[schedule.documentTypeKey];
      if (!serviceId) throw Errors.unprocessable('NO_RENEWAL_SERVICE', 'Choose the service that renews this type of document in the renewal autopilot settings.');

      const request = await this.requests.create({ serviceId, customerId: schedule.customerId, renewalOfScheduleId: schedule.id, instructions: `Renewal of ${schedule.subjectLabel} (expires ${ymd(schedule.expiryDate)}), prepared by the renewal autopilot.` });
      const draft = await this.quotations.createFromRequest(request.id, {});
      const quotation = await this.quotations.send(draft.id, { silent: true });
      const service = await tx.service.findFirstOrThrow({ where: { id: serviceId }, select: { name: true, nameAr: true } });
      const documentName = await this.documentName(tx, tenantId, schedule.documentTypeKey, schedule.subjectLabel);
      const renewLink = await this.resolver.portalLink(tenantId, '/renew', { t: signPayload({ k: 'renewal', t: tenantId, q: quotation.id }, LINK_TTL_SECONDS) });
      await this.events.emit(tx, 'renewal.offered', {
        scheduleId: schedule.id,
        requestId: request.id,
        quotationId: quotation.id,
        customerId: schedule.customerId,
        documentName: documentName.en,
        documentNameAr: documentName.ar,
        expiryDate: ymd(schedule.expiryDate),
        serviceName: service.name,
        serviceNameAr: service.nameAr,
        total: fmt(quotation.total),
        currency: quotation.currency,
        renewLink,
      });
      await this.audit.log(
        { action: 'renewals.offered', resourceType: 'ReminderSchedule', resourceId: schedule.id, summary: `${schedule.subjectLabel}: renewal ${request.requestNo} quoted (${quotation.quotationNo}, ${quotation.currency} ${fmt(quotation.total)}) and offered to the customer`, after: { requestId: request.id, quotationId: quotation.id } },
        tx,
      );
      return { scheduleId: schedule.id, requestId: request.id, requestNo: request.requestNo as string, quotationId: quotation.id, quotationNo: quotation.quotationNo as string, total: fmt(quotation.total), currency: quotation.currency as string, renewLink };
    });
  }

  // ------------------------------------------------------------------ the one-tap link (public)
  private decode(token: string): LinkPayload {
    const p = verifyPayload<LinkPayload>(token);
    if (!p || p.k !== 'renewal' || typeof p.t !== 'string' || typeof p.q !== 'string') throw Errors.notFound('Renewal offer');
    return p;
  }

  /** What the customer sees before deciding. Only what the link holder needs: no contact details, no document data. */
  async view(token: string) {
    const p = this.decode(token);
    return runAsTenant(p.t, () =>
      this.db.tx(async (tx) => {
        const q = found(
          await tx.quotation.findFirst({
            where: { id: p.q, tenantId: p.t },
            include: { quotationItems: { orderBy: { sortOrder: 'asc' } }, customer: { select: { fullName: true } }, request: { select: { requestNo: true, service: { select: { name: true, nameAr: true } } } } },
          }),
          'Renewal offer',
        );
        const schedule = q.requestId ? await tx.reminderSchedule.findFirst({ where: { tenantId: p.t, renewalRequestId: q.requestId }, select: { subjectLabel: true, documentTypeKey: true, expiryDate: true } }) : null;
        const documentName = schedule ? await this.documentName(tx, p.t, schedule.documentTypeKey, schedule.subjectLabel) : null;
        const tenant = await tx.tenant.findFirstOrThrow({ where: { id: p.t }, select: { name: true } });
        const invoice = await tx.invoice.findFirst({ where: { tenantId: p.t, quotationId: q.id, status: { not: 'VOID' } }, select: { invoiceNo: true, status: true, balanceDue: true } });
        let payOnline = true;
        try {
          await this.gateways.forTenant(tx);
        } catch {
          payOnline = false;
        }
        const expired = q.status === 'SENT' && !!q.validUntil && q.validUntil < new Date();
        return {
          centreName: tenant.name,
          customerFirstName: (q.customer?.fullName ?? '').split(' ')[0] ?? '',
          status: expired ? 'EXPIRED' : q.status,
          quotationNo: q.quotationNo,
          requestNo: q.request?.requestNo ?? null,
          serviceName: q.request?.service.name ?? null,
          serviceNameAr: q.request?.service.nameAr ?? null,
          documentName: documentName?.en ?? null,
          documentNameAr: documentName?.ar ?? null,
          expiryDate: schedule ? ymd(schedule.expiryDate) : null,
          validUntil: q.validUntil,
          currency: q.currency,
          lines: q.quotationItems.map((i) => ({ description: i.description, component: i.component, amount: fmt(i.lineTotal) })),
          taxTotal: fmt(q.taxTotal),
          total: fmt(q.total),
          payOnline,
          invoice: invoice ? { invoiceNo: invoice.invoiceNo, status: invoice.status, balanceDue: fmt(invoice.balanceDue) } : null,
        };
      }),
    );
  }

  /** The customer's context, for exactly the one quotation the link was made for. */
  private asCustomer<T>(p: LinkPayload, customerId: string, fn: () => Promise<T>) {
    return runAsTenant(p.t, fn, { actorType: 'CUSTOMER', actorLabel: 'renewal link', customerId, permissions: new Set(['self.payments']), allBranches: false });
  }
  private async owner(p: LinkPayload) {
    const q = await runAsTenant(p.t, () => this.db.tx((tx) => tx.quotation.findFirst({ where: { id: p.q, tenantId: p.t }, select: { customerId: true, status: true } })));
    return found(q, 'Renewal offer');
  }

  /**
   * Approve (creates the invoice) and, when the centre takes online payments, open the payment page. Opening the
   * link again after approving goes straight back to payment.
   */
  async accept(token: string, returnUrl?: string) {
    const p = this.decode(token);
    const q = await this.owner(p);
    return this.asCustomer(p, q.customerId, async () => {
      let invoiceId: string;
      if (q.status === 'SENT') invoiceId = (await this.quotations.approve(p.q)).invoice.id;
      else if (q.status === 'APPROVED') {
        invoiceId = found(await this.db.tx((tx) => tx.invoice.findFirst({ where: { tenantId: p.t, quotationId: p.q, status: { not: 'VOID' } }, select: { id: true } })), 'Invoice').id;
      } else throw Errors.conflict('QUOTATION_NOT_OPEN', 'This renewal offer is no longer open. Please contact the centre.');
      try {
        const checkout = await this.payments.startOnline(invoiceId, { returnUrl });
        return { approved: true, checkoutUrl: checkout.checkoutUrl as string | null };
      } catch (e) {
        // Paid already, or no online payments at this centre: approved all the same, the customer pays at the counter.
        if (e instanceof AppError && ['INTEGRATION_NOT_CONFIGURED', 'INVOICE_NOT_PAYABLE'].includes(e.code)) return { approved: true, checkoutUrl: null };
        throw e;
      }
    });
  }

  async decline(token: string, reason?: string | null) {
    const p = this.decode(token);
    const q = await this.owner(p);
    await this.asCustomer(p, q.customerId, () => this.quotations.reject(p.q, reason || 'Declined from the renewal link'));
    return { declined: true };
  }
}
