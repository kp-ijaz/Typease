import { Injectable } from '@nestjs/common';
import type { CorporateMemberInput, UpdateCorporateMemberInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { UsageService } from '../../common/usage.service';
import { AuthService } from '../auth/auth.service';
import { CorporateAccess } from './corporate-access.service';
import { CorporateRolesService } from './roles.service';

const devTokens = () => process.env.EXPOSE_DEV_TOKENS === 'true' && process.env.NODE_ENV !== 'production';
const MEMBER_ORDER = [{ createdAt: 'asc' as const }];
/** What the company's own users see of their colleagues (no internal ids). */
const PORTAL_MEMBER_SELECT = { id: true, fullName: true, email: true, phone: true, role: true, isAuthorisedSignatory: true, status: true, createdAt: true } as const;

/**
 * Authorised contacts of a company. Each one is a `corporate_members` row plus a
 * tenant membership of kind CORPORATE (role `corporate_admin`) bound to that
 * company: the membership is what gives - and limits - portal access.
 */
@Injectable()
export class CorporateMembersService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly usage: UsageService,
    private readonly auth: AuthService,
    private readonly access: CorporateAccess,
  ) {}

  // ------------------------------------------------------------------ staff
  list(accountId: string) {
    return this.db.tx(async (tx) => {
      await this.access.requireAccount(tx, accountId);
      return tx.corporateMember.findMany({ where: { tenantId: this.db.tenantId, corporateAccountId: accountId, status: { not: 'REMOVED' } }, orderBy: MEMBER_ORDER });
    });
  }

  async inviteByStaff(accountId: string, input: CorporateMemberInput) {
    await this.db.tx(async (tx) => this.access.assertNotArchived(await this.access.requireAccount(tx, accountId)));
    return this.invite(accountId, input);
  }

  /** The membership behind a member row (same user, same company). */
  private membershipOf(tx: Tx, member: { userId: string | null; corporateAccountId: string }) {
    if (!member.userId) return Promise.resolve(null);
    return tx.tenantMembership.findFirst({ where: { tenantId: this.db.tenantId, userId: member.userId, kind: 'CORPORATE', corporateAccountId: member.corporateAccountId } });
  }
  private async requireMember(tx: Tx, accountId: string, memberId: string) {
    return found(await tx.corporateMember.findFirst({ where: { id: memberId, corporateAccountId: accountId, tenantId: this.db.tenantId, status: { not: 'REMOVED' } } }), 'Member');
  }

  async update(accountId: string, memberId: string, input: UpdateCorporateMemberInput) {
    const { member, revokeUserId } = await this.db.tx(async (tx) => {
      this.access.assertNotArchived(await this.access.requireAccount(tx, accountId));
      const before = await this.requireMember(tx, accountId, memberId);
      const data: Record<string, unknown> = {};
      if (input.fullName !== undefined) data.fullName = input.fullName;
      if (input.phone !== undefined) data.phone = input.phone;
      if (input.isAuthorisedSignatory !== undefined) data.isAuthorisedSignatory = input.isAuthorisedSignatory;
      let revoke: string | null = null;
      if (input.status && input.status !== before.status) {
        if (before.status === 'INVITED') throw Errors.conflict('INVITATION_PENDING', 'This person has not accepted the invitation yet. Remove the member to withdraw it.');
        const membership = await this.membershipOf(tx, before);
        if (membership) await tx.tenantMembership.update({ where: { id: membership.id }, data: { status: input.status } });
        data.status = input.status;
        if (input.status === 'SUSPENDED') revoke = before.userId;
      }
      const after = await tx.corporateMember.update({ where: { id: memberId }, data });
      await this.audit.log(
        { action: 'corporate.member_updated', resourceType: 'CorporateAccount', resourceId: accountId, summary: `${before.email}: ${Object.keys(data).join(', ')}`, before: { memberId, fullName: before.fullName, phone: before.phone, isAuthorisedSignatory: before.isAuthorisedSignatory, status: before.status }, after: { memberId, ...data } },
        tx,
      );
      return { member: after, revokeUserId: revoke };
    });
    if (revokeUserId) await this.access.endSessions([revokeUserId], 'MEMBERSHIP_CHANGED');
    return member;
  }

  async remove(accountId: string, memberId: string) {
    const userId = await this.db.tx(async (tx) => {
      await this.access.requireAccount(tx, accountId);
      const member = await this.requireMember(tx, accountId, memberId);
      const membership = await this.membershipOf(tx, member);
      if (membership) await tx.tenantMembership.update({ where: { id: membership.id }, data: { status: 'REMOVED' } });
      await tx.corporateMember.update({ where: { id: memberId }, data: { status: 'REMOVED' } });
      await this.audit.log({ action: 'corporate.member_removed', resourceType: 'CorporateAccount', resourceId: accountId, summary: `${member.email} removed`, before: { memberId, email: member.email, status: member.status } }, tx);
      return member.userId;
    });
    if (userId) await this.access.endSessions([userId], 'MEMBERSHIP_REMOVED');
    return { status: 'REMOVED' as const };
  }

  async resend(accountId: string, memberId: string) {
    const invitation = await this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const account = await this.access.requireAccount(tx, accountId);
      this.access.assertNotArchived(account);
      const member = await this.requireMember(tx, accountId, memberId);
      const membership = await this.membershipOf(tx, member);
      if (member.status !== 'INVITED' || !membership || membership.status !== 'INVITED') throw Errors.conflict('NOT_INVITED', 'There is no pending invitation for this person.');
      const [tenant, role] = await Promise.all([tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { name: true, defaultLanguage: true } }), tx.role.findFirstOrThrow({ where: { id: membership.roleId } })]);
      await this.audit.log({ action: 'corporate.member_invitation_resent', resourceType: 'CorporateAccount', resourceId: accountId, after: { memberId, email: member.email } }, tx);
      return { tenantId, membershipId: membership.id, email: member.email, fullName: member.fullName, app: 'corporate' as const, centreName: tenant.name, roleName: role.name, language: tenant.defaultLanguage };
    });
    const { token } = await this.auth.sendInvitation(invitation);
    return { status: 'SENT' as const, ...(devTokens() ? { dev: { invitationToken: token } } : {}) };
  }

  // ------------------------------------------------------------------ portal
  listOwn() {
    return this.db.tx(async (tx) => {
      const account = await this.access.ownAccount(tx);
      return tx.corporateMember.findMany({ where: { tenantId: this.db.tenantId, corporateAccountId: account.id, status: { not: 'REMOVED' } }, select: PORTAL_MEMBER_SELECT, orderBy: MEMBER_ORDER });
    });
  }

  /** A company administrator invites a colleague to the company's own account. */
  async inviteColleague(input: CorporateMemberInput) {
    const accountId = await this.db.tx(async (tx) => {
      const account = await this.access.ownAccount(tx);
      this.access.assertPortalWritable(account);
      return account.id;
    });
    const result = await this.invite(accountId, input);
    return { id: result.id, status: result.status, email: result.email, ...(result.dev ? { dev: result.dev } : {}) };
  }

  // ------------------------------------------------------------------ shared
  private async invite(accountId: string, input: CorporateMemberInput) {
    const c = ctx();
    // The plan decides whether the centre offers a corporate portal at all.
    await this.usage.assertFeature('corporatePortal');
    const user = await this.access.placeholderUser(input.email, input.fullName);
    const { member, invitation } = await this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const account = await this.access.requireAccount(tx, accountId);
      this.access.assertNotArchived(account);
      // One login acts for one company per centre. An address that already acts for a company cannot be
      // attached to another one; the message is the same whichever company it is, so nothing leaks.
      const existing = await tx.tenantMembership.findFirst({ where: { tenantId, userId: user.id, kind: 'CORPORATE' } });
      if (existing && existing.status !== 'REMOVED') {
        if (existing.corporateAccountId === accountId) throw Errors.conflict('ALREADY_MEMBER', 'This person already has access to the company account, or an invitation is pending.');
        throw Errors.conflict('EMAIL_IN_USE', 'This email address is already used for another corporate login at this centre. Use a different address.');
      }
      const role = found(await CorporateRolesService.defaultRole(tx, tenantId, accountId, 'corporate_admin'), 'Corporate administrator role');
      const tenant = await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { name: true, defaultLanguage: true } });
      const data = { roleId: role.id, status: 'INVITED' as const, corporateAccountId: accountId, corporateEmployeeId: null, customerId: null, allBranches: true, invitedById: c.userId ?? null, invitedAt: new Date(), joinedAt: null };
      const membership = existing ? await tx.tenantMembership.update({ where: { id: existing.id }, data }) : await tx.tenantMembership.create({ data: { ...data, tenantId, userId: user.id, kind: 'CORPORATE' } });

      const details = { userId: user.id, fullName: input.fullName, phone: input.phone ?? null, isAuthorisedSignatory: input.isAuthorisedSignatory, role: 'ADMIN', status: 'INVITED' };
      const previous = await tx.corporateMember.findFirst({ where: { tenantId, corporateAccountId: accountId, email: input.email } });
      const row = previous ? await tx.corporateMember.update({ where: { id: previous.id }, data: details }) : await tx.corporateMember.create({ data: { ...details, tenantId, corporateAccountId: accountId, email: input.email } });
      await this.audit.log(
        { action: 'corporate.member_invited', resourceType: 'CorporateAccount', resourceId: accountId, summary: `${input.email} invited to ${account.accountNo}`, after: { memberId: row.id, membershipId: membership.id, email: input.email, isAuthorisedSignatory: input.isAuthorisedSignatory, invitedByType: c.actorType } },
        tx,
      );
      return {
        member: row,
        invitation: { tenantId, membershipId: membership.id, email: input.email, fullName: input.fullName, app: 'corporate' as const, centreName: tenant.name, roleName: role.name, language: tenant.defaultLanguage },
      };
    });
    // One-time tokens live outside the tenant connection: send after the transaction committed.
    const { token } = await this.auth.sendInvitation(invitation);
    return { ...member, ...(devTokens() ? { dev: { invitationToken: token } } : {}) } as typeof member & { dev?: { invitationToken: string } };
  }
}
