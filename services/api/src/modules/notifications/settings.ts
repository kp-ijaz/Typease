import { Tx } from '../../common/db/prisma.service';
import { Channel, eventDefinition } from './catalogue';

/** Stored in tenant.settings.notifications. */
export interface NotificationSettings {
  /** eventKey -> channel -> enabled. Missing entries follow the platform default for the event. */
  events: Record<string, Partial<Record<Channel, boolean>>>;
  /** Maximum messages per recipient, channel and hour. */
  rateLimitPerHour: number;
}
export const DEFAULT_RATE_LIMIT_PER_HOUR = 20;

export function parseSettings(raw: unknown): NotificationSettings {
  const value = (raw && typeof raw === 'object' ? (raw as any).notifications : null) ?? {};
  const limit = Number(value.rateLimitPerHour);
  return {
    events: value.events && typeof value.events === 'object' ? value.events : {},
    rateLimitPerHour: Number.isInteger(limit) && limit >= 1 && limit <= 200 ? limit : DEFAULT_RATE_LIMIT_PER_HOUR,
  };
}

/** Is this event switched on for this channel? An explicit centre choice wins over the platform default. */
export function channelEnabled(settings: NotificationSettings, eventKey: string, channel: Channel): boolean {
  const explicit = settings.events[eventKey]?.[channel];
  if (typeof explicit === 'boolean') return explicit;
  return eventDefinition(eventKey)?.defaultChannels.includes(channel) ?? false;
}

/**
 * Atomically replaces tenant.settings.notifications (jsonb_set), so a concurrent
 * change to another settings key by another module is never overwritten.
 * Timestamps are passed in from the application (never the database's now()),
 * like every other timestamp the ORM writes.
 */
export async function saveSettings(tx: Tx, tenantId: string, settings: NotificationSettings): Promise<void> {
  await tx.$executeRaw`
    UPDATE "tenants"
    SET "settings" = jsonb_set(COALESCE("settings", '{}'::jsonb), '{notifications}', ${JSON.stringify(settings)}::jsonb, true), "updatedAt" = ${new Date()}
    WHERE "id" = ${tenantId}::uuid`;
}

/**
 * Atomically replaces one top-level section of tenant.settings (e.g. "appointments", "queue").
 * Used by the operations modules for their own settings; other sections are untouched.
 */
export async function saveTenantSettingsSection(tx: Tx, tenantId: string, section: string, value: unknown): Promise<void> {
  if (!/^[a-z][A-Za-z]{1,30}$/.test(section)) throw new Error(`Invalid settings section "${section}".`);
  await tx.$executeRaw`
    UPDATE "tenants"
    SET "settings" = jsonb_set(COALESCE("settings", '{}'::jsonb), ARRAY[${section}]::text[], ${JSON.stringify(value)}::jsonb, true), "updatedAt" = ${new Date()}
    WHERE "id" = ${tenantId}::uuid`;
}
/** Reads tenant.settings with the row locked, so a read-modify-write of one section cannot interleave. */
export async function lockTenantSettings(tx: Tx, tenantId: string): Promise<Record<string, any>> {
  const rows = await tx.$queryRaw<Array<{ settings: unknown }>>`SELECT "settings" FROM "tenants" WHERE "id" = ${tenantId}::uuid FOR UPDATE`;
  return (rows[0]?.settings ?? {}) as Record<string, any>;
}
