import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { AuditService } from '../common/audit.service';
import { runAsSystem } from '../common/context';
import { currentKeyId } from '../common/crypto';
import { SystemDb } from '../common/db/prisma.service';
import { env, parseKeyring } from '../config/env';
import { StorageService } from '../modules/storage/storage.service';
import { LOCAL_FILES_STORE, OLD_KEY_GRACE_HOURS, reencryptDatabase, StoreReport, STORES } from './reencrypt-stores';

/**
 * Moves everything that is encrypted with DATA_ENCRYPTION_KEY to the CURRENT key
 * (the one named by DATA_ENCRYPTION_KEY_ID). Second step of a key rotation; the
 * whole procedure is in docs/deployment/secrets.md.
 *
 *   pnpm --filter @typease/api reencrypt -- --dry-run      # count only, change nothing
 *   pnpm --filter @typease/api reencrypt                   # re-encrypt, in batches
 *   pnpm --filter @typease/api reencrypt -- --batch 500 --only customers.emiratesIdEnc,customers.passportNoEnc
 *   pnpm --filter @typease/api reencrypt -- --skip-files   # database only (local storage driver)
 *   pnpm --filter @typease/api reencrypt -- --list         # what is covered
 *
 * Safe while the API is running, safe to interrupt, safe to repeat: every value
 * is replaced only if it still is what was read, and values that already use the
 * current key are skipped. It prints counts and row ids, never a value or a key.
 * Exit code 0 = nothing is left under an old key; 1 = something could not be
 * re-encrypted (keep the old keys configured and look at the listed rows).
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function printReport(reports: StoreReport[], dryRun: boolean) {
  const rows = reports.map((r) => ({
    store: r.store,
    rows: r.rows,
    values: r.values,
    'by key (before)': Object.entries(r.byKeyId).map(([k, n]) => `${k}: ${n}`).join(', ') || '-',
    'old key': r.stale,
    [dryRun ? 'would re-encrypt' : 're-encrypted']: dryRun ? r.stale : r.reencrypted,
    failed: r.failed,
  }));
  console.table(rows);
  for (const r of reports) for (const f of r.failures) console.error(`  FAILED ${r.store}: ${f}`);
}

async function main() {
  if (flag('list')) {
    console.table([...STORES.map((s) => ({ store: s.name, what: s.what })), { store: LOCAL_FILES_STORE, what: 'Files of the local storage driver (STORAGE_DRIVER=local); S3 objects are encrypted by the object store' }]);
    return;
  }
  const dryRun = flag('dry-run');
  const batchSize = Math.min(5000, Math.max(1, Number(arg('batch') ?? 200) || 200));
  const only = (arg('only') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const known = [...STORES.map((s) => s.name), LOCAL_FILES_STORE];
  const unknown = only.filter((o) => !known.includes(o));
  if (unknown.length) {
    console.error(`Unknown store(s): ${unknown.join(', ')}. Known: ${known.join(', ')}`);
    process.exit(2);
  }
  const ring = parseKeyring(env());
  console.log(`Current key: "${ring.current.id}". Keys that can still decrypt: ${[...ring.all.keys()].filter((k) => k !== ring.current.id).map((k) => `"${k}"`).join(', ') || 'none'}.${dryRun ? ' DRY RUN: nothing is changed.' : ''}`);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  let failed = 0;
  let stale = 0;
  let done = 0;
  try {
    const reports = await reencryptDatabase(app.get(SystemDb).client, { dryRun, batchSize, only });
    const local = app.get(StorageService).local;
    if (!flag('skip-files') && (!only.length || only.includes(LOCAL_FILES_STORE))) {
      if (local) {
        const files = await local.reencryptAll({ dryRun });
        reports.push({ store: LOCAL_FILES_STORE, rows: files.scanned, values: files.scanned, byKeyId: files.byKeyId, stale: files.stale, reencrypted: files.reencrypted, failed: files.failed, failures: files.failures });
      } else console.log(`${LOCAL_FILES_STORE}: skipped (STORAGE_DRIVER=${env().STORAGE_DRIVER}: objects are encrypted by the object store, not with DATA_ENCRYPTION_KEY).`);
    }
    printReport(reports, dryRun);
    failed = reports.reduce((n, r) => n + r.failed, 0);
    stale = reports.reduce((n, r) => n + r.stale, 0);
    done = reports.reduce((n, r) => n + r.reencrypted, 0);
    if (!dryRun) {
      await runAsSystem(
        () =>
          app.get(AuditService).logSystem({
            action: 'platform.encryption.reencrypted',
            resourceType: 'EncryptionKey',
            summary: `Re-encryption to key "${currentKeyId()}": ${done} value(s) moved, ${failed} failed`,
            after: { currentKeyId: currentKeyId(), stores: Object.fromEntries(reports.map((r) => [r.store, { values: r.values, stale: r.stale, reencrypted: r.reencrypted, failed: r.failed }])) },
          }),
        { actorLabel: 'cli:reencrypt' },
      );
    }
  } finally {
    await app.close();
  }
  if (failed) {
    console.error(`\n${failed} value(s) could not be re-encrypted. Keep every old key configured and investigate the rows listed above.`);
    process.exit(1);
  }
  if (dryRun) console.log(stale ? `\n${stale} value(s) are under an old key. Run again without --dry-run to move them.` : '\nNothing is under an old key.');
  else if (only.length || flag('skip-files')) console.log(`\n${done} value(s) moved. This was a partial run: run once more without --only / --skip-files before retiring an old key.`);
  else console.log(`\n${done} value(s) moved; nothing is left under an old key. Keep the old key(s) in DATA_ENCRYPTION_OLD_KEYS for another ${OLD_KEY_GRACE_HOURS} hours (queued messages and open links), then remove them and restart.`);
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
