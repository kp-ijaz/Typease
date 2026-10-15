import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { authenticator } from 'otplib';
import { ENCRYPTION_USES, LOCAL_FILES_STORE, reencryptDatabase, reencryptInside, STORES } from '../src/cli/reencrypt-stores';
import { currentKeyId, decryptBuffer, decryptJson, decryptText, encryptBuffer, encryptJson, encryptText, envelopeKeyId, needsReencryption, reencryptText, UnknownEncryptionKey } from '../src/common/crypto';
import { assertPasswordPolicy, passwordPolicy, passwordProblems } from '../src/common/password-policy';
import { entropyBits, env, KNOWN_PLACEHOLDER_SECRETS, loadEnv, parseKeyring, weakKeyReasons, weakSecretReasons } from '../src/config/env';
import { uniqueEmiratesId, uniquePassport } from '../src/modules/customers/fixtures';
import { fetchBytes, pdfBytes } from '../src/modules/documents/fixtures';
import { makeIntegration } from '../src/modules/notifications/fixtures';
import { requestAccess } from '../src/modules/platform/fixtures';
import { StorageService } from '../src/modules/storage/storage.service';
import { PASSWORD, TenantFixture, TestApp, uniq } from './helpers';

const b64 = (n: number) => randomBytes(n).toString('base64');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const KEY_VARS = ['DATA_ENCRYPTION_KEY', 'DATA_ENCRYPTION_KEY_ID', 'DATA_ENCRYPTION_OLD_KEYS'] as const;

/** Runs `fn` with another keyring configured, then puts the original configuration back. */
async function withKeys<T>(keys: { key: string; id: string; old?: string }, fn: () => Promise<T> | T): Promise<T> {
  const e = env() as any;
  const before = Object.fromEntries(KEY_VARS.map((k) => [k, e[k]]));
  Object.assign(e, { DATA_ENCRYPTION_KEY: keys.key, DATA_ENCRYPTION_KEY_ID: keys.id, DATA_ENCRYPTION_OLD_KEYS: keys.old ?? '' });
  try {
    return await fn();
  } finally {
    Object.assign(e, before);
  }
}

