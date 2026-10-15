/**
 * Screenshot scenarios of the "ops" section (service catalogue, workflows, appointments, queue,
 * reminders, support, notifications, automations). Run from the repository root:
 *
 *   export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
 *   node packages/ui/scripts/screenshots.mjs --app centre --scenarios apps/centre-web/scripts/shots-ops.mjs --out /tmp/shots-ops [--only ops-services]
 *
 * Scenarios whose name ends in "-flow" drive a real flow through the UI and the API (they create records).
 */
const OWNER = 'owner@al-noor.test';
const RECEPTION = 'reception.dubai@al-noor.test';
const DESKTOP = ['en-light-desktop'];
const ALL = ['en-light-desktop', 'ar-dark-desktop', 'en-light-mobile'];
const API = process.env.SHOTS_API ?? 'http://localhost:4000/api/v1';

/** Signs in against the API (for scenarios that need an id or a display token before the page opens). */
async function apiSession(email = OWNER) {
  const res = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client-App': 'centre', 'X-Requested-With': 'typease' }, body: JSON.stringify({ email, password: 'TypEase-Demo-2026', app: 'centre' }) });
  const { accessToken } = await res.json();
  const call = async (method, path, body) => {
    const r = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'X-Client-App': 'centre', 'X-Requested-With': 'typease' }, body: body ? JSON.stringify(body) : undefined });
    return r.json();
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), del: (p) => call('DELETE', p) };
}

const stamp = Date.now().toString(36).slice(-5).toUpperCase();

