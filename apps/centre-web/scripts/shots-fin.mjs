/**
 * Screenshot scenarios of the "fin" section (money, reports, subscription, audit).
 *
 *   export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
 *   node packages/ui/scripts/screenshots.mjs --app centre --scenarios apps/centre-web/scripts/shots-fin.mjs --out /tmp/shots-fin [--only fin-invoices,...]
 *
 * Read-only scenarios take pictures of seeded records (looked up through the UI, never by a
 * hard-coded id). Scenarios whose name starts with "flow-" WRITE to the database through the
 * UI (a quotation, an invoice, payments, a refund, a scheduled report ...): run them on a demo
 * database only, and one at a time with --only. They save a picture of every step next to the
 * final one, as centre-<scenario>-<step>.png.
 */
import { resolve } from 'node:path';

const OWNER = 'owner@al-noor.test';
const ACCOUNTANT = 'accountant@al-noor.test';
const RECEPTION = 'reception.dubai@al-noor.test';
const OWNER_PRO = 'owner@gulf-star.test'; // Professional plan, active
const OWNER_TRIAL = 'owner@desert-rose.test'; // Starter plan, in its trial
const PASSWORD = 'TypEase-Demo-2026';
const ROW = 'main table tbody tr a:visible, main ul li a:visible';
/** Rows of a list whose rows are not links (report tables, the audit log): the table from `md` up, cards below. */
const RECORD = 'main table tbody tr:visible, main ul li:visible';
const EN = ['en-light-desktop'];
const EN_BOTH = ['en-light-desktop', 'en-light-mobile'];

const outArg = process.argv.indexOf('--out');
const OUT = resolve(process.cwd(), outArg >= 0 ? process.argv[outArg + 1] : 'docs/brand/screenshots');

const settle = async (page) => {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(400);
};

/** Opens the first row of a list that matches the filter in the URL. */
const openFirstRow = async (page) => {
  await page.locator(ROW).first().click();
  await page.waitForURL(/\/[0-9a-f-]{36}/);
  await page.locator('main h1').waitFor();
  await settle(page);
};

/** A step picture of a flow. */
const step = (page, flow, name) => page.screenshot({ path: resolve(OUT, `centre-${flow}-${name}.png`), fullPage: true, animations: 'disabled' });

/** A second signed-in person (segregation of duties needs two): returns their page, in a context of its own. */
async function asUser(page, email) {
  const base = new URL(page.url()).origin;
  const context = await page.context().browser().newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-AE', timezoneId: 'Asia/Dubai', acceptDownloads: true });
  await context.addCookies([{ name: 'te_locale', value: 'en', domain: new URL(base).hostname, path: '/' }]);
  const other = await context.newPage();
  await other.goto(`${base}/sign-in`, { waitUntil: 'domcontentloaded' });
  await other.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 90_000 });
  await other.locator('input[type="email"]').fill(email);
  await other.locator('input[type="password"]').fill(PASSWORD);
  await other.locator('button[type="submit"]').click();
  await other.waitForURL((url) => !/sign-in/.test(url.pathname), { timeout: 60_000 });
  return other;
}

