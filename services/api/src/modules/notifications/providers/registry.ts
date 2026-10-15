import { Injectable, Logger } from '@nestjs/common';
import { env } from '../../../config/env';
import { decryptJson, sha256 } from '../../../common/crypto';
import { TenantDb, Tx } from '../../../common/db/prisma.service';
import type { Channel } from '../catalogue';
import { SmtpEmailProvider } from './email';
import { LogProvider } from './log';
import { assertAllowedHttpEndpoint, assertPublicHost } from './net-guard';
import { FcmPushProvider } from './push';
import { HttpSmsProvider, TwilioSmsProvider } from './sms';
import { ChannelProvider, notConfigured, ProviderError } from './types';
import { MetaWhatsAppProvider } from './whatsapp';

export type ProviderChannel = Exclude<Channel, 'IN_APP'>;
export const PROVIDER_CHANNELS: ProviderChannel[] = ['EMAIL', 'SMS', 'WHATSAPP', 'PUSH'];

export interface ResolvedProvider {
  provider: ChannelProvider;
  /** TENANT = the centre's own integration, PLATFORM = TypEase default from the environment. */
  source: 'TENANT' | 'PLATFORM';
  /** Non-secret settings of the integration (sender address, WhatsApp language codes ...). */
  settings: Record<string, any>;
}
export interface ChannelStatus {
  channel: Channel;
  provider: string | null;
  source: 'TENANT' | 'PLATFORM' | 'BUILT_IN' | 'NONE';
  configured: boolean;
  /** Plain-language explanation when the channel cannot send. */
  detail: string | null;
}

const HOW = 'Add the credentials in Settings > Integrations, or ask TypEase support to enable the platform provider.';
const LABEL: Record<ProviderChannel, string> = { EMAIL: 'Email delivery', SMS: 'SMS delivery', WHATSAPP: 'WhatsApp Business', PUSH: 'Push notifications' };

function parseServiceAccount(raw: string): { client_email: string; private_key: string; private_key_id?: string } {
  let text = raw.trim();
  if (!text.startsWith('{')) text = Buffer.from(text, 'base64').toString('utf8');
  const parsed = JSON.parse(text);
  if (typeof parsed?.client_email !== 'string' || typeof parsed?.private_key !== 'string') throw new Error('missing client_email / private_key');
  return parsed;
}

/**
 * Chooses the provider for a channel: the tenant's own ACTIVE integration wins,
 * otherwise the platform default from the environment. Nothing is invented: a
 * channel without usable credentials yields INTEGRATION_NOT_CONFIGURED, and the
 * `log` driver is refused in production so a message can never "succeed"
 * without being sent.
 *
 * Expected integration rows (table integration_credentials_metadata), written by the integrations module:
 *   EMAIL    / smtp    config { host, port, secure, requireTls?, fromAddress?, fromName? }   secrets { user, password }
 *   SMS      / twilio  config { accountSid, from }                                           secrets { authToken }
 *   SMS      / http    config { url }                                                        secrets { token }
 *   WHATSAPP / meta    config { phoneNumberId, apiVersion?, languageCodes? { en, ar } }      secrets { accessToken }
 *   PUSH     / fcm     config { projectId }                                                  secrets { serviceAccountJson }
 */
@Injectable()
export class ProviderRegistry {
  private readonly logger = new Logger(ProviderRegistry.name);
  private readonly cache = new Map<string, ChannelProvider>();
  /** Tests only: force a provider for a channel. */
  private readonly overrides = new Map<ProviderChannel, ChannelProvider>();

  constructor(private readonly db: TenantDb) {}

  setOverride(channel: ProviderChannel, provider: ChannelProvider | null) {
    if (env().NODE_ENV === 'production') throw new Error('Provider overrides are not available in production.');
    if (provider) this.overrides.set(channel, provider);
    else this.overrides.delete(channel);
  }

  private cached(key: string, build: () => ChannelProvider): ChannelProvider {
    const hit = this.cache.get(key);
    if (hit) return hit;
    if (this.cache.size > 200) this.cache.clear();
    const provider = build();
    this.cache.set(key, provider);
    return provider;
  }
  private log(channel: ProviderChannel): ChannelProvider {
    if (env().NODE_ENV === 'production') throw notConfigured(LABEL[channel], HOW);
    return this.cached(`log:${channel}`, () => new LogProvider(channel));
  }

