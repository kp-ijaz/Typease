/**
 * Screenshot scenarios of the customer portal (signed-in screens).
 *
 *   export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
 *   node packages/ui/scripts/screenshots.mjs --app customer --scenarios apps/customer-web/scripts/shots.mjs --out /tmp/shots-customer-web [--only requests,...]
 *
 * Read-only scenarios take pictures of seeded records of the demo centre Al Noor (looked up through
 * the UI, never by a hard-coded id). Scenarios whose name starts with "flow-" WRITE to the database
 * through the UI (a request, an upload, a quotation decision, a payment, an appointment, a ticket ...):
 * run them on a demo database only, one at a time with --only. They save a picture of every step next
 * to the final one, as customer-<scenario>-<step>.png.
 */
import { resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const TENANT = 'al-noor';
const AISHA = 'aisha.rahman@example.test'; // requests in several states, documents, invoices, an appointment, a ticket
const JOSEPH = 'joseph.mathew@example.test'; // a rejected photo to replace
const EMILY = 'emily.carter@example.test'; // a quotation to accept or reject
const GRACE = 'grace.mendoza@example.test'; // a draft to finish
const DANIEL = 'daniel.okafor@example.test'; // a cancelled request, a blocked deletion request
const NOURA = 'noura.al.ketbi@example.test'; // Arabic; a quotation with a discount
const PASSWORD = 'TypEase-Demo-2026';
const API = process.env.TYPEASE_API ?? 'http://localhost:4000/api/v1';
const SIGN_IN = `/login?tenant=${TENANT}`;
const ROW = 'main table tbody tr a:visible, main ul li a:visible';
const EN = ['en-light-desktop'];
const PHONE = ['en-light-mobile'];

const outArg = process.argv.indexOf('--out');
const OUT = resolve(process.cwd(), outArg >= 0 ? process.argv[outArg + 1] : 'docs/brand/screenshots');
mkdirSync(OUT, { recursive: true });

const settle = async (page) => {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(400);
};
const as = (email, extra) => ({ as: email, signInPath: SIGN_IN, ...extra });
/** A step picture of a flow. */
const step = (page, flow, name) => page.screenshot({ path: resolve(OUT, `customer-${flow}-${name}.png`), fullPage: true, animations: 'disabled' });
const must = async (locator, what, timeout = 30_000) => {
  try {
    // Lists exist twice in the page (table and phone cards): only what can be seen counts.
    await locator.filter({ visible: true }).first().waitFor({ state: 'visible', timeout });
  } catch {
    throw new Error(`expected to see: ${what}`);
  }
};
/** Opens the row of a list that contains the text (a request number, a subject). */
const RECORD = 'main table tbody tr:visible, main ul li:visible';
const openRow = async (page, text) => {
  await page.locator(RECORD).filter({ hasText: text }).first().locator('a').first().click();
  await page.waitForURL(/\/[0-9a-f-]{36}/);
  await page.locator('main h1').waitFor();
  await settle(page);
};
/** A small valid PNG / PDF to upload (generated, never a real document). */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC', 'base64');
const pdf = (text) =>
  Buffer.from(
    `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length ${44 + text.length}>>stream\nBT /F1 14 Tf 20 100 Td (${text}) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
  );

/** The staff side of a flow (issue a quotation, answer a ticket ...) through the API, as the centre owner. */
async function staff() {
  const login = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-client-app': 'centre' }, body: JSON.stringify({ email: 'owner@al-noor.test', password: PASSWORD, app: 'centre' }) });
  const { accessToken } = await login.json();
  if (!accessToken) throw new Error('staff sign-in failed');
  return async (method, path, body, headers = {}) => {
    const res = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${accessToken}`, 'x-client-app': 'centre', ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`staff ${method} ${path}: ${res.status} ${json?.code ?? ''} ${json?.message ?? ''}`);
    return json;
  };
}

