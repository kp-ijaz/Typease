#!/usr/bin/env node
/**
 * TypEase development quick start.
 *
 * Creates (or re-uses) demo data in a RUNNING development API so that the four
 * web apps have something to show. It only talks to the public REST API with
 * plain `fetch`; it never touches the database.
 *
 *   node scripts/dev-quickstart.mjs                  # print the credentials
 *   node scripts/dev-quickstart.mjs --out creds.json # also write them as JSON
 *   node scripts/dev-quickstart.mjs --api http://localhost:4000
 *
 * The script is idempotent: every run ends with the same two centres, the same
 * logins and at least the same customers and requests. It needs an API started
 * with EXPOSE_DEV_TOKENS=true (verification / invitation tokens are read from
 * the `dev` field of the responses), which is the case for `scripts/dev-api.sh`.
 *
 * What you get:
 *   1. "Al Noor Typing Centre" (slug alnoor-demo): Business plan, WHITE-LABEL
 *      branding (its own colours), starter catalogue, customers, requests in
 *      several states, a portal customer and a corporate client with an admin.
 *   2. "Gulf Express Typing" (slug gulf-demo): Starter plan, TypEase branding,
 *      public catalogue, a few customers and requests.
 */
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const API = (arg('api', process.env.TYPEASE_API_URL ?? 'http://localhost:4000')).replace(/\/$/, '') + '/api/v1';
const OUT = arg('out', null);
const QUIET = args.includes('--quiet');
const PASSWORD = 'TypEase-Demo-2026';

const log = (...a) => {
  if (!QUIET) console.log(...a);
};

class ApiError extends Error {
  constructor(status, body, path) {
    super(`${path} -> ${status} ${body?.code ?? ''} ${body?.message ?? ''}`);
    this.status = status;
    this.code = body?.code;
    this.body = body;
  }
}

/** Minimal API helper. `app` decides which refresh cookie / session kind the API issues. */
function client(app, token) {
  const call = async (method, path, body, extraHeaders = {}) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-client-app': app,
        'x-requested-with': 'typease',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { message: text.slice(0, 200) };
    }
    if (!res.ok) throw new ApiError(res.status, json, `${method} ${path}`);
    return json;
  };
  return {
    get: (p) => call('GET', p),
    post: (p, b = {}, h) => call('POST', p, b, h),
    put: (p, b = {}) => call('PUT', p, b),
    patch: (p, b = {}) => call('PATCH', p, b),
    withToken: (t) => client(app, t),
  };
}

/** Runs a step and ignores the listed error codes (used for "already done" answers). */
async function tolerate(codes, fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError && (codes.includes(e.code) || codes.includes(e.status))) return null;
    throw e;
  }
}

async function login(app, email, tenantSlug) {
  const anon = client(app);
  const body = { email, password: PASSWORD, app, ...(tenantSlug ? { tenantSlug } : {}) };
  let result = await anon.post('/auth/login', body);
  if (result.status === 'SELECT_TENANT') {
    const m = result.memberships.find((x) => x.tenantSlug === tenantSlug) ?? result.memberships[0];
    result = await anon.post('/auth/select-tenant', { selectionToken: result.selectionToken, membershipId: m.membershipId });
  }
  if (result.status !== 'OK') throw new Error(`Login of ${email} needs ${result.status}; this script expects demo users without two-step verification.`);
  return { api: client(app, result.accessToken), session: result.session };
}

