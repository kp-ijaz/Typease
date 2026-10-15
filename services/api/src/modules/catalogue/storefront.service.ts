import { Injectable } from '@nestjs/common';
import type { CustomerCatalogueQuery, PublicCatalogueQuery, ServicePriceQuery } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { ctx, runAsTenant } from '../../common/context';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { TenantResolver } from '../tenancy/tenant-resolver.service';
import { FormsService } from './forms.service';
import { EffectivePrice, PricingService } from './pricing.service';
import { installStarterCatalogue } from './starter-catalogue';

/** Tenant states in which a centre serves customers. */
const CUSTOMER_FACING = ['TRIAL', 'ACTIVE', 'PAST_DUE'];
const CATEGORY_SELECT = { id: true, key: true, name: true, nameAr: true, icon: true, sortOrder: true } as const;
const REQUIREMENT_ORDER = [{ sortOrder: 'asc' as const }, { createdAt: 'asc' as const }];

type ServiceRow = Awaited<ReturnType<Tx['service']['findFirstOrThrow']>> & { category: { id: string; key: string; name: string; nameAr: string | null; icon: string | null; sortOrder: number }; serviceBranches?: Array<{ branchId: string }> };

/**
 * What customers see of a service. Internal configuration (code, staff group,
 * workflow, approval rules, version) is deliberately left out.
 */
function customerView(s: ServiceRow, price: EffectivePrice | null) {
  return {
    id: s.id,
    name: s.name,
    nameAr: s.nameAr,
    description: s.description,
    descriptionAr: s.descriptionAr,
    eligibilityGuidance: s.eligibilityGuidance,
    category: { key: s.category.key, name: s.category.name, nameAr: s.category.nameAr, icon: s.category.icon },
    complianceCapability: s.complianceCapability,
    estimatedProcessingHours: s.estimatedProcessingHours,
    paymentPolicy: s.paymentPolicy,
    onlineAvailable: s.onlineAvailable,
    allBranches: s.allBranches,
    branchIds: (s.serviceBranches ?? []).map((b) => b.branchId),
    price,
  };
}

/** What anonymous visitors see: descriptive information and fee ESTIMATES only. */
function publicView(s: ServiceRow, price: EffectivePrice | null, requirements: Array<{ label: string; labelAr: string | null; description: string | null; isMandatory: boolean }>) {
  return {
    id: s.id,
    name: s.name,
    nameAr: s.nameAr,
    description: s.description,
    descriptionAr: s.descriptionAr,
    eligibilityGuidance: s.eligibilityGuidance,
    category: { key: s.category.key, name: s.category.name, nameAr: s.category.nameAr, icon: s.category.icon },
    complianceCapability: s.complianceCapability,
    estimatedProcessingHours: s.estimatedProcessingHours,
    onlineAvailable: s.onlineAvailable,
    requiredDocuments: requirements.map((r) => ({ label: r.label, labelAr: r.labelAr, description: r.description, isMandatory: r.isMandatory })),
    feeEstimate: price
      ? {
          currency: price.currency,
          serviceFee: price.serviceFee,
          governmentFeeEstimate: price.governmentFeeEstimate,
          thirdPartyFeeEstimate: price.thirdPartyFeeEstimate,
          taxEstimate: price.taxAmount,
          totalEstimate: price.total,
          isEstimate: true as const,
        }
      : null,
  };
}

