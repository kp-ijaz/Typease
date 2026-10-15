import { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { createCustomer, createRequest, createService } from '../finance/fixtures';
import { localDate } from '../reminders/dates';

describe('Payroll', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let accountant: Actor;
  let operator: Actor;
  let receptionist: Actor;
  let runId: string;
  const commissionIds: string[] = [];
  const period = localDate(new Date(), 'Asia/Dubai').slice(0, 7);
  const IBAN = 'AE070331234567890123456';

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    accountant = await t.addStaff(alpha, 'accountant');
    operator = await t.addStaff(alpha, 'operator');
    receptionist = await t.addStaff(alpha, 'receptionist');
    // 40.00 of unpaid commission for the operator, earned this month.
    const service = await createService(t, alpha);
    const customer = await createCustomer(t, alpha);
    const rule = await t.sys.commissionRule.create({ data: { tenantId: alpha.id, beneficiary: 'OPERATOR', kind: 'FIXED', value: '20.00', createdById: alpha.owner.userId! } });
    for (let i = 0; i < 2; i++) {
      const request = await createRequest(t, alpha, { customerId: customer.id, serviceId: service.id, status: 'COMPLETED' });
      const e = await t.sys.commissionEntry.create({ data: { tenantId: alpha.id, ruleId: rule.id, requestId: request.id, serviceId: service.id, membershipId: operator.membershipId!, userId: operator.userId!, beneficiary: 'OPERATOR', basis: '100.00', kind: 'FIXED', value: '20.00', amount: '20.00', currency: 'AED' } });
      commissionIds.push(e.id);
    }
  });
  afterAll(() => t.close());

  it('sets up pay per staff member; IBANs are encrypted and WPS needs its details', async () => {
    await t.as(receptionist).put(`/payroll/staff/${operator.membershipId}`, { basicSalary: '3000' }).expect(403);
    await t.as(accountant).put(`/payroll/staff/${operator.membershipId}`, { basicSalary: '3000', payMethod: 'WPS' }).expect(422);
    await t.as(accountant).put(`/payroll/staff/${operator.membershipId}`, { basicSalary: '3000', payMethod: 'WPS', employeeWpsId: '12345678901234', bankRoutingCode: '803320101', iban: 'GB00 1234' }).expect(400);
    await t.as(accountant).put(`/payroll/staff/${operator.membershipId}`, { basicSalary: '3000.00', housingAllowance: '1000.00', transportAllowance: '500.00', payMethod: 'WPS', employeeWpsId: '12345678901234', bankRoutingCode: '803320101', iban: 'AE07 0331 2345 6789 0123 456' }).expect(200);
    await t.as(accountant).put(`/payroll/staff/${receptionist.membershipId}`, { basicSalary: '2500.00', payMethod: 'CASH', includeCommission: false }).expect(200);
    const stored = await t.sys.staffPay.findFirstOrThrow({ where: { membershipId: operator.membershipId! } });
    expect(stored.ibanEnc).not.toContain('0331234567');
    expect(stored.ibanLast4).toBe('3456');
    const staff = (await t.as(accountant).get('/payroll/staff').expect(200)).body;
    expect(staff.find((s: { membershipId: string }) => s.membershipId === operator.membershipId).pay).toMatchObject({ monthlyTotal: '4500.00', ibanMasked: expect.stringContaining('3456') });
    expect(JSON.stringify(staff)).not.toContain(IBAN);
  });

  it('drafts the month with salaries, allowances and unpaid commission', async () => {
    await t.as(accountant).post('/payroll/runs', { period: '2099-01' }).expect(422);
    const run = (await t.as(accountant).post('/payroll/runs', { period }).expect(201)).body;
    runId = run.id;
    await t.as(accountant).post('/payroll/runs', { period }).expect(409);
    expect(run).toMatchObject({ status: 'DRAFT', runNo: expect.stringMatching(/^PR-\d{6}$/), totalNet: '7040.00' });
    const op = run.lines.find((l: { membershipId: string }) => l.membershipId === operator.membershipId);
    expect(op).toMatchObject({ basicSalary: '3000.00', allowances: '1500.00', commission: '40.00', gross: '4540.00', net: '4540.00' });
    expect(op.commissionEntryIds.sort()).toEqual([...commissionIds].sort());
  });

  it('adjusts a line pro rata while it is a draft', async () => {
    const run = (await t.as(accountant).get(`/payroll/runs/${runId}`).expect(200)).body;
    const rec = run.lines.find((l: { membershipId: string }) => l.membershipId === receptionist.membershipId);
    const half = Math.floor(rec.daysInPeriod / 2);
    const updated = (await t.as(accountant).patch(`/payroll/runs/${runId}/lines/${rec.id}`, { daysWorked: rec.daysInPeriod, overtime: '200.00', deductions: '100.00', deductionNote: 'Advance' }).expect(200)).body;
    expect(updated.lines.find((l: { id: string }) => l.id === rec.id)).toMatchObject({ basicSalary: '2500.00', overtime: '200.00', deductions: '100.00', gross: '2700.00', net: '2600.00' });
    const prorated = (await t.as(accountant).patch(`/payroll/runs/${runId}/lines/${rec.id}`, { daysWorked: half }).expect(200)).body;
    expect(Number(prorated.lines.find((l: { id: string }) => l.id === rec.id).basicSalary)).toBeCloseTo((2500 * half) / rec.daysInPeriod, 2);
    await t.as(accountant).patch(`/payroll/runs/${runId}/lines/${rec.id}`, { daysWorked: rec.daysInPeriod, deductions: '99999' }).expect(422);
    await t.as(accountant).patch(`/payroll/runs/${runId}/lines/${rec.id}`, { daysWorked: rec.daysInPeriod }).expect(200);
  });

  it('produces the WPS file for the staff paid through WPS', async () => {
    await t.as(accountant).get(`/payroll/runs/${runId}/wps`).expect(409);
    await t.as(accountant).post(`/payroll/runs/${runId}/approve`).expect(200);
    await t.as(accountant).patch(`/payroll/runs/${runId}/lines/${(await t.sys.payrollLine.findFirstOrThrow({ where: { runId } })).id}`, { overtime: '1' }).expect(409);
    expect((await t.as(accountant).get(`/payroll/runs/${runId}/wps`)).body.code).toBe('WPS_EMPLOYER_MISSING');
    await t.as(accountant).put('/payroll/settings', { wpsEmployerId: '1234567890123', wpsBankRoutingCode: '803320101' }).expect(200);
    const file = await t.as(accountant).get(`/payroll/runs/${runId}/wps`).expect(200);
    expect(file.headers['content-disposition']).toMatch(/1234567890123\d{12}\.SIF/);
    const lines = file.text.trim().split('\r\n');
    expect(lines).toHaveLength(2); // the receptionist is paid in cash
    const [y, m] = period.split('-');
    expect(lines[0]).toMatch(new RegExp(`^EDR,12345678901234,803320101,${IBAN},${period}-01,${period}-\\d{2},\\d{2},4500\\.00,40\\.00,0$`));
    expect(lines[1]).toMatch(new RegExp(`^SCR,1234567890123,803320101,\\d{4}-\\d{2}-\\d{2},\\d{4},${m}${y},1,4540\\.00,AED,PR-\\d{6}$`));
  });

  it('paying marks the commission paid and posts the month to the books; a paid run is final', async () => {
    const paid = (await t.as(accountant).post(`/payroll/runs/${runId}/pay`, { paidFrom: 'BANK', reference: 'WPS OCT' }).expect(200)).body;
    expect(paid.status).toBe('PAID');
    const entries = await t.sys.commissionEntry.findMany({ where: { id: { in: commissionIds } } });
    expect(entries.every((e) => e.status === 'PAID' && e.payoutRef === paid.runNo)).toBe(true);
    const journal = await t.sys.journalEntry.findFirstOrThrow({ where: { tenantId: alpha.id, sourceType: 'PAYROLL', sourceId: runId }, include: { lines: { include: { account: true } } } });
    const by = (k: string) => journal.lines.find((l) => l.account.systemKey === k)!;
    expect([by('EXP_SALARIES').debit.toFixed(2), by('COMMISSION_PAYABLE').debit.toFixed(2), by('BANK').credit.toFixed(2)]).toEqual(['7100.00', '40.00', '7140.00']); // 4,540 + 2,500 + 200 overtime - 100 deduction
    await t.as(accountant).delete(`/payroll/runs/${runId}`).expect(409);
    await expect(t.sys.payrollLine.updateMany({ where: { runId }, data: { deductions: 1 } })).rejects.toThrow(/draft/);
  });

  it('staff see their own payslips only', async () => {
    const mine = (await t.as(operator).get('/payroll/payslips/mine').expect(200)).body;
    expect(mine).toEqual([expect.objectContaining({ period, net: '4540.00', status: 'PAID' })]);
    const pdf = await t.as(operator).get(`/payroll/payslips/${mine[0].id}/pdf`).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    const other = await t.sys.payrollLine.findFirstOrThrow({ where: { runId, membershipId: receptionist.membershipId! } });
    await t.as(operator).get(`/payroll/payslips/${other.id}/pdf`).expect(404);
    await t.as(accountant).get(`/payroll/payslips/${other.id}/pdf`).expect(200);
    await t.as(operator).get('/payroll/runs').expect(403);
    expect((await t.as(beta.owner).get('/payroll/runs').expect(200)).body).toEqual([]);
  });
});
