/**
 * Generates PostgreSQL DDL from prisma/schema.prisma.
 *
 *   pnpm --filter @typease/database sql:generate            -> prints baseline DDL + security SQL
 *   pnpm --filter @typease/database sql:generate -- --write -> (re)writes migrations 0001 and 0002
 *
 * Only use --write before the first production deployment. After that, every
 * schema change must be a NEW numbered migration file (see docs/DATABASE_SCHEMA.md).
 *
 * Naming follows Prisma conventions (<table>_pkey, <table>_<cols>_key,
 * <table>_<cols>_idx, <table>_<col>_fkey) so `prisma db pull` round-trips.
 */
import { getDMMF } from '@prisma/internals';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RLS } from './rls-config';

type Field = any;
type Model = any;

const q = (s: string) => `"${s}"`;
const name63 = (s: string) => (s.length <= 63 ? s : s.slice(0, 63));

function sqlType(f: Field): string {
  let t: string;
  const [native, args] = f.nativeType ?? [];
  if (f.kind === 'enum') t = q(f.type);
  else {
    switch (f.type) {
      case 'String':
        t = native === 'Uuid' ? 'UUID' : 'TEXT';
        break;
      case 'Int':
        t = 'INTEGER';
        break;
      case 'BigInt':
        t = 'BIGINT';
        break;
      case 'Boolean':
        t = 'BOOLEAN';
        break;
      case 'Decimal':
        t = native === 'Decimal' ? `DECIMAL(${args.join(',')})` : 'DECIMAL(65,30)';
        break;
      case 'DateTime':
        t = native === 'Date' ? 'DATE' : native === 'Timestamptz' ? `TIMESTAMPTZ(${args[0] ?? 3})` : 'TIMESTAMP(3)';
        break;
      case 'Json':
        t = 'JSONB';
        break;
      default:
        throw new Error(`Unsupported type ${f.type} on ${f.name}`);
    }
  }
  return f.isList ? `${t}[]` : t;
}

function sqlDefault(f: Field): string | null {
  if (f.isUpdatedAt) return 'CURRENT_TIMESTAMP';
  if (!f.hasDefaultValue) return null;
  const d = f.default;
  if (d && typeof d === 'object' && !Array.isArray(d)) {
    if (d.name === 'uuid') return 'gen_random_uuid()';
    if (d.name === 'now') return 'CURRENT_TIMESTAMP';
    throw new Error(`Unsupported default fn ${d.name} on ${f.name}`);
  }
  if (Array.isArray(d)) {
    const base = sqlType({ ...f, isList: false });
    if (d.length === 0) return `ARRAY[]::${base}[]`;
    return `ARRAY[${d.map((v: any) => (typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : v)).join(', ')}]::${base}[]`;
  }
  if (f.kind === 'enum') return `'${d}'`;
  if (f.type === 'Json') return `'${String(d).replace(/'/g, "''")}'`;
  if (typeof d === 'string') return `'${d.replace(/'/g, "''")}'`;
  return String(d);
}