async function ensureCentre({ slug, businessName, ownerName, email, phone, planKey, emirate, branding }) {
  const anon = client('centre');
  const signup = await tolerate(['SLUG_TAKEN', 'ACCOUNT_EXISTS'], () =>
    anon.post('/public/signup', { businessName, slug, ownerName, email, phone, password: PASSWORD, preferredLanguage: 'en', acceptTerms: true }),
  );
  if (signup) {
    const token = signup.dev?.emailVerificationToken;
    if (!token) throw new Error('The API did not return a dev verification token. Start it with EXPOSE_DEV_TOKENS=true.');
    await anon.post('/auth/verify-email', { token });
    log(`  created centre ${slug}`);
  } else {
    // A previous run may have stopped before the email was verified.
    const again = await tolerate([400, 404, 409, 429], () => anon.post('/auth/resend-verification', { email }));
    if (again?.dev?.emailVerificationToken) await tolerate([400], () => anon.post('/auth/verify-email', { token: again.dev.emailVerificationToken }));
    log(`  centre ${slug} already exists`);
  }

  const { api } = await login('centre', email, slug);
  const state = await api.get('/onboarding');
  if (state.tenant?.status === 'ONBOARDING' || state.status === 'ONBOARDING' || state.completed === false) {
    await tolerate([409, 422, 400], () => api.post('/onboarding/plan', { planKey, billingCycle: 'MONTHLY' }));
    await tolerate([409], () =>
      api.put('/onboarding/business', { legalName: `${businessName} LLC`, emirate, contactEmail: email, contactPhone: phone, defaultLanguage: 'en', tradeLicenceNo: `CN-${slug.length}04512` }),
    );
    await tolerate([409], () => api.post('/services/starter-catalogue', {}));
    await tolerate([409, 422], () => api.post('/onboarding/complete', {}));
  }
  // Safe to repeat: the starter catalogue only adds what is missing.
  const services = await api.get('/services?pageSize=100');
  if ((services.data ?? []).length === 0) await api.post('/services/starter-catalogue', {});
  if (branding) await api.put('/branding', branding);
  // Fresh login: the first token was issued while the centre was still onboarding.
  return login('centre', email, slug);
}

async function ensureCustomers(api, people) {
  const out = [];
  for (const p of people) {
    const found = await api.get(`/customers?email=${encodeURIComponent(p.email)}&status=ALL&pageSize=1`);
    if (found.data.length) {
      out.push(found.data[0]);
      continue;
    }
    out.push(await api.post('/customers', { ...p, confirmNotDuplicate: true }));
  }
  return out;
}

/** Brings a request from DRAFT towards the wanted status using only transitions staff may trigger. */
async function ensureRequests(api, customers, plan) {
  const existing = await api.get('/requests?pageSize=100');
  if (existing.meta.total >= plan.length) return existing.meta.total;
  const services = (await api.get('/services?pageSize=100&isActive=true')).data;
  if (!services.length) throw new Error('The centre has no services. The starter catalogue was not installed.');
  let created = 0;
  for (let i = existing.meta.total; i < plan.length; i++) {
    const step = plan[i];
    const service = services[i % services.length];
    const customer = customers[i % customers.length];
    let request;
    try {
      request = await api.post('/requests', {
        serviceId: service.id,
        customerId: customer.id,
        priority: step.priority ?? 'NORMAL',
        instructions: step.instructions ?? null,
      });
    } catch (e) {
      log(`    could not create a request for ${service.name}: ${e.message}`);
      continue;
    }
    created++;
    if (step.target === 'DRAFT') continue;
    // Fill the form with harmless values so that submission passes validation, then walk the state machine.
    const full = await api.get(`/requests/${request.id}`);
    const values = {};
    for (const s of full.form?.schema?.steps ?? []) {
      for (const f of s.fields ?? []) {
        if (!f.required || full.form.values?.[f.key] != null) continue;
        values[f.key] =
          f.type === 'number' ? (f.min ?? 1)
          : f.type === 'date' ? '2027-01-15'
          : f.type === 'email' ? customer.email ?? 'demo@example.com'
          : f.type === 'phone' ? '+971500000000'
          : f.type === 'checkbox' ? true
          : f.type === 'multiselect' ? [f.options?.[0]?.value].filter(Boolean)
          : f.type === 'select' || f.type === 'radio' ? f.options?.[0]?.value
          : f.type === 'country' ? 'AE'
          : 'Demo';
      }
    }
    if (Object.keys(values).length) await tolerate([400, 422], () => api.put(`/requests/${request.id}/fields`, { values }));
    const submitted = await tolerate([400, 402, 409, 422], () => api.post(`/requests/${request.id}/submit`, {}));
    if (!submitted) continue;
    for (const to of step.path ?? []) {
      const ok = await tolerate([400, 402, 403, 409, 422], () =>
        api.post(`/requests/${request.id}/transition`, { to, reason: 'Demo data', customerMessage: to === 'AWAITING_CUSTOMER' ? 'Please upload a clearer passport copy.' : undefined }),
      );
      if (!ok) break;
    }
  }
  return existing.meta.total + created;
}

