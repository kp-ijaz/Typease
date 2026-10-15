/**
 * TypEase migration runner.
 *
 *   tsx scripts/migrate.ts            apply pending migrations, then sync role passwords
 *   tsx scripts/migrate.ts --status   list applied / pending migrations
 *   tsx scripts/migrate.ts --reset    DROP everything and re-apply (refused in production)
 *
 * Connects with DATABASE_MIGRATION_URL (the schema owner). Each file runs in
 * its own transaction and is recorded with a SHA-256 checksum; a changed
 * checksum on an applied file aborts the run.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const APP_ROLE = 'typease_app';
const SYSTEM_ROLE = 'typease_system';

function roleFromUrl(url: string | undefined, expected: string): { password: string } | null {
  if (!url) return null;
  const u = new URL(url);
  const user = decodeURIComponent(u.username);
  if (user !== expected) {
    throw new Error(`Connection user "${user}" must be "${expected}" (see docs/TENANT_ISOLATION.md).`);
  }
  return { password: decodeURIComponent(u.password) };
}

async function main() {
  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url) throw new Error('DATABASE_MIGRATION_URL is not set');
  const args = new Set(process.argv.slice(2));
  const client = new Client({ connectionString: url, options: '-c timezone=UTC' });
  await client.connect();
  try {
    if (args.has('--reset')) {
      if (process.env.NODE_ENV === 'production' || process.env.ALLOW_DB_RESET !== 'true') {
        throw new Error('Refusing to reset: set ALLOW_DB_RESET=true and never run this in production.');
      }
      await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      console.log('Schema dropped.');
    }
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Map<string, string>(
      (await client.query('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [r.name, r.checksum]),
    );
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f))
      .sort();

    if (args.has('--status')) {
      for (const f of files) console.log(`${applied.has(f) ? 'applied ' : 'PENDING '} ${f}`);
      return;
    }

    for (const f of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prev = applied.get(f);
      if (prev) {
        if (prev !== checksum) throw new Error(`Migration ${f} was modified after it was applied.`);
        continue;
      }
      process.stdout.write(`Applying ${f} ... `);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [f, checksum]);
        await client.query('COMMIT');
        console.log('ok');
      } catch (e) {
        await client.query('ROLLBACK');
        console.log('FAILED');
        throw e;
      }
    }

    // Login credentials for the two runtime roles come from the environment,
    // so no password ever lives in a migration file.
    for (const [role, envUrl] of [
      [APP_ROLE, process.env.DATABASE_URL],
      [SYSTEM_ROLE, process.env.DATABASE_SYSTEM_URL],
    ] as const) {
      const cred = roleFromUrl(envUrl, role);
      if (!cred) {
        console.warn(`! ${role}: no connection URL configured, role left without login.`);
        continue;
      }
      if (!cred.password) throw new Error(`${role}: a password is required.`);
      const literal = (await client.query('SELECT quote_literal($1) AS q', [cred.password])).rows[0].q;
      await client.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD ${literal}`);
      // All application sessions run in UTC (see services/api/src/common/db/prisma.service.ts).
      await client.query(`ALTER ROLE ${role} SET timezone = 'UTC'`);
      const attrs = (await client.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1', [role])).rows[0];
      if (attrs.rolsuper || (role === APP_ROLE && attrs.rolbypassrls)) {
        throw new Error(`${role} must not be SUPERUSER or BYPASSRLS: tenant isolation would not be enforced.`);
      }
    }
    console.log('Database is up to date.');
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
