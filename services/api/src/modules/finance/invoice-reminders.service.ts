import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { InvoiceReminderSettingsInput, PauseInvoiceRemindersInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { Prisma, TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { DomainEvents } from '../../common/events.service';
import { JobQueue } from '../../common/jobs/job-queue';
import { TenantDirectory } from '../../common/tenant-directory';
import { daysBetween, localYmd, safeTimeZone } from '../reports/time';
import { fmt } from './finance.calc';
import { documentScope } from './finance.core';

export const INVOICE_REMINDER_JOB = 'finance.invoice-reminders';
/** On the due date, then 3, 7 and 14 days late. */
export const DEFAULT_REMINDER_DAYS = [0, 3, 7, 14];
/** Reminders stop this many days after the last stage: older debt is followed up by people, not by a burst of messages. */
const GRACE_AFTER_LAST_STAGE = 7;
/** A manual reminder cannot be sent again within this many minutes (double clicks, two people at once). */
const MANUAL_COOLDOWN_MINUTES = 10;
const OPEN: Array<'ISSUED' | 'PARTIALLY_PAID'> = ['ISSUED', 'PARTIALLY_PAID'];

export interface ReminderSettings {
  enabled: boolean;
  days: number[];
}

/**
 * Payment reminders for unpaid invoices.
 *
 * Every morning each open invoice with a balance is placed on the centre's schedule of days relative to its
 * due date. The latest stage that has been reached is sent, once; a stage that was skipped (the job did not
 * run, the invoice was paused) is not sent late, and an invoice discovered long after its last stage is left
 * to the staff. The message (invoice.payment_reminder -> notification "invoice.reminder") carries the link to
 * pay the invoice online in the portal.
 */
@Injectable()
export class InvoiceRemindersService implements OnModuleInit {
  private readonly logger = new Logger(InvoiceRemindersService.name);

  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly jobs: JobQueue,
    private readonly tenants: TenantDirectory,
  ) {}

  onModuleInit() {
    this.jobs.register(
      INVOICE_REMINDER_JOB,
      async (payload: { today?: string }) => {
        const result = await this.tenants.forEachTenant(INVOICE_REMINDER_JOB, async () => void (await this.scan(payload?.today)));
        if (result.failed) this.logger.warn(`${INVOICE_REMINDER_JOB}: ${result.failed} tenant(s) failed, ${result.ok} ok`);
      },
      { attempts: 1 },
    );
    // 05:00 UTC = 09:00 in the UAE, an hour after the document expiry reminders.
    this.jobs.schedule({ name: INVOICE_REMINDER_JOB, cron: '0 5 * * *', description: 'Send payment reminders for unpaid invoices' });
  }

  // ------------------------------------------------------------------ settings
  static read(settings: unknown): ReminderSettings {
    const s = (settings ?? {}) as Record<string, unknown>;
    const days = Array.isArray(s.invoiceReminderDays) && s.invoiceReminderDays.every((d) => Number.isInteger(d)) ? (s.invoiceReminderDays as number[]) : DEFAULT_REMINDER_DAYS;
    return { enabled: s.invoiceRemindersEnabled !== false, days: [...days].sort((a, b) => a - b) };
  }

  async settings(): Promise<ReminderSettings> {
    return this.db.tx(async (tx) => InvoiceRemindersService.read((await tx.tenant.findFirstOrThrow({ where: { id: this.db.tenantId }, select: { settings: true } })).settings));
  }

  async updateSettings(input: InvoiceReminderSettingsInput): Promise<ReminderSettings> {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const t = await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { settings: true } });
      const before = InvoiceRemindersService.read(t.settings);
      const next = {
        ...((t.settings ?? {}) as Record<string, unknown>),
        ...(input.enabled !== undefined ? { invoiceRemindersEnabled: input.enabled } : {}),
        ...(input.days !== undefined ? { invoiceReminderDays: [...input.days].sort((a, b) => a - b) } : {}),
      };
      await tx.tenant.update({ where: { id: tenantId }, data: { settings: next as Prisma.InputJsonValue } });
      const after = InvoiceRemindersService.read(next);
      await this.audit.log({ action: 'finance.reminder_settings_updated', resourceType: 'Tenant', resourceId: tenantId, before: { ...before }, after: { ...after } }, tx);
      return after;
    });
  }

  // ------------------------------------------------------------------ the daily scan
  /** Pure decision, unit-tested: which stage (if any) should be sent today. */
  static stageToSend(daysOverdue: number, stages: number[], alreadySent: Set<number>): number | null {
    const reached = stages.filter((s) => s <= daysOverdue);
    if (!reached.length) return null;
    const last = Math.max(...stages);
    if (daysOverdue > last + GRACE_AFTER_LAST_STAGE) return null;
    const stage = Math.max(...reached);
    // Sent already, or a later one was (a manual change of the schedule must not resend older stages).
    if ([...alreadySent].some((s) => s >= stage)) return null;
    return stage;
  }

  async scan(todayOverride?: string): Promise<{ checked: number; sent: number }> {
    return this.db.tx(
      async (tx) => {
        const tenantId = this.db.tenantId;
        const tenant = await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { settings: true, timezone: true } });
        const settings = InvoiceRemindersService.read(tenant.settings);
        if (!settings.enabled) return { checked: 0, sent: 0 };
        const tz = safeTimeZone(tenant.timezone);
        const today = todayOverride ?? localYmd(new Date(), tz);
        const invoices = await tx.invoice.findMany({
          where: {
            tenantId,
            status: { in: OPEN },
            balanceDue: { gt: 0 },
            dueAt: { not: null },
            // Erased and merged-away customers are not contacted.
            customer: { is: { status: 'ACTIVE' } },
          },
          select: { id: true, invoiceNo: true, dueAt: true, balanceDue: true, currency: true, remindersPausedUntil: true, customerId: true, reminders: { where: { automatic: true }, select: { stage: true } } },
        });
        let sent = 0;
        for (const inv of invoices) {
          const pausedUntil = inv.remindersPausedUntil ? inv.remindersPausedUntil.toISOString().slice(0, 10) : null;
          if (pausedUntil && pausedUntil >= today) continue;
          const daysOverdue = daysBetween(localYmd(inv.dueAt!, tz), today);
          const stage = InvoiceRemindersService.stageToSend(daysOverdue, settings.days, new Set(inv.reminders.map((r) => r.stage!)));
          if (stage === null) continue;
          // The unique index (invoiceId, stage) makes a second run of the same day harmless.
          const created = await tx.$executeRaw`
            INSERT INTO "invoice_reminders" ("tenantId", "invoiceId", "stage", "daysOverdue", "automatic", "amount", "currency")
            VALUES (${tenantId}::uuid, ${inv.id}::uuid, ${stage}, ${daysOverdue}, true, ${inv.balanceDue}, ${inv.currency})
            ON CONFLICT ("invoiceId", "stage") WHERE "automatic" DO NOTHING`;
          if (!created) continue;
          await this.events.emit(tx, 'invoice.payment_reminder', { invoiceId: inv.id, invoiceNo: inv.invoiceNo, customerId: inv.customerId, stage, daysOverdue, amount: fmt(inv.balanceDue), currency: inv.currency, automatic: true });
          sent += 1;
        }
        if (sent) this.logger.log(`${tenantId}: ${sent} invoice reminder(s) sent for ${today}`);
        return { checked: invoices.length, sent };
      },
      { timeoutMs: 120_000 },
    );
  }

  // ------------------------------------------------------------------ per invoice (staff)
  private async loadInvoice(tx: Tx, id: string) {
    return found(
      await tx.invoice.findFirst({
        where: { id, tenantId: this.db.tenantId, AND: [documentScope()] },
        select: { id: true, invoiceNo: true, status: true, balanceDue: true, currency: true, dueAt: true, customerId: true, remindersPausedUntil: true, customer: { select: { status: true } } },
      }),
      'Invoice',
    );
  }

  async history(id: string) {
    return this.db.tx(async (tx) => {
      const inv = await this.loadInvoice(tx, id);
      const tenant = await tx.tenant.findFirstOrThrow({ where: { id: this.db.tenantId }, select: { settings: true, timezone: true } });
      const settings = InvoiceRemindersService.read(tenant.settings);
      const rows = await tx.invoiceReminder.findMany({ where: { tenantId: this.db.tenantId, invoiceId: id }, orderBy: { createdAt: 'desc' } });
      const tz = safeTimeZone(tenant.timezone);
      const sentStages = new Set(rows.filter((r) => r.automatic).map((r) => r.stage!));
      // The next automatic stage still to come, for "next reminder on ...".
      let next: { stage: number; date: string } | null = null;
      if (settings.enabled && OPEN.includes(inv.status as 'ISSUED') && inv.balanceDue.gt(0) && inv.dueAt) {
        const due = localYmd(inv.dueAt, tz);
        const today = localYmd(new Date(), tz);
        const overdue = daysBetween(due, today);
        const upcoming = settings.days.filter((s) => s > overdue && ![...sentStages].some((x) => x >= s));
        if (upcoming.length) {
          const stage = Math.min(...upcoming);
          const date = new Date(Date.parse(`${due}T00:00:00.000Z`) + stage * 86_400_000).toISOString().slice(0, 10);
          next = { stage, date };
        }
      }
      return {
        enabled: settings.enabled,
        pausedUntil: inv.remindersPausedUntil ? inv.remindersPausedUntil.toISOString().slice(0, 10) : null,
        next,
        reminders: rows.map((r) => ({ id: r.id, automatic: r.automatic, stage: r.stage, daysOverdue: r.daysOverdue, amount: fmt(r.amount), currency: r.currency, sentById: r.sentById, createdAt: r.createdAt })),
      };
    });
  }

  async sendNow(id: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const inv = await this.loadInvoice(tx, id);
      if (!OPEN.includes(inv.status as 'ISSUED') || inv.balanceDue.lte(0)) throw Errors.conflict('NOTHING_DUE', `Invoice ${inv.invoiceNo} has nothing left to pay.`);
      if (inv.customer.status !== 'ACTIVE') throw Errors.conflict('CUSTOMER_NOT_ACTIVE', 'This customer record is archived, merged or erased and cannot be contacted.');
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:invoice-reminder:${id}`}, 0))::text AS locked`;
      const recent = await tx.invoiceReminder.findFirst({ where: { tenantId, invoiceId: id, automatic: false, createdAt: { gt: new Date(Date.now() - MANUAL_COOLDOWN_MINUTES * 60_000) } } });
      if (recent) throw Errors.conflict('REMINDER_TOO_SOON', `A reminder for ${inv.invoiceNo} was sent a moment ago. Wait a few minutes before sending another.`);
      const tz = safeTimeZone((await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { timezone: true } })).timezone);
      const daysOverdue = inv.dueAt ? daysBetween(localYmd(inv.dueAt, tz), localYmd(new Date(), tz)) : 0;
      const row = await tx.invoiceReminder.create({ data: { tenantId, invoiceId: id, stage: null, daysOverdue, automatic: false, amount: inv.balanceDue, currency: inv.currency, sentById: ctx().userId ?? null } });
      await this.events.emit(tx, 'invoice.payment_reminder', { invoiceId: id, invoiceNo: inv.invoiceNo, customerId: inv.customerId, stage: null, daysOverdue, amount: fmt(inv.balanceDue), currency: inv.currency, automatic: false });
      await this.audit.log({ action: 'invoice.reminder_sent', resourceType: 'Invoice', resourceId: id, summary: `Payment reminder sent for ${inv.invoiceNo} (${inv.currency} ${fmt(inv.balanceDue)})` }, tx);
      return { id: row.id, createdAt: row.createdAt };
    });
  }

  async pause(id: string, input: PauseInvoiceRemindersInput) {
    return this.db.tx(async (tx) => {
      const inv = await this.loadInvoice(tx, id);
      await tx.invoice.update({ where: { id }, data: { remindersPausedUntil: input.until ? new Date(`${input.until}T00:00:00.000Z`) : null } });
      await this.audit.log({ action: input.until ? 'invoice.reminders_paused' : 'invoice.reminders_resumed', resourceType: 'Invoice', resourceId: id, summary: input.until ? `Reminders for ${inv.invoiceNo} paused until ${input.until}` : `Reminders for ${inv.invoiceNo} resumed` }, tx);
      return { pausedUntil: input.until };
    });
  }
}
