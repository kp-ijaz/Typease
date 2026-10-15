import {
  Actor,
  aed,
  anonymous,
  api,
  Centre,
  createService,
  CreatedService,
  disguisedExecutable,
  downloadDocument,
  dubaiDay,
  expectRefused,
  fetchLink,
  fils,
  idempotencyKey,
  invitePortalAccess,
  inviteStaff,
  mailTo,
  pathOf,
  pdf,
  percent,
  png,
  registerPortalCustomer,
  SAMPLE_FORM,
  sampleEmiratesId,
  samplePassportNo,
  samplePhone,
  signUpCentre,
  sum,
  TestApp,
  uniq,
  uploadDocument,
  Uploaded,
} from '../support';

/**
 * Scenarios 6-17 and 20: ONE request of ONE customer, from the counter to the
 * downloaded result. Every `it` continues where the previous one stopped, with
 * the same users a centre has: receptionist, reviewer, manager, operator and the
 * customer on the portal. Nothing is written to the database by the test; the
 * state machine, the workflow engine, finance, the vault and the notification
 * module have to carry the case between them.
 */
describe('Request journey (scenarios 6-17 and 20)', () => {
  let t: TestApp;
  let centre: Centre;
  let receptionist: Actor;
  let reviewer: Actor;
  let manager: Actor;
  let operator: Actor;
  let service: CreatedService;

  // The price list of the service; every expected amount below is derived from these four figures.
  const SERVICE_FEE = fils('200.00');
  const GOVERNMENT_FEE = fils('350.00');
  const THIRD_PARTY_FEE = fils('30.00');
  const TAX_RATE = 5;
  const TAX = percent(SERVICE_FEE, TAX_RATE);
  const TOTAL = sum([SERVICE_FEE, TAX, GOVERNMENT_FEE, THIRD_PARTY_FEE]);

  // The case file, filled as the story goes.
  const id = uniq();
  const person = { fullName: `Fatima Rahman ${id}`, email: `fatima-${id}@example.test`, passportNo: samplePassportNo(), emiratesId: sampleEmiratesId() };
  let customerId: string;
  let customer: Actor;
  let stranger: Actor;
  let requestId: string;
  let requestNo: string;
  let trackingCode: string;
  let passport: Uploaded;
  let photo: Uploaded;
  let quotationId: string;
  let invoiceId: string;
  let invoiceNo: string;
  let prepared: Uploaded;

  const view = (actor: Actor) => api(t, actor).get(`/requests/${requestId}`);
  const line = (v: any, typeKey: string, kind = 'INPUT') => (v.checklist as any[]).find((l) => l.documentTypeKey === typeKey && l.kind === kind);

  beforeAll(async () => {
    t = await TestApp.create();
    centre = await signUpCentre(t, { name: `Journey Typing ${id}` });
    await api(t, centre.owner).patch('/tenant', { taxRatePercent: TAX_RATE });
    service = await createService(t, centre.owner, {
      name: 'Family visa application typing',
      categoryKey: 'visa',
      complianceCapability: 'DOCUMENT_PREPARATION_ONLY',
      requiresApproval: true,
      paymentPolicy: 'BEFORE_PROCESSING',
      price: { serviceFee: aed(SERVICE_FEE), governmentFeeEstimate: aed(GOVERNMENT_FEE), thirdPartyFeeEstimate: aed(THIRD_PARTY_FEE) },
      requirements: [
        { documentTypeKey: 'passport', label: 'Passport copy', isMandatory: true },
        { documentTypeKey: 'photo', label: 'Personal photo', isMandatory: true },
      ],
      form: SAMPLE_FORM,
    });
    receptionist = await inviteStaff(t, centre, 'receptionist');
    reviewer = await inviteStaff(t, centre, 'reviewer');
    manager = await inviteStaff(t, centre, 'manager');
    operator = await inviteStaff(t, centre, 'operator');
    stranger = await registerPortalCustomer(t, centre, { fullName: 'Somebody Else' });
    await t.settle();
  });
  afterAll(() => t.close());

  it('S06 staff creates a customer', async () => {
    const desk = api(t, receptionist);
    const created = await desk.post('/customers', { type: 'INDIVIDUAL', fullName: person.fullName, email: person.email, phone: samplePhone(), nationality: 'BD', dateOfBirth: '1990-04-12', passportNo: person.passportNo, passportCountry: 'BD', passportExpiry: '2031-01-01', emiratesId: person.emiratesId }, 201);
    customerId = created.id;
    expect(created).toMatchObject({ fullName: person.fullName, status: 'ACTIVE', type: 'INDIVIDUAL', tenantId: centre.id, hasPassport: true, hasEmiratesId: true });
    expect(created.customerNo).toMatch(/^CUS-\d+$/);

    // Identity numbers are stored, but never returned in full to someone without the special permission.
    const body = JSON.stringify(created);
    expect(body).not.toContain(person.passportNo);
    expect(body).not.toContain(person.emiratesId);
    expect(created.passportNoMasked).toContain(person.passportNo.slice(-4));
    expectRefused(await desk.req('GET', `/customers/${customerId}/identity`), 403);
    const revealed = await api(t, centre.owner).get(`/customers/${customerId}/identity`);
    expect(JSON.stringify(revealed)).toContain(person.passportNo);

    // The record is found by name and number, and the same person is not registered twice by accident.
    const byName = await desk.get(`/customers?q=${encodeURIComponent(person.fullName)}`);
    expect(byName.data.map((c: any) => c.id)).toEqual([customerId]);
    const duplicate = await desk.req('POST', '/customers', { type: 'INDIVIDUAL', fullName: person.fullName, email: person.email });
    expectRefused(duplicate, 409, 'POSSIBLE_DUPLICATE');
    expect((await desk.get(`/customers?q=${encodeURIComponent(person.fullName)}`)).meta.total).toBe(1);

    // Who registered the customer is on the audit trail (without the identity numbers).
    const audit = await api(t, centre.owner).get('/audit-logs?pageSize=100');
    const entry = audit.data.find((e: any) => e.action === 'customer.created' && e.resourceId === customerId);
    expect(entry).toBeTruthy();
    expect(JSON.stringify(entry)).not.toContain(person.passportNo);

    // The customer gets portal access by invitation and sees their own profile there.
    customer = await invitePortalAccess(t, receptionist, centre, { id: customerId, email: person.email });
    expect(customer.customerId).toBe(customerId);
    const mine = await api(t, customer).get('/me/customer');
    expect(mine).toMatchObject({ id: customerId, fullName: person.fullName });
    expect(JSON.stringify(mine)).not.toContain(person.passportNo);
  });

  it('S07 customer submits a service request', async () => {
    const portal = api(t, customer);
    // The customer finds the service in the portal catalogue, with the fee estimate of the price list.
    const catalogue = await portal.get('/catalogue');
    const offered = catalogue.services.find((s: any) => s.id === service.id);
    expect(offered).toBeTruthy();
    expect(offered.price).toMatchObject({ serviceFee: aed(SERVICE_FEE), governmentFeeEstimate: aed(GOVERNMENT_FEE), thirdPartyFeeEstimate: aed(THIRD_PARTY_FEE), taxAmount: aed(TAX), total: aed(TOTAL) });

    const draft = await portal.post('/requests', { serviceId: service.id, fields: { purpose: 'work' }, instructions: 'Please call before submitting.' }, 201);
    requestId = draft.id;
    requestNo = draft.requestNo;
    expect(draft).toMatchObject({ status: 'DRAFT', source: 'ONLINE' });
    expect(draft.customer.id).toBe(customerId);
    // The checklist comes from the service, the form is the published one, and the name is prefilled from the profile.
    expect((draft.checklist as any[]).map((l) => [l.documentTypeKey, l.kind, l.isMandatory, l.status])).toEqual([
      ['passport', 'INPUT', true, 'MISSING'],
      ['photo', 'INPUT', true, 'MISSING'],
    ]);
    expect(draft.form.values).toMatchObject({ fullName: person.fullName, purpose: 'work' });

    // The server validates the form: "sponsor" is required because the purpose is "work".
    const invalid = await portal.req('POST', `/requests/${requestId}/submit`);
    expectRefused(invalid, 422, 'FORM_INVALID');
    expect(JSON.stringify(invalid.body.details)).toContain('sponsor');
    expect((await view(customer)).status).toBe('DRAFT');
    // A draft is not visible to public tracking and has no tracking code.
    await portal.put(`/requests/${requestId}/fields`, { values: { sponsor: 'Sample Trading LLC' } });

    const submitted = await portal.post(`/requests/${requestId}/submit`, {}, 200);
    trackingCode = submitted.trackingCode;
    expect(trackingCode).toBeTruthy();
    expect(submitted.status).toBe('SUBMITTED');
    expect(submitted.submittedAt).toBeTruthy();
    await t.settle();

    // Staff see the new request at the counter; the customer cannot be given staff-only fields.
    const staffView = await view(receptionist);
    expect(staffView).toMatchObject({ requestNo, status: 'SUBMITTED', paymentStatus: 'UNPAID' });
    expect(staffView.targetDate).toBeTruthy();
    const list = await api(t, receptionist).get(`/requests?q=${requestNo}`);
    expect(list.data.map((r: any) => r.id)).toEqual([requestId]);
    const counts = await api(t, receptionist).get('/requests/counts');
    expect(counts.byStatus.SUBMITTED).toBeGreaterThanOrEqual(1);
    expectRefused(await portal.req('PATCH', `/requests/${requestId}`, { priority: 'URGENT' }), 403, 'STAFF_ONLY_FIELD');

    // Anyone holding the tracking code can follow the status - and nothing else; a wrong code reveals nothing.
    const tracked = await anonymous(t).post('/public/track', { tenantSlug: centre.slug, requestNo, trackingCode }, [200, 201]);
    expect(tracked).toMatchObject({ requestNo, status: 'SUBMITTED' });
    expect(JSON.stringify(tracked)).not.toContain(person.fullName);
    expectRefused(await anonymous(t).req('POST', '/public/track', { tenantSlug: centre.slug, requestNo, trackingCode: 'AAAAA-BBBBB' }), 404);

    // Another customer of the same centre cannot see the request.
    expectRefused(await api(t, stranger).req('GET', `/requests/${requestId}`), 404);
  });

  it('S08 customer uploads documents', async () => {
    const before = await view(customer);
    const passportLine = line(before, 'passport');
    const photoLine = line(before, 'photo');

    // A file that is not what it claims to be is refused and nothing is attached.
    const fake = disguisedExecutable();
    const intent = await api(t, customer).post('/documents/upload-intents', { requestId, checklistItemId: passportLine.id, documentTypeKey: 'passport', filename: fake.filename, mime: fake.mime, sizeBytes: fake.content.length }, 201);
    let put = t.http.put(pathOf(intent.upload.url));
    for (const [k, v] of Object.entries(intent.upload.headers ?? {})) put = put.set(k, v as string);
    await put.send(fake.content);
    const refused = await api(t, customer).req('POST', `/documents/${intent.documentId}/versions/${intent.versionId}/complete`);
    expectRefused(refused, 422, ['FILE_TYPE_NOT_ALLOWED', 'FILE_TYPE_MISMATCH']);
    expect(line(await view(customer), 'passport').status).toBe('MISSING');

    // The signed URL takes exactly what was announced: a larger file or another content type is turned away at the door.
    const announced = await api(t, customer).post('/documents/upload-intents', { requestId, checklistItemId: passportLine.id, documentTypeKey: 'passport', filename: 'passport.pdf', mime: 'application/pdf', sizeBytes: 500 }, 201);
    const tooBig = await t.http.put(pathOf(announced.upload.url)).set('Content-Type', 'application/pdf').send(pdf('too big', 'passport.pdf', 50_000).content);
    expectRefused(tooBig, 413, 'PAYLOAD_TOO_LARGE');
    const otherType = await t.http.put(pathOf(announced.upload.url)).set('Content-Type', 'text/html').send(Buffer.from('<html></html>'));
    expectRefused(otherType, 415, 'UPLOAD_TYPE_MISMATCH');
    expectRefused(await api(t, customer).req('POST', `/documents/${announced.documentId}/versions/${announced.versionId}/complete`), 409, 'UPLOAD_NOT_FOUND');
    expectRefused(await api(t, stranger).req('POST', `/documents/${announced.documentId}/versions/${announced.versionId}/complete`), 404);
    expect(line(await view(customer), 'passport').status).toBe('MISSING');

    // The real uploads: intent -> PUT to the signed URL -> complete.
    passport = await uploadDocument(t, customer, { requestId, checklistItemId: passportLine.id, documentTypeKey: 'passport', expiryDate: '2031-01-01' }, pdf('passport copy', 'passport.pdf'));
    photo = await uploadDocument(t, customer, { requestId, checklistItemId: photoLine.id, documentTypeKey: 'photo' }, png('photo.png'));

    // The upload URL was a one-time capability: sending the very same bytes to it again is refused.
    const replay = await t.http.put(pathOf(passport.uploadUrl)).set('Content-Type', 'application/pdf').send(passport.content);
    expectRefused(replay, 403, 'LINK_EXPIRED');

    // The checklist follows the uploads, and with every mandatory document present the case moves to review.
    const after = await view(customer);
    expect(line(after, 'passport')).toMatchObject({ status: 'UPLOADED', document: { id: passport.documentId } });
    expect(line(after, 'photo')).toMatchObject({ status: 'UPLOADED', document: { id: photo.documentId } });
    expect(after.status).toBe('UNDER_REVIEW');

    // The customer finds the files in their vault and gets back exactly what they uploaded.
    const mine = await api(t, customer).get(`/documents?requestId=${requestId}`);
    expect(mine.data.map((d: any) => d.id).sort()).toEqual([passport.documentId, photo.documentId].sort());
    const again = await downloadDocument(t, customer, passport.documentId);
    expect(again.bytes.equals(passport.content)).toBe(true);
    // Neither the document nor its file is reachable for another customer of the centre.
    expectRefused(await api(t, stranger).req('GET', `/documents/${passport.documentId}`), 404);
    expectRefused(await api(t, stranger).req('POST', `/documents/${passport.documentId}/download-link`, {}), 404);
    // Verifying a document is never the customer's own decision.
    expectRefused(await api(t, customer).req('POST', `/documents/${passport.documentId}/verify`, { decision: 'APPROVED' }), 403);
  });

  it('S09 reviewer verifies documents', async () => {
    const r = api(t, reviewer);
    // Verifying is the reviewer's decision: the receptionist may not.
    expectRefused(await api(t, receptionist).req('POST', `/documents/${photo.documentId}/verify`, { decision: 'APPROVED' }), 403);

    // The passport is fine; the reviewer confirms the expiry date against the document.
    const ok = await r.post(`/documents/${passport.documentId}/verify`, { decision: 'APPROVED', expiryDate: '2031-01-01' });
    expect(ok).toMatchObject({ verificationStatus: 'VERIFIED', expiryVerified: true });
    // The photo is not: a rejection needs a reason, and the customer is asked to replace it.
    expectRefused(await r.req('POST', `/documents/${photo.documentId}/verify`, { decision: 'REJECTED' }), 400, 'VALIDATION_FAILED');
    await r.post(`/documents/${photo.documentId}/verify`, { decision: 'REJECTED', reason: 'The background must be white.' });
    await t.settle();

    const waiting = await view(customer);
    expect(waiting.status).toBe('AWAITING_CUSTOMER');
    expect(line(waiting, 'passport').status).toBe('VERIFIED');
    expect(line(waiting, 'photo')).toMatchObject({ status: 'REJECTED', actionRequired: true });
    expect(line(waiting, 'photo').note).toContain('white');
    // Nothing can be released while a document is rejected.
    expectRefused(await api(t, customer).req('POST', `/requests/${requestId}/resubmit`, {}), 422, 'REJECTED_DOCUMENTS_PENDING');

    // The customer uploads a new photo (a new version of the same document) and sends the case back.
    const replacement = await uploadDocument(t, customer, { requestId, checklistItemId: line(waiting, 'photo').id, documentTypeKey: 'photo', replacesDocumentId: photo.documentId }, png('photo-white.png'));
    expect(replacement.documentId).toBe(photo.documentId);
    photo = replacement;
    await api(t, customer).post(`/requests/${requestId}/resubmit`, { note: 'New photo uploaded.' }, [200, 201]);
    await t.settle();
    expect((await view(customer)).status).toBe('UNDER_REVIEW');

    // Second look: approved. Every mandatory document is verified now.
    await r.post(`/documents/${photo.documentId}/verify`, { decision: 'APPROVED' });
    await t.settle();
    const verified = await view(reviewer);
    expect((verified.checklist as any[]).filter((l) => l.kind === 'INPUT').map((l) => l.status)).toEqual(['VERIFIED', 'VERIFIED']);
    expect(verified.status).toBe('UNDER_REVIEW'); // waits for the quotation, not for documents any more
    // The older, rejected file is kept as history: the document has two versions.
    const doc = await r.get(`/documents/${photo.documentId}`);
    expect(doc.versions).toHaveLength(2);
    expect(doc.verificationStatus).toBe('VERIFIED');
  });

  it('S10 quotation is generated', async () => {
    const desk = api(t, receptionist);
    const quotation = await desk.post(`/quotations/from-request/${requestId}`, {}, 201);
    quotationId = quotation.id;
    // Built from the price list of the service: three separate components, tax on the service fee only.
    expect(quotation).toMatchObject({
      status: 'DRAFT',
      currency: 'AED',
      subtotalServiceFee: aed(SERVICE_FEE),
      subtotalGovernmentFee: aed(GOVERNMENT_FEE),
      subtotalThirdParty: aed(THIRD_PARTY_FEE),
      discountTotal: '0.00',
      taxTotal: aed(TAX),
      total: aed(TOTAL),
    });
    expect(quotation.quotationNo).toMatch(/^QUO-\d{6}$/);
    const byComponent = Object.fromEntries((quotation.quotationItems as any[]).map((i) => [i.component, [i.unitAmount, i.taxAmount, i.lineTotal]]));
    expect(byComponent).toEqual({
      SERVICE_FEE: [aed(SERVICE_FEE), aed(TAX), aed(SERVICE_FEE + TAX)],
      GOVERNMENT_FEE: [aed(GOVERNMENT_FEE), '0.00', aed(GOVERNMENT_FEE)],
      THIRD_PARTY_FEE: [aed(THIRD_PARTY_FEE), '0.00', aed(THIRD_PARTY_FEE)],
    });
    // A draft is the centre's business: the customer does not see it yet.
    expect((await api(t, customer).get('/quotations')).data.map((q: any) => q.id)).not.toContain(quotationId);

    const sent = await desk.post(`/quotations/${quotationId}/send`);
    expect(sent.status).toBe('SENT');
    await t.settle();
    expect((await view(receptionist)).status).toBe('QUOTED');

    // Now the customer has it: in the list, in the request, and as a PDF.
    const mine = await api(t, customer).get('/quotations');
    expect(mine.data.find((q: any) => q.id === quotationId)).toMatchObject({ status: 'SENT', total: aed(TOTAL) });
    const cv = await view(customer);
    expect(cv.status).toBe('QUOTED');
    expect(cv.finance.quotation).toMatchObject({ id: quotationId, status: 'SENT', total: aed(TOTAL) });
    const file = await api(t, customer).download(`/quotations/${quotationId}/pdf`);
    expect(file.headers['content-type']).toContain('application/pdf');
    expect(file.body.subarray(0, 5).toString()).toBe('%PDF-');
    expectRefused(await api(t, stranger).req('GET', `/quotations/${quotationId}`), 404);
    // Reviewers do not prepare quotations.
    expectRefused(await api(t, reviewer).req('POST', `/quotations/from-request/${requestId}`, {}), 403);
  });

  it('S11 customer approves quotation', async () => {
    // Only the customer the quotation belongs to can accept it.
    expectRefused(await api(t, stranger).req('POST', `/quotations/${quotationId}/approve`, {}), 404);

    const approved = await api(t, customer).post(`/quotations/${quotationId}/approve`, {}, [200, 201]);
    expect(approved.quotation.status).toBe('APPROVED');
    expect(approved.invoice).toMatchObject({ total: aed(TOTAL), balanceDue: aed(TOTAL), currency: 'AED' });
    invoiceId = approved.invoice.id;
    invoiceNo = approved.invoice.invoiceNo;
    await t.settle();

    // The service is "payment before processing": the case now waits for the money.
    const v = await view(customer);
    expect(v.status).toBe('AWAITING_PAYMENT');
    expect(v.finance.quotation.status).toBe('APPROVED');
    // A decision is final.
    expectRefused(await api(t, customer).req('POST', `/quotations/${quotationId}/approve`, {}), 409);
    expectRefused(await api(t, customer).req('POST', `/quotations/${quotationId}/reject`, { reason: 'Changed my mind' }), 409);
    // Staff cannot push the case past the payment by hand.
    const skip = await api(t, receptionist).req('POST', `/requests/${requestId}/transition`, { to: 'READY_FOR_PROCESSING' });
    expectRefused(skip, 403, 'TRANSITION_NOT_ALLOWED');
    expect((await view(receptionist)).status).toBe('AWAITING_PAYMENT');
  });

  it('S20 invoice is generated', async () => {
    // Approving the quotation issued the invoice: numbered, dated, with the lines and totals of the quotation.
    const invoice = await api(t, receptionist).get(`/invoices/${invoiceId}`);
    expect(invoice.invoiceNo).toBe(invoiceNo);
    expect(invoiceNo).toMatch(/^INV-\d{6}$/);
    expect(invoice).toMatchObject({
      status: 'ISSUED',
      customerId,
      requestId,
      currency: 'AED',
      subtotalServiceFee: aed(SERVICE_FEE),
      subtotalGovernmentFee: aed(GOVERNMENT_FEE),
      subtotalThirdParty: aed(THIRD_PARTY_FEE),
      taxTotal: aed(TAX),
      total: aed(TOTAL),
      amountPaid: '0.00',
      balanceDue: aed(TOTAL),
    });
    expect(invoice.issuedAt).toBeTruthy();
    // Due on receipt (the centre has no payment terms): payable until the END of the day of issue on the centre's
    // calendar - 23:59:59.999 in Dubai, which is 19:59:59.999 UTC - and therefore not overdue the moment it exists.
    expect(invoice.dueAt).toBe(`${dubaiDay(0, new Date(invoice.issuedAt))}T19:59:59.999Z`);
    expect(invoice.overdue).toBe(false);
    expect((await api(t, receptionist).get(`/invoices?overdue=true&requestId=${requestId}`)).data).toEqual([]);
    const lines = (invoice.invoiceItems as any[]).map((i) => [i.component, i.lineTotal]).sort();
    expect(lines).toEqual([
      ['GOVERNMENT_FEE', aed(GOVERNMENT_FEE)],
      ['SERVICE_FEE', aed(SERVICE_FEE + TAX)],
      ['THIRD_PARTY_FEE', aed(THIRD_PARTY_FEE)],
    ]);
    expect(aed(sum((invoice.invoiceItems as any[]).map((i) => fils(i.lineTotal))))).toBe(invoice.total);

    // It is the first invoice of this centre and there is exactly one for the request.
    const all = await api(t, receptionist).get(`/invoices?requestId=${requestId}`);
    expect(all.data.map((i: any) => i.invoiceNo)).toEqual([invoiceNo]);
    expect((await view(receptionist)).finance.invoices.map((i: any) => i.id)).toEqual([invoiceId]);

    // The customer sees it and can print it; an issued invoice can no longer be edited.
    const mine = await api(t, customer).get('/invoices');
    expect(mine.data.find((i: any) => i.id === invoiceId)).toMatchObject({ invoiceNo, status: 'ISSUED', balanceDue: aed(TOTAL) });
    const file = await api(t, customer).download(`/invoices/${invoiceId}/pdf`);
    expect(file.body.subarray(0, 5).toString()).toBe('%PDF-');
    expectRefused(await api(t, stranger).req('GET', `/invoices/${invoiceId}`), 404);
    const accountant = await inviteStaff(t, centre, 'accountant');
    expectRefused(await api(t, accountant).req('PATCH', `/invoices/${invoiceId}`, { notes: 'Changed after issue' }), 409, ['INVOICE_ISSUED', 'IMMUTABLE_RECORD']);
    expect((await api(t, receptionist).get(`/invoices/${invoiceId}`)).total).toBe(aed(TOTAL));

    // What the accountant is still working on is not the customer's business: a draft invoice does not exist for
    // the customer - not in the list, not by id, not as a PDF, not payable - and neither does one that was
    // voided before it was ever issued.
    const draft = await api(t, accountant).post('/invoices', { customerId, branchId: centre.headOfficeId, items: [{ description: 'Extra copies (still being prepared)', component: 'SERVICE_FEE', quantity: 1, unitAmount: '45.00' }] }, 201);
    expect(draft.status).toBe('DRAFT');
    const hiddenFromCustomer = async () => {
      expect((await api(t, customer).get('/invoices?pageSize=100')).data.map((i: any) => i.id)).toEqual([invoiceId]);
      expectRefused(await api(t, customer).req('GET', `/invoices/${draft.id}`), 404);
      expectRefused(await api(t, customer).req('GET', `/invoices/${draft.id}/pdf`), 404);
      expectRefused(await api(t, customer).req('POST', `/invoices/${draft.id}/pay`, {}), 404);
    };
    await hiddenFromCustomer();
    await api(t, accountant).post(`/invoices/${draft.id}/void`, { reason: 'Not needed after all' }, [200, 201]);
    await hiddenFromCustomer();
    expect((await api(t, accountant).get(`/invoices/${draft.id}`)).status).toBe('VOID'); // staff keep the record
    expect((await view(receptionist)).finance.totals.invoiced).toBe(aed(TOTAL)); // and it never counted
  });

  it('S12 payment is recorded', async () => {
    const desk = api(t, receptionist);
    const deposit = fils('200.00');
    const rest = TOTAL - deposit;

    // A payment needs an idempotency key, and can never exceed what is due.
    expectRefused(await desk.req('POST', '/payments', { method: 'CASH', amount: aed(deposit), branchId: centre.headOfficeId, allocations: [{ invoiceId, amount: aed(deposit) }] }), 400, 'IDEMPOTENCY_KEY_REQUIRED');
    const tooMuch = aed(TOTAL + 100n);
    expectRefused(await desk.with({ 'Idempotency-Key': idempotencyKey() }).req('POST', '/payments', { method: 'CASH', amount: tooMuch, branchId: centre.headOfficeId, allocations: [{ invoiceId, amount: tooMuch }] }), 422, 'OVERPAYMENT');

    // First instalment in cash: a receipt is issued, the invoice is part paid, the case keeps waiting.
    const key = idempotencyKey();
    const body = { method: 'CASH', amount: aed(deposit), branchId: centre.headOfficeId, customerId, allocations: [{ invoiceId, amount: aed(deposit) }] };
    const first = await desk.with({ 'Idempotency-Key': key }).post('/payments', body, 201);
    expect(first).toMatchObject({ status: 'COMPLETED', method: 'CASH', amount: aed(deposit), unallocatedAmount: '0.00' });
    expect(first.paymentNo).toMatch(/^PAY-\d{6}$/);
    expect(first.receiptNo).toMatch(/^RCT-\d{6}$/);
    await t.settle();
    expect(await api(t, receptionist).get(`/invoices/${invoiceId}`)).toMatchObject({ status: 'PARTIALLY_PAID', amountPaid: aed(deposit), balanceDue: aed(rest) });
    expect(await view(receptionist)).toMatchObject({ status: 'AWAITING_PAYMENT', paymentStatus: 'PARTIALLY_PAID' });

    // The cashier's double click (same key, same body) returns the same payment and books nothing twice.
    const replay = await desk.with({ 'Idempotency-Key': key }).req('POST', '/payments', body);
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(first.id);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect((await api(t, receptionist).get(`/invoices/${invoiceId}`)).amountPaid).toBe(aed(deposit));

    // The balance by card at the counter: invoice paid, case released for processing.
    const second = await desk.with({ 'Idempotency-Key': idempotencyKey() }).post('/payments', { method: 'CARD_POS', amount: aed(rest), reference: 'POS slip 000123', branchId: centre.headOfficeId, customerId, allocations: [{ invoiceId, amount: aed(rest) }] }, 201);
    await t.settle();
    const invoice = await api(t, receptionist).get(`/invoices/${invoiceId}`);
    expect(invoice).toMatchObject({ status: 'PAID', amountPaid: aed(TOTAL), balanceDue: '0.00' });
    const v = await view(receptionist);
    expect(v).toMatchObject({ status: 'READY_FOR_PROCESSING', paymentStatus: 'PAID' });
    expect(v.finance.totals).toMatchObject({ invoiced: aed(TOTAL), paid: aed(TOTAL), balance: '0.00' });

    // Exactly two payments exist for the invoice, and they add up to its total.
    const payments = await api(t, receptionist).get(`/payments?invoiceId=${invoiceId}`);
    expect(payments.data.map((p: any) => p.id).sort()).toEqual([first.id, second.id].sort());
    expect(aed(sum(payments.data.map((p: any) => fils(p.amount))))).toBe(aed(TOTAL));
    // A paid invoice takes no more money.
    expectRefused(await desk.with({ 'Idempotency-Key': idempotencyKey() }).req('POST', '/payments', { method: 'CASH', amount: '1.00', branchId: centre.headOfficeId, allocations: [{ invoiceId, amount: '1.00' }] }), 409, 'INVOICE_NOT_PAYABLE');

    // The customer has the receipt.
    const mine = await api(t, customer).get('/payments');
    expect(mine.data.map((p: any) => p.id).sort()).toEqual([first.id, second.id].sort());
    const receipt = await api(t, customer).download(`/payments/${first.id}/receipt/pdf`);
    expect(receipt.body.subarray(0, 5).toString()).toBe('%PDF-');
    // Reviewers do not take money.
    expectRefused(await api(t, reviewer).with({ 'Idempotency-Key': idempotencyKey() }).req('POST', '/payments', body), 403);
  });

  it('S13 request is assigned', async () => {
    const m = api(t, manager);
    // An operator only sees the cases assigned to them: before the assignment this one does not exist for them.
    expectRefused(await api(t, operator).req('GET', `/requests/${requestId}`), 404);
    // Work cannot start without an operator.
    expectRefused(await m.req('POST', `/requests/${requestId}/transition`, { to: 'IN_PREPARATION' }), 422, 'OPERATOR_REQUIRED');
    // A receptionist cannot process, so cannot be the operator; assigning is the manager's job.
    expectRefused(await m.req('POST', `/requests/${requestId}/assign`, { assigneeMembershipId: receptionist.membershipId, role: 'OPERATOR' }), 422, 'ASSIGNEE_ROLE_NOT_SUITABLE');
    expectRefused(await api(t, receptionist).req('POST', `/requests/${requestId}/assign`, { assigneeMembershipId: operator.membershipId, role: 'OPERATOR' }), 403);

    const assigned = await m.post(`/requests/${requestId}/assign`, { assigneeMembershipId: operator.membershipId, role: 'OPERATOR' }, [200, 201]);
    expect(assigned.assignee.membershipId).toBe(operator.membershipId);

    // Segregation of duties: one person cannot be operator and reviewer of the same case. The manager's role
    // would allow either job, so the manager is the one to try it with.
    const asReviewer = await m.post(`/requests/${requestId}/assign`, { assigneeMembershipId: manager.membershipId, role: 'REVIEWER' }, [200, 201]);
    expect(asReviewer.reviewer.membershipId).toBe(manager.membershipId);
    expectRefused(await m.req('POST', `/requests/${requestId}/assign`, { assigneeMembershipId: manager.membershipId, role: 'OPERATOR', reason: 'Trying to hold both roles' }), 409, 'SEGREGATION_OF_DUTIES');
    expect((await view(manager)).assignee.membershipId).toBe(operator.membershipId);
    // Replacing somebody needs a reason; with one, the dedicated reviewer takes over.
    expectRefused(await m.req('POST', `/requests/${requestId}/assign`, { assigneeMembershipId: reviewer.membershipId, role: 'REVIEWER' }), 422, 'REASON_REQUIRED');
    const withReviewer = await m.post(`/requests/${requestId}/assign`, { assigneeMembershipId: reviewer.membershipId, role: 'REVIEWER', reason: 'The document reviewer checks visa cases.' }, [200, 201]);
    expect(withReviewer.reviewer.membershipId).toBe(reviewer.membershipId);
    await t.settle();

    // The operator now has the case - in the list and by id - and was told about it.
    const mineNow = await api(t, operator).get('/requests?assignedToId=me');
    expect(mineNow.data.map((r: any) => r.id)).toEqual([requestId]);
    expect((await view(operator)).assignee.membershipId).toBe(operator.membershipId);
    const inbox = await api(t, operator).get('/me/notifications');
    expect(inbox.data.some((n: any) => n.relatedId === requestId)).toBe(true);
    const workload = await m.get('/staff/workload');
    expect(JSON.stringify(workload)).toContain(operator.membershipId);

    // The customer is not told who works on the file.
    const cv = await view(customer);
    expect(cv.assignee).toBeUndefined();
    expect(cv.assignments).toBeUndefined();
    // Every assignment is on record for staff.
    expect(((await view(manager)).assignments as any[]).length).toBeGreaterThanOrEqual(3);
  });

  it('S14 operator processes request', async () => {
    const op = api(t, operator);
    const started = await op.post(`/requests/${requestId}/transition`, { to: 'IN_PREPARATION' }, [200, 201]);
    expect(started.status).toBe('IN_PREPARATION');

    // Notes for colleagues stay internal; a message to the customer is visible to the customer.
    await op.post(`/requests/${requestId}/comments`, { body: 'Internal: sponsor file checked against the tenancy contract.', visibility: 'INTERNAL' }, [200, 201]);
    await op.post(`/requests/${requestId}/comments`, { body: 'We are preparing your application.', visibility: 'CUSTOMER' }, [200, 201]);
    const cv = await view(customer);
    expect(cv.statusLabel.en).toBe('Being prepared');
    const seen = (cv.comments as any[]).map((c) => c.body);
    expect(seen).toContain('We are preparing your application.');
    expect(JSON.stringify(cv)).not.toContain('sponsor file checked');
    // The customer learns that the centre wrote, and the first name of who did - not the full name, not the role.
    const operatorName = (await api(t, operator).get('/auth/me')).user.fullName as string;
    expect(operatorName.split(' ').length).toBeGreaterThan(1);
    const theirs = (cv.comments as any[]).find((c) => c.body === 'We are preparing your application.');
    expect(theirs).toMatchObject({ authorKind: 'STAFF', authorType: 'STAFF', authorName: operatorName.split(' ')[0], visibility: 'CUSTOMER' });
    expect(JSON.stringify(cv.comments)).not.toContain(operatorName);
    const forStaff = ((await view(receptionist)).comments as any[]).find((c) => c.body === 'We are preparing your application.');
    expect(forStaff).toMatchObject({ authorKind: 'STAFF', authorName: operatorName });

    // This centre only prepares the paperwork for this service: recording a submission to an authority is refused.
    const submission = await op.req('POST', `/requests/${requestId}/external-references`, { channel: 'MANUAL_PORTAL', authorityName: 'Sample authority (fictional)', referenceNo: 'SAMPLE-0001' });
    expectRefused(submission, 422, 'SUBMISSION_NOT_PERMITTED');

    // The operator files the prepared application as the result document of the case.
    const withLine = await op.post(`/requests/${requestId}/checklist`, { documentTypeKey: 'completed_document', label: 'Prepared application', isMandatory: true, kind: 'COMPLETION' }, [200, 201]);
    const completion = line(withLine, 'completed_document', 'COMPLETION');
    expect(completion.status).toBe('MISSING');
    // (The customer cannot put a file there.)
    expectRefused(
      await api(t, customer).req('POST', '/documents/upload-intents', { requestId, checklistItemId: completion.id, documentTypeKey: 'completed_document', filename: 'mine.pdf', mime: 'application/pdf', sizeBytes: 100 }),
      403,
      'COMPLETION_DOCUMENT_STAFF_ONLY',
    );
    prepared = await uploadDocument(t, operator, { customerId, requestId, checklistItemId: completion.id, documentTypeKey: 'completed_document', title: 'Prepared family visa application' }, pdf('prepared application', 'application.pdf', 1500));

    // "Preparation done": the service requires review, so the case goes to the reviewer - not straight on.
    const direct = await op.req('POST', `/requests/${requestId}/transition`, { to: 'FINAL_REVIEW' });
    expectRefused(direct, 422, 'APPROVAL_REQUIRED');
    await op.post(`/requests/${requestId}/workflow/complete-step`, { note: 'Preparation finished.' }, [200, 201]);
    await t.settle();
    const pending = await view(reviewer);
    expect(pending.status).toBe('PENDING_APPROVAL');
    const approval = (pending.approvals as any[]).find((a) => a.status === 'PENDING');
    expect(approval).toBeTruthy();
    // For the customer nothing changed: still "being prepared".
    expect((await view(customer)).statusLabel.en).toBe('Being prepared');

    // The operator cannot approve their own work; the reviewer does.
    expectRefused(await op.req('POST', `/requests/${requestId}/approvals/${approval.id}/decide`, { decision: 'APPROVED', comment: 'Looks fine to me' }), 403);
    await api(t, reviewer).post(`/requests/${requestId}/approvals/${approval.id}/decide`, { decision: 'APPROVED', comment: 'Checked against the documents.' }, [200, 201]);
    await t.settle();
    const reviewed = await view(reviewer);
    expect(reviewed.status).toBe('FINAL_REVIEW');
    expect((reviewed.approvals as any[]).find((a) => a.id === approval.id).status).toBe('APPROVED');
  });

  it('S15 request is completed', async () => {
    // Completing is a review decision: the operator and the receptionist cannot do it.
    expectRefused(await api(t, operator).req('POST', `/requests/${requestId}/complete`), 403);
    expectRefused(await api(t, receptionist).req('POST', `/requests/${requestId}/complete`), 403);

    const done = await api(t, reviewer).post(`/requests/${requestId}/complete`, {}, [200, 201]);
    expect(done.status).toBe('COMPLETED');
    expect(done.completedAt).toBeTruthy();
    await t.settle();

    // Everybody sees the same end state: staff, the customer, and whoever holds the tracking code.
    const staffView = await view(manager);
    expect(staffView).toMatchObject({ status: 'COMPLETED', paymentStatus: 'PAID' });
    expect(staffView.workflow.status).toBe('COMPLETED');
    expect((await view(customer)).status).toBe('COMPLETED');
    const tracked = await anonymous(t).post('/public/track', { tenantSlug: centre.slug, requestNo, trackingCode }, [200, 201]);
    expect(tracked.status).toBe('COMPLETED');
    expect(tracked.completedAt).toBeTruthy();

    // The history tells the whole story in order, for staff.
    const path = (staffView.history as any[])
      .filter((h) => h.from !== h.to)
      .sort((a, b) => Number(a.meta.seq) - Number(b.meta.seq))
      .map((h) => h.to);
    expect(path).toEqual(['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'AWAITING_CUSTOMER', 'UNDER_REVIEW', 'QUOTED', 'AWAITING_PAYMENT', 'READY_FOR_PROCESSING', 'IN_PREPARATION', 'PENDING_APPROVAL', 'READY_TO_SUBMIT', 'FINAL_REVIEW', 'COMPLETED']);

    // A completed case cannot be cancelled, and the money matches: invoiced = paid, nothing open.
    expectRefused(await api(t, manager).req('POST', `/requests/${requestId}/cancel`, { reason: 'Too late to cancel' }), 409, 'INVALID_TRANSITION');
    expect(staffView.finance.totals).toMatchObject({ invoiced: aed(TOTAL), paid: aed(TOTAL), refunded: '0.00', balance: '0.00' });
    const counts = await api(t, manager).get('/requests/counts');
    expect(counts.buckets.completedToday).toBeGreaterThanOrEqual(1);
  });

  it('S16 customer receives notification', async () => {
    // In the portal inbox: one message per step that concerned the customer, each linked to its record.
    const inbox = await api(t, customer).get('/me/notifications?pageSize=100');
    const events = inbox.data.map((n: any) => n.eventKey);
    expect(events).toEqual(expect.arrayContaining(['request.created', 'request.documents_missing', 'quotation.ready', 'payment.requested', 'payment.received', 'request.completed']));
    const completed = inbox.data.filter((n: any) => n.eventKey === 'request.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ relatedType: 'ServiceRequest', relatedId: requestId, readAt: null });
    expect(`${completed[0].subject} ${completed[0].body}`).toContain(requestNo);
    // Internal steps (sent for review, approved) produced no customer message.
    expect(inbox.data.every((n: any) => !JSON.stringify(n).includes('PENDING_APPROVAL'))).toBe(true);

    // The centre's delivery log: the "completed" email was SENT once, through the configured provider.
    const log = await api(t, centre.owner).get(`/notifications?customerId=${customerId}&eventKey=request.completed&pageSize=100`);
    const email = log.data.filter((n: any) => n.channel === 'EMAIL');
    expect(email).toHaveLength(1);
    expect(email[0]).toMatchObject({ status: 'SENT', recipientAddress: person.email, relatedId: requestId });
    const detail = await api(t, centre.owner).get(`/notifications/${email[0].id}`);
    expect(detail.deliveries.filter((d: any) => d.status === 'SENT')).toHaveLength(1);

    // And what left the application: the mail driver of the test environment ("log") captured exactly one such
    // message to the customer's address. (Real delivery by an external provider is outside this suite.)
    const mails = mailTo(person.email).filter((mail) => mail.subject === email[0].subject);
    expect(mails).toHaveLength(1);
    expect(mails[0].text).toContain(requestNo);
    expect(mails[0].text).not.toMatch(/storage\/local\/download|download-link/); // a message never carries a file link

    // Reading it is the customer's own business: somebody else cannot mark it, the customer can.
    expectRefused(await api(t, stranger).req('POST', `/me/notifications/${completed[0].id}/read`), 404);
    const before = inbox.unreadCount;
    await api(t, customer).post(`/me/notifications/${completed[0].id}/read`, {}, [200, 201]);
    expect((await api(t, customer).get('/me/notifications')).unreadCount).toBe(before - 1);
    // The other customer of the centre received nothing about this request.
    const theirs = await api(t, stranger).get('/me/notifications?pageSize=100');
    expect(theirs.data.some((n: any) => n.relatedId === requestId || JSON.stringify(n).includes(requestNo))).toBe(false);
  });

  it('S17 customer downloads completed document', async () => {
    // The result is in the customer's documents, marked as the centre's completed document.
    const docs = await api(t, customer).get(`/documents?requestId=${requestId}`);
    const result = docs.data.find((d: any) => d.isCompletionDocument);
    expect(result).toBeTruthy();
    expect(result).toMatchObject({ id: prepared.documentId, documentTypeKey: 'completed_document', downloadable: true });
    expect(line(await view(customer), 'completed_document', 'COMPLETION').document.id).toBe(prepared.documentId);

    // A short-lived signed link, and behind it exactly the file the operator uploaded.
    const { link, bytes } = await downloadDocument(t, customer, prepared.documentId);
    expect(new Date(link.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(link.expiresAt).getTime()).toBeLessThan(Date.now() + 60 * 60_000);
    expect(link).toMatchObject({ filename: 'application.pdf', mime: 'application/pdf', sizeBytes: prepared.content.length });
    expect(bytes.equals(prepared.content)).toBe(true);
    // The link is the capability (no token needed) - which is exactly why it is short-lived; a tampered link is refused.
    const tampered = link.url.replace(/.$/, (c: string) => (c === 'A' ? 'B' : 'A'));
    expectRefused(await fetchLink(t, tampered), 403);

    // Another customer cannot get a link, and an anonymous caller cannot ask for one.
    expectRefused(await api(t, stranger).req('POST', `/documents/${prepared.documentId}/download-link`, {}), 404);
    expectRefused(await anonymous(t).req('POST', `/documents/${prepared.documentId}/download-link`, {}), 401);

    // The download is on the document's access log, attributed to the customer.
    const log = await api(t, centre.owner).get(`/documents/${prepared.documentId}/access-logs?pageSize=100`);
    const byCustomer = log.data.filter((e: any) => e.actorId === customer.userId || e.userId === customer.userId);
    expect(byCustomer.some((e: any) => /DOWNLOAD/.test(e.action))).toBe(true);
  });
});