  /** Platform default for a channel, from the environment. */
  platform(channel: ProviderChannel): ResolvedProvider {
    const e = env();
    const override = this.overrides.get(channel);
    if (override) return { provider: override, source: 'PLATFORM', settings: {} };
    const settings: Record<string, any> = {};
    let provider: ChannelProvider;
    switch (channel) {
      case 'EMAIL':
        if (e.MAIL_DRIVER === 'log') provider = this.log(channel);
        else {
          if (!e.SMTP_HOST) throw notConfigured(LABEL.EMAIL, 'Set SMTP_HOST (and SMTP_USER / SMTP_PASSWORD) for the platform mail server.');
          provider = this.cached(`env:smtp:${sha256([e.SMTP_HOST, e.SMTP_PORT, e.SMTP_SECURE, e.SMTP_USER, e.SMTP_PASSWORD].join('|'))}`, () =>
            new SmtpEmailProvider({
              host: e.SMTP_HOST!,
              port: e.SMTP_PORT,
              secure: e.SMTP_SECURE,
              user: e.SMTP_USER,
              password: e.SMTP_PASSWORD,
              requireTls: e.NODE_ENV === 'production',
              defaultFrom: { name: e.MAIL_FROM_NAME, address: e.MAIL_FROM_ADDRESS },
            }),
          );
        }
        break;
      case 'SMS':
        if (e.SMS_DRIVER === 'log') provider = this.log(channel);
        else if (e.SMS_DRIVER === 'twilio') {
          if (!e.TWILIO_ACCOUNT_SID || !e.TWILIO_AUTH_TOKEN || !e.TWILIO_FROM) throw notConfigured(LABEL.SMS, 'Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM.');
          provider = this.cached(`env:twilio:${sha256([e.TWILIO_ACCOUNT_SID, e.TWILIO_AUTH_TOKEN, e.TWILIO_FROM].join('|'))}`, () =>
            new TwilioSmsProvider({ accountSid: e.TWILIO_ACCOUNT_SID!, authToken: e.TWILIO_AUTH_TOKEN!, from: e.TWILIO_FROM! }),
          );
        } else {
          if (!e.SMS_HTTP_URL || !e.SMS_HTTP_TOKEN) throw notConfigured(LABEL.SMS, 'Set SMS_HTTP_URL and SMS_HTTP_TOKEN.');
          provider = this.cached(`env:http:${sha256([e.SMS_HTTP_URL, e.SMS_HTTP_TOKEN].join('|'))}`, () => new HttpSmsProvider({ url: e.SMS_HTTP_URL!, token: e.SMS_HTTP_TOKEN! }));
        }
        break;
      case 'WHATSAPP':
        if (e.WHATSAPP_DRIVER === 'log') provider = this.log(channel);
        else {
          if (!e.WHATSAPP_PHONE_NUMBER_ID || !e.WHATSAPP_ACCESS_TOKEN) throw notConfigured(LABEL.WHATSAPP, 'Set WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN.');
          provider = this.cached(`env:meta:${sha256([e.WHATSAPP_PHONE_NUMBER_ID, e.WHATSAPP_ACCESS_TOKEN].join('|'))}`, () =>
            new MetaWhatsAppProvider({ phoneNumberId: e.WHATSAPP_PHONE_NUMBER_ID!, accessToken: e.WHATSAPP_ACCESS_TOKEN! }),
          );
        }
        break;
      case 'PUSH':
        if (e.PUSH_DRIVER === 'log') provider = this.log(channel);
        else {
          if (!e.FCM_PROJECT_ID || !e.FCM_SERVICE_ACCOUNT_JSON) throw notConfigured(LABEL.PUSH, 'Set FCM_PROJECT_ID and FCM_SERVICE_ACCOUNT_JSON.');
          provider = this.cached(`env:fcm:${sha256([e.FCM_PROJECT_ID, e.FCM_SERVICE_ACCOUNT_JSON].join('|'))}`, () => {
            try {
              return new FcmPushProvider({ projectId: e.FCM_PROJECT_ID!, serviceAccount: parseServiceAccount(e.FCM_SERVICE_ACCOUNT_JSON!) });
            } catch {
              throw notConfigured(LABEL.PUSH, 'FCM_SERVICE_ACCOUNT_JSON is not a valid service-account key.');
            }
          });
        }
        break;
    }
    return { provider, source: 'PLATFORM', settings };
  }

