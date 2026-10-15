import type { CompanyFx, CustomerFx, PersonFx } from './fixture-types';
import { daysAgo, isoDay, step } from './runtime';
import { CustomerState, SeedContext, TenantState } from './state';

const emailOf = (fullName: string) =>
  `${fullName
    .toLowerCase()
    .replace(/[^a-z]+/g, '.')
    .replace(/^\.|\.$/g, '')}@example.test`;

const EMIRATE_OF: Record<string, string> = { Dubai: 'Dubai', Sharjah: 'Sharjah', 'Abu Dhabi': 'Abu Dhabi', Ajman: 'Ajman' };

/** Identity details of a person: fake numbers, plausible expiry dates. */
function identityOf(ctx: SeedContext, t: TenantState, person: PersonFx, want: { emiratesId?: boolean; passport?: boolean } = {}) {
  const n = ctx.nextIdentity();
  const rng = t.rng(`identity:${person.key}`);
  const out: { emiratesId?: string; emiratesIdExpiry?: string; passportNo?: string; passportCountry?: string; passportExpiry?: string } = {};
  if (want.emiratesId !== false) {
    out.emiratesId = ctx.fixtures.identity.emiratesId(n);
    out.emiratesIdExpiry = isoDay(daysAgo(-rng.int(40, 1400)));
  }
  if (want.passport !== false) {
    out.passportNo = ctx.fixtures.identity.passportNo(n);
    out.passportCountry = person.nationality;
    out.passportExpiry = isoDay(daysAgo(-rng.int(200, 3000)));
  }
  return { n, fields: out };
}

function remember(t: TenantState, state: Omit<CustomerState, 'vault'>): CustomerState {
  const full: CustomerState = { ...state, vault: new Map() };
  t.customers.set(state.key, full);
  return full;
}

/** Customers of a centre: registered at the counter by staff, or by themselves on the portal. */
export async function createCustomers(ctx: SeedContext, t: TenantState): Promise<void> {
  const { rt, fixtures } = ctx;
  const anon = rt.anonymous();

  await step(`${t.fx.name}: ${t.fx.customers.length} customers`, async () => {
    // Oldest first, so customer numbers grow with time like they would in real life.
    const ordered = [...t.fx.customers].sort((a, b) => b.since - a.since);
    for (const c of ordered) {
      // A little before opening-hours "now" of that day: the record exists before a request of the same morning.
      const at = ctx.timeline.office(daysAgo(c.since), 20);
      // Account messages without a record of their own (portal invitation, verification) follow the centre's timeline.
      ctx.timeline.mark(t.id, at);
      const pin = ctx.timeline.begin(at);
      const { n, fields } = identityOf(ctx, t, c, c.identity);
      const email = c.noEmail ? null : emailOf(c.fullName);
      const phone = c.noPhone ? null : fixtures.identity.phone(n);
      const profile = {
        fullNameAr: c.fullNameAr ?? null,
        preferredLanguage: c.language ?? 'en',
        nationality: c.nationality,
        dateOfBirth: c.dateOfBirth,
        address: { line1: 'Sample address (fictional)', city: c.city ?? t.fx.emirate, emirate: EMIRATE_OF[c.city ?? ''] ?? t.fx.emirate, country: 'AE' },
        ...fields,
        communicationPrefs: { whatsapp: !!c.whatsapp },
        tagIds: (c.tags ?? []).map((name) => t.tags.get(name)).filter((x): x is string => !!x),
      };

      let state: CustomerState;
      if (c.portal === 'SELF') {
        // The customer registers on the centre's portal; staff complete the profile at the first visit.
        if (!email) throw new Error(`${t.slug}: customer ${c.key} registers on the portal and therefore needs an email address.`);
        const reg = await anon.post('/auth/register', { tenantSlug: t.slug, fullName: c.fullName, email, ...(phone ? { phone } : {}), password: rt.password, preferredLanguage: c.language ?? 'en', acceptTerms: true, marketingOptIn: !!c.marketing });
        await anon.post('/auth/verify-email', { token: reg.dev.emailVerificationToken });
        const actor = await rt.login(email, 'customer', t.slug, `${t.slug} customer ${c.key}`);
        if (!actor.customerId) throw new Error(`${t.slug}: the portal login of ${c.key} is not linked to a customer record.`);
        const row = await rt.as(t.receptionist()).patch(`/customers/${actor.customerId}`, profile);
        state = remember(t, { key: c.key, id: row.id, customerNo: row.customerNo, person: c, fx: c, email, phone, identityNo: n, ids: fields, portal: actor });
        pin(row.id, actor.userId, actor.membershipId);
        ctx.credentials.push({ tenant: t.fx.name, slug: t.slug, app: 'Customer portal', role: 'Customer (registered online)', name: c.fullName, email });
      } else {
        const registrar = t.actor(c.registeredBy ?? t.fx.staff.find((s) => s.roleKey === 'receptionist')?.key ?? 'owner');
        const row = await rt.as(registrar).post('/customers', { type: 'INDIVIDUAL', fullName: c.fullName, email, phone, marketingOptIn: !!c.marketing, ...profile });
        state = remember(t, { key: c.key, id: row.id, customerNo: row.customerNo, person: c, fx: c, email, phone, identityNo: n, ids: fields });
        pin(row.id);
      }
      await afterRegistration(ctx, t, c, state);
    }
    return t.customers.size;
  });
}

