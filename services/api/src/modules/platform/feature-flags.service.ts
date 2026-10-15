import { Injectable } from '@nestjs/common';
import type { FeatureFlagInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { tryCtx } from '../../common/context';
import { Prisma, SystemDb, TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { auditForCentre } from './platform.util';

type FlagRow = { key: string; tenantId: string | null; enabled: boolean; payload: unknown };

/** Pure resolution rule: the centre's own row wins over the global default; no row at all means "off". */
export function resolveFlag(rows: FlagRow[], key: string, tenantId: string | null | undefined): { enabled: boolean; source: 'TENANT' | 'GLOBAL' | 'NONE'; payload: Record<string, unknown> } {
  const own = tenantId ? rows.find((r) => r.key === key && r.tenantId === tenantId) : undefined;
  if (own) return { enabled: own.enabled, source: 'TENANT', payload: (own.payload ?? {}) as Record<string, unknown> };
  const global = rows.find((r) => r.key === key && r.tenantId === null);
  if (global) return { enabled: global.enabled, source: 'GLOBAL', payload: (global.payload ?? {}) as Record<string, unknown> };
  return { enabled: false, source: 'NONE', payload: {} };
}

/**
 * Feature flags for the CURRENT centre. Inject this in any module:
 *
 *     if (await this.flags.isEnabled('new_quotation_editor')) { ... }
 *
 * Resolution: the centre's own row > the global default > false. It reads on
 * the tenant-scoped connection (a centre can read its own rows and the global
 * defaults, nothing else). Outside a tenant context only the global default
 * applies.
 */
@Injectable()
export class FeatureFlags {
  constructor(
    private readonly db: TenantDb,
    private readonly sys: SystemDb,
  ) {}

  private async rows(keys: string[] | null, tx?: Tx): Promise<{ rows: FlagRow[]; tenantId: string | null }> {
    const tenantId = tryCtx()?.tenantId ?? null;
    const select = { key: true, tenantId: true, enabled: true, payload: true } as const;
    if (!tenantId) {
      return { rows: await this.sys.client.featureFlag.findMany({ where: { tenantId: null, ...(keys ? { key: { in: keys } } : {}) }, select }), tenantId };
    }
    const where: Prisma.FeatureFlagWhereInput = { OR: [{ tenantId }, { tenantId: null }], ...(keys ? { key: { in: keys } } : {}) };
    const load = (t: Tx) => t.featureFlag.findMany({ where, select });
    return { rows: tx ? await load(tx) : await this.db.tx(load), tenantId };
  }

  async isEnabled(key: string, tx?: Tx): Promise<boolean> {
    const { rows, tenantId } = await this.rows([key], tx);
    return resolveFlag(rows, key, tenantId).enabled;
  }
  /** Settings that travel with a flag (empty object when the flag does not exist). */
  async payload(key: string, tx?: Tx): Promise<Record<string, unknown>> {
    const { rows, tenantId } = await this.rows([key], tx);
    return resolveFlag(rows, key, tenantId).payload;
  }
  /** Every known flag as it applies to the current centre: `{ key: boolean }`. */
  async all(tx?: Tx): Promise<Record<string, boolean>> {
    const { rows, tenantId } = await this.rows(null, tx);
    const out: Record<string, boolean> = {};
    for (const key of [...new Set(rows.map((r) => r.key))].sort()) out[key] = resolveFlag(rows, key, tenantId).enabled;
    return out;
  }
}

/** Platform console: global defaults and per-centre overrides. */
@Injectable()
export class FeatureFlagAdminService {
  constructor(
    private readonly sys: SystemDb,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const rows = await this.sys.client.featureFlag.findMany({ orderBy: [{ key: 'asc' }] });
    const keys = [...new Set(rows.map((r) => r.key))];
    return keys.map((key) => {
      const global = rows.find((r) => r.key === key && r.tenantId === null);
      const overrides = rows.filter((r) => r.key === key && r.tenantId !== null);
      return {
        key,
        /** The default for every centre without an override. No global row means "off". */
        enabled: global?.enabled ?? false,
        hasGlobalDefault: !!global,
        payload: global?.payload ?? {},
        updatedAt: global?.updatedAt ?? null,
        overrides: { total: overrides.length, enabled: overrides.filter((o) => o.enabled).length, disabled: overrides.filter((o) => !o.enabled).length },
      };
    });
  }

  /** The unique index treats NULL tenants as equal, but Prisma cannot upsert on a NULL key part. */
  private async upsert(key: string, tenantId: string | null, input: FeatureFlagInput) {
    return this.sys.tx(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`feature-flag:${key}:${tenantId ?? 'global'}`}, 0))::text AS locked`;
      const existing = await tx.featureFlag.findFirst({ where: { key, tenantId } });
      const payload = (input.payload ?? existing?.payload ?? {}) as Prisma.InputJsonValue;
      const row = existing ? await tx.featureFlag.update({ where: { id: existing.id }, data: { enabled: input.enabled, payload } }) : await tx.featureFlag.create({ data: { key, tenantId, enabled: input.enabled, payload } });
      return { existing, row };
    });
  }

  async setGlobal(key: string, input: FeatureFlagInput) {
    const { existing, row } = await this.upsert(key, null, input);
    await this.audit.logSystem({ action: existing ? 'platform.feature_flag_changed' : 'platform.feature_flag_created', resourceType: 'FeatureFlag', resourceId: key, summary: `Feature "${key}" is now ${row.enabled ? 'ON' : 'OFF'} by default`, before: existing ? { enabled: existing.enabled, payload: existing.payload } : undefined, after: { enabled: row.enabled, payload: row.payload } });
    return (await this.list()).find((f) => f.key === key)!;
  }

  /** Removes a flag completely: the global default and every override. Code that asks for it gets "off". */
  async remove(key: string) {
    const rows = await this.sys.client.featureFlag.findMany({ where: { key } });
    if (!rows.length) throw Errors.notFound('Feature flag');
    await this.sys.client.featureFlag.deleteMany({ where: { key } });
    await this.audit.logSystem({ action: 'platform.feature_flag_deleted', resourceType: 'FeatureFlag', resourceId: key, summary: `Feature "${key}" removed (default and ${rows.filter((r) => r.tenantId).length} overrides)`, before: { enabled: rows.find((r) => !r.tenantId)?.enabled ?? null, overrides: rows.filter((r) => r.tenantId).length } });
    return { status: 'DELETED' as const };
  }

  async overrides(key: string) {
    const rows = await this.sys.client.featureFlag.findMany({ where: { key, tenantId: { not: null } }, orderBy: { updatedAt: 'desc' }, include: { tenant: { select: { id: true, name: true, slug: true, status: true } } } });
    return rows.map((r) => ({ centre: r.tenant, enabled: r.enabled, payload: r.payload, updatedAt: r.updatedAt }));
  }

  private async centre(tenantId: string) {
    return found(await this.sys.client.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true, slug: true } }), 'Centre');
  }

  /** All flags as they apply to one centre, with where each value comes from. */
  async forCentre(tenantId: string) {
    await this.centre(tenantId);
    const rows = await this.sys.client.featureFlag.findMany({ where: { OR: [{ tenantId }, { tenantId: null }] }, select: { key: true, tenantId: true, enabled: true, payload: true } });
    return [...new Set(rows.map((r) => r.key))].sort().map((key) => {
      const resolved = resolveFlag(rows, key, tenantId);
      return { key, enabled: resolved.enabled, source: resolved.source, globalDefault: rows.find((r) => r.key === key && r.tenantId === null)?.enabled ?? false, payload: resolved.payload };
    });
  }

  async setOverride(tenantId: string, key: string, input: FeatureFlagInput) {
    const centre = await this.centre(tenantId);
    const { existing, row } = await this.upsert(key, tenantId, input);
    await auditForCentre(this.audit, { action: 'platform.feature_override_set', resourceType: 'FeatureFlag', resourceId: key, summary: `Feature "${key}" switched ${row.enabled ? 'ON' : 'OFF'} for this centre by TypEase`, before: existing ? { enabled: existing.enabled } : undefined, after: { enabled: row.enabled } }, centre);
    return (await this.forCentre(tenantId)).find((f) => f.key === key)!;
  }

  async clearOverride(tenantId: string, key: string) {
    const centre = await this.centre(tenantId);
    const existing = await this.sys.client.featureFlag.findFirst({ where: { key, tenantId } });
    if (!existing) throw Errors.notFound('Override');
    await this.sys.client.featureFlag.delete({ where: { id: existing.id } });
    await auditForCentre(this.audit, { action: 'platform.feature_override_removed', resourceType: 'FeatureFlag', resourceId: key, summary: `Feature "${key}" follows the platform default again`, before: { enabled: existing.enabled } }, centre);
    const now = (await this.forCentre(tenantId)).find((f) => f.key === key);
    return now ?? { key, enabled: false, source: 'NONE' as const, globalDefault: false, payload: {} };
  }
}
