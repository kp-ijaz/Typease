import { Injectable, Logger } from '@nestjs/common';
import { runAsTenant } from './context';
import { SystemDb } from './db/prisma.service';

/**
 * Lets scheduled jobs fan out over tenants without touching the system
 * database themselves: the callback runs once per tenant, inside that tenant's
 * RLS-enforced context. One tenant failing never stops the others.
 */
@Injectable()
export class TenantDirectory {
  private readonly logger = new Logger(TenantDirectory.name);
  constructor(private readonly sys: SystemDb) {}

  /** Tenants where work can happen (not suspended / cancelled / archived). */
  async operationalIds(): Promise<string[]> {
    const rows = await this.sys.client.tenant.findMany({ where: { status: { in: ['ONBOARDING', 'PENDING_APPROVAL', 'TRIAL', 'ACTIVE', 'PAST_DUE'] } }, select: { id: true } });
    return rows.map((r) => r.id);
  }
  async allIds(): Promise<string[]> {
    return (await this.sys.client.tenant.findMany({ select: { id: true } })).map((r) => r.id);
  }

  async forEachTenant(label: string, fn: (tenantId: string) => Promise<void>, opts: { includeInactive?: boolean } = {}): Promise<{ ok: number; failed: number }> {
    const ids = opts.includeInactive ? await this.allIds() : await this.operationalIds();
    let ok = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await runAsTenant(id, () => fn(id), { actorLabel: `job:${label}` });
        ok += 1;
      } catch (e: any) {
        failed += 1;
        this.logger.error(`${label} failed for tenant ${id}: ${e?.message ?? e}`);
      }
    }
    return { ok, failed };
  }
}
