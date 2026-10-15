/**
 * Takes screenshots of the TypEase web apps with Playwright (Chromium), in the
 * combinations a screen has to be checked in: desktop / phone, light / dark,
 * English / Arabic.
 *
 * Prerequisites:
 *   - the API is running and `node scripts/dev-quickstart.mjs` has created the demo data;
 *   - the app you want to capture is running (`pnpm dev:centre`, or `next start`).
 *
 * Usage (from the repository root):
 *   export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers     # where Chromium is installed on this machine
 *   node packages/ui/scripts/screenshots.mjs --app centre                 # every scenario of one app
 *   node packages/ui/scripts/screenshots.mjs --app centre --only dashboard
 *   node packages/ui/scripts/screenshots.mjs --app customer --out /tmp/shots --variants en-light-desktop,en-light-mobile
 *
 *   node packages/ui/scripts/screenshots.mjs --app centre --scenarios apps/centre-web/scripts/shots-finance.mjs --out /tmp/shots
 *
 * Output: <out>/<app>-<scenario>-<lang>-<theme>-<device>.png (default <out>: docs/brand/screenshots).
 * Add a scenario by adding an entry to SCENARIOS below.
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// @playwright/test is a dependency of the `tests` workspace package.
const { chromium } = createRequire(resolve(root, 'tests/package.json'))('@playwright/test');

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const APP = arg('app', 'centre');
const OUT = resolve(root, arg('out', 'docs/brand/screenshots'));
const ONLY = arg('only', '').split(',').filter(Boolean);
const PASSWORD = arg('password', 'TypEase-Demo-2026');

const PORTS = { centre: 3001, customer: 3002, corporate: 3003, platform: 3004 };
const BASE = arg('base', `http://localhost:${PORTS[APP]}`);

const DEVICES = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};
/** The three combinations every screen is checked in. */
const DEFAULT_VARIANTS = ['en-light-desktop', 'ar-dark-desktop', 'en-light-mobile'];
const VARIANTS = arg('variants', '').split(',').filter(Boolean);

const OWNER_WL = 'owner@al-noor.test';

/**
 * A scenario: where to go, who is signed in, and what to do before the picture.
 *   path      URL path (may carry ?tenant=<slug> for the portals)
 *   as        email to sign in with first (demo accounts of the seed: docs/DEMO_ENVIRONMENT.md)
 *   signInPath, tenant   where and for which centre to sign in (portals)
 *   ready     selector or text that must be visible before the picture
 *   prepare   async (context) => {} runs after sign-in and before the page opens (route interception ...)
 *   act       async (page) => {} extra steps: open a dialog, submit a form ... Throw to fail the scenario.
 *   fullPage  capture the whole scrollable page
 *   variants  override DEFAULT_VARIANTS
 */
