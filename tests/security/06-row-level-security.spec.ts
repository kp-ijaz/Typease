import { api, AppRole, asAppRole, changedTables, fingerprint, populate, sqlError, tenantTables, TestApp, World } from '../support';

/**
 * The last line of defence of scenario 24: PostgreSQL row-level security.
 *
 * The API reads and writes tenant data on a connection of the database role
 * `typease_app` and binds the tenant at the start of every transaction
 * (`set_config('app.tenant_id', ..., true)`). These tests talk raw SQL on that
 * very connection pool - what a query with a forgotten `where tenantId` would
 * do - and check what the database itself allows:
 *
 *   - with NO tenant bound: not one tenant row is visible, nothing can be
 *     written, in any tenant-owned table;
 *   - with tenant A bound: only A's rows, no way to read, change, delete or
 *     point at a row of B, and no way to move a row to B;
 *   - the role itself cannot switch row-level security off or become another role.
 *
 * What row-level security does NOT do: stop somebody who can run arbitrary SQL
 * as `typease_app` from binding another tenant - binding the tenant is the
 * application's job (tests/security/01 covers that side over HTTP).
 */
describe('Row-level security (raw SQL as typease_app)', () => {
  let t: TestApp;
  let a: World;
  let b: World;
  let app: AppRole;
  let tables: string[];
  /** What the role may do per table, from the database catalogue. */
  let grants: Record<string, Set<string>>;

  const quoted = (name: string) => `"${name}"`;
  /** Rolls the transaction back whatever happened inside, and returns what `fn` returned. */
  async function rolledBack<T>(run: (fn: (q: any) => Promise<never>) => Promise<unknown>, body: (q: any) => Promise<T>): Promise<T> {
    let out: T | undefined;
    const marker = new Error('rollback');
    await run(async (q) => {
      out = await body(q);
      throw marker;
    }).catch((e) => {
      if (e !== marker) throw e;
    });
    return out as T;
  }

  beforeAll(async () => {
    t = await TestApp.create();
    const support = await t.createPlatformAdmin('SUPPORT_AGENT');
    a = await populate(t, 'Alpha', support);
    b = await populate(t, 'Beta', support);
    await t.settle(10);
    app = asAppRole(t);
    tables = await tenantTables(t);
    // What the role may do, table by table (a privilege on single columns counts: "users" and "tenants" are granted that way).
    const rows = await t.sys.$queryRawUnsafe<Array<{ name: string; s: boolean; i: boolean; u: boolean; d: boolean }>>(
      `SELECT c.relname AS name,
              has_any_column_privilege('typease_app', c.oid, 'SELECT') AS s, has_any_column_privilege('typease_app', c.oid, 'INSERT') AS i,
              has_any_column_privilege('typease_app', c.oid, 'UPDATE') AS u, has_table_privilege('typease_app', c.oid, 'DELETE') AS d
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'`,
    );
    grants = {};
    for (const r of rows) {
      const held = [r.s && 'SELECT', r.i && 'INSERT', r.u && 'UPDATE', r.d && 'DELETE'].filter(Boolean) as string[];
      if (held.length) grants[r.name] = new Set(held);
    }
    expect(Object.keys(grants).length).toBeGreaterThan(90);
  }, 300_000);
  afterAll(() => t.close());

  it('S24 database: the connection the API uses for tenant data is an ordinary role: no superuser, no bypass, no way to become one', async () => {
    const [role] = await app.query(`SELECT current_user::text AS name, session_user::text AS session, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication FROM pg_roles r WHERE r.rolname = current_user`);
    expect(role).toEqual({ name: 'typease_app', session: 'typease_app', rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false });
    // It owns nothing (an owner is not subject to row-level security unless it is forced) and is member of no other role.
    expect(await app.query(`SELECT c.relname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname = current_user`)).toEqual([]);
    expect(await app.query(`SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)`)).toEqual([]);

    // Attempts to get out of the cage. Each one must fail, and must fail because the database says no.
    const attempts: Array<[string, string, RegExp]> = [
      ['become the system role', `SET ROLE typease_system`, /permission denied/i],
      ['become the schema owner', `SET ROLE typease_owner`, /permission denied|does not exist/i],
      ['become the system role (session)', `SET SESSION AUTHORIZATION typease_system`, /permission denied/i],
      ['switch row-level security off for a table', `ALTER TABLE "customers" DISABLE ROW LEVEL SECURITY`, /must be owner/i],
      ['drop the policy', `DROP POLICY tenant_isolation ON "customers"`, /must be owner/i],
      ['add a policy of its own', `CREATE POLICY let_me_in ON "customers" FOR ALL TO typease_app USING (true)`, /must be owner/i],
      ['give itself the bypass', `ALTER ROLE typease_app BYPASSRLS`, /permission denied|must be superuser|must have/i],
      ['create a table', `CREATE TABLE "loot" (id int)`, /permission denied/i],
      ['replace the tenant function', `CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$`, /permission denied|must be owner/i],
      ['drop the cross-tenant guard', `DROP FUNCTION assert_same_tenant() CASCADE`, /must be owner/i],
      ['disable the triggers of a table', `ALTER TABLE "payments" DISABLE TRIGGER ALL`, /must be owner/i],
      ['disable triggers for the session', `SET session_replication_role = replica`, /permission denied/i],
      ['truncate a table', `TRUNCATE "audit_logs"`, /permission denied|must be owner/i],
      ['read password hashes', `SELECT "passwordHash" FROM "users" LIMIT 1`, /permission denied/i],
      ['read MFA secrets', `SELECT "mfaSecretEnc" FROM "users" LIMIT 1`, /permission denied/i],
      ['read sessions', `SELECT count(*) FROM "sessions"`, /permission denied/i],
      ['read one-time tokens', `SELECT count(*) FROM "auth_tokens"`, /permission denied/i],
      ['read the files of the server', `SELECT pg_read_file('/etc/passwd')`, /permission denied/i],
      ['run a program on the server', `COPY "customers" TO PROGRAM 'cat'`, /permission denied|must be superuser|pg_execute_server_program/i],
    ];
    for (const [what, sql, expected] of attempts) {
      const error = await sqlError(() => app.query(sql));
      expect([what, error === null ? 'IT WORKED' : expected.test(error) ? 'refused' : error]).toEqual([what, 'refused']);
    }
    // "SET row_security = off" is allowed for any role - and makes queries on protected tables FAIL instead of
    // returning unfiltered rows.
    const off = await sqlError(() =>
      app.inTransaction(async (q) => {
        await q(`SET LOCAL row_security = off`);
        return q(`SELECT count(*) FROM "customers"`);
      }),
    );
    expect(off).toMatch(/row-level security|row security/i);
    expect((await app.query(`SELECT current_user::text AS name`))[0].name).toBe('typease_app');
  });

  it('S24 database: every table the role can touch is protected by a row-level security policy', async () => {
    const protection = await t.sys.$queryRawUnsafe<Array<{ name: string; rls: boolean; policies: string | null; quals: string | null }>>(
      `SELECT c.relname AS name, c.relrowsecurity AS rls,
              (SELECT string_agg(p.policyname, ',') FROM pg_policies p WHERE p.tablename = c.relname AND 'typease_app' = ANY (p.roles)) AS policies,
              (SELECT string_agg(coalesce(p.qual, '') || ' ' || coalesce(p.with_check, ''), ' | ') FROM pg_policies p WHERE p.tablename = c.relname AND 'typease_app' = ANY (p.roles)) AS quals
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`,
    );
    const byName = Object.fromEntries(protection.map((p) => [p.name, p]));
    expect(tables.length).toBeGreaterThan(90);

    const unprotected: string[] = [];
    for (const table of Object.keys(grants)) {
      const p = byName[table];
      // Row-level security is on, and the role has a policy (without one it sees nothing at all, which is also safe).
      if (!p?.rls) unprotected.push(`${table}: row-level security is off`);
      // A table with a tenant column: the policy must compare it with the bound tenant.
      else if (tables.includes(table) && !(p.policies && /app_tenant_id\(\)/.test(p.quals ?? ''))) unprotected.push(`${table}: no policy on the tenant column (${p.policies ?? 'no policy'})`);
    }
    expect(unprotected).toEqual([]);
    // Every tenant-owned table has row-level security switched on, whether or not the role may use it.
    expect(tables.filter((name) => !byName[name].rls)).toEqual([]);

    // The tables WITHOUT a tenant column that the role can read are these, and nothing else. A new one is a
    // decision somebody has to take: is its content really the same for every centre?
    const shared = Object.keys(grants).filter((name) => !tables.includes(name)).sort();
    expect(shared).toEqual(['permissions', 'subscription_plans', 'tenants', 'users']);
    // ... and of those it may only read (tenants and users: selected columns; tenants: its own row).
    expect([...grants.permissions]).toEqual(['SELECT']);
    expect([...grants.subscription_plans]).toEqual(['SELECT']);
    expect([...grants.users]).toEqual(['SELECT']);
    expect([...grants.tenants].sort()).toEqual(['SELECT', 'UPDATE']);
    // What a centre must never write by itself, even inside its own tenant: its subscription and its bills.
    for (const table of ['subscriptions', 'subscription_invoices', 'subscription_events', 'feature_flags']) expect([table, [...(grants[table] ?? [])]]).toEqual([table, ['SELECT']]);
    for (const table of ['sessions', 'auth_tokens', 'login_activity', 'platform_settings', 'coupons']) expect([table, grants[table]]).toEqual([table, undefined]);
  });

  it('S24 database: without app.tenant_id the role sees no tenant rows and cannot write - in every tenant-owned table', async () => {
    const [before1, before2] = [await fingerprint(t, a.centre.id), await fingerprint(t, b.centre.id)];
    // The API returns a connection to the pool without a tenant on it: checked on more connections than the pool has.
    const leftovers = await Promise.all(Array.from({ length: 12 }, () => app.query(`SELECT coalesce(current_setting('app.tenant_id', true), '') AS tenant, coalesce(current_setting('app.user_id', true), '') AS "user"`)));
    expect(leftovers.map((r) => `${r[0].tenant}|${r[0].user}`)).toEqual(Array(12).fill('|'));

    const wrong: string[] = [];
    let populated = 0;
    let readable = 0;
    for (const table of tables) {
      const really = (await t.sys.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM ${quoted(table)} WHERE "tenantId" IS NOT NULL`))[0].n;
      if (really > 0) populated += 1;
      const can = grants[table] ?? new Set<string>();

      // --- read
      const error = await sqlError(async () => {
        const seen = (await app.query(`SELECT count(*)::int AS n FROM ${quoted(table)} WHERE "tenantId" IS NOT NULL`))[0].n;
        if (seen !== 0) wrong.push(`${table}: ${seen} of ${really} tenant rows are visible without a tenant`);
      });
      if (error === null) readable += 1;
      else if (!/permission denied/i.test(error)) wrong.push(`${table}: SELECT -> ${error.slice(0, 160)}`);
      else if (can.has('SELECT')) wrong.push(`${table}: SELECT is granted but was denied`);

      // --- change and delete (in a transaction that is rolled back, should a statement ever succeed)
      for (const [verb, sql] of [['UPDATE', `UPDATE ${quoted(table)} SET "tenantId" = "tenantId"`], ['DELETE', `DELETE FROM ${quoted(table)}`]] as const) {
        let affected = -1;
        const failed = await sqlError(() =>
          rolledBack(app.inTransaction, async (q) => {
            affected = (await q(`WITH changed AS (${sql} RETURNING 1) SELECT count(*)::int AS n FROM changed`))[0].n;
          }),
        );
        if (failed === null && affected !== 0) wrong.push(`${table}: ${verb} touched ${affected} row(s) without a tenant`);
        if (failed !== null && !/permission denied|append-only|immutable|never deleted|cannot be|not allowed|has been issued|frozen/i.test(failed)) wrong.push(`${table}: ${verb} -> ${failed.slice(0, 160)}`);
      }
    }
    expect(wrong).toEqual([]);
    expect(populated).toBeGreaterThan(60); // the two centres really have rows in most tables ...
    expect(readable).toBeGreaterThan(80); // ... and the role really may query most of them

    // --- insert: a row "for" centre A, without A being bound, in the tables that matter most
    const inserts: Array<[string, string]> = [
      ['customers', `INSERT INTO "customers" (id, "tenantId", "customerNo", "fullName", "updatedAt") VALUES (gen_random_uuid(), '${a.centre.id}', 'CUS-999999', 'Planted By SQL', now())`],
      ['branches', `INSERT INTO "branches" (id, "tenantId", code, name, "updatedAt") VALUES (gen_random_uuid(), '${a.centre.id}', 'SQL', 'Planted By SQL', now())`],
      ['customer_notes', `INSERT INTO "customer_notes" (id, "tenantId", "customerId", "authorId", body) VALUES (gen_random_uuid(), '${a.centre.id}', '${a.ids.walkIn}', '${a.centre.owner.userId}', 'Planted By SQL')`],
      ['audit_logs', `INSERT INTO "audit_logs" (id, "tenantId", "actorType", action, "resourceType") VALUES (gen_random_uuid(), '${a.centre.id}', 'SYSTEM', 'planted.by_sql', 'Nothing')`],
      ['role_permissions', `INSERT INTO "role_permissions" ("tenantId", "roleId", "permissionKey") VALUES ('${a.centre.id}', '${a.ids.role}', 'refund.approve')`],
      ['tenant_memberships', `UPDATE "tenant_memberships" SET status = 'ACTIVE', "roleId" = '${a.ids.role}' WHERE id = '${a.ids.invitedStaff}' RETURNING id`],
    ];
    for (const [table, sql] of inserts) {
      let rows: any[] | undefined;
      const error = await sqlError(() => rolledBack(app.inTransaction, async (q) => void (rows = await q(sql))));
      const outcome = error === null ? (rows && rows.length === 0 && /^UPDATE/.test(sql) ? 'no row' : 'IT WORKED') : /row-level security|permission denied/i.test(error) ? 'refused' : error.slice(0, 200);
      expect([table, outcome]).toEqual([table, /^UPDATE/.test(sql) ? 'no row' : 'refused']);
    }
    // The centre's own row and the platform's tables.
    expect((await app.query(`SELECT count(*)::int AS n FROM "tenants"`))[0].n).toBe(0);
    expect((await app.query(`SELECT count(*)::int AS n FROM "users"`))[0].n).toBe(0);
    expect(await sqlError(() => app.query(`UPDATE "tenants" SET status = 'ARCHIVED'`))).toMatch(/permission denied/i);
    expect(await sqlError(() => app.query(`UPDATE "users" SET "platformRole" = 'SUPER_ADMIN'`))).toMatch(/permission denied/i);
    expect(await sqlError(() => app.query(`INSERT INTO "subscriptions" ("tenantId") VALUES ('${a.centre.id}')`))).toMatch(/permission denied/i);

    // Nothing of either centre changed.
    expect(changedTables(before1, await fingerprint(t, a.centre.id))).toEqual([]);
    expect(changedTables(before2, await fingerprint(t, b.centre.id))).toEqual([]);
  }, 300_000);

  it('S24 database: with tenant A bound the role reaches only rows of A: no row of B can be read, changed, deleted, taken over or pointed at', async () => {
    const A = a.centre.id;
    const B = b.centre.id;
    const beforeB = await fingerprint(t, B);
    const beforeA = await fingerprint(t, A);

    // --- read: in every tenant-owned table, with A bound, there are rows of A and not one row of anybody else
    const wrong: string[] = [];
    const withPlatformDefaults: string[] = [];
    let own = 0;
    await app.inTenant(A, async (q) => {
      for (const table of tables.filter((name) => grants[name]?.has('SELECT'))) {
        const [row] = await q(
          `SELECT count(*) FILTER (WHERE "tenantId" = $1::uuid)::int AS own, count(*) FILTER (WHERE "tenantId" <> $1::uuid)::int AS others, count(*) FILTER (WHERE "tenantId" IS NULL)::int AS shared FROM ${quoted(table)}`,
          A,
        );
        if (row.others !== 0) wrong.push(`${table}: ${row.others} row(s) of other tenants are visible to tenant A`);
        if (row.shared !== 0) withPlatformDefaults.push(table);
        own += row.own;
      }
      // Rows of B by id: not there.
      for (const [table, id] of [['customers', b.ids.walkIn], ['documents', b.ids.document], ['invoices', b.ids.invoice], ['payments', b.ids.payment], ['service_requests', b.ids.request], ['audit_logs', b.ids.auditLog], ['access_grants', b.ids.accessGrant]] as const) {
        const rows = await q(`SELECT id FROM ${quoted(table)} WHERE id = $1::uuid`, id);
        if (rows.length) wrong.push(`${table}: the row of tenant B is visible to tenant A`);
      }
      // The people: A sees its own members, not B's - and never a credential column.
      const users = (await q(`SELECT id::text FROM "users"`)).map((u: any) => u.id);
      if (!users.includes(a.centre.owner.userId)) wrong.push('users: the own owner is not visible');
      if (users.includes(b.centre.owner.userId) || users.includes(b.customer.userId)) wrong.push('users: people of tenant B are visible');
      const tenantsSeen = (await q(`SELECT id::text FROM "tenants"`)).map((x: any) => x.id);
      if (tenantsSeen.length !== 1 || tenantsSeen[0] !== A) wrong.push(`tenants: ${tenantsSeen.length} rows visible`);
    });
    expect(wrong).toEqual([]);
    expect(own).toBeGreaterThan(300);
    // Rows that belong to no centre (platform defaults every centre reads) exist in exactly these tables.
    expect(withPlatformDefaults.sort()).toEqual(['document_types', 'notification_templates']);

    // --- write: each attempt in its own transaction (bound to A), rolled back in any case
    const attempt = async (sql: string, ...params: unknown[]): Promise<string> => {
      let rows: any[] = [];
      const error = await sqlError(() => rolledBack((fn) => app.inTenant(A, fn), async (q) => void (rows = await q(sql, ...params))));
      if (error !== null) return /row-level security/i.test(error) ? 'row-level security' : /cross-tenant reference blocked/i.test(error) ? 'cross-tenant guard' : /permission denied/i.test(error) ? 'permission denied' : /append-only|immutable|never deleted|has been issued|frozen/i.test(error) ? 'immutable' : error.slice(0, 200);
      return `${rows.length} row(s)`;
    };
    const cases: Array<[string, string, string]> = [
      // rows of B are not there to be changed or deleted
      ['rename a customer of B', await attempt(`UPDATE "customers" SET "fullName" = 'Renamed By SQL' WHERE id = $1::uuid RETURNING id`, b.ids.walkIn), '0 row(s)'],
      ['delete a customer note of B', await attempt(`DELETE FROM "customer_notes" WHERE id = $1::uuid RETURNING id`, b.ids.customerNote), '0 row(s)'],
      ['void an invoice of B', await attempt(`UPDATE "invoices" SET notes = 'Touched By SQL' WHERE id = $1::uuid RETURNING id`, b.ids.draftInvoice), '0 row(s)'],
      ['change every customer there is', await attempt(`UPDATE "customers" SET "fullNameAr" = "fullNameAr" WHERE "tenantId" = $1::uuid RETURNING id`, B), '0 row(s)'],
      ['delete every task there is', await attempt(`DELETE FROM "tasks" WHERE "tenantId" <> $1::uuid RETURNING id`, A), '0 row(s)'],
      // a row cannot be created in B, or moved to B
      ['insert a customer into B', await attempt(`INSERT INTO "customers" (id, "tenantId", "customerNo", "fullName", "updatedAt") VALUES (gen_random_uuid(), $1::uuid, 'CUS-999998', 'Planted By SQL', now()) RETURNING id`, B), 'row-level security'],
      ['insert an audit entry into B', await attempt(`INSERT INTO "audit_logs" (id, "tenantId", "actorType", action, "resourceType") VALUES (gen_random_uuid(), $1::uuid, 'SYSTEM', 'planted.by_sql', 'Nothing') RETURNING id`, B), 'row-level security'],
      ['give a role of B a permission', await attempt(`INSERT INTO "role_permissions" ("tenantId", "roleId", "permissionKey") VALUES ($1::uuid, $2::uuid, 'refund.approve') RETURNING "roleId"`, B, b.ids.role), 'row-level security'],
      ['move an own customer to B', await attempt(`UPDATE "customers" SET "tenantId" = $1::uuid WHERE id = $2::uuid RETURNING id`, B, a.ids.walkIn), 'row-level security'],
      ['move an own document to B', await attempt(`UPDATE "documents" SET "tenantId" = $1::uuid WHERE id = $2::uuid RETURNING id`, B, a.ids.vaultDocument), 'cross-tenant guard'], // (the guard on its customer fires first)
      // an own row cannot point at a row of B
      ['own note on a customer of B', await attempt(`INSERT INTO "customer_notes" (id, "tenantId", "customerId", "authorId", body) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'Planted By SQL') RETURNING id`, A, b.ids.walkIn, a.centre.owner.userId), 'cross-tenant guard'],
      ['own request for a customer of B', await attempt(`UPDATE "service_requests" SET "customerId" = $1::uuid WHERE id = $2::uuid RETURNING id`, b.ids.walkIn, a.ids.neighbourRequest), 'cross-tenant guard'],
      ['own document on a request of B', await attempt(`UPDATE "documents" SET "requestId" = $1::uuid WHERE id = $2::uuid RETURNING id`, b.ids.request, a.ids.vaultDocument), 'cross-tenant guard'],
      ['own staff member in a branch of B', await attempt(`INSERT INTO "membership_branches" ("tenantId", "membershipId", "branchId") VALUES ($1::uuid, $2::uuid, $3::uuid) RETURNING "branchId"`, A, a.ids.staff, b.ids.branch), 'cross-tenant guard'],
      ['own task for a staff member of B', await attempt(`INSERT INTO "task_assignments" ("tenantId", "taskId", "assigneeId") VALUES ($1::uuid, $2::uuid, $3::uuid) RETURNING "taskId"`, A, a.ids.task, b.ids.staff), 'cross-tenant guard'],
      // platform defaults are read by every centre - and changed by none
      ['change a platform document type', await attempt(`UPDATE "document_types" SET name = 'Changed For Everybody' WHERE "tenantId" IS NULL RETURNING id`), '0 row(s)'],
      ['change a platform message template', await attempt(`UPDATE "notification_templates" SET body = 'Changed For Everybody' WHERE "tenantId" IS NULL RETURNING id`), '0 row(s)'],
      ['delete the platform message templates', await attempt(`DELETE FROM "notification_templates" WHERE "tenantId" IS NULL RETURNING id`), '0 row(s)'],
      ['add a platform message template', await attempt(`INSERT INTO "notification_templates" ("tenantId", "eventKey", channel, language, name, body) VALUES (NULL, 'planted.by_sql', 'EMAIL', 'en', 'Planted', 'Planted By SQL') RETURNING id`), 'row-level security'],
      // what a centre cannot do to itself either
      ['activate the own centre', await attempt(`UPDATE "tenants" SET status = 'ACTIVE' WHERE id = $1::uuid RETURNING id`, A), 'permission denied'],
      ['change the own web address', await attempt(`UPDATE "tenants" SET slug = 'taken-over' WHERE id = $1::uuid RETURNING id`, A), 'permission denied'],
      ['upgrade the own plan', await attempt(`UPDATE "subscriptions" SET status = 'ACTIVE' WHERE "tenantId" = $1::uuid RETURNING "tenantId"`, A), 'permission denied'],
      ['rewrite the own audit trail', await attempt(`UPDATE "audit_logs" SET summary = 'Nothing happened' WHERE "tenantId" = $1::uuid RETURNING id`, A), 'permission denied'],
      ['delete the own audit trail', await attempt(`DELETE FROM "audit_logs" WHERE "tenantId" = $1::uuid RETURNING id`, A), 'permission denied'],
      ['change the amount of an own payment', await attempt(`UPDATE "payments" SET amount = 1 WHERE id = $1::uuid RETURNING id`, a.ids.payment), 'immutable'],
      ['change the total of an issued invoice', await attempt(`UPDATE "invoices" SET total = 1 WHERE id = $1::uuid RETURNING id`, a.ids.invoice), 'immutable'],
      // control: an ordinary change of an own row works (the cases above failed for their own reasons)
      ['rename an own customer (control)', await attempt(`UPDATE "customers" SET "fullNameAr" = 'control' WHERE id = $1::uuid RETURNING id`, a.ids.walkIn), '1 row(s)'],
      ['own note on an own customer (control)', await attempt(`INSERT INTO "customer_notes" (id, "tenantId", "customerId", "authorId", body) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'control') RETURNING id`, A, a.ids.walkIn, a.centre.owner.userId), '1 row(s)'],
    ];
    expect(cases.map(([what, got]) => [what, got])).toEqual(cases.map(([what, , expected]) => [what, expected]));

    // The binding is per transaction: the next statement on the pool has no tenant again.
    expect((await app.query(`SELECT count(*)::int AS n FROM "customers"`))[0].n).toBe(0);
    // Nothing of B changed - and nothing of A (every attempt was rolled back or refused).
    expect(changedTables(beforeB, await fingerprint(t, B))).toEqual([]);
    expect(changedTables(beforeA, await fingerprint(t, A))).toEqual([]);
    // After all of this both centres work as before, over the API.
    expect((await api(t, a.centre.owner).get(`/customers/${a.ids.walkIn}`)).id).toBe(a.ids.walkIn);
    expect((await api(t, b.centre.owner).get(`/customers/${b.ids.walkIn}`)).id).toBe(b.ids.walkIn);
  }, 300_000);
});
