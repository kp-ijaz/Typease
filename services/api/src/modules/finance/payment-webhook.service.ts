import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../common/audit.service';
import { runAsTenant } from '../../common/context';
import { sha256 } from '../../common/crypto';
import { SystemDb } from '../../common/db/prisma.service';
import { Errors } from '../../common/errors';
import { GatewayEvent, PaymentGateway, WebhookHeaders, WebhookSignatureError } from './gateways/payment-gateway';
import { isKnownGateway, PaymentGateways } from './gateways/payment-gateways';
import { PaymentsService } from './payments.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WebhookResult {
  received: true;
  /** true when this delivery changed something. */
  processed: boolean;
  duplicate?: boolean;
  outcome?: string;
  reason?: string;
}

/**
 * Intake of gateway webhooks for CUSTOMER payments.
 *
 * A webhook arrives without a tenant session, so this is one of the few places
 * that uses the system connection: it finds the payment (and therefore the
 * tenant) the delivery is about, verifies the signature with that tenant's
 * gateway credentials, records the delivery in `payment_webhook_events`
 * (unique gateway + event id) and then performs the business change inside the
 * tenant's own row-level-security context.
 *
 * Guarantees:
 *   - nothing is recorded or changed before the signature over the RAW body is verified;
 *   - stale deliveries are rejected (timestamp tolerance) - replay resistant;
 *   - a duplicate delivery returns 200 and does nothing;
 *   - a delivery whose processing crashed is processed when the gateway retries it;
 *   - the payment itself completes exactly once (conditional update PENDING -> COMPLETED).
 */
@Injectable()
export class PaymentWebhookService {
  private readonly logger = new Logger(PaymentWebhookService.name);

  constructor(
    private readonly sys: SystemDb,
    private readonly gateways: PaymentGateways,
    private readonly payments: PaymentsService,
    private readonly audit: AuditService,
  ) {}

  private async locate(gateway: string, ref: { sessionRef: string | null; paymentRef: string | null; reference?: string | null } | null) {
    const select = { id: true, tenantId: true } as const;
    if (!ref) return null;
    if (ref.sessionRef) {
      const hit = await this.sys.client.payment.findFirst({ where: { gateway, gatewaySessionRef: ref.sessionRef }, select });
      if (hit) return hit;
    }
    if (ref.paymentRef) {
      const hit = await this.sys.client.payment.findFirst({ where: { gateway, gatewayPaymentRef: ref.paymentRef }, select });
      if (hit) return hit;
    }
    // Our own payment id, echoed back by the gateway (covers a session reference that was never stored).
    if (ref.reference && UUID.test(ref.reference)) return this.sys.client.payment.findFirst({ where: { id: ref.reference, gateway, method: 'ONLINE_GATEWAY' }, select });
    return null;
  }

