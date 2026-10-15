#!/usr/bin/env node
/**
 * TypEase production-readiness gate.
 *
 * Run it against the environment you are about to deploy, BEFORE the deploy:
 *
 *   node scripts/production-readiness.mjs --env-file /etc/typease/typease.env --env-file /etc/typease/migrate.env
 *   pnpm check:production -- --env-file ./prod.env --backup-marker /var/backups/typease/last-success.json
 *   docker compose -f docker-compose.prod.yml run --rm migrate node scripts/production-readiness.mjs   # inside the stack
 *
 * What it does
 *   1. Validates the environment with the same rules as services/api/src/config/env.ts
 *      (plus stricter go-live rules: HTTPS public URLs, no placeholder or development secrets ...).
 *   2. Connects to PostgreSQL and inspects the real state: migrations, role attributes,
 *      table ownership, row-level security, immutability triggers, demo data, platform admins.
 *   3. Probes Redis and (when enabled) ClamAV.
 *   4. Looks for evidence of a recent, encrypted backup.
 *
 * Output: a PASS / WARN / FAIL table. Exit code 0 = no FAIL, 1 = at least one FAIL,
 * 2 = the script itself could not run. `--strict` turns WARN into a failing exit code.
 *
 * Secret values are never printed: details only mention names, lengths and booleans,
 * and every line is scrubbed against the secret values that were loaded.
 *
 * Dependencies: Node built-ins and `pg` (resolved from the `database` workspace package).
 * It only reads: every database statement runs in a READ ONLY transaction.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// --------------------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const values = (name) => {
  const out = [];
  argv.forEach((a, i) => {
    if (a === `--${name}` && argv[i + 1] !== undefined) out.push(argv[i + 1]);
    else if (a.startsWith(`--${name}=`)) out.push(a.slice(name.length + 3));
  });
  return out;
};
const value = (name) => values(name).pop();

if (flag('help') || flag('h')) {
  console.log(`TypEase production-readiness gate

Usage: node scripts/production-readiness.mjs [options]

  --env-file <path>       Environment file to check (repeatable; later files win).
                          When given, ONLY the file(s) are checked - the shell environment is
                          ignored, so the result describes the file. Add --inherit-env to overlay it.
  --inherit-env           Also read the process environment (the file still wins).
  --database-url <url>    Connection used for the inspection (default: DATABASE_MIGRATION_URL,
                          then DATABASE_SYSTEM_URL). Needs to read schema_migrations and users.
  --migrations-dir <dir>  Default: database/migrations
  --backup-marker <file>  Marker written by scripts/db-backup.sh (default: $BACKUP_MARKER_FILE)
  --backup-max-age-hours <n>   Default 26
  --skip-db | --skip-redis | --skip-network   Skip live probes (reported as SKIP, never as PASS)
  --strict                WARN also produces a non-zero exit code
  --json                  Machine-readable output
  --no-color
`);
  process.exit(0);
}

// --------------------------------------------------------------------------- environment
function parseEnvFile(path) {
  const out = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

const envFiles = values('env-file');
let source = {};
let sourceLabel;
try {
  if (envFiles.length) {
    if (flag('inherit-env')) source = { ...process.env };
    for (const f of envFiles) source = { ...source, ...parseEnvFile(resolve(f)) };
    sourceLabel = `${envFiles.join(', ')}${flag('inherit-env') ? ' + process environment' : ''}`;
  } else {
    source = { ...process.env };
    sourceLabel = 'process environment';
  }
} catch (e) {
  console.error(`Cannot read the environment file: ${e.code ?? ''} ${e.path ?? ''}`.trim());
  process.exit(2);
}

/** Defaults copied from services/api/src/config/env.ts - keep in sync (the script compares them at the end). */
const DEFAULTS = {
  NODE_ENV: 'development',
  API_PUBLIC_URL: 'http://localhost:4000',
  CENTRE_WEB_URL: 'http://localhost:3001',
  CUSTOMER_WEB_URL: 'http://localhost:3002',
  CORPORATE_WEB_URL: 'http://localhost:3003',
  PLATFORM_ADMIN_URL: 'http://localhost:3004',
  PLATFORM_BASE_DOMAIN: 'typease.localhost',
  CUSTOM_DOMAIN_CNAME_TARGET: 'portal.typease.localhost',
  REDIS_URL: 'redis://localhost:6379',
  MFA_ENFORCEMENT: 'optional',
  QUEUE_DRIVER: 'bullmq',
  STORAGE_DRIVER: 'local',
  S3_BUCKET: 'typease-documents',
  S3_PUBLIC_ASSETS_BUCKET: 'typease-public-assets',
  MALWARE_SCANNER: 'none',
  CLAMAV_HOST: 'localhost',
  CLAMAV_PORT: '3310',
  MAIL_DRIVER: 'log',
  MAIL_FROM_ADDRESS: 'no-reply@typease.localhost',
  SMS_DRIVER: 'log',
  WHATSAPP_DRIVER: 'log',
  PUSH_DRIVER: 'log',
  OCR_PROVIDER: 'disabled',
  PAYMENT_SANDBOX_WEBHOOK_SECRET: 'sandbox-webhook-secret-change-me',
  INTERNAL_API_TOKEN: 'dev-internal-token-change-me',
  LOG_LEVEL: 'info',
  DATA_ENCRYPTION_KEY_ID: 'k1',
  PASSWORD_MIN_LENGTH: '10',
  WORKER_HEARTBEAT_INTERVAL_SECONDS: '15',
};
const isSet = (k) => source[k] !== undefined && source[k] !== '';
const get = (k) => (isSet(k) ? source[k] : (DEFAULTS[k] ?? ''));
/** Same semantics as the `bool()` helper in env.ts. */
const bool = (k, def) => (!isSet(k) ? def : source[k] === 'true' || source[k] === '1');
const csv = (k) => get(k).split(',').map((x) => x.trim()).filter(Boolean);

// Values that must never appear in the output.
const SECRET_KEYS = /SECRET|PASSWORD|TOKEN|_KEY$|_KEYS$|KEY_ID|CREDENTIAL|SERVICE_ACCOUNT|PASSPHRASE|_SID$/i;
const secrets = new Set();
for (const [k, v] of Object.entries(source)) {
  if (!v) continue;
  if (SECRET_KEYS.test(k) && v.length >= 6) secrets.add(v);
  if (/_URL$/.test(k) || k === 'REDIS_URL') {
    try {
      const u = new URL(v);
      if (u.password) {
        secrets.add(u.password);
        secrets.add(decodeURIComponent(u.password));
      }
    } catch {
      /* not a URL */
    }
  }
}
const scrub = (text) => {
  let out = String(text ?? '');
  for (const s of secrets) if (s.length >= 6) out = out.split(s).join('***');
  // Anything that still looks like credentials in a URL.
  return out.replace(/(\w+:\/\/[^:\s/@]+):[^@\s]+@/g, '$1:***@');
};

// --------------------------------------------------------------------------- result collection
const results = [];
const add = (status, group, check, detail = '') => results.push({ status, group, check, detail: scrub(detail) });
const pass = (g, c, d) => add('PASS', g, c, d);
const warn = (g, c, d) => add('WARN', g, c, d);
const fail = (g, c, d) => add('FAIL', g, c, d);
const skip = (g, c, d) => add('SKIP', g, c, d);
const expect = (ok, g, c, okDetail, failDetail, level = 'FAIL') => add(ok ? 'PASS' : level, g, c, ok ? okDetail : failDetail);

