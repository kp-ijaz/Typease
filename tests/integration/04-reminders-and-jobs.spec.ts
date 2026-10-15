import { TestSmtp } from '../../services/api/src/modules/notifications/fixtures';
import { Actor, allowOperatorHost, api, Centre, dubaiDay, expectRefused, inviteStaff, mailTo, pdf, registerPortalCustomer, runScheduledJob, signUpCentre, TestApp, uniq, uploadDocument } from '../support';

/**
 * Scenario 19 (the reminder job runs) and scenario 27 (a failed notification is
 * retried safely): what happens when nobody clicks anything - the worker's side
 * of the system. Jobs run through the same queue facade the worker uses
 * (`inline` driver: executed when the test settles).
 */
describe('Reminders and background jobs (scenarios 19 and 27)', () => {
  let t: TestApp;
  let centre: Centre;
  let receptionist: Actor;
  let reviewer: Actor;
  const id = uniq();

  beforeAll(async () => {
    t = await TestApp.create();
    centre = await signUpCentre(t, { name: `Reminder Centre ${id}` });
    receptionist = await inviteStaff(t, centre, 'receptionist');
    reviewer = await inviteStaff(t, centre, 'reviewer');
    await t.settle();
  });
  afterAll(() => t.close());

  /** A customer uploads a passport to their vault and the reviewer confirms its expiry date. */
  async function customerWithVerifiedPassport(expiryDate: string, opts: { consent: boolean }) {
    const email = `expiry-${uniq()}@example.test`;
    const customer = await registerPortalCustomer(t, centre, { fullName: `Passport Holder ${uniq()}`, email });
    if (opts.consent) await api(t, customer).put('/me/consents', { consents: [{ purpose: 'REMINDERS', granted: true }] });
    const doc = await uploadDocument(t, customer, { documentTypeKey: 'passport', expiryDate }, pdf('passport', 'passport.pdf'));
    await api(t, reviewer).post(`/documents/${doc.documentId}/verify`, { decision: 'APPROVED', expiryDate });
    await t.settle();
    return { customer, email, documentId: doc.documentId };
  }
  const schedulesOf = async (customerId: string) => (await api(t, receptionist).get(`/reminders?customerId=${customerId}&includeExpired=true`)).data as any[];
  const expiryMessages = async (customer: Actor) => ((await api(t, customer).get('/me/notifications?pageSize=100')).data as any[]).filter((n) => n.eventKey === 'document.expiry');

  it('S19 reminder job runs', async () => {
    const expiry = dubaiDay(30);
    const { customer, email, documentId } = await customerWithVerifiedPassport(expiry, { consent: true });
    const silent = await customerWithVerifiedPassport(expiry, { consent: false });

    // Verifying a document with an expiry date started a reminder schedule - nobody created it by hand.
    const [schedule] = await schedulesOf(customer.customerId!);
    expect(schedule).toMatchObject({ documentId, documentTypeKey: 'passport', expiryDate: expiry, daysLeft: 30, status: 'ACTIVE', lastReminderAt: null });
    expect(schedule.offsetsDays).toEqual(expect.arrayContaining([30, 15, 7]));
    expect(schedule.nextReminderOn).toBe(dubaiDay(0));
    expect(await expiryMessages(customer)).toHaveLength(0);
    const upcoming = await api(t, receptionist).get('/reminders?withinDays=30');
    expect(upcoming.data.map((s: any) => s.id)).toEqual(expect.arrayContaining([schedule.id]));
    // The customer sees their own reminder, with the way to start the renewal.
    const mine = await api(t, customer).get('/me/reminders');
    expect(mine.data.map((s: any) => s.id)).toEqual([schedule.id]);

    // --- the daily job runs (it is on the scheduler's list; here it is triggered instead of waiting for 04:00 UTC)
    await runScheduledJob(t, 'reminders.scan');

    // One reminder went out - the one closest to the expiry date; older offsets that were also due are closed, not sent.
    const after = await api(t, receptionist).get(`/reminders/${schedule.id}`);
    const byOffset = Object.fromEntries((after.dispatches as any[]).map((d) => [d.offsetDays, d.status]));
    expect(byOffset[30]).toBe('SENT');
    for (const older of (schedule.offsetsDays as number[]).filter((o) => o > 30)) expect(byOffset[older]).toBe('CANCELLED');
    expect(byOffset[15]).toBeUndefined();
    expect(after.lastReminderAt).toBeTruthy();
    const inbox = await expiryMessages(customer);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ relatedType: 'ReminderSchedule', relatedId: schedule.id });
    const log = await api(t, centre.owner).get(`/notifications?customerId=${customer.customerId}&eventKey=document.expiry&pageSize=100`);
    const emails = log.data.filter((n: any) => n.channel === 'EMAIL');
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({ status: 'SENT', recipientAddress: email });
    expect(mailTo(email).filter((m) => m.subject === emails[0].subject)).toHaveLength(1);
    // The dispatch knows which notification it produced.
    expect((after.dispatches as any[]).find((d) => d.offsetDays === 30).notificationId).toBeTruthy();

    // No consent for reminders: the job records why nothing was sent, and nothing was sent.
    const [quiet] = await schedulesOf(silent.customer.customerId!);
    const quietDetail = await api(t, receptionist).get(`/reminders/${quiet.id}`);
    expect((quietDetail.dispatches as any[]).find((d) => d.offsetDays === 30).status).toBe('SKIPPED_NO_CONSENT');
    expect(await expiryMessages(silent.customer)).toHaveLength(0);
    expect(mailTo(silent.email).filter((m) => m.subject === emails[0].subject)).toHaveLength(0);

    // --- the job runs again the same day (a restart, a second worker): nobody is reminded twice
    await runScheduledJob(t, 'reminders.scan');
    await runScheduledJob(t, 'reminders.scan');
    expect(await expiryMessages(customer)).toHaveLength(1);
    expect(mailTo(email).filter((m) => m.subject === emails[0].subject)).toHaveLength(1);
    expect(((await api(t, receptionist).get(`/reminders/${schedule.id}`)).dispatches as any[]).filter((d) => d.status === 'SENT')).toHaveLength(1);

    // --- fifteen days later (the job's own "today" parameter, made for back-fills): the next reminder, once
    await runScheduledJob(t, 'reminders.scan', { today: dubaiDay(15) });
    await runScheduledJob(t, 'reminders.scan', { today: dubaiDay(15) });
    expect(await expiryMessages(customer)).toHaveLength(2);
    const later = await api(t, receptionist).get(`/reminders/${schedule.id}`);
    expect(Object.fromEntries((later.dispatches as any[]).map((d) => [d.offsetDays, d.status]))).toMatchObject({ 30: 'SENT', 15: 'SENT' });

    // --- the customer starts the renewal from the reminder; the centre sees that it is in hand
    const link = await api(t, receptionist).post(`/reminders/${schedule.id}/renewal-link`, {}, [200, 201]);
    expect(link.link).toContain(schedule.id);
    const renewal = await api(t, customer).post('/requests', { serviceId: centre.firstService.id, renewalOfScheduleId: schedule.id }, 201);
    expect((await api(t, receptionist).get(`/reminders/${schedule.id}`)).renewalRequestId).toBe(renewal.id);
    // Somebody else's reminder cannot be used for a request.
    expectRefused(await api(t, silent.customer).req('POST', '/requests', { serviceId: centre.firstService.id, renewalOfScheduleId: schedule.id }), 404);

    // --- after the expiry date the schedule is closed and nothing further is sent
    await runScheduledJob(t, 'reminders.scan', { today: dubaiDay(31) });
    const closed = await api(t, receptionist).get(`/reminders/${schedule.id}`);
    expect(closed.status).toBe('COMPLETED');
    expect((closed.dispatches as any[]).filter((d) => d.status === 'SENT')).toHaveLength(2);
    expect(await expiryMessages(customer)).toHaveLength(2);
  });

  it('S19 every scheduled job is registered, runs, and can run twice in a row', async () => {
    const schedules = t.jobs.schedules();
    const names = schedules.map((s) => s.name);
    // The jobs the specification relies on are on the worker's schedule.
    expect(names).toEqual(expect.arrayContaining(['reminders.scan', 'workflows.scan', 'documents.purge', 'finance.quotations.expire', 'finance.expire_checkouts', 'notifications.maintenance', 'subscriptions.lifecycle', 'reports.scheduled']));
    expect(new Set(names).size).toBe(names.length);
    for (const s of schedules) expect(Boolean(s.cron) || Boolean(s.everySeconds)).toBe(true);

    // Handlers must be idempotent ("a job can run twice"): run each one twice against the data of this suite.
    const failures: string[] = [];
    for (const name of names) {
      for (const round of [1, 2]) {
        try {
          await t.jobs.execute(name, {}, { attempt: 1, maxAttempts: 1 });
          await t.settle();
        } catch (e: any) {
          failures.push(`${name} (run ${round}): ${e?.message ?? e}`);
        }
      }
    }
    expect(failures).toEqual([]);
    // The centre is still operational and its data is where it was.
    expect((await api(t, centre.owner).get('/tenant')).status).toBe('TRIAL');
    await api(t, receptionist).get('/customers');
  });

  describe('S27', () => {
    let smtp: TestSmtp;
    let removeHost: () => void;
    let customer: Actor;
    const email = `retry-${id}@example.test`;

    beforeAll(async () => {
      // The centre sends its email through its own mail server: a real SMTP server on this machine that can be
      // told to refuse messages. The operator has to allow the (private) host first.
      smtp = await new TestSmtp().start();
      removeHost = allowOperatorHost('127.0.0.1');
      customer = await registerPortalCustomer(t, centre, { fullName: 'Retry Recipient', email });
      await t.settle();
      const owner = api(t, centre.owner);
      const integration = await owner.post('/integrations', { category: 'EMAIL', provider: 'smtp', config: { host: '127.0.0.1', port: smtp.port, secure: false, fromAddress: `hello-${id}@centre.example` }, secrets: { user: 'centre-mailer', password: 'centre-secret' } }, 201);
      const enabled = await owner.post(`/integrations/${integration.id}/enable`);
      expect(enabled.status).toBe('ACTIVE');
      const channels: any[] = await owner.get('/notifications/channels');
      expect(channels.find((c) => c.channel === 'EMAIL')).toMatchObject({ provider: 'smtp', source: 'TENANT', configured: true });
      expect(JSON.stringify(channels)).not.toContain('centre-secret');
    });
    afterAll(async () => {
      removeHost?.();
      await smtp?.stop();
    });

    const received = () => smtp.messages.filter((m) => m.to.includes(email));
    /** The customer does something that makes the centre write to them: starting a request. Returns the email notification. */
    async function triggerEmail(settleRounds = 6) {
      const draft = await api(t, customer).post('/requests', { serviceId: centre.firstService.id }, 201);
      await t.settle(settleRounds);
      const log = await api(t, centre.owner).get(`/notifications?customerId=${customer.customerId}&eventKey=request.created&pageSize=100`);
      const row = log.data.find((n: any) => n.channel === 'EMAIL' && n.relatedId === draft.id);
      if (!row) throw new Error('No email notification was created for the new request.');
      return { requestId: draft.id as string, requestNo: draft.requestNo as string, id: row.id as string };
    }
    const detail = (notificationId: string) => api(t, centre.owner).get(`/notifications/${notificationId}`);

    it('S27 failed notification is retried safely', async () => {
      // --- a temporary failure: the mail server says "try again later" once
      const before = received().length;
      const attemptsBefore = smtp.attempts;
      smtp.behaviour = [451];
      const first = await triggerEmail();

      const sent = await detail(first.id);
      expect(sent.status).toBe('SENT');
      expect((sent.deliveries as any[]).map((d) => d.status)).toEqual(['FAILED', 'SENT']);
      expect(smtp.attempts - attemptsBefore).toBe(2);
      // Exactly one message reached the mailbox, and it is the right one.
      expect(received().length - before).toBe(1);
      expect(received().at(-1)!.text).toContain(first.requestNo);
      expect(smtp.logins.at(-1)).toEqual({ username: 'centre-mailer', password: 'centre-secret' });

      // A duplicate or late delivery job for a notification that was sent must not send it again.
      await t.jobs.enqueue('notifications.deliver', { tenantId: centre.id, notificationId: first.id }, { jobId: `duplicate-${first.id}` });
      await t.jobs.execute('notifications.deliver', { tenantId: centre.id, notificationId: first.id }, { attempt: 1, maxAttempts: 5 });
      await t.settle();
      expect(received().length - before).toBe(1);
      expect(((await detail(first.id)).deliveries as any[]).filter((d) => d.status === 'SENT')).toHaveLength(1);
      // Something that was sent cannot be "retried" by hand either.
      expectRefused(await api(t, centre.owner).req('POST', `/notifications/${first.id}/retry`), 409, 'NOT_RETRYABLE');

      // --- the mail server stays down for every automatic attempt
      const beforeOutage = received().length;
      smtp.behaviour = [451, 451, 451, 451, 451];
      const second = await triggerEmail(12);
      const failed = await detail(second.id);
      expect(failed.status).toBe('FAILED');
      expect((failed.deliveries as any[]).every((d) => d.status === 'FAILED')).toBe(true);
      expect((failed.deliveries as any[]).length).toBeGreaterThanOrEqual(2);
      expect(received().length).toBe(beforeOutage);
      // The failure is visible to the centre, with the provider's reason.
      const failures = await api(t, centre.owner).get('/notifications/failures?channel=EMAIL');
      const entry = failures.data.find((n: any) => n.id === second.id);
      expect(entry).toMatchObject({ status: 'FAILED', recipientAddress: email });
      expect(entry.lastError).toBeTruthy();
      // The in-app copy of the same message was not affected by the mail outage.
      const inbox = await api(t, customer).get('/me/notifications?pageSize=100');
      expect(inbox.data.filter((n: any) => n.eventKey === 'request.created' && n.relatedId === second.requestId)).toHaveLength(1);

      // --- the server is back; the owner retries once: one message, and a second retry is refused
      expectRefused(await api(t, receptionist).req('POST', `/notifications/${second.id}/retry`), 403);
      const attemptsSoFar = (failed.deliveries as any[]).length;
      const retried = await api(t, centre.owner).post(`/notifications/${second.id}/retry`, {}, [200, 201]);
      expect(retried.status).toBe('QUEUED');
      await t.settle();
      const recovered = await detail(second.id);
      expect(recovered.status).toBe('SENT');
      expect((recovered.deliveries as any[]).filter((d) => d.status === 'SENT')).toHaveLength(1);
      expect(recovered.deliveries).toHaveLength(attemptsSoFar + 1);
      expect(received().length).toBe(beforeOutage + 1);
      expect(received().at(-1)!.text).toContain(second.requestNo);
      expectRefused(await api(t, centre.owner).req('POST', `/notifications/${second.id}/retry`), 409, 'NOT_RETRYABLE');
      await t.settle();
      expect(received().length).toBe(beforeOutage + 1);
      const audit = await api(t, centre.owner).get('/audit-logs?pageSize=100');
      expect(audit.data.filter((e: any) => e.action === 'notification.retried' && e.resourceId === second.id)).toHaveLength(1);
    });
  });
});
