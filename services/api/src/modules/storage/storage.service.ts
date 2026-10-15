import { Injectable } from '@nestjs/common';
import { env } from '../../config/env';
import { randomToken } from '../../common/crypto';
import { LocalStorageDriver } from './local.driver';
import { S3StorageDriver } from './s3.driver';
import { DownloadOptions, PresignedDownload, PresignedUpload, stagingKeyFor, StorageDriver, StoredObjectInfo, StorageCheck } from './storage.types';

/**
 * The private document store. Callers only ever handle opaque keys created by
 * `newKey()`; keys and paths never leave the backend except inside a signed,
 * expiring URL.
 */
@Injectable()
export class StorageService {
  private readonly driver: StorageDriver = env().STORAGE_DRIVER === 's3' ? new S3StorageDriver() : new LocalStorageDriver();

  get driverName() {
    return this.driver.name;
  }
  get encryption() {
    return this.driver.encryption;
  }
  /** Is the store reachable right now? One cheap call; never throws. Used by the platform's system status. */
  check(): Promise<StorageCheck> {
    return this.driver.check();
  }
  /** The local driver, for the controller that serves its signed URLs. Null when S3 is in use. */
  get local(): LocalStorageDriver | null {
    return this.driver instanceof LocalStorageDriver ? this.driver : null;
  }

  /** `<tenantId>/<192-bit random>`: unguessable and never derived from user input. */
  newKey(tenantId: string): string {
    if (!/^[0-9a-f-]{36}$/.test(tenantId)) throw new Error('newKey needs a tenant id.');
    return `${tenantId}/${randomToken(24)}`;
  }

  /**
   * URL the client PUTs the bytes to. It writes to a staging key, not to the
   * final key, so a leaked or replayed upload URL can never overwrite an object
   * that has already been checked and scanned (see `promote`).
   */
  presignUpload(finalKey: string, contentType: string, sizeBytes: number): Promise<PresignedUpload> {
    return this.driver.presignUpload(stagingKeyFor(finalKey), { contentType, sizeBytes, ttlSeconds: env().UPLOAD_URL_TTL_SECONDS });
  }
  /** Server-side write to the staging area (multipart endpoint). */
  putStaged(finalKey: string, body: Buffer, contentType: string): Promise<void> {
    return this.driver.put(stagingKeyFor(finalKey), body, contentType);
  }
  /**
   * Moves a staged upload to its final key. Safe to repeat: when the staging
   * object is gone (already promoted) the final object is reported as is.
   */
  async promote(finalKey: string): Promise<StoredObjectInfo | null> {
    const staging = stagingKeyFor(finalKey);
    if (await this.driver.head(staging)) await this.driver.move(staging, finalKey);
    return this.driver.head(finalKey);
  }
  /** Removes whatever exists for a key, staged or final. */
  async discard(finalKey: string): Promise<void> {
    await this.driver.delete(stagingKeyFor(finalKey));
    await this.driver.delete(finalKey);
  }

  put(key: string, body: Buffer, contentType: string): Promise<void> {
    return this.driver.put(key, body, contentType);
  }
  head(key: string): Promise<StoredObjectInfo | null> {
    return this.driver.head(key);
  }
  readHead(key: string, bytes = 4100): Promise<Buffer> {
    return this.driver.readHead(key, bytes);
  }
  getBuffer(key: string): Promise<Buffer> {
    return this.driver.getBuffer(key);
  }
  delete(key: string): Promise<void> {
    return this.driver.delete(key);
  }
  /** Short-lived download URL. The TTL is capped by DOWNLOAD_URL_TTL_SECONDS. */
  presignDownload(key: string, options: Omit<DownloadOptions, 'ttlSeconds'> & { ttlSeconds?: number }): Promise<PresignedDownload> {
    const max = env().DOWNLOAD_URL_TTL_SECONDS;
    return this.driver.presignDownload(key, { ...options, ttlSeconds: Math.min(options.ttlSeconds ?? max, max) });
  }
  sweep(olderThanMs = 24 * 3600_000): Promise<{ removed: number }> {
    return this.driver.sweep(olderThanMs);
  }
  /**
   * Tenant offboarding only: permanently removes every stored and staged object
   * of one tenant (everything under the `<tenantId>/` prefix). Cannot be undone.
   */
  deleteTenantObjects(tenantId: string): Promise<{ removed: number }> {
    return this.driver.deleteTenant(tenantId);
  }
}
