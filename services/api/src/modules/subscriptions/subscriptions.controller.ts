import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, RawBodyRequest, Req, Res, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  adminChangePlanSchema, applyCouponSchema, cancelSubscriptionSchema, changePlanSchema, couponSchema, extendTrialSchema, offlineSubscriptionPaymentSchema,
  platformSubscriptionListQuery, startPlanSchema, subscriptionInvoiceListQuery, subscriptionPlanSchema, updateCouponSchema, updateSubscriptionPlanSchema,
  voidSubscriptionInvoiceSchema,
} from '@typease/validation';
import { Permissions, Platform, Public, TenantMember } from '../../common/auth/access';
import { RateLimit } from '../../common/rate-limit';
import { dto } from '../../common/zod';
import { MoneyInterceptor } from '../finance/finance.serialise';
import { PlansService } from './plans.service';
import { SubscriptionWebhookService } from './subscription-webhook.service';
import { SubscriptionsService } from './subscriptions.service';

class StartPlanDto extends dto(startPlanSchema) {}
class ChangePlanDto extends dto(changePlanSchema) {}
class CancelDto extends dto(cancelSubscriptionSchema) {}
class ApplyCouponDto extends dto(applyCouponSchema) {}
class InvoiceListDto extends dto(subscriptionInvoiceListQuery) {}
class PlanDto extends dto(subscriptionPlanSchema) {}
class UpdatePlanDto extends dto(updateSubscriptionPlanSchema) {}
class CouponDto extends dto(couponSchema) {}
class UpdateCouponDto extends dto(updateCouponSchema) {}
class SubscriptionListDto extends dto(platformSubscriptionListQuery) {}
class OfflinePaymentDto extends dto(offlineSubscriptionPaymentSchema) {}
class ExtendTrialDto extends dto(extendTrialSchema) {}
class VoidInvoiceDto extends dto(voidSubscriptionInvoiceSchema) {}
class AdminChangePlanDto extends dto(adminChangePlanSchema) {}

function sendPdf(res: Response, file: { filename: string; content: Buffer }) {
  res.status(200);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${file.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
  res.setHeader('Content-Length', String(file.content.length));
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(file.content);
}

// ====================================================================== public
@ApiTags('Public')
@UseInterceptors(MoneyInterceptor)
@Controller('public')
export class PublicPlansController {
  constructor(
    private readonly plans: PlansService,
    private readonly webhooks: SubscriptionWebhookService,
  ) {}

  @Public()
  @RateLimit({ name: 'public-plans', limit: 120, windowSeconds: 60 })
  @Get('plans')
  @ApiOperation({ summary: 'TypEase plans with prices, limits and features (pricing page)' })
  list() {
    return this.plans.publicPlans();
  }

  @Public()
  @RateLimit({ name: 'subscription-webhook', limit: 300, windowSeconds: 60 })
  @Post('webhooks/subscriptions/:gateway')
  @HttpCode(200)
  @ApiOperation({ summary: 'Gateway webhook for SUBSCRIPTION payments (separate from customer payments)' })
  webhook(@Param('gateway') gateway: string, @Req() req: RawBodyRequest<Request>) {
    return this.webhooks.handle(gateway, req.rawBody, req.headers);
  }
}

// ====================================================================== centre owner
/** Reading and paying stay available to a suspended centre, so it can always settle its invoice. */
const OwnerEvenSuspended = () => TenantMember({ any: ['subscription.manage'], allowSuspended: true });

@ApiTags('Subscription')
@ApiBearerAuth()
@UseInterceptors(MoneyInterceptor)
@Controller()
export class SubscriptionController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @OwnerEvenSuspended()
  @Post('onboarding/plan')
  @ApiOperation({ summary: 'Choose the plan during onboarding: starts the trial, or issues the first invoice' })
  startDuringOnboarding(@Body() body: StartPlanDto) {
    return this.subscriptions.start(body);
  }
  @OwnerEvenSuspended()
  @Post('subscription/restart')
  @ApiOperation({ summary: 'Subscribe again after a cancellation or a lapse (no second trial)' })
  restart(@Body() body: StartPlanDto) {
    return this.subscriptions.start(body);
  }

  @OwnerEvenSuspended()
  @Get('subscription')
  @ApiOperation({ summary: 'Plan, status, period, trial end, pending change, coupon and usage against the plan limits' })
  current() {
    return this.subscriptions.current();
  }
  @OwnerEvenSuspended()
  @Get('subscription/invoices')
  invoices(@Query() query: InvoiceListDto) {
    return this.subscriptions.invoices(query);
  }
  @OwnerEvenSuspended()
  @Get('subscription/invoices/:id')
  invoice(@Param('id', ParseUUIDPipe) id: string) {
    return this.subscriptions.invoice(id);
  }
  @OwnerEvenSuspended()
  @Get('subscription/invoices/:id/pdf')
  @ApiProduces('application/pdf')
  async invoicePdf(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    sendPdf(res, await this.subscriptions.invoicePdf(id));
  }
  @OwnerEvenSuspended()
  @Post('subscription/invoices/:id/pay')
  @ApiOperation({ summary: 'Open the hosted checkout of the TypEase payment gateway for one subscription invoice' })
  pay(@Param('id', ParseUUIDPipe) id: string) {
    return this.subscriptions.pay(id);
  }

  @Permissions('subscription.manage')
  @Post('subscription/change-plan')
  @HttpCode(200)
  @ApiOperation({ summary: 'Upgrade (now, prorated) or downgrade / switch billing cycle (at period end)' })
  changePlan(@Body() body: ChangePlanDto) {
    return this.subscriptions.changePlan(body);
  }
  @Permissions('subscription.manage')
  @Post('subscription/cancel')
  @HttpCode(200)
  cancel(@Body() body: CancelDto) {
    return this.subscriptions.cancel(body.reason);
  }
  @Permissions('subscription.manage')
  @Post('subscription/resume')
  @HttpCode(200)
  resume() {
    return this.subscriptions.resume();
  }
  @OwnerEvenSuspended()
  @Post('subscription/coupon')
  @HttpCode(200)
  coupon(@Body() body: ApplyCouponDto) {
    return this.subscriptions.applyCoupon(body.code);
  }
}