const safeUrl = (raw) => {
  try {
    const u = new URL(raw);
    return { ok: true, u, text: `${u.protocol}//${u.username ? `${decodeURIComponent(u.username)}@` : ''}${u.host}${u.pathname}` };
  } catch {
    return { ok: false, text: '(not a valid URL)' };
  }
};
// --------------------------------------------------------------------------- secret rules of env.ts
// The API refuses to start in production with a secret that breaks one of these rules. They are
// repeated here (this script runs without the TypeScript sources) and kept identical by a test:
// services/api/test/env-drift.spec.ts compares the list and the functions' results with env.ts.
/** Values published in .env.example, the documentation, the test setup and the development compose files. */
const KNOWN_PLACEHOLDER_SECRETS = [
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
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
/** Shannon entropy of the characters (or bytes) of a value, in bits for the whole value. */
function entropyBits(value) {
  const units = typeof value === 'string' ? [...value] : [...value.values()].map(String);
  if (!units.length) return 0;
  const counts = new Map();
  for (const u of units) counts.set(u, (counts.get(u) ?? 0) + 1);
  let perUnit = 0;
  for (const n of counts.values()) perUnit -= (n / units.length) * Math.log2(n / units.length);
  return perUnit * units.length;
}
/** Why a text secret (JWT signing secret, HMAC key) is not acceptable in production. Empty = acceptable. */
function weakSecretReasons(name, value) {
  const reasons = [];
  if (KNOWN_PLACEHOLDER_SECRETS.includes(value)) return [`${name} is the published development / example value`];
  if (value.length < 32) reasons.push(`${name} must be at least 32 characters`);
  if (PLACEHOLDER_WORDS.test(value)) reasons.push(`${name} looks like a placeholder or a typed phrase`);
  if (entropyBits(value) < 100 || new Set(value).size < 10) reasons.push(`${name} is not random enough (generate it: openssl rand -base64 48)`);
  return reasons.length ? [`${reasons.join('; ')}`] : [];
}
const decodeKey = (b64) => {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(b64)) return null;
  const key = Buffer.from(b64, 'base64');
  return key.length === 32 ? key : null;
};
/** Why an encryption key is not acceptable in production. Empty = acceptable. Never includes key material. */
function weakKeyReasons(name, base64) {
  if (KNOWN_PLACEHOLDER_SECRETS.includes(base64)) return [`${name} is the published development / example value`];
  const key = decodeKey(base64);
  if (!key) return [`${name} must be 32 bytes, base64 encoded`];
  if ([...key.values()].every((b) => b >= 0x20 && b <= 0x7e)) return [`${name} is text somebody typed, not random bytes (generate it: openssl rand -base64 32)`];
  if (new Set(key.values()).size < 20) return [`${name} is not random enough (generate it: openssl rand -base64 32)`];
  return [];
}
/** The keyring rules of env.ts (parseKeyring): problems as text, never with key material. */
function keyringProblems(currentB64, currentId, oldKeys) {
  const problems = [];
  const current = decodeKey(currentB64);
  if (!current) problems.push('DATA_ENCRYPTION_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32)');
  const all = new Map();
  if (current) all.set(currentId, current);
  for (const [index, part] of oldKeys.split(',').map((x) => x.trim()).filter(Boolean).entries()) {
    const at = part.indexOf(':');
    const id = at > 0 ? part.slice(0, at) : '';
    const key = at > 0 ? decodeKey(part.slice(at + 1)) : null;
    const label = `DATA_ENCRYPTION_OLD_KEYS entry ${index + 1}${id ? ` ("${id}")` : ''}`;
    if (!KEY_ID.test(id)) problems.push(`${label}: expected "id:base64key" with an id of letters, digits, "-" or "_"`);
    else if (!key) problems.push(`${label}: the key must be 32 bytes, base64 encoded`);
    else if (id === currentId) {
      if (!current || !key.equals(current)) problems.push(`${label}: this id is the id of the current key (DATA_ENCRYPTION_KEY_ID) but the key is different. Give the new key a new id.`);
    } else if (all.has(id)) {
      if (!all.get(id).equals(key)) problems.push(`${label}: the id is listed twice with different keys`);
    } else all.set(id, key);
  }
  return { problems, all };
}
/** For the test that keeps this script and env.ts in step. Nothing below runs when it is set. */
if (process.env.TYPEASE_READINESS_EXPORT_RULES === '1') {
  const sample = JSON.parse(process.env.TYPEASE_READINESS_RULE_SAMPLES ?? '{"secrets":[],"keys":[],"keyrings":[]}');
  console.log(JSON.stringify({
    known: KNOWN_PLACEHOLDER_SECRETS,
    defaults: DEFAULTS,
    secrets: sample.secrets.map((v) => weakSecretReasons('X', v)),
    keys: sample.keys.map((v) => weakKeyReasons('X', v)),
    keyrings: sample.keyrings.map(([key, id, old]) => keyringProblems(key, id, old).problems),
  }));
  process.exit(0);
}

const LOCAL_HOST = /(^|\.)localhost$|^127\.|^0\.0\.0\.0$|^\[?::1\]?$|\.local$|\.test$|\.example$|\.invalid$|(^|\.)example\.(com|org|net)$/i;
const PLACEHOLDER = /change[-_ ]?me|dev[-_]|example|placeholder|replace[-_ ]?(?:me|this|with)|local[-_]development|test[-_]only|your[-_]|x{6,}|<[^>]*>|^(.)\1+$|0123456789abcdef/i;

