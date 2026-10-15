import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findTransition, REQUEST_STATUS_META, REQUEST_TRANSITIONS } from '@typease/types';
import type { RequestStatus } from '@typease/types';
import { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import {
  approveQuotation, checklistOf, completeDocuments, createCorporateAccount, createCustomer, createDocument, createService, forceStatus, getRequest, historyOf, payInvoice,
  readyRequest, sendQuotation, statusOf, submittedRequest, uploadFor, verifyDocument, draftRequest,
} from './fixtures';
import { RequestStateMachine } from './request-state-machine.service';

const STATUSES = Object.keys(REQUEST_TRANSITIONS) as RequestStatus[];

describe('Service requests: state machine', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let manager: Actor;
  let receptionist: Actor;
  let operator: Actor;
  let reviewer: Actor;
  let customerActor: Actor;

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    manager = await t.addStaff(alpha, 'manager');
    receptionist = await t.addStaff(alpha, 'receptionist');
    operator = await t.addStaff(alpha, 'operator');
    reviewer = await t.addStaff(alpha, 'reviewer');
    customerActor = await t.addCustomer(alpha);
  });
  afterAll(() => t.close());

  const move = (actor: Actor, id: string, to: string, extra: object = {}) => t.as(actor).post(`/requests/${id}/transition`, { to, ...extra });
  const assign = (id: string, who: Actor, role = 'OPERATOR') => t.as(manager).post(`/requests/${id}/assign`, { assigneeMembershipId: who.membershipId, role });

  // =====================================================================================
  describe('the transition table is the only way a status can change', () => {
    it('has the expected shape', () => {
      expect(STATUSES).toHaveLength(16);
      expect(REQUEST_TRANSITIONS.CANCELLED).toEqual([]);
      // No status leads to itself and no edge is listed twice.
      for (const from of STATUSES) {
        const targets = REQUEST_TRANSITIONS[from].map((r) => r.to);
        expect(targets).not.toContain(from);
        expect(new Set(targets).size).toBe(targets.length);
      }
    });

    it('refuses EVERY pair that is not listed, for a request in each status (HTTP 409 INVALID_TRANSITION)', async () => {
      const service = await createService(t, alpha);
      const customer = await createCustomer(t, alpha);
      const request = await submittedRequest(t, alpha, receptionist, service.id, customer.id);
      const forbidden = STATUSES.flatMap((from) => STATUSES.filter((to) => !findTransition(from, to)).map((to) => [from, to] as const));
      const listed = STATUSES.reduce((n, from) => n + REQUEST_TRANSITIONS[from].length, 0);
      expect(forbidden.length).toBe(16 * 16 - listed);
      expect(forbidden.length).toBeGreaterThan(200);

      const wrong: string[] = [];
      let current: RequestStatus | null = null;
      for (const [from, to] of forbidden) {
        if (current !== from) {
          await forceStatus(t, request.id, from);
          current = from;
        }
        // The owner holds every staff permission, so a refusal can only come from the table itself.
        const res = await move(alpha.owner, request.id, to, { reason: 'trying an arbitrary jump' });
        if (res.status !== 409 || res.body.code !== 'INVALID_TRANSITION') wrong.push(`${from} -> ${to}: ${res.status} ${res.body.code}`);
        else if (res.body.message !== `A request cannot go from ${REQUEST_STATUS_META[from].en} to ${REQUEST_STATUS_META[to].en}.`) wrong.push(`${from} -> ${to}: message "${res.body.message}"`);
      }
      expect(wrong).toEqual([]);
      // None of the 200+ attempts changed anything or left a trace in the history.
      expect(await statusOf(t, request.id)).toBe(current);
      expect((await historyOf(t, request.id)).map((h) => h.toStatus)).toEqual(['DRAFT', 'SUBMITTED']);
    });

    it('every listed edge is recognised (never INVALID_TRANSITION, never a server error), whatever the guards say', async () => {
      const service = await createService(t, alpha);
      const customer = await createCustomer(t, alpha);
      const request = await submittedRequest(t, alpha, receptionist, service.id, customer.id);
      const outcomes: Record<string, number> = {};
      for (const from of STATUSES) {
        for (const rule of REQUEST_TRANSITIONS[from]) {
          await forceStatus(t, request.id, from);
          const res = await move(alpha.owner, request.id, rule.to, { reason: 'listed edge' });
          expect({ edge: `${from} -> ${rule.to}`, known: res.body.code !== 'INVALID_TRANSITION', ok: [200, 402, 403, 422].includes(res.status) }).toEqual({ edge: `${from} -> ${rule.to}`, known: true, ok: true });
          outcomes[res.status] = (outcomes[res.status] ?? 0) + 1;
        }
      }
      expect(outcomes[200]).toBeGreaterThan(5);
      expect(outcomes[422]).toBeGreaterThan(5);
    });

    it('only the state machine writes service_requests.status', () => {
      const writers: string[] = [];
      for (const dir of [__dirname, join(__dirname, '..', 'workflows')]) {
        for (const file of readdirSync(dir)) {
          if (!file.endsWith('.ts') || file.endsWith('.spec.ts') || file === 'fixtures.ts') continue;
          const source: string = readFileSync(join(dir, file), 'utf8');
          // Any write to a request row whose statement mentions the `status` column.
          if (/serviceRequest\.(update|updateMany|upsert|create|createMany)\([^;]*?\bstatus\s*:/s.test(source) || /UPDATE\s+"service_requests"/i.test(source)) writers.push(file);
        }
      }
      // requests.service.ts creates the row (always as DRAFT); every later change is the state machine's.
      expect(writers.sort()).toEqual(['request-state-machine.service.ts', 'requests.service.ts']);
      const creator: string = readFileSync(join(__dirname, 'requests.service.ts'), 'utf8');
      const statements = creator.match(/serviceRequest\.(update|updateMany|upsert|create|createMany)\([^;]*?\bstatus\s*:\s*[^,}]+/gs) ?? [];
      expect(statements).toHaveLength(1);
      expect(statements[0]).toMatch(/^serviceRequest\.create\(/);
      expect(statements[0]).toMatch(/status: 'DRAFT'$/);
    });

    it('unknown statuses are rejected by validation', async () => {
      const service = await createService(t, alpha);
      const request = await submittedRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
      await move(alpha.owner, request.id, 'DONE').expect(400);
      await move(alpha.owner, request.id, '').expect(400);
      await t.as(alpha.owner).post(`/requests/${request.id}/transition`, {}).expect(400);
    });
  });

  // =====================================================================================
  describe('who may use an edge', () => {
    it('staff need one of the permissions of the edge', async () => {
      const service = await createService(t, alpha, { requiresApproval: false, complianceCapability: 'DOCUMENT_PREPARATION_ONLY' });
      const request = await readyRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
      await assign(request.id, operator).expect(200);
      // A receptionist starts requests but does not process them.
      const refused = await move(receptionist, request.id, 'IN_PREPARATION').expect(403);
      expect(refused.body.code).toBe('FORBIDDEN');
      expect(await statusOf(t, request.id)).toBe('READY_FOR_PROCESSING');
      await move(reviewer, request.id, 'IN_PREPARATION').expect(403);
      await move(operator, request.id, 'IN_PREPARATION').expect(200);
      await move(operator, request.id, 'FINAL_REVIEW').expect(200);
      // Completing belongs to request.review / request.reopen.
      await move(operator, request.id, 'COMPLETED').expect(403);
      await move(receptionist, request.id, 'COMPLETED').expect(403);
      await move(reviewer, request.id, 'COMPLETED').expect(200);
      // Reopening belongs to request.reopen only.
      await move(reviewer, request.id, 'IN_PREPARATION', { reason: 'please' }).expect(403);
      await move(operator, request.id, 'IN_PREPARATION', { reason: 'please' }).expect(403);
      await move(manager, request.id, 'IN_PREPARATION', { reason: 'Correction needed' }).expect(200);
    });

    it('edges that only the system may use cannot be triggered by hand, not even by the owner', async () => {
      const service = await createService(t, alpha);
      const request = await submittedRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
      await completeDocuments(t, alpha, request.id);
      await sendQuotation(t, alpha, request.id);
      expect(await statusOf(t, request.id)).toBe('QUOTED');
      for (const to of ['AWAITING_PAYMENT', 'READY_FOR_PROCESSING']) {
        const res = await move(alpha.owner, request.id, to).expect(403);
        expect(res.body).toMatchObject({ code: 'TRANSITION_NOT_ALLOWED', message: 'This step happens automatically and cannot be triggered by hand.' });
      }
      expect(await statusOf(t, request.id)).toBe('QUOTED');
    });

    it('customers can only use customer edges, and only on their own requests', async () => {
      const service = await createService(t, alpha);
      const own = (await t.as(customerActor).post('/requests', { serviceId: service.id, fields: { purpose: 'family' } }).expect(201)).body;
      const other = await draftRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
      // Someone else's request does not exist for this customer.
      await move(customerActor, other.id, 'SUBMITTED').expect(404);
      await move(customerActor, other.id, 'CANCELLED', { reason: 'not mine' }).expect(404);
      expect(await statusOf(t, other.id)).toBe('DRAFT');
      // Their own: submit is a customer edge ...
      await move(customerActor, own.id, 'SUBMITTED').expect(200);
      // ... staff edges are not.
      const refused = await move(customerActor, own.id, 'UNDER_REVIEW').expect(403);
      expect(refused.body).toMatchObject({ code: 'FORBIDDEN', message: 'This step is done by the centre.' });
      await move(customerActor, own.id, 'AWAITING_CUSTOMER', { reason: 'x' }).expect(403);
      expect(await statusOf(t, own.id)).toBe('SUBMITTED');
      // Customers cannot reach staff-only action endpoints at all.
      await t.as(customerActor).post(`/requests/${own.id}/assign`, { assigneeMembershipId: operator.membershipId }).expect(403);
      await t.as(customerActor).post(`/requests/${own.id}/request-information`, { message: 'hello there' }).expect(403);
      await t.as(customerActor).post(`/requests/${own.id}/complete`).expect(403);
      await t.as(customerActor).post(`/requests/${own.id}/external-references`, { channel: 'MANUAL_PORTAL', referenceNo: 'X-1' }).expect(403);
      await t.as(customerActor).post(`/requests/${own.id}/workflow/migrate`).expect(403);
    });

    it('the engine authority cannot be requested over HTTP', async () => {
      const service = await createService(t, alpha);
      const request = await submittedRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
      await completeDocuments(t, alpha, request.id);
      await sendQuotation(t, alpha, request.id);
      // Extra body fields are ignored by validation; the system-only edge stays closed.
      const res = await t.as(alpha.owner).post(`/requests/${request.id}/transition`, { to: 'AWAITING_PAYMENT', actor: { kind: 'ENGINE' }, engine: true, via: 'ENGINE' });
      expect([res.status, res.body.code]).toEqual([403, 'TRANSITION_NOT_ALLOWED']);
      // In code, a system actor is limited to system edges as well.
      const machine = t.get(RequestStateMachine);
      await expect(t.inTenant(alpha.id, () => t.db.tx((tx) => machine.transition(tx, request.id, 'CANCELLED', { actor: { kind: 'SYSTEM' }, reason: 'automation' })))).rejects.toMatchObject({ code: 'TRANSITION_NOT_ALLOWED' });
      await expect(t.inTenant(alpha.id, () => t.db.tx((tx) => machine.transition(tx, request.id, 'CANCELLED', { actor: { kind: 'CONTEXT' }, reason: 'job context' })))).rejects.toMatchObject({ code: 'TRANSITION_NOT_ALLOWED' });
      // And even the engine cannot leave the table.
      await expect(t.inTenant(alpha.id, () => t.db.tx((tx) => machine.transition(tx, request.id, 'COMPLETED', { actor: { kind: 'ENGINE' } })))).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
      expect(await statusOf(t, request.id)).toBe('QUOTED');
    });

    it('a reason is mandatory where the table says so', async () => {
      const service = await createService(t, alpha);
      const request = await submittedRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
      const missing = await move(manager, request.id, 'CANCELLED').expect(422);
      expect(missing.body).toMatchObject({ code: 'REASON_REQUIRED', message: 'Please give a reason to cancel request.' });
      await move(manager, request.id, 'CANCELLED', { reason: '   ' }).expect(422);
      expect((await move(receptionist, request.id, 'AWAITING_CUSTOMER').expect(422)).body.code).toBe('REASON_REQUIRED');
      expect(await statusOf(t, request.id)).toBe('SUBMITTED');
      await move(manager, request.id, 'CANCELLED', { reason: 'Customer never came back' }).expect(200);
      expect(await getRequest(t, request.id)).toMatchObject({ status: 'CANCELLED', cancellationReason: 'Customer never came back' });
    });
  });

  // =====================================================================================
  describe('guards', () => {
    it('-> SUBMITTED needs a valid form', async () => {
      const service = await createService(t, alpha);
      const draft = (await t.as(receptionist).post('/requests', { serviceId: service.id, customerId: (await createCustomer(t, alpha)).id }).expect(201)).body;
      expect(draft.allowedActions.transitions.find((x: any) => x.to === 'SUBMITTED')).toMatchObject({ enabled: false, blocked: { code: 'FORM_INVALID' } });
      const res = await move(receptionist, draft.id, 'SUBMITTED').expect(422);
      expect(res.body).toMatchObject({ code: 'FORM_INVALID', message: 'The application form is not complete: Purpose is required.' });
      expect(await statusOf(t, draft.id)).toBe('DRAFT');
      // Nothing was counted against the plan and no workflow was started.
      expect(await t.sys.workflowExecution.count({ where: { requestId: draft.id } })).toBe(0);
    });

    it('-> READY_FOR_PROCESSING needs verified documents', async () => {
      const service = await createService(t, alpha, { paymentPolicy: 'AFTER_COMPLETION' });
      const request = await submittedRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
      const [passportLine, photoLine] = await checklistOf(t, request.id);
      const passport = await uploadFor(t, alpha, request.id, passportLine);
      await uploadFor(t, alpha, request.id, photoLine);
      await verifyDocument(t, alpha, passport.id, request.id);
      expect(await statusOf(t, request.id)).toBe('UNDER_REVIEW');
      // The reviewer holds document.verify, the permission of this edge.
      const unverified = await move(reviewer, request.id, 'READY_FOR_PROCESSING').expect(422);
      expect(unverified.body).toMatchObject({ code: 'DOCUMENTS_NOT_VERIFIED', message: 'These required documents are not verified yet: Personal photo.' });
      // A waiver with a reason counts like a verification.
      await t.as(reviewer).post(`/requests/${request.id}/checklist/${photoLine.id}/waive`, {}).expect(400);
      await t.as(receptionist).post(`/requests/${request.id}/checklist/${photoLine.id}/waive`, { reason: 'Photo on file from last year' }).expect(403);
      const waived = (await t.as(reviewer).post(`/requests/${request.id}/checklist/${photoLine.id}/waive`, { reason: 'Photo on file from last year' }).expect(200)).body;
      expect(waived.checklist[1]).toMatchObject({ status: 'WAIVED', note: 'Photo on file from last year' });
      await move(reviewer, request.id, 'READY_FOR_PROCESSING').expect(200);
    });

    it('-> READY_FOR_PROCESSING needs the payment policy satisfied (BEFORE_PROCESSING)', async () => {
      const service = await createService(t, alpha, { paymentPolicy: 'BEFORE_PROCESSING' });
      const request = await submittedRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
      await completeDocuments(t, alpha, request.id);
      // Documents are fine, but nothing was invoiced or paid.
      const noInvoice = await move(reviewer, request.id, 'READY_FOR_PROCESSING').expect(422);
      expect(noInvoice.body).toMatchObject({ code: 'PAYMENT_REQUIRED', details: { basis: 'NO_INVOICE' } });
      const { invoice } = await approveQuotation(t, alpha, (await sendQuotation(t, alpha, request.id, 200)).id);
      expect(await statusOf(t, request.id)).toBe('AWAITING_PAYMENT');
      await payInvoice(t, alpha, invoice!.id, 199);
      expect(await statusOf(t, request.id)).toBe('AWAITING_PAYMENT');
      await payInvoice(t, alpha, invoice!.id, 1);
      expect(await statusOf(t, request.id)).toBe('READY_FOR_PROCESSING');
    });

    it('-> READY_FOR_PROCESSING with a DEPOSIT policy needs the deposit, completion needs the rest', async () => {
      const service = await createService(t, alpha, { paymentPolicy: 'DEPOSIT', depositPercent: 40, requiresApproval: false, complianceCapability: 'DOCUMENT_PREPARATION_ONLY' });
      const request = await submittedRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
      await completeDocuments(t, alpha, request.id);
      const { invoice } = await approveQuotation(t, alpha, (await sendQuotation(t, alpha, request.id, 1000)).id);
      expect(await statusOf(t, request.id)).toBe('AWAITING_PAYMENT');
      await payInvoice(t, alpha, invoice!.id, 399);
      const view = (await t.as(manager).get(`/requests/${request.id}`).expect(200)).body;
      expect(view.status).toBe('AWAITING_PAYMENT');
      expect(view.nextStep.step.blocked).toEqual({ code: 'PAYMENT_REQUIRED', message: 'Waiting for payment (1.00 outstanding).' });
      await payInvoice(t, alpha, invoice!.id, 1);
      expect(await getRequest(t, request.id)).toMatchObject({ status: 'READY_FOR_PROCESSING', paymentStatus: 'PARTIALLY_PAID' });

      await assign(request.id, operator).expect(200);
      await move(operator, request.id, 'IN_PREPARATION').expect(200);
      await move(operator, request.id, 'FINAL_REVIEW').expect(200);
      const unpaid = await t.as(reviewer).post(`/requests/${request.id}/complete`).expect(422);
      expect(unpaid.body).toMatchObject({ code: 'PAYMENT_INCOMPLETE', message: 'The request cannot be completed while 600.00 is still unpaid.' });
      await payInvoice(t, alpha, invoice!.id);
      await t.as(reviewer).post(`/requests/${request.id}/complete`).expect(200);
      expect(await getRequest(t, request.id)).toMatchObject({ status: 'COMPLETED', paymentStatus: 'PAID' });
    });

    it('corporate requests on an active account with approved credit are invoiced on account', async () => {
      const service = await createService(t, alpha, { requiresApproval: false, complianceCapability: 'DOCUMENT_PREPARATION_ONLY' });
      const credit = await createCorporateAccount(t, alpha, { creditApproved: true });
      const noCredit = await createCorporateAccount(t, alpha, { creditApproved: false });
      const run = async (accountId: string) => {
        const employee = await createCustomer(t, alpha, { corporateAccountId: accountId });
        const request = await submittedRequest(t, alpha, receptionist, service.id, employee.id, { corporateAccountId: accountId });
        await completeDocuments(t, alpha, request.id);
        const { invoice } = await approveQuotation(t, alpha, (await sendQuotation(t, alpha, request.id, 900)).id);
        return { id: request.id as string, invoice: invoice! };
      };
      const onAccount = await run(credit.id);
      expect(await getRequest(t, onAccount.id)).toMatchObject({ status: 'READY_FOR_PROCESSING', paymentStatus: 'UNPAID', corporateAccountId: credit.id });
      expect((await t.sys.workflowStepExecution.findFirstOrThrow({ where: { execution: { requestId: onAccount.id }, stepKey: 'payment' } })).result).toMatchObject({ skipped: 'CORPORATE_CREDIT' });
      // Completion is not blocked by the open invoice either.
      await assign(onAccount.id, operator).expect(200);
      await move(operator, onAccount.id, 'IN_PREPARATION').expect(200);
      await move(operator, onAccount.id, 'FINAL_REVIEW').expect(200);
      await t.as(reviewer).post(`/requests/${onAccount.id}/complete`).expect(200);

      // Without approved credit the company pays like everybody else.
      const prepaid = await run(noCredit.id);
      expect(await statusOf(t, prepaid.id)).toBe('AWAITING_PAYMENT');
      // Credit that is withdrawn (account suspended) stops applying immediately.
      const third = await run(credit.id);
      expect(await statusOf(t, third.id)).toBe('READY_FOR_PROCESSING');
      await t.sys.corporateAccount.update({ where: { id: credit.id }, data: { status: 'SUSPENDED' } });
      await assign(third.id, operator).expect(200);
      await move(operator, third.id, 'IN_PREPARATION').expect(200);
      await move(operator, third.id, 'FINAL_REVIEW').expect(200);
      expect((await t.as(reviewer).post(`/requests/${third.id}/complete`).expect(422)).body.code).toBe('PAYMENT_INCOMPLETE');
    });

    it('-> QUOTED needs a sent quotation and leaving QUOTED needs its approval', async () => {
      const service = await createService(t, alpha);
      const request = await submittedRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
      await completeDocuments(t, alpha, request.id);
      const res = await move(receptionist, request.id, 'QUOTED').expect(422);
      expect(res.body).toMatchObject({ code: 'QUOTATION_REQUIRED', message: 'Send the quotation to the customer first.' });
      await sendQuotation(t, alpha, request.id);
      expect(await statusOf(t, request.id)).toBe('QUOTED');
      // A quotation that was sent but not approved does not release the request, whoever asks.
      const machine = t.get(RequestStateMachine);
      await expect(t.inTenant(alpha.id, () => t.db.tx((tx) => machine.transition(tx, request.id, 'READY_FOR_PROCESSING', { actor: { kind: 'ENGINE' } })))).rejects.toMatchObject({ code: 'QUOTATION_NOT_APPROVED' });
      await expect(t.inTenant(alpha.id, () => t.db.tx((tx) => machine.transition(tx, request.id, 'AWAITING_PAYMENT', { actor: { kind: 'SYSTEM' } })))).rejects.toMatchObject({ code: 'QUOTATION_NOT_APPROVED' });
    });

    it('a request that waits for the customer can only return to where the question was asked', async () => {
      const service = await createService(t, alpha);
      // Asked before the request was released: "resume preparation" would skip the document and payment checks.
      const early = await submittedRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
      await t.as(receptionist).post(`/requests/${early.id}/request-information`, { message: 'Please upload your documents.' }).expect(200);
      const shortcut = await move(manager, early.id, 'IN_PREPARATION').expect(422);
      expect(shortcut.body).toMatchObject({ code: 'NOT_RELEASED_FOR_PROCESSING', message: 'This request was not in preparation when the customer was asked. It returns to document review first.' });
      expect(await statusOf(t, early.id)).toBe('AWAITING_CUSTOMER');
      await move(receptionist, early.id, 'UNDER_REVIEW').expect(200);

      // Asked during preparation: it returns to preparation, not back to document review.
      const late = await readyRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
      await assign(late.id, operator).expect(200);
      await move(operator, late.id, 'IN_PREPARATION').expect(200);
      await move(operator, late.id, 'AWAITING_CUSTOMER', { reason: 'Which sponsor should be named?' }).expect(200);
      expect((await move(receptionist, late.id, 'UNDER_REVIEW').expect(422)).body.code).toBe('RESUME_PREPARATION');
      await move(operator, late.id, 'IN_PREPARATION').expect(200);
    });

    it('"revise quotation" follows the quotation: an offer that still stands cannot be bypassed by hand', async () => {
      const service = await createService(t, alpha);
      const request = await submittedRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
      await completeDocuments(t, alpha, request.id);
      const first = await sendQuotation(t, alpha, request.id, 800);
      // With the customer: going back to review by hand is refused.
      expect((await move(receptionist, request.id, 'UNDER_REVIEW').expect(422)).body.code).toBe('QUOTATION_PENDING');
      const { invoice } = await approveQuotation(t, alpha, first.id);
      expect(await statusOf(t, request.id)).toBe('AWAITING_PAYMENT');
      expect((await move(receptionist, request.id, 'QUOTED').expect(422)).body.code).toBe('QUOTATION_STILL_APPROVED');

      // Finance replaces the approved quotation with a revised one: the request returns to the customer by itself.
      await t.sys.quotation.update({ where: { id: first.id }, data: { status: 'SUPERSEDED' } });
      await t.sys.invoice.update({ where: { id: invoice!.id }, data: { status: 'VOID', voidedAt: new Date(), voidReason: 'Quotation revised' } });
      const second = await sendQuotation(t, alpha, request.id, 650);
      expect(await statusOf(t, request.id)).toBe('QUOTED');
      const row = (await historyOf(t, request.id)).pop()!;
      expect(row).toMatchObject({ fromStatus: 'AWAITING_PAYMENT', toStatus: 'QUOTED', reason: 'Quotation revised', customerMessage: 'Your quotation was revised. Please review it.' });
      const steps = await t.sys.workflowStepExecution.findMany({ where: { execution: { requestId: request.id }, stepKey: { in: ['customer-approval', 'payment'] } }, orderBy: [{ createdAt: 'asc' }, { attempt: 'asc' }] });
      expect(steps.map((s) => [s.stepKey, s.attempt, s.status])).toEqual([['customer-approval', 1, 'COMPLETED'], ['payment', 1, 'COMPLETED'], ['customer-approval', 2, 'ACTIVE']]);
      // The voided invoice no longer counts; the new approval and its invoice do.
      const again = await approveQuotation(t, alpha, second.id);
      expect(await getRequest(t, request.id)).toMatchObject({ status: 'AWAITING_PAYMENT', paymentStatus: 'UNPAID' });
      await payInvoice(t, alpha, again.invoice!.id);
      expect(await getRequest(t, request.id)).toMatchObject({ status: 'READY_FOR_PROCESSING', paymentStatus: 'PAID' });
    });

    it('-> IN_PREPARATION needs an assigned operator', async () => {
      const service = await createService(t, alpha);
      const request = await readyRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
      const view = (await t.as(manager).get(`/requests/${request.id}`).expect(200)).body;
      expect(view.allowedActions.transitions.find((x: any) => x.to === 'IN_PREPARATION')).toMatchObject({ enabled: false, blocked: { code: 'OPERATOR_REQUIRED', message: 'Assign an operator before preparation starts.' } });
      expect((await move(manager, request.id, 'IN_PREPARATION').expect(422)).body.code).toBe('OPERATOR_REQUIRED');
      // A reviewer assignment does not count.
      await assign(request.id, reviewer, 'REVIEWER').expect(200);
      expect((await move(manager, request.id, 'IN_PREPARATION').expect(422)).body.code).toBe('OPERATOR_REQUIRED');
      await assign(request.id, operator).expect(200);
      await move(manager, request.id, 'IN_PREPARATION').expect(200);
    });

    it('-> READY_TO_SUBMIT: directly only without review; from review only with an approval', async () => {
      const noReview = await createService(t, alpha, { requiresApproval: false });
      const a = await readyRequest(t, alpha, receptionist, noReview.id, (await createCustomer(t, alpha)).id);
      await assign(a.id, operator).expect(200);
      await move(operator, a.id, 'IN_PREPARATION').expect(200);
      await move(operator, a.id, 'READY_TO_SUBMIT').expect(200);

      const withReview = await createService(t, alpha, { requiresApproval: true });
      const b = await readyRequest(t, alpha, receptionist, withReview.id, (await createCustomer(t, alpha)).id);
      await assign(b.id, operator).expect(200);
      await move(operator, b.id, 'IN_PREPARATION').expect(200);
      expect((await move(operator, b.id, 'READY_TO_SUBMIT').expect(422)).body).toMatchObject({ code: 'APPROVAL_REQUIRED', message: 'This case requires review approval. Send it for review instead.' });
      await move(operator, b.id, 'PENDING_APPROVAL').expect(200);
      // "Approve" without a decided review is refused, for the reviewer too.
      const undecided = await move(reviewer, b.id, 'READY_TO_SUBMIT').expect(422);
      expect(undecided.body).toMatchObject({ code: 'APPROVAL_REQUIRED', message: 'A reviewer must approve the prepared application first.' });
      // "Send back" through the generic endpoint closes the pending review as rejected.
      await move(reviewer, b.id, 'IN_PREPARATION', { reason: 'Missing sponsor details' }).expect(200);
      expect(await t.sys.requestApproval.findFirstOrThrow({ where: { requestId: b.id } })).toMatchObject({ status: 'REJECTED', decidedById: reviewer.userId, comment: 'Missing sponsor details' });
    });

    it('-> FINAL_REVIEW: skipping submission is only possible when the centre does not submit the service', async () => {
      // Preparation-only: the standard workflow skips the submission step and final review follows directly.
      const prepOnly = await createService(t, alpha, { requiresApproval: false, complianceCapability: 'DOCUMENT_PREPARATION_ONLY' });
      const a = await readyRequest(t, alpha, receptionist, prepOnly.id, (await createCustomer(t, alpha)).id);
      await assign(a.id, operator).expect(200);
      await move(operator, a.id, 'IN_PREPARATION').expect(200);
      await move(operator, a.id, 'READY_TO_SUBMIT').expect(200);
      // The workflow has no applicable submission step, so the engine moves on to final review itself.
      expect(await statusOf(t, a.id)).toBe('FINAL_REVIEW');

      // Direct submission by the centre: neither preparation nor "ready to submit" may jump to final review.
      const direct = await createService(t, alpha, { requiresApproval: false, complianceCapability: 'DIRECT_AUTHORISED' });
      const b = await readyRequest(t, alpha, receptionist, direct.id, (await createCustomer(t, alpha)).id);
      await assign(b.id, operator).expect(200);
      await move(operator, b.id, 'IN_PREPARATION').expect(200);
      expect((await move(operator, b.id, 'FINAL_REVIEW').expect(422)).body).toMatchObject({ code: 'EXTERNAL_SUBMISSION_PENDING', message: 'This application has to be submitted and its reference recorded before final review.' });
      await move(operator, b.id, 'READY_TO_SUBMIT').expect(200);
      expect((await move(operator, b.id, 'FINAL_REVIEW').expect(422)).body.code).toBe('EXTERNAL_SUBMISSION_PENDING');
      expect(await statusOf(t, b.id)).toBe('READY_TO_SUBMIT');
    });

    it('-> COMPLETED needs completion documents, full payment and (when required) an approved review', async () => {
      const service = await createService(t, alpha, { requiresApproval: false, complianceCapability: 'DOCUMENT_PREPARATION_ONLY', paymentPolicy: 'AFTER_COMPLETION' });
      const customer = await createCustomer(t, alpha);
      const request = await submittedRequest(t, alpha, receptionist, service.id, customer.id);
      await completeDocuments(t, alpha, request.id);
      const { invoice } = await approveQuotation(t, alpha, (await sendQuotation(t, alpha, request.id, 250)).id);
      // Pay-after-completion: released without payment.
      expect(await getRequest(t, request.id)).toMatchObject({ status: 'READY_FOR_PROCESSING', paymentStatus: 'UNPAID' });
      await assign(request.id, operator).expect(200);
      await move(operator, request.id, 'IN_PREPARATION').expect(200);
      const line = (await t.as(operator).post(`/requests/${request.id}/checklist`, { documentTypeKey: 'completed_document', label: 'Typed contract', kind: 'COMPLETION' }).expect(201)).body.checklist.find((l: any) => l.kind === 'COMPLETION');
      // Only staff who process may manage completion documents.
      await t.as(receptionist).post(`/requests/${request.id}/checklist`, { documentTypeKey: 'completed_document', label: 'Another', kind: 'COMPLETION' }).expect(403);
      await move(operator, request.id, 'FINAL_REVIEW').expect(200);

      const view = (await t.as(reviewer).get(`/requests/${request.id}`).expect(200)).body;
      expect(view.allowedActions.transitions.find((x: any) => x.to === 'COMPLETED')).toMatchObject({ enabled: false, blocked: { code: 'COMPLETION_DOCUMENTS_MISSING' } });
      expect((await t.as(reviewer).post(`/requests/${request.id}/complete`).expect(422)).body).toMatchObject({ code: 'COMPLETION_DOCUMENTS_MISSING', message: 'Attach the completed documents first: Typed contract.' });
      const contract = await createDocument(t, alpha, { customerId: customer.id, requestId: request.id, documentTypeKey: 'completed_document', isCompletionDocument: true });
      await t.as(receptionist).put(`/requests/${request.id}/checklist/${line.id}/document`, { documentId: contract.id }).expect(403);
      await t.as(operator).put(`/requests/${request.id}/checklist/${line.id}/document`, { documentId: contract.id }).expect(200);
      expect((await t.as(reviewer).post(`/requests/${request.id}/complete`).expect(422)).body.code).toBe('PAYMENT_INCOMPLETE');
      await payInvoice(t, alpha, invoice!.id);
      await t.as(reviewer).post(`/requests/${request.id}/complete`).expect(200);
    });
  });

  // =====================================================================================
  describe('one transaction, one winner', () => {
    it('simultaneous submit and cancel are serialised: the history is always a valid path', async () => {
      const service = await createService(t, alpha);
      for (let round = 0; round < 4; round++) {
        const draft = await draftRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
        const [submit, cancel] = await Promise.all([move(receptionist, draft.id, 'SUBMITTED'), move(manager, draft.id, 'CANCELLED', { reason: 'Entered by mistake' })]);
        const codes = [submit.status, cancel.status].sort();
        const final = await statusOf(t, draft.id);
        // Either the cancellation came first (then submitting a cancelled request is refused),
        // or the submission came first and the cancellation of the submitted request is a second, valid step.
        if (final === 'CANCELLED' && codes[1] === 409) {
          expect(submit.body.code).toBe('INVALID_TRANSITION');
          expect((await historyOf(t, draft.id)).map((h) => h.toStatus)).toEqual(['DRAFT', 'CANCELLED']);
        } else {
          expect(codes).toEqual([200, 200]);
          expect((await historyOf(t, draft.id)).map((h) => h.toStatus)).toEqual(['DRAFT', 'SUBMITTED', 'CANCELLED']);
        }
        const history = await historyOf(t, draft.id);
        expect(history.map((h) => (h.meta as any).seq)).toEqual(history.map((_, i) => i + 1));
      }
    });

    it('the same transition requested twice at the same time happens once', async () => {
      const service = await createService(t, alpha, { requiresApproval: false, complianceCapability: 'DOCUMENT_PREPARATION_ONLY' });
      const request = await readyRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
      await assign(request.id, operator).expect(200);
      const results = await Promise.all([1, 2, 3, 4].map(() => move(operator, request.id, 'IN_PREPARATION')));
      expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
      expect(results.filter((r) => r.status === 409).every((r) => r.body.code === 'INVALID_TRANSITION')).toBe(true);
      expect((await historyOf(t, request.id)).filter((h) => h.toStatus === 'IN_PREPARATION')).toHaveLength(1);
      expect(await t.sys.auditLog.count({ where: { resourceId: request.id, action: 'request.status_changed', summary: { contains: 'In preparation' } } })).toBe(1);
      expect((await getRequest(t, request.id)).version).toBeGreaterThan(1);
    });

    it('two simultaneous conflicting transitions: exactly one wins, the other is refused', async () => {
      const service = await createService(t, alpha, { requiresApproval: false, complianceCapability: 'DOCUMENT_PREPARATION_ONLY' });
      const request = await readyRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
      await assign(request.id, operator).expect(200);
      await move(operator, request.id, 'IN_PREPARATION').expect(200);
      const [toReview, toCustomer] = await Promise.all([move(operator, request.id, 'FINAL_REVIEW'), move(operator, request.id, 'AWAITING_CUSTOMER', { reason: 'Need the original contract' })]);
      expect([toReview.status, toCustomer.status].sort()).toEqual([200, 409]);
      const final = await statusOf(t, request.id);
      expect(['FINAL_REVIEW', 'AWAITING_CUSTOMER']).toContain(final);
      expect((await historyOf(t, request.id)).pop()!.toStatus).toBe(final);
    });

    it('optimistic locking: a stale version is refused', async () => {
      const service = await createService(t, alpha);
      const draft = await draftRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
      const fresh = (await t.as(receptionist).patch(`/requests/${draft.id}`, { instructions: 'Urgent please', version: draft.version }).expect(200)).body;
      expect(fresh.version).toBe(draft.version + 1);
      const stale = await t.as(receptionist).patch(`/requests/${draft.id}`, { instructions: 'Overwrite', version: draft.version }).expect(409);
      expect(stale.body).toMatchObject({ code: 'STALE_VERSION', details: { currentVersion: fresh.version } });
      expect((await move(receptionist, draft.id, 'SUBMITTED', { version: draft.version }).expect(409)).body.code).toBe('STALE_VERSION');
      await move(receptionist, draft.id, 'SUBMITTED', { version: fresh.version }).expect(200);
      expect((await getRequest(t, draft.id)).customerInstructions).toBe('Urgent please');
    });

    it('a failed guard leaves no trace: no history, no event, no audit entry, no counter', async () => {
      const service = await createService(t, alpha);
      const draft = (await t.as(receptionist).post('/requests', { serviceId: service.id, customerId: (await createCustomer(t, alpha)).id }).expect(201)).body;
      const before = {
        history: await t.sys.requestStatusHistory.count({ where: { requestId: draft.id } }),
        events: await t.sys.outboxEvent.count({ where: { tenantId: alpha.id } }),
        audit: await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'request.status_changed' } }),
        usage: Number((await t.sys.usageRecord.findFirst({ where: { tenantId: alpha.id, metric: 'monthlyRequests' } }))?.quantity ?? 0),
      };
      await move(receptionist, draft.id, 'SUBMITTED').expect(422);
      expect({
        history: await t.sys.requestStatusHistory.count({ where: { requestId: draft.id } }),
        events: await t.sys.outboxEvent.count({ where: { tenantId: alpha.id } }),
        audit: await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'request.status_changed' } }),
        usage: Number((await t.sys.usageRecord.findFirst({ where: { tenantId: alpha.id, metric: 'monthlyRequests' } }))?.quantity ?? 0),
      }).toEqual(before);
      expect((await getRequest(t, draft.id)).version).toBe(draft.version);
    });
  });
});
