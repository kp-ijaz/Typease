/**
 * Screenshot scenarios of the "adm" section (organisation, white label, integrations, privacy, settings,
 * onboarding). Run from the repository root:
 *
 *   export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
 *   node packages/ui/scripts/screenshots.mjs --app centre --scenarios apps/centre-web/scripts/shots-adm.mjs --out /tmp/shots-adm [--only staff,roles]
 *
 * Scenarios whose name starts with "flow-" CHANGE data (they invite a person, create a role ...): they
 * run in one variant only and use the Gulf Star / Desert Rose demo centres, never Al Noor's seeded staff.
 * Intermediate pictures of a flow are written next to the final one as <name>-<step>.png.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = resolve(process.cwd(), process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : '/tmp/shots-adm');
mkdirSync(OUT, { recursive: true });
const AL_NOOR = 'owner@al-noor.test';
const GULF = 'owner@gulf-star.test';
const DESERT = 'owner@desert-rose.test';
const ONE = ['en-light-desktop'];
const LIST = 'main table tbody tr a:visible, main ul li a:visible';
const stamp = Date.now().toString(36).slice(-5);
const API = process.env.ADM_API_URL || 'http://localhost:4000/api/v1';
const PASSWORD = 'TypEase-Demo-2026';

/** A small API client for the steps a flow cannot do in this app (a request made in the platform console, for example). */
async function apiSession(email, app) {
  const login = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client-App': app }, body: JSON.stringify({ email, password: PASSWORD, app }) });
  const { accessToken } = await login.json();
  if (!accessToken) throw new Error(`API sign-in failed for ${email}`);
  return async (method, path, body) => {
    const reply = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${accessToken}`, 'X-Client-App': app, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const json = await reply.json().catch(() => null);
    return { status: reply.status, json };
  };
}

/** TypEase support (the platform admin of the demo) asks a centre for access; an older open request of the same person is withdrawn first. */
async function requestSupportAccess(slug, scopes, reason) {
  const platform = await apiSession('admin@typease.test', 'platform');
  const centres = await platform('GET', `/platform/tenants?pageSize=100&q=${slug}`);
  const centre = (centres.json?.data ?? []).find((c) => c.slug === slug);
  if (!centre) throw new Error(`Centre ${slug} not found`);
  const ask = () => platform('POST', `/platform/tenants/${centre.id}/access-grants`, { reason, scopes, durationMinutes: 30 });
  let made = await ask();
  if (made.status === 409) {
    const open = await platform('GET', `/platform/access-grants?centreId=${centre.id}&pageSize=50`);
    for (const g of open.json?.data ?? []) if (g.status === 'REQUESTED' || (g.status === 'APPROVED' && g.usable)) await platform('POST', `/platform/access-grants/${g.id}/revoke`);
    made = await ask();
  }
  if (made.status !== 201) throw new Error(`Access request failed: ${made.status} ${made.json?.code}`);
  return { platform, grantId: made.json.id };
}

/** Signs somebody in to the staff app in a second browser window (own cookies), for flows with two people. */
async function secondWindow(page, email) {
  const context = await page.context().browser().newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-AE', timezoneId: 'Asia/Dubai', colorScheme: 'light' });
  const origin = new URL(page.url()).origin;
  await context.addCookies([{ name: 'te_locale', value: 'en', domain: new URL(origin).hostname, path: '/' }]);
  const other = await context.newPage();
  await other.goto(`${origin}/sign-in`, { waitUntil: 'domcontentloaded' });
  await other.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 90_000 });
  await other.locator('input[type="email"]').fill(email);
  await other.locator('input[type="password"]').fill(PASSWORD);
  await other.locator('button[type="submit"]').click();
  await other.waitForURL((url) => !/sign-in/.test(url.pathname), { timeout: 60_000 });
  return { context, other };
}

/** An extra picture in the middle of a flow. */
const step = async (page, name) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: resolve(OUT, `centre-${name}.png`), animations: 'disabled' });
};
const toast = (page) => page.locator('[data-sonner-toast]').first();
const dialog = (page) => page.getByRole('dialog');
/** Picks an option of a Radix <Select> by its visible text. */
const choose = async (page, trigger, text) => {
  await trigger.click();
  await page.getByRole('option', { name: text }).first().click();
};

export default [
  // ------------------------------------------------------------------ staff
  { name: 'staff', path: '/staff', as: AL_NOOR, ready: LIST },
  { name: 'staff-workload', path: '/staff?tab=workload', as: AL_NOOR, ready: 'main table tbody tr' },
  {
    name: 'staff-detail',
    path: '/staff',
    as: AL_NOOR,
    ready: LIST,
    fullPage: true,
    act: async (page) => {
      await page.locator('main').getByRole('link', { name: /Maria Santos/ }).first().click();
      await page.waitForURL(/\/staff\/[0-9a-f-]{36}/);
      await page.locator('main input[type="time"]').first().waitFor();
    },
  },
  {
    name: 'staff-invite',
    path: '/staff',
    as: AL_NOOR,
    ready: LIST,
    act: async (page) => {
      await page.locator('main header button').first().click();
      await dialog(page).waitFor();
      await dialog(page).locator('button[type="submit"]').click();
      await dialog(page).locator('[role="alert"]').first().waitFor();
    },
  },
  {
    name: 'flow-staff-invite',
    path: '/staff',
    as: GULF,
    ready: LIST,
    variants: ONE,
    act: async (page) => {
      const email = `shots.${stamp}@gulf-star.test`;
      await page.locator('main header button').first().click();
      const d = dialog(page);
      await d.waitFor();
      await d.locator('input').nth(0).fill(`Shots Tester ${stamp}`);
      await d.locator('input[type="email"]').fill(email);
      await choose(page, d.getByRole('combobox').first(), 'Receptionist');
      await d.locator('input').nth(2).fill('Trainee receptionist');
      await step(page, 'flow-staff-invite-1-form');
      await d.locator('button[type="submit"]').click();
      await toast(page).waitFor();
      await step(page, 'flow-staff-invite-2-sent');
      await page.keyboard.press('Escape');
      await page.locator('main').getByText(email).first().waitFor();
      await step(page, 'flow-staff-invite-3-listed');
      // open the new person, edit the job title and the schedule
      await page.locator('main').getByRole('link', { name: new RegExp(`Shots Tester ${stamp}`) }).first().click();
      await page.waitForURL(/\/staff\/[0-9a-f-]{36}/);
      await page.getByRole('button', { name: /Add shift on Monday/ }).click();
      await page.getByRole('button', { name: /Add shift on Tuesday/ }).click();
      await page.getByRole('button', { name: 'Save schedule' }).click();
      await page.getByText('Work schedule saved').first().waitFor();
      await page.getByLabel(/Job title/).fill('Receptionist in training');
      await page.getByRole('button', { name: 'Save changes' }).click();
      await page.getByText('Staff member updated').first().waitFor();
      await page.locator('main input').nth(0).waitFor();
    },
    fullPage: true,
  },

  // ------------------------------------------------------------------ roles
  { name: 'roles', path: '/roles', as: AL_NOOR, ready: 'main h3', fullPage: true },
  {
    name: 'roles-editor',
    path: '/roles',
    as: AL_NOOR,
    ready: 'main h3',
    act: async (page) => {
      await page.locator('main header button').last().click();
      await dialog(page).waitFor();
      await dialog(page).locator('input[type="checkbox"], button[role="checkbox"]').first().waitFor();
    },
  },
  {
    name: 'flow-roles-create',
    path: '/roles',
    as: GULF,
    ready: 'main h3',
    variants: ONE,
    fullPage: true,
    act: async (page) => {
      await page.getByRole('button', { name: 'New role' }).first().click();
      const d = dialog(page);
      await d.waitFor();
      await d.locator('input').first().fill(`Front desk lead ${stamp}`);
      await choose(page, d.getByRole('combobox').first(), 'Receptionist');
      await d.getByPlaceholder('Search permissions').fill('refund');
      await d.getByLabel(/Request refunds/).check();
      await step(page, 'flow-roles-create-1-matrix');
      await d.locator('button[type="submit"]').click();
      await toast(page).waitFor();
      await page.locator('main').getByText(`Front desk lead ${stamp}`).first().waitFor();
    },
  },
  // ------------------------------------------------------------------ branches
  { name: 'branches', path: '/branches', as: AL_NOOR, ready: 'main h2' },
  {
    name: 'branches-edit',
    path: '/branches',
    as: AL_NOOR,
    ready: 'main h2',
    fullPage: true,
    act: async (page) => {
      await page.locator('main').getByRole('button', { name: /Edit|تعديل/ }).first().click();
      await dialog(page).waitFor();
      await dialog(page).locator('input[type="time"]').first().waitFor();
    },
  },
  {
    name: 'flow-branches-add',
    path: '/branches',
    as: GULF,
    ready: 'main h2',
    variants: ONE,
    act: async (page) => {
      await page.getByRole('button', { name: 'Add branch' }).first().click();
      const d = dialog(page);
      await d.waitFor();
      await d.locator('input').nth(0).fill(`Marina desk ${stamp}`);
      await d.locator('input').nth(1).fill('مكتب المارينا');
      await d.locator('input').nth(2).fill(`M${stamp}`.toUpperCase().slice(0, 6));
      await step(page, 'flow-branches-add-1-form');
      await d.locator('button[type="submit"]').click();
      await toast(page).waitFor();
      await page.locator('main').getByText(`Marina desk ${stamp}`).first().waitFor();
    },
  },
  {
    name: 'flow-branches-limit',
    path: '/branches',
    as: DESERT,
    ready: 'main h2',
    variants: ['en-light-desktop', 'ar-dark-desktop'],
    act: async (page) => {
      await page.locator('main header button').first().click();
      const d = dialog(page);
      await d.waitFor();
      await d.locator('input').nth(0).fill('Second branch');
      await d.locator('input').nth(2).fill('SEC');
      await d.locator('button[type="submit"]').click();
      await d.locator('[role="alert"]').first().waitFor();
      await d.locator('[role="alert"]').first().scrollIntoViewIfNeeded();
    },
  },

  // ------------------------------------------------------------------ settings
  { name: 'settings', path: '/settings', as: AL_NOOR, ready: 'main form input', fullPage: true },
  { name: 'settings-preferences', path: '/settings?tab=preferences', as: AL_NOOR, ready: 'main form input', fullPage: true },
  { name: 'settings-support', path: '/settings?tab=support', as: GULF, ready: 'main h2', fullPage: true },
  { name: 'settings-plan', path: '/settings?tab=plan', as: AL_NOOR, ready: 'main [role="progressbar"]' },
  {
    name: 'flow-settings-ai-limit',
    path: '/settings?tab=preferences',
    as: DESERT,
    ready: 'main form input',
    variants: ONE,
    fullPage: true,
    act: async (page) => {
      await page.getByRole('switch', { name: /AI document assistant/ }).click();
      await page.locator('main [role="alert"]').first().waitFor();
    },
  },
  {
    name: 'flow-settings-profile-save',
    path: '/settings',
    as: GULF,
    ready: 'main form input',
    variants: ONE,
    act: async (page) => {
      const licence = page.getByLabel('Trade licence number');
      const before = await licence.inputValue();
      await licence.fill(`${before.replace(/-S\d+$/, '')}-S${Date.now() % 1000}`);
      await page.getByRole('button', { name: 'Save changes' }).click();
      await toast(page).waitFor();
      await licence.fill(before);
      await page.getByRole('button', { name: 'Save changes' }).click();
      await page.waitForTimeout(1200);
    },
  },

  // ------------------------------------------------------------------ branding
  { name: 'branding', path: '/branding', as: AL_NOOR, ready: 'main [data-preview="dark"]', fullPage: true },
  { name: 'branding-typease', path: '/branding', as: GULF, ready: 'main [data-preview="dark"]', fullPage: true, variants: ['en-light-desktop', 'en-light-mobile'] },
  {
    name: 'flow-branding-upgrade',
    path: '/branding',
    as: GULF,
    ready: 'main [data-preview="dark"]',
    variants: ONE,
    act: async (page) => {
      await page.getByRole('radio', { name: /White label/ }).click();
      await page.getByRole('button', { name: 'Save branding' }).click();
      await page.locator('main [role="alert"]').first().waitFor();
    },
  },

  // ------------------------------------------------------------------ domains
  { name: 'domains', path: '/domains', as: AL_NOOR, ready: 'main code', fullPage: true },
  { name: 'domains-not-included', path: '/domains', as: DESERT, ready: 'main h2', variants: ONE },

  // ------------------------------------------------------------------ integrations
  { name: 'integrations', path: '/integrations', as: AL_NOOR, ready: 'main h3', fullPage: true },
  { name: 'integrations-logs', path: '/integrations?tab=logs', as: GULF, ready: 'main table tbody tr:visible, main section ul li:visible' },
  {
    name: 'integrations-record',
    path: '/integrations',
    as: AL_NOOR,
    ready: 'main h3',
    act: async (page) => {
      await page.locator('main section').filter({ has: page.locator('#cat-PARTNER') }).getByRole('button').first().click();
      await dialog(page).waitFor();
    },
  },

  // ------------------------------------------------------------------ privacy
  { name: 'privacy', path: '/privacy', as: AL_NOOR, ready: 'main table tbody tr', fullPage: true },
  { name: 'privacy-requests', path: '/privacy?tab=requests', as: AL_NOOR, ready: LIST },
  {
    name: 'privacy-request-blocked',
    path: '/privacy?tab=requests&type=DELETION',
    as: AL_NOOR,
    ready: LIST,
    act: async (page) => {
      await page.locator('main').getByRole('link', { name: /Daniel Okafor/ }).first().click();
      await dialog(page).waitFor();
      await dialog(page).locator('dl').first().waitFor();
      // What an erasure does, keeps and cannot reach (wording follows docs/api/modules/privacy.md).
      await dialog(page).locator('details summary').click();
      await dialog(page).locator('details ul').last().scrollIntoViewIfNeeded();
    },
  },
  {
    // A deletion that was carried out (flow-privacy-erasure makes one on Gulf Star).
    name: 'privacy-request-erased',
    path: '/privacy?tab=requests&type=DELETION&status=COMPLETED',
    as: GULF,
    ready: LIST,
    variants: ['en-light-desktop', 'ar-dark-desktop'],
    act: async (page) => {
      await page.locator('main').locator('table tbody tr a:visible, ul li a:visible').first().click();
      await dialog(page).waitFor();
      await dialog(page).locator('dl').first().waitFor();
    },
  },
  { name: 'privacy-retention', path: '/privacy?tab=retention', as: AL_NOOR, ready: 'main [data-policy]:visible', fullPage: true },
  { name: 'privacy-consents', path: '/privacy?tab=consents', as: AL_NOOR, ready: LIST },
  { name: 'privacy-incidents', path: '/privacy?tab=incidents', as: GULF, ready: LIST },
  { name: 'privacy-processors', path: '/privacy?tab=processors', as: AL_NOOR, ready: 'main [role="tabpanel"] p' },

  // ------------------------------------------------------------------ onboarding (a finished centre shows the end state)
  { name: 'onboarding-done', path: '/onboarding', as: AL_NOOR, ready: 'main h2', variants: ['en-light-desktop', 'ar-dark-desktop'] },
  // A centre that is still being set up (created by flow-onboarding and left at the business step). Skipped when it does not exist.
  { name: 'onboarding-business', path: '/onboarding?step=business', as: process.env.ADM_ONBOARDING_EMAIL || 'owner@shots-bzna0.test', ready: 'main form', fullPage: true },
  { name: 'onboarding-plan', path: '/onboarding?step=plan', as: process.env.ADM_ONBOARDING_EMAIL || 'owner@shots-bzna0.test', ready: 'main [role="radio"], main button[aria-pressed]', fullPage: true },
  {
    // The role overview as it prints (A4 landscape): the print style sheet is applied before the picture.
    name: 'roles-print',
    path: '/roles',
    as: AL_NOOR,
    ready: 'main h3',
    variants: ONE,
    fullPage: true,
    act: async (page) => {
      await page.emulateMedia({ media: 'print' });
      await page.waitForTimeout(400);
    },
  },

  // ------------------------------------------------------------------ support session landing (signed out)
  { name: 'support-session-no-code', path: '/support-session', ready: '[data-step="noCode"] h1' },
  // A code nobody issued: the API answers 400 HANDOFF_INVALID (the console error of that answer is expected).
  { name: 'support-session-invalid', path: `/support-session#code=${'not-a-real-code-'.repeat(3)}`, ready: '[data-step="refused"] h1' },
  {
    // The demo data has no verified domain (verification needs real DNS), so the answer of GET /domains is
    // changed on the way to the page: one domain verified but suspended by the plan, one claim past its 72 hours.
    name: 'domains-suspended',
    path: '/domains',
    as: AL_NOOR,
    ready: 'main [data-claim]',
    fullPage: true,
    prepare: async (context) => {
      await context.route('**/api/v1/domains', async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const reply = await route.fetch();
        const body = await reply.json();
        const base = body.domains[0];
        if (!base) return route.fulfill({ response: reply });
        const hours = (n) => new Date(Date.now() + n * 3_600_000).toISOString();
        body.customDomainsIncluded = false;
        body.domains = [
          { ...base, id: `${base.id}-s`, domain: 'portal.alnoor-typing.test', status: 'SUSPENDED_BY_PLAN', verifiedAt: hours(-24 * 40), isPrimary: true, routed: false, claim: null, dns: null },
          { ...base, id: `${base.id}-p`, domain: 'requests.alnoor-typing.test', status: 'FAILED', lastCheckedAt: hours(-2), lastCheckError: 'The TXT record _typease-verify.requests.alnoor-typing.test was not found.', claim: { releasableAt: hours(-6), expiresAt: hours(24 * 11) } },
          { ...base, id: `${base.id}-n`, domain: 'new.alnoor-typing.test', claim: { releasableAt: hours(70), expiresAt: hours(24 * 14) } },
        ];
        return route.fulfill({ response: reply, json: body });
      });
    },
  },

  // ------------------------------------------------------------------ flows that change data
  {
    // Al Noor (white label): change the colours and the tagline, watch the live preview, save, then put everything back.
    name: 'flow-branding-change-restore',
    path: '/branding',
    as: AL_NOOR,
    ready: 'main [data-preview="dark"]',
    variants: ONE,
    act: async (page) => {
      const primary = page.getByLabel('Primary colour', { exact: true });
      const accent = page.getByLabel('Accent colour', { exact: true });
      const tagline = page.getByLabel('Tagline', { exact: true });
      const before = { primary: await primary.inputValue(), accent: await accent.inputValue(), tagline: await tagline.inputValue() };
      await primary.fill('#7A1F5C');
      await accent.fill('#FFE45C');
      await tagline.fill('Preview test tagline');
      await page.locator('[data-preview="light"]').scrollIntoViewIfNeeded();
      await step(page, 'flow-branding-change-1-preview');
      await page.getByRole('button', { name: 'Save branding' }).click();
      await page.getByText('Branding saved').first().waitFor();
      await page.waitForTimeout(1500);
      await step(page, 'flow-branding-change-2-saved');
      // restore
      await primary.fill(before.primary);
      await accent.fill(before.accent);
      await tagline.fill(before.tagline);
      await page.getByRole('button', { name: 'Save branding' }).click();
      await page.waitForTimeout(2500);
    },
  },
  {
    name: 'flow-branding-logo-validation',
    path: '/branding',
    as: AL_NOOR,
    ready: 'main [data-preview="dark"]',
    variants: ONE,
    act: async (page) => {
      await page.locator('input[type="file"][data-asset="favicon"]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') });
      await page.locator('main [role="alert"]').first().waitFor();
      await page.locator('main [role="alert"]').first().scrollIntoViewIfNeeded();
    },
  },
  {
    name: 'flow-domains-add-verify',
    path: '/domains',
    as: AL_NOOR,
    ready: 'main code',
    variants: ONE,
    fullPage: true,
    act: async (page) => {
      const domain = `shots-${stamp}.alnoor-typing.test`;
      await page.getByRole('button', { name: 'Add domain' }).first().click();
      const d = dialog(page);
      await d.waitFor();
      await d.locator('input').first().fill(`https://${domain}/portal`);
      await step(page, 'flow-domains-1-add');
      await d.locator('button[type="submit"]').click();
      await toast(page).waitFor();
      const card = page.locator('main section > div').filter({ hasText: domain }).first();
      await card.waitFor();
      await card.getByRole('button', { name: 'Verify' }).click();
      await card.getByText('Not verified yet').waitFor();
      await card.scrollIntoViewIfNeeded();
      await step(page, 'flow-domains-2-verify-failed');
      // ---- the same domain a second time, and a TypEase address: the API's refusal lands on the field
      await page.getByRole('button', { name: 'Add domain' }).first().click();
      await d.waitFor();
      await d.locator('input').first().fill(domain);
      await d.locator('button[type="submit"]').click();
      await d.getByText('This domain is already on your list.').waitFor();
      await step(page, 'flow-domains-3-already-added');
      await d.locator('input').first().fill('anything.typease.localhost');
      await d.locator('button[type="submit"]').click();
      await d.getByText('Use a domain that you own.', { exact: false }).waitFor();
      await d.getByRole('button', { name: 'Cancel' }).click();
      await d.waitFor({ state: 'hidden' });
      await card.getByRole('button', { name: 'Remove' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
      await page.getByText('Domain removed').first().waitFor();
    },
  },
  {
    name: 'flow-integrations-smtp',
    path: '/integrations',
    as: GULF,
    ready: 'main h3',
    variants: ONE,
    act: async (page) => {
      const card = page.locator('main section').filter({ has: page.locator('#cat-EMAIL') });
      await card.getByRole('button', { name: /Set up|Manage/ }).first().click();
      const d = dialog(page);
      await d.waitFor();
      if (await d.getByRole('button', { name: 'Save and add' }).count()) {
        await d.getByLabel('Server', { exact: false }).first().fill('smtp.example.invalid');
        await d.getByLabel('Port', { exact: true }).fill('587');
        await d.getByLabel('Sender address', { exact: true }).fill('hello@gulf-star.test');
        await d.getByLabel('User name', { exact: true }).fill('mailer');
        await d.getByLabel('Password', { exact: true }).fill('not-a-real-password');
        await step(page, 'flow-integrations-smtp-1-form');
        await d.getByRole('button', { name: 'Save and add' }).click();
        await page.getByText('Integration added').first().waitFor();
      }
      await d.getByRole('button', { name: 'Test connection' }).scrollIntoViewIfNeeded();
      await d.getByRole('button', { name: 'Test connection' }).click();
      await d.getByText(/The test (failed|succeeded)\./).waitFor({ timeout: 60000 });
      await d.getByText(/The test (failed|succeeded)\./).scrollIntoViewIfNeeded();
      await step(page, 'flow-integrations-smtp-2-tested');
      // ---- switch on, then off again (the API decides whether an untested connection may be switched on)
      if (await d.getByRole('button', { name: 'Switch on' }).isEnabled()) {
        await d.getByRole('button', { name: 'Switch on' }).click();
        const on = await Promise.race([page.getByText('Integration switched on').first().waitFor().then(() => true), d.locator('[role="alert"]').filter({ hasText: /./ }).last().waitFor().then(() => false)]);
        await step(page, 'flow-integrations-smtp-3-switched-on');
        if (on) {
          await d.getByRole('button', { name: 'Switch off' }).click();
          await page.getByText('Integration switched off').first().waitFor();
        }
      }
      await d.getByRole('button', { name: 'Delete' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
      await page.getByText('Integration deleted').first().waitFor();
      await page.goto(page.url().split('?')[0] + '?tab=logs');
      await page.locator('main table tbody tr').first().waitFor();
    },
  },
  {
    name: 'flow-integrations-government-record',
    path: '/integrations',
    as: GULF,
    ready: 'main h3',
    variants: ONE,
    act: async (page) => {
      const card = page.locator('main section').filter({ has: page.locator('#cat-GOVERNMENT') });
      await card.getByRole('button', { name: 'Add a record' }).click();
      const d = dialog(page);
      await d.waitFor();
      await d.getByLabel('Authority').fill(`Sample Authority ${stamp} (fictional)`);
      await d.getByLabel('Authorisation / licence reference').fill('SAMPLE-LIC-0001');
      await d.getByLabel('Who holds the portal credentials').fill('password: hunter2');
      await d.getByLabel('What the authorisation consists of').fill('Fictional licence for the screenshots; it stands for the accreditation letter of the centre.');
      await d.getByRole('button', { name: 'Submit for review' }).click();
      await d.getByText(/looks like a password/).waitFor();
      await d.getByText(/looks like a password/).scrollIntoViewIfNeeded();
      await step(page, 'flow-integrations-record-1-refused');
      await d.getByLabel('Who holds the portal credentials').fill('Shaima Al Ali, centre owner');
      await d.getByRole('button', { name: 'Submit for review' }).click();
      await page.getByText('Record submitted for review').first().waitFor();
      await d.locator('h2').scrollIntoViewIfNeeded();
      await step(page, 'flow-integrations-record-2-pending');
      await d.getByRole('button', { name: 'Delete' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
      await page.getByText('Integration deleted').first().waitFor();
    },
  },
  {
    // The request is made first, as the platform admin of the demo, through the API (docs/api/modules/platform.md).
    name: 'flow-support-access',
    path: '/settings?tab=support',
    as: GULF,
    ready: 'main h2',
    variants: ONE,
    fullPage: true,
    act: async (page) => {
      await requestSupportAccess('gulf-star', ['customer.read', 'request.read.all', 'document.read'], 'Screenshot run: checking why a document preview fails for one customer. (fictional)');
      await page.reload();
      const card = page.locator('main li').filter({ hasText: 'Platform Admin (demo) asks for access' }).first();
      await card.waitFor();
      await card.getByRole('button', { name: /Approve/ }).click();
      const d = dialog(page);
      await d.waitFor();
      await d.getByLabel(/View and download documents/).uncheck();
      await choose(page, d.getByRole('combobox').first(), '30 minutes');
      await d.locator('textarea').fill('Customer list only, half an hour is enough.');
      await step(page, 'flow-support-access-1-approve');
      await d.getByRole('button', { name: 'Approve access' }).click();
      await page.getByText('Access approved').first().waitFor();
      await page.getByText('Platform Admin (demo) has access', { exact: true }).waitFor();
      await step(page, 'flow-support-access-2-active');
      await page.getByRole('button', { name: 'Revoke now' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke now' }).click();
      await page.getByText('Access revoked').first().waitFor();
      await page.getByText('Nobody from TypEase has access').waitFor();
    },
  },
  {
    // The request is made first through the API. The seeded request of the support agent stays untouched.
    name: 'flow-support-access-deny',
    path: '/settings?tab=support',
    as: GULF,
    ready: 'main h2',
    variants: ONE,
    fullPage: true,
    act: async (page) => {
      await requestSupportAccess('gulf-star', ['customer.read', 'invoice.read'], 'Screenshot run: check a receipt layout. (fictional)');
      await page.reload();
      const card = page.locator('main li').filter({ hasText: 'Platform Admin (demo) asks for access' }).first();
      await card.waitFor();
      await card.getByRole('button', { name: 'Deny' }).click();
      const d = dialog(page);
      await d.waitFor();
      await d.locator('textarea').fill('Not needed: the receipt question is already solved. (test)');
      await step(page, 'flow-support-access-deny-1-dialog');
      await d.getByRole('button', { name: 'Deny' }).click();
      await page.getByText('Access denied').first().waitFor();
      await d.waitFor({ state: 'hidden' });
    },
  },
  {
    // Al Noor: the upload path, with the logo the centre already has (the same picture is uploaded again, so nothing changes for the centre).
    name: 'flow-branding-logo-upload',
    path: '/branding',
    as: AL_NOOR,
    ready: 'main [data-preview="dark"]',
    variants: ONE,
    act: async (page) => {
      const src = await page.locator('main img[alt="Current logo"]').first().getAttribute('src');
      const reply = await page.request.get(src);
      const buffer = await reply.body();
      await page.locator('input[type="file"][data-asset="logo"]').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer });
      await page.getByText('Logo saved').first().waitFor();
      await page.waitForFunction((old) => document.querySelector('main img[alt="Current logo"]')?.getAttribute('src') !== old, src);
    },
  },
  {
    // Gulf Star needs two active branches for this card (flow-branches-add creates the second one).
    name: 'flow-branding-branch',
    path: '/branding',
    as: GULF,
    ready: 'main [data-preview="dark"]',
    variants: ONE,
    act: async (page) => {
      const item = page.locator('main li').filter({ hasText: /Same as the centre|Has its own details/ }).first();
      if (!(await item.count())) return;
      await item.scrollIntoViewIfNeeded();
      await item.getByRole('button', { name: 'Edit' }).click();
      const d = dialog(page);
      await d.waitFor();
      await d.getByLabel('Receipt footer').fill('Thank you for visiting our Musaffah office. (test)');
      await step(page, 'flow-branding-branch-1-dialog');
      await d.locator('button[type="submit"]').click();
      await page.getByText('Branch branding saved').first().waitFor();
      await d.waitFor({ state: 'hidden' });
      await page.locator('main li').filter({ hasText: 'Has its own details' }).first().waitFor();
      await step(page, 'flow-branding-branch-2-own-details');
      // ---- and back: an empty field follows the centre again
      await page.locator('main li').filter({ hasText: 'Has its own details' }).first().getByRole('button', { name: 'Edit' }).click();
      await d.waitFor();
      await d.getByLabel('Receipt footer').fill('');
      await d.locator('button[type="submit"]').click();
      await page.getByText('Branch branding saved').first().waitFor();
      await d.waitFor({ state: 'hidden' });
    },
  },
  {
    // The whole road of a support session: TypEase support asks (platform API), the owner of Al Noor approves on the
    // settings tab, support enters (platform API) and arrives on /support-session with the one-time code, looks
    // around, and the owner revokes. Leaves a revoked grant in Al Noor's history and nothing else.
    name: 'flow-support-session',
    path: '/settings?tab=support',
    as: AL_NOOR,
    ready: 'main h2',
    variants: ONE,
    act: async (page) => {
      const origin = new URL(page.url()).origin;
      const { platform, grantId } = await requestSupportAccess('al-noor', ['customer.read', 'invoice.read', 'request.read.all', 'request.comment.internal', 'staff.read', 'branch.read'], 'Screenshot run: follow a request that looks stuck and leave a note for the team. (fictional)');
      // ---- the owner: the request waits on the tab the notification links to
      await page.goto(`${origin}/settings?tab=support&grant=${grantId}`);
      const card = page.locator(`main li[data-grant="${grantId}"]`);
      await card.waitFor();
      await card.getByText('Can add internal notes').waitFor();
      await step(page, 'flow-support-session-1-request');
      await card.getByRole('button', { name: /Approve/ }).click();
      const d = dialog(page);
      await d.waitFor();
      await step(page, 'flow-support-session-2-approve');
      await d.getByRole('button', { name: 'Approve access' }).click();
      await page.getByText('Access approved').first().waitFor();
      await page.getByText('Platform Admin (demo) has access', { exact: true }).waitFor();
      // ---- TypEase support enters: the console gets a one-time code and opens the staff app with it in the URL fragment
      const entered = await platform('POST', `/platform/access-grants/${grantId}/enter`);
      if (entered.status >= 300) throw new Error(`enter failed: ${entered.status} ${entered.json?.code}`);
      const handoff = new URL(entered.json.handoff.url);
      // The owner is signed in on this browser: the page says so and waits for one click.
      await page.goto(`${origin}/support-session${handoff.hash}`);
      await page.locator('[data-step="confirm"] h1').waitFor();
      if (page.url().includes('#') || page.url().includes('code=')) throw new Error('the code is still in the address bar');
      await step(page, 'flow-support-session-3-landing-confirm');
      await page.getByRole('button', { name: 'Continue as TypEase support' }).click();
      const banner = page.locator('[data-slot="support-session-banner"]');
      await banner.waitFor({ timeout: 60_000 });
      await page.waitForTimeout(1500);
      await step(page, 'flow-support-session-4-entered');
      // ---- pages the grant covers, and pages it does not
      await page.goto(`${origin}/customers`);
      await banner.waitFor();
      await page.locator(LIST).first().waitFor();
      await step(page, 'flow-support-session-5-customers');
      await page.goto(`${origin}/staff`);
      await banner.waitFor();
      await page.locator(LIST).first().waitFor();
      await page.waitForTimeout(800);
      await step(page, 'flow-support-session-6-staff-read-only');
      await page.goto(`${origin}/branches`);
      await banner.waitFor();
      await page.locator('main h2').first().waitFor();
      await page.waitForTimeout(800);
      await step(page, 'flow-support-session-7-branches-read-only');
      await page.goto(`${origin}/staff`);
      await page.locator('main').getByRole('link', { name: /Maria Santos/ }).first().click();
      await page.waitForURL(/\/staff\/[0-9a-f-]{36}/);
      await page.locator('main input[type="time"]').first().waitFor();
      await page.waitForTimeout(800);
      await page.screenshot({ path: resolve(OUT, 'centre-flow-support-session-7b-staff-detail-read-only.png'), animations: 'disabled', fullPage: true });
      await page.goto(`${origin}/roles`);
      await banner.waitFor();
      await page.locator('main h3').first().waitFor();
      await page.waitForTimeout(800);
      await step(page, 'flow-support-session-7c-roles-read-only');
      await page.goto(`${origin}/settings?tab=support`);
      await banner.waitFor();
      await page.locator('main h1, main h2').first().waitFor();
      await page.waitForTimeout(800);
      await step(page, 'flow-support-session-8-settings-no-access');
      await page.goto(`${origin}/integrations`);
      await banner.waitFor();
      await page.locator('main h1, main h2').first().waitFor();
      await page.waitForTimeout(800);
      await step(page, 'flow-support-session-9-integrations-no-access');
      // The used code does not work a second time (a new tab of the same browser: the support session is still running).
      await page.goto(`${origin}/support-session${handoff.hash}`);
      await page.locator('[data-step="refused"] h1').waitFor();
      await step(page, 'flow-support-session-10-code-used');
      await page.getByRole('link', { name: 'Back to the running support session' }).click();
      await banner.waitFor();
      // ---- the owner (another browser) looks at what was done, then ends the access
      const { context, other } = await secondWindow(page, AL_NOOR);
      try {
        await other.goto(`${origin}/settings?tab=support`);
        await other.getByText('Platform Admin (demo) has access', { exact: true }).waitFor();
        await other.screenshot({ path: resolve(OUT, 'centre-flow-support-session-11-owner-running.png'), animations: 'disabled' });
        await other.getByRole('link', { name: 'See what was done in the audit log' }).click();
        await other.waitForURL(/\/audit-log/);
        await other.locator('main table tbody tr').first().waitFor();
        await other.waitForTimeout(800);
        await other.screenshot({ path: resolve(OUT, 'centre-flow-support-session-12-owner-audit.png'), animations: 'disabled' });
        await other.goto(`${origin}/settings?tab=support`);
        await other.getByRole('button', { name: 'Revoke now' }).click();
        await other.getByRole('alertdialog').getByRole('button', { name: 'Revoke now' }).click();
        await other.getByText('Access revoked').first().waitFor();
      } finally {
        await context.close();
      }
      // ---- the support tab stays open: its very next call is refused and the app says the session is over
      await page.getByRole('link', { name: 'Customers' }).first().click();
      await page.locator('[data-slot="support-session-ended"]').waitFor({ timeout: 60_000 });
    },
  },
  {
    // Erasing while a request is open: the API refuses (409 ERASURE_BLOCKED, nothing is deleted) and names what
    // stands in the way. The flow stops before the confirmation if the API says the erasure could go ahead.
    name: 'flow-privacy-erasure-blocked',
    path: '/privacy?tab=requests&type=DELETION&status=APPROVED',
    as: AL_NOOR,
    ready: LIST,
    variants: ['en-light-desktop', 'ar-dark-desktop', 'en-light-mobile'],
    act: async (page) => {
      const owner = await apiSession(AL_NOOR, 'centre');
      const list = await owner('GET', '/privacy/requests?type=DELETION&status=APPROVED&pageSize=20');
      const target = (list.json?.data ?? []).find((r) => r.customer?.customerNo === 'CUS-000026');
      if (!target) throw new Error('the approved deletion request of CUS-000026 is gone');
      const detail = await owner('GET', `/privacy/requests/${target.id}`);
      if (detail.json?.erasureImpact?.canProceed !== false) throw new Error('this erasure is no longer blocked: not touching it');
      await page.locator('main').getByRole('link', { name: /Daniel Okafor/ }).first().click();
      const d = dialog(page);
      await d.waitFor();
      await d.locator('dl').first().waitFor();
      await d.locator('button', { hasText: /Erase the data|محو البيانات/ }).click();
      const confirm = page.getByRole('alertdialog');
      await confirm.waitFor();
      await confirm.locator('input').fill('CUS-000026');
      await confirm.locator('button').last().click();
      await confirm.waitFor({ state: 'hidden' });
      const blocked = d.locator('[data-erasure-blocked]');
      await blocked.locator('a[href^="/requests/"]').first().waitFor();
      await blocked.scrollIntoViewIfNeeded();
    },
  },
  {
    // A whole erasure, on a customer made for this purpose (Gulf Star): recorded, reviewed, approved, erased with the
    // typed confirmation. Leaves an anonymised customer record and a completed deletion request.
    name: 'flow-privacy-erasure',
    path: '/privacy?tab=requests',
    as: GULF,
    ready: 'main [role="tabpanel"] p',
    variants: ONE,
    act: async (page) => {
      const owner = await apiSession(GULF, 'centre');
      const found = await owner('GET', '/customers?q=Erasure%20Test&pageSize=20');
      let customer = (found.json?.data ?? []).find((c) => c.status === 'ACTIVE' && /^Erasure Test/.test(c.fullName));
      if (!customer) {
        const digits = String(Date.now()).slice(-7);
        const made = await owner('POST', '/customers', { fullName: `Erasure Test ${stamp} (fictional)`, phone: `+97158${digits}`, email: `erasure.test.${stamp}@example.test`, preferredLanguage: 'en' });
        if (made.status !== 201) throw new Error(`could not create the test customer: ${made.status} ${made.json?.code}`);
        customer = made.json;
      }
      await page.getByRole('button', { name: 'Record a request' }).first().click();
      const d = dialog(page);
      await d.waitFor();
      await d.getByRole('combobox').first().click();
      await page.getByPlaceholder(/search/i).last().fill(customer.fullName.slice(0, 16));
      await page.getByRole('option', { name: new RegExp(customer.customerNo) }).first().click();
      await choose(page, d.getByRole('combobox').nth(1), 'Deletion');
      await d.locator('textarea').fill('Asked at the counter to have all data deleted. (test)');
      await d.locator('button[type="submit"]').click();
      await page.getByText('Request recorded').first().waitFor();
      await page.locator('main').getByRole('link', { name: new RegExp(customer.customerNo) }).first().click();
      await d.waitFor();
      await d.getByRole('button', { name: 'Start review' }).click();
      await page.getByText('Review started').first().waitFor();
      await d.locator('textarea').fill('Identity checked at the counter; nothing open for this customer.');
      await d.getByRole('button', { name: 'Approve' }).click();
      await page.getByText('Request approved').first().waitFor();
      await d.getByText('Nothing blocks the erasure.', { exact: false }).scrollIntoViewIfNeeded();
      await step(page, 'flow-privacy-erasure-1-approved');
      await d.getByRole('button', { name: 'Erase the data' }).click();
      const confirm = page.getByRole('alertdialog');
      await confirm.waitFor();
      await confirm.locator('input').fill(customer.customerNo);
      await step(page, 'flow-privacy-erasure-2-confirm');
      await confirm.getByRole('button', { name: 'Erase the data' }).click();
      await page.getByText('Request completed').first().waitFor();
      await confirm.waitFor({ state: 'hidden' });
      await d.getByText('Completed', { exact: true }).first().waitFor();
      await page.waitForTimeout(800);
    },
  },
  {
    name: 'flow-privacy-incident',
    path: '/privacy?tab=incidents',
    as: GULF,
    ready: 'main [role="tabpanel"] p',
    variants: ONE,
    act: async (page) => {
      const title = `Receipt emailed to the wrong address ${stamp}`;
      await page.getByRole('button', { name: 'Record an incident' }).first().click();
      const d = dialog(page);
      await d.waitFor();
      await d.getByLabel('What happened').fill(title);
      await d.getByLabel('Description').fill('A receipt PDF was emailed to a customer with a similar name. Noticed by the receptionist the same hour. (fictional test entry)');
      await choose(page, d.getByRole('combobox').first(), 'High');
      await d.getByRole('switch').click();
      await d.locator('button[type="submit"]').click();
      await page.getByText('Incident recorded').first().waitFor();
      await page.locator('main').getByRole('link', { name: title }).first().click();
      await d.waitFor();
      await d.getByRole('button', { name: 'Start investigating' }).click();
      await d.getByRole('button', { name: 'Mark as contained' }).waitFor();
      await d.getByRole('button', { name: 'Mark as contained' }).click();
      await d.getByRole('button', { name: 'Resolve' }).waitFor();
      // resolving without the required facts is refused by the API: its message is shown
      await d.getByRole('button', { name: 'Resolve' }).click();
      await d.locator('[role="alert"]').first().waitFor();
      await d.locator('[role="alert"]').first().scrollIntoViewIfNeeded();
      await step(page, 'flow-privacy-incident-1-refused');
      await choose(page, d.getByRole('combobox').first(), 'No, notification is not required');
      await d.getByLabel('How it was resolved').fill('The recipient confirmed deletion. Staff were reminded to check the address before sending.');
      await d.getByRole('button', { name: 'Resolve' }).click();
      await d.getByRole('button', { name: 'Reopen' }).waitFor();
      await d.locator('h2').scrollIntoViewIfNeeded();
    },
  },
  {
    name: 'flow-privacy-vendor',
    path: '/privacy?tab=processors',
    as: GULF,
    ready: 'main [role="tabpanel"] p',
    variants: ONE,
    act: async (page) => {
      const name = `Sample SMS Relay ${stamp} (fictional)`;
      await page.getByRole('button', { name: 'Add vendor' }).first().click();
      const d = dialog(page);
      await d.waitFor();
      await d.locator('input').first().fill(name);
      await d.getByLabel('What they do with the data').fill('Sends our SMS reminders.');
      await d.getByLabel('Data they receive').fill('names, mobile numbers');
      await d.getByRole('combobox').first().click();
      await page.getByPlaceholder(/Type to search/).fill('Ireland');
      await page.getByRole('option', { name: 'Ireland' }).first().click();
      await step(page, 'flow-privacy-vendor-1-form');
      await d.locator('button[type="submit"]').click();
      await page.getByText('Vendor added').first().waitFor();
      const row = page.locator('main tbody tr').filter({ hasText: name }).first();
      await row.getByRole('button').last().click();
      await page.getByRole('menuitem', { name: /Review/ }).click();
      await d.waitFor();
      await d.locator('textarea').fill('');
      await d.getByRole('button', { name: 'Save review' }).click();
      await d.locator('[role="alert"]').first().waitFor();
      await step(page, 'flow-privacy-vendor-2-safeguards-required');
      await d.locator('textarea').fill('Data processing agreement with standard clauses; data encrypted in transit and at rest.');
      await d.getByRole('button', { name: 'Save review' }).click();
      await page.getByText('Vendor approved').first().waitFor();
    },
  },
  {
    name: 'flow-privacy-request',
    path: '/privacy?tab=requests',
    as: GULF,
    ready: 'main [role="tabpanel"] p',
    variants: ONE,
    act: async (page) => {
      await page.getByRole('button', { name: 'Record a request' }).first().click();
      const d = dialog(page);
      await d.waitFor();
      await d.getByRole('combobox').first().click();
      await page.getByRole('option').first().waitFor();
      await page.getByRole('option').first().click();
      await choose(page, d.getByRole('combobox').nth(1), 'Data copy');
      await d.locator('textarea').fill('Asked at the counter for a copy of the data. (test)');
      await d.locator('button[type="submit"]').click();
      const done = await Promise.race([page.getByText('Request recorded').first().waitFor().then(() => true), d.locator('[role="alert"]').first().waitFor().then(() => false)]);
      if (!done) return; // an open request of this type already exists for this customer: the API's message is on screen
      await page.locator('main tbody tr a, main ul li a').first().click();
      await d.waitFor();
      await d.getByRole('button', { name: 'Start review' }).click();
      await page.getByText('Review started').first().waitFor();
      await d.locator('textarea').fill('Identity checked against the Emirates ID at the counter.');
      await d.getByRole('button', { name: 'Approve' }).click();
      await page.getByText('Request approved').first().waitFor();
      await step(page, 'flow-privacy-request-1-approved');
      await d.getByRole('button', { name: 'Create the data file' }).click();
      await page.getByText('Request completed').first().waitFor();
      await d.getByText('Data file created').waitFor();
      await d.getByText('Data file created').scrollIntoViewIfNeeded();
    },
  },
  {
    name: 'flow-privacy-retention-edit',
    path: '/privacy?tab=retention',
    as: GULF,
    ready: 'main table tbody tr',
    variants: ONE,
    act: async (page) => {
      await page.getByRole('button', { name: 'Edit the policy for Sent messages' }).click();
      const d = dialog(page);
      await d.waitFor();
      await d.getByLabel('Keep for (days)').fill('400');
      await d.locator('textarea').fill('Test edit: period agreed with the accountant (fictional).');
      await step(page, 'flow-privacy-retention-1-dialog');
      await d.getByRole('button', { name: 'Save changes' }).click();
      await page.getByText('Retention policy saved').first().waitFor();
      await page.locator('main tbody tr').filter({ hasText: '400 days' }).first().waitFor();
    },
  },

  {
    // Puts Gulf Star's privacy records back and, on the way, drives the paths the flows above skip:
    // a refused second policy, delete + add of a policy, editing and deleting a vendor, reopening an incident.
    name: 'flow-privacy-cleanup',
    path: '/privacy?tab=retention',
    as: GULF,
    ready: 'main table tbody tr',
    variants: ONE,
    act: async (page) => {
      const d = dialog(page);
      const confirm = (name) => page.getByRole('alertdialog').getByRole('button', { name });
      const NOTE = 'Starting value set by TypEase, not legal advice. Confirm the period with your legal adviser and change it here.';
      const addPolicy = async () => {
        await page.getByRole('button', { name: 'Add policy' }).first().click();
        await d.waitFor();
        await choose(page, d.getByRole('combobox').first(), 'Sent messages');
        await d.getByLabel('Keep for (days)').fill('365');
        await d.locator('textarea').fill(NOTE);
        await d.getByRole('switch').click(); // the starting policy is not active
        await d.getByRole('button', { name: 'Add policy' }).click();
      };
      // ---- a second policy for the same kind of record is refused with the API's reason
      if (await page.getByRole('button', { name: 'Edit the policy for Sent messages' }).count()) {
        await addPolicy();
        await d.locator('[role="alert"]').first().waitFor();
        await step(page, 'flow-privacy-cleanup-1-policy-exists');
        await d.getByRole('button', { name: 'Cancel' }).click();
        await d.waitFor({ state: 'hidden' });
        // ---- delete it, then add it again with the starting values
        await page.getByRole('button', { name: 'Delete the policy for Sent messages' }).click();
        await confirm('Delete policy').click();
        await page.getByText('Retention policy deleted').first().waitFor();
        await page.getByRole('alertdialog').waitFor({ state: 'hidden' });
      }
      await addPolicy();
      await page.getByText('Retention policy saved').first().waitFor();
      await page.locator('main tbody tr').filter({ hasText: 'Sent messages' }).filter({ hasText: '365 days' }).first().waitFor();
      await step(page, 'flow-privacy-cleanup-2-policy-restored');

      // ---- vendors: edit (goes back to review), then delete the test entry
      await page.goto(new URL('/privacy?tab=processors', page.url()).href);
      await page.locator('main [role="tabpanel"] p').first().waitFor();
      await page.waitForTimeout(1200);
      for (let guard = 0; guard < 4 && (await page.locator('main tbody tr').filter({ hasText: /Sample SMS Relay/ }).count()); guard++) {
        const row = page.locator('main tbody tr').filter({ hasText: /Sample SMS Relay/ }).first();
        if (guard === 0) {
          await row.getByRole('button').last().click();
          await page.getByRole('menuitem', { name: 'Edit' }).click();
          await d.waitFor();
          await d.getByLabel('What they do with the data').fill('Sends our SMS reminders and one-time codes.');
          await d.locator('button[type="submit"]').click();
          await page.getByText('Vendor saved').first().waitFor();
          await d.waitFor({ state: 'hidden' });
          await step(page, 'flow-privacy-cleanup-3-vendor-back-in-review');
        }
        await row.getByRole('button').last().click();
        await page.getByRole('menuitem', { name: 'Delete' }).click();
        await confirm('Delete vendor').click();
        await page.getByText('Vendor deleted').first().waitFor();
        await page.getByRole('alertdialog').waitFor({ state: 'hidden' });
        await page.waitForTimeout(800);
      }

      // ---- incidents: a resolved incident can be reopened, then resolved again
      await page.goto(new URL('/privacy?tab=incidents&status=RESOLVED', page.url()).href);
      await page.locator('main [role="tabpanel"] p').first().waitFor();
      await page.waitForTimeout(1200);
      if (await page.locator('main tbody tr a').count()) {
        await page.locator('main tbody tr a').first().click();
        await d.waitFor();
        await d.getByRole('button', { name: 'Reopen' }).click();
        await d.getByRole('button', { name: 'Mark as contained' }).waitFor();
        await step(page, 'flow-privacy-cleanup-4-incident-reopened');
        await d.getByRole('button', { name: 'Mark as contained' }).click();
        await d.getByRole('button', { name: 'Resolve' }).waitFor();
        await d.getByRole('button', { name: 'Resolve' }).click();
        await d.getByRole('button', { name: 'Reopen' }).waitFor();
      }
    },
  },
  {
    // A NEW centre from the sign-up screen to "Your centre is ready". No demo account is touched.
    name: 'flow-onboarding',
    path: '/sign-up',
    ready: 'form',
    variants: ONE,
    act: async (page) => {
      const email = `owner@shots-${stamp}.test`;
      const password = 'TypEase-Demo-2026';
      const phone = `58${String(Date.now()).slice(-7)}`;
      // ---- sign up, confirm the email through the development link, sign in
      await page.locator('form input').nth(0).fill(`Shots Typing ${stamp}`);
      await page.locator('form input').nth(1).fill(`shots-${stamp}`);
      await page.locator('form input').nth(2).fill('Sara Tester');
      await page.locator('form input[type="tel"]').fill(phone);
      await page.locator('form input[type="email"]').fill(email);
      await page.locator('form input[type="password"]').fill(password);
      await page.getByRole('checkbox').click();
      await page.getByText('This address is available').waitFor();
      await page.locator('form button[type="submit"]').click();
      await page.waitForURL(/verify-email/);
      await page.getByRole('link', { name: 'Open the confirmation link' }).click();
      await page.getByText('Email address confirmed').first().waitFor();
      await page.getByRole('link', { name: 'Sign in' }).first().click();
      await page.locator('input[type="email"]').fill(email);
      await page.locator('input[type="password"]').fill(password);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL(/\/onboarding/, { timeout: 60000 });
      // ---- 1 account: phone code
      await page.getByRole('heading', { name: 'Business information' }).waitFor(); // resumes at the first open required step
      await page.getByRole('button', { name: /Verify your account/ }).click();
      await page.getByRole('button', { name: 'Send code' }).click();
      const hint = page.getByText(/Your code is \d{6}/);
      await hint.waitFor();
      const code = (await hint.textContent()).match(/\d{6}/)[0];
      await step(page, 'flow-onboarding-1-account');
      await page.getByLabel('Code', { exact: true }).fill(code);
      await page.getByRole('button', { name: 'Confirm number' }).click();
      await page.getByText(/Mobile number confirmed:/).waitFor();
      await page.getByRole('button', { name: 'Continue' }).click();
      // ---- 2 business
      await page.getByRole('heading', { name: 'Business information' }).waitFor();
      await page.getByLabel(/Legal name/).fill(`Shots Typing ${stamp} LLC (test)`);
      await page.getByLabel(/Trade licence number/).fill('SAMPLE-TL-9999');
      await choose(page, page.locator('main').getByRole('combobox').first(), 'Sharjah');
      await page.getByText('Draft saved.').waitFor({ timeout: 15000 });
      // resumable: a reload brings the draft back
      await page.reload();
      await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
      await page.getByLabel(/Trade licence number/).waitFor();
      if ((await page.getByLabel(/Trade licence number/).inputValue()) !== 'SAMPLE-TL-9999') throw new Error('The draft was not restored after a reload');
      await step(page, 'flow-onboarding-2-business-draft-restored');
      await page.getByRole('button', { name: 'Save and continue' }).click();
      // ---- 3 plan
      await page.getByRole('heading', { name: 'Choose your plan' }).waitFor();
      await page.getByRole('radio', { name: 'Pay yearly' }).click();
      await page.getByRole('radio', { name: /Professional/ }).click();
      await page.getByLabel('Coupon code').fill('NOPE');
      await page.getByRole('button', { name: /Start free trial of Professional/ }).click();
      await page.locator('main [role="alert"]').filter({ hasText: /coupon/i }).waitFor();
      await step(page, 'flow-onboarding-3-plan-coupon-refused');
      await page.getByLabel('Coupon code').fill('');
      await page.getByRole('button', { name: /Start free trial of Professional/ }).click();
      // ---- 4 branding (optional)
      await page.getByRole('heading', { name: 'Your name and contact details' }).waitFor();
      await page.getByLabel('Business name (Arabic)').fill('مركز الاختبار للطباعة');
      await step(page, 'flow-onboarding-4-branding');
      await page.getByRole('button', { name: 'Save and continue' }).click();
      // ---- 5 services
      await page.getByRole('heading', { name: 'Add your services' }).waitFor();
      await page.getByRole('button', { name: 'Install starter catalogue' }).click();
      await page.getByText(/services were added/).first().waitFor({ timeout: 60000 });
      await step(page, 'flow-onboarding-5-services');
      await page.getByRole('button', { name: 'Continue' }).click();
      // ---- 6 branches
      await page.getByRole('heading', { name: 'Your branches' }).waitFor();
      await page.locator('main').getByRole('button', { name: 'Edit' }).first().click();
      const d = dialog(page);
      await d.waitFor();
      await d.locator('textarea').fill('Shop 1, Sample Building, Sample Street (fictional address)');
      await d.locator('input[type="tel"]').fill(phone);
      await d.locator('button[type="submit"]').click();
      await page.getByText('Branch saved').first().waitFor();
      await step(page, 'flow-onboarding-6-branches');
      await page.getByRole('button', { name: 'Continue' }).click();
      // ---- 7 team (optional)
      await page.getByRole('heading', { name: 'Invite your team' }).waitFor();
      await page.getByRole('button', { name: 'Skip for now' }).click();
      // ---- 8 review and finish
      await page.getByRole('heading', { name: 'Review and finish' }).waitFor();
      await step(page, 'flow-onboarding-7-review');
      await page.getByRole('button', { name: 'Finish set-up' }).click();
      await page.getByRole('heading', { name: /Your centre is ready|Waiting for approval/ }).waitFor();
    },
  },

  // ---- "nobody can grant what they do not hold": needs a staff member with staff.manage + role.manage but few
  // other permissions. Create one (custom role + invitation accepted through the API) and pass the email:
  //   ADM_LEAD_EMAIL=lead.1234@gulf-star.test node packages/ui/scripts/screenshots.mjs ... --only flow-roles-escalation,flow-staff-escalation
  {
    name: 'flow-roles-escalation',
    path: '/roles',
    as: process.env.ADM_LEAD_EMAIL ?? '',
    ready: 'main h3',
    variants: ONE,
    act: async (page) => {
      const card = page.locator('main section').filter({ has: page.locator('#roles-builtin') }).locator('h3', { hasText: 'Centre Manager' }).locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]');
      await card.getByRole('button', { name: 'Copy to a new role' }).click();
      const d = dialog(page);
      await d.waitFor();
      await d.getByText(/left out because you do not hold/).waitFor();
      await d.getByText(/left out because you do not hold/).scrollIntoViewIfNeeded();
    },
  },
  {
    name: 'flow-staff-escalation',
    path: '/staff',
    as: process.env.ADM_LEAD_EMAIL ?? '',
    ready: LIST,
    variants: ONE,
    act: async (page) => {
      await page.locator('main header button').first().click();
      const d = dialog(page);
      await d.waitFor();
      await d.locator('input').nth(0).fill('Too Powerful');
      await d.locator('input[type="email"]').fill(`too.powerful.${stamp}@gulf-star.test`);
      await choose(page, d.getByRole('combobox').first(), 'Centre Owner');
      if (await d.getByRole('radio', { name: 'All branches' }).count()) await d.getByRole('radio', { name: 'All branches' }).click();
      await d.locator('button[type="submit"]').click();
      await d.getByText(/more permissions than your own/).waitFor();
    },
  },

  {
    // Exercises edit / suspend / reactivate / remove and the API's blocking reasons on the TEST records the
    // flows above created in Gulf Star (never on seeded staff), and removes them again.
    name: 'flow-cleanup-gulf',
    path: '/staff',
    as: GULF,
    ready: LIST,
    variants: ONE,
    act: async (page) => {
      const confirm = (name) => page.getByRole('alertdialog').getByRole('button', { name });
      const main = page.locator('main');
      // ---- edit, suspend, reactivate the limited test user
      if (await main.getByRole('link', { name: /Lead Tester/ }).count()) {
        await main.getByRole('link', { name: /Lead Tester/ }).first().click();
        await page.waitForURL(/\/staff\/[0-9a-f-]{36}/);
        await page.getByLabel(/Job title/).fill('Team lead on probation');
        if (await page.getByRole('radio', { name: 'Selected branches only' }).count()) {
          await page.getByRole('radio', { name: 'Selected branches only' }).click();
          await page.getByRole('checkbox', { name: /Musaffah Office/ }).check();
        }
        await page.getByRole('button', { name: 'Save changes' }).click();
        await page.getByText('Staff member updated').first().waitFor();
        await step(page, 'flow-cleanup-1-staff-edited');
        await page.getByRole('button', { name: 'Suspend' }).click();
        await confirm('Suspend').click();
        await page.getByText('Staff member suspended').first().waitFor();
        await page.getByRole('button', { name: 'Reactivate' }).click();
        await step(page, 'flow-cleanup-2-reactivate-confirm');
        await confirm('Reactivate').click();
        await page.getByText('Staff member reactivated').first().waitFor();
        // ---- a role that is in use cannot be deleted: the API's reason stays in the dialog
        await page.goto(new URL('/roles', page.url()).href);
        const lead = page.locator('main h3', { hasText: /Team lead \(test/ }).first().locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]');
        await lead.getByRole('button', { name: 'Delete' }).click();
        await confirm('Delete role').click();
        await page.getByRole('alertdialog').locator('[role="alert"]').waitFor();
        await step(page, 'flow-cleanup-3-role-in-use');
        await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
        await page.getByRole('alertdialog').waitFor({ state: 'hidden' });
        // ---- remove the test user from the detail page
        await page.goto(new URL('/staff', page.url()).href);
        await main.getByRole('link', { name: /Lead Tester/ }).first().click();
        await page.waitForURL(/\/staff\/[0-9a-f-]{36}/);
        await page.getByRole('button', { name: 'Remove from centre' }).click();
        await confirm('Remove from centre').click();
        await page.waitForURL(/\/staff$/);
      }
      // ---- remove invited test people from the list
      await main.locator('table tbody tr a').first().waitFor();
      for (let guard = 0; guard < 6 && (await main.locator('tbody tr', { hasText: /Shots Tester/ }).count()); guard++) {
        const row = main.locator('tbody tr', { hasText: /Shots Tester/ }).first();
        await row.getByRole('button').last().click();
        await page.getByRole('menuitem', { name: 'Remove from centre' }).click();
        await confirm('Remove from centre').click();
        await page.getByText('Staff member removed').first().waitFor();
        await page.waitForTimeout(800);
      }
      // ---- delete the test roles
      await page.goto(new URL('/roles', page.url()).href);
      await page.locator('main h3').first().waitFor();
      for (let guard = 0; guard < 6 && (await page.locator('main h3', { hasText: /Team lead \(test|Front desk lead/ }).count()); guard++) {
        const card = page.locator('main h3', { hasText: /Team lead \(test|Front desk lead/ }).first().locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]');
        await card.getByRole('button', { name: 'Delete' }).click();
        await confirm('Delete role').click();
        await page.getByText('Role deleted').first().waitFor();
        await page.waitForTimeout(800);
      }
      // ---- branches: the head office cannot be deactivated (API reason shown); the test branch can
      await page.goto(new URL('/branches', page.url()).href);
      await page.locator('main h2').first().waitFor();
      const head = page.locator('main li', { hasText: 'Head office' }).first();
      await head.getByRole('button', { name: 'Deactivate' }).click();
      await confirm('Deactivate').click();
      await page.getByRole('alertdialog').locator('[role="alert"]').waitFor();
      await step(page, 'flow-cleanup-4-head-office-blocked');
      await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
      await page.getByRole('alertdialog').waitFor({ state: 'hidden' });
      for (let guard = 0; guard < 4 && (await page.locator('main li', { hasText: /Marina desk/ }).filter({ hasText: 'Active' }).getByRole('button', { name: 'Deactivate' }).count()); guard++) {
        await page.locator('main li', { hasText: /Marina desk/ }).getByRole('button', { name: 'Deactivate' }).first().click();
        await confirm('Deactivate').click();
        await page.getByText('Branch deactivated').first().waitFor();
        await page.waitForTimeout(800);
      }
    },
  },
];
