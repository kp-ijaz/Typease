import type { TicketFx } from './fixture-types';
import { daysAgo, HOUR, isoDay, step } from './runtime';
import { SeedContext, TenantState } from './state';

const TYPE_NAMES: Record<string, string> = { trade_licence: 'trade licence', residence_visa: 'residence visa', tenancy_contract: 'tenancy contract', labour_card: 'labour card', emirates_id: 'Emirates ID', passport: 'passport' };

/** Support tickets between customers and the centre, with internal notes, every status and satisfaction ratings. */
export async function runTickets(ctx: SeedContext, t: TenantState): Promise<void> {
  const list = t.fx.tickets ?? [];
  if (!list.length) return;
  const { rt } = ctx;
  const desk = t.receptionist();
  await step(`${t.fx.name}: ${list.length} support tickets`, async () => {
    for (const k of [...list].sort((a, b) => b.openedDaysAgo - a.openedDaysAgo) as TicketFx[]) {
      const customer = t.customer(k.customer);
      const opened = daysAgo(k.openedDaysAgo);
      const at = (hours: number) => ctx.timeline.office(new Date(opened.getTime() + hours * HOUR));
      const request = k.request ? t.request(k.request) : null;
      const [first, ...rest] = k.messages;
      const pin = ctx.timeline.begin(at(0));
      let ticket: any;
      if (k.via === 'PORTAL') {
        if (!customer.portal) throw new Error(`${k.ref}: customer ${k.customer} has no portal account to open a ticket with.`);
        ticket = await rt.as(customer.portal).post('/me/tickets', { subject: k.subject, message: first.body, ...(k.category ? { category: k.category } : {}), ...(request ? { requestId: request.id } : {}) });
      } else {
        ticket = await rt.as(first.by ? t.actor(first.by) : desk).post('/support/tickets', { customerId: customer.id, subject: k.subject, message: first.body, ...(k.category ? { category: k.category } : {}), priority: k.priority ?? 'NORMAL', ...(request ? { requestId: request.id } : {}) });
      }
      pin(ticket.id);
      t.count('tickets');
      const manager = rt.as(k.assignee ? t.actor(k.assignee) : desk);
      if (k.assignee || (k.via === 'PORTAL' && k.priority)) {
        await rt.as(desk).patch(`/support/tickets/${ticket.id}`, { ...(k.assignee ? { assigneeId: t.actor(k.assignee).membershipId } : {}), ...(k.via === 'PORTAL' && k.priority ? { priority: k.priority } : {}) });
      }

      const visibleStaffReplies = rest.filter((m) => m.from === 'STAFF' && !m.internal);
      for (const m of rest) {
        ctx.timeline.mark(ticket.id, at(m.afterHours));
        if (m.from === 'CUSTOMER') {
          if (!customer.portal) throw new Error(`${k.ref}: a customer reply needs a portal account for ${k.customer}.`);
          await rt.as(customer.portal).post(`/me/tickets/${ticket.id}/messages`, { body: m.body });
        } else {
          const author = rt.as(m.by ? t.actor(m.by) : desk);
          const last = m === visibleStaffReplies[visibleStaffReplies.length - 1];
          await author.post(`/support/tickets/${ticket.id}/messages`, {
            body: m.body,
            visibility: m.internal ? 'INTERNAL' : 'CUSTOMER',
            ...(last && k.state === 'WAITING_CUSTOMER' ? { status: 'WAITING_CUSTOMER' } : {}),
          });
        }
      }
      const lastAt = Math.max(0, ...rest.map((m) => m.afterHours));
      if (k.state === 'RESOLVED' || k.state === 'CLOSED') {
        ctx.timeline.mark(ticket.id, at(lastAt + 1));
        await manager.post(`/support/tickets/${ticket.id}/status`, { status: 'RESOLVED', resolutionSummary: k.resolution ?? 'Resolved. (demo)' });
        if (k.rating) {
          ctx.timeline.mark(ticket.id, at(lastAt + 6));
          await rt.as(customer.portal!).post('/me/feedback', { ticketId: ticket.id, rating: k.rating.stars, ...(k.rating.comment ? { comment: k.rating.comment } : {}) });
          t.count('feedback');
        }
        if (k.state === 'CLOSED') {
          ctx.timeline.mark(ticket.id, at(lastAt + 30));
          await manager.post(`/support/tickets/${ticket.id}/status`, { status: 'CLOSED' });
        }
      }
      const final = await rt.as(desk).get(`/support/tickets/${ticket.id}`);
      if (final.status !== k.state) throw new Error(`${k.ref}: the ticket should be ${k.state} but is ${final.status}.`);
    }
  });
}

