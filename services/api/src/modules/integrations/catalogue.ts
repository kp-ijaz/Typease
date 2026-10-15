import { env } from '../../config/env';

/**
 * The provider catalogue: every external service a centre can configure in
 * Settings > Integrations, with its non-secret settings and its credentials.
 *
 * This file is the contract with the modules that READ the rows
 * (integration_credentials_metadata): the `config` keys and the secret keys
 * below are exactly the names those modules look up. Changing a key here
 * without changing the consumer breaks that provider.
 *
 *   PAYMENT   finance/gateways/payment-gateways.ts
 *   EMAIL, SMS, WHATSAPP, PUSH   notifications/providers/registry.ts
 *   GOVERNMENT, PARTNER          catalogue (capability check), requests (official channel)
 */
export const CATEGORIES = ['PAYMENT', 'EMAIL', 'SMS', 'WHATSAPP', 'PUSH', 'OCR', 'MALWARE_SCAN', 'AUTOMATION', 'PARTNER', 'GOVERNMENT'] as const;
export type Category = (typeof CATEGORIES)[number];

export type FieldType = 'string' | 'text' | 'number' | 'boolean' | 'email' | 'phone' | 'host' | 'url' | 'date' | 'languageCodes' | 'json';
export interface FieldDef {
  key: string;
  label: string;
  help?: string;
  type: FieldType;
  required?: boolean;
  maxLength?: number;
  min?: number;
  max?: number;
  /** `url` fields: the host must also be on the operator's allow-list (OUTBOUND_WEBHOOK_ALLOWED_HOSTS). */
  allowListed?: boolean;
  /** Authorisation records: changing this field invalidates an earlier verification. */
  keyField?: boolean;
  example?: string;
}

export interface ProviderDef {
  category: Category;
  provider: string;
  name: string;
  description: string;
  /**
   * CONNECTION            credentials for an external service our code calls.
   * AUTHORISATION_RECORD  a statement that the centre is authorised to do something, checked by a
   *                       TypEase administrator. It holds no credentials and connects to nothing.
   */
  kind: 'CONNECTION' | 'AUTHORISATION_RECORD';
  configFields: FieldDef[];
  secretFields: FieldDef[];
  /** A centre may keep several records (one per partner / authority). */
  multiple?: boolean;
  /** Which connection test exists. `null` = cannot be tested automatically. */
  test: 'smtp' | 'stripe' | 'twilio' | 'clamav' | null;
  testNote: string;
  /** Only this many providers of the category can be ACTIVE at once (the consumer picks one). */
  exclusive: boolean;
  /** How the stored row is used today. Stated in the API so the screen never promises more than the code does. */
  usage: { effective: boolean; note: string };
  /** Hidden and refused unless this returns true (the sandbox payment adapter). */
  available?: () => boolean;
  /** Extra validation of the secrets after the field checks. Returns a message or null. */
  validateSecrets?: (secrets: Record<string, string>) => string | null;
  modes: Array<'TEST' | 'LIVE'>;
}

const NOT_TESTABLE = 'This provider cannot be tested automatically. Send a test message / make a test call from the feature that uses it.';

function validServiceAccount(raw: string): string | null {
  let text = raw.trim();
  try {
    if (!text.startsWith('{')) text = Buffer.from(text, 'base64').toString('utf8');
    const parsed = JSON.parse(text);
    if (typeof parsed?.client_email !== 'string' || typeof parsed?.private_key !== 'string') return 'The service-account key must contain client_email and private_key.';
    return null;
  } catch {
    return 'The service-account key is not valid JSON. Paste the key file downloaded from the Firebase console.';
  }
}