const readOnly = [
  // ---------------------------------------------------------------- dashboard
  { name: 'fin-dashboard', path: '/dashboard', as: OWNER, ready: 'main h1', fullPage: true, act: settle },
  { name: 'fin-dashboard-accountant', path: '/dashboard', as: ACCOUNTANT, ready: 'main h1', fullPage: true, act: settle, variants: EN },

  // ---------------------------------------------------------------- quotations
  { name: 'fin-quotations', path: '/quotations', as: OWNER, ready: ROW },
  { name: 'fin-quotation-detail', path: '/quotations?status=SENT', as: OWNER, ready: ROW, act: openFirstRow, fullPage: true },
  { name: 'fin-quotation-new', path: '/quotations/new', as: RECEPTION, ready: 'main form', fullPage: true, act: settle, variants: EN_BOTH },

  // ---------------------------------------------------------------- invoices
  { name: 'fin-invoices', path: '/invoices', as: OWNER, ready: ROW },
  { name: 'fin-invoice-detail', path: '/invoices?status=PARTIALLY_PAID', as: OWNER, ready: ROW, act: openFirstRow, fullPage: true },
  { name: 'fin-invoice-draft', path: '/invoices?status=DRAFT', as: ACCOUNTANT, ready: ROW, act: openFirstRow, variants: EN },
  {
    name: 'fin-invoice-new',
    path: '/invoices/new',
    as: ACCOUNTANT,
    ready: 'main form',
    fullPage: true,
    act: async (page) => {
      await page.locator('input[name="items.0.description"]').fill('Typing of a tenancy contract');
      await page.locator('input[name="items.0.unitAmount"]').fill('120');
      await page.locator('input[name="items.0.discountAmount"]').fill('20');
      await page.getByRole('button', { name: /Government fee line|بند رسوم حكومية/ }).click();
      await page.locator('input[name="items.1.description"]').fill('Ejari registration fee');
      await page.locator('input[name="items.1.unitAmount"]').fill('220');
      await page.locator('input[name="items.1.unitAmount"]').blur();
    },
  },

  // ---------------------------------------------------------------- payments
  { name: 'fin-payments', path: '/payments', as: OWNER, ready: ROW },
  { name: 'fin-payment-detail', path: '/payments?status=PARTIALLY_REFUNDED', as: OWNER, ready: ROW, act: openFirstRow, fullPage: true },
  {
    name: 'fin-payment-new',
    path: '/invoices?status=PARTIALLY_PAID',
    as: RECEPTION,
    ready: ROW,
    fullPage: true,
    act: async (page) => {
      await openFirstRow(page);
      await page.locator('main header a[href^="/payments/new"]').click();
      await page.waitForURL(/\/payments\/new/);
      await page.locator('main form ul li input').first().waitFor();
    },
  },

  // ---------------------------------------------------------------- refunds
  { name: 'fin-refunds', path: '/refunds', as: OWNER, ready: ROW },
  { name: 'fin-refund-detail', path: '/refunds?status=COMPLETED', as: OWNER, ready: ROW, act: openFirstRow, fullPage: true },
  {
    // The approver's view of somebody else's request, with the approval dialog open (nothing is submitted).
    name: 'fin-refund-approval',
    path: '/refunds?status=REQUESTED',
    as: OWNER,
    ready: ROW,
    act: async (page) => {
      await openFirstRow(page);
      await page.locator('main header button').last().click();
      await page.getByRole('dialog').locator('form').waitFor();
      await settle(page);
    },
  },
  {
    name: 'fin-refund-new',
    path: '/payments?status=COMPLETED',
    as: ACCOUNTANT,
    ready: ROW,
    fullPage: true,
    variants: EN_BOTH,
    act: async (page) => {
      await openFirstRow(page);
      await page.locator('main header a[href^="/refunds/new"]').click();
      await page.waitForURL(/\/refunds\/new/);
      await page.locator('main form input[name="amount"]').waitFor();
      await settle(page);
    },
  },

  // ---------------------------------------------------------------- finance tools
  { name: 'fin-expenses', path: '/finance/expenses', as: ACCOUNTANT, ready: ROW },
  { name: 'fin-expense-dialog', path: '/finance/expenses?new=1', as: ACCOUNTANT, ready: '[role="dialog"] form', variants: EN_BOTH },
  { name: 'fin-liabilities', path: '/finance/liabilities', as: ACCOUNTANT, ready: ROW, fullPage: true },
  { name: 'fin-reconciliation', path: '/finance/reconciliation', as: ACCOUNTANT, ready: ROW },
  { name: 'fin-reconciliation-detail', path: '/finance/reconciliation', as: ACCOUNTANT, ready: ROW, act: openFirstRow, fullPage: true },
  { name: 'fin-fee-settings', path: '/finance/settings', as: OWNER, ready: 'main form', fullPage: true },

  // ---------------------------------------------------------------- reports
  { name: 'fin-reports', path: '/reports', as: OWNER, ready: 'main section a', fullPage: true },
  { name: 'fin-report-daily-sales', path: '/reports/daily-sales?range=last_30_days', as: OWNER, ready: RECORD, fullPage: true, act: settle },
  { name: 'fin-report-outstanding', path: '/reports/outstanding-payments', as: ACCOUNTANT, ready: RECORD, fullPage: true, act: settle, variants: EN_BOTH },
  { name: 'fin-report-requests', path: '/reports/requests-by-status', as: OWNER, ready: RECORD, fullPage: true, act: settle, variants: ['en-light-desktop', 'ar-dark-desktop'] },
  {
    name: 'fin-report-drilldown',
    path: '/reports/outstanding-payments',
    as: OWNER,
    ready: 'main table tbody tr',
    variants: EN,
    act: async (page) => {
      await page.locator('main table tbody tr').first().getByRole('button').click();
      await page.getByRole('dialog').locator('table tbody tr, ul li').first().waitFor();
      await settle(page);
    },
  },
  { name: 'fin-scheduled-reports', path: '/reports/scheduled', as: OWNER, ready: 'main h1', act: settle },
  { name: 'fin-schedule-dialog', path: '/reports/scheduled?new=daily-sales', as: OWNER, ready: '[role="dialog"] form', act: settle, variants: EN_BOTH },
  { name: 'fin-scheduled-not-in-plan', path: '/reports/scheduled', as: OWNER_TRIAL, ready: 'main h1', act: settle, variants: EN },

  // ---------------------------------------------------------------- subscription
  { name: 'fin-subscription', path: '/subscription', as: OWNER_PRO, ready: 'main h2', fullPage: true, act: settle },
  { name: 'fin-subscription-trial', path: '/subscription', as: OWNER_TRIAL, ready: 'main h2', fullPage: true, act: settle, variants: EN_BOTH },
  {
    // "Suspended for non-payment" without suspending a demo centre: the real GET /subscription answer is
    // rewritten in the browser (lapsed subscription, one overdue invoice). Only this page's own request is mocked.
    name: 'fin-subscription-suspended',
    path: '/subscription',
    as: OWNER_PRO,
    ready: 'main h2',
    fullPage: true,
    variants: EN_BOTH,
    act: async (page) => {
      await page.route('**/api/v1/subscription', async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const response = await route.fetch();
        const view = await response.json();
        const due = new Date(Date.now() - 12 * 86_400_000).toISOString();
        await route.fulfill({
          response,
          json: {
            ...view,
            tenantStatus: 'SUSPENDED',
            suspendedForNonPayment: true,
            pendingChange: null,
            subscription: { ...view.subscription, status: 'EXPIRED', graceEndsAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), cancelAtPeriodEnd: false },
            openInvoices: [{ id: '00000000-0000-4000-8000-00000000f1a7', number: 'TE-SUB-000099', reason: 'RENEWAL', total: view.subscription?.price ?? '349.00', currency: view.plan?.currency ?? 'AED', dueAt: due, overdue: true }],
          },
        });
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
      await page.getByText('TE-SUB-000099').first().waitFor();
      await settle(page);
    },
  },

  // ---------------------------------------------------------------- audit log
  { name: 'fin-audit-log', path: '/audit-log', as: OWNER, ready: RECORD },
  {
    name: 'fin-audit-entry',
    path: '/audit-log?action=invoice.',
    as: OWNER,
    ready: RECORD,
    variants: EN_BOTH,
    act: async (page) => {
      await page.locator('main table tbody tr:visible, main ul li:visible').first().getByRole('button').last().click();
      await page.getByRole('menuitem').first().click();
      await page.getByRole('dialog').locator('dl').first().waitFor();
      await settle(page);
    },
  },
];

