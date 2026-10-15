#!/usr/bin/env node
/**
 * Demo data verification.
 *
 * Connects to a database that was filled by `pnpm db:seed`, prints a summary of
 * what is in it and checks it: the expected centres, people and case states
 * exist, no row points across centres, and nothing in it looks like real
 * personal data. Exit code 0 = every check passed, 1 = at least one failed.
 *
 *   node scripts/seed-verify.mjs                         (environment already loaded)
 *   node scripts/seed-verify.mjs --env-file=.env         (reads KEY=VALUE lines first)
 *
 * READ-ONLY: the session runs with default_transaction_read_only = on.
 *
 * Connection: SEED_VERIFY_DATABASE_URL, else DATABASE_SYSTEM_URL, else
 * DATABASE_MIGRATION_URL. The application role (DATABASE_URL) cannot be used:
 * row-level security hides every centre's rows from it unless a centre is
 * selected, which is exactly what this script must not depend on.
 *
 * HMAC_KEY (the API setting) is optional. With it, the script also proves that
 * every stored Emirates ID and passport number comes from the fake demo ranges
 * (they are stored encrypted; their keyed lookup hashes are compared).
 *
 * `pg` is installed in the `database` workspace package; it is resolved from
 * there, so the script runs from any directory.
 */
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { Client } = createRequire(resolve(ROOT, 'database', 'package.json'))('pg');

// ------------------------------------------------------------------ what the seed is expected to have produced

const REQUEST_STATUSES = [
  'DRAFT', 'SUBMITTED', 'AWAITING_CUSTOMER', 'UNDER_REVIEW', 'QUOTED', 'AWAITING_PAYMENT', 'READY_FOR_PROCESSING', 'IN_PREPARATION',
  'PENDING_APPROVAL', 'READY_TO_SUBMIT', 'EXTERNAL_PROCESSING', 'RETURNED', 'REJECTED', 'FINAL_REVIEW', 'COMPLETED', 'CANCELLED',
];
const EXPECTED = {
  'al-noor': {
    name: 'Al Noor Typing Centre', plan: 'business', status: 'ACTIVE', subscription: 'ACTIVE', branches: 2, branding: 'WHITE_LABEL',
    staff: { owner: 1, manager: 1, receptionist: 2, operator: 3, reviewer: 1, accountant: 1 },
    min: { customers: 35, portalAccounts: 8, companies: 3, companyAdmins: 2, requests: 55 },
  },
  'gulf-star': {
    name: 'Gulf Star Document Services', plan: 'professional', status: 'ACTIVE', subscription: 'ACTIVE', branches: 1, branding: 'TYPEASE',
    staff: { owner: 1, receptionist: 1, operator: 1, accountant: 1 },
    min: { customers: 12, portalAccounts: 2, companies: 1, companyAdmins: 1, requests: 18 },
  },
  'desert-rose': {
    name: 'Desert Rose Typing', plan: 'starter', status: 'TRIAL', subscription: 'TRIALING', branches: 1, branding: 'TYPEASE',
    staff: { owner: 1, receptionist: 1 },
    min: { customers: 5, portalAccounts: 1, companies: 0, companyAdmins: 0, requests: 5 },
  },
};
/** Reserved for testing and documentation (RFC 2606 / RFC 6761): mail to these can never reach a real mailbox. */
const TEST_EMAIL_DOMAIN = /(^|\.)(test|example|invalid|localhost)$|^example\.(com|net|org)$/i;
/** The demo phone range (see database/seed/identity.ts). */
const DEMO_PHONE = /^\+97159000\d{4}$/;

// ------------------------------------------------------------------ plumbing

function loadEnvFile(path) {
  const file = isAbsolute(path) ? path : [resolve(process.cwd(), path), resolve(ROOT, path)].find(existsSync) ?? path;
  if (!existsSync(file)) throw new Error(`--env-file: ${path} does not exist.`);
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`   ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
}
const section = (title) => console.log(`\n== ${title}`);
const q = (identifier) => `"${String(identifier).replace(/"/g, '""')}"`;
const pad = (value, width) => String(value).padEnd(width);