  /** Builds a provider from a tenant integration row. Throws ProviderError when the row is unusable. */
  private async fromIntegration(channel: ProviderChannel, row: { id: string; provider: string; config: unknown; secretsEnc: string | null; updatedAt: Date }): Promise<ResolvedProvider> {
    const config = (row.config ?? {}) as Record<string, any>;
    let secrets: Record<string, any> = {};
    if (row.secretsEnc) {
      try {
        secrets = decryptJson(row.secretsEnc) ?? {};
      } catch {
        throw new ProviderError(`${LABEL[channel]}: the saved credentials could not be read. Enter them again in Settings > Integrations.`, false, 'INTEGRATION_NOT_CONFIGURED');
      }
    }
    const key = `tenant:${row.id}:${row.updatedAt.getTime()}`;
    const incomplete = (fields: string) => new ProviderError(`${LABEL[channel]}: the integration is incomplete (${fields}). Complete it in Settings > Integrations.`, false, 'INTEGRATION_NOT_CONFIGURED');
    const kind = `${channel}/${row.provider.toLowerCase()}`;
    let provider: ChannelProvider;
    switch (kind) {
      case 'EMAIL/smtp': {
        if (!config.host) throw incomplete('host');
        await assertPublicHost(String(config.host), LABEL.EMAIL);
        provider = this.cached(key, () =>
          new SmtpEmailProvider({
            host: String(config.host),
            port: Number(config.port ?? 587),
            secure: config.secure === true,
            requireTls: config.requireTls ?? env().NODE_ENV === 'production',
            user: secrets.user ?? config.user ?? null,
            password: secrets.password ?? null,
            defaultFrom: { name: env().MAIL_FROM_NAME, address: env().MAIL_FROM_ADDRESS },
          }),
        );
        break;
      }
      case 'SMS/twilio':
        if (!config.accountSid || !config.from || !secrets.authToken) throw incomplete('accountSid, from, authToken');
        provider = this.cached(key, () => new TwilioSmsProvider({ accountSid: String(config.accountSid), authToken: String(secrets.authToken), from: String(config.from) }));
        break;
      case 'SMS/http': {
        if (!config.url || !secrets.token) throw incomplete('url, token');
        const url = assertAllowedHttpEndpoint(String(config.url), LABEL.SMS);
        await assertPublicHost(url.hostname, LABEL.SMS);
        provider = this.cached(key, () => new HttpSmsProvider({ url: url.toString(), token: String(secrets.token) }));
        break;
      }
      case 'WHATSAPP/meta':
        if (!config.phoneNumberId || !secrets.accessToken) throw incomplete('phoneNumberId, accessToken');
        provider = this.cached(key, () => new MetaWhatsAppProvider({ phoneNumberId: String(config.phoneNumberId), accessToken: String(secrets.accessToken), apiVersion: config.apiVersion ? String(config.apiVersion) : undefined }));
        break;
      case 'PUSH/fcm': {
        if (!config.projectId || !secrets.serviceAccountJson) throw incomplete('projectId, serviceAccountJson');
        let account: ReturnType<typeof parseServiceAccount>;
        try {
          account = parseServiceAccount(typeof secrets.serviceAccountJson === 'string' ? secrets.serviceAccountJson : JSON.stringify(secrets.serviceAccountJson));
        } catch {
          throw incomplete('serviceAccountJson is not a valid service-account key');
        }
        provider = this.cached(key, () => new FcmPushProvider({ projectId: String(config.projectId), serviceAccount: account }));
        break;
      }
      default:
        throw new ProviderError(`${LABEL[channel]}: the provider "${row.provider}" is not supported for this channel.`, false, 'INTEGRATION_NOT_CONFIGURED');
    }
    return { provider, source: 'TENANT', settings: config };
  }

  private activeIntegration(channel: ProviderChannel, tx: Tx) {
    return tx.integration.findFirst({
      where: { tenantId: this.db.tenantId, category: channel, status: 'ACTIVE' },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, provider: true, config: true, secretsEnc: true, updatedAt: true },
    });
  }

  /** Provider for the current tenant. Call inside the tenant transaction. */
  async resolve(channel: ProviderChannel, tx: Tx): Promise<ResolvedProvider> {
    const override = this.overrides.get(channel);
    if (override) return { provider: override, source: 'PLATFORM', settings: {} };
    const row = await this.activeIntegration(channel, tx);
    if (row) return this.fromIntegration(channel, row);
    return this.platform(channel);
  }

  /** What `GET /notifications/channels` shows. Never contains credentials. */
  async status(tx: Tx): Promise<ChannelStatus[]> {
    const out: ChannelStatus[] = [];
    for (const channel of PROVIDER_CHANNELS) {
      try {
        const row = await this.activeIntegration(channel, tx);
        const resolved = row ? await this.fromIntegration(channel, row) : this.platform(channel);
        out.push({ channel, provider: resolved.provider.name, source: resolved.source, configured: true, detail: resolved.provider.name === 'log' ? 'Development mode: messages are written to the server log and not sent.' : null });
      } catch (e: any) {
        if (!(e instanceof ProviderError)) this.logger.warn(`channel status for ${channel} failed: ${e?.message}`);
        out.push({ channel, provider: null, source: 'NONE', configured: false, detail: e instanceof ProviderError ? e.message : 'The channel could not be checked.' });
      }
    }
    out.push({ channel: 'IN_APP', provider: 'in-app', source: 'BUILT_IN', configured: true, detail: null });
    return out;
  }
}