const SCENARIOS = {
  centre: [
    { name: 'sign-in', path: '/sign-in', ready: 'form' },
    { name: 'dashboard', path: '/dashboard', as: OWNER_WL, ready: 'main table tbody tr a:visible, main ul li a:visible' },
    { name: 'requests', path: '/requests', as: OWNER_WL, ready: 'main table tbody tr a:visible, main ul li a:visible' },
    { name: 'customers', path: '/customers', as: OWNER_WL, ready: 'main table tbody tr a:visible, main ul li a:visible' },
    {
      name: 'customers-add-validation',
      path: '/customers',
      as: OWNER_WL,
      ready: 'main table tbody tr a:visible, main ul li a:visible',
      act: async (page) => {
        await page.locator('main header button').first().click();
        const dialog = page.getByRole('dialog');
        await dialog.waitFor();
        await dialog.locator('input[type="email"]').fill('not-an-email');
        await dialog.locator('input[type="tel"]').fill('12');
        await dialog.locator('button[type="submit"]').click();
        await dialog.locator('[role="alert"]').first().waitFor();
      },
    },
    { name: 'components', path: '/dev/components', ready: '#data table tbody tr a:visible, #data ul li a:visible', fullPage: true },
    { name: 'account-security', path: '/account/security', as: OWNER_WL, ready: 'main h1', variants: ['en-light-desktop'] },
    { name: 'sign-up', path: '/sign-up', ready: 'form', variants: ['en-light-desktop', 'en-light-mobile'] },
    {
      name: 'navigation-drawer',
      path: '/dashboard',
      as: OWNER_WL,
      ready: 'main h1',
      variants: ['en-light-mobile', 'ar-dark-mobile'],
      act: async (page) => {
        await page.locator('header button').first().click();
        await page.getByRole('dialog').waitFor();
        await page.waitForTimeout(350);
      },
    },
  ],
  customer: [
    { name: 'home-whitelabel', path: '/?tenant=al-noor', ready: 'main ul a:visible', fullPage: true, variants: ['en-light-desktop', 'ar-dark-desktop', 'en-light-mobile', 'ar-light-mobile'] },
    { name: 'home-typease', path: '/?tenant=gulf-star', ready: 'main ul a:visible', fullPage: true, variants: ['en-light-desktop', 'en-light-mobile'] },
    { name: 'services-whitelabel', path: '/services?tenant=al-noor', ready: 'main ul a:visible', fullPage: true },
    { name: 'services-typease', path: '/services?tenant=gulf-star', ready: 'main ul a:visible', fullPage: true, variants: ['en-light-desktop', 'en-light-mobile'] },
    { name: 'login-whitelabel', path: '/login?tenant=al-noor', ready: 'form' },
    { name: 'login-typease', path: '/login?tenant=gulf-star', ready: 'form', variants: ['en-light-desktop', 'en-light-mobile'] },
    { name: 'register-whitelabel', path: '/register?tenant=al-noor', ready: 'form', variants: ['en-light-mobile'] },
    { name: 'track-whitelabel', path: '/track?tenant=al-noor', ready: 'form', variants: ['en-light-desktop'] },
    { name: 'dashboard-whitelabel', path: '/dashboard?tenant=al-noor', as: 'aisha.rahman@example.test', signInPath: '/login?tenant=al-noor', ready: 'main h1', variants: ['en-light-desktop', 'en-light-mobile', 'ar-dark-mobile'] },
    { name: 'centre-not-found', path: '/?tenant=no-such-centre', ready: 'main h1', variants: ['en-light-desktop'] },
  ],
  corporate: [
    { name: 'sign-in', path: '/sign-in?tenant=al-noor', ready: 'form', variants: ['en-light-desktop', 'en-light-mobile'] },
    { name: 'overview', path: '/overview?tenant=al-noor', as: 'admin@falcon-demo.test', signInPath: '/sign-in?tenant=al-noor', ready: 'main h1' },
  ],
  platform: [
    { name: 'sign-in', path: '/sign-in', ready: 'form' },
    // Platform staff exist only after the demo seed (admin@typease.test). Without --platform-user the
    // session is simulated in the browser (see mockPlatformSession); the plans themselves come from the real API.
    { name: 'plans', path: '/plans', as: arg('platform-user', ''), mockSession: !arg('platform-user', ''), ready: 'main table:visible, main dl:visible' },
  ],
};

/**
 * Answers the silent sign-in (POST /auth/refresh) with a platform super admin
 * session, for screens behind the platform login when the database has no
 * platform staff. Only the session is simulated: every other call is real.
 */
async function mockPlatformSession(context) {
  const cors = (request) => ({
    'access-control-allow-origin': new URL(BASE).origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': request.headers()['access-control-request-headers'] ?? '*',
    'access-control-allow-methods': 'POST, OPTIONS',
  });
  await context.route('**/api/v1/auth/refresh', (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors(request) });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: cors(request),
      body: JSON.stringify({
        status: 'OK',
        accessToken: 'simulated',
        expiresIn: 900,
        landing: '/dashboard',
        session: {
          user: { id: '00000000-0000-4000-8000-000000000001', email: 'admin@typease.test', phone: null, fullName: 'Platform Admin (simulated)', preferredLanguage: 'en', platformRole: 'SUPER_ADMIN', mfaEnabled: true, emailVerified: true, phoneVerified: false },
          tenant: null,
          membership: null,
          permissions: ['platform.tenants.read', 'platform.tenants.manage', 'platform.plans.manage', 'platform.billing.manage', 'platform.metrics.read', 'platform.features.manage', 'platform.integrations.manage', 'platform.staff.manage', 'platform.audit.read', 'platform.support.manage', 'platform.access.request'],
          supportGrant: null,
          mfaRequiredSetup: false,
        },
      }),
    });
  });
}

async function signIn(context, scenario) {
  const page = await context.newPage();
  await page.goto(`${BASE}${scenario.signInPath ?? '/sign-in'}`, { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 90_000 });
  await page.locator('input[type="email"]').waitFor({ timeout: 60_000 });
  await page.locator('input[type="email"]').fill(scenario.as);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  // Signed in when the form is gone and the app shell (or the portal account) has rendered.
  await page.waitForURL((url) => !/sign-in|login/.test(url.pathname), { timeout: 60_000 });
  await page.close();
}

/**
 * --scenarios <file.mjs>[,<file.mjs>]: extra scenario files, so each section of an app keeps its own
 * list. A file default-exports an array of scenarios (same shape as above) or `{ app, scenarios }`.
 */
