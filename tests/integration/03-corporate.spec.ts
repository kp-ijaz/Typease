import {
  Actor,
  aed,
  api,
  Centre,
  Company,
  createCompany,
  createService,
  CreatedService,
  downloadDocument,
  dubaiDay,
  expectRefused,
  fils,
  finishCheckout,
  enableSandboxGateway,
  inviteStaff,
  pdf,
  percent,
  samplePassportNo,
  signUpCentre,
  startCheckout,
  sum,
  TestApp,
  uniq,
  uploadDocument,
} from '../support';

/**
 * Scenario 18: a corporate customer submits a request for one of its employees.
 *
 * The company has approved credit and a contract price, the service is handled
 * through an authorised partner (integration mode "partner processing" of
 * section 31 of the specification), and the invoice is settled on account after
 * the work is done. The story crosses the corporate, catalogue, integrations,
 * requests, documents and finance modules and three applications (centre,
 * platform console, corporate portal).
 */
describe('Corporate customer (scenario 18)', () => {
  let t: TestApp;
  let centre: Centre;
  let company: Company;
  let service: CreatedService;
  let receptionist: Actor;
  let reviewer: Actor;
  let operator: Actor;

  const id = uniq();
  const LIST_FEE = fils('300.00');
  const CONTRACT_FEE = fils('250.00');
  const GOVERNMENT_FEE = fils('500.00');
  const TAX = percent(CONTRACT_FEE, 5);
  const TOTAL = sum([CONTRACT_FEE, TAX, GOVERNMENT_FEE]);
  const CREDIT_LIMIT = fils('1000.00');
  const TERMS_DAYS = 30;
  const PARTNER = `Sample Partner Services ${id} (fictional)`;

  let employeeId: string;
  let requestId: string;
  let requestNo: string;
  let quotationId: string;
  let invoiceId: string;

  const view = (actor: Actor) => api(t, actor).get(`/requests/${requestId}`);

  beforeAll(async () => {
    t = await TestApp.create();
    centre = await signUpCentre(t, { name: `Corporate Desk ${id}` });
    await api(t, centre.owner).patch('/tenant', { taxRatePercent: 5 });
    await enableSandboxGateway(t, centre.owner);
    receptionist = await inviteStaff(t, centre, 'receptionist');
    reviewer = await inviteStaff(t, centre, 'reviewer');
    operator = await inviteStaff(t, centre, 'operator');

    // The centre works with a partner for this kind of service. The owner records the authorisation; TypEase
    // reviews it. Until then the catalogue refuses a partner-coordination service.
    const refused = await api(t, centre.owner).req('POST', '/services', { categoryId: (await api(t, centre.owner).get('/service-categories'))[0].id, code: `EARLY-${id}`.toUpperCase(), name: 'Too early', complianceCapability: 'PARTNER_COORDINATION', price: { serviceFee: '1.00' } });
    expectRefused(refused, 422, 'CAPABILITY_NOT_PERMITTED');
    const record = await api(t, centre.owner).post(
      '/integrations',
      {
        category: 'PARTNER',
        provider: 'authorised-partner',
        name: PARTNER,
        config: { partnerLegalName: `${PARTNER} LLC`, serviceScope: 'Work permit applications (sample)', agreementReference: `AGR-${id}`.toUpperCase(), agreementValidUntil: new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10) },
        authorisationNote: 'Sample agreement on file (test data, fictional partner).',
      },
      201,
    );
    const platformAdmin = await t.createPlatformAdmin('SUPER_ADMIN');
    const verified = await api(t, platformAdmin).post(`/platform/integrations/authorisations/${record.id}/verify`, { note: 'Sample agreement checked (test data).' });
    expect(verified.state).toBe('VERIFIED');

    service = await createService(t, centre.owner, {
      name: 'Work permit application (through partner)',
      categoryKey: 'visa',
      complianceCapability: 'PARTNER_COORDINATION',
      requiresApproval: false,
      paymentPolicy: 'BEFORE_PROCESSING',
      price: { serviceFee: aed(LIST_FEE), governmentFeeEstimate: aed(GOVERNMENT_FEE) },
      requirements: [{ documentTypeKey: 'passport', label: 'Passport copy of the employee', isMandatory: true }],
    });

    // The corporate customer: verified, with credit terms, a contract price and an authorised contact.
    company = await createCompany(t, centre, { companyName: `Gulf Build Contracting ${id} LLC`, credit: { limit: aed(CREDIT_LIMIT), termsDays: TERMS_DAYS } });
    await api(t, centre.owner).put(`/corporate-accounts/${company.id}/prices`, { serviceId: service.id, serviceFee: aed(CONTRACT_FEE) });
    await t.settle();
  });
  afterAll(() => t.close());

  it('S18 corporate customer submits an employee request', async () => {
    const corp = api(t, company.admin);

    // --- the company administrator works in the corporate portal, for their own company only
    const account = await corp.get('/corporate/account');
    expect(account).toMatchObject({ id: company.id, status: 'ACTIVE', verified: true, credit: { approved: true, limit: aed(CREDIT_LIMIT), paymentTermsDays: TERMS_DAYS } });
    expect(account.notes).toBeUndefined();
    const prices = await corp.get('/corporate/prices');
    expect(prices.find((p: any) => p.serviceId === service.id)).toMatchObject({ contractServiceFee: aed(CONTRACT_FEE), catalogueServiceFee: aed(LIST_FEE) });
    // The portal catalogue already shows the company's own price.
    const catalogue = await corp.get('/catalogue');
    expect(catalogue.services.find((s: any) => s.id === service.id).price).toMatchObject({ serviceFee: aed(CONTRACT_FEE), serviceFeeSource: 'CORPORATE_CONTRACT', total: aed(TOTAL) });

    // --- an employee is added to the company's directory
    const passportNo = samplePassportNo();
    const employee = await corp.post('/corporate/employees', { fullName: `Ravi Kumar ${id}`, email: `ravi-${id}@example.test`, nationality: 'IN', passportNo, passportCountry: 'IN', passportExpiry: '2031-06-30', employeeNo: `E-${id}`, designation: 'Electrician' }, 201);
    employeeId = employee.id;
    expect(employee).toMatchObject({ fullName: `Ravi Kumar ${id}`, status: 'ACTIVE', outcome: 'CREATED' });
    expect(JSON.stringify(employee)).not.toContain(passportNo); // masked, also for the company
    // The id of the person's customer record is given (the portal filters requests, documents and reminders by it);
    // the centre's internal customer number and record status are not exposed to the company.
    expect(employee.customerId).toEqual(expect.any(String));
    expect(employee.customerNo).toBeUndefined();
    expect(employee.customerStatus).toBeUndefined();

    // --- the request for that employee
    const draft = await corp.post('/requests', { serviceId: service.id, corporateEmployeeId: employeeId, instructions: 'Urgent site deployment.' }, 201);
    requestId = draft.id;
    requestNo = draft.requestNo;
    expect(draft).toMatchObject({ status: 'DRAFT', source: 'CORPORATE' });
    expect(draft.corporateAccount.id).toBe(company.id);
    expect(draft.customer.fullName).toBe(`Ravi Kumar ${id}`);
    const passportLine = (draft.checklist as any[]).find((l) => l.documentTypeKey === 'passport');
    await uploadDocument(t, company.admin, { requestId, checklistItemId: passportLine.id, documentTypeKey: 'passport', expiryDate: '2031-06-30' }, pdf('employee passport', 'passport-ravi.pdf'));
    const submitted = await corp.post(`/requests/${requestId}/submit`, {}, 200);
    expect(submitted.trackingCode).toBeTruthy();
    await t.settle();
    expect((await view(company.admin)).status).toBe('UNDER_REVIEW');

    // The centre sees a corporate request, billed to the company.
    const staffView = await view(receptionist);
    expect(staffView).toMatchObject({ requestNo, source: 'CORPORATE', corporateAccount: { id: company.id } });
    const corporateList = await api(t, receptionist).get(`/requests?corporateAccountId=${company.id}`);
    expect(corporateList.data.map((r: any) => r.id)).toEqual([requestId]);

    // --- documents verified, quotation at the contract price
    const uploaded = (staffView.checklist as any[]).find((l) => l.documentTypeKey === 'passport').document;
    await api(t, reviewer).post(`/documents/${uploaded.id}/verify`, { decision: 'APPROVED', expiryDate: '2031-06-30' });
    await t.settle();
    const quotation = await api(t, receptionist).post(`/quotations/from-request/${requestId}`, {}, 201);
    quotationId = quotation.id;
    expect(quotation).toMatchObject({ subtotalServiceFee: aed(CONTRACT_FEE), subtotalGovernmentFee: aed(GOVERNMENT_FEE), taxTotal: aed(TAX), total: aed(TOTAL), corporateAccountId: company.id });
    await api(t, receptionist).post(`/quotations/${quotationId}/send`);
    await t.settle();
    expect((await view(company.admin)).status).toBe('QUOTED');

    // --- the company approves; the invoice goes on account and work starts without waiting for money
    const approved = await corp.post(`/quotations/${quotationId}/approve`, {}, [200, 201]);
    invoiceId = approved.invoice.id;
    expect(approved.invoice).toMatchObject({ total: aed(TOTAL), balanceDue: aed(TOTAL) });
    await t.settle();
    const released = await view(receptionist);
    expect(released.status).toBe('READY_FOR_PROCESSING');
    const invoice = await api(t, receptionist).get(`/invoices/${invoiceId}`);
    expect(invoice).toMatchObject({ status: 'ISSUED', corporateAccountId: company.id, requestId, total: aed(TOTAL) });
    // Payment terms of the company: due about 30 days after issue, not on the day itself.
    // Exactly: the end (23:59:59.999 Dubai time = 19:59:59.999 UTC) of the day "issue date + 30" on the centre's calendar.
    expect(invoice.dueAt).toBe(`${dubaiDay(TERMS_DAYS, new Date(invoice.issuedAt))}T19:59:59.999Z`);
    expect(invoice.overdue).toBe(false);

    // The credit limit is real: a further quotation that would take the company over it cannot be approved.
    const companyProfile = await api(t, centre.owner).post('/customers', { type: 'BUSINESS', fullName: company.companyName, corporateAccountId: company.id, confirmNotDuplicate: true }, 201);
    const extra = await api(t, receptionist).post('/quotations', { customerId: companyProfile.id, corporateAccountId: company.id, items: [{ description: 'Document attestation (sample)', component: 'SERVICE_FEE', quantity: 1, unitAmount: '400.00' }] }, 201);
    await api(t, receptionist).post(`/quotations/${extra.id}/send`);
    const overLimit = await corp.req('POST', `/quotations/${extra.id}/approve`, {});
    expectRefused(overLimit, 422, 'CREDIT_LIMIT_EXCEEDED');
    expect((await corp.get(`/quotations/${extra.id}`)).status).toBe('SENT'); // nothing was approved, no invoice exists
    expect((await corp.get('/corporate/invoices')).data.map((i: any) => i.id)).toEqual([invoiceId]);

    // --- processing through the partner (staff record what the partner did; nothing is sent to any authority)
    await api(t, centre.owner).post(`/requests/${requestId}/assign`, { assigneeMembershipId: operator.membershipId, role: 'OPERATOR' }, [200, 201]);
    const op = api(t, operator);
    await op.post(`/requests/${requestId}/transition`, { to: 'IN_PREPARATION' }, [200, 201]);
    const withLine = await op.post(`/requests/${requestId}/checklist`, { documentTypeKey: 'completed_document', label: 'Work permit (result)', isMandatory: true, kind: 'COMPLETION' }, [200, 201]);
    const completion = (withLine.checklist as any[]).find((l) => l.kind === 'COMPLETION');
    // The result line is for the centre to fill: the company cannot put a file of its own there.
    expectRefused(
      await corp.req('POST', '/documents/upload-intents', { requestId, checklistItemId: completion.id, documentTypeKey: 'completed_document', filename: 'our-own-permit.pdf', mime: 'application/pdf', sizeBytes: 500 }),
      403,
      'COMPLETION_DOCUMENT_STAFF_ONLY',
    );
    await op.post(`/requests/${requestId}/workflow/complete-step`, { note: 'File prepared for the partner.' }, [200, 201]);
    await t.settle();
    expect((await view(operator)).status).toBe('READY_TO_SUBMIT');

    // Only the channel that matches the service's capability is accepted, and a partner must be named.
    expectRefused(await op.req('POST', `/requests/${requestId}/external-references`, { channel: 'MANUAL_PORTAL', authorityName: 'Sample authority (fictional)', referenceNo: 'SAMPLE-1' }), 422, 'CHANNEL_NOT_PERMITTED');
    expectRefused(await op.req('POST', `/requests/${requestId}/external-references`, { channel: 'AUTHORISED_PARTNER', referenceNo: 'SAMPLE-1' }), 422, 'PARTNER_NAME_REQUIRED');
    // A client can never claim that a status is "official".
    expectRefused(await op.req('POST', `/requests/${requestId}/external-references`, { channel: 'AUTHORISED_PARTNER', partnerName: PARTNER, referenceNo: 'SAMPLE-1', statusSource: 'VERIFIED_OFFICIAL' }), 400);

    const sent = await op.post(`/requests/${requestId}/external-references`, { channel: 'AUTHORISED_PARTNER', authorityName: 'Sample authority (fictional)', referenceNo: `SAMPLE-APP-${id}`, partnerName: PARTNER, partnerReference: `SAMPLE-PRT-${id}`, notes: 'Sample reference numbers.' }, [200, 201]);
    expect(sent.status).toBe('EXTERNAL_PROCESSING');
    const reference = (sent.externalReferences as any[]).at(-1);
    await op.patch(`/requests/${requestId}/external-references/${reference.id}`, { status: 'Under process at the partner' });
    // The status is labelled with where it came from - the company sees the label too.
    const corpView = await view(company.admin);
    expect(corpView.status).toBe('EXTERNAL_PROCESSING');
    expect(corpView.externalStatus).toMatchObject({ status: 'Under process at the partner', source: 'PARTNER_PROVIDED' });
    expect(corpView.externalStatus.sourceLabel.en).toMatch(/partner/i);
    expect(JSON.stringify(corpView)).not.toContain('Sample reference numbers.'); // internal notes stay internal

    // The partner reports the result; the centre files the permit and completes the case.
    await op.post(`/requests/${requestId}/external-result`, { outcome: 'COMPLETED', note: 'The partner confirmed that the application was processed (sample).' }, [200, 201]);
    await t.settle();
    expect((await view(operator)).status).toBe('FINAL_REVIEW');
    const permit = await uploadDocument(t, operator, { requestId, checklistItemId: completion.id, documentTypeKey: 'completed_document', title: 'Work permit (sample)' }, pdf('work permit', 'work-permit.pdf', 900));
    // On account: the open invoice does not block completion for a company with approved credit.
    const done = await api(t, reviewer).post(`/requests/${requestId}/complete`, {}, [200, 201]);
    expect(done.status).toBe('COMPLETED');
    await t.settle();

    // --- back in the corporate portal: the request, the result and the invoice on the statement
    const mine = await corp.get('/requests');
    expect(mine.data.map((r: any) => [r.id, r.status])).toEqual([[requestId, 'COMPLETED']]);
    const result = await downloadDocument(t, company.admin, permit.documentId);
    expect(result.bytes.equals(permit.content)).toBe(true);
    const statement = await corp.get('/corporate/invoices/statement');
    expect(statement).toMatchObject({ openBalance: aed(TOTAL), availableCredit: aed(CREDIT_LIMIT - TOTAL) });
    expect(statement.invoices.map((i: any) => [i.id, i.balanceDue])).toEqual([[invoiceId, aed(TOTAL)]]);
    expect(statement.ageing.current).toBe(aed(TOTAL)); // not due yet
    const counters = (await api(t, centre.owner).get(`/corporate-accounts/${company.id}`)).counters;
    expect(counters).toMatchObject({ employees: 1, totalRequests: 1, openRequests: 0, unpaidInvoices: 1, unpaidInvoicesBalance: aed(TOTAL), creditAvailable: aed(CREDIT_LIMIT - TOTAL) });

    // --- the company pays the invoice online; the statement is clear and the credit is free again
    const checkout = await startCheckout(t, company.admin, invoiceId);
    expect(checkout.amount).toBe(aed(TOTAL));
    const paid = await finishCheckout(t, checkout);
    expect(paid.webhook).toMatchObject({ delivered: true, status: 200 });
    await t.settle();
    expect(await api(t, receptionist).get(`/invoices/${invoiceId}`)).toMatchObject({ status: 'PAID', balanceDue: '0.00' });
    const after = await corp.get('/corporate/invoices/statement');
    expect(after).toMatchObject({ openBalance: '0.00', availableCredit: aed(CREDIT_LIMIT) });
    expect((await view(receptionist)).paymentStatus).toBe('PAID');
    // With the credit free again, the quotation that was over the limit can now be approved.
    const second = await corp.post(`/quotations/${extra.id}/approve`, {}, [200, 201]);
    expect(second.quotation.status).toBe('APPROVED');
  });

  it('S18 the company employee signs in and sees only their own request', async () => {
    const corp = api(t, company.admin);
    // A colleague with a request of their own.
    const other = await corp.post('/corporate/employees', { fullName: `Sunil Thapa ${id}`, email: `sunil-${id}@example.test`, nationality: 'NP', employeeNo: `E2-${id}` }, 201);
    const otherRequest = await corp.post('/requests', { serviceId: service.id, corporateEmployeeId: other.id }, 201);

    // The administrator gives the first employee a login; the employee accepts the invitation.
    const login = await corp.post(`/corporate/employees/${employeeId}/login`, {}, 201);
    expect(login).toMatchObject({ employeeId, status: 'INVITED', email: `ravi-${id}@example.test` });
    const invitation = login.dev?.invitationToken;
    expect(invitation).toBeTruthy();
    const accepted = await api(t, null).post('/auth/invitations/accept', { token: invitation, password: 'Correct-Horse-42', app: 'corporate' }, 200);
    expect(accepted.status).toBe('OK');
    const employee = await t.login(`ravi-${id}@example.test`, 'Correct-Horse-42', 'corporate', centre.slug);
    expect(employee.roleKey).toBe('corporate_employee');

    // Own request: yes. The colleague's request, the company's account, directory and invoices: no.
    const e = api(t, employee);
    const mine = await e.get('/requests');
    expect(mine.data.map((r: any) => r.id)).toEqual([requestId]);
    expect((await e.get(`/requests/${requestId}`)).status).toBe('COMPLETED');
    expectRefused(await e.req('GET', `/requests/${otherRequest.id}`), 404);
    expectRefused(await e.req('GET', '/corporate/account'), 403);
    expectRefused(await e.req('GET', '/corporate/employees'), 403);
    expectRefused(await e.req('GET', '/corporate/invoices'), 403);
    expectRefused(await e.req('GET', `/invoices/${invoiceId}`), 403);
    expectRefused(await e.req('POST', `/quotations/${quotationId}/approve`, {}), 403);
    // The administrator sees both.
    expect((await corp.get('/requests')).data.map((r: any) => r.id).sort()).toEqual([requestId, otherRequest.id].sort());
  });
});
