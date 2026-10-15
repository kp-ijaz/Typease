import type { PrismaClient } from '@typease/database';
import { currentKeyId, envelopeKeyId, reencryptText } from '../common/crypto';

/**
 * Everything the API stores encrypted with DATA_ENCRYPTION_KEY, and how to move
 * it to the current key. Used by `src/cli/reencrypt.ts`.
 *
 * ADDING ENCRYPTED DATA? Add the file that encrypts to `ENCRYPTION_USES` and, if
 * the ciphertext is kept in the database or on disk, a store to `STORES`.
 * test/encryption.spec.ts fails when a file uses the encryption helpers without
 * being listed here - otherwise a key rotation would silently leave data behind
 * that becomes unreadable once the old key is retired.
 */

export interface StoreReport {
  store: string;
  /** Rows (or files) that hold at least one encrypted value. */
  rows: number;
  /** Encrypted values found. */
  values: number;
  /** Values per key id BEFORE this run. */
  byKeyId: Record<string, number>;
  /** Values written with a key other than the current one. */
  stale: number;
  reencrypted: number;
  failed: number;
  /** Row ids (never values) of the first failures, with the reason. */
  failures: string[];
}
export interface ReencryptOptions {
  dryRun: boolean;
  batchSize: number;
}
export interface EncryptedStore {
  name: string;
  what: string;
  run(db: PrismaClient, opts: ReencryptOptions): Promise<StoreReport>;
}

const emptyReport = (store: string): StoreReport => ({ store, rows: 0, values: 0, byKeyId: {}, stale: 0, reencrypted: 0, failed: 0, failures: [] });
const UUID_ZERO = '00000000-0000-0000-0000-000000000000';

/** Re-encrypts every envelope found under one of `keys` anywhere inside a JSON value. Returns the new value and what happened. */
export function reencryptInside(value: unknown, keys: string[], current: string, tally: { values: number; stale: number; byKeyId: Record<string, number> }, dryRun: boolean): unknown {
  if (Array.isArray(value)) return value.map((v) => reencryptInside(v, keys, current, tally, dryRun));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const id = keys.includes(k) && typeof v === 'string' ? envelopeKeyId(v) : null;
      if (id) {
        tally.values += 1;
        tally.byKeyId[id] = (tally.byKeyId[id] ?? 0) + 1;
        if (id !== current) {
          tally.stale += 1;
          out[k] = dryRun ? v : reencryptText(v as string);
          continue;
        }
        out[k] = v;
      } else out[k] = reencryptInside(v, keys, current, tally, dryRun);
    }
    return out;
  }
  return value;
}

/**
 * One generic pass for a column: walk all rows that hold ciphertext in id order, in batches; rewrite the stale
 * ones. The UPDATE is conditional on the value that was read, so a row that changed in the meantime is left
 * alone (it was just written with the current key anyway) and running twice is harmless.
 */
function columnStore(def: { name: string; what: string; table: string; column: string; json?: { keys: string[] } }): EncryptedStore {
  const table = `"${def.table}"`;
  const column = `"${def.column}"`;
  return {
    name: def.name,
    what: def.what,
    async run(db, opts) {
      const report = emptyReport(def.name);
      const current = currentKeyId();
      let last = UUID_ZERO;
      for (;;) {
        const filter = def.json ? `${column} IS NOT NULL AND (${def.json.keys.map((k) => `${column}::text LIKE '%"${k}"%'`).join(' OR ')})` : `${column} IS NOT NULL`;
        const rows = await db.$queryRawUnsafe<Array<{ id: string; value: unknown }>>(
          `SELECT "id"::text AS id, ${column} AS value FROM ${table} WHERE ${filter} AND "id" > $1::uuid ORDER BY "id" LIMIT $2`,
          last,
          opts.batchSize,
        );
        if (!rows.length) break;
        last = rows[rows.length - 1].id;
        for (const row of rows) {
          const tally = { values: 0, stale: 0, byKeyId: {} as Record<string, number> };
          let next: unknown;
          try {
            if (def.json) next = reencryptInside(row.value, def.json.keys, current, tally, opts.dryRun);
            else {
              const id = typeof row.value === 'string' ? envelopeKeyId(row.value) : null;
              if (!id) throw new Error('not a ciphertext of this application');
              tally.values = 1;
              tally.byKeyId[id] = 1;
              if (id !== current) {
                tally.stale = 1;
                next = opts.dryRun ? row.value : reencryptText(row.value as string);
              }
            }
          } catch (e: any) {
            report.rows += 1;
            report.failed += 1;
            if (report.failures.length < 20) report.failures.push(`${def.table} ${row.id}: ${e?.name === 'UnknownEncryptionKey' ? `encrypted with key "${e.keyId}", which is not configured` : 'could not be decrypted (wrong key for this id, or damaged data)'}`);
            continue;
          }
          if (!tally.values) continue;
          report.rows += 1;
          report.values += tally.values;
          for (const [id, n] of Object.entries(tally.byKeyId)) report.byKeyId[id] = (report.byKeyId[id] ?? 0) + n;
          report.stale += tally.stale;
          if (!tally.stale || opts.dryRun) continue;
          const changed = def.json
            ? await db.$executeRawUnsafe(`UPDATE ${table} SET ${column} = $1::jsonb WHERE "id" = $2::uuid AND ${column} = $3::jsonb`, JSON.stringify(next), row.id, JSON.stringify(row.value))
            : await db.$executeRawUnsafe(`UPDATE ${table} SET ${column} = $1 WHERE "id" = $2::uuid AND ${column} = $3`, next as string, row.id, row.value as string);
          // 0 rows: somebody changed the value after it was read; whatever they wrote used the current key.
          if (changed === 1) report.reencrypted += tally.stale;
        }
      }
      return report;
    },
  };
}

