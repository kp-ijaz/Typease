import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { encryptJson } from '../../common/crypto';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { JobQueue } from '../../common/jobs/job-queue';
import { UsageService } from '../../common/usage.service';
import { Channel, CHANNELS, EXTERNAL_CHANNELS, isSecurityEvent, Lang } from './catalogue';
import { CustomerFacts, decide, Decision, RecipientFacts, summarise, SuppressionReason } from './policy';
import { hasSecrets, maskSecrets, renderHtmlBody, renderSubject, renderText, TemplateData, variablesIn } from './render';
import { channelEnabled, parseSettings } from './settings';
import { EffectiveTemplate, effectiveTemplate, TemplateService } from './template.service';

export const DELIVER_JOB = 'notifications.deliver';
export const DELIVER_ATTEMPTS = 5;
export const DELIVER_BACKOFF_MS = 30_000;

export type Recipient =
  | { kind: 'CUSTOMER'; customerId: string }
  | { kind: 'USER'; userId: string }
  /** A bare address: a guest's phone, an invited person's email, a company contact without a portal account. */
  | { kind: 'ADDRESS'; channel: 'EMAIL' | 'SMS'; address: string; name?: string | null; language?: string | null; businessContact?: boolean };

/** The person behind a recipient, with everything needed to choose channels. */
export interface Target {
  kind: 'CUSTOMER' | 'USER' | 'ADDRESS';
  /** Stable key used in dedupe keys when a channel has no address. */
  key: string;
  customerId: string | null;
  name: string;
  language: Lang;
  email: string | null;
  phone: string | null;
  /** Number for WhatsApp when it differs from the phone number (customer contact of type WHATSAPP). */
  whatsapp?: string | null;
  /** Portal / staff accounts that receive in-app and push notifications. */
  userIds: string[];
  inactive: boolean;
  facts: RecipientFacts;
  /** ADDRESS recipients are reachable on exactly one channel. */
  onlyChannel?: Channel;
  /**
   * The application this person signs in to, so that links in a message open where they can actually
   * sign in: the customer portal, the corporate portal (company administrators, employees whose only
   * login is the company one, company contacts) or the centre application (staff).
   */
  portal: Portal;
}
export type Portal = 'customer' | 'corporate' | 'staff';

export interface NotifyInput {
  eventKey: string;
  /** Id of the domain event: makes the call idempotent (`<eventId>:<channel>:<recipient>`). Omit for direct sends. */
  eventId?: string | null;
  recipient: Recipient;
  /** Template variables. A function receives the resolved person, for values that depend on their language. */
  data: TemplateData | ((target: Target) => TemplateData);
  related?: { type: string; id: string } | null;
  /** Restrict to these channels (e.g. account-security messages name their channel). */
  channels?: Channel[];
  /** Send on the named channels even when the centre did not enable the event there (account security). */
  force?: boolean;
}
/** Event keys of messages a centre wrote itself (automation rules). They are not in the template catalogue. */
export const CUSTOM_EVENT = 'automation.message';
/** Promotional custom messages: the "marketing." prefix makes the marketing consent and opt-in mandatory. */
export const CUSTOM_MARKETING_EVENT = 'marketing.automation';

export interface CustomNotifyInput {
  /**
   * Stable id of this send (for an automation: execution id + action index). The same id never
   * produces a second notification for the same recipient and channel, however often it is retried.
   */
  dedupeId: string;
  recipient: Recipient;
  /** The channels the author chose. Channels the person cannot be reached on produce nothing or a SUPPRESSED row. */
  channels: Channel[];
  /** Subject template (email, in-app, push). `{{variables}}` are filled from `data`. */
  subject?: string | null;
  /** Body template: plain text with `{{variables}}` and `[Label]({{linkVariable}})` links. */
  body: string;
  data: TemplateData;
  /** MARKETING requires the customer's marketing consent and opt-in. Default: SERVICE (operational message). */
  purpose?: 'SERVICE' | 'MARKETING';
  /** Name of the WhatsApp Business template approved by Meta; without it a WhatsApp message is suppressed. */
  whatsappTemplateName?: string | null;
  related?: { type: string; id: string } | null;
}
interface CustomTemplate {
  subject: string | null;
  body: string;
  whatsappTemplateName: string | null;
}

