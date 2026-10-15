import { Actor, TenantFixture, TestApp, uniq } from '../../../test/helpers';
import { emit, makeCustomer, setConsent } from '../notifications/fixtures';
import { LogProvider } from '../notifications/providers/log';
import { addDays, localDate } from './dates';
import { SCAN_JOB } from './reminders.service';

describe('Reminders (document expiry automation)', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let receptionist: Actor;
  const today = localDate(new Date(), 'Asia/Dubai');
  const inDays = (n: number) => addDays(today, n);

  const runScan = async (day = today) => {
    await t.jobs.execute(SCAN_JOB, { today: day }, { attempt: 1, maxAttempts: 1 });
    await t.settle();
  };
  const dispatches = (scheduleId: string) => t.sys.reminderDispatch.findMany({ where: { scheduleId }, orderBy: { offsetDays: 'desc' } });
  /** Notifications that were actually sent for a schedule (suppressed channels left out). */
  const expiryNotifications = (tenantId: string, scheduleId: string) =>
    t.sys.notification.findMany({ where: { tenantId, eventKey: 'document.expiry', relatedId: scheduleId, status: { not: 'SUPPRESSED' } }, orderBy: [{ createdAt: 'asc' }, { channel: 'asc' }] });
  const makeDocument = (tenant: TenantFixture, owner: { customerId?: string; corporateAccountId?: string }, documentTypeKey: string, expiryDate: string | null) =>
    t.sys.document.create({ data: { tenantId: tenant.id, ...owner, documentTypeKey, title: `${documentTypeKey} ${uniq()}`, status: 'AVAILABLE', verificationStatus: 'VERIFIED', expiryDate: expiryDate ? new Date(`${expiryDate}T00:00:00Z`) : null, expiryVerified: !!expiryDate } });

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    receptionist = await t.addStaff(alpha, 'receptionist');
    await t.settle();
  });
  afterAll(() => t.close());

  // ------------------------------------------------------------------ schedules API
  describe('schedules', () => {
    it('creates a schedule with the default offsets, a custom schedule and the centre default', async () => {
      const customer = await makeCustomer(t, alpha, { fullName: 'Fatima Al Mansoori' });
      const created = await t.as(alpha.owner).post('/reminders', { customerId: customer.id, documentTypeKey: 'passport', expiryDate: inDays(200) }).expect(201);
      expect(created.body).toMatchObject({
        customerId: customer.id,
        customerName: 'Fatima Al Mansoori',
        documentTypeKey: 'passport',
        documentTypeName: 'Passport',
        subjectLabel: 'Fatima Al Mansoori',
        expiryDate: inDays(200),
        daysLeft: 200,
        offsetsDays: [90, 60, 30, 15, 7],
        status: 'ACTIVE',
        nextReminderOn: inDays(110),
        dispatches: [],
      });
      const custom = await t.as(alpha.owner).post('/reminders', { customerId: customer.id, documentTypeKey: 'emirates_id', expiryDate: inDays(100), offsetsDays: [5, 45, 45, 120], subjectLabel: 'Fatima (Emirates ID)' }).expect(201);
      expect(custom.body.offsetsDays).toEqual([120, 45, 5]);
      expect(custom.body.nextReminderOn).toBe(today); // the 120-day reminder is already due

      await t.as(alpha.owner).patch('/tenant/settings', { reminderOffsetsDays: [45, 10] }).expect(200);
      const withCentreDefault = await t.as(alpha.owner).post('/reminders', { customerId: customer.id, documentTypeKey: 'residence_visa', expiryDate: inDays(300) }).expect(201);
      expect(withCentreDefault.body.offsetsDays).toEqual([45, 10]);
      await t.sys.tenant.update({ where: { id: alpha.id }, data: { settings: {} } });

      const audit = await t.sys.auditLog.findFirst({ where: { tenantId: alpha.id, action: 'reminder.created', resourceId: created.body.id } });
      expect(audit?.actorUserId).toBe(alpha.owner.userId);
      const detail = await t.as(receptionist).get(`/reminders/${created.body.id}`).expect(200);
      expect(detail.body.id).toBe(created.body.id);
    });

    it('validates input and enforces permissions', async () => {
      const customer = await makeCustomer(t, alpha);
      const other = await makeCustomer(t, alpha);
      await t.as(receptionist).post('/reminders', { customerId: customer.id, documentTypeKey: 'passport', expiryDate: inDays(50) }).expect(403); // reminder.read only
      await t.as(receptionist).get('/reminders').expect(200);
      const operator = await t.addStaff(alpha, 'operator');
      await t.as(operator).get('/reminders').expect(403);
      await t.as(null).get('/reminders').expect(401);

      await t.as(alpha.owner).post('/reminders', { documentTypeKey: 'passport', expiryDate: inDays(50) }).expect(400);
      await t.as(alpha.owner).post('/reminders', { customerId: customer.id, documentTypeKey: 'passport', expiryDate: '12/10/2027' }).expect(400);
      expect((await t.as(alpha.owner).post('/reminders', { customerId: customer.id, documentTypeKey: 'passport', expiryDate: inDays(-1) }).expect(422)).body.code).toBe('EXPIRY_IN_PAST');
      expect((await t.as(alpha.owner).post('/reminders', { customerId: customer.id, documentTypeKey: 'driving_licence_x', expiryDate: inDays(50) }).expect(422)).body.code).toBe('UNKNOWN_DOCUMENT_TYPE');
      await t.as(alpha.owner).post('/reminders', { customerId: customer.id, documentTypeKey: 'passport', expiryDate: inDays(50) }).expect(201);
      expect((await t.as(alpha.owner).post('/reminders', { customerId: customer.id, documentTypeKey: 'passport', expiryDate: inDays(80) }).expect(409)).body.code).toBe('DUPLICATE_REMINDER');
      const foreignDocument = await makeDocument(alpha, { customerId: other.id }, 'labour_card', inDays(60));
      expect((await t.as(alpha.owner).post('/reminders', { customerId: customer.id, documentId: foreignDocument.id, documentTypeKey: 'labour_card', expiryDate: inDays(60) }).expect(422)).body.code).toBe('DOCUMENT_OWNER_MISMATCH');
      // A tenant document type works too.
      await t.sys.documentType.create({ data: { tenantId: alpha.id, key: 'municipality_permit', name: 'Municipality Permit', hasExpiry: true, reminderEnabled: true } });
      const own = await t.as(alpha.owner).post('/reminders', { customerId: customer.id, documentTypeKey: 'municipality_permit', expiryDate: inDays(60) }).expect(201);
      expect(own.body.documentTypeName).toBe('Municipality Permit');
    });

    it('lists upcoming expiries with filters', async () => {
      const gamma = await t.createTenant();
      const a = await makeCustomer(t, gamma, { fullName: 'Soon Expiring' });
      const b = await makeCustomer(t, gamma, { fullName: 'Later Expiring' });
      const soon = (await t.as(gamma.owner).post('/reminders', { customerId: a.id, documentTypeKey: 'passport', expiryDate: inDays(10) }).expect(201)).body;
      const mid = (await t.as(gamma.owner).post('/reminders', { customerId: b.id, documentTypeKey: 'emirates_id', expiryDate: inDays(40) }).expect(201)).body;
      const far = (await t.as(gamma.owner).post('/reminders', { customerId: b.id, documentTypeKey: 'passport', expiryDate: inDays(400) }).expect(201)).body;
      await t.as(gamma.owner).post(`/reminders/${far.id}/pause`).expect(200);

      const upcoming = await t.as(gamma.owner).get('/reminders?withinDays=60').expect(200);
      expect(upcoming.body.data.map((r: any) => r.id)).toEqual([soon.id, mid.id]); // soonest first
      expect(upcoming.body.data[0]).toMatchObject({ daysLeft: 10, customerName: 'Soon Expiring' });
      expect(upcoming.body.meta.total).toBe(2);
      expect((await t.as(gamma.owner).get('/reminders?withinDays=30').expect(200)).body.data.map((r: any) => r.id)).toEqual([soon.id]);
      expect((await t.as(gamma.owner).get(`/reminders?customerId=${b.id}`).expect(200)).body.meta.total).toBe(2);
      expect((await t.as(gamma.owner).get('/reminders?documentTypeKey=emirates_id').expect(200)).body.data.map((r: any) => r.id)).toEqual([mid.id]);
      expect((await t.as(gamma.owner).get('/reminders?status=PAUSED').expect(200)).body.data.map((r: any) => r.id)).toEqual([far.id]);
      expect((await t.as(gamma.owner).get('/reminders?q=soon').expect(200)).body.data.map((r: any) => r.id)).toEqual([soon.id]);
      expect((await t.as(gamma.owner).get('/reminders?pageSize=1&sort=expiryDate:desc').expect(200)).body.data[0].id).toBe(far.id);
    });

    it('edits, pauses, resumes and cancels, and refuses changes to a closed schedule', async () => {
      const customer = await makeCustomer(t, alpha);
      const s = (await t.as(alpha.owner).post('/reminders', { customerId: customer.id, documentTypeKey: 'labour_card', expiryDate: inDays(120) }).expect(201)).body;
      const edited = await t.as(alpha.owner).patch(`/reminders/${s.id}`, { expiryDate: inDays(150), offsetsDays: [30, 7], subjectLabel: 'Work permit' }).expect(200);
      expect(edited.body).toMatchObject({ expiryDate: inDays(150), offsetsDays: [30, 7], subjectLabel: 'Work permit' });
      await t.as(alpha.owner).patch(`/reminders/${s.id}`, { expiryDate: inDays(-3) }).expect(422);
      await t.as(receptionist).patch(`/reminders/${s.id}`, { subjectLabel: 'Nope' }).expect(403);

      expect((await t.as(alpha.owner).post(`/reminders/${s.id}/pause`).expect(200)).body).toMatchObject({ status: 'PAUSED', nextReminderOn: null });
      await t.as(alpha.owner).post(`/reminders/${s.id}/pause`).expect(409);
      expect((await t.as(alpha.owner).post(`/reminders/${s.id}/resume`).expect(200)).body.status).toBe('ACTIVE');
      expect((await t.as(alpha.owner).post(`/reminders/${s.id}/cancel`, { reason: 'Customer left the country' }).expect(200)).body.status).toBe('CANCELLED');
      expect((await t.as(alpha.owner).patch(`/reminders/${s.id}`, { subjectLabel: 'Again' }).expect(409)).body.code).toBe('REMINDER_CLOSED');
      await t.as(alpha.owner).post(`/reminders/${s.id}/resume`).expect(409);
      await t.as(alpha.owner).post(`/reminders/${s.id}/cancel`).expect(409);
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, resourceId: s.id, action: { in: ['reminder.created', 'reminder.updated', 'reminder.cancelled'] } } })).toBe(5);
    });
  });

  // ------------------------------------------------------------------ daily scan
  describe('daily scan (job reminders.scan)', () => {
    it('sends the reminder that is due, records the result and never sends twice on the same day', async () => {
      const customer = await makeCustomer(t, alpha, { fullName: 'Huda Karim', consents: ['REMINDERS'], phone: null });
      const s = (await t.as(alpha.owner).post('/reminders', { customerId: customer.id, documentTypeKey: 'passport', expiryDate: inDays(90) }).expect(201)).body;

      await runScan(inDays(-1)); // the day before: nothing is due yet (91 days left)
      expect(await dispatches(s.id)).toHaveLength(0);

      await runScan();
      let rows = await dispatches(s.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ offsetDays: 90, status: 'SENT' });
      expect(rows[0].dueOn.toISOString().slice(0, 10)).toBe(today);
      expect(rows[0].processedAt).not.toBeNull();

      const sent = await expiryNotifications(alpha.id, s.id);
      expect(sent.map((n) => `${n.channel}:${n.status}`)).toEqual(['EMAIL:SENT']);
      expect(sent[0].subject).toMatch(/^Passport expires on .+ according to our records$/);
      expect(sent[0].body).toContain('According to our records, the Passport for Huda Karim expires on');
      expect(sent[0].body).toContain('(in 90 days)');
      expect(sent[0].body).toContain(`renewalOf=${s.id}`);
      expect(sent[0].body).not.toMatch(/penalt|fine|deadline|illegal/i);
      // The dispatch points at the notification that was created for it.
      expect(rows[0].notificationId).toBe(sent[0].id);
      expect(rows[0].detail).toContain('EMAIL: QUEUED');
      expect(LogProvider.lastFor(customer.email!, 'EMAIL')!.message.html).toContain('Start a renewal request');

      // Running the job again the same day (or the next) does nothing.
      await runScan();
      await runScan();
      await runScan(inDays(1));
      expect(await dispatches(s.id)).toHaveLength(1);
      expect(await expiryNotifications(alpha.id, s.id)).toHaveLength(1);

      // 60 days before expiry the next reminder goes out.
      await runScan(inDays(30));
      rows = await dispatches(s.id);
      expect(rows.map((d) => [d.offsetDays, d.status])).toEqual([[90, 'SENT'], [60, 'SENT']]);
      const all = await expiryNotifications(alpha.id, s.id);
      expect(all).toHaveLength(2);
      expect(all[1].body).toContain('(in 60 days)');

      const detail = await t.as(alpha.owner).get(`/reminders/${s.id}`).expect(200);
      expect(detail.body.dispatches.map((d: any) => d.status)).toEqual(['SENT', 'SENT']);
      expect(detail.body.lastReminderAt).toBeTruthy();
    });

    it('skips a customer who has not agreed to reminders and one who opted out', async () => {
      const noConsent = await makeCustomer(t, alpha);
      const withdrawn = await makeCustomer(t, alpha);
      await setConsent(t, alpha.id, withdrawn.id, 'REMINDERS', 'WITHDRAWN');
      const optedOut = await makeCustomer(t, alpha, { consents: ['REMINDERS'], communicationPrefs: { email: false, sms: false, whatsapp: false, push: false } });
      const ids: string[] = [];
      for (const c of [noConsent, withdrawn, optedOut]) ids.push((await t.as(alpha.owner).post('/reminders', { customerId: c.id, documentTypeKey: 'passport', expiryDate: inDays(30) }).expect(201)).body.id);
      await runScan();

      const [a, b, c] = [await dispatches(ids[0]), await dispatches(ids[1]), await dispatches(ids[2])];
      expect(a.find((d) => d.offsetDays === 30)).toMatchObject({ status: 'SKIPPED_NO_CONSENT' });
      expect(b.find((d) => d.offsetDays === 30)).toMatchObject({ status: 'SKIPPED_NO_CONSENT' });
      expect(c.find((d) => d.offsetDays === 30)).toMatchObject({ status: 'SKIPPED_OPT_OUT' });
      for (const id of ids) expect(await expiryNotifications(alpha.id, id)).toHaveLength(0);
      // The earlier offsets were missed before the schedule existed: recorded, never sent late.
      expect(a.filter((d) => d.status === 'CANCELLED').map((d) => d.offsetDays)).toEqual([90, 60]);

      // Consent granted later: the next offset is sent.
      await setConsent(t, alpha.id, noConsent.id, 'REMINDERS', 'GRANTED');
      await runScan(inDays(15));
      expect((await dispatches(ids[0])).find((d) => d.offsetDays === 15)!.status).toBe('SENT');
      expect(await expiryNotifications(alpha.id, ids[0])).toHaveLength(2); // EMAIL + SMS
    });

    it('catches up with a single reminder, ignores paused schedules and completes expired ones', async () => {
      const customer = await makeCustomer(t, alpha, { consents: ['REMINDERS'], phone: null });
      const late = (await t.as(alpha.owner).post('/reminders', { customerId: customer.id, documentTypeKey: 'passport', expiryDate: inDays(20) }).expect(201)).body;
      const paused = (await t.as(alpha.owner).post('/reminders', { customerId: customer.id, documentTypeKey: 'emirates_id', expiryDate: inDays(7) }).expect(201)).body;
      await t.as(alpha.owner).post(`/reminders/${paused.id}/pause`).expect(200);
      await runScan();
      expect((await dispatches(late.id)).map((d) => [d.offsetDays, d.status])).toEqual([[90, 'CANCELLED'], [60, 'CANCELLED'], [30, 'SENT']]);
      expect(await expiryNotifications(alpha.id, late.id)).toHaveLength(1);
      expect(await dispatches(paused.id)).toHaveLength(0);

      // After the expiry date the schedule is finished.
      await runScan(inDays(21));
      const done = await t.as(alpha.owner).get(`/reminders/${late.id}`).expect(200);
      expect(done.body.status).toBe('COMPLETED');
      expect(done.body.dispatches.map((d: any) => [d.offsetDays, d.status])).toEqual([[90, 'CANCELLED'], [60, 'CANCELLED'], [30, 'SENT'], [15, 'CANCELLED'], [7, 'CANCELLED']]);
      expect(await expiryNotifications(alpha.id, late.id)).toHaveLength(1);
      expect((await t.as(alpha.owner).get(`/reminders/${paused.id}`).expect(200)).body.status).toBe('PAUSED');
    });

    it('reminds the contacts of a corporate account', async () => {
      const account = await t.sys.corporateAccount.create({ data: { tenantId: alpha.id, accountNo: `CORP-${uniq()}`, companyName: 'Gulf Trading LLC', billingEmail: 'accounts@gulf-trading.example', status: 'ACTIVE' } });
      const email = `pro-${uniq()}@gulf-trading.example`;
      await t.sys.corporateMember.create({ data: { tenantId: alpha.id, corporateAccountId: account.id, fullName: 'Khalid PRO', email, status: 'ACTIVE' } });
      const s = (await t.as(alpha.owner).post('/reminders', { corporateAccountId: account.id, documentTypeKey: 'trade_licence', expiryDate: inDays(60) }).expect(201)).body;
      expect(s).toMatchObject({ corporateName: 'Gulf Trading LLC', subjectLabel: 'Gulf Trading LLC', customerId: null });
      await runScan();
      expect((await dispatches(s.id)).find((d) => d.offsetDays === 60)!.status).toBe('SENT');
      const sent = await expiryNotifications(alpha.id, s.id);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ channel: 'EMAIL', status: 'SENT', recipientAddress: email });
      expect(sent[0].body).toContain('the Trade Licence for Gulf Trading LLC expires on');
      const link = await t.as(alpha.owner).post(`/reminders/${s.id}/renewal-link`).expect(200);
      expect(link.body.app).toBe('corporate');
    });

    it('marks the dispatch FAILED when the reminder could not be delivered', async () => {
      const delta = await t.createTenant();
      await t.sys.integration.create({ data: { tenantId: delta.id, category: 'EMAIL', provider: 'smtp', name: 'broken', status: 'ACTIVE', config: {} } });
      const customer = await makeCustomer(t, delta, { consents: ['REMINDERS'], phone: null });
      const s = (await t.as(delta.owner).post('/reminders', { customerId: customer.id, documentTypeKey: 'passport', expiryDate: inDays(7) }).expect(201)).body;
      await runScan();
      const row = (await dispatches(s.id)).find((d) => d.offsetDays === 7)!;
      expect(row.status).toBe('FAILED');
      expect(row.detail).toMatch(/integration is incomplete/);
    });
  });

  // ------------------------------------------------------------------ automatic schedules + renewal
  describe('verified documents and renewal', () => {
    it('creates a schedule when a document with an expiry date is verified, and replaces it when the document is renewed', async () => {
      const customer = await makeCustomer(t, alpha, { fullName: 'Omar Zayed' });
      const oldPassport = await makeDocument(alpha, { customerId: customer.id }, 'passport', inDays(45));
      await emit(t, alpha.id, 'document.verified', { documentId: oldPassport.id, customerId: customer.id, documentTypeKey: 'passport', expiryDate: inDays(45) });
      await t.settle();
      let list = (await t.as(alpha.owner).get(`/reminders?customerId=${customer.id}`).expect(200)).body.data;
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ documentId: oldPassport.id, documentTypeKey: 'passport', subjectLabel: 'Omar Zayed', expiryDate: inDays(45), status: 'ACTIVE', offsetsDays: [90, 60, 30, 15, 7] });

      // The same event again (at-least-once delivery) changes nothing.
      await emit(t, alpha.id, 'document.verified', { documentId: oldPassport.id, customerId: customer.id, documentTypeKey: 'passport', expiryDate: inDays(45) });
      await t.settle();
      expect((await t.as(alpha.owner).get(`/reminders?customerId=${customer.id}`).expect(200)).body.meta.total).toBe(1);

      // Renewal: the new passport is verified -> the old schedule stops, a new one starts.
      const newPassport = await makeDocument(alpha, { customerId: customer.id }, 'passport', inDays(3650));
      await emit(t, alpha.id, 'document.verified', { documentId: newPassport.id, customerId: customer.id, documentTypeKey: 'passport', expiryDate: `${inDays(3650)}T00:00:00.000Z` });
      await t.settle();
      list = (await t.as(alpha.owner).get(`/reminders?customerId=${customer.id}&sort=expiryDate:asc`).expect(200)).body.data;
      expect(list.map((r: any) => [r.documentId, r.status])).toEqual([[oldPassport.id, 'COMPLETED'], [newPassport.id, 'ACTIVE']]);
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'reminder.completed', resourceId: list[0].id } })).toBe(1);

      // A corrected expiry date on the same document updates its schedule.
      await emit(t, alpha.id, 'document.verified', { documentId: newPassport.id, customerId: customer.id, documentTypeKey: 'passport', expiryDate: inDays(3000) });
      await t.settle();
      expect((await t.as(alpha.owner).get(`/reminders/${list[1].id}`).expect(200)).body.expiryDate).toBe(inDays(3000));
    });

    it('ignores documents without an expiry date and types without reminders', async () => {
      const customer = await makeCustomer(t, alpha);
      const photo = await makeDocument(alpha, { customerId: customer.id }, 'photo', inDays(100));
      const certificate = await makeDocument(alpha, { customerId: customer.id }, 'passport', null);
      await emit(t, alpha.id, 'document.verified', { documentId: photo.id, customerId: customer.id, documentTypeKey: 'photo', expiryDate: inDays(100) });
      await emit(t, alpha.id, 'document.verified', { documentId: certificate.id, customerId: customer.id, documentTypeKey: 'passport' });
      await t.settle();
      expect((await t.as(alpha.owner).get(`/reminders?customerId=${customer.id}`).expect(200)).body.meta.total).toBe(0);
    });

    it('offers a renewal link to the portal', async () => {
      const customer = await makeCustomer(t, alpha);
      const s = (await t.as(alpha.owner).post('/reminders', { customerId: customer.id, documentTypeKey: 'residence_visa', expiryDate: inDays(25) }).expect(201)).body;
      const link = await t.as(receptionist).post(`/reminders/${s.id}/renewal-link`).expect(200);
      expect(link.body).toMatchObject({ scheduleId: s.id, app: 'customer' });
      const url = new URL(link.body.link);
      expect(url.pathname).toBe('/requests/new');
      expect(url.searchParams.get('renewalOf')).toBe(s.id);
      expect(url.searchParams.get('tenant')).toBe(alpha.slug);
    });
  });

  // ------------------------------------------------------------------ customers and isolation
  describe('customers and tenant isolation', () => {
    it('shows customers only their own reminders', async () => {
      const one = await t.addCustomer(alpha);
      const two = await t.addCustomer(alpha);
      const mine = (await t.as(alpha.owner).post('/reminders', { customerId: one.customerId, documentTypeKey: 'passport', expiryDate: inDays(77) }).expect(201)).body;
      const cancelled = (await t.as(alpha.owner).post('/reminders', { customerId: one.customerId, documentTypeKey: 'emirates_id', expiryDate: inDays(88) }).expect(201)).body;
      await t.as(alpha.owner).post(`/reminders/${cancelled.id}/cancel`).expect(200);
      await t.as(alpha.owner).post('/reminders', { customerId: two.customerId, documentTypeKey: 'passport', expiryDate: inDays(99) }).expect(201);

      const list = await t.as(one).get('/me/reminders').expect(200);
      expect(list.body.data).toEqual([
        { id: mine.id, documentTypeKey: 'passport', documentTypeName: 'Passport', documentTypeNameAr: 'جواز السفر', subjectLabel: expect.any(String), customerId: one.customerId, customerName: 'Test Customer', expiryDate: inDays(77), daysLeft: 77, status: 'ACTIVE', nextReminderOn: today, renewalRequestId: null, renewalPath: `/requests/new?renewalOf=${mine.id}` },
      ]);
      // Customers have no access to the staff API.
      await t.as(one).get('/reminders').expect(403);
      await t.as(one).get(`/reminders/${mine.id}`).expect(403);
      await t.as(one).post(`/reminders/${mine.id}/cancel`).expect(403);
      // Staff have no "my reminders".
      await t.as(alpha.owner).get('/me/reminders').expect(403);
    });

    it('never lets tenant B read, change or reference tenant A reminders', async () => {
      const alphaCustomer = await makeCustomer(t, alpha, { consents: ['REMINDERS'] });
      const s = (await t.as(alpha.owner).post('/reminders', { customerId: alphaCustomer.id, documentTypeKey: 'passport', expiryDate: inDays(333) }).expect(201)).body;
      await t.as(beta.owner).get(`/reminders/${s.id}`).expect(404);
      await t.as(beta.owner).patch(`/reminders/${s.id}`, { subjectLabel: 'Hijacked' }).expect(404);
      await t.as(beta.owner).post(`/reminders/${s.id}/pause`).expect(404);
      await t.as(beta.owner).post(`/reminders/${s.id}/cancel`).expect(404);
      await t.as(beta.owner).post(`/reminders/${s.id}/renewal-link`).expect(404);
      // Referencing another centre's customer or document is "not found".
      await t.as(beta.owner).post('/reminders', { customerId: alphaCustomer.id, documentTypeKey: 'passport', expiryDate: inDays(50) }).expect(404);
      const betaCustomer = await makeCustomer(t, beta);
      const alphaDocument = await makeDocument(alpha, { customerId: alphaCustomer.id }, 'passport', inDays(50));
      await t.as(beta.owner).post('/reminders', { customerId: betaCustomer.id, documentId: alphaDocument.id, documentTypeKey: 'passport', expiryDate: inDays(50) }).expect(404);
      const list = await t.as(beta.owner).get('/reminders?pageSize=100').expect(200);
      expect(list.body.data.some((r: any) => r.id === s.id)).toBe(false);

      const seen = await t.inTenant(beta.id, () => t.db.tx((tx) => tx.reminderSchedule.findMany({ select: { tenantId: true } })));
      expect(seen.every((r) => r.tenantId === beta.id)).toBe(true);
      await expect(
        t.inTenant(beta.id, () => t.db.tx((tx) => tx.reminderDispatch.create({ data: { tenantId: beta.id, scheduleId: s.id, offsetDays: 1, dueOn: new Date() } }))),
      ).rejects.toThrow(/cross-tenant|violates|security/i);
      const untouched = await t.sys.reminderSchedule.findUniqueOrThrow({ where: { id: s.id } });
      expect(untouched).toMatchObject({ subjectLabel: alphaCustomer.fullName, status: 'ACTIVE' });
    });
  });
});
