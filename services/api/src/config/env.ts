import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === true || v === 'true' || v === '1'));
const int = (def: number) => z.coerce.number().int().default(def);
const csv = z
  .string()
  .default('')
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean));

/**
 * Every runtime setting of the API and worker. Validated at boot: the process
 * refuses to start with a missing or unsafe configuration.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** json = one structured object per line (default in production); text = readable console output. */
  LOG_FORMAT: z.enum(['json', 'text']).default(process.env.NODE_ENV === 'production' ? 'json' : 'text'),

  // Public URLs
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  CENTRE_WEB_URL: z.string().url().default('http://localhost:3001'),
  CUSTOMER_WEB_URL: z.string().url().default('http://localhost:3002'),
  CORPORATE_WEB_URL: z.string().url().default('http://localhost:3003'),
  PLATFORM_ADMIN_URL: z.string().url().default('http://localhost:3004'),
  /** Tenants get <slug>.<PLATFORM_BASE_DOMAIN> automatically. */
  PLATFORM_BASE_DOMAIN: z.string().default('typease.localhost'),
  /** The hostname customers point CNAME records at for custom domains. */
  CUSTOM_DOMAIN_CNAME_TARGET: z.string().default('portal.typease.localhost'),
  CORS_ORIGINS: csv,

  // Data stores
  DATABASE_URL: z.string().min(1),
  DATABASE_SYSTEM_URL: z.string().min(1),
  DATABASE_POOL_MAX: int(10),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Secrets
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL_SECONDS: int(900),
  REFRESH_TTL_DAYS: int(30),
  /** 32-byte key, base64. Encrypts identity numbers, MFA secrets, integration credentials, local files. */
  DATA_ENCRYPTION_KEY: z.string().min(40),
  /** Name of DATA_ENCRYPTION_KEY. It is stamped on everything that is encrypted; change it together with the key. */
  DATA_ENCRYPTION_KEY_ID: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, 'DATA_ENCRYPTION_KEY_ID may contain letters, digits, "-" and "_" (1-32 characters)').default('k1'),
  /** Previous keys ("id:base64,id:base64") kept for decryption during rotation. */
  DATA_ENCRYPTION_OLD_KEYS: z.string().default(''),
  /** Keyed-hash key for blind indexes and signed URLs. */
  HMAC_KEY: z.string().min(32),
  COOKIE_SECURE: bool(false),
  COOKIE_DOMAIN: z.string().optional(),

  // Auth policy
  MFA_ENFORCEMENT: z.enum(['required', 'optional']).default('optional'),
  LOGIN_MAX_FAILURES: int(5),
  LOGIN_LOCK_MINUTES: int(15),
  /** Minimum length of every password that is set. The shared validation schema has a floor of 10; this can only raise it. */
  PASSWORD_MIN_LENGTH: z.coerce.number().int().min(10, 'PASSWORD_MIN_LENGTH cannot be lower than 10').max(128).default(10),
  OTP_TTL_SECONDS: int(300),
  /** Development only: returns OTP / email tokens in API responses so flows work without providers. */
  EXPOSE_DEV_TOKENS: bool(false),
  SELF_SIGNUP_ENABLED: bool(true),
  TENANT_APPROVAL_REQUIRED: bool(false),
  ONBOARDING_REQUIRE_PHONE_VERIFICATION: bool(true),

  // Rate limiting
  RATE_LIMIT_ENABLED: bool(true),
  RATE_LIMIT_GLOBAL_PER_MINUTE: int(600),

  // Queue
  QUEUE_DRIVER: z.enum(['bullmq', 'inline']).default('bullmq'),
  /**
   * Single-process mode (small installs, demos): with QUEUE_DRIVER=inline the API itself runs
   * queued jobs and interval schedules, so no separate worker or Redis queue is needed.
   * Cron-style schedules still require the worker.
   */
  QUEUE_INLINE_AUTORUN: bool(false),

  // Background worker (services/worker)
  WORKER_CONCURRENCY: int(5),
  WORKER_HEALTH_PORT: int(4100),
  WORKER_OUTBOX_INTERVAL_MS: int(10_000),
  WORKER_SHUTDOWN_TIMEOUT_MS: int(30_000),
  /**
   * How often the process that runs background jobs (the worker, or the API in single-process mode) reports
   * that it is alive. The platform's system status calls it STALE after two intervals without a report.
   */
  WORKER_HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(300).default(15),

  // Object storage
  STORAGE_DRIVER: z.enum(['s3', 'local']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage-data'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('me-central-1'),
  S3_BUCKET: z.string().default('typease-documents'),
  S3_PUBLIC_ASSETS_BUCKET: z.string().default('typease-public-assets'),
  /** Optional CDN / public bucket URL for brand assets. When unset the API streams them from the bucket itself. */
  S3_PUBLIC_ASSETS_BASE_URL: z.string().url().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool(true),
  UPLOAD_MAX_BYTES: int(15 * 1024 * 1024),
  UPLOAD_ALLOWED_MIME: z.string().default('application/pdf,image/jpeg,image/png,image/webp'),
  DOWNLOAD_URL_TTL_SECONDS: int(120),
  UPLOAD_URL_TTL_SECONDS: int(600),

  // Malware scanning
  MALWARE_SCANNER: z.enum(['clamav', 'none']).default('none'),
  CLAMAV_HOST: z.string().default('localhost'),
  CLAMAV_PORT: int(3310),
  /** When true, a file may only be downloaded after a CLEAN scan result. */
  REQUIRE_CLEAN_SCAN: bool(false),

  // Platform default notification providers (tenants may configure their own)
  MAIL_DRIVER: z.enum(['smtp', 'log']).default('log'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: int(587),
  SMTP_SECURE: bool(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM_ADDRESS: z.string().default('no-reply@typease.localhost'),
  MAIL_FROM_NAME: z.string().default('TypEase'),
  SMS_DRIVER: z.enum(['twilio', 'http', 'log']).default('log'),
  SMS_HTTP_URL: z.string().optional(),
  SMS_HTTP_TOKEN: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM: z.string().optional(),
  WHATSAPP_DRIVER: z.enum(['meta', 'log']).default('log'),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  PUSH_DRIVER: z.enum(['fcm', 'log']).default('log'),
  FCM_PROJECT_ID: z.string().optional(),
  FCM_SERVICE_ACCOUNT_JSON: z.string().optional(),

  // AI / OCR
  OCR_PROVIDER: z.enum(['disabled', 'tesseract', 'external-http']).default('disabled'),
  OCR_EXTERNAL_URL: z.string().optional(),
  OCR_EXTERNAL_TOKEN: z.string().optional(),
  OCR_COST_PER_PAGE: z.coerce.number().default(0),

  // Payments
  /** Test adapter. Must stay off in production. */
  PAYMENT_SANDBOX_ENABLED: bool(false),
  PAYMENT_SANDBOX_WEBHOOK_SECRET: z.string().default('sandbox-webhook-secret-change-me'),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  PAYMENT_WEBHOOK_TOLERANCE_SECONDS: int(300),

  // Automation
  N8N_WEBHOOK_BASE_URL: z.string().optional(),
  N8N_WEBHOOK_SECRET: z.string().optional(),
  /** Hosts automations may call, comma separated. Everything else is blocked (SSRF protection). */
  OUTBOUND_WEBHOOK_ALLOWED_HOSTS: csv,

  // Internal
  /** Shared secret for the reverse proxy's on-demand TLS "ask" endpoint and metrics. */
  INTERNAL_API_TOKEN: z.string().min(16).default('dev-internal-token-change-me'),
});

export type Env = z.infer<typeof schema>;
/** Every variable this file validates, in declaration order. `.env.example` documents exactly these (test/env-drift.spec.ts). */
export const ENV_VARIABLES = Object.keys(schema.shape) as Array<keyof Env>;

// ---------------------------------------------------------------------------------------------
// Encryption keyring (DATA_ENCRYPTION_KEY, DATA_ENCRYPTION_KEY_ID, DATA_ENCRYPTION_OLD_KEYS)
// ---------------------------------------------------------------------------------------------
export interface Keyring {
  current: { id: string; key: Buffer };
  /** Every key that may decrypt, the current one included, by id. */
  all: Map<string, Buffer>;
}
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const decodeKey = (b64: string): Buffer | null => {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(b64)) return null;
  const key = Buffer.from(b64, 'base64');
  return key.length === 32 ? key : null;
};