// =========================================================================== 1. environment
function checkEnvironment() {
  const G = 'Environment';

  expect(get('NODE_ENV') === 'production', G, 'NODE_ENV is production', 'production', `NODE_ENV is "${get('NODE_ENV')}" - the API only applies its production safety checks when it is "production"`);

  // --- secrets: the rules env.ts applies at start-up in production (weakSecretReasons / weakKeyReasons /
  //     parseKeyring), plus this script's own, stricter placeholder pattern
  for (const k of ['JWT_ACCESS_SECRET', 'HMAC_KEY']) {
    if (!isSet(k)) {
      fail(G, `${k} is set`, 'missing (required)');
      continue;
    }
    const v = source[k];
    const reasons = weakSecretReasons(k, v);
    if (reasons.length) fail(G, `${k} is a generated secret`, `${reasons.join('; ')} - the API refuses to start with it`);
    else if (PLACEHOLDER.test(v)) fail(G, `${k} is a generated secret`, 'looks like a placeholder / development value (matches the placeholder pattern)');
    else pass(G, `${k} is a generated secret`, `${v.length} characters, about ${Math.round(entropyBits(v))} bits by character statistics`);
  }
  if (!isSet('INTERNAL_API_TOKEN')) fail(G, 'INTERNAL_API_TOKEN is set', 'not set: the built-in development default would be used');
  else {
    const v = source.INTERNAL_API_TOKEN;
    if (KNOWN_PLACEHOLDER_SECRETS.includes(v) || v.includes('change-me') || PLACEHOLDER.test(v)) fail(G, 'INTERNAL_API_TOKEN is a generated secret', 'a published development value or a placeholder - the API refuses to start with it');
    else if (v.length < 24) fail(G, 'INTERNAL_API_TOKEN is a generated secret', `${v.length} characters: production needs a generated value of at least 24 (openssl rand -base64 32)`);
    else pass(G, 'INTERNAL_API_TOKEN is a generated secret', `${v.length} characters`);
  }
  if (!isSet('DATA_ENCRYPTION_KEY')) fail(G, 'DATA_ENCRYPTION_KEY is set', 'missing (required)');
  else {
    const keyId = get('DATA_ENCRYPTION_KEY_ID');
    if (!KEY_ID.test(keyId)) fail(G, 'DATA_ENCRYPTION_KEY_ID is valid', 'it may contain letters, digits, "-" and "_" (1-32 characters)');
    const weak = weakKeyReasons('DATA_ENCRYPTION_KEY', source.DATA_ENCRYPTION_KEY);
    if (source.DATA_ENCRYPTION_KEY.length < 40) fail(G, 'DATA_ENCRYPTION_KEY is 32 random bytes', `${source.DATA_ENCRYPTION_KEY.length} characters: base64 of 32 bytes has 44 (openssl rand -base64 32)`);
    else if (weak.length) fail(G, 'DATA_ENCRYPTION_KEY is 32 random bytes', `${weak.join('; ')} - the API refuses to start with it`);
    else pass(G, 'DATA_ENCRYPTION_KEY is 32 random bytes', KEY_ID.test(keyId) ? `key id "${keyId}"${isSet('DATA_ENCRYPTION_KEY_ID') ? '' : ' (the default: set DATA_ENCRYPTION_KEY_ID explicitly, it matters at the first rotation)'}` : '');
    // The keyring: read at every start, in every environment. A mistake here stops the API.
    const ring = keyringProblems(source.DATA_ENCRYPTION_KEY, keyId, get('DATA_ENCRYPTION_OLD_KEYS'));
    const oldIds = [...ring.all.keys()].filter((id) => id !== keyId);
    const weakOld = oldIds.flatMap((id) => weakKeyReasons(`DATA_ENCRYPTION_OLD_KEYS key "${id}"`, ring.all.get(id).toString('base64')));
    if (ring.problems.length) fail(G, 'Encryption keyring is readable', ring.problems.join('; '));
    else if (weakOld.length) fail(G, 'Encryption keyring is readable', `${weakOld.join('; ')} - the API refuses to start with it`);
    else if (oldIds.length) warn(G, 'Encryption keyring is readable', `${oldIds.length} previous key(s) kept for decryption (${oldIds.join(', ')}): a rotation is in progress. Run "pnpm --filter @typease/api reencrypt", then remove the entry once nothing is left under that id`);
    else pass(G, 'Encryption keyring is readable', 'one key, no rotation in progress');
  }
  const distinct = ['JWT_ACCESS_SECRET', 'HMAC_KEY', 'DATA_ENCRYPTION_KEY', 'INTERNAL_API_TOKEN', 'N8N_WEBHOOK_SECRET'].filter(isSet);
  const reused = distinct.filter((k, i) => distinct.some((o, j) => j !== i && source[o] === source[k]));
  expect(reused.length === 0, G, 'Secrets are distinct', `${distinct.length} secrets, all different`, `the same value is used for: ${reused.join(', ')}`);

  // --- flags enforced by env.ts in production
  expect(!bool('PAYMENT_SANDBOX_ENABLED', false), G, 'PAYMENT_SANDBOX_ENABLED is off', 'false', 'the sandbox payment adapter is enabled: payments could be "completed" without money');
  expect(!bool('EXPOSE_DEV_TOKENS', false), G, 'EXPOSE_DEV_TOKENS is off', 'false', 'OTP / verification tokens would be returned in API responses');
  expect(bool('COOKIE_SECURE', false), G, 'COOKIE_SECURE is on', 'true', 'refresh cookies would be sent over plain HTTP');
  expect(get('MFA_ENFORCEMENT') === 'required', G, 'MFA_ENFORCEMENT is required', 'required', `"${get('MFA_ENFORCEMENT')}" - privileged roles could sign in without a second factor`);
  expect(bool('RATE_LIMIT_ENABLED', true), G, 'RATE_LIMIT_ENABLED is on', 'true', 'rate limiting is disabled (login, signup and OTP endpoints are unprotected)');

  // --- public URLs
  for (const k of ['API_PUBLIC_URL', 'CENTRE_WEB_URL', 'CUSTOMER_WEB_URL', 'CORPORATE_WEB_URL', 'PLATFORM_ADMIN_URL']) {
    const p = safeUrl(get(k));
    if (!isSet(k)) fail(G, `${k} is HTTPS`, `not set: the development default ${DEFAULTS[k]} would be used`);
    else if (!p.ok) fail(G, `${k} is HTTPS`, 'not a valid URL');
    else if (p.u.protocol !== 'https:') fail(G, `${k} is HTTPS`, `${p.text} is not https`);
    else if (LOCAL_HOST.test(p.u.hostname)) fail(G, `${k} is HTTPS`, `${p.text} is a local / reserved host name`);
    else if (p.u.pathname !== '/' || get(k).endsWith('/')) warn(G, `${k} is HTTPS`, `${p.text}: use the bare origin without a path or trailing slash (it is compared with the browser Origin header)`);
    else pass(G, `${k} is HTTPS`, p.text);
  }
  const badOrigins = csv('CORS_ORIGINS').filter((o) => {
    const p = safeUrl(o);
    return !p.ok || p.u.protocol !== 'https:' || LOCAL_HOST.test(p.u.hostname) || o.includes('*');
  });
  expect(badOrigins.length === 0, G, 'CORS_ORIGINS are HTTPS origins', csv('CORS_ORIGINS').length ? `${csv('CORS_ORIGINS').length} extra origin(s)` : 'none (the four app URLs and verified tenant domains are always allowed)', `not acceptable in production: ${badOrigins.join(', ')}`);

  for (const k of ['PLATFORM_BASE_DOMAIN', 'CUSTOM_DOMAIN_CNAME_TARGET']) {
    const v = get(k);
    if (!isSet(k)) fail(G, `${k} is a real domain`, `not set: the development default ${DEFAULTS[k]} would be used`);
    else if (LOCAL_HOST.test(v) || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(v)) fail(G, `${k} is a real domain`, `"${v}" is not a public host name`);
    else pass(G, `${k} is a real domain`, v);
  }
  if (isSet('COOKIE_DOMAIN') && isSet('PLATFORM_BASE_DOMAIN')) {
    const cd = get('COOKIE_DOMAIN').replace(/^\./, '');
    expect(get('PLATFORM_BASE_DOMAIN') === cd || get('PLATFORM_BASE_DOMAIN').endsWith(`.${cd}`) || safeUrl(get('API_PUBLIC_URL')).u?.hostname.endsWith(cd), G, 'COOKIE_DOMAIN matches the API host', cd, `"${cd}" is not a parent of the API host: browsers will reject the refresh cookie`);
  }

  // --- database URLs
  const dbRoles = { DATABASE_URL: 'typease_app', DATABASE_SYSTEM_URL: 'typease_system' };
  const passwords = [];
  for (const [k, role] of Object.entries(dbRoles)) {
    if (!isSet(k)) {
      fail(G, `${k} is set`, 'missing (required)');
      continue;
    }
    const p = safeUrl(source[k]);
    if (!p.ok) {
      fail(G, `${k} is valid`, 'not a valid connection URL');
      continue;
    }
    const user = decodeURIComponent(p.u.username);
    const pw = decodeURIComponent(p.u.password);
    passwords.push(pw);
    if (user !== role) fail(G, `${k} connects as ${role}`, `connects as "${user}" - the migration runner and tenant isolation require the role "${role}"`);
    else if (!pw) fail(G, `${k} has a password`, 'no password in the URL');
    else if (pw.length < 16 || /_dev_pw$|^(password|postgres|typease|secret|changeme)$/i.test(pw) || PLACEHOLDER.test(pw)) fail(G, `${k} password is strong`, `password is ${pw.length} characters and/or a known development / placeholder value`);
    else pass(G, `${k} connects as ${role}`, p.text);
    const ssl = p.u.searchParams.get('sslmode');
    const internal = !p.u.hostname.includes('.') || LOCAL_HOST.test(p.u.hostname) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(p.u.hostname);
    if (!ssl && !internal) warn(G, `${k} uses TLS`, `${p.u.hostname} is not a private address and the URL has no sslmode parameter (use sslmode=require or verify-full for managed databases)`);
  }
  if (isSet('DATABASE_MIGRATION_URL')) {
    const p = safeUrl(source.DATABASE_MIGRATION_URL);
    if (p.ok) {
      const user = decodeURIComponent(p.u.username);
      const pw = decodeURIComponent(p.u.password);
      passwords.push(pw);
      if (Object.values(dbRoles).includes(user)) fail(G, 'DATABASE_MIGRATION_URL uses the owner role', `connects as "${user}": migrations must run as the schema owner, never as a runtime role`);
      else if (pw.length < 16 || /_dev_pw$/i.test(pw) || PLACEHOLDER.test(pw)) fail(G, 'DATABASE_MIGRATION_URL password is strong', `password is ${pw.length} characters and/or a known development / placeholder value`);
      else pass(G, 'DATABASE_MIGRATION_URL uses the owner role', p.text);
    } else fail(G, 'DATABASE_MIGRATION_URL is valid', 'not a valid connection URL');
  }
  if (passwords.length > 1) expect(new Set(passwords).size === passwords.length, G, 'Database roles have different passwords', `${passwords.length} roles`, 'two database roles share a password: a leak of the app credentials would also expose a more powerful role');

  // --- Redis / queue
  const r = safeUrl(get('REDIS_URL'));
  if (!isSet('REDIS_URL')) fail(G, 'REDIS_URL is set', `not set: the development default ${DEFAULTS.REDIS_URL} would be used`);
  else if (!r.ok || !/^rediss?:$/.test(r.u.protocol)) fail(G, 'REDIS_URL is valid', 'must be a redis:// or rediss:// URL');
  else {
    const internal = !r.u.hostname.includes('.') || LOCAL_HOST.test(r.u.hostname);
    if (!r.u.password && !internal) warn(G, 'REDIS_URL has credentials', `${r.u.hostname}: no password in the URL`);
    else if (r.u.protocol === 'redis:' && !internal) warn(G, 'REDIS_URL uses TLS', `${r.u.hostname} is not a local service name: use rediss://`);
    else pass(G, 'REDIS_URL is set', r.text);
  }
  if (get('QUEUE_DRIVER') === 'inline') warn(G, 'QUEUE_DRIVER is bullmq', `inline${bool('QUEUE_INLINE_AUTORUN', false) ? ' with QUEUE_INLINE_AUTORUN (single-process mode)' : ' WITHOUT QUEUE_INLINE_AUTORUN: queued jobs would never run'}: jobs live in the API's memory and are lost on restart; cron schedules need the worker`);
  else pass(G, 'QUEUE_DRIVER is bullmq', 'jobs are executed by the worker service');

  // --- object storage
  if (get('STORAGE_DRIVER') !== 's3') fail(G, 'STORAGE_DRIVER is s3', `"${get('STORAGE_DRIVER')}": files would live on the API container's disk (not shared between replicas, lost with the container unless a volume is mounted and backed up)`);
  else {
    const hasCreds = (isSet('S3_ACCESS_KEY_ID') && isSet('S3_SECRET_ACCESS_KEY')) || isSet('AWS_ROLE_ARN');
    expect(hasCreds, G, 'S3 credentials are configured', isSet('AWS_ROLE_ARN') ? 'AWS_ROLE_ARN' : 'access key pair', 'S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY (or AWS_ROLE_ARN) are required for STORAGE_DRIVER=s3');
    expect(isSet('S3_BUCKET'), G, 'S3_BUCKET is configured', get('S3_BUCKET'), `not set: the default bucket name "${DEFAULTS.S3_BUCKET}" would be used - set it explicitly`, 'WARN');
    expect(get('S3_BUCKET') !== get('S3_PUBLIC_ASSETS_BUCKET'), G, 'Private and public buckets differ', `${get('S3_BUCKET')} / ${get('S3_PUBLIC_ASSETS_BUCKET')}`, 'S3_BUCKET and S3_PUBLIC_ASSETS_BUCKET are the same bucket: customer documents must never share a bucket with public assets');
    if (isSet('S3_ACCESS_KEY_ID') && /^(minioadmin|typease-dev|admin|test)/i.test(source.S3_ACCESS_KEY_ID)) fail(G, 'S3 credentials are not development defaults', 'S3_ACCESS_KEY_ID is a well-known development value');
    if (isSet('S3_ENDPOINT')) {
      const p = safeUrl(source.S3_ENDPOINT);
      if (!p.ok) fail(G, 'S3_ENDPOINT is valid', 'not a valid URL');
      else if (p.u.protocol !== 'https:') fail(G, 'S3_ENDPOINT is HTTPS', `${p.text}: browsers upload and download through presigned URLs on this endpoint, so it must be HTTPS and publicly resolvable`);
      else pass(G, 'S3_ENDPOINT is HTTPS', p.text);
    }
  }

  // --- malware scanning
  const scanner = get('MALWARE_SCANNER');
  if (scanner === 'none' && bool('REQUIRE_CLEAN_SCAN', false)) fail(G, 'Malware scanning', 'REQUIRE_CLEAN_SCAN=true with MALWARE_SCANNER=none: no upload would ever become downloadable');
  else if (scanner === 'none') warn(G, 'Malware scanning is enabled', 'MALWARE_SCANNER=none: uploads are marked SKIPPED and are never scanned');
  else if (!bool('REQUIRE_CLEAN_SCAN', false)) warn(G, 'Malware scanning is enabled', 'clamav, but REQUIRE_CLEAN_SCAN=false: files can be downloaded before the scan result is known');
  else pass(G, 'Malware scanning is enabled', `clamav at ${get('CLAMAV_HOST')}:${get('CLAMAV_PORT')}, clean scan required`);

  // --- notifications
  if (get('MAIL_DRIVER') === 'log') warn(G, 'Email delivery is configured', 'MAIL_DRIVER=log: verification, invitation and password-reset emails are only written to the log');
  else if (!isSet('SMTP_HOST')) fail(G, 'Email delivery is configured', 'MAIL_DRIVER=smtp but SMTP_HOST is not set');
  else if (/localhost|mailpit|mailhog|mailcatcher/i.test(get('SMTP_HOST'))) fail(G, 'Email delivery is configured', `SMTP_HOST "${get('SMTP_HOST')}" is a development mail sink`);
  else pass(G, 'Email delivery is configured', `smtp via ${get('SMTP_HOST')}:${get('SMTP_PORT') || 587}`);
  if (LOCAL_HOST.test(get('MAIL_FROM_ADDRESS').split('@')[1] ?? '')) warn(G, 'MAIL_FROM_ADDRESS is a real address', `"${get('MAIL_FROM_ADDRESS')}" will be rejected by mail servers`);
  if (get('SMS_DRIVER') === 'log') {
    if (bool('ONBOARDING_REQUIRE_PHONE_VERIFICATION', true)) warn(G, 'SMS delivery is configured', 'SMS_DRIVER=log while ONBOARDING_REQUIRE_PHONE_VERIFICATION=true: phone OTP codes cannot reach anyone');
    else warn(G, 'SMS delivery is configured', 'SMS_DRIVER=log: OTP login and SMS notifications are only written to the log');
  } else if (get('SMS_DRIVER') === 'twilio') expect(['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM'].every(isSet), G, 'SMS delivery is configured', 'twilio', 'TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM are required');
  else if (get('SMS_DRIVER') === 'http') expect(isSet('SMS_HTTP_URL') && isSet('SMS_HTTP_TOKEN') && get('SMS_HTTP_URL').startsWith('https://'), G, 'SMS delivery is configured', 'http gateway', 'SMS_HTTP_URL (https) and SMS_HTTP_TOKEN are required');
  if (get('WHATSAPP_DRIVER') === 'meta') expect(isSet('WHATSAPP_PHONE_NUMBER_ID') && isSet('WHATSAPP_ACCESS_TOKEN'), G, 'WhatsApp provider is configured', 'meta', 'WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN are required');
  if (get('PUSH_DRIVER') === 'fcm') expect(isSet('FCM_PROJECT_ID') && isSet('FCM_SERVICE_ACCOUNT_JSON'), G, 'Push provider is configured', 'fcm', 'FCM_PROJECT_ID and FCM_SERVICE_ACCOUNT_JSON are required');

  // --- payments / automation / OCR
  if (isSet('STRIPE_SECRET_KEY')) {
    if (!isSet('STRIPE_WEBHOOK_SECRET')) fail(G, 'Payment gateway webhook secret', 'STRIPE_SECRET_KEY is set without STRIPE_WEBHOOK_SECRET: webhooks could not be verified');
    else if (/^sk_test_|^rk_test_/.test(source.STRIPE_SECRET_KEY)) warn(G, 'Payment gateway uses live keys', 'STRIPE_SECRET_KEY is a TEST key');
    else pass(G, 'Platform payment gateway is configured', 'stripe');
  } else warn(G, 'Platform payment gateway is configured', 'no STRIPE_SECRET_KEY: subscription invoices can only be settled offline by a platform admin');
  if (isSet('N8N_WEBHOOK_BASE_URL')) expect(isSet('N8N_WEBHOOK_SECRET') && get('N8N_WEBHOOK_SECRET').length >= 24 && !PLACEHOLDER.test(get('N8N_WEBHOOK_SECRET')), G, 'n8n webhook secret', 'set', 'N8N_WEBHOOK_BASE_URL is set but N8N_WEBHOOK_SECRET is missing, short or a placeholder');
  if (get('OCR_PROVIDER') === 'external-http') expect(isSet('OCR_EXTERNAL_URL') && get('OCR_EXTERNAL_URL').startsWith('https://'), G, 'OCR provider is configured', 'external-http', 'OCR_EXTERNAL_URL (https) is required for OCR_PROVIDER=external-http');
  if (['debug', 'trace'].includes(get('LOG_LEVEL'))) warn(G, 'LOG_LEVEL', `"${get('LOG_LEVEL')}" may write personal data to the logs`);
  if (isSet('LOG_FORMAT') && !['json', 'text'].includes(get('LOG_FORMAT'))) fail(G, 'LOG_FORMAT is json or text', `"${get('LOG_FORMAT')}": the API refuses to start`);
  else if (get('LOG_FORMAT') === 'text') warn(G, 'LOG_FORMAT is json', 'text: readable on a console, but a log collector wants one JSON object per line (the default in production)');

  // --- numeric settings with a range in env.ts (outside the range the API refuses to start)
  const ranged = { PASSWORD_MIN_LENGTH: [10, 128, 'passwords that are set must have at least this many characters'], WORKER_HEARTBEAT_INTERVAL_SECONDS: [5, 300, 'seconds between two worker heartbeats; the platform console reports STALE after two intervals'] };
  for (const [k, [min, max, what]] of Object.entries(ranged)) {
    const raw = get(k);
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || n < min || n > max) fail(G, `${k} is between ${min} and ${max}`, `"${raw}": must be a whole number from ${min} to ${max} (${what}) - the API refuses to start`);
    else pass(G, `${k} is between ${min} and ${max}`, `${n}${isSet(k) ? '' : ' (default)'}`);
  }
  if (isSet('ALLOW_DB_RESET')) fail(G, 'ALLOW_DB_RESET is absent', 'ALLOW_DB_RESET must never be set in a production environment file');
  if (isSet('TYPEASE_MODULES')) fail(G, 'TYPEASE_MODULES is absent', 'TYPEASE_MODULES restricts which API modules are loaded (tests only): the API would start with missing features');
}