export interface CreatedNotification {
  id: string;
  channel: Channel;
  status: 'QUEUED' | 'SENT' | 'SUPPRESSED';
  suppressedReason: SuppressionReason | null;
}

const lang = (value: string | null | undefined, fallback: string): Lang => (value === 'ar' || value === 'en' ? value : fallback === 'ar' ? 'ar' : 'en');
/** WhatsApp template parameters may not contain new lines, tabs or runs of spaces. */
const waParam = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 1000) || '-';

/**
 * Creates notifications. The only writer of the `notifications` table.
 *
 * For every enabled channel of an event it resolves the destination, applies
 * consent / preference / rate-limit / plan rules, renders the template in the
 * recipient's language and stores the result: QUEUED (a delivery job follows
 * after commit), SENT (in-app: stored only) or SUPPRESSED with a reason.
 * Nothing is ever dropped silently.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly db: TenantDb,
    private readonly jobs: JobQueue,
    private readonly usage: UsageService,
    private readonly templates: TemplateService,
  ) {}

  // ------------------------------------------------------------------ recipients
  async resolveTarget(tx: Tx, recipient: Recipient, tenantLanguage: string): Promise<Target | null> {
    const tenantId = this.db.tenantId;
    if (recipient.kind === 'ADDRESS') {
      return {
        kind: 'ADDRESS',
        key: recipient.address.toLowerCase(),
        customerId: null,
        name: recipient.name ?? '',
        language: lang(recipient.language, tenantLanguage),
        email: recipient.channel === 'EMAIL' ? recipient.address.toLowerCase() : null,
        phone: recipient.channel === 'SMS' ? recipient.address : null,
        userIds: [],
        inactive: false,
        facts: { kind: 'ADDRESS', businessContact: recipient.businessContact === true },
        onlyChannel: recipient.channel,
        portal: recipient.businessContact === true ? 'corporate' : 'customer',
      };
    }
    if (recipient.kind === 'USER') {
      const member = await tx.tenantMembership.findFirst({ where: { tenantId, userId: recipient.userId, status: 'ACTIVE' }, select: { id: true, kind: true } });
      if (!member) return null;
      const user = await tx.user.findFirst({ where: { id: recipient.userId }, select: { id: true, fullName: true, email: true, phone: true, preferredLanguage: true, status: true, deletedAt: true } });
      if (!user || user.status !== 'ACTIVE' || user.deletedAt) return null;
      const preferences = await tx.notificationPreference.findMany({ where: { tenantId, userId: user.id, customerId: null }, select: { channel: true, eventGroup: true, enabled: true } });
      return {
        kind: 'USER',
        key: `u:${user.id}`,
        customerId: null,
        name: user.fullName,
        language: lang(user.preferredLanguage, tenantLanguage),
        email: user.email,
        phone: user.phone,
        userIds: [user.id],
        inactive: false,
        facts: { kind: 'USER', preferences },
        portal: member.kind === 'CORPORATE' ? 'corporate' : member.kind === 'CUSTOMER' ? 'customer' : 'staff',
      };
    }
    let customer = await tx.customer.findFirst({ where: { id: recipient.customerId, tenantId } });
    // A merged record forwards to the surviving customer.
    if (customer?.status === 'MERGED' && customer.mergedIntoId) customer = await tx.customer.findFirst({ where: { id: customer.mergedIntoId, tenantId } });
    if (!customer) return null;
    const consents = await tx.customerConsent.findMany({ where: { tenantId, customerId: customer.id }, select: { purpose: true, status: true } });
    const preferences = await tx.notificationPreference.findMany({ where: { tenantId, customerId: customer.id }, select: { channel: true, eventGroup: true, enabled: true } });
    const members = await tx.tenantMembership.findMany({ where: { tenantId, customerId: customer.id, status: 'ACTIVE', kind: { in: ['CUSTOMER', 'CORPORATE'] } }, select: { userId: true, kind: true } });
    // Additional contact details kept by the customers module: used when the profile itself has none,
    // and for a WhatsApp number that differs from the phone number.
    const contacts = await tx.customerContact.findMany({ where: { tenantId, customerId: customer.id, type: { in: ['EMAIL', 'PHONE', 'WHATSAPP'] } }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }], select: { type: true, value: true } });
    const contact = (type: string) => contacts.find((c) => c.type === type)?.value ?? null;
    const language = lang(customer.preferredLanguage, tenantLanguage);
    const facts: CustomerFacts = {
      kind: 'CUSTOMER',
      communicationPrefs: (customer.communicationPrefs ?? {}) as Record<string, unknown>,
      marketingOptIn: customer.marketingOptIn,
      consents: Object.fromEntries(consents.map((c) => [c.purpose, c.status])),
      preferences,
    };
    return {
      kind: 'CUSTOMER',
      key: `c:${customer.id}`,
      customerId: customer.id,
      name: (language === 'ar' ? customer.fullNameAr : null) ?? customer.fullName,
      language,
      email: customer.email ?? contact('EMAIL'),
      phone: customer.phone ?? contact('PHONE'),
      whatsapp: contact('WHATSAPP'),
      userIds: [...new Set(members.map((m) => m.userId))],
      inactive: customer.status !== 'ACTIVE' || customer.deletedAt !== null,
      facts,
      // A person whose only login is the one their company gave them reads their messages in the corporate portal.
      portal: members.length > 0 && members.every((m) => m.kind === 'CORPORATE') ? 'corporate' : 'customer',
    };
  }

  /**
   * The administrators of a company who should hear about one of its requests: active portal logins of
   * that company whose role holds `permissionKey` (for instance `corp.requests.approve` for a quotation
   * that waits for approval). Each is addressed as a user, so their own notification preferences apply.
   */
  async corporateAdministrators(tx: Tx, corporateAccountId: string, permissionKey: string): Promise<Recipient[]> {
    const tenantId = this.db.tenantId;
    const members = await tx.tenantMembership.findMany({
      where: { tenantId, kind: 'CORPORATE', status: 'ACTIVE', corporateAccountId, role: { rolePermissions: { some: { permissionKey } } }, user: { status: 'ACTIVE', deletedAt: null } },
      select: { userId: true },
      orderBy: { createdAt: 'asc' },
    });
    return [...new Set(members.map((m) => m.userId))].map((userId) => ({ kind: 'USER' as const, userId }));
  }

  /** People who act for a company: portal members first, the billing address as a fallback. */
  async corporateRecipients(tx: Tx, corporateAccountId: string): Promise<Recipient[]> {
    const tenantId = this.db.tenantId;
    const account = await tx.corporateAccount.findFirst({ where: { id: corporateAccountId, tenantId }, select: { billingEmail: true, companyName: true } });
    if (!account) return [];
    const members = await tx.corporateMember.findMany({ where: { tenantId, corporateAccountId, status: { notIn: ['REMOVED', 'DISABLED', 'INACTIVE', 'SUSPENDED'] } }, select: { userId: true, email: true, fullName: true } });
    const out: Recipient[] = [];
    for (const m of members) {
      const active = m.userId ? await tx.tenantMembership.findFirst({ where: { tenantId, userId: m.userId, status: 'ACTIVE' }, select: { id: true } }) : null;
      if (m.userId && active) out.push({ kind: 'USER', userId: m.userId });
      else out.push({ kind: 'ADDRESS', channel: 'EMAIL', address: m.email, name: m.fullName, businessContact: true });
    }
    if (!out.length && account.billingEmail) out.push({ kind: 'ADDRESS', channel: 'EMAIL', address: account.billingEmail, name: account.companyName, businessContact: true });
    return out;
  }


  /**
   * Would this event reach the recipient on any enabled channel? Used by the
   * expiry-reminder scan to record SKIPPED_NO_CONSENT / SKIPPED_OPT_OUT.
   */
  async evaluate(tx: Tx, recipient: Recipient, eventKey: string): Promise<'ALLOWED' | 'NO_CONSENT' | 'OPT_OUT' | 'NO_RECIPIENT'> {
    const tenant = await tx.tenant.findFirstOrThrow({ where: { id: this.db.tenantId }, select: { settings: true, defaultLanguage: true } });
    const target = await this.resolveTarget(tx, recipient, tenant.defaultLanguage);
    if (!target || target.inactive) return 'NO_RECIPIENT';
    const settings = parseSettings(tenant.settings);
    const decisions: Decision[] = [];
    for (const channel of CHANNELS) {
      if (target.onlyChannel && target.onlyChannel !== channel) continue;
      if (!channelEnabled(settings, eventKey, channel)) continue;
      if ((channel === 'IN_APP' || channel === 'PUSH') && !target.userIds.length) continue;
      if (channel === 'EMAIL' && !target.email) continue;
      if (channel === 'SMS' && !target.phone) continue;
      if (channel === 'WHATSAPP' && !target.whatsapp && !target.phone) continue;
      decisions.push(decide(eventKey, channel, target.facts));
    }
    if (!decisions.length) return 'NO_RECIPIENT';
    return summarise(decisions);
  }

  // ------------------------------------------------------------------ creation
  async notify(input: NotifyInput): Promise<CreatedNotification[]> {
    return this.create(input, null);
  }

  /**
   * A message whose wording was written by the centre (automation rules) instead of
   * coming from a catalogue template. It takes exactly the same road as every other
   * notification - recipient resolution, consent, opt-out, rate limit, plan limit,
   * delivery job, delivery log - with these differences only:
   *   - the channels are the ones named by the author (there is no per-event channel switch for it);
   *   - it can never be an account-security message, so nothing here bypasses preferences;
   *   - `dedupeId` makes a retried send a no-op.
   */
  async sendCustom(input: CustomNotifyInput): Promise<CreatedNotification[]> {
    const body = input.body?.trim();
    if (!body) throw new Error('sendCustom: the message body is empty.');
    if (!input.dedupeId) throw new Error('sendCustom: a dedupe id is required.');
    const channels = [...new Set(input.channels)].filter((c) => CHANNELS.includes(c));
    if (!channels.length) return [];
    return this.create(
      { eventKey: input.purpose === 'MARKETING' ? CUSTOM_MARKETING_EVENT : CUSTOM_EVENT, eventId: input.dedupeId, recipient: input.recipient, data: input.data, related: input.related ?? null, channels, force: true },
      { subject: input.subject?.trim() || null, body, whatsappTemplateName: input.whatsappTemplateName?.trim() || null },
    );
  }

  private async create(input: NotifyInput, custom: CustomTemplate | null): Promise<CreatedNotification[]> {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const tenant = await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { settings: true, defaultLanguage: true } });
      const target = await this.resolveTarget(tx, input.recipient, tenant.defaultLanguage);
      if (!target) {
        this.logger.warn(`${input.eventKey}: recipient not found, nothing to notify.`);
        return [];
      }
      const settings = parseSettings(tenant.settings);
      const rows = custom ? [] : await this.templates.rowsFor(tx, input.eventKey);
      const brand = await this.templates.brand(tenantId, target.language);
      const data: TemplateData = { ...(typeof input.data === 'function' ? input.data(target) : input.data), ...this.templates.commonData(brand) };
      const security = isSecurityEvent(input.eventKey);
      const created: CreatedNotification[] = [];
      let devicesByUser: Map<string, number> | undefined;
      let plan: { limit: number; used: number } | undefined;

      for (const channel of CHANNELS) {
        if (input.channels && !input.channels.includes(channel)) continue;
        if (target.onlyChannel && target.onlyChannel !== channel) continue;
        if (!input.force && !channelEnabled(settings, input.eventKey, channel)) continue;
        const template: EffectiveTemplate | null = custom
          ? { id: 'custom', source: 'TENANT', channel, language: target.language, subject: channel === 'SMS' || channel === 'WHATSAPP' ? null : custom.subject, body: custom.body, whatsappTemplateName: channel === 'WHATSAPP' ? custom.whatsappTemplateName : null }
          : effectiveTemplate(rows, input.eventKey, channel, target.language);
        if (!template) continue;

        // Where does this channel go for this person?
        let destinations: Array<{ key: string; address: string | null; userId: string | null }>;
        if (channel === 'IN_APP') destinations = target.userIds.map((userId) => ({ key: userId, address: null, userId }));
        else if (channel === 'PUSH') {
          if (!devicesByUser && target.userIds.length) {
            const tokens = await tx.deviceToken.groupBy({ by: ['userId'], where: { tenantId, userId: { in: target.userIds } }, _count: { _all: true } });
            devicesByUser = new Map(tokens.map((t) => [t.userId, t._count._all]));
          }
          destinations = target.userIds.filter((u) => (devicesByUser?.get(u) ?? 0) > 0).map((userId) => ({ key: userId, address: null, userId }));
        } else {
          const address = channel === 'EMAIL' ? target.email : channel === 'WHATSAPP' ? (target.whatsapp ?? target.phone) : target.phone;
          destinations = [{ key: address ? address.toLowerCase() : target.key, address: address ?? null, userId: null }];
        }

        for (const dest of destinations) {
          const dedupeKey = input.eventId ? `${input.eventId}:${channel}:${dest.key}` : null;
          if (dedupeKey && (await tx.notification.findFirst({ where: { tenantId, dedupeKey }, select: { id: true } }))) continue;

          // ---- may we send?
          let reason: SuppressionReason | null = null;
          if (target.inactive && !security) reason = 'CUSTOMER_INACTIVE';
          else if (channel !== 'IN_APP' && channel !== 'PUSH' && !dest.address) reason = 'NO_ADDRESS';
          else {
            const decision = decide(input.eventKey, channel, target.facts);
            if (!decision.allowed) reason = decision.reason;
          }
          if (!reason && channel === 'WHATSAPP' && !template.whatsappTemplateName) reason = 'WHATSAPP_TEMPLATE_REQUIRED';
          if (!reason && EXTERNAL_CHANNELS.includes(channel)) {
            const since = new Date(Date.now() - 3600_000);
            const recent = await tx.notification.count({
              where: { tenantId, channel, createdAt: { gt: since }, status: { not: 'SUPPRESSED' }, ...(dest.userId ? { recipientUserId: dest.userId } : { recipientAddress: dest.address }) },
            });
            if (recent >= settings.rateLimitPerHour) reason = 'RATE_LIMITED';
          }
          if (!reason && EXTERNAL_CHANNELS.includes(channel) && !security) {
            if (!plan) plan = { limit: (await this.usage.plan(tx)).limits.notifications, used: await this.usage.current('notifications', tx) };
            if (plan.limit !== -1 && plan.limit !== undefined && plan.used + 1 > plan.limit) reason = 'PLAN_LIMIT';
          }

          // ---- render
          const secret = security && hasSecrets(data);
          const visible = secret ? maskSecrets(data) : data;
          const subject = template.subject ? renderSubject(template.subject, visible) : null;
          const body = renderText(template.body, visible);
          const stored: Record<string, any> = { templateId: template.id, templateSource: template.source };
          const full: Record<string, any> = {};
          if (channel === 'EMAIL') full.html = renderHtmlBody(template.body, data, brand.colors.secondary);
          if (channel === 'WHATSAPP' && template.whatsappTemplateName) full.wa = { templateName: template.whatsappTemplateName, parameters: variablesIn(template.body).map((v) => waParam(data[v])) };
          if (channel === 'PUSH' && input.related) stored.push = { eventKey: input.eventKey, relatedType: input.related.type, relatedId: input.related.id };
          if (secret) {
            // Links and codes never rest in clear text: the complete rendering is encrypted until it has been sent.
            if (!reason) stored.secure = encryptJson({ subject: template.subject ? renderSubject(template.subject, data) : null, text: renderText(template.body, data), ...full });
          } else Object.assign(stored, full);

          const status = reason ? 'SUPPRESSED' : channel === 'IN_APP' ? 'SENT' : 'QUEUED';
          const id = randomUUID();
          const inserted = await tx.notification.createMany({
            data: [
              {
                id,
                tenantId,
                recipientUserId: dest.userId,
                recipientCustomerId: target.customerId,
                recipientAddress: dest.address,
                eventKey: input.eventKey,
                channel,
                language: template.language,
                subject,
                body,
                data: stored,
                status,
                suppressedReason: reason,
                relatedType: input.related?.type ?? null,
                relatedId: input.related?.id ?? null,
                dedupeKey,
                sentAt: status === 'SENT' ? new Date() : null,
              },
            ],
            skipDuplicates: true,
          });
          if (!inserted.count) continue; // another delivery of the same event got there first
          created.push({ id, channel, status, suppressedReason: reason });
          if (status === 'QUEUED') {
            await this.usage.record('notifications', 1, tx);
            if (plan) plan.used += 1;
            this.db.afterCommit(() => this.jobs.enqueue(DELIVER_JOB, { tenantId, notificationId: id }, { jobId: `notif-${id}` }));
          }
        }
      }
      return created;
    });
  }
}