// ====================================================================== platform: plans and coupons
@ApiTags('Platform billing')
@ApiBearerAuth()
@UseInterceptors(MoneyInterceptor)
@Controller('platform')
export class PlatformPlansController {
  constructor(private readonly plans: PlansService) {}

  @Platform('platform.plans.manage', 'platform.billing.manage')
  @Get('plans')
  listPlans() {
    return this.plans.listPlans();
  }
  @Platform('platform.plans.manage')
  @Post('plans')
  createPlan(@Body() body: PlanDto) {
    return this.plans.createPlan(body);
  }
  @Platform('platform.plans.manage')
  @Patch('plans/:id')
  updatePlan(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdatePlanDto) {
    return this.plans.updatePlan(id, body);
  }
  @Platform('platform.plans.manage')
  @Delete('plans/:id')
  @ApiOperation({ summary: 'Delete an unused plan (a plan with subscribers can only be deactivated)' })
  deletePlan(@Param('id', ParseUUIDPipe) id: string) {
    return this.plans.deletePlan(id);
  }

  @Platform('platform.plans.manage', 'platform.billing.manage')
  @Get('coupons')
  listCoupons() {
    return this.plans.listCoupons();
  }
  @Platform('platform.plans.manage')
  @Post('coupons')
  createCoupon(@Body() body: CouponDto) {
    return this.plans.createCoupon(body);
  }
  @Platform('platform.plans.manage')
  @Patch('coupons/:id')
  updateCoupon(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateCouponDto) {
    return this.plans.updateCoupon(id, body);
  }
  @Platform('platform.plans.manage')
  @Delete('coupons/:id')
  deleteCoupon(@Param('id', ParseUUIDPipe) id: string) {
    return this.plans.deleteCoupon(id);
  }
}

// ====================================================================== platform: billing administration
@ApiTags('Platform billing')
@ApiBearerAuth()
@UseInterceptors(MoneyInterceptor)
@Controller('platform/billing')
export class PlatformBillingController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Platform('platform.billing.manage')
  @Get('subscriptions')
  list(@Query() query: SubscriptionListDto) {
    return this.subscriptions.listSubscriptions(query);
  }
  @Platform('platform.billing.manage')
  @Get('tenants/:tenantId')
  @ApiOperation({ summary: 'One centre: subscription, invoices and billing event history' })
  tenant(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.subscriptions.billingOf(tenantId);
  }
  @Platform('platform.billing.manage')
  @Get('tenants/:tenantId/invoices/:id/pdf')
  @ApiProduces('application/pdf')
  async invoicePdf(@Param('tenantId', ParseUUIDPipe) tenantId: string, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    sendPdf(res, await this.subscriptions.invoicePdf(id, tenantId));
  }
  @Platform('platform.billing.manage')
  @Post('tenants/:tenantId/extend-trial')
  @HttpCode(200)
  extendTrial(@Param('tenantId', ParseUUIDPipe) tenantId: string, @Body() body: ExtendTrialDto) {
    return this.subscriptions.extendTrial(tenantId, body);
  }
  @Platform('platform.billing.manage')
  @Post('tenants/:tenantId/coupon')
  @HttpCode(200)
  applyCoupon(@Param('tenantId', ParseUUIDPipe) tenantId: string, @Body() body: ApplyCouponDto) {
    return this.subscriptions.applyCoupon(body.code, tenantId);
  }
  @Platform('platform.billing.manage')
  @Post('tenants/:tenantId/change-plan')
  @HttpCode(200)
  changePlan(@Param('tenantId', ParseUUIDPipe) tenantId: string, @Body() body: AdminChangePlanDto) {
    return this.subscriptions.changePlanOnBehalf(tenantId, body);
  }
  @Platform('platform.billing.manage')
  @Post('invoices/:id/pay-offline')
  @HttpCode(200)
  @ApiOperation({ summary: 'Record a bank transfer (or other offline payment) for a subscription invoice' })
  payOffline(@Param('id', ParseUUIDPipe) id: string, @Body() body: OfflinePaymentDto) {
    return this.subscriptions.recordOfflinePayment(id, body);
  }
  @Platform('platform.billing.manage')
  @Post('invoices/:id/void')
  @HttpCode(200)
  voidInvoice(@Param('id', ParseUUIDPipe) id: string, @Body() body: VoidInvoiceDto) {
    return this.subscriptions.voidInvoice(id, body.reason);
  }
}
