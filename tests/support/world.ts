import { Actor, TestApp, uniq } from '../../services/api/test/helpers';
import { api, Centre, Company, createCompany, createService, CreatedService, inviteStaff, registerPortalCustomer, registerWalkInCustomer, samplePassportNo, samplePhone, signUpCentre } from './centre';
import { uploadDocument } from './documents';
import { pdf } from './files';
import { enableSandboxGateway, idempotencyKey } from './finance';
import { dubaiDay } from './jobs';
import { CaseFile, Crew, runCase } from './journey';

/**
 * A fully populated centre: at least one row of every main resource type,
 * created through the public API by the users who would create it. The security
 * suite builds two of these and lets one attack the other with the harvested ids.
 */
export interface World {
  centre: Centre;
  crew: Crew;
  manager: Actor;
  accountant: Actor;
  /** A customer with a portal account and a completed, paid request. */
  customer: Actor;
  /** A second portal customer of the same centre, with a request of their own (resting in review). */
  neighbour: Actor;
  neighbourCase: CaseFile;
  company: Company;
  service: CreatedService;
  case: CaseFile;
  /** Ids by resource name (see `populate`). */
  ids: Record<string, string>;
  /** Strings that belong to this centre only: they must never show up in another centre's responses. */
  secrets: string[];
  /**
   * Personal data of this centre's customers: names, addresses, numbers, document titles, the text of an
   * internal note. Unlike `secrets` it does not contain the centre's own name - TypEase staff may see that.
   */
  personal: string[];
  /** Passport number and phone number of the walk-in customer (`ids.walkIn`). */
  passportNo: string;
  phone: string;
  /** Start time of an appointment slot at the head office that is still free; every call returns another one. */
  freeSlot: () => string;
}

const first = <T = any>(rows: T[] | { data: T[] }, what: string): T => {
  const list = Array.isArray(rows) ? rows : rows.data;
  if (!list?.length) throw new Error(`populate: expected at least one ${what}.`);
  return list[0];
};

/**
 * `platformStaff`: a TypEase staff member who asks this centre for support access (the request stays undecided),
 * so that the centre also owns an access grant and its owner has a message in the inbox.
 */
