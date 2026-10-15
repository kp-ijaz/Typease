import nodemailer, { Transporter } from 'nodemailer';
import { brief, ChannelProvider, OutboundMessage, ProviderError, SendResult } from './types';

export interface SmtpConfig {
  host: string;
  port: number;
  /** true = implicit TLS (port 465). false = plain connection upgraded with STARTTLS when offered. */
  secure: boolean;
  user?: string | null;
  password?: string | null;
  /** Refuse to send unless the connection is encrypted. */
  requireTls?: boolean;
  /** Used when the message carries no explicit sender. */
  defaultFrom: { name: string; address: string };
}

/** SMTP email through nodemailer. One pooled transporter per provider instance. */
export class SmtpEmailProvider implements ChannelProvider {
  readonly name = 'smtp';
  readonly channel = 'EMAIL' as const;
  private transporter?: Transporter;
  constructor(private readonly config: SmtpConfig) {}

  private transport(): Transporter {
    this.transporter ??= nodemailer.createTransport({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      requireTLS: this.config.requireTls === true && !this.config.secure,
      auth: this.config.user ? { user: this.config.user, pass: this.config.password ?? '' } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    return this.transporter;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const from = message.from ?? this.config.defaultFrom;
    try {
      const info = await this.transport().sendMail({
        from: { name: from.name, address: from.address },
        to: message.to,
        replyTo: message.replyTo ?? undefined,
        subject: message.subject ?? '',
        text: message.text,
        html: message.html,
        // A stable Message-ID lets receiving servers discard a duplicate if an attempt is ever repeated.
        messageId: message.notificationId ? `<${message.notificationId}@${from.address.split('@')[1] ?? 'typease.local'}>` : undefined,
        headers: { 'X-Auto-Response-Suppress': 'All', 'Auto-Submitted': 'auto-generated' },
      });
      if (info.rejected?.length) throw new ProviderError(`smtp: the server rejected the recipient ${brief(info.rejected.join(', '), 120)}.`, false, 'RECIPIENT_REJECTED');
      return { providerMessageId: info.messageId ?? null };
    } catch (e: any) {
      if (e instanceof ProviderError) throw e;
      // 5xx replies are permanent (bad mailbox, policy); 4xx replies and connection problems are worth another attempt.
      const code = Number(e?.responseCode ?? 0);
      const permanent = code >= 500 && code < 600;
      throw new ProviderError(`smtp: ${brief(e?.response ?? e?.message ?? e)}`, !permanent, e?.code ?? 'SMTP_ERROR');
    }
  }
  close() {
    this.transporter?.close();
    this.transporter = undefined;
  }
}
