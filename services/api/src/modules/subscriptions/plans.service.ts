import { Injectable } from '@nestjs/common';
import type { CouponInput, SubscriptionPlanInput, UpdateCouponInput, UpdateSubscriptionPlanInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { Prisma, SystemDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { offeredFeatures, withOfferedFeatures } from '../../common/plan-features';
import { D } from '../../common/pagination';

const PUBLIC_SELECT = { key: true, name: true, description: true, monthlyPrice: true, annualPrice: true, currency: true, trialDays: true, limits: true, features: true, sortOrder: true } as const;

/**
 * Plans and coupons are data, never code: prices, limits and features live in
 * `subscription_plans` and are changed by platform administrators. A plan that
 * has (or had) subscribers is never deleted - it is deactivated, so existing
 * subscriptions and old invoices keep pointing at a real row.
 */
@Injectable()
export class PlansService {
  constructor(
    private readonly sys: SystemDb,
    private readonly audit: AuditService,
  ) {}

  /** What anyone may see on the pricing page: active, public plans. */
  async publicPlans() {
    const plans = await this.sys.client.subscriptionPlan.findMany({ where: { isActive: true, isPublic: true }, orderBy: [{ sortOrder: 'asc' }, { monthlyPrice: 'asc' }], select: PUBLIC_SELECT });
    return plans.map((p) => ({
      ...withOfferedFeatures(p),
      // What a year costs compared with twelve monthly payments.
      annualSaving: Prisma.Decimal.max(D(p.monthlyPrice).mul(12).minus(p.annualPrice), 0),
    }));
  }

  /** A plan a centre may choose itself (platform staff may also assign non-public plans). */
  async selectable(tx: Tx, key: string, opts: { allowPrivate?: boolean } = {}) {
    const plan = await tx.subscriptionPlan.findUnique({ where: { key } });
    if (!plan || !plan.isActive || (!plan.isPublic && !opts.allowPrivate)) {
      throw Errors.unprocessable('PLAN_NOT_AVAILABLE', 'That plan is not available. Please choose one of the current plans.');
    }
    return plan;
  }

  // ------------------------------------------------------------------ plans (platform.plans.manage)
  async listPlans() {
    const plans = await this.sys.client.subscriptionPlan.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], include: { _count: { select: { subscriptions: true, pendingSubscriptions: true } } } });
    return plans.map(({ _count, ...p }) => ({ ...withOfferedFeatures(p), subscriptionCount: _count.subscriptions, pendingCount: _count.pendingSubscriptions }));
  }

  async createPlan(input: SubscriptionPlanInput) {
    if (await this.sys.client.subscriptionPlan.findUnique({ where: { key: input.key } })) throw Errors.conflict('PLAN_KEY_TAKEN', 'A plan with this key already exists.');
    const plan = await this.sys.client.subscriptionPlan.create({ data: { ...input, features: offeredFeatures(input.features), description: input.description ?? null } });
    await this.audit.logSystem({ action: 'platform.plan_created', resourceType: 'SubscriptionPlan', resourceId: plan.id, summary: `Plan ${plan.key} created`, after: input });
    return withOfferedFeatures(plan);
  }

  async updatePlan(id: string, input: UpdateSubscriptionPlanInput) {
    const before = found(await this.sys.client.subscriptionPlan.findUnique({ where: { id } }), 'Plan');
    const data: Prisma.SubscriptionPlanUpdateInput = { ...input, description: input.description === undefined ? undefined : (input.description ?? null) };
    if (input.limits) data.limits = { ...(before.limits as object), ...input.limits };
    // Stored features are rewritten as the offered set: a key of an earlier release that the row still carried goes away here.
    if (input.features) data.features = offeredFeatures({ ...(before.features as object), ...input.features });
    const plan = await this.sys.client.subscriptionPlan.update({ where: { id }, data });
    await this.audit.logSystem({
      action: 'platform.plan_updated',
      resourceType: 'SubscriptionPlan',
      resourceId: id,
      summary: `Plan ${plan.key} updated`,
      before: { monthlyPrice: before.monthlyPrice, annualPrice: before.annualPrice, limits: before.limits, features: before.features, isActive: before.isActive, isPublic: before.isPublic },
      after: input,
    });
    return withOfferedFeatures(plan);
  }

  async deletePlan(id: string) {
    const plan = found(await this.sys.client.subscriptionPlan.findUnique({ where: { id }, include: { _count: { select: { subscriptions: true, pendingSubscriptions: true } } } }), 'Plan');
    if (plan._count.subscriptions + plan._count.pendingSubscriptions > 0) {
      throw Errors.conflict('PLAN_IN_USE', `${plan._count.subscriptions} centre(s) are on this plan, so it cannot be deleted. Deactivate it instead: nobody new can choose it and current subscribers keep it.`);
    }
    const invoiced = await this.sys.client.subscriptionEvent.count({ where: { type: 'INVOICE_CREATED', data: { path: ['planKey'], equals: plan.key } } });
    if (invoiced) throw Errors.conflict('PLAN_IN_USE', 'Invoices have been issued for this plan, so it cannot be deleted. Deactivate it instead.');
    await this.sys.client.subscriptionPlan.delete({ where: { id } });
    await this.audit.logSystem({ action: 'platform.plan_deleted', resourceType: 'SubscriptionPlan', resourceId: id, summary: `Plan ${plan.key} deleted`, before: { key: plan.key, name: plan.name } });
    return { status: 'DELETED' as const };
  }

  // ------------------------------------------------------------------ coupons (platform.plans.manage)
  listCoupons() {
    return this.sys.client.coupon.findMany({ orderBy: { createdAt: 'desc' }, include: { _count: { select: { subscriptions: true } } } }).then((rows) => rows.map(({ _count, ...c }) => ({ ...c, activeSubscriptions: _count.subscriptions })));
  }

  async createCoupon(input: CouponInput) {
    if (await this.sys.client.coupon.findUnique({ where: { code: input.code } })) throw Errors.conflict('COUPON_CODE_TAKEN', 'A coupon with this code already exists.');
    if (input.planKeys.length) {
      const known = await this.sys.client.subscriptionPlan.findMany({ where: { key: { in: input.planKeys } }, select: { key: true } });
      const missing = input.planKeys.filter((k) => !known.some((p) => p.key === k));
      if (missing.length) throw Errors.unprocessable('UNKNOWN_PLAN', `Unknown plan key(s): ${missing.join(', ')}.`);
    }
    const coupon = await this.sys.client.coupon.create({
      data: {
        code: input.code,
        description: input.description ?? null,
        percentOff: input.percentOff ?? null,
        amountOff: input.amountOff ?? null,
        currency: input.currency,
        durationMonths: input.durationMonths ?? null,
        maxRedemptions: input.maxRedemptions ?? null,
        planKeys: input.planKeys,
        validFrom: input.validFrom ? new Date(input.validFrom) : null,
        validUntil: input.validUntil ? new Date(input.validUntil) : null,
        isActive: input.isActive,
      },
    });
    await this.audit.logSystem({ action: 'platform.coupon_created', resourceType: 'Coupon', resourceId: coupon.id, summary: `Coupon ${coupon.code} created`, after: input });
    return coupon;
  }

  async updateCoupon(id: string, input: UpdateCouponInput) {
    const before = found(await this.sys.client.coupon.findUnique({ where: { id } }), 'Coupon');
    if (input.maxRedemptions !== undefined && input.maxRedemptions !== null && input.maxRedemptions < before.redeemedCount) {
      throw Errors.unprocessable('BELOW_REDEEMED', `This coupon has already been redeemed ${before.redeemedCount} time(s). Deactivate it to stop further use.`);
    }
    const coupon = await this.sys.client.coupon.update({
      where: { id },
      data: {
        ...(input.description !== undefined ? { description: input.description ?? null } : {}),
        ...(input.durationMonths !== undefined ? { durationMonths: input.durationMonths ?? null } : {}),
        ...(input.maxRedemptions !== undefined ? { maxRedemptions: input.maxRedemptions ?? null } : {}),
        ...(input.planKeys !== undefined ? { planKeys: input.planKeys } : {}),
        ...(input.validFrom !== undefined ? { validFrom: input.validFrom ? new Date(input.validFrom) : null } : {}),
        ...(input.validUntil !== undefined ? { validUntil: input.validUntil ? new Date(input.validUntil) : null } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    await this.audit.logSystem({ action: 'platform.coupon_updated', resourceType: 'Coupon', resourceId: id, summary: `Coupon ${coupon.code} updated`, before: { isActive: before.isActive, maxRedemptions: before.maxRedemptions, validUntil: before.validUntil }, after: input });
    return coupon;
  }

  async deleteCoupon(id: string) {
    const coupon = found(await this.sys.client.coupon.findUnique({ where: { id }, include: { _count: { select: { subscriptions: true } } } }), 'Coupon');
    if (coupon.redeemedCount > 0 || coupon._count.subscriptions > 0) {
      throw Errors.conflict('COUPON_IN_USE', 'This coupon has been redeemed, so it cannot be deleted. Deactivate it instead.');
    }
    await this.sys.client.coupon.delete({ where: { id } });
    await this.audit.logSystem({ action: 'platform.coupon_deleted', resourceType: 'Coupon', resourceId: id, summary: `Coupon ${coupon.code} deleted` });
    return { status: 'DELETED' as const };
  }
}