const screens = [
  // ------------------------------------------------------------------ read-only
  { name: 'requests', path: '/requests', ...as(AISHA), ready: ROW },
  {
    name: 'request-external',
    path: '/requests',
    ...as(AISHA),
    ready: ROW,
    fullPage: true,
    act: async (page) => {
      await openRow(page, 'AN-000027');
      // An external status is never shown without its source.
      await must(page.locator('[data-external-status]').getByText(/Provided by partner|مقدمة من الشريك/), 'the source label of the external status');
    },
  },
  {
    name: 'request-awaiting-payment',
    path: '/requests',
    ...as(AISHA),
    ready: ROW,
    fullPage: true,
    variants: ['en-light-desktop', 'en-light-mobile'],
    act: async (page) => {
      await openRow(page, 'AN-000052');
      await must(page.locator('[data-waiting-on="CUSTOMER"]'), 'the "waiting for you" card');
    },
  },
  {
    name: 'request-completed',
    path: '/requests',
    ...as(AISHA),
    ready: ROW,
    fullPage: true,
    variants: ['en-light-mobile', 'ar-dark-desktop'],
    act: async (page) => {
      await openRow(page, 'AN-000004');
      // The completed document really downloads (through a short-lived link from the API).
      const download = page.waitForEvent('download', { timeout: 60_000 });
      await page.locator('main button').filter({ hasText: /^(Download|تنزيل)$/ }).first().click();
      await download;
      await settle(page);
    },
  },
  {
    name: 'request-rejected-document',
    path: '/requests',
    ...as(JOSEPH),
    ready: ROW,
    fullPage: true,
    act: async (page) => {
      await openRow(page, 'AN-000050');
      await must(page.locator('[data-waiting-on="CUSTOMER"]'), 'the "waiting for you" card');
    },
  },
  {
    name: 'request-documents-tab',
    path: '/requests',
    ...as(JOSEPH),
    ready: ROW,
    fullPage: true,
    variants: ['en-light-mobile', 'ar-dark-desktop'],
    act: async (page) => {
      await openRow(page, 'AN-000050');
      await page.getByRole('tab').nth(1).click();
      await must(page.locator('[data-checklist-status="REJECTED"]'), 'the rejected document');
      await page.locator('[data-checklist-status="REJECTED"] button').first().click();
      await must(page.locator('input[type="file"]').first().locator('xpath=..'), 'the upload area');
    },
  },
  { name: 'new-request-services', path: '/requests/new', ...as(AISHA), ready: 'main ul li button:visible', fullPage: true },
  {
    name: 'new-request-intro',
    path: '/requests/new',
    ...as(AISHA),
    ready: 'main ul li button:visible',
    fullPage: true,
    act: async (page) => {
      await page.locator('main ul li button').filter({ hasText: /Emirates ID|الهوية/ }).first().click();
      await page.waitForURL(/serviceId=/);
      await must(page.locator('main aside button').last(), 'the start button');
      await settle(page);
    },
  },
  { name: 'new-request-draft', path: '/requests', ...as(GRACE), ready: ROW, fullPage: true, act: async (page) => {
      await page.locator(RECORD).filter({ hasText: 'AN-000056' }).first().locator('a').first().click();
      await page.waitForURL(/draft=/);
      await must(page.locator('main [aria-current="step"]'), 'the stepper');
      await settle(page);
    } },
  { name: 'documents', path: '/documents', ...as(AISHA), ready: 'main table tbody tr:visible, main ul li:visible', fullPage: true },
  { name: 'quotations', path: '/quotations', ...as(AISHA), ready: ROW },
  {
    name: 'quotation-open',
    path: '/quotations',
    ...as(EMILY),
    ready: ROW,
    fullPage: true,
    act: async (page) => {
      await openRow(page, 'QUO-000051');
      await must(page.locator('[data-action="approve"]'), 'the approve button');
    },
  },
  { name: 'quotation-discount', path: '/quotations', ...as(NOURA), ready: ROW, fullPage: true, variants: ['ar-dark-desktop', 'ar-light-mobile'], act: async (page) => {
      await page.locator(ROW).first().click();
      await page.waitForURL(/\/[0-9a-f-]{36}/);
      await page.locator('main h1').waitFor();
      await settle(page);
    } },
  { name: 'payments', path: '/payments', ...as(AISHA), ready: 'main [data-outstanding], main [role="tabpanel"] p', fullPage: true },
  { name: 'payments-invoices', path: '/payments?tab=invoices', ...as(AISHA), ready: ROW, fullPage: true, variants: ['en-light-desktop', 'en-light-mobile'] },
  { name: 'payments-receipts', path: '/payments?tab=payments', ...as(AISHA), ready: 'main table tbody tr:visible, main ul li:visible', fullPage: true, variants: ['en-light-desktop', 'en-light-mobile'] },
  {
    name: 'invoice-unpaid',
    path: '/payments?tab=invoices',
    ...as(AISHA),
    ready: ROW,
    fullPage: true,
    act: async (page) => {
      await openRow(page, 'INV-000041');
      await must(page.locator('[data-pay-card]'), 'the pay card');
    },
  },
  { name: 'invoice-paid', path: '/payments?tab=invoices', ...as(AISHA), ready: ROW, fullPage: true, variants: ['en-light-desktop', 'en-light-mobile'], act: async (page) => openRow(page, 'INV-000026') },
  { name: 'appointments', path: '/appointments', ...as(AISHA), ready: 'main [data-appointment-status], main h2', fullPage: true },
  {
    name: 'appointments-book',
    path: '/appointments?book=1',
    ...as(AISHA),
    ready: '[role="dialog"]',
    act: async (page) => {
      const dialog = page.getByRole('dialog');
      // Tomorrow has free times whatever the hour is.
      const tomorrow = new Date(Date.now() + 4 * 3600_000 + 86_400_000).toISOString().slice(0, 10);
      await dialog.locator('input[type="date"]').fill(tomorrow);
      await must(dialog.locator('[role="radio"]:not([disabled])'), 'free times');
      await dialog.locator('[role="radio"]:not([disabled])').nth(2).click();
    },
  },
  { name: 'messages', path: '/messages', ...as(AISHA), ready: 'main ul li a:visible, main p', fullPage: true },
  { name: 'notifications', path: '/notifications', ...as(AISHA), ready: 'main [role="tabpanel"] ul li:visible' },
  { name: 'notifications-settings', path: '/notifications?tab=settings', ...as(AISHA), ready: 'main [role="switch"]', fullPage: true },
  { name: 'support', path: '/support', ...as(AISHA), ready: ROW },
  { name: 'support-ticket', path: '/support', ...as(AISHA), ready: ROW, fullPage: true, act: async (page) => openRow(page, 'TKT-000003') },
  { name: 'profile', path: '/profile', ...as(AISHA), ready: 'main form input', fullPage: true },
  { name: 'profile-security', path: '/profile?tab=security', ...as(AISHA), ready: 'main form input[type="password"]', fullPage: true, variants: ['en-light-desktop', 'en-light-mobile'] },
  { name: 'profile-privacy', path: '/profile?tab=privacy', ...as(DANIEL), ready: 'main [data-consent]', fullPage: true },
  { name: 'payment-return-missing', path: '/payments/return', ...as(AISHA), ready: 'main h1', variants: EN },
  {
    name: 'account-menu',
    path: '/dashboard',
    ...as(AISHA),
    ready: 'main h1',
    variants: ['en-light-mobile', 'ar-dark-mobile'],
    act: async (page) => {
      await page.locator('header button[aria-haspopup="menu"]').last().click();
      await page.getByRole('menu').waitFor();
      await page.waitForTimeout(300);
    },
  },
  { name: 'dashboard', path: '/dashboard', ...as(AISHA), ready: 'main h1', fullPage: true },
];

// ------------------------------------------------------------------ flows (they write: demo database only, one at a time)

const STATE = resolve(OUT, 'flow-state.json');
const readState = () => {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'));
  } catch {
    return {};
  }
};
const saveState = (patch) => writeFileSync(STATE, JSON.stringify({ ...readState(), ...patch }, null, 2));
const origin = (page) => new URL(page.url()).origin;
const go = async (page, path) => {
  await page.goto(`${origin(page)}${path}`, { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 90_000 });
  await page.locator('main h1').first().waitFor({ timeout: 90_000 });
  await settle(page);
};
/** Signs in on the login page the scenario opened (flows of the customer registered by flow-register). */
const login = async (page, email, password = readState().password ?? PASSWORD) => {
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !/login/.test(url.pathname), { timeout: 60_000 });
  await page.locator('main h1').first().waitFor();
  await settle(page);
};
const newCustomer = () => {
  const { email } = readState();
  if (!email) throw new Error('run flow-register first: it creates the customer the other flows sign in as');
  return email;
};
/** Chooses an option of a <Select> / <Combobox> by its visible text. */
const choose = async (page, trigger, optionText) => {
  await trigger.click();
  await page.getByRole('option', { name: optionText }).first().click();
};
const toast = (page, text) => must(page.locator('[data-sonner-toast]').filter({ hasText: text }), `toast "${text}"`);
/** Uploads a file into the upload area of one checklist line (the first file input of the line is the picker, the second the camera). */
const uploadTo = async (line, file) => {
  if (!(await line.locator('input[type="file"]').count())) await line.getByRole('button', { name: /^Upload|Replace/ }).first().click();
  await line.locator('input[type="file"]').first().setInputFiles(file);
};

