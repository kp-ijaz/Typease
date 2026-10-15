import { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { addDays, localYmd } from '../reports/time';
import { createCustomer, issueInvoice, key, listen, recordPayment } from './fixtures';
import { INVOICE_REMINDER_JOB, InvoiceRemindersService } from './invoice-reminders.service';

describe('Finance: automatic payment reminders for unpaid invoices', () => {
  describe('which stage is sent (pure)', () => {
    const stages = [0, 3, 7, 14];
    const send = (days: number, sent: number[] = []) => InvoiceRemindersService.stageToSend(days, stages, new Set(sent));
    it('sends nothing before the first stage, the stage itself on its day, and only the latest stage reached', () => {
      expect(send(-1)).toBeNull();
      expect(send(0)).toBe(0);
      expect(send(2, [0])).toBeNull();
      expect(send(5, [0])).toBe(3);
      // The job missed a few days: only the latest stage goes out, never a burst.
      expect(send(9)).toBe(7);
    });
    it('never repeats a stage or goes back to an older one, and stops after the last stage', () => {
      expect(send(3, [3])).toBeNull();
      expect(send(3, [7])).toBeNull();
      expect(send(14 + 7)).toBe(14);
      expect(send(14 + 8)).toBeNull();
    });
    it('supports days before the due date', () => {
      expect(InvoiceRemindersService.stageToSend(-2, [-2, 0], new Set())).toBe(-2);
      expect(InvoiceRemindersService.stageToSend(-1, [-2, 0], new Set([-2]))).toBeNull();
    });
  });

  describe('daily scan, history, manual send and pause', () => {
    let t: TestApp;
    let alpha: TenantFixture;
    let beta: TenantFixture;
    let accountant: Actor;
    let operator: Actor;
    let customerId: string;
    const today = () => localYmd(new Date(), 'Asia/Dubai');
    const scan = (day: string) => t.jobs.execute(INVOICE_REMINDER_JOB, { today: day }, { attempt: 1, maxAttempts: 1 });
    const reminders = (invoiceId: string) => t.sys.invoiceReminder.findMany({ where: { invoiceId }, orderBy: { createdAt: 'asc' } });
    const notices = (invoiceId: string) => t.sys.notification.findMany({ where: { eventKey: 'invoice.reminder', relatedId: invoiceId } });

    beforeAll(async () => {
      t = await listen(await TestApp.create());
      alpha = await t.createTenant({ name: 'Alpha Typing' });
      beta = await t.createTenant({ name: 'Beta Typing' });
      accountant = await t.addStaff(alpha, 'accountant');
      operator = await t.addStaff(alpha, 'operator');
      customerId = (await createCustomer(t, alpha)).id;
    });
    afterAll(() => t.close());

    it('sends each stage once, with the payment link, to the customer', async () => {
      const inv = await issueInvoice(t, alpha.owner, customerId, { serviceFee: '100.00', governmentFee: '0' });
      // Invoices are due on the day they are issued (invoiceDueDays 0).
      await scan(today());
      await t.settle();
      expect((await reminders(inv.id)).map((r) => r.stage)).toEqual([0]);
      await scan(today()); // same day again: nothing new
      await scan(addDays(today(), 2));
      expect((await reminders(inv.id)).map((r) => r.stage)).toEqual([0]);
      await scan(addDays(today(), 3));
      await scan(addDays(today(), 8));
      await t.settle();
      const sent = await reminders(inv.id);
      expect(sent.map((r) => [r.stage, r.daysOverdue, r.automatic])).toEqual([
        [0, 0, true],
        [3, 3, true],
        [7, 8, true],
      ]);
      const email = (await notices(inv.id)).find((n) => n.channel === 'EMAIL');
      expect(email?.subject).toContain(inv.invoiceNo);
      expect(email?.body).toContain(`/invoices/${inv.id}`);
      expect((await notices(inv.id)).filter((n) => n.channel === 'EMAIL')).toHaveLength(3);
    });

    it('stops as soon as the invoice is paid', async () => {
      const inv = await issueInvoice(t, alpha.owner, customerId, { serviceFee: '100.00', governmentFee: '0' });
      await recordPayment(t, alpha.owner, { method: 'CASH', amount: inv.total, branchId: alpha.headOfficeId, allocations: [{ invoiceId: inv.id, amount: inv.total }] }, key()).expect(201);
      await scan(addDays(today(), 3));
      expect(await reminders(inv.id)).toHaveLength(0);
    });

    it('can be paused until a promised date, and resumed', async () => {
      const inv = await issueInvoice(t, alpha.owner, customerId, { serviceFee: '50.00', governmentFee: '0' });
      await t.as(operator).put(`/invoices/${inv.id}/reminders/pause`, { until: addDays(today(), 5) }).expect(403);
      await t.as(accountant).put(`/invoices/${inv.id}/reminders/pause`, { until: addDays(today(), 5) }).expect(200);
      await scan(addDays(today(), 3));
      expect(await reminders(inv.id)).toHaveLength(0);
      const history = await t.as(accountant).get(`/invoices/${inv.id}/reminders`).expect(200);
      expect(history.body).toMatchObject({ enabled: true, pausedUntil: addDays(today(), 5) });
      // After the promised day the schedule continues with the stage reached by then.
      await scan(addDays(today(), 7));
      expect((await reminders(inv.id)).map((r) => r.stage)).toEqual([7]);
      await t.as(accountant).put(`/invoices/${inv.id}/reminders/pause`, { until: null }).expect(200);
    });

    it('lets staff send one now, but not twice in a row', async () => {
      const inv = await issueInvoice(t, alpha.owner, customerId, { serviceFee: '80.00', governmentFee: '0' });
      await t.as(operator).post(`/invoices/${inv.id}/reminders`).expect(403);
      await t.as(accountant).post(`/invoices/${inv.id}/reminders`).expect(201);
      const again = await t.as(accountant).post(`/invoices/${inv.id}/reminders`).expect(409);
      expect(again.body.code).toBe('REMINDER_TOO_SOON');
      const history = await t.as(accountant).get(`/invoices/${inv.id}/reminders`).expect(200);
      expect(history.body.reminders).toHaveLength(1);
      expect(history.body.reminders[0]).toMatchObject({ automatic: false, stage: null, sentById: accountant.userId });
      // A manual reminder does not use up an automatic stage.
      await scan(addDays(today(), 3));
      expect((await reminders(inv.id)).filter((r) => r.automatic).map((r) => r.stage)).toEqual([3]);
    });

    it('follows the centre settings and stays inside the centre', async () => {
      await t.as(accountant).put('/finance/invoice-reminders', { enabled: false }).expect(403);
      const updated = await t.as(alpha.owner).put('/finance/invoice-reminders', { days: [-2, 1, 5, 1] }).expect(400);
      expect(JSON.stringify(updated.body)).toContain('once');
      expect((await t.as(alpha.owner).put('/finance/invoice-reminders', { days: [5, 1] }).expect(200)).body).toEqual({ enabled: true, days: [1, 5] });
      const inv = await issueInvoice(t, alpha.owner, customerId, { serviceFee: '60.00', governmentFee: '0' });
      await scan(today());
      expect(await reminders(inv.id)).toHaveLength(0); // day 0 is no longer a stage
      await t.as(alpha.owner).put('/finance/invoice-reminders', { enabled: false }).expect(200);
      await scan(addDays(today(), 5));
      expect(await reminders(inv.id)).toHaveLength(0);
      await t.as(alpha.owner).put('/finance/invoice-reminders', { enabled: true, days: [0, 3, 7, 14] }).expect(200);
      await t.as(beta.owner).get(`/invoices/${inv.id}/reminders`).expect(404);
      await t.as(beta.owner).post(`/invoices/${inv.id}/reminders`).expect(404);
    });
  });
});
