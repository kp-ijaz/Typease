import { Injectable } from '@nestjs/common';
import type { PayrollSettingsInput, StaffPayInput, UpdatePayrollLineInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { decryptText, encryptText } from '../../common/crypto';
import { Prisma, TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { D, sum } from '../../common/pagination';
import { SequenceService } from '../../common/sequence.service';
import { fmt } from '../finance/finance.calc';
import { LedgerService } from '../finance/ledger.service';
import { FinancePdfService } from '../finance/pdf.service';
import { localDate } from '../reminders/dates';
import { renderPayslip } from './payslip.renderer';

type Dec = Prisma.Decimal;
const daysIn = (period: string) => new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).getUTCDate();
const prorate = (monthly: Dec | string, worked: number, days: number) => D(monthly).mul(worked).div(days).toDecimalPlaces(2);

/**
 * Payroll of a centre. Each active staff member with a pay set-up gets a line per month: salary and allowances
 * (pro rata for the days worked), overtime, unpaid commission earned up to the end of the month, and deductions.
 * A run is drafted, approved and paid; paying marks the commission as paid and posts one journal (salaries and
 * commission payable against the bank or cash). The WPS salary file is produced from an approved run.
 */
@Injectable()
export class PayrollService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly sequences: SequenceService,
    private readonly ledger: LedgerService,
    private readonly pdfs: FinancePdfService,
  ) {}

  // ------------------------------------------------------------------ settings and pay set-up
  async settings() {
    return this.db.tx(async (tx) => {
      const s = ((await tx.tenant.findFirstOrThrow({ where: { id: this.db.tenantId }, select: { settings: true } })).settings ?? {}) as Record<string, unknown>;
      return { wpsEmployerId: (s.wpsEmployerId as string) ?? null, wpsBankRoutingCode: (s.wpsBankRoutingCode as string) ?? null };
    });
  }
  async updateSettings(input: PayrollSettingsInput) {
    return this.db.tx(async (tx) => {
      const t = await tx.tenant.findFirstOrThrow({ where: { id: this.db.tenantId }, select: { settings: true } });
      const next = { ...((t.settings ?? {}) as object), ...(input.wpsEmployerId !== undefined ? { wpsEmployerId: input.wpsEmployerId } : {}), ...(input.wpsBankRoutingCode !== undefined ? { wpsBankRoutingCode: input.wpsBankRoutingCode } : {}) };
      await tx.tenant.update({ where: { id: this.db.tenantId }, data: { settings: next as Prisma.InputJsonValue } });
      await this.audit.log({ action: 'payroll.settings_updated', resourceType: 'Tenant', resourceId: this.db.tenantId, after: input }, tx);
      return this.settings();
    });
  }

  /** Every active staff member with their pay set-up (empty when none yet). The IBAN is shown masked only. */
  async staff() {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const members = await tx.tenantMembership.findMany({ where: { tenantId, kind: 'STAFF', status: 'ACTIVE' }, select: { id: true, jobTitle: true, user: { select: { fullName: true } }, role: { select: { name: true } } }, orderBy: { user: { fullName: 'asc' } } });
      const pay = new Map((await tx.staffPay.findMany({ where: { tenantId } })).map((p) => [p.membershipId, p]));
      return members.map((m) => {
        const p = pay.get(m.id);
        return {
          membershipId: m.id,
          name: m.user.fullName,
          jobTitle: m.jobTitle,
          role: m.role?.name ?? null,
          pay: p
            ? { basicSalary: fmt(p.basicSalary), housingAllowance: fmt(p.housingAllowance), transportAllowance: fmt(p.transportAllowance), otherAllowance: fmt(p.otherAllowance), payMethod: p.payMethod, employeeWpsId: p.employeeWpsId, bankRoutingCode: p.bankRoutingCode, ibanMasked: p.ibanLast4 ? `AE•• •••• •••• •••• ••${p.ibanLast4}` : null, includeCommission: p.includeCommission, isActive: p.isActive, monthlyTotal: fmt(D(p.basicSalary).plus(p.housingAllowance).plus(p.transportAllowance).plus(p.otherAllowance)) }
            : null,
        };
      });
    });
  }

  async setPay(membershipId: string, input: StaffPayInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      found(await tx.tenantMembership.findFirst({ where: { id: membershipId, tenantId, kind: 'STAFF' }, select: { id: true } }), 'Staff member');
      if (input.payMethod === 'WPS' && (!input.employeeWpsId || !input.bankRoutingCode)) {
        const existing = await tx.staffPay.findFirst({ where: { tenantId, membershipId } });
        if (!existing?.ibanEnc && !input.iban) throw Errors.unprocessable('WPS_DETAILS_REQUIRED', 'Salary through WPS needs the person code, the bank routing code and the IBAN.');
      }
      const { iban, ...fields } = input;
      const data = { ...fields, ...(iban ? { ibanEnc: encryptText(iban), ibanLast4: iban.slice(-4) } : iban === null ? { ibanEnc: null, ibanLast4: null } : {}) };
      await tx.staffPay.upsert({ where: { tenantId_membershipId: { tenantId, membershipId } }, create: { tenantId, membershipId, ...data }, update: data });
      await this.audit.log({ action: 'payroll.pay_updated', resourceType: 'TenantMembership', resourceId: membershipId, after: { ...fields, iban: iban ? `••${iban.slice(-4)}` : undefined } }, tx);
      return { membershipId };
    });
  }

  // ------------------------------------------------------------------ runs
  private async loadRun(tx: Tx, id: string) {
    return found(await tx.payrollRun.findFirst({ where: { id, tenantId: this.db.tenantId }, include: { lines: { orderBy: { staffName: 'asc' } } } }), 'Payroll run');
  }
  private present(run: Prisma.PayrollRunGetPayload<{ include: { lines: true } }>) {
    const money = (v: Dec) => fmt(v);
    return {
      ...run,
      totalGross: money(run.totalGross),
      totalDeductions: money(run.totalDeductions),
      totalNet: money(run.totalNet),
      lines: run.lines.map((l) => ({ ...l, basicSalary: money(l.basicSalary), allowances: money(l.allowances), overtime: money(l.overtime), commission: money(l.commission), deductions: money(l.deductions), gross: money(l.gross), net: money(l.net) })),
    };
  }
  private async totals(tx: Tx, runId: string) {
    const lines = await tx.payrollLine.findMany({ where: { runId } });
    await tx.payrollRun.update({ where: { id: runId }, data: { totalGross: sum(lines.map((l) => D(l.gross))), totalDeductions: sum(lines.map((l) => D(l.deductions))), totalNet: sum(lines.map((l) => D(l.net))) } });
  }

  async runs() {
    return this.db.tx((tx) => tx.payrollRun.findMany({ where: { tenantId: this.db.tenantId }, orderBy: { period: 'desc' } }));
  }
  async get(id: string) {
    return this.db.tx(async (tx) => this.present(await this.loadRun(tx, id)));
  }

  /** Drafts the month: one line per active pay set-up, with unpaid commission earned up to the end of the month. */
  async create(period: string, notes?: string | null) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      if (await tx.payrollRun.findFirst({ where: { tenantId, period }, select: { id: true } })) throw Errors.conflict('RUN_EXISTS', `There is already a payroll for ${period}.`);
      const tenant = await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { defaultCurrency: true, timezone: true } });
      if (period > localDate(new Date(), tenant.timezone).slice(0, 7)) throw Errors.unprocessable('FUTURE_PERIOD', 'Payroll can be prepared for the current month or earlier.');
      const pays = await tx.staffPay.findMany({ where: { tenantId, isActive: true, basicSalary: { gt: 0 }, membership: { status: 'ACTIVE', kind: 'STAFF' } }, include: { membership: { select: { jobTitle: true, user: { select: { fullName: true } } } } } });
      if (!pays.length) throw Errors.unprocessable('NO_STAFF_PAY', 'Set up the salary of at least one staff member first.');
      const run = await tx.payrollRun.create({ data: { tenantId, runNo: await this.sequences.next(tx, 'payroll'), period, currency: tenant.defaultCurrency, notes: notes ?? null, createdById: ctx().userId ?? null } });
      const days = daysIn(period);
      const end = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 1));
      for (const p of pays) {
        const commission = p.includeCommission ? await tx.commissionEntry.findMany({ where: { tenantId, membershipId: p.membershipId, status: 'ACCRUED', earnedAt: { lt: end } }, select: { id: true, amount: true } }) : [];
        const basic = D(p.basicSalary);
        const allowances = D(p.housingAllowance).plus(p.transportAllowance).plus(p.otherAllowance);
        const commissionTotal = sum(commission.map((c) => D(c.amount)));
        const gross = basic.plus(allowances).plus(commissionTotal);
        await tx.payrollLine.create({
          data: {
            tenantId, runId: run.id, membershipId: p.membershipId, staffName: p.membership.user.fullName, jobTitle: p.membership.jobTitle, payMethod: p.payMethod,
            daysWorked: days, daysInPeriod: days, basicSalary: basic, allowances, commission: commissionTotal, gross, net: gross, commissionEntryIds: commission.map((c) => c.id),
          },
        });
      }
      await this.totals(tx, run.id);
      await this.audit.log({ action: 'payroll.drafted', resourceType: 'PayrollRun', resourceId: run.id, summary: `${run.runNo} drafted for ${period} (${pays.length} staff)` }, tx);
      return this.present(await this.loadRun(tx, run.id));
    });
  }

  async updateLine(runId: string, lineId: string, input: UpdatePayrollLineInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const run = await this.loadRun(tx, runId);
      if (run.status !== 'DRAFT') throw Errors.conflict('RUN_NOT_DRAFT', 'Only a draft payroll can be changed.');
      const line = found(run.lines.find((l) => l.id === lineId), 'Line');
      const pay = found(await tx.staffPay.findFirst({ where: { tenantId, membershipId: line.membershipId } }), 'Pay set-up');
      const worked = input.daysWorked ?? line.daysWorked;
      if (worked > line.daysInPeriod) throw Errors.unprocessable('TOO_MANY_DAYS', `${line.daysInPeriod} days in this month.`);
      const basic = prorate(pay.basicSalary, worked, line.daysInPeriod);
      const allowances = prorate(D(pay.housingAllowance).plus(pay.transportAllowance).plus(pay.otherAllowance), worked, line.daysInPeriod);
      const overtime = input.overtime !== undefined ? D(input.overtime) : D(line.overtime);
      const deductions = input.deductions !== undefined ? D(input.deductions) : D(line.deductions);
      const gross = basic.plus(allowances).plus(overtime).plus(line.commission);
      if (deductions.gt(gross)) throw Errors.unprocessable('DEDUCTIONS_TOO_HIGH', 'Deductions cannot be more than the pay of the month.');
      await tx.payrollLine.update({ where: { id: lineId }, data: { daysWorked: worked, basicSalary: basic, allowances, overtime, deductions, deductionNote: input.deductionNote !== undefined ? input.deductionNote : line.deductionNote, gross, net: gross.minus(deductions) } });
      await this.totals(tx, runId);
      return this.present(await this.loadRun(tx, runId));
    });
  }

  async remove(runId: string) {
    return this.db.tx(async (tx) => {
      const run = await this.loadRun(tx, runId);
      if (run.status === 'PAID') throw Errors.conflict('RUN_PAID', 'A paid payroll is final.');
      if (run.status === 'APPROVED') await tx.payrollRun.update({ where: { id: runId }, data: { status: 'DRAFT', approvedAt: null, approvedById: null } });
      await tx.payrollRun.delete({ where: { id: runId } });
      await this.audit.log({ action: 'payroll.deleted', resourceType: 'PayrollRun', resourceId: runId, summary: `${run.runNo} (${run.period}) deleted` }, tx);
      return { deleted: true };
    });
  }

  async approve(runId: string) {
    return this.db.tx(async (tx) => {
      const run = await this.loadRun(tx, runId);
      if (run.status !== 'DRAFT') throw Errors.conflict('RUN_NOT_DRAFT', 'This payroll is already approved.');
      await tx.payrollRun.update({ where: { id: runId }, data: { status: 'APPROVED', approvedAt: new Date(), approvedById: ctx().userId ?? null } });
      await this.audit.log({ action: 'payroll.approved', resourceType: 'PayrollRun', resourceId: runId, summary: `${run.runNo} approved: ${run.currency} ${fmt(run.totalNet)} net` }, tx);
      return this.present(await this.loadRun(tx, runId));
    });
  }

  /** Paid: commission included is marked paid, and one balanced journal records the month. */
  async pay(runId: string, paidFrom: 'BANK' | 'CASH', reference: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const run = await this.loadRun(tx, runId);
      if (run.status !== 'APPROVED') throw Errors.conflict('RUN_NOT_APPROVED', 'Approve the payroll before recording the payment.');
      const ids = run.lines.flatMap((l) => l.commissionEntryIds);
      if (ids.length) {
        const changed = await tx.commissionEntry.updateMany({ where: { tenantId, id: { in: ids }, status: 'ACCRUED' }, data: { status: 'PAID', paidAt: new Date(), paidById: ctx().userId!, payoutRef: run.runNo } });
        if (changed.count !== ids.length) throw Errors.conflict('COMMISSION_CHANGED', 'Some of the commission in this payroll was paid or cancelled in the meantime. Delete the payroll and prepare it again.');
      }
      await tx.payrollRun.update({ where: { id: runId }, data: { status: 'PAID', paidAt: new Date(), paidById: ctx().userId ?? null, paymentReference: reference } });
      const commission = sum(run.lines.map((l) => D(l.commission)));
      const net = sum(run.lines.map((l) => D(l.net)));
      const tenant = await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { timezone: true } });
      await this.ledger.post(tx, tenantId, { date: new Date(`${localDate(new Date(), tenant.timezone)}T00:00:00.000Z`), memo: `Payroll ${run.runNo} (${run.period})`, sourceType: 'PAYROLL', sourceId: run.id }, [
        { account: 'EXP_SALARIES', debit: net.minus(commission) },
        { account: 'COMMISSION_PAYABLE', debit: commission },
        { account: paidFrom, credit: net },
      ]);
      await this.audit.log({ action: 'payroll.paid', resourceType: 'PayrollRun', resourceId: runId, summary: `${run.runNo} paid from ${paidFrom.toLowerCase()} (ref ${reference}): ${run.currency} ${fmt(net)}`, after: { commission: fmt(commission), net: fmt(net) } }, tx);
      return this.present(await this.loadRun(tx, runId));
    });
  }

  // ------------------------------------------------------------------ WPS salary information file
  /**
   * The Salary Information File (SIF) of the UAE Wage Protection System: one EDR line per employee paid through
   * WPS, then the SCR control line. Banks and exchange houses accept it as is; check the layout with yours once.
   */
  async sif(runId: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const run = await this.loadRun(tx, runId);
      if (run.status === 'DRAFT') throw Errors.conflict('RUN_NOT_APPROVED', 'Approve the payroll before creating the WPS file.');
      const s = await this.settings();
      if (!s.wpsEmployerId || !s.wpsBankRoutingCode) throw Errors.unprocessable('WPS_EMPLOYER_MISSING', 'Enter the employer id and the bank routing code in the payroll settings.');
      const pays = new Map((await tx.staffPay.findMany({ where: { tenantId, membershipId: { in: run.lines.map((l) => l.membershipId) } } })).map((p) => [p.membershipId, p]));
      const wps = run.lines.filter((l) => l.payMethod === 'WPS');
      const missing = wps.filter((l) => { const p = pays.get(l.membershipId); return !p?.employeeWpsId || !p.bankRoutingCode || !p.ibanEnc; });
      if (missing.length) throw Errors.unprocessable('WPS_DETAILS_MISSING', `WPS details are missing for: ${missing.map((m) => m.staffName).join(', ')}.`);
      const [y, m] = run.period.split('-');
      const start = `${run.period}-01`;
      const end = `${run.period}-${String(daysIn(run.period)).padStart(2, '0')}`;
      const edr = wps.map((l) => {
        const p = pays.get(l.membershipId)!;
        const fixed = Prisma.Decimal.min(D(l.basicSalary).plus(l.allowances), D(l.net));
        const variable = D(l.net).minus(fixed);
        return ['EDR', p.employeeWpsId, p.bankRoutingCode, decryptText(p.ibanEnc!), start, end, String(l.daysInPeriod), fmt(fixed), fmt(variable), String(l.daysInPeriod - l.daysWorked)].join(',');
      });
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const total = sum(wps.map((l) => D(l.net)));
      const scr = ['SCR', s.wpsEmployerId, s.wpsBankRoutingCode, `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`, `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`, `${m}${y}`, String(edr.length), fmt(total), run.currency, run.runNo].join(',');
      const stamp = `${String(now.getUTCFullYear()).slice(2)}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
      await this.audit.log({ action: 'payroll.wps_file', resourceType: 'PayrollRun', resourceId: runId, summary: `WPS file for ${run.runNo}: ${edr.length} employees, ${fmt(total)}` }, tx);
      return { filename: `${s.wpsEmployerId}${stamp}.SIF`, content: `${[...edr, scr].join('\r\n')}\r\n` };
    });
  }

  // ------------------------------------------------------------------ payslips
  /** Staff with payroll.manage: any payslip. Everyone else: their own, once the run is approved. */
  async payslip(lineId: string, manage: boolean) {
    const { line, run } = await this.db.tx(async (tx) => {
      const l = found(await tx.payrollLine.findFirst({ where: { id: lineId, tenantId: this.db.tenantId }, include: { run: true } }), 'Payslip');
      if (!manage && (l.membershipId !== ctx().membershipId || l.run.status === 'DRAFT')) throw Errors.notFound('Payslip');
      return { line: l, run: l.run };
    });
    const brand = await this.pdfs.brand(null, 'invoiceFooter');
    const content = await renderPayslip({
      brand,
      runNo: run.runNo,
      period: run.period,
      currency: run.currency,
      status: run.status,
      staffName: line.staffName,
      jobTitle: line.jobTitle,
      daysWorked: line.daysWorked,
      daysInPeriod: line.daysInPeriod,
      earnings: [
        ['Basic salary', 'الراتب الأساسي', fmt(line.basicSalary)],
        ['Allowances', 'البدلات', fmt(line.allowances)],
        ['Overtime', 'العمل الإضافي', fmt(line.overtime)],
        ['Commission', 'العمولات', fmt(line.commission)],
      ],
      deductions: fmt(line.deductions),
      deductionNote: line.deductionNote,
      gross: fmt(line.gross),
      net: fmt(line.net),
      paidAt: run.paidAt ? run.paidAt.toISOString().slice(0, 10) : null,
    });
    return { filename: `payslip-${run.period}-${line.staffName.replace(/[^A-Za-z0-9]+/g, '-')}.pdf`, content };
  }

  async myPayslips() {
    return this.db.tx(async (tx) => {
      const lines = await tx.payrollLine.findMany({ where: { tenantId: this.db.tenantId, membershipId: ctx().membershipId ?? '00000000-0000-0000-0000-000000000000', run: { status: { in: ['APPROVED', 'PAID'] } } }, include: { run: { select: { period: true, status: true, runNo: true, currency: true, paidAt: true } } }, orderBy: { run: { period: 'desc' } } });
      return lines.map((l) => ({ id: l.id, period: l.run.period, runNo: l.run.runNo, status: l.run.status, paidAt: l.run.paidAt, currency: l.run.currency, gross: fmt(l.gross), deductions: fmt(l.deductions), net: fmt(l.net) }));
    });
  }
}
