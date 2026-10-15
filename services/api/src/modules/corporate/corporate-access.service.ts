import { Injectable } from '@nestjs/common';
import { ctx } from '../../common/context';
import { SystemDb, TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { ownCorporateAccountId } from '../../common/scope';

/**
 * Which company a call is about, and the two things this module must do
 * outside the tenant connection: create the global user placeholder for an
 * invited contact, and end sessions when portal access is taken away. Nothing
 * else in the corporate module touches the system database.
 */
@Injectable()
export class CorporateAccess {
  constructor(
    private readonly db: TenantDb,
    private readonly sys: SystemDb,
  ) {}

  /** Staff: any corporate account of this centre, or 404. */
  async requireAccount(tx: Tx, id: string) {
    return found(await tx.corporateAccount.findFirst({ where: { id, tenantId: this.db.tenantId, deletedAt: null } }), 'Corporate account');
  }

  /**
   * Portal: the company of the signed-in corporate user. The id comes from the
   * verified membership, never from the request, so a user of company X has no
   * way to name company Y.
   */
  async ownAccount(tx: Tx) {
    const id = ownCorporateAccountId();
    const account = await tx.corporateAccount.findFirst({ where: { id, tenantId: this.db.tenantId, deletedAt: null } });
    if (!account || account.status === 'ARCHIVED') throw Errors.forbidden('NO_CORPORATE_ACCOUNT', 'Your company account is no longer available. Please contact the centre.');
    return account;
  }

  /** Staff may work on any account that is not archived. */
  assertNotArchived(account: { status: string }) {
    if (account.status === 'ARCHIVED') throw Errors.conflict('CORPORATE_ACCOUNT_ARCHIVED', 'This corporate account is archived. Restore it before changing it.');
  }
  /** The company itself may only change things once the centre has verified it, and not while it is suspended. */
  assertPortalWritable(account: { status: string }) {
    if (account.status === 'ACTIVE') return;
    throw Errors.forbidden(
      'CORPORATE_ACCOUNT_NOT_ACTIVE',
      account.status === 'PENDING_VERIFICATION'
        ? 'The centre has not verified your company yet. You can make changes as soon as verification is complete.'
        : 'Your company account is suspended. Please contact the centre.',
    );
  }

  isPortalUser() {
    return ctx().actorType === 'CORPORATE';
  }

  /**
   * The company a call works on. Staff name it in the path (`accountId`); a portal
   * user passes `null` and gets the company of their own membership, so there is
   * no way to name somebody else's company from the portal.
   */
  async scope(tx: Tx, accountId: string | null, write: boolean) {
    if (accountId === null) {
      const account = await this.ownAccount(tx);
      if (write) this.assertPortalWritable(account);
      return account;
    }
    const account = await this.requireAccount(tx, accountId);
    if (write) this.assertNotArchived(account);
    return account;
  }

  /** Users are global identities; the placeholder has no password until the invitation is accepted. */
  async placeholderUser(email: string, fullName: string): Promise<{ id: string; email: string }> {
    return this.sys.client.user.upsert({ where: { email }, create: { email, fullName }, update: {}, select: { id: true, email: true } });
  }

  /** Taking away access takes effect at once: the person's sessions for this centre are ended. */
  async endSessions(userIds: string[], reason: string): Promise<void> {
    if (!userIds.length) return;
    await this.sys.client.session.updateMany({ where: { userId: { in: userIds }, tenantId: this.db.tenantId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
  }
}
