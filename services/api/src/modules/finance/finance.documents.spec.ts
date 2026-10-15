import { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { listen } from './fixtures';
import { addCorporateAdmin, createCorporate, createCustomer, createRequest, createService, issueInvoice, line, outbox } from './fixtures';
import { EXPIRE_JOB } from './quotations.service';

/** End of the due day (23:59:59.999) on the centre's calendar: Asia/Dubai, UTC+4 all year. */
const endOfDubaiDay = (issuedAt: string, termsDays: number) => {
  const local = new Date(new Date(issuedAt).getTime() + 4 * 3_600_000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + termsDays + 1) - 4 * 3_600_000 - 1).toISOString();
};

describe('Finance: fee components, quotations and invoices', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let receptionist: Actor;
  let manager: Actor;
  let accountant: Actor;
  let operator: Actor;
  let customer: Actor;
  let otherCustomer: Actor;

  beforeAll(async () => {
    t = await listen(await TestApp.create());
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    receptionist = await t.addStaff(alpha, 'receptionist');
    manager = await t.addStaff(alpha, 'manager');
    accountant = await t.addStaff(alpha, 'accountant');
    operator = await t.addStaff(alpha, 'operator');
    customer = await t.addCustomer(alpha, { fullName: 'Aisha Khan' });
    otherCustomer = await t.addCustomer(alpha, { fullName: 'Omar Said' });
  });
  afterAll(() => t.close());

  // ---------------------------------------------------------------- fee components
  describe('fee components (accounting treatment)', () => {
    it('are provisioned with government and third-party fees as pass-through liabilities', async () => {
      const res = await t.as(alpha.owner).get('/finance/fee-components').expect(200);
      expect(res.body.notice).toMatch(/accountant/i);
      const byType = Object.fromEntries(res.body.components.map((c: any) => [c.type, c]));
      expect(byType.SERVICE_FEE.treatment).toBe('REVENUE');
      expect(byType.GOVERNMENT_FEE.treatment).toBe('PASS_THROUGH_LIABILITY');
      expect(byType.THIRD_PARTY_FEE.treatment).toBe('PASS_THROUGH_LIABILITY');
    });

    it('lets the owner change name / ledger code / treatment, with a review note and an audit entry', async () => {
      const res = await t
        .as(alpha.owner)
        .put('/finance/fee-components', { components: [{ type: 'THIRD_PARTY_FEE', name: 'Courier and attestation charges', ledgerCode: '2150', treatment: 'REVENUE' }] })
        .expect(200);
      const tp = res.body.components.find((c: any) => c.type === 'THIRD_PARTY_FEE');
      expect(tp).toMatchObject({ name: 'Courier and attestation charges', ledgerCode: '2150', treatment: 'REVENUE' });
      expect(tp.reviewNote).toMatch(/accountant/i);
      const audit = await t.sys.auditLog.findFirst({ where: { tenantId: alpha.id, action: 'finance.fee_component_updated' }, orderBy: { createdAt: 'desc' } });
      expect((audit!.before as any).treatment).toBe('PASS_THROUGH_LIABILITY');
      // back to the default for the rest of the suite
      await t.as(alpha.owner).put('/finance/fee-components', { components: [{ type: 'THIRD_PARTY_FEE', treatment: 'PASS_THROUGH_LIABILITY' }] }).expect(200);
    });

    it('never lets the service fee be anything but revenue', async () => {
      const res = await t.as(alpha.owner).put('/finance/fee-components', { components: [{ type: 'SERVICE_FEE', treatment: 'PASS_THROUGH_LIABILITY' }] });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('SERVICE_FEE_IS_REVENUE');
      // The database refuses it too.
      await expect(t.sys.feeComponent.updateMany({ where: { tenantId: alpha.id, type: 'SERVICE_FEE' }, data: { treatment: 'PASS_THROUGH_LIABILITY' } })).rejects.toThrow();
    });

    it('is restricted to finance.settings', async () => {
      await t.as(manager).put('/finance/fee-components', { components: [{ type: 'GOVERNMENT_FEE', taxable: true }] }).expect(403);
      await t.as(accountant).put('/finance/fee-components', { components: [{ type: 'GOVERNMENT_FEE', taxable: true }] }).expect(403);
      await t.as(accountant).get('/finance/fee-components').expect(200); // read for reporting
      await t.as(receptionist).get('/finance/fee-components').expect(403);
      await t.as(customer).get('/finance/fee-components').expect(403);
    });
  });

  // ---------------------------------------------------------------- quotations
  describe('quotations', () => {
    it('calculates lines and totals with the three components kept apart', async () => {
      const res = await t
        .as(receptionist)
        .post('/quotations', {
          customerId: customer.customerId,
          items: [line('SERVICE_FEE', '150.00'), line('GOVERNMENT_FEE', '250.25', { quantity: 2 }), line('THIRD_PARTY_FEE', '35.00')],
        })
        .expect(201);
      expect(res.body.quotationNo).toMatch(/^QUO-\d{6}$/);
      expect(res.body).toMatchObject({
        status: 'DRAFT',
        currency: 'AED',
        subtotalServiceFee: '150.00',
        subtotalGovernmentFee: '500.50',
        subtotalThirdParty: '35.00',
        discountTotal: '0.00',
        taxTotal: '7.50', // 5% on the service fee only
        total: '693.00',
        discountApproval: 'NONE',
      });
      const fee = res.body.quotationItems.find((i: any) => i.component === 'SERVICE_FEE');
      expect(fee).toMatchObject({ taxRatePercent: '5.00', taxAmount: '7.50', lineTotal: '157.50' });
      const gov = res.body.quotationItems.find((i: any) => i.component === 'GOVERNMENT_FEE');
      expect(gov).toMatchObject({ taxRatePercent: '0.00', taxAmount: '0.00', lineTotal: '500.50' });
      // default validity: 14 days
      const days = (new Date(res.body.validUntil).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(13.9);
      expect(days).toBeLessThan(14.1);
    });

    it('uses the tenant setting for validity and an explicit per-line tax rate', async () => {
      await t.as(alpha.owner).patch('/tenant/settings', { quotationValidityDays: 7 }).expect(200);
      const res = await t.as(receptionist).post('/quotations', { customerId: customer.customerId, items: [line('GOVERNMENT_FEE', '100.00', { taxRatePercent: 5 }), line('SERVICE_FEE', '10.10', { taxRatePercent: '0' })] }).expect(201);
      expect(res.body).toMatchObject({ taxTotal: '5.00', total: '115.10' });
      const days = (new Date(res.body.validUntil).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(6.9);
      expect(days).toBeLessThan(7.1);
      await t.as(alpha.owner).patch('/tenant/settings', { quotationValidityDays: 14 }).expect(200);
    });

    it('rejects invalid input with a clear message', async () => {
      const bad = await t.as(receptionist).post('/quotations', { customerId: customer.customerId, items: [line('SERVICE_FEE', '10.00', { discountAmount: '10.01', })], discountReason: 'x y z' });
      expect(bad.status).toBe(422);
      expect(bad.body.code).toBe('DISCOUNT_EXCEEDS_LINE');
      const govDiscount = await t.as(receptionist).post('/quotations', { customerId: customer.customerId, items: [line('GOVERNMENT_FEE', '100.00', { discountAmount: '5.00' })], discountReason: 'loyal customer' });
      expect(govDiscount.status).toBe(422);
      expect(govDiscount.body.code).toBe('DISCOUNT_ON_PASS_THROUGH');
      await t.as(receptionist).post('/quotations', { customerId: customer.customerId, items: [] }).expect(400);
      await t.as(receptionist).post('/quotations', { customerId: customer.customerId, items: [line('SERVICE_FEE', '10.999')] }).expect(400);
      await t.as(receptionist).post('/quotations', { customerId: customer.customerId, items: [line('SERVICE_FEE', '-1')] }).expect(400);
    });

    describe('built from a request', () => {
      let second: any;
      beforeAll(async () => {
        second = (await t.as(alpha.owner).post('/branches', { code: 'DXB2', name: 'Deira Branch' }).expect(201)).body;
      });

      it('uses the default price, with fee estimates as separate lines', async () => {
        const service = await createService(t, alpha, { name: 'Family visa', serviceFee: '120.00', governmentFee: '330.00', thirdPartyFee: '25.00' });
        const request = await createRequest(t, alpha, { customerId: customer.customerId!, serviceId: service.id });
        const res = await t.as(receptionist).post(`/quotations/from-request/${request.id}`, {}).expect(201);
        expect(res.body.requestId).toBe(request.id);
        expect(res.body.quotationItems.map((i: any) => [i.component, i.unitAmount, i.taxAmount])).toEqual([
          ['SERVICE_FEE', '120.00', '6.00'],
          ['GOVERNMENT_FEE', '330.00', '0.00'],
          ['THIRD_PARTY_FEE', '25.00', '0.00'],
        ]);
        expect(res.body.total).toBe('481.00');
        expect(res.body.quotationItems[1].description).toMatch(/government fee \(estimate\)/i);
      });

      it('prefers the branch price over the default', async () => {
        const service = await createService(t, alpha, { serviceFee: '100.00', governmentFee: '200.00', branchPrices: [{ branchId: second.id, serviceFee: '80.00', governmentFee: '210.00' }] });
        const here = await createRequest(t, alpha, { customerId: customer.customerId!, serviceId: service.id, branchId: second.id });
        const there = await createRequest(t, alpha, { customerId: customer.customerId!, serviceId: service.id });
        const branchQuote = await t.as(alpha.owner).post(`/quotations/from-request/${here.id}`, {}).expect(201);
        expect(branchQuote.body.subtotalServiceFee).toBe('80.00');
        expect(branchQuote.body.subtotalGovernmentFee).toBe('210.00');
        expect(branchQuote.body.branchId).toBe(second.id);
        const defaultQuote = await t.as(alpha.owner).post(`/quotations/from-request/${there.id}`, {}).expect(201);
        expect(defaultQuote.body.subtotalServiceFee).toBe('100.00');
      });

      it('applies the corporate contract price to the service fee only', async () => {
        const company = await createCorporate(t, alpha);
        const service = await createService(t, alpha, { serviceFee: '100.00', governmentFee: '200.00' });
        await t.sys.corporatePrice.create({ data: { tenantId: alpha.id, corporateAccountId: company.id, serviceId: service.id, serviceFee: '60.00' } });
        const employee = await createCustomer(t, alpha, { corporateAccountId: company.id });
        const request = await createRequest(t, alpha, { customerId: employee.id, serviceId: service.id, corporateAccountId: company.id });
        const res = await t.as(receptionist).post(`/quotations/from-request/${request.id}`, {}).expect(201);
        expect(res.body.corporateAccountId).toBe(company.id);
        expect(res.body.subtotalServiceFee).toBe('60.00');
        expect(res.body.subtotalGovernmentFee).toBe('200.00'); // government fee is never "discounted" by a contract
        expect(res.body.quotationItems[0].description).toMatch(/contract price/);
      });

      it('respects the service tax mode', async () => {
        const all = await createService(t, alpha, { taxMode: 'ALL_COMPONENTS', serviceFee: '100.00', governmentFee: '200.00' });
        const none = await createService(t, alpha, { taxMode: 'NONE', serviceFee: '100.00', governmentFee: '200.00' });
        const r1 = await createRequest(t, alpha, { customerId: customer.customerId!, serviceId: all.id });
        const r2 = await createRequest(t, alpha, { customerId: customer.customerId!, serviceId: none.id });
        expect((await t.as(receptionist).post(`/quotations/from-request/${r1.id}`, {}).expect(201)).body.taxTotal).toBe('15.00');
        expect((await t.as(receptionist).post(`/quotations/from-request/${r2.id}`, {}).expect(201)).body.taxTotal).toBe('0.00');
      });

      it('explains when the service has no price, and hides other tenants\' requests', async () => {
        const service = await createService(t, alpha, { noPrice: true });
        const request = await createRequest(t, alpha, { customerId: customer.customerId!, serviceId: service.id });
        const res = await t.as(receptionist).post(`/quotations/from-request/${request.id}`, {});
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('NO_PRICE');
        await t.as(beta.owner).post(`/quotations/from-request/${request.id}`, {}).expect(404);
      });
    });

    describe('discount approval (segregation of duties)', () => {
      let quotationId: string;

      it('a discount puts the draft in PENDING and blocks sending', async () => {
        const noReason = await t.as(manager).post('/quotations', { customerId: customer.customerId, items: [line('SERVICE_FEE', '200.00', { discountAmount: '50.00' })] });
        expect(noReason.status).toBe(422);
        expect(noReason.body.code).toBe('DISCOUNT_REASON_REQUIRED');
        const res = await t
          .as(manager)
          .post('/quotations', { customerId: customer.customerId, discountReason: 'Returning customer', items: [line('SERVICE_FEE', '200.00', { discountAmount: '50.00' }), line('GOVERNMENT_FEE', '100.00')] })
          .expect(201);
        quotationId = res.body.id;
        expect(res.body).toMatchObject({ discountApproval: 'PENDING', discountRequestedById: manager.userId, discountTotal: '50.00', taxTotal: '7.50', total: '257.50' });
        const send = await t.as(manager).post(`/quotations/${quotationId}/send`);
        expect(send.status).toBe(409);
        expect(send.body.code).toBe('DISCOUNT_APPROVAL_REQUIRED');
      });

      it('the requester cannot approve their own discount, and a role without discount.approve gets 403', async () => {
        const self = await t.as(manager).post(`/quotations/${quotationId}/discount/approve`, {});
        expect(self.status).toBe(403);
        expect(self.body.code).toBe('SELF_APPROVAL_FORBIDDEN');
        await t.as(receptionist).post(`/quotations/${quotationId}/discount/approve`, {}).expect(403);
        await t.as(accountant).post(`/quotations/${quotationId}/discount/approve`, {}).expect(403);
      });

      it('a different approver approves; the quotation can then be sent', async () => {
        const res = await t.as(alpha.owner).post(`/quotations/${quotationId}/discount/approve`, { note: 'ok for this customer' }).expect(200);
        expect(res.body).toMatchObject({ discountApproval: 'APPROVED', discountDecidedById: alpha.owner.userId });
        const audit = await t.sys.auditLog.findFirst({ where: { tenantId: alpha.id, action: 'quotation.discount_approved', resourceId: quotationId } });
        expect(audit!.after).toMatchObject({ selfApproved: false, requestedById: manager.userId, approvedById: alpha.owner.userId });
        await t.as(manager).post(`/quotations/${quotationId}/send`).expect(200);
      });

      it('changing the lines after approval restarts the approval', async () => {
        const q = (await t.as(manager).post('/quotations', { customerId: customer.customerId, discountReason: 'Bulk', items: [line('SERVICE_FEE', '100.00', { discountAmount: '10.00' })] }).expect(201)).body;
        await t.as(alpha.owner).post(`/quotations/${q.id}/discount/approve`, {}).expect(200);
        const edited = await t.as(manager).patch(`/quotations/${q.id}`, { items: [line('SERVICE_FEE', '100.00', { discountAmount: '60.00' })] }).expect(200);
        expect(edited.body.discountApproval).toBe('PENDING');
        expect((await t.as(manager).post(`/quotations/${q.id}/send`)).status).toBe(409);
      });

      it('rejecting clears the discounts (sendable draft) or keeps them for a new request', async () => {
        const a = (await t.as(manager).post('/quotations', { customerId: customer.customerId, discountReason: 'Friend', items: [line('SERVICE_FEE', '100.00', { discountAmount: '40.00' })] }).expect(201)).body;
        const cleared = await t.as(alpha.owner).post(`/quotations/${a.id}/discount/reject`, { reason: 'Too generous' }).expect(200);
        expect(cleared.body).toMatchObject({ status: 'DRAFT', discountApproval: 'NONE', discountTotal: '0.00', total: '105.00' });
        await t.as(manager).post(`/quotations/${a.id}/send`).expect(200);

        const b = (await t.as(manager).post('/quotations', { customerId: customer.customerId, discountReason: 'Friend', items: [line('SERVICE_FEE', '100.00', { discountAmount: '40.00' })] }).expect(201)).body;
        const kept = await t.as(alpha.owner).post(`/quotations/${b.id}/discount/reject`, { reason: 'Explain better', clearDiscounts: false }).expect(200);
        expect(kept.body).toMatchObject({ status: 'DRAFT', discountApproval: 'REJECTED', discountTotal: '40.00' });
        const send = await t.as(manager).post(`/quotations/${b.id}/send`);
        expect(send.body.code).toBe('DISCOUNT_REJECTED');
        const again = await t.as(manager).patch(`/quotations/${b.id}`, { discountReason: 'Customer brings 12 employees next month' }).expect(200);
        expect(again.body.discountApproval).toBe('PENDING');
      });

      it('an owner who is the only approver may self-approve, and the audit says so', async () => {
        // Beta has a single member holding discount.approve: its owner.
        const betaCustomer = await createCustomer(t, beta);
        const q = (await t.as(beta.owner).post('/quotations', { customerId: betaCustomer.id, discountReason: 'Opening offer', items: [line('SERVICE_FEE', '100.00', { discountAmount: '10.00' })] }).expect(201)).body;
        expect(q.discountApproval).toBe('PENDING');
        await t.as(beta.owner).post(`/quotations/${q.id}/discount/approve`, {}).expect(200);
        const audit = await t.sys.auditLog.findFirst({ where: { tenantId: beta.id, action: 'quotation.discount_approved', resourceId: q.id } });
        expect(audit!.after).toMatchObject({ selfApproved: true });
        // As soon as a second approver exists, self-approval is refused.
        await t.addStaff(beta, 'manager');
        const q2 = (await t.as(beta.owner).post('/quotations', { customerId: betaCustomer.id, discountReason: 'Opening offer', items: [line('SERVICE_FEE', '100.00', { discountAmount: '10.00' })] }).expect(201)).body;
        const refused = await t.as(beta.owner).post(`/quotations/${q2.id}/discount/approve`, {});
        expect(refused.status).toBe(403);
        expect(refused.body.code).toBe('SELF_APPROVAL_FORBIDDEN');
      });
    });

    describe('sending, superseding and the customer decision', () => {
      it('only a draft can be edited or sent', async () => {
        const q = (await t.as(receptionist).post('/quotations', { customerId: customer.customerId, items: [line('SERVICE_FEE', '50.00')] }).expect(201)).body;
        const sent = await t.as(receptionist).post(`/quotations/${q.id}/send`).expect(200);
        expect(sent.body.status).toBe('SENT');
        expect(sent.body.sentAt).toBeTruthy();
        const events = await outbox(t, alpha.id, 'quotation.sent');
        expect(events.some((e) => (e.payload as any).quotationId === q.id && (e.payload as any).total === '52.50' && (e.payload as any).currency === 'AED')).toBe(true);
        expect((await t.as(receptionist).patch(`/quotations/${q.id}`, { notes: 'late change' })).body.code).toBe('QUOTATION_NOT_DRAFT');
        expect((await t.as(receptionist).post(`/quotations/${q.id}/send`)).status).toBe(409);
        // The database also freezes the lines once the quotation left DRAFT.
        await expect(t.sys.quotationItem.updateMany({ where: { quotationId: q.id }, data: { unitAmount: '1.00' } })).rejects.toThrow(/frozen/);
      });

      it('a new quotation for the same request supersedes the earlier sent one', async () => {
        const service = await createService(t, alpha);
        const request = await createRequest(t, alpha, { customerId: customer.customerId!, serviceId: service.id });
        const first = (await t.as(receptionist).post(`/quotations/from-request/${request.id}`, {}).expect(201)).body;
        await t.as(receptionist).post(`/quotations/${first.id}/send`).expect(200);
        const second = (await t.as(receptionist).post(`/quotations/from-request/${request.id}`, {}).expect(201)).body;
        // Still SENT until the new one is actually sent.
        expect((await t.as(receptionist).get(`/quotations/${first.id}`)).body.status).toBe('SENT');
        await t.as(receptionist).post(`/quotations/${second.id}/send`).expect(200);
        expect((await t.as(receptionist).get(`/quotations/${first.id}`)).body.status).toBe('SUPERSEDED');
        const approveOld = await t.as(customer).post(`/quotations/${first.id}/approve`, {});
        expect(approveOld.status).toBe(409);
        expect(approveOld.body.code).toBe('QUOTATION_NOT_OPEN');
      });

      it('the owning customer approves: the invoice is created and issued in the same step', async () => {
        const service = await createService(t, alpha, { serviceFee: '100.00', governmentFee: '200.00' });
        const request = await createRequest(t, alpha, { customerId: customer.customerId!, serviceId: service.id });
        const q = (await t.as(receptionist).post(`/quotations/from-request/${request.id}`, {}).expect(201)).body;
        // Drafts are invisible to the customer.
        await t.as(customer).get(`/quotations/${q.id}`).expect(404);
        await t.as(receptionist).post(`/quotations/${q.id}/send`).expect(200);
        const seen = await t.as(customer).get(`/quotations/${q.id}`).expect(200);
        expect(seen.body.discountRequestedById).toBeUndefined();
        expect(seen.body.createdById).toBeUndefined();
        // Another customer of the same centre cannot see or approve it.
        await t.as(otherCustomer).get(`/quotations/${q.id}`).expect(404);
        await t.as(otherCustomer).post(`/quotations/${q.id}/approve`, {}).expect(404);

        const res = await t.as(customer).post(`/quotations/${q.id}/approve`, {}).expect(200);
        expect(res.body.quotation).toMatchObject({ status: 'APPROVED', decidedByType: 'CUSTOMER' });
        expect(res.body.invoice.invoiceNo).toMatch(/^INV-\d{6}$/);
        expect(res.body.invoice).toMatchObject({ status: 'ISSUED', total: '305.00', balanceDue: '305.00' });

        const invoice = await t.as(customer).get(`/invoices/${res.body.invoice.id}`).expect(200);
        expect(invoice.body).toMatchObject({ quotationId: q.id, requestId: request.id, subtotalServiceFee: '100.00', subtotalGovernmentFee: '200.00', taxTotal: '5.00', total: '305.00' });
        expect(invoice.body.invoiceItems).toHaveLength(2);

        for (const [type, check] of [
          ['quotation.approved', (p: any) => p.quotationId === q.id && p.approvedByType === 'CUSTOMER' && p.requestId === request.id],
          ['invoice.issued', (p: any) => p.invoiceId === res.body.invoice.id && p.total === '305.00' && p.currency === 'AED'],
          ['payment.requested', (p: any) => p.invoiceId === res.body.invoice.id && p.amount === '305.00'],
        ] as Array<[string, (p: any) => boolean]>) {
          expect((await outbox(t, alpha.id, type)).some((e) => check(e.payload))).toBe(true);
        }
        // Approving twice never creates a second invoice.
        expect((await t.as(customer).post(`/quotations/${q.id}/approve`, {})).status).toBe(409);
        expect(await t.sys.invoice.count({ where: { quotationId: q.id } })).toBe(1);
      });

      it('staff may record the decision on the customer\'s behalf, with a mandatory note in the audit', async () => {
        const q = (await t.as(receptionist).post('/quotations', { customerId: customer.customerId, items: [line('SERVICE_FEE', '40.00')] }).expect(201)).body;
        await t.as(receptionist).post(`/quotations/${q.id}/send`).expect(200);
        const missing = await t.as(receptionist).post(`/quotations/${q.id}/approve`, {});
        expect(missing.status).toBe(422);
        expect(missing.body.code).toBe('NOTE_REQUIRED');
        // An accountant has no quotation.manage and cannot decide for the customer.
        await t.as(accountant).post(`/quotations/${q.id}/approve`, { note: 'x' }).expect(403);
        const res = await t.as(receptionist).post(`/quotations/${q.id}/approve`, { note: 'Customer approved at the counter' }).expect(200);
        expect(res.body.quotation).toMatchObject({ status: 'APPROVED', decidedByType: 'STAFF', decidedById: receptionist.userId });
        const audit = await t.sys.auditLog.findFirst({ where: { tenantId: alpha.id, action: 'quotation.approved', resourceId: q.id } });
        expect(audit!.after).toMatchObject({ onBehalfOfCustomer: true, note: 'Customer approved at the counter', decidedByType: 'STAFF' });
      });

      it('a zero-total quotation issues a settled invoice without a payment request', async () => {
        const q = (await t.as(receptionist).post('/quotations', { customerId: otherCustomer.customerId, items: [line('SERVICE_FEE', '0')] }).expect(201)).body;
        await t.as(receptionist).post(`/quotations/${q.id}/send`).expect(200);
        const res = await t.as(otherCustomer).post(`/quotations/${q.id}/approve`, {}).expect(200);
        expect(res.body.invoice).toMatchObject({ status: 'PAID', total: '0.00', balanceDue: '0.00' });
        expect((await outbox(t, alpha.id, 'payment.requested')).some((e) => (e.payload as any).invoiceId === res.body.invoice.id)).toBe(false);
        expect((await outbox(t, alpha.id, 'invoice.issued')).some((e) => (e.payload as any).invoiceId === res.body.invoice.id)).toBe(true);
      });

      it('the customer can reject with a reason', async () => {
        const q = (await t.as(receptionist).post('/quotations', { customerId: customer.customerId, items: [line('SERVICE_FEE', '40.00')] }).expect(201)).body;
        await t.as(receptionist).post(`/quotations/${q.id}/send`).expect(200);
        await t.as(customer).post(`/quotations/${q.id}/reject`, {}).expect(400);
        const res = await t.as(customer).post(`/quotations/${q.id}/reject`, { reason: 'Too expensive' }).expect(200);
        expect(res.body).toMatchObject({ status: 'REJECTED', rejectionReason: 'Too expensive' });
        expect((await outbox(t, alpha.id, 'quotation.rejected')).some((e) => (e.payload as any).quotationId === q.id && (e.payload as any).reason === 'Too expensive')).toBe(true);
        expect((await t.as(customer).post(`/quotations/${q.id}/approve`, {})).status).toBe(409);
      });

      it('an expired quotation cannot be approved, and the scheduled job marks it EXPIRED', async () => {
        const mk = async () => {
          const q = (await t.as(receptionist).post('/quotations', { customerId: customer.customerId, items: [line('SERVICE_FEE', '40.00')] }).expect(201)).body;
          await t.as(receptionist).post(`/quotations/${q.id}/send`).expect(200);
          await t.sys.quotation.update({ where: { id: q.id }, data: { validUntil: new Date(Date.now() - 60_000) } });
          return q.id as string;
        };
        const a = await mk();
        const b = await mk();
        const fresh = (await t.as(receptionist).post('/quotations', { customerId: customer.customerId, items: [line('SERVICE_FEE', '40.00')] }).expect(201)).body;
        await t.as(receptionist).post(`/quotations/${fresh.id}/send`).expect(200);

        const res = await t.as(customer).post(`/quotations/${a}/approve`, {});
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('QUOTATION_EXPIRED');
        expect((await t.sys.quotation.findUniqueOrThrow({ where: { id: a } })).status).toBe('EXPIRED');
        expect(await t.sys.invoice.count({ where: { quotationId: a } })).toBe(0);

        expect(t.jobs.schedules().some((s) => s.name === EXPIRE_JOB)).toBe(true);
        await t.jobs.runScheduled(EXPIRE_JOB);
        expect((await t.sys.quotation.findUniqueOrThrow({ where: { id: b } })).status).toBe('EXPIRED');
        expect((await t.sys.quotation.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe('SENT');
      });

      it('a corporate admin approves quotations of their own company only', async () => {
        const company = await createCorporate(t, alpha);
        const rival = await createCorporate(t, alpha);
        const admin = await addCorporateAdmin(t, alpha, company.id);
        const rivalAdmin = await addCorporateAdmin(t, alpha, rival.id);
        const employee = await createCustomer(t, alpha, { corporateAccountId: company.id });
        const q = (await t.as(receptionist).post('/quotations', { customerId: employee.id, corporateAccountId: company.id, items: [line('SERVICE_FEE', '90.00')] }).expect(201)).body;
        await t.as(receptionist).post(`/quotations/${q.id}/send`).expect(200);
        await t.as(rivalAdmin).get(`/quotations/${q.id}`).expect(404);
        await t.as(rivalAdmin).post(`/quotations/${q.id}/approve`, {}).expect(404);
        const list = await t.as(admin).get('/quotations').expect(200);
        expect(list.body.data.map((r: any) => r.id)).toEqual([q.id]);
        const res = await t.as(admin).post(`/quotations/${q.id}/approve`, {}).expect(200);
        expect(res.body.quotation.decidedByType).toBe('CORPORATE');
        expect(res.body.invoice.status).toBe('ISSUED');
      });
    });

    it('lists with filters, scoped per audience', async () => {
      const mine = await t.as(customer).get('/quotations?pageSize=100').expect(200);
      expect(mine.body.data.length).toBeGreaterThan(0);
      expect(mine.body.data.every((q: any) => q.customerId === customer.customerId && q.status !== 'DRAFT')).toBe(true);
      // A customer filtering on someone else's id gets nothing, never the other person's rows.
      const sneaky = await t.as(customer).get(`/quotations?customerId=${otherCustomer.customerId}`).expect(200);
      expect(sneaky.body.data).toHaveLength(0);
      const approved = await t.as(receptionist).get(`/quotations?status=APPROVED&customerId=${customer.customerId}`).expect(200);
      expect(approved.body.data.length).toBeGreaterThan(0);
      expect(approved.body.data.every((q: any) => q.status === 'APPROVED')).toBe(true);
      expect(approved.body.meta.total).toBe(approved.body.data.length);
      const pending = await t.as(alpha.owner).get('/quotations?discountApproval=PENDING').expect(200);
      expect(pending.body.data.every((q: any) => q.discountApproval === 'PENDING')).toBe(true);
    });

    it('enforces permissions and tenant isolation', async () => {
      await t.as(accountant).post('/quotations', { customerId: customer.customerId, items: [line('SERVICE_FEE', '10.00')] }).expect(403);
      await t.as(customer).post('/quotations', { customerId: customer.customerId, items: [line('SERVICE_FEE', '10.00')] }).expect(403);
      await t.as(null).get('/quotations').expect(401);
      const q = (await t.as(receptionist).post('/quotations', { customerId: customer.customerId, items: [line('SERVICE_FEE', '10.00')] }).expect(201)).body;
      // Beta cannot read, change, send or reference Alpha's rows.
      await t.as(beta.owner).get(`/quotations/${q.id}`).expect(404);
      await t.as(beta.owner).patch(`/quotations/${q.id}`, { notes: 'hijack' }).expect(404);
      await t.as(beta.owner).post(`/quotations/${q.id}/send`).expect(404);
      await t.as(beta.owner).get(`/quotations/${q.id}/pdf`).expect(404);
      await t.as(beta.owner).post('/quotations', { customerId: customer.customerId, items: [line('SERVICE_FEE', '10.00')] }).expect(404);
      const betaList = await t.as(beta.owner).get('/quotations?pageSize=100').expect(200);
      expect(betaList.body.data.every((r: any) => r.tenantId === beta.id)).toBe(true);
    });

    it('operators limited to assigned requests see only quotations of those requests', async () => {
      const service = await createService(t, alpha);
      const assigned = await createRequest(t, alpha, { customerId: customer.customerId!, serviceId: service.id, assignedToId: operator.membershipId });
      const notMine = await createRequest(t, alpha, { customerId: customer.customerId!, serviceId: service.id });
      const a = (await t.as(receptionist).post(`/quotations/from-request/${assigned.id}`, {}).expect(201)).body;
      const b = (await t.as(receptionist).post(`/quotations/from-request/${notMine.id}`, {}).expect(201)).body;
      await t.as(operator).get(`/quotations/${a.id}`).expect(200);
      await t.as(operator).get(`/quotations/${b.id}`).expect(404);
      const list = await t.as(operator).get('/quotations?pageSize=100').expect(200);
      expect(list.body.data.map((q: any) => q.id)).toEqual([a.id]);
    });
  });

  // ---------------------------------------------------------------- invoices
  describe('invoices', () => {
    it('are drafted, edited, then issued with a gap-free number and a due date', async () => {
      await t.as(alpha.owner).patch('/tenant/settings', { invoiceDueDays: 3 }).expect(200);
      const draft = await t.as(accountant).post('/invoices', { customerId: customer.customerId, items: [line('SERVICE_FEE', '100.00')] }).expect(201);
      expect(draft.body.status).toBe('DRAFT');
      expect(draft.body.invoiceNo).toMatch(/^DRAFT-/);
      expect(draft.body.issuedAt).toBeNull();
      // Customers never see drafts.
      await t.as(customer).get(`/invoices/${draft.body.id}`).expect(404);
      const edited = await t.as(accountant).patch(`/invoices/${draft.body.id}`, { notes: 'Thank you', items: [line('SERVICE_FEE', '100.00'), line('GOVERNMENT_FEE', '50.00')] }).expect(200);
      expect(edited.body).toMatchObject({ total: '155.00', balanceDue: '155.00', notes: 'Thank you' });
      const issued = await t.as(accountant).post(`/invoices/${draft.body.id}/issue`).expect(200);
      expect(issued.body.invoiceNo).toMatch(/^INV-\d{6}$/);
      expect(issued.body).toMatchObject({ status: 'ISSUED', total: '155.00', balanceDue: '155.00', overdue: false });
      // The centre's terms are 3 days: due at the end of the third day on the centre's calendar.
      expect(issued.body.dueAt).toBe(endOfDubaiDay(issued.body.issuedAt, 3));
      // The next invoice gets the next number.
      const next = await issueInvoice(t, accountant, customer.customerId!);
      expect(Number(next.invoiceNo.slice(4))).toBe(Number(issued.body.invoiceNo.slice(4)) + 1);
      await t.as(alpha.owner).patch('/tenant/settings', { invoiceDueDays: 0 }).expect(200);
    });

    it('an issued invoice is immutable in the API and in the database', async () => {
      const inv = await issueInvoice(t, accountant, customer.customerId!);
      const edit = await t.as(accountant).patch(`/invoices/${inv.id}`, { items: [line('SERVICE_FEE', '1.00')] });
      expect(edit.status).toBe(409);
      expect(edit.body.code).toBe('INVOICE_ISSUED');
      expect((await t.as(accountant).post(`/invoices/${inv.id}/issue`)).body.code).toBe('INVOICE_ALREADY_ISSUED');
      // Even the system connection cannot change amounts, lines or delete it.
      await expect(t.sys.invoice.update({ where: { id: inv.id }, data: { total: '1.00', subtotalServiceFee: '1.00', subtotalGovernmentFee: 0, taxTotal: 0, balanceDue: '1.00' } })).rejects.toThrow(/immutable/);
      await expect(t.sys.invoiceItem.deleteMany({ where: { invoiceId: inv.id } })).rejects.toThrow(/frozen/);
      await expect(t.sys.invoice.delete({ where: { id: inv.id } })).rejects.toThrow();
      // And the tenant-scoped connection has no DELETE privilege at all.
      await expect(t.inTenant(alpha.id, () => t.db.tx((tx) => tx.invoice.deleteMany({ where: { id: inv.id } })))).rejects.toThrow(/permission denied/);
    });

    it('can be voided with a reason only while nothing is paid', async () => {
      const inv = await issueInvoice(t, accountant, customer.customerId!);
      await t.as(accountant).post(`/invoices/${inv.id}/void`, {}).expect(400);
      await t.as(receptionist).post(`/invoices/${inv.id}/void`, { reason: 'Wrong customer' }).expect(403);
      const res = await t.as(accountant).post(`/invoices/${inv.id}/void`, { reason: 'Wrong customer' }).expect(200);
      expect(res.body).toMatchObject({ status: 'VOID', voidReason: 'Wrong customer' });
      expect((await t.as(accountant).post(`/invoices/${inv.id}/void`, { reason: 'again' })).body.code).toBe('INVOICE_VOID');
      // The void reason is internal.
      expect((await t.as(customer).get(`/invoices/${inv.id}`).expect(200)).body.voidReason).toBeUndefined();
      const audit = await t.sys.auditLog.findFirst({ where: { tenantId: alpha.id, action: 'invoice.voided', resourceId: inv.id } });
      expect(audit!.after).toMatchObject({ status: 'VOID', reason: 'Wrong customer' });
    });

    it('a discounted direct invoice needs a discount approver who did not create it', async () => {
      const draft = (await t.as(accountant).post('/invoices', { customerId: customer.customerId, items: [line('SERVICE_FEE', '100.00', { discountAmount: '20.00' })] }).expect(201)).body;
      const res = await t.as(accountant).post(`/invoices/${draft.id}/issue`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('DISCOUNT_APPROVAL_REQUIRED');
      await t.as(manager).post(`/invoices/${draft.id}/issue`).expect(200);
      const own = (await t.as(manager).post('/invoices', { customerId: customer.customerId, items: [line('SERVICE_FEE', '100.00', { discountAmount: '20.00' })] }).expect(201)).body;
      const self = await t.as(manager).post(`/invoices/${own.id}/issue`);
      expect(self.status).toBe(403);
      expect(self.body.code).toBe('SELF_APPROVAL_FORBIDDEN');
      await t.as(alpha.owner).post(`/invoices/${own.id}/issue`).expect(200);
    });

    it('lists with filters, including overdue, and scopes customers to their own invoices', async () => {
      const inv = await issueInvoice(t, accountant, otherCustomer.customerId!);
      await t.sys.invoice.update({ where: { id: inv.id }, data: { dueAt: new Date(Date.now() - 3 * 86_400_000) } });
      const overdue = await t.as(accountant).get('/invoices?overdue=true&pageSize=100').expect(200);
      expect(overdue.body.data.map((i: any) => i.id)).toContain(inv.id);
      expect(overdue.body.data.every((i: any) => i.overdue === true)).toBe(true);
      const byCustomer = await t.as(accountant).get(`/invoices?customerId=${otherCustomer.customerId}&status=ISSUED`).expect(200);
      expect(byCustomer.body.data.every((i: any) => i.customerId === otherCustomer.customerId && i.status === 'ISSUED')).toBe(true);
      const mine = await t.as(otherCustomer).get('/invoices?pageSize=100').expect(200);
      expect(mine.body.data.length).toBeGreaterThan(0);
      expect(mine.body.data.every((i: any) => i.customerId === otherCustomer.customerId && i.status !== 'DRAFT')).toBe(true);
      await t.as(customer).get(`/invoices/${inv.id}`).expect(404);
      expect((await t.as(customer).get(`/invoices?customerId=${otherCustomer.customerId}`).expect(200)).body.data).toHaveLength(0);
    });

    it('enforces permissions, branch scope and tenant isolation', async () => {
      await t.as(receptionist).post('/invoices', { customerId: customer.customerId, items: [line('SERVICE_FEE', '10.00')] }).expect(403);
      await t.as(customer).post('/invoices', { customerId: customer.customerId, items: [line('SERVICE_FEE', '10.00')] }).expect(403);
      const inv = await issueInvoice(t, accountant, customer.customerId!);
      await t.as(beta.owner).get(`/invoices/${inv.id}`).expect(404);
      await t.as(beta.owner).post(`/invoices/${inv.id}/void`, { reason: 'hijack attempt' }).expect(404);
      await t.as(beta.owner).get(`/invoices/${inv.id}/pdf`).expect(404);
      await t.as(beta.owner).post('/invoices', { customerId: customer.customerId, items: [line('SERVICE_FEE', '10.00')] }).expect(404);
      expect((await t.sys.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('ISSUED');
      // Staff limited to another branch do not see head-office invoices.
      const branch = (await t.as(alpha.owner).post('/branches', { code: 'SHJ', name: 'Sharjah' }).expect(201)).body;
      const limited = await t.addStaff(alpha, 'accountant', { branchIds: [branch.id] });
      await t.as(limited).get(`/invoices/${inv.id}`).expect(404);
      const list = await t.as(limited).get('/invoices?pageSize=100').expect(200);
      expect(list.body.data.every((i: any) => i.branchId === branch.id)).toBe(true);
      const forbidden = await t.as(limited).post('/invoices', { customerId: customer.customerId, branchId: alpha.headOfficeId, items: [line('SERVICE_FEE', '10.00')] });
      expect(forbidden.status).toBe(403);
      expect(forbidden.body.code).toBe('BRANCH_FORBIDDEN');
      const ownBranch = await t.as(limited).post('/invoices', { customerId: customer.customerId, items: [line('SERVICE_FEE', '10.00')] }).expect(201);
      expect(ownBranch.body.branchId).toBe(branch.id);
    });
  });

  // ---------------------------------------------------------------- corporate billing
  describe('corporate billing', () => {
    it('applies payment terms and enforces the approved credit limit', async () => {
      const company = await createCorporate(t, alpha, { creditApproved: true, creditLimit: '500.00', paymentTermsDays: 30, companyName: 'Credit Co LLC' });
      const employee = await createCustomer(t, alpha, { corporateAccountId: company.id });
      const first = await issueInvoice(t, accountant, employee.id, { corporateAccountId: company.id }); // 305.00
      const full = await t.as(accountant).get(`/invoices/${first.id}`).expect(200);
      expect(full.body.dueAt).toBe(endOfDubaiDay(full.body.issuedAt, 30));
      expect(full.body.overdue).toBe(false);

      const draft = (await t.as(accountant).post('/invoices', { customerId: employee.id, corporateAccountId: company.id, items: [line('SERVICE_FEE', '100.00'), line('GOVERNMENT_FEE', '200.00')] }).expect(201)).body;
      const over = await t.as(accountant).post(`/invoices/${draft.id}/issue`);
      expect(over.status).toBe(422);
      expect(over.body.code).toBe('CREDIT_LIMIT_EXCEEDED');
      expect(over.body.details).toMatchObject({ creditLimit: '500.00', openBalance: '305.00', invoiceTotal: '305.00' });
      expect(over.body.message).toMatch(/Credit Co LLC/);
      // Still a draft: nothing was numbered or issued.
      expect((await t.sys.invoice.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('DRAFT');
      // Within the limit it works (305 + 195 = 500).
      const small = (await t.as(accountant).post('/invoices', { customerId: employee.id, corporateAccountId: company.id, items: [line('GOVERNMENT_FEE', '195.00')] }).expect(201)).body;
      await t.as(accountant).post(`/invoices/${small.id}/issue`).expect(200);
    });

    it('a company without approved credit pays like anyone else', async () => {
      const company = await createCorporate(t, alpha, { creditApproved: false, creditLimit: '10.00', paymentTermsDays: 45 });
      const employee = await createCustomer(t, alpha, { corporateAccountId: company.id });
      const inv = await issueInvoice(t, accountant, employee.id, { corporateAccountId: company.id });
      const full = (await t.as(accountant).get(`/invoices/${inv.id}`)).body;
      // No 45-day terms: the centre's own terms apply (3 days here, set in an earlier test), counted to the end of the day.
      const termsDays = ((await t.sys.tenant.findUniqueOrThrow({ where: { id: alpha.id } })).settings as any)?.invoiceDueDays ?? 0;
      expect(full.dueAt).toBe(endOfDubaiDay(full.issuedAt, termsDays));
      expect(full.overdue).toBe(false);
    });

    it('a quotation approval that would exceed the credit limit is refused as a whole', async () => {
      const company = await createCorporate(t, alpha, { creditApproved: true, creditLimit: '100.00', paymentTermsDays: 15 });
      const admin = await addCorporateAdmin(t, alpha, company.id);
      const employee = await createCustomer(t, alpha, { corporateAccountId: company.id });
      const q = (await t.as(receptionist).post('/quotations', { customerId: employee.id, corporateAccountId: company.id, items: [line('GOVERNMENT_FEE', '150.00')] }).expect(201)).body;
      await t.as(receptionist).post(`/quotations/${q.id}/send`).expect(200);
      const res = await t.as(admin).post(`/quotations/${q.id}/approve`, {});
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('CREDIT_LIMIT_EXCEEDED');
      expect((await t.sys.quotation.findUniqueOrThrow({ where: { id: q.id } })).status).toBe('SENT');
      expect(await t.sys.invoice.count({ where: { quotationId: q.id } })).toBe(0);
    });

    it('corporate admins see only their company\'s invoices and statement with ageing buckets', async () => {
      const company = await createCorporate(t, alpha, { creditApproved: true, creditLimit: '5000.00', paymentTermsDays: 30 });
      const rival = await createCorporate(t, alpha);
      const admin = await addCorporateAdmin(t, alpha, company.id);
      const rivalAdmin = await addCorporateAdmin(t, alpha, rival.id);
      const employee = await createCustomer(t, alpha, { corporateAccountId: company.id });
      const rivalEmployee = await createCustomer(t, alpha, { corporateAccountId: rival.id });
      const ages = [-5, 10, 45, 75, 120]; // days past due
      const ids: string[] = [];
      for (const days of ages) {
        const inv = await issueInvoice(t, accountant, employee.id, { corporateAccountId: company.id, serviceFee: '100.00', governmentFee: '0' }); // 105.00 each
        await t.sys.invoice.update({ where: { id: inv.id }, data: { dueAt: new Date(Date.now() - days * 86_400_000) } });
        ids.push(inv.id);
      }
      const rivalInvoice = await issueInvoice(t, accountant, rivalEmployee.id, { corporateAccountId: rival.id });

      const list = await t.as(admin).get('/corporate/invoices?pageSize=100').expect(200);
      expect(list.body.data.map((i: any) => i.id).sort()).toEqual([...ids].sort());
      await t.as(admin).get(`/invoices/${rivalInvoice.id}`).expect(404);
      await t.as(rivalAdmin).get(`/invoices/${ids[0]}`).expect(404);
      await t.as(customer).get('/corporate/invoices').expect(403);
      await t.as(receptionist).get('/corporate/invoices').expect(403);

      const statement = await t.as(admin).get('/corporate/invoices/statement').expect(200);
      expect(statement.body.account.id).toBe(company.id);
      expect(statement.body.openBalance).toBe('525.00');
      expect(statement.body.availableCredit).toBe('4475.00');
      expect(statement.body.ageing).toEqual({ current: '105.00', days1to30: '105.00', days31to60: '105.00', days61to90: '105.00', days90plus: '105.00' });
      expect(statement.body.invoices).toHaveLength(5);
      // Staff view of the same statement; another tenant gets 404.
      const staffView = await t.as(accountant).get(`/finance/corporate-accounts/${company.id}/statement`).expect(200);
      expect(staffView.body.openBalance).toBe('525.00');
      await t.as(beta.owner).get(`/finance/corporate-accounts/${company.id}/statement`).expect(404);
      await t.as(customer).get(`/finance/corporate-accounts/${company.id}/statement`).expect(403);
    });
  });

  // ---------------------------------------------------------------- PDFs
  describe('PDF documents', () => {
    it('streams branded PDFs for quotation and invoice, authorised like the JSON detail', async () => {
      const q = (await t.as(receptionist).post('/quotations', { customerId: customer.customerId, items: [line('SERVICE_FEE', '100.00'), line('GOVERNMENT_FEE', '200.00'), line('THIRD_PARTY_FEE', '30.00')] }).expect(201)).body;
      await t.as(receptionist).post(`/quotations/${q.id}/send`).expect(200);
      const qPdf = await t.as(customer).get(`/quotations/${q.id}/pdf`).buffer(true).parse(binary).expect(200);
      expect(qPdf.headers['content-type']).toBe('application/pdf');
      expect(qPdf.headers['content-disposition']).toMatch(/quotation-QUO-\d{6}\.pdf/);
      expect((qPdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      expect((qPdf.body as Buffer).length).toBeGreaterThan(1500);
      await t.as(otherCustomer).get(`/quotations/${q.id}/pdf`).expect(404);

      const inv = await issueInvoice(t, accountant, customer.customerId!, { thirdPartyFee: '30.00' });
      const iPdf = await t.as(customer).get(`/invoices/${inv.id}/pdf`).buffer(true).parse(binary).expect(200);
      expect((iPdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      expect(iPdf.headers['cache-control']).toMatch(/no-store/);
      await t.as(otherCustomer).get(`/invoices/${inv.id}/pdf`).expect(404);
      await t.as(null).get(`/invoices/${inv.id}/pdf`).expect(401);
    });
  });
});

function binary(res: any, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}
