import jwt from 'jsonwebtoken';
import { brief, ChannelProvider, httpPost, OutboundMessage, ProviderError, retryableStatus, SendResult } from './types';

export interface FcmConfig {
  projectId: string;
  /** Google service-account key (the JSON file contents). */
  serviceAccount: { client_email: string; private_key: string; private_key_id?: string };
  /** Overrides for tests. Production always talks to Google. */
  tokenUrl?: string;
  baseUrl?: string;
}
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/**
 * Firebase Cloud Messaging, HTTP v1 API. Authenticates with an OAuth 2 access
 * token obtained by signing a JWT (RS256) with the service-account key; the
 * token is cached until shortly before it expires. The token endpoint is
 * fixed (never taken from the uploaded key file).
 */
export class FcmPushProvider implements ChannelProvider {
  readonly name = 'fcm';
  readonly channel = 'PUSH' as const;
  private cached?: { token: string; expiresAt: number };
  constructor(private readonly config: FcmConfig) {}

  async accessToken(now = Date.now()): Promise<string> {
    if (this.cached && this.cached.expiresAt - 60_000 > now) return this.cached.token;
    const tokenUrl = this.config.tokenUrl ?? GOOGLE_TOKEN_URL;
    const iat = Math.floor(now / 1000);
    let assertion: string;
    try {
      assertion = jwt.sign({ iss: this.config.serviceAccount.client_email, scope: FCM_SCOPE, aud: tokenUrl, iat, exp: iat + 3600 }, this.config.serviceAccount.private_key, {
        algorithm: 'RS256',
        ...(this.config.serviceAccount.private_key_id ? { keyid: this.config.serviceAccount.private_key_id } : {}),
      });
    } catch (e: any) {
      throw new ProviderError(`fcm: the service-account key could not be used (${brief(e?.message, 120)}).`, false, 'FCM_KEY_INVALID');
    }
    const res = await httpPost('fcm', tokenUrl, {
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    });
    if (res.status < 200 || res.status >= 300 || !res.json?.access_token) {
      throw new ProviderError(`fcm: could not obtain an access token (HTTP ${res.status} ${brief(res.json?.error_description ?? res.json?.error ?? res.text, 160)}).`, retryableStatus(res.status), 'FCM_AUTH_FAILED');
    }
    this.cached = { token: String(res.json.access_token), expiresAt: now + Number(res.json.expires_in ?? 3600) * 1000 };
    return this.cached.token;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const token = await this.accessToken();
    const base = (this.config.baseUrl ?? 'https://fcm.googleapis.com').replace(/\/$/, '');
    const res = await httpPost('fcm', `${base}/v1/projects/${encodeURIComponent(this.config.projectId)}/messages:send`, {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        message: {
          token: message.to,
          notification: { title: message.subject ?? '', body: message.text },
          ...(message.pushData && Object.keys(message.pushData).length ? { data: message.pushData } : {}),
        },
      }),
    });
    if (res.status >= 200 && res.status < 300 && res.json?.name) return { providerMessageId: String(res.json.name) };
    if (res.status === 401) this.cached = undefined;
    const err = res.json?.error;
    const fcmCode: string | undefined = err?.details?.find((d: any) => d?.errorCode)?.errorCode;
    // The device uninstalled the app or the token rotated: the caller removes the token.
    if (res.status === 404 || fcmCode === 'UNREGISTERED') throw new ProviderError('fcm: the device token is no longer registered.', false, 'UNREGISTERED');
    throw new ProviderError(`fcm: HTTP ${res.status} ${brief(err?.message ?? res.text)}`, res.status === 401 || retryableStatus(res.status), 'FCM_ERROR');
  }
}
