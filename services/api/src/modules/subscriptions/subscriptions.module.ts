import { Module } from '@nestjs/common';
import { PaymentGatewayModule } from '../finance/gateways/payment-gateways';
import { BillingClock } from './billing-clock';
import { BillingCore } from './billing.core';
import { SubscriptionLifecycle } from './lifecycle.service';
import { PlansService } from './plans.service';
import { SubscriptionWebhookService } from './subscription-webhook.service';
import { PlatformBillingController, PlatformPlansController, PublicPlansController, SubscriptionController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';

/**
 * SaaS billing of typing centres by TypEase: plans, coupons, subscriptions,
 * subscription invoices and their lifecycle. It shares the payment gateway
 * ADAPTERS with the finance module (PaymentGatewayModule) but nothing else:
 * its own webhook route, its own tables, the platform's own credentials.
 */
@Module({
  imports: [PaymentGatewayModule],
  controllers: [PublicPlansController, SubscriptionController, PlatformPlansController, PlatformBillingController],
  providers: [BillingClock, BillingCore, PlansService, SubscriptionsService, SubscriptionLifecycle, SubscriptionWebhookService],
  exports: [BillingClock, BillingCore, SubscriptionsService],
})
export class SubscriptionsModule {}
