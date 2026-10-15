import { STATUS_SOURCE_LABEL } from '@typease/types';
import { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import {
  approveQuotation, checklistOf, completeDocuments, createCustomer, createDocument, createService, emit, eventsOf, getRequest, historyOf, openTasksOf, pathOf, payInvoice,
  readyRequest, rejectDocument, sendQuotation, statusOf, stepsOf, submittedRequest, tasksOf, uploadFor, verifyDocument,
} from './fixtures';
import { Clock } from '../workflows/clock';
import { SCAN_JOB } from './workflow-engine.service';

describe('Service requests: lifecycle', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let manager: Actor;
  let receptionist: Actor;
  let operator: Actor;
  let operator2: Actor;
  let reviewer: Actor;
  let accountant: Actor;

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    manager = await t.addStaff(alpha, 'manager');
    receptionist = await t.addStaff(alpha, 'receptionist');
    operator = await t.addStaff(alpha, 'operator');
    operator2 = await t.addStaff(alpha, 'operator');
    reviewer = await t.addStaff(alpha, 'reviewer');
    accountant = await t.addStaff(alpha, 'accountant');
  });
  afterAll(() => t.close());
  afterEach(() => t.get(Clock).reset());

  const move = (actor: Actor, id: string, to: string, extra: object = {}) => t.as(actor).post(`/requests/${id}/transition`, { to, ...extra });
  const assign = (id: string, who: Actor, role = 'OPERATOR', reason?: string) => t.as(manager).post(`/requests/${id}/assign`, { assigneeMembershipId: who.membershipId, role, reason });
  const types = async (id: string) => (await eventsOf(t, alpha.id, id)).map((e) => e.type);

  /** Drives a request of a "requires approval + direct submission" service into preparation. */
  async function inPreparation(options: Parameters<typeof createService>[2] = {}) {
    const service = await createService(t, alpha, options);
    const customer = await createCustomer(t, alpha);
    const request = await readyRequest(t, alpha, receptionist, service.id, customer.id);
    await assign(request.id, operator).expect(200);
    await move(operator, request.id, 'IN_PREPARATION').expect(200);
    return { ...request, service, customer };
  }
  async function approvedForSubmission(options: Parameters<typeof createService>[2] = {}) {
    const request = await inPreparation(options);
    await move(operator, request.id, 'PENDING_APPROVAL').expect(200);
    const approval = await t.sys.requestApproval.findFirstOrThrow({ where: { requestId: request.id, status: 'PENDING' } });
    await t.as(reviewer).post(`/requests/${request.id}/approvals/${approval.id}/decide`, { decision: 'APPROVED' }).expect(200);
    return request;
  }
  async function inExternalProcessing(options: Parameters<typeof createService>[2] = {}) {
    const request = await approvedForSubmission(options);
    await t.as(operator).post(`/requests/${request.id}/external-references`, { channel: 'MANUAL_PORTAL', authorityName: 'GDRFA', referenceNo: `REF-${request.requestNo}` }).expect(201);
    return request;
  }

  // =====================================================================================
  it('happy path: from draft to completed, with history, tasks and events at every stage', async () => {
    const service = await createService(t, alpha, { name: 'New residence visa', complianceCapability: 'DIRECT_AUTHORISED', requiresApproval: true, paymentPolicy: 'BEFORE_PROCESSING', estimatedProcessingHours: 48 });
    const customer = await createCustomer(t, alpha, { fullName: 'Aisha Khan', nationality: 'PK' });

    // ---- 1. staff create the request: draft, checklist built, profile data prefilled
    const created = (await t.as(receptionist).post('/requests', { serviceId: service.id, customerId: customer.id, priority: 'HIGH', instructions: 'Please call before submitting.' }).expect(201)).body;
    const id: string = created.id;
    expect(created.requestNo).toMatch(/^TE-\d{6}$/);
    expect(created).toMatchObject({ status: 'DRAFT', priority: 'HIGH', source: 'WALK_IN', paymentStatus: 'UNPAID', customerInstructions: 'Please call before submitting.' });
    expect(created.branch.id).toBe(alpha.headOfficeId);
    expect(created.service).toMatchObject({ name: 'New residence visa', complianceCapability: 'DIRECT_AUTHORISED', requiresApproval: true, paymentPolicy: 'BEFORE_PROCESSING', permittedChannels: ['MANUAL_PORTAL', 'OFFICIAL_API'] });
    expect(created.checklist.map((l: any) => [l.label, l.kind, l.status, l.isMandatory])).toEqual([['Passport copy', 'INPUT', 'MISSING', true], ['Personal photo', 'INPUT', 'MISSING', true]]);
    expect(created.form.values).toEqual({ fullName: 'Aisha Khan', nationality: 'PK' });
    expect(created.form.fields.find((f: any) => f.key === 'fullName').source).toBe('PREFILL');
    expect(created.workflow.status).toBe('NOT_STARTED');
    expect(await types(id)).toEqual(['request.created']);
    const row = await getRequest(t, id);
    expect(row.serviceSnapshot).toMatchObject({ name: 'New residence visa', code: service.code, complianceCapability: 'DIRECT_AUTHORISED', requiresApproval: true, paymentPolicy: 'BEFORE_PROCESSING', taxMode: 'SERVICE_FEE_ONLY', estimatedProcessingHours: 48, categoryKey: 'visa' });
    expect(row.formDefinitionId).toBeTruthy();
    expect(row.workflowVersionId).toBeTruthy();

    // ---- 2. the draft cannot be submitted until the form is valid
    const invalid = await t.as(receptionist).post(`/requests/${id}/submit`).expect(422);
    expect(invalid.body.code).toBe('FORM_INVALID');
    expect(invalid.body.details.map((e: any) => e.field)).toEqual(['purpose']);
    await t.as(receptionist).put(`/requests/${id}/fields`, { values: { purpose: 'work' } }).expect(200);
    expect((await t.as(receptionist).post(`/requests/${id}/submit`).expect(422)).body.details[0]).toMatchObject({ field: 'sponsor', code: 'REQUIRED' });
    await t.as(receptionist).put(`/requests/${id}/fields`, { values: { sponsor: 'ACME LLC' } }).expect(200);

    const submitted = (await t.as(receptionist).post(`/requests/${id}/submit`).expect(200)).body;
    expect(submitted.status).toBe('SUBMITTED');
    expect(submitted.trackingCode).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    expect(new Date(submitted.targetDate).getTime() - new Date(submitted.submittedAt).getTime()).toBe(48 * 3_600_000);
    expect((await getRequest(t, id)).trackingCodeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await types(id)).toEqual(['request.created', 'request.status_changed', 'request.submitted']);
    let wf = await stepsOf(t, id);
    expect(wf.execution).toMatchObject({ status: 'ACTIVE', versionId: row.workflowVersionId, currentStepKey: 'documents' });
    expect(wf.steps.map((s) => [s.stepKey, s.status])).toEqual([['form', 'COMPLETED'], ['documents', 'ACTIVE']]);
    expect(await tasksOf(t, id)).toHaveLength(0);

    // ---- 3. documents arrive (documents module -> document.uploaded)
    const [passportLine, photoLine] = await checklistOf(t, id);
    const passport = await uploadFor(t, alpha, id, passportLine);
    expect(await statusOf(t, id)).toBe('SUBMITTED');
    const photo = await uploadFor(t, alpha, id, photoLine, { withItemId: false }); // matched by document type
    expect((await checklistOf(t, id)).map((l) => [l.status, l.documentId])).toEqual([['UPLOADED', passport.id], ['UPLOADED', photo.id]]);
    // Everything is uploaded: staff verification starts.
    expect(await statusOf(t, id)).toBe('UNDER_REVIEW');
    expect((await stepsOf(t, id)).current).toBe('verification');

    // ---- 4. documents are verified (document.verified)
    await verifyDocument(t, alpha, passport.id, id);
    expect(await statusOf(t, id)).toBe('UNDER_REVIEW');
    expect((await stepsOf(t, id)).current).toBe('verification');
    await verifyDocument(t, alpha, photo.id, id);
    expect((await checklistOf(t, id)).every((l) => l.status === 'VERIFIED')).toBe(true);
    wf = await stepsOf(t, id);
    expect(wf.current).toBe('quotation');
    expect(wf.status('verification')).toBe('COMPLETED');
    let open = await openTasksOf(t, id);
    expect(open.map((x) => [x.title, x.source, x.stepKey, x.roleKey, x.type, x.priority])).toEqual([[`Prepare quotation - ${created.requestNo}`, 'WORKFLOW', 'quotation', 'receptionist', 'WORKFLOW_STEP', 'HIGH']]);
    expect(open[0].dueAt).toBeTruthy();

    // ---- 5. quotation sent (finance -> quotation.sent)
    const quotation = await sendQuotation(t, alpha, id, 750);
    expect(await statusOf(t, id)).toBe('QUOTED');
    expect((await stepsOf(t, id)).current).toBe('customer-approval');
    expect(await openTasksOf(t, id)).toHaveLength(0);
    expect((await tasksOf(t, id))[0]).toMatchObject({ status: 'DONE', stepKey: 'quotation' });

    // ---- 6. quotation approved, invoice issued: payment is due before processing
    const { invoice } = await approveQuotation(t, alpha, quotation.id);
    expect(await statusOf(t, id)).toBe('AWAITING_PAYMENT');
    expect((await stepsOf(t, id)).current).toBe('payment');
    expect((await getRequest(t, id)).paymentStatus).toBe('UNPAID');

    // ---- 7. payment completed (finance -> payment.completed)
    await payInvoice(t, alpha, invoice!.id);
    expect(await getRequest(t, id)).toMatchObject({ status: 'READY_FOR_PROCESSING', paymentStatus: 'PAID' });
    wf = await stepsOf(t, id);
    expect(wf.current).toBe('prepare');
    expect(wf.status('payment')).toBe('COMPLETED');
    open = await openTasksOf(t, id);
    expect(open.map((x) => [x.title, x.stepKey, x.roleKey, x.taskAssignments.length])).toEqual([[`Prepare application - ${created.requestNo}`, 'prepare', 'operator', 0]]);

    // ---- 8. assignment
    await t.as(operator).get(`/requests/${id}`).expect(404); // operators only see what is assigned to them
    expect((await move(manager, id, 'IN_PREPARATION').expect(422)).body.code).toBe('OPERATOR_REQUIRED');
    const assigned = (await assign(id, operator).expect(200)).body;
    expect(assigned.assignee).toMatchObject({ membershipId: operator.membershipId, roleKey: 'operator' });
    expect(assigned.assignments).toEqual([expect.objectContaining({ role: 'OPERATOR', method: 'MANUAL', assigneeMembershipId: operator.membershipId, unassignedAt: null })]);
    expect((await eventsOf(t, alpha.id, id, 'request.assigned'))[0].payload).toMatchObject({ assigneeMembershipId: operator.membershipId, assigneeUserId: operator.userId, role: 'OPERATOR', method: 'MANUAL' });
    // The open workflow task now belongs to the operator.
    expect((await openTasksOf(t, id))[0].taskAssignments.map((a) => a.assigneeId)).toEqual([operator.membershipId]);
    await assign(id, reviewer, 'REVIEWER').expect(200);

    // ---- 9. preparation
    const preparing = (await move(operator, id, 'IN_PREPARATION').expect(200)).body;
    expect(preparing.status).toBe('IN_PREPARATION');
    expect(preparing.allowedActions.transitions.map((x: any) => [x.to, x.enabled, x.blocked?.code])).toEqual([
      ['PENDING_APPROVAL', true, undefined],
      ['READY_TO_SUBMIT', false, 'APPROVAL_REQUIRED'],
      ['FINAL_REVIEW', false, 'APPROVAL_REQUIRED'],
      ['AWAITING_CUSTOMER', true, undefined],
    ]);
    // The service requires review: preparation cannot jump to submission.
    expect((await move(operator, id, 'READY_TO_SUBMIT').expect(422)).body.code).toBe('APPROVAL_REQUIRED');

    // ---- 10. sent for review
    await move(operator, id, 'PENDING_APPROVAL').expect(200);
    const approval = await t.sys.requestApproval.findFirstOrThrow({ where: { requestId: id } });
    expect(approval).toMatchObject({ type: 'REVIEW', status: 'PENDING', stepKey: 'review', requestedById: operator.userId });
    wf = await stepsOf(t, id);
    expect([wf.status('prepare'), wf.status('review'), wf.current]).toEqual(['COMPLETED', 'ACTIVE', 'review']);
    open = await openTasksOf(t, id);
    expect(open.map((x) => [x.stepKey, x.type, x.roleKey, x.taskAssignments.map((a) => a.assigneeId)])).toEqual([['review', 'APPROVAL', 'reviewer', [reviewer.membershipId]]]);
    // The customer does not see the internal review as a separate step.
    const reviewRow = (await historyOf(t, id)).find((h) => h.toStatus === 'PENDING_APPROVAL')!;
    expect(reviewRow.customerVisible).toBe(false);

    // ---- 11. review approval
    await t.as(operator).post(`/requests/${id}/approvals/${approval.id}/decide`, { decision: 'APPROVED' }).expect(403); // operators cannot review
    const approved = (await t.as(reviewer).post(`/requests/${id}/approvals/${approval.id}/decide`, { decision: 'APPROVED', comment: 'All good' }).expect(200)).body;
    expect(approved.status).toBe('READY_TO_SUBMIT');
    expect(approved.approvals).toEqual([expect.objectContaining({ id: approval.id, status: 'APPROVED', decidedById: reviewer.userId, comment: 'All good', superseded: false })]);
    wf = await stepsOf(t, id);
    expect([wf.status('review'), wf.status('submission'), wf.current]).toEqual(['COMPLETED', 'ACTIVE', 'submission']);
    open = await openTasksOf(t, id);
    expect(open.map((x) => [x.title, x.taskAssignments.map((a) => a.assigneeId)])).toEqual([[`Submit application and record the reference - ${created.requestNo}`, [operator.membershipId]]]);
    // A submission has to be recorded: final review cannot be reached around it.
    expect((await move(operator, id, 'FINAL_REVIEW').expect(422)).body.code).toBe('EXTERNAL_SUBMISSION_PENDING');
    expect((await move(operator, id, 'EXTERNAL_PROCESSING').expect(422)).body.code).toBe('EXTERNAL_REFERENCE_REQUIRED');

    // ---- 12. external submission recorded
    const afterSubmission = (await t.as(operator).post(`/requests/${id}/external-references`, { channel: 'MANUAL_PORTAL', authorityName: 'GDRFA Dubai', referenceNo: 'GD-2026-000123', notes: 'Submitted on the official portal' }).expect(201)).body;
    expect(afterSubmission).toMatchObject({ status: 'EXTERNAL_PROCESSING', submissionChannel: 'MANUAL_PORTAL' });
    expect(afterSubmission.externalStatus).toMatchObject({ status: 'Submitted', source: 'STAFF_ENTERED', sourceLabel: STATUS_SOURCE_LABEL.STAFF_ENTERED });
    expect(afterSubmission.externalReferences).toEqual([expect.objectContaining({ channel: 'MANUAL_PORTAL', referenceNo: 'GD-2026-000123', statusSource: 'STAFF_ENTERED', statusSourceLabel: STATUS_SOURCE_LABEL.STAFF_ENTERED, result: null })]);
    expect(await openTasksOf(t, id)).toHaveLength(0);
    const referenceId = afterSubmission.externalReferences[0].id;
    const updated = (await t.as(operator).patch(`/requests/${id}/external-references/${referenceId}`, { status: 'Under process at the authority' }).expect(200)).body;
    expect(updated).toMatchObject({ status: 'Under process at the authority', statusSource: 'STAFF_ENTERED' });
    expect(await getRequest(t, id)).toMatchObject({ externalStatus: 'Under process at the authority', externalStatusSource: 'STAFF_ENTERED' });
    // Final review needs a recorded result.
    expect((await move(operator, id, 'FINAL_REVIEW').expect(422)).body.code).toBe('EXTERNAL_RESULT_REQUIRED');

    // ---- 13. result received
    const afterResult = (await t.as(operator).post(`/requests/${id}/external-result`, { outcome: 'COMPLETED', note: 'Visa issued' }).expect(200)).body;
    expect(afterResult.status).toBe('FINAL_REVIEW');
    expect(afterResult.externalReferences[0]).toMatchObject({ status: 'COMPLETED', result: 'COMPLETED', statusSource: 'STAFF_ENTERED' });
    wf = await stepsOf(t, id);
    expect([wf.status('submission'), wf.status('completion'), wf.current]).toEqual(['COMPLETED', 'ACTIVE', 'completion']);
    open = await openTasksOf(t, id);
    expect(open.map((x) => [x.title, x.type, x.taskAssignments.map((a) => a.assigneeId)])).toEqual([[`Final review - ${created.requestNo}`, 'APPROVAL', [reviewer.membershipId]]]);

    // ---- 14. completed documents, then completion
    const withDeliverable = (await t.as(operator).post(`/requests/${id}/checklist`, { documentTypeKey: 'completed_document', label: 'Issued visa', kind: 'COMPLETION' }).expect(201)).body;
    const deliverable = withDeliverable.checklist.find((l: any) => l.kind === 'COMPLETION');
    expect((await t.as(reviewer).post(`/requests/${id}/complete`).expect(422)).body.code).toBe('COMPLETION_DOCUMENTS_MISSING');
    const visa = await createDocument(t, alpha, { customerId: customer.id, requestId: id, documentTypeKey: 'completed_document', isCompletionDocument: true });
    await emit(t, alpha.id, 'document.uploaded', { documentId: visa.id, versionId: visa.id, customerId: customer.id, requestId: id, checklistItemId: deliverable.id, documentTypeKey: 'completed_document', uploadedByType: 'STAFF' });
    await t.as(operator).post(`/requests/${id}/complete`).expect(403); // completing is the reviewer's decision

    const done = (await t.as(reviewer).post(`/requests/${id}/complete`).expect(200)).body;
    expect(done.status).toBe('COMPLETED');
    expect(done.completedAt).toBeTruthy();
    expect(done.allowedActions.transitions).toEqual([]); // a reviewer cannot reopen
    expect(done.workflow.status).toBe('COMPLETED');
    expect(done.workflow.steps.map((s: any) => [s.key, s.status])).toEqual([
      ['form', 'COMPLETED'], ['documents', 'COMPLETED'], ['verification', 'COMPLETED'], ['quotation', 'COMPLETED'], ['customer-approval', 'COMPLETED'],
      ['payment', 'COMPLETED'], ['prepare', 'COMPLETED'], ['review', 'COMPLETED'], ['submission', 'COMPLETED'], ['completion', 'COMPLETED'],
    ]);
    const tasks = await tasksOf(t, id);
    expect(tasks.map((x) => [x.stepKey, x.status])).toEqual([['quotation', 'DONE'], ['prepare', 'DONE'], ['review', 'DONE'], ['submission', 'DONE'], ['completion', 'DONE']]);
    expect(tasks.every((x) => x.source === 'WORKFLOW')).toBe(true);

    // ---- the record that remains
    const history = await historyOf(t, id);
    expect(history.map((h) => h.toStatus)).toEqual([
      'DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'QUOTED', 'AWAITING_PAYMENT', 'READY_FOR_PROCESSING', 'IN_PREPARATION', 'PENDING_APPROVAL', 'READY_TO_SUBMIT', 'EXTERNAL_PROCESSING', 'FINAL_REVIEW', 'COMPLETED',
    ]);
    expect(history.map((h) => h.fromStatus)).toEqual([null, ...history.slice(0, -1).map((h) => h.toStatus)]);
    expect(history.find((h) => h.toStatus === 'SUBMITTED')).toMatchObject({ actorId: receptionist.userId, actorType: 'STAFF' });
    expect(history.find((h) => h.toStatus === 'UNDER_REVIEW')).toMatchObject({ actorType: 'SYSTEM', actorId: null });
    expect((history.find((h) => h.toStatus === 'UNDER_REVIEW')!.meta as any).via).toBe('ENGINE');
    expect(history.find((h) => h.toStatus === 'COMPLETED')).toMatchObject({ actorId: reviewer.userId, customerVisible: true, customerMessage: 'Completed' });
    const statusEvents = await eventsOf(t, alpha.id, id, 'request.status_changed');
    expect(statusEvents.map((e) => `${e.payload.from}>${e.payload.to}`)).toEqual(history.slice(1).map((h) => `${h.fromStatus}>${h.toStatus}`));
    expect((await types(id)).filter((x) => x.startsWith('request.') && x !== 'request.status_changed' && x !== 'request.assigned')).toEqual(['request.created', 'request.submitted', 'request.completed']);
    const audit = await t.sys.auditLog.findMany({ where: { tenantId: alpha.id, resourceId: id, action: 'request.status_changed' } });
    expect(audit).toHaveLength(11);

    // The history table is append-only, even for the system connection used by tests.
    await expect(t.sys.requestStatusHistory.updateMany({ where: { requestId: id }, data: { reason: 'rewritten' } })).rejects.toThrow(/append-only/);
  });

  // =====================================================================================
  describe('exceptions', () => {
    let customerActor: Actor;
    beforeAll(async () => {
      customerActor = await t.addCustomer(alpha, { fullName: 'Omar Farouk' });
    });

    it('missing documents: staff ask, the customer uploads and resubmits', async () => {
      const service = await createService(t, alpha);
      const created = (await t.as(customerActor).post('/requests', { serviceId: service.id, fields: { purpose: 'family' } }).expect(201)).body;
      expect(created).toMatchObject({ status: 'DRAFT', source: 'ONLINE' });
      const id = created.id;
      await t.as(customerActor).post(`/requests/${id}/submit`).expect(200);
      expect(await statusOf(t, id)).toBe('SUBMITTED'); // waiting for documents
      const [passportLine] = await checklistOf(t, id);

      const message = 'Please upload your passport and a recent salary certificate.';
      const asked = (await t.as(receptionist).post(`/requests/${id}/request-information`, { message, checklistItemIds: [passportLine.id], addItems: [{ documentTypeKey: 'certificate', label: 'Salary certificate', isMandatory: true }] }).expect(200)).body;
      expect(asked.status).toBe('AWAITING_CUSTOMER');
      expect(asked.checklist.map((l: any) => l.label)).toEqual(['Passport copy', 'Personal photo', 'Salary certificate']);
      expect((await eventsOf(t, alpha.id, id, 'request.information_requested'))[0].payload).toMatchObject({ requestId: id, customerId: customerActor.customerId, message });

      // The customer sees what to do, and nothing internal.
      const seen = (await t.as(customerActor).get(`/requests/${id}`).expect(200)).body;
      expect(seen.statusLabel.en).toBe('Action needed from you');
      expect(seen.nextStep).toMatchObject({ waitingOn: 'CUSTOMER', text: { en: message } });
      expect(seen.checklist.map((l: any) => [l.label, l.actionRequired])).toEqual([['Passport copy', true], ['Personal photo', false], ['Salary certificate', true]]);
      expect(seen.history[seen.history.length - 1]).toMatchObject({ status: 'AWAITING_CUSTOMER', message });
      expect(seen.allowedActions.other).toEqual(expect.arrayContaining(['upload_documents', 'resubmit', 'edit_fields']));

      // Nothing moves while the centre waits for the customer, even when documents arrive.
      const lines = await checklistOf(t, id);
      for (const line of lines) await uploadFor(t, alpha, id, line);
      expect(await statusOf(t, id)).toBe('AWAITING_CUSTOMER');

      const back = (await t.as(customerActor).post(`/requests/${id}/resubmit`, { note: 'Uploaded everything' }).expect(200)).body;
      expect(back.status).toBe('UNDER_REVIEW'); // the question came from before the review
      expect(await pathOf(t, id)).toEqual(['DRAFT', 'SUBMITTED', 'AWAITING_CUSTOMER', 'UNDER_REVIEW']);
      const resubmitted = (await historyOf(t, id)).pop()!;
      expect(resubmitted).toMatchObject({ actorId: customerActor.userId, actorType: 'CUSTOMER' });
      expect(resubmitted.meta).toMatchObject({ resubmitted: true, origin: 'SUBMITTED' });
      // Resubmitting twice is refused.
      expect((await t.as(customerActor).post(`/requests/${id}/resubmit`).expect(409)).body.code).toBe('INVALID_TRANSITION');
    });

    it('invalid documents: a rejected document sends the request back to the customer until it is replaced', async () => {
      const service = await createService(t, alpha);
      const id = (await t.as(customerActor).post('/requests', { serviceId: service.id, fields: { purpose: 'family' } }).expect(201)).body.id;
      await t.as(customerActor).post(`/requests/${id}/submit`).expect(200);
      const [passportLine, photoLine] = await checklistOf(t, id);
      const passport = await uploadFor(t, alpha, id, passportLine);
      const photo = await uploadFor(t, alpha, id, photoLine);
      await verifyDocument(t, alpha, passport.id, id);
      expect(await statusOf(t, id)).toBe('UNDER_REVIEW');

      await rejectDocument(t, alpha, photo.id, 'The photo is blurred', id);
      expect(await statusOf(t, id)).toBe('AWAITING_CUSTOMER');
      const line = (await checklistOf(t, id))[1];
      expect(line).toMatchObject({ status: 'REJECTED', rejectionReason: 'The photo is blurred' });
      const asked = (await historyOf(t, id)).pop()!;
      expect(asked).toMatchObject({ toStatus: 'AWAITING_CUSTOMER', customerVisible: true, customerMessage: 'Please replace the following document: Personal photo (The photo is blurred).' });
      expect(asked.meta).toMatchObject({ via: 'ENGINE', stepKey: 'verification', automatic: true, rejectedItemIds: [line.id] });
      const seen = (await t.as(customerActor).get(`/requests/${id}`).expect(200)).body;
      expect(seen.checklist[1]).toMatchObject({ status: 'REJECTED', note: 'The photo is blurred', actionRequired: true });

      // Resubmitting without replacing the document is refused with a clear message.
      const refused = await t.as(customerActor).post(`/requests/${id}/resubmit`).expect(422);
      expect(refused.body).toMatchObject({ code: 'REJECTED_DOCUMENTS_PENDING', message: 'These documents were not accepted and must be replaced first: Personal photo.' });

      // A new upload of that type replaces the rejected one (no checklist item id needed).
      const replacement = await uploadFor(t, alpha, id, photoLine, { withItemId: false });
      expect((await checklistOf(t, id))[1]).toMatchObject({ status: 'UPLOADED', documentId: replacement.id, rejectionReason: null });
      await t.as(customerActor).post(`/requests/${id}/resubmit`).expect(200);
      expect(await statusOf(t, id)).toBe('UNDER_REVIEW');
      await verifyDocument(t, alpha, replacement.id, id);
      expect((await stepsOf(t, id)).current).toBe('quotation');
      expect(await statusOf(t, id)).toBe('UNDER_REVIEW');
    });

    it('customer correction during preparation returns to preparation, not to document review', async () => {
      const service = await createService(t, alpha);
      const created = (await t.as(customerActor).post('/requests', { serviceId: service.id, fields: { purpose: 'family' } }).expect(201)).body;
      const id = created.id;
      await t.as(customerActor).post(`/requests/${id}/submit`).expect(200);
      await completeDocuments(t, alpha, id);
      const { invoice } = await approveQuotation(t, alpha, (await sendQuotation(t, alpha, id)).id);
      await payInvoice(t, alpha, invoice!.id);
      await assign(id, operator).expect(200);
      await move(operator, id, 'IN_PREPARATION').expect(200);

      // The customer can no longer edit a request that is being prepared.
      expect((await t.as(customerActor).put(`/requests/${id}/fields`, { values: { purpose: 'work' } }).expect(409)).body.code).toBe('REQUEST_NOT_EDITABLE');
      await t.as(operator).post(`/requests/${id}/request-information`, { message: 'Please confirm the name of your sponsor.' }).expect(200);
      expect(await statusOf(t, id)).toBe('AWAITING_CUSTOMER');

      // Once submitted, the whole form must stay valid.
      const invalid = await t.as(customerActor).put(`/requests/${id}/fields`, { values: { purpose: 'work' } }).expect(422);
      expect(invalid.body.details[0]).toMatchObject({ field: 'sponsor', code: 'REQUIRED' });
      await t.as(customerActor).put(`/requests/${id}/fields`, { values: { purpose: 'work', sponsor: 'ACME LLC' } }).expect(200);
      const back = (await t.as(customerActor).post(`/requests/${id}/resubmit`).expect(200)).body;
      expect(back.status).toBe('IN_PREPARATION');
      expect(back.form.values).toMatchObject({ purpose: 'work', sponsor: 'ACME LLC' });
      expect(back.form.fields.find((f: any) => f.key === 'sponsor').source).toBe('CUSTOMER');
      const wf = await stepsOf(t, id);
      expect(wf.current).toBe('prepare');
      expect(wf.steps.filter((s) => s.stepKey === 'prepare')).toHaveLength(1); // the same preparation continues
    });

    it('payment failure and partial payment do not move the request', async () => {
      const service = await createService(t, alpha);
      const customer = await createCustomer(t, alpha);
      const request = await submittedRequest(t, alpha, receptionist, service.id, customer.id);
      await completeDocuments(t, alpha, request.id);
      const { invoice } = await approveQuotation(t, alpha, (await sendQuotation(t, alpha, request.id, 400)).id);
      expect(await statusOf(t, request.id)).toBe('AWAITING_PAYMENT');

      await emit(t, alpha.id, 'payment.failed', { paymentId: '00000000-0000-4000-8000-000000000001', customerId: customer.id, requestId: request.id, reason: 'Card declined' });
      expect(await getRequest(t, request.id)).toMatchObject({ status: 'AWAITING_PAYMENT', paymentStatus: 'UNPAID' });

      await payInvoice(t, alpha, invoice!.id, 150);
      expect(await getRequest(t, request.id)).toMatchObject({ status: 'AWAITING_PAYMENT', paymentStatus: 'PARTIALLY_PAID' });
      const blocked = (await t.as(manager).get(`/requests/${request.id}`).expect(200)).body;
      expect(blocked.nextStep.step).toMatchObject({ key: 'payment', blocked: { code: 'PAYMENT_REQUIRED' } });
      expect(blocked.finance.totals).toEqual({ invoiced: '400.00', paid: '150.00', refunded: '0.00', balance: '250.00' });

      await payInvoice(t, alpha, invoice!.id); // the rest
      expect(await getRequest(t, request.id)).toMatchObject({ status: 'READY_FOR_PROCESSING', paymentStatus: 'PAID' });
    });

    it('review rejection sends the case back to preparation with the reviewer comment as internal reason', async () => {
      const request = await inPreparation();
      await move(operator, request.id, 'PENDING_APPROVAL').expect(200);
      const first = await t.sys.requestApproval.findFirstOrThrow({ where: { requestId: request.id, status: 'PENDING' } });
      // A rejection needs an explanation.
      await t.as(reviewer).post(`/requests/${request.id}/approvals/${first.id}/decide`, { decision: 'REJECTED' }).expect(400);
      const rejected = (await t.as(reviewer).post(`/requests/${request.id}/approvals/${first.id}/decide`, { decision: 'REJECTED', comment: 'Wrong visa category selected' }).expect(200)).body;
      expect(rejected.status).toBe('IN_PREPARATION');
      const row = (await historyOf(t, request.id)).pop()!;
      expect(row).toMatchObject({ fromStatus: 'PENDING_APPROVAL', toStatus: 'IN_PREPARATION', reason: 'Wrong visa category selected', customerVisible: false, actorId: reviewer.userId });
      let wf = await stepsOf(t, request.id);
      expect(wf.current).toBe('prepare');
      expect(wf.steps.filter((s) => s.stepKey === 'prepare').map((s) => [s.attempt, s.status])).toEqual([[1, 'COMPLETED'], [2, 'ACTIVE']]);
      expect(wf.steps.find((s) => s.stepKey === 'review')).toMatchObject({ status: 'COMPLETED', result: expect.objectContaining({ outcome: 'REJECTED', goTo: 'prepare' }) });
      expect((await openTasksOf(t, request.id)).map((x) => x.stepKey)).toEqual(['prepare']);
      // Deciding the same review twice is refused.
      expect((await t.as(reviewer).post(`/requests/${request.id}/approvals/${first.id}/decide`, { decision: 'APPROVED' }).expect(409)).body.code).toBe('ALREADY_DECIDED');

      // The second round gets a fresh review.
      await move(operator, request.id, 'PENDING_APPROVAL').expect(200);
      const approvals = await t.sys.requestApproval.findMany({ where: { requestId: request.id }, orderBy: { createdAt: 'asc' } });
      expect(approvals.map((a) => a.status)).toEqual(['REJECTED', 'PENDING']);
      await t.as(reviewer).post(`/requests/${request.id}/approvals/${approvals[1].id}/decide`, { decision: 'APPROVED' }).expect(200);
      wf = await stepsOf(t, request.id);
      expect(wf.current).toBe('submission');
      expect(wf.steps.filter((s) => s.stepKey === 'review').map((s) => [s.attempt, s.status])).toEqual([[1, 'COMPLETED'], [2, 'COMPLETED']]);
    });

    it('segregation of duties: whoever prepared the case cannot approve it', async () => {
      const service = await createService(t, alpha);
      const customer = await createCustomer(t, alpha);
      const request = await readyRequest(t, alpha, receptionist, service.id, customer.id);
      // The manager may both process and review, and prepares this case personally.
      await assign(request.id, manager).expect(200);
      expect((await assign(request.id, manager, 'REVIEWER').expect(409)).body.code).toBe('SEGREGATION_OF_DUTIES');
      await move(manager, request.id, 'IN_PREPARATION').expect(200);
      await move(manager, request.id, 'PENDING_APPROVAL').expect(200);
      const approval = await t.sys.requestApproval.findFirstOrThrow({ where: { requestId: request.id, status: 'PENDING' } });
      const own = await t.as(manager).post(`/requests/${request.id}/approvals/${approval.id}/decide`, { decision: 'APPROVED' }).expect(403);
      expect(own.body.code).toBe('SEGREGATION_OF_DUTIES');
      expect((await t.sys.requestApproval.findUniqueOrThrow({ where: { id: approval.id } })).status).toBe('PENDING');
      // The generic transition cannot be used to get around the review either.
      expect((await move(manager, request.id, 'READY_TO_SUBMIT').expect(422)).body.code).toBe('APPROVAL_REQUIRED');
      expect(await statusOf(t, request.id)).toBe('PENDING_APPROVAL');
      await t.as(reviewer).post(`/requests/${request.id}/approvals/${approval.id}/decide`, { decision: 'APPROVED' }).expect(200);
      expect(await statusOf(t, request.id)).toBe('READY_TO_SUBMIT');
    });

    it('application returned: corrected and submitted again with a new reference and a new review', async () => {
      const request = await inExternalProcessing();
      await t.as(operator).post(`/requests/${request.id}/external-result`, { outcome: 'RETURNED' }).expect(400); // what did the authority say?
      const returned = (await t.as(operator).post(`/requests/${request.id}/external-result`, { outcome: 'RETURNED', note: 'Sponsor file number missing' }).expect(200)).body;
      expect(returned.status).toBe('RETURNED');
      expect(returned.externalStatus).toMatchObject({ status: 'RETURNED', source: 'STAFF_ENTERED' });
      expect(returned.externalReferences[0]).toMatchObject({ status: 'RETURNED', result: 'RETURNED', notes: 'Sponsor file number missing' });
      expect((await stepsOf(t, request.id)).status('submission')).toBe('ACTIVE'); // the step stays open

      // "Correct and resubmit".
      await move(operator, request.id, 'IN_PREPARATION').expect(200);
      let wf = await stepsOf(t, request.id);
      expect(wf.current).toBe('prepare');
      expect(wf.steps.filter((s) => s.stepKey === 'submission').map((s) => s.status)).toEqual(['CANCELLED']);
      // The earlier approval no longer counts: the corrected application is reviewed again.
      expect((await t.sys.requestApproval.findFirstOrThrow({ where: { requestId: request.id } })).payload).toMatchObject({ supersededBecause: 'Returned to preparation from RETURNED' });
      expect((await move(operator, request.id, 'READY_TO_SUBMIT').expect(422)).body.code).toBe('APPROVAL_REQUIRED');
      await move(operator, request.id, 'PENDING_APPROVAL').expect(200);
      const approval = await t.sys.requestApproval.findFirstOrThrow({ where: { requestId: request.id, status: 'PENDING' } });
      await t.as(reviewer).post(`/requests/${request.id}/approvals/${approval.id}/decide`, { decision: 'APPROVED' }).expect(200);

      // The old reference has a result, so a new submission must be recorded.
      expect((await move(operator, request.id, 'EXTERNAL_PROCESSING').expect(422)).body.code).toBe('EXTERNAL_REFERENCE_REQUIRED');
      const again = (await t.as(operator).post(`/requests/${request.id}/external-references`, { channel: 'MANUAL_PORTAL', referenceNo: 'SECOND-TRY-1' }).expect(201)).body;
      expect(again.status).toBe('EXTERNAL_PROCESSING');
      expect(again.externalReferences.map((r: any) => [r.referenceNo, r.result])).toEqual([[`REF-${request.requestNo}`, 'RETURNED'], ['SECOND-TRY-1', null]]);
      await t.as(operator).post(`/requests/${request.id}/external-result`, { outcome: 'COMPLETED' }).expect(200);
      wf = await stepsOf(t, request.id);
      expect(wf.current).toBe('completion');
      expect(await pathOf(t, request.id)).toEqual([
        'DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'QUOTED', 'AWAITING_PAYMENT', 'READY_FOR_PROCESSING', 'IN_PREPARATION', 'PENDING_APPROVAL', 'READY_TO_SUBMIT', 'EXTERNAL_PROCESSING',
        'RETURNED', 'IN_PREPARATION', 'PENDING_APPROVAL', 'READY_TO_SUBMIT', 'EXTERNAL_PROCESSING', 'FINAL_REVIEW',
      ]);
    });

    it('application returned because of the customer: the question goes out and the answer returns to preparation', async () => {
      const request = await inExternalProcessing();
      await move(operator, request.id, 'RETURNED', { reason: 'Photo not accepted by the authority' }).expect(200);
      // Marking it returned through the generic endpoint records the outcome on the open submission too.
      expect(await t.sys.requestExternalReference.findFirstOrThrow({ where: { requestId: request.id } })).toMatchObject({ status: 'RETURNED', statusSource: 'STAFF_ENTERED', notes: 'Photo not accepted by the authority' });
      await t.as(operator).post(`/requests/${request.id}/request-information`, { message: 'The authority needs a photo with a white background.' }).expect(200);
      expect(await statusOf(t, request.id)).toBe('AWAITING_CUSTOMER');
      await t.as(receptionist).post(`/requests/${request.id}/resubmit`, { note: 'Customer brought a new photo' }).expect(200);
      expect(await statusOf(t, request.id)).toBe('IN_PREPARATION');
      expect((await stepsOf(t, request.id)).current).toBe('prepare');
    });

    it('application rejected: the outcome is recorded with its source and a new application needs a reason', async () => {
      const direct = await inExternalProcessing();
      const rejected = (await t.as(operator).post(`/requests/${direct.id}/external-result`, { outcome: 'REJECTED', note: 'Applicant not eligible' }).expect(200)).body;
      expect(rejected.status).toBe('REJECTED');
      expect(rejected.statusLabel.en).toBe('Rejected');
      expect(rejected.externalReferences[0]).toMatchObject({ result: 'REJECTED', statusSource: 'STAFF_ENTERED', statusSourceLabel: STATUS_SOURCE_LABEL.STAFF_ENTERED });
      const history = await historyOf(t, direct.id);
      expect(history[history.length - 1]).toMatchObject({ toStatus: 'REJECTED', reason: 'Applicant not eligible', customerVisible: true, customerMessage: 'Application was not accepted' });
      // The reference can no longer be edited into something else.
      expect((await t.as(operator).patch(`/requests/${direct.id}/external-references/${rejected.externalReferences[0].id}`, { status: 'Approved' }).expect(409)).body.code).toBe('RESULT_ALREADY_RECORDED');
      expect((await move(operator, direct.id, 'IN_PREPARATION').expect(422)).body.code).toBe('REASON_REQUIRED');
      await move(operator, direct.id, 'IN_PREPARATION', { reason: 'Customer provided a new sponsor; preparing a new application' }).expect(200);
      expect((await stepsOf(t, direct.id)).current).toBe('prepare');
      // Or the case is closed instead.
      const other = await inExternalProcessing();
      await t.as(operator).post(`/requests/${other.id}/external-result`, { outcome: 'REJECTED', note: 'Not eligible' }).expect(200);
      await t.as(manager).post(`/requests/${other.id}/cancel`, { reason: 'Application rejected by the authority' }).expect(200);
      expect(await statusOf(t, other.id)).toBe('CANCELLED');
    });

    it('external processing delay: the overdue step and the overdue request are escalated exactly once', async () => {
      const request = await inExternalProcessing();
      const clock = t.get(Clock);
      await t.jobs.runScheduled(SCAN_JOB);
      expect((await tasksOf(t, request.id)).filter((x) => x.source === 'ESCALATION')).toHaveLength(0);

      clock.travelHours(121); // the submission step allows 120 hours; the target date (48 h) has passed as well
      await t.jobs.runScheduled(SCAN_JOB);
      let escalations = (await tasksOf(t, request.id)).filter((x) => x.source === 'ESCALATION');
      expect(escalations.map((x) => [x.stepKey, x.roleKey, x.type, x.status, x.priority]).sort()).toEqual([['overdue', 'manager', 'ESCALATION', 'OPEN', 'HIGH'], ['submission', 'manager', 'ESCALATION', 'OPEN', 'HIGH']]);
      expect(escalations.find((x) => x.stepKey === 'submission')!.title).toBe(`Overdue step: Submission and external processing - ${request.requestNo}`);
      expect((await eventsOf(t, alpha.id, request.id, 'request.step_overdue')).map((e) => e.payload)).toEqual([expect.objectContaining({ stepKey: 'submission', stepName: 'Submission and external processing', escalateToRoleKey: 'manager' })]);
      expect((await eventsOf(t, alpha.id, request.id, 'request.overdue')).map((e) => e.payload)).toEqual([expect.objectContaining({ requestId: request.id, assigneeUserId: operator.userId })]);
      expect((await stepsOf(t, request.id)).steps.find((s) => s.stepKey === 'submission')!.escalatedAt).toBeTruthy();
      const view = (await t.as(manager).get(`/requests/${request.id}`).expect(200)).body;
      expect(view.overdue).toBe(true);
      expect(view.workflow.steps.find((s: any) => s.key === 'submission').escalatedAt).toBeTruthy();

      // Idempotent: running the scan again (twice, a day later) escalates nothing new.
      await t.jobs.runScheduled(SCAN_JOB);
      clock.travelHours(24);
      await t.jobs.runScheduled(SCAN_JOB);
      escalations = (await tasksOf(t, request.id)).filter((x) => x.source === 'ESCALATION');
      expect(escalations).toHaveLength(2);
      expect(await eventsOf(t, alpha.id, request.id, 'request.step_overdue')).toHaveLength(1);
      expect(await eventsOf(t, alpha.id, request.id, 'request.overdue')).toHaveLength(1);

      // A new target date re-arms the overdue flag; the result closes the step escalation.
      const later = new Date(clock.now().getTime() + 2 * 3_600_000).toISOString();
      await t.as(manager).patch(`/requests/${request.id}`, { targetDate: later }).expect(200);
      await t.jobs.runScheduled(SCAN_JOB);
      expect(await eventsOf(t, alpha.id, request.id, 'request.overdue')).toHaveLength(1);
      clock.travelHours(3);
      await t.jobs.runScheduled(SCAN_JOB);
      expect(await eventsOf(t, alpha.id, request.id, 'request.overdue')).toHaveLength(2);
      await t.as(operator).post(`/requests/${request.id}/external-result`, { outcome: 'COMPLETED' }).expect(200);
      expect((await tasksOf(t, request.id)).find((x) => x.source === 'ESCALATION' && x.stepKey === 'submission')!.status).toBe('DONE');
    });

    it('customer cancellation: allowed before processing, never refunds by itself, flags money for finance', async () => {
      const service = await createService(t, alpha);
      const id = (await t.as(customerActor).post('/requests', { serviceId: service.id, fields: { purpose: 'family' } }).expect(201)).body.id;
      await t.as(customerActor).post(`/requests/${id}/submit`).expect(200);
      await completeDocuments(t, alpha, id);
      const { invoice } = await approveQuotation(t, alpha, (await sendQuotation(t, alpha, id, 300)).id);
      await payInvoice(t, alpha, invoice!.id, 100); // a part payment is already in
      expect(await statusOf(t, id)).toBe('AWAITING_PAYMENT');

      await t.as(customerActor).post(`/requests/${id}/cancel`, {}).expect(400); // a reason is mandatory
      const cancelled = (await t.as(customerActor).post(`/requests/${id}/cancel`, { reason: 'I no longer need the visa' }).expect(200)).body;
      expect(cancelled.status).toBe('CANCELLED');
      expect(cancelled.allowedActions.transitions).toEqual([]);
      const row = await getRequest(t, id);
      expect(row).toMatchObject({ status: 'CANCELLED', cancellationReason: 'I no longer need the visa', paymentStatus: 'PARTIALLY_PAID' });
      expect(row.cancelledAt).toBeTruthy();
      const last = (await historyOf(t, id)).pop()!;
      expect(last.meta).toMatchObject({ refundReviewNeeded: true, amountHeld: '100.00' });
      expect((await eventsOf(t, alpha.id, id, 'request.cancelled'))[0].payload).toMatchObject({ requestId: id, reason: 'I no longer need the visa', refundReviewNeeded: true, amountHeld: '100.00' });
      // No refund was created: that is a finance decision.
      expect(await t.sys.refund.count({ where: { tenantId: alpha.id, requestId: id } })).toBe(0);
      expect((await eventsOf(t, alpha.id, id)).filter((e) => e.type.startsWith('refund.'))).toEqual([]);
      const wf = await stepsOf(t, id);
      expect(wf.execution!.status).toBe('CANCELLED');
      expect(wf.status('payment')).toBe('CANCELLED');
      expect(await openTasksOf(t, id)).toHaveLength(0);

      // A late payment on the cancelled request is recorded and changes nothing else.
      await payInvoice(t, alpha, invoice!.id);
      expect(await getRequest(t, id)).toMatchObject({ status: 'CANCELLED', paymentStatus: 'PAID' });
      expect((await stepsOf(t, id)).execution!.status).toBe('CANCELLED');
      // Finance refunds it later (refund.completed): the payment status follows.
      await t.sys.invoice.update({ where: { id: invoice!.id }, data: { amountRefunded: 300, balanceDue: 300 } });
      await emit(t, alpha.id, 'refund.completed', { refundId: '00000000-0000-4000-8000-000000000002', paymentId: '00000000-0000-4000-8000-000000000003', invoiceId: invoice!.id, requestId: id, amount: '300.00', currency: 'AED' });
      expect(await getRequest(t, id)).toMatchObject({ status: 'CANCELLED', paymentStatus: 'REFUNDED' });
      // Cancelled is final.
      expect((await move(manager, id, 'IN_PREPARATION', { reason: 'undo' }).expect(409)).body.code).toBe('INVALID_TRANSITION');
    });

    it('customer cancellation is not possible once the request is released for processing', async () => {
      const service = await createService(t, alpha);
      const id = (await t.as(customerActor).post('/requests', { serviceId: service.id, fields: { purpose: 'family' } }).expect(201)).body.id;
      await t.as(customerActor).post(`/requests/${id}/submit`).expect(200);
      await completeDocuments(t, alpha, id);
      const { invoice } = await approveQuotation(t, alpha, (await sendQuotation(t, alpha, id)).id);
      await payInvoice(t, alpha, invoice!.id);
      expect(await statusOf(t, id)).toBe('READY_FOR_PROCESSING');
      const refused = await t.as(customerActor).post(`/requests/${id}/cancel`, { reason: 'Changed my mind' }).expect(403);
      expect(refused.body).toMatchObject({ code: 'CANCELLATION_NOT_ALLOWED', message: 'This request is already being processed, so it can no longer be cancelled online. Please contact the centre.' });
      expect((await t.as(customerActor).get(`/requests/${id}`).expect(200)).body.allowedActions.transitions).toEqual([]);
      // Staff with the permission still can; a receptionist cannot.
      await t.as(receptionist).post(`/requests/${id}/cancel`, { reason: 'Customer asked at the counter' }).expect(403);
      const cancelled = await t.as(manager).post(`/requests/${id}/cancel`, { reason: 'Customer asked at the counter' }).expect(200);
      expect(cancelled.body.status).toBe('CANCELLED');
      expect((await historyOf(t, id)).pop()!.meta).toMatchObject({ refundReviewNeeded: true, amountHeld: '500.00' });
    });

    it('duplicate request: linked to the original and cancelled with the reason', async () => {
      const service = await createService(t, alpha);
      const customer = await createCustomer(t, alpha);
      const original = await submittedRequest(t, alpha, receptionist, service.id, customer.id);
      const copy = await submittedRequest(t, alpha, receptionist, service.id, customer.id);
      await t.as(receptionist).post(`/requests/${copy.id}/mark-duplicate`, { duplicateOfId: original.id }).expect(403);
      expect((await t.as(manager).post(`/requests/${copy.id}/mark-duplicate`, { duplicateOfId: copy.id }).expect(422)).body.code).toBe('SAME_REQUEST');
      await t.as(manager).post(`/requests/${copy.id}/mark-duplicate`, { duplicateOfId: '00000000-0000-4000-8000-00000000dead' }).expect(404);

      const marked = (await t.as(manager).post(`/requests/${copy.id}/mark-duplicate`, { duplicateOfId: original.id }).expect(200)).body;
      expect(marked).toMatchObject({ status: 'CANCELLED', duplicateOfId: original.id, cancellationReason: `Duplicate of ${original.requestNo}` });
      expect((await historyOf(t, copy.id)).pop()).toMatchObject({ toStatus: 'CANCELLED', reason: `Duplicate of ${original.requestNo}`, customerMessage: `This request was a duplicate of ${original.requestNo} and has been closed.` });
      expect((await eventsOf(t, alpha.id, copy.id, 'request.cancelled'))[0].payload).toMatchObject({ reason: `Duplicate of ${original.requestNo}`, refundReviewNeeded: false });
      expect(await statusOf(t, original.id)).toBe('SUBMITTED');
      // Not twice, and not in a circle.
      expect((await t.as(manager).post(`/requests/${copy.id}/mark-duplicate`, { duplicateOfId: original.id }).expect(409)).body.code).toBe('INVALID_TRANSITION');
      expect((await t.as(manager).post(`/requests/${original.id}/mark-duplicate`, { duplicateOfId: copy.id }).expect(422)).body.code).toBe('CIRCULAR_DUPLICATE');
    });

    it('reassignment: needs a reason, closes the previous assignment and moves access and tasks', async () => {
      const request = await inPreparation();
      // Unsuitable assignees are refused with the reason.
      expect((await assign(request.id, receptionist, 'OPERATOR', 'cover').expect(422)).body.code).toBe('ASSIGNEE_ROLE_NOT_SUITABLE');
      expect((await assign(request.id, operator, 'REVIEWER').expect(422)).body.code).toBe('ASSIGNEE_ROLE_NOT_SUITABLE');
      expect((await assign(request.id, accountant, 'REVIEWER').expect(422)).body.code).toBe('ASSIGNEE_ROLE_NOT_SUITABLE');
      expect((await assign(request.id, operator, 'OPERATOR', 'again').expect(409)).body.code).toBe('ALREADY_ASSIGNED');
      const elsewhere = (await t.as(alpha.owner).post('/branches', { code: `B${Date.now() % 100000}`, name: 'Second branch' }).expect(201)).body;
      const remote = await t.addStaff(alpha, 'operator', { branchIds: [elsewhere.id] });
      expect((await assign(request.id, remote, 'OPERATOR', 'cover').expect(422)).body.code).toBe('ASSIGNEE_NOT_AT_BRANCH');
      await t.as(manager).post(`/requests/${request.id}/assign`, { assigneeMembershipId: '00000000-0000-4000-8000-00000000dead' }).expect(404);
      await t.as(operator).post(`/requests/${request.id}/assign`, { assigneeMembershipId: operator2.membershipId, reason: 'x' }).expect(403);

      expect((await assign(request.id, operator2).expect(422)).body).toMatchObject({ code: 'REASON_REQUIRED', message: 'Please give a reason for the reassignment.' });
      const reassigned = (await assign(request.id, operator2, 'OPERATOR', 'Colleague is on sick leave').expect(200)).body;
      expect(reassigned.assignee.membershipId).toBe(operator2.membershipId);
      expect(reassigned.assignments.map((a: any) => [a.assigneeMembershipId, a.reason, !!a.unassignedAt])).toEqual([[operator.membershipId, null, true], [operator2.membershipId, 'Colleague is on sick leave', false]]);
      expect((await eventsOf(t, alpha.id, request.id, 'request.assigned')).map((e) => e.payload.assigneeMembershipId)).toEqual([operator.membershipId, operator2.membershipId]);
      const audit = await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: alpha.id, resourceId: request.id, action: 'request.reassigned' } });
      expect(audit.actorUserId).toBe(manager.userId);
      expect(audit.after).toMatchObject({ assignedToId: operator2.membershipId, reason: 'Colleague is on sick leave' });
      // The open preparation task moved with the case.
      const task = (await openTasksOf(t, request.id))[0];
      expect(task.taskAssignments.map((a) => [a.assigneeId, !!a.unassignedAt])).toEqual([[operator.membershipId, true], [operator2.membershipId, false]]);
      // Access follows the assignment.
      await t.as(operator).get(`/requests/${request.id}`).expect(404);
      await move(operator, request.id, 'PENDING_APPROVAL').expect(404);
      await t.as(operator2).get(`/requests/${request.id}`).expect(200);
      await move(operator2, request.id, 'PENDING_APPROVAL').expect(200);
    });

    it('reopening: only with the permission and a reason; the workflow restarts at preparation and needs a new review', async () => {
      const request = await inExternalProcessing();
      await t.as(operator).post(`/requests/${request.id}/external-result`, { outcome: 'COMPLETED' }).expect(200);
      await t.as(reviewer).post(`/requests/${request.id}/complete`).expect(200);
      expect((await stepsOf(t, request.id)).execution!.status).toBe('COMPLETED');

      await t.as(reviewer).post(`/requests/${request.id}/reopen`, { reason: 'Typo in the name' }).expect(403);
      await t.as(manager).post(`/requests/${request.id}/reopen`, {}).expect(400);
      expect((await move(manager, request.id, 'IN_PREPARATION').expect(422)).body.code).toBe('REASON_REQUIRED');
      const reopened = (await t.as(manager).post(`/requests/${request.id}/reopen`, { reason: 'Typo in the name on the issued visa' }).expect(200)).body;
      expect(reopened).toMatchObject({ status: 'IN_PREPARATION', reopenedCount: 1, completedAt: null });
      expect((await historyOf(t, request.id)).pop()).toMatchObject({ fromStatus: 'COMPLETED', toStatus: 'IN_PREPARATION', reason: 'Typo in the name on the issued visa', actorId: manager.userId });
      const wf = await stepsOf(t, request.id);
      expect(wf.execution).toMatchObject({ status: 'ACTIVE', currentStepKey: 'prepare', completedAt: null });
      expect(wf.steps.filter((s) => s.stepKey === 'prepare').map((s) => [s.attempt, s.status])).toEqual([[1, 'COMPLETED'], [2, 'ACTIVE']]);
      expect((await openTasksOf(t, request.id)).map((x) => [x.stepKey, x.taskAssignments.map((a) => a.assigneeId)])).toEqual([['prepare', [operator.membershipId]]]);
      // The rework is reviewed again before it can be submitted or completed.
      expect(reopened.approvals[0]).toMatchObject({ status: 'APPROVED', superseded: true });
      expect((await move(operator, request.id, 'READY_TO_SUBMIT').expect(422)).body.code).toBe('APPROVAL_REQUIRED');
      await move(operator, request.id, 'PENDING_APPROVAL').expect(200);
      const approval = await t.sys.requestApproval.findFirstOrThrow({ where: { requestId: request.id, status: 'PENDING' } });
      await t.as(reviewer).post(`/requests/${request.id}/approvals/${approval.id}/decide`, { decision: 'APPROVED' }).expect(200);
      await t.as(operator).post(`/requests/${request.id}/external-references`, { channel: 'MANUAL_PORTAL', referenceNo: 'AMENDMENT-1' }).expect(201);
      await t.as(operator).post(`/requests/${request.id}/external-result`, { outcome: 'COMPLETED' }).expect(200);
      const again = (await t.as(manager).post(`/requests/${request.id}/complete`).expect(200)).body;
      expect(again).toMatchObject({ status: 'COMPLETED', reopenedCount: 1 });
      expect((await stepsOf(t, request.id)).execution!.status).toBe('COMPLETED');
      expect((await eventsOf(t, alpha.id, request.id, 'request.completed'))).toHaveLength(2);
    });
  });
});