/**
 * Parses and validates the keyring. Throws with every problem listed (never with key material in the text).
 * Encryption always uses `current`; decryption picks the key by the id stamped on the ciphertext.
 */
export function parseKeyring(e: Pick<Env, 'DATA_ENCRYPTION_KEY' | 'DATA_ENCRYPTION_KEY_ID' | 'DATA_ENCRYPTION_OLD_KEYS'>): Keyring {
  const problems: string[] = [];
  const current = decodeKey(e.DATA_ENCRYPTION_KEY);
  if (!current) problems.push('DATA_ENCRYPTION_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32)');
  const all = new Map<string, Buffer>();
  if (current) all.set(e.DATA_ENCRYPTION_KEY_ID, current);
  for (const [index, part] of e.DATA_ENCRYPTION_OLD_KEYS.split(',').map((x) => x.trim()).filter(Boolean).entries()) {
    const at = part.indexOf(':');
    const id = at > 0 ? part.slice(0, at) : '';
    const key = at > 0 ? decodeKey(part.slice(at + 1)) : null;
    const label = `DATA_ENCRYPTION_OLD_KEYS entry ${index + 1}${id ? ` ("${id}")` : ''}`;
    if (!KEY_ID.test(id)) problems.push(`${label}: expected "id:base64key" with an id of letters, digits, "-" or "_"`);
    else if (!key) problems.push(`${label}: the key must be 32 bytes, base64 encoded`);
    else if (id === e.DATA_ENCRYPTION_KEY_ID) {
      // The same id for two different keys would make old data undecryptable without anybody noticing.
      if (!current || !key.equals(current)) problems.push(`${label}: this id is the id of the current key (DATA_ENCRYPTION_KEY_ID) but the key is different. Give the new key a new id.`);
    } else if (all.has(id)) {
      if (!all.get(id)!.equals(key)) problems.push(`${label}: the id is listed twice with different keys`);
    } else all.set(id, key);
  }
  if (problems.length) throw new Error(`Invalid encryption key configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  return { current: { id: e.DATA_ENCRYPTION_KEY_ID, key: current! }, all };
}

// ---------------------------------------------------------------------------------------------
// Secrets that must not reach production
// ---------------------------------------------------------------------------------------------
/** Values that are published in .env.example, the documentation, the test setup and the development compose file. */
export const KNOWN_PLACEHOLDER_SECRETS = [
  'local-development-jwt-secret-0123456789abcdef',
  'local-development-hmac-key-0123456789abcdef',
  'bG9jYWwtZGV2ZWxvcG1lbnQta2V5LTMyLWJ5dGVzISE=',
  'test-only-jwt-secret-0123456789abcdef0123456789abcdef',
  'test-only-hmac-key-0123456789abcdef0123456789abcdef',
  'dev-internal-token-change-me',
  'docker-development-jwt-secret-0123456789abcdef',
  'docker-development-hmac-key-0123456789abcdef',
  'dHlwZWFzZS1kb2NrZXItZGV2LWtleS0zMi1ieXRlcyE=',
  'ci-e2e-only-jwt-secret-0123456789abcdef0123456789',
  'ci-e2e-only-hmac-key-0123456789abcdef0123456789',
  'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
];
const PLACEHOLDER_WORDS = /change[-_ ]?me|example|placeholder|local[-_]dev|development|test[-_]only|dev[-_]|your[-_]|secret[-_]?key|password|0123456789|abcdefgh|qwerty/i;

/** Shannon entropy of the characters of a text, in bits for the whole text. A typed phrase scores low, random output high. */
export function entropyBits(value: string | Buffer): number {
  const units = typeof value === 'string' ? [...value] : [...value.values()].map(String);
  if (!units.length) return 0;
  const counts = new Map<string, number>();
  for (const u of units) counts.set(u, (counts.get(u) ?? 0) + 1);
  let perUnit = 0;
  for (const n of counts.values()) perUnit -= (n / units.length) * Math.log2(n / units.length);
  return perUnit * units.length;
}

/** Why a text secret (JWT signing secret, HMAC key) is not acceptable in production. Empty = acceptable. */
export function weakSecretReasons(name: string, value: string): string[] {
  const reasons: string[] = [];
  if (KNOWN_PLACEHOLDER_SECRETS.includes(value)) return [`${name} is the published development / example value`];
  if (value.length < 32) reasons.push(`${name} must be at least 32 characters`);
  if (PLACEHOLDER_WORDS.test(value)) reasons.push(`${name} looks like a placeholder or a typed phrase`);
  // By this measure 32 random base64 characters carry about 150 bits and 32 random hex characters about 115;
  // a repeated or patterned value falls far below.
  if (entropyBits(value) < 100 || new Set(value).size < 10) reasons.push(`${name} is not random enough (generate it: openssl rand -base64 48)`);
  return reasons.length ? [`${reasons.join('; ')}`] : [];
}

/** Why an encryption key is not acceptable in production. Empty = acceptable. Never includes key material. */
export function weakKeyReasons(name: string, base64: string): string[] {
  if (KNOWN_PLACEHOLDER_SECRETS.includes(base64)) return [`${name} is the published development / example value`];
  const key = decodeKey(base64);
  if (!key) return [`${name} must be 32 bytes, base64 encoded`];
  // 32 random bytes are practically never all printable text; a key somebody typed always is.
  if ([...key.values()].every((b) => b >= 0x20 && b <= 0x7e)) return [`${name} is text somebody typed, not random bytes (generate it: openssl rand -base64 32)`];
  if (new Set(key.values()).size < 20) return [`${name} is not random enough (generate it: openssl rand -base64 32)`];
  return [];
}

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  // In every environment: a keyring that cannot be read is found at start-up, not when the first customer is opened.
  const keyring = parseKeyring(e);
  if (e.NODE_ENV === 'production') {
    const problems: string[] = [];
    if (e.PAYMENT_SANDBOX_ENABLED) problems.push('PAYMENT_SANDBOX_ENABLED must be false in production');
    if (e.EXPOSE_DEV_TOKENS) problems.push('EXPOSE_DEV_TOKENS must be false in production');
    if (!e.COOKIE_SECURE) problems.push('COOKIE_SECURE must be true in production');
    if (e.MFA_ENFORCEMENT !== 'required') problems.push('MFA_ENFORCEMENT must be "required" in production');
    if (e.INTERNAL_API_TOKEN.includes('change-me')) problems.push('INTERNAL_API_TOKEN must be changed');
    if (e.STORAGE_DRIVER === 's3' && (!e.S3_ACCESS_KEY_ID || !e.S3_SECRET_ACCESS_KEY) && !process.env.AWS_ROLE_ARN)
      problems.push('S3 credentials are required for STORAGE_DRIVER=s3');
    problems.push(...weakSecretReasons('JWT_ACCESS_SECRET', e.JWT_ACCESS_SECRET));
    problems.push(...weakSecretReasons('HMAC_KEY', e.HMAC_KEY));
    problems.push(...weakKeyReasons('DATA_ENCRYPTION_KEY', e.DATA_ENCRYPTION_KEY));
    for (const [id, key] of keyring.all) {
      if (id !== keyring.current.id) problems.push(...weakKeyReasons(`DATA_ENCRYPTION_OLD_KEYS key "${id}"`, key.toString('base64')));
    }
    if (KNOWN_PLACEHOLDER_SECRETS.includes(e.INTERNAL_API_TOKEN) || e.INTERNAL_API_TOKEN.length < 24) problems.push('INTERNAL_API_TOKEN must be a generated value of at least 24 characters');
    // One secret per purpose: a leak of one must not open the others.
    const reused = [['JWT_ACCESS_SECRET', e.JWT_ACCESS_SECRET], ['HMAC_KEY', e.HMAC_KEY], ['DATA_ENCRYPTION_KEY', e.DATA_ENCRYPTION_KEY], ['INTERNAL_API_TOKEN', e.INTERNAL_API_TOKEN]] as const;
    for (let i = 0; i < reused.length; i++) for (let j = i + 1; j < reused.length; j++) if (reused[i][1] === reused[j][1]) problems.push(`${reused[i][0]} and ${reused[j][0]} must be different values`);
    if (problems.length) throw new Error(`Unsafe production configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
  return e;
}

export function env(): Env {
  if (!cached) cached = loadEnv();
  return cached;
}
/** Tests only. */
export function resetEnvCache() {
  cached = undefined;
}
