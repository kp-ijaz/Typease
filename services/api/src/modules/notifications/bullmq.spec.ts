import { Queue, Worker } from 'bullmq';
import type Redis from 'ioredis';
import { TenantFixture, TestApp } from '../../../test/helpers';
import { DomainEvents } from '../../common/events.service';
import { QUEUE_NAME } from '../../common/jobs/job-queue';
import { RedisService } from '../../common/redis';
import { emit, makeCustomer, makeIntegration, makeRequest, TestSmtp } from './fixtures';
import { DELIVER_ATTEMPTS, DELIVER_JOB } from './notification.service';

/**
 * One real BullMQ round trip on the private Redis database: the delivery job
 * is added with the same options the JobQueue uses in production (attempts +
 * exponential backoff), fails once against a real SMTP server and is retried
 * by BullMQ itself. Tests otherwise use the inline driver.
 */
describe('Notifications on BullMQ (real Redis queue)', () => {
  let t: TestApp;
  let tenant: TenantFixture;
  let smtp: TestSmtp;
  let queue: Queue;
  let worker: Worker;
  const connections: Redis[] = [];
  const name = `${QUEUE_NAME}-b4-test-${Date.now()}`;

  beforeAll(async () => {
    t = await TestApp.create();
    tenant = await t.createTenant({ name: 'Queue Typing' });
    smtp = await new TestSmtp().start();
    await makeIntegration(t, tenant.id, 'EMAIL', 'smtp', { host: '127.0.0.1', port: smtp.port, secure: false }, {});
    await t.settle();
    const redis = t.get(RedisService);
    connections.push(redis.duplicateForQueue(), redis.duplicateForQueue());
    queue = new Queue(name, { connection: connections[0] });
    // The same execution path the worker service uses: JobQueue.execute with BullMQ's attempt counters.
    worker = new Worker(name, (job) => t.jobs.execute(job.name, job.data, { attempt: job.attemptsMade + 1, maxAttempts: job.opts.attempts ?? 1, jobId: job.id }), { connection: connections[1] });
    await worker.waitUntilReady();
  });
  afterAll(async () => {
    await worker.close();
    await queue.obliterate({ force: true });
    await queue.close();
    // BullMQ does not close connections it was handed: do it here so nothing is left open.
    await Promise.all(connections.map((c) => c.quit().catch(() => undefined)));
    await smtp.stop();
    await t.close();
  });

  it('retries a failed delivery with backoff and sends exactly once', async () => {
    const customer = await makeCustomer(t, tenant, { fullName: 'Queue Customer', phone: null });
    const request = await makeRequest(t, tenant, customer.id);
    const eventId = await emit(t, tenant.id, 'request.completed', { requestId: request.id, customerId: customer.id });
    await t.get(DomainEvents).dispatch();
    t.jobs.clearInline(); // BullMQ, not the inline driver, runs this delivery
    const n = await t.sys.notification.findFirstOrThrow({ where: { tenantId: tenant.id, dedupeKey: { startsWith: `${eventId}:EMAIL` } } });
    expect(n.status).toBe('QUEUED');

    smtp.behaviour = [451];
    const failures: number[] = [];
    worker.on('failed', (job) => failures.push(job?.attemptsMade ?? 0));
    const completed = new Promise<{ attemptsMade: number; finishedOn?: number; processedOn?: number }>((resolve) => worker.on('completed', (job) => resolve(job)));
    const started = Date.now();
    await queue.add(DELIVER_JOB, { tenantId: tenant.id, notificationId: n.id }, { attempts: DELIVER_ATTEMPTS, backoff: { type: 'exponential', delay: 300 }, jobId: `notif-${n.id}` });
    // Same id = same job: an identical second enqueue is ignored by BullMQ.
    await queue.add(DELIVER_JOB, { tenantId: tenant.id, notificationId: n.id }, { attempts: DELIVER_ATTEMPTS, backoff: { type: 'exponential', delay: 300 }, jobId: `notif-${n.id}` });
    const job = await completed;

    expect(job.attemptsMade).toBe(2);
    expect(failures).toEqual([1]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300); // the retry waited for the backoff
    const after = await t.sys.notification.findUniqueOrThrow({ where: { id: n.id }, include: { notificationDeliveries: { orderBy: { attempt: 'asc' } } } });
    expect(after.status).toBe('SENT');
    expect(after.notificationDeliveries.map((d) => d.status)).toEqual(['FAILED', 'SENT']);
    expect(smtp.messages.filter((m) => m.to.includes(customer.email!))).toHaveLength(1);
    expect(await queue.getJobCountByTypes('waiting', 'delayed', 'active', 'failed')).toBe(0);
  });
});