/** Questions the centre asked TypEase support, answered by the platform support agent. */
export async function runPlatformTickets(ctx: SeedContext, t: TenantState): Promise<void> {
  const list = t.fx.platformTickets ?? [];
  if (!list.length) return;
  const { rt } = ctx;
  await step(`${t.fx.name}: ${list.length} question(s) to TypEase support`, async () => {
    for (const p of list) {
      const opened = daysAgo(p.daysAgo);
      const pin = ctx.timeline.begin(ctx.timeline.office(opened));
      const ticket = await rt.as(t.owner).post('/support/platform-tickets', { subject: p.subject, message: p.message, ...(p.category ? { category: p.category } : {}), priority: p.priority ?? 'NORMAL' });
      pin(ticket.id);
      t.count('platformTickets');
      if (!p.reply) continue;
      ctx.timeline.mark(ticket.id, ctx.timeline.office(new Date(opened.getTime() + 3 * HOUR)));
      await rt.as(ctx.platformSupport).post(`/platform/support/tickets/${ticket.id}/messages`, { body: p.reply, visibility: 'CUSTOMER', ...(p.resolved ? { status: 'RESOLVED', resolutionSummary: 'Answered. (demo)' } : {}) });
    }
  });
}

/** Expiry reminders tracked by hand, next to the ones created automatically when a document with an expiry date is verified. */
export async function runReminders(ctx: SeedContext, t: TenantState): Promise<void> {
  const list = t.fx.reminders ?? [];
  if (!list.length) return;
  const owner = ctx.rt.as(t.owner);
  await step(`${t.fx.name}: ${list.length} expiry reminders tracked by hand`, async () => {
    for (const r of list) {
      const who = r.customer ? t.customer(r.customer) : null;
      const company = r.company ? t.company(r.company) : null;
      const label = r.subjectLabel ?? `${who?.person.fullName ?? company!.fx.companyName} - ${TYPE_NAMES[r.documentTypeKey] ?? r.documentTypeKey} (tracked by hand)`;
      const schedule = await owner.post('/reminders', {
        ...(who ? { customerId: who.id } : {}),
        ...(company ? { corporateAccountId: company.id } : {}),
        documentTypeKey: r.documentTypeKey,
        subjectLabel: label,
        expiryDate: isoDay(daysAgo(-r.expiresInDays)),
        ...(r.offsetsDays ? { offsetsDays: r.offsetsDays } : {}),
      });
      if (r.state === 'PAUSED') await owner.post(`/reminders/${schedule.id}/pause`);
      if (r.state === 'CANCELLED') await owner.post(`/reminders/${schedule.id}/cancel`, { reason: 'Customer renewed elsewhere. (demo)' });
      t.count('reminders');
    }
  });
}

/** Data subject requests: received, in review, approved (and blocked), rejected, completed with an export file. */
export async function runPrivacyRequests(ctx: SeedContext, t: TenantState): Promise<void> {
  const list = t.fx.privacyRequests ?? [];
  if (!list.length) return;
  const { rt } = ctx;
  const officer = rt.as(t.owner);
  await step(`${t.fx.name}: ${list.length} data subject request(s)`, async () => {
    const notes: string[] = [];
    for (const p of [...list].sort((a, b) => b.daysAgo - a.daysAgo)) {
      const customer = t.customer(p.customer);
      const received = daysAgo(p.daysAgo);
      const pin = ctx.timeline.begin(ctx.timeline.office(received));
      let row: any;
      if (p.via === 'PORTAL') {
        if (!customer.portal) throw new Error(`${t.slug}: customer ${p.customer} has no portal account to file a privacy request with.`);
        row = await rt.as(customer.portal).post('/privacy/my/requests', { type: p.type, ...(p.details ? { details: p.details } : {}) });
      } else {
        row = await officer.post('/privacy/requests', { customerId: customer.id, type: p.type, ...(p.details ? { details: p.details } : {}) });
      }
      pin(row.id);
      t.count('privacyRequests');
      if (p.outcome === 'RECEIVED') continue;
      const later = (days: number) => ctx.timeline.office(new Date(received.getTime() + Math.min(days, p.daysAgo * 0.8) * 86_400_000));
      ctx.timeline.mark(row.id, later(1));
      await officer.post(`/privacy/requests/${row.id}/review`);
      if (p.outcome === 'IN_REVIEW') continue;
      ctx.timeline.mark(row.id, later(2));
      await officer.post(`/privacy/requests/${row.id}/decision`, { decision: p.outcome === 'REJECTED' ? 'REJECTED' : 'APPROVED', decisionNote: p.note ?? 'Decided. (demo)' });
      if (p.outcome === 'REJECTED') continue;
      ctx.timeline.mark(row.id, later(3));
      if (p.outcome === 'COMPLETED') {
        await officer.post(`/privacy/requests/${row.id}/complete`, { note: p.note ?? 'Completed. (demo)' });
      } else if (p.type === 'DELETION') {
        // Approved, but the customer still has an open request: the erasure is refused and the reason is recorded.
        const refusal = await officer.expectRefusal('POST', `/privacy/requests/${row.id}/complete`, {}, { status: 409, code: 'ERASURE_BLOCKED' });
        notes.push(`erasure of ${customer.person.fullName} blocked as designed (${refusal.apiMessage})`);
      }
    }
    return notes;
  }, (n) => n.join('; ') || 'done');
}

