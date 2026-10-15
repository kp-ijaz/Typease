import type { DemoFixtures } from './fixture-types';
import { ApiError, need, step } from './runtime';
import { SeedContext, TenantState } from './state';

/** Catches mistakes in the data modules before anything is written, with a message that names the entry. */
export function validateFixtures(fx: DemoFixtures): void {
  const problems: string[] = [];
  const slugs = new Set<string>();
  for (const t of fx.tenants) {
    if (slugs.has(t.slug)) problems.push(`duplicate centre slug ${t.slug}`);
    slugs.add(t.slug);
    const branches = new Set(t.branches.map((b) => b.code));
    const staff = new Map([t.owner, ...t.staff].map((s) => [s.key, s]));
    const people = new Set<string>([...t.customers.map((c) => c.key), ...(t.companies ?? []).flatMap((c) => [...c.employees.map((e) => e.key), ...(c.businessProfile ? [c.key] : [])])]);
    const companies = new Set((t.companies ?? []).map((c) => c.key));
    const refs = new Set<string>();
    const at = (what: string) => `${t.slug}: ${what}`;
    if (people.size !== t.customers.length + (t.companies ?? []).reduce((n, c) => n + c.employees.length + (c.businessProfile ? 1 : 0), 0)) problems.push(at('customer / employee keys are not unique'));
    for (const s of t.staff) for (const b of s.branches === 'ALL' ? [] : s.branches) if (!branches.has(b)) problems.push(at(`staff ${s.key} works at unknown branch ${b}`));
    for (const r of t.requests) {
      if (refs.has(r.ref)) problems.push(at(`duplicate request ref ${r.ref}`));
      refs.add(r.ref);
      if (!people.has(r.customer)) problems.push(at(`request ${r.ref} is for unknown customer ${r.customer}`));
      if (r.branch && !branches.has(r.branch)) problems.push(at(`request ${r.ref} is at unknown branch ${r.branch}`));
      if (r.company && !companies.has(r.company)) problems.push(at(`request ${r.ref} is billed to unknown company ${r.company}`));
      if (r.operator && r.operator !== 'AUTO') {
        const op = staff.get(r.operator);
        if (!op) problems.push(at(`request ${r.ref} names unknown operator ${r.operator}`));
        else if (op.branches !== 'ALL' && !op.branches.includes(r.branch ?? t.branches[0].code)) problems.push(at(`request ${r.ref}: operator ${r.operator} does not work at branch ${r.branch ?? t.branches[0].code}`));
      }
      if (r.start < r.end) problems.push(at(`request ${r.ref} ends before it starts`));
      if (r.duplicateOf && !t.requests.some((o) => o.ref === r.duplicateOf && o.start >= r.start)) problems.push(at(`request ${r.ref} is a duplicate of ${r.duplicateOf}, which must exist and start earlier`));
      const portal = t.customers.find((c) => c.key === r.customer)?.portal;
      if ((r.via === 'PORTAL' || r.rating || r.quotation?.approvedBy === 'CUSTOMER' || r.cancel?.by === 'CUSTOMER') && portal !== 'SELF' && portal !== 'INVITED') {
        problems.push(at(`request ${r.ref} needs customer ${r.customer} to have a portal account`));
      }
    }
    for (const k of t.tickets ?? []) if (k.request && !refs.has(k.request)) problems.push(at(`ticket ${k.ref} refers to unknown request ${k.request}`));
    for (const k of t.tasks ?? []) if (k.request && !refs.has(k.request)) problems.push(at(`task "${k.title}" refers to unknown request ${k.request}`));
  }
  if (problems.length) throw new Error(`The demo data in database/seed is inconsistent:\n  - ${problems.join('\n  - ')}`);
}

/**
 * Shows, with real calls, that one centre cannot reach another centre's rows,
 * that customers and companies only reach their own, and where the Starter
 * plan stops. Every call here is EXPECTED to be refused; a success stops the seed.
 */
