import { Actor, PASSWORD, TenantFixture, TestApp, uniq } from '../../services/api/test/helpers';
import { Api } from './http';

/** A typing centre that exists because its owner went through the public flows. Compatible with the API's TenantFixture. */
export interface Centre extends TenantFixture {
  ownerEmail: string;
  /** Status the centre reported when onboarding was completed (TRIAL for a fresh trial subscription). */
  status: string;
  /** The service the owner created during onboarding (a centre cannot complete onboarding without one). */
  firstService: CreatedService;
}

export const samplePhone = () => `+9715${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
/** Fictional identity numbers (never real documents): the right shape, random digits. */
const digits = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
export const sampleEmiratesId = () => `784${digits(12)}`;
export const samplePassportNo = () => `N${digits(8)}`;

export const api = (t: TestApp, actor: Actor | null, label?: string) => new Api(t, actor, {}, label ?? actor?.email ?? 'anonymous');
export const anonymous = (t: TestApp) => new Api(t, null);

export interface ServiceSpec {
  code?: string;
  name?: string;
  categoryKey?: string;
  complianceCapability?: 'DOCUMENT_PREPARATION_ONLY' | 'PARTNER_COORDINATION' | 'DIRECT_AUTHORISED' | 'INFORMATIONAL_ONLY';
  requiresApproval?: boolean;
  paymentPolicy?: 'BEFORE_PROCESSING' | 'AFTER_COMPLETION' | 'DEPOSIT';
  depositPercent?: number;
  taxMode?: 'SERVICE_FEE_ONLY' | 'ALL_COMPONENTS' | 'NONE';
  estimatedProcessingHours?: number;
  onlineAvailable?: boolean;
  isPublic?: boolean;
  workflowKey?: string;
  price?: { serviceFee: string; governmentFeeEstimate?: string; thirdPartyFeeEstimate?: string };
  requirements?: Array<{ documentTypeKey: string; label: string; isMandatory?: boolean; allowReuse?: boolean }>;
  /** A dynamic form (FormSchema). `null` = the service has no form. */
  form?: object | null;
}

/** A one-step form with a required choice and a conditional field: enough to prove server-side validation. */
export const SAMPLE_FORM = {
  steps: [
    {
      key: 'applicant',
      title: 'Applicant',
      fields: [
        { key: 'fullName', label: 'Full name', type: 'text', required: true, prefillFrom: 'customer.fullName' },
        { key: 'purpose', label: 'Purpose', type: 'select', required: true, options: [{ value: 'work', label: 'Work' }, { value: 'family', label: 'Family' }] },
        { key: 'sponsor', label: 'Sponsor', type: 'text', required: true, showIf: { field: 'purpose', in: ['work'] } },
      ],
    },
  ],
};

export interface CreatedService {
  id: string;
  code: string;
  name: string;
  [k: string]: any;
}

/**
 * Service + price + document checklist + published form, through the catalogue
 * API (what an owner does in Settings > Services).
 */
export async function createService(t: TestApp, owner: Actor, spec: ServiceSpec = {}): Promise<CreatedService> {
  const a = api(t, owner);
  const categories: any[] = await a.get('/service-categories');
  const category = categories.find((c) => c.key === (spec.categoryKey ?? 'typing')) ?? categories[0];
  if (!category) throw new Error('The centre has no service category.');
  let workflowDefinitionId: string | undefined;
  if (spec.workflowKey) {
    const workflows: any[] = await a.get('/workflows');
    workflowDefinitionId = workflows.find((w) => w.key === spec.workflowKey)?.id;
    if (!workflowDefinitionId) throw new Error(`The centre has no workflow "${spec.workflowKey}".`);
  }
  const code = spec.code ?? `SVC-${uniq()}`.toUpperCase().slice(0, 30);
  const service = await a.post(
    '/services',
    {
      categoryId: category.id,
      code,
      name: spec.name ?? `Typing service ${code}`,
      complianceCapability: spec.complianceCapability ?? 'DOCUMENT_PREPARATION_ONLY',
      requiresApproval: spec.requiresApproval ?? false,
      paymentPolicy: spec.paymentPolicy ?? 'BEFORE_PROCESSING',
      ...(spec.depositPercent ? { depositPercent: spec.depositPercent } : {}),
      ...(spec.taxMode ? { taxMode: spec.taxMode } : {}),
      estimatedProcessingHours: spec.estimatedProcessingHours ?? 24,
      onlineAvailable: spec.onlineAvailable ?? true,
      isPublic: spec.isPublic ?? true,
      allBranches: true,
      ...(workflowDefinitionId ? { workflowDefinitionId } : {}),
      price: spec.price ?? { serviceFee: '100.00' },
    },
    201,
  );
  for (const r of spec.requirements ?? []) await a.post(`/services/${service.id}/requirements`, r, 201);
  if (spec.form) {
    const draft = await a.post(`/services/${service.id}/forms`, { schema: spec.form }, 201);
    await a.post(`/services/${service.id}/forms/${draft.id}/publish`);
  }
  return service;
}

export interface SignUpOptions {
  name?: string;
  slug?: string;
  /** Plan chosen during onboarding. A first subscription starts as a trial of that plan. */
  plan?: 'starter' | 'professional' | 'business' | 'enterprise';
  emirate?: string;
  /** The service every centre needs before onboarding can be completed. */
  firstService?: ServiceSpec;
}

/**
 * A new centre, the way a real owner gets one: public sign-up, email
 * verification, sign-in, business details, plan (trial), a first service,
 * "complete onboarding". No row is written to the database by the test.
 */
export async function signUpCentre(t: TestApp, opts: SignUpOptions = {}): Promise<Centre> {
  const id = uniq();
  const slug = opts.slug ?? `c-${id}`;
  const name = opts.name ?? `Centre ${id}`;
  const email = `owner-${id}@example.test`;
  const phone = samplePhone();
  const anon = anonymous(t);

  const signup = await anon.post('/public/signup', { businessName: name, slug, ownerName: `Owner ${id}`, email, phone, password: PASSWORD, acceptTerms: true }, 201);
  if (!signup.dev?.emailVerificationToken) throw new Error('The sign-up answer has no verification token (EXPOSE_DEV_TOKENS must be true in tests).');
  await anon.post('/auth/verify-email', { token: signup.dev.emailVerificationToken }, 200);
  const owner = await t.login(email);
  const o = api(t, owner);

  await o.put('/onboarding/business', { legalName: `${name} LLC`, emirate: opts.emirate ?? 'Dubai', contactEmail: email, contactPhone: phone, defaultLanguage: 'en' });
  await o.post('/onboarding/plan', { planKey: opts.plan ?? 'enterprise', billingCycle: 'MONTHLY' }, 201);
  const firstService = await createService(t, owner, opts.firstService ?? { name: 'Document typing', price: { serviceFee: '100.00' } });
  const done = await o.post('/onboarding/complete');
  if (!['TRIAL', 'ACTIVE'].includes(done.status)) throw new Error(`Onboarding ended with centre status ${done.status}.`);

  const branches: any[] = await o.get('/branches');
  const head = branches.find((b) => b.isHeadOffice) ?? branches[0];
  return { id: signup.tenantId, slug, name, owner, ownerEmail: email, headOfficeId: head.id, status: done.status, firstService };
}

/** Invite a colleague and accept the invitation with a password of their own (the API helper does exactly that over HTTP). */
export const inviteStaff = (t: TestApp, centre: TenantFixture, roleKey: string, opts: { branchIds?: string[]; allBranches?: boolean } = {}) => t.addStaff(centre, roleKey, opts);

/** A staff member holding exactly these permissions: a custom role created by the owner, then the normal invitation. */
export async function inviteStaffWithPermissions(t: TestApp, centre: TenantFixture, permissions: string[]): Promise<Actor> {
  const key = `custom_${uniq().slice(-8)}`;
  await api(t, centre.owner).post('/roles', { key, name: `Custom ${key}`, permissions }, 201);
  return t.addStaff(centre, key);
}

/** A customer who registers on the centre's portal, confirms the email address and signs in. */
export const registerPortalCustomer = (t: TestApp, centre: TenantFixture, opts: { fullName?: string; email?: string } = {}) => t.addCustomer(centre, opts);

export interface WalkInCustomer {
  id: string;
  customerNo: string;
  fullName: string;
  email: string;
  [k: string]: any;
}

/** A customer registered at the counter by staff. */
export async function registerWalkInCustomer(t: TestApp, staff: Actor, over: Record<string, unknown> = {}): Promise<WalkInCustomer> {
  const id = uniq();
  return api(t, staff).post('/customers', { type: 'INDIVIDUAL', fullName: `Customer ${id}`, email: `customer-${id}@example.test`, phone: samplePhone(), nationality: 'IN', ...over }, 201);
}

/** Staff invite a registered customer to the portal; the customer accepts with a password and is signed in. */
export async function invitePortalAccess(t: TestApp, staff: Actor, centre: TenantFixture, customer: { id: string; email: string }): Promise<Actor> {
  const invite = await api(t, staff).post(`/customers/${customer.id}/portal-invitation`, {}, 201);
  const accepted = await anonymous(t).post('/auth/invitations/accept', { token: invite.dev.invitationToken, password: PASSWORD, app: 'customer' }, 200);
  if (accepted.status !== 'OK') throw new Error(`The portal invitation ended with ${accepted.status}.`);
  return t.login(customer.email, PASSWORD, 'customer', centre.slug);
}

export interface Company {
  id: string;
  accountNo: string;
  companyName: string;
  admin: Actor;
  adminEmail: string;
}

/**
 * A corporate customer: account created and verified by the centre, optional
 * credit approval, and an authorised contact who accepts the invitation and
 * signs in to the corporate portal.
 */
export async function createCompany(t: TestApp, centre: TenantFixture, opts: { companyName?: string; credit?: { limit: string; termsDays: number } } = {}): Promise<Company> {
  const id = uniq();
  const o = api(t, centre.owner);
  const account = await o.post('/corporate-accounts', { companyName: opts.companyName ?? `Company ${id} LLC`, tradeLicenceNo: `TL-${id}`.toUpperCase(), billingEmail: `accounts-${id}@example.test` }, 201);
  await o.post(`/corporate-accounts/${account.id}/verify`, { note: 'Trade licence copy and authorisation letter checked (test data).' });
  if (opts.credit) await o.post(`/corporate-accounts/${account.id}/credit`, { approved: true, creditLimit: opts.credit.limit, paymentTermsDays: opts.credit.termsDays, note: 'Credit terms approved (test data).' });
  const adminEmail = `corp-admin-${id}@example.test`;
  const invite = await o.post(`/corporate-accounts/${account.id}/members`, { fullName: `Company Admin ${id}`, email: adminEmail, isAuthorisedSignatory: true }, 201);
  const accepted = await anonymous(t).post('/auth/invitations/accept', { token: invite.dev.invitationToken, password: PASSWORD, app: 'corporate' }, 200);
  if (accepted.status !== 'OK') throw new Error(`The corporate invitation ended with ${accepted.status}.`);
  const admin = await t.login(adminEmail, PASSWORD, 'corporate', centre.slug);
  return { id: account.id, accountNo: account.accountNo, companyName: account.companyName, admin, adminEmail };
}



/** The company administrator adds an employee to the directory; returns the portal view of the record. */
export async function addCompanyEmployee(t: TestApp, company: Company, over: Record<string, unknown> = {}): Promise<{ id: string; fullName: string; email: string }> {
  const id = uniq();
  const email = `employee-${id}@example.test`;
  const created = await api(t, company.admin).post('/corporate/employees', { fullName: `Employee ${id}`, email, nationality: 'IN', employeeNo: `E-${id}`, ...over }, 201);
  return { id: created.id, fullName: created.fullName, email: (over.email as string) ?? email };
}

/** The company administrator gives an employee a portal login; the employee accepts the invitation and signs in. */
export async function employeeLogin(t: TestApp, centre: TenantFixture, company: Company, employee: { id: string; email: string }): Promise<Actor> {
  const invited = await api(t, company.admin).post(`/corporate/employees/${employee.id}/login`, {}, 201);
  if (!invited.dev?.invitationToken) throw new Error('The employee login answer has no invitation token (EXPOSE_DEV_TOKENS must be true in tests).');
  const accepted = await anonymous(t).post('/auth/invitations/accept', { token: invited.dev.invitationToken, password: PASSWORD, app: 'corporate' }, 200);
  if (accepted.status !== 'OK') throw new Error(`The employee invitation ended with ${accepted.status}.`);
  return t.login(employee.email, PASSWORD, 'corporate', centre.slug);
}
