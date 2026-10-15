import { Injectable } from '@nestjs/common';
import { connect, isIP } from 'node:net';
import nodemailer from 'nodemailer';
import { env } from '../../config/env';
import type { ProviderDef } from './catalogue';
import { EndpointNotAllowed, guardedRequest, resolveSafeHost } from './net-guard';

export interface TestOutcome {
  ok: boolean;
  /** Plain-language result shown to the centre. Never contains a credential. */
  message: string;
  statusCode: number | null;
  durationMs: number;
  /** Redacted summaries for integration_logs. */
  request: Record<string, unknown>;
  response: Record<string, unknown> | null;
  error: string | null;
}

type Config = Record<string, any>;
type Secrets = Record<string, string>;

/** Removes any credential value that an upstream error message might have echoed back. */
export function scrub(text: string, secrets: Secrets): string {
  let out = text;
  for (const value of Object.values(secrets)) {
    if (typeof value === 'string' && value.length >= 4) out = out.split(value).join('[redacted]');
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, 300);
}

const blocked = (e: EndpointNotAllowed, started: number, request: Record<string, unknown>): TestOutcome => ({
  ok: false,
  message: e.message,
  statusCode: null,
  durationMs: Date.now() - started,
  request,
  response: null,
  error: e.code,
});

/**
 * Harmless connection tests. Each one only reads (or says hello): no message is
 * sent, no payment is created, no file is transferred. Every outbound call
 * goes through the SSRF guard, and results are reported in plain language
 * without ever echoing a credential.
 *
 * Verified in this repository: SMTP against a real local `smtp-server`, and
 * Stripe / Twilio / ClamAV against local fake servers that assert the exact
 * request. The live Stripe and Twilio APIs were not reachable from the build
 * environment.
 */
@Injectable()
export class ConnectionTester {
  private endpoints: Record<'stripe' | 'twilio', string> = { stripe: 'https://api.stripe.com', twilio: 'https://api.twilio.com' };

  /** Tests only: point a fixed provider API at a local fake server. Refused in production. */
  setEndpoint(name: 'stripe' | 'twilio', url: string | null) {
    if (env().NODE_ENV === 'production') throw new Error('Provider endpoints cannot be overridden in production.');
    this.endpoints[name] = url ?? (name === 'stripe' ? 'https://api.stripe.com' : 'https://api.twilio.com');
  }

  async run(def: ProviderDef, config: Config, secrets: Secrets, mode: string): Promise<TestOutcome> {
    switch (def.test) {
      case 'smtp':
        return this.smtp(config, secrets);
      case 'stripe':
        return this.stripe(secrets, mode);
      case 'twilio':
        return this.twilio(config, secrets);
      case 'clamav':
        return this.clamav(config);
      default:
        throw new Error(`No connection test exists for ${def.category}/${def.provider}.`);
    }
  }

  private async smtp(config: Config, secrets: Secrets): Promise<TestOutcome> {
    const started = Date.now();
    const host = String(config.host);
    const port = Number(config.port ?? 587);
    const secure = config.secure === true;
    const requireTls = (config.requireTls ?? env().NODE_ENV === 'production') === true && !secure;
    const request = { operation: 'SMTP verify', host, port, secure, requireTls, auth: secrets.user ? 'user + password (redacted)' : 'none' };
    let target;
    try {
      target = await resolveSafeHost(host, 'Mail server');
    } catch (e) {
      if (e instanceof EndpointNotAllowed) return blocked(e, started, request);
      throw e;
    }
    const transport = nodemailer.createTransport({
      // Connect to the address that passed the check; TLS still validates the certificate against the host name.
      host: target.address,
      port,
      secure,
      requireTLS: requireTls,
      auth: secrets.user ? { user: secrets.user, pass: secrets.password ?? '' } : undefined,
      tls: isIP(target.host) ? undefined : { servername: target.host },
      connectionTimeout: 8_000,
      greetingTimeout: 8_000,
      socketTimeout: 10_000,
    });
    try {
      await transport.verify();
      return { ok: true, message: `Connected to ${host}:${port}${secrets.user ? ' and signed in' : ''}. No message was sent.`, statusCode: null, durationMs: Date.now() - started, request, response: { verified: true }, error: null };
    } catch (e: any) {
      const code = String(e?.code ?? 'SMTP_ERROR');
      const detail = scrub(String(e?.response ?? e?.message ?? e), secrets);
      const message =
        code === 'EAUTH'
          ? `The mail server refused the user name or password (${detail}).`
          : code === 'ETIMEDOUT' || code === 'ECONNECTION' || code === 'ESOCKET' || code === 'ECONNREFUSED'
            ? `Could not connect to ${host}:${port}. Check the server name, the port and whether TLS is required (${detail}).`
            : `The mail server answered with an error: ${detail}`;
      return { ok: false, message, statusCode: Number(e?.responseCode) || null, durationMs: Date.now() - started, request, response: null, error: code };
    } finally {
      transport.close();
    }
  }

