import { Injectable } from '@nestjs/common';
import type { PlanLimitKey, PlanLimits } from '@typease/types';
import { TenantDb, Tx } from './db/prisma.service';
import { Errors } from './errors';
import { OfferedPlanFeatureKey as PlanFeatureKey, OfferedPlanFeatures as PlanFeatures, offeredFeatures } from './plan-features';

const FALLBACK_LIMITS: PlanLimits = { branches: 1, staffUsers: 3, monthlyRequests: 100, storageMb: 1024, aiPages: 0, notifications: 500, corporateClients: 0 };
const FALLBACK_FEATURES: PlanFeatures = offeredFeatures({});

const LABEL: Record<PlanLimitKey, string> = {
  branches: 'branches',
  staffUsers: 'staff users',
  monthlyRequests: 'requests this month',
  storageMb: 'MB of document storage',
  aiPages: 'AI-processed pages this month',
  notifications: 'notifications this month',
  corporateClients: 'corporate clients',
};
const FEATURE_LABEL: Record<PlanFeatureKey, string> = {
  whiteLabel: 'White-label branding',
  customDomains: 'Custom domains',
  corporatePortal: 'The corporate portal',
  automation: 'Automations',
  aiAssistant: 'The AI document assistant',
  scheduledReports: 'Scheduled reports',
};
export const periodKey = (d = new Date()) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

/**
 * Subscription plan enforcement and usage metering for the current tenant.
 * Limits and features come from the plan row (never hard-coded prices or caps);
 * -1 means unlimited.
 */
@Injectable()
export class UsageService {
  constructor(private readonly db: TenantDb) {}

  async plan(tx?: Tx): Promise<{ key: string | null; status: string | null; limits: PlanLimits; features: PlanFeatures }> {
    const load = async (t: Tx) => {
      const sub = await t.subscription.findFirst({ where: { tenantId: this.db.tenantId }, include: { plan: true } });
      if (!sub) return { key: null, status: null, limits: FALLBACK_LIMITS, features: FALLBACK_FEATURES };
      return {
        key: sub.plan.key,
        status: sub.status,
        limits: { ...FALLBACK_LIMITS, ...(sub.plan.limits as object) } as PlanLimits,
        // Exactly the features that exist: keys of earlier releases that a stored plan may still carry are ignored.
        features: offeredFeatures(sub.plan.features),
      };
    };
    return tx ? load(tx) : this.db.tx(load);
  }

  /** Current value of a metered limit. */
  async current(metric: PlanLimitKey, tx: Tx): Promise<number> {
    const tenantId = this.db.tenantId;
    switch (metric) {
      case 'branches':
        return tx.branch.count({ where: { tenantId, isActive: true } });
      case 'staffUsers':
        return tx.tenantMembership.count({ where: { tenantId, kind: 'STAFF', status: { in: ['ACTIVE', 'INVITED'] } } });
      case 'corporateClients':
        return tx.corporateAccount.count({ where: { tenantId, deletedAt: null, status: { not: 'ARCHIVED' } } });
      case 'storageMb': {
        const r = await tx.usageRecord.findFirst({ where: { tenantId, metric: 'storageBytes', periodKey: 'total' } });
        return Math.ceil(Number(r?.quantity ?? 0) / (1024 * 1024));
      }
      default: {
        const r = await tx.usageRecord.findFirst({ where: { tenantId, metric, periodKey: periodKey() } });
        return Number(r?.quantity ?? 0);
      }
    }
  }

  /** Throws PLAN_LIMIT_REACHED (HTTP 402) when adding `adding` would exceed the plan. */
  async assertWithinLimit(metric: PlanLimitKey, tx: Tx, adding = 1): Promise<void> {
    const { limits } = await this.plan(tx);
    const limit = limits[metric];
    if (limit === -1 || limit === undefined) return;
    const used = await this.current(metric, tx);
    if (used + adding > limit) {
      throw Errors.planLimit(metric, `Your plan includes ${limit} ${LABEL[metric]}. Upgrade your subscription to add more.`);
    }
  }

  async assertFeature(feature: PlanFeatureKey, tx?: Tx): Promise<void> {
    const { features } = await this.plan(tx);
    if (!features[feature]) {
      throw Errors.planLimit(feature, `${FEATURE_LABEL[feature]} is not included in your plan. Upgrade your subscription to use it.`);
    }
  }
  async hasFeature(feature: PlanFeatureKey, tx?: Tx): Promise<boolean> {
    return (await this.plan(tx)).features[feature] === true;
  }

  /** Add to a monthly counter (requests, notifications, aiPages) or a running total (storageBytes). */
  async record(metric: string, quantity: number, tx: Tx, total = false): Promise<void> {
    const tenantId = this.db.tenantId;
    const key = total ? 'total' : periodKey();
    await tx.$executeRaw`
      INSERT INTO "usage_records" ("id", "tenantId", "metric", "periodKey", "quantity", "updatedAt")
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${metric}, ${key}, GREATEST(${quantity}::numeric, 0), now())
      ON CONFLICT ("tenantId", "metric", "periodKey")
      DO UPDATE SET "quantity" = GREATEST("usage_records"."quantity" + ${quantity}::numeric, 0), "updatedAt" = now()`;
  }

  async summary(): Promise<Array<{ metric: PlanLimitKey; used: number; limit: number }>> {
    return this.db.tx(async (tx) => {
      const { limits } = await this.plan(tx);
      const out: Array<{ metric: PlanLimitKey; used: number; limit: number }> = [];
      for (const metric of Object.keys(LABEL) as PlanLimitKey[]) out.push({ metric, used: await this.current(metric, tx), limit: limits[metric] });
      return out;
    });
  }
}