/** "A 3, B 1" from rows of { key, n }. */
const tally = (rows, key = 'key') => rows.map((r) => `${r[key]} ${r.n}`).join(', ') || '(none)';
/** Prints one line per centre: "al-noor   A 3, B 1" and returns { slug: { key: n } }. */
function perCentre(rows, slugs, label) {
  const out = Object.fromEntries(slugs.map((s) => [s, {}]));
  for (const r of rows) if (out[r.slug]) out[r.slug][r.key] = Number(r.n);
  console.log(`   ${label}`);
  for (const slug of slugs) {
    const parts = Object.entries(out[slug]).map(([k, n]) => `${k} ${n}`);
    const total = Object.values(out[slug]).reduce((a, b) => a + b, 0);
    console.log(`     ${pad(slug, 12)} ${pad(total, 5)} ${parts.join(', ') || '(none)'}`);
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  if (args.includes('--help') || args.includes('-h')) {
    console.log('node scripts/seed-verify.mjs [--env-file=<path>]\n\nNeeds SEED_VERIFY_DATABASE_URL, DATABASE_SYSTEM_URL or DATABASE_MIGRATION_URL. HMAC_KEY is optional (identity-number check).');
    return 0;
  }
  for (const a of args) {
    if (a.startsWith('--env-file=')) loadEnvFile(a.slice('--env-file='.length));
    else throw new Error(`Unknown argument: ${a}`);
  }
  const url = process.env.SEED_VERIFY_DATABASE_URL || process.env.DATABASE_SYSTEM_URL || process.env.DATABASE_MIGRATION_URL;
  if (!url) {
    console.error('No database connection. Set SEED_VERIFY_DATABASE_URL, DATABASE_SYSTEM_URL or DATABASE_MIGRATION_URL (or pass --env-file=<path>).');
    return 2;
  }
  const target = new URL(url);
  console.log(`Demo data verification - database "${target.pathname.slice(1)}" on ${target.hostname}:${target.port || 5432} as ${decodeURIComponent(target.username)} (read-only session)`);

  const db = new Client({ connectionString: url, options: '-c default_transaction_read_only=on', application_name: 'typease-seed-verify' });
  await db.connect();
  const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
  const one = async (sql, params = []) => (await rows(sql, params))[0];
  const count = async (sql, params = []) => Number((await one(sql, params)).n);

  try {
    // ================================================================== centres
    section('Centres');
    const tenants = await rows(`
      SELECT t."id", t."slug", t."name", t."status", t."createdAt", p."key" AS plan, s."status" AS subscription,
             (SELECT count(*)::int FROM "branches" b WHERE b."tenantId" = t."id") AS branches,
             (SELECT b."mode" FROM "branding_settings" b WHERE b."tenantId" = t."id" AND b."branchId" IS NULL LIMIT 1) AS branding,
             (SELECT string_agg(d."domain" || ' ' || d."status", ', ') FROM "tenant_domains" d WHERE d."tenantId" = t."id" AND d."kind" = 'CUSTOM') AS domains,
             (SELECT count(*)::int FROM "subscription_invoices" i WHERE i."tenantId" = t."id" AND i."status" = 'PAID') AS paid_invoices
      FROM "tenants" t
      LEFT JOIN "subscriptions" s ON s."tenantId" = t."id"
      LEFT JOIN "subscription_plans" p ON p."id" = s."planId"
      ORDER BY t."createdAt"`);
    if (!tenants.length) {
      const visible = await count('SELECT count(*) AS n FROM "users"');
      check('the database contains centres', false, visible ? 'no centre found: run the seed first' : 'nothing is visible: use the system or owner connection, not the application role (row-level security)');
      return 1;
    }
    for (const t of tenants) {
      console.log(`   ${pad(t.slug, 12)} ${pad(t.name, 30)} centre ${pad(t.status, 7)} plan ${pad(t.plan ?? '-', 13)} subscription ${pad(t.subscription ?? '-', 9)} branches ${t.branches}  branding ${pad(t.branding ?? '-', 11)} paid SaaS invoices ${t.paid_invoices}  since ${t.createdAt.toISOString().slice(0, 10)}${t.domains ? `  domain ${t.domains}` : ''}`);
    }
    const slugs = tenants.map((t) => t.slug);
    const ids = tenants.map((t) => t.id);
    const bySlug = Object.fromEntries(tenants.map((t) => [t.slug, t]));
    check('exactly the three demo centres exist', slugs.length === 3 && Object.keys(EXPECTED).every((s) => slugs.includes(s)), slugs.join(', '));
    for (const [slug, e] of Object.entries(EXPECTED)) {
      const t = bySlug[slug];
      if (!t) continue;
      const got = `${t.name} / ${t.plan} / ${t.status} / ${t.subscription} / ${t.branches} branch(es) / ${t.branding}`;
      check(`${slug}: name, plan, status, branches, branding`, t.name === e.name && t.plan === e.plan && t.status === e.status && t.subscription === e.subscription && t.branches === e.branches && t.branding === e.branding, got);
    }
    check('al-noor: custom domain waits for DNS verification', /PENDING/.test(bySlug['al-noor']?.domains ?? ''), bySlug['al-noor']?.domains ?? 'none');
    const oldest = Math.min(...tenants.map((t) => t.createdAt.getTime()));
    const spanDays = Math.round((Date.now() - oldest) / 86_400_000);
    check('activity is spread over about 90 days', spanDays >= 60 && spanDays <= 130, `the oldest centre signed up ${spanDays} days ago`);

    // ================================================================== people
    section('Users');
    const platform = await rows(`SELECT "platformRole" AS key, count(*)::int AS n FROM "users" WHERE "platformRole" IS NOT NULL GROUP BY 1 ORDER BY 1`);
    console.log(`   platform staff: ${tally(platform)}`);
    check('one platform super admin and one support agent', platform.find((r) => r.key === 'SUPER_ADMIN')?.n === 1 && platform.find((r) => r.key === 'SUPPORT_AGENT')?.n === 1);
    const roles = perCentre(
      await rows(`SELECT t."slug", r."key" || CASE WHEN m."status" <> 'ACTIVE' THEN ' (' || lower(m."status"::text) || ')' ELSE '' END AS key, count(*)::int AS n
                  FROM "tenant_memberships" m JOIN "roles" r ON r."id" = m."roleId" JOIN "tenants" t ON t."id" = m."tenantId"
                  GROUP BY 1, 2 ORDER BY 1, 2`),
      slugs, 'accounts per role (active unless stated)');
    for (const [slug, e] of Object.entries(EXPECTED)) {
      if (!roles[slug]) continue;
      const staffOk = Object.entries(e.staff).every(([role, n]) => roles[slug][role] === n);
      check(`${slug}: staff accounts ${Object.entries(e.staff).map(([r, n]) => `${r} ${n}`).join(', ')}`, staffOk);
      check(`${slug}: at least ${e.min.portalAccounts} customer portal account(s) and ${e.min.companyAdmins} company administrator(s)`, (roles[slug].customer ?? 0) >= e.min.portalAccounts && (roles[slug].corporate_admin ?? 0) >= e.min.companyAdmins, `customer ${roles[slug].customer ?? 0}, corporate_admin ${roles[slug].corporate_admin ?? 0}`);
    }
    const noPassword = await count(`SELECT count(*) AS n FROM "users" u WHERE u."passwordHash" IS NULL AND EXISTS (SELECT 1 FROM "tenant_memberships" m WHERE m."userId" = u."id" AND m."status" = 'ACTIVE')`);
    check('every active account can sign in (has a password)', noPassword === 0, `${noPassword} without`);

    const al = bySlug['al-noor'].id;
    const setup = await one(`
      SELECT (SELECT count(*)::int FROM "tenant_memberships" m JOIN "roles" r ON r."id" = m."roleId" WHERE m."tenantId" = $1 AND r."key" = 'manager' AND NOT m."allBranches"
                AND (SELECT count(*) FROM "membership_branches" b WHERE b."membershipId" = m."id") = 1) AS one_branch_managers,
             (SELECT count(DISTINCT skills)::int FROM (SELECT (SELECT string_agg(k."serviceId"::text, ',' ORDER BY k."serviceId") FROM "staff_skills" k WHERE k."membershipId" = m."id") AS skills
                FROM "tenant_memberships" m JOIN "roles" r ON r."id" = m."roleId" WHERE m."tenantId" = $1 AND r."key" = 'operator') x WHERE skills IS NOT NULL) AS operator_skill_sets,
             (SELECT count(DISTINCT "membershipId")::int FROM "staff_schedules" WHERE "tenantId" = $1) AS scheduled_staff,
             (SELECT count(*)::int FROM "services" WHERE "tenantId" = $1 AND "deletedAt" IS NULL) AS services,
             (SELECT count(*)::int FROM "services" WHERE "tenantId" = $1 AND "code" LIKE 'AN-%') AS own_services,
             (SELECT count(*)::int FROM "services" WHERE "tenantId" = $1 AND "code" LIKE 'AN-%' AND "requiresApproval") AS own_with_approval,
             (SELECT max(v."version")::int FROM "workflow_versions" v WHERE v."tenantId" = $1 AND v."status" = 'PUBLISHED') AS published_workflow_version`, [al]);
    console.log(`   al-noor set-up: ${setup.services} services (${setup.own_services} of its own, ${setup.own_with_approval} needing internal approval), ${setup.scheduled_staff} staff with a weekly schedule, ${setup.operator_skill_sets} different operator skill sets, customised workflow published as version ${setup.published_workflow_version}`);
    check('al-noor: the manager is limited to one branch; the three operators have different skills; schedules exist', setup.one_branch_managers === 1 && setup.operator_skill_sets === 3 && setup.scheduled_staff >= 5);
    check('al-noor: starter catalogue plus own services (one needs approval) and a customised published workflow version', setup.services >= 13 && setup.own_services >= 2 && setup.own_with_approval >= 1 && setup.published_workflow_version >= 2);

    section('Customers and companies');
    const customers = perCentre(await rows(`SELECT t."slug", c."type" || ' ' || lower(c."status"::text) AS key, count(*)::int AS n FROM "customers" c JOIN "tenants" t ON t."id" = c."tenantId" GROUP BY 1, 2 ORDER BY 1, 2`), slugs, 'customers by type and status');
    const companies = perCentre(await rows(`SELECT t."slug", c."status"::text || CASE WHEN c."creditApproved" THEN ' (credit approved)' ELSE '' END AS key, count(*)::int AS n FROM "corporate_accounts" c JOIN "tenants" t ON t."id" = c."tenantId" GROUP BY 1, 2 ORDER BY 1, 2`), slugs, 'corporate accounts');
    perCentre(await rows(`SELECT t."slug", 'employees' AS key, count(*)::int AS n FROM "corporate_employees" c JOIN "tenants" t ON t."id" = c."tenantId" GROUP BY 1`), slugs, 'corporate employees');
    const sum = (o) => Object.values(o ?? {}).reduce((a, b) => a + b, 0);
    for (const [slug, e] of Object.entries(EXPECTED)) {
      check(`${slug}: at least ${e.min.customers} customers and ${e.min.companies} corporate account(s)`, sum(customers[slug]) >= e.min.customers && sum(companies[slug]) >= e.min.companies, `${sum(customers[slug])} customers, ${sum(companies[slug])} companies`);
    }
    const an = companies['al-noor'] ?? {};
    check('al-noor: a verified company with approved credit, one pending verification, one suspended', an['ACTIVE (credit approved)'] >= 1 && an.PENDING_VERIFICATION >= 1 && an.SUSPENDED >= 1, tally(Object.entries(an).map(([key, n]) => ({ key, n }))));

    // ================================================================== requests
    section('Requests');
    const requests = perCentre(await rows(`SELECT t."slug", r."status"::text AS key, count(*)::int AS n FROM "service_requests" r JOIN "tenants" t ON t."id" = r."tenantId" WHERE r."deletedAt" IS NULL GROUP BY 1, 2 ORDER BY 1, array_position($1::text[], r."status"::text)`, [REQUEST_STATUSES]), slugs, 'requests per status');
    for (const [slug, e] of Object.entries(EXPECTED)) check(`${slug}: at least ${e.min.requests} requests`, sum(requests[slug]) >= e.min.requests, `${sum(requests[slug])}`);
    const missing = REQUEST_STATUSES.filter((s) => !(requests['al-noor']?.[s] > 0));
    check('al-noor: every one of the 16 request statuses is present', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : '16 of 16');
    const paths = await one(`
      SELECT (SELECT count(*)::int FROM "service_requests" WHERE "duplicateOfId" IS NOT NULL) AS duplicates,
             (SELECT count(*)::int FROM "service_requests" WHERE "reopenedCount" > 0) AS reopened,
             (SELECT count(*)::int FROM "service_requests" WHERE "targetDate" < now() AND "status" NOT IN ('COMPLETED', 'CANCELLED', 'DRAFT')) AS overdue,
             (SELECT count(*)::int FROM "request_documents" WHERE "status" = 'REJECTED') AS rejected_lines,
             (SELECT count(*)::int FROM "request_status_history") AS history_rows,
             (SELECT count(DISTINCT "workflowVersionId")::int FROM "service_requests") AS workflow_versions,
             (SELECT count(*)::int FROM "request_approvals") AS approvals,
             (SELECT count(*)::int FROM "request_external_references") AS external_refs`);
    console.log(`   exception paths: ${paths.duplicates} duplicate(s), ${paths.reopened} reopened, ${paths.overdue} overdue, ${paths.rejected_lines} checklist line(s) with a rejected document, ${paths.approvals} internal approval decision(s), ${paths.external_refs} external reference(s); ${paths.history_rows} status history rows; ${paths.workflow_versions} workflow versions in use`);
    check('exception paths exist: duplicate, reopened, overdue, rejected document', paths.duplicates >= 1 && paths.reopened >= 1 && paths.overdue >= 1 && paths.rejected_lines >= 1);
    const jumps = await count(`SELECT count(*) AS n FROM "service_requests" r WHERE r."status" <> 'DRAFT' AND r."deletedAt" IS NULL AND NOT EXISTS (SELECT 1 FROM "request_status_history" h WHERE h."requestId" = r."id" AND h."toStatus" = r."status")`);
    check('every request reached its status through a recorded transition', jumps === 0, `${jumps} without a matching history row`);
    const spread = await one(`SELECT min("createdAt") AS first, max("createdAt") AS last, count(DISTINCT date_trunc('week', "createdAt"))::int AS weeks FROM "service_requests"`);
    check('requests are spread over the past weeks', spread.weeks >= 8, `first ${spread.first.toISOString().slice(0, 10)}, last ${spread.last.toISOString().slice(0, 10)}, ${spread.weeks} different weeks`);

    // ================================================================== finance
    section('Finance');
    const quotations = perCentre(await rows(`SELECT t."slug", x."status"::text AS key, count(*)::int AS n FROM "quotations" x JOIN "tenants" t ON t."id" = x."tenantId" GROUP BY 1, 2 ORDER BY 1, 2`), slugs, 'quotations per status');
    const invoices = perCentre(await rows(`SELECT t."slug", x."status"::text AS key, count(*)::int AS n FROM "invoices" x JOIN "tenants" t ON t."id" = x."tenantId" GROUP BY 1, 2 ORDER BY 1, 2`), slugs, 'invoices per status');
    const payments = perCentre(await rows(`SELECT t."slug", x."method"::text || ' ' || x."status"::text AS key, count(*)::int AS n FROM "payments" x JOIN "tenants" t ON t."id" = x."tenantId" GROUP BY 1, 2 ORDER BY 1, 2`), slugs, 'payments per method and status');
    const refunds = perCentre(await rows(`SELECT t."slug", x."status"::text AS key, count(*)::int AS n FROM "refunds" x JOIN "tenants" t ON t."id" = x."tenantId" GROUP BY 1, 2 ORDER BY 1, 2`), slugs, 'refunds per status');
    perCentre(await rows(`SELECT t."slug", 'credit notes' AS key, count(*)::int AS n FROM "credit_notes" x JOIN "tenants" t ON t."id" = x."tenantId" GROUP BY 1`), slugs, 'credit notes');
    const expenses = perCentre(await rows(`SELECT t."slug", x."category"::text AS key, count(*)::int AS n FROM "expenses" x JOIN "tenants" t ON t."id" = x."tenantId" WHERE x."deletedAt" IS NULL GROUP BY 1, 2 ORDER BY 1, 2`), slugs, 'expenses per category');
    const recon = perCentre(await rows(`SELECT t."slug", x."method"::text || ' ' || x."status"::text AS key, count(*)::int AS n FROM "reconciliation_records" x JOIN "tenants" t ON t."id" = x."tenantId" GROUP BY 1, 2 ORDER BY 1, 2`), slugs, 'reconciliation records');
    const a = { q: quotations['al-noor'] ?? {}, i: invoices['al-noor'] ?? {}, p: payments['al-noor'] ?? {}, r: refunds['al-noor'] ?? {} };
    check('al-noor: quotations approved, rejected and expired', a.q.APPROVED >= 1 && a.q.REJECTED >= 1 && a.q.EXPIRED >= 1);
    const invoiceStates = ['DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID', 'CREDITED'];
    check('al-noor: invoices in every state', invoiceStates.every((s) => a.i[s] >= 1), invoiceStates.filter((s) => !(a.i[s] >= 1)).map((s) => `missing ${s}`).join(', ') || invoiceStates.join(', '));
    const methods = ['CASH', 'CARD_POS', 'BANK_TRANSFER', 'CHEQUE', 'ONLINE_GATEWAY'];
    const paidBy = (m) => Object.entries(a.p).filter(([k]) => k.startsWith(`${m} `) && /COMPLETED|REFUNDED/.test(k)).reduce((n, [, v]) => n + v, 0);
    check('al-noor: completed payments by every method, including the online test gateway', methods.every((m) => paidBy(m) >= 1), methods.map((m) => `${m} ${paidBy(m)}`).join(', '));
    check('al-noor: a failed online payment attempt', (a.p['ONLINE_GATEWAY FAILED'] ?? 0) + (a.p['ONLINE_GATEWAY CANCELLED'] ?? 0) >= 1);
    check('al-noor: a completed refund, one waiting for approval, one rejected', a.r.COMPLETED >= 1 && a.r.REQUESTED >= 1 && a.r.REJECTED >= 1, tally(Object.entries(a.r).map(([key, n]) => ({ key, n }))));
    check('al-noor: a credit note, a government-fee remittance, a reconciliation record', (await count(`SELECT count(*) AS n FROM "credit_notes" WHERE "tenantId" = $1`, [bySlug['al-noor'].id])) >= 1 && expenses['al-noor']?.GOVERNMENT_FEE_REMITTANCE >= 1 && sum(recon['al-noor']) >= 1);
    for (const slug of ['gulf-star', 'desert-rose']) check(`${slug}: basic finance (invoices and payments)`, sum(invoices[slug]) >= 3 && sum(payments[slug]) >= 2, `${sum(invoices[slug])} invoices, ${sum(payments[slug])} payments`);
    const money = await one(`
      SELECT (SELECT count(*)::int FROM "invoices" WHERE "status" NOT IN ('DRAFT', 'VOID') AND "balanceDue" <> "total" - "amountPaid" - "amountCredited" + "amountRefunded") AS unbalanced,
             (SELECT count(*)::int FROM "payments" p WHERE p."status" IN ('COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED')
                AND p."amount" < (SELECT COALESCE(sum(a."amount"), 0) FROM "payment_allocations" a WHERE a."paymentId" = p."id")) AS over_allocated`);
    check('money adds up: invoice balances match their payments, no payment is allocated beyond its amount', money.unbalanced === 0 && money.over_allocated === 0, `${money.unbalanced} unbalanced invoice(s), ${money.over_allocated} over-allocated payment(s)`);

    // ================================================================== documents
    section('Documents');
    const documents = perCentre(await rows(`SELECT t."slug", d."status"::text || CASE WHEN d."status" = 'AVAILABLE' THEN ' ' || lower(d."verificationStatus"::text) ELSE '' END AS key, count(*)::int AS n FROM "documents" d JOIN "tenants" t ON t."id" = d."tenantId" GROUP BY 1, 2 ORDER BY 1, 2`), slugs, 'documents per status');
    const docs = await one(`
      SELECT (SELECT count(*)::int FROM (SELECT "documentId" FROM "document_versions" GROUP BY 1 HAVING count(*) > 1) v) AS versioned,
             (SELECT count(*)::int FROM "documents" WHERE "expiryDate" BETWEEN now() AND now() + interval '60 days' AND "status" = 'AVAILABLE') AS expiring,
             (SELECT count(*)::int FROM "documents" WHERE "expiryDate" < now() AND "status" = 'AVAILABLE') AS expired,
             (SELECT count(*)::int FROM "documents" WHERE "isCompletionDocument") AS completion,
             (SELECT count(*)::int FROM "documents" WHERE "legalHold") AS legal_hold,
             (SELECT count(*)::int FROM "document_shares") AS shares,
             (SELECT count(*)::int FROM "document_versions" WHERE "scanStatus" = 'INFECTED') AS infected`);
    console.log(`   ${docs.versioned} with more than one version, ${docs.expiring} expiring within 60 days, ${docs.expired} already expired, ${docs.completion} completed (output) documents, ${docs.legal_hold} on legal hold, ${docs.shares} share link(s), ${docs.infected} upload(s) caught by the malware check (EICAR test file)`);
    const d = documents['al-noor'] ?? {};
    check('al-noor: documents verified, rejected and not yet reviewed', d['AVAILABLE verified'] >= 1 && d['AVAILABLE rejected'] >= 1 && d['AVAILABLE unverified'] >= 1);
    check('documents with several versions, documents expiring soon, completed documents', docs.versioned >= 1 && docs.expiring >= 1 && docs.completion >= 1);
    check('the EICAR test upload was quarantined', docs.infected >= 1 && (d.QUARANTINED ?? 0) >= 1);

    // ================================================================== operations
    section('Operations');
    const appointments = perCentre(await rows(`SELECT t."slug", x."status"::text AS key, count(*)::int AS n FROM "appointments" x JOIN "tenants" t ON t."id" = x."tenantId" GROUP BY 1, 2 ORDER BY 1, 2`), slugs, 'appointments per status');
    const when = await one(`SELECT count(*) FILTER (WHERE "startsAt" < date_trunc('day', now()))::int AS past, count(*) FILTER (WHERE "startsAt" >= date_trunc('day', now()) AND "startsAt" < date_trunc('day', now()) + interval '1 day')::int AS today, count(*) FILTER (WHERE "startsAt" >= date_trunc('day', now()) + interval '1 day')::int AS upcoming FROM "appointments"`);
    console.log(`     (database day) ${when.past} in the past, ${when.today} today, ${when.upcoming} upcoming`);
    const ap = appointments['al-noor'] ?? {};
    check('al-noor: appointments past and upcoming, a no-show and a rescheduled one', when.past >= 1 && when.upcoming >= 1 && ap.NO_SHOW >= 1 && ap.RESCHEDULED >= 1);
    const queue = perCentre(await rows(`SELECT t."slug", x."status"::text AS key, count(*)::int AS n FROM "queue_tokens" x JOIN "tenants" t ON t."id" = x."tenantId" GROUP BY 1, 2 ORDER BY 1, 2`), slugs, 'queue tokens per status');
    check('al-noor: queue tokens issued', sum(queue['al-noor']) >= 5, `${sum(queue['al-noor'])}`);
    const tasks = perCentre(await rows(`SELECT t."slug", x."source" || ' ' || lower(x."status"::text) AS key, count(*)::int AS n FROM "tasks" x JOIN "tenants" t ON t."id" = x."tenantId" GROUP BY 1, 2 ORDER BY 1, 2`), slugs, 'tasks per source and status');
    const taskSources = Object.keys(tasks['al-noor'] ?? {}).map((k) => k.split(' ')[0]);
    check('al-noor: manual tasks and workflow tasks', taskSources.includes('MANUAL') && taskSources.includes('WORKFLOW'), [...new Set(taskSources)].join(', '));
    const tickets = perCentre(await rows(`SELECT t."slug", x."scope" || ' ' || x."status"::text AS key, count(*)::int AS n FROM "support_tickets" x JOIN "tenants" t ON t."id" = x."tenantId" GROUP BY 1, 2 ORDER BY 1, 2`), slugs, 'support tickets per scope and status');
    const ticketStates = ['OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED'];
    const haveStates = new Set(Object.keys(tickets['al-noor'] ?? {}).map((k) => k.split(' ')[1]));
    const support = await one(`SELECT (SELECT count(*)::int FROM "support_messages" WHERE "visibility" = 'INTERNAL') AS internal_notes, (SELECT count(*)::int FROM "customer_feedback" WHERE "ticketId" IS NOT NULL) AS ticket_ratings, (SELECT count(*)::int FROM "customer_feedback" WHERE "requestId" IS NOT NULL) AS request_ratings`);
    console.log(`     ${support.internal_notes} internal note(s), ${support.ticket_ratings} satisfaction rating(s) on tickets, ${support.request_ratings} feedback entries on requests`);
    check('al-noor: support tickets in every state, with internal notes and a satisfaction rating', ticketStates.every((s) => haveStates.has(s)) && support.internal_notes >= 1 && support.ticket_ratings >= 1, ticketStates.filter((s) => !haveStates.has(s)).map((s) => `missing ${s}`).join(', '));
    check('customer feedback on completed requests', support.request_ratings >= 3, `${support.request_ratings}`);
    const notifications = perCentre(await rows(`SELECT t."slug", x."channel"::text || ' ' || lower(x."status"::text) AS key, count(*)::int AS n FROM "notifications" x JOIN "tenants" t ON t."id" = x."tenantId" GROUP BY 1, 2 ORDER BY 1, 2`), slugs, 'notifications per channel and status');
    const n = Object.keys(notifications['al-noor'] ?? {}).map((k) => k.split(' ')[1]);
    check('al-noor: notifications sent, failed and suppressed', n.includes('sent') && n.includes('failed') && n.includes('suppressed'), [...new Set(n)].join(', '));
    const reminders = perCentre(await rows(`SELECT t."slug", x."status"::text AS key, count(*)::int AS n FROM "reminder_schedules" x JOIN "tenants" t ON t."id" = x."tenantId" GROUP BY 1, 2 ORDER BY 1, 2`), slugs, 'expiry reminder schedules per status');
    const dueSoon = await count(`SELECT count(*) AS n FROM "reminder_schedules" WHERE "status" = 'ACTIVE' AND "expiryDate" BETWEEN now() AND now() + interval '30 days'`);
    check('expiry reminders exist, some due within 30 days', sum(reminders['al-noor']) >= 5 && dueSoon >= 1, `${dueSoon} due soon`);
    const privacy = await one(`SELECT (SELECT count(*)::int FROM "consent_records") AS consent_events, (SELECT count(*)::int FROM "customer_consents") AS consents, (SELECT count(*)::int FROM "data_subject_requests") AS dsr, (SELECT string_agg(DISTINCT "status"::text, ', ') FROM "data_subject_requests") AS dsr_states`);
    console.log(`   privacy: ${privacy.consents} consent states, ${privacy.consent_events} consent events, ${privacy.dsr} data subject requests (${privacy.dsr_states ?? '-'})`);
    check('consents and data subject requests exist', privacy.consents >= 10 && privacy.dsr >= 2);

    // ================================================================== tenant isolation
    section('Tenant isolation');
    const tenantTables = (await rows(`SELECT c."table_name" AS t FROM "information_schema"."columns" c JOIN "information_schema"."tables" x ON x."table_schema" = c."table_schema" AND x."table_name" = c."table_name" AND x."table_type" = 'BASE TABLE' WHERE c."table_schema" = 'public' AND c."column_name" = 'tenantId' ORDER BY 1`)).map((r) => r.t);
    const foreign = [];
    let ownedRows = 0;
    for (const t of tenantTables) {
      const r = await one(`SELECT count(*) FILTER (WHERE "tenantId" IS NOT NULL AND NOT ("tenantId" = ANY($1::uuid[])))::int AS foreign_rows, count(*) FILTER (WHERE "tenantId" IS NOT NULL)::int AS owned FROM ${q(t)}`, [ids]);
      ownedRows += r.owned;
      if (r.foreign_rows) foreign.push(`${t} (${r.foreign_rows})`);
    }
    check(`every tenant-owned table holds only rows of the three known centres (${tenantTables.length} tables, ${ownedRows} rows)`, foreign.length === 0, foreign.join(', '));

    // Every foreign key between two tenant-owned tables: the row and the row it points to must belong to the same centre.
    const fks = await rows(`
      SELECT con."conname" AS name, child."relname" AS child, parent."relname" AS parent,
             (SELECT array_agg(a."attname"::text ORDER BY k.ord) FROM unnest(con."conkey") WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a."attrelid" = con."conrelid" AND a."attnum" = k.attnum) AS child_cols,
             (SELECT array_agg(a."attname"::text ORDER BY k.ord) FROM unnest(con."confkey") WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a."attrelid" = con."confrelid" AND a."attnum" = k.attnum) AS parent_cols
      FROM pg_constraint con
      JOIN pg_class child ON child."oid" = con."conrelid"
      JOIN pg_class parent ON parent."oid" = con."confrelid"
      JOIN pg_namespace ns ON ns."oid" = child."relnamespace"
      WHERE con."contype" = 'f' AND ns."nspname" = 'public'
      ORDER BY 2, 1`);
    const owned = new Set(tenantTables);
    const crossing = [];
    let checkedFks = 0;
    let checkedLinks = 0;
    for (const fk of fks) {
      if (!owned.has(fk.child) || !owned.has(fk.parent)) continue;
      // A key that contains tenantId itself is already enforced by the database.
      if (fk.child_cols.includes('tenantId')) continue;
      const on = fk.child_cols.map((c, i) => `c.${q(c)} = p.${q(fk.parent_cols[i])}`).join(' AND ');
      const r = await one(`SELECT count(*)::int AS links, count(*) FILTER (WHERE c."tenantId" IS NOT NULL AND p."tenantId" IS NOT NULL AND c."tenantId" <> p."tenantId")::int AS crossing FROM ${q(fk.child)} c JOIN ${q(fk.parent)} p ON ${on}`);
      checkedFks += 1;
      checkedLinks += r.links;
      if (r.crossing) crossing.push(`${fk.child}.${fk.child_cols.join('+')} -> ${fk.parent} (${r.crossing})`);
    }
    check(`no foreign key points from one centre into another (${checkedFks} relations, ${checkedLinks} links followed)`, crossing.length === 0, crossing.join(', '));

    // The main relations, spelled out (they are also covered by the generic check above).
    const main = [
      ['service_requests', 'customerId', 'customers'], ['service_requests', 'branchId', 'branches'], ['service_requests', 'serviceId', 'services'],
      ['service_requests', 'corporateAccountId', 'corporate_accounts'], ['quotations', 'requestId', 'service_requests'], ['invoices', 'requestId', 'service_requests'],
      ['invoices', 'customerId', 'customers'], ['payment_allocations', 'invoiceId', 'invoices'], ['payment_allocations', 'paymentId', 'payments'],
      ['refunds', 'paymentId', 'payments'], ['documents', 'customerId', 'customers'], ['documents', 'requestId', 'service_requests'],
      ['request_documents', 'documentId', 'documents'], ['appointments', 'customerId', 'customers'], ['tasks', 'requestId', 'service_requests'],
      ['support_tickets', 'customerId', 'customers'], ['notifications', 'recipientCustomerId', 'customers'], ['tenant_memberships', 'customerId', 'customers'],
      ['corporate_employees', 'customerId', 'customers'], ['membership_branches', 'branchId', 'branches'],
    ];
    const mainCrossing = [];
    for (const [child, column, parent] of main) {
      const r = await one(`SELECT count(*)::int AS n FROM ${q(child)} c JOIN ${q(parent)} p ON p."id" = c.${q(column)} WHERE c."tenantId" <> p."tenantId"`);
      if (r.n) mainCrossing.push(`${child}.${column} (${r.n})`);
    }
    check(`main relations stay inside one centre (${main.length} relations: requests, money, documents, people)`, mainCrossing.length === 0, mainCrossing.join(', '));
    const shared = await rows(`SELECT u."email", count(DISTINCT m."tenantId")::int AS n FROM "tenant_memberships" m JOIN "users" u ON u."id" = m."userId" GROUP BY 1 HAVING count(DISTINCT m."tenantId") > 1`);
    check('no demo account belongs to two centres', shared.length === 0, shared.map((s) => s.email).join(', '));
    const rls = await rows(`SELECT c."relname" AS t FROM pg_class c JOIN pg_namespace ns ON ns."oid" = c."relnamespace" WHERE ns."nspname" = 'public' AND c."relkind" = 'r' AND c."relname" = ANY($1::text[]) AND NOT c."relrowsecurity"`, [tenantTables]);
    check('row-level security is switched on for every tenant-owned table', rls.length === 0, rls.map((r) => r.t).join(', '));

    // ================================================================== no real-looking data
    section('No real-looking data');
    const textColumns = await rows(`SELECT "table_name" AS t, "column_name" AS c FROM "information_schema"."columns" WHERE "table_schema" = 'public' AND "data_type" IN ('text', 'character varying') ORDER BY 1, 2`);
    const emailColumns = textColumns.filter((x) => /email/i.test(x.c) && !/name|verified|enc|hash/i.test(x.c));
    const badEmails = [];
    let emailCount = 0;
    const inspectEmails = (source, values) => {
      for (const v of values) {
        emailCount += 1;
        const domain = String(v).split('@').pop() ?? '';
        if (!String(v).includes('@') || !TEST_EMAIL_DOMAIN.test(domain)) badEmails.push(`${source}: ${v}`);
      }
    };
    for (const col of emailColumns) inspectEmails(`${col.t}.${col.c}`, (await rows(`SELECT DISTINCT ${q(col.c)} AS v FROM ${q(col.t)} WHERE ${q(col.c)} IS NOT NULL AND ${q(col.c)} <> ''`)).map((r) => r.v));
    inspectEmails('notifications.recipientAddress', (await rows(`SELECT DISTINCT "recipientAddress" AS v FROM "notifications" WHERE "channel" = 'EMAIL' AND "recipientAddress" IS NOT NULL`)).map((r) => r.v));
    inspectEmails('customer_contacts.value', (await rows(`SELECT DISTINCT "value" AS v FROM "customer_contacts" WHERE "value" LIKE '%@%'`)).map((r) => r.v));
    check(`every email address is on a reserved test domain (${emailCount} distinct values in ${emailColumns.length + 2} columns)`, badEmails.length === 0, badEmails.slice(0, 8).join('; '));
    const domains = await rows(`SELECT "domain" AS v FROM "tenant_domains" WHERE "kind" = 'CUSTOM'`);
    check('custom domains are on a reserved test domain', domains.every((r) => TEST_EMAIL_DOMAIN.test(r.v.split('.').slice(-1)[0]) || TEST_EMAIL_DOMAIN.test(r.v)), domains.map((r) => r.v).join(', '));

    const phoneColumns = textColumns.filter((x) => /phone/i.test(x.c));
    const badPhones = [];
    let phoneCount = 0;
    const inspectPhones = (source, values) => {
      for (const v of values) {
        phoneCount += 1;
        if (!DEMO_PHONE.test(String(v).replace(/[\s-]/g, ''))) badPhones.push(`${source}: ${v}`);
      }
    };
    for (const col of phoneColumns) inspectPhones(`${col.t}.${col.c}`, (await rows(`SELECT DISTINCT ${q(col.c)} AS v FROM ${q(col.t)} WHERE ${q(col.c)} IS NOT NULL AND ${q(col.c)} <> ''`)).map((r) => r.v));
    inspectPhones('notifications.recipientAddress', (await rows(`SELECT DISTINCT "recipientAddress" AS v FROM "notifications" WHERE "channel" IN ('SMS', 'WHATSAPP') AND "recipientAddress" IS NOT NULL`)).map((r) => r.v));
    inspectPhones('customer_contacts.value', (await rows(`SELECT DISTINCT "value" AS v FROM "customer_contacts" WHERE "value" NOT LIKE '%@%' AND "type"::text IN ('PHONE', 'MOBILE', 'WHATSAPP')`)).map((r) => r.v));
    check(`every phone number is in the demo range +971 59 000 xxxx (${phoneCount} distinct values in ${phoneColumns.length + 2} columns)`, badPhones.length === 0, badPhones.slice(0, 8).join('; '));

    const samples = await one(`
      SELECT (SELECT count(*)::int FROM "tenants" WHERE ("tradeLicenceNo" IS NOT NULL AND "tradeLicenceNo" NOT LIKE 'SAMPLE-%') OR ("taxRegistrationNo" IS NOT NULL AND "taxRegistrationNo" NOT LIKE 'SAMPLE-%')) AS tenants,
             (SELECT count(*)::int FROM "corporate_accounts" WHERE ("tradeLicenceNo" IS NOT NULL AND "tradeLicenceNo" NOT LIKE 'SAMPLE-%') OR ("taxRegistrationNo" IS NOT NULL AND "taxRegistrationNo" NOT LIKE 'SAMPLE-%')) AS companies,
             (SELECT count(*)::int FROM "request_external_references" WHERE ("referenceNo" IS NOT NULL AND "referenceNo" NOT LIKE 'SAMPLE-%') OR ("partnerReference" IS NOT NULL AND "partnerReference" NOT LIKE 'SAMPLE-%')) AS external_refs,
             (SELECT count(*)::int FROM "request_external_references" WHERE ("authorityName" IS NOT NULL AND "authorityName" NOT ILIKE '%fictional%') OR ("partnerName" IS NOT NULL AND "partnerName" NOT ILIKE '%fictional%')) AS authorities,
             (SELECT count(*)::int FROM "corporate_accounts" WHERE "companyName" NOT ILIKE '%demo%') AS company_names,
             (SELECT count(*)::int FROM "payments" WHERE "reference" IS NOT NULL AND "reference" NOT LIKE '%SAMPLE-%' AND "method" <> 'ONLINE_GATEWAY') AS payment_refs`);
    check('licence, tax and external reference numbers are labelled sample values (SAMPLE-...)', samples.tenants === 0 && samples.companies === 0 && samples.external_refs === 0 && samples.payment_refs === 0, `${samples.tenants} centre, ${samples.companies} company, ${samples.external_refs} external, ${samples.payment_refs} payment reference(s) without the label`);
    check('companies, authorities and partners carry "demo" / "fictional" in their name', samples.company_names === 0 && samples.authorities === 0, `${samples.company_names} company name(s), ${samples.authorities} authority / partner name(s) without it`);

    const withIds = await one(`SELECT count(*) FILTER (WHERE "emiratesIdHash" IS NOT NULL)::int AS eid, count(*) FILTER (WHERE "passportNoHash" IS NOT NULL)::int AS passport FROM "customers"`);
    if (process.env.HMAC_KEY) {
      // The numbers are stored encrypted. Their keyed lookup hash (common/crypto.ts, blindIndex) is recomputed for
      // every value of the fake ranges 784-1900-0000NNN-C and TEST0NNNN; a stored hash outside that set is a number
      // the seed's generator cannot have produced.
      const luhn = (digits) => {
        let total = 0;
        for (let i = 0; i < digits.length; i++) {
          let x = Number(digits[digits.length - 1 - i]);
          if (i % 2 === 0) {
            x *= 2;
            if (x > 9) x -= 9;
          }
          total += x;
        }
        return (10 - (total % 10)) % 10;
      };
      const index = (tenantId, kind, value) => createHmac('sha256', process.env.HMAC_KEY).update(`${tenantId}|${kind}|${value}`).digest('hex');
      const fake = new Set();
      for (const id of ids) {
        for (let i = 0; i < 2000; i++) {
          const body = `7841900${String(i).padStart(7, '0')}`;
          fake.add(index(id, 'emiratesId', `${body}${(luhn(body) + 1) % 10}`));
          fake.add(index(id, 'passport', `TEST${String(i).padStart(5, '0')}`));
        }
      }
      const stored = await rows(`SELECT "customerNo", "emiratesIdHash" AS e, "passportNoHash" AS p FROM "customers" WHERE "emiratesIdHash" IS NOT NULL OR "passportNoHash" IS NOT NULL`);
      const outside = stored.filter((r) => (r.e && !fake.has(r.e)) || (r.p && !fake.has(r.p)));
      check(`every Emirates ID (${withIds.eid}) and passport number (${withIds.passport}) is from the fake demo ranges`, outside.length === 0, outside.length ? `${outside.length} outside, e.g. customer ${outside[0].customerNo} (wrong HMAC_KEY for this database?)` : '784-1900-0000NNN-C with a wrong check digit, TEST0NNNN');
    } else {
      console.log(`   skip  Emirates ID / passport ranges (${withIds.eid} + ${withIds.passport} stored encrypted): set HMAC_KEY to the API's value to check them`);
    }
    // Files the application generates itself (personal data exports) are not uploads and keep their own names.
    const watermark = await one(`SELECT count(*)::int AS files, count(*) FILTER (WHERE v."originalFilename" NOT ILIKE 'sample-%')::int AS unlabelled
                                 FROM "document_versions" v JOIN "documents" d ON d."id" = v."documentId" WHERE d."documentTypeKey" <> 'data_export'`);
    check(`every uploaded file is a generated sample (${watermark.files} files named sample-...)`, watermark.unlabelled === 0, `${watermark.unlabelled} with another file name`);
  } finally {
    await db.end();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed.${failed.length ? ` FAILED: ${failed.map((f) => f.name).join(' | ')}` : ''}`);
  return failed.length ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e?.stack ?? e);
    process.exit(1);
  });