async function main() {
  const schemaPath = join(__dirname, '..', 'prisma', 'schema.prisma');
  const dmmf = await getDMMF({ datamodel: readFileSync(schemaPath, 'utf8') });
  const models: Model[] = dmmf.datamodel.models as any;
  const enums = dmmf.datamodel.enums;
  const indexes: any[] = (dmmf.datamodel as any).indexes ?? [];
  const table = (m: Model) => m.dbName ?? m.name;
  const byName = new Map(models.map((m) => [m.name, m]));
  const col = (m: Model, fieldName: string) => {
    const f = m.fields.find((x: Field) => x.name === fieldName);
    return f?.dbName ?? fieldName;
  };

  const ddl: string[] = [];
  ddl.push('-- TypEase baseline schema. Generated from prisma/schema.prisma by scripts/prisma-to-sql.ts.');
  ddl.push('-- Do not edit after first deployment: add a new numbered migration instead.\n');
  ddl.push('CREATE EXTENSION IF NOT EXISTS pgcrypto;\n');

  for (const e of enums) {
    ddl.push(`CREATE TYPE ${q(e.name)} AS ENUM (${e.values.map((v: any) => `'${v.name}'`).join(', ')});`);
  }
  ddl.push('');

  for (const m of models) {
    const lines: string[] = [];
    for (const f of m.fields) {
      if (f.kind === 'object') continue;
      const def = sqlDefault(f);
      const notNull = f.isRequired || f.isList ? ' NOT NULL' : '';
      lines.push(`  ${q(f.dbName ?? f.name)} ${sqlType(f)}${notNull}${def !== null ? ` DEFAULT ${def}` : ''}`);
    }
    const pkFields = m.primaryKey?.fields ?? m.fields.filter((f: Field) => f.isId).map((f: Field) => f.name);
    lines.push(`  CONSTRAINT ${q(name63(`${table(m)}_pkey`))} PRIMARY KEY (${pkFields.map((n: string) => q(col(m, n))).join(', ')})`);
    ddl.push(`CREATE TABLE ${q(table(m))} (\n${lines.join(',\n')}\n);\n`);
  }

  for (const ix of indexes) {
    if (ix.type === 'id') continue;
    const m = byName.get(ix.model)!;
    const cols = ix.fields.map((f: any) => col(m, f.name));
    const suffix = ix.type === 'unique' ? 'key' : 'idx';
    const nm = ix.dbName ?? name63(`${table(m)}_${cols.join('_')}_${suffix}`);
    ddl.push(
      `CREATE ${ix.type === 'unique' ? 'UNIQUE ' : ''}INDEX ${q(nm)} ON ${q(table(m))}(${cols.map(q).join(', ')});`,
    );
  }
  ddl.push('');

  const tenantFks = new Map<string, Array<[string, string]>>();
  for (const m of models) {
    for (const f of m.fields) {
      if (f.kind !== 'object' || !f.relationFromFields?.length) continue;
      const target = byName.get(f.type)!;
      const from = f.relationFromFields.map((n: string) => col(m, n));
      const to = f.relationToFields.map((n: string) => col(target, n));
      const scalar = m.fields.find((x: Field) => x.name === f.relationFromFields[0]);
      const onDelete = (f.relationOnDelete ?? (scalar.isRequired ? 'Restrict' : 'SetNull'))
        .replace('SetNull', 'SET NULL')
        .replace('NoAction', 'NO ACTION')
        .toUpperCase();
      ddl.push(
        `ALTER TABLE ${q(table(m))} ADD CONSTRAINT ${q(name63(`${table(m)}_${from.join('_')}_fkey`))} FOREIGN KEY (${from
          .map(q)
          .join(', ')}) REFERENCES ${q(table(target))}(${to.map(q).join(', ')}) ON DELETE ${onDelete} ON UPDATE CASCADE;`,
      );
      const childHasTenant = m.fields.some((x: Field) => x.name === 'tenantId');
      const parentHasTenant = target.fields.some((x: Field) => x.name === 'tenantId');
      if (childHasTenant && parentHasTenant && from.length === 1 && target.name !== 'Tenant') {
        const list = tenantFks.get(table(m)) ?? [];
        list.push([from[0], table(target)]);
        tenantFks.set(table(m), list);
      }
    }
  }

  // ---------------------------------------------------------------- security
  const sec: string[] = [];
  sec.push('-- TypEase tenant isolation: database roles, grants, row-level security and');
  sec.push('-- cross-tenant reference guards. Generated by scripts/prisma-to-sql.ts.\n');
  sec.push(`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RLS.appRole}') THEN CREATE ROLE ${RLS.appRole} NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RLS.systemRole}') THEN CREATE ROLE ${RLS.systemRole} NOLOGIN; END IF;
END $$;\n`);
  sec.push(`-- Tenant / user context is set per transaction by the API (SET LOCAL via set_config).
CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;\n`);
  sec.push(`-- Blocks a row in tenant A from pointing at a row of tenant B through a foreign key.
-- SECURITY DEFINER so the lookup is not hidden by RLS.
CREATE OR REPLACE FUNCTION assert_same_tenant() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  i int := 0;
  ref uuid;
  parent_tenant uuid;
  row_json jsonb := to_jsonb(NEW);
BEGIN
  WHILE i < TG_NARGS LOOP
    ref := (row_json ->> TG_ARGV[i])::uuid;
    IF ref IS NOT NULL THEN
      EXECUTE format('SELECT "tenantId" FROM %I WHERE id = $1', TG_ARGV[i + 1]) INTO parent_tenant USING ref;
      IF parent_tenant IS NOT NULL AND parent_tenant IS DISTINCT FROM (row_json ->> 'tenantId')::uuid THEN
        RAISE EXCEPTION 'cross-tenant reference blocked: %.% -> %', TG_TABLE_NAME, TG_ARGV[i], TG_ARGV[i + 1]
          USING ERRCODE = '23514';
      END IF;
    END IF;
    i := i + 2;
  END LOOP;
  RETURN NEW;
END $$;\n`);

  sec.push(`GRANT USAGE ON SCHEMA public TO ${RLS.appRole}, ${RLS.systemRole};`);
  sec.push(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${RLS.appRole}, ${RLS.systemRole};\n`);

  for (const m of models) {
    const t = table(m);
    const hasTenant = m.fields.some((f: Field) => f.name === 'tenantId');
    sec.push(`-- ${t}`);
    sec.push(`ALTER TABLE ${q(t)} ENABLE ROW LEVEL SECURITY;`);
    sec.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${q(t)} TO ${RLS.systemRole};`);
    sec.push(`CREATE POLICY system_access ON ${q(t)} FOR ALL TO ${RLS.systemRole} USING (true) WITH CHECK (true);`);

    if (RLS.systemOnly.includes(t)) {
      sec.push('');
      continue;
    }
    if (t === 'users') {
      sec.push(`GRANT SELECT (${RLS.userSafeColumns.map(q).join(', ')}) ON "users" TO ${RLS.appRole};`);
      sec.push(
        `CREATE POLICY tenant_visible ON "users" FOR SELECT TO ${RLS.appRole} USING (id = app_user_id() OR EXISTS (SELECT 1 FROM "tenant_memberships" m WHERE m."userId" = "users".id AND m."tenantId" = app_tenant_id()));`,
      );
      sec.push('');
      continue;
    }
    if (t === 'tenants') {
      sec.push(`GRANT SELECT ON "tenants" TO ${RLS.appRole};`);
      sec.push(`GRANT UPDATE (${RLS.tenantSelfUpdatableColumns.map(q).join(', ')}) ON "tenants" TO ${RLS.appRole};`);
      sec.push(
        `CREATE POLICY tenant_isolation ON "tenants" FOR ALL TO ${RLS.appRole} USING (id = app_tenant_id()) WITH CHECK (id = app_tenant_id());`,
      );
      sec.push('');
      continue;
    }
    if (!hasTenant) {
      // Global reference data: read-only for the tenant-scoped role.
      if (RLS.globalReadable.includes(t)) {
        sec.push(`GRANT SELECT ON ${q(t)} TO ${RLS.appRole};`);
        sec.push(`CREATE POLICY global_read ON ${q(t)} FOR SELECT TO ${RLS.appRole} USING (true);`);
      } else {
        throw new Error(`Table ${t} has no tenantId and is not classified in rls-config.ts`);
      }
      sec.push('');
      continue;
    }
    const grant = RLS.grants[t] ?? (RLS.appendOnly.includes(t) ? 'SELECT, INSERT' : 'SELECT, INSERT, UPDATE, DELETE');
    sec.push(`GRANT ${grant} ON ${q(t)} TO ${RLS.appRole};`);
    sec.push(
      `CREATE POLICY tenant_isolation ON ${q(t)} FOR ALL TO ${RLS.appRole} USING ("tenantId" = app_tenant_id()) WITH CHECK ("tenantId" = app_tenant_id());`,
    );
    if (RLS.sharedReadable.includes(t)) {
      sec.push(`CREATE POLICY shared_read ON ${q(t)} FOR SELECT TO ${RLS.appRole} USING ("tenantId" IS NULL);`);
    }
    const pairs = tenantFks.get(t);
    if (pairs?.length) {
      const args = pairs.map(([c, p]) => `'${c}', '${p}'`).join(', ');
      sec.push(
        `CREATE TRIGGER same_tenant_guard BEFORE INSERT OR UPDATE ON ${q(t)} FOR EACH ROW EXECUTE FUNCTION assert_same_tenant(${args});`,
      );
    }
    sec.push('');
  }

  const out1 = ddl.join('\n') + '\n';
  const out2 = sec.join('\n') + '\n';
  if (process.argv.includes('--write')) {
    writeFileSync(join(__dirname, '..', 'migrations', '0001_init.sql'), out1);
    writeFileSync(join(__dirname, '..', 'migrations', '0002_tenant_isolation.sql'), out2);
    console.log(`Wrote 0001_init.sql (${models.length} tables, ${enums.length} enums) and 0002_tenant_isolation.sql`);
  } else {
    process.stdout.write(out1 + '\n' + out2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