/** Extra pictures inside a flow: <out>/centre-<name>.png next to the scenario's own picture. */
const outDir = (() => {
  const i = process.argv.indexOf('--out');
  return i >= 0 ? process.argv[i + 1] : 'docs/brand/screenshots';
})();
async function snap(page, name, fullPage = true) {
  await page.evaluate(() => document.fonts.ready);
  // A full-page picture is stitched from the top: go back there first (the shell header is sticky).
  if (fullPage) await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${outDir}/centre-${name}.png`, fullPage, animations: 'disabled' });
}

// Ids the scenarios need before a page opens (read once through the API).
const session = await apiSession();
const bundle = (await session.get('/services?q=AN-MEDICAL-BUNDLE&pageSize=1')).data?.[0];
const serviceTab = (tab) => `/services/${bundle?.id}?tab=${tab}`;
const branchDxb = (await session.get('/branches')).find?.((b) => b.code === 'DXB');
const displayLink = branchDxb ? await session.post('/queue/display-tokens', { branchId: branchDxb.id, validDays: 2 }) : null;
const displayPath = `/queue-display?token=${encodeURIComponent(displayLink?.token ?? '')}`;
const BASE = 'http://localhost:3001';
const tickets = (await session.get('/support/tickets?pageSize=50')).data ?? [];
const ticketOpen = tickets.find((x) => x.ticketNo === 'TKT-000007') ?? tickets.find((x) => x.status === 'OPEN');
const ticketWithNote = tickets.find((x) => x.ticketNo === 'TKT-000005') ?? tickets[0];
const ticketRated = tickets.find((x) => x.ticketNo === 'TKT-000001') ?? tickets[0];
const platformTicket = ((await session.get('/support/platform-tickets')).data ?? [])[0];
const standardWorkflow = (await session.get('/workflows')).find?.((w) => w.key === 'standard');

const automationRule = ((await session.get('/automations?pageSize=50')).data ?? []).find((r) => r.name === 'Tell managers about new appointments');
const automationExecution = ((await session.get('/automations/executions?pageSize=1')).data ?? [])[0];

// The two builders need a draft to show. For their scenarios only, a draft copy of the published form of the bundle
// service and of the standard workflow is created through the API; "ops-builders-cleanup" discards both again.
const only = (() => {
  const i = process.argv.indexOf('--only');
  return i >= 0 ? process.argv[i + 1].split(',') : [];
})();
let formDraft = null;
let workflowDraft = null;
if (only.some((n) => n.startsWith('ops-form-builder') || n.startsWith('ops-workflow-builder') || n === 'ops-builders-cleanup')) {
  const forms = bundle ? await session.get(`/services/${bundle.id}/forms`) : [];
  formDraft = forms.find?.((f) => f.status === 'DRAFT') ?? null;
  const drafts = standardWorkflow ? await session.get(`/workflows/${standardWorkflow.id}/versions`) : [];
  workflowDraft = drafts.find?.((v) => v.status === 'DRAFT') ?? null;
  if (!only.includes('ops-builders-cleanup')) {
    if (!formDraft && bundle) {
      const published = forms.find?.((f) => f.status === 'PUBLISHED');
      const schema = published ? (await session.get(`/services/${bundle.id}/forms/${published.id}`)).schema : undefined;
      formDraft = await session.post(`/services/${bundle.id}/forms`, schema ? { schema } : {});
    }
    if (!workflowDraft && standardWorkflow) workflowDraft = await session.post(`/workflows/${standardWorkflow.id}/versions`, {});
  }
}

export default [
  // ------------------------------------------------------------------ services
  { name: 'ops-services', path: '/services', as: OWNER, ready: 'main ul li a:visible', variants: ALL },
  { name: 'ops-services-reception', path: '/services', as: RECEPTION, ready: 'main ul li a:visible', variants: DESKTOP },
  {
    name: 'ops-services-categories',
    path: '/services',
    as: OWNER,
    ready: 'main ul li a:visible',
    variants: ['en-light-desktop', 'ar-dark-desktop'],
    act: async (page) => {
      await page.locator('main header button').nth(0).click();
      await page.getByRole('dialog').locator('ul li').first().waitFor();
    },
  },
  {
    name: 'ops-services-document-types',
    path: '/services',
    as: OWNER,
    ready: 'main ul li a:visible',
    variants: DESKTOP,
    act: async (page) => {
      await page.locator('main header button').nth(1).click();
      await page.getByRole('dialog').locator('ul li').first().waitFor();
    },
  },
  { name: 'ops-service-basics', path: serviceTab('basics'), as: OWNER, ready: '[role="tablist"]', variants: ['ar-dark-desktop', 'en-light-mobile'], fullPage: true },
  {
    name: 'ops-service-compliance',
    path: serviceTab('compliance'),
    as: OWNER,
    ready: '[role="radiogroup"]',
    variants: ALL,
    fullPage: true,
    act: async (page) => {
      // Choosing "Direct authorised processing" without a verified authorisation: the API's requirement message appears.
      await page.locator('[role="radio"]').nth(3).click();
      await page.locator('main [role="tabpanel"] button').last().click();
      await page.locator('main [role="alert"]').first().waitFor();
    },
  },
  { name: 'ops-service-pricing', path: serviceTab('pricing'), as: OWNER, ready: 'main dl >> nth=1', variants: ALL, fullPage: true },
  { name: 'ops-service-documents', path: serviceTab('documents'), as: OWNER, ready: 'main ol li', variants: ALL, fullPage: true },
  { name: 'ops-service-form-published', path: serviceTab('form'), as: OWNER, ready: 'main table tbody tr', variants: ALL, fullPage: true },
  { name: 'ops-service-workflow', path: serviceTab('workflow'), as: OWNER, ready: 'main ol li', variants: ALL, fullPage: true },
  {
    // Creates a service with a price, adds a required document, builds and publishes a form, previews it.
    name: 'ops-service-create-flow',
    path: '/services',
    as: OWNER,
    ready: 'main ul li a:visible',
    variants: DESKTOP,
    fullPage: true,
    act: async (page) => {
      await page.locator('main header button').nth(2).click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      await dialog.locator('input').nth(0).fill(`Salary certificate typing ${stamp}`);
      await dialog.locator('input').nth(1).fill('طباعة شهادة راتب');
      await dialog.getByRole('combobox').first().click();
      await page.getByRole('option').first().click();
      await dialog.locator('input').nth(2).fill(`SAL-${stamp}`);
      await dialog.locator('input[inputmode="decimal"]').nth(0).fill('85');
      await dialog.locator('input[inputmode="decimal"]').nth(1).fill('20');
      await snap(page, 'ops-flow-service-1-add-dialog', false);
      await dialog.locator('button[type="submit"]').click();
      await page.waitForURL(/\/services\/[0-9a-f-]{36}/, { timeout: 30_000 });
      await page.locator('[role="tablist"]').waitFor();

      // Required documents
      await page.getByRole('tab', { name: 'Required documents' }).click();
      await page.getByRole('button', { name: 'Add document' }).first().click();
      const doc = page.getByRole('dialog');
      await doc.getByRole('combobox').click();
      await page.getByRole('option', { name: /Passport/ }).first().click();
      await doc.locator('textarea').fill('Valid for at least 6 months');
      await doc.locator('button[type="submit"]').click();
      await doc.waitFor({ state: 'hidden' });
      await page.locator('main ol li').first().waitFor();
      await snap(page, 'ops-flow-service-2-documents');

      // Form: start, two fields (one shown on a condition), save, publish
      await page.getByRole('tab', { name: 'Form', exact: true }).click();
      await page.getByRole('button', { name: 'Start a form' }).click();
      await page.getByRole('button', { name: 'Add field' }).click();
      await page.getByRole('menuitem').filter({ hasText: 'Radio buttons' }).click();
      await page.getByLabel('Label (English)').fill('Who is the certificate for');
      await page.getByLabel('Label (Arabic)').fill('لمن الشهادة');
      await page.getByPlaceholder('Choice (English)').first().fill('A bank');
      await page.getByPlaceholder('Choice (Arabic)').first().fill('بنك');
      await page.getByRole('button', { name: 'Add choice' }).click();
      await page.getByPlaceholder('Choice (English)').nth(1).fill('An embassy');
      await page.getByPlaceholder('Choice (Arabic)').nth(1).fill('سفارة');
      await page.getByRole('switch').first().click();
      await page.getByRole('button', { name: 'Add field' }).click();
      await page.getByRole('menuitem').filter({ hasText: 'Short text' }).click();
      await page.getByLabel('Label (English)').fill('Name of the bank');
      await page.getByLabel('Label (Arabic)').fill('اسم البنك');
      await page.getByLabel('Show this field').click();
      await page.getByRole('option', { name: 'Who is the certificate for' }).click();
      await snap(page, 'ops-flow-service-3-form-builder');
      await page.getByRole('button', { name: 'Save draft' }).click();
      await page.getByText('All changes are saved.').waitFor();
      // Try the preview: the second field appears only for "A bank".
      await page.getByRole('radio', { name: 'A bank' }).click();
      await page.getByRole('button', { name: 'Check answers' }).click();
      await snap(page, 'ops-flow-service-4-form-preview');
      await page.getByRole('button', { name: 'Publish', exact: true }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Publish', exact: true }).click();
      await page.getByText(/Published form, version/).waitFor();
      await page.waitForTimeout(600);
    },
  },

  // ------------------------------------------------------------------ workflows
  { name: 'ops-workflows', path: '/workflows', as: OWNER, ready: 'main ul li a:visible', variants: ALL, fullPage: true },
  { name: 'ops-workflow-published', path: `/workflows/${standardWorkflow?.id}`, as: OWNER, ready: 'main ol li', variants: ALL, fullPage: true },
  { name: 'ops-workflow-versions', path: `/workflows/${standardWorkflow?.id}?tab=versions`, as: OWNER, ready: 'main table tbody tr', variants: DESKTOP },
  {
    // Create from a template, edit the draft, hit a validation error, fix it, publish.
    name: 'ops-workflow-flow',
    path: '/workflows',
    as: OWNER,
    ready: 'main ul li a:visible',
    variants: DESKTOP,
    act: async (page) => {
      await page.getByRole('button', { name: 'Use this template' }).first().click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Name').fill(`Attestation express ${stamp}`);
      await snap(page, 'ops-flow-workflow-1-new', false);
      await dialog.locator('button[type="submit"]').click();
      await page.waitForURL(/\/workflows\/[0-9a-f-]{36}/, { timeout: 30_000 });
      await page.getByRole('button', { name: 'Check for problems' }).waitFor();
      // Break a rule: the Completion step must be the last one.
      await page.getByRole('button', { name: /^Move Final review and completion up$/ }).click();
      await page.getByRole('button', { name: 'Check for problems' }).click();
      await page.locator('main [role="alert"]').first().waitFor();
      await page.locator('main ol li [role="alert"]').first().scrollIntoViewIfNeeded();
      await snap(page, 'ops-flow-workflow-2-validation', false);
      // Fix it, then change a step: a time limit with escalation, and a condition.
      await page.getByRole('button', { name: /^Move Final review and completion down$/ }).click();
      await page.getByRole('button', { name: /^Edit step Prepare application$/ }).click();
      await page.getByLabel('Time limit (hours)').fill('36');
      await page.getByRole('button', { name: 'Add a condition' }).click();
      await page.getByLabel('What changed in this version').fill('Shorter time limit for preparation');
      await page.getByRole('button', { name: /^Edit step Prepare application$|^Close the editor of Prepare application$/ }).scrollIntoViewIfNeeded();
      await snap(page, 'ops-flow-workflow-3-step-editor', false);
      await page.getByRole('button', { name: 'Save draft' }).click();
      await page.getByText('All changes are saved.').waitFor();
      await page.getByRole('button', { name: 'Publish', exact: true }).click();
      await snap(page, 'ops-flow-workflow-4-publish-confirm', false);
      await page.getByRole('alertdialog').getByRole('button', { name: 'Publish', exact: true }).click();
      await page.getByText(/Version 1, in use/).waitFor();
      await page.waitForTimeout(500);
    },
  },

  // ------------------------------------------------------------------ appointments and queue
  { name: 'ops-appointments-day', path: '/appointments', as: OWNER, ready: 'main [role="tabpanel"] ul li, main [role="tabpanel"] p', variants: ALL },
  { name: 'ops-appointments-week', path: '/appointments?view=week', as: OWNER, ready: 'main [role="tabpanel"] section', variants: ALL, fullPage: true },
  { name: 'ops-appointments-settings', path: '/appointments?tab=settings', as: OWNER, ready: 'main [role="tabpanel"] ul li', variants: ALL, fullPage: true },
  { name: 'ops-appointments-reception', path: '/appointments', as: RECEPTION, ready: 'main [role="tabpanel"] ul li, main [role="tabpanel"] p', variants: DESKTOP },
  {
    name: 'ops-appointments-book-dialog',
    path: '/appointments',
    as: OWNER,
    ready: 'main [role="tabpanel"]',
    variants: ['ar-dark-desktop', 'en-light-mobile'],
    act: async (page) => {
      await page.locator('main header button').last().click();
      await page.getByRole('dialog').locator('[role="radiogroup"] button[role="radio"]').nth(3).waitFor({ timeout: 20_000 });
    },
  },
  { name: 'ops-queue', path: '/queue', as: OWNER, ready: 'main [role="tabpanel"] h2', variants: ALL, fullPage: true },
  { name: 'ops-queue-report', path: '/queue?tab=report', as: OWNER, ready: 'main [role="tabpanel"] dl, main [role="tabpanel"] p', variants: ALL, fullPage: true },
  { name: 'ops-queue-display-links', path: '/queue?tab=display', as: OWNER, ready: 'main [role="tabpanel"] form', variants: DESKTOP,
    act: async (page) => {
      await page.locator('main [role="tabpanel"] form button[type="submit"]').click();
      await page.locator('main [role="tabpanel"] svg[role="img"]').waitFor();
    },
  },
  { name: 'ops-queue-display', path: displayPath, ready: 'main h2', variants: ['en-light-desktop', 'ar-dark-desktop', 'en-light-mobile'] },
  { name: 'ops-queue-display-invalid', path: '/queue-display?token=not-a-valid-display-token-000000', ready: 'main p', variants: DESKTOP },
  {
    // Book a guest appointment, check in (a queue token is issued), call it at counter 7, see it on the public display, finish it.
    name: 'ops-appointment-queue-flow',
    path: '/appointments',
    as: OWNER,
    ready: 'main [role="tabpanel"]',
    variants: DESKTOP,
    act: async (page) => {
      const guest = `Guest ${stamp}`;
      await page.getByRole('button', { name: 'Book appointment' }).first().click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('radio', { name: 'A guest (name and phone)' }).click();
      await dialog.getByLabel('Visitor’s name').fill(guest);
      await dialog.locator('input[type="tel"]').fill('50 555 0' + String(Date.now()).slice(-3));
      await dialog.getByRole('combobox', { name: /Service/ }).click();
      await page.getByPlaceholder('Search services').fill('attestation');
      await page.getByRole('option', { name: /Certificate attestation/ }).waitFor();
      await page.keyboard.press('Enter');
      await dialog.locator('[role="radiogroup"][aria-label="Free times"] button:not([disabled])').first().click();
      await snap(page, 'ops-flow-queue-1-booking', false);
      await dialog.locator('button[type="submit"]').click();
      await dialog.waitFor({ state: 'hidden' });
      const row = page.locator('main li', { hasText: guest });
      await row.waitFor();
      await row.getByRole('button', { name: 'Check in' }).click();
      await page.getByText(/Checked in\. Queue token/).waitFor();
      await snap(page, 'ops-flow-queue-2-checked-in', false);

      await page.goto(`${BASE}/queue`);
      await page.locator('main input[placeholder="1"]').fill('7');
      await page.getByRole('combobox', { name: 'Service category' }).click();
      await page.getByRole('option', { name: /Attestation/ }).click();
      await page.getByRole('button', { name: 'Call next' }).click();
      await page.getByText(/please come to counter 7/).waitFor();
      await snap(page, 'ops-flow-queue-3-called', false);

      const display = await page.context().newPage();
      await display.goto(`${BASE}${displayPath}`);
      await display.locator('main li', { hasText: '7' }).first().waitFor();
      await snap(display, 'ops-flow-queue-4-display', false);
      await display.close();

      // Serve and finish, so the demo queue is left tidy.
      const mine = page.locator('main li', { hasText: 'Calling now' });
      await mine.getByRole('button', { name: 'Start serving' }).click();
      await page.getByText(/^Serving /).first().waitFor();
      await page.locator('main li', { hasText: 'Being served' }).first().getByRole('button', { name: 'Done' }).click();
      await page.getByText(/ served$/).first().waitFor();
      await page.waitForTimeout(500);
    },
  },

  // ------------------------------------------------------------------ support
  { name: 'ops-support', path: '/support', as: OWNER, ready: 'main table tbody tr a:visible, main ul li a:visible', variants: ALL },
  { name: 'ops-support-ticket', path: `/support/${ticketWithNote?.id}`, as: OWNER, ready: 'main ol li', variants: ALL, fullPage: true },
  { name: 'ops-support-ticket-rated', path: `/support/${ticketRated?.id}`, as: OWNER, ready: 'main ol li', variants: DESKTOP, fullPage: true },
  { name: 'ops-support-feedback', path: '/support?tab=feedback', as: OWNER, ready: 'main table tbody tr:visible, main ul li:visible', variants: ['en-light-desktop', 'ar-dark-desktop'], fullPage: true },
  { name: 'ops-support-sla', path: '/support?tab=sla', as: OWNER, ready: 'main form ul li', variants: ALL, fullPage: true },
  { name: 'ops-support-platform', path: '/support/platform', as: OWNER, ready: 'main table tbody tr a:visible, main ul li a:visible', variants: ['en-light-desktop', 'ar-dark-desktop'] },
  { name: 'ops-support-platform-ticket', path: `/support/platform/${platformTicket?.id}`, as: OWNER, ready: 'main ol li', variants: ['en-light-desktop', 'en-light-mobile'], fullPage: true },
  {
    // A ticket opened by staff about one of the customer's requests: the request is found by its number and linked on the ticket.
    name: 'ops-support-new-ticket-flow',
    path: '/support',
    as: OWNER,
    ready: 'main table tbody tr',
    variants: DESKTOP,
    act: async (page) => {
      await page.getByRole('button', { name: 'New ticket' }).first().click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('combobox', { name: /Customer/ }).click();
      await page.getByPlaceholder(/Search/).last().fill('Layla Demo');
      await page.getByRole('option').first().waitFor();
      await page.keyboard.press('Enter');
      await dialog.getByRole('combobox', { name: /About which request/ }).click();
      await page.getByRole('option').first().waitFor();
      await snap(page, 'ops-flow-support-2-request-search', false);
      await page.keyboard.press('Enter');
      await dialog.getByLabel('Subject').fill(`Question about the residence file (${stamp})`);
      await dialog.getByLabel(/What the customer said|Message/).first().fill('The customer called to ask when the file will be handed over.');
      await dialog.locator('button[type="submit"]').click();
      await page.waitForURL(/\/support\/[0-9a-f-]{36}$/);
      await page.locator('main ol li').first().waitFor();
      await page.waitForTimeout(500);
    },
  },
  {
    // An internal note first, then a reply the customer can see.
    name: 'ops-support-reply-flow',
    path: `/support/${ticketOpen?.id}`,
    as: OWNER,
    ready: 'main ol li',
    variants: DESKTOP,
    fullPage: true,
    act: async (page) => {
      await page.getByRole('switch', { name: 'Internal note' }).click();
      await page.getByLabel('Your note').fill(`Checked with the operator: the file is complete. (note ${stamp})`);
      await snap(page, 'ops-flow-support-1-internal-note');
      await page.getByRole('button', { name: 'Add internal note' }).click();
      await page.getByText(`(note ${stamp})`).waitFor();
      await page.getByLabel('Your reply').fill(`Thank you for your message. Your file is complete and we will update you today. (reply ${stamp})`);
      await page.getByRole('button', { name: 'Send reply to customer' }).click();
      await page.locator('main ol li', { hasText: `(reply ${stamp})` }).waitFor();
      await page.waitForTimeout(500);
    },
  },

  // ------------------------------------------------------------------ reminders
  { name: 'ops-reminders', path: '/reminders', as: OWNER, ready: 'main table tbody tr button:visible, main ul li button:visible', variants: ALL },
  {
    name: 'ops-reminders-detail',
    path: '/reminders?withinDays=30',
    as: OWNER,
    ready: 'main table tbody tr button:visible, main ul li button:visible',
    variants: ['en-light-desktop', 'ar-dark-desktop', 'en-light-mobile'],
    act: async (page) => {
      await page.locator('main table tbody tr button:visible, main ul li button:visible').first().click();
      await page.getByRole('dialog').locator('dl').waitFor();
      await page.waitForTimeout(400);
    },
  },
  {
    // Add a schedule by hand, pause it, create the renewal link, stop it.
    name: 'ops-reminders-flow',
    path: '/reminders',
    as: OWNER,
    ready: 'main table tbody tr button:visible',
    variants: DESKTOP,
    act: async (page) => {
      const label = `Test labour card ${stamp}`;
      await page.getByRole('button', { name: 'Add reminder' }).first().click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('combobox', { name: /Customer/ }).click();
      await page.getByRole('option').first().waitFor();
      await page.keyboard.press('Enter');
      await dialog.getByRole('combobox', { name: /Document/ }).click();
      await page.getByPlaceholder('Search document types').fill('labour');
      await page.getByRole('option').first().waitFor();
      await page.keyboard.press('Enter');
      const soon = new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10);
      await dialog.locator('input[type="date"]').fill(soon);
      await dialog.getByLabel(/shown in the reminder/).fill(label);
      await snap(page, 'ops-flow-reminders-1-add', false);
      await dialog.locator('button[type="submit"]').click();
      await dialog.waitFor({ state: 'hidden' });
      await page.locator('main').getByRole('searchbox').fill(label);
      await page.locator('main table tbody tr button', { hasText: label }).click();
      const sheet = page.getByRole('dialog');
      await sheet.getByRole('button', { name: 'Pause' }).click();
      await sheet.getByRole('button', { name: 'Resume' }).waitFor();
      await sheet.getByRole('button', { name: 'Create renewal link' }).click();
      await sheet.getByRole('button', { name: 'Copy the renewal link' }).waitFor();
      await snap(page, 'ops-flow-reminders-2-paused-link', false);
      await sheet.getByRole('button', { name: 'Stop for good' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Stop for good' }).click();
      await page.getByRole('alertdialog').waitFor({ state: 'hidden' });
      await page.waitForTimeout(500);
    },
  },
  // ------------------------------------------------------------------ notifications
  { name: 'ops-inbox', path: '/notifications', as: OWNER, ready: 'main ul li, main [data-empty], main h3', variants: ALL },
  {
    // One notification marked as read (the bell follows), then the deep link of a reply from TypEase support.
    name: 'ops-inbox-flow',
    path: '/notifications',
    as: OWNER,
    ready: 'main ul li',
    variants: DESKTOP,
    act: async (page) => {
      const unread = async () => Number((await page.locator('header [aria-label*="otification"] >> xpath=..').first().innerText().catch(() => '0')).replace(/\D/g, '') || 0);
      const before = await unread();
      const first = page.locator('main ul li', { has: page.getByRole('button', { name: 'Mark as read' }) }).first();
      if (await first.count()) {
        await first.getByRole('button', { name: 'Mark as read' }).click();
        await page.waitForTimeout(1500);
      }
      console.log(`      bell before ${before}, after ${await unread()}`);
      await snap(page, 'ops-flow-inbox-1-marked', false);
      const link = page.locator('main ul li a', { hasText: 'Reply to ticket' }).first();
      if (await link.count()) {
        await link.click();
        await page.waitForURL(/\/support\/platform\//);
        await page.locator('main h1').waitFor();
        await page.waitForTimeout(800);
      }
    },
  },
  {
    name: 'ops-inbox-mark-all',
    path: '/notifications',
    as: 'manager@al-noor.test',
    ready: 'main ul li, main h3',
    variants: DESKTOP,
    act: async (page) => {
      await snap(page, 'ops-flow-inbox-2-manager-before', false);
      const all = page.getByRole('button', { name: 'Mark all as read' });
      if (await all.isEnabled()) {
        await all.click();
        await page.getByText('All notifications marked as read').waitFor();
        await page.waitForTimeout(1200);
      }
    },
  },
  { name: 'ops-notify-channels', path: '/notification-settings', as: OWNER, ready: 'main [role="switch"]:visible', variants: ALL, fullPage: true },
  { name: 'ops-notify-templates', path: '/notification-settings?tab=templates', as: OWNER, ready: 'main textarea', variants: ['en-light-desktop', 'en-light-mobile'], fullPage: true },
  {
    name: 'ops-notify-templates-ar',
    path: '/notification-settings?tab=templates&event=appointment.reminder&channel=WHATSAPP&lang=ar',
    as: OWNER,
    ready: 'main textarea',
    variants: ['ar-dark-desktop'],
    fullPage: true,
    act: async (page) => {
      await page.locator('main button:has(svg.lucide-eye)').click();
      await page.locator('main p.whitespace-pre-wrap').waitFor();
    },
  },
  { name: 'ops-notify-log', path: '/notification-settings?tab=log', as: OWNER, ready: 'main table tbody tr button:visible, main ul li button:visible', variants: ALL },
  {
    name: 'ops-notify-log-detail',
    path: '/notification-settings?tab=log',
    as: OWNER,
    ready: 'main table tbody tr button:visible',
    variants: DESKTOP,
    act: async (page) => {
      await page.locator('main table tbody tr button:visible').first().click();
      await page.getByRole('dialog').locator('dl').waitFor();
      await page.waitForTimeout(400);
    },
  },
  { name: 'ops-notify-failures', path: '/notification-settings?tab=failures', as: OWNER, ready: 'main table tbody tr button:visible, main ul li button:visible', variants: ['en-light-desktop', 'ar-dark-desktop'] },
  {
    // One switch of the matrix on and off again (the setting ends as it started), then a failed message is sent again.
    name: 'ops-notify-matrix-retry-flow',
    path: '/notification-settings',
    as: OWNER,
    ready: 'main [role="switch"]:visible',
    variants: DESKTOP,
    act: async (page) => {
      const toggle = page.getByRole('switch', { name: 'Staff assigned: Email' }).first();
      const before = await toggle.getAttribute('aria-checked');
      await toggle.click();
      await page.getByText(/Staff assigned is (now|no longer) sent by Email/).first().waitFor();
      await page.waitForTimeout(1200);
      await page.getByRole('switch', { name: 'Staff assigned: Email' }).first().click();
      await page.waitForTimeout(1500);
      console.log(`      matrix switch before ${before}, after ${await page.getByRole('switch', { name: 'Staff assigned: Email' }).first().getAttribute('aria-checked')}`);
      await page.getByRole('tab', { name: 'Failures' }).click();
      await page.locator('main table tbody tr').first().waitFor();
      await page.locator('main table tbody tr').first().getByRole('button').last().click();
      await page.getByRole('menuitem', { name: 'Send again' }).click();
      await page.getByText('Sending again').waitFor();
      await page.waitForTimeout(500);
    },
  },
  {
    // Change the wording of an email, preview it with example values, save it, then go back to the standard wording.
    name: 'ops-notify-template-flow',
    path: '/notification-settings?tab=templates&event=request.completed&channel=EMAIL&lang=en',
    as: OWNER,
    ready: 'main textarea',
    variants: DESKTOP,
    fullPage: true,
    act: async (page) => {
      const subject = page.getByLabel('Subject');
      await subject.fill(`Your application is ready, {{customerName}} (${stamp})`);
      const body = page.locator('main textarea');
      await body.focus();
      await page.keyboard.press('Control+End');
      await page.keyboard.type('\n\nThank you for choosing ');
      await page.getByRole('button', { name: '{{centreName}}' }).click();
      await page.getByRole('button', { name: 'Preview' }).click();
      await page.locator('main iframe').waitFor();
      await page.waitForTimeout(800);
      await snap(page, 'ops-flow-template-1-preview');
      await page.getByRole('button', { name: 'Save changes' }).click();
      await page.getByText('Your wording', { exact: true }).waitFor();
      await snap(page, 'ops-flow-template-2-saved');
      await page.getByRole('button', { name: 'Back to the standard wording' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Back to the standard wording' }).click();
      await page.getByText('Standard wording', { exact: true }).waitFor();
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(500);
    },
  },
  // ------------------------------------------------------------------ automations
  { name: 'ops-automations', path: '/automations', as: OWNER, ready: 'main section ul li button', variants: ALL, fullPage: true },
  { name: 'ops-automations-plan', path: '/automations', as: 'owner@desert-rose.test', ready: 'main section ul li button', variants: DESKTOP },
  { name: 'ops-automation-new', path: '/automations/new', as: OWNER, ready: 'main input', variants: ['en-light-desktop', 'en-light-mobile'], fullPage: true },
  {
    // A new rule saved without a name or an action: the same messages the API would give, next to the fields.
    name: 'ops-automation-validation',
    path: '/automations/new',
    as: OWNER,
    ready: 'main input',
    variants: DESKTOP,
    fullPage: true,
    act: async (page) => {
      await page.getByRole('button', { name: 'Add action' }).click();
      await page.getByRole('menuitem', { name: 'Send a message' }).click();
      await page.getByRole('button', { name: 'Create automation' }).first().click();
      await page.locator('main [role="alert"]').first().waitFor();
    },
  },
  {
    // Every action form at once, with a condition, on an event that carries a request, a customer and a document.
    name: 'ops-automation-actions',
    path: '/automations/new',
    as: OWNER,
    ready: 'main input',
    variants: ['en-light-desktop', 'ar-dark-desktop', 'en-light-mobile'],
    fullPage: true,
    act: async (page) => {
      // Selectors that do not depend on the language, so the same steps run in Arabic.
      await page.locator('main button[role="combobox"]').first().click();
      await page.getByRole('option').nth(4).click(); // "A document was verified"
      await page.locator('main button:has(svg.lucide-plus):not([aria-haspopup])').first().click(); // add a condition
      for (let i = 0; i < 10; i += 1) {
        try {
          await page.locator('main button[aria-haspopup="menu"]:has(svg.lucide-plus)').first().click({ timeout: 8000 });
          await page.getByRole('menuitem').nth(i).click({ timeout: 8000 });
          await page.locator('main ol li[data-action]').nth(i).waitFor({ timeout: 8000 });
          await page.waitForTimeout(400); // the menu finishes closing before it is opened again
        } catch (e) {
          console.log(`      action ${i}: ${String(e.message).slice(0, 900)}`);
          throw e;
        }
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(500);
    },
  },
  {
    // A webhook action without an n8n connection can be saved but not switched on: the API's reason appears on the path field. Then: leaving with unsaved changes asks first.
    name: 'ops-automation-problems',
    path: '/automations/new',
    as: OWNER,
    ready: 'main input',
    variants: DESKTOP,
    fullPage: true,
    act: async (page) => {
      await page.getByLabel('Name of the automation').fill(`Webhook test ${stamp}`);
      await page.getByRole('button', { name: 'Add action' }).click();
      await page.getByRole('menuitem', { name: 'Call n8n / a webhook' }).click();
      await page.locator('main ol li[data-action] input[placeholder="/typease/new-request"]').fill('/typease/test');
      await page.getByRole('button', { name: 'Create automation' }).first().click();
      // It is saved (switched off) and opens under its own address; the API's reason why it cannot run is on the path field.
      await page.waitForURL(/\/automations\/[0-9a-f-]{36}$/);
      const id = page.url().split('/').pop();
      try {
        await page.getByRole('switch', { name: /Switch on/ }).click();
        await page.locator('main ol li[data-action] [role="alert"]').first().waitFor();
        await page.getByText('It cannot be switched on yet').first().waitFor();
        await snap(page, 'ops-flow-automation-problem');
        await page.getByLabel('Name of the automation').fill(`Webhook test ${stamp} changed`);
        await page.locator('main nav a', { hasText: 'Automations' }).first().click();
        await page.getByRole('alertdialog').getByText('Leave without saving?').waitFor();
        await snap(page, 'ops-flow-automation-leave', false);
        await page.getByRole('alertdialog').getByRole('button', { name: 'Stay on this page' }).click();
        await page.getByRole('alertdialog').waitFor({ state: 'hidden' });
        await page.evaluate(() => window.scrollTo(0, 0));
      } finally {
        await session.del(`/automations/${id}`);
      }
    },
  },
  ...(automationRule
    ? [
        { name: 'ops-automation-rule', path: `/automations/${automationRule.id}`, as: OWNER, ready: 'main ol li[data-action]', variants: ALL, fullPage: true },
        { name: 'ops-automation-executions', path: '/automations/executions', as: OWNER, ready: 'main table tbody tr a:visible, main ul li a:visible, main h3', variants: ALL },
      ]
    : []),
  ...(automationExecution ? [{ name: 'ops-automation-execution', path: `/automations/executions/${automationExecution.id}`, as: OWNER, ready: 'main ol li', variants: ALL, fullPage: true }] : []),
  {
    // From a ready-made automation: add it, rename it, add a second action, save, dry-run it, switch it on.
    name: 'ops-automation-flow',
    path: '/automations',
    as: OWNER,
    ready: 'main section ul li button',
    variants: DESKTOP,
    fullPage: true,
    act: async (page) => {
      const card = page.locator('main section li', { hasText: 'Thank the customer when a request is completed' });
      await card.getByRole('button', { name: 'Use this automation' }).click();
      await page.waitForURL(/\/automations\/[0-9a-f-]{36}$/);
      await page.locator('main ol li[data-action]').first().waitFor();
      await snap(page, 'ops-flow-automation-1-from-template');
      const name = `Thank the customer (${stamp})`;
      await page.getByLabel('Name of the automation').fill(name);
      await page.getByRole('button', { name: 'Add action' }).click();
      await page.getByRole('menuitem', { name: 'Create a follow-up' }).click();
      const followUp = page.locator('main ol li[data-action="create_follow_up"]');
      await followUp.getByLabel('Title').fill('Ask for feedback: ');
      await followUp.getByRole('button', { name: 'Insert a value' }).first().click();
      await page.getByRole('menuitem', { name: /Request number/ }).click();
      await page.getByRole('button', { name: 'Save changes' }).first().click();
      await page.getByText('Automation saved').waitFor();
      await page.getByRole('button', { name: 'Dry run' }).click();
      await page.getByRole('dialog').getByText('This was only a trial').waitFor();
      await snap(page, 'ops-flow-automation-2-dry-run', false);
      await page.getByRole('dialog').getByRole('button', { name: 'Close' }).first().click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await page.getByRole('switch', { name: `Switch on: ${name}` }).click();
      await page.getByText('Automation switched on').waitFor();
      await snap(page, 'ops-flow-automation-3-enabled');
      // Leave the demo centre as it was: switch the rule off again and delete it.
      await page.getByRole('switch', { name: `Switch on: ${name}` }).click();
      await page.getByText('Automation switched off').waitFor();
      await page.getByRole('button', { name: 'Delete' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
      await page.waitForURL(/\/automations$/);
      await page.locator('main section ul li button').first().waitFor();
      await page.waitForTimeout(600);
    },
  },
  // ------------------------------------------------------------------ the two builders in Arabic and on a phone
  { name: 'ops-form-builder', path: serviceTab('form'), as: OWNER, ready: 'main [data-form-builder], main input', variants: ALL, fullPage: true },
  { name: 'ops-workflow-builder', path: `/workflows/${standardWorkflow?.id}?tab=draft`, as: OWNER, ready: 'main ol li, main ul li', variants: ALL, fullPage: true },
  {
    name: 'ops-builders-cleanup',
    path: '/services',
    as: OWNER,
    ready: 'main ul li a:visible',
    variants: DESKTOP,
    act: async () => {
      if (formDraft && bundle) console.log('      form draft:', JSON.stringify(await session.del(`/services/${bundle.id}/forms/${formDraft.id}`)).slice(0, 80));
      if (workflowDraft && standardWorkflow) console.log('      workflow draft:', JSON.stringify(await session.del(`/workflows/${standardWorkflow.id}/versions/${workflowDraft.id}`)).slice(0, 80));
    },
  },
];
