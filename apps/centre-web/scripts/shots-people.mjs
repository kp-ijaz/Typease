/**
 * Screenshot scenarios of the "people" section (customer detail, corporate clients, document vault).
 *
 *   cd /home/claude/typease && export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
 *   node packages/ui/scripts/screenshots.mjs --app centre --scenarios apps/centre-web/scripts/shots-people.mjs --out /tmp/shots-people
 *   ... --only people-customer-overview,people-documents          (a few of them)
 *
 * The records are looked up through the API of the seeded demo centre (al-noor), so the scenarios do not
 * depend on generated ids. Scenarios whose name starts with "people-flow-" change data: they drive a
 * real flow once (edit, note, tag, consent, merge, upload, verify, share, company, employee, price).
 */
const API = process.env.TYPEASE_API ?? 'http://localhost:4000/api/v1';
const OWNER = 'owner@al-noor.test';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'TypEase-Demo-2026';
const LIST_READY = 'main table tbody tr a:visible, main ul li a:visible';
const EN = ['en-light-desktop'];

const tokens = new Map();
async function api(method, path, body, as = OWNER) {
  if (!tokens.has(as)) {
    tokens.set(
      as,
      fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client-App': 'centre' }, body: JSON.stringify({ email: as, password: PASSWORD, app: 'centre' }) })
        .then((r) => r.json())
        .then((r) => r.accessToken),
    );
  }
  const token = await tokens.get(as);
  const res = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'X-Client-App': 'centre', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data?.code ?? ''} ${data?.message ?? ''}`);
  return data;
}
const first = async (path) => (await api('GET', path)).data[0];

const aisha = await first('/customers?q=aisha.rahman@example.test');
const falcon = await first('/corporate-accounts?q=Falcon');
const blueDune = await first('/corporate-accounts?q=Blue%20Dune');
const verifiedDoc = await first(`/documents?customerId=${aisha.id}&verificationStatus=VERIFIED&pageSize=1`);
const rejectedDoc = await first('/documents?verificationStatus=REJECTED&pageSize=1');
const quarantinedDoc = await first('/documents?status=QUARANTINED&pageSize=1');
const STARTER = 'owner@desert-rose.test';
const starterDoc = (await api('GET', '/documents?pageSize=1', undefined, STARTER)).data[0];
// Records for the merge / erasure checks (created through the API by an earlier verification run; skipped when absent).
const mergedRecords = (await api('GET', '/customers?status=MERGED&pageSize=50')).data;
/** A retired record whose kept record was erased after a deletion request (it lost its personal data as well). */
const mergedErased = mergedRecords.find((c) => c.fullName === 'Erased customer');
/** A retired record that kept an issued invoice and a payment. */
const mergedFinance = mergedRecords.find((c) => /^Merge Finance/.test(c.fullName));
const flowCompanies = (await api('GET', '/corporate-accounts?q=Flow%20Test%20Trading&pageSize=50')).data.filter((a) => a.status === 'ACTIVE');
/** A test company (created by people-flow-corporate) for the employee-login flow. */
const flowCompany = flowCompanies[0];
/** The test company with an employee whose data was erased after a deletion request. */
let erasedCompany = null;
for (const company of flowCompanies) {
  const employees = (await api('GET', `/corporate-accounts/${company.id}/employees?status=ALL&pageSize=100`)).data;
  if (employees.some((e) => e.customerStatus === 'ANONYMISED')) {
    erasedCompany = company;
    break;
  }
}
const heldDoc = mergedErased ? (await api('GET', `/documents?customerId=${mergedErased.mergedIntoId}&pageSize=1`)).data[0] : null;
const ALL = ['en-light-desktop', 'ar-dark-desktop', 'en-light-mobile'];
/** The employees table of a company, narrowed to one person by the search box; opens that row's menu. */
const employeeMenu = async (page, name) => {
  const search = page.locator('main [role="tabpanel"] input[type="search"], main [role="tabpanel"] input[role="searchbox"]').first();
  await search.fill(name);
  const row = page.locator('main [role="tabpanel"] tbody tr:visible, main [role="tabpanel"] ul > li:visible').filter({ hasText: name }).first();
  await row.waitFor({ timeout: 30_000 });
  await page.waitForTimeout(400);
  await row.locator('button[aria-haspopup="menu"]').click();
};
/** "Everyone" in the employees filter (active and inactive). */
const showEveryEmployee = async (page) => {
  await page.locator('main [role="tabpanel"] button[role="combobox"]:visible').first().click();
  await page.getByRole('option').last().click();
  await page.waitForTimeout(600);
};


// ---------------------------------------------------------------- helpers for the flows
import { resolve } from 'node:path';
const outArg = process.argv.indexOf('--out');
const OUT = resolve(process.cwd(), outArg >= 0 ? process.argv[outArg + 1] : 'docs/brand/screenshots');
/** An extra picture in the middle of a flow: <out>/centre-<name>.png */
const snap = async (page, name) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(OUT, `centre-${name}.png`), animations: 'disabled' });
};
const stamp = () => Date.now().toString().slice(-7);
const dialog = (page) => page.getByRole('dialog').last();
const toast = (page, text) => page.locator('[data-sonner-toast]', { hasText: text }).first().waitFor({ timeout: 20_000 });
/** Choose from a searchable picker (Combobox): open it, type, click the option. */
async function pick(page, trigger, text, option = text) {
  await trigger.click();
  await page.locator('[cmdk-input]').fill(text);
  await page.locator('[cmdk-item]', { hasText: option }).first().click();
}
const openDetail = async (page, path, ready = 'main [role="tabpanel"] dl') => {
  await page.goto(`http://localhost:3001${path}`, { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 90_000 });
  await page.locator(ready).first().waitFor({ state: 'visible', timeout: 90_000 });
};
/** A test customer with an Emirates ID and passport (fictional numbers that pass the format rules). */
async function createTestCustomer(overrides = {}) {
  const n = stamp();
  return api('POST', '/customers', {
    fullName: `Flow Test ${n}`,
    phone: `+97155${n}`,
    email: `flow.test.${n}@example.test`,
    nationality: 'PH',
    emiratesId: `7841990${n}0`.padEnd(15, '1').slice(0, 15),
    passportNo: `FT${n}`,
    confirmNotDuplicate: true,
    ...overrides,
  });
}
// 1x1 PNG and a one-page PDF, built in memory (the API checks the real file signature).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 60>>stream\nBT /F1 18 Tf 30 100 Td (Sample document - fictional) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

