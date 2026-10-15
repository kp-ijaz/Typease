import { Injectable } from '@nestjs/common';
import type { PublicTenantConfig } from '@typease/types';
import type { TemplateOverrideInput, TemplatePreviewInput } from '@typease/validation';
import { env } from '../../config/env';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { BrandingService, TYPEASE_COLORS } from '../tenancy/branding.service';
import { allowedVariables, Channel, CHANNELS, COMMON_VARIABLES, defaultTemplateRows, EVENT_DEFINITIONS, eventDefinition, Lang, LANGS, sampleData, SUPERSEDED_DEFAULTS, templateName } from './catalogue';
import { EmailBrand, emailLayout, renderHtmlBody, renderSubject, renderText, TemplateData, variablesIn } from './render';
import { channelEnabled, parseSettings } from './settings';

export interface TemplateRow {
  id: string;
  tenantId: string | null;
  eventKey: string;
  channel: Channel;
  language: string;
  name: string;
  subject: string | null;
  body: string;
  whatsappTemplateName: string | null;
  isActive: boolean;
}
export interface EffectiveTemplate {
  id: string;
  source: 'TENANT' | 'DEFAULT';
  channel: Channel;
  language: string;
  subject: string | null;
  body: string;
  whatsappTemplateName: string | null;
}

/**
 * Picks the template for one channel and language from all rows of an event
 * (tenant overrides and platform defaults).
 *
 *   wanted language:  tenant override -> platform default
 *   then English:     tenant override -> platform default
 *
 * The right language matters more than the centre's wording, so a centre that
 * only rewrote the English text still sends the Arabic default to an Arabic
 * reader. PUSH falls back to the IN_APP template.
 */
export function pickTemplate(rows: TemplateRow[], channel: Channel, language: string): EffectiveTemplate | null {
  const active = rows.filter((r) => r.isActive);
  const languages = language === 'en' ? ['en'] : [language, 'en'];
  const channels: Channel[] = channel === 'PUSH' ? ['PUSH', 'IN_APP'] : [channel];
  for (const ch of channels) {
    for (const lang of languages) {
      const row = active.find((r) => r.channel === ch && r.language === lang && r.tenantId !== null) ?? active.find((r) => r.channel === ch && r.language === lang && r.tenantId === null);
      if (row) return { id: row.id, source: row.tenantId ? 'TENANT' : 'DEFAULT', channel, language: row.language, subject: row.subject, body: row.body, whatsappTemplateName: row.whatsappTemplateName };
    }
  }
  return null;
}

/**
 * Like `pickTemplate`, but falls back to the built-in default when the database holds no platform row at all
 * for the event and channel (the platform bootstrap has not run yet). A message - above all an account-security
 * one - must never vanish because seeding is pending. A default that platform staff deactivated stays off.
 */
export function effectiveTemplate(rows: TemplateRow[], eventKey: string, channel: Channel, language: string): EffectiveTemplate | null {
  const picked = pickTemplate(rows, channel, language);
  if (picked) return picked;
  const lookup: Channel[] = channel === 'PUSH' ? ['PUSH', 'IN_APP'] : [channel];
  if (rows.some((r) => r.tenantId === null && lookup.includes(r.channel))) return null;
  const builtIn: TemplateRow[] = defaultTemplateRows()
    .filter((r) => r.eventKey === eventKey)
    .map((r) => ({ ...r, id: `builtin:${r.eventKey}:${r.channel}:${r.language}`, tenantId: null, whatsappTemplateName: null, isActive: true }));
  return pickTemplate(builtIn, channel, language);
}

/** Colours, name and contact of the centre for the email frame. */
export function brandOf(config: PublicTenantConfig | null, fallbackName = 'TypEase', language = 'en'): EmailBrand {
  if (!config) return { name: fallbackName, colors: TYPEASE_COLORS, logoUrl: null, supportEmail: null, supportPhone: null, showPlatformCredit: false };
  return {
    name: (language === 'ar' ? config.nameAr : null) ?? config.name,
    colors: config.colors,
    logoUrl: config.logoUrl,
    supportEmail: config.supportEmail,
    supportPhone: config.supportPhone,
    showPlatformCredit: config.mode !== 'WHITE_LABEL',
  };
}