describe('encryption keyring (DATA_ENCRYPTION_KEY, _KEY_ID, _OLD_KEYS)', () => {
  const first = { key: b64(32), id: 'k1' };
  const second = { key: b64(32), id: '2026-10' };

  it('stamps the id of the current key on everything it encrypts and picks the key by that id', async () => {
    const [text, json, file] = await withKeys(first, () => [encryptText('784-1990-1234567-1'), encryptJson({ secretKey: 'sk_live_x' }), encryptBuffer(Buffer.from('%PDF-1.4 passport'))] as const);
    expect(envelopeKeyId(text)).toBe('k1');
    expect(text.split('.')).toHaveLength(4);
    expect(file.meta.keyId).toBe('k1');

    // After a rotation: the old key only decrypts, the new key encrypts.
    await withKeys({ ...second, old: `k1:${first.key}` }, () => {
      expect(currentKeyId()).toBe('2026-10');
      expect(decryptText(text)).toBe('784-1990-1234567-1');
      expect(decryptJson(json)).toEqual({ secretKey: 'sk_live_x' });
      expect(decryptBuffer(file.data, file.meta).toString()).toBe('%PDF-1.4 passport');
      const fresh = encryptText('784-1990-1234567-1');
      expect(envelopeKeyId(fresh)).toBe('2026-10');
      expect(encryptBuffer(Buffer.from('x')).meta.keyId).toBe('2026-10');
      expect(needsReencryption(text)).toBe(true);
      expect(needsReencryption(fresh)).toBe(false);
      // Re-encryption moves a value to the current key and is idempotent.
      const moved = reencryptText(text);
      expect(envelopeKeyId(moved)).toBe('2026-10');
      expect(decryptText(moved)).toBe('784-1990-1234567-1');
      expect(reencryptText(moved)).toBe(moved);
    });
  });

  it('fails closed with a clear message when the key of a ciphertext is not configured', async () => {
    const text = await withKeys(first, () => encryptText('P1234567'));
    const file = await withKeys(first, () => encryptBuffer(Buffer.from('file')));
    await withKeys(second, () => {
      expect(() => decryptText(text)).toThrow(UnknownEncryptionKey);
      expect(() => decryptText(text)).toThrow(/key "k1", which is not configured.*DATA_ENCRYPTION_OLD_KEYS/);
      expect(() => decryptBuffer(file.data, file.meta)).toThrow(UnknownEncryptionKey);
      expect(() => reencryptText(text)).toThrow(UnknownEncryptionKey);
    });
    // The right id with the wrong key is not accepted either (GCM authentication), and nothing is guessed.
    await withKeys({ key: second.key, id: 'k1' }, () => {
      expect(() => decryptText(text)).toThrow();
      expect(() => decryptBuffer(file.data, file.meta)).toThrow();
    });
    await withKeys(first, () => {
      expect(() => decryptText('not-an-envelope')).toThrow();
      expect(() => decryptText(`k1.${text.split('.').slice(1, 3).join('.')}`)).toThrow(/Malformed/);
    });
  });

  it('validates the keyring configuration without ever printing key material', () => {
    const ring = parseKeyring({ DATA_ENCRYPTION_KEY: second.key, DATA_ENCRYPTION_KEY_ID: 'k2', DATA_ENCRYPTION_OLD_KEYS: ` k1:${first.key} , old_2024:${b64(32)} ` });
    expect(ring.current.id).toBe('k2');
    expect([...ring.all.keys()].sort()).toEqual(['k1', 'k2', 'old_2024']);
    // The default id is k1, so an installation that never set the variable keeps reading its data.
    expect(loadEnv({ ...process.env, DATA_ENCRYPTION_KEY_ID: undefined } as any).DATA_ENCRYPTION_KEY_ID).toBe('k1');

    const bad = (over: Record<string, string>) => {
      try {
        parseKeyring({ DATA_ENCRYPTION_KEY: second.key, DATA_ENCRYPTION_KEY_ID: 'k2', DATA_ENCRYPTION_OLD_KEYS: '', ...over });
      } catch (e: any) {
        return String(e.message);
      }
      return 'accepted';
    };
    expect(bad({ DATA_ENCRYPTION_KEY: b64(16) })).toMatch(/DATA_ENCRYPTION_KEY must be 32 bytes/);
    expect(bad({ DATA_ENCRYPTION_KEY: 'not base64 at all !!!!!!!!!!!!!!!!!!!!!!!!!!!' })).toMatch(/32 bytes/);
    expect(bad({ DATA_ENCRYPTION_OLD_KEYS: first.key })).toMatch(/entry 1: expected "id:base64key"/);
    expect(bad({ DATA_ENCRYPTION_OLD_KEYS: `k 1:${first.key}` })).toMatch(/entry 1/);
    expect(bad({ DATA_ENCRYPTION_OLD_KEYS: `k1:${b64(8)}` })).toMatch(/entry 1 \("k1"\): the key must be 32 bytes/);
    expect(bad({ DATA_ENCRYPTION_OLD_KEYS: `k1:${first.key},k1:${b64(32)}` })).toMatch(/listed twice with different keys/);
    // Re-using the id of the current key for a different key would make old data unreadable without notice.
    expect(bad({ DATA_ENCRYPTION_OLD_KEYS: `k2:${first.key}` })).toMatch(/id of the current key.*Give the new key a new id/);
    expect(bad({ DATA_ENCRYPTION_OLD_KEYS: `k2:${second.key}` })).toBe('accepted');
    for (const message of [bad({ DATA_ENCRYPTION_OLD_KEYS: `k1:${b64(8)}` }), bad({ DATA_ENCRYPTION_OLD_KEYS: `k2:${first.key}` })]) {
      expect(message).not.toContain(first.key);
      expect(message).not.toContain(second.key);
    }
    expect(() => loadEnv({ ...process.env, DATA_ENCRYPTION_KEY_ID: 'has.dot' } as any)).toThrow(/DATA_ENCRYPTION_KEY_ID/);
    expect(() => loadEnv({ ...process.env, DATA_ENCRYPTION_OLD_KEYS: 'garbage' } as any)).toThrow(/Invalid encryption key configuration/);
  });

  it('finds envelopes inside JSON and leaves everything else alone', async () => {
    const old = await withKeys(first, () => ({ a: encryptText('one'), b: encryptText('two') }));
    await withKeys({ ...second, old: `k1:${first.key}` }, () => {
      const fresh = encryptText('three');
      const value = { fields: [{ key: 'passportNumber', value: null, valueEnc: old.a }, { key: 'fullName', value: 'Mariam', valueEnc: 'not.an.envelope' }, { key: 'x', valueEnc: fresh }], note: old.b, nested: { deep: [{ valueEnc: old.b }] } };
      const tally = { values: 0, stale: 0, byKeyId: {} as Record<string, number> };
      const out = reencryptInside(value, ['valueEnc'], currentKeyId(), tally, false) as typeof value;
      expect(tally).toEqual({ values: 3, stale: 2, byKeyId: { k1: 2, '2026-10': 1 } });
      expect(decryptText(out.fields[0].valueEnc!)).toBe('one');
      expect(envelopeKeyId(out.fields[0].valueEnc!)).toBe('2026-10');
      expect(out.fields[1]).toEqual(value.fields[1]);
      expect(out.fields[2].valueEnc).toBe(fresh);
      expect(out.note).toBe(old.b); // not under a listed key: not ours to touch
      expect(decryptText(out.nested.deep[0].valueEnc)).toBe('two');
      const dry = { values: 0, stale: 0, byKeyId: {} as Record<string, number> };
      expect(reencryptInside(value, ['valueEnc'], currentKeyId(), dry, true)).toEqual(value);
      expect(dry.stale).toBe(2);
    });
  });
});

