import { TestApp } from '../../services/api/test/helpers';

/**
 * Database-level evidence for the security suite. These are the places where the
 * suite reads the database directly, and each one proves something no API
 * response can prove:
 *
 *  - `fingerprint`: that NOTHING of a centre changed while another centre
 *    attacked it (every row of every tenant-owned table, hashed);
 *  - `crossTenantReferences`: that no row of one centre points at a row of
 *    another centre, anywhere;
 *  - `asAppRole`: what the `typease_app` database role (the one the API uses
 *    for tenant data) can see and do when the application forgets to say which
 *    tenant it is working for.
 */

/** Every table that has a "tenantId" column (the tenant-owned tables). */
export async function tenantTables(t: TestApp): Promise<string[]> {
  const rows = await t.sys.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT c.relname AS name FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE a.attname = 'tenantId' AND c.relkind = 'r' AND NOT a.attisdropped AND n.nspname = 'public' ORDER BY 1`,
  );
  return rows.map((r) => r.name);
}

export type Fingerprint = Record<string, string>;

/**
 * Number of rows and a hash over the full content of every row a centre owns,
 * per table - plus the centre's own row and the accounts of its members.
 * Two fingerprints are equal exactly when no row was added, removed or changed.
 * `except`: tables that legitimately move without anybody touching the centre.
 */
export async function fingerprint(t: TestApp, tenantId: string, except: string[] = []): Promise<Fingerprint> {
  const out: Fingerprint = {};
  for (const table of await tenantTables(t)) {
    if (except.includes(table)) continue;
    const rows = await t.sys.$queryRawUnsafe<Array<{ n: number; h: string | null }>>(
      `SELECT count(*)::int AS n, md5(coalesce(string_agg(md5(x::text), '' ORDER BY md5(x::text)), '')) AS h FROM "${table}" x WHERE x."tenantId" = $1::uuid`,
      tenantId,
    );
    out[table] = `${rows[0].n} rows ${rows[0].h}`;
  }
  const tenant = await t.sys.$queryRawUnsafe<Array<{ h: string }>>(`SELECT md5(x::text) AS h FROM "tenants" x WHERE x.id = $1::uuid`, tenantId);
  out['tenants (own row)'] = tenant[0]?.h ?? 'missing';
  // Accounts of the centre's members, without the columns every sign-in moves.
  const users = await t.sys.$queryRawUnsafe<Array<{ n: number; h: string }>>(
    `SELECT count(*)::int AS n, md5(coalesce(string_agg(md5(concat_ws('|', u.id, u.email, u.phone, u."fullName", u.status, u."passwordHash", u."mfaEnabled", u."platformRole", u."deletedAt")), '' ORDER BY u.id), '')) AS h
     FROM "users" u WHERE EXISTS (SELECT 1 FROM "tenant_memberships" m WHERE m."userId" = u.id AND m."tenantId" = $1::uuid)`,
    tenantId,
  );
  out['users (members)'] = `${users[0].n} rows ${users[0].h}`;
  return out;
}

/** The tables in which two fingerprints differ (empty = identical). */
export function changedTables(before: Fingerprint, after: Fingerprint): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k]).map((k) => `${k}: ${before[k]} -> ${after[k]}`);
}

/**
 * Rows whose foreign key points at a row of ANOTHER tenant, over every
 * single-column foreign key between two tenant-owned tables. Must be empty.
 */
export async function crossTenantReferences(t: TestApp): Promise<string[]> {
  const fks = await t.sys.$queryRawUnsafe<Array<{ child: string; col: string; parent: string; pcol: string }>>(
    `SELECT c.relname AS child, a.attname AS col, p.relname AS parent, pa.attname AS pcol
     FROM pg_constraint con
     JOIN pg_class c ON c.oid = con.conrelid JOIN pg_class p ON p.oid = con.confrelid
     JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
     JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = con.confkey[1]
     WHERE con.contype = 'f' AND array_length(con.conkey, 1) = 1 AND p.relname <> 'tenants'
       AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = con.conrelid AND x.attname = 'tenantId' AND NOT x.attisdropped)
       AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = con.confrelid AND x.attname = 'tenantId' AND NOT x.attisdropped)
     ORDER BY 1, 2`,
  );
  const offenders: string[] = [];
  for (const fk of fks) {
    const rows = await t.sys.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM "${fk.child}" c JOIN "${fk.parent}" p ON p."${fk.pcol}" = c."${fk.col}" WHERE c."tenantId" IS DISTINCT FROM p."tenantId" AND p."tenantId" IS NOT NULL`,
    );
    if (rows[0].n > 0) offenders.push(`${fk.child}.${fk.col} -> ${fk.parent}: ${rows[0].n} row(s)`);
  }
  if (fks.length < 100) throw new Error(`Only ${fks.length} foreign keys between tenant tables were found - the catalogue query is wrong.`);
  return offenders;
}

export interface AppRole {
  /** One statement on the `typease_app` connection, outside any transaction: no tenant is bound. */
  query<T = any>(sql: string, ...params: unknown[]): Promise<T[]>;
  /** Statements in one transaction with `app.tenant_id` bound the way the API binds it (set_config, transaction-local). */
  inTenant<T>(tenantId: string, fn: (q: <R = any>(sql: string, ...params: unknown[]) => Promise<R[]>) => Promise<T>): Promise<T>;
  /** Statements in one transaction WITHOUT a tenant (for statements that need a transaction, e.g. SET LOCAL attempts). */
  inTransaction<T>(fn: (q: <R = any>(sql: string, ...params: unknown[]) => Promise<R[]>) => Promise<T>): Promise<T>;
}

/**
 * Raw SQL on the API's own tenant connection pool (database role `typease_app`,
 * DATABASE_URL) - the connection a forgotten `where tenantId` or an injected
 * statement would run on.
 */
export function asAppRole(t: TestApp): AppRole {
  const client = t.db.client;
  return {
    query: (sql, ...params) => client.$queryRawUnsafe(sql, ...params) as Promise<any[]>,
    inTenant: (tenantId, fn) =>
      client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', $1, true)`, tenantId);
        return fn((sql, ...params) => tx.$queryRawUnsafe(sql, ...params) as Promise<any[]>);
      }),
    inTransaction: (fn) => client.$transaction(async (tx) => fn((sql, ...params) => tx.$queryRawUnsafe(sql, ...params) as Promise<any[]>)),
  };
}

/** The message of whatever a database statement threw (the driver wraps the PostgreSQL error several layers deep). */
export async function sqlError(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (e: any) {
    return `${e?.message ?? ''} ${e?.meta?.message ?? ''} ${e?.meta?.driverAdapterError?.cause?.originalMessage ?? ''} ${e?.cause?.message ?? ''}`.trim() || String(e);
  }
}
