import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { Prisma, SystemDb } from '../../common/db/prisma.service';
import { Errors } from '../../common/errors';
import { ALL_PROVIDER_CODES } from '../integrations/catalogue';
import { APPROVED_PROVIDERS_KEY, PlatformIntegrationsService } from '../integrations/platform-integrations.service';

export const SUPPORT_ACCESS_POLICY_KEY = 'supportAccess.policy';
export const OFFBOARDING_POLICY_KEY = 'offboarding.policy';
export const BILLING_POLICY_KEY = 'subscriptions.policy';

export interface SupportAccessPolicy {
  /** Longest access a centre can be asked for, in minutes (5..1440). */
  maxDurationMinutes: number;
  /** A request nobody answered expires after this many days. */
  pendingExpiryDays: number;
}
export interface OffboardingPolicy {
  /** Minimum days between scheduling an offboarding and the permanent deletion. Never below 30. */
  minPurgeDelayDays: number;
}

interface SettingDef {
  key: string;
  description: string;
  /** Used when nothing is stored. */
  defaultValue: unknown;
  schema: z.ZodTypeAny;
  usedBy: string;
}

/**
 * The ONLY platform settings that can be read or changed through the API.
 * `platform_settings` also holds internal rows (for example the subscription
 * invoice counter); anything that is not listed here is invisible and
 * read-only as far as the console is concerned.
 */
export const SETTINGS: SettingDef[] = [
  {
    key: BILLING_POLICY_KEY,
    description: 'Dunning policy and tax of TypEase subscription invoices.',
    defaultValue: { renewalLeadDays: 7, trialReminderDays: 3, retryDelaysDays: [1, 2], graceDays: 7, taxRatePercent: 0 },
    schema: z
      .object({
        renewalLeadDays: z.number().int().min(0).max(60),
        trialReminderDays: z.number().int().min(0).max(30),
        retryDelaysDays: z.array(z.number().min(0).max(30)).max(10),
        graceDays: z.number().int().min(0).max(90),
        taxRatePercent: z.number().min(0).max(100),
      })
      .partial()
      .strict(),
    usedBy: 'subscriptions',
  },
  {
    key: APPROVED_PROVIDERS_KEY,
    description: 'Integration providers centres may configure ("CATEGORY/provider"). null = every provider of the catalogue. Removing a provider switches its active integrations off in every centre.',
    defaultValue: null,
    schema: z.array(z.string().refine((code) => ALL_PROVIDER_CODES.includes(code), 'Not a provider of the integration catalogue')).max(100).nullable(),
    usedBy: 'integrations',
  },
  {
    key: SUPPORT_ACCESS_POLICY_KEY,
    description: 'Limits for time-limited support access to a centre.',
    defaultValue: { maxDurationMinutes: 1440, pendingExpiryDays: 7 } satisfies SupportAccessPolicy,
    schema: z.object({ maxDurationMinutes: z.number().int().min(5).max(1440), pendingExpiryDays: z.number().int().min(1).max(30) }).partial().strict(),
    usedBy: 'platform (support access)',
  },
  {
    key: OFFBOARDING_POLICY_KEY,
    description: 'How long a centre scheduled for offboarding is kept before its data is permanently deleted. The minimum can be raised, never lowered below 30 days.',
    defaultValue: { minPurgeDelayDays: 30 } satisfies OffboardingPolicy,
    schema: z.object({ minPurgeDelayDays: z.number().int().min(30).max(3650) }).strict(),
    usedBy: 'platform (offboarding)',
  },
];
const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

/** Key / value platform settings, restricted to the documented allow-list above. */
@Injectable()
export class PlatformSettingsService {
  constructor(
    private readonly sys: SystemDb,
    private readonly audit: AuditService,
    private readonly integrations: PlatformIntegrationsService,
  ) {}

  private def(key: string): SettingDef {
    const def = BY_KEY.get(key);
    // An unknown key and an internal key look the same from outside.
    if (!def) throw Errors.notFound('Setting');
    return def;
  }
  private view(def: SettingDef, row: { value: unknown; updatedAt: Date } | null | undefined) {
    return { key: def.key, description: def.description, usedBy: def.usedBy, value: row ? row.value : def.defaultValue, isDefault: !row, defaultValue: def.defaultValue, updatedAt: row?.updatedAt ?? null };
  }

  async list() {
    const rows = await this.sys.client.platformSetting.findMany({ where: { key: { in: SETTINGS.map((s) => s.key) } } });
    const stored = new Map(rows.map((r) => [r.key, r]));
    return SETTINGS.map((def) => this.view(def, stored.get(def.key)));
  }
  async get(key: string) {
    const def = this.def(key);
    return this.view(def, await this.sys.client.platformSetting.findUnique({ where: { key } }));
  }

  /** Stored value merged over the defaults (object settings), for use inside the platform module. */
  async value<T extends object>(key: string): Promise<T> {
    const def = this.def(key);
    const row = await this.sys.client.platformSetting.findUnique({ where: { key } });
    const parsed = row ? def.schema.safeParse(row.value) : null;
    return { ...(def.defaultValue as T), ...(parsed?.success ? (parsed.data as T) : {}) };
  }

  async set(key: string, value: unknown) {
    const def = this.def(key);
    const parsed = def.schema.safeParse(value);
    if (!parsed.success) {
      throw Errors.unprocessable('INVALID_SETTING', `The value for "${key}" is not valid.`, parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    }
    // This one has consequences in every centre, so it goes through the service that owns them.
    if (key === APPROVED_PROVIDERS_KEY) {
      await this.integrations.setApproved({ providers: parsed.data });
      return this.get(key);
    }
    const before = await this.sys.client.platformSetting.findUnique({ where: { key } });
    const row = await this.sys.client.platformSetting.upsert({ where: { key }, create: { key, value: parsed.data as Prisma.InputJsonValue }, update: { value: parsed.data as Prisma.InputJsonValue } });
    await this.audit.logSystem({ action: 'platform.setting_changed', resourceType: 'PlatformSetting', resourceId: key, summary: `Platform setting ${key} changed`, before: { value: before?.value ?? null }, after: { value: row.value } });
    return this.view(def, row);
  }

  /** Back to the default. */
  async reset(key: string) {
    const def = this.def(key);
    if (key === APPROVED_PROVIDERS_KEY) {
      await this.integrations.setApproved({ providers: null });
      return this.get(key);
    }
    const before = await this.sys.client.platformSetting.findUnique({ where: { key } });
    if (before) {
      await this.sys.client.platformSetting.delete({ where: { key } });
      await this.audit.logSystem({ action: 'platform.setting_reset', resourceType: 'PlatformSetting', resourceId: key, summary: `Platform setting ${key} reset to its default`, before: { value: before.value } });
    }
    return this.view(def, null);
  }
}
