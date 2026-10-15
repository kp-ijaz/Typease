import { Injectable } from '@nestjs/common';
import { Prisma } from '@typease/database';
import { OPEN_STATUSES } from '@typease/types';
import type { CorporateAccountInput, CorporateAccountListQuery, CorporateCreditDecisionInput, UpdateCorporateAccountInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors } from '../../common/errors';
import { D, pageArgs, pageResult, sum } from '../../common/pagination';
import { SequenceService } from '../../common/sequence.service';
import { UsageService } from '../../common/usage.service';
import { CorporateAccess } from './corporate-access.service';

const ACCOUNT_SORT = ['createdAt', 'companyName', 'accountNo'] as const;
const dateOnly = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const parseDate = (v: string | null | undefined) => (v ? new Date(`${v}T00:00:00.000Z`) : null);
const pick = (obj: Record<string, any>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, obj[k] instanceof Date ? obj[k].toISOString() : (obj[k] ?? null)]));

type AccountRow = Awaited<ReturnType<CorporateAccess['requireAccount']>>;

/** Staff view: everything, with the licence expiry as a plain date. */
export function accountView(a: AccountRow) {
  const { deletedAt: _deleted, tradeLicenceExpiry, ...rest } = a;
  return { ...rest, tradeLicenceExpiry: dateOnly(tradeLicenceExpiry) };
}
/** What the company sees of its own account: no internal notes, no staff ids, and credit terms only once approved. */
export function portalAccountView(a: AccountRow) {
  return {
    id: a.id,
    accountNo: a.accountNo,
    companyName: a.companyName,
    companyNameAr: a.companyNameAr,
    tradeLicenceNo: a.tradeLicenceNo,
    tradeLicenceAuthority: a.tradeLicenceAuthority,
    tradeLicenceExpiry: dateOnly(a.tradeLicenceExpiry),
    taxRegistrationNo: a.taxRegistrationNo,
    billingEmail: a.billingEmail,
    billingAddress: a.billingAddress ?? null,
    status: a.status,
    verified: !!a.verifiedAt,
    verifiedAt: a.verifiedAt,
    credit: a.creditApproved ? { approved: true as const, limit: a.creditLimit?.toFixed(2) ?? null, paymentTermsDays: a.paymentTermsDays } : { approved: false as const, limit: null, paymentTermsDays: 0 },
  };
}

