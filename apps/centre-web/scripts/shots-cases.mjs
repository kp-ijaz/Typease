/**
 * Screenshot scenarios of the "cases" section (request wizard, case page, tasks).
 *
 *   cd /home/claude/typease && export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
 *   node packages/ui/scripts/screenshots.mjs --app centre --scenarios apps/centre-web/scripts/shots-cases.mjs --out /tmp/shots-cases [--only name,name]
 *
 * Two kinds of scenarios:
 *  - "look" scenarios: one screen in the three standard variants (English desktop, Arabic dark desktop, English phone).
 *  - "flow-*" scenarios: drive a whole flow once, for real, against the running API (English desktop only, because
 *    they change data). They run in file order and hand ids to each other through `state`; every flow works on the
 *    request that `flow-wizard` creates through the UI, so the set can be run again and again.
 *    Intermediate pictures go to <out>/steps/.
 *    What the flows do NOT do through the UI is the money part (quotation, approval, payment): that belongs to the
 *    finance section and is done with API calls in `settleMoney`, clearly as test set-up.
 *
 * Scenario shape: see the top of packages/ui/scripts/screenshots.mjs.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';

const API = process.env.API_URL ?? 'http://localhost:4000/api/v1';
const PASSWORD = 'TypEase-Demo-2026';
const OWNER = 'owner@al-noor.test';
const RECEPTION = 'reception.dubai@al-noor.test';
const OPERATOR = 'operator1@al-noor.test';
const REVIEWER = 'reviewer@al-noor.test';
const ACCOUNTANT = 'accountant@al-noor.test';

const outArg = process.argv.indexOf('--out');
const OUT = resolve(process.cwd(), outArg >= 0 ? process.argv[outArg + 1] : 'docs/brand/screenshots');
const STEPS = join(OUT, 'steps');
mkdirSync(STEPS, { recursive: true });

const FLOW = ['en-light-desktop'];
/** Ids handed from one flow scenario to the next (kept in <out>/state.json so that one flow can be run again alone). */
const STATE_FILE = join(OUT, 'state.json');
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
const remember = (values) => {
  Object.assign(state, values);
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
};
const need = (key) => {
  if (!state[key]) throw new Error(`Run flow-wizard first: "${key}" is not known yet.`);
  return state[key];
};

// ---------------------------------------------------------------- API helpers (look-ups and finance set-up only)

const tokens = new Map();
async function token(email) {
  const cached = tokens.get(email);
  if (cached && Date.now() - cached.at < 8 * 60_000) return cached.value;
  const res = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client-App': 'centre' }, body: JSON.stringify({ email, password: PASSWORD, app: 'centre' }) });
  const body = await res.json();
  if (!body.accessToken) throw new Error(`Sign-in failed for ${email}: ${JSON.stringify(body).slice(0, 200)}`);
  tokens.set(email, { value: body.accessToken, at: Date.now() });
  return body.accessToken;
}
async function api(email, method, path, body, headers = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await token(email)}`, 'X-Client-App': 'centre', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${json?.code}: ${json?.message}`);
  return json;
}
/** A seeded request by its number (ids differ per database). */
async function seeded(requestNo) {
  const page = await api(OWNER, 'GET', `/requests?q=${requestNo}`);
  const row = page.data.find((r) => r.requestNo === requestNo);
  if (!row) throw new Error(`Request ${requestNo} not found`);
  return row.id;
}
/** The first request in a status (optionally of one service code). */
async function inStatus(status, serviceCode, as = OWNER) {
  const page = await api(as, 'GET', `/requests?status=${status}&pageSize=50&sort=createdAt:asc`);
  const row = page.data.find((r) => !serviceCode || r.service.code === serviceCode);
  if (!row) throw new Error(`No request in ${status}${serviceCode ? ` for ${serviceCode}` : ''}`);
  return row.id;
}
/**
 * TEST SET-UP for the finance part of the lifecycle (not built in this section): quotation from the
 * service price, sent, approved on behalf of the customer, and paid in cash.
 */
async function settleMoney(requestId) {
  // Never twice: a second run of a flow must not charge the test customer again.
  let view = await api(OWNER, 'GET', `/requests/${requestId}`);
  if (!view.finance?.quotation && !view.finance?.invoices?.length) {
    const quotation = await api(OWNER, 'POST', `/quotations/from-request/${requestId}`, {});
    await api(OWNER, 'POST', `/quotations/${quotation.id}/send`);
    await api(OWNER, 'POST', `/quotations/${quotation.id}/approve`, { note: 'Approved at the counter (screenshot run)' });
    view = await api(OWNER, 'GET', `/requests/${requestId}`);
  }
  for (const invoice of view.finance?.invoices ?? []) {
    if (Number(invoice.balanceDue) > 0) {
      await api(OWNER, 'POST', '/payments', { method: 'CASH', amount: invoice.balanceDue, branchId: view.branch.id, allocations: [{ invoiceId: invoice.id, amount: invoice.balanceDue }] }, { 'Idempotency-Key': randomUUID() });
    }
  }
  return api(OWNER, 'GET', `/requests/${requestId}`);
}