@Injectable()
export class TemplateService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly branding: BrandingService,
  ) {}

  /** Inserts missing platform defaults. Rows that exist (possibly edited by platform staff) are never overwritten. */
  async seedDefaults(tx: Tx): Promise<number> {
    const existing = await tx.notificationTemplate.findMany({ where: { tenantId: null }, select: { eventKey: true, channel: true, language: true } });
    const have = new Set(existing.map((r) => `${r.eventKey}|${r.channel}|${r.language}`));
    const missing = defaultTemplateRows().filter((r) => !have.has(`${r.eventKey}|${r.channel}|${r.language}`));
    if (missing.length) await tx.notificationTemplate.createMany({ data: missing.map((r) => ({ ...r, tenantId: null })), skipDuplicates: true });
    // A stored default that still carries a superseded built-in wording was never edited: bring it up to date.
    let corrected = 0;
    for (const old of SUPERSEDED_DEFAULTS) {
      const current = defaultTemplateRows().find((r) => r.eventKey === old.eventKey && r.channel === old.channel && r.language === old.language);
      if (!current) continue;
      const updated = await tx.notificationTemplate.updateMany({
        where: { tenantId: null, eventKey: old.eventKey, channel: old.channel, language: old.language, body: old.body, subject: old.subject },
        data: { subject: current.subject, body: current.body },
      });
      corrected += updated.count;
    }
    return missing.length + corrected;
  }

  /** All rows of an event visible to the current tenant (own overrides + platform defaults, via row-level security). */
  async rowsFor(tx: Tx, eventKey: string): Promise<TemplateRow[]> {
    return (await tx.notificationTemplate.findMany({ where: { eventKey, OR: [{ tenantId: this.db.tenantId }, { tenantId: null }] } })) as TemplateRow[];
  }
  /**
   * Platform defaults when there is no tenant (platform-staff password reset ...).
   * Uses the tenant-restricted connection outside a tenant transaction: row-level
   * security then exposes only the shared rows (tenantId IS NULL).
   */
  async platformRows(eventKey: string): Promise<TemplateRow[]> {
    return (await this.db.client.notificationTemplate.findMany({ where: { eventKey, tenantId: null } })) as TemplateRow[];
  }

  async brand(tenantId: string, language = 'en'): Promise<EmailBrand> {
    try {
      return brandOf(await this.branding.publicConfig(tenantId), 'TypEase', language);
    } catch {
      return brandOf(null);
    }
  }
  /** Variables every template can rely on. */
  commonData(brand: EmailBrand): TemplateData {
    return { centreName: brand.name, supportEmail: brand.supportEmail ?? '', supportPhone: brand.supportPhone ?? '' };
  }

  // ------------------------------------------------------------------ editor API
  /** Catalogue of events with their variables: what the template editor offers. */
  events() {
    return EVENT_DEFINITIONS.map((d) => ({
      eventKey: d.key,
      label: d.label,
      group: d.group,
      audience: d.audience,
      bypassesPreferences: d.group === 'security',
      requiredConsent: d.consent ?? null,
      defaultChannels: d.defaultChannels,
      variables: Object.entries({ ...d.variables, ...COMMON_VARIABLES }).map(([name, description]) => ({ name, description })),
    }));
  }

  /** Effective templates: the tenant override when there is one, else the platform default. */
  async list(filter: { eventKey?: string; channel?: Channel; language?: string }) {
    return this.db.tx(async (tx) => {
      const tenant = await tx.tenant.findFirstOrThrow({ where: { id: this.db.tenantId }, select: { settings: true } });
      const settings = parseSettings(tenant.settings);
      const rows = (await tx.notificationTemplate.findMany({
        where: { OR: [{ tenantId: this.db.tenantId }, { tenantId: null }], ...(filter.eventKey ? { eventKey: filter.eventKey } : {}), ...(filter.channel ? { channel: filter.channel } : {}), ...(filter.language ? { language: filter.language } : {}) },
      })) as TemplateRow[];
      const keys = new Map<string, { eventKey: string; channel: Channel; language: string }>();
      for (const r of rows) keys.set(`${r.eventKey}|${r.channel}|${r.language}`, { eventKey: r.eventKey, channel: r.channel, language: r.language });
      const order = new Map(EVENT_DEFINITIONS.map((d, i) => [d.key as string, i]));
      return [...keys.values()]
        .sort((a, b) => (order.get(a.eventKey) ?? 999) - (order.get(b.eventKey) ?? 999) || CHANNELS.indexOf(a.channel) - CHANNELS.indexOf(b.channel) || a.language.localeCompare(b.language))
        .map((k) => {
          const same = rows.filter((r) => r.eventKey === k.eventKey && r.channel === k.channel && r.language === k.language);
          const override = same.find((r) => r.tenantId !== null);
          const base = same.find((r) => r.tenantId === null);
          const effective = override ?? base!;
          const def = eventDefinition(k.eventKey);
          return {
            eventKey: k.eventKey,
            label: def?.label ?? k.eventKey,
            group: def?.group ?? null,
            channel: k.channel,
            language: k.language,
            source: override ? ('TENANT' as const) : ('DEFAULT' as const),
            name: effective.name,
            subject: effective.subject,
            body: effective.body,
            whatsappTemplateName: effective.whatsappTemplateName,
            enabled: channelEnabled(settings, k.eventKey, k.channel),
            default: base ? { subject: base.subject, body: base.body } : null,
            variables: allowedVariables(k.eventKey),
          };
        });
    });
  }

  private assertKnown(eventKey: string) {
    if (!eventDefinition(eventKey)) throw Errors.unprocessable('UNKNOWN_EVENT', 'That notification event does not exist. Choose one from the list of events.');
  }

  /** Create or update the centre's own wording for one event / channel / language. */
  async saveOverride(eventKey: string, channel: Channel, language: Lang, input: TemplateOverrideInput) {
    this.assertKnown(eventKey);
    if (channel === 'EMAIL' && !input.subject) throw Errors.unprocessable('SUBJECT_REQUIRED', 'Email templates need a subject line.');
    const unknownVariables = [...new Set([...variablesIn(input.subject), ...variablesIn(input.body)])].filter((v) => !allowedVariables(eventKey).includes(v));
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const before = await tx.notificationTemplate.findFirst({ where: { tenantId, eventKey, channel, language } });
      const data = {
        name: input.name ?? before?.name ?? templateName(eventKey, channel, language),
        subject: channel === 'SMS' || channel === 'WHATSAPP' ? null : (input.subject ?? null),
        body: input.body,
        whatsappTemplateName: channel === 'WHATSAPP' ? (input.whatsappTemplateName ?? null) : null,
        isActive: true,
        updatedById: ctx().userId ?? null,
      };
      const row = before ? await tx.notificationTemplate.update({ where: { id: before.id }, data }) : await tx.notificationTemplate.create({ data: { ...data, tenantId, eventKey, channel, language } });
      await this.audit.log(
        {
          action: before ? 'notification_template.updated' : 'notification_template.created',
          resourceType: 'NotificationTemplate',
          resourceId: row.id,
          summary: `${eventKey} / ${channel} / ${language}`,
          before: before ? { subject: before.subject, body: before.body, whatsappTemplateName: before.whatsappTemplateName } : undefined,
          after: { subject: data.subject, body: data.body, whatsappTemplateName: data.whatsappTemplateName },
        },
        tx,
      );
      return { ...row, source: 'TENANT' as const, unknownVariables };
    });
  }

  /** Remove the centre's override: the platform default applies again. */
  async resetOverride(eventKey: string, channel: Channel, language: Lang) {
    return this.db.tx(async (tx) => {
      const row = found(await tx.notificationTemplate.findFirst({ where: { tenantId: this.db.tenantId, eventKey, channel, language } }), 'Template override');
      await tx.notificationTemplate.delete({ where: { id: row.id } });
      await this.audit.log({ action: 'notification_template.reset', resourceType: 'NotificationTemplate', resourceId: row.id, summary: `${eventKey} / ${channel} / ${language}`, before: { subject: row.subject, body: row.body } }, tx);
      const base = await tx.notificationTemplate.findFirst({ where: { tenantId: null, eventKey, channel, language } });
      return { eventKey, channel, language, source: 'DEFAULT' as const, subject: base?.subject ?? null, body: base?.body ?? null };
    });
  }

  /** Render a draft (or the effective template) with sample data. Nothing is sent or stored. */
  async preview(input: TemplatePreviewInput) {
    this.assertKnown(input.eventKey);
    const tenantId = this.db.tenantId;
    const effective = await this.db.tx(async (tx) => pickTemplate(await this.rowsFor(tx, input.eventKey), input.channel, input.language));
    const body = input.body ?? effective?.body;
    if (body === undefined || body === null) throw Errors.notFound('Template');
    const subjectTemplate = input.subject ?? effective?.subject ?? null;
    const brand = await this.brand(tenantId, input.language);
    const data: TemplateData = { ...sampleData(input.eventKey), ...this.commonData(brand), ...(input.data ?? {}) };
    const subject = subjectTemplate ? renderSubject(subjectTemplate, data) : null;
    const text = renderText(body, data);
    const used = [...new Set([...variablesIn(subjectTemplate), ...variablesIn(body)])];
    return {
      eventKey: input.eventKey,
      channel: input.channel,
      language: input.language,
      subject,
      text,
      html: input.channel === 'EMAIL' ? emailLayout({ innerHtml: renderHtmlBody(body, data, brand.colors.secondary), subject: subject ?? '', language: input.language, brand }) : null,
      whatsappParameters: input.channel === 'WHATSAPP' ? variablesIn(body).map((v) => ({ name: v, value: String(data[v] ?? '') })) : null,
      unknownVariables: used.filter((v) => !allowedVariables(input.eventKey).includes(v)),
      sampleData: data,
    };
  }
}

export const LANGUAGES = LANGS;
export const centreAppUrl = (path: string) => `${env().CENTRE_WEB_URL}${path}`;
