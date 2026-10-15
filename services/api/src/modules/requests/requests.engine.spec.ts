import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATUS_SOURCE_LABEL } from '@typease/types';
import { Actor, TenantFixture, TestApp, uniq } from '../../../test/helpers';
import { DomainEvents } from '../../common/events.service';
import type { GeneratedDocumentInput } from '../../common/ports';
import { ExternalProcessingService } from './external-processing.service';
import {
  approveQuotation, checklistOf, completeDocuments, createCustomer, createService, emit, eventsOf, getRequest, historyOf, openTasksOf, pathOf, payInvoice, readyRequest,
  rejectQuotation, sendQuotation, statusOf, stepsOf, submittedRequest, tasksOf, ServiceOptions,
} from './fixtures';
import { OfficialSubmissionPort } from './official-submission.port';
import { RequestStateMachine } from './request-state-machine.service';
import { ADVANCE_JOB, SCAN_JOB, WorkflowEngine } from './workflow-engine.service';

describe('Workflow engine and external processing', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let manager: Actor;
  let receptionist: Actor;
  let operator: Actor;
  let reviewer: Actor;
  let engine: WorkflowEngine;
  let realDocumentStore: unknown;

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    manager = await t.addStaff(alpha, 'manager');
    receptionist = await t.addStaff(alpha, 'receptionist');
    operator = await t.addStaff(alpha, 'operator');
    reviewer = await t.addStaff(alpha, 'reviewer');
    engine = t.get(WorkflowEngine);
    realDocumentStore = (engine as any).documentStore; // undefined unless the documents module is loaded too
  });
  afterAll(() => t.close());
  afterEach(() => {
    (engine as any).documentStore = realDocumentStore;
    (t.get(ExternalProcessingService) as any).officialPort = undefined;
    jest.restoreAllMocks();
  });

  const move = (actor: Actor, id: string, to: string, extra: object = {}) => t.as(actor).post(`/requests/${id}/transition`, { to, ...extra });
  const assign = (id: string, who: Actor, role = 'OPERATOR', tenantManager: Actor = manager) => t.as(tenantManager).post(`/requests/${id}/assign`, { assigneeMembershipId: who.membershipId, role });
  const advance = (tenant: TenantFixture, id: string) => t.inTenant(tenant.id, () => t.db.tx((tx) => engine.advance(tx, id)));
  const definitionId = async (tenant: TenantFixture, key: string) => (await t.sys.workflowDefinition.findFirstOrThrow({ where: { tenantId: tenant.id, key } })).id;
  const step = (key: string, type: string, extra: object = {}) => ({ key, name: key, type, ...extra });
  async function customWorkflow(tenant: TenantFixture, steps: object[], actor: Actor = tenant.owner) {
    const res = await t.as(actor).post('/workflows', { key: `wf-${uniq()}`, name: 'Custom workflow', steps, publish: true });
    if (res.status !== 201) throw new Error(`workflow not created: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as { id: string; versionId: string };
  }
  /** A request in preparation under the given service options. */
  async function preparing(options: ServiceOptions = {}) {
    const service = await createService(t, alpha, options);
    const request = await readyRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
    await assign(request.id, operator).expect(200);
    await move(operator, request.id, 'IN_PREPARATION').expect(200);
    return request;
  }

  // =====================================================================================
  describe('workflow versions', () => {
    let gamma: TenantFixture;
    let gammaOperator: Actor;
    let standardId: string;
    const stepsBody = (steps: any[]) => steps.map(({ id: _id, position: _position, ...s }) => s);

    beforeAll(async () => {
      gamma = await t.createTenant({ name: 'Gamma Versions' });
      gammaOperator = await t.addStaff(gamma, 'operator');
      standardId = await definitionId(gamma, 'standard');
    });

    it('existing cases keep their version, new cases get the new one, and one case can be migrated explicitly', async () => {
      const service = await createService(t, gamma, { requiresApproval: false, complianceCapability: 'DOCUMENT_PREPARATION_ONLY' });
      const customer = await createCustomer(t, gamma);
      const v1 = (await t.as(gamma.owner).get(`/workflows/${standardId}`).expect(200)).body.publishedVersion;
      expect(v1.version).toBe(1);

      const old = await submittedRequest(t, gamma, gamma.owner, service.id, customer.id);
      expect((await getRequest(t, old.id)).workflowVersionId).toBe(v1.id);

      // Version 2 adds a customer notification before final review.
      const draft = (await t.as(gamma.owner).post(`/workflows/${standardId}/versions`, {}).expect(201)).body;
      const next = stepsBody(draft.steps);
      next.splice(next.length - 1, 0, { key: 'almost-done', name: 'Almost done', type: 'NOTIFICATION', config: { message: 'Your documents are in final checks.' }, customerVisible: true });
      await t.as(gamma.owner).put(`/workflows/${standardId}/versions/${draft.id}/steps`, { steps: next }).expect(200);
      // Saving a draft changes nothing for anybody.
      expect((await t.sys.workflowDefinition.findUniqueOrThrow({ where: { id: standardId } })).publishedVersionId).toBe(v1.id);
      const v2 = (await t.as(gamma.owner).post(`/workflows/${standardId}/versions/${draft.id}/publish`).expect(200)).body;
      expect(v2).toMatchObject({ version: 2, status: 'PUBLISHED' });

      // The running case is untouched; the new case uses version 2.
      expect((await getRequest(t, old.id)).workflowVersionId).toBe(v1.id);
      expect((await stepsOf(t, old.id)).execution).toMatchObject({ versionId: v1.id, migratedFromVersionId: null });
      const fresh = await submittedRequest(t, gamma, gamma.owner, service.id, customer.id);
      expect((await getRequest(t, fresh.id)).workflowVersionId).toBe(v2.id);
      const oldView = (await t.as(gamma.owner).get(`/requests/${old.id}`).expect(200)).body;
      const freshView = (await t.as(gamma.owner).get(`/requests/${fresh.id}`).expect(200)).body;
      expect(oldView.workflow).toMatchObject({ version: 1, versionId: v1.id });
      expect(oldView.workflow.steps.map((s: any) => s.key)).not.toContain('almost-done');
      expect(freshView.workflow).toMatchObject({ version: 2 });
      expect(freshView.workflow.steps.map((s: any) => s.key)).toContain('almost-done');

      // The old case keeps working on version 1 right to the end.
      await completeDocuments(t, gamma, old.id);
      expect((await stepsOf(t, old.id)).current).toBe('quotation');
      expect((await stepsOf(t, old.id)).execution!.versionId).toBe(v1.id);

      // Explicit migration of that one case: the current step is matched by key.
      await t.as(gammaOperator).post(`/requests/${old.id}/workflow/migrate`).expect(403);
      const migrated = (await t.as(gamma.owner).post(`/requests/${old.id}/workflow/migrate`).expect(200)).body;
      expect(migrated.migration).toEqual({ fromVersion: 1, toVersion: 2, currentStepKey: 'quotation' });
      expect(migrated.workflow).toMatchObject({ version: 2, versionId: v2.id, migratedFromVersionId: v1.id, currentStepKey: 'quotation' });
      expect(migrated.workflow.steps.map((s: any) => s.key)).toContain('almost-done');
      expect(await getRequest(t, old.id)).toMatchObject({ workflowVersionId: v2.id, status: 'UNDER_REVIEW' });
      const audit = await t.sys.auditLog.findFirstOrThrow({ where: { resourceId: old.id, action: 'request.workflow_migrated' } });
      expect(audit).toMatchObject({ actorUserId: gamma.owner.userId, before: { workflowVersionId: v1.id, version: 1 }, after: { workflowVersionId: v2.id, version: 2, currentStepKey: 'quotation' } });
      expect((await t.as(gamma.owner).post(`/requests/${old.id}/workflow/migrate`).expect(409)).body.code).toBe('ALREADY_CURRENT');

      // The migrated case now runs the new step: the notification fires before final review.
      const { invoice } = await approveQuotation(t, gamma, (await sendQuotation(t, gamma, old.id)).id);
      await payInvoice(t, gamma, invoice!.id);
      await assign(old.id, gammaOperator, 'OPERATOR', gamma.owner).expect(200);
      await move(gammaOperator, old.id, 'IN_PREPARATION').expect(200);
      await move(gammaOperator, old.id, 'FINAL_REVIEW').expect(200);
      const history = await historyOf(t, old.id);
      const note = history.find((h) => (h.meta as any).kind === 'NOTE')!;
      expect(note).toMatchObject({ fromStatus: 'FINAL_REVIEW', toStatus: 'FINAL_REVIEW', customerVisible: true, customerMessage: 'Your documents are in final checks.' });
      expect((await stepsOf(t, old.id)).status('almost-done')).toBe('COMPLETED');
    });

    it('migration is refused, with an explanation, when the current step no longer exists', async () => {
      const service = await createService(t, gamma);
      const stuck = await submittedRequest(t, gamma, gamma.owner, service.id, (await createCustomer(t, gamma)).id);
      expect((await stepsOf(t, stuck.id)).current).toBe('documents');
      const before = await getRequest(t, stuck.id);

      // Version 3 renames the key of the upload step.
      const draft = (await t.as(gamma.owner).post(`/workflows/${standardId}/versions`, {}).expect(201)).body;
      const renamed = stepsBody(draft.steps).map((s: any) => (s.key === 'documents' ? { ...s, key: 'uploads' } : s));
      await t.as(gamma.owner).put(`/workflows/${standardId}/versions/${draft.id}/steps`, { steps: renamed }).expect(200);
      await t.as(gamma.owner).post(`/workflows/${standardId}/versions/${draft.id}/publish`).expect(200);

      const refused = await t.as(gamma.owner).post(`/requests/${stuck.id}/workflow/migrate`).expect(409);
      expect(refused.body).toMatchObject({
        code: 'STEP_NOT_IN_TARGET',
        message: 'The request is at the step "Upload documents" (documents), which does not exist in version 3. Finish this step first, or keep the request on version 2.',
        details: { stepKey: 'documents', fromVersion: 2, toVersion: 3 },
      });
      expect(await getRequest(t, stuck.id)).toMatchObject({ workflowVersionId: before.workflowVersionId, version: before.version });
      expect((await stepsOf(t, stuck.id)).execution).toMatchObject({ versionId: before.workflowVersionId, migratedFromVersionId: null });
      // Once the case has moved past that step, it can be migrated.
      await completeDocuments(t, gamma, stuck.id);
      const migrated = (await t.as(gamma.owner).post(`/requests/${stuck.id}/workflow/migrate`).expect(200)).body;
      expect(migrated.migration).toEqual({ fromVersion: 2, toVersion: 3, currentStepKey: 'quotation' });
      // Closed cases keep the workflow they were processed with.
      await t.as(gamma.owner).post(`/requests/${stuck.id}/cancel`, { reason: 'No longer needed' }).expect(200);
      expect((await t.as(gamma.owner).post(`/requests/${stuck.id}/workflow/migrate`).expect(409)).body.code).toBe('REQUEST_CLOSED');
    });

    it('rollback publishes a copy of an older version; history is never rewritten', async () => {
      const versions = (await t.as(gamma.owner).get(`/workflows/${standardId}/versions`).expect(200)).body;
      expect(versions.map((v: any) => [v.version, v.status])).toEqual([[3, 'PUBLISHED'], [2, 'ARCHIVED'], [1, 'ARCHIVED']]);
      const v1 = versions.find((v: any) => v.version === 1);
      const v1Before = (await t.as(gamma.owner).get(`/workflows/${standardId}/versions/${v1.id}`).expect(200)).body;

      const rolled = (await t.as(gamma.owner).post(`/workflows/${standardId}/versions/${v1.id}/rollback`).expect(200)).body;
      expect(rolled).toMatchObject({ version: 4, status: 'PUBLISHED', notes: 'Rollback to version 1.' });
      expect(rolled.steps.map((s: any) => s.key)).toEqual(v1Before.steps.map((s: any) => s.key));
      expect(rolled.id).not.toBe(v1.id);
      // Version 1 itself is still what it was, and versions 2 and 3 still exist for the cases that use them.
      expect((await t.as(gamma.owner).get(`/workflows/${standardId}/versions/${v1.id}`).expect(200)).body).toEqual(v1Before);
      const after = (await t.as(gamma.owner).get(`/workflows/${standardId}/versions`).expect(200)).body;
      expect(after.map((v: any) => [v.version, v.status])).toEqual([[4, 'PUBLISHED'], [3, 'ARCHIVED'], [2, 'ARCHIVED'], [1, 'ARCHIVED']]);
      expect(after.find((v: any) => v.version === 3).casesUsing).toBeGreaterThan(0);

      // New cases get the rolled-back workflow.
      const service = await createService(t, gamma);
      const fresh = await submittedRequest(t, gamma, gamma.owner, service.id, (await createCustomer(t, gamma)).id);
      expect((await getRequest(t, fresh.id)).workflowVersionId).toBe(rolled.id);
      expect((await stepsOf(t, fresh.id)).current).toBe('documents');
      expect((await t.as(gamma.owner).post(`/workflows/${standardId}/versions/${rolled.id}/rollback`).expect(409)).body.code).toBe('ALREADY_PUBLISHED');
    });
  });

  // =====================================================================================
  describe('compliance is enforced by the engine, not by the workflow', () => {
    it('a custom workflow without verification, payment or review still cannot skip any of them', async () => {
      // The centre "simplified" its workflow: prepare, submit, done.
      const shortcut = await customWorkflow(alpha, [step('task', 'STAFF_TASK'), step('submit', 'EXTERNAL_PROCESSING'), step('done', 'COMPLETION')]);
      const service = await createService(t, alpha, { workflowDefinitionId: shortcut.id, requiresApproval: true, complianceCapability: 'DOCUMENT_PREPARATION_ONLY', paymentPolicy: 'BEFORE_PROCESSING' });
      const request = await submittedRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
      const id = request.id;
      expect((await getRequest(t, id)).workflowVersionId).toBe(shortcut.versionId);
      const blockedBy = async () => ((await stepsOf(t, id)).steps.find((s) => s.status === 'ACTIVE')?.result as any)?.blocked?.code ?? null;

      // 1. Documents: the workflow has no verification step, the release for processing still needs them.
      expect(await statusOf(t, id)).toBe('UNDER_REVIEW');
      expect([(await stepsOf(t, id)).current, await blockedBy()]).toEqual(['task', 'DOCUMENTS_NOT_VERIFIED']);
      expect(await openTasksOf(t, id)).toHaveLength(0); // no preparation task before the request is released
      expect((await move(reviewer, id, 'READY_FOR_PROCESSING').expect(422)).body.code).toBe('DOCUMENTS_NOT_VERIFIED');
      await completeDocuments(t, alpha, id);

      // 2. Payment: the service is paid before processing, whatever the workflow leaves out.
      expect([await statusOf(t, id), await blockedBy()]).toEqual(['UNDER_REVIEW', 'PAYMENT_REQUIRED']);
      expect((await move(reviewer, id, 'READY_FOR_PROCESSING').expect(422)).body.code).toBe('PAYMENT_REQUIRED');
      const { invoice } = await approveQuotation(t, alpha, (await sendQuotation(t, alpha, id, 300)).id);
      expect(await statusOf(t, id)).toBe('UNDER_REVIEW');
      await payInvoice(t, alpha, invoice!.id);
      expect(await statusOf(t, id)).toBe('READY_FOR_PROCESSING');
      expect((await openTasksOf(t, id)).map((x) => x.stepKey)).toEqual(['task']);

      // 3. Review: the service requires it; there is no way from preparation to submission or final review around it.
      await assign(id, operator).expect(200);
      await move(operator, id, 'IN_PREPARATION').expect(200);
      expect((await move(operator, id, 'READY_TO_SUBMIT').expect(422)).body.code).toBe('APPROVAL_REQUIRED');
      expect((await move(operator, id, 'FINAL_REVIEW').expect(422)).body.code).toBe('APPROVAL_REQUIRED');
      expect((await move(manager, id, 'FINAL_REVIEW').expect(422)).body.code).toBe('APPROVAL_REQUIRED');
      // "Preparation done" lets the workflow continue - and the workflow is stopped by the same guard.
      const done = (await t.as(operator).post(`/requests/${id}/workflow/complete-step`, { note: 'Ready' }).expect(200)).body;
      expect(done.status).toBe('IN_PREPARATION');
      let wf = await stepsOf(t, id);
      expect([wf.status('task'), wf.status('submit'), wf.current, await blockedBy()]).toEqual(['COMPLETED', 'SKIPPED', 'done', 'APPROVAL_REQUIRED']);
      expect(done.nextStep.step.blocked).toMatchObject({ code: 'APPROVAL_REQUIRED' });

      // 4. Submission: a preparation-only service is never submitted by the centre. The step was skipped by the engine ...
      expect(wf.steps.find((s) => s.stepKey === 'submit')!.result).toMatchObject({ skipped: 'SUBMISSION_NOT_PERMITTED' });
      // ... recording a submission is refused ...
      const submission = await t.as(operator).post(`/requests/${id}/external-references`, { channel: 'MANUAL_PORTAL', referenceNo: 'SNEAKY-1' }).expect(422);
      expect(submission.body).toMatchObject({ code: 'SUBMISSION_NOT_PERMITTED', message: 'The centre only prepares the documents for this service. The customer submits the application themselves, so no submission can be recorded.' });
      expect(await t.sys.requestExternalReference.count({ where: { requestId: id } })).toBe(0);

      // The review that the workflow "forgot" happens anyway.
      await move(operator, id, 'PENDING_APPROVAL').expect(200);
      const approval = await t.sys.requestApproval.findFirstOrThrow({ where: { requestId: id, status: 'PENDING' } });
      expect(approval).toMatchObject({ type: 'REVIEW', stepKey: null });
      // ... and so is the status change itself, even with the authority of the engine and a reference on file.
      await t.sys.requestExternalReference.create({ data: { tenantId: alpha.id, requestId: id, channel: 'MANUAL_PORTAL', referenceNo: 'FORGED-1' } });
      await t.sys.serviceRequest.update({ where: { id }, data: { status: 'READY_TO_SUBMIT' } });
      const machine = t.get(RequestStateMachine);
      await expect(t.inTenant(alpha.id, () => t.db.tx((tx) => machine.transition(tx, id, 'EXTERNAL_PROCESSING', { actor: { kind: 'ENGINE' } })))).rejects.toMatchObject({ code: 'SUBMISSION_NOT_PERMITTED' });
      expect((await move(alpha.owner, id, 'EXTERNAL_PROCESSING').expect(422)).body.code).toBe('SUBMISSION_NOT_PERMITTED');
      await t.sys.requestExternalReference.deleteMany({ where: { requestId: id } });
      await t.sys.serviceRequest.update({ where: { id }, data: { status: 'PENDING_APPROVAL' } });

      // 5. Completion without the approval is impossible, even if the status is forced to final review.
      await t.sys.serviceRequest.update({ where: { id }, data: { status: 'FINAL_REVIEW' } });
      expect((await t.as(alpha.owner).post(`/requests/${id}/complete`).expect(422)).body.code).toBe('APPROVAL_REQUIRED');
      await t.sys.serviceRequest.update({ where: { id }, data: { status: 'PENDING_APPROVAL' } });

      // With the review done, the simplified workflow finishes normally.
      await t.as(reviewer).post(`/requests/${id}/approvals/${approval.id}/decide`, { decision: 'APPROVED' }).expect(200);
      expect(await statusOf(t, id)).toBe('FINAL_REVIEW'); // approved -> ready -> (no submission for this service) -> final review
      await t.as(reviewer).post(`/requests/${id}/complete`).expect(200);
      wf = await stepsOf(t, id);
      expect(wf.execution!.status).toBe('COMPLETED');
      expect(await pathOf(t, id)).toEqual(['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'READY_FOR_PROCESSING', 'IN_PREPARATION', 'PENDING_APPROVAL', 'READY_TO_SUBMIT', 'FINAL_REVIEW', 'COMPLETED']);
    });

    it('a workflow can add a review to a service that does not require one, and then it cannot be skipped either', async () => {
      const careful = await customWorkflow(alpha, [step('task', 'STAFF_TASK'), step('check', 'INTERNAL_APPROVAL', { onRejectStepKey: 'task' }), step('done', 'COMPLETION')]);
      const service = await createService(t, alpha, { workflowDefinitionId: careful.id, requiresApproval: false, complianceCapability: 'DOCUMENT_PREPARATION_ONLY', paymentPolicy: 'AFTER_COMPLETION', requirements: [] });
      const request = await submittedRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
      expect(await statusOf(t, request.id)).toBe('READY_FOR_PROCESSING');
      await assign(request.id, operator).expect(200);
      await move(operator, request.id, 'IN_PREPARATION').expect(200);
      expect((await move(operator, request.id, 'FINAL_REVIEW').expect(422)).body.code).toBe('APPROVAL_REQUIRED');
      expect((await move(operator, request.id, 'READY_TO_SUBMIT').expect(422)).body.code).toBe('APPROVAL_REQUIRED');
      // "Preparation done" routes the case into the review the workflow asks for.
      const sent = (await t.as(operator).post(`/requests/${request.id}/workflow/complete-step`, {}).expect(200)).body;
      expect(sent.status).toBe('PENDING_APPROVAL');
      expect(sent.approvals).toEqual([expect.objectContaining({ status: 'PENDING', stepKey: 'check' })]);
      await t.as(reviewer).post(`/requests/${request.id}/approvals/${sent.approvals[0].id}/decide`, { decision: 'APPROVED' }).expect(200);
      expect(await statusOf(t, request.id)).toBe('FINAL_REVIEW');
      await t.as(reviewer).post(`/requests/${request.id}/complete`).expect(200);
    });
  });

  // =====================================================================================
  describe('submission channels and status sources (section 31)', () => {
    it('partner coordination: only through an authorised partner, whose name is recorded; statuses are labelled as partner-provided', async () => {
      const request = await preparing({ complianceCapability: 'PARTNER_COORDINATION', requiresApproval: false });
      await move(operator, request.id, 'READY_TO_SUBMIT').expect(200);
      const viaPortal = await t.as(operator).post(`/requests/${request.id}/external-references`, { channel: 'MANUAL_PORTAL', referenceNo: 'X-1' }).expect(422);
      expect(viaPortal.body).toMatchObject({ code: 'CHANNEL_NOT_PERMITTED', details: { permitted: ['AUTHORISED_PARTNER'] } });
      expect((await t.as(operator).post(`/requests/${request.id}/external-references`, { channel: 'OFFICIAL_API', referenceNo: 'X-1' }).expect(422)).body.code).toBe('CHANNEL_NOT_PERMITTED');
      const anonymous = await t.as(operator).post(`/requests/${request.id}/external-references`, { channel: 'AUTHORISED_PARTNER', referenceNo: 'P-77' }).expect(422);
      expect(anonymous.body).toMatchObject({ code: 'PARTNER_NAME_REQUIRED', message: 'Name the authorised partner the application was handed to.' });
      expect(await statusOf(t, request.id)).toBe('READY_TO_SUBMIT');

      const handed = (await t.as(operator).post(`/requests/${request.id}/external-references`, { channel: 'AUTHORISED_PARTNER', referenceNo: 'P-77', partnerName: 'Al Noor PRO Services', partnerReference: 'ANP/2026/15' }).expect(201)).body;
      expect(handed).toMatchObject({ status: 'EXTERNAL_PROCESSING', submissionChannel: 'AUTHORISED_PARTNER' });
      expect(handed.externalStatus).toMatchObject({ source: 'PARTNER_PROVIDED', sourceLabel: STATUS_SOURCE_LABEL.PARTNER_PROVIDED });
      const ref = handed.externalReferences[0];
      expect(ref).toMatchObject({ channel: 'AUTHORISED_PARTNER', partnerName: 'Al Noor PRO Services', partnerReference: 'ANP/2026/15', statusSource: 'PARTNER_PROVIDED', statusSourceLabel: { en: 'Provided by partner' } });

      const updated = (await t.as(operator).patch(`/requests/${request.id}/external-references/${ref.id}`, { status: 'Partner says: typing done, waiting for approval' }).expect(200)).body;
      expect(updated).toMatchObject({ statusSource: 'PARTNER_PROVIDED', statusSourceLabel: STATUS_SOURCE_LABEL.PARTNER_PROVIDED });
      const done = (await t.as(operator).post(`/requests/${request.id}/external-result`, { outcome: 'COMPLETED', note: 'Partner delivered the documents' }).expect(200)).body;
      expect(done.status).toBe('FINAL_REVIEW');
      expect(done.externalReferences[0]).toMatchObject({ result: 'COMPLETED', statusSource: 'PARTNER_PROVIDED' });
      expect(done.externalStatus.sourceLabel).toEqual(STATUS_SOURCE_LABEL.PARTNER_PROVIDED);
    });

    it('a status typed by staff can never be stored or shown as official', async () => {
      const request = await preparing({ complianceCapability: 'DIRECT_AUTHORISED', requiresApproval: false });
      await move(operator, request.id, 'READY_TO_SUBMIT').expect(200);
      // The source cannot be supplied by the client, on creation or on update.
      await t.as(operator).post(`/requests/${request.id}/external-references`, { channel: 'MANUAL_PORTAL', referenceNo: 'M-1', statusSource: 'VERIFIED_OFFICIAL' }).expect(400);
      await t.as(operator).post(`/requests/${request.id}/external-references`, { channel: 'MANUAL_PORTAL', referenceNo: 'M-1', integrationId: '00000000-0000-4000-8000-000000000001' }).expect(400);
      expect(await t.sys.requestExternalReference.count({ where: { requestId: request.id } })).toBe(0);
      const recorded = (await t.as(operator).post(`/requests/${request.id}/external-references`, { channel: 'MANUAL_PORTAL', referenceNo: 'M-1' }).expect(201)).body;
      const ref = recorded.externalReferences[0];
      await t.as(operator).patch(`/requests/${request.id}/external-references/${ref.id}`, { status: 'Approved', statusSource: 'VERIFIED_OFFICIAL' }).expect(400);
      await t.as(operator).patch(`/requests/${request.id}/external-references/${ref.id}`, { status: 'Approved', source: 'VERIFIED_OFFICIAL' }).expect(400);
      await t.as(operator).patch(`/requests/${request.id}/external-references/${ref.id}`, {}).expect(400);
      const typed = (await t.as(operator).patch(`/requests/${request.id}/external-references/${ref.id}`, { status: 'Approved by the authority', notes: 'Seen on the portal' }).expect(200)).body;
      expect(typed).toMatchObject({ status: 'Approved by the authority', statusSource: 'STAFF_ENTERED', statusSourceLabel: { en: 'Entered by staff (not verified by the authority)' } });
      // Every place that shows the status shows the source with it.
      const view = (await t.as(manager).get(`/requests/${request.id}`).expect(200)).body;
      expect(view.externalStatus).toMatchObject({ status: 'Approved by the authority', source: 'STAFF_ENTERED', sourceLabel: STATUS_SOURCE_LABEL.STAFF_ENTERED });
      const row = (await t.as(manager).get(`/requests?q=M-1`).expect(200)).body.data[0];
      expect(row.externalStatus).toMatchObject({ status: 'Approved by the authority', source: 'STAFF_ENTERED', sourceLabel: STATUS_SOURCE_LABEL.STAFF_ENTERED });
      expect((await t.as(manager).get(`/requests/${request.id}/external-references`).expect(200)).body[0].statusSourceLabel).toEqual(STATUS_SOURCE_LABEL.STAFF_ENTERED);
      expect(await t.sys.requestExternalReference.count({ where: { tenantId: alpha.id, statusSource: 'VERIFIED_OFFICIAL' } })).toBe(0);
      // The final outcome goes through "record result", so that the case moves on consistently.
      expect((await t.as(operator).patch(`/requests/${request.id}/external-references/${ref.id}`, { status: 'completed' }).expect(422)).body.code).toBe('USE_RESULT_ACTION');
      // A receptionist cannot touch external statuses at all.
      await t.as(receptionist).patch(`/requests/${request.id}/external-references/${ref.id}`, { status: 'Done' }).expect(403);
      // A second reference for the same submission can be added while it is in processing.
      const more = (await t.as(operator).post(`/requests/${request.id}/external-references`, { channel: 'MANUAL_PORTAL', referenceNo: 'M-2', authorityName: 'MOHRE' }).expect(201)).body;
      expect(more.status).toBe('EXTERNAL_PROCESSING');
      expect(more.externalReferences.map((r: any) => r.referenceNo)).toEqual(['M-1', 'M-2']);
    });

    it('OFFICIAL_API is "not available" unless a verified integration AND a real adapter exist; nothing is simulated', async () => {
      const request = await preparing({ complianceCapability: 'DIRECT_AUTHORISED', requiresApproval: false });
      await move(operator, request.id, 'READY_TO_SUBMIT').expect(200);
      const attempt = () => t.as(operator).post(`/requests/${request.id}/external-references`, { channel: 'OFFICIAL_API', referenceNo: 'API-1', authorityName: 'MOHRE' });
      const expectNotAvailable = async (fragment: string) => {
        const res = await attempt().expect(422);
        expect(res.body.code).toBe('OFFICIAL_INTEGRATION_NOT_AVAILABLE');
        expect(res.body.message).toContain(fragment);
        expect(res.body.message).toContain('record the reference as a manual submission');
        expect(await statusOf(t, request.id)).toBe('READY_TO_SUBMIT');
        expect(await t.sys.requestExternalReference.count({ where: { requestId: request.id } })).toBe(0);
      };

      // 1. No integration at all.
      await expectNotAvailable('no active government integration');
      // 2. An integration that is configured but not active, or active but with unverified authorisation.
      const integration = await t.sys.integration.create({ data: { tenantId: alpha.id, category: 'GOVERNMENT', provider: 'mohre-api', name: 'MOHRE API', status: 'CONFIGURED' } });
      await expectNotAvailable('no active government integration');
      await t.sys.integration.update({ where: { id: integration.id }, data: { status: 'ACTIVE' } });
      await expectNotAvailable('no active government integration');
      // 3. Verified and active - but this code base contains no adapter for any authority.
      await t.sys.integration.update({ where: { id: integration.id }, data: { authorisationVerifiedAt: new Date(), authorisationNote: 'Licence 12345 checked' } });
      await expectNotAvailable('no official adapter for "mohre-api" is installed');
      // A PARTNER or other-category integration does not count as a government one.
      await t.sys.integration.create({ data: { tenantId: alpha.id, category: 'PARTNER', provider: 'some-partner', name: 'Partner', status: 'ACTIVE', authorisationVerifiedAt: new Date() } });

      // 4. With an adapter registered through the port (here: a test double standing in for a deployment's
      //    real adapter), the authority's answer is stored as VERIFIED_OFFICIAL - and only then.
      const calls: any[] = [];
      class TestAdapter extends OfficialSubmissionPort {
        readonly providers = ['mohre-api'];
        answer: string | Error = new Error('reference unknown to the authority');
        async confirmSubmission(input: any) {
          calls.push(input);
          if (this.answer instanceof Error) throw this.answer;
          return { referenceNo: input.referenceNo, status: this.answer };
        }
        async fetchStatus(input: any) {
          if (this.answer instanceof Error) throw this.answer;
          return { referenceNo: input.referenceNo, status: this.answer };
        }
      }
      const adapter = new TestAdapter();
      (t.get(ExternalProcessingService) as any).officialPort = adapter;
      // The authority does not confirm: still not available, still nothing recorded.
      await expectNotAvailable('the authority did not confirm reference API-1');
      // An adapter for another provider does not apply.
      (adapter as any).providers = ['other-authority'];
      await expectNotAvailable('no official adapter for "mohre-api" is installed');
      (adapter as any).providers = ['mohre-api'];

      adapter.answer = 'RECEIVED';
      const confirmed = (await attempt().expect(201)).body;
      expect(calls[calls.length - 1]).toMatchObject({ integrationId: integration.id, provider: 'mohre-api', requestId: request.id, referenceNo: 'API-1' });
      expect(confirmed).toMatchObject({ status: 'EXTERNAL_PROCESSING', submissionChannel: 'OFFICIAL_API' });
      expect(confirmed.externalStatus).toMatchObject({ status: 'RECEIVED', source: 'VERIFIED_OFFICIAL', sourceLabel: STATUS_SOURCE_LABEL.VERIFIED_OFFICIAL });
      const ref = confirmed.externalReferences[0];
      expect(ref).toMatchObject({ channel: 'OFFICIAL_API', statusSource: 'VERIFIED_OFFICIAL', integrationId: integration.id, statusSourceLabel: { en: 'Verified via official integration' } });

      // As soon as a person types a status, it is labelled as typed by a person again.
      const typed = (await t.as(operator).patch(`/requests/${request.id}/external-references/${ref.id}`, { status: 'I think it is approved' }).expect(200)).body;
      expect(typed.statusSource).toBe('STAFF_ENTERED');
      expect((await getRequest(t, request.id)).externalStatusSource).toBe('STAFF_ENTERED');
      // Only the adapter can restore the official label.
      adapter.answer = 'UNDER PROCESS';
      const refreshed = await t.inTenant(alpha.id, () => t.get(ExternalProcessingService).refreshOfficialStatus(request.id, ref.id));
      expect(refreshed).toMatchObject({ status: 'UNDER PROCESS', statusSource: 'VERIFIED_OFFICIAL' });
      expect(await getRequest(t, request.id)).toMatchObject({ externalStatus: 'UNDER PROCESS', externalStatusSource: 'VERIFIED_OFFICIAL' });
      // Without the adapter the refresh is not available either.
      (t.get(ExternalProcessingService) as any).officialPort = undefined;
      await expect(t.inTenant(alpha.id, () => t.get(ExternalProcessingService).refreshOfficialStatus(request.id, ref.id))).rejects.toMatchObject({ code: 'OFFICIAL_INTEGRATION_NOT_AVAILABLE' });
      await t.sys.integration.deleteMany({ where: { tenantId: alpha.id } });
    });

    it('the requests module contains no code that could reach a government system', () => {
      const offenders: string[] = [];
      for (const dir of [__dirname, join(__dirname, '..', 'workflows')]) {
        for (const file of readdirSync(dir)) {
          if (!file.endsWith('.ts') || file.endsWith('.spec.ts')) continue;
          const source = readFileSync(join(dir, file), 'utf8');
          if (/\bfetch\(|from 'node:https?'|from 'https?'|axios|XMLHttpRequest|puppeteer|playwright|net\.connect|require\('https?'\)/.test(source)) offenders.push(file);
        }
      }
      expect(offenders).toEqual([]);
    });
  });

  // =====================================================================================
  describe('step types', () => {
    const richSteps = (generation: object) => [
      step('docs', 'DOCUMENT_UPLOAD'),
      step('verify', 'STAFF_VERIFICATION'),
      step('route', 'CONDITIONAL_BRANCH', { nextStepKey: 'cover', branches: [{ when: { all: [{ fact: 'request.priority', op: 'eq', value: 'URGENT' }] }, goTo: 'fast-note' }] }),
      step('fast-note', 'NOTIFICATION', { config: { message: 'Your urgent request is handled with priority.' } }),
      step('cover', 'DOCUMENT_GENERATION', { config: generation, customerVisible: false }),
      step('draft', 'STAFF_TASK', { name: 'Draft the document', assigneeRoleKey: 'operator' }),
      step('finalise', 'STAFF_TASK', { name: 'Finalise the document' }),
      step('done', 'COMPLETION'),
    ];
    const richService = async (generation: object) => {
      const workflow = await customWorkflow(alpha, richSteps(generation));
      return createService(t, alpha, { workflowDefinitionId: workflow.id, requiresApproval: false, complianceCapability: 'DOCUMENT_PREPARATION_ONLY', paymentPolicy: 'AFTER_COMPLETION' });
    };

    it('conditional branch, notification, optional document generation and consecutive staff tasks', async () => {
      (engine as any).documentStore = undefined; // no document storage in this scenario
      const service = await richService({ optional: true });
      const customer = await createCustomer(t, alpha);

      // Normal priority: the branch falls through to its default next step, skipping the notification.
      const normal = await submittedRequest(t, alpha, receptionist, service.id, customer.id);
      await completeDocuments(t, alpha, normal.id);
      let wf = await stepsOf(t, normal.id);
      expect(wf.steps.map((s) => [s.stepKey, s.status])).toEqual([['docs', 'COMPLETED'], ['verify', 'COMPLETED'], ['route', 'COMPLETED'], ['cover', 'FAILED'], ['draft', 'ACTIVE']]);
      expect(wf.steps.find((s) => s.stepKey === 'route')!.result).toMatchObject({ matchedBranch: null });
      // Document storage is not part of this test application: the optional step fails visibly and the workflow continues.
      expect(wf.steps.find((s) => s.stepKey === 'cover')!.result).toMatchObject({
        message: 'The document could not be generated: document storage is not available in this installation (the documents module is not loaded).', continuedBecauseOptional: true,
      });
      // Pay-after-completion service, documents verified: released for processing by the staff task step.
      expect(await statusOf(t, normal.id)).toBe('READY_FOR_PROCESSING');
      expect((await eventsOf(t, alpha.id, normal.id, 'request.status_changed')).filter((e) => e.payload.informational)).toEqual([]);

      // Two staff tasks in a row: "preparation done" completes one after the other.
      await assign(normal.id, operator).expect(200);
      await move(operator, normal.id, 'IN_PREPARATION').expect(200);
      expect((await openTasksOf(t, normal.id)).map((x) => [x.stepKey, x.title])).toEqual([['draft', `Draft the document - ${normal.requestNo}`]]);
      await t.as(operator).post(`/requests/${normal.id}/workflow/complete-step`, { stepKey: 'finalise' }).expect(409); // not the step that is active
      const second = (await t.as(operator).post(`/requests/${normal.id}/workflow/complete-step`, { stepKey: 'draft', note: 'Draft ready' }).expect(200)).body;
      expect(second.status).toBe('IN_PREPARATION');
      expect(second.workflow.currentStepKey).toBe('finalise');
      expect((await tasksOf(t, normal.id)).map((x) => [x.stepKey, x.status])).toEqual([['draft', 'DONE'], ['finalise', 'OPEN']]);
      expect((await stepsOf(t, normal.id)).steps.find((s) => s.stepKey === 'draft')!.result).toMatchObject({ completedManually: true, completedBy: operator.userId, completedNote: 'Draft ready' });
      const third = (await t.as(operator).post(`/requests/${normal.id}/workflow/complete-step`, {}).expect(200)).body;
      expect(third.status).toBe('FINAL_REVIEW'); // the workflow decides what follows the last task
      expect((await t.as(operator).post(`/requests/${normal.id}/workflow/complete-step`, {}).expect(409)).body.code).toBe('STEP_NOT_ACTIVE');
      // Nothing was quoted or invoiced for this request, so there is nothing to collect.
      await t.as(reviewer).post(`/requests/${normal.id}/complete`).expect(200);

      // Urgent priority: the branch jumps to the notification, which informs the customer and completes at once.
      const urgent = await submittedRequest(t, alpha, receptionist, service.id, customer.id, { priority: 'URGENT' });
      await completeDocuments(t, alpha, urgent.id);
      wf = await stepsOf(t, urgent.id);
      expect(wf.steps.map((s) => [s.stepKey, s.status])).toEqual([['docs', 'COMPLETED'], ['verify', 'COMPLETED'], ['route', 'COMPLETED'], ['fast-note', 'COMPLETED'], ['cover', 'FAILED'], ['draft', 'ACTIVE']]);
      expect(wf.steps.find((s) => s.stepKey === 'route')!.result).toMatchObject({ matchedBranch: 1, goTo: 'fast-note' });
      const note = (await historyOf(t, urgent.id)).find((h) => (h.meta as any).kind === 'NOTE')!;
      expect(note).toMatchObject({ fromStatus: 'UNDER_REVIEW', toStatus: 'UNDER_REVIEW', customerVisible: true, customerMessage: 'Your urgent request is handled with priority.' });
      const informational = (await eventsOf(t, alpha.id, urgent.id, 'request.status_changed')).filter((e) => e.payload.informational);
      expect(informational.map((e) => e.payload)).toEqual([expect.objectContaining({ from: 'UNDER_REVIEW', to: 'UNDER_REVIEW', customerVisible: true, customerMessage: 'Your urgent request is handled with priority.', stepKey: 'fast-note' })]);
      // The notification is not a status change: it does not appear in the status path.
      expect(await pathOf(t, urgent.id)).toEqual(['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'READY_FOR_PROCESSING']);
    });

    it('document generation stores a PDF through the document port when the documents module provides it', async () => {
      const stored: GeneratedDocumentInput[] = [];
      (engine as any).documentStore = { storeGenerated: async (input: GeneratedDocumentInput) => (stored.push(input), { documentId: '11111111-1111-4111-8111-111111111111', versionId: '22222222-2222-4222-8222-222222222222' }) };
      const service = await richService({ title: 'Cover sheet', customerVisible: false });
      const customer = await createCustomer(t, alpha, { fullName: 'Pdf Person' });
      const request = await submittedRequest(t, alpha, receptionist, service.id, customer.id, { instructions: 'Handle with care' });
      await completeDocuments(t, alpha, request.id);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ customerId: customer.id, requestId: request.id, documentTypeKey: 'other', title: 'Cover sheet', filename: `${request.requestNo}-summary.pdf`, mime: 'application/pdf', isCompletionDocument: false, customerVisible: false });
      expect(stored[0].content.subarray(0, 5).toString()).toBe('%PDF-');
      expect(stored[0].content.length).toBeGreaterThan(800);
      const wf = await stepsOf(t, request.id);
      expect(wf.steps.find((s) => s.stepKey === 'cover')).toMatchObject({ status: 'COMPLETED', result: expect.objectContaining({ documentId: '11111111-1111-4111-8111-111111111111' }) });
      expect(wf.current).toBe('draft');
    });

    it('a mandatory document generation step holds the workflow and is retried; a failure inside it never breaks the surrounding transaction', async () => {
      (engine as any).documentStore = undefined;
      const service = await richService({}); // not optional
      const request = await submittedRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
      await completeDocuments(t, alpha, request.id);
      let wf = await stepsOf(t, request.id);
      expect([wf.current, wf.status('cover'), await statusOf(t, request.id)]).toEqual(['cover', 'FAILED', 'UNDER_REVIEW']);
      // The documents were verified in the same transaction that hit the failure: that work is not lost.
      expect((await checklistOf(t, request.id)).every((l) => l.status === 'VERIFIED')).toBe(true);
      expect((await t.as(manager).get(`/requests/${request.id}`).expect(200)).body.workflow.steps.find((s: any) => s.key === 'cover')).toMatchObject({ status: 'FAILED', note: expect.stringContaining('document storage is not available') });

      // The storage breaks with a database error inside the caller's transaction ...
      (engine as any).documentStore = { storeGenerated: () => t.db.tx((tx) => tx.$executeRawUnsafe('INSERT INTO "table_that_does_not_exist" VALUES (1)')) };
      await advance(alpha, request.id);
      wf = await stepsOf(t, request.id);
      expect(wf.status('cover')).toBe('FAILED');
      expect((wf.steps.find((s) => s.stepKey === 'cover')!.result as any).message).toContain('The document could not be generated');
      // ... and a later retry with working storage completes the step and the workflow moves on.
      (engine as any).documentStore = { storeGenerated: async () => ({ documentId: '11111111-1111-4111-8111-111111111111', versionId: '22222222-2222-4222-8222-222222222222' }) };
      await advance(alpha, request.id);
      wf = await stepsOf(t, request.id);
      expect([wf.status('cover'), wf.current, await statusOf(t, request.id)]).toEqual(['COMPLETED', 'draft', 'READY_FOR_PROCESSING']);
      expect(wf.steps.filter((s) => s.stepKey === 'cover')).toHaveLength(1); // retried in place, not duplicated
    });

    it('a workflow that runs in circles is stopped instead of spinning; the request itself keeps working', async () => {
      // The branch always leads back to the staff task.
      const looping = await customWorkflow(alpha, [
        step('task', 'STAFF_TASK'),
        step('again', 'CONDITIONAL_BRANCH', { branches: [{ when: { all: [{ fact: 'request.priority', op: 'exists' }] }, goTo: 'task' }] }),
        step('done', 'COMPLETION'),
      ]);
      const service = await createService(t, alpha, { workflowDefinitionId: looping.id, requiresApproval: false, complianceCapability: 'DOCUMENT_PREPARATION_ONLY', paymentPolicy: 'AFTER_COMPLETION', requirements: [] });
      const request = await submittedRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
      await assign(request.id, operator).expect(200);
      await move(operator, request.id, 'IN_PREPARATION').expect(200);
      const quiet = jest.spyOn((engine as any).logger, 'error').mockImplementation(() => undefined);
      const moved = (await move(operator, request.id, 'FINAL_REVIEW').expect(200)).body;
      expect(quiet).toHaveBeenCalledWith(expect.stringContaining('loop at step "task"'));
      expect(moved.status).toBe('FINAL_REVIEW');
      expect(moved.workflow.status).toBe('FAILED');
      const wf = await stepsOf(t, request.id);
      expect(wf.steps.map((s) => [s.stepKey, s.attempt, s.status])).toEqual([['task', 1, 'COMPLETED'], ['again', 1, 'COMPLETED'], ['task', 2, 'FAILED']]);
      expect((wf.steps[2].result as any).message).toContain('keeps returning to the step "task"');
      expect(await t.sys.auditLog.count({ where: { resourceId: request.id, action: 'request.workflow_failed' } })).toBe(1);
      // Further advances add nothing, and the case can still be finished by hand.
      for (let i = 0; i < 3; i++) await advance(alpha, request.id);
      expect((await stepsOf(t, request.id)).steps).toHaveLength(3);
      await t.as(reviewer).post(`/requests/${request.id}/complete`).expect(200);
      expect(await statusOf(t, request.id)).toBe('COMPLETED');
    });
  });

  // =====================================================================================
  describe('templates', () => {
    it('installs the three templates for every centre and uses "standard" by default', async () => {
      const definitions = await t.sys.workflowDefinition.findMany({ where: { tenantId: alpha.id, templateKey: { not: null } }, orderBy: { key: 'asc' } });
      expect(definitions.map((d) => d.key)).toEqual(['pay-on-completion', 'standard', 'walk-in-express']);
      const settings = (await t.sys.tenant.findUniqueOrThrow({ where: { id: alpha.id } })).settings as any;
      expect(settings.defaultWorkflowDefinitionId).toBe(definitions.find((d) => d.key === 'standard')!.id);
      for (const d of definitions) {
        const versions = await t.sys.workflowVersion.findMany({ where: { definitionId: d.id } });
        expect(versions.map((v) => [v.version, v.status])).toEqual([[1, 'PUBLISHED']]);
        expect(d.publishedVersionId).toBe(versions[0].id);
      }
      // A service without its own workflow is pinned to the default one.
      const service = await createService(t, alpha);
      const request = await submittedRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
      expect((await getRequest(t, request.id)).workflowVersionId).toBe(definitions.find((d) => d.key === 'standard')!.publishedVersionId);
    });

    it('walk-in express: documents, quick check, quotation, payment, the job, hand-over', async () => {
      const service = await createService(t, alpha, { workflowDefinitionId: await definitionId(alpha, 'walk-in-express'), requiresApproval: false, complianceCapability: 'DOCUMENT_PREPARATION_ONLY', form: null, requirements: [{ documentTypeKey: 'emirates_id', label: 'Emirates ID' }] });
      // This service has no form: there is nothing to fill in, and submitting needs no values.
      const request = await readyRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id, { fields: {} });
      expect(await statusOf(t, request.id)).toBe('READY_FOR_PROCESSING');
      await assign(request.id, operator).expect(200);
      await move(operator, request.id, 'IN_PREPARATION').expect(200);
      expect((await openTasksOf(t, request.id)).map((x) => x.title)).toEqual([`Type / print the document - ${request.requestNo}`]);
      await move(operator, request.id, 'FINAL_REVIEW').expect(200);
      await t.as(reviewer).post(`/requests/${request.id}/complete`).expect(200);
      const wf = await stepsOf(t, request.id);
      expect(wf.steps.map((s) => [s.stepKey, s.status])).toEqual([['documents', 'COMPLETED'], ['verification', 'COMPLETED'], ['quotation', 'COMPLETED'], ['customer-approval', 'COMPLETED'], ['payment', 'COMPLETED'], ['task', 'COMPLETED'], ['completion', 'COMPLETED']]);
      expect(await pathOf(t, request.id)).toEqual(['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'QUOTED', 'AWAITING_PAYMENT', 'READY_FOR_PROCESSING', 'IN_PREPARATION', 'FINAL_REVIEW', 'COMPLETED']);
    });

    it('pay on completion: work first, the payment step waits just before completion', async () => {
      const service = await createService(t, alpha, { workflowDefinitionId: await definitionId(alpha, 'pay-on-completion'), paymentPolicy: 'AFTER_COMPLETION', requiresApproval: false, complianceCapability: 'DIRECT_AUTHORISED' });
      const request = await submittedRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
      await completeDocuments(t, alpha, request.id);
      const { invoice } = await approveQuotation(t, alpha, (await sendQuotation(t, alpha, request.id, 420)).id);
      // Released without payment.
      expect(await getRequest(t, request.id)).toMatchObject({ status: 'READY_FOR_PROCESSING', paymentStatus: 'UNPAID' });
      await assign(request.id, operator).expect(200);
      await move(operator, request.id, 'IN_PREPARATION').expect(200);
      await move(operator, request.id, 'READY_TO_SUBMIT').expect(200);
      await t.as(operator).post(`/requests/${request.id}/external-references`, { channel: 'MANUAL_PORTAL', referenceNo: 'POC-1' }).expect(201);
      await t.as(operator).post(`/requests/${request.id}/external-result`, { outcome: 'COMPLETED' }).expect(200);

      // The work is done; the workflow now waits for the money before final review is handed out.
      let wf = await stepsOf(t, request.id);
      expect([await statusOf(t, request.id), wf.current, wf.status('payment'), wf.status('completion')]).toEqual(['FINAL_REVIEW', 'payment', 'ACTIVE', null]);
      expect((await openTasksOf(t, request.id)).map((x) => [x.title, x.roleKey])).toEqual([[`Collect payment - ${request.requestNo}`, 'receptionist']]);
      expect((wf.steps.find((s) => s.stepKey === 'payment')!.result as any).blocked).toEqual({ code: 'PAYMENT_INCOMPLETE', message: 'Waiting for payment (420.00 outstanding).' });
      expect((await t.as(reviewer).post(`/requests/${request.id}/complete`).expect(422)).body.code).toBe('PAYMENT_INCOMPLETE');

      await payInvoice(t, alpha, invoice!.id);
      wf = await stepsOf(t, request.id);
      expect([wf.status('payment'), wf.status('completion'), wf.current]).toEqual(['COMPLETED', 'ACTIVE', 'completion']);
      expect((await openTasksOf(t, request.id)).map((x) => x.title)).toEqual([`Final review - ${request.requestNo}`]);
      await t.as(reviewer).post(`/requests/${request.id}/complete`).expect(200);
      expect(await getRequest(t, request.id)).toMatchObject({ status: 'COMPLETED', paymentStatus: 'PAID' });
    });

    it('a service whose policy is "pay before processing" is not released by the pay-on-completion workflow', async () => {
      const service = await createService(t, alpha, { workflowDefinitionId: await definitionId(alpha, 'pay-on-completion'), paymentPolicy: 'BEFORE_PROCESSING' });
      const request = await submittedRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
      await completeDocuments(t, alpha, request.id);
      const { invoice } = await approveQuotation(t, alpha, (await sendQuotation(t, alpha, request.id)).id);
      // The workflow has no payment step here, yet the customer is asked to pay: the service policy decides.
      const wf = await stepsOf(t, request.id);
      expect([await statusOf(t, request.id), wf.current]).toEqual(['AWAITING_PAYMENT', 'prepare']);
      expect((wf.steps.find((s) => s.stepKey === 'prepare')!.result as any).blocked.code).toBe('PAYMENT_REQUIRED');
      expect(await openTasksOf(t, request.id)).toHaveLength(0);
      await payInvoice(t, alpha, invoice!.id);
      expect(await statusOf(t, request.id)).toBe('READY_FOR_PROCESSING');
      expect((await openTasksOf(t, request.id)).map((x) => x.stepKey)).toEqual(['prepare']);
    });
  });

  // =====================================================================================
  describe('reacting to events', () => {
    it('quotation rejected: back to the quotation step with a new task, then a revised quotation', async () => {
      const service = await createService(t, alpha);
      const request = await submittedRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
      await completeDocuments(t, alpha, request.id);
      const first = await sendQuotation(t, alpha, request.id, 900);
      expect(await statusOf(t, request.id)).toBe('QUOTED');
      await rejectQuotation(t, alpha, first.id, 'Too expensive');
      const wf = await stepsOf(t, request.id);
      expect([await statusOf(t, request.id), wf.current]).toEqual(['UNDER_REVIEW', 'quotation']);
      expect(wf.steps.filter((s) => s.stepKey === 'quotation').map((s) => [s.attempt, s.status])).toEqual([[1, 'COMPLETED'], [2, 'ACTIVE']]);
      expect(wf.steps.find((s) => s.stepKey === 'customer-approval')!.result).toMatchObject({ outcome: 'REJECTED', goTo: 'quotation' });
      expect((await tasksOf(t, request.id)).map((x) => [x.stepKey, x.status])).toEqual([['quotation', 'DONE'], ['quotation', 'OPEN']]);
      const row = (await historyOf(t, request.id)).pop()!;
      expect(row).toMatchObject({ fromStatus: 'QUOTED', toStatus: 'UNDER_REVIEW', reason: 'Quotation rejected: Too expensive', customerMessage: 'We are revising your quotation.' });

      const second = await sendQuotation(t, alpha, request.id, 700);
      expect(await statusOf(t, request.id)).toBe('QUOTED');
      await approveQuotation(t, alpha, second.id);
      expect(await statusOf(t, request.id)).toBe('AWAITING_PAYMENT');
      expect((await t.as(manager).get(`/requests/${request.id}`).expect(200)).body.finance.quotation).toMatchObject({ id: second.id, status: 'APPROVED', total: '700.00' });
    });

    it('quotation expired: finance sends no event, the scan sends the request back for a revised offer (once)', async () => {
      const service = await createService(t, alpha);
      const request = await submittedRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
      await completeDocuments(t, alpha, request.id);
      const first = await sendQuotation(t, alpha, request.id, 900);
      expect(await statusOf(t, request.id)).toBe('QUOTED');

      // Still valid: the scan leaves the request alone.
      await t.jobs.runScheduled(SCAN_JOB);
      expect(await statusOf(t, request.id)).toBe('QUOTED');

      // What finance does when the validity date has passed (job finance.quotations.expire): a status change, no event.
      await t.sys.quotation.update({ where: { id: first.id }, data: { status: 'EXPIRED', validUntil: new Date(Date.now() - 86_400_000) } });
      await t.jobs.runScheduled(SCAN_JOB);
      const wf = await stepsOf(t, request.id);
      expect([await statusOf(t, request.id), wf.current]).toEqual(['UNDER_REVIEW', 'quotation']);
      expect(wf.steps.filter((s) => s.stepKey === 'quotation').map((s) => [s.attempt, s.status])).toEqual([[1, 'COMPLETED'], [2, 'ACTIVE']]);
      expect(wf.steps.find((s) => s.stepKey === 'customer-approval')!.result).toMatchObject({ outcome: 'EXPIRED', goTo: 'quotation' });
      expect((await tasksOf(t, request.id)).map((x) => [x.stepKey, x.status])).toEqual([['quotation', 'DONE'], ['quotation', 'OPEN']]);
      expect((await historyOf(t, request.id)).pop()!).toMatchObject({ fromStatus: 'QUOTED', toStatus: 'UNDER_REVIEW', reason: 'Quotation expired', customerMessage: 'We are revising your quotation.' });

      // Idempotent, and an old expired quotation next to a new offer changes nothing.
      await t.jobs.runScheduled(SCAN_JOB);
      expect((await tasksOf(t, request.id)).map((x) => [x.stepKey, x.status])).toEqual([['quotation', 'DONE'], ['quotation', 'OPEN']]);
      const second = await sendQuotation(t, alpha, request.id, 700);
      expect(await statusOf(t, request.id)).toBe('QUOTED');
      await t.jobs.runScheduled(SCAN_JOB);
      expect(await statusOf(t, request.id)).toBe('QUOTED');
      await approveQuotation(t, alpha, second.id);
      expect(await statusOf(t, request.id)).toBe('AWAITING_PAYMENT');
    });

    it('an invoice that is issued after the approval event still blocks processing (no invoice is never "paid")', async () => {
      const service = await createService(t, alpha);
      const request = await submittedRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
      await completeDocuments(t, alpha, request.id);
      const quotation = await sendQuotation(t, alpha, request.id, 350);
      // Finance announces the approval before the invoice exists.
      await approveQuotation(t, alpha, quotation.id, { withInvoice: false });
      expect(await statusOf(t, request.id)).toBe('AWAITING_PAYMENT');
      expect(((await stepsOf(t, request.id)).steps.find((s) => s.stepKey === 'payment')!.result as any).blocked.code).toBe('PAYMENT_REQUIRED');
      const invoice = await t.sys.invoice.create({
        data: { tenantId: alpha.id, branchId: alpha.headOfficeId, invoiceNo: `INV-${uniq()}`.toUpperCase(), requestId: request.id, quotationId: quotation.id, customerId: quotation.customerId, status: 'ISSUED', subtotalServiceFee: 350, total: 350, balanceDue: 350, issuedAt: new Date() },
      });
      await emit(t, alpha.id, 'invoice.issued', { invoiceId: invoice.id, requestId: request.id, customerId: quotation.customerId, total: '350.00', currency: 'AED' });
      expect(await statusOf(t, request.id)).toBe('AWAITING_PAYMENT');
      // A payment event that only names the invoice is matched to the request through it.
      await t.sys.invoice.update({ where: { id: invoice.id }, data: { amountPaid: 350, balanceDue: 0, status: 'PAID' } });
      await emit(t, alpha.id, 'payment.completed', { paymentId: '00000000-0000-4000-8000-000000000009', customerId: quotation.customerId, amount: '350.00', currency: 'AED', method: 'CARD_POS', invoiceIds: [invoice.id], requestIds: [] });
      expect(await getRequest(t, request.id)).toMatchObject({ status: 'READY_FOR_PROCESSING', paymentStatus: 'PAID' });
    });

    it('staff can release a request without waiting for the quotation steps: the workflow catches up', async () => {
      const service = await createService(t, alpha, { paymentPolicy: 'AFTER_COMPLETION' });
      const request = await submittedRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
      await completeDocuments(t, alpha, request.id);
      expect((await stepsOf(t, request.id)).current).toBe('quotation');
      await move(reviewer, request.id, 'READY_FOR_PROCESSING').expect(200);
      const wf = await stepsOf(t, request.id);
      expect(wf.steps.slice(-4).map((s) => [s.stepKey, s.status, (s.result as any).skipped ?? null])).toEqual([
        ['quotation', 'SKIPPED', 'OVERTAKEN'], ['customer-approval', 'SKIPPED', 'OVERTAKEN'], ['payment', 'SKIPPED', 'NOT_DUE_YET'], ['prepare', 'ACTIVE', null],
      ]);
      expect((await tasksOf(t, request.id)).map((x) => [x.stepKey, x.status])).toEqual([['quotation', 'DONE'], ['prepare', 'OPEN']]);
    });

    it('events about unknown, foreign or closed requests are tolerated', async () => {
      const service = await createService(t, alpha);
      const request = await submittedRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
      await t.as(manager).post(`/requests/${request.id}/cancel`, { reason: 'Customer withdrew' }).expect(200);
      const before = (await historyOf(t, request.id)).length;
      const ghost = '00000000-0000-4000-8000-00000000beef';
      const beta = await t.createTenant({ name: 'Beta Events' });
      for (const [type, payload] of [
        ['document.uploaded', { documentId: ghost, requestId: request.id, documentTypeKey: 'passport' }],
        ['document.uploaded', { documentId: ghost, requestId: ghost, documentTypeKey: 'passport' }],
        ['document.verified', { documentId: ghost, requestId: request.id, documentTypeKey: 'passport' }],
        ['document.rejected', { documentId: ghost, documentTypeKey: 'passport', reason: 'x' }],
        ['quotation.sent', { quotationId: ghost, requestId: request.id, customerId: ghost, total: '1.00', currency: 'AED' }],
        ['quotation.approved', { quotationId: ghost, customerId: ghost, approvedByType: 'CUSTOMER' }], // no request at all
        ['quotation.rejected', { quotationId: ghost, requestId: 'not-a-uuid', customerId: ghost, reason: 'x' }],
        ['payment.completed', { paymentId: ghost, amount: '5.00', currency: 'AED', method: 'CASH', invoiceIds: [ghost], requestIds: [request.id, ghost] }],
        ['payment.completed', { paymentId: ghost, amount: '5.00', currency: 'AED', method: 'CASH' }], // malformed payload
        ['refund.completed', { refundId: ghost, paymentId: ghost, amount: '5.00', currency: 'AED' }],
        ['invoice.issued', { invoiceId: ghost, requestId: request.id, customerId: ghost, total: '1.00', currency: 'AED' }],
      ] as const) {
        await expect(emit(t, alpha.id, type, payload)).resolves.toBeTruthy();
      }
      // An event of another tenant that names this request changes nothing here.
      await expect(emit(t, beta.id, 'payment.completed', { paymentId: ghost, amount: '5.00', currency: 'AED', method: 'CASH', invoiceIds: [], requestIds: [request.id] })).resolves.toBeTruthy();
      expect(await statusOf(t, request.id)).toBe('CANCELLED');
      expect((await historyOf(t, request.id)).length).toBe(before);
      expect((await stepsOf(t, request.id)).execution!.status).toBe('CANCELLED');
    });

    it('advance is idempotent: calling it again and again changes nothing', async () => {
      const service = await createService(t, alpha);
      const request = await submittedRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
      const snapshot = async () => ({
        status: await statusOf(t, request.id),
        history: (await historyOf(t, request.id)).length,
        events: (await eventsOf(t, alpha.id, request.id)).length,
        tasks: (await tasksOf(t, request.id)).map((x) => `${x.stepKey}:${x.status}`),
        steps: (await stepsOf(t, request.id)).steps.map((s) => `${s.stepKey}:${s.status}:${s.attempt}`),
        approvals: await t.sys.requestApproval.count({ where: { requestId: request.id } }),
        audit: await t.sys.auditLog.count({ where: { resourceId: request.id } }),
      });
      const stages: Array<() => Promise<unknown>> = [
        async () => undefined, // waiting for documents
        () => completeDocuments(t, alpha, request.id), // waiting for the quotation
        async () => sendQuotation(t, alpha, request.id), // waiting for the customer's approval
        async () => approveQuotation(t, alpha, (await t.sys.quotation.findFirstOrThrow({ where: { requestId: request.id } })).id), // waiting for payment
        async () => payInvoice(t, alpha, (await t.sys.invoice.findFirstOrThrow({ where: { requestId: request.id } })).id), // ready for processing
        async () => {
          await assign(request.id, operator).expect(200);
          await move(operator, request.id, 'IN_PREPARATION').expect(200);
          await move(operator, request.id, 'PENDING_APPROVAL').expect(200); // waiting for the review
        },
        async () => t.as(manager).post(`/requests/${request.id}/cancel`, { reason: 'Stop' }).expect(200), // closed
      ];
      for (const stage of stages) {
        await stage();
        const before = await snapshot();
        for (let i = 0; i < 3; i++) await advance(alpha, request.id);
        await t.jobs.enqueue(ADVANCE_JOB, { tenantId: alpha.id, requestId: request.id });
        await t.settle();
        expect(await snapshot()).toEqual(before);
      }
      await expect(advance(alpha, '00000000-0000-4000-8000-00000000beef')).resolves.toBeUndefined(); // unknown request: nothing to do
    });

    it('a failing workflow reaction never undoes the other module\'s transaction; it is retried by a job', async () => {
      const service = await createService(t, alpha);
      const request = await submittedRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
      await completeDocuments(t, alpha, request.id);
      const { invoice } = await approveQuotation(t, alpha, (await sendQuotation(t, alpha, request.id)).id);
      const quiet = jest.spyOn((engine as any).logger, 'error').mockImplementation(() => undefined);
      const original = (engine as any).run.bind(engine);
      let failures = 0;
      jest.spyOn(engine as any, 'run').mockImplementation(async (...args: any[]) => {
        if (failures++ === 0) {
          // The reaction writes something and then breaks the database transaction.
          await args[0].requestComment.create({ data: { tenantId: alpha.id, requestId: request.id, authorType: 'SYSTEM', body: 'half-done engine write' } });
          await args[0].$executeRawUnsafe('SELECT * FROM "table_that_does_not_exist"');
        }
        return original(...args);
      });

      // "Finance" records a payment and emits the event in one transaction.
      await t.sys.invoice.update({ where: { id: invoice!.id }, data: { amountPaid: invoice!.total, balanceDue: 0, status: 'PAID' } });
      await t.inTenant(alpha.id, () =>
        t.db.tx(async (tx) => {
          await tx.requestComment.create({ data: { tenantId: alpha.id, requestId: request.id, authorType: 'SYSTEM', body: 'finance wrote this in the same transaction' } });
          await t.get(DomainEvents).emit(tx, 'payment.completed', { paymentId: '00000000-0000-4000-8000-000000000010', amount: '500.00', currency: 'AED', method: 'CASH', invoiceIds: [invoice!.id], requestIds: [request.id] });
        }),
      );
      // The other module's work is committed, the engine's partial work is not, and the request has not moved yet.
      const comments = await t.sys.requestComment.findMany({ where: { requestId: request.id } });
      expect(comments.map((c) => c.body)).toEqual(['finance wrote this in the same transaction']);
      expect(await t.sys.outboxEvent.count({ where: { tenantId: alpha.id, type: 'payment.completed', payload: { path: ['paymentId'], equals: '00000000-0000-4000-8000-000000000010' } } })).toBe(1);
      expect(await getRequest(t, request.id)).toMatchObject({ status: 'AWAITING_PAYMENT', paymentStatus: 'UNPAID' });
      expect(quiet).toHaveBeenCalledWith(expect.stringContaining('workflow reaction to payment.completed failed and will be retried'));
      expect(t.jobs.pendingCount()).toBeGreaterThan(0);

      // The retry job brings the request up to date.
      await t.settle();
      expect(await getRequest(t, request.id)).toMatchObject({ status: 'READY_FOR_PROCESSING', paymentStatus: 'PAID' });
      expect(t.jobs.deadLetters).toEqual([]);
    });
  });
});
