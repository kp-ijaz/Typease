import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../common/audit.service';
import { sha256 } from '../../common/crypto';
import { SystemDb } from '../../common/db/prisma.service';
import { Errors } from '../../common/errors';
import { D } from '../../common/pagination';
import { GatewayEvent, WebhookHeaders, WebhookSignatureError } from '../finance/gateways/payment-gateway';
import { isKnownGateway, PaymentGateways } from '../finance/gateways/payment-gateways';
import { BillingCore } from './billing.core';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Deliveries for SaaS billing are de-duplicated in their own namespace, apart from tenant payment webhooks. */
export const webhookNamespace = (gateway: string) => `subscriptions:${gateway}`;

export interface SubscriptionWebhookResult {
  received: true;
  processed: boolean;
  duplicate?: boolean;
  outcome?: string;
  reason?: string;
}

/**
 * Gateway webhooks for SUBSCRIPTION payments (centres paying TypEase).
 *
 * Deliberately separate from the customer-payment webhook: its own route, the
 * platform's own gateway credentials, and it only ever touches
 * subscription_invoices / subscriptions - never the tenants' `payments` table.
 * Same guarantees: signature over the raw body, timestamp tolerance, one
 * recorded delivery per event id, and the invoice is paid exactly once.
 */
@Injectable()
export class SubscriptionWebhookService {
  private readonly logger = new Logger(SubscriptionWebhookService.name);

  constructor(
    private readonly sys: SystemDb,
    private readonly gateways: PaymentGateways,
    private readonly core: BillingCore,
    private readonly audit: AuditService,
  ) {}

  private async locate(event: GatewayEvent) {
    if (event.sessionRef) {
      const hit = await this.sys.client.subscriptionInvoice.findFirst({ where: { gatewayRef: event.sessionRef } });
      if (hit) return hit;
    }
    const id = event.metadata.subscriptionInvoiceId ?? event.metadata.reference;
    return id && UUID.test(id) ? this.sys.client.subscriptionInvoice.findUnique({ where: { id } }) : null;
  }

  async handle(gateway: string, rawBody: Buffer | undefined, headers: WebhookHeaders): Promise<SubscriptionWebhookResult> {
    if (!isKnownGateway(gateway)) throw Errors.notFound('Payment gateway');
    const adapter = this.gateways.platformByName(gateway);
    if (!adapter) throw Errors.notFound('Payment gateway');
    if (!rawBody?.length) throw Errors.badRequest('EMPTY_BODY', 'The webhook has no body.');
    const payloadHash = sha256(rawBody);
    const namespace = webhookNamespace(gateway);

    let event: GatewayEvent;
    try {
      event = adapter.verifyWebhook(rawBody, headers);
    } catch (e) {
      if (e instanceof WebhookSignatureError) {
        await this.audit.security('WEBHOOK_SIGNATURE_INVALID', 'HIGH', { gateway, channel: 'subscriptions', reason: e.reason, payloadHash }, null);
        throw Errors.badRequest('WEBHOOK_SIGNATURE_INVALID', 'The webhook signature could not be verified.');
      }
      throw e;
    }
    const invoice = await this.locate(event);

    let record = await this.sys.client.paymentWebhookEvent.findUnique({ where: { gateway_eventId: { gateway: namespace, eventId: event.id } } });
    if (record && ['PROCESSED', 'IGNORED'].includes(record.status)) return { received: true, processed: false, duplicate: true };
    if (!record) {
      try {
        record = await this.sys.client.paymentWebhookEvent.create({ data: { gateway: namespace, eventId: event.id, tenantId: invoice?.tenantId ?? null, eventType: event.rawType, signatureValid: true, payloadHash, status: 'RECEIVED' } });
      } catch (e: any) {
        if (e?.code === 'P2002') return { received: true, processed: false, duplicate: true };
        throw e;
      }
    }
    const finish = (status: 'PROCESSED' | 'IGNORED' | 'FAILED', error?: string) =>
      this.sys.client.paymentWebhookEvent.update({ where: { id: record!.id }, data: { status, error: error?.slice(0, 1000) ?? null, processedAt: new Date() } });

    if (!invoice || event.type === 'ignored') {
      await finish('IGNORED', !invoice ? 'No matching subscription invoice.' : `Event type ${event.rawType} is not handled.`);
      return { received: true, processed: false, reason: !invoice ? 'UNKNOWN_REFERENCE' : 'EVENT_NOT_HANDLED' };
    }
    try {
      if (event.type === 'payment.failed') {
        const reason = (event.failureReason ?? 'The payment was not completed.').slice(0, 500);
        await this.core.tx(async (tx) => {
          const changed = await tx.subscriptionInvoice.updateMany({ where: { id: invoice.id, status: 'OPEN' }, data: { lastError: reason } });
          if (changed.count) await this.core.record(tx, { id: invoice.subscriptionId, tenantId: invoice.tenantId }, 'CHECKOUT_FAILED', { invoiceId: invoice.id, number: invoice.number, gateway, reason });
          if (changed.count) this.core.emit('subscription.payment_failed', { subscriptionId: invoice.subscriptionId, invoiceId: invoice.id, invoiceNumber: invoice.number, amount: D(invoice.total).toFixed(2), currency: invoice.currency, reason, attempt: null }, invoice.tenantId);
        });
        await finish('PROCESSED');
        return { received: true, processed: true, outcome: 'FAILED' };
      }
      if ((event.amount !== null && !D(event.amount).equals(invoice.total)) || (event.currency !== null && event.currency !== invoice.currency)) {
        const reason = `The gateway reported ${event.currency ?? ''} ${event.amount ?? '?'} but ${invoice.currency} ${D(invoice.total).toFixed(2)} was expected.`;
        await finish('FAILED', reason);
        await this.audit.security('WEBHOOK_AMOUNT_MISMATCH', 'HIGH', { gateway, channel: 'subscriptions', eventId: event.id, invoiceId: invoice.id, reason }, invoice.tenantId);
        return { received: true, processed: false, outcome: 'REJECTED', reason: 'AMOUNT_MISMATCH' };
      }
      const result = await this.core.tx((tx) => this.core.markPaid(tx, invoice.id, { method: `ONLINE:${gateway}`, reference: event.paymentRef ?? event.sessionRef }));
      if (result.outcome === 'PAID') {
        await finish('PROCESSED');
        return { received: true, processed: true, outcome: 'PAID' };
      }
      await finish('IGNORED', `Invoice is ${result.invoice.status}.`);
      if (result.outcome === 'NOT_PAYABLE') {
        // Money arrived for an invoice that is void: someone has to refund or re-apply it.
        await this.core.tx((tx) => this.core.record(tx, { id: invoice.subscriptionId, tenantId: invoice.tenantId }, 'PAYMENT_FOR_CLOSED_INVOICE', { invoiceId: invoice.id, number: invoice.number, status: result.invoice.status, gateway, paymentRef: event.paymentRef }));
        await this.audit.security('WEBHOOK_PAYMENT_NOT_PENDING', 'MEDIUM', { gateway, channel: 'subscriptions', eventId: event.id, invoiceId: invoice.id, status: result.invoice.status }, invoice.tenantId);
      }
      return { received: true, processed: false, outcome: result.outcome };
    } catch (e: any) {
      this.logger.error(`subscription webhook ${gateway}/${event.id} failed: ${e?.stack ?? e}`);
      await finish('FAILED', String(e?.message ?? e)).catch(() => undefined);
      throw e;
    }
  }
}
