/**
 * Screenshot scenarios of the platform console. Run from the repository root:
 *
 *   export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
 *   node packages/ui/scripts/screenshots.mjs --app platform --scenarios apps/platform-admin/scripts/shots.mjs --out /tmp/shots-platform-admin [--only dashboard,tenants]
 *
 * Scenarios whose name starts with "flow-" CHANGE data: they run in one variant only and work on
 * centres, coupons, flags, staff and register entries they create themselves (names start with "Shots").
 * The three demo centres are only read. Run the flows in file order: "flow-tenant-create" adds the
 * centre the billing, suspend and close flows work on.
 *
 * Set-up the flows expect (done once through the API, see the comment above the flows):
 *   - the centre "Shots Console Typing" (slug shots-console, owner owner@shots-console.test, signed up
 *     through POST /public/signup and verified) with one platform support ticket "Shots: cannot upload ...";
 *   - the coupon SHOTSBILL (10 %, 2 months).
 * Intermediate pictures of a flow are written next to the final one as platform-<name>-<step>.png.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = resolve(process.cwd(), process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : '/tmp/shots-platform-admin');
mkdirSync(OUT, { recursive: true });

const ADMIN = 'admin@typease.test';
const AGENT = 'support@typease.test';
const ONE = ['en-light-desktop'];
const LIST = 'main table tbody tr a:visible, main table tbody tr button:visible, main ul li a:visible, main ul li button:visible';
const stamp = Date.now().toString(36).slice(-5);

/** An extra picture in the middle of a flow. */
const step = async (page, name) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: resolve(OUT, `platform-${name}.png`), animations: 'disabled' });
};
const dialog = (page) => page.getByRole('dialog');
const alertDialog = (page) => page.getByRole('alertdialog');
/** Picks an option of a Radix <Select> by its visible text. */
const choose = async (page, trigger, text) => {
  await trigger.click();
  await page.getByRole('option', { name: text }).first().click();
};
/** Opens the row menu of the table row that contains `text` and picks an action. */
const rowAction = async (page, text, action) => {
  const row = page.locator('main table tbody tr', { hasText: text }).first();
  await row.waitFor();
  await row.getByRole('button', { name: /More actions|Actions for/ }).click();
  await page.getByRole('menuitem', { name: action }).click();
};
const expectText = async (page, text) => {
  await page.getByText(text, { exact: false }).first().waitFor({ timeout: 20_000 });
};
/** From the centre list to the page of the newest centre whose name matches. */
const openCentre = async (page, name) => {
  await page.locator('main').getByRole('link', { name }).first().click();
  await page.waitForURL(/\/tenants\/[0-9a-f-]{36}/);
  await page.locator('main [role="tablist"]').waitFor();
};
/** Picks an entry of the "Lifecycle" menu of a centre page. */
const lifecycle = async (page, action) => {
  await page.locator('main header').getByRole('button', { name: 'Lifecycle' }).click();
  await page.getByRole('menuitem', { name: action }).click();
};

// The API, for the one step that belongs to another app (a centre approving support access).
const API = process.env.TYPEASE_API ?? 'http://localhost:4000/api/v1';
const signIn = async ({ email, app, tenantSlug }) => {
  const res = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Client-App': app }, body: JSON.stringify({ email, password: 'TypEase-Demo-2026', app, tenantSlug }) });
  const body = await res.json();
  if (!body.accessToken) throw new Error(`sign-in of ${email} failed: ${JSON.stringify(body).slice(0, 200)}`);
  return body.accessToken;
};
const call = async (token, method, path, body, app = 'platform') => {
  const res = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'X-Client-App': app, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
};