// =========================================================================== 2. database
function loadPg() {
  const require = createRequire(join(ROOT, 'database', 'package.json'));
  return require('pg');
}

async function checkDatabase() {
  const G = 'Database';
  if (flag('skip-db')) return skip(G, 'Database inspection', '--skip-db');
  const url = value('database-url') ?? (isSet('DATABASE_MIGRATION_URL') ? source.DATABASE_MIGRATION_URL : isSet('DATABASE_SYSTEM_URL') ? source.DATABASE_SYSTEM_URL : undefined);
  if (!url) return fail(G, 'Database inspection', 'no DATABASE_MIGRATION_URL / DATABASE_SYSTEM_URL / --database-url to connect with');
  if (value('database-url')) {
    try {
      const u = new URL(url);
      if (u.password) {
        secrets.add(u.password);
        secrets.add(decodeURIComponent(u.password));
      }
    } catch {
      /* reported below */
    }
  }
  let pg;
  try {
    pg = loadPg();
  } catch {
    return fail(G, 'Database inspection', 'the "pg" module could not be resolved from database/ - run pnpm install first');
  }
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 8000, statement_timeout: 30000, application_name: 'typease-readiness' });
  try {
    await client.connect();
  } catch (e) {
    return fail(G, 'Database is reachable', `${safeUrl(url).text}: ${e.code ?? ''} ${e.message}`);
  }
  const q = async (sql, params = []) => (await client.query(sql, params)).rows;
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    const [me] = await q(`SELECT current_user::text AS usr, current_database()::text AS db, current_setting('server_version') AS version, current_setting('server_version_num')::int AS num`);
    pass(G, 'Database is reachable', `${me.db} as ${me.usr}, PostgreSQL ${me.version}`);
    if (me.num < 160000) warn(G, 'PostgreSQL version', `${me.version}: the platform is developed and tested on PostgreSQL 16`);

    // --- migrations: files on disk vs schema_migrations
    const dir = resolve(value('migrations-dir') ?? join(ROOT, 'database', 'migrations'));
    let files = [];
    try {
      files = readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    } catch {
      fail(G, 'Migration files are available', `cannot read ${dir}`);
    }
    let applied = null;
    await client.query('SAVEPOINT m');
    try {
      applied = new Map((await q('SELECT name, checksum FROM schema_migrations')).map((r) => [r.name, r.checksum]));
    } catch (e) {
      await client.query('ROLLBACK TO SAVEPOINT m');
      fail(G, 'All migrations are applied', e.code === '42P01' ? 'table schema_migrations does not exist: the migration runner has never run on this database' : `cannot read schema_migrations as ${me.usr} (${e.code}): pass the owner connection with --database-url or DATABASE_MIGRATION_URL`);
    }
    const sqlByFile = new Map();
    if (applied && files.length) {
      const pending = [];
      const changed = [];
      for (const f of files) {
        const sql = readFileSync(join(dir, f), 'utf8');
        sqlByFile.set(f, sql);
        const sum = createHash('sha256').update(sql).digest('hex');
        if (!applied.has(f)) pending.push(f);
        else if (applied.get(f) !== sum) changed.push(f);
      }
      const unknown = [...applied.keys()].filter((n) => !files.includes(n));
      if (pending.length) fail(G, 'All migrations are applied', `pending: ${pending.join(', ')}`);
      else if (changed.length) fail(G, 'All migrations are applied', `checksum mismatch (file edited after it was applied): ${changed.join(', ')}`);
      else pass(G, 'All migrations are applied', `${files.length} file(s), checksums match`);
      if (unknown.length) warn(G, 'Database is not ahead of this checkout', `applied in the database but missing here: ${unknown.join(', ')} - you are checking with an older release than the one that migrated the database`);
    } else for (const f of files) sqlByFile.set(f, readFileSync(join(dir, f), 'utf8'));

    // --- roles
    const roles = new Map((await q(`SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication FROM pg_roles WHERE rolname IN ('typease_app','typease_system','typease_owner')`)).map((r) => [r.rolname, r]));
    const app = roles.get('typease_app');
    if (!app) fail(G, 'Role typease_app exists', 'missing: run the migration runner');
    else {
      const bad = ['rolsuper', 'rolbypassrls', 'rolcreaterole', 'rolcreatedb', 'rolreplication'].filter((a) => app[a]);
      expect(bad.length === 0, G, 'typease_app is not SUPERUSER / BYPASSRLS', 'no elevated attributes', `typease_app has ${bad.map((b) => b.slice(3).toUpperCase()).join(', ')}: row-level security would not protect tenants`);
      expect(app.rolcanlogin, G, 'typease_app can log in', 'LOGIN', 'NOLOGIN: the migration runner has not synchronised the password (DATABASE_URL missing when it ran?)');
    }
    const sys = roles.get('typease_system');
    if (!sys) fail(G, 'Role typease_system exists', 'missing: run the migration runner');
    else expect(!sys.rolsuper && !sys.rolcreaterole && !sys.rolcreatedb, G, 'typease_system is not SUPERUSER', sys.rolbypassrls ? 'BYPASSRLS (allowed: cross-tenant by design)' : 'no elevated attributes', 'typease_system must not be SUPERUSER / CREATEROLE / CREATEDB');
    const [inherit] = await q(`SELECT count(*)::int AS n FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member JOIN pg_roles g ON g.oid = m.roleid
                                WHERE r.rolname = 'typease_app' AND (g.rolsuper OR g.rolbypassrls OR g.rolname IN ('typease_system','typease_owner','pg_read_all_data','pg_write_all_data'))`);
    expect(inherit.n === 0, G, 'typease_app is not a member of a privileged role', 'no memberships', 'typease_app inherits from a role that bypasses row-level security');

    // --- ownership
    const owners = await q(`SELECT tableowner, count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' GROUP BY 1`);
    const total = owners.reduce((a, o) => a + o.n, 0);
    const runtimeOwned = owners.filter((o) => ['typease_app', 'typease_system'].includes(o.tableowner));
    expect(total > 0 && runtimeOwned.length === 0, G, 'Runtime roles own no tables', `${total} tables owned by ${owners.map((o) => o.tableowner).join(', ')}`, total === 0 ? 'no tables in schema public' : `${runtimeOwned.map((o) => `${o.tableowner} owns ${o.n}`).join('; ')}: a table owner is not subject to row-level security`);
    const superOwned = await q(`SELECT count(*)::int AS n FROM pg_tables t JOIN pg_roles r ON r.rolname = t.tableowner WHERE t.schemaname = 'public' AND r.rolsuper`);
    if (superOwned[0].n) warn(G, 'Tables are owned by a non-superuser', `${superOwned[0].n} table(s) are owned by a superuser: use the dedicated typease_owner role for migrations`);

    // --- row-level security on every tenant table
    const tenantTables = await q(`
      SELECT c.relname AS t, c.relrowsecurity AS rls,
             has_table_privilege('typease_app', c.oid, 'SELECT') OR has_table_privilege('typease_app', c.oid, 'INSERT')
               OR has_table_privilege('typease_app', c.oid, 'UPDATE') OR has_table_privilege('typease_app', c.oid, 'DELETE')
               OR has_any_column_privilege('typease_app', c.oid, 'SELECT') AS app_access,
             has_table_privilege('typease_app', c.oid, 'SELECT') AS app_select,
             EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname
                       AND ('typease_app' = ANY (p.roles) OR 'public' = ANY (p.roles))
                       AND (coalesce(p.qual, '') LIKE '%app_tenant_id()%' OR coalesce(p.with_check, '') LIKE '%app_tenant_id()%')) AS tenant_policy,
             EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname AND p.permissive = 'PERMISSIVE'
                       AND ('typease_app' = ANY (p.roles) OR 'public' = ANY (p.roles))
                       AND coalesce(p.qual, p.with_check, '') = 'true') AS open_policy
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
         AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenantId' AND NOT a.attisdropped)
       ORDER BY 1`);
    if (app) {
      const noRls = tenantTables.filter((t) => !t.rls).map((t) => t.t);
      const noPolicy = tenantTables.filter((t) => t.rls && t.app_access && !t.tenant_policy).map((t) => t.t);
      const open = tenantTables.filter((t) => t.open_policy).map((t) => t.t);
      const systemOnly = tenantTables.filter((t) => t.rls && !t.app_access).length;
      expect(tenantTables.length > 0 && noRls.length === 0, G, 'RLS is enabled on every table with a tenantId column', `${tenantTables.length} tenant tables`, tenantTables.length ? `row-level security is DISABLED on: ${noRls.join(', ')}` : 'no table with a tenantId column was found');
      expect(noPolicy.length === 0, G, 'Every tenant table has a tenant policy', `${tenantTables.length - systemOnly} with an app_tenant_id() policy, ${systemOnly} not accessible to typease_app at all`, `typease_app can reach these tables but no policy binds them to app_tenant_id(): ${noPolicy.join(', ')}`);
      expect(open.length === 0, G, 'No tenant table has an open policy for typease_app', 'none', `a "USING (true)" policy lets typease_app read every tenant's rows in: ${open.join(', ')}`);
    }
    const noRlsOther = await q(`SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                                 WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity AND c.relname <> 'schema_migrations'
                                   AND (has_table_privilege('typease_app', c.oid, 'SELECT') OR has_any_column_privilege('typease_app', c.oid, 'SELECT'))`);
    if (noRlsOther.length) warn(G, 'Tables without RLS that typease_app can read', noRlsOther.map((r) => r.t).join(', '));
    const [funcs] = await q(`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN ('app_tenant_id', 'app_user_id', 'assert_same_tenant')`);
    expect(funcs.n === 3, G, 'Tenant context functions exist', 'app_tenant_id, app_user_id, assert_same_tenant', `${funcs.n} of 3 found`);

    // --- triggers declared by the migration files must exist and be enabled
    const expected = new Map();
    for (const sql of sqlByFile.values()) {
      const noComments = sql.replace(/--[^\n]*/g, '');
      for (const m of noComments.matchAll(/(CREATE(?:\s+OR\s+REPLACE)?(?:\s+CONSTRAINT)?\s+TRIGGER|DROP\s+TRIGGER(?:\s+IF\s+EXISTS)?)\s+"?(\w+)"?\s[^;]*?\bON\s+"?(\w+)"?/gis)) {
        const key = `${m[3]}.${m[2]}`;
        if (/^DROP/i.test(m[1])) expected.delete(key);
        else expected.set(key, true);
      }
    }
    const present = new Map((await q(`SELECT c.relname || '.' || t.tgname AS key, t.tgenabled::text AS enabled FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT t.tgisinternal`)).map((r) => [r.key, r.enabled]));
    const critical = ['audit_logs.append_only', 'security_events.append_only', 'request_status_history.append_only', 'document_access_logs.append_only', 'consent_records.append_only', 'payment_allocations.append_only', 'liability_entries.append_only', 'invoices.invoice_immutability', 'invoice_items.items_frozen', 'quotation_items.items_frozen', 'payments.payment_immutability', 'refunds.amount_immutability', 'credit_notes.amount_immutability', 'payment_allocations.allocation_within_payment'];
    const missingCritical = critical.filter((k) => !present.has(k));
    const disabled = [...present].filter(([, e]) => e === 'D').map(([k]) => k);
    expect(missingCritical.length === 0, G, 'Append-only / immutability triggers exist', `${critical.length} audit and financial integrity triggers`, `missing: ${missingCritical.join(', ')}`);
    if (expected.size) {
      const missing = [...expected.keys()].filter((k) => !present.has(k));
      expect(missing.length === 0, G, 'Every trigger from the migration files exists', `${expected.size} triggers (incl. cross-tenant reference guards)`, `${missing.length} missing, e.g. ${missing.slice(0, 6).join(', ')}`);
    }
    expect(disabled.length === 0, G, 'No trigger is disabled', `${present.size} triggers enabled`, `disabled: ${disabled.slice(0, 8).join(', ')}`);

    // --- data checks (need a role that sees all rows: the owner or typease_system)
    await client.query('SAVEPOINT d');
    try {
      const demoDomains = `email ~* '(\\.test|\\.example|\\.invalid|\\.localhost|@example\\.(com|org|net)|@typease\\.localhost)$'`;
      const [demoUsers] = await q(`SELECT count(*)::int AS n, count(*) FILTER (WHERE "platformRole" IS NOT NULL)::int AS platform FROM users WHERE "deletedAt" IS NULL AND ${demoDomains}`);
      const [allUsers] = await q(`SELECT count(*)::int AS n FROM users`);
      const demoTenants = await q(`SELECT slug FROM tenants WHERE slug ~ '(^|-)(demo|test|fixture|sample)(-|$)' OR slug = ANY ($1) ORDER BY 1 LIMIT 20`, [['alnoor-demo', 'gulf-demo', 'smoke-test', 'mobile-fixture']]);
      expect(demoUsers.n === 0, G, 'No demo / test accounts exist', `${allUsers.n} user(s), none on a reserved test domain`, `${demoUsers.n} user(s) with a .test / .example / .localhost email address (${demoUsers.platform} of them platform staff) - demo logins use publicly documented passwords`);
      expect(demoTenants.length === 0, G, 'No demo tenants exist', 'none', `demo / test centres present: ${demoTenants.map((t) => t.slug).join(', ')}`);
      const [admins] = await q(`SELECT count(*) FILTER (WHERE "mfaEnabled")::int AS mfa, count(*)::int AS total FROM users WHERE "platformRole" = 'SUPER_ADMIN' AND status = 'ACTIVE' AND "deletedAt" IS NULL`);
      if (admins.mfa === 0) fail(G, 'A platform super admin with MFA exists', admins.total ? `${admins.total} active super admin(s), none has two-step verification enabled` : 'there is no active platform super admin: nobody can operate the platform console');
      else if (admins.mfa < admins.total) warn(G, 'A platform super admin with MFA exists', `${admins.mfa} of ${admins.total} active super admins have MFA: the others must enrol before they can work (MFA_ENFORCEMENT=required)`);
      else pass(G, 'A platform super admin with MFA exists', `${admins.mfa} active super admin(s), all with MFA`);
      const [outbox] = await q(`SELECT count(*) FILTER (WHERE status = 'FAILED')::int AS failed, count(*) FILTER (WHERE status = 'PENDING' AND "availableAt" < now() - interval '15 minutes')::int AS stuck FROM outbox_events`);
      if (outbox.failed || outbox.stuck) warn(G, 'Outbox is healthy', `${outbox.failed} FAILED and ${outbox.stuck} PENDING for more than 15 minutes: is the worker running?`);
      else pass(G, 'Outbox is healthy', 'no failed or stuck events');
    } catch (e) {
      await client.query('ROLLBACK TO SAVEPOINT d');
      fail(G, 'Data checks (demo accounts, platform admin)', `could not read as ${me.usr} (${e.code ?? e.message}): connect as the schema owner or typease_system`);
    }
    await client.query('ROLLBACK');
  } catch (e) {
    fail(G, 'Database inspection completed', `${e.code ?? ''} ${e.message}`);
  } finally {
    await client.end().catch(() => {});
  }

  // --- behavioural probe with the REAL application credentials
  if (!isSet('DATABASE_URL')) return;
  const appClient = new pg.Client({ connectionString: source.DATABASE_URL, connectionTimeoutMillis: 8000, statement_timeout: 30000, application_name: 'typease-readiness' });
  try {
    await appClient.connect();
  } catch (e) {
    return fail(G, 'DATABASE_URL credentials work', `${safeUrl(source.DATABASE_URL).text}: ${e.code ?? ''} ${e.message}`);
  }
  try {
    await appClient.query('BEGIN TRANSACTION READ ONLY');
    const [who] = (await appClient.query(`SELECT current_user::text AS usr, r.rolsuper, r.rolbypassrls, current_setting('TimeZone') AS tz FROM pg_roles r WHERE r.rolname = current_user`)).rows;
    expect(who.usr === 'typease_app' && !who.rolsuper && !who.rolbypassrls, G, 'DATABASE_URL credentials work', `logged in as ${who.usr}`, `logged in as ${who.usr} (superuser=${who.rolsuper}, bypassrls=${who.rolbypassrls})`);
    expect(/^(UTC|Etc\/UTC)$/i.test(who.tz), G, 'Application sessions run in UTC', who.tz, `session time zone is ${who.tz}: the migration runner sets ALTER ROLE ... SET timezone = 'UTC' - was it bypassed (pooler with a forced user)?`, 'WARN');
    const tables = (await appClient.query(`
      SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND has_table_privilege(current_user, c.oid, 'SELECT')
         AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenantId' AND NOT a.attisdropped) ORDER BY 1`)).rows.map((r) => r.t);
    const leaking = [];
    for (const t of tables) {
      const { rows } = await appClient.query(`SELECT EXISTS (SELECT 1 FROM "${t.replace(/"/g, '""')}" WHERE "tenantId" IS NOT NULL) AS visible`);
      if (rows[0].visible) leaking.push(t);
    }
    expect(leaking.length === 0, G, 'Without a tenant context typease_app sees no tenant rows', `probed ${tables.length} tables with the real application credentials: 0 rows visible`, `rows are visible WITHOUT a bound tenant in: ${leaking.join(', ')}`);
    await appClient.query('ROLLBACK');
  } catch (e) {
    fail(G, 'Isolation probe with DATABASE_URL', `${e.code ?? ''} ${e.message}`);
  } finally {
    await appClient.end().catch(() => {});
  }
}