  private async http(what: string, url: string, headers: Record<string, string>, request: Record<string, unknown>, secrets: Secrets, read: (status: number, body: any) => { ok: boolean; message: string; response: Record<string, unknown> }): Promise<TestOutcome> {
    const started = Date.now();
    try {
      const res = await guardedRequest('GET', url, { what, headers, timeoutMs: 10_000 });
      let body: any = null;
      try {
        body = JSON.parse(res.body);
      } catch {
        body = null;
      }
      const result = read(res.status, body);
      return { ok: result.ok, message: scrub(result.message, secrets), statusCode: res.status, durationMs: res.durationMs, request, response: { status: res.status, ...result.response }, error: result.ok ? null : `HTTP_${res.status}` };
    } catch (e: any) {
      if (e instanceof EndpointNotAllowed) return blocked(e, started, request);
      const detail = scrub(String(e?.message ?? e), secrets);
      return { ok: false, message: `${what} could not be reached (${detail}).`, statusCode: null, durationMs: Date.now() - started, request, response: null, error: String(e?.code ?? 'NETWORK_ERROR') };
    }
  }

  private stripe(secrets: Secrets, mode: string): Promise<TestOutcome> {
    const url = `${this.endpoints.stripe}/v1/balance`;
    const keyKind = secrets.secretKey?.startsWith('sk_live_') ? 'live' : secrets.secretKey?.startsWith('sk_test_') ? 'test' : 'unknown';
    return this.http('Stripe', url, { authorization: `Bearer ${secrets.secretKey}` }, { method: 'GET', url, auth: 'bearer secret key (redacted)', keyKind }, secrets, (status, body) => {
      if (status === 200) {
        const live = body?.livemode === true;
        const mismatch = (mode === 'LIVE') !== live;
        return {
          ok: true,
          message: `Stripe accepted the key (${live ? 'live' : 'test'} mode).${mismatch ? ` Note: this integration is set to ${mode} but the key is a ${live ? 'live' : 'test'} key.` : ''} Nothing was charged.`,
          response: { livemode: live },
        };
      }
      if (status === 401) return { ok: false, message: 'Stripe rejected the secret key. Copy it again from the Stripe dashboard (Developers > API keys).', response: { errorType: body?.error?.type ?? null } };
      if (status === 403) return { ok: false, message: 'Stripe accepted the key but it may not read the balance. Use a standard secret key, or a restricted key with "Balance: read".', response: { errorType: body?.error?.type ?? null } };
      return { ok: false, message: `Stripe answered with HTTP ${status}. Please try again in a few minutes.`, response: { errorType: body?.error?.type ?? null } };
    });
  }

  private twilio(config: Config, secrets: Secrets): Promise<TestOutcome> {
    const sid = String(config.accountSid);
    const url = `${this.endpoints.twilio}/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`;
    const basic = Buffer.from(`${sid}:${secrets.authToken}`).toString('base64');
    return this.http('Twilio', url, { authorization: `Basic ${basic}` }, { method: 'GET', url, auth: 'basic account SID + auth token (redacted)' }, secrets, (status, body) => {
      if (status === 200) {
        const state = typeof body?.status === 'string' ? body.status : 'unknown';
        return state === 'active' || state === 'unknown'
          ? { ok: true, message: 'Twilio accepted the account SID and auth token. No message was sent.', response: { accountStatus: state } }
          : { ok: false, message: `Twilio accepted the credentials, but the account is "${state}". Messages will not be delivered until Twilio reactivates it.`, response: { accountStatus: state } };
      }
      if (status === 401 || status === 404) return { ok: false, message: 'Twilio rejected the account SID or the auth token. Copy both again from the Twilio console.', response: { code: body?.code ?? null } };
      return { ok: false, message: `Twilio answered with HTTP ${status}. Please try again in a few minutes.`, response: { code: body?.code ?? null } };
    });
  }

  /** clamd protocol: "zPING\0" is answered with "PONG\0". */
  private async clamav(config: Config): Promise<TestOutcome> {
    const started = Date.now();
    const host = String(config.host);
    const port = Number(config.port ?? 3310);
    const request = { operation: 'clamd PING', host, port };
    let target;
    try {
      target = await resolveSafeHost(host, 'Scanner');
    } catch (e) {
      if (e instanceof EndpointNotAllowed) return blocked(e, started, request);
      throw e;
    }
    const reply = await new Promise<{ text: string | null; error: string | null }>((resolve) => {
      const socket = connect({ host: target.address, port, family: target.family });
      let data = '';
      const finish = (text: string | null, error: string | null) => {
        socket.destroy();
        resolve({ text, error });
      };
      socket.setTimeout(8_000, () => finish(null, 'ETIMEDOUT'));
      socket.once('error', (e: any) => finish(null, String(e?.code ?? 'ECONNECTION')));
      socket.once('connect', () => socket.write('zPING\0'));
      socket.on('data', (chunk) => {
        data += chunk.toString('utf8');
        if (data.includes('\0') || data.length > 64) finish(data.replace(/\0/g, '').trim().slice(0, 64), null);
      });
      socket.once('end', () => finish(data.replace(/\0/g, '').trim().slice(0, 64) || null, data ? null : 'ECONNRESET'));
    });
    const durationMs = Date.now() - started;
    if (reply.text === 'PONG') return { ok: true, message: `The scanner at ${host}:${port} answered. No file was transferred.`, statusCode: null, durationMs, request, response: { reply: 'PONG' }, error: null };
    if (reply.error) return { ok: false, message: `Could not reach a ClamAV scanner at ${host}:${port} (${reply.error}).`, statusCode: null, durationMs, request, response: null, error: reply.error };
    return { ok: false, message: `The server at ${host}:${port} answered, but not like a ClamAV scanner.`, statusCode: null, durationMs, request, response: { reply: 'unexpected' }, error: 'UNEXPECTED_REPLY' };
  }
}
