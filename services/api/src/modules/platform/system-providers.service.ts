import { Injectable } from '@nestjs/common';
import { JobQueue } from '../../common/jobs/job-queue';
import { RedisService } from '../../common/redis';
import { Env, env } from '../../config/env';
import { StorageService } from '../storage/storage.service';

export type ProviderStatus = 'CONFIGURED' | 'NOT_CONFIGURED' | 'LOG_ONLY' | 'DISABLED' | 'SANDBOX';
export interface SystemProvider {
  key: string;
  label: string;
  /** The driver selected in the environment (`smtp`, `log`, `s3`, `none` ...). */
  driver: string;
  status: ProviderStatus;
  /** One or two sentences for an operator: what is configured, or what is missing. Never a secret. */
  detail: string;
  /** Only for providers that are really checked (object storage, Redis): the result of that check. */
  reachable?: boolean;
  lastCheckedAt?: string;
  lastError?: string | null;
}

const host = (url: string | undefined | null): string | null => {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};
const missing = (names: Array<[string, unknown]>) => names.filter(([, v]) => !v).map(([n]) => n);
const LOG_DETAIL = (what: string, variable: string) => `${variable}=log: ${what} are written to the application log and are NOT delivered. Centres can still connect their own provider under Settings > Integrations.`;

/**
 * What the installation is configured to use for everything that leaves the platform - derived from
 * the environment and from two cheap, real checks (object storage and Redis). Nothing is contacted
 * that would send something or cost something: no SMTP handshake, no SMS or WhatsApp call, no call
 * to a payment provider. A `log` driver is never reported as configured, and no value of a secret
 * ever appears here (not even a part of one).
 */
@Injectable()
export class SystemProvidersService {
  constructor(
    private readonly storage: StorageService,
    private readonly redis: RedisService,
    private readonly jobs: JobQueue,
  ) {}

