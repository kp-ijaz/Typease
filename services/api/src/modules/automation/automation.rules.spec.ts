import { Actor, TenantFixture, TestApp, uniq } from '../../../test/helpers';
import { addStaffWithPermissions } from '../reports/fixtures';
import { createCustomer, createService, submittedRequest } from '../requests/fixtures';
import { allowHost, connectN8n, createRule, executionsOf } from './fixtures';

const TASK_ACTION = { type: 'create_task', config: { title: 'Check {{requestNumber}}' } };

describe('Automation rules (management API)', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let starter: TenantFixture;
  let manager: Actor;
  let operator: Actor;
  const problemsOf = (body: any): Array<{ path: string; code: string; message: string }> => body.details?.problems ?? [];
  const codes = (body: any) => problemsOf(body).map((p) => p.code);

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    starter = await t.createTenant({ plan: 'starter' });
    manager = await t.addStaff(alpha, 'manager');
    operator = await t.addStaff(alpha, 'operator');
    await t.settle();
  });
  afterAll(() => t.close());

  // ------------------------------------------------------------------ access
  describe('access', () => {
    it('requires automation.manage on every route', async () => {
      const id = '5b1d7c2e-1111-4222-8333-444455556666';
      const routes: Array<['get' | 'post' | 'patch' | 'delete', string]> = [
        ['get', '/automations'], ['get', '/automations/meta'], ['get', '/automations/templates'], ['post', '/automations/from-template/auto-assign-on-submission'], ['get', '/automations/summary'],
        ['get', '/automations/executions'], ['get', `/automations/executions/${id}`], ['post', `/automations/executions/${id}/retry`], ['post', '/automations'], ['get', `/automations/${id}`],
        ['patch', `/automations/${id}`], ['delete', `/automations/${id}`], ['post', `/automations/${id}/enable`], ['post', `/automations/${id}/disable`], ['post', `/automations/${id}/test`],
      ];
      const customer = await t.addCustomer(alpha);
      for (const [method, path] of routes) {
        expect([path, (await t.as(null)[method](path)).status]).toEqual([path, 401]);
        expect([path, (await t.as(operator)[method](path)).status]).toEqual([path, 403]);
        expect([path, (await t.as(customer)[method](path)).status]).toEqual([path, 403]);
      }
      // Owners and managers hold the permission by default; a custom role can be given it on its own.
      await t.as(manager).get('/automations').expect(200);
      const custom = await addStaffWithPermissions(t, alpha, ['automation.manage']);
      await t.as(custom).get('/automations/summary').expect(200);
    });

    it('needs the plan feature to create, copy a template or switch on - not to look, switch off or delete', async () => {
      const refused = await t.as(starter.owner).post('/automations', { name: 'Rule', triggerEvent: 'request.submitted', actions: [TASK_ACTION] }).expect(402);
      expect(refused.body).toMatchObject({ code: 'PLAN_LIMIT_REACHED', details: { limit: 'automation' } });
      await t.as(starter.owner).post('/automations/from-template/auto-assign-on-submission').expect(402);
      expect((await t.as(starter.owner).get('/automations/templates').expect(200)).body.available).toBe(false);
      expect((await t.as(starter.owner).get('/automations/meta').expect(200)).body.available).toBe(false);
      expect((await t.as(starter.owner).get('/automations/summary').expect(200)).body).toMatchObject({ available: false, rules: { total: 0 } });

      // A rule left over from a better plan: visible, can be switched off and deleted, cannot be switched on.
      const old = await t.sys.automationRule.create({ data: { tenantId: starter.id, name: 'From the old plan', triggerEvent: 'request.submitted', actions: [{ type: 'create_task', config: { title: 'x', priority: 'NORMAL', type: 'GENERAL' } }], isEnabled: true } });
      expect((await t.as(starter.owner).get('/automations').expect(200)).body.data.map((r: any) => r.id)).toEqual([old.id]);
      expect((await t.as(starter.owner).post(`/automations/${old.id}/disable`).expect(200)).body.isEnabled).toBe(false);
      expect((await t.as(starter.owner).post(`/automations/${old.id}/enable`).expect(402)).body.code).toBe('PLAN_LIMIT_REACHED');
      await t.as(starter.owner).delete(`/automations/${old.id}`).expect(200);
      expect(await t.sys.automationRule.count({ where: { tenantId: starter.id } })).toBe(0);
    });
  });

  // ------------------------------------------------------------------ CRUD
  describe('rules', () => {
    it('creates a rule switched off by default, lists, reads, changes and deletes it, with an audit trail', async () => {
      const created = await t
        .as(manager)
        .post('/automations', {
          name: '  Urgent requests to the manager ',
          description: 'Tell managers about urgent requests',
          triggerEvent: 'request.submitted',
          conditions: { all: [{ fact: 'request.priority', op: 'in', value: ['HIGH', 'URGENT'] }] },
          actions: [{ type: 'send_notification', config: { to: 'ROLE', roleKey: 'Manager', channels: ['IN_APP'], subject: 'Urgent: {{requestNumber}}', body: '{{customerName}} needs {{serviceName}} urgently.' } }, TASK_ACTION],
        })
        .expect(201);
      expect(created.body).toMatchObject({
        name: 'Urgent requests to the manager', triggerEvent: 'request.submitted', triggerLabel: 'A request was submitted for processing', isEnabled: false, maxRetries: 3, templateKey: null, createdById: manager.userId, problems: [],
      });
      expect(created.body.actions).toEqual([
        { type: 'send_notification', label: 'Send notification', config: { to: 'ROLE', roleKey: 'manager', channels: ['IN_APP'], subject: 'Urgent: {{requestNumber}}', body: '{{customerName}} needs {{serviceName}} urgently.', purpose: 'SERVICE' } },
        { type: 'create_task', label: 'Create task', config: { title: 'Check {{requestNumber}}', priority: 'NORMAL', type: 'GENERAL' } },
      ]);
      const id = created.body.id as string;

      const read = await t.as(manager).get(`/automations/${id}`).expect(200);
      expect(read.body).toMatchObject({ id, stats: { total: 0, succeeded: 0, failed: 0, deadLetter: 0, lastExecutionAt: null }, problems: [] });

      const other = await createRule(t, alpha.owner, { name: 'Welcome call', triggerEvent: 'customer.created', actions: [{ type: 'create_task', config: { title: 'Call {{customerName}}' } }] });
      const all = await t.as(manager).get('/automations').expect(200);
      expect(all.body.meta.total).toBeGreaterThanOrEqual(2);
      expect(all.body.data[0].id).toBe(other.id); // newest first
      expect((await t.as(manager).get('/automations?q=URGENT').expect(200)).body.data.map((r: any) => r.id)).toEqual([id]);
      expect((await t.as(manager).get('/automations?triggerEvent=customer.created').expect(200)).body.data.map((r: any) => r.id)).toEqual([other.id]);
      expect((await t.as(manager).get('/automations?enabled=false').expect(200)).body.data.map((r: any) => r.id)).toContain(id);
      expect((await t.as(manager).get('/automations?enabled=true').expect(200)).body.data.map((r: any) => r.id)).not.toContain(id);
      await t.as(manager).get('/automations?triggerEvent=invoice.issued').expect(400);
      await t.as(manager).get('/automations?tenantId=' + beta.id).expect(400);

      const updated = await t.as(manager).patch(`/automations/${id}`, { name: 'Urgent requests', maxRetries: 5, conditions: { all: [{ fact: 'request.priority', op: 'eq', value: 'URGENT' }] } }).expect(200);
      expect(updated.body).toMatchObject({ name: 'Urgent requests', maxRetries: 5, conditions: { all: [{ fact: 'request.priority', op: 'eq', value: 'URGENT' }] }, isEnabled: false });
      expect(updated.body.actions).toHaveLength(2); // untouched
      await t.as(manager).patch(`/automations/${id}`, { isEnabled: true }).expect(400); // switching on has its own route

      await t.as(manager).delete(`/automations/${id}`).expect(200);
      await t.as(manager).get(`/automations/${id}`).expect(404);
      await t.as(manager).delete(`/automations/${id}`).expect(404);
      const audit = await t.sys.auditLog.findMany({ where: { tenantId: alpha.id, resourceType: 'AutomationRule', resourceId: id }, orderBy: { createdAt: 'asc' } });
      expect(audit.map((a) => a.action)).toEqual(['automation.created', 'automation.updated', 'automation.deleted']);
      expect(audit[0]).toMatchObject({ actorUserId: manager.userId, actorType: 'STAFF' });
      expect((audit[1].before as any).name).toBe('Urgent requests to the manager');
      expect((audit[1].after as any).maxRetries).toBe(5);
    });

    it('rejects malformed input before anything is stored', async () => {
      const before = await t.sys.automationRule.count({ where: { tenantId: alpha.id } });
      const bad = async (body: Record<string, unknown>) => (await t.as(manager).post('/automations', { name: 'Rule', triggerEvent: 'request.submitted', actions: [TASK_ACTION], ...body }).expect(400)).body;
      expect((await bad({ triggerEvent: 'invoice.issued' })).code).toBe('VALIDATION_FAILED');
      expect((await bad({ actions: [] })).details.map((d: any) => d.path)).toContain('actions');
      expect((await bad({ actions: [{ type: 'run_sql', config: {} }] })).details.map((d: any) => d.path)).toContain('actions.0.type');
      expect((await bad({ actions: [{ type: 'create_task', config: { title: 'x', assigneeId: 'someone' } }] })).code).toBe('VALIDATION_FAILED');
      expect((await bad({ actions: [{ type: 'call_webhook', config: { path: '/../admin' } }] })).code).toBe('VALIDATION_FAILED');
      expect((await bad({ maxRetries: 99 })).code).toBe('VALIDATION_FAILED');
      expect((await bad({ tenantId: beta.id })).code).toBe('VALIDATION_FAILED');
      expect((await bad({ conditions: { all: [{ fact: 'request.priority', op: 'matches', value: '.*' }] } })).code).toBe('VALIDATION_FAILED');
      expect(await t.sys.automationRule.count({ where: { tenantId: alpha.id } })).toBe(before);
    });

    it('only lets a rule use facts, variables and actions that exist for its trigger', async () => {
      const invalid = async (body: Record<string, unknown>) => {
        const res = await t.as(manager).post('/automations', { name: 'Rule', triggerEvent: 'request.submitted', actions: [TASK_ACTION], ...body }).expect(422);
        expect(res.body.code).toBe('INVALID_AUTOMATION');
        return res.body;
      };
      // "status.to" belongs to request.status_changed, not to request.submitted.
      const fact = await invalid({ conditions: { all: [{ fact: 'status.to', op: 'eq', value: 'COMPLETED' }] } });
      expect(problemsOf(fact)).toEqual([expect.objectContaining({ path: 'conditions', code: 'UNKNOWN_FACT' })]);
      expect(codes(await invalid({ conditions: { all: [{ fact: 'customer.emiratesId', op: 'exists' }] } }))).toEqual(['UNKNOWN_FACT']);
      expect(codes(await invalid({ conditions: { any: [{ fact: 'request.priority', op: 'in', value: 'URGENT' }] } }))).toEqual(['INVALID_RULE']);
      expect(codes(await invalid({ conditions: { all: [{ fact: 'request.priority', op: 'eq', value: 'SUPER' }] } }))).toEqual(['UNKNOWN_VALUE']);

      const variable = await invalid({ triggerEvent: 'customer.created', actions: [{ type: 'create_task', config: { title: 'Call about {{requestNumber}}', description: '{{customerName}} {{daysLeft}}' } }] });
      expect(problemsOf(variable)).toEqual([
        expect.objectContaining({ path: 'actions.0.config.title', code: 'UNKNOWN_VARIABLE', message: expect.stringContaining('{{requestNumber}}') }),
        expect.objectContaining({ path: 'actions.0.config.description', code: 'UNKNOWN_VARIABLE', message: expect.stringContaining('{{daysLeft}}') }),
      ]);

      // Actions that work on a request make no sense for an event that never has one.
      const applicable = await invalid({
        triggerEvent: 'customer.created',
        actions: [{ type: 'assign_staff', config: { mode: 'AUTO' } }, { type: 'update_workflow_state', config: { to: 'UNDER_REVIEW' } }, { type: 'request_approval' }, { type: 'generate_document' }, { type: 'send_notification', config: { to: 'ASSIGNEE', channels: ['IN_APP'], subject: 's', body: 'hello' } }],
      });
      expect(problemsOf(applicable).map((p) => [p.path, p.code])).toEqual([
        ['actions.0', 'ACTION_NOT_APPLICABLE'], ['actions.1', 'ACTION_NOT_APPLICABLE'], ['actions.2', 'ACTION_NOT_APPLICABLE'], ['actions.3', 'ACTION_NOT_APPLICABLE'], ['actions.4.config.to', 'ACTION_NOT_APPLICABLE'],
      ]);
      expect(codes(await invalid({ triggerEvent: 'subscription.renewal_due', actions: [{ type: 'send_notification', config: { to: 'CUSTOMER', channels: ['EMAIL'], subject: 's', body: 'hello' } }, { type: 'schedule_reminder', config: { documentTypeKey: 'passport', expiryInDays: 30 } }] }))).toEqual([
        'ACTION_NOT_APPLICABLE', 'ACTION_NOT_APPLICABLE',
      ]);
      // A reminder needs to know which document expires when.
      expect(codes(await invalid({ actions: [{ type: 'schedule_reminder', config: {} }] }))).toEqual(['DOCUMENT_TYPE_REQUIRED', 'EXPIRY_REQUIRED']);
      expect(codes(await invalid({ actions: [{ type: 'send_notification', config: { to: 'CUSTOMER', channels: ['WHATSAPP'], body: 'hello' } }] }))).toEqual(['WHATSAPP_TEMPLATE_REQUIRED']);
    });

    it('never lets a rule ask for a status change that needs a person', async () => {
      for (const to of ['COMPLETED', 'CANCELLED', 'PENDING_APPROVAL', 'READY_TO_SUBMIT', 'EXTERNAL_PROCESSING', 'FINAL_REVIEW', 'SUBMITTED', 'REJECTED']) {
        const res = await t.as(alpha.owner).post('/automations', { name: 'Shortcut', triggerEvent: 'request.submitted', actions: [{ type: 'update_workflow_state', config: { to } }] }).expect(422);
        expect(problemsOf(res.body)).toEqual([expect.objectContaining({ path: 'actions.0.config.to', code: 'STATUS_NOT_AUTOMATABLE' })]);
      }
      const ok = await t.as(alpha.owner).post('/automations', { name: 'Start review', triggerEvent: 'request.submitted', actions: [{ type: 'update_workflow_state', config: { to: 'UNDER_REVIEW' } }] }).expect(201);
      // ... and an edit cannot sneak it in afterwards.
      const edit = await t.as(alpha.owner).patch(`/automations/${ok.body.id}`, { actions: [{ type: 'update_workflow_state', config: { to: 'COMPLETED' } }] }).expect(422);
      expect(codes(edit.body)).toEqual(['STATUS_NOT_AUTOMATABLE']);
      expect(((await t.sys.automationRule.findUniqueOrThrow({ where: { id: ok.body.id } })).actions as any)[0].config.to).toBe('UNDER_REVIEW');
    });

    it('only accepts roles, staff, services, branches and document types of the own centre', async () => {
      const betaRole = `beta_only_${uniq().slice(-6)}`;
      await t.as(beta.owner).post('/roles', { key: betaRole, name: 'Beta only', permissions: ['task.read'] }).expect(201);
      const betaOperator = await t.addStaff(beta, 'operator');
      const betaService = await createService(t, beta);
      const alphaService = await createService(t, alpha);
      const receptionist = await t.addStaff(alpha, 'receptionist');
      const invalid = async (body: Record<string, unknown>) => problemsOf((await t.as(manager).post('/automations', { name: 'Rule', triggerEvent: 'request.submitted', actions: [TASK_ACTION], ...body }).expect(422)).body);

      expect(await invalid({ actions: [{ type: 'create_task', config: { title: 'Task', roleKey: betaRole } }] })).toEqual([expect.objectContaining({ path: 'actions.0.config.roleKey', code: 'UNKNOWN_ROLE' })]);
      expect(await invalid({ actions: [{ type: 'escalate', config: { roleKey: 'customer' } }] })).toEqual([expect.objectContaining({ code: 'UNKNOWN_ROLE' })]); // not a staff role
      expect(await invalid({ actions: [{ type: 'send_notification', config: { to: 'ROLE', roleKey: betaRole, channels: ['IN_APP'], subject: 's', body: 'hello' } }] })).toEqual([expect.objectContaining({ code: 'UNKNOWN_ROLE' })]);
      expect(await invalid({ actions: [{ type: 'assign_staff', config: { mode: 'MEMBER', membershipId: betaOperator.membershipId } }] })).toEqual([expect.objectContaining({ path: 'actions.0.config.membershipId', code: 'UNKNOWN_STAFF' })]);
      // A receptionist cannot prepare applications; an operator cannot review them.
      expect(await invalid({ actions: [{ type: 'assign_staff', config: { mode: 'MEMBER', membershipId: receptionist.membershipId } }] })).toEqual([expect.objectContaining({ code: 'STAFF_ROLE_NOT_SUITABLE' })]);
      expect(await invalid({ actions: [{ type: 'assign_staff', config: { mode: 'MEMBER', membershipId: operator.membershipId, role: 'REVIEWER' } }] })).toEqual([expect.objectContaining({ code: 'STAFF_ROLE_NOT_SUITABLE' })]);
      expect(await invalid({ conditions: { all: [{ fact: 'service.code', op: 'eq', value: betaService.code }] } })).toEqual([expect.objectContaining({ path: 'conditions.all.0', code: 'UNKNOWN_REFERENCE' })]);
      expect(await invalid({ conditions: { any: [{ fact: 'service.code', op: 'in', value: [alphaService.code, betaService.code] }] } })).toEqual([expect.objectContaining({ path: 'conditions.any.0', code: 'UNKNOWN_REFERENCE', message: expect.stringContaining(betaService.code) })]);
      expect(await invalid({ conditions: { all: [{ fact: 'branch.code', op: 'eq', value: 'NOPE' }] } })).toEqual([expect.objectContaining({ code: 'UNKNOWN_REFERENCE' })]);
      expect(await invalid({ conditions: { all: [{ fact: 'assignee.roleKey', op: 'eq', value: betaRole }] } })).toEqual([expect.objectContaining({ code: 'UNKNOWN_REFERENCE' })]);
      expect(await invalid({ actions: [{ type: 'generate_document', config: { documentTypeKey: 'made_up_type' } }] })).toEqual([expect.objectContaining({ code: 'UNKNOWN_DOCUMENT_TYPE' })]);
      expect(await invalid({ triggerEvent: 'document.verified', actions: [{ type: 'schedule_reminder', config: { documentTypeKey: 'made_up_type' } }] })).toEqual([expect.objectContaining({ code: 'UNKNOWN_DOCUMENT_TYPE' })]);

      // The same things of the own centre are fine.
      const branch = await t.sys.branch.findUniqueOrThrow({ where: { id: alpha.headOfficeId } });
      const ok = await t
        .as(manager)
        .post('/automations', {
          name: 'Own references',
          triggerEvent: 'request.submitted',
          conditions: { all: [{ fact: 'service.code', op: 'in', value: [alphaService.code] }, { fact: 'branch.code', op: 'eq', value: branch.code }, { fact: 'service.categoryKey', op: 'eq', value: 'visa' }] },
          actions: [{ type: 'assign_staff', config: { mode: 'MEMBER', membershipId: operator.membershipId } }, { type: 'create_task', config: { title: 'Task', roleKey: 'reviewer' } }, { type: 'generate_document', config: { documentTypeKey: 'passport' } }],
        })
        .expect(201);
      expect(ok.body.problems).toEqual([]);
    });

    it('shows on the rule when something it refers to has gone, and refuses to switch it on', async () => {
      const key = `night_shift_${uniq().slice(-6)}`;
      const role = await t.as(alpha.owner).post('/roles', { key, name: 'Night shift', permissions: ['task.read'] }).expect(201);
      const rule = await createRule(t, manager, { triggerEvent: 'request.overdue', isEnabled: false, actions: [{ type: 'escalate', config: { roleKey: key } }] });
      await t.sys.rolePermission.deleteMany({ where: { roleId: role.body.id } });
      await t.sys.role.delete({ where: { id: role.body.id } });
      expect((await t.as(manager).get(`/automations/${rule.id}`).expect(200)).body.problems).toEqual([expect.objectContaining({ path: 'actions.0.config.roleKey', code: 'UNKNOWN_ROLE' })]);
      const refused = await t.as(manager).post(`/automations/${rule.id}/enable`).expect(422);
      expect(refused.body).toMatchObject({ code: 'INVALID_AUTOMATION', message: 'This automation cannot be switched on yet.' });
      expect((await t.sys.automationRule.findUniqueOrThrow({ where: { id: rule.id } })).isEnabled).toBe(false);
    });
  });

  // ------------------------------------------------------------------ enable / disable
  describe('switching on and off', () => {
    it('switches a rule on and off, idempotently and audited', async () => {
      const rule = await createRule(t, manager, { triggerEvent: 'request.submitted', isEnabled: false, actions: [TASK_ACTION] });
      expect((await t.as(manager).post(`/automations/${rule.id}/enable`).expect(200)).body).toMatchObject({ isEnabled: true, problems: [] });
      expect((await t.as(manager).post(`/automations/${rule.id}/enable`).expect(200)).body.isEnabled).toBe(true);
      expect((await t.as(manager).post(`/automations/${rule.id}/disable`).expect(200)).body.isEnabled).toBe(false);
      expect((await t.as(manager).post(`/automations/${rule.id}/disable`).expect(200)).body.isEnabled).toBe(false);
      const audit = await t.sys.auditLog.findMany({ where: { tenantId: alpha.id, resourceType: 'AutomationRule', resourceId: rule.id, action: { in: ['automation.enabled', 'automation.disabled'] } }, orderBy: { createdAt: 'asc' } });
      expect(audit.map((a) => a.action)).toEqual(['automation.enabled', 'automation.disabled']);
    });

    it('checks the webhook destination when a rule is saved and when it is switched on', async () => {
      const gamma = await t.createTenant();
      // A complete URL must be on a host approved by the operator - whatever the centre types.
      for (const url of ['https://evil.example/hook', 'https://169.254.169.254/latest/meta-data', 'https://localhost/x']) {
        const res = await t.as(gamma.owner).post('/automations', { name: 'Hook', triggerEvent: 'request.submitted', actions: [{ type: 'call_webhook', config: { url } }] }).expect(422);
        expect(problemsOf(res.body)).toEqual([expect.objectContaining({ path: 'actions.0.config.url', code: 'HOST_NOT_ALLOWED' })]);
      }
      const remove = allowHost('hooks.partner.example');
      try {
        expect(codes((await t.as(gamma.owner).post('/automations', { name: 'Hook', triggerEvent: 'request.submitted', actions: [{ type: 'call_webhook', config: { url: 'https://user:pw@hooks.partner.example/a' } }] }).expect(422)).body)).toEqual(['CREDENTIALS_IN_URL']);
        // Saved switched off: fine. Switched on: there is no signing secret yet.
        const saved = await t.as(gamma.owner).post('/automations', { name: 'Hook', triggerEvent: 'request.submitted', actions: [{ type: 'call_webhook', config: { url: 'https://hooks.partner.example/a' } }] }).expect(201);
        expect(codes((await t.as(gamma.owner).post(`/automations/${saved.body.id}/enable`).expect(422)).body)).toEqual(['NOT_CONFIGURED']);

        // A path needs an n8n address; one that is saved but not switched on does not count.
        const byPath = await t.as(gamma.owner).post('/automations', { name: 'To n8n', triggerEvent: 'request.submitted', actions: [{ type: 'call_webhook', config: { path: '/typease/new' } }] }).expect(201);
        expect(codes((await t.as(gamma.owner).post(`/automations/${byPath.body.id}/enable`).expect(422)).body)).toEqual(['NOT_CONFIGURED']);
        await connectN8n(t, gamma, 'https://hooks.partner.example/webhook', 'gamma-secret', 'CONFIGURED');
        await t.as(gamma.owner).post(`/automations/${byPath.body.id}/enable`).expect(422);
        expect((await t.as(gamma.owner).get('/automations/meta').expect(200)).body.webhook).toMatchObject({ configured: false, source: null });

        await connectN8n(t, gamma, 'https://hooks.partner.example/webhook', 'gamma-secret', 'ACTIVE');
        expect((await t.as(gamma.owner).post(`/automations/${byPath.body.id}/enable`).expect(200)).body.isEnabled).toBe(true);
        expect((await t.as(gamma.owner).post(`/automations/${saved.body.id}/enable`).expect(200)).body.isEnabled).toBe(true);
        const meta = await t.as(gamma.owner).get('/automations/meta').expect(200);
        expect(meta.body.webhook).toMatchObject({ configured: true, source: 'CENTRE' });
        // The secret is never part of any answer.
        expect(JSON.stringify([meta.body, (await t.as(gamma.owner).get(`/automations/${byPath.body.id}`)).body])).not.toContain('gamma-secret');
        // Creating a rule that is switched on at once runs the same checks.
        await t.as(gamma.owner).post('/automations', { name: 'On at once', triggerEvent: 'request.submitted', isEnabled: true, actions: [{ type: 'call_webhook', config: { path: '/typease/other' } }] }).expect(201);
      } finally {
        remove();
      }
    });

    it('says what still stops a rule from running on create, update, read and switch-off - not only when it is switched on', async () => {
      const delta = await t.createTenant();
      const owner = delta.owner;
      const hook = { type: 'call_webhook', config: { path: '/typease/new' } };
      const found = (body: any) => (body.problems as Array<{ path: string; code: string; message: string }>).map((p) => [p.path, p.code]);
      const remove = allowHost('hooks.partner.example');
      try {
        // Saved switched off without an n8n connection: accepted, and the answer says what is missing.
        const created = await t.as(owner).post('/automations', { name: 'To n8n', triggerEvent: 'request.submitted', actions: [hook] }).expect(201);
        const id = created.body.id as string;
        expect(created.body.isEnabled).toBe(false);
        expect(found(created.body)).toEqual([['actions.0.config.path', 'NOT_CONFIGURED']]);
        expect(created.body.problems[0].message).toMatch(/n8n/);

        // The same finding on read and on every change, at the place of the action it is about.
        const read = await t.as(owner).get(`/automations/${id}`).expect(200);
        expect(read.body.problems).toEqual(created.body.problems);
        expect(found((await t.as(owner).patch(`/automations/${id}`, { name: 'New requests to n8n' }).expect(200)).body)).toEqual([['actions.0.config.path', 'NOT_CONFIGURED']]);
        const moved = await t.as(owner).patch(`/automations/${id}`, { actions: [TASK_ACTION, hook] }).expect(200);
        expect(found(moved.body)).toEqual([['actions.1.config.path', 'NOT_CONFIGURED']]);
        // Switching on refuses with exactly the list the owner was already shown.
        const refused = await t.as(owner).post(`/automations/${id}/enable`).expect(422);
        expect(refused.body.details.problems).toEqual(moved.body.problems);
        // A rule that is to run at once is not saved with such a finding.
        const before = await t.sys.automationRule.count({ where: { tenantId: delta.id } });
        expect(codes((await t.as(owner).post('/automations', { name: 'On at once', triggerEvent: 'request.submitted', isEnabled: true, actions: [hook] }).expect(422)).body)).toEqual(['NOT_CONFIGURED']);
        expect(await t.sys.automationRule.count({ where: { tenantId: delta.id } })).toBe(before);

        // An address without a signing secret is a different finding (on the action, not on its path).
        await connectN8n(t, delta, 'https://hooks.partner.example/webhook', '', 'ACTIVE');
        const noSecret = (await t.as(owner).get(`/automations/${id}`).expect(200)).body;
        expect(found(noSecret)).toEqual([['actions.1', 'NOT_CONFIGURED']]);
        expect(noSecret.problems[0].message).toMatch(/signing secret/);

        // With the connection in place nothing is left, and the rule can be switched on.
        await connectN8n(t, delta, 'https://hooks.partner.example/webhook', 'delta-secret', 'ACTIVE');
        expect((await t.as(owner).get(`/automations/${id}`).expect(200)).body.problems).toEqual([]);
        expect((await t.as(owner).patch(`/automations/${id}`, { description: 'Checked' }).expect(200)).body.problems).toEqual([]);
        expect((await t.as(owner).post(`/automations/${id}/enable`).expect(200)).body).toMatchObject({ isEnabled: true, problems: [] });

        // The connection is switched off later: the running rule shows it, cannot be changed into something that
        // cannot run, and switching it off keeps saying what has to be repaired.
        await connectN8n(t, delta, 'https://hooks.partner.example/webhook', 'delta-secret', 'CONFIGURED');
        const stale = await t.as(owner).get(`/automations/${id}`).expect(200);
        expect(stale.body.isEnabled).toBe(true);
        expect(found(stale.body)).toEqual([['actions.1.config.path', 'NOT_CONFIGURED']]);
        expect(codes((await t.as(owner).patch(`/automations/${id}`, { name: 'Renamed while broken' }).expect(422)).body)).toEqual(['NOT_CONFIGURED']);
        const off = await t.as(owner).post(`/automations/${id}/disable`).expect(200);
        expect(off.body.isEnabled).toBe(false);
        expect(found(off.body)).toEqual([['actions.1.config.path', 'NOT_CONFIGURED']]);
        expect(found((await t.as(owner).post(`/automations/${id}/disable`).expect(200)).body)).toEqual([['actions.1.config.path', 'NOT_CONFIGURED']]);
        // Once it is off it can be edited again; the finding stays on the answer.
        expect(found((await t.as(owner).patch(`/automations/${id}`, { name: 'Renamed while off' }).expect(200)).body)).toEqual([['actions.1.config.path', 'NOT_CONFIGURED']]);

        // A stale reference is reported the same way and comes before anything about the connection.
        const key = `late_shift_${uniq().slice(-6)}`;
        const role = await t.as(owner).post('/roles', { key, name: 'Late shift', permissions: ['task.read'] }).expect(201);
        const withRole = await t.as(owner).post('/automations', { name: 'Late shift task', triggerEvent: 'request.submitted', actions: [{ type: 'create_task', config: { title: 'Look', roleKey: key } }, hook] }).expect(201);
        expect(found(withRole.body)).toEqual([['actions.1.config.path', 'NOT_CONFIGURED']]);
        await t.sys.rolePermission.deleteMany({ where: { roleId: role.body.id } });
        await t.sys.role.delete({ where: { id: role.body.id } });
        expect(found((await t.as(owner).get(`/automations/${withRole.body.id}`).expect(200)).body)).toEqual([['actions.0.config.roleKey', 'UNKNOWN_ROLE']]);
        expect(found((await t.as(owner).post(`/automations/${withRole.body.id}/disable`).expect(200)).body)).toEqual([['actions.0.config.roleKey', 'UNKNOWN_ROLE']]);

        // Findings never carry the secret, and another centre never sees the rule or its findings.
        expect(JSON.stringify([stale.body, off.body, noSecret])).not.toContain('delta-secret');
        await t.as(manager).get(`/automations/${id}`).expect(404);
      } finally {
        remove();
      }
    });
  });

  // ------------------------------------------------------------------ templates and meta
  describe('templates and meta', () => {
    it('offers the gallery and creates a DISABLED rule from a template', async () => {
      const gallery = await t.as(manager).get('/automations/templates').expect(200);
      expect(gallery.body.available).toBe(true);
      expect(gallery.body.templates.length).toBeGreaterThanOrEqual(8);
      expect(gallery.body.templates.find((x: any) => x.key === 'thank-customer-on-completion')).toMatchObject({
        name: 'Thank the customer when a request is completed', category: 'Customer communication', triggerEvent: 'request.completed', triggerLabel: 'A request was completed',
        actions: [expect.objectContaining({ type: 'send_notification', label: 'Send notification' })],
      });

      const copy = await t.as(manager).post('/automations/from-template/notify-manager-request-overdue', { name: 'Overdue alarm' }).expect(201);
      expect(copy.body).toMatchObject({ name: 'Overdue alarm', templateKey: 'notify-manager-request-overdue', triggerEvent: 'request.overdue', isEnabled: false, problems: [] });
      expect(copy.body.actions[0].config).toMatchObject({ to: 'ROLE', roleKey: 'manager', channels: ['IN_APP', 'EMAIL'], purpose: 'SERVICE' });
      // The copy belongs to the centre: it can be edited and switched on like any rule.
      await t.as(manager).patch(`/automations/${copy.body.id}`, { description: 'Reviewed by the owner' }).expect(200);
      expect((await t.as(manager).post(`/automations/${copy.body.id}/enable`).expect(200)).body.isEnabled).toBe(true);

      // Default name; and a template whose requirements are not met yet says so instead of failing.
      const n8n = await t.as(manager).post('/automations/from-template/send-new-requests-to-n8n').expect(201);
      expect(n8n.body).toMatchObject({ name: 'Send new requests to n8n', isEnabled: false });
      expect(n8n.body.problems).toEqual([expect.objectContaining({ code: 'NOT_CONFIGURED' })]);
      await t.as(manager).post('/automations/from-template/does-not-exist').expect(404);
      await t.as(manager).post('/automations/from-template/auto-assign-on-submission', { isEnabled: true }).expect(400);
    });

    it('creates a valid rule from every template', async () => {
      const gallery = await t.as(alpha.owner).get('/automations/templates').expect(200);
      for (const template of gallery.body.templates) {
        const res = await t.as(alpha.owner).post(`/automations/from-template/${template.key}`).expect(201);
        expect([template.key, res.body.problems.filter((p: any) => p.code !== 'NOT_CONFIGURED')]).toEqual([template.key, []]);
        expect(res.body.isEnabled).toBe(false);
      }
    });

    it('describes triggers, facts, variables and actions for the rule builder', async () => {
      const meta = (await t.as(manager).get('/automations/meta').expect(200)).body;
      expect(meta.available).toBe(true);
      expect(meta.triggers).toHaveLength(15);
      expect(meta.actions.map((a: any) => a.type).sort()).toEqual(['assign_staff', 'call_webhook', 'create_follow_up', 'create_task', 'escalate', 'generate_document', 'request_approval', 'schedule_reminder', 'send_notification', 'update_workflow_state']);
      const changed = meta.triggers.find((x: any) => x.key === 'request.status_changed');
      expect(changed).toMatchObject({ label: 'A request moved to a new status', hasRequest: 'ALWAYS', hasCustomer: 'ALWAYS' });
      expect(changed.facts.find((f: any) => f.key === 'status.to')).toMatchObject({ label: 'Status after the change', type: 'string', values: expect.arrayContaining(['COMPLETED']) });
      expect(changed.variables.map((v: any) => v.key)).toEqual(expect.arrayContaining(['customerName', 'requestNumber', 'previousStatusLabel', 'centreLink']));
      expect(meta.automaticStatuses.map((s: any) => s.status).sort()).toEqual(['AWAITING_PAYMENT', 'IN_PREPARATION', 'QUOTED', 'READY_FOR_PROCESSING', 'UNDER_REVIEW']);
      expect(meta.operators).toEqual(expect.arrayContaining(['eq', 'in', 'gt', 'exists']));
      expect(meta.limits).toEqual({ maxActions: 10, maxRetries: 10, maxConditionsPerGroup: 20 });
    });
  });

  // ------------------------------------------------------------------ dry run
  describe('dry run', () => {
    it('explains what a rule would do for a real event without doing any of it', async () => {
      const delta = await t.createTenant({ name: 'Delta Typing' });
      const service = await createService(t, delta, { name: 'Golden visa' });
      const customer = await createCustomer(t, delta, { fullName: 'Omar Haddad' });
      const rule = await createRule(t, delta.owner, {
        name: 'Urgent handling',
        triggerEvent: 'request.submitted',
        isEnabled: false,
        conditions: { all: [{ fact: 'request.priority', op: 'eq', value: 'URGENT' }], any: [{ fact: 'service.code', op: 'eq', value: service.code }, { fact: 'customer.isCorporate', op: 'eq', value: true }] },
        actions: [
          { type: 'create_task', config: { title: 'Call {{customerName}} about {{requestNumber}}', roleKey: 'receptionist' } },
          { type: 'send_notification', config: { to: 'ASSIGNEE', channels: ['IN_APP'], subject: 'Urgent', body: 'Look at {{requestNumber}}' } },
          { type: 'update_workflow_state', config: { to: 'AWAITING_PAYMENT' } },
          { type: 'call_webhook', config: { path: '/typease/urgent' } },
        ],
      });
      // Nothing has happened in this centre yet.
      expect((await t.as(delta.owner).post(`/automations/${rule.id}/test`).expect(422)).body.code).toBe('NO_RECENT_EVENT');

      const normal = await submittedRequest(t, delta, delta.owner, service.id, customer.id);
      const urgent = await submittedRequest(t, delta, delta.owner, service.id, customer.id, { priority: 'URGENT' });
      await t.settle();
      const tasksBefore = await t.sys.task.count({ where: { tenantId: delta.id } });
      const notificationsBefore = await t.sys.notification.count({ where: { tenantId: delta.id } });

      // Default: the most recent event of the trigger.
      const run = (await t.as(delta.owner).post(`/automations/${rule.id}/test`).expect(200)).body;
      expect(run).toMatchObject({ dryRun: true, rule: { id: rule.id, isEnabled: false }, conditionsMet: true, wouldRun: false, notes: ['The automation is switched off.'] });
      expect(run.event).toMatchObject({ type: 'request.submitted', label: 'A request was submitted for processing', causedByAutomation: false, data: { requestId: urgent.id, customerId: customer.id } });
      expect(run.facts).toMatchObject({ 'event.type': 'request.submitted', 'event.actorType': 'STAFF', 'request.priority': 'URGENT', 'request.isAssigned': false, 'service.code': service.code, 'customer.type': 'INDIVIDUAL', 'customer.isCorporate': false });
      expect(run.conditions).toEqual([
        { group: 'all', fact: 'request.priority', label: 'Priority of the request', op: 'eq', value: 'URGENT', actual: 'URGENT', passed: true },
        { group: 'any', fact: 'service.code', label: 'Service code', op: 'eq', value: service.code, actual: service.code, passed: true },
        { group: 'any', fact: 'customer.isCorporate', label: 'Customer belongs to a company account', op: 'eq', value: true, actual: false, passed: false },
      ]);
      expect(run.actions.map((a: any) => [a.index, a.type, a.applicable])).toEqual([[0, 'create_task', true], [1, 'send_notification', false], [2, 'update_workflow_state', false], [3, 'call_webhook', false]]);
      expect(run.actions[0].preview).toMatchObject({ title: `Call Omar Haddad about ${urgent.requestNo}`, queue: 'receptionist' });
      expect(run.actions[1].note).toMatch(/no operator/);
      expect(run.actions[2].note).toMatch(/cannot be moved to "Awaiting payment" by an automation/);
      expect(run.actions[3].note).toMatch(/No n8n address is configured/);

      // A named event; this one does not meet the conditions, so no actions are listed.
      const events = await t.sys.outboxEvent.findMany({ where: { tenantId: delta.id, type: 'request.submitted' } });
      const normalEvent = events.find((e) => (e.payload as any).requestId === normal.id)!;
      const miss = (await t.as(delta.owner).post(`/automations/${rule.id}/test`, { eventId: normalEvent.id }).expect(200)).body;
      expect(miss).toMatchObject({ conditionsMet: false, wouldRun: false, actions: [] });
      expect(miss.conditions[0]).toMatchObject({ actual: 'NORMAL', passed: false });

      // Wrong kind of event, an event of another centre, garbage.
      const other = await t.sys.outboxEvent.findFirstOrThrow({ where: { tenantId: delta.id, type: 'request.created' } });
      expect((await t.as(delta.owner).post(`/automations/${rule.id}/test`, { eventId: other.id }).expect(422)).body.code).toBe('EVENT_TYPE_MISMATCH');
      const foreign = await t.sys.outboxEvent.findFirstOrThrow({ where: { tenantId: alpha.id } });
      await t.as(delta.owner).post(`/automations/${rule.id}/test`, { eventId: foreign.id }).expect(404);
      await t.as(delta.owner).post(`/automations/${rule.id}/test`, { eventId: 'nope' }).expect(400);

      // Nothing was executed and nothing was recorded.
      await t.settle();
      expect(await executionsOf(t, rule.id)).toEqual([]);
      expect(await t.sys.task.count({ where: { tenantId: delta.id } })).toBe(tasksBefore);
      expect(await t.sys.notification.count({ where: { tenantId: delta.id } })).toBe(notificationsBefore);
      expect((await t.sys.serviceRequest.findUniqueOrThrow({ where: { id: urgent.id } })).status).not.toBe('AWAITING_PAYMENT');

      // Switched on, the same dry run says the rule would run.
      await t.as(delta.owner).patch(`/automations/${rule.id}`, { actions: [{ type: 'create_task', config: { title: 'Call {{customerName}}' } }] }).expect(200);
      await t.as(delta.owner).post(`/automations/${rule.id}/enable`).expect(200);
      expect((await t.as(delta.owner).post(`/automations/${rule.id}/test`).expect(200)).body).toMatchObject({ conditionsMet: true, wouldRun: true, notes: [] });
      expect(await executionsOf(t, rule.id)).toEqual([]);
    });
  });

  // ------------------------------------------------------------------ isolation
  describe('tenant isolation', () => {
    it('never shows or touches the rules and executions of another centre', async () => {
      const rule = await createRule(t, alpha.owner, { name: 'Alpha secret rule', triggerEvent: 'customer.created', actions: [{ type: 'create_task', config: { title: 'Welcome {{customerName}}' } }] });
      await t.as(alpha.owner).post('/customers', { fullName: 'Isolation Test' }).expect(201);
      await t.settle();
      const [execution] = await executionsOf(t, rule.id);
      expect(execution).toBeDefined();

      expect((await t.as(beta.owner).get('/automations').expect(200)).body.data).toEqual([]);
      expect((await t.as(beta.owner).get('/automations/executions').expect(200)).body.data).toEqual([]);
      expect((await t.as(beta.owner).get(`/automations/executions?ruleId=${rule.id}`).expect(200)).body.data).toEqual([]);
      expect((await t.as(beta.owner).get('/automations/summary').expect(200)).body).toMatchObject({ rules: { total: 0, enabled: 0 }, executions: { allTime: { total: 0 } }, deadLetters: { open: 0, recent: [] } });
      await t.as(beta.owner).get(`/automations/${rule.id}`).expect(404);
      await t.as(beta.owner).patch(`/automations/${rule.id}`, { name: 'Taken over' }).expect(404);
      await t.as(beta.owner).delete(`/automations/${rule.id}`).expect(404);
      await t.as(beta.owner).post(`/automations/${rule.id}/enable`).expect(404);
      await t.as(beta.owner).post(`/automations/${rule.id}/disable`).expect(404);
      await t.as(beta.owner).post(`/automations/${rule.id}/test`).expect(404);
      await t.as(beta.owner).get(`/automations/executions/${execution.id}`).expect(404);
      await t.as(beta.owner).post(`/automations/executions/${execution.id}/retry`).expect(404);
      const untouched = await t.sys.automationRule.findUniqueOrThrow({ where: { id: rule.id } });
      expect(untouched).toMatchObject({ name: 'Alpha secret rule', isEnabled: true, tenantId: alpha.id });

      // Events of one centre never start rules of another.
      const betaRule = await createRule(t, beta.owner, { triggerEvent: 'customer.created', actions: [{ type: 'create_task', config: { title: 'Beta welcome' } }] });
      await t.as(alpha.owner).post('/customers', { fullName: 'Second Isolation Test' }).expect(201);
      await t.settle();
      expect(await executionsOf(t, betaRule.id)).toEqual([]);
      expect((await executionsOf(t, rule.id)).length).toBe(2);
      expect(await t.sys.task.count({ where: { tenantId: beta.id, source: 'AUTOMATION' } })).toBe(0);
    });
  });
});