// ====================================================================== flows (they write)

/**
 * Quotation from a request with a discount (receptionist) -> the discount is approved by somebody
 * else (owner) -> sent -> the customer's approval is recorded -> the invoice it created ->
 * a partial and a final payment with a receipt (receptionist) -> a refund requested by the
 * accountant and approved by the owner.
 *
 * Needs FIN_FLOW_REQUEST_ID: the id of a request of the Deira branch that has no quotation yet
 * (the flow moves that request on to "ready for processing"). Without it the scenario stops at once.
 */
const quoteToRefund = {
  name: 'flow-quote-to-refund',
  path: `/quotations/new?requestId=${process.env.FIN_FLOW_REQUEST_ID ?? ''}`,
  as: RECEPTION,
  ready: 'main h1',
  variants: EN,
  fullPage: true,
  act: async (page) => {
    const flow = 'flow-quote-to-refund';
    const base = new URL(page.url()).origin;
    if (!process.env.FIN_FLOW_REQUEST_ID) throw new Error('flow-quote-to-refund needs FIN_FLOW_REQUEST_ID (a request without a quotation)');

    // ---- 1. quotation from a request, with a discount that needs approval
    await page.locator('main form input[inputmode="decimal"]').first().waitFor();
    await page.locator('main form input[inputmode="decimal"]').first().fill('20');
    await page.locator('textarea[name="discountReason"]').fill('Returning customer (screenshot flow)');
    await step(page, flow, '01-quotation-form');
    await page.locator('main form button[type="submit"]').click();
    await page.waitForURL(/\/quotations\/[0-9a-f-]{36}$/);
    await page.locator('main h1').waitFor();
    await settle(page);
    const quotationUrl = page.url();
    await step(page, flow, '02-discount-waits-for-someone-else');

    // ---- 2. the owner approves the discount, sends the quotation and records the customer's approval
    const owner = await asUser(page, OWNER);
    await owner.goto(quotationUrl);
    await owner.getByRole('button', { name: 'Approve discount' }).first().click();
    await owner.getByRole('dialog').locator('textarea').fill('Agreed');
    await owner.getByRole('dialog').locator('button[type="submit"]').click();
    await owner.getByRole('button', { name: 'Send to customer' }).click();
    await owner.getByRole('alertdialog').getByRole('button', { name: 'Send to customer' }).click();
    await owner.getByRole('button', { name: /Record customer/ }).click();
    await owner.getByRole('dialog').locator('textarea').fill('Approved at the counter (screenshot flow)');
    await owner.getByRole('dialog').locator('button[type="submit"]').click();
    await owner.getByRole('link', { name: /Open invoice INV-/ }).first().waitFor();
    await settle(owner);
    await step(owner, flow, '03-quotation-approved');
    await owner.getByRole('link', { name: /Open invoice INV-/ }).first().click();
    await owner.waitForURL(/\/invoices\/[0-9a-f-]{36}$/);
    const invoiceUrl = owner.url();
    await owner.locator('main h1').waitFor();
    await settle(owner);
    await step(owner, flow, '04-invoice');

    // ---- 3. the receptionist records a partial payment (double click: still one payment), then the rest
    await page.goto(invoiceUrl);
    await page.getByRole('link', { name: 'Record payment' }).first().click();
    await page.locator('main form ul li input').first().waitFor();
    await page.locator('input[name="amount"]').fill('100');
    await page.locator('input[name="amount"]').blur();
    await step(page, flow, '05-partial-payment-form');
    await page.locator('main form button[type="submit"]').dblclick();
    await page.waitForURL(/\/payments\/[0-9a-f-]{36}/);
    await page.getByRole('button', { name: 'Print receipt' }).waitFor();
    await settle(page);
    await step(page, flow, '06-payment-recorded');
    await page.goto(`${base}/payments/new?invoiceId=${invoiceUrl.split('/').pop()}`);
    await page.locator('main form ul li input').first().waitFor();
    await page.locator('label', { hasText: 'Card terminal' }).click();
    await page.locator('input[name="reference"]').fill('POS slip 004512');
    await page.locator('main form button[type="submit"]').click();
    await page.waitForURL(/\/payments\/[0-9a-f-]{36}/);
    await page.getByRole('button', { name: 'Print receipt' }).waitFor();
    const paymentUrl = page.url().split('?')[0];

    // ---- 4. the accountant asks for a refund; the owner (somebody else) approves it and records the pay-out
    const accountant = await asUser(page, ACCOUNTANT);
    await accountant.goto(paymentUrl);
    await accountant.getByRole('link', { name: 'Request refund' }).click();
    await accountant.locator('input[name="amount"]').fill('25');
    await accountant.locator('textarea[name="reason"]').fill('Government fee was lower than estimated (screenshot flow)');
    await accountant.locator('label', { hasText: 'The charge is cancelled' }).click();
    await step(accountant, flow, '07-refund-form');
    await accountant.locator('main form button[type="submit"]').click();
    await accountant.waitForURL(/\/refunds\/[0-9a-f-]{36}$/);
    const refundUrl = accountant.url();
    await accountant.locator('main h1').waitFor();
    await settle(accountant);
    await step(accountant, flow, '08-refund-waits-for-someone-else');
    await accountant.context().close();

    await owner.goto(refundUrl);
    await owner.getByRole('button', { name: 'Approve refund' }).click();
    await owner.getByRole('dialog').locator('button[type="submit"]').click();
    await owner.getByRole('button', { name: 'Record pay-out' }).click();
    await owner.getByRole('dialog').locator('input').fill('Cash voucher (screenshot flow)');
    await owner.getByRole('dialog').locator('button[type="submit"]').click();
    await owner.getByRole('button', { name: /Credit note CN-/ }).waitFor();
    await settle(owner);
    await step(owner, flow, '09-refund-completed');
    await owner.context().close();

    await page.goto(invoiceUrl);
    await page.locator('main h1').waitFor();
    await settle(page);
  },
};