export const PROVIDERS: ProviderDef[] = [
  // ------------------------------------------------------------------ payments
  {
    category: 'PAYMENT',
    provider: 'sandbox',
    name: 'Sandbox (test payments)',
    description: 'Built-in TEST gateway. No money moves. Only offered on installations where test payments are switched on; never in production.',
    kind: 'CONNECTION',
    configFields: [],
    secretFields: [],
    test: null,
    testNote: 'The sandbox is part of TypEase itself: there is no external connection to test.',
    exclusive: false,
    usage: { effective: true, note: 'Used for online invoice payments while it is ACTIVE and no real gateway is active.' },
    available: () => env().PAYMENT_SANDBOX_ENABLED && env().NODE_ENV !== 'production',
    modes: ['TEST'],
  },
  {
    category: 'PAYMENT',
    provider: 'stripe',
    name: 'Stripe',
    description: 'Card payments through Stripe Checkout. Customers pay on a Stripe-hosted page; TypEase never sees card numbers.',
    kind: 'CONNECTION',
    configFields: [],
    secretFields: [
      { key: 'secretKey', label: 'Secret key', help: 'Starts with sk_test_ or sk_live_ (Stripe dashboard > Developers > API keys).', type: 'string', required: true, maxLength: 300 },
      { key: 'webhookSecret', label: 'Webhook signing secret', help: 'Starts with whsec_. Create a webhook endpoint in Stripe that points at the payment webhook address shown on this screen.', type: 'string', required: true, maxLength: 300 },
    ],
    test: 'stripe',
    testNote: 'Reads the account balance (GET /v1/balance). Nothing is charged or changed.',
    exclusive: false,
    usage: { effective: true, note: 'Used for online invoice payments while it is ACTIVE. A real gateway always wins over the sandbox.' },
    modes: ['TEST', 'LIVE'],
  },
  // ------------------------------------------------------------------ email
  {
    category: 'EMAIL',
    provider: 'smtp',
    name: 'Your own mail server (SMTP)',
    description: 'Send customer emails through your own SMTP server or relay.',
    kind: 'CONNECTION',
    configFields: [
      { key: 'host', label: 'Server', type: 'host', required: true, maxLength: 253, example: 'smtp.example.ae' },
      { key: 'port', label: 'Port', type: 'number', min: 1, max: 65535, help: '587 (STARTTLS) or 465 (TLS). Default 587.', example: '587' },
      { key: 'secure', label: 'Connect with TLS (port 465)', type: 'boolean' },
      { key: 'requireTls', label: 'Refuse to send without STARTTLS', type: 'boolean', help: 'Always on in production unless switched off here.' },
      { key: 'fromAddress', label: 'Sender address', type: 'email', help: 'Must be an address your server is allowed to send from.' },
      { key: 'fromName', label: 'Sender name', type: 'string', maxLength: 120 },
    ],
    secretFields: [
      { key: 'user', label: 'User name', type: 'string', maxLength: 320 },
      { key: 'password', label: 'Password', type: 'string', maxLength: 1000 },
    ],
    test: 'smtp',
    testNote: 'Connects, starts TLS when offered and signs in. No message is sent.',
    exclusive: true,
    usage: { effective: true, note: 'Used for all customer emails of this centre while it is ACTIVE; otherwise the TypEase mail server is used.' },
    modes: ['TEST', 'LIVE'],
  },
  // ------------------------------------------------------------------ sms
  {
    category: 'SMS',
    provider: 'twilio',
    name: 'Twilio SMS',
    description: 'Send SMS through your own Twilio account.',
    kind: 'CONNECTION',
    configFields: [
      { key: 'accountSid', label: 'Account SID', type: 'string', required: true, maxLength: 64, example: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
      { key: 'from', label: 'Sender', type: 'string', required: true, maxLength: 40, help: 'A Twilio number, an approved sender name or a messaging service SID (MG...).' },
    ],
    secretFields: [{ key: 'authToken', label: 'Auth token', type: 'string', required: true, maxLength: 200 }],
    test: 'twilio',
    testNote: 'Reads the account record (GET /2010-04-01/Accounts/{sid}.json). No message is sent.',
    exclusive: true,
    usage: { effective: true, note: 'Used for all customer SMS of this centre while it is ACTIVE.' },
    modes: ['TEST', 'LIVE'],
  },
  {
    category: 'SMS',
    provider: 'http',
    name: 'SMS gateway (HTTP)',
    description: 'A local SMS gateway that accepts POST { to, body } with a bearer token.',
    kind: 'CONNECTION',
    configFields: [{ key: 'url', label: 'Gateway address', type: 'url', required: true, allowListed: true, maxLength: 500, help: 'https only. The host has to be approved by TypEase before it can be used.' }],
    secretFields: [{ key: 'token', label: 'Access token', type: 'string', required: true, maxLength: 2000 }],
    test: null,
    testNote: NOT_TESTABLE,
    exclusive: true,
    usage: { effective: true, note: 'Used for all customer SMS of this centre while it is ACTIVE.' },
    modes: ['TEST', 'LIVE'],
  },
  // ------------------------------------------------------------------ whatsapp
  {
    category: 'WHATSAPP',
    provider: 'meta',
    name: 'WhatsApp Business (Meta Cloud API)',
    description: 'Send approved WhatsApp template messages from your own WhatsApp Business number.',
    kind: 'CONNECTION',
    configFields: [
      { key: 'phoneNumberId', label: 'Phone number ID', type: 'string', required: true, maxLength: 64 },
      { key: 'apiVersion', label: 'Graph API version', type: 'string', maxLength: 10, example: 'v20.0' },
      { key: 'languageCodes', label: 'Template language codes', type: 'languageCodes', help: 'The language codes your templates were approved with, e.g. { "en": "en", "ar": "ar" }.' },
      { key: 'verifyToken', label: 'Webhook verify token', type: 'string', maxLength: 120, help: 'For the team inbox: any secret word; enter the same word as the verify token of the webhook in your Meta app.' },
    ],
    secretFields: [
      { key: 'accessToken', label: 'Permanent access token', type: 'string', required: true, maxLength: 2000 },
      { key: 'appSecret', label: 'App secret (team inbox)', type: 'string', maxLength: 200, help: 'Used to check that incoming messages really come from Meta.' },
    ],
    test: null,
    testNote: NOT_TESTABLE,
    exclusive: true,
    usage: { effective: true, note: 'Used for WhatsApp notifications of this centre while it is ACTIVE.' },
    modes: ['TEST', 'LIVE'],
  },
  // ------------------------------------------------------------------ push
  {
    category: 'PUSH',
    provider: 'fcm',
    name: 'Firebase Cloud Messaging',
    description: 'Push notifications to your own branded mobile app.',
    kind: 'CONNECTION',
    configFields: [{ key: 'projectId', label: 'Firebase project ID', type: 'string', required: true, maxLength: 120 }],
    secretFields: [{ key: 'serviceAccountJson', label: 'Service-account key (JSON)', type: 'json', required: true, maxLength: 20_000 }],
    validateSecrets: (s) => (s.serviceAccountJson ? validServiceAccount(s.serviceAccountJson) : null),
    test: null,
    testNote: NOT_TESTABLE,
    exclusive: true,
    usage: { effective: true, note: 'Used for push notifications of this centre while it is ACTIVE.' },
    modes: ['TEST', 'LIVE'],
  },
  // ------------------------------------------------------------------ ocr
  {
    category: 'OCR',
    provider: 'external-http',
    name: 'External document-reading service (HTTP)',
    description: 'An OCR / data-extraction service chosen by the centre. Customer documents would be sent to it, so the provider has to be approved by TypEase first.',
    kind: 'CONNECTION',
    configFields: [{ key: 'url', label: 'Service address', type: 'url', required: true, allowListed: true, maxLength: 500, help: 'https only. The host has to be approved by TypEase before it can be used.' }],
    secretFields: [{ key: 'token', label: 'Access token', type: 'string', required: true, maxLength: 2000 }],
    test: null,
    testNote: NOT_TESTABLE,
    exclusive: true,
    usage: { effective: false, note: 'Recorded only. Document reading currently uses the service configured for the whole platform (OCR_PROVIDER); a centre-specific service is not read by the OCR module.' },
    modes: ['TEST', 'LIVE'],
  },
  // ------------------------------------------------------------------ malware scanning
  {
    category: 'MALWARE_SCAN',
    provider: 'clamav',
    name: 'ClamAV scanner',
    description: 'A ClamAV daemon (clamd) that scans uploaded files.',
    kind: 'CONNECTION',
    configFields: [
      { key: 'host', label: 'Server', type: 'host', required: true, maxLength: 253 },
      { key: 'port', label: 'Port', type: 'number', min: 1, max: 65535, help: 'Default 3310.', example: '3310' },
    ],
    secretFields: [],
    test: 'clamav',
    testNote: 'Sends the clamd PING command and expects PONG. No file is transferred.',
    exclusive: true,
    usage: { effective: false, note: 'Recorded only. Uploads are currently scanned by the scanner configured for the whole platform (MALWARE_SCANNER); a centre-specific scanner is not read by the document module.' },
    modes: ['TEST', 'LIVE'],
  },
  // ------------------------------------------------------------------ automation
  {
    category: 'AUTOMATION',
    provider: 'n8n',
    name: 'n8n workflows',
    description: 'Your own n8n instance that receives TypEase events as signed webhooks.',
    kind: 'CONNECTION',
    configFields: [{ key: 'webhookBaseUrl', label: 'Webhook base address', type: 'url', required: true, allowListed: true, maxLength: 500, help: 'https only, e.g. https://n8n.example.ae/webhook. The host has to be approved by TypEase.' }],
    secretFields: [{ key: 'signingSecret', label: 'Signing secret', type: 'string', required: true, maxLength: 500, help: 'TypEase signs every call with this secret (HMAC-SHA256) so your workflow can check where it came from.' }],
    test: null,
    testNote: NOT_TESTABLE,
    exclusive: true,
    usage: { effective: false, note: 'Stored for the automation engine ("call webhook" action). Whether a centre-specific n8n instance is used depends on the automation module of this installation.' },
    modes: ['TEST', 'LIVE'],
  },
  // ------------------------------------------------------------------ authorisation records
  {
    category: 'PARTNER',
    provider: 'authorised-partner',
    name: 'Authorised partner',
    description: 'A partner (for example an authorised service centre) that processes cases on your behalf. This is a record of the arrangement, checked by TypEase: it holds no credentials and connects to nothing.',
    kind: 'AUTHORISATION_RECORD',
    multiple: true,
    configFields: [
      { key: 'partnerLegalName', label: 'Partner legal name', type: 'string', required: true, maxLength: 200, keyField: true },
      { key: 'serviceScope', label: 'Services the partner handles', type: 'text', required: true, maxLength: 1000, keyField: true, help: 'Which case types are sent to this partner.' },
      { key: 'agreementReference', label: 'Agreement reference', type: 'string', required: true, maxLength: 120, keyField: true, help: 'Contract or agreement number between your centre and the partner.' },
      { key: 'agreementValidUntil', label: 'Agreement valid until', type: 'date', keyField: true },
      { key: 'contactName', label: 'Contact person', type: 'string', maxLength: 160 },
      { key: 'contactEmail', label: 'Contact email', type: 'email' },
      { key: 'contactPhone', label: 'Contact phone', type: 'phone' },
    ],
    secretFields: [],
    test: null,
    testNote: 'There is nothing to connect to: this is a record, not a connection.',
    exclusive: false,
    usage: { effective: true, note: 'Once verified and ACTIVE, services may use the "Coordination through an authorised partner" capability.' },
    modes: ['LIVE'],
  },
  {
    category: 'GOVERNMENT',
    provider: 'official-portal-access',
    name: 'Authorisation to use an official portal',
    description:
      'A record that your centre is authorised by an authority to process cases on its official portal. It is NOT a connection: TypEase never stores portal user names or passwords and never signs in to a government website. Staff use the portal themselves and record the reference.',
    kind: 'AUTHORISATION_RECORD',
    multiple: true,
    configFields: [
      { key: 'authorityName', label: 'Authority', type: 'string', required: true, maxLength: 200, keyField: true, example: 'MOHRE' },
      { key: 'authorisationReference', label: 'Authorisation / licence reference', type: 'string', required: true, maxLength: 120, keyField: true, help: 'The number of the licence, accreditation or approval issued to your centre.' },
      { key: 'validFrom', label: 'Valid from', type: 'date', keyField: true },
      { key: 'validUntil', label: 'Valid until', type: 'date', keyField: true },
      { key: 'credentialHolder', label: 'Who holds the portal credentials', type: 'string', required: true, maxLength: 200, help: 'Name and role of the person in your centre who is personally responsible for the portal account. Never enter the credentials themselves.' },
      { key: 'notes', label: 'Notes', type: 'text', maxLength: 1000 },
    ],
    secretFields: [],
    test: null,
    testNote: 'There is nothing to connect to: this is a record, not a connection.',
    exclusive: false,
    usage: { effective: true, note: 'Once verified and ACTIVE, services may use the "Direct authorised processing" capability.' },
    modes: ['LIVE'],
  },
];

export const providerCode = (category: string, provider: string) => `${category}/${provider}`;
export const ALL_PROVIDER_CODES = PROVIDERS.map((p) => providerCode(p.category, p.provider));

/** `official-portal-access:mohre` -> { base: 'official-portal-access', instanceKey: 'mohre' } */
export function splitProvider(stored: string): { base: string; instanceKey: string | null } {
  const at = stored.indexOf(':');
  return at === -1 ? { base: stored, instanceKey: null } : { base: stored.slice(0, at), instanceKey: stored.slice(at + 1) };
}
export const storedProvider = (base: string, instanceKey: string | null | undefined) => (instanceKey ? `${base}:${instanceKey}` : base);

export function findProvider(category: string, storedOrBase: string): ProviderDef | undefined {
  const { base } = splitProvider(storedOrBase);
  return PROVIDERS.find((p) => p.category === category && p.provider === base);
}

export const AUTHORISATION_KEY = '_authorisation';
export type AuthorisationState = 'PENDING' | 'VERIFIED' | 'REJECTED';
/** Review bookkeeping of an authorisation record, kept in a reserved key of `config`. */
export interface AuthorisationMeta {
  state: AuthorisationState;
  submittedAt: string;
  evidenceDocumentId: string | null;
  reviewNote: string | null;
  reviewedAt: string | null;
}

export class ConfigProblem extends Error {
  constructor(
    message: string,
    public readonly field: string,
  ) {
    super(message);
  }
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+[1-9][0-9]{6,14}$/;

function coerce(field: FieldDef, raw: unknown): unknown {
  const bad = (why: string) => new ConfigProblem(`${field.label}: ${why}`, field.key);
  switch (field.type) {
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
      if (!Number.isInteger(n)) throw bad('enter a whole number.');
      if (field.min !== undefined && n < field.min) throw bad(`must be at least ${field.min}.`);
      if (field.max !== undefined && n > field.max) throw bad(`must be at most ${field.max}.`);
      return n;
    }
    case 'boolean':
      if (raw === true || raw === 'true') return true;
      if (raw === false || raw === 'false') return false;
      throw bad('choose yes or no.');
    case 'languageCodes': {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('send an object such as { "en": "en", "ar": "ar" }.');
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (!['en', 'ar'].includes(k) || typeof v !== 'string' || !/^[A-Za-z]{2,3}([_-][A-Za-z]{2,4})?$/.test(v)) throw bad('only "en" and "ar" with a language code such as en_US are allowed.');
        out[k] = v;
      }
      return out;
    }
    default: {
      if (typeof raw !== 'string') throw bad('enter text.');
      const text = raw.trim();
      const max = field.maxLength ?? 500;
      if (text.length > max) throw bad(`use at most ${max} characters.`);
      if (field.type === 'host' && !(HOST_RE.test(text) || IPV4_RE.test(text))) throw bad('enter a server name such as smtp.example.ae (no http://, no port).');
      if (field.type === 'email' && !EMAIL_RE.test(text)) throw bad('enter a valid email address.');
      if (field.type === 'phone' && !PHONE_RE.test(text.replace(/[\s()-]/g, ''))) throw bad('use international format, e.g. +971501234567.');
      if (field.type === 'date') {
        if (!DATE_RE.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) throw bad('use YYYY-MM-DD.');
      }
      if (field.type === 'url') {
        let url: URL;
        try {
          url = new URL(text);
        } catch {
          throw bad('enter a full address starting with https://.');
        }
        if (url.username || url.password) throw bad('do not put a user name or password in the address. Credentials belong in the credential fields.');
        return url.toString();
      }
      return field.type === 'phone' ? text.replace(/[\s()-]/g, '') : field.type === 'email' ? text.toLowerCase() : text;
    }
  }
}