export async function populate(t: TestApp, label: string, platformStaff: Actor): Promise<World> {
  const tag = `${label}${uniq().slice(-6)}`.toUpperCase();
  const centre = await signUpCentre(t, { name: `${label} Typing ${tag}` });
  const owner = api(t, centre.owner);
  await owner.patch('/tenant', { taxRatePercent: 5 });
  await enableSandboxGateway(t, centre.owner);
  const crew: Crew = { owner: centre.owner, receptionist: await inviteStaff(t, centre, 'receptionist'), reviewer: await inviteStaff(t, centre, 'reviewer'), operator: await inviteStaff(t, centre, 'operator') };
  const manager = await inviteStaff(t, centre, 'manager');
  const accountant = await inviteStaff(t, centre, 'accountant');
  const ids: Record<string, string> = { tenant: centre.id, branch: centre.headOfficeId };
  const secrets: string[] = [tag, tag.toLowerCase()];
  const HO = centre.headOfficeId;

  // --- organisation and catalogue
  ids.branch2 = (await owner.post('/branches', { code: `B2${tag}`.slice(0, 10), name: `${tag} second branch` }, 201)).id;
  ids.role = (await owner.post('/roles', { key: `custom_${tag.toLowerCase()}`, name: `${tag} custom role`, permissions: ['customer.read'] }, 201)).id;
  ids.staff = crew.receptionist.membershipId!;
  ids.operator = crew.operator.membershipId!;
  ids.ownerUser = centre.owner.userId;
  const invitedEmail = `invited-${tag.toLowerCase()}@example.test`;
  await owner.post('/staff/invitations', { email: invitedEmail, fullName: `${tag} Invited Colleague`, roleKey: 'operator', allBranches: true, branchIds: [] }, 201);
  ids.invitedStaff = (await owner.get('/staff') as any[]).find((s) => (s.email ?? s.user?.email) === invitedEmail)?.id;
  ids.receptionistSession = first<any>(await api(t, crew.receptionist).get('/auth/sessions'), 'session of the receptionist').id;
  const service = await createService(t, centre.owner, {
    name: `${tag} visa typing`,
    categoryKey: 'visa',
    price: { serviceFee: '200.00', governmentFeeEstimate: '300.00' },
    requirements: [{ documentTypeKey: 'passport', label: 'Passport copy', isMandatory: true }],
    form: { steps: [{ key: 'details', title: 'Details', fields: [{ key: 'purpose', label: 'Purpose', type: 'text', required: true }] }] },
  });
  ids.service = service.id;
  ids.spareService = (await createService(t, centre.owner, { name: `${tag} attestation`, price: { serviceFee: '75.00' } })).id;
  const serviceDetail = await owner.get(`/services/${service.id}`);
  ids.requirement = first<any>(serviceDetail.requirements, 'service requirement').id;
  ids.form = first<any>(await owner.get(`/services/${service.id}/forms`), 'service form').id;
  ids.price = first<any>(await owner.get(`/services/${service.id}/prices`), 'service price').id;
  ids.category = first<any>(await owner.get('/service-categories'), 'service category').id;
  ids.documentType = (await owner.post('/document-types', { key: `doc_${tag.toLowerCase()}`, name: `${tag} special form` }, 201)).id;
  const workflow = first<any>(await owner.get('/workflows'), 'workflow');
  ids.workflow = workflow.id;
  ids.workflowVersion = first<any>(await owner.get(`/workflows/${workflow.id}/versions`), 'workflow version').id;

  // --- customers
  const customer = await registerPortalCustomer(t, centre, { fullName: `${tag} Portal Customer`, email: `portal-${tag.toLowerCase()}@example.test` });
  const neighbour = await registerPortalCustomer(t, centre, { fullName: `${tag} Neighbour`, email: `neighbour-${tag.toLowerCase()}@example.test` });
  ids.customer = customer.customerId!;
  ids.neighbour = neighbour.customerId!;
  const passportNo = samplePassportNo();
  secrets.push(passportNo);
  const phone = samplePhone();
  secrets.push(phone);
  const walkIn = await registerWalkInCustomer(t, crew.receptionist, { fullName: `${tag} Walk-in Customer`, passportNo, passportCountry: 'IN', phone });
  ids.walkIn = walkIn.id;
  ids.customerTag = (await api(t, crew.receptionist).post('/customer-tags', { name: `${tag} VIP`, color: '#0B7AD1' }, 201)).id;
  await api(t, crew.receptionist).post(`/customers/${walkIn.id}/tags/${ids.customerTag}`, {}, [200, 201]);
  ids.customerNote = (await api(t, crew.receptionist).post(`/customers/${walkIn.id}/notes`, { body: `${tag} internal note: prefers a call in the evening.` }, 201)).id;
  ids.customerContact = (await api(t, crew.receptionist).post(`/customers/${walkIn.id}/contacts`, { type: 'EMAIL', value: `alt-${tag.toLowerCase()}@example.test`, label: 'Work' }, 201)).id;

  // --- a completed, paid request with documents; and the neighbour's request resting in review
  const done = await runCase(t, crew, { serviceId: service.id, branchId: HO, portalCustomer: customer, fields: { purpose: `${tag} family visit` } });
  const neighbourCase = await runCase(t, crew, { serviceId: service.id, branchId: HO, portalCustomer: neighbour, fields: { purpose: `${tag} neighbour purpose` }, stopAt: 'QUOTED' });
  Object.assign(ids, { request: done.requestId, quotation: done.quotationId!, invoice: done.invoiceId!, payment: done.paymentId!, document: done.inputs[0].documentId, documentVersion: done.inputs[0].versionId, resultDocument: done.result!.documentId });
  Object.assign(ids, { neighbourRequest: neighbourCase.requestId, neighbourQuotation: neighbourCase.quotationId!, neighbourDocument: neighbourCase.inputs[0].documentId });
  const requestView = await owner.get(`/requests/${done.requestId}`);
  ids.checklistItem = first<any>(requestView.checklist, 'checklist line').id;
  ids.neighbourChecklistItem = first<any>((await owner.get(`/requests/${neighbourCase.requestId}`)).checklist, 'checklist line of the second request').id;
  const commented = await api(t, crew.receptionist).post(`/requests/${neighbourCase.requestId}/comments`, { body: `${tag} internal comment`, visibility: 'INTERNAL' }, [200, 201]);
  ids.comment = (commented.comments ? commented.comments.at(-1) : commented).id;
  ids.share = (await api(t, manager).post(`/documents/${ids.document}/shares`, { recipient: `${tag} recipient` }, 201)).id;
  const vault = await uploadDocument(t, customer, { documentTypeKey: 'other', title: `${tag} salary letter` }, pdf(`${tag} vault`, `${tag.toLowerCase()}-letter.pdf`));
  ids.vaultDocument = vault.documentId;
  ids.neighbourVaultDocument = (await uploadDocument(t, neighbour, { documentTypeKey: 'other', title: `${tag} bank statement` }, pdf(`${tag} statement`, `${tag.toLowerCase()}-statement.pdf`))).documentId;

  // --- more finance: refund with credit note, expense, reconciliation, a second (open) invoice
  const refund = await api(t, accountant).with({ 'Idempotency-Key': idempotencyKey() }).post('/refunds', { paymentId: ids.payment, invoiceId: ids.invoice, amount: '21.00', reason: `${tag} fee correction`, cancelCharge: true }, 201);
  await owner.post(`/refunds/${refund.id}/approve`, { reference: `${tag} cash returned` });
  ids.refund = refund.id;
  ids.creditNote = first<any>(await api(t, accountant).get(`/credit-notes?invoiceId=${ids.invoice}`), 'credit note').id;
  ids.pendingRefund = (await api(t, accountant).with({ 'Idempotency-Key': idempotencyKey() }).post('/refunds', { paymentId: ids.payment, invoiceId: ids.invoice, amount: '5.00', reason: `${tag} waiting for approval` }, 201)).id;
  ids.expense = (await api(t, accountant).post('/expenses', { branchId: HO, category: 'RENT', description: `${tag} office rent`, amount: '900.00', paidOn: dubaiDay(0) }, 201)).id;
  ids.reconciliation = (await api(t, accountant).post('/reconciliations', { method: 'CASH', periodStart: `${dubaiDay(-1)}T00:00:00.000Z`, periodEnd: new Date(Date.now() + 60_000).toISOString(), settledAmount: '1.00' }, 201)).id;
  const openDraft = await api(t, accountant).post('/invoices', { customerId: walkIn.id, branchId: HO, items: [{ description: `${tag} typing`, component: 'SERVICE_FEE', quantity: 1, unitAmount: '80.00' }] }, 201);
  await api(t, accountant).post(`/invoices/${openDraft.id}/issue`);
  ids.openInvoice = openDraft.id;
  ids.draftInvoice = (await api(t, accountant).post('/invoices', { customerId: walkIn.id, branchId: HO, items: [{ description: `${tag} draft line`, component: 'SERVICE_FEE', quantity: 1, unitAmount: '60.00' }] }, 201)).id;
  ids.spareReconciliation = (await api(t, accountant).post('/reconciliations', { method: 'CARD_POS', periodStart: `${dubaiDay(-1)}T00:00:00.000Z`, periodEnd: new Date(Date.now() + 60_000).toISOString(), settledAmount: '0.00' }, 201)).id;

  // --- operations
  const day = dubaiDay(3);
  ids.slotConfig = (await owner.post('/appointments/slot-configs', { branchId: HO, weekday: new Date(`${day}T00:00:00Z`).getUTCDay(), startTime: '09:00', endTime: '17:00', slotMinutes: 30, capacity: 2 }, 201)).id;
  const availability = await owner.get(`/appointments/availability?branchId=${HO}&date=${day}`);
  const free = (availability.slots as any[]).filter((s) => s.available).map((s) => s.startsAt as string);
  if (free.length < 10) throw new Error(`populate: only ${free.length} free appointment slots.`);
  const freeSlot = () => {
    const next = free.shift();
    if (!next) throw new Error('populate: no free appointment slot is left.');
    return next;
  };
  ids.appointment = (await api(t, crew.receptionist).post('/appointments', { branchId: HO, startsAt: freeSlot(), customerId: ids.customer, notes: `${tag} appointment note` }, 201)).id;
  ids.spareAppointment = (await api(t, crew.receptionist).post('/appointments', { branchId: HO, startsAt: freeSlot(), customerId: ids.neighbour, notes: `${tag} second appointment` }, 201)).id;
  ids.closure = (await owner.post('/appointments/closures', { branchId: ids.branch2, date: dubaiDay(20), reason: `${tag} holiday` }, 201)).id;
  ids.queueToken = (await api(t, crew.receptionist).post('/queue/tokens', { branchId: HO }, 201)).id;
  ids.task = (await api(t, manager).post('/tasks', { title: `${tag} call the customer`, type: 'FOLLOW_UP', priority: 'HIGH', customerId: ids.customer, assigneeIds: [crew.receptionist.membershipId] }, 201)).id;
  ids.ticket = (await api(t, customer).post('/me/tickets', { subject: `${tag} where is my document`, message: `${tag} I am waiting for news.` }, 201)).id;
  ids.reminder = (await owner.post('/reminders', { customerId: ids.walkIn, documentTypeKey: 'passport', subjectLabel: `${tag} passport`, expiryDate: dubaiDay(200) }, 201)).id;
  const template = first<any>((await owner.get('/automations/templates')).templates, 'automation template');
  ids.automation = (await owner.post(`/automations/from-template/${template.key}`, {}, 201)).id;
  ids.scheduledReport = (await owner.post('/reports/scheduled', { reportKey: 'requests-by-status', params: { range: 'last_month' }, frequency: 'MONTHLY', recipients: [centre.owner.email] }, 201)).id;
  await owner.put('/notifications/templates/request.completed/EMAIL/en', { subject: `${tag} your request is ready`, body: `${tag} thank you for choosing us.` });

  // --- corporate
  const company = await createCompany(t, centre, { companyName: `${tag} Trading LLC`, credit: { limit: '5000.00', termsDays: 30 } });
  ids.corporateAccount = company.id;
  ids.corporateMember = first<any>(await owner.get(`/corporate-accounts/${company.id}/members`), 'corporate member').id;
  const employee = await owner.post(`/corporate-accounts/${company.id}/employees`, { fullName: `${tag} Employee`, email: `employee-${tag.toLowerCase()}@example.test`, employeeNo: `E-${tag}` }, 201);
  ids.corporateEmployee = employee.id;
  ids.corporateEmployeeCustomer = employee.customerId;
  ids.corporateAgreement = (await owner.post(`/corporate-accounts/${company.id}/agreements`, { title: `${tag} service agreement`, startsOn: dubaiDay(0), status: 'ACTIVE' }, 201)).id;
  ids.corporatePrice = (await owner.put(`/corporate-accounts/${company.id}/prices`, { serviceId: service.id, serviceFee: '150.00' })).id;
  const corporateRequest = await api(t, company.admin).post('/requests', { serviceId: service.id, corporateEmployeeId: employee.id, fields: { purpose: `${tag} company purpose` } }, 201);
  ids.corporateRequest = corporateRequest.id;
  const corporateDraft = await api(t, accountant).post('/invoices', { customerId: employee.customerId, corporateAccountId: company.id, branchId: HO, items: [{ description: `${tag} company typing`, component: 'SERVICE_FEE', quantity: 1, unitAmount: '300.00' }] }, 201);
  await api(t, accountant).post(`/invoices/${corporateDraft.id}/issue`);
  ids.corporateInvoice = corporateDraft.id;

  // --- administration and privacy
  ids.integration = first<any>(await owner.get('/integrations'), 'integration').id;
  ids.domain = (await owner.post('/domains', { domain: `portal-${tag.toLowerCase()}.example.ae` }, 201)).id;
  ids.privacyRequest = (await api(t, customer).post('/privacy/my/requests', { type: 'ACCESS', details: `${tag} please send me my data` }, 201)).id;
  ids.retentionPolicy = first<any>(await owner.get('/privacy/retention-policies'), 'retention policy').id;
  ids.privacyIncident = (await owner.post('/privacy/incidents', { title: `${tag} misdirected email`, description: `${tag}: a quotation was sent to the wrong address (test data).`, severity: 'LOW', personalDataInvolved: true }, 201)).id;
  ids.processor = (await owner.post('/privacy/processors', { name: `${tag} Mail Service`, purpose: 'Sends the centre\'s email (test data)', dataCategories: ['contact details'], country: 'AE' }, 201)).id;
  ids.platformTicket = (await owner.post('/support/platform-tickets', { subject: `${tag} question about billing`, message: `${tag}: how do we change the plan?` }, 201)).id;
  ids.accessGrant = (await api(t, platformStaff).post(`/platform/tenants/${centre.id}/access-grants`, { reason: `${tag}: investigating the billing question`, scopes: ['customer.read'], durationMinutes: 30 }, 201)).id;
  await t.settle();
  ids.ownerInboxNotification = first<any>(await owner.get('/me/notifications'), 'message in the owner\'s inbox').id;
  ids.notification = first<any>(await owner.get('/notifications?pageSize=5'), 'notification').id;
  ids.inboxNotification = first<any>(await api(t, customer).get('/me/notifications'), 'inbox notification').id;
  ids.auditLog = first<any>(await owner.get('/audit-logs?pageSize=5'), 'audit entry').id;
  ids.session = first<any>(await owner.get('/auth/sessions'), 'session').id;

  for (const [name, value] of Object.entries(ids)) if (!value) throw new Error(`populate: no id was harvested for "${name}".`);
  const personal = [passportNo, phone, `${tag} Portal Customer`, `${tag} Neighbour`, `${tag} Walk-in Customer`, `${tag} Employee`, customer.email, neighbour.email, `${tag} salary letter`, `${tag.toLowerCase()}-letter.pdf`, `${tag} internal note`, `${tag} family visit`];
  return { centre, crew, manager, accountant, customer, neighbour, neighbourCase, company, service, case: done, ids, secrets, personal, passportNo, phone, freeSlot };
}