async function ensurePortalCustomer(slug, person) {
  const anon = client('customer');
  const reg = await tolerate(['ACCOUNT_EXISTS'], () =>
    anon.post('/auth/register', { tenantSlug: slug, fullName: person.fullName, email: person.email, phone: person.phone, password: PASSWORD, preferredLanguage: 'en', acceptTerms: true, marketingOptIn: false }),
  );
  if (reg?.dev?.emailVerificationToken) await anon.post('/auth/verify-email', { token: reg.dev.emailVerificationToken });
  return login('customer', person.email, slug);
}

async function ensureCorporate(api, slug, company, admin) {
  const list = await api.get(`/corporate-accounts?q=${encodeURIComponent(company.companyName)}&status=ALL`);
  let account = list.data[0];
  if (!account) account = await api.post('/corporate-accounts', company);
  if (account.status === 'PENDING_VERIFICATION') {
    await tolerate([409, 422], () => api.post(`/corporate-accounts/${account.id}/verify`, { note: 'Trade licence and authorisation letter seen (demo data).' }));
  }
  const members = await api.get(`/corporate-accounts/${account.id}/members`);
  let member = (members.data ?? members).find((m) => m.email === admin.email);
  if (!member) {
    member = await api.post(`/corporate-accounts/${account.id}/members`, { fullName: admin.fullName, email: admin.email, isAuthorisedSignatory: true });
    const token = member.dev?.invitationToken ?? member.dev?.token;
    if (token) await client('corporate').post('/auth/invitations/accept', { token, fullName: admin.fullName, password: PASSWORD, app: 'corporate' });
  } else if (member.status === 'INVITED') {
    const again = await tolerate([409, 422], () => api.post(`/corporate-accounts/${account.id}/members/${member.id}/resend-invitation`, {}));
    const token = again?.dev?.invitationToken ?? again?.dev?.token;
    if (token) await client('corporate').post('/auth/invitations/accept', { token, fullName: admin.fullName, password: PASSWORD, app: 'corporate' });
  }
  const employees = await api.get(`/corporate-accounts/${account.id}/employees?pageSize=1`);
  if (employees.meta.total === 0) {
    await tolerate([400, 409, 422], () =>
      api.post(`/corporate-accounts/${account.id}/employees/bulk`, {
        employees: [
          { fullName: 'Imran Qureshi', email: 'imran.qureshi@oryx-demo.test', jobTitle: 'Driver', nationality: 'PK' },
          { fullName: 'Maria Santos', email: 'maria.santos@oryx-demo.test', jobTitle: 'Accountant', nationality: 'PH' },
          { fullName: 'Yousef Haddad', email: 'yousef.haddad@oryx-demo.test', jobTitle: 'Operations Manager', nationality: 'JO' },
        ],
      }),
    );
  }
  return account;
}

