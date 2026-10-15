import type { AddressInfo } from 'node:net';
import { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { signPayload } from '../../common/crypto';
import { localParts } from '../appointments/slots';
import { makeCustomer } from '../notifications/fixtures';
import { QueueService } from './queue.service';

const TZ = 'Asia/Dubai';

describe('Walk-in queue', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let receptionist: Actor;
  let operator: Actor;
  const today = () => localParts(new Date(), TZ).date;
  const issue = (actor: Actor, body: Record<string, unknown>) => t.as(actor).post('/queue/tokens', body);
  const newBranch = async (tenant: TenantFixture, code: string) => (await t.as(tenant.owner).post('/branches', { code, name: `Branch ${code}` }).expect(201)).body as { id: string };

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    receptionist = await t.addStaff(alpha, 'receptionist');
    operator = await t.addStaff(alpha, 'operator');
    await t.settle();
  });
  afterAll(() => t.close());

  describe('tokens', () => {
    it('issues gap-free tokens per branch and day with a letter for the service category', async () => {
      const categories = await t.sys.serviceCategory.findMany({ where: { tenantId: alpha.id }, orderBy: { sortOrder: 'asc' } });
      const customer = await makeCustomer(t, alpha, { fullName: 'Fatima Al Mansoori' });
      const first = await issue(receptionist, { branchId: alpha.headOfficeId }).expect(201);
      expect(first.body).toMatchObject({ tokenNo: 'W-001', status: 'WAITING', branchId: alpha.headOfficeId, queueDate: today(), categoryId: null, customerId: null, counter: null });
      const second = await issue(receptionist, { branchId: alpha.headOfficeId, categoryId: categories[0].id, customerId: customer.id }).expect(201);
      expect(second.body).toMatchObject({ tokenNo: 'A-002', categoryName: categories[0].name, customerId: customer.id, customerName: 'Fatima Al Mansoori' });
      const third = await issue(receptionist, { branchId: alpha.headOfficeId, categoryId: categories[2].id }).expect(201);
      expect(third.body.tokenNo).toBe('C-003');

      // Another branch has its own numbering.
      const second_branch = await newBranch(alpha, 'Q2');
      expect((await issue(receptionist, { branchId: second_branch.id }).expect(201)).body.tokenNo).toBe('W-001');

      const list = await t.as(receptionist).get(`/queue/tokens?branchId=${alpha.headOfficeId}`).expect(200);
      expect(list.body).toMatchObject({ date: today(), summary: { waiting: 3, called: 0, serving: 0, completed: 0, noShow: 0, cancelled: 0 } });
      expect(list.body.tokens.map((x: any) => x.tokenNo)).toEqual(['W-001', 'A-002', 'C-003']);
      expect((await t.as(receptionist).get(`/queue/tokens?branchId=${alpha.headOfficeId}&categoryId=${categories[0].id}`).expect(200)).body.tokens).toHaveLength(1);
      expect((await t.as(receptionist).get(`/queue/tokens?branchId=${alpha.headOfficeId}&date=2020-01-01`).expect(200)).body.tokens).toHaveLength(0);
    });

    it('numbers concurrent requests without gaps or duplicates', async () => {
      const branch = await newBranch(alpha, 'Q3');
      const results = await Promise.all(Array.from({ length: 8 }, () => issue(receptionist, { branchId: branch.id })));
      expect(results.every((r) => r.status === 201)).toBe(true);
      expect(results.map((r) => r.body.tokenNo).sort()).toEqual(['W-001', 'W-002', 'W-003', 'W-004', 'W-005', 'W-006', 'W-007', 'W-008']);
    });

    it('validates references and permissions', async () => {
      await issue(operator, { branchId: alpha.headOfficeId }).expect(403); // no queue.manage
      await t.as(operator).get(`/queue/tokens?branchId=${alpha.headOfficeId}`).expect(403);
      await t.as(null).get(`/queue/tokens?branchId=${alpha.headOfficeId}`).expect(401);
      await issue(receptionist, {}).expect(400);
      await issue(receptionist, { branchId: alpha.headOfficeId, categoryId: '00000000-0000-4000-8000-000000000000' }).expect(404);
      await issue(receptionist, { branchId: alpha.headOfficeId, customerId: '00000000-0000-4000-8000-000000000000' }).expect(404);
      const appointment = await t.sys.appointment.create({ data: { tenantId: alpha.id, branchId: alpha.headOfficeId, guestName: 'Visitor', startsAt: new Date(), endsAt: new Date(Date.now() + 1800_000), status: 'BOOKED' } });
      expect((await issue(receptionist, { branchId: alpha.headOfficeId, appointmentId: appointment.id }).expect(409)).body.code).toBe('APPOINTMENT_NOT_CHECKED_IN');
    });
  });

  describe('calling and serving', () => {
    it('calls the longest-waiting token, supports a category filter and never gives two counters the same token', async () => {
      const branch = await newBranch(alpha, 'Q4');
      const categories = await t.sys.serviceCategory.findMany({ where: { tenantId: alpha.id }, orderBy: { sortOrder: 'asc' } });
      const tokens = [];
      for (const categoryId of [null, categories[1].id, null, null, categories[1].id]) tokens.push((await issue(receptionist, { branchId: branch.id, categoryId }).expect(201)).body);
      expect(tokens.map((x) => x.tokenNo)).toEqual(['W-001', 'B-002', 'W-003', 'W-004', 'B-005']);

      const filtered = await t.as(receptionist).post('/queue/call-next', { branchId: branch.id, counter: '3', categoryId: categories[1].id }).expect(200);
      expect(filtered.body.token).toMatchObject({ tokenNo: 'B-002', status: 'CALLED', counter: '3', servedById: receptionist.membershipId });
      expect(filtered.body.token.calledAt).toBeTruthy();

      // Two counters press "next" at the same moment.
      const [one, two] = await Promise.all([
        t.as(receptionist).post('/queue/call-next', { branchId: branch.id, counter: '1' }),
        t.as(alpha.owner).post('/queue/call-next', { branchId: branch.id, counter: '2' }),
      ]);
      expect(one.status).toBe(200);
      expect(two.status).toBe(200);
      expect([one.body.token.tokenNo, two.body.token.tokenNo].sort()).toEqual(['W-001', 'W-003']);

      expect((await t.as(receptionist).post('/queue/call-next', { branchId: branch.id, counter: '1' }).expect(200)).body.token.tokenNo).toBe('W-004');
      expect((await t.as(receptionist).post('/queue/call-next', { branchId: branch.id, counter: '1' }).expect(200)).body.token.tokenNo).toBe('B-005');
      expect((await t.as(receptionist).post('/queue/call-next', { branchId: branch.id, counter: '1' }).expect(200)).body).toEqual({ token: null, message: 'Nobody is waiting.' });
      await t.as(receptionist).post('/queue/call-next', { branchId: branch.id }).expect(400); // counter is required
    });

    it('recalls, serves, completes, cancels and records no-shows, refusing invalid steps', async () => {
      const branch = await newBranch(alpha, 'Q5');
      const [a, b, c, d] = [
        (await issue(receptionist, { branchId: branch.id }).expect(201)).body,
        (await issue(receptionist, { branchId: branch.id }).expect(201)).body,
        (await issue(receptionist, { branchId: branch.id }).expect(201)).body,
        (await issue(receptionist, { branchId: branch.id }).expect(201)).body,
      ];
      const act = (id: string, action: string, body?: object) => t.as(receptionist).post(`/queue/tokens/${id}/${action}`, body);
      // A waiting token cannot be served or completed before it was called.
      for (const action of ['start', 'complete', 'recall', 'no-show']) expect((await act(a.id, action).expect(409)).body.code).toBe('INVALID_TRANSITION');

      await t.as(receptionist).post('/queue/call-next', { branchId: branch.id, counter: '1' }).expect(200);
      const recalled = await act(a.id, 'recall', { counter: '2' }).expect(200);
      expect(recalled.body).toMatchObject({ status: 'CALLED', counter: '2' });
      expect((await act(a.id, 'start').expect(200)).body).toMatchObject({ status: 'SERVING' });
      await act(a.id, 'recall').expect(409);
      const done = await act(a.id, 'complete').expect(200);
      expect(done.body.status).toBe('COMPLETED');
      expect(done.body.completedAt).toBeTruthy();
      for (const action of ['start', 'complete', 'cancel', 'no-show']) await act(a.id, action).expect(409);

      await t.as(receptionist).post('/queue/call-next', { branchId: branch.id, counter: '1' }).expect(200); // b
      expect((await act(b.id, 'no-show').expect(200)).body.status).toBe('NO_SHOW');
      expect((await act(c.id, 'cancel').expect(200)).body.status).toBe('CANCELLED'); // left before being called
      await t.as(receptionist).post('/queue/call-next', { branchId: branch.id, counter: '2' }).expect(200); // d (c was cancelled)
      expect((await act(d.id, 'complete').expect(200)).body.status).toBe('COMPLETED'); // quick service without "start"
      await act('00000000-0000-4000-8000-000000000000', 'start').expect(404);

      const list = await t.as(receptionist).get(`/queue/tokens?branchId=${branch.id}`).expect(200);
      expect(list.body.summary).toEqual({ waiting: 0, called: 0, serving: 0, completed: 2, noShow: 1, cancelled: 1 });
      expect((await t.as(receptionist).get(`/queue/tokens?branchId=${branch.id}&status=NO_SHOW`).expect(200)).body.tokens.map((x: any) => x.tokenNo)).toEqual([b.tokenNo]);
      const counters = await t.as(receptionist).get(`/queue/counters?branchId=${branch.id}`).expect(200);
      expect(counters.body.counters).toEqual([
        { counter: '1', current: null, servedToday: 0, noShowsToday: 1 },
        { counter: '2', current: null, servedToday: 2, noShowsToday: 0 },
      ]);
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: { in: ['queue.token_no_show', 'queue.token_cancelled'] }, resourceId: { in: [b.id, c.id] } } })).toBe(2);
    });

    it('shows who is at each counter', async () => {
      const branch = await newBranch(alpha, 'Q6');
      await issue(receptionist, { branchId: branch.id }).expect(201);
      await issue(receptionist, { branchId: branch.id }).expect(201);
      const first = (await t.as(receptionist).post('/queue/call-next', { branchId: branch.id, counter: 'Desk A' }).expect(200)).body.token;
      await t.as(receptionist).post(`/queue/tokens/${first.id}/start`).expect(200);
      await t.as(receptionist).post('/queue/call-next', { branchId: branch.id, counter: 'Desk B' }).expect(200);
      const counters = (await t.as(receptionist).get(`/queue/counters?branchId=${branch.id}`).expect(200)).body.counters;
      expect(counters.map((c: any) => [c.counter, c.current.tokenNo, c.current.status])).toEqual([['Desk A', 'W-001', 'SERVING'], ['Desk B', 'W-002', 'CALLED']]);
      expect(counters[0].current.servedByName).toContain('receptionist');
    });
  });

  describe('public display', () => {
    let branch: { id: string };
    let display: { token: string; displayUrl: string; streamUrl: string; expiresAt: string };
    const personal = { fullName: 'Confidential Person', phone: '+971509998877', email: 'confidential.person@example.test' };

    beforeAll(async () => {
      branch = await newBranch(alpha, 'Q7');
      const customer = await makeCustomer(t, alpha, personal);
      const categories = await t.sys.serviceCategory.findMany({ where: { tenantId: alpha.id }, orderBy: { sortOrder: 'asc' } });
      for (let i = 0; i < 4; i++) await issue(receptionist, { branchId: branch.id, customerId: customer.id, categoryId: categories[3].id }).expect(201);
      const called = (await t.as(receptionist).post('/queue/call-next', { branchId: branch.id, counter: '5' }).expect(200)).body.token;
      await t.as(receptionist).post(`/queue/tokens/${called.id}/start`).expect(200);
      await t.as(receptionist).post('/queue/call-next', { branchId: branch.id, counter: '6' }).expect(200);
      display = (await t.as(receptionist).post('/queue/display-tokens', { branchId: branch.id }).expect(201)).body;
    });

    it('issues a signed long-lived link to staff only', async () => {
      expect(display.token).toEqual(expect.any(String));
      expect(display.displayUrl).toContain('/api/v1/public/queue/display?token=');
      expect(new Date(display.expiresAt).getTime()).toBeGreaterThan(Date.now() + 89 * 86_400_000);
      await t.as(operator).post('/queue/display-tokens', { branchId: branch.id }).expect(403);
      await t.as(null).post('/queue/display-tokens', { branchId: branch.id }).expect(401);
      await t.as(receptionist).post('/queue/display-tokens', { branchId: branch.id, validDays: 1000 }).expect(400);
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'queue.display_token_issued', resourceId: branch.id } })).toBe(1);
    });

    it('shows only token numbers, counters and statuses: nothing personal', async () => {
      const res = await t.http.get(`/api/v1/public/queue/display?token=${encodeURIComponent(display.token)}`).expect(200);
      expect(Object.keys(res.body).sort()).toEqual(['branch', 'date', 'generatedAt', 'language', 'nextUp', 'nowServing', 'waitingCount']);
      expect(res.body.branch).toEqual({ name: 'Branch Q7', nameAr: null });
      expect(res.body.nowServing).toEqual([
        { tokenNo: 'D-002', counter: '6', status: 'CALLED' },
        { tokenNo: 'D-001', counter: '5', status: 'SERVING' },
      ]);
      expect(res.body.nextUp).toEqual(['D-003', 'D-004']);
      expect(res.body.waitingCount).toBe(2);
      expect(res.body.language).toBe('en');
      for (const entry of res.body.nowServing) expect(Object.keys(entry).sort()).toEqual(['counter', 'status', 'tokenNo']);

      // No personal data, ids or service names anywhere in the payload.
      const text = JSON.stringify(res.body);
      for (const secret of [personal.fullName, 'Confidential', personal.phone, '9998877', personal.email, 'customer', 'servedBy', 'categor', 'Emirates ID', receptionist.userId, alpha.id, branch.id]) expect(text).not.toContain(secret);
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/); // no ids at all
    });

    it('rejects missing, forged, foreign and revoked display tokens', async () => {
      await t.http.get('/api/v1/public/queue/display').expect(400);
      expect((await t.http.get(`/api/v1/public/queue/display?token=${encodeURIComponent(`${display.token}x`)}`).expect(401)).body.code).toBe('DISPLAY_TOKEN_INVALID');
      // A correctly signed token of another kind is not a display token.
      const other = signPayload({ k: 'something-else', t: alpha.id, b: branch.id }, 600);
      await t.http.get(`/api/v1/public/queue/display?token=${encodeURIComponent(other)}`).expect(401);
      const expired = signPayload({ k: 'queue-display', t: alpha.id, b: branch.id, v: 1 }, -10);
      await t.http.get(`/api/v1/public/queue/display?token=${encodeURIComponent(expired)}`).expect(401);
      // A token for a branch that is not in the token's tenant shows nothing.
      const crossed = signPayload({ k: 'queue-display', t: beta.id, b: branch.id, v: 1 }, 600);
      await t.http.get(`/api/v1/public/queue/display?token=${encodeURIComponent(crossed)}`).expect(401);

      const second = (await t.as(receptionist).post('/queue/display-tokens', { branchId: branch.id, validDays: 1 }).expect(201)).body;
      await t.http.get(`/api/v1/public/queue/display?token=${encodeURIComponent(second.token)}`).expect(200);
      await t.as(operator).post('/queue/display-tokens/revoke', { branchId: branch.id }).expect(403);
      await t.as(receptionist).post('/queue/display-tokens/revoke', { branchId: branch.id }).expect(200);
      await t.http.get(`/api/v1/public/queue/display?token=${encodeURIComponent(second.token)}`).expect(401);
      await t.http.get(`/api/v1/public/queue/display?token=${encodeURIComponent(display.token)}`).expect(401);
      display = (await t.as(receptionist).post('/queue/display-tokens', { branchId: branch.id }).expect(201)).body;
      await t.http.get(`/api/v1/public/queue/display?token=${encodeURIComponent(display.token)}`).expect(200);
    });

    it('streams updates over Server-Sent Events and cleans up when the screen disconnects', async () => {
      const server = t.app.getHttpServer();
      if (!server.listening) await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;
      const queue = t.get(QueueService);
      const before = queue.activeStreams;

      const abort = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/public/queue/display/stream?token=${encodeURIComponent(display.token)}`, { signal: abort.signal, headers: { accept: 'text/event-stream' } });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      /** Reads until the next complete "queue" event and returns its JSON payload. */
      const nextEvent = async (): Promise<any> => {
        for (;;) {
          const match = buffer.match(/event: queue\ndata: (.*)\n\n/);
          if (match) {
            buffer = buffer.slice(match.index! + match[0].length);
            return JSON.parse(match[1]);
          }
          const { value, done } = await reader.read();
          if (done) throw new Error('stream ended');
          buffer += decoder.decode(value, { stream: true });
        }
      };

      const first = await nextEvent();
      expect(first.nextUp).toEqual(['D-003', 'D-004']);
      expect(first.waitingCount).toBe(2);
      expect(Object.keys(first).sort()).toEqual(['branch', 'date', 'generatedAt', 'language', 'nextUp', 'nowServing', 'waitingCount']);
      expect(queue.activeStreams).toBe(before + 1);

      // A change at the counter reaches the screen.
      await issue(receptionist, { branchId: branch.id }).expect(201);
      const second = await nextEvent();
      expect(second.waitingCount).toBe(3);
      expect(second.nextUp).toEqual(['D-003', 'D-004', 'W-005']);

      abort.abort();
      await reader.cancel().catch(() => undefined);
      for (let i = 0; i < 40 && queue.activeStreams > before; i++) await new Promise((r) => setTimeout(r, 50));
      expect(queue.activeStreams).toBe(before);

      // An invalid link never opens a stream.
      const bad = await fetch(`http://127.0.0.1:${port}/api/v1/public/queue/display/stream?token=${encodeURIComponent(`${display.token}x`)}`);
      expect(bad.status).toBe(401);
      await bad.text();
      expect(queue.activeStreams).toBe(before);
    });
  });

  describe('waiting-time statistics', () => {
    it('reports average, median and 90th percentile waits, service times, tokens per hour and the no-show rate', async () => {
      const branch = await newBranch(alpha, 'Q8');
      const date = today();
      const base = new Date(`${date}T06:00:00.000Z`).getTime(); // 10:00 in Dubai
      const seed = (n: number, issuedMinute: number, status: string, waitSeconds: number | null, serviceSeconds: number | null) => {
        const issuedAt = new Date(base + issuedMinute * 60_000);
        const calledAt = waitSeconds === null ? null : new Date(issuedAt.getTime() + waitSeconds * 1000);
        const servedAt = serviceSeconds === null || !calledAt ? null : new Date(calledAt.getTime() + 30_000);
        const completedAt = servedAt ? new Date(servedAt.getTime() + serviceSeconds! * 1000) : status === 'NO_SHOW' || status === 'CANCELLED' ? new Date(issuedAt.getTime() + 900_000) : null;
        return t.sys.queueToken.create({ data: { tenantId: alpha.id, branchId: branch.id, queueDate: new Date(`${date}T00:00:00Z`), tokenNo: `W-${String(n).padStart(3, '0')}`, status: status as any, issuedAt, calledAt, servedAt, completedAt, counter: calledAt ? '1' : null } });
      };
      await seed(1, 0, 'COMPLETED', 60, 300);
      await seed(2, 5, 'COMPLETED', 120, 600);
      await seed(3, 10, 'NO_SHOW', 180, null);
      await seed(4, 70, 'CALLED', 240, null); // 11:10
      await seed(5, 75, 'NO_SHOW', 600, null);
      await seed(6, 80, 'CANCELLED', null, null);
      await seed(7, 130, 'WAITING', null, null); // 12:10

      const res = await t.as(receptionist).get(`/queue/stats?branchId=${branch.id}&from=${date}&to=${date}`).expect(200);
      expect(res.body).toMatchObject({
        branchId: branch.id,
        from: date,
        to: date,
        timezone: TZ,
        tokens: { total: 7, completed: 2, noShows: 2, cancelled: 1, daysWithTokens: 1 },
        waitSeconds: { average: 240, median: 180, p90: 456 },
        serviceSeconds: { average: 450, median: 450, p90: 570 },
        noShowRate: 0.333,
      });
      expect(res.body.tokensPerHour).toEqual([
        { hour: 10, count: 3, averagePerDay: 3 },
        { hour: 11, count: 3, averagePerDay: 3 },
        { hour: 12, count: 1, averagePerDay: 1 },
      ]);
      // An empty period is reported with nulls, not zeros.
      const empty = await t.as(receptionist).get(`/queue/stats?branchId=${branch.id}&from=2020-01-01&to=2020-01-31`).expect(200);
      expect(empty.body).toMatchObject({ tokens: { total: 0 }, waitSeconds: { average: null, median: null, p90: null }, noShowRate: 0, tokensPerHour: [] });
      await t.as(receptionist).get(`/queue/stats?branchId=${branch.id}&from=${date}&to=2020-01-01`).expect(400);
      // The default period is the last 30 days.
      expect((await t.as(receptionist).get(`/queue/stats?branchId=${branch.id}`).expect(200)).body.tokens.total).toBe(7);
      const accountant = await t.addStaff(alpha, 'accountant'); // report.operational
      await t.as(accountant).get(`/queue/stats?branchId=${branch.id}`).expect(200);
      await t.as(operator).get(`/queue/stats?branchId=${branch.id}`).expect(403);
    });
  });

  describe('branch scope and tenant isolation', () => {
    it('limits branch staff to their own branch', async () => {
      const other = await newBranch(alpha, 'Q9');
      const clerk = await t.addStaff(alpha, 'receptionist', { branchIds: [other.id] });
      const mainToken = (await issue(receptionist, { branchId: alpha.headOfficeId }).expect(201)).body;
      expect((await issue(clerk, { branchId: alpha.headOfficeId }).expect(403)).body.code).toBe('BRANCH_FORBIDDEN');
      await t.as(clerk).get(`/queue/tokens?branchId=${alpha.headOfficeId}`).expect(403);
      await t.as(clerk).post('/queue/call-next', { branchId: alpha.headOfficeId, counter: '1' }).expect(403);
      await t.as(clerk).post(`/queue/tokens/${mainToken.id}/cancel`).expect(403);
      await t.as(clerk).get(`/queue/stats?branchId=${alpha.headOfficeId}`).expect(403);
      await t.as(clerk).post('/queue/display-tokens', { branchId: alpha.headOfficeId }).expect(403);
      expect((await issue(clerk, { branchId: other.id }).expect(201)).body.tokenNo).toBe('W-001');
    });

    it('never lets tenant B see or change tenant A queues', async () => {
      const token = (await issue(receptionist, { branchId: alpha.headOfficeId }).expect(201)).body;
      const betaCustomer = await makeCustomer(t, beta);
      await issue(beta.owner, { branchId: alpha.headOfficeId }).expect(404);
      await issue(receptionist, { branchId: alpha.headOfficeId, customerId: betaCustomer.id }).expect(404);
      await t.as(beta.owner).get(`/queue/tokens?branchId=${alpha.headOfficeId}`).expect(404);
      await t.as(beta.owner).post('/queue/call-next', { branchId: alpha.headOfficeId, counter: '1' }).expect(404);
      for (const action of ['recall', 'start', 'complete', 'no-show', 'cancel']) await t.as(beta.owner).post(`/queue/tokens/${token.id}/${action}`).expect(404);
      await t.as(beta.owner).get(`/queue/counters?branchId=${alpha.headOfficeId}`).expect(404);
      await t.as(beta.owner).get(`/queue/stats?branchId=${alpha.headOfficeId}`).expect(404);
      await t.as(beta.owner).post('/queue/display-tokens', { branchId: alpha.headOfficeId }).expect(404);
      await t.as(beta.owner).post('/queue/display-tokens/revoke', { branchId: alpha.headOfficeId }).expect(404);

      // Beta's own numbering starts at 1 on the same day.
      expect((await issue(beta.owner, { branchId: beta.headOfficeId }).expect(201)).body.tokenNo).toBe('W-001');
      const seen = await t.inTenant(beta.id, () => t.db.tx((tx) => tx.queueToken.findMany({ select: { tenantId: true } })));
      expect(seen.length).toBe(1);
      expect(seen.every((r) => r.tenantId === beta.id)).toBe(true);
      expect((await t.sys.queueToken.findUniqueOrThrow({ where: { id: token.id } })).status).toBe('WAITING');
    });
  });
});
