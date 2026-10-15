import { Injectable, Module } from '@nestjs/common';
import { env } from '../../../config/env';
import { decryptJson } from '../../../common/crypto';
import { TenantDb, Tx } from '../../../common/db/prisma.service';
import { Errors } from '../../../common/errors';
import { PaymentGateway, PeekedReference } from './payment-gateway';
import { SandboxCheckoutController } from './sandbox.controller';
import { SandboxGateway } from './sandbox.gateway';
import { StripeGateway } from './stripe.gateway';

export const KNOWN_GATEWAYS = ['sandbox', 'stripe'] as const;
export type GatewayName = (typeof KNOWN_GATEWAYS)[number];
export const isKnownGateway = (name: string): name is GatewayName => (KNOWN_GATEWAYS as readonly string[]).includes(name);

const TENANT_HELP = 'Ask the centre owner to connect a payment gateway in Settings > Integrations. Cash, card-machine, bank-transfer and cheque payments can still be recorded.';
const PLATFORM_HELP = 'Online subscription payments are not available yet. Please contact TypEase support to pay by bank transfer.';

/**
 * Selects the payment gateway adapter.
 *
 *  - Tenant flow (customers paying a typing centre): the tenant's ACTIVE
 *    Integration row of category PAYMENT, credentials decrypted from `secretsEnc`.
 *  - Platform flow (centres paying TypEase): environment configuration.
 *
 * A configured real gateway always wins over the sandbox, so test payments are
 * never taken by accident once real credentials exist. The sandbox additionally
 * requires PAYMENT_SANDBOX_ENABLED (forced off in production).
 */
@Injectable()
export class PaymentGateways {
  constructor(private readonly db: TenantDb) {}

  /** Unverified session / payment reference of a webhook body, used only to locate whose secret verifies it. */
  peek(name: string, rawBody: Buffer): PeekedReference | null {
    if (name === 'sandbox') return SandboxGateway.peek(rawBody);
    if (name === 'stripe') return StripeGateway.peek(rawBody);
    return null;
  }

  private sandbox(): PaymentGateway | null {
    return env().PAYMENT_SANDBOX_ENABLED ? new SandboxGateway() : null;
  }

  private async tenantRows(tx: Tx) {
    return tx.integration.findMany({ where: { tenantId: this.db.tenantId, category: 'PAYMENT', status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } });
  }
  private build(row: { provider: string; secretsEnc: string | null }): PaymentGateway | null {
    if (row.provider === 'sandbox') return this.sandbox();
    if (row.provider === 'stripe') {
      if (!row.secretsEnc) return null;
      const secrets = decryptJson<{ secretKey?: string; webhookSecret?: string }>(row.secretsEnc);
      if (!secrets.secretKey) return null;
      return new StripeGateway({ secretKey: secrets.secretKey, webhookSecret: secrets.webhookSecret ?? null });
    }
    return null;
  }

  /** Gateway for new online payments of the current tenant. 503 INTEGRATION_NOT_CONFIGURED when there is none. */
  async forTenant(tx?: Tx): Promise<PaymentGateway> {
    const load = async (t: Tx) => {
      const gateways = (await this.tenantRows(t)).map((r) => this.build(r)).filter((g): g is PaymentGateway => !!g);
      const chosen = gateways.find((g) => g.name !== 'sandbox') ?? gateways[0];
      if (!chosen) throw Errors.notConfigured('Online payment', TENANT_HELP);
      return chosen;
    };
    return tx ? load(tx) : this.db.tx(load);
  }

  /** The specific gateway a payment was taken with (webhooks, refunds). Null when it is no longer configured. */
  async forTenantByName(name: string, tx?: Tx): Promise<PaymentGateway | null> {
    const load = async (t: Tx) => {
      const row = (await this.tenantRows(t)).find((r) => r.provider === name);
      return row ? this.build(row) : null;
    };
    return tx ? load(tx) : this.db.tx(load);
  }

  /** Platform gateway by name (subscription webhooks). Null when not configured. */
  platformByName(name: string): PaymentGateway | null {
    if (name === 'stripe') {
      const key = env().STRIPE_SECRET_KEY;
      return key ? new StripeGateway({ secretKey: key, webhookSecret: env().STRIPE_WEBHOOK_SECRET ?? null }) : null;
    }
    if (name === 'sandbox') return this.sandbox();
    return null;
  }
  /** Gateway for SaaS subscription payments. */
  platform(): PaymentGateway {
    const gateway = this.platformByName('stripe') ?? this.platformByName('sandbox');
    if (!gateway) throw Errors.notConfigured('Online payment', PLATFORM_HELP);
    return gateway;
  }
}

/** Shared by the finance module (customer payments) and the subscriptions module (SaaS billing). */
@Module({ controllers: [SandboxCheckoutController], providers: [PaymentGateways], exports: [PaymentGateways] })
export class PaymentGatewayModule {}