describe('every use of the encryption helpers is covered by the re-encryption list', () => {
  const SRC = join(__dirname, '..', 'src');
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) out.push(full);
    }
    return out;
  };
  const rel = (f: string) => relative(SRC, f).replace(/\\/g, '/');
  const encrypting = walk(SRC)
    .filter((f) => rel(f) !== 'common/crypto.ts' && /\b(encryptText|encryptJson|encryptBuffer)\s*\(/.test(readFileSync(f, 'utf8')))
    .map(rel)
    .sort();

  it('a file that encrypts is registered with the store its ciphertext goes to (or as short-lived)', () => {
    expect(encrypting.length).toBeGreaterThanOrEqual(7);
    // Fails for a NEW use of the helpers: add the file to ENCRYPTION_USES in src/cli/reencrypt-stores.ts and, when
    // the ciphertext is kept, a store to STORES - otherwise a key rotation leaves that data behind.
    expect(encrypting.filter((f) => !ENCRYPTION_USES[f])).toEqual([]);
    expect(Object.keys(ENCRYPTION_USES).filter((f) => !encrypting.includes(f))).toEqual([]);
    const known = [...STORES.map((s) => s.name), LOCAL_FILES_STORE];
    for (const [file, use] of Object.entries(ENCRYPTION_USES)) {
      expect([file, (use.stores?.length ?? 0) > 0 || (use.transient?.length ?? 0) > 20]).toEqual([file, true]);
      for (const store of use.stores ?? []) expect([file, store, known.includes(store)]).toEqual([file, store, true]);
    }
    // And every store is fed by at least one registered file.
    const fed = new Set(Object.values(ENCRYPTION_USES).flatMap((u) => u.stores ?? []));
    expect(known.filter((s) => !fed.has(s))).toEqual([]);
    expect(new Set(STORES.map((s) => s.name)).size).toBe(STORES.length);
  });

  it('every encrypted column of the database schema has a store', () => {
    const schema = readFileSync(join(__dirname, '..', '..', '..', 'database', 'prisma', 'schema.prisma'), 'utf8');
    const columns = [...schema.matchAll(/^\s+(\w+Enc)\s+String/gm)].map((m) => m[1]).sort();
    expect(columns).toEqual(['emiratesIdEnc', 'ibanEnc', 'mfaSecretEnc', 'passportNoEnc', 'secretsEnc']);
    for (const column of columns) expect([column, STORES.some((s) => s.name.endsWith(`.${column}`))]).toEqual([column, true]);
  });
});

