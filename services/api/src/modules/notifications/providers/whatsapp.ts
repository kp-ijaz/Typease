import { brief, ChannelProvider, httpPost, OutboundMessage, ProviderError, retryableStatus, SendResult } from './types';

export interface MetaWhatsAppConfig {
  phoneNumberId: string;
  accessToken: string;
  /** Graph API version. */
  apiVersion?: string;
  /** Override for tests. */
  baseUrl?: string;
}

/**
 * Meta WhatsApp Business Cloud API. Business-initiated messages must use a
 * template approved by Meta, so this adapter only sends TEMPLATE messages; the
 * notification service suppresses WhatsApp notifications that have no approved
 * template name before they ever reach it.
 */
export class MetaWhatsAppProvider implements ChannelProvider {
  readonly name = 'meta';
  readonly channel = 'WHATSAPP' as const;
  constructor(private readonly config: MetaWhatsAppConfig) {}

  private get base() {
    return `${(this.config.baseUrl ?? 'https://graph.facebook.com').replace(/\/$/, '')}/${this.config.apiVersion ?? 'v21.0'}`;
  }

  /** Media a customer sent (photo, PDF): two calls, the media URL first, then the file with the same token. */
  async downloadMedia(mediaId: string): Promise<{ data: Buffer; mime: string }> {
    const auth = { authorization: `Bearer ${this.config.accessToken}` };
    const meta = await fetch(`${this.base}/${encodeURIComponent(mediaId)}`, { headers: auth, signal: AbortSignal.timeout(15_000), redirect: 'error' }).catch(() => null);
    const info = meta && meta.ok ? ((await meta.json()) as { url?: string; mime_type?: string }) : null;
    if (!info?.url || !/^https:\/\//.test(info.url)) throw new ProviderError('meta: the media could not be found.', false, 'META_MEDIA');
    const file = await fetch(info.url, { headers: auth, signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (!file || !file.ok) throw new ProviderError('meta: the media could not be downloaded.', true, 'META_MEDIA');
    const data = Buffer.from(await file.arrayBuffer());
    if (data.length > 20 * 1024 * 1024) throw new ProviderError('meta: the media is larger than 20 MB.', false, 'META_MEDIA');
    return { data, mime: info.mime_type ?? 'application/octet-stream' };
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (message.freeForm) {
      const res = await httpPost('meta', `${this.base}/${encodeURIComponent(this.config.phoneNumberId)}/messages`, {
        headers: { authorization: `Bearer ${this.config.accessToken}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: message.to.replace(/^\+/, ''), type: 'text', text: { body: message.text, preview_url: false } }),
      });
      const id = res.json?.messages?.[0]?.id;
      if (res.status >= 200 && res.status < 300 && id) return { providerMessageId: String(id) };
      const err = res.json?.error;
      throw new ProviderError(`meta: HTTP ${res.status} ${brief(err?.message ?? res.text)}${err?.code ? ` (code ${err.code})` : ''}`, retryableStatus(res.status), 'META_ERROR');
    }
    if (!message.whatsapp?.templateName) throw new ProviderError('meta: an approved WhatsApp template is required for this message.', false, 'WHATSAPP_TEMPLATE_REQUIRED');
    const base = (this.config.baseUrl ?? 'https://graph.facebook.com').replace(/\/$/, '');
    const version = this.config.apiVersion ?? 'v21.0';
    const parameters = message.whatsapp.parameters.map((text) => ({ type: 'text', text }));
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: message.to.replace(/^\+/, ''),
      type: 'template',
      template: {
        name: message.whatsapp.templateName,
        language: { code: message.whatsapp.languageCode },
        ...(parameters.length ? { components: [{ type: 'body', parameters }] } : {}),
      },
    };
    const res = await httpPost('meta', `${base}/${version}/${encodeURIComponent(this.config.phoneNumberId)}/messages`, {
      headers: { authorization: `Bearer ${this.config.accessToken}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const id = res.json?.messages?.[0]?.id;
    if (res.status >= 200 && res.status < 300 && id) return { providerMessageId: String(id) };
    const err = res.json?.error;
    throw new ProviderError(`meta: HTTP ${res.status} ${brief(err?.message ?? res.text)}${err?.code ? ` (code ${err.code})` : ''}`, retryableStatus(res.status), 'META_ERROR');
  }
}