  async handle(gateway: string, rawBody: Buffer | undefined, headers: WebhookHeaders): Promise<WebhookResult> {
    if (!isKnownGateway(gateway)) throw Errors.notFound('Payment gateway');
    if (!rawBody?.length) throw Errors.badRequest('EMPTY_BODY', 'The webhook has no body.');
    const payloadHash = sha256(rawBody);

    // 1. Whose delivery is this? (unverified pointers, used only to pick the secret)
    const peeked = this.gateways.peek(gateway, rawBody);
    let payment = await this.locate(gateway, peeked ? { ...peeked, reference: referenceOf(rawBody) } : null);

    // 2. The adapter holding the secret that must verify it.
    let adapter: PaymentGateway | null;
    if (gateway === 'sandbox') adapter = this.gateways.platformByName('sandbox');
    else adapter = payment ? await runAsTenant(payment.tenantId, () => this.gateways.forTenantByName(gateway)) : null;
    if (!adapter) {
      if (gateway === 'sandbox') throw Errors.notFound('Payment gateway');
      if (!payment) {
        // Not one of our checkouts (for example another system using the same gateway account). Nothing can or should be done.
        await this.audit.security('WEBHOOK_UNMATCHED', 'LOW', { gateway, channel: 'payments', payloadHash }, null);
        return { received: true, processed: false, reason: 'UNKNOWN_REFERENCE' };
      }
      await this.audit.security('WEBHOOK_SIGNATURE_INVALID', 'HIGH', { gateway, channel: 'payments', reason: 'GATEWAY_NOT_CONFIGURED', payloadHash }, payment.tenantId);
      throw Errors.badRequest('WEBHOOK_SIGNATURE_INVALID', 'The webhook signature could not be verified.');
    }

    // 3. Signature + timestamp over the raw body.
    let event: GatewayEvent;
    try {
      event = adapter.verifyWebhook(rawBody, headers);
    } catch (e) {
      if (e instanceof WebhookSignatureError) {
        await this.audit.security('WEBHOOK_SIGNATURE_INVALID', 'HIGH', { gateway, channel: 'payments', reason: e.reason, payloadHash }, payment?.tenantId ?? null);
        throw Errors.badRequest('WEBHOOK_SIGNATURE_INVALID', 'The webhook signature could not be verified.');
      }
      throw e;
    }
    // From here on only verified data is used.
    payment = (await this.locate(gateway, { sessionRef: event.sessionRef, paymentRef: event.paymentRef, reference: event.metadata.paymentId ?? event.metadata.reference ?? null })) ?? null;

    // 4. Duplicate / replay protection.
    let record = await this.sys.client.paymentWebhookEvent.findUnique({ where: { gateway_eventId: { gateway, eventId: event.id } } });
    if (record && ['PROCESSED', 'IGNORED'].includes(record.status)) return { received: true, processed: false, duplicate: true };
    if (!record) {
      try {
        record = await this.sys.client.paymentWebhookEvent.create({
          data: { gateway, eventId: event.id, tenantId: payment?.tenantId ?? null, eventType: event.rawType, signatureValid: true, payloadHash, status: 'RECEIVED' },
        });
      } catch (e: any) {
        if (e?.code === 'P2002') return { received: true, processed: false, duplicate: true }; // a parallel delivery of the same event is handling it
        throw e;
      }
    }
    const finish = (status: 'PROCESSED' | 'IGNORED' | 'FAILED', error?: string) =>
      this.sys.client.paymentWebhookEvent.update({ where: { id: record!.id }, data: { status, error: error?.slice(0, 1000) ?? null, processedAt: new Date() } });

    // 5. Business change inside the tenant's own context.
    if (!payment || event.type === 'ignored') {
      await finish('IGNORED', !payment ? 'No matching payment.' : `Event type ${event.rawType} is not handled.`);
      return { received: true, processed: false, reason: !payment ? 'UNKNOWN_REFERENCE' : 'EVENT_NOT_HANDLED' };
    }
    const target = payment;
    try {
      const result = await runAsTenant(
        target.tenantId,
        () => (event.type === 'payment.succeeded' ? this.payments.completeOnline(target.id, event) : this.payments.failOnline(target.id, event)),
        { actorLabel: `webhook:${gateway}` },
      );
      if (result.outcome === 'REJECTED') {
        await finish('FAILED', result.reason);
        await this.audit.security('WEBHOOK_AMOUNT_MISMATCH', 'HIGH', { gateway, eventId: event.id, paymentId: target.id, reason: result.reason }, target.tenantId);
        return { received: true, processed: false, outcome: result.outcome, reason: 'AMOUNT_MISMATCH' };
      }
      if (result.outcome === 'IGNORED') {
        await finish('IGNORED', result.reason);
        if (event.type === 'payment.succeeded') {
          // Money arrived for a payment we no longer consider open: a person has to look at it.
          await this.audit.security('WEBHOOK_PAYMENT_NOT_PENDING', 'MEDIUM', { gateway, eventId: event.id, paymentId: target.id, reason: result.reason }, target.tenantId);
        }
        return { received: true, processed: false, outcome: result.outcome };
      }
      await finish('PROCESSED');
      return { received: true, processed: true, outcome: result.outcome };
    } catch (e: any) {
      // Left as FAILED so the gateway's retry of the same event is processed again.
      this.logger.error(`webhook ${gateway}/${event.id} failed: ${e?.stack ?? e}`);
      await finish('FAILED', String(e?.message ?? e)).catch(() => undefined);
      throw e;
    }
  }
}

/** Our own reference echoed by the gateway (unverified at this point). */
function referenceOf(rawBody: Buffer): string | null {
  try {
    const body = JSON.parse(rawBody.toString('utf8'));
    const v = body?.data?.reference ?? body?.data?.object?.client_reference_id ?? body?.data?.object?.metadata?.paymentId ?? null;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}
