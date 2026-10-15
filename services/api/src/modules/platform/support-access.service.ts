import { Injectable } from '@nestjs/common';
import type { AccessGrantStatus } from '@typease/database';
import type { ApproveAccessInput, TenantAccessGrantQuery } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { Prisma, TenantDb } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { DomainEvents } from '../../common/events.service';
import { pageArgs, pageResult } from '../../common/pagination';
import { AccessGrantsService, describeScopes, invalidScopes } from './access-grants.service';

const SORT = ['createdAt', 'expiresAt', 'status'] as const;
type Grant = Prisma.AccessGrantGetPayload<object>;

/**
 * The centre's side of support access: the owner (permission
 * `support_access.decide`) sees who at TypEase asked for what and why, and
 * approves, denies or revokes. All reads and decisions run on the tenant-scoped
 * connection, so a grant of another centre does not exist as far as this
 * service is concerned.
 *
 * The clock starts when the centre approves: `startsAt = now`,
 * `expiresAt = now + durationMinutes`.
 */
@Injectable()
export class SupportAccessService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly platform: AccessGrantsService,
    private readonly events: DomainEvents,
  ) {}

  private async view(rows: Grant[]) {
    // A centre cannot read platform accounts; the names come from a narrow lookup that returns names only.
    const names = await this.platform.staffNames(rows.map((r) => r.requestedById));
    const now = Date.now();
    return rows.map((g) => ({
      id: g.id,
      requestedByName: names.get(g.requestedById) ?? 'TypEase support',
      reason: g.reason,
      scopes: describeScopes(g.scopes),
      ticketId: g.ticketId,
      status: g.status,
      durationMinutes: g.durationMinutes,
      decidedById: g.decidedById,
      decidedAt: g.decidedAt,
      decisionNote: g.decisionNote,
      startsAt: g.startsAt,
      expiresAt: g.expiresAt,
      revokedAt: g.revokedAt,
      /** True while TypEase support can actually use this access. */
      active: g.status === 'APPROVED' && !g.revokedAt && !!g.expiresAt && g.expiresAt.getTime() > now,
      createdAt: g.createdAt,
    }));
  }

  async list(query: TenantAccessGrantQuery) {
    const where: Prisma.AccessGrantWhereInput = { tenantId: this.db.tenantId, ...(query.status ? { status: query.status } : {}), ...(query.q ? { reason: { contains: query.q, mode: 'insensitive' } } : {}) };
    const { rows, total, pending } = await this.db.tx(async (tx) => {
      const [r, t, p] = await Promise.all([tx.accessGrant.findMany({ where, ...pageArgs(query, SORT, 'createdAt:desc') }), tx.accessGrant.count({ where }), tx.accessGrant.count({ where: { tenantId: this.db.tenantId, status: 'REQUESTED' } })]);
      return { rows: r, total: t, pending: p };
    });
    return { ...pageResult(await this.view(rows), total, query), pending };
  }

  async get(id: string) {
    const row = await this.db.tx(async (tx) => found(await tx.accessGrant.findFirst({ where: { id, tenantId: this.db.tenantId } }), 'Access request'));
    return (await this.view([row]))[0];
  }

  /** Conditional update: of two simultaneous decisions exactly one wins. */
  private async decide(id: string, from: AccessGrantStatus[], data: Prisma.AccessGrantUncheckedUpdateInput, audit: { action: string; summary: (g: Grant) => string; after: (g: Grant) => Record<string, unknown> }) {
    const result = await this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const current = found(await tx.accessGrant.findFirst({ where: { id, tenantId } }), 'Access request');
      const changed = await tx.accessGrant.updateMany({ where: { id, tenantId, status: { in: from } }, data });
      if (changed.count !== 1) {
        throw Errors.conflict('ACCESS_ALREADY_DECIDED', `This request is already ${current.status.toLowerCase()}.`, { status: current.status });
      }
      const updated = await tx.accessGrant.findFirstOrThrow({ where: { id, tenantId } });
      await this.audit.log({ action: audit.action, resourceType: 'AccessGrant', resourceId: id, summary: audit.summary(updated), before: { status: current.status }, after: { status: updated.status, ...audit.after(updated) } }, tx);
      // The platform module tells the TypEase staff member who asked (email). No personal data of the centre travels with it.
      await this.events.emit(tx, 'support_access.decided', { grantId: id, status: updated.status, previousStatus: current.status, by: 'CENTRE', expiresAt: updated.expiresAt?.toISOString() ?? null });
      return { current, updated };
    });
    return result;
  }

  async approve(id: string, input: ApproveAccessInput) {
    const now = new Date();
    const existing = await this.db.tx(async (tx) => found(await tx.accessGrant.findFirst({ where: { id, tenantId: this.db.tenantId } }), 'Access request'));
    // The centre may give less than was asked for, never more.
    let scopes = existing.scopes;
    if (input.scopes) {
      const requested = [...new Set(input.scopes)];
      const extra = requested.filter((s) => !existing.scopes.includes(s));
      if (extra.length || invalidScopes(requested).length) throw Errors.unprocessable('SCOPE_NOT_REQUESTED', 'You can approve fewer permissions than were requested, not different ones.', { notRequested: extra });
      scopes = requested;
    }
    const minutes = input.durationMinutes ?? existing.durationMinutes;
    if (minutes > existing.durationMinutes) throw Errors.unprocessable('DURATION_TOO_LONG', `You can approve at most the ${existing.durationMinutes} minutes that were requested.`);
    const expiresAt = new Date(now.getTime() + minutes * 60_000);
    const { updated } = await this.decide(
      id,
      ['REQUESTED'],
      { status: 'APPROVED', scopes, durationMinutes: minutes, decidedById: ctx().userId ?? null, decidedAt: now, decisionNote: input.note ?? null, startsAt: now, expiresAt, revokedAt: null },
      {
        action: 'support_access.approved',
        summary: (g) => `Support access approved for ${g.durationMinutes} minutes (until ${g.expiresAt!.toISOString()})`,
        after: (g) => ({ scopes: g.scopes, durationMinutes: g.durationMinutes, expiresAt: g.expiresAt!.toISOString(), note: g.decisionNote }),
      },
    );
    await this.audit.security('SUPPORT_ACCESS_APPROVED', 'MEDIUM', { grantId: id, scopes: updated.scopes, expiresAt: expiresAt.toISOString() });
    return (await this.view([updated]))[0];
  }

  async deny(id: string, note?: string | null) {
    const { updated } = await this.decide(
      id,
      ['REQUESTED'],
      { status: 'DENIED', decidedById: ctx().userId ?? null, decidedAt: new Date(), decisionNote: note ?? null },
      { action: 'support_access.denied', summary: () => 'Support access denied', after: (g) => ({ note: g.decisionNote }) },
    );
    await this.audit.security('SUPPORT_ACCESS_DENIED', 'INFO', { grantId: id });
    return (await this.view([updated]))[0];
  }

  /** Ends access at any time. It stops working on the support agent's very next request. */
  async revoke(id: string, note?: string | null) {
    const { current, updated } = await this.decide(
      id,
      ['REQUESTED', 'APPROVED'],
      { status: 'REVOKED', revokedAt: new Date(), ...(note ? { decisionNote: note } : {}) },
      { action: 'support_access.revoked', summary: () => 'Support access revoked by the centre', after: (g) => ({ by: 'CENTRE', note: g.decisionNote }) },
    );
    // The grant no longer authorises anything; the sessions opened under it are closed as well.
    const sessions = await this.platform.endSessions([id], 'SUPPORT_ACCESS_REVOKED');
    await this.audit.security('SUPPORT_ACCESS_REVOKED', 'MEDIUM', { grantId: id, by: 'CENTRE', previousStatus: current.status, sessionsEnded: sessions });
    return (await this.view([updated]))[0];
  }
}