export async function demonstrateBoundaries(ctx: SeedContext): Promise<void> {
  const { rt } = ctx;
  const [a, b] = ctx.tenants;
  const small = ctx.tenants.find((t) => t.fx.planLimitDemo);

  await step('Tenant isolation: direct access to another centre\'s rows answers 404', async () => {
    const checks: Array<[string, Promise<ApiError>]> = [];
    const bCustomer = [...b.customers.values()][0];
    const bRequest = [...b.requests.values()].find((r) => r.invoiceId)!;
    const aRequest = [...a.requests.values()].find((r) => r.invoiceId)!;
    const aCustomer = [...a.customers.values()][0];
    const refuse = (who: TenantState, path: string) => rt.as(who.owner).expectRefusal('GET', path, undefined, { status: 404 });
    checks.push([`${a.slug} owner -> ${b.slug} customer`, refuse(a, `/customers/${bCustomer.id}`)]);
    checks.push([`${a.slug} owner -> ${b.slug} request`, refuse(a, `/requests/${bRequest.id}`)]);
    checks.push([`${a.slug} owner -> ${b.slug} invoice`, refuse(a, `/invoices/${bRequest.invoiceId}`)]);
    checks.push([`${a.slug} owner -> ${b.slug} payment`, refuse(a, `/payments/${bRequest.paymentIds[0] ?? bRequest.id}`)]);
    checks.push([`${b.slug} owner -> ${a.slug} customer`, refuse(b, `/customers/${aCustomer.id}`)]);
    checks.push([`${b.slug} owner -> ${a.slug} request`, refuse(b, `/requests/${aRequest.id}`)]);
    checks.push([`${b.slug} owner -> ${a.slug} quotation`, refuse(b, `/quotations/${aRequest.quotationId}`)]);
    // Inside one centre: a customer and a company see only what is theirs.
    const portalUser = [...a.customers.values()].find((c) => c.portal)!;
    const foreign = [...a.requests.values()].find((r) => r.customerKey !== portalUser.key && !a.customer(r.customerKey).companyKey)!;
    checks.push([`customer ${portalUser.person.fullName} -> another customer's request`, rt.as(portalUser.portal!).expectRefusal('GET', `/requests/${foreign.id}`, undefined, { status: 404 })]);
    const withAdmin = [...a.companies.values()].filter((c) => c.admin);
    if (withAdmin.length >= 2) {
      const otherEmployee = [...a.customers.values()].find((c) => c.companyKey === withAdmin[1].key && c.employeeId)!;
      checks.push([`${withAdmin[0].fx.companyName} admin -> employee of ${withAdmin[1].fx.companyName}`, rt.as(withAdmin[0].admin!).expectRefusal('GET', `/corporate/employees/${otherEmployee.employeeId}`, undefined, { status: 404 })]);
    }
    // Staff limited to a branch do not see requests of another branch.
    const limited = a.fx.staff.find((s) => s.roleKey === 'receptionist' && s.branches !== 'ALL');
    if (limited) {
      const elsewhere = [...a.requests.values()].find((r) => !(limited.branches as string[]).includes(r.branchCode));
      if (elsewhere) checks.push([`${limited.fullName} (${(limited.branches as string[]).join('/')} only) -> request of branch ${elsewhere.branchCode}`, rt.as(a.actor(limited.key)).expectRefusal('GET', `/requests/${elsewhere.id}`, undefined, { status: 404 })]);
    }
    for (const [what, call] of checks) {
      const refusal = await call;
      ctx.highlights.push(`Isolation: ${what} -> ${refusal.status} ${refusal.code}`);
    }
    return checks.length;
  }, (n) => `${n} cross-boundary reads refused`);

  if (small) {
    await step(`Plan limits: what ${small.fx.name} (Starter, trial) cannot do`, async () => {
      const owner = rt.as(small.owner);
      const br = small.fx.planLimitDemo!.secondBranch;
      const refusals: ApiError[] = [];
      refusals.push(await owner.expectRefusal('POST', '/branches', { code: br.code, name: br.name, address: br.address, emirate: br.emirate }, { status: 402, code: 'PLAN_LIMIT_REACHED' }));
      refusals.push(await owner.expectRefusal('POST', '/corporate-accounts', { companyName: 'Not Allowed Demo LLC' }, { status: 402, code: 'PLAN_LIMIT_REACHED' }));
      refusals.push(await owner.expectRefusal('PUT', '/branding', { mode: 'WHITE_LABEL', primaryColor: '#AA3355' }, { status: 402, code: 'PLAN_LIMIT_REACHED' }));
      refusals.push(await owner.expectRefusal('POST', '/domains', { domain: 'portal.desert-rose-demo.test', app: 'customer' }, { status: 402, code: 'PLAN_LIMIT_REACHED' }));
      for (const r of refusals) ctx.highlights.push(`Plan limit (${small.fx.name}): ${r.method} ${r.path} -> ${r.status} ${r.code}: ${r.apiMessage}`);
      return refusals.length;
    }, (n) => `${n} actions refused with 402 PLAN_LIMIT_REACHED`);
  }
}

