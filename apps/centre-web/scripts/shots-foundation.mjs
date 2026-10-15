/**
 * Checks of the shared foundation in the staff app (Select, DataTable, dialogs, the shell). Each scenario
 * asserts what it is about and throws when it does not hold, so a green run is more than a set of pictures.
 * Run from the repository root, against the running dev server:
 *
 *   export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
 *   node packages/ui/scripts/screenshots.mjs --app centre --scenarios apps/centre-web/scripts/shots-foundation.mjs --out /tmp/shots-foundation
 *
 * The runner itself reports console errors (React's development warnings included) for every picture.
 * Nothing here changes data, except that the dialogs are opened and closed again.
 */
const AL_NOOR = 'owner@al-noor.test';
const ONE = ['en-light-desktop'];
const LIST = 'main table tbody tr:visible, main ul li:visible';

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const dialog = (page) => page.getByRole('dialog');
const top = async (locator) => (await locator.boundingBox()).y;

export default [
  // ---- Select: empty -> set and "open with a value" used to log a React error about portal containers.
  {
    name: 'fx-select-gallery',
    path: '/dev/components',
    ready: '#inputs',
    variants: ONE,
    act: async (page) => {
      const select = page.locator('#inputs').getByRole('combobox').first();
      await select.scrollIntoViewIfNeeded();
      const before = (await select.innerText()).trim();
      await select.click(); // opens empty
      const options = page.getByRole('option');
      await options.first().waitFor();
      const chosen = (await options.nth(1).innerText()).trim();
      await options.nth(1).click(); // empty -> set
      await page.waitForTimeout(200);
      check((await select.innerText()).trim() === chosen && chosen !== before, `the trigger shows "${await select.innerText()}", expected "${chosen}"`);
      await select.click(); // opens with a value
      await page.getByRole('option', { name: chosen }).waitFor();
      check((await page.getByRole('option', { name: chosen }).getAttribute('aria-selected')) === 'true', 'the chosen option is not marked as selected');
      await page.waitForTimeout(300);
    },
  },
  // ---- /customers?add=1 opens the dialog; the Select inside a React Hook Form keeps the value set by form.reset().
  {
    name: 'fx-customers-add-param',
    path: '/customers?add=1',
    as: AL_NOOR,
    ready: '[role="dialog"]',
    variants: ['en-light-desktop', 'ar-dark-desktop', 'en-light-mobile'],
    act: async (page) => {
      await page.waitForFunction(() => !new URL(window.location.href).searchParams.has('add'));
      // (the phone field's country list is a native <select>, also a "combobox": take the Radix trigger)
      const language = dialog(page).locator('button[role="combobox"]').first();
      const value = (await language.innerText()).trim();
      check(value.length > 0, 'the language select lost the value the form was reset with (empty-string echo)');
      await language.click(); // opens with a value
      await page.getByRole('option').first().waitFor();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      check(await dialog(page).isVisible(), 'the dialog closed with the select');
    },
  },
  // ---- Dialog + blur validation: the control under the pointer must not move between press and release.
  {
    name: 'fx-dialog-click-kept',
    path: '/customers?add=1',
    as: AL_NOOR,
    ready: '[role="dialog"]',
    variants: ONE,
    act: async (page) => {
      const d = dialog(page);
      const name = d.locator('input[name="fullName"]');
      const email = d.locator('input[type="email"]');
      await name.click(); // focus in the (empty, required) name field
      const panelTop = await top(d);
      const emailTop = await top(email);
      const box = await email.boundingBox();
      // Press near the top edge of a control BELOW the name field: this blurs the name field.
      await page.mouse.move(box.x + box.width / 2, box.y + 3);
      await page.mouse.down();
      await page.waitForTimeout(400); // the validation has run by now
      check((await name.getAttribute('aria-invalid')) === 'true', 'the name field was not validated on blur');
      check((await d.getByRole('alert').count()) === 0, 'the message appeared while the mouse button was still down');
      check(Math.abs((await top(email)) - emailTop) < 1, 'the control moved away from under the pointer during the press');
      await page.mouse.up();
      await d.getByRole('alert').first().waitFor();
      check(await email.evaluate((el) => el === document.activeElement), 'the click did not reach the control');
      // The panel hangs from its top edge: it did not jump upwards when the content grew.
      check(Math.abs((await top(d)) - panelTop) < 1, `the dialog moved by ${(await top(d)) - panelTop}px when the message appeared`);

      // The same press on a button in the footer performs its click.
      await name.click();
      await name.fill('');
      const cancel = d.getByRole('button', { name: 'Cancel' });
      const cb = await cancel.boundingBox();
      await page.screenshot({ path: process.env.FX_OUT ? `${process.env.FX_OUT}/centre-fx-dialog-click-kept-message.png` : '/tmp/centre-fx-dialog-click-kept-message.png', animations: 'disabled' });
      await page.mouse.move(cb.x + cb.width / 2, cb.y + 3);
      await page.mouse.down();
      await page.waitForTimeout(300);
      await page.mouse.up();
      await d.waitFor({ state: 'hidden', timeout: 5000 });
    },
  },
  // ---- A list without `filters`: used to end in "Maximum update depth exceeded".
  { name: 'fx-list-without-filters', path: '/reports/scheduled', as: AL_NOOR, ready: 'main h1', variants: ONE, act: async (page) => page.waitForTimeout(2500) },
  { name: 'fx-list-reconciliation', path: '/finance/reconciliation', as: AL_NOOR, ready: 'main h1', variants: ONE, act: async (page) => page.waitForTimeout(2500) },
  {
    name: 'fx-list-with-filters',
    path: '/customers?type=BUSINESS',
    as: AL_NOOR,
    ready: LIST,
    variants: ONE,
    act: async (page) => {
      await page.waitForTimeout(1500);
      check(new URL(page.url()).searchParams.get('type') === 'BUSINESS', 'the filter from the URL was dropped');
    },
  },
  // ---- Shell: unread count on the bell, the new navigation entries, one current item.
  {
    name: 'fx-bell-and-nav',
    path: '/reports/scheduled',
    as: AL_NOOR,
    ready: '[data-slot="notifications-count"]',
    variants: ['en-light-desktop', 'ar-dark-desktop'],
    act: async (page) => {
      const count = (await page.locator('[data-slot="notifications-count"]').innerText()).trim();
      check(/^\d+\+?$|^[٠-٩]+\+?$/.test(count), `the bell shows "${count}"`);
      const label = await page.locator('header a[href="/notifications"]').getAttribute('aria-label');
      check(/\d|[٠-٩]|غير/.test(label ?? ''), `the bell's accessible name does not mention the count: "${label}"`);
      const nav = page.locator('aside nav');
      check((await nav.locator('a[href="/finance"]').count()) === 1, 'no "Expenses & fees" entry');
      check((await nav.locator('a[href="/reports/scheduled"]').count()) === 1, 'no "Scheduled reports" entry');
      const current = await nav.locator('a[aria-current="page"]').evaluateAll((links) => links.map((a) => a.getAttribute('href')));
      check(current.length === 1 && current[0] === '/reports/scheduled', `current navigation items: ${JSON.stringify(current)}`);
      await nav.locator('a[href="/reports/scheduled"]').scrollIntoViewIfNeeded();
    },
  },
  // ---- Printing: the sidebar and the top bar are left out, the page prints in the light theme.
  {
    name: 'fx-print',
    path: '/invoices',
    as: AL_NOOR,
    ready: LIST,
    variants: ['en-light-desktop', 'ar-dark-desktop'],
    act: async (page) => {
      await page.emulateMedia({ media: 'print' });
      await page.waitForTimeout(300);
      check(!(await page.locator('aside').first().isVisible()), 'the sidebar is printed');
      check(!(await page.locator('header').first().isVisible()), 'the top bar is printed');
      const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      check(background === 'rgb(255, 255, 255)', `the page prints on ${background}`);
    },
  },
  // ---- Built-in roles have Arabic names in the role picker and in the top bar.
  {
    name: 'fx-roles-arabic',
    path: '/staff',
    as: AL_NOOR,
    ready: 'main h1',
    variants: ['ar-dark-desktop'],
    act: async (page) => {
      await page.locator('main header button').first().click();
      const d = dialog(page);
      await d.waitFor();
      const role = d.locator('button[role="combobox"]').first();
      await role.click();
      await page.getByRole('option').first().waitFor();
      const names = await page.getByRole('option').allInnerTexts();
      check(names.some((n) => n.includes('موظف الاستقبال')), `role names in Arabic: ${names.join(' | ')}`);
      check(!names.some((n) => /^(Centre Owner|Centre Manager|Receptionist|Accountant)$/.test(n.trim())), `built-in roles still in English: ${names.join(' | ')}`);
    },
  },
  // ---- A centre that is still being set up: its administrator is taken to the wizard from any screen.
  // No demo centre is in that state, so the session and GET /onboarding are altered on their way to the browser.
  {
    name: 'fx-onboarding-redirect',
    path: '/customers',
    as: AL_NOOR,
    ready: 'main h1',
    variants: ONE,
    prepare: async (context) => {
      const patchSession = async (route) => {
        const response = await route.fetch();
        let json;
        try {
          json = await response.json();
        } catch {
          return route.fulfill({ response });
        }
        const session = json.session ?? json;
        if (session?.tenant) session.tenant.status = 'ONBOARDING';
        return route.fulfill({ response, json });
      };
      await context.route('**/api/v1/auth/refresh', patchSession);
      await context.route('**/api/v1/auth/me', patchSession);
      await context.route('**/api/v1/onboarding', async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const response = await route.fetch();
        const json = await response.json();
        return route.fulfill({ response, json: { ...json, completed: false } });
      });
    },
    act: async (page) => {
      await page.waitForURL((url) => url.pathname === '/onboarding', { timeout: 30_000 });
      await page.locator('main h1').waitFor();
      // The person's own account stays reachable during the set-up.
      await page.goto(new URL('/account/profile', page.url()).href, { waitUntil: 'domcontentloaded' });
      await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
      await page.locator('main h1').waitFor();
      await page.waitForTimeout(800);
      check(new URL(page.url()).pathname === '/account/profile', 'the account page was redirected as well');
      await page.goto(new URL('/invoices', page.url()).href, { waitUntil: 'domcontentloaded' });
      await page.waitForURL((url) => url.pathname === '/onboarding', { timeout: 30_000 });
      await page.locator('main h1').waitFor();
    },
  },
];