export default [
  // ------------------------------------------------------------------ dashboard
  { name: 'dashboard', path: '/dashboard', as: ADMIN, ready: 'main .recharts-surface', fullPage: true },
  { name: 'dashboard-agent', path: '/dashboard', as: AGENT, ready: 'main h1', variants: ['en-light-desktop', 'en-light-mobile'] },

  // ------------------------------------------------------------------ centres
  { name: 'tenants', path: '/tenants', as: ADMIN, ready: LIST },
  {
    name: 'tenants-add-validation',
    path: '/tenants?add=1',
    as: ADMIN,
    ready: LIST,
    act: async (page) => {
      const d = dialog(page);
      await d.waitFor();
      await d.locator('input').nth(0).fill('A');
      await d.locator('input[type="email"]').fill('not-an-email');
      await d.locator('button[type="submit"]').click();
      await d.locator('[role="alert"]').first().waitFor();
    },
  },
  {
    name: 'tenant-overview',
    path: '/tenants?q=al-noor',
    as: ADMIN,
    ready: LIST,
    fullPage: true,
    act: async (page) => {
      await page.locator('main').getByRole('link', { name: /Al Noor/ }).first().click();
      await page.waitForURL(/\/tenants\/[0-9a-f-]{36}/);
      await page.locator('main [role="meter"]').first().waitFor();
    },
  },
  {
    name: 'tenant-billing',
    path: '/tenants?q=al-noor',
    as: ADMIN,
    ready: LIST,
    fullPage: true,
    act: async (page) => {
      await page.locator('main').getByRole('link', { name: /Al Noor/ }).first().click();
      await page.waitForURL(/\/tenants\/[0-9a-f-]{36}/);
      await page.getByRole('tab').nth(1).click();
      await page.locator('main table tbody tr').first().waitFor();
    },
  },
  {
    name: 'tenant-access',
    path: '/tenants?q=gulf-star',
    as: ADMIN,
    ready: LIST,
    variants: ['en-light-desktop', 'en-light-mobile'],
    act: async (page) => {
      await page.locator('main').getByRole('link', { name: /Gulf Star/ }).first().click();
      await page.waitForURL(/\/tenants\/[0-9a-f-]{36}/);
      await page.getByRole('tab', { name: 'Support access' }).click();
      await page.locator('main [role="tabpanel"] table tbody tr:visible, main [role="tabpanel"] ul li:visible').first().waitFor();
    },
  },
  {
    name: 'tenant-audit',
    path: '/tenants?q=gulf-star',
    as: ADMIN,
    ready: LIST,
    variants: ['en-light-desktop', 'en-light-mobile'],
    fullPage: true,
    act: async (page) => {
      await page.locator('main').getByRole('link', { name: /Gulf Star/ }).first().click();
      await page.waitForURL(/\/tenants\/[0-9a-f-]{36}/);
      await page.getByRole('tab', { name: 'Audit trail' }).click();
      await page.locator('main [role="tabpanel"] table tbody tr:visible, main [role="tabpanel"] ul li:visible').first().waitFor();
    },
  },
  {
    // The confirmation of a far-reaching action with its mandatory reason, in every variant. Nothing is
    // submitted: the scenario presses the button with an empty reason and stops at the message.
    name: 'tenant-suspend-dialog',
    path: '/tenants?q=shots-console',
    as: ADMIN,
    ready: LIST,
    act: async (page) => {
      await page.locator('main').getByRole('link', { name: /Shots Console/ }).first().click();
      await page.waitForURL(/\/tenants\/[0-9a-f-]{36}/);
      await page.locator('main [role="tablist"]').waitFor();
      await page.locator('main header button[aria-haspopup="menu"]').click();
      await page.getByRole('menuitem').first().click();
      const a = alertDialog(page);
      await a.waitFor();
      await a.locator('button').last().click();
      await a.locator('[role="alert"]').first().waitFor();
    },
  },
  {
    // Only shows rows while a feature flag exists (the flag flow creates and deletes its own).
    name: 'tenant-flags',
    path: '/tenants?q=shots-console',
    as: ADMIN,
    ready: LIST,
    variants: ['en-light-desktop', 'en-light-mobile'],
    act: async (page) => {
      await openCentre(page, /Shots Console/);
      await page.getByRole('tab', { name: 'Feature flags' }).click();
      await page.locator('main [role="tabpanel"] a[href="/feature-flags"]').waitFor();
      await page.locator('main [role="tabpanel"] [aria-busy="true"], main [role="tabpanel"] .animate-pulse').first().waitFor({ state: 'hidden' });
    },
  },
  {
    name: 'tenant-agent',
    path: '/tenants?q=al-noor',
    as: AGENT,
    ready: LIST,
    variants: ONE,
    fullPage: true,
    act: async (page) => {
      await page.locator('main').getByRole('link', { name: /Al Noor/ }).first().click();
      await page.waitForURL(/\/tenants\/[0-9a-f-]{36}/);
      await page.locator('main [role="meter"]').first().waitFor();
      // A support agent has no lifecycle menu, no billing, flags or audit tab.
      if (await page.getByRole('button', { name: 'Lifecycle' }).count()) throw new Error('lifecycle menu is visible to a support agent');
      if (await page.getByRole('tab', { name: 'Billing' }).count()) throw new Error('billing tab is visible to a support agent');
    },
  },

  // ------------------------------------------------------------------ billing
  { name: 'subscriptions', path: '/subscriptions', as: ADMIN, ready: LIST },
  { name: 'subscriptions-failed', path: '/subscriptions?tab=failed', as: ADMIN, ready: 'main [role="tabpanel"] section', variants: ONE },
  { name: 'coupons', path: '/plans/coupons', as: ADMIN, ready: 'main table tbody tr td:visible, main ul li:visible' },
  { name: 'plans', path: '/plans', as: ADMIN, ready: 'main table:visible, main dl:visible' },

  // ------------------------------------------------------------------ support
  { name: 'support', path: '/support?show=all', as: ADMIN, ready: LIST },
  {
    name: 'support-ticket',
    path: '/support',
    as: AGENT,
    ready: LIST,
    fullPage: true,
    act: async (page) => {
      await page.locator('main table tbody tr a:visible, main ul li a:visible').first().click();
      await page.waitForURL(/\/support\/[0-9a-f-]{36}/);
      await page.locator('main textarea').waitFor();
    },
  },
  { name: 'access-requests', path: '/access-requests', as: ADMIN, ready: LIST },
  {
    name: 'access-request-detail',
    path: '/access-requests',
    as: ADMIN,
    ready: LIST,
    variants: ['en-light-desktop', 'ar-dark-desktop'],
    act: async (page) => {
      await page.locator('main table tbody tr button:visible').first().click();
      await dialog(page).waitFor();
      await dialog(page).locator('ol li').first().waitFor();
    },
  },
  {
    name: 'access-request-form',
    path: '/access-requests',
    as: AGENT,
    ready: 'main h1',
    act: async (page) => {
      await page.locator('main header button').first().click();
      const d = dialog(page);
      await d.waitFor();
      await d.locator('button[type="submit"]').click();
      await d.locator('[role="alert"]').first().waitFor();
    },
  },

  // ------------------------------------------------------------------ platform
  { name: 'feature-flags', path: '/feature-flags', as: ADMIN, ready: 'main [role="tabpanel"] > *' },
  { name: 'platform-settings', path: '/feature-flags?tab=settings', as: ADMIN, ready: 'main form', fullPage: true },
  { name: 'integrations', path: '/integrations', as: ADMIN, ready: 'main [role="tabpanel"] table tbody tr', fullPage: true },
  { name: 'integrations-reviews', path: '/integrations?tab=reviews', as: ADMIN, ready: 'main [role="tabpanel"] section' },
  { name: 'integrations-providers', path: '/integrations?tab=providers', as: ADMIN, ready: 'main table tbody tr', fullPage: true },
  { name: 'system-health', path: '/system-health', as: ADMIN, ready: 'main section h2', fullPage: true },
  { name: 'audit', path: '/audit', as: ADMIN, ready: LIST },
  { name: 'audit-security', path: '/audit?tab=security', as: ADMIN, ready: LIST, fullPage: true },
  { name: 'audit-incidents', path: '/audit?tab=incidents', as: ADMIN, ready: LIST, variants: ONE },
  { name: 'audit-processors', path: '/audit?tab=processors', as: ADMIN, ready: 'main table tbody tr td:visible', variants: ONE },
  { name: 'staff', path: '/staff', as: ADMIN, ready: 'main table tbody tr td:visible, main ul li:visible' },

  {
    // The review of a centre's authorisation record: opened up to the confirmation, never confirmed
    // (a decision on a demo centre's record cannot be taken back).
    name: 'integrations-review',
    path: '/integrations?tab=reviews',
    as: ADMIN,
    ready: 'main table tbody tr button:visible, main table tbody tr td:visible',
    variants: ['en-light-desktop', 'ar-dark-desktop'],
    act: async (page) => {
      await page.locator('main table tbody tr').first().click();
      await dialog(page).waitFor();
      await dialog(page).locator('dl').first().waitFor();
    },
  },
  {
    // Approved providers: a change is prepared and stopped at the confirmation. Saving it would switch
    // off connections of the demo centres, so the scenario cancels.
    name: 'integrations-providers-confirm',
    path: '/integrations?tab=providers',
    as: ADMIN,
    ready: 'main table tbody tr [role="switch"]',
    variants: ONE,
    act: async (page) => {
      await page.locator('main table [role="switch"]').first().click();
      await page.getByRole('button', { name: 'Save changes' }).click();
      await alertDialog(page).waitFor();
      await step(page, 'integrations-providers-confirm-1-dialog');
      await alertDialog(page).getByRole('button', { name: 'Cancel' }).click();
      await alertDialog(page).waitFor({ state: 'hidden' });
    },
  },

  // ================================================================== flows that change data
  // Everything below works on things the scenarios (or the set-up described in the header) created:
  // the centre "Shots Flow <stamp>" added through the dialog, the centre "Shots Console Typing"
  // (slug shots-console, signed up for these scenarios, with one support ticket) and the coupon SHOTSBILL.

  {
    name: 'flow-tenant-create',
    path: '/tenants',
    as: ADMIN,
    ready: LIST,
    variants: ONE,
    fullPage: true,
    act: async (page) => {
      await page.getByRole('button', { name: 'Add centre' }).first().click();
      const d = dialog(page);
      await d.waitFor();
      await d.locator('[name="businessName"]').fill(`Shots Flow ${stamp}`);
      await d.locator('[name="ownerName"]').fill('Shots Flow Owner');
      await d.locator('[name="ownerEmail"]').fill(`owner@shots-flow-${stamp}.test`);
      await choose(page, d.getByRole('combobox', { name: /^Plan/ }), /Professional/);
      await step(page, 'flow-tenant-create-1-form');
      await d.locator('button[type="submit"]').click();
      await page.waitForURL(/\/tenants\/[0-9a-f-]{36}/);
      await expectText(page, 'Centre added');
      await page.locator('main h1', { hasText: `Shots Flow ${stamp}` }).waitFor();
      await page.locator('main [role="meter"]').first().waitFor();
    },
  },
  {
    name: 'flow-tenant-billing',
    path: '/tenants?q=shots-flow',
    as: ADMIN,
    ready: LIST,
    variants: ONE,
    fullPage: true,
    act: async (page) => {
      await openCentre(page, /Shots Flow/);
      await page.getByRole('tab', { name: 'Billing' }).click();
      const main = page.locator('main');

      // Extend the trial: the reason is mandatory.
      await main.getByRole('button', { name: 'Extend trial' }).click();
      const a = alertDialog(page);
      await a.waitFor();
      await a.getByRole('button', { name: 'Extend trial' }).click();
      await a.locator('[role="alert"]').first().waitFor();
      await step(page, 'flow-tenant-billing-1-reason-required');
      await a.locator('input[type="number"]').fill('14');
      await a.locator('textarea').fill('Shots: the owner asked for two more weeks to move their data.');
      await a.getByRole('button', { name: 'Extend trial' }).click();
      await expectText(page, 'Trial extended by 14 days');
      await a.waitFor({ state: 'hidden' });

      // Apply a coupon.
      await main.getByRole('button', { name: 'Apply coupon' }).click();
      const d = dialog(page);
      await d.waitFor();
      await d.locator('[name="code"]').fill('SHOTSBILL');
      await d.locator('button[type="submit"]').click();
      await expectText(page, 'Coupon SHOTSBILL applied');
      await d.waitFor({ state: 'hidden' });

      // Change the plan, at once.
      await main.getByRole('button', { name: 'Change plan' }).click();
      await a.waitFor();
      await choose(page, a.getByRole('combobox', { name: /New plan/ }), /Business/);
      await a.getByRole('checkbox').click();
      await a.locator('textarea').fill('Shots: they need the customer portal on their own domain.');
      await step(page, 'flow-tenant-billing-2-change-plan');
      await a.getByRole('button', { name: 'Change plan' }).click();
      await expectText(page, 'Plan changed');
      await a.waitFor({ state: 'hidden' });
      await main.locator('dl', { hasText: 'Business' }).first().waitFor();
      await main.locator('dl', { hasText: 'SHOTSBILL' }).first().waitFor();
    },
  },
  {
    name: 'flow-tenant-suspend',
    path: '/tenants?q=shots-flow',
    as: ADMIN,
    ready: LIST,
    variants: ONE,
    act: async (page) => {
      await openCentre(page, /Shots Flow/);
      await lifecycle(page, 'Suspend');
      const a = alertDialog(page);
      await a.waitFor();
      await a.getByRole('button', { name: 'Suspend' }).click();
      await a.locator('[role="alert"]').first().waitFor();
      await a.locator('textarea').fill('Shots: the trade licence on file expired and was not renewed.');
      await step(page, 'flow-tenant-suspend-1-confirm');
      await a.getByRole('button', { name: 'Suspend' }).click();
      await expectText(page, 'suspended');
      await a.waitFor({ state: 'hidden' });
      await expectText(page, 'Suspended by TypEase');
      await step(page, 'flow-tenant-suspend-2-suspended');

      await page.locator('main [role="alert"], main [role="status"], main').getByRole('button', { name: 'Reactivate' }).first().click();
      await a.waitFor();
      await a.locator('textarea').fill('Shots: the renewed licence arrived.');
      await a.getByRole('button', { name: 'Reactivate' }).click();
      await expectText(page, 'reactivated');
      await a.waitFor({ state: 'hidden' });
      await page.getByText('Suspended by TypEase').first().waitFor({ state: 'hidden' });
    },
  },
  {
    name: 'flow-coupon',
    path: '/plans/coupons',
    as: ADMIN,
    ready: 'main table tbody tr td:visible, main ul li:visible',
    variants: ONE,
    act: async (page) => {
      const code = `SHOTS${stamp.toUpperCase()}`;
      await page.getByRole('button', { name: 'Create coupon' }).first().click();
      const d = dialog(page);
      await d.waitFor();
      await d.locator('[name="code"]').fill(code);
      await d.locator('button[type="submit"]').click();
      await d.locator('[role="alert"]').first().waitFor();
      await step(page, 'flow-coupon-1-discount-required');
      await d.locator('[name="percentOff"]').fill('15');
      await d.locator('[name="durationMonths"]').fill('3');
      await d.locator('[name="description"]').fill('Shots: test coupon, not for customers');
      await d.locator('button[type="submit"]').click();
      await expectText(page, `Coupon ${code} created`);
      await d.waitFor({ state: 'hidden' });

      await rowAction(page, code, 'Deactivate');
      const a = alertDialog(page);
      await a.waitFor();
      await a.getByRole('button', { name: 'Deactivate' }).click();
      await expectText(page, `Coupon ${code} deactivated`);
      await a.waitFor({ state: 'hidden' });
      await page.locator('main table tbody tr', { hasText: code }).getByText('Deactivated').waitFor();
      await step(page, 'flow-coupon-2-deactivated');

      await rowAction(page, code, 'Delete');
      await a.waitFor();
      await a.getByRole('button', { name: 'Delete' }).click();
      await expectText(page, `Coupon ${code} deleted`);
      await a.waitFor({ state: 'hidden' });
      await page.locator('main table tbody tr', { hasText: code }).waitFor({ state: 'hidden' });
    },
  },
  {
    // A plan of its own: added as a private plan, re-priced and taken off the offer, deleted again.
    name: 'flow-plan',
    path: '/plans',
    as: ADMIN,
    ready: 'main table:visible, main dl:visible',
    variants: ONE,
    act: async (page) => {
      const name = `Shots Plan ${stamp}`;
      await page.locator('main header').getByRole('button', { name: 'Add plan' }).click();
      const d = dialog(page);
      await d.waitFor();
      await d.locator('button[type="submit"]').click();
      await d.locator('[role="alert"]').first().waitFor();
      await step(page, 'flow-plan-1-required');
      await d.locator('[name="key"]').fill(`shots-plan-${stamp}`);
      await d.locator('[name="name"]').fill(name);
      await d.locator('[name="description"]').fill('Shots: test plan of the screenshot scenarios.');
      await d.locator('[name="monthlyPrice"]').fill('99');
      await d.locator('[name="annualPrice"]').fill('990');
      await d.getByRole('checkbox', { name: 'API access' }).click();
      await d.getByRole('switch', { name: 'On the sign-up page' }).click();
      await step(page, 'flow-plan-2-form');
      await d.locator('button[type="submit"]').click();
      await expectText(page, `Plan ${name} added`);
      await d.waitFor({ state: 'hidden' });
      const column = page.locator('main table thead th', { hasText: name });
      await column.getByText('Private').waitFor();

      await page.getByRole('button', { name: `Edit the plan ${name}` }).first().click();
      await d.waitFor();
      await d.locator('[name="monthlyPrice"]').fill('119');
      await d.getByRole('switch', { name: 'Offered' }).click();
      await d.locator('button[type="submit"]').click();
      await expectText(page, `Plan ${name} saved`);
      await d.waitFor({ state: 'hidden' });
      await column.getByText('Not offered').waitFor();
      await expectText(page, 'AED 119.00');
      await step(page, 'flow-plan-3-edited');

      await page.getByRole('button', { name: `Edit the plan ${name}` }).first().click();
      await d.waitFor();
      await d.getByRole('button', { name: 'Delete plan' }).click();
      const a = alertDialog(page);
      await a.waitFor();
      await a.getByRole('button', { name: 'Delete plan' }).click();
      await expectText(page, `Plan ${name} deleted`);
      await a.waitFor({ state: 'hidden' });
      await column.waitFor({ state: 'hidden' });
    },
  },
  {
    // Editing a plan that centres are on asks first. Opened on a demo plan and cancelled: nothing is saved.
    name: 'plan-edit-confirm',
    path: '/plans',
    as: ADMIN,
    ready: 'main table:visible, main dl:visible',
    variants: ['en-light-desktop', 'ar-dark-desktop', 'en-light-mobile'],
    act: async (page) => {
      await page.locator('main').getByRole('button', { name: /Starter/ }).first().click();
      const d = dialog(page);
      await d.waitFor();
      await d.locator('[name="name"]').waitFor();
    },
  },
  {
    // Driven by the support agent: this is the daily work of the lower-privileged role.
    name: 'flow-ticket',
    path: '/support?show=all',
    as: AGENT,
    ready: LIST,
    variants: ONE,
    fullPage: true,
    act: async (page) => {
      await page.locator('main').getByRole('link', { name: /Shots: cannot upload/ }).first().click();
      await page.waitForURL(/\/support\/[0-9a-f-]{36}/);
      const main = page.locator('main');
      await main.locator('textarea').waitFor();
      // Makes the scenario repeatable: a ticket resolved by an earlier run is reopened first.
      if (await main.getByRole('button', { name: 'Reopen' }).count()) {
        await main.getByRole('button', { name: 'Reopen' }).click();
        await expectText(page, 'Status changed');
        await main.getByRole('button', { name: 'Resolve' }).waitFor();
      }
      if (await main.getByRole('button', { name: 'Unassign me' }).count()) {
        await main.getByRole('button', { name: 'Unassign me' }).click();
        await main.getByRole('button', { name: 'Assign to me' }).waitFor();
      }
      await main.getByRole('button', { name: 'Assign to me' }).click();
      await expectText(page, 'Ticket assigned to you');
      await main.getByRole('button', { name: 'Unassign me' }).waitFor();

      // An internal note: never shown to the centre.
      await page.locator('#reply-internal').click();
      await main.locator('textarea').fill('Shots: the upload limit is 10 MB, so 3 MB should pass. Asking for the file name; could be the file type.');
      await step(page, 'flow-ticket-1-internal-note');
      await main.getByRole('button', { name: 'Add note' }).click();
      await expectText(page, 'Note added');
      await main.getByRole('button', { name: 'Send reply' }).waitFor();

      // A reply to the centre that also moves the ticket to "waiting".
      await main.locator('textarea').fill('Thank you for writing in. Could you tell us the file name and type of the trade licence you tried to upload? PDF, JPG and PNG are accepted.');
      await choose(page, main.getByRole('combobox', { name: /After sending/ }), 'Wait for the centre');
      await main.getByRole('button', { name: 'Send reply' }).click();
      await expectText(page, 'Reply sent');
      await main.locator('header').getByText('Waiting').first().waitFor();
      await step(page, 'flow-ticket-2-replied');

      // Resolve with a summary.
      await main.getByRole('button', { name: 'Resolve' }).click();
      const a = alertDialog(page);
      await a.waitFor();
      await a.locator('textarea').fill('Shots: the file was a .heic photo. The centre converted it to PDF and the upload went through.');
      await a.getByRole('button', { name: 'Resolve' }).click();
      await expectText(page, 'Ticket resolved');
      await a.waitFor({ state: 'hidden' });
      await main.locator('header').getByText('Resolved').first().waitFor();
    },
  },
  {
    // Request access to a centre, see it waiting for the centre's decision, withdraw it again.
    name: 'flow-access-request',
    path: '/access-requests',
    as: AGENT,
    ready: 'main h1',
    variants: ONE,
    act: async (page) => {
      const reason = `Shots ${stamp}: the centre reports wrong totals on two requests; we need to look at them.`;
      await page.locator('main header').getByRole('button', { name: 'Request access' }).click();
      const d = dialog(page);
      await d.waitFor();
      await d.getByRole('combobox').first().click();
      await page.getByPlaceholder('Name, address part or email').fill('shots-console');
      await page.getByRole('option', { name: /Shots Console/ }).first().click();
      await d.locator('[name="reason"]').fill(reason);
      await d.getByRole('checkbox', { name: /^Requests/ }).click();
      await d.getByRole('checkbox', { name: /^Invoices/ }).click();
      await step(page, 'flow-access-request-1-form');
      await d.locator('button[type="submit"]').click();
      await expectText(page, 'Access requested');
      await d.waitFor({ state: 'hidden' });

      const row = page.locator('main table tbody tr', { hasText: `Shots ${stamp}` }).first();
      await row.waitFor();
      await row.getByText('Waiting').first().waitFor();
      await row.locator('td').nth(1).click();
      await d.waitFor();
      await d.locator('ol li').first().waitFor();
      await step(page, 'flow-access-request-2-waiting');
      await d.getByRole('button', { name: 'Withdraw request' }).click();
      const a = alertDialog(page);
      await a.waitFor();
      await a.getByRole('button', { name: 'Withdraw request' }).click();
      await expectText(page, 'Request withdrawn');
      await a.waitFor({ state: 'hidden' });
    },
  },
  {
    // An access the centre approved is ended from the console. The request and the centre's approval
    // are made through the API (the approval belongs to the centre's own app); the revoke is driven here.
    name: 'flow-access-revoke',
    path: '/access-requests',
    as: ADMIN,
    ready: 'main h1',
    variants: ONE,
    prepare: async () => {
      const agent = await signIn({ email: AGENT, app: 'platform' });
      const centre = (await call(agent, 'GET', '/platform/tenants?q=shots-console')).data[0];
      const grant = await call(agent, 'POST', `/platform/tenants/${centre.id}/access-grants`, {
        reason: `Shots ${stamp}: approved access that the console ends again.`,
        scopes: ['request.read.all'],
        durationMinutes: 30,
      });
      const owner = await signIn({ email: 'owner@shots-console.test', app: 'centre', tenantSlug: 'shots-console' });
      await call(owner, 'POST', `/support-access/${grant.id}/approve`, { note: 'Shots: approved for the screenshot scenario.' }, 'centre');
    },
    act: async (page) => {
      const row = page.locator('main table tbody tr', { hasText: `Shots ${stamp}: approved` }).first();
      await row.waitFor();
      await row.getByText('Active').first().waitFor();
      await step(page, 'flow-access-revoke-1-active');
      await rowAction(page, `Shots ${stamp}: approved`, 'End access now');
      const a = alertDialog(page);
      await a.waitFor();
      await a.getByRole('button', { name: 'End access now' }).click();
      await expectText(page, 'Access ended');
      await a.waitFor({ state: 'hidden' });
      await row.getByText('Revoked').first().waitFor();
    },
  },
  {
    // "Enter centre": the support agent asks Al Noor for access, the owner approves it (through the API: the
    // decision belongs to the centre's own app), the agent presses Enter. The console opens the hand-off URL
    // in a new tab; the scenario checks that tab's address (code in the fragment, never in the path or query)
    // and ends the access again. The grant itself is the only change to Al Noor, and it is revoked at the end.
    name: 'flow-access-enter',
    path: '/access-requests',
    as: AGENT,
    ready: 'main h1',
    variants: ONE,
    prepare: async (context) => {
      // The staff app may not be running: its hand-off page is answered by a stub so the new tab keeps
      // its address (an unanswered tab shows Chrome's error page and loses the URL). Nothing else is intercepted.
      await context.route(/^https?:\/\/[^/]+\/support-session(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stub</title><p>support-session stub of the screenshot scenarios</p>' }));
      const agent = await signIn({ email: AGENT, app: 'platform' });
      const centre = (await call(agent, 'GET', '/platform/tenants?q=al-noor')).data.find((t) => t.slug === 'al-noor');
      const grant = await call(agent, 'POST', `/platform/tenants/${centre.id}/access-grants`, {
        reason: `Shots ${stamp}: enter-centre check of the console (revoked again by the scenario).`,
        scopes: ['service.read'],
        durationMinutes: 15,
      });
      const owner = await signIn({ email: 'owner@al-noor.test', app: 'centre', tenantSlug: 'al-noor' });
      await call(owner, 'POST', `/support-access/${grant.id}/approve`, { note: 'Shots: approved for the enter-centre check.' }, 'centre');
    },
    act: async (page) => {
      const row = page.locator('main table tbody tr', { hasText: `Shots ${stamp}: enter-centre` }).first();
      await row.waitFor();
      await row.getByText('Active').first().waitFor();
      await row.locator('td').nth(1).click();
      const d = dialog(page);
      await d.waitFor();
      await d.getByRole('button', { name: 'Enter centre' }).waitFor();
      await step(page, 'flow-access-enter-1-active');
      const [tab] = await Promise.all([page.context().waitForEvent('page'), d.getByRole('button', { name: 'Enter centre' }).click()]);
      await expectText(page, 'opened in a new tab');
      // The new tab: the staff app's hand-off page, with the one-time code in the fragment only.
      const deadline = Date.now() + 15_000;
      let url = tab.url();
      while (!/support-session/.test(url) && Date.now() < deadline) {
        await page.waitForTimeout(250);
        url = tab.url();
      }
      const parsed = new URL(url);
      if (parsed.pathname !== '/support-session') throw new Error(`the new tab is at ${parsed.origin}${parsed.pathname}, not /support-session`);
      if (!/^#code=[A-Za-z0-9_-]{43,}$/.test(parsed.hash)) throw new Error('the new tab has no one-time code in its fragment');
      if (parsed.search) throw new Error('the new tab carries a query string');
      console.log(`      [enter] new tab: ${parsed.origin}${parsed.pathname} (one-time code of ${parsed.hash.length - 6} characters in the fragment; the page itself was a stub)`);
      await tab.close();
      await d.getByRole('button', { name: 'End access now' }).click();
      const a = alertDialog(page);
      await a.waitFor();
      await a.getByRole('button', { name: 'End access now' }).click();
      await expectText(page, 'Access ended');
      await a.waitFor({ state: 'hidden' });
    },
  },
  {
    name: 'flow-flags',
    path: '/feature-flags',
    as: ADMIN,
    ready: 'main [role="tabpanel"] > *',
    variants: ONE,
    act: async (page) => {
      const key = `shots_flag_${stamp}`;
      await page.locator('main header').getByRole('button', { name: 'Add flag' }).click();
      const d = dialog(page);
      await d.waitFor();
      await d.locator('[name="key"]').fill('Not A Key!');
      await d.locator('button[type="submit"]').click();
      await d.locator('[role="alert"]').first().waitFor();
      await step(page, 'flow-flags-1-key-invalid');
      await d.locator('[name="key"]').fill(key);
      await d.locator('[name="description"]').fill('Shots: a test flag of the screenshot scenarios.');
      await d.locator('button[type="submit"]').click();
      await expectText(page, `Flag ${key} added`);
      await d.waitFor({ state: 'hidden' });

      // Switch the default on (confirmed, because it reaches every centre).
      const a = alertDialog(page);
      await page.getByRole('switch', { name: `Default of ${key}` }).click();
      await a.waitFor();
      await a.getByRole('button', { name: 'Switch on' }).click();
      await expectText(page, `${key} is on by default`);
      await a.waitFor({ state: 'hidden' });

      // One centre gets its own setting.
      await page.getByRole('button', { name: `Actions for ${key}` }).click();
      await page.getByRole('menuitem', { name: 'Centres with their own setting' }).click();
      await d.waitFor();
      await d.getByRole('combobox').first().click();
      await page.getByPlaceholder('Name, address part or email').fill('shots-console');
      await page.getByRole('option', { name: /Shots Console/ }).first().click();
      await choose(page, d.getByRole('combobox', { name: /Setting/ }), 'Off for this centre');
      await d.getByRole('button', { name: 'Apply' }).click();
      await a.waitFor();
      await a.getByRole('button', { name: 'Save changes' }).click();
      await expectText(page, `${key} changed`);
      await a.waitFor({ state: 'hidden' });
      await d.locator('ul li', { hasText: 'Shots Console' }).waitFor();
      await step(page, 'flow-flags-2-override');
      await page.keyboard.press('Escape');
      await d.waitFor({ state: 'hidden' });
      await page.locator('main table tbody tr', { hasText: key }).getByText('1 centre').first().waitFor();

      // The same flag on the centre's own page: back to the default.
      await page.goto(new URL('/tenants?q=shots-console', page.url()).href);
      await openCentre(page, /Shots Console/);
      await page.getByRole('tab', { name: 'Feature flags' }).click();
      await choose(page, page.getByRole('combobox', { name: `Setting of ${key}` }), /Follow the default/);
      await a.waitFor();
      await a.getByRole('button', { name: 'Save changes' }).click();
      await expectText(page, `${key} changed`);
      await a.waitFor({ state: 'hidden' });
      await step(page, 'flow-flags-3-centre');

      // Delete the flag: the key has to be typed.
      await page.goto(new URL('/feature-flags', page.url()).href);
      await page.getByRole('button', { name: `Actions for ${key}` }).click();
      await page.getByRole('menuitem', { name: 'Delete flag' }).click();
      await a.waitFor();
      await a.locator('input').fill(key);
      await a.getByRole('button', { name: 'Delete flag' }).click();
      await expectText(page, `Flag ${key} deleted`);
      await a.waitFor({ state: 'hidden' });
    },
  },
  {
    name: 'flow-settings',
    path: '/feature-flags?tab=settings',
    as: ADMIN,
    ready: 'main form',
    variants: ONE,
    fullPage: true,
    act: async (page) => {
      const form = page.locator('main form', { hasText: 'Shortest waiting time' });
      const a = alertDialog(page);
      await form.locator('input').fill('10');
      await form.getByRole('button', { name: 'Save changes' }).click();
      await form.locator('[role="alert"]').first().waitFor();
      await form.locator('input').fill('45');
      await form.getByRole('button', { name: 'Save changes' }).click();
      await a.waitFor();
      await a.getByRole('button', { name: 'Save changes' }).click();
      await expectText(page, 'saved');
      await a.waitFor({ state: 'hidden' });
      await form.getByRole('button', { name: 'Back to default' }).waitFor();
      await step(page, 'flow-settings-1-changed');
      await form.getByRole('button', { name: 'Back to default' }).click();
      await a.waitFor();
      await a.getByRole('button', { name: 'Back to default' }).click();
      await expectText(page, 'is back at its defaults');
      await a.waitFor({ state: 'hidden' });
      await form.getByRole('button', { name: 'Back to default' }).waitFor({ state: 'hidden' });
    },
  },
  {
    name: 'flow-staff',
    path: '/staff',
    as: ADMIN,
    ready: 'main table tbody tr td:visible',
    variants: ONE,
    act: async (page) => {
      const name = `Shots Staff ${stamp}`;
      await page.locator('main header').getByRole('button', { name: 'Invite staff' }).click();
      const d = dialog(page);
      await d.waitFor();
      await d.locator('button[type="submit"]').click();
      await d.locator('[role="alert"]').first().waitFor();
      await d.locator('[name="fullName"]').fill(name);
      await d.locator('[name="email"]').fill(`shots-staff-${stamp}@typease.test`);
      await step(page, 'flow-staff-1-invite');
      await d.locator('button[type="submit"]').click();
      await expectText(page, `${name} invited`);
      await d.waitFor({ state: 'hidden' });
      const row = page.locator('main table tbody tr', { hasText: name }).first();
      await row.getByText('Invitation pending').waitFor();

      const a = alertDialog(page);
      await rowAction(page, name, 'Change role');
      await a.waitFor();
      await step(page, 'flow-staff-2-role');
      await a.getByRole('button', { name: 'Change role' }).click();
      await expectText(page, `${name} is now Super admin`);
      await a.waitFor({ state: 'hidden' });
      await row.getByText('Super admin').waitFor();
      // ... and back, so that no test account keeps the highest role.
      await rowAction(page, name, 'Change role');
      await a.waitFor();
      await a.getByRole('button', { name: 'Change role' }).click();
      await expectText(page, `${name} is now Support agent`);
      await a.waitFor({ state: 'hidden' });

      await rowAction(page, name, 'Disable account');
      await a.waitFor();
      await a.getByRole('button', { name: 'Disable account' }).click();
      await expectText(page, `Account of ${name} disabled`);
      await a.waitFor({ state: 'hidden' });
      await row.getByText('Disabled').waitFor();
    },
  },
  {
    name: 'flow-incident',
    path: '/audit?tab=incidents',
    as: ADMIN,
    ready: 'main [role="tabpanel"] button:visible',
    variants: ONE,
    act: async (page) => {
      const title = `Shots ${stamp}: test entry of the screenshot scenarios (no real incident)`;
      await page.locator('main').getByRole('button', { name: 'Record incident' }).first().click();
      const d = dialog(page);
      await d.waitFor();
      await d.locator('button[type="submit"]').click();
      await d.locator('[role="alert"]').first().waitFor();
      await d.locator('[name="title"]').fill(title);
      await d.locator('[name="description"]').fill('Written by the screenshot scenarios of the platform console to drive the register end to end. Nothing happened.');
      await d.locator('button[type="submit"]').click();
      await expectText(page, 'Incident recorded');
      await d.waitFor({ state: 'hidden' });

      await page.locator('main table tbody tr', { hasText: `Shots ${stamp}` }).first().locator('td').first().click();
      await d.waitFor();
      const a = alertDialog(page);
      await d.getByRole('button', { name: 'Start investigating' }).click();
      await a.waitFor();
      await a.getByRole('button', { name: 'Start investigating' }).click();
      await expectText(page, 'Incident is now: Investigating');
      await a.waitFor({ state: 'hidden' });
      await d.getByRole('button', { name: 'Mark as contained' }).click();
      await a.waitFor();
      await a.locator('textarea').fill('Shots: nothing to contain, test entry.');
      await a.getByRole('button', { name: 'Mark as contained' }).click();
      await expectText(page, 'Incident is now: Contained');
      await a.waitFor({ state: 'hidden' });
      await d.getByRole('button', { name: 'Resolve' }).click();
      await a.waitFor();
      await a.getByRole('button', { name: 'Resolve' }).click();
      await a.locator('[role="alert"]').first().waitFor();
      await step(page, 'flow-incident-1-notes-required');
      await a.locator('textarea').fill('Shots: closed, it was a test entry.');
      await a.getByRole('button', { name: 'Resolve' }).click();
      await expectText(page, 'Incident is now: Resolved');
      await a.waitFor({ state: 'hidden' });
    },
  },
  {
    name: 'flow-processor',
    path: '/audit?tab=processors',
    as: ADMIN,
    ready: 'main [role="tabpanel"] button:visible',
    variants: ONE,
    act: async (page) => {
      const name = `Shots Processor ${stamp}`;
      await page.locator('main').getByRole('button', { name: 'Add processor' }).first().click();
      const d = dialog(page);
      await d.waitFor();
      await d.locator('[name="name"]').fill(name);
      await d.locator('[name="purpose"]').fill('Shots: sends test messages for the screenshot scenarios.');
      await d.getByLabel(/Data categories/).fill('names, mobile numbers');
      await step(page, 'flow-processor-1-form');
      await d.locator('button[type="submit"]').click();
      await expectText(page, `${name} added to the register`);
      await d.waitFor({ state: 'hidden' });

      const a = alertDialog(page);
      await rowAction(page, name, 'Approve');
      await a.waitFor();
      await a.getByRole('button', { name: 'Approve' }).click();
      await expectText(page, `${name} approved`);
      await a.waitFor({ state: 'hidden' });
      await page.locator('main table tbody tr', { hasText: name }).getByText('Approved').waitFor();
      await step(page, 'flow-processor-2-approved');

      await rowAction(page, name, 'Remove');
      await a.waitFor();
      await a.getByRole('button', { name: 'Remove' }).click();
      await expectText(page, `${name} removed`);
      await a.waitFor({ state: 'hidden' });
    },
  },
  {
    // Closes the centre of the flows above (the address part has to be typed), schedules its deletion
    // and cancels that again. Leaves "Shots Flow <stamp>" closed and archived.
    name: 'flow-tenant-close',
    path: '/tenants?q=shots-flow',
    as: ADMIN,
    ready: LIST,
    variants: ONE,
    fullPage: true,
    act: async (page) => {
      await openCentre(page, /Shots Flow/);
      const slug = (await page.locator('main header .ltr-value').first().innerText()).trim();
      const a = alertDialog(page);

      await lifecycle(page, 'Close and archive');
      await a.waitFor();
      await a.locator('textarea').fill('Shots: the centre stopped trading (test centre of the screenshot scenarios).');
      await a.locator('input').fill(slug);
      await step(page, 'flow-tenant-close-1-archive');
      await a.getByRole('button', { name: 'Close and archive' }).click();
      await expectText(page, 'closed and archived');
      await a.waitFor({ state: 'hidden' });

      await lifecycle(page, 'Schedule deletion');
      await a.waitFor();
      await a.locator('textarea').fill('Shots: deletion requested by the owner in writing (test).');
      await a.locator('input[type="number"]').fill('60');
      await a.locator('input:not([type="number"])').fill(slug);
      await step(page, 'flow-tenant-close-2-deletion');
      await a.getByRole('button', { name: 'Schedule deletion' }).click();
      await expectText(page, 'scheduled in 60 days');
      await a.waitFor({ state: 'hidden' });
      await page.locator('main').getByRole('button', { name: 'Cancel deletion' }).first().waitFor();
      await step(page, 'flow-tenant-close-3-scheduled');

      await page.locator('main').getByRole('button', { name: 'Cancel deletion' }).first().click();
      await a.waitFor();
      await a.locator('textarea').fill('Shots: the owner changed their mind (test).');
      await a.getByRole('button', { name: 'Cancel deletion' }).click();
      await expectText(page, 'cancelled');
      await a.waitFor({ state: 'hidden' });
    },
  },

  // ------------------------------------------------------------------ a lower-privileged role
  {
    name: 'agent-no-access',
    path: '/staff',
    as: AGENT,
    ready: 'main h1',
    variants: ONE,
    act: async (page) => {
      // The page reached by URL explains itself; nothing was requested from the API.
      await expectText(page, 'do not have');
      const nav = await page.locator('nav a').allInnerTexts();
      for (const hidden of ['Subscriptions', 'Staff', 'Feature flags', 'Integrations', 'Audit', 'System health']) {
        if (nav.some((label) => label.includes(hidden))) throw new Error(`"${hidden}" is in the navigation of a support agent`);
      }
    },
  },
];