/** Looks like a credential typed into a free-text field of an authorisation record. */
const CREDENTIAL_HINT = /\b(pass(word|code)?|pwd|otp|pin)\s*[:=]\s*\S+/i;

/**
 * Validates the non-secret configuration against the provider's fields:
 * unknown keys are refused, values are coerced to the field type, and (when
 * `complete`) every required field must be present. Returns the clean object.
 */
export function cleanConfig(def: ProviderDef, input: Record<string, unknown>, opts: { complete: boolean }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const known = new Map(def.configFields.map((f) => [f.key, f]));
  for (const [key, raw] of Object.entries(input ?? {})) {
    if (key === AUTHORISATION_KEY) continue;
    const field = known.get(key);
    if (!field) throw new ConfigProblem(`"${key}" is not a setting of ${def.name}.`, key);
    if (raw === null || raw === undefined || raw === '') continue;
    const value = coerce(field, raw);
    if (def.kind === 'AUTHORISATION_RECORD' && typeof value === 'string' && CREDENTIAL_HINT.test(value)) {
      throw new ConfigProblem(`${field.label}: this looks like a password or code. Never store portal credentials in TypEase.`, key);
    }
    out[key] = value;
  }
  if (opts.complete) {
    const missing = missingConfig(def, out);
    if (missing.length) throw new ConfigProblem(`Please fill in: ${missing.map((k) => known.get(k)!.label).join(', ')}.`, missing[0]);
  }
  if (typeof out.validFrom === 'string' && typeof out.validUntil === 'string' && out.validUntil < out.validFrom) {
    throw new ConfigProblem('"Valid until" cannot be before "Valid from".', 'validUntil');
  }
  return out;
}

