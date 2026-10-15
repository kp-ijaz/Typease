import { Injectable, Logger } from '@nestjs/common';
import type { NotificationEventKey } from '@typease/types';
import { env } from '../config/env';

export interface TransactionalMessage {
  /** Template key, e.g. account.email_verification */
  eventKey: NotificationEventKey;
  channel: 'EMAIL' | 'SMS';
  to: string;
  language?: string;
  tenantId?: string | null;
  /** Template variables. Secrets (links, codes) are passed here and never logged in production. */
  data: Record<string, string | number | null | undefined>;
}
type Transport = (message: TransactionalMessage) => Promise<void>;

/**
 * Account-security messages (verification, password reset, OTP, invitations).
 * These bypass marketing preferences and must be delivered even before a tenant
 * exists, so the auth module depends on this small port instead of the full
 * notification module, which plugs its transport in at start-up.
 */
@Injectable()
export class Messenger {
  private readonly logger = new Logger(Messenger.name);
  private transport?: Transport;
  /** Captured messages (test / development only). */
  readonly captured: TransactionalMessage[] = [];

  setTransport(transport: Transport) {
    this.transport = transport;
  }

  async send(message: TransactionalMessage): Promise<void> {
    if (env().NODE_ENV !== 'production') {
      this.captured.push(message);
      if (this.captured.length > 500) this.captured.shift();
    }
    if (!this.transport) {
      if (env().NODE_ENV === 'production') {
        this.logger.error(`No transport for ${message.eventKey}: message to ${mask(message.to)} was NOT sent.`);
      } else {
        this.logger.log(`[dev message] ${message.channel} ${message.eventKey} -> ${message.to} ${JSON.stringify(message.data)}`);
      }
      return;
    }
    await this.transport(message);
  }

  lastFor(to: string, eventKey?: string): TransactionalMessage | undefined {
    for (let i = this.captured.length - 1; i >= 0; i--) {
      const m = this.captured[i];
      if (m.to === to && (!eventKey || m.eventKey === eventKey)) return m;
    }
    return undefined;
  }
}

const mask = (v: string) => (v.includes('@') ? v.replace(/^(.).*(@.*)$/, '$1***$2') : v.replace(/.(?=.{3})/g, '*'));