// =========================================================================== 3. network probes
/** Minimal RESP exchange: no dependency on a Redis client library. */
function redisProbe(rawUrl) {
  return new Promise((resolveP) => {
    let u;
    try {
      u = new URL(rawUrl);
    } catch {
      return resolveP({ ok: false, error: 'invalid URL' });
    }
    const port = Number(u.port || 6379);
    const cmds = [];
    const enc = (...parts) => `*${parts.length}\r\n${parts.map((p) => `$${Buffer.byteLength(p)}\r\n${p}\r\n`).join('')}`;
    if (u.password) cmds.push(u.username ? enc('AUTH', decodeURIComponent(u.username), decodeURIComponent(u.password)) : enc('AUTH', decodeURIComponent(u.password)));
    cmds.push(enc('PING'), enc('INFO', 'server'), enc('INFO', 'memory'), enc('INFO', 'persistence'), enc('QUIT'));
    const socket = u.protocol === 'rediss:' ? tls.connect({ host: u.hostname, port, servername: u.hostname }) : net.connect({ host: u.hostname, port });
    let data = '';
    const done = (r) => {
      socket.destroy();
      resolveP(r);
    };
    socket.setTimeout(6000, () => done({ ok: false, error: 'timeout' }));
    socket.on('error', (e) => done({ ok: false, error: e.code ?? e.message }));
    socket.on(u.protocol === 'rediss:' ? 'secureConnect' : 'connect', () => socket.write(cmds.join('')));
    socket.on('data', (d) => (data += d.toString('utf8')));
    socket.on('close', () => {
      if (/-(NOAUTH|WRONGPASS|ERR invalid password|ERR AUTH)/.test(data)) return resolveP({ ok: false, error: 'authentication failed' });
      if (!data.includes('+PONG')) return resolveP({ ok: false, error: 'no PONG received' });
      const field = (k) => new RegExp(`^${k}:(.*)$`, 'm').exec(data)?.[1]?.trim();
      resolveP({ ok: true, version: field('redis_version'), policy: field('maxmemory_policy'), maxmemory: field('maxmemory'), aof: field('aof_enabled'), rdb: field('rdb_last_bgsave_status') });
    });
  });
}
function clamavProbe(host, port) {
  return new Promise((resolveP) => {
    const socket = net.connect({ host, port });
    let data = '';
    const done = (r) => {
      socket.destroy();
      resolveP(r);
    };
    socket.setTimeout(6000, () => done({ ok: false, error: 'timeout' }));
    socket.on('error', (e) => done({ ok: false, error: e.code ?? e.message }));
    socket.on('connect', () => socket.write('zPING\0'));
    socket.on('data', (d) => {
      data += d.toString('utf8');
      if (data.includes('PONG')) done({ ok: true });
    });
    socket.on('close', () => resolveP({ ok: data.includes('PONG'), error: 'no PONG received' }));
  });
}

