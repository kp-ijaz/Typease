import { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { localYmd } from '../reports/time';
import { completeDocuments, createCustomer as createRequestCustomer, createService, draftRequest, forceStatus } from '../requests/fixtures';
import { CommissionsService } from './commissions.service';
import { key, line, listen, recordPayment } from './fixtures';

describe('Finance: staff commission', () => {
  it('computes percentages of the service fee and fixed amounts', () => {
    expect(CommissionsService.computeAmount('PERCENT', '2.5', '199.99').toString()).toBe('5');
    expect(CommissionsService.computeAmount('PERCENT', '10', '200').toFixed(2)).toBe('20.00');
    expect(CommissionsService.computeAmount('FIXED', '25', '0').toFixed(2)).toBe('25.00');
  });

  describe('rules, accrual on completion, reopen, statements and payout', () => {
    let t: TestApp;
    let alpha: TenantFixture;
    let beta: TenantFixture;
    let receptionist: Actor;
    let operator: Actor;
    let reviewer: Actor;
    let accountant: Actor;
    let serviceId: string;
    let otherServiceId: string;
    let customerId: string;
    let requestId: string;
    const entries = (id: string) => t.sys.commissionEntry.findMany({ where: { requestId: id }, orderBy: [{ beneficiary: 'asc' }, { createdAt: 'asc' }] });

    /** A request created by the receptionist, assigned to the operator and reviewer, invoiced (200.00 service fee, 20.00 off) and paid, in final review. */
    const readyForCompletion = async (svc: string) => {
      const draft = await draftRequest(t, alpha, receptionist, svc, customerId);
      await completeDocuments(t, alpha, draft.id);
      const invoice = await t
        .as(alpha.owner)
        .post('/invoices', { customerId, requestId: draft.id, items: [line('SERVICE_FEE', '200.00', { discountAmount: '20.00' }), line('GOVERNMENT_FEE', '500.00')] })
        .expect(201);
      const issued = await t.as(alpha.owner).post(`/invoices/${invoice.body.id}/issue`).expect(200);
      await recordPayment(t, alpha.owner, { method: 'CASH', amount: issued.body.total, branchId: alpha.headOfficeId, allocations: [{ invoiceId: issued.body.id, amount: issued.body.total }] }, key()).expect(201);
      await forceStatus(t, draft.id, 'FINAL_REVIEW', { assignedToId: operator.membershipId });
      await t.sys.requestAssignment.create({ data: { tenantId: alpha.id, requestId: draft.id, assigneeId: reviewer.membershipId!, role: 'REVIEWER' } });
      return draft.id as string;
    };

    beforeAll(async () => {
      t = await listen(await TestApp.create());
      alpha = await t.createTenant({ name: 'Alpha Typing' });
      beta = await t.createTenant({ name: 'Beta Typing' });
      receptionist = await t.addStaff(alpha, 'receptionist');
      operator = await t.addStaff(alpha, 'operator');
      reviewer = await t.addStaff(alpha, 'reviewer');
      accountant = await t.addStaff(alpha, 'accountant');
      serviceId = (await createService(t, alpha, { paymentPolicy: 'AFTER_COMPLETION', requiresApproval: false })).id;
      otherServiceId = (await createService(t, alpha, { paymentPolicy: 'AFTER_COMPLETION', requiresApproval: false })).id;
      customerId = (await createRequestCustomer(t, alpha)).id;
    });
    afterAll(() => t.close());

    it('manages rules: one active rule per service and person, percentages up to 100', async () => {
      await t.as(operator).post('/commissions/rules', { serviceId: null, beneficiary: 'OPERATOR', kind: 'PERCENT', value: '10' }).expect(403);
      await t.as(accountant).post('/commissions/rules', { serviceId: null, beneficiary: 'OPERATOR', kind: 'PERCENT', value: '120' }).expect(400);
      await t.as(accountant).post('/commissions/rules', { serviceId: null, beneficiary: 'OPERATOR', kind: 'PERCENT', value: '10' }).expect(201);
      const dup = await t.as(accountant).post('/commissions/rules', { serviceId: null, beneficiary: 'OPERATOR', kind: 'FIXED', value: '5' }).expect(409);
      expect(dup.body.code).toBe('RULE_EXISTS');
      // The service's own rule wins over the default.
      await t.as(accountant).post('/commissions/rules', { serviceId, beneficiary: 'OPERATOR', kind: 'FIXED', value: '25' }).expect(201);
      await t.as(accountant).post('/commissions/rules', { serviceId: null, beneficiary: 'REVIEWER', kind: 'PERCENT', value: '2.5' }).expect(201);
      await t.as(accountant).post('/commissions/rules', { serviceId: null, beneficiary: 'CREATOR', kind: 'FIXED', value: '5' }).expect(201);
      const rules = await t.as(accountant).get('/commissions/rules').expect(200);
      expect(rules.body).toHaveLength(4);
      await t.as(beta.owner).get('/commissions/rules').expect(200).expect((r) => expect(r.body).toHaveLength(0));
    });

    it('accrues for the operator, reviewer and creator when the request is completed', async () => {
      requestId = await readyForCompletion(serviceId);
      await t.as(reviewer).post(`/requests/${requestId}/complete`).expect(200);
      const earned = await entries(requestId);
      // Basis: 200.00 service fee - 20.00 discount = 180.00; the 500.00 government fee and VAT never count.
      expect(earned.map((e) => [e.beneficiary, e.basis.toFixed(2), e.amount.toFixed(2), e.status])).toEqual([
        ['OPERATOR', '180.00', '25.00', 'ACCRUED'],
        ['REVIEWER', '180.00', '4.50', 'ACCRUED'],
        ['CREATOR', '180.00', '5.00', 'ACCRUED'],
      ]);
      expect(earned.find((e) => e.beneficiary === 'CREATOR')?.userId).toBe(receptionist.userId);
    });

    it('uses the default rule for other services', async () => {
      const other = await readyForCompletion(otherServiceId);
      await t.as(reviewer).post(`/requests/${other}/complete`).expect(200);
      expect((await entries(other)).find((e) => e.beneficiary === 'OPERATOR')?.amount.toFixed(2)).toBe('18.00');
    });

    it('voids unpaid commission when the request is reopened, and earns again on completion', async () => {
      await t.as(alpha.owner).post(`/requests/${requestId}/reopen`, { reason: 'Customer spotted a typo' }).expect(200);
      expect((await entries(requestId)).every((e) => e.status === 'VOID')).toBe(true);
      await forceStatus(t, requestId, 'FINAL_REVIEW');
      await t.as(reviewer).post(`/requests/${requestId}/complete`).expect(200);
      const after = await entries(requestId);
      expect(after.filter((e) => e.status === 'ACCRUED')).toHaveLength(3);
      expect(after.filter((e) => e.status === 'VOID')).toHaveLength(3);
    });

    it('shows each person their own commission, managers everybody\'s', async () => {
      const own = await t.as(operator).get('/commissions/entries').expect(200);
      expect(own.body.data.every((e: { membershipId: string }) => e.membershipId === operator.membershipId)).toBe(true);
      expect(own.body.totals.ACCRUED).toBe('43.00');
      const all = await t.as(accountant).get('/commissions/entries').query({ status: 'ACCRUED' }).expect(200);
      expect(new Set(all.body.data.map((e: { membershipId: string }) => e.membershipId)).size).toBe(3);
      await t.as(operator).get('/commissions/summary').query({ from: '2020-01-01', to: '2099-12-31' }).expect(403);
      const summary = await t.as(accountant).get('/commissions/summary').query({ from: '2020-01-01', to: '2099-12-31' }).expect(200);
      expect(summary.body.staff.find((s: { membershipId: string }) => s.membershipId === operator.membershipId)).toMatchObject({ earned: '43.00', accrued: '43.00', paid: '0.00', owedTotal: '43.00', requests: 2 });
    });

    it('pays out up to a day; paid commission is final', async () => {
      const today = localYmd(new Date(), 'Asia/Dubai');
      const paid = await t.as(accountant).post('/commissions/payouts', { membershipId: operator.membershipId, upTo: today, reference: 'PAYROLL-OCT' }).expect(201);
      expect(paid.body).toMatchObject({ entries: 2, total: '43.00', reference: 'PAYROLL-OCT' });
      // The books: accrued, voided on reopen and accrued again, then the operator's 43.00 paid out of the bank.
      const journal = await t.sys.journalEntry.groupBy({ by: ['sourceType'], where: { tenantId: alpha.id, sourceType: { startsWith: 'COMMISSION_' } }, _count: { _all: true } });
      expect(Object.fromEntries(journal.map((j) => [j.sourceType, j._count._all]))).toEqual({ COMMISSION_ACCRUED: 9, COMMISSION_VOIDED: 3, COMMISSION_PAID: 2 });
      const nothing = await t.as(accountant).post('/commissions/payouts', { membershipId: operator.membershipId, upTo: today, reference: 'AGAIN' }).expect(409);
      expect(nothing.body.code).toBe('NOTHING_TO_PAY');
      const entry = await t.sys.commissionEntry.findFirstOrThrow({ where: { membershipId: operator.membershipId!, status: 'PAID' } });
      await expect(t.sys.commissionEntry.update({ where: { id: entry.id }, data: { amount: 1 } })).rejects.toThrow(/final/);
      // Reopening after the payout leaves paid commission alone.
      await t.as(alpha.owner).post(`/requests/${requestId}/reopen`, { reason: 'Another correction' }).expect(200);
      expect((await t.sys.commissionEntry.findUniqueOrThrow({ where: { id: entry.id } })).status).toBe('PAID');
    });
  });
});
