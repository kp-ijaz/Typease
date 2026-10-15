import { SYSTEM_ROLES } from '@typease/permissions';
import {
  Actor,
  addCompanyEmployee,
  api,
  bodyForRoute,
  call,
  changedTables,
  Company,
  createCompany,
  employeeLogin,
  expectRefused,
  fetchLink,
  fingerprint,
  isIdParam,
  mayPass,
  Method,
  nameParam,
  NO_SUCH_ID,
  paramsOf,
  pdf,
  populate,
  recordIdFor,
  Route,
  routeName,
  routeTable,
  TestApp,
  textOf,
  uploadDocument,
  urlOf,
  World,
} from '../support';

/**
 * The boundaries INSIDE one centre (and, for the portal routes, across centres):
 *
 *   - a customer sees and changes only what hangs off their own customer record;
 *   - a company administrator sees only their own company;
 *   - a company employee sees only their own request, not a colleague's;
 *   - none of them reaches the portal records of another centre.
 *
 * The users are real portal accounts created through the public flows: two
 * customers of centre A who each have requests, documents, a quotation, an
 * invoice and a payment; two companies with an administrator each; two employees
 * of the first company with a login each.
 */
describe('Customer and corporate boundaries (scenario 24, inside a centre)', () => {
  let t: TestApp;
  let a: World;
  let b: World;
  let routes: Route[];
  let rival: Company;
  let rivalEmployee: { id: string; fullName: string; email: string };
  let rivalRequestId: string;
  let rivalInvoiceId: string;
  let rivalDocumentId: string;
  let first: { id: string; fullName: string; email: string };
  let second: { id: string; fullName: string; email: string };
  let firstLogin: Actor;
  let secondLogin: Actor;
  let firstRequestId: string;
  let secondRequestId: string;
  let secondDocumentId: string;
  let companyRequestId: string;

  const idsIn = (body: any): string[] => (Array.isArray(body) ? body : (body?.data ?? [])).map((row: any) => row.id);

  beforeAll(async () => {
    t = await TestApp.create();
    const support = await t.createPlatformAdmin('SUPPORT_AGENT');
    a = await populate(t, 'Alpha', support);
    b = await populate(t, 'Beta', support);
    routes = routeTable(t);
    const owner = api(t, a.centre.owner);
    const accountant = api(t, a.accountant);

    // A second company of centre A, with an employee, a request, a document and an invoice of its own.
    rival = await createCompany(t, a.centre, { companyName: `Rival Contracting ${a.secrets[0]} LLC`, credit: { limit: '3000.00', termsDays: 15 } });
    rivalEmployee = await addCompanyEmployee(t, rival, { fullName: `Rival Worker ${a.secrets[0]}` });
    const rivalRequest = await api(t, rival.admin).post('/requests', { serviceId: a.service.id, corporateEmployeeId: rivalEmployee.id, fields: { purpose: 'Rival company purpose' } }, 201);
    rivalRequestId = rivalRequest.id;
    rivalDocumentId = (await uploadDocument(t, rival.admin, { requestId: rivalRequestId, checklistItemId: rivalRequest.checklist[0].id, documentTypeKey: 'passport' }, pdf('rival passport', 'rival-passport.pdf'))).documentId;
    const rivalCustomerId = (await owner.get(`/corporate-accounts/${rival.id}/employees/${rivalEmployee.id}`)).customerId;
    const draft = await accountant.post('/invoices', { customerId: rivalCustomerId, corporateAccountId: rival.id, branchId: a.ids.branch, items: [{ description: 'Rival company typing', component: 'SERVICE_FEE', quantity: 1, unitAmount: '410.00' }] }, 201);
    await accountant.post(`/invoices/${draft.id}/issue`);
    rivalInvoiceId = draft.id;

    // Two employees of the first company with a login each, and a request each (created by their administrator).
    first = await addCompanyEmployee(t, a.company, { fullName: `First Employee ${a.secrets[0]}` });
    second = await addCompanyEmployee(t, a.company, { fullName: `Second Employee ${a.secrets[0]}` });
    const corp = api(t, a.company.admin);
    firstRequestId = (await corp.post('/requests', { serviceId: a.service.id, corporateEmployeeId: first.id, fields: { purpose: 'First employee purpose' } }, 201)).id;
    const secondRequest = await corp.post('/requests', { serviceId: a.service.id, corporateEmployeeId: second.id, fields: { purpose: 'Second employee purpose' } }, 201);
    secondRequestId = secondRequest.id;
    secondDocumentId = (await uploadDocument(t, a.company.admin, { requestId: secondRequestId, checklistItemId: secondRequest.checklist[0].id, documentTypeKey: 'passport' }, pdf('second passport', 'second-passport.pdf'))).documentId;
    companyRequestId = a.ids.corporateRequest;
    firstLogin = await employeeLogin(t, a.centre, a.company, first);
    secondLogin = await employeeLogin(t, a.centre, a.company, second);
    await t.settle(10);
  }, 300_000);
  afterAll(() => t.close());

  /** One attempt of `actor` on a record that is not theirs: [what, method, path, body?]. */
  type Attempt = [string, Method, string, unknown?];
  async function mustAllBeRefused(actor: Actor, attempts: Attempt[], strangers: string[], accepted: number[] = [404]) {
    const wrong: string[] = [];
    for (const [what, method, path, body] of attempts) {
      const res = await api(t, actor).req(method, path, method === 'GET' || method === 'DELETE' ? undefined : (body ?? {}));
      if (!accepted.includes(res.status)) wrong.push(`${what}: ${method} ${path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')} -> ${res.status} ${res.body?.code ?? ''}`);
      const leak = strangers.find((s) => textOf(res).includes(s));
      if (leak) wrong.push(`${what}: the answer contains "${leak}"`);
    }
    expect(wrong).toEqual([]);
  }

  it('S24 a customer cannot read, download, change or pay anything of another customer of the same centre', async () => {
    const victim = a.customer; // completed and paid request, documents, invoice, payment, ticket, appointment, privacy request
    const attacker = a.neighbour;
    const x = a.ids;
    const victimName = (await api(t, victim).get('/me/customer')).fullName as string;
    const before = await fingerprint(t, a.centre.id);

    // --- by id: every kind of record the portal shows
    const victimNotification = (await api(t, victim).get('/me/notifications')).data[0].id;
    const victimCreditNote = x.creditNote;
    await mustAllBeRefused(
      attacker,
      [
        ['request', 'GET', `/requests/${x.request}`],
        ['request comments', 'GET', `/requests/${x.request}/comments`],
        ['request references', 'GET', `/requests/${x.request}/external-references`],
        ['request change', 'PATCH', `/requests/${x.request}`, { instructions: 'Changed by another customer' }],
        ['request fields', 'PUT', `/requests/${x.request}/fields`, { values: { purpose: 'Changed by another customer' } }],
        ['request comment', 'POST', `/requests/${x.request}/comments`, { body: 'Hello from another customer' }],
        ['request cancel', 'POST', `/requests/${x.request}/cancel`, { reason: 'Cancelled by another customer' }],
        ['request submit', 'POST', `/requests/${x.request}/submit`],
        ['request resubmit', 'POST', `/requests/${x.request}/resubmit`, {}],
        ['request transition', 'POST', `/requests/${x.request}/transition`, { to: 'CANCELLED', reason: 'By another customer' }],
        ['checklist link', 'PUT', `/requests/${x.request}/checklist/${x.checklistItem}/document`, { documentId: x.neighbourVaultDocument }],
        ['checklist unlink', 'DELETE', `/requests/${x.request}/checklist/${x.checklistItem}/document`],
        ['document', 'GET', `/documents/${x.document}`],
        ['document link', 'POST', `/documents/${x.document}/download-link`, {}],
        ['document preview', 'POST', `/documents/${x.document}/preview-link`, {}],
        ['result document link', 'POST', `/documents/${x.resultDocument}/download-link`, {}],
        ['vault document', 'GET', `/documents/${x.vaultDocument}`],
        ['vault document link', 'POST', `/documents/${x.vaultDocument}/download-link`, {}],
        ['upload completion', 'POST', `/documents/${x.document}/versions/${x.documentVersion}/complete`, {}],
        ['quotation', 'GET', `/quotations/${x.quotation}`],
        ['quotation pdf', 'GET', `/quotations/${x.quotation}/pdf`],
        ['quotation approve', 'POST', `/quotations/${x.quotation}/approve`, {}],
        ['quotation reject', 'POST', `/quotations/${x.quotation}/reject`, { reason: 'Rejected by another customer' }],
        ['invoice', 'GET', `/invoices/${x.invoice}`],
        ['invoice pdf', 'GET', `/invoices/${x.invoice}/pdf`],
        ['invoice pay', 'POST', `/invoices/${x.invoice}/pay`, {}],
        ['payment', 'GET', `/payments/${x.payment}`],
        ['receipt', 'GET', `/payments/${x.payment}/receipt/pdf`],
        ['credit note', 'GET', `/credit-notes/${victimCreditNote}`],
        ['credit note pdf', 'GET', `/credit-notes/${victimCreditNote}/pdf`],
        ['ticket', 'GET', `/me/tickets/${x.ticket}`],
        ['ticket reply', 'POST', `/me/tickets/${x.ticket}/messages`, { body: 'A reply from another customer' }],
        ['appointment', 'GET', `/me/appointments/${x.appointment}`],
        ['appointment cancel', 'POST', `/me/appointments/${x.appointment}/cancel`, { reason: 'Cancelled by another customer' }],
        ['appointment move', 'POST', `/me/appointments/${x.appointment}/reschedule`, { startsAt: a.freeSlot() }],
        ['privacy request', 'GET', `/privacy/my/requests/${x.privacyRequest}`],
        ['notification', 'POST', `/me/notifications/${victimNotification}/read`, {}],
      ],
      [victimName, victim.email],
    );

    // --- the other way round, on a request that waits for its customer: nobody else can accept the quotation or add a file
    const openQuotation = await api(t, attacker).get(`/quotations/${x.neighbourQuotation}`);
    expect(openQuotation.status).toBe('SENT');
    await mustAllBeRefused(
      victim,
      [
        ['open quotation', 'GET', `/quotations/${x.neighbourQuotation}`],
        ['open quotation approve', 'POST', `/quotations/${x.neighbourQuotation}/approve`, {}],
        ['open quotation reject', 'POST', `/quotations/${x.neighbourQuotation}/reject`, { reason: 'Rejected by another customer' }],
        ['open request cancel', 'POST', `/requests/${x.neighbourRequest}/cancel`, { reason: 'Cancelled by another customer' }],
        ['open request comment', 'POST', `/requests/${x.neighbourRequest}/comments`, { body: 'Hello from another customer' }],
        ['open request document', 'GET', `/documents/${x.neighbourDocument}`],
      ],
      [],
    );
    expect((await api(t, attacker).get(`/quotations/${x.neighbourQuotation}`)).status).toBe('SENT');

    // --- ids of somebody else inside the customer's own requests (references)
    const me = api(t, attacker);
    // A customer id in the body is not a way to act for somebody else: the request is the caller's own.
    const forMe = await me.post('/requests', { serviceId: x.service, customerId: victim.customerId, fields: { purpose: 'Mine, whatever the body says' } }, 201);
    expect(forMe.customer.id).toBe(attacker.customerId);
    const myLine = forMe.checklist[0].id;
    const upload = (target: Record<string, unknown>) => me.req('POST', '/documents/upload-intents', { documentTypeKey: 'other', filename: 'x.pdf', mime: 'application/pdf', sizeBytes: 400, ...target });
    for (const [what, res] of [
      ['upload to their request', await upload({ requestId: x.request })],
      ['upload to their checklist line', await upload({ requestId: x.request, checklistItemId: x.checklistItem, documentTypeKey: 'passport' })],
      ['upload replacing their document', await upload({ replacesDocumentId: x.vaultDocument })],
      ['link their document to my request', await me.req('PUT', `/requests/${forMe.id}/checklist/${myLine}/document`, { documentId: x.document })],
      ['link their vault document to my request', await me.req('PUT', `/requests/${forMe.id}/checklist/${myLine}/document`, { documentId: x.vaultDocument })],
      ['ticket about their request', await me.req('POST', '/me/tickets', { subject: 'About somebody else', message: 'Hello', requestId: x.request })],
      ['ticket with their document', await me.req('POST', '/me/tickets', { subject: 'With a file of somebody else', message: 'Hello', attachments: [x.vaultDocument] })],
      ['feedback on their request', await me.req('POST', '/me/feedback', { requestId: x.request, rating: 1, comment: 'Not mine' })],
      ['feedback on their ticket', await me.req('POST', '/me/feedback', { ticketId: x.ticket, rating: 1 })],
      ['renewal from their reminder', await me.req('POST', '/requests', { serviceId: x.service, renewalOfScheduleId: x.reminder, fields: { purpose: 'x' } })],
    ] as const) {
      if (process.env.DEBUG_SWEEP) process.stderr.write(`REFS ${res.status} ${res.body?.code} ${what}\n`);
      expect([what, [403, 404, 422].includes(res.status) ? 'refused' : `${res.status} ${res.body?.code ?? ''} ${JSON.stringify(res.body).slice(0, 300)}`]).toEqual([what, 'refused']);
    }
    expect((await me.get(`/requests/${forMe.id}`)).checklist[0].document ?? null).toBeNull();
    // A version id of somebody else's file does not turn a link to my own document into a link to theirs.
    const viaVersion = await me.req('POST', `/documents/${x.neighbourVaultDocument}/download-link`, { versionId: x.documentVersion });
    expect(viaVersion.status).toBe(404);
    const preview = await me.req('POST', `/documents/${x.neighbourVaultDocument}/preview-link`, { versionId: x.documentVersion, documentId: x.document });
    expect(preview.status).toBe(200);
    const served = (await fetchLink(t, preview.body.url)).body as Buffer;
    expect(served.equals(a.case.inputs[0].content)).toBe(false); // not the other customer's passport copy ...
    expect(served.includes(Buffer.from(`${a.secrets[0]} statement`))).toBe(true); // ... but my own bank statement
    // ... and neither is an upload: the file lands in the caller's own vault.
    const ownUpload = await upload({ customerId: victim.customerId });
    if (ownUpload.status === 201) expect((await api(t, a.centre.owner).get(`/documents/${ownUpload.body.documentId}`)).customerId).toBe(attacker.customerId);
    else expect([403, 404]).toContain(ownUpload.status);

    // --- lists: only the caller's own rows, also when a filter names somebody else
    const victimIds = [x.request, x.document, x.resultDocument, x.vaultDocument, x.quotation, x.invoice, x.payment, x.creditNote, x.refund, x.ticket, x.appointment, x.privacyRequest, victim.customerId!];
    for (const path of ['/requests', '/documents', '/quotations', '/invoices', '/payments', '/credit-notes', '/me/tickets', '/me/appointments', '/me/notifications', '/me/reminders', '/privacy/my/requests', '/me/feedback']) {
      for (const query of ['?pageSize=100', `?pageSize=100&customerId=${victim.customerId}`, `?pageSize=100&requestId=${x.request}`, `?pageSize=100&q=${encodeURIComponent(victimName)}`]) {
        const res = await me.req('GET', path + query);
        expect([path + query, [200, 400, 403, 404].includes(res.status)]).toEqual([path + query, true]);
        const text = textOf(res);
        expect([path + query, victimIds.filter((id) => text.includes(id))]).toEqual([path + query, []]);
        expect([path + query, text.includes(victimName) || text.includes(victim.email)]).toEqual([path + query, false]);
      }
    }
    expect(idsIn((await me.req('GET', '/requests?pageSize=100')).body).sort()).toEqual([x.neighbourRequest, forMe.id].sort());
    expect(idsIn((await me.req('GET', '/quotations')).body)).toEqual([x.neighbourQuotation]);
    expect(idsIn((await me.req('GET', '/invoices')).body)).toEqual([]);
    expect((await me.get('/me/customer')).id).toBe(attacker.customerId);

    // --- control: the owner of those records reaches every one of them
    for (const path of [`/requests/${x.request}`, `/documents/${x.document}`, `/quotations/${x.quotation}`, `/invoices/${x.invoice}`, `/payments/${x.payment}`, `/credit-notes/${x.creditNote}`, `/me/tickets/${x.ticket}`, `/me/appointments/${x.appointment}`, `/privacy/my/requests/${x.privacyRequest}`]) {
      expect([path, (await api(t, victim).req('GET', path)).status]).toEqual([path, 200]);
    }
    await api(t, victim).post(`/documents/${x.resultDocument}/download-link`, {});

    // Nothing of the victim changed: the only new rows are the attacker's own request (and what creating it writes).
    await t.settle(10);
    const changed = changedTables(before, await fingerprint(t, a.centre.id)).map((line) => line.split(':')[0]);
    expect((await api(t, a.centre.owner).get(`/requests/${x.request}`)).status).toBe('COMPLETED');
    expect(changed).not.toContain('quotations');
    expect(changed).not.toContain('invoices');
    expect(changed).not.toContain('payments');
    expect(changed).not.toContain('appointments');
    expect(changed).not.toContain('support_tickets');
    expect(changed).not.toContain('support_messages');
  }, 120_000);

  it('S24 a company administrator cannot see or touch another company, nor a private customer of the centre', async () => {
    const corp = api(t, a.company.admin);
    const x = a.ids;
    // What the administrator of the first company legitimately sees: their own company, employees, requests, invoices.
    expect((await corp.get('/corporate/account')).id).toBe(a.company.id);
    const ownEmployees = idsIn(await corp.get('/corporate/employees?pageSize=100'));
    expect(ownEmployees.sort()).toEqual([x.corporateEmployee, first.id, second.id].sort());
    expect(idsIn(await corp.get('/requests?pageSize=100')).sort()).toEqual([companyRequestId, firstRequestId, secondRequestId].sort());
    expect(idsIn(await corp.get('/corporate/invoices?pageSize=100'))).toEqual([x.corporateInvoice]);
    expect((await corp.get('/corporate/invoices/statement')).invoices.map((i: any) => i.id)).toEqual([x.corporateInvoice]);

    const strangers = [rival.companyName, rival.adminEmail, rivalEmployee.fullName, rivalEmployee.email];
    await mustAllBeRefused(
      a.company.admin,
      [
        // the other company
        ['rival employee', 'GET', `/corporate/employees/${rivalEmployee.id}`],
        ['rival employee change', 'PATCH', `/corporate/employees/${rivalEmployee.id}`, { designation: 'Changed by another company' }],
        ['rival employee login', 'POST', `/corporate/employees/${rivalEmployee.id}/login`, {}],
        ['rival employee login removal', 'DELETE', `/corporate/employees/${rivalEmployee.id}/login`],
        ['rival request', 'GET', `/requests/${rivalRequestId}`],
        ['rival request comment', 'POST', `/requests/${rivalRequestId}/comments`, { body: 'Hello from another company' }],
        ['rival request cancel', 'POST', `/requests/${rivalRequestId}/cancel`, { reason: 'Cancelled by another company' }],
        ['rival request submit', 'POST', `/requests/${rivalRequestId}/submit`],
        ['rival document', 'GET', `/documents/${rivalDocumentId}`],
        ['rival document link', 'POST', `/documents/${rivalDocumentId}/download-link`, {}],
        ['rival invoice', 'GET', `/invoices/${rivalInvoiceId}`],
        ['rival invoice pdf', 'GET', `/invoices/${rivalInvoiceId}/pdf`],
        ['rival invoice pay', 'POST', `/invoices/${rivalInvoiceId}/pay`, {}],
        ['request for a rival employee', 'POST', '/requests', { serviceId: x.service, corporateEmployeeId: rivalEmployee.id, fields: { purpose: 'x' } }],
        ['upload to the rival request', 'POST', '/documents/upload-intents', { requestId: rivalRequestId, documentTypeKey: 'other', filename: 'x.pdf', mime: 'application/pdf', sizeBytes: 400 }],
        // private customers of the same centre
        ['private request', 'GET', `/requests/${x.request}`],
        ['private document', 'GET', `/documents/${x.document}`],
        ['private document link', 'POST', `/documents/${x.resultDocument}/download-link`, {}],
        ['private quotation', 'GET', `/quotations/${x.quotation}`],
        ['private quotation approve', 'POST', `/quotations/${x.neighbourQuotation}/approve`, {}],
        ['private invoice', 'GET', `/invoices/${x.invoice}`],
        ['private payment', 'GET', `/payments/${x.payment}`],
        ['request for a private customer', 'POST', '/requests', { serviceId: x.service, customerId: x.customer, fields: { purpose: 'x' } }],
      ],
      strangers,
    );
    // The company id is never a parameter: the staff routes that take one are closed to portal users altogether.
    for (const path of [`/corporate-accounts/${rival.id}`, `/corporate-accounts/${rival.id}/employees`, `/corporate-accounts/${a.company.id}`, `/finance/corporate-accounts/${rival.id}/statement`, '/customers', `/customers/${x.customer}`]) {
      expect([path, (await corp.req('GET', path)).status]).toEqual([path, 403]);
    }
    // Lists and filters: nothing of the rival, nothing of private customers.
    const foreignIds = [rival.id, rivalEmployee.id, rivalRequestId, rivalInvoiceId, rivalDocumentId, x.request, x.invoice, x.document, x.customer];
    for (const path of ['/requests', '/documents', '/quotations', '/invoices', '/payments', '/credit-notes', '/corporate/employees', '/corporate/members', '/corporate/invoices', '/corporate/prices', '/me/reminders', '/me/tickets']) {
      for (const query of ['?pageSize=100', `?pageSize=100&corporateAccountId=${rival.id}`, `?pageSize=100&customerId=${x.customer}`, `?pageSize=100&q=${encodeURIComponent('Rival')}`]) {
        const res = await corp.req('GET', path + query);
        expect([path + query, [200, 400, 403, 404].includes(res.status)]).toEqual([path + query, true]);
        const text = textOf(res);
        expect([path + query, foreignIds.filter((id) => text.includes(id)), strangers.filter((s) => text.includes(s))]).toEqual([path + query, [], []]);
      }
    }
    // The rival's side of the same story, and proof that the rival's records are real.
    const other = api(t, rival.admin);
    expect(idsIn(await other.get('/requests'))).toEqual([rivalRequestId]);
    expect(idsIn(await other.get('/corporate/invoices'))).toEqual([rivalInvoiceId]);
    expect(idsIn(await other.get('/corporate/employees'))).toEqual([rivalEmployee.id]);
    expect((await other.req('GET', `/requests/${firstRequestId}`)).status).toBe(404);
    expect((await other.req('GET', `/invoices/${x.corporateInvoice}`)).status).toBe(404);
    expect((await other.req('GET', `/corporate/employees/${first.id}`)).status).toBe(404);
    expect((await api(t, a.centre.owner).get(`/requests/${rivalRequestId}`)).status).toBe('DRAFT'); // untouched
  }, 120_000);

  it('S24 a company employee sees only their own request - not a colleague\'s, not the company\'s books', async () => {
    const me = api(t, firstLogin);
    expect(firstLogin.roleKey).toBe('corporate_employee');
    expect(idsIn(await me.get('/requests?pageSize=100'))).toEqual([firstRequestId]);
    expect((await me.get(`/requests/${firstRequestId}`)).id).toBe(firstRequestId);

    await mustAllBeRefused(
      firstLogin,
      [
        ['colleague request', 'GET', `/requests/${secondRequestId}`],
        ['colleague request comments', 'GET', `/requests/${secondRequestId}/comments`],
        ['colleague request comment', 'POST', `/requests/${secondRequestId}/comments`, { body: 'Hello from a colleague' }],
        ['colleague request cancel', 'POST', `/requests/${secondRequestId}/cancel`, { reason: 'Cancelled by a colleague' }],
        ['colleague request submit', 'POST', `/requests/${secondRequestId}/submit`],
        ['colleague request fields', 'PUT', `/requests/${secondRequestId}/fields`, { values: { purpose: 'Changed by a colleague' } }],
        ['colleague document', 'GET', `/documents/${secondDocumentId}`],
        ['colleague document link', 'POST', `/documents/${secondDocumentId}/download-link`, {}],
        ['upload to the colleague request', 'POST', '/documents/upload-intents', { requestId: secondRequestId, documentTypeKey: 'other', filename: 'x.pdf', mime: 'application/pdf', sizeBytes: 400 }],
        ['another employee request (created by the centre)', 'GET', `/requests/${companyRequestId}`],
        ['rival company request', 'GET', `/requests/${rivalRequestId}`],
        ['private request', 'GET', `/requests/${a.ids.request}`],
      ],
      [second.fullName, second.email],
    );
    // The company's own administration is not for employees (403: the route is closed to the role, whatever the id).
    for (const [method, path] of [['GET', '/corporate/account'], ['GET', '/corporate/employees'], ['GET', `/corporate/employees/${second.id}`], ['GET', '/corporate/members'], ['GET', '/corporate/prices'], ['GET', '/corporate/invoices'], ['GET', '/corporate/invoices/statement'], ['GET', '/invoices'], ['GET', `/invoices/${a.ids.corporateInvoice}`], ['GET', '/quotations'], ['GET', '/payments'], ['POST', '/corporate/employees']] as const) {
      const res = await me.req(method, path, method === 'POST' ? { fullName: 'Not Allowed' } : undefined);
      expect([`${method} ${path}`, res.status]).toEqual([`${method} ${path}`, 403]);
    }
    // An employee creates requests for themselves only: naming a colleague (by employee id or by customer id) or a
    // stranger is refused outright, and nothing is created for them.
    for (const body of [{ corporateEmployeeId: second.id }, { customerId: a.ids.customer }, { corporateEmployeeId: second.id, customerId: a.ids.customer }]) {
      expectRefused(await me.req('POST', '/requests', { serviceId: a.service.id, ...body, fields: { purpose: 'For somebody else' } }), 403, 'EMPLOYEE_SELF_ONLY');
    }
    const mine = await me.post('/requests', { serviceId: a.service.id, fields: { purpose: 'For myself' } }, 201);
    expect(mine.customer.fullName).toBe(first.fullName);
    // Naming themselves explicitly is the same thing.
    expect((await me.post('/requests', { serviceId: a.service.id, corporateEmployeeId: first.id, fields: { purpose: 'For myself' } }, 201)).customer.fullName).toBe(first.fullName);
    // Lists never contain the colleague.
    for (const path of ['/requests?pageSize=100', '/documents?pageSize=100', `/requests?pageSize=100&q=${encodeURIComponent('Second')}`, `/documents?pageSize=100&requestId=${secondRequestId}`]) {
      const text = textOf(await me.req('GET', path));
      expect([path, [secondRequestId, secondDocumentId, second.fullName].filter((s) => text.includes(s))]).toEqual([path, []]);
    }
    // The colleague's own view, and the administrator's, are as they should be.
    expect(idsIn(await api(t, secondLogin).get('/requests'))).toEqual([secondRequestId]);
    expect((await api(t, secondLogin).req('GET', `/requests/${firstRequestId}`)).status).toBe(404);
    // What an employee starts in the company's portal is a request OF THE COMPANY about them (contract prices, the
    // company pays): the company's administrator sees it like any other company request; a rival company does not.
    expect(idsIn(await api(t, a.company.admin).get('/requests?pageSize=100'))).toEqual(expect.arrayContaining([companyRequestId, firstRequestId, secondRequestId, mine.id]));
    expect((await api(t, a.company.admin).get(`/requests/${mine.id}`))).toMatchObject({ id: mine.id, source: 'CORPORATE', corporateAccount: { id: a.ids.corporateAccount } });
    // The employee follows it without amounts and without a say.
    expect((await me.get(`/requests/${mine.id}`)).finance).toMatchObject({ amountsHidden: true, totals: null });
    expect((await api(t, a.centre.owner).get(`/requests/${secondRequestId}`)).status).toBe('DRAFT');
  }, 120_000);

  it('no field in a request body makes a portal user more than they are (mass assignment)', async () => {
    const x = a.ids;
    const owner = api(t, a.centre.owner);
    const me = api(t, a.neighbour);
    const before = await owner.get(`/customers/${x.neighbour}`);
    const membership = (await me.get('/auth/me')).membership;

    // --- the own profile: only the profile fields are taken
    const patched = await me.req('PATCH', '/me/customer', {
      fullNameAr: 'تجربة',
      id: x.customer, tenantId: b.centre.id, customerNo: 'CUS-000001', status: 'ARCHIVED', type: 'BUSINESS', corporateAccountId: x.corporateAccount,
      email: a.customer.email, emiratesId: '784199012345678', passportNo: 'X9999999', version: 99, createdById: a.centre.owner.userId, marketingOptIn: true, deletedAt: new Date().toISOString(),
    });
    expect(patched.status).toBe(200);
    const after = await owner.get(`/customers/${x.neighbour}`);
    expect(after).toMatchObject({ id: x.neighbour, customerNo: before.customerNo, status: 'ACTIVE', type: 'INDIVIDUAL', email: before.email, fullNameAr: 'تجربة' });
    expect(after.corporateAccountId ?? null).toBeNull();
    expect([after.hasPassport, after.hasEmiratesId]).toEqual([before.hasPassport, before.hasEmiratesId]);

    // --- the own account: no role, no permission, no other identity
    const account = await me.req('PATCH', '/auth/me', {
      fullName: 'Still A Customer', platformRole: 'SUPER_ADMIN', roleKey: 'owner', kind: 'STAFF', permissions: ['refund.approve'], email: a.centre.owner.email, status: 'ACTIVE', emailVerifiedAt: null, mfaEnabled: false, id: a.centre.owner.userId,
    });
    expect(account.status).toBe(200);
    const session = await me.get('/auth/me');
    expect(session.user).toMatchObject({ id: a.neighbour.userId, email: a.neighbour.email, platformRole: null, fullName: 'Still A Customer' });
    expect(session.membership).toMatchObject({ id: membership.id, kind: 'CUSTOMER', roleKey: 'customer', customerId: x.neighbour });
    expect(session.permissions.sort()).toEqual([...SYSTEM_ROLES.customer.permissions].sort());
    expect((await me.req('GET', '/customers')).status).toBe(403);
    expect((await me.req('GET', '/platform/tenants')).status).toBe(403);

    // --- a new request: the price, the status, the branch of staff, the assignee and the payment state are not the customer's to set
    const made = await me.req('POST', '/requests', {
      serviceId: x.service, fields: { purpose: 'Mine' },
      status: 'COMPLETED', paymentStatus: 'PAID', assigneeMembershipId: x.operator, requestNo: 'TE-999999', source: 'WALK_IN', tenantId: b.centre.id, customerId: x.customer, total: '0.00', serviceSnapshot: { name: 'Free' },
    });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ status: 'DRAFT', paymentStatus: 'UNPAID', source: 'ONLINE' });
    expect(made.body.requestNo).not.toBe('TE-999999');
    expect(made.body.customer.id).toBe(x.neighbour);
    const staffView = await owner.get(`/requests/${made.body.id}`);
    expect(staffView.assignee ?? null).toBeNull();
    expect(staffView.service.name).toBe(a.service.name);
    // Fields only staff may set are refused, not silently taken.
    const pushy = await me.req('POST', '/requests', { serviceId: x.service, fields: { purpose: 'Mine' }, priority: 'URGENT' });
    expect([pushy.status, pushy.body.code]).toEqual([403, 'STAFF_ONLY_FIELD']);
    // A comment is always the customer's own, visible one - never an "internal" note, never somebody else's name.
    const comment = await me.req('POST', `/requests/${made.body.id}/comments`, { body: 'From the customer', visibility: 'INTERNAL', authorType: 'STAFF', authorName: 'The Manager', authorId: a.manager.userId });
    expect([200, 201]).toContain(comment.status);
    const stored = ((await owner.get(`/requests/${made.body.id}`)).comments as any[]).find((c) => c.body === 'From the customer');
    expect(stored).toMatchObject({ visibility: 'CUSTOMER', authorKind: 'CUSTOMER', authorName: 'Still A Customer' });

    // --- registering and accepting an invitation: the role comes from the invitation, not from the form
    const email = `climber-${Date.now().toString(36)}@example.test`;
    const registered = await api(t, null).req('POST', '/auth/register', { tenantSlug: a.centre.slug, fullName: 'Social Climber', email, password: 'Correct-Horse-42', acceptTerms: true, roleKey: 'owner', kind: 'STAFF', platformRole: 'SUPER_ADMIN', permissions: ['refund.approve'], emailVerified: true, status: 'ACTIVE' });
    expect(registered.status).toBe(201);
    // (not verified by the body either: signing in still needs the link from the email)
    expect((await api(t, null).req('POST', '/auth/login', { email, password: 'Correct-Horse-42', app: 'customer', tenantSlug: a.centre.slug })).body.accessToken).toBeUndefined();
    await api(t, null).post('/auth/verify-email', { token: registered.body.dev.emailVerificationToken }, 200);
    const climber = await t.login(email, 'Correct-Horse-42', 'customer', a.centre.slug);
    expect(climber.roleKey).toBe('customer');
    expect((await api(t, null).req('POST', '/auth/login', { email, password: 'Correct-Horse-42', app: 'centre' })).status).toBe(403);
    expect((await api(t, null).req('POST', '/auth/login', { email, password: 'Correct-Horse-42', app: 'platform' })).status).toBe(403);
    const invite = await owner.post('/staff/invitations', { email: `modest-${Date.now().toString(36)}@example.test`, fullName: 'Modest Receptionist', roleKey: 'receptionist', allBranches: true }, 201);
    const accepted = await api(t, null).req('POST', '/auth/invitations/accept', { token: invite.dev.invitationToken, password: 'Correct-Horse-42', app: 'centre', roleKey: 'owner', permissions: ['refund.approve'], allBranches: true, platformRole: 'SUPER_ADMIN' });
    expect(accepted.status).toBe(200);
    expect(accepted.body.session.membership.roleKey).toBe('receptionist');
    expect(accepted.body.session.user.platformRole).toBeNull();
    expect(accepted.body.session.permissions).not.toContain('refund.approve');
  });

  it('S24 portal users of centre A reach nothing of centre B (every portal route that takes an id)', async () => {
    const before = await (async () => {
      await t.settle(10);
      return fingerprint(t, b.centre.id);
    })();
    const foreign = [...new Set([...Object.values(b.ids), ...b.secrets])];
    const wrong: string[] = [];
    let calls = 0;
    const users: Array<[string, Actor, 'CUSTOMER' | 'CORPORATE', string]> = [
      ['customer', a.customer, 'CUSTOMER', 'customer'],
      ['company administrator', a.company.admin, 'CORPORATE', 'corporate_admin'],
      ['company employee', firstLogin, 'CORPORATE', 'corporate_employee'],
    ];
    for (const [label, actor, kind, role] of users) {
      const open = routes.filter((r) => r.rule?.type === 'tenant' && paramsOf(r).some(isIdParam) && mayPass(r.rule, { kind, permissions: SYSTEM_ROLES[role].permissions }));
      expect([label, open.length > 10]).toEqual([label, true]);
      for (const r of open) {
        const url = urlOf(r, (param, beforeSegment) => (isIdParam(param) ? (recordIdFor(b.ids, r.path, param, beforeSegment) ?? NO_SUCH_ID) : nameParam(param)));
        const res = await call(t, actor, r, url, bodyForRoute(r, a, b.ids));
        calls += 1;
        if (process.env.DEBUG_SWEEP && res.status !== 404) process.stderr.write(`PORTAL ${res.status} ${res.body?.code} ${label}: ${routeName(r)}\n`);
        // With a valid body the answer is "not found": the record of the other centre does not exist for the caller.
        if (res.status !== 404) wrong.push(`${label}: ${routeName(r)} -> ${res.status} ${res.body?.code ?? ''}`);
        const leak = foreign.find((s) => textOf(res).includes(s));
        if (leak) wrong.push(`${label}: ${routeName(r)} -> the answer contains "${leak}" of centre B`);
      }
      // The lists of their own portal know nothing of centre B.
      for (const path of ['/requests?pageSize=100', '/documents?pageSize=100', '/me/notifications?pageSize=100']) {
        const text = textOf(await api(t, actor).req('GET', path));
        const leak = foreign.find((s) => text.includes(s));
        if (leak) wrong.push(`${label}: GET ${path} contains "${leak}" of centre B`);
      }
    }
    // The portal records of B with valid bodies, as the customer and as the company administrator of A.
    await mustAllBeRefused(a.customer, [
      ['request of B', 'GET', `/requests/${b.ids.request}`],
      ['document link of B', 'POST', `/documents/${b.ids.resultDocument}/download-link`, {}],
      ['quotation of B', 'POST', `/quotations/${b.ids.neighbourQuotation}/approve`, {}],
      ['invoice of B', 'POST', `/invoices/${b.ids.openInvoice}/pay`, {}],
      ['ticket of B', 'POST', `/me/tickets/${b.ids.ticket}/messages`, { body: 'Hello from another centre' }],
      ['appointment of B', 'POST', `/me/appointments/${b.ids.appointment}/cancel`, { reason: 'From another centre' }],
      ['service of B', 'GET', `/catalogue/${b.ids.service}`],
      ['request for a service of B', 'POST', '/requests', { serviceId: b.ids.service, fields: { purpose: 'x' } }],
      ['appointment in a branch of B', 'POST', '/me/appointments', { branchId: b.ids.branch, startsAt: b.freeSlot() }],
    ], foreign);
    await mustAllBeRefused(a.company.admin, [
      ['employee of B', 'GET', `/corporate/employees/${b.ids.corporateEmployee}`],
      ['employee of B change', 'PATCH', `/corporate/employees/${b.ids.corporateEmployee}`, { designation: 'Changed from another centre' }],
      ['employee login of B', 'POST', `/corporate/employees/${b.ids.corporateEmployee}/login`, {}],
      ['request of B', 'GET', `/requests/${b.ids.corporateRequest}`],
      ['invoice of B', 'GET', `/invoices/${b.ids.corporateInvoice}`],
      ['request for an employee of B', 'POST', '/requests', { serviceId: a.ids.service, corporateEmployeeId: b.ids.corporateEmployee, fields: { purpose: 'x' } }],
    ], foreign);
    expect(wrong).toEqual([]);
    expect(calls).toBeGreaterThan(80);
    await t.settle(10);
    expect(changedTables(before, await fingerprint(t, b.centre.id))).toEqual([]);
  }, 300_000);
});