async function checkNetwork() {
  const G = 'Services';
  if (flag('skip-network') || flag('skip-redis')) skip(G, 'Redis is reachable', flag('skip-redis') ? '--skip-redis' : '--skip-network');
  else {
    const r = await redisProbe(get('REDIS_URL'));
    if (!r.ok) fail(G, 'Redis is reachable', `${safeUrl(get('REDIS_URL')).text}: ${r.error}`);
    else {
      pass(G, 'Redis is reachable', `redis ${r.version ?? '?'} at ${safeUrl(get('REDIS_URL')).text}`);
      if (get('QUEUE_DRIVER') !== 'inline' && r.policy) expect(r.policy === 'noeviction', G, 'Redis maxmemory-policy is noeviction', 'noeviction', `"${r.policy}": BullMQ needs noeviction, otherwise queued jobs can be evicted silently under memory pressure`, 'WARN');
      if (get('QUEUE_DRIVER') !== 'inline' && r.aof !== undefined && r.aof !== '1') warn(G, 'Redis persistence (AOF) is enabled', 'aof_enabled=0: jobs that are queued or delayed in Redis are lost if Redis restarts');
    }
  }
  if (get('MALWARE_SCANNER') === 'clamav') {
    if (flag('skip-network')) skip(G, 'ClamAV answers PING', '--skip-network');
    else {
      const c = await clamavProbe(get('CLAMAV_HOST'), Number(get('CLAMAV_PORT')));
      expect(c.ok, G, 'ClamAV answers PING', `${get('CLAMAV_HOST')}:${get('CLAMAV_PORT')}`, `${get('CLAMAV_HOST')}:${get('CLAMAV_PORT')}: ${c.error} - uploads would stay in PENDING_SCAN`);
    }
  }
}

