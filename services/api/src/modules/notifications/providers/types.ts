import type { Channel } from '../catalogue';

/** A fully rendered message, ready for a provider. */
export interface OutboundMessage {
  /** Stable id of the notification: used as an idempotency hint where the provider supports one. */
  notificationId?: string;
  /** Email address, E.164 phone number or device token. */
  to: string;
  subject?: string | null;
  text: string;
  html?: string;
  from?: { name: string; address: string };
  replyTo?: string | null;
  /** WhatsApp only: a free-form text reply, allowed within 24 hours of the customer's last message (team inbox). */
  freeForm?: boolean;
  /** Approved WhatsApp Business template (business-initiated messages must use one). */
  whatsapp?: { templateName: string; languageCode: string; parameters: string[] };
  /** Small key/value payload for push notifications (deep-link target). */
  pushData?: Record<string, string>;
}
export interface SendResult {
  providerMessageId?: string | null;
}
export interface ChannelProvider {
  /** Stored on the delivery row, e.g. "smtp", "twilio", "meta", "fcm", "http", "log". */
  readonly name: string;
  readonly channel: Channel;
  send(message: OutboundMessage): Promise<SendResult>;
}

/**
 * A delivery attempt failed. `retryable = false` means trying again cannot
 * help (missing configuration, rejected recipient): the notification is marked
 * FAILED immediately instead of burning the remaining attempts.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable = true,
    public readonly code = 'PROVIDER_ERROR',
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
export const notConfigured = (what: string, how: string) => new ProviderError(`${what} is not configured. ${how}`, false, 'INTEGRATION_NOT_CONFIGURED');

const TIMEOUT_MS = 15_000;

/** JSON / form POST with a timeout. Network failures and 5xx / 429 are retryable; other 4xx are not. */
export async function httpPost(
  provider: string,
  url: string,
  init: { headers: Record<string, string>; body: string },
): Promise<{ status: number; json: any; text: string }> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: init.headers, body: init.body, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
  } catch (e: any) {
    throw new ProviderError(`${provider}: the provider could not be reached (${e?.cause?.code ?? e?.name ?? 'network error'}).`, true, 'NETWORK');
  }
  const text = await res.text().catch(() => '');
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}
export const retryableStatus = (status: number) => status === 408 || status === 425 || status === 429 || status >= 500;
/** Provider error texts are stored on the delivery row: keep them short and free of credentials. */
export const brief = (value: unknown, max = 300) => String(value ?? '').replace(/\s+/g, ' ').slice(0, max);