export const missingConfig = (def: ProviderDef, config: Record<string, unknown>) =>
  def.configFields.filter((f) => f.required && (config[f.key] === undefined || config[f.key] === null || config[f.key] === '')).map((f) => f.key);
export const missingSecrets = (def: ProviderDef, secretKeys: string[]) => def.secretFields.filter((f) => f.required && !secretKeys.includes(f.key)).map((f) => f.key);

/**
 * Merges a write-only credential patch into the stored credentials. `null`
 * removes a value. Unknown keys are refused so a typo can never be stored as a
 * "secret" nobody reads.
 */
export function mergeSecrets(def: ProviderDef, current: Record<string, string>, patch: Record<string, string | null>): Record<string, string> {
  if (!def.secretFields.length) {
    throw new ConfigProblem(
      def.kind === 'AUTHORISATION_RECORD'
        ? `${def.name} is a record, not a connection: it never holds credentials. Portal user names and passwords must not be stored in TypEase.`
        : `${def.name} has no credentials.`,
      Object.keys(patch)[0] ?? 'secrets',
    );
  }
  const known = new Map(def.secretFields.map((f) => [f.key, f]));
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    const field = known.get(key);
    if (!field) throw new ConfigProblem(`"${key}" is not a credential of ${def.name}.`, key);
    if (value === null) {
      delete next[key];
      continue;
    }
    const max = field.maxLength ?? 2000;
    if (value.length > max) throw new ConfigProblem(`${field.label}: use at most ${max} characters.`, key);
    // Pasted keys very often carry a trailing newline or space.
    next[key] = value.trim();
  }
  const problem = def.validateSecrets?.(next);
  if (problem) throw new ConfigProblem(problem, def.secretFields[0].key);
  return next;
}

/** True when a change to `config` touches a field that the verification was based on. */
export function keyFieldsChanged(def: ProviderDef, before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  return def.configFields.filter((f) => f.keyField).some((f) => JSON.stringify(before[f.key] ?? null) !== JSON.stringify(after[f.key] ?? null));
}

/** What the catalogue endpoint shows for one provider. */
export function describeProvider(def: ProviderDef) {
  const field = (f: FieldDef) => ({ key: f.key, label: f.label, help: f.help ?? null, type: f.type, required: f.required === true, maxLength: f.maxLength ?? null, example: f.example ?? null });
  return {
    category: def.category,
    provider: def.provider,
    name: def.name,
    description: def.description,
    kind: def.kind,
    multiple: def.multiple === true,
    modes: def.modes,
    configFields: def.configFields.map(field),
    secretFields: def.secretFields.map(field),
    requiresVerification: def.kind === 'AUTHORISATION_RECORD',
    testable: def.test !== null,
    testNote: def.testNote,
    usage: def.usage,
  };
}