// =========================================================================== 4. backups
function checkBackups() {
  const G = 'Backups';
  const marker = value('backup-marker') ?? (isSet('BACKUP_MARKER_FILE') ? source.BACKUP_MARKER_FILE : process.env.BACKUP_MARKER_FILE);
  const maxAge = Number(value('backup-max-age-hours') ?? source.BACKUP_MAX_AGE_HOURS ?? 26);
  if (marker) {
    if (!existsSync(marker)) return fail(G, 'A recent database backup exists', `marker file ${marker} does not exist: scripts/db-backup.sh has never completed on this host`);
    let info = {};
    try {
      info = JSON.parse(readFileSync(marker, 'utf8'));
    } catch {
      return fail(G, 'A recent database backup exists', `marker file ${marker} is not valid JSON`);
    }
    const at = Date.parse(info.completedAt ?? '') || statSync(marker).mtimeMs;
    const ageH = (Date.now() - at) / 3600_000;
    expect(ageH <= maxAge, G, 'A recent database backup exists', `last successful backup ${ageH.toFixed(1)} h ago (${info.file ?? 'file name not recorded'}, ${info.bytes ?? '?'} bytes)`, `last successful backup is ${ageH.toFixed(1)} h old (limit ${maxAge} h)`);
    expect(['age', 'openssl-aes-256-cbc'].includes(info.encryption), G, 'Backups are encrypted', String(info.encryption), `the marker reports encryption "${info.encryption ?? 'none'}"`);
    if (info.offsite !== true) warn(G, 'Backups are copied off the host', 'the last backup was not uploaded to object storage (BACKUP_S3_URI not set): a disk failure would destroy both the database and its backups');
    else pass(G, 'Backups are copied off the host', String(info.offsiteTarget ?? 'uploaded'));
    const drill = info.lastRestoreDrill ?? (existsSync(join(dirname(marker), 'last-restore-drill.json')) ? JSON.parse(readFileSync(join(dirname(marker), 'last-restore-drill.json'), 'utf8')).completedAt : null);
    const drillAge = drill ? (Date.now() - Date.parse(drill)) / 86400_000 : Infinity;
    if (!drill) warn(G, 'A restore drill has been performed', 'no last-restore-drill.json next to the marker: a backup that was never restored is not a backup');
    else expect(drillAge <= 100, G, 'A restore drill has been performed', `${drillAge.toFixed(0)} day(s) ago`, `last drill ${drillAge.toFixed(0)} days ago (quarterly drill is overdue)`, 'WARN');
    return;
  }
  const managed = (isSet('BACKUP_PROVIDER_MANAGED') ? source.BACKUP_PROVIDER_MANAGED : process.env.BACKUP_PROVIDER_MANAGED) === 'true';
  if (managed) return warn(G, 'A recent database backup exists', 'BACKUP_PROVIDER_MANAGED=true: you DECLARE that the database provider takes backups / PITR. This script cannot verify that - attach the provider evidence and a restore drill record to the go-live checklist');
  fail(G, 'A recent database backup exists', 'no evidence: pass --backup-marker <file written by scripts/db-backup.sh> (or BACKUP_MARKER_FILE), or set BACKUP_PROVIDER_MANAGED=true for provider-managed backups');
}