describe('production start-up check for secrets', () => {
  const production = (over: Record<string, string | undefined> = {}) => ({
    ...process.env,
    NODE_ENV: 'production',
    PAYMENT_SANDBOX_ENABLED: 'false',
    EXPOSE_DEV_TOKENS: 'false',
    COOKIE_SECURE: 'true',
    MFA_ENFORCEMENT: 'required',
    JWT_ACCESS_SECRET: b64(48),
    HMAC_KEY: b64(48),
    DATA_ENCRYPTION_KEY: b64(32),
    DATA_ENCRYPTION_OLD_KEYS: '',
    INTERNAL_API_TOKEN: b64(32),
    ...over,
  });
  const problemsOf = (over: Record<string, string | undefined>) => {
    try {
      loadEnv(production(over) as any);
    } catch (e: any) {
      return String(e.message);
    }
    return 'accepted';
  };

  it('accepts generated secrets (base64 and hex) and repeats nothing secret in its messages', () => {
    for (let i = 0; i < 25; i++) expect(problemsOf({})).toBe('accepted');
    expect(problemsOf({ JWT_ACCESS_SECRET: randomBytes(32).toString('hex'), HMAC_KEY: randomBytes(32).toString('hex') })).toBe('accepted');
    expect(problemsOf({ JWT_ACCESS_SECRET: randomBytes(24).toString('base64url') })).toBe('accepted');
    const old = b64(32);
    expect(problemsOf({ DATA_ENCRYPTION_KEY_ID: 'k2', DATA_ENCRYPTION_OLD_KEYS: `k1:${old}` })).toBe('accepted');
  });

  it('rejects every value published in .env.example, the docker dev files, CI and the test setup', () => {
    const example = Object.fromEntries(
      readFileSync(join(__dirname, '..', '..', '..', '.env.example'), 'utf8')
        .split('\n')
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
    );
    for (const name of ['JWT_ACCESS_SECRET', 'HMAC_KEY', 'DATA_ENCRYPTION_KEY', 'INTERNAL_API_TOKEN']) {
      expect(example[name]).toBeTruthy();
      expect(KNOWN_PLACEHOLDER_SECRETS).toContain(example[name]);
      expect([name, problemsOf({ [name]: example[name] })]).toEqual([name, expect.stringContaining(name)]);
    }
    expect(problemsOf({ JWT_ACCESS_SECRET: example.JWT_ACCESS_SECRET })).toMatch(/JWT_ACCESS_SECRET is the published development \/ example value/);
    expect(problemsOf({ DATA_ENCRYPTION_KEY: example.DATA_ENCRYPTION_KEY })).toMatch(/DATA_ENCRYPTION_KEY is the published development \/ example value/);
    // The values this very test run uses, and the other development files.
    expect(problemsOf({ JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET, HMAC_KEY: process.env.HMAC_KEY, DATA_ENCRYPTION_KEY: process.env.DATA_ENCRYPTION_KEY })).toMatch(/JWT_ACCESS_SECRET[\s\S]*HMAC_KEY[\s\S]*DATA_ENCRYPTION_KEY/);
    for (const value of KNOWN_PLACEHOLDER_SECRETS) {
      const asKey = weakKeyReasons('DATA_ENCRYPTION_KEY', value);
      const asSecret = weakSecretReasons('HMAC_KEY', value);
      expect([value, asKey.length > 0 && asSecret.length > 0]).toEqual([value, true]);
    }
    // An old key that is a development value is refused as well: it can still decrypt.
    expect(problemsOf({ DATA_ENCRYPTION_KEY_ID: 'k2', DATA_ENCRYPTION_OLD_KEYS: `k1:${example.DATA_ENCRYPTION_KEY}` })).toMatch(/DATA_ENCRYPTION_OLD_KEYS key "k1"/);
  });

  it('rejects short, typed and low-entropy values, and one secret used for two purposes', () => {
    expect(problemsOf({ JWT_ACCESS_SECRET: 'x'.repeat(31) })).toMatch(/JWT_ACCESS_SECRET/);
    for (const weak of ['a'.repeat(48), 'abcabcabcabcabcabcabcabcabcabcabcabcabcabc', 'my-production-jwt-secret-change-me-please-now', 'ThisIsOurCompanyPassword2026ForTypEase!!', 'prod-secret-key-for-typease-0123456789abcdef', 'example-example-example-example-example']) {
      expect([weak, problemsOf({ JWT_ACCESS_SECRET: weak })]).toEqual([weak, expect.stringContaining('JWT_ACCESS_SECRET')]);
      expect([weak, problemsOf({ HMAC_KEY: weak })]).toEqual([weak, expect.stringContaining('HMAC_KEY')]);
    }
    // Encryption keys: text somebody typed, a repeated byte, the wrong length.
    expect(problemsOf({ DATA_ENCRYPTION_KEY: Buffer.from('our-production-key-32-bytes-long').toString('base64') })).toMatch(/DATA_ENCRYPTION_KEY is text somebody typed/);
    expect(problemsOf({ DATA_ENCRYPTION_KEY: Buffer.alloc(32, 0xa7).toString('base64') })).toMatch(/DATA_ENCRYPTION_KEY is not random enough/);
    expect(problemsOf({ DATA_ENCRYPTION_KEY: Buffer.concat([Buffer.alloc(16, 1), Buffer.alloc(16, 2)]).toString('base64') })).toMatch(/not random enough/);
    expect(problemsOf({ DATA_ENCRYPTION_KEY: b64(31) + 'AAAAAAAA' })).toMatch(/32 bytes/);
    const shared = b64(48);
    expect(problemsOf({ JWT_ACCESS_SECRET: shared, HMAC_KEY: shared })).toMatch(/JWT_ACCESS_SECRET and HMAC_KEY must be different values/);
    expect(problemsOf({ INTERNAL_API_TOKEN: 'dev-internal-token-change-me' })).toMatch(/INTERNAL_API_TOKEN/);
    expect(problemsOf({ INTERNAL_API_TOKEN: 'shortshortshortsho' })).toMatch(/INTERNAL_API_TOKEN/);
    // Messages name the variable, never its value.
    const typed = 'my-production-jwt-secret-change-me-please-now';
    expect(problemsOf({ JWT_ACCESS_SECRET: typed })).not.toContain(typed);
    // The same values are fine outside production (development and tests use them).
    expect(() => loadEnv({ ...process.env, NODE_ENV: 'development', JWT_ACCESS_SECRET: 'local-development-jwt-secret-0123456789abcdef' } as any)).not.toThrow();
  });

  it('measures randomness sensibly', () => {
    expect(entropyBits('a'.repeat(64))).toBe(0);
    expect(entropyBits(b64(48))).toBeGreaterThan(250);
    expect(entropyBits(randomBytes(16).toString('hex'))).toBeGreaterThan(100);
    expect(weakSecretReasons('X', b64(48))).toEqual([]);
    expect(weakKeyReasons('X', b64(32))).toEqual([]);
  });
});

