import { brief, ChannelProvider, httpPost, OutboundMessage, ProviderError, retryableStatus, SendResult } from './types';

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  /** Sender number in E.164, an alphanumeric sender id, or a Messaging Service SID (MG...). */
  from: string;
  /** Override for tests. */
  baseUrl?: string;
}

/** Twilio Programmable Messaging REST API (form-encoded, HTTP Basic auth). */
export class TwilioSmsProvider implements ChannelProvider {
  readonly name = 'twilio';
  readonly channel = 'SMS' as const;
  constructor(private readonly config: TwilioConfig) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    const base = (this.config.baseUrl ?? 'https://api.twilio.com').replace(/\/$/, '');
    const form = new URLSearchParams({ To: message.to, Body: message.text });
    if (/^MG[0-9a-fA-F]{32}$/.test(this.config.from)) form.set('MessagingServiceSid', this.config.from);
    else form.set('From', this.config.from);
    const res = await httpPost('twilio', `${base}/2010-04-01/Accounts/${encodeURIComponent(this.config.accountSid)}/Messages.json`, {
      headers: {
        authorization: `Basic ${Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: form.toString(),
    });
    if (res.status >= 200 && res.status < 300 && res.json?.sid) return { providerMessageId: String(res.json.sid) };
    throw new ProviderError(`twilio: HTTP ${res.status} ${brief(res.json?.message ?? res.text)}${res.json?.code ? ` (code ${res.json.code})` : ''}`, retryableStatus(res.status), 'TWILIO_ERROR');
  }
}

export interface HttpSmsConfig {
  url: string;
  token: string;
}

/**
 * Generic SMS gateway: POST JSON { to, body } with a bearer token. Lets a centre
 * or operator connect a local aggregator without a dedicated adapter.
 */
export class HttpSmsProvider implements ChannelProvider {
  readonly name = 'http';
  readonly channel = 'SMS' as const;
  constructor(private readonly config: HttpSmsConfig) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    const res = await httpPost('sms gateway', this.config.url, {
      headers: { authorization: `Bearer ${this.config.token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ to: message.to, body: message.text }),
    });
    if (res.status >= 200 && res.status < 300) {
      const id = res.json?.id ?? res.json?.messageId ?? res.json?.message_id ?? null;
      return { providerMessageId: id === null ? null : String(id) };
    }
    throw new ProviderError(`sms gateway: HTTP ${res.status} ${brief(res.json?.message ?? res.json?.error ?? res.text)}`, retryableStatus(res.status), 'SMS_HTTP_ERROR');
  }
}