/** The jobs the worker runs on a schedule, run once so that derived data (expiries, escalations, reminders) exists. */
export const CLOSING_JOBS = [
  'finance.quotations.expire',
  'workflows.scan',
  'support.sla',
  'tasks.overdue_scan',
  'appointments.no_shows',
  'appointments.reminders',
  'reminders.scan',
  'notifications.maintenance',
];

export async function backdateAndRunJobs(ctx: SeedContext): Promise<void> {
  const { rt } = ctx;
  await step('Activity spread over the past weeks (creation-style timestamps moved back)', async () => {
    const result = await ctx.timeline.apply(rt.sys);
    ctx.noteDirectDb('creation-style timestamps (createdAt, updatedAt, sentAt, decidedAt, verifiedAt, dueAt ...) of non-append-only rows are moved into the past in one pass; append-only tables and the fields protected by the immutability triggers are not touched (see services/api/src/cli/seed/timeline.ts for the exact list).');
    return result;
  }, (r) => `${r.rows} row updates in ${r.statements} statements`);

  await step('Scheduled jobs run once (quotation expiry, escalations, support SLA, no-shows, expiry reminders)', async () => {
    const registered = new Set(rt.jobs.names());
    const ran: string[] = [];
    for (const name of CLOSING_JOBS) {
      if (!registered.has(name)) continue;
      await rt.runScheduled(name);
      ran.push(name);
    }
    // Events raised by the jobs (escalations, reminders) lead to notifications: deliver them too.
    await rt.settle(12);
    return ran;
  }, (ran) => ran.join(', '));

  // A quotation that ran out: finance marks it EXPIRED, the workflow scan sends the request back for a revised offer.
  const lapsing = ctx.tenants.flatMap((t) => t.fx.requests.filter((r) => r.quotation?.expires).map((r) => ({ t, state: t.request(r.ref) })));
  if (lapsing.length) {
    await step('Requests whose quotation ran out are back with the centre for a revised offer', async () => {
      for (const { t, state } of lapsing) {
        const quotation = (await rt.as(t.owner).get(`/quotations/${need(state.quotationId, `a quotation on ${state.requestNo}`)}`)) as { status: string; quotationNo: string };
        if (quotation.status !== 'EXPIRED') throw new Error(`${state.requestNo}: quotation ${quotation.quotationNo} should have expired, but it is ${quotation.status}. Check the validity period against the scenario dates.`);
        const request = (await rt.as(t.owner).get(`/requests/${state.id}`)) as { status: string };
        if (request.status !== 'UNDER_REVIEW') throw new Error(`${state.requestNo}: the quotation expired, so the request should be UNDER_REVIEW again, but it is ${request.status}.`);
        state.status = request.status;
        ctx.highlights.push(`Expired quotation (${t.fx.name}): ${quotation.quotationNo} of request ${state.requestNo} ran out unanswered; the request went back to "Under review" with a new quotation task.`);
      }
      return lapsing.length;
    }, (n) => `${n} request${n === 1 ? '' : 's'}`);
  }
}