/** Corporate accounts as the centre's staff manage them. */
@Injectable()
export class CorporateAccountsService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly sequences: SequenceService,
    private readonly usage: UsageService,
    private readonly access: CorporateAccess,
  ) {}

  list(query: CorporateAccountListQuery) {
    return this.db.tx(async (tx) => {
      const q = query.q;
      const where = {
        tenantId: this.db.tenantId,
        deletedAt: null,
        ...(query.status === 'ALL' ? {} : query.status ? { status: query.status } : { status: { not: 'ARCHIVED' as const } }),
        ...(q
          ? { OR: [{ companyName: { contains: q, mode: 'insensitive' as const } }, { companyNameAr: { contains: q } }, { accountNo: q.toUpperCase() }, { tradeLicenceNo: { contains: q, mode: 'insensitive' as const } }] }
          : {}),
      };
      const [rows, total] = await Promise.all([
        tx.corporateAccount.findMany({
          where,
          include: { _count: { select: { corporateEmployees: { where: { status: 'ACTIVE' } }, corporateMembers: { where: { status: { in: ['ACTIVE', 'INVITED'] } } } } } },
          ...pageArgs(query, ACCOUNT_SORT, 'createdAt:desc'),
        }),
        tx.corporateAccount.count({ where }),
      ]);
      return pageResult(rows.map(({ _count, ...a }) => ({ ...accountView(a), employeeCount: _count.corporateEmployees, memberCount: _count.corporateMembers })), total, query);
    });
  }

  /** Money owed and work in progress for one company. */
  async counters(tx: Tx, account: AccountRow) {
    const tenantId = this.db.tenantId;
    const [employees, members, openRequests, totalRequests, unpaid] = await Promise.all([
      tx.corporateEmployee.count({ where: { tenantId, corporateAccountId: account.id, status: 'ACTIVE' } }),
      tx.corporateMember.count({ where: { tenantId, corporateAccountId: account.id, status: { in: ['ACTIVE', 'INVITED'] } } }),
      tx.serviceRequest.count({ where: { tenantId, corporateAccountId: account.id, deletedAt: null, status: { in: OPEN_STATUSES } } }),
      tx.serviceRequest.count({ where: { tenantId, corporateAccountId: account.id, deletedAt: null } }),
      tx.invoice.findMany({ where: { tenantId, corporateAccountId: account.id, status: { in: ['ISSUED', 'PARTIALLY_PAID'] } }, select: { balanceDue: true } }),
    ]);
    const outstanding = sum(unpaid.map((i) => i.balanceDue));
    // A credit limit means something only after it has been approved.
    const available = account.creditApproved && account.creditLimit ? Prisma.Decimal.max(D(0), account.creditLimit.minus(outstanding)) : null;
    return { employees, members, openRequests, totalRequests, unpaidInvoices: unpaid.length, unpaidInvoicesBalance: outstanding.toFixed(2), creditAvailable: available ? available.toFixed(2) : null };
  }

  get(id: string) {
    return this.db.tx(async (tx) => {
      const account = await this.access.requireAccount(tx, id);
      return { ...accountView(account), counters: await this.counters(tx, account) };
    });
  }

  private async assertLicenceFree(tx: Tx, tradeLicenceNo: string, exceptId?: string) {
    const clash = await tx.corporateAccount.findFirst({
      where: { tenantId: this.db.tenantId, deletedAt: null, status: { not: 'ARCHIVED' }, tradeLicenceNo: { equals: tradeLicenceNo, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true, accountNo: true, companyName: true },
    });
    if (clash) {
      throw Errors.conflict('DUPLICATE_TRADE_LICENCE', `${clash.companyName} (${clash.accountNo}) is already registered with this trade licence number.`, { corporateAccountId: clash.id });
    }
  }

  create(input: CorporateAccountInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      await this.usage.assertWithinLimit('corporateClients', tx);
      if (input.tradeLicenceNo) await this.assertLicenceFree(tx, input.tradeLicenceNo);
      const { tradeLicenceExpiry, billingAddress, ...fields } = input;
      const account = await tx.corporateAccount.create({
        data: {
          tenantId,
          accountNo: await this.sequences.next(tx, 'corporate'),
          companyName: fields.companyName,
          companyNameAr: fields.companyNameAr ?? null,
          tradeLicenceNo: fields.tradeLicenceNo ?? null,
          tradeLicenceAuthority: fields.tradeLicenceAuthority ?? null,
          tradeLicenceExpiry: parseDate(tradeLicenceExpiry),
          taxRegistrationNo: fields.taxRegistrationNo ?? null,
          billingEmail: fields.billingEmail ?? null,
          ...(billingAddress ? { billingAddress: billingAddress as Prisma.InputJsonValue } : {}),
          paymentTermsDays: fields.paymentTermsDays,
          creditLimit: fields.creditLimit ?? null,
          notes: fields.notes ?? null,
          // A new company is never trusted automatically: authorisation and credit are separate decisions.
          status: 'PENDING_VERIFICATION',
          creditApproved: false,
        },
      });
      await this.audit.log({ action: 'corporate.account_created', resourceType: 'CorporateAccount', resourceId: account.id, summary: `${account.accountNo} ${account.companyName}`, after: accountView(account) }, tx);
      return accountView(account);
    });
  }

  update(id: string, input: UpdateCorporateAccountInput) {
    return this.db.tx(async (tx) => {
      const before = await this.access.requireAccount(tx, id);
      this.access.assertNotArchived(before);
      if (input.tradeLicenceNo && input.tradeLicenceNo.toLowerCase() !== (before.tradeLicenceNo ?? '').toLowerCase()) await this.assertLicenceFree(tx, input.tradeLicenceNo, id);
      const { tradeLicenceExpiry, billingAddress, ...fields } = input;
      const data: Record<string, unknown> = { ...fields };
      if (tradeLicenceExpiry !== undefined) data.tradeLicenceExpiry = parseDate(tradeLicenceExpiry);
      if (billingAddress !== undefined) data.billingAddress = billingAddress === null ? Prisma.DbNull : billingAddress;
      // Approved credit covers exactly the terms that were approved. Changing them needs a new approval.
      const limitChanged = input.creditLimit !== undefined && !D(input.creditLimit).equals(D(before.creditLimit)) && !(input.creditLimit === null && before.creditLimit === null);
      const termsChanged = input.paymentTermsDays !== undefined && input.paymentTermsDays !== before.paymentTermsDays;
      const creditReset = before.creditApproved && (limitChanged || termsChanged);
      if (creditReset) data.creditApproved = false;
      const after = await tx.corporateAccount.update({ where: { id }, data });
      const keys = [...Object.keys(input), ...(creditReset ? ['creditApproved'] : [])];
      await this.audit.log(
        { action: 'corporate.account_updated', resourceType: 'CorporateAccount', resourceId: id, summary: `${before.accountNo}: ${keys.join(', ')}${creditReset ? ' (credit approval withdrawn: terms changed)' : ''}`, before: pick(before, keys), after: pick(after, keys) },
        tx,
      );
      return { ...accountView(after), creditApprovalWithdrawn: creditReset };
    });
  }

  // ------------------------------------------------------------------ verification and credit (corporate.verify)
  /** The centre confirms that the company is who it says it is and that its contacts may act for it. */
  verify(id: string, note: string) {
    return this.db.tx(async (tx) => {
      const before = await this.access.requireAccount(tx, id);
      this.access.assertNotArchived(before);
      if (before.verifiedAt) throw Errors.conflict('ALREADY_VERIFIED', 'This company has already been verified.');
      const after = await tx.corporateAccount.update({ where: { id }, data: { status: 'ACTIVE', verifiedById: ctx().userId ?? null, verifiedAt: new Date() } });
      await this.audit.log(
        { action: 'corporate.account_verified', resourceType: 'CorporateAccount', resourceId: id, summary: `${before.accountNo} verified: ${note}`, before: { status: before.status, verifiedAt: null }, after: { status: 'ACTIVE', verifiedAt: after.verifiedAt, note } },
        tx,
      );
      return accountView(after);
    });
  }

  decideCredit(id: string, input: CorporateCreditDecisionInput) {
    return this.db.tx(async (tx) => {
      const before = await this.access.requireAccount(tx, id);
      this.access.assertNotArchived(before);
      const data: Record<string, unknown> = { creditApproved: input.approved };
      if (input.creditLimit !== undefined) data.creditLimit = input.creditLimit;
      if (input.paymentTermsDays !== undefined) data.paymentTermsDays = input.paymentTermsDays;
      if (input.approved) {
        if (!before.verifiedAt) throw Errors.unprocessable('CORPORATE_NOT_VERIFIED', 'Verify the company before approving credit.');
        const limit = D(input.creditLimit ?? before.creditLimit);
        if (!limit.greaterThan(0)) throw Errors.unprocessable('CREDIT_LIMIT_REQUIRED', 'Enter the credit limit that is being approved.');
      }
      const after = await tx.corporateAccount.update({ where: { id }, data });
      await this.audit.log(
        {
          action: input.approved ? 'corporate.credit_approved' : 'corporate.credit_revoked',
          resourceType: 'CorporateAccount',
          resourceId: id,
          summary: `${before.accountNo}: credit ${input.approved ? 'approved' : 'not approved'} - ${input.note}`,
          before: { creditApproved: before.creditApproved, creditLimit: before.creditLimit?.toFixed(2) ?? null, paymentTermsDays: before.paymentTermsDays },
          after: { creditApproved: after.creditApproved, creditLimit: after.creditLimit?.toFixed(2) ?? null, paymentTermsDays: after.paymentTermsDays, note: input.note },
        },
        tx,
      );
      return accountView(after);
    });
  }

  // ------------------------------------------------------------------ status
  suspend(id: string, reason: string) {
    return this.db.tx(async (tx) => {
      const before = await this.access.requireAccount(tx, id);
      if (before.status !== 'ACTIVE') {
        throw Errors.conflict('INVALID_STATUS', before.status === 'SUSPENDED' ? 'This account is already suspended.' : 'Only an active account can be suspended.');
      }
      const after = await tx.corporateAccount.update({ where: { id }, data: { status: 'SUSPENDED' } });
      await this.audit.log({ action: 'corporate.account_suspended', resourceType: 'CorporateAccount', resourceId: id, summary: `${before.accountNo} suspended: ${reason}`, before: { status: before.status }, after: { status: 'SUSPENDED', reason } }, tx);
      return accountView(after);
    });
  }

  /** Lifts a suspension, or brings an archived account back (which counts against the plan again). */
  reactivate(id: string) {
    return this.db.tx(async (tx) => {
      const before = await this.access.requireAccount(tx, id);
      if (before.status !== 'SUSPENDED' && before.status !== 'ARCHIVED') throw Errors.conflict('INVALID_STATUS', 'This account is not suspended or archived.');
      if (before.status === 'ARCHIVED') await this.usage.assertWithinLimit('corporateClients', tx);
      const status = before.verifiedAt ? ('ACTIVE' as const) : ('PENDING_VERIFICATION' as const);
      const after = await tx.corporateAccount.update({ where: { id }, data: { status } });
      await this.audit.log({ action: 'corporate.account_reactivated', resourceType: 'CorporateAccount', resourceId: id, summary: `${before.accountNo} reactivated`, before: { status: before.status }, after: { status } }, tx);
      return accountView(after);
    });
  }

  /** Archiving ends the company's portal access. Refused while requests are still open. */
  async archive(id: string, reason: string) {
    const { view, userIds } = await this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const before = await this.access.requireAccount(tx, id);
      if (before.status === 'ARCHIVED') throw Errors.conflict('INVALID_STATUS', 'This account is already archived.');
      const open = await tx.serviceRequest.count({ where: { tenantId, corporateAccountId: id, deletedAt: null, status: { in: OPEN_STATUSES } } });
      if (open) throw Errors.conflict('CORPORATE_HAS_OPEN_REQUESTS', `This company still has ${open} open request(s). Complete or cancel them before archiving the account.`);
      const memberships = await tx.tenantMembership.findMany({ where: { tenantId, corporateAccountId: id, kind: 'CORPORATE', status: { in: ['ACTIVE', 'INVITED'] } }, select: { id: true, userId: true } });
      await tx.tenantMembership.updateMany({ where: { id: { in: memberships.map((m) => m.id) }, tenantId }, data: { status: 'SUSPENDED' } });
      await tx.corporateMember.updateMany({ where: { tenantId, corporateAccountId: id, status: { in: ['ACTIVE', 'INVITED'] } }, data: { status: 'SUSPENDED' } });
      const after = await tx.corporateAccount.update({ where: { id }, data: { status: 'ARCHIVED' } });
      await this.audit.log(
        { action: 'corporate.account_archived', resourceType: 'CorporateAccount', resourceId: id, summary: `${before.accountNo} archived: ${reason}`, before: { status: before.status }, after: { status: 'ARCHIVED', reason, portalAccessEnded: memberships.length } },
        tx,
      );
      return { view: accountView(after), userIds: memberships.map((m) => m.userId) };
    });
    await this.access.endSessions(userIds, 'CORPORATE_ACCOUNT_ARCHIVED');
    return view;
  }

  // ------------------------------------------------------------------ portal
  /** GET /corporate/account */
  own() {
    return this.db.tx(async (tx) => {
      const account = await this.access.ownAccount(tx);
      const { employees, members, openRequests, unpaidInvoices, unpaidInvoicesBalance, creditAvailable } = await this.counters(tx, account);
      return { ...portalAccountView(account), counters: { employees, members, openRequests, unpaidInvoices, unpaidInvoicesBalance, creditAvailable } };
    });
  }
}