// =========================================================================== 5. self check
/** Warns when env.ts gained a variable, changed a default or changed its secret rules without this script (and the examples) following. */
function checkSelf() {
  const file = join(ROOT, 'services', 'api', 'src', 'config', 'env.ts');
  if (!existsSync(file)) return; // running from an image without the sources
  const src = readFileSync(file, 'utf8');
  const drift = [];
  for (const [k, v] of Object.entries(DEFAULTS)) {
    const m = new RegExp(`^\\s*${k}:\\s*(.+)$`, 'm').exec(src);
    if (!m) drift.push(`${k} (no longer in env.ts)`);
    else if (!m[1].includes(`'${v}'`) && !m[1].includes(`(${v})`)) drift.push(`${k} (default changed)`);
  }
  if (drift.length) warn('Self check', 'Script defaults match services/api/src/config/env.ts', `update DEFAULTS in scripts/production-readiness.mjs: ${drift.join(', ')}`);

  // The published development secrets: the same list in both places.
  const list = /export const KNOWN_PLACEHOLDER_SECRETS = \[([\s\S]*?)\];/.exec(src);
  const inEnvTs = list ? [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
  const missing = inEnvTs.filter((v) => !KNOWN_PLACEHOLDER_SECRETS.includes(v)).length + KNOWN_PLACEHOLDER_SECRETS.filter((v) => !inEnvTs.includes(v)).length;
  if (!list || missing) warn('Self check', 'Known development secrets match env.ts', `KNOWN_PLACEHOLDER_SECRETS differs from services/api/src/config/env.ts in ${missing || 'an unknown number of'} value(s): update the list in scripts/production-readiness.mjs`);

  // Every variable of env.ts is documented in .env.example (set, or commented out as "# NAME=").
  const example = join(ROOT, '.env.example');
  const schema = /const schema = z\.object\(\{([\s\S]*?)\n\}\);/.exec(src);
  if (schema && existsSync(example)) {
    const declared = [...schema[1].matchAll(/^ {2}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]);
    const documented = new Set([...readFileSync(example, 'utf8').matchAll(/^(?:# ?)?([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
    const undocumented = declared.filter((k) => !documented.has(k));
    if (undocumented.length) warn('Self check', '.env.example documents every variable of env.ts', `missing from .env.example: ${undocumented.join(', ')}`);
  }
}

// =========================================================================== run + report
function render() {
  const color = !flag('no-color') && process.stdout.isTTY && !process.env.NO_COLOR;
  const paint = { PASS: 32, WARN: 33, FAIL: 31, SKIP: 90 };
  const tag = (s) => (color ? `\x1b[${paint[s]}m${s}\x1b[0m` : s);
  const counts = { PASS: 0, WARN: 0, FAIL: 0, SKIP: 0 };
  results.forEach((r) => counts[r.status]++);
  if (flag('json')) {
    console.log(JSON.stringify({ target: sourceLabel, checkedAt: new Date().toISOString(), counts, results }, null, 2));
    return counts;
  }
  const w = Math.min(58, Math.max(...results.map((r) => r.check.length)));
  console.log(`TypEase production readiness - ${new Date().toISOString()}`);
  console.log(`Target: ${scrub(sourceLabel)}\n`);
  let group = '';
  for (const r of results) {
    if (r.group !== group) {
      group = r.group;
      console.log(`${group}`);
    }
    const lines = wrap(r.detail, Math.max(30, (process.stdout.columns || Number(process.env.COLUMNS) || 140) - w - 10));
    console.log(`  ${tag(r.status)}  ${r.check.padEnd(w)}  ${lines[0] ?? ''}`);
    for (const l of lines.slice(1)) console.log(`        ${' '.repeat(w)}  ${l}`);
  }
  const verdict = counts.FAIL ? 'NOT READY FOR PRODUCTION' : counts.WARN ? 'READY WITH WARNINGS - review every WARN before go-live' : 'READY';
  console.log(`\nSummary: ${counts.PASS} PASS, ${counts.WARN} WARN, ${counts.FAIL} FAIL, ${counts.SKIP} SKIP  ->  ${verdict}`);
  return counts;
}
function wrap(text, width) {
  const out = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

try {
  checkEnvironment();
  await checkDatabase();
  await checkNetwork();
  checkBackups();
  checkSelf();
} catch (e) {
  console.error(scrub(`The readiness script failed unexpectedly: ${e?.stack ?? e}`));
  process.exit(2);
}
const counts = render();
process.exit(counts.FAIL ? 1 : flag('strict') && counts.WARN ? 1 : 0);