  /** The rows that depend on the environment only (pure: unit-testable with any configuration). */
  static fromEnvironment(e: Env): SystemProvider[] {
    const rows: SystemProvider[] = [];
    const row = (key: string, label: string, driver: string, status: ProviderStatus, detail: string) => rows.push({ key, label, driver, status, detail });
    const needs = (variables: string[]) => `Not usable yet: set ${variables.join(', ')}.`;

    // ---- e-mail
    if (e.MAIL_DRIVER === 'log') row('mail', 'E-mail', 'log', 'LOG_ONLY', LOG_DETAIL('e-mails', 'MAIL_DRIVER'));
    else if (!e.SMTP_HOST) row('mail', 'E-mail', 'smtp', 'NOT_CONFIGURED', needs(['SMTP_HOST']));
    else row('mail', 'E-mail', 'smtp', 'CONFIGURED', `SMTP server ${e.SMTP_HOST}:${e.SMTP_PORT} (${e.SMTP_SECURE ? 'TLS from the start' : 'STARTTLS'}), ${e.SMTP_USER ? 'with a user name' : 'without authentication'}; sender "${e.MAIL_FROM_NAME}" <${e.MAIL_FROM_ADDRESS}>. The server is not contacted by this check.`);

    // ---- SMS
    if (e.SMS_DRIVER === 'log') row('sms', 'SMS', 'log', 'LOG_ONLY', LOG_DETAIL('text messages', 'SMS_DRIVER'));
    else if (e.SMS_DRIVER === 'twilio') {
      const gaps = missing([['TWILIO_ACCOUNT_SID', e.TWILIO_ACCOUNT_SID], ['TWILIO_AUTH_TOKEN', e.TWILIO_AUTH_TOKEN], ['TWILIO_FROM', e.TWILIO_FROM]]);
      if (gaps.length) row('sms', 'SMS', 'twilio', 'NOT_CONFIGURED', needs(gaps));
      else row('sms', 'SMS', 'twilio', 'CONFIGURED', `Twilio, sender ${e.TWILIO_FROM}. Twilio is not contacted by this check.`);
    } else {
      const gaps = missing([['SMS_HTTP_URL', e.SMS_HTTP_URL], ['SMS_HTTP_TOKEN', e.SMS_HTTP_TOKEN]]);
      if (gaps.length) row('sms', 'SMS', 'http', 'NOT_CONFIGURED', needs(gaps));
      else row('sms', 'SMS', 'http', 'CONFIGURED', `HTTP gateway at ${host(e.SMS_HTTP_URL) ?? 'the configured address'}. The gateway is not contacted by this check.`);
    }

    // ---- WhatsApp
    if (e.WHATSAPP_DRIVER === 'log') row('whatsapp', 'WhatsApp Business', 'log', 'LOG_ONLY', LOG_DETAIL('WhatsApp messages', 'WHATSAPP_DRIVER'));
    else {
      const gaps = missing([['WHATSAPP_PHONE_NUMBER_ID', e.WHATSAPP_PHONE_NUMBER_ID], ['WHATSAPP_ACCESS_TOKEN', e.WHATSAPP_ACCESS_TOKEN]]);
      if (gaps.length) row('whatsapp', 'WhatsApp Business', 'meta', 'NOT_CONFIGURED', needs(gaps));
      else row('whatsapp', 'WhatsApp Business', 'meta', 'CONFIGURED', `Meta Cloud API, phone number id ${e.WHATSAPP_PHONE_NUMBER_ID}. Messages need templates approved by Meta. Meta is not contacted by this check.`);
    }

    // ---- push
    if (e.PUSH_DRIVER === 'log') row('push', 'Push notifications', 'log', 'LOG_ONLY', LOG_DETAIL('push notifications', 'PUSH_DRIVER'));
    else {
      const gaps = missing([['FCM_PROJECT_ID', e.FCM_PROJECT_ID], ['FCM_SERVICE_ACCOUNT_JSON', e.FCM_SERVICE_ACCOUNT_JSON]]);
      if (gaps.length) row('push', 'Push notifications', 'fcm', 'NOT_CONFIGURED', needs(gaps));
      else row('push', 'Push notifications', 'fcm', 'CONFIGURED', `Firebase Cloud Messaging, project ${e.FCM_PROJECT_ID}. Firebase is not contacted by this check.`);
    }

    // ---- malware scanner
    if (e.MALWARE_SCANNER === 'none') {
      row('malware_scanner', 'Malware scanner', 'none', 'DISABLED', `MALWARE_SCANNER=none: uploaded files are checked for their type only, not for malware.${e.REQUIRE_CLEAN_SCAN ? ' REQUIRE_CLEAN_SCAN is on, so files stay unavailable for download until a scanner is configured.' : ''}`);
    } else {
      row('malware_scanner', 'Malware scanner', 'clamav', 'CONFIGURED', `ClamAV daemon at ${e.CLAMAV_HOST}:${e.CLAMAV_PORT}; ${e.REQUIRE_CLEAN_SCAN ? 'a file can be downloaded only after a clean result' : 'files are available while the scan is pending (REQUIRE_CLEAN_SCAN is off)'}. The daemon is not contacted by this check.`);
    }

    // ---- OCR
    if (e.OCR_PROVIDER === 'disabled') row('ocr', 'Document reading (OCR)', 'disabled', 'DISABLED', 'OCR_PROVIDER=disabled: the document assistant answers "not configured".');
    else if (e.OCR_PROVIDER === 'tesseract') row('ocr', 'Document reading (OCR)', 'tesseract', 'CONFIGURED', 'Tesseract runs inside this server (English model shipped with the application); documents do not leave the installation.');
    else if (!e.OCR_EXTERNAL_URL) row('ocr', 'Document reading (OCR)', 'external-http', 'NOT_CONFIGURED', needs(['OCR_EXTERNAL_URL']));
    else row('ocr', 'Document reading (OCR)', 'external-http', 'CONFIGURED', `External OCR service at ${host(e.OCR_EXTERNAL_URL) ?? 'the configured address'}${e.OCR_EXTERNAL_TOKEN ? ', with a token' : ', without a token'}. Documents are sent to that service. It is not contacted by this check.`);

    // ---- online payments: the platform's own gateway (subscriptions) and the test adapter
    if (e.STRIPE_SECRET_KEY && e.STRIPE_WEBHOOK_SECRET) {
      row('payments', 'Online payments', 'stripe', 'CONFIGURED', `Stripe (${/^sk_test_/.test(e.STRIPE_SECRET_KEY) ? 'TEST mode key' : 'live key'}) with a webhook signing secret, for the platform's own billing. Each centre connects its own gateway under Settings > Integrations. Stripe is not contacted by this check.`);
    } else if (e.STRIPE_SECRET_KEY || e.STRIPE_WEBHOOK_SECRET) {
      row('payments', 'Online payments', 'stripe', 'NOT_CONFIGURED', needs(missing([['STRIPE_SECRET_KEY', e.STRIPE_SECRET_KEY], ['STRIPE_WEBHOOK_SECRET', e.STRIPE_WEBHOOK_SECRET]])));
    } else if (e.PAYMENT_SANDBOX_ENABLED) {
      row('payments', 'Online payments', 'sandbox', 'SANDBOX', 'No real gateway is configured for the platform; only the test adapter can take "payments", and no money moves.');
    } else {
      row('payments', 'Online payments', 'none', 'NOT_CONFIGURED', 'No platform gateway: set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET to take subscription payments online. Each centre connects its own gateway under Settings > Integrations.');
    }
    row(
      'payments_sandbox',
      'Payment test adapter',
      'sandbox',
      e.PAYMENT_SANDBOX_ENABLED ? 'SANDBOX' : 'DISABLED',
      e.PAYMENT_SANDBOX_ENABLED
        ? 'PAYMENT_SANDBOX_ENABLED=true: centres can connect the test gateway and "pay" invoices without money moving. It must be off in production (the API refuses to start otherwise).'
        : 'PAYMENT_SANDBOX_ENABLED=false: the test gateway cannot be used.',
    );

    // ---- automation webhooks
    const allowed = e.OUTBOUND_WEBHOOK_ALLOWED_HOSTS;
    const allowList = allowed.length ? ` ${allowed.length} additional host(s) on the allow-list: ${allowed.join(', ')}.` : ' No additional hosts are on the allow-list (OUTBOUND_WEBHOOK_ALLOWED_HOSTS).';
    if (e.N8N_WEBHOOK_BASE_URL && e.N8N_WEBHOOK_SECRET) row('automation_webhooks', 'Automation webhooks (n8n)', 'n8n', 'CONFIGURED', `Platform n8n at ${host(e.N8N_WEBHOOK_BASE_URL) ?? 'the configured address'}; calls are signed.${allowList} n8n is not contacted by this check.`);
    else if (e.N8N_WEBHOOK_BASE_URL || e.N8N_WEBHOOK_SECRET) row('automation_webhooks', 'Automation webhooks (n8n)', 'n8n', 'NOT_CONFIGURED', `${needs(missing([['N8N_WEBHOOK_BASE_URL', e.N8N_WEBHOOK_BASE_URL], ['N8N_WEBHOOK_SECRET', e.N8N_WEBHOOK_SECRET]]))}${allowList}`);
    else row('automation_webhooks', 'Automation webhooks (n8n)', 'none', 'NOT_CONFIGURED', `No platform n8n (N8N_WEBHOOK_BASE_URL, N8N_WEBHOOK_SECRET). Centres can still enter the address of their own n8n; such calls go to public addresses only.${allowList}`);

    // ---- error tracking: there is none built in, and saying so is more useful than leaving it out
    row('error_tracking', 'Error tracking', 'none', 'NOT_CONFIGURED', `TypEase has no error-tracking integration. Errors are written to the application log (LOG_FORMAT=${e.LOG_FORMAT}, LOG_LEVEL=${e.LOG_LEVEL}); collect the log to be alerted.`);
    return rows;
  }

