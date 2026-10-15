import { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { env } from '../../config/env';
import { DomainEvents } from '../../common/events.service';
import { makeCustomer } from '../notifications/fixtures';
import { createService, submittedRequest } from '../requests/fixtures';
import { AutomationEngine, EXECUTE_JOB, SWEEP_JOB } from './engine.service';
import { allowHost, connectN8n, createRule, executionsOf, HookServer, onlyExecution, results } from './fixtures';

const SECRET = 'centre-signing-secret-1';

/** The engine itself: webhooks, retries with backoff, the dead-letter list, manual retry, lost jobs. */
describe('Automation engine', () => {
  let t: TestApp;
  let hooks: HookServer;
  let disallow: () => void;

  /** A centre with its own n8n connection pointing at the local server. */
  async function centre(options: { base?: string; secret?: string | null } = {}) {
    const tenant = await t.createTenant();
    if (options.secret !== null) await connectN8n(t, tenant, options.base ?? hooks.base, options.secret ?? SECRET);
    const receptionist = await t.addStaff(tenant, 'receptionist');
    const service = await createService(t, tenant, { name: 'Residence visa' });
    await t.settle();
    return { tenant, receptionist, service };
  }
  const submit = async (c: { tenant: TenantFixture; receptionist: Actor; service: { id: string } }, customerId?: string, extra: Record<string, unknown> = {}) =>
    (await submittedRequest(t, c.tenant, c.receptionist, c.service.id, customerId ?? (await makeCustomer(t, c.tenant)).id, extra)) as { id: string; requestNo: string };
  const inbox = async (actor: Actor) => (await t.as(actor).get('/me/notifications?pageSize=50').expect(200)).body.data as Array<{ subject: string; body: string }>;
  const pendingRetries = () => ((t.jobs as any).inline as Array<{ name: string; payload: any; runAt: number }>).filter((j) => j.name === EXECUTE_JOB);
  const retryAll = () => t.jobs.drain({ includeDelayed: true });

  beforeAll(async () => {
    t = await TestApp.create();
    hooks = await new HookServer().start();
    // What an operator does for a development n8n: the host is approved explicitly.
    disallow = allowHost('127.0.0.1');
  });
  afterAll(async () => {
    disallow();
    await hooks.stop();
    await t.close();
  });
  beforeEach(() => {
    hooks.received.length = 0;
    hooks.statuses = [];
  });

  // ------------------------------------------------------------------ webhook
  describe('call_webhook', () => {
    it('POSTs a signed payload with identifiers only to the n8n address of the centre', async () => {
      const c = await centre();
      const rule = await createRule(t, c.tenant.owner, { name: 'To n8n', triggerEvent: 'request.submitted', actions: [{ type: 'call_webhook', config: { path: '/typease/request-submitted' } }] });
      const customer = await makeCustomer(t, c.tenant, { fullName: 'Sensitive Person Name', email: 'sensitive@example.test', phone: '+971509998877' });
      await t.sys.customer.update({ where: { id: customer.id }, data: { passportNoLast4: '4567', nationality: 'IN' } });
      const request = await submit(c, customer.id, { instructions: 'My passport number is P1234567', priority: 'HIGH' });
      await t.settle();

      const execution = await onlyExecution(t, rule.id);
      expect(execution).toMatchObject({ status: 'SUCCEEDED', attempts: 1 });
      expect(hooks.received).toHaveLength(1);
      const call = hooks.received[0];
      expect(call.path).toBe('/webhook/typease/request-submitted');
      expect(call.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(call.headers['x-typease-event']).toBe('request.submitted');
      expect(call.headers['x-typease-delivery']).toBe(`${execution.id}:0`);
      expect(Math.abs(Number(call.headers['x-typease-timestamp']) - Date.now() / 1000)).toBeLessThan(60);
      // The receiver verifies the call with the shared secret - and only with the right one.
      expect(call.headers['x-typease-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
      expect(call.signatureValid(SECRET)).toBe(true);
      expect(call.signatureValid('some-other-secret')).toBe(false);

      const event = await t.sys.outboxEvent.findUniqueOrThrow({ where: { id: execution.eventId } });
      const branch = await t.sys.branch.findUniqueOrThrow({ where: { id: c.tenant.headOfficeId } });
      const service = await t.sys.service.findUniqueOrThrow({ where: { id: c.service.id } });
      expect(call.json).toEqual({
        event: 'request.submitted',
        tenantSlug: c.tenant.slug,
        occurredAt: event.createdAt.toISOString(),
        data: {
          eventId: event.id,
          requestId: request.id,
          customerId: customer.id,
          request: { id: request.id, number: request.requestNo, status: 'SUBMITTED', priority: 'HIGH', serviceCode: service.code, branchCode: branch.code },
        },
      });
      // No names, contact details, free text or identity data - whatever the request contains.
      for (const secret of ['Sensitive', 'sensitive@example.test', '+971509998877', 'P1234567', 'passport', '4567', SECRET]) expect(call.raw).not.toContain(secret);
      expect(results(execution)[0]).toMatchObject({ status: 'SUCCEEDED', output: { host: '127.0.0.1', path: '/webhook/typease/request-submitted', status: 200 } });
      // The execution log never shows the secret either.
      expect(JSON.stringify((await t.as(c.tenant.owner).get(`/automations/executions/${execution.id}`).expect(200)).body)).not.toContain(SECRET);
    });

    it("signs with the platform secret when the centre uses the platform's n8n", async () => {
      const e = env() as any;
      const before = { base: e.N8N_WEBHOOK_BASE_URL, secret: e.N8N_WEBHOOK_SECRET };
      e.N8N_WEBHOOK_BASE_URL = `http://localhost:${hooks.port}/platform-hooks/`;
      e.N8N_WEBHOOK_SECRET = 'platform-secret';
      try {
        const c = await centre({ secret: null }); // no connection of its own
        expect((await t.as(c.tenant.owner).get('/automations/meta').expect(200)).body.webhook).toMatchObject({ configured: true, source: 'PLATFORM' });
        const rule = await createRule(t, c.tenant.owner, { triggerEvent: 'request.submitted', actions: [{ type: 'call_webhook', config: { path: '/new' } }] });
        await submit(c);
        await t.settle();
        expect((await onlyExecution(t, rule.id)).status).toBe('SUCCEEDED');
        expect(hooks.received.map((h) => h.path)).toEqual(['/platform-hooks/new']);
        expect(hooks.received[0].signatureValid('platform-secret')).toBe(true);
      } finally {
        e.N8N_WEBHOOK_BASE_URL = before.base;
        e.N8N_WEBHOOK_SECRET = before.secret;
      }
    });

    it('refuses a private address typed by a centre, and never calls it', async () => {
      // The centre saved an internal address as its n8n (the integrations module would not allow this; the engine does not rely on that).
      for (const base of ['https://10.0.0.5/webhook', 'https://169.254.169.254/latest', 'https://[::1]/webhook', 'https://127.0.0.2/webhook']) {
        const c = await centre({ base });
        const rule = await createRule(t, c.tenant.owner, { name: 'Internal probe', triggerEvent: 'request.submitted', maxRetries: 5, actions: [{ type: 'call_webhook', config: { path: '/x' } }] });
        await submit(c);
        await t.settle();
        const execution = await onlyExecution(t, rule.id);
        // Not retried: the answer cannot change.
        expect([base, execution.status, execution.attempts]).toEqual([base, 'DEAD_LETTER', 1]);
        expect(results(execution)[0].error).toMatchObject({ code: 'PRIVATE_ADDRESS', retryable: false, message: expect.stringContaining('private or internal network address') });
      }
      expect(hooks.received).toEqual([]);
    });

    it('refuses plain http and hosts that are not (or no longer) approved', async () => {
      // 1. The local server over http, but 127.0.0.1 is not on the allow-list any more: it is just a centre-supplied http address.
      const c = await centre();
      const rule = await createRule(t, c.tenant.owner, { triggerEvent: 'request.submitted', actions: [{ type: 'call_webhook', config: { path: '/x' } }] });
      disallow();
      try {
        await submit(c);
        await t.settle();
        const refused = await onlyExecution(t, rule.id);
        expect(refused.status).toBe('DEAD_LETTER');
        expect(results(refused)[0].error).toMatchObject({ code: 'HTTPS_REQUIRED', retryable: false });
      } finally {
        disallow = allowHost('127.0.0.1');
      }

      // 2. A complete URL on a host that was approved when the rule was saved and has been removed since.
      const d = await centre();
      const remove = allowHost('hooks.partner.example');
      const byUrl = await createRule(t, d.tenant.owner, { triggerEvent: 'request.submitted', actions: [{ type: 'call_webhook', config: { url: 'https://hooks.partner.example/in' } }] });
      remove();
      await submit(d);
      await t.settle();
      const stale = await onlyExecution(t, byUrl.id);
      expect(stale.status).toBe('DEAD_LETTER');
      expect(results(stale)[0].error).toMatchObject({ code: 'HOST_NOT_ALLOWED', retryable: false });
      // ... and it cannot be saved again.
      const res = await t.as(d.tenant.owner).patch(`/automations/${byUrl.id}`, { actions: [{ type: 'call_webhook', config: { url: 'https://hooks.partner.example/in' } }] }).expect(422);
      expect(res.body.details.problems[0]).toMatchObject({ code: 'HOST_NOT_ALLOWED' });
      expect(hooks.received).toEqual([]);
    });

    it('does not follow redirects', async () => {
      const c = await centre();
      const rule = await createRule(t, c.tenant.owner, { triggerEvent: 'request.submitted', actions: [{ type: 'call_webhook', config: { path: '/moved' } }] });
      hooks.statuses = [302];
      await submit(c);
      await t.settle();
      const execution = await onlyExecution(t, rule.id);
      expect(execution.status).toBe('DEAD_LETTER');
      expect(results(execution)[0].error).toMatchObject({ code: 'WEBHOOK_HTTP_302', retryable: false });
      expect(hooks.received.map((h) => h.path)).toEqual(['/webhook/moved']);
    });
  });

  // ------------------------------------------------------------------ retries
  describe('retries and the dead-letter list', () => {
    it('retries a failed action with backoff and continues where it stopped, without repeating finished actions', async () => {
      const c = await centre();
      const rule = await createRule(t, c.tenant.owner, {
        name: 'Task then n8n then note',
        triggerEvent: 'request.submitted',
        maxRetries: 3,
        actions: [
          { type: 'create_task', config: { title: 'Before the webhook {{requestNumber}}' } },
          { type: 'call_webhook', config: { path: '/flaky' } },
          { type: 'create_task', config: { title: 'After the webhook {{requestNumber}}' } },
        ],
      });
      hooks.statuses = [500, 503]; // then 200
      const request = await submit(c);
      await t.settle();

      // First run: action 1 done, action 2 failed, action 3 not started; a retry is scheduled 30 seconds later.
      let execution = await onlyExecution(t, rule.id);
      expect(execution).toMatchObject({ status: 'FAILED', attempts: 1, error: 'Step 2 (Call n8n / webhook): The webhook answered with HTTP 500.' });
      expect(results(execution).map((r) => [r.status, r.attempts])).toEqual([['SUCCEEDED', 1], ['FAILED', 1], ['PENDING', 0]]);
      expect(results(execution)[1].error).toEqual({ code: 'WEBHOOK_HTTP_500', message: 'The webhook answered with HTTP 500.', retryable: true });
      const scheduled = pendingRetries().filter((j) => j.payload.executionId === execution.id);
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0].runAt - Date.now()).toBeGreaterThan(25_000);
      expect(scheduled[0].runAt - Date.now()).toBeLessThanOrEqual(30_000);
      // Not due yet: the normal queue run leaves it alone.
      await t.settle();
      expect(hooks.received).toHaveLength(1);

      // Second run fails again (503), third succeeds.
      await retryAll();
      execution = await onlyExecution(t, rule.id);
      expect(execution).toMatchObject({ status: 'SUCCEEDED', attempts: 3, error: null });
      expect(results(execution).map((r) => [r.status, r.attempts])).toEqual([['SUCCEEDED', 1], ['SUCCEEDED', 3], ['SUCCEEDED', 1]]);
      expect(results(execution)[1].error).toBeUndefined();
      expect(hooks.received).toHaveLength(3);
      // Every attempt carries the same delivery id, so the receiver can drop duplicates.
      expect(new Set(hooks.received.map((h) => h.headers['x-typease-delivery']))).toEqual(new Set([`${execution.id}:1`]));
      expect(hooks.received.every((h) => h.signatureValid(SECRET))).toBe(true);
      // The finished action ran exactly once; the one after the webhook ran only after it succeeded.
      const tasks = await t.sys.task.findMany({ where: { requestId: request.id, source: 'AUTOMATION' }, orderBy: { createdAt: 'asc' } });
      expect(tasks.map((x) => x.title)).toEqual([`Before the webhook ${request.requestNo}`, `After the webhook ${request.requestNo}`]);
      // A success after retries is not a failure: no dead letter, no alert.
      expect(await t.sys.auditLog.count({ where: { tenantId: c.tenant.id, action: 'automation.dead_letter' } })).toBe(0);
      expect((await inbox(c.tenant.owner)).some((n) => n.subject.startsWith('Automation failed'))).toBe(false);
    });

    it('gives up after maxRetries: dead letter, audit entry, in-app alert to the owners - and a manual retry finishes the job', async () => {
      const c = await centre();
      const manager = await t.addStaff(c.tenant, 'manager');
      const rule = await createRule(t, c.tenant.owner, {
        name: 'Unlucky webhook',
        triggerEvent: 'request.submitted',
        maxRetries: 2,
        actions: [{ type: 'create_task', config: { title: 'Once only {{requestNumber}}' } }, { type: 'call_webhook', config: { path: '/down' } }],
      });
      hooks.statuses = [500, 500, 500, 500, 500];
      const request = await submit(c);
      await t.settle();
      await retryAll();

      // 1 run + 2 retries, then no more.
      const dead = await onlyExecution(t, rule.id);
      expect(dead).toMatchObject({ status: 'DEAD_LETTER', attempts: 3, error: 'Step 2 (Call n8n / webhook): The webhook answered with HTTP 500.' });
      expect(dead.finishedAt).not.toBeNull();
      expect(hooks.received).toHaveLength(3);
      expect(results(dead).map((r) => [r.status, r.attempts])).toEqual([['SUCCEEDED', 1], ['FAILED', 3]]);
      expect(pendingRetries().filter((j) => j.payload.executionId === dead.id)).toEqual([]);
      await retryAll();
      expect(hooks.received).toHaveLength(3);

      const audit = await t.sys.auditLog.findMany({ where: { tenantId: c.tenant.id, action: 'automation.dead_letter' } });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ resourceType: 'AutomationExecution', resourceId: dead.id, actorType: 'AUTOMATION', summary: expect.stringContaining('Automation "Unlucky webhook" failed for good') });
      expect(audit[0].after).toMatchObject({ ruleId: rule.id, eventType: 'request.submitted', attempts: 3, step: 2, action: 'call_webhook', code: 'WEBHOOK_HTTP_500', retryable: true });
      const alerts = (await inbox(c.tenant.owner)).filter((n) => n.subject === 'Automation failed: Unlucky webhook');
      expect(alerts).toHaveLength(1);
      expect(alerts[0].body).toContain('could not finish after 3 attempt(s).');
      expect(alerts[0].body).toContain('Step 2 (Call n8n / webhook): The webhook answered with HTTP 500.');
      expect(alerts[0].body).toMatch(/Open the execution log: https?:\/\/\S+\/automations\/executions\/[0-9a-f-]{36}/);
      expect((await inbox(manager)).some((n) => n.subject.startsWith('Automation failed'))).toBe(false);
      const summary = (await t.as(manager).get('/automations/summary').expect(200)).body;
      expect(summary.deadLetters).toMatchObject({ open: 1, recent: [expect.objectContaining({ id: dead.id, ruleName: 'Unlucky webhook' })] });
      expect((await t.as(manager).get(`/automations/executions/${dead.id}`).expect(200)).body.canRetry).toBe(true);

      // n8n is back. Someone looks at the dead letter and retries it.
      hooks.statuses = [];
      const queued = (await t.as(manager).post(`/automations/executions/${dead.id}/retry`).expect(200)).body;
      expect(queued).toMatchObject({ id: dead.id, status: 'PENDING', attempts: 0, error: null });
      await t.settle();
      const done = await onlyExecution(t, rule.id);
      expect(done).toMatchObject({ status: 'SUCCEEDED', attempts: 1, error: null });
      expect(hooks.received).toHaveLength(4);
      expect(await t.sys.task.count({ where: { requestId: request.id, title: `Once only ${request.requestNo}` } })).toBe(1);
      expect(await t.sys.auditLog.count({ where: { tenantId: c.tenant.id, action: 'automation.execution_retried', resourceId: dead.id, actorUserId: manager.userId } })).toBe(1);
      expect((await t.as(manager).get('/automations/summary').expect(200)).body.deadLetters.open).toBe(0);

      // Only dead letters can be retried, and only while the automation is switched on.
      expect((await t.as(manager).post(`/automations/executions/${dead.id}/retry`).expect(409)).body.code).toBe('NOT_DEAD_LETTERED');
      hooks.statuses = [404];
      await submit(c);
      await t.settle();
      const second = (await executionsOf(t, rule.id)).find((e) => e.id !== dead.id)!;
      expect(second).toMatchObject({ status: 'DEAD_LETTER', attempts: 1 }); // a 404 is not retried
      await t.as(manager).post(`/automations/${rule.id}/disable`).expect(200);
      expect((await t.as(manager).post(`/automations/executions/${second.id}/retry`).expect(409)).body.code).toBe('AUTOMATION_DISABLED');
      expect((await t.as(manager).get(`/automations/executions/${second.id}`).expect(200)).body.canRetry).toBe(false);
    });
  });

  // ------------------------------------------------------------------ lifecycle
  describe('lifecycle of an execution', () => {
    /** Delivers the events (creating executions) without running the jobs. */
    const deliverOnly = () => t.get(DomainEvents).dispatch();

    it('does not run a rule that was switched off, or lost its plan, between the event and its turn', async () => {
      const c = await centre();
      const off = await createRule(t, c.tenant.owner, { name: 'Switched off in time', triggerEvent: 'request.submitted', actions: [{ type: 'create_task', config: { title: 'Must not exist' } }] });
      await submit(c);
      await deliverOnly();
      expect((await onlyExecution(t, off.id)).status).toBe('PENDING');
      await t.as(c.tenant.owner).post(`/automations/${off.id}/disable`).expect(200);
      await t.settle();
      expect(await onlyExecution(t, off.id)).toMatchObject({ status: 'SKIPPED', attempts: 0, error: 'The automation was switched off before it ran.' });

      const downgraded = await createRule(t, c.tenant.owner, { name: 'Plan lost', triggerEvent: 'request.submitted', actions: [{ type: 'create_task', config: { title: 'Must not exist' } }] });
      await submit(c);
      await deliverOnly();
      const starter = await t.sys.subscriptionPlan.findUniqueOrThrow({ where: { key: 'starter' } });
      await t.sys.subscription.update({ where: { tenantId: c.tenant.id }, data: { planId: starter.id } });
      await t.settle();
      expect(await onlyExecution(t, downgraded.id)).toMatchObject({ status: 'SKIPPED', error: 'Automations are not included in the current plan.' });
      // From now on events do not even create executions; the rule itself is kept for the day the plan comes back.
      await submit(c);
      await t.settle();
      expect(await executionsOf(t, downgraded.id)).toHaveLength(1);
      expect((await t.sys.automationRule.findUniqueOrThrow({ where: { id: downgraded.id } })).isEnabled).toBe(true);
      expect(await t.sys.task.count({ where: { tenantId: c.tenant.id, title: 'Must not exist' } })).toBe(0);
    });

    it('a deleted rule takes its waiting executions with it', async () => {
      const c = await centre();
      const rule = await createRule(t, c.tenant.owner, { triggerEvent: 'request.submitted', actions: [{ type: 'create_task', config: { title: 'Must not exist either' } }] });
      await submit(c);
      await deliverOnly();
      const waiting = await onlyExecution(t, rule.id);
      await t.as(c.tenant.owner).delete(`/automations/${rule.id}`).expect(200);
      await t.settle(); // the queued job finds nothing and ends quietly
      expect(await t.sys.automationExecution.count({ where: { id: waiting.id } })).toBe(0);
      expect(await t.sys.task.count({ where: { tenantId: c.tenant.id, title: 'Must not exist either' } })).toBe(0);
      expect(t.jobs.deadLetters.filter((d) => d.name === EXECUTE_JOB)).toEqual([]);
      const audit = await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: c.tenant.id, action: 'automation.deleted', resourceId: rule.id } });
      expect(audit.summary).toContain('1 execution record(s)');
    });

    it('recovers executions whose job was lost, interrupted, or whose retry is due (sweep)', async () => {
      const c = await centre();
      const rule = await createRule(t, c.tenant.owner, { triggerEvent: 'request.submitted', actions: [{ type: 'create_task', config: { title: 'Swept {{requestNumber}}' } }] });
      const engine = t.get(AutomationEngine);
      const sweep = () => t.inTenant(c.tenant.id, () => engine.sweep());
      const lost = async () => {
        const request = await submit(c);
        await deliverOnly();
        t.jobs.clearInline(); // the process stopped before the job ran
        const row = (await executionsOf(t, rule.id)).find((e) => e.status === 'PENDING')!;
        return { request, row };
      };

      // 1. Never started. A fresh one is left alone (its job is probably still queued), an old one is queued again.
      const a = await lost();
      expect(await sweep()).toBe(0);
      await t.sys.automationExecution.update({ where: { id: a.row.id }, data: { createdAt: new Date(Date.now() - 5 * 60_000) } });
      expect(await sweep()).toBe(1);
      expect(await sweep()).toBe(1); // asked twice in the same window: the queue keeps one job
      expect(pendingRetries().filter((j) => j.payload.executionId === a.row.id)).toHaveLength(1);
      await t.settle();
      expect(await t.sys.automationExecution.findUniqueOrThrow({ where: { id: a.row.id } })).toMatchObject({ status: 'SUCCEEDED', attempts: 1 });

      // 2. Interrupted while RUNNING. While the run could still be alive nobody else touches it ...
      const b = await lost();
      await t.sys.automationExecution.update({ where: { id: b.row.id }, data: { status: 'RUNNING', attempts: 1, startedAt: new Date() } });
      expect(await engine.execute(c.tenant.id, b.row.id)).toBe('IGNORED');
      expect(await sweep()).toBe(0);
      // ... after 15 minutes it is taken over, as a new attempt.
      await t.sys.automationExecution.update({ where: { id: b.row.id }, data: { startedAt: new Date(Date.now() - 20 * 60_000) } });
      expect(await sweep()).toBe(1);
      await t.settle();
      expect(await t.sys.automationExecution.findUniqueOrThrow({ where: { id: b.row.id } })).toMatchObject({ status: 'SUCCEEDED', attempts: 2 });

      // 3. FAILED and the retry job was lost: picked up once its backoff has passed, not before.
      const d = await lost();
      await t.sys.automationExecution.update({ where: { id: d.row.id }, data: { status: 'FAILED', attempts: 1, startedAt: new Date(), finishedAt: new Date() } });
      expect(await sweep()).toBe(0);
      await t.sys.automationExecution.update({ where: { id: d.row.id }, data: { finishedAt: new Date(Date.now() - 3 * 60_000) } });
      expect(await sweep()).toBe(1);
      await t.settle();
      expect(await t.sys.automationExecution.findUniqueOrThrow({ where: { id: d.row.id } })).toMatchObject({ status: 'SUCCEEDED', attempts: 2 });

      // Each request got its task exactly once, and the scheduled job covers every centre.
      for (const x of [a, b, d]) expect(await t.sys.task.count({ where: { requestId: x.request.id, title: `Swept ${x.request.requestNo}` } })).toBe(1);
      expect(t.jobs.schedules().find((s) => s.name === SWEEP_JOB)).toMatchObject({ everySeconds: 300 });
      const e = await lost();
      await t.sys.automationExecution.update({ where: { id: e.row.id }, data: { createdAt: new Date(Date.now() - 5 * 60_000) } });
      await t.jobs.runScheduled(SWEEP_JOB);
      await t.settle();
      expect((await t.sys.automationExecution.findUniqueOrThrow({ where: { id: e.row.id } })).status).toBe('SUCCEEDED');
    });

    it('dead-letters an execution whose event no longer exists', async () => {
      const c = await centre();
      const rule = await createRule(t, c.tenant.owner, { name: 'Orphan', triggerEvent: 'request.submitted', actions: [{ type: 'create_task', config: { title: 'No event' } }] });
      await submit(c);
      await deliverOnly();
      const waiting = await onlyExecution(t, rule.id);
      await t.sys.outboxEvent.delete({ where: { id: waiting.eventId } });
      await t.settle();
      expect(await onlyExecution(t, rule.id)).toMatchObject({ status: 'DEAD_LETTER', attempts: 1, error: 'The event that started this automation is no longer available.' });
      expect(await t.sys.task.count({ where: { tenantId: c.tenant.id, title: 'No event' } })).toBe(0);
      expect((await inbox(c.tenant.owner)).some((n) => n.subject === 'Automation failed: Orphan')).toBe(true);
    });

    it('does nothing for a centre without the plan feature, even with an enabled rule in the database', async () => {
      const starter = await t.createTenant({ plan: 'starter' });
      const receptionist = await t.addStaff(starter, 'receptionist');
      const service = await createService(t, starter);
      const rule = await t.sys.automationRule.create({ data: { tenantId: starter.id, name: 'Smuggled in', triggerEvent: 'request.submitted', isEnabled: true, actions: [{ type: 'create_task', config: { title: 'Smuggled', priority: 'NORMAL', type: 'GENERAL' } }] } });
      await submit({ tenant: starter, receptionist, service });
      await t.settle();
      expect(await executionsOf(t, rule.id)).toEqual([]);
      expect(await t.sys.task.count({ where: { tenantId: starter.id, source: 'AUTOMATION' } })).toBe(0);
    });
  });
});