const flows = [
  // Not a flow, but it only runs when named: the API answers 404, which the browser always logs as a console error.
  { name: 'request-not-found', path: '/requests/00000000-0000-4000-8000-000000000000', ...as(AISHA), ready: 'main h1', variants: EN, act: async (page) => must(page.getByText('We could not find this request'), 'the not-found state') },
  {
    // A brand-new customer: the real register screen, the verification link, the first sign-in and every empty state.
    name: 'flow-register',
    path: `/register?tenant=${TENANT}`,
    ready: 'form',
    variants: PHONE,
    act: async (page) => {
      const flow = 'flow-register';
      const email = `mariam.demo.${Date.now().toString(36)}@example.test`;
      await page.locator('button[type="submit"]').click();
      await must(page.locator('form [role="alert"]'), 'validation messages of the empty form');
      await step(page, flow, '1-validation');
      await page.locator('input[autocomplete="name"]').fill('Mariam Demo Hassan');
      await page.locator('input[type="email"]').fill(email);
      await page.locator('input[autocomplete="new-password"]').fill(PASSWORD);
      await page.getByRole('checkbox').first().click();
      await page.locator('button[type="submit"]').click();
      await page.waitForURL(/verify-email/);
      await must(page.locator('a[href*="verify-email?token="]'), 'the development verification link');
      await step(page, flow, '2-check-your-email');
      await page.locator('a[href*="verify-email?token="]').click();
      await page.waitForURL(/verify-email\?token=/);
      // "Confirmed" has no form any more (the pending and the failed state both offer to send a new link).
      await page.locator('form').waitFor({ state: 'detached', timeout: 30_000 });
      await must(page.locator('a[href*="/login"]'), 'the "sign in" button after verification');
      await step(page, flow, '3-verified');
      await page.locator('main a[href*="/login"], a[href*="/login"]').last().click();
      await page.waitForURL(/login/);
      await page.locator('input[type="email"]').waitFor();
      await login(page, email);
      saveState({ email });
      await must(page.getByText('You have no requests yet'), 'the empty dashboard');
      await step(page, flow, '4-first-dashboard');
      for (const [path, name, text] of [
        ['/requests', '5-requests-empty', 'You have no requests yet'],
        ['/documents', '6-documents-empty', 'No documents yet'],
        ['/quotations', '7-quotations-empty', 'No quotations yet'],
        ['/payments', '8-payments-empty', 'Nothing to pay'],
        ['/appointments', '9-appointments-empty', 'No appointments yet'],
        ['/messages', '10-messages-empty', 'No conversations yet'],
        ['/support', '11-support-empty', 'No questions yet'],
        ['/profile', '12-profile', 'About you'],
      ]) {
        await go(page, path);
        await must(page.getByText(text), `"${text}" on ${path}`);
        await step(page, flow, name);
      }
      await go(page, '/notifications');
    },
  },
  {
    // The first request, from the public service page to the tracking code, as the customer of flow-register.
    name: 'flow-new-request',
    path: SIGN_IN,
    ready: 'form',
    variants: PHONE,
    act: async (page) => {
      const flow = 'flow-new-request';
      await login(page, newCustomer());
      // 1. From the public catalogue: "Start this request" carries ?serviceId= into the wizard.
      await go(page, '/services');
      await page.getByRole('link', { name: /Tenancy contract typing/ }).first().click();
      await page.waitForURL(/\/services\/[0-9a-f-]{36}/);
      await page.locator('a[href*="/requests/new?serviceId="]').click();
      await page.waitForURL(/requests\/new\?serviceId=/);
      await must(page.getByRole('button', { name: 'Start this request' }), 'the service summary with "Start this request"');
      await settle(page);
      await step(page, flow, '1-service');
      await page.getByRole('button', { name: 'Start this request' }).click();
      await page.waitForURL(/draft=[0-9a-f-]{36}.*step=details|step=details.*draft=/);
      await must(page.getByLabel('Landlord name'), 'the form of the service');
      // The tenant's name comes from the profile.
      if ((await page.getByLabel('Tenant name').inputValue()) !== 'Mariam Demo Hassan') throw new Error('the tenant name was not prefilled from the profile');

      // 2. Details: an incomplete form does not continue and says where the problem is.
      await page.getByRole('button', { name: 'Continue' }).click();
      await must(page.locator('main [role="alert"]').filter({ hasText: 'This field is required' }), 'required-field messages');
      await step(page, flow, '2-details-validation');
      await page.getByLabel('Landlord name').fill('Sample Landlord (fictional)');
      await choose(page, page.getByLabel('Property type'), 'Other');
      await must(page.getByLabel('Describe the property'), 'the field that only shows for "Other"');
      await page.getByLabel('Describe the property').fill('Warehouse unit');
      await page.getByLabel('Property address').fill('Unit 4, Sample Street, Deira, Dubai (fictional)');
      await page.getByLabel('Annual rent').fill('abc');
      await page.getByLabel('Contract start date').fill('2026-11-01');
      await page.getByLabel('Contract period (months)').fill('12');
      await page.getByRole('radio', { name: '4', exact: true }).click();
      await page.getByRole('button', { name: 'Continue' }).click();
      await must(page.locator('main [role="alert"]').filter({ hasText: 'Enter a number' }), 'the message for a rent that is not a number');
      await page.getByLabel('Annual rent').fill('48000');
      await page.getByLabel(/Anything else the centre should know/).fill('Please call me after 4 pm. (flow test)');
      // The draft saves itself; a reload shows what was typed.
      await must(page.locator('[data-save-state="saved"]'), 'the "Saved at" note of the automatic save', 20_000);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await must(page.getByLabel('Landlord name'), 'the form after a reload');
      if ((await page.getByLabel('Landlord name').inputValue()) !== 'Sample Landlord (fictional)') throw new Error('the draft did not keep the landlord name after a reload');
      if ((await page.getByLabel('Annual rent').inputValue()) !== '48000') throw new Error('the draft did not keep the rent after a reload');
      await settle(page);
      await step(page, flow, '3-details-filled');
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.waitForURL(/step=documents/);

      // 3. Documents: the API refuses a file whose content is not what it claims; a real PDF is accepted.
      const lines = page.locator('main li[data-checklist-status]');
      await must(lines.first(), 'the document checklist');
      await must(page.locator('[data-missing-documents="2"]'), 'the note about 2 missing documents');
      await uploadTo(lines.nth(0), { name: 'renamed-text.pdf', mimeType: 'application/pdf', buffer: Buffer.from('this is plain text, not a PDF') });
      await must(lines.nth(0).locator('[role="alert"]'), 'the API error for a file that is not a real PDF');
      await step(page, flow, '4-upload-refused');
      await lines.nth(0).getByRole('button', { name: /^Remove/ }).click();
      await lines.nth(0).locator('input[type="file"]').first().setInputFiles({ name: 'emirates-id-sample.pdf', mimeType: 'application/pdf', buffer: pdf('SAMPLE Emirates ID (not a real document)') });
      await must(page.locator('main li[data-checklist-status="UPLOADED"], main li[data-checklist-status="VERIFIED"]').first(), 'the first document as uploaded', 60_000);
      await uploadTo(lines.nth(1), { name: 'landlord-passport-sample.png', mimeType: 'image/png', buffer: PNG });
      await must(page.locator('main li[data-checklist-status="UPLOADED"]').nth(1), 'the second document as uploaded', 60_000);
      await page.locator('[data-missing-documents]').waitFor({ state: 'detached', timeout: 30_000 });
      await settle(page);
      await step(page, flow, '5-documents');
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.waitForURL(/step=review/);

      // 4. Review and submit.
      await must(page.getByRole('button', { name: 'Submit request' }), 'the submit button');
      await must(page.getByText('Warehouse unit'), 'the answers on the review step');
      await settle(page);
      await step(page, flow, '6-review');
      await page.getByRole('button', { name: 'Submit request' }).click();
      await must(page.getByText('Request submitted'), 'the confirmation', 60_000);
      const requestNo = (await page.locator('[data-request-no]').innerText()).trim();
      const trackingCode = (await page.locator('[data-tracking-code]').innerText()).trim();
      if (!/^[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(trackingCode)) throw new Error(`unexpected tracking code "${trackingCode}"`);
      await step(page, flow, '7-submitted');

      // 5. The request page, and a first message to the centre.
      await page.getByRole('link', { name: 'Open my request' }).click();
      await page.waitForURL(/\/requests\/[0-9a-f-]{36}$/);
      await page.locator('main h1').waitFor();
      const requestId = page.url().split('/').pop();
      saveState({ requestId, requestNo, trackingCode });
      await settle(page);
      await step(page, flow, '8-request');
      await page.getByRole('tab', { name: /Messages/ }).click();
      await page.getByLabel('Your message').fill('Hello, can I collect the contract on Saturday? (flow test)');
      await page.getByRole('button', { name: 'Send message' }).click();
      await must(page.locator('main ol li').filter({ hasText: 'collect the contract on Saturday' }), 'the message in the conversation');
      await settle(page);
      await step(page, flow, '9-message-sent');

      // 6. The tracking code works without an account (public page).
      await go(page, `/track?no=${requestNo}&code=${trackingCode}`);
      await page.locator('button[type="submit"]').click();
      await must(page.getByText('Progress so far'), 'the public tracking result');
      await step(page, flow, '10-public-tracking');
    },
  },
  {
    // The centre rejects a document and asks a question; the customer fixes it; the centre quotes; the customer
    // approves, pays online (first a declined try, then a successful one) and sees the invoice paid.
    // Every stage starts from the status the request really has, so a run that stopped half-way can be repeated.
    name: 'flow-fix-and-pay',
    path: SIGN_IN,
    ready: 'form',
    variants: PHONE,
    act: async (page) => {
      const flow = 'flow-fix-and-pay';
      const { requestId, requestNo } = readState();
      if (!requestId) throw new Error('run flow-new-request first');
      const api = await staff();
      const request = () => api('GET', `/requests/${requestId}`);
      await login(page, newCustomer());

      // 1. Staff: one document is fine, the other is not readable; the centre asks for a new copy.
      let now = await request();
      if (now.status === 'UNDER_REVIEW' && !now.finance.quotation && now.checklist.some((l) => l.document?.verificationStatus === 'UNVERIFIED' && l.documentTypeKey === 'passport')) {
        const [first, second] = now.checklist.filter((l) => l.document);
        await api('POST', `/documents/${first.document.id}/verify`, { decision: 'APPROVED' });
        await api('POST', `/documents/${second.document.id}/verify`, { decision: 'REJECTED', reason: 'The photo is too small to read. Please upload the full page. (flow test)' });
        // Rejecting a required document already hands the request to the customer (workflow engine); no separate question is needed.
        await api('POST', `/requests/${requestId}/comments`, { body: 'Saturday is fine, we are open until 2 pm. (flow test)', visibility: 'CUSTOMER' });
        now = await request();
      }

      // 2. Customer: the conversation list marks the answer as new; the request says what to do; a new file is uploaded.
      if (now.status === 'AWAITING_CUSTOMER') {
        await go(page, '/messages');
        await must(page.locator('main a[data-unread]'), 'the conversation marked as new');
        await step(page, flow, '1-messages-new');
        await go(page, '/requests');
        await must(page.locator(RECORD).filter({ hasText: requestNo }), 'the request in the list');
        await step(page, flow, '2-requests-action-needed');
        await openRow(page, requestNo);
        await must(page.locator('[data-waiting-on="CUSTOMER"]'), 'the "your turn" card');
        await must(page.locator('[data-waiting-on="CUSTOMER"]').getByText('too small to read'), 'the reason of the centre in the "your turn" card');
        await step(page, flow, '3-request-your-turn');
        await page.getByRole('tab', { name: /Documents/ }).click();
        const rejected = page.locator('main li[data-checklist-status="REJECTED"]');
        await must(rejected, 'the rejected document line');
        await must(rejected.getByText('too small to read'), 'the reason of the rejection');
        await step(page, flow, '4-rejected-document');
        await uploadTo(rejected, { name: 'landlord-passport-full-page.pdf', mimeType: 'application/pdf', buffer: pdf('SAMPLE passport, full page (not a real document)') });
        await rejected.waitFor({ state: 'detached', timeout: 60_000 });
        await page.locator('main li[data-checklist-status="SCANNING"]').waitFor({ state: 'detached', timeout: 60_000 }).catch(() => {});
        await settle(page);
        await step(page, flow, '5-replaced');
        await page.getByRole('tab', { name: /Overview/ }).click();
        await page.getByRole('button', { name: 'Send back to the centre' }).click();
        await toast(page, 'Sent back to the centre');
        await must(page.locator('[data-waiting-on="CENTRE"]'), 'the request back with the centre');
        await settle(page);
        await step(page, flow, '6-sent-back');
        now = await request();
      }

      // 3. Staff: the new copy is accepted, a quotation is built from the service price and sent.
      if (now.status === 'UNDER_REVIEW' && !now.finance.quotation) {
        for (const line of now.checklist.filter((l) => l.document && l.document.verificationStatus !== 'VERIFIED')) await api('POST', `/documents/${line.document.id}/verify`, { decision: 'APPROVED' });
        const quotation = await api('POST', `/quotations/from-request/${requestId}`, { notes: 'Typing and one printed copy. (flow test)' });
        await api('POST', `/quotations/${quotation.id}/send`);
        now = await request();
      }

      // 4. Customer: review and approve the quotation; the invoice opens.
      if (now.status === 'QUOTED') {
        await go(page, `/requests/${requestId}`);
        await must(page.getByRole('link', { name: 'Review the quotation' }), 'the "Review the quotation" action on the request');
        await step(page, flow, '7-request-quoted');
        await page.getByRole('link', { name: 'Review the quotation' }).first().click();
        await page.waitForURL(/\/quotations\/[0-9a-f-]{36}/);
        await must(page.locator('[data-action="approve"]'), 'the approve button');
        await settle(page);
        await step(page, flow, '8-quotation');
        const download = page.waitForEvent('download', { timeout: 60_000 });
        await page.getByRole('button', { name: 'PDF' }).click();
        if (!/\.pdf$/.test((await download).suggestedFilename())) throw new Error('the quotation PDF did not download');
        await page.locator('[data-action="approve"]').click();
        await must(page.getByRole('alertdialog'), 'the confirmation of the approval');
        await step(page, flow, '9-approve-confirm');
        await page.getByRole('alertdialog').getByRole('button', { name: 'Approve quotation' }).click();
        await page.waitForURL(/\/invoices\/[0-9a-f-]{36}/, { timeout: 60_000 });
        saveState({ invoiceId: page.url().split('/').pop().split('?')[0] });
      }

      // 5. Customer: pay online. The first try is declined, the second one goes through.
      const { invoiceId } = readState();
      if (!invoiceId) throw new Error('no invoice: the approval did not create one');
      await go(page, `/invoices/${invoiceId}`);
      if (await page.locator('[data-pay-card]').count()) {
        await must(page.locator('[data-pay-card]').getByRole('button', { name: 'Pay online' }), 'the "Pay online" button');
        await step(page, flow, '10-invoice-to-pay');
        await page.locator('[data-pay-card]').getByRole('button', { name: 'Pay online' }).click();
        await must(page.locator('[data-test-pay="fail"]'), 'the test checkout');
        await settle(page);
        await step(page, flow, '11-test-checkout');
        await page.locator('[data-test-pay="fail"]').click();
        await page.waitForURL(/payments\/return/, { timeout: 60_000 });
        await must(page.locator('[data-payment-state="failed"]'), 'the declined payment, read from the API', 60_000);
        await step(page, flow, '12-payment-declined');
        await page.getByRole('link', { name: 'Try again' }).click();
        await page.waitForURL(/\/invoices\/[0-9a-f-]{36}/);
        await must(page.locator('[data-pay-card]').getByRole('button', { name: 'Pay online' }), 'the invoice, still to pay after the declined try');
        await page.locator('[data-pay-card]').getByRole('button', { name: 'Pay online' }).click();
        await page.locator('[data-test-pay="complete"]').click();
        await page.waitForURL(/payments\/return/, { timeout: 60_000 });
        await must(page.locator('[data-payment-state="paid"]'), 'the confirmed payment, read from the API', 60_000);
        await settle(page);
        await step(page, flow, '13-payment-received');
        const receipt = page.waitForEvent('download', { timeout: 60_000 });
        await page.getByRole('button', { name: 'Download receipt' }).click();
        if (!/\.pdf$/.test((await receipt).suggestedFilename())) throw new Error('the receipt PDF did not download');
        // A forged address must not turn anything into "paid": the page reads the payment, not the query string.
        await go(page, `/payments/return?invoice=${invoiceId}&payment=00000000-0000-4000-8000-000000000000&result=success`);
        if (await page.locator('[data-payment-state="paid"]').count()) throw new Error('a forged return address was shown as paid');
        await step(page, flow, '14-forged-return');
      }

      // 6. The invoice is paid for the customer and for the centre.
      await go(page, `/invoices/${invoiceId}`);
      await must(page.locator('[data-balance="0.00"]'), 'a balance of 0.00 on the invoice');
      if (await page.locator('[data-pay-card]').count()) throw new Error('a paid invoice still offers to pay');
      await step(page, flow, '15-invoice-paid');
      const invoice = await api('GET', `/invoices/${invoiceId}`);
      if (invoice.status !== 'PAID') throw new Error(`the centre sees the invoice as ${invoice.status}, not PAID`);
      await go(page, '/payments?tab=payments');
      await must(page.locator(RECORD).first(), 'the payment in the list');
      await step(page, flow, '16-payments');
      await go(page, `/requests/${requestId}`);
      await step(page, flow, '17-request-after-payment');
    },
  },
  {
    // A second request: saved as a draft, found again in the list, finished, quoted by the centre, the quotation
    // declined with a reason and the request cancelled. Then a draft that is started and discarded.
    name: 'flow-draft-decline-cancel',
    path: SIGN_IN,
    ready: 'form',
    variants: PHONE,
    act: async (page) => {
      const flow = 'flow-draft-decline-cancel';
      const api = await staff();
      await login(page, newCustomer());
      const startLetter = async () => {
        await go(page, '/requests/new');
        await page.locator('main ul li button:visible').filter({ hasText: 'Letter and application typing' }).first().click();
        await must(page.getByRole('button', { name: 'Start this request' }), 'the service summary');
        await page.getByRole('button', { name: 'Start this request' }).click();
        await page.waitForURL(/step=details/);
        await must(page.getByLabel('What should the letter say?'), 'the form of the service');
      };

      // 1. Start, fill half, "Save and finish later".
      await startLetter();
      await page.getByLabel('What should the letter say?').fill('A no-objection letter for my bank. (flow test)');
      await must(page.locator('[data-save-state="saved"]'), 'the automatic save', 20_000);
      await step(page, flow, '1-half-filled');
      await page.getByRole('button', { name: 'Save and finish later' }).click();
      await page.waitForURL(/\/requests(\?|$)/);
      const draft = page.locator(RECORD).filter({ hasText: 'Letter and application typing' }).filter({ hasText: 'Draft' });
      await must(draft, 'the draft in the list of requests');
      await settle(page);
      await step(page, flow, '2-draft-in-list');

      // 2. The draft opens in the wizard with what was typed; the missing required answer stops "Continue".
      await draft.first().locator('a').first().click();
      await page.waitForURL(/requests\/new\?.*draft=/);
      await must(page.getByLabel('What should the letter say?'), 'the draft in the wizard');
      if (!(await page.getByLabel('What should the letter say?').inputValue()).includes('no-objection letter')) throw new Error('the draft lost the text');
      await page.getByRole('button', { name: 'Continue' }).click();
      await must(page.locator('main [role="alert"]').filter({ hasText: 'This field is required' }), 'the message for the missing language');
      await choose(page, page.getByLabel('Language'), /English/);
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.waitForURL(/step=documents/);
      await settle(page);
      await step(page, flow, '3-no-documents-needed');
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.waitForURL(/step=review/);
      await must(page.getByRole('button', { name: 'Submit request' }), 'the submit button');
      await page.getByRole('button', { name: 'Submit request' }).click();
      await must(page.getByText('Request submitted'), 'the confirmation', 60_000);
      const requestNo = (await page.locator('[data-request-no]').innerText()).trim();
      await page.getByRole('link', { name: 'Open my request' }).click();
      await page.waitForURL(/\/requests\/[0-9a-f-]{36}$/);
      const requestId = page.url().split('/').pop();
      saveState({ secondRequestId: requestId, secondRequestNo: requestNo });

      // 3. Staff: a quotation. Customer: declines it, and the form insists on a reason.
      const quotation = await api('POST', `/quotations/from-request/${requestId}`, {});
      await api('POST', `/quotations/${quotation.id}/send`);
      await go(page, '/quotations');
      await must(page.locator(RECORD).filter({ hasText: quotation.quotationNo }), 'the new quotation in the list');
      await step(page, flow, '4-quotations');
      await openRow(page, quotation.quotationNo);
      await page.locator('[data-action="reject"]').click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: 'Decline quotation' }).click();
      await must(dialog.locator('[role="alert"]'), 'the message that a reason is needed');
      await dialog.getByLabel('Reason').fill('I will bring my own printed copy. (flow test)');
      await step(page, flow, '5-decline-reason');
      await dialog.getByRole('button', { name: 'Decline quotation' }).click();
      await toast(page, `Quotation ${quotation.quotationNo} declined`);
      await dialog.waitFor({ state: 'detached' });
      await page.locator('[data-action="approve"]').waitFor({ state: 'detached', timeout: 30_000 });
      await must(page.getByText('I will bring my own printed copy'), 'the reason on the declined quotation');
      await settle(page);
      await step(page, flow, '6-declined');
      const seen = await api('GET', `/quotations/${quotation.id}`);
      if (seen.status !== 'REJECTED') throw new Error(`the centre sees the quotation as ${seen.status}`);

      // 4. Cancel the request, with the reason the centre will read.
      await go(page, `/requests/${requestId}`);
      await step(page, flow, '7-request-after-decline');
      await page.getByRole('button', { name: 'Cancel request' }).click();
      const cancel = page.getByRole('dialog');
      await cancel.getByLabel('Why are you cancelling?').fill('I no longer need the letter. (flow test)');
      await step(page, flow, '8-cancel-dialog');
      await cancel.getByRole('button', { name: 'Cancel request' }).click();
      await toast(page, `Request ${requestNo} cancelled`);
      await must(page.locator('[data-waiting-on="NOBODY"]'), 'the cancelled request');
      await settle(page);
      await step(page, flow, '9-cancelled');
      const closed = await api('GET', `/requests/${requestId}`);
      if (closed.status !== 'CANCELLED') throw new Error(`the centre sees the request as ${closed.status}`);

      // 5. A draft that is started by mistake is discarded.
      await startLetter();
      await page.getByRole('button', { name: 'Discard this draft' }).click();
      await must(page.getByRole('alertdialog'), 'the confirmation before discarding');
      await step(page, flow, '10-discard-confirm');
      await page.getByRole('alertdialog').getByRole('button', { name: 'Discard this draft' }).click();
      await page.waitForURL(/\/requests(\?|$)/);
      await must(page.locator('[data-sonner-toast]').filter({ hasText: 'discarded' }), 'the toast of the discarded draft');
      await settle(page);
      await step(page, flow, '11-after-discard');
    },
  },
  {
    // Book a visit from the request page, move it to another time, cancel it.
    name: 'flow-appointment',
    path: SIGN_IN,
    ready: 'form',
    variants: PHONE,
    act: async (page) => {
      const flow = 'flow-appointment';
      const { requestId } = readState();
      await login(page, newCustomer());
      await go(page, `/requests/${requestId}`);
      await page.getByRole('link', { name: 'Book a visit' }).click();
      await page.waitForURL(/appointments\?.*book=1/);
      const dialog = page.getByRole('dialog');
      await must(dialog.getByLabel('Day'), 'the booking dialog');
      // The first day from tomorrow on that has a free time (the branch is closed on some days).
      const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
      const free = dialog.locator('[role="radio"]:not([disabled])');
      let sawClosedDay = false;
      for (let n = 1; n < 10; n += 1) {
        await dialog.getByLabel('Day').fill(day(n));
        await dialog.locator('[role="status"]').waitFor({ state: 'detached' }).catch(() => {});
        await page.waitForTimeout(600);
        if (await free.count()) break;
        if (!sawClosedDay) {
          sawClosedDay = true;
          await step(page, flow, '1-day-without-times');
        }
      }
      if (!(await free.count())) throw new Error('no free appointment time in the next 9 days');
      await free.nth(1).click();
      await dialog.getByLabel('Note for the centre').fill('I will collect the tenancy contract. (flow test)');
      await step(page, flow, '2-time-chosen');
      await dialog.getByRole('button', { name: /^Book \d/ }).click();
      await toast(page, 'Appointment booked');
      await dialog.waitFor({ state: 'detached' });
      const card = page.locator('main li[data-appointment-status]').first();
      await must(card, 'the appointment in the list');
      await settle(page);
      await step(page, flow, '3-booked');
      const before = await card.innerText();

      await card.getByRole('button', { name: 'Reschedule' }).click();
      await must(dialog.getByText('Choose a new time'), 'the reschedule dialog');
      await dialog.locator('[role="status"]').waitFor({ state: 'detached' }).catch(() => {});
      await must(free, 'free times for the new day');
      await free.nth(3).click();
      await step(page, flow, '4-reschedule');
      await dialog.getByRole('button', { name: /^Book \d/ }).click();
      await toast(page, 'Appointment rescheduled');
      await dialog.waitFor({ state: 'detached' });
      await settle(page);
      const upcoming = page.locator('main li[data-appointment-status]:has(button)').first();
      if ((await upcoming.innerText()) === before) throw new Error('the appointment shows the same time after rescheduling');
      await step(page, flow, '5-rescheduled');

      await upcoming.getByRole('button', { name: 'Cancel appointment' }).click();
      const confirm = page.getByRole('alertdialog');
      await confirm.getByLabel('Reason').fill('Plans changed. (flow test)');
      await step(page, flow, '6-cancel-confirm');
      await confirm.getByRole('button', { name: 'Cancel appointment' }).click();
      await toast(page, 'Appointment cancelled');
      await must(page.locator('main li[data-appointment-status="CANCELLED"]'), 'the cancelled appointment');
      await settle(page);
      await step(page, flow, '7-cancelled');
    },
  },
  {
    // A question to the centre with a file, the centre's answer, the customer's reply, "resolved", and a rating.
    name: 'flow-support',
    path: SIGN_IN,
    ready: 'form',
    variants: PHONE,
    act: async (page) => {
      const flow = 'flow-support';
      const { requestId, requestNo } = readState();
      const api = await staff();
      await login(page, newCustomer());
      await go(page, `/requests/${requestId}`);
      await page.getByRole('link', { name: 'Ask about this request' }).click();
      await page.waitForURL(/support\?.*new=1/);
      const dialog = page.getByRole('dialog');
      await must(dialog.getByLabel('Subject'), 'the question form');
      await dialog.getByRole('button', { name: 'Send question' }).click();
      await must(dialog.locator('[role="alert"]').first(), 'messages for the empty form');
      await step(page, flow, '1-validation');
      await dialog.getByLabel('Subject').fill('Can a relative collect the contract? (flow test)');
      await choose(page, dialog.getByLabel('Topic'), 'Request status');
      await dialog.getByLabel('Your question').fill('My brother is in Deira on Saturday. Can he collect the contract with a copy of my Emirates ID?');
      await dialog.locator('input[type="file"]').first().setInputFiles({ name: 'authorisation-letter-sample.pdf', mimeType: 'application/pdf', buffer: pdf('SAMPLE authorisation letter (not a real document)') });
      await must(dialog.getByText('authorisation-letter-sample.pdf'), 'the attached file');
      await must(dialog.getByRole('button', { name: 'Send question' }).and(page.locator(':not([disabled])')), 'the send button after the upload', 60_000);
      if (!(await dialog.getByText(requestNo).count())) throw new Error('the request was not preselected');
      await step(page, flow, '2-question');
      await dialog.getByRole('button', { name: 'Send question' }).click();
      await page.waitForURL(/\/support\/[0-9a-f-]{36}/, { timeout: 60_000 });
      const ticketId = page.url().split('/').pop().split('?')[0];
      await must(page.locator('main').getByText('My brother is in Deira'), 'the question in the conversation');
      await must(page.locator('main').getByText('authorisation-letter-sample.pdf'), 'the attachment in the conversation');
      await settle(page);
      await step(page, flow, '3-asked');

      // The centre answers and asks something back.
      await api('POST', `/support/tickets/${ticketId}/messages`, { body: 'Yes. Please tell us the full name of your brother so we can note it on the request. (flow test)', visibility: 'CUSTOMER', status: 'WAITING_CUSTOMER' });
      await api('POST', `/support/tickets/${ticketId}/messages`, { body: 'Internal note that the customer must never see. (flow test)', visibility: 'INTERNAL' });
      await go(page, '/support');
      await must(page.locator(RECORD).filter({ hasText: 'Waiting for your reply' }), 'the list saying the centre waits for a reply');
      await step(page, flow, '4-waiting-for-you');
      await openRow(page, 'Can a relative collect');
      await must(page.locator('main').getByText('full name of your brother'), 'the answer of the centre');
      if (await page.getByText('Internal note that the customer must never see').count()) throw new Error('an internal note is visible to the customer');
      await page.getByLabel('Your reply').fill('His name is Omar Demo Hassan. (flow test)');
      await page.getByRole('button', { name: 'Send reply' }).click();
      await toast(page, 'Reply sent');
      await must(page.locator('main').getByText('Omar Demo Hassan'), 'the reply in the conversation');
      await settle(page);
      await step(page, flow, '5-replied');

      // The centre resolves it; the customer rates the help.
      await api('POST', `/support/tickets/${ticketId}/status`, { status: 'RESOLVED', resolutionSummary: 'Collection by the brother noted on the request. (flow test)' });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await must(page.getByText('The centre marked this as resolved'), 'the resolved note');
      await must(page.getByText('How did we do?'), 'the rating card');
      await page.getByRole('radio', { name: '5 stars out of 5' }).click();
      await page.getByLabel('Anything you want to add?').fill('Quick and clear. (flow test)');
      await settle(page);
      await step(page, flow, '6-resolved-rating');
      await page.getByRole('button', { name: 'Send rating' }).click();
      await toast(page, 'Thank you for your rating');
      await page.getByRole('button', { name: 'Send rating' }).waitFor({ state: 'detached' });
      await settle(page);
      await step(page, flow, '7-rated');
    },
  },
  {
    // The document vault: upload with an expiry date, security check, view, a new version.
    name: 'flow-documents',
    path: SIGN_IN,
    ready: 'form',
    variants: PHONE,
    act: async (page) => {
      const flow = 'flow-documents';
      await login(page, newCustomer());
      await go(page, '/documents');
      const dialog = page.getByRole('dialog');
      // Without a title the document is listed under the name of its kind ("Passport").
      const row = page.locator(RECORD).filter({ hasText: '20 Nov 2026' });
      await page.locator(RECORD).first().waitFor();
      if (!(await row.count())) {
        await page.getByRole('button', { name: 'Upload a document' }).first().click();
        await must(dialog.getByText('Choose the kind of document first.'), 'the hint to choose the kind first');
        await choose(page, dialog.getByLabel('What kind of document is it?'), /^Passport/);
        await dialog.getByLabel('Expiry date').fill('2026-11-20');
        await dialog.locator('input[type="file"]').first().setInputFiles({ name: 'my-passport-sample.pdf', mimeType: 'application/pdf', buffer: pdf('SAMPLE passport of the account holder (not a real document)') });
        await must(dialog.getByText('Uploaded. The file is checked'), 'the note after the upload', 60_000);
        await step(page, flow, '1-uploaded');
        await dialog.getByRole('button', { name: 'Done' }).click();
        await toast(page, 'Document uploaded');
      }
      await must(row, 'the new document in the list', 60_000);
      // The list re-checks by itself until the security check is over.
      await row.first().getByRole('button', { name: 'More actions' }).waitFor({ timeout: 90_000 });
      await settle(page);
      await step(page, flow, '2-in-the-list');

      await row.first().getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'View' }).click();
      await must(page.getByRole('dialog').locator('iframe, embed, object, img, canvas'), 'the document in the viewer', 60_000);
      await page.waitForTimeout(1500);
      await step(page, flow, '3-viewer');
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'detached' });

      await row.first().getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'Upload a new version' }).click();
      await must(dialog.getByText('The new file replaces'), 'the new-version dialog');
      await dialog.locator('input[type="file"]').first().setInputFiles({ name: 'my-passport-renewed-sample.png', mimeType: 'image/png', buffer: PNG });
      await must(dialog.getByText('Uploaded. The file is checked'), 'the note after the new version', 60_000);
      await step(page, flow, '4-new-version');
      await dialog.getByRole('button', { name: 'Done' }).click();
      await settle(page);
      await page.waitForTimeout(4000);
      await step(page, flow, '5-after-new-version');

      // The new version is an image: the viewer shows it (headless Chromium has no PDF plug-in, so the PDF above stays blank there).
      await row.first().getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'View' }).click();
      await must(page.getByRole('dialog').locator('img'), 'the image of the new version in the viewer', 60_000);
      await page.waitForTimeout(800);
      await step(page, flow, '6-viewer-image');
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'detached' });

      const download = page.waitForEvent('download', { timeout: 60_000 });
      await row.first().getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'Download' }).click();
      if (!/\.png$/.test((await download).suggestedFilename())) throw new Error('the download is not the new version');
    },
  },
  {
    // Profile, permissions, how to be contacted, notifications, a copy of the data (prepared by the centre, downloaded here).
    name: 'flow-profile',
    path: SIGN_IN,
    ready: 'form',
    variants: PHONE,
    act: async (page) => {
      const flow = 'flow-profile';
      const api = await staff();
      await login(page, newCustomer());

      // 1. Details.
      await go(page, '/profile');
      await page.getByLabel('Full name').fill('');
      await page.getByRole('button', { name: 'Save changes' }).click();
      await must(page.locator('main form [role="alert"]').first(), 'the message for an empty name');
      await page.getByLabel('Full name').fill('Mariam Demo Hassan');
      await page.getByLabel('Name in Arabic').fill('مريم تجريبي حسن');
      await page.getByLabel('Street and building').fill('Sample Street 4 (fictional)');
      await page.getByLabel('City').fill('Dubai');
      await page.getByRole('button', { name: 'Save changes' }).click();
      await toast(page, 'Your details were saved');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await must(page.getByLabel('Street and building'), 'the profile after a reload');
      if ((await page.getByLabel('Street and building').inputValue()) !== 'Sample Street 4 (fictional)') throw new Error('the address was not saved');
      await settle(page);
      await step(page, flow, '1-details-saved');

      // 2. Permissions: one switched on and off again (the state is put back).
      await go(page, '/profile?tab=privacy');
      const marketing = page.locator('[data-consent="MARKETING"]');
      await must(marketing, 'the permissions');
      const was = await marketing.getAttribute('data-granted');
      await marketing.getByRole('switch').click();
      await must(page.locator(`[data-consent="MARKETING"][data-granted="${was === 'true' ? 'false' : 'true'}"]`), 'the changed permission');
      await settle(page);
      await step(page, flow, '2-permission-changed');
      await page.locator('[data-consent="MARKETING"]').getByRole('switch').click();
      await must(page.locator(`[data-consent="MARKETING"][data-granted="${was}"]`), 'the permission put back');
      if (await page.locator('[data-consent="SERVICE_PROCESSING"]').getByRole('switch').count()) throw new Error('the permission that the service needs can be switched off');

      // 3. A copy of my data: asked here, prepared by the centre, downloaded here.
      await page.locator('[data-privacy-type="EXPORT"]').click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel(/Anything you want to tell the centre/).fill('For my own records. (flow test)');
      await step(page, flow, '3-ask-for-copy');
      await dialog.getByRole('button', { name: 'Ask for a copy' }).click();
      await toast(page, 'Your request was sent');
      await must(page.locator('[data-privacy-status]'), 'the request in "Your requests"');
      await must(page.locator('[data-privacy-type="EXPORT"][disabled]'), 'the button that says it was already requested');
      await settle(page);
      await step(page, flow, '4-copy-requested');
      const mine = (await api('GET', '/privacy/requests?pageSize=50')).data.find((r) => r.type === 'EXPORT' && r.details?.includes('flow test') && !['COMPLETED', 'REJECTED'].includes(r.status));
      if (!mine) throw new Error('the centre does not see the privacy request');
      await api('POST', `/privacy/requests/${mine.id}/review`, {});
      await api('POST', `/privacy/requests/${mine.id}/decision`, { decision: 'APPROVED', decisionNote: 'Identity confirmed; the file is ready. (flow test)' });
      await api('POST', `/privacy/requests/${mine.id}/complete`, { note: 'Export produced. (flow test)' });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await must(page.getByRole('button', { name: 'Download my data' }), 'the download button of the finished export', 60_000);
      const download = page.waitForEvent('download', { timeout: 60_000 });
      await page.getByRole('button', { name: 'Download my data' }).first().click();
      await download;
      await settle(page);
      await step(page, flow, '5-copy-ready');

      // 4. How the centre may contact me: one channel off and on again.
      await go(page, '/notifications?tab=settings');
      const sms = page.locator('#channel-SMS');
      await must(sms, 'the channel switches');
      const smsWas = await sms.getAttribute('aria-checked');
      await sms.click();
      await must(page.locator(`#channel-SMS[aria-checked="${smsWas === 'true' ? 'false' : 'true'}"]`), 'the changed channel');
      await settle(page);
      await step(page, flow, '6-channel-changed');
      await page.locator('#channel-SMS:not([disabled])').click();
      await must(page.locator(`#channel-SMS[aria-checked="${smsWas}"]`), 'the channel put back');

      // 5. Notifications: open one (it is marked read and leads to its subject), then mark everything read.
      await go(page, '/notifications');
      const unread = page.locator('main li[data-unread]');
      await must(unread, 'unread notifications');
      const count = await unread.count();
      await step(page, flow, '7-notifications');
      await unread.first().locator('button').click();
      await page.waitForURL((url) => !/\/notifications/.test(url.pathname), { timeout: 30_000 });
      await page.locator('main h1').first().waitFor();
      await go(page, '/notifications');
      await must(page.locator('main [role="tabpanel"] ul li').first(), 'the inbox');
      if ((await page.locator('main li[data-unread]').count()) >= count && count < 20) throw new Error('opening a notification did not mark it as read');
      await page.getByRole('button', { name: 'Mark all as read' }).click();
      await toast(page, 'All notifications marked as read');
      await page.locator('main li[data-unread]').first().waitFor({ state: 'detached' });
      await settle(page);
      await step(page, flow, '8-all-read');
      await page.getByRole('switch', { name: 'Show unread only' }).click();
      await must(page.getByText('You have read everything'), 'the empty "unread only" state');
      await step(page, flow, '9-unread-only-empty');
    },
  },
  {
    // Password and devices of the customer of flow-register (never of a demo account): a wrong current password is
    // refused, the password is changed, the new one signs in, and it is changed back.
    name: 'flow-security',
    path: SIGN_IN,
    ready: 'form',
    variants: PHONE,
    act: async (page) => {
      const flow = 'flow-security';
      const email = newCustomer();
      const other = 'TypEase-Flow-2027!';
      const change = async (from, to) => {
        await go(page, '/profile?tab=security');
        await page.locator('main input[autocomplete="current-password"]').fill(from);
        await page.locator('main input[autocomplete="new-password"]').nth(0).fill(to);
        await page.locator('main input[autocomplete="new-password"]').nth(1).fill(to);
        await page.getByRole('button', { name: 'Change password' }).click();
      };
      await login(page, email);
      await go(page, '/profile?tab=security');
      await must(page.getByText('This device'), 'the list of signed-in devices');
      await settle(page);
      await step(page, flow, '1-security');
      await change('not-my-password-1A!', other);
      await must(page.locator('main form [role="alert"]').first(), 'the message for a wrong current password');
      await step(page, flow, '2-wrong-current-password');
      const current = readState().password ?? PASSWORD;
      const next = current === PASSWORD ? other : PASSWORD;
      await change(current, next);
      await toast(page, 'Password changed');
      saveState({ password: next });
      // Sign out and in again with the new password.
      const context = page.context();
      await context.clearCookies();
      await page.goto(`${origin(page)}${SIGN_IN}`, { waitUntil: 'domcontentloaded' });
      await page.locator('input[type="email"]').waitFor();
      await login(page, email, next);
      await step(page, flow, '3-signed-in-with-new-password');
      if (next !== PASSWORD) {
        await change(next, PASSWORD);
        await toast(page, 'Password changed');
        saveState({ password: PASSWORD });
      }
    },
  },
];

// Flows write data: they run only when --only names them, never as part of the plain run of every screen.
const onlyArg = process.argv.indexOf('--only');
const only = onlyArg >= 0 ? (process.argv[onlyArg + 1] ?? '').split(',') : [];
export default [...screens, ...flows.filter((flow) => only.includes(flow.name))];