  /** Object storage: configuration plus one real round trip (HeadBucket, or a probe file on local disk). */
  async storageRow(now: Date = new Date()): Promise<SystemProvider> {
    const e = env();
    const check = await this.storage.check();
    const base = { key: 'storage', label: 'Object storage', driver: this.storage.driverName, reachable: check.ok, lastCheckedAt: now.toISOString(), lastError: check.error };
    if (e.STORAGE_DRIVER === 's3' && (!e.S3_ACCESS_KEY_ID || !e.S3_SECRET_ACCESS_KEY) && !process.env.AWS_ROLE_ARN && !check.ok) {
      return { ...base, status: 'NOT_CONFIGURED', detail: `${check.target}: no static credentials (S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY) and no role, and the bucket could not be reached.` };
    }
    const encryption = this.storage.encryption === 'SSE_S3' ? 'encrypted by the store (SSE-S3)' : 'encrypted by the application (AES-256-GCM)';
    return { ...base, status: 'CONFIGURED', detail: `${check.target}; objects are private and ${encryption}. ${check.ok ? 'The store answered just now.' : 'The store did NOT answer just now: uploads and downloads will fail.'}` };
  }

  /** Redis: sessions' rate limits, caches and (with QUEUE_DRIVER=bullmq) the job queue. One PING. */
  async redisRow(now: Date = new Date()): Promise<SystemProvider> {
    const ok = await this.redis.ping();
    const where = host(env().REDIS_URL.replace(/^rediss?:/, 'http:')) ?? 'the configured address';
    return {
      key: 'redis', label: 'Redis', driver: 'redis', status: 'CONFIGURED', reachable: ok, lastCheckedAt: now.toISOString(), lastError: ok ? null : 'PING was not answered',
      detail: `Redis at ${where}: rate limits, short-lived caches${this.jobs.driver === 'bullmq' ? ' and the job queue' : ''}. ${ok ? 'It answered just now.' : 'It did NOT answer just now.'}`,
    };
  }

