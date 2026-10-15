import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENV_VARIABLES, KNOWN_PLACEHOLDER_SECRETS, loadEnv, parseKeyring, weakKeyReasons, weakSecretReasons } from '../src/config/env';

/**
 * Operator tooling must say what the API actually reads. This file fails when
 *   - a variable validated by src/config/env.ts is missing from `.env.example` or from the production
 *     template, or one of those files documents (as an API setting) a variable env.ts does not know;
 *   - `scripts/production-readiness.mjs` judges a secret, a key or a keyring differently from env.ts,
 *     or carries other defaults / another list of published development secrets.
 * No database is needed: it reads files and runs the script in its "export the rules" mode.
 */
const ROOT = join(__dirname, '..', '..', '..');
const read = (...path: string[]) => readFileSync(join(ROOT, ...path), 'utf8');

/** Variables of an env file: assigned (`NAME=value`) and documented-but-unset (`# NAME=`). */
function variablesOf(text: string): { assigned: Record<string, string>; commented: string[]; all: string[] } {
  const assigned: Record<string, string> = {};
  const commented: string[] = [];
  for (const line of text.split('\n')) {
    const set = /^([A-Z][A-Z0-9_]+)=(.*)$/.exec(line);
    const unset = /^# ?([A-Z][A-Z0-9_]+)=/.exec(line);
    if (set) assigned[set[1]] = set[2];
    else if (unset) commented.push(unset[1]);
  }
  return { assigned, commented, all: [...new Set([...Object.keys(assigned), ...commented])] };
}

