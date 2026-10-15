import { Injectable } from '@nestjs/common';
import type { ServicePriceInput, ServicePriceQuery } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { CatalogueService, PRICE_SELECT } from './catalogue.service';
import { calculatePrice, PaymentPolicy, PriceBreakdown, selectPriceRow, TaxMode } from './pricing';

export interface EffectivePrice extends PriceBreakdown {
  serviceId: string;
  priceId: string;
  /** Which price row was used. */
  source: 'BRANCH' | 'DEFAULT';
  branchId: string | null;
  corporateAccountId: string | null;
  currency: string;
  validFrom: Date;
  /** Government and third-party amounts are estimates; the binding amounts are on the quotation / invoice. */
  containsEstimates: boolean;
}
interface PricedService {
  id: string;
  taxMode: string;
  paymentPolicy: string;
  depositPercent: unknown;
}

/** Price history per service and resolution of the price that applies right now. */
@Injectable()
export class PricingService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly catalogue: CatalogueService,
  ) {}

  listPrices(serviceId: string) {
    return this.db.tx(async (tx) => {
      await this.catalogue.requireService(tx, serviceId, { includeDeleted: true });
      return tx.servicePrice.findMany({
        where: { tenantId: this.db.tenantId, serviceId },
        select: { ...PRICE_SELECT, branch: { select: { id: true, code: true, name: true } } },
        orderBy: [{ validFrom: 'desc' }, { createdAt: 'desc' }],
      });
    });
  }

  /**
   * Sets a new price. Prices are never edited: the current price for the same
   * scope (default, or one branch) is closed and a new row takes over, so the
   * history shows what was charged when.
   */
  setPrice(serviceId: string, input: ServicePriceInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const service = await this.catalogue.requireService(tx, serviceId);
      await this.catalogue.lockService(tx, serviceId);
      const branchId = input.branchId ?? null;
      if (branchId) {
        found(await tx.branch.findFirst({ where: { id: branchId, tenantId }, select: { id: true } }), 'Branch');
        if (!service.allBranches && !(await tx.serviceBranch.findFirst({ where: { tenantId, serviceId, branchId }, select: { id: true } }))) {
          throw Errors.unprocessable('SERVICE_NOT_AT_BRANCH', 'This service is not offered at that branch. Add the branch to the service first.');
        }
        if (!(await tx.servicePrice.findFirst({ where: { tenantId, serviceId, branchId: null, isActive: true }, select: { id: true } }))) {
          throw Errors.unprocessable('DEFAULT_PRICE_REQUIRED', 'Set the default price of the service before adding a branch price.');
        }
      }
      const now = new Date();
      const current = await tx.servicePrice.findMany({ where: { tenantId, serviceId, branchId, isActive: true }, select: PRICE_SELECT });
      if (current.length) await tx.servicePrice.updateMany({ where: { id: { in: current.map((p) => p.id) }, tenantId }, data: { isActive: false, validTo: now } });
      const tenant = await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { defaultCurrency: true } });
      const price = await tx.servicePrice.create({
        data: {
          tenantId, serviceId, branchId, currency: tenant.defaultCurrency, validFrom: now, isActive: true,
          serviceFee: input.serviceFee, governmentFeeEstimate: input.governmentFeeEstimate, thirdPartyFeeEstimate: input.thirdPartyFeeEstimate,
        },
        select: PRICE_SELECT,
      });
      await this.audit.log(
        {
          action: 'service_price.set', resourceType: 'Service', resourceId: serviceId,
          summary: `${service.code}: ${branchId ? 'branch' : 'default'} price ${price.serviceFee.toFixed(2)} ${price.currency}`,
          before: current[0] ? priceAudit(current[0]) : null,
          after: priceAudit(price),
        },
        tx,
      );
      return price;
    });
  }

  /** Ends a branch-specific price; the branch falls back to the default price. */
  removeBranchPrice(serviceId: string, priceId: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      await this.catalogue.requireService(tx, serviceId);
      await this.catalogue.lockService(tx, serviceId);
      const price = found(await tx.servicePrice.findFirst({ where: { id: priceId, serviceId, tenantId }, select: PRICE_SELECT }), 'Price');
      if (!price.isActive) throw Errors.conflict('PRICE_ALREADY_ENDED', 'This price is no longer in force.');
      if (price.branchId === null) throw Errors.conflict('DEFAULT_PRICE_REQUIRED', 'A service always needs a default price. Set a new default price instead of removing it.');
      await tx.servicePrice.update({ where: { id: priceId }, data: { isActive: false, validTo: new Date() } });
      await this.audit.log({ action: 'service_price.ended', resourceType: 'Service', resourceId: serviceId, before: priceAudit(price) }, tx);
      return { status: 'ENDED' as const };
    });
  }

  /** Effective prices for many services in two queries (catalogue lists). Services without a price are absent from the map. */
  async resolveMany(tx: Tx, services: PricedService[], opts: { branchId?: string | null; corporateAccountId?: string | null; taxRatePercent: unknown }): Promise<Map<string, EffectivePrice>> {
    const tenantId = this.db.tenantId;
    const out = new Map<string, EffectivePrice>();
    if (!services.length) return out;
    const ids = services.map((s) => s.id);
    const [prices, contracts] = await Promise.all([
      tx.servicePrice.findMany({ where: { tenantId, serviceId: { in: ids }, isActive: true }, select: PRICE_SELECT }),
      opts.corporateAccountId ? tx.corporatePrice.findMany({ where: { tenantId, corporateAccountId: opts.corporateAccountId, serviceId: { in: ids } }, select: { serviceId: true, serviceFee: true } }) : [],
    ]);
    const now = new Date();
    for (const service of services) {
      const chosen = selectPriceRow(prices.filter((p) => p.serviceId === service.id), opts.branchId ?? null, now);
      if (!chosen) continue;
      const contract = contracts.find((c) => c.serviceId === service.id);
      const breakdown = calculatePrice({
        serviceFee: chosen.row.serviceFee,
        governmentFeeEstimate: chosen.row.governmentFeeEstimate,
        thirdPartyFeeEstimate: chosen.row.thirdPartyFeeEstimate,
        corporateServiceFee: contract?.serviceFee ?? null,
        taxMode: service.taxMode as TaxMode,
        taxRatePercent: opts.taxRatePercent as any,
        paymentPolicy: service.paymentPolicy as PaymentPolicy,
        depositPercent: service.depositPercent as any,
      });
      out.set(service.id, {
        serviceId: service.id,
        priceId: chosen.row.id,
        source: chosen.source,
        branchId: opts.branchId ?? null,
        corporateAccountId: opts.corporateAccountId ?? null,
        currency: chosen.row.currency,
        validFrom: chosen.row.validFrom,
        ...breakdown,
        containsEstimates: !chosen.row.governmentFeeEstimate.isZero() || !chosen.row.thirdPartyFeeEstimate.isZero(),
      });
    }
    return out;
  }

  /** Validates the branch / company the caller named and that the service is offered at the branch. */
  async assertPriceScope(tx: Tx, service: { id: string; allBranches: boolean }, query: ServicePriceQuery) {
    const tenantId = this.db.tenantId;
    if (query.branchId) {
      found(await tx.branch.findFirst({ where: { id: query.branchId, tenantId }, select: { id: true } }), 'Branch');
      if (!service.allBranches && !(await tx.serviceBranch.findFirst({ where: { tenantId, serviceId: service.id, branchId: query.branchId }, select: { id: true } }))) {
        throw Errors.unprocessable('SERVICE_NOT_AT_BRANCH', 'This service is not offered at that branch.');
      }
    }
    if (query.corporateAccountId) {
      found(await tx.corporateAccount.findFirst({ where: { id: query.corporateAccountId, tenantId, deletedAt: null }, select: { id: true } }), 'Corporate account');
    }
  }

  async taxRatePercent(tx: Tx) {
    return (await tx.tenant.findFirstOrThrow({ where: { id: this.db.tenantId }, select: { taxRatePercent: true } })).taxRatePercent;
  }

  /** GET /services/:id/price */
  effectivePrice(serviceId: string, query: ServicePriceQuery) {
    return this.db.tx(async (tx) => {
      const service = await this.catalogue.requireService(tx, serviceId);
      await this.assertPriceScope(tx, service, query);
      const price = (await this.resolveMany(tx, [service], { ...query, taxRatePercent: await this.taxRatePercent(tx) })).get(service.id);
      if (!price) throw Errors.unprocessable('PRICE_NOT_SET', 'No price has been set for this service yet. Add a default price first.');
      return price;
    });
  }
}

const priceAudit = (p: { id: string; branchId: string | null; serviceFee: unknown; governmentFeeEstimate: unknown; thirdPartyFeeEstimate: unknown; currency: string }) => ({
  priceId: p.id,
  branchId: p.branchId,
  serviceFee: String(p.serviceFee),
  governmentFeeEstimate: String(p.governmentFeeEstimate),
  thirdPartyFeeEstimate: String(p.thirdPartyFeeEstimate),
  currency: p.currency,
});