export const STORES: EncryptedStore[] = [
  columnStore({ name: 'users.mfaSecretEnc', what: 'Authenticator (TOTP) secrets of users with two-step verification', table: 'users', column: 'mfaSecretEnc' }),
  columnStore({ name: 'customers.emiratesIdEnc', what: 'Emirates ID numbers of customers', table: 'customers', column: 'emiratesIdEnc' }),
  columnStore({ name: 'customers.passportNoEnc', what: 'Passport numbers of customers', table: 'customers', column: 'passportNoEnc' }),
  columnStore({ name: 'staff_pay.ibanEnc', what: 'Salary IBANs of staff (payroll)', table: 'staff_pay', column: 'ibanEnc' }),
  columnStore({ name: 'integrations.secretsEnc', what: 'Credentials of integrations (payment gateways, SMTP, SMS, WhatsApp, OCR, n8n ...)', table: 'integration_credentials_metadata', column: 'secretsEnc' }),
  columnStore({ name: 'notifications.data.secure', what: 'Rendered message text of notifications waiting for or kept after delivery', table: 'notifications', column: 'data', json: { keys: ['secure'] } }),
  columnStore({ name: 'ocr_extraction_results.fields', what: 'Identity numbers read from documents by OCR', table: 'ocr_extraction_results', column: 'fields', json: { keys: ['valueEnc'] } }),
  columnStore({ name: 'ocr_extraction_results.reviewedFields', what: 'Identity numbers confirmed or corrected by a reviewer', table: 'ocr_extraction_results', column: 'reviewedFields', json: { keys: ['valueEnc'] } }),
];
/** Files of the local storage driver are a store too; the CLI handles it through the driver (STORAGE_DRIVER=local only). */
export const LOCAL_FILES_STORE = 'storage.local-files';

/**
 * Every source file that ENCRYPTS, and where its ciphertext ends up. `stores` must name entries of STORES (or
 * LOCAL_FILES_STORE); `transient` explains ciphertext that is not kept: it must be short-lived enough that
 * keeping the old key configured for the stated time covers it.
 */
export const ENCRYPTION_USES: Record<string, { stores?: string[]; transient?: string }> = {
  'modules/auth/auth.service.ts': { stores: ['users.mfaSecretEnc'] },
  'modules/customers/customer-view.ts': { stores: ['customers.emiratesIdEnc', 'customers.passportNoEnc'] },
  'modules/payroll/payroll.service.ts': { stores: ['staff_pay.ibanEnc'] },
  'modules/ocr/ocr.service.ts': { stores: ['customers.emiratesIdEnc', 'customers.passportNoEnc', 'ocr_extraction_results.fields', 'ocr_extraction_results.reviewedFields'] },
  'modules/integrations/integrations.service.ts': { stores: ['integrations.secretsEnc'] },
  'modules/notifications/notification.service.ts': { stores: ['notifications.data.secure'] },
  'modules/notifications/delivery.service.ts': { transient: 'Payload of the queued job "notifications.direct" (account emails / SMS). Lives until the job ran: minutes, at most the retry window of the queue (24 hours).' },
  'modules/storage/local.driver.ts': { stores: [LOCAL_FILES_STORE], transient: 'Upload / download tickets inside signed URLs. They expire within minutes (at most 1 hour).' },
  // Test fixtures write the same columns as the services above.
  'modules/finance/fixtures.ts': { stores: ['integrations.secretsEnc'] },
  'modules/notifications/fixtures.ts': { stores: ['integrations.secretsEnc'] },
};
/** How long an old key must stay in DATA_ENCRYPTION_OLD_KEYS after a clean re-encryption run, because of the transient uses above. */
export const OLD_KEY_GRACE_HOURS = 24;

export async function reencryptDatabase(db: PrismaClient, opts: ReencryptOptions & { only?: string[] }): Promise<StoreReport[]> {
  const reports: StoreReport[] = [];
  for (const store of STORES) {
    if (opts.only?.length && !opts.only.includes(store.name)) continue;
    reports.push(await store.run(db, opts));
  }
  return reports;
}