/** Read models of the catalogue: request wizard, customer / corporate portal and the public website. */
@Injectable()
export class StorefrontService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly pricing: PricingService,
    private readonly forms: FormsService,
    private readonly resolver: TenantResolver,
  ) {}

  // ------------------------------------------------------------------ staff: request wizard
  /** GET /services/:id/full - everything the request wizard needs in one call. */
  full(serviceId: string, query: ServicePriceQuery) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const service = found(
        await tx.service.findFirst({ where: { id: serviceId, tenantId, deletedAt: null }, include: { category: { select: { ...CATEGORY_SELECT, isActive: true } }, serviceBranches: { select: { branchId: true } } } }),
        'Service',
      );
      await this.pricing.assertPriceScope(tx, service, query);
      const [prices, requirements, form] = await Promise.all([
        this.pricing.resolveMany(tx, [service], { ...query, taxRatePercent: await this.pricing.taxRatePercent(tx) }),
        tx.serviceRequirement.findMany({ where: { tenantId, serviceId }, orderBy: REQUIREMENT_ORDER }),
        this.forms.published(tx, serviceId),
      ]);
      const { serviceBranches, ...rest } = service;
      return { ...rest, branchIds: serviceBranches.map((b) => b.branchId), price: prices.get(serviceId) ?? null, requirements, form };
    });
  }

  // ------------------------------------------------------------------ signed-in customers and corporate users
  /**
   * Services a signed-in portal user may request online.
   *  - customers:        active + online + public services
   *  - corporate users:  the same, plus non-public services their company has a contract price for
   * Corporate users see their company's contract price.
   */
  private async portalScope(tx: Tx, branchId?: string) {
    const tenantId = this.db.tenantId;
    const c = ctx();
    const corporateAccountId = c.actorType === 'CORPORATE' ? (c.corporateAccountId ?? null) : null;
    if (branchId) found(await tx.branch.findFirst({ where: { id: branchId, tenantId, isActive: true }, select: { id: true } }), 'Branch');
    const visibility = corporateAccountId ? { OR: [{ isPublic: true }, { corporatePrices: { some: { corporateAccountId } } }] } : { isPublic: true };
    const where = {
      tenantId,
      deletedAt: null,
      isActive: true,
      onlineAvailable: true,
      category: { isActive: true },
      AND: [visibility, ...(branchId ? [{ OR: [{ allBranches: true }, { serviceBranches: { some: { branchId } } }] }] : [])],
    };
    return { where, corporateAccountId };
  }

  customerCatalogue(query: CustomerCatalogueQuery) {
    return this.db.tx(async (tx) => {
      const { where, corporateAccountId } = await this.portalScope(tx, query.branchId);
      const services = (await tx.service.findMany({
        where: {
          ...where,
          ...(query.categoryKey ? { category: { isActive: true, key: query.categoryKey } } : {}),
          ...(query.q ? { OR: [{ name: { contains: query.q, mode: 'insensitive' as const } }, { nameAr: { contains: query.q } }, { description: { contains: query.q, mode: 'insensitive' as const } }] } : {}),
        },
        include: { category: { select: CATEGORY_SELECT }, serviceBranches: { select: { branchId: true } } },
        orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { name: 'asc' }],
        take: 500,
      })) as ServiceRow[];
      const prices = await this.pricing.resolveMany(tx, services, { branchId: query.branchId, corporateAccountId, taxRatePercent: await this.pricing.taxRatePercent(tx) });
      return { categories: categoriesOf(services), services: services.map((s) => customerView(s, prices.get(s.id) ?? null)) };
    });
  }

  customerService(serviceId: string, query: { branchId?: string }) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const { where, corporateAccountId } = await this.portalScope(tx, query.branchId);
      const service = found(
        await tx.service.findFirst({ where: { ...where, id: serviceId }, include: { category: { select: CATEGORY_SELECT }, serviceBranches: { select: { branchId: true } } } }),
        'Service',
      ) as ServiceRow;
      const [prices, requirements, form] = await Promise.all([
        this.pricing.resolveMany(tx, [service], { branchId: query.branchId, corporateAccountId, taxRatePercent: await this.pricing.taxRatePercent(tx) }),
        tx.serviceRequirement.findMany({
          where: { tenantId, serviceId },
          orderBy: REQUIREMENT_ORDER,
          select: { id: true, documentTypeKey: true, label: true, labelAr: true, description: true, isMandatory: true, allowReuse: true, maxAgeDays: true },
        }),
        this.forms.published(tx, serviceId),
      ]);
      return { ...customerView(service, prices.get(serviceId) ?? null), requirements, form: form ? { id: form.id, version: form.version, schema: form.schema } : null };
    });
  }

  // ------------------------------------------------------------------ public website (no session)
  /**
   * Runs `fn` for the centre a public request is addressed to, but only when
   * that centre is open for business and has switched its public catalogue on.
   * Anything else looks exactly like "no such centre".
   */
  private async inPublicTenant<T>(slug: string | undefined, fn: (tx: Tx, tenant: { id: string; slug: string; name: string; defaultCurrency: string; taxRatePercent: unknown }) => Promise<T>): Promise<T> {
    const tenantId = await this.resolver.resolveId(slug || undefined);
    if (!tenantId) throw Errors.notFound('Catalogue');
    return runAsTenant(
      tenantId,
      () =>
        this.db.tx(async (tx) => {
          const [tenant, branding] = await Promise.all([
            tx.tenant.findFirst({ where: { id: tenantId }, select: { id: true, slug: true, name: true, status: true, defaultCurrency: true, taxRatePercent: true } }),
            tx.brandingSettings.findFirst({ where: { tenantId, branchId: null }, select: { publicCatalogueEnabled: true } }),
          ]);
          if (!tenant || !CUSTOMER_FACING.includes(tenant.status) || !branding?.publicCatalogueEnabled) throw Errors.notFound('Catalogue');
          return fn(tx, tenant);
        }),
      { actorLabel: 'public-catalogue' },
    );
  }
  private publicWhere(tenantId: string) {
    return { tenantId, deletedAt: null, isActive: true, isPublic: true, category: { isActive: true } };
  }

  publicCatalogue(query: PublicCatalogueQuery) {
    return this.inPublicTenant(query.slug, async (tx, tenant) => {
      const services = (await tx.service.findMany({
        where: {
          ...this.publicWhere(tenant.id),
          ...(query.categoryKey ? { category: { isActive: true, key: query.categoryKey } } : {}),
          ...(query.q ? { OR: [{ name: { contains: query.q, mode: 'insensitive' as const } }, { nameAr: { contains: query.q } }, { description: { contains: query.q, mode: 'insensitive' as const } }] } : {}),
        },
        include: { category: { select: CATEGORY_SELECT } },
        orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { name: 'asc' }],
        take: 500,
      })) as ServiceRow[];
      const ids = services.map((s) => s.id);
      const [prices, requirements] = await Promise.all([
        this.pricing.resolveMany(tx, services, { taxRatePercent: tenant.taxRatePercent }),
        ids.length
          ? tx.serviceRequirement.findMany({ where: { tenantId: tenant.id, serviceId: { in: ids } }, orderBy: REQUIREMENT_ORDER, select: { serviceId: true, label: true, labelAr: true, description: true, isMandatory: true } })
          : [],
      ]);
      return {
        centre: { slug: tenant.slug, name: tenant.name, currency: tenant.defaultCurrency },
        categories: categoriesOf(services),
        services: services.map((s) => publicView(s, prices.get(s.id) ?? null, requirements.filter((r) => r.serviceId === s.id))),
      };
    });
  }

  publicService(serviceId: string, query: { slug?: string }) {
    return this.inPublicTenant(query.slug, async (tx, tenant) => {
      const service = found(await tx.service.findFirst({ where: { ...this.publicWhere(tenant.id), id: serviceId }, include: { category: { select: CATEGORY_SELECT } } }), 'Service') as ServiceRow;
      const [prices, requirements] = await Promise.all([
        this.pricing.resolveMany(tx, [service], { taxRatePercent: tenant.taxRatePercent }),
        tx.serviceRequirement.findMany({ where: { tenantId: tenant.id, serviceId }, orderBy: REQUIREMENT_ORDER, select: { label: true, labelAr: true, description: true, isMandatory: true } }),
      ]);
      return { centre: { slug: tenant.slug, name: tenant.name, currency: tenant.defaultCurrency }, service: publicView(service, prices.get(serviceId) ?? null, requirements) };
    });
  }

  // ------------------------------------------------------------------ onboarding
  /** POST /services/starter-catalogue - never runs by itself; a manager asks for it. */
  installStarter() {
    return this.db.tx(
      async (tx) => {
        const result = await installStarterCatalogue(tx, this.db.tenantId);
        await this.audit.log({ action: 'service.starter_catalogue_installed', resourceType: 'Service', summary: `${result.created.length} created, ${result.skipped.length} already present`, after: result }, tx);
        return { ...result, createdCount: result.created.length, skippedCount: result.skipped.length };
      },
      { timeoutMs: 60_000 },
    );
  }
}

function categoriesOf(services: ServiceRow[]) {
  const seen = new Map<string, { key: string; name: string; nameAr: string | null; icon: string | null; sortOrder: number; serviceCount: number }>();
  for (const s of services) {
    const current = seen.get(s.category.key);
    if (current) current.serviceCount += 1;
    else seen.set(s.category.key, { key: s.category.key, name: s.category.name, nameAr: s.category.nameAr, icon: s.category.icon, sortOrder: s.category.sortOrder, serviceCount: 1 });
  }
  return [...seen.values()].sort((a, b) => a.sortOrder - b.sortOrder).map(({ sortOrder: _order, ...c }) => c);
}
