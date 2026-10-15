/**
 * Private object storage contract. Two drivers implement it: `s3` (any
 * S3-compatible store) and `local` (encrypted files on disk, for development,
 * tests and single-server installs).
 *
 * Rules every driver obeys:
 *  - objects are private: there is no method that produces a public URL;
 *  - upload / download URLs expire and are bound to one object key;
 *  - content is encrypted at rest (SSE-S3, or AES-256-GCM in the application).
 */
export interface PresignedUpload {
  url: string;
  method: 'PUT';
  /** Headers the client MUST send with the PUT, exactly as given. */
  headers: Record<string, string>;
  expiresAt: Date;
}
export interface PresignedDownload {
  url: string;
  expiresAt: Date;
}
export interface UploadConstraints {
  contentType: string;
  /** Exact size of the body in bytes. The upload is rejected if it differs. */
  sizeBytes: number;
  ttlSeconds: number;
}
export interface DownloadOptions {
  filename: string;
  contentType: string;
  disposition: 'attachment' | 'inline';
  ttlSeconds: number;
}
export interface StoredObjectInfo {
  sizeBytes: number;
  contentType: string | null;
}
/** Value stored in document_versions.encryption. */
export type AtRestEncryption = 'SSE_S3' | 'APP_AES256_GCM';

/** Result of a cheap reachability check: can the store be written to (local) / is the bucket there and ours (S3)? */
export interface StorageCheck {
  ok: boolean;
  /** Where the objects live, in words an operator recognises. Never a credential. */
  target: string;
  /** Why the check failed (error name / status only), or null. */
  error: string | null;
}

export interface StorageDriver {
  readonly name: 's3' | 'local';
  readonly encryption: AtRestEncryption;
  /** One cheap round trip: `HeadBucket` (S3) or a probe file written and removed (local disk). Never throws. */
  check(): Promise<StorageCheck>;
  presignUpload(key: string, constraints: UploadConstraints): Promise<PresignedUpload>;
  presignDownload(key: string, options: DownloadOptions): Promise<PresignedDownload>;
  /** Server-side write (multipart endpoint, generated documents). */
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  head(key: string): Promise<StoredObjectInfo | null>;
  /** First `bytes` bytes of the object, for content sniffing. */
  readHead(key: string, bytes: number): Promise<Buffer>;
  getBuffer(key: string): Promise<Buffer>;
  /** Moves an object. Overwrites the destination. Throws if the source is missing. */
  move(fromKey: string, toKey: string): Promise<void>;
  /** Idempotent: deleting a missing object succeeds. */
  delete(key: string): Promise<void>;
  /** Housekeeping of driver-internal leftovers (expired upload markers, temp files). */
  sweep(olderThanMs: number): Promise<{ removed: number }>;
  /**
   * Permanently removes EVERY object of one tenant: stored objects (`<tenantId>/...`)
   * and staged uploads (`incoming/<tenantId>/...`). Only for tenant offboarding.
   * Idempotent: a second call finds nothing and succeeds.
   */
  deleteTenant(tenantId: string): Promise<{ removed: number }>;
}

/**
 * Object keys are `<tenantId>/<random>` for stored objects and
 * `incoming/<tenantId>/<random>` for the short-lived staging area that
 * presigned uploads write to. They are never derived from user input.
 */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const KEY_RE = new RegExp(`^(incoming/)?${UUID}/[A-Za-z0-9_-]{32,64}$`);
export const isTenantId = (value: unknown): value is string => typeof value === 'string' && new RegExp(`^${UUID}$`).test(value);
export const isValidKey = (key: unknown): key is string => typeof key === 'string' && KEY_RE.test(key);
export const STAGING_PREFIX = 'incoming/';
export const stagingKeyFor = (finalKey: string) => `${STAGING_PREFIX}${finalKey}`;

/** RFC 6266 / 5987 Content-Disposition with an ASCII fallback and a UTF-8 name. */
export function contentDisposition(disposition: 'attachment' | 'inline', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