// ---------------------------------------------------------------- files to upload (generated, so the script has no fixtures)

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function png(width = 240, height = 160, rgb = [230, 236, 245]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function pdf(text) {
  const stream = `BT /F1 18 Tf 60 760 Td (${text.replace(/[()\\]/g, '')}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const FILES = join(tmpdir(), 'typease-shots-cases');
mkdirSync(FILES, { recursive: true });
const file = (name, bytes) => {
  const path = join(FILES, name);
  writeFileSync(path, bytes);
  return path;
};
const PASSPORT_PDF = file('sample-passport-copy.pdf', pdf('Sample passport copy - fictional, for screenshots'));
const PHOTO_PNG = file('sample-photo.png', png());
const PHOTO_PNG_2 = file('sample-photo-white-background.png', png(240, 160, [255, 255, 255]));
const PREPARED_PDF = file('sample-prepared-application.pdf', pdf('Sample prepared application - fictional'));

// ---------------------------------------------------------------- page helpers

const step = (page, name) => page.screenshot({ path: join(STEPS, `${name}.png`), fullPage: true, animations: 'disabled' });
const go = async (page, path, ready = '#next-step-title') => {
  await page.goto(new URL(path, page.url()).href, { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 90_000 });
  if (ready) await page.locator(ready).first().waitFor({ timeout: 90_000 });
};
const openCase = (page, id, tab) => go(page, `/requests/${id}${tab ? `?tab=${tab}` : ''}`);
const toast = (page, text) => page.locator('[data-sonner-toast]', { hasText: text }).first().waitFor({ timeout: 30_000 });
const status = (page, text) => page.locator('main header [data-status]', { hasText: text }).first().waitFor({ timeout: 30_000 });
const top = (page) => page.evaluate(() => window.scrollTo(0, 0));
/** The one primary action of the "What happens next" panel (scrolled to first: the top bar is sticky). */
const clickPrimary = async (page, id) => {
  await top(page);
  await page.locator(id ? `[data-primary-action="${id}"]` : '[data-primary-action]').click();
};
const lineStatus = async (id, label) => (await api(OWNER, 'GET', `/requests/${id}`)).checklist.find((l) => l.label === label)?.status;
const moreActions = async (page, label) => {
  await top(page);
  await page.getByRole('button', { name: 'More actions' }).first().click();
  await page.getByRole('menuitem', { name: label }).click();
};
/** A searchable dropdown (Combobox): open, type, choose. */
async function choose(scope, trigger, text, option = text) {
  await trigger.click();
  const input = scope.page ? scope.page().locator('[cmdk-input]') : scope.locator('[cmdk-input]');
  await input.fill(text);
  const root = scope.page ? scope.page() : scope;
  await root.locator('[cmdk-item]', { hasText: option }).first().click();
}
/** A short dropdown (Select). */
async function select(page, trigger, option) {
  await trigger.click();
  await page.getByRole('option', { name: option }).first().click();
}
const line = (page, label) => page.locator('[data-checklist-line]', { hasText: label }).first();
const upload = async (page, label, path, button = 'Upload') => {
  const row = line(page, label);
  await row.getByRole('button', { name: button, exact: true }).click();
  await row.locator('input[type="file"]').first().setInputFiles(path);
  await toast(page, 'File uploaded');
};

// ---------------------------------------------------------------- scenarios

export default [
  // ---- flow 1: a receptionist creates a customer and a request, with a real upload, and submits it
  {
    name: 'flow-wizard',
    path: '/requests/new',
    as: RECEPTION,
    ready: 'main h1',
    variants: FLOW,
    fullPage: true,
    act: async (page) => {
      const stamp = Date.now().toString(36).toUpperCase();
      const name = `Layla Demo ${stamp}`;
      // Step 1: customer, added on the spot with the shared "Add customer" dialog.
      await page.getByRole('button', { name: 'Add customer' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Full name (English)').fill(name);
      await dialog.locator('input[type="tel"]').fill(`50${String(Date.now()).slice(-7)}`);
      await dialog.getByRole('button', { name: 'Add customer' }).click();
      await page.locator('[data-customer-summary]', { hasText: name }).waitFor({ timeout: 30_000 });
      await step(page, '01-wizard-customer');
      await page.locator('[data-wizard-next]').click();

      // Step 2: service, found by search; fees are estimates, the compliance note is shown.
      await page.getByRole('searchbox', { name: 'Search services' }).fill('family');
      await page.locator('[data-service="AN-FAMILY-FILE"]').click();
      await page.locator('[data-service-detail]').waitFor();
      await page.getByText('Estimated total').waitFor();
      await step(page, '02-wizard-service');
      await page.locator('[data-wizard-next]').click();

      // Step 3: the dynamic form. Continue first with a gap, to see the validation.
      await page.getByText('Details for: Family residence file').waitFor({ timeout: 30_000 });
      await page.getByLabel('Family member name (as in passport)').fill('Sami Demo');
      await page.locator('[data-wizard-next]').click();
      await page.getByText('This field is required').first().waitFor();
      await step(page, '03-wizard-details-validation');
      await select(page, page.getByLabel('Relationship to the sponsor'), 'Child');
      await page.getByLabel("Sponsor's monthly salary").fill('12500');
      await page.getByLabel('Customer instructions').fill('Please call before submitting. (screenshot run)');
      await page.locator('[data-save-state="saved"]').waitFor({ timeout: 15_000 });
      await step(page, '04-wizard-details-saved');
      await page.locator('[data-wizard-next]').click();

      // Step 4: documents, with a real upload through the three-step helper.
      await page.getByText('Documents from the customer').waitFor({ timeout: 30_000 });
      await upload(page, "Family member's passport copy", PASSPORT_PDF);
      await line(page, "Family member's passport copy").locator('[data-status="UPLOADED"]').waitFor({ timeout: 30_000 });
      await step(page, '05-wizard-documents');
      await page.locator('[data-wizard-next]').click();

      // Step 5: review, with what is still missing, then submit.
      await page.locator('[data-submit-request]').waitFor({ timeout: 30_000 });
      await step(page, '06-wizard-review');
      await page.locator('[data-submit-request]').click();
      await page.locator('[data-tracking-code]').waitFor({ timeout: 30_000 });
      const requestNo = (await page.locator('[data-request-no]').textContent()).trim();
      const trackingCode = (await page.locator('[data-tracking-code]').textContent()).trim();
      const view = await api(OWNER, 'GET', `/requests/${await seeded(requestNo)}`);
      remember({ requestNo, trackingCode, requestId: view.id, customerId: view.customer.id, customerName: name });
      console.log(`     created ${requestNo} for ${name}, tracking code ${trackingCode}`);
    },
  },

  // ---- flow 2: document review on that request: start review, ask the customer, verify, reject, waive
  {
    name: 'flow-review',
    path: '/requests',
    as: OWNER,
    ready: 'main h1',
    variants: FLOW,
    fullPage: true,
    act: async (page) => {
      const id = need('requestId');
      await openCase(page, id);
      await step(page, '10-case-new');
      await clickPrimary(page); // "Start review"
      await status(page, 'Documents under review');
      await step(page, '11-case-under-review');

      // Request information from the customer: message + which documents.
      await moreActions(page, 'Request information');
      let dialog = page.getByRole('dialog');
      await dialog.getByLabel('Message to the customer').fill('Please bring a photo with a white background and the marriage certificate. (screenshot run)');
      await dialog.getByLabel('Personal photo, white background').check();
      await step(page, '12-case-request-information');
      await dialog.getByRole('button', { name: 'Send to the customer' }).click();
      await status(page, 'Awaiting customer');
      await step(page, '13-case-awaiting-customer');

      // The customer came back: add the photo, then continue the request.
      await page.getByRole('tab', { name: /Documents/ }).click();
      await upload(page, 'Personal photo, white background', PHOTO_PNG);
      await clickPrimary(page); // "The customer has answered"
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('Note').fill('Customer brought the photo to the counter.');
      await dialog.getByRole('button', { name: 'Continue the request' }).click();
      await status(page, 'Documents under review');

      // Verify the passport copy (with the expiry date compared against the document).
      await line(page, "Family member's passport copy").getByRole('button', { name: 'Check document' }).click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('Expiry date on the document').fill('2031-05-01');
      await step(page, '14-case-verify-dialog');
      await dialog.getByRole('button', { name: 'Accept document' }).click();
      await toast(page, 'Document accepted');
      await line(page, "Family member's passport copy").locator('[data-status="VERIFIED"]').waitFor({ timeout: 30_000 });

      // Reject the photo with a reason: the request goes back to the customer by itself.
      await line(page, 'Personal photo, white background').getByRole('button', { name: 'Check document' }).click();
      dialog = page.getByRole('dialog');
      await dialog.getByRole('radio', { name: /^Reject/ }).click();
      await dialog.getByLabel('What has to be corrected?').fill('The background is not white. Please bring a new photo.');
      await dialog.getByRole('button', { name: 'Reject document' }).click();
      await toast(page, 'Document rejected');
      await line(page, 'Personal photo, white background').locator('[data-status="REJECTED"]').waitFor({ timeout: 30_000 });
      await step(page, '15-case-document-rejected');
    },
  },

  // ---- flow 2b: the rejected photo goes back to the customer, comes back, is accepted; two lines are waived
  {
    name: 'flow-review-2',
    path: '/requests',
    as: OWNER,
    ready: 'main h1',
    variants: FLOW,
    fullPage: true,
    act: async (page) => {
      const id = need('requestId');
      await openCase(page, id, 'documents');
      // (The `if`s only make the flow restartable after an interrupted run.)
      if ((await lineStatus(id, 'Personal photo, white background')) === 'REJECTED') {
        await moreActions(page, 'Request information');
        const dialog = page.getByRole('dialog');
        // The rejected line is already ticked.
        await dialog.getByLabel('Message to the customer').fill('The photo needs a white background. Please bring a new one. (screenshot run)');
        await dialog.getByRole('button', { name: 'Send to the customer' }).click();
        await status(page, 'Awaiting customer');
        await page.locator('[data-blocked]').first().waitFor();
        await step(page, '16-case-awaiting-rejected-document');
        await upload(page, 'Personal photo, white background', PHOTO_PNG_2);
      }
      let dialog;

      // The customer brought a new photo: continue, then accept it.
      if ((await api(OWNER, 'GET', `/requests/${id}`)).status === 'AWAITING_CUSTOMER') {
        await clickPrimary(page, 'resubmit');
        await page.getByRole('dialog').getByRole('button', { name: 'Continue the request' }).click();
        await status(page, 'Documents under review');
      }
      if ((await lineStatus(id, 'Personal photo, white background')) === 'UPLOADED') {
        await line(page, 'Personal photo, white background').getByRole('button', { name: 'Check document' }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Accept document' }).click();
        await line(page, 'Personal photo, white background').locator('[data-status="VERIFIED"]').waitFor({ timeout: 30_000 });
      }

      // The other two required documents are not needed for this customer: waive with a reason.
      for (const label of ["Sponsor's residence visa", 'Attested marriage or birth certificate']) {
        if ((await lineStatus(id, label)) !== 'MISSING') continue;
        await line(page, label).getByRole('button', { name: `More actions for ${label}` }).click();
        await page.getByRole('menuitem', { name: 'Not needed for this request' }).click();
        dialog = page.getByRole('dialog');
        await dialog.getByLabel('Why is it not needed?').fill('Seen in original at the counter. (screenshot run)');
        await dialog.getByRole('button', { name: 'Mark as not needed' }).click();
        await line(page, label).locator('[data-status="WAIVED"]').waitFor({ timeout: 30_000 });
      }
      await step(page, '17-case-documents-complete');
      await top(page);
    },
  },

  // ---- flow 3: after the money part (API set-up), the manager assigns the operator and the reviewer
  {
    name: 'flow-assign',
    path: '/requests',
    as: OWNER,
    ready: 'main h1',
    variants: FLOW,
    fullPage: true,
    act: async (page) => {
      const id = need('requestId');
      if ((await api(OWNER, 'GET', `/requests/${id}`)).paymentStatus !== 'PAID') await settleMoney(id);
      await openCase(page, id);
      await status(page, 'Ready for processing');
      await step(page, '20-case-ready-unassigned');
      await clickPrimary(page); // "Assign an operator": what unblocks "Start preparation"
      let dialog = page.getByRole('dialog');
      await choose(page, dialog.getByRole('combobox'), 'Rahul', 'Rahul Menon');
      await step(page, '21-case-assign-dialog');
      await dialog.getByRole('button', { name: 'Assign an operator' }).click();
      await toast(page, 'Assigned');
      await page.getByRole('tab', { name: /Assignment and review/ }).click();
      await page.getByRole('button', { name: 'Assign a reviewer' }).click();
      dialog = page.getByRole('dialog');
      await choose(page, dialog.getByRole('combobox'), 'Lakshmi', 'Lakshmi Iyer');
      await dialog.getByRole('button', { name: 'Assign a reviewer' }).click();
      await page.getByText('Lakshmi Iyer').first().waitFor();
      await page.locator('[data-primary-action="to-IN_PREPARATION"]').waitFor({ timeout: 30_000 });
    },
  },

  // ---- flow 4: the operator prepares the application, attaches the completed document and sends it for review
  {
    name: 'flow-prepare',
    path: '/requests',
    as: OPERATOR,
    ready: 'main h1',
    variants: FLOW,
    fullPage: true,
    act: async (page) => {
      const id = need('requestId');
      await openCase(page, id);
      let view = await api(OWNER, 'GET', `/requests/${id}`);
      if (view.status === 'READY_FOR_PROCESSING') {
        await clickPrimary(page, 'to-IN_PREPARATION'); // "Start preparation"
        await status(page, 'In preparation');
      }
      await page.getByRole('tab', { name: /Documents/ }).click();
      if (!view.checklist.some((l) => l.kind === 'COMPLETION')) {
        await page.getByRole('button', { name: 'Add a completed document' }).click();
        const dialog = page.getByRole('dialog');
        await choose(dialog, dialog.getByRole('combobox', { name: 'Document type' }), 'Completed', 'Completed Document');
        await dialog.getByLabel('Name on the checklist').fill('Prepared application');
        await step(page, '30-case-add-completed-line');
        await dialog.getByRole('button', { name: 'Add to checklist' }).click();
        await toast(page, 'Line added');
      }
      view = await api(OWNER, 'GET', `/requests/${id}`);
      if (!view.checklist.find((l) => l.kind === 'COMPLETION')?.document) {
        await upload(page, 'Prepared application', PREPARED_PDF, 'Attach');
      }
      await step(page, '31-case-prepared-document');
      if ((await api(OWNER, 'GET', `/requests/${id}`)).status === 'IN_PREPARATION') {
        await clickPrimary(page, 'to-PENDING_APPROVAL'); // "Send for review": the only way forward for a service that requires review
        await status(page, 'Pending review approval');
      }
      await page.getByRole('tab', { name: 'Overview' }).click();
    },
  },

  // ---- flow 5: another person reviews and approves
  {
    name: 'flow-approve',
    path: '/requests',
    as: REVIEWER,
    ready: 'main h1',
    variants: FLOW,
    fullPage: true,
    act: async (page) => {
      const id = need('requestId');
      await openCase(page, id);
      await step(page, '40-case-reviewer-view');
      await clickPrimary(page); // "Approve"
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Comment').fill('Checked against the documents. (screenshot run)');
      await step(page, '41-case-approval-dialog');
      await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
      await status(page, 'Ready to submit');
      await page.getByRole('tab', { name: /Assignment and review/ }).click();
      await page.locator('[data-approval="APPROVED"]').first().waitFor();
    },
  },

  // ---- flow 6: the operator records the submission through the partner, a status and the result
  {
    name: 'flow-submission',
    path: '/requests',
    as: OPERATOR,
    ready: 'main h1',
    variants: FLOW,
    fullPage: true,
    act: async (page) => {
      const id = need('requestId');
      await openCase(page, id);
      await clickPrimary(page); // "Record submission"
      let dialog = page.getByRole('dialog');
      await dialog.getByLabel('Reference number').fill('SAMPLE-APP-2026-0042');
      await dialog.getByLabel('Authority').fill('Sample authority (fictional)');
      await dialog.getByRole('textbox', { name: /^Partner/ }).fill('Sample PRO Partner Services (fictional)');
      await dialog.getByLabel('Reference at the partner').fill('SAMPLE-PRT-0042');
      await step(page, '50-case-record-submission');
      await dialog.getByRole('button', { name: 'Record submission' }).click();
      await status(page, 'External processing');
      await page.getByRole('tab', { name: /Submission/ }).click();
      await page.getByRole('button', { name: 'Update the status' }).click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('Status at the authority or partner').fill('Received by the partner; result expected within two working days (sample status).');
      await dialog.getByRole('button', { name: 'Save status' }).click();
      await toast(page, 'Status updated');
      await page.locator('[data-status-source="PARTNER_PROVIDED"]').first().waitFor();
      await step(page, '51-case-external-status');
      await clickPrimary(page); // "Record the result"
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('What was reported?').fill('Approved by the authority (sample result).');
      await step(page, '52-case-external-result');
      await dialog.getByRole('button', { name: 'Record result' }).click();
      await status(page, 'Final review');
    },
  },

  // ---- flow 7: an internal note and a message to the customer
  {
    name: 'flow-messages',
    path: '/requests',
    as: OWNER,
    ready: 'main h1',
    variants: FLOW,
    fullPage: true,
    act: async (page) => {
      const id = need('requestId');
      await openCase(page, id, 'messages');
      await page.getByLabel('Note for colleagues').fill('Customer prefers a call after 5 pm. (internal, screenshot run)');
      await page.getByRole('button', { name: 'Add internal note' }).click();
      await toast(page, 'Internal note added');
      await page.getByRole('switch', { name: /Visible to the customer/ }).click();
      await page.getByLabel('Message to the customer').fill('Your family residence file was approved. You can collect the documents tomorrow. (screenshot run)');
      await page.getByRole('button', { name: 'Send to the customer' }).click();
      await toast(page, 'Message sent to the customer');
      await page.locator('[data-visibility="CUSTOMER"]').first().waitFor();
      // After sending, the form is back on the safe default: an internal note.
      await page.getByRole('button', { name: 'Add internal note' }).waitFor();
      if ((await page.getByRole('switch', { name: /Visible to the customer/ }).getAttribute('aria-checked')) !== 'false') throw new Error('The switch must go back to "internal" after a message to the customer');
    },
  },

  // ---- flow 8: the reviewer completes the request; the history shows every step
  {
    name: 'flow-complete',
    path: '/requests',
    as: REVIEWER,
    ready: 'main h1',
    variants: FLOW,
    fullPage: true,
    act: async (page) => {
      const id = need('requestId');
      await openCase(page, id);
      await clickPrimary(page); // "Complete"
      await page.getByRole('alertdialog').getByRole('button', { name: 'Complete' }).click();
      await status(page, 'Completed');
      await page.getByRole('tab', { name: 'History' }).click();
      await page.getByText('Status history').waitFor();
    },
  },

  // ---- flow 9: a service the centre only prepares: nothing can be recorded as submitted, and the page says why
  {
    name: 'flow-refusal',
    path: '/requests',
    as: OPERATOR,
    ready: 'main h1',
    variants: FLOW,
    fullPage: true,
    act: async (page) => {
      await openCase(page, await inStatus('IN_PREPARATION', 'ST-VISA-TYPING'), 'external');
      await page.getByText('The customer submits the application themselves.', { exact: false }).waitFor();
      if (await page.getByRole('button', { name: 'Record a submission' }).count()) throw new Error('"Record a submission" must not be offered for a preparation-only service');
    },
  },

  // ---- flow 10: continue a draft on another desk and reuse a document that is already on file
  {
    name: 'flow-resume',
    path: '/requests',
    as: RECEPTION,
    ready: 'main h1',
    variants: FLOW,
    fullPage: true,
    act: async (page) => {
      const id = await seeded('AN-000064');
      await go(page, `/requests/new?draft=${id}&step=documents`, '[data-checklist-line]');
      await step(page, '60-wizard-resume-documents');
      const use = line(page, 'Personal photo, white background').getByRole('button', { name: 'Use this document' });
      if (await use.count()) {
        await use.first().click();
        await toast(page, 'Document linked');
      }
    },
  },

  // ---- flow 11: cancel with a reason (confirmation dialog)
  {
    name: 'flow-cancel',
    path: '/requests',
    as: OWNER,
    ready: 'main h1',
    variants: FLOW,
    fullPage: true,
    act: async (page) => {
      // A request of the screenshot run that is still open; otherwise a fresh draft for the test customer (set-up).
      const open = (await api(OWNER, 'GET', '/requests?q=Layla%20Demo&pageSize=50')).data.filter((r) => r.id !== state.requestId && !['COMPLETED', 'CANCELLED'].includes(r.status));
      let id = open.find((r) => r.status === 'UNDER_REVIEW')?.id ?? open.find((r) => r.status === 'DRAFT')?.id;
      if (!id) {
        const service = (await api(OWNER, 'GET', '/services?pageSize=100')).data.find((s) => s.code === 'ST-LETTER');
        id = (await api(OWNER, 'POST', '/requests', { serviceId: service.id, customerId: need('customerId') })).id;
      }
      await openCase(page, id);
      await moreActions(page, 'Cancel request');
      const dialog = page.getByRole('alertdialog');
      await dialog.getByRole('button', { name: 'Cancel request' }).click(); // without a reason: refused, with a message
      await dialog.getByText('Give a reason of at least 3 characters.').waitFor();
      await dialog.getByLabel('Why is the request cancelled?').fill('Customer no longer needs the service. (screenshot run)');
      await step(page, '70-case-cancel-dialog');
      await dialog.getByRole('button', { name: 'Cancel request' }).click();
      await status(page, 'Cancelled');
      await page.getByRole('tab', { name: 'History' }).click();
      await page.getByText('Status history').waitFor();
    },
  },

  // ---- flow 12: reopen a completed request; the person who prepares a request cannot approve it
  {
    name: 'flow-self-approval',
    path: '/requests',
    as: OWNER,
    ready: 'main h1',
    variants: FLOW,
    fullPage: true,
    act: async (page) => {
      const id = need('requestId');
      const get = () => api(OWNER, 'GET', `/requests/${id}`);
      const reassign = async (text, name, why) => {
        await moreActions(page, 'Change the operator');
        const dialog = page.getByRole('dialog');
        await choose(page, dialog.getByRole('combobox'), text, name);
        await dialog.getByLabel('Why is it changed?').fill(why);
        await dialog.getByRole('button', { name: 'Change the operator' }).click();
        await toast(page, 'Assigned');
      };
      await openCase(page, id);
      if ((await get()).status === 'COMPLETED') {
        await moreActions(page, 'Reopen');
        const dialog = page.getByRole('dialog');
        await dialog.getByLabel('Reason').fill('Customer asked for a correction of the address. (screenshot run)');
        await step(page, '80-case-reopen-dialog');
        await dialog.getByRole('button', { name: 'Reopen' }).click();
        await status(page, 'In preparation');
      }
      if ((await get()).status === 'READY_TO_SUBMIT') {
        await moreActions(page, 'Back to preparation');
        const dialog = page.getByRole('dialog');
        await dialog.getByLabel('Reason').fill('One more correction before submission. (screenshot run)');
        await dialog.getByRole('button', { name: 'Back to preparation' }).click();
        await status(page, 'In preparation');
      }
      // The owner takes over the preparation ...
      if ((await get()).assignee?.name !== 'Salem Al Marri') await reassign('Salem', 'Salem Al Marri', 'Rahul is on leave. (screenshot run)');
      if ((await get()).status === 'IN_PREPARATION') {
        if (await page.locator('[data-primary-action="to-PENDING_APPROVAL"]').count()) await clickPrimary(page, 'to-PENDING_APPROVAL');
        else await moreActions(page, 'Send for review');
        await status(page, 'Pending review approval');
      }
      // ... and therefore cannot approve it: either the page does not offer it, or the API refuses and the dialog explains.
      await step(page, '82-case-own-review');
      if (await page.locator('[data-primary-action="to-READY_TO_SUBMIT"]').count()) {
        await clickPrimary(page, 'to-READY_TO_SUBMIT');
        const dialog = page.getByRole('dialog');
        await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
        await dialog.getByText('You cannot review your own work').waitFor();
        await step(page, '83-case-self-approval-refused');
        await dialog.getByRole('button', { name: 'Cancel' }).click();
      } else {
        await page.getByRole('tab', { name: /Assignment and review/ }).click();
        await page.getByText('A reviewer has to decide.', { exact: false }).waitFor();
        await step(page, '83-case-self-approval-refused');
      }
      // Put the operator back (the request stays in review for the reviewer).
      await reassign('Rahul', 'Rahul Menon', 'Rahul is back. (screenshot run)');
      await page.getByRole('tab', { name: /Assignment and review/ }).click();
    },
  },

  // ---- flow 13: tasks. The owner creates one for a colleague (linked to the request) and one for a role
  {
    name: 'flow-tasks-create',
    path: '/requests',
    as: OWNER,
    ready: 'main h1',
    variants: FLOW,
    fullPage: true,
    act: async (page) => {
      const id = need('requestId');
      await go(page, `/tasks?requestId=${id}`, 'main h1');
      await page.getByText(`Tasks of request ${need('requestNo')}`, { exact: false }).waitFor();
      await page.getByRole('button', { name: 'New task' }).first().click();
      let dialog = page.getByRole('dialog');
      await dialog.getByLabel('What has to be done?').fill('Call the customer about the collection time (screenshot run)');
      await dialog.getByLabel('Details').fill('She prefers a call after 5 pm.');
      await choose(dialog, dialog.getByRole('combobox', { name: 'Add a staff member' }), 'Rahul', 'Rahul Menon');
      await step(page, '90-task-create-dialog');
      await dialog.getByRole('button', { name: 'Create task' }).click();
      await toast(page, 'Task created');
      await page.locator('tbody tr', { hasText: 'Call the customer about the collection time' }).first().waitFor();

      await page.getByRole('button', { name: 'New task' }).first().click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('What has to be done?').fill('Check the attested certificate copy (screenshot run)');
      await select(page, dialog.getByRole('combobox', { name: /leave it for a role/ }), 'Document Reviewer');
      await dialog.getByRole('button', { name: 'Create task' }).click();
      await toast(page, 'Task created');
      await page.locator('tbody tr', { hasText: 'Check the attested certificate copy' }).first().waitFor();
      await step(page, '91-tasks-of-request');

      // A task of a workflow step cannot be completed by hand: the details say so.
      await go(page, '/tasks?tab=all&type=WORKFLOW_STEP', 'tbody tr [data-task]');
      await page.locator('tbody tr [data-task]').first().click();
      await page.getByRole('dialog').getByText('This task belongs to a step of the request.', { exact: false }).waitFor();
      if (await page.getByRole('dialog').getByRole('button', { name: 'Mark as done' }).count()) throw new Error('A workflow task must not offer "Mark as done"');
    },
  },

  // ---- flow 14: the operator starts and completes the task that was assigned to him
  {
    name: 'flow-tasks-do',
    path: '/tasks',
    as: OPERATOR,
    ready: 'main h1',
    variants: FLOW,
    fullPage: true,
    act: async (page) => {
      const row = () => page.locator('tbody tr', { hasText: 'Call the customer about the collection time' }).first();
      await row().waitFor({ timeout: 60_000 });
      await step(page, '92-tasks-mine-operator');
      await row().getByRole('button', { name: 'Start' }).click();
      await toast(page, 'Task started');
      await row().getByRole('button', { name: 'Mark as done' }).click();
      await toast(page, 'Task done');
    },
  },

  // ---- flow 15: a reviewer takes a task from the queue of her role
  {
    name: 'flow-tasks-claim',
    path: '/tasks?tab=queue',
    as: REVIEWER,
    ready: 'main h1',
    variants: FLOW,
    fullPage: true,
    act: async (page) => {
      const row = page.locator('tbody tr', { hasText: 'Check the attested certificate copy' }).first();
      await row.waitFor({ timeout: 60_000 });
      await step(page, '93-tasks-queue-reviewer');
      await row.getByRole('button', { name: 'Take this task' }).click();
      await toast(page, 'The task is yours');
      await page.getByRole('tab', { name: 'My tasks' }).click();
      await page.locator('tbody tr', { hasText: 'Check the attested certificate copy' }).first().waitFor();
    },
  },

  // ---- flow 16: the smaller things of the case page, each done once for real
  {
    name: 'flow-misc',
    path: '/requests',
    as: OWNER,
    ready: 'main h1',
    variants: FLOW,
    fullPage: true,
    act: async (page) => {
      const id = need('requestId');
      await openCase(page, id, 'details');
      // Edit an answer of the form
      await page.getByRole('button', { name: 'Edit details' }).click();
      await page.getByLabel("Sponsor's monthly salary").fill('13250');
      await step(page, 'a0-case-details-editing');
      await page.getByRole('button', { name: 'Save changes' }).click();
      await toast(page, 'Details saved');
      await step(page, 'a1-case-details-saved');
      // Priority, due date, instructions
      await top(page);
      await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
      const dialog = page.getByRole('dialog');
      await select(page, dialog.getByRole('combobox', { name: 'Priority' }), (await api(OWNER, 'GET', `/requests/${id}`)).priority === 'HIGH' ? 'Normal' : 'High');
      await dialog.getByLabel('Customer instructions').fill('Please call before submitting. Customer travels on 20 October. (screenshot run)');
      await step(page, 'a2-case-edit-dialog');
      await dialog.getByRole('button', { name: 'Save changes' }).click();
      await toast(page, 'Request updated');
      // Documents: preview, versions, several other files at once
      await page.getByRole('tab', { name: /Documents/ }).click();
      // An image: headless Chromium has no PDF viewer, so a PDF preview would stay blank in this run.
      await line(page, 'Personal photo, white background').getByRole('button', { name: 'View' }).click();
      await page.getByRole('dialog').locator('img').first().waitFor({ timeout: 30_000 });
      await page.waitForTimeout(1000);
      await step(page, 'a3-case-file-preview');
      await page.keyboard.press('Escape');
      await line(page, "Family member's passport copy").locator('button[aria-haspopup="menu"]').click();
      await page.getByRole('menuitem', { name: 'Versions and checks' }).click();
      await page.getByRole('dialog').getByText('Version 1').first().waitFor();
      await step(page, 'a4-case-versions');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Upload other files' }).click();
      await page.getByText('Type of these files').waitFor();
      await page.locator('input[type="file"][multiple]').first().setInputFiles([PHOTO_PNG, PREPARED_PDF]);
      // The upload area shows the progress and the result of each file itself; the list below refreshes afterwards.
      const before = (await api(OWNER, 'GET', `/documents?requestId=${id}&pageSize=100`)).data.length;
      for (let i = 0; i < 30 && (await api(OWNER, 'GET', `/documents?requestId=${id}&pageSize=100`)).data.filter((d) => d.status === 'AVAILABLE').length < before; i++) await page.waitForTimeout(1000);
      await page.waitForTimeout(4000);
      await step(page, 'a5-case-other-files');
      // Money (read-only)
      await page.getByRole('tab', { name: 'Money' }).click();
      await page.getByText('Invoiced').first().waitFor();
      await step(page, 'a6-case-money');
      // Workflow version
      await page.getByRole('tab', { name: 'Overview' }).click();
      await page.getByText('Progress', { exact: true }).waitFor();
      // Only offered when a newer version of the workflow was published since the request started.
      await page.waitForTimeout(1500);
      const migrate = page.getByRole('button', { name: 'Move to the current workflow' });
      if (await migrate.count()) {
        await migrate.first().click();
        await step(page, 'a7-case-migrate-dialog');
        await page.getByRole('button', { name: 'Move request' }).click();
        await toast(page, 'Workflow updated');
      }
      // Cancelling a paid request: the dialog says what the centre holds. Not confirmed here.
      await moreActions(page, 'Cancel request');
      await page.getByRole('alertdialog').getByText('The centre holds', { exact: false }).waitFor();
      await step(page, 'a9-case-cancel-paid');
      await page.getByRole('alertdialog').getByRole('button', { name: 'Keep request' }).click();
      // The printed summary (print styles applied to the same page)
      await page.emulateMedia({ media: 'print' });
      await step(page, 'a8-case-print-summary');
      await page.emulateMedia({ media: 'screen' });
    },
  },

  // ---- flow 17: a fresh draft: assign automatically, then mark it as a duplicate of the first request
  {
    name: 'flow-duplicate',
    path: '/requests',
    as: OWNER,
    ready: 'main h1',
    variants: FLOW,
    fullPage: true,
    act: async (page) => {
      const service = (await api(OWNER, 'GET', '/services?pageSize=100')).data.find((s) => s.code === 'AN-FAMILY-FILE');
      const draft = await api(OWNER, 'POST', '/requests', { serviceId: service.id, customerId: need('customerId') }); // set-up
      await openCase(page, draft.id, 'team');
      const auto = page.getByRole('button', { name: 'Assign automatically' });
      if (await auto.count()) {
        await auto.click();
        await page.locator('[data-sonner-toast]').first().waitFor();
        await step(page, 'b0-case-auto-assign');
      }
      await moreActions(page, 'Mark as a duplicate');
      const dialog = page.getByRole('dialog');
      await choose(page, dialog.getByRole('combobox'), need('requestNo'), need('requestNo'));
      await step(page, 'b1-case-duplicate-dialog');
      await dialog.getByRole('button', { name: 'Mark as duplicate and cancel' }).click();
      await status(page, 'Cancelled');
      await page.getByRole('tab', { name: 'Overview' }).click();
      await page.getByText('Duplicate of').first().waitFor();
    },
  },

  // ---- flow 18: a document is rejected while the customer still owes other documents: the request does not
  //      start waiting by itself (documented), so the page offers to ask the customer, with the text prepared
  {
    name: 'flow-reject-guide',
    path: '/requests',
    as: OWNER,
    ready: 'main h1',
    variants: FLOW,
    fullPage: true,
    act: async (page) => {
      // Set-up: a submitted request of the test customer with the answers of the first one.
      const first = await api(OWNER, 'GET', `/requests/${need('requestId')}`);
      const created = await api(OWNER, 'POST', '/requests', { serviceId: first.service.id, customerId: first.customer.id, fields: first.form.values });
      await api(OWNER, 'POST', `/requests/${created.id}/submit`);
      await openCase(page, created.id);
      await clickPrimary(page); // "Start review"
      await status(page, 'Documents under review');
      await page.getByRole('tab', { name: /Documents/ }).click();
      await upload(page, 'Personal photo, white background', PHOTO_PNG);
      await line(page, 'Personal photo, white background').getByRole('button', { name: 'Check document' }).click();
      let dialog = page.getByRole('dialog');
      await dialog.getByRole('radio', { name: /^Reject/ }).click();
      await dialog.getByLabel('What has to be corrected?').fill('The background is not white');
      await dialog.getByRole('button', { name: 'Reject document' }).click();
      await toast(page, 'Document rejected');
      await line(page, 'Personal photo, white background').locator('[data-status="REJECTED"]').waitFor({ timeout: 30_000 });
      await page.locator('[data-ask-customer]').waitFor();
      await page.locator('[data-primary-action="ask-customer"]').waitFor();
      await step(page, 'c0-case-rejected-offer');
      await page.locator('[data-ask-customer]').click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('Message to the customer').waitFor();
      if (!(await dialog.getByLabel('Message to the customer').inputValue()).includes('The background is not white')) throw new Error('The message is not pre-filled with the rejected document');
      if (!(await dialog.getByLabel('Personal photo, white background').isChecked())) throw new Error('The rejected line is not ticked');
      await step(page, 'c1-case-rejected-request-info');
      await dialog.getByRole('button', { name: 'Send to the customer' }).click();
      await status(page, 'Awaiting customer');
    },
  },

  // ---------------------------------------------------------------- "look" scenarios: three variants each
  ...[
    ['case-overview', OWNER, 'EXTERNAL_PROCESSING', 'AN-FAMILY-FILE', undefined],
    ['case-details', OWNER, 'IN_PREPARATION', 'AN-FAMILY-FILE', 'details'],
    ['case-documents', OWNER, 'RETURNED', 'AN-FAMILY-FILE', 'documents'],
    ['case-money', OWNER, 'AWAITING_CUSTOMER', 'ST-TL-RENEWAL', 'money'],
    ['case-team', OWNER, 'PENDING_APPROVAL', 'AN-FAMILY-FILE', 'team'],
    ['case-external', OWNER, 'EXTERNAL_PROCESSING', 'AN-FAMILY-FILE', 'external'],
    ['case-messages', OWNER, 'AWAITING_CUSTOMER', 'ST-TL-RENEWAL', 'messages'],
    ['case-history', OWNER, 'RETURNED', 'AN-FAMILY-FILE', 'history'],
    // How the page degrades for the other roles.
    ['case-as-operator', OPERATOR, 'READY_TO_SUBMIT', 'AN-FAMILY-FILE', undefined],
    ['case-as-reception', RECEPTION, 'SUBMITTED', undefined, undefined],
    ['case-as-reviewer', REVIEWER, 'PENDING_APPROVAL', 'AN-FAMILY-FILE', 'team'],
    ['case-as-accountant', ACCOUNTANT, 'AWAITING_PAYMENT', 'ST-RES-RENEWAL', 'money'],
  ].map(([name, as, inState, service, tab]) => ({
    name,
    path: '/requests',
    as,
    ready: 'main h1',
    fullPage: true,
    act: async (page) => openCase(page, await inStatus(inState, service, as), tab),
  })),
  {
    // An operator opens a request that is not assigned to him: a plain "not available" page, no data.
    name: 'case-not-assigned',
    path: '/requests',
    as: OPERATOR,
    ready: 'main h1',
    variants: FLOW,
    act: async (page) => go(page, `/requests/${await inStatus('SUBMITTED', 'ST-RES-RENEWAL')}`, 'main h1'),
  },
  {
    name: 'wizard-service',
    path: '/requests',
    as: RECEPTION,
    ready: 'main h1',
    fullPage: true,
    act: async (page) => {
      const customer = (await api(OWNER, 'GET', '/customers?q=Mariam%20Yousef')).data[0];
      await go(page, `/requests/new?customerId=${customer.id}`, '[data-service]');
      await page.locator('main input[type="search"]').first().fill('visa');
      await page.locator('[data-service="ST-VISA-TYPING"]').click();
      await page.locator('[data-service-detail]').waitFor();
    },
  },
  {
    name: 'wizard-customer',
    path: '/requests',
    as: RECEPTION,
    ready: 'main h1',
    fullPage: true,
    act: async (page) => {
      const customer = (await api(OWNER, 'GET', '/customers?q=Mariam%20Yousef')).data[0];
      await go(page, `/requests/new?customerId=${customer.id}&step=customer`, 'main h1');
      // The link opens on the service step with the customer chosen: go one step back to see the summary.
      await page.locator('[data-customer-summary]').or(page.locator('[data-service]').first()).first().waitFor({ timeout: 60_000 });
      if (!(await page.locator('[data-customer-summary]').count())) {
        await page.getByRole('button', { name: /^(Back|رجوع)$/ }).first().click();
        await page.locator('[data-customer-summary]').waitFor({ timeout: 60_000 });
      }
    },
  },
  {
    name: 'wizard-documents',
    path: '/requests',
    as: RECEPTION,
    ready: 'main h1',
    fullPage: true,
    act: async (page) => go(page, `/requests/new?draft=${await seeded('AN-000064')}&step=documents`, '[data-checklist-line]'),
  },
  {
    name: 'wizard-details',
    path: '/requests',
    as: RECEPTION,
    ready: 'main h1',
    fullPage: true,
    act: async (page) => go(page, `/requests/new?draft=${await seeded('AN-000056')}&step=details`, '[data-wizard-next]'),
  },
  {
    name: 'wizard-review',
    path: '/requests',
    as: RECEPTION,
    ready: 'main h1',
    fullPage: true,
    act: async (page) => go(page, `/requests/new?draft=${await seeded('AN-000063')}&step=review`, '[data-submit-request]'),
  },
  { name: 'tasks-all', path: '/tasks?tab=all', as: OWNER, ready: 'main h1', fullPage: true, act: async (page) => page.locator('[data-task] >> visible=true').first().waitFor({ timeout: 60_000 }) },
  { name: 'tasks-mine', path: '/tasks', as: OPERATOR, ready: 'main h1', fullPage: true },
  {
    name: 'tasks-new',
    path: '/tasks',
    as: OWNER,
    ready: 'main h1',
    act: async (page) => {
      await page.getByRole('button', { name: /New task|مهمة جديدة/ }).first().click();
      await page.getByRole('dialog').waitFor();
    },
  },

  // ---- AI document assistant
  {
    // Real: the centre has the assistant switched off (and no provider is configured here), so it is not offered at all.
    name: 'flow-ai-hidden',
    path: '/requests',
    as: OWNER,
    ready: 'main h1',
    variants: FLOW,
    act: async (page) => {
      await openCase(page, await inStatus('RETURNED', 'AN-FAMILY-FILE'), 'documents');
      await page.locator('[data-checklist-line] button[aria-haspopup="menu"]').first().click();
      await page.getByRole('menu').waitFor();
      if (await page.getByRole('menuitem', { name: /AI reading/ }).count()) throw new Error('The AI assistant must be hidden while it is switched off');
    },
  },
  {
    // SIMULATED API ANSWERS (no OCR provider is configured in this environment): only shows that the review
    // screen renders what GET /tenant, /ocr/usage, /documents/:id/extractions and /ocr/results/:id return.
    name: 'ai-review-simulated',
    path: '/requests',
    as: OWNER,
    ready: 'main h1',
    act: async (page) => {
      const run = { id: '00000000-0000-4000-8000-0000000000aa', documentId: 'x', status: 'COMPLETED', profile: 'PASSPORT', provider: 'simulated', error: null, createdAt: new Date().toISOString(), completedAt: new Date().toISOString() };
      const field = (key, label, value, confidence, source, onFile, canApply = true) => ({ key, label, canApply, extracted: value === null ? null : { value, confidence, source }, onFile, reviewed: null });
      const result = {
        ...run,
        unverified: true,
        notice: 'Extracted automatically. Not verified.',
        classification: 'PASSPORT',
        classificationConfidence: 0.97,
        pages: 1,
        fields: [
          field('passportNumber', 'Passport number', 'X0000000', 0.99, 'MRZ', { value: 'X0000000', matches: true }),
          field('surname', 'Surname', 'SAMPLE', 0.98, 'MRZ', null, false),
          field('givenNames', 'Given names', 'PERSON FICTIONAL', 0.95, 'MRZ', null, false),
          field('nationality', 'Nationality', 'PH', 0.93, 'MRZ', { value: 'PH', matches: true }),
          field('dateOfBirth', 'Date of birth', '1990-01-01', 0.72, 'TEXT', { value: '1990-01-10', matches: false }),
          field('expiryDate', 'Expiry date', '2031-05-01', 0.58, 'TEXT', { value: null, matches: null }),
          field('issueDate', 'Issue date', null, 0, 'TEXT', { value: null, matches: null }),
        ],
        warnings: [
          { code: 'MISMATCH', severity: 'HIGH', field: 'dateOfBirth', message: 'The date of birth differs from the customer file.', suggestion: null },
          { code: 'LOW_CONFIDENCE', severity: 'MEDIUM', field: 'expiryDate', message: 'The expiry date was read with low confidence.', suggestion: null },
        ],
        reviewNote: null,
        applied: [],
      };
      await page.route('**/api/v1/tenant', async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const response = await route.fetch();
        await route.fulfill({ response, json: { ...(await response.json()), aiEnabled: true } });
      });
      await page.route('**/api/v1/ocr/usage', (route) => route.fulfill({ json: { aiEnabled: true, provider: { name: 'simulated', configured: true }, plan: { includesAiAssistant: true, monthlyPageLimit: 500 }, currentMonth: { period: '2026-10', pagesUsed: 12, pagesRemaining: 488 } } }));
      await page.route('**/api/v1/documents/*/extractions*', (route) => route.fulfill({ json: { data: [run], total: 1, page: 1, pageSize: 20, totalPages: 1 } }));
      await page.route('**/api/v1/ocr/results/*', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: result }) : route.continue()));
      await openCase(page, await inStatus('RETURNED', 'AN-FAMILY-FILE'), 'documents');
      await page.locator('[data-checklist-line][data-status="VERIFIED"] button[aria-haspopup="menu"], [data-checklist-line][data-status="UPLOADED"] button[aria-haspopup="menu"]').first().click();
      await page.getByRole('menuitem', { name: /AI reading|قراءة آلية/ }).click();
      await page.getByRole('dialog').getByRole('table').waitFor();
    },
  },
];
