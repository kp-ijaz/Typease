import { customerErasedError, isErasedCustomer } from '../../common/customer-ref';
import { Injectable } from '@nestjs/common';
import type { CorporateEmployeeLoginInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { UsageService } from '../../common/usage.service';
import { AuthService } from '../auth/auth.service';
import { CorporateAccess } from './corporate-access.service';
import { CorporateRolesService } from './roles.service';

const devTokens = () => process.env.EXPOSE_DEV_TOKENS === 'true' && process.env.NODE_ENV !== 'production';

export type EmployeeLoginStatus = 'NONE' | 'INVITED' | 'ACTIVE' | 'SUSPENDED';
export interface EmployeeLoginState {
  status: EmployeeLoginStatus;
  /** The address the person signs in with (the invitation went there). */
  email: string | null;
  invitedAt: Date | null;
  joinedAt: Date | null;
  lastLoginAt: Date | null;
}
const NO_LOGIN: EmployeeLoginState = { status: 'NONE', email: null, invitedAt: null, joinedAt: null, lastLoginAt: null };
const RANK: Record<string, number> = { ACTIVE: 3, INVITED: 2, SUSPENDED: 1 };
const LIVE = ['ACTIVE', 'INVITED', 'SUSPENDED'] as const;

/**
 * Portal logins for a company's employees. A login is a tenant membership of
 * kind CORPORATE with the role `corporate_employee`, bound to the company
 * (`corporateAccountId`), to the employment (`corporateEmployeeId`) and to the
 * person's customer record (`customerId`). The role carries only `self.*`
 * permissions, so the employee reaches their own requests and documents and
 * nothing of the company or of a colleague.
 */
@Injectable()
export class CorporateEmployeeLoginsService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly usage: UsageService,
    private readonly auth: AuthService,
    private readonly access: CorporateAccess,
  ) {}

  // ------------------------------------------------------------------ read
  /** Login state of each employee, for the employee views. */
  async statesFor(tx: Tx, employeeIds: string[]): Promise<Map<string, EmployeeLoginState>> {
    const out = new Map<string, EmployeeLoginState>();
    if (!employeeIds.length) return out;
    const rows = await tx.tenantMembership.findMany({
      where: { tenantId: this.db.tenantId, kind: 'CORPORATE', corporateEmployeeId: { in: employeeIds }, status: { in: [...LIVE] } },
      select: { corporateEmployeeId: true, status: true, invitedAt: true, joinedAt: true, user: { select: { email: true, lastLoginAt: true } } },
      orderBy: { createdAt: 'asc' },
    });
    for (const m of rows) {
      const current = out.get(m.corporateEmployeeId!);
      if (current && RANK[current.status] >= RANK[m.status]) continue;
      out.set(m.corporateEmployeeId!, { status: m.status as EmployeeLoginStatus, email: m.user.email, invitedAt: m.invitedAt, joinedAt: m.joinedAt, lastLoginAt: m.user.lastLoginAt });
    }
    return out;
  }
  async stateOf(tx: Tx, employeeId: string): Promise<EmployeeLoginState> {
    return (await this.statesFor(tx, [employeeId])).get(employeeId) ?? NO_LOGIN;
  }

  private async requireEmployee(tx: Tx, accountId: string, employeeId: string) {
    return found(
      await tx.corporateEmployee.findFirst({
        // A company never sees a person whose data was erased (404); staff are told why nothing can be done (409).
        where: { id: employeeId, corporateAccountId: accountId, tenantId: this.db.tenantId, ...(ctx().actorType === 'CORPORATE' ? { customer: { status: { not: 'ANONYMISED' } } } : {}) },
        include: { customer: { select: { id: true, fullName: true, email: true, status: true, preferredLanguage: true } } },
      }),
      'Employee',
    );
  }
  private assertInvitable(employee: { status: string; customer: { status: string } }) {
    if (isErasedCustomer(employee.customer)) throw customerErasedError();
    if (employee.status !== 'ACTIVE') throw Errors.conflict('EMPLOYEE_INACTIVE', 'This employee is inactive. Reactivate the employee before giving portal access.');
    if (employee.customer.status !== 'ACTIVE') throw Errors.conflict('EMPLOYEE_RECORD_LOCKED', 'The record of this employee is archived or closed, so portal access cannot be given. Please contact the centre.');
  }
  private linked(tx: Tx, employeeId: string) {
    return tx.tenantMembership.findMany({
      where: { tenantId: this.db.tenantId, kind: 'CORPORATE', corporateEmployeeId: employeeId, status: { in: [...LIVE] } },
      select: { id: true, status: true, userId: true, roleId: true, user: { select: { email: true, fullName: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ------------------------------------------------------------------ invite
  /**
   * `accountId` is the company named by staff, or `null` for a portal user, whose
   * company comes from their own membership.
   */
  async invite(accountId: string | null, employeeId: string, input: CorporateEmployeeLoginInput) {
    const c = ctx();
    // The plan decides whether the centre offers a corporate portal at all. Portal logins are not
    // metered: the `staffUsers` limit counts staff memberships only.
    await this.usage.assertFeature('corporatePortal');

    // 1. Decide the address before any account is touched.
    const { email, fullName } = await this.db.tx(async (tx) => {
      const account = await this.access.scope(tx, accountId, true);
      const employee = await this.requireEmployee(tx, account.id, employeeId);
      this.assertInvitable(employee);
      const address = input.email ?? employee.customer.email;
      if (!address) throw Errors.unprocessable('EMAIL_REQUIRED', 'Add an email address for this employee, or enter the address the invitation should go to.');
      return { email: address.toLowerCase(), fullName: employee.customer.fullName };
    });
    // 2. Users are global identities: the placeholder has no password until the invitation is accepted.
    const user = await this.access.placeholderUser(email, fullName);

    // 3. Bind the login to the company, the employment and the person's customer record.
    const { membershipId, invitation, withdrawnUserIds } = await this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const account = await this.access.scope(tx, accountId, true);
      const employee = await this.requireEmployee(tx, account.id, employeeId);
      this.assertInvitable(employee);

      const linked = await this.linked(tx, employeeId);
      if (linked.some((m) => m.status === 'ACTIVE')) throw Errors.conflict('ALREADY_HAS_ACCESS', 'This employee already has portal access. Revoke it first to move it to another email address.');
      if (linked.some((m) => m.status === 'INVITED' && m.userId === user.id)) {
        throw Errors.conflict('INVITATION_PENDING', 'An invitation to this address is already waiting to be accepted. Send it again instead.');
      }
      // One login acts in one corporate capacity per centre. The message is the same whichever company
      // or employee the address belongs to, so nothing leaks.
      const sameUser = await tx.tenantMembership.findFirst({ where: { tenantId, userId: user.id, kind: 'CORPORATE' } });
      if (sameUser && sameUser.status !== 'REMOVED' && sameUser.corporateEmployeeId !== employeeId) {
        throw Errors.conflict('EMAIL_IN_USE', 'This email address is already used for another corporate login at this centre. Use a different address.');
      }
      const role = found(await CorporateRolesService.defaultRole(tx, tenantId, account.id, 'corporate_employee'), 'Corporate employee role');
      const tenant = await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { name: true, defaultLanguage: true } });

      // An earlier invitation to another address, or a suspended login of another address, is withdrawn.
      const stale = linked.filter((m) => m.userId !== user.id);
      for (const m of stale) await tx.tenantMembership.update({ where: { id: m.id }, data: { status: 'REMOVED', corporateEmployeeId: null, customerId: null } });

      const data = {
        roleId: role.id, status: 'INVITED' as const, corporateAccountId: account.id, corporateEmployeeId: employeeId, customerId: employee.customerId,
        allBranches: true, invitedById: c.userId ?? null, invitedAt: new Date(), joinedAt: null,
      };
      const membership = sameUser ? await tx.tenantMembership.update({ where: { id: sameUser.id }, data }) : await tx.tenantMembership.create({ data: { ...data, tenantId, userId: user.id, kind: 'CORPORATE' } });
      await this.audit.log(
        {
          action: 'corporate.employee_login_invited', resourceType: 'CorporateAccount', resourceId: account.id,
          summary: `${employee.customer.fullName}: portal invitation sent (${account.accountNo})`,
          after: { employeeId, customerId: employee.customerId, membershipId: membership.id, email, invitedByType: c.actorType, withdrawnMembershipIds: stale.map((m) => m.id) },
        },
        tx,
      );
      return {
        membershipId: membership.id,
        withdrawnUserIds: stale.map((m) => m.userId),
        invitation: {
          tenantId, membershipId: membership.id, email, fullName: employee.customer.fullName, app: 'corporate' as const, centreName: tenant.name, roleName: role.name,
          language: employee.customer.preferredLanguage ?? tenant.defaultLanguage,
        },
      };
    });
    await this.access.endSessions(withdrawnUserIds, 'MEMBERSHIP_REMOVED');
    // 4. One-time tokens live outside the tenant connection: send after the transaction committed.
    const { token } = await this.auth.sendInvitation(invitation);
    return { employeeId, membershipId, status: 'INVITED' as const, email, ...(devTokens() ? { dev: { invitationToken: token } } : {}) };
  }

  // ------------------------------------------------------------------ resend
  async resend(accountId: string | null, employeeId: string) {
    const invitation = await this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const account = await this.access.scope(tx, accountId, true);
      const employee = await this.requireEmployee(tx, account.id, employeeId);
      this.assertInvitable(employee);
      const pending = (await this.linked(tx, employeeId)).find((m) => m.status === 'INVITED');
      if (!pending) throw Errors.conflict('NOT_INVITED', 'There is no pending invitation for this employee.');
      const [tenant, role] = await Promise.all([tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { name: true, defaultLanguage: true } }), tx.role.findFirstOrThrow({ where: { id: pending.roleId, tenantId } })]);
      await this.audit.log({ action: 'corporate.employee_login_invitation_resent', resourceType: 'CorporateAccount', resourceId: account.id, after: { employeeId, membershipId: pending.id, email: pending.user.email } }, tx);
      return {
        tenantId, membershipId: pending.id, email: pending.user.email, fullName: employee.customer.fullName, app: 'corporate' as const, centreName: tenant.name, roleName: role.name,
        language: employee.customer.preferredLanguage ?? tenant.defaultLanguage,
      };
    });
    // sendInvitation invalidates the earlier link of the same membership.
    const { token } = await this.auth.sendInvitation(invitation);
    return { status: 'SENT' as const, email: invitation.email, ...(devTokens() ? { dev: { invitationToken: token } } : {}) };
  }

  // ------------------------------------------------------------------ revoke
  /** Withdraws a pending invitation or takes away an existing login. The person's sessions end at once. */
  async revoke(accountId: string | null, employeeId: string) {
    const userIds = await this.db.tx(async (tx) => {
      // Taking access away must stay possible while the company is suspended or waiting for verification.
      const account = await this.access.scope(tx, accountId, false);
      const employee = await this.requireEmployee(tx, account.id, employeeId);
      const linked = await this.linked(tx, employeeId);
      if (!linked.length) throw Errors.conflict('NO_LOGIN', 'This employee has no portal access and no pending invitation.');
      for (const m of linked) await tx.tenantMembership.update({ where: { id: m.id }, data: { status: 'REMOVED', corporateEmployeeId: null, customerId: null } });
      await this.audit.log(
        {
          action: 'corporate.employee_login_revoked', resourceType: 'CorporateAccount', resourceId: account.id,
          summary: `${employee.customer.fullName}: portal access revoked (${account.accountNo})`,
          before: { employeeId, logins: linked.map((m) => ({ membershipId: m.id, email: m.user.email, status: m.status })) },
          after: { employeeId, status: 'NONE' },
        },
        tx,
      );
      return linked.map((m) => m.userId);
    });
    await this.access.endSessions(userIds, 'MEMBERSHIP_REMOVED');
    return { employeeId, status: 'NONE' as const };
  }
}
