import { Injectable } from '@nestjs/common';
import type { CorporateEmployeeInput, CorporateEmployeeListQuery, UpdateCorporateEmployeeInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { blindIndex, maskTail } from '../../common/crypto';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { pageResult } from '../../common/pagination';
import { CustomersService } from '../customers/customers.service';
import { DuplicatesService } from '../customers/duplicates.service';
import { customerErasedError, ERASED_CUSTOMER_STATUS, isErasedCustomer } from '../../common/customer-ref';
import { CorporateAccess } from './corporate-access.service';
import { CorporateEmployeeLoginsService, EmployeeLoginState } from './employee-logins.service';

const PERSON_SELECT = {
  id: true, customerNo: true, status: true, fullName: true, fullNameAr: true, email: true, phone: true, nationality: true, dateOfBirth: true,
  emiratesIdLast4: true, emiratesIdExpiry: true, passportNoLast4: true, passportCountry: true, passportExpiry: true,
} as const;
const EMPLOYEE_INCLUDE = { customer: { select: PERSON_SELECT } } as const;
const PERSON_FIELDS = ['fullName', 'fullNameAr', 'email', 'phone', 'nationality', 'dateOfBirth', 'emiratesId', 'emiratesIdExpiry', 'passportNo', 'passportCountry', 'passportExpiry'] as const;
const dateOnly = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

type Account = { id: string; accountNo: string; status: string };
type EmployeeRow = {
  id: string; corporateAccountId: string; customerId: string; employeeNo: string | null; designation: string | null; status: string; createdAt: Date; updatedAt: Date;
  customer: {
    id: string; customerNo: string; status: string; fullName: string; fullNameAr: string | null; email: string | null; phone: string | null; nationality: string | null; dateOfBirth: Date | null;
    emiratesIdLast4: string | null; emiratesIdExpiry: Date | null; passportNoLast4: string | null; passportCountry: string | null; passportExpiry: Date | null;
  };
};

/**
 * One employee as shown to staff and to the company's authorised users.
 * Identity numbers are masked for everyone here; staff with the sensitive-read
 * permission use GET /customers/:id/identity, which is audited.
 */
const NO_LOGIN: EmployeeLoginState = { status: 'NONE', email: null, invitedAt: null, joinedAt: null, lastLoginAt: null };

function employeeView(e: EmployeeRow, forPortal: boolean, login: EmployeeLoginState = NO_LOGIN) {
  const p = e.customer;
  return {
    id: e.id,
    corporateAccountId: e.corporateAccountId,
    employeeNo: e.employeeNo,
    designation: e.designation,
    status: e.status,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    // The id of the person's record: the key by which a company's portal asks for this person's requests,
    // documents and reminders (`?customerId=`). The centre's customer number and record status stay internal.
    customerId: e.customerId,
    // `erased`: the person's data was erased; the row is kept because past requests of the company point at it.
    ...(forPortal ? {} : { customerNo: p.customerNo, customerStatus: p.status, erased: isErasedCustomer(p) }),
    fullName: p.fullName,
    fullNameAr: p.fullNameAr,
    email: p.email,
    phone: p.phone,
    nationality: p.nationality,
    dateOfBirth: dateOnly(p.dateOfBirth),
    emiratesIdMasked: maskTail(p.emiratesIdLast4),
    emiratesIdExpiry: dateOnly(p.emiratesIdExpiry),
    passportNoMasked: maskTail(p.passportNoLast4),
    passportCountry: p.passportCountry,
    passportExpiry: dateOnly(p.passportExpiry),
    /** Portal access of this employee: NONE, INVITED (not accepted yet), ACTIVE or SUSPENDED. */
    login,
  };
}

export type EmployeeOutcome = 'CREATED' | 'LINKED_EXISTING_CUSTOMER' | 'ALREADY_EMPLOYEE';

/**
 * A company's employee directory. Every employee is backed by a customer
 * record of the centre (type INDIVIDUAL, linked to the company), so documents
 * and requests hang off a person, not off a spreadsheet row.
 */
@Injectable()
export class CorporateEmployeesService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly access: CorporateAccess,
    private readonly customers: CustomersService,
    private readonly duplicates: DuplicatesService,
    private readonly logins: CorporateEmployeeLoginsService,
  ) {}

  // ------------------------------------------------------------------ scope
  /** Staff name the company; a portal user's company comes from their membership and nowhere else. */
  private scope(tx: Tx, accountId: string | null, write: boolean): Promise<Account> {
    return this.access.scope(tx, accountId, write);
  }
  private get portal() {
    return this.access.isPortalUser();
  }

  // ------------------------------------------------------------------ read
  list(accountId: string | null, query: CorporateEmployeeListQuery) {
    return this.db.tx(async (tx) => {
      const account = await this.scope(tx, accountId, false);
      const q = query.q;
      const where = {
        tenantId: this.db.tenantId,
        corporateAccountId: account.id,
        // A company never sees a person whose data was erased; staff see the row, marked `erased`, under "ALL" / "INACTIVE".
        ...(this.portal ? { customer: { status: { not: ERASED_CUSTOMER_STATUS } } } : {}),
        ...(query.status === 'ALL' ? {} : { status: query.status ?? 'ACTIVE' }),
        ...(q
          ? { OR: [{ customer: { fullName: { contains: q, mode: 'insensitive' as const } } }, { customer: { fullNameAr: { contains: q } } }, { employeeNo: { contains: q, mode: 'insensitive' as const } }, { designation: { contains: q, mode: 'insensitive' as const } }] }
          : {}),
      };
      const page = Math.max(1, query.page ?? 1);
      const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
      const [field, dir] = (query.sort ?? 'createdAt:desc').split(':');
      const direction = dir === 'asc' ? ('asc' as const) : ('desc' as const);
      const orderBy = field === 'fullName' ? { customer: { fullName: direction } } : field === 'employeeNo' ? { employeeNo: direction } : { createdAt: field === 'createdAt' ? direction : ('desc' as const) };
      const [rows, total] = await Promise.all([
        tx.corporateEmployee.findMany({ where, include: EMPLOYEE_INCLUDE, orderBy: [orderBy, { id: 'asc' }], skip: (page - 1) * pageSize, take: pageSize }),
        tx.corporateEmployee.count({ where }),
      ]);
      const logins = await this.logins.statesFor(tx, rows.map((r) => r.id));
      return pageResult(rows.map((r) => employeeView(r, this.portal, logins.get(r.id))), total, query);
    });
  }

  private async require(tx: Tx, account: Account, employeeId: string): Promise<EmployeeRow> {
    return found(
      await tx.corporateEmployee.findFirst({
        where: { id: employeeId, corporateAccountId: account.id, tenantId: this.db.tenantId, ...(this.portal ? { customer: { status: { not: ERASED_CUSTOMER_STATUS } } } : {}) },
        include: EMPLOYEE_INCLUDE,
      }),
      'Employee',
    );
  }
  get(accountId: string | null, employeeId: string) {
    return this.db.tx(async (tx) => {
      const employee = await this.require(tx, await this.scope(tx, accountId, false), employeeId);
      return employeeView(employee, this.portal, await this.logins.stateOf(tx, employee.id));
    });
  }

  // ------------------------------------------------------------------ create
  /**
   * An existing customer is re-used only when it already belongs to THIS company
   * and its passport or Emirates ID matches exactly (blind index). A person known
   * to the centre in another context is never attached to a company by this
   * route: that would hand the company somebody else's history.
   */
  private async matchInCompany(tx: Tx, account: Account, input: { emiratesId?: string | null; passportNo?: string | null }) {
    const tenantId = this.db.tenantId;
    const or = [
      input.emiratesId ? { emiratesIdHash: blindIndex(tenantId, 'emiratesId', input.emiratesId) } : null,
      input.passportNo ? { passportNoHash: blindIndex(tenantId, 'passport', input.passportNo) } : null,
    ].filter((c): c is NonNullable<typeof c> => !!c);
    if (!or.length) return null;
    return tx.customer.findFirst({ where: { tenantId, corporateAccountId: account.id, deletedAt: null, status: { in: ['ACTIVE', 'ARCHIVED'] }, OR: or }, select: { id: true, status: true }, orderBy: { createdAt: 'asc' } });
  }

  private async createOne(tx: Tx, account: Account, input: CorporateEmployeeInput): Promise<{ outcome: EmployeeOutcome; employee: EmployeeRow }> {
    const tenantId = this.db.tenantId;
    const { employeeNo, designation, ...person } = input;
    // Two uploads of the same person at the same moment must not both miss the match below.
    await this.duplicates.lock(tx, { emiratesId: person.emiratesId, passportNo: person.passportNo });
    const match = await this.matchInCompany(tx, account, person);
    if (match) {
      const existing = await tx.corporateEmployee.findFirst({ where: { tenantId, corporateAccountId: account.id, customerId: match.id }, include: EMPLOYEE_INCLUDE });
      if (existing) return { outcome: 'ALREADY_EMPLOYEE', employee: existing };
      const linked = await tx.corporateEmployee.create({ data: { tenantId, corporateAccountId: account.id, customerId: match.id, employeeNo: employeeNo ?? null, designation: designation ?? null }, include: EMPLOYEE_INCLUDE });
      await this.audit.log({ action: 'corporate.employee_added', resourceType: 'CorporateAccount', resourceId: account.id, summary: `${linked.customer.fullName} added to ${account.accountNo} (existing customer record)`, after: { employeeId: linked.id, customerId: match.id, employeeNo, designation, reusedCustomer: true } }, tx);
      return { outcome: 'LINKED_EXISTING_CUSTOMER', employee: linked };
    }
    // The company supplies the details; the person was not at the counter, so no consent is recorded in their name.
    const customer = await this.customers.create({ ...person, type: 'INDIVIDUAL', preferredLanguage: 'en', corporateAccountId: account.id }, { source: 'CORPORATE', allowDuplicates: true, recordConsents: false });
    const employee = await tx.corporateEmployee.create({ data: { tenantId, corporateAccountId: account.id, customerId: customer.id, employeeNo: employeeNo ?? null, designation: designation ?? null }, include: EMPLOYEE_INCLUDE });
    await this.audit.log({ action: 'corporate.employee_added', resourceType: 'CorporateAccount', resourceId: account.id, summary: `${employee.customer.fullName} added to ${account.accountNo}`, after: { employeeId: employee.id, customerId: customer.id, employeeNo, designation, reusedCustomer: false } }, tx);
    return { outcome: 'CREATED', employee };
  }

  create(accountId: string | null, input: CorporateEmployeeInput) {
    return this.db.tx(async (tx) => {
      const account = await this.scope(tx, accountId, true);
      const { outcome, employee } = await this.createOne(tx, account, input);
      if (outcome === 'ALREADY_EMPLOYEE') {
        throw Errors.conflict('EMPLOYEE_EXISTS', `${employee.customer.fullName} is already in the employee list${employee.status === 'INACTIVE' ? ' (inactive). Reactivate the existing record instead.' : '.'}`, { employeeId: employee.id, status: employee.status });
      }
      return { ...employeeView(employee, this.portal, await this.logins.stateOf(tx, employee.id)), outcome };
    });
  }

  /** Up to 200 employees in one transaction. People already on the list are reported, not duplicated. */
  createMany(accountId: string | null, inputs: CorporateEmployeeInput[]) {
    return this.db.tx(
      async (tx) => {
        const account = await this.scope(tx, accountId, true);
        const created: Array<ReturnType<typeof employeeView> & { index: number; outcome: EmployeeOutcome }> = [];
        const skipped: Array<{ index: number; reason: 'ALREADY_EMPLOYEE'; employeeId: string; fullName: string }> = [];
        for (const [index, input] of inputs.entries()) {
          const { outcome, employee } = await this.createOne(tx, account, input);
          if (outcome === 'ALREADY_EMPLOYEE') skipped.push({ index, reason: outcome, employeeId: employee.id, fullName: employee.customer.fullName });
          else created.push({ index, outcome, ...employeeView(employee, this.portal) });
        }
        return { created, skipped, createdCount: created.length, skippedCount: skipped.length };
      },
      { timeoutMs: 120_000 },
    );
  }

  // ------------------------------------------------------------------ update / deactivate
  async update(accountId: string | null, employeeId: string, input: UpdateCorporateEmployeeInput) {
    const { view, suspendedUserIds } = await this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const account = await this.scope(tx, accountId, true);
      const before = await this.require(tx, account, employeeId);
      if (isErasedCustomer(before.customer)) throw customerErasedError();
      const personChanges = Object.fromEntries(PERSON_FIELDS.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]));
      if (Object.keys(personChanges).length) {
        if (before.customer.status !== 'ACTIVE') throw Errors.conflict('EMPLOYEE_RECORD_LOCKED', 'The personal details of this employee can no longer be changed here. Please contact the centre.');
        // A changed identity number must not collide with a colleague in the same company.
        const clash = await this.matchInCompany(tx, account, { emiratesId: input.emiratesId, passportNo: input.passportNo });
        if (clash && clash.id !== before.customerId) throw Errors.conflict('EMPLOYEE_EXISTS', 'Another employee of this company already has this Emirates ID or passport number.');
        await this.customers.update(before.customerId, personChanges, { allowDuplicates: true });
      }
      const data: Record<string, unknown> = {};
      if (input.employeeNo !== undefined) data.employeeNo = input.employeeNo;
      if (input.designation !== undefined) data.designation = input.designation;
      let suspended: string[] = [];
      if (input.status && input.status !== before.status) {
        data.status = input.status;
        if (input.status === 'INACTIVE') {
          // Someone who left the company must not keep a portal login tied to that employment.
          const memberships = await tx.tenantMembership.findMany({ where: { tenantId, corporateEmployeeId: employeeId, status: { in: ['ACTIVE', 'INVITED'] } }, select: { id: true, userId: true } });
          if (memberships.length) await tx.tenantMembership.updateMany({ where: { id: { in: memberships.map((m) => m.id) }, tenantId }, data: { status: 'SUSPENDED' } });
          suspended = memberships.map((m) => m.userId);
        }
      }
      if (Object.keys(data).length) await tx.corporateEmployee.update({ where: { id: employeeId }, data });
      const after = await this.require(tx, account, employeeId);
      const changed = [...Object.keys(personChanges), ...Object.keys(data)];
      if (changed.length) {
        await this.audit.log(
          { action: input.status === 'INACTIVE' && before.status !== 'INACTIVE' ? 'corporate.employee_deactivated' : 'corporate.employee_updated', resourceType: 'CorporateAccount', resourceId: account.id, summary: `${after.customer.fullName}: ${changed.join(', ')}`, before: { employeeId, employeeNo: before.employeeNo, designation: before.designation, status: before.status }, after: { employeeId, employeeNo: after.employeeNo, designation: after.designation, status: after.status, changed } },
          tx,
        );
      }
      return { view: employeeView(after, this.portal, await this.logins.stateOf(tx, employeeId)), suspendedUserIds: suspended };
    });
    await this.access.endSessions(suspendedUserIds, 'EMPLOYEE_DEACTIVATED');
    return view;
  }
}
