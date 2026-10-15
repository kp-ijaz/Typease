import { Logger } from '@nestjs/common';
import type { Channel } from '../catalogue';
import { ChannelProvider, OutboundMessage, SendResult } from './types';

/**
 * Development / test provider: nothing leaves the process. The rendered
 * message is written to the log and kept in a small in-memory outbox so local
 * flows (and tests) can read what would have been sent. The registry refuses
 * to hand this provider out in production.
 */
export class LogProvider implements ChannelProvider {
  static readonly outbox: Array<{ channel: Channel; message: OutboundMessage; at: Date }> = [];
  private static counter = 0;
  private readonly logger = new Logger('NotificationLog');
  readonly name = 'log';
  constructor(readonly channel: Channel) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    LogProvider.outbox.push({ channel: this.channel, message, at: new Date() });
    if (LogProvider.outbox.length > 500) LogProvider.outbox.shift();
    this.logger.log(`[${this.channel}] to=${message.to}${message.subject ? ` subject="${message.subject}"` : ''}\n${message.text}`);
    return { providerMessageId: `log-${++LogProvider.counter}` };
  }
  static lastFor(to: string, channel?: Channel) {
    for (let i = LogProvider.outbox.length - 1; i >= 0; i--) {
      const entry = LogProvider.outbox[i];
      if (entry.message.to === to && (!channel || entry.channel === channel)) return entry;
    }
    return undefined;
  }
}