async function loadExtraScenarios() {
  const { pathToFileURL } = await import('node:url');
  const extra = [];
  for (const file of arg('scenarios', '').split(',').filter(Boolean)) {
    const mod = (await import(pathToFileURL(resolve(process.cwd(), file)).href)).default;
    const list = Array.isArray(mod) ? mod : mod.scenarios;
    if (!Array.isArray(list)) throw new Error(`${file} must default-export an array of scenarios`);
    extra.push(...list);
  }
  return extra;
}

async function run() {
  const extra = await loadExtraScenarios();
  const scenarios = (extra.length ? extra : SCENARIOS[APP] ?? []).filter((s) => (ONLY.length ? ONLY.includes(s.name) : true)).filter((s) => s.as !== '' || s.mockSession);
  if (!scenarios.length) throw new Error(`No scenarios for app "${APP}"${ONLY.length ? ` matching ${ONLY.join(', ')}` : ''}.`);
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const failures = [];
  for (const scenario of scenarios) {
    for (const variant of VARIANTS.length ? VARIANTS : scenario.variants ?? DEFAULT_VARIANTS) {
      const [lang, theme, device] = variant.split('-');
      const file = `${APP}-${scenario.name}-${variant}.png`;
      const context = await browser.newContext({ ...DEVICES[device], locale: lang === 'ar' ? 'ar-AE' : 'en-AE', timezoneId: 'Asia/Dubai', colorScheme: theme });
      const url = new URL(BASE);
      await context.addCookies([{ name: 'te_locale', value: lang, domain: url.hostname, path: '/' }]);
      await context.addInitScript((t) => {
        try {
          window.localStorage.setItem('te_theme', t);
        } catch {}
      }, theme);
      const problems = [];
      try {
        if (scenario.mockSession) await mockPlatformSession(context);
        else if (scenario.as) await signIn(context, scenario);
        // After signing in, before the page opens: route interception, cookies, storage.
        if (scenario.prepare) await scenario.prepare(context);
        const page = await context.newPage();
        page.on('console', (m) => {
          // The silent sign-in on load answers 401 for visitors without a session: expected, not a problem.
          if (m.type() !== 'error' || /status of 401/.test(m.text())) return;
          // For a hydration mismatch the useful part is the +/- lines of React's diff.
          const diff = m.text().split('\n').filter((line) => /^[+-]\s+[\w-]+=/.test(line)).map((line) => line.replace(/\s+/g, ' ')).join(' | ');
          problems.push(diff ? `hydration mismatch: ${diff.slice(0, 500)}` : m.text().slice(0, 300));
        });
        page.on('pageerror', (e) => problems.push(`pageerror: ${String(e).slice(0, 300)}`));
        await page.goto(`${BASE}${scenario.path}`, { waitUntil: 'domcontentloaded' });
        // AppProviders sets this once React has hydrated; the server-rendered HTML alone is not the working page.
        await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 90_000 });
        if (scenario.ready) await page.locator(scenario.ready).first().waitFor({ state: 'visible', timeout: 90_000 });
        if (scenario.act) await scenario.act(page);
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(500);
        await page.screenshot({ path: resolve(OUT, file), fullPage: !!scenario.fullPage, animations: 'disabled' });
        const info = await page.evaluate(() => ({
          lang: document.documentElement.lang,
          dir: document.documentElement.dir,
          dark: document.documentElement.classList.contains('dark'),
          overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        }));
        const notes = [
          info.lang !== lang ? `lang=${info.lang}` : '',
          info.dark !== (theme === 'dark') ? `dark=${info.dark}` : '',
          info.overflowX > 1 ? `HORIZONTAL OVERFLOW ${info.overflowX}px` : '',
          problems.length ? `${problems.length} console error(s): ${problems[0]}` : '',
        ].filter(Boolean);
        console.log(`ok   ${file}${scenario.mockSession ? '   (simulated platform session)' : ''}${notes.length ? `   [${notes.join('; ')}]` : ''}`);
        if (notes.length) failures.push(`${file}: ${notes.join('; ')}`);
      } catch (e) {
        console.log(`FAIL ${file}: ${String(e.message ?? e).split('\n')[0]}${problems.length ? ` | console: ${problems[0]}` : ''}`);
        failures.push(file);
        try {
          const pages = context.pages();
          if (pages.length) await pages[pages.length - 1].screenshot({ path: resolve(OUT, file.replace('.png', '.FAILED.png')) });
        } catch {}
      } finally {
        await context.close();
      }
    }
  }
  await browser.close();
  if (failures.length) {
    console.log(`\n${failures.length} screenshot(s) need attention.`);
    process.exitCode = 1;
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
