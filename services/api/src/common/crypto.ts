import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { env, Keyring, parseKeyring } from '../config/env';

/**
 * Application-level cryptography.
 *  - Field / file encryption: AES-256-GCM, random 96-bit IV. Every ciphertext carries the id of its key
 *    (DATA_ENCRYPTION_KEY_ID), so keys can be rotated: see docs/deployment/secrets.md and src/cli/reencrypt.ts.
 *  - Blind index + URL signatures: HMAC-SHA-256.
 *  - One-time tokens: 256-bit random, stored only as SHA-256.
 */

let cachedKeyring: { source: string; ring: Keyring } | undefined;
/**
 * The keyring from the environment (see config/env.ts). `current` encrypts and its id is stamped on the
 * ciphertext; `all` (current + DATA_ENCRYPTION_OLD_KEYS) decrypts. Parsed once per configuration.
 */
function keyring(): Keyring {
  const e = env();
  const source = `${e.DATA_ENCRYPTION_KEY_ID}|${e.DATA_ENCRYPTION_KEY}|${e.DATA_ENCRYPTION_OLD_KEYS}`;
  if (cachedKeyring?.source !== source) cachedKeyring = { source, ring: parseKeyring(e) };
  return cachedKeyring.ring;
}

/** Raised when a ciphertext names a key that is not configured. Decryption fails closed: nothing is guessed. */
export class UnknownEncryptionKey extends Error {
  constructor(public readonly keyId: string) {
    super(`This data was encrypted with key "${keyId}", which is not configured. Add it to DATA_ENCRYPTION_OLD_KEYS as "${keyId}:<base64 key>" (it is needed to read the data), or restore the key from escrow.`);
    this.name = 'UnknownEncryptionKey';
  }
}
function keyFor(id: string | undefined): Buffer {
  const key = id ? keyring().all.get(id) : undefined;
  if (!key) throw new UnknownEncryptionKey(String(id ?? ''));
  return key;
}

/** Id of the key new data is encrypted with. */
export const currentKeyId = () => keyring().current.id;
/** Id of the key a text envelope was encrypted with (the part before the first dot), or null if it is not an envelope. */
export function envelopeKeyId(envelope: string): string | null {
  const parts = envelope.split('.');
  return parts.length === 4 && parts[0] ? parts[0] : null;
}
/** True when the envelope was written with a key other than the current one. */
export const needsReencryption = (envelope: string) => envelopeKeyId(envelope) !== currentKeyId();
/** Decrypts with whichever configured key wrote the envelope and encrypts again with the current key. Idempotent. */
export function reencryptText(envelope: string): string {
  return needsReencryption(envelope) ? encryptText(decryptText(envelope)) : envelope;
}

export function encryptText(plain: string): string {
  const { current } = keyring();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', current.key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${current.id}.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
}

export function decryptText(envelope: string): string {
  const [id, iv, tag, data] = envelope.split('.');
  if (!iv || !tag || data === undefined) throw new Error('Malformed ciphertext.');
  const key = keyFor(id);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

export function encryptBuffer(plain: Buffer): { data: Buffer; meta: { keyId: string; iv: string; tag: string } } {
  const { current } = keyring();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', current.key, iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { data, meta: { keyId: current.id, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') } };
}
export function decryptBuffer(data: Buffer, meta: { keyId: string; iv: string; tag: string }): Buffer {
  const key = keyFor(meta.keyId);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(meta.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(meta.tag, 'base64url'));
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

export const encryptJson = (value: unknown) => encryptText(JSON.stringify(value));
export const decryptJson = <T = any>(envelope: string): T => JSON.parse(decryptText(envelope));

/** Deterministic keyed hash for exact-match lookup of encrypted values (scoped by tenant). */
export function blindIndex(tenantId: string, kind: string, value: string): string {
  const normalised = value.replace(/[\s-]/g, '').toUpperCase();
  return createHmac('sha256', env().HMAC_KEY).update(`${tenantId}|${kind}|${normalised}`).digest('hex');
}

export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const numericCode = (digits = 6) => String(randomInt(0, 10 ** digits)).padStart(digits, '0');
export const hmac = (value: string, key: string = env().HMAC_KEY) => createHmac('sha256', key).update(value).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Signed, expiring token carrying a small JSON payload (download links, upload intents). */
export function signPayload(payload: Record<string, unknown>, ttlSeconds: number): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
  return `${body}.${createHmac('sha256', env().HMAC_KEY).update(body).digest('base64url')}`;
}
export function verifyPayload<T = Record<string, any>>(token: string): (T & { exp: number }) | null {
  const [body, sig] = (token ?? '').split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', env().HMAC_KEY).update(body).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof parsed.exp !== 'number' || parsed.exp < Math.floor(Date.now() / 1000)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export const last4 = (value: string) => value.replace(/[\s-]/g, '').slice(-4);
export const maskTail = (tail: string | null | undefined) => (tail ? `•••• ${tail}` : null);