const APP_KEYS = { 'Centre app': 'centre', 'Customer portal': 'customer', 'Corporate portal': 'corporate', 'Platform console': 'platform' } as const;

/** Every login the demo guide lists is tried once with the shared password, from a fresh sign-in. */
export async function verifyLogins(ctx: SeedContext): Promise<void> {
  await step(`Every demo login signs in with the shared password`, async () => {
    for (const c of ctx.credentials) {
      const actor = await ctx.rt.login(c.email, APP_KEYS[c.app], c.slug, `${c.role} ${c.email}`);
      const me = await ctx.rt.as(actor).get('/auth/me');
      if (!me) throw new Error(`${c.email}: signed in, but GET /auth/me returned nothing.`);
    }
    return ctx.credentials.length;
  }, (n) => `${n} accounts`);
}

export function printSummary(ctx: SeedContext): void {
  console.log('\n== What was created');
  for (const t of ctx.tenants) {
    const c = t.counts;
    const parts = [
      `${t.customers.size} customers`,
      `${t.companies.size} companies`,
      `${t.requests.size} requests`,
      `${c.documents ?? 0} documents uploaded`,
      `${c.quotations ?? 0} quotations`,
      `${c.invoices ?? 0} invoices`,
      `${c.payments ?? 0} payments`,
      `${c.refunds ?? 0} refunds`,
      `${c.expenses ?? 0} expenses`,
      `${c.appointments ?? 0} appointments`,
      `${c.tickets ?? 0} tickets`,
      `${c.subscriptionInvoicesPaid ?? 0} paid subscription invoices`,
    ];
    console.log(`   ${t.fx.name} (${t.slug}, ${t.fx.planKey}): ${parts.join(', ')}`);
  }
  if (ctx.highlights.length) {
    console.log('\n== Demonstrated during the seed');
    for (const h of ctx.highlights) console.log(`   ${h}`);
  }
  const tracked = ctx.tenants.flatMap((t) => [...t.requests.values()].filter((r) => r.trackingCode && !['DRAFT'].includes(r.status)).slice(-1).map((r) => `${t.slug}: request ${r.requestNo}, tracking code ${r.trackingCode}`));
  if (tracked.length) {
    console.log('\n== Public tracking (tracking codes are shown once, at submission - note them now)');
    for (const line of tracked) console.log(`   ${line}`);
  }
  console.log('\n== Direct database writes (everything else went through the HTTP API)');
  for (const d of ctx.directDb) console.log(`   - ${d}`);

  console.log(`\n== Demo logins (password for every account: ${ctx.rt.password})`);
  // Grouped by centre in the order the centres were created; inside a centre: staff, customers, company users.
  const groups = new Map<string, typeof ctx.credentials>();
  for (const c of ctx.credentials) groups.set(c.tenant, [...(groups.get(c.tenant) ?? []), c]);
  for (const [tenant, list] of groups) {
    console.log(`   ${tenant}`);
    const apps = [...new Set(list.map((c) => c.app))];
    for (const c of [...list].sort((a, b) => apps.indexOf(a.app) - apps.indexOf(b.app))) {
      console.log(`     ${c.app.padEnd(16)} ${c.role.padEnd(32)} ${c.email.padEnd(40)} ${c.name}${c.note ? `  [${c.note}]` : ''}`);
    }
  }
  console.log('\n   FOR LOCAL DEVELOPMENT ONLY - never deploy known demo passwords to production.');
  console.log('   Guide: docs/DEMO_ENVIRONMENT.md   Check the result: node scripts/seed-verify.mjs');
}