async function afterRegistration(ctx: SeedContext, t: TenantState, c: CustomerFx, state: CustomerState): Promise<void> {
  const { rt, fixtures } = ctx;
  const desk = rt.as(t.receptionist());
  for (const consent of c.consents ?? []) await desk.put(`/customers/${state.id}/consents`, { purpose: consent.purpose, granted: consent.granted, noticeVersion: 'demo-v1' });
  for (const [i, contact] of (c.extraContacts ?? []).entries()) {
    const value = contact.type === 'EMAIL' ? `alt.${state.email ?? `${c.key}@example.test`}` : fixtures.identity.phone(500 + state.identityNo + i);
    await desk.post(`/customers/${state.id}/contacts`, { type: contact.type, value, label: contact.label });
  }
  for (const note of c.notes ?? []) await rt.as(note.by ? t.actor(note.by) : t.receptionist()).post(`/customers/${state.id}/notes`, { body: note.body, isPinned: !!note.pinned });

  if (c.portal === 'INVITED' || c.portal === 'PENDING') {
    // Invited a little after registration.
    const invitedAt = ctx.timeline.office(daysAgo(Math.max(0.1, c.since * 0.9)));
    ctx.timeline.mark(t.id, invitedAt);
    const pin = ctx.timeline.begin(invitedAt);
    const invite = await desk.post(`/customers/${state.id}/portal-invitation`, {});
    if (c.portal === 'INVITED') {
      const accepted = await rt.anonymous().post('/auth/invitations/accept', { token: invite.dev.invitationToken, password: rt.password, app: 'customer' });
      if (accepted.status !== 'OK') throw new Error(`Portal invitation of ${state.email} ended with ${accepted.status}`);
      state.portal = rt.actorFrom(accepted, state.email!, 'customer', t.slug, `${t.slug} customer ${c.key}`);
      pin(state.portal.userId, state.portal.membershipId);
      ctx.credentials.push({ tenant: t.fx.name, slug: t.slug, app: 'Customer portal', role: 'Customer (invited by the centre)', name: c.fullName, email: state.email! });
    } else {
      pin(invite.membershipId);
    }
  }
  if (c.archived) await rt.as(t.decider()).post(`/customers/${state.id}/archive`, { reason: c.archived });
}

