import { STATUS_SOURCE_LABEL } from '@typease/types';
import { Actor, TenantFixture, TestApp, uniq } from '../../../test/helpers';
import { periodKey } from '../../common/usage.service';
import {
  addCorporateUser, approveQuotation, checklistOf, completeDocuments, createCorporateAccount, createCustomer, createDocument, createService, draftRequest, emit, eventsOf, forceStatus,
  getRequest, historyOf, payInvoice, readyRequest, sendQuotation, statusOf, submittedRequest,
} from './fixtures';

describe('Service requests: access, scoping and creation', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let manager: Actor;
  let receptionist: Actor;
  let operator: Actor;
  let operator2: Actor;
  let reviewer: Actor;
  let accountant: Actor;

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    manager = await t.addStaff(alpha, 'manager');
    receptionist = await t.addStaff(alpha, 'receptionist');
    operator = await t.addStaff(alpha, 'operator');
    operator2 = await t.addStaff(alpha, 'operator');
    reviewer = await t.addStaff(alpha, 'reviewer');
    accountant = await t.addStaff(alpha, 'accountant');
  });
  afterAll(() => t.close());

  const move = (actor: Actor, id: string, to: string, extra: object = {}) => t.as(actor).post(`/requests/${id}/transition`, { to, ...extra });
  const assign = (id: string, who: Actor, role = 'OPERATOR', by: Actor = manager) => t.as(by).post(`/requests/${id}/assign`, { assigneeMembershipId: who.membershipId, role });

  // =====================================================================================
  describe('creation', () => {
    it('validates the service, the branch and the customer', async () => {
      const customer = await createCustomer(t, alpha);
      const service = await createService(t, alpha);
      await t.as(receptionist).post('/requests', { serviceId: service.id }).expect(422).then((r) => expect(r.body.code).toBe('CUSTOMER_REQUIRED'));
      await t.as(receptionist).post('/requests', { serviceId: '00000000-0000-4000-8000-00000000dead', customerId: customer.id }).expect(404);
      await t.as(receptionist).post('/requests', { serviceId: service.id, customerId: '00000000-0000-4000-8000-00000000dead' }).expect(404);
      await t.as(receptionist).post('/requests', { serviceId: service.id, customerId: customer.id, branchId: '00000000-0000-4000-8000-00000000dead' }).expect(404);
      await t.as(receptionist).post('/requests', { serviceId: 'not-a-uuid', customerId: customer.id }).expect(400);

      const inactive = await createService(t, alpha, { isActive: false });
      expect((await t.as(receptionist).post('/requests', { serviceId: inactive.id, customerId: customer.id }).expect(422)).body.code).toBe('SERVICE_NOT_AVAILABLE');
      const archived = await createCustomer(t, alpha, { status: 'ARCHIVED' });
      expect((await t.as(receptionist).post('/requests', { serviceId: service.id, customerId: archived.id }).expect(422)).body.code).toBe('CUSTOMER_NOT_ACTIVE');

      // A service offered only at another branch.
      const second = (await t.as(alpha.owner).post('/branches', { code: `S${uniq().slice(-5)}`.toUpperCase(), name: 'Second branch' }).expect(201)).body;
      const local = await createService(t, alpha, { allBranches: false, branchIds: [second.id] });
      const refused = await t.as(receptionist).post('/requests', { serviceId: local.id, customerId: customer.id }).expect(422);
      expect(refused.body).toMatchObject({ code: 'SERVICE_NOT_AT_BRANCH', message: 'This service is not offered at that branch. Choose another branch.' });
      const there = (await t.as(receptionist).post('/requests', { serviceId: local.id, customerId: customer.id, branchId: second.id }).expect(201)).body;
      expect(there.branch.id).toBe(second.id);

      // Staff limited to one branch cannot create at another, and default to their own.
      const limited = await t.addStaff(alpha, 'receptionist', { branchIds: [second.id] });
      expect((await t.as(limited).post('/requests', { serviceId: service.id, customerId: customer.id, branchId: alpha.headOfficeId }).expect(403)).body.code).toBe('BRANCH_FORBIDDEN');
      expect((await t.as(limited).post('/requests', { serviceId: service.id, customerId: customer.id }).expect(201)).body.branch.id).toBe(second.id);
      // ... and they only see requests of their branch.
      const visible = (await t.as(limited).get('/requests?pageSize=100').expect(200)).body.data;
      expect(visible.length).toBeGreaterThan(0);
      expect(visible.every((r: any) => r.branchId === second.id)).toBe(true);
      const elsewhere = await draftRequest(t, alpha, receptionist, service.id, customer.id);
      await t.as(limited).get(`/requests/${elsewhere.id}`).expect(404);
    });

    it('customers create for themselves, online services only, without staff-only fields', async () => {
      const service = await createService(t, alpha);
      const customerActor = await t.addCustomer(alpha, { fullName: 'Layla Hassan' });
      const someoneElse = await createCustomer(t, alpha);
      // customerId in the body is ignored: a customer can only ever create for themselves.
      const created = (await t.as(customerActor).post('/requests', { serviceId: service.id, customerId: someoneElse.id }).expect(201)).body;
      expect(created).toMatchObject({ status: 'DRAFT', source: 'ONLINE', priority: 'NORMAL' });
      expect(created.customer.id).toBe(customerActor.customerId);
      expect(created.branch.id).toBe(alpha.headOfficeId);
      expect(created.form.values).toEqual({ fullName: 'Layla Hassan' });
      expect((await getRequest(t, created.id)).createdByType).toBe('CUSTOMER');

      // The mobile app is recorded as its own source.
      const mobile = await t.login(customerActor.email, undefined, 'mobile', alpha.slug);
      expect((await t.as(mobile).post('/requests', { serviceId: service.id }).expect(201)).body.source).toBe('MOBILE');

      expect((await t.as(customerActor).post('/requests', { serviceId: service.id, priority: 'URGENT' }).expect(403)).body.code).toBe('STAFF_ONLY_FIELD');
      expect((await t.as(customerActor).patch(`/requests/${created.id}`, { priority: 'URGENT' }).expect(403)).body.code).toBe('STAFF_ONLY_FIELD');
      expect((await t.as(customerActor).patch(`/requests/${created.id}`, { targetDate: new Date().toISOString() }).expect(403)).body.code).toBe('STAFF_ONLY_FIELD');
      expect((await t.as(customerActor).patch(`/requests/${created.id}`, { instructions: 'Call me after 5 pm' }).expect(200)).body.customerInstructions).toBe('Call me after 5 pm');

      const counterOnly = await createService(t, alpha, { onlineAvailable: false });
      const refused = await t.as(customerActor).post('/requests', { serviceId: counterOnly.id }).expect(422);
      expect(refused.body).toMatchObject({ code: 'SERVICE_NOT_ONLINE', message: 'This service can only be requested at the centre. Please visit or contact the centre.' });
      // Staff can still create it at the counter.
      await t.as(receptionist).post('/requests', { serviceId: counterOnly.id, customerId: customerActor.customerId }).expect(201);
    });

    it('drafts are saved across devices: partial values are kept, wrong values are refused', async () => {
      const service = await createService(t, alpha);
      const customerActor = await t.addCustomer(alpha, { fullName: 'Draft Saver' });
      const id = (await t.as(customerActor).post('/requests', { serviceId: service.id }).expect(201)).body.id;
      await t.as(customerActor).put(`/requests/${id}/fields`, { values: { purpose: 'work' } }).expect(200);
      const bad = await t.as(customerActor).put(`/requests/${id}/fields`, { values: { purpose: 'holiday', hack: 'x' } }).expect(422);
      expect(bad.body.code).toBe('FORM_INVALID');
      expect(bad.body.details.map((e: any) => `${e.field}:${e.code}`).sort()).toEqual(['hack:UNKNOWN_FIELD', 'purpose:INVALID_OPTION']);
      // A second session (another device) sees the same draft.
      const laptop = await t.login(customerActor.email, undefined, 'customer', alpha.slug);
      const seen = (await t.as(laptop).get(`/requests/${id}`).expect(200)).body;
      expect(seen.form.values).toEqual({ fullName: 'Draft Saver', purpose: 'work' });
      expect(seen.form.visibleFields).toEqual(expect.arrayContaining(['sponsor']));
      // null clears a value.
      const cleared = (await t.as(laptop).put(`/requests/${id}/fields`, { values: { purpose: null, sponsor: 'ACME' } }).expect(200)).body;
      expect(cleared.form.values).toEqual({ fullName: 'Draft Saver', sponsor: 'ACME' });
      const audit = await t.sys.auditLog.findFirstOrThrow({ where: { resourceId: id, action: 'request.fields_saved' }, orderBy: { createdAt: 'desc' } });
      expect(JSON.stringify(audit.after)).not.toContain('ACME'); // field names only, never the values
    });

    it('document reuse: offered always, linked automatically only with the customer\'s consent', async () => {
      const service = await createService(t, alpha, {
        requirements: [
          { documentTypeKey: 'passport', label: 'Passport copy' },
          { documentTypeKey: 'photo', label: 'Personal photo', maxAgeDays: 180 },
          { documentTypeKey: 'emirates_id', label: 'Emirates ID' },
          { documentTypeKey: 'certificate', label: 'Fresh certificate', allowReuse: false },
        ],
      });
      const customer = await createCustomer(t, alpha);
      const other = await createCustomer(t, alpha);
      const year = 365 * 86_400_000;
      const oldPassport = await createDocument(t, alpha, { customerId: customer.id, documentTypeKey: 'passport', verified: true, expiryDate: new Date(Date.now() + year), createdAt: new Date(Date.now() - 30 * 86_400_000) });
      const passport = await createDocument(t, alpha, { customerId: customer.id, documentTypeKey: 'passport', verified: true, expiryDate: new Date(Date.now() + year) });
      await createDocument(t, alpha, { customerId: customer.id, documentTypeKey: 'photo', verified: true, createdAt: new Date(Date.now() - 200 * 86_400_000) }); // too old for this service
      await createDocument(t, alpha, { customerId: customer.id, documentTypeKey: 'emirates_id', verified: true, expiryDate: new Date(Date.now() - 86_400_000) }); // expired
      await createDocument(t, alpha, { customerId: customer.id, documentTypeKey: 'certificate', verified: true }); // reuse not allowed for this requirement
      await createDocument(t, alpha, { customerId: other.id, documentTypeKey: 'emirates_id', verified: true }); // somebody else's
      const unverified = await createDocument(t, alpha, { customerId: customer.id, documentTypeKey: 'emirates_id', verified: false });

      // No consent on file: the candidate is offered, nothing is linked.
      const first = (await t.as(receptionist).post('/requests', { serviceId: service.id, customerId: customer.id }).expect(201)).body;
      expect(first.reuseCandidates).toEqual([expect.objectContaining({ documentId: passport.id, documentTypeKey: 'passport', linked: false, checklistItemId: first.checklist[0].id })]);
      expect(first.checklist.map((l: any) => [l.status, l.document])).toEqual([['MISSING', null], ['MISSING', null], ['MISSING', null], ['MISSING', null]]);

      // Staff link it explicitly: verified documents count as verified at once.
      const linked = (await t.as(receptionist).put(`/requests/${first.id}/checklist/${first.checklist[0].id}/document`, { documentId: oldPassport.id }).expect(200)).body;
      expect(linked.checklist[0]).toMatchObject({ status: 'VERIFIED', document: { id: oldPassport.id, verificationStatus: 'VERIFIED' } });
      // An unverified document is linked as uploaded and still has to be checked.
      expect((await t.as(receptionist).put(`/requests/${first.id}/checklist/${first.checklist[2].id}/document`, { documentId: unverified.id }).expect(200)).body.checklist[2].status).toBe('UPLOADED');
      const unlinked = (await t.as(receptionist).delete(`/requests/${first.id}/checklist/${first.checklist[2].id}/document`).expect(200)).body;
      expect(unlinked.checklist[2]).toMatchObject({ status: 'MISSING', document: null });

      // What cannot be linked.
      const foreign = await createDocument(t, alpha, { customerId: other.id, documentTypeKey: 'passport', verified: true });
      await t.as(receptionist).put(`/requests/${first.id}/checklist/${first.checklist[0].id}/document`, { documentId: foreign.id }).expect(404);
      const betaDoc = await createDocument(t, beta, { customerId: (await createCustomer(t, beta)).id, documentTypeKey: 'passport', verified: true });
      await t.as(receptionist).put(`/requests/${first.id}/checklist/${first.checklist[0].id}/document`, { documentId: betaDoc.id }).expect(404);
      const expired = await createDocument(t, alpha, { customerId: customer.id, documentTypeKey: 'passport', verified: true, expiryDate: new Date(Date.now() - 86_400_000) });
      expect((await t.as(receptionist).put(`/requests/${first.id}/checklist/${first.checklist[0].id}/document`, { documentId: expired.id }).expect(422)).body.code).toBe('DOCUMENT_EXPIRED');
      const rejected = await createDocument(t, alpha, { customerId: customer.id, documentTypeKey: 'passport', rejected: true });
      expect((await t.as(receptionist).put(`/requests/${first.id}/checklist/${first.checklist[0].id}/document`, { documentId: rejected.id }).expect(422)).body.code).toBe('DOCUMENT_REJECTED');
      const scanning = await createDocument(t, alpha, { customerId: customer.id, documentTypeKey: 'passport', status: 'PENDING_SCAN' });
      expect((await t.as(receptionist).put(`/requests/${first.id}/checklist/${first.checklist[0].id}/document`, { documentId: scanning.id }).expect(422)).body.code).toBe('DOCUMENT_NOT_AVAILABLE');
      await t.as(receptionist).put(`/requests/${first.id}/checklist/00000000-0000-4000-8000-00000000dead/document`, { documentId: passport.id }).expect(404);

      // With the DOCUMENT_REUSE consent the newest valid document is linked automatically.
      await t.sys.customerConsent.create({ data: { tenantId: alpha.id, customerId: customer.id, purpose: 'DOCUMENT_REUSE', status: 'GRANTED', grantedAt: new Date() } });
      const second = (await t.as(receptionist).post('/requests', { serviceId: service.id, customerId: customer.id }).expect(201)).body;
      expect(second.reuseCandidates).toEqual([expect.objectContaining({ documentId: passport.id, linked: true })]);
      expect(second.checklist.map((l: any) => [l.label, l.status, l.document?.id ?? null])).toEqual([
        ['Passport copy', 'VERIFIED', passport.id], ['Personal photo', 'MISSING', null], ['Emirates ID', 'MISSING', null], ['Fresh certificate', 'MISSING', null],
      ]);
      // A withdrawn consent stops the automatic linking again.
      await t.sys.customerConsent.updateMany({ where: { customerId: customer.id, purpose: 'DOCUMENT_REUSE' }, data: { status: 'WITHDRAWN', withdrawnAt: new Date() } });
      const third = (await t.as(receptionist).post('/requests', { serviceId: service.id, customerId: customer.id }).expect(201)).body;
      expect(third.reuseCandidates[0].linked).toBe(false);
      expect(third.checklist[0].status).toBe('MISSING');
    });

    it('a customer can link their own documents while the request is open for them, but not replace accepted ones', async () => {
      const service = await createService(t, alpha);
      const customerActor = await t.addCustomer(alpha);
      const created = (await t.as(customerActor).post('/requests', { serviceId: service.id, fields: { purpose: 'family' } }).expect(201)).body;
      const mine = await createDocument(t, alpha, { customerId: customerActor.customerId, documentTypeKey: 'passport', verified: true });
      const another = await createDocument(t, alpha, { customerId: customerActor.customerId, documentTypeKey: 'passport' });
      const linked = (await t.as(customerActor).put(`/requests/${created.id}/checklist/${created.checklist[0].id}/document`, { documentId: mine.id }).expect(200)).body;
      expect(linked.checklist[0].status).toBe('VERIFIED');
      expect((await t.as(customerActor).put(`/requests/${created.id}/checklist/${created.checklist[0].id}/document`, { documentId: another.id }).expect(409)).body.code).toBe('DOCUMENT_ALREADY_ACCEPTED');
      expect((await t.as(customerActor).delete(`/requests/${created.id}/checklist/${created.checklist[0].id}/document`).expect(409)).body.code).toBe('DOCUMENT_ALREADY_ACCEPTED');
      await t.as(customerActor).post(`/requests/${created.id}/checklist`, { documentTypeKey: 'other', label: 'Extra' }).expect(403);
      await t.as(customerActor).post(`/requests/${created.id}/checklist/${created.checklist[1].id}/waive`, { reason: 'not needed' }).expect(403);
    });

    it('a completed-document line is never filled by a customer upload, whatever the upload event names', async () => {
      const service = await createService(t, alpha);
      const customerActor = await t.addCustomer(alpha);
      const created = (await t.as(customerActor).post('/requests', { serviceId: service.id, fields: { purpose: 'family' } }).expect(201)).body;
      const output = await t.sys.requestDocument.create({ data: { tenantId: alpha.id, requestId: created.id, documentTypeKey: 'completed_document', label: 'Issued visa', kind: 'COMPLETION', sortOrder: 99 } });
      // The documents module refuses such an upload; the engine does not trust the event either.
      const fromCustomer = await createDocument(t, alpha, { customerId: customerActor.customerId, requestId: created.id, documentTypeKey: 'completed_document' });
      for (const uploadedByType of ['CUSTOMER', 'CORPORATE']) {
        await emit(t, alpha.id, 'document.uploaded', { documentId: fromCustomer.id, versionId: fromCustomer.id, customerId: customerActor.customerId, requestId: created.id, checklistItemId: output.id, documentTypeKey: 'completed_document', uploadedByType });
        expect(await t.sys.requestDocument.findUniqueOrThrow({ where: { id: output.id } })).toMatchObject({ documentId: null, status: 'MISSING' });
      }
      const fromStaff = await createDocument(t, alpha, { customerId: customerActor.customerId, requestId: created.id, documentTypeKey: 'completed_document', isCompletionDocument: true });
      await emit(t, alpha.id, 'document.uploaded', { documentId: fromStaff.id, versionId: fromStaff.id, customerId: customerActor.customerId, requestId: created.id, checklistItemId: output.id, documentTypeKey: 'completed_document', uploadedByType: 'STAFF' });
      expect(await t.sys.requestDocument.findUniqueOrThrow({ where: { id: output.id } })).toMatchObject({ documentId: fromStaff.id, status: 'UPLOADED' });
    });

    it('a renewal request is linked to the expiry reminder it came from', async () => {
      const service = await createService(t, alpha);
      const customer = await createCustomer(t, alpha);
      const visa = await createDocument(t, alpha, { customerId: customer.id, documentTypeKey: 'residence_visa', verified: true, expiryDate: new Date(Date.now() + 20 * 86_400_000) });
      const schedule = await t.sys.reminderSchedule.create({ data: { tenantId: alpha.id, customerId: customer.id, documentId: visa.id, documentTypeKey: 'residence_visa', subjectLabel: 'Residence visa', expiryDate: visa.expiryDate! } });
      const foreign = await t.sys.reminderSchedule.create({ data: { tenantId: alpha.id, customerId: (await createCustomer(t, alpha)).id, documentTypeKey: 'passport', subjectLabel: 'Passport', expiryDate: new Date(Date.now() + 86_400_000) } });
      await t.as(receptionist).post('/requests', { serviceId: service.id, customerId: customer.id, renewalOfScheduleId: foreign.id }).expect(404);
      const created = (await t.as(receptionist).post('/requests', { serviceId: service.id, customerId: customer.id, renewalOfScheduleId: schedule.id }).expect(201)).body;
      expect(created.renewalOfDocumentId).toBe(visa.id);
      expect((await t.sys.reminderSchedule.findUniqueOrThrow({ where: { id: schedule.id } })).renewalRequestId).toBe(created.id);
      expect((await t.sys.reminderSchedule.findUniqueOrThrow({ where: { id: foreign.id } })).renewalRequestId).toBeNull();
    });
  });

  // =====================================================================================
  describe('centre settings', () => {
    let gamma: TenantFixture;
    let skilled: Actor;
    let busy: Actor;
    let fresh: Actor;
    beforeAll(async () => {
      gamma = await t.createTenant({ name: 'Gamma Typing' });
      skilled = await t.addStaff(gamma, 'operator');
      busy = await t.addStaff(gamma, 'operator');
      fresh = await t.addStaff(gamma, 'operator');
    });

    it('request number prefix and default target time come from the centre settings', async () => {
      const service = await createService(t, gamma, { estimatedProcessingHours: null });
      const customer = await createCustomer(t, gamma);
      const first = await submittedRequest(t, gamma, gamma.owner, service.id, customer.id);
      expect(first.requestNo).toMatch(/^TE-\d{6}$/);
      // Neither the service nor the centre says how long it takes: 72 hours.
      expect(new Date(first.targetDate).getTime() - new Date(first.submittedAt).getTime()).toBe(72 * 3_600_000);

      await t.as(gamma.owner).patch('/tenant/settings', { requestNumberPrefix: 'gam', defaultTargetHours: 24 }).expect(200);
      const second = await submittedRequest(t, gamma, gamma.owner, service.id, customer.id);
      expect(second.requestNo).toMatch(/^GAM-\d{6}$/);
      expect(Number(second.requestNo.slice(4))).toBe(Number(first.requestNo.slice(3)) + 1); // one gap-free sequence
      expect(new Date(second.targetDate).getTime() - new Date(second.submittedAt).getTime()).toBe(24 * 3_600_000);
      // The service's own estimate wins over the centre default, and a target date set by staff is kept.
      const quick = await createService(t, gamma, { estimatedProcessingHours: 2 });
      const third = await submittedRequest(t, gamma, gamma.owner, quick.id, customer.id);
      expect(new Date(third.targetDate).getTime() - new Date(third.submittedAt).getTime()).toBe(2 * 3_600_000);
      const promised = new Date(Date.now() + 10 * 86_400_000).toISOString();
      const fourth = await submittedRequest(t, gamma, gamma.owner, quick.id, customer.id, { targetDate: promised });
      expect(fourth.targetDate).toBe(promised);
    });

    it('automatic assignment: skilled staff first, then the lowest workload; recorded as AUTO', async () => {
      // Both services are handled by the operators' staff group.
      const service = await createService(t, gamma, { staffGroupRoleKey: 'operator' });
      const other = await createService(t, gamma, { staffGroupRoleKey: 'operator' });
      const customer = await createCustomer(t, gamma);
      await t.sys.staffSkill.create({ data: { tenantId: gamma.id, membershipId: skilled.membershipId!, serviceId: service.id } });

      // Off by default: nothing is assigned at submission.
      const manual = await submittedRequest(t, gamma, gamma.owner, service.id, customer.id);
      expect((await getRequest(t, manual.id)).assignedToId).toBeNull();
      // On request, the best candidate is chosen and the choice is explained.
      const chosen = (await t.as(gamma.owner).post(`/requests/${manual.id}/auto-assign`).expect(200)).body;
      expect(chosen.assignee.membershipId).toBe(skilled.membershipId);
      expect(chosen.autoAssignment).toMatchObject({ considered: 3, chosen: { membershipId: skilled.membershipId, hasSkill: true } });
      expect(chosen.assignments[0]).toMatchObject({ method: 'AUTO', role: 'OPERATOR' });
      expect((await t.as(gamma.owner).post(`/requests/${manual.id}/auto-assign`).expect(409)).body.code).toBe('ALREADY_ASSIGNED');

      await t.as(gamma.owner).patch('/tenant/settings', { autoAssign: true }).expect(200);
      // For a service nobody is specially skilled in, the workload decides (urgent work weighs more).
      const urgent = await submittedRequest(t, gamma, gamma.owner, other.id, customer.id, { priority: 'URGENT' });
      const firstPick = (await getRequest(t, urgent.id)).assignedToId!;
      expect([busy.membershipId, fresh.membershipId]).toContain(firstPick); // "skilled" already carries a case
      const next = await submittedRequest(t, gamma, gamma.owner, other.id, customer.id);
      const secondPick = (await getRequest(t, next.id)).assignedToId!;
      expect([busy.membershipId, fresh.membershipId]).toContain(secondPick);
      expect(secondPick).not.toBe(firstPick);
      // Now: skilled = 1 (normal), firstPick = 3 (urgent), secondPick = 1 (normal).
      // Another unskilled case goes to one of the two with the lowest load, never to the one with the urgent case.
      const fourth = await submittedRequest(t, gamma, gamma.owner, other.id, customer.id);
      expect([skilled.membershipId, secondPick]).toContain((await getRequest(t, fourth.id)).assignedToId);
      // The skilled service goes to the skilled operator even if others carry less.
      await t.sys.serviceRequest.updateMany({ where: { tenantId: gamma.id, assignedToId: skilled.membershipId }, data: { priority: 'URGENT' } });
      const third = await submittedRequest(t, gamma, gamma.owner, service.id, customer.id);
      expect((await getRequest(t, third.id)).assignedToId).toBe(skilled.membershipId);
      const event = (await eventsOf(t, gamma.id, third.id, 'request.assigned'))[0];
      expect(event.payload).toMatchObject({ method: 'AUTO', role: 'OPERATOR', assigneeMembershipId: skilled.membershipId, assigneeUserId: skilled.userId });
      expect(await t.sys.requestAssignment.findFirstOrThrow({ where: { requestId: third.id } })).toMatchObject({ method: 'AUTO', unassignedAt: null, assignedById: gamma.owner.userId });

      // Staff who are marked unavailable are not considered; with nobody left the request stays unassigned.
      await t.sys.tenantMembership.updateMany({ where: { tenantId: gamma.id, id: { in: [skilled.membershipId!, busy.membershipId!, fresh.membershipId!] } }, data: { isAvailable: false } });
      const unassigned = await submittedRequest(t, gamma, gamma.owner, service.id, customer.id);
      expect(unassigned.status).toBe('SUBMITTED');
      expect((await getRequest(t, unassigned.id)).assignedToId).toBeNull();
      const none = await t.as(gamma.owner).post(`/requests/${unassigned.id}/auto-assign`).expect(422);
      expect(none.body).toMatchObject({ code: 'NO_ASSIGNEE_AVAILABLE', message: 'Nobody suitable is available for this request right now. Assign it manually.' });
      // A service without a staff group can go to anybody whose role may process requests - here, the owner.
      const open = await createService(t, gamma);
      const fallback = await submittedRequest(t, gamma, gamma.owner, open.id, customer.id);
      expect((await getRequest(t, fallback.id)).assignedToId).toBe(gamma.owner.membershipId);
    });

    it('automatic assignment respects the staff group of the service and who is on shift', async () => {
      const delta = await t.createTenant({ name: 'Delta Typing' });
      const onShift = await t.addStaff(delta, 'operator');
      const offShift = await t.addStaff(delta, 'operator');
      const customer = await createCustomer(t, delta);
      const now = new Date();
      const dubai = new Date(now.getTime() + 4 * 3_600_000); // Asia/Dubai is UTC+4, no daylight saving
      const weekday = dubai.getUTCDay();
      await t.sys.staffSchedule.create({ data: { tenantId: delta.id, membershipId: onShift.membershipId!, branchId: delta.headOfficeId, weekday, startTime: '00:00', endTime: '23:59' } });
      await t.sys.staffSchedule.create({ data: { tenantId: delta.id, membershipId: offShift.membershipId!, branchId: delta.headOfficeId, weekday: (weekday + 3) % 7, startTime: '09:00', endTime: '17:00' } });
      // Only operators belong to the staff group of this service: the owner (no schedule, no workload) is not a candidate.
      const service = await createService(t, delta, { staffGroupRoleKey: 'operator' });
      const request = await submittedRequest(t, delta, delta.owner, service.id, customer.id);
      const result = (await t.as(delta.owner).post(`/requests/${request.id}/auto-assign`).expect(200)).body;
      expect(result.autoAssignment).toMatchObject({ considered: 2, chosen: { membershipId: onShift.membershipId, hasSchedule: true, onShift: true } });
    });
  });

  // =====================================================================================
  describe('roles', () => {
    let request: { id: string; requestNo: string };
    beforeAll(async () => {
      const service = await createService(t, alpha);
      request = await readyRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
    });

    it('a receptionist starts requests but cannot assign, process, review, submit or cancel them', async () => {
      await t.as(receptionist).get(`/requests/${request.id}`).expect(200);
      await assign(request.id, operator, 'OPERATOR', receptionist).expect(403);
      await t.as(receptionist).post(`/requests/${request.id}/auto-assign`).expect(403);
      await move(receptionist, request.id, 'IN_PREPARATION').expect(403);
      await t.as(receptionist).post(`/requests/${request.id}/workflow/complete-step`, {}).expect(403);
      await t.as(receptionist).post(`/requests/${request.id}/external-references`, { channel: 'MANUAL_PORTAL', referenceNo: 'X-1' }).expect(403);
      await t.as(receptionist).post(`/requests/${request.id}/external-result`, { outcome: 'COMPLETED' }).expect(403);
      await t.as(receptionist).post(`/requests/${request.id}/complete`).expect(403);
      await t.as(receptionist).post(`/requests/${request.id}/cancel`, { reason: 'no permission' }).expect(403);
      await t.as(receptionist).post(`/requests/${request.id}/reopen`, { reason: 'no permission' }).expect(403);
      await t.as(receptionist).post(`/requests/${request.id}/workflow/migrate`).expect(403);
      expect(await statusOf(t, request.id)).toBe('READY_FOR_PROCESSING');
      const view = (await t.as(receptionist).get(`/requests/${request.id}`).expect(200)).body;
      expect(view.allowedActions.transitions).toEqual([]);
      expect(view.allowedActions.other).toEqual(expect.arrayContaining(['edit_fields', 'edit_details', 'comment', 'comment_internal']));
      expect(view.allowedActions.other).not.toEqual(expect.arrayContaining(['assign']));
    });

    it('an accountant can read requests but not create or change them', async () => {
      await t.as(accountant).get(`/requests/${request.id}`).expect(200);
      await t.as(accountant).get('/requests').expect(200);
      const service = await createService(t, alpha);
      await t.as(accountant).post('/requests', { serviceId: service.id, customerId: (await createCustomer(t, alpha)).id }).expect(403);
      await t.as(accountant).patch(`/requests/${request.id}`, { priority: 'HIGH' }).expect(403);
      await t.as(accountant).put(`/requests/${request.id}/fields`, { values: { purpose: 'work' } }).expect(403);
      await t.as(accountant).post(`/requests/${request.id}/comments`, { body: 'hello', visibility: 'INTERNAL' }).expect(403);
      await move(accountant, request.id, 'CANCELLED', { reason: 'no' }).expect(403);
    });

    it('an operator only sees and touches the requests assigned to them', async () => {
      const service = await createService(t, alpha, { requiresApproval: true });
      const mine = await readyRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha, { fullName: 'Visible Customer' })).id);
      const theirs = await readyRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha, { fullName: 'Hidden Customer' })).id);
      await assign(mine.id, operator).expect(200);
      await assign(theirs.id, operator2).expect(200);

      const list = (await t.as(operator).get('/requests?pageSize=100').expect(200)).body;
      expect(list.data.map((r: any) => r.id)).toContain(mine.id);
      expect(list.data.map((r: any) => r.id)).not.toContain(theirs.id);
      expect(list.data.map((r: any) => r.id)).not.toContain(request.id); // unassigned
      expect(list.data.every((r: any) => r.assignee?.membershipId === operator.membershipId)).toBe(true);
      const counts = (await t.as(operator).get('/requests/counts').expect(200)).body;
      expect(counts.open).toBe(list.meta.total);
      expect((await t.as(operator).get(`/requests?q=Hidden`).expect(200)).body.data).toEqual([]);

      await t.as(operator).get(`/requests/${theirs.id}`).expect(404);
      await t.as(operator).get(`/requests/${theirs.id}/comments`).expect(404);
      await t.as(operator).get(`/requests/${theirs.id}/external-references`).expect(404);
      await move(operator, theirs.id, 'IN_PREPARATION').expect(404);
      await t.as(operator).put(`/requests/${theirs.id}/fields`, { values: { purpose: 'work' } }).expect(404);
      await t.as(operator).post(`/requests/${theirs.id}/comments`, { body: 'peek', visibility: 'INTERNAL' }).expect(404);
      await t.as(operator).post(`/requests/${theirs.id}/request-information`, { message: 'Send me your documents' }).expect(404);
      await t.as(operator).post(`/requests/${theirs.id}/workflow/complete-step`, {}).expect(404);
      await t.as(operator).post(`/requests/${theirs.id}/external-result`, { outcome: 'COMPLETED' }).expect(404);
      expect(await statusOf(t, theirs.id)).toBe('READY_FOR_PROCESSING');

      // An operator cannot review: neither their own case nor anybody else's.
      await move(operator, mine.id, 'IN_PREPARATION').expect(200);
      await move(operator, mine.id, 'PENDING_APPROVAL').expect(200);
      const approval = await t.sys.requestApproval.findFirstOrThrow({ where: { requestId: mine.id } });
      await t.as(operator).post(`/requests/${mine.id}/approvals/${approval.id}/decide`, { decision: 'APPROVED' }).expect(403);
      await move(operator, mine.id, 'READY_TO_SUBMIT').expect(403);
      await t.as(operator2).post(`/requests/${mine.id}/approvals/${approval.id}/decide`, { decision: 'APPROVED' }).expect(403);
      expect(await statusOf(t, mine.id)).toBe('PENDING_APPROVAL');
      // A reviewer assigned to the case sees it through "assigned" as well as "all".
      await t.as(reviewer).post(`/requests/${mine.id}/approvals/${approval.id}/decide`, { decision: 'APPROVED' }).expect(200);
    });

    it('internal notes are for staff with the permission; customer-visible comments reach the customer', async () => {
      const service = await createService(t, alpha);
      const customerActor = await t.addCustomer(alpha);
      const id = (await t.as(customerActor).post('/requests', { serviceId: service.id, fields: { purpose: 'family' } }).expect(201)).body.id;
      await t.as(customerActor).post(`/requests/${id}/submit`).expect(200);
      await t.as(receptionist).post(`/requests/${id}/comments`, { body: 'INTERNAL-NOTE: customer seemed unsure' }).expect(201); // INTERNAL is the default for staff
      await t.as(receptionist).post(`/requests/${id}/comments`, { body: 'We received your request.', visibility: 'CUSTOMER' }).expect(201);
      // Whatever a customer sends is a customer-visible comment.
      const mine = (await t.as(customerActor).post(`/requests/${id}/comments`, { body: 'Thank you!', visibility: 'INTERNAL' }).expect(201)).body;
      expect(mine).toMatchObject({ visibility: 'CUSTOMER', authorType: 'CUSTOMER' });
      await t.as(customerActor).post(`/requests/${id}/comments`, { body: '' }).expect(400);

      expect((await t.as(receptionist).get(`/requests/${id}/comments`).expect(200)).body.map((c: any) => c.visibility)).toEqual(['INTERNAL', 'CUSTOMER', 'CUSTOMER']);
      const seen = (await t.as(customerActor).get(`/requests/${id}/comments`).expect(200)).body;
      expect(seen.map((c: any) => c.body)).toEqual(['We received your request.', 'Thank you!']);
      expect(JSON.stringify((await t.as(customerActor).get(`/requests/${id}`).expect(200)).body)).not.toContain('INTERNAL-NOTE');
      // Staff without request.comment.internal do not see internal notes either.
      expect((await t.as(accountant).get(`/requests/${id}/comments`).expect(200)).body.map((c: any) => c.visibility)).toEqual(['CUSTOMER', 'CUSTOMER']);
      expect(JSON.stringify((await t.as(accountant).get(`/requests/${id}`).expect(200)).body.comments)).not.toContain('INTERNAL-NOTE');
    });

    it('customers and company users see who answered by first name only; staff keep seeing full names', async () => {
      const service = await createService(t, alpha);
      const account = await createCorporateAccount(t, alpha);
      const employee = await createCustomer(t, alpha, { corporateAccountId: account.id });
      const admin = await addCorporateUser(t, alpha, account.id, 'corporate_admin');
      const customerActor = await t.addCustomer(alpha, { fullName: 'Fatima Al Mansoori' });
      // Real-looking names, as staff have them.
      await t.sys.user.update({ where: { id: receptionist.userId }, data: { fullName: 'Dr. Abdul Rahman Al Farsi' } });
      await t.sys.user.update({ where: { id: manager.userId }, data: { fullName: 'Noura Khalid Al Suwaidi' } });
      try {
        for (const [owner, requestBody] of [[customerActor, { serviceId: service.id, fields: { purpose: 'family' } }], [admin, { serviceId: service.id, customerId: employee.id, fields: { purpose: 'family' } }]] as const) {
          const id = (await t.as(owner).post('/requests', requestBody).expect(201)).body.id;
          await t.as(owner).post(`/requests/${id}/submit`).expect(200);
          const first = (await t.as(receptionist).post(`/requests/${id}/comments`, { body: 'We received your request.', visibility: 'CUSTOMER' }).expect(201)).body;
          // The author gets their own comment back as staff see it.
          expect(first).toMatchObject({ authorType: 'STAFF', authorKind: 'STAFF', authorName: 'Dr. Abdul Rahman Al Farsi' });
          await t.as(manager).post(`/requests/${id}/comments`, { body: 'Your documents look complete.', visibility: 'CUSTOMER' }).expect(201);
          await t.as(manager).post(`/requests/${id}/comments`, { body: 'INTERNAL-NOTE: call Noura if in doubt' }).expect(201);
          const own = (await t.as(owner).post(`/requests/${id}/comments`, { body: 'Thank you!' }).expect(201)).body;
          expect(own).toMatchObject({ authorKind: 'CUSTOMER', visibility: 'CUSTOMER' });
          expect(own.authorName).toBeTruthy();

          const expected = [
            { authorType: 'STAFF', authorKind: 'STAFF', authorName: 'Abdul Rahman', body: 'We received your request.' },
            { authorType: 'STAFF', authorKind: 'STAFF', authorName: 'Noura', body: 'Your documents look complete.' },
            { authorType: own.authorType, authorKind: 'CUSTOMER', authorName: own.authorName, body: 'Thank you!' },
          ];
          const pick = (rows: any[]) => rows.map((c) => ({ authorType: c.authorType, authorKind: c.authorKind, authorName: c.authorName, body: c.body }));
          // The same in the comment list and inside the request.
          const list = (await t.as(owner).get(`/requests/${id}/comments`).expect(200)).body;
          const detail = (await t.as(owner).get(`/requests/${id}`).expect(200)).body;
          expect(pick(list)).toEqual(expected);
          expect(pick(detail.comments)).toEqual(expected);
          // Nothing else in what they receive carries the family name, the title or the role of a staff member.
          for (const text of [JSON.stringify(list), JSON.stringify(detail)]) {
            expect(text).not.toMatch(/Al Farsi|Al Suwaidi|Khalid|Dr\.|receptionist|manager|INTERNAL-NOTE/);
          }
          // Staff see the full names and every note.
          const staffView = (await t.as(manager).get(`/requests/${id}/comments`).expect(200)).body;
          expect(staffView.map((c: any) => [c.authorType, c.authorKind, c.authorName])).toEqual([
            ['STAFF', 'STAFF', 'Dr. Abdul Rahman Al Farsi'], ['STAFF', 'STAFF', 'Noura Khalid Al Suwaidi'], ['STAFF', 'STAFF', 'Noura Khalid Al Suwaidi'], [own.authorType, 'CUSTOMER', own.authorName],
          ]);
          expect((await t.as(manager).get(`/requests/${id}`).expect(200)).body.comments.map((c: any) => c.authorName)).toContain('Dr. Abdul Rahman Al Farsi');
          // What is stored is unchanged: the full name stays on record for the centre.
          expect(await t.sys.requestComment.count({ where: { requestId: id, authorName: 'Dr. Abdul Rahman Al Farsi' } })).toBe(1);
        }
      } finally {
        await t.sys.user.update({ where: { id: receptionist.userId }, data: { fullName: 'receptionist staff' } });
        await t.sys.user.update({ where: { id: manager.userId }, data: { fullName: 'manager staff' } });
      }
    });
  });

  // =====================================================================================
  describe('customers and companies', () => {
    it('a customer only reaches their own requests and never sees internals', async () => {
      const service = await createService(t, alpha, { requiresApproval: true });
      const owner = await t.addCustomer(alpha, { fullName: 'Request Owner' });
      const stranger = await t.addCustomer(alpha, { fullName: 'Curious Stranger' });
      const id = (await t.as(owner).post('/requests', { serviceId: service.id, fields: { purpose: 'family' } }).expect(201)).body.id;
      await t.as(owner).post(`/requests/${id}/submit`).expect(200);
      await completeDocuments(t, alpha, id);
      const { invoice } = await approveQuotation(t, alpha, (await sendQuotation(t, alpha, id, 640)).id);
      await payInvoice(t, alpha, invoice!.id);
      await assign(id, operator).expect(200);
      await assign(id, reviewer, 'REVIEWER').expect(200);
      await move(operator, id, 'IN_PREPARATION').expect(200);
      await move(operator, id, 'PENDING_APPROVAL').expect(200);
      const approval = await t.sys.requestApproval.findFirstOrThrow({ where: { requestId: id } });
      await t.as(reviewer).post(`/requests/${id}/approvals/${approval.id}/decide`, { decision: 'REJECTED', comment: 'SECRET-REVIEW-COMMENT wrong category' }).expect(200);
      await t.as(operator).post(`/requests/${id}/comments`, { body: 'SECRET-INTERNAL-NOTE', visibility: 'INTERNAL' }).expect(201);

      // The stranger: nothing exists.
      for (const res of [
        await t.as(stranger).get(`/requests/${id}`),
        await t.as(stranger).get(`/requests/${id}/comments`),
        await t.as(stranger).get(`/requests/${id}/external-references`),
        await t.as(stranger).patch(`/requests/${id}`, { instructions: 'mine now' }),
        await t.as(stranger).put(`/requests/${id}/fields`, { values: { purpose: 'work' } }),
        await t.as(stranger).post(`/requests/${id}/submit`),
        await t.as(stranger).post(`/requests/${id}/cancel`, { reason: 'not mine' }),
        await t.as(stranger).post(`/requests/${id}/resubmit`, {}),
        await t.as(stranger).post(`/requests/${id}/comments`, { body: 'hello' }),
        await t.as(stranger).put(`/requests/${id}/checklist/${(await checklistOf(t, id))[0].id}/document`, { documentId: '00000000-0000-4000-8000-00000000dead' }),
      ]) {
        expect(res.status).toBe(404);
      }
      expect((await t.as(stranger).get('/requests').expect(200)).body.data).toEqual([]);
      expect((await t.as(stranger).get('/requests/counts').expect(200)).body.open).toBe(0);
      // Filters cannot widen the scope.
      expect((await t.as(stranger).get(`/requests?customerId=${owner.customerId}`).expect(200)).body.data).toEqual([]);

      // The owner: their request, in customer wording, without internals.
      const list = (await t.as(owner).get('/requests').expect(200)).body;
      expect(list.data.map((r: any) => r.id)).toEqual([id]);
      expect(list.data[0]).toMatchObject({ statusLabel: { en: 'Being prepared' }, paymentStatus: 'PAID' });
      expect(list.data[0].assignee).toBeUndefined();
      const view = (await t.as(owner).get(`/requests/${id}`).expect(200)).body;
      const text = JSON.stringify(view);
      expect(view.status).toBe('IN_PREPARATION');
      expect(view.statusLabel).toEqual({ en: 'Being prepared', ar: 'قيد التحضير' });
      for (const hidden of ['assignee', 'reviewer', 'assignments', 'approvals', 'cancellationReason', 'workflowVersionId', 'reopenedCount']) expect(view).not.toHaveProperty(hidden);
      expect(text).not.toContain('SECRET-REVIEW-COMMENT');
      expect(text).not.toContain('SECRET-INTERNAL-NOTE');
      expect(text).not.toContain(operator.email);
      expect(text).not.toMatch(/"reason"/);
      // History: only what concerns the customer, in customer wording. The internal review round trip is invisible.
      expect(view.history.map((h: any) => h.status)).toEqual(['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'QUOTED', 'AWAITING_PAYMENT', 'READY_FOR_PROCESSING', 'IN_PREPARATION']);
      expect(Object.keys(view.history[0]).sort()).toEqual(['at', 'id', 'message', 'status', 'statusLabel']);
      // Workflow: customer-visible steps only, no deadlines, roles or blockers.
      expect(view.workflow.steps.map((s: any) => s.key)).not.toContain('review');
      expect(Object.keys(view.workflow.steps[0]).sort()).toEqual(['completedAt', 'current', 'key', 'name', 'nameAr', 'position', 'startedAt', 'status', 'type']);
      expect(view.service).toEqual({ id: service.id, name: service.name, nameAr: service.nameAr, code: service.code });
      // Their own money is visible to them.
      expect(view.finance.totals).toMatchObject({ invoiced: '640.00', paid: '640.00', balance: '0.00' });
      // The staff view of the same request has all of it.
      const staff = (await t.as(manager).get(`/requests/${id}`).expect(200)).body;
      expect(JSON.stringify(staff)).toContain('SECRET-REVIEW-COMMENT');
      expect(staff.history.map((h: any) => h.to)).toEqual(expect.arrayContaining(['PENDING_APPROVAL']));
      expect(staff.assignee.name).toBeTruthy();
    });

    it('corporate admins act for their company only; employees see only their own record', async () => {
      const service = await createService(t, alpha);
      const acme = await createCorporateAccount(t, alpha);
      const globex = await createCorporateAccount(t, alpha);
      const worker = await createCustomer(t, alpha, { fullName: 'Acme Worker', corporateAccountId: acme.id });
      const colleague = await createCustomer(t, alpha, { fullName: 'Acme Colleague', corporateAccountId: acme.id });
      const globexWorker = await createCustomer(t, alpha, { fullName: 'Globex Worker', corporateAccountId: globex.id });
      const employee = await t.sys.corporateEmployee.create({ data: { tenantId: alpha.id, corporateAccountId: acme.id, customerId: worker.id, status: 'ACTIVE' } });
      const employee2 = await t.sys.corporateEmployee.create({ data: { tenantId: alpha.id, corporateAccountId: acme.id, customerId: colleague.id, status: 'ACTIVE' } });
      const globexEmployee = await t.sys.corporateEmployee.create({ data: { tenantId: alpha.id, corporateAccountId: globex.id, customerId: globexWorker.id, status: 'ACTIVE' } });
      const acmeAdmin = await addCorporateUser(t, alpha, acme.id, 'corporate_admin');
      const globexAdmin = await addCorporateUser(t, alpha, globex.id, 'corporate_admin');
      const workerUser = await addCorporateUser(t, alpha, acme.id, 'corporate_employee', { customerId: worker.id, corporateEmployeeId: employee.id });

      // For an employee of the company.
      const forWorker = (await t.as(acmeAdmin).post('/requests', { serviceId: service.id, corporateEmployeeId: employee.id, fields: { purpose: 'work', sponsor: 'Acme' } }).expect(201)).body;
      expect(forWorker).toMatchObject({ status: 'DRAFT', source: 'CORPORATE', corporateAccount: { id: acme.id }, customer: { id: worker.id } });
      const forColleague = (await t.as(acmeAdmin).post('/requests', { serviceId: service.id, customerId: colleague.id, fields: { purpose: 'family' } }).expect(201)).body;
      expect(forColleague.customer.id).toBe(colleague.id);
      void employee2;
      // Not for another company's people, and not for arbitrary customers.
      await t.as(acmeAdmin).post('/requests', { serviceId: service.id, corporateEmployeeId: globexEmployee.id }).expect(404);
      await t.as(acmeAdmin).post('/requests', { serviceId: service.id, customerId: globexWorker.id }).expect(404);
      await t.as(acmeAdmin).post('/requests', { serviceId: service.id, customerId: (await createCustomer(t, alpha)).id }).expect(404);
      // For the company itself: needs the company's own customer profile.
      expect((await t.as(acmeAdmin).post('/requests', { serviceId: service.id }).expect(422)).body.code).toBe('COMPANY_PROFILE_MISSING');
      const companyProfile = await createCustomer(t, alpha, { fullName: 'Acme LLC', type: 'BUSINESS', corporateAccountId: acme.id });
      const forCompany = (await t.as(acmeAdmin).post('/requests', { serviceId: service.id, fields: { purpose: 'family' } }).expect(201)).body;
      expect(forCompany.customer.id).toBe(companyProfile.id);
      // A suspended company cannot create requests.
      await t.sys.corporateAccount.update({ where: { id: globex.id }, data: { status: 'SUSPENDED' } });
      expect((await t.as(globexAdmin).post('/requests', { serviceId: service.id, corporateEmployeeId: globexEmployee.id }).expect(422)).body.code).toBe('CORPORATE_ACCOUNT_INACTIVE');
      await t.sys.corporateAccount.update({ where: { id: globex.id }, data: { status: 'ACTIVE' } });
      const globexRequest = (await t.as(globexAdmin).post('/requests', { serviceId: service.id, corporateEmployeeId: globexEmployee.id, fields: { purpose: 'family' } }).expect(201)).body;

      // The admin sees the company's requests, submits and cancels them, and nothing of the other company.
      const list = (await t.as(acmeAdmin).get('/requests?sort=createdAt:asc').expect(200)).body.data;
      expect(list.map((r: any) => r.id)).toEqual([forWorker.id, forColleague.id, forCompany.id]);
      await t.as(acmeAdmin).get(`/requests/${globexRequest.id}`).expect(404);
      await t.as(acmeAdmin).post(`/requests/${globexRequest.id}/submit`).expect(404);
      await t.as(acmeAdmin).post(`/requests/${globexRequest.id}/cancel`, { reason: 'sabotage' }).expect(404);
      const submitted = (await t.as(acmeAdmin).post(`/requests/${forWorker.id}/submit`).expect(200)).body;
      expect(submitted.status).toBe('SUBMITTED');
      expect(submitted).not.toHaveProperty('assignments');
      await t.as(acmeAdmin).post(`/requests/${forColleague.id}/cancel`, { reason: 'Employee left the company' }).expect(200);
      // A personal request of the worker (walk-in, not billed to the company) is not the company's business.
      const personal = await draftRequest(t, alpha, receptionist, service.id, worker.id);
      await t.as(acmeAdmin).get(`/requests/${personal.id}`).expect(404);

      // The employee sees their own record's requests - company-paid and personal - and nobody else's.
      const own = (await t.as(workerUser).get('/requests').expect(200)).body.data.map((r: any) => r.id).sort();
      expect(own).toEqual([forWorker.id, personal.id].sort());
      await t.as(workerUser).get(`/requests/${forColleague.id}`).expect(404);
      // Amounts are shown to those who pay: the company's administrator sees them, the employee sees only where things stand.
      expect((await t.as(workerUser).get(`/requests/${forWorker.id}`).expect(200)).body.finance).toEqual({ amountsHidden: true, quotation: null, invoices: [], totals: null });
      expect((await t.as(acmeAdmin).get(`/requests/${forWorker.id}`).expect(200)).body.finance.totals).toEqual({ invoiced: '0.00', paid: '0.00', refunded: '0.00', balance: '0.00' });
      expect((await t.as(reviewer).get(`/requests/${forWorker.id}`).expect(200)).body.finance).toBeNull(); // a reviewer has no finance permission
      expect((await t.as(receptionist).get(`/requests/${forWorker.id}`).expect(200)).body.finance).not.toBeNull();
      await t.as(workerUser).get(`/requests/${forCompany.id}`).expect(404);
      // An employee creating a request in the corporate portal does so for themselves, as a request of the company
      // (contract prices, the company's administrators see and pay it); nobody else can be named.
      expect((await t.as(workerUser).post('/requests', { serviceId: service.id, customerId: colleague.id }).expect(403)).body.code).toBe('EMPLOYEE_SELF_ONLY');
      const self = (await t.as(workerUser).post('/requests', { serviceId: service.id }).expect(201)).body;
      expect(self.customer.id).toBe(worker.id);
      expect(await getRequest(t, self.id)).toMatchObject({ corporateAccountId: acme.id, source: 'CORPORATE' });
      await t.as(acmeAdmin).get(`/requests/${self.id}`).expect(200);
      // Staff creating for a company must name somebody who belongs to it.
      expect((await t.as(receptionist).post('/requests', { serviceId: service.id, customerId: globexWorker.id, corporateAccountId: acme.id }).expect(422)).body.code).toBe('CUSTOMER_NOT_IN_COMPANY');
      await t.as(receptionist).post('/requests', { serviceId: service.id, customerId: worker.id, corporateAccountId: '00000000-0000-4000-8000-00000000dead' }).expect(404);
    });
  });

  // =====================================================================================
  describe('lists and dashboard counts', () => {
    let delta: TenantFixture;
    let deltaOperator: Actor;
    const ids: Record<string, string> = {};
    beforeAll(async () => {
      delta = await t.createTenant({ name: 'Delta Lists' });
      deltaOperator = await t.addStaff(delta, 'operator');
      const visa = await createService(t, delta, { name: 'Visa stamping' });
      const typing = await createService(t, delta, { name: 'Letter typing' });
      const ali = await createCustomer(t, delta, { fullName: 'Ali Mansour' });
      const sara = await createCustomer(t, delta, { fullName: 'Sara Qasim' });
      const make = async (key: string, serviceId: string, customerId: string, status: string, extra: Record<string, unknown> = {}, body: Record<string, unknown> = {}) => {
        const request = await submittedRequest(t, delta, delta.owner, serviceId, customerId, body);
        await forceStatus(t, request.id, status as any, extra);
        ids[key] = request.id;
      };
      const hour = 3_600_000;
      await make('new', visa.id, ali.id, 'SUBMITTED');
      await make('review', visa.id, sara.id, 'UNDER_REVIEW', {}, { priority: 'URGENT' });
      await make('awaiting', typing.id, ali.id, 'AWAITING_CUSTOMER');
      await make('quoted', typing.id, sara.id, 'QUOTED');
      await make('payment', visa.id, ali.id, 'AWAITING_PAYMENT');
      await make('ready', visa.id, sara.id, 'READY_FOR_PROCESSING');
      await make('prep', visa.id, ali.id, 'IN_PREPARATION', { assignedToId: deltaOperator.membershipId, targetDate: new Date(Date.now() - hour) });
      await make('external', visa.id, sara.id, 'EXTERNAL_PROCESSING', { assignedToId: deltaOperator.membershipId, externalStatus: 'Under process', externalStatusSource: 'STAFF_ENTERED', externalStatusAt: new Date() });
      await make('doneToday', typing.id, ali.id, 'COMPLETED', { completedAt: new Date() });
      await make('doneEarlier', typing.id, sara.id, 'COMPLETED', { completedAt: new Date(Date.now() - 5 * 86_400_000), targetDate: new Date(Date.now() - 6 * 86_400_000) });
      await make('cancelled', visa.id, ali.id, 'CANCELLED', { targetDate: new Date(Date.now() - hour) });
      ids.draft = (await draftRequest(t, delta, delta.owner, visa.id, sara.id)).id;
      await t.sys.requestExternalReference.create({ data: { tenantId: delta.id, requestId: ids.external, channel: 'MANUAL_PORTAL', referenceNo: 'MOHRE-778899', status: 'Under process', statusSource: 'STAFF_ENTERED' } });
      ids.visa = visa.id;
      ids.ali = ali.id;
    });
    const listed = async (query: string, actor: Actor = delta.owner) => (await t.as(actor).get(`/requests?pageSize=100&sort=createdAt:asc&${query}`).expect(200)).body.data.map((r: any) => Object.keys(ids).find((k) => ids[k] === r.id));

    it('counts per bucket use real queries over the visible requests', async () => {
      const counts = (await t.as(delta.owner).get('/requests/counts').expect(200)).body;
      expect(counts.buckets).toEqual({ newRequests: 1, pendingVerification: 1, awaitingCustomer: 2, awaitingPayment: 1, readyForProcessing: 1, inProgress: 2, completedToday: 1, overdue: 1 });
      expect(counts).toMatchObject({ open: 8, drafts: 1 });
      expect(counts.byStatus).toMatchObject({ COMPLETED: 2, CANCELLED: 1, DRAFT: 1, UNDER_REVIEW: 1 });
      // The same numbers come back from the list with the bucket filter.
      for (const [bucket, n] of Object.entries(counts.buckets)) {
        expect([bucket, (await t.as(delta.owner).get(`/requests?bucket=${bucket}`).expect(200)).body.meta.total]).toEqual([bucket, n]);
      }
      // An operator's dashboard only counts their own cases.
      expect((await t.as(deltaOperator).get('/requests/counts').expect(200)).body.buckets).toMatchObject({ newRequests: 0, inProgress: 2, overdue: 1, completedToday: 0 });
    });

    it('filters by status, bucket, assignee, customer, service, priority, dates and text', async () => {
      expect(await listed('status=QUOTED,AWAITING_PAYMENT')).toEqual(['quoted', 'payment']);
      expect(await listed('status=QUOTED&status=SUBMITTED')).toEqual(['new', 'quoted']);
      expect(await listed('bucket=awaitingCustomer')).toEqual(['awaiting', 'quoted']);
      expect(await listed('bucket=inProgress')).toEqual(['prep', 'external']);
      expect(await listed('bucket=overdue')).toEqual(['prep']); // completed and cancelled requests are never overdue
      expect(await listed('bucket=completedToday')).toEqual(['doneToday']);
      expect(await listed(`assignedToId=${deltaOperator.membershipId}`)).toEqual(['prep', 'external']);
      expect(await listed('assignedToId=me', deltaOperator)).toEqual(['prep', 'external']);
      expect(await listed('assignedToId=me')).toEqual([]);
      expect(await listed(`customerId=${ids.ali}&status=SUBMITTED,IN_PREPARATION`)).toEqual(['new', 'prep']);
      expect(await listed(`serviceId=${ids.visa}&bucket=inProgress`)).toEqual(['prep', 'external']);
      expect(await listed('priority=URGENT')).toEqual(['review']);
      expect(await listed('source=ONLINE')).toEqual([]);
      const today = new Date().toISOString().slice(0, 10);
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      expect((await listed(`createdFrom=${today}&createdTo=${today}`)).length + (await listed(`createdFrom=${tomorrow}`)).length).toBe(12);
      expect(await listed(`createdFrom=${tomorrow}`)).toEqual([]);
      expect(await listed(`completedTo=${new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10)}`)).toEqual(['doneEarlier']);
      expect((await listed(`submittedFrom=${new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)}`)).length).toBe(11);
      // Text search: request number, customer name, external reference number.
      const number = (await getRequest(t, ids.review)).requestNo;
      expect(await listed(`q=${number}`)).toEqual(['review']);
      expect(await listed('q=mansour&status=SUBMITTED,AWAITING_PAYMENT')).toEqual(['new', 'payment']);
      expect(await listed('q=778899')).toEqual(['external']);
      expect(await listed('q=no-such-thing')).toEqual([]);
      await t.as(delta.owner).get('/requests?status=NOPE').expect(400);
      await t.as(delta.owner).get('/requests?bucket=everything').expect(400);
    });

    it('list rows carry what a work queue needs', async () => {
      const page = (await t.as(delta.owner).get('/requests?bucket=inProgress&sort=createdAt:asc&pageSize=1&page=2').expect(200)).body;
      expect(page.meta).toEqual({ page: 2, pageSize: 1, total: 2, totalPages: 2 });
      expect(page.data[0]).toMatchObject({
        id: ids.external, status: 'EXTERNAL_PROCESSING', statusLabel: { en: 'External processing' }, priority: 'NORMAL', paymentStatus: 'UNPAID', customerName: 'Sara Qasim', serviceName: 'Visa stamping',
        overdue: false, assignee: { membershipId: deltaOperator.membershipId }, externalStatus: { status: 'Under process', source: 'STAFF_ENTERED', sourceLabel: STATUS_SOURCE_LABEL.STAFF_ENTERED },
      });
      expect(page.data[0].assigneeName).toBeTruthy();
      expect(page.data[0].targetDate).toBeTruthy();
      const overdue = (await t.as(delta.owner).get('/requests?bucket=overdue').expect(200)).body.data[0];
      expect(overdue).toMatchObject({ id: ids.prep, overdue: true });
      // Sorting is limited to an allow-list.
      const sorted = (await t.as(delta.owner).get('/requests?sort=tenantId:asc').expect(200)).body.data;
      expect(new Date(sorted[0].createdAt).getTime()).toBeGreaterThanOrEqual(new Date(sorted[sorted.length - 1].createdAt).getTime());
    });
  });

  // =====================================================================================
  describe('tenant isolation', () => {
    it('no endpoint lets another centre read, change or reference a request', async () => {
      const service = await createService(t, alpha);
      const customer = await createCustomer(t, alpha);
      const request = await readyRequest(t, alpha, receptionist, service.id, customer.id);
      await assign(request.id, operator).expect(200);
      await move(operator, request.id, 'IN_PREPARATION').expect(200);
      await move(operator, request.id, 'PENDING_APPROVAL').expect(200);
      const approval = await t.sys.requestApproval.findFirstOrThrow({ where: { requestId: request.id } });
      const line = (await checklistOf(t, request.id))[0];
      const reference = await t.sys.requestExternalReference.create({ data: { tenantId: alpha.id, requestId: request.id, channel: 'MANUAL_PORTAL', referenceNo: 'ALPHA-REF-1', status: 'Submitted' } });
      const betaOperator = await t.addStaff(beta, 'operator');
      const betaService = await createService(t, beta);
      const betaCustomer = await createCustomer(t, beta);
      const betaRequest = await submittedRequest(t, beta, beta.owner, betaService.id, betaCustomer.id);
      const before = { row: await getRequest(t, request.id), history: (await historyOf(t, request.id)).length };
      const id = request.id;

      const attempts: Array<[string, string, object?]> = [
        ['get', `/requests/${id}`],
        ['patch', `/requests/${id}`, { priority: 'URGENT' }],
        ['put', `/requests/${id}/fields`, { values: { purpose: 'work' } }],
        ['post', `/requests/${id}/submit`],
        ['post', `/requests/${id}/transition`, { to: 'CANCELLED', reason: 'cross-tenant' }],
        ['post', `/requests/${id}/cancel`, { reason: 'cross-tenant' }],
        ['post', `/requests/${id}/reopen`, { reason: 'cross-tenant' }],
        ['post', `/requests/${id}/complete`],
        ['post', `/requests/${id}/mark-duplicate`, { duplicateOfId: betaRequest.id }],
        ['post', `/requests/${id}/request-information`, { message: 'cross-tenant question' }],
        ['post', `/requests/${id}/resubmit`, {}],
        ['get', `/requests/${id}/comments`],
        ['post', `/requests/${id}/comments`, { body: 'cross-tenant', visibility: 'CUSTOMER' }],
        ['post', `/requests/${id}/assign`, { assigneeMembershipId: betaOperator.membershipId }],
        ['post', `/requests/${id}/auto-assign`],
        ['post', `/requests/${id}/checklist`, { documentTypeKey: 'other', label: 'Injected' }],
        ['post', `/requests/${id}/checklist/${line.id}/waive`, { reason: 'cross-tenant' }],
        ['put', `/requests/${id}/checklist/${line.id}/document`, { documentId: line.documentId }],
        ['delete', `/requests/${id}/checklist/${line.id}/document`],
        ['post', `/requests/${id}/approvals/${approval.id}/decide`, { decision: 'APPROVED' }],
        ['get', `/requests/${id}/external-references`],
        ['post', `/requests/${id}/external-references`, { channel: 'MANUAL_PORTAL', referenceNo: 'BETA-1' }],
        ['patch', `/requests/${id}/external-references/${reference.id}`, { status: 'Hijacked' }],
        ['post', `/requests/${id}/external-result`, { outcome: 'COMPLETED' }],
        ['post', `/requests/${id}/workflow/complete-step`, {}],
        ['post', `/requests/${id}/workflow/migrate`],
      ];
      const leaks: string[] = [];
      for (const [method, path, body] of attempts) {
        const res = await (t.as(beta.owner) as any)[method](path, body);
        if (res.status !== 404 || res.body.code !== 'NOT_FOUND') leaks.push(`${method.toUpperCase()} ${path}: ${res.status} ${res.body.code}`);
      }
      expect(leaks).toEqual([]);

      // Nothing of alpha is listed, counted or found by search in beta.
      const list = (await t.as(beta.owner).get('/requests?pageSize=100').expect(200)).body;
      expect(list.data.map((r: any) => r.id)).toEqual([betaRequest.id]);
      expect((await t.as(beta.owner).get(`/requests?q=${request.requestNo}&customerId=${customer.id}`).expect(200)).body.data).toEqual([]);
      expect((await t.as(beta.owner).get(`/requests?q=ALPHA-REF-1`).expect(200)).body.data).toEqual([]);
      expect((await t.as(beta.owner).get('/requests/counts').expect(200)).body.open).toBe(1);

      // Beta cannot build a request out of alpha's rows either ...
      await t.as(beta.owner).post('/requests', { serviceId: service.id, customerId: betaCustomer.id }).expect(404);
      await t.as(beta.owner).post('/requests', { serviceId: betaService.id, customerId: customer.id }).expect(404);
      await t.as(beta.owner).post('/requests', { serviceId: betaService.id, customerId: betaCustomer.id, branchId: alpha.headOfficeId }).expect(404);
      // ... nor point its own requests at them.
      await t.as(beta.owner).post(`/requests/${betaRequest.id}/mark-duplicate`, { duplicateOfId: id }).expect(404);
      await t.as(beta.owner).post(`/requests/${betaRequest.id}/assign`, { assigneeMembershipId: operator.membershipId }).expect(404);
      const betaLine = (await checklistOf(t, betaRequest.id))[0];
      await t.as(beta.owner).put(`/requests/${betaRequest.id}/checklist/${betaLine.id}/document`, { documentId: line.documentId }).expect(404);
      await t.as(beta.owner).put(`/requests/${betaRequest.id}/checklist/${line.id}/document`, { documentId: line.documentId }).expect(404);
      await t.as(beta.owner).post(`/requests/${betaRequest.id}/approvals/${approval.id}/decide`, { decision: 'APPROVED' }).expect(404);
      await t.as(beta.owner).patch(`/requests/${betaRequest.id}/external-references/${reference.id}`, { status: 'Hijacked' }).expect(404);

      // Alpha's request is exactly as it was.
      const after = await getRequest(t, id);
      expect({ status: after.status, version: after.version, assignedToId: after.assignedToId, priority: after.priority }).toEqual({ status: before.row.status, version: before.row.version, assignedToId: before.row.assignedToId, priority: before.row.priority });
      expect((await historyOf(t, id)).length).toBe(before.history);
      expect((await t.sys.requestExternalReference.findUniqueOrThrow({ where: { id: reference.id } })).status).toBe('Submitted');
      expect(await t.sys.requestComment.count({ where: { requestId: id } })).toBe(0);
      expect((await t.sys.requestApproval.findUniqueOrThrow({ where: { id: approval.id } })).status).toBe('PENDING');
    });

    it('row-level security hides requests of other centres even from unfiltered queries', async () => {
      const rows = await t.inTenant(beta.id, () => t.db.tx((tx) => tx.serviceRequest.findMany()));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.tenantId === beta.id)).toBe(true);
      const history = await t.inTenant(beta.id, () => t.db.tx((tx) => tx.requestStatusHistory.findMany()));
      expect(history.every((r) => r.tenantId === beta.id)).toBe(true);
      const steps = await t.inTenant(beta.id, () => t.db.tx((tx) => tx.workflowStep.findMany()));
      expect(steps.length).toBeGreaterThan(0);
      expect(steps.every((r) => r.tenantId === beta.id)).toBe(true);
    });
  });

  // =====================================================================================
  describe('plan limit on monthly requests', () => {
    it('submitting counts against the plan and is refused at the limit; drafts are free', async () => {
      const small = await t.createTenant({ name: 'Small Centre', plan: 'starter' }); // 200 requests per month
      const service = await createService(t, small);
      const customer = await createCustomer(t, small);
      const usage = async () => Number((await t.sys.usageRecord.findFirst({ where: { tenantId: small.id, metric: 'monthlyRequests', periodKey: periodKey() } }))?.quantity ?? 0);

      const first = await submittedRequest(t, small, small.owner, service.id, customer.id);
      expect(first.status).toBe('SUBMITTED');
      expect(await usage()).toBe(1);
      await t.sys.usageRecord.updateMany({ where: { tenantId: small.id, metric: 'monthlyRequests' }, data: { quantity: 199 } });
      await submittedRequest(t, small, small.owner, service.id, customer.id); // the 200th
      expect(await usage()).toBe(200);

      const draft = await draftRequest(t, small, small.owner, service.id, customer.id); // creating a draft is always possible
      const refused = await t.as(small.owner).post(`/requests/${draft.id}/submit`).expect(402);
      expect(refused.body).toMatchObject({ code: 'PLAN_LIMIT_REACHED', message: 'Your plan includes 200 requests this month. Upgrade your subscription to add more.', details: { limit: 'monthlyRequests' } });
      expect(await statusOf(t, draft.id)).toBe('DRAFT');
      expect(await usage()).toBe(200);
      expect(await t.sys.workflowExecution.count({ where: { requestId: draft.id } })).toBe(0);
      // The generic endpoint is subject to the same limit.
      expect((await t.as(small.owner).post(`/requests/${draft.id}/transition`, { to: 'SUBMITTED' }).expect(402)).body.code).toBe('PLAN_LIMIT_REACHED');
      // A customer submitting online hits it too.
      const customerActor = await t.addCustomer(small);
      const own = (await t.as(customerActor).post('/requests', { serviceId: service.id, fields: { purpose: 'family' } }).expect(201)).body;
      await t.as(customerActor).post(`/requests/${own.id}/submit`).expect(402);
      // After an upgrade (enterprise = unlimited) the same draft goes through.
      const enterprise = await t.sys.subscriptionPlan.findUniqueOrThrow({ where: { key: 'enterprise' } });
      await t.sys.subscription.updateMany({ where: { tenantId: small.id }, data: { planId: enterprise.id } });
      await t.as(small.owner).post(`/requests/${draft.id}/submit`).expect(200);
      expect(await usage()).toBe(201);
    });
  });

  // =====================================================================================
  describe('public tracking', () => {
    it('shows the status with the tracking code and leaks nothing else', async () => {
      const service = await createService(t, alpha, { name: 'Golden visa assistance' });
      const customer = await createCustomer(t, alpha, { fullName: 'Very Private Person' });
      const request = await readyRequest(t, alpha, receptionist, service.id, customer.id);
      expect(request.trackingCode).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
      await assign(request.id, operator).expect(200);
      await move(operator, request.id, 'IN_PREPARATION').expect(200);
      await move(operator, request.id, 'PENDING_APPROVAL').expect(200);
      const approval = await t.sys.requestApproval.findFirstOrThrow({ where: { requestId: request.id } });
      await t.as(reviewer).post(`/requests/${request.id}/approvals/${approval.id}/decide`, { decision: 'APPROVED' }).expect(200);
      await t.as(operator).post(`/requests/${request.id}/external-references`, { channel: 'MANUAL_PORTAL', referenceNo: 'PRIVATE-REF-42', authorityName: 'GDRFA' }).expect(201);
      const ref = await t.sys.requestExternalReference.findFirstOrThrow({ where: { requestId: request.id } });
      await t.as(operator).patch(`/requests/${request.id}/external-references/${ref.id}`, { status: 'Under process' }).expect(200);

      const track = (body: object) => t.as(null).post('/public/track', body);
      const ok = (await track({ tenantSlug: alpha.slug, requestNo: request.requestNo, trackingCode: request.trackingCode }).expect(200)).body;
      expect(Object.keys(ok).sort()).toEqual(['completedAt', 'externalStatus', 'requestNo', 'service', 'status', 'statusLabel', 'submittedAt', 'timeline']);
      expect(ok).toMatchObject({
        requestNo: request.requestNo,
        service: { name: 'Golden visa assistance' },
        status: 'EXTERNAL_PROCESSING',
        statusLabel: { en: 'Submitted — in processing', ar: 'تم التقديم — قيد المعالجة' },
        externalStatus: { status: 'Under process', source: 'STAFF_ENTERED', sourceLabel: STATUS_SOURCE_LABEL.STAFF_ENTERED },
      });
      // Customer-visible milestones only: the internal review does not appear.
      expect(ok.timeline.map((x: any) => x.status)).toEqual(['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'QUOTED', 'AWAITING_PAYMENT', 'READY_FOR_PROCESSING', 'IN_PREPARATION', 'READY_TO_SUBMIT', 'EXTERNAL_PROCESSING']);
      expect(Object.keys(ok.timeline[0]).sort()).toEqual(['at', 'status', 'statusLabel']);
      const text = JSON.stringify(ok);
      for (const secret of ['Very Private Person', customer.id, customer.customerNo, 'PRIVATE-REF-42', 'GDRFA', '500', operator.userId, request.id, alpha.id, 'trackingCodeHash', 'reason']) expect(text).not.toContain(secret);
      // The code works with or without the dash, in any case; the host can replace the slug.
      await track({ tenantSlug: alpha.slug, requestNo: request.requestNo.toLowerCase(), trackingCode: request.trackingCode.replace('-', '').toLowerCase() }).expect(200);
      await t.http.post('/api/v1/public/track').set('x-tenant-host', `${alpha.slug}.typease.test`).send({ requestNo: request.requestNo, trackingCode: request.trackingCode }).expect(200);

      // Wrong code, unknown number, wrong centre and no centre are indistinguishable.
      const failures = [
        await track({ tenantSlug: alpha.slug, requestNo: request.requestNo, trackingCode: 'AAAAA-BBBBB' }),
        await track({ tenantSlug: alpha.slug, requestNo: 'TE-999999', trackingCode: request.trackingCode }),
        await track({ tenantSlug: beta.slug, requestNo: request.requestNo, trackingCode: request.trackingCode }),
        await track({ tenantSlug: 'no-such-centre', requestNo: request.requestNo, trackingCode: request.trackingCode }),
        await track({ requestNo: request.requestNo, trackingCode: request.trackingCode }),
      ];
      for (const res of failures) {
        expect(res.status).toBe(404);
        const { requestId: _ignored, ...body } = res.body;
        expect(body).toEqual({ statusCode: 404, code: 'NOT_FOUND', message: 'Request was not found.' });
      }
      await track({ tenantSlug: alpha.slug, requestNo: request.requestNo }).expect(400);
      // A draft has no tracking code and cannot be tracked at all.
      const draft = await draftRequest(t, alpha, receptionist, service.id, customer.id);
      await track({ tenantSlug: alpha.slug, requestNo: draft.requestNo, trackingCode: '000000' }).expect(404);
      // The code itself is not stored and is never shown again.
      expect(JSON.stringify(await getRequest(t, request.id))).not.toContain(request.trackingCode);
      expect(JSON.stringify((await t.as(manager).get(`/requests/${request.id}`).expect(200)).body)).not.toContain(request.trackingCode);
    });
  });
});