const PEOPLE_A = [
  { fullName: 'Ahmed Khalid', fullNameAr: 'أحمد خالد', email: 'ahmed.khalid@demo-customers.test', phone: '+971501110001', nationality: 'AE', preferredLanguage: 'ar' },
  { fullName: 'Sara Mohammed', fullNameAr: 'سارة محمد', email: 'sara.mohammed@demo-customers.test', phone: '+971501110002', nationality: 'EG', preferredLanguage: 'ar' },
  { fullName: 'Rajesh Kumar', email: 'rajesh.kumar@demo-customers.test', phone: '+971501110003', nationality: 'IN', preferredLanguage: 'en' },
  { fullName: 'Fatima Al Ali', fullNameAr: 'فاطمة العلي', email: 'fatima.alali@demo-customers.test', phone: '+971501110004', nationality: 'AE', preferredLanguage: 'ar' },
  { fullName: 'John Smith', email: 'john.smith@demo-customers.test', phone: '+971501110005', nationality: 'GB', preferredLanguage: 'en' },
  { fullName: 'Maria Santos', email: 'maria.santos@demo-customers.test', phone: '+971501110006', nationality: 'PH', preferredLanguage: 'en' },
  { fullName: 'Omar Haddad', fullNameAr: 'عمر حداد', email: 'omar.haddad@demo-customers.test', phone: '+971501110007', nationality: 'JO', preferredLanguage: 'ar' },
  { fullName: 'Blue Falcon Trading LLC', type: 'BUSINESS', email: 'office@bluefalcon-demo.test', phone: '+971501110008', preferredLanguage: 'en' },
];
const PEOPLE_B = [
  { fullName: 'Layla Hassan', fullNameAr: 'ليلى حسن', email: 'layla.hassan@demo-customers.test', phone: '+971502220001', nationality: 'LB', preferredLanguage: 'ar' },
  { fullName: 'Peter Novak', email: 'peter.novak@demo-customers.test', phone: '+971502220002', nationality: 'CZ', preferredLanguage: 'en' },
  { fullName: 'Aisha Khan', email: 'aisha.khan@demo-customers.test', phone: '+971502220003', nationality: 'PK', preferredLanguage: 'en' },
];
const REQUEST_PLAN = [
  { target: 'SUBMITTED' },
  { target: 'SUBMITTED', priority: 'HIGH' },
  { target: 'UNDER_REVIEW', path: ['UNDER_REVIEW'] },
  { target: 'AWAITING_CUSTOMER', path: ['AWAITING_CUSTOMER'] },
  { target: 'IN_PREPARATION', path: ['UNDER_REVIEW', 'READY_FOR_PROCESSING', 'IN_PREPARATION'], priority: 'URGENT' },
  { target: 'IN_PREPARATION', path: ['UNDER_REVIEW', 'READY_FOR_PROCESSING', 'IN_PREPARATION'] },
  { target: 'READY_FOR_PROCESSING', path: ['UNDER_REVIEW', 'READY_FOR_PROCESSING'] },
  { target: 'DRAFT' },
  { target: 'CANCELLED', path: ['CANCELLED'] },
  { target: 'SUBMITTED', instructions: 'Customer will collect on Thursday.' },
  { target: 'UNDER_REVIEW', path: ['UNDER_REVIEW'], priority: 'LOW' },
  { target: 'SUBMITTED' },
];

