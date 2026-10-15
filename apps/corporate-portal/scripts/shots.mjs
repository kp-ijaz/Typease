/**
 * Screenshot scenarios of the corporate portal (signed-in screens).
 *
 *   export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
 *   node packages/ui/scripts/screenshots.mjs --app corporate --scenarios apps/corporate-portal/scripts/shots.mjs --out /tmp/shots-corporate-portal [--only requests,...]
 *
 * Read-only scenarios take pictures of seeded records of the demo company Falcon Demo Logistics at the
 * demo centre Al Noor (looked up through the UI, never by a hard-coded id). Scenarios whose name starts
 * with "flow-" WRITE to the database through the UI (an employee, a portal login, a request, a quotation
 * decision, a payment, a ticket ...): run them on a demo database only, one at a time with --only. They
 * save a picture of every step next to the final one, as corporate-<scenario>-<step>.png.
 *
 * The scenarios named "employee-*" sign in as a company employee. The demo seed has no such login:
 * run flow-employee-login once first, it invites Ibrahim Saleh from the employee directory and accepts
 * the invitation.
 */
import { resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const TENANT = 'al-noor';
const ADMIN = 'admin@falcon-demo.test'; // administrator of Falcon Demo Logistics: employees, requests, invoices
const SUSPENDED = 'admin@marsa-demo.test'; // administrator of a company whose account is suspended
const EMPLOYEE = 'ibrahim.saleh@example.test'; // an employee of Falcon with a portal login (created by flow-employee-login)
const EMPLOYEE_NAME = 'Ibrahim Saleh';
const PASSWORD = 'TypEase-Demo-2026';
const API = process.env.TYPEASE_API ?? 'http://localhost:4000/api/v1';
const baseArg = process.argv.indexOf('--base');
const BASE = baseArg >= 0 ? process.argv[baseArg + 1] : 'http://localhost:3003';
const SIGN_IN = `/sign-in?tenant=${TENANT}`;
const ROW = 'main table tbody tr a:visible, main ul li a:visible';
const RECORD = 'main table tbody tr:visible, main ul li:visible';
const EN = ['en-light-desktop'];
const PHONE = ['en-light-mobile'];
const EN_PHONE = ['en-light-desktop', 'en-light-mobile'];
const AR_PHONE = ['ar-dark-desktop', 'en-light-mobile'];

const outArg = process.argv.indexOf('--out');
const OUT = resolve(process.cwd(), outArg >= 0 ? process.argv[outArg + 1] : 'docs/brand/screenshots');
mkdirSync(OUT, { recursive: true });

const settle = async (page) => {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(400);
};
const as = (email, extra) => ({ as: email, signInPath: SIGN_IN, ...extra });
/** A step picture of a flow. */
const step = (page, flow, name) => page.screenshot({ path: resolve(OUT, `corporate-${flow}-${name}.png`), fullPage: true, animations: 'disabled' });
const must = async (locator, what, timeout = 30_000) => {
  try {
    // Lists exist twice in the page (table and phone cards): only what can be seen counts.
    await locator.filter({ visible: true }).first().waitFor({ state: 'visible', timeout });
  } catch {
    throw new Error(`expected to see: ${what}`);
  }
};
const mustNot = async (page, selector, what) => {
  if (await page.locator(selector).filter({ visible: true }).count()) throw new Error(`must not be shown: ${what}`);
};
/** Opens the row of a list that contains the text (a request number, a name, a subject). */
const openRow = async (page, text) => {
  await page.locator(RECORD).filter({ hasText: text }).first().locator('a').first().click();
  await page.waitForURL(/\/[0-9a-f-]{36}/);
  await page.locator('main h1').waitFor();
  await settle(page);
};
const origin = (page) => new URL(page.url()).origin;
const go = async (page, path) => {
  await page.goto(`${origin(page)}${path}`, { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 90_000 });
  await page.locator('main h1').first().waitFor({ timeout: 90_000 });
  await settle(page);
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
/** A screen the signed-in person has no permission for: the explanation, and none of the data. */
const noAccess = async (page) => {
  await must(page.locator('[data-no-access]'), 'the "not available to you" explanation');
  await mustNot(page, 'main table tbody tr', 'rows of a list the person may not read');
};
/** A small valid PNG / PDF to upload (generated, never a real document). */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC', 'base64');
const pdf = (text) =>
  Buffer.from(
    `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length ${44 + text.length}>>stream\nBT /F1 14 Tf 20 100 Td (${text}) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
  );

/** The staff side of a flow (verify documents, issue a quotation, answer a ticket ...) through the API, as the centre owner. */
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
  // ------------------------------------------------------------------ the company administrator (read-only)
  { name: 'overview', path: '/overview', ...as(ADMIN), ready: 'main [data-expiring-soon]', fullPage: true },
  { name: 'employees', path: '/employees', ...as(ADMIN), ready: ROW, fullPage: true },
  {
    name: 'employees-row-menu',
    path: '/employees',
    ...as(ADMIN),
    ready: ROW,
    variants: EN_PHONE,
    act: async (page) => {
      await page.locator(RECORD).filter({ hasText: 'Chandani Silva' }).first().getByRole('button', { name: 'More actions' }).click();
      await must(page.getByRole('menuitem', { name: 'Invite to the portal' }), 'the invitation action of an employee without a login');
    },
  },
  {
    name: 'employees-add-validation',
    path: '/employees',
    ...as(ADMIN),
    ready: ROW,
    act: async (page) => {
      await page.locator('[data-action="add-employee"]').first().click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      await dialog.locator('input[type="email"]').fill('not-an-email');
      await dialog.locator('button[type="submit"]').click();
      await dialog.locator('[role="alert"]').first().waitFor();
    },
  },
  {
    name: 'employee-detail',
    path: '/employees',
    ...as(ADMIN),
    ready: ROW,
    fullPage: true,
    act: async (page) => {
      await openRow(page, 'Mohan Lal Shrestha');
      // Identity numbers reach the browser masked only.
      await must(page.locator('[data-identity] [data-masked]'), 'a masked identity number');
      const numbers = await page.locator('[data-identity] [data-masked]').allInnerTexts();
      if (numbers.some((n) => !/[•*Xx·]/.test(n))) throw new Error(`an identity number is not masked: ${numbers.join(', ')}`);
      await must(page.locator('[data-employee-requests]'), 'the requests of this employee');
      await must(page.locator('[data-employee-requests]').filter({ hasText: 'AN-000053' }), 'request AN-000053 of this employee');
    },
  },
  { name: 'requests', path: '/requests', ...as(ADMIN), ready: ROW },
  {
    name: 'requests-of-employee',
    path: '/requests',
    ...as(ADMIN),
    ready: ROW,
    variants: EN_PHONE,
    act: async (page) => {
      await choose(page, page.locator('[data-employee-filter] button, button[data-employee-filter]').first(), 'Ramon Dela Cruz');
      await page.waitForURL(/employee=[0-9a-f-]{36}/);
      await must(page.locator(RECORD).filter({ hasText: 'AN-000012' }), 'the request of Ramon Dela Cruz');
      await settle(page);
      if (await page.locator(RECORD).filter({ hasText: 'AN-000053' }).count()) throw new Error('the list still shows a request of another employee');
    },
  },
  {
    name: 'request-external',
    path: '/requests',
    ...as(ADMIN),
    ready: ROW,
    fullPage: true,
    act: async (page) => {
      await openRow(page, 'AN-000042');
      // An external status is never shown without its source.
      await must(page.locator('[data-external-status] [data-external-source]'), 'the source label of the external status');
    },
  },
  {
    name: 'request-ready',
    path: '/requests',
    ...as(ADMIN),
    ready: ROW,
    fullPage: true,
    variants: EN_PHONE,
    act: async (page) => {
      await openRow(page, 'AN-000053');
      await must(page.locator('[data-waiting-on]'), 'the "what happens now" card');
      await must(page.locator('[data-money-card]'), 'the quotation and invoice of the request');
    },
  },
  {
    name: 'request-completed',
    path: '/requests',
    ...as(ADMIN),
    ready: ROW,
    fullPage: true,
    variants: AR_PHONE,
    act: async (page) => {
      await openRow(page, 'AN-000012');
      await must(page.locator('[data-completed-documents]'), 'the completed documents');
      // The completed document really downloads (through a short-lived link from the API).
      const download = page.waitForEvent('download', { timeout: 60_000 });
      await page.locator('[data-completed-documents] button').first().click();
      await download;
      await settle(page);
    },
  },
  {
    name: 'request-tabs',
    path: '/requests',
    ...as(ADMIN),
    ready: ROW,
    fullPage: true,
    variants: AR_PHONE,
    act: async (page) => {
      await openRow(page, 'AN-000053');
      await page.getByRole('tab').nth(1).click();
      await must(page.locator('main li[data-checklist-status]'), 'the document checklist of the request');
    },
  },
  { name: 'new-request-who', path: '/requests/new', ...as(ADMIN), ready: 'main [data-action="who-continue"]', fullPage: true },
  { name: 'new-request-services', path: '/requests/new?for=company', ...as(ADMIN), ready: 'main [data-service]', fullPage: true },
  {
    name: 'new-request-intro',
    path: '/requests/new?for=company',
    ...as(ADMIN),
    ready: 'main [data-service]',
    fullPage: true,
    act: async (page) => {
      // A service with a contract price of this company.
      await must(page.locator('main [data-service]:has([data-contract-price])'), 'a service with a contract price');
      await page.locator('main [data-service]:has([data-contract-price])').first().click();
      await must(page.locator('[data-action="start-request"]'), 'the summary of the service');
      await must(page.locator('[data-fee-source="CORPORATE_CONTRACT"]'), 'the contract price of the company');
      await settle(page);
    },
  },
  { name: 'approvals', path: '/approvals', ...as(ADMIN), ready: 'main [role="tabpanel"]', fullPage: true },
  { name: 'approvals-history', path: '/approvals?tab=history', ...as(ADMIN), ready: ROW, fullPage: true, variants: EN_PHONE },
  {
    name: 'approval-decided',
    path: '/approvals?tab=history',
    ...as(ADMIN),
    ready: ROW,
    fullPage: true,
    variants: AR_PHONE,
    act: async (page) => {
      await page.locator(RECORD).first().locator('a').first().click();
      await page.waitForURL(/\/approvals\/[0-9a-f-]{36}/);
      await must(page.locator('[data-decision]'), 'the decision that was taken');
      await mustNot(page, '[data-action="approve"]', 'the approve button on a decided quotation');
      await settle(page);
    },
  },
  { name: 'invoices', path: '/invoices', ...as(ADMIN), ready: 'main [data-statement]', fullPage: true },
  { name: 'invoices-all', path: '/invoices?tab=all', ...as(ADMIN), ready: ROW, fullPage: true },
  {
    name: 'invoice-unpaid',
    path: '/invoices?tab=all',
    ...as(ADMIN),
    ready: ROW,
    fullPage: true,
    act: async (page) => {
      await openRow(page, 'INV-000038');
      await must(page.locator('[data-pay-card]'), 'the amount to pay');
      const download = page.waitForEvent('download', { timeout: 60_000 });
      await page.locator('[data-action="invoice-pdf"]').first().click();
      if (!/\.pdf$/.test((await download).suggestedFilename())) throw new Error('the invoice PDF did not download');
    },
  },
  {
    name: 'invoice-paid',
    path: '/invoices?tab=all',
    ...as(ADMIN),
    ready: ROW,
    fullPage: true,
    variants: AR_PHONE,
    act: async (page) => {
      await openRow(page, 'INV-000012');
      await must(page.locator('[data-balance="0.00"]'), 'a balance of 0.00');
      await mustNot(page, '[data-pay-card]', 'a pay button on a paid invoice');
    },
  },
  { name: 'payment-return-missing', path: '/payments/return', ...as(ADMIN), ready: 'main h1', variants: EN },
  { name: 'reminders', path: '/reminders', ...as(ADMIN), ready: 'main [data-reminder]', fullPage: true },
  { name: 'documents', path: '/documents', ...as(ADMIN), ready: 'main table tbody tr:visible, main ul li:visible', fullPage: true },
  { name: 'notifications', path: '/notifications', ...as(ADMIN), ready: 'main [role="tabpanel"] ul li:visible' },
  { name: 'notifications-settings', path: '/notifications?tab=settings', ...as(ADMIN), ready: 'main [role="switch"]', fullPage: true },
  { name: 'company', path: '/company', ...as(ADMIN), ready: 'main [data-company-users] [data-member]', fullPage: true },
  { name: 'support', path: '/support', ...as(ADMIN), ready: 'main h1', fullPage: true },
  // Needs a conversation of the administrator (flow-support opens one).
  { name: 'support-ticket', path: '/support', ...as(ADMIN), ready: ROW, fullPage: true, act: async (page) => openRow(page, /Collection of the typed application/) },
  {
    name: 'navigation-drawer',
    path: '/overview',
    ...as(ADMIN),
    ready: 'main h1',
    variants: ['en-light-mobile', 'ar-dark-mobile'],
    act: async (page) => {
      await page.locator('header button').first().click();
      await page.getByRole('dialog').waitFor();
      await page.waitForTimeout(350);
    },
  },

  // ------------------------------------------------------------------ a company whose account is suspended
  { name: 'suspended-overview', path: '/overview', ...as(SUSPENDED), ready: 'main h1', fullPage: true, variants: EN_PHONE },
  {
    name: 'suspended-employees',
    path: '/employees',
    ...as(SUSPENDED),
    ready: 'main h1',
    fullPage: true,
    variants: EN,
    act: async (page) => {
      await settle(page);
      await mustNot(page, '[data-action="add-employee"]', 'the "Add employee" button while the account is suspended');
    },
  },
  { name: 'suspended-new-request', path: '/requests/new', ...as(SUSPENDED), ready: 'main h1', fullPage: true, variants: EN, act: settle },

  // ------------------------------------------------------------------ a company employee (own requests and documents only)
  {
    name: 'employee-overview',
    path: '/overview',
    ...as(EMPLOYEE),
    ready: 'main [data-employee-overview]',
    fullPage: true,
    act: async (page) => {
      await settle(page);
      // Nothing of the company's money or of the other employees.
      await mustNot(page, '[data-statement], [data-open-balance], [data-approvals-waiting]', 'company figures on the overview of an employee');
    },
  },
  {
    name: 'employee-navigation',
    path: '/overview',
    ...as(EMPLOYEE),
    ready: 'main [data-employee-overview]',
    variants: ['en-light-mobile', 'ar-dark-mobile'],
    act: async (page) => {
      await page.locator('header button').first().click();
      const drawer = page.getByRole('dialog');
      await drawer.waitFor();
      await page.waitForTimeout(350);
      for (const href of ['/employees', '/invoices', '/approvals', '/company']) {
        if (await drawer.locator(`a[href="${href}"]`).count()) throw new Error(`the navigation of an employee offers ${href}`);
      }
      for (const href of ['/requests', '/documents', '/reminders', '/notifications', '/support']) {
        if (!(await drawer.locator(`a[href="${href}"]`).count())) throw new Error(`the navigation of an employee misses ${href}`);
      }
    },
  },
  {
    name: 'employee-requests',
    path: '/requests',
    ...as(EMPLOYEE),
    ready: ROW,
    act: async (page) => {
      await settle(page);
      // Only the employee's own request: none of the colleagues' ones.
      await must(page.locator(RECORD).filter({ hasText: 'AN-000042' }), 'the own request AN-000042');
      for (const other of ['AN-000053', 'AN-000012', 'AN-000032', 'AN-000007']) {
        if (await page.locator(RECORD).filter({ hasText: other }).count()) throw new Error(`an employee sees the request ${other} of a colleague`);
      }
      await mustNot(page, '[data-employee-filter]', 'the employee filter');
    },
  },
  {
    name: 'employee-request',
    path: '/requests',
    ...as(EMPLOYEE),
    ready: ROW,
    fullPage: true,
    act: async (page) => {
      await openRow(page, 'AN-000042');
      await must(page.locator('[data-external-status] [data-external-source]'), 'the source label of the external status');
      // The company's quotation and invoice: where they stand, no amounts, nothing to decide.
      await must(page.locator('[data-money-card][data-amounts-hidden]'), 'the quotation and invoice without amounts');
      await mustNot(page, '[data-money-card] a[href*="/invoices/"], [data-money-card] a[href*="/approvals/"], [data-action="review-quotation"]', 'links into the company\'s money for an employee');
      if (await page.locator('[data-money-card]').getByText(/AED/).count()) throw new Error('an amount is shown to an employee');
    },
  },
  { name: 'employee-new-request', path: '/requests/new', ...as(EMPLOYEE), ready: 'main [data-service]', fullPage: true, variants: EN_PHONE, act: async (page) => mustNot(page, '[data-action="who-continue"]', 'the "who is it for" step') },
  { name: 'employee-documents', path: '/documents', ...as(EMPLOYEE), ready: 'main h1', fullPage: true, variants: EN_PHONE, act: settle },
  { name: 'employee-reminders', path: '/reminders', ...as(EMPLOYEE), ready: 'main h1', fullPage: true, variants: EN_PHONE, act: settle },
  { name: 'employee-notifications', path: '/notifications', ...as(EMPLOYEE), ready: 'main [role="tabpanel"]', variants: EN, act: settle },
  { name: 'employee-support', path: '/support', ...as(EMPLOYEE), ready: 'main h1', variants: EN, act: settle },
  // The API answers 403 for these: the browser logs the refused call, the screen explains it.
  { name: 'employee-no-directory', path: '/employees', ...as(EMPLOYEE), ready: 'main [data-no-access]', act: noAccess },
  { name: 'employee-no-invoices', path: '/invoices', ...as(EMPLOYEE), ready: 'main [data-no-access]', variants: EN_PHONE, act: noAccess },
  { name: 'employee-no-approvals', path: '/approvals', ...as(EMPLOYEE), ready: 'main [data-no-access]', variants: EN, act: noAccess },
  { name: 'employee-no-company', path: '/company', ...as(EMPLOYEE), ready: 'main [data-no-access]', variants: EN, act: noAccess },
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

const stamp = () => Date.now().toString().slice(-6);
/** Chooses an option of a searchable <Combobox>: types into its search box, then takes the option with exactly this label. */
const pick = async (page, trigger, text) => {
  await trigger.click();
  await page.locator('[cmdk-input]').fill(text);
  await page.locator('[cmdk-item]').filter({ has: page.getByText(text, { exact: true }) }).first().click();
};
/** Finds one person in the employee directory with the search box and returns the row. */
const findEmployee = async (page, name) => {
  await page.locator('main input[type="search"], main input[placeholder^="Search"]').first().fill(name);
  const row = page.locator(RECORD).filter({ hasText: name });
  await must(row, `${name} in the employee directory`);
  await settle(page);
  return row.first();
};
const rowAction = async (page, row, action) => {
  await row.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
};
/** A second browser (nobody signed in): the employee who opens an invitation, a colleague, a former user. */
const visitor = async (page) => {
  const context = await page.context().browser().newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-AE', timezoneId: 'Asia/Dubai' });
  await context.addCookies([{ name: 'te_locale', value: 'en', domain: new URL(page.url()).hostname, path: '/' }]);
  return context.newPage();
};
/** Signs in on the real sign-in screen of the portal. */
const signInAs = async (page, email, password = PASSWORD) => {
  await page.goto(`${BASE}${SIGN_IN}`, { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 90_000 });
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !/sign-in/.test(url.pathname), { timeout: 60_000 });
  await page.locator('main h1').first().waitFor({ timeout: 90_000 });
  await settle(page);
};
const dateFromToday = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const flows = [
  {
    // The employee directory: add one person (with the field errors first), correct a detail, import a list
    // pasted from a spreadsheet, deactivate and reactivate.
    name: 'flow-employees',
    path: '/employees',
    ...as(ADMIN),
    ready: ROW,
    variants: EN,
    act: async (page) => {
      const flow = 'flow-employees';
      const id = stamp();
      const name = `Priya Demo Nair ${id}`;

      // 1. Add: the form says what is wrong before anything is sent.
      await page.locator('[data-action="add-employee"]').first().click();
      let dialog = page.getByRole('dialog');
      await dialog.waitFor();
      await dialog.getByLabel('Emirates ID', { exact: true }).fill('12345');
      await dialog.getByLabel('Email').fill('priya@');
      await dialog.locator('button[type="submit"]').click();
      await must(dialog.locator('[role="alert"]').filter({ hasText: 'This field is required' }), 'the required-name message');
      await must(dialog.locator('[role="alert"]').filter({ hasText: /15 digits/ }), 'the Emirates ID format message');
      await step(page, flow, '1-add-validation');
      await dialog.getByLabel('Full name (English)').fill(name);
      await dialog.getByLabel('Employee number').fill(`FDL-${id}`);
      await dialog.getByLabel('Job title').fill('Accountant');
      await dialog.locator('input[type="tel"]').fill('50 123 4567');
      await dialog.getByLabel('Email').fill(`priya.demo.${id}@example.test`);
      await pick(page, dialog.getByLabel('Nationality'), 'India');
      await dialog.getByLabel('Date of birth').fill('1990-05-17');
      await dialog.getByLabel('Emirates ID', { exact: true }).fill(`784-1990-${id}7-1`);
      await dialog.getByLabel('Emirates ID expiry').fill(dateFromToday(400));
      await dialog.getByLabel('Passport', { exact: true }).fill(`P${id}9`);
      await pick(page, dialog.getByLabel('Passport issued by'), 'India');
      await dialog.getByLabel('Passport expiry').fill(dateFromToday(45));
      await step(page, flow, '2-add-filled');
      await dialog.locator('button[type="submit"]').click();
      await toast(page, 'Employee added');
      await dialog.waitFor({ state: 'detached' });
      let row = await findEmployee(page, name);
      // The numbers come back masked, and the passport that runs out in 45 days is flagged.
      const text = await row.innerText();
      if (text.includes(`784-1990-${id}7-1`) || text.includes(`P${id}9`)) throw new Error('an identity number is shown in full in the directory');
      await must(row.locator('[data-expiry="soon"]'), 'the expiry indicator of the passport');
      await step(page, flow, '3-added');

      // 2. The same Emirates ID again is refused by the API, and the form says so.
      await page.locator('[data-action="add-employee"]').first().click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('Full name (English)').fill(`Duplicate ${name}`);
      await dialog.getByLabel('Emirates ID', { exact: true }).fill(`784-1990-${id}7-1`);
      await dialog.locator('button[type="submit"]').click();
      await must(dialog.locator('[role="alert"]').filter({ hasText: 'already on your employee list' }), 'the duplicate message of the API');
      await step(page, flow, '4-duplicate-refused');
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await dialog.waitFor({ state: 'detached' });

      // 3. Edit from the detail page.
      await row.locator('a').first().click();
      await page.waitForURL(/\/employees\/[0-9a-f-]{36}/);
      await must(page.locator('[data-identity] [data-masked]'), 'the masked identity numbers');
      await page.locator('[data-action="edit-employee"]').click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('Job title').fill('Senior Accountant');
      await dialog.locator('button[type="submit"]').click();
      await toast(page, 'Employee saved');
      await must(page.locator('main').getByText('Senior Accountant'), 'the new job title on the page');
      await settle(page);
      await step(page, flow, '5-detail-edited');

      // 4. Import a list: a wrong row is marked, nothing is saved until every row is correct.
      await go(page, '/employees');
      await page.locator('[data-action="import-employees"]').click();
      dialog = page.getByRole('dialog');
      const good = [`Import Demo One ${id}\tFDL-I1${id}\tDriver\t0551230001\timport.one.${id}@example.test\tIN\tN${id}1\t`, `Import Demo Two ${id}\tFDL-I2${id}\tHelper\t\t\tPK\t\t`];
      await dialog.locator('textarea').fill([...good, `Import Demo Bad ${id}\tFDL-I3${id}\tClerk\t\tnot-an-email\tINDIA\t\t`].join('\n'));
      await must(dialog.locator('table tbody tr').nth(2), 'the preview of three rows');
      await must(dialog.getByText(/1 needs? correcting/), 'the count of rows to correct');
      if (await dialog.locator('[data-action="import-submit"]:not([disabled])').count()) throw new Error('the import can be sent although a row is wrong');
      await step(page, flow, '6-import-invalid-row');
      await dialog.locator('textarea').fill([...good, `${name}\t\t\t\t\t\t\t784-1990-${id}7-1`].join('\n'));
      await must(dialog.locator('[data-action="import-submit"]:not([disabled])'), 'the import button once every row is correct');
      await step(page, flow, '7-import-ready');
      await dialog.locator('[data-action="import-submit"]').click();
      await must(dialog.locator('[data-import-created="2"]'), 'two employees created');
      await must(dialog.locator('[data-import-skipped="1"]'), 'the person already on the list skipped');
      await step(page, flow, '8-import-result');
      await dialog.getByRole('button', { name: 'Done' }).click();
      await findEmployee(page, `Import Demo One ${id}`);

      // 5. Deactivate (someone left the company) and reactivate.
      row = await findEmployee(page, `Import Demo Two ${id}`);
      await rowAction(page, row, 'Deactivate employee');
      await must(page.getByRole('alertdialog'), 'the confirmation');
      await step(page, flow, '9-deactivate-confirm');
      await page.getByRole('alertdialog').getByRole('button', { name: 'Deactivate employee' }).click();
      await toast(page, 'Employee deactivated');
      await page.locator(RECORD).filter({ hasText: `Import Demo Two ${id}` }).first().waitFor({ state: 'detached', timeout: 30_000 });
      await choose(page, page.locator('main button').filter({ hasText: /^Show/ }).first(), 'Inactive employees');
      row = await findEmployee(page, `Import Demo Two ${id}`);
      await must(row.getByText('Inactive'), 'the inactive mark');
      await step(page, flow, '10-inactive');
      await rowAction(page, row, 'Reactivate employee');
      await toast(page, 'Employee reactivated');
      saveState({ addedEmployee: name });
    },
  },
  {
    // The portal login of an employee, through the real screens: invite from the directory (a refused address
    // first), send the invitation again, accept it as the employee in a separate browser, and see what the
    // employee sees. Then an invitation that is withdrawn, and an access that is removed.
    // Every stage starts from the state the login really has, so the flow can be repeated.
    name: 'flow-employee-login',
    path: '/employees',
    ...as(ADMIN),
    ready: ROW,
    variants: EN,
    act: async (page) => {
      const flow = 'flow-employee-login';
      const loginStatus = async (name) => (await findEmployee(page, name)).locator('[data-login-status]').getAttribute('data-login-status');
      const linkIn = async (dialog) => {
        await must(dialog.locator('[data-invitation-link]'), 'the invitation link (development servers send no email)');
        return dialog.locator('[data-invitation-link]').getAttribute('href');
      };

      // 1. Invite: an address that already signs in here for another role is refused on the field.
      let link = null;
      let status = await loginStatus(EMPLOYEE_NAME);
      if (status === 'NONE' || status === 'SUSPENDED') {
        await rowAction(page, await findEmployee(page, EMPLOYEE_NAME), 'Invite to the portal');
        const dialog = page.getByRole('dialog');
        await dialog.locator('input[type="email"]').fill(ADMIN);
        await dialog.locator('button[type="submit"]').click();
        await must(dialog.locator('[role="alert"]').filter({ hasText: 'already signs in' }), 'the message for an address that is in use');
        await step(page, flow, '1-invite-address-in-use');
        await dialog.locator('input[type="email"]').fill(EMPLOYEE);
        await dialog.locator('button[type="submit"]').click();
        await toast(page, 'Invitation sent');
        link = await linkIn(dialog);
        await step(page, flow, '2-invitation-sent');
        await dialog.getByRole('button', { name: 'Done' }).click();
        status = await loginStatus(EMPLOYEE_NAME);
        if (status !== 'INVITED') throw new Error(`after the invitation the directory shows ${status}`);
        await step(page, flow, '3-directory-invited');
      }

      // 2. Send it again: the earlier link stops working, the new one is used below.
      if (status === 'INVITED') {
        const earlier = link;
        await rowAction(page, await findEmployee(page, EMPLOYEE_NAME), 'Send the invitation again');
        await toast(page, 'Invitation sent again');
        const dialog = page.getByRole('dialog');
        link = await linkIn(dialog);
        await step(page, flow, '4-invitation-resent');
        await dialog.getByRole('button', { name: 'Done' }).click();

        // 3. The employee opens the link in their own browser, chooses a password and is signed in.
        const theirs = await visitor(page);
        if (earlier && earlier !== link) {
          await theirs.goto(`${origin(page)}${earlier}`, { waitUntil: 'domcontentloaded' });
          await must(theirs.getByText(/no longer valid|not valid|expired/i), 'the earlier invitation link refused');
        }
        await theirs.goto(`${origin(page)}${link}`, { waitUntil: 'domcontentloaded' });
        await must(theirs.locator('input[type="password"]'), 'the "choose a password" form of the invitation');
        await must(theirs.getByText(EMPLOYEE), 'the address the invitation was sent to');
        await theirs.locator('input[type="password"]').fill('short');
        await theirs.locator('button[type="submit"]').click();
        await must(theirs.locator('[role="alert"]'), 'the password rule');
        await theirs.screenshot({ path: resolve(OUT, `corporate-${flow}-5-accept-invitation.png`), animations: 'disabled' });
        await theirs.locator('input[type="password"]').fill(PASSWORD);
        await theirs.locator('button[type="submit"]').click();
        await theirs.waitForURL(/\/overview/, { timeout: 60_000 });
        await must(theirs.locator('main [data-employee-overview]'), 'the overview of an employee');
        await settle(theirs);
        await theirs.screenshot({ path: resolve(OUT, `corporate-${flow}-6-employee-signed-in.png`), fullPage: true, animations: 'disabled' });
        await theirs.context().close();
        await go(page, '/employees');
        status = await loginStatus(EMPLOYEE_NAME);
      }
      if (status !== 'ACTIVE') throw new Error(`the login of ${EMPLOYEE_NAME} is ${status}, expected ACTIVE`);
      await step(page, flow, '7-directory-active');

      // 4. What the employee can and cannot open, signed in on the real sign-in screen.
      const theirs = await visitor(page);
      await signInAs(theirs, EMPLOYEE);
      await must(theirs.locator('main [data-employee-overview]'), 'the overview of an employee');
      for (const path of ['/employees', '/invoices', '/approvals', '/company']) {
        await theirs.goto(`${origin(page)}${path}`, { waitUntil: 'domcontentloaded' });
        await must(theirs.locator('main [data-no-access]'), `no access to ${path} for an employee`);
      }
      await theirs.screenshot({ path: resolve(OUT, `corporate-${flow}-8-employee-no-company-screens.png`), animations: 'disabled' });
      await theirs.goto(`${origin(page)}/requests`, { waitUntil: 'domcontentloaded' });
      await must(theirs.locator(RECORD).filter({ hasText: 'AN-000042' }), 'the own request of the employee');
      if (await theirs.locator(RECORD).filter({ hasText: 'AN-000053' }).count()) throw new Error('an employee sees a request of a colleague');
      await theirs.screenshot({ path: resolve(OUT, `corporate-${flow}-9-employee-own-requests.png`), animations: 'disabled' });
      // A colleague's request by its address: the API refuses it and the screen says "not found", nothing else.
      const api = await staff();
      const others = await api('GET', '/requests?q=AN-000053');
      const foreign = others.data.find((r) => r.requestNo === 'AN-000053');
      await theirs.goto(`${origin(page)}/requests/${foreign.id}`, { waitUntil: 'domcontentloaded' });
      await must(theirs.getByText('We could not find this request'), 'the not-found state for a request of a colleague');
      if (await theirs.getByText('Mohan Lal Shrestha').count()) throw new Error('the name of a colleague is shown to an employee');
      await theirs.screenshot({ path: resolve(OUT, `corporate-${flow}-10-employee-foreign-request.png`), animations: 'disabled' });
      await theirs.context().close();

      // 5. An invitation that is withdrawn: its link stops working.
      if ((await loginStatus('Chandani Silva')) === 'NONE') {
        await rowAction(page, await findEmployee(page, 'Chandani Silva'), 'Invite to the portal');
        const dialog = page.getByRole('dialog');
        await dialog.locator('button[type="submit"]').click();
        const withdrawn = await linkIn(dialog);
        await dialog.getByRole('button', { name: 'Done' }).click();
        await rowAction(page, await findEmployee(page, 'Chandani Silva'), 'Withdraw invitation');
        await must(page.getByRole('alertdialog'), 'the confirmation');
        await step(page, flow, '11-withdraw-confirm');
        await page.getByRole('alertdialog').getByRole('button', { name: 'Withdraw invitation' }).click();
        await toast(page, 'Invitation withdrawn');
        if ((await loginStatus('Chandani Silva')) !== 'NONE') throw new Error('the withdrawn invitation still shows in the directory');
        const anyone = await visitor(page);
        await anyone.goto(`${origin(page)}${withdrawn}`, { waitUntil: 'domcontentloaded' });
        await must(anyone.getByText(/no longer valid|not valid|expired/i), 'the withdrawn invitation link refused');
        await anyone.context().close();
      }

      // 6. Remove the access of an employee who can sign in: from the detail page, and the sign-in really stops.
      if ((await loginStatus('Mohan Lal Shrestha')) === 'ACTIVE') {
        await (await findEmployee(page, 'Mohan Lal Shrestha')).locator('a').first().click();
        await page.waitForURL(/\/employees\/[0-9a-f-]{36}/);
        await must(page.locator('[data-login-card="ACTIVE"]'), 'the portal access card');
        await page.locator('[data-action="revoke-login"]').click();
        await must(page.getByRole('alertdialog'), 'the confirmation');
        await step(page, flow, '12-revoke-confirm');
        await page.getByRole('alertdialog').getByRole('button', { name: 'Remove portal access' }).click();
        await toast(page, 'Portal access removed');
        await must(page.locator('[data-login-card="NONE"]'), 'the card without access');
        await settle(page);
        await step(page, flow, '13-access-removed');
        const former = await visitor(page);
        await former.goto(`${origin(page)}${SIGN_IN}`, { waitUntil: 'domcontentloaded' });
        await former.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 90_000 });
        await former.locator('input[type="email"]').fill('mohan.lal.shrestha@example.test');
        await former.locator('input[type="password"]').fill(PASSWORD);
        await former.locator('button[type="submit"]').click();
        await must(former.locator('form [role="alert"]'), 'the refused sign-in of the removed login');
        if (!/sign-in/.test(former.url())) throw new Error('an employee whose access was removed could still sign in');
        await former.screenshot({ path: resolve(OUT, `corporate-${flow}-14-removed-cannot-sign-in.png`), animations: 'disabled' });
        await former.context().close();
        await go(page, '/employees');
      }
    },
  },
  {
    // A request for one employee, from "who is it for" to the tracking code: the contract price of the company,
    // the form of the service prefilled from the employee's record, a refused and two accepted uploads, the
    // review and the submission. Then the same service for a second employee, reusing documents already on file.
    name: 'flow-new-request',
    path: '/requests',
    ...as(ADMIN),
    ready: ROW,
    variants: EN,
    act: async (page) => {
      const flow = 'flow-new-request';
      const SERVICE = 'Emirates ID application typing (document preparation)';

      // 1. Who is it for: nothing chosen is said on the field; then one employee of the directory.
      await page.getByRole('link', { name: 'New request' }).first().click();
      await page.waitForURL(/\/requests\/new/);
      await must(page.locator('[data-action="who-continue"]'), 'the "who is it for" step');
      await page.locator('[data-action="who-continue"]').click();
      await must(page.locator('main [role="alert"]').filter({ hasText: 'Choose the employee' }), 'the message that an employee must be chosen');
      await step(page, flow, '1-who-validation');
      await pick(page, page.locator('main [role="combobox"]').first(), 'Chandani Silva');
      await page.locator('[data-action="who-continue"]').click();
      await page.waitForURL(/employee=[0-9a-f-]{36}/);

      // 2. The service: the company's contract price is marked in the list and in the estimate.
      await must(page.locator('main [data-service]'), 'the services');
      await must(page.locator('[data-request-for]').filter({ hasText: 'Chandani Silva' }), 'the person the request is for');
      await page.locator('main input[type="search"], main input[placeholder^="Search"]').first().fill('Emirates ID');
      await must(page.locator('main [data-service]:has([data-contract-price])').filter({ hasText: SERVICE }), 'the service with its contract price mark');
      await step(page, flow, '2-services');
      await page.locator('main [data-service]').filter({ hasText: SERVICE }).first().click();
      await must(page.locator('[data-fee-source="CORPORATE_CONTRACT"]'), 'the contract price in the estimate');
      await settle(page);
      await step(page, flow, '3-service-summary');
      await page.locator('[data-action="start-request"]').click();
      await page.waitForURL(/draft=[0-9a-f-]{36}.*step=details|step=details.*draft=/);

      // 3. Details: prefilled from the employee's record; a missing answer does not continue.
      await must(page.getByLabel('Full name (as in passport)'), 'the form of the service');
      if ((await page.getByLabel('Full name (as in passport)').inputValue()) !== 'Chandani Silva') throw new Error('the name was not prefilled from the employee record');
      await page.getByRole('button', { name: 'Continue' }).click();
      await must(page.locator('main [role="alert"]').filter({ hasText: 'This field is required' }), 'required-field messages');
      await step(page, flow, '4-details-validation');
      await choose(page, page.getByLabel('Application type'), 'Renewal');
      await must(page.getByLabel('Current Emirates ID expiry date'), 'the field that only shows for a renewal');
      await page.getByLabel(/Anything else the centre should know/).fill('Needed before the labour inspection on the 20th. (flow test)');
      // The draft saves itself; a reload shows what was entered.
      await must(page.locator('[data-save-state="saved"]'), 'the "Saved at" note of the automatic save', 20_000);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await must(page.getByLabel('Full name (as in passport)'), 'the form after a reload');
      await must(page.getByLabel('Current Emirates ID expiry date'), 'the renewal field after a reload');
      await settle(page);
      await step(page, flow, '5-details-filled');
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.waitForURL(/step=documents/);

      // 4. Documents: a file whose content is not what it claims is refused by the API; real ones are accepted.
      const lines = page.locator('main li[data-checklist-status]');
      await must(lines.first(), 'the document checklist');
      await must(page.locator('[data-missing-documents="2"]'), 'the note about 2 missing documents');
      await uploadTo(lines.nth(0), { name: 'renamed-text.pdf', mimeType: 'application/pdf', buffer: Buffer.from('this is plain text, not a PDF') });
      await must(lines.nth(0).locator('[role="alert"]'), 'the API error for a file that is not a real PDF');
      await step(page, flow, '6-upload-refused');
      await lines.nth(0).getByRole('button', { name: /^Remove/ }).click();
      await lines.nth(0).locator('input[type="file"]').first().setInputFiles({ name: 'passport-sample.pdf', mimeType: 'application/pdf', buffer: pdf('SAMPLE passport (not a real document)') });
      await must(page.locator('main li[data-checklist-status="UPLOADED"], main li[data-checklist-status="VERIFIED"]').first(), 'the first document as uploaded', 60_000);
      await uploadTo(lines.nth(1), { name: 'photo-sample.png', mimeType: 'image/png', buffer: PNG });
      await must(page.locator('main li[data-checklist-status="UPLOADED"]').nth(1), 'the second document as uploaded', 60_000);
      await page.locator('[data-missing-documents]').waitFor({ state: 'detached', timeout: 30_000 });
      await settle(page);
      await step(page, flow, '7-documents');
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.waitForURL(/step=review/);

      // 5. Review and submit.
      await must(page.getByRole('button', { name: 'Submit request' }), 'the submit button');
      await must(page.locator('main').getByText('Renewal'), 'the answers on the review step');
      await settle(page);
      await step(page, flow, '8-review');
      await page.getByRole('button', { name: 'Submit request' }).click();
      await must(page.getByText('Request submitted'), 'the confirmation', 60_000);
      const requestNo = (await page.locator('[data-request-no]').innerText()).trim();
      const trackingCode = (await page.locator('[data-tracking-code]').innerText()).trim();
      if (!/^[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(trackingCode)) throw new Error(`unexpected tracking code "${trackingCode}"`);
      await step(page, flow, '9-submitted');

      // 6. The same service for a second employee: who and service are asked again, documents on file are reused.
      await page.locator('[data-action="same-again"]').click();
      await must(page.locator('[data-action="who-continue"]'), 'the "who is it for" step of the next request');
      await pick(page, page.locator('main [role="combobox"]').first(), 'Faisal Anwar');
      await page.locator('[data-action="who-continue"]').click();
      await must(page.locator('[data-action="start-request"]'), 'the same service, already chosen');
      await must(page.locator('main h2, main h1').filter({ hasText: SERVICE }), 'the name of the service');
      await page.locator('[data-action="start-request"]').click();
      await page.waitForURL(/step=details/);
      await must(page.getByLabel('Full name (as in passport)'), 'the form of the service');
      if ((await page.getByLabel('Full name (as in passport)').inputValue()) !== 'Faisal Anwar') throw new Error('the name of the second employee was not prefilled');
      await choose(page, page.getByLabel('Application type'), 'Replacement');
      await page.getByRole('radio', { name: 'Lost' }).click();
      await must(page.locator('[data-save-state="saved"]'), 'the automatic save', 20_000);
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.waitForURL(/step=documents/);
      await must(page.getByRole('button', { name: 'Use this one' }), 'the offer to reuse a document already on file');
      await step(page, flow, '10-second-reuse-offer');
      while (await page.getByRole('button', { name: 'Use this one' }).filter({ visible: true }).count()) {
        const before = await page.getByRole('button', { name: 'Use this one' }).filter({ visible: true }).count();
        await page.getByRole('button', { name: 'Use this one' }).filter({ visible: true }).first().click();
        await page.waitForFunction((n) => [...document.querySelectorAll('main button')].filter((b) => b.textContent?.trim() === 'Use this one' && b.offsetParent).length < n, before, { timeout: 30_000 });
      }
      await page.locator('[data-missing-documents]').waitFor({ state: 'detached', timeout: 30_000 });
      await settle(page);
      await step(page, flow, '11-second-documents-reused');
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.waitForURL(/step=review/);
      await page.getByRole('button', { name: 'Submit request' }).click();
      await must(page.getByText('Request submitted'), 'the confirmation of the second request', 60_000);
      const secondNo = (await page.locator('[data-request-no]').innerText()).trim();

      // 7. Both are in the list, each under its employee; the first one opens with its timeline and a message.
      await go(page, '/requests');
      await must(page.locator(RECORD).filter({ hasText: requestNo }).filter({ hasText: 'Chandani Silva' }), 'the first request under Chandani Silva');
      await must(page.locator(RECORD).filter({ hasText: secondNo }).filter({ hasText: 'Faisal Anwar' }), 'the second request under Faisal Anwar');
      await step(page, flow, '12-requests');
      await openRow(page, requestNo);
      const requestId = page.url().split('/').pop().split('?')[0];
      await must(page.locator('[data-waiting-on="CENTRE"]'), 'the request with the centre');
      await step(page, flow, '13-request');
      await page.getByRole('tab', { name: /Messages/ }).click();
      await page.getByLabel('Your message').fill('Please confirm when the application is typed. (flow test)');
      await page.getByRole('button', { name: 'Send message' }).click();
      await must(page.locator('main ol li').filter({ hasText: 'confirm when the application is typed' }), 'the message in the conversation');
      await settle(page);
      await step(page, flow, '14-message-sent');
      await go(page, '/requests');
      await openRow(page, secondNo);
      saveState({ requestId, requestNo, secondId: page.url().split('/').pop().split('?')[0], secondNo, trackingCode });
    },
  },
  {
    // The centre checks the documents and sends a quotation for each of the two requests of flow-new-request
    // (staff API). The company approves the first one (an invoice on its credit terms is issued) and declines
    // the second one with a reason.
    name: 'flow-approvals',
    path: '/overview',
    ...as(ADMIN),
    ready: 'main h1',
    variants: EN,
    act: async (page) => {
      const flow = 'flow-approvals';
      const { requestId, requestNo, secondId, secondNo } = readState();
      if (!requestId || !secondId) throw new Error('run flow-new-request first');
      const api = await staff();
      for (const id of [requestId, secondId]) {
        const now = await api('GET', `/requests/${id}`);
        if (now.finance?.quotation) continue;
        for (const line of now.checklist.filter((l) => l.document && l.document.verificationStatus !== 'VERIFIED')) await api('POST', `/documents/${line.document.id}/verify`, { decision: 'APPROVED' });
        const quotation = await api('POST', `/quotations/from-request/${id}`, { notes: 'Typing as per your contract price. (flow test)' });
        await api('POST', `/quotations/${quotation.id}/send`);
      }
      const first = await api('GET', `/requests/${requestId}`);
      const second = await api('GET', `/requests/${secondId}`);

      // 1. The overview and the request say that a decision is needed.
      await go(page, '/overview');
      if (first.status === 'QUOTED' || second.status === 'QUOTED') {
        await must(page.locator('[data-approvals-waiting]'), 'the note about quotations waiting for approval');
        await step(page, flow, '1-overview-waiting');
        await page.locator('[data-approvals-waiting] a').first().click();
        await page.waitForURL(/\/approvals/);
        await must(page.locator('[data-quotation]'), 'the quotations waiting for a decision');
        await settle(page);
        await step(page, flow, '2-approvals-waiting');
      }

      // 2. Approve the first one, from the request.
      if (first.status === 'QUOTED') {
        await go(page, `/requests/${requestId}`);
        await must(page.locator('[data-waiting-on="COMPANY"], [data-waiting-on="CUSTOMER"]'), 'the "your company\'s turn" card');
        await must(page.locator('[data-action="review-quotation"]'), 'the link to the quotation');
        await step(page, flow, '3-request-quoted');
        await page.locator('[data-action="review-quotation"]').first().click();
        await page.waitForURL(/\/approvals\/[0-9a-f-]{36}/);
        await must(page.locator('[data-action="approve"]'), 'the approve button');
        await must(page.locator('main').getByText(/contract price/i), 'the contract price on the quotation');
        await settle(page);
        await step(page, flow, '4-quotation');
        const download = page.waitForEvent('download', { timeout: 60_000 });
        await page.getByRole('button', { name: /PDF/ }).click();
        if (!/\.pdf$/.test((await download).suggestedFilename())) throw new Error('the quotation PDF did not download');
        await page.locator('[data-action="approve"]').click();
        await must(page.getByRole('alertdialog'), 'the confirmation of the approval');
        await step(page, flow, '5-approve-confirm');
        await page.getByRole('alertdialog').getByRole('button', { name: 'Approve quotation' }).click();
        await must(page.locator('[data-decision="APPROVED"]'), 'the approved quotation with its invoice', 60_000);
        await mustNot(page, '[data-action="approve"]', 'the approve button after the decision');
        await settle(page);
        await step(page, flow, '6-approved');
        await page.locator('[data-decision="APPROVED"] a').click();
        await page.waitForURL(/\/invoices\/[0-9a-f-]{36}/);
        await must(page.locator('[data-pay-card]'), 'the invoice that was issued');
        saveState({ invoiceId: page.url().split('/').pop().split('?')[0] });
        await settle(page);
        await step(page, flow, '7-invoice-issued');
      }

      // 3. Decline the second one: a reason is required, and the centre sees it.
      if (second.status === 'QUOTED') {
        await go(page, '/approvals');
        await must(page.locator('[data-quotation]').filter({ hasText: secondNo }), 'the quotation of the second request');
        await page.locator('[data-quotation]').filter({ hasText: secondNo }).locator('[data-action="review"]').click();
        await page.waitForURL(/\/approvals\/[0-9a-f-]{36}/);
        await page.locator('[data-action="reject"]').click();
        const dialog = page.getByRole('dialog');
        await dialog.locator('button[type="submit"]').click();
        await must(dialog.locator('[role="alert"]'), 'the message that a reason is required');
        await step(page, flow, '8-decline-validation');
        await dialog.locator('textarea').fill('The replacement fee should follow our contract. Please check. (flow test)');
        await dialog.locator('button[type="submit"]').click();
        await must(page.locator('[data-decision="REJECTED"]').filter({ hasText: 'follow our contract' }), 'the declined quotation with the reason', 60_000);
        await settle(page);
        await step(page, flow, '9-declined');
        const after = await api('GET', `/requests/${secondId}`);
        if (after.finance?.quotation?.status !== 'REJECTED') throw new Error(`the centre sees the quotation as ${after.finance?.quotation?.status}, not REJECTED`);
      }

      // 4. Nothing is left to decide; the history has both decisions.
      await go(page, '/approvals');
      await mustNot(page, `[data-quotation]:has-text("${requestNo}"), [data-quotation]:has-text("${secondNo}")`, 'a decided quotation among the waiting ones');
      await go(page, '/approvals?tab=history');
      await must(page.locator(RECORD).filter({ hasText: requestNo }), 'the approved quotation in the history');
      await must(page.locator(RECORD).filter({ hasText: secondNo }), 'the declined quotation in the history');
      await step(page, flow, '10-history');
      await go(page, `/requests/${requestId}`);
      await must(page.locator('[data-money-card] [data-approval-state="APPROVED"]'), 'the approval on the request');
      await step(page, flow, '11-request-after-approval');
    },
  },
  {
    // Pay an invoice online with the test payment provider: a declined try first, then a successful one.
    // The statement goes down by the amount, the receipt downloads, a forged return address shows nothing as paid.
    name: 'flow-pay',
    path: '/invoices',
    ...as(ADMIN),
    ready: 'main [data-statement]',
    variants: EN,
    act: async (page) => {
      const flow = 'flow-pay';
      const { invoiceId } = readState();
      if (!invoiceId) throw new Error('run flow-approvals first: it issues the invoice that is paid here');
      const api = await staff();
      const invoice = await api('GET', `/invoices/${invoiceId}`);
      const before = Number(await page.locator('[data-open-balance]').first().getAttribute('data-open-balance'));
      await settle(page);
      await step(page, flow, '1-statement-before');

      if (invoice.status !== 'PAID') {
        // 1. From the list of open invoices: "Pay" opens the checkout of the provider.
        const line = page.locator(`[data-invoice="${invoice.invoiceNo}"]`);
        await must(line, `invoice ${invoice.invoiceNo} among the open invoices`);
        await line.getByRole('button', { name: 'Pay' }).click();
        await must(page.locator('[data-test-pay="fail"]'), 'the test checkout');
        await settle(page);
        await step(page, flow, '2-test-checkout');
        await page.locator('[data-test-pay="fail"]').click();
        await page.waitForURL(/payments\/return/, { timeout: 60_000 });
        await must(page.locator('[data-payment-state="failed"]'), 'the declined payment, read from the API', 60_000);
        await step(page, flow, '3-payment-declined');
        await page.getByRole('link', { name: 'Try again' }).click();
        await page.waitForURL(/\/invoices\/[0-9a-f-]{36}/);

        // 2. From the invoice itself: this time it goes through.
        await must(page.locator('[data-pay-card]').getByRole('button', { name: 'Pay online' }), 'the invoice, still to pay after the declined try');
        await page.locator('[data-pay-card]').getByRole('button', { name: 'Pay online' }).click();
        await page.locator('[data-test-pay="complete"]').click();
        await page.waitForURL(/payments\/return/, { timeout: 60_000 });
        await must(page.locator('[data-payment-state="paid"]'), 'the confirmed payment, read from the API', 60_000);
        await settle(page);
        await step(page, flow, '4-payment-received');
        const receipt = page.waitForEvent('download', { timeout: 60_000 });
        await page.getByRole('button', { name: 'Download receipt' }).click();
        if (!/\.pdf$/.test((await receipt).suggestedFilename())) throw new Error('the receipt PDF did not download');
        // A forged address must not turn anything into "paid": the page reads the payment, not the query string.
        await go(page, `/payments/return?invoice=${invoiceId}&payment=00000000-0000-4000-8000-000000000000&result=success`);
        if (await page.locator('[data-payment-state="paid"]').count()) throw new Error('a forged return address was shown as paid');
        await step(page, flow, '5-forged-return');
      }

      // 3. The invoice is paid for the company and for the centre, and the statement went down by its amount.
      await go(page, `/invoices/${invoiceId}`);
      await must(page.locator('[data-balance="0.00"]'), 'a balance of 0.00 on the invoice');
      await mustNot(page, '[data-pay-card]', 'a pay button on a paid invoice');
      await settle(page);
      await step(page, flow, '6-invoice-paid');
      const paid = await api('GET', `/invoices/${invoiceId}`);
      if (paid.status !== 'PAID') throw new Error(`the centre sees the invoice as ${paid.status}, not PAID`);
      await go(page, '/invoices');
      await must(page.locator('[data-statement]'), 'the statement');
      const after = Number(await page.locator('[data-open-balance]').first().getAttribute('data-open-balance'));
      if (invoice.status !== 'PAID' && Math.abs(before - after - Number(invoice.total)) > 0.005) throw new Error(`the open balance went from ${before} to ${after}, expected ${invoice.total} less`);
      await mustNot(page, `[data-invoice="${invoice.invoiceNo}"]`, 'the paid invoice among the open ones');
      await step(page, flow, '7-statement-after');
      await go(page, '/invoices?tab=all');
      await must(page.locator(RECORD).filter({ hasText: invoice.invoiceNo }).filter({ hasText: 'Paid' }), 'the invoice as paid in the list of all invoices');
      await step(page, flow, '8-all-invoices');
    },
  },
  {
    // A question about a request, with a file; the centre answers (staff API); the company replies; the centre
    // resolves it. A colleague with an employee login does not see this conversation.
    name: 'flow-support',
    path: '/requests',
    ...as(ADMIN),
    ready: ROW,
    variants: EN,
    act: async (page) => {
      const flow = 'flow-support';
      const { requestId, requestNo } = readState();
      if (!requestId) throw new Error('run flow-new-request first');
      const subject = `Collection of the typed application ${stamp()}`;
      await go(page, `/requests/${requestId}`);
      await page.getByRole('link', { name: 'Ask about this request' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      await dialog.locator('button[type="submit"]').click();
      await must(dialog.locator('[role="alert"]').filter({ hasText: 'This field is required' }), 'required-field messages');
      await step(page, flow, '1-ask-validation');
      await dialog.getByLabel('Subject').fill(subject);
      await dialog.getByLabel('Your question').fill('Can our PRO collect the typed application tomorrow morning? (flow test)');
      await dialog.locator('input[type="file"]').first().setInputFiles({ name: 'authorisation-letter-sample.pdf', mimeType: 'application/pdf', buffer: pdf('SAMPLE authorisation letter (not a real document)') });
      await must(dialog.getByText('authorisation-letter-sample.pdf'), 'the attached file');
      await must(dialog.locator('button[type="submit"]:not([disabled])'), 'the send button once the file is uploaded', 60_000);
      await must(dialog.getByText(requestNo), 'the request the question is about');
      await step(page, flow, '2-ask-filled');
      await dialog.locator('button[type="submit"]').click();
      await page.waitForURL(/\/support\/[0-9a-f-]{36}/, { timeout: 60_000 });
      const ticketId = page.url().split('/').pop().split('?')[0];
      await must(page.locator('main').getByText('collect the typed application tomorrow'), 'the question in the conversation');
      await must(page.locator('main').getByText('authorisation-letter-sample.pdf'), 'the attachment in the conversation');
      await settle(page);
      await step(page, flow, '3-question-sent');

      // The centre answers and waits for a reply.
      const api = await staff();
      await api('POST', `/support/tickets/${ticketId}/messages`, { body: 'Yes. Please bring the original Emirates ID and this letter. Who will come? (flow test)', visibility: 'CUSTOMER', status: 'WAITING_CUSTOMER' });
      await api('POST', `/support/tickets/${ticketId}/messages`, { body: 'Internal note that the company must never see. (flow test)', visibility: 'INTERNAL' });
      await go(page, '/support');
      await must(page.locator(RECORD).filter({ hasText: subject }), 'the question in the list');
      await step(page, flow, '4-list-waiting-for-reply');
      await openRow(page, subject);
      await must(page.locator('main').getByText('Who will come?'), 'the answer of the centre');
      if (await page.locator('main').getByText('Internal note').count()) throw new Error('an internal note of the centre is shown to the company');
      await must(page.locator('main').getByText('Waiting for your reply'), 'the note that the centre waits for a reply');
      await step(page, flow, '5-answer');
      await page.getByLabel('Your reply').fill('Our PRO, Mr Rashid, at 9 am. Thank you. (flow test)');
      await page.getByRole('button', { name: 'Send reply' }).click();
      await toast(page, 'Reply sent');
      await must(page.locator('main').getByText('Mr Rashid, at 9 am'), 'the reply in the conversation');
      await api('POST', `/support/tickets/${ticketId}/status`, { status: 'RESOLVED', resolutionSummary: 'Collection agreed for tomorrow 9 am. (flow test)' });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await must(page.locator('main').getByText('The centre marked this as resolved'), 'the resolved conversation');
      // Ratings need a customer record, which a company administrator does not have: no rating form here.
      await mustNot(page, 'main button:has-text("Send rating")', 'a rating form for a company administrator');
      await settle(page);
      await step(page, flow, '6-resolved');

      // A colleague's conversation is not shown to an employee, not in the list and not by its address.
      const theirs = await visitor(page);
      await signInAs(theirs, EMPLOYEE);
      await theirs.goto(`${origin(page)}/support`, { waitUntil: 'domcontentloaded' });
      await theirs.locator('main h1').waitFor();
      await settle(theirs);
      if (await theirs.getByText(subject).count()) throw new Error('an employee sees a conversation opened by the administrator');
      await theirs.goto(`${origin(page)}/support/${ticketId}`, { waitUntil: 'domcontentloaded' });
      await must(theirs.getByText('We could not find this conversation'), 'the not-found state for a conversation of a colleague');
      await theirs.screenshot({ path: resolve(OUT, `corporate-${flow}-7-employee-cannot-open.png`), animations: 'disabled' });
      await theirs.context().close();
    },
  },
  {
    // The inbox: unread only, everything marked as read, one message opened; a channel switched off and on again.
    // As the employee of flow-employee-own: request and support events notify the person the request is for,
    // company administrators only get expiry reminders (see the notification rules of the API).
    name: 'flow-notifications',
    path: '/notifications',
    ...as(EMPLOYEE),
    ready: 'main [role="tabpanel"] ul li:visible',
    variants: EN,
    act: async (page) => {
      const flow = 'flow-notifications';
      const unread = page.locator('main [data-notification][data-unread="true"]');
      const count = await unread.count();
      if (!count) throw new Error('there is no unread notification to work with: run flow-employee-own first (its request and the answered question notify the employee)');
      await step(page, flow, '1-inbox');
      if (count > 0) {
        await page.getByRole('switch', { name: 'Show unread only' }).click();
        await settle(page);
        if ((await page.locator('main [data-notification]').count()) !== (await unread.count())) throw new Error('"unread only" still lists read notifications');
        await step(page, flow, '2-unread-only');
        await page.locator('[data-action="mark-all-read"]').click();
        await toast(page, 'All notifications marked as read');
        await must(page.getByText('You have read everything'), 'the empty state of "unread only"');
        await step(page, flow, '3-all-read');
        await page.getByRole('switch', { name: 'Show unread only' }).click();
        await must(page.locator('main [data-notification]'), 'the read notifications, still listed');
        if (await unread.count()) throw new Error('a notification is still unread after "Mark all as read"');
      }
      // The link of a notification leads to a screen of this portal.
      const first = page.locator('main [data-notification] button').first();
      if (await first.count()) {
        await first.click();
        await page.waitForURL((url) => !/\/notifications/.test(url.pathname), { timeout: 30_000 });
        await page.locator('main h1').first().waitFor();
        await settle(page);
        await step(page, flow, '4-opened-from-notification');
      }

      // Preferences: switch text messages off, reload, switch them on again.
      await go(page, '/notifications?tab=settings');
      const sms = page.getByRole('switch', { name: /Text message/ });
      await must(sms, 'the SMS switch');
      const was = await sms.getAttribute('aria-checked');
      await sms.click();
      await toast(page, was === 'true' ? 'switched off' : 'switched on');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await must(page.getByRole('switch', { name: /Text message/ }), 'the SMS switch after a reload');
      await settle(page);
      if ((await page.getByRole('switch', { name: /Text message/ }).getAttribute('aria-checked')) === was) throw new Error('the changed preference was not kept');
      await step(page, flow, '5-preference-changed');
      await page.getByRole('switch', { name: /Text message/ }).click();
      await toast(page, was === 'true' ? 'switched on' : 'switched off');
    },
  },
  {
    // The company profile: invite a colleague as a second administrator (field errors, the "already a user"
    // answer of the API), the colleague accepts and sees the whole company. The centre then removes the
    // colleague again (staff API: the portal has no endpoint for that), so the demo company stays as it was.
    name: 'flow-company',
    path: '/company',
    ...as(ADMIN),
    ready: 'main [data-company-users] [data-member]',
    variants: EN,
    act: async (page) => {
      const flow = 'flow-company';
      const id = stamp();
      const email = `pro.demo.${id}@falcon-demo.test`;
      await page.locator('[data-action="invite-colleague"]').click();
      const dialog = page.getByRole('dialog');
      await dialog.locator('button[type="submit"]').click();
      await must(dialog.locator('[role="alert"]').filter({ hasText: 'This field is required' }), 'required-field messages');
      await step(page, flow, '1-invite-validation');
      await dialog.getByLabel('Full name').fill(`Rashid Demo PRO ${id}`);
      await dialog.locator('input[type="email"]').fill(ADMIN);
      await dialog.locator('button[type="submit"]').click();
      await must(dialog.locator('[role="alert"]').filter({ hasText: 'already a portal user' }), 'the answer for somebody who is already a portal user');
      await step(page, flow, '2-already-a-user');
      await dialog.locator('input[type="email"]').fill(email);
      await dialog.locator('button[type="submit"]').click();
      await toast(page, 'Invitation sent');
      await must(page.locator('[data-invitation-link]'), 'the invitation link (development servers send no email)');
      const link = await page.locator('[data-invitation-link]').getAttribute('href');
      await step(page, flow, '3-invited');
      await page.getByRole('dialog').getByRole('button', { name: 'Done' }).click();
      await must(page.locator(`[data-member="${email}"]`).getByText('Invited'), 'the invited colleague in the list');

      const theirs = await visitor(page);
      await theirs.goto(`${origin(page)}${link}`, { waitUntil: 'domcontentloaded' });
      await must(theirs.locator('input[type="password"]'), 'the "choose a password" form of the invitation');
      await theirs.locator('input[type="password"]').fill(PASSWORD);
      await theirs.locator('button[type="submit"]').click();
      await theirs.waitForURL(/\/overview/, { timeout: 60_000 });
      await must(theirs.locator('main [data-expiring-soon]'), 'the company overview for the new administrator');
      await theirs.goto(`${origin(page)}/employees`, { waitUntil: 'domcontentloaded' });
      await must(theirs.locator(RECORD).filter({ hasText: 'Ramon Dela Cruz' }), 'the employee directory for the new administrator');
      await theirs.screenshot({ path: resolve(OUT, `corporate-${flow}-4-colleague-signed-in.png`), animations: 'disabled' });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await must(page.locator(`[data-member="${email}"]`).getByText('Active'), 'the colleague as active after accepting');
      await settle(page);
      await step(page, flow, '5-colleague-active');

      // The centre removes the colleague: the list shows it and the colleague is signed out.
      const api = await staff();
      const accounts = await api('GET', '/corporate-accounts?q=Falcon');
      const account = accounts.data.find((a) => /Falcon Demo Logistics/.test(a.name ?? a.companyName ?? ''));
      const members = await api('GET', `/corporate-accounts/${account.id}/members`);
      const member = (members.data ?? members).find((m) => m.email === email);
      await api('DELETE', `/corporate-accounts/${account.id}/members/${member.id}`);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await must(page.locator('main [data-company-users] [data-member]'), 'the portal users');
      await settle(page);
      if (await page.locator(`[data-member="${email}"]`).count()) throw new Error('the removed colleague is still listed');
      await theirs.goto(`${origin(page)}/employees`, { waitUntil: 'domcontentloaded' });
      await theirs.waitForURL(/sign-in/, { timeout: 60_000 });
      await theirs.context().close();
    },
  },
  {
    // From an expiry reminder to a renewal request: the reminder proposes the employee, the draft is saved for
    // later, found again among the drafts and discarded. Then a submitted request is cancelled with a reason.
    name: 'flow-renewal',
    path: '/reminders',
    ...as(ADMIN),
    ready: 'main [data-reminder]',
    variants: EN,
    act: async (page) => {
      const flow = 'flow-renewal';
      // 1. Filter the list, then start the renewal of one residence visa.
      await page.locator('main input[type="search"], main input[placeholder^="Search"]').first().fill('Ramon');
      await settle(page);
      if (await page.locator('main [data-reminder]').filter({ hasText: 'Suresh Babu' }).count()) throw new Error('the search still shows reminders of somebody else');
      await choose(page, page.locator('main button').filter({ hasText: /^Expiry/ }).first(), 'Within 30 days');
      await settle(page);
      const reminder = page.locator('main [data-reminder]').filter({ hasText: 'Residence Visa' }).first();
      await must(reminder, 'the residence visa of Ramon Dela Cruz that expires soon');
      await step(page, flow, '1-reminders-filtered');
      await reminder.locator('[data-action="renew"]').click();
      await page.waitForURL(/\/requests\/new\?.*renewalOf=/);
      await must(page.locator('[data-renewal]'), 'the note that this request is a renewal');
      // The reminder names its subject in words; the employee with that name is proposed, the administrator confirms.
      await must(page.locator('main [role="combobox"]').filter({ hasText: 'Ramon Dela Cruz' }), 'the employee proposed from the reminder');
      await step(page, flow, '2-renewal-who');
      await page.locator('[data-action="who-continue"]').click();
      await must(page.locator('main [data-service]'), 'the services');
      await page.locator('main [data-service]').filter({ hasText: 'Residence renewal typing' }).first().click();
      await must(page.locator('[data-action="start-request"]'), 'the summary of the service');
      await must(page.locator('[data-renewal]'), 'the renewal note on the summary');
      await settle(page);
      await step(page, flow, '3-renewal-service');
      await page.locator('[data-action="start-request"]').click();
      await page.waitForURL(/step=details/);
      const draftNo = ((await page.locator('main').getByText(/Draft AN-\d+/).first().innerText()).match(/AN-\d+/) ?? [])[0];
      if (!draftNo) throw new Error('the draft number is not shown');
      await settle(page);
      await step(page, flow, '4-renewal-draft');

      // 2. Save for later; the draft is in the list and continues where it stopped; then it is discarded.
      await page.getByRole('button', { name: 'Save and finish later' }).click();
      await page.waitForURL(/\/requests(\?|$)/);
      await choose(page, page.locator('main button').filter({ hasText: /^Show/ }).first(), 'Drafts, not submitted');
      await must(page.locator(RECORD).filter({ hasText: draftNo }), 'the draft in the list');
      await step(page, flow, '5-drafts');
      await page.locator(RECORD).filter({ hasText: draftNo }).first().locator('a').first().click();
      await page.waitForURL(/\/requests\/new\?.*draft=/);
      await must(page.getByRole('button', { name: 'Discard this draft' }), 'the draft, open again');
      await page.getByRole('button', { name: 'Discard this draft' }).click();
      await must(page.getByRole('alertdialog'), 'the confirmation');
      await step(page, flow, '6-discard-confirm');
      await page.getByRole('alertdialog').getByRole('button', { name: 'Discard this draft' }).click();
      await toast(page, 'discarded');
      await page.waitForURL(/\/requests(\?|$)/);

      // 3. Cancel a request the centre has not started yet: a reason is required and the centre sees it.
      const { cancelNo } = readState();
      if (cancelNo) {
        await go(page, '/requests');
        await page.locator('main input[type="search"], main input[placeholder^="Search"]').first().fill(cancelNo);
        await must(page.locator(RECORD).filter({ hasText: cancelNo }), `request ${cancelNo}`);
        await settle(page);
        await openRow(page, cancelNo);
        if (await page.getByRole('button', { name: 'Cancel request' }).count()) {
          await page.getByRole('button', { name: 'Cancel request' }).click();
          const dialog = page.getByRole('dialog');
          await dialog.locator('button[type="submit"]').click();
          await must(dialog.locator('[role="alert"]'), 'the message that a reason is required');
          await step(page, flow, '7-cancel-validation');
          await dialog.locator('textarea').fill('Entered twice by mistake. (flow test)');
          await dialog.locator('button[type="submit"]').click();
          await toast(page, 'cancelled');
          await must(page.locator('main header, main').getByText('Cancelled').first(), 'the cancelled status');
          await settle(page);
          await step(page, flow, '8-cancelled');
        }
      }
    },
  },
  {
    // The company's own documents: upload the trade licence with its expiry date, view it, download it.
    name: 'flow-documents',
    path: '/documents',
    ...as(ADMIN),
    ready: 'main table tbody tr:visible, main ul li:visible',
    variants: EN,
    act: async (page) => {
      const flow = 'flow-documents';
      const file = `trade-licence-sample-${stamp()}.pdf`;
      await page.locator('[data-action="upload-document"]').first().click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      await must(dialog.getByText('Choose the kind of document first'), 'the note that the kind of document comes first');
      await step(page, flow, '1-upload-choose-type');
      await choose(page, dialog.getByRole('combobox').first(), 'Trade Licence');
      await dialog.locator('input[type="date"]').fill(dateFromToday(200));
      await dialog.locator('input[type="file"]').first().setInputFiles({ name: file, mimeType: 'application/pdf', buffer: pdf('SAMPLE trade licence (not a real document)') });
      await must(dialog.getByText('Uploaded. The file is checked'), 'the confirmation of the upload', 60_000);
      await step(page, flow, '2-uploaded');
      await dialog.getByRole('button', { name: 'Done' }).click();
      // The newest document comes first; the vault names it after its kind.
      const row = page.locator(RECORD).filter({ hasText: 'Trade Licence' }).filter({ hasText: /Not checked|Security check/ });
      await must(row, 'the uploaded document in the list', 60_000);
      await row.first().getByRole('button', { name: 'More actions' }).waitFor({ timeout: 90_000 });
      await settle(page);
      await step(page, flow, '3-in-the-list');
      await row.first().getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'View' }).click();
      await must(page.getByRole('dialog').locator('iframe, object, embed, canvas, img'), 'the document in the viewer', 60_000);
      await page.waitForTimeout(1500);
      await step(page, flow, '4-viewer');
      await page.keyboard.press('Escape');
      await row.first().getByRole('button', { name: 'More actions' }).click();
      const download = page.waitForEvent('download', { timeout: 60_000 });
      await page.getByRole('menuitem', { name: 'Download' }).click();
      await download;
    },
  },
  {
    // The employee's side: a request of their own (no "who is it for", the form prefilled from their record),
    // a question to the centre that the centre resolves, and a rating.
    name: 'flow-employee-own',
    path: '/overview',
    ...as(EMPLOYEE),
    ready: 'main [data-employee-overview]',
    variants: PHONE,
    act: async (page) => {
      const flow = 'flow-employee-own';
      // A draft left by an earlier run is discarded first (the employee's own "Discard this draft").
      await go(page, '/requests?show=drafts');
      while (await page.locator(RECORD).filter({ hasText: /AN-\d+/ }).count()) {
        await page.locator(RECORD).filter({ hasText: /AN-\d+/ }).first().locator('a').first().click();
        await page.waitForURL(/\/requests\/new\?.*draft=/);
        await page.getByRole('button', { name: 'Discard this draft' }).click();
        await page.getByRole('alertdialog').getByRole('button', { name: 'Discard this draft' }).click();
        await toast(page, 'discarded');
        await go(page, '/requests?show=drafts');
      }
      await go(page, '/overview');
      await page.getByRole('link', { name: 'New request' }).first().click();
      await page.waitForURL(/\/requests\/new/);
      await must(page.locator('main [data-service]'), 'the services');
      await mustNot(page, '[data-action="who-continue"]', 'the "who is it for" step for an employee');
      // An employee's request is the company's: the contract price applies.
      await must(page.locator('main [data-service]:has([data-contract-price])'), 'a service with the company\'s contract price');
      await step(page, flow, '1-services');
      await page.locator('main [data-service]').filter({ hasText: 'Emirates ID application typing' }).first().click();
      await must(page.locator('[data-action="start-request"]'), 'the summary of the service');
      // An own request is not billed to the company: the screen says so and does not show the company's contract price.
      await must(page.locator('[data-company-request]'), 'the note that this is a request of the company, for the employee');
      await must(page.locator('[data-fee-source="CORPORATE_CONTRACT"]'), 'the contract price of the company');
      await settle(page);
      await step(page, flow, '2-service-summary');
      await page.locator('[data-action="start-request"]').click();
      await page.waitForURL(/step=details/);
      await must(page.getByLabel('Full name (as in passport)'), 'the form of the service');
      if ((await page.getByLabel('Full name (as in passport)').inputValue()) !== EMPLOYEE_NAME) throw new Error('the name was not prefilled from the own record');
      await choose(page, page.getByLabel('Application type'), 'New');
      await must(page.locator('[data-save-state="saved"]'), 'the automatic save', 20_000);
      await settle(page);
      await step(page, flow, '3-details');
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.waitForURL(/step=documents/);
      await must(page.locator('main li[data-checklist-status]'), 'the document checklist');
      // Documents the centre already has for this employee are offered again.
      await must(page.getByRole('button', { name: 'Use this one' }), 'the offer to reuse a document already on file');
      while (await page.getByRole('button', { name: 'Use this one' }).filter({ visible: true }).count()) {
        const before = await page.getByRole('button', { name: 'Use this one' }).filter({ visible: true }).count();
        await page.getByRole('button', { name: 'Use this one' }).filter({ visible: true }).first().click();
        await page.waitForFunction((n) => [...document.querySelectorAll('main button')].filter((b) => b.textContent?.trim() === 'Use this one' && b.offsetParent).length < n, before, { timeout: 30_000 });
      }
      await page.locator('[data-missing-documents]').waitFor({ state: 'detached', timeout: 30_000 });
      await settle(page);
      await step(page, flow, '4-documents');
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.waitForURL(/step=review/);
      await settle(page);
      await step(page, flow, '5-review');
      await page.getByRole('button', { name: 'Submit request' }).click();
      await must(page.getByText('Request submitted'), 'the confirmation', 60_000);
      const requestNo = (await page.locator('[data-request-no]').innerText()).trim();
      await step(page, flow, '6-submitted');
      await page.getByRole('link', { name: 'Open the request' }).click();
      await page.waitForURL(/\/requests\/[0-9a-f-]{36}$/);
      await page.locator('main h1').waitFor();
      const requestId = page.url().split('/').pop();
      await must(page.locator('[data-waiting-on="CENTRE"]'), 'the request with the centre');
      await mustNot(page, '[data-money-card]', 'a quotation before the centre has sent one');
      await settle(page);
      await step(page, flow, '7-request');

      // The request is the company's, about the employee: the administrator sees it under the employee's name.
      const admin = await visitor(page);
      await signInAs(admin, ADMIN);
      await admin.goto(`${origin(page)}/requests`, { waitUntil: 'domcontentloaded' });
      await must(admin.locator(RECORD).filter({ hasText: requestNo }).filter({ hasText: EMPLOYEE_NAME }), 'the employee\'s request in the company list');
      await admin.screenshot({ path: resolve(OUT, `corporate-${flow}-7b-admin-sees-request.png`), animations: 'disabled' });

      // The centre quotes (staff API). The employee sees that a quotation waits for the company, without the amount
      // and without a decision; the administrator is told and approves it in this portal.
      const centre = await staff();
      const now = await centre('GET', `/requests/${requestId}`);
      if (!now.finance?.quotation) {
        for (const line of now.checklist.filter((l) => l.document && l.document.verificationStatus !== 'VERIFIED')) await centre('POST', `/documents/${line.document.id}/verify`, { decision: 'APPROVED' });
        const quotation = await centre('POST', `/quotations/from-request/${requestId}`, { notes: 'Contract price. (flow test)' });
        await centre('POST', `/quotations/${quotation.id}/send`);
      }
      await page.reload({ waitUntil: 'domcontentloaded' });
      await must(page.locator('[data-waiting-on="CUSTOMER"]'), 'the "waiting for your company" card');
      await must(page.locator('[data-money-card][data-amounts-hidden] [data-approval-state="SENT"]'), 'the quotation waiting for the company, without amounts');
      await mustNot(page, '[data-action="review-quotation"], [data-action="approve"], [data-money-card] a', 'a decision for the employee');
      if (await page.locator('[data-money-card]').getByText(/AED/).count()) throw new Error('an amount is shown to an employee');
      await settle(page);
      await step(page, flow, '7c-quoted-employee-view');
      await go(page, '/requests');
      await must(page.locator(RECORD).filter({ hasText: requestNo }).locator('[data-made-by="company"]'), 'the request billed to the company');
      await step(page, flow, '7d-requests');

      // The administrator: a notification with a link to the approval, and the approval itself.
      const quoted = await centre('GET', `/requests/${requestId}`);
      const quotationNo = quoted.finance.quotation.quotationNo;
      await admin.goto(`${origin(page)}/notifications`, { waitUntil: 'domcontentloaded' });
      await must(admin.locator('main [data-notification]').filter({ hasText: quotationNo }), 'the administrator\'s notification about the quotation');
      await admin.screenshot({ path: resolve(OUT, `corporate-${flow}-7e-admin-notified.png`), animations: 'disabled' });
      await admin.locator('main [data-notification]').filter({ hasText: quotationNo }).first().locator('button').first().click();
      await admin.waitForURL(/\/approvals\/[0-9a-f-]{36}/, { timeout: 30_000 });
      await must(admin.locator('[data-action="approve"]'), 'the approve button for the administrator');
      await settle(admin);
      await admin.screenshot({ path: resolve(OUT, `corporate-${flow}-7f-admin-approves.png`), fullPage: true, animations: 'disabled' });
      await admin.locator('[data-action="approve"]').click();
      await admin.getByRole('alertdialog').getByRole('button', { name: 'Approve quotation' }).click();
      await must(admin.locator('[data-decision="APPROVED"]'), 'the approved quotation', 60_000);
      await admin.context().close();
      await go(page, `/requests/${requestId}`);
      await must(page.locator('[data-money-card][data-amounts-hidden] [data-approval-state="APPROVED"]'), 'the approval, seen by the employee');
      await must(page.locator('[data-money-card]').getByText(/INV-\d+/), 'the invoice of the company, by number only');
      if (await page.locator('[data-money-card]').getByText(/AED/).count()) throw new Error('an amount is shown to an employee');
      await step(page, flow, '7g-approved-employee-view');

      // A question; the centre resolves it; the employee rates the answer.
      const subject = `Photo size ${stamp()}`;
      await page.getByRole('link', { name: 'Ask about this request' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Subject').fill(subject);
      await dialog.getByLabel('Your question').fill('Is a passport-size photo enough? (flow test)');
      await dialog.locator('button[type="submit"]').click();
      await page.waitForURL(/\/support\/[0-9a-f-]{36}/, { timeout: 60_000 });
      const ticketId = page.url().split('/').pop().split('?')[0];
      const api = await staff();
      await api('POST', `/support/tickets/${ticketId}/messages`, { body: 'Yes, with a white background. (flow test)', visibility: 'CUSTOMER', status: 'RESOLVED', resolutionSummary: 'Answered. (flow test)' });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await must(page.locator('main').getByText('with a white background'), 'the answer of the centre');
      await must(page.getByRole('radio', { name: '5 stars out of 5' }), 'the rating of a resolved conversation');
      await step(page, flow, '8-resolved');
      await page.getByRole('radio', { name: '5 stars out of 5' }).click();
      await page.getByLabel('Anything you want to add?').fill('Quick answer. (flow test)');
      await page.getByRole('button', { name: 'Send rating' }).click();
      await toast(page, 'Thank you for your rating');
      await page.getByRole('button', { name: 'Send rating' }).waitFor({ state: 'detached' });
      await settle(page);
      await step(page, flow, '9-rated');
      saveState({ employeeRequestId: requestId, employeeRequestNo: requestNo });
    },
  },
  {
    // A completed company request is rated once, by the administrator (the person it is about may rate it too).
    name: 'flow-rating',
    path: '/requests',
    ...as(ADMIN),
    ready: ROW,
    variants: EN,
    act: async (page) => {
      const flow = 'flow-rating';
      await choose(page, page.locator('main button').filter({ hasText: /^Show/ }).first(), 'Completed');
      const api = await staff();
      // A completed company request that was not rated yet.
      const done = await api('GET', '/requests?status=COMPLETED&corporateAccountId=ec33221e-598d-462c-b0a3-309d2dcb3f8e&pageSize=50');
      let target = null;
      for (const r of done.data) {
        const view = await api('GET', `/requests/${r.id}`);
        if (!view.feedback) {
          target = r;
          break;
        }
      }
      if (!target) throw new Error('every completed company request is rated already');
      await openRow(page, target.requestNo);
      await page.locator('[data-request-feedback]').scrollIntoViewIfNeeded();
      await must(page.locator('[data-request-feedback]'), 'the rating card on a completed request');
      await must(page.getByRole('radio', { name: '4 stars out of 5' }), 'the stars');
      await step(page, flow, '1-completed-request');
      await page.getByRole('radio', { name: '4 stars out of 5' }).click();
      await page.getByLabel('Anything you want to add?').fill('Done on time. (flow test)');
      await page.getByRole('button', { name: 'Send rating' }).click();
      await toast(page, 'Thank you for your rating');
      await page.getByRole('button', { name: 'Send rating' }).waitFor({ state: 'detached' });
      await must(page.locator('[data-request-feedback]').getByText('Done on time'), 'the rating that was given');
      await settle(page);
      await step(page, flow, '2-rated');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await must(page.locator('[data-request-feedback]').getByText('Done on time'), 'the rating after a reload (from the request itself)');
      if (await page.getByRole('button', { name: 'Send rating' }).count()) throw new Error('a rated request can be rated again');
      // The administrator's support conversations cannot be rated (the API refuses it): no form there.
      await go(page, '/support');
      if (await page.locator(RECORD).count()) {
        await page.locator(RECORD).first().locator('a').first().click();
        await page.waitForURL(/\/support\/[0-9a-f-]{36}/);
        await page.locator('main h1').waitFor();
        await settle(page);
        if (await page.getByRole('button', { name: 'Send rating' }).count()) throw new Error('a rating form on a company ticket');
      }
    },
  },
  {
    // The steps of the wizard in Arabic and on a phone: a draft for the company itself is started, each step is
    // pictured (corporate-flow-wizard-views-<step>-<variant>.png) and the draft is discarded again.
    name: 'flow-wizard-views',
    path: '/requests/new?for=company',
    ...as(ADMIN),
    ready: 'main [data-service]',
    variants: ['ar-dark-desktop', 'en-light-mobile'],
    act: async (page) => {
      const flow = 'flow-wizard-views';
      const variant = `${await page.evaluate(() => document.documentElement.lang)}-${page.viewportSize().width < 600 ? 'mobile' : 'desktop'}`;
      await page.locator('main [data-service]').filter({ hasText: /Trade licence renewal|الرخصة التجارية/ }).first().click();
      await must(page.locator('[data-action="start-request"]'), 'the summary of the service');
      await page.locator('[data-action="start-request"]').click();
      await page.waitForURL(/step=details/);
      await page.locator('main h1').waitFor();
      await settle(page);
      await step(page, flow, `1-details-${variant}`);
      const next = page.locator('main button').filter({ hasText: /^(Continue|متابعة)$/ }).last();
      await next.click();
      // A form with required answers stays on the step and marks them: that picture is wanted too.
      await page.waitForTimeout(800);
      if (!/step=documents/.test(page.url())) {
        await step(page, flow, `2-details-errors-${variant}`);
        await go(page, `${new URL(page.url()).pathname}?${new URL(page.url()).searchParams.toString().replace('step=details', 'step=documents')}`);
      }
      await must(page.locator('main li[data-checklist-status]'), 'the document checklist');
      await page.locator('main li[data-checklist-status] button').first().click();
      await settle(page);
      await step(page, flow, `3-documents-${variant}`);
      await go(page, `${new URL(page.url()).pathname}?${new URL(page.url()).searchParams.toString().replace('step=documents', 'step=review')}`);
      await settle(page);
      await step(page, flow, `4-review-${variant}`);
      await page.locator('main button').filter({ hasText: /^(Discard this draft|تجاهل هذه المسودة|حذف هذه المسودة)$/ }).click();
      await must(page.getByRole('alertdialog'), 'the confirmation');
      await step(page, flow, `5-discard-${variant}`);
      await page.getByRole('alertdialog').locator('button').last().click();
      await page.waitForURL(/\/requests(\?|$)/, { timeout: 30_000 });
      await page.locator('main h1').waitFor();
      await settle(page);
    },
  },
  {
    // A quotation waiting for the company's decision, in the three variants: the list, the quotation and the
    // decline dialog. The centre sends a new quotation for the request whose first one was declined in
    // flow-approvals (staff API, once); it is left waiting, so the demo company has something to approve.
    name: 'flow-approval-views',
    path: '/approvals',
    ...as(ADMIN),
    ready: 'main [role="tabpanel"]',
    fullPage: true,
    prepare: async () => {
      const { secondId } = readState();
      if (!secondId) throw new Error('run flow-new-request and flow-approvals first');
      const api = await staff();
      const now = await api('GET', `/requests/${secondId}`);
      if (now.finance?.quotation?.status === 'SENT') return;
      const quotation = await api('POST', `/quotations/from-request/${secondId}`, { notes: 'Corrected: your contract price applies to replacements too. (flow test)' });
      await api('POST', `/quotations/${quotation.id}/send`);
    },
    act: async (page) => {
      const flow = 'flow-approval-views';
      const variant = `${await page.evaluate(() => document.documentElement.lang)}-${page.viewportSize().width < 600 ? 'mobile' : 'desktop'}`;
      await must(page.locator('[data-quotation]'), 'the quotation waiting for a decision');
      await settle(page);
      await step(page, flow, `1-waiting-${variant}`);
      await page.locator('[data-quotation] [data-action="review"]').first().click();
      await page.waitForURL(/\/approvals\/[0-9a-f-]{36}/);
      await must(page.locator('[data-action="approve"]'), 'the approve button');
      await settle(page);
      await step(page, flow, `2-quotation-${variant}`);
      await page.locator('[data-action="reject"]').click();
      const dialog = page.getByRole('dialog');
      await dialog.locator('button[type="submit"]').click();
      await must(dialog.locator('[role="alert"]'), 'the message that a reason is required');
    },
  },
];

const only = (() => {
  const i = process.argv.indexOf('--only');
  return i >= 0 ? (process.argv[i + 1] ?? '').split(',').filter(Boolean) : [];
})();
// Flows and the scenarios that are expected to log a refused call only run when they are named.
const NAMED_ONLY = (s) => s.name.startsWith('flow-') || s.namedOnly;
export default [...screens, ...flows].filter((s) => (only.length ? true : !NAMED_ONLY(s)));
