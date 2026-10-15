import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../config/env';
import { Errors } from '../../common/errors';
import { StorageObjectNotFound } from './local.driver';
import { AtRestEncryption, contentDisposition, DownloadOptions, isTenantId, isValidKey, PresignedDownload, PresignedUpload, STAGING_PREFIX, StorageDriver, StoredObjectInfo, UploadConstraints, StorageCheck } from './storage.types';

export interface S3DriverOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle: boolean;
  credentials?: { accessKeyId: string; secretAccessKey: string };
  /** Tests inject a request handler so nothing touches the network. */
  requestHandler?: S3ClientConfig['requestHandler'];
}

const SSE = 'AES256';
const notFound = (e: any) => e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;

/**
 * S3-compatible private bucket.
 *
 *  - Every write asks for server-side encryption (SSE-S3 / AES256). Presigned
 *    uploads SIGN the `x-amz-server-side-encryption`, `content-type` and
 *    `content-length` headers, so the store rejects an upload that is
 *    unencrypted, of another type or of another size than was declared.
 *  - Only presigned, expiring URLs are ever produced. There is no code path
 *    that returns a plain bucket URL or changes an object ACL.
 */
export class S3StorageDriver implements StorageDriver {
  readonly name = 's3' as const;
  readonly encryption: AtRestEncryption = 'SSE_S3';
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options: S3DriverOptions = S3StorageDriver.optionsFromEnv()) {
    this.bucket = options.bucket;
    this.client = new S3Client({
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle,
      credentials: options.credentials,
      // Flexible checksums would add x-amz-checksum-* parameters to presigned URLs, which
      // browsers cannot satisfy and several S3-compatible stores reject.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      ...(options.requestHandler ? { requestHandler: options.requestHandler } : {}),
    });
  }

  /** `HeadBucket`: the bucket exists and these credentials may use it. Gives up after three seconds. */
  async check(): Promise<StorageCheck> {
    const endpoint = await this.client.config.endpoint?.().then((e) => e.hostname, () => null).catch(() => null);
    const target = `S3 bucket "${this.bucket}"${endpoint ? ` at ${endpoint}` : ''}`;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }), { abortSignal: AbortSignal.timeout(3000) });
      return { ok: true, target, error: null };
    } catch (e: any) {
      const status = e?.$metadata?.httpStatusCode;
      // Name and status only: SDK messages can carry request details.
      return { ok: false, target, error: `${e?.name ?? 'Error'}${status ? ` (HTTP ${status})` : ''}` };
    }
  }

  static optionsFromEnv(): S3DriverOptions {
    const e = env();
    return {
      bucket: e.S3_BUCKET,
      region: e.S3_REGION,
      endpoint: e.S3_ENDPOINT || undefined,
      forcePathStyle: e.S3_FORCE_PATH_STYLE,
      // Without static keys the SDK falls back to its default chain (instance / task role).
      credentials: e.S3_ACCESS_KEY_ID && e.S3_SECRET_ACCESS_KEY ? { accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY } : undefined,
    };
  }

  private validKey(key: string): string {
    if (!isValidKey(key)) throw new Error('Invalid storage key.');
    return key;
  }
  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e: any) {
      if (e?.name === 'CredentialsProviderError') {
        throw Errors.notConfigured('Document storage', 'Set S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY (or attach an IAM role) for the private bucket.');
      }
      throw e;
    }
  }

  async presignUpload(key: string, c: UploadConstraints): Promise<PresignedUpload> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.validKey(key),
      ContentType: c.contentType,
      ContentLength: c.sizeBytes,
      ServerSideEncryption: SSE,
    });
    const url = await this.run(() =>
      getSignedUrl(this.client, command, {
        expiresIn: c.ttlSeconds,
        // Keep these as SIGNED HEADERS (not query parameters) so the client must send them unchanged.
        unhoistableHeaders: new Set(['x-amz-server-side-encryption']),
        signableHeaders: new Set(['content-type', 'content-length']),
      }),
    );
    return {
      url,
      method: 'PUT',
      headers: { 'Content-Type': c.contentType, 'x-amz-server-side-encryption': SSE },
      expiresAt: new Date(Date.now() + c.ttlSeconds * 1000),
    };
  }

  async presignDownload(key: string, o: DownloadOptions): Promise<PresignedDownload> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: this.validKey(key),
      ResponseContentDisposition: contentDisposition(o.disposition, o.filename),
      ResponseContentType: o.contentType,
      ResponseCacheControl: 'private, no-store',
    });
    const url = await this.run(() => getSignedUrl(this.client, command, { expiresIn: o.ttlSeconds }));
    return { url, expiresAt: new Date(Date.now() + o.ttlSeconds * 1000) };
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.run(() =>
      this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.validKey(key), Body: body, ContentType: contentType, ContentLength: body.length, ServerSideEncryption: SSE })),
    );
  }

  async head(key: string): Promise<StoredObjectInfo | null> {
    try {
      const out = await this.run(() => this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.validKey(key) })));
      return { sizeBytes: Number(out.ContentLength ?? 0), contentType: out.ContentType ?? null };
    } catch (e: any) {
      if (notFound(e)) return null;
      throw e;
    }
  }

  private async read(key: string, range?: string): Promise<Buffer> {
    try {
      const out = await this.run(() => this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.validKey(key), Range: range })));
      if (!out.Body) return Buffer.alloc(0);
      return Buffer.from(await out.Body.transformToByteArray());
    } catch (e: any) {
      if (notFound(e)) throw new StorageObjectNotFound();
      throw e;
    }
  }
  readHead(key: string, bytes: number): Promise<Buffer> {
    return this.read(key, `bytes=0-${Math.max(0, bytes - 1)}`);
  }
  getBuffer(key: string): Promise<Buffer> {
    return this.read(key);
  }

  async move(fromKey: string, toKey: string): Promise<void> {
    this.validKey(toKey);
    try {
      await this.run(() =>
        this.client.send(
          new CopyObjectCommand({
            Bucket: this.bucket,
            Key: toKey,
            CopySource: `${this.bucket}/${this.validKey(fromKey).split('/').map(encodeURIComponent).join('/')}`,
            ServerSideEncryption: SSE,
          }),
        ),
      );
    } catch (e: any) {
      if (notFound(e)) throw new StorageObjectNotFound();
      throw e;
    }
    await this.delete(fromKey);
  }

  async delete(key: string): Promise<void> {
    await this.run(() => this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.validKey(key) })));
  }

  /**
   * Lists the tenant's two prefixes page by page and deletes every key found.
   * Keys are deleted one request at a time (in small parallel batches): slower
   * than a bulk delete, but it works unchanged on every S3-compatible store.
   */
  async deleteTenant(tenantId: string): Promise<{ removed: number }> {
    if (!isTenantId(tenantId)) throw new Error('deleteTenant needs a tenant id.');
    let removed = 0;
    for (const prefix of [`${tenantId}/`, `${STAGING_PREFIX}${tenantId}/`]) {
      let token: string | undefined;
      do {
        const page = await this.run(() => this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 })));
        const keys = (page.Contents ?? []).map((o) => o.Key).filter((k): k is string => typeof k === 'string' && k.startsWith(prefix));
        for (let i = 0; i < keys.length; i += 20) {
          await Promise.all(keys.slice(i, i + 20).map((Key) => this.run(() => this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key })))));
        }
        removed += keys.length;
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
    }
    return { removed };
  }

  /** Nothing to sweep: configure a bucket lifecycle rule that expires the `incoming/` prefix after one day. */
  async sweep(): Promise<{ removed: number }> {
    return { removed: 0 };
  }
}