/** Runs a report with another period, opens the records behind a figure, exports it and schedules it. */
const reports = {
  name: 'flow-reports',
  path: '/reports',
  as: OWNER,
  ready: 'main section a',
  variants: EN,
  act: async (page) => {
    const flow = 'flow-reports';
    await page.getByRole('link', { name: /Daily sales/ }).click();
    await page.locator('main table').first().waitFor();
    await page.getByRole('combobox', { name: 'Period' }).click();
    await page.getByRole('option', { name: 'Last 30 days' }).click();
    await page.waitForURL(/range=last_30_days/);
    await settle(page);
    await step(page, flow, '01-daily-sales-30-days');
    await page.locator('main table tbody tr').last().getByRole('button').click();
    await page.getByRole('dialog').locator('table tbody tr, ul li').first().waitFor();
    await step(page, flow, '02-records-behind-a-day');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Export' }).click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /Excel/ }).click()]);
    console.log(`  exported ${download.suggestedFilename()}`);
    await page.getByRole('link', { name: 'Send by email on a schedule' }).click();
    const form = page.getByRole('dialog');
    await form.locator('form').waitFor();
    await form.getByRole('combobox', { name: /How often/ }).click();
    await page.getByRole('option', { name: 'Every week' }).click();
    await step(page, flow, '03-schedule-form');
    await form.locator('button[type="submit"]').click();
    await form.waitFor({ state: 'hidden' });
    await page.locator(ROW).first().waitFor();
    await settle(page);
  },
};

export default [...readOnly, quoteToRefund, reports];