async function main() {
  const health = await fetch(API.replace('/api/v1', '/health')).then((r) => r.ok).catch(() => false);
  if (!health) throw new Error(`No TypEase API answers at ${API}. Start it first (scripts/dev-api.sh).`);

  log('Centre 1: Al Noor Typing Centre (white label)');
  const a = await ensureCentre({
    slug: 'alnoor-demo',
    businessName: 'Al Noor Typing Centre',
    ownerName: 'Noor Al Mansoori',
    email: 'owner@alnoor-demo.test',
    phone: '+971509990001',
    planKey: 'business',
    emirate: 'Dubai',
    branding: {
      mode: 'WHITE_LABEL',
      businessName: 'Al Noor Typing Centre',
      businessNameAr: 'مركز النور للطباعة',
      primaryColor: '#5B1A3C',
      secondaryColor: '#B4532A',
      accentColor: '#C8962E',
      websiteTitle: 'Al Noor Typing Centre',
      tagline: 'Documents done right, the first time.',
      supportEmail: 'help@alnoor-demo.test',
      supportPhone: '+97143330001',
      publicCatalogueEnabled: true,
    },
  });
  const customersA = await ensureCustomers(a.api, PEOPLE_A);
  const requestsA = await ensureRequests(a.api, customersA, REQUEST_PLAN);
  const corporate = await ensureCorporate(
    a.api,
    'alnoor-demo',
    { companyName: 'Oryx Logistics LLC', companyNameAr: 'أوريكس للخدمات اللوجستية', tradeLicenceNo: 'DED-778812', tradeLicenceAuthority: 'Dubai DET', billingEmail: 'accounts@oryx-demo.test', paymentTermsDays: 30 },
    { fullName: 'Hind Al Suwaidi', email: 'admin@oryx-demo.test' },
  );
  const portal = await ensurePortalCustomer('alnoor-demo', { fullName: 'Khalid Rahman', email: 'khalid.rahman@demo-portal.test', phone: '+971503330001' });
  // One online request so that the portal dashboard is not empty.
  const mine = await portal.api.get('/requests?pageSize=1');
  if (mine.meta.total === 0) {
    const catalogue = await tolerate([403, 404], () => portal.api.get('/catalogue'));
    const first = (catalogue?.services ?? catalogue?.data ?? [])[0];
    if (first) await tolerate([400, 402, 403, 409, 422], () => portal.api.post('/requests', { serviceId: first.id }));
  }
  log(`  ${customersA.length} customers, ${requestsA} requests, corporate account ${corporate.accountNo ?? corporate.id}`);

  log('Centre 2: Gulf Express Typing (TypEase branding)');
  const b = await ensureCentre({
    slug: 'gulf-demo',
    businessName: 'Gulf Express Typing',
    ownerName: 'Salim Al Hashmi',
    email: 'owner@gulf-demo.test',
    phone: '+971509990002',
    planKey: 'starter',
    emirate: 'Sharjah',
    branding: { mode: 'TYPEASE', publicCatalogueEnabled: true },
  });
  const customersB = await ensureCustomers(b.api, PEOPLE_B);
  const requestsB = await ensureRequests(b.api, customersB, REQUEST_PLAN.slice(0, 5));
  await ensurePortalCustomer('gulf-demo', { fullName: 'Dana Yousef', email: 'dana.yousef@demo-portal.test', phone: '+971503330002' });
  log(`  ${customersB.length} customers, ${requestsB} requests`);

  const result = {
    api: API,
    password: PASSWORD,
    centres: [
      { name: 'Al Noor Typing Centre', slug: 'alnoor-demo', branding: 'WHITE_LABEL', plan: 'business', owner: 'owner@alnoor-demo.test', customer: 'khalid.rahman@demo-portal.test', corporateAdmin: 'admin@oryx-demo.test' },
      { name: 'Gulf Express Typing', slug: 'gulf-demo', branding: 'TYPEASE', plan: 'starter', owner: 'owner@gulf-demo.test', customer: 'dana.yousef@demo-portal.test', corporateAdmin: null },
    ],
    urls: {
      centre: 'http://localhost:3001/sign-in',
      customerWhiteLabel: 'http://localhost:3002/?tenant=alnoor-demo',
      customerTypEase: 'http://localhost:3002/?tenant=gulf-demo',
      corporate: 'http://localhost:3003/sign-in?tenant=alnoor-demo',
      platformAdmin: 'http://localhost:3004/sign-in',
    },
  };
  if (OUT) writeFileSync(OUT, JSON.stringify(result, null, 2));

  console.log(`
TypEase demo data is ready. Every account uses the password:  ${PASSWORD}

  Staff app        http://localhost:3001/sign-in
      owner@alnoor-demo.test      Al Noor Typing Centre  (Business plan, white label)
      owner@gulf-demo.test        Gulf Express Typing    (Starter plan, TypEase branding)

  Customer portal  http://localhost:3002/?tenant=alnoor-demo   (white label)
                   http://localhost:3002/?tenant=gulf-demo     (TypEase branding)
      khalid.rahman@demo-portal.test   customer of Al Noor
      dana.yousef@demo-portal.test     customer of Gulf Express

  Corporate portal http://localhost:3003/sign-in?tenant=alnoor-demo
      admin@oryx-demo.test             Oryx Logistics LLC (client of Al Noor)

  Platform admin   http://localhost:3004/sign-in
      Platform staff are not created through the public API. Use the account
      created by the database seed (see docs/deployment).
`);
}

main().catch((e) => {
  console.error(`\ndev-quickstart failed: ${e.message}`);
  if (e.body?.details) console.error(JSON.stringify(e.body.details, null, 2));
  process.exit(1);
});