describe('password policy (PASSWORD_MIN_LENGTH)', () => {
  it('one function decides, with the configured minimum', () => {
    expect(passwordPolicy()).toEqual({ minLength: env().PASSWORD_MIN_LENGTH, maxLength: 128, requires: ['lowercase', 'uppercase', 'digit'] });
    expect(passwordProblems('Correct-Horse-42')).toEqual([]);
    expect(passwordProblems('Short-1a')).toEqual(['Use at least 10 characters']);
    expect(passwordProblems('Correct-Horse-42', passwordPolicy(20))).toEqual(['Use at least 20 characters']);
    expect(passwordProblems('correct-horse-42')).toEqual(['Include upper-case, lower-case and a number']);
    expect(passwordProblems('CORRECT-HORSE-42')).toEqual(['Include upper-case, lower-case and a number']);
    expect(passwordProblems('Correct-Horse-xx')).toEqual(['Include upper-case, lower-case and a number']);
    expect(passwordProblems(`Aa1${'x'.repeat(126)}`)).toEqual(['Use at most 128 characters']);
    expect(passwordProblems('abc')).toEqual(['Use at least 10 characters', 'Include upper-case, lower-case and a number']);
    try {
      assertPasswordPolicy('weak', 'newPassword');
      throw new Error('accepted');
    } catch (e: any) {
      expect(e.getStatus()).toBe(400);
      expect(e.getResponse()).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ path: 'newPassword', message: 'Use at least 10 characters' }, { path: 'newPassword', message: 'Include upper-case, lower-case and a number' }] });
      expect(JSON.stringify(e.getResponse())).not.toContain('weak"');
    }
  });

  it('the minimum can be raised by configuration but not lowered below the floor of the shared schema', () => {
    expect(loadEnv({ ...process.env, PASSWORD_MIN_LENGTH: '16' } as any).PASSWORD_MIN_LENGTH).toBe(16);
    expect(loadEnv({ ...process.env, PASSWORD_MIN_LENGTH: undefined } as any).PASSWORD_MIN_LENGTH).toBe(10);
    expect(() => loadEnv({ ...process.env, PASSWORD_MIN_LENGTH: '8' } as any)).toThrow(/PASSWORD_MIN_LENGTH cannot be lower than 10/);
    expect(() => loadEnv({ ...process.env, PASSWORD_MIN_LENGTH: '500' } as any)).toThrow(/PASSWORD_MIN_LENGTH/);
  });
});