  /** The job queue driver. Its figures (waiting, failed ...) and the worker's heartbeat are part of the system health. */
  queueRow(): SystemProvider {
    const e = env();
    if (this.jobs.driver === 'bullmq') return { key: 'queue', label: 'Background jobs', driver: 'bullmq', status: 'CONFIGURED', detail: 'BullMQ on Redis; jobs are executed by the separate worker process. See the system health for the queue figures and the worker heartbeat.' };
    return {
      key: 'queue', label: 'Background jobs', driver: 'inline', status: e.QUEUE_INLINE_AUTORUN ? 'CONFIGURED' : 'DISABLED',
      detail: e.QUEUE_INLINE_AUTORUN
        ? 'Single-process mode (QUEUE_DRIVER=inline, QUEUE_INLINE_AUTORUN=true): the API runs the jobs itself, in memory. Jobs that are waiting are lost when the process stops; daily schedules run hourly.'
        : 'QUEUE_DRIVER=inline without QUEUE_INLINE_AUTORUN: jobs are kept in memory and run only when something drains them (tests). Nothing is processed on its own.',
    };
  }

  async providers() {
    const now = new Date();
    const [storage, redis] = await Promise.all([this.storageRow(now), this.redisRow(now)]);
    const fromEnv = SystemProvidersService.fromEnvironment(env());
    const order = ['mail', 'sms', 'whatsapp', 'push', 'storage', 'malware_scanner', 'ocr', 'payments', 'payments_sandbox', 'automation_webhooks', 'redis', 'queue', 'error_tracking'];
    const all = [...fromEnv, storage, redis, this.queueRow()];
    return { generatedAt: now.toISOString(), environment: env().NODE_ENV, providers: order.map((key) => all.find((r) => r.key === key)!).filter(Boolean) };
  }
}
