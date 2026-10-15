import {
  Actor,
  anonymous,
  api,
  Centre,
  createService,
  CreatedService,
  Crew,
  downloadDocument,
  expectRefused,
  inviteStaff,
  PASSWORD,
  pdf,
  registerPortalCustomer,
  registerWalkInCustomer,
  runCase,
  runScheduledJob,
  samplePassportNo,
  signUpCentre,
  TestApp,
  uniq,
  uploadDocument,
} from '../support';

/**
 * Scenario 29: deleted or archived customer data is handled according to policy.
 *
 * Four policies are exercised end to end:
 *   1. archive  - the customer leaves daily work, the history stays;
 *   2. erasure  - a deletion request removes the person and keeps the books;
 *   3. retention - documents are deleted when their period ends, unless held;
 *   4. export   - the person receives their own data, nobody else does.
 *
 * "Ageing" a document is the one thing done in the database here (createdAt is
 * moved 40 days back): there is no API to make a file old.
 */
describe('Privacy, archive and retention (scenario 29)', () => {
  let t: TestApp;
  let centre: Centre;
  let crew: Crew;
  let manager: Actor;
  let accountant: Actor;
  let service: CreatedService;
  const id = uniq();
  const DAY = 86_400_000;

  const salesToday = async () => (await api(t, accountant).get('/reports/daily-sales?range=today')).totals;

  beforeAll(async () => {
    t = await TestApp.create();
    centre = await signUpCentre(t, { name: `Privacy Centre ${id}` });
    await api(t, centre.owner).patch('/tenant', { taxRatePercent: 5 });
    service = await createService(t, centre.owner, {
      name: 'Tenancy contract typing',
      price: { serviceFee: '150.00', governmentFeeEstimate: '100.00' },
      requirements: [{ documentTypeKey: 'passport', label: 'Passport copy', isMandatory: true }],
      form: { steps: [{ key: 'details', title: 'Details', fields: [{ key: 'landlord', label: 'Landlord name', type: 'text', required: true }] }] },
    });
    crew = { owner: centre.owner, receptionist: await inviteStaff(t, centre, 'receptionist'), reviewer: await inviteStaff(t, centre, 'reviewer'), operator: await inviteStaff(t, centre, 'operator') };
    manager = await inviteStaff(t, centre, 'manager');
    accountant = await inviteStaff(t, centre, 'accountant');
    await t.settle();
  });
  afterAll(() => t.close());

  it('S29 an archived customer leaves daily work, and the history stays and can be restored', async () => {
    const person = await registerWalkInCustomer(t, crew.receptionist, { fullName: `Archie Walker ${id}` });
    const done = await runCase(t, crew, { serviceId: service.id, branchId: centre.headOfficeId, customerId: person.id, fields: { landlord: 'Sample Properties LLC' } });
    const draft = await runCase(t, crew, { serviceId: service.id, branchId: centre.headOfficeId, customerId: person.id, stopAt: 'DRAFT' });
    const desk = api(t, crew.receptionist);

    // Archiving is not for everybody, and not while work is open.
    expectRefused(await desk.req('POST', `/customers/${person.id}/archive`, { reason: 'Moved abroad' }), 403);
    expectRefused(await api(t, manager).req('POST', `/customers/${person.id}/archive`, { reason: 'Moved abroad' }), 409, 'CUSTOMER_HAS_OPEN_REQUESTS');
    await api(t, manager).post(`/requests/${draft.requestId}/cancel`, { reason: 'Customer left the country' }, [200, 201]);
    const archived = await api(t, manager).post(`/customers/${person.id}/archive`, { reason: 'Moved abroad' }, [200, 201]);
    expect(archived.status).toBe('ARCHIVED');

    // Out of daily work: not in the default list, not editable, no new requests.
    expect((await desk.get(`/customers?q=${encodeURIComponent(person.fullName)}`)).data).toEqual([]);
    expect((await desk.get(`/customers?status=ARCHIVED&q=${encodeURIComponent(person.fullName)}`)).data.map((c: any) => c.id)).toEqual([person.id]);
    expectRefused(await desk.req('PATCH', `/customers/${person.id}`, { fullName: 'Changed While Archived' }), 409, 'CUSTOMER_ARCHIVED');
    expectRefused(await desk.req('POST', '/requests', { serviceId: service.id, customerId: person.id }), 422, 'CUSTOMER_NOT_ACTIVE');

    // The history is intact: the record, the completed case, the paid invoice, the documents.
    expect(await desk.get(`/customers/${person.id}`)).toMatchObject({ status: 'ARCHIVED', fullName: person.fullName, customerNo: person.customerNo });
    expect(await desk.get(`/requests/${done.requestId}`)).toMatchObject({ status: 'COMPLETED', paymentStatus: 'PAID' });
    expect(await desk.get(`/invoices/${done.invoiceId}`)).toMatchObject({ status: 'PAID', total: done.total, customerId: person.id });
    expect((await downloadDocument(t, crew.receptionist, done.result!.documentId)).bytes.equals(done.result!.content)).toBe(true);

    // Restoring brings the customer back to normal.
    const restored = await api(t, manager).post(`/customers/${person.id}/restore`, {}, [200, 201]);
    expect(restored.status).toBe('ACTIVE');
    expect((await desk.get(`/customers?q=${encodeURIComponent(person.fullName)}`)).data.map((c: any) => c.id)).toEqual([person.id]);
    await desk.post('/requests', { serviceId: service.id, customerId: person.id }, 201);
    const audit = await api(t, centre.owner).get(`/audit-logs?resourceType=Customer&resourceId=${person.id}&pageSize=100`);
    expect(audit.data.map((e: any) => e.action)).toEqual(expect.arrayContaining(['customer.created', 'customer.archived', 'customer.restored']));
  });

  it('S29 a deletion request erases the person and keeps the books', async () => {
    const name = `Leila Haddad ${id}`;
    const email = `leila-${id}@example.test`;
    const passportNo = samplePassportNo();
    const customer = await registerPortalCustomer(t, centre, { fullName: name, email });
    const customerId = customer.customerId!;
    await api(t, crew.receptionist).patch(`/customers/${customerId}`, { passportNo, passportCountry: 'LB', nationality: 'LB', dateOfBirth: '1988-02-03', phone: '+971501112233' });
    const paid = await runCase(t, crew, { serviceId: service.id, branchId: centre.headOfficeId, portalCustomer: customer, fields: { landlord: 'Secret Landlord Holdings' } });
    const open = await runCase(t, crew, { serviceId: service.id, branchId: centre.headOfficeId, portalCustomer: customer, fields: { landlord: 'Another Landlord' }, stopAt: 'AWAITING_PAYMENT' });
    await api(t, customer).post(`/requests/${open.requestId}/comments`, { body: 'Please call my husband Karim before you start.' }, [200, 201]);
    const vaultDoc = await uploadDocument(t, customer, { documentTypeKey: 'other', title: `Salary letter of ${name}` }, pdf('salary letter', 'salary-letter.pdf'));
    await t.settle();

    // What the books say before anything is erased.
    const customerNoBefore = (await api(t, crew.receptionist).get(`/customers/${customerId}`)).customerNo;
    const invoiceBefore = await api(t, accountant).get(`/invoices/${paid.invoiceId}`);
    const paymentBefore = await api(t, accountant).get(`/payments/${paid.paymentId}`);
    const salesBefore = await salesToday();
    expect(invoiceBefore).toMatchObject({ status: 'PAID', total: paid.total });

    // --- the customer asks for deletion on the portal
    const filed = await api(t, customer).post('/privacy/my/requests', { type: 'DELETION', details: 'Please delete my data, I am leaving the UAE.' }, 201);
    expect(filed).toMatchObject({ type: 'DELETION', status: 'RECEIVED', customerId });
    expect(new Date(filed.dueAt).getTime()).toBeGreaterThan(Date.now() + 20 * DAY); // a deadline is set
    expectRefused(await api(t, customer).req('POST', '/privacy/my/requests', { type: 'DELETION' }), 409, 'REQUEST_ALREADY_OPEN');
    // Privacy requests are for the privacy officer (the owner), not for the front desk.
    expectRefused(await api(t, crew.receptionist).req('GET', '/privacy/requests'), 403);
    expectRefused(await api(t, manager).req('POST', `/privacy/requests/${filed.id}/complete`, {}), 403);

    // --- the officer sees what an erasure would touch, and why it cannot happen yet
    const officer = api(t, centre.owner);
    const review = await officer.get(`/privacy/requests/${filed.id}`);
    expect(review.erasureImpact).toMatchObject({ openRequests: 1, unpaidInvoices: 1, canProceed: false });
    expectRefused(await officer.req('POST', `/privacy/requests/${filed.id}/complete`, {}), 409, 'NOT_APPROVED'); // not approved yet
    await officer.post(`/privacy/requests/${filed.id}/decision`, { decision: 'APPROVED', decisionNote: 'Identity confirmed by phone. Approved.' }, [200, 201]);
    const blocked = await officer.req('POST', `/privacy/requests/${filed.id}/complete`, {});
    expectRefused(blocked, 409, 'ERASURE_BLOCKED');
    expect(blocked.body.details.blocking.requests.map((r: any) => r.id)).toEqual([open.requestId]);
    expect(blocked.body.details.blocking.invoices.map((i: any) => i.id)).toEqual([open.invoiceId]);
    // A blocked erasure changed nothing, and the customer can read the reason.
    expect(await api(t, crew.receptionist).get(`/customers/${customerId}`)).toMatchObject({ status: 'ACTIVE', fullName: name, email });
    const waiting = await api(t, customer).get(`/privacy/my/requests/${filed.id}`);
    expect(waiting.status).toBe('APPROVED');
    expect(waiting.retentionException).toContain(open.requestNo);

    // --- the obstacles are cleared the normal way: the open case is cancelled, its unpaid invoice voided
    await api(t, manager).post(`/requests/${open.requestId}/cancel`, { reason: 'Customer is leaving the country' }, [200, 201]);
    await api(t, accountant).post(`/invoices/${open.invoiceId}/void`, { reason: 'Request cancelled before payment' }, [200, 201]);
    await t.settle();
    expect((await officer.get(`/privacy/requests/${filed.id}`)).erasureImpact).toMatchObject({ openRequests: 0, unpaidInvoices: 0, canProceed: true });
    const salesBeforeErasure = await salesToday(); // the voided invoice left the day's figures; from here on nothing may move

    // --- the erasure
    const completed = await officer.post(`/privacy/requests/${filed.id}/complete`, {}, [200, 201]);
    expect(completed.status).toBe('COMPLETED');
    expect(completed.retentionException).toBeTruthy(); // says what was kept and why
    await t.settle(10);

    // The person is gone from the customer file: what is left is a stub that says so (the kept invoices and
    // requests still point at it), cannot be changed, and is found neither by search nor in any list ...
    const secrets = [name, 'Leila', 'Haddad', email, passportNo, '501112233', '1988-02-03'];
    for (const who of [crew.receptionist, centre.owner]) {
      const stub = await api(t, who).get(`/customers/${customerId}`);
      expect(stub).toMatchObject({ id: customerId, status: 'ANONYMISED', erased: true, erasedAt: expect.any(String), fullName: 'Erased customer', email: null, phone: null, nationality: null, dateOfBirth: null, hasPassport: false, hasEmiratesId: false });
      for (const secret of secrets) expect(JSON.stringify(stub)).not.toContain(secret);
    }
    for (const q of [name, email]) expect((await api(t, crew.receptionist).get(`/customers?status=ALL&q=${encodeURIComponent(q)}`)).data).toEqual([]);
    expect((await api(t, crew.receptionist).get('/customers?status=ALL&pageSize=100')).data.map((c: any) => c.id)).not.toContain(customerId);
    expect((await api(t, crew.receptionist).get('/customers?status=ANONYMISED&pageSize=100')).data.map((c: any) => c.id)).toContain(customerId);
    const identity = await officer.req('GET', `/customers/${customerId}/identity`);
    expectRefused(identity, 409, 'CUSTOMER_ERASED'); // nothing is left to reveal
    expect(JSON.stringify(identity.body)).not.toContain(passportNo);
    expectRefused(await api(t, manager).req('POST', `/customers/${customerId}/restore`), 409, 'CUSTOMER_ERASED'); // an erased record cannot be brought back
    expectRefused(await api(t, crew.receptionist).req('POST', '/requests', { serviceId: service.id, customerId }), 409, 'CUSTOMER_ERASED');
    expectRefused(await api(t, crew.receptionist).req('POST', '/documents/upload-intents', { customerId, documentTypeKey: 'other', filename: 'x.pdf', mime: 'application/pdf', sizeBytes: 100 }), 409, 'CUSTOMER_ERASED');
    // ... (in the database - the API no longer shows the row: it is kept as an anonymous pseudonym for the books, with nothing personal left)
    const row = await t.sys.customer.findUniqueOrThrow({ where: { id: customerId } });
    expect(row).toMatchObject({ status: 'ANONYMISED', customerNo: customerNoBefore, email: null, phone: null, dateOfBirth: null, nationality: null, passportNoEnc: null, passportNoHash: null, passportNoLast4: null, emiratesIdEnc: null });
    for (const secret of secrets) expect(JSON.stringify(row)).not.toContain(secret);

    // ... from the case (which stays as a business record) ...
    const caseAfter = await api(t, manager).get(`/requests/${paid.requestId}`);
    expect(caseAfter).toMatchObject({ requestNo: paid.requestNo, status: 'COMPLETED', paymentStatus: 'PAID' });
    expect(caseAfter.service.name).toBe('Tenancy contract typing');
    expect(caseAfter.customer).toMatchObject({ id: customerId, customerNo: customerNoBefore, erased: true }); // the pseudonym the kept records point at, marked as erased
    for (const secret of [name, email, 'Secret Landlord Holdings', passportNo]) expect(JSON.stringify(caseAfter)).not.toContain(secret);
    const cancelledAfter = await api(t, manager).get(`/requests/${open.requestId}`);
    expect(cancelledAfter).toMatchObject({ requestNo: open.requestNo, status: 'CANCELLED' });
    expect(cancelledAfter.comments.length).toBeGreaterThanOrEqual(1); // the comment row is kept, its text is not
    for (const secret of [name, email, 'Another Landlord', 'Karim']) expect(JSON.stringify(cancelledAfter)).not.toContain(secret);
    // ... from the vault: the documents are deleted, with no way back ...
    for (const documentId of [vaultDoc.documentId, paid.inputs[0].documentId, paid.result!.documentId]) {
      expectRefused(await api(t, manager).req('POST', `/documents/${documentId}/download-link`, {}), 404);
      expectRefused(await officer.req('POST', `/documents/${documentId}/restore`, {}), 409, 'DOCUMENT_PURGED');
    }
    const deleted = await api(t, manager).get(`/documents?customerId=${customerId}&includeDeleted=true&pageSize=100`);
    expect(deleted.data.every((d: any) => d.status === 'DELETED')).toBe(true);
    expect(JSON.stringify(deleted.data)).not.toContain(name);
    expect(JSON.stringify(deleted.data)).not.toContain('salary-letter');
    // ... from the messages that were sent to them ...
    const messages = await officer.get(`/notifications?customerId=${customerId}&pageSize=100`);
    expect(messages.data.length).toBeGreaterThan(0); // kept as delivery statistics
    expect(JSON.stringify(messages.data)).not.toContain(email);
    expect(JSON.stringify(messages.data)).not.toContain('Leila');
    // ... and from the trails, which are kept but no longer name the person.
    const trail = await officer.get(`/audit-logs?action=privacy.customer_anonymised&pageSize=10`);
    expect(trail.data.length).toBeGreaterThanOrEqual(1);
    const exported = (await officer.download('/audit-logs/export')).body.toString('utf8');
    expect(exported).toContain('customer.created'); // nothing was removed from the trail ...
    for (const secret of [name, email, passportNo, 'Secret Landlord Holdings']) expect(exported).not.toContain(secret); // ... but it no longer names the person
    const about = await officer.get(`/audit-logs?resourceType=Customer&resourceId=${customerId}&pageSize=100`);
    expect(about.data.length).toBeGreaterThanOrEqual(2);
    for (const entry of about.data) {
      const detail = await officer.get(`/audit-logs/${entry.id}`);
      for (const secret of [name, email, passportNo, '501112233']) expect(JSON.stringify(detail)).not.toContain(secret);
    }

    // The books are exactly as they were: same invoice, same payment, same receipt, same report figures.
    const invoiceAfter = await api(t, accountant).get(`/invoices/${paid.invoiceId}`);
    for (const field of ['invoiceNo', 'status', 'total', 'taxTotal', 'subtotalServiceFee', 'subtotalGovernmentFee', 'amountPaid', 'balanceDue', 'issuedAt', 'customerId']) expect(invoiceAfter[field]).toEqual(invoiceBefore[field]);
    expect(invoiceAfter.invoiceItems.map((i: any) => [i.component, i.lineTotal])).toEqual(invoiceBefore.invoiceItems.map((i: any) => [i.component, i.lineTotal]));
    const paymentAfter = await api(t, accountant).get(`/payments/${paid.paymentId}`);
    for (const field of ['paymentNo', 'receiptNo', 'status', 'amount', 'method', 'receivedAt']) expect(paymentAfter[field]).toEqual(paymentBefore[field]);
    const receipt = await api(t, accountant).download(`/payments/${paid.paymentId}/receipt/pdf`);
    expect(receipt.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(await salesToday()).toEqual(salesBeforeErasure);
    expect(salesBeforeErasure.grossCollections).toBe(salesBefore.grossCollections); // cancelling and voiding moved no money either

    // The portal account is closed: the old session is dead and the password no longer works ...
    expectRefused(await api(t, customer).req('GET', '/me/customer'), 401);
    expectRefused(await anonymous(t).req('POST', '/auth/login', { email, password: PASSWORD, app: 'customer', tenantSlug: centre.slug }), 401, 'INVALID_CREDENTIALS');
    // ... (in the database: no password, no address - the one thing an API cannot show)
    const user = await t.sys.user.findUniqueOrThrow({ where: { id: customer.userId } });
    expect(user.passwordHash).toBeNull();
    expect(user.email).not.toBe(email);
    expect(user.fullName).not.toContain('Leila');
    // ... and the address is free: the same person can come back later as a new customer, without the old history.
    const again = await registerPortalCustomer(t, centre, { fullName: name, email });
    expect(again.customerId).not.toBe(customerId);
    expect((await api(t, again).get('/requests')).data).toEqual([]);
    expect((await api(t, again).get('/invoices')).data).toEqual([]);
    expect((await api(t, again).get('/documents')).data).toEqual([]);

    // Completing the same request again changes nothing.
    const repeat = await officer.post(`/privacy/requests/${filed.id}/complete`, {}, [200, 201]);
    expect(repeat.status).toBe('COMPLETED');
    expect((await t.sys.customer.findUniqueOrThrow({ where: { id: customerId } })).status).toBe('ANONYMISED');
  });

  it('S29 documents are deleted when their retention period ends, unless they are on legal hold', async () => {
    const customer = await registerPortalCustomer(t, centre, { fullName: `Retention Case ${id}` });
    const officer = api(t, centre.owner);
    const old = await uploadDocument(t, customer, { documentTypeKey: 'other', title: 'Old supporting letter' }, pdf('old letter', 'old-letter.pdf'));
    const held = await uploadDocument(t, customer, { documentTypeKey: 'other', title: 'Letter under dispute' }, pdf('held letter', 'held-letter.pdf'));
    const recent = await uploadDocument(t, customer, { documentTypeKey: 'other', title: 'Recent letter' }, pdf('recent letter', 'recent-letter.pdf'));
    const oldPassport = await uploadDocument(t, customer, { documentTypeKey: 'passport' }, pdf('old passport copy', 'passport.pdf'));
    // Ageing (database): three of the files were uploaded 40 days ago.
    await t.sys.document.updateMany({ where: { tenantId: centre.id, id: { in: [old.documentId, held.documentId, oldPassport.documentId] } }, data: { createdAt: new Date(Date.now() - 40 * DAY) } });

    // The centre's policy: supporting documents ("other") are kept 30 days; everything else follows the general period.
    const policies: any[] = await officer.get('/privacy/retention-policies');
    const general = policies.find((p) => p.entity === 'DOCUMENT' && !p.documentTypeKey);
    expect(general).toMatchObject({ action: 'DELETE', isActive: true, enforced: true });
    expect(general.retainDays).toBeGreaterThan(365);
    const policy = await officer.post('/privacy/retention-policies', { entity: 'DOCUMENT', documentTypeKey: 'other', retainDays: 30, action: 'DELETE', legalBasisNote: 'Supporting letters are not needed after the case (test policy).' }, 201);
    expect(policy).toMatchObject({ retainDays: 30, enforced: true });
    expectRefused(await officer.req('POST', '/privacy/retention-policies', { entity: 'DOCUMENT', documentTypeKey: 'other', retainDays: 10, action: 'DELETE' }), 409, 'POLICY_EXISTS');
    expectRefused(await api(t, manager).req('POST', '/privacy/retention-policies', { entity: 'DOCUMENT', documentTypeKey: 'photo', retainDays: 10, action: 'DELETE' }), 403);
    // One of the old letters is needed for a dispute: legal hold.
    await officer.put(`/documents/${held.documentId}/legal-hold`, { legalHold: true, reason: 'Dispute with the landlord (test).' });

    // --- the nightly job
    await runScheduledJob(t, 'documents.purge');

    // The old letter is gone for the customer and for staff; its file cannot be brought back.
    expectRefused(await api(t, customer).req('GET', `/documents/${old.documentId}`), 404);
    expectRefused(await api(t, customer).req('POST', `/documents/${old.documentId}/download-link`, {}), 404);
    expectRefused(await api(t, manager).req('POST', `/documents/${old.documentId}/download-link`, {}), 404);
    await runScheduledJob(t, 'documents.purge');
    expectRefused(await officer.req('POST', `/documents/${old.documentId}/restore`, {}), 409, 'DOCUMENT_PURGED');
    // Kept: the held letter (old, but on hold), the recent letter (not old), the passport copy (old, but the general period applies).
    for (const kept of [held, recent, oldPassport]) expect((await downloadDocument(t, customer, kept.documentId)).bytes.equals(kept.content)).toBe(true);
    // The deletion is on the audit trail with its reason, and staff cannot delete a held document by hand either.
    const audit = await officer.get(`/audit-logs?resourceType=Document&resourceId=${old.documentId}&pageSize=100`);
    const entry = audit.data.find((e: any) => /retention/i.test(`${e.action} ${e.summary ?? ''}`));
    expect(entry).toBeTruthy();
    expect(entry.actorType).toBe('SYSTEM'); // nobody clicked: the policy did it
    expectRefused(await officer.req('DELETE', `/documents/${held.documentId}`), 409, 'LEGAL_HOLD');
    const overview = await officer.get('/privacy/overview');
    expect(overview.retention.documentsOnLegalHold).toBeGreaterThanOrEqual(1);

    // --- the dispute ends: the hold is released and the next run applies the policy
    await officer.put(`/documents/${held.documentId}/legal-hold`, { legalHold: false, reason: 'Dispute settled (test).' });
    await runScheduledJob(t, 'documents.purge');
    expectRefused(await api(t, customer).req('GET', `/documents/${held.documentId}`), 404);
    expect((await downloadDocument(t, customer, recent.documentId)).bytes.equals(recent.content)).toBe(true);
    expect((await api(t, customer).get('/documents?pageSize=100')).data.map((d: any) => d.id).sort()).toEqual([recent.documentId, oldPassport.documentId].sort());
  });

  it('S29 an export request gives the person their own data, and only to them', async () => {
    const name = `Export Person ${id}`;
    const customer = await registerPortalCustomer(t, centre, { fullName: name });
    const other = await registerPortalCustomer(t, centre, { fullName: 'Other Person' });
    const done = await runCase(t, crew, { serviceId: service.id, branchId: centre.headOfficeId, portalCustomer: customer, fields: { landlord: 'Export Landlord LLC' } });
    await runCase(t, crew, { serviceId: service.id, branchId: centre.headOfficeId, portalCustomer: other, fields: { landlord: 'Somebody Elses Landlord' }, stopAt: 'SUBMITTED' });

    const filed = await api(t, customer).post('/privacy/my/requests', { type: 'EXPORT' }, 201);
    const officer = api(t, centre.owner);
    await officer.post(`/privacy/requests/${filed.id}/review`, {}, [200, 201]);
    await officer.post(`/privacy/requests/${filed.id}/decision`, { decision: 'APPROVED', decisionNote: 'Identity confirmed at the counter.' }, [200, 201]);
    const completed = await officer.post(`/privacy/requests/${filed.id}/complete`, {}, [200, 201]);
    expect(completed.status).toBe('COMPLETED');
    expect(completed.exportDocumentId).toBeTruthy();
    await t.settle();

    // The customer downloads the file through the normal document link ...
    expect((await api(t, customer).get(`/privacy/my/requests/${filed.id}`)).exportDocumentId).toBe(completed.exportDocumentId);
    const { bytes } = await downloadDocument(t, customer, completed.exportDocumentId);
    const data = JSON.parse(bytes.toString('utf8'));
    const text = JSON.stringify(data);
    // ... it holds their profile, their request with what they submitted, their invoice and payment ...
    for (const expected of [name, customer.email, done.requestNo, 'Export Landlord LLC', done.invoiceNo!, done.total!]) expect(text).toContain(expected);
    // ... and nothing about anybody else or about the centre's internals.
    for (const foreign of ['Other Person', other.email, 'Somebody Elses Landlord']) expect(text).not.toContain(foreign);
    expect(text).not.toMatch(/passwordHash|storageKey/);
    // Nobody else can open the export.
    expectRefused(await api(t, other).req('POST', `/documents/${completed.exportDocumentId}/download-link`, {}), 404);
    expectRefused(await api(t, other).req('GET', `/privacy/my/requests/${filed.id}`), 404);
  });
});