/**
 * A short period in which the centre's own SMS gateway could not be reached, so
 * that the notification log shows genuine failures (with their retries) and a
 * later manual retry.
 *
 * The owner adds the gateway in Settings > Integrations and enables it; when the
 * listed requests are done it is switched off again and SMS goes back to the
 * platform default (the log driver during a seed). The gateway address is a
 * closed port on this machine (127.0.0.1:2): every attempt is refused at once
 * and nothing leaves the computer. The seed allows exactly that host for its
 * own process (OUTBOUND_WEBHOOK_ALLOWED_HOSTS, see cli/seed.ts).
 *
 * Without the integrations module there is no such endpoint: the record is then
 * written directly (documented exception), without credentials, which makes the
 * notifications module refuse to send through it.
 */
export const DEMO_SMS_GATEWAY_URL = 'https://127.0.0.1:2/demo-sms-gateway';

export class SmsOutage {
  private rowId: string | null = null;
  private pending: string[];
  private readonly viaApi: boolean;

  constructor(
    private readonly ctx: SeedContext,
    private readonly t: TenantState,
  ) {
    this.pending = [...(t.fx.smsOutage?.during ?? [])];
    this.viaApi = ctx.rt.hasModule('IntegrationsModule');
  }

  /** Call before every request scenario: switches the unreachable gateway on for the listed ones and off afterwards. */
  async before(ref: string): Promise<void> {
    const cfg = this.t.fx.smsOutage;
    if (!cfg) return;
    const { rt } = this.ctx;
    if (this.pending.includes(ref)) {
      if (!this.rowId) {
        this.announce();
        if (this.viaApi) {
          const owner = rt.as(this.t.owner);
          const gateway = await owner.post('/integrations', { category: 'SMS', provider: 'http', name: cfg.gatewayName, mode: 'TEST', config: { url: DEMO_SMS_GATEWAY_URL }, secrets: { token: 'demo-token-not-a-secret' } });
          await owner.post(`/integrations/${gateway.id}/enable`);
          this.rowId = gateway.id;
        } else {
          const row = await rt.sys.integration.create({ data: { tenantId: this.t.id, category: 'SMS', provider: 'http', name: cfg.gatewayName, status: 'ACTIVE', mode: 'TEST', config: { url: DEMO_SMS_GATEWAY_URL }, createdById: this.t.owner.userId } });
          this.rowId = row.id;
          this.ctx.noteDirectDb('integration_credentials_metadata: this installation runs without the integrations module, so the unreachable SMS gateway of the Al Noor demo (ACTIVE while four requests run, then DISABLED) was written directly.');
        }
      }
      this.pending = this.pending.filter((r) => r !== ref);
      return;
    }
    await this.end();
  }

  private announced = false;
  private announce(): void {
    if (this.announced) return;
    this.announced = true;
    console.log(`   ..  ${this.t.fx.name}: SMS gateway outage of the demo begins - the "failed for good" delivery warnings that follow are intended`);
  }

  async end(): Promise<void> {
    if (!this.rowId || this.pending.length) return;
    if (this.viaApi) await this.ctx.rt.as(this.t.owner).post(`/integrations/${this.rowId}/disable`);
    else await this.ctx.rt.sys.integration.update({ where: { id: this.rowId }, data: { status: 'DISABLED' } });
    this.rowId = null;
  }
}

/** Staff retry one failed message after the gateway problem is over ("failed notification is retried safely"). */
export async function retryOneFailedNotification(ctx: SeedContext, t: TenantState): Promise<void> {
  if (!t.fx.smsOutage) return;
  const { rt } = ctx;
  await step(`${t.fx.name}: failed SMS notifications, one retried`, async () => {
    const failures = await rt.as(t.owner).get('/notifications/failures', { query: { pageSize: 50 } });
    const total = failures.summary?.total ?? failures.data.length;
    if (!total) throw new Error('The SMS gateway outage produced no failed notification.');
    await rt.as(t.owner).post(`/notifications/${failures.data[0].id}/retry`);
    await rt.settle();
    const after = await rt.as(t.owner).get(`/notifications/${failures.data[0].id}`);
    if (after.status !== 'SENT') throw new Error(`The retried notification is ${after.status}, expected SENT.`);
    return total;
  }, (n) => `${n} failed, 1 of them sent on retry`);
}
