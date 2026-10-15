import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SUPPORT_GRANTABLE, TENANT_PERMISSIONS } from '@typease/permissions';
import type { PlatformAccessGrantQuery, RequestAccessInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { SUPPORT_WRITE_SCOPES } from '../../common/auth/support-session';
import { env } from '../../config/env';
import { ctx, tryCtx } from '../../common/context';
import { Prisma, SystemDb } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { DomainEvent, DomainEvents } from '../../common/events.service';
import { Messenger } from '../../common/messenger';
import { pageArgs, pageResult } from '../../common/pagination';
import { AuthService } from '../auth/auth.service';
import { PlatformSettingsService, SUPPORT_ACCESS_POLICY_KEY, SupportAccessPolicy } from './settings.service';

export const ACCESS_EXPIRY_JOB = 'platform.access_grants_expiry';
const SORT = ['createdAt', 'expiresAt', 'status'] as const;
const USABLE_TENANT = ['ONBOARDING', 'PENDING_APPROVAL', 'TRIAL', 'ACTIVE', 'PAST_DUE'];
type Grant = Prisma.AccessGrantGetPayload<object>;
const REQUESTER_NOTIFIED = 'support_access.requester_notified';

/** Wording of the decision message for the platform staff member who asked (English / Arabic). */
const DECISION_TEXT = {
  en: {
    APPROVED: 'approved',
    DENIED: 'denied',
    REVOKED: 'ended',
    validUntil: (when: string) => `The access is valid until ${when} (UTC). It stops working at that moment, or earlier if the centre ends it.`,
    denied: 'No access was given.',
    revokedByCentre: 'The centre ended the access. Sessions opened under it were closed.',
    revokedByPlatform: 'A platform administrator ended the access. Sessions opened under it were closed.',
    note: (note: string) => `Note from the centre: ${note}`,
  },
  ar: {
    APPROVED: 'تمت الموافقة عليه',
    DENIED: 'تم رفضه',
    REVOKED: 'تم إنهاؤه',
    validUntil: (when: string) => `الوصول صالح حتى ${when} (بالتوقيت العالمي). يتوقف عند ذلك الوقت، أو قبل ذلك إذا أنهاه المركز.`,
    denied: 'لم يُمنح أي وصول.',
    revokedByCentre: 'أنهى المركز الوصول، وأُغلقت الجلسات المفتوحة بموجبه.',
    revokedByPlatform: 'أنهى أحد مسؤولي المنصة الوصول، وأُغلقت الجلسات المفتوحة بموجبه.',
    note: (note: string) => `ملاحظة من المركز: ${note}`,
  },
} as const;

/** Scopes with the plain-language description from the permission catalogue. */
export const describeScopes = (scopes: string[]) =>
  scopes.map((key) => ({
    key,
    description: (TENANT_PERMISSIONS as Record<string, { description: string }>)[key]?.description ?? key,
    /** True for the few scopes that let support change something (everything else is a read). The centre sees this before it approves. */
    write: SUPPORT_WRITE_SCOPES.includes(key),
  }));

/** Unknown or non-delegable scopes in a request (write permissions can never be delegated to support). */
export function invalidScopes(scopes: string[]): string[] {
  return scopes.filter((s) => !(SUPPORT_GRANTABLE as string[]).includes(s));
}

/**
 * The platform side of time-limited support access (spec section 5):
 * platform staff ASK a centre for access, and may enter it only while the
 * centre's approval is in force. Platform staff hold no tenant permission by
 * themselves; without an approved grant every tenant route answers 403.
 *
 * How access is enforced (not here, but on every request): the access token of
 * a support session carries the grant id, and `PrincipalService` re-reads the
 * grant from the database each time. It must be APPROVED, not revoked and not
 * past `expiresAt`, and only its scopes become permissions - so a denial, a
 * revocation or the expiry takes effect on the very next request.
 */
@Injectable()
export class AccessGrantsService implements OnModuleInit {
  private readonly logger = new Logger(AccessGrantsService.name);

  constructor(
    private readonly sys: SystemDb,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    private readonly settings: PlatformSettingsService,
    private readonly events: DomainEvents,
    private readonly messenger: Messenger,
  ) {}

  onModuleInit() {
    // The person who asked hears about the decision. The centre's owners hear about the request through
    // the notifications module (`support_access.requested`).
    this.events.subscribe('platform.support-access', ['support_access.decided'], (event) => this.notifyRequester(event));
  }

  /**
   * `support_access.decided` -> an email to the platform staff member who asked, sent with the platform's
   * own template and provider (the requester is not a member of the centre, and the centre's notification
   * allowance is not used). Events are delivered at least once: the audit entry written with the message is
   * also what prevents a second message for the same event.
   */
  async notifyRequester(event: DomainEvent): Promise<void> {
    const p = event.payload ?? {};
    if (!event.tenantId || typeof p.grantId !== 'string' || !['APPROVED', 'DENIED', 'REVOKED'].includes(p.status)) return;
    const grant = await this.sys.client.accessGrant.findFirst({ where: { id: p.grantId, tenantId: event.tenantId } });
    if (!grant) return;
    // Somebody who withdrew their own request does not need to be told.
    if (p.actorUserId && p.actorUserId === grant.requestedById) return;
    const already = await this.sys.client.auditLog.findFirst({ where: { tenantId: null, action: REQUESTER_NOTIFIED, resourceId: grant.id, after: { path: ['eventId'], equals: event.id } }, select: { id: true } });
    if (already) return;
    const [requester, tenant] = await Promise.all([
      this.sys.client.user.findFirst({ where: { id: grant.requestedById, platformRole: { not: null }, status: 'ACTIVE', deletedAt: null }, select: { email: true, fullName: true, preferredLanguage: true } }),
      this.sys.client.tenant.findUnique({ where: { id: grant.tenantId }, select: { name: true } }),
    ]);
    if (!requester || !tenant) return;
    const status = p.status as 'APPROVED' | 'DENIED' | 'REVOKED';
    const language = requester.preferredLanguage === 'ar' ? 'ar' : 'en';
    const text = DECISION_TEXT[language];
    const until = grant.expiresAt ? `${grant.expiresAt.toISOString().slice(0, 16).replace('T', ' ')}` : '';
    const lines: string[] = [status === 'APPROVED' ? text.validUntil(until) : status === 'DENIED' ? text.denied : p.by === 'PLATFORM' ? text.revokedByPlatform : text.revokedByCentre];
    if (grant.decisionNote && p.by !== 'PLATFORM') lines.push(text.note(grant.decisionNote));
    await this.sys.client.auditLog.create({
      data: {
        tenantId: null, actorType: 'SYSTEM', actorLabel: 'system', action: REQUESTER_NOTIFIED, resourceType: 'AccessGrant', resourceId: grant.id,
        summary: `The requester was told that support access was ${status.toLowerCase()} [centre ${tenant.name}]`, after: { eventId: event.id, status, by: p.by ?? 'CENTRE' },
      },
    });
    await this.messenger.send({
      eventKey: 'support_access.decided', channel: 'EMAIL', to: requester.email, language,
      data: { name: requester.fullName, tenantName: tenant.name, decision: text[status], details: lines.join('\n\n'), consoleLink: `${env().PLATFORM_ADMIN_URL}/access-requests` },
    });
  }

  /** Audit entry on the centre's trail that carries the grant id (the generic helper only knows the request context). */
  async auditOnCentre(grant: Pick<Grant, 'id' | 'tenantId'>, action: string, summary: string, after?: Record<string, unknown>) {
    const c = tryCtx();
    await this.sys.client.auditLog.create({
      data: {
        tenantId: grant.tenantId,
        actorUserId: c?.userId ?? null,
        actorType: c?.actorType ?? 'SYSTEM',
        actorLabel: c?.actorLabel ?? 'system',
        action,
        resourceType: 'AccessGrant',
        resourceId: grant.id,
        summary,
        after: after as Prisma.InputJsonValue | undefined,
        supportGrantId: grant.id,
        requestId: c?.requestId ?? null,
        ip: c?.ip ?? null,
        userAgent: c?.userAgent?.slice(0, 300) ?? null,
      },
    });
  }

  /** Names of platform staff, for screens of a centre (which cannot read platform accounts itself). */
  async staffNames(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((v): v is string => !!v))];
    if (!unique.length) return new Map();
    const rows = await this.sys.client.user.findMany({ where: { id: { in: unique }, platformRole: { not: null } }, select: { id: true, fullName: true } });
    return new Map(rows.map((u) => [u.id, u.fullName]));
  }

  private async view(rows: Grant[]) {
    const tenantIds = [...new Set(rows.map((r) => r.tenantId))];
    const [tenants, names, deciders] = await Promise.all([
      tenantIds.length ? this.sys.client.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true, slug: true, status: true } }) : [],
      this.staffNames(rows.map((r) => r.requestedById)),
      this.deciderNames(rows),
    ]);
    const tenantMap = new Map(tenants.map((t) => [t.id, t]));
    const now = Date.now();
    return rows.map((g) => ({
      id: g.id,
      centre: tenantMap.get(g.tenantId) ?? null,
      requestedById: g.requestedById,
      requestedByName: names.get(g.requestedById) ?? null,
      reason: g.reason,
      scopes: g.scopes,
      ticketId: g.ticketId,
      status: g.status,
      durationMinutes: g.durationMinutes,
      decidedByName: g.decidedById ? (deciders.get(g.decidedById) ?? null) : null,
      decidedAt: g.decidedAt,
      decisionNote: g.decisionNote,
      startsAt: g.startsAt,
      expiresAt: g.expiresAt,
      revokedAt: g.revokedAt,
      /** True only while the grant can actually be used. */
      usable: g.status === 'APPROVED' && !g.revokedAt && !!g.expiresAt && g.expiresAt.getTime() > now,
      createdAt: g.createdAt,
    }));
  }
  /** The person at the centre who decided: name only. */
  private async deciderNames(rows: Grant[]): Promise<Map<string, string>> {
    const ids = [...new Set(rows.map((r) => r.decidedById).filter((v): v is string => !!v))];
    if (!ids.length) return new Map();
    const users = await this.sys.client.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } });
    return new Map(users.map((u) => [u.id, u.fullName]));
  }

  private canSeeAll(): boolean {
    return ctx().permissions.has('platform.audit.read');
  }
  private async mine(id: string, opts: { requesterOnly?: boolean } = {}): Promise<Grant> {
    const c = ctx();
    const grant = found(await this.sys.client.accessGrant.findUnique({ where: { id } }), 'Access request');
    if (grant.requestedById !== c.userId && (opts.requesterOnly || !this.canSeeAll())) throw Errors.notFound('Access request');
    return grant;
  }

  // ------------------------------------------------------------------ request
  async request(tenantId: string, input: RequestAccessInput) {
    const c = ctx();
    const tenant = found(await this.sys.client.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true, slug: true, status: true } }), 'Centre');
    if (!USABLE_TENANT.includes(tenant.status)) throw Errors.conflict('TENANT_UNAVAILABLE', `This centre is ${tenant.status.toLowerCase().replace('_', ' ')}; nobody there can approve support access.`);
    const scopes = [...new Set(input.scopes)];
    const invalid = invalidScopes(scopes);
    if (invalid.length) {
      throw Errors.unprocessable('SCOPE_NOT_GRANTABLE', `These permissions can never be given to TypEase support: ${invalid.join(', ')}. Support access is read-only, apart from internal notes on requests when the centre approves that.`, { invalid, grantable: SUPPORT_GRANTABLE });
    }
    const policy = await this.settings.value<SupportAccessPolicy>(SUPPORT_ACCESS_POLICY_KEY);
    if (input.durationMinutes > policy.maxDurationMinutes) throw Errors.unprocessable('DURATION_TOO_LONG', `Support access can be requested for at most ${policy.maxDurationMinutes} minutes.`, { maxDurationMinutes: policy.maxDurationMinutes });
    if (input.ticketId) {
      const ticket = await this.sys.client.supportTicket.findFirst({ where: { id: input.ticketId, tenantId, scope: 'PLATFORM' }, select: { id: true } });
      if (!ticket) throw Errors.unprocessable('TICKET_NOT_FOUND', 'That support ticket does not belong to this centre.');
    }
    const open = await this.sys.client.accessGrant.findFirst({
      where: { tenantId, requestedById: c.userId!, OR: [{ status: 'REQUESTED' }, { status: 'APPROVED', revokedAt: null, expiresAt: { gt: new Date() } }] },
      select: { id: true, status: true },
    });
    if (open) throw Errors.conflict('ACCESS_ALREADY_OPEN', open.status === 'REQUESTED' ? 'You already have a request waiting for this centre. Withdraw it before asking again.' : 'You already have access to this centre. Revoke it before asking for different access.', { id: open.id });

    // The request and the event that tells the centre about it are written together: either both exist or neither.
    const grant = await this.sys.tx(async (tx) => {
      const created = await tx.accessGrant.create({ data: { tenantId, requestedById: c.userId!, reason: input.reason, scopes, durationMinutes: input.durationMinutes, ticketId: input.ticketId ?? null, status: 'REQUESTED' } });
      await this.events.emitSystem('support_access.requested', { grantId: created.id, requestedById: c.userId, requesterName: c.actorLabel ?? null, durationMinutes: input.durationMinutes, scopes, ticketId: input.ticketId ?? null }, tenantId, tx);
      return created;
    });
    await this.auditOnCentre(grant, 'support_access.requested', `TypEase support (${c.actorLabel}) asked for ${input.durationMinutes} minutes of access: ${input.reason}`, { scopes, durationMinutes: input.durationMinutes, ticketId: input.ticketId ?? null });
    await this.audit.logSystem({ action: 'support_access.requested', resourceType: 'AccessGrant', resourceId: grant.id, summary: `Support access requested [centre ${tenant.slug}]`, after: { scopes, durationMinutes: input.durationMinutes, reason: input.reason } });
    await this.audit.security('SUPPORT_ACCESS_REQUESTED', 'INFO', { grantId: grant.id, scopes, durationMinutes: input.durationMinutes }, tenantId);
    return (await this.view([grant]))[0];
  }

  async list(query: PlatformAccessGrantQuery) {
    const c = ctx();
    if (query.all && !this.canSeeAll()) throw Errors.forbidden('FORBIDDEN', 'Seeing the requests of other staff needs the platform audit permission.');
    const where: Prisma.AccessGrantWhereInput = {
      ...(query.all ? {} : { requestedById: c.userId! }),
      ...(query.status ? { status: query.status } : {}),
      ...(query.centreId ? { tenantId: query.centreId } : {}),
      ...(query.q ? { reason: { contains: query.q, mode: 'insensitive' } } : {}),
    };
    const [rows, total] = await Promise.all([this.sys.client.accessGrant.findMany({ where, ...pageArgs(query, SORT, 'createdAt:desc') }), this.sys.client.accessGrant.count({ where })]);
    return pageResult(await this.view(rows), total, query);
  }

  async get(id: string) {
    return (await this.view([await this.mine(id)]))[0];
  }

  // ------------------------------------------------------------------ enter
  /**
   * Starts a support session inside the centre. Only the person who asked, only
   * while the centre's approval is in force. The returned access token carries
   * the grant id; what it may do is decided per request from the grant's scopes.
   */
  async enter(id: string) {
    const c = ctx();
    const grant = await this.mine(id, { requesterOnly: true });
    const now = new Date();
    if (grant.status === 'REQUESTED') throw Errors.conflict('ACCESS_NOT_APPROVED', 'The centre has not approved this request yet.');
    if (grant.status !== 'APPROVED' || grant.revokedAt || !grant.expiresAt || grant.expiresAt <= now) {
      throw Errors.forbidden('SUPPORT_ACCESS_ENDED', grant.status === 'DENIED' ? 'The centre denied this request.' : 'This access has expired or was revoked. Ask the centre again if you still need it.');
    }
    const tenant = await this.sys.client.tenant.findUnique({ where: { id: grant.tenantId }, select: { status: true, slug: true } });
    if (!tenant || !USABLE_TENANT.includes(tenant.status)) throw Errors.forbidden('TENANT_UNAVAILABLE', 'This centre is currently not available.');
    const session = await this.auth.issueSupportSession(c.userId!, grant.id, grant.tenantId);
    // For the browser: a one-time code the console passes to the staff app in a URL fragment (see AuthService).
    const handoff = await this.auth.createSupportHandoff(c.userId!, grant);
    await this.auditOnCentre(grant, 'support_access.entered', `TypEase support (${c.actorLabel}) entered the centre under an approved access grant`, { via: 'CONSOLE', scopes: grant.scopes, expiresAt: grant.expiresAt.toISOString() });
    await this.audit.logSystem({ action: 'support_access.entered', resourceType: 'AccessGrant', resourceId: grant.id, summary: `Support session started [centre ${tenant.slug}]`, after: { via: 'CONSOLE', scopes: grant.scopes, expiresAt: grant.expiresAt.toISOString() } });
    await this.audit.security('SUPPORT_ACCESS_ENTERED', 'MEDIUM', { grantId: grant.id, scopes: grant.scopes, expiresAt: grant.expiresAt.toISOString() }, grant.tenantId);
    return { ...session, grant: { id: grant.id, scopes: grant.scopes, expiresAt: grant.expiresAt }, handoff: { code: handoff.code, expiresAt: handoff.expiresAt, url: handoff.url } };
  }

  /** Ends every session that was opened under a grant. */
  async endSessions(grantIds: string[], reason: string): Promise<number> {
    if (!grantIds.length) return 0;
    const r = await this.sys.client.session.updateMany({ where: { supportGrantId: { in: grantIds }, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
    return r.count;
  }

  /** The requester withdraws a waiting request or gives up access early. A Super Admin may do it for anyone. */
  async revoke(id: string) {
    const c = ctx();
    const existing = found(await this.sys.client.accessGrant.findUnique({ where: { id } }), 'Access request');
    if (existing.requestedById !== c.userId && c.platformRole !== 'SUPER_ADMIN') throw Errors.notFound('Access request');
    const updated = await this.sys.client.accessGrant.updateMany({ where: { id, status: { in: ['REQUESTED', 'APPROVED'] } }, data: { status: 'REVOKED', revokedAt: new Date() } });
    if (updated.count !== 1) throw Errors.conflict('ACCESS_ALREADY_CLOSED', `This request is already ${existing.status.toLowerCase()}.`);
    const sessions = await this.endSessions([id], 'SUPPORT_ACCESS_REVOKED');
    await this.auditOnCentre(existing, 'support_access.revoked', `TypEase support ${existing.status === 'REQUESTED' ? 'withdrew the access request' : 'ended its access early'}`, { by: 'PLATFORM', previousStatus: existing.status, sessionsEnded: sessions });
    // Ended by somebody else (a Super Admin): the person who asked is told. Their own withdrawal needs no message.
    if (existing.requestedById !== c.userId) await this.events.emitSystem('support_access.decided', { grantId: id, status: 'REVOKED', previousStatus: existing.status, by: 'PLATFORM', actorUserId: c.userId }, existing.tenantId);
    await this.audit.security('SUPPORT_ACCESS_REVOKED', 'INFO', { grantId: id, by: 'PLATFORM' }, existing.tenantId);
    return this.get(id);
  }

  // ------------------------------------------------------------------ expiry job
  /**
   * Marks grants whose time is over as EXPIRED and ends their sessions. Access
   * itself stops at `expiresAt` regardless of this job (checked on every
   * request); the job keeps the records and the session list truthful.
   */
  async expireDue(now = new Date()): Promise<{ expired: number; lapsedRequests: number; sessionsEnded: number }> {
    const policy = await this.settings.value<SupportAccessPolicy>(SUPPORT_ACCESS_POLICY_KEY);
    const due = await this.sys.client.accessGrant.findMany({ where: { status: 'APPROVED', expiresAt: { lte: now } }, select: { id: true, tenantId: true } });
    const stale = await this.sys.client.accessGrant.findMany({ where: { status: 'REQUESTED', createdAt: { lte: new Date(now.getTime() - policy.pendingExpiryDays * 86_400_000) } }, select: { id: true, tenantId: true } });
    let expired = 0;
    let lapsed = 0;
    for (const grant of due) {
      const r = await this.sys.client.accessGrant.updateMany({ where: { id: grant.id, status: 'APPROVED' }, data: { status: 'EXPIRED' } });
      if (r.count !== 1) continue;
      expired += 1;
      await this.auditOnCentre(grant, 'support_access.expired', 'Support access ended: the approved time is over');
    }
    for (const grant of stale) {
      const r = await this.sys.client.accessGrant.updateMany({ where: { id: grant.id, status: 'REQUESTED' }, data: { status: 'EXPIRED' } });
      if (r.count !== 1) continue;
      lapsed += 1;
      await this.auditOnCentre(grant, 'support_access.expired', `Support access request lapsed: nobody answered within ${policy.pendingExpiryDays} days`);
    }
    const sessionsEnded = await this.endSessions(due.map((g) => g.id), 'SUPPORT_ACCESS_ENDED');
    return { expired, lapsedRequests: lapsed, sessionsEnded };
  }

  /** Called when a platform account is disabled: nothing it asked for stays open. */
  async revokeAllOf(userId: string): Promise<number> {
    const open = await this.sys.client.accessGrant.findMany({ where: { requestedById: userId, status: { in: ['REQUESTED', 'APPROVED'] } }, select: { id: true, tenantId: true } });
    for (const grant of open) {
      await this.sys.client.accessGrant.updateMany({ where: { id: grant.id, status: { in: ['REQUESTED', 'APPROVED'] } }, data: { status: 'REVOKED', revokedAt: new Date() } });
      await this.auditOnCentre(grant, 'support_access.revoked', 'Support access ended: the TypEase staff account was disabled', { by: 'PLATFORM' });
    }
    await this.endSessions(open.map((g) => g.id), 'ACCOUNT_DISABLED');
    return open.length;
  }
}
