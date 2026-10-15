import { Injectable, Logger } from '@nestjs/common';
import { ALL_PERMISSIONS, PERMISSION_ROLLOUTS, SYSTEM_ROLES } from '@typease/permissions';
import { DEFAULT_DOCUMENT_TYPES, DEFAULT_SERVICE_CATEGORIES } from '@typease/types';
import type { Tenant } from '@typease/database';
import { SystemDb, Tx } from '../../common/db/prisma.service';
import { RETIRED_PLAN_FEATURES } from '../../common/plan-features';

const f = (o: Partial<Record<string, boolean>>) => ({ whiteLabel: false, customDomains: false, corporatePortal: false, automation: false, aiAssistant: false, scheduledReports: false, ...o });
/** What the Enterprise plan said while a plan could still claim "API access" (a feature that was never built). */
const ENTERPRISE_DESCRIPTION_BEFORE = 'Unlimited usage, API access and dedicated deployment options.';
export const DEFAULT_PLANS = [
  { key: 'starter', name: 'Starter', description: 'One branch and a small team.', monthlyPrice: 149, annualPrice: 1490, trialDays: 14, sortOrder: 1,
    limits: { branches: 1, staffUsers: 3, monthlyRequests: 200, storageMb: 2048, aiPages: 0, notifications: 500, corporateClients: 0 }, features: f({}) },
  { key: 'professional', name: 'Professional', description: 'Growing centres with corporate clients and automation.', monthlyPrice: 349, annualPrice: 3490, trialDays: 14, sortOrder: 2,
    limits: { branches: 2, staffUsers: 10, monthlyRequests: 1000, storageMb: 10240, aiPages: 200, notifications: 3000, corporateClients: 10 },
    features: f({ corporatePortal: true, automation: true, aiAssistant: true, scheduledReports: true }) },
  { key: 'business', name: 'Business', description: 'Multi-branch centres with their own brand and domain.', monthlyPrice: 749, annualPrice: 7490, trialDays: 14, sortOrder: 3,
    limits: { branches: 5, staffUsers: 30, monthlyRequests: 5000, storageMb: 51200, aiPages: 1000, notifications: 15000, corporateClients: 100 },
    features: f({ corporatePortal: true, automation: true, aiAssistant: true, scheduledReports: true, whiteLabel: true, customDomains: true }) },
  { key: 'enterprise', name: 'Enterprise', description: 'Unlimited usage and dedicated deployment options.', monthlyPrice: 1999, annualPrice: 19990, trialDays: 14, sortOrder: 4,
    limits: { branches: -1, staffUsers: -1, monthlyRequests: -1, storageMb: -1, aiPages: -1, notifications: -1, corporateClients: -1 },
    features: f({ corporatePortal: true, automation: true, aiAssistant: true, scheduledReports: true, whiteLabel: true, customDomains: true }) },
];

type TenantStep = (tx: Tx, tenant: Tenant) => Promise<void>;
type GlobalStep = (tx: Tx) => Promise<void>;

/**
 * Creates everything a tenant needs before its owner can work: roles, head
 * office, default catalogue categories, fee treatment, branding and whatever
 * other modules register (workflow templates, SLA policies, automations ...).
 * All steps are idempotent so they can be re-run after an upgrade.
 */
@Injectable()
export class ProvisioningService {
  private readonly logger = new Logger(ProvisioningService.name);
  private readonly tenantSteps: Array<{ name: string; run: TenantStep }> = [];
  private readonly globalSteps: Array<{ name: string; run: GlobalStep }> = [];

  constructor(private readonly sys: SystemDb) {}

  /** Other modules add their tenant defaults here (called in onModuleInit). */
  registerTenantStep(name: string, run: TenantStep) {
    this.tenantSteps.push({ name, run });
  }
  /** Other modules add platform-wide defaults here (templates, plans ...). */
  registerGlobalStep(name: string, run: GlobalStep) {
    this.globalSteps.push({ name, run });
  }

  /** Platform-wide reference data. Safe to run on every deploy. */
  async bootstrapPlatform(): Promise<void> {
    await this.sys.tx(async (tx) => {
      for (const [key, def] of Object.entries(ALL_PERMISSIONS)) {
        await tx.permission.upsert({ where: { key }, create: { key, groupName: def.group, description: def.description }, update: { groupName: def.group, description: def.description } });
      }
      for (const dt of DEFAULT_DOCUMENT_TYPES) {
        const existing = await tx.documentType.findFirst({ where: { tenantId: null, key: dt.key } });
        if (!existing) await tx.documentType.create({ data: { ...dt, tenantId: null } });
      }
      // Starting plans. Prices and limits are data: platform admins change them in the console.
      if ((await tx.subscriptionPlan.count()) === 0) {
        await tx.subscriptionPlan.createMany({ data: DEFAULT_PLANS as any });
      }
      // Retired plan features (see common/plan-features.ts): readers ignore the key anyway; this takes it out of the
      // stored plans as well, and corrects the one default description that advertised it - only while that text is
      // still exactly the default (a description somebody rewrote is theirs).
      for (const key of RETIRED_PLAN_FEATURES) {
        await tx.$executeRaw`UPDATE "subscription_plans" SET "features" = "features" - ${key}::text WHERE "features" ? ${key}::text`;
      }
      await tx.subscriptionPlan.updateMany({ where: { key: 'enterprise', description: ENTERPRISE_DESCRIPTION_BEFORE }, data: { description: 'Unlimited usage and dedicated deployment options.' } });
      for (const step of this.globalSteps) await step.run(tx);
      await this.applyPermissionRollouts(tx);
    }, { timeoutMs: 120_000 });
    this.logger.log(`Platform bootstrap complete (${this.globalSteps.length} module steps).`);
  }