describe('with the application: key rotation end to end and the password policy on every route that sets a password', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    await t.settle();
  });
  afterAll(() => t.close());

  it('re-encrypts every store to the new key: dry run, real run, idempotent, old key can be retired', async () => {
    const original = { key: env().DATA_ENCRYPTION_KEY, id: env().DATA_ENCRYPTION_KEY_ID };
    const next = { key: b64(32), id: 'k2' };
    const emiratesId = uniqueEmiratesId();
    const passportNo = uniquePassport();

    // ---- data written under the first key, through the API wherever there is one
    const customer = await t.as(alpha.owner).post('/customers', { fullName: 'Mariam Al Hashimi', phone: '+971501112233', emiratesId, passportNo, passportCountry: 'AE' }).expect(201);
    const untouched = await t.as(alpha.owner).post('/customers', { fullName: 'No Identity Numbers', phone: '+971501112244' }).expect(201);
    const mfaUser = await t.addStaff(alpha, 'accountant');
    const setup = await t.as(mfaUser).post('/auth/mfa/setup').expect(200);
    const integration = await makeIntegration(t, alpha.id, 'SMS', 'twilio', { accountSid: 'AC123' }, { authToken: 'tw-secret-token' });
    const content = pdfBytes('rotation');
    const upload = await t.as(alpha.owner).upload('/documents/upload', 'file', content, 'passport.pdf', { customerId: customer.body.id, documentTypeKey: 'passport', title: 'Passport copy' }).expect(201);
    const version = await t.sys.documentVersion.findFirstOrThrow({ where: { documentId: upload.body.documentId } });
    const ocr = await t.sys.ocrExtractionResult.create({
      data: {
        tenantId: alpha.id, documentId: upload.body.documentId, versionId: version.id, status: 'REVIEWED', provider: 'test', profile: 'PASSPORT',
        fields: [{ key: 'passportNumber', value: null, valueEnc: encryptText(passportNo), confidence: 0.98 }, { key: 'fullName', value: 'MARIAM AL HASHIMI', confidence: 0.9 }] as any,
        reviewedFields: { fields: [{ key: 'passportNumber', value: null, valueEnc: encryptText(passportNo), decision: 'CONFIRMED' }], note: null, applied: [] } as any,
      } as any,
    });
    // A notification that still holds its encrypted rendering (as queued account-security messages do).
    const agent = await t.createPlatformAdmin('SUPPORT_AGENT');
    const grant = await requestAccess(t, agent, alpha, ['customer.read']);
    await t.settle();
    const notification = await t.sys.notification.findFirstOrThrow({ where: { tenantId: alpha.id, relatedType: 'AccessGrant', relatedId: grant.id } });
    const secureText = { subject: 'Reset your password', text: 'Your link: https://alpha.example/reset?token=abc' };
    await t.sys.$executeRawUnsafe(`UPDATE "notifications" SET "data" = jsonb_set("data", '{secure}', to_jsonb($1::text)) WHERE "id" = $2::uuid`, encryptJson(secureText), notification.id);
    const local = t.get(StorageService).local!;
    const count = (reports: Array<{ store: string; stale: number; reencrypted: number; failed: number; values: number; byKeyId: Record<string, number> }>, store: string) => reports.find((r) => r.store === store)!;

    try {
      // ---- step 1 of a rotation: new key + new id, the previous pair moves to the old keys
      Object.assign(env(), { DATA_ENCRYPTION_KEY: next.key, DATA_ENCRYPTION_KEY_ID: next.id, DATA_ENCRYPTION_OLD_KEYS: `${original.id}:${original.key}` });
      // Everything written before is still readable.
      expect((await t.as(alpha.owner).get(`/customers/${customer.body.id}/identity`).expect(200)).body).toMatchObject({ emiratesId, passportNo });

      // ---- dry run: counts, changes nothing
      const before = await t.sys.customer.findUniqueOrThrow({ where: { id: customer.body.id } });
      const dry = await reencryptDatabase(t.sys as any, { dryRun: true, batchSize: 3 });
      expect(dry.map((r) => r.store)).toEqual(STORES.map((s) => s.name));
      expect(dry.every((r) => r.failed === 0 && r.reencrypted === 0)).toBe(true);
      expect(count(dry, 'customers.emiratesIdEnc').stale).toBeGreaterThanOrEqual(1);
      expect(count(dry, 'customers.passportNoEnc').stale).toBeGreaterThanOrEqual(1);
      expect(count(dry, 'users.mfaSecretEnc').stale).toBeGreaterThanOrEqual(1);
      expect(count(dry, 'integrations.secretsEnc').stale).toBeGreaterThanOrEqual(1);
      expect(count(dry, 'ocr_extraction_results.fields').stale).toBeGreaterThanOrEqual(1);
      expect(count(dry, 'ocr_extraction_results.reviewedFields').stale).toBeGreaterThanOrEqual(1);
      expect(count(dry, 'notifications.data.secure').stale).toBeGreaterThanOrEqual(1); // other suites of the same run leave some behind too
      for (const r of dry) expect(Object.keys(r.byKeyId).every((k) => k === original.id)).toBe(true);
      expect(await t.sys.customer.findUniqueOrThrow({ where: { id: customer.body.id } })).toEqual(before);
      const dryFiles = await local.reencryptAll({ dryRun: true });
      expect(dryFiles).toMatchObject({ reencrypted: 0, failed: 0 });
      expect(dryFiles.stale).toBeGreaterThanOrEqual(1);

      // A value written now already uses the new key and is not counted as old.
      const fresh = await t.as(alpha.owner).post('/customers', { fullName: 'After Rotation', phone: '+971501112255', passportNo: uniquePassport(), passportCountry: 'AE' }).expect(201);
      expect(envelopeKeyId((await t.sys.customer.findUniqueOrThrow({ where: { id: fresh.body.id } })).passportNoEnc!)).toBe('k2');

      // ---- the real run, in small batches
      const run = await reencryptDatabase(t.sys as any, { dryRun: false, batchSize: 3 });
      expect(run.every((r) => r.failed === 0 && r.reencrypted === r.stale)).toBe(true);
      for (const r of dry) expect([r.store, count(run, r.store).reencrypted]).toEqual([r.store, r.stale]);
      const files = await local.reencryptAll();
      expect(files).toMatchObject({ failed: 0, reencrypted: dryFiles.stale });

      // Nothing is left under the old key anywhere - checked on the raw rows, not through the API.
      const row = await t.sys.customer.findUniqueOrThrow({ where: { id: customer.body.id } });
      expect([envelopeKeyId(row.emiratesIdEnc!), envelopeKeyId(row.passportNoEnc!)]).toEqual(['k2', 'k2']);
      // Only the ciphertext changed: lookups by blind index, the masked tail and the timestamps are as before.
      expect(row).toMatchObject({ emiratesIdHash: before.emiratesIdHash, passportNoHash: before.passportNoHash, emiratesIdLast4: before.emiratesIdLast4, updatedAt: before.updatedAt });
      expect((await t.sys.customer.findUniqueOrThrow({ where: { id: untouched.body.id } })).emiratesIdEnc).toBeNull();
      expect(envelopeKeyId((await t.sys.user.findUniqueOrThrow({ where: { id: mfaUser.userId } })).mfaSecretEnc!)).toBe('k2');
      expect(envelopeKeyId((await t.sys.integration.findUniqueOrThrow({ where: { id: integration.id } })).secretsEnc!)).toBe('k2');
      const ocrRow = await t.sys.ocrExtractionResult.findUniqueOrThrow({ where: { id: ocr.id } });
      expect((ocrRow.fields as any[]).map((f) => (f.valueEnc ? envelopeKeyId(f.valueEnc) : null))).toEqual(['k2', null]);
      expect((ocrRow.fields as any[])[1]).toEqual({ key: 'fullName', value: 'MARIAM AL HASHIMI', confidence: 0.9 });
      expect(envelopeKeyId((ocrRow.reviewedFields as any).fields[0].valueEnc)).toBe('k2');
      for (const table of ['users', 'customers', 'integration_credentials_metadata', 'notifications', 'ocr_extraction_results']) {
        const left = await t.sys.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "${table}" t WHERE to_jsonb(t)::text ~ '"${original.id}\\.[A-Za-z0-9_-]{16}\\.[A-Za-z0-9_-]{22}\\.'`);
        expect([table, Number(left[0].n)]).toEqual([table, 0]);
      }

      // ---- idempotent: a second run finds nothing to do
      const again = await reencryptDatabase(t.sys as any, { dryRun: false, batchSize: 100 });
      expect(again.every((r) => r.stale === 0 && r.reencrypted === 0 && r.failed === 0)).toBe(true);
      for (const r of again) expect(Object.keys(r.byKeyId).every((k) => k === 'k2')).toBe(true);
      expect(await local.reencryptAll()).toMatchObject({ stale: 0, reencrypted: 0, failed: 0 });

      // ---- step 3: the old key is retired; everything still works with the new key alone
      Object.assign(env(), { DATA_ENCRYPTION_OLD_KEYS: '' });
      expect((await t.as(alpha.owner).get(`/customers/${customer.body.id}/identity`).expect(200)).body).toMatchObject({ emiratesId, passportNo });
      const link = await t.as(alpha.owner).post(`/documents/${upload.body.documentId}/download-link`).expect(200);
      const file = await fetchBytes(t, link.body.url);
      expect(sha(file.body)).toBe(sha(content));
      await t.as(mfaUser).post('/auth/mfa/enable', { code: authenticator.generate(setup.body.secret) }).expect(200);
      expect(decryptJson((await t.sys.integration.findUniqueOrThrow({ where: { id: integration.id } })).secretsEnc!)).toEqual({ authToken: 'tw-secret-token' });
      expect(decryptText(((await t.sys.ocrExtractionResult.findUniqueOrThrow({ where: { id: ocr.id } })).fields as any[])[0].valueEnc)).toBe(passportNo);
      const kept = await t.sys.notification.findUniqueOrThrow({ where: { id: notification.id } });
      expect(decryptJson((kept.data as any).secure)).toEqual(secureText);
      expect({ ...(kept.data as any), secure: undefined }).toEqual({ ...(notification.data as any), secure: undefined });

      // ---- a value under a key that is not configured is reported (by row id), never guessed and never destroyed
      const orphanKey = { key: b64(32), id: 'lost' };
      const orphan = await withKeys(orphanKey, () => encryptText('784199012345671'));
      await t.sys.customer.update({ where: { id: untouched.body.id }, data: { emiratesIdEnc: orphan } });
      const failing = await reencryptDatabase(t.sys as any, { dryRun: false, batchSize: 50, only: ['customers.emiratesIdEnc'] });
      expect(failing).toHaveLength(1);
      expect(failing[0]).toMatchObject({ failed: 1, reencrypted: 0 });
      expect(failing[0].failures).toEqual([`customers ${untouched.body.id}: encrypted with key "lost", which is not configured`]);
      expect((await t.sys.customer.findUniqueOrThrow({ where: { id: untouched.body.id } })).emiratesIdEnc).toBe(orphan);
      await t.sys.customer.update({ where: { id: untouched.body.id }, data: { emiratesIdEnc: null } });
    } finally {
      // Put the suite's own key back as the current one, and move the data back so later tests are unaffected.
      Object.assign(env(), { DATA_ENCRYPTION_KEY: original.key, DATA_ENCRYPTION_KEY_ID: original.id, DATA_ENCRYPTION_OLD_KEYS: `${next.id}:${next.key}` });
      await reencryptDatabase(t.sys as any, { dryRun: false, batchSize: 200 });
      await local.reencryptAll();
      Object.assign(env(), { DATA_ENCRYPTION_OLD_KEYS: '' });
    }
    expect((await t.as(alpha.owner).get(`/customers/${customer.body.id}/identity`).expect(200)).body).toMatchObject({ emiratesId, passportNo });
  }, 120_000);

  it('a stricter PASSWORD_MIN_LENGTH applies to registration, sign-up, reset, change and invitations, and is published', async () => {
    const before = env().PASSWORD_MIN_LENGTH;
    const twelve = 'Abcdefghi-12'; // fine for the default policy (10), too short for 14
    const fourteen = 'Abcdefghijk-14';
    const tooShort = (res: { status: number; body: any }, field = 'password') => {
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ path: field, message: 'Use at least 14 characters' }] });
    };
    try {
      (env() as any).PASSWORD_MIN_LENGTH = 14;
      // Published where the web apps look before they show a password form.
      const config = await t.http.get(`/api/v1/public/tenant-config?slug=${alpha.slug}`).expect(200);
      expect(config.body.passwordPolicy).toEqual({ minLength: 14, maxLength: 128, requires: ['lowercase', 'uppercase', 'digit'] });

      // Customer registration.
      const email = `policy-${uniq()}@example.test`;
      tooShort(await t.http.post('/api/v1/auth/register').send({ tenantSlug: alpha.slug, fullName: 'Policy Person', email, password: twelve, acceptTerms: true }));
      expect(await t.sys.user.count({ where: { email } })).toBe(0);
      const registered = await t.http.post('/api/v1/auth/register').send({ tenantSlug: alpha.slug, fullName: 'Policy Person', email, password: fourteen, acceptTerms: true }).expect(201);
      await t.http.post('/api/v1/auth/verify-email').send({ token: registered.body.dev.emailVerificationToken }).expect(200);

      // A new centre signing up.
      const slug = `pol-${uniq()}`;
      tooShort(await t.http.post('/api/v1/public/signup').send({ businessName: 'Policy Centre', slug, ownerName: 'Policy Owner', email: `owner-${slug}@example.test`, phone: `+9715${String(Date.now()).slice(-8)}`, password: twelve, acceptTerms: true }));
      expect(await t.sys.tenant.count({ where: { slug } })).toBe(0);

      // Reset: a password that is too weak does not use up the link.
      const forgot = await t.http.post('/api/v1/auth/password/forgot').send({ email, app: 'customer', tenantSlug: alpha.slug }).expect(200);
      const resetToken = forgot.body.dev.passwordResetToken;
      tooShort(await t.http.post('/api/v1/auth/password/reset').send({ token: resetToken, password: twelve }));
      await t.http.post('/api/v1/auth/password/reset').send({ token: resetToken, password: 'Resetpassword-14' }).expect(200);
      await t.http.post('/api/v1/auth/password/reset').send({ token: resetToken, password: 'Resetpassword-15' }).expect(400);

      // Change (signed in). The old, shorter password of an existing user keeps working for sign-in.
      const staff = await t.login(alpha.owner.email);
      tooShort(await t.as(staff).post('/auth/password/change', { currentPassword: PASSWORD, newPassword: twelve }), 'newPassword');
      expect(PASSWORD.length).toBeGreaterThanOrEqual(14);
      const shortUser = await t.sys.user.findFirstOrThrow({ where: { email } });
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy on purpose: auth.service pulls in the whole auth module graph; loading it only when the fixture runs keeps spec-file load order unchanged
      const { hashPassword } = require('../src/modules/auth/auth.service');
      await t.sys.user.update({ where: { id: shortUser.id }, data: { passwordHash: await hashPassword(twelve) } });
      const signedIn = await t.http.post('/api/v1/auth/login').send({ email, password: twelve, app: 'customer', tenantSlug: alpha.slug }).expect(200);
      expect(signedIn.body.status).toBe('OK');

      // Invitation: the preview says what is required; a weak password does not use up the invitation.
      const invitee = `invitee-${uniq()}@example.test`;
      const invite = await t.as(alpha.owner).post('/staff/invitations', { email: invitee, fullName: 'Invited Person', roleKey: 'operator', allBranches: true }).expect(201);
      const token = invite.body.dev.invitationToken;
      const preview = await t.http.get(`/api/v1/auth/invitations/preview?token=${token}`).expect(200);
      expect(preview.body).toMatchObject({ needsPassword: true, passwordPolicy: { minLength: 14 } });
      tooShort(await t.http.post('/api/v1/auth/invitations/accept').send({ token, password: twelve, app: 'centre' }));
      expect((await t.http.post('/api/v1/auth/invitations/accept').send({ token, password: fourteen, app: 'centre' }).expect(200)).body.status).toBe('OK');
    } finally {
      (env() as any).PASSWORD_MIN_LENGTH = before;
    }
    expect((await t.http.get(`/api/v1/public/tenant-config?slug=${alpha.slug}`).expect(200)).body.passwordPolicy.minLength).toBe(before);
  });
});
