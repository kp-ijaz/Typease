import { Actor, TenantFixture, TestApp, uniq } from '../../../test/helpers';
import { makeCustomer } from '../notifications/fixtures';
import { LogProvider } from '../notifications/providers/log';
import { addBranch } from '../reports/fixtures';
import {
  approveQuotation, checklistOf, completeDocuments, createCustomer, createDocument, createService, emit, historyOf, payInvoice, readyRequest, sendQuotation, ServiceOptions, statusOf, submittedRequest, uploadFor, verifyDocument,
} from '../requests/fixtures';
import { SCAN_JOB } from '../requests/workflow-engine.service';
import { AutomationEngine } from './engine.service';
import { createRule, executionsOf, onlyExecution, results } from './fixtures';

/**
 * Every action type, end to end: a real trigger event travels through the
 * outbox, the engine creates an execution, the job runs the action through the
 * service of the module that owns the data.
 */
describe('Automation actions', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let manager: Actor;
  let receptionist: Actor;
  let operator: Actor;
  let reviewer: Actor;
  let accountant: Actor;

  const inbox = async (actor: Actor) => (await t.as(actor).get('/me/notifications?pageSize=50').expect(200)).body.data as Array<{ subject: string; body: string }>;
  const near = (date: Date | null, expectedMs: number, toleranceMs = 120_000) => !!date && Math.abs(date.getTime() - expectedMs) < toleranceMs;
  const submit = async (options: ServiceOptions = {}, extra: Record<string, unknown> = {}, customerId?: string) => {
    const service = await createService(t, alpha, options);
    const request = await submittedRequest(t, alpha, receptionist, service.id, customerId ?? (await createCustomer(t, alpha)).id, extra);
    return { service, request: request as { id: string; requestNo: string; customerId: string } };
  };
  const overdue = async (requestId: string) => {
    await t.sys.serviceRequest.update({ where: { id: requestId }, data: { targetDate: new Date(Date.now() - 3_600_000) } });
    await t.jobs.runScheduled(SCAN_JOB);
    await t.settle();
  };

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    manager = await t.addStaff(alpha, 'manager');
    receptionist = await t.addStaff(alpha, 'receptionist');
    operator = await t.addStaff(alpha, 'operator');
    reviewer = await t.addStaff(alpha, 'reviewer');
    accountant = await t.addStaff(alpha, 'accountant');
    await t.settle();
  });
  afterAll(() => t.close());
  // Rules react to every matching event of the centre: each test starts without rules from the test before.
  afterEach(async () => {
    await t.settle();
    await t.sys.automationRule.updateMany({ where: { tenantId: alpha.id }, data: { isEnabled: false } });
  });

  // ------------------------------------------------------------------ create_task + conditions
  it('create_task: creates a task for the events that meet the conditions, and only for those', async () => {
    const service = await createService(t, alpha, { name: 'Golden visa' });
    const customer = await createCustomer(t, alpha, { fullName: 'Omar Haddad' });
    const rule = await createRule(t, manager, {
      name: 'Urgent golden visas',
      triggerEvent: 'request.submitted',
      conditions: { all: [{ fact: 'service.code', op: 'eq', value: service.code }, { fact: 'request.priority', op: 'in', value: ['HIGH', 'URGENT'] }] },
      actions: [{ type: 'create_task', config: { title: 'Urgent: {{requestNumber}} for {{customerName}}', description: '{{serviceName}} at {{branchName}} - {{statusLabel}}', priority: 'HIGH', roleKey: 'manager', dueInHours: 4 } }],
    });
    const normal = await submittedRequest(t, alpha, receptionist, service.id, customer.id);
    const urgent = await submittedRequest(t, alpha, receptionist, service.id, customer.id, { priority: 'URGENT' });
    const elsewhere = await submit({}, { priority: 'URGENT' }); // urgent, but another service
    await t.settle();

    const execution = await onlyExecution(t, rule.id);
    expect(execution).toMatchObject({ tenantId: alpha.id, eventType: 'request.submitted', status: 'SUCCEEDED', attempts: 1, error: null });
    expect(execution.startedAt).not.toBeNull();
    expect(execution.finishedAt).not.toBeNull();
    const tasks = await t.sys.task.findMany({ where: { tenantId: alpha.id, source: 'AUTOMATION', requestId: { in: [normal.id, urgent.id, elsewhere.request.id] } } });
    expect(tasks).toHaveLength(1);
    const branch = await t.sys.branch.findUniqueOrThrow({ where: { id: alpha.headOfficeId } });
    expect(tasks[0]).toMatchObject({
      requestId: urgent.id, customerId: customer.id, branchId: alpha.headOfficeId, type: 'GENERAL', source: 'AUTOMATION', status: 'OPEN', priority: 'HIGH', roleKey: 'manager',
      title: `Urgent: ${urgent.requestNo} for Omar Haddad`, description: `Golden visa at ${branch.name} - New`, createdById: null,
    });
    expect(near(tasks[0].dueAt, Date.now() + 4 * 3_600_000)).toBe(true);
    expect(results(execution)).toEqual([expect.objectContaining({ index: 0, type: 'create_task', status: 'SUCCEEDED', attempts: 1, output: { taskId: tasks[0].id, title: tasks[0].title } })]);
    // The task is visible in the normal task list of the role, and the audit trail names the automation.
    expect((await t.as(manager).get(`/tasks?requestId=${urgent.id}`).expect(200)).body.data.map((x: any) => x.id)).toContain(tasks[0].id);
    const audit = await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: alpha.id, action: 'task.created', resourceId: tasks[0].id } });
    expect(audit).toMatchObject({ actorType: 'AUTOMATION', actorUserId: null, actorLabel: 'automation:Urgent golden visas' });
  });

  // ------------------------------------------------------------------ create_follow_up
  it('create_follow_up: a follow-up with a due date after a quotation is approved', async () => {
    const rule = await createRule(t, manager, {
      triggerEvent: 'quotation.approved',
      conditions: { all: [{ fact: 'quotation.total', op: 'gte', value: 400 }, { fact: 'quotation.approvedByType', op: 'eq', value: 'CUSTOMER' }] },
      actions: [{ type: 'create_follow_up', config: { title: 'Follow up {{requestNumber}}: {{amount}} {{currency}} approved', priority: 'LOW', roleKey: 'receptionist' } }],
    });
    const big = await submit();
    await completeDocuments(t, alpha, big.request.id);
    await approveQuotation(t, alpha, (await sendQuotation(t, alpha, big.request.id, 650)).id);
    const small = await submit();
    await completeDocuments(t, alpha, small.request.id);
    await approveQuotation(t, alpha, (await sendQuotation(t, alpha, small.request.id, 150)).id);
    await t.settle();

    const execution = await onlyExecution(t, rule.id);
    expect(execution.status).toBe('SUCCEEDED');
    const tasks = await t.sys.task.findMany({ where: { tenantId: alpha.id, type: 'FOLLOW_UP' } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ requestId: big.request.id, source: 'AUTOMATION', type: 'FOLLOW_UP', priority: 'LOW', roleKey: 'receptionist', title: `Follow up ${big.request.requestNo}: 650.00 AED approved` });
    expect(near(tasks[0].dueAt, Date.now() + 2 * 86_400_000)).toBe(true); // default: two days
    expect(results(execution)[0].output).toMatchObject({ taskId: tasks[0].id });
  });

  // ------------------------------------------------------------------ assign_staff + loop protection
  it('assign_staff: assigns through the requests module, and what an automation does never starts another rule', async () => {
    const assignRule = await createRule(t, manager, { name: 'Auto assign', triggerEvent: 'request.submitted', actions: [{ type: 'assign_staff', config: { mode: 'AUTO' } }] });
    const onAssigned = await createRule(t, manager, { name: 'After assignment', triggerEvent: 'request.assigned', actions: [{ type: 'create_task', config: { title: 'Greet the customer of {{requestNumber}}' } }] });

    const { request } = await submit({ staffGroupRoleKey: 'operator' });
    await t.settle();
    const after = await t.sys.serviceRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(after.assignedToId).toBe(operator.membershipId);
    const assignment = await t.sys.requestAssignment.findFirstOrThrow({ where: { requestId: request.id } });
    expect(assignment).toMatchObject({ assigneeId: operator.membershipId, role: 'OPERATOR', method: 'AUTO', assignedById: null });
    expect(results(await onlyExecution(t, assignRule.id))[0]).toMatchObject({ status: 'SUCCEEDED', output: { assigneeMembershipId: operator.membershipId, role: 'OPERATOR', method: 'AUTO' } });
    // The operator can see the case (assigned-only scope) like after a manual assignment.
    await t.as(operator).get(`/requests/${request.id}`).expect(200);

    // The assignment made by the automation produced a real request.assigned event ...
    const events = await t.sys.outboxEvent.findMany({ where: { tenantId: alpha.id, type: 'request.assigned' } });
    const mine = events.find((e) => (e.payload as any).requestId === request.id)!;
    expect(mine.status).toBe('PROCESSED');
    expect((mine.payload as any)._actor).toEqual({ userId: null, type: 'AUTOMATION' });
    // ... which the standard notification still handled (the operator was told) but no rule saw.
    expect(await executionsOf(t, onAssigned.id)).toEqual([]);
    expect(await t.sys.task.count({ where: { requestId: request.id, source: 'AUTOMATION' } })).toBe(0);

    // The same event caused by a person starts the rule.
    const manual = await submit({ staffGroupRoleKey: 'reviewer' }); // nobody suitable for the automatic assignment
    await t.settle();
    await t.as(manager).post(`/requests/${manual.request.id}/assign`, { assigneeMembershipId: operator.membershipId, role: 'OPERATOR' }).expect(200);
    await t.settle();
    const second = await onlyExecution(t, onAssigned.id);
    expect(second.status).toBe('SUCCEEDED');
    expect(await t.sys.task.count({ where: { requestId: manual.request.id, title: `Greet the customer of ${manual.request.requestNo}` } })).toBe(1);
  });

  it('assign_staff: a named member takes an empty seat and never replaces the person who has the case', async () => {
    const service = await createService(t, alpha);
    const rule = await createRule(t, manager, {
      triggerEvent: 'request.submitted',
      conditions: { all: [{ fact: 'service.code', op: 'eq', value: service.code }] },
      actions: [{ type: 'assign_staff', config: { mode: 'MEMBER', membershipId: reviewer.membershipId, role: 'REVIEWER' } }, { type: 'assign_staff', config: { mode: 'MEMBER', membershipId: operator.membershipId } }],
    });
    const second = await t.addStaff(alpha, 'operator');
    const customer = await createCustomer(t, alpha);
    const empty = await submittedRequest(t, alpha, receptionist, service.id, customer.id);
    // This one already has an operator when the event arrives.
    const draft = (await t.as(receptionist).post('/requests', { serviceId: service.id, customerId: customer.id, fields: { purpose: 'family' } }).expect(201)).body;
    await t.as(manager).post(`/requests/${draft.id}/assign`, { assigneeMembershipId: second.membershipId, role: 'OPERATOR' }).expect(200);
    await t.as(receptionist).post(`/requests/${draft.id}/submit`).expect(200);
    await t.settle();

    expect(await t.sys.serviceRequest.findUniqueOrThrow({ where: { id: empty.id } })).toMatchObject({ assignedToId: operator.membershipId, reviewerId: reviewer.membershipId });
    expect(await t.sys.serviceRequest.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({ assignedToId: second.membershipId, reviewerId: reviewer.membershipId });
    const executions = await executionsOf(t, rule.id);
    expect(executions.map((e) => e.status)).toEqual(['SUCCEEDED', 'SUCCEEDED']);
    const taken = executions.find((e) => results(e)[1].status === 'SKIPPED')!;
    expect(results(taken)).toEqual([expect.objectContaining({ status: 'SUCCEEDED' }), expect.objectContaining({ status: 'SKIPPED', output: { reason: 'The request already has an operator.' } })]);
  });

  // ------------------------------------------------------------------ send_notification
  it('send_notification: to the customer through the notifications module, so opt-outs apply', async () => {
    const service = await createService(t, alpha, { name: 'Tenancy contract typing' });
    const customer = await makeCustomer(t, alpha, { fullName: 'Layla Hassan', communicationPrefs: { email: true, sms: false, whatsapp: false, push: true } });
    const rule = await createRule(t, manager, {
      name: 'Welcome message',
      triggerEvent: 'request.submitted',
      conditions: { all: [{ fact: 'service.code', op: 'eq', value: service.code }] },
      actions: [{ type: 'send_notification', config: { to: 'CUSTOMER', channels: ['EMAIL', 'SMS', 'IN_APP'], subject: 'We are on it: {{requestNumber}}', body: 'Dear {{customerName}},\n\nwe received your request for {{serviceName}}.\n\n[Follow your request]({{portalLink}})\n\n{{centreName}}' } }],
    });
    const request = await submittedRequest(t, alpha, receptionist, service.id, customer.id);
    await t.settle();

    const execution = await onlyExecution(t, rule.id);
    expect(execution.status).toBe('SUCCEEDED');
    // Email went out, SMS was suppressed (opted out), nothing in-app (a walk-in customer has no portal account).
    expect(results(execution)[0]).toMatchObject({ status: 'SUCCEEDED', output: { to: 'CUSTOMER', recipients: 1, queued: 1, delivered: 0, suppressed: 1, suppressedReasons: ['OPT_OUT'] } });
    const rows = await t.sys.notification.findMany({ where: { tenantId: alpha.id, dedupeKey: { startsWith: `automation:${execution.id}:0:` } }, include: { notificationDeliveries: true }, orderBy: { channel: 'asc' } });
    expect(rows.map((r) => [r.channel, r.status, r.suppressedReason])).toEqual([['EMAIL', 'SENT', null], ['SMS', 'SUPPRESSED', 'OPT_OUT']]);
    expect(rows[0]).toMatchObject({ eventKey: 'automation.message', recipientCustomerId: customer.id, recipientAddress: customer.email, relatedType: 'ServiceRequest', relatedId: request.id, subject: `We are on it: ${request.requestNo}` });
    expect(rows[0].notificationDeliveries).toEqual([expect.objectContaining({ status: 'SENT' })]);
    const sent = LogProvider.outbox.filter((m) => m.message.to === customer.email && m.message.subject === `We are on it: ${request.requestNo}`);
    expect(sent).toHaveLength(1);
    expect(sent[0].message.text).toContain('Dear Layla Hassan,\n\nwe received your request for Tenancy contract typing.');
    expect(sent[0].message.text).toMatch(/Follow your request: https?:\/\/\S+\/requests\/[0-9a-f-]{36}/);
    expect(sent[0].message.text).toContain('Alpha Typing');
    expect(LogProvider.outbox.some((m) => m.message.to === customer.phone && String(m.message.text).includes('we received your request'))).toBe(false);
  });

  it('send_notification: to the assigned operator and to the holders of a role', async () => {
    const assigned = await createRule(t, manager, {
      triggerEvent: 'request.assigned',
      conditions: { all: [{ fact: 'assignment.role', op: 'eq', value: 'OPERATOR' }, { fact: 'assignment.method', op: 'eq', value: 'MANUAL' }] },
      actions: [{ type: 'send_notification', config: { to: 'ASSIGNEE', channels: ['IN_APP'], subject: 'Yours now: {{requestNumber}}', body: '{{assigneeName}}, please start with {{requestNumber}} ({{serviceName}}).\n\n[Open]({{centreLink}})' } }],
    });
    const paid = await createRule(t, manager, {
      triggerEvent: 'payment.completed',
      conditions: { all: [{ fact: 'payment.amount', op: 'gt', value: 100 }, { fact: 'payment.method', op: 'eq', value: 'CASH' }] },
      actions: [{ type: 'send_notification', config: { to: 'ROLE', roleKey: 'accountant', channels: ['IN_APP'], subject: 'Payment received: {{amount}} {{currency}}', body: '{{paymentMethod}} payment for {{requestNumber}} from {{customerName}}.' } }],
    });
    const service = await createService(t, alpha);
    const customer = await createCustomer(t, alpha, { fullName: 'Hamad Saeed' });
    const ready = await readyRequest(t, alpha, receptionist, service.id, customer.id); // quotation 500.00, paid in cash
    await t.as(manager).post(`/requests/${ready.id}/assign`, { assigneeMembershipId: operator.membershipId, role: 'OPERATOR' }).expect(200);
    await t.settle();

    const operatorUser = await t.sys.user.findUniqueOrThrow({ where: { id: operator.userId } });
    expect(await inbox(operator)).toEqual(expect.arrayContaining([expect.objectContaining({ subject: `Yours now: ${ready.requestNo}`, body: expect.stringContaining(`${operatorUser.fullName}, please start with ${ready.requestNo}`) })]));
    expect(results(await onlyExecution(t, assigned.id))[0].output).toMatchObject({ to: 'ASSIGNEE', recipients: 1, delivered: 1, suppressed: 0 });
    expect(await inbox(accountant)).toEqual(expect.arrayContaining([expect.objectContaining({ subject: 'Payment received: 500.00 AED', body: `CASH payment for ${ready.requestNo} from Hamad Saeed.` })]));
    expect(results(await onlyExecution(t, paid.id))[0].output).toMatchObject({ to: 'ROLE', recipients: 1, delivered: 1 });
    // Nobody else got the accountant's message.
    expect((await inbox(operator)).some((n) => n.subject.startsWith('Payment received'))).toBe(false);
  });

  // ------------------------------------------------------------------ schedule_reminder
  it('schedule_reminder: schedules an expiry reminder through the reminders module', async () => {
    await t.sys.documentType.create({ data: { tenantId: alpha.id, key: 'insurance_policy', name: 'Insurance policy', hasExpiry: true, reminderEnabled: false } });
    const rule = await createRule(t, manager, { triggerEvent: 'document.verified', conditions: { all: [{ fact: 'document.typeKey', op: 'in', value: ['insurance_policy', 'photo'] }] }, actions: [{ type: 'schedule_reminder', config: { offsetsDays: [30, 7] } }] });
    const customer = await createCustomer(t, alpha, { fullName: 'Noura Al Ali' });
    const expiry = new Date(Date.UTC(new Date().getUTCFullYear() + 1, 5, 15));
    const policy = await createDocument(t, alpha, { customerId: customer.id, documentTypeKey: 'insurance_policy', expiryDate: expiry });
    await verifyDocument(t, alpha, policy.id);
    await t.settle();

    const schedules = await t.sys.reminderSchedule.findMany({ where: { tenantId: alpha.id, customerId: customer.id } });
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({ documentTypeKey: 'insurance_policy', documentId: policy.id, subjectLabel: 'Noura Al Ali', status: 'ACTIVE', offsetsDays: [30, 7], createdById: null });
    expect(schedules[0].expiryDate.toISOString().slice(0, 10)).toBe(expiry.toISOString().slice(0, 10));
    const [first] = await executionsOf(t, rule.id);
    expect(results(first)[0]).toMatchObject({ status: 'SUCCEEDED', output: { reminderId: schedules[0].id, documentTypeKey: 'insurance_policy', expiryDate: expiry.toISOString().slice(0, 10) } });
    expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'reminder.created', resourceId: schedules[0].id, actorType: 'AUTOMATION' } })).toBe(1);

    // Verified again (a new event): the existing reminder is what was asked for - no duplicate, no failure.
    await verifyDocument(t, alpha, policy.id);
    // A document without an expiry date: nothing to remind about.
    const photo = await createDocument(t, alpha, { customerId: customer.id, documentTypeKey: 'photo' });
    await verifyDocument(t, alpha, photo.id);
    await t.settle();
    const all = await executionsOf(t, rule.id);
    expect(all.map((e) => e.status)).toEqual(['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED']);
    expect(all.map((e) => results(e)[0])).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'SUCCEEDED', output: expect.objectContaining({ reminderId: schedules[0].id, alreadyScheduled: true }) }),
      expect.objectContaining({ status: 'SKIPPED', output: { reason: 'No expiry date is known for the document, so there is nothing to remind about.' } }),
    ]));
    expect(await t.sys.reminderSchedule.count({ where: { tenantId: alpha.id, customerId: customer.id } })).toBe(1);
  });

  it('schedule_reminder: with a fixed term when the event has no document', async () => {
    const rule = await createRule(t, manager, { triggerEvent: 'customer.created', actions: [{ type: 'schedule_reminder', config: { documentTypeKey: 'emirates_id', expiryInDays: 365, subjectLabel: 'Emirates ID check' } }] });
    const created = await t.as(receptionist).post('/customers', { fullName: `Reminder Customer ${uniq()}` }).expect(201);
    await t.settle();
    const schedule = await t.sys.reminderSchedule.findFirstOrThrow({ where: { tenantId: alpha.id, customerId: created.body.id } });
    expect(schedule).toMatchObject({ documentTypeKey: 'emirates_id', subjectLabel: 'Emirates ID check', status: 'ACTIVE', documentId: null });
    const days = Math.round((schedule.expiryDate.getTime() - Date.now()) / 86_400_000);
    expect(days).toBeGreaterThanOrEqual(364);
    expect(days).toBeLessThanOrEqual(366);
    expect((await onlyExecution(t, rule.id)).status).toBe('SUCCEEDED');
  });

  // ------------------------------------------------------------------ generate_document
  it('generate_document: stores an internal summary PDF with the request, and the upload it causes starts no rule', async () => {
    const service = await createService(t, alpha);
    const rule = await createRule(t, manager, { triggerEvent: 'request.submitted', conditions: { all: [{ fact: 'service.code', op: 'eq', value: service.code }] }, actions: [{ type: 'generate_document', config: { title: 'Cover sheet {{requestNumber}}' } }] });
    const onUpload = await createRule(t, manager, { triggerEvent: 'document.uploaded', conditions: { all: [{ fact: 'document.generated', op: 'eq', value: true }] }, actions: [{ type: 'create_task', config: { title: 'File the generated document' } }] });
    const customer = await createCustomer(t, alpha);
    const request = await submittedRequest(t, alpha, receptionist, service.id, customer.id);
    await t.settle();

    const execution = await onlyExecution(t, rule.id);
    expect(execution.status).toBe('SUCCEEDED');
    const output = results(execution)[0].output!;
    const document = await t.sys.document.findUniqueOrThrow({ where: { id: output.documentId }, include: { documentVersions: true } });
    expect(document).toMatchObject({ tenantId: alpha.id, requestId: request.id, customerId: customer.id, documentTypeKey: 'other', title: `Cover sheet ${request.requestNo}`, status: 'AVAILABLE', customerVisible: false, isCompletionDocument: false, uploadedByType: 'AUTOMATION', uploadedById: null });
    expect(document.documentVersions).toHaveLength(1);
    expect(document.documentVersions[0]).toMatchObject({ id: output.versionId, originalFilename: `${request.requestNo}-summary.pdf` });
    expect(Number(document.documentVersions[0].sizeBytes)).toBeGreaterThan(800);
    // Staff reach it through the documents module like any other document of the request.
    expect((await t.as(manager).get(`/documents/${document.id}`).expect(200)).body).toMatchObject({ id: document.id, title: `Cover sheet ${request.requestNo}` });
    expect(await executionsOf(t, onUpload.id)).toEqual([]);
  });

  // ------------------------------------------------------------------ update_workflow_state
  it('update_workflow_state: performs an automatic step through the state machine as the automation actor', async () => {
    const service = await createService(t, alpha);
    const only = { fact: 'service.code', op: 'eq', value: service.code };
    const rule = await createRule(t, manager, {
      name: 'Start review at once',
      triggerEvent: 'request.submitted',
      conditions: { all: [only, { fact: 'request.status', op: 'eq', value: 'SUBMITTED' }] },
      actions: [{ type: 'update_workflow_state', config: { to: 'UNDER_REVIEW', customerMessage: 'We started checking your documents.' } }],
    });
    // Would run in circles if the status changes made by automations started rules again.
    const onReview = await createRule(t, manager, { name: 'On review', triggerEvent: 'request.status_changed', conditions: { all: [only, { fact: 'status.to', op: 'eq', value: 'UNDER_REVIEW' }] }, actions: [{ type: 'create_task', config: { title: 'Loop!' } }] });
    const request = await submittedRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
    expect(await statusOf(t, request.id)).toBe('SUBMITTED');
    await t.settle();

    expect(await statusOf(t, request.id)).toBe('UNDER_REVIEW');
    const execution = await onlyExecution(t, rule.id);
    expect(execution.status).toBe('SUCCEEDED');
    expect(results(execution)[0]).toMatchObject({ status: 'SUCCEEDED', output: { from: 'SUBMITTED', to: 'UNDER_REVIEW' } });
    const change = (await historyOf(t, request.id)).find((h) => h.fromStatus === 'SUBMITTED' && h.toStatus === 'UNDER_REVIEW')!;
    expect(change).toMatchObject({ actorType: 'AUTOMATION', actorId: null, reason: 'Automation "Start review at once"', customerMessage: 'We started checking your documents.' });
    expect(change.meta).toMatchObject({ via: 'SYSTEM', automationRuleId: rule.id, automationExecutionId: execution.id });
    const audit = await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: alpha.id, action: 'request.status_changed', resourceId: request.id, actorType: 'AUTOMATION' } });
    expect(audit.actorLabel).toBe('automation:Start review at once');

    // The change produced a real request.status_changed event, marked as caused by an automation: no rule saw it.
    const events = await t.sys.outboxEvent.findMany({ where: { tenantId: alpha.id, type: 'request.status_changed' } });
    const mine = events.find((e) => (e.payload as any).requestId === request.id && (e.payload as any).to === 'UNDER_REVIEW')!;
    expect((mine.payload as any)._actor).toEqual({ userId: null, type: 'AUTOMATION' });
    expect(await executionsOf(t, onReview.id)).toEqual([]);
    expect(await t.sys.task.count({ where: { tenantId: alpha.id, title: 'Loop!' } })).toBe(0);
    // The same change made by a person does start it.
    const second = await submittedRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
    await t.as(manager).post(`/automations/${rule.id}/disable`).expect(200);
    await t.as(reviewer).post(`/requests/${second.id}/transition`, { to: 'UNDER_REVIEW' }).expect(200);
    await t.settle();
    expect((await onlyExecution(t, onReview.id)).status).toBe('SUCCEEDED');

    // Running the finished execution again changes nothing.
    expect(await t.get(AutomationEngine).execute(alpha.id, execution.id)).toBe('IGNORED');
    expect((await historyOf(t, request.id)).filter((h) => h.actorType === 'AUTOMATION')).toHaveLength(1);
  });

  it('compliance: an automation cannot use an edge that is not automatic, skip a guard, or invent a transition', async () => {
    const service = await createService(t, alpha);
    const only = { fact: 'service.code', op: 'eq', value: service.code };
    // 1. READY_FOR_PROCESSING -> IN_PREPARATION exists, but only an operator may start preparation.
    const start = await createRule(t, manager, { name: 'Start preparation without an operator', triggerEvent: 'payment.completed', conditions: { all: [only] }, actions: [{ type: 'update_workflow_state', config: { to: 'IN_PREPARATION' } }, { type: 'create_task', config: { title: 'Never created' } }] });
    // 2. UNDER_REVIEW -> READY_FOR_PROCESSING is automatic, but guarded: documents must be verified and the payment policy met.
    const skip = await createRule(t, manager, { name: 'Skip document review', triggerEvent: 'document.uploaded', conditions: { all: [only, { fact: 'request.status', op: 'eq', value: 'UNDER_REVIEW' }] }, maxRetries: 5, actions: [{ type: 'update_workflow_state', config: { to: 'READY_FOR_PROCESSING' } }] });
    // 3. There is no way from a new request to "awaiting payment" at all.
    const jump = await createRule(t, manager, { name: 'Jump to payment', triggerEvent: 'request.submitted', conditions: { all: [only] }, actions: [{ type: 'update_workflow_state', config: { to: 'AWAITING_PAYMENT' } }] });

    const customer = await createCustomer(t, alpha);
    const request = await submittedRequest(t, alpha, receptionist, service.id, customer.id);
    await t.settle();
    const jumped = await onlyExecution(t, jump.id);
    expect(jumped.status).toBe('DEAD_LETTER');
    expect(results(jumped)[0].error).toMatchObject({ code: 'INVALID_TRANSITION', retryable: false, message: 'A request cannot go from New to Awaiting payment.' });
    expect(await statusOf(t, request.id)).toBe('SUBMITTED');

    await t.as(reviewer).post(`/requests/${request.id}/transition`, { to: 'UNDER_REVIEW' }).expect(200);
    const [firstLine] = (await checklistOf(t, request.id)).filter((l) => l.kind === 'INPUT');
    await uploadFor(t, alpha, request.id, firstLine);
    await t.settle();
    expect(await statusOf(t, request.id)).toBe('UNDER_REVIEW');
    const skipped = await onlyExecution(t, skip.id);
    // Refused by the guard, not retried (trying again cannot make the documents verified), and nothing changed.
    expect(skipped).toMatchObject({ status: 'DEAD_LETTER', attempts: 1 });
    expect(results(skipped)[0]).toMatchObject({ status: 'FAILED', attempts: 1, error: { code: 'DOCUMENTS_NOT_VERIFIED', retryable: false } });
    expect(skipped.error).toMatch(/^Step 1 \(Update internal workflow state\): /);
    await t.as(manager).post(`/automations/${skip.id}/disable`).expect(200);

    // The normal way still works, and when the payment arrives rule 1 tries its shortcut.
    await completeDocuments(t, alpha, request.id);
    const { invoice } = await approveQuotation(t, alpha, (await sendQuotation(t, alpha, request.id, 300)).id);
    await payInvoice(t, alpha, invoice!.id);
    await t.settle();
    expect(await statusOf(t, request.id)).toBe('READY_FOR_PROCESSING');
    const started = await onlyExecution(t, start.id);
    expect(started.status).toBe('DEAD_LETTER');
    expect(results(started)).toEqual([
      expect.objectContaining({ status: 'FAILED', error: { code: 'TRANSITION_NOT_ALLOWED', message: 'This step happens automatically and cannot be triggered by hand.', retryable: false } }),
      expect.objectContaining({ status: 'PENDING', attempts: 0 }), // actions after a failed one do not run
    ]);
    expect(await t.sys.task.count({ where: { tenantId: alpha.id, title: 'Never created' } })).toBe(0);

    // Not one status change of this request was made by an automation.
    expect((await historyOf(t, request.id)).filter((h) => h.actorType === 'AUTOMATION')).toEqual([]);
    expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'request.status_changed', resourceId: request.id, actorType: 'AUTOMATION' } })).toBe(0);

    // Each failure is on the dead-letter list, audited, and the owner was alerted in the application.
    const audits = await t.sys.auditLog.findMany({ where: { tenantId: alpha.id, action: 'automation.dead_letter', resourceId: { in: [skipped.id, jumped.id, started.id] } } });
    expect(audits).toHaveLength(3);
    expect(audits.find((a) => a.resourceId === started.id)).toMatchObject({ actorType: 'AUTOMATION', resourceType: 'AutomationExecution' });
    expect((audits.find((a) => a.resourceId === started.id)!.after as any)).toMatchObject({ ruleId: start.id, step: 1, action: 'update_workflow_state', code: 'TRANSITION_NOT_ALLOWED' });
    const alerts = (await inbox(alpha.owner)).filter((n) => n.subject.startsWith('Automation failed: '));
    expect(alerts.map((a) => a.subject).sort()).toEqual(['Automation failed: Jump to payment', 'Automation failed: Skip document review', 'Automation failed: Start preparation without an operator']);
    expect(alerts.find((a) => a.subject.endsWith('Skip document review'))!.body).toMatch(/could not finish after 1 attempt\(s\)\.\nStep 1 \(Update internal workflow state\): /);
    // Managers are not owners: the alert goes to the owners only.
    expect((await inbox(manager)).some((n) => n.subject.startsWith('Automation failed: '))).toBe(false);
  });

  // ------------------------------------------------------------------ request_approval
  describe('request_approval', () => {
    const step = (key: string, type: string, extra: object = {}) => ({ key, name: key, type, ...extra });
    async function workflow(steps: object[]) {
      const res = await t.as(alpha.owner).post('/workflows', { key: `wf-${uniq()}`, name: 'Custom workflow', steps, publish: true });
      if (res.status !== 201) throw new Error(`workflow not created: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body as { id: string };
    }
    /** A request in preparation with the given workflow; returns after the trigger (staff upload the prepared application). */
    async function preparedAndUploaded(workflowId: string) {
      const service = await createService(t, alpha, { workflowDefinitionId: workflowId, requiresApproval: false, complianceCapability: 'DOCUMENT_PREPARATION_ONLY', paymentPolicy: 'AFTER_COMPLETION', requirements: [] });
      const request = await submittedRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
      await t.as(manager).post(`/requests/${request.id}/assign`, { assigneeMembershipId: operator.membershipId, role: 'OPERATOR' }).expect(200);
      await t.as(operator).post(`/requests/${request.id}/transition`, { to: 'IN_PREPARATION' }).expect(200);
      await t.settle();
      const document = await createDocument(t, alpha, { customerId: request.customerId, requestId: request.id, documentTypeKey: 'other' });
      await emit(t, alpha.id, 'document.uploaded', { documentId: document.id, versionId: document.id, customerId: request.customerId, requestId: request.id, documentTypeKey: 'other', uploadedByType: 'STAFF' });
      await t.settle();
      return request as { id: string; requestNo: string };
    }
    const rule = () =>
      createRule(t, manager, {
        name: 'Send for review after upload',
        triggerEvent: 'document.uploaded',
        conditions: { all: [{ fact: 'request.status', op: 'eq', value: 'IN_PREPARATION' }, { fact: 'document.uploadedByType', op: 'eq', value: 'STAFF' }] },
        actions: [{ type: 'request_approval', config: { note: 'Prepared application uploaded' } }],
      });

    it('sends a request in preparation for review through the workflow of the requests module', async () => {
      const created = await rule();
      const request = await preparedAndUploaded((await workflow([step('task', 'STAFF_TASK'), step('check', 'INTERNAL_APPROVAL', { onRejectStepKey: 'task' }), step('done', 'COMPLETION')])).id);
      expect(await statusOf(t, request.id)).toBe('PENDING_APPROVAL');
      const approval = await t.sys.requestApproval.findFirstOrThrow({ where: { requestId: request.id } });
      expect(approval).toMatchObject({ type: 'REVIEW', status: 'PENDING', stepKey: 'check', requestedById: null });
      const execution = await onlyExecution(t, created.id);
      expect(execution.status).toBe('SUCCEEDED');
      expect(results(execution)[0]).toMatchObject({ status: 'SUCCEEDED', output: { approvalId: approval.id } });
      // The review itself stays with a person: the reviewer decides as usual.
      await t.as(reviewer).post(`/requests/${request.id}/approvals/${approval.id}/decide`, { decision: 'APPROVED' }).expect(200);
      expect(await statusOf(t, request.id)).toBe('FINAL_REVIEW');
    });

    it('never pushes a case past preparation when its workflow has no review: everything is undone', async () => {
      const created = await rule();
      const request = await preparedAndUploaded((await workflow([step('task', 'STAFF_TASK'), step('done', 'COMPLETION')])).id);
      expect(await statusOf(t, request.id)).toBe('IN_PREPARATION');
      expect(await t.sys.requestApproval.count({ where: { requestId: request.id } })).toBe(0);
      const execution = await onlyExecution(t, created.id);
      expect(execution.status).toBe('DEAD_LETTER');
      expect(results(execution)[0]).toMatchObject({ status: 'FAILED', error: { code: 'REVIEW_NOT_REQUESTED', retryable: false } });
      // The preparation step was not completed on the operator's behalf either.
      const wf = await t.sys.workflowExecution.findUniqueOrThrow({ where: { requestId: request.id }, include: { workflowStepExecutions: true } });
      expect(wf.currentStepKey).toBe('task');
      expect(wf.workflowStepExecutions.find((s) => s.stepKey === 'task')).toMatchObject({ status: 'ACTIVE' });
      expect((await historyOf(t, request.id)).filter((h) => h.actorType === 'AUTOMATION')).toEqual([]);
      // The operator finishes the case the normal way.
      await t.as(operator).post(`/requests/${request.id}/workflow/complete-step`, {}).expect(200);
      expect(await statusOf(t, request.id)).toBe('FINAL_REVIEW');
    });
  });

  // ------------------------------------------------------------------ escalate
  it('escalate: an escalation task for a role and an in-app alert to its holders at the branch', async () => {
    const other = await addBranch(t, alpha);
    const elsewhere = await t.addStaff(alpha, 'manager', { branchIds: [other.id] });
    const service = await createService(t, alpha, { name: 'Trade licence renewal' });
    const rule = await createRule(t, manager, {
      name: 'Overdue to managers',
      triggerEvent: 'request.overdue',
      conditions: { all: [{ fact: 'service.code', op: 'eq', value: service.code }] },
      actions: [{ type: 'escalate', config: { roleKey: 'manager', title: 'Overdue: {{requestNumber}}', message: '{{requestNumber}} ({{serviceName}}) is past its target date {{targetDate}}.', priority: 'URGENT', dueInHours: 2 } }],
    });
    const request = await submittedRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
    await t.settle();
    await overdue(request.id);

    const execution = await onlyExecution(t, rule.id);
    expect(execution.status).toBe('SUCCEEDED');
    const task = await t.sys.task.findFirstOrThrow({ where: { requestId: request.id, type: 'ESCALATION', source: 'ESCALATION', stepKey: null } });
    const target = (await t.sys.serviceRequest.findUniqueOrThrow({ where: { id: request.id } })).targetDate!.toISOString().slice(0, 10);
    expect(task).toMatchObject({ title: `Overdue: ${request.requestNo}`, description: `${request.requestNo} (Trade licence renewal) is past its target date ${target}.`, priority: 'URGENT', roleKey: 'manager', status: 'OPEN', branchId: alpha.headOfficeId });
    expect(near(task.dueAt, Date.now() + 2 * 3_600_000)).toBe(true);
    expect(results(execution)[0]).toMatchObject({ status: 'SUCCEEDED', output: { taskId: task.id, roleKey: 'manager', notified: 1 } });
    expect(await inbox(manager)).toEqual(expect.arrayContaining([expect.objectContaining({ subject: `Overdue: ${request.requestNo}`, body: expect.stringContaining('is past its target date') })]));
    // A manager who does not work at the branch of the request is not told about it.
    expect((await inbox(elsewhere)).some((n) => n.subject === `Overdue: ${request.requestNo}`)).toBe(false);

    // The scan flags a request once; a second scan produces no second escalation.
    await t.jobs.runScheduled(SCAN_JOB);
    await t.settle();
    expect(await executionsOf(t, rule.id)).toHaveLength(1);
  });

  // ------------------------------------------------------------------ idempotency
  it('handles an event exactly once, however often it is delivered or its job runs', async () => {
    const rule = await createRule(t, manager, {
      triggerEvent: 'customer.created',
      actions: [{ type: 'create_task', config: { title: 'Welcome {{customerName}}' } }, { type: 'send_notification', config: { to: 'ROLE', roleKey: 'receptionist', channels: ['IN_APP'], subject: 'New customer', body: '{{customerName}} was registered.' } }],
    });
    const name = `Idempotent ${uniq()}`;
    const created = await t.as(manager).post('/customers', { fullName: name }).expect(201);
    await t.settle();
    const execution = await onlyExecution(t, rule.id);
    expect(execution.status).toBe('SUCCEEDED');
    const count = async () => [
      (await executionsOf(t, rule.id)).length,
      await t.sys.task.count({ where: { tenantId: alpha.id, customerId: created.body.id } }),
      await t.sys.notification.count({ where: { tenantId: alpha.id, dedupeKey: { startsWith: `automation:${execution.id}:` } } }),
    ];
    expect(await count()).toEqual([1, 1, 1]);

    // 1. The outbox delivers the event again (at-least-once delivery).
    const event = await t.sys.outboxEvent.findUniqueOrThrow({ where: { id: execution.eventId } });
    await t.sys.outboxEvent.update({ where: { id: event.id }, data: { status: 'PENDING', availableAt: new Date() } });
    await t.settle();
    expect((await t.sys.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe('PROCESSED');
    expect(await count()).toEqual([1, 1, 1]);
    // 2. The subscriber is called directly with the same event.
    const engine = t.get(AutomationEngine);
    const again = await t.inTenant(alpha.id, () => engine.onEvent({ id: event.id, tenantId: alpha.id, type: 'customer.created', payload: event.payload as any, createdAt: event.createdAt }));
    expect(again).toEqual({ matched: 1, created: 0 });
    // 3. The job runs a second and a third time.
    expect(await engine.execute(alpha.id, execution.id)).toBe('IGNORED');
    await t.jobs.enqueue('automation.execute', { tenantId: alpha.id, executionId: execution.id });
    await t.settle();
    expect(await count()).toEqual([1, 1, 1]);
    expect((await onlyExecution(t, rule.id)).attempts).toBe(1);

    // An event of the same kind caused by an automation is ignored by the subscriber itself.
    const forged = await t.inTenant(alpha.id, () => engine.onEvent({ id: '5b1d7c2e-1111-4222-8333-444455556666', tenantId: alpha.id, type: 'customer.created', payload: { customerId: created.body.id, _actor: { userId: null, type: 'AUTOMATION' } }, createdAt: new Date() }));
    expect(forged).toEqual({ matched: 0, created: 0 });
  });

  // ------------------------------------------------------------------ execution log
  it('shows executions with per-action results, filters, and summary counters', async () => {
    const service = await createService(t, alpha);
    const only = { fact: 'service.code', op: 'eq', value: service.code };
    const good = await createRule(t, manager, { name: 'Log: good', triggerEvent: 'request.submitted', conditions: { all: [only] }, actions: [{ type: 'create_task', config: { title: 'Logged {{requestNumber}}' } }, { type: 'assign_staff', config: { mode: 'MEMBER', membershipId: operator.membershipId } }] });
    const bad = await createRule(t, manager, { name: 'Log: bad', triggerEvent: 'request.submitted', conditions: { all: [only] }, actions: [{ type: 'create_task', config: { title: 'Before the failure' } }, { type: 'update_workflow_state', config: { to: 'AWAITING_PAYMENT' } }] });
    const request = await submittedRequest(t, alpha, receptionist, service.id, (await createCustomer(t, alpha)).id);
    await t.settle();

    const list = (await t.as(manager).get(`/automations/executions?ruleId=${good.id}`).expect(200)).body;
    expect(list.meta.total).toBe(1);
    expect(list.data[0]).toMatchObject({ ruleId: good.id, ruleName: 'Log: good', eventType: 'request.submitted', eventLabel: 'A request was submitted for processing', status: 'SUCCEEDED', attempts: 1, error: null });
    expect(list.data[0].actions).toEqual([
      { index: 0, type: 'create_task', label: 'Create task', status: 'SUCCEEDED', attempts: 1, finishedAt: expect.any(String) },
      { index: 1, type: 'assign_staff', label: 'Assign staff', status: 'SUCCEEDED', attempts: 1, finishedAt: expect.any(String) },
    ]);
    const dead = (await t.as(manager).get(`/automations/executions?status=DEAD_LETTER&ruleId=${bad.id}`).expect(200)).body;
    expect(dead.data.map((e: any) => [e.ruleName, e.status])).toEqual([['Log: bad', 'DEAD_LETTER']]);
    expect((await t.as(manager).get(`/automations/executions?status=SUCCEEDED&ruleId=${bad.id}`).expect(200)).body.data).toEqual([]);
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect((await t.as(manager).get(`/automations/executions?ruleId=${good.id}&from=${today}&to=${today}`).expect(200)).body.meta.total).toBe(1);
    expect((await t.as(manager).get(`/automations/executions?ruleId=${good.id}&from=${tomorrow}`).expect(200)).body.meta.total).toBe(0);
    expect((await t.as(manager).get(`/automations/executions?ruleId=${good.id}&eventType=customer.created`).expect(200)).body.meta.total).toBe(0);
    await t.as(manager).get(`/automations/executions?from=${tomorrow}&to=${today}`).expect(400);
    await t.as(manager).get('/automations/executions?status=EXPLODED').expect(400);

    // One execution in detail: what each action was asked to do, what it did, and why one failed.
    const detail = (await t.as(manager).get(`/automations/executions/${dead.data[0].id}`).expect(200)).body;
    expect(detail).toMatchObject({ status: 'DEAD_LETTER', maxRetries: 3, canRetry: true, event: { data: { requestId: request.id } } });
    expect(detail.actions[0]).toMatchObject({ type: 'create_task', status: 'SUCCEEDED', config: { title: 'Before the failure' }, output: { taskId: expect.any(String) }, error: null });
    expect(detail.actions[1]).toMatchObject({ type: 'update_workflow_state', status: 'FAILED', config: { to: 'AWAITING_PAYMENT' }, output: null, error: { code: 'INVALID_TRANSITION', retryable: false } });
    // An action that finished before the failure stays done: its task exists once.
    expect(await t.sys.task.count({ where: { requestId: request.id, title: 'Before the failure' } })).toBe(1);

    const summary = (await t.as(manager).get('/automations/summary').expect(200)).body;
    const db = await t.sys.automationExecution.groupBy({ by: ['status'], where: { tenantId: alpha.id }, _count: { _all: true } });
    const of = (status: string) => db.find((g) => g.status === status)?._count._all ?? 0;
    expect(summary).toMatchObject({ available: true, rules: { total: await t.sys.automationRule.count({ where: { tenantId: alpha.id } }), enabled: 2 } });
    expect(summary.executions.allTime).toMatchObject({ succeeded: of('SUCCEEDED'), deadLetter: of('DEAD_LETTER'), total: db.reduce((a, g) => a + g._count._all, 0) });
    expect(summary.executions.last24h.total).toBe(summary.executions.allTime.total);
    expect(summary.deadLetters.open).toBe(of('DEAD_LETTER'));
    expect(summary.deadLetters.recent[0]).toMatchObject({ ruleName: 'Log: bad', status: 'DEAD_LETTER' });
    // The rule list carries the same counters per rule.
    const rules = (await t.as(manager).get('/automations?q=Log:').expect(200)).body.data;
    expect(rules.find((r: any) => r.id === good.id).stats).toMatchObject({ total: 1, succeeded: 1, deadLetter: 0 });
    expect(rules.find((r: any) => r.id === bad.id).stats).toMatchObject({ total: 1, succeeded: 0, deadLetter: 1 });
  });
});