  /**
   * Grants permissions that were added to the built-in roles after centres already existed
   * (PERMISSION_ROLLOUTS). Each rollout runs once: a centre that later removes such a permission
   * from its role keeps it removed.
   */
  async applyPermissionRollouts(tx: Tx): Promise<void> {
    const KEY = 'permission_rollouts';
    const row = await tx.platformSetting.findUnique({ where: { key: KEY } });
    const applied = new Set<string>(Array.isArray(row?.value) ? (row!.value as string[]) : []);
    const pending = PERMISSION_ROLLOUTS.filter((r) => !applied.has(r.id));
    if (!pending.length) return;
    for (const rollout of pending) {
      for (const [roleKey, keys] of Object.entries(rollout.grants)) {
        const roles = await tx.role.findMany({ where: { key: roleKey, isSystem: true, tenantId: { not: null } }, select: { id: true, tenantId: true } });
        for (const role of roles) {
          const have = new Set((await tx.rolePermission.findMany({ where: { roleId: role.id }, select: { permissionKey: true } })).map((r) => r.permissionKey));
          const add = (keys ?? []).filter((k) => !have.has(k));
          if (add.length) await tx.rolePermission.createMany({ data: add.map((permissionKey) => ({ tenantId: role.tenantId!, roleId: role.id, permissionKey })) });
        }
      }
      applied.add(rollout.id);
      this.logger.log(`Permission rollout ${rollout.id} applied.`);
    }
    await tx.platformSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: [...applied] }, update: { value: [...applied] } });
  }

  async syncSystemRoles(tx: Tx, tenantId: string): Promise<void> {
    for (const def of Object.values(SYSTEM_ROLES)) {
      let role = await tx.role.findFirst({ where: { tenantId, key: def.key } });
      if (!role) {
        role = await tx.role.create({ data: { tenantId, key: def.key, name: def.name, description: def.description, kind: def.kind, isSystem: true } });
      }
      const existing = new Set((await tx.rolePermission.findMany({ where: { roleId: role.id } })).map((r) => r.permissionKey));
      const missing = def.permissions.filter((p) => !existing.has(p));
      if (missing.length) await tx.rolePermission.createMany({ data: missing.map((permissionKey) => ({ tenantId, roleId: role!.id, permissionKey })) });
      // The owner role always mirrors the full staff catalogue; other system roles only gain new permissions.
      if (def.key === 'owner') {
        const extra = [...existing].filter((p) => !(def.permissions as string[]).includes(p));
        if (extra.length) await tx.rolePermission.deleteMany({ where: { roleId: role.id, permissionKey: { in: extra } } });
      }
    }
  }

  async provisionTenant(tx: Tx, tenant: Tenant, opts: { headOfficeName?: string } = {}): Promise<{ headOfficeId: string }> {
    await this.syncSystemRoles(tx, tenant.id);

    let branch = await tx.branch.findFirst({ where: { tenantId: tenant.id, isHeadOffice: true } });
    if (!branch) {
      branch = await tx.branch.create({
        data: {
          tenantId: tenant.id,
          code: 'MAIN',
          name: opts.headOfficeName ?? 'Main Branch',
          emirate: tenant.emirate,
          isHeadOffice: true,
          workingHours: { '0': { open: '09:00', close: '18:00' }, '1': { open: '09:00', close: '18:00' }, '2': { open: '09:00', close: '18:00' }, '3': { open: '09:00', close: '18:00' }, '4': { open: '09:00', close: '18:00' }, '5': null, '6': { open: '09:00', close: '14:00' } },
        },
      });
    }
    for (const [i, cat] of DEFAULT_SERVICE_CATEGORIES.entries()) {
      const exists = await tx.serviceCategory.findFirst({ where: { tenantId: tenant.id, key: cat.key } });
      if (!exists) await tx.serviceCategory.create({ data: { tenantId: tenant.id, key: cat.key, name: cat.name, nameAr: cat.nameAr, icon: cat.icon, sortOrder: i } });
    }
    for (const fc of [
      { type: 'SERVICE_FEE', name: 'Typing centre service fee', treatment: 'REVENUE', taxable: true },
      { type: 'GOVERNMENT_FEE', name: 'Government fee (collected on behalf of the authority)', treatment: 'PASS_THROUGH_LIABILITY', taxable: false },
      { type: 'THIRD_PARTY_FEE', name: 'Third-party processing charge', treatment: 'PASS_THROUGH_LIABILITY', taxable: false },
    ] as const) {
      const exists = await tx.feeComponent.findFirst({ where: { tenantId: tenant.id, type: fc.type } });
      if (!exists) {
        await tx.feeComponent.create({
          data: { tenantId: tenant.id, ...fc, reviewNote: 'Default treatment. Confirm with your accountant / tax adviser for your legal arrangements.' },
        });
      }
    }
    const branding = await tx.brandingSettings.findFirst({ where: { tenantId: tenant.id, branchId: null } });
    if (!branding) await tx.brandingSettings.create({ data: { tenantId: tenant.id, branchId: null, mode: 'TYPEASE', businessName: tenant.name } });

    for (const step of this.tenantSteps) await step.run(tx, tenant);
    return { headOfficeId: branch.id };
  }
}