/** Uploads one file for a customer through the three API steps (intent, bytes, complete) and waits for the security check. */
async function uploadTestDocument(customerId, title) {
  const intent = await api('POST', '/documents/upload-intents', { customerId, documentTypeKey: 'passport', title, filename: 'passport-scan.pdf', mime: 'application/pdf', sizeBytes: PDF.length });
  const put = await fetch(intent.upload.url, { method: 'PUT', headers: intent.upload.headers, body: PDF });
  if (!put.ok) throw new Error(`upload failed: ${put.status}`);
  await api('POST', `/documents/${intent.documentId}/versions/${intent.versionId}/complete`);
  for (let i = 0; i < 30; i++) {
    const doc = await api('GET', `/documents/${intent.documentId}`);
    if (doc.status === 'AVAILABLE') return doc;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('the uploaded document did not become available');
}

const flows = [
  // ---- edit a customer, reveal identity numbers, add a note and a tag, record a consent
  {
    name: 'people-flow-customer',
    path: '/customers',
    as: OWNER,
    ready: LIST_READY,
    variants: EN,
    act: async (page) => {
      const customer = await createTestCustomer();
      await openDetail(page, `/customers/${customer.id}`);

      // edit
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      await dialog(page).getByLabel('Full name (Arabic)').fill('اختبار المسار');
      await dialog(page).getByLabel('City').fill('Sharjah');
      await snap(page, 'people-flow-customer-1-edit-en-light-desktop');
      await dialog(page).getByRole('button', { name: 'Save changes' }).click();
      await toast(page, 'Customer saved');
      await page.locator('main h1', { hasText: 'اختبار المسار' }).waitFor();

      // reveal identity numbers
      await page.getByRole('button', { name: 'Show full numbers' }).click();
      await snap(page, 'people-flow-customer-2-reveal-ask-en-light-desktop');
      await dialog(page).getByRole('button', { name: 'Show the numbers' }).click();
      await dialog(page).getByText(/^784-/).waitFor();
      await snap(page, 'people-flow-customer-3-revealed-en-light-desktop');
      await dialog(page).getByRole('button', { name: 'Hide now' }).click();

      // note
      await page.getByPlaceholder('Anything your colleagues should know').fill('Collects documents on Fridays only. (flow test)');
      await page.getByLabel('Pin to the top').click();
      await page.getByRole('button', { name: 'Add note' }).click();
      await toast(page, 'Note added');

      // tag: tick an existing one and create a new one
      await page.getByRole('button', { name: 'Change', exact: true }).click();
      await dialog(page).getByLabel('VIP').first().click();
      await toast(page, 'Tag added');
      await dialog(page).getByLabel('Name').fill(`Flow ${stamp()}`);
      await dialog(page).getByRole('radio', { name: 'Colour 2' }).click();
      await snap(page, 'people-flow-customer-4-tags-en-light-desktop');
      await dialog(page).getByRole('button', { name: 'Create and add' }).click();
      await toast(page, 'Tag created');
      await dialog(page).getByRole('button', { name: 'Done' }).click();

      // consent
      await page.locator('li', { hasText: 'Offers and news from the centre.' }).getByRole('button', { name: 'Record a change' }).click();
      await dialog(page).getByLabel('Privacy notice version').fill('v3');
      await snap(page, 'people-flow-customer-5-consent-en-light-desktop');
      await dialog(page).getByRole('button', { name: 'Record decision' }).click();
      await toast(page, 'Consent recorded');
      await page.getByRole('button', { name: 'History', exact: true }).click();
      await dialog(page).getByText('Offers and news: Agreed').waitFor();
      await snap(page, 'people-flow-customer-6-consent-history-en-light-desktop');
      await dialog(page).getByRole('button', { name: 'Close' }).last().click();
      await page.evaluate(() => window.scrollTo(0, 0));
    },
    fullPage: true,
  },

  // ---- merge two test customers that share a mobile number
  {
    name: 'people-flow-merge',
    path: '/customers',
    as: OWNER,
    ready: LIST_READY,
    variants: EN,
    act: async (page) => {
      const kept = await createTestCustomer();
      const retired = await createTestCustomer({ fullName: `${kept.fullName} Duplicate`, phone: kept.phone, emiratesId: undefined, passportNo: undefined, nationality: undefined });
      await api('POST', `/customers/${retired.id}/notes`, { body: 'Note on the duplicate record. (flow test)' });
      await openDetail(page, `/customers/${kept.id}`);
      // the possible-duplicates panel finds the second record through the shared mobile
      await page.getByText('Strong match').first().waitFor();
      await page.getByText('Possible duplicates').scrollIntoViewIfNeeded();
      await snap(page, 'people-flow-merge-1-duplicates-en-light-desktop');
      await page.getByRole('button', { name: 'Compare and merge' }).first().click();
      await dialog(page).getByText('The two records side by side').waitFor({ state: 'attached' });
      await snap(page, 'people-flow-merge-2-compare-en-light-desktop');
      await dialog(page).getByRole('button', { name: 'Continue' }).click();
      await dialog(page).getByLabel(/Type CUS-/).fill(retired.customerNo);
      await dialog(page).getByLabel('Reason').fill('Same person registered twice at the counter; same mobile number, passport seen.');
      await snap(page, 'people-flow-merge-3-confirm-en-light-desktop');
      await dialog(page).getByRole('button', { name: 'Merge records' }).click();
      await dialog(page).getByText('Moved to the kept record').waitFor({ timeout: 30_000 });
      await snap(page, 'people-flow-merge-4-result-en-light-desktop');
      await dialog(page).getByRole('button', { name: 'Done' }).click();
      await page.getByText('Records merged into this one:').waitFor();
      await page.evaluate(() => window.scrollTo(0, 0));
    },
  },
  // the retired record of the last merge, read-only
  {
    name: 'people-flow-merged-record',
    path: '/customers?status=MERGED',
    as: OWNER,
    ready: LIST_READY,
    variants: EN,
    act: async (page) => {
      const merged = await first('/customers?status=MERGED&sort=createdAt:desc&pageSize=1');
      await openDetail(page, `/customers/${merged.id}`);
    },
  },
  // ---- upload a document for a customer, verify it, create and revoke a share link
  {
    name: 'people-flow-document',
    path: '/documents',
    as: OWNER,
    ready: LIST_READY,
    variants: EN,
    act: async (page) => {
      const customer = await createTestCustomer();
      await page.getByRole('button', { name: 'Upload documents' }).first().click();
      const d = dialog(page);
      await pick(page, d.getByRole('combobox').nth(0), customer.fullName);
      await pick(page, d.getByRole('combobox').nth(1), 'Passport');
      await d.getByLabel('Title').fill('Passport copy (flow test)');
      await d.locator('input[type="date"]').fill('2031-05-01');
      await d.locator('input[type="file"]').first().setInputFiles([
        { name: 'passport-page.png', mimeType: 'image/png', buffer: PNG },
        { name: 'passport-scan.pdf', mimeType: 'application/pdf', buffer: PDF },
      ]);
      await d.getByText('Uploaded', { exact: true }).nth(1).waitFor({ timeout: 60_000 });
      await d.getByText('Each file is checked for viruses').scrollIntoViewIfNeeded();
      await snap(page, 'people-flow-document-1-upload-en-light-desktop');
      await d.getByRole('button', { name: 'Done' }).click();

      // open the PNG, wait for the security check, verify it
      const png = (await api('GET', `/documents?customerId=${customer.id}&q=Passport%20copy`)).data.find((x) => x.currentVersion.mime === 'image/png');
      for (let i = 0; i < 20; i++) {
        if ((await api('GET', `/documents/${png.id}`)).status === 'AVAILABLE') break;
        await page.waitForTimeout(1000);
      }
      await openDetail(page, `/documents/${png.id}`);
      await page.getByRole('button', { name: 'View file' }).click();
      await dialog(page).locator('img').waitFor({ timeout: 30_000 });
      await snap(page, 'people-flow-document-2-preview-en-light-desktop');
      await dialog(page).getByRole('button', { name: 'Close' }).last().click();
      await page.getByRole('button', { name: 'Approve document' }).click();
      await toast(page, 'Document approved');
      await page.getByText('was confirmed against the document').waitFor();
      await snap(page, 'people-flow-document-3-verified-en-light-desktop');

      // share link: create (shown once), then revoke
      await page.getByRole('tab', { name: 'Sharing' }).click();
      await page.getByRole('button', { name: 'Create link' }).first().click();
      await dialog(page).getByLabel('Who is it for?').fill('Customer, by WhatsApp (flow test)');
      await snap(page, 'people-flow-document-4-share-form-en-light-desktop');
      await dialog(page).getByRole('button', { name: 'Create link' }).click();
      await dialog(page).getByText('Shown only once').waitFor();
      await snap(page, 'people-flow-document-5-share-link-en-light-desktop');
      await dialog(page).getByRole('button', { name: 'Done' }).click();
      await page.getByText('0 of 3 downloads used').waitFor();
      await snap(page, 'people-flow-document-6-share-list-en-light-desktop');
      await page.getByRole('button', { name: 'Revoke' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke' }).click();
      await toast(page, 'Link revoked');
      await page.getByText('Revoked', { exact: true }).waitFor();
      await page.getByRole('tab', { name: 'Access log' }).click();
      await page.getByText('Share link revoked').first().waitFor();
    },
  },

  // ---- a new company with an employee, a pasted list, a contract price, verification, credit and a contact
  {
    name: 'people-flow-corporate',
    path: '/corporate',
    as: OWNER,
    ready: LIST_READY,
    variants: EN,
    act: async (page) => {
      const n = stamp();
      await page.getByRole('button', { name: 'Add company' }).first().click();
      let d = dialog(page);
      await d.getByLabel('Company name (English)').fill(`Flow Test Trading ${n} LLC`);
      await d.getByLabel('Trade licence number').fill(`FLOW-TL-${n}`);
      await d.getByLabel('Email for invoices').fill(`accounts.${n}@flow-test.test`);
      await d.getByLabel('Payment terms').fill('30');
      await d.getByLabel('Credit limit').fill('5000');
      await snap(page, 'people-flow-corporate-1-create-en-light-desktop');
      await d.getByRole('button', { name: 'Add company' }).click();
      await page.waitForURL(/\/corporate\/[0-9a-f-]{36}/, { timeout: 30_000 });
      await page.locator('main [role="tabpanel"] dl').first().waitFor();

      // employee
      await page.getByRole('tab', { name: 'Employees' }).click();
      await page.getByRole('button', { name: 'Add employee' }).first().click();
      d = dialog(page);
      await d.getByLabel('Full name (English)').fill(`Ravi Flow ${n}`);
      await d.getByLabel('Employee no.').fill('E-100');
      await d.getByLabel('Job title').fill('Electrician');
      await d.getByLabel('Passport number').fill(`RF${n}`);
      await snap(page, 'people-flow-corporate-2-employee-en-light-desktop');
      await d.getByRole('button', { name: 'Add employee' }).click();
      await toast(page, 'Employee added');

      // several employees pasted from a spreadsheet: one row is wrong on purpose
      await page.getByRole('button', { name: 'Add several' }).first().click();
      d = dialog(page);
      const rows = [`Full name\tEmployee no.\tJob title\tMobile\tEmail\tNationality\tPassport no.\tEmirates ID`, `Sunil Flow ${n}\tE-101\tDriver\t055${n}\tsunil.${n}@flow-test.test\tIN\tSF${n}\t`, `Maria Flow ${n}\tE-102\tAccountant\t12\tnot-an-email\tPH\t\t784-1990`
];
      await d.getByLabel('Rows to add').fill(rows.join('\n'));
      await d.getByText('needs correction').waitFor();
      await snap(page, 'people-flow-corporate-3-bulk-invalid-en-light-desktop');
      rows[2] = `Maria Flow ${n}\tE-102\tAccountant\t056${n}\tmaria.${n}@flow-test.test\tPH\tMF${n}\t`;
      await d.getByLabel('Rows to add').fill(rows.join('\n'));
      await d.getByRole('button', { name: 'Add 2 employees' }).click();
      await d.getByText('2 employees added').first().waitFor({ timeout: 30_000 });
      await snap(page, 'people-flow-corporate-4-bulk-done-en-light-desktop');
      await d.getByRole('button', { name: 'Done' }).click();
      await page.getByRole('link', { name: `Sunil Flow ${n}` }).first().waitFor();
      await snap(page, 'people-flow-corporate-5-employees-en-light-desktop');

      // contract price
      await page.getByRole('tab', { name: 'Contract prices' }).click();
      await page.getByRole('button', { name: 'Add contract price' }).first().click();
      d = dialog(page);
      await pick(page, d.getByRole('combobox').first(), 'Emirates ID', 'Emirates ID application typing');
      await d.getByText('Catalogue service fee').waitFor();
      await d.getByLabel('Contract service fee').fill('55');
      await snap(page, 'people-flow-corporate-6-price-en-light-desktop');
      await d.getByRole('button', { name: 'Save price' }).click();
      await toast(page, 'Contract price saved');
      await page.getByText('below the catalogue fee').waitFor();

      // agreement
      await page.getByRole('tab', { name: 'Agreements' }).click();
      await page.getByRole('button', { name: 'Add agreement' }).first().click();
      d = dialog(page);
      await d.getByLabel('Title').fill('Employee document services 2026 (flow test)');
      await d.getByLabel('Terms').fill('Per-file fees as in the contract price list. Monthly statement, 30 days.');
      await d.getByRole('button', { name: 'Add agreement' }).click();
      await toast(page, 'Agreement added');

      // verify, then approve credit
      await page.getByRole('tab', { name: 'Overview' }).click();
      await page.getByRole('button', { name: 'Verify company' }).first().click();
      d = dialog(page);
      await d.getByLabel('What did you check?').fill('Trade licence and authorisation letter of the signatory seen. (flow test)');
      await snap(page, 'people-flow-corporate-7-verify-en-light-desktop');
      await d.getByRole('button', { name: 'Verify company' }).click();
      await toast(page, 'Company verified');
      await page.getByRole('button', { name: 'Approve credit' }).first().click();
      d = dialog(page);
      await d.getByLabel('Reason for the decision').fill('Approved by the owner after reviewing the licence. (flow test)');
      await snap(page, 'people-flow-corporate-8-credit-en-light-desktop');
      await d.getByRole('button', { name: 'Approve credit' }).last().click();
      await toast(page, 'Credit approved');

      // editing the approved terms withdraws the approval: the form says so before saving
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      d = dialog(page);
      await d.getByLabel('Credit limit').fill('8000');
      await d.getByText('Saving this withdraws the credit approval').waitFor();
      await d.getByText('Saving this withdraws the credit approval').scrollIntoViewIfNeeded();
      await snap(page, 'people-flow-corporate-9-withdraw-warning-en-light-desktop');
      await d.getByRole('button', { name: 'Save changes' }).click();
      await toast(page, 'The credit approval was withdrawn');

      // authorised contact
      await page.getByRole('tab', { name: 'Authorised contacts' }).click();
      await page.getByRole('button', { name: 'Invite contact' }).first().click();
      d = dialog(page);
      await d.getByLabel('Full name').fill(`Nadia Flow ${n}`);
      await d.getByLabel('Email address').fill(`pro.${n}@flow-test.test`);
      await d.getByRole('button', { name: 'Send invitation' }).click();
      await toast(page, 'Invitation sent');
      await page.getByText(`Nadia Flow ${n}`).waitFor();
      await snap(page, 'people-flow-corporate-10-contacts-en-light-desktop');
      await page.getByRole('tab', { name: 'Overview' }).click();
      await page.waitForTimeout(600);
    },
    fullPage: true,
  },
  // ---- the remaining customer actions: contact, portal invitation, duplicate warning on edit, archive / restore
  {
    name: 'people-flow-customer-more',
    path: '/customers',
    as: OWNER,
    ready: LIST_READY,
    variants: EN,
    act: async (page) => {
      const customer = await createTestCustomer();
      await openDetail(page, `/customers/${customer.id}`);

      // additional contact: add, edit, delete
      await page.getByRole('button', { name: 'Add contact' }).click();
      let d = dialog(page);
      await d.locator('input[type="tel"]').fill('0561234567');
      await d.getByLabel('Label').fill('Work');
      await d.getByRole('button', { name: 'Add contact' }).click();
      await toast(page, 'Contact added');
      await page.getByRole('button', { name: 'More actions' }).first().click();
      await page.getByRole('menuitem', { name: 'Edit' }).click();
      d = dialog(page);
      await d.getByLabel('Label').fill('Office');
      await d.getByRole('button', { name: 'Save changes' }).click();
      await toast(page, 'Contact saved');
      await page.getByText('· Office').waitFor();
      await page.getByRole('button', { name: 'More actions' }).first().click();
      await page.getByRole('menuitem', { name: 'Delete' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
      await toast(page, 'Contact deleted');

      // changing the mobile to one another customer has: the API answers POSSIBLE_DUPLICATE
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      d = dialog(page);
      await d.locator('input[type="tel"]').fill(aisha.phone.replace('+971', '0'));
      await d.getByRole('button', { name: 'Save changes' }).click();
      await d.getByText('This customer may already exist').waitFor();
      await d.getByText('This customer may already exist').scrollIntoViewIfNeeded();
      await snap(page, 'people-flow-customer-more-1-duplicate-on-edit-en-light-desktop');
      await d.getByRole('button', { name: 'Cancel' }).click();

      // portal invitation
      await page.getByRole('button', { name: 'Invite to the portal' }).first().click();
      d = dialog(page);
      await snap(page, 'people-flow-customer-more-2-invite-en-light-desktop');
      await d.getByRole('button', { name: 'Invite to the portal' }).click();
      await toast(page, 'Invitation sent');
      await page.getByRole('button', { name: 'Send invitation again' }).first().waitFor();

      // archive and restore
      await page.getByRole('button', { name: 'More', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Archive customer' }).click();
      let a = page.getByRole('alertdialog');
      await a.getByLabel('Reason').fill('Registered by mistake. (flow test)');
      await a.getByRole('button', { name: 'Archive customer' }).click();
      await toast(page, 'Customer archived');
      await page.getByText('This customer is archived').waitFor();
      await snap(page, 'people-flow-customer-more-3-archived-en-light-desktop');
      await page.getByRole('button', { name: 'Restore customer' }).first().click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Restore customer' }).click();
      await toast(page, 'Customer restored');

      // a customer with open requests cannot be archived: the API's reason is shown in the dialog
      await openDetail(page, `/customers/${aisha.id}`);
      await page.getByRole('button', { name: 'More', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Archive customer' }).click();
      a = page.getByRole('alertdialog');
      await a.getByRole('button', { name: 'Archive customer' }).click();
      await a.getByText('This customer cannot be archived yet').waitFor();
    },
  },
  // ---- the remaining document actions: edit, new version, correction request, legal hold blocks deletion, delete / restore
  {
    name: 'people-flow-document-more',
    path: '/documents',
    as: OWNER,
    ready: LIST_READY,
    variants: EN,
    act: async (page) => {
      const customer = await createTestCustomer();
      const doc = await uploadTestDocument(customer.id, 'Passport scan (flow test)');
      await openDetail(page, `/documents/${doc.id}`);
      const more = async (item) => {
        await page.getByRole('button', { name: 'More', exact: true }).click();
        await page.getByRole('menuitem', { name: item }).click();
      };

      await more('Edit details');
      let d = dialog(page);
      await d.getByLabel('Title').fill(`Passport scan ${stamp()} (flow test)`);
      // a category reserved for files the system generates is refused at the field (422 CATEGORY_RESERVED)
      await d.getByLabel('Category').fill('restricted:reports');
      await d.getByRole('button', { name: 'Save changes' }).click();
      await d.getByText('are reserved for files the system generates').waitFor();
      await snap(page, 'people-flow-document-more-0-category-reserved-en-light-desktop');
      await d.getByLabel('Category').fill('Identity');
      await d.getByRole('button', { name: 'Save changes' }).click();
      await toast(page, 'Document saved');

      await page.getByRole('button', { name: 'Upload new version' }).click();
      d = dialog(page);
      await d.locator('input[type="file"]').first().setInputFiles([{ name: 'passport-scan-v2.pdf', mimeType: 'application/pdf', buffer: PDF }]);
      await d.getByText('New version uploaded').waitFor({ timeout: 60_000 });
      await d.getByRole('button', { name: 'Done' }).click();
      await page.getByText('Version 2').waitFor({ timeout: 30_000 });
      for (let i = 0; i < 20; i++) {
        if ((await api('GET', `/documents/${doc.id}`)).currentVersion.versionNo === 2) break;
        await page.waitForTimeout(1000);
      }
      await openDetail(page, `/documents/${doc.id}`);

      // ask for a correction (reason is required)
      await page.getByLabel('Ask for a correction').click();
      await page.getByRole('button', { name: 'Ask for correction' }).click();
      await page.locator('main [role="alert"]').first().waitFor();
      await page.getByLabel('Reason').fill('The second page is cut off. Please upload the full page. (flow test)');
      await snap(page, 'people-flow-document-more-1-correction-en-light-desktop');
      await page.getByRole('button', { name: 'Ask for correction' }).click();
      await toast(page, 'Correction requested');

      // legal hold blocks deletion
      await more('Place legal hold');
      d = dialog(page);
      await d.getByLabel('Reason').fill('Needed for a pending complaint. (flow test)');
      await d.getByRole('button', { name: 'Place legal hold' }).click();
      await toast(page, 'Legal hold placed');
      await more('Delete document');
      let a = page.getByRole('alertdialog');
      await a.getByRole('button', { name: 'Delete document' }).click();
      await a.getByText('Under legal hold').first().waitFor();
      await snap(page, 'people-flow-document-more-2-delete-blocked-en-light-desktop');
      await a.getByRole('button', { name: 'Cancel' }).click();
      await more('Release legal hold');
      d = dialog(page);
      await d.getByLabel('Reason').fill('Complaint closed. (flow test)');
      await d.getByRole('button', { name: 'Release legal hold' }).click();
      await toast(page, 'Legal hold released');

      // delete and restore
      await more('Delete document');
      a = page.getByRole('alertdialog');
      await a.getByRole('button', { name: 'Delete document' }).click();
      await toast(page, 'Document deleted');
      await page.getByText('This document was deleted').waitFor();
      await snap(page, 'people-flow-document-more-3-deleted-en-light-desktop');
      await page.getByRole('button', { name: 'Restore document' }).first().click();
      await toast(page, 'Document restored');
      await page.getByRole('tab', { name: 'Access log' }).click();
      await page.getByText('Legal hold changed').first().waitFor();
    },
  },
  // ---- the remaining company actions on the company of people-flow-corporate
  {
    name: 'people-flow-corporate-more',
    path: '/corporate',
    as: OWNER,
    ready: LIST_READY,
    variants: EN,
    act: async (page) => {
      // its own company, set up through the API: verified, with one contact, one employee, one price, one agreement
      const n = stamp();
      const company = await api('POST', '/corporate-accounts', { companyName: `Flow Test Services ${n} LLC`, tradeLicenceNo: `FLOW-TL-${n}` });
      await api('POST', `/corporate-accounts/${company.id}/verify`, { note: 'Set up by the screenshot scenario (flow test).' });
      await api('POST', `/corporate-accounts/${company.id}/members`, { fullName: `Nadia Flow ${n}`, email: `pro.${n}@flow-test.test` });
      await api('POST', `/corporate-accounts/${company.id}/employees`, { fullName: `Ravi Flow ${n}`, employeeNo: 'E-100', designation: 'Electrician' });
      const service = await first('/services?pageSize=1&sort=name:asc');
      await api('PUT', `/corporate-accounts/${company.id}/prices`, { serviceId: service.id, serviceFee: '55.00' });
      await api('POST', `/corporate-accounts/${company.id}/agreements`, { title: 'Employee document services 2026 (flow test)', startsOn: '2026-10-01', terms: 'Sample terms.' });
      await openDetail(page, `/corporate/${company.id}?tab=contacts`, 'main [role="tabpanel"] ul li');
      const rowMenu = async (item) => {
        await page.locator('main [role="tabpanel"]').getByRole('button', { name: /More actions/ }).first().click();
        await page.getByRole('menuitem', { name: item }).click();
      };
      const more = async (item) => {
        await page.getByRole('button', { name: 'More', exact: true }).click();
        await page.getByRole('menuitem', { name: item }).click();
      };

      // contact: send again, withdraw
      await rowMenu('Send invitation again');
      await toast(page, 'Invitation sent again');
      await rowMenu('Withdraw invitation');
      await page.getByRole('alertdialog').getByRole('button', { name: 'Withdraw invitation' }).click();
      await toast(page, 'Contact removed');

      // employee: edit, deactivate
      await page.getByRole('tab', { name: 'Employees' }).click();
      await page.locator('main table tbody tr a').first().waitFor();
      await rowMenu('Edit');
      let d = dialog(page);
      await d.getByLabel('Job title').fill('Senior technician');
      await d.getByRole('button', { name: 'Save changes' }).click();
      await toast(page, 'Employee saved');
      await rowMenu('Deactivate');
      await toast(page, 'Employee deactivated');

      // contract price: change, remove
      await page.getByRole('tab', { name: 'Contract prices' }).click();
      await page.getByRole('button', { name: /Change price/ }).first().click();
      d = dialog(page);
      await d.getByLabel('Contract service fee').fill('60');
      await d.getByRole('button', { name: 'Save price' }).click();
      await toast(page, 'Contract price saved');
      await page.getByRole('button', { name: /^Remove:/ }).first().click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
      await toast(page, 'Contract price removed');

      // agreement: edit, delete
      await page.getByRole('tab', { name: 'Agreements' }).click();
      await page.locator('main [role="tabpanel"]').getByRole('button', { name: 'Edit', exact: true }).first().click();
      d = dialog(page);
      await d.getByLabel('Title').fill('Employee document services 2026, revised (flow test)');
      await d.getByRole('button', { name: 'Save changes' }).click();
      await toast(page, 'Agreement saved');
      await page.getByRole('button', { name: /^Delete:/ }).first().click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
      await toast(page, 'Agreement deleted');

      // suspend, reactivate, archive
      await more('Suspend company');
      d = dialog(page);
      await d.getByLabel('Reason').fill('Invoices overdue. (flow test)');
      await d.getByRole('button', { name: 'Suspend company' }).click();
      await toast(page, 'Company suspended');
      await page.getByText('This company is suspended').waitFor();
      await snap(page, 'people-flow-corporate-more-1-suspended-en-light-desktop');
      await more('Reactivate company');
      await page.getByRole('alertdialog').getByRole('button', { name: 'Reactivate company' }).click();
      await toast(page, 'Company reactivated');
      await more('Archive company');
      d = dialog(page);
      await d.getByLabel('Reason').fill('Test company no longer needed. (flow test)');
      await d.getByRole('button', { name: 'Archive company' }).click();
      await toast(page, 'Company archived');
      await page.getByText('This company is archived').waitFor();
    },
  },
  // ---- portal login of an employee: invite, send again, another address, withdraw, accept (API), suspended by deactivating, remove
  ...(flowCompany
    ? [
        {
          name: 'people-flow-employee-login',
          path: `/corporate/${flowCompany.id}?tab=employees`,
          as: OWNER,
          ready: LIST_READY,
          variants: EN,
          act: async (page) => {
            const n = stamp();
            const base = `/corporate-accounts/${flowCompany.id}/employees`;
            const person = await api('POST', base, { fullName: `Login Test ${n}`, email: `login.test.${n}@flow-test.test`, employeeNo: `L-${n.slice(-4)}`, designation: 'Driver' });
            const noMail = await api('POST', base, { fullName: `Login Nomail ${n}` });
            const reopen = async () => {
              await openDetail(page, `/corporate/${flowCompany.id}?tab=employees`, LIST_READY);
            };
            const openLogin = async (name) => {
              await employeeMenu(page, name);
              await page.getByRole('menuitem', { name: 'Portal login' }).click();
              const d = dialog(page);
              await d.getByRole('heading', { name: 'Portal login' }).waitFor();
              return d;
            };
            const close = async (d) => {
              await d.getByRole('button', { name: 'Close' }).first().click();
              await d.waitFor({ state: 'hidden' });
            };
            await reopen();

            // no login yet -> invite to the address on the record
            let d = await openLogin(person.fullName);
            await d.getByText('has no login for the corporate portal').waitFor();
            await snap(page, 'people-flow-employee-login-1-none-en-light-desktop');
            await d.getByRole('button', { name: 'Send invitation', exact: true }).click();
            await toast(page, 'Invitation sent');
            await d.getByText(`login.test.${n}@flow-test.test`).first().waitFor();
            await d.getByText('Invited').first().waitFor();
            await snap(page, 'people-flow-employee-login-2-invited-en-light-desktop');

            // send it again
            await d.getByRole('button', { name: 'Send invitation again' }).click();
            await toast(page, 'Invitation sent again');

            // another address: one that is already a corporate login at the centre is refused at the field ...
            await d.getByRole('button', { name: 'Use another address' }).click();
            await d.getByLabel('Send the invitation to').fill('admin@falcon-demo.test');
            await d.getByRole('button', { name: 'Send invitation', exact: true }).click();
            await d.getByText('already used for another corporate login').waitFor();
            await snap(page, 'people-flow-employee-login-3-email-in-use-en-light-desktop');
            // ... a free one replaces the earlier invitation
            await d.getByLabel('Send the invitation to').fill(`login.other.${n}@flow-test.test`);
            await d.getByRole('button', { name: 'Send invitation', exact: true }).click();
            await d.getByText(`login.other.${n}@flow-test.test`).first().waitFor({ timeout: 20_000 });
            await close(d);
            await page.locator('main [role="tabpanel"] tbody tr', { hasText: person.fullName }).getByText('Invited').waitFor({ timeout: 20_000 });
            await snap(page, 'people-flow-employee-login-4-list-en-light-desktop');

            // withdraw the invitation
            d = await openLogin(person.fullName);
            await d.getByRole('button', { name: 'Withdraw invitation' }).click();
            await page.getByRole('alertdialog').getByRole('button', { name: 'Withdraw invitation' }).click();
            await toast(page, 'Invitation withdrawn');
            await d.getByText('has no login for the corporate portal').waitFor();
            await close(d);

            // an employee without an email address: the API asks for one, shown at the field
            d = await openLogin(noMail.fullName);
            await d.getByRole('button', { name: 'Send invitation', exact: true }).click();
            await d.getByText('Add an email address for this employee').waitFor();
            await snap(page, 'people-flow-employee-login-5-email-required-en-light-desktop');
            await close(d);

            // the person accepts an invitation (through the API, as the email link would): the login is active
            const invited = await api('POST', `${base}/${person.id}/login`, {});
            const accepted = await fetch(`${API}/auth/invitations/accept`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Client-App': 'corporate' },
              body: JSON.stringify({ token: invited.dev.invitationToken, password: PASSWORD, app: 'corporate' }),
            });
            if (!accepted.ok) throw new Error(`accepting the invitation failed: ${accepted.status} ${await accepted.text()}`);
            await reopen();
            d = await openLogin(person.fullName);
            await d.getByText('Active').first().waitFor();
            await d.getByRole('button', { name: 'Remove login' }).waitFor();
            await snap(page, 'people-flow-employee-login-6-active-en-light-desktop');
            await close(d);

            // deactivating the employee suspends the login; it can still be removed
            await employeeMenu(page, person.fullName);
            await page.getByRole('menuitem', { name: 'Deactivate' }).click();
            await toast(page, 'Employee deactivated');
            await showEveryEmployee(page);
            d = await openLogin(person.fullName);
            await d.getByText('Suspended').first().waitFor();
            await d.getByText('This employee is inactive').waitFor();
            await snap(page, 'people-flow-employee-login-7-suspended-en-light-desktop');
            await d.getByRole('button', { name: 'Remove login' }).click();
            await page.getByRole('alertdialog').getByRole('button', { name: 'Remove login' }).click();
            await toast(page, 'Login removed');
            await d.getByText('has no login for the corporate portal').waitFor();
          },
        },
      ]
    : []),
];

export default [
  ...flows,
  // ---------------------------------------------------------------- customer detail
  { name: 'people-customer-overview', path: `/customers/${aisha.id}`, as: OWNER, ready: 'main [role="tabpanel"] dl', fullPage: true },
  { name: 'people-customer-requests', path: `/customers/${aisha.id}?tab=requests`, as: OWNER, ready: LIST_READY },
  { name: 'people-customer-documents', path: `/customers/${aisha.id}?tab=documents`, as: OWNER, ready: LIST_READY },
  { name: 'people-customer-invoices', path: `/customers/${aisha.id}?tab=invoices`, as: OWNER, ready: LIST_READY },
  { name: 'people-customer-payments', path: `/customers/${aisha.id}?tab=payments`, as: OWNER, ready: LIST_READY },
  { name: 'people-customer-appointments', path: `/customers/${aisha.id}?tab=appointments`, as: OWNER, ready: 'main [role="tabpanel"] table tbody tr td:visible, main [role="tabpanel"] ul li:visible' },
  { name: 'people-customer-communications', path: `/customers/${aisha.id}?tab=communications`, as: OWNER, ready: 'main [role="tabpanel"] table tbody tr td:visible, main [role="tabpanel"] ul li:visible' },
  { name: 'people-customer-reminders', path: `/customers/${aisha.id}?tab=reminders`, as: OWNER, ready: 'main [role="tabpanel"] table tbody tr td:visible, main [role="tabpanel"] ul li:visible' },
  { name: 'people-customer-tickets', path: `/customers/${aisha.id}?tab=tickets`, as: OWNER, ready: LIST_READY },
  { name: 'people-customer-activity', path: `/customers/${aisha.id}?tab=activity`, as: OWNER, ready: 'main [role="tabpanel"] ol li' },
  { name: 'people-customer-reception', path: `/customers/${aisha.id}`, as: 'reception.dubai@al-noor.test', ready: 'main [role="tabpanel"] dl', fullPage: true },
  { name: 'people-customer-not-found', path: '/customers/00000000-0000-4000-8000-000000000000', as: OWNER, ready: 'main h1' },

  // the customers list with the two filters this section added (record status, tag)
  { name: 'people-customers-list', path: '/customers?status=ALL', as: OWNER, ready: LIST_READY },

  // ---------------------------------------------------------------- documents
  { name: 'people-documents', path: '/documents', as: OWNER, ready: LIST_READY },
  { name: 'people-documents-customer', path: `/documents?customerId=${aisha.id}`, as: OWNER, ready: LIST_READY },
  { name: 'people-document-detail', path: `/documents/${verifiedDoc.id}`, as: OWNER, ready: 'main [role="tabpanel"] dl', fullPage: true },
  { name: 'people-document-rejected', path: `/documents/${rejectedDoc.id}`, as: 'reviewer@al-noor.test', ready: 'main [role="tabpanel"] dl', fullPage: true },
  { name: 'people-document-quarantined', path: `/documents/${quarantinedDoc.id}`, as: OWNER, ready: 'main [role="alert"], main [role="tabpanel"] dl', fullPage: true },
  { name: 'people-document-assistant', path: `/documents/${verifiedDoc.id}?tab=assistant`, as: OWNER, ready: 'main [role="tabpanel"] h2' },
  { name: 'people-document-sharing', path: `/documents/${verifiedDoc.id}?tab=sharing`, as: OWNER, ready: 'main [role="tabpanel"] h2' },
  { name: 'people-document-log', path: `/documents/${verifiedDoc.id}?tab=log`, as: OWNER, ready: 'main [role="tabpanel"] table tbody tr td:visible, main [role="tabpanel"] ul li:visible' },

  // ---------------------------------------------------------------- corporate
  { name: 'people-corporate', path: '/corporate', as: OWNER, ready: LIST_READY },
  { name: 'people-corporate-detail', path: `/corporate/${falcon.id}`, as: OWNER, ready: 'main [role="tabpanel"] dl', fullPage: true },
  { name: 'people-corporate-pending', path: `/corporate/${blueDune.id}`, as: OWNER, ready: 'main [role="tabpanel"] dl', fullPage: true },
  { name: 'people-corporate-contacts', path: `/corporate/${falcon.id}?tab=contacts`, as: OWNER, ready: 'main [role="tabpanel"] ul li' },
  { name: 'people-corporate-employees', path: `/corporate/${falcon.id}?tab=employees`, as: OWNER, ready: LIST_READY },
  { name: 'people-corporate-agreements', path: `/corporate/${falcon.id}?tab=agreements`, as: OWNER, ready: 'main [role="tabpanel"] ul li' },
  { name: 'people-corporate-prices', path: `/corporate/${falcon.id}?tab=prices`, as: OWNER, ready: 'main [role="tabpanel"] table tbody tr' },
  { name: 'people-corporate-requests', path: `/corporate/${falcon.id}?tab=requests`, as: OWNER, ready: LIST_READY },
  { name: 'people-corporate-invoices', path: `/corporate/${falcon.id}?tab=invoices`, as: OWNER, ready: 'main [role="tabpanel"] dl', fullPage: true },

  // ---------------------------------------------------------------- merged records, erased records, employee logins
  ...(mergedFinance
    ? [
        { name: 'people-customer-merged-kept-invoices', path: `/customers/${mergedFinance.mergedIntoId}?tab=invoices`, as: OWNER, ready: LIST_READY },
        { name: 'people-customer-merged-kept-payments', path: `/customers/${mergedFinance.mergedIntoId}?tab=payments`, as: OWNER, ready: LIST_READY },
        { name: 'people-customer-merged-retired-invoices', path: `/customers/${mergedFinance.id}?tab=invoices`, as: OWNER, ready: LIST_READY },
        { name: 'people-customer-merged-retired-overview', path: `/customers/${mergedFinance.id}`, as: OWNER, ready: 'main [role="tabpanel"] dl', fullPage: true },
      ]
    : []),
  ...(mergedErased
    ? [
        // The erased record itself no longer answers (404): the page says so.
        { name: 'people-customer-erased', path: `/customers/${mergedErased.mergedIntoId}`, as: OWNER, ready: 'main h1' },
        // A record that had been merged into it: personal data gone, the invoice and the payment that had to stay are still listed.
        { name: 'people-customer-merged-erased', path: `/customers/${mergedErased.id}`, as: OWNER, ready: 'main [role="tabpanel"] dl', fullPage: true },
        { name: 'people-customer-merged-erased-invoices', path: `/customers/${mergedErased.id}?tab=invoices`, as: OWNER, ready: LIST_READY },
        { name: 'people-customers-list-merged', path: '/customers?status=MERGED', as: OWNER, ready: LIST_READY },
      ]
    : []),
  ...(heldDoc ? [{ name: 'people-document-erased-owner', path: `/documents/${heldDoc.id}`, as: OWNER, ready: 'main [role="tabpanel"] dl', fullPage: true }] : []),
  ...(erasedCompany
    ? [
        {
          // The erased employee of the test company: placeholder name, no link, no actions except nothing to do.
          name: 'people-corporate-employees-erased',
          path: `/corporate/${erasedCompany.id}?tab=employees`,
          as: OWNER,
          ready: LIST_READY,
          act: async (page) => {
            await showEveryEmployee(page);
            await page.locator('main [role="tabpanel"] :text-matches("Data erased|مُحيت البيانات") >> visible=true').first().waitFor({ timeout: 30_000 });
          },
        },
      ]
    : []),
  {
    // Ibrahim Saleh of the seeded company has an active portal login.
    name: 'people-corporate-employee-login',
    path: `/corporate/${falcon.id}?tab=employees`,
    as: OWNER,
    ready: LIST_READY,
    act: async (page) => {
      await employeeMenu(page, 'Ibrahim Saleh');
      await page.getByRole('menuitem').nth(1).click();
      await page.getByRole('dialog').last().locator('dl').waitFor();
      await page.waitForTimeout(300);
    },
  },
  {
    // The accountant may read companies but not manage them: the login state without any action.
    name: 'people-corporate-employee-login-readonly',
    path: `/corporate/${falcon.id}?tab=employees`,
    as: 'accountant@al-noor.test',
    ready: LIST_READY,
    variants: EN,
    act: async (page) => {
      await employeeMenu(page, 'Ibrahim Saleh');
      await page.getByRole('menuitem', { name: 'Portal login' }).click();
      await page.getByRole('dialog').last().locator('dl').waitFor();
      await page.waitForTimeout(300);
    },
  },
  {
    // The demo centre's plan includes the corporate portal, so the API never answers 402 for it. ONLY the answer to
    // the invitation is simulated here, with the exact body the API sends on a Starter centre (checked with curl:
    // POST /corporate-accounts/:id/employees/:employeeId/login as owner@desert-rose.test).
    name: 'people-corporate-employee-login-no-portal',
    path: `/corporate/${falcon.id}?tab=employees`,
    as: OWNER,
    ready: LIST_READY,
    variants: ['en-light-desktop', 'ar-dark-desktop'],
    act: async (page) => {
      await page.route('**/api/v1/corporate-accounts/*/employees/*/login', (route) =>
        route.request().method() === 'POST'
          ? route.fulfill({
              status: 402,
              contentType: 'application/json',
              headers: { 'access-control-allow-origin': 'http://localhost:3001', 'access-control-allow-credentials': 'true' },
              body: JSON.stringify({ statusCode: 402, code: 'PLAN_LIMIT_REACHED', message: 'The corporate portal is not included in your plan. Upgrade your subscription to use it.', details: { limit: 'corporatePortal' } }),
            })
          : route.fallback(),
      );
      await employeeMenu(page, 'Suresh Babu');
      await page.getByRole('menuitem').nth(1).click();
      const d = page.getByRole('dialog').last();
      await d.locator('button[type="submit"]').click();
      await d.locator('a[href="/subscription"]').waitFor({ timeout: 20_000 });
      await page.waitForTimeout(300);
    },
  },
  // ---------------------------------------------------------------- dialogs in Arabic / dark and on a phone (nothing is saved)
  {
    name: 'people-customer-edit-dialog',
    path: `/customers/${aisha.id}`,
    as: OWNER,
    ready: 'main [role="tabpanel"] dl',
    variants: ALL,
    act: async (page) => {
      await page.locator('main header button').first().click();
      await page.getByRole('dialog').waitFor();
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'people-customer-merge-dialog',
    path: `/customers/${aisha.id}`,
    as: OWNER,
    ready: 'main [role="tabpanel"] dl',
    variants: ALL,
    act: async (page) => {
      await page.locator('main header button').nth(1).click();
      await page.getByRole('menuitem').nth(1).click();
      const d = page.getByRole('dialog').last();
      await d.getByRole('combobox').first().click();
      await page.locator('[cmdk-input]').fill('Layla');
      await page.locator('[cmdk-item]').first().click();
      await d.locator('table tbody tr').first().waitFor();
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'people-documents-upload-dialog',
    path: `/documents?customerId=${aisha.id}`,
    as: OWNER,
    ready: LIST_READY,
    variants: ALL,
    act: async (page) => {
      await page.locator('main header button').first().click();
      await page.getByRole('dialog').waitFor();
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'people-corporate-bulk-dialog',
    path: `/corporate/${falcon.id}?tab=employees`,
    as: OWNER,
    ready: LIST_READY,
    variants: ALL,
    act: async (page) => {
      await page.locator('main [role="tabpanel"] button').first().click();
      const d = page.getByRole('dialog').last();
      await d.locator('textarea').fill('Sunil Kumar\tE-201\tDriver\t0551234567\tsunil@example.test\tIN\tN1234567\t\nMaria Cruz\tE-202\tAccountant\t12\tnot-an-email\tPH\t\t784-1990');
      await d.locator('table tbody tr').nth(1).waitFor();
      await page.waitForTimeout(300);
    },
  },
  // ---------------------------------------------------------------- other roles and plans
  { name: 'people-corporate-accountant', path: `/corporate/${falcon.id}?tab=invoices`, as: 'accountant@al-noor.test', ready: 'main [role="tabpanel"] dl' },
  { name: 'people-documents-operator', path: '/documents', as: 'operator1@al-noor.test', ready: 'main h1' },
  { name: 'people-corporate-starter-limit', path: '/corporate', as: STARTER, ready: 'main [role="alert"], main h1' },
  ...(starterDoc ? [{ name: 'people-document-assistant-starter', path: `/documents/${starterDoc.id}?tab=assistant`, as: STARTER, ready: 'main [role="tabpanel"] h2' }] : []),
  {
    // The plan of the demo centre includes the corporate portal, so the API never answers 402 here. To see the
    // upgrade message, ONLY the answer to the invitation is simulated (402 PLAN_LIMIT_REACHED as documented in
    // corporate.md); the screen then behaves as it would on a plan without the feature.
    name: 'people-corporate-contacts-no-portal',
    path: `/corporate/${blueDune.id}?tab=contacts`,
    as: OWNER,
    ready: 'main [role="tabpanel"] ul li',
    variants: EN,
    act: async (page) => {
      await page.route('**/api/v1/corporate-accounts/*/members', (route) =>
        route.request().method() === 'POST'
          ? route.fulfill({
              status: 402,
              contentType: 'application/json',
              headers: { 'access-control-allow-origin': 'http://localhost:3001', 'access-control-allow-credentials': 'true' },
              body: JSON.stringify({ statusCode: 402, code: 'PLAN_LIMIT_REACHED', message: 'Your plan does not include the corporate portal.', details: { limit: 'corporatePortal' } }),
            })
          : route.fallback(),
      );
      await page.locator('main [role="tabpanel"] button').first().click();
      const d = page.getByRole('dialog').last();
      await d.locator('input').first().fill('Simulated Contact');
      await d.locator('input[type="email"]').fill('simulated.contact@example.test');
      await d.locator('button[type="submit"]').click();
      await page.locator('main [role="tabpanel"] [role="alert"], main [role="tabpanel"] .border-warning\\/40').first().waitFor();
    },
  },
  {
    // The AI assistant cannot run in this environment (OCR_PROVIDER is "disabled" and the centre has AI switched off).
    // To see the review screen at all, the ANSWERS of the assistant's endpoints are simulated here, shaped exactly as
    // services/api/src/modules/ocr/ocr.service.ts builds them. No real extraction happens; the document is not changed.
    name: 'people-document-assistant-simulated',
    path: '/documents',
    as: OWNER,
    ready: LIST_READY,
    variants: ['en-light-desktop', 'ar-dark-desktop', 'en-light-mobile'],
    act: async (page) => {
      const doc = await first(`/documents?customerId=${aisha.id}&type=passport&pageSize=1`);
      const id = '11111111-1111-4111-8111-111111111111';
      const state = { status: null, reviewed: null, applied: [] };
      const summary = () => ({
        id, documentId: doc.id, versionId: doc.currentVersion.id, provider: 'tesseract', profile: 'PASSPORT', status: state.status, unverified: state.status !== 'REVIEWED',
        classification: 'PASSPORT', classificationConfidence: 0.97, fieldCount: 5, warningCount: { high: 1, medium: 1, low: 0 }, pages: 1, costUnits: '0', error: null,
        requestedById: null, reviewedById: null, reviewedAt: state.status === 'REVIEWED' ? new Date().toISOString() : null, createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      });
      const extracted = [
        ['passportNumber', 'Passport number', 'L898902C3', 0.99, 'MRZ', { value: '•••• 0014', matches: false }, true],
        ['fullName', 'Full name', 'AISHA RAHMAN', 0.9, 'MRZ', { value: 'Aisha Rahman', matches: true }, true],
        ['nationality', 'Nationality', 'IND', 0.92, 'MRZ', { value: 'IN', matches: true }, true],
        ['dateOfBirth', 'Date of birth', '1989-04-12', 0.99, 'MRZ', { value: '1989-04-12', matches: true }, true],
        ['expiryDate', 'Expiry date', '2031-07-04', 0.55, 'TEXT', { value: null, matches: null }, true],
        ['sex', 'Sex', 'F', 0.9, 'MRZ', null, false],
      ];
      const result = () => ({
        ...summary(),
        notice: state.status === 'REVIEWED' ? null : 'Read automatically from the document. Not verified: compare every value with the document before using it.',
        customerId: aisha.id,
        fields: extracted.map(([key, label, value, confidence, source, onFile, canApply]) => ({
          key, label, canApply, extracted: { value, confidence, source }, onFile,
          reviewed: state.reviewed ? { value: state.reviewed[key] ?? null, decision: state.reviewed[key] == null ? 'REJECTED' : state.reviewed[key] === value ? 'CONFIRMED' : 'CORRECTED' } : null,
        })),
        warnings: [
          { code: 'DOCUMENT_NUMBER_MISMATCH', severity: 'HIGH', field: 'passportNumber', message: 'The passport number on the document differs from the one on file.', suggestion: { target: 'customer.passportNo', fieldKey: 'passportNumber' } },
          { code: 'LOW_CONFIDENCE', severity: 'MEDIUM', field: 'expiryDate', message: 'The expiry date could not be read with confidence.' },
        ],
        reviewNote: state.note ?? null,
        applied: state.applied,
      });
      const answer = async (route, status, json) => {
        const real = await route.fetch();
        await route.fulfill({ response: real, status, json });
      };
      await page.route('**/api/v1/tenant', async (route) => {
        const real = await route.fetch();
        await route.fulfill({ response: real, json: { ...(await real.json()), aiEnabled: true } });
      });
      await page.route('**/api/v1/ocr/usage*', async (route) => {
        const real = await route.fetch();
        const json = await real.json();
        await route.fulfill({ response: real, json: { ...json, aiEnabled: true, provider: { name: 'tesseract', configured: true } } });
      });
      await page.route(`**/api/v1/documents/${doc.id}/extractions*`, (route) => answer(route, 200, { data: state.status ? [summary()] : [], meta: { page: 1, pageSize: 50, total: state.status ? 1 : 0, totalPages: 1 } }));
      await page.route(`**/api/v1/documents/${doc.id}/extract`, (route) => {
        state.status = 'QUEUED';
        setTimeout(() => (state.status = 'COMPLETED'), 2500);
        return answer(route, 202, summary());
      });
      await page.route(`**/api/v1/ocr/results/${id}`, (route) => answer(route, 200, result()));
      await page.route(`**/api/v1/ocr/results/${id}/review`, (route) => {
        const body = route.request().postDataJSON();
        state.reviewed = Object.fromEntries(body.fields.map((f) => [f.key, f.value]));
        state.note = body.note ?? null;
        state.status = 'REVIEWED';
        return answer(route, 200, result());
      });
      await page.route(`**/api/v1/ocr/results/${id}/apply`, (route) => {
        state.applied = [...state.applied, { at: new Date().toISOString(), by: null, keys: route.request().postDataJSON().fields }];
        return answer(route, 200, result());
      });

      const suffix = `${await page.evaluate(() => document.documentElement.lang)}-${await page.evaluate(() => (document.documentElement.classList.contains('dark') ? 'dark' : 'light'))}-${page.viewportSize().width < 600 ? 'mobile' : 'desktop'}`;
      await openDetail(page, `/documents/${doc.id}?tab=assistant`, 'main [role="tabpanel"] h2');
      const panel = page.locator('main [role="tabpanel"]');
      await panel.locator('button').last().click(); // "Read document"
      await panel.locator('[role="status"]').first().waitFor(); // queued / reading
      await panel.locator('table tbody tr').first().waitFor({ timeout: 30_000 });
      await snap(page, `people-document-assistant-simulated-1-review-${suffix}`);
      // the reviewer corrects the expiry date and rejects "sex"
      await panel.locator('table tbody tr').nth(4).locator('input').fill('2031-07-14');
      await panel.locator('table tbody tr').nth(5).locator('input').fill('');
      await panel.locator('textarea').fill('Expiry date corrected from the document.');
      await panel.locator('button').last().click(); // "Save my review"
      await panel.locator('table tbody [role="checkbox"]').first().waitFor({ timeout: 30_000 });
      await panel.locator('table tbody [role="checkbox"]').nth(1).click();
      await panel.locator('table tbody [role="checkbox"]').nth(4).click();
      await snap(page, `people-document-assistant-simulated-2-apply-${suffix}`);
      await panel.locator('button').last().click(); // "Apply selected fields"
      await panel.locator('table tbody .bg-success-soft', { hasText: /./ }).first().waitFor({ timeout: 30_000 });
      await page.waitForTimeout(500);
    },
    fullPage: true,
  },
];