describe('environment reference files follow src/config/env.ts', () => {
  const declared = ENV_VARIABLES as string[];
  const OTHER_PROGRAMS = '# NOT part of env.ts - read by other programs';
  /** Read by the migration job and the readiness check, never by the API: documented next to the two URLs it belongs with. */
  const NOT_FOR_THE_API = ['DATABASE_MIGRATION_URL'];

  it('env.ts declares what it is expected to declare (a sanity check of this test itself)', () => {
    expect(declared.length).toBeGreaterThan(90);
    for (const key of ['DATABASE_URL', 'DATA_ENCRYPTION_KEY_ID', 'DATA_ENCRYPTION_OLD_KEYS', 'PASSWORD_MIN_LENGTH', 'LOG_FORMAT', 'WORKER_HEARTBEAT_INTERVAL_SECONDS', 'S3_PUBLIC_ASSETS_BASE_URL']) expect(declared).toContain(key);
    expect(new Set(declared).size).toBe(declared.length);
  });

  it('.env.example documents every variable of env.ts, and nothing else as an API setting', () => {
    const text = read('.env.example');
    expect(text).toContain(OTHER_PROGRAMS);
    const [apiPart, otherPart] = text.split(OTHER_PROGRAMS);
    const api = variablesOf(apiPart);
    const other = variablesOf(otherPart);
    expect(declared.filter((k) => !api.all.includes(k))).toEqual([]); // declared in env.ts, missing from .env.example
    expect(api.all.filter((k) => !declared.includes(k) && !NOT_FOR_THE_API.includes(k))).toEqual([]); // documented, unknown to env.ts
    expect(other.all.filter((k) => declared.includes(k))).toEqual([]); // filed under "other programs" but read by the API
    // A variable is either set or shown commented out, not both.
    expect(Object.keys(api.assigned).filter((k) => api.commented.includes(k))).toEqual([]);
  });

  it('the development values of .env.example are a configuration the API starts with', () => {
    const { assigned } = variablesOf(read('.env.example').split(OTHER_PROGRAMS)[0]);
    const env = loadEnv(assigned as NodeJS.ProcessEnv);
    expect(env).toMatchObject({ NODE_ENV: 'development', DATA_ENCRYPTION_KEY_ID: 'k1', PASSWORD_MIN_LENGTH: 10, WORKER_HEARTBEAT_INTERVAL_SECONDS: 15, LOG_FORMAT: 'text', QUEUE_DRIVER: 'inline' });
    // ... and one that production refuses, value by value (they are the published development secrets).
    expect(() => loadEnv({ ...assigned, NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(/Unsafe production configuration/);
    for (const key of ['JWT_ACCESS_SECRET', 'HMAC_KEY', 'DATA_ENCRYPTION_KEY', 'INTERNAL_API_TOKEN']) expect([key, KNOWN_PLACEHOLDER_SECRETS.includes(assigned[key])]).toEqual([key, true]);
  });

  it('the production template lists every variable of env.ts and is accepted once its placeholders are replaced by generated values', () => {
    const template = variablesOf(read('infrastructure', 'deployment', 'env', 'typease.env.example'));
    expect(declared.filter((k) => !template.all.includes(k))).toEqual([]);
    expect(template.all.filter((k) => !declared.includes(k))).toEqual([]);
    expect(template.assigned).toMatchObject({ NODE_ENV: 'production', LOG_FORMAT: 'json', DATA_ENCRYPTION_KEY_ID: 'k1', QUEUE_DRIVER: 'bullmq', COOKIE_SECURE: 'true', MFA_ENFORCEMENT: 'required', PAYMENT_SANDBOX_ENABLED: 'false', EXPOSE_DEV_TOKENS: 'false' });

    // As it is in the repository (placeholders in angle brackets) the API must refuse it.
    expect(() => loadEnv(template.assigned as NodeJS.ProcessEnv)).toThrow();
    // Filled in the way scripts/generate-secrets.sh does it: accepted, with the production checks on.
    const filled = Object.fromEntries(
      Object.entries(template.assigned).map(([key, value]) => {
        if (/<openssl rand -base64 (\d+)>/.test(value)) return [key, randomBytes(Number(/(\d+)>/.exec(value)![1])).toString('base64')];
        return [key, value.replace(/<[^>]+>/g, () => randomBytes(12).toString('hex'))];
      }),
    );
    const env = loadEnv(filled as NodeJS.ProcessEnv);
    expect(env).toMatchObject({ NODE_ENV: 'production', LOG_FORMAT: 'json', STORAGE_DRIVER: 's3', WORKER_HEARTBEAT_INTERVAL_SECONDS: 15, PASSWORD_MIN_LENGTH: 10 });
    // One generated value used for two purposes is refused.
    expect(() => loadEnv({ ...filled, HMAC_KEY: filled.JWT_ACCESS_SECRET } as NodeJS.ProcessEnv)).toThrow(/must be different values/);
  });
});

describe('scripts/production-readiness.mjs applies the rules of env.ts', () => {
  const key = () => randomBytes(32).toString('base64');
  const typedKey = Buffer.from('this-is-a-typed-32-byte-password').toString('base64');
  const current = key();
  const old = key();
  const samples = {
    secrets: [
      ...KNOWN_PLACEHOLDER_SECRETS,
      randomBytes(48).toString('base64'),
      randomBytes(32).toString('hex'),
      randomBytes(8).toString('hex'),
      'correct-horse-battery-staple-correct-horse',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'change-me-change-me-change-me-change-me-please',
      'Zx9!Zx9!Zx9!Zx9!Zx9!Zx9!Zx9!Zx9!Zx9!Zx9!',
      'my-secret-key-for-production-use-2026-v1',
    ],
    keys: [...KNOWN_PLACEHOLDER_SECRETS, key(), key(), typedKey, Buffer.alloc(32, 7).toString('base64'), Buffer.alloc(31, 9).toString('base64'), 'not base64 at all!', randomBytes(64).toString('base64'), Buffer.from(Array.from({ length: 32 }, (_, i) => i % 6)).toString('base64')],
    keyrings: [
      [current, 'k2', ''],
      [current, 'k2', `k1:${old}`],
      [current, 'k2', `k1:${old},k0:${key()}`],
      [current, 'k2', `k2:${old}`], // the current id with another key
      [current, 'k2', `k2:${current}`], // the current pair repeated: harmless
      [current, 'k2', `k1:${old},k1:${key()}`], // one id, two keys
      [current, 'k2', `k1:${old},k1:${old}`],
      [current, 'k2', 'k1'],
      [current, 'k2', `bad id:${old}`],
      [current, 'k2', 'k1:c2hvcnQ='],
      ['c2hvcnQ=', 'k1', `k0:${old}`],
    ] as Array<[string, string, string]>,
  };
  let script: { known: string[]; defaults: Record<string, string>; secrets: string[][]; keys: string[][]; keyrings: string[][] };

  beforeAll(() => {
    const out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'production-readiness.mjs')], {
      env: { PATH: process.env.PATH ?? '', TYPEASE_READINESS_EXPORT_RULES: '1', TYPEASE_READINESS_RULE_SAMPLES: JSON.stringify(samples) },
      encoding: 'utf8',
    });
    script = JSON.parse(out);
  });

  it('knows the same published development secrets', () => {
    expect(script.known).toEqual(KNOWN_PLACEHOLDER_SECRETS);
  });

  it('judges every sample secret and key exactly like the API would at start-up', () => {
    const fromApi = { secrets: samples.secrets.map((v) => weakSecretReasons('X', v)), keys: samples.keys.map((v) => weakKeyReasons('X', v)) };
    expect(script.secrets).toEqual(fromApi.secrets);
    expect(script.keys).toEqual(fromApi.keys);
    // The samples really cover both verdicts.
    expect(fromApi.secrets.filter((r) => r.length === 0).length).toBeGreaterThanOrEqual(2);
    expect(fromApi.secrets.filter((r) => r.length > 0).length).toBeGreaterThanOrEqual(KNOWN_PLACEHOLDER_SECRETS.length + 5);
    expect(fromApi.keys.filter((r) => r.length === 0).length).toBeGreaterThanOrEqual(2);
    expect(fromApi.keys.filter((r) => r.length > 0).length).toBeGreaterThanOrEqual(KNOWN_PLACEHOLDER_SECRETS.length + 5);
    // Nothing a verdict says contains the value it judged.
    for (const [i, value] of samples.keys.entries()) expect(script.keys[i].join(' ')).not.toContain(value);
  });

  it('reads a keyring like the API does, problem for problem', () => {
    const fromApi = samples.keyrings.map(([k, id, oldKeys]) => {
      try {
        parseKeyring({ DATA_ENCRYPTION_KEY: k, DATA_ENCRYPTION_KEY_ID: id, DATA_ENCRYPTION_OLD_KEYS: oldKeys });
        return [];
      } catch (e: any) {
        return String(e.message).split('\n').slice(1).map((line) => line.replace(/^\s*-\s*/, ''));
      }
    });
    expect(script.keyrings).toEqual(fromApi);
    expect(fromApi.map((p) => p.length > 0)).toEqual([false, false, false, true, false, true, false, true, true, true, true]);
  });

  it('carries the defaults of env.ts', () => {
    const minimal = { DATABASE_URL: 'postgresql://a:b@c/d', DATABASE_SYSTEM_URL: 'postgresql://a:b@c/d', JWT_ACCESS_SECRET: 'x'.repeat(32), HMAC_KEY: 'y'.repeat(32), DATA_ENCRYPTION_KEY: current };
    const defaults = loadEnv(minimal as NodeJS.ProcessEnv) as unknown as Record<string, unknown>;
    expect(Object.keys(script.defaults).length).toBeGreaterThan(25);
    for (const [name, value] of Object.entries(script.defaults)) expect([name, String(defaults[name])]).toEqual([name, value]);
  });

  it('checks the variables that were added to env.ts: key id, old keys, password length, heartbeat interval, log format', () => {
    const source = read('scripts', 'production-readiness.mjs');
    for (const name of ['DATA_ENCRYPTION_KEY_ID', 'DATA_ENCRYPTION_OLD_KEYS', 'PASSWORD_MIN_LENGTH', 'WORKER_HEARTBEAT_INTERVAL_SECONDS', 'LOG_FORMAT', 'INTERNAL_API_TOKEN']) expect([name, source.includes(name)]).toEqual([name, true]);
    // Run for real against a file: a weak value is a FAIL with the name of the variable, never with its value.
    const dir = process.env.TEST_STORAGE_DIR ?? '/tmp';
    const file = join(dir, `readiness-${randomBytes(4).toString('hex')}.env`);
    const weakSecret = 'my-secret-key-for-production-use-2026-v1';
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      file,
      [
        'NODE_ENV=production', `JWT_ACCESS_SECRET=${weakSecret}`, `HMAC_KEY=${randomBytes(48).toString('base64')}`, `DATA_ENCRYPTION_KEY=${typedKey}`, 'DATA_ENCRYPTION_KEY_ID=k 2',
        `DATA_ENCRYPTION_OLD_KEYS=k1:${old},k1:${key()}`, 'INTERNAL_API_TOKEN=short-token-1234567', 'PASSWORD_MIN_LENGTH=8', 'WORKER_HEARTBEAT_INTERVAL_SECONDS=2', 'LOG_FORMAT=xml',
      ].join('\n'),
    );
    let output = '';
    try {
      output = execFileSync(process.execPath, [join(ROOT, 'scripts', 'production-readiness.mjs'), '--env-file', file, '--skip-db', '--skip-redis', '--skip-network', '--json'], { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8' });
    } catch (e: any) {
      output = e.stdout; // exit code 1: there are FAILs, which is the point
    } finally {
      rmSync(file, { force: true });
    }
    const results = JSON.parse(output).results as Array<{ status: string; check: string; detail: string }>;
    const failed = (check: string) => results.find((r) => r.check === check && r.status === 'FAIL');
    expect(failed('JWT_ACCESS_SECRET is a generated secret')?.detail).toMatch(/placeholder or a typed phrase/);
    expect(results.find((r) => r.check === 'HMAC_KEY is a generated secret')?.status).toBe('PASS');
    expect(failed('DATA_ENCRYPTION_KEY is 32 random bytes')?.detail).toMatch(/text somebody typed/);
    expect(failed('DATA_ENCRYPTION_KEY_ID is valid')).toBeDefined();
    expect(failed('Encryption keyring is readable')?.detail).toMatch(/listed twice with different keys/);
    expect(failed('INTERNAL_API_TOKEN is a generated secret')?.detail).toMatch(/at least 24/);
    expect(failed('PASSWORD_MIN_LENGTH is between 10 and 128')).toBeDefined();
    expect(failed('WORKER_HEARTBEAT_INTERVAL_SECONDS is between 5 and 300')).toBeDefined();
    expect(failed('LOG_FORMAT is json or text')).toBeDefined();
    for (const secret of [weakSecret, typedKey, old, 'short-token-1234567']) expect(output).not.toContain(secret);
  });
});