/** Corporate customers: account, verification, credit, contacts, employees, agreement, contract prices. */
export async function createCompanies(ctx: SeedContext, t: TenantState): Promise<void> {
  const { rt, fixtures } = ctx;
  const companies = t.fx.companies ?? [];
  if (!companies.length) return;
  const owner = rt.as(t.owner);

  await step(`${t.fx.name}: ${companies.length} corporate account(s) with contacts and employees`, async () => {
    let employees = 0;
    for (const co of [...companies].sort((a, b) => b.since - a.since)) {
      const at = ctx.timeline.office(daysAgo(co.since), 20);
      ctx.timeline.mark(t.id, at);
      const pin = ctx.timeline.begin(at);
      const terms = co.credit ?? co.proposedTerms;
      const account = await owner.post('/corporate-accounts', {
        companyName: co.companyName,
        companyNameAr: co.companyNameAr ?? null,
        tradeLicenceNo: fixtures.identity.tradeLicenceNo(ctx.nextIdentity()),
        tradeLicenceAuthority: 'Sample licensing authority (fictional)',
        tradeLicenceExpiry: isoDay(daysAgo(-t.rng(`company:${co.key}`).int(20, 300))),
        billingEmail: `accounts@${co.emailDomain}`,
        billingAddress: { line1: 'Sample office address (fictional)', city: co.city, emirate: co.city, country: 'AE' },
        ...(terms ? { paymentTermsDays: terms.termsDays, creditLimit: co.proposedTerms ? co.proposedTerms.limit : terms.limit } : {}),
        notes: co.notes ?? null,
      });
      pin(account.id);
      const state = { key: co.key, fx: co, id: account.id, accountNo: account.accountNo } as ReturnType<TenantState['company']>;
      t.companies.set(co.key, state);

      if (co.state !== 'PENDING') await owner.post(`/corporate-accounts/${account.id}/verify`, { note: co.verificationNote ?? 'Trade licence copy checked (demo).' });
      if (co.credit) await owner.post(`/corporate-accounts/${account.id}/credit`, { approved: true, creditLimit: co.credit.limit, paymentTermsDays: co.credit.termsDays, note: co.credit.note });

      const prepared = co.employees.map((e) => ({ e, ...identityOf(ctx, t, e) }));
      const created = await owner.post(`/corporate-accounts/${account.id}/employees/bulk`, {
        employees: prepared.map(({ e, n, fields }) => ({ fullName: e.fullName, fullNameAr: e.fullNameAr ?? null, email: emailOf(e.fullName), phone: fixtures.identity.phone(n), nationality: e.nationality, dateOfBirth: e.dateOfBirth, ...fields, employeeNo: e.employeeNo, designation: e.designation })),
      });
      if (created.createdCount !== co.employees.length) throw new Error(`${co.companyName}: ${created.skippedCount} employee(s) were skipped.`);
      for (const row of created.created) {
        const { e, n } = prepared[row.index];
        const { fields } = prepared[row.index];
        remember(t, { key: e.key, id: row.customerId, customerNo: row.customerNo, person: e, email: emailOf(e.fullName), phone: fixtures.identity.phone(n), identityNo: n, ids: fields, companyKey: co.key, employeeId: row.id });
        ctx.timeline.alias(row.customerId, account.id);
        employees += 1;
      }

      for (const m of co.members) {
        const email = `${m.login}@${co.emailDomain}`;
        const invite = await owner.post(`/corporate-accounts/${account.id}/members`, { fullName: m.fullName, email, phone: fixtures.identity.phone(ctx.nextIdentity()), isAuthorisedSignatory: !!m.signatory });
        if (!m.accept) continue;
        const accepted = await rt.anonymous().post('/auth/invitations/accept', { token: invite.dev.invitationToken, password: rt.password, app: 'corporate' });
        if (accepted.status !== 'OK') throw new Error(`Corporate invitation of ${email} ended with ${accepted.status}`);
        const actor = rt.actorFrom(accepted, email, 'corporate', t.slug, `${t.slug} ${co.key} admin`);
        state.admin ??= actor;
        ctx.timeline.alias(actor.userId, account.id);
        if (actor.membershipId) ctx.timeline.alias(actor.membershipId, account.id);
        ctx.credentials.push({ tenant: t.fx.name, slug: t.slug, app: 'Corporate portal', role: 'Corporate administrator', name: `${m.fullName} (${co.companyName})`, email, note: co.state === 'SUSPENDED' ? 'company is suspended: read-only' : undefined });
      }

      if (co.agreement) {
        const starts = daysAgo(co.agreement.startsDaysAgo);
        const ends = new Date(starts);
        ends.setUTCMonth(ends.getUTCMonth() + co.agreement.months);
        await owner.post(`/corporate-accounts/${account.id}/agreements`, { title: co.agreement.title, terms: co.agreement.terms, startsOn: isoDay(starts), endsOn: isoDay(ends), status: co.agreement.status });
      }
      for (const p of co.contractPrices ?? []) await owner.put(`/corporate-accounts/${account.id}/prices`, { serviceId: t.service(p.service).id, serviceFee: p.fee });

      if (co.businessProfile) {
        // The company's own customer profile, used for requests and invoices of the company itself.
        const profile = await owner.post('/customers', { type: 'BUSINESS', fullName: co.companyName, fullNameAr: co.companyNameAr ?? null, email: `accounts@${co.emailDomain}`, corporateAccountId: account.id, address: { line1: 'Sample office address (fictional)', city: co.city, emirate: co.city, country: 'AE' }, confirmNotDuplicate: true });
        const person: PersonFx = { key: co.key, fullName: co.companyName, nationality: 'AE', dateOfBirth: '2000-01-01' };
        remember(t, { key: co.key, id: profile.id, customerNo: profile.customerNo, person, email: `accounts@${co.emailDomain}`, phone: null, identityNo: 0, ids: {}, companyKey: co.key });
        ctx.timeline.alias(profile.id, account.id);
        state.profileCustomerKey = co.key;
      }
    }
    return employees;
  }, (n) => `${n} employees`);
}

/** Suspensions happen after the company's history exists (a suspended company cannot start requests). */
export async function suspendCompanies(ctx: SeedContext, t: TenantState): Promise<void> {
  const suspended = (t.fx.companies ?? []).filter((c: CompanyFx) => c.state === 'SUSPENDED');
  if (!suspended.length) return;
  await step(`${t.fx.name}: ${suspended.length} corporate account(s) suspended`, async () => {
    for (const co of suspended) await ctx.rt.as(t.owner).post(`/corporate-accounts/${t.company(co.key).id}/suspend`, { reason: co.suspendReason ?? 'Suspended (demo).' });
  });
}
