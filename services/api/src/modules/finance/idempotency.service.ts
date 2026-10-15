import { Injectable } from '@nestjs/common';
import { sha256 } from '../../common/crypto';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors } from '../../common/errors';
import { toApi } from './finance.serialise';

const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

/** Deterministic JSON (sorted keys) so the same request always hashes the same. */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
export const requestHash = (body: unknown) => sha256(stableStringify(body));

export interface IdempotentResult<T> {
  /** true when the stored response of an earlier identical request is returned. */
  replayed: boolean;
  status: number;
  body: T;
}

/**
 * Makes money-moving POSTs safe to retry (double click, flaky network, client
 * retry). The caller sends an `Idempotency-Key` header:
 *
 *   - first request: the work runs and its response is stored with the key;
 *   - same key + same body: the stored response is returned, nothing runs again;
 *   - same key + different body: 409 IDEMPOTENCY_KEY_REUSED.
 *
 * The key row is written in the SAME transaction as the business change, so
 * either both exist or neither does: a failed request can be retried with the
 * same key. Two concurrent requests with one key are serialised by the unique
 * index (the second waits for the first to commit, then replays its response).
 * Keys are scoped per tenant and per operation and expire after 24 hours.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly db: TenantDb) {}

  assertKey(key: string | undefined | null): string {
    const k = (key ?? '').trim();
    if (!k) throw Errors.badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (a unique value per attempt, e.g. a UUID) so a retry can never record this twice.');
    if (!KEY_PATTERN.test(k)) throw Errors.badRequest('IDEMPOTENCY_KEY_INVALID', 'The Idempotency-Key must be 8-128 letters, digits or - _ . : characters.');
    return k;
  }

  async run<T>(scope: string, key: string | undefined | null, body: unknown, work: (tx: Tx) => Promise<T>, successStatus = 201): Promise<IdempotentResult<T>> {
    const k = this.assertKey(key);
    const hash = requestHash(body);
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      await tx.idempotencyKey.deleteMany({ where: { tenantId, expiresAt: { lt: new Date() } } });
      const inserted = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO "idempotency_keys" ("id", "tenantId", "scope", "key", "requestHash", "createdAt", "expiresAt")
        VALUES (gen_random_uuid(), ${tenantId}::uuid, ${scope}, ${k}, ${hash}, now(), now() + interval '24 hours')
        ON CONFLICT ("tenantId", "scope", "key") DO NOTHING
        RETURNING "id"`;
      if (!inserted.length) {
        const existing = await tx.idempotencyKey.findFirst({ where: { tenantId, scope, key: k } });
        if (!existing) throw Errors.conflict('IDEMPOTENCY_RETRY', 'The earlier attempt with this key did not finish. Please try again.');
        if (existing.requestHash !== hash) {
          throw Errors.conflict('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request. Use a new key for a new operation.');
        }
        if (existing.responseBody === null || existing.responseStatus === null) {
          throw Errors.conflict('IDEMPOTENCY_RETRY', 'The earlier attempt with this key did not finish. Please try again.');
        }
        return { replayed: true, status: existing.responseStatus, body: existing.responseBody as T };
      }
      const result = await work(tx);
      // Stored exactly as the client receives it (amounts as two-decimal strings, dates as ISO strings).
      const serialised = JSON.parse(JSON.stringify(toApi(result ?? null)));
      await tx.idempotencyKey.update({ where: { id: inserted[0].id }, data: { responseStatus: successStatus, responseBody: serialised } });
      return { replayed: false, status: successStatus, body: serialised as T };
    });
  }
}
